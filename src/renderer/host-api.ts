/**
 * 渲染层唯一的宿主桥封装（R3 交付封装与类型；R10 增补开机自启；R11 增补托盘可用性）。
 *
 * 边界：渲染层拿到的是白名单方法，拿不到任何 Token——凭据与业务 HTTP 只在 sidecar/Rust。
 * 歌词窗仅获配置与三种媒体动作的专命令；任意业务请求仍只在主窗执行。
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  CORE_CALL,
  CORE_GET_AUTOSTART,
  CORE_GET_TRAY_AVAILABLE,
  CORE_LOGIN_CHROME,
  CORE_LYRICS_CONFIGURE,
  CORE_LYRICS_CONTROL,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_TOGGLE,
  CORE_RENDERER_READY,
  CORE_SET_AUTOSTART,
} from "../shared/commands.ts";
import { CORE_EVENT, LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts";
import { acceptThemePayload } from "./features/theme/theme.mjs";
import { AUTH_LOGOUT } from "../shared/request-channels.ts";
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
  /** 托盘是否真的可用（R11）：设置页的关窗行为提示靠它说真话。 */
  getTrayAvailable: () => Promise<boolean>;
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
 * 退出登录（R38）：`core_call(auth:logout)` 的**唯一实现**。
 *
 * 为什么收进这里（而不是让某个页面自己写一行 coreCall）：R38 把退出入口从设置页搬到了左下角
 * 账号区，而"退出"必须始终是**同一件事**——一个频道、一种载荷（`null`）。摆在具名封装里，
 * 第二份实现就没有地方可长（设置页那份已经删掉了）。
 *
 * 失败抛 `CoreError` 形状（与 `coreCall` 同一套归一）：调用方用 `accountLogoutFailureText`
 * 变成人话，别把原始错误糊到界面上。成功后**不需要**任何跳转：`auth:status` 广播会把门禁翻回来。
 */
export async function coreLogout(): Promise<unknown> {
  return coreCall(AUTH_LOGOUT, null);
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
 * 托盘是否真的可用（R11）。
 *
 * 回执只有 `true` 才算"可用"：命令失败、回执形状不对都按"不可用"处理
 * （调用方用 `trayAvailabilityFromAnswer` 投影）——界面说"不可用"而实际能用，
 * 比反过来（界面说能用、关窗却退出了）代价小得多。
 */
export async function getTrayAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>(CORE_GET_TRAY_AVAILABLE);
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

// 歌词 configure/control 限 main/lyrics，其余命令仍 main-only。状态回执携带 revision。

async function invokeLyrics<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

/** 开/关桌面歌词窗（目标态：`true` = 要开）。 */
export async function coreLyricsToggle(checked: boolean): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_TOGGLE, { checked });
}

/** 改歌词窗配置（**空对象 = 读回当前配置**，设置页挂载时用）。
 *
 * R44e：`retrySave` 只能与空 config 一起用——它重存的是**当前运行配置**（保存失败后的手动重试），
 * 不是又改一次值。落盘由 Rust 拥有的保存任务完成，渲染层不再自己写 settings。
 */
export async function coreLyricsConfigure(config: unknown, retrySave?: boolean): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_CONFIGURE, retrySave === undefined ? { config } : { config, retrySave });
}

export async function coreLyricsControl(action: "toggle" | "previous" | "next"): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_CONTROL, { payload: { action } });
}

/** 把歌词文档转发给歌词窗（行数组来自官方 `parseLrc` 的适配层）。 */
export async function coreLyricsDocument(document: unknown): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_DOCUMENT, { document });
}

/** 推进度（调用方已按 `shouldPushProgress` 节流）。 */
export async function coreLyricsProgress(progress: unknown): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_PROGRESS, { progress });
}

// ---------------------------------------------------------------------------
// 登录体验的浮动控件（R25）：一条专用命令
// ---------------------------------------------------------------------------

/** 浮动控件能发的两种动作（与 `src/shared/commands.ts` 的说明同源）。 */
export type LoginChromeRequest =
  | { action: "return" }
  /** `theme` 缺省 = 读回当前档位（不需要第二条命令） */
  | { action: "theme"; theme?: string };

/**
 * 登录体验的控件命令（**`core_call` 之外的第二条业务命令**，理由见 `src/shared/commands.ts`）。
 *
 * 谁调它：主窗里 gate 的主题控件、以及两个浮动 webview（label `login-return` / `login-theme`）。
 * 官方登录页与歌词窗调不动（来源守卫只放行那三个 label）。回执是**事实**：
 * `{cancelled}` 或 `{theme}`——调用方不必猜"到底改没改"。
 */
export async function coreLoginChrome<T = unknown>(payload: LoginChromeRequest): Promise<T> {
  try {
    return await invoke<T>(CORE_LOGIN_CHROME, { payload });
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

export async function signalLyricsReady(): Promise<void> {
  await emit<CoreEventEnvelope>(CORE_EVENT, { channel: LYRICS_STATE, payload: { ready: true } });
}

/**
 * 主窗替歌词窗"补一次主题"（歌词窗调不动读主题那条命令）。
 *
 * R44e：判定用共享的单调合同 [`acceptThemePayload`]——读回**必须比期间收到的广播更新**才补发，
 * 否则这份延迟的旧读回会把刚广播出去的新主题又盖回去（主窗与歌词窗一起回退）。
 * 临时观察无论成功失败都要清掉。
 */
export async function syncLyricsTheme(): Promise<void> {
  let newest = -1;
  let interrupted = false;
  const stop = await onCoreEvent<{ theme?: string; revision?: number }>(THEME_CHANGED, (payload) => {
    interrupted = true;
    newest = acceptThemePayload(newest, payload).seen;
  });
  try {
    const answer = await coreLoginChrome<{ theme?: string; revision?: number }>({ action: "theme" });
    // 期间来过广播：只有"比它更新的读回"才值得补发（没有编号也算旧）。
    const verdict = acceptThemePayload(newest, answer);
    if (interrupted && verdict.seen <= newest) return;
    const payload: { theme?: string; revision?: number } = { theme: answer?.theme };
    if (Number.isSafeInteger(answer?.revision)) payload.revision = answer!.revision!;
    await emit<CoreEventEnvelope>(CORE_EVENT, { channel: THEME_CHANGED, payload });
  } finally {
    stop();
  }
}

/** 方法路由表：`window.desktop` 的全部能力。 */
export const desktopBridge: DesktopBridge = {
  coreCall,
  rendererReady,
  onCoreEvent,
  setAutostart,
  getAutostart,
  getTrayAvailable,
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
