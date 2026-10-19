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
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::bridge::{CoreError, LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE, APP_NOTICE};
use crate::commands::{emit_core_event, require_main_window};
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

/// 歌词窗的**会话内**配置（唯一真源；持久化不做，见模块头）。
///
/// 登记成托管状态（`lib.rs` 的 setup）：主窗的设置页读它、四条命令改它。
/// 直接用 `Mutex` 而不是 `RwLock`：读也只是一次 clone，省一种锁的心智负担。
#[derive(Default)]
pub struct LyricsWindowState {
    config: Mutex<LyricsConfig>,
}

impl LyricsWindowState {
    pub fn config(&self) -> LyricsConfig {
        lock(&self.config).clone()
    }

    fn store(&self, config: LyricsConfig) {
        *lock(&self.config) = config;
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
// 窗口
// ---------------------------------------------------------------------------

/// 歌词窗的 webview 数据目录：`<数据根>/webview2/lyrics`（与登录窗 `webview2/login/<partition>` 同款）。
///
/// 独占目录而不是与主窗共用：WebView2 的数据目录同时被两个进程内 webview 打开会互相踩
/// （缓存/Cookie 库的锁）。
pub fn lyrics_data_dir(data_root: &Path) -> PathBuf {
    data_root.join("webview2").join("lyrics")
}

/// 建窗加载的地址：`lyrics.html?<配置>`（配置经查询串同步到位，见 [`LyricsConfig::query`]）。
pub fn lyrics_window_url(config: &LyricsConfig) -> String {
    format!("lyrics.html?{}", config.query())
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
        WebviewUrl::App(lyrics_window_url(config).into()),
    )
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

/// 开关落地：开 = 建（没有就建）/摆好/显示；关 = **隐藏**（不销毁，webview 与进度都留着）。
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
        Some(window) => window,
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
    window: tauri::Window,
    checked: bool,
) -> Result<Value, CoreError> {
    require_main_window(window.label())?;

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
    window: tauri::Window,
    config: Option<Value>,
) -> Result<Value, CoreError> {
    require_main_window(window.label())?;

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
#[tauri::command]
pub async fn core_lyrics_document(
    app: AppHandle,
    window: tauri::Window,
    document: Value,
) -> Result<Value, CoreError> {
    require_main_window(window.label())?;

    let Some(object) = document.as_object() else {
        return Err(CoreError::new(
            "invalid_payload",
            "歌词文档必须是对象（{lines, status}）",
        ));
    };
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

    emit_core_event(&app, LYRICS_DOCUMENT, json!({ "lines": lines, "status": status }));
    Ok(Value::Null)
}

/// 推进度（主窗的 rAF 已经按 ≥100ms / 播放或跳转变化节流过）。
#[tauri::command]
pub async fn core_lyrics_progress(
    app: AppHandle,
    window: tauri::Window,
    progress: Value,
) -> Result<Value, CoreError> {
    require_main_window(window.label())?;

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
    fn window_url_carries_the_effective_config_and_the_renderer_reads_the_same_keys() {
        let config = LyricsConfig {
            mode: LyricsMode::Taskbar,
            size: "xxl".to_string(),
            color: "contrast".to_string(),
            locked: true,
            click_through: false,
        };
        let url = lyrics_window_url(&config);
        assert!(url.starts_with("lyrics.html?"), "加载的是 R1 建好的那个入口：{url}");
        assert!(url.contains("mode=taskbar"), "{url}");
        assert!(url.contains("size=md"), "查询串里带的是**生效**档位（任务栏 ≤20px）：{url}");
        assert!(url.contains("color=contrast"), "{url}");
        assert!(url.contains("locked=1"), "布尔写成 0/1（渲染层只认这两个值）：{url}");
        assert!(url.contains("clickThrough=0"), "{url}");
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
                .find("require_main_window(")
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
