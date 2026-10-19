/**
 * 广播频道与桥内部事件名的唯一真源（Node sidecar 与渲染层 import 同一模块）。
 *
 * Rust 侧 src-tauri/src/bridge.rs 用同名字符串字面量镜像这两项（Rust 无法 import TS），
 * 由 test/channel-parity.test.mjs 扫描源码钉住两侧一致——改这里就必须同步改那里。
 */

/** 渲染层订阅的唯一 Tauri 事件名（漏斗事件）：载荷形如 `{channel, payload}`。 */
export const CORE_EVENT = "core:event";

/**
 * sidecar 允许广播给渲染层的频道白名单（Rust 侧 `Effect::Emit` 的准入集合）。
 *
 * 初始集合由控制器裁决为 `app:notice`（R3 尚无真实广播，它是 R4+ 的第一个广播频道；
 * 白名单一旦为空，sidecar 的任何广播都会被当成白名单外帧丢掉）。R4+ 每新增一个广播频道
 * 都往这里增补，不另立清单。
 */
export const APP_NOTICE = "app:notice" as const;

/**
 * 登录状态广播（R7 增补）：`{loggedIn: boolean, busy: boolean, message?: string}`。
 *
 * 为什么是独立频道而不是复用 `app:notice`：`app:notice` 的语义是"给用户看的提示文案"，
 * 而登录状态是**状态**——渲染层的门禁与 R8 主界面靠它决定"该显示哪一层"，
 * 把状态塞进提示文案里，早晚要靠解析文案来判状态。
 *
 * 为什么结论走广播而不是 `core_call` 的返回值：渲染层那条调用链有 60 秒上限
 * （Rust `CALL_TIMEOUT_SECS`），而扫码要等好几分钟——`auth:login` 只回"已受理"，
 * 真正的结论（含失败原因与文案）经这里送达。渲染层也不必猜：`busy` 是宿主的登录状态。
 *
 * 启动期的那一条也会经 Rust 的 NoticeQueue 排队（渲染层就绪后冲刷），所以"渲染层还没订阅"
 * 不会丢掉"已登录"这个事实。
 */
export const AUTH_STATUS = "auth:status" as const;

export const BROADCAST_CHANNELS = [APP_NOTICE, AUTH_STATUS] as const;

export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];
