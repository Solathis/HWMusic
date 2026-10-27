//! 登录页宿主：华为官方授权页是主窗里的第二个子 webview（`add_child`，不是独立窗口）。
//! 不向官方页执行任何脚本，白名单与回调只靠导航事件观测；`hms://` 一律拦下、原样交给 Node 侧判断，
//! 白名单条目与 `src/protocols/login-callback.mjs` 保持一致。
//! 每次登录用随机 `partition` + 独立数据目录，收场后清除。
//! 已知缺口：wry 0.57 没有帧级 `NavigationStarting`，iframe 内发起的 `hms://` 看不到，由总期限兜底。
//! `add_child` 依赖 tauri 的 `unstable` feature（`Cargo.toml` 已开）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Manager, Webview, WebviewUrl};

use crate::bridge::{CoreError, CoreShared, Effect, APP_NOTICE};
use crate::{MAIN_WINDOW_LABEL, WebviewDataRoot};

/// 登录页那个 webview 的 label（它是主窗的子 webview，不再是窗口）。
/// `capabilities/main.json` 故意不列它（官方页零命令权限），而命令层只能靠它与 `main` 区分来源。
pub const LOGIN_WEBVIEW_LABEL: &str = "login";

/// 左上角那个「返回扫码登录」浮动控件的 label。
/// 它是主窗里的第三个 webview，建在登录页之后（后建的在 z 序上层）；盒子只取控件那么大——透明子窗照样吃鼠标。
pub const LOGIN_RETURN_WEBVIEW_LABEL: &str = "login-return";

/// 右上角那个主题控件（浅色 / 深色 / 跟随系统）浮动 webview 的 label。
pub const LOGIN_THEME_WEBVIEW_LABEL: &str = "login-theme";

/// 两个浮动控件的 label（顺序 = 建窗顺序 = 左右顺序；也是收尾时要关掉的全部）。
pub const LOGIN_CHROME_LABELS: [&str; 2] = [
    LOGIN_RETURN_WEBVIEW_LABEL,
    LOGIN_THEME_WEBVIEW_LABEL,
];

/// 浮动控件的本地页面（唯一真源 `src/shared/login-chrome.mjs`，Rust 镜像 + parity 测试互钉）。
pub const LOGIN_CHROME_ENTRY: &str = "login-chrome.html";
/// `?kind=` 的两个取值（同上，与渲染层的 `LOGIN_CHROME_KIND` 逐字相同）。
pub const LOGIN_CHROME_KIND_RETURN: &str = "return";
pub const LOGIN_CHROME_KIND_THEME: &str = "theme";

/// 浮动控件与主窗客户区边缘的距离（CSS 像素，按缩放比换算成物理像素）。
pub const CHROME_MARGIN: f64 = 8.0;
/// 「返回扫码登录」控件的盒子（CSS 像素：宽、高）：盒子就是控件本身那么大，再大就是白挡一块网页。
/// 渲染层那份是一个 `size="sm"` 的 shadcn Button 加 2px 内缩，留够六个字与内边距的余量。
pub const RETURN_CHROME_SIZE: (f64, f64) = (124.0, 34.0);
/// 主题控件的盒子（CSS 像素：宽、高）：三个小按钮 + 边框 + 内缩。
pub const THEME_CHROME_SIZE: (f64, f64) = (184.0, 34.0);

/// 浮动控件要加载的地址：`login-chrome.html?kind=…`（与渲染层的 `loginChromeUrl` 同一拼法）。
pub fn chrome_url(kind: &str) -> String {
    format!("{LOGIN_CHROME_ENTRY}?kind={kind}")
}

/// 总登录期限（秒）：与 Node `LOGIN_TIMEOUT_MS` 互钉（`LOGIN_TIMEOUT_SECS × 1000 == LOGIN_TIMEOUT_MS`）。
pub const LOGIN_TIMEOUT_SECS: u64 = 600;

/// 首载期限（秒）：官方页这么久都没加载完，多半是网络/代理问题，早点告诉用户比让他干等 10 分钟好。
pub const LOGIN_LOAD_DEADLINE_SECS: u64 = 30;

/// 首载超时文案（与 Node 侧 [`crate`] 的 `LOGIN_PAGE_UNAVAILABLE_MESSAGE` 逐字一致，parity 钉住）。
pub const LOGIN_LOAD_TIMEOUT_MESSAGE: &str = "无法打开华为官方登录页面，请检查网络或代理后重试。";

/// 总超时文案（与 Node 侧的 `LOGIN_TIMEOUT_MESSAGE` 逐字一致，parity 钉住）。
pub const LOGIN_TOTAL_TIMEOUT_MESSAGE: &str = "登录超时（10 分钟内未完成扫码），请重试。";

/// 并排第二次登录的提示（不并行开第二个登录页：只把既有那个拉到前台）。
pub const LOGIN_IN_PROGRESS_MESSAGE: &str = "已有一次登录正在进行（已把登录界面拉到前台）";

/// 回调 scheme 的镜像（Node 唯一真源是 `auth.mjs` 的 `OAUTH_REDIRECT_URI`）。
pub const CALLBACK_SCHEME: &str = "hms";

/// `partition` 的字符集与长度（进文件系统之前必须过这一关）。
pub const PARTITION_MAX_LEN: usize = 64;

/// 几何钳制下限：主窗被外部压到退化尺寸时也不交出负尺寸（`set_bounds` 会失败或建出畸形块）。
/// 只适用于"量得到但很小"的主窗；"量不到"那一档由 [`layout_for`] 挡在门外。
pub const MIN_LOGIN_HEIGHT: f64 = 160.0;
/// 几何钳制下限（宽），见 [`MIN_LOGIN_HEIGHT`]。
pub const MIN_LOGIN_WIDTH: f64 = 320.0;

/// 跟随主窗几何的轮询间隔。
/// 不订阅主窗 Resized：on_window_event 无法注销，每次登录都会多挂一个监听器。
const FOLLOW_TICK: Duration = Duration::from_millis(250);

/// 建登录页任务投到主线程后的等待上限（主线程若在忙，宁可结构化失败也不要永久挂住）。
const BUILD_TIMEOUT: Duration = Duration::from_secs(10);

/// 删目录的退避次数与基数（WebView2 释放用户数据目录有延迟，一把删不掉是常态）。
const DELETE_ATTEMPTS: u32 = 5;
const DELETE_BACKOFF_MS: u64 = 50;

/// 导航白名单的镜像（Node 侧唯一真源：`src/protocols/login-callback.mjs`）：显式条目表，不是 `*.huawei.com` 通配。
/// 授权域与令牌域是两个不同主机，`oauth-login1.cloud.huawei.com` 已降级为下面的精确例外。
pub const LOGIN_ALLOWED_ORIGINS: [&str; 5] = [
    "https://oauth-login.platform.hicloud.com", // 授权入口域（authorize 端点所在主机）
    "https://oauth-login.cloud.huawei.com", // 令牌兑换域（token 端点所在主机）
    // CAS 门户域：授权页拿到 `loginType = TICKET` 后跳到这里，拦下它页面就停在一个什么都没渲染的空壳上。
    // 端口 443 是默认端口，`Url::origin()` 归一化后不带端口，所以这一条同时覆盖 `:443` 的写法。
    "https://id1.cloud.huawei.com", // 华为帐号 CAS 门户域（授权页的落地页）
    "https://account.huawei.com", // 账号域（参考清单条目）
    "https://consumer.huawei.com", // 消费者域（参考清单条目）
];

/// 精确例外：扫码成功后回调落到这里，漏掉它就会卡在 CAS 页。
pub const LOGIN_ALLOWED_URLS: [&str; 1] = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"];

// ---------------------------------------------------------------------------
// 导航策略（纯函数）
// ---------------------------------------------------------------------------

/// 一次导航请求的处置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    /// `hms://`：**拦下不请求**，并把原样 URL 交给等待方（不清洗、不解析、不改写）
    Callback(String),
    /// 白名单内：放行
    Allow,
    /// 其余一律拦下（同形钓鱼域、降级 http、userinfo、非 443 端口、javascript: 等）
    Block,
}

impl Navigation {
    /// 日志用的词（不参与任何判定逻辑，只为了让日志能被人读）。
    pub fn log_label(&self) -> &'static str {
        match self {
            Navigation::Callback(_) => "callback",
            Navigation::Allow => "allow",
            Navigation::Block => "block",
        }
    }
}

/// 日志里 URL 的最大长度（字符数）：日志行不许被一个畸形 URL 撑爆。
pub const MAX_URL_LOG_CHARS: usize = 160;

/// 按字符截断（不是字节：中文/百分号编码都不能截出半个字符）。
fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 把一次导航/加载的 URL 变成可进日志的一行：`scheme://host/path` 原样保留，查询串只留参数名（最多 8 个）。
/// 授权页带着 `code_challenge` / `state`、回调带着 `code`，整段 URL 进日志就等于把一次性凭据抄进了日志文件。
pub fn describe_navigation_for_log(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return "(空 URL)".to_string();
    }
    let (head, query) = match text.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (text, None),
    };
    // `#` 之后是片段：保留 path 上的片段标记没意义，直接丢掉
    let head = head.split('#').next().unwrap_or(head);

    let mut described = head.to_string();
    if let Some(query) = query {
        let query = query.split('#').next().unwrap_or("");
        let parts: Vec<&str> = query.split('&').filter(|part| !part.is_empty()).collect();
        let names: Vec<&str> = parts
            .iter()
            .map(|part| part.split('=').next().unwrap_or(""))
            .filter(|name| !name.is_empty())
            .take(8)
            .collect();
        if !names.is_empty() {
            described.push('?');
            described.push_str(&names.join(","));
            if parts.len() > names.len() {
                described.push_str(",…");
            }
        }
    }
    truncate_chars(&described, MAX_URL_LOG_CHARS)
}

/// 抽 scheme：`hms://x` → `"hms"`；没有 `://` 就是空串（不是 URL 的形状）。
fn scheme_of(value: &str) -> &str {
    match value.find("://") {
        Some(index) => &value[..index],
        None => "",
    }
}

/// 导航白名单判定：`hms://` 最先看（它是回调不是页面，必须在 URL 解析之前拦下），再看 https 的显式条目。
/// https 只比 `origin`（含端口）与 `origin + path`，userinfo 显式拒——光比 origin 会误放行 `https://user@host/`。
pub fn navigation_for(raw: &str) -> Navigation {
    let value = raw.trim();
    if value.is_empty() {
        return Navigation::Block;
    }
    if scheme_of(value).eq_ignore_ascii_case(CALLBACK_SCHEME) {
        return Navigation::Callback(value.to_string());
    }

    let Ok(url) = tauri::Url::parse(value) else {
        return Navigation::Block;
    };
    if url.scheme() != "https" {
        return Navigation::Block;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Navigation::Block;
    }
    let origin = url.origin().ascii_serialization();
    if LOGIN_ALLOWED_ORIGINS.contains(&origin.as_str()) {
        return Navigation::Allow;
    }
    let exact = format!("{origin}{}", url.path());
    if LOGIN_ALLOWED_URLS.contains(&exact.as_str()) {
        return Navigation::Allow;
    }
    Navigation::Block
}

// ---------------------------------------------------------------------------
// 配置校验（纯函数；错误里绝不回显 url 原文）
// ---------------------------------------------------------------------------

/// 登录页配置（`host:open-login` 的 payload）。
#[derive(Debug, Clone, PartialEq)]
pub struct LoginConfig {
    /// 官方授权页 URL（必须 https 且在导航白名单内）
    pub url: String,
    /// 一次性随机分区（`[A-Za-z0-9_-]{1,64}`）：独立 webview 数据目录的目录名
    pub partition: String,
}

fn invalid_payload(message: impl Into<String>) -> CoreError {
    CoreError::new("invalid_payload", message)
}

/// 坏形态一律结构化 `invalid_payload`，且不复述入参内容——只说哪一条规则没过。
/// URL 里带着 `code_challenge` / `state`（回调还带 `code`），把原文打进错误消息或日志等于泄漏一次性凭据。
pub fn parse_config(payload: &Value) -> Result<LoginConfig, CoreError> {
    let object = payload
        .as_object()
        .ok_or_else(|| invalid_payload("登录页配置必须是 JSON 对象"))?;

    let url = match object.get("url") {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(_) => return Err(invalid_payload("url 必须是字符串")),
        None => return Err(invalid_payload("登录页配置缺少 url")),
    };
    if url.is_empty() {
        return Err(invalid_payload("url 不能为空"));
    }
    match navigation_for(&url) {
        Navigation::Allow => {}
        Navigation::Callback(_) => {
            return Err(invalid_payload(
                "url 必须是 https 的官方授权页（hms:// 是登录回调，不是登录页）",
            ))
        }
        Navigation::Block => {
            return Err(invalid_payload(
                "url 不在登录导航白名单内（必须 https，且主机是白名单里的显式条目）",
            ))
        }
    }

    let partition = match object.get("partition") {
        Some(Value::String(value)) => value.clone(),
        Some(_) => return Err(invalid_payload("partition 必须是字符串")),
        None => return Err(invalid_payload("登录页配置缺少 partition")),
    };
    if !partition_is_safe(&partition) {
        return Err(invalid_payload(format!(
            "partition 只接受 [A-Za-z0-9_-] 且长度 1..={PARTITION_MAX_LEN}（它要当目录名，越界写法一律拒）"
        )));
    }

    Ok(LoginConfig { url, partition })
}

/// `partition` 的字符集闸门：它要当目录名，所以只收 `[A-Za-z0-9_-]`，路径穿越在进文件系统之前就断掉。
pub fn partition_is_safe(partition: &str) -> bool {
    !partition.is_empty()
        && partition.len() <= PARTITION_MAX_LEN
        && partition
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 登录页 webview 的数据目录（与主窗数据根分开）：登录态、cookie、缓存都锁在一个一次性目录里，收场即删。
pub fn login_data_dir(data_root: &Path, partition: &str) -> PathBuf {
    data_root.join("webview2").join("login").join(partition)
}

// ---------------------------------------------------------------------------
// 双期限与结论
// ---------------------------------------------------------------------------

/// 一次登录尝试的收场结论（四收场 + 首载失败）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginConclusion {
    /// 拿到 `hms://` 回调（URL 原样带出，判真伪是 Node 侧的事）
    Callback { url: String },
    /// 用户/渲染层主动取消
    Cancelled,
    /// 登录页没了（应用退出 / 收尾先行；同窗宿主里用户没有可关的窗）
    Closed,
    /// 超过总期限
    TimedOut,
    /// 首载期限内没能打开官方页（网络/代理问题，文案与总超时不同）
    LoadFailed { message: String },
}

impl LoginConclusion {
    /// 线上 `status` 词表（Node `huawei.ts` 的 `HOST_LOGIN_STATUS` 按它分支；parity 钉住）。
    pub fn status(&self) -> &'static str {
        match self {
            LoginConclusion::Callback { .. } => "callback",
            LoginConclusion::Cancelled => "cancelled",
            LoginConclusion::Closed => "closed",
            LoginConclusion::TimedOut => "timed_out",
            LoginConclusion::LoadFailed { .. } => "load_failed",
        }
    }

    /// 交给 Node 的载荷：`{status}` +（回调时的）`url` /（失败时的）`message`。
    pub fn to_payload(&self) -> Value {
        match self {
            LoginConclusion::Callback { url } => json!({ "status": self.status(), "url": url }),
            LoginConclusion::TimedOut => json!({
                "status": self.status(),
                "message": LOGIN_TOTAL_TIMEOUT_MESSAGE,
            }),
            LoginConclusion::LoadFailed { message } => {
                json!({ "status": self.status(), "message": message })
            }
            LoginConclusion::Cancelled | LoginConclusion::Closed => json!({ "status": self.status() }),
        }
    }
}

/// 期限判定（纯函数）：此刻该结算成什么结论，`None` = 还该继续等。
/// 总超时优先：到了 [`LOGIN_TIMEOUT_SECS`] 一律判 [`LoginConclusion::TimedOut`]，不论首载是否成功。
pub fn deadline_conclusion(elapsed: Duration, loaded: bool) -> Option<LoginConclusion> {
    if elapsed >= Duration::from_secs(LOGIN_TIMEOUT_SECS) {
        return Some(LoginConclusion::TimedOut);
    }
    if !loaded && elapsed >= Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS) {
        return Some(LoginConclusion::LoadFailed {
            message: LOGIN_LOAD_TIMEOUT_MESSAGE.to_string(),
        });
    }
    None
}

// ---------------------------------------------------------------------------
// 屏外 → 内容区：切换网页登录时那一段加载动画。
// ---------------------------------------------------------------------------

/// 登录页此刻摆在哪一档：`Offscreen` 是建出来之后的初始档，静默窗走完或首载期限到才进 `InContent`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// 屏外（客户区左沿之外）：还在加载（或者刚又起了一次导航）
    Offscreen,
    /// 内容区里（铺满客户区）：跟随主窗几何
    InContent,
}

/// 屏外摆放的横向余量（物理像素）：整个矩形挪到客户区左沿之外，再留一点，免得贴边露一条。
pub const OFFSCREEN_MARGIN: f64 = 8.0;

/// 屏外矩形：同尺寸、`x` 挪到客户区左沿之外，`y` 保持目标值（摆进来时只动 `x`，一处到位）。
/// 用"挪到屏外"而不是 `Webview::hide`：隐藏的子 webview 是否照常加载各平台不一致，几何裁剪则到处一样。
pub fn offscreen_rect(target: Rect) -> Rect {
    let width = if target.width.is_finite() && target.width > 0.0 {
        target.width
    } else {
        0.0
    };
    Rect {
        x: -(width + OFFSCREEN_MARGIN),
        y: target.y,
        width: target.width,
        height: target.height,
    }
}

/// 静默窗长度：每次 `Finished` 之后这么久内没有新导航，才算"页面真的加载完了"。
/// 它量的是"两次导航之间有没有下一跳"（重定向链每一跳都在毫秒到数百毫秒级），而不是页面何时画完。
pub const LOGIN_QUIET_WINDOW_MS: u64 = 1_500;

/// 静默满一整个窗了吗？（纯函数）
pub fn quiet_window_passed(quiet_for: Duration) -> bool {
    quiet_for >= Duration::from_millis(LOGIN_QUIET_WINDOW_MS)
}

/// 该把登录页摆进内容区了吗：页面静默满一窗，或首载期限到——页面可能还在转，但对着转圈干等更糟。
/// 与 [`deadline_conclusion`] 互不影响：结论说"打不开"，摆放说"别藏着了"。
pub fn placement_due(page_quiet: bool, elapsed: Duration) -> bool {
    page_quiet || elapsed >= Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS)
}

/// 登录页没了是否该判 [`LoginConclusion::Closed`]：同窗宿主里用户没有可关的窗，页不在就如实判 Closed。
pub fn vanish_conclusion(webview_present: bool) -> Option<LoginConclusion> {
    if webview_present {
        None
    } else {
        Some(LoginConclusion::Closed)
    }
}

/// 一次登录尝试的结论槽（take-once）+ 首载标志 + 摆放状态：五个生产者共用一个槽，谁先到谁算、后到的返回 `false` 且不改写。
/// 静默起点与摆放标记由同一把 `SessionState` 锁护着——它们说的是同一件事的连续几步。
pub struct LoginSession {
    state: Mutex<SessionState>,
    changed: Condvar,
}

struct SessionState {
    conclusion: Option<LoginConclusion>,
    /// 首载完成（**整个登录期间只记第一次**）：解除首载期限，见 [`deadline_conclusion`]。
    loaded: bool,
    /// 最近一次 `Finished` 的时刻（`None` = 还没有 `Finished`，或刚被新导航**撤窗**）。
    quiet_since: Option<Instant>,
    /// 已经摆进内容区了没（摆放是一次性的：摆进来之后页面再怎么导航都不再动它）。
    placed: bool,
    /// 这一份 webview 从哪一刻开始等（= 建出来的那一刻）：首载期限那条兜底从这里算。
    placement_since: Instant,
}

impl SessionState {
    /// 页面此刻是不是"静默满一整窗"（`now` 由调用方给，好注入确定的时间）。
    /// 没有静默窗一律算不静默——宁可多看一会儿动画，也不在还在加载的页面上把动画收掉。
    fn is_quiet_at(&self, now: Instant) -> bool {
        self.quiet_since
            .map(|since| quiet_window_passed(now.saturating_duration_since(since)))
            .unwrap_or(false)
    }
}

impl LoginSession {
    pub fn new() -> Arc<Self> {
        Self::new_at(Instant::now())
    }

    /// 建一份会话，起点由调用方给（生产走 [`LoginSession::new`]，测试注入一个确定的时间）。
    /// 静默窗与首载期限都是"过了多久"的判定，靠 sleep 钉不出来。
    pub fn new_at(origin: Instant) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SessionState {
                conclusion: None,
                loaded: false,
                quiet_since: None,
                placed: false,
                // 建出来的那一刻就开始等：屏外那一份的首载期限从这里算
                placement_since: origin,
            }),
            changed: Condvar::new(),
        })
    }

    /// 登记结论：`true` = 本次是第一个（胜出），`false` = 已有结论（本次被忽略，绝不覆盖）。
    pub fn settle(&self, conclusion: LoginConclusion) -> bool {
        let mut state = lock(&self.state);
        if state.conclusion.is_some() {
            return false;
        }
        state.conclusion = Some(conclusion);
        drop(state);
        self.changed.notify_all();
        true
    }

    /// 当前结论（只读；不"取走即删除"——等待方与收尾路径都要能看到同一个结论）。
    pub fn conclusion(&self) -> Option<LoginConclusion> {
        lock(&self.state).conclusion.clone()
    }

    /// 首载完成（只记第一次）：解除首载期限。
    pub fn mark_loaded(&self) -> bool {
        let mut state = lock(&self.state);
        if state.loaded {
            return false;
        }
        state.loaded = true;
        drop(state);
        self.changed.notify_all();
        true
    }

    pub fn is_loaded(&self) -> bool {
        lock(&self.state).loaded
    }

    /// 一次加载完成：起一个静默窗，每一次 `Finished` 都重新起表（authorize 中间页、CAS 门户页各来一条）。
    /// 与 [`LoginSession::mark_loaded`] 不同：那个是"曾经加载成功过"，这个是"上一次加载在这一刻收尾"。
    pub fn note_page_finished_at(&self, at: Instant) {
        lock(&self.state).quiet_since = Some(at);
        self.changed.notify_all();
    }

    /// 见 [`LoginSession::note_page_finished_at`]（用当下这个时刻）。
    pub fn note_page_finished(&self) {
        self.note_page_finished_at(Instant::now());
    }

    /// 页面上起了新导航：撤掉静默窗，等下一次 `Finished`（CAS 重定向正靠这一条不让动画提前结束）。
    /// `true` = 真的撤掉了一个窗；`false` = 本来就没在等（已撤过或还没 `Finished` 过）。
    pub fn note_navigation_started(&self) -> bool {
        let had_window = lock(&self.state).quiet_since.take().is_some();
        if had_window {
            self.changed.notify_all();
        }
        had_window
    }

    /// 页面此刻是不是"静默满一整窗"了（纯读；日志与测试用）。
    pub fn is_quiet(&self) -> bool {
        self.is_quiet_at(Instant::now())
    }

    /// 见 [`LoginSession::is_quiet`]（时刻由调用方给）。
    pub fn is_quiet_at(&self, now: Instant) -> bool {
        lock(&self.state).is_quiet_at(now)
    }

    /// 这一版 webview 摆进内容区了吗？——**跟随主窗几何的前置条件**（屏外期间不跟随）。
    pub fn is_placed(&self) -> bool {
        lock(&self.state).placed
    }

    /// 记下"已经摆进内容区"（`true` = 这次是第一次，调用方该记一行日志）。幂等。
    pub fn mark_placed(&self) -> bool {
        let mut state = lock(&self.state);
        if state.placed {
            return false;
        }
        state.placed = true;
        true
    }

    /// 现在该摆进内容区了吗？（静默窗走完，或首载期限到——见 [`placement_due`]）
    pub fn placement_due(&self) -> bool {
        self.placement_due_at(Instant::now())
    }

    /// 见 [`LoginSession::placement_due`]（时刻由调用方给：测试注入确定的时间）。
    pub fn placement_due_at(&self, now: Instant) -> bool {
        let state = lock(&self.state);
        let elapsed = now.saturating_duration_since(state.placement_since);
        placement_due(state.is_quiet_at(now), elapsed)
    }

    /// 当前该摆在哪一档（等待方每 tick 读它决定"跟不跟随"）。
    pub fn placement(&self) -> Placement {
        if self.is_placed() {
            Placement::InContent
        } else {
            Placement::Offscreen
        }
    }

    /// 等结论最多 `timeout`：拿到就返回，到点返回 `None`（由调用方用 [`deadline_conclusion`] 定夺）。
    pub fn wait(&self, timeout: Duration) -> Option<LoginConclusion> {
        let state = lock(&self.state);
        if let Some(conclusion) = &state.conclusion {
            return Some(conclusion.clone());
        }
        let (state, _) = self
            .changed
            .wait_timeout(state, timeout)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.conclusion.clone()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 登录独占状态：同一时刻只允许一次登录（并排第二次只聚焦既有窗）。
#[derive(Default)]
pub struct LoginState {
    active: Mutex<Option<Arc<LoginSession>>>,
}

impl LoginState {
    /// 登记一次登录。`false` = 已有进行中的登录（调用方聚焦既有窗 + 报结构化错误）。
    pub fn begin(&self, session: Arc<LoginSession>) -> bool {
        let mut active = lock(&self.active);
        if active.is_some() {
            return false;
        }
        *active = Some(session);
        true
    }

    /// 收尾：放开独占（登录页拆完之后才调，避免新建的那个撞上正在拆的 label）。幂等。
    pub fn finish(&self) {
        *lock(&self.active) = None;
    }

    pub fn session(&self) -> Option<Arc<LoginSession>> {
        lock(&self.active).as_ref().map(Arc::clone)
    }

    pub fn is_active(&self) -> bool {
        lock(&self.active).is_some()
    }
}

// ---------------------------------------------------------------------------
// 几何（纯函数）
// ---------------------------------------------------------------------------

/// 矩形（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 主窗客户区此刻的原始读数：几何决策与线上排障共用这一份，绝不各读各的。
/// `inner_size()` 给的是物理像素（最小化时是 `(0,0)`，那一档不是尺寸），`scale` 是 DPI 比，`minimized` 只进日志。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClientArea {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub minimized: bool,
}

impl ClientArea {
    /// 原始读数那一行：留下没加工过的值，否则日志里只剩钳制下限凑出的几何，没人说得清当时量到多大。
    pub fn describe(&self) -> String {
        format!(
            "inner_size=({},{}) scale={} minimized={}",
            self.width.round() as i64,
            self.height.round() as i64,
            self.scale,
            self.minimized
        )
    }

    /// 这份读数够不够拿来算几何：客户区必须**量得到**（正数、有限）。
    fn is_measurable(&self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    /// 可信的缩放比（不可信按 1）：宁可少缩放，不要乱缩放。
    fn trusted_scale(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }
}

/// 一次"给登录页定几何"的结论：要么给出目标矩形，要么承认主窗此刻量不到客户区。
/// "量不到"不同于"很小"——它什么都没有，钳出下限只会得到一个假盒子。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Layout {
    /// 主窗客户区可测量 → 目标矩形（**客户区相对**物理像素）
    Target(Rect),
    /// 主窗此刻量不到客户区（最小化/未就绪）→ 没有几何可言
    HostUnmeasurable,
}

/// 客户区读数 → 这次该把登录页摆成什么（唯一的决策点）：量得到就铺满整个客户区，量不到就承认没有几何。
/// 顶部让位那套对登录页已退役，返回与主题改成浮在网页之上的两个小 webview（见 [`chrome_rects`]）。
pub fn layout_for(area: &ClientArea) -> Layout {
    if !area.is_measurable() {
        return Layout::HostUnmeasurable;
    }
    Layout::Target(layout_target(area.width, area.height))
}

/// 登录页的目标几何：铺满主窗客户区，客户区相对坐标、物理像素，输出恒为 `(0, 0, 客户区宽, 高)`。
/// 入参必须是量得到的尺寸（调用方一律走 [`layout_for`]）；非有限或负值按 0 处理再钳到下限。
pub fn layout_target(client_width: f64, client_height: f64) -> Rect {
    let sane = |value: f64| if value.is_finite() && value > 0.0 { value } else { 0.0 };
    Rect {
        x: 0.0,
        y: 0.0,
        width: sane(client_width).max(MIN_LOGIN_WIDTH),
        height: sane(client_height).max(MIN_LOGIN_HEIGHT),
    }
}

// ---------------------------------------------------------------------------
// 浮动控件（返回 / 主题）两个小 webview 的几何
// ---------------------------------------------------------------------------

/// 浮动控件的目标矩形 `[返回（左上）, 主题（右上）]`，客户区相对物理像素。
/// 盒子只取控件本身那么大（透明子窗也吃鼠标，别挡住官方页），贴边留 [`CHROME_MARGIN`] 否则圆角被裁。
pub fn chrome_rects(client_width: f64, client_height: f64, scale: f64) -> [Rect; 2] {
    let sane = |value: f64| if value.is_finite() && value > 0.0 { value } else { 0.0 };
    let trusted_scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let width = sane(client_width);
    let height = sane(client_height);
    let margin = CHROME_MARGIN * trusted_scale;

    let fit = |wanted: (f64, f64)| {
        let max_width = (width - margin * 2.0).max(0.0);
        let max_height = (height - margin).max(0.0);
        Rect {
            x: 0.0,
            y: 0.0,
            width: (wanted.0 * trusted_scale).min(max_width).max(1.0),
            height: (wanted.1 * trusted_scale).min(max_height).max(1.0),
        }
    };

    let mut back = fit(RETURN_CHROME_SIZE);
    back.x = margin;
    back.y = margin;

    let mut theme = fit(THEME_CHROME_SIZE);
    theme.x = (width - margin - theme.width).max(margin);
    theme.y = margin;

    [back, theme]
}

// ---------------------------------------------------------------------------
// 建登录页 / 等待 / 收尾（需要 tauri 运行时）
// ---------------------------------------------------------------------------

/// `host:open-login` 的入口（在效果线程上调用，必须立刻返回）。
/// `Ok(())` = 已交给 `login-view` 线程去答复这一帧（调用方不得再写第二次）；`Err` = 连窗都没开起来。
pub fn open_login(
    app: &AppHandle,
    shared: &Arc<CoreShared>,
    request_id: &str,
    payload: &Value,
) -> Result<(), CoreError> {
    // 打开的就是服务端给的那一条 URL：不挂主题查询参数、不复用"按主题重开"的机制，白名单校验照旧。
    let config = parse_config(payload)?;
    let data_root = app
        .try_state::<WebviewDataRoot>()
        .map(|state| state.0.clone())
        .ok_or_else(|| CoreError::new("internal", "数据根未登记：登录页无法确定 webview 数据目录"))?;
    let state = app
        .try_state::<Arc<LoginState>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| CoreError::new("internal", "登录状态未登记（setup 未完成）"))?;

    let login_data = login_data_dir(&data_root, &config.partition);
    let session = LoginSession::new();
    if !state.begin(Arc::clone(&session)) {
        focus_login_view(app);
        return Err(CoreError::new("login_in_progress", LOGIN_IN_PROGRESS_MESSAGE));
    }

    let app_handle = app.clone();
    let shared = Arc::clone(shared);
    let request_id = request_id.to_string();
    // 线程里用一份 Arc，外面留一份用于"线程都起不来"这条路的收尾
    let thread_state = Arc::clone(&state);
    let spawned = std::thread::Builder::new()
        .name("login-view".to_string())
        .spawn(move || {
            run_login_view(
                app_handle,
                shared,
                request_id,
                config,
                data_root,
                login_data,
                thread_state,
                session,
            )
        });

    if let Err(source) = spawned {
        state.finish();
        return Err(CoreError::new(
            "internal",
            format!("登录线程起不来：{source}（本次登录未开始）"),
        ));
    }
    Ok(())
}

/// `host:cancel-login` 的入口：把结论槽结算成 [`LoginConclusion::Cancelled`]。
/// 返回 `false` 表示本来就没有进行中的登录——那不是错误，用户的意图"别等了"已经满足。
pub fn cancel_login(app: &AppHandle) -> Result<bool, CoreError> {
    let state = app
        .try_state::<Arc<LoginState>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| CoreError::new("internal", "登录状态未登记（setup 未完成）"))?;
    match state.session() {
        Some(session) => Ok(session.settle(LoginConclusion::Cancelled)),
        None => Ok(false),
    }
}

/// 登录线程的正体：建登录页 → 等结论 → **先答复等待方** → 拆登录页清理 → 放开独占。
fn run_login_view(
    app: AppHandle,
    shared: Arc<CoreShared>,
    request_id: String,
    config: LoginConfig,
    data_root: PathBuf,
    login_data: PathBuf,
    state: Arc<LoginState>,
    session: Arc<LoginSession>,
) {
    let webview = match create_login_view(&app, &config.url, &data_root, &login_data, &session) {
        Ok(webview) => webview,
        Err(error) => {
            // 建页失败不是登录结论而是宿主错误：如实回带真实原因的错帧，别塞"请检查网络或代理"那句。
            log::warn!("登录页建不起来：{error}");
            // 先答复、再善后（与成功路径同一条纪律）：退避删目录最长要等约 1.5 秒，
            // 不能让等待方陪着等——何况"删目录失败"的结论不该改变这次登录的答复。
            respond(&shared, &request_id, Err(error));
            // `create_dir_all(login_data)` 在建登录页之前就跑了，建不出来时目录已经在那儿，
            // 而这条路上 `shutdown_login_view` 永远不会被调用 → 就地尽力清一次。
            for failure in abandon_build_data_dir(&login_data) {
                if failure.needs_user_notice() {
                    log::warn!("建登录页失败后的目录善后有残留：{}", failure.message());
                    announce_failure(&app, &shared, &failure.message());
                } else {
                    log::warn!("建登录页失败后的目录善后未竟（不打扰用户）：{}", failure.message());
                }
            }
            state.finish();
            return;
        }
    };

    // 建页交付的句柄只用来"知道建成了"。**收尾不拿它**：收尾一律按 label 找**当前**那一份
    //（见 [`shutdown_login_view`]），免得拿一个可能的死句柄去 close 而误报"残留"。
    let _built = webview;

    let conclusion = wait_for_conclusion(&app, &session);

    // **先答复、再拆登录页**（顺序是硬要求）：拆要删目录、要退避重试，可能失败；
    // 若因为拆失败而不答复，Node 侧就变成"扫码成功却等超时"。
    respond(&shared, &request_id, Ok(conclusion.to_payload()));

    for failure in shutdown_login_view(&app, &login_data) {
        if failure.needs_user_notice() {
            // 只有真残留才打扰用户（webview 还在 / 目录没删掉）。
            log::warn!("登录页收尾失败（有残留）：{}", failure.message());
            announce_failure(&app, &shared, &failure.message());
        } else {
            // 登录页已消失的路径上 `clear_all_browsing_data` / `close` 必然失败，但整个一次性目录照样被删掉，
            // 所以这是预期失败、不是残留：只留日志，别弹一条让用户去清理刚被删掉的东西。
            log::warn!("登录页收尾未竟（预期失败，不打扰用户）：{}", failure.message());
        }
    }
    state.finish();
}

/// 等结论：结论槽 + 登录页消失兜底 + 屏外摆放 + 双期限 + 每 tick 跟随主窗几何。
fn wait_for_conclusion(app: &AppHandle, session: &Arc<LoginSession>) -> LoginConclusion {
    let started = Instant::now();
    let mut layout_warned = false;
    // 跟随每 250ms 一次，只在状态翻转那一次说话。
    let mut follow_note = FollowNote::default();
    // 摆放那一支同理：主窗最小化时它会一直失败到主窗回来。
    let mut placement_note = FollowNote::default();
    loop {
        if let Some(conclusion) = session.conclusion() {
            return conclusion;
        }
        // 登录页没了而结论槽还空着：兜底判 Closed（事件路径之外的第二条来源，绝不让等待方挂到超时）。
        // 同窗宿主里这不是"用户关了窗"，而是"那个 webview 被拆掉了"（应用退出 / 收尾先行）。
        let present = app.get_webview(LOGIN_WEBVIEW_LABEL).is_some();
        if let Some(conclusion) = vanish_conclusion(present) {
            session.settle(conclusion.clone());
            return session.conclusion().unwrap_or(conclusion);
        }
        // 屏外 → 内容区的那一次摆放（静默窗走完或首载期限到）：每 tick 现算不缓存，因为新导航随时会撤窗；
        // 排在期限判定之前——先摆出来给用户看，再结算首载失败，反过来那一帧就把页拆了。
        if !session.is_placed() && session.placement_due() {
            match place_login_view(app) {
                Ok(target) => {
                    placement_note.observe(FollowState::Applied); // 摆成了：把"摆不动"那条记录复位
                    if session.mark_placed() {
                        log::info!(
                            "登录页摆进内容区（静默窗走完或首载期限到）：rect=({},{},{},{})——此前一直摆在屏外，门禁页上的加载动画到此为止",
                            target.x,
                            target.y,
                            target.width,
                            target.height
                        );
                    }
                }
                // 主窗量不到客户区（最小化）就保持屏外，等主窗回来那一 tick 再摆，绝不拿钳制下限凑几何。
                // 只在状态翻转时说一次：这一档会一直成立到主窗回来，每 250ms 一条警告就是几千行废话。
                Err(error) => {
                    if placement_note.observe(FollowState::Unmeasurable) {
                        log::warn!("登录页还不能摆进内容区：{error}（下一 tick 再试，主窗回来之前不再重复记录）");
                    }
                }
            }
        }
        if let Some(conclusion) = deadline_conclusion(started.elapsed(), session.is_loaded()) {
            if !session.settle(conclusion.clone()) {
                // 期限判定与别的来源撞上了：先到者胜，返回槽里那一条
                return session.conclusion().unwrap_or(conclusion);
            }
            return conclusion;
        }
        if session.wait(FOLLOW_TICK).is_some() {
            continue; // 回到循环顶部统一"读槽"，省得两条返回路径
        }
        // 屏外期间**不跟随**：跟随会把那一份摆回内容区，用户当场就看到一个还在加载的白页
        // ——那正是本次要消灭的现象。浮动控件照常跟随（它们此刻是唯一可点的东西）。
        match follow_main_window(app, session.placement()) {
            Ok(FollowOutcome::Applied(target)) => {
                if follow_note.observe(FollowState::Applied) {
                    log::info!(
                        "登录页跟随主窗几何：客户区可测量，摆到 rect=({},{},{},{})",
                        target.x,
                        target.y,
                        target.width,
                        target.height
                    );
                }
            }
            Ok(FollowOutcome::Offscreen(target)) => {
                if follow_note.observe(FollowState::Offscreen) {
                    log::info!(
                        "登录页仍在屏外（等首载），这次只跟随浮动控件：客户区 rect=({},{},{},{})",
                        target.x,
                        target.y,
                        target.width,
                        target.height
                    );
                }
            }
            Ok(FollowOutcome::HostUnmeasurable(area)) => {
                if follow_note.observe(FollowState::Unmeasurable) {
                    // 保持登录页现有几何（绝不拿钳制下限覆盖它）：主窗最小化时量到的是 (0,0)，
                    // 主窗一回来，下一 tick 自然重新摆对。
                    log::warn!(
                        "登录页跟随：主窗此刻量不到客户区（{}）——保持登录页现有几何，等主窗回来（不再重复记录）",
                        area.describe()
                    );
                }
            }
            Err(error) => {
                if !layout_warned {
                    log::warn!("登录页未能跟随主窗几何：{error}（后续不再重复记录）");
                    layout_warned = true;
                }
            }
        }
    }
}

/// 把屏外的登录页摆进内容区（静默窗走完或首载期限到共用这一处）。
/// 几何取那一刻的客户区读数而不是创建时那一份：屏外期间用户可能已经把主窗拖大/缩小了。
fn place_login_view(app: &AppHandle) -> Result<Rect, CoreError> {
    match follow_main_window(app, Placement::InContent)? {
        FollowOutcome::Applied(target) => Ok(target),
        FollowOutcome::HostUnmeasurable(area) => Err(CoreError::new(
            "internal",
            format!(
                "主窗此刻量不到客户区（{}）：登录页先留在屏外",
                area.describe()
            ),
        )),
        // 入参是 InContent，这一档不可能出现；真出现了也当作"没摆成"
        FollowOutcome::Offscreen(target) => Err(CoreError::new(
            "internal",
            format!("登录页没有摆进内容区（rect=({},{})）", target.x, target.y),
        )),
    }
}

/// 建登录页（投到主线程执行：webview 的创建必须在事件循环线程上）；`url` 原样打开，不挂主题参数、不重开。
fn create_login_view(
    app: &AppHandle,
    url: &str,
    data_root: &Path,
    login_data: &Path,
    session: &Arc<LoginSession>,
) -> Result<Webview, CoreError> {
    let url = tauri::Url::parse(url)
        .map_err(|_| invalid_payload("url 解析不了（parse_config 之后不该发生）"))?;

    // 目录必须先建：WebView2 不会自建，缺目录时建 webview 直接 `os error 5`（拒绝访问）。
    std::fs::create_dir_all(login_data).map_err(|source| {
        CoreError::new(
            "internal",
            format!("登录页数据目录建不出来（{source}）：登录无法开始"),
        )
    })?;

    // 代理在建登录页时读取一次 → 改代理要重启应用才生效（与主窗一致）。
    let proxy = crate::proxy_url_argument(crate::webview_proxy::resolve_for_webview(
        data_root,
        LOGIN_WEBVIEW_LABEL,
    ));

    let (sender, receiver) = std::sync::mpsc::channel();
    let app_for_build = app.clone();
    let url_for_build = url;
    let login_data_for_build = login_data.to_path_buf();
    let login_data_for_discard = login_data.to_path_buf();
    let nav_session = Arc::clone(session);
    let load_session = Arc::clone(session);

    app.run_on_main_thread(move || {
        let built = build_on_main_thread(
            &app_for_build,
            url_for_build,
            login_data_for_build,
            proxy,
            nav_session,
            load_session,
        );
        // 交付守卫：等待方可能已经走了（超时或先返回 Err），那时 `send` 会把刚建出的登录页原样还回来，
        // 必须就地关掉；浮动控件在同一个闭包里建出，孤儿清理要连它们与数据目录一起收。
        match deliver_build_result(sender.send(built), |webview| {
            let mut problems = Vec::new();
            if let Err(reason) = discard_orphan_login_window(&webview, &login_data_for_discard) {
                problems.push(reason);
            }
            if let Err(reason) = close_login_chrome(&app_for_build) {
                problems.push(reason);
            }
            if problems.is_empty() {
                Ok(())
            } else {
                Err(problems.join("；"))
            }
        }) {
            BuildDelivery::Delivered | BuildDelivery::NothingBuilt => {}
            BuildDelivery::OrphanDiscarded => log::warn!(
                "登录页建出来了，但等待方已收场（多半是建页超时）：已关掉这个没人等的登录页、它的浮动控件与数据目录"
            ),
            BuildDelivery::OrphanLeftBehind(reason) => log::warn!(
                "登录页建出来了但等待方已收场，且没能清干净（{reason}）：登录页/浮动控件或数据目录可能残留"
            ),
        }
    })
    .map_err(|source| {
        CoreError::new(
            "internal",
            format!("建登录页任务排不到主线程（{source}）：登录无法开始"),
        )
    })?;

    let outcome = receiver.recv_timeout(BUILD_TIMEOUT);
    // 等待方一收场就立刻扔掉接收端，此后闭包的 `send` 必然失败、建出来的页落进交付守卫手里被关掉；
    // 留到函数返回才析构的话，中间那一瞬晚到的 `send` 仍可能"成功"，页就被丢进没人再读的通道。
    drop(receiver);

    match outcome {
        Ok(Ok(webview)) => Ok(webview),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            // 主线程忙到超时：排队的闭包稍后仍会执行，这里先清掉"已建出但还没交付"的那一份，
            // 闭包侧的交付守卫兜"稍后才建出来"的那种，两道防线都不留孤儿。
            discard_pending_login_view(app);
            Err(CoreError::new(
                "internal",
                "登录页建页任务超时（主线程没有回应）：登录无法开始",
            ))
        }
    }
}

/// 尽力关掉一个"可能已建出来、但已经没人等待"的登录页（建页超时专用）：只写日志，不发 `app:notice`。
/// 只关 webview、不删数据目录（闭包可能正在用它建 WebView2，并发删会把它弄坏），目录由 Err 支退避删兜底。
fn discard_pending_login_view(app: &AppHandle) {
    let Some(webview) = app.get_webview(LOGIN_WEBVIEW_LABEL) else {
        return; // 还没建出来：闭包侧的交付守卫会接住它
    };
    if let Err(source) = webview.discard() {
        log::warn!("建页超时留下的孤儿登录页未能关掉（{source}）：它可能还挂在主窗上");
    }
    if let Err(reason) = close_login_chrome(app) {
        log::warn!("建页超时留下的孤儿浮动控件未能清干净（{reason}）：它们可能还浮在主窗上");
    }
}

/// 关掉两个浮动控件（幂等：label 不在表里就是"本来就没有"）；`Err(原因)` = 还有没关掉的。
/// 必须跟着登录页一起收：它们浮在官方页之上，还握着 `core_login_chrome` 的来源资格。
pub fn close_login_chrome(app: &AppHandle) -> Result<(), String> {
    let mut problems = Vec::new();
    for label in LOGIN_CHROME_LABELS {
        let Some(webview) = app.get_webview(label) else {
            continue;
        };
        if let Err(source) = webview.close() {
            problems.push(format!("关掉 {label} 失败（{source}）"));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("；"))
    }
}

/// 真正调用 tauri 建登录页（主线程上跑）：几何在 `add_child` 时就定死，之后每 tick 由 [`follow_main_window`] 重算。
/// 浮动控件必须建在登录页之后（wry 用 `SetWindowPos(HWND_TOP)` 建子窗，后建的在上），返回控件建不起来即登录失败。
#[allow(clippy::too_many_arguments)]
fn build_on_main_thread(
    app: &AppHandle,
    url: tauri::Url,
    login_data: PathBuf,
    proxy: Option<tauri::Url>,
    nav_session: Arc<LoginSession>,
    load_session: Arc<LoginSession>,
) -> Result<Webview, CoreError> {
    let main = app.get_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        CoreError::new(
            "internal",
            "主窗不在了：登录页没有可挂的地方（同窗宿主）",
        )
    })?;

    // 建之前先把几何算出来：`add_child` 一步就摆到最终位置，不存在"先闪一下左上角再搬过去"的窗口期。
    // 客户区量不到（最小化时 `inner_size()` 是 (0,0)）就先 [`crate::focus_main`] 恢复主窗再量一次。
    let mut area = read_client_area(&main)?;
    if layout_for(&area) == Layout::HostUnmeasurable {
        log::warn!(
            "登录页创建时主窗量不到客户区（{}）：先把主窗恢复/拉到前台再量一次",
            area.describe()
        );
        crate::focus_main(app);
        area = read_client_area(&main)?;
    }
    let target = match layout_for(&area) {
        Layout::Target(target) => target,
        // 恢复之后仍然量不到：宁可结构化报错收场，也不建一个钳制下限凑出来的假盒子。
        Layout::HostUnmeasurable => {
            return Err(CoreError::new(
                "internal",
                format!(
                    "主窗客户区尺寸拿不到（{}）：登录页没有可摆放的位置",
                    area.describe()
                ),
            ));
        }
    };
    let chrome = chrome_rects(area.width, area.height, area.trusted_scale());
    // 登录页先摆在屏外（客户区左沿之外）加载，门禁页底下显示加载动画，静默窗走完或首载期限到才摆进 `target`。
    // 浮动控件照常摆在客户区里——屏外那一段它们是唯一可点的东西（返回扫码登录 / 主题三档）。
    let offscreen = offscreen_rect(target);

    // 这一行要能回答两个问题：登录页停在哪一页（只记 origin + path + 参数名，值不进日志）、
    // 主窗当时量到多大（原始读数），所以还连带记下屏外 rect、内容区目标 rect 与两个浮动控件矩形。
    log::info!(
        "登录页创建（主窗内第二 webview；先摆在屏外等静默窗）：url={} partition={} {} 屏外=({},{},{},{}) 内容区目标=({},{},{},{}) 浮动控件=返回({},{},{},{})/主题({},{},{},{})",
        describe_navigation_for_log(url.as_str()),
        config_partition_hint(&login_data),
        area.describe(),
        offscreen.x,
        offscreen.y,
        offscreen.width,
        offscreen.height,
        target.x,
        target.y,
        target.width,
        target.height,
        chrome[0].x,
        chrome[0].y,
        chrome[0].width,
        chrome[0].height,
        chrome[1].x,
        chrome[1].y,
        chrome[1].width,
        chrome[1].height
    );

    // 不设 UA：WebView2 用自己的默认桌面 UA。
    let mut builder = WebviewBuilder::new(LOGIN_WEBVIEW_LABEL, WebviewUrl::External(url))
        .data_directory(login_data.clone())
        // 白名单 + hms:// 拦截全部走导航事件（登录页零注入：不订阅 initialization_script 那条路）
        .on_navigation(move |url| {
            let decision = navigation_for(url.as_str());
            let described = describe_navigation_for_log(url.as_str());
            match &decision {
                // 拦下必须留痕：这是"页面为什么是空白/为什么没动"的第一手证据
                Navigation::Block => log::warn!(
                    "登录页拦下一次不在白名单里的导航：{described}（如果页面上是空白，多半就是这一步被拦下的）"
                ),
                Navigation::Callback(_) => {
                    log::info!("登录页收到登录回调：{described}（交给 core 判定真伪）")
                }
                // 放行的导航当场撤掉静默窗（CAS 重定向就是新的一次导航）；拦下的两条不撤，它们不加载任何东西。
                Navigation::Allow => {
                    if nav_session.note_navigation_started() {
                        log::info!(
                            "登录页起了一次新导航：{described}（撤掉上一次的静默窗，等这一次加载完成）"
                        );
                    } else {
                        log::debug!("登录页导航放行：{described}");
                    }
                }
            }
            match decision {
                Navigation::Callback(original) => {
                    nav_session.settle(LoginConclusion::Callback { url: original });
                    false // 拦下不请求：`hms://` 交给 Node 侧判定与结算
                }
                Navigation::Allow => true,
                Navigation::Block => false,
            }
        })
        // 弹窗一律拒（官方页不需要开新窗；`window.open` 是攻击面）
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        // 首载与失败都要记：只认 `Finished` 的话，"开始加载了却一直没完成"在日志里就是一片空白。
        // `Finished` 起一个静默窗（摆进由等待方做，它才拿着客户区读数）；每次加载各来一条，判据是"最近一次"。
        .on_page_load(move |_webview, payload| {
            let described = describe_navigation_for_log(payload.url().as_str());
            match payload.event() {
                // 内容真的开始加载了：撤窗（与 on_navigation 那一条同一个动作，两道防线都留着
                // ——导航事件与加载事件在 wry 里是两条独立的回调，任一条到了都算"还在加载"）
                PageLoadEvent::Started => {
                    if load_session.note_navigation_started() {
                        log::info!("登录页开始加载：{described}（撤掉上一次的静默窗）");
                    } else {
                        log::info!("登录页开始加载：{described}");
                    }
                }
                PageLoadEvent::Finished => {
                    log::info!(
                        "登录页加载完成：{described}（起一个静默窗：窗内没有新导航才摆进内容区）"
                    );
                    load_session.mark_loaded();
                    load_session.note_page_finished();
                }
            }
        });

    // debug 构建才开 devtools（"空白页"的 console/网络错误只能在这里看见）；
    // release 不开：官方页在生产环境不该多一个可调试面板，那是身份边界上的输入面。
    #[cfg(debug_assertions)]
    {
        builder = builder.devtools(true);
    }

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }

    let webview = main
        .add_child(
            builder,
            // 建在屏外：`offscreen.x` 为负，整个矩形落在客户区左沿之外（子窗被父窗裁剪，一个像素都不露）
            tauri::PhysicalPosition::new(offscreen.x.round() as i32, offscreen.y.round() as i32),
            tauri::PhysicalSize::new(target.width.round() as u32, target.height.round() as u32),
        )
        .map_err(|source| CoreError::new("internal", format!("登录页建不起来（{source}）")))?;
    // 把焦点交给官方页（用户在它里面扫码/输入）；聚焦失败只留痕，不该让整次登录失败。
    // 屏外期间焦点落在客户区之外无碍，摆进内容区之后这一次 `set_focus` 仍然有效。
    if !foreground_allowed() {
        // 后台验证实例只读界面，不碰焦点
        log::info!("后台验证开关生效：登录页不做 set_focus");
    } else if let Err(source) = webview.set_focus() {
        log::warn!("登录页没能拿到焦点（{source}）：用户可能要自己点一下页面");
    }

    // 官方页之后紧接着建两个浮动控件（后建 = 在上）；返回控件是硬要求：
    // 建不出来就按结构化错误收场，否则留下一个没有出口的官方页。
    if let Err(error) = build_chrome_on_main_thread(
        &main,
        LOGIN_RETURN_WEBVIEW_LABEL,
        LOGIN_CHROME_KIND_RETURN,
        &login_data,
        chrome[0],
    ) {
        // 已经建出来的两个 webview 由调用方（`run_login_view` 的 Err 支 / 交付守卫）收，
        // 这里只把登录页也关掉：否则会留下一个盖着门禁的官方页（用户看不到二维码，也没法返回）。
        if let Err(source) = webview.discard() {
            log::warn!("返回控件建不起来，且登录页没能收掉（{source}）：它可能还铺在主窗上");
        }
        return Err(error);
    }
    if let Err(error) = build_chrome_on_main_thread(
        &main,
        LOGIN_THEME_WEBVIEW_LABEL,
        LOGIN_CHROME_KIND_THEME,
        &login_data,
        chrome[1],
    ) {
        // 主题控件只是少一个便利入口：登录本身照常（留痕即可，不打扰用户）。
        log::warn!("主题浮动控件建不起来（{error}）：这次登录没有右上角的主题控件");
    }

    Ok(webview)
}

/// 建一个浮动控件 webview（返回 / 主题）：加载本地 `login-chrome.html?kind=…`、背景透明，
/// 并与登录页共用同一个数据目录（tauri 的 `WebContextStore` 按目录缓存，另起目录要多建一棵一次性目录）。
fn build_chrome_on_main_thread(
    main: &tauri::Window,
    label: &str,
    kind: &str,
    login_data: &Path,
    target: Rect,
) -> Result<(), CoreError> {
    let builder = WebviewBuilder::new(label, WebviewUrl::App(chrome_url(kind).into()))
        .data_directory(login_data.to_path_buf())
        // 透明：浮在官方页之上，不铺任何底色（wry 在 Windows 上把 alpha=0 交给
        // WebView2 的 `SetDefaultBackgroundColor`，只有 0 才是透明——非 0 会被强制成不透明）
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .on_navigation(|url| {
            let allowed = chrome_navigation_allowed(url.as_str());
            if !allowed {
                log::warn!(
                    "浮动控件拦下一次不该有的导航：{}（它只许停在应用自己的本地页面上）",
                    describe_navigation_for_log(url.as_str())
                );
            }
            allowed
        })
        // 弹窗一律拒（这个页面里没有链接，也没有开新窗的理由）
        .on_new_window(|_url, _features| NewWindowResponse::Deny);

    main.add_child(
        builder,
        tauri::PhysicalPosition::new(target.x.round() as i32, target.y.round() as i32),
        tauri::PhysicalSize::new(target.width.round() as u32, target.height.round() as u32),
    )
    .map(|_| ())
    .map_err(|source| {
        CoreError::new(
            "internal",
            format!("{label} 浮动控件建不起来（{source}）"),
        )
    })
}

/// 浮动控件只许停在应用自己的本地页面上（生产 `tauri://localhost`，开发 `http://localhost:<devUrl 端口>`）。
/// 它们的 label 已在 `core_login_chrome` 的允许集合里，能导航到任意网页就等于把那项资格让出去。
pub fn chrome_navigation_allowed(raw: &str) -> bool {
    let Ok(url) = tauri::Url::parse(raw.trim()) else {
        return false;
    };
    match url.scheme() {
        // 生产：前端经自定义协议加载（tauri://localhost/login-chrome.html）
        "tauri" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost") | Some("tauri.localhost") | Some("127.0.0.1")
        ),
        _ => false,
    }
}

/// 一次性数据目录名的最后一段，只为让日志能追"这次登录用的是哪个目录"。
fn config_partition_hint(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "(未知)".to_string())
}

/// 主窗客户区此刻的原始读数（只读；日志由调用点按各自的节奏决定，见 [`ClientArea::describe`]）。
/// 单位是物理像素 + DPI 缩放比，原样交给 `add_child` / `set_position` 用，从未被谁除过。
fn read_client_area(main: &tauri::Window) -> Result<ClientArea, CoreError> {
    let scale = main.scale_factor().unwrap_or(1.0);
    let size = main
        .inner_size()
        .map_err(|source| CoreError::new("internal", format!("取主窗客户区尺寸失败：{source}")))?;
    Ok(ClientArea {
        width: f64::from(size.width),
        height: f64::from(size.height),
        scale,
        minimized: main.is_minimized().unwrap_or(false),
    })
}

/// 一次跟随的结果：登录页真的摆了（附摆成的矩形）/ 登录页还在屏外（只跟了浮动控件）/
/// 主窗此刻量不到客户区（**保持原样**）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FollowOutcome {
    /// 登录页摆到了这个矩形（客户区相对物理像素）
    Applied(Rect),
    /// 登录页还在屏外等首载：这一 tick 只跟随了浮动控件
    Offscreen(Rect),
    HostUnmeasurable(ClientArea),
}

/// 跟随每 250ms 一次，所以只在状态翻转时说话：三档（摆进 / 屏外 / 量不到）各对应一句不同的日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowState {
    /// 登录页摆到了内容区（跟随生效）
    Applied,
    /// 登录页还在屏外等首载：这一 tick 只跟随了浮动控件
    Offscreen,
    /// 主窗此刻量不到客户区（保持现有几何）
    Unmeasurable,
}

/// 跟随日志的"只在状态翻转时说话"（见 [`FollowState`]）。
#[derive(Debug, Default)]
pub struct FollowNote {
    last: Option<FollowState>,
}

impl FollowNote {
    /// 记下这一 tick 的状态；`true` = 与上一 tick 不同（该说一句了）。
    pub fn observe(&mut self, state: FollowState) -> bool {
        let changed = self.last != Some(state);
        self.last = Some(state);
        changed
    }
}

/// 按主窗此刻的客户区摆三个 webview：`placement` 决定登录页怎么处置，浮动控件两档都跟随（失败只留痕）。
/// 三者共用同一次客户区读数，分两次量会摆出"登录页新尺寸、控件旧尺寸"的错位。
fn apply_layout(app: &AppHandle, placement: Placement) -> Result<FollowOutcome, CoreError> {
    let main = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "主窗不在了：无法计算登录页几何"))?;
    let area = read_client_area(&main)?;

    let Layout::Target(target) = layout_for(&area) else {
        // 量不到就什么都不改（钳成下限写回去正是"主窗一最小化、登录页缩成左上角小盒子"那条路），
        // 反正此刻登录页看不见，等主窗回来那一 tick 自然重新摆对。
        return Ok(FollowOutcome::HostUnmeasurable(area));
    };

    // 浮动控件先摆（它们两档都要跟）：失败只留痕
    let rects = chrome_rects(area.width, area.height, area.trusted_scale());
    for (label, rect) in LOGIN_CHROME_LABELS.iter().zip(rects) {
        let Some(chrome) = app.get_webview(label) else {
            continue;
        };
        if let Err(error) = set_webview_rect(&chrome, rect, label) {
            log::debug!("浮动控件 {label} 未能跟随主窗几何：{error}");
        }
    }

    if placement == Placement::Offscreen {
        // 屏外期间**不碰登录页**：把它摆回内容区 = 让用户对着一个还在加载的白页
        return Ok(FollowOutcome::Offscreen(target));
    }

    let webview = app
        .get_webview(LOGIN_WEBVIEW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "登录页已拆掉：无需跟随"))?;
    set_webview_rect(&webview, target, "登录页")?;
    Ok(FollowOutcome::Applied(target))
}

/// 把一个子 webview 摆到客户区相对的矩形上。
fn set_webview_rect(webview: &Webview, target: Rect, what: &str) -> Result<(), CoreError> {
    webview
        .set_position(tauri::PhysicalPosition::new(
            target.x.round() as i32,
            target.y.round() as i32,
        ))
        .map_err(|source| CoreError::new("internal", format!("摆放{what}失败：{source}")))?;
    webview
        .set_size(tauri::PhysicalSize::new(
            target.width.round() as u32,
            target.height.round() as u32,
        ))
        .map_err(|source| CoreError::new("internal", format!("设置{what}尺寸失败：{source}")))?;
    Ok(())
}

/// 跟随主窗几何（登录页铺在主窗客户区上、两个浮动控件贴角：主窗一动就要重算）。
///
/// `placement` 是登录页此刻那一档（[`LoginSession::placement`]）：屏外期间登录页不跟随。
pub fn follow_main_window(app: &AppHandle, placement: Placement) -> Result<FollowOutcome, CoreError> {
    apply_layout(app, placement)
}

/// 收尾各步的原始结果（拆成数据就是为了让分级判定成为**纯函数**，不依赖真 GUI 也能测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownOutcome {
    /// `clear_all_browsing_data` 的结果
    pub clear_browsing_data: Result<(), String>,
    /// `close` 的结果
    pub close: Result<(), String>,
    /// `close` 之后登录页是否还在 tauri 的 webview 表里（还在才需要再关一次）
    pub still_present: bool,
    /// 再关一次的结果（只在 `still_present` 为真时才被采纳）
    pub destroy: Result<(), String>,
    /// 删数据目录的失败原因（`None` = 已清干净或本来就不存在）
    pub data_dir: Option<String>,
}

impl Default for ShutdownOutcome {
    /// "什么都没出错"的那一份（`Result` 本身没有 `Default` 实现，所以手写）。
    fn default() -> Self {
        Self {
            clear_browsing_data: Ok(()),
            close: Ok(()),
            still_present: false,
            destroy: Ok(()),
            data_dir: None,
        }
    }
}

/// 收尾失败项。**带"该不该打扰用户"的属性**是这张表的全部意义：
/// 失败要留痕（日志），但不是每一条都值得弹给用户看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShutdownFailure {
    BrowsingData(String),
    Close(String),
    Destroy(String),
    DataDir(String),
}

impl ShutdownFailure {
    /// 是否值得广播 `app:notice`：只有"窗口还在"（销毁失败）与"目录没删掉"（可能躺着 cookie）算真残留。
    /// 浏览数据与 close 的失败在窗口已被关掉的收尾里每次都会发生，且什么也没留下。
    pub fn needs_user_notice(&self) -> bool {
        matches!(self, Self::Destroy(_) | Self::DataDir(_))
    }

    /// 给人看的一句话（同时用于日志与 app:notice）。
    ///
    /// 纯文本，不带 markdown 记号：它会原样进入 `app:notice` 的 `text` 与日志文件。
    pub fn message(&self) -> String {
        match self {
            Self::BrowsingData(source) => format!(
                "登录页浏览数据未能清除（{source}）：本次的一次性数据目录会被整棵删掉，正常收尾不留残留"
            ),
            Self::Close(source) => {
                format!("登录页关闭调用失败（{source}）：会再关一次，这一步失败本身不代表残留")
            }
            Self::Destroy(source) => {
                format!("登录页关不掉了（{source}）：它可能还铺在主窗上，重启应用可清")
            }
            Self::DataDir(source) => format!(
                "登录页临时数据目录未能删除（{source}）：下次登录会另建新目录（partition 一次性），\
                 但该目录里可能残留本次的浏览数据，建议手动清理"
            ),
        }
    }
}

/// 收尾结果 → 失败清单（纯函数）。
pub fn shutdown_failures(outcome: &ShutdownOutcome) -> Vec<ShutdownFailure> {
    let mut failures = Vec::new();
    if let Err(source) = &outcome.clear_browsing_data {
        failures.push(ShutdownFailure::BrowsingData(source.clone()));
    }
    if let Err(source) = &outcome.close {
        failures.push(ShutdownFailure::Close(source.clone()));
    }
    if outcome.still_present {
        if let Err(source) = &outcome.destroy {
            failures.push(ShutdownFailure::Destroy(source.clone()));
        }
    }
    if let Some(source) = &outcome.data_dir {
        failures.push(ShutdownFailure::DataDir(source.clone()));
    }
    failures
}

/// 收尾顺序不能换：浏览数据要在 webview 还活着时清，之后 close（还在就再关一次），最后退避删目录。
/// 同窗宿主没有"窗口关闭"那一步，所以按 label 找当下那一份再关——拿旧句柄会把每次收尾误报成残留。
pub fn shutdown_login_view(app: &AppHandle, data_dir: &Path) -> Vec<ShutdownFailure> {
    let closed = close_login_view_now(app);
    let data_dir = remove_dir_with_backoff(data_dir);

    shutdown_failures(&ShutdownOutcome {
        clear_browsing_data: closed.clear_browsing_data,
        close: closed.close,
        still_present: closed.still_present,
        destroy: closed.destroy,
        data_dir,
    })
}

/// `close_login_view_now` 的分步结果（`shutdown_login_view` 把它接上"删数据目录"那一步）。
struct CloseOutcome {
    clear_browsing_data: Result<(), String>,
    close: Result<(), String>,
    still_present: bool,
    destroy: Result<(), String>,
}

/// 关掉登录页和两个浮动控件，不动数据目录（由 shutdown_login_view 删）。
/// 页面本来就不在时如实记 Ok：没什么可关不等于关不掉。
fn close_login_view_now(app: &AppHandle) -> CloseOutcome {
    let Some(webview) = app.get_webview(LOGIN_WEBVIEW_LABEL) else {
        // 页不在了：清浏览数据与关闭都无从谈起（浮动控件照旧要收）
        let chrome = close_login_chrome(app);
        return CloseOutcome {
            clear_browsing_data: Ok(()),
            close: chrome,
            still_present: false,
            destroy: Ok(()),
        };
    };
    let clear_browsing_data = webview
        .clear_all_browsing_data()
        .map_err(|source| source.to_string());
    let close = webview.close().map_err(|source| source.to_string());
    let still_present = app.get_webview(LOGIN_WEBVIEW_LABEL).is_some();
    let destroy = if still_present {
        webview.close().map_err(|source| source.to_string())
    } else {
        Ok(())
    };
    // 浮动控件与登录页同生同灭（它们浮在官方页之上，还握着 core_login_chrome 的来源资格），
    // 失败并入 `close` 那一档，分级与提示语才一致。
    let close = close.and_then(|()| close_login_chrome(app));
    CloseOutcome {
        clear_browsing_data,
        close,
        still_present,
        destroy,
    }
}

/// "建出来了但还没交给等待方"的登录页的最小能力面：真实实现是 tauri 的 [`Webview`]。
/// 测试要用假实现观察究竟有没有去关，纯函数替代不了。
pub trait DiscardableWindow {
    /// 关掉它（尽力而为）：`Ok(())` = 已关掉；`Err` = 失败原因。
    fn discard(&self) -> Result<(), String>;
}

impl DiscardableWindow for Webview {
    fn discard(&self) -> Result<(), String> {
        self.close().map_err(|source| source.to_string())
    }
}

/// 清掉一个"没人等待"的登录页：关掉它 + 删掉它那个一次性数据目录。
///
/// 两条**各自尽力**（关闭失败不该连累目录清理，反之亦然），失败原因合并交回调用方写日志。
pub fn discard_orphan_login_window<W: DiscardableWindow>(
    webview: &W,
    data_dir: &Path,
) -> Result<(), String> {
    let mut problems = Vec::new();
    if let Err(source) = webview.discard() {
        problems.push(format!("关掉孤儿登录页失败（{source}）"));
    }
    if let Some(source) = remove_dir_with_backoff(data_dir) {
        problems.push(format!("删孤儿登录页数据目录失败（{source}）"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("；"))
    }
}

/// 建登录页结果交付的结局（纯函数可测；调用方据此留日志）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildDelivery {
    /// 等待方收到了结果（正常路径）
    Delivered,
    /// 等待方已经走了，但登录页已经建出来了 → 已尽力关掉
    OrphanDiscarded,
    /// 等待方已经走了，登录页建出来了却没关掉（它可能还铺在主窗上）
    OrphanLeftBehind(String),
    /// 等待方已经走了，登录页也没建出来 → 没什么可清
    NothingBuilt,
}

/// 交付建页结果；没人接收时把已经建出来的登录页就地关掉。
/// 建页闭包可能在等待超时之后才执行，那时 `send` 会把建好的值原样还回来——正好是孤儿信号。
pub fn deliver_build_result<T, E>(
    sent: Result<(), std::sync::mpsc::SendError<Result<T, E>>>,
    discard: impl FnOnce(T) -> Result<(), String>,
) -> BuildDelivery {
    match sent {
        Ok(()) => BuildDelivery::Delivered,
        Err(std::sync::mpsc::SendError(Ok(webview))) => match discard(webview) {
            Ok(()) => BuildDelivery::OrphanDiscarded,
            Err(reason) => BuildDelivery::OrphanLeftBehind(reason),
        },
        Err(std::sync::mpsc::SendError(Err(_))) => BuildDelivery::NothingBuilt,
    }
}

/// 带退避删目录（WebView2 释放用户数据目录有延迟，一把删不掉是常态）：`None` = 已清干净。
/// 只交回原因，给人看的文案由 [`ShutdownFailure::DataDir`] 按分级组装。
pub fn remove_dir_with_backoff(dir: &Path) -> Option<String> {
    let mut last = String::from("未知原因");
    for attempt in 0..DELETE_ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return None,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return None,
            Err(source) => {
                last = source.to_string();
                let backoff = DELETE_BACKOFF_MS << attempt;
                std::thread::sleep(Duration::from_millis(backoff));
            }
        }
    }
    Some(last)
}

/// 建页失败路径的目录善后（删除器注入，好测"删不掉"那一半），与收尾路径共用 [`shutdown_failures`] 的分级。
pub fn abandon_build_data_dir_with(
    data_dir: &Path,
    remove: impl FnOnce(&Path) -> Option<String>,
) -> Vec<ShutdownFailure> {
    shutdown_failures(&ShutdownOutcome {
        data_dir: remove(data_dir),
        ..Default::default()
    })
}

/// 建页失败时 [`shutdown_login_view`] 不会被调用（它只接在"建页成功"之后），所以这里要删掉那次的目录。
/// 目录里可能有 cookie；只有真删不掉才按 [`ShutdownFailure::DataDir`] 广播 `app:notice`。
pub fn abandon_build_data_dir(data_dir: &Path) -> Vec<ShutdownFailure> {
    abandon_build_data_dir_with(data_dir, remove_dir_with_backoff)
}

/// 向渲染层发一条 `app:notice`（宿主级提示：登录页收尾没做完）。
///
/// 复用 `apply_effect` 的广播路径（判定与入队在同一个加锁方法里完成，渲染层没就绪就先排队）。
fn announce_failure(app: &AppHandle, shared: &Arc<CoreShared>, text: &str) {
    crate::commands::apply_effect(
        app,
        shared,
        Effect::Emit {
            channel: APP_NOTICE.to_string(),
            payload: json!({ "text": text }),
        },
    );
}

/// 把结论写成响应帧（同一 id 只写一次，二次写会被桥拒掉并留日志）。
fn respond(shared: &Arc<CoreShared>, request_id: &str, result: Result<Value, CoreError>) {
    if !shared.respond(request_id, result) {
        log::warn!("登录结论未能交付（{request_id}）：等待方可能已经收场");
    }
}

/// 焦点/前台的唯一闸门：后台验证开关下登录链路一次都不许把窗口端到用户眼前。
fn foreground_allowed() -> bool {
    !crate::background_test()
}

/// 并排第二次登录要把既有登录页和主窗一起拉到前台：只聚焦 webview 不够，用户可能正把整个应用最小化着。
/// 主窗那一段与托盘「显示窗口」/ 单实例共用 [`crate::focus_main`]，两处必须同一语义。
fn focus_login_view(app: &AppHandle) {
    if !foreground_allowed() {
        log::info!("后台验证开关生效：并排登录不拉主窗到前台");
        return;
    }
    crate::focus_main(app);
    if let Some(webview) = app.get_webview(LOGIN_WEBVIEW_LABEL) {
        let _ = webview.show();
        let _ = webview.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 登录体验的两个浮动控件（返回 / 主题）：label 两两不同，入口是同一个本地页面。
    #[test]
    fn the_login_chrome_widgets_are_two_distinct_labels_on_one_entry_page() {
        assert_eq!(LOGIN_RETURN_WEBVIEW_LABEL, "login-return");
        assert_eq!(LOGIN_THEME_WEBVIEW_LABEL, "login-theme");
        assert_eq!(
            LOGIN_CHROME_LABELS,
            [LOGIN_RETURN_WEBVIEW_LABEL, LOGIN_THEME_WEBVIEW_LABEL]
        );

        // 两个控件与登录页、主窗的 label 必须两两不同：守卫就是按 label 判来源的
        for label in LOGIN_CHROME_LABELS {
            assert_ne!(label, LOGIN_WEBVIEW_LABEL, "控件与官方登录页的 label 不许相同");
            assert_ne!(label, crate::MAIN_WINDOW_LABEL, "控件与主窗的 label 不许相同");
        }
        assert_ne!(LOGIN_RETURN_WEBVIEW_LABEL, LOGIN_THEME_WEBVIEW_LABEL);

        // 入口与 kind（与 src/shared/login-chrome.mjs 逐字相同，由 Node 侧 parity 用例互钉）
        assert_eq!(LOGIN_CHROME_ENTRY, "login-chrome.html");
        assert_eq!(LOGIN_CHROME_KIND_RETURN, "return");
        assert_eq!(LOGIN_CHROME_KIND_THEME, "theme");
        assert_eq!(chrome_url(LOGIN_CHROME_KIND_RETURN), "login-chrome.html?kind=return");
        assert_eq!(chrome_url(LOGIN_CHROME_KIND_THEME), "login-chrome.html?kind=theme");
    }

    /// 浮动控件只许停在应用自己的本地页面上（安全前提：它们的 label 已在可信来源集合里，
    /// 一旦能导航到任意网页，那个网页就拿到了改主题 / 取消登录的资格）。
    #[test]
    fn a_chrome_widget_may_only_stay_on_the_apps_own_pages() {
        for allowed in [
            "tauri://localhost/login-chrome.html?kind=return",
            "http://localhost:1420/login-chrome.html?kind=theme",
            "http://tauri.localhost/login-chrome.html?kind=theme",
            "https://localhost/login-chrome.html?kind=return",
            "  http://127.0.0.1:1420/login-chrome.html  ",
        ] {
            assert!(chrome_navigation_allowed(allowed), "本地页面应当放行：{allowed}");
        }
        for blocked in [
            "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize",
            "https://evil.example.com/",
            "http://localhost.evil.com/login-chrome.html",
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "",
            "   ",
            "不是 URL",
        ] {
            assert!(!chrome_navigation_allowed(blocked), "只许本地：{blocked} 必须拦下");
        }
    }

    #[test]
    fn scheme_of_is_the_text_before_the_double_slash() {
        assert_eq!(scheme_of("hms://redirect_uri"), "hms");
        assert_eq!(scheme_of("https://example.invalid/"), "https");
        assert_eq!(scheme_of("javascript:alert(1)"), "");
        assert_eq!(scheme_of(""), "");
        assert_eq!(scheme_of("mailto:a@b"), "");
    }

    #[test]
    fn partition_gate_rejects_everything_that_could_leave_the_directory() {
        for good in ["a", "A0_-z", &"x".repeat(PARTITION_MAX_LEN)] {
            assert!(partition_is_safe(good), "应当接受：{good}");
        }
        for bad in [
            "",
            "..",
            ".",
            "../main",
            "a/b",
            "a\\b",
            "a b",
            "a\u{0}b",
            "%2e%2e",
            "登录",
            &"x".repeat(PARTITION_MAX_LEN + 1),
        ] {
            assert!(!partition_is_safe(bad), "应当拒绝：{bad:?}");
        }
    }

    #[test]
    fn login_data_dir_is_three_levels_below_the_root() {
        let root = Path::new("C:\\root");
        assert_eq!(
            login_data_dir(root, "p1"),
            Path::new("C:\\root").join("webview2").join("login").join("p1")
        );
    }

    #[test]
    fn messages_for_the_two_deadlines_differ() {
        assert_ne!(LOGIN_LOAD_TIMEOUT_MESSAGE, LOGIN_TOTAL_TIMEOUT_MESSAGE);
        assert!(LOGIN_LOAD_DEADLINE_SECS < LOGIN_TIMEOUT_SECS);
    }

    #[test]
    fn concluding_status_words_are_the_wire_contract() {
        assert_eq!(LoginConclusion::Cancelled.status(), "cancelled");
        assert_eq!(LoginConclusion::Closed.status(), "closed");
        assert_eq!(LoginConclusion::TimedOut.status(), "timed_out");
        assert_eq!(
            LoginConclusion::LoadFailed {
                message: LOGIN_LOAD_TIMEOUT_MESSAGE.to_string()
            }
            .status(),
            "load_failed"
        );
        assert_eq!(
            LoginConclusion::Callback {
                url: "hms://redirect_uri?code=C".to_string()
            }
            .status(),
            "callback"
        );
    }

    #[test]
    fn remove_dir_with_backoff_tolerates_missing_and_removes_real_dirs() {
        let missing = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("hwmusic-login-not-there");
        assert_eq!(remove_dir_with_backoff(&missing), None, "本来就不存在 = 已经清干净");

        // 用构建目录下的临时路径：`std::env::temp_dir()` 在受限环境里不可写（本机验证过 code 5），
        // 而"能不能删掉一棵真实的目录树"正是这条用例要钉的事。
        let real = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("login-backoff-test-{}", std::process::id()));
        std::fs::create_dir_all(real.join("EBWebView").join("Default")).expect("能建测试目录");
        std::fs::write(real.join("EBWebView").join("Default").join("Cookies"), b"x").expect("能写文件");
        assert_eq!(remove_dir_with_backoff(&real), None);
        assert!(!real.exists(), "退避删除要把整棵目录删掉");
    }

    #[test]
    fn waiting_on_an_unsettled_session_times_out_instead_of_hanging() {
        let session = LoginSession::new();
        // 只断言超时的返回语义，不断言耗时：Windows 计时器粒度会让耗时下界偶发失败。
        assert_eq!(session.wait(Duration::from_millis(20)), None);
        assert_eq!(session.conclusion(), None, "超时返回不得凭空写入结论");
        assert!(!session.is_loaded(), "超时返回不得改动首载标志");
        assert!(session.settle(LoginConclusion::Closed), "超时之后槽仍可结算");
        assert_eq!(
            session.wait(Duration::from_secs(5)),
            Some(LoginConclusion::Closed),
            "结算之后等待立刻拿到结论（控制权交回后一切照旧）"
        );
    }

    /// 登录页零注入（只靠导航事件），且只加载外部官方页。
    /// 本地页面只有浮动控件能用：登录页一旦挂上它就等于自绘登录页、自实现登录协议。
    #[test]
    fn the_login_window_never_injects_scripts_into_the_official_page() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/login.rs"))
            .expect("要能读到自己的源码");
        let production = match source.find("#[cfg(test)]") {
            Some(cut) => &source[..cut],
            None => &source[..],
        };
        for forbidden in ["initialization_script(", ".eval(", "evaluate_script("] {
            assert!(
                !production.contains(forbidden),
                "登录页零注入：不得出现 {forbidden}（白名单与回调只靠导航事件）"
            );
        }
        assert!(
            production.contains("WebviewUrl::External("),
            "登录窗加载的是外部官方页（不是本地 App 页面）"
        );

        // 建登录页那一段（从 WebviewBuilder::new(LOGIN_WEBVIEW_LABEL) 到建浮动控件之前）
        let login_builder = production
            .find("WebviewBuilder::new(LOGIN_WEBVIEW_LABEL")
            .expect("登录页要由 WebviewBuilder 建");
        let chrome_builder = production
            .find("fn build_chrome_on_main_thread(")
            .expect("浮动控件的建窗要有具名函数");
        let login_section = &production[login_builder..chrome_builder];
        assert!(
            !login_section.contains("WebviewUrl::App("),
            "登录窗不得挂本地页面：那会变成「自绘登录页」，等于自实现登录协议"
        );
    }

    // -----------------------------------------------------------------------
    // 宿主是主窗里的第二个 webview，不是独立窗口。
    // -----------------------------------------------------------------------

    /// 生产代码那一段（`#[cfg(test)]` 之前）。源码扫描类用例共用它：
    /// 本模块自己的字面量也在同一文件里，不切掉就等于在扫自己。
    fn production_source() -> String {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/login.rs"))
            .expect("要能读到自己的源码");
        match source.find("#[cfg(test)]") {
            Some(cut) => source[..cut].to_string(),
            None => source,
        }
    }

    /// 登录页必须是主窗的子 webview（同窗第二个 webview），生产代码里不许再出现任何建窗 API。
    /// 扫的是字面量，所以这条注释也不写那两个标识符。
    #[test]
    fn the_login_page_is_hosted_as_a_child_webview_of_the_main_window() {
        let production = production_source();
        assert!(
            production.contains("WebviewBuilder::new("),
            "登录页要由 WebviewBuilder 建（同窗第二 webview）"
        );
        assert!(
            production.contains(".add_child("),
            "登录页要挂进主窗（Window::add_child），不是自己开一个窗"
        );
        for forbidden in ["WebviewWindowBuilder", "WebviewWindow"] {
            assert!(
                !production.contains(forbidden),
                "登录页不再是独立子窗：生产代码里不许出现 {forbidden}"
            );
        }
    }

    /// 来源守卫能区分登录页与主窗，靠的是 **webview label**（同窗之后窗口 label 恒为 `main`）。
    /// 两个 label 必须不同，否则登录页在命令层与主窗长得一模一样。
    #[test]
    fn the_login_webview_label_is_distinct_from_the_main_window_label() {
        assert_eq!(LOGIN_WEBVIEW_LABEL, "login");
        assert_ne!(
            LOGIN_WEBVIEW_LABEL,
            crate::MAIN_WINDOW_LABEL,
            "登录 webview 的 label 必须与主窗不同：相同就等于把来源守卫让出去"
        );
    }

    /// 登录页铺满整个客户区（顶部那条让位已退役）；前提是入参为客户区量得到的尺寸。
    #[test]
    fn layout_target_fills_the_whole_client_area() {
        let target = layout_target(1280.0, 800.0);
        assert_eq!(target.x, 0.0, "同窗 webview 里不存在屏幕 x 偏移");
        assert_eq!(target.y, 0.0, "R25：顶部不再让出那一条（官方页铺满整窗）");
        assert_eq!(target.width, 1280.0, "宽度铺满客户区");
        assert_eq!(target.height, 800.0, "高度铺满客户区（不再是 800-48）");

        // 客户区**真的小**（量得到，只是小）时仍然钳制：绝不交出零尺寸（set_size 会失败/建出畸形块）
        let squashed = layout_target(1.0, 1.0);
        assert_eq!(squashed.width, MIN_LOGIN_WIDTH);
        assert_eq!(squashed.height, MIN_LOGIN_HEIGHT);
        for bad in [f64::NAN, f64::INFINITY, -5.0] {
            let target = layout_target(bad, bad);
            assert!(target.x.is_finite() && target.y.is_finite());
            assert!(target.width >= MIN_LOGIN_WIDTH && target.height >= MIN_LOGIN_HEIGHT);
        }
    }

    /// 浮动控件贴在客户区两个上角、留固定边距，尺寸与边距都按缩放比放大。
    #[test]
    fn chrome_widgets_sit_in_the_two_top_corners() {
        let [back, theme] = chrome_rects(1280.0, 800.0, 1.0);
        assert_eq!((back.x, back.y), (CHROME_MARGIN, CHROME_MARGIN), "返回控件在左上角");
        assert_eq!((back.width, back.height), RETURN_CHROME_SIZE, "盒子就是控件那么大");
        assert_eq!(theme.y, CHROME_MARGIN, "主题控件贴着上沿");
        assert_eq!(
            theme.x,
            1280.0 - CHROME_MARGIN - THEME_CHROME_SIZE.0,
            "主题控件贴右沿（右上角）"
        );
        assert_eq!((theme.width, theme.height), THEME_CHROME_SIZE);

        // 两个控件不许重叠（窗口宽到放得下时）
        assert!(
            back.x + back.width <= theme.x,
            "两个控件不许叠在一起：{:?} vs {:?}",
            back,
            theme
        );

        // 200% 缩放：尺寸与边距一起翻倍（它们是 CSS 像素，几何要物理像素）
        let [back2, theme2] = chrome_rects(1280.0, 800.0, 2.0);
        assert_eq!(back2.width, RETURN_CHROME_SIZE.0 * 2.0);
        assert_eq!(back2.x, CHROME_MARGIN * 2.0);
        assert_eq!(theme2.width, THEME_CHROME_SIZE.0 * 2.0);
        assert_eq!(theme2.x, 1280.0 - CHROME_MARGIN * 2.0 - THEME_CHROME_SIZE.0 * 2.0);

        // 缩放比不可信时按 1 算（与 ClientArea::trusted_scale 同一条纪律）
        let [fallback, _] = chrome_rects(1280.0, 800.0, f64::NAN);
        assert_eq!(fallback.width, RETURN_CHROME_SIZE.0);

        // 窗口窄到放不下：夹进客户区，且仍然是正尺寸（不许摆到客户区之外——那样就点不到了）
        let [narrow_back, narrow_theme] = chrome_rects(200.0, 800.0, 1.0);
        for rect in [narrow_back, narrow_theme] {
            assert!(rect.width >= 1.0 && rect.height >= 1.0, "退化尺寸也要是正的：{rect:?}");
            assert!(rect.x >= 0.0 && rect.x + rect.width <= 200.0, "不许越过客户区右沿：{rect:?}");
        }
    }

    // -----------------------------------------------------------------------
    // 几何的输入可能"量不到"（最小化时是 (0,0)）：那一档没有尺寸，不许钳成假尺寸；
    // 量得到时物理像素原样用、不减任何 inset（登录页铺满整窗）。
    // -----------------------------------------------------------------------

    /// 量得到：客户区物理尺寸 → 客户区相对矩形（**不减任何 inset**）。
    #[test]
    fn a_measurable_client_area_converts_to_the_client_relative_rect() {
        let area = ClientArea {
            width: 1280.0,
            height: 800.0,
            scale: 1.0,
            minimized: false,
        };
        assert_eq!(
            layout_for(&area),
            Layout::Target(Rect {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
            "R25：登录页铺满整个客户区（真机 1280×800 → rect=(0,0,1280,800)）"
        );

        // 200% 缩放：客户区尺寸是**物理**像素（原样用，不缩放）
        let hidpi = ClientArea { scale: 2.0, ..area };
        assert_eq!(
            layout_for(&hidpi),
            Layout::Target(Rect {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            })
        );
    }

    /// 量不到时（最小化下 `inner_size()` 是 (0,0)）没有几何，不许拿钳制下限凑一个。
    #[test]
    fn an_unmeasurable_client_area_is_not_a_size() {
        let minimized = ClientArea {
            width: 0.0,
            height: 0.0,
            scale: 1.0,
            minimized: true,
        };
        assert_eq!(layout_for(&minimized), Layout::HostUnmeasurable);

        // 半边为 0、非有限、负数同样是"量不到"（合成器偶发退化值不当尺寸用）
        for (width, height) in [
            (0.0, 800.0),
            (1280.0, 0.0),
            (f64::NAN, 800.0),
            (1280.0, f64::INFINITY),
            (-1.0, -1.0),
        ] {
            let area = ClientArea {
                width,
                height,
                scale: 1.0,
                minimized: false,
            };
            assert_eq!(
                layout_for(&area),
                Layout::HostUnmeasurable,
                "({width},{height}) 不是尺寸"
            );
        }

        // 缩放比不可信时按 1 算：客户区量得到就照摆，不因缩放退化放弃跟随
        let no_scale = ClientArea {
            width: 1280.0,
            height: 800.0,
            scale: f64::NAN,
            minimized: false,
        };
        assert_eq!(
            layout_for(&no_scale),
            Layout::Target(Rect {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            })
        );
    }

    /// 钳制下限的**正当**用途：主窗真的被压小了（量得到，只是小）。
    #[test]
    fn a_measurable_but_tiny_client_area_is_still_clamped() {
        let tiny = ClientArea {
            width: 300.0,
            height: 180.0,
            scale: 1.0,
            minimized: false,
        };
        assert_eq!(
            layout_for(&tiny),
            Layout::Target(Rect {
                x: 0.0,
                y: 0.0,
                width: MIN_LOGIN_WIDTH,
                height: 180.0,
            }),
            "宽度低于下限要钳到 320；高度 180 在下限之上，照原样"
        );

        let smaller = ClientArea { width: 100.0, height: 100.0, ..tiny };
        assert_eq!(
            layout_for(&smaller),
            Layout::Target(Rect {
                x: 0.0,
                y: 0.0,
                width: MIN_LOGIN_WIDTH,
                height: MIN_LOGIN_HEIGHT,
            })
        );
    }

    /// 建窗那一次要把原始读数整行留在日志里，只看到钳过的结果就没法诊断。
    #[test]
    fn the_raw_client_area_reading_is_what_the_log_says() {
        let minimized = ClientArea {
            width: 0.0,
            height: 0.0,
            scale: 1.0,
            minimized: true,
        };
        assert_eq!(minimized.describe(), "inner_size=(0,0) scale=1 minimized=true");
        let good = ClientArea {
            width: 1280.0,
            height: 800.0,
            scale: 1.25,
            minimized: false,
        };
        assert_eq!(good.describe(), "inner_size=(1280,800) scale=1.25 minimized=false");
    }

    /// 跟随每 250ms 一次，只在状态翻转那次说话（摆进 / 屏外 / 量不到三档各说各的）。
    #[test]
    fn the_follow_log_speaks_once_per_state_change() {
        let mut note = FollowNote::default();
        assert!(note.observe(FollowState::Applied), "第一次就要说（真机要能看出当时量到了多大）");
        assert!(!note.observe(FollowState::Applied), "同状态不重复");
        assert!(note.observe(FollowState::Offscreen), "屏外这一档要自己说一句");
        assert!(!note.observe(FollowState::Offscreen), "一直在屏外也不刷屏");
        assert!(note.observe(FollowState::Unmeasurable), "翻转要说话");
        assert!(!note.observe(FollowState::Unmeasurable), "持续量不到也不刷屏");
        assert!(note.observe(FollowState::Applied), "恢复要说话");
    }

    /// 源码钉子：两路都**不许**把"量不到"当尺寸用——
    /// 创建路先恢复主窗再量一次，跟随路把"量不到"当成一档结果（保持现有几何）。
    #[test]
    fn neither_path_turns_an_unmeasurable_host_into_a_clamped_page() {
        let production = production_source();
        assert!(
            production.contains("read_client_area("),
            "原始读数只该有一个来源（read_client_area）"
        );
        assert!(
            production.matches("layout_for(").count() >= 2,
            "创建路与跟随路都要走同一个决策函数（量不到那一档不许绕过）"
        );
        assert!(
            production.contains("crate::focus_main("),
            "创建路量不到时先把主窗恢复/拉到前台（与 focus_login_view 同一条纪律）"
        );
        assert!(
            production.contains("HostUnmeasurable"),
            "跟随路把「量不到」当一档结果：保持登录页现有几何，不用钳制下限覆盖它"
        );
    }

    /// 后台验证开关下，登录链路一次都不许拿走焦点或把主窗拉到前台。
    #[test]
    fn the_background_test_switch_gates_every_foreground_action_in_the_login_path() {
        let production = production_source();
        let gate = production
            .find("fn foreground_allowed")
            .expect("登录链路要有一个焦点闸门（两处各判一次早晚会漏一处）");
        let gate_body = &production[gate..];
        let gate_body = &gate_body[..gate_body.find("\n}\n").unwrap_or(gate_body.len())];
        assert!(
            gate_body.contains("crate::background_test()"),
            "闸门读的是后台验证开关"
        );
        assert!(
            production.matches("foreground_allowed()").count() >= 3,
            "闸门定义 + 建页聚焦 + 并排登录三处都要用它"
        );
        let start = production
            .find("fn focus_login_view")
            .expect("找不到并排登录的聚焦入口");
        let window = &production[start..];
        let window = &window[..window.find("\n}\n").unwrap_or(window.len())];
        let guard = window.find("foreground_allowed()").expect("先看闸门");
        assert!(
            guard < window.find("crate::focus_main(").expect("正常启动要把主窗拉到前台"),
            "闸门必须挡在拉主窗之前"
        );
    }

    /// 浮动控件必须建在登录页之后（后建的子窗在 z 序上层），并且与登录页同生同灭。
    #[test]
    fn the_chrome_widgets_are_built_after_the_login_page_and_torn_down_with_it() {
        let production = production_source();

        // 顺序：`add_child` 建登录页那一段必须**排在**两个控件的建窗调用之前
        //（用 kind 字面量定位调用点：label 常量在文件开头的数组里也出现过）
        let login_child = production
            .find("WebviewBuilder::new(LOGIN_WEBVIEW_LABEL")
            .expect("登录页要由 WebviewBuilder 建");
        let return_chrome = production
            .find("LOGIN_CHROME_KIND_RETURN,")
            .expect("返回控件的建窗调用要在生产代码里");
        let theme_chrome = production
            .find("LOGIN_CHROME_KIND_THEME,")
            .expect("主题控件的建窗调用要在生产代码里");
        assert!(
            login_child < return_chrome && login_child < theme_chrome,
            "浮动控件必须建在登录页**之后**：后建的子窗在 z 序上面，否则它们会沉到官方页底下"
        );

        // 透明 + 本地页面 + 导航闸门：三条都在建控件那一个函数里
        let chrome_builder = production
            .find("fn build_chrome_on_main_thread(")
            .expect("浮动控件的建窗要有一个具名函数");
        let body = &production[chrome_builder..];
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        assert!(
            body.contains("tauri::webview::Color(0, 0, 0, 0)"),
            "浮动控件要透明（铺底色会盖住官方页一块）：{body}"
        );
        assert!(
            body.contains("WebviewUrl::App("),
            "浮动控件加载的是应用自己的本地页面（不是外部网页）"
        );
        assert!(
            body.contains("chrome_navigation_allowed("),
            "浮动控件的导航闸门必须接上（它手里握着 core_login_chrome 的来源资格）"
        );

        // 同生同灭：收尾那一条链里必须出现 close_login_chrome
        assert!(
            production.matches("close_login_chrome(").count() >= 3,
            "收尾、孤儿清理、建页超时三条路都要收掉浮动控件"
        );
        assert!(
            production.contains("close_login_chrome"),
            "收尾要连浮动控件一起收"
        );
    }

    /// 返回控件建不起来就按结构化错误收场：官方页铺满整窗时它是唯一的回退路径。
    #[test]
    fn a_missing_return_widget_fails_the_login_instead_of_trapping_the_user() {
        let production = production_source();
        let build = production
            .find("if let Err(error) = build_chrome_on_main_thread(")
            .expect("返回控件的建窗要单独处置");
        let block = &production[build..];
        let block = &block[..block.find("\n    if let Err(error) = build_chrome_on_main_thread(").unwrap_or(block.len())];
        assert!(
            block.contains("return Err(error)"),
            "返回控件失败要按结构化错误收场（否则用户被困在一个没有出口的登录页上）：{block}"
        );

        // 主题控件相反：失败只留痕（登录照常）
        let theme = production
            .rfind("if let Err(error) = build_chrome_on_main_thread(")
            .expect("主题控件的建窗也要单独处置");
        let theme_block = &production[theme..];
        assert!(
            theme_block.contains("log::warn!") && !theme_block.contains("return Err(error)"),
            "主题控件失败不该让登录失败（它只是少一个便利入口）"
        );
    }

    // -----------------------------------------------------------------------
    // 登录窗白屏的诊断设施：导航日志留页面、丢参数值。
    // -----------------------------------------------------------------------

    #[test]
    fn navigation_log_keeps_the_page_but_drops_every_query_value() {
        // 诊断要的是"哪一页"，凭据要的是"值不进日志"：这两件事必须同时成立
        let described = describe_navigation_for_log(
            "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?response_type=code&client_id=101444301&code_challenge=SECRET-CHALLENGE&state=SECRET-STATE",
        );
        assert_eq!(
            described,
            "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?response_type,client_id,code_challenge,state"
        );
        assert!(!described.contains("SECRET"), "查询参数的值一律不进日志");
    }

    #[test]
    fn navigation_log_describes_the_cas_landing_page_and_the_callback() {
        // id1 的 CAS 门户页是登录链的真实落点，诊断"窗里停在哪一页"全靠它
        let cas = describe_navigation_for_log(
            "https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html?reqClientType=90&service=https%3A%2F%2Foauth-login1.cloud.huawei.com%2Foauth2%2Fv3%2FloginCallback%3Fcode%3DSECRET",
        );
        assert!(cas.starts_with("https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html?reqClientType,service"));

        // `hms://` 回调：scheme+authority 保留、code 的值不留
        assert_eq!(
            describe_navigation_for_log("hms://redirect_uri?code=SECRET&state=SECRET2"),
            "hms://redirect_uri?code,state"
        );
    }

    #[test]
    fn navigation_log_is_bounded_and_tolerates_junk() {
        assert_eq!(describe_navigation_for_log(""), "(空 URL)");
        assert_eq!(describe_navigation_for_log("   "), "(空 URL)");
        assert_eq!(describe_navigation_for_log("https://host/path?a=1"), "https://host/path?a");

        // 段数超过上限时截断并标记（8 个参数名 + "…"）
        let many: Vec<String> = (0..20).map(|index| format!("p{index}=v")).collect();
        let described = describe_navigation_for_log(&format!("https://host/path?{}", many.join("&")));
        assert!(described.ends_with(",…"), "超出上限要看得出来被截过：{described}");
        assert_eq!(described.matches(',').count(), 8, "参数名最多保留 8 个：{described}");

        // 超长 URL 截断，且不截出半个字符
        let long = format!("https://host/{}", "长".repeat(500));
        let described = describe_navigation_for_log(&long);
        assert!(described.chars().count() <= MAX_URL_LOG_CHARS);
        assert!(described.ends_with('…'));

        // 片段不进日志
        assert_eq!(describe_navigation_for_log("https://host/p#section"), "https://host/p");
    }

    #[test]
    fn navigation_log_labels_match_the_decisions() {
        assert_eq!(navigation_for("https://id1.cloud.huawei.com/CAS/portal/loginAuth.html").log_label(), "allow");
        assert_eq!(navigation_for("https://evil.example.com/").log_label(), "block");
        assert_eq!(navigation_for("hms://redirect_uri?code=C").log_label(), "callback");
    }

    // -----------------------------------------------------------------------
    // 登录页先摆在屏外加载（门禁底下显示加载动画），静默窗走完才摆进内容区。
    // -----------------------------------------------------------------------

    /// 登录页先摆在客户区左沿之外，一个像素都不露，门禁底下显示加载动画。
    #[test]
    fn the_login_page_is_built_offscreen_out_of_the_client_area() {
        let target = layout_target(1280.0, 800.0);
        let offscreen = offscreen_rect(target);
        assert!(
            offscreen.x < 0.0 && offscreen.x + offscreen.width <= 0.0,
            "整个矩形要在客户区左沿之外（子窗被父窗客户区裁剪，一个像素都露不出来）：{offscreen:?}"
        );
        assert_eq!(
            (offscreen.y, offscreen.width, offscreen.height),
            (target.y, target.width, target.height),
            "屏外只改 x：摆进来时 `set_position` 一处到位，尺寸不用再动"
        );

        // 尺寸退化（NaN）也不许交出 NaN 几何
        let degenerate = offscreen_rect(Rect { x: 0.0, y: 0.0, width: f64::NAN, height: 100.0 });
        assert!(degenerate.x.is_finite() && degenerate.x < 0.0, "{degenerate:?}");
    }

    /// 摆进内容区之前一直算"屏外"，摆进来之后才算"内容区"——跟随主窗几何的前置条件。
    /// 首载标志（解除首载期限）与摆放标志是**两件事**：前者管期限，后者管几何。
    #[test]
    fn the_session_stays_offscreen_until_it_is_placed() {
        let session = LoginSession::new();
        assert_eq!(session.placement(), Placement::Offscreen, "刚建出来时摆在屏外等加载");
        assert!(!session.is_placed());
        assert!(!session.is_quiet(), "还没 Finished 过：谈不上静默");

        assert!(session.mark_loaded(), "首载完成：解除首载期限（整个登录期间只记第一次）");
        assert!(!session.mark_loaded(), "重复上报不是新的首载");
        assert!(session.is_loaded());

        assert!(session.mark_placed());
        assert!(!session.mark_placed(), "幂等");
        assert_eq!(session.placement(), Placement::InContent, "摆进来之后才跟随主窗几何");
    }

    /// 页不在就如实判 `Closed`，别让等待方挂到总期限。
    #[test]
    fn a_missing_login_page_is_a_closed_conclusion() {
        assert_eq!(vanish_conclusion(true), None, "页还在就没有「没了」这回事");
        assert_eq!(
            vanish_conclusion(false),
            Some(LoginConclusion::Closed),
            "页不在了：如实判 Closed（等待方绝不该挂到总期限）"
        );
    }

    /// 摆放那一支要**只在状态翻转时说话**：主窗最小化时 `place_login_view` 会一直失败到主窗回来，
    /// 每 250ms 一条警告刷到总期限（10 分钟）就是几千行废话。
    #[test]
    fn the_placement_branch_only_speaks_when_the_state_changes() {
        let production = production_source();
        let wait = production
            .find("fn wait_for_conclusion(")
            .expect("等待方的正体要还在");
        let wait = &production[wait..];
        let wait = &wait[..wait.find("\nfn place_login_view(").unwrap_or(wait.len())];
        assert!(
            wait.contains("placement_note.observe("),
            "摆放那一支也要只在状态翻转时说话（否则最小化期间每 250ms 一条警告）：{wait}"
        );
    }

    /// 静默窗必须真的接在页面事件上：Finished 起窗，Started 与放行的导航都撤窗。
    #[test]
    fn the_quiet_window_is_wired_to_the_page_load_and_navigation_events() {
        let production = production_source();

        let page_load = production.find(".on_page_load(").expect("页面加载回调还在");
        let page_load = &production[page_load..];
        let started = page_load
            .find("PageLoadEvent::Started")
            .expect("Started 那一支还在");
        let finished = page_load
            .find("PageLoadEvent::Finished")
            .expect("Finished 那一支还在");
        assert!(started < finished, "两个分支的顺序不该被改（这条钉子按它切段）");
        assert!(
            page_load[started..finished].contains("note_navigation_started("),
            "`Started` 那一支里要撤窗（新的一次加载开始了）：{}",
            &page_load[started..finished]
        );
        assert!(
            page_load[finished..].contains("note_page_finished("),
            "`Finished` 那一支里要起窗：{}",
            &page_load[finished..]
        );

        let navigation = production.find(".on_navigation(").expect("导航回调还在");
        let navigation = &production[navigation..];
        let navigation =
            &navigation[..navigation.find(".on_new_window(").unwrap_or(navigation.len())];
        assert!(
            navigation.contains("note_navigation_started("),
            "放行的导航也要撤窗（那是用户报的那条链上的那一跳）：{navigation}"
        );
    }

    // -----------------------------------------------------------------------
    // 官方登录页不跟随应用主题、不改移动端 UA；下面两条只检查 #[cfg(test)] 之前的生产代码。
    // -----------------------------------------------------------------------

    /// 官方页一个主题相关标识符都不许剩：半迁移残留比彻底没有更误导下一个人。
    #[test]
    fn the_official_login_page_carries_no_theme_mechanism_at_all() {
        let production = production_source();
        for forbidden in [
            "themeName",
            "LOGIN_THEME_PARAM",
            "LOGIN_THEME_NAME_",
            "with_theme_name",
            "login_theme_name",
            "effective_login_theme",
            "system_is_dark",
            "reapply_login_theme",
            "rebuild_login_view",
            "reopen_login_view",
            "begin_rebuild",
            "end_rebuild",
            "LoginBuildSpec",
            "ThemeChoice",
        ] {
            assert!(
                !production.contains(forbidden),
                "R28 用户指令：官方页不再跟随应用主题，这套机制要删干净——生产代码里不许再有 {forbidden}"
            );
        }
        // 禁令只针对官方页：`login-theme` 浮动控件是自家 UI，仍跟随应用主题。
        assert!(
            production.contains("LOGIN_THEME_WEBVIEW_LABEL"),
            "主题浮动控件与官方页的主题机制是两件事：前者留着（自家 UI），后者删掉"
        );
    }

    /// 建窗不设 user_agent，走 WebView2 默认桌面 UA；同时钉住生产代码不留任何移动 UA 字面量。
    #[test]
    fn the_login_webview_keeps_the_host_default_user_agent() {
        let production = production_source();
        assert!(
            !production.contains(".user_agent("),
            "R28 用户指令：不再伪装 UA——建窗时不设 user_agent，WebView2 走自己的默认桌面 UA"
        );
        for forbidden in ["LOGIN_MOBILE_UA", "HarmonyOS", "Mobile Safari"] {
            assert!(
                !production.contains(forbidden),
                "移动 UA 要删干净（{forbidden} 一个都不许留）"
            );
        }
    }

    /// 摆进内容区要等静默窗走完（每次 Finished 起窗、窗内出现新导航就撤窗），首载期限到点则兜底摆进。
    /// 时间全部注入，1.5 秒的窗口靠 sleep 测不出来。
    #[test]
    fn the_login_page_is_placed_only_after_a_quiet_window() {
        let base = Instant::now();
        let after = |ms: u64| base + Duration::from_millis(ms);
        let window = LOGIN_QUIET_WINDOW_MS;

        // 纯函数那一层：静默满一整窗才算"页面安静下来了"（差一毫秒都不算）
        assert!(!quiet_window_passed(Duration::from_millis(window - 1)), "差一毫秒不算静默");
        assert!(quiet_window_passed(Duration::from_millis(window)));
        assert!(placement_due(true, Duration::ZERO), "静默窗走完 → 摆进");
        assert!(
            !placement_due(false, Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS - 1)),
            "既不静默、期限也没到 → 留在屏外"
        );
        assert!(
            placement_due(false, Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS)),
            "首载期限到 → 也摆进来（页面可能还在转，但让人对着加载动画干等更糟）"
        );

        // 关键场景：authorize 中间页 Finished 后，CAS 重定向在静默窗内起航 → 必须撤窗
        let session = LoginSession::new_at(base);
        assert_eq!(session.placement(), Placement::Offscreen, "刚建出来时摆在屏外等加载");
        assert!(!session.placement_due_at(base), "一个字都还没加载：不摆");
        assert!(!session.is_quiet_at(after(1_000)), "还没 Finished 过：谈不上静默");

        session.note_page_finished_at(after(1_000)); // authorize 中间页 Finished
        assert!(!session.placement_due_at(after(1_000 + window - 1)), "静默窗还没走完：不摆");
        assert!(
            session.note_navigation_started(),
            "窗内出现新导航（CAS 重定向起）→ 撤窗"
        );
        assert!(
            !session.note_navigation_started(),
            "同一个导航只撤一次（没有窗可撤时不重复报）"
        );
        assert!(!session.is_quiet_at(after(3_000)), "撤窗之后不再算静默");
        assert!(
            !session.placement_due_at(after(1_000 + window + 500)),
            "撤窗之后即使过了 1.5 秒也不摆——等的是**下一次** Finished（这正是用户报的那个提前结束）"
        );

        // CAS 页自己 Finished → 一整窗没有新导航 → 这才是"页面真的好了"，摆进
        session.note_page_finished_at(after(2_000));
        assert_eq!(
            session.placement(),
            Placement::Offscreen,
            "静默窗走完之前一直留在屏外（动画继续转）"
        );
        assert!(!session.placement_due_at(after(2_000 + window - 1)), "差一毫秒也不摆");
        assert!(
            session.placement_due_at(after(2_000 + window)),
            "静默窗走完 → 该摆进内容区了"
        );
        assert!(!session.is_placed());
        assert!(session.mark_placed());
        assert!(!session.mark_placed(), "幂等");
        assert_eq!(session.placement(), Placement::InContent, "摆进来之后才跟随主窗几何");

        // 期限兜底（不变）：一个 Finished 都没来也到点就摆
        let never = LoginSession::new_at(base);
        assert!(
            !never.placement_due_at(base + Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS - 1)),
            "差一秒到期限也不摆"
        );
        assert!(
            never.placement_due_at(base + Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS)),
            "到点即摆（页面可能还在转）"
        );
    }

}
