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

export const BROADCAST_CHANNELS = [APP_NOTICE] as const;

export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];
