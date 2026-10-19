//! 登录子窗：把**华为官方授权页**铺在引导页正文位置，并把它变成一次可结算的登录尝试。
//!
//! 设计要点（每一条都对应旧仓踩过的坑，见 `docs/API_CONTRACT.md` §1.4/§1.6）：
//!
//! 1. **零命令权限**：`capabilities/main.json` 的 `windows` 里没有 `login`，因此官方页调不到本应用
//!    的任何命令；这里也不给它注入任何脚本（不订阅 `initialization_script`/`eval` 那条路），
//!    白名单与回调**只靠导航事件**观测。
//! 2. **白名单是显式条目**：`LOGIN_ALLOWED_ORIGINS`/`LOGIN_ALLOWED_URLS` 是 Node 侧
//!    `src/protocols/login-callback.mjs` 的镜像副本（Rust 无法 import .mjs），
//!    由 `test/login-parity.test.mjs` 双向钉住；漏条目就是旧仓"扫码成功后卡在 CAS 页"的根因。
//! 3. **`hms://` 一律拦下不请求**，并把**原样** URL 交给等待方：判真伪是 Node 侧 `isCallback`/
//!    `consumeCallback` 的唯一职责（宿主预滤或不预滤都安全，见契约 §1.6）。
//! 4. **双来源**（旧仓缺陷 C1）：导航拦截与窗口关闭两条路**都能**把结论交给等待方，
//!    结论槽是 take-once 的（先到者胜、后到者不改写）。只接一条路 → "扫码成功却等超时"。
//! 5. **双期限**：首载 [`LOGIN_LOAD_DEADLINE_SECS`] 秒打不开官方页 = 独立文案（多半是网络/代理），
//!    总 [`LOGIN_TIMEOUT_SECS`] 秒 = 扫码超时文案。两条文案不同，处置方式也不同。
//! 6. **一次性隔离**：每次登录一个随机 `partition` + 独立 webview 数据目录；收场后清浏览数据、
//!    退避删目录（WebView2 释放句柄有延迟）。下次登录是全新目录，不残留上一次的登录态。
//! 7. **不阻塞效果线程**：`host:open-login` 立刻返回，真正的等待与收尾在 `login-window` 线程里
//!    （阻塞效果线程会让随后的 `host:cancel-login` 永远送不进来）。
//!
//! **已知缺口（不硬绕）**：wry 0.57（tauri 2.12 的 webview 层）只注册 WebView2 的
//! `NavigationStarting`（主框架级），**没有** `FrameNavigationStarting`。官方页若从 **iframe**
//! 内部发起 `hms://` 跳转，本模块看不到（顶部框架的跳转与 302 都能看到）。关闭这个缺口要么等上游
//! 拿到帧级事件，要么注入脚本监听——后者是硬边界明令禁止的（登录页零注入），所以这里**如实记录**。
//! 兜底：即使回调从 iframe 走了、结论没收到，总期限（10 分钟）仍会收口，不会永久挂住。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::bridge::{CoreError, CoreShared, Effect, APP_NOTICE};
use crate::{MAIN_WINDOW_LABEL, WebviewDataRoot};

/// 登录窗 label（capabilities 里**故意不列**它：官方页零命令权限）。
pub const LOGIN_WINDOW_LABEL: &str = "login";

/// 顶部内缩（物理像素会按主窗缩放比换算）。
///
/// 唯一真源是 Node/渲染层共享的 `src/shared/login-inset.mjs`（48）；Rust 无法 import .mjs，
/// 只能镜像这一份字面量，由 `test/login-parity.test.mjs` 两侧互钉——**改任何一侧都要同步改另一侧**。
pub const LOGIN_VIEW_TOP_INSET: f64 = 48.0;

/// 总登录期限（秒）：与 Node `LOGIN_TIMEOUT_MS` 互钉（`LOGIN_TIMEOUT_SECS × 1000 == LOGIN_TIMEOUT_MS`）。
pub const LOGIN_TIMEOUT_SECS: u64 = 600;

/// 首载期限（秒）：官方页这么久都没加载完，多半是网络/代理问题，早点告诉用户比让他干等 10 分钟好。
pub const LOGIN_LOAD_DEADLINE_SECS: u64 = 30;

/// 首载超时文案（与 Node 侧 [`crate`] 的 `LOGIN_PAGE_UNAVAILABLE_MESSAGE` 逐字一致，parity 钉住）。
pub const LOGIN_LOAD_TIMEOUT_MESSAGE: &str = "无法打开华为官方登录页面，请检查网络或代理后重试。";

/// 总超时文案（与 Node 侧的 `LOGIN_TIMEOUT_MESSAGE` 逐字一致，parity 钉住）。
pub const LOGIN_TOTAL_TIMEOUT_MESSAGE: &str = "登录超时（10 分钟内未完成扫码），请重试。";

/// 并排第二次登录的提示（不并行开第二个窗：只把既有窗拉到前台）。
pub const LOGIN_IN_PROGRESS_MESSAGE: &str = "已有一次登录正在进行（已把登录窗口拉到前台）";

/// 回调 scheme 的镜像（Node 唯一真源是 `auth.mjs` 的 `OAUTH_REDIRECT_URI`）。
pub const CALLBACK_SCHEME: &str = "hms";

/// `topInset` 的合法上界：越界值静默接受会把窗摆到屏外，不如结构化拒掉。
pub const MAX_TOP_INSET: f64 = 4096.0;

/// `partition` 的字符集与长度（进文件系统之前必须过这一关）。
pub const PARTITION_MAX_LEN: usize = 64;

/// 几何钳制下限：主窗被外部压到退化尺寸时也不交出负高度（`set_size` 会失败或建出畸形窗）。
pub const MIN_LOGIN_HEIGHT: f64 = 160.0;
/// 几何钳制下限（宽）。
pub const MIN_LOGIN_WIDTH: f64 = 320.0;

/// 跟随主窗几何的轮询间隔：登录窗"铺在主窗内容区上"，主窗一动就要重算。
///
/// 为什么轮询而不是订阅主窗的 `WindowEvent`：tauri 每个窗口只有一个事件处理器，
/// 在 main 窗上注册会与后续任务（托盘 R11 / 歌词 R12 / 窗口状态）抢同一个槽位。
/// 代价是每 250 毫秒 4 次几何查询（可忽略），换掉一个跨任务的共享可变点。
const FOLLOW_TICK: Duration = Duration::from_millis(250);

/// 建窗任务投到主线程后的等待上限（主线程若在忙，宁可结构化失败也不要永久挂住）。
const BUILD_TIMEOUT: Duration = Duration::from_secs(10);

/// 删目录的退避次数与基数（WebView2 释放用户数据目录有延迟，一把删不掉是常态）。
const DELETE_ATTEMPTS: u32 = 5;
const DELETE_BACKOFF_MS: u64 = 50;

/// **导航白名单的镜像**（Node 侧唯一真源：`src/protocols/login-callback.mjs`）。
/// 显式条目表，不是 `*.huawei.com` 通配；条目由 parity 测试互钉。
pub const LOGIN_ALLOWED_ORIGINS: [&str; 2] = [
    "https://oauth-login1.cloud.huawei.com", // OAuth 授权/令牌服务域
    "https://login.cloud.huawei.com",        // 华为帐号登录（CAS 系）页面域
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

/// 抽 scheme：`hms://x` → `"hms"`；没有 `://` 就是空串（不是 URL 的形状）。
fn scheme_of(value: &str) -> &str {
    match value.find("://") {
        Some(index) => &value[..index],
        None => "",
    }
}

/// 导航白名单判定：先看 `hms://`（回调），再看 https 的显式条目。
///
/// 判定顺序是有意的：
/// - `hms://` 放在最前：它是**回调**不是页面，且必须在 URL 解析之前拦下（解析失败的不许漏成放行）；
/// - https 只看 `origin`（含端口）与精确 URL（`origin + path`），与 Node 侧 `isAllowedLoginUrl` 逐条对齐：
///   userinfo 显式拒（`origin` 会把它抹掉，光比 origin 会误放行 `https://user@host/`）。
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

/// 登录窗配置（`host:open-login` 的 payload）。
#[derive(Debug, Clone, PartialEq)]
pub struct LoginConfig {
    /// 官方授权页 URL（必须 https 且在导航白名单内）
    pub url: String,
    /// 一次性随机分区（`[A-Za-z0-9_-]{1,64}`）：独立 webview 数据目录的目录名
    pub partition: String,
    /// 顶部让出的高度（CSS 像素；两侧同一常量，但允许调用方显式指定）
    pub top_inset: f64,
}

fn invalid_payload(message: impl Into<String>) -> CoreError {
    CoreError::new("invalid_payload", message)
}

/// 坏形态一律结构化 `invalid_payload`，且**不复述入参内容**。
///
/// 为什么不回显 url：授权页 URL 里带着 `code_challenge`/`state`（回调 URL 还带 `code`），
/// 旧仓把整段 URL 打进错误消息与日志，等于把一次性凭据抄进了日志文件。这里只说"哪一条规则没过"。
pub fn parse_config(payload: &Value) -> Result<LoginConfig, CoreError> {
    let object = payload
        .as_object()
        .ok_or_else(|| invalid_payload("登录窗配置必须是 JSON 对象"))?;

    let url = match object.get("url") {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(_) => return Err(invalid_payload("url 必须是字符串")),
        None => return Err(invalid_payload("登录窗配置缺少 url")),
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
        None => return Err(invalid_payload("登录窗配置缺少 partition")),
    };
    if !partition_is_safe(&partition) {
        return Err(invalid_payload(format!(
            "partition 只接受 [A-Za-z0-9_-] 且长度 1..={PARTITION_MAX_LEN}（它要当目录名，越界写法一律拒）"
        )));
    }

    let top_inset = match object.get("topInset") {
        Some(value) => value
            .as_f64()
            .filter(|inset| inset.is_finite())
            .ok_or_else(|| invalid_payload("topInset 必须是有限数字"))?,
        None => return Err(invalid_payload("登录窗配置缺少 topInset")),
    };
    if !(0.0..=MAX_TOP_INSET).contains(&top_inset) {
        return Err(invalid_payload(format!(
            "topInset 必须在 0..={MAX_TOP_INSET} 之间（单位：CSS 像素）"
        )));
    }

    Ok(LoginConfig {
        url,
        partition,
        top_inset,
    })
}

/// `partition` 的字符集闸门：它要当目录名，所以只收 `[A-Za-z0-9_-]`。
///
/// `..`、`a/b`、`a\b`、`%2e%2e`、空白、非 ASCII 全都过不去——路径穿越在**进入文件系统之前**
/// 就断掉，而不是靠"事后检查目录名"。
pub fn partition_is_safe(partition: &str) -> bool {
    !partition.is_empty()
        && partition.len() <= PARTITION_MAX_LEN
        && partition
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 登录窗的 webview 数据目录：`<数据根>/webview2/login/<partition>`。
///
/// 与主窗数据根分开（主窗那份只给主窗用）：登录态、cookie、缓存都锁在这一个一次性目录里，
/// 收场即删；下次登录换一个 partition，天然隔离。
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
    /// 登录窗被关闭（用户关窗、系统关窗、应用退出）
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

/// 期限判定（纯函数）：此刻该结算成什么结论；`None` = 还该继续等。
///
/// - 首载没过 [`LOGIN_LOAD_DEADLINE_SECS`] 秒且还没加载完 → 首载失败（**独立文案**）；
/// - 到 [`LOGIN_TIMEOUT_SECS`] 秒 → 总超时（不论首载是否成功：扫码也可能一直不扫）。
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

/// 一次登录尝试的结论槽（take-once）+ 首载标志。
///
/// **双来源就在这里收口**：导航拦截、窗口关闭事件、关闭轮询兜底、期限判定、渲染层取消——
/// 五个生产者共用一个槽，谁先到谁算，后到的返回 `false` 且**不改写**已有结论。
/// 这样"扫码成功"与"窗被关掉"不会再各写各的，等待方也不必猜哪个是真的。
pub struct LoginSession {
    state: Mutex<SessionState>,
    changed: Condvar,
}

#[derive(Default)]
struct SessionState {
    conclusion: Option<LoginConclusion>,
    loaded: bool,
}

impl LoginSession {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SessionState::default()),
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

    /// 收尾：放开独占（拆窗完成后才调，避免新窗撞上正在拆除的 label）。幂等。
    pub fn finish(&self) {
        *lock(&self.active) = None;
    }

    pub fn session(&self) -> Option<Arc<LoginSession>> {
        lock(&self.active).clone()
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

/// 登录窗的目标几何：铺满主窗**内容区**，顶部让出 `top_inset`。
///
/// 钳制两条（主窗被外部压到退化尺寸时才会碰到）：
/// - 高度下限 [`MIN_LOGIN_HEIGHT`] / 宽度下限 [`MIN_LOGIN_WIDTH`]：绝不把负值或零交给 `set_size`；
/// - 非有限/负输入按 0 处理：合成器偶发退化值不该变成 NaN 几何。
pub fn layout_target(content: Rect, top_inset: f64) -> Rect {
    let sane = |value: f64| if value.is_finite() && value > 0.0 { value } else { 0.0 };
    let inset = sane(top_inset);
    let x = sane(content.x);
    let y = sane(content.y);
    let width = sane(content.width);
    let height = sane(content.height);
    Rect {
        x,
        y: y + inset,
        width: width.max(MIN_LOGIN_WIDTH),
        height: (height - inset).max(MIN_LOGIN_HEIGHT),
    }
}

// ---------------------------------------------------------------------------
// 建窗 / 等待 / 收尾（需要 tauri 运行时）
// ---------------------------------------------------------------------------

/// `host:open-login` 的入口（在效果线程上调用，**必须立刻返回**）。
///
/// 返回 `Ok(())` = 已交给 `login-window` 线程（它在窗收场后答复这一帧，调用方不得再写第二次）；
/// `Err` = 连窗都没开起来，结构化错误直接答复。
pub fn open_login(
    app: &AppHandle,
    shared: &Arc<CoreShared>,
    request_id: &str,
    payload: &Value,
) -> Result<(), CoreError> {
    let config = parse_config(payload)?;
    let data_root = app
        .try_state::<WebviewDataRoot>()
        .map(|state| state.0.clone())
        .ok_or_else(|| CoreError::new("internal", "数据根未登记：登录窗无法确定 webview 数据目录"))?;
    let state = app
        .try_state::<Arc<LoginState>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| CoreError::new("internal", "登录状态未登记（setup 未完成）"))?;

    let session = LoginSession::new();
    if !state.begin(Arc::clone(&session)) {
        focus_login_window(app);
        return Err(CoreError::new("login_in_progress", LOGIN_IN_PROGRESS_MESSAGE));
    }

    let login_data = login_data_dir(&data_root, &config.partition);
    let app_handle = app.clone();
    let shared = Arc::clone(shared);
    let request_id = request_id.to_string();
    // 线程里用一份 Arc，外面留一份用于"线程都起不来"这条路的收尾
    let thread_state = Arc::clone(&state);
    let spawned = std::thread::Builder::new()
        .name("login-window".to_string())
        .spawn(move || {
            run_login_window(
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
///
/// 返回值 = 本次是否真的收口了一次进行中的登录（`false` = 本来就没有进行中的登录——这**不是错误**：
/// 用户的意图"别等了"已经满足，重复点取消按钮不该看到一个报错）。
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

/// 登录线程的正体：建窗 → 等结论 → **先答复等待方** → 拆窗清理 → 放开独占。
fn run_login_window(
    app: AppHandle,
    shared: Arc<CoreShared>,
    request_id: String,
    config: LoginConfig,
    data_root: PathBuf,
    login_data: PathBuf,
    state: Arc<LoginState>,
    session: Arc<LoginSession>,
) {
    let window = match create_login_window(&app, &config, &data_root, &login_data, &session) {
        Ok(window) => window,
        Err(error) => {
            // 建窗失败**不是**登录结论，而是宿主错误：如实回结构化错误帧（带真实原因），
            // 而不是塞一句"打不开官方页，请检查网络或代理"——那是另一回事，处置方式也不同。
            // 用户点一次登录什么都没发生是最难排查的故障，所以这里必须留痕。
            log::warn!("登录窗建不起来：{error}");
            respond(&shared, &request_id, Err(error));
            state.finish();
            return;
        }
    };

    let conclusion = wait_for_conclusion(&app, &session, config.top_inset);

    // **先答复、再拆窗**（顺序是硬要求）：拆窗要删目录、要退避重试，可能失败；
    // 若因为拆窗失败而不答复，Node 侧就变成"扫码成功却等超时"——旧仓缺陷 C1 的另一种写法。
    respond(&shared, &request_id, Ok(conclusion.to_payload()));

    for failure in shutdown_window(&app, &window, &login_data) {
        if failure.needs_user_notice() {
            // 只有真残留才打扰用户（窗口还在 / 目录没删掉）。
            log::warn!("登录窗收尾失败（有残留）：{}", failure.message());
            announce_failure(&app, &shared, &failure.message());
        } else {
            // 窗口已经消失的路径上（vanish-poll 判 Closed，或收尾前用户/系统已关窗）
            // `clear_all_browsing_data`/`close` 必然失败，而整个一次性目录照样被删掉——
            // 这是预期失败，不是残留：只留日志，绝不弹一条让用户去清理一个刚被删掉的东西。
            log::warn!("登录窗收尾未竟（预期失败，不打扰用户）：{}", failure.message());
        }
    }
    state.finish();
}

/// 等结论：结论槽 + 窗口消失兜底 + 双期限 + 每 tick 跟随主窗几何。
fn wait_for_conclusion(app: &AppHandle, session: &Arc<LoginSession>, top_inset: f64) -> LoginConclusion {
    let started = Instant::now();
    let mut layout_warned = false;
    loop {
        if let Some(conclusion) = session.conclusion() {
            return conclusion;
        }
        // 窗口没了而结论槽还空着：兜底判 Closed（事件路径之外的第二条来源，绝不让等待方挂到超时）
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            session.settle(LoginConclusion::Closed);
            return session.conclusion().unwrap_or(LoginConclusion::Closed);
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
        if let Err(error) = follow_main_window(app, top_inset) {
            if !layout_warned {
                log::warn!("登录窗未能跟随主窗几何：{error}（后续不再重复记录）");
                layout_warned = true;
            }
        }
    }
}

/// 建窗（投到主线程执行：tao 的窗口创建要在事件循环线程上）。
fn create_login_window(
    app: &AppHandle,
    config: &LoginConfig,
    data_root: &Path,
    login_data: &Path,
    session: &Arc<LoginSession>,
) -> Result<WebviewWindow, CoreError> {
    let url = tauri::Url::parse(&config.url)
        .map_err(|_| invalid_payload("url 解析不了（parse_config 之后不该发生）"))?;

    // 目录必须先建：WebView2 不会自建，缺目录时建窗直接 `os error 5`（拒绝访问）。
    std::fs::create_dir_all(login_data).map_err(|source| {
        CoreError::new(
            "internal",
            format!("登录窗数据目录建不出来（{source}）：登录无法开始"),
        )
    })?;

    // 代理在**建窗时**读取一次 → 改代理要重启应用才生效（与主窗一致，R6 已知限制）。
    let proxy = crate::proxy_url_argument(crate::webview_proxy::resolve_for_webview(
        data_root,
        LOGIN_WINDOW_LABEL,
    ));

    let (sender, receiver) = std::sync::mpsc::channel();
    let app_for_build = app.clone();
    let url_for_build = url;
    let login_data_for_build = login_data.to_path_buf();
    let login_data_for_discard = login_data.to_path_buf();
    let nav_session = Arc::clone(session);
    let load_session = Arc::clone(session);
    let close_session = Arc::clone(session);
    let top_inset = config.top_inset;

    app.run_on_main_thread(move || {
        let built = build_on_main_thread(
            &app_for_build,
            url_for_build,
            login_data_for_build,
            proxy,
            nav_session,
            load_session,
            close_session,
            top_inset,
        );
        // 交付守卫：等待方可能已经走了（`BUILD_TIMEOUT` 超时，或它先返回了 Err）。那时 `send` 会把
        // 刚建出来的窗**原样还回来**——必须销毁，否则这个晚到的闭包会留下一个无人等待、无人管理的
        // 登录窗（`LoginState` 已 finish，用户再点登录只会撞 duplicate-label）。
        match deliver_build_result(sender.send(built), |window| {
            discard_orphan_login_window(&window, &login_data_for_discard)
        }) {
            BuildDelivery::Delivered | BuildDelivery::NothingBuilt => {}
            BuildDelivery::OrphanDiscarded => log::warn!(
                "登录窗建出来了，但等待方已收场（多半是建窗超时）：已销毁这个没人等的窗并删掉它的数据目录"
            ),
            BuildDelivery::OrphanLeftBehind(reason) => log::warn!(
                "登录窗建出来了但等待方已收场，且没能清干净（{reason}）：窗口或数据目录可能残留"
            ),
        }
    })
    .map_err(|source| {
        CoreError::new(
            "internal",
            format!("建窗任务排不到主线程（{source}）：登录无法开始"),
        )
    })?;

    let outcome = receiver.recv_timeout(BUILD_TIMEOUT);
    // 等待方一旦收场就**立刻扔掉接收端**：此后闭包的 `send` 必然失败，它建出来的窗就落进交付守卫
    // 手里被销毁。若把接收端留到函数返回时才析构，中间那一瞬晚到的 `send` 仍可能"成功"——
    // 窗被丢进一个没人再读的通道，照样是孤儿窗（这正是本次要堵的那个洞）。
    drop(receiver);

    match outcome {
        Ok(Ok(window)) => Ok(window),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            // 主线程忙到超时：排队的闭包稍后仍会执行，它会建出、显示并聚焦一个无人等待的窗。
            // 闭包侧的交付守卫兜住"稍后才建出来"的那种；这里再清一次"已经建出来但还没交付"的那种，
            // 两道防线都不留孤儿窗（此时 `LoginState` 仍是本次登录的，label 不会被别人占用）。
            discard_pending_login_window(app);
            Err(CoreError::new(
                "internal",
                "登录窗建窗任务超时（主线程没有回应）：登录无法开始",
            ))
        }
    }
}

/// 尽力清掉一个"可能已经建出来、但已经没人等待"的登录窗（建窗超时那条路专用）。
///
/// 只写日志不发 `app:notice`：这条路上用户已经拿到结构化错误了，残留与否不影响他的下一步。
/// **这里只销毁窗口、不删数据目录**：闭包可能正在用那个目录建 WebView2，并发删会把它弄坏；
/// 窗真的建出来了的话，交付守卫会连目录一起清掉。
fn discard_pending_login_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
        return; // 还没建出来：闭包侧的交付守卫会接住它
    };
    if let Err(source) = window.discard() {
        log::warn!("建窗超时留下的孤儿登录窗未能销毁（{source}）：窗口可能残留在任务管理器里");
    }
}

/// 真正调用 tauri 建窗（在主线程上跑）。
#[allow(clippy::too_many_arguments)]
fn build_on_main_thread(
    app: &AppHandle,
    url: tauri::Url,
    login_data: PathBuf,
    proxy: Option<tauri::Url>,
    nav_session: Arc<LoginSession>,
    load_session: Arc<LoginSession>,
    close_session: Arc<LoginSession>,
    top_inset: f64,
) -> Result<WebviewWindow, CoreError> {
    let title = format!("{} · 华为帐号登录", display_name(app));

    let mut builder = WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title(title)
        .decorations(false)
        .skip_taskbar(true)
        .visible(false) // 先摆好几何再显示：避免在左上角闪一下
        .data_directory(login_data)
        // 白名单 + hms:// 拦截全部走导航事件（登录页零注入：不订阅 initialization_script 那条路）
        .on_navigation(move |url| match navigation_for(url.as_str()) {
            Navigation::Callback(original) => {
                nav_session.settle(LoginConclusion::Callback { url: original });
                false // 拦下不请求：`hms://` 交给 Node 侧判定与结算
            }
            Navigation::Allow => true,
            Navigation::Block => false,
        })
        // 弹窗一律拒（官方页不需要开新窗；`window.open` 是攻击面）
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        // 首载完成 → 解除首载期限
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                load_session.mark_loaded();
            }
        });

    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        builder = builder.parent(&main).map_err(|source| {
            CoreError::new("internal", format!("登录窗挂不上主窗（{source}）"))
        })?;
    }

    let window = builder
        .build()
        .map_err(|source| CoreError::new("internal", format!("登录窗建不起来（{source}）")))?;

    // 双来源之一：窗口关闭。CloseRequested（用户/系统要求关）与 Destroyed（已销毁）都算 Closed。
    {
        let close_session = Arc::clone(&close_session);
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                close_session.settle(LoginConclusion::Closed);
            }
        });
    }

    if let Err(error) = apply_layout(app, &window, top_inset) {
        log::warn!("登录窗几何未能按主窗内容区摆放：{error}");
    }
    // `show()` 失败发生在 `build()` **之后**：窗已经在 label 表里了，直接返回 Err 就留下一个
    // 谁也管不到的窗（后续重试撞 duplicate-label）——所以先销毁再返回错误。
    if let Err(source) = window.show() {
        return Err(abandon_unmanaged_window(
            &window,
            CoreError::new("internal", format!("登录窗显示不出来（{source}）")),
        ));
    }
    let _ = window.set_focus();
    Ok(window)
}

/// 应用名（标题用），拿不到就退回 label。
fn display_name(app: &AppHandle) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// 把登录窗摆到主窗内容区（顶部让出 `top_inset`，单位 CSS 像素 → 物理像素按主窗缩放比换算）。
fn apply_layout(app: &AppHandle, window: &WebviewWindow, top_inset: f64) -> Result<(), CoreError> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "主窗不在了：无法计算登录窗几何"))?;
    let scale = main.scale_factor().unwrap_or(1.0).max(0.1);
    let position = main
        .inner_position()
        .map_err(|source| CoreError::new("internal", format!("取主窗位置失败：{source}")))?;
    let size = main
        .inner_size()
        .map_err(|source| CoreError::new("internal", format!("取主窗尺寸失败：{source}")))?;

    let target = layout_target(
        Rect {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        },
        top_inset * scale,
    );

    window
        .set_position(tauri::PhysicalPosition::new(
            target.x.round() as i32,
            target.y.round() as i32,
        ))
        .map_err(|source| CoreError::new("internal", format!("摆放登录窗失败：{source}")))?;
    window
        .set_size(tauri::PhysicalSize::new(
            target.width.round() as u32,
            target.height.round() as u32,
        ))
        .map_err(|source| CoreError::new("internal", format!("设置登录窗尺寸失败：{source}")))?;
    Ok(())
}

/// 跟随主窗 geometry（登录窗"铺在主窗内容区上"：主窗一动就要重算）。
pub fn follow_main_window(app: &AppHandle, top_inset: f64) -> Result<(), CoreError> {
    let window = app
        .get_webview_window(LOGIN_WINDOW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "登录窗已关闭：无需跟随"))?;
    apply_layout(app, &window, top_inset)
}

/// 收尾各步的原始结果（拆成数据就是为了让分级判定成为**纯函数**，不依赖真 GUI 也能测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownOutcome {
    /// `clear_all_browsing_data` 的结果
    pub clear_browsing_data: Result<(), String>,
    /// `close` 的结果
    pub close: Result<(), String>,
    /// `close` 之后窗口是否还在（还在才需要 destroy）
    pub still_present: bool,
    /// `destroy` 的结果（只在 `still_present` 为真时才被采纳）
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
    /// 是否值得广播 `app:notice` 打扰用户：**只有真残留才值得**。
    ///
    /// 为什么"浏览数据没清掉"与"关闭调用失败"不算：`shutdown_window` 跑在"先答复、再拆窗"之后，
    /// 到达这里时窗口往往已经被用户或系统关掉了（"窗口消失"轮询判 Closed 的路径更是必然），
    /// 这种句柄失效的失败**每次都发生**且什么也没留下——[`remove_dir_with_backoff`] 会把整个
    /// 一次性数据目录端掉（旧仓文案却让用户去"手动清理"一个刚被删掉的东西）。
    /// 真正会留下东西的只有两条：窗口还在（销毁失败）与目录没删掉（里面可能躺着登录 cookie）。
    pub fn needs_user_notice(&self) -> bool {
        matches!(self, Self::Destroy(_) | Self::DataDir(_))
    }

    /// 给人看的一句话（同时用于日志与 app:notice）。
    ///
    /// 纯文本，不带 markdown 记号：它会原样进入 `app:notice` 的 `text` 与日志文件。
    pub fn message(&self) -> String {
        match self {
            Self::BrowsingData(source) => format!(
                "登录窗浏览数据未能清除（{source}）：本次的一次性数据目录会被整棵删掉，正常收尾不留残留"
            ),
            Self::Close(source) => {
                format!("登录窗关闭调用失败（{source}）：改用强制销毁，这一步失败本身不代表残留")
            }
            Self::Destroy(source) => {
                format!("登录窗销毁失败（{source}）：窗口可能残留在任务管理器里")
            }
            Self::DataDir(source) => format!(
                "登录窗临时数据目录未能删除（{source}）：下次登录会另建新目录（partition 一次性），\
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

/// 收尾：清浏览数据 → close（必要时 destroy）→ 退避删数据目录。
///
/// 顺序不能换：浏览数据必须在 webview 还活着时清（销毁后就够不着了）。
pub fn shutdown_window(
    app: &AppHandle,
    window: &WebviewWindow,
    data_dir: &Path,
) -> Vec<ShutdownFailure> {
    let clear_browsing_data = window.clear_all_browsing_data().map_err(|source| source.to_string());
    let close = window.close().map_err(|source| source.to_string());
    let still_present = app.get_webview_window(LOGIN_WINDOW_LABEL).is_some();
    let destroy = if still_present {
        window.destroy().map_err(|source| source.to_string())
    } else {
        Ok(())
    };
    let data_dir = remove_dir_with_backoff(data_dir);

    shutdown_failures(&ShutdownOutcome {
        clear_browsing_data,
        close,
        still_present,
        destroy,
        data_dir,
    })
}

/// 一个"建出来了但还没交给等待方"的窗的最小能力面。
///
/// 真实实现是 tauri 的 [`WebviewWindow`]（销毁要真 GUI，测不了）；测试用假实现观察
/// **有没有真的去销毁**——这正是"孤儿窗"缺陷的判据，纯函数替代不了。
pub trait DiscardableWindow {
    /// 销毁窗口（尽力而为）：`Ok(())` = 已销毁；`Err` = 失败原因。
    fn discard(&self) -> Result<(), String>;
}

impl DiscardableWindow for WebviewWindow {
    fn discard(&self) -> Result<(), String> {
        self.destroy().map_err(|source| source.to_string())
    }
}

/// 建出来的窗还没交出去就失败了（`show()` 失败等）：**先销毁再返回 Err**。
///
/// 为什么必须销毁：`build()` 成功那一刻窗已经注册进 label 表了，光返回 Err 会留下一个
/// 谁也管不到的窗（此时 `LoginState` 已 `finish`——用户再点登录只会撞 duplicate-label）。
/// 销毁也失败时把两个原因都留在错误里：不许吞掉任何一个（`show` 失败与清不掉是两件事）。
pub fn abandon_unmanaged_window<W: DiscardableWindow>(window: &W, error: CoreError) -> CoreError {
    match window.discard() {
        Ok(()) => error,
        Err(source) => CoreError::new(
            "internal",
            format!("{}；清理这个未接管的登录窗也失败（{source}）：窗口可能残留", error.message),
        ),
    }
}

/// 清掉一个"没人等待"的窗：销毁窗口 + 删掉它那个一次性数据目录。
///
/// 两条**各自尽力**（销毁失败不该连累目录清理，反之亦然），失败原因合并交回调用方写日志。
pub fn discard_orphan_login_window<W: DiscardableWindow>(
    window: &W,
    data_dir: &Path,
) -> Result<(), String> {
    let mut problems = Vec::new();
    if let Err(source) = window.discard() {
        problems.push(format!("销毁孤儿登录窗失败（{source}）"));
    }
    if let Some(source) = remove_dir_with_backoff(data_dir) {
        problems.push(format!("删孤儿登录窗数据目录失败（{source}）"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("；"))
    }
}

/// 建窗结果交付的结局（纯函数可测；调用方据此留日志）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildDelivery {
    /// 等待方收到了结果（正常路径）
    Delivered,
    /// 等待方已经走了，但窗已经建出来了 → 已尽力销毁
    OrphanDiscarded,
    /// 等待方已经走了，窗建出来了却没销毁掉（窗口可能残留）
    OrphanLeftBehind(String),
    /// 等待方已经走了，窗也没建出来 → 没什么可清
    NothingBuilt,
}

/// 交付建窗结果；**没人接收时把已经建出来的窗就地清掉**。
///
/// 为什么这不是"多此一举"：`create_login_window` 把建窗闭包投到主线程后只等
/// [`BUILD_TIMEOUT`]（10 秒）。主线程忙到超时时，那个闭包**稍后仍会执行**——它会建出、显示并
/// 聚焦一个无人等待的登录窗；此刻 `LoginState` 已经 `finish()`，用户再点登录只会撞
/// duplicate-label，人卡在一个没人管的无边框窗里。
/// `mpsc::Sender::send` 在接收端已经析构时会把**值原样还回来**（`SendError(built)`），正好是
/// "等待方走了、但窗建出来了"的准确信号：拿回来的窗就是孤儿，交给 `discard` 清掉。
pub fn deliver_build_result<T, E>(
    sent: Result<(), std::sync::mpsc::SendError<Result<T, E>>>,
    discard: impl FnOnce(T) -> Result<(), String>,
) -> BuildDelivery {
    match sent {
        Ok(()) => BuildDelivery::Delivered,
        Err(std::sync::mpsc::SendError(Ok(window))) => match discard(window) {
            Ok(()) => BuildDelivery::OrphanDiscarded,
            Err(reason) => BuildDelivery::OrphanLeftBehind(reason),
        },
        Err(std::sync::mpsc::SendError(Err(_))) => BuildDelivery::NothingBuilt,
    }
}

/// 带退避删目录：WebView2 释放用户数据目录有延迟（文件句柄），一把删不掉是常态。
///
/// 返回 `None` = 已清干净（含"本来就不存在"）；`Some(原因)` = 没删掉。
/// **这个函数只交回原因**，给人看的文案由 [`ShutdownFailure::DataDir`] 组装（分级的判据在那一层）。
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

/// 向渲染层发一条 `app:notice`（宿主级提示：登录窗收尾没做完）。
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

/// 并排第二次登录：把既有窗拉到前台。
fn focus_login_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_inset_mirror_is_48_and_inside_the_allowed_range() {
        // 镜像值的唯一意义是"与 src/shared/login-inset.mjs 相等"，parity 测试扫源码钉住这里；
        // 这条用例再钉一次数值本身，免得改成 47.9 也能过（源码扫描会把 48.0 读成 48）。
        assert_eq!(LOGIN_VIEW_TOP_INSET, 48.0);
        assert!((0.0..=MAX_TOP_INSET).contains(&LOGIN_VIEW_TOP_INSET));
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
        let started = Instant::now();
        assert_eq!(session.wait(Duration::from_millis(20)), None);
        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(!session.is_loaded());
    }

    /// 硬边界：登录页零注入（只靠导航事件）+ 只加载**外部**官方页。
    ///
    /// 扫的是**生产代码那一段**（`#[cfg(test)]` 之前）：本用例自己的字面量也在同一文件里，
    /// 不切掉就等于在扫自己。
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
        assert!(
            !production.contains("WebviewUrl::App("),
            "登录窗不得挂本地页面：那会变成「自绘登录页」，等于自实现登录协议"
        );
    }
}
