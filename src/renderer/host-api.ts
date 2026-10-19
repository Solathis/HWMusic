/**
 * 渲染层唯一的宿主桥封装（R3 交付封装与类型；R10 增补开机自启）。
 *
 * 边界：渲染层拿到的是白名单方法，拿不到任何 Token——凭据与业务 HTTP 只在 sidecar/Rust。
 * 这里只做两件事：把 `core_call` 包成带类型的调用、把漏斗事件 `core:event` 包成按频道过滤的订阅。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { CORE_CALL, CORE_GET_AUTOSTART, CORE_RENDERER_READY, CORE_SET_AUTOSTART } from "../shared/commands.ts";
import { CORE_EVENT } from "../shared/channels.ts";
import type { CoreError } from "../shared/result.ts";
import type { RequestChannel } from "../shared/request-channels.ts";

/** Rust `CoreError` 的渲染层镜像：只带 message（+ 可选 kind），没有堆栈与原始载荷。 */
export type CoreCallError = CoreError;

/** 漏斗事件的线上载荷：一个事件名，按 channel 分流。 */
export interface CoreEventEnvelope<T = unknown> {
  channel: string;
  payload: T;
}

export interface DesktopBridge {
  /** 调 sidecar 的白名单请求频道；失败抛出 `CoreError` 形状的对象（不是 Error 实例）。 */
  coreCall: <T = unknown>(channel: RequestChannel, payload?: unknown) => Promise<T>;
  /** 告诉外壳渲染层已就绪（启动期提示的冲刷钩子）；返回本次冲刷的提示条数。 */
  rendererReady: () => Promise<number>;
  /** 订阅漏斗事件并按频道过滤；返回退订函数。 */
  onCoreEvent: <T = unknown>(channel: string, handler: (payload: T) => void) => Promise<UnlistenFn>;
  /** 开机自启：写入并返回观测状态（R10）。 */
  setAutostart: (enabled: boolean) => Promise<boolean>;
  /** 开机自启：读当前状态（R10）。 */
  getAutostart: () => Promise<boolean>;
}

export function isCoreError(value: unknown): value is CoreError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Tauri 的 command 错误不是 Error 实例，这里归一成 `CoreError` 形状再抛。 */
function normalizeFailure(failure: unknown): CoreError {
  if (isCoreError(failure)) return failure;
  if (failure instanceof Error && failure.message !== "") return { message: failure.message, kind: "internal" };
  if (typeof failure === "string" && failure.trim() !== "") return { message: failure, kind: "internal" };
  return { message: "core 调用失败", kind: "internal" };
}

export async function coreCall<T = unknown>(channel: RequestChannel, payload: unknown = null): Promise<T> {
  try {
    return await invoke<T>(CORE_CALL, { channel, payload });
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

export async function rendererReady(): Promise<number> {
  try {
    return await invoke<number>(CORE_RENDERER_READY);
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

/**
 * 开机自启的开关（R10）。
 *
 * 回执是 Rust **观测到的实际状态**（写完再 `is_enabled` 回读），所以界面上的开关直接跟着它走：
 * 乐观地把开关翻过去，会在注册表写入失败时显示一个不存在的状态（用户下次开机才发现没生效）。
 *
 * 失败抛出 `CoreError` 形状（与 `coreCall` 同一套归一）：调用方用 `settingsFailureText` 之类
 * 的纯函数把它变成人话，不把原始错误糊到界面上。
 */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  try {
    return await invoke<boolean>(CORE_SET_AUTOSTART, { enabled });
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

/** 读当前自启状态（设置页挂载时一次）。 */
export async function getAutostart(): Promise<boolean> {
  try {
    return await invoke<boolean>(CORE_GET_AUTOSTART);
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

/**
 * 订阅漏斗事件。
 *
 * 广播白名单（`src/shared/channels.ts` 的 `BROADCAST_CHANNELS`）初始只有 `app:notice`，
 * 且 R4+ 还会往里加，所以这里按 `string` 接收、运行时靠事件载荷里的 channel 过滤。
 */
export async function onCoreEvent<T = unknown>(
  channel: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<CoreEventEnvelope<T>>(CORE_EVENT, (event) => {
    if (event.payload?.channel !== channel) return;
    handler(event.payload.payload);
  });
}

/** 方法路由表：`window.desktop` 的全部能力。 */
export const desktopBridge: DesktopBridge = {
  coreCall,
  rendererReady,
  onCoreEvent,
  setAutostart,
  getAutostart,
};

/** 挂到 `window.desktop`（R8 起在 main.tsx 调用；本任务不接 UI）。 */
export function installDesktopBridge(target: Window = window): void {
  target.desktop = desktopBridge;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
