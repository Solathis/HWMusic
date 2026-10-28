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
/** 二维码登录：发起一次二维码会话，应答 `{content, expiresInMs}`；重复调用即换一张新码。 */
export const AUTH_QR_START = "auth:qr-start" as const;
/** 登录状态重查：渲染层挂载时主动问一次，应答与 `auth:status` 广播同形状（`{loggedIn, busy, message?}`），且不触发广播。 */
export const AUTH_GET_STATUS = "auth:get-status" as const;
/**
 * 停掉进行中的二维码会话（门禁切主界面或卸载时发）；幂等，没有会话也回 `{cancelled:true}`。
 * 与 `auth:cancel-login`（关宿主那扇登录窗）是两件事：这条停的是二维码轮询。
 */
export const AUTH_CANCEL_QR = "auth:cancel-qr" as const;
export const SETTINGS_GET = "settings:get" as const;
export const SETTINGS_SET = "settings:set" as const;

/** 代理测试频道：用表单当前草稿发一次真实请求，应答 `data.result` 为 `{ok, ms, status}` 或 `{ok:false, error:{kind, message}}`。 */
export const SETTINGS_TEST_PROXY = "settings:test-proxy" as const;

/** 库页面数据频道：主界面六个页面的唯一数据通道，共用分页、结构化错误与空态。没登录回 `session_required`，与「接口没配」是两件事。 */
export const LIBRARY_FAVORITES = "library:favorites" as const;
export const LIBRARY_PLAYLISTS = "library:playlists" as const;
export const LIBRARY_PLAYLIST_DETAIL = "library:playlist-detail" as const;
export const LIBRARY_SEARCH = "library:search" as const;
export const LIBRARY_ALBUM = "library:album" as const;
export const LIBRARY_ARTIST = "library:artist" as const;
export const LIBRARY_HISTORY = "library:history" as const;

/**
 * 播放地址频道：载荷 `{trackId}`；地址不写日志、不持久化，渲染层仍需过 safe-media-url。
 * 应答 `{url, fileInfos, format, size, bitrate, duration, auditionLikely, signals, warnings}`。
 */
export const PLAYBACK_RESOLVE_URL = "playback:resolve-url" as const;

/**
 * 歌词文本频道：载荷 `{trackId}`，应答 `{text, format, warnings}` 是原始歌词文本。
 * 解析交给渲染层官方 `parseLrc`；来源顺序为注入端点 → 进程内索引 → 播放响应。
 */
export const PLAYBACK_LYRICS = "playback:lyrics" as const;

/**
 * 本地歌词导入：载荷 `{trackId, text, fileName}` 存进 `lyrics-local/`。
 * 应答为生效文档 `{text, format, source:"local", fileName?, warnings}`，永远压过在线结果。
 */
export const LYRICS_IMPORT = "lyrics:import" as const;

/** 歌词缓存占用：载荷 `null`，应答 `{available, bytes, entries, localBytes, localEntries}`，在线缓存与本地导入各一份数字。 */
export const LYRICS_CACHE_INFO = "lyrics:cache-info" as const;

/** 清歌词缓存：载荷 `{local?: boolean}`，应答为清完后的新占用；`local: true` 才连本地导入目录一起删。 */
export const LYRICS_CACHE_CLEAR = "lyrics:cache-clear" as const;

export const REQUEST_CHANNELS = [
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_CANCEL_LOGIN,
  AUTH_QR_START,
  AUTH_GET_STATUS,
  AUTH_CANCEL_QR,
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_TEST_PROXY,
  LIBRARY_FAVORITES,
  LIBRARY_PLAYLISTS,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_SEARCH,
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_HISTORY,
  PLAYBACK_RESOLVE_URL,
  PLAYBACK_LYRICS,
  LYRICS_IMPORT,
  LYRICS_CACHE_INFO,
  LYRICS_CACHE_CLEAR,
] as const;

export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export function isRequestChannel(channel: string): channel is RequestChannel {
  return (REQUEST_CHANNELS as readonly string[]).includes(channel);
}

/** core → 宿主的宿主要求频道，覆盖登录窗、安全存储与通知。 */
export const HOST_OPEN_LOGIN = "host:open-login" as const;
/** 取消进行中的登录。链路：渲染层 → `core_call(auth:cancel-login)` → sidecar 编排 → 这条宿主要求，由 Rust 把登录窗结算成 Cancelled。 */
export const HOST_CANCEL_LOGIN = "host:cancel-login" as const;
export const HOST_SECURE_ENCRYPT = "host:secure-encrypt" as const;
export const HOST_SECURE_DECRYPT = "host:secure-decrypt" as const;
export const HOST_NOTIFY = "host:notify" as const;

/** 本地曲目的歌词来源：载荷 `{trackId}`，应答 `{bytes, source, name?}`，回原始字节的 base64。编码识别只由 sidecar 做一份，路径与上限由 Rust 定。 */
export const HOST_LOCAL_LYRICS_SOURCE = "host:local-lyrics-source" as const;

export const HOST_REQUEST_CHANNELS = [
  HOST_OPEN_LOGIN,
  HOST_CANCEL_LOGIN,
  HOST_SECURE_ENCRYPT,
  HOST_SECURE_DECRYPT,
  HOST_NOTIFY,
  HOST_LOCAL_LYRICS_SOURCE,
] as const;

export type HostRequestChannel = (typeof HOST_REQUEST_CHANNELS)[number];

export function isHostRequestChannel(channel: string): channel is HostRequestChannel {
  return (HOST_REQUEST_CHANNELS as readonly string[]).includes(channel);
}
