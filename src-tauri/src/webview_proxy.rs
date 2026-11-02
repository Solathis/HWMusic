//! webview 侧的出口决策：把 `settings.json` 变成建窗参数（`proxy_url` 或强制直连的浏览器参数），
//! 并读 Windows 系统代理（HKCU Internet Settings）。webview 请求走 WebView2 自己的网络栈、绕开 sidecar 的 dispatcher，
//! 所以建窗时必须先定出口：只有「全部请求」才把请求交给代理，其余一律强制直连。
//! 两条硬规则：凭据不进 URL——Chromium 的 `--proxy-server` 不接受内联凭据，凭据只能丢弃且必须被
//! [`WebviewProxy::credentials_dropped`] 报告；形状不认识一律按默认档（系统代理、仅检查更新），绝不猜。
//! 日志只允许出现 `host:port`：[`describe`] 与 [`describe_update_network`] 是唯一出口，有用例钉住它们不含凭据。

use std::path::Path;

use serde_json::Value;

/// 设置文件名（Node 侧 `src/main/settings.mjs` 的同名字面量，两侧由测试互钉）。
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// 设置文件 schema 版本（Node 侧同名字面量）。
pub const SETTINGS_SCHEMA_VERSION: f64 = 1.0;

/// webview 代理的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebviewProxy {
    /// `http://host:port` —— 只有主机与端口，**绝不含凭据**。
    pub url: String,
    /// 设置里带了凭据但被丢弃（Chromium 不吃内联凭据）：必须让调用方看见。
    pub credentials_dropped: bool,
}

/// host 清洗：只接受主机名 / 裸 IPv4 / 带方括号的 IPv6，其余一律 `None`；规则与 Node `cleanHost` 对齐。
/// 拒绝协议前缀、路径/查询/片段/userinfo、空白、多冒号（端口另字段）与非 ASCII；方括号内还须能 `Ipv6Addr` 解析。
pub fn clean_host(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://") {
        return None;
    }
    if trimmed.chars().any(|c| matches!(c, '/' | '?' | '#' | '@')) {
        return None;
    }
    if trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    if let Some(inner) = trimmed.strip_prefix('[') {
        let inner = inner.strip_suffix(']')?;
        // 字符集合法 ≠ 结构合法：这里用标准库结构闸门，与 Node 侧 `node:net isIPv6` 对齐
        return inner
            .parse::<std::net::Ipv6Addr>()
            .ok()
            .map(|_| trimmed.to_string());
    }
    if trimmed.contains(':') {
        return None;
    }
    let hostname_charset = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !hostname_charset || !trimmed.chars().any(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(trimmed.to_string())
}

/// 端口清洗：`1..=65535` 的整数值才收（JSON 里的 `1080` 到 serde 就是 `f64`，所以入参是浮点）；
/// 0 / 越界 / 小数 / NaN / 无穷一律 `None`（= 没填）。
pub fn clean_port(raw: Option<f64>) -> Option<u16> {
    let value = raw?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    if !(1.0..=65535.0).contains(&value) {
        return None;
    }
    Some(value as u16)
}

/// 判定 webview 代理：所有 `None` 都是「当作没配」而非错误（未启用、host 可疑、端口不全）。
/// 凭据不进 URL，带了凭据只置 [`WebviewProxy::credentials_dropped`]——丢弃必须被报告，不能假装认证可用。
pub fn webview_proxy_url(
    enabled: Option<bool>,
    host: Option<&str>,
    port: Option<f64>,
    username: Option<&str>,
    password: Option<&str>,
) -> Option<WebviewProxy> {
    if enabled != Some(true) {
        return None;
    }
    let host = clean_host(host)?;
    let port = clean_port(port)?;
    let credentials_dropped = [username, password]
        .into_iter()
        .flatten()
        .any(|value| !value.is_empty());
    Some(WebviewProxy {
        url: format!("http://{host}:{port}"),
        credentials_dropped,
    })
}

/// `settings.json` 文本里的 `data.proxy` 对象：非 JSON、非对象、`schemaVersion` 不是 1、缺 `data` 或 `proxy` 不是对象都是 `None`。
fn proxy_section(raw: &str) -> Option<serde_json::Map<String, Value>> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let document = value.as_object()?;
    if document.get("schemaVersion").and_then(Value::as_f64) != Some(SETTINGS_SCHEMA_VERSION) {
        return None;
    }
    document.get("data")?.as_object()?.get("proxy")?.as_object().cloned()
}

/// 取一个字符串字段（类型不对 = 没填）。
fn field<'a>(proxy: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    proxy.get(key).and_then(Value::as_str)
}

/// 代理方式（与 Node `src/shared/proxy-mode.mjs` 的 PROXY_MODES 同序、同值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyMode {
    Off,
    System,
    Custom,
}

/// 作用范围（与 Node 的 PROXY_SCOPES 同序、同值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyScope {
    All,
    Update,
}

/// 方式与作用范围归一：与 Node `proxyModeAndScope` 逐条对齐（缺失时旧文档 `enabled === true` 记自定义、否则系统）。
fn proxy_mode_and_scope(proxy: Option<&serde_json::Map<String, Value>>) -> (ProxyMode, ProxyScope) {
    let mode = match proxy.and_then(|proxy| field(proxy, "mode")) {
        Some("off") => ProxyMode::Off,
        Some("system") => ProxyMode::System,
        Some("custom") => ProxyMode::Custom,
        _ if proxy.and_then(|proxy| proxy.get("enabled")).and_then(Value::as_bool) == Some(true) => ProxyMode::Custom,
        _ => ProxyMode::System,
    };
    let scope = match proxy.and_then(|proxy| field(proxy, "scope")) {
        Some("all") => ProxyScope::All,
        Some("update") => ProxyScope::Update,
        _ if mode == ProxyMode::Custom => ProxyScope::All,
        _ => ProxyScope::Update,
    };
    (mode, scope)
}

/// 强制直连的浏览器参数：wry 只在没设 `additional_browser_args` 时用自己的默认串，设了就整串替换，所以要带上默认的那些。
const DIRECT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --no-proxy-server";

/// webview 的网络出口。同一数据目录下的 webview 必须拿到同一份参数（WebView2 建第二个环境时参数不一致会直接失败），
/// 所以登录页与两个浮动控件用同一个值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebviewNetwork {
    /// 自定义代理：只给 `proxy_url`，URL 里没有凭据。
    Proxy(WebviewProxy),
    /// 跟随系统代理：两样都不传（WebView2 默认就走系统代理）。
    FollowSystem,
    /// 强制直连：只给 `additional_browser_args`。代理关着、只用于检查更新、自定义没填全，都走这里。
    Direct,
}

impl WebviewNetwork {
    /// 交给 `builder.proxy_url`；解析不了就返回 `None`（跟随系统），一个配置错误不能把窗口建不起来。
    pub fn proxy_url(&self) -> Option<tauri::Url> {
        match self {
            WebviewNetwork::Proxy(proxy) => crate::proxy_url_argument(Some(proxy.url.clone())),
            WebviewNetwork::FollowSystem | WebviewNetwork::Direct => None,
        }
    }

    /// 交给 `builder.additional_browser_args`：只有强制直连才返回（代理由 wry 按 `proxy_url` 自己拼参数）。
    pub fn browser_args(&self) -> Option<&'static str> {
        match self {
            WebviewNetwork::Direct => Some(DIRECT_BROWSER_ARGS),
            WebviewNetwork::Proxy(_) | WebviewNetwork::FollowSystem => None,
        }
    }
}

/// 代理设置 → webview 出口：只有自定义 + 全部请求才用设置里的代理。
pub fn webview_network(proxy: Option<&serde_json::Map<String, Value>>) -> WebviewNetwork {
    match proxy_mode_and_scope(proxy) {
        (ProxyMode::Off, _) | (_, ProxyScope::Update) => WebviewNetwork::Direct,
        (ProxyMode::System, ProxyScope::All) => WebviewNetwork::FollowSystem,
        (ProxyMode::Custom, ProxyScope::All) => {
            let proxy = proxy.expect("自定义方式只可能来自存在的代理对象");
            match webview_proxy_url(
                Some(true),
                field(proxy, "host"),
                proxy.get("port").and_then(Value::as_f64),
                field(proxy, "username"),
                field(proxy, "password"),
            ) {
                Some(proxy) => WebviewNetwork::Proxy(proxy),
                // 自定义没填全：与改动前一样不传代理参数（跟随系统）。
                None => WebviewNetwork::FollowSystem,
            }
        }
    }
}

/// `settings.json` 文本 → 建窗出口：认不出的文档按默认档（系统代理、仅检查更新 → 强制直连），绝不猜。
pub fn parse_settings(raw: &str) -> WebviewNetwork {
    webview_network(proxy_section(raw).as_ref())
}

/// 读数据目录下的 `settings.json`：读不到（没有 / 读不了 / 坏 JSON）就是默认档，不是错误。
pub fn read_proxy(data_dir: &Path) -> WebviewNetwork {
    let raw = std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)).unwrap_or_default();
    parse_settings(&raw)
}

/// 一行可见日志（**只有 `host:port`**）：给建窗用。纯函数，为的是让"日志里绝不出现用户名/密码"可以被用例直接断言。
pub fn describe(window_tag: &str, network: &WebviewNetwork) -> String {
    match network {
        WebviewNetwork::Proxy(proxy) if proxy.credentials_dropped => format!(
            "窗口 {window_tag} 的 webview 代理：{}（凭据已丢弃：Chromium 的 --proxy-server 不接受内联凭据，认证代理需要另想办法）",
            proxy.url
        ),
        WebviewNetwork::Proxy(proxy) => format!("窗口 {window_tag} 的 webview 代理：{}", proxy.url),
        WebviewNetwork::FollowSystem => format!("窗口 {window_tag}：webview 跟随系统代理"),
        WebviewNetwork::Direct => format!("窗口 {window_tag}：webview 强制直连（不传代理参数，加 --no-proxy-server）"),
    }
}

/// 建窗前的取值口子：读盘 → 打一行可见日志 → 交给建窗代码，四个建窗处都调它。`window_tag` 只进日志，不参与判定。
pub fn resolve_for_webview(data_dir: &Path, window_tag: &str) -> WebviewNetwork {
    let network = read_proxy(data_dir);
    log::info!("{}", describe(window_tag, &network));
    network
}

/// 更新请求用的代理：与 webview 同一份设置、同一套主机与端口规则，但凭据保留在 URL 里（reqwest 支持认证代理）。
/// 这个 URL 只交给 `UpdaterBuilder::proxy`，不进日志（日志用 [`describe_update_network`]）。
pub fn updater_proxy_url(
    enabled: Option<bool>,
    host: Option<&str>,
    port: Option<f64>,
    username: Option<&str>,
    password: Option<&str>,
) -> Option<tauri::Url> {
    if enabled != Some(true) {
        return None;
    }
    let host = clean_host(host)?;
    let port = clean_port(port)?;
    let mut url = tauri::Url::parse(&format!("http://{host}:{port}")).ok()?;
    if let Some(username) = username.filter(|value| !value.is_empty()) {
        url.set_username(username).ok()?;
        url.set_password(password.filter(|value| !value.is_empty())).ok()?;
    }
    Some(url)
}

/// 更新检查的网络出口：与 webview、内核同一份设置；检查更新不看作用范围（选了哪种方式就照哪种走）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateNetwork {
    /// 强制直连：附带原因（不使用代理 / 系统没设代理 / 自定义没填全），只进日志。
    Direct(&'static str),
    /// 系统代理（已归一成 `http://host:port`，没有凭据）。
    System(tauri::Url),
    /// 自定义代理（凭据留在 URL 里，只交给 reqwest）。
    Custom(tauri::Url),
}

impl UpdateNetwork {
    /// 交给 `UpdaterBuilder::proxy`；`None` 必须配合 `no_proxy()`，否则 reqwest 会自己回到系统代理。
    pub fn proxy_url(&self) -> Option<tauri::Url> {
        match self {
            UpdateNetwork::Direct(_) => None,
            UpdateNetwork::System(url) | UpdateNetwork::Custom(url) => Some(url.clone()),
        }
    }
}

/// 更新请求的代理日志：只有 `host:port`，绝不含凭据。
pub fn describe_update_network(network: &UpdateNetwork) -> String {
    match network {
        UpdateNetwork::Direct(reason) => format!("直连（{reason}）"),
        UpdateNetwork::System(url) => format!("经系统代理 {}", host_port(url)),
        UpdateNetwork::Custom(url) => format!("经 HTTP 代理 {}", host_port(url)),
    }
}

/// 只取 `host:port`：日志的唯一出口，凭据绝不出现。
fn host_port(url: &tauri::Url) -> String {
    match (url.host_str(), url.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        _ => "（地址不可读）".to_string(),
    }
}

/// 更新检查走哪条出口：不使用代理 → 直连；系统代理 → 系统有就用，没有直连；自定义 → 填全才用，否则直连。
pub fn update_network(
    proxy: Option<&serde_json::Map<String, Value>>,
    system: impl FnOnce() -> Option<String>,
) -> UpdateNetwork {
    match proxy_mode_and_scope(proxy).0 {
        ProxyMode::Off => UpdateNetwork::Direct("不使用代理"),
        ProxyMode::System => match system().and_then(|raw| tauri::Url::parse(&raw).ok()) {
            Some(url) => UpdateNetwork::System(url),
            None => UpdateNetwork::Direct("系统没有设置代理"),
        },
        ProxyMode::Custom => {
            let proxy = proxy.expect("自定义方式只可能来自存在的代理对象");
            match updater_proxy_url(
                Some(true),
                field(proxy, "host"),
                proxy.get("port").and_then(Value::as_f64),
                field(proxy, "username"),
                field(proxy, "password"),
            ) {
                Some(url) => UpdateNetwork::Custom(url),
                None => UpdateNetwork::Direct("自定义代理没填全"),
            }
        }
    }
}

/// 读数据目录下的 `settings.json`，决定更新检查的出口；数据目录或文件不在都是默认档（跟随系统代理）。
pub fn read_update_network(
    data_dir: Option<&Path>,
    system: impl FnOnce() -> Option<String>,
) -> UpdateNetwork {
    let proxy = data_dir.and_then(|dir| {
        std::fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).ok().and_then(|raw| proxy_section(&raw))
    });
    update_network(proxy.as_ref(), system)
}

/// Windows：读 HKCU Internet Settings 的手动代理（PAC 暂不支持），统一成 `http://host:port`。
/// 其他平台一律 `None`（WebKit 的 webview 自己跟随系统代理）。
#[cfg(windows)]
pub fn system_proxy() -> Option<String> {
    registry::manual_proxy()
}

/// 非 Windows 没有注册表可读，也不猜任何系统设置。
#[cfg(not(windows))]
pub fn system_proxy() -> Option<String> {
    None
}

/// `ProxyServer` 的两种写法 → `http://host:port`：`host:port`，或 `http=h:p;https=h:p;socks=h:p`（优先 https，其次 http）。
/// 没写端口按 WinINet 的规矩补 80；认不出的写法一律 `None`（宁可直连，也不猜一个代理）。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let endpoint = if raw.contains('=') {
        proxy_for(raw, "https").or_else(|| proxy_for(raw, "http"))?
    } else {
        raw.strip_prefix("http://").unwrap_or(raw)
    };
    let (host, port) = proxy_endpoint(endpoint)?;
    Some(format!("http://{host}:{port}"))
}

/// 取 `key=value;...` 里某个协议的条目（键不分大小写，空值当作没有）。
#[cfg_attr(not(windows), allow(dead_code))]
fn proxy_for<'a>(raw: &'a str, scheme: &str) -> Option<&'a str> {
    raw.split(';')
        .filter_map(|entry| entry.split_once('='))
        .find(|(key, value)| key.trim().eq_ignore_ascii_case(scheme) && !value.trim().is_empty())
        .map(|(_, value)| value.trim())
}

/// `host:port` 或裸 `host`（补 80）→ 清洗过的 `(host, port)`；`[::1]:8080` 这类方括号写法照收。
#[cfg_attr(not(windows), allow(dead_code))]
fn proxy_endpoint(raw: &str) -> Option<(String, u16)> {
    if raw.is_empty() {
        return None;
    }
    let (host, port) = if raw.ends_with(']') || !raw.contains(':') {
        (raw, 80u16)
    } else {
        let (host, port) = raw.rsplit_once(':')?;
        (host, port.parse::<u16>().ok()?)
    };
    let host = clean_host(Some(host))?;
    let port = clean_port(Some(f64::from(port)))?;
    Some((host, port))
}

/// 只读注册表（HKCU Internet Settings → RegGetValueW），不写、不改任何系统设置。
#[cfg(windows)]
mod registry {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    /// 注册表键路径（反斜杠分隔；UTF-16 缓冲自己拼，避免宏带进别的 windows-core 版本）。
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    /// 字符串 → NUL 结尾的 UTF-16。
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 读一个值：None = 不存在 / 类型不符 / 被禁用；长度按返回的字节数截断。
    fn raw_value(name: &str, flags: windows::Win32::System::Registry::REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
        let key = wide(KEY);
        let value = wide(name);
        let mut kind = Default::default();
        let mut size = 0u32;
        // SAFETY：两个空指针就是「只问需要多大」；失败说明值不存在。
        if unsafe {
            RegGetValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(value.as_ptr()), flags, Some(&mut kind), None, Some(&mut size as *mut u32))
        }
        .is_err()
        {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        // SAFETY：缓冲区按上一步问到的字节数分配；size 回填后按实际长度截断。
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(value.as_ptr()),
                flags,
                Some(&mut kind),
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size as *mut u32),
            )
        };
        if status.is_err() {
            return None;
        }
        buffer.truncate(size as usize);
        Some(buffer)
    }

    fn dword(name: &str) -> Option<u32> {
        raw_value(name, RRF_RT_REG_DWORD).and_then(|bytes| (bytes.len() >= 4).then(|| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
    }

    fn string(name: &str) -> Option<String> {
        let bytes = raw_value(name, RRF_RT_REG_SZ)?;
        let wide: Vec<u16> = bytes.chunks_exact(2).map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect();
        let text = String::from_utf16_lossy(&wide);
        let text = text.trim_end_matches(char::from(0)).trim();
        (!text.is_empty()).then(|| text.to_string())
    }

    pub fn manual_proxy() -> Option<String> {
        if dword("ProxyEnable") != Some(1) {
            return None;
        }
        match string("ProxyServer") {
            Some(server) => match super::parse_proxy_server(&server) {
                Some(url) => Some(url),
                None => {
                    log::warn!("系统代理的写法没认出来（只认 host:port 或 http=/https= 分协议写法）：按没有系统代理处理");
                    None
                }
            },
            None => {
                if string("AutoConfigURL").is_some() {
                    log::warn!("系统代理用的是自动配置脚本（PAC）：暂不支持，按没有系统代理处理");
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn fixture<T: for<'de> serde::Deserialize<'de>>(raw: &str) -> T {
        serde_json::from_str(raw).expect("夹具必须是合法 JSON")
    }

    #[test]
    fn fixture_host_cases_are_shared_with_node() {
        let raw = std::fs::read_to_string(host_fixture_path()).expect("跨语言夹具必须存在");
        let fixture: Value = fixture(&raw);
        let cases = fixture["cases"].as_array().expect("夹具要有 cases 数组");
        assert!(cases.len() >= 24, "夹具规模不能缩水");

        let port = fixture["port"].as_f64().expect("夹具要有端口");
        for case in cases {
            let host = case["host"].as_str().expect("每条夹具都要有 host");
            let valid = case["valid"].as_bool().expect("每条夹具都要有 valid");
            let why = case["why"].as_str().unwrap_or("");
            let parsed = webview_proxy_url(Some(true), Some(host), Some(port), None, None);
            assert_eq!(
                parsed.is_some(),
                valid,
                "host={host:?}（{why}）：期望 valid={valid}，实际 {parsed:?}"
            );
        }
    }

    #[test]
    fn full_configuration_produces_credential_free_url() {
        let proxy = webview_proxy_url(Some(true), Some("proxy.local"), Some(8080.0), None, None)
            .expect("完整配置必须给出 url");
        assert_eq!(proxy.url, "http://proxy.local:8080");
        assert!(!proxy.credentials_dropped);
    }

    #[test]
    fn credentials_are_dropped_and_reported() {
        let proxy = webview_proxy_url(
            Some(true),
            Some("proxy.local"),
            Some(8080.0),
            Some("webview-user"),
            Some("webview-secret"),
        )
        .expect("凭据不该阻止代理生效");
        assert_eq!(proxy.url, "http://proxy.local:8080");
        assert!(
            proxy.credentials_dropped,
            "丢掉了凭据就必须报告，否则用户以为认证代理能用"
        );
        assert!(!proxy.url.contains("webview-user"), "凭据绝不进 URL：{}", proxy.url);
        assert!(!proxy.url.contains("webview-secret"), "凭据绝不进 URL：{}", proxy.url);
        assert!(!proxy.url.contains('@'), "URL 里没有 userinfo：{}", proxy.url);
    }

    #[test]
    fn only_one_credential_is_still_a_drop() {
        // 只填用户名或只填密码：都算"带了凭据"，都要报告丢弃
        for (user, password) in [(Some("u"), None), (None, Some("p")), (Some("u"), Some(""))] {
            let proxy = webview_proxy_url(Some(true), Some("proxy.local"), Some(8080.0), user, password)
                .expect("缺一半凭据不该让代理失效");
            assert!(proxy.credentials_dropped, "user={user:?} password={password:?}");
        }
        // 两端都是空串 = 没填 = 没丢东西
        let empty = webview_proxy_url(Some(true), Some("proxy.local"), Some(8080.0), Some(""), Some(""))
            .expect("空串就是没填");
        assert!(!empty.credentials_dropped, "空串不算凭据");
    }

    #[test]
    fn disabled_or_missing_enabled_is_not_configured() {
        for enabled in [Some(false), None] {
            assert_eq!(
                webview_proxy_url(enabled, Some("proxy.local"), Some(8080.0), None, None),
                None,
                "enabled={enabled:?} 时字段再全也不算配"
            );
        }
    }

    #[test]
    fn missing_host_or_port_is_not_configured() {
        let cases = [
            (None, Some(8080.0)),
            (Some(""), Some(8080.0)),
            (Some("   "), Some(8080.0)),
            (Some("proxy.local"), None),
            (Some("proxy.local"), Some(0.0)),
        ];
        for (host, port) in cases {
            assert_eq!(
                webview_proxy_url(Some(true), host, port, None, None),
                None,
                "host={host:?} port={port:?} 应视为没配"
            );
        }
    }

    #[test]
    fn json_float_ports_are_accepted_and_odd_ports_rejected() {
        // JS 把 1080 序列化成 1080（也可能 1080.0）：serde 给到的是 f64
        for good in [1080.0, 1.0, 65535.0] {
            assert!(webview_proxy_url(Some(true), Some("proxy.local"), Some(good), None, None).is_some());
        }
        for bad in [0.0, -1.0, 65536.0, 8080.5, f64::NAN, f64::INFINITY] {
            assert_eq!(
                webview_proxy_url(Some(true), Some("proxy.local"), Some(bad), None, None),
                None,
                "端口 {bad} 应视为没填"
            );
        }
    }

    #[test]
    fn bracketed_ipv6_is_allowed_bare_ipv6_is_not() {
        let proxy = webview_proxy_url(Some(true), Some("[::1]"), Some(3128.0), None, None).expect("方括号 IPv6");
        assert_eq!(proxy.url, "http://[::1]:3128");
        assert_eq!(webview_proxy_url(Some(true), Some("::1"), Some(3128.0), None, None), None);
        assert_eq!(
            webview_proxy_url(Some(true), Some("[2001:db8::1]"), Some(3128.0), None, None)
                .expect("全写 IPv6")
                .url,
            "http://[2001:db8::1]:3128"
        );
    }

    #[test]
    fn parse_settings_rejects_bad_shapes_without_guessing() {
        let good_proxy = json!({
            "enabled": true, "host": "proxy.local", "port": 1080.0,
            "username": "", "password": "", "bypass": ["localhost"]
        });
        // 认不出的文档按默认档（系统代理 + 仅检查更新）：WebView 强制直连，绝不猜一个代理出来
        let bad = vec![
            "".to_string(),
            "不是 JSON".to_string(),
            "null".to_string(),
            "[]".to_string(),
            json!("settings").to_string(),
            "42".to_string(),
            json!({ "data": { "proxy": good_proxy } }).to_string(),
            json!({ "schemaVersion": 2, "data": { "proxy": good_proxy } }).to_string(),
            json!({ "schemaVersion": "1", "data": { "proxy": good_proxy } }).to_string(),
            json!({ "schemaVersion": 1 }).to_string(),
            json!({ "schemaVersion": 1, "data": null }).to_string(),
            json!({ "schemaVersion": 1, "data": [] }).to_string(),
            json!({ "schemaVersion": 1, "data": { "proxy": "proxy.local" } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "proxy": null } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "proxy": {} } }).to_string(),
            json!({ "schemaVersion": 1, "data": {} }).to_string(),
        ];
        for raw in bad {
            assert_eq!(parse_settings(&raw), WebviewNetwork::Direct, "坏形状必须按默认档，绝不猜：{raw}");
        }
        // 旧版 enabled=true 但没填全：与改动前一样不传代理参数（跟随系统）
        let partial = json!({ "schemaVersion": 1, "data": { "proxy": { "enabled": true, "host": "proxy.local" } } }).to_string();
        assert_eq!(parse_settings(&partial), WebviewNetwork::FollowSystem);
    }

    #[test]
    fn parse_settings_reads_valid_document_with_float_port() {
        let raw = json!({
            "schemaVersion": 1,
            "data": {
                "proxy": {
                    "enabled": true, "host": "proxy.local", "port": 1080.0,
                    "username": "webview-user", "password": "webview-secret",
                    "bypass": ["localhost", "127.0.0.1"]
                },
                "closeBehavior": "tray"
            }
        })
        .to_string();
        let expected = WebviewNetwork::Proxy(WebviewProxy { url: "http://proxy.local:1080".to_string(), credentials_dropped: true });
        assert_eq!(parse_settings(&raw), expected, "旧版 enabled=true 的文档 = 自定义 + 全部请求");
        assert_eq!(parse_settings(&raw.replace("1080.0", "1080")), expected, "整数端口同样可读");
    }

    #[test]
    fn read_proxy_missing_or_broken_file_is_the_default() {
        let dir = test_dir("read-proxy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(read_proxy(&dir), WebviewNetwork::Direct, "读不到就是默认档（不是错误）");

        std::fs::write(dir.join(SETTINGS_FILE_NAME), "{ 半个 JSON").expect("坏文件要能写");
        assert_eq!(read_proxy(&dir), WebviewNetwork::Direct, "坏文件同样按默认档");

        std::fs::write(
            dir.join(SETTINGS_FILE_NAME),
            json!({
                "schemaVersion": 1,
                "data": { "proxy": { "enabled": true, "host": "proxy.local", "port": 8080 } }
            })
            .to_string(),
        )
        .expect("好文件要能写");
        assert_eq!(
            read_proxy(&dir).proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://proxy.local:8080/")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_for_webview_returns_the_decision_and_logs_without_credentials() {
        let dir = test_dir("resolve-webview");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(resolve_for_webview(&dir, "main"), WebviewNetwork::Direct, "没有设置文件 → 默认档强制直连");

        std::fs::write(
            dir.join(SETTINGS_FILE_NAME),
            json!({
                "schemaVersion": 1,
                "data": {
                    "proxy": {
                        "enabled": true, "host": "proxy.local", "port": 8080,
                        "username": "webview-user", "password": "webview-secret"
                    }
                }
            })
            .to_string(),
        )
        .expect("好文件要能写");
        assert_eq!(
            resolve_for_webview(&dir, "main").proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://proxy.local:8080/")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn describe_line_has_host_port_and_never_credentials() {
        let proxy = WebviewNetwork::Proxy(WebviewProxy {
            url: "http://proxy.local:8080".to_string(),
            credentials_dropped: true,
        });
        let line = describe("main", &proxy);
        assert!(line.contains("main"), "要说清是哪个窗口：{line}");
        assert!(line.contains("proxy.local:8080"), "要说清去哪：{line}");
        assert!(line.contains("凭据") && line.contains("丢弃"), "丢弃必须被报告：{line}");
        assert!(!line.contains("webview-user"), "日志里不得出现用户名：{line}");
        assert!(!line.contains("webview-secret"), "日志里不得出现密码：{line}");

        let direct = describe("main", &WebviewNetwork::Direct);
        assert!(direct.contains("main") && direct.contains("直连"), "强制直连要说成直连：{direct}");
        let system = describe("main", &WebviewNetwork::FollowSystem);
        assert!(system.contains("跟随系统代理") && !system.contains("直连"), "不传参数是跟随系统，不能说成直连：{system}");
    }

    #[test]
    fn clean_host_trims_and_rejects_multi_colon_without_brackets() {
        assert_eq!(clean_host(Some("  proxy.local  ")).as_deref(), Some("proxy.local"));
        assert_eq!(clean_host(Some("proxy.local:8080")), None);
        assert_eq!(clean_host(None), None);
        assert_eq!(clean_port(Some(8080.0)), Some(8080));
        assert_eq!(clean_port(Some(0.0)), None);
    }
    #[test]
    fn updater_proxy_keeps_encoded_credentials_but_logs_never_do() {
        let url = updater_proxy_url(Some(true), Some(" proxy.lan "), Some(8080.0), Some("user"), Some("p@ss:w"))
            .expect("完整配置要得到 URL");
        assert_eq!(url.as_str(), "http://user:p%40ss%3Aw@proxy.lan:8080/");
        let line = describe_update_network(&UpdateNetwork::Custom(url));
        assert_eq!(line, "经 HTTP 代理 proxy.lan:8080");
        assert!(!line.contains("user") && !line.contains("p%40ss"), "日志不含凭据：{line}");
        let system = tauri::Url::parse("http://127.0.0.1:7890").expect("系统代理地址");
        assert_eq!(describe_update_network(&UpdateNetwork::System(system)), "经系统代理 127.0.0.1:7890");
        assert_eq!(describe_update_network(&UpdateNetwork::Direct("不使用代理")), "直连（不使用代理）");
    }

    #[test]
    fn read_update_network_reads_the_same_settings_document() {
        let dir = test_dir("update-proxy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");
        let system = || Some("http://127.0.0.1:7890".to_string());

        assert_eq!(read_update_network(Some(&dir), system), UpdateNetwork::System(tauri::Url::parse("http://127.0.0.1:7890").expect("系统代理")));

        std::fs::write(
            dir.join(SETTINGS_FILE_NAME),
            json!({
                "schemaVersion": 1,
                "data": {
                    "proxy": {
                        "enabled": true, "host": "127.0.0.1", "port": 7890,
                        "username": "u", "password": "p", "scope": "update"
                    }
                }
            })
            .to_string(),
        )
        .expect("设置文件要能写");
        assert_eq!(
            read_update_network(Some(&dir), system).proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://u:p@127.0.0.1:7890/")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_network_follows_the_mode_and_probes_the_system_proxy_only_when_asked() {
        let probes = std::cell::Cell::new(0);
        let system = || {
            probes.set(probes.get() + 1);
            Some("http://127.0.0.1:7890".to_string())
        };

        assert_eq!(
            update_network(None, system).proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://127.0.0.1:7890/"),
            "没有设置文件 = 默认档：更新器跟随系统代理"
        );
        assert_eq!(probes.get(), 1, "默认档要问系统代理");

        let off = json!({ "mode": "off", "host": "proxy.local", "port": 8080 });
        assert_eq!(update_network(off.as_object(), system), UpdateNetwork::Direct("不使用代理"));
        assert_eq!(probes.get(), 1, "off 档不该去问系统代理");

        let system_mode = json!({ "mode": "system" });
        assert_eq!(
            update_network(system_mode.as_object(), system).proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://127.0.0.1:7890/")
        );
        assert_eq!(probes.get(), 2, "system 档每次都要问系统代理");

        let none = || None;
        let silent = json!({ "mode": "system" });
        assert_eq!(
            update_network(silent.as_object(), none),
            UpdateNetwork::Direct("系统没有设置代理"),
            "系统没有代理就直连"
        );

        let custom = json!({ "mode": "custom", "host": "proxy.local", "port": 8080, "username": "u", "password": "p" });
        assert_eq!(
            update_network(custom.as_object(), none).proxy_url().map(|url| url.to_string()).as_deref(),
            Some("http://u:p@proxy.local:8080/"),
            "自定义代理把凭据留在 URL 里（reqwest 支持认证代理）"
        );

        let incomplete = json!({ "mode": "custom", "host": "proxy.local" });
        assert_eq!(
            update_network(incomplete.as_object(), system),
            UpdateNetwork::Direct("自定义代理没填全"),
            "自定义没填全就直连，不拿系统代理顶替"
        );
        assert_eq!(probes.get(), 2, "自定义档不该去问系统代理");

        let bad_url = json!({ "mode": "system" });
        assert_eq!(
            update_network(bad_url.as_object(), || Some("不是地址".to_string())),
            UpdateNetwork::Direct("系统没有设置代理")
        );
    }

    #[test]
    fn direct_mode_keeps_wry_defaults_and_adds_no_proxy_server() {
        assert!(DIRECT_BROWSER_ARGS.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"), "wry 的默认串必须原样带上：{DIRECT_BROWSER_ARGS}");
        assert!(DIRECT_BROWSER_ARGS.contains("--no-proxy-server"), "强制直连就是这一个参数：{DIRECT_BROWSER_ARGS}");
        assert_eq!(WebviewNetwork::Direct.browser_args(), Some(DIRECT_BROWSER_ARGS));
        assert_eq!(WebviewNetwork::FollowSystem.browser_args(), None, "跟随系统不传参数");
        assert_eq!(WebviewNetwork::FollowSystem.proxy_url(), None, "跟随系统不传 proxy_url");

        let proxy = WebviewNetwork::Proxy(WebviewProxy { url: "http://proxy.local:8080".to_string(), credentials_dropped: false });
        assert_eq!(proxy.browser_args(), None, "代理走 proxy_url，不自己拼 --proxy-server");
        assert_eq!(proxy.proxy_url().map(|url| url.to_string()).as_deref(), Some("http://proxy.local:8080/"));
    }

    #[test]
    fn proxy_server_values_are_normalized_like_wininet() {
        let cases = [
            ("127.0.0.1:7890", Some("http://127.0.0.1:7890")),
            ("  proxy.local:8080  ", Some("http://proxy.local:8080")),
            ("http://proxy.local:8080", Some("http://proxy.local:8080")),
            ("https=secure.corp:8443;http=plain.corp:8080", Some("http://secure.corp:8443")),
            ("http=10.0.0.1:3128", Some("http://10.0.0.1:3128")),
            ("HTTPS=10.0.0.1:3128", Some("http://10.0.0.1:3128")),
            ("https=;http=10.0.0.1:3128", Some("http://10.0.0.1:3128")),
            ("socks=10.0.0.3:1080", None),
            ("[::1]:8080", Some("http://[::1]:8080")),
            ("[::1]", Some("http://[::1]:80")),
            ("proxy.corp", Some("http://proxy.corp:80")),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse_proxy_server(raw).as_deref(), expected, "{raw}");
        }
        for bad in ["", "   ", "127.0.0.1:0", "127.0.0.1:abc", "::1", "user:pass@proxy.corp:8080", "http://proxy corp:8080"] {
            assert_eq!(parse_proxy_server(bad), None, "{bad}");
        }
    }

    #[test]
    fn system_proxy_is_none_or_a_plain_http_credential_free_url() {
        let Some(raw) = system_proxy() else { return };
        assert!(raw.starts_with("http://"), "系统代理统一成 http://host:port：{raw}");
        let url = tauri::Url::parse(&raw).expect("系统代理必须能解析");
        assert_eq!(url.username(), "", "系统代理不带用户名");
        assert_eq!(url.password(), None, "系统代理不带密码");
        assert_eq!(parse_proxy_server(&raw).as_deref(), Some(raw.as_str()), "再解析一遍结果不变");
    }

    #[test]
    fn every_builder_applies_the_same_network_decision() {
        let files = [
            "src/lib.rs",
            "src/lyrics_window.rs",
            "src/lyrics_settings.rs",
            "src/login.rs",
        ];
        for file in files {
            let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file)).expect("要能读到源码");
            let production = match source.find("#[cfg(test)]") {
                Some(cut) => &source[..cut],
                None => &source[..],
            };
            assert!(production.contains("webview_proxy::resolve_for_webview("), "{file} 要经 webview_proxy 解析出口");
            assert!(production.contains(".proxy_url("), "{file} 要把自定义代理接到 builder 上");
            assert!(production.contains(".additional_browser_args("), "{file} 强制直连要接 additional_browser_args");
        }

        let login = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/login.rs")).expect("要能读到登录窗源码");
        let production = match login.find("#[cfg(test)]") {
            Some(cut) => &login[..cut],
            None => &login[..],
        };
        assert!(!production.contains("proxy_url_argument(crate::webview_proxy::resolve_for_webview("), "登录窗必须直接拿 WebviewNetwork，不能再只取 url");
        let chrome = production
            .find("fn build_chrome_on_main_thread(")
            .and_then(|start| {
                let rest = &production[start..];
                rest.find("pub fn chrome_navigation_allowed").map(|end| &rest[..end])
            })
            .expect("浮动控件那一段要在");
        assert!(
            chrome.contains("network.proxy_url()") && chrome.contains("network.browser_args()"),
            "浮动控件与登录页共用一个数据目录：WebView2 的环境参数必须一致，否则后建的窗口建不起来"
        );
    }

    fn host_fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("proxy-host-cases.json")
    }

    fn test_dir(label: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("webview-proxy-test")
            .join(format!("{label}-{}", std::process::id()))
    }
}
