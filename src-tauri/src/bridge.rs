//! NDJSON 帧协议与 core（sidecar）调用内核。
//!
//! R3 范围：分帧状态机、请求/响应帧、sidecar → 宿主的效果分类、pending 表（调用在途登记与结清）。
//! 这里不碰 tauri，也不碰进程：进程与线程在 `sidecar.rs`，命令面与宿主路由在 `commands.rs`。

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 单个调用超时（秒）：Node 侧 `CALL_TIMEOUT_MS` 必须等于它 × 1000（一致性测试钉住）。
pub const CALL_TIMEOUT_SECS: u64 = 60;

/// 桥内部漏斗事件名（与 src/shared/channels.ts 的 CORE_EVENT 同值）。
pub const CORE_EVENT: &str = "core:event";

/// 广播频道白名单（src/shared/channels.ts 的 BROADCAST_CHANNELS 镜像，两侧由一致性测试钉住）。
///
/// 集合内容：`app:notice`（宿主级提示，控制器裁决的初始集合）+ `auth:status`（R7 增补：
/// 登录状态变化，渲染层门禁与 R8 主界面靠它决定"该显示哪一层"）+ `player:command`
/// （R9 增补的**预登记**：R11 托盘发出的播放控制意图）+ `lyrics:toggle` 与 `app:open-settings`
/// （R11 增补：托盘"桌面歌词"勾选与"设置…"两项要发给渲染层的意图）。增补时两侧一起改。
///
/// 数组里保持**字面量**：`test/channel-parity.test.mjs` 直接扫这一行的字符串集合，
/// 写成常量引用它会扫不到（`bridge_broadcast_channels_match_the_named_constants` 兜住这份重复）。
pub const APP_NOTICE: &str = "app:notice";
/// 登录状态广播频道（R7）：`{loggedIn: bool}`。
pub const AUTH_STATUS: &str = "auth:status";
/// 二维码登录状态广播频道（R16）：`{status, content?, expiresInMs?, message?, errorKind?}`。
///
/// 与 `auth:status` 分开：那一条说的是**会话**（登录了没有、忙不忙），这一条说的是
/// **一张二维码的生命周期**（pending/scanned/confirmed/expired/failed）。门禁要同时知道两件事。
pub const AUTH_QR: &str = "auth:qr";
/// 播放控制广播频道（R9 预登记，发送方是 R11 的托盘）：`{command: "play"|"pause"|...}`。
pub const PLAYER_COMMAND: &str = "player:command";
/// 桌面歌词开关广播频道（R11）：`{checked: bool}` —— **目标态**（点完这一下之后应当是什么）。
///
/// 为什么是目标态而不是"切换一下"：消费方（R12 的歌词窗）要按它决定开还是关，
/// 让消费方自己去猜"现在是开还是关"等于把状态分裂成两份。勾选态由托盘的 CheckMenuItem 镜像。
pub const LYRICS_TOGGLE: &str = "lyrics:toggle";
/// 打开设置页广播频道（R11）：`{view: "settings"}`（托盘菜单"设置…"）。
///
/// 托盘点不了渲染层的页面切换（视图状态在渲染层），所以发一条"去设置页"的意图，
/// 由渲染层自己走它既有的 `navigate`（不新增任何 IPC 通道）。
pub const APP_OPEN_SETTINGS: &str = "app:open-settings";
/// 歌词文档广播频道（R12）：`{lines, status}` —— 主窗转发给桌面歌词窗。
///
/// 歌词窗**没有业务频道权限**（`core_call` 只收主窗来源），所以它唯一的输入就是广播；
/// 少一条白名单的后果是桌面歌词永远空白，而日志里什么都看不出来。
pub const LYRICS_DOCUMENT: &str = "lyrics:document";
/// 歌词进度广播频道（R12）：`{timeMs, playing, seekGeneration}`（主窗 rAF 节流后推）。
pub const LYRICS_PROGRESS: &str = "lyrics:progress";
/// 歌词窗配置广播频道（R12）：`{config, visible}` —— 字号/颜色/模式/锁定/点透（会话内）。
pub const LYRICS_STATE: &str = "lyrics:state";
/// 主题变化广播频道（R25）：`{theme: "light"|"dark"|"system"}` —— **目标态**。
///
/// 发送方是 Rust 侧（`theme::set_theme`，由 `core_login_chrome` 的 `theme` 动作触发）：
/// 主题状态归 Rust 持有（`settings.json` 的 `theme` 键），改它的入口有三个
/// （gate 里的控件、浮动 `login-theme` 控件、将来的设置页），而它们活在三个不同的 webview 里
/// ——各存一份必然漂移。一条广播让主窗与两个浮动控件的 `<html>` 类一起变。
pub const THEME_CHANGED: &str = "theme:changed";
pub const BROADCAST_CHANNELS: &[&str] = &[
    "app:notice",
    "auth:status",
    "auth:qr",
    "player:command",
    "lyrics:toggle",
    "app:open-settings",
    "lyrics:document",
    "lyrics:progress",
    "lyrics:state",
    "theme:changed",
];

/// 已答复 id 的保留上限：应答一次性守卫必须有界（超出按插入顺序淘汰）。
pub const MAX_ANSWERED_IDS: usize = 4096;

/// 帧内错误：只带一段可读文本 + 可选类别，绝不回显凭据或整段 payload。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl CoreError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: Some(kind.to_string()),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Some(kind) => write!(formatter, "[{kind}] {}", self.message),
            None => write!(formatter, "{}", self.message),
        }
    }
}

impl std::error::Error for CoreError {}

/// 请求帧：`{id, channel, payload}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestFrame {
    pub id: String,
    pub channel: String,
    #[serde(default)]
    pub payload: Value,
}

impl RequestFrame {
    pub fn new(id: impl Into<String>, channel: impl Into<String>, payload: Value) -> Self {
        Self {
            id: id.into(),
            channel: channel.into(),
            payload,
        }
    }

    pub fn to_line(&self) -> Result<String, CoreError> {
        serde_json::to_string(self)
            .map_err(|source| CoreError::new("internal", format!("请求帧无法编码：{source}")))
    }
}

/// 响应帧：`{id, ok, data}` 或 `{id, ok, error}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreError>,
}

impl ResponseFrame {
    pub fn ok(id: &str, data: Option<Value>) -> Self {
        Self {
            id: id.to_string(),
            ok: true,
            data,
            error: None,
        }
    }

    pub fn err(id: &str, error: CoreError) -> Self {
        Self {
            id: id.to_string(),
            ok: false,
            data: None,
            error: Some(error),
        }
    }

    pub fn to_line(&self) -> Result<String, CoreError> {
        serde_json::to_string(self)
            .map_err(|source| CoreError::new("internal", format!("响应帧无法编码：{source}")))
    }

    pub fn into_result(self) -> Result<Value, CoreError> {
        if self.ok {
            Ok(self.data.unwrap_or(Value::Null))
        } else {
            Err(self
                .error
                .unwrap_or_else(|| CoreError::new("internal", "对端返回了错误但没有 message")))
        }
    }
}

/// sidecar stdout 上的一行在 Rust 侧被归结为这四种效果。
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// 广播：转成漏斗事件 `core:event` 发给渲染层（不答复）
    Emit { channel: String, payload: Value },
    /// 宿主要求：答复走响应帧；已有人负责答复时不得再写第二次
    HostRequest {
        id: String,
        channel: String,
        payload: Value,
    },
    /// 进程退出：结清 pending、关写入端，此后调用立刻失败而不是再等超时
    CoreGone { code: Option<i32> },
    /// 只进日志（协议异常、提示文本）
    Notice(String),
}

/// 频道准入策略。参数化是为了让单测能构造自己的白名单，而不必改全局常量。
#[derive(Debug, Clone, Copy)]
pub struct FramePolicy {
    pub host_channels: &'static [&'static str],
    pub broadcast_channels: &'static [&'static str],
}

impl FramePolicy {
    pub fn new(
        host_channels: &'static [&'static str],
        broadcast_channels: &'static [&'static str],
    ) -> Self {
        Self {
            host_channels,
            broadcast_channels,
        }
    }
}

impl Default for FramePolicy {
    fn default() -> Self {
        Self::new(
            crate::commands::HOST_REQUEST_CHANNELS,
            BROADCAST_CHANNELS,
        )
    }
}

/// 一行帧的解析结论。
#[derive(Debug, Clone, PartialEq)]
pub enum LineOutcome {
    /// 对端响应：当场结清 pending，不进效果队列
    Response(ResponseFrame),
    /// 需要副作用（可能在主线程之外落地）
    Effect(Effect),
    /// 白名单外的请求频道：有 id 就回结构化错误，没有 id 只能记日志
    Reject { id: Option<String>, error: CoreError },
}

/// 一行 → 结论。纯函数：不写 stdout、不碰进程、不碰 app。
pub fn classify_line(line: &str, policy: &FramePolicy) -> LineOutcome {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(source) => {
            return LineOutcome::Effect(Effect::Notice(format!(
                "sidecar 输出了非 JSON 帧：{source}"
            )))
        }
    };

    let Some(object) = value.as_object() else {
        return LineOutcome::Effect(Effect::Notice("sidecar 帧不是 JSON 对象".to_string()));
    };

    // 有 ok 字段 = 响应帧；其余当请求帧
    if object.contains_key("ok") {
        return match serde_json::from_value::<ResponseFrame>(value) {
            Ok(frame) => LineOutcome::Response(frame),
            Err(source) => LineOutcome::Effect(Effect::Notice(format!(
                "sidecar 响应帧不合法：{source}"
            ))),
        };
    }

    let Some(channel) = object.get("channel").and_then(Value::as_str) else {
        return LineOutcome::Effect(Effect::Notice("sidecar 帧缺少 channel".to_string()));
    };
    let id = object.get("id").and_then(Value::as_str);
    let payload = object.get("payload").cloned().unwrap_or(Value::Null);

    if policy.host_channels.contains(&channel) {
        return match id {
            Some(id) => LineOutcome::Effect(Effect::HostRequest {
                id: id.to_string(),
                channel: channel.to_string(),
                payload,
            }),
            None => LineOutcome::Effect(Effect::Notice(format!(
                "宿主要求 {channel} 缺少 id，无法答复"
            ))),
        };
    }

    if policy.broadcast_channels.contains(&channel) {
        return LineOutcome::Effect(Effect::Emit {
            channel: channel.to_string(),
            payload,
        });
    }

    LineOutcome::Reject {
        id: id.map(str::to_string),
        error: CoreError::new("unknown_channel", format!("频道 {channel} 不在桥的白名单内")),
    }
}

/// 分帧状态机：帧必须能跨 `read()` 分片存活。
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: String,
}

impl FrameDecoder {
    /// 吃进一片数据，吐出其中已经完整的行（吞掉 `\r` 与空行）。
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline).collect();
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(trimmed.to_string());
            }
        }
        lines
    }

    /// EOF：交出半帧残余（非空即截断）。重复调用不重复报告。
    pub fn end(&mut self) -> Option<String> {
        let rest = self.buffer.trim().to_string();
        self.buffer.clear();
        (!rest.is_empty()).then_some(rest)
    }

    /// 当前残余（半帧）——测试与排障用。
    #[cfg(test)]
    pub fn remainder(&self) -> &str {
        &self.buffer
    }
}

/// 帧摘要的字节上限：残余帧/非法行进日志时最多留这么多字节（与 `src/host/bridge.mjs` 的
/// `FRAME_EXCERPT_BYTES` 同一口径，两侧都改才不会一边漏）。
pub const FRAME_EXCERPT_BYTES: usize = 64;

/// 帧摘要：日志里**只给前 [`FRAME_EXCERPT_BYTES`] 字节 + 总字节数**。
///
/// 为什么不是"原样带上那段残余"：截断帧是唯一会把**未解析的字节**交出来的地方，而它可能正是
/// 一帧带着凭据的 JSON（负载里躺着一个密码字段的那种安全存储请求）。
/// 日志会落盘、会被贴进 issue，所以按裁决取 64 字节上限：够认出"是哪个频道、坏在哪一段"，
/// 第 64 字节之后的凭据进不了日志。按 UTF-8 字符边界切，不产生半个汉字。
pub fn frame_excerpt(text: &str) -> String {
    let total = text.len();
    if total <= FRAME_EXCERPT_BYTES {
        return format!("{text}（共 {total} 字节）");
    }
    let mut end = FRAME_EXCERPT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断，共 {total} 字节）", &text[..end])
}

#[derive(Debug, Default)]
struct PendingInner {
    entries: HashMap<String, Sender<Result<Value, CoreError>>>,
    closed: Option<CoreError>,
}

/// pending 表：请求 id → 结清通道。
#[derive(Debug, Default)]
pub struct PendingTable {
    inner: Mutex<PendingInner>,
}

impl PendingTable {
    /// 登记一次在途调用；同一 id 二次登记或表已关闭都返回错误。
    pub fn register(&self, id: &str) -> Result<Receiver<Result<Value, CoreError>>, CoreError> {
        let mut inner = lock(&self.inner);
        if let Some(error) = &inner.closed {
            return Err(error.clone());
        }
        if inner.entries.contains_key(id) {
            return Err(CoreError::new("internal", format!("请求 id 冲突：{id}")));
        }
        let (sender, receiver) = channel();
        inner.entries.insert(id.to_string(), sender);
        Ok(receiver)
    }

    /// 结清一次调用。未知 id（二次回调、超时后迟到）返回 false，绝不覆盖已有值。
    pub fn settle(&self, id: &str, result: Result<Value, CoreError>) -> bool {
        let removed = lock(&self.inner).entries.remove(id);
        match removed {
            Some(sender) => {
                // 接收端可能已因超时离开：这不影响"该 id 已被结清"的事实
                let _ = sender.send(result);
                true
            }
            None => false,
        }
    }

    /// 撤掉登记但不结清（超时路径：接收端自己要走了）。
    pub fn forget(&self, id: &str) -> bool {
        lock(&self.inner).entries.remove(id).is_some()
    }

    /// 结清全部在途调用（收尸路径）。
    pub fn fail_all(&self, error: &CoreError) -> usize {
        let drained: Vec<Sender<Result<Value, CoreError>>> = {
            let mut inner = lock(&self.inner);
            inner.entries.drain().map(|(_, sender)| sender).collect()
        };
        let count = drained.len();
        for sender in drained {
            let _ = sender.send(Err(error.clone()));
        }
        count
    }

    pub fn close(&self, error: CoreError) {
        lock(&self.inner).closed = Some(error);
    }

    pub fn len(&self) -> usize {
        lock(&self.inner).entries.len()
    }
}

/// 应答一次性守卫：有界集合（插入顺序淘汰）。
#[derive(Debug, Default)]
struct AnsweredIds {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl AnsweredIds {
    fn insert(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > MAX_ANSWERED_IDS {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
        true
    }
}

/// 桥的内核：pending 表、写入端、请求 id、收尸标志。帧泵线程、效果线程与命令线程共享它。
pub struct CoreShared {
    pending: PendingTable,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    answered: Mutex<AnsweredIds>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl CoreShared {
    pub fn new(writer: Box<dyn Write + Send>) -> Arc<Self> {
        Arc::new(Self {
            pending: PendingTable::default(),
            writer: Mutex::new(Some(writer)),
            answered: Mutex::new(AnsweredIds::default()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        })
    }

    pub fn request_id(&self) -> String {
        format!("r{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    /// 写一行帧：自带结尾换行（NDJSON 的一帧 = 一行，缺了换行对端永远等不到完整帧）。
    pub fn write_line(&self, line: &str) -> Result<(), CoreError> {
        let mut guard = lock(&self.writer);
        let Some(writer) = guard.as_mut() else {
            return Err(CoreError::new("core_gone", "core 写入端已关闭"));
        };
        match writer
            .write_all(line.trim_end().as_bytes())
            .and_then(|()| writer.write_all(b"\n"))
            .and_then(|()| writer.flush())
        {
            Ok(()) => Ok(()),
            Err(source) => {
                let error = CoreError::new("core_gone", format!("写入 core 失败：{source}"));
                drop(guard);
                self.core_gone(error.clone());
                Err(error)
            }
        }
    }

    /// 发起一次调用：登记 pending → 写请求帧 → 等响应（超时/收尸都有确定结论）。
    pub fn call(
        &self,
        channel: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, CoreError> {
        if self.is_closed() {
            return Err(CoreError::new("core_gone", "core 进程已退出，调用未发送"));
        }

        let id = self.request_id();
        let receiver = self.pending.register(&id)?;
        let frame = RequestFrame::new(id.clone(), channel, payload);
        if let Err(error) = frame.to_line().and_then(|line| self.write_line(&line)) {
            self.pending.forget(&id);
            return Err(error);
        }

        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.pending.forget(&id);
                Err(CoreError::new(
                    "timeout",
                    format!("调用 {channel} 超时（{} 秒）", timeout.as_secs()),
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.pending.forget(&id);
                Err(CoreError::new("core_gone", "core 进程已退出"))
            }
        }
    }

    /// 响应帧 → 结清对应调用。false = 无人认领（二次回调或超时后迟到）。
    pub fn settle_response(&self, frame: ResponseFrame) -> bool {
        let id = frame.id.clone();
        self.pending.settle(&id, frame.into_result())
    }

    /// 给某个请求 id 写响应帧。同一 id 只允许写一次（Deferred 语义的守卫）。
    pub fn respond(&self, id: &str, result: Result<Value, CoreError>) -> bool {
        if id.is_empty() || !lock(&self.answered).insert(id) {
            return false;
        }
        let frame = match result {
            Ok(data) => ResponseFrame::ok(id, Some(data)),
            Err(error) => ResponseFrame::err(id, error),
        };
        match frame.to_line() {
            Ok(line) => self.write_line(&line).is_ok(),
            Err(_) => false,
        }
    }

    /// 收尸：结清在途调用、关写入端、之后调用立刻失败。
    pub fn core_gone(&self, error: CoreError) -> usize {
        let settled = self.pending.fail_all(&error);
        self.pending.close(error);
        self.closed.store(true, Ordering::SeqCst);
        self.close_write_end();
        settled
    }

    /// 关写入端（幂等）：sidecar 收到 stdin EOF 会自己 exit(0)。
    pub fn close_write_end(&self) {
        let mut guard = lock(&self.writer);
        if let Some(mut writer) = guard.take() {
            let _ = writer.flush();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

impl std::fmt::Debug for CoreShared {
    /// 手动实现：写入端是 `dyn Write`，但日志里真正有用的是"还有几个在途、是否已收尸"。
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CoreShared")
            .field("pending", &self.pending_len())
            .field("closed", &self.is_closed())
            .finish()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::json;

    /// 广播频道白名单与它的具名常量是**同一份事实**（数组里必须是字面量，parity 测试才扫得到）。
    #[test]
    fn bridge_broadcast_channels_match_the_named_constants() {
        assert_eq!(
            BROADCAST_CHANNELS,
            [
                APP_NOTICE,
                AUTH_STATUS,
                AUTH_QR,
                PLAYER_COMMAND,
                LYRICS_TOGGLE,
                APP_OPEN_SETTINGS,
                LYRICS_DOCUMENT,
                LYRICS_PROGRESS,
                LYRICS_STATE,
                THEME_CHANGED
            ]
        );
        assert_eq!(APP_NOTICE, "app:notice");
        assert_eq!(AUTH_STATUS, "auth:status");
        assert_eq!(AUTH_QR, "auth:qr");
        assert_eq!(PLAYER_COMMAND, "player:command");
        assert_eq!(LYRICS_TOGGLE, "lyrics:toggle");
        assert_eq!(APP_OPEN_SETTINGS, "app:open-settings");
        assert_eq!(LYRICS_DOCUMENT, "lyrics:document");
        assert_eq!(LYRICS_PROGRESS, "lyrics:progress");
        assert_eq!(LYRICS_STATE, "lyrics:state");
        assert_eq!(THEME_CHANGED, "theme:changed");
    }

    /// 可读回的假写入端：断言"到底写出了什么帧"。
    #[derive(Clone, Default)]
    struct SharedWriter {
        chunks: Arc<Mutex<Vec<String>>>,
    }

    impl Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.chunks
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl SharedWriter {
        fn lines(&self) -> Vec<String> {
            let joined: String = self.chunks.lock().unwrap().concat();
            joined
                .split('\n')
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect()
        }

        fn take_first_line(&self) -> Option<String> {
            self.lines().into_iter().next()
        }
    }

    fn wait_until(deadline: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let started = Instant::now();
        while started.elapsed() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(2));
        }
        condition()
    }

    fn policy() -> FramePolicy {
        FramePolicy::new(&["host:notify", "host:open-login"], &["auth:state"])
    }

    #[test]
    fn request_frame_round_trip_through_decoder_and_classifier() {
        let original = RequestFrame::new("7", "host:notify", json!({"text": "已复制"}));
        let line = original.to_line().expect("请求帧必须能编码");

        let mut decoder = FrameDecoder::default();
        let lines = decoder.push(&format!("{line}\n"));
        assert_eq!(lines.len(), 1);

        match classify_line(&lines[0], &policy()) {
            LineOutcome::Effect(Effect::HostRequest { id, channel, payload }) => {
                assert_eq!(id, "7");
                assert_eq!(channel, "host:notify");
                assert_eq!(payload, json!({"text": "已复制"}));
            }
            other => panic!("宿主要求应还原成 HostRequest，实际 {other:?}"),
        }
    }

    #[test]
    fn response_frame_round_trip() {
        let response = ResponseFrame::ok("11", Some(json!({"schemaVersion": 1})));
        let line = response.to_line().expect("响应帧必须能编码");

        match classify_line(&line, &policy()) {
            LineOutcome::Response(frame) => {
                assert_eq!(frame.id, "11");
                assert!(frame.ok);
                assert_eq!(frame.data, Some(json!({"schemaVersion": 1})));
                assert_eq!(frame.into_result(), Ok(json!({"schemaVersion": 1})));
            }
            other => panic!("响应帧应分类为 Response，实际 {other:?}"),
        }

        let failure = ResponseFrame::err("12", CoreError::new("unimplemented", "登录由 R7 实现"));
        match classify_line(&failure.to_line().unwrap(), &policy()) {
            LineOutcome::Response(frame) => {
                let error = frame.into_result().expect_err("ok=false 必须变成错误");
                assert_eq!(error.kind.as_deref(), Some("unimplemented"));
                assert_eq!(error.message, "登录由 R7 实现");
            }
            other => panic!("错误响应应分类为 Response，实际 {other:?}"),
        }
    }

    #[test]
    fn decoder_survives_half_frame_spanning_chunks() {
        let mut decoder = FrameDecoder::default();
        assert!(decoder.push("{\"id\":\"1\",\"ok\":true,\"da").is_empty());
        assert_eq!(decoder.remainder(), "{\"id\":\"1\",\"ok\":true,\"da");
        assert!(decoder.push("ta\":1}").is_empty(), "缺换行就不算完整帧");

        let lines = decoder.push("\n{\"id\":\"2\",\"ok\":true}\r\n");
        assert_eq!(lines.len(), 2, "补齐换行后一次吐出两帧（含 CRLF）");
        assert_eq!(decoder.remainder(), "");
        assert!(decoder.end().is_none(), "没有残余就不该报截断");
    }

    #[test]
    fn decoder_reports_truncated_frame_at_eof() {
        let mut decoder = FrameDecoder::default();
        decoder.push("{\"id\":\"half\"}");
        assert_eq!(decoder.end().as_deref(), Some("{\"id\":\"half\"}"), "EOF 时必须交出半帧残余");
        assert_eq!(decoder.remainder(), "", "残余已消费，EOF 有确定结论");
        assert!(decoder.end().is_none(), "重复 end() 不重复报截断");
    }

    #[test]
    fn classifier_maps_host_channels_to_host_request() {
        match classify_line(r#"{"id":"3","channel":"host:open-login","payload":{"a":1}}"#, &policy()) {
            LineOutcome::Effect(Effect::HostRequest { channel, .. }) => assert_eq!(channel, "host:open-login"),
            other => panic!("应分类为 HostRequest，实际 {other:?}"),
        }
    }

    #[test]
    fn classifier_host_request_without_id_is_notice() {
        match classify_line(r#"{"channel":"host:notify","payload":{}}"#, &policy()) {
            LineOutcome::Effect(Effect::Notice(text)) => {
                assert!(text.contains("id"), "缺 id 的宿主要求必须明确报出来：{text}");
            }
            other => panic!("缺 id 的宿主要求应报 Notice，实际 {other:?}"),
        }
    }

    #[test]
    fn classifier_maps_broadcast_channel_to_emit() {
        match classify_line(r#"{"channel":"auth:state","payload":{"loggedIn":true}}"#, &policy()) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "auth:state");
                assert_eq!(payload, json!({"loggedIn": true}));
            }
            other => panic!("广播频道应分类为 Emit，实际 {other:?}"),
        }
    }

    #[test]
    fn default_policy_admits_first_broadcast_channel_as_emit() {
        // 生产路径用的是 FramePolicy::default()；集合为空时这里会退化成 Reject，
        // 无 id 的广播帧只能进日志——等于 sidecar 发出去的广播被静默丢弃。
        let default_policy = FramePolicy::default();
        // R7 增补了 auth:status、R9 预登记了 player:command、R11 增补了托盘那两条、
        // R12 增补了歌词窗那三条（文档/进度/配置）、R25 增补了主题那一条：每加一个都在这里同步。
        let expected: &[&str] = &[
            "app:notice",
            "auth:status",
            "auth:qr",
            "player:command",
            "lyrics:toggle",
            "app:open-settings",
            "lyrics:document",
            "lyrics:progress",
            "lyrics:state",
            "theme:changed",
        ];
        assert_eq!(BROADCAST_CHANNELS, expected, "控制器裁决的广播集合（R16 起加上二维码那条）");

        let frame = r#"{"channel":"app:notice","payload":{"text":"已复制"}}"#;
        match classify_line(frame, &default_policy) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "app:notice");
                assert_eq!(payload, json!({"text": "已复制"}));
            }
            other => panic!("默认策略下 app:notice 必须分类为 Emit，实际 {other:?}"),
        }

        // R7 的登录状态广播同样必须被默认策略放行（否则渲染层永远等不到"已登录"）
        let auth_frame = r#"{"channel":"auth:status","payload":{"loggedIn":true}}"#;
        match classify_line(auth_frame, &default_policy) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "auth:status");
                assert_eq!(payload, json!({"loggedIn": true}));
            }
            other => panic!("默认策略下 auth:status 必须分类为 Emit，实际 {other:?}"),
        }

        // R9 预登记的托盘播放控制：预登记的意义就在这条用例里——不预先放进白名单，
        // R11 的托盘广播会被静默丢弃（用户点了没反应，日志里只有一条 Reject）。
        let player_frame = r#"{"channel":"player:command","payload":{"command":"toggle"}}"#;
        match classify_line(player_frame, &default_policy) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "player:command");
                assert_eq!(payload, json!({"command": "toggle"}));
            }
            other => panic!("默认策略下 player:command 必须分类为 Emit，实际 {other:?}"),
        }

        // R11 增补的两条：托盘的"桌面歌词"勾选与"设置…"。白名单缺一条的后果与 player:command
        // 完全一样——广播被静默丢掉，用户只看到"点了没反应"。
        let lyrics_frame = r#"{"channel":"lyrics:toggle","payload":{"checked":true}}"#;
        match classify_line(lyrics_frame, &default_policy) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "lyrics:toggle");
                assert_eq!(payload, json!({"checked": true}));
            }
            other => panic!("默认策略下 lyrics:toggle 必须分类为 Emit，实际 {other:?}"),
        }

        let settings_frame = r#"{"channel":"app:open-settings","payload":{"view":"settings"}}"#;
        match classify_line(settings_frame, &default_policy) {
            LineOutcome::Effect(Effect::Emit { channel, payload }) => {
                assert_eq!(channel, "app:open-settings");
                assert_eq!(payload, json!({"view": "settings"}));
            }
            other => panic!("默认策略下 app:open-settings 必须分类为 Emit，实际 {other:?}"),
        }
    }

    #[test]
    fn classifier_rejects_unknown_channel_with_structured_error() {
        match classify_line(r#"{"id":"9","channel":"nope:whatever","payload":null}"#, &policy()) {
            LineOutcome::Reject { id, error } => {
                assert_eq!(id.as_deref(), Some("9"));
                assert_eq!(error.kind.as_deref(), Some("unknown_channel"));
                assert!(error.message.contains("nope:whatever"));
            }
            other => panic!("白名单外应 Reject，实际 {other:?}"),
        }

        match classify_line(r#"{"channel":"nope:whatever"}"#, &policy()) {
            LineOutcome::Reject { id, .. } => assert_eq!(id, None, "没有 id 只能记日志，不能臆造答复对象"),
            other => panic!("白名单外应 Reject，实际 {other:?}"),
        }
    }

    #[test]
    fn classifier_reports_invalid_json_as_notice() {
        match classify_line("not json", &policy()) {
            LineOutcome::Effect(Effect::Notice(text)) => assert!(text.contains("JSON"), "{text}"),
            other => panic!("非法行应报 Notice，实际 {other:?}"),
        }
        match classify_line("[1,2,3]", &policy()) {
            LineOutcome::Effect(Effect::Notice(text)) => assert!(text.contains("对象"), "{text}"),
            other => panic!("非对象帧应报 Notice，实际 {other:?}"),
        }
    }

    #[test]
    fn pending_table_rejects_duplicate_id_and_second_settle() {
        let table = PendingTable::default();

        let receiver = table.register("r1").expect("首次登记应成功");
        assert!(table.register("r1").is_err(), "同一 id 不能登记两次");
        assert_eq!(table.len(), 1);

        assert!(table.settle("r1", Ok(json!("first"))));
        assert_eq!(receiver.recv().unwrap(), Ok(json!("first")));
        assert!(!table.settle("r1", Ok(json!("second"))), "二次回调必须被拒绝");
        assert!(!table.settle("missing", Ok(json!(null))));
        assert_eq!(table.len(), 0);

        // 结清后同一个 id 可以再次使用（id 是发起方生成的字符串）
        assert!(table.register("r1").is_ok());
    }

    #[test]
    fn pending_table_fail_all_settles_everything_and_closes() {
        let table = PendingTable::default();
        let first = table.register("a").unwrap();
        let second = table.register("b").unwrap();

        let error = CoreError::new("core_gone", "sidecar 进程已退出");
        assert_eq!(table.fail_all(&error), 2);
        assert_eq!(first.recv().unwrap().expect_err("必须结清为错误").kind.as_deref(), Some("core_gone"));
        assert_eq!(second.recv().unwrap().expect_err("必须结清为错误").message, "sidecar 进程已退出");
        assert_eq!(table.len(), 0);

        table.close(CoreError::new("core_gone", "已关闭"));
        assert!(table.register("c").is_err(), "关闭后不再接受登记");
    }

    #[test]
    fn shared_call_settles_on_matching_response() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer.clone()));

        let responder = Arc::clone(&shared);
        let reader = writer.clone();
        let peer = thread::spawn(move || {
            let line = wait_for_line(&reader).expect("必须写出请求帧");
            let frame: serde_json::Value = serde_json::from_str(&line).expect("请求帧必须是合法 JSON");
            let id = frame["id"].as_str().expect("请求帧必须带 id").to_string();
            assert_eq!(frame["channel"], "host:notify");
            responder.settle_response(ResponseFrame::ok(&id, Some(json!({"shown": true}))));
        });

        let value = shared
            .call("host:notify", json!({"text": "x"}), Duration::from_secs(5))
            .expect("对端答复后应拿到数据");
        assert_eq!(value, json!({"shown": true}));
        peer.join().unwrap();
        assert_eq!(shared.pending_len(), 0);
    }

    fn wait_for_line(writer: &SharedWriter) -> Option<String> {
        let mut found = None;
        wait_until(Duration::from_secs(5), || {
            found = writer.take_first_line();
            found.is_some()
        });
        found
    }

    #[test]
    fn shared_call_times_out_without_waiting_forever() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer.clone()));

        let started = Instant::now();
        let error = shared
            .call("host:notify", json!({}), Duration::from_millis(30))
            .expect_err("无人答复必须超时");
        assert_eq!(error.kind.as_deref(), Some("timeout"));
        assert!(started.elapsed() < Duration::from_secs(5), "超时不该拖成 60 秒");
        assert_eq!(shared.pending_len(), 0, "超时必须把登记撤掉");
        assert_eq!(writer.lines().len(), 1, "超时前请求确实写出去了");
    }

    #[test]
    fn core_gone_settles_pending_and_fails_fast_without_writing() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer.clone()));

        let waiting = Arc::clone(&shared);
        let inflight = thread::spawn(move || {
            waiting.call("host:notify", json!({}), Duration::from_secs(30))
        });
        assert!(
            wait_until(Duration::from_secs(5), || shared.pending_len() == 1),
            "在途调用必须先登记"
        );

        let settled = shared.core_gone(CoreError::new("core_gone", "sidecar 进程已退出"));
        assert_eq!(settled, 1, "收尸必须结清在途调用");
        let error = inflight.join().unwrap().expect_err("收尸后调用必须失败");
        assert_eq!(error.kind.as_deref(), Some("core_gone"));
        assert!(shared.is_closed());

        let started = Instant::now();
        let after = shared
            .call("host:notify", json!({}), Duration::from_secs(30))
            .expect_err("收尸后调用必须立刻失败");
        assert_eq!(after.kind.as_deref(), Some("core_gone"));
        assert!(started.elapsed() < Duration::from_secs(5), "不该再等 60 秒");
        assert_eq!(writer.lines().len(), 1, "收尸后不再写帧");
    }

    #[test]
    fn respond_writes_at_most_once_per_request_id() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer.clone()));

        assert!(shared.respond("r1", Ok(json!(null))));
        assert!(!shared.respond("r1", Ok(json!("second"))), "同一 id 第二次答复必须被拒绝");
        assert!(shared.respond("r2", Err(CoreError::new("unimplemented", "未实现"))));

        let lines = writer.lines();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], r#"{"id":"r1","ok":true,"data":null}"#.to_string());
        let second: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(second["id"], "r2");
        assert_eq!(second["ok"], false);
        assert_eq!(second["error"]["kind"], "unimplemented");
    }

    #[test]
    fn write_after_close_is_structured_error() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer.clone()));
        shared.close_write_end();

        let error = shared
            .call("host:notify", json!({}), Duration::from_millis(50))
            .expect_err("写入端已关必须立刻失败");
        assert_eq!(error.kind.as_deref(), Some("core_gone"));
        assert_eq!(shared.pending_len(), 0);
        assert_eq!(writer.lines().len(), 0);
    }

    #[test]
    fn request_ids_are_unique() {
        let writer = SharedWriter::default();
        let shared = CoreShared::new(Box::new(writer));

        let first = shared.request_id();
        let second = shared.request_id();
        assert!(!first.is_empty());
        assert_ne!(first, second, "请求 id 必须互不相同，否则 pending 表会互相顶掉");
    }
}
