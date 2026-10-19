//! tauri 命令面：`core_call`（唯一业务通道 + 主窗来源守卫 + 请求频道准入）、`core_renderer_ready`
//! （渲染层就绪钩子），以及宿主要求路由（`host:notify` 走系统通知；R5/R7 的频道如实回未实现）。
//!
//! 判定逻辑刻意抽成纯函数（`require_main_window` / `require_request_channel` / `plan_host_request`），
//! 这样不依赖 `tauri::test` mock runtime 就能钉住来源守卫与路由表。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Window};

use crate::bridge::{CoreError, CoreShared, Effect, ResponseFrame, CALL_TIMEOUT_SECS, CORE_EVENT};
use crate::sidecar::SidecarProcess;
use crate::MAIN_WINDOW_LABEL;

/// 渲染层 → core 的请求频道白名单。
///
/// 这是刻意与 src/shared/request-channels.ts 同源的镜像副本（Rust 无法 import TS）：
/// test/channel-parity.test.mjs 扫描两侧源码，集合必须相等——改这里就必须同步改那里。
pub const REQUEST_CHANNELS: &[&str] = &[
    "auth:login",
    "auth:logout",
    "auth:cancel-login",
    "settings:get",
    "settings:set",
];

/// core → 宿主 的宿主要求频道（与 src/shared/request-channels.ts 的 HOST_REQUEST_CHANNELS 同源）。
pub const HOST_REQUEST_CHANNELS: &[&str] =
    &["host:open-login", "host:secure-encrypt", "host:secure-decrypt", "host:notify"];

/// 主窗来源守卫：只有主窗能调 `core_call`（登录子窗、歌词窗、托盘一律拒绝）。
pub fn require_main_window(label: &str) -> Result<(), CoreError> {
    if label == MAIN_WINDOW_LABEL {
        return Ok(());
    }
    Err(CoreError::new(
        "forbidden_source",
        format!("core_call 只接受主窗调用（来源：{label}）"),
    ))
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

/// 托管状态：当前 core（sidecar）进程。None = 未启动或已收尸。
#[derive(Default)]
pub struct CoreState {
    process: Mutex<Option<Arc<SidecarProcess>>>,
    renderer_ready: AtomicBool,
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
        match lock(&self.process).take() {
            Some(process) => {
                process.terminate(reason);
                true
            }
            None => false,
        }
    }

    /// 渲染层就绪标志（启动期提示队列的冲刷前提，队列本体 R7+ 再建）。
    pub fn mark_renderer_ready(&self) {
        self.renderer_ready.store(true, Ordering::SeqCst);
    }

    pub fn renderer_ready(&self) -> bool {
        self.renderer_ready.load(Ordering::SeqCst)
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
    /// 通道已留、实现留给后续任务（值 = 任务号）
    Unimplemented(&'static str),
    /// 已有人负责答复：绝不再写第二次（R7 起 open-login 会在登录窗关闭后才答复）。
    ///
    /// R3 里没有任何路由会走到它——这是刻意留出的扩展点，所以显式标注允许"暂时无构造点"。
    #[allow(dead_code)]
    Deferred,
    Unknown,
}

pub fn route_host_request(channel: &str) -> HostRoute {
    match channel {
        "host:notify" => HostRoute::Notify,
        "host:open-login" => HostRoute::Unimplemented("R7"),
        "host:secure-encrypt" | "host:secure-decrypt" => HostRoute::Unimplemented("R5"),
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
    /// 已有人负责答复，调用方不得再写
    Deferred,
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
        HostRoute::Unimplemented(task) => HostPlan::Respond(ResponseFrame::err(
            id,
            CoreError::new(
                "unimplemented",
                format!("宿主要求 {channel} 尚未实现（由 {task} 实现），本任务只留了通道"),
            ),
        )),
        HostRoute::Deferred => HostPlan::Deferred,
        HostRoute::Unknown => HostPlan::Respond(ResponseFrame::err(
            id,
            CoreError::new(
                "unknown_channel",
                format!("未知宿主要求频道：{channel}"),
            ),
        )),
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
        Effect::Emit { channel, payload } => {
            let envelope = emit_envelope(&channel, payload);
            if let Err(source) = app.emit(CORE_EVENT, envelope) {
                log::warn!("向渲染层广播 {channel} 失败：{source}");
            }
        }
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

/// 宿主要求路由：系统通知已接通；R5/R7 的频道如实回结构化未实现（不 panic、不静默）。
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
            log::info!("宿主要求 {channel} 交由他人答复（本桥不再写第二次）");
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
pub fn shutdown_core(app: &AppHandle, reason: &str) {
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
    window: Window,
    channel: String,
    payload: Option<Value>,
) -> Result<Value, CoreError> {
    require_main_window(window.label())?;
    require_request_channel(&channel)?;

    let state = app.state::<Arc<CoreState>>().inner().clone();
    let shared = require_shared(&state)?;
    let payload = payload.unwrap_or(Value::Null);
    let call = tauri::async_runtime::spawn_blocking(move || {
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

/// 渲染层就绪通知：启动期提示队列的冲刷钩子。
///
/// 返回值 = 本次冲刷的提示条数。R3 恒为 0：队列本体在 R7+ 真正需要时再建
/// （旧仓缺陷：渲染层就绪前 emit 的提示发进空气）。
#[tauri::command]
pub fn core_renderer_ready(window: Window, state: State<'_, Arc<CoreState>>) -> Result<u32, CoreError> {
    require_main_window(window.label())?;
    let first_time = !state.renderer_ready();
    state.mark_renderer_ready();
    if first_time {
        log::info!("渲染层就绪：core_renderer_ready 已登记（提示队列本体在 R7+ 建立）");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn main_window_guard_allows_only_main() {
        assert!(require_main_window(crate::MAIN_WINDOW_LABEL).is_ok());
        for label in [crate::LYRICS_WINDOW_LABEL, "login", "tray", ""] {
            let error = require_main_window(label).expect_err("非主窗来源必须被拒绝");
            assert_eq!(error.kind.as_deref(), Some("forbidden_source"));
            assert!(error.message.contains(label), "错误应指明来源：{}", error.message);
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
    fn renderer_ready_flag_is_recorded_once() {
        let state = CoreState::default();
        assert!(!state.renderer_ready());
        state.mark_renderer_ready();
        assert!(state.renderer_ready());
        state.mark_renderer_ready();
        assert!(state.renderer_ready());
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
    fn plan_unimplemented_channels_are_structured_errors() {
        for (channel, task) in [
            ("host:open-login", "R7"),
            ("host:secure-encrypt", "R5"),
            ("host:secure-decrypt", "R5"),
        ] {
            match plan_host_request("r3", channel, &json!({})) {
                HostPlan::Respond(frame) => {
                    assert!(!frame.ok);
                    let error = frame.error.expect("必须带结构化错误");
                    assert_eq!(error.kind.as_deref(), Some("unimplemented"));
                    assert!(error.message.contains(task), "{} 应指明由 {task} 实现", error.message);
                }
                other => panic!("{channel} 在 R3 必须回未实现，实际 {other:?}"),
            }
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
}
