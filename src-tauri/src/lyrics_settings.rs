//! 桌面歌词设置气泡：一扇独立的透明小窗，里面是一个 shadcn `Popover`。
//!
//! 面板要能长到 800×128 的歌词窗外面去，所以自成一窗：尺寸位置全由 Rust 定，该窗不授予任何 window 权限。
//! 锚点是调用方自己客户区里的 CSS 像素，Rust 用 `inner_position()` 与缩放比换成物理像素再夹进工作区。
//! 窗口四周多出 [`SETTINGS_POPUP_PAD_DIP`] 的透明边容纳阴影与箭头；失焦、Esc、点外面、锁定、隐藏、退出都要关。
//! 关闭一律 `hide()` 以保留页面与量好的尺寸；退出时直接 `destroy()`，不排队不等待。

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

/// 面板与锚点之间的竖直间距（DIP）：箭头（约 12 DIP）全落在这一缝里。
pub const SETTINGS_BUBBLE_GAP_DIP: f64 = 16.0;

/// 面板左右两端各留多少（DIP）不给箭头用：箭头菱形半宽约 7 DIP，再让开圆角。
pub const SETTINGS_ARROW_INSET_DIP: f64 = 12.0;

/// 透明窗四周留的一圈（DIP）：给阴影与"探到面板外的箭头"让位。
pub const SETTINGS_POPUP_PAD_DIP: f64 = 14.0;

/// 内容尺寸还没报上来时的兜底（DIP）。只有"窗口已存在、页面还没量过"这一种情况会用到它。
pub const SETTINGS_POPUP_FALLBACK_SIZE: Size = Size {
    width: 336.0,
    height: 320.0,
};

/// 渲染层报上来的尺寸上限（DIP）：拦掉明显是坏值的数（真正的上限是工作区）。
pub const SETTINGS_POPUP_MAX_DIP: f64 = 100_000.0;

/// 失焦关闭之后多久之内的"打开"算同一次点击（毫秒）。齿轮那一下既让窗口失焦又发出一笔 open。
pub const SETTINGS_REOPEN_SUPPRESS_MS: u64 = 400;

/// 气泡在锚点的哪一侧（字符串与页面 `BUBBLE_SIDES` 同口径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BubbleSide {
    Bottom,
    Top,
}

impl BubbleSide {
    pub fn as_str(self) -> &'static str {
        match self {
            BubbleSide::Bottom => "bottom",
            BubbleSide::Top => "top",
        }
    }
}

/// 一次摆放的结果，**全部是屏幕物理像素**；`arrow` 是箭头中心距面板左边缘的距离。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BubbleGeometry {
    pub side: BubbleSide,
    pub panel: Point,
    pub window: Rect,
    pub arrow: f64,
}

/// 缩放比的可信化：非有限/非正一律按 1（宁可少缩放，不要乱缩放）。
fn trusted_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// 单轴夹紧：先把"放得下的最大起点"算出来，窗口比工作区还大时退回起点。
fn clamp_axis(value: f64, start: f64, span: f64, length: f64) -> f64 {
    let max = start + (span - length).max(0.0);
    value.max(start).min(max)
}

/// 箭头中心相对面板左边缘：对准锚点中心，两端各留 `inset`（面板比 `2×inset` 还窄就正中）。
pub fn arrow_offset(anchor_center: f64, panel_x: f64, panel_width: f64, inset: f64) -> f64 {
    let inset = inset.max(0.0);
    if panel_width <= inset * 2.0 {
        return panel_width / 2.0;
    }
    (anchor_center - panel_x).max(inset).min(panel_width - inset)
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

/// 客户区 DIP 锚点 → 屏幕物理像素矩形；`inner` 是调用窗口客户区左上角的屏幕物理坐标。
/// 因此这里只有一次乘加换算，没有第二套坐标系。
pub fn anchor_rect(inner: Point, anchor: Rect, scale: f64) -> Rect {
    let scale = trusted_scale(scale);
    Rect {
        x: inner.x + anchor.x * scale,
        y: inner.y + anchor.y * scale,
        width: anchor.width * scale,
        height: anchor.height * scale,
    }
}

/// 气泡摆放：方向（下方优先）、面板左上角、窗口矩形、箭头偏移一次算完。
///
/// `gap`/`pad`/`inset` 由调用方按缩放比换算好后传入（纯函数不碰 DPI）。
pub fn bubble_placement(
    anchor: Rect,
    panel: Size,
    area: Rect,
    gap: f64,
    pad: f64,
    inset: f64,
) -> BubbleGeometry {
    let center = anchor.x + anchor.width / 2.0;
    let below = anchor.y + anchor.height + gap;
    let side = if below + panel.height <= area.y + area.height {
        BubbleSide::Bottom
    } else {
        BubbleSide::Top
    };
    let wanted_y = if side == BubbleSide::Bottom {
        below
    } else {
        anchor.y - gap - panel.height
    };
    // 夹紧范围排除那一圈留边：窗口因此整块落在工作区里（含阴影与箭头）
    let x = clamp_axis(center - panel.width / 2.0, area.x + pad, area.width - pad * 2.0, panel.width);
    let y = clamp_axis(wanted_y, area.y + pad, area.height - pad * 2.0, panel.height);
    BubbleGeometry {
        side,
        panel: Point { x, y },
        window: Rect {
            x: x - pad,
            y: y - pad,
            width: panel.width + pad * 2.0,
            height: panel.height + pad * 2.0,
        },
        arrow: arrow_offset(center, x, panel.width, inset),
    }
}

/// 内容尺寸（DIP）→ 物理像素，并夹进"工作区减去留边"（再大的内容也只剩这一块地方）。
pub fn bubble_content_size(content: Size, scale: f64, area: Rect, pad: f64) -> Size {
    let scale = trusted_scale(scale);
    let wanted = Size {
        width: content.width * scale,
        height: content.height * scale,
    };
    Size {
        width: wanted.width.min((area.width - pad * 2.0).max(1.0)).max(1.0),
        height: wanted.height.min((area.height - pad * 2.0).max(1.0)).max(1.0),
    }
}

/// 页面要的那三样（CSS 像素）：方向、箭头中心相对面板左边缘、窗口留边。
///
/// 面板左上角在页面坐标系里永远等于 `(pad, pad)`（见 [`bubble_placement`]），所以不需要回传坐标。
fn geometry_payload(geometry: &BubbleGeometry, scale: f64) -> Value {
    json!({
        "side": geometry.side.as_str(),
        "arrow": geometry.arrow / trusted_scale(scale),
        "pad": SETTINGS_POPUP_PAD_DIP,
    })
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

/// 谁可以要求打开设置弹出窗：只有歌词窗那枚齿轮。
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

/// 弹出窗的标题（Alt+Tab / 任务视图里的名字；不能留给 tao 的默认 "Tauri App"）。
pub const SETTINGS_POPUP_TITLE: &str = "桌面歌词设置";

/// 弹出窗的 webview 数据目录：`<数据根>/webview2/lyrics-settings`。
/// 不与歌词窗共用：同目录建两个环境会让库锁互相牵制，每窗一份是本仓既有做法。
pub fn popup_data_dir(data_root: &Path) -> PathBuf {
    data_root.join("webview2").join("lyrics-settings")
}

/// 弹出窗加载的地址：`lyrics-settings.html?<配置>&theme=<档位>`。
///
/// 配置与主题都经查询串同步到位：页面还没订阅事件时也不会丢掉当前档位/主题，第一帧就是对的。
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
    // 尺寸由 Rust 按内容报上来的值设：用户可以拖歌词窗，但不该拖这个面板。
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
        // 点到窗口外面 = 面板该收起来了。先 hide 再记时刻：紧跟着到达的那笔 open 会因为这段窗口被拒。
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

/// 按当前锚点摆好窗口（尺寸/位置都从"锚点 + 内容尺寸 + 工作区"重新算），返回页面要的几何。
fn apply_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
    anchor: Rect,
    content: Size,
    area: Rect,
) -> Result<BubbleGeometry, CoreError> {
    let scale = trusted_scale(window.scale_factor().unwrap_or(1.0));
    let pad = SETTINGS_POPUP_PAD_DIP * scale;
    let size = bubble_content_size(content, scale, area, pad);
    let geometry = bubble_placement(
        anchor,
        size,
        area,
        SETTINGS_BUBBLE_GAP_DIP * scale,
        pad,
        SETTINGS_ARROW_INSET_DIP * scale,
    );
    window
        .set_size(PhysicalSize::new(
            geometry.window.width.round().max(1.0) as u32,
            geometry.window.height.round().max(1.0) as u32,
        ))
        .and_then(|_| {
            window.set_position(PhysicalPosition::new(
                geometry.window.x.round() as i32,
                geometry.window.y.round() as i32,
            ))
        })
        .map_err(|source| CoreError::new("internal", format!("歌词设置弹出窗摆不到位：{source}")))?;
    Ok(geometry)
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

/// 打开（或再次摆好）设置弹出窗；`anchor` 是调用窗口客户区里的 CSS 像素矩形。
/// 首次只建隐藏窗，等页面报上内容尺寸再显示；之后用上次量好的尺寸摆好、`show()` 并取焦点。
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
    let geometry = match apply_geometry(&window, anchor_px, content, area) {
        Ok(geometry) => geometry,
        Err(error) => {
            log::warn!("歌词设置弹出窗没能摆到目标位置（按默认位置显示）：{error}");
            return Ok(json!({ "open": true, "visible": false, "measured": !fresh }));
        }
    };
    show(&window);
    Ok(json!({
        "open": true,
        "visible": true,
        "measured": !fresh,
        "geometry": geometry_payload(&geometry, scale),
    }))
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
    let scale = trusted_scale(window.scale_factor().unwrap_or(1.0));
    let applied = match apply_geometry(&window, anchor, content, area) {
        Ok(geometry) => Ok(geometry),
        Err(error) => {
            log::warn!("歌词设置弹出窗的尺寸没能应用（{error}）：面板可能被裁一点");
            Err(error)
        }
    };
    // 首次打开走的就是这条路：量到尺寸之后才显示，所以这里要补 show + 取焦点。
    if !window.is_visible().unwrap_or(false) {
        show(&window);
    }
    Ok(json!({
        "applied": applied.is_ok(),
        "width": content.width,
        "height": content.height,
        "visible": window.is_visible().unwrap_or(false),
        "geometry": applied.ok().map(|geometry| geometry_payload(&geometry, scale)),
    }))
}

/// 关闭弹出窗（Esc / 点面板外面都由页面这条命令回来）。
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

    /// 约定：齿轮靠歌词窗右侧，屏幕 960×1080 那种纵向屏也放得下（面板 ≤ 360 高）。
    fn gear() -> Rect {
        rect(700.0, 10.0, 28.0, 28.0)
    }

    const PAD: f64 = SETTINGS_POPUP_PAD_DIP;
    const GAP: f64 = SETTINGS_BUBBLE_GAP_DIP;
    const INSET: f64 = SETTINGS_ARROW_INSET_DIP;

    /// 默认形态：面板在齿轮下方、水平以齿轮为中心、窗口=面板+四周留边、箭头对准齿轮中心。
    #[test]
    fn r60_the_panel_hangs_under_the_gear_with_the_arrow_on_its_centre() {
        let anchor = gear();
        let panel = size(336.0, 320.0);
        let placed = bubble_placement(anchor, panel, main_monitor(), GAP, PAD, INSET);
        assert_eq!(placed.side, BubbleSide::Bottom);
        assert_eq!(placed.panel.y, anchor.y + anchor.height + GAP, "面板顶边在齿轮下方 GAP");
        let centre = anchor.x + anchor.width / 2.0;
        assert_eq!(placed.panel.x + panel.width / 2.0, centre, "水平以齿轮为中心");
        assert_eq!(placed.arrow, centre - placed.panel.x, "箭头对着齿轮中心");
        assert_eq!(
            placed.window,
            rect(placed.panel.x - PAD, placed.panel.y - PAD, panel.width + PAD * 2.0, panel.height + PAD * 2.0),
            "窗口 = 面板四周各一圈留边"
        );
    }

    /// 下方放不下 → 翻到上方（面板底边在齿轮上方 GAP）。
    #[test]
    fn r60_a_crowded_bottom_flips_the_panel_above_the_gear() {
        let area = rect(0.0, 0.0, 1920.0, 620.0);
        let anchor = rect(700.0, 520.0, 28.0, 28.0);
        let placed = bubble_placement(anchor, size(336.0, 320.0), area, GAP, PAD, INSET);
        assert_eq!(placed.side, BubbleSide::Top);
        assert_eq!(placed.panel.y + 320.0, anchor.y - GAP, "面板底边离齿轮 GAP");
        assert!(placed.window.y >= area.y, "窗口仍留在工作区里");
        assert_eq!(placed.arrow, 714.0 - placed.panel.x, "箭头同样对准齿轮中心");
        assert_eq!(placed.arrow, 168.0, "没夹紧 ⇒ 箭头正好居中");
    }

    /// 齿轮贴左边缘：面板被夹到留边处，箭头**跟着滑到左侧留边**、不再居中。
    #[test]
    fn r60_a_gear_near_the_left_edge_slides_the_arrow_inwards() {
        let anchor = rect(100.0, 10.0, 28.0, 28.0);
        let placed = bubble_placement(anchor, size(336.0, 320.0), main_monitor(), GAP, PAD, INSET);
        assert_eq!(placed.panel.x, PAD, "面板夹到工作区左侧留边");
        assert_eq!(placed.arrow, (anchor.x + 14.0) - PAD, "箭头仍指着齿轮（明显不在面板中心）");
        assert_eq!(placed.arrow, 100.0);
        assert!(placed.arrow >= INSET, "箭头留在圆角以里");

        // 齿轮整个在工作区外面：箭头退到留边处，绝不出面板
        let outside = bubble_placement(rect(-900.0, 10.0, 28.0, 28.0), size(336.0, 320.0), main_monitor(), GAP, PAD, INSET);
        assert_eq!(outside.arrow, INSET);
        assert_eq!(outside.panel.x, PAD);
    }

    /// 齿轮贴右边缘：面板被夹回来，箭头同样滑到右侧留边（仍指着齿轮）。
    #[test]
    fn r60_a_gear_near_the_right_edge_slides_the_arrow_inwards_too() {
        let anchor = rect(1890.0, 10.0, 28.0, 28.0);
        let placed = bubble_placement(anchor, size(336.0, 320.0), main_monitor(), GAP, PAD, INSET);
        assert_eq!(placed.panel.x + 336.0, 1920.0 - PAD, "面板夹到工作区右侧留边");
        assert_eq!(placed.arrow, 336.0 - INSET, "箭头退到右端留边处");
        assert!(placed.window.x + placed.window.width <= 1920.0, "窗口不出工作区");

        // 齿轮在工作区外（更靠右）：箭头停在右端留边
        let outside = bubble_placement(rect(3000.0, 10.0, 28.0, 28.0), size(336.0, 320.0), main_monitor(), GAP, PAD, INSET);
        assert_eq!(outside.arrow, 336.0 - INSET);
    }

    /// 面板比工作区还宽/还高：夹到留边范围里（窗口不出去）。
    #[test]
    fn r60_an_oversized_panel_stays_inside_the_work_area() {
        let area = rect(0.0, 0.0, 300.0, 200.0);
        let placed = bubble_placement(gear(), size(336.0, 320.0), area, GAP, PAD, INSET);
        assert_eq!(placed.panel.x, PAD);
        assert_eq!(placed.panel.y, PAD, "上下都放不下 → 夹回工作区顶部留边");
        assert_eq!(placed.arrow, 336.0 - INSET, "齿轮远在右方：箭头停到右端留边处");
        // 面板比两端留边还窄：箭头无从滑起，只能走中点
        assert_eq!(arrow_offset(500.0, 0.0, 16.0, INSET), 8.0);
    }

    /// 副屏在主屏左边：坐标是负的，夹紧用**工作区原点**（粘 0 会把窗扔回主屏）。
    #[test]
    fn r60_a_monitor_left_of_the_primary_keeps_negative_coordinates() {
        let left = rect(-1920.0, 0.0, 1920.0, 1040.0);
        let anchor = rect(-500.0, 10.0, 28.0, 28.0);
        let placed = bubble_placement(anchor, size(336.0, 320.0), left, GAP, PAD, INSET);
        assert_eq!(placed.panel.x + 168.0, -486.0, "仍以齿轮为中心");
        assert!(placed.panel.x < 0.0, "仍在那块屏上：{placed:?}");
        assert_eq!(placed.arrow, 168.0, "没夹紧 ⇒ 箭头居中");

        let hugging = bubble_placement(rect(-1920.0, 10.0, 8.0, 8.0), size(336.0, 320.0), left, GAP, PAD, INSET);
        assert_eq!(hugging.panel.x, -1920.0 + PAD, "夹到那块屏的左留边，绝不回到 0");
    }

    /// 缩放比 1.5：锚点换算只乘一次，几何随之放大，回报给页面的仍是 CSS 像素。
    #[test]
    fn r60_the_geometry_scales_once_and_reports_css_pixels() {
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

        let scale = 1.5;
        let area = rect(0.0, 0.0, 2880.0, 1560.0);
        let anchor_px = anchor_rect(point(1000.0, 200.0), anchor, scale);
        let panel = bubble_content_size(size(336.0, 320.0), scale, area, PAD * scale);
        assert_eq!(panel, size(504.0, 480.0), "内容尺寸乘一次缩放");
        let placed = bubble_placement(anchor_px, panel, area, GAP * scale, PAD * scale, INSET * scale);
        assert_eq!(placed.side, BubbleSide::Bottom);
        assert_eq!(placed.panel.y, anchor_px.y + anchor_px.height + GAP * scale);
        assert_eq!(placed.arrow, (anchor_px.x + anchor_px.width / 2.0) - placed.panel.x);
        let payload = geometry_payload(&placed, scale);
        assert_eq!(payload["side"], json!("bottom"));
        assert_eq!(payload["pad"], json!(PAD), "页面用的是 CSS 像素，留边就是那个常量");
        let arrow = payload["arrow"].as_f64().expect("箭头必须是数字");
        assert!((arrow - panel.width / scale / 2.0).abs() < 1e-9, "回报的箭头是 CSS 像素：{arrow}");
    }

    /// 内容尺寸：DIP → 物理，并夹进"工作区减去留边"。
    #[test]
    fn r60_content_size_is_scaled_and_clamped_into_the_work_area() {
        assert_eq!(
            bubble_content_size(size(336.0, 320.0), 1.5, main_monitor(), PAD * 1.5),
            size(504.0, 480.0)
        );
        assert_eq!(
            bubble_content_size(size(336.0, 5000.0), 1.0, main_monitor(), PAD),
            size(336.0, 1040.0 - PAD * 2.0),
            "高过工作区就截到留边以内（面板不压出屏幕）"
        );
        assert_eq!(
            bubble_content_size(size(5000.0, 320.0), 1.0, main_monitor(), PAD),
            size(1920.0 - PAD * 2.0, 320.0)
        );
    }

    /// 失焦关闭之后的短窗口内，"打开"被拒；过了窗口照旧打开。
    #[test]
    fn r60_a_second_gear_click_right_after_the_blur_does_not_reopen() {
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
        // 时刻倒退时 `saturating_duration_since` 给 0，仍算"刚关过"，即 fail-closed 宁可不弹。
        assert!(reopen_suppressed(
            Some(now + Duration::from_secs(5)),
            now,
            window
        ));
    }

    /// 渲染层报上来的尺寸：坏值一律不覆盖上一次的好值。
    #[test]
    fn r60_reported_sizes_are_never_guessed() {
        assert_eq!(normalize_content_size(335.6, 320.4), Some(size(336.0, 320.0)));
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
    fn r60_only_the_named_sources_may_drive_the_popup() {
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
        // 配置可以写（面板里的控件就是那条窄命令），媒体动作不行
        assert!(crate::lyrics_window::require_lyrics_source(LYRICS_SETTINGS_WINDOW_LABEL).is_ok());
        assert!(crate::lyrics_window::control_payload(
            LYRICS_SETTINGS_WINDOW_LABEL,
            &json!({"action": "next"})
        )
        .is_err());
    }

    /// 坏锚点一律 `invalid_payload`（宽高为负、NaN、缺字段、不是对象）。
    #[test]
    fn r60_anchors_are_validated_not_guessed() {
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
    fn r60_the_popup_lives_in_its_own_webview_data_directory() {
        assert_eq!(
            popup_data_dir(Path::new("C:\\root")),
            Path::new("C:\\root").join("webview2").join("lyrics-settings")
        );
    }

    /// 页面地址：入口是 lyrics-settings.html，配置与主题都在查询串里（第一帧就是对的）。
    #[test]
    fn r60_the_popup_url_carries_the_config_and_the_theme() {
        let config = LyricsConfig::default().apply_patch(&json!({"layout": "vertical", "size": "xl"}));
        let url = popup_url(&config, crate::theme::ThemeChoice::Dark);
        assert!(url.starts_with("lyrics-settings.html?"), "{url}");
        assert!(url.contains("layout=vertical") && url.contains("size=xl"), "{url}");
        assert!(url.contains("&theme=dark"), "{url}");
    }

    /// 建窗契约（源码扫描：这扇窗的属性一次到位，且它**不销毁**只隐藏）。
    #[test]
    fn r60_the_popup_window_is_built_with_the_contract_attributes() {
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
            "pub fn bubble_placement",
            "pub fn bubble_content_size",
            "pub fn arrow_offset",
            "\"geometry\": geometry_payload",
        ] {
            assert!(production.contains(required), "建窗契约缺一项：{required}");
        }
        // 右边缘对齐的旧定位规则必须整段删掉，不许留一半
        assert!(
            !production.contains("settings_popup_placement")
                && !production.contains("settings_popup_window_rect"),
            "旧的右对齐定位规则必须整段删掉"
        );
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
    fn r60_every_popup_command_is_async_with_its_narrow_guard() {
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
