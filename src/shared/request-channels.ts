/**
 * 请求频道白名单的唯一真源（Node 与渲染层 import 同一模块）。
 *
 * 两侧镜像：
 * - Node：src/host/dispatcher.mjs 按 `REQUEST_CHANNELS` 路由，白名单外一律结构化 `unknown_channel`；
 * - Rust：src-tauri/src/commands.rs 用同名字符串字面量做 `core_call` 准入；
 *   test/channel-parity.test.mjs 扫描两侧源码，集合必须相等（防双份漂移）。
 *
 * 需要新频道时往这里增补，不要另立清单。
 */

/** 渲染层 → core 的请求频道（`core_call` 唯一业务通道）。 */
export const AUTH_LOGIN = "auth:login" as const;
export const AUTH_LOGOUT = "auth:logout" as const;
export const AUTH_CANCEL_LOGIN = "auth:cancel-login" as const;
export const SETTINGS_GET = "settings:get" as const;
export const SETTINGS_SET = "settings:set" as const;

export const REQUEST_CHANNELS = [
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_CANCEL_LOGIN,
  SETTINGS_GET,
  SETTINGS_SET,
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export function isRequestChannel(channel: string): channel is RequestChannel {
  return (REQUEST_CHANNELS as readonly string[]).includes(channel);
}

/** core → 宿主的宿主要求频道。R3 只实现 `host:notify`；其余由 R5/R7 实现（见 commands.rs 路由表）。 */
export const HOST_OPEN_LOGIN = "host:open-login" as const;
export const HOST_SECURE_ENCRYPT = "host:secure-encrypt" as const;
export const HOST_SECURE_DECRYPT = "host:secure-decrypt" as const;
export const HOST_NOTIFY = "host:notify" as const;

export const HOST_REQUEST_CHANNELS = [
  HOST_OPEN_LOGIN,
  HOST_SECURE_ENCRYPT,
  HOST_SECURE_DECRYPT,
  HOST_NOTIFY,
] as const;

export type HostRequestChannel = (typeof HOST_REQUEST_CHANNELS)[number];

export function isHostRequestChannel(channel: string): channel is HostRequestChannel {
  return (HOST_REQUEST_CHANNELS as readonly string[]).includes(channel);
}
