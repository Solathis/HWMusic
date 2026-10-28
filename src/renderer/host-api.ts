/**
 * 渲染层唯一的宿主桥封装：白名单方法，拿不到任何 Token——凭据与业务 HTTP 只在 sidecar/Rust。
 *
 * 歌词窗仅获配置与三种媒体动作的专命令；任意业务请求仍只在主窗执行。
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  CORE_CALL,
  CORE_GET_AUTOSTART,
  CORE_GET_TRAY_AVAILABLE,
  CORE_LOGIN_CHROME,
  CORE_LOCAL_BASE_URL,
  CORE_LOCAL_IMPORT,
  CORE_LOCAL_LIST,
  CORE_LOCAL_REMOVE,
  CORE_LYRICS_CONFIGURE,
  CORE_LYRICS_CONTROL,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_SETTINGS_CLOSE,
  CORE_LYRICS_SETTINGS_OPEN,
  CORE_LYRICS_SETTINGS_RESIZE,
  CORE_LYRICS_TOGGLE,
  CORE_LYRICS_UNLOCK_ZONE,
  CORE_READ_RUN_LOG,
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
  /** 开机自启：写入并返回观测状态。 */
  setAutostart: (enabled: boolean) => Promise<boolean>;
  /** 开机自启：读当前状态。 */
  getAutostart: () => Promise<boolean>;
  /** 托盘是否真的可用：设置页的关窗行为提示靠它说真话。 */
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
 * 退出登录：`core_call(auth:logout)` 的唯一实现，让退出始终是同一件事（一个频道、一种载荷）。
 *
 * 失败抛 `CoreError` 形状，调用方用 `accountLogoutFailureText` 变成人话；成功后靠 `auth:status` 广播翻回门禁。
 */
export async function coreLogout(): Promise<unknown> {
  return coreCall(AUTH_LOGOUT, null);
}

/**
 * 开机自启的开关：回执是 Rust 观测到的实际状态，界面开关直接跟着它走，不做乐观翻转。
 *
 * 失败抛 `CoreError` 形状，调用方用 `settingsFailureText` 之类把它变成人话。
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
 * 托盘是否真的可用：只认 `true`，命令失败或回执形状不对都按不可用处理——界面说不可用比反过来代价小。
 */
export async function getTrayAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>(CORE_GET_TRAY_AVAILABLE);
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

/**
 * 运行日志：日志文件最后 N 条（旧的在前），默认只取本次启动之后的。
 *
 * 回执是已脱敏的结构化条目，脱敏与条数上限都在 Rust 侧。
 */
export async function readRunLog(scope: "session" | "all" = "session"): Promise<unknown> {
  try {
    return await invoke<unknown>(CORE_READ_RUN_LOG, { scope });
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

/**
 * 改歌词窗配置（空对象 = 读回当前配置）；`retrySave` 只能与空 config 一起用，重存的是当前运行配置。
 *
 * 落盘由 Rust 的保存任务完成，渲染层不再自己写 settings。
 */
export async function coreLyricsConfigure(config: unknown, retrySave?: boolean): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_CONFIGURE, retrySave === undefined ? { config } : { config, retrySave });
}

export async function coreLyricsControl(action: "toggle" | "previous" | "next"): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_CONTROL, { payload: { action } });
}

/** 歌词页上报解锁按钮所在区域（CSS 像素；null = 没有解锁按钮）。 */
export async function coreLyricsUnlockZone(zone: { x: number; y: number; width: number; height: number } | null): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_UNLOCK_ZONE, { zone });
}

/** 把歌词文档转发给歌词窗（行数组来自官方 `parseLrc` 的适配层）。 */
export async function coreLyricsDocument(document: unknown): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_DOCUMENT, { document });
}

/** 推进度（调用方已按 `shouldPushProgress` 节流）。 */
export async function coreLyricsProgress(progress: unknown): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_PROGRESS, { progress });
}

/**
 * 打开桌面歌词的设置弹出窗：`anchor` 是调用窗口客户区里的 CSS 像素矩形，Rust 换算后右对齐、下方优先、夹进工作区。
 *
 * 回执是事实 `{open, visible}`：`open:false` 表示这次被刚失焦关掉的短窗口挡了。
 */
export async function coreLyricsSettingsOpen(anchor: { x: number; y: number; width: number; height: number }): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_SETTINGS_OPEN, { anchor });
}

/** 弹出窗把量到的菜单尺寸（CSS 像素）报给宿主：尺寸与位置都由 Rust 设，页面不碰窗口。 */
export async function coreLyricsSettingsResize(width: number, height: number): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_SETTINGS_RESIZE, { width, height });
}

/** 关掉弹出窗（Esc / 点菜单外面）。 */
export async function coreLyricsSettingsClose(): Promise<unknown> {
  return invokeLyrics(CORE_LYRICS_SETTINGS_CLOSE);
}

// 登录体验的浮动控件：一条专用命令。

/** 浮动控件能发的两种动作（与 `src/shared/commands.ts` 的说明同源）。 */
export type LoginChromeRequest =
  | { action: "return" }
  /** `theme` 缺省 = 读回当前档位（不需要第二条命令） */
  | { action: "theme"; theme?: string };

/**
 * 登录体验的控件命令（`core_call` 之外的第二条业务命令），只对主窗与两个浮动 webview 开放。
 *
 * 回执是事实：`{cancelled}` 或 `{theme}`，调用方不必猜到底改没改。
 */
export async function coreLoginChrome<T = unknown>(payload: LoginChromeRequest): Promise<T> {
  try {
    return await invoke<T>(CORE_LOGIN_CHROME, { payload });
  } catch (failure) {
    throw normalizeFailure(failure);
  }
}

// 本地曲库：四条命令，全部只对主窗开放（Rust 侧 `require_main_webview`）。

/** 本地曲库协议基址（平台不同：Windows 是 `http://hwlocal.localhost`，mac/Linux 是 `hwlocal://localhost`）。 */
export async function coreLocalBaseUrl(): Promise<{ baseUrl?: string }> {
  return invokeLyrics<{ baseUrl?: string }>(CORE_LOCAL_BASE_URL);
}

/** 曲库快照（每条**没有路径**；`available` 说的是文件还在不在）。 */
export async function coreLocalList(): Promise<unknown> {
  return invokeLyrics(CORE_LOCAL_LIST);
}

/**
 * 导入：`paths` 省略 = 开系统对话框（`folder: true` 是选文件夹）。
 * 传了 `paths` 就不弹对话框（守卫与测试走这条，见 `silent-testing-protocol.md`）。
 */
export async function coreLocalImport(payload: { paths?: string[]; folder?: boolean } = {}): Promise<unknown> {
  return invokeLyrics(CORE_LOCAL_IMPORT, payload);
}

/** 从曲库里移除一条（**不删文件**：用户的原文件不是我们的东西）。 */
export async function coreLocalRemove(id: string): Promise<unknown> {
  return invokeLyrics(CORE_LOCAL_REMOVE, { id });
}

/**
 * 订阅漏斗事件。
 *
 * 广播白名单还会不断扩充，所以这里按 `string` 接收、运行时靠载荷里的 channel 过滤。
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
 * 主窗替歌词窗补一次主题：判定用共享的单调合同 `acceptThemePayload`，读回必须比期间收到的广播更新才补发。
 *
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

/** 挂到 `window.desktop`（在 main.tsx 调用）。 */
export function installDesktopBridge(target: Window = window): void {
  target.desktop = desktopBridge;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
