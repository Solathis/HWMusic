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

/**
 * 库页面数据频道（R8 一次增补齐）：主界面六个页面的**唯一**数据通道。
 *
 * 一次补齐而不是按页面零散加：这些页面共用同一套"分页 + 结构化错误 + 空态"处理，
 * 分批加只会让渲染层在中间几轮里出现"某些页面点了没反应"（频道不在白名单 =
 * Rust 准入直接回 `unknown_channel`，看起来像坏掉）。
 *
 * 业务语义（与 src/protocols/music.mjs 同源，端点全部注入、未配置时结构化 `endpoint_unknown`）：
 * - `library:favorites`：收藏分页（**没有可信总数**，总数 = 完整分页后 ID 去重，UI 与已加载数分开显示）；
 * - `library:playlist-detail`：歌单曲目分页（与歌单列表分开：列表只有元信息）；
 * - 其余为一页式列表（`hasMore` 由协议层的同一规则给出，渲染层不自己猜）。
 */
export const LIBRARY_FAVORITES = "library:favorites" as const;
export const LIBRARY_PLAYLISTS = "library:playlists" as const;
export const LIBRARY_PLAYLIST_DETAIL = "library:playlist-detail" as const;
export const LIBRARY_SEARCH = "library:search" as const;
export const LIBRARY_ALBUM = "library:album" as const;
export const LIBRARY_ARTIST = "library:artist" as const;
export const LIBRARY_HISTORY = "library:history" as const;

export const REQUEST_CHANNELS = [
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_CANCEL_LOGIN,
  SETTINGS_GET,
  SETTINGS_SET,
  LIBRARY_FAVORITES,
  LIBRARY_PLAYLISTS,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_SEARCH,
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_HISTORY,
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export function isRequestChannel(channel: string): channel is RequestChannel {
  return (REQUEST_CHANNELS as readonly string[]).includes(channel);
}

/** core → 宿主的宿主要求频道。R3 只实现 `host:notify`；R5 接上安全存储，R7 接上登录窗。 */
export const HOST_OPEN_LOGIN = "host:open-login" as const;
/**
 * 取消进行中的登录（R7 增补）。
 *
 * 链路：渲染层"取消登录" → `core_call(auth:cancel-login)` → sidecar 的登录编排 →
 * 这条宿主要求 → Rust 把登录窗的结论槽结算成 Cancelled（窗随即被拆掉）。
 * 渲染层的取消**不是**"前端自己假装关了窗"：窗在 Rust 手里，只有它能拆。
 */
export const HOST_CANCEL_LOGIN = "host:cancel-login" as const;
export const HOST_SECURE_ENCRYPT = "host:secure-encrypt" as const;
export const HOST_SECURE_DECRYPT = "host:secure-decrypt" as const;
export const HOST_NOTIFY = "host:notify" as const;

export const HOST_REQUEST_CHANNELS = [
  HOST_OPEN_LOGIN,
  HOST_CANCEL_LOGIN,
  HOST_SECURE_ENCRYPT,
  HOST_SECURE_DECRYPT,
  HOST_NOTIFY,
] as const;

export type HostRequestChannel = (typeof HOST_REQUEST_CHANNELS)[number];

export function isHostRequestChannel(channel: string): channel is HostRequestChannel {
  return (HOST_REQUEST_CHANNELS as readonly string[]).includes(channel);
}
