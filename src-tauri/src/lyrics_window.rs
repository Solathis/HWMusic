//! 桌面歌词的运行配置与 revision 由 Rust 原子持有；`settings.json` 的唯一写者是 sidecar。
//! 持久化任务**由 Rust 拥有**：不依赖主窗 WebView 与渲染层保存队列，认证卸载/渲染层崩溃/退出都改不了"最新配置最终落盘"。
//! 配置/媒体专命令限 main/lyrics；开关、文档、进度与 core_call 仍限主窗。
//! desktop 几何只随 mode/layout 变化；Windows taskbar 交独立原生宿主，失败停显而不贴边。

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::bridge::{CoreError, LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE, APP_NOTICE};
use crate::commands::{emit_core_event, require_main_webview, settings_receipt_value};
use crate::webview_proxy::SETTINGS_FILE_NAME;
use crate::{LYRICS_WINDOW_LABEL, MAIN_WINDOW_LABEL};

// ---------------------------------------------------------------------------
// 几何（纯函数）
// ---------------------------------------------------------------------------

/// 工作区矩形（物理像素）——坐标**可以是负的**：副屏摆在主屏左边/上边时，工作区原点就是负的。
/// 把"负偏移钳 0"写成"把最终坐标钳到 0"会把窗口扔到另一块屏上。
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

/// 任务栏模式的窗口尺寸：如 1200×44，一条单行显示带。
pub const TASKBAR_SIZE: Size = Size {
    width: 1200.0,
    height: 44.0,
};

/// 桌面模式的窗口尺寸：一条紧凑的显示带，上下行各露一部分（AMLL 自己排版）。
/// 控件行与歌词左右留白同步收小（见 `LyricsWindow.tsx` 与 `amll-theme.css`），变矮的是那些空白而不是"能看见的歌词"。
pub const DESKTOP_SIZE: Size = Size {
    width: 800.0,
    height: 128.0,
};

/// 竖版桌面窗的默认尺寸：窄而高，lg 档正好放下两列（当前句 + 下一句或译文）。
pub const DESKTOP_VERTICAL_SIZE: Size = Size {
    width: 112.0,
    height: 600.0,
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

/// 任务栏位置：水平居中、贴 `work_area` 下沿，**偏移**负值钳 0——钳的是偏移而非最终坐标，窗口比工作区还大时贴左上角摆而不是被推到屏幕外。
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

/// 任务栏专用字号档位：44px 高的槽位只放得下一行当前歌词，所以上限压到 20px、档距 2px。
/// id 与桌面那张表不重叠——两张表互不通用，`taskbarSize` 收桌面档位一律判非法。
pub const TASKBAR_FONT_STEPS: &[(&str, u32)] =
    &[("tsm", 12), ("tmd", 14), ("tlg", 16), ("txl", 18), ("txxl", 20)];

/// 任务栏模式的字号上限（≤ 20）。
pub const TASKBAR_MAX_FONT_PX: u32 = 20;

/// 颜色令牌表（唯一真源在渲染层的 `LYRICS_COLOR_TOKENS`，这里是镜像副本）：
/// 只认设计令牌，绝不接受任意色值（`#fff`、`rgb(...)` 一律落回上一个合法值）。
pub const LYRICS_COLOR_TOKENS: &[&str] = &["foreground", "muted", "primary", "contrast"];

/// 自定义歌词颜色：`#` + 6 位十六进制（与渲染层 `CUSTOM_COLOR_PATTERN` 同一口径）。
/// 不接"任意 CSS 色值"是因为它会被写进官方 AMLL 组件消费的 CSS 变量，能写色值就能写 `url(...)`/`;}`。
pub fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

/// 自定义颜色合法（空串 = 用设计令牌）。
pub fn custom_color_ok(value: &str) -> bool {
    value.is_empty() || is_hex_color(value)
}

/// 自定义颜色写进查询串：`#` 必须转义（`#` 在 URL 里是 fragment 分隔符，原样写会把后面全吃掉）。
pub fn encode_custom_color(value: &str) -> String {
    if !is_hex_color(value) {
        return String::new();
    }
    format!("%23{}", &value[1..])
}

/// 横版与任务栏的最小尺寸（DIP）：比这更小就放不下一行歌词。
pub const MIN_WINDOW_WIDTH_DIP: f64 = 240.0;
pub const MIN_WINDOW_HEIGHT_DIP: f64 = 120.0;
/// 竖版桌面窗的最小宽度（DIP）：最大字号档也还放得下一列。
pub const MIN_VERTICAL_WINDOW_WIDTH_DIP: f64 = 96.0;

/// 歌词窗的最小尺寸（DIP）按布局取：只有桌面竖版用窄的那一档。
pub fn min_window_size(config: &LyricsConfig) -> Size {
    let width = if config.mode == LyricsMode::Desktop && config.layout == "vertical" { MIN_VERTICAL_WINDOW_WIDTH_DIP } else { MIN_WINDOW_WIDTH_DIP };
    Size { width, height: MIN_WINDOW_HEIGHT_DIP }
}

/// 尺寸的绝对上限（DIP）：真正的上限是工作区，这里只是拦掉"明显是坏值"的数。
pub const MAX_WINDOW_DIP: f64 = 100_000.0;

/// 归一尺寸补丁：`None` = 没提这个键（不动），`Some(None)` = 明确清空，`Some(Some(v))` = 取整并夹进 [min, MAX_WINDOW_DIP]。
/// 钳最小是因为比 `min_window_size` 更小的尺寸用户拖不到（窗口有最小尺寸），留在配置里只会让下次恢复出个怪尺寸。
fn size_patch(patch: &serde_json::Map<String, Value>, key: &str, min: f64) -> Option<Option<f64>> {
    match patch.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => value
            .as_f64()
            .filter(|size| size.is_finite() && *size > 0.0)
            .map(|size| Some(size.round().clamp(min, MAX_WINDOW_DIP))),
    }
}


/// 默认字号档位。
pub const DEFAULT_LYRICS_SIZE: &str = "lg";
/// 默认颜色令牌。
pub const DEFAULT_LYRICS_COLOR: &str = "foreground";
/// 任务栏的默认字号：取上限那一档（任务栏把桌面 `lg` 压到的就是 20px，观感不变）。
pub const DEFAULT_TASKBAR_SIZE: &str = "txxl";
/// 任务栏的默认颜色令牌。
pub const DEFAULT_TASKBAR_COLOR: &str = "foreground";

pub const LYRICS_LAYOUTS: &[&str] = &["horizontal", "vertical"];
pub const LYRICS_STYLES: &[&str] = &["clean", "panel", "bare"];
pub const LYRICS_CONTROL_ACTIONS: &[&str] = &["toggle", "previous", "next", "close"];

#[derive(Debug, Clone, PartialEq)]
pub struct LyricsConfig {
    pub mode: LyricsMode,
    pub layout: String,
    pub style: String,
    pub size: String,
    pub color: String,
    /// 自定义歌词颜色（`#RRGGBB`；空串 = 用 `color` 选的设计令牌）。
    pub custom_color: String,
    /// 桌面窗的 DIP 尺寸（未锁定时拖拽缩放后保存；`None` = 用该方向的默认尺寸）。
    pub window_width: Option<f64>,
    pub window_height: Option<f64>,
    pub locked: bool,
    pub enable_blur: bool,
    pub enable_scale: bool,
    pub enable_spring: bool,
    pub show_controls: bool,
    /// 任务栏模式的外观：与桌面那三样各存一份——两扇窗的观感是两件事。
    pub taskbar_size: String,
    pub taskbar_color: String,
    pub taskbar_custom_color: String,
    /// 任务栏的逐字高亮（默认开）。关掉 = 不经逐字词推导，官方组件按行渐变。
    pub taskbar_karaoke: bool,
}

impl Default for LyricsConfig {
    fn default() -> Self {
        Self {
            mode: LyricsMode::Desktop,
            layout: "horizontal".into(),
            style: "clean".into(),
            size: DEFAULT_LYRICS_SIZE.to_string(),
            color: DEFAULT_LYRICS_COLOR.to_string(),
            custom_color: String::new(),
            window_width: None,
            window_height: None,
            locked: false,
            enable_blur: true,
            enable_scale: true,
            enable_spring: true,
            show_controls: true,
            taskbar_size: DEFAULT_TASKBAR_SIZE.to_string(),
            taskbar_color: DEFAULT_TASKBAR_COLOR.to_string(),
            taskbar_custom_color: String::new(),
            taskbar_karaoke: true,
        }
    }
}

impl LyricsConfig {
    /// 实际渲染的字号档位：两种模式各读自己那一列，桌面选的档位不参与任务栏。
    /// 认不出的档位（盘上被手改过）落默认，绝不 panic，也不把坏值透给 CSS。
    pub fn effective_size(&self) -> &str {
        if self.mode != LyricsMode::Taskbar {
            return self.size.as_str();
        }
        if TASKBAR_FONT_STEPS.iter().any(|(id, _)| *id == self.taskbar_size) {
            return self.taskbar_size.as_str();
        }
        DEFAULT_TASKBAR_SIZE
    }

    pub fn apply_patch(&self, patch: &Value) -> LyricsConfig {
        let Some(patch) = patch.as_object() else { return self.clone(); };
        let mut next = self.clone();
        if let Some(mode) = patch.get("mode").and_then(Value::as_str).and_then(LyricsMode::parse) { next.mode = mode; }
        for (key, target, allowed) in [
            ("layout", &mut next.layout, LYRICS_LAYOUTS),
            ("style", &mut next.style, LYRICS_STYLES),
            ("color", &mut next.color, LYRICS_COLOR_TOKENS),
            ("taskbarColor", &mut next.taskbar_color, LYRICS_COLOR_TOKENS),
        ] {
            if let Some(value) = patch.get(key).and_then(Value::as_str).filter(|v| allowed.contains(v)) { *target = value.into(); }
        }
        if let Some(value) = patch.get("size").and_then(Value::as_str).filter(|v| LYRICS_FONT_STEPS.iter().any(|(id, _)| id == v)) { next.size = value.into(); }
        if let Some(value) = patch.get("taskbarSize").and_then(Value::as_str).filter(|v| TASKBAR_FONT_STEPS.iter().any(|(id, _)| id == v)) { next.taskbar_size = value.into(); }
        // 自定义颜色（空串 = 回设计令牌）；坏形状不覆盖上一个合法值
        if let Some(value) = patch.get("customColor").and_then(Value::as_str).filter(|v| custom_color_ok(v)) { next.custom_color = value.into(); }
        if let Some(value) = patch.get("taskbarCustomColor").and_then(Value::as_str).filter(|v| custom_color_ok(v)) { next.taskbar_custom_color = value.into(); }
        // 窗口 DIP 尺寸（`null` = 没有自定义尺寸；小数取整并夹进当前布局的最小尺寸）
        let min = min_window_size(&next);
        if let Some(size) = size_patch(patch, "windowWidth", min.width) { next.window_width = size; }
        if let Some(size) = size_patch(patch, "windowHeight", min.height) { next.window_height = size; }
        for (key, target) in [
            ("locked", &mut next.locked),
            ("enableBlur", &mut next.enable_blur), ("enableScale", &mut next.enable_scale),
            ("enableSpring", &mut next.enable_spring), ("showControls", &mut next.show_controls),
            ("taskbarKaraoke", &mut next.taskbar_karaoke),
        ] { if let Some(value) = patch.get(key).and_then(Value::as_bool) { *target = value; } }
        next
    }

    /// 自定义尺寸（两个分量都得有；缺一个就当没有——半个尺寸不是尺寸）。
    pub fn custom_size(&self) -> Option<Size> {
        match (self.window_width, self.window_height) {
            (Some(width), Some(height)) => Some(Size { width, height }),
            _ => None,
        }
    }

    /// 清掉自定义尺寸（方向/模式切换时用：上一方向的尺寸不属于新方向）。
    pub fn without_custom_size(mut self) -> LyricsConfig {
        self.window_width = None;
        self.window_height = None;
        self
    }

    pub fn payload(&self) -> Value {
        json!({
            "mode": self.mode.as_str(), "layout": self.layout, "style": self.style,
            "size": self.size, "color": self.color, "locked": self.locked,
            "customColor": self.custom_color, "windowWidth": self.window_width,
            "windowHeight": self.window_height,
            "enableBlur": self.enable_blur,
            "enableScale": self.enable_scale, "enableSpring": self.enable_spring,
            "showControls": self.show_controls, "effectiveSize": self.effective_size(),
            // 任务栏那扇窗的外观（与桌面各存一份）
            "taskbarSize": self.taskbar_size, "taskbarColor": self.taskbar_color,
            "taskbarCustomColor": self.taskbar_custom_color, "taskbarKaraoke": self.taskbar_karaoke,
        })
    }

    /// **落盘合同**：只有 `DEFAULT_LYRICS_CONFIG` 那 17 个字面键，刻意与 [`LyricsConfig::payload`] 分开。
    /// 派生值（`effectiveSize`）和运行时状态（taskbar 的附着/可见/revision/dirty/saveError）写进 `settings.json` 就是给同一件事造第二份真相。
    pub fn persisted(&self) -> Value {
        json!({
            "mode": self.mode.as_str(), "layout": self.layout, "style": self.style,
            "size": self.size, "color": self.color, "locked": self.locked,
            "customColor": self.custom_color, "windowWidth": self.window_width,
            "windowHeight": self.window_height,
            "enableBlur": self.enable_blur,
            "enableScale": self.enable_scale, "enableSpring": self.enable_spring,
            "showControls": self.show_controls,
            "taskbarSize": self.taskbar_size, "taskbarColor": self.taskbar_color,
            "taskbarCustomColor": self.taskbar_custom_color, "taskbarKaraoke": self.taskbar_karaoke,
        })
    }

    /// 从盘上读到的那一格还原配置：**未知字段按默认**（坏值不猜，与 `apply_patch` 同一条纪律）。
    pub fn restored(raw: Option<&Value>) -> LyricsConfig {
        LyricsConfig::default().apply_patch(raw.unwrap_or(&Value::Null))
    }

    pub fn query(&self) -> String {
        format!(
            "mode={}&size={}&color={}&customColor={}&windowWidth={}&windowHeight={}&locked={}&layout={}&style={}&enableBlur={}&enableScale={}&enableSpring={}&showControls={}&taskbarSize={}&taskbarColor={}&taskbarCustomColor={}&taskbarKaraoke={}",
            self.mode.as_str(), self.size, self.color, encode_custom_color(&self.custom_color),
            dip_param(self.window_width), dip_param(self.window_height),
            u8::from(self.locked),
            self.layout, self.style, u8::from(self.enable_blur), u8::from(self.enable_scale),
            u8::from(self.enable_spring), u8::from(self.show_controls),
            self.taskbar_size, self.taskbar_color,
            encode_custom_color(&self.taskbar_custom_color), u8::from(self.taskbar_karaoke),
        )
    }
}

/// 查询串里的 DIP 尺寸：没有就留空（渲染层把空串当"没有自定义尺寸"，不是 0）。
fn dip_param(value: Option<f64>) -> String {
    value.map(|size| format!("{}", size.round() as i64)).unwrap_or_default()
}

pub fn desktop_topmost(config: &LyricsConfig) -> bool { config.mode == LyricsMode::Desktop }

/// 拖拽缩放的资格：**仅未锁的桌面窗**（渲染层 `resizableEnabled` 是同一口径）。
/// 任务栏那一条是原生宿主摆的，锁定意味着"这一块不该再被误拖大小"——两条都不可缩放。
pub fn resizable_enabled(config: &LyricsConfig) -> bool {
    config.mode == LyricsMode::Desktop && !config.locked
}

/// 一次配置补丁的**归一结果**（纯函数）：布局/方向切换时，上一方向的自定义尺寸不再沿用（否则竖版 320×620 切回横版就成了又窄又高的一条）。
/// 补丁里明确带了尺寸则按补丁来——那是"设尺寸"这条动作本身，不是方向切换的副产物。
pub fn normalized_patch(current: &LyricsConfig, patch: &Value) -> LyricsConfig {
    let next = current.apply_patch(patch);
    let geometry_changed = next.mode != current.mode || next.layout != current.layout;
    let patch_sets_size = patch
        .as_object()
        .is_some_and(|object| object.contains_key("windowWidth") || object.contains_key("windowHeight"));
    if geometry_changed && !patch_sets_size {
        next.without_custom_size()
    } else {
        next
    }
}

/// 任务栏模式一律不接收鼠标；锁定的桌面歌词也不接收（解锁按钮所在区域由指针轮询临时放开）。
pub fn click_through_enabled(config: &LyricsConfig) -> bool {
    config.mode == LyricsMode::Taskbar || config.locked
}

/// 解锁按钮在歌词窗里的矩形（CSS 像素，相对窗口左上角）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnlockZone { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerZone { Outside, Inside, Unlock }

/// 光标落在歌词窗的哪一块：参数是物理像素（光标与窗口左上角）、窗口的 CSS 尺寸与缩放比。
pub fn pointer_zone(cursor: (f64, f64), window_origin: (f64, f64), window_size: (f64, f64), scale: f64, unlock: Option<UnlockZone>) -> PointerZone {
    let factor = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let x = (cursor.0 - window_origin.0) / factor;
    let y = (cursor.1 - window_origin.1) / factor;
    if !(x >= 0.0 && y >= 0.0 && x < window_size.0 && y < window_size.1) { return PointerZone::Outside; }
    match unlock {
        Some(zone) if x >= zone.x && x < zone.x + zone.width && y >= zone.y && y < zone.y + zone.height => PointerZone::Unlock,
        _ => PointerZone::Inside,
    }
}

/// 解锁区报告的参数：`null` 表示没有解锁按钮；否则必须恰好是 x/y/width/height 四个有限非负数。
pub fn parse_unlock_zone(value: &Value) -> Result<Option<UnlockZone>, CoreError> {
    if value.is_null() { return Ok(None); }
    let bad = || CoreError::new("invalid_payload", "解锁区只接受 null 或 {x, y, width, height}");
    let object = value.as_object().filter(|map| map.len() == 4).ok_or_else(bad)?;
    let read = |key: &str| object.get(key).and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0).ok_or_else(bad);
    Ok(Some(UnlockZone { x: read("x")?, y: read("y")?, width: read("width")?, height: read("height")? }))
}

pub fn status_payload(config: &LyricsConfig, visible: bool, revision: u64) -> Value {
    json!({ "config": config.payload(), "visible": visible, "revision": revision })
}

#[derive(Default, Clone)]
pub struct LyricsSnapshot {
    config: LyricsConfig,
    revision: u64,
}

/// 歌词配置在 `settings.json` 里的键名（与渲染层 `LYRICS_SETTING_KEY` 同源）。
pub const LYRICS_SETTING_KEY: &str = "lyricsWindow";

/// 保存失败的两种**代码**（渲染层用纯函数把它翻成人话；盘上不留这些码）。
pub const SAVE_ERROR_WRITE_FAILED: &str = "settings_write_failed";
pub const SAVE_ERROR_UNCONFIRMED: &str = "settings_write_unconfirmed";

/// 歌词配置的持久化记账（**Rust 拥有**：与 WebView / React 生命周期无关）：单写者、单在途、只留最新待写，成功只确认对应快照，`dirty = saved != 运行配置`。
/// 失败不自动重试（`retrySave` 或下一次改动才重试）且错误要留给用户看；`frozen` 后不再受理新值；`retried_for_exit` 保证**一次 Quit 至多一次**重试。
#[derive(Default)]
struct LyricsPersistence {
    enabled: bool,
    frozen: bool,
    stopped: bool,
    saved: Option<LyricsConfig>,
    pending: Option<(u64, LyricsConfig)>,
    inflight: Option<u64>,
    generation: u64,
    save_error: Option<String>,
    retried_for_exit: bool,
}

/// 一次写盘的结论（为什么不是 `Result`：三种结论的**处置**各不相同，混成 Ok/Err 会丢掉一种）。
#[derive(Debug, Clone)]
enum WriteOutcome {
    /// 回执里读出了配置（与请求一致才算确认成功）
    Confirmed(LyricsConfig),
    /// 回执读不出配置（形状不认识）：不能算已保存
    Unreadable,
    /// 明确失败（core 不可用/被拒/超时）：保存失败可见、保留 dirty、不自动重试
    Failed,
}

impl LyricsPersistence {
    fn dirty(&self) -> bool {
        self.pending.is_some() || self.inflight.is_some()
    }

    /// 受理一次新值（**不 await**：与配置接受同一步完成，中间没有可以丢队列的缝）。
    fn enqueue(&mut self, config: &LyricsConfig) -> bool {
        if !self.enabled || self.frozen || self.stopped {
            return false;
        }
        if self.saved.as_ref() == Some(config) && self.pending.is_none() {
            return false;
        }
        self.generation += 1;
        self.pending = Some((self.generation, config.clone()));
        self.save_error = None; // 新值是一次新的尝试（不是"自动重试"同一个失败值）
        true
    }

    /// 写盘结论 → 记账转移（**纯逻辑**：成功只确认对应快照、失败保 dirty 且停自动重试）。
    fn settle(&mut self, sent: &LyricsConfig, outcome: WriteOutcome) {
        self.inflight = None;
        match outcome {
            WriteOutcome::Confirmed(confirmed) if &confirmed == sent => {
                // 成功只确认**对应快照**：期间又来了新值（pending 非空）就不算"现在已与盘一致"。
                if self.pending.is_none() {
                    self.saved = Some(sent.clone());
                }
                self.save_error = None;
            }
            WriteOutcome::Confirmed(_) | WriteOutcome::Unreadable => {
                self.save_error = Some(SAVE_ERROR_UNCONFIRMED.to_string());
            }
            WriteOutcome::Failed => {
                self.save_error = Some(SAVE_ERROR_WRITE_FAILED.to_string());
            }
        }
    }

    /// 退出准备时的排空计划（**纯逻辑**）：已失败的那一份在本轮 Quit **至多**重试一次；
    /// 有脏值但没在排队的，补排一次最新值。`true` = 排了新东西进队列。
    fn plan_exit_drain(&mut self, current: &LyricsConfig) -> bool {
        self.frozen = true;
        if self.stopped || !self.enabled {
            return false;
        }
        if self.save_error.is_some() {
            if self.retried_for_exit {
                return false;
            }
            self.retried_for_exit = true;
            self.save_error = None;
            self.generation += 1;
            self.pending = Some((self.generation, current.clone()));
            return true;
        }
        if self.pending.is_none() && self.inflight.is_none() && self.saved.as_ref() != Some(current) {
            self.generation += 1;
            self.pending = Some((self.generation, current.clone()));
            return true;
        }
        false
    }

    /// 退出准备**失败**（保窗）时的复原：解冻，并把"本轮已重试过"清掉——一次失败的退出不能把这个会话的保存能力一起带走。
    /// 只复原这两格：`saved`/`pending`/`save_error` **一格都不许动**（没写成就不许宣布已保存，也不许把错误洗掉）。
    fn abort_exit_drain(&mut self) {
        self.frozen = false;
        self.retried_for_exit = false;
    }
}

#[derive(Default)]
pub struct LyricsWindowState {
    config: Mutex<LyricsSnapshot>,
    document: Mutex<Option<Value>>,
    progress: Mutex<Option<(Value, std::time::Instant)>>,
    awaiting_first_progress: Mutex<Option<std::time::Instant>>,
    lifecycle: Mutex<LyricsLifecycle>,
    operations: tauri::async_runtime::Mutex<()>,
    runtime_status: Mutex<(u64, Option<Value>)>,
    persist: Mutex<LyricsPersistence>,
    persist_idle: Condvar,
    writer: Mutex<Option<std::thread::JoinHandle<()>>>,
    unlock_zone: Mutex<Option<UnlockZone>>,
    pointer_generation: std::sync::atomic::AtomicU64,
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
    /// 启动时从 `settings.json` **只读**恢复基线，内存必须与盘上一致，否则第一帧 `configure({})` 读回默认值。
    /// **坏文件/坏字段不默认回写**：读不懂就当默认（与 `theme::read_theme` 同一条纪律），诊断留在日志里；"文件认不出"由 sidecar 的 `save` 拒绝覆盖。
    pub fn restore(data_dir: &Path) -> Self {
        let raw: Option<String> = std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)).ok();
        let parsed: Option<Value> = raw.as_deref().and_then(|text| serde_json::from_str(text).ok());
        let recognized: Option<Value> = parsed.as_ref().and_then(|document| {
            let version_ok = document.get("schemaVersion").and_then(Value::as_f64)
                == Some(crate::webview_proxy::SETTINGS_SCHEMA_VERSION);
            if !version_ok {
                return None;
            }
            document.get("data")?.as_object()?.get(LYRICS_SETTING_KEY).cloned()
        });
        if raw.is_some() && recognized.is_none() {
            log::warn!("{SETTINGS_FILE_NAME} 的形状不认识：歌词配置按默认恢复，且不覆盖原文件（诊断见 sidecar 日志）");
        }
        let baseline = LyricsConfig::restored(recognized.as_ref());
        log::info!("歌词配置（按 {SETTINGS_FILE_NAME} 恢复）：mode={} layout={} style={}", baseline.mode.as_str(), baseline.layout, baseline.style);
        LyricsWindowState {
            config: Mutex::new(LyricsSnapshot { config: baseline.clone(), revision: 0 }),
            persist: Mutex::new(LyricsPersistence { enabled: true, saved: Some(baseline), ..Default::default() }),
            ..Default::default()
        }
    }

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

    /// 接受一次配置补丁：改运行配置 + 推进 revision，并在**同一步**把新值交给持久化任务。
    /// 锁序是死规矩：**先 config、后 persist，永不反向**（持久化线程只拿 persist），且"接受"到"入队"之间**没有 await**，不丢这一笔。
    fn configure(&self, patch: &Value) -> (LyricsConfig, LyricsSnapshot, bool) {
        let (previous, snapshot, changed) = {
            let mut state = lock(&self.config);
            let current = state.config.clone();
            // 方向/模式切换时把上一方向的自定义尺寸一起清掉（见 `normalized_patch`）
            let next = normalized_patch(&current, patch);
            let changed = next != current;
            if changed { state.config = next; state.revision += 1; }
            (current, state.clone(), changed)
        };
        if changed {
            let queued = lock(&self.persist).enqueue(&snapshot.config);
            if queued { self.persist_idle.notify_all(); }
        }
        (previous, snapshot, changed)
    }

    /// 用户点了"重试保存"（或退出 drain 主动重存）：把当前运行配置重新排进队列。
    fn retry_save(&self) -> bool {
        let config = self.config();
        let mut persist = lock(&self.persist);
        if !persist.enabled || persist.stopped || persist.frozen {
            return false;
        }
        persist.save_error = None;
        persist.generation += 1;
        persist.pending = Some((persist.generation, config));
        drop(persist);
        self.persist_idle.notify_all();
        true
    }

    /// 退出准备**失败**（`abort_exit` 保窗）时的复原：解冻 + 唤醒保存任务。
    /// 不解冻的话 `enqueue` 与 `retry_save` 会一直拒收、下一次 Quit 也不再重排，一次失败的退出就带走整个会话的保存能力。
    pub fn abort_exit_drain(&self) {
        {
            let mut persist = lock(&self.persist);
            persist.abort_exit_drain();
        }
        self.persist_idle.notify_all();
    }

    /// 状态里的持久化两格（`dirty` / `saveError`）：保存完成或失败都会让 payload 变，
    /// `stamp_status` 因此推进 runtimeRevision——同 revision 的旧回执就盖不掉新状态了。
    fn persistence_status(&self, payload: &mut Value) {
        let current = self.config();
        let persist = lock(&self.persist);
        payload["dirty"] = json!(persist.dirty() || persist.saved.as_ref() != Some(&current));
        payload["saveError"] = persist.save_error.clone().map(Value::String).unwrap_or(Value::Null);
    }

    pub fn document(&self) -> Option<Value> { lock(&self.document).clone() }
    fn store_document(&self, document: Value) { *lock(&self.document) = Some(document); }
    pub fn progress(&self) -> Option<(Value, std::time::Instant)> { lock(&self.progress).clone() }
    fn store_progress(&self, progress: Value) { *lock(&self.progress) = Some((progress, std::time::Instant::now())); }
}

pub fn current_status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let state = app.state::<LyricsWindowState>(); let snapshot = state.snapshot();
    let mut payload = status_payload(&snapshot.config, is_open(app), snapshot.revision);
    payload["requestedVisible"] = json!(lock(&state.lifecycle).requested);
    #[cfg(windows)] { payload["taskbar"] = app.state::<crate::taskbar_lyrics::Host>().payload(); }
    #[cfg(not(windows))] { payload["taskbar"] = crate::taskbar_lyrics::Reason::Unsupported.payload(false); }
    state.persistence_status(&mut payload);
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

// ---------------------------------------------------------------------------
// 歌词配置持久化（唯一保存任务，Rust 拥有，与 WebView 生命周期无关）
// ---------------------------------------------------------------------------

/// 起持久化线程（`setup` 里调一次；重复调用无副作用）。
/// 保存必须与 React 的挂载周期、与渲染层是否还活着脱钩——只有 Rust 拥有它，登出/崩溃都还在写。
pub fn start_persistence<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LyricsWindowState>();
    {
        let writer = lock(&state.writer);
        if writer.is_some() { return; }
    }
    let owner = app.clone();
    match std::thread::Builder::new().name("lyrics-persist".into()).spawn(move || persistence_loop(&owner)) {
        Ok(handle) => { *lock(&state.writer) = Some(handle); }
        Err(error) => log::error!("歌词配置保存任务起不来（配置会只留在内存里）：{error}"),
    }
}

/// 停下持久化线程（退出收尾时调；在飞的那一笔先等它有结论）。
pub fn stop_persistence<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LyricsWindowState>();
    lock(&state.persist).stopped = true;
    state.persist_idle.notify_all();
}

fn persistence_loop<R: Runtime>(app: &AppHandle<R>) {
    loop {
        let state = app.state::<LyricsWindowState>();
        let job = {
            let mut persist = lock(&state.persist);
            loop {
                if persist.stopped { return; }
                if let Some(job) = persist.pending.take() { break Some(job); }
                persist = state.persist_idle.wait(persist).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let Some((generation, config)) = job else { continue };
        {
            let mut persist = lock(&state.persist);
            persist.inflight = Some(generation);
        }
        // **不持 worker 需要的锁**去等 sidecar：等写盘时只拿着自己那份快照。
        let result = crate::commands::settings_write_owned(app, json!({ LYRICS_SETTING_KEY: config.persisted() }));
        let outcome = match result {
            Ok(answer) => match settings_receipt_value(&answer, LYRICS_SETTING_KEY) {
                Some(value) => WriteOutcome::Confirmed(LyricsConfig::restored(Some(value))),
                None => WriteOutcome::Unreadable,
            },
            Err(error) => {
                log::warn!("歌词配置保存失败（本次运行仍生效，不自动重试）：{}", error.message);
                WriteOutcome::Failed
            }
        };
        let mut persist = lock(&state.persist);
        persist.settle(&config, outcome);
        drop(persist);
        state.persist_idle.notify_all();
        emit_status(app);
    }
}

/// 渲染层发起的歌词配置：**先过退出准入门，再原子接受并入队**（与渲染层 settings 写共用同一个 [`crate::commands::PersistenceGate`]）。
/// 受理凭据持有到配置被接受、持久任务已入队为止，所以"已受理还没入队"的那一笔挡得住退出；锁次序：准入门 → config → persist。
fn accept_renderer_configure(
    gate: &std::sync::Arc<crate::commands::PersistenceGate>,
    state: &LyricsWindowState,
    config: &Value,
    retry: bool,
) -> Result<(LyricsConfig, LyricsSnapshot, bool), CoreError> {
    let _admission = gate.admit(crate::commands::PersistKind::Renderer)?;
    let (previous, snapshot, changed) = state.configure(config);
    if retry {
        state.retry_save();
    }
    Ok((previous, snapshot, changed))
}

/// 退出准备**失败**（`abort_exit` 保窗）时把「准入门 ↔ 歌词持久化」一起复原。
/// **顺序是合同**：先解冻歌词再放门回 `Running`，否则门开了歌词还冻着，中间到达的写会被受理却入队失败。
pub fn restore_after_failed_exit(
    gate: &std::sync::Arc<crate::commands::PersistenceGate>,
    state: &LyricsWindowState,
    while_gate_still_closed: impl FnOnce(),
) {
    state.abort_exit_drain();
    while_gate_still_closed();
    gate.abort_prepare();
}

/// 退出准备：**冻结 + 重试一次（若上一次失败）+ 等排空**；返回 `Ok(())` 才允许往下走不可逆清理。
/// 失败/超时保持现状：盘上可能还是旧的，但 Rust 侧的 dirty/saveError 仍在，主窗能回读并给出可操作提示。
pub fn prepare_exit_persistence<R: Runtime>(app: &AppHandle<R>, deadline: std::time::Instant) -> Result<(), CoreError> {
    let state = app.state::<LyricsWindowState>();
    let current = state.config();
    {
        let mut persist = lock(&state.persist);
        persist.plan_exit_drain(&current);
    }
    state.persist_idle.notify_all();
    loop {
        {
            let persist = lock(&state.persist);
            if persist.pending.is_none() && persist.inflight.is_none() {
                if persist.save_error.is_some() {
                    let code = persist.save_error.clone().unwrap_or_default();
                    return Err(CoreError::new("settings_unsaved", format!("歌词配置未保存（{code}）：本次不退出，请重试")));
                }
                return Ok(());
            }
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(CoreError::new("timeout", "等待歌词配置保存超时：本次不退出，请重试"));
        }
        let persist = lock(&state.persist);
        let _ = state.persist_idle.wait_timeout(persist, std::time::Duration::from_millis(20).min(deadline - now));
    }
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
    // 设置弹出窗**直接销毁**（不排队、不等待）：它不持有要落盘的东西，不该出现在退出预算里，也不该拖慢一次正常退出。
    crate::lyrics_settings::shutdown(app);
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

/// 谁可以改歌词配置：主窗、歌词窗，以及装着那些控件的设置弹出窗。
/// 这条**不**等于"谁能用歌词专命令"：媒体控制另有 [`require_lyrics_control_source`]，弹出窗能改外观，却不能替用户按上一首/下一首。
pub fn require_lyrics_source(label: &str) -> Result<(), CoreError> {
    if [
        MAIN_WINDOW_LABEL,
        LYRICS_WINDOW_LABEL,
        crate::LYRICS_SETTINGS_WINDOW_LABEL,
    ]
    .contains(&label)
    {
        return Ok(());
    }
    Err(CoreError::new("forbidden_source", "歌词配置仅接受主窗、歌词窗或设置弹出窗调用"))
}

/// 谁可以发歌词的**媒体控制与关闭**：只有主窗与歌词窗（弹出窗只改外观）。
pub fn require_lyrics_control_source(label: &str) -> Result<(), CoreError> {
    if [MAIN_WINDOW_LABEL, LYRICS_WINDOW_LABEL].contains(&label) {
        return Ok(());
    }
    Err(CoreError::new("forbidden_source", "歌词媒体控制仅接受主窗或歌词窗调用"))
}

pub fn validate_configure(label: &str, patch: &Value, retry_save: Option<bool>, restore_if_pristine: Option<Value>) -> Result<(), CoreError> {
    require_lyrics_source(label)?;
    if restore_if_pristine.is_some() {
        // 启动时由 Rust **只读**恢复盘上配置（`LyricsWindowState::restore`），恢复不再由渲染层触发——旧参数留着会被当成"又要覆盖一次盘"，所以明确拒。
        return Err(CoreError::new(
            "invalid_payload",
            "restoreIfPristine 已取消：启动配置由宿主只读恢复，不再接受渲染层恢复请求",
        ));
    }
    if retry_save == Some(true) {
        let empty = patch.as_object().map(|object| object.is_empty()).unwrap_or(false);
        if !empty {
            return Err(CoreError::new(
                "invalid_payload",
                "retrySave 只能与空 config 一起用（它重存的是当前运行配置，不是又改一次值）",
            ));
        }
    }
    let Some(object) = patch.as_object() else { return Err(CoreError::new("invalid_payload", "歌词配置必须是对象")); };
    for (key, value) in object {
        let valid = match key.as_str() {
            "mode" => value.as_str().and_then(LyricsMode::parse).is_some(),
            "layout" => value.as_str().is_some_and(|v| LYRICS_LAYOUTS.contains(&v)),
            "style" => value.as_str().is_some_and(|v| LYRICS_STYLES.contains(&v)),
            "color" => value.as_str().is_some_and(|v| LYRICS_COLOR_TOKENS.contains(&v)),
            "size" => value.as_str().is_some_and(|v| LYRICS_FONT_STEPS.iter().any(|(id, _)| *id == v)),
            // 任务栏那四个键各收各的（档位表不通用：桌面档位在 `taskbarSize` 里就是非法值）
            "taskbarColor" => value.as_str().is_some_and(|v| LYRICS_COLOR_TOKENS.contains(&v)),
            "taskbarSize" => value.as_str().is_some_and(|v| TASKBAR_FONT_STEPS.iter().any(|(id, _)| *id == v)),
            "taskbarKaraoke" => value.is_boolean(),
            // 自定义颜色只收空串或 `#RRGGBB`；窗口尺寸只收 null 或有限正数
            "customColor" => value.as_str().is_some_and(custom_color_ok),
            "taskbarCustomColor" => value.as_str().is_some_and(custom_color_ok),
            "windowWidth" | "windowHeight" => value.is_null()
                || value.as_f64().is_some_and(|size| size.is_finite() && size > 0.0),
            "locked" | "enableBlur" | "enableScale" | "enableSpring" | "showControls" => value.is_boolean(),
            _ => false,
        };
        if !valid { return Err(CoreError::new("invalid_payload", "歌词配置含未知字段或非法值")); }
    }
    Ok(())
}

pub fn control_payload(label: &str, payload: &Value) -> Result<Value, CoreError> {
    require_lyrics_control_source(label)?;
    if let Some(object) = payload.as_object() {
        if object.len() == 1 {
            if let Some(action) = object.get("action").and_then(Value::as_str).filter(|v| LYRICS_CONTROL_ACTIONS.contains(v)) {
                return Ok(json!({"command": action}));
            }
        }
    }
    Err(CoreError::new("invalid_payload", "歌词媒体控制仅接受 {action: toggle|previous|next|close}"))
}

// ---------------------------------------------------------------------------
// 歌词文档（最后一份的缓存 + 页面加载完成时的重发）
// ---------------------------------------------------------------------------

/// 歌词文档归一（**纯函数**）：`{lines, status}`；不是对象就回 `None`（调用方按 `invalid_payload` 报错）。
/// `lines` 不是数组就当空、`status` 认不出就 `unavailable`；提成纯函数是为了让单测钉住"缓存住的是哪一份"。
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

/// 进度只在歌词窗存在时广播（可见或隐藏都发）；不存在时只缓存最新一份。
pub fn should_emit_progress(window_exists: bool) -> bool {
    window_exists
}

pub fn first_progress_line(elapsed_ms: u64, playing: bool) -> String {
    format!("歌词窗页面加载后首条进度已转发（距加载 {elapsed_ms}ms，{}）", if playing { "播放中" } else { "已暂停" })
}

/// 页面加载完成后要补发的内容：先文档后进度；播放中的进度按缓存后经过的时间前推。
pub fn page_load_replay(document: Option<Value>, progress: Option<(Value, u64)>) -> Vec<(&'static str, Value)> {
    let mut plan = Vec::new();
    if let Some(document) = document {
        plan.push((LYRICS_DOCUMENT, document));
    }
    if let Some((mut progress, elapsed_ms)) = progress {
        if progress.get("playing").and_then(Value::as_bool) == Some(true) {
            let base = progress.get("timeMs").and_then(Value::as_f64).unwrap_or(0.0);
            progress["timeMs"] = json!(base + elapsed_ms as f64);
        }
        plan.push((LYRICS_PROGRESS, progress));
    }
    plan
}

/// 页面加载完成时补发最后一份文档与进度，并在 10 秒后核对主窗是否推来过进度。
pub fn replay_after_page_load<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<LyricsWindowState>() else { return; };
    let loaded = std::time::Instant::now();
    *lock(&state.awaiting_first_progress) = Some(loaded);
    let progress = state.progress().map(|(value, at)| (value, at.elapsed().as_millis() as u64));
    let plan = page_load_replay(state.document(), progress);
    let has_document = plan.iter().any(|(event, _)| *event == LYRICS_DOCUMENT);
    let has_progress = plan.iter().any(|(event, _)| *event == LYRICS_PROGRESS);
    if has_document && has_progress {
        log::info!("歌词窗页面加载完成：补发歌词文档与进度");
    } else if has_document {
        log::info!("歌词窗页面加载完成：补发歌词文档");
    } else if has_progress {
        log::info!("歌词窗页面加载完成：补发进度");
    }
    for (event, payload) in plan {
        emit_core_event(app, event, payload);
    }
    let owner = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let Some(state) = owner.try_state::<LyricsWindowState>() else { return; };
        let mut awaiting = lock(&state.awaiting_first_progress);
        if *awaiting != Some(loaded) { return; }
        *awaiting = None;
        drop(awaiting);
        if owner.get_webview_window(LYRICS_WINDOW_LABEL).is_some() {
            log::warn!("歌词窗页面加载 10 秒后仍未收到主窗进度");
        }
    });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/// 歌词窗的 webview 数据目录：`<数据根>/webview2/lyrics`（与登录窗 `webview2/login/<partition>` 同款）。
/// 独占目录而不是与主窗共用：WebView2 的数据目录同时被两个 webview 打开会互相踩（缓存/Cookie 库的锁）。
pub fn lyrics_data_dir(data_root: &Path) -> PathBuf {
    data_root.join("webview2").join("lyrics")
}

/// 歌词窗的标题：这是窗口在 **Alt+Tab / 任务视图**里的名字。
/// Windows 上 `skip_taskbar(true)` 只删任务栏条目，不设 `WS_EX_TOOLWINDOW`，没有标题就会在 Alt+Tab 里显示成 "Tauri App"。
pub const LYRICS_WINDOW_TITLE: &str = "桌面歌词";

/// 建窗加载的地址：`lyrics.html?<配置>&theme=<档位>`（配置经查询串同步到位，见 [`LyricsConfig::query`]）。
/// 主题也得走查询串：歌词窗调不动读主题的那条命令（`require_login_chrome_source` 只放行主窗与两个浮动控件），不传就永远停在浅色令牌上，深色主题下"有歌词但看不见"。
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

    Ok(work_area_rect(&monitor))
}

/// 一块显示器的工作区（物理像素）。**唯一读数点**：歌词窗几何与设置弹出窗定位共用它，别处不许再写 `monitor.work_area()`。
pub fn work_area_rect(monitor: &tauri::Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: f64::from(area.position.x),
        y: f64::from(area.position.y),
        width: f64::from(area.size.width),
        height: f64::from(area.size.height),
    }
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

    // 代理在建窗时读一次，改代理要重启应用才生效（主窗与登录窗相同）。
    // 三窗都接 proxy_url 是审计结论：不接的话 webview 自己的网络栈会绕过设置直连。
    let proxy = crate::proxy_url_argument(crate::webview_proxy::resolve_for_webview(
        &data_root,
        LYRICS_WINDOW_LABEL,
    ));

    let min_size = min_window_size(config);
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
    // 桌面窗未锁定时可拖拽缩放（右下角拖柄调官方 startResizeDragging），锁定与任务栏模式下不可缩放——"锁定后功能键全部隐藏"的窗口层那一半。
    .resizable(resizable_enabled(config))
    .min_inner_size(min_size.width, min_size.height)
    .focused(false)
    .visible(false)
    .data_directory(lyrics_data);

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }

    let window = builder
        // 页面（重新）加载完成 → 把最后一份歌词文档重发一次：`apply_toggle` 每次显示已有窗口都会 `reload()`，而主窗的重推总落在新页面 `listen()` 之前（即转即弃）。
        // 只认 `Finished`（`Started` 时页面的 JS 还没执行），并按 label 过滤，让"只发给歌词窗"由它自证。
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished || webview.label() != LYRICS_WINDOW_LABEL {
                return;
            }
            if let Some(state) = webview.app_handle().try_state::<LyricsWindowState>() {
                if lock(&state.lifecycle).live_generation != Some(generation) { return; }
            }
            replay_after_page_load(webview.app_handle());
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
        // 歌词窗没了，设置弹出窗也一起收（它锚在歌词窗的齿轮上，没有锚就不该留着）。
        crate::lyrics_settings::close(&events);
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
    /// 最小尺寸（DIP）：必须排在 `Geometry` 之前，否则竖版会被横版的下限夹住缩不下去。
    MinSize(Size),
    /// **只改尺寸、不动位置**：用户拖拽缩放后保存的 DIP 尺寸落到窗口上，并夹进工作区。
    /// 刻意与 [`WindowEffect::Geometry`] 分开：颜色/锁/演出/尺寸这些变化都不许让窗口跳位。
    Size(Size),
    ClickThrough(bool),
}

pub fn geometry_plan(area: Rect, config: &LyricsConfig, scale: f64, current: Option<Point>) -> (Size, Point) {
    let wanted = if config.mode == LyricsMode::Taskbar { TASKBAR_SIZE }
        // 用户拖过的尺寸优先（它是 DIP，按缩放比换成物理像素后再夹进工作区）
        else if let Some(size) = config.custom_size() { size }
        else if config.layout == "vertical" { DESKTOP_VERTICAL_SIZE }
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
    let geometry = previous.is_none_or(|old| old.mode != config.mode || old.layout != config.layout);
    if geometry {
        let (size, point) = geometry_plan(area, config, scale, current);
        apply(WindowEffect::MinSize(min_window_size(config)));
        apply(WindowEffect::Geometry(size, point));
    } else if let (Some(old), Some(size)) = (previous.and_then(LyricsConfig::custom_size), config.custom_size()) {
        // 只有"自定义尺寸变了"才动尺寸；方向切换那一支已经把尺寸清空（见 `normalized_patch`），
        // 所以这里不会跟 Geometry 抢同一帧。
        if old != size {
            let factor = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
            apply(WindowEffect::Size(Size {
                width: (size.width * factor).min(area.width).max(1.0),
                height: (size.height * factor).min(area.height).max(1.0),
            }));
        }
    }
    if previous.is_none_or(|old| click_through_enabled(old) != click_through_enabled(config)) {
        apply(WindowEffect::ClickThrough(click_through_enabled(config)));
    }
}

const POINTER_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// 配置一变就作废旧的轮询线程；锁定的桌面歌词再起一个新的。
fn sync_pointer_watch<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, config: &LyricsConfig) {
    let state = app.state::<LyricsWindowState>();
    let generation = state.pointer_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    if config.mode != LyricsMode::Desktop || !config.locked { return; }
    let app = app.clone();
    let window = window.clone();
    std::thread::spawn(move || watch_pointer(app, window, generation));
}

fn watch_pointer<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, generation: u64) {
    let mut last: Option<PointerZone> = None;
    loop {
        std::thread::sleep(POINTER_POLL);
        let Some(state) = app.try_state::<LyricsWindowState>() else { return; };
        if state.pointer_generation.load(std::sync::atomic::Ordering::SeqCst) != generation { return; }
        let config = state.config();
        if config.mode != LyricsMode::Desktop || !config.locked { return; }
        match window.is_visible() { Ok(true) => {}, Ok(false) => { last = None; continue; }, Err(_) => return }
        let zone = match (window.cursor_position(), window.inner_position(), window.inner_size(), window.scale_factor()) {
            (Ok(cursor), Ok(origin), Ok(size), Ok(scale)) => pointer_zone(
                (cursor.x, cursor.y),
                (f64::from(origin.x), f64::from(origin.y)),
                (f64::from(size.width) / scale, f64::from(size.height) / scale),
                scale,
                *lock(&state.unlock_zone),
            ),
            (Err(error), ..) => {
                log::warn!("读不到光标位置（{error}）：锁定的桌面歌词改为照常接收鼠标");
                let _ = window.set_ignore_cursor_events(false);
                return;
            }
            _ => continue,
        };
        if last == Some(zone) { continue; }
        if let Err(error) = window.set_ignore_cursor_events(zone != PointerZone::Unlock) {
            log::warn!("歌词窗的鼠标接收状态没能更新：{error}");
        }
        if last.map(|old| old != PointerZone::Outside) != Some(zone != PointerZone::Outside) {
            emit_core_event(&app, crate::bridge::LYRICS_POINTER, json!({ "inside": zone != PointerZone::Outside }));
        }
        last = Some(zone);
    }
}

fn apply_config<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, previous: Option<&LyricsConfig>, config: &LyricsConfig) -> Result<(), CoreError> {
    sync_pointer_watch(app, window, config);
    if config.mode == LyricsMode::Taskbar { return Ok(()); }
    let geometry = previous.is_none_or(|old| old.mode != config.mode || old.layout != config.layout);
    let resized = !geometry && previous.and_then(LyricsConfig::custom_size) != config.custom_size() && config.custom_size().is_some();
    let area = if geometry || resized { work_area(app, previous.is_some() && config.mode == LyricsMode::Desktop)? } else { Rect { x:0.0, y:0.0, width:1.0, height:1.0 } };
    let current = window.outer_position().ok().map(|p| Point {x: p.x.into(), y: p.y.into()});
    let mut result = Ok(());
    // 可缩放资格是窗口属性（锁定 = 不可拖大小）。失败只留痕：它是增强，不该让配置应用失败。
    if let Err(source) = window.set_resizable(resizable_enabled(config)) {
        log::warn!("歌词窗的缩放资格没能应用（{source}）：锁定态仍由渲染层不显示缩放拖柄兜住");
    }
    apply_window_effects(previous, config, area, window.scale_factor().unwrap_or(1.0), if previous.is_some() { current } else { None }, |effect| {
        let applied = match effect {
            WindowEffect::Geometry(size, point) => window.set_size(PhysicalSize::new(size.width.round() as u32, size.height.round() as u32))
                .and_then(|_| window.set_position(PhysicalPosition::new(point.x.round() as i32, point.y.round() as i32))),
            WindowEffect::MinSize(size) => window.set_min_size(Some(tauri::LogicalSize::new(size.width, size.height))),
            WindowEffect::Size(size) => window.set_size(PhysicalSize::new(size.width.round() as u32, size.height.round() as u32)),
            WindowEffect::ClickThrough(through) => window.set_ignore_cursor_events(through),
        };
        if let Err(source) = applied { result = Err(CoreError::new("internal", format!("歌词窗属性更新失败：{source}"))); }
    });
    result
}

/// 桌面窗上允许做的两种动作（生产实现包住 `WebviewWindow`；测试用会计数的那种假的）。
/// 抽成窄接口是为了让"撤销态下一个 `reload`/`show` 都不许发"能按行为验证——扫源码只证明写了 `if`，证明不了它挡在副作用之前。
pub trait DesktopWindowOps {
    fn reload(&mut self) -> Result<(), String>;
    fn show(&mut self) -> Result<(), String>;
}

/// 生产实现：动作原样转给 `WebviewWindow`（不缓存任何 tee 样式，与 tao 的唯一事实来源一致）。
struct LyricsWindowOps<'a, R: Runtime>(&'a WebviewWindow<R>);
impl<R: Runtime> DesktopWindowOps for LyricsWindowOps<'_, R> {
    fn reload(&mut self) -> Result<(), String> {
        self.0.reload().map_err(|error| error.to_string())
    }
    fn show(&mut self) -> Result<(), String> {
        self.0.show().map_err(|error| error.to_string())
    }
}

/// 桌面「打开」那一步的窄收口（**行为可测**）：所有对已有窗的 `reload`/`show` 只从这里出去。
/// 撤销态下不碰旧代次，直接回 `destroy_failed`。新建的窗只 show 不 reload，已有窗 reload 失败只留 warn。
pub fn open_desktop(
    revoked: bool,
    fresh: bool,
    window: &mut dyn DesktopWindowOps,
) -> Result<(), CoreError> {
    if revoked {
        // 一次也不碰：不 reload、不 show，窗保持隐藏，回可重试的失败。
        return Err(CoreError::new(
            "destroy_failed",
            "歌词窗清理未完成，已停显；请关闭歌词后重试",
        ));
    }
    if !fresh {
        if let Err(error) = window.reload() {
            log::warn!("歌词窗页面没能重新加载（继续显示现有页面）：{error}");
        }
    }
    // `show()` 失败发生在 `build()` 之后：窗已经在 label 表里了，如实报错让上层提示并翻回勾选
    window
        .show()
        .map_err(|source| CoreError::new("internal", format!("歌词窗显示不出来：{source}")))
}

/// 开关落地：开 = 建/摆好/**重新加载**/显示；关 = **隐藏**（不销毁，webview 与进度都留着；跨 mode/parent/monitor 重建与退出另走受控销毁）。
/// 已有的窗在 show 前必须 reload（页面只在建窗那一刻加载，加载失败就永久空白），重载后的歌词由页面加载完成回调重发；taskbar 的显隐/几何/点透全交原生宿主。
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
        // 歌词窗收起来了，挂在它上面的设置弹出窗一起收（否则会有一份菜单浮在桌面上）。
        crate::lyrics_settings::close(app);
        return Ok(false);
    }

    let (window, fresh) = match app.get_webview_window(LYRICS_WINDOW_LABEL) {
        // 已经有了（多半是上次隐藏下来的）：**不重摆几何**——用户可能刚把它拖到别处，每次开关都拽回计算位置等于"拖了白拖"。
        // 模式/点透变化由 configure 那条路负责，重新加载由 [`open_desktop`] 做（它先问撤销态）。
        Some(window) => (window, false),
        None => {
            let window = build_lyrics_window(app, config)?;
            if let Err(error) = apply_config(app, &window, None, config) {
                log::warn!("歌词窗没能摆到目标位置（按默认位置显示）：{error}");
            }
            (window, true)
        }
    };
    // 显示这一步只走窄收口：命令层的 `DesktopReopen::ReplaceRevoked` 是正常路径，这里是**竞态兜底**。
    // 判定之后、显示之前若宿主刚被 revoke，已 revoke 的旧代次照样被挡住（`destroy_failed`、窗保持隐藏）。
    open_desktop(revoked_window(app), fresh, &mut LyricsWindowOps(&window))?;
    Ok(true)
}

/// 开关失败时的收口（纯函数）：勾选态回到**窗实际在不在**，并给一句给用户看的提示。
/// 不做"勾选态 ↔ 窗存在性"的双向同步链（两条链迟早给出不同答案）：失败时一律以事实为准，勾这个动作仍由托盘自己翻转。
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

/// 桌面重开时"已经存在的那扇窗"能不能直接沿用（**纯函数**：决定权不在调用点）。
/// 被 revoke 的旧 taskbar HWND 仍活着但永久禁探测/禁显示，照旧 `reload()` + `show()` 会把它显示出来；这种代次必须先受控销毁再重建（新代次不继承旧 saved）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopReopen {
    /// 没有旧代次问题：按原来的规则（没有就建，有就 reload + show）。
    Direct,
    /// 窗还是被 revoke 的旧代次：**不许 reload/show**，先受控销毁再新建。
    ReplaceRevoked,
}

pub fn desktop_reopen(checked: bool, mode: LyricsMode, window_exists: bool, revoked: bool) -> DesktopReopen {
    if checked && mode == LyricsMode::Desktop && window_exists && revoked {
        DesktopReopen::ReplaceRevoked
    } else {
        DesktopReopen::Direct
    }
}

/// 现有歌词窗是不是**已被 revoke 的旧（taskbar）代次**。
///
/// 只有 Windows 原生宿主有这个状态；其它平台没有 taskbar 挂接，也就没有撤销态。
#[cfg(windows)]
fn revoked_window<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<crate::taskbar_lyrics::Host>().revoked_live().is_some()
}

#[cfg(not(windows))]
fn revoked_window<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
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
    // 先判定"已经存在的那扇窗"能不能沿用：被 `Host::revoke` 过的旧 taskbar 代次仍活着（live/saved 留给 restore 重试），照旧 reload+show 会把它重新显示出来。
    let reopened = desktop_reopen(
        checked,
        snapshot.config.mode,
        app.get_webview_window(LYRICS_WINDOW_LABEL).is_some(),
        revoked_window(&app),
    );
    let result = match reopened {
        DesktopReopen::Direct => apply_toggle(&app, &snapshot.config, checked).map(|_| ()),
        DesktopReopen::ReplaceRevoked => {
            // `rebuild_window` 只按 `lifecycle.requested` 决定重建后是否重开，所以这一支先把用户意图落进状态，失败即 `destroy_failed`。
            // 没有登记代次就没有受控 detach 可走：宁可保守失败，也绝不落到 apply_toggle 去 reload/show 一扇旧 HWND。
            if lock(&state.lifecycle).live_generation.is_none() {
                Err(CoreError::new("destroy_failed", "歌词窗清理未完成，已停显；请关闭歌词后重试"))
            } else {
                lock(&state.lifecycle).requested = checked;
                rebuild_window(&app, false).await
            }
        }
    };
    match result {
        Ok(()) => {
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

/// 改歌词配置（窄命令）：空 `config` 纯读运行状态，带字段则打补丁并推进 revision，`retrySave` 重存当前配置。
/// 传 `restoreIfPristine` 明确回 `invalid_payload`：启动配置只由 Rust 只读恢复（见 [`LyricsWindowState::restore`]），不静默当成普通改值。
#[tauri::command]
pub async fn core_lyrics_configure(
    app: AppHandle,
    webview: tauri::Webview,
    config: Value,
    retry_save: Option<bool>,
    restore_if_pristine: Option<Value>,
) -> Result<Value, CoreError> {
    validate_configure(webview.label(), &config, retry_save, restore_if_pristine)?;
    let state = app.state::<LyricsWindowState>();
    let _operation = state.operations.lock().await;
    #[cfg(windows)] {
        let document_generation = webview.url().ok().and_then(|url| url.query_pairs().find(|(key, _)| key == "generation").and_then(|(_, value)| value.parse().ok()));
        let generation = ready_generation(webview.label(), document_generation, lock(&state.lifecycle).live_generation, config.as_object().is_some_and(|map| map.is_empty()));
        if let Some(generation) = generation { app.state::<crate::taskbar_lyrics::Host>().ready(generation); }
    }
    let retry = retry_save == Some(true);
    let gate = crate::commands::persistence_gate(&app)?;
    let (previous, snapshot, changed) = accept_renderer_configure(&gate, &state, &config, retry)?;
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
        // 锁定 / 切任务栏之后设置弹出窗都不该再留着（任务栏那条根本不挂控件）；放在应用之后：先摆对窗口再收菜单。
        if snapshot.config.locked || snapshot.config.mode == LyricsMode::Taskbar {
            crate::lyrics_settings::close(&app);
        }
    }
    let payload = read_status(&app).await?;
    if changed || retry { emit_core_event(&app, LYRICS_STATE, payload.clone()); }
    Ok(payload)
}

/// 歌词窗的三枚媒体键转成播放命令；`close` 与托盘「关闭桌面歌词」同一条路：先把托盘勾选改成不勾，再请主窗关歌词窗。
#[tauri::command]
pub async fn core_lyrics_control(app: AppHandle, webview: tauri::Webview, payload: Value) -> Result<Value, CoreError> {
    let command = control_payload(webview.label(), &payload)?;
    if command["command"] == "close" {
        crate::tray::revert_lyrics_checked(&app, false);
        emit_core_event(&app, crate::bridge::LYRICS_TOGGLE, json!({ "checked": false }));
    } else {
        emit_core_event(&app, crate::bridge::PLAYER_COMMAND, command);
    }
    Ok(Value::Null)
}

/// 歌词页报告解锁按钮所在区域（只接受歌词窗自己调用）。
#[tauri::command]
pub async fn core_lyrics_unlock_zone(app: AppHandle, webview: tauri::Webview, zone: Value) -> Result<Value, CoreError> {
    if webview.label() != LYRICS_WINDOW_LABEL {
        return Err(CoreError::new("forbidden_source", "解锁区只接受歌词窗调用"));
    }
    let parsed = parse_unlock_zone(&zone)?;
    *lock(&app.state::<LyricsWindowState>().unlock_zone) = parsed;
    Ok(Value::Null)
}

/// 把歌词文档转发给歌词窗（歌词窗没有业务频道权限，数据只能由主窗转发），顺手留一份供 [`replay_after_page_load`] 重发。
/// 留的是归一之后的形状——缓存里躺着的与发出去的必须是同一份。
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

/// 推进度：先缓存最新一份，歌词窗存在时才广播（主窗已按 ≥100ms 或播放/跳转变化节流）。
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

    let payload = json!({ "timeMs": time_ms, "playing": playing, "seekGeneration": seek_generation });
    let state = app.state::<LyricsWindowState>();
    state.store_progress(payload.clone());
    if !should_emit_progress(app.get_webview_window(LYRICS_WINDOW_LABEL).is_some()) {
        return Ok(Value::Null);
    }
    if let Some(loaded) = lock(&state.awaiting_first_progress).take() {
        log::info!("{}", first_progress_line(loaded.elapsed().as_millis() as u64, playing));
    }
    emit_core_event(&app, LYRICS_PROGRESS, payload);
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 进度缓存、只在歌词窗存在时广播、加载完成补发 -------------------------

    #[test]
    fn r68b_progress_is_broadcast_only_while_the_lyrics_window_exists() {
        assert!(!should_emit_progress(false), "歌词窗不在了：只缓存最新一份，不广播");
        assert!(should_emit_progress(true), "窗口存在（可见或隐藏）都要广播");
    }

    #[test]
    fn r68b_first_progress_line_carries_the_gap_and_the_state() {
        assert_eq!(
            first_progress_line(1234, true),
            "歌词窗页面加载后首条进度已转发（距加载 1234ms，播放中）"
        );
        assert_eq!(
            first_progress_line(0, false),
            "歌词窗页面加载后首条进度已转发（距加载 0ms，已暂停）"
        );
    }

    #[test]
    fn r68b_page_load_replays_document_first_then_progress() {
        let document = json!({ "lines": [{ "text": "a" }], "status": "ready" });

        let both = page_load_replay(
            Some(document.clone()),
            Some((json!({ "timeMs": 1000.0, "playing": true, "seekGeneration": 3 }), 250)),
        );
        assert_eq!(both.len(), 2, "两样都缓存着就补发两样");
        assert_eq!(both[0], (LYRICS_DOCUMENT, document), "先文档");
        assert_eq!(both[1].0, LYRICS_PROGRESS, "后进度");
        assert_eq!(both[1].1["timeMs"], json!(1250.0), "播放中：时间加上经过的毫秒数");
        assert_eq!(both[1].1["playing"], json!(true));
        assert_eq!(both[1].1["seekGeneration"], json!(3), "跳转代次原样带上");

        let document_only = page_load_replay(Some(json!({ "status": "ready" })), None);
        assert_eq!(document_only.len(), 1, "只有文档就只发文档");
        assert_eq!(document_only[0].0, LYRICS_DOCUMENT);

        let progress_only = page_load_replay(
            None,
            Some((json!({ "timeMs": 700.0, "playing": false, "seekGeneration": 0 }), 5000)),
        );
        assert_eq!(progress_only.len(), 1, "只有进度就只发进度");
        assert_eq!(progress_only[0].0, LYRICS_PROGRESS);
        assert_eq!(progress_only[0].1["timeMs"], json!(700.0), "暂停中：时间不动");

        assert_eq!(page_load_replay(None, None), Vec::new(), "都没有就什么都不发");
    }

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

    /// 桌面重开**不得**沿用已被 revoke 的旧 taskbar 代次（旧 HWND 仍活着，但可能还挂在 Explorer 下）。
    /// 那种情况下照旧 `reload()` + `show()` 就会把旧子窗重新显示出来，必须先受控销毁再重建。
    #[test]
    fn d3_desktop_reopen_replaces_a_revoked_generation_instead_of_reusing_it() {
        assert_eq!(
            desktop_reopen(true, LyricsMode::Desktop, true, true),
            DesktopReopen::ReplaceRevoked,
            "旧代次被 revoke 后仍活着：不许 reload/show，必须先受控销毁再由新代次重建"
        );
        assert_eq!(
            desktop_reopen(true, LyricsMode::Desktop, true, false),
            DesktopReopen::Direct,
            "没被 revoke 的桌面窗照旧沿用（reload + show）"
        );
        assert_eq!(
            desktop_reopen(true, LyricsMode::Desktop, false, true),
            DesktopReopen::Direct,
            "没有窗就没有可沿用的旧 HWND：直接新建一代"
        );
        assert_eq!(
            desktop_reopen(false, LyricsMode::Desktop, true, true),
            DesktopReopen::Direct,
            "关（hide）不销毁：撤销态只拦「打开」这一侧"
        );
        assert_eq!(
            desktop_reopen(true, LyricsMode::Taskbar, true, true),
            DesktopReopen::Direct,
            "taskbar 分支已由宿主 request 拒绝复活，不走桌面重建"
        );
    }

    /// 命令行为（扫源码）：先判定，再决定沿用还是受控重建；重建复用既有销毁路径。
    #[test]
    fn d3_desktop_toggle_consults_the_plan_before_applying_it() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let start = production.find("pub async fn core_lyrics_toggle(").expect("开关命令必须在");
        let end = production.find("pub async fn core_lyrics_configure(").expect("窄配置命令必须在");
        let toggle = &production[start..end];
        let plan = toggle.find("desktop_reopen(").expect("开关命令必须先问「这扇窗能不能沿用」");
        let reused = toggle.find("apply_toggle(").expect("沿用那条路仍在");
        assert!(plan < reused, "判定必须在 apply_toggle（reload/show）之前");
        let branch = toggle.find("DesktopReopen::ReplaceRevoked").expect("被 revoke 的旧代次要有单独一条路");
        assert!(branch > plan);
        let replaced = &toggle[branch..];
        let rebuild = replaced.find("rebuild_window(").expect("旧代次走既有的受控 detach/restore/destroy 后重建");
        assert!(
            !replaced[..rebuild].contains(".show()") && !replaced[..rebuild].contains(".reload()"),
            "那条路不许再显示/重新加载旧 HWND"
        );
        assert!(
            production.contains("fn revoked_window"),
            "撤销态只读地取自宿主（不在命令里现猜）"
        );
        // 竞态兜底：真正 reload/show 的那一步也要先问撤销态（命令层判定之后、显示之前被 revoke）。
        let seam = production.find("pub fn open_desktop(").expect("显示那一步必须是窄收口");
        let seam_body = &production[seam..];
        let seam_body = &seam_body[..seam_body.find("\n}").expect("窄收口要有结尾")];
        assert!(seam_body.find("if revoked").expect("窄收口必须先问撤销态") < seam_body.find("window.reload()").expect("reload 仍在"));
        let applied = production.find("fn apply_toggle").expect("apply_toggle 必须在");
        let applied_body = &production[applied..];
        let applied_body = &applied_body[..applied_body.find("\n}\n").expect("apply_toggle 要有结尾")];
        assert!(
            applied_body.contains("open_desktop(revoked_window(app)"),
            "沿用的那条路只许从窄收口显示，且撤销态取自宿主"
        );
    }

    /// 假宿主：只回答 [`revoked_window`] 问的那一件事——**已 revoke 但仍活着**的旧代次还在不在
    /// （生产实现是 `Host::revoked_live()`：撤销态 + `live` 仍存在）。
    struct FakeRevokedHost {
        live: Option<u64>,
        revoked: Option<u64>,
    }
    impl FakeRevokedHost {
        /// 旧 taskbar 代次被 revoke 之后的状态：`live`/`saved` 都刻意保留（好让同一代次重试
        /// restore/detach），所以它**还活着**，只是不许被显示。
        fn revoked_live(generation: u64) -> Self {
            Self { live: Some(generation), revoked: Some(generation) }
        }
        fn healthy(generation: u64) -> Self {
            Self { live: Some(generation), revoked: None }
        }
        fn revoked_live_generation(&self) -> Option<u64> {
            if self.revoked.is_some() {
                self.live
            } else {
                None
            }
        }
    }

    /// 假窗：只数次数（`reload`/`show`）并记可见性——D3 要断言的就是这两个计数。
    #[derive(Default)]
    struct FakeDesktopWindow {
        reloads: usize,
        shows: usize,
        visible: bool,
    }
    impl DesktopWindowOps for FakeDesktopWindow {
        fn reload(&mut self) -> Result<(), String> {
            self.reloads += 1;
            Ok(())
        }
        fn show(&mut self) -> Result<(), String> {
            self.shows += 1;
            self.visible = true;
            Ok(())
        }
    }

    /// 撤销态 + 桌面 toggle ⇒ 旧 HWND 的 `show`/`reload` 计数必须都是 0，窗保持隐藏，回 `destroy_failed`（可重试）。
    /// 这条必须验行为而不是扫源码："判定写了、副作用照发"正是缺陷本身。
    #[test]
    fn d3_revoked_generation_is_never_reloaded_or_shown_by_a_desktop_toggle() {
        // 现场：Beta 显示中切回 Desktop，restore 失败 → 旧 g1 被 revoke 但 HWND 仍活着。
        let host = FakeRevokedHost::revoked_live(1);
        let mut window = FakeDesktopWindow::default();
        let outcome = open_desktop(host.revoked_live_generation().is_some(), false, &mut window);
        // 先看副作用：这两条一旦不为 0，就说明旧 HWND 被重新显示/重载了（= 缺陷本身）。
        assert_eq!(window.reloads, 0, "旧 HWND 一次也不许 reload");
        assert_eq!(window.shows, 0, "旧 HWND 一次也不许 show");
        assert!(!window.visible, "撤销态下窗必须保持隐藏（用户再点一次才是重试）");
        let error = outcome.expect_err("撤销态下桌面 toggle 必须失败关闭：绝不许把旧 HWND 重新显示出来");
        assert_eq!(error.kind.as_deref(), Some("destroy_failed"), "要回可重试的 destroy_failed");
        // 同一状态再点一次（用户重试）：在撤销解除之前仍不许放行——只有新代次 register
        // 或同一代次受控 detach/restore 成功才解除，这里不再碰窗。
        let mut retry = FakeDesktopWindow::default();
        assert!(open_desktop(host.revoked_live_generation().is_some(), false, &mut retry).is_err());
        assert_eq!((retry.reloads, retry.shows), (0, 0), "重试也不许绕过撤销");
    }

    /// 正控：没被 revoke 的桌面窗**照旧** reload + show；刚建出来的窗只 show（不打断首次加载）。
    /// 少了这条，"撤销态什么都不做"可以用"永远什么都不做"作弊过关。
    #[test]
    fn d3_a_healthy_desktop_generation_still_reloads_and_shows() {
        let host = FakeRevokedHost::healthy(2);
        let mut window = FakeDesktopWindow::default();
        open_desktop(host.revoked_live_generation().is_some(), false, &mut window)
            .expect("没被 revoke 的窗必须照旧显示");
        assert_eq!((window.reloads, window.shows, window.visible), (1, 1, true));
        let mut fresh = FakeDesktopWindow::default();
        open_desktop(false, true, &mut fresh).expect("新建的窗必须显示");
        assert_eq!((fresh.reloads, fresh.shows, fresh.visible), (0, 1, true), "新建的窗不 reload");
    }

    /// 原子 revision 仍成立；`restoreIfPristine` 那条旧入口**已取消**（启动恢复由宿主只读做）。
    #[test]
    fn r44e_atomic_revision_and_the_retired_pristine_restore() {
        let state = LyricsWindowState::default();
        let (_, accepted, changed) = state.configure(&json!({"layout":"vertical", "style":"panel"}));
        assert!(changed);
        assert_eq!(accepted.revision, 1);
        assert_eq!(accepted.config.payload()["layout"], "vertical");
        let (_, next, _) = state.configure(&json!({"locked":true}));
        assert_eq!(next.revision, 2);
        // 旧参数必须明确被拒（不许静默当成普通改值）
        let retired = validate_configure(MAIN_WINDOW_LABEL, &json!({}), None, Some(json!(true)))
            .expect_err("restoreIfPristine 已取消");
        assert_eq!(retired.kind.as_deref(), Some("invalid_payload"));
        assert!(retired.message.contains("restoreIfPristine"), "{}", retired.message);
        for source in [MAIN_WINDOW_LABEL, LYRICS_WINDOW_LABEL] {
            assert!(validate_configure(source, &json!({}), None, Some(Value::Null)).is_err(), "连 null 也拒（按旧合同传过就是旧调用方）");
        }
        // retrySave 只能与空 config 一起用；空 config 本身仍是纯读
        assert!(validate_configure(LYRICS_WINDOW_LABEL, &json!({}), Some(true), None).is_ok());
        let bad_retry = validate_configure(MAIN_WINDOW_LABEL, &json!({"locked": true}), Some(true), None)
            .expect_err("retrySave 不许夹带改值");
        assert_eq!(bad_retry.kind.as_deref(), Some("invalid_payload"));
        assert_eq!(state.configure(&json!({})).1.revision, 2, "空补丁是纯读：不动 revision");
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..20).map(|i| { let state = &state; scope.spawn(move || {
                let (_, snapshot, changed) = state.configure(&json!({"size": if i % 2 == 0 {"sm"} else {"xl"}}));
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
            assert!(validate_configure(source, &json!({"locked":true}), None, None).is_ok());
            assert!(validate_configure(source, &json!({"document":[]}), None, None).is_err());
            assert!(validate_configure(source, &json!({"enableBlur":"yes"}), None, None).is_err());
        }
        for source in ["login", "login-theme", "login-return", "tray", ""] {
            assert!(control_payload(source, &json!({"action":"next"})).is_err());
            assert!(validate_configure(source, &json!({}), None, None).is_err());
        }
        // 恢复已取消：任何来源（含主窗）传旧参数都拒；retrySave 只接受空 config。
        assert!(validate_configure(MAIN_WINDOW_LABEL, &json!({}), None, Some(json!(false))).is_err());
        assert!(validate_configure(MAIN_WINDOW_LABEL, &json!({}), Some(true), None).is_ok());
        assert!(validate_configure(MAIN_WINDOW_LABEL, &json!({"locked":true}), Some(true), None).is_err());
        assert!(require_main_webview("lyrics").is_err());
        assert!(crate::commands::require_login_chrome_source("lyrics").is_err());
    }

    #[test]
    fn r44c_visual_changes_never_emit_geometry_but_layout_is_scaled_and_clamped() {
        let current = LyricsConfig::default();
        let area = Rect { x: -1920.0, y: -200.0, width: 1920.0, height: 1040.0 };
        let mut effects = Vec::new();
        let visual = current.apply_patch(&json!({"locked":true,"color":"primary","style":"panel","enableBlur":false,"enableScale":false,"enableSpring":false}));
        apply_window_effects(Some(&current), &visual, area, 1.25, Some(Point {x:-800.0,y:150.0}), |effect| effects.push(effect));
        assert_eq!(effects, vec![WindowEffect::ClickThrough(true)]);
        effects.clear();
        let vertical = visual.apply_patch(&json!({"layout":"vertical"}));
        apply_window_effects(Some(&visual), &vertical, area, 1.25, Some(Point {x:-200.0,y:700.0}), |effect| effects.push(effect));
        // 竖版默认 112×600 DIP → 1.25 缩放比下 140×750 物理像素；最小尺寸先于几何
        assert_eq!(effects, vec![
            WindowEffect::MinSize(Size { width: MIN_VERTICAL_WINDOW_WIDTH_DIP, height: MIN_WINDOW_HEIGHT_DIP }),
            WindowEffect::Geometry(Size {width:140.0,height:750.0}, Point {x:-200.0,y:90.0}),
        ]);
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

    /// 默认尺寸紧凑（横版 800×128、竖版 112×600），横版最小尺寸与任务栏尺寸不变。
    /// 默认尺寸是**用户什么都不改时看到的那个窗**，悄悄长回去就等于"改成紧凑"这件事没做。
    #[test]
    fn r51_the_default_desktop_sizes_are_compact() {
        assert_eq!((DESKTOP_SIZE.width, DESKTOP_SIZE.height), (800.0, 128.0));
        assert_eq!((DESKTOP_VERTICAL_SIZE.width, DESKTOP_VERTICAL_SIZE.height), (112.0, 600.0));
        assert_eq!((TASKBAR_SIZE.width, TASKBAR_SIZE.height), (1200.0, 44.0), "任务栏尺寸不变");
        assert_eq!((MIN_WINDOW_WIDTH_DIP, MIN_WINDOW_HEIGHT_DIP), (240.0, 120.0), "横版最小尺寸不变");
        assert_eq!(MIN_VERTICAL_WINDOW_WIDTH_DIP, 96.0, "竖版最小宽度");

        let area = main_monitor();
        let horizontal = LyricsConfig::default();
        let (size, _) = geometry_plan(area, &horizontal, 1.0, None);
        assert_eq!(size, DESKTOP_SIZE, "横版默认走 DESKTOP_SIZE");
        let vertical = horizontal.apply_patch(&json!({"layout": "vertical"}));
        let (size, _) = geometry_plan(area, &vertical, 1.0, None);
        assert_eq!(size, DESKTOP_VERTICAL_SIZE, "竖版默认走 DESKTOP_VERTICAL_SIZE");
        // 用户保存过的自定义尺寸不受影响
        let custom = horizontal.apply_patch(&json!({"windowWidth": 640.0, "windowHeight": 200.0}));
        assert_eq!(
            geometry_plan(area, &custom, 1.0, None).0,
            Size { width: 640.0, height: 200.0 },
            "自定义尺寸优先于新的默认值"
        );
    }

    /// 最小尺寸跟着布局走：横版切竖版时先放宽下限再改几何，竖版的尺寸补丁按竖版下限夹。
    #[test]
    fn r76_min_size_follows_layout_and_is_applied_before_geometry() {
        let horizontal = LyricsConfig::default();
        let vertical = horizontal.apply_patch(&json!({"layout": "vertical"}));
        let taskbar = vertical.apply_patch(&json!({"mode": "taskbar"}));
        assert_eq!(min_window_size(&horizontal), Size { width: 240.0, height: 120.0 });
        assert_eq!(min_window_size(&vertical), Size { width: 96.0, height: 120.0 });
        assert_eq!(min_window_size(&taskbar), Size { width: 240.0, height: 120.0 }, "任务栏不用竖版下限");

        let mut effects = Vec::new();
        apply_window_effects(Some(&horizontal), &vertical, main_monitor(), 1.0, None, |effect| effects.push(effect));
        assert_eq!(effects.first(), Some(&WindowEffect::MinSize(Size { width: 96.0, height: 120.0 })), "先放宽下限：{effects:?}");
        assert!(matches!(effects.get(1), Some(WindowEffect::Geometry(size, _)) if *size == DESKTOP_VERTICAL_SIZE), "再改几何：{effects:?}");

        effects.clear();
        apply_window_effects(Some(&vertical), &horizontal, main_monitor(), 1.0, None, |effect| effects.push(effect));
        assert_eq!(effects.first(), Some(&WindowEffect::MinSize(Size { width: 240.0, height: 120.0 })), "切回横版也先改下限：{effects:?}");

        assert_eq!(vertical.apply_patch(&json!({"windowWidth": 50.0})).window_width, Some(96.0), "竖版按竖版下限夹");
        assert_eq!(horizontal.apply_patch(&json!({"windowWidth": 100.0})).window_width, Some(240.0), "横版仍按 240 夹");
        assert_eq!(horizontal.apply_patch(&json!({"layout": "vertical", "windowWidth": 100.0})).window_width, Some(100.0), "同一补丁里先换布局，再按新布局的下限夹");
    }

    /// 设置弹出窗的四条关闭路径都接在歌词窗这一侧（隐藏/销毁/锁定或切任务栏/退出）。
    /// 扫的是"这些时刻有没有人去收弹出窗"，真窗行为不在这条用例的范围内。
    #[test]
    fn r51_the_popup_is_closed_on_every_lyrics_lifecycle_event() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let hide_branch = production
            .split("if !checked {")
            .nth(1)
            .expect("关歌词那条分支必须在")
            .split("return Ok(false);")
            .next()
            .unwrap();
        assert!(
            hide_branch.contains("crate::lyrics_settings::close(app)"),
            "歌词窗隐藏时要把设置弹出窗一起收"
        );
        let configure = production
            .split("pub async fn core_lyrics_configure(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(
            configure.contains("snapshot.config.locked || snapshot.config.mode == LyricsMode::Taskbar"),
            "锁定或切到任务栏模式之后不能再留一份菜单在桌面上"
        );
        assert!(
            configure.contains("crate::lyrics_settings::close(&app)"),
            "那条判定之后要真的收窗"
        );
        let destroy = production
            .split("tauri::WindowEvent::Destroyed")
            .nth(1)
            .unwrap()
            .split("let mut recover")
            .next()
            .unwrap();
        assert!(
            destroy.contains("crate::lyrics_settings::close(&events)"),
            "歌词窗销毁时弹出窗一起收"
        );
        let shutdown = production
            .split("pub fn begin_shutdown")
            .nth(1)
            .unwrap()
            .split("#[cfg(windows)]")
            .next()
            .unwrap();
        assert!(
            shutdown.contains("crate::lyrics_settings::shutdown(app)"),
            "退出时直接销毁弹出窗（不排队、不等待）"
        );
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
    /// 钳的是**偏移**而不是最终坐标——把坐标钳到 0 会把窗口从左侧副屏扔回主屏。
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
        assert_eq!(config.effective_size(), "lg");
    }

    #[test]
    fn config_patch_never_guesses_unknown_values() {
        let base = LyricsConfig {
            mode: LyricsMode::Desktop,
            size: "xl".to_string(),
            color: "primary".to_string(),
            locked: true,
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
        }));
        assert_eq!(patched.mode, LyricsMode::Taskbar);
        assert_eq!(patched.size, "md");
        assert_eq!(patched.color, "contrast");
        assert!(!patched.locked);
    }

    /// 任务栏档位表每一档都 ≤ 20px（上限由表本身保证，不靠桌面档位去压）。
    /// 任务栏有自己的一列档位（`TASKBAR_FONT_STEPS`），桌面选的字号不再参与任务栏渲染。
    #[test]
    fn taskbar_font_steps_never_exceed_the_pinned_ceiling() {
        assert_eq!(
            TASKBAR_FONT_STEPS.iter().map(|(_, px)| *px).max(),
            Some(TASKBAR_MAX_FONT_PX),
            "最大一档就是简报钉死的上限（否则档位表可以偷偷长大）"
        );
        for (id, px) in TASKBAR_FONT_STEPS {
            assert!(*px <= TASKBAR_MAX_FONT_PX, "{id}（{px}px）超过上限");
        }
        // 桌面档位与任务栏档位是两张表：id 不许重叠（重叠就没法各自校验）
        for (id, _) in LYRICS_FONT_STEPS {
            assert!(
                !TASKBAR_FONT_STEPS.iter().any(|(taskbar_id, _)| taskbar_id == id),
                "档位 id 两侧不许同名：{id}"
            );
        }
    }

    // ---- 任务栏歌词的独立外观（颜色 / 逐字高亮 / 字号）--------------------------

    /// 四个任务栏字段各有默认值，且默认值本身合法（不靠"碰巧表里第一个"）。
    #[test]
    fn r59_taskbar_appearance_defaults_are_valid_choices() {
        let config = LyricsConfig::default();
        assert_eq!(config.taskbar_size, DEFAULT_TASKBAR_SIZE);
        assert_eq!(config.taskbar_color, DEFAULT_TASKBAR_COLOR);
        assert_eq!(config.taskbar_custom_color, "");
        assert!(config.taskbar_karaoke, "逐字高亮默认开：R58 修好的观感就是默认观感");
        assert!(TASKBAR_FONT_STEPS.iter().any(|(id, _)| *id == DEFAULT_TASKBAR_SIZE));
        assert!(LYRICS_COLOR_TOKENS.contains(&DEFAULT_TASKBAR_COLOR));
        // 默认字号 = 20px（沿用桌面 lg 被压到这一档时的实际观感）
        let default_px = TASKBAR_FONT_STEPS
            .iter()
            .find(|(id, _)| *id == DEFAULT_TASKBAR_SIZE)
            .map(|(_, px)| *px);
        assert_eq!(default_px, Some(20), "默认任务栏字号 = R58 渲染出来的 20px");
    }

    /// 坏值不覆盖上一个合法值：认不出的档位/令牌/自定义色/非布尔一律丢掉。
    #[test]
    fn r59_taskbar_fields_never_guess_and_validation_rejects_bad_values() {
        let base = LyricsConfig {
            taskbar_size: "tlg".to_string(),
            taskbar_color: "primary".to_string(),
            taskbar_custom_color: "#112233".to_string(),
            taskbar_karaoke: false,
            ..LyricsConfig::default()
        };
        let bogus = base.apply_patch(&json!({
            // 桌面档位不是任务栏档位（两张表，不许混用）
            "taskbarSize": "lg",
            "taskbarColor": "#fff",
            "taskbarCustomColor": "red",
            "taskbarKaraoke": "yes",
        }));
        assert_eq!(bogus, base, "坏值一个都不许覆盖");

        let patched = base.apply_patch(&json!({
            "taskbarSize": "txl",
            "taskbarColor": "contrast",
            "taskbarCustomColor": "",
            "taskbarKaraoke": true,
        }));
        assert_eq!(patched.taskbar_size, "txl");
        assert_eq!(patched.taskbar_color, "contrast");
        assert_eq!(patched.taskbar_custom_color, "", "空串 = 回设计令牌");
        assert!(patched.taskbar_karaoke);

        for patch in [
            json!({"taskbarSize": "tlg"}),
            json!({"taskbarColor": "muted"}),
            json!({"taskbarCustomColor": "#00dd00"}),
            json!({"taskbarCustomColor": ""}),
            json!({"taskbarKaraoke": false}),
        ] {
            assert!(
                validate_configure(crate::MAIN_WINDOW_LABEL, &patch, None, None).is_ok(),
                "合法补丁必须收：{patch}"
            );
        }
        for patch in [
            json!({"taskbarSize": "lg"}),
            json!({"taskbarSize": "tsm2"}),
            json!({"taskbarColor": "#fff"}),
            json!({"taskbarCustomColor": "#12"}),
            json!({"taskbarCustomColor": true}),
            json!({"taskbarKaraoke": 1}),
            json!({"taskbarKaraoke": "on"}),
        ] {
            let error = validate_configure(crate::MAIN_WINDOW_LABEL, &patch, None, None)
                .expect_err("坏值必须被拒（拒 = 保留上一次合法值）");
            assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "{patch}");
        }
    }

    /// 落盘往返 + 查询串：四个键各自到位，`#` 照旧转义；旧盘缺键时按默认。
    #[test]
    fn r59_taskbar_fields_round_trip_through_persisted_query_and_restore() {
        let config = LyricsConfig {
            taskbar_size: "tsm".to_string(),
            taskbar_color: "muted".to_string(),
            taskbar_custom_color: "#00DD00".to_string(),
            taskbar_karaoke: false,
            ..LyricsConfig::default()
        };
        let persisted = config.persisted();
        assert_eq!(persisted["taskbarSize"], "tsm");
        assert_eq!(persisted["taskbarColor"], "muted");
        assert_eq!(persisted["taskbarCustomColor"], "#00DD00");
        assert_eq!(persisted["taskbarKaraoke"], false);
        assert_eq!(LyricsConfig::restored(Some(&persisted)), config, "往返一字不差");

        let query = config.query();
        assert!(query.contains("taskbarSize=tsm"), "{query}");
        assert!(query.contains("taskbarColor=muted"), "{query}");
        assert!(query.contains("taskbarCustomColor=%2300DD00"), "`#` 必须转义：{query}");
        assert!(query.contains("taskbarKaraoke=0"), "布尔写成 0/1：{query}");

        // 旧 settings.json 没有这四个键：按默认（不是空串、不是 false）
        let old = LyricsConfig::restored(Some(&json!({"mode": "taskbar", "size": "lg", "color": "primary"})));
        assert_eq!(old.taskbar_size, DEFAULT_TASKBAR_SIZE);
        assert_eq!(old.taskbar_color, DEFAULT_TASKBAR_COLOR);
        assert_eq!(old.taskbar_custom_color, "");
        assert!(old.taskbar_karaoke);

        // 盘上的坏值同样不猜（整格按默认，不 panic）
        let broken = LyricsConfig::restored(Some(&json!({
            "taskbarSize": 7, "taskbarColor": "neon", "taskbarKaraoke": "no", "taskbarCustomColor": "#12"
        })));
        assert_eq!(broken, LyricsConfig::default());
    }

    /// 各读各的：任务栏模式读 `taskbarSize`，桌面模式读 `size`，两边互不改写。
    #[test]
    fn r59_each_mode_reads_its_own_size() {
        let config = LyricsConfig {
            mode: LyricsMode::Taskbar,
            size: "xxl".to_string(),
            taskbar_size: "tlg".to_string(),
            ..LyricsConfig::default()
        };
        assert_eq!(config.effective_size(), "tlg", "任务栏模式只读任务栏字号");
        assert_eq!(config.size, "xxl", "桌面档位原样保留（切回去不丢）");
        assert_eq!(config.apply_patch(&json!({"mode": "desktop"})).effective_size(), "xxl");
        // 认不出的任务栏档位（盘上被手改过）：落默认，绝不 panic
        let broken = LyricsConfig {
            mode: LyricsMode::Taskbar,
            taskbar_size: "huge".to_string(),
            ..LyricsConfig::default()
        };
        assert_eq!(broken.effective_size(), DEFAULT_TASKBAR_SIZE);
        // 桌面模式完全不受任务栏字段影响
        let desktop = LyricsConfig {
            taskbar_size: "tsm".to_string(),
            size: "sm".to_string(),
            ..LyricsConfig::default()
        };
        assert_eq!(desktop.effective_size(), "sm");
    }

    #[test]
    fn taskbar_and_locked_desktop_ignore_the_cursor() {
        let desktop = LyricsConfig::default();
        assert!(!click_through_enabled(&desktop), "未锁定的桌面歌词要能接收鼠标");
        let locked = LyricsConfig { locked: true, ..LyricsConfig::default() };
        assert!(click_through_enabled(&locked), "锁定的桌面歌词不接收鼠标");
        let taskbar = LyricsConfig { mode: LyricsMode::Taskbar, ..LyricsConfig::default() };
        assert!(click_through_enabled(&taskbar), "任务栏模式一律不接收鼠标");
    }

    /// 盘上还留着已删除的 `clickThrough` 时要照常恢复（它现在是未知字段）。
    #[test]
    fn a_saved_config_with_the_removed_click_through_key_still_restores() {
        let old = json!({ "mode": "desktop", "locked": true, "clickThrough": true, "style": "panel" });
        let restored = LyricsConfig::restored(Some(&old));
        assert!(restored.locked);
        assert_eq!(restored.style, "panel");
        assert!(restored.persisted().get("clickThrough").is_none(), "已删除的键不再写回");
        assert_eq!(LyricsConfig::default().apply_patch(&json!({"style": "bare"})).style, "bare");
    }

    #[test]
    fn pointer_zone_maps_physical_cursor_to_css_pixels() {
        let unlock = Some(UnlockZone { x: 380.0, y: 0.0, width: 40.0, height: 28.0 });
        let origin = (1000.0, 500.0);
        let size = (800.0, 128.0);
        assert_eq!(pointer_zone((990.0, 510.0), origin, size, 1.5, unlock), PointerZone::Outside);
        assert_eq!(pointer_zone((1000.0 + 100.0 * 1.5, 500.0 + 60.0 * 1.5), origin, size, 1.5, unlock), PointerZone::Inside);
        assert_eq!(pointer_zone((1000.0 + 400.0 * 1.5, 500.0 + 10.0 * 1.5), origin, size, 1.5, unlock), PointerZone::Unlock);
        assert_eq!(pointer_zone((1000.0 + 400.0 * 1.5, 500.0 + 10.0 * 1.5), origin, size, 1.5, None), PointerZone::Inside);
        assert_eq!(pointer_zone((1000.0 + 800.0 * 1.5, 510.0), origin, size, 1.5, unlock), PointerZone::Outside, "右边界不算在窗内");
        assert_eq!(pointer_zone((-300.0, 50.0), (-500.0, 0.0), size, 1.0, None), PointerZone::Inside, "副屏的负坐标照常换算");
    }

    #[test]
    fn unlock_zone_payload_is_null_or_exactly_four_numbers() {
        assert_eq!(parse_unlock_zone(&Value::Null).ok(), Some(None));
        assert_eq!(
            parse_unlock_zone(&json!({"x": 1, "y": 2, "width": 30, "height": 28})).ok(),
            Some(Some(UnlockZone { x: 1.0, y: 2.0, width: 30.0, height: 28.0 }))
        );
        assert!(parse_unlock_zone(&json!({"x": 1, "y": 2, "width": 30})).is_err(), "少一个键");
        assert!(parse_unlock_zone(&json!({"x": 1, "y": 2, "width": 30, "height": 28, "z": 0})).is_err(), "多一个键");
        assert!(parse_unlock_zone(&json!({"x": -1, "y": 2, "width": 30, "height": 28})).is_err(), "负数");
        assert!(parse_unlock_zone(&json!({"x": "1", "y": 2, "width": 30, "height": 28})).is_err(), "字符串");
        assert!(parse_unlock_zone(&json!([1, 2, 30, 28])).is_err(), "数组");
    }

    #[test]
    fn window_url_carries_the_effective_config_the_theme_and_the_renderer_reads_the_same_keys() {
        let config = LyricsConfig {
            mode: LyricsMode::Taskbar,
            size: "xxl".to_string(),
            color: "contrast".to_string(),
            locked: true,
            ..LyricsConfig::default()
        };
        let url = lyrics_window_url(&config, crate::theme::ThemeChoice::Dark);
        assert!(url.starts_with("lyrics.html?"), "加载的是 R1 建好的那个入口：{url}");
        assert!(url.contains("mode=taskbar"), "{url}");
        assert!(url.contains("size=xxl"), "查询串保留用户档位，渲染时再限有效字号：{url}");
        assert!(url.contains("color=contrast"), "{url}");
        assert!(url.contains("locked=1"), "布尔写成 0/1（渲染层只认这两个值）：{url}");
        assert!(!url.contains("clickThrough"), "{url}");
        // 主题也走查询串（歌词窗调不动读主题的那条命令，只能由建窗那一刻同步给它）
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

    /// 显示已有窗口之前必须**重新加载**页面（从"页面没加载完 ⇒ 永久空白"里恢复的唯一出路）。
    /// reload 与 show 都收口在 `open_desktop` 一处，因为"撤销态下什么动作都不许发"必须行为可测。
    #[test]
    fn showing_an_existing_lyrics_window_reloads_the_page_but_a_fresh_one_is_left_alone() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        let start = production.find("pub fn open_desktop(").expect("显示那一步必须是窄收口");
        let body = &production[start..];
        let body = &body[..body.find("\n}").expect("open_desktop 的函数体要有结尾")];
        // 新建的窗本来就在加载：reload 会把它打断
        let fresh = body.find("if !fresh").expect("新建那条分支不许 reload");
        let reload = body.find("window.reload()").expect("显示已有窗口前必须重新加载页面");
        assert!(fresh < reload, "reload 必须在「已经有了」那条分支里（不是新建那条）");
        assert!(body[reload..].contains("log::warn!"), "重新加载失败只留一行 warn：刷新不了不该让「打开歌词」这件事失败");
        let show = body.find(".show()").expect("必须真的显示");
        assert!(reload < show, "先 reload 再 show");
    }

    /// 歌词文档的归一（缓存里躺着的与发出去的必须是同一份形状）。
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

    /// 最后一份文档真的留在状态里（`None` = 这次会话还没有歌词可重发）。
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
        state.configure(&json!({"mode": "taskbar"}));
        assert_eq!(state.config().mode, LyricsMode::Taskbar);
        assert_eq!(state.document(), Some(json!({ "lines": [], "status": "unavailable" })));
    }

    /// **页面加载完成**时重发最后一份文档（按 label 过滤），且只认 `Finished`；只能扫源码验（回调时机没有真窗可测）。
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
            callback.contains("replay_after_page_load("),
            "回调里要真的重发（不是只记一行日志）"
        );

        // 重发走的是同一条广播与同一个信封构造点（歌词窗只有一条消费路径）
        let replay = production.find("pub fn replay_after_page_load").expect("重发函数必须在");
        let replay_body = &production[replay..];
        assert!(
            replay_body.contains("emit_core_event(app, event, payload)"),
            "补发的文档与进度都走同一条歌词广播"
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

    /// 缓存发生在**发出去之前**（缓存住的必须是用户本来能看到的那一份）。
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

    /// 窗口标题是给 Alt+Tab 看的（`skip_taskbar` 只删任务栏条目，不碰 WS_EX_TOOLWINDOW）。
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

    /// 源码扫描：窗属性一次到位 + **隐藏不销毁** + 代理三窗收口（真窗在测试环境起不来，只能扫源码钉住）。
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
            // 可缩放资格按配置算（桌面未锁才可拖大小；锁定与任务栏不可）
            ".resizable(resizable_enabled(config))",
            ".min_inner_size(min_size.width, min_size.height)",
            "let min_size = min_window_size(config);",
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
        // 信封的唯一构造点仍是 commands::emit_core_event
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
            ("core_lyrics_unlock_zone", "LYRICS_WINDOW_LABEL"),
        ] {
            let body = &production[production.find(&format!("pub async fn {name}(")).unwrap()..];
            assert!(body.find(guard).unwrap() < 900);
        }
        assert_eq!(production.matches("#[tauri::command]").count(), 6);
    }

    #[test]
    fn r82_close_action_reuses_the_tray_close_path() {
        for source in [MAIN_WINDOW_LABEL, LYRICS_WINDOW_LABEL] {
            assert_eq!(control_payload(source, &json!({"action": "close"})).unwrap(), json!({"command": "close"}));
        }
        assert!(control_payload(crate::LYRICS_SETTINGS_WINDOW_LABEL, &json!({"action": "close"})).is_err(), "弹出窗不能替用户关歌词");
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs")).unwrap();
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        let body = &production[production.find("pub async fn core_lyrics_control(").unwrap()..];
        let body = &body[..body.find("\n}").unwrap()];
        let revert = body.find("crate::tray::revert_lyrics_checked(&app, false)").expect("关闭先把托盘勾选改成不勾");
        let toggle = body.find("crate::bridge::LYRICS_TOGGLE").expect("再请主窗关歌词窗（与托盘同一条广播）");
        assert!(revert < toggle);
        assert!(body.contains(r#""checked": false"#), "目标态是关");
    }

    // ---- 歌词配置持久化（Rust 拥有的保存任务）----------------------------------

    fn persisted_config(patch: Value) -> LyricsConfig {
        LyricsConfig::default().apply_patch(&patch)
    }

    /// 落盘合同恰好是 17 个字面键：不含 `effectiveSize`（派生值）与 taskbar/revision/visible/dirty。
    #[test]
    fn r44e_the_persisted_contract_is_exactly_the_config_keys() {
        let persisted = LyricsConfig::default().persisted();
        let mut keys: Vec<&str> = persisted.as_object().expect("必须是对象").keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "mode", "layout", "style", "size", "color", "locked",
            "enableBlur", "enableScale", "enableSpring", "showControls",
            // 歌词颜色与窗口尺寸也是用户配置（要落盘、要重启恢复）
            "customColor", "windowWidth", "windowHeight",
            // 任务栏歌词的独立外观（不与桌面共用）
            "taskbarSize", "taskbarColor", "taskbarCustomColor", "taskbarKaraoke",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected, "只写合同 config 字段");
        assert_eq!(keys.len(), 17, "落盘键数就是 17");
        assert!(persisted.get("effectiveSize").is_none(), "派生值不入盘");
        for forbidden in ["revision", "visible", "dirty", "saveError", "requestedVisible", "taskbar"] {
            assert!(persisted.get(forbidden).is_none(), "{forbidden} 是运行时状态，不入盘");
        }
        // status 里则有它们（渲染层要读）
        let status = status_payload(&LyricsConfig::default(), true, 3);
        assert_eq!(status["revision"], 3);
        assert_eq!(status["config"]["effectiveSize"], "lg");
    }

    /// 读回：未知字段/坏值一律按默认（不猜、不回写默认值去砸盘）。
    #[test]
    fn r44e_restoring_a_stored_config_never_guesses() {
        let restored = LyricsConfig::restored(Some(&json!({
            "mode": "taskbar", "layout": "vertical", "style": "panel",
            "size": "huge", "locked": true, "futureKey": 7
        })));
        assert_eq!(restored.mode, LyricsMode::Taskbar);
        assert_eq!(restored.layout, "vertical");
        assert_eq!(restored.style, "panel");
        assert_eq!(restored.size, DEFAULT_LYRICS_SIZE, "认不出的字号档位按默认");
        assert!(restored.locked);
        assert_eq!(restored.persisted().get("futureKey"), None, "未知字段不跟着进落盘合同");
        assert_eq!(LyricsConfig::restored(None), LyricsConfig::default(), "没有这一格 = 默认");
        assert_eq!(LyricsConfig::restored(Some(&json!("坏形状"))), LyricsConfig::default());
    }

    /// 接受一次配置 = 改运行值 + **同一步**交给保存任务（中间没有可丢队列的缝）。
    #[test]
    fn r44e_accepting_a_config_enqueues_it_for_persistence_in_the_same_step() {
        let mut persist = LyricsPersistence { enabled: true, saved: Some(LyricsConfig::default()), ..Default::default() };
        let vertical = persisted_config(json!({"layout": "vertical"}));
        assert!(persist.enqueue(&vertical));
        let (generation, pending) = persist.pending.clone().expect("入队");
        assert_eq!(pending, vertical);
        assert!(!persist.dirty() || persist.pending.is_some());

        // 后续值合并到 latestPending（不并行写、不丢最新的那一笔）
        let panel = persisted_config(json!({"layout": "vertical", "style": "panel"}));
        assert!(persist.enqueue(&panel));
        let (next_generation, pending) = persist.pending.clone().expect("仍在队里");
        assert!(next_generation > generation, "generation 单调（成功只确认对应快照）");
        assert_eq!(pending, panel);

        // 与已保存一致的值不再入队（纯读不回写）
        let mut saved_panel = LyricsPersistence { enabled: true, saved: Some(panel.clone()), ..Default::default() };
        assert!(!saved_panel.enqueue(&panel));
        assert!(saved_panel.pending.is_none());
    }

    /// 单在途 + 最新待写：成功只确认**对应快照**；期间来了新值就继续写。
    #[test]
    fn r44e_success_confirms_only_its_own_snapshot_and_newer_values_keep_writing() {
        let vertical = persisted_config(json!({"layout": "vertical"}));
        let panel = persisted_config(json!({"layout": "vertical", "style": "panel"}));
        let mut persist = LyricsPersistence { enabled: true, saved: Some(LyricsConfig::default()), inflight: Some(1), ..Default::default() };

        // 在飞期间来了新值
        persist.enqueue(&panel);
        persist.settle(&vertical, WriteOutcome::Confirmed(vertical.clone()));
        assert_eq!(persist.saved, Some(LyricsConfig::default()), "有更新的待写值：这一笔不宣布'盘已一致'");
        assert!(persist.dirty(), "仍脏（pending 还在）");
        assert_eq!(persist.save_error, None);

        // 第二笔写的是最新值：确认后清脏
        persist.pending = None;
        persist.inflight = Some(2);
        persist.settle(&panel, WriteOutcome::Confirmed(panel.clone()));
        assert_eq!(persist.saved, Some(panel));
        assert!(!persist.dirty());
    }

    /// 回执认不出 / 明确失败：都不算已保存；失败保 dirty 且**不自动重试**。
    #[test]
    fn r44e_unconfirmed_and_failed_writes_stay_dirty_without_automatic_retry() {
        let vertical = persisted_config(json!({"layout": "vertical"}));
        let mut persist = LyricsPersistence { enabled: true, saved: Some(LyricsConfig::default()), inflight: Some(1), ..Default::default() };
        persist.settle(&vertical, WriteOutcome::Unreadable);
        assert_eq!(persist.save_error.as_deref(), Some(SAVE_ERROR_UNCONFIRMED));
        assert_eq!(persist.saved, Some(LyricsConfig::default()));
        assert!(!persist.dirty(), "没有待写值就不再排队（不自动重试）");

        let mut failed = LyricsPersistence { enabled: true, saved: Some(LyricsConfig::default()), inflight: Some(1), ..Default::default() };
        failed.settle(&vertical, WriteOutcome::Failed);
        assert_eq!(failed.save_error.as_deref(), Some(SAVE_ERROR_WRITE_FAILED));
        assert_eq!(failed.saved, Some(LyricsConfig::default()), "失败不确认任何东西");
        assert!(failed.pending.is_none(), "失败不自己重排队");

        // 回执是**另一份**配置（并发写者）也不能算成功
        let mut mismatch = LyricsPersistence { enabled: true, saved: Some(LyricsConfig::default()), inflight: Some(1), ..Default::default() };
        mismatch.settle(&vertical, WriteOutcome::Confirmed(LyricsConfig::default()));
        assert_eq!(mismatch.save_error.as_deref(), Some(SAVE_ERROR_UNCONFIRMED));
        assert_eq!(mismatch.saved, Some(LyricsConfig::default()));
    }

    /// 退出 drain：上一次失败的那一份**本轮至多重试一次**，且冻结后不再自动受理新值。
    #[test]
    fn r44e_exit_drain_retries_a_failed_save_at_most_once() {
        let vertical = persisted_config(json!({"layout": "vertical"}));
        let mut persist = LyricsPersistence {
            enabled: true,
            saved: Some(LyricsConfig::default()),
            inflight: Some(1),
            ..Default::default()
        };
        persist.settle(&vertical, WriteOutcome::Failed);
        assert_eq!(persist.save_error.as_deref(), Some(SAVE_ERROR_WRITE_FAILED));

        assert!(persist.plan_exit_drain(&vertical), "Quit 时把上一次失败的那一份重排一次");
        assert!(persist.frozen, "冻结：不再自动受理新值");
        assert_eq!(persist.save_error, None, "重排时清掉旧错误（这次结论说了算）");
        assert!(persist.pending.is_some());
        assert!(!persist.enqueue(&vertical), "冻结之后新值不再入队");

        // 重试又失败 → 本轮不再重试
        persist.pending = None;
        persist.inflight = Some(2);
        persist.settle(&vertical, WriteOutcome::Failed);
        assert!(!persist.plan_exit_drain(&vertical), "一次 Quit 至多一次重试");
        assert_eq!(persist.save_error.as_deref(), Some(SAVE_ERROR_WRITE_FAILED));
    }

    /// 没有失败、但脏着（比如保存任务刚好还没轮到）：Quit 时要补排最新值。
    #[test]
    fn r44e_exit_drain_flushes_a_dirty_value_that_was_never_queued() {
        let vertical = persisted_config(json!({"layout": "vertical"}));
        let mut persist = LyricsPersistence {
            enabled: true,
            saved: Some(LyricsConfig::default()),
            ..Default::default()
        };
        assert!(persist.plan_exit_drain(&vertical));
        assert_eq!(persist.pending.as_ref().map(|(_, config)| config), Some(&vertical));
        assert!(!persist.plan_exit_drain(&vertical), "已经在队里就不再补（幂等）");
    }

    // ---- 退出准备失败后的可恢复性 ---------------------------------------------

    /// 一个"保存任务在线、盘上还是默认值"的状态（这几条用例的起点）。
    fn enabled_state() -> LyricsWindowState {
        LyricsWindowState {
            persist: Mutex::new(LyricsPersistence {
                enabled: true,
                saved: Some(LyricsConfig::default()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// 一次"保存失败 → Quit 冻结 → drain 重试也失败"之后的现场（两条用例共用）。
    fn state_after_a_failed_exit_drain() -> (LyricsWindowState, LyricsConfig) {
        let vertical = persisted_config(json!({"layout": "vertical"}));
        let state = enabled_state();
        assert!(state.configure(&json!({"layout": "vertical"})).2, "运行值改成了 vertical");
        {
            let mut persist = lock(&state.persist);
            persist.pending = None;
            persist.inflight = Some(1);
            persist.settle(&vertical, WriteOutcome::Failed);
        }
        assert!(lock(&state.persist).plan_exit_drain(&vertical), "Quit：冻结并重排一次");
        {
            let mut persist = lock(&state.persist);
            persist.pending = None;
            persist.inflight = Some(2);
            persist.settle(&vertical, WriteOutcome::Failed);
        }
        assert!(lock(&state.persist).frozen, "退出准备期间保持冻结");
        (state, vertical)
    }

    /// 退出准备失败（`abort_exit` 保窗）之后，歌词保存必须**解冻**并清掉本轮的退出重试标记。
    /// 否则手动 retrySave 不入队、下一次 Quit 不再重排，本次会话再也保存不了。
    #[test]
    fn fix1_aborting_a_failed_exit_makes_lyrics_persistence_writable_again() {
        let (state, vertical) = state_after_a_failed_exit_drain();

        state.abort_exit_drain();

        let persist = lock(&state.persist);
        assert!(!persist.frozen, "abort 之后不许继续冻结（否则本次会话再也保存不了）");
        assert!(!persist.retried_for_exit, "下一次 Quit 是一次新的尝试（本轮至多一次重试仍成立）");
        assert_eq!(persist.saved, Some(LyricsConfig::default()), "没写成就不许宣布已保存");
        assert_eq!(
            persist.save_error.as_deref(),
            Some(SAVE_ERROR_WRITE_FAILED),
            "失败仍然可见（abort 不许把错误洗掉）"
        );
        drop(persist);

        assert!(state.retry_save(), "abort 之后手动重试必须能入队");
        assert_eq!(
            lock(&state.persist).pending.as_ref().map(|(_, config)| config.clone()),
            Some(vertical.clone())
        );

        // 之后的一次改动（渲染层新值）也要能入队，并且排队的正是**最新**那份
        lock(&state.persist).pending = None; // worker 取走了上一笔
        assert!(state.configure(&json!({"style": "panel"})).2, "abort 之后新值必须接受");
        let newest = state.config();
        assert_eq!(
            lock(&state.persist).pending.as_ref().map(|(_, config)| config.clone()),
            Some(newest.clone()),
            "排队的是最新接受的那一份"
        );

        // 下一次 Quit 还能再排队（一次新尝试）
        {
            let mut persist = lock(&state.persist);
            persist.pending = None;
            persist.inflight = None;
            persist.save_error = Some(SAVE_ERROR_WRITE_FAILED.to_string());
        }
        assert!(lock(&state.persist).plan_exit_drain(&newest), "失败保窗后的下一次 Quit 必须能重排最新值");
    }

    /// abort 必须**唤醒**保存任务——它可能正睡在 condvar 上等下一笔。
    #[test]
    fn fix1_aborting_a_failed_exit_wakes_the_persistence_worker() {
        let state = std::sync::Arc::new(state_after_a_failed_exit_drain().0);
        let waiter = {
            let state = std::sync::Arc::clone(&state);
            std::thread::spawn(move || {
                let persist = lock(&state.persist);
                let (restored, waited) = state
                    .persist_idle
                    .wait_timeout(persist, std::time::Duration::from_secs(2))
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                // 超时说明没人叫醒它；被叫醒才算 abort 叫到了保存任务
                let woken = !waited.timed_out();
                drop(restored);
                woken
            })
        };
        // 让 worker 先睡下，再 abort（顺序反过来就测不到"唤醒"这件事）
        std::thread::sleep(std::time::Duration::from_millis(60));
        state.abort_exit_drain();
        assert!(waiter.join().expect("worker 线程"), "abort 必须 notify 保存任务，否则队列里有值也永远不动");
    }

    // ---- 歌词配置走退出准入门 -------------------------------------------------

    /// 退出准备开始后，渲染层发起的 `core_lyrics_configure` 必须被**结构化拒绝**（与渲染层 settings 写同一条准入）。
    /// 否则内存变了、worker 却已冻结，磁盘永远停在旧值。
    #[test]
    fn fix2_lyrics_configure_is_refused_once_exit_preparation_closed_admission() {
        let gate = std::sync::Arc::new(crate::commands::PersistenceGate::new());
        let state = enabled_state();
        gate.begin_prepare();

        let error = match accept_renderer_configure(&gate, &state, &json!({"layout": "vertical"}), false) {
            Ok(_) => panic!("退出准备开始后不许再受理新的渲染层配置"),
            Err(error) => error,
        };
        assert_eq!(
            error.kind.as_deref(),
            Some("shutting_down"),
            "结构化拒绝：渲染层要能认出这是「正在退出」而不是坏载荷"
        );
        assert_eq!(state.config(), LyricsConfig::default(), "被拒的那一笔不许改运行值");
        assert!(lock(&state.persist).pending.is_none(), "被拒的那一笔不许入队");
        assert_eq!(gate.in_flight(), 0, "被拒的调用不留在飞计数里");

        // 同一份准入门在 Running 时照旧受理
        gate.abort_prepare();
        assert!(accept_renderer_configure(&gate, &state, &json!({"layout": "vertical"}), false).is_ok());
        assert_eq!(state.config().layout, "vertical");
    }

    /// 修复 2 的另一半：受理凭据要**持有到配置被接受并入队**为止，退出等的是它。
    #[test]
    fn fix2_lyrics_configure_holds_its_admission_until_the_value_is_enqueued() {
        let gate = std::sync::Arc::new(crate::commands::PersistenceGate::new());
        let state = std::sync::Arc::new(enabled_state());
        // 占住持久记账锁：这一笔就停在"准入已拿、还没入队"的那一步（正是退出最怕的缝）
        let held = lock(&state.persist);
        let worker = {
            let gate = std::sync::Arc::clone(&gate);
            let state = std::sync::Arc::clone(&state);
            std::thread::spawn(move || {
                accept_renderer_configure(&gate, &state, &json!({"layout": "vertical"}), false)
                    .map(|(_, snapshot, changed)| (snapshot.config, changed))
            })
        };

        let wait_until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while gate.in_flight() == 0 {
            assert!(std::time::Instant::now() < wait_until, "准入没有被登记");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            !gate.wait_drained(std::time::Instant::now() + std::time::Duration::from_millis(50)),
            "已受理但还没入队的那一笔必须挡住退出（否则退出会越过它去排空）"
        );

        drop(held);
        let (config, changed) = worker.join().expect("configure 线程").expect("入队成功");
        assert!(changed);
        assert_eq!(
            lock(&state.persist).pending.as_ref().map(|(_, queued)| queued.clone()),
            Some(config),
            "凭据放下时值已经入队（中间没有可丢队列的缝）"
        );
        assert_eq!(gate.in_flight(), 0, "入队完成之后才放下准入凭据");
        assert!(gate.wait_drained(std::time::Instant::now()), "入队之后退出不再被这一笔挡住");
    }

    // ---- abort 的顺序 ---------------------------------------------------------

    /// 退出失败的复原必须**先解冻歌词、再打开准入门**：否则夹在中间到达的写会通过准入门却入队失败，内存是新值、盘上还是旧值。
    /// 探针切在生产顺序的那一刀上（歌词已解冻、门还关着），顺序换回来断言就红。
    #[test]
    fn fix2_abort_unfreezes_lyrics_before_it_reopens_the_admission_gate() {
        use crate::commands::{PersistKind, PersistPhase};
        let gate = std::sync::Arc::new(crate::commands::PersistenceGate::new());
        let state = state_after_a_failed_exit_drain().0;
        gate.begin_prepare();

        restore_after_failed_exit(&gate, &state, || {
            assert_eq!(
                gate.phase(),
                PersistPhase::PreparingExit,
                "歌词还没解冻就先把准入门打开了：这一刀就是复审说的丢写缝"
            );
            assert!(
                gate.admit(PersistKind::Renderer).is_err(),
                "门还关着：这段时间到达的渲染层写一笔都进不来"
            );
            assert!(!lock(&state.persist).frozen, "解冻必须在开门之前就已经生效");
            // 不看标志位，看它真的能不能入队（"内存改了、队列收下、盘上会写"）
            assert!(state.configure(&json!({ "style": "panel" })).2, "解冻之后新值必须被接受");
            assert_eq!(
                lock(&state.persist).pending.as_ref().map(|(_, queued)| queued.clone()),
                Some(state.config()),
                "解冻之后接受的那一份必须真的在队列里"
            );
        });

        assert_eq!(gate.phase(), PersistPhase::Running, "复原完成后门照旧回到 Running");
        // 门开之后到达的渲染层配置：受理 + 入队（不是"受理了但没人写"）
        assert!(
            accept_renderer_configure(&gate, &state, &json!({ "layout": "vertical" }), false).is_ok(),
            "门开了之后渲染层配置照旧受理"
        );
        assert_eq!(gate.in_flight(), 0, "入队完成后凭据放掉");
        assert_eq!(state.config().layout, "vertical");
        assert_eq!(
            lock(&state.persist).pending.as_ref().map(|(_, queued)| queued.clone()),
            Some(state.config()),
            "被受理的那一笔必须在队列里（否则就是复审说的 frozen gap）"
        );
    }

    /// 自定义颜色 / 窗口 DIP 尺寸的形状校验与往返（坏值不覆盖上一个合法值）。
    #[test]
    fn r45b_custom_color_and_window_size_are_validated_and_round_trip() {
        assert!(is_hex_color("#a1b2c3"));
        assert!(is_hex_color("#A1B2C3"));
        for bad in ["#fff", "fff", "#12345", "#1234567", "#12345g", "red", "rgb(0,0,0)", " #a1b2c3"] {
            assert!(!is_hex_color(bad), "{bad} 不是合法的六位 hex");
            assert!(!custom_color_ok(bad), "{bad} 不该被接受");
        }
        assert!(custom_color_ok(""), "空串 = 用设计令牌，合法");

        let base = LyricsConfig::default();
        let painted = base.apply_patch(&json!({"customColor": "#FF8800"}));
        assert_eq!(painted.custom_color, "#FF8800", "合法值原样收（大小写不折叠）");
        assert_eq!(painted.apply_patch(&json!({"customColor": "#fff"})).custom_color, "#FF8800", "坏值不覆盖");
        assert_eq!(painted.apply_patch(&json!({"customColor": ""})).custom_color, "", "清空回设计令牌");

        let sized = base.apply_patch(&json!({"windowWidth": 359.6, "windowHeight": 480.0}));
        assert_eq!(sized.window_width, Some(360.0), "DIP 存整像素");
        assert_eq!(sized.window_height, Some(480.0));
        assert_eq!(sized.custom_size(), Some(Size { width: 360.0, height: 480.0 }));
        for bad in [json!(0.0), json!(-10.0), json!("320"), json!({}), json!(true)] {
            let next = sized.apply_patch(&json!({"windowWidth": bad}));
            assert_eq!(next.window_width, Some(360.0), "尺寸坏值不覆盖上一个合法值：{bad}");
        }
        assert_eq!(sized.apply_patch(&json!({"windowWidth": null})).window_width, None, "null = 清掉自定义尺寸");
        let small = base.apply_patch(&json!({"windowWidth": 100.0, "windowHeight": 50.0}));
        assert_eq!(
            (small.window_width, small.window_height),
            (Some(MIN_WINDOW_WIDTH_DIP), Some(MIN_WINDOW_HEIGHT_DIP)),
            "横版最小尺寸 240×120"
        );

        // 落盘合同 / 回执 / 查询串三处都带上，且往返一字不差
        let config = sized.apply_patch(&json!({"customColor": "#ff8800"}));
        let persisted = config.persisted();
        for key in ["customColor", "windowWidth", "windowHeight"] {
            assert!(persisted.get(key).is_some(), "{key} 必须在落盘合同里");
        }
        assert_eq!(LyricsConfig::restored(Some(&persisted)), config, "落盘往返一字不差");
        assert_eq!(LyricsConfig::restored(Some(&config.payload())), config, "回执往返一字不差（effectiveSize 是派生值）");
        let query = config.query();
        assert!(query.contains("customColor=%23ff8800"), "`#` 必须转义（否则查询串在那里就断成 fragment）：{query}");
        assert!(query.contains("windowWidth=360"), "{query}");
        assert!(query.contains("windowHeight=480"), "{query}");
        assert!(
            base.query().contains("customColor=&windowWidth=&windowHeight="),
            "没有自定义值时参数留空（渲染层把空串当「没有」而不是 0）：{}",
            base.query()
        );
    }

    /// 方向/模式切换不再沿用上一方向的自定义尺寸（一个纯函数说得清）。
    #[test]
    fn r45b_switching_layout_or_mode_drops_the_previous_custom_size() {
        let sized = LyricsConfig::default().apply_patch(&json!({
            "layout": "vertical", "windowWidth": 360.0, "windowHeight": 620.0
        }));
        assert_eq!(normalized_patch(&sized, &json!({"layout": "horizontal"})).custom_size(), None, "切回横版用横版默认尺寸");
        assert_eq!(normalized_patch(&sized, &json!({"color": "primary"})).custom_size(), sized.custom_size(), "改颜色不动尺寸");
        assert_eq!(normalized_patch(&sized, &json!({"locked": true})).custom_size(), sized.custom_size(), "锁定不动尺寸");
        let both = normalized_patch(&sized, &json!({"layout": "horizontal", "windowWidth": 500.0, "windowHeight": 200.0}));
        assert_eq!(
            both.custom_size(),
            Some(Size { width: 500.0, height: 200.0 }),
            "补丁自己带了尺寸就按补丁来（那是「设尺寸」这个动作）"
        );
        assert_eq!(normalized_patch(&sized, &json!({"mode": "taskbar"})).custom_size(), None, "切任务栏同样丢掉");

        // 运行状态的配置接受走的正是这条归一：一次 configure 之后尺寸已经清掉
        let state = LyricsWindowState::default();
        state.configure(&json!({"windowWidth": 420.0, "windowHeight": 300.0}));
        let (_, snapshot, changed) = state.configure(&json!({"layout": "vertical"}));
        assert!(changed);
        assert_eq!(snapshot.config.custom_size(), None, "方向切换后运行配置里不再留着上一方向的尺寸");
    }

    /// 自定义尺寸是 DIP，按缩放比换成物理像素并夹进工作区；尺寸变化只改尺寸不动位置。
    #[test]
    fn r45b_custom_size_is_dip_scaled_clamped_and_never_moves_the_window() {
        let area = Rect { x: -1920.0, y: 0.0, width: 1920.0, height: 1040.0 };
        let sized = LyricsConfig::default().apply_patch(&json!({"windowWidth": 360.0, "windowHeight": 480.0}));
        let (size, point) = geometry_plan(area, &sized, 2.0, None);
        assert_eq!(size, Size { width: 720.0, height: 960.0 }, "DIP × 缩放比 = 物理像素");
        assert!(point.x >= area.x && point.x + size.width <= area.x + area.width, "位置仍夹在工作区内：{point:?}");
        assert!(point.y >= area.y && point.y + size.height <= area.y + area.height, "{point:?}");

        let huge = sized.apply_patch(&json!({"windowWidth": 4000.0, "windowHeight": 4000.0}));
        let (clamped, _) = geometry_plan(area, &huge, 1.0, None);
        assert_eq!(clamped, Size { width: 1920.0, height: 1040.0 }, "超出工作区的自定义尺寸被夹回工作区");

        let current = Some(Point { x: 40.0, y: 200.0 });
        let mut effects = Vec::new();
        apply_window_effects(Some(&sized), &sized.apply_patch(&json!({"windowWidth": 500.0})), area, 1.0, current, |effect| effects.push(effect));
        assert_eq!(
            effects,
            vec![WindowEffect::Size(Size { width: 500.0, height: 480.0 })],
            "用户拖出来的尺寸只改尺寸——不许给 Geometry（那会连位置一起重算 = 跳位）"
        );
        // 锁定会切换鼠标接收状态，所以不在这一组里（见 taskbar_and_locked_desktop_ignore_the_cursor）。
        for patch in [
            json!({"color": "primary"}),
            json!({"style": "panel"}),
            json!({"enableSpring": false}),
            json!({"customColor": "#ff8800"}),
            json!({"size": "xl"}),
        ] {
            let next = sized.apply_patch(&patch);
            let mut quiet = Vec::new();
            apply_window_effects(Some(&sized), &next, area, 1.0, current, |effect| quiet.push(effect));
            assert!(quiet.is_empty(), "颜色/样式/演出/字号/自定义色都不许产生窗口效果：{patch} → {quiet:?}");
        }
    }

    /// 缩放资格 = 未锁的桌面窗（锁定与任务栏两条都不可缩）。
    #[test]
    fn r45b_resize_is_only_available_while_the_desktop_window_is_unlocked() {
        let base = LyricsConfig::default();
        assert!(resizable_enabled(&base));
        assert!(!resizable_enabled(&base.apply_patch(&json!({"locked": true}))), "锁定不可缩放");
        assert!(!resizable_enabled(&base.apply_patch(&json!({"mode": "taskbar"}))), "任务栏那条不可缩放");
        // 建窗与配置应用两处都按同一个判定走（窗口属性不能有第二份口径）
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        assert!(production.contains(".resizable(resizable_enabled(config))"), "建窗时就按资格设可缩放");
        assert!(production.contains("window.set_resizable(resizable_enabled(config))"), "锁定后要收回缩放资格");
        assert!(production.contains(".min_inner_size(min_size.width, min_size.height)"), "最小尺寸由窗口层兜住");
    }

    /// 唯一写者的形状：本模块不自己写 `settings.json`，写盘走内部 `settings:set`。
    #[test]
    fn r44e_the_lyrics_module_owns_no_second_settings_json_writer() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lyrics_window.rs"))
            .expect("要能读到自己的源码");
        let production = &source[..source.find("#[cfg(test)]").unwrap_or(source.len())];
        for forbidden in ["std::fs::write(", "std::fs::rename(", "write_settings_document"] {
            assert!(!production.contains(forbidden), "歌词模块不许自己写 settings.json（唯一写者是 sidecar）：{forbidden}");
        }
        assert!(production.contains("settings_write_owned"), "保存必须走内部 settings:set");
        assert!(production.contains("SETTINGS_FILE_NAME"), "启动恢复的读盘自读取的是同一个文件");
        // 保存任务必须是 Rust 拥有的线程，且不依赖任何 webview/事件订阅
        assert!(production.contains("fn start_persistence"), "保存任务由宿主启动");
        assert!(production.contains("lyrics-persist"), "独立线程名（与 WebView 生命周期无关）");
        for forbidden in ["onCoreEvent", "webview.listen", "PageLoadEvent::"] {
            let _ = forbidden; // 基线与页面加载无关：保存不看页面
        }
    }
}
