/**
 * 广播频道与桥内部事件名的唯一真源（Node sidecar 与渲染层 import 同一模块）。
 *
 * Rust 侧 src-tauri/src/bridge.rs 用同名字符串字面量镜像这两项（Rust 无法 import TS），
 * 由 test/channel-parity.test.mjs 扫描源码钉住两侧一致——改这里就必须同步改那里。
 */

/** 渲染层订阅的唯一 Tauri 事件名（漏斗事件）：载荷形如 `{channel, payload}`。 */
export const CORE_EVENT = "core:event";

/** sidecar 允许广播给渲染层的频道白名单；Rust 侧 `bridge.rs` 的同名数组是镜像副本，由 `test/channel-parity.test.mjs` 钉住。 */
export const APP_NOTICE = "app:notice" as const;

/**
 * 登录状态广播：`{loggedIn, busy, message?, profile?}`。
 *
 * `app:notice` 是给用户看的提示文案，登录是**状态**，不能塞进文案里靠解析判断。
 */
export const AUTH_STATUS = "auth:status" as const;

/**
 * 播放控制广播：`{command: "play"|"pause"|"toggle"|"next"|"previous"}` —— 控制意图，不是状态。
 *
 * 发送方是托盘（Rust 侧），它既不能调 `core_call`，也不该为一条命令起一趟请求/响应。
 */
export const PLAYER_COMMAND = "player:command" as const;

/**
 * 桌面歌词开关广播：`{checked: boolean}` —— **目标态**，渲染层按它行动，不必猜现在是开还是关。
 */
export const LYRICS_TOGGLE = "lyrics:toggle" as const;

/**
 * 打开设置页广播：`{view: "settings"}`；视图状态在渲染层，Rust 只发「去设置页」的意图。
 */
export const APP_OPEN_SETTINGS = "app:open-settings" as const;

/**
 * 歌词文档广播：`{lines: LyricLine[], status: string}`。
 *
 * 歌词窗没有业务频道权限，只能订阅；行数组由主窗用官方 `parseLrc` 解析后转发，两处不可能显示两首歌。
 */
export const LYRICS_DOCUMENT = "lyrics:document" as const;

/**
 * 歌词进度广播：`{timeMs, playing, seekGeneration}`；歌词窗没有音频元素，进度由主窗的 rAF 推、节流在桥里。
 */
export const LYRICS_PROGRESS = "lyrics:progress" as const;

/**
 * Rust 权威广播：`{config,visible,requestedVisible,revision,runtimeRevision,taskbar:{supported,attached,reason}}`。
 * revision 只随 config 变，runtimeRevision 在 owner 线程对全状态单调编号；主窗拒旧运行回执且仅保存 config。
 * URL 只供初值，歌词窗订阅后 configure({}) 回读再发 `{ready:true}`，主窗补最新文档/进度/主题。
 */
export const LYRICS_STATE = "lyrics:state" as const;

/** 锁定的桌面歌词：光标进出歌词窗 `{inside: boolean}`（Rust 轮询光标后广播）。 */
export const LYRICS_POINTER = "lyrics:pointer" as const;

/**
 * 二维码登录状态广播：`{status, content?, expiresInMs?, message?, errorKind?}`。
 *
 * `auth:status` 是**会话**状态，这里是一张二维码的生命周期，门禁要同时知道这两件事。
 * 二维码内容只在广播里走，会话令牌（qrToken）留在 sidecar，不进广播。
 */
export const AUTH_QR = "auth:qr" as const;

/**
 * 主题变化广播：`{theme: "light"|"dark"|"system"}` —— **目标态**，不是计算出来的明暗。
 *
 * 主题由 Rust 侧持有，各 webview 自己查会各自漂移；广播一发，所有该应用 class 的 webview 一起变。
 * 官方登录页零注入、不订阅；歌词窗订阅（否则深色主题下停在浅色令牌上，有歌词但看不见）。
 */
export const THEME_CHANGED = "theme:changed" as const;

export const BROADCAST_CHANNELS = [
  APP_NOTICE,
  AUTH_STATUS,
  AUTH_QR,
  PLAYER_COMMAND,
  LYRICS_TOGGLE,
  APP_OPEN_SETTINGS,
  LYRICS_DOCUMENT,
  LYRICS_PROGRESS,
  LYRICS_STATE,
  LYRICS_POINTER,
  THEME_CHANGED,
] as const;

export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];
