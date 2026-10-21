//! 桌面歌词窗与任务栏歌词降级（R12）。
//!
//! 这个模块只有三件事，件件都刻意做成"可单测的形状"：
//!
//! 1. **几何是纯函数**（[`taskbar_position`] / [`desktop_position`]）：贴 `work_area` 下沿、
//!    水平居中、偏移负值钳 0、桌面模式再上抬一段并夹回工作区顶部。窗口坐标这种东西，
//!    靠"跑起来看一眼"是验不完的（多显示器、小屏、副屏在主屏左边时坐标是负的），
//!    所以判定全在纯函数里，由内联单测覆盖矩阵。
//! 2. **配置是纯函数 + 会话内状态**（[`LyricsConfig`]）：字号档位、颜色令牌、模式、锁定、点透。
//!    认不出的值一律不猜（落回上一个合法值）；任务栏模式的有效字号 ≤ 20px。
//!    **持久化不做**（简报裁决）：配置只活在 [`LyricsWindowState`] 里，下次启动回默认——
//!    设置项旁边如实写着这件事（`LYRICS_SESSION_NOTICE`）。
//! 3. **命令只在主窗侧**（四个 `core_lyrics_*`）：歌词窗自己**只订阅事件、不调命令**
//!    （`core_call` 的来源守卫本来就把它挡在外面）。建窗**只在 async 命令里做**：
//!    `WebviewWindowBuilder::build` 内部要走一趟主线程往返，同步命令自己就站在主线程上，
//!    等那一趟 = 死锁（旧仓结论）。
//!
//! 任务栏歌词是**降级实现**：三端都没有"往任务栏里写文字"的公开 API，所以本模块只做
//! "独立透明窗 + 贴 work_area 下沿"。**绝不注入系统进程、不装系统钩子、不做 shell 扩展**
//! ——`test/lyrics-window.test.mjs` 有一条全源码扫描把这件事钉死（那类 API 名字 0 命中）。
//!
//! 与托盘的关系：勾选态由托盘自己镜像并翻转（R11），所以**窗命令失败时"把勾选翻回"也只能
//! 由托盘做**（[`crate::tray::revert_lyrics_checked`]）。这里不建"勾选态 ↔ 窗存在性"的第二条
//! 同步链——那两条链迟早会给出两个不同的答案。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::bridge::{CoreError, LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE, APP_NOTICE};
use crate::commands::{emit_core_event, require_main_webview};
use crate::{LYRICS_WINDOW_LABEL, MAIN_WINDOW_LABEL};

// ---------------------------------------------------------------------------
// 几何（纯函数）
// ---------------------------------------------------------------------------

/// 工作区矩形（物理像素）。
///
/// 注意坐标**可以是负的**：副屏摆在主屏左边/上边时，工作区原点就是负的。
/// 把"负偏移钳 0"写成"把最终坐标钳到 0"会把窗口扔到另一块屏上——这是这条规矩最容易写错的地方。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 尺寸（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// 位置（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// 任务栏模式的窗口尺寸（简报给的口径：如 1200×44 —— 一条单行显示带）。
pub const TASKBAR_SIZE: Size = Size {
    width: 1200.0,
    height: 44.0,
};

/// 桌面模式的窗口尺寸：比任务栏那条高一点，让上下行各露一部分（AMLL 自己排版）。
pub const DESKTOP_SIZE: Size = Size {
    width: 960.0,
    height: 120.0,
};

/// 桌面模式在任务栏位置之上再抬多少（正好让开任务栏那一条）。
pub const DESKTOP_LIFT: f64 = 120.0;

/// 窗口尺寸：按模式取标准尺寸，**并夹进工作区**（小屏上窗口不该比屏幕还宽）。
pub fn window_size(area: Rect, mode: LyricsMode) -> Size {
    let wanted = match mode {
        LyricsMode::Taskbar => TASKBAR_SIZE,
        LyricsMode::Desktop => DESKTOP_SIZE,
    };
    Size {
        width: wanted.width.min(area.width),
        height: wanted.height.min(area.height),
    }
}

/// 任务栏位置：水平居中、贴 `work_area` 下沿，**偏移**负值钳 0。
///
/// 钳的是偏移（`居中量` 与 `贴底量`），不是最终坐标：窗口比工作区还宽/还高时，结果是
/// 贴左上角摆（仍然在工作区内），而不是被推到屏幕外。
pub fn taskbar_position(area: Rect, size: Size) -> Point {
    let offset_x = ((area.width - size.width) / 2.0).max(0.0);
    let offset_y = (area.height - size.height).max(0.0);
    Point {
        x: area.x + offset_x,
        y: area.y + offset_y,
    }
}

/// 桌面位置：在任务栏位置之上再抬 [`DESKTOP_LIFT`]，**夹回工作区顶部**（矮屏上不许跑到屏幕外）。
pub fn desktop_position(area: Rect, size: Size) -> Point {
    let base = taskbar_position(area, size);
    Point {
        x: base.x,
        y: (base.y - DESKTOP_LIFT).max(area.y),
    }
}

/// 按模式取位置（窗口摆放的唯一入口）。
pub fn position_for(area: Rect, mode: LyricsMode, size: Size) -> Point {
    match mode {
        LyricsMode::Taskbar => taskbar_position(area, size),
        LyricsMode::Desktop => desktop_position(area, size),
    }
}

// ---------------------------------------------------------------------------
// 配置（纯函数 + 会话内状态）
// ---------------------------------------------------------------------------

/// 两种模式：桌面悬浮条（可拖）与任务栏显示带（贴边、点透）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LyricsMode {
    Desktop,
    Taskbar,
}

impl LyricsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            LyricsMode::Desktop => "desktop",
            LyricsMode::Taskbar => "taskbar",
        }
    }

    /// 认不出的词回 `None`（调用方落回上一个合法值，绝不猜）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "desktop" => Some(LyricsMode::Desktop),
            "taskbar" => Some(LyricsMode::Taskbar),
            _ => None,
        }
    }
}

/// 字号档位表：与 `src/renderer/features/lyrics/lyrics-window.mjs` 的 `LYRICS_FONT_STEPS` 同一张表
/// （`test/lyrics-window.test.mjs` 逐条钉住两侧相等）。CSS 里的 rem 规则在 `amll-theme.css`。
pub const LYRICS_FONT_STEPS: &[(&str, u32)] =
    &[("sm", 16), ("md", 20), ("lg", 28), ("xl", 40), ("xxl", 56)];

/// 任务栏模式的字号上限（简报钉死：≤ 20）。
pub const TASKBAR_MAX_FONT_PX: u32 = 20;

/// 颜色令牌表（唯一真源在渲染层的 `LYRICS_COLOR_TOKENS`，这里是镜像副本）：
/// 只认设计令牌，绝不接受任意色值（`#fff`、`rgb(...)` 一律落回上一个合法值）。
pub const LYRICS_COLOR_TOKENS: &[&str] = &["foreground", "muted", "primary", "contrast"];

/// 默认字号档位。
pub const DEFAULT_LYRICS_SIZE: &str = "lg";
/// 默认颜色令牌。
pub const DEFAULT_LYRICS_COLOR: &str = "foreground";

/// 歌词窗配置（会话内）。
#[derive(Debug, Clone, PartialEq)]
pub struct LyricsConfig {
    pub mode: LyricsMode,
    /// 用户选的档位 id（**不是**生效值：任务栏模式下经 [`LyricsConfig::effective_size`] 压到 ≤20px，
    /// 切回桌面模式时用户的选择还在）。
    pub size: String,
    pub color: String,
    pub locked: bool,
    pub click_through: bool,
}

impl Default for LyricsConfig {
    fn default() -> Self {
        Self {
            mode: LyricsMode::Desktop,
            size: DEFAULT_LYRICS_SIZE.to_string(),
            color: DEFAULT_LYRICS_COLOR.to_string(),
            locked: false,
            click_through: false,
        }
    }
}

impl LyricsConfig {
    /// 生效的字号档位：任务栏模式压到 ≤ [`TASKBAR_MAX_FONT_PX`] 的最大档位；其余模式原样。
    pub fn effective_size(&self) -> &str {
        if self.mode != LyricsMode::Taskbar {
            return self.size.as_str();
        }
        let chosen = LYRICS_FONT_STEPS.iter().find(|(id, _)| *id == self.size);
        if let Some((id, px)) = chosen {
            if *px <= TASKBAR_MAX_FONT_PX {
                return id;
            }
        }
        LYRICS_FONT_STEPS
            .iter()
            .filter(|(_, px)| *px <= TASKBAR_MAX_FONT_PX)
            .next_back()
            .map(|(id, _)| *id)
            .unwrap_or(DEFAULT_LYRICS_SIZE)
    }

    /// 配置补丁（纯函数）：**认不出的值一律不猜**，落回当前值。
    ///
    /// 与渲染层 `normalizeLyricsConfig` 是同一条语义（两侧各有一份实现，测试钉住词表与上限）。
    /// 空补丁 = 原样返回（设置页挂载时用它读回当前配置，不该有任何副作用）。
    pub fn apply_patch(&self, patch: &Value) -> LyricsConfig {
        let Some(patch) = patch.as_object() else {
            return self.clone();
        };
        let mode = patch
            .get("mode")
            .and_then(Value::as_str)
            .and_then(LyricsMode::parse)
            .unwrap_or(self.mode);
        let size = patch
            .get("size")
            .and_then(Value::as_str)
            .filter(|raw| LYRICS_FONT_STEPS.iter().any(|(id, _)| id == raw))
            .map(str::to_string)
            .unwrap_or_else(|| self.size.clone());
        let color = patch
            .get("color")
            .and_then(Value::as_str)
            .filter(|raw| LYRICS_COLOR_TOKENS.contains(raw))
            .map(str::to_string)
            .unwrap_or_else(|| self.color.clone());
        let locked = patch
            .get("locked")
            .and_then(Value::as_bool)
            .unwrap_or(self.locked);
        let click_through = patch
            .get("clickThrough")
            .and_then(Value::as_bool)
            .unwrap_or(self.click_through);
        LyricsConfig {
            mode,
            size,
            color,
            locked,
            click_through,
        }
    }

    /// 广播/回执里的配置形状（`{mode, size, color, locked, clickThrough, effectiveSize}`）。
    pub fn payload(&self) -> Value {
        json!({
            "mode": self.mode.as_str(),
            "size": self.size,
            "color": self.color,
            "locked": self.locked,
            "clickThrough": self.click_through,
            "effectiveSize": self.effective_size(),
        })
    }

    /// 建窗用的查询串：渲染层的**初值**。
    ///
    /// 为什么不"建完再发一条广播"：渲染层订阅事件是异步的，建窗那一刻它可能还没 `listen`——
    /// 事件发进空气，歌词窗会用默认档位显示，而用户明明选过。查询串是同步到位的。
    pub fn query(&self) -> String {
        format!(
            "mode={}&size={}&color={}&locked={}&clickThrough={}",
            self.mode.as_str(),
            self.effective_size(),
            self.color,
            if self.locked { 1 } else { 0 },
            if self.click_through { 1 } else { 0 }
        )
    }
}

/// 点透：用户显式开了就点透；**任务栏模式一律点透**（贴边的一条显示带不该抢底下窗口的点击）。
pub fn click_through_enabled(config: &LyricsConfig) -> bool {
    config.click_through || config.mode == LyricsMode::Taskbar
}

/// 状态回执（`{config, visible}`）：每条命令都回整个状态，免得调用方拿半份状态去猜另一半。
pub fn status_payload(config: &LyricsConfig, visible: bool) -> Value {
    json!({ "config": config.payload(), "visible": visible })
}

/// 歌词窗的**会话内**状态：配置 + 最后一份发出去的歌词文档（唯一真源；持久化不做，见模块头）。
///
/// 登记成托管状态（`lib.rs` 的 setup）：主窗的设置页读它、四条命令改它。
/// 直接用 `Mutex` 而不是 `RwLock`：读也只是一次 clone，省一种锁的心智负担。
///
/// 为什么还要留一份**最后文档**（R41a）：歌词窗每显示一次都会重新加载页面（[`apply_toggle`]），
/// 而"主窗推文档"与"新页面订阅事件"是两条不同步的异步链——主窗推得再快也在新页 `listen()`
/// 之前。缓存 + 加载完成时重发（[`replay_document`]）把这条链的**顺序**钉在唯一知道
/// "页面什么时候就绪"的那一侧（webview 的加载回调），而不是靠"希望它已经订阅了"。
#[derive(Default)]
pub struct LyricsWindowState {
    config: Mutex<LyricsConfig>,
    document: Mutex<Option<Value>>,
}

impl LyricsWindowState {
    pub fn config(&self) -> LyricsConfig {
        lock(&self.config).clone()
    }

    fn store(&self, config: LyricsConfig) {
        *lock(&self.config) = config;
    }

    /// 最后一份**真的发出去过**的歌词文档（`None` = 这次会话还没有歌词可重发）。
    pub fn document(&self) -> Option<Value> {
        lock(&self.document).clone()
    }

    fn store_document(&self, document: Value) {
        *lock(&self.document) = Some(document);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 当前配置：托管状态没登记（理论上不会发生）时用默认值——命令里绝不 panic。
fn config_of<R: Runtime>(app: &AppHandle<R>) -> LyricsConfig {
    match app.try_state::<LyricsWindowState>() {
        Some(state) => state.config(),
        None => {
            log::warn!("歌词窗配置状态未登记：本次按默认配置处理");
            LyricsConfig::default()
        }
    }
}

fn store_config<R: Runtime>(app: &AppHandle<R>, config: LyricsConfig) {
    match app.try_state::<LyricsWindowState>() {
        Some(state) => state.store(config),
        None => log::warn!("歌词窗配置状态未登记：配置只在这一次里生效"),
    }
}

// ---------------------------------------------------------------------------
// 歌词文档（最后一份的缓存 + 页面加载完成时的重发）
// ---------------------------------------------------------------------------

/// 歌词文档归一（**纯函数**）：`{lines, status}`；不是对象就回 `None`（调用方按 `invalid_payload` 报错）。
///
/// 判据与 R12 起的那一版逐条相同（`lines` 不是数组就当空、`status` 认不出就 `unavailable`）——
/// 这里只是把它从命令体里提出来，好让"缓存住的到底是哪一份"可以被单测钉住。
pub fn normalize_document(document: &Value) -> Option<Value> {
    let object = document.as_object()?;
    let lines = object
        .get("lines")
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unavailable");
    Some(json!({ "lines": lines, "status": status }))
}

/// 记下这一份（**发出去的那一刻才记**：缓存里躺着的必须是"用户本来能看到的那一份"）。
fn remember_document<R: Runtime>(app: &AppHandle<R>, document: Value) {
    match app.try_state::<LyricsWindowState>() {
        Some(state) => state.store_document(document),
        None => log::warn!("歌词窗状态未登记：这一份歌词文档没能留到页面重新加载之后"),
    }
}

/// 页面加载完成时把最后一份文档重发一次（**没有就什么都不发**）。
///
/// 这条是 R41a 对"重开歌词窗显示占位直到换歌"的对症修：`reload()` 之后主窗那次重推落在
/// 新页订阅**之前**（Rust 即转即弃），所以重发必须由**知道页面何时就绪**的那一侧做
/// ——`on_page_load(Finished)`（见 [`build_lyrics_window`]）。
///
/// 走的是同一条广播（[`LYRICS_DOCUMENT`]）与同一种信封（[`emit_core_event`]）：歌词窗那边
/// 只有一条消费路径，不因为"这次是重发"而多认一种形状。
pub fn replay_document<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<LyricsWindowState>() else {
        return;
    };
    let Some(document) = state.document() else {
        // 这一次会话还没有任何歌词文档（比如刚启动、还没播过歌）：没什么可重发的
        return;
    };
    // 只记"发了一件事"，**不记文档内容**：歌词文本进了日志就等于把用户的歌单抄进日志文件
    //（与取词那条路同一条纪律）。
    log::info!("歌词窗页面加载完成：重发最后一份歌词文档");
    emit_core_event(app, LYRICS_DOCUMENT, document);
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/// 歌词窗的 webview 数据目录：`<数据根>/webview2/lyrics`（与登录窗 `webview2/login/<partition>` 同款）。
///
/// 独占目录而不是与主窗共用：WebView2 的数据目录同时被两个进程内 webview 打开会互相踩
/// （缓存/Cookie 库的锁）。
pub fn lyrics_data_dir(data_root: &Path) -> PathBuf {
    data_root.join("webview2").join("lyrics")
}

/// 歌词窗的标题（R41）：这是窗口在 **Alt+Tab / 任务视图**里的名字。
///
/// 为什么必须有：tao 的默认标题是 `"Tauri App"`（`WebviewWindowBuilder` 不给 `.title()` 时），
/// 而 `skip_taskbar(true)` 在 Windows 上只做 `ITaskbarList::DeleteTab`（tao 0.37.1 的
/// `set_skip_taskbar`）——它把任务栏那个条目删掉，**没有**碰 `WS_EX_TOOLWINDOW`，
/// 所以窗口仍会出现在 Alt+Tab 里（实测 exStyle `0x40118`：有 `WS_EX_APPWINDOW`、没有 TOOLWINDOW）。
/// 一个没有标题的透明条在 Alt+Tab 里显示成"Tauri App"，用户没有任何线索知道那是什么。
pub const LYRICS_WINDOW_TITLE: &str = "桌面歌词";

/// 建窗加载的地址：`lyrics.html?<配置>&theme=<档位>`（配置经查询串同步到位，见 [`LyricsConfig::query`]）。
///
/// **主题也走查询串**（R41），理由与配置同款、且多一条：歌词窗**调不动**读主题的那条命令
/// （`core_login_chrome` 的来源守卫只放行主窗与两个浮动控件，见 `commands::require_login_chrome_source`），
/// 所以它自己在启动时问不出"现在是哪一档"。查询串是同步到位的，之后的变化由 `theme:changed`
/// 广播补上（订阅广播不需要任何权限）。
///
/// 不带这个参数会怎样（R12 起就一直是那样）：歌词窗永远停在 `:root` 的**浅色**令牌上
/// （`lyrics-main.tsx` 里没有 `installThemeSync`），于是深色主题下歌词用近黑的字浮在深色桌面上
/// ——"有歌词但看不见"。
pub fn lyrics_window_url(config: &LyricsConfig, theme: crate::theme::ThemeChoice) -> String {
    format!("lyrics.html?{}&theme={}", config.query(), theme.setting())
}

/// 歌词窗此刻是不是**开着**（存在且可见）。
///
/// 现问 tauri 的窗口表（`get_webview_window`），不维护第二份镜像——镜像与事实之间只会有漂移。
pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.get_webview_window(LYRICS_WINDOW_LABEL) {
        Some(window) => window.is_visible().unwrap_or(false),
        None => false,
    }
}

/// 取窗口该摆放的工作区：**优先主窗所在显示器**，取不到退主屏。
///
/// 为什么优先主窗所在的那块屏：桌面歌词是"给正在用主窗的人看的"——摆到另一块屏上，
/// 用户会以为它没开。两者都取不到才如实报错（由调用方降级成"留在默认位置"，绝不猜一个坐标）。
fn work_area<R: Runtime>(app: &AppHandle<R>) -> Result<Rect, CoreError> {
    let monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.get_webview_window(LYRICS_WINDOW_LABEL).and_then(|w| w.current_monitor().ok().flatten()))
        .ok_or_else(|| CoreError::new("internal", "取不到显示器的工作区：歌词窗按默认位置显示"))?;

    let area = monitor.work_area();
    Ok(Rect {
        x: f64::from(area.position.x),
        y: f64::from(area.position.y),
        width: f64::from(area.size.width),
        height: f64::from(area.size.height),
    })
}

/// 建窗（**只在 async 命令里调用**：`build` 内部走一趟主线程往返，同步命令会死锁）。
///
/// 建出来是**隐藏**的（`visible(false)`）：先摆好几何再 show，免得用户在屏幕角落看到一闪。
fn build_lyrics_window<R: Runtime>(
    app: &AppHandle<R>,
    config: &LyricsConfig,
) -> Result<WebviewWindow<R>, CoreError> {
    let data_root = app
        .try_state::<crate::WebviewDataRoot>()
        .map(|root| root.0.clone())
        .ok_or_else(|| {
            CoreError::new(
                "internal",
                "webview 数据根尚未登记：歌词窗建不起来（数据目录不能猜）",
            )
        })?;
    let lyrics_data = lyrics_data_dir(&data_root);
    // 目录必须先建：WebView2 不会自建，缺目录时建窗直接 `os error 5`（拒绝访问）
    std::fs::create_dir_all(&lyrics_data).map_err(|source| {
        CoreError::new(
            "internal",
            format!("歌词窗数据目录（{lyrics_data:?}）建不出来：{source}"),
        )
    })?;

    // 代理在**建窗时**读一次 → 改代理要重启应用才生效（与主窗/登录窗同款，R6 的已知限制）。
    // 三窗都接 proxy_url 是审计结论：不接的话 webview 自己的网络栈会绕过设置直连。
    let proxy = crate::proxy_url_argument(crate::webview_proxy::resolve_for_webview(
        &data_root,
        LYRICS_WINDOW_LABEL,
    ));

    let mut builder = WebviewWindowBuilder::new(
        app,
        LYRICS_WINDOW_LABEL,
        WebviewUrl::App(lyrics_window_url(config, crate::theme::current_theme(app)).into()),
    )
    .title(LYRICS_WINDOW_TITLE)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .data_directory(lyrics_data);

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }

    builder
        // 页面（重新）加载完成 → 把最后一份歌词文档重发一次（R41a）。
        //
        // 为什么挂在这里：`apply_toggle` 每次显示已有窗口都会 `reload()`，而主窗的重推
        // 与新页面的 `listen()` 是两条不同步的异步链——重推总是落在订阅之前（即转即弃），
        // 用户会看到占位文案直到换歌。加载完成是**唯一**能确定"新页面已经在跑"的时刻。
        //
        // 只认 `Finished`：`Started` 时页面里的 JS 还没执行，重发等于发进空气。
        // 按 label 过滤：这个回调跟着这个窗的 webview 走，判一次 label 是兜底
        // （"这条广播只发给歌词窗"这件事由它自证，而不是靠"只有一个窗"这种当下的巧合）。
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished || webview.label() != LYRICS_WINDOW_LABEL {
                return;
            }
            replay_document(webview.app_handle());
        })
        .build()
        .map_err(|source| CoreError::new("internal", format!("歌词窗建不起来：{source}")))
}

/// 把配置落到窗口上：尺寸、位置、点透。
///
/// 失败只记日志不上报：**配置（字号/颜色）与窗存在性是两件事**——摆不到理想位置时，
/// 用户至少还能看到歌词（"因为摆不下所以什么都不显示"是更差的降级）。
fn apply_config<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    config: &LyricsConfig,
) -> Result<(), CoreError> {
    let area = work_area(app)?;
    let size = window_size(area, config.mode);
    let point = position_for(area, config.mode, size);

    window
        .set_size(PhysicalSize::new(
            size.width.round().max(1.0) as u32,
            size.height.round().max(1.0) as u32,
        ))
        .map_err(|source| CoreError::new("internal", format!("歌词窗尺寸设置失败：{source}")))?;
    window
        .set_position(PhysicalPosition::new(
            point.x.round() as i32,
            point.y.round() as i32,
        ))
        .map_err(|source| CoreError::new("internal", format!("歌词窗位置设置失败：{source}")))?;
    // 点透：任务栏模式一律点透（见 click_through_enabled）。失败不是致命的——
    // 最坏情况是"点得着它"，比"窗口不见了"轻。
    if let Err(source) = window.set_ignore_cursor_events(click_through_enabled(config)) {
        log::warn!("歌词窗点透设置失败（{source}）：这一条可能挡住鼠标点击");
    }
    Ok(())
}

/// 开关落地：开 = 建（没有就建）/摆好/**重新加载**/显示；关 = **隐藏**（不销毁，webview 与进度都留着）。
///
/// ## 为什么"已经有了的窗"在 show 之前要 reload（R41）
///
/// 这条是**实测出来的缺陷**（R41 真机诊断，见任务报告）：
/// 歌词窗的页面只在**建窗那一刻**加载一次，此后没有任何重新加载的路径——`toggle` 只 hide/show、
/// `configure` 只改尺寸/位置/点透、模块里没有 destroy。于是**任何一次没加载完的页面都会被永久保留**：
///
/// - 实测现场：dev server（`http://localhost:1420`）在 16:27:50 挂掉，歌词窗恰好在那一刻建出来
///   ——HTML/CSS 到了、JS 模块没到，React 从未挂载。窗口是**全透明**的，所以屏幕上什么都看不到
///   （连页内那句占位文案都没有），而用户再怎么开关这个勾选都不会有任何变化，**只有重启应用能救**。
///   取证：品红背板实验里那块 960×120 全是品红（非品红像素 0）——页面确实一个像素都没画。
/// - 生产（`tauri://localhost` 的内嵌资源）虽然极少失败，但"加载失败即永久空白且无路可退"这条性质
///   与触发原因无关：换台慢盘、杀毒软件拦一下、webview 渲染进程崩一次，都会落到同一个状态。
///
/// 所以规则改成：**每一次显示都让页面重新加载一次**（新建的窗除外——它本来就在加载）。
///
/// ## 重新加载之后，歌词从哪来（R41a 修的那一次）
///
/// 页面一重载就回到初始态（没有行、状态是"尚未配置"），所以必须有人把**当前这首**的文档补上。
/// R41 把这件事交给主窗"窗口可见时重推一次"（`use-lyrics-window.ts`），但那一次**必然太早**：
/// `reload()` 是异步的，主窗拿到"已显示"的回执时新页面还在加载——文档落在新页 `listen()` 之前，
/// 此后没有任何补发路径，用户看到的是占位文案，**直到换歌**（换歌会重新走一遍数据链）。
///
/// 现在改成：`core_lyrics_document` 留一份最后发出去的文档（[`remember_document`]），
/// **页面加载完成时由 webview 自己那条回调重发**（[`replay_document`]，见 [`build_lyrics_window`]）。
/// 帧的顺序由"知道页面何时就绪"的那一侧定，而不是靠"希望主窗推得够晚"。
/// 主窗那次重推因此删掉了（它在任何时序下都不落在可用的那一刻，留着只会让人以为它在起作用）。
///
/// 与 R12 的"隐藏不销毁"并不冲突：webview 仍然活着（省掉建窗那几百毫秒与一份新数据目录），
/// 变的只是"页面在打开时是新鲜的"。
fn apply_toggle<R: Runtime>(
    app: &AppHandle<R>,
    config: &LyricsConfig,
    checked: bool,
) -> Result<bool, CoreError> {
    if !checked {
        if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
            window
                .hide()
                .map_err(|source| CoreError::new("internal", format!("歌词窗隐藏失败：{source}")))?;
        }
        return Ok(false);
    }

    let window = match app.get_webview_window(LYRICS_WINDOW_LABEL) {
        // 已经有了（多半是上次隐藏下来的）：**不重摆几何**——用户可能刚把它拖到别处，
        // 每次开关都把它拽回计算位置等于"拖了白拖"。模式/点透变化由 configure 那条路负责。
        Some(window) => {
            // 重新加载（见函数头）：失败只留一行 warn——"页面没能刷新"不该让"打开歌词"这件事失败，
            // 用户至少还有上一次那份页面（比"什么都看不到"好）。
            if let Err(error) = window.reload() {
                log::warn!("歌词窗页面没能重新加载（继续显示现有页面）：{error}");
            }
            window
        }
        None => {
            let window = build_lyrics_window(app, config)?;
            if let Err(error) = apply_config(app, &window, config) {
                log::warn!("歌词窗没能摆到目标位置（按默认位置显示）：{error}");
            }
            window
        }
    };
    // `show()` 失败发生在 `build()` 之后：窗已经在 label 表里了，如实报错让上层提示并翻回勾选
    window
        .show()
        .map_err(|source| CoreError::new("internal", format!("歌词窗显示不出来：{source}")))?;
    Ok(true)
}

/// 开关失败时的收口（纯函数）：勾选态回到**窗实际在不在**，并给一句给用户看的提示。
///
/// 为什么不建"勾选态 ↔ 窗存在性"的双向同步链：那两条链迟早给出两个不同的答案。
/// 这里的规矩只有一条——**失败时以事实为准**（窗在就是勾着，不在就是没勾），
/// 而"勾"这个动作本身仍由托盘自己翻转（R11）。
#[derive(Debug, Clone, PartialEq)]
pub struct ToggleFailurePlan {
    /// 托盘勾选项应当被改成什么（= 窗此刻的实际状态）。
    pub tray_checked: bool,
    /// 给用户看的提示（经 `app:notice` 广播）。
    pub notice: String,
}

pub fn toggle_failure_plan(requested_open: bool, window_visible: bool, reason: &str) -> ToggleFailurePlan {
    let action = if requested_open { "打开" } else { "关闭" };
    ToggleFailurePlan {
        tray_checked: window_visible,
        notice: format!("桌面歌词没能{action}（{reason}）：托盘的勾选已按实际状态翻回。"),
    }
}

// ---------------------------------------------------------------------------
// 命令面（四条，全部 async + 全部过主窗来源守卫）
// ---------------------------------------------------------------------------

/// 开/关桌面歌词窗。`checked` 是**目标态**（托盘的 `lyrics:toggle` 给的就是它，不做"切换一下"）。
#[tauri::command]
pub async fn core_lyrics_toggle(
    app: AppHandle,
    webview: tauri::Webview,
    checked: bool,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;

    let config = config_of(&app);
    match apply_toggle(&app, &config, checked) {
        Ok(visible) => {
            // 窗回来时把配置再对齐一次（幂等）：会话内改过档位的窗口被藏起来再显示，
            // 设置页与窗里的字号必须是同一个。
            emit_core_event(&app, LYRICS_STATE, status_payload(&config, visible));
            Ok(status_payload(&config, visible))
        }
        Err(error) => {
            // 失败收口：勾选翻回实际状态 + 一条给用户看的提示（托盘的勾选只有托盘能改）
            let plan = toggle_failure_plan(checked, is_open(&app), &error.message);
            crate::tray::revert_lyrics_checked(&app, plan.tray_checked);
            emit_core_event(&app, APP_NOTICE, json!({ "text": plan.notice }));
            Err(error)
        }
    }
}

/// 改配置（字号/颜色/模式/锁定/点透）。
///
/// **空补丁 = 读回当前配置**：设置页挂载时用它（所以不需要第五条"读配置"命令），
/// 而且空补丁不广播、不动窗口——读操作不该有副作用。
#[tauri::command]
pub async fn core_lyrics_configure(
    app: AppHandle,
    webview: tauri::Webview,
    config: Option<Value>,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;

    let current = config_of(&app);
    let next = current.apply_patch(&config.unwrap_or(Value::Null));
    if next != current {
        store_config(&app, next.clone());
        if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
            // 只有**几何或点透**真的变了才重摆：换字号/颜色不该把用户拖到的位置拽回来
            let moved = next.mode != current.mode;
            let clicks = click_through_enabled(&next) != click_through_enabled(&current);
            if moved || clicks {
                if let Err(error) = apply_config(&app, &window, &next) {
                    log::warn!("歌词窗配置已更新，但没能重新摆位（{error}）");
                }
            }
        }
        emit_core_event(&app, LYRICS_STATE, status_payload(&next, is_open(&app)));
    }
    Ok(status_payload(&next, is_open(&app)))
}

/// 把歌词文档转发给歌词窗（歌词窗没有业务频道权限，数据只能由主窗转发）。
///
/// 顺手**留一份**（[`remember_document`]）：歌词窗每显示一次都会重新加载页面，那一份要由
/// [`replay_document`] 在加载完成时重发。留的是归一之后的形状——缓存里躺着的与发出去的
/// 必须是同一份，否则"重发"会是一种谁都没见过的形状。
#[tauri::command]
pub async fn core_lyrics_document(
    app: AppHandle,
    webview: tauri::Webview,
    document: Value,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;

    let Some(payload) = normalize_document(&document) else {
        return Err(CoreError::new(
            "invalid_payload",
            "歌词文档必须是对象（{lines, status}）",
        ));
    };

    remember_document(&app, payload.clone());
    emit_core_event(&app, LYRICS_DOCUMENT, payload);
    Ok(Value::Null)
}

/// 推进度（主窗的 rAF 已经按 ≥100ms / 播放或跳转变化节流过）。
#[tauri::command]
pub async fn core_lyrics_progress(
    app: AppHandle,
    webview: tauri::Webview,
    progress: Value,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;

    let Some(object) = progress.as_object() else {
        return Err(CoreError::new(
            "invalid_payload",
            "进度必须是对象（{timeMs, playing, seekGeneration}）",
        ));
    };
    let time_ms = object
        .get("timeMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
        .round();
    let playing = object
        .get("playing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let seek_generation = object
        .get("seekGeneration")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    emit_core_event(
        &app,
        LYRICS_PROGRESS,
        json!({ "timeMs": time_ms, "playing": playing, "seekGeneration": seek_generation }),
    );
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// 主屏常见形态：1920×1080，任务栏 40px 高 → 工作区 1920×1040。
    fn main_monitor() -> Rect {
        area(0.0, 0.0, 1920.0, 1040.0)
    }

    #[test]
    fn taskbar_position_centers_horizontally_and_sits_on_the_work_area_bottom() {
        let size = window_size(main_monitor(), LyricsMode::Taskbar);
        assert_eq!(size, TASKBAR_SIZE, "大屏上按标准尺寸");
        let point = taskbar_position(main_monitor(), size);
        assert_eq!(point.x, (1920.0 - 1200.0) / 2.0, "水平居中");
        assert_eq!(point.y, 1040.0 - 44.0, "贴工作区下沿（= 任务栏上沿）");
    }

    #[test]
    fn desktop_position_lifts_above_the_taskbar_and_clamps_to_the_area_top() {
        let size = window_size(main_monitor(), LyricsMode::Desktop);
        let taskbar = taskbar_position(main_monitor(), size);
        let desktop = desktop_position(main_monitor(), size);
        assert_eq!(desktop.x, taskbar.x, "水平位置与任务栏模式一致");
        assert_eq!(desktop.y, taskbar.y - DESKTOP_LIFT, "在任务栏位置之上再抬 120px");

        // 矮屏：抬不动了要夹回工作区顶部（不许跑到屏幕外）
        let short = area(0.0, 0.0, 1280.0, 130.0);
        let short_size = window_size(short, LyricsMode::Desktop);
        let clamped = desktop_position(short, short_size);
        assert_eq!(clamped.y, short.y, "夹回工作区顶部");
        assert!(clamped.y >= short.y, "任何情况下都不许高于工作区顶部");
    }

    /// 小屏：窗口尺寸夹进工作区，位置贴着左上角（偏移钳 0 的正确含义）。
    #[test]
    fn tiny_work_area_clamps_size_and_never_pushes_the_window_offscreen() {
        let tiny = area(0.0, 0.0, 800.0, 600.0);
        let taskbar_size = window_size(tiny, LyricsMode::Taskbar);
        assert_eq!(taskbar_size, Size { width: 800.0, height: 44.0 }, "宽度夹到屏幕宽");
        let point = taskbar_position(tiny, taskbar_size);
        assert_eq!(point, Point { x: 0.0, y: 600.0 - 44.0 });

        // 窗口比工作区还高：贴顶摆（偏移钳 0），绝不出现负的偏移把内容推到屏幕外
        let squat = area(0.0, 0.0, 800.0, 30.0);
        let squat_size = window_size(squat, LyricsMode::Taskbar);
        assert_eq!(squat_size.height, 30.0);
        assert_eq!(taskbar_position(squat, squat_size), Point { x: 0.0, y: 0.0 });
    }

    /// **负坐标**：副屏摆在主屏左边时工作区原点就是负的（-1920）。
    ///
    /// 这条用例钉的正是"负偏移钳 0"最容易写错的地方：钳的是**偏移**，不是最终坐标——
    /// 把坐标钳到 0 会把窗口从左侧副屏扔到主屏上，而用户明明把应用放那边。
    #[test]
    fn a_monitor_left_of_the_primary_keeps_its_negative_origin() {
        let left = area(-1920.0, 0.0, 1920.0, 1040.0);
        let size = window_size(left, LyricsMode::Taskbar);
        let point = taskbar_position(left, size);
        assert_eq!(point.x, -1920.0 + (1920.0 - 1200.0) / 2.0);
        assert!(point.x < 0.0, "副屏在主屏左边时 x 就该是负的：{point:?}");
        assert!(point.x >= left.x, "仍然落在那块屏的工作区内");

        let desktop = desktop_position(left, window_size(left, LyricsMode::Desktop));
        assert!(desktop.x < 0.0, "桌面模式同理（同一块屏）");
        assert!(desktop.y >= left.y, "夹回那块屏的工作区顶部");
    }

    /// 多显示器矩阵：三块屏（左副屏 / 主屏 / 右上副屏）各自的窗口都落在自己的工作区内。
    #[test]
    fn every_monitor_keeps_the_window_inside_its_own_work_area() {
        let monitors = [
            area(-1920.0, 0.0, 1920.0, 1040.0),
            area(0.0, 0.0, 2560.0, 1400.0),
            area(2560.0, -200.0, 1280.0, 1024.0),
        ];
        for monitor in monitors {
            for mode in [LyricsMode::Taskbar, LyricsMode::Desktop] {
                let size = window_size(monitor, mode);
                let point = position_for(monitor, mode, size);
                assert!(
                    point.x >= monitor.x && point.x + size.width <= monitor.x + monitor.width + 0.001,
                    "模式 {mode:?} 在 {monitor:?} 上横向越界：{point:?} / {size:?}"
                );
                assert!(
                    point.y >= monitor.y && point.y + size.height <= monitor.y + monitor.height + 0.001,
                    "模式 {mode:?} 在 {monitor:?} 上纵向越界：{point:?} / {size:?}"
                );
            }
        }
    }

    #[test]
    fn config_defaults_are_the_session_defaults() {
        let config = LyricsConfig::default();
        assert_eq!(config.mode, LyricsMode::Desktop);
        assert_eq!(config.size, "lg");
        assert_eq!(config.color, "foreground");
        assert!(!config.locked);
        assert!(!config.click_through);
        assert_eq!(config.effective_size(), "lg");
    }

    #[test]
    fn config_patch_never_guesses_unknown_values() {
        let base = LyricsConfig {
            mode: LyricsMode::Desktop,
            size: "xl".to_string(),
            color: "primary".to_string(),
            locked: true,
            click_through: true,
        };

        // 空补丁 / 坏补丁 = 原样（设置页挂载时用它读回当前配置）
        assert_eq!(base.apply_patch(&json!({})), base);
        assert_eq!(base.apply_patch(&Value::Null), base);
        assert_eq!(base.apply_patch(&json!("nope")), base);

        // 认不出的值逐个落回原值（尤其不许把字符串/数字当布尔）
        let bogus = base.apply_patch(&json!({
            "mode": "floating",
            "size": "999",
            "color": "#fff",
            "locked": "yes",
            "clickThrough": 1,
        }));
        assert_eq!(bogus, base);

        // 合法值照收
        let patched = base.apply_patch(&json!({
            "mode": "taskbar",
            "size": "md",
            "color": "contrast",
            "locked": false,
            "clickThrough": false,
        }));
        assert_eq!(patched.mode, LyricsMode::Taskbar);
        assert_eq!(patched.size, "md");
        assert_eq!(patched.color, "contrast");
        assert!(!patched.locked);
        assert!(!patched.click_through);
    }

    /// 简报钉死的上限：任务栏模式的有效字号 ≤ 20px，且**配置值本身保留**（切回桌面能还原）。
    #[test]
    fn taskbar_mode_caps_the_effective_font_size_without_losing_the_choice() {
        for (id, px) in LYRICS_FONT_STEPS {
            let config = LyricsConfig {
                mode: LyricsMode::Taskbar,
                size: (*id).to_string(),
                ..LyricsConfig::default()
            };
            let effective = config.effective_size();
            let effective_px = LYRICS_FONT_STEPS
                .iter()
                .find(|(step, _)| step == &effective)
                .map(|(_, px)| *px)
                .expect("生效档位必须在表里");
            assert!(
                effective_px <= TASKBAR_MAX_FONT_PX,
                "{id}（{px}px）在任务栏模式下必须被压到 ≤{TASKBAR_MAX_FONT_PX}px，实际 {effective}（{effective_px}px）"
            );
        }

        let big = LyricsConfig {
            size: "xxl".to_string(),
            ..LyricsConfig::default()
        };
        assert_eq!(big.effective_size(), "xxl", "桌面模式原样");
        let taskbar = LyricsConfig {
            mode: LyricsMode::Taskbar,
            ..big.clone()
        };
        assert_eq!(taskbar.effective_size(), "md", "xxl 压到 20px 那一档");
        assert_eq!(taskbar.size, "xxl", "用户选的档位保留着");

        // 认不出的档位（盘上被人改过）：落默认，绝不 panic
        let broken = LyricsConfig {
            mode: LyricsMode::Taskbar,
            size: "huge".to_string(),
            ..LyricsConfig::default()
        };
        assert_eq!(broken.effective_size(), "md");
    }

    #[test]
    fn taskbar_mode_is_always_click_through_and_desktop_mode_is_not() {
        let desktop = LyricsConfig::default();
        assert!(!click_through_enabled(&desktop), "桌面模式默认可点（要能接手拖动）");
        let explicit = LyricsConfig {
            click_through: true,
            ..LyricsConfig::default()
        };
        assert!(click_through_enabled(&explicit), "用户显式开了就点透");
        let taskbar = LyricsConfig {
            mode: LyricsMode::Taskbar,
            ..LyricsConfig::default()
        };
        assert!(click_through_enabled(&taskbar), "任务栏模式一律点透");
    }

    #[test]
    fn window_url_carries_the_effective_config_the_theme_and_the_renderer_reads_the_same_keys() {
        let config = LyricsConfig {
            mode: LyricsMode::Taskbar,
            size: "xxl".to_string(),
            color: "contrast".to_string(),
            locked: true,
            click_through: false,
        };
        let url = lyrics_window_url(&config, crate::theme::ThemeChoice::Dark);
        assert!(url.starts_with("lyrics.html?"), "加载的是 R1 建好的那个入口：{url}");
        assert!(url.contains("mode=taskbar"), "{url}");
        assert!(url.contains("size=md"), "查询串里带的是**生效**档位（任务栏 ≤20px）：{url}");
        assert!(url.contains("color=contrast"), "{url}");
        assert!(url.contains("locked=1"), "布尔写成 0/1（渲染层只认这两个值）：{url}");
        assert!(url.contains("clickThrough=0"), "{url}");
        // R41：主题也走查询串（歌词窗调不动读主题的那条命令，只能由建窗那一刻同步给它）
        assert!(url.contains("&theme=dark"), "深色档位要真的带上：{url}");
        assert!(
            lyrics_window_url(&config, crate::theme::ThemeChoice::System).contains("&theme=system"),
            "跟随系统那一档同样是三个字面量之一（渲染层按 system = 不加类处理）"
        );
        assert_ne!(
            lyrics_window_url(&config, crate::theme::ThemeChoice::Light),
            lyrics_window_url(&config, crate::theme::ThemeChoice::Dark),
            "不同档位必须给出不同的地址（否则歌词窗永远停在浅色令牌上）"
        );
    }

    /// R41：显示已有窗口之前必须**重新加载**页面（从"页面没加载完 ⇒ 永久空白"里恢复的唯一出路）。
    ///
    /// 这条只能扫源码：真要验得建一个真窗并让它的加载失败，而本任务不能重启应用。
    /// 扫描同时把"新建那条分支不许 reload"钉住——新建的窗本来就在加载，reload 会把它打断。
    #[test]
    fn showing_an_existing_lyrics_window_reloads_the_page_but_a_fresh_one_is_left_alone() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let start = production.find("fn apply_toggle").expect("apply_toggle 必须在");
        let body = &production[start..];
        let existing = body.find("Some(window) => {").expect("必须有「已经有了」那条分支");
        let building = body.find("None => {").expect("必须有「新建」那条分支");
        let reload = body.find("window.reload()").expect("显示已有窗口前必须重新加载页面");
        assert!(
            existing < reload && reload < building,
            "reload 必须在「已经有了」那条分支里（不是新建那条）"
        );
        assert!(
            body[reload..].contains("log::warn!"),
            "重新加载失败只留一行 warn：刷新不了不该让「打开歌词」这件事失败"
        );
    }

    /// R41a：歌词文档的归一（缓存里躺着的与发出去的必须是同一份形状）。
    #[test]
    fn the_document_is_normalized_before_it_is_kept_and_broadcast() {
        assert_eq!(
            normalize_document(&json!({ "lines": [1, 2], "status": "ready" })),
            Some(json!({ "lines": [1, 2], "status": "ready" }))
        );
        // `lines` 不是数组 → 空数组；`status` 认不出（缺/空/非字符串）→ unavailable
        assert_eq!(
            normalize_document(&json!({ "lines": "nope", "status": "" })),
            Some(json!({ "lines": [], "status": "unavailable" }))
        );
        assert_eq!(
            normalize_document(&json!({ "status": 7 })),
            Some(json!({ "lines": [], "status": "unavailable" }))
        );
        assert_eq!(normalize_document(&json!({})), Some(json!({ "lines": [], "status": "unavailable" })));
        // 不是对象 = 用不了（命令按 invalid_payload 回错，缓存里不留东西）
        assert_eq!(normalize_document(&json!("nope")), None);
        assert_eq!(normalize_document(&json!([1, 2])), None);
        assert_eq!(normalize_document(&Value::Null), None);
    }

    /// R41a：最后一份文档真的留在状态里（`None` = 这次会话还没有歌词可重发）。
    #[test]
    fn the_state_keeps_the_last_document_for_the_replay() {
        let state = LyricsWindowState::default();
        assert_eq!(state.document(), None, "刚启动时没有可重发的文档");

        state.store_document(normalize_document(&json!({ "lines": [1], "status": "ready" })).unwrap());
        assert_eq!(
            state.document(),
            Some(json!({ "lines": [1], "status": "ready" })),
            "缓存的是归一之后那一份"
        );

        // 每推一份就换一份（缓存的是"最后一份"，不是"第一份"）
        state.store_document(normalize_document(&json!({ "lines": [], "status": "unavailable" })).unwrap());
        assert_eq!(state.document(), Some(json!({ "lines": [], "status": "unavailable" })));

        // 文档与配置各占一把锁：改配置不会把文档弄丢（两件事互不干扰）
        state.store(LyricsConfig {
            mode: LyricsMode::Taskbar,
            ..LyricsConfig::default()
        });
        assert_eq!(state.config().mode, LyricsMode::Taskbar);
        assert_eq!(state.document(), Some(json!({ "lines": [], "status": "unavailable" })));
    }

    /// R41a：**页面加载完成**时重发最后一份文档（按 label 过滤），且只认 `Finished`。
    ///
    /// 这条只能扫源码（本任务不能重启应用、也起不了真窗），扫的是"重发挂在哪个回调上、
    /// 什么时候发"——正是 R41 缺的那一环。
    #[test]
    fn a_finished_page_load_replays_the_last_document_to_the_lyrics_window() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];

        let start = production.find("fn build_lyrics_window").expect("建窗函数必须在");
        let body = &production[start..];
        let hook = body.find(".on_page_load(").expect("建窗时必须挂页面加载回调（重发的唯一时机）");
        let built = body.find(".build()").expect("建窗要真的 build");
        assert!(hook < built, "回调要挂在 build 之前（挂在之后就没有那一刻了）");

        let callback = &body[hook..built];
        assert!(
            callback.contains("PageLoadEvent::Finished"),
            "只认加载完成：Started 时页面里的 JS 还没跑，重发等于发进空气"
        );
        assert!(
            !callback.contains("PageLoadEvent::Started"),
            "Started 不是重发的时机"
        );
        assert!(
            callback.contains("webview.label() != LYRICS_WINDOW_LABEL"),
            "按 label 过滤：这条广播只发给歌词窗那一个 webview"
        );
        assert!(
            callback.contains("replay_document("),
            "回调里要真的重发（不是只记一行日志）"
        );

        // 重发走的是同一条广播与同一个信封构造点（歌词窗只有一条消费路径）
        let replay = production.find("pub fn replay_document").expect("重发函数必须在");
        let replay_body = &production[replay..];
        assert!(
            replay_body.contains("emit_core_event(app, LYRICS_DOCUMENT, document)"),
            "重发用的是同一条歌词广播"
        );
        assert!(
            !replay_body.contains("app.emit("),
            "不许绕开唯一构造点自己 emit"
        );
        // 日志里不许出现文档内容（歌词文本进日志 = 把用户的歌单抄进日志文件）
        let log_line = replay_body.find("log::info!").expect("重发要留一行日志（不然真机上无从取证）");
        let log_end = replay_body[log_line..].find(");").expect("日志语句要收尾");
        assert!(
            !replay_body[log_line..log_line + log_end].contains("document"),
            "日志里不许带上文档本身"
        );
    }

    /// R41a：缓存发生在**发出去之前**（缓存住的必须是用户本来能看到的那一份）。
    #[test]
    fn the_document_command_keeps_the_document_it_broadcasts() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let start = production.find("pub async fn core_lyrics_document(").expect("这条命令必须在");
        let body = &production[start..];
        let normalized = body.find("normalize_document(").expect("先归一（缓存的与发出的必须是同一份形状）");
        let kept = body.find("remember_document(").expect("要留一份给页面重新加载之后");
        let emitted = body.find("emit_core_event(").expect("照旧立刻发出去（当次显示不等重发）");
        assert!(
            normalized < kept && kept < emitted,
            "顺序是：归一 → 留一份 → 发出去（留的是发出去的那一份）"
        );
        assert!(
            body[..kept].contains("return Err("),
            "归一失败要如实报错（不许把半个文档发出去，也不许缓存它）"
        );
    }

    /// R41：窗口标题是给 Alt+Tab 看的（`skip_taskbar` 只删任务栏条目，不碰 WS_EX_TOOLWINDOW）。
    #[test]
    fn the_window_carries_a_human_title_for_alt_tab() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        assert!(production.contains(".title(LYRICS_WINDOW_TITLE)"), "建窗时必须给标题");
        assert!(
            production.contains("pub const LYRICS_WINDOW_TITLE: &str = \"桌面歌词\";"),
            "标题是给用户看的（不是 \"Tauri App\" 那种默认值）"
        );
    }

    #[test]
    fn status_payload_has_the_shape_the_renderer_projects() {
        let payload = status_payload(&LyricsConfig::default(), true);
        assert_eq!(payload["visible"], json!(true));
        let config = payload["config"].as_object().expect("config 必须是对象");
        let mut keys: Vec<&str> = config.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["clickThrough", "color", "effectiveSize", "locked", "mode", "size"],
            "形状是契约（渲染层的 lyricsStatusFromAnswer 按它投影）"
        );
    }

    #[test]
    fn the_lyrics_window_lives_in_its_own_webview_data_directory() {
        let dir = lyrics_data_dir(Path::new("C:\\root"));
        assert_eq!(
            dir,
            Path::new("C:\\root").join("webview2").join("lyrics"),
            "独占数据目录：与主窗共用会被 WebView2 的库锁互相踩"
        );
    }

    /// 失败收口：勾选态回到**窗实际在不在**，提示里要有原因、不许画饼、不许写任务号。
    #[test]
    fn toggle_failure_plan_reverts_the_checkbox_to_reality() {
        let open_failed = toggle_failure_plan(true, false, "歌词窗建不起来：os error 5");
        assert!(!open_failed.tray_checked, "窗没开成 → 勾选翻回未勾");
        assert!(open_failed.notice.contains("os error 5"), "原因不许丢：{}", open_failed.notice);
        assert!(open_failed.notice.contains("桌面歌词"));
        assert!(open_failed.notice.contains("翻回"));
        assert!(!open_failed.notice.contains("R12"), "文案是给用户的：{}", open_failed.notice);
        assert!(!open_failed.notice.contains("敬请期待"));

        let close_failed = toggle_failure_plan(false, true, "歌词窗隐藏失败：超时");
        assert!(close_failed.tray_checked, "关不掉 → 勾选翻回勾上（窗还在）");
        assert!(close_failed.notice.contains("关闭"), "{}", close_failed.notice);

        // 目标态与实际态一致时也照样按事实走（不猜"用户到底想要什么"）
        assert!(toggle_failure_plan(true, true, "x").tray_checked);
        assert!(!toggle_failure_plan(false, false, "x").tray_checked);
    }

    /// 源码扫描：窗属性一次到位 + **隐藏不销毁** + 代理三窗收口。
    ///
    /// 这些是"建窗那一刻"的性质，跑不起来真窗就没法验（本任务环境起不了真窗，如实记 untested），
    /// 所以用源码扫描把它们钉住——至少有据可查，而不是靠人眼。
    #[test]
    fn the_window_is_built_with_the_contract_attributes_and_hidden_not_destroyed() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];

        for required in [
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
            "set_ignore_cursor_events(",
            "LYRICS_WINDOW_LABEL",
        ] {
            assert!(production.contains(required), "建窗契约缺一项：{required}");
        }
        assert!(!production.contains(".destroy("), "关闭桌面歌词 = 隐藏，不销毁（保住 webview 与进度）");
        assert!(production.contains(".hide()"), "必须真的调 hide()");

        // 三条广播都得从这里发出去（歌词窗唯一的输入）；用**调用形状**扫（去掉空白再比，
        // rustfmt 换行不该让用例变红），免得只 import 了常量就算过
        let compact: String = production.chars().filter(|c| !c.is_whitespace()).collect();
        for name in ["LYRICS_DOCUMENT", "LYRICS_PROGRESS", "LYRICS_STATE", "APP_NOTICE"] {
            assert!(
                compact.contains(&format!("emit_core_event(&app,{name},")),
                "{name} 要在本模块里真的发出去（emit_core_event 的唯一构造点）"
            );
        }
        // 信封的唯一构造点仍是 commands::emit_core_event（R11 的纪律）
        assert!(!production.contains("app.emit("), "不许绕开唯一构造点自己 emit");
        assert!(production.contains("emit_core_event("));
    }

    /// 四个命令都必须是 async 且过主窗来源守卫（同步建窗会死锁；守卫是权限收口）。
    #[test]
    fn every_command_is_async_and_guarded_by_the_main_window() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];

        for name in [
            "core_lyrics_toggle",
            "core_lyrics_configure",
            "core_lyrics_document",
            "core_lyrics_progress",
        ] {
            let start = production
                .find(&format!("pub async fn {name}("))
                .unwrap_or_else(|| panic!("{name} 必须是 async 命令"));
            let body = &production[start..];
            let guard = body
                .find("require_main_webview(")
                .unwrap_or_else(|| panic!("{name} 必须过主窗来源守卫"));
            assert!(guard < 900, "{name} 的守卫要在最前面（守卫={guard}）");
        }
        assert_eq!(
            production.matches("#[tauri::command]").count(),
            4,
            "命令面恰好四条（多一条就是白名单悄悄放宽）"
        );
    }
}
