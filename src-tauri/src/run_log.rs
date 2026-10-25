//! 运行日志读取（R56）：把插件日志文件的尾部读成结构化条目，供设置页展示。
//!
//! 唯一调用方是命令 `core_read_run_log`（主窗来源守卫 + 返回前脱敏）。

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 一次最多返回多少条。
pub const READ_LIMIT: usize = 500;

/// 从文件尾部读多少字节（足够 500 条，又不把 4MB 日志整份读进内存）。
const TAIL_WINDOW: u64 = 512 * 1024;

/// 脱敏后的替身。
pub const REDACTED: &str = "***";

/// 一条日志（`time` 是本地时间 `YYYY-MM-DD HH:MM:SS`，解析不出来时为空串）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunLogEntry {
    pub time: String,
    pub level: &'static str,
    pub source: String,
    pub message: String,
}

/// 插件日志文件的目录部分：`<数据根>/logs`。
pub fn log_dir_for(data_root: &Path) -> PathBuf {
    data_root.join(crate::LOG_DIR_NAME)
}

/// 日志目录的决议（与 `log_plugin_targets` 同一档）：覆盖旋钮可用时 `<覆盖值>/logs`，
/// 否则插件的默认落点（`app_log_dir`）。
pub fn resolve_dir(override_value: Option<&str>, app_log_dir: Option<PathBuf>) -> PathBuf {
    match crate::log_folder(override_value) {
        Some(dir) => dir,
        None => app_log_dir.unwrap_or_else(|| PathBuf::from(crate::LOG_DIR_NAME)),
    }
}

/// 目录里最新的 `.log` 文件（插件 KeepOne 策略下通常只有一个）。
pub fn newest_log_file(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("log") {
            continue;
        }
        let Ok(stamp) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(newest, _)| stamp >= *newest) {
            best = Some((stamp, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 把插件日志的一行解析成条目。
///
/// 上游有**两种**行格式（都用 `[...]` 分段）：默认 Builder 是 `[日期][时间][target][级别]`，
/// 而调过 `timezone_strategy()` 之后变成 `[日期][时间][级别][target]`——顺序不同，字段名不认位置只认值。
pub fn parse_line(raw: &str) -> RunLogEntry {
    let mut rest = raw;
    let mut fields: Vec<&str> = Vec::new();
    while fields.len() < 4 {
        let Some(head) = rest.strip_prefix('[') else { break };
        let Some(close) = head.find(']') else { break };
        fields.push(&head[..close]);
        rest = &head[close + 1..];
    }

    let unparsed = |message: &str| RunLogEntry {
        time: String::new(),
        level: "info",
        source: String::new(),
        message: message.to_string(),
    };

    if fields.len() < 3 || !is_date(fields[0]) || !is_clock(fields[1]) {
        return unparsed(raw);
    }

    let (level, source, message) = match fields.len() {
        4 => match parse_level(fields[3]) {
            Some(level) => (level, fields[2], rest.to_string()),
            None => match parse_level(fields[2]) {
                Some(level) => (level, fields[3], rest.to_string()),
                // 两段都不是级别：第 4 段属于正文（解析没认出，不等于可以吞掉一段内容）
                None => ("info", fields[2], format!("[{}]{rest}", fields[3])),
            },
        },
        _ => ("info", fields[2], rest.to_string()),
    };

    RunLogEntry {
        time: format!("{} {}", fields[0], fields[1]),
        level,
        source: source.to_string(),
        message: message.trim_start().to_string(),
    }
}

fn is_date(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) || byte.is_ascii_digit()
        })
}

fn is_clock(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 2 | 5) || byte.is_ascii_digit()
        })
}

/// 级别名（`info` / `warn` / `error` / `debug`）→ 归一化结果。
///
/// `trace` 归到 `debug`：界面上只有四档，多出来的第五档没有对应的筛选项。
pub fn parse_level(raw: &str) -> Option<&'static str> {
    let name = raw.trim().to_ascii_lowercase();
    match name.as_str() {
        "error" => Some("error"),
        "warn" | "warning" => Some("warn"),
        "info" => Some("info"),
        "debug" | "trace" => Some("debug"),
        _ => None,
    }
}

/// sidecar stderr 的一行 → 级别 + 正文。
///
/// sidecar 自己的标记是 `[hwmusic-core][<级别>] 正文`；没有标记的行（多行异常的续行）按 info，
/// 正文一个字都不动——那半截栈正是排障要看的东西。
pub fn stderr_line(raw: &str) -> (&'static str, String) {
    let line = raw.trim_end_matches(['\r', '\n']);
    let Some(body) = line.strip_prefix(crate::sidecar::STDERR_PREFIX) else {
        return ("info", line.to_string());
    };
    let body = body.trim_start();
    if let Some(after) = body.strip_prefix('[') {
        if let Some(close) = after.find(']') {
            if let Some(level) = parse_level(&after[..close]) {
                return (level, after[close + 1..].trim_start().to_string());
            }
        }
    }
    ("info", body.to_string())
}

/// 需要打码的键（小写比较）：查询串/表单一律按 `键=值` 处理。
const SECRET_KEYS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-auth-token",
    "cookie",
    "set-cookie",
    "token",
    "access_token",
    "access-token",
    "accesstoken",
    "refresh_token",
    "refresh-token",
    "refreshtoken",
    "id_token",
    "code",
    "ticket",
    "auth_ticket",
    "sign",
    "sig",
    "signature",
    "sessionid",
    "session_id",
    "devicedata",
    "accesskeyid",
    "password",
    "passwd",
    "pwd",
    "secret",
];

/// 头部类的键：值一直打到行尾（它们的值本身就可能带空格）。
const HEADER_KEYS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "x-auth-token",
    "cookie",
    "set-cookie",
];

/// 把可能内联着凭据的文本打码。
///
/// 三条规则，按顺序：`Bearer <令牌>` → `头部名: 值` → `键=值`（键在 [`SECRET_KEYS`] 里）。
/// 只打码值、保留键与其余文字：日志是给人看的，抹掉整行等于把排障线索一起抹掉。
pub fn redact(text: &str) -> String {
    let after_bearer = redact_marked(text, "bearer");
    let after_headers = redact_headers(&after_bearer);
    redact_values(&after_headers)
}

/// `Bearer xxx` → `Bearer ***`（`xxx` 到空白或常见分隔符为止）。
fn redact_marked(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = find_word(text, marker, cursor) {
        let after_word = found + marker.len();
        let Some(space) = text[after_word..].find(char::is_whitespace).map(|at| after_word + at) else {
            break;
        };
        let value_start = space + (text[space..].len() - text[space..].trim_start().len());
        let value_end = text[value_start..]
            .find(|ch: char| ch.is_whitespace() || "'\"&,;)]}".contains(ch))
            .map(|at| value_start + at)
            .unwrap_or(text.len());
        if value_end <= value_start || &text[value_start..value_end] == REDACTED {
            cursor = after_word;
            continue;
        }
        out.push_str(&text[cursor..value_start]);
        out.push_str(REDACTED);
        cursor = value_end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// `头部名: 值` → `头部名: ***`（值到行尾）。
fn redact_headers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search = 0;
    while let Some((key_at, key_len)) = find_any_key(text, HEADER_KEYS, search) {
        let after_key = key_at + key_len;
        let tail = &text[after_key..];
        let trimmed = tail.trim_start_matches([' ', '\t']);
        let Some(colon) = trimmed.strip_prefix(':') else {
            search = after_key;
            continue;
        };
        let value_start = after_key + (tail.len() - trimmed.len()) + 1 + space_len(colon);
        let value_end = text[value_start..]
            .find(['\n', '\r'])
            .map(|at| value_start + at)
            .unwrap_or(text.len());
        if value_end <= value_start || text[value_start..value_end].trim() == REDACTED {
            search = value_start;
            continue;
        }
        out.push_str(&text[cursor..value_start]);
        out.push_str(REDACTED);
        cursor = value_end;
        search = value_end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// `键=值` → `键=***`（键在 [`SECRET_KEYS`] 里；值到空白或 `&;,"')]}` 为止）。
fn redact_values(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut search = 0;
    while let Some((key_at, key_len)) = find_any_key(text, SECRET_KEYS, search) {
        let after_key = key_at + key_len;
        let Some(rest) = text[after_key..].strip_prefix('=') else {
            search = after_key;
            continue;
        };
        let _ = rest;
        let value_start = after_key + 1;
        let value_end = text[value_start..]
            .find(|ch: char| ch.is_whitespace() || "&;,\"')]}<>".contains(ch))
            .map(|at| value_start + at)
            .unwrap_or(text.len());
        if value_end <= value_start || text[value_start..value_end].trim() == REDACTED {
            search = value_start;
            continue;
        }
        out.push_str(&text[cursor..value_start]);
        out.push_str(REDACTED);
        cursor = value_end;
        search = value_end;
    }
    out.push_str(&text[cursor..]);
    out
}

fn space_len(raw: &str) -> usize {
    raw.len() - raw.trim_start_matches([' ', '\t']).len()
}

/// 在 `from` 之后找整词 `word`（ASCII 大小写不敏感，前一字符不能是词字符）。
fn find_word(text: &str, word: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = from;
    while index + word.len() <= bytes.len() {
        if bytes[index..index + word.len()].eq_ignore_ascii_case(word.as_bytes())
            && is_boundary_before(text, index)
            && !is_word_byte(bytes.get(index + word.len()).copied())
        {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn find_any_key(text: &str, keys: &[&str], from: usize) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for key in keys {
        let Some(at) = find_word(text, key, from) else {
            continue;
        };
        if best.is_none_or(|(current, _)| at < current) {
            best = Some((at, key.len()));
        }
    }
    best
}

fn is_boundary_before(text: &str, index: usize) -> bool {
    match text[..index].chars().next_back() {
        None => true,
        Some(ch) => !is_word_char(ch),
    }
}

fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_word_byte(byte: Option<u8>) -> bool {
    byte.is_some_and(|value| value.is_ascii_alphanumeric() || value == b'_')
}

/// 文件尾部若干行（最新的一行在末尾）。
pub fn read_tail(path: &Path, limit: usize) -> io::Result<Vec<String>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut lines = read_window(path, TAIL_WINDOW)?;
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines)
}

/// 文件尾部一个字节窗口内的完整行（`window` 从中间切入时丢掉那半行）。
pub fn read_window(path: &Path, window: u64) -> io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(window);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        match text.find('\n') {
            Some(at) => {
                text.drain(..=at);
            }
            None => text.clear(),
        }
    }
    Ok(text.lines().map(|line| line.to_string()).collect())
}

/// 目录里最新日志文件的最后 `limit` 条（旧的在前）。
pub fn read_entries(dir: &Path, limit: usize) -> io::Result<Vec<RunLogEntry>> {
    let Some(path) = newest_log_file(dir) else {
        return Ok(Vec::new());
    };
    let lines = read_tail(&path, limit)?;
    Ok(lines
        .into_iter()
        .map(|line| {
            let mut entry = parse_line(&line);
            entry.message = redact(&entry.message);
            entry
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 测试临时目录：放 `src-tauri/target/` 下（构建产物区，已在 .gitignore 内）。
    fn scratch(label: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("run-log-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("测试目录");
        dir
    }

    fn write_lines(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, lines.join("\n") + "\n").expect("写夹具");
        path
    }

    #[test]
    fn parses_the_default_builder_line_shape() {
        let entry = parse_line("[2026-10-26][05:12:33][hwmusic_core][INFO] 已就绪（频道 21 条）");
        assert_eq!(entry.time, "2026-10-26 05:12:33");
        assert_eq!(entry.level, "info");
        assert_eq!(entry.source, "hwmusic_core");
        assert_eq!(entry.message, "已就绪（频道 21 条）");
    }

    #[test]
    fn parses_the_timezone_strategy_line_shape_too() {
        // `.timezone_strategy()` 会把格式换成 [时间][级别][target]（上游顺序不同），
        // 两种形状都必须认：认不出就等于把日志里的级别丢了。
        let entry = parse_line("[2026-10-26][05:12:33][WARN][hwmusic_core] 代理不可用");
        assert_eq!(entry.time, "2026-10-26 05:12:33");
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.source, "hwmusic_core");
        assert_eq!(entry.message, "代理不可用");
    }

    #[test]
    fn keeps_unparseable_lines_as_info_verbatim() {
        for raw in ["    at Object.<anonymous> (file:///x.mjs:1:1)", "", "[坏了", "纯中文一行"] {
            let entry = parse_line(raw);
            assert_eq!(entry.level, "info", "解析失败的行按 info：{raw}");
            assert_eq!(entry.message, raw, "原样保留（不丢内容）：{raw}");
        }
    }

    #[test]
    fn parses_every_level_name_case_insensitively() {
        assert_eq!(parse_level("ERROR"), Some("error"));
        assert_eq!(parse_level("warn"), Some("warn"));
        assert_eq!(parse_level(" Info "), Some("info"));
        assert_eq!(parse_level("debug"), Some("debug"));
        assert_eq!(parse_level("trace"), Some("debug"));
        assert_eq!(parse_level("hwmusic_core"), None);
        assert_eq!(parse_level(""), None);
    }

    #[test]
    fn maps_sidecar_stderr_lines_to_levels() {
        assert_eq!(stderr_line("[hwmusic-core][warn] 代理不通"), ("warn", "代理不通".to_string()));
        assert_eq!(stderr_line("[hwmusic-core][error] 未捕获异常：x"), ("error", "未捕获异常：x".to_string()));
        assert_eq!(stderr_line("[hwmusic-core][debug] 细节"), ("debug", "细节".to_string()));
        // 没有级别标记（老格式 / 多行异常的续行）按 info，正文一个字都不许丢
        assert_eq!(stderr_line("[hwmusic-core] 已就绪"), ("info", "已就绪".to_string()));
        assert_eq!(stderr_line("    at foo (a.mjs:2:3)"), ("info", "    at foo (a.mjs:2:3)".to_string()));
        // 认不出的标记不是级别：整段当成正文
        assert_eq!(stderr_line("[hwmusic-core][慢] 嗯"), ("info", "[慢] 嗯".to_string()));
    }

    #[test]
    fn redacts_bearer_tokens() {
        let redacted = redact("请求带 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig 之后继续");
        assert!(!redacted.contains("eyJhbGciOiJIUzI1NiJ9"), "Bearer 后面那串必须打码：{redacted}");
        assert!(redacted.contains("之后继续"), "只打码凭据，别把整行吞掉：{redacted}");
        assert!(redacted.contains(REDACTED));
    }

    #[test]
    fn redacts_secret_query_parameters() {
        for (raw, secret) in [
            ("GET https://x/y?token=abc123&page=2", "abc123"),
            ("https://x/y?access_token=zzz&x=1", "zzz"),
            ("https://x/y?refresh_token=rrr", "rrr"),
            ("https://x/y?code=qqq&state=1", "qqq"),
            ("https://x/y?sign=sss&t=1", "sss"),
            ("https://x/y?signature=ggg", "ggg"),
            ("https://x/y?ticket=ttt", "ttt"),
            ("https://x/y?sessionid=sid", "sid"),
            ("https://x/y?deviceData=dd", "dd"),
            ("https://x/y?AccessKeyId=kk&sig=1", "kk"),
            ("password=hunter2 已保存", "hunter2"),
        ] {
            let redacted = redact(raw);
            assert!(!redacted.contains(secret), "这个值必须打码：{raw} → {redacted}");
            assert!(redacted.contains(REDACTED), "打码要看得出来（不是把键删掉）：{redacted}");
        }
    }

    #[test]
    fn redacts_cookie_headers() {
        let redacted = redact("Cookie: sid=abc; uid=7");
        assert!(!redacted.contains("abc"), "Cookie 的值必须打码：{redacted}");
        let set_cookie = redact("Set-Cookie: SESSION=deadbeef; Path=/");
        assert!(!set_cookie.contains("deadbeef"), "Set-Cookie 同理：{set_cookie}");
    }

    #[test]
    fn redaction_leaves_ordinary_text_alone() {
        for raw in [
            "数据根：E:\\data（来源：HWMUSIC_DATA_DIR 覆盖）",
            "登录状态恢复：已登录（restored）",
            "频道 settings:get 处理失败：没有数据目录",
            "代理按环境变量设置生效：http://127.0.0.1:7890",
        ] {
            assert_eq!(redact(raw), raw, "正常文本不许被打码：{raw}");
        }
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = redact("?token=abc");
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn reads_the_last_lines_newest_last() {
        let dir = scratch("tail");
        let lines: Vec<String> = (1..=600).map(|index| format!("第 {index} 行")).collect();
        let path = write_lines(&dir, "a.log", &lines);

        let tail = read_tail(&path, 5).expect("读尾部");
        assert_eq!(tail, lines[595..].to_vec());
        assert_eq!(read_tail(&path, 5000).expect("超过总行数").len(), 600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_drops_the_half_line_it_started_on() {
        let dir = scratch("window");
        let lines: Vec<String> = (1..=40).map(|index| format!("line-{index:03}")).collect();
        let path = write_lines(&dir, "a.log", &lines);

        // 40 行 × 9 字节 = 360 字节；窗口 50 字节从中间切入，第一条必然是残行
        let window = read_window(&path, 50).expect("读窗口");
        assert!(window.len() > 1, "窗口里应当有若干完整行：{window:?}");
        for line in &window {
            assert!(
                lines.contains(line),
                "窗口里的每一行都必须是完整的日志行（不许把半个时间戳画到界面上）：{line}"
            );
        }
        assert_eq!(window.last().unwrap(), lines.last().unwrap(), "最后一行必须是最新的那行");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn newest_log_file_prefers_the_most_recently_written_one() {
        let dir = scratch("newest");
        write_lines(&dir, "华为音乐第三方客户端.log", &["[2026-10-25][01:00:00][t][INFO] old".to_string()]);
        let _ = fs::write(dir.join("notes.txt"), "不是日志");
        std::thread::sleep(Duration::from_millis(30));
        let fresh = write_lines(&dir, "另一个.log", &["[2026-10-26][01:00:00][t][INFO] new".to_string()]);

        assert_eq!(newest_log_file(&dir), Some(fresh), "按写入时间认最新，不按文件名");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_are_parsed_redacted_and_capped() {
        let dir = scratch("entries");
        let lines: Vec<String> = (0..8)
            .map(|index| {
                format!("[2026-10-26][05:00:0{index}][hwmusic_core][INFO] 第 {index} 条 token=secret{index}")
            })
            .collect();
        write_lines(&dir, "华为音乐第三方客户端.log", &lines);

        let entries = read_entries(&dir, 3).expect("读条目");
        assert_eq!(entries.len(), 3, "只要最后 3 条");
        assert_eq!(entries[2].message, "第 7 条 token=***", "返回前必须脱敏");
        assert!(entries.iter().all(|entry| !entry.message.contains("secret")), "任何一条都不许带凭据");
        assert_eq!(entries[2].source, "hwmusic_core");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_reads_as_empty_not_an_error() {
        let dir = scratch("missing").join("nope");
        assert_eq!(read_entries(&dir, 10).expect("没有日志目录不是错误"), Vec::new());
        assert_eq!(newest_log_file(&dir), None);
    }

    #[test]
    fn resolve_dir_follows_the_same_two_slots_as_the_plugin() {
        let fallback = PathBuf::from("C:\\Users\\x\\AppData\\Local\\app\\logs");
        assert_eq!(
            resolve_dir(Some("C:\\data"), Some(fallback.clone())),
            PathBuf::from("C:\\data").join(crate::LOG_DIR_NAME),
            "覆盖旋钮可用时与插件写同一个目录"
        );
        assert_eq!(resolve_dir(None, Some(fallback.clone())), fallback, "没设旋钮时跟插件默认落点");
        assert_eq!(resolve_dir(Some("relative"), Some(fallback.clone())), fallback, "相对路径不算覆盖");
        assert_eq!(resolve_dir(None, None), PathBuf::from(crate::LOG_DIR_NAME), "两级都取不到时不许 panic");
    }
}
