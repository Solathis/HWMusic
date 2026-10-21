/**
 * 华为音乐业务接口（协议原型层）。
 *
 * ## R32 换血：从"端点未知"到"端点形状 = 公开参考实现的实测值"
 *
 * 本模块此前是**纯注入 + 全部待确认**：端点表空着、参数名是占位、响应信封按 `{code:"0"}` 猜。
 * R4 的探针只证明了"那些域名不存在"，于是每个业务请求都老老实实回 `endpoint_unknown`——
 * 诚实，但一条业务链都不通。
 *
 * R32 拿到了一份**可用的协议事实**：公开仓库 `talongao/huawei-music-desktop` 的
 * `src/music.mjs` + `docs/API_CONTRACT.md`（2026-10-14 本人账号的实验记录，含收藏/歌单/搜索/
 * 专辑/歌手/历史/播放地址/歌词的**请求形状与响应形状**）。本模块按它逐字段对齐：
 *
 * | 维度 | 换血前（R4） | 换血后（R32 = 参考实测） |
 * |---|---|---|
 * | 参数位置 | 一律拼进查询串 | `POST` → JSON 体；`GET` → 查询串 |
 * | 分页 | `page`/`size` | `start`/`limit`（`page` 在**通道边界**换算成 `start`） |
 * | 业务成功 | `code === "0"` | HTTP 成功 **且** `result.resultCode === "000000"` |
 * | 收藏容器 | `list`/`items`/…（猜的） | `favoriteInfos[]` |
 * | 歌曲字段 | `id`/`name`（猜的） | `contentID`/`contentName`/… → **归一化**成 `id`/`name` |
 * | 密码头 | 无 | `Authorization: Digest …`（由调用方经 `sessionHeaders` 注入） |
 *
 * **端点仍然注入**（注入式架构没变）：本模块不写任何域名，只登记**路径形状**
 * （`MUSIC_ENDPOINT_PATHS`）。绝对 URL 的默认值住在 `src/main/music-service.mjs`
 * （照抄参考的业务域 + 这些路径），可被设置文档 `data.musicEndpoints` 逐键覆盖或显式关闭。
 *
 * ## 归一化：为什么协议层要重写字段名
 *
 * 真接口的字段是 `contentID`/`contentName`/`singer`…，而渲染层的读取兜底表
 * （`features/library/track-fields.mjs`）只认 `id`/`name`/…。两者对不上时界面不是报错，
 * 而是显示"未知歌曲 / 未命名歌单"——**看起来像数据坏了**。所以线上形状在这里统一翻成
 * 内部形状（`normalizeTrack` / `normalizePlaylist`），渲染层一行都不用改。
 *
 * 三个必须守住的业务语义（旧仓踩过的坑）：
 * 1. 收藏列表没有可信的总数字段 → 总数 = **完整分页后 ID 去重**，与"已加载 N 首"分开；
 *    接口若上报了 total，只作 `reportedTotal` 记录，绝不当真值。
 * 2. playback 响应里**顶层 `fileURL` 才是音频地址**；`fileInfos` 可能是 JSON 字符串
 *    （参考的样本里它甚至根本不是音频，而是辅助描述）。
 * 3. `auditionTime > 0` **不能单独**判定 30 秒试听，必须再有第二个信号（标志位）才算。
 * 另：自建歌单删除必须走 `playlistDelete` 端点，不允许拿收藏端点冒充成功。
 *
 * 安全约定：错误的 message 只带 HTTP 状态/错误码/域名，不回显整段响应体；
 * 会话凭据（音乐 token / 账号 AT）在本模块里只经 `session`/`sessionHeaders` 流过，不进日志。
 */
import { err, ok } from "../shared/result.ts";
import { isSafeMediaUrl, safeMediaUrl } from "./safe-media-url.mjs";

/** 业务成功码（参考契约：`result.resultCode === "000000"`）。 */
export const MUSIC_BUSINESS_OK = "000000";

/** 业务域下的**路径**（唯一真源；绝对 URL 由调用方按业务域拼出来注入）。 */
export const MUSIC_ENDPOINT_PATHS = Object.freeze({
  /** 收藏（含"我的歌单"发现）：同一端点，靠 `contentTypes` 区分要什么 */
  favorites: "/music-userbehavior-service/v3/service/favorite/simple/all",
  /** 歌单发现：与收藏同一个端点、不同的 `contentTypes`（见 `MUSIC_LIBRARY_CONTENT_TYPES`） */
  playlistList: "/music-userbehavior-service/v3/service/favorite/simple/all",
  /** 自建歌单曲目：要真实 `playListID`，**不是**歌单列表接口 */
  playlistDetail: "/music-userbehavior-service/v1/service/playlist/detail/all",
  /** 公开/收藏歌单详情（type=4）：与自建歌单是两个端点 */
  playlistDetailPublic: "/music-operation-service/v2/service/musiclist/detail/bymusiclistid",
  /** 自建歌单删除（**只此一条**，收藏端点删歌单会拿到"成功"码却没删掉） */
  playlistDelete: "/music-userbehavior-service/v1/service/playlist/delete",
  search: "/music-search-service/v10/service/fuzzysearch",
  album: "/music-metacontent-service/v1/service/album/detail/byalbumcode",
  artist: "/music-metacontent-service/v2/service/artist/detail/byartistcode",
  history: "/music-userbehavior-service/v1/service/recentlyplayed/query",
  playback: "/music-play-service/v3/service/file/bycontentcode",
  /**
   * 歌词：参考实现里**没有独立歌词端点**——歌词从播放响应里取
   * （`lyricAddress` / `contentExInfo.lyrics`，见 `getLyrics`）。
   * 这个键留着只是因为设置文档里可能已经写过一个独立歌词端点：写了就用它，
   * 没写就走"从播放响应推导"这条默认路。
   */
  lyrics: null,
});

/** 每个端点的 HTTP 方法（参考实测；写死在这里而不是让调用方猜）。 */
export const MUSIC_ENDPOINT_METHODS = Object.freeze({
  favorites: "POST",
  playlistList: "POST",
  playlistDetail: "GET",
  playlistDetailPublic: "POST",
  playlistDelete: "POST",
  search: "POST",
  album: "GET",
  artist: "POST",
  history: "GET",
  playback: "POST",
  lyrics: "GET",
});

/** 需要音乐会话（`session.token`）的端点。 */
export const MUSIC_AUTHENTICATED_ENDPOINTS = Object.freeze([
  "favorites",
  "playlistList",
  "playlistDetail",
  "playlistDelete",
  "history",
  "playback",
]);

/** 收藏里"歌曲"的内容类型（参考：官方 H5 的 1 = 歌曲）。 */
export const MUSIC_SONG_CONTENT_TYPES = Object.freeze(["1"]);
/**
 * "我的歌单"发现用的内容类型（参考实测：`[1,4,5,7]` 一次调用同时返回歌曲与歌单，调用方按
 * `contentType` 分流；官方 H5 的语义是 1=歌曲、4=收藏歌单、5=自建歌单、7=榜单）。
 */
export const MUSIC_LIBRARY_CONTENT_TYPES = Object.freeze(["1", "4", "5", "7"]);

/** 音质 → `qualityType`（参考实测：standard="1"、lossless="3"；其余不认，不猜）。 */
export const MUSIC_QUALITY_TYPES = Object.freeze({ standard: "1", lossless: "3" });

/** 业务端点键名（唯一真源；每个键都要由调用方注入，缺一个就少一个可用接口）。 */
export const MUSIC_ENDPOINT_KEYS = [
  "favorites",
  "playlistList",
  /** 歌单曲目（R8 增补）：与歌单列表是两件事——列表只有元信息，曲目要单独取 */
  "playlistDetail",
  /** 公开/收藏歌单详情（R32 增补，参考实测的第二条歌单详情路由） */
  "playlistDetailPublic",
  "playlistDelete",
  "search",
  "album",
  "artist",
  "history",
  "playback",
  /** 歌词（R12 增补；R32 起默认从播放响应推导，见 `MUSIC_ENDPOINT_PATHS.lyrics`） */
  "lyrics",
];

export const MUSIC_ERROR_KINDS = {
  /** 端点未注入/非 https —— 设计上的"端点未知"落点 */
  endpointUnknown: "endpoint_unknown",
  /** 调用方参数不齐（如空 id） */
  missingParam: "missing_param",
  /** 这个操作要音乐会话，而现在没有（未登录 / 会话缺 SNS 标识） */
  sessionRequired: "session_required",
  /** 音质取值不认识（不猜，也不降级成另一个音质） */
  qualityUnsupported: "quality_unsupported",
  httpError: "http_error",
  networkError: "network_error",
  invalidResponse: "invalid_response",
  /** HTTP 2xx 但业务错误码不是 000000 */
  apiError: "api_error",
  /** 播放地址不在 CDN 白名单内（渲染层反正也加载不了，早点如实报错） */
  unsafeMediaUrl: "unsafe_media_url",
};

/** 能佐证"这是试听片段"的标志位候选（与 auditionTime 齐备才算试听）。 */
export const DEFAULT_AUDITION_FLAG_KEYS = ["isAudition", "audition", "tryListen", "trialFlag", "isTry"];

/**
 * 列表可能挂在这些字段下（真实容器名在前，旧候选留在后面兼容手工注入的响应）。
 *
 * 真实名来自参考的响应记录：`favoriteInfos`（收藏/歌单发现）、`songSimpleInfos`（搜索/专辑/
 * 公开歌单）、`contentSimpleInfos`（播放历史）。
 */
export const LIST_CONTAINER_KEYS = [
  "favoriteInfos",
  "songSimpleInfos",
  "contentSimpleInfos",
  "playListSongInfoList",
  "list",
  "items",
  "songs",
  "records",
  "tracks",
];

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_PAGES = 200;
/** 歌单发现（`playlistList`）的单次抓取量：参考用 200（`limit=1000` 会被 400 拒）。 */
export const DEFAULT_DISCOVERY_LIMIT = 200;
/** 歌单发现的翻页上限（参考的保守上界：`DISCOVERY_PAGE_CAP = 10`）。 */
export const DEFAULT_DISCOVERY_PAGE_CAP = 10;
/** 歌词文本资源的体积上限（参考实现同样取 512 KiB）。 */
export const LYRICS_MAX_BYTES = 512 * 1024;
/** 只读请求超时（参考：25 秒）。 */
export const MUSIC_TIMEOUT_MS = 25_000;

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 文本读取（去空白；数字也接受——真接口里数量和时长**多为字符串**）。 */
function textOf(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 数值读取：转不动就是未知（**不默认成 0**，那会显示成"确实是 0"）。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 正整数兜底（负数/NaN/0 一律回落到默认值）。 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * 业务信封解码。
 *
 * 判据按参考契约：**HTTP 成功且 `result.resultCode === "000000"`** 才算成功
 * （`resultCode` 是字符串，且非 000000 时业务失败）。响应体里没有 `result` 时
 * 兼容两种老形态：`{code, data}` 信封（取 `data`）与直给对象。
 *
 * 返回的是**整个响应体**（不是某个 `data` 字段）：真接口把 `favoriteInfos`/`result` 等
 * 平铺在顶层，调用方按各自的容器名取（见 `extractList` 与各操作的 `pick`）。
 */
export function decodeEnvelope(raw) {
  if (raw === null || typeof raw !== "object") return err("接口响应不是 JSON 对象", MUSIC_ERROR_KINDS.invalidResponse);
  if (Array.isArray(raw)) return ok(raw);

  const result = raw.result;
  if (isObject(result)) {
    const code = result.resultCode;
    if (code !== undefined && code !== null && String(code) !== MUSIC_BUSINESS_OK) {
      // 只带业务码：resultMessage 可能回显请求内容
      return err(`接口返回错误码 ${String(code).slice(0, 32)}`, MUSIC_ERROR_KINDS.apiError);
    }
    return ok(raw);
  }

  const code = raw.code ?? raw.resultCode;
  if (code !== undefined && code !== null && code !== "" && !(code === 0 || code === "0")) {
    const detail = raw.msg ?? raw.message ?? raw.desc ?? raw.error_description;
    const text = isNonEmptyString(detail) ? `：${String(detail).slice(0, 200)}` : "";
    return err(`接口返回错误码 ${String(code).slice(0, 32)}${text}`, MUSIC_ERROR_KINDS.apiError);
  }
  return ok(raw.data !== undefined ? raw.data : raw);
}

/** 从响应里取出列表数组（多容器名兼容；取不到给空数组）。 */
export function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== "object") return [];
  for (const key of LIST_CONTAINER_KEYS) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data !== undefined && payload.data !== payload) return extractList(payload.data);
  return [];
}

/** 嵌套取值：`pick(raw, "playListInfoEx.playListSongInfoList")`（缺一层就是 null）。 */
export function pickPath(payload, path) {
  let current = payload;
  for (const key of String(path).split(".")) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return current === undefined ? null : current;
}

/** 歌曲 ID：内部形状优先（`normalizeTrack` 的产物），再兜旧候选；取不到返回 null。 */
export function trackIdOf(item) {
  if (item === null || typeof item !== "object") return null;
  for (const key of ["id", "songId", "musicId", "resourceId", "trackId"]) {
    const value = item[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** 艺人显示名（参考：优先 `artistNamePairs[]`，其次 `artistName`/`singerName`；不按逗号切）。 */
function artistsTextOf(item) {
  const pairs = Array.isArray(item.artistNamePairs) ? item.artistNamePairs : [];
  const names = [];
  for (const pair of pairs) {
    const name = textOf(isObject(pair) ? pair.artistName ?? pair.name : pair);
    if (name !== null) names.push(name);
  }
  if (names.length > 0) return names.join("、");
  return textOf(item.artistName) ?? textOf(item.singerName);
}

/** 封面地址：只在 CDN 白名单内才认（白名单外的图渲染层也加载不了）。 */
function coverUrlOf(item, isSafeUrl) {
  const picture = isObject(item.picture) ? item.picture : {};
  const candidates = [picture.bigImgURL, picture.middleImgURL, picture.smallImgURL, item.coverUrl, item.cover];
  for (const candidate of candidates) {
    const value = textOf(candidate);
    if (value !== null && isSafeUrl(value)) return value;
  }
  return null;
}

/**
 * 线上条目 → 内部曲目形状。
 *
 * 字段映射逐条来自参考的 `trackFrom`（`docs/API_CONTRACT.md` §5"曲目归一化"）：
 * `contentID → id`、`contentName → title/name`、`artistNamePairs|artistName → singer`、
 * `albumID/albumName → albumId/albumName`、`picture.* → coverUrl`、`duration → duration`。
 *
 * **没有 id 的条目一律返回 null**（调用方如实丢弃并计数，绝不编一个 id——
 * 列表里出现删不掉的幽灵行比少一行糟得多）。
 *
 * R38：条目自带的歌词地址（`lyricAddress`，真机实测在列表条目上存在）不进曲目投影
 * （渲染层不需要、投影契约不动），而是经 `options.onLyricAddress(id, url)` 交给调用方
 * ——`createMusicApi` 用它填**进程内的地址索引**，供 `getLyrics` 取歌词（见那边的说明）。
 */
export function normalizeTrack(item, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  if (!isObject(item)) return null;
  const id = textOf(item.contentID ?? item.contentId ?? item.songCode) ?? trackIdOf(item);
  if (id === null) return null;
  const name = textOf(item.contentName ?? item.songName) ?? textOf(item.name);
  const albumPair = isObject(item.albumNamePair) ? item.albumNamePair : null;
  const albumId = textOf(item.albumID ?? item.albumId ?? albumPair?.id ?? albumPair?.albumID);
  const albumName = textOf(item.albumName ?? albumPair?.name ?? albumPair?.albumName);
  const coverUrl = coverUrlOf(item, isSafeUrl);
  if (typeof options.onLyricAddress === "function") {
    const lyricAddress = lyricAddressOf(item, { isSafeUrl });
    if (lyricAddress !== null) options.onLyricAddress(id, lyricAddress);
  }
  const track = { id };
  if (name !== null) track.name = name;
  const singer = artistsTextOf(item);
  if (singer !== null) track.singer = singer;
  if (albumId !== null) track.albumId = albumId;
  if (albumName !== null) track.albumName = albumName;
  if (coverUrl !== null) track.coverUrl = coverUrl;
  const duration = numberOrNull(item.duration);
  if (duration !== null) track.duration = duration;
  return track;
}

/** 歌单内容类型 → 语义（参考：官方 H5 的 4/5/7）。 */
export const PLAYLIST_KINDS = Object.freeze({ "4": "collected", "5": "owned", "7": "chart" });

/** 线上条目 → 内部歌单形状（渲染层读 `id`/`name`/`count`）。 */
export function normalizePlaylist(item, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  if (!isObject(item)) return null;
  const id = textOf(item.contentID ?? item.contentId ?? item.musicListID);
  const name = textOf(item.contentName ?? item.name);
  if (id === null || name === null) return null;
  const contentType = item.contentType === undefined || item.contentType === null ? null : String(item.contentType);
  const count = numberOrNull(item.totalCount ?? item.songCount ?? item.count);
  const coverUrl = coverUrlOf(item, isSafeUrl);
  const playlist = { id, name, kind: PLAYLIST_KINDS[contentType] ?? "unknown" };
  if (contentType !== null) playlist.contentType = contentType;
  if (count !== null) playlist.count = count;
  if (coverUrl !== null) playlist.coverUrl = coverUrl;
  const description = textOf(item.listDesc ?? item.description);
  if (description !== null) playlist.description = description;
  return playlist;
}

/**
 * 单页列表归一（R8 抽出：渐进加载器与"一次一页"的库页面频道共用同一套结论）。
 *
 * 三件事只在这里做一次：取列表（多容器名兼容）、**归一化并丢掉无 ID 的条目**（不编 ID）、
 * 读接口上报的 total（**只作记录**——收藏没有可信总数，真值是完整分页后的 ID 去重）。
 */
export function normalizeListPage(payload, options = {}) {
  const container = isObject(payload) ? payload : {};
  const list = extractList(container);
  const songs = [];
  let skipped = 0;
  for (const item of list) {
    const track = normalizeTrack(item, options);
    if (track === null) {
      skipped += 1;
      continue;
    }
    songs.push(track);
  }
  const reported = container.total ?? container.totalCount ?? container.totalNum;
  return {
    container,
    songs,
    skipped,
    received: list.length,
    // 真接口的数量字段**多为字符串**，所以按数值宽容读；读不出来就是 null（只作记录，从不当真值）
    reportedTotal: numberOrNull(reported),
  };
}

/** fileInfos 可能是 JSON 字符串，也可能是已解析的对象；坏 JSON 不抛。 */
export function parseFileInfos(value) {
  if (value === null || value === undefined || value === "") return { ok: false, reason: "missing" };
  if (typeof value === "object") return { ok: true, value };
  if (typeof value !== "string") return { ok: false, reason: "unsupported" };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false, reason: "unparsable" };
  }
}

/**
 * 试听判定：`auditionTime > 0` 记一个信号，标志位记另一个信号，**两个齐备**才算试听。
 * 只看 auditionTime 会把"整曲但带试听字段"误判成 30 秒片段（参考的会员样本实测就是
 * `auditionTime=30000` 却完整可播）。
 */
export function classifyAudition(payload, options = {}) {
  const flagKeys = options.flagKeys ?? DEFAULT_AUDITION_FLAG_KEYS;
  const signals = [];
  if (payload !== null && typeof payload === "object") {
    const raw = payload.auditionTime ?? payload.audition_time;
    const seconds = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) signals.push("auditionTime");
    if (flagKeys.some((key) => payload[key] === true || payload[key] === 1 || payload[key] === "true")) signals.push("flag");
  }
  return { auditionLikely: signals.includes("auditionTime") && signals.includes("flag"), signals };
}

/** 查询串清洗：丢空值/NaN/对象，字符串去首尾空白（GET 用）。 */
function cleanParams(params) {
  const cleaned = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) cleaned[key] = String(value);
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") cleaned[key] = trimmed;
      continue;
    }
    if (typeof value === "boolean") cleaned[key] = String(value);
  }
  return cleaned;
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * 已确认的音质（**声明的**音质要与实际返回对得上才算数，见参考 `confirmedPlaybackQuality`）。
 * `playQuality` 是接口回的音质码，`type` 是响应里声明的编码（mp3/flac 之类）。
 */
export function confirmedPlaybackQuality(playQuality, declaredType) {
  const quality = String(playQuality ?? "");
  const normalized = typeof declaredType === "string" ? declaredType.trim().toLowerCase() : "";
  const codec = /\bflac\b/.test(normalized) ? "flac" : /\bmp3\b/.test(normalized) || normalized === "audio/mpeg" ? "mp3" : undefined;
  if (quality === "3" && codec === "flac") return "lossless";
  if (quality === "1" && codec === "mp3") return "standard";
  return "unknown";
}

/**
 * 播放地址解码（纯函数，便于单独测试）。
 * @returns {{ok: true, data: object} | {ok: false, error: {message: string, kind: string}}}
 */
export function parsePlaybackPayload(raw, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("播放接口响应不是对象", MUSIC_ERROR_KINDS.invalidResponse);
  }

  const fileUrl = isNonEmptyString(raw.fileURL) ? raw.fileURL.trim() : null;
  if (fileUrl === null) {
    return err("播放接口响应里没有顶层 fileURL（它才是音频地址，fileInfos 只是音质列表）", MUSIC_ERROR_KINDS.invalidResponse);
  }
  if (!isSafeUrl(fileUrl)) {
    return err(`播放地址不在 CDN 白名单内：${hostOf(fileUrl) ?? "无法解析的域名"}`, MUSIC_ERROR_KINDS.unsafeMediaUrl);
  }

  const warnings = [];
  let fileInfos = null;
  if (raw.fileInfos !== undefined && raw.fileInfos !== null && raw.fileInfos !== "") {
    const parsed = parseFileInfos(raw.fileInfos);
    if (parsed.ok) fileInfos = parsed.value;
    else warnings.push("file_infos_unparsable");
  }

  const audition = classifyAudition(raw, { flagKeys: options.flagKeys });
  const songInfo = isObject(raw.songInfo) ? raw.songInfo : null;
  return ok({
    url: fileUrl,
    fileInfos,
    format: raw.format ?? null,
    size: raw.size ?? null,
    bitrate: raw.bitrate ?? null,
    duration: raw.duration ?? songInfo?.duration ?? null,
    actualQuality: confirmedPlaybackQuality(raw.playQuality ?? raw.qualityType, raw.type),
    auditionLikely: audition.auditionLikely,
    signals: audition.signals,
    warnings,
  });
}

/**
 * 歌词响应解码（R12；用于"设置里注入了一个独立歌词端点"的那条路）。
 *
 * 独立歌词端点的**响应形状没有实测证据**，所以这里仍按"多个候选键宽容读取"的老办法：
 * 拿到非空字符串就算歌词文本，一个都没有就如实回 `invalid_response`（**不猜**、不把
 * 整段响应体当歌词塞给渲染层——那只会让歌词窗显示一坨 JSON）。
 */
export function parseLyricsPayload(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("歌词接口响应不是对象", MUSIC_ERROR_KINDS.invalidResponse);
  }

  const warnings = [];
  const candidates = ["lyric", "lyrics", "lrc", "lyricText", "content", "text"];
  let text = null;
  let key = null;
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (isNonEmptyString(value)) {
      text = value;
      key = candidate;
      break;
    }
  }
  if (text === null && raw.data !== undefined && raw.data !== raw) {
    const nested = parseLyricsPayload(raw.data);
    if (nested.ok && isNonEmptyString(nested.data.text)) return nested;
    warnings.push("nested_shape_unrecognized");
  }
  if (text === null) {
    return err(
      `歌词接口响应里没有可识别的歌词文本（找过 ${candidates.join(" / ")}）`,
      MUSIC_ERROR_KINDS.invalidResponse,
    );
  }

  const format = isNonEmptyString(raw.format) ? raw.format.trim() : "lrc";
  if (key !== "lyric" && key !== "lyrics") warnings.push(`read_from_${key}`);
  return ok({ text, format, warnings });
}

/** `contentExInfo` 经常是 **JSON 字符串**（参考契约 §1）：能解就解，解不动当没有。 */
function contentExInfoOf(raw) {
  const extra = raw?.contentExInfo;
  if (isObject(extra)) return extra;
  if (typeof extra === "string") {
    try {
      const parsed = JSON.parse(extra);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 歌词地址/内嵌歌词的**候选容器**（R38 增补）。
 *
 * 为什么不止看响应本体（真机取证，2026-10-21）：曲目条目（`songSimpleInfos[]` 那一档）**自带
 * `lyricAddress`**（实测该批次 3/3 条都有，域在 `safe-media-url.mjs` 的白名单内）；
 * 而播放响应是按音频文件组织的，同一首歌的歌词地址未必平铺在顶层。
 * `songInfo` 正是**同一个曲目条目形状**（`parsePlaybackPayload` 也从它读 `duration`），
 * 所以它里面的 `lyricAddress` / `contentExInfo` 与顶层按同一份候选表读——
 * 这仍然是"读已有字段"，不是发明字段：所有候选都要过 CDN 白名单才算数。
 */
function lyricContainersOf(raw) {
  const containers = [raw];
  const songInfo = isObject(raw.songInfo) ? raw.songInfo : null;
  if (songInfo !== null) containers.push(songInfo);
  return containers;
}

/** 一个容器里的歌词地址候选（顺序即优先级：先本体的，再 `contentExInfo` 里那几种形态）。 */
function lyricAddressCandidatesOf(container) {
  const values = [container.lyricAddress, container.lyricAddres];
  const extra = contentExInfoOf(container);
  if (extra !== null) {
    values.push(extra.lyricAddress, extra.lyricAddres, extra.lyrics?.lyricAddress, extra.lyrics?.lineByLineLyric);
  }
  values.push(container.lyrics?.lineByLineLyric);
  return values;
}

/**
 * 歌词资源地址（参考 `lyricAddressFrom` 的字段清单，含历史拼写 `lyricAddres`）。
 * 只认 CDN 白名单内的地址——歌词资源同样走那条白名单。
 *
 * R38：候选容器从"响应本体"扩到"响应本体 + 内嵌曲目对象（`songInfo`）"，
 * 每个容器内部仍按同一份字段清单读（见 `lyricContainersOf`）。
 */
export function lyricAddressOf(raw, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  if (!isObject(raw)) return null;
  for (const container of lyricContainersOf(raw)) {
    for (const value of lyricAddressCandidatesOf(container)) {
      if (typeof value === "string" && isSafeUrl(value)) return value;
    }
  }
  return null;
}

/**
 * 内嵌歌词文本（参考 `inlineLyricsFrom`）：有的播放响应不给地址，直接把歌词塞在
 * `contentExInfo.lyrics` 里，而且**可能再套一层 JSON 字符串**（最多剥两层）。
 *
 * R38：与 `lyricAddressOf` 同一处扩到 `songInfo`（同一份候选表，不另立规则）。
 */
export function inlineLyricsOf(raw) {
  if (!isObject(raw)) return null;
  for (const container of lyricContainersOf(raw)) {
    const extra = contentExInfoOf(container) ?? {};
    const values = [extra.lyrics, extra.Lyrics, container.lyrics, container.Lyrics];
    for (const value of values) {
      const text = unwrapLyricValue(value);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * 专辑 id（R40）：**与 `normalizeTrack` 同一份候选表**（`albumID` 是已实证的那个名字——
 * 真机证据：专辑响应的 `$.albumInfoEx.songSimpleInfos[i]` 里有 `albumID`/`albumName`，
 * 见 `.tmp/r38-probe-lyrics.json`；`albumId`/`albumNamePair.id` 是同一处的历史拼写兜底）。
 *
 * 用途只有一个：歌词索引里没有这条曲目时，用专辑 id 去**既有**的专辑端点补一次条目
 * （见 `getLyrics` 的第 ④ 档）。取不到就是 null——**不猜**。
 */
export function albumIdOf(raw) {
  if (!isObject(raw)) return null;
  for (const container of lyricContainersOf(raw)) {
    const pair = isObject(container.albumNamePair) ? container.albumNamePair : null;
    const candidates = [container.albumID, container.albumId, pair?.id, pair?.albumID];
    for (const candidate of candidates) {
      const value = textOf(candidate);
      if (value !== null) return value;
    }
  }
  return null;
}

/** 对象顶层键名（**只记键名，不记值**；诊断用）。坏形状回空数组。 */
export function objectKeysOf(value, limit = 30) {
  if (!isObject(value)) return [];
  return Object.keys(value).sort().slice(0, Math.max(1, limit));
}

function unwrapLyricValue(value, depth = 0) {
  if (typeof value !== "string" || depth > 2) return null;
  const text = value.trim();
  if (text === "" || text.length > LYRICS_MAX_BYTES) return null;
  if (!text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text);
    return unwrapLyricValue(parsed?.lyric ?? parsed?.lyrics ?? parsed?.content ?? parsed?.lrc, depth + 1);
  } catch {
    return null;
  }
}

/** 是否还有下一页（各端点的判据不一样，逐条写在这里而不是到处猜）。 */
function favoritesHasMore(received, limit) {
  return received >= limit;
}

/**
 * 业务接口客户端。
 *
 * @param {{endpoints?: Record<string, string>, fetchImpl?: Function,
 *          session?: object|Function|null,
 *          sessionHeaders?: (context: {key: string, authenticated: boolean}) => Record<string, string>,
 *          pageSize?: number, maxPages?: number, flagKeys?: string[],
 *          isSafeUrl?: (url: string) => boolean, timeoutMs?: number,
 *          discoveryLimit?: number, discoveryPageCap?: number,
 *          lyricIndexLimit?: number, log?: Function}} options
 *
 * `session` 是 `{token, snsUserID}`（音乐会话；`snsUserID` 是收藏/歌单发现必需的
 * `targetSnsUserID` 来源）。可以传对象，也可以传函数（会话在运行时才会变——
 * 顶层装配时它多半还是 null）。
 */
export function createMusicApi(options = {}) {
  const endpoints = options.endpoints ?? {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sessionHeaders = options.sessionHeaders ?? (() => ({}));
  const defaultPageSize = positiveInt(options.pageSize, DEFAULT_PAGE_SIZE);
  const maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES);
  const discoveryLimit = positiveInt(options.discoveryLimit, DEFAULT_DISCOVERY_LIMIT);
  const discoveryPageCap = positiveInt(options.discoveryPageCap, DEFAULT_DISCOVERY_PAGE_CAP);
  const flagKeys = options.flagKeys ?? DEFAULT_AUDITION_FLAG_KEYS;
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  const timeoutMs = positiveInt(options.timeoutMs, MUSIC_TIMEOUT_MS);
  const sessionSource = options.session;
  /**
   * 诊断口（R40）：**只记键名**的日志（协议层自己不写日志，与 `createHuaweiMusicSessionPort`
   * 的 `log` 同一条纪律）。目前只有一处用：歌词回落到专辑补索引时，把播放响应的键名记下来
   * ——"播放响应里到底有没有 `albumID`"这句话没有实证，靠这一行在真机上看到，而不是靠猜。
   */
  const log = typeof options.log === "function" ? options.log : () => undefined;
  /** 被设置**显式关闭**的端点（`musicEndpoints: {favorites: null}`）：报错要说得比"尚未确定"更准。 */
  const disabledEndpoints = new Set(options.disabledEndpoints ?? []);

  /**
   * 曲目条目里的歌词地址**进程内索引**（R38）：`trackId → 白名单内的歌词地址`。
   *
   * 为什么需要它（真机取证 2026-10-21）：华为的曲目条目自带 `lyricAddress`（列表/专辑响应
   * `songSimpleInfos[]` 实测该批次 3/3 有，域在白名单内），而
   * **播放响应里没有**——`getLyrics` 从前只问播放响应，所以永远拿不到歌词。
   * 官方 H5 也是拿列表里那条地址，而不是"按曲目 id 再问一次歌词"。
   *
   * 三条边界：
   * 1. **只在进程内存**：不落盘、不进设置、不跨进程（sidecar 重启即空，没有"上次的地址还能用"的假象）；
   * 2. **只记已经加载过的条目**：用户没在列表里见过的曲目，索引里就没有（那时仍走播放响应那条路）；
   * 3. **有上限、先进先出**：浏览几千首也不会让这张表无界增长。
   * 另外地址可能带时效签名——取歌词时**先过一遍白名单**，下载失败就照旧回落到播放响应那条路。
   */
  const lyricAddressIndex = new Map();
  const lyricAddressIndexLimit = positiveInt(options.lyricIndexLimit, 400);

  function rememberLyricAddress(trackId, address) {
    if (!isNonEmptyString(trackId) || !isNonEmptyString(address)) return;
    if (!isSafeUrl(address)) return;
    // 重新记一次要挪到队尾（"最近见过"才是最可能还有效的那个）
    if (lyricAddressIndex.has(trackId)) lyricAddressIndex.delete(trackId);
    lyricAddressIndex.set(trackId, address);
    while (lyricAddressIndex.size > lyricAddressIndexLimit) {
      const oldest = lyricAddressIndex.keys().next().value;
      lyricAddressIndex.delete(oldest);
    }
  }

  /** 取索引里的地址（**再过一次白名单**：索引里的东西也要自己证明自己还在名单内）。 */
  function indexedLyricAddress(trackId) {
    const value = lyricAddressIndex.get(trackId);
    if (typeof value !== "string") return null;
    return isSafeUrl(value) ? value : null;
  }

  /** 曲目归一化的共同选项：白名单校验 + 顺手把歌词地址记进索引（唯一一处拼它）。 */
  const trackOptions = { isSafeUrl, onLyricAddress: rememberLyricAddress };

  /** 当前音乐会话（对象或"返回对象的函数"两种传法都认）。 */
  function currentSession() {
    const value = typeof sessionSource === "function" ? sessionSource() : sessionSource;
    return isObject(value) ? value : null;
  }

  function sessionTokenOf() {
    const session = currentSession();
    return isNonEmptyString(session?.token) ? session.token : null;
  }

  function snsUserIDOf() {
    const session = currentSession();
    return isNonEmptyString(session?.snsUserID) ? session.snsUserID : null;
  }

  /** 端点解析：非 https / 空值 = "端点尚未确定"，绝不猜。 */
  function endpointOf(key) {
    const value = endpoints[key];
    if (disabledEndpoints.has(key)) {
      return err(
        `接口端点 ${key} 被设置显式关闭（settings.data.musicEndpoints.${key} = null）`,
        MUSIC_ERROR_KINDS.endpointUnknown,
      );
    }
    if (!isNonEmptyString(value)) {
      return err(
        `接口端点 ${key} 尚未确定（默认值见 src/main/music-service.mjs，可在设置里覆盖或显式关闭）`,
        MUSIC_ERROR_KINDS.endpointUnknown,
      );
    }
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      return err(`接口端点 ${key} 不是合法 URL`, MUSIC_ERROR_KINDS.endpointUnknown);
    }
    if (url.protocol !== "https:") {
      return err(`接口端点 ${key} 不是 https（拒绝明文传输）`, MUSIC_ERROR_KINDS.endpointUnknown);
    }
    return ok(url.href);
  }

  /** 一次业务调用：方法/参数位置/头/超时/重试都按参考的 `#request` 形状。 */
  async function call(key, { params = {}, retry = true } = {}) {
    const endpoint = endpointOf(key);
    if (!endpoint.ok) return endpoint;

    const authenticated = MUSIC_AUTHENTICATED_ENDPOINTS.includes(key);
    if (authenticated && sessionTokenOf() === null) {
      return err(`此操作需要音乐会话（先登录）：接口 ${key}`, MUSIC_ERROR_KINDS.sessionRequired);
    }

    const method = MUSIC_ENDPOINT_METHODS[key] ?? "POST";
    const url = new URL(endpoint.data);
    if (method === "GET") {
      for (const [name, value] of Object.entries(cleanParams(params))) url.searchParams.set(name, value);
    }

    const headers = { "content-type": "application/json", ...sessionHeaders({ key, authenticated }) };
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (method === "POST") {
      // 参数逐个原样进 JSON 体（参考就是这么发的：数字是数字、数组是数组、
      // 该是字符串的字段在各自的构造点已经是字符串）。
      init.body = JSON.stringify(params ?? {});
    }

    const attempts = retry ? 2 : 1;
    let response = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await fetchImpl(url.href, init);
        break;
      } catch (cause) {
        if (attempt === attempts - 1) {
          return err(`请求 ${key} 失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.networkError);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!response || typeof response.ok !== "boolean") {
      return err(`请求 ${key} 未返回可识别的响应`, MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (!response.ok) {
      // 不读响应体：网关/代理错误页里可能带内部信息
      return err(`请求 ${key} 返回 HTTP ${response.status}`, MUSIC_ERROR_KINDS.httpError);
    }

    let raw;
    try {
      raw = await response.json();
    } catch {
      return err(`请求 ${key} 的响应不是 JSON`, MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (raw === null || typeof raw !== "object") {
      return err(`请求 ${key} 的响应不是 JSON 对象`, MUSIC_ERROR_KINDS.invalidResponse);
    }
    const decoded = decodeEnvelope(raw);
    // 业务码失败与成功都带上原始响应体（各操作要按各自的容器名取数据，
    // 失败时也常要靠容器名判断"是哪条路由不对"）。
    return Object.assign(decoded, { raw });
  }

  /** `page` → `start`（协议层唯一一处换算：通道契约仍然是页号）。 */
  function startOf(page, pageSize) {
    return (positiveInt(page, 1) - 1) * positiveInt(pageSize, defaultPageSize);
  }

  /** 收藏一页（R32：`contentTypes` 现在真的会被带上——决定"要歌曲"还是"要歌单"）。 */
  function favoritesPageBody({ start, limit, contentTypes }) {
    const snsUserID = snsUserIDOf();
    if (snsUserID === null) return null;
    return { targetSnsUserID: snsUserID, start, limit, contentTypes: [...contentTypes] };
  }

  async function listFavoritesPage(request = {}) {
    // 与 listPlaylists 同一个顺序：先说"端点没配"，再说"没登录"（从外到里，用户才知道下一步做什么）
    const endpoint = endpointOf("favorites");
    if (!endpoint.ok) return endpoint;
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const body = favoritesPageBody({
      start: startOf(page, pageSize),
      limit: pageSize,
      contentTypes: request.contentTypes ?? MUSIC_SONG_CONTENT_TYPES,
    });
    if (body === null) {
      return err("收藏接口需要音乐会话里的 SNS 用户标识（先登录）", MUSIC_ERROR_KINDS.sessionRequired);
    }
    return call("favorites", { params: body });
  }

  /**
   * 渐进式收藏加载器（渲染层滚动加载用）。
   * `total` 只在**完整分页走完**后才有值（= 去重后的 ID 数），否则为 null：
   * "已加载 N 首"用 loadedCount，"共 M 首"只能等走完才敢写。
   */
  function createFavoritesLoader(loaderOptions = {}) {
    const pageSize = positiveInt(loaderOptions.pageSize, defaultPageSize);
    const pageLimit = positiveInt(loaderOptions.maxPages, maxPages);

    const songs = [];
    const seen = new Set();
    let skipped = 0;
    let pages = 0;
    let reportedTotal = null;
    let done = false;
    let stopReason = null;

    const isComplete = () => done && stopReason === "exhausted";

    function snapshot() {
      return {
        songs: [...songs],
        loadedCount: songs.length,
        total: isComplete() ? songs.length : null,
        reportedTotal,
        skipped,
        pages,
        isComplete: isComplete(),
        stopReason,
      };
    }

    function accept(page) {
      const normalized = normalizeListPage(page, trackOptions);
      skipped += normalized.skipped;
      let added = 0;
      for (const item of normalized.songs) {
        const id = trackIdOf(item);
        if (seen.has(id)) continue;
        seen.add(id);
        songs.push(item);
        added += 1;
      }
      if (normalized.reportedTotal !== null) reportedTotal = normalized.reportedTotal;
      return { added, received: normalized.received, container: normalized.container };
    }

    async function loadNext() {
      if (done) {
        return ok({ added: 0, loadedCount: songs.length, total: snapshot().total, isComplete: isComplete(), stopReason });
      }

      const nextPage = pages + 1;
      const result = await listFavoritesPage({ page: nextPage, pageSize });
      if (!result.ok) {
        // 如实停下并保留已加载内容；不置 done，调用方可以重试同一页
        stopReason = "error";
        return result;
      }

      pages = nextPage;
      const { added, received } = accept(result.data);

      // 判据 = 参考的"整页返回即可能还有"（真接口不发 hasMore）
      if (favoritesHasMore(received, pageSize)) {
        if (pages >= pageLimit) {
          done = true;
          stopReason = "max_pages";
        }
      } else {
        done = true;
        stopReason = "exhausted";
      }

      return ok({ added, loadedCount: songs.length, total: snapshot().total, isComplete: isComplete(), stopReason });
    }

    async function loadAll() {
      while (!done) {
        const step = await loadNext();
        if (!step.ok) return step;
      }
      return ok(snapshot());
    }

    return { loadNext, loadAll, snapshot };
  }

  async function loadAllFavorites(loaderOptions = {}) {
    return createFavoritesLoader(loaderOptions).loadAll();
  }

  /**
   * 单页收藏读取（R8 的滚动加载走这条）：把**分页结论**在协议层算好——渲染层不必、也不许
   * 自己猜 "还有没有下一页"。刻意不给 `total`：收藏没有可信总数，"共 M 首"只能等
   * 完整分页后去重才知道，那是拼页者的结论，不是单页的结论。
   */
  async function readFavoritesPage(request = {}) {
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const result = await listFavoritesPage({ page, pageSize });
    if (!result.ok) return result;
    const normalized = normalizeListPage(result.data, trackOptions);
    return ok({
      page,
      pageSize,
      songs: normalized.songs,
      skipped: normalized.skipped,
      reportedTotal: normalized.reportedTotal,
      hasMore: favoritesHasMore(normalized.received, pageSize),
    });
  }

  /**
   * **我的歌单**（R32 起按参考的发现流程走）。
   *
   * 为什么不能"一页拿完就交"：歌单与歌曲**混在同一个分页列表里**（`contentTypes=[1,4,5,7]`），
   * 首页很可能整页都是歌曲——直接过滤首页就会显示"还没有歌单"，而用户明明有。
   * 所以这里照参考的做法翻页：翻到短页、翻到"这一页没带来新条目"、或触到保守上限为止，
   * 再把歌单条目挑出来（`contentType != 1`，按 `contentType:id` 去重）。
   *
   * `start` 的起点仍然是通道给的页号（`page=1` 即参考的"从头扫"）。
   */
  async function listPlaylists(request = {}) {
    // 先报"端点没配"，再报"没登录"：两件事按从外到里的顺序说，用户才知道下一步该干什么
    const endpoint = endpointOf("playlistList");
    if (!endpoint.ok) return endpoint;
    if (snsUserIDOf() === null) {
      return err("歌单列表需要音乐会话里的 SNS 用户标识（先登录）", MUSIC_ERROR_KINDS.sessionRequired);
    }

    let start = startOf(request.page, request.pageSize ?? discoveryLimit);
    const seen = new Set();
    const playlists = [];
    let truncated = true;
    let scanned = 0;

    for (let index = 0; index < discoveryPageCap; index += 1) {
      const body = favoritesPageBody({ start, limit: discoveryLimit, contentTypes: MUSIC_LIBRARY_CONTENT_TYPES });
      const page = await call("playlistList", { params: body });
      if (!page.ok) return page;
      const items = extractList(page.data);
      scanned += items.length;
      let fresh = 0;
      for (const item of items) {
        if (!isObject(item)) continue;
        const contentType = item.contentType === undefined || item.contentType === null ? "" : String(item.contentType);
        const rawId = textOf(item.contentID ?? item.contentId ?? item.musicListID);
        if (rawId === null) continue;
        const key = `${contentType}:${rawId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // `fresh` 数的是**所有新条目**（含歌曲）——这是参考的判据，也是"没有进展就停"的唯一依据。
        // 只数歌单会怎样：首页整页都是新歌时 fresh=0 → 立刻停 → 界面上"还没有歌单"，而用户明明有。
        fresh += 1;
        // 歌曲（contentType=1）不进歌单列表：它属于收藏那一条路
        if (contentType === "1") continue;
        const playlist = normalizePlaylist(item, { isSafeUrl });
        if (playlist === null) continue;
        playlists.push(playlist);
      }
      start += discoveryLimit;
      if (items.length < discoveryLimit || fresh === 0) {
        truncated = false;
        break;
      }
    }

    return ok({ playlists, hasMore: truncated, scanned });
  }

  /**
   * 歌单曲目：自建（type=5，`playlistDetail`）与收藏（type=4，`playlistDetailPublic`）
   * 是**两个不同的端点**，而通道只带 `playlistId`（渲染层不知道 kind）。
   *
   * 所以默认 `kind='auto'` = 先自建、拿不到歌单元信息再试公开那条；`kind` 显式给了就只走那一条。
   * 这不是"猜"：两条路由都是参考实测存在且形状明确的，响应用 `playListInfoEx` / `musicListInfoEx`
   * 自证身份——哪条路真的回了歌单，就从哪条路取。
   */
  async function getPlaylistDetail(playlistId, request = {}) {
    if (!isNonEmptyString(playlistId)) return err("歌单曲目接口需要 playlistId", MUSIC_ERROR_KINDS.missingParam);
    const id = playlistId.trim();
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const start = startOf(page, pageSize);
    const kind = request.kind ?? "auto";

    const failures = [];

    async function owned() {
      const result = await call("playlistDetail", { params: { playListID: id, start, limit: pageSize } });
      if (!result.ok) return { failure: result };
      const container = pickPath(result.data, "playListInfoEx");
      if (!isObject(container)) return { empty: true, result };
      const songs = extractList({ list: container.playListSongInfoList ?? [] }).map((item) => normalizeTrack(item, trackOptions)).filter((track) => track !== null);
      const playlist = normalizePlaylist({ ...(isObject(container.playListInfo) ? container.playListInfo : {}), contentType: "5" }, { isSafeUrl });
      return { songs, playlist, received: Array.isArray(container.playListSongInfoList) ? container.playListSongInfoList.length : 0 };
    }

    async function collected() {
      const result = await call("playlistDetailPublic", {
        params: { musicListID: id, copyrightSwitch: "1", start, limit: String(pageSize) },
      });
      if (!result.ok) return { failure: result };
      const container = pickPath(result.data, "musicListInfoEx");
      if (!isObject(container)) return { empty: true, result };
      const songs = extractList({ list: container.songSimpleInfos ?? [] }).map((item) => normalizeTrack(item, trackOptions)).filter((track) => track !== null);
      const detail = isObject(container.musicListDetail) ? container.musicListDetail : {};
      const playlist = normalizePlaylist({ ...detail, contentType: detail.contentType ?? "4" }, { isSafeUrl });
      return { songs, playlist, received: Array.isArray(container.songSimpleInfos) ? container.songSimpleInfos.length : 0 };
    }

    const order = kind === "owned" ? [owned] : kind === "collected" ? [collected] : [owned, collected];
    for (const attempt of order) {
      const found = await attempt();
      if (found.failure) {
        failures.push(found.failure);
        continue;
      }
      if (found.empty) continue;
      return ok({
        playlistId: id,
        playlist: found.playlist,
        songs: found.songs,
        hasMore: found.received >= pageSize,
      });
    }

    // 两条路都没给出歌单：如实报第一段的失败（网络/端点/业务码），都已成功但内容为空则报 invalid_response
    if (failures.length > 0) return failures[0];
    return err(`歌单详情里没有歌单元信息（playlistId=${id.slice(0, 40)}）`, MUSIC_ERROR_KINDS.invalidResponse);
  }

  /** 自建歌单删除：**只走 playlistDelete**（拿收藏端点删歌单会拿到"成功"码却没删掉）。 */
  async function deletePlaylist(playlistId, request = {}) {
    if (!isNonEmptyString(playlistId)) return err("删除歌单需要 playlistId", MUSIC_ERROR_KINDS.missingParam);
    const result = await call("playlistDelete", {
      params: { playListID: playlistId.trim() },
      retry: false,
    });
    if (!result.ok) return result;
    return ok({ deleted: true, playlistId: playlistId.trim() });
  }

  async function search(keyword, request = {}) {
    if (!isNonEmptyString(keyword)) return err("搜索关键字为空", MUSIC_ERROR_KINDS.missingParam);
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const result = await call("search", {
      params: {
        contentType: "1",
        correct: "1",
        queryWord: keyword.trim().slice(0, 80),
        start: String(startOf(page, pageSize)),
        limit: String(pageSize),
      },
    });
    if (!result.ok) return result;
    const normalized = normalizeListPage(result.data, trackOptions);
    return ok({
      songs: normalized.songs,
      skipped: normalized.skipped,
      reportedTotal: normalized.reportedTotal,
      hasMore: String(result.data.hasNextPage ?? "") === "1",
    });
  }

  async function getAlbum(albumId, request = {}) {
    if (!isNonEmptyString(albumId)) return err("专辑接口需要 albumId", MUSIC_ERROR_KINDS.missingParam);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const result = await call("album", {
      params: { albumCode: albumId.trim(), start: startOf(request.page, pageSize), limit: pageSize },
    });
    if (!result.ok) return result;
    const container = pickPath(result.data, "albumInfoEx") ?? {};
    const songs = extractList({ list: container.songSimpleInfos ?? [] })
      .map((item) => normalizeTrack(item, trackOptions))
      .filter((track) => track !== null);
    return ok({
      albumId: albumId.trim(),
      songs,
      detail: result.data,
      hasMore: Array.isArray(container.songSimpleInfos) ? container.songSimpleInfos.length >= pageSize : false,
    });
  }

  async function getArtist(artistId, request = {}) {
    if (!isNonEmptyString(artistId)) return err("歌手接口需要 artistId", MUSIC_ERROR_KINDS.missingParam);
    const songNum = positiveInt(request.songNum, 20);
    const albumNum = positiveInt(request.albumNum, 20);
    const result = await call("artist", {
      params: { artistCode: artistId.trim(), songNum, albumNum },
    });
    if (!result.ok) return result;
    const container = pickPath(result.data, "artistInfoEx") ?? {};
    const songs = extractList({ list: container.songSimpleInfos ?? [] })
      .map((item) => normalizeTrack(item, trackOptions))
      .filter((track) => track !== null);
    // 歌手页的曲目是**有限列表**（参考：start 分页未验证，不造无限滚动接口）
    return ok({ artistId: artistId.trim(), songs, detail: result.data });
  }

  /** 播放历史：参考只验证了 `contentType=1` 这一条查询，**不承诺无限翻页**。 */
  async function getHistory(request = {}) {
    const result = await call("history", { params: { contentType: "1" } });
    if (!result.ok) return result;
    const normalized = normalizeListPage(result.data, trackOptions);
    return ok({ songs: normalized.songs, skipped: normalized.skipped, hasMore: false, reportedTotal: normalized.reportedTotal });
  }

  /**
   * 播放地址（R32 换血：`contentCode`/`contentType`/`qualityType` 进 JSON 体；
   * 音质只认 standard/lossless 两个值，别的一律如实回 `quality_unsupported`——不猜也不用别的音质顶替）。
   */
  async function getPlayback(request = {}) {
    const trackId = request.trackId ?? request.id;
    if (!isNonEmptyString(trackId)) return err("播放地址接口需要 trackId", MUSIC_ERROR_KINDS.missingParam);
    const quality = request.quality ?? "standard";
    const qualityType = MUSIC_QUALITY_TYPES[quality];
    if (qualityType === undefined) {
      return err(`不支持的音质：${String(quality).slice(0, 20)}（只认 standard / lossless）`, MUSIC_ERROR_KINDS.qualityUnsupported);
    }
    const result = await call("playback", {
      params: { contentCode: trackId.trim(), contentType: "1", qualityType },
    });
    if (!result.ok) return result;
    return parsePlaybackPayload(result.data, { isSafeUrl, flagKeys });
  }

  /**
   * 歌词文本（R12；R32 起默认**从播放响应推导**；R38 起先看列表条目里那条地址；
   * R40 增补"按专辑补条目索引"的第四档）。
   *
   * 四条路，按"最可能有、最便宜"排序：
   * 1. 设置里显式注入过 `musicEndpoints.lyrics` → 直接打那个端点（形状按候选键宽容读取）；
   * 2. **已加载过的曲目条目里那条 `lyricAddress`**（见 `lyricAddressIndex`）：官方 H5 走的就是
   *    列表里这条地址；命中就省掉一次播放请求。地址可能带时效签名——下载失败不算结论，继续往下走；
   * 3. 播放响应：`lyricAddress`（白名单内，含内嵌的 `songInfo`）→ 下载文本；
   *    没有地址就看内嵌的 `contentExInfo.lyrics`。
   * 4. **专辑补索引**（R40）：播放响应里既没有地址也没有内嵌歌词时，用它给的专辑 id 去
   *    **既有**的专辑端点拉一次详情——那条响应的条目自带 `lyricAddress`（真机实测 3/3 有），
   *    归一化时顺手进索引，于是"本次运行从没在任何列表里加载过"的曲目（典型：重启后直接播
   *    恢复出来的队列，见 docs/KNOWN_LIMITATIONS.md B23）也还有一次机会。
   *    **代价与边界**：多一次专辑请求（只在前面几档全落空时才发生）；专辑 id 只能来自**播放响应
   *    自己承认的字段**（`albumID`，与 `normalizeTrack` 同一份候选表）——它没给就没有这一档，
   *    仍然如实回 `invalid_response`（不猜 id、不编地址）。
   *
   * 四条都没有才回 `invalid_response`，且**不把整段响应体当歌词**塞给渲染层。
   * 拿到的文本**不进日志、不落盘**：它只经这一帧交给渲染层。
   */
  async function getLyrics(request = {}) {
    const trackId = request.trackId ?? request.id;
    if (!isNonEmptyString(trackId)) return err("歌词接口需要 trackId", MUSIC_ERROR_KINDS.missingParam);
    const id = trackId.trim();

    if (isNonEmptyString(endpoints.lyrics)) {
      const direct = await call("lyrics", { params: { contentID: id, contentType: "1" } });
      if (!direct.ok) return direct;
      return parseLyricsPayload(direct.data);
    }

    const warnings = [];

    // ② 进程内索引里那条地址（用户已经加载过的列表条目自带的）
    const indexed = indexedLyricAddress(id);
    if (indexed !== null) {
      const fetched = await fetchLyricsText(indexed);
      if (fetched.ok) return ok({ text: fetched.data, format: "lrc", warnings });
      // 地址过期/被拒：如实记一笔，继续走播放响应那条路（它可能给出一个新地址）
      warnings.push(fetched.error.kind);
    }

    // ③ 播放响应（含内嵌 songInfo 的同一份候选表）
    const qualityType = MUSIC_QUALITY_TYPES[request.quality ?? "standard"] ?? MUSIC_QUALITY_TYPES.standard;
    const result = await call("playback", {
      params: { contentCode: id, contentType: "1", qualityType },
    });
    if (!result.ok) return result;

    const address = lyricAddressOf(result.data, { isSafeUrl });
    if (address !== null) {
      const fetched = await fetchLyricsText(address);
      if (fetched.ok) return ok({ text: fetched.data, format: "lrc", warnings });
      warnings.push(fetched.error.kind);
    }
    const inline = inlineLyricsOf(result.data);
    if (inline !== null) return ok({ text: inline, format: "lrc", warnings });

    // ④ 专辑补索引（R40）：播放响应里没有歌词地址，就用它给的专辑 id 去**既有**的专辑端点
    //    拉一次详情——`getAlbum` 走的是同一套归一化（`trackOptions`），条目自带的 `lyricAddress`
    //    会顺手进索引，于是"从没在任何列表里加载过的曲目"（典型：重启后直接播恢复出来的队列）
    //    也还有一次机会。取不到专辑 id 就照旧如实回下面那个 `invalid_response`（不猜、不编地址）。
    const albumId = albumIdOf(result.data);
    if (albumId !== null) {
      // 只记键名（不记值，**连专辑 id 的值也不记**）：这条路的成败取决于"播放响应里到底有没有
      // albumID"，而那个形状一直没有实证——下一台真机跑一次就能从这一行看出来（协议层不自造事实）。
      log(
        "歌词回落：播放响应里没有歌词地址，按专辑补一次条目索引" +
          `（只记键名，不记值）｜播放响应顶层键名：${objectKeysOf(result.data).join(", ")}` +
          `｜songInfo 键名：${objectKeysOf(result.data.songInfo).join(", ")}`,
      );
      const album = await getAlbum(albumId, {});
      if (!album.ok) {
        warnings.push(album.error.kind ?? "album_failed");
      } else {
        const indexed = indexedLyricAddress(id);
        if (indexed !== null) {
          const fetched = await fetchLyricsText(indexed);
          if (fetched.ok) return ok({ text: fetched.data, format: "lrc", warnings });
          warnings.push(fetched.error.kind);
        } else {
          warnings.push("album_without_this_track");
        }
      }
    }

    return err(
      "这首歌没有可用的歌词（已加载的曲目条目与播放响应里都没有白名单内的歌词地址，也没有内嵌歌词）",
      MUSIC_ERROR_KINDS.invalidResponse,
    );
  }

  /** 下载歌词文本（有上限、不跟随跳转、只认白名单地址已在上面查过）。 */
  async function fetchLyricsText(address) {
    let response;
    try {
      response = await fetchImpl(address, {
        method: "GET",
        headers: { accept: "text/plain,*/*" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (cause) {
      return err(`歌词资源请求失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.networkError);
    }
    if (!response || typeof response.ok !== "boolean") {
      return err("歌词资源未返回可识别的响应", MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (!response.ok) return err(`歌词资源返回 HTTP ${response.status}`, MUSIC_ERROR_KINDS.httpError);
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      return err(`歌词资源读取失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (typeof text !== "string") return err("歌词资源不是文本", MUSIC_ERROR_KINDS.invalidResponse);
    if (text.length > LYRICS_MAX_BYTES) return err("歌词资源过大", MUSIC_ERROR_KINDS.invalidResponse);
    if (text.trim() === "") return err("歌词资源是空的", MUSIC_ERROR_KINDS.invalidResponse);
    return ok(text);
  }

  return {
    endpointOf,
    call,
    listFavoritesPage,
    readFavoritesPage,
    createFavoritesLoader,
    loadAllFavorites,
    listPlaylists,
    getPlaylistDetail,
    deletePlaylist,
    search,
    getAlbum,
    getArtist,
    getHistory,
    getPlayback,
    getLyrics,
  };
}

/** 播放地址白名单校验的转发（渲染层/上层不必再 import 两个模块）。 */
export function safePlaybackUrl(value) {
  return safeMediaUrl(value);
}
