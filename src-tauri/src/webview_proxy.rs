//! webview 侧代理：把 `settings.json` 变成 `WebviewWindowBuilder::proxy_url` 的纯函数层。
//! webview 请求走 WebView2 自己的网络栈、绕开 sidecar 的 dispatcher，所以三个窗口都必须接 proxy_url，
//! 否则封面图和 `<audio>` 音频流会直连。
//! 两条硬规则：凭据不进 URL——Chromium 的 `--proxy-server` 不接受内联凭据，凭据只能丢弃且必须被
//! [`WebviewProxy::credentials_dropped`] 报告；形状不认识一律当没配（`None` 即直连），绝不猜。
//! 日志只允许出现 `host:port`：[`describe`] 是唯一出口，有用例钉住它不含凭据。

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

/// `settings.json` 文本 → webview 代理：非 JSON、非对象、`schemaVersion` 不是 1、缺 `data`、
/// `data.proxy` 不是对象、端口或主机不全，一律 `None`（直连），绝不猜。
pub fn parse_settings(raw: &str) -> Option<WebviewProxy> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let document = value.as_object()?;
    if document.get("schemaVersion").and_then(Value::as_f64) != Some(SETTINGS_SCHEMA_VERSION) {
        return None;
    }
    let proxy = document
        .get("data")?
        .as_object()?
        .get("proxy")?
        .as_object()?;
    webview_proxy_url(
        proxy.get("enabled").and_then(Value::as_bool),
        proxy.get("host").and_then(Value::as_str),
        proxy.get("port").and_then(Value::as_f64),
        proxy.get("username").and_then(Value::as_str),
        proxy.get("password").and_then(Value::as_str),
    )
}

/// 读数据目录下的 `settings.json`：读不到（没有 / 读不了 / 坏 JSON）就是"没有代理"，不是错误。
pub fn read_proxy(data_dir: &Path) -> Option<WebviewProxy> {
    let raw = std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)).ok()?;
    parse_settings(&raw)
}

/// 一行可见日志（**只有 `host:port`**）：给窗口建窗用。
///
/// 这是个纯函数，为的是让"日志里绝不出现用户名/密码"可以被用例直接断言（`resolve_for_webview` 只负责打它）。
pub fn describe(window_tag: &str, proxy: Option<&WebviewProxy>) -> String {
    match proxy {
        Some(proxy) if proxy.credentials_dropped => format!(
            "窗口 {window_tag} 的 webview 代理：{}（凭据已丢弃：Chromium 的 --proxy-server 不接受内联凭据，\
             认证代理需要另想办法）",
            proxy.url
        ),
        Some(proxy) => format!("窗口 {window_tag} 的 webview 代理：{}", proxy.url),
        None => format!("窗口 {window_tag} 未配置代理：webview 直连（封面图与音频流也直连）"),
    }
}

/// 建窗前的取值口子：读盘 → 打一行可见日志 → 交给 `builder.proxy_url`，三个窗口都调它。
/// `window_tag` 只进日志，不参与判定。
pub fn resolve_for_webview(data_dir: &Path, window_tag: &str) -> Option<String> {
    let proxy = read_proxy(data_dir);
    log::info!("{}", describe(window_tag, proxy.as_ref()));
    proxy.map(|proxy| proxy.url)
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
        let bad = vec![
            "".to_string(),
            "不是 JSON".to_string(),
            "null".to_string(),
            "[]".to_string(),
            "\"settings\"".to_string(),
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
            json!({ "schemaVersion": 1, "data": { "proxy": { "enabled": true, "host": "proxy.local" } } })
                .to_string(),
        ];
        for raw in bad {
            assert_eq!(parse_settings(&raw), None, "坏形状必须当没配，绝不猜：{raw}");
        }
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
        let proxy = parse_settings(&raw).expect("合法文档必须给出代理");
        assert_eq!(proxy.url, "http://proxy.local:1080");
        assert!(proxy.credentials_dropped);
        assert_eq!(parse_settings(&raw.replace("1080.0", "1080")).expect("整数端口同样可读").url, "http://proxy.local:1080");
    }

    #[test]
    fn read_proxy_missing_or_broken_file_is_none() {
        let dir = test_dir("read-proxy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(read_proxy(&dir), None, "读不到就是没有（不是错误）");

        std::fs::write(dir.join(SETTINGS_FILE_NAME), "{ 半个 JSON").expect("坏文件要能写");
        assert_eq!(read_proxy(&dir), None, "坏文件同样当没配");

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
            read_proxy(&dir).expect("合法文件必须读出代理").url,
            "http://proxy.local:8080"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_for_webview_returns_url_and_logs_without_credentials() {
        let dir = test_dir("resolve-webview");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(resolve_for_webview(&dir, "main"), None, "没配代理 → 直连（None）");

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
            resolve_for_webview(&dir, "main").as_deref(),
            Some("http://proxy.local:8080")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn describe_line_has_host_port_and_never_credentials() {
        let proxy = WebviewProxy {
            url: "http://proxy.local:8080".to_string(),
            credentials_dropped: true,
        };
        let line = describe("main", Some(&proxy));
        assert!(line.contains("main"), "要说清是哪个窗口：{line}");
        assert!(line.contains("proxy.local:8080"), "要说清去哪：{line}");
        assert!(line.contains("凭据") && line.contains("丢弃"), "丢弃必须被报告：{line}");
        assert!(!line.contains("webview-user"), "日志里不得出现用户名：{line}");
        assert!(!line.contains("webview-secret"), "日志里不得出现密码：{line}");

        let none = describe("main", None);
        assert!(none.contains("main"));
        assert!(none.contains("直连"), "没配要说成直连，不能含糊：{none}");
    }

    #[test]
    fn clean_host_trims_and_rejects_multi_colon_without_brackets() {
        assert_eq!(clean_host(Some("  proxy.local  ")).as_deref(), Some("proxy.local"));
        assert_eq!(clean_host(Some("proxy.local:8080")), None);
        assert_eq!(clean_host(None), None);
        assert_eq!(clean_port(Some(8080.0)), Some(8080));
        assert_eq!(clean_port(Some(0.0)), None);
    }

    fn host_fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test")
            .join("fixtures")
            .join("proxy-host-cases.json")
    }

    fn test_dir(label: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("webview-proxy-test")
            .join(format!("{label}-{}", std::process::id()))
    }
}
