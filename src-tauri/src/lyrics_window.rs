//! 桌面歌词的运行配置与 revision 由 Rust 原子持有，主窗代理 settings 持久化。
//! 配置/媒体专命令限 main/lyrics；开关、文档、进度与 core_call 仍限主窗。
//! desktop 几何只随 mode/layout 变化；Windows taskbar 交独立原生宿主，失败停显而不贴边。

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
    height: 160.0,
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

/// 桌面悬浮与 Windows 自窗内嵌 Beta（单行、点透）。
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

pub const LYRICS_LAYOUTS: &[&str] = &["horizontal", "vertical"];
pub const LYRICS_STYLES: &[&str] = &["clean", "panel"];
pub const LYRICS_CONTROL_ACTIONS: &[&str] = &["toggle", "previous", "next"];

#[derive(Debug, Clone, PartialEq)]
pub struct LyricsConfig {
    pub mode: LyricsMode,
    pub layout: String,
    pub style: String,
    pub size: String,
    pub color: String,
    pub locked: bool,
    pub click_through: bool,
    pub enable_blur: bool,
    pub enable_scale: bool,
    pub enable_spring: bool,
    pub show_controls: bool,
}

impl Default for LyricsConfig {
    fn default() -> Self {
        Self {
            mode: LyricsMode::Desktop,
            layout: "horizontal".into(),
            style: "clean".into(),
            size: DEFAULT_LYRICS_SIZE.to_string(),
            color: DEFAULT_LYRICS_COLOR.to_string(),
            locked: false,
            click_through: false,
            enable_blur: true,
            enable_scale: true,
            enable_spring: true,
            show_controls: true,
        }
    }
}

impl LyricsConfig {
    pub fn effective_size(&self) -> &str {
        if self.mode != LyricsMode::Taskbar {
            return self.size.as_str();
        }
        let chosen = LYRICS_FONT_STEPS.iter().find(|(id, _)| *id == self.size);
        if let Some((id, px)) = chosen {
            if *px <= TASKBAR_MAX_FONT_PX { return id; }
        }
        LYRICS_FONT_STEPS.iter().filter(|(_, px)| *px <= TASKBAR_MAX_FONT_PX)
            .next_back().map(|(id, _)| *id).unwrap_or(DEFAULT_LYRICS_SIZE)
    }

    pub fn apply_patch(&self, patch: &Value) -> LyricsConfig {
        let Some(patch) = patch.as_object() else { return self.clone(); };
        let mut next = self.clone();
        if let Some(mode) = patch.get("mode").and_then(Value::as_str).and_then(LyricsMode::parse) { next.mode = mode; }
        for (key, target, allowed) in [
            ("layout", &mut next.layout, LYRICS_LAYOUTS),
            ("style", &mut next.style, LYRICS_STYLES),
            ("color", &mut next.color, LYRICS_COLOR_TOKENS),
        ] {
            if let Some(value) = patch.get(key).and_then(Value::as_str).filter(|v| allowed.contains(v)) { *target = value.into(); }
        }
        if let Some(value) = patch.get("size").and_then(Value::as_str).filter(|v| LYRICS_FONT_STEPS.iter().any(|(id, _)| id == v)) { next.size = value.into(); }
        for (key, target) in [
            ("locked", &mut next.locked), ("clickThrough", &mut next.click_through),
            ("enableBlur", &mut next.enable_blur), ("enableScale", &mut next.enable_scale),
            ("enableSpring", &mut next.enable_spring), ("showControls", &mut next.show_controls),
        ] { if let Some(value) = patch.get(key).and_then(Value::as_bool) { *target = value; } }
        next
    }

    pub fn payload(&self) -> Value {
        json!({
            "mode": self.mode.as_str(), "layout": self.layout, "style": self.style,
            "size": self.size, "color": self.color, "locked": self.locked,
            "clickThrough": self.click_through, "enableBlur": self.enable_blur,
            "enableScale": self.enable_scale, "enableSpring": self.enable_spring,
            "showControls": self.show_controls, "effectiveSize": self.effective_size(),
        })
    }

    pub fn query(&self) -> String {
        format!(
            "mode={}&size={}&color={}&locked={}&clickThrough={}&layout={}&style={}&enableBlur={}&enableScale={}&enableSpring={}&showControls={}",
            self.mode.as_str(), self.size, self.color, u8::from(self.locked), u8::from(self.click_through),
            self.layout, self.style, u8::from(self.enable_blur), u8::from(self.enable_scale),
            u8::from(self.enable_spring), u8::from(self.show_controls),
        )
    }
}

pub fn desktop_topmost(config: &LyricsConfig) -> bool { config.mode == LyricsMode::Desktop }

pub fn click_through_enabled(config: &LyricsConfig) -> bool {
    config.click_through || config.mode == LyricsMode::Taskbar
}

pub fn status_payload(config: &LyricsConfig, visible: bool, revision: u64) -> Value {
    json!({ "config": config.payload(), "visible": visible, "revision": revision })
}

#[derive(Default, Clone)]
pub struct LyricsSnapshot {
    config: LyricsConfig,
    revision: u64,
}

#[derive(Default)]
pub struct LyricsWindowState {
    config: Mutex<LyricsSnapshot>,
    document: Mutex<Option<Value>>,
    lifecycle: Mutex<LyricsLifecycle>,
    operations: tauri::async_runtime::Mutex<()>,
    runtime_status: Mutex<(u64, Option<Value>)>,
}

#[derive(Default)]
struct LyricsLifecycle {
    requested: bool,
    generation: u64,
    live_generation: Option<u64>,
    desktop_position: Option<Point>,
    shutting_down: bool,
    destroy_waiter: Option<(u64, std::sync::mpsc::Sender<bool>)>,
}

impl LyricsWindowState {
    pub fn snapshot(&self) -> LyricsSnapshot { lock(&self.config).clone() }
    pub fn config(&self) -> LyricsConfig { self.snapshot().config }

    fn with_desktop_position<T>(&self, apply: impl FnOnce(Option<Point>) -> T) -> T {
        let position = lock(&self.lifecycle).desktop_position;
        apply(position)
    }

    fn stamp_status(&self, mut payload: Value) -> Value {
        let mut status = lock(&self.runtime_status);
        if status.1.as_ref() != Some(&payload) { status.0 += 1; status.1 = Some(payload.clone()); }
        payload["runtimeRevision"] = json!(status.0);
        payload
    }

    fn configure(&self, patch: &Value, restore: bool) -> (LyricsConfig, LyricsSnapshot, bool) {
        let mut state = lock(&self.config);
        let current = state.config.clone();
        if restore && state.revision != 0 { return (current, state.clone(), false); }
        let next = current.apply_patch(patch);
        let changed = next != current || restore;
        if changed { state.config = next; state.revision += 1; }
        (current, state.clone(), changed)
    }

    pub fn document(&self) -> Option<Value> { lock(&self.document).clone() }
    fn store_document(&self, document: Value) { *lock(&self.document) = Some(document); }
}

pub fn current_status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let state = app.state::<LyricsWindowState>(); let snapshot = state.snapshot();
    let mut payload = status_payload(&snapshot.config, is_open(app), snapshot.revision);
    payload["requestedVisible"] = json!(lock(&state.lifecycle).requested);
    #[cfg(windows)] { payload["taskbar"] = app.state::<crate::taskbar_lyrics::Host>().payload(); }
    #[cfg(not(windows))] { payload["taskbar"] = crate::taskbar_lyrics::Reason::Unsupported.payload(false); }
    state.stamp_status(payload)
}

pub fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let owner = app.clone();
    let _ = app.run_on_main_thread(move || { emit_core_event(&owner, LYRICS_STATE, current_status(&owner)); });
}

async fn read_status<R: Runtime>(app: &AppHandle<R>) -> Result<Value, CoreError> {
    let (tx, rx) = tauri::async_runtime::channel(1); let owner = app.clone();
    app.run_on_main_thread(move || { let _ = tx.try_send(current_status(&owner)); }).map_err(|e| CoreError::new("internal", e.to_string()))?;
    let mut rx = rx;
    rx.recv().await.ok_or_else(|| CoreError::new("internal", "歌词运行状态回读失败"))
}

async fn rebuild_window<R: Runtime>(app: &AppHandle<R>, save_desktop: bool) -> Result<(), CoreError> {
    let state = app.state::<LyricsWindowState>();
    if lock(&state.lifecycle).shutting_down { return Err(CoreError::new("shutting_down", "应用正在退出")); }
    if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
        if save_desktop { lock(&state.lifecycle).desktop_position = window.outer_position().ok().map(|p| Point { x: p.x.into(), y: p.y.into() }); }
        let (sender, receiver) = std::sync::mpsc::channel();
        let expected_generation = lock(&state.lifecycle).live_generation;
        let owner = app.clone();
        app.run_on_main_thread(move || {
            let state = owner.state::<LyricsWindowState>();
            let generation = lock(&state.lifecycle).live_generation;
            if generation != expected_generation { let _ = sender.send(generation.is_none()); return; }
            let Some(generation) = generation else { let _ = sender.send(true); return; };
            // Register the receipt before asking the runtime to destroy the window.
            lock(&state.lifecycle).destroy_waiter = Some((generation, sender));
            #[cfg(windows)] let result = owner.state::<crate::taskbar_lyrics::Host>().detach(&window, generation).map_err(|_| ());
            #[cfg(not(windows))] let result = window.destroy().map_err(|_| ());
            if result.is_err() {
                if let Some((_, sender)) = lock(&state.lifecycle).destroy_waiter.take() { let _ = sender.send(false); }
            }
        }).map_err(|e| CoreError::new("internal", e.to_string()))?;
        let destroyed = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(std::time::Duration::from_millis(2100)).unwrap_or(false)).await.unwrap_or(false);
        if !destroyed { return Err(CoreError::new("destroy_failed", "歌词窗清理未完成，已停显；请关闭歌词后重试")); }
    }
    let requested = lock(&state.lifecycle).requested;
    if requested {
        let config = state.config();
        apply_toggle(app, &config, true)?;
        if config.mode == LyricsMode::Desktop {
            state.with_desktop_position(|position| -> Result<(), CoreError> {
                if let (Some(position), Some(window)) = (position, app.get_webview_window(LYRICS_WINDOW_LABEL)) {
                    let (size, point) = geometry_plan(work_area(app, false)?, &config, window.scale_factor().unwrap_or(1.0), Some(position));
                    window.set_size(PhysicalSize::new(size.width.round() as u32, size.height.round() as u32)).and_then(|_| window.set_position(PhysicalPosition::new(point.x.round() as i32, point.y.round() as i32))).map_err(|e| CoreError::new("internal", e.to_string()))?;
                }
                Ok(())
            })?;
        }
    }
    Ok(())
}

pub fn schedule_rebuild<R: Runtime>(app: &AppHandle<R>) {
    let generation = lock(&app.state::<LyricsWindowState>().lifecycle).live_generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<LyricsWindowState>(); let _operation = state.operations.lock().await;
        if lock(&state.lifecycle).live_generation != generation || state.config().mode != LyricsMode::Taskbar { return; }
        if let Err(error) = rebuild_window(&app, false).await { log::warn!("任务栏歌词重建失败：{}", error.message); }
        emit_status(&app);
    });
}

pub fn begin_shutdown<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LyricsWindowState>();
    let mut lifecycle = lock(&state.lifecycle); lifecycle.shutting_down = true; lifecycle.requested = false;
    #[cfg(windows)] {
        let host = app.state::<crate::taskbar_lyrics::Host>(); host.shutdown();
        let generation = lifecycle.live_generation;
        lock(&host.barrier).begin(host.now(), generation);
        drop(lifecycle);
        if let (Some(generation), Some(window)) = (generation, app.get_webview_window(LYRICS_WINDOW_LABEL)) {
            if host.detach(&window, generation).is_err() { lock(&host.barrier).failed(generation); }
        }
    }
    #[cfg(not(windows))] { drop(lifecycle); if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) { let _ = window.destroy(); } }
}

pub fn shutdown_finished<R: Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(windows)] { let host = app.state::<crate::taskbar_lyrics::Host>(); let finished = lock(&host.barrier).finished(host.now()); finished }
    #[cfg(not(windows))] { let _ = app; true }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn ready_generation(source: &str, document_generation: Option<u64>, live_generation: Option<u64>, empty_read: bool) -> Option<u64> {
    if source == LYRICS_WINDOW_LABEL && empty_read && document_generation == live_generation { document_generation } else { None }
}

pub fn require_lyrics_source(label: &str) -> Result<(), CoreError> {
    if [MAIN_WINDOW_LABEL, LYRICS_WINDOW_LABEL].contains(&label) { return Ok(()); }
    Err(CoreError::new("forbidden_source", "歌词配置与媒体控制仅接受主窗或歌词窗调用"))
}

pub fn validate_configure(label: &str, patch: &Value, restore: Option<bool>) -> Result<(), CoreError> {
    require_lyrics_source(label)?;
    if label != MAIN_WINDOW_LABEL && restore.is_some() {
        return Err(CoreError::new("forbidden_source", "仅主窗可以恢复歌词配置"));
    }
    let Some(object) = patch.as_object() else { return Err(CoreError::new("invalid_payload", "歌词配置必须是对象")); };
    for (key, value) in object {
        let valid = match key.as_str() {
            "mode" => value.as_str().and_then(LyricsMode::parse).is_some(),
            "layout" => value.as_str().is_some_and(|v| LYRICS_LAYOUTS.contains(&v)),
            "style" => value.as_str().is_some_and(|v| LYRICS_STYLES.contains(&v)),
            "color" => value.as_str().is_some_and(|v| LYRICS_COLOR_TOKENS.contains(&v)),
            "size" => value.as_str().is_some_and(|v| LYRICS_FONT_STEPS.iter().any(|(id, _)| *id == v)),
            "locked" | "clickThrough" | "enableBlur" | "enableScale" | "enableSpring" | "showControls" => value.is_boolean(),
            _ => false,
        };
        if !valid { return Err(CoreError::new("invalid_payload", "歌词配置含未知字段或非法值")); }
    }
    Ok(())
}

pub fn control_payload(label: &str, payload: &Value) -> Result<Value, CoreError> {
    require_lyrics_source(label)?;
    if let Some(object) = payload.as_object() {
        if object.len() == 1 {
            if let Some(action) = object.get("action").and_then(Value::as_str).filter(|v| LYRICS_CONTROL_ACTIONS.contains(v)) {
                return Ok(json!({"command": action}));
            }
        }
    }
    Err(CoreError::new("invalid_payload", "歌词媒体控制仅接受 {action: toggle|previous|next}"))
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

fn work_area<R: Runtime>(app: &AppHandle<R>, preserve_position: bool) -> Result<Rect, CoreError> {
    let current = preserve_position.then(|| app.get_webview_window(LYRICS_WINDOW_LABEL)
        .and_then(|window| window.current_monitor().ok().flatten())).flatten();
    let monitor = current.or_else(|| app.get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|main| main.current_monitor().ok().flatten()))
        .or_else(|| app.primary_monitor().ok().flatten())
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
    let generation = {
        let state = app.state::<LyricsWindowState>(); let mut lifecycle = lock(&state.lifecycle);
        if lifecycle.shutting_down { return Err(CoreError::new("shutting_down", "应用正在退出")); }
        lifecycle.generation += 1; lifecycle.live_generation = Some(lifecycle.generation); lifecycle.generation
    };
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
        WebviewUrl::App(format!("{}&generation={generation}", lyrics_window_url(config, crate::theme::current_theme(app))).into()),
    )
    .title(LYRICS_WINDOW_TITLE)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(desktop_topmost(config))
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .data_directory(lyrics_data);

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }

    let window = builder
        // 页面（重新）加载完成 → 把最后一份歌词文档重发一次（R41a）。
        //
        // 为什么挂在这里：`apply_toggle` 每次显示已有窗口都会 `reload()`，而主窗的重推
        // 与新页面的 `listen()` 是两条不同步的异步链——重推总是落在订阅之前（即转即弃），
        // 用户会看到占位文案直到换歌。加载完成是**唯一**能确定"新页面已经在跑"的时刻。
        //
        // 只认 `Finished`：`Started` 时页面里的 JS 还没执行，重发等于发进空气。
        // 按 label 过滤：这个回调跟着这个窗的 webview 走，判一次 label 是兜底
        // （"这条广播只发给歌词窗"这件事由它自证，而不是靠"只有一个窗"这种当下的巧合）。
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished || webview.label() != LYRICS_WINDOW_LABEL {
                return;
            }
            if let Some(state) = webview.app_handle().try_state::<LyricsWindowState>() {
                if lock(&state.lifecycle).live_generation != Some(generation) { return; }
            }
            replay_document(webview.app_handle());
        })
        .build()
        .map_err(|source| {
            let state = app.state::<LyricsWindowState>(); let mut lifecycle = lock(&state.lifecycle);
            if lifecycle.live_generation == Some(generation) { lifecycle.live_generation = None; }
            CoreError::new("internal", format!("歌词窗建不起来：{source}"))
        })?;
    let events = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) { return; }
        let mut recover = false;
        if let Some(state) = events.try_state::<LyricsWindowState>() {
            let mut lifecycle = lock(&state.lifecycle);
            if lifecycle.live_generation == Some(generation) { lifecycle.live_generation = None; }
            if lifecycle.destroy_waiter.as_ref().is_some_and(|(g, _)| *g == generation) {
                if let Some((_, waiter)) = lifecycle.destroy_waiter.take() { let _ = waiter.send(true); }
            } else { recover = lifecycle.requested && !lifecycle.shutting_down; }
        }
        #[cfg(windows)]
        events.state::<crate::taskbar_lyrics::Host>().destroyed(generation);
        if recover { schedule_rebuild(&events); }
    });
    #[cfg(windows)] {
        let owner_app = app.clone(); let owned = window.clone(); let enabled = config.mode == LyricsMode::Taskbar;
        app.run_on_main_thread(move || {
            let state = owner_app.state::<LyricsWindowState>();
            if lock(&state.lifecycle).live_generation != Some(generation) { return; }
            let requested = lock(&state.lifecycle).requested;
            let monitor = crate::taskbar_lyrics::monitor_for(&owner_app);
            let host = owner_app.state::<crate::taskbar_lyrics::Host>();
            if let Err(reason) = host.register(&owned, generation, enabled, requested, monitor) { host.failed(reason); }
            emit_status(&owner_app);
        }).map_err(|error| CoreError::new("internal", error.to_string()))?;
    }
    Ok(window)
}

#[derive(Debug, PartialEq)]
pub enum WindowEffect {
    Geometry(Size, Point),
    ClickThrough(bool),
}

pub fn geometry_plan(area: Rect, config: &LyricsConfig, scale: f64, current: Option<Point>) -> (Size, Point) {
    let wanted = if config.mode == LyricsMode::Taskbar { TASKBAR_SIZE }
        else if config.layout == "vertical" { Size { width: 320.0, height: 620.0 } }
        else { DESKTOP_SIZE };
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let size = Size { width: (wanted.width * scale).min(area.width).max(1.0), height: (wanted.height * scale).min(area.height).max(1.0) };
    let point = if config.mode == LyricsMode::Desktop { current.unwrap_or_else(|| desktop_position(area, size)) }
        else { taskbar_position(area, size) };
    (size, Point { x: point.x.clamp(area.x, area.x + (area.width - size.width).max(0.0)),
        y: point.y.clamp(area.y, area.y + (area.height - size.height).max(0.0)) })
}

pub fn apply_window_effects(previous: Option<&LyricsConfig>, config: &LyricsConfig, area: Rect, scale: f64, current: Option<Point>, mut apply: impl FnMut(WindowEffect)) {
    if config.mode == LyricsMode::Taskbar { return; }
    if previous.is_none_or(|old| old.mode != config.mode || old.layout != config.layout) {
        let (size, point) = geometry_plan(area, config, scale, current);
        apply(WindowEffect::Geometry(size, point));
    }
    if previous.is_none_or(|old| click_through_enabled(old) != click_through_enabled(config)) {
        apply(WindowEffect::ClickThrough(click_through_enabled(config)));
    }
}

fn apply_config<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, previous: Option<&LyricsConfig>, config: &LyricsConfig) -> Result<(), CoreError> {
    if config.mode == LyricsMode::Taskbar { return Ok(()); }
    let geometry = previous.is_none_or(|old| old.mode != config.mode || old.layout != config.layout);
    let area = if geometry { work_area(app, previous.is_some() && config.mode == LyricsMode::Desktop)? } else { Rect { x:0.0, y:0.0, width:1.0, height:1.0 } };
    let current = window.outer_position().ok().map(|p| Point {x: p.x.into(), y: p.y.into()});
    let mut result = Ok(());
    apply_window_effects(previous, config, area, window.scale_factor().unwrap_or(1.0), if previous.is_some() { current } else { None }, |effect| {
        let applied = match effect {
            WindowEffect::Geometry(size, point) => window.set_size(PhysicalSize::new(size.width.round() as u32, size.height.round() as u32))
                .and_then(|_| window.set_position(PhysicalPosition::new(point.x.round() as i32, point.y.round() as i32))),
            WindowEffect::ClickThrough(through) => window.set_ignore_cursor_events(through),
        };
        if let Err(source) = applied { result = Err(CoreError::new("internal", format!("歌词窗属性更新失败：{source}"))); }
    });
    result
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
/// 普通 desktop 开关仍隐藏不销毁；跨 mode/parent/monitor 重建与退出另走受控销毁。
/// taskbar 的 show/hide、几何、点透全交原生宿主，不混用 tao 样式缓存。
fn apply_toggle<R: Runtime>(
    app: &AppHandle<R>,
    config: &LyricsConfig,
    checked: bool,
) -> Result<bool, CoreError> {
    let state = app.state::<LyricsWindowState>();
    if lock(&state.lifecycle).shutting_down { return Err(CoreError::new("shutting_down", "应用正在退出")); }
    lock(&state.lifecycle).requested = checked;
    if config.mode == LyricsMode::Taskbar {
        if checked && app.get_webview_window(LYRICS_WINDOW_LABEL).is_none() { build_lyrics_window(app, config)?; }
        #[cfg(windows)] {
            let owner = app.clone();
            let generation = lock(&state.lifecycle).live_generation;
            app.run_on_main_thread(move || {
                let state = owner.state::<LyricsWindowState>();
                let lifecycle = lock(&state.lifecycle);
                if lifecycle.live_generation != generation || lifecycle.shutting_down || state.config().mode != LyricsMode::Taskbar { return; }
                let requested = lifecycle.requested; drop(lifecycle);
                owner.state::<crate::taskbar_lyrics::Host>().request(true, requested, crate::taskbar_lyrics::monitor_for(&owner));
            }).map_err(|error| CoreError::new("internal", error.to_string()))?;
        }
        return Ok(is_open(app));
    }
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
            if let Err(error) = apply_config(app, &window, None, config) {
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
// 命令面（主窗数据转发与 main/lyrics 窄配置/媒体）
// ---------------------------------------------------------------------------

/// 开/关桌面歌词窗。`checked` 是**目标态**（托盘的 `lyrics:toggle` 给的就是它，不做"切换一下"）。
#[tauri::command]
pub async fn core_lyrics_toggle(
    app: AppHandle,
    webview: tauri::Webview,
    checked: bool,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;

    let state = app.state::<LyricsWindowState>();
    let _operation = state.operations.lock().await;
    let snapshot = state.snapshot();
    match apply_toggle(&app, &snapshot.config, checked) {
        Ok(_) => {
            let payload = read_status(&app).await?;
            emit_core_event(&app, LYRICS_STATE, payload.clone());
            Ok(payload)
        }
        Err(error) => {
            lock(&state.lifecycle).requested = is_open(&app);
            let plan = toggle_failure_plan(checked, is_open(&app), &error.message);
            crate::tray::revert_lyrics_checked(&app, plan.tray_checked);
            emit_core_event(&app, APP_NOTICE, json!({ "text": plan.notice }));
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn core_lyrics_configure(
    app: AppHandle,
    webview: tauri::Webview,
    config: Value,
    restore_if_pristine: Option<bool>,
) -> Result<Value, CoreError> {
    validate_configure(webview.label(), &config, restore_if_pristine)?;
    let state = app.state::<LyricsWindowState>();
    let _operation = state.operations.lock().await;
    #[cfg(windows)] {
        let document_generation = webview.url().ok().and_then(|url| url.query_pairs().find(|(key, _)| key == "generation").and_then(|(_, value)| value.parse().ok()));
        let generation = ready_generation(webview.label(), document_generation, lock(&state.lifecycle).live_generation, config.as_object().is_some_and(|map| map.is_empty()));
        if let Some(generation) = generation { app.state::<crate::taskbar_lyrics::Host>().ready(generation); }
    }
    let (previous, snapshot, changed) = state.configure(&config, restore_if_pristine == Some(true));
    if changed {
        if previous.mode != snapshot.config.mode {
            if let Err(error) = rebuild_window(&app, previous.mode == LyricsMode::Desktop).await {
                // 切出 Beta 失败（restore/销毁任一环节）时旧 taskbar 宿主必须失败关闭：
                // 只 invalidate 一次查询不够，旧 policy 可能凭旧 enabled/requested 再次探测并重新显示。
                #[cfg(windows)] {
                    let host = app.state::<crate::taskbar_lyrics::Host>();
                    if previous.mode == LyricsMode::Taskbar { host.revoke(crate::taskbar_lyrics::Reason::DestroyFailed); }
                    else { host.failed(crate::taskbar_lyrics::Reason::DestroyFailed); }
                }
                emit_status(&app);
                return Err(error);
            }
        } else if let Some(window) = app.get_webview_window(LYRICS_WINDOW_LABEL) {
            if let Err(error) = apply_config(&app, &window, Some(&previous), &snapshot.config) {
                log::warn!("歌词窗配置已更新，但窗口属性未完全应用（{error}）");
            }
        }
    }
    let payload = read_status(&app).await?;
    if changed { emit_core_event(&app, LYRICS_STATE, payload.clone()); }
    Ok(payload)
}

#[tauri::command]
pub async fn core_lyrics_control(app: AppHandle, webview: tauri::Webview, payload: Value) -> Result<Value, CoreError> {
    let command = control_payload(webview.label(), &payload)?;
    emit_core_event(&app, crate::bridge::PLAYER_COMMAND, command);
    Ok(Value::Null)
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

    #[test]
    fn d5_runtime_status_sequence_changes_without_config_revision_or_persistence() {
        let state = LyricsWindowState::default();
        let waiting = state.stamp_status(json!({"config":{},"revision":2,"visible":false}));
        let attached = state.stamp_status(json!({"config":{},"revision":2,"visible":true}));
        assert!(attached["runtimeRevision"].as_u64().unwrap() > waiting["runtimeRevision"].as_u64().unwrap());
        assert_eq!(state.stamp_status(json!({"config":{},"revision":2,"visible":true})), attached);
        assert_eq!(state.snapshot().revision, 0);
    }

    #[test]
    fn d4_desktop_restore_drops_lifecycle_lock_before_synchronous_ui() {
        let state = LyricsWindowState::default();
        lock(&state.lifecycle).desktop_position = Some(Point { x: 12.0, y: -24.0 });
        let position = state.with_desktop_position(|point| {
            let mut lifecycle = state.lifecycle.try_lock().expect("UI callback must acquire lifecycle without deadlocking");
            lifecycle.requested = true;
            point
        });
        assert_eq!(position, Some(Point { x: 12.0, y: -24.0 }));
        assert!(lock(&state.lifecycle).requested);
    }

    #[test]
    fn r44c_pristine_restore_and_atomic_revision_reject_stale_disk() {
        let state = LyricsWindowState::default();
        let (_, restored, changed) = state.configure(&json!({"layout":"vertical", "style":"panel"}), true);
        assert!(changed);
        assert_eq!(restored.revision, 1);
        assert_eq!(restored.config.payload()["layout"], "vertical");
        let (_, next, _) = state.configure(&json!({"locked":true}), false);
        assert_eq!(next.revision, 2);
        let (_, reread, changed) = state.configure(&json!({"layout":"horizontal"}), true);
        assert!(!changed);
        assert_eq!(reread.revision, 2);
        assert_eq!(reread.config.payload()["layout"], "vertical");
        assert_eq!(state.configure(&json!({}), false).1.revision, 2);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..20).map(|i| { let state = &state; scope.spawn(move || {
                let (_, snapshot, changed) = state.configure(&json!({"size": if i % 2 == 0 {"sm"} else {"xl"}}), false);
                changed.then_some(snapshot.revision)
            }) }).collect();
            let mut revisions: Vec<_> = handles.into_iter().filter_map(|handle| handle.join().unwrap()).collect();
            revisions.sort_unstable();
            assert_eq!(revisions, (3..3 + revisions.len() as u64).collect::<Vec<_>>());
        });
        let snap = state.snapshot();
        assert!(snap.revision >= 3);
        assert_eq!(status_payload(&snap.config, true, snap.revision)["revision"], snap.revision);
    }

    #[test]
    fn r44c_sources_and_strict_narrow_payloads_never_open_core_or_login() {
        for source in ["main", "lyrics"] {
            assert!(require_lyrics_source(source).is_ok());
            for action in ["toggle", "previous", "next"] {
                assert_eq!(control_payload(source, &json!({"action": action})).unwrap(), json!({"command":action}));
            }
            for bad in [json!({"action":"play"}), json!({"action":"next","url":"bad"}), json!("next"), json!({})] {
                assert!(control_payload(source, &bad).is_err());
            }
            assert!(validate_configure(source, &json!({"locked":true}), None).is_ok());
            assert!(validate_configure(source, &json!({"document":[]}), None).is_err());
            assert!(validate_configure(source, &json!({"enableBlur":"yes"}), None).is_err());
        }
        for source in ["login", "login-theme", "login-return", "tray", ""] {
            assert!(control_payload(source, &json!({"action":"next"})).is_err());
            assert!(validate_configure(source, &json!({}), None).is_err());
        }
        assert!(validate_configure("lyrics", &json!({}), Some(false)).is_err());
        assert!(validate_configure("main", &json!({}), Some(true)).is_ok());
        assert!(require_main_webview("lyrics").is_err());
        assert!(crate::commands::require_login_chrome_source("lyrics").is_err());
    }

    #[test]
    fn r44c_visual_changes_never_emit_geometry_but_layout_is_scaled_and_clamped() {
        let current = LyricsConfig::default();
        let area = Rect { x: -1920.0, y: -200.0, width: 1920.0, height: 1040.0 };
        let mut effects = Vec::new();
        let visual = current.apply_patch(&json!({"locked":true,"color":"primary","clickThrough":true,"style":"panel","enableBlur":false,"enableScale":false,"enableSpring":false}));
        apply_window_effects(Some(&current), &visual, area, 1.25, Some(Point {x:-800.0,y:150.0}), |effect| effects.push(effect));
        assert_eq!(effects, vec![WindowEffect::ClickThrough(true)]);
        effects.clear();
        let vertical = visual.apply_patch(&json!({"layout":"vertical"}));
        apply_window_effects(Some(&visual), &vertical, area, 1.25, Some(Point {x:-200.0,y:700.0}), |effect| effects.push(effect));
        assert_eq!(effects[0], WindowEffect::Geometry(Size {width:400.0,height:775.0}, Point {x:-400.0,y:65.0}));
        let taskbar = vertical.apply_patch(&json!({"mode":"taskbar"}));
        let (size, _) = geometry_plan(area, &taskbar, 1.0, None);
        assert_eq!(size, TASKBAR_SIZE);
        for area in [Rect{x:-1280.0,y:-100.0,width:1280.0,height:760.0}, Rect{x:1920.0,y:0.0,width:200.0,height:200.0}] {
            for layout in ["horizontal", "vertical"] {
                for scale in [1.0, 1.5, 2.0] {
                    let config = current.apply_patch(&json!({"layout": layout}));
                    let (size, point) = geometry_plan(area, &config, scale, Some(Point{x:area.x+area.width-1.0,y:area.y-50.0}));
                    assert!(point.x >= area.x && point.y >= area.y);
                    assert!(point.x + size.width <= area.x + area.width);
                    assert!(point.y + size.height <= area.y + area.height);
                }
            }
        }
    }

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
            ..LyricsConfig::default()
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
            ..LyricsConfig::default()
        };
        let url = lyrics_window_url(&config, crate::theme::ThemeChoice::Dark);
        assert!(url.starts_with("lyrics.html?"), "加载的是 R1 建好的那个入口：{url}");
        assert!(url.contains("mode=taskbar"), "{url}");
        assert!(url.contains("size=xxl"), "查询串保留用户档位，渲染时再限有效字号：{url}");
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
        state.configure(&json!({"mode": "taskbar"}), false);
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
        let payload = status_payload(&LyricsConfig::default(), true, 7);
        assert_eq!(payload["visible"], json!(true));
        assert_eq!(payload["revision"], 7);
        assert_eq!(payload["config"]["style"], "clean");
        assert_eq!(payload["config"]["layout"], "horizontal");
        assert_eq!(payload["config"]["enableBlur"], true);
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
            ".always_on_top(desktop_topmost(config))",
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
        let toggle = production.split("fn apply_toggle").nth(1).unwrap().split("pub struct ToggleFailurePlan").next().unwrap();
        assert!(!toggle.contains(".destroy("), "普通开关保留页面；换模式/退出才销毁");
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

    #[test]
    fn every_command_is_async_with_its_narrow_guard() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs")).unwrap();
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        for (name, guard) in [
            ("core_lyrics_toggle", "require_main_webview("),
            ("core_lyrics_document", "require_main_webview("),
            ("core_lyrics_progress", "require_main_webview("),
            ("core_lyrics_configure", "validate_configure("),
            ("core_lyrics_control", "control_payload("),
        ] {
            let body = &production[production.find(&format!("pub async fn {name}(")).unwrap()..];
            assert!(body.find(guard).unwrap() < 900);
        }
        assert_eq!(production.matches("#[tauri::command]").count(), 5);
    }
}
