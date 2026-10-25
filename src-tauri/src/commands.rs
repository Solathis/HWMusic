//! tauri 命令面：`core_call`（唯一业务通道 + 主窗来源守卫 + 请求频道准入）、`core_renderer_ready`
//! （渲染层就绪钩子），以及宿主要求路由（`host:notify` 走系统通知；`host:secure-encrypt` /
//! `host:secure-decrypt` 走 DPAPI 安全存储；R7 的频道如实回未实现）。
//!
//! 判定逻辑刻意抽成纯函数（`require_main_webview` / `require_request_channel` / `plan_host_request`），
//! 这样不依赖 `tauri::test` mock runtime 就能钉住来源守卫与路由表。

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

use crate::bridge::{CoreError, CoreShared, Effect, ResponseFrame, CALL_TIMEOUT_SECS, CORE_EVENT};
use crate::sidecar::SidecarProcess;
use crate::MAIN_WINDOW_LABEL;

/// 渲染层 → core 的请求频道白名单。
///
/// 这是刻意与 src/shared/request-channels.ts 同源的镜像副本（Rust 无法 import TS）：
/// test/channel-parity.test.mjs 扫描两侧源码，集合必须相等——改这里就必须同步改那里。
///
/// R8 增补 `library:*` 七条：主界面六个库页面的唯一数据通道。少一条的后果是那个页面
/// 的请求在**这里**就被拒（`unknown_channel`）——渲染层只会显示"加载失败"，很难看出是准入问题。
///
/// R9 增补 `playback:resolve-url`：拿**当次**播放地址（地址只作当次播放结果交给渲染层，
/// 不写日志、不持久化）。少了它，播放器点播放只会拿到 `unknown_channel`。
///
/// R10 增补 `settings:test-proxy`：设置页的"测试连接"（core 侧用独立的 ProxyAgent 发一次请求）。
/// 少了它，那个按钮只会拿到 `unknown_channel`——而它看起来像"代理不通"。
///
/// R12 增补 `playback:lyrics`：歌词**文本**来源（`{trackId}` → 原始 LRC 文本；解析在渲染层，
/// 由官方 `parseLrc` 负责）。少了它，桌面歌词窗与主窗歌词面板都只会空白，而设置页显示
/// "歌词来源尚未配置"——那句话本身没错，但原因是频道压根没接（两个原因长得一模一样）。
///
/// R16 增补 `auth:qr-start`：引导页**自动**发起二维码会话（R7 的 `auth:login` 是"开官方登录窗"
/// 那条路）。少了它，引导页只会拿到 `unknown_channel`，用户看到的是一张显示不出来的二维码。
///
/// R19 增补 `auth:get-status`：渲染层主动查一次当前登录状态。`auth:status` 只在 sidecar 启动时
/// 广播一次（`NoticeQueue` 冲刷**只发生一次**），渲染层 reload/崩溃重启之后那一条已经错过了 ——
/// 门禁会永远停在 `checking`（"正在检查登录状态…"）。少了这条频道，`core_call` 会在**这里**
/// 就被拒（`unknown_channel`），而渲染层看到的仍然只是"一直在检查"。
///
/// R41 增补 `lyrics:*` 三条：**歌词体系**的三件事（本地导入 / 缓存占用 / 清缓存）。
/// 少了它们的后果各不相同，但都表现为"按钮点了没反应或界面说错话"：
/// - `lyrics:import` 缺失 → 用户导入 `.lrc` 之后那首歌仍然放的是在线歌词（导入悄悄失败）；
/// - `lyrics:cache-info` 缺失 → 设置页那张卡永远显示"读不到占用"；
/// - `lyrics:cache-clear` 缺失 → "清除缓存"按下去什么都没发生，而用户以为清了。
/// 三条都在**这里**被准入，与 `library:*` / `playback:*` 同一条规矩（唯一真源在
/// `src/shared/request-channels.ts`，本数组是它的镜像副本，由 channel-parity 测试钉住）。
///
/// R53 增补 `auth:cancel-qr`：渲染层门禁收场时停掉二维码轮询（切主界面 / 卸载）。
/// 与 `auth:cancel-login`（关宿主登录窗）是两件事；镜像副本由 channel-parity 测试钉住。
pub const REQUEST_CHANNELS: &[&str] = &[
    "auth:login",
    "auth:logout",
    "auth:cancel-login",
    "auth:qr-start",
    "auth:cancel-qr",
    "auth:get-status",
    "settings:get",
    "settings:set",
    "settings:test-proxy",
    "library:favorites",
    "library:playlists",
    "library:playlist-detail",
    "library:search",
    "library:album",
    "library:artist",
    "library:history",
    "playback:resolve-url",
    "playback:lyrics",
    "lyrics:import",
    "lyrics:cache-info",
    "lyrics:cache-clear",
];

/// core → 宿主 的宿主要求频道（与 src/shared/request-channels.ts 的 HOST_REQUEST_CHANNELS 同源）。
///
/// R7 增补 `host:cancel-login`：渲染层的"取消登录"走 `core_call(auth:cancel-login)` → sidecar →
/// 这条宿主要求，最终由 `login.rs` 把结论槽结算成 Cancelled。
pub const HOST_REQUEST_CHANNELS: &[&str] = &[
    "host:open-login",
    "host:cancel-login",
    "host:secure-encrypt",
    "host:secure-decrypt",
    "host:notify",
];

/// 主窗来源守卫：只有主窗那个 **webview** 能调 `core_call`（登录页、歌词窗、托盘一律拒绝）。
///
/// **为什么判的是 webview label 而不是窗口 label**（R23 的安全性前提）：R23 把官方登录页从"独立子窗"
/// 改成**主窗里的第二个 webview**（用户指令：在程序内跳转）。同窗之后
/// `Webview::window_ref().label()` 对这个登录页**恒为 `main`**（tauri 2.12.4 `src/webview/mod.rs:1793`
/// `window_label()` 返回宿主窗的 label），于是任何"按窗口 label 判来源"的守卫都会被登录页绕过。
/// 能区分两者的只有 **webview label**：主窗 `main`（`WebviewWindowBuilder::new` 把 webview 的 label
/// 取成同一个值，`src/webview/webview_window.rs:101-107`），登录页 `login`（[`crate::login`]）。
///
/// 命令侧怎么拿到它：命令参数声明成 `tauri::Webview` 而不是 `tauri::Window`
/// （`CommandArg for Webview` 直接把发起这一帧的 webview 交出来，`src/webview/mod.rs:2604-2609`；
/// 而 `CommandArg for Window` 给的是 `webview().window()`，`src/window/mod.rs:1099-1104`）。
/// 这条"必须按 webview label 判"由 `every_guarded_command_judges_by_webview_label_not_window_label` 扫描钉住。
pub fn require_main_webview(label: &str) -> Result<(), CoreError> {
    if label == MAIN_WINDOW_LABEL {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        format!("core_call 只接受主窗调用（来源 webview：{label}）"),
    ))
}

/// `core_login_chrome` 的来源守卫（R25）：**只有**主窗与两个浮动控件能调这条命令。
///
/// 为什么另开一份而不是放宽 [`require_main_webview`]：那条守卫管的是 `core_call`（**全部业务频道**），
/// 放宽它等于把库/播放/设置的请求面交给登录体验的浮动控件。这里收的是一条**只有两个动作**
///（取消登录 / 改主题）的专用命令，允许集合就那三个 label：
///
/// - `main`：gate 视图右上角那个主题控件就在主窗里（与浮动那份是同一个 React 组件）；
/// - `login-return` / `login-theme`：两个浮动控件（[`crate::login`]）。
///
/// **官方登录页（label `login`）不在集合里**，歌词窗、托盘同理：它们拿不到"改主题 / 取消登录"的口子。
/// 判的仍然是 **webview label**（同窗宿主里窗口 label 恒为 `main`，按窗口判等于把守卫让出去）。
pub fn require_login_chrome_source(label: &str) -> Result<(), CoreError> {
    if label == MAIN_WINDOW_LABEL || crate::login::LOGIN_CHROME_LABELS.contains(&label) {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        format!("core_login_chrome 只接受主窗与登录浮动控件调用（来源 webview：{label}）"),
    ))
}

/// `core_login_chrome` 的动作（**纯数据**：解析与执行分开，判定就能单测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginChromeAction {
    /// 取消进行中的登录（浮动「返回扫码登录」）
    Cancel,
    /// 读回当前主题（控件挂载时用：不需要第二条命令）
    ReadTheme,
    /// 改主题（Rust 持有状态 + 落盘 + 广播 `theme:changed`）
    SetTheme(crate::theme::ThemeChoice),
}

/// `core_login_chrome` 的载荷 → 动作（纯函数；坏形状一律结构化 `invalid_payload`）。
///
/// 载荷形状只有三种，由 `action` 加"有没有带 `theme`"决定：
/// - `{action:"return"}`；
/// - `{action:"theme"}`（**没有** `theme` = 读回当前档位，与 `core_lyrics_configure` 的
///   "空补丁 = 读回"同一条纪律：再开一条命令只会多一个要同步的地方）；
/// - `{action:"theme", theme:"light"|"dark"|"system"}`。
///
/// 认不出的动作/档位**不猜**（宁可回结构化错误，也不要"点了没反应"）。
pub fn parse_login_chrome_action(payload: &Value) -> Result<LoginChromeAction, CoreError> {
    let invalid =
        |message: &str| CoreError::new("invalid_payload", format!("core_login_chrome {message}"));
    let object = payload
        .as_object()
        .ok_or_else(|| invalid("需要对象载荷 {action: \"return\"|\"theme\", theme?}"))?;

    match object.get("action").and_then(Value::as_str) {
        Some("return") => Ok(LoginChromeAction::Cancel),
        Some("theme") => match object.get("theme") {
            None | Some(Value::Null) => Ok(LoginChromeAction::ReadTheme),
            Some(Value::String(raw)) => crate::theme::ThemeChoice::from_setting(Some(raw))
                .map(LoginChromeAction::SetTheme)
                .ok_or_else(|| {
                    invalid("的 theme 只接受 light / dark / system（认不出的档位不猜）")
                }),
            Some(_) => Err(invalid("的 theme 必须是字符串（或省略 = 读回当前档位）")),
        },
        Some(other) => Err(invalid(&format!(
            "不认得的 action：{other}（只接受 return / theme）"
        ))),
        None => Err(invalid("缺少 action（只接受 return / theme）")),
    }
}

/// 请求频道准入：白名单外的频道在到达 sidecar 之前就被拒。
pub fn require_request_channel(channel: &str) -> Result<(), CoreError> {
    if REQUEST_CHANNELS.contains(&channel) {
        return Ok(());
    }
    Err(CoreError::new(
        "unknown_channel",
        format!("未知请求频道：{channel}"),
    ))
}

// ---------------------------------------------------------------------------
// R44e：持久化准入（唯一写者是 sidecar 的 writeTail；这里只管"谁能进、谁在飞"）
// ---------------------------------------------------------------------------

/// `settings:set` / `settings:get` 的频道名（与 `src/shared/request-channels.ts` 同源）。
pub const SETTINGS_SET_CHANNEL: &str = "settings:set";
pub const SETTINGS_GET_CHANNEL: &str = "settings:get";

/// **保留键**：只能经各自的运行时命令改（`core_login_chrome` 的 theme、`core_lyrics_configure`），
/// 渲染层不许用一条 `settings:set` 绕过运行时直接 patch 它们。
///
/// 绕过的代价不是"少一条广播"，而是**两份真相**：盘上写成了新主题/新歌词配置，Rust 内存里的
/// 权威值、`theme:changed` 广播与原生标题栏都还停在旧的那一份（重启才"变回去"）。
pub const RESERVED_SETTINGS_KEYS: &[&str] = &["theme", "lyricsWindow"];

/// 内部 settings 调用的超时（秒）。
///
/// 刻意比 `CALL_TIMEOUT_SECS`（60，渲染层业务调用）短得多：这两条内部调用服务于**退出**与
/// **主题/歌词落盘**，它们的调用方都要在有界时间内给结论（保窗可重试，而不是吊死退出）。
pub const SETTINGS_CALL_TIMEOUT_SECS: u64 = 10;

/// 持久化阶段（退出编排的状态机；只是"准入门"，不是进程状态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistPhase {
    /// 正常受理（渲染层与内部写都收）
    Running,
    /// 已进入退出准备：**拒新的渲染层写**，已受理的收尾、内部保存/退出 drain 继续
    PreparingExit,
    /// 准备成功、正在做不可逆清理：不再受理任何持久写
    Exiting,
}

/// 一次持久写是谁发起的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistKind {
    /// 渲染层经 `core_call` 发起（退出准备后一律拒：那时界面正在收摊，新的写没有意义）
    Renderer,
    /// Rust 自己的运行时（主题事务、歌词保存任务、退出 drain）发起
    Internal,
}

/// 准入判定（**纯函数**：判定与入队必须在同一个加锁方法里发生，不能先查 Running 再排队）。
pub fn decide_persist_admission(phase: PersistPhase, kind: PersistKind) -> Result<(), CoreError> {
    match (phase, kind) {
        (PersistPhase::Running, _) => Ok(()),
        (PersistPhase::PreparingExit, PersistKind::Internal) => Ok(()),
        (PersistPhase::PreparingExit, PersistKind::Renderer) => Err(CoreError::new(
            "shutting_down",
            "应用正在退出：已停止受理新的设置保存（本次退出会先把已受理的配置写完）",
        )),
        (PersistPhase::Exiting, _) => Err(CoreError::new(
            "shutting_down",
            "应用正在退出：不再受理设置写入",
        )),
    }
}

/// 一次已受理的持久写（RAII 凭据）。
///
/// **它就是"在飞"的记账**：退出编排等的是"没有凭据还活着"，而不是"调用方还在等"。
/// 凭据必须由**拥有任务**持有到实际调用有结论为止——`spawn_blocking`/后台线程里的
/// 那一份守卫一旦交给 invoke 的等待者，WebView 一关（或一次导航）就会提前放行退出。
pub struct PersistAdmission {
    gate: Arc<PersistenceGate>,
}

impl Drop for PersistAdmission {
    fn drop(&mut self) {
        self.gate.finish_one();
    }
}

/// 持久化准入门（在 `setup` 里登记；`Arc` 是给凭据留的引用）。
#[derive(Default)]
pub struct PersistenceGate {
    state: Mutex<GateState>,
    idle: std::sync::Condvar,
}

#[derive(Default)]
struct GateState {
    phase: Option<PersistPhase>,
    in_flight: usize,
}

fn lock_gate(state: &Mutex<GateState>) -> MutexGuard<'_, GateState> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PersistenceGate {
    pub fn new() -> Self {
        PersistenceGate {
            state: Mutex::new(GateState {
                // Option 只为了 Default：首次访问即 Running
                phase: Some(PersistPhase::Running),
                in_flight: 0,
            }),
            idle: std::sync::Condvar::new(),
        }
    }

    pub fn phase(&self) -> PersistPhase {
        lock_gate(&self.state)
            .phase
            .unwrap_or(PersistPhase::Running)
    }

    pub fn in_flight(&self) -> usize {
        lock_gate(&self.state).in_flight
    }

    /// 受理一次写。**判定与记账在同一个临界区**：中间没有"判定说 Running、入队时已冻结"的缝。
    pub fn admit(self: &Arc<Self>, kind: PersistKind) -> Result<PersistAdmission, CoreError> {
        let mut state = lock_gate(&self.state);
        let phase = state.phase.unwrap_or(PersistPhase::Running);
        decide_persist_admission(phase, kind)?;
        state.in_flight += 1;
        drop(state);
        Ok(PersistAdmission {
            gate: Arc::clone(self),
        })
    }

    /// 一次受理的写有结论了（成功/失败/超时都算结论）。
    fn finish_one(&self) {
        let mut state = lock_gate(&self.state);
        state.in_flight = state.in_flight.saturating_sub(1);
        if state.in_flight == 0 {
            self.idle.notify_all();
        }
    }

    /// 进入退出准备（幂等）：此后的**渲染层**写被拒，内部收尾继续。
    pub fn begin_prepare(&self) {
        let mut state = lock_gate(&self.state);
        if state.phase != Some(PersistPhase::Exiting) {
            state.phase = Some(PersistPhase::PreparingExit);
        }
    }

    /// 准备成功、进入不可逆清理：不再受理任何持久写。
    pub fn begin_exit(&self) {
        lock_gate(&self.state).phase = Some(PersistPhase::Exiting);
    }

    /// 准备失败：**回到 Running**（CAS 同义复位——下一次 Quit 必须能再试一次）。
    pub fn abort_prepare(&self) {
        let mut state = lock_gate(&self.state);
        if state.phase != Some(PersistPhase::Exiting) {
            state.phase = Some(PersistPhase::Running);
        }
    }

    /// 等已受理的写落地（有界）。`true` = 已排空。
    pub fn wait_drained(&self, deadline: std::time::Instant) -> bool {
        let mut state = lock_gate(&self.state);
        while state.in_flight > 0 {
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            state = self
                .idle
                .wait_timeout(state, deadline - now)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
        true
    }
}

/// 取登记好的准入门（没登记 = setup 未完成：调用方按"不能写"处理，绝不假装成功）。
pub fn persistence_gate<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Arc<PersistenceGate>, CoreError> {
    app.try_state::<Arc<PersistenceGate>>()
        .map(|state| Arc::clone(state.inner()))
        .ok_or_else(|| CoreError::new("internal", "持久化准入门未登记（setup 未完成）：这次不写盘"))
}

/// `core_call(settings:set)` 的**保留键闸门**（纯函数）。
///
/// 只拒"渲染层直接 patch 保留键"，其余载荷（proxy / queue / closeBehavior / reset / 未知键）
/// 原样放过：那些字段本来就归设置页写。
pub fn reject_reserved_settings_keys(channel: &str, payload: &Value) -> Result<(), CoreError> {
    if channel != SETTINGS_SET_CHANNEL {
        return Ok(());
    }
    let Some(patch) = payload.get("patch").and_then(Value::as_object) else {
        return Ok(()); // 形状问题交给 sidecar 的 planSettingsWrite 报 invalid_payload
    };
    let reserved: Vec<&str> = RESERVED_SETTINGS_KEYS
        .iter()
        .copied()
        .filter(|key| patch.contains_key(*key))
        .collect();
    if reserved.is_empty() {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        format!(
            "settings:set 不接受直接改保留键（{}）：主题走 core_login_chrome 的 theme 动作，歌词配置走 core_lyrics_configure",
            reserved.join(" / ")
        ),
    ))
}

/// 托管状态：当前 core（sidecar）进程。None = 未启动或已收尸。
#[derive(Default)]
pub struct CoreState {
    process: Mutex<Option<Arc<SidecarProcess>>>,
    notices: NoticeQueue,
}

/// 启动期提示队列 + 渲染层就绪标志。
///
/// 旧仓缺陷：启动期 `emit` 直接发进空气（那时渲染层还没订阅）。代理启动提示（R6 的环境变量兜底）
/// 恰好就是这种时机，所以队列在这里落地——R7 的门禁提示可以直接复用。
///
/// **就绪标志与队列必须在同一把锁下**：判定就绪与入队是两个动作，若分两次拿锁
/// （先读标志、再入队），中间那一段就是 check-then-act 的缝——渲染层恰好在这一刻完成
/// 「标记就绪 + 冲刷」，提示就 push 进那个**已经冲刷过**的队列，而冲刷只发生一次，
/// 这条提示再没有人管（用户永远看不到）。
#[derive(Default)]
pub struct NoticeQueue {
    state: Mutex<NoticeState>,
}

#[derive(Default)]
struct NoticeState {
    renderer_ready: bool,
    pending: Vec<EmitEnvelope>,
}

/// `core_renderer_ready` 的冲刷结果。
pub struct FlushOutcome {
    /// 本次是否是"首次就绪"（只用于日志：重复调用不重复报）。
    pub first_time: bool,
    /// 本次冲刷出来的待发提示（顺序 = 入队顺序）。
    pub flushed: Vec<EmitEnvelope>,
}

impl NoticeQueue {
    /// 就绪判定 + 入队的**唯一入口**（同一把锁内完成，调用方没有第二步可写）。
    ///
    /// - `Some(envelope)`：渲染层已就绪 → 调用方立刻投递（拿回去 emit）；
    /// - `None`：已就绪之前的提示，已排队，等 [`NoticeQueue::mark_ready_and_flush`]。
    pub fn deliver_or_queue(&self, envelope: EmitEnvelope) -> Option<EmitEnvelope> {
        let mut state = lock(&self.state);
        match plan_broadcast(state.renderer_ready) {
            BroadcastPlan::Deliver => Some(envelope),
            BroadcastPlan::Queue => {
                state.pending.push(envelope);
                None
            }
        }
    }

    /// 标记就绪并取走待发（同一把锁内完成）：
    /// 就绪之后入队的提示一律走"直接投递"，不会再落进队列，因此队列不会留下无人冲刷的孤儿。
    pub fn mark_ready_and_flush(&self) -> FlushOutcome {
        let mut state = lock(&self.state);
        let first_time = !state.renderer_ready;
        state.renderer_ready = true;
        FlushOutcome {
            first_time,
            flushed: std::mem::take(&mut state.pending),
        }
    }

    pub fn len(&self) -> usize {
        lock(&self.state).pending.len()
    }
}

/// 广播落地的时机决策（纯函数：让"启动期提示不会发进空气"可被单测钉住）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BroadcastPlan {
    /// 渲染层已就绪：直接 emit
    Deliver,
    /// 渲染层没就绪：先排队，等 `core_renderer_ready`
    Queue,
}

pub fn plan_broadcast(renderer_ready: bool) -> BroadcastPlan {
    if renderer_ready {
        BroadcastPlan::Deliver
    } else {
        BroadcastPlan::Queue
    }
}

impl CoreState {
    pub fn install(&self, process: Arc<SidecarProcess>) {
        *lock(&self.process) = Some(process);
    }

    pub fn shared(&self) -> Option<Arc<CoreShared>> {
        lock(&self.process)
            .as_ref()
            .map(|process| Arc::clone(process.shared()))
    }

    /// 收尸：幂等。返回是否真的收了一个进程。
    pub fn shutdown(&self, reason: &str) -> bool {
        let process = lock(&self.process).take();
        match process {
            Some(process) => {
                process.terminate(reason);
                true
            }
            None => false,
        }
    }

    /// 广播落地决策 + 入队：**一个加锁方法**，判定与入队之间没有缝（见 [`NoticeQueue`]）。
    ///
    /// `Some(..)` = 立刻投递，`None` = 已排队。就绪与否**只经这个方法对外可见**：
    /// 刻意不再暴露"读就绪标志"的公开口子（那正是缝的形状，谁读到谁就想自己再判一次）。
    pub fn deliver_or_queue(&self, envelope: EmitEnvelope) -> Option<EmitEnvelope> {
        self.notices.deliver_or_queue(envelope)
    }

    /// 标记渲染层就绪并冲刷启动期提示（同一把锁内完成）。
    pub fn mark_renderer_ready_and_flush(&self) -> FlushOutcome {
        self.notices.mark_ready_and_flush()
    }

    pub fn queued_notices(&self) -> usize {
        self.notices.len()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 拿 core；没有（启动失败或已收尸）就是结构化错误，而不是 panic 或静默。
pub fn require_shared(state: &CoreState) -> Result<Arc<CoreShared>, CoreError> {
    state.shared().ok_or_else(|| {
        CoreError::new("core_unavailable", "core 进程不可用（启动失败或已退出）")
    })
}

/// 宿主要求的路由决策（纯函数，便于单测）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRoute {
    /// 系统通知（R3 已实现）
    Notify,
    /// DPAPI 加密（R5 已接通）
    SecureEncrypt,
    /// DPAPI 解密（R5 已接通）
    SecureDecrypt,
    /// 打开官方登录页（R7）：**长轮询性质**——答复发生在登录页收场之后
    OpenLogin,
    /// 取消进行中的登录（R7）：把结论槽结算成 Cancelled
    CancelLogin,
    /// 路由表不认识这个频道
    Unknown,
}

pub fn route_host_request(channel: &str) -> HostRoute {
    match channel {
        "host:notify" => HostRoute::Notify,
        "host:secure-encrypt" => HostRoute::SecureEncrypt,
        "host:secure-decrypt" => HostRoute::SecureDecrypt,
        "host:open-login" => HostRoute::OpenLogin,
        "host:cancel-login" => HostRoute::CancelLogin,
        _ => HostRoute::Unknown,
    }
}

/// 宿主要求的处理计划：先决定"回什么"，再决定"怎么落地"（落地要 app，计划不要）。
#[derive(Debug, Clone, PartialEq)]
pub enum HostPlan {
    /// 先弹系统通知，再回 ack 响应帧
    Notify { text: String, ack: ResponseFrame },
    /// 直接回一帧（结构化错误也走这里）
    Respond(ResponseFrame),
    /// 已有人负责答复：调用方不得再写第二帧。
    ///
    /// R7 唯一的构造点是 `host:open-login` 的合法载荷——答复由 `login-view` 线程在登录页
    /// 收场后写出（旧仓把"等扫码"做成了同步阻塞，效果线程被占住，随后的取消请求永远送不进来）。
    Deferred,
    /// 取消登录（R7）：答复里要带"到底取消掉了没有"，那个答案只有 app 知道（计划阶段拿不到），
    /// 所以由 `apply_host_request` 算完**立刻**答复。
    CancelLogin,
}

pub fn plan_host_request(id: &str, channel: &str, payload: &Value) -> HostPlan {
    match route_host_request(channel) {
        HostRoute::Notify => {
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty());
            match text {
                Some(text) => HostPlan::Notify {
                    text: text.to_string(),
                    ack: ResponseFrame::ok(id, None),
                },
                None => HostPlan::Respond(ResponseFrame::err(
                    id,
                    CoreError::new("invalid_payload", "宿主要求 host:notify 需要非空 text"),
                )),
            }
        }
        HostRoute::SecureEncrypt => secure_plan(
            id,
            payload,
            ("plaintext", "cipher"),
            crate::secure_store::encrypt,
        ),
        HostRoute::SecureDecrypt => secure_plan(
            id,
            payload,
            ("cipher", "plaintext"),
            crate::secure_store::decrypt,
        ),
        // 登录窗配置的校验是纯函数（无 GUI、无 app），所以计划阶段就能把坏载荷挡掉：
        // 坏配置不该先起线程再失败（那样错误会晚一步到达，用户看到的是"点了没反应"）。
        HostRoute::OpenLogin => match crate::login::parse_config(payload) {
            Ok(_) => HostPlan::Deferred,
            Err(error) => HostPlan::Respond(ResponseFrame::err(id, error)),
        },
        // 取消要读运行时状态（有没有进行中的登录），所以答复在 `apply_host_request` 里算。
        HostRoute::CancelLogin => HostPlan::CancelLogin,
        HostRoute::Unknown => HostPlan::Respond(ResponseFrame::err(
            id,
            CoreError::new(
                "unknown_channel",
                format!("未知宿主要求频道：{channel}"),
            ),
        )),
    }
}

/// 宿主要求里的必需字符串字段：缺失/空串/类型不对都是 `invalid_payload`，且**不回显内容**。
fn required_string(payload: &Value, field: &str) -> Result<String, CoreError> {
    match payload.get(field) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        Some(Value::String(_)) => Err(CoreError::new(
            "invalid_payload",
            format!("宿主要求的 {field} 不能是空串"),
        )),
        Some(_) => Err(CoreError::new(
            "invalid_payload",
            format!("宿主要求的 {field} 必须是字符串"),
        )),
        None => Err(CoreError::new(
            "invalid_payload",
            format!("宿主要求缺少字符串字段 {field}"),
        )),
    }
}

/// 安全存储类宿主要求的计划：先校验载荷，再交给 [`crate::secure_store`]，后端错误原样结构化返回。
///
/// 载荷形状（R5 定形；Node 侧 `src/main/session-store.mjs` 消费）：
/// - `host:secure-encrypt`：入 `{plaintext}` → 出 `{cipher}`；
/// - `host:secure-decrypt`：入 `{cipher}` → 出 `{plaintext}`。
///
/// 刻意不做任何"失败就降级成明文"的分支：后端不可用就如实回 `secure_store_unavailable`，
/// 由上层决定保留内存会话（提示 UI 是 R7+ 的事）。
fn secure_plan(
    id: &str,
    payload: &Value,
    fields: (&'static str, &'static str),
    operate: fn(&str) -> Result<String, CoreError>,
) -> HostPlan {
    let (in_field, out_field) = fields;
    let input = match required_string(payload, in_field) {
        Ok(input) => input,
        Err(error) => return HostPlan::Respond(ResponseFrame::err(id, error)),
    };
    match operate(&input) {
        Ok(value) => {
            let mut data = serde_json::Map::new();
            data.insert(out_field.to_string(), Value::String(value));
            HostPlan::Respond(ResponseFrame::ok(id, Some(Value::Object(data))))
        }
        Err(error) => HostPlan::Respond(ResponseFrame::err(id, error)),
    }
}

/// 漏斗事件载荷：渲染层只订阅一个事件名，按 channel 分流。
#[derive(Debug, Clone, Serialize)]
pub struct EmitEnvelope {
    pub channel: String,
    pub payload: Value,
}

pub fn emit_envelope(channel: &str, payload: Value) -> EmitEnvelope {
    EmitEnvelope {
        channel: channel.to_string(),
        payload,
    }
}

/// 效果落地：在效果线程上跑（`app.emit`、系统通知都不能占着阻塞读的帧泵线程）。
pub fn apply_effect(app: &AppHandle, shared: &Arc<CoreShared>, effect: Effect) {
    match effect {
        Effect::Emit { channel, payload } => emit_core_event(app, &channel, payload),
        Effect::HostRequest {
            id,
            channel,
            payload,
        } => apply_host_request(app, shared, &id, &channel, &payload),
        Effect::CoreGone { code } => {
            log::warn!("core（sidecar）已退出：退出码 {code:?}；在途调用已结清，此后调用立刻失败");
        }
        Effect::Notice(text) => log::info!("core 提示：{text}"),
    }
}

/// 向渲染层广播一条漏斗事件：**事件信封的唯一构造点**。
///
/// 宿主侧模块（R11 的托盘）发广播只能经这里：信封形状（`{channel, payload}`）与
/// **"渲染层没就绪就先排队"**两条规矩都收在这一个函数里。模块里直接写 `app.emit(` 等于绕开
/// 启动期队列——启动期发出去的提示会直接发进空气（旧仓缺陷，R6 修复轮的 NoticeQueue 就是为它）。
pub fn emit_core_event<R: tauri::Runtime>(app: &AppHandle<R>, channel: &str, payload: Value) {
    let envelope = emit_envelope(channel, payload);
    match app.try_state::<Arc<CoreState>>() {        // 判定与入队是同一个加锁方法：不存在"判定说没就绪、入队时已经就绪"的缝，
        // 也就不会有提示被塞进已经冲刷过的队列（那种提示再没人冲刷）。
        Some(state) => match state.deliver_or_queue(envelope) {
            Some(envelope) => emit_now(app, envelope),
            None => log::info!(
                "渲染层未就绪：广播 {channel} 已排队（待冲刷 {} 条）",
                state.queued_notices()
            ),
        },
        // 托管状态还没登记（启动极早期，setup 里 core 状态登记之前）：没有队列可用，只能直接发
        None => emit_now(app, envelope),
    }
}

/// 立刻向渲染层广播漏斗事件（`core:event`）。
fn emit_now<R: tauri::Runtime>(app: &AppHandle<R>, envelope: EmitEnvelope) {
    let channel = envelope.channel.clone();
    if let Err(source) = app.emit(CORE_EVENT, envelope) {
        log::warn!("向渲染层广播 {channel} 失败：{source}");
    }
}

/// 宿主要求路由：系统通知与安全存储已接通；登录窗由 R7 的 `login.rs` 承接。
pub fn apply_host_request(
    app: &AppHandle,
    shared: &Arc<CoreShared>,
    id: &str,
    channel: &str,
    payload: &Value,
) {
    match plan_host_request(id, channel, payload) {
        HostPlan::Respond(frame) => respond_frame(shared, frame),
        HostPlan::Notify { text, ack } => {
            if let Err(source) = show_notification(app, &text) {
                log::warn!("系统通知未能送达：{source}");
                respond_frame(
                    shared,
                    ResponseFrame::err(
                        id,
                        CoreError::new("internal", "系统通知未能送达（详情见日志）"),
                    ),
                );
                return;
            }
            respond_frame(shared, ack);
        }
        HostPlan::Deferred => {
            // open-login：起登录窗线程，答复由它在**窗收场之后**写出（本桥不再写第二次）。
            // 起不来（配置坏、线程起不来）才由这里立刻回结构化错误。
            if let Err(error) = crate::login::open_login(app, shared, id, payload) {
                respond_frame(shared, ResponseFrame::err(id, error));
            }
        }
        HostPlan::CancelLogin => {
            let frame = match crate::login::cancel_login(app) {
                Ok(cancelled) => ResponseFrame::ok(id, Some(serde_json::json!({ "cancelled": cancelled }))),
                Err(error) => ResponseFrame::err(id, error),
            };
            respond_frame(shared, frame);
        }
    }
}

fn respond_frame(shared: &Arc<CoreShared>, frame: ResponseFrame) {
    let id = frame.id.clone();
    let result = frame.into_result();
    if !shared.respond(&id, result) {
        log::warn!("宿主要求 {id} 的答复被拒绝（已答复过，或写入端已关）");
    }
}

fn show_notification(app: &AppHandle, text: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let title = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());
    app.notification()
        .builder()
        .title(title)
        .body(text)
        .show()
        .map_err(|source| source.to_string())
}

/// 帧泵接线：解析 → 结清/效果 → 效果线程落地。setup 里调用一次。
pub fn start_pump(app: &AppHandle, process: &Arc<SidecarProcess>) {
    let shared = Arc::clone(process.shared());
    let app_handle = app.clone();
    if let Err(error) = process.start_pump(move |effect| apply_effect(&app_handle, &shared, effect))
    {
        log::error!("core 帧泵启动失败：{error}");
    }
}

/// 显式收尸：`RunEvent::ExitRequested`/`Exit` 调用。幂等。
pub fn shutdown_core<R: tauri::Runtime>(app: &AppHandle<R>, reason: &str) {
    match app.try_state::<Arc<CoreState>>() {
        Some(state) if state.shutdown(reason) => log::info!("core 已收尸（{reason}）"),
        Some(_) => log::info!("core 收尸跳过（{reason}）：没有活着的进程"),
        None => log::warn!("core 收尸跳过（{reason}）：托管状态未登记"),
    }
}

/// 渲染层唯一业务通道：来源守卫 → 频道准入 → sidecar 调用（带超时）。
///
/// 阻塞等待（最长 [`CALL_TIMEOUT_SECS`] 秒）放在 `spawn_blocking` 里：同步命令会占住主线程，
/// 异步命令里直接阻塞又会卡住 async 运行时的工作线程。
#[tauri::command]
pub async fn core_call(
    app: AppHandle,
    webview: Webview,
    channel: String,
    payload: Option<Value>,
) -> Result<Value, CoreError> {
    require_main_webview(webview.label())?;
    require_request_channel(&channel)?;

    let state = app.state::<Arc<CoreState>>().inner().clone();
    let payload = payload.unwrap_or(Value::Null);
    // R44e：保留键只能走各自运行时命令（绕过去就是盘上与内存两份真相）。
    reject_reserved_settings_keys(&channel, &payload)?;
    let shared = require_shared(&state)?;
    // R44e：settings:set 是**持久写**，要过准入门；凭据随阻塞任务一起活到调用有结论为止
    //（invoke 的等待者消失不会提前放行退出——它只是不再收结果）。
    let admission = if channel == SETTINGS_SET_CHANNEL {
        Some(persistence_gate(&app)?.admit(PersistKind::Renderer)?)
    } else {
        None
    };
    let call = tauri::async_runtime::spawn_blocking(move || {
        let _admission = admission;
        shared.call(&channel, payload, Duration::from_secs(CALL_TIMEOUT_SECS))
    });

    match call.await {
        Ok(result) => result,
        Err(source) => Err(CoreError::new(
            "internal",
            format!("core_call 任务失败：{source}"),
        )),
    }
}

// ---------------------------------------------------------------------------
// R44e：内部 settings 调用（Rust 拥有的运行时写；不经 invoke、不持进程槽锁）
// ---------------------------------------------------------------------------

/// 把一次内部 settings 调用限制在**整个退出准备的绝对期限**之内（review finding 4）。
///
/// 退出准备只有一条 4 秒预算（[`crate::EXIT_PREPARE_BUDGET_MS`]）：uncertain 重存与最终的
/// `settings:get` 屏障要拿的是**这一刻剩下的**时间，而不是各自再起一个 10 秒等待；剩下的
/// 时间连一次调用都不够时直接结构化失败（`timeout`）——退出走既有的可逆 abort，保窗可重试。
pub fn call_timeout_within(
    deadline: std::time::Instant,
    now: std::time::Instant,
    cap: Duration,
) -> Result<Duration, CoreError> {
    if now >= deadline {
        return Err(CoreError::new(
            "timeout",
            "退出准备的预算已用尽（这次保存没有时间窗口）：本次不退出，请稍后重试",
        ));
    }
    Ok((deadline - now).min(cap))
}

/// 一次内部调用放在**拥有任务**里跑：写帧与等回执都在后台线程上，调用方只等到自己的绝对期限。
///
/// 为什么不能只把 timeout 交给 [`CoreShared::call`]（review round 2 finding 2）：那是
/// `recv_timeout` 的上限，而 `call` 在等回执**之前**要**同步**写一帧（`write_line` 锁写入端 →
/// `write_all` → `flush`）。对端管道堵住时这一段没有任何上限，4 秒的退出预算能被一次写盘整个
/// 拖穿——"有界退出"就不成立了。
///
/// 两条不变：
/// 1. **所有权随任务走**：`owned`（受理凭据）由后台线程持有到那一笔真正有结论为止（响应 /
///    自己的超时 / 收尸）。调用方超时返回时它**不**被释放，所以 `wait_drained` 仍看得见这一笔：
///    "可能已经发出去的迟到写"没落定之前，退出不可能成功，也不会有"退出成功之后才写盘"。
/// 2. **不阻塞 UI 线程**：调用方是退出线程 / 主题事务线程 / 歌词保存线程；写帧的阻塞只留在
///    这一条后台线程里。
pub fn call_owned_within(
    shared: Arc<CoreShared>,
    channel: &'static str,
    payload: Value,
    deadline: std::time::Instant,
    cap: Duration,
    owned: Option<PersistAdmission>,
) -> Result<Value, CoreError> {
    // 预算判定在起线程之前：没预算就一次都不发（结构化 timeout，退出走可逆 abort）。
    let timeout = call_timeout_within(deadline, std::time::Instant::now(), cap)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("settings-call".into())
        .spawn(move || {
            // 凭据活到 `call` 有结论（含同步写帧被堵住的那一段）：这就是"写在飞"的记账。
            let _owned = owned;
            let _ = sender.send(shared.call(channel, payload, timeout));
        })
        .map_err(|error| CoreError::new("internal", format!("内部调用任务起不来（{error}）：这次不写盘")))?;
    let left = deadline.saturating_duration_since(std::time::Instant::now());
    match receiver.recv_timeout(left) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(CoreError::new(
            "timeout",
            format!("内部调用 {channel} 没在给定时间内返回（写可能仍在进行，不能当作没写）"),
        )),
        // 拥有任务没回话（线程本身出事）：同样**不能**当作"没写"——那一帧可能已经发出去了。
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(CoreError::new(
            "uncertain",
            format!("内部调用 {channel} 的拥有任务没有结论（写可能已经发生，不能当作没写）"),
        )),
    }
}

/// 取 `Arc<CoreShared>`（克隆出来就放掉进程槽锁：等待期间不能再持它）。
fn shared_for_call<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Arc<CoreShared>, CoreError> {
    let state = app
        .try_state::<Arc<CoreState>>()
        .ok_or_else(|| CoreError::new("core_unavailable", "core 状态未登记（setup 未完成）"))?;
    require_shared(state.inner())
}

/// 内部 `settings:set`：同步语义的一次写（调用方负责把它放到不占主线程的线程上）。
///
/// 三条不变量：
/// 1. 准入凭据由**拥有任务**持有到 `call` 有结论（调用方是 Rust 拥有的任务，不是 WebView 等待者）；
/// 2. 等待期间不持进程槽锁（`shared_for_call` 只克隆 `Arc`）；
/// 3. 返回 `timeout` 只说明"调用方没等到"，**写可能迟到**（`CoreShared::call` 超时后 `forget` 了
///    接收槽，sidecar 仍可能把那一帧处理完）。所以调用方必须把"超时"当 `uncertain`，不能当"没写"；
///    而那一笔的准入凭据要等它自己落定才放（超时返回不释放，退出因此挡得住）。
pub fn settings_write_owned<R: tauri::Runtime>(
    app: &AppHandle<R>,
    patch: Value,
) -> Result<Value, CoreError> {
    settings_write_owned_within(app, patch, Duration::from_secs(SETTINGS_CALL_TIMEOUT_SECS))
}

/// 同上，但**整次调用**（同步写帧 + 等回执）不许超过 `timeout`。
///
/// 时间上限不是转手给 `CoreShared::call` 的 `recv_timeout`（那只管等回执）：写帧也在限时之内，
/// 由 [`call_owned_within`] 的拥有任务在期限上把控制权交回调用方。
pub fn settings_write_owned_within<R: tauri::Runtime>(
    app: &AppHandle<R>,
    patch: Value,
    timeout: Duration,
) -> Result<Value, CoreError> {
    let gate = persistence_gate(app)?;
    let shared = shared_for_call(app)?;
    // 受理凭据交给**调用任务**，不留在调用方：调用方超时返回之后这一笔仍算在飞（可能迟到写成）。
    let admission = Some(gate.admit(PersistKind::Internal)?);
    call_owned_within(
        shared,
        SETTINGS_SET_CHANNEL,
        serde_json::json!({ "patch": patch }),
        std::time::Instant::now() + timeout,
        timeout,
        admission,
    )
}

/// 内部 `settings:get`：**读也是屏障**（sidecar 先排空已受理的写再读盘）。
///
/// 上限来自**退出准备的绝对期限**（剩余预算；没预算就立刻失败），并且与写共用同一条拥有任务
/// 边界（[`call_owned_within`]）——"同步写帧被堵住"不会把调用方拖过它的期限。
///
/// 只有这一个入口：退出路径的读**永远**拿剩余预算，没有"另起一个 10 秒"的变体。
pub fn settings_read_owned_before<R: tauri::Runtime>(
    app: &AppHandle<R>,
    deadline: std::time::Instant,
) -> Result<Value, CoreError> {
    call_owned_within(
        shared_for_call(app)?,
        SETTINGS_GET_CHANNEL,
        Value::Null,
        deadline,
        Duration::from_secs(SETTINGS_CALL_TIMEOUT_SECS),
        None,
    )
}

/// 内部 `settings:set` 的**拥有任务**形式：起一条后台线程跑 [`settings_write_owned`]，
/// 结果经通道回来。
///
/// 为什么是线程而不是"让命令自己 await"：主题的整笔事务（写 → 校验回执 → 更新内存/原生/广播）
/// 必须由 Rust 拥有——invoke 的等待者（WebView 导航、组件卸载）消失**不能**取消后半提交。
/// 丢弃返回的 receiver 只会让结果没人看，线程照样跑完、凭据照样在结论时放掉。
pub fn spawn_settings_write<R: tauri::Runtime>(
    app: &AppHandle<R>,
    patch: Value,
) -> std::sync::mpsc::Receiver<Result<Value, CoreError>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let owner = app.clone();
    let _ = std::thread::Builder::new()
        .name("settings-write".into())
        .spawn(move || {
            let _ = sender.send(settings_write_owned(&owner, patch));
        });
    receiver
}

/// 从 `settings:set` 回执里取权威文档里某个键的值（纯函数：形状认不出就 `None`，绝不猜）。
pub fn settings_receipt_value<'a>(answer: &'a Value, key: &str) -> Option<&'a Value> {
    answer.get("settings")?.get("data")?.get(key)
}

/// 渲染层就绪通知：启动期提示队列的冲刷钩子。
///
/// 返回值 = 本次冲刷的提示条数。渲染层必须先订阅 `core:event` 再调这里，否则提示还是会丢
/// （订阅在渲染层，R8 的 main.tsx 负责；R6 只保证"排了队、就绪即冲刷"）。
#[tauri::command]
pub fn core_renderer_ready(
    webview: Webview,
    state: State<'_, Arc<CoreState>>,
) -> Result<u32, CoreError> {
    require_main_webview(webview.label())?;
    // 标记就绪与冲刷在同一个加锁方法里完成：冲刷期间到的广播会走"直接投递"这条更快的路，
    // 也不会有人把提示塞进已经冲刷过的队列（见 NoticeQueue）。
    let outcome = state.mark_renderer_ready_and_flush();
    let count = outcome.flushed.len() as u32;
    let app = webview.app_handle();
    for envelope in outcome.flushed {
        emit_now(app, envelope);
    }
    if outcome.first_time {
        log::info!("渲染层就绪：已冲刷启动期提示 {count} 条");
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// 开机自启（R10）
// ---------------------------------------------------------------------------

/// 开机自启的读写口子。
///
/// 抽成 trait 的两个理由：
/// 1. 单测不需要 tauri app / mock runtime（`AutoLaunchManager` 是插件 setup 里托管的，拿不到就
///    只能整段不测）；
/// 2. **单测绝不能写本机注册表**——真跑一次 `enable()` 会在开发机上留下一个自启项，
///    而那是用户的机器状态，不是测试夹具。假 manager 覆盖判定逻辑，真插件调用层只做转发。
pub trait AutoStart {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

impl AutoStart for tauri_plugin_autostart::AutoLaunchManager {
    fn enable(&self) -> Result<(), String> {
        tauri_plugin_autostart::AutoLaunchManager::enable(self).map_err(|error| error.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        tauri_plugin_autostart::AutoLaunchManager::disable(self).map_err(|error| error.to_string())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        tauri_plugin_autostart::AutoLaunchManager::is_enabled(self).map_err(|error| error.to_string())
    }
}

/// 应用自启开关，并**回报观测到的实际状态**。
///
/// 为什么写完要回读：`enable()` 返回 `Ok` 只说明这次调用没报错，不代表系统真的记下了
/// （Windows 上是 `Run` 键写入，可能被策略/权限挡回）。把请求回显成"已开启"，
/// 代价是用户下次开机才发现没生效——而这中间界面一直在说"已开启"。
pub fn apply_autostart(enabled: bool, manager: &dyn AutoStart) -> Result<bool, CoreError> {
    let applied = if enabled { manager.enable() } else { manager.disable() };
    if let Err(detail) = applied {
        return Err(CoreError::new(
            "internal",
            format!("开机自启设置失败（{detail}）"),
        ));
    }
    manager.is_enabled().map_err(|detail| {
        CoreError::new("internal", format!("开机自启状态读取失败（{detail}）"))
    })
}

/// 读当前自启状态（设置页挂载时用）。
pub fn read_autostart(manager: &dyn AutoStart) -> Result<bool, CoreError> {
    manager.is_enabled().map_err(|detail| {
        CoreError::new("internal", format!("开机自启状态读取失败（{detail}）"))
    })
}

/// 取插件的 `AutoLaunchManager` 托管状态。
///
/// 用 `try_state` 而不是插件扩展 trait 的 `autolaunch()`：后者在插件没注册时**直接 panic**，
/// 命令里 panic 的后果是整个应用崩掉，而不是界面上显示一句"改不了开机自启"。
///
/// 入参是 [`tauri::Webview`]（R23 起命令面一律拿 webview）：托管状态的查找两者同源，
/// 拿 webview 是为了**来源判定**那一头（见 [`require_main_webview`]）。
fn autostart_manager<R: tauri::Runtime>(
    webview: &Webview<R>,
) -> Result<State<'_, tauri_plugin_autostart::AutoLaunchManager>, CoreError> {
    webview
        .try_state::<tauri_plugin_autostart::AutoLaunchManager>()
        .ok_or_else(|| {
            CoreError::new(
                "internal",
                "开机自启插件未注册：无法读写系统自启（详情见日志）",
            )
        })
}

/// 设置页的"开机自启"开关。
///
/// **为什么不加 capabilities 权限条目**（Tauri 2.12 语义，逐行出处已核对）：
/// `tauri::Webview::on_message`（tauri-2.12.4 `src/webview/mod.rs:2080`）只在三种情形查 ACL——
/// ① 命令名带 `plugin:` 前缀；② 应用定义了 app 级 ACL manifest；③ 来源不是本地
/// （`!is_local`，远程 URL）。而 ② 的前置是 `tauri-build` 侧算出的 `has_app_manifest`
/// （`src/acl.rs:421`：`app_manifest` 带 commands，或 `src-tauri/permissions` 非空）——
/// 本应用 `build.rs` 只调 `tauri_build::build()`（无 app_manifest）、没有 `permissions/` 目录，
/// 渲染层来源是本地 `tauri://localhost`，所以自定义命令**不经 ACL**（`core_call` /
/// `core_renderer_ready` 一直如此）。这些前置条件由 `test/autostart.test.mjs` 钉住：
/// 将来谁加了 app 级 manifest，那条用例会先红，提醒他同步加权限条目。
///
/// 顺带：这条命令挂在 `require_main_webview` 后面——登录页/歌词窗/托盘都改不了系统自启。
#[tauri::command]
pub fn core_set_autostart(webview: Webview, enabled: bool) -> Result<bool, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_set_autostart", error))?;
    let manager = autostart_manager(&webview).map_err(|error| logged("core_set_autostart", error))?;
    apply_autostart(enabled, manager.inner()).map_err(|error| logged("core_set_autostart", error))
}

/// 读当前开机自启状态（设置页挂载时一次；没有这条，开关的初始状态只能靠猜）。
#[tauri::command]
pub fn core_get_autostart(webview: Webview) -> Result<bool, CoreError> {
    require_main_webview(webview.label()).map_err(|error| logged("core_get_autostart", error))?;
    let manager = autostart_manager(&webview).map_err(|error| logged("core_get_autostart", error))?;
    read_autostart(manager.inner()).map_err(|error| logged("core_get_autostart", error))
}

/// 命令失败时先把**原文**记进运行日志，再原样返回给渲染层。
///
/// 界面只说一句可操作的话（原因 + 下一步）；core 侧的原文留给日志面板——
/// 同一个失败说两遍，第二遍还带着技术细节，用户既读不懂也帮不上排障。
fn logged(command: &str, error: CoreError) -> CoreError {
    log::warn!("{command} 未完成：{error}");
    error
}

// ---------------------------------------------------------------------------
// 托盘可用性（R11）
// ---------------------------------------------------------------------------

/// 托盘**是不是真的可用**（设置页的关窗行为提示与托盘文案要这一条）。
///
/// R10 之前渲染层的 `TRAY_AVAILABLE` 是写死的 `false`——那是**如实**（宿主侧当时没有"托盘在不在"
/// 的口子），但托盘装上之后，那句写死的话就变成假话了。这条命令是那个口子的唯一来源。
///
/// **只认"确实装上了"这一个事实**（Windows 同时检查 Shell 原生注册，不只看 tauri 对象）：
/// 查不到就回 `false`——保守方向与 `tray::decide_close` 的 fail-safe 一致。
/// 界面说"不可用"而实际能用，比反过来（界面说能用、关窗却退出了）代价小得多。
///
/// 与自启那两条同一个门（`require_main_webview`）：登录页/歌词窗问不了这件事。
#[tauri::command]
pub fn core_get_tray_available(webview: Webview) -> Result<bool, CoreError> {
    require_main_webview(webview.label())?;
    Ok(crate::tray::available(webview.app_handle()))
}

// ---------------------------------------------------------------------------
// 运行日志（R56）
// ---------------------------------------------------------------------------

/// 设置页「日志」标签的数据源：最新日志文件的最后 [`crate::run_log::READ_LIMIT`] 条（旧的在前）。
///
/// 只给主窗（与自启/托盘同一道门）：日志是宿主的诊断面，登录页与浮动控件不该读到。
/// 每条 `message` 在返回前已脱敏（`run_log::redact`），渲染层拿到的就是能直接显示的东西。
#[tauri::command]
pub fn core_read_run_log(webview: Webview) -> Result<Vec<crate::run_log::RunLogEntry>, CoreError> {
    require_main_webview(webview.label())?;
    let dir = crate::run_log::resolve_dir(
        std::env::var(crate::DATA_DIR_ENV).ok().as_deref(),
        webview.path().app_log_dir().ok(),
    );
    crate::run_log::read_entries(&dir, crate::run_log::READ_LIMIT).map_err(|source| {
        log::warn!("读运行日志失败（{}）：{source}", dir.display());
        CoreError::new("internal", format!("读不到运行日志：{source}"))
    })
}

// ---------------------------------------------------------------------------
// 登录体验的浮动控件（R25）
// ---------------------------------------------------------------------------

/// 登录体验的控件命令：**取消登录**与**主题三态**两条动作。
///
/// 为什么需要它（而不是复用 `core_call`）：两个浮动控件是主窗里的**另外两个子 webview**
/// （label `login-return` / `login-theme`），而 `core_call` 的来源守卫只认主窗那一个 label
/// （[`require_main_webview`]）——放宽它等于把**全部业务频道**交给登录体验的浮动控件。
/// 这条命令的守卫（[`require_login_chrome_source`]）只放行 `main` 与那两个 label。
///
/// 回执是**事实**：
/// - `{action:"return"}` → `{cancelled: bool}`：与 `auth:cancel-login` 落到**同一个结论槽**
///   （[`crate::login::cancel_login`]），之后 sidecar 的登录流程照常收场并广播带文案的
///   `auth:status`，门禁据此回到二维码态——R18 那条链一个字都没改；
/// - `{action:"theme"}` → `{theme: "light"|"dark"|"system"}`：读回当前档位；
/// - `{action:"theme", theme}` → 落盘 + 更新内存 + 广播 `theme:changed`，回执是**实际生效**的档位。
///
/// 异步命令：`theme` 的**整笔事务**（写盘 → 校验回执 → 内存/原生/revision/广播）由 Rust 拥有的
/// 线程完成，所以这条命令是 async——它等的是"事务有结论"，而不是"这一次调用返回了"。
/// 等待者消失（WebView 导航/组件卸载）不会取消后半提交（见 [`crate::theme::spawn_theme_transaction`]）。
#[tauri::command]
pub async fn core_login_chrome(
    app: AppHandle,
    webview: Webview,
    payload: Option<Value>,
) -> Result<Value, CoreError> {
    require_login_chrome_source(webview.label())?;
    let action = parse_login_chrome_action(payload.as_ref().unwrap_or(&Value::Null))?;
    match action {
        LoginChromeAction::Cancel => {
            let cancelled = crate::login::cancel_login(&app)?;
            Ok(serde_json::json!({ "cancelled": cancelled }))
        }
        LoginChromeAction::ReadTheme => {
            // 读回也带 revision：渲染层拿它拒绝"慢半拍"的旧回执（同一份单调合同）。
            // 档位与编号是同一次原子快照（不会拼出"新档位 + 旧编号"）。
            Ok(crate::theme::reply_payload(crate::theme::current_snapshot(&app)))
        }
        LoginChromeAction::SetTheme(choice) => {
            // 回执是**这一笔事务自己提交的** `{theme, revision}`——不是事务结束后另读的快照。
            // 另读会让"旧档位 + 新编号"溜回渲染层（单调合同拦不住，界面被拉回旧主题）。
            let commit = crate::theme::set_theme(&app, choice).await?;
            log::info!("主题已改为 {}（revision {}）", commit.theme.describe(), commit.revision);
            Ok(crate::theme::reply_payload(commit))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn main_webview_guard_allows_only_the_main_webview() {
        assert!(require_main_webview(crate::MAIN_WINDOW_LABEL).is_ok());
        for label in [crate::LYRICS_WINDOW_LABEL, "login", "tray", ""] {
            let error = require_main_webview(label).expect_err("非主窗来源必须被拒绝");
            assert_eq!(error.kind.as_deref(), Some("forbidden_source"));
            assert!(error.message.contains(label), "错误应指明来源：{}", error.message);
        }
    }

    /// R25：浮动控件的专用命令守卫。允许集合恰好是三个 label，其余一律拒——
    /// **官方登录页（`login`）不在里面**（它手里不该多一个"改主题 / 取消登录"的口子），
    /// 歌词窗与托盘同理。
    #[test]
    fn the_login_chrome_guard_allows_exactly_the_main_window_and_the_two_widgets() {
        for label in [
            crate::MAIN_WINDOW_LABEL,
            crate::login::LOGIN_RETURN_WEBVIEW_LABEL,
            crate::login::LOGIN_THEME_WEBVIEW_LABEL,
        ] {
            assert!(require_login_chrome_source(label).is_ok(), "{label} 应当被放行");
        }

        for label in [
            crate::login::LOGIN_WEBVIEW_LABEL, // 官方登录页：零命令权限是硬边界
            crate::LYRICS_WINDOW_LABEL,
            crate::TRAY_ID,
            "login-return ",
            "LOGIN-RETURN",
            "",
        ] {
            let error = require_login_chrome_source(label).expect_err("非允许来源必须被拒绝");
            assert_eq!(error.kind.as_deref(), Some("forbidden_source"), "来源：{label}");
            assert!(error.message.contains(label), "错误应指明来源：{}", error.message);
        }
    }

    /// 载荷解析（纯函数）：三种合法形状 + 认不出的一律结构化拒绝（不猜）。
    #[test]
    fn login_chrome_payloads_are_parsed_without_guessing() {
        assert_eq!(
            parse_login_chrome_action(&json!({"action": "return"})),
            Ok(LoginChromeAction::Cancel)
        );
        assert_eq!(
            parse_login_chrome_action(&json!({"action": "theme"})),
            Ok(LoginChromeAction::ReadTheme),
            "没带 theme = 读回当前档位（不需要第二条命令）"
        );
        assert_eq!(
            parse_login_chrome_action(&json!({"action": "theme", "theme": null})),
            Ok(LoginChromeAction::ReadTheme)
        );
        for (raw, expected) in [
            ("light", crate::theme::ThemeChoice::Light),
            ("dark", crate::theme::ThemeChoice::Dark),
            ("system", crate::theme::ThemeChoice::System),
        ] {
            assert_eq!(
                parse_login_chrome_action(&json!({"action": "theme", "theme": raw})),
                Ok(LoginChromeAction::SetTheme(expected)),
                "{raw} 是合法档位"
            );
        }

        for bad in [
            json!({}),
            json!({"action": "open"}),
            json!({"action": "return-"}),
            json!({"action": 7}),
            json!({"action": "theme", "theme": "auto"}),
            json!({"action": "theme", "theme": "Light"}),
            json!({"action": "theme", "theme": 1}),
            json!([]),
            json!("return"),
            Value::Null,
        ] {
            let error = parse_login_chrome_action(&bad).expect_err("坏载荷必须结构化拒掉");
            assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "载荷：{bad}");
        }
    }

    /// 源码钉子：这条命令必须挂在**专用**来源守卫后面，且判的是 webview label。
    #[test]
    fn the_login_chrome_command_is_guarded_by_its_own_source_check() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands.rs"))
            .expect("要能读到自己的源码");
        let production = match source.find("#[cfg(test)]") {
            Some(cut) => &source[..cut],
            None => &source[..],
        };
        let start = production
            .find("pub async fn core_login_chrome(")
            .expect("找不到命令本体");
        let end = production[start..]
            .find("\n}\n")
            .map(|offset| start + offset)
            .expect("命令本体没有闭合");
        let body = &production[start..end];

        assert!(
            body.contains("require_login_chrome_source(webview.label())"),
            "浮动控件的命令必须过**专用**守卫并判 webview label：{body}"
        );
        assert!(
            !body.contains("require_main_webview("),
            "它不能用 core_call 那条守卫：浮动控件的 label 不是 main（用了就等于永远拒绝）"
        );
    }

    /// R23 的关键钉子（同窗宿主的**安全前提**）：登录页与主窗共用同一个窗口，
    /// 于是 `window.label()` 恒为 `main`——按窗口 label 判来源等于把守卫让给登录页。
    /// 唯一能区分两者的东西是 **webview label**（登录页 `login` ≠ 主窗 `main`）。
    ///
    /// 扫的是字面量：命令面必须拿 `Webview` 并判 `webview.label()`；一旦有人改回
    /// `Window` + `window.label()`，这条会立刻红（那是"登录页获得业务命令权限"的形状）。
    #[test]
    fn every_guarded_command_judges_by_webview_label_not_window_label() {
        for relative in ["/src/commands.rs", "/src/lyrics_window.rs"] {
            let source = std::fs::read_to_string(format!("{}{relative}", env!("CARGO_MANIFEST_DIR")))
                .unwrap_or_else(|_| panic!("要能读到 {relative}"));
            let production = match source.find("#[cfg(test)]") {
                Some(cut) => &source[..cut],
                None => &source[..],
            };

            assert!(
                production.contains("require_main_webview(webview.label())"),
                "{relative} 的来源守卫必须判 webview label"
            );
            assert!(
                !production.contains("require_main_window("),
                "{relative} 不许再有按窗口 label 判来源的守卫（同窗后它区分不出登录页）"
            );
            assert!(
                !production.contains("window: Window") && !production.contains("window: tauri::Window"),
                "{relative} 的命令参数不许再拿 Window（同窗后它的 label 恒为 main）"
            );
        }
    }

    #[test]
    fn request_channel_guard_accepts_whitelist_and_rejects_others() {
        for channel in REQUEST_CHANNELS {
            assert!(require_request_channel(channel).is_ok(), "{channel} 在白名单内");
        }
        for channel in ["auth:not-a-channel", "", "host:notify", "core:event"] {
            let error = require_request_channel(channel).expect_err("白名单外必须被拒绝");
            assert_eq!(error.kind.as_deref(), Some("unknown_channel"));
        }
    }

    #[test]
    fn core_state_without_process_reports_core_unavailable() {
        let state = CoreState::default();
        assert!(state.shared().is_none());
        let error = require_shared(&state).expect_err("没有 sidecar 时必须报结构化错误");
        assert_eq!(error.kind.as_deref(), Some("core_unavailable"));
    }

    #[test]
    fn core_state_shutdown_is_idempotent_without_process() {
        let state = CoreState::default();
        assert!(!state.shutdown("应用退出"), "没有进程时收尸是空操作");
        assert!(!state.shutdown("应用退出"), "重复收尸必须幂等且不 panic");
    }

    #[test]
    fn shutdown_releases_the_process_slot_before_waiting_for_reap() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".tmp");
        std::fs::create_dir_all(&dir).expect("测试目录");
        let marker = dir.join(format!("r44a-exit-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let plan = crate::sidecar::LaunchPlan {
            program: std::path::PathBuf::from("node"),
            args: vec!["-e".into(), "process.stdin.resume(); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(() => process.exit(0), 800); });".into(), marker.as_os_str().to_owned()],
            source: crate::sidecar::LaunchSource::OverrideScript,
        };
        let process = Arc::new(crate::sidecar::SidecarProcess::spawn(&plan).expect("测试子进程可启动"));
        let state = Arc::new(CoreState::default());
        state.install(process);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || worker_state.shutdown("测试退出"));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !marker.exists() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
        let child_waiting = marker.exists();
        let slot_released = state.process.try_lock().is_ok();
        let started = std::time::Instant::now();
        let repeated = state.shutdown("RunEvent 兜底");
        let fallback_time = started.elapsed();
        assert!(worker.join().expect("收尸线程结束"));
        let _ = std::fs::remove_file(marker);
        assert!(child_waiting, "必须在子进程已收到 EOF 但未退出时取证");
        assert!(!repeated);
        assert!(slot_released, "等待子进程期间不得持有 process 锁");
        assert!(fallback_time < Duration::from_millis(100), "退出事件不得等待后台收尸锁：{fallback_time:?}");
    }

    #[test]
    fn renderer_ready_flag_is_recorded_once() {
        let state = CoreState::default();
        // 就绪与否只从**行为**上看（没有"读标志再自己判一次"的口子，那正是缝的形状）
        assert!(
            state
                .deliver_or_queue(emit_envelope("app:notice", json!({"text": "还没就绪"})))
                .is_none(),
            "没就绪 → 排队"
        );
        assert!(state.mark_renderer_ready_and_flush().first_time, "第一次就绪要如实报告");
        assert!(
            state
                .deliver_or_queue(emit_envelope("app:notice", json!({"text": "已就绪"})))
                .is_some(),
            "就绪之后 → 直接投递"
        );
        assert!(!state.mark_renderer_ready_and_flush().first_time, "重复调用不再是首次");
    }

    /// 旧仓缺陷：启动期 emit 发进空气 —— 代理启动提示（R6）正是这种时机，所以启动期提示要先排队，
    /// `core_renderer_ready` 时冲刷（顺序保持、只冲一次、之后就绪的直接投递）。
    #[test]
    fn startup_notices_are_queued_until_renderer_ready() {
        assert_eq!(plan_broadcast(false), BroadcastPlan::Queue);
        assert_eq!(plan_broadcast(true), BroadcastPlan::Deliver);

        let state = CoreState::default();
        assert_eq!(state.queued_notices(), 0);
        assert!(
            state
                .deliver_or_queue(emit_envelope("app:notice", json!({"text": "一"})))
                .is_none(),
            "没就绪要排队"
        );
        assert!(
            state
                .deliver_or_queue(emit_envelope("app:notice", json!({"text": "二"})))
                .is_none()
        );
        assert_eq!(state.queued_notices(), 2);

        let outcome = state.mark_renderer_ready_and_flush();
        assert_eq!(outcome.flushed.len(), 2, "就绪时必须把排队的提示全冲出去");
        assert_eq!(outcome.flushed[0].channel, "app:notice");
        assert_eq!(outcome.flushed[0].payload["text"], "一", "顺序要保持（提示的先后有意义）");
        assert_eq!(outcome.flushed[1].payload["text"], "二");
        assert_eq!(state.queued_notices(), 0);
        assert!(
            state.mark_renderer_ready_and_flush().flushed.is_empty(),
            "重复冲刷是空操作，不能重复提示"
        );

        assert!(
            state
                .deliver_or_queue(emit_envelope("app:notice", json!({"text": "三"})))
                .is_some(),
            "就绪之后的广播直接投递（进了队列就再没人冲刷）"
        );
        assert_eq!(state.queued_notices(), 0);
    }

    /// 这条钉的是 Important 3 的缝：**判定就绪与入队之间不能有第二步**。
    /// 旧写法是 `plan_broadcast(state.renderer_ready())` → `state.queue_notice(..)` 两步。
    /// 两步之间渲染层若完成 `mark_renderer_ready` + `flush_notices`，提示就 push 进那个**已经冲刷过**
    /// 的队列，而《冲刷只发生一次》，这条提示再没有人管——永远发不出去。
    /// 现在判定与入队是同一个加锁方法，把"就绪已翻"的那一刻原样交给调用方去投递。
    #[test]
    fn notice_is_not_stranded_when_readiness_flips_before_enqueue() {
        let state = CoreState::default();

        // 渲染层的「标记就绪 + 冲刷」先发生（冲刷的是空队列）
        let outcome = state.mark_renderer_ready_and_flush();
        assert!(outcome.first_time);
        assert!(outcome.flushed.is_empty());

        // 这一条必须被判成"立刻投递"：调用方拿回 envelope 直接 emit
        let delivered = state
            .deliver_or_queue(emit_envelope("app:notice", json!({"text": "启动提示"})))
            .expect("已就绪的广播必须走投递这条路（不许进队列）");
        assert_eq!(delivered.payload, json!({"text": "启动提示"}));
        assert_eq!(
            state.queued_notices(),
            0,
            "队列里留下没人冲刷的提示 = 这条提示永远发不出去"
        );
        assert!(
            state.mark_renderer_ready_and_flush().flushed.is_empty(),
            "重复冲刷不能凭空吐出提示"
        );
    }

    /// 另一侧的先后：先入队、后就绪 → 排队的一条不落，且只冲一次。
    #[test]
    fn notices_queued_before_readiness_are_flushed_exactly_once() {
        let state = CoreState::default();
        for index in 0..3 {
            assert!(
                state
                    .deliver_or_queue(emit_envelope("app:notice", json!({"n": index})))
                    .is_none(),
                "还没就绪就该排队"
            );
        }
        let outcome = state.mark_renderer_ready_and_flush();
        assert_eq!(outcome.flushed.len(), 3, "排队的提示必须全部冲出来");
        assert_eq!(outcome.flushed[1].payload["n"], json!(1), "顺序要保持（提示的先后有意义）");
        assert_eq!(state.queued_notices(), 0);
        assert!(state.mark_renderer_ready_and_flush().flushed.is_empty(), "第二次冲刷是空操作");
    }

    /// 并发交错下的守恒律（真线程，不是模拟）：任何交错都不许丢提示、也不许重复投递。
    ///
    /// `queued == 冲刷出来的条数` 是这条缝的直接表述：旧写法在这个用例下会偶发少几条
    /// （进了已冲刷过的队列）。判定与入队在同一个锁里完成之后，这是一条恒等式。
    #[test]
    fn no_notice_is_lost_or_delivered_twice_under_concurrent_readiness_flip() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::mpsc;
        use std::sync::Arc as SharedArc;

        const PUSHERS: usize = 4;
        const ROUNDS: usize = 20_000;

        let state = SharedArc::new(CoreState::default());
        let queued = SharedArc::new(AtomicUsize::new(0));
        let delivered = SharedArc::new(AtomicUsize::new(0));
        let (sender, receiver) = mpsc::channel::<usize>();

        std::thread::scope(|scope| {
            for _ in 0..PUSHERS {
                let state = SharedArc::clone(&state);
                let queued = SharedArc::clone(&queued);
                let delivered = SharedArc::clone(&delivered);
                scope.spawn(move || {
                    for index in 0..ROUNDS {
                        match state.deliver_or_queue(emit_envelope("app:notice", json!({ "n": index }))) {
                            Some(_) => {
                                delivered.fetch_add(1, AtomicOrdering::Relaxed);
                            }
                            None => {
                                queued.fetch_add(1, AtomicOrdering::Relaxed);
                            }
                        }
                    }
                });
            }
            let flipper = SharedArc::clone(&state);
            scope.spawn(move || {
                // 等队列真的攒下提示再翻就绪：保证这次交错确实跨过"就绪那一刻"
                while flipper.queued_notices() < 8 {
                    std::hint::spin_loop();
                }
                let outcome = flipper.mark_renderer_ready_and_flush();
                let _ = sender.send(outcome.flushed.len());
            });
        });

        let flushed = receiver.recv().expect("冲刷线程必须回报条数");
        let queued = queued.load(AtomicOrdering::SeqCst);
        let delivered = delivered.load(AtomicOrdering::SeqCst);

        assert_eq!(queued + delivered, PUSHERS * ROUNDS, "每条广播要么排队要么投递，不能凭空消失");
        assert!(queued > 0 && delivered > 0, "这次交错必须真的跨过就绪那一刻（queued={queued} delivered={delivered}）");
        assert_eq!(flushed, queued, "排队过的每一条都必须被冲刷出来；差额就是丢掉的提示");
        assert_eq!(state.queued_notices(), 0, "就绪之后队列必须永远为空（否则那些提示再没人冲刷）");
    }

    /// 源码扫描：广播分支只走 `emit_core_event` 这一个入口，而它内部只走 `deliver_or_queue`
    /// 这一个加锁口子——「先读就绪标志、再入队」的两步写法不许复活。
    ///
    /// R11 之前这段是"从 apply_effect 扫到 emit_now"一整段；托盘也成了广播发送方之后
    /// 把信封构造与投递收进 `emit_core_event`（唯一构造点），于是这条用例拆成两段：
    /// 上一段管"效果分支必须经唯一入口"，下一段管"唯一入口内部必须是同一个加锁方法"。
    #[test]
    fn broadcast_effect_uses_the_single_locked_entry_point() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands.rs"))
            .expect("要能读到自己的源码");

        let effect = slice_between(&source, "pub fn apply_effect", "pub fn emit_core_event");
        assert!(
            effect.contains("emit_core_event("),
            "广播分支必须经唯一构造点（信封形状与启动期排队都在那里）：{effect}"
        );

        let emitter = slice_between(&source, "pub fn emit_core_event", "fn emit_now");
        assert!(emitter.contains("deliver_or_queue("), "广播落地必须走唯一入口：{emitter}");
        assert!(
            !emitter.contains("queue_notice(") && !emitter.contains("renderer_ready()"),
            "不许再出现「先读就绪标志、再入队」的两步写法：{emitter}"
        );
    }

    /// 从 `start` 标记到 `end` 标记之间的一段源码（找不到就 panic：标记本身也是契约）。
    fn slice_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let from = source.find(start).unwrap_or_else(|| panic!("找不到 {start}"));
        let to = source[from..]
            .find(end)
            .map(|offset| from + offset)
            .unwrap_or_else(|| panic!("找不到 {start} 之后的 {end}"));
        &source[from..to]
    }

    /// 源码扫描：`core_get_tray_available` 是 tauri 命令、挂主窗来源守卫、且用的是**活的托盘事实**
    /// （`tray::available` 现问 tauri 的托盘表），不是第二份自己记的镜像。
    #[test]
    fn tray_availability_command_is_guarded_and_reads_the_live_fact() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands.rs"))
            .expect("要能读到自己的源码");
        let body = slice_between(
            &source,
            "#[tauri::command]\npub fn core_get_tray_available",
            "\n#[cfg(test)]",
        );
        assert!(body.contains("require_main_webview("), "托盘可用性也要过主窗来源守卫：{body}");
        assert!(
            body.contains("crate::tray::available("),
            "可用性必须现问托盘表（自己记一份镜像只会漂移）：{body}"
        );
    }

    #[test]
    fn host_channels_are_all_routable() {
        for channel in HOST_REQUEST_CHANNELS {
            assert_ne!(
                route_host_request(channel),
                HostRoute::Unknown,
                "{channel} 必须在宿主要求路由表里"
            );
        }
        for channel in ["host:not-a-channel", "auth:login", "core:event"] {
            assert_eq!(route_host_request(channel), HostRoute::Unknown, "{channel} 不是宿主要求频道");
        }
    }

    #[test]
    fn plan_notify_requires_text() {
        match plan_host_request("r1", "host:notify", &json!({"text": "已复制链接"})) {
            HostPlan::Notify { text, ack } => {
                assert_eq!(text, "已复制链接");
                assert_eq!(ack.id, "r1");
                assert!(ack.ok, "通知送达后必须回 ok 响应帧");
            }
            other => panic!("host:notify 应走系统通知，实际 {other:?}"),
        }

        for payload in [json!({}), json!({"text": ""}), json!({"text": "   "}), json!({"text": 42})] {
            match plan_host_request("r2", "host:notify", &payload) {
                HostPlan::Respond(frame) => {
                    assert!(!frame.ok);
                    assert_eq!(
                        frame.error.expect("必须带结构化错误").kind.as_deref(),
                        Some("invalid_payload")
                    );
                }
                other => panic!("坏 payload 必须回结构化错误，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn plan_open_login_rejects_bad_config_before_touching_the_window() {
        // 坏配置在**计划阶段**就被挡掉：不该先起线程再失败（用户看到的是"点了没反应"）
        match plan_host_request("r3", "host:open-login", &json!({})) {
            HostPlan::Respond(frame) => {
                assert!(!frame.ok);
                let error = frame.error.expect("必须带结构化错误");
                assert_eq!(error.kind.as_deref(), Some("invalid_payload"));
                assert!(
                    error.message.contains("url") || error.message.contains("topInset"),
                    "错误要指明缺了哪个字段：{}",
                    error.message
                );
            }
            other => panic!("坏配置必须在计划阶段被拒，实际 {other:?}"),
        }

        // 合法配置 → Deferred：答复交给登录窗线程（它在窗收场之后写这一帧）
        // R32：白名单换成参考实测的授权入口域，这里的 URL 也要跟着换（否则会被当"不在白名单"拒掉）
        let good = json!({
            "url": "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize?client_id=101444301",
            "partition": "p-1",
            "topInset": 48,
        });
        assert_eq!(plan_host_request("r4", "host:open-login", &good), HostPlan::Deferred);
    }

    #[test]
    fn plan_cancel_login_is_a_runtime_decision() {
        // 取消的答复里要带"到底取消掉了没有"，那个答案要读运行时状态
        assert_eq!(plan_host_request("r5", "host:cancel-login", &json!({})), HostPlan::CancelLogin);
        assert_eq!(route_host_request("host:cancel-login"), HostRoute::CancelLogin);
    }

    #[test]
    fn host_secure_channels_route_to_secure_store() {
        assert_eq!(route_host_request("host:secure-encrypt"), HostRoute::SecureEncrypt);
        assert_eq!(route_host_request("host:secure-decrypt"), HostRoute::SecureDecrypt);
    }

    #[test]
    fn plan_secure_requests_reject_bad_payload_before_touching_backend() {
        for payload in [
            json!({}),
            json!({"plaintext": ""}),
            json!({"plaintext": 42}),
            json!({"plaintext": null}),
        ] {
            match plan_host_request("r5", "host:secure-encrypt", &payload) {
                HostPlan::Respond(frame) => {
                    assert!(!frame.ok, "坏 payload 不该成功：{payload}");
                    let error = frame.error.expect("必须带结构化错误");
                    assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "payload={payload}");
                    assert!(error.message.contains("plaintext"), "{}", error.message);
                }
                other => panic!("坏 payload 必须回结构化错误，实际 {other:?}"),
            }
        }

        for payload in [json!({}), json!({"cipher": ""}), json!({"cipher": 42})] {
            match plan_host_request("r5", "host:secure-decrypt", &payload) {
                HostPlan::Respond(frame) => {
                    assert!(!frame.ok, "坏 payload 不该成功：{payload}");
                    let error = frame.error.expect("必须带结构化错误");
                    assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "payload={payload}");
                    assert!(error.message.contains("cipher"), "{}", error.message);
                }
                other => panic!("坏 payload 必须回结构化错误，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn plan_secure_decrypt_reports_invalid_cipher_without_echoing_it() {
        // 合法 base64、但不是 DPAPI 信封：解不开也不许 panic、不许回显
        let foreign = "ZGVhZGJlZWYwMTAyMDM=";
        match plan_host_request("r8", "host:secure-decrypt", &json!({ "cipher": foreign })) {
            HostPlan::Respond(frame) => {
                assert!(!frame.ok);
                let error = frame.error.expect("必须带结构化错误");
                assert!(
                    matches!(
                        error.kind.as_deref(),
                        Some("invalid_cipher") | Some("secure_store_unavailable")
                    ),
                    "外来信封只能是 invalid_cipher 或（非 Windows）不可用：{:?}",
                    error.kind
                );
                assert!(!error.message.contains(foreign), "错误里不能回显密文：{}", error.message);
                assert!(!error.message.contains("ZGVh"), "错误里不能回显密文片段");
            }
            other => panic!("外来信封必须回结构化错误，实际 {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn plan_secure_encrypt_decrypt_round_trips_through_host_route() {
        let secret = "{\"musicSession\":\"user$7f3a\"}";
        let cipher = match plan_host_request("r6", "host:secure-encrypt", &json!({"plaintext": secret})) {
            HostPlan::Respond(frame) => {
                assert!(frame.ok, "Windows 上加密必须成功：{:?}", frame.error);
                frame.data.expect("加密必须回数据")["cipher"]
                    .as_str()
                    .expect("加密响应必须带 cipher 字段")
                    .to_string()
            }
            other => panic!("加密应直接回一帧，实际 {other:?}"),
        };
        assert_ne!(cipher, secret, "密文不能等于明文");
        assert!(!cipher.contains("musicSession"), "密文里不该有明文片段");

        match plan_host_request("r7", "host:secure-decrypt", &json!({"cipher": cipher})) {
            HostPlan::Respond(frame) => {
                assert!(frame.ok, "自己封的信封必须能解回来：{:?}", frame.error);
                assert_eq!(
                    frame.data.expect("解密必须回数据")["plaintext"],
                    json!(secret),
                    "往返必须还原原文"
                );
            }
            other => panic!("解密应直接回一帧，实际 {other:?}"),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn plan_secure_encrypt_is_unavailable_on_non_windows_without_plaintext_fallback() {
        match plan_host_request("r6", "host:secure-encrypt", &json!({"plaintext": "secret"})) {
            HostPlan::Respond(frame) => {
                assert!(!frame.ok, "非 Windows 不允许'成功'");
                assert_eq!(
                    frame.error.expect("必须带结构化错误").kind.as_deref(),
                    Some("secure_store_unavailable")
                );
                assert!(frame.data.is_none(), "失败帧不得携带任何数据（尤其不能是明文）");
            }
            other => panic!("非 Windows 必须回结构化不可用，实际 {other:?}"),
        }
    }

    #[test]
    fn plan_unknown_channel_is_unknown_channel_error() {
        match plan_host_request("r4", "host:not-a-channel", &json!({})) {
            HostPlan::Respond(frame) => {
                assert!(!frame.ok);
                let error = frame.error.expect("必须带结构化错误");
                assert_eq!(error.kind.as_deref(), Some("unknown_channel"));
                assert!(error.message.contains("host:not-a-channel"));
            }
            other => panic!("未知宿主要求频道必须回结构化错误，实际 {other:?}"),
        }
    }

    #[test]
    fn emit_envelope_carries_channel_and_payload() {
        let envelope = emit_envelope("auth:state", json!({"loggedIn": true}));
        assert_eq!(envelope.channel, "auth:state");
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({"channel": "auth:state", "payload": {"loggedIn": true}}),
            "渲染层拿到的漏斗事件载荷形如 {{channel, payload}}"
        );
    }

    // -----------------------------------------------------------------------
    // 开机自启（R10）：只测判定逻辑，**绝不碰本机注册表**
    // -----------------------------------------------------------------------

    /// 假的自启后端：记录调用顺序，可分别让"写"或"读"失败。
    ///
    /// `ignore_write` 模拟"调用没报错，但系统没真的改"（策略挡回、注册表被改写）——
    /// 这正是"必须回读实际状态"那条规矩要抓的情形。
    #[derive(Default)]
    struct FakeAutostart {
        enabled: std::cell::Cell<bool>,
        ignore_write: bool,
        fail_write: bool,
        fail_read: bool,
        calls: std::cell::RefCell<Vec<&'static str>>,
    }

    impl FakeAutostart {
        fn note(&self, step: &'static str) {
            self.calls.borrow_mut().push(step);
        }
    }

    impl AutoStart for FakeAutostart {
        fn enable(&self) -> Result<(), String> {
            self.note("enable");
            if self.fail_write {
                return Err("注册表写入被拒绝".to_string());
            }
            if !self.ignore_write {
                self.enabled.set(true);
            }
            Ok(())
        }

        fn disable(&self) -> Result<(), String> {
            self.note("disable");
            if self.fail_write {
                return Err("注册表写入被拒绝".to_string());
            }
            if !self.ignore_write {
                self.enabled.set(false);
            }
            Ok(())
        }

        fn is_enabled(&self) -> Result<bool, String> {
            self.note("is_enabled");
            if self.fail_read {
                return Err("读取注册表被拒绝".to_string());
            }
            Ok(self.enabled.get())
        }
    }

    #[test]
    fn autostart_writes_then_reads_back_the_real_state() {
        let manager = FakeAutostart::default();
        assert_eq!(apply_autostart(true, &manager), Ok(true));
        assert_eq!(
            manager.calls.borrow().as_slice(),
            ["enable", "is_enabled"],
            "先写再读：反过来报的就是写入前的旧状态"
        );

        let manager = FakeAutostart {
            enabled: std::cell::Cell::new(true),
            ..Default::default()
        };
        assert_eq!(apply_autostart(false, &manager), Ok(false));
        assert_eq!(manager.calls.borrow().as_slice(), ["disable", "is_enabled"]);
    }

    /// 旧仓缺陷的形状：把"这次调用没报错"当成"已经打开了"。
    #[test]
    fn autostart_reports_the_observed_state_not_the_request() {
        let manager = FakeAutostart {
            ignore_write: true,
            ..Default::default()
        };
        assert_eq!(
            apply_autostart(true, &manager),
            Ok(false),
            "写入没生效时不许回 true（否则界面一直显示一个不存在的「已开启」）"
        );
    }

    #[test]
    fn autostart_write_failure_is_structured_and_does_not_report_success() {
        let manager = FakeAutostart {
            fail_write: true,
            ..Default::default()
        };
        let error = apply_autostart(true, &manager).expect_err("写入失败必须报错");
        assert_eq!(error.kind.as_deref(), Some("internal"));
        assert!(error.message.contains("注册表写入被拒绝"), "{}", error.message);
        assert!(error.message.starts_with("开机自启设置失败"), "{}", error.message);
        assert_eq!(
            manager.calls.borrow().as_slice(),
            ["enable"],
            "写入失败就不该再去回读（那只会把一次失败变成两条噪声）"
        );
    }

    #[test]
    fn autostart_read_failure_is_structured() {
        let manager = FakeAutostart {
            fail_read: true,
            ..Default::default()
        };
        for result in [
            apply_autostart(false, &manager),
            read_autostart(&manager),
        ] {
            let error = result.expect_err("读不到状态必须报错，不许猜一个「关闭」");
            assert_eq!(error.kind.as_deref(), Some("internal"));
            assert!(error.message.contains("读取注册表被拒绝"), "{}", error.message);
        }
    }

    #[test]
    fn autostart_read_reports_what_the_system_says() {
        assert_eq!(read_autostart(&FakeAutostart::default()), Ok(false));
        let on = FakeAutostart {
            enabled: std::cell::Cell::new(true),
            ..Default::default()
        };
        assert_eq!(read_autostart(&on), Ok(true));
    }

    // ---- R44e：持久化准入 ---------------------------------------------------------

    /// 准入矩阵（纯函数）：只有"退出准备中的渲染层写"与"正在不可逆清理"被拒，
    /// 内部保存/退出 drain 在准备阶段仍然收。
    #[test]
    fn r44e_persist_admission_freezes_only_new_renderer_writes() {
        assert_eq!(decide_persist_admission(PersistPhase::Running, PersistKind::Renderer), Ok(()));
        assert_eq!(decide_persist_admission(PersistPhase::Running, PersistKind::Internal), Ok(()));
        assert_eq!(decide_persist_admission(PersistPhase::PreparingExit, PersistKind::Internal), Ok(()));
        let frozen = decide_persist_admission(PersistPhase::PreparingExit, PersistKind::Renderer)
            .expect_err("退出准备中不再受理新的渲染层写");
        assert_eq!(frozen.kind.as_deref(), Some("shutting_down"));
        for kind in [PersistKind::Renderer, PersistKind::Internal] {
            let exiting = decide_persist_admission(PersistPhase::Exiting, kind).expect_err("不可逆清理中不写盘");
            assert_eq!(exiting.kind.as_deref(), Some("shutting_down"));
        }
    }

    /// 冻结与受理在**同一个临界区**：准备开始之后到的写拿到的是 prepared 状态（不是"先查 Running 再排队"）。
    /// 凭据活着的期间 `wait_drained` 必须为假——退出等的是"没有在飞的写"，不是"没人等结果"。
    #[test]
    fn r44e_gate_counts_in_flight_writes_and_refuses_after_prepare() {
        let gate = Arc::new(PersistenceGate::new());
        assert_eq!(gate.phase(), PersistPhase::Running);

        let held = gate.admit(PersistKind::Renderer).expect("运行中受理");
        assert_eq!(gate.in_flight(), 1);
        assert!(!gate.wait_drained(std::time::Instant::now() + std::time::Duration::from_millis(20)), "在飞时不算排空");

        gate.begin_prepare();
        assert_eq!(gate.phase(), PersistPhase::PreparingExit);
        assert!(gate.admit(PersistKind::Renderer).is_err(), "冻结后拒新渲染层写");
        let internal = gate.admit(PersistKind::Internal).expect("退出 drain 的内部写仍受理");
        assert_eq!(gate.in_flight(), 2);

        drop(held);
        drop(internal);
        assert_eq!(gate.in_flight(), 0);
        assert!(gate.wait_drained(std::time::Instant::now() + std::time::Duration::from_millis(20)), "落定即排空");

        // 准备失败 → 复位 Running，下一次 Quit 能再试
        gate.abort_prepare();
        assert_eq!(gate.phase(), PersistPhase::Running);
        assert!(gate.admit(PersistKind::Renderer).is_ok());

        // 准备成功后进入不可逆清理：内部写也拒
        gate.begin_exit();
        assert!(gate.admit(PersistKind::Internal).is_err());
        gate.abort_prepare();
        assert_eq!(gate.phase(), PersistPhase::Exiting, "不可逆清理阶段不能被复位成 Running");
    }

    /// R44e fix1 / review finding 4：内部 settings 调用只能拿**整个退出准备剩下的**时间。
    ///
    /// 修复前 uncertain 重存与最终 `settings:get` 各自另起一个 10 秒等待：4 秒预算之外的
    /// 两段等待合起来还能把"有界退出"拖到 20 秒。这里钉的是"剩余预算才是上限，没预算就立刻失败"。
    #[test]
    fn fix4_a_settings_call_never_gets_more_time_than_the_exit_budget_that_is_left() {
        let now = std::time::Instant::now();
        let cap = std::time::Duration::from_secs(SETTINGS_CALL_TIMEOUT_SECS);
        let deadline = now + std::time::Duration::from_millis(400);

        assert_eq!(
            call_timeout_within(deadline, now, cap).expect("还有预算"),
            std::time::Duration::from_millis(400),
            "只剩 400ms 就只拿 400ms（不另起 10 秒）"
        );
        assert_eq!(
            call_timeout_within(deadline, now + std::time::Duration::from_millis(150), cap).expect("还有预算"),
            std::time::Duration::from_millis(250),
            "预算随时间推进缩小"
        );

        let exhausted = call_timeout_within(deadline, deadline, cap).expect_err("没有预算就不许再起一笔等待");
        assert_eq!(exhausted.kind.as_deref(), Some("timeout"), "结构化失败（走既有的可逆 abort）");
        assert!(call_timeout_within(deadline, deadline + std::time::Duration::from_millis(1), cap).is_err());

        assert_eq!(
            call_timeout_within(now + std::time::Duration::from_secs(60), now, cap).expect("预算充裕"),
            cap,
            "预算比单笔上限还多时仍受单笔上限约束"
        );
    }

    /// 保留键闸门：`settings:set` 不许直接 patch `theme` / `lyricsWindow`，其余载荷原样放过。
    #[test]
    fn r44e_reserved_settings_keys_cannot_be_patched_through_core_call() {
        for key in ["theme", "lyricsWindow"] {
            let payload = json!({ "patch": { (key): "dark" } });
            let error = reject_reserved_settings_keys(SETTINGS_SET_CHANNEL, &payload)
                .expect_err("保留键必须被拒");
            assert_eq!(error.kind.as_deref(), Some("forbidden_source"), "键：{key}");
            assert!(error.message.contains(key), "错误要点名是哪个键：{}", error.message);
        }
        let mixed = json!({ "patch": { "proxy": { "enabled": true }, "lyricsWindow": {} } });
        assert!(reject_reserved_settings_keys(SETTINGS_SET_CHANNEL, &mixed).is_err(), "混合载荷里带保留键也要拒");

        for allowed in [
            json!({ "patch": { "proxy": { "enabled": false } } }),
            json!({ "patch": { "closeBehavior": "quit" } }),
            json!({ "patch": { "queue": { "ids": [] } } }),
            json!({ "patch": { "futureKey": 7 } }),
            json!({ "reset": true }),
            Value::Null,
        ] {
            assert_eq!(reject_reserved_settings_keys(SETTINGS_SET_CHANNEL, &allowed), Ok(()), "载荷：{allowed}");
        }
        // 其他频道不受这条闸门影响（例如 settings:get）
        assert_eq!(
            reject_reserved_settings_keys(SETTINGS_GET_CHANNEL, &json!({ "patch": { "theme": "dark" } })),
            Ok(())
        );
    }

    // ---- R44e fix2：同步写帧也能拖穿退出预算（review round 2 finding 2）-------------

    /// 一个"写进去就停住"的管道：真的会阻塞的 `Write`。
    ///
    /// 生产里的 `CoreShared::write_line` 是**同步**的（锁写入端 → `write_all` → `flush`）：
    /// 对端管道堵住时它就停在 `write` 里。给 `recv_timeout` 一个 timeout 对这一段毫无作用——
    /// 这正是 finding 2 说的"deadline 只限制了等回执"。
    #[derive(Clone)]
    struct BlockingWriter {
        entered: Arc<(Mutex<bool>, std::sync::Condvar)>,
        release: Arc<(Mutex<bool>, std::sync::Condvar)>,
        written: Arc<Mutex<Vec<u8>>>,
    }

    impl BlockingWriter {
        fn new() -> Self {
            Self {
                entered: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
                release: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
                written: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// 写帧那一步真的已经进来了（不是"调用方还没开始就超时了"）。
        fn write_entered(&self) -> bool {
            *self.entered.0.lock().unwrap()
        }

        fn release(&self) {
            *self.release.0.lock().unwrap() = true;
            self.release.1.notify_all();
        }

        fn written(&self) -> String {
            String::from_utf8_lossy(&self.written.lock().unwrap()).to_string()
        }
    }

    impl std::io::Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            {
                let mut entered = self.entered.0.lock().unwrap();
                *entered = true;
                self.entered.1.notify_all();
            }
            // 对端管道堵住：一直停在这里，直到测试放行（10 秒兜底，免得测试自己挂死）
            let released = self.release.0.lock().unwrap();
            let _ = self
                .release
                .1
                .wait_timeout_while(released, Duration::from_secs(10), |done| !*done);
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// R44e fix2 / review round 2 finding 2：写帧被堵住时，调用方仍必须在**自己的**期限上回来。
    ///
    /// 修复前 `settings_write_owned_within` 只把时间上限交给 `CoreShared::call` 的 `recv_timeout`，
    /// 而同步写帧在它之前，可以先把整个退出预算吃掉。这里用真的会阻塞的 `Write`：调用方必须按
    /// deadline（200ms）返回结构化 `timeout`，而**迟到的那一笔仍然算在准入账上**——退出不可能
    /// 在"可能已发出的迟到写"落定之前成功，也不会出现"退出成功之后才写盘"。
    #[test]
    fn fix2_a_blocked_bridge_write_still_returns_by_the_exit_deadline() {
        let writer = BlockingWriter::new();
        let shared = CoreShared::new(Box::new(writer.clone()));
        let gate = Arc::new(PersistenceGate::new());
        let admission = gate.admit(PersistKind::Internal).expect("退出 drain 的内部写仍受理");
        let deadline = std::time::Instant::now() + Duration::from_millis(200);

        let began = std::time::Instant::now();
        let result = call_owned_within(
            Arc::clone(&shared),
            SETTINGS_SET_CHANNEL,
            json!({ "patch": { "queue": { "volume": 50 } } }),
            deadline,
            // 单笔上限比预算宽松：证明卡住调用方的是 deadline，不是 cap
            Duration::from_secs(2),
            Some(admission),
        );
        let elapsed = began.elapsed();

        let error = result.expect_err("写被堵住时必须在预算内返回，不许陪着同步写一起等");
        assert_eq!(
            error.kind.as_deref(),
            Some("timeout"),
            "结构化超时（主题留 uncertain、退出走可逆 abort 都认这一码）"
        );
        assert!(
            elapsed < Duration::from_secs(1),
            "调用方必须按 deadline 回来（上限 1 秒，实际 {elapsed:?}）"
        );
        assert!(writer.write_entered(), "卡住的正是同步写帧那一步（不是还没开始就超时）");

        // 迟到的写仍在准入账上：`wait_drained` 为假 = 退出不可能在它落定之前成功
        assert_eq!(gate.in_flight(), 1, "超时返回不许把这一笔的准入一起放掉");
        assert!(
            !gate.wait_drained(std::time::Instant::now() + Duration::from_millis(80)),
            "迟到写没落定之前，退出必须被它挡住"
        );

        // 放行：那一帧真的写出去（不是被扔掉的幻影），之后准入才落定
        writer.release();
        assert!(
            gate.wait_drained(std::time::Instant::now() + Duration::from_secs(5)),
            "迟到写有结论之后才排空"
        );
        assert_eq!(gate.in_flight(), 0);
        let frame = writer.written();
        assert!(frame.contains(SETTINGS_SET_CHANNEL), "迟到的那一帧确实发出去了：{frame}");
        assert!(frame.contains("\"volume\":50"), "发出去的是那一笔写（载荷没被篡改）：{frame}");
    }

    /// 最终 `settings:get` 屏障走同一条路：读被堵住时也必须在同一个期限上回来（读没有准入，
    /// 这里钉的是"调用方按 deadline 返回"这一半）。
    #[test]
    fn fix2_the_final_settings_barrier_returns_by_the_same_deadline() {
        let writer = BlockingWriter::new();
        let shared = CoreShared::new(Box::new(writer.clone()));
        let deadline = std::time::Instant::now() + Duration::from_millis(150);

        let began = std::time::Instant::now();
        let error = call_owned_within(
            shared,
            SETTINGS_GET_CHANNEL,
            Value::Null,
            deadline,
            Duration::from_secs(2),
            None,
        )
        .expect_err("读被堵住也要有界返回");
        let elapsed = began.elapsed();

        assert_eq!(error.kind.as_deref(), Some("timeout"));
        assert!(
            elapsed < Duration::from_secs(1),
            "屏障读必须按 deadline 回来（上限 1 秒，实际 {elapsed:?}）"
        );
        assert!(writer.write_entered(), "卡住的正是同步写帧那一步");
        writer.release(); // 收尸：让后台那一笔有结论，别把 10 秒兜底留给下一条用例
    }

    /// `settings:set` 回执里取键值：形状认不出回 None（调用方必须走 uncertain，而不是假成功）。
    #[test]
    fn r44e_settings_receipt_reading_never_guesses() {
        let answer = json!({ "settings": { "schemaVersion": 1, "data": { "theme": "dark", "lyricsWindow": { "style": "panel" } } } });
        assert_eq!(settings_receipt_value(&answer, "theme"), Some(&json!("dark")));
        assert_eq!(settings_receipt_value(&answer, "lyricsWindow"), Some(&json!({ "style": "panel" })));
        assert_eq!(settings_receipt_value(&answer, "missing"), None);
        for junk in [json!(null), json!({}), json!({ "settings": null }), json!({ "settings": { "data": [] } })] {
            assert_eq!(settings_receipt_value(&junk, "theme"), None, "载荷：{junk}");
        }
    }
}
