//! 桌面歌词设置弹出窗（R51）：**独立的小窗**，不是一个装不进 128px 高歌词窗的面板。
//!
//! ## 为什么要另开一扇窗
//!
//! R50 的设置面是歌词窗内嵌的 `DropdownMenu`：radix 会把浮层限制在**窗口**的可用高度里
//! （`--radix-dropdown-menu-content-available-height`），于是 800×128 的歌词窗里那份菜单只能滚。
//! 用户的要求是"允许突破桌面歌词大小限制"——菜单必须能长到窗口外面去。
//!
//! 做法：菜单本体（仍是**同一个 shadcn `DropdownMenu`**，内容一个字没改）搬进一扇独立的透明小窗，
//! 尺寸/位置全由 Rust 决定（这扇窗**不授予任何 window 权限**，见 `capabilities/lyrics-settings.json`）。
//!
//! ## 几何（纯函数，单测在文件末尾）
//!
//! 调用方给的是**它自己客户区里的 CSS 像素锚点**（齿轮按钮的 `getBoundingClientRect()`）。
//! Rust 用调用窗口的 `inner_position()`（客户区左上角的屏幕物理坐标）与缩放比换算到物理像素，
//! 然后：
//!
//! - 弹出窗**右边缘对齐锚点右边缘**、顶部在锚点下方 [`SETTINGS_POPUP_GAP_DIP`]；
//! - 下方放不下就**翻到上方**（底边在锚点上方同一个间距处）；
//! - 最终夹进锚点所在显示器的**工作区**（坐标可以是负的：副屏在主屏左边时工作区原点就是负的）；
//! - 内容高于工作区就把尺寸截到工作区，剩下交给菜单自己滚。
//!
//! 窗口比菜单**四周各多 [`SETTINGS_POPUP_PAD_DIP`]**：透明窗里 CSS 的 `shadow-md` 会被窗口边界裁掉，
//! 留一圈透明白边让菜单看起来与 R50 的浮层一致（那圈不吃点击以外的东西，也不挡任何控件）。
//!
//! ## 关闭路径（每一条都要关，少一条就是"菜单粘住不走了"）
//!
//! 失焦（= 点到窗口外面）、Esc（radix 的 dismiss 经命令回来）、点菜单外面、锁定、歌词窗隐藏/销毁、
//! 切到任务栏模式、退出。关闭 = `hide()`（**不销毁**：下次打开要快，页面里量好的尺寸也还在）。
//!
//! **齿轮二次点击不能闪**：点齿轮会让弹出窗失焦 → 先在失焦那一刻 hide，紧接着调用窗口那条
//! `core_lyrics_settings_open` 才到。所以 Rust 在失焦时记一个时刻，[`SETTINGS_REOPEN_SUPPRESS_MS`]
//! 之内的"打开"一律判为**同一次点击的尾巴**、拒绝打开（Esc/点外面关掉的不记这个时刻，那两种意图
//! 与"再点一次齿轮"无关）。
//!
//! ## 退出
//!
//! 退出时**不排队、不等待**：`begin_shutdown` 里直接 `destroy()`，不参与 R44e 的保存预算
//! （弹出窗自己不持有任何要落盘的东西——配置的写者仍是 `lyrics_window` 那条窄命令）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::bridge::CoreError;
use crate::lyrics_window::{work_area_rect, LyricsConfig, Point, Rect, Size};
use crate::{LYRICS_SETTINGS_WINDOW_LABEL, WebviewDataRoot};

// ---------------------------------------------------------------------------
// 几何（纯函数）
// ---------------------------------------------------------------------------

/// 弹出窗（菜单本体）与锚点之间的竖直间距（DIP）。
pub const SETTINGS_POPUP_GAP_DIP: f64 = 4.0;

/// 透明窗四周留的一圈（DIP）：给菜单的 `shadow-md` 让位，否则阴影会被窗口边界切掉。
pub const SETTINGS_POPUP_PAD_DIP: f64 = 8.0;

/// 内容尺寸还没报上来时的兜底（DIP）。只有"窗口已存在、页面还没量过"这一种情况会用到它。
pub const SETTINGS_POPUP_FALLBACK_SIZE: Size = Size {
    width: 256.0,
    height: 320.0,
};

/// 渲染层报上来的尺寸上限（DIP）：拦掉明显是坏值的数（真正的上限是工作区）。
pub const SETTINGS_POPUP_MAX_DIP: f64 = 100_000.0;

/// 失焦关闭之后多久之内的"打开"算同一次点击（毫秒）。
///
/// 为什么需要一个窗口：齿轮那一下点击既会让弹出窗失焦（→ hide），又会让调用窗口发出一笔
/// `core_lyrics_settings_open`。两支之间只有几十毫秒，没有这一条就会出现"关掉又立刻打开"的闪烁，
/// 用户再也关不掉这个菜单（R51 简报点名的那条）。
pub const SETTINGS_REOPEN_SUPPRESS_MS: u64 = 400;

/// 缩放比的可信化：非有限/非正一律按 1（与歌词窗几何同一条纪律：宁可少缩放，不要乱缩放）。
fn trusted_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// 调用方给的锚点（`{x, y, width, height}`，**调用窗口客户区里的 CSS 像素**）。
///
/// 坏形状一律 `invalid_payload`：宽/高为负或不是有限数就不是一个矩形，不猜一个出来。
pub fn parse_anchor(value: &Value) -> Result<Rect, CoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::new("invalid_payload", "锚点必须是 {x, y, width, height}"))?;
    let field = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite())
    };
    let (Some(x), Some(y), Some(width), Some(height)) = (
        field("x"),
        field("y"),
        field("width"),
        field("height"),
    ) else {
        return Err(CoreError::new(
            "invalid_payload",
            "锚点的 x/y/width/height 必须是有限数字",
        ));
    };
    if width < 0.0 || height < 0.0 {
        return Err(CoreError::new("invalid_payload", "锚点的宽高不能是负数"));
    }
    Ok(Rect {
        x,
        y,
        width,
        height,
    })
}

/// 客户区 DIP 锚点 → **屏幕物理像素**矩形。
///
/// `inner` 是调用窗口客户区左上角的屏幕物理坐标（`Window::inner_position()`），
/// 所以这里只有一次乘加，没有第二套"屏幕坐标 + 缩放比"的换算（R7 的真机偏差就出在那条路上）。
pub fn anchor_rect(inner: Point, anchor: Rect, scale: f64) -> Rect {
    let scale = trusted_scale(scale);
    Rect {
        x: inner.x + anchor.x * scale,
        y: inner.y + anchor.y * scale,
        width: anchor.width * scale,
        height: anchor.height * scale,
    }
}

/// 单轴夹紧：先把"放得下的最大起点"算出来，窗口比工作区还大时退回起点（与歌词窗同一条纪律）。
fn clamp_axis(value: f64, start: f64, span: f64, length: f64) -> f64 {
    let max = start + (span - length).max(0.0);
    value.max(start).min(max)
}

/// 菜单位置（物理像素）：右边缘对齐锚点、优先下方、放不下翻上方、最后夹进工作区。
///
/// `gap` 由调用方按缩放比换算好后传入（纯函数不碰 DPI）。
pub fn settings_popup_placement(anchor: Rect, size: Size, area: Rect, gap: f64) -> Point {
    let below = anchor.y + anchor.height + gap;
    let fits_below = below + size.height <= area.y + area.height;
    let y = if fits_below {
        below
    } else {
        anchor.y - gap - size.height
    };
    Point {
        x: clamp_axis(anchor.x + anchor.width - size.width, area.x, area.width, size.width),
        y: clamp_axis(y, area.y, area.height, size.height),
    }
}

/// 内容尺寸（DIP）→ 物理像素，并夹进工作区（比工作区还高的内容交给菜单自己滚）。
pub fn settings_popup_content_size(content: Size, scale: f64, area: Rect) -> Size {
    let scale = trusted_scale(scale);
    let wanted = Size {
        width: content.width * scale,
        height: content.height * scale,
    };
    Size {
        width: wanted.width.min(area.width).max(1.0),
        height: wanted.height.min(area.height).max(1.0),
    }
}

/// 窗口尺寸与位置：菜单位置四周各展开 `pad`（那圈透明白边是给阴影的）。
pub fn settings_popup_window_rect(
    anchor: Rect,
    content: Size,
    area: Rect,
    gap: f64,
    pad: f64,
) -> (Size, Point) {
    let point = settings_popup_placement(anchor, content, area, gap);
    (
        Size {
            width: content.width + pad * 2.0,
            height: content.height + pad * 2.0,
        },
        Point {
            x: point.x - pad,
            y: point.y - pad,
        },
    )
}

/// 这一次"打开"是不是同一段点击的尾巴（刚因失焦关闭）——纯函数，好让判定可单测。
pub fn reopen_suppressed(last_blur: Option<Instant>, now: Instant, window: Duration) -> bool {
    match last_blur {
        Some(last) => now.saturating_duration_since(last) < window,
        None => false,
    }
}

/// 渲染层报上来的内容尺寸（CSS 像素）→ 可信的 DIP 尺寸；坏值回 `None`（不猜、不覆盖上一次的好值）。
pub fn normalize_content_size(width: f64, height: f64) -> Option<Size> {
    let sane = |value: f64| {
        value.is_finite() && value > 0.0 && value <= SETTINGS_POPUP_MAX_DIP
    };
    if !sane(width) || !sane(height) {
        return None;
    }
    Some(Size {
        width: width.round().max(1.0),
        height: height.round().max(1.0),
    })
}

// ---------------------------------------------------------------------------
// 来源守卫（与仓里既有的窄守卫同款：只放行点名的 label）
// ---------------------------------------------------------------------------

/// 谁可以要求打开设置弹出窗：歌词窗（R51 的齿轮）与主窗（R52 的设置页会从那里打开同一个窗）。
pub fn require_settings_open_source(label: &str) -> Result<(), CoreError> {
    if [crate::MAIN_WINDOW_LABEL, crate::LYRICS_WINDOW_LABEL].contains(&label) {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        "歌词设置弹出窗只能由主窗或歌词窗要求打开",
    ))
}

/// 谁可以指挥弹出窗自己（量尺寸 / 关掉）：**只有它自己**。
pub fn require_settings_self_source(label: &str) -> Result<(), CoreError> {
    if label == LYRICS_SETTINGS_WINDOW_LABEL {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        "只有歌词设置弹出窗可以上报尺寸或关闭自己",
    ))
}

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------

/// 弹出窗的会话内状态：锚点（物理像素）、量到的内容尺寸（DIP）、最近一次失焦关闭的时刻。
#[derive(Default)]
pub struct SettingsPopupState {
    inner: Mutex<PopupState>,
}

#[derive(Default)]
struct PopupState {
    anchor: Option<Rect>,
    content: Option<Size>,
    last_blur: Option<Instant>,
    shutting_down: bool,
}

impl SettingsPopupState {
    fn with<T>(&self, apply: impl FnOnce(&mut PopupState) -> T) -> T {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        apply(&mut state)
    }

    fn content(&self) -> Option<Size> {
        self.with(|state| state.content)
    }

    fn note_blur(&self) -> bool {
        self.with(|state| {
            state.last_blur = Some(Instant::now());
            state.shutting_down
        })
    }

    fn reopen_suppressed(&self) -> bool {
        let window = Duration::from_millis(SETTINGS_REOPEN_SUPPRESS_MS);
        self.with(|state| reopen_suppressed(state.last_blur, Instant::now(), window))
    }

    fn begin_shutdown(&self) -> bool {
        self.with(|state| {
            if state.shutting_down {
                return false;
            }
            state.shutting_down = true;
            true
        })
    }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/// 弹出窗的标题（Alt+Tab / 任务视图里的名字；与歌词窗同理，不能留给 tao 的默认 "Tauri App"）。
pub const SETTINGS_POPUP_TITLE: &str = "桌面歌词设置";

/// 弹出窗的 webview 数据目录：`<数据根>/webview2/lyrics-settings`。
///
/// **为什么不与歌词窗共用**（R51 实测选定的方案）：同一份 WebView2 用户数据目录上建两个环境时，
/// 环境参数（这里就是代理）必须**完全一致**，否则建窗直接失败；共用目录还会让两扇窗的库锁互相
/// 牵制（关歌词窗/销毁弹出窗的次序会突然变得有意义）。每窗一份独立目录是本仓既有的做法
/// （主窗、歌词窗、每一次登录窗都各有一份），代价只是多一个几十 MB 的缓存目录。
pub fn popup_data_dir(data_root: &Path) -> PathBuf {
    data_root.join("webview2").join("lyrics-settings")
}

/// 弹出窗加载的地址：`lyrics-settings.html?<配置>&theme=<档位>`。
///
/// 配置与主题都经查询串同步到位（与歌词窗 [`crate::lyrics_window::lyrics_window_url`] 同一条纪律）：
/// 页面还没订阅事件时也不会丢掉当前档位/主题，第一帧就是对的。
pub fn popup_url(config: &LyricsConfig, theme: crate::theme::ThemeChoice) -> String {
    format!(
        "lyrics-settings.html?{}&theme={}",
        config.query(),
        theme.setting()
    )
}

fn build_popup<R: Runtime>(
    app: &AppHandle<R>,
    config: &LyricsConfig,
) -> Result<WebviewWindow<R>, CoreError> {
    let data_root = app
        .try_state::<WebviewDataRoot>()
        .map(|root| root.0.clone())
        .ok_or_else(|| CoreError::new("internal", "webview 数据根尚未登记：歌词设置弹出窗建不起来"))?;
    let data = popup_data_dir(&data_root);
    std::fs::create_dir_all(&data).map_err(|source| {
        CoreError::new(
            "internal",
            format!("歌词设置弹出窗数据目录（{data:?}）建不出来：{source}"),
        )
    })?;
    // 与主窗/歌词窗/登录窗同一条取值链：不接代理的话，这扇窗自己的网络栈会绕过设置直连。
    let proxy = crate::proxy_url_argument(crate::webview_proxy::resolve_for_webview(
        &data_root,
        LYRICS_SETTINGS_WINDOW_LABEL,
    ));

    let mut builder = WebviewWindowBuilder::new(
        app,
        LYRICS_SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(popup_url(config, crate::theme::current_theme(app)).into()),
    )
    .title(SETTINGS_POPUP_TITLE)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // 尺寸由 Rust 按内容报上来的值设：用户可以拖歌词窗，但不该拖这个菜单。
    .resizable(false)
    .focused(false)
    .visible(false)
    .data_directory(data);

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }

    let window = builder
        .build()
        .map_err(|source| CoreError::new("internal", format!("歌词设置弹出窗建不起来：{source}")))?;
    let events = app.clone();
    window.on_window_event(move |event| match event {
        // 点到窗口外面 = 菜单该收起来了。先 hide 再记时刻：紧跟着到达的那笔 open 会因为这段窗口被拒。
        tauri::WindowEvent::Focused(false) => {
            if let Some(window) = events.get_webview_window(LYRICS_SETTINGS_WINDOW_LABEL) {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                    if let Some(state) = events.try_state::<SettingsPopupState>() {
                        state.note_blur();
                    }
                }
            }
        }
        // 关闭 = 隐藏：窗口与页面都留着（下次打开不用重新加载、尺寸也还是量好的那份）。
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&events);
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(state) = events.try_state::<SettingsPopupState>() {
                state.with(|state| state.anchor = None);
            }
        }
        _ => {}
    });
    Ok(window)
}

/// 隐藏弹出窗（不存在就什么都不做）。**不销毁**：页面、位置、量好的尺寸都留着。
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LYRICS_SETTINGS_WINDOW_LABEL) {
        if let Err(error) = window.hide() {
            log::warn!("歌词设置弹出窗隐藏失败：{error}");
        }
    }
}

/// 关闭弹出窗：歌词窗隐藏/销毁、锁定、切任务栏模式都走这里（幂等）。
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    hide(app);
}

/// 退出：直接销毁（**不等待、不排队**——它不持有任何要落盘的东西）。
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<SettingsPopupState>() {
        if !state.begin_shutdown() {
            return;
        }
    }
    if let Some(window) = app.get_webview_window(LYRICS_SETTINGS_WINDOW_LABEL) {
        if let Err(error) = window.destroy() {
            log::warn!("歌词设置弹出窗销毁失败（退出不受影响）：{error}");
        }
    }
}

/// 按当前锚点摆好窗口（尺寸/位置都从"锚点 + 内容尺寸 + 工作区"重新算）。
fn apply_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
    anchor: Rect,
    content: Size,
    area: Rect,
) -> Result<(), CoreError> {
    let scale = trusted_scale(window.scale_factor().unwrap_or(1.0));
    let gap = SETTINGS_POPUP_GAP_DIP * scale;
    let pad = SETTINGS_POPUP_PAD_DIP * scale;
    let size = settings_popup_content_size(content, scale, area);
    let (window_size, point) = settings_popup_window_rect(anchor, size, area, gap, pad);
    window
        .set_size(PhysicalSize::new(
            window_size.width.round().max(1.0) as u32,
            window_size.height.round().max(1.0) as u32,
        ))
        .and_then(|_| {
            window.set_position(PhysicalPosition::new(
                point.x.round() as i32,
                point.y.round() as i32,
            ))
        })
        .map_err(|source| CoreError::new("internal", format!("歌词设置弹出窗摆不到位：{source}")))
}

/// 显示（拿到焦点，失焦才会关）。
fn show<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.show() {
        log::warn!("歌词设置弹出窗显示不出来：{error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        log::warn!("歌词设置弹出窗拿不到焦点（失焦关闭会失效）：{error}");
    }
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

/// 打开（或再次摆好）设置弹出窗。`anchor` 是**调用窗口客户区里的 CSS 像素**矩形。
///
/// 首次打开：建一扇**隐藏**的窗就返回——页面挂载后会 `core_lyrics_settings_resize` 报上来的内容尺寸
/// 才会真正显示出来（先定位、量好尺寸再显示，用户看不到默认尺寸那一闪）。
/// 之后每次打开：用上一次量好的内容尺寸摆好、`show()` + 取焦点。
#[tauri::command]
pub async fn core_lyrics_settings_open(
    app: AppHandle,
    webview: tauri::Webview,
    anchor: Value,
) -> Result<Value, CoreError> {
    require_settings_open_source(webview.label())?;
    let anchor = parse_anchor(&anchor)?;
    let state = app.state::<SettingsPopupState>();
    if state.with(|state| state.shutting_down) {
        return Err(CoreError::new("shutting_down", "应用正在退出"));
    }
    // 齿轮那一下点击的尾巴：刚因失焦关掉就不要再开（否则是"关掉又被同一次点击打开"的闪烁）。
    if state.reopen_suppressed() {
        return Ok(json!({ "open": false, "reason": "closed_by_focus" }));
    }

    let caller = app
        .get_webview_window(webview.label())
        .ok_or_else(|| CoreError::new("internal", "找不到发起打开的那扇窗"))?;
    let inner = caller
        .inner_position()
        .map_err(|source| CoreError::new("internal", format!("取不到窗口客户区位置：{source}")))?;
    let scale = caller.scale_factor().unwrap_or(1.0);
    let anchor_px = anchor_rect(
        Point {
            x: f64::from(inner.x),
            y: f64::from(inner.y),
        },
        anchor,
        scale,
    );
    let monitor = caller
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| CoreError::new("internal", "取不到显示器的工作区：弹出窗按默认位置显示"))?;
    let area = work_area_rect(&monitor);

    let config = app.state::<crate::lyrics_window::LyricsWindowState>().config();
    state.with(|state| state.anchor = Some(anchor_px));

    let existing = app.get_webview_window(LYRICS_SETTINGS_WINDOW_LABEL);
    let fresh = existing.is_none();
    let window = match existing {
        Some(window) => window,
        None => build_popup(&app, &config)?,
    };
    let content = state.content();
    let Some(content) = content else {
        // 页面还没量过（首次打开）：等它报尺寸。**不显示**——先定位、量好再显示，避免默认尺寸那一闪。
        return Ok(json!({ "open": true, "visible": false, "measured": false }));
    };
    if let Err(error) = apply_geometry(&window, anchor_px, content, area) {
        log::warn!("歌词设置弹出窗没能摆到目标位置（按默认位置显示）：{error}");
    }
    show(&window);
    Ok(json!({ "open": true, "visible": true, "measured": !fresh }))
}

/// 弹出窗自己报上来的内容尺寸（CSS 像素）：Rust 设窗口尺寸、按同一个锚点重算位置，再显示。
#[tauri::command]
pub async fn core_lyrics_settings_resize(
    app: AppHandle,
    webview: tauri::Webview,
    width: f64,
    height: f64,
) -> Result<Value, CoreError> {
    require_settings_self_source(webview.label())?;
    let Some(content) = normalize_content_size(width, height) else {
        return Err(CoreError::new(
            "invalid_payload",
            "弹出窗尺寸必须是有限正数（CSS 像素）",
        ));
    };
    let state = app.state::<SettingsPopupState>();
    if state.with(|state| state.shutting_down) {
        return Ok(json!({ "applied": false }));
    }
    let anchor = state.with(|state| {
        state.content = Some(content);
        state.anchor
    });
    let Some(window) = app.get_webview_window(LYRICS_SETTINGS_WINDOW_LABEL) else {
        return Ok(json!({ "applied": false }));
    };
    let Some(anchor) = anchor else {
        return Ok(json!({ "applied": false }));
    };
    let area = match window.current_monitor().ok().flatten() {
        Some(monitor) => work_area_rect(&monitor),
        None => match app.primary_monitor().ok().flatten() {
            Some(monitor) => work_area_rect(&monitor),
            None => {
                return Ok(json!({ "applied": false }));
            }
        },
    };
    let applied = apply_geometry(&window, anchor, content, area);
    if let Err(error) = &applied {
        log::warn!("歌词设置弹出窗的尺寸没能应用（{error}）：菜单可能被裁一点");
    }
    // 首次打开走的就是这条路：量到尺寸之后才显示，所以这里要补 show + 取焦点。
    if !window.is_visible().unwrap_or(false) {
        show(&window);
    }
    Ok(json!({
        "applied": applied.is_ok(),
        "width": content.width,
        "height": content.height,
        "visible": window.is_visible().unwrap_or(false),
    }))
}

/// 关闭弹出窗（Esc / 点菜单外面都由页面这条命令回来）。
#[tauri::command]
pub async fn core_lyrics_settings_close(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<Value, CoreError> {
    require_settings_self_source(webview.label())?;
    hide(&app);
    Ok(json!({ "open": false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn size(width: f64, height: f64) -> Size {
        Size { width, height }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn main_monitor() -> Rect {
        rect(0.0, 0.0, 1920.0, 1040.0)
    }

    /// 主屏常见形态：齿轮在歌词窗里靠右，菜单右对齐、贴锚点下方。
    #[test]
    fn r51_the_menu_is_right_aligned_under_the_anchor() {
        let anchor = rect(700.0, 10.0, 28.0, 28.0);
        let placed = settings_popup_placement(anchor, size(256.0, 180.0), main_monitor(), 4.0);
        assert_eq!(placed.x + 256.0, anchor.x + anchor.width, "右边缘对齐锚点右边缘");
        assert_eq!(placed.y, anchor.y + anchor.height + 4.0, "顶部在锚点下方 4");
    }

    /// 下方放不下 → 翻到上方（底边在锚点上方同一个间距处）。
    #[test]
    fn r51_a_crowded_bottom_flips_the_menu_above_the_anchor() {
        let area = rect(0.0, 0.0, 1920.0, 600.0);
        let anchor = rect(700.0, 520.0, 28.0, 28.0);
        let placed = settings_popup_placement(anchor, size(256.0, 180.0), area, 4.0);
        assert_eq!(placed.y + 180.0, anchor.y - 4.0, "翻到锚点上方：底边离锚点 4");
        assert!(placed.y >= area.y);
    }

    /// 上下一共放不下：夹回工作区顶部（宁可压住锚点，也不许把菜单推出屏幕）。
    #[test]
    fn r51_a_menu_taller_than_the_area_stays_inside_it() {
        let area = rect(0.0, 0.0, 1920.0, 200.0);
        let anchor = rect(700.0, 60.0, 28.0, 28.0);
        let placed = settings_popup_placement(anchor, size(256.0, 180.0), area, 4.0);
        assert_eq!(placed.y, area.y, "夹回工作区顶部");
        assert!(placed.y + 180.0 <= area.y + area.height);
    }

    /// 锚点贴右边缘：菜单右对齐会伸出工作区 → 夹回来（右边留 0 也行，但不许出去）。
    #[test]
    fn r51_a_menu_hanging_over_the_right_edge_is_clamped_back() {
        let anchor = rect(1900.0, 10.0, 28.0, 28.0);
        let placed = settings_popup_placement(anchor, size(256.0, 180.0), main_monitor(), 4.0);
        assert_eq!(placed.x + 256.0, 1920.0, "夹到工作区右边缘");
        assert!(placed.x >= 0.0);
    }

    /// 副屏在主屏左边：坐标是负的，**夹紧用的是工作区原点**（粘 0 会把窗扔回主屏）。
    #[test]
    fn r51_a_monitor_left_of_the_primary_keeps_negative_coordinates() {
        let left = rect(-1920.0, 0.0, 1920.0, 1040.0);
        let anchor = rect(-500.0, 10.0, 28.0, 28.0);
        let placed = settings_popup_placement(anchor, size(256.0, 180.0), left, 4.0);
        assert_eq!(placed.x + 256.0, anchor.x + anchor.width);
        assert!(placed.x < 0.0, "仍在那块屏上：{placed:?}");

        // 贴那块屏的左边缘：夹到 -1920，绝不回到 0
        let hugging = settings_popup_placement(rect(-1920.0, 10.0, 8.0, 8.0), size(256.0, 180.0), left, 4.0);
        assert_eq!(hugging.x, -1920.0);
    }

    /// DIP 锚点 → 物理像素：缩放比 1.0 / 1.5 / 2.0 都只乘一次。
    #[test]
    fn r51_the_anchor_is_converted_with_the_window_scale_factor_once() {
        let anchor = rect(10.0, 20.0, 28.0, 28.0);
        assert_eq!(
            anchor_rect(point(100.0, 200.0), anchor, 1.0),
            rect(110.0, 220.0, 28.0, 28.0)
        );
        assert_eq!(
            anchor_rect(point(100.0, 200.0), anchor, 1.5),
            rect(115.0, 230.0, 42.0, 42.0)
        );
        // 缩放比不可信按 1（绝不 produce NaN 几何）
        assert_eq!(
            anchor_rect(point(0.0, 0.0), anchor, f64::NAN),
            rect(10.0, 20.0, 28.0, 28.0)
        );
        // 物理锚点 + 缩放过的尺寸：菜单仍右对齐、仍在下方 4 DIP（=6 物理）
        let anchor_px = anchor_rect(point(1000.0, 100.0), anchor, 1.5);
        let placed = settings_popup_placement(anchor_px, size(384.0, 270.0), rect(0.0, 0.0, 2880.0, 1560.0), 6.0);
        assert_eq!(placed.x + 384.0, anchor_px.x + anchor_px.width);
        assert_eq!(placed.y, anchor_px.y + anchor_px.height + 6.0);
    }

    /// 内容尺寸：DIP → 物理，并夹进工作区（高过工作区就截到工作区高度，由菜单自己滚）。
    #[test]
    fn r51_content_size_is_scaled_and_clamped_into_the_work_area() {
        assert_eq!(
            settings_popup_content_size(size(256.0, 180.0), 1.5, main_monitor()),
            size(384.0, 270.0)
        );
        assert_eq!(
            settings_popup_content_size(size(256.0, 5000.0), 1.0, main_monitor()),
            size(256.0, 1040.0)
        );
        assert_eq!(
            settings_popup_content_size(size(5000.0, 180.0), 1.0, main_monitor()),
            size(1920.0, 180.0)
        );
    }

    /// 窗口矩形 = 菜单矩形四周各一圈 pad（阴影的容身处），右对齐关系由"菜单"保证。
    #[test]
    fn r51_the_window_is_the_menu_plus_a_shadow_ring() {
        let anchor = rect(700.0, 10.0, 28.0, 28.0);
        let (window_size, window_point) =
            settings_popup_window_rect(anchor, size(256.0, 180.0), main_monitor(), 4.0, 8.0);
        assert_eq!(window_size, size(272.0, 196.0));
        let menu = settings_popup_placement(anchor, size(256.0, 180.0), main_monitor(), 4.0);
        assert_eq!(window_point, point(menu.x - 8.0, menu.y - 8.0));
    }

    /// 失焦关闭之后的短窗口内，"打开"被拒；过了窗口照旧打开。
    #[test]
    fn r51_a_second_gear_click_right_after_the_blur_does_not_reopen() {
        let now = Instant::now();
        let window = Duration::from_millis(SETTINGS_REOPEN_SUPPRESS_MS);
        assert!(!reopen_suppressed(None, now, window), "没关过就照旧打开");
        assert!(reopen_suppressed(Some(now), now + Duration::from_millis(1), window));
        assert!(reopen_suppressed(
            Some(now),
            now + Duration::from_millis(SETTINGS_REOPEN_SUPPRESS_MS - 1),
            window
        ));
        assert!(
            !reopen_suppressed(Some(now), now + window, window),
            "过了窗口就是一次新的打开（用户过一会儿再点齿轮）"
        );
        // 时刻倒退（`Instant` 在真机上不回退，这条只证明"注入的假时刻不会 panic"）：
        // `saturating_duration_since` 给 0 ⇒ 仍算"刚关过"，也就是 **fail-closed**（宁可不弹）。
        assert!(reopen_suppressed(
            Some(now + Duration::from_secs(5)),
            now,
            window
        ));
    }

    /// 渲染层报上来的尺寸：坏值一律不覆盖上一次的好值。
    #[test]
    fn r51_reported_sizes_are_never_guessed() {
        assert_eq!(normalize_content_size(255.6, 180.4), Some(size(256.0, 180.0)));
        for (width, height) in [
            (0.0, 10.0),
            (-1.0, 10.0),
            (10.0, 0.0),
            (f64::NAN, 10.0),
            (10.0, f64::INFINITY),
            (SETTINGS_POPUP_MAX_DIP + 1.0, 10.0),
        ] {
            assert_eq!(normalize_content_size(width, height), None, "{width}×{height} 不是尺寸");
        }
    }

    /// 来源守卫：只有主窗/歌词窗能要它打开；只有它自己能报尺寸/关掉自己；媒体控制不放行它。
    #[test]
    fn r51_only_the_named_sources_may_drive_the_popup() {
        for label in [crate::MAIN_WINDOW_LABEL, crate::LYRICS_WINDOW_LABEL] {
            assert!(require_settings_open_source(label).is_ok());
            assert!(
                require_settings_self_source(label).is_err(),
                "调用方不许替弹出窗报尺寸/关它"
            );
        }
        assert!(require_settings_self_source(LYRICS_SETTINGS_WINDOW_LABEL).is_ok());
        for label in [
            LYRICS_SETTINGS_WINDOW_LABEL,
            crate::login::LOGIN_WEBVIEW_LABEL,
            crate::login::LOGIN_THEME_WEBVIEW_LABEL,
            "",
        ] {
            let error = require_settings_open_source(label).expect_err("不是调用方");
            assert_eq!(error.kind.as_deref(), Some("forbidden_source"));
        }
        // 配置可以写（弹出窗里的控件就是那条窄命令），媒体动作不行
        assert!(crate::lyrics_window::require_lyrics_source(LYRICS_SETTINGS_WINDOW_LABEL).is_ok());
        assert!(crate::lyrics_window::control_payload(
            LYRICS_SETTINGS_WINDOW_LABEL,
            &json!({"action": "next"})
        )
        .is_err());
    }

    /// 坏锚点一律 `invalid_payload`（宽高为负、NaN、缺字段、不是对象）。
    #[test]
    fn r51_anchors_are_validated_not_guessed() {
        assert_eq!(
            parse_anchor(&json!({"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0})),
            Ok(rect(1.0, 2.0, 3.0, 4.0))
        );
        for bad in [
            json!({}),
            json!({"x": 1, "y": 2, "width": 3}),
            json!({"x": "1", "y": 2, "width": 3, "height": 4}),
            json!({"x": 1, "y": 2, "width": -3, "height": 4}),
            json!({"x": 1, "y": 2, "width": 3, "height": -4}),
            json!([1, 2, 3, 4]),
            json!("nope"),
            Value::Null,
        ] {
            let error = parse_anchor(&bad).expect_err("坏锚点必须被拒");
            assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "{bad}");
        }
    }

    /// 数据目录口径：`<数据根>/webview2/lyrics-settings`（每窗一份，不与歌词窗共用）。
    #[test]
    fn r51_the_popup_lives_in_its_own_webview_data_directory() {
        assert_eq!(
            popup_data_dir(Path::new("C:\\root")),
            Path::new("C:\\root").join("webview2").join("lyrics-settings")
        );
    }

    /// 页面地址：入口是 lyrics-settings.html，配置与主题都在查询串里（第一帧就是对的）。
    #[test]
    fn r51_the_popup_url_carries_the_config_and_the_theme() {
        let config = LyricsConfig::default().apply_patch(&json!({"layout": "vertical", "size": "xl"}));
        let url = popup_url(&config, crate::theme::ThemeChoice::Dark);
        assert!(url.starts_with("lyrics-settings.html?"), "{url}");
        assert!(url.contains("layout=vertical") && url.contains("size=xl"), "{url}");
        assert!(url.contains("&theme=dark"), "{url}");
    }

    /// 建窗契约（源码扫描：这扇窗的属性一次到位，且它**不销毁**只隐藏）。
    #[test]
    fn r51_the_popup_window_is_built_with_the_contract_attributes() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_settings.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        for required in [
            ".title(SETTINGS_POPUP_TITLE)",
            ".decorations(false)",
            ".transparent(true)",
            ".shadow(false)",
            ".always_on_top(true)",
            ".skip_taskbar(true)",
            ".resizable(false)",
            ".focused(false)",
            ".visible(false)",
            ".data_directory(",
            "proxy_url(",
            "resolve_for_webview(",
            "LYRICS_SETTINGS_WINDOW_LABEL",
        ] {
            assert!(production.contains(required), "建窗契约缺一项：{required}");
        }
        assert!(production.contains("window.hide()"), "关闭 = hide（不销毁）");
        assert!(
            !production[..production.find("pub fn shutdown").unwrap()].contains(".destroy()"),
            "普通关闭路径不许销毁窗口（页面与量好的尺寸都留着）"
        );
        assert!(production.contains("window.set_focus()"), "显示时要拿到焦点（失焦才会关）");
        assert!(
            production.contains("api.prevent_close()"),
            "系统关闭（Alt+F4 之类）也只隐藏"
        );
    }

    /// 三条命令都是 async、都带窄守卫、都在 `lib.rs` 注册（命令名是跨语言契约）。
    #[test]
    fn r51_every_popup_command_is_async_with_its_narrow_guard() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_settings.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        for (name, guard) in [
            ("core_lyrics_settings_open", "require_settings_open_source("),
            ("core_lyrics_settings_resize", "require_settings_self_source("),
            ("core_lyrics_settings_close", "require_settings_self_source("),
        ] {
            assert!(
                production.contains(&format!("pub async fn {name}(")),
                "{name} 必须是 async 命令：{name}"
            );
            let body = &production[production.find(&format!("pub async fn {name}(")).unwrap()..];
            assert!(body.find(guard).unwrap() < 900, "{name} 必须先过窄守卫");
        }
        assert_eq!(production.matches("#[tauri::command]").count(), 3);
        let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("要能读到 lib.rs");
        for name in [
            "core_lyrics_settings_open",
            "core_lyrics_settings_resize",
            "core_lyrics_settings_close",
        ] {
            assert!(
                lib.contains(&format!("lyrics_settings::{name}")),
                "{name} 必须在 generate_handler! 里注册"
            );
        }
        assert!(
            lib.contains("pub const LYRICS_SETTINGS_WINDOW_LABEL"),
            "窗口 label 与歌词窗的常量放在同一处"
        );
    }
}
