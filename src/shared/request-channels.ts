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
/**
 * 二维码登录（R16 增补）：发起一次二维码会话，应答 `{content, expiresInMs}`。
 *
 * 为什么是"发起并立刻回内容"而不是长轮询：扫码状态的变化走 `auth:qr` 广播（同 `auth:login`
 * 的理由——渲染层那条调用链有 60 秒上限，而等待扫码要好几分钟）。轮询在 sidecar 里做，
 * 渲染层只画二维码、只看广播；重复调用 = 换一张新二维码（用户重试就是想要这个）。
 */
export const AUTH_QR_START = "auth:qr-start" as const;
/**
 * 登录状态**重查**（R19 增补）：渲染层挂载时主动问一次"现在是什么状态"，应答与
 * `auth:status` 广播**同形状**（`{loggedIn, busy, message?}`）。
 *
 * 为什么必须有这条（真缺陷，不是锦上添花）：`auth:status` 只在 sidecar 启动时广播一次
 * （渲染层没就绪时由 Rust 的 NoticeQueue 排队，`core_renderer_ready` 时冲刷——但**只冲刷一次**）。
 * 渲染层 reload / 崩溃重启之后，那一条已经冲刷过了，于是门禁永远停在 `checking`
 * （"正在检查登录状态…"）：既不自动发起二维码，也没有任何报错。广播是"变化时通知"，
 * 它天生回答不了"**现在的**状态是什么"——那需要一次有应答的查询。
 *
 * 与托盘可用性查询（`core_get_tray_available`，挂载时问一次）同款模式：**状态由拥有者答**，
 * 渲染层不猜、也不靠"等一条可能已经错过的通知"。
 *
 * 三条边界：
 * 1. **不触发广播**：查询有应答，再播一条只会让渲染层把同一件事处理两遍；
 * 2. **只答状态，不答历史**：`message` 是"刚发生的那件事"（失败原因），它随广播走、不随快照走
 *    ——重查回答的是"现在是什么"，不是"上次怎么了"；
 * 3. **不推结论**：答的就是 `authManager` 的当前事实（会话有没有、开窗那条路忙不忙），
 *    未经验证的会话不会因为被问了一句就变成"已登录"（`restore` 的诚实性规矩不变）。
 */
export const AUTH_GET_STATUS = "auth:get-status" as const;
/**
 * 停掉进行中的二维码会话（门禁切主界面或卸载时发）；幂等，没有会话也回 `{cancelled:true}`。
 * 与 `auth:cancel-login`（关宿主那扇登录窗）是两件事：这条停的是二维码轮询。
 */
export const AUTH_CANCEL_QR = "auth:cancel-qr" as const;
export const SETTINGS_GET = "settings:get" as const;
export const SETTINGS_SET = "settings:set" as const;

/**
 * 代理测试频道（R10 增补）：把 R6 的 `testProxyConnection` 接到设置页的"测试连接"按钮。
 *
 * 为什么不并进 `settings:set`：它**不发网络请求**（只写盘），而这条会发一次真实请求——
 * 两件事的耗时、失败方式、超时语义都不同（保存是写盘失败，测试是代理不通），并在一起就只能靠
 * 载荷形状区分意图（"保存并顺手测一下"？），而用户要的是"先测通再保存"。
 *
 * 载荷 `{proxy:{...}}`（表单当前的草稿，**不是已保存的旧值**：用户点它就是想验证刚填的这组能不能通）；
 * 应答 `data.result` 即 R6 测试器的结构化结论（`{ok, ms, status}` 或 `{ok:false, error:{kind, message}}`）。
 * 目标 URL 由 core 侧的固定常量决定（不接受调用方指定，见 `src/host/proxy-handlers.mjs`）。
 */
export const SETTINGS_TEST_PROXY = "settings:test-proxy" as const;

/**
 * 库页面数据频道（R8 一次增补齐）：主界面六个页面的**唯一**数据通道。
 *
 * 一次补齐而不是按页面零散加：这些页面共用同一套"分页 + 结构化错误 + 空态"处理，
 * 分批加只会让渲染层在中间几轮里出现"某些页面点了没反应"（频道不在白名单 =
 * Rust 准入直接回 `unknown_channel`，看起来像坏掉）。
 *
 * 业务语义（与 src/protocols/music.mjs 同源；R32 起端点有默认值 = 参考实测的业务域 + 路径，
 * 可在设置里覆盖或显式关闭，关闭/未确定时才是结构化 `endpoint_unknown`）：
 * - `library:favorites`：收藏分页（**没有可信总数**，总数 = 完整分页后 ID 去重，UI 与已加载数分开显示）；
 * - `library:playlists`：歌单（协议层会翻页扫完再挑歌单——真接口把歌曲与歌单混在一个列表里）；
 * - `library:playlist-detail`：歌单曲目分页（与歌单列表分开：列表只有元信息）；
 * - 其余为一页式列表（`hasMore` 由协议层的同一规则给出，渲染层不自己猜）。
 * 没有音乐会话（没登录）时回结构化 `session_required`——与"接口没配"是两件事。
 */
export const LIBRARY_FAVORITES = "library:favorites" as const;
export const LIBRARY_PLAYLISTS = "library:playlists" as const;
export const LIBRARY_PLAYLIST_DETAIL = "library:playlist-detail" as const;
export const LIBRARY_SEARCH = "library:search" as const;
export const LIBRARY_ALBUM = "library:album" as const;
export const LIBRARY_ARTIST = "library:artist" as const;
export const LIBRARY_HISTORY = "library:history" as const;

/**
 * 播放地址频道（R9 增补）：拿**当次**播放地址，载荷 `{trackId}`，应答 `data` 即协议层
 * `parsePlaybackPayload` 的产物（`{url, fileInfos, format, size, bitrate, duration,
 * auditionLikely, signals, warnings}`）。
 *
 * 三条不可协商的边界（R9 简报裁决）：
 * 1. **音频地址只作当次播放结果**交给渲染层：不写日志、不持久化（队列仅存标识、索引与安全展示快照）；
 * 2. 渲染层拿到后还要**再过一次 safe-media-url**（CSP `media-src` 白名单）才允许装载，
 *    协议层的校验不是"渲染层可以省掉这一步"的理由；
 * 3. 端点未配置时是结构化的 `endpoint_unknown`（不冒充已实现，也不打到一个瞎猜的地址上）。
 */
export const PLAYBACK_RESOLVE_URL = "playback:resolve-url" as const;

/**
 * 歌词文本频道（R12 增补）：载荷 `{trackId}`，应答 `data` 即协议层 `getLyrics` 的产物
 * （`{text, format, warnings}` —— **原始歌词文本**，不是解析结果）。
 *
 * 为什么返回文本而不是 AMLL 行数组：逐行滚动必须来自官方组件，而"文本 → 行"这一步是官方
 * `parseLrc` 的职责（R9 的 `features/lyrics/amll-adapter.ts` 在它之上补 `[offset:]` 与翻译行）。
 * 把解析放在 sidecar 会让渲染层拿到的是一份"别人解析好的东西"，AMLL 的版本一变就对不上。
 *
 * **文本来源（R32 换血；R38 按真机取证改成三档）**：参考实现里没有独立歌词端点。R38 的真机
 * 取证（2026-10-21）发现：**曲目条目自带 `lyricAddress`**（列表/专辑响应实测都有，域在白名单内、
 * 无查询串、GET 200 且是真 LRC），而**播放响应里没有任何歌词字段**。所以顺序是
 * 「显式注入的歌词端点 → 用户已加载过的条目里那条地址（协议层的进程内索引）→ 播放响应」。
 * 失败时协议层回结构化 `endpoint_unknown`（界面说"歌词来源尚未配置"）或 `invalid_response`
 * （"这首歌没有可用的歌词"）——两者不互相冒充。
 */
export const PLAYBACK_LYRICS = "playback:lyrics" as const;

/**
 * 本地歌词导入（R41 增补）：载荷 `{trackId, text, fileName}` → 存进数据根下的
 * `lyrics-local/`，应答 `data` = **生效的歌词文档**（`{text, format, source:"local", fileName?, warnings}`）。
 *
 * 为什么发过来的是**解码后的文本**而不是文件路径：文件是渲染层用系统标准控件
 * （`<input type="file">`）选的，编码识别（BOM → UTF-8 → GBK）也在那一侧做完——那边拿到的
 * 本来就是 `ArrayBuffer`。让 sidecar 去读一个路径，等于要再开一条"宿主给路径、sidecar 读盘"
 * 的信任边界（那是一整类目录穿越问题的入口），而这里只要文本。
 *
 * **本地导入永远压过在线结果**（`getLyrics` 的第 ① 跳），所以这条频道同时也是"换掉当前这首歌
 * 的歌词"的动作——导入完那一份文档就是这一首的歌词，直到用户再导入或删掉。
 */
export const LYRICS_IMPORT = "lyrics:import" as const;

/**
 * 歌词缓存占用（R41 增补）：载荷 `null`，应答 `data` = `{available, bytes, entries, localBytes, localEntries}`
 * （在线缓存与本地导入两个目录各一份数字）。
 *
 * 为什么是独立频道而不是塞进 `settings:get`：这两件事的生命周期不同——设置是**用户配置**
 * （会随 `settings:set` 走校验与广播），缓存是**磁盘现状**（要现算，且会自己变）。
 * 把它塞进设置文档，等于让一份会漂的数字混进用户的配置里。
 */
export const LYRICS_CACHE_INFO = "lyrics:cache-info" as const;

/**
 * 清歌词缓存（R41 增补）：载荷 `{local?: boolean}`，应答 `data` = 清完之后的**新占用**（同 `lyrics:cache-info`）。
 *
 * `local: true` 才连本地导入目录一起删。默认**只清在线缓存**：`lyrics-local/` 里是用户自己导入的
 * 文件，删它是一次不可撤销的动作，界面上要多问一句（设置页那张卡就是这么做的）。
 */
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
