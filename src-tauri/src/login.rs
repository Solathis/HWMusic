//! 登录页宿主：把**华为官方授权页**铺在主窗客户区里（顶部让出应用自己的 header），
//! 并把它变成一次可结算的登录尝试。
//!
//! **宿主形态（R23，用户指令"不开新窗口、在程序中跳转"）**：官方页是**主窗里的第二个 webview**
//! （`tauri::webview::WebviewBuilder` + `Window::add_child`），不是独立子窗口。于是：
//!
//! - 应用自己的 header（含「返回扫码登录」）**始终**在主窗 webview 里、始终可见可点——它是规范几何
//!   [`LOGIN_VIEW_TOP_INSET`] 让出来的那一条，登录页铺在它下面（R7 的独立子窗做不到这件事：
//!   子窗是另一个顶层窗口，"返回"要么被盖住、要么得先关窗）；
//! - 几何是**客户区相对**的物理像素（[`layout_target`]）：没有屏幕坐标、没有跨窗缩放换算；
//! - "返回"= 关掉这个 webview（[`shutdown`]），主窗一动不动。
//!
//! 设计要点（每一条都对应旧仓踩过的坑，见 `docs/API_CONTRACT.md` §1.4/§1.6）：
//!
//! 1. **零命令权限**：`capabilities/main.json` 的 `windows` 只列 `main`/`lyrics`，官方页那个
//!    **webview**（label [`LOGIN_WEBVIEW_LABEL`]）不在其中；这里也不给它注入任何脚本
//!    （不订阅 `initialization_script`/`eval` 那条路），白名单与回调**只靠导航事件**观测。
//!    R23 追加一条同类前提：**来源守卫按 webview label 判**（见 `commands::require_main_webview`）
//!    ——同窗之后窗口 label 恒为 `main`，按窗口 label 判等于把守卫让给官方页。
//! 2. **白名单是显式条目**：`LOGIN_ALLOWED_ORIGINS`/`LOGIN_ALLOWED_URLS` 是 Node 侧
//!    `src/protocols/login-callback.mjs` 的镜像副本（Rust 无法 import .mjs），
//!    由 `test/login-parity.test.mjs` 双向钉住；漏条目就是旧仓"扫码成功后卡在 CAS 页"的根因。
//! 3. **`hms://` 一律拦下不请求**，并把**原样** URL 交给等待方：判真伪是 Node 侧 `isCallback`/
//!    `consumeCallback` 的唯一职责（宿主预滤或不预滤都安全，见契约 §1.6）。
//! 4. **双来源**（旧仓缺陷 C1）：导航拦截与"webview 没了"两条路**都能**把结论交给等待方，
//!    结论槽是 take-once 的（先到者胜、后到者不改写）。只接一条路 → "扫码成功却等超时"。
//!    R23 起第二条不再是"窗口关闭事件"（同窗宿主没有可被用户关掉的窗），而是每 tick 现问
//!    `app.get_webview(..)`：查不到即 `Closed`。用户那条正路是 header 的「返回扫码登录」
//!    → `host:cancel-login` → `Cancelled`。
//! 5. **双期限**：首载 [`LOGIN_LOAD_DEADLINE_SECS`] 秒打不开官方页 = 独立文案（多半是网络/代理），
//!    总 [`LOGIN_TIMEOUT_SECS`] 秒 = 扫码超时文案。两条文案不同，处置方式也不同。
//! 6. **一次性隔离**：每次登录一个随机 `partition` + 独立 webview 数据目录；收场后清浏览数据、
//!    退避删目录（WebView2 释放句柄有延迟）。下次登录是全新目录，不残留上一次的登录态。
//! 7. **不阻塞效果线程**：`host:open-login` 立刻返回，真正的等待与收尾在 `login-view` 线程里
//!    （阻塞效果线程会让随后的 `host:cancel-login` 永远送不进来）。
//!
//! **已知缺口（不硬绕）**：wry 0.57（tauri 2.12 的 webview 层）只注册 WebView2 的
//! `NavigationStarting`（主框架级），**没有** `FrameNavigationStarting`。官方页若从 **iframe**
//! 内部发起 `hms://` 跳转，本模块看不到（顶部框架的跳转与 302 都能看到）。关闭这个缺口要么等上游
//! 拿到帧级事件，要么注入脚本监听——后者是硬边界明令禁止的（登录页零注入），所以这里**如实记录**。
//! 兜底：即使回调从 iframe 走了、结论没收到，总期限（10 分钟）仍会收口，不会永久挂住。
//!
//! **同窗宿主带来的构建代价（如实登记，见报告 §核实）**：`Window::add_child` 与 `WebviewBuilder`
//! 在 tauri 2.12.4 里由 `unstable` Cargo feature 把关（`src/window/mod.rs:1224`、
//! `src/webview/mod.rs:261-271`），因此 `Cargo.toml` 开了这个 feature；它的副作用是运行时把
//! **每个**窗口的内容 webview 建成 `WindowChild`（tauri-runtime-wry `src/lib.rs:4596-4615`），
//! 主窗/歌词窗由"自动铺满父窗"改成"显式 bounds + 比例跟随"（同文件 `4922-4933`、`4273-4293`）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Manager, Webview, WebviewUrl};

use crate::bridge::{CoreError, CoreShared, Effect, APP_NOTICE};
use crate::{MAIN_WINDOW_LABEL, WebviewDataRoot};

/// 登录页那个 **webview** 的 label（R23 起：它是主窗的子 webview，不再是窗口）。
///
/// 两条要点：
/// 1. `capabilities/main.json` 里**故意不列**它（列的是 `windows: ["main","lyrics"]`）——官方页零命令权限；
/// 2. 它与主窗的 label（`main`）**必须不同**：同窗之后 `window.label()` 恒为 `main`，命令层唯一能区分
///    "这一帧是登录页发的还是主窗发的"的东西就是这个 **webview label**（见 `commands::require_main_webview`）。
pub const LOGIN_WEBVIEW_LABEL: &str = "login";

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

/// 并排第二次登录的提示（不并行开第二个登录页：只把既有那个拉到前台）。
pub const LOGIN_IN_PROGRESS_MESSAGE: &str = "已有一次登录正在进行（已把登录界面拉到前台）";

/// 回调 scheme 的镜像（Node 唯一真源是 `auth.mjs` 的 `OAUTH_REDIRECT_URI`）。
pub const CALLBACK_SCHEME: &str = "hms";

/// `topInset` 的合法上界：越界值静默接受会把登录页摆到客户区之外，不如结构化拒掉。
pub const MAX_TOP_INSET: f64 = 4096.0;

/// `partition` 的字符集与长度（进文件系统之前必须过这一关）。
pub const PARTITION_MAX_LEN: usize = 64;

/// 几何钳制下限：主窗被外部压到退化尺寸时也不交出负高度（`set_bounds` 会失败或建出畸形块）。
pub const MIN_LOGIN_HEIGHT: f64 = 160.0;
/// 几何钳制下限（宽）。
pub const MIN_LOGIN_WIDTH: f64 = 320.0;

/// 跟随主窗几何的轮询间隔：登录页"铺在主窗客户区上"，主窗一动就要重算。
///
/// 为什么轮询而不是订阅主窗的 `Resized`：
/// 1. `Window::on_window_event`（tauri-2.12.4 `src/window/mod.rs:1276-1281`）**没有注销口子**——
///    它把运行时的 event id 直接丢掉，而 `Listener::unlisten` 管的是 JS 事件、不是窗口事件。
///    每次登录挂一个监听器就会永久累积（每个还握着一份 [`LoginSession`]）；
/// 2. 同窗 webview 本来就**不会**随父窗自动长大：tauri 只对开了 `auto_resize` 的 webview 按比例跟随，
///    而比例缩放会把 header 那条 48px 一起缩掉（我们要的是"顶部恒让出 48px"）。
///
/// 代价是每 250 毫秒几次几何查询（可忽略），换掉一个会累积的注册点与一个跨任务共享点。
const FOLLOW_TICK: Duration = Duration::from_millis(250);

/// 建登录页任务投到主线程后的等待上限（主线程若在忙，宁可结构化失败也不要永久挂住）。
const BUILD_TIMEOUT: Duration = Duration::from_secs(10);

/// 删目录的退避次数与基数（WebView2 释放用户数据目录有延迟，一把删不掉是常态）。
const DELETE_ATTEMPTS: u32 = 5;
const DELETE_BACKOFF_MS: u64 = 50;

/// **导航白名单的镜像**（Node 侧唯一真源：`src/protocols/login-callback.mjs`）。
/// 显式条目表，不是 `*.huawei.com` 通配；条目由 parity 测试互钉。
pub const LOGIN_ALLOWED_ORIGINS: [&str; 3] = [
    "https://oauth-login1.cloud.huawei.com", // OAuth 授权/令牌服务域
    // R16 增补（真机"登录窗空白"的直接原因）：实探（scripts/probe-qr.mjs）证明授权页拿到
    // `loginType = TICKET` 后会把浏览器跳到 `https://id1.cloud.huawei.com:443/CAS/remoteLogin?…`
    // → `/CAS/portal/loginAuth.html`。这条导航原先被拦下，页面上就停在一个什么都没渲染的空壳上。
    // 端口 443 是默认端口，`Url::origin()` 归一化后不带端口，所以这一条同时覆盖 `:443` 的写法。
    "https://id1.cloud.huawei.com", // 华为帐号 CAS 门户域（授权页的落地页）
    "https://login.cloud.huawei.com", // 华为帐号登录（CAS 系，旧域名，仍在跳转链里出现）
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

/// R16：把一次导航/加载的 URL 变成**可进日志**的一行描述。
///
/// 规则（与 `parse_config` 的"错误里不回显 url"同一条纪律，但目的相反——这里要的是可诊断性）：
/// - `scheme://host/path` **原样保留**：诊断"到底去了哪一页"就是靠它；
/// - **查询串只留参数名**（最多 8 个）：授权页 URL 里带着 `code_challenge`/`state`，
///   登录回调里带着 `code`——旧仓把整段 URL 打进日志，等于把一次性凭据抄进了日志文件；
/// - 超长截断（[`MAX_URL_LOG_CHARS`]）。
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

/// 登录页配置（`host:open-login` 的 payload）。
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

    let top_inset = match object.get("topInset") {
        Some(value) => value
            .as_f64()
            .filter(|inset| inset.is_finite())
            .ok_or_else(|| invalid_payload("topInset 必须是有限数字"))?,
        None => return Err(invalid_payload("登录页配置缺少 topInset")),
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

/// 登录页 webview 的数据目录：`<数据根>/webview2/login/<partition>`。
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

    /// 收尾：放开独占（登录页拆完之后才调，避免新建的那个撞上正在拆的 label）。幂等。
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

/// 登录页的目标几何：铺满主窗**客户区**，顶部让出 `top_inset`——**客户区相对坐标**。
///
/// 入参是主窗客户区的**物理像素**尺寸（不是屏幕坐标：同窗 webview 的坐标原点就是客户区左上角，
/// 跨窗那套"屏幕位置 + 缩放比换算"在这里根本不存在——R7 的真机几何偏差就出在那条路上）。
/// 输出恒以 `x = 0` 为左边界、`y = top_inset` 为顶边（上面那一条留给应用自己的 header，
/// 「返回扫码登录」就在那儿，它必须始终可见可点）。
///
/// 钳制两条（主窗被外部压到退化尺寸时才会碰到）：
/// - 高度下限 [`MIN_LOGIN_HEIGHT`] / 宽度下限 [`MIN_LOGIN_WIDTH`]：绝不把负值或零交给 `set_bounds`；
/// - 非有限/负输入按 0 处理：合成器偶发退化值不该变成 NaN 几何。
pub fn layout_target(client_width: f64, client_height: f64, top_inset: f64) -> Rect {
    let sane = |value: f64| if value.is_finite() && value > 0.0 { value } else { 0.0 };
    let inset = sane(top_inset);
    let width = sane(client_width);
    let height = sane(client_height);
    Rect {
        x: 0.0,
        y: inset,
        width: width.max(MIN_LOGIN_WIDTH),
        height: (height - inset).max(MIN_LOGIN_HEIGHT),
    }
}

// ---------------------------------------------------------------------------
// 建登录页 / 等待 / 收尾（需要 tauri 运行时）
// ---------------------------------------------------------------------------

/// `host:open-login` 的入口（在效果线程上调用，**必须立刻返回**）。
///
/// 返回 `Ok(())` = 已交给 `login-view` 线程（它在登录页收场后答复这一帧，调用方不得再写第二次）；
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
        .ok_or_else(|| CoreError::new("internal", "数据根未登记：登录页无法确定 webview 数据目录"))?;
    let state = app
        .try_state::<Arc<LoginState>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| CoreError::new("internal", "登录状态未登记（setup 未完成）"))?;

    let session = LoginSession::new();
    if !state.begin(Arc::clone(&session)) {
        focus_login_view(app);
        return Err(CoreError::new("login_in_progress", LOGIN_IN_PROGRESS_MESSAGE));
    }

    let login_data = login_data_dir(&data_root, &config.partition);
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
    let webview = match create_login_view(&app, &config, &data_root, &login_data, &session) {
        Ok(webview) => webview,
        Err(error) => {
            // 建登录页失败**不是**登录结论，而是宿主错误：如实回结构化错误帧（带真实原因），
            // 而不是塞一句"打不开官方页，请检查网络或代理"——那是另一回事，处置方式也不同。
            // 用户点一次登录什么都没发生是最难排查的故障，所以这里必须留痕。
            log::warn!("登录页建不起来：{error}");
            // 先答复、再善后（与成功路径同一条纪律）：退避删目录最长要等约 1.5 秒，
            // 不能让等待方陪着等——何况"删目录失败"的结论不该改变这次登录的答复。
            respond(&shared, &request_id, Err(error));
            // `create_dir_all(login_data)` 在建登录页**之前**就跑了：建不出来时目录已经在那儿，
            // 而这条路上 `shutdown_login_view` 永远不会被调用 → 就地尽力清一次（终审 C）。
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

    let conclusion = wait_for_conclusion(&app, &session, config.top_inset);

    // **先答复、再拆登录页**（顺序是硬要求）：拆要删目录、要退避重试，可能失败；
    // 若因为拆失败而不答复，Node 侧就变成"扫码成功却等超时"——旧仓缺陷 C1 的另一种写法。
    respond(&shared, &request_id, Ok(conclusion.to_payload()));

    for failure in shutdown_login_view(&app, &webview, &login_data) {
        if failure.needs_user_notice() {
            // 只有真残留才打扰用户（webview 还在 / 目录没删掉）。
            log::warn!("登录页收尾失败（有残留）：{}", failure.message());
            announce_failure(&app, &shared, &failure.message());
        } else {
            // 登录页已经消失的路径上（vanish-poll 判 Closed，或收尾前它已被拆掉）
            // `clear_all_browsing_data`/`close` 必然失败，而整个一次性目录照样被删掉——
            // 这是预期失败，不是残留：只留日志，绝不弹一条让用户去清理一个刚被删掉的东西。
            log::warn!("登录页收尾未竟（预期失败，不打扰用户）：{}", failure.message());
        }
    }
    state.finish();
}

/// 等结论：结论槽 + 登录页消失兜底 + 双期限 + 每 tick 跟随主窗几何。
fn wait_for_conclusion(app: &AppHandle, session: &Arc<LoginSession>, top_inset: f64) -> LoginConclusion {
    let started = Instant::now();
    let mut layout_warned = false;
    loop {
        if let Some(conclusion) = session.conclusion() {
            return conclusion;
        }
        // 登录页没了而结论槽还空着：兜底判 Closed（事件路径之外的第二条来源，绝不让等待方挂到超时）。
        // 同窗宿主里这不是"用户关了窗"，而是"那个 webview 被拆掉了"（应用退出 / 收尾先行）。
        if app.get_webview(LOGIN_WEBVIEW_LABEL).is_none() {
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
                log::warn!("登录页未能跟随主窗几何：{error}（后续不再重复记录）");
                layout_warned = true;
            }
        }
    }
}

/// 建登录页（投到主线程执行：webview 的创建要在事件循环线程上）。
fn create_login_view(
    app: &AppHandle,
    config: &LoginConfig,
    data_root: &Path,
    login_data: &Path,
    session: &Arc<LoginSession>,
) -> Result<Webview, CoreError> {
    let url = tauri::Url::parse(&config.url)
        .map_err(|_| invalid_payload("url 解析不了（parse_config 之后不该发生）"))?;

    // 目录必须先建：WebView2 不会自建，缺目录时建 webview 直接 `os error 5`（拒绝访问）。
    std::fs::create_dir_all(login_data).map_err(|source| {
        CoreError::new(
            "internal",
            format!("登录页数据目录建不出来（{source}）：登录无法开始"),
        )
    })?;

    // 代理在**建登录页时**读取一次 → 改代理要重启应用才生效（与主窗一致，R6 已知限制）。
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
    let top_inset = config.top_inset;

    app.run_on_main_thread(move || {
        let built = build_on_main_thread(
            &app_for_build,
            url_for_build,
            login_data_for_build,
            proxy,
            nav_session,
            load_session,
            top_inset,
        );
        // 交付守卫：等待方可能已经走了（`BUILD_TIMEOUT` 超时，或它先返回了 Err）。那时 `send` 会把
        // 刚建出来的登录页**原样还回来**——必须关掉，否则这个晚到的闭包会留下一个无人等待、无人管理的
        // 登录页（`LoginState` 已 finish，用户再点登录只会撞 duplicate-label）。
        match deliver_build_result(sender.send(built), |webview| {
            discard_orphan_login_window(&webview, &login_data_for_discard)
        }) {
            BuildDelivery::Delivered | BuildDelivery::NothingBuilt => {}
            BuildDelivery::OrphanDiscarded => log::warn!(
                "登录页建出来了，但等待方已收场（多半是建页超时）：已关掉这个没人等的登录页并删掉它的数据目录"
            ),
            BuildDelivery::OrphanLeftBehind(reason) => log::warn!(
                "登录页建出来了但等待方已收场，且没能清干净（{reason}）：登录页或数据目录可能残留"
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
    // 等待方一旦收场就**立刻扔掉接收端**：此后闭包的 `send` 必然失败，它建出来的登录页就落进交付守卫
    // 手里被关掉。若把接收端留到函数返回时才析构，中间那一瞬晚到的 `send` 仍可能"成功"——
    // 登录页被丢进一个没人再读的通道，照样是孤儿（这正是本次要堵的那个洞）。
    drop(receiver);

    match outcome {
        Ok(Ok(webview)) => Ok(webview),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            // 主线程忙到超时：排队的闭包稍后仍会执行，它会建出并聚焦一个无人等待的登录页。
            // 闭包侧的交付守卫兜住"稍后才建出来"的那种；这里再清一次"已经建出来但还没交付"的那种，
            // 两道防线都不留孤儿（此时 `LoginState` 仍是本次登录的，label 不会被别人占用）。
            discard_pending_login_view(app);
            Err(CoreError::new(
                "internal",
                "登录页建页任务超时（主线程没有回应）：登录无法开始",
            ))
        }
    }
}

/// 尽力关掉一个"可能已经建出来、但已经没人等待"的登录页（建页超时那条路专用）。
///
/// 只写日志不发 `app:notice`：这条路上用户已经拿到结构化错误了，残留与否不影响他的下一步。
/// **这个函数只关 webview、不删数据目录**：闭包可能正在用那个目录建 WebView2，并发删会把它弄坏。
/// 目录由 [`run_login_view`] 的 Err 支用退避删除兜底（那里对"删不掉"仍按 [`ShutdownFailure::DataDir`]
/// 分级——目录里可能真有 cookie）；并发删的最坏结果是那个晚到的闭包建不出登录页，而那比留下一个
/// 无人等待的孤儿页更好；页真的建出来了的话，交付守卫也会连目录一起清掉。
fn discard_pending_login_view(app: &AppHandle) {
    let Some(webview) = app.get_webview(LOGIN_WEBVIEW_LABEL) else {
        return; // 还没建出来：闭包侧的交付守卫会接住它
    };
    if let Err(source) = webview.discard() {
        log::warn!("建页超时留下的孤儿登录页未能关掉（{source}）：它可能还挂在主窗上");
    }
}

/// 真正调用 tauri 建登录页（在主线程上跑）。
///
/// 宿主是**主窗的第二个 webview**：几何在**建的时候就定死**（`add_child` 的 position/size 参数），
/// 之后由 [`follow_main_window`] 每 tick 重算——同窗 webview 不会随父窗自动长大，也不需要
/// （`auto_resize` 是比例缩放，会把 header 那条 48px 一起缩掉）。
#[allow(clippy::too_many_arguments)]
fn build_on_main_thread(
    app: &AppHandle,
    url: tauri::Url,
    login_data: PathBuf,
    proxy: Option<tauri::Url>,
    nav_session: Arc<LoginSession>,
    load_session: Arc<LoginSession>,
    top_inset: f64,
) -> Result<Webview, CoreError> {
    let main = app.get_window(MAIN_WINDOW_LABEL).ok_or_else(|| {
        CoreError::new(
            "internal",
            "主窗不在了：登录页没有可挂的地方（同窗宿主）",
        )
    })?;

    // 建之前先把目标几何算出来：`add_child` 一步就把登录页摆到最终位置，
    // 于是不存在"先闪一下左上角再搬过去"的窗口期（R7 用 `visible(false)` + `show()` 达到同一目的，
    // 同窗宿主没有那一步，也不需要）。
    let target = main_layout_target(&main, top_inset)?;

    // R16：把这次登录要打开的地址记下来（**只记形状**：origin+path+参数名，见 describe_navigation_for_log）。
    // 真机"登录页空白"当天，日志里缺的正是这一行：没有任何一条记录说得出"页面上到底停在哪一页"。
    log::info!(
        "登录页创建（主窗内第二 webview）：url={} partition={} topInset={} rect=({},{},{},{})",
        describe_navigation_for_log(url.as_str()),
        config_partition_hint(&login_data),
        top_inset,
        target.x,
        target.y,
        target.width,
        target.height
    );

    let mut builder = WebviewBuilder::new(LOGIN_WEBVIEW_LABEL, WebviewUrl::External(url))
        .data_directory(login_data)
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
                Navigation::Allow => log::debug!("登录页导航放行：{described}"),
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
        // 首载/失败都要记：只认 Finished 的话，"页面开始加载了但一直没完成"这件事在日志里
        // 就是一片空白（首载 30 秒超时那条结论到了，却没人知道卡在哪一页）。
        .on_page_load(move |_webview, payload| {
            let described = describe_navigation_for_log(payload.url().as_str());
            match payload.event() {
                PageLoadEvent::Started => log::info!("登录页开始加载：{described}"),
                PageLoadEvent::Finished => {
                    log::info!("登录页加载完成：{described}");
                    load_session.mark_loaded();
                }
            }
        });

    // debug 构建给登录页开 devtools：真机上"空白页"的 console/网络错误只有在这里看得见。
    // release 不开：官方登录页在生产环境不该多出一个可调试面板（那是身份边界上的输入面）。
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
            tauri::PhysicalPosition::new(target.x.round() as i32, target.y.round() as i32),
            tauri::PhysicalSize::new(target.width.round() as u32, target.height.round() as u32),
        )
        .map_err(|source| CoreError::new("internal", format!("登录页建不起来（{source}）")))?;
    // 把焦点交给官方页（用户在它里面扫/输）：失败只留痕——页已经建好且能点，聚焦失败不该让整次登录失败。
    if let Err(source) = webview.set_focus() {
        log::warn!("登录页没能拿到焦点（{source}）：用户可能要自己点一下页面");
    }
    Ok(webview)
}

/// 日志里的分区名（一次性数据目录的最后一段）：只为让"这次登录用的是哪个目录"可追。
fn config_partition_hint(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "(未知)".to_string())
}

/// 主窗此刻的登录页目标几何（**客户区相对**物理像素）。
///
/// `top_inset` 的单位是 **CSS 像素**（唯一真源 [`LOGIN_VIEW_TOP_INSET`]），这里按主窗缩放比换算成
/// 物理像素——同窗 webview 的坐标系就是物理像素，没有跨窗换算那一步。
fn main_layout_target(main: &tauri::Window, top_inset: f64) -> Result<Rect, CoreError> {
    let scale = main.scale_factor().unwrap_or(1.0).max(0.1);
    let size = main
        .inner_size()
        .map_err(|source| CoreError::new("internal", format!("取主窗客户区尺寸失败：{source}")))?;
    Ok(layout_target(
        f64::from(size.width),
        f64::from(size.height),
        top_inset * scale,
    ))
}

/// 把登录页摆到主窗客户区（顶部让出 header 那一条）。
fn apply_layout(app: &AppHandle, webview: &Webview, top_inset: f64) -> Result<(), CoreError> {
    let main = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "主窗不在了：无法计算登录页几何"))?;
    let target = main_layout_target(&main, top_inset)?;

    webview
        .set_position(tauri::PhysicalPosition::new(
            target.x.round() as i32,
            target.y.round() as i32,
        ))
        .map_err(|source| CoreError::new("internal", format!("摆放登录页失败：{source}")))?;
    webview
        .set_size(tauri::PhysicalSize::new(
            target.width.round() as u32,
            target.height.round() as u32,
        ))
        .map_err(|source| CoreError::new("internal", format!("设置登录页尺寸失败：{source}")))?;
    Ok(())
}

/// 跟随主窗几何（登录页"铺在主窗客户区上"：主窗一动就要重算）。
pub fn follow_main_window(app: &AppHandle, top_inset: f64) -> Result<(), CoreError> {
    let webview = app
        .get_webview(LOGIN_WEBVIEW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "登录页已拆掉：无需跟随"))?;
    apply_layout(app, &webview, top_inset)
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
    /// 是否值得广播 `app:notice` 打扰用户：**只有真残留才值得**。
    ///
    /// 为什么"浏览数据没清掉"与"关闭调用失败"不算：`shutdown_login_view` 跑在"先答复、再拆登录页"之后，
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

/// 收尾：清浏览数据 → close（还在就再关一次）→ 退避删数据目录。
///
/// 顺序不能换：浏览数据必须在 webview 还活着时清（拆掉后就够不着了）。
///
/// **同窗宿主没有"窗口关闭"那一步**：tauri 对子 webview 只有一条拆解路（`Webview::close()`
/// → 运行时的 `WebviewMessage::Close` → 从宿主窗的 webview 表里摘掉，最后一个 `Rc` 掉下去时
/// wry 关掉 WebView2 控制器）。于是 [`ShutdownOutcome::destroy`] 这一格的含义变成"**再关一次**"：
/// `close()` 之后表里还有它，说明第一次没成功，重试是仅剩的手段（幂等，失败才算真残留）。
pub fn shutdown_login_view(
    app: &AppHandle,
    webview: &Webview,
    data_dir: &Path,
) -> Vec<ShutdownFailure> {
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
    let data_dir = remove_dir_with_backoff(data_dir);

    shutdown_failures(&ShutdownOutcome {
        clear_browsing_data,
        close,
        still_present,
        destroy,
        data_dir,
    })
}

/// 一个"建出来了但还没交给等待方"的登录页的最小能力面。
///
/// 真实实现是 tauri 的 [`Webview`]（真拆解要 GUI，测不了）；测试用假实现观察
/// **有没有真的去关掉**——这正是"孤儿登录页"缺陷的判据，纯函数替代不了。
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

/// 交付建页结果；**没人接收时把已经建出来的登录页就地关掉**。
///
/// 为什么这不是"多此一举"：`create_login_view` 把建页闭包投到主线程后只等
/// [`BUILD_TIMEOUT`]（10 秒）。主线程忙到超时时，那个闭包**稍后仍会执行**——它会建出并聚焦一个
/// 无人等待的登录页；此刻 `LoginState` 已经 `finish()`，用户再点登录只会撞 duplicate-label，
/// 人卡在一个没人管的官方页面上（那还是身份边界上的输入面）。
/// `mpsc::Sender::send` 在接收端已经析构时会把**值原样还回来**（`SendError(built)`），正好是
/// "等待方走了、但登录页建出来了"的准确信号：拿回来的就是孤儿，交给 `discard` 关掉。
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

/// 建登录页失败路径的目录善后（**注入式**：删除器可替身，好测"删不掉"那一半）。
///
/// 与收尾路径共用 [`shutdown_failures`] 的分级：唯一的失败项是 [`ShutdownFailure::DataDir`]，
/// 于是"删不掉才会打扰用户"这条判断不需要第二份实现。
pub fn abandon_build_data_dir_with(
    data_dir: &Path,
    remove: impl FnOnce(&Path) -> Option<String>,
) -> Vec<ShutdownFailure> {
    shutdown_failures(&ShutdownOutcome {
        data_dir: remove(data_dir),
        ..Default::default()
    })
}

/// 建登录页失败后的善后：尽力删掉 `create_login_view` 可能**已经建出来**的那个一次性目录。
///
/// 为什么必须有：`create_dir_all(login_data)` 在建登录页之前就跑了，而建页失败会让函数带着 `Err`
/// 返回——那条路上 [`shutdown_login_view`] 永远不会被调用（它只接在"建页成功"后面），
/// 于是目录没人删。里面可能有 cookie，也是"下次登录会另建新目录"之外的纯垃圾。
/// 失败时按 [`ShutdownFailure::DataDir`] 分级：只有真删不掉才广播 `app:notice`。
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

/// 并排第二次登录：把既有的登录页与主窗一起拉到前台（同窗宿主里"既有登录页"就铺在主窗上，
/// 只把 webview 聚焦是不够的——用户可能正把整个应用最小化在任务栏后面）。
fn focus_login_view(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(webview) = app.get_webview(LOGIN_WEBVIEW_LABEL) {
        let _ = webview.show();
        let _ = webview.set_focus();
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
        // 断言的是**超时路径的返回语义**（返回 None + 槽未被这次等待动过 + 之后一切照旧），
        // 不是挂钟耗时：下界卡在超时值本身会被 Windows 计时器粒度钳住而偶发打红
        //（同 login_policy.rs 里同型断言的修法）。
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

    // -----------------------------------------------------------------------
    // R23：宿主从"独立子窗"换成"主窗里的第二个 webview"
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

    /// 宿主形状的源码钉子（R23 用户指令"不开新窗口"）：官方登录页必须是**主窗的子 webview**
    /// （`WebviewBuilder` + `Window::add_child`），生产代码里不许再出现任何**建窗** API——
    /// 那正是用户退回来的那件事（"网页登录仍然是打开一个新界面"）。
    ///
    /// 扫的是字面量，所以注释里也不许写那两个标识符；说"独立子窗/建窗 API"就够了。
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

    /// 几何：同窗 webview 的坐标原点是**主窗客户区左上角**，所以 x 恒为 0、屏幕坐标不参与。
    #[test]
    fn layout_target_is_client_relative_and_reserves_the_header() {
        let target = layout_target(1280.0, 800.0, LOGIN_VIEW_TOP_INSET);
        assert_eq!(target.x, 0.0, "同窗 webview 里不存在屏幕 x 偏移");
        assert_eq!(target.y, LOGIN_VIEW_TOP_INSET, "顶部让出 header 那一条");
        assert_eq!(target.width, 1280.0, "宽度铺满客户区");
        assert_eq!(target.height, 800.0 - LOGIN_VIEW_TOP_INSET, "高度铺满剩下的客户区");

        // 退化尺寸仍然钳制，且非有限/负输入不许产出 NaN 几何
        let squashed = layout_target(1.0, 1.0, LOGIN_VIEW_TOP_INSET);
        assert_eq!(squashed.width, MIN_LOGIN_WIDTH);
        assert_eq!(squashed.height, MIN_LOGIN_HEIGHT);
        for bad in [f64::NAN, f64::INFINITY, -5.0] {
            let target = layout_target(bad, bad, bad);
            assert!(target.x.is_finite() && target.y.is_finite());
            assert!(target.width >= MIN_LOGIN_WIDTH && target.height >= MIN_LOGIN_HEIGHT);
        }
    }

    // -----------------------------------------------------------------------
    // R16：真机"登录窗空白"的诊断设施
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
        // 真机那条链的落点（id1 的 CAS 门户页）：诊断"窗里停在哪一页"全靠它
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
}
