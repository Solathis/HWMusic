/**
 * 华为音乐业务接口（协议原型层）：只登记路径形状，绝对 URL 由调用方注入。
 * 线上字段（contentID/contentName…）在这里统一归一成渲染层认的 id/name。
 * 收藏没有可信总数：总数取完整分页后 ID 去重，接口上报值仅作记录。
 * 播放响应的顶层 fileURL 才是音频地址；试听要 auditionTime 与标志位同时成立。
 * 报错只带状态码/域名，会话凭据不经日志；自建歌单删除必须走 playlistDelete。
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
  /** 歌词端点：只在设置里显式注入时使用，默认从播放响应推导（见 getLyrics）。 */
  lyrics: null,
});

/** 每个端点的 HTTP 方法（实测固定）；写死在这里，不让调用方猜。 */
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
/** "我的歌单"发现用的内容类型（1=歌曲、4=收藏歌单、5=自建歌单、7=榜单），调用方按 contentType 分流。 */
export const MUSIC_LIBRARY_CONTENT_TYPES = Object.freeze(["1", "4", "5", "7"]);

/** 音质 → qualityType（standard="1"、lossless="3"）；其余档位不认，不猜。 */
export const MUSIC_QUALITY_TYPES = Object.freeze({ standard: "1", lossless: "3" });

/** 业务端点键名（唯一真源；每个键都要由调用方注入，缺一个就少一个可用接口）。 */
export const MUSIC_ENDPOINT_KEYS = [
  "favorites",
  "playlistList",
  /** 歌单曲目：歌单列表只有元信息，曲目必须单独取。 */
  "playlistDetail",
  /** 公开/收藏歌单详情的第二条路由，按歌单归属与 playlistDetail 二选一。 */
  "playlistDetailPublic",
  "playlistDelete",
  "search",
  "album",
  "artist",
  "history",
  "playback",
  /** 独立歌词端点（可选）：默认走播放响应推导，见 MUSIC_ENDPOINT_PATHS.lyrics。 */
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
  /** 歌词缓存不可用：宿主没给数据目录，属环境问题，而非"这首没有歌词"。 */
  cacheUnavailable: "cache_unavailable",
  /** 响应已过期：请求在途时会话换了或歌单重开，这份数据属于过去，必须丢弃而不是重试。 */
  staleResponse: "stale_response",
};

/** 能佐证"这是试听片段"的标志位候选（与 auditionTime 齐备才算试听）。 */
export const DEFAULT_AUDITION_FLAG_KEYS = ["isAudition", "audition", "tryListen", "trialFlag", "isTry"];

/** 列表容器候选名，真实名在前（favoriteInfos 收藏、songSimpleInfos 搜索、contentSimpleInfos 历史）。 */
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

/** 解业务信封：HTTP 成功且 result.resultCode === "000000" 才算成功；返回整个响应体，容器由调用方取。 */
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
 * 时长上限（秒）：超过 24 小时的"时长"一律是坏数据，宁可显示占位符。
 */
const TRACK_DURATION_SECONDS_LIMIT = 24 * 3600;

function durationSeconds(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds < TRACK_DURATION_SECONDS_LIMIT ? seconds : null;
}

/** 资源是否显式声明 MP3：format/mediaFileType 出现过的值必须全部读作 MP3，都没写则为 false。 */
function declaresMp3(resource) {
  const formats = [resource.format, resource.mediaFileType].filter((value) => value !== undefined && value !== null && value !== "");
  if (formats.length === 0) return false;
  return formats.every((value) => typeof value === "string" && value.trim().toUpperCase() === "MP3");
}

/** 是否为标准音质档：真机是字符串 "1"，容忍数字 1，别的值一律不认。 */
function isStandardQuality(quality) {
  return quality !== undefined && quality !== null && quality !== "" && String(quality) === MUSIC_QUALITY_TYPES.standard;
}

/** 音质档的标识形状：整数或纯数字串，返回档位字符串；没声明或形状认不出则为 null。 */
function qualityIdOf(quality) {
  if (typeof quality === "number") return Number.isInteger(quality) && quality >= 0 ? String(quality) : null;
  if (typeof quality !== "string") return null;
  return /^\d+$/.test(quality) ? quality : null;
}

function resourceDuration(resource) {
  if (!isObject(resource) || !declaresMp3(resource)) return null;
  return durationSeconds(resource.duration);
}

/** 条目里所有"音质档 → 资源"候选：completeFileInfos 与 fileInfos 都读，对象 key 即档位；fileType 不参与编码判断。 */
function resourceCandidates(item) {
  const extra = contentExInfoOf(item);
  const candidates = [];
  const collect = (container) => {
    if (Array.isArray(container)) {
      for (const resource of container) {
        if (!isObject(resource)) continue;
        candidates.push({ quality: resource.quality, resource });
      }
      return;
    }
    if (!isObject(container)) return;
    for (const [key, resource] of Object.entries(container)) {
      if (!isObject(resource)) continue;
      const own = resource.quality;
      candidates.push({ quality: own === undefined || own === null || own === "" ? key : own, resource });
    }
  };
  collect(extra?.completeFileInfos);
  collect(extra?.fileInfos);
  return candidates;
}

// 条目时长（秒）：顶层 duration 优先，其次明确声明 MP3 的音质档资源，标准档排第一顺位。
// 秒数只认有限正数、不读 times、不按毫秒估；非 MP3 编码（MKV/M4A/FLAC/空）一律不取。
export function durationOfEntry(item) {
  const duration = durationSeconds(item?.duration);
  if (duration !== null) return duration;
  // 只有"档位明确的显式 MP3"才是候选（没声明档位的资源在这里就被排除了）
  const candidates = resourceCandidates(item).filter((entry) => qualityIdOf(entry.quality) !== null);
  // ① 标准档第一顺位
  for (const entry of candidates) {
    if (!isStandardQuality(entry.quality)) continue;
    const seconds = resourceDuration(entry.resource);
    if (seconds !== null) return seconds;
  }
  // ② 其余明确声明 MP3 的档位兜底（标准档已在上面取过）
  for (const entry of candidates) {
    if (isStandardQuality(entry.quality)) continue;
    const seconds = resourceDuration(entry.resource);
    if (seconds !== null) return seconds;
  }
  return null;
}

/** 线上条目 → 内部曲目形状；没有 id 的条目返回 null（调用方丢弃并计数，绝不编 id）。
 *  条目自带的 lyricAddress 不进投影，经 options.onLyricAddress 交给调用方建索引。 */
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
  const duration = durationOfEntry(item);
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

/** 单页列表归一：取列表、归一化并丢掉无 ID 条目、读上报 total（只作记录，真值是分页后 ID 去重）。 */
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

/** 试听判定：auditionTime > 0 与标志位两个信号齐备才算 30 秒片段，只看前者会误判整曲。 */
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

/** 独立歌词端点响应解码：形状无实测证据，按多个候选键宽容取非空字符串，取不到如实报 invalid_response。 */
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

/** 歌词候选容器：响应本体与内嵌 songInfo（同一曲目条目形状），取出的地址都要过 CDN 白名单。 */
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

/** 歌词资源地址（含历史拼写 lyricAddres）；候选容器见 lyricContainersOf，只认白名单内地址。 */
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

/** 内嵌歌词文本：contentExInfo.lyrics 可能再套一层 JSON 字符串（最多剥两层）。 */
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

/** 专辑 id（候选同 normalizeTrack）：只用于歌词索引缺这首时补取专辑条目，取不到即 null，不猜。 */
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
 * 业务接口客户端。端点、会话、缓存端口全部由调用方注入，本层不读设置也不碰 fs。
 * session 也可传函数（装配时它多半还是 null）；lyricsCache/lyricsFallback 不给即无对应能力。
 *
 * @param {{endpoints?: Record<string, string>, fetchImpl?: Function,
 *          session?: object|Function|null,
 *          sessionHeaders?: (context: {key: string, authenticated: boolean}) => Record<string, string>,
 *          pageSize?: number, maxPages?: number, flagKeys?: string[],
 *          isSafeUrl?: (url: string) => boolean, timeoutMs?: number,
 *          discoveryLimit?: number, discoveryPageCap?: number,
 *          lyricIndexLimit?: number, lyricMemoryLimit?: number, log?: Function,
 *          lyricsCache?: object|null, lyricsFallback?: Function|null}} options
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
  /** 诊断日志口：只记键名不记值；目前用于在真机上确认播放响应里有没有 albumID。 */
  const log = typeof options.log === "function" ? options.log : () => undefined;
  /** 被设置**显式关闭**的端点（`musicEndpoints: {favorites: null}`）：报错要说得比"尚未确定"更准。 */
  const disabledEndpoints = new Set(options.disabledEndpoints ?? []);

  // 曲目条目里的歌词地址进程内索引（trackId → 白名单地址）：播放响应里没有它，只能从加载过的列表条目记下。
  // 仅内存、先进先出有上限；取用前重过白名单，下载失败仍回落播放入口那条路。
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

  // 第 4 档的会话内负缓存（trackId → 试过的 albumId）：同一首在同一进程里不重复打注定同样的专辑请求。
  // 仅内存、有上限；键是 (trackId, albumId) 一对，换了专辑 id 就是没试过的新请求。
  const lyricAlbumAttempts = new Map();

  function albumAttempted(trackId, albumId) {
    const tried = lyricAlbumAttempts.get(trackId);
    return tried !== undefined && tried.has(albumId);
  }

  function rememberAlbumAttempt(trackId, albumId) {
    if (!isNonEmptyString(trackId) || !isNonEmptyString(albumId)) return;
    let tried = lyricAlbumAttempts.get(trackId);
    if (tried === undefined) {
      tried = new Set();
      lyricAlbumAttempts.set(trackId, tried);
    }
    tried.add(albumId);
    while (lyricAlbumAttempts.size > lyricAddressIndexLimit) {
      const oldest = lyricAlbumAttempts.keys().next().value;
      lyricAlbumAttempts.delete(oldest);
    }
  }

  // 歌词的三处缓存端口：协议层不碰 fs，三个端口都可选——不给时 getLyrics 只剩华为那几档，行为不变。

  /**
   * 磁盘缓存端口（`createLyricsCache()` 产物，sidecar 装配时注入），只需 readLocal/readCached/writeCached 三个方法。
   * 写入一律 best-effort：缓存只求"下次更快"，端口自己吞掉失败，这里不再包一层 try。
   */
  const lyricsCache = options.lyricsCache ?? null;

  /** 第三方回退端口（`src/main/lyrics-fallback.mjs` 的 `createThirdPartyLyrics()` 产物）。 */
  const lyricsFallback = typeof options.lyricsFallback === "function" ? options.lyricsFallback : null;

  /**
   * 进程内内存缓存 `trackId → 歌词文档`：同一首歌一次会话里会被取很多次，免掉重复读盘与形状校验。
   * 与 `lyricAddressIndex` 同一条纪律：只在内存、有上限、先进先出，重启即空。
   */
  const lyricMemoryCache = new Map();
  const lyricMemoryLimit = positiveInt(options.lyricMemoryLimit, 200);

  function rememberLyrics(trackId, doc) {
    if (!isNonEmptyString(trackId) || !isObject(doc) || !isNonEmptyString(doc.text)) return;
    if (lyricMemoryCache.has(trackId)) lyricMemoryCache.delete(trackId);
    lyricMemoryCache.set(trackId, doc);
    while (lyricMemoryCache.size > lyricMemoryLimit) {
      const oldest = lyricMemoryCache.keys().next().value;
      lyricMemoryCache.delete(oldest);
    }
  }

  /**
   * 读本地导入；端口不在或形状不对一律回 null——这一跳只是"可能更好"，失败不该有副作用。
   * 交回的文档带上文件名与导入时间：它们住在磁盘记录顶层，只有读盘那一刻才知道，界面要用来交代来源。
   */
  async function readLocalLyrics(trackId) {
    if (lyricsCache === null || typeof lyricsCache.readLocal !== "function") return null;
    try {
      const found = await lyricsCache.readLocal(trackId);
      if (!isObject(found) || !isObject(found.doc) || !isNonEmptyString(found.doc.text)) return null;
      const doc = { ...found.doc, source: "local" };
      if (isNonEmptyString(found.fileName)) doc.fileName = found.fileName;
      if (typeof found.importedAt === "number" && Number.isFinite(found.importedAt) && found.importedAt > 0) {
        doc.importedAt = found.importedAt;
      }
      return doc;
    } catch (cause) {
      // 本地文件读不出来（权限/坏文件）不是"这首歌没有歌词"：留一行 warn 级的日志，继续往下走
      log(`本地导入歌词读取失败（按没有导入处理）：${messageOf(cause)}`);
      return null;
    }
  }

  /** 读 90 天磁盘缓存（同上：失败当"没命中"，继续走在线那条路）。 */
  async function readCachedLyrics(trackId) {
    if (lyricsCache === null || typeof lyricsCache.readCached !== "function") return null;
    try {
      const doc = await lyricsCache.readCached(trackId);
      return isObject(doc) && isNonEmptyString(doc.text) ? doc : null;
    } catch (cause) {
      log(`歌词磁盘缓存读取失败（按没有缓存处理）：${messageOf(cause)}`);
      return null;
    }
  }

  /** 命中在线结果之后：先记内存（这一帧之后的重复取词立刻命中），再尽力写盘。 */
  async function rememberAndPersist(trackId, doc) {
    rememberLyrics(trackId, doc);
    if (lyricsCache === null || typeof lyricsCache.writeCached !== "function") return;
    try {
      await lyricsCache.writeCached(trackId, doc);
    } catch (cause) {
      log(`歌词缓存写入失败（不影响这次显示）：${messageOf(cause)}`);
    }
  }

  /**
   * 第三方回退这一跳：只有曲目有标题才试（第三方全靠关键字搜索），艺人/时长有就参与严格匹配。
   * 无艺人且时长 ≤ 30 秒时不发请求——两项佐证都没有时最高分必然低于 MIN_SCORE，白等两个 8 秒超时。
   */
  async function thirdPartyLyricsFor(trackId, request = {}) {
    if (lyricsFallback === null) return null;
    const title = isNonEmptyString(request.title) ? request.title.trim() : "";
    if (title === "") return null;
    const artist = isNonEmptyString(request.artist) ? request.artist.trim() : "";
    const duration = numberOrNull(request.durationSeconds ?? request.duration);
    if (artist === "" && !(duration !== null && duration > 30)) {
      log("第三方歌词回退跳过：这一首既没有艺人、时长也不构成佐证（匹配器的最高分必然不过门槛）");
      return null;
    }
    try {
      const doc = await lyricsFallback({ title, artist, durationSeconds: duration });
      if (!isObject(doc) || !isNonEmptyString(doc.text)) return null;
      // 来源只认端口给的那两个（端口自己不报来源的，按"第三方"记，绝不冒充 huawei）
      const source = isNonEmptyString(doc.source) ? doc.source : "third_party";
      return {
        text: doc.text,
        format: isNonEmptyString(doc.format) ? doc.format : "lrc",
        source,
        ...(isNonEmptyString(doc.matchedTitle) ? { matchedTitle: doc.matchedTitle } : {}),
        ...(isNonEmptyString(doc.matchedArtist) ? { matchedArtist: doc.matchedArtist } : {}),
      };
    } catch (cause) {
      // 一个歌词服务挂了绝不能打断播放（也不缓存这次失败）
      log(`第三方歌词回退失败（按没有回退处理）：${messageOf(cause)}`);
      return null;
    }
  }

  /**
   * 导入本地歌词：交给磁盘端口写进 `lyrics-local/`，顺手更新内存缓存，再把生效的文档交回调用方。
   * 不清磁盘缓存里的在线结果——本地永远排在它前面，留着它，用户删掉本地导入后原词还在。
   */
  async function importLyrics(request = {}) {
    const trackId = request.trackId ?? request.id;
    if (!isNonEmptyString(trackId)) return err("导入本地歌词需要 trackId", MUSIC_ERROR_KINDS.missingParam);
    const id = trackId.trim();
    if (typeof request.text !== "string" || request.text.trim() === "") {
      return err("导入本地歌词需要歌词文本（文件是空的，或选中的文件读不出文本）", MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (lyricsCache === null || typeof lyricsCache.writeLocal !== "function") {
      return err(
        "本地歌词无法保存：没有可用的数据目录（宿主未传 --data-dir），这一次导入不会留下来",
        MUSIC_ERROR_KINDS.cacheUnavailable,
      );
    }
    const fileName = isNonEmptyString(request.fileName) ? request.fileName.trim().slice(0, 120) : "";
    let written;
    try {
      written = await lyricsCache.writeLocal(id, { text: request.text, fileName });
    } catch (cause) {
      // 端口在自己的错误里带了 kind（invalid_payload / unavailable）；认不出就按 invalid_response 报
      const kind = isNonEmptyString(cause?.kind) ? cause.kind : MUSIC_ERROR_KINDS.invalidResponse;
      const mapped = kind === "unavailable" ? MUSIC_ERROR_KINDS.cacheUnavailable : MUSIC_ERROR_KINDS.invalidResponse;
      return err(`本地歌词没能保存：${messageOf(cause)}`, mapped);
    }
    const doc = isObject(written?.doc) ? written.doc : null;
    if (doc === null) return err("本地歌词没能保存（磁盘模块没有交回文档）", MUSIC_ERROR_KINDS.invalidResponse);
    const imported = { ...doc, source: "local", ...(fileName === "" ? {} : { fileName }) };
    rememberLyrics(id, imported);
    return ok({ ...imported, warnings: [] });
  }

  /** 两处磁盘占用（设置页那张卡显示的就是它；端口不在时如实回"不可用"）。 */
  async function lyricsCacheInfo() {
    if (lyricsCache === null || typeof lyricsCache.info !== "function") {
      return ok({ available: false, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
    }
    try {
      return ok(await lyricsCache.info());
    } catch (cause) {
      return err(`读取歌词缓存占用失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.invalidResponse);
    }
  }

  /**
   * 清歌词缓存；`options.local === true` 才连本地导入一起删——用户导入的是他的文件，默认不碰。
   * 清完必须顺手清内存缓存，否则这一首仍命中内存里的旧文本，用户会以为清除没生效。
   */
  async function clearLyricsCache(options = {}) {
    const local = options.local === true;
    if (lyricsCache === null || typeof lyricsCache.clear !== "function") {
      return err("歌词缓存不可用：没有可用的数据目录（宿主未传 --data-dir）", MUSIC_ERROR_KINDS.cacheUnavailable);
    }
    let stats;
    try {
      stats = await lyricsCache.clear({ local });
    } catch (cause) {
      return err(`清除歌词缓存失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.invalidResponse);
    }
    if (local) {
      lyricMemoryCache.clear();
    } else {
      // 只清在线缓存时要留下本地导入那几首的内存副本：它们是"用户的文件"，与缓存无关
      for (const [key, doc] of [...lyricMemoryCache]) {
        if (doc?.source === "local") continue;
        lyricMemoryCache.delete(key);
      }
    }
    return ok(stats);
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

  /** 收藏一页：`contentTypes` 决定"要歌曲"还是"要歌单"。 */
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
   * 渐进式收藏加载器（渲染层滚动加载用）；`total` 只在完整分页走完后才有值，否则为 null。
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
   * 单页收藏读取：分页结论在协议层算好，渲染层不必也不许自己猜"还有没有下一页"。
   * 刻意不给 `total`——收藏没有可信总数，那是拼页者走完整分页去重后的结论。
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
   * 我的歌单：歌单与歌曲混在同一分页列表里，首页很可能整页都是歌曲，所以照参考流程翻页。
   * 翻到短页、没带来新条目或触到保守上限为止，再挑出 `contentType != 1` 的条目按 `contentType:id` 去重。
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
   * 歌单详情：整份响应缓存 + 按页本地切片——该端点不认 start/limit，一次就回整张歌单（实测 1623 条）。
   * 缓存只在实例内存，键为 kind+id，一张歌单只留最近一次解析到的 kind，有上限；请求带会话指纹与第一页代次，
   * 对不上的迟到响应整条作废。
   */
  const playlistDetailCache = new Map();
  const playlistDetailCacheLimit = positiveInt(options.playlistCacheLimit, 4);

  /** 这张歌单**最近一次**解析到哪条端点（`playlistId → "owned"|"collected"`）。 */
  const activePlaylistKinds = new Map();

  /**
   * 这张歌单"第一页尝试"的代次（`playlistId → 自增序号`）：每开一次第一页就 +1，在途旧请求回来对不上即作废。
   * 有上限，被挤掉的只是作废判据，最坏多一次网络请求，绝不会把旧数据写进缓存。
   */
  const playlistPage1Serials = new Map();
  let playlistPage1Seed = 0;
  const playlistPage1SerialLimit = Math.max(playlistDetailCacheLimit * 4, 8);

  /** auto 服务端分页的第一页端点选择（歌单 id → kind + 会话/第一页代次）。 */
  const serverPlaylistRoutes = new Map();
  const serverPlaylistRouteLimit = Math.max(playlistDetailCacheLimit * 4, 8);

  /**
   * 服务端分页"整页重复"的指纹：恰好一整页时两种服务端行为长得一样，重复回同一份会让触底加载永远滚不完。
   * 只做保守判定——整张页的归一化 ID 序列相同而窗口起点不同，就收敛成"没有更多"，不猜总数。
   */
  const serverPageSignatures = new Map();
  const serverPageSignatureLimit = Math.max(playlistDetailCacheLimit * 4, 8);

  function playlistCacheKey(kind, id) {
    return `${kind}\u0000${id}`;
  }

  function forgetServerPlaylistRoute(id) {
    serverPlaylistRoutes.delete(id);
  }

  function rememberServerPlaylistRoute(id, kind, sessionMark, serialMark) {
    serverPlaylistRoutes.delete(id);
    serverPlaylistRoutes.set(id, { kind, sessionMark, serialMark });
    while (serverPlaylistRoutes.size > serverPlaylistRouteLimit) {
      serverPlaylistRoutes.delete(serverPlaylistRoutes.keys().next().value);
    }
  }

  function serverPlaylistRouteOf(id, sessionMark, serialMark) {
    const route = serverPlaylistRoutes.get(id);
    if (route === undefined) return null;
    if (route.sessionMark !== sessionMark || route.serialMark !== serialMark) {
      forgetServerPlaylistRoute(id);
      return null;
    }
    serverPlaylistRoutes.delete(id);
    serverPlaylistRoutes.set(id, route);
    return route.kind;
  }

  /** 这张歌单的所有端点条目一起忘掉（含"最近解析到哪条"的记忆、分页路由与重复指纹）。 */
  function forgetPlaylistDetail(id) {
    playlistDetailCache.delete(playlistCacheKey("owned", id));
    playlistDetailCache.delete(playlistCacheKey("collected", id));
    activePlaylistKinds.delete(id);
    forgetServerPlaylistRoute(id);
    forgetServerPageSignatures(id);
  }

  // —— 在途请求的"身份证"（会话指纹 + 这张歌单第一页的代次） ——

  /** 这张歌单新开一次第一页（不论成败/空）：代次 +1，返回新代次。 */
  function beginPlaylistPage1(id) {
    playlistPage1Seed += 1;
    // 先删再插：Map 的插入顺序就是"最近一次尝试"的顺序（上限淘汰时先丢最旧的）
    playlistPage1Serials.delete(id);
    playlistPage1Serials.set(id, playlistPage1Seed);
    while (playlistPage1Serials.size > playlistPage1SerialLimit) {
      playlistPage1Serials.delete(playlistPage1Serials.keys().next().value);
    }
    return playlistPage1Seed;
  }

  /** 这张歌单当前的第一页代次（`null` = 一次都没开过 / 判据已被上限挤掉）。 */
  function currentPlaylistPage1Serial(id) {
    return playlistPage1Serials.get(id) ?? null;
  }

  function serverPageSignatureKey(kind, id, pageSize) {
    return `${kind}\u0000${id}\u0000${pageSize}`;
  }

  function forgetServerPageSignatures(id) {
    for (const [key, entry] of [...serverPageSignatures]) {
      if (entry?.playlistId === id) serverPageSignatures.delete(key);
    }
  }

  function rememberServerPageSignature(key, entry) {
    serverPageSignatures.delete(key);
    serverPageSignatures.set(key, entry);
    while (serverPageSignatures.size > serverPageSignatureLimit) {
      serverPageSignatures.delete(serverPageSignatures.keys().next().value);
    }
  }

  /** 一页的"是不是同一份"判据：归一化之后的 ID 序列（顺序也算，不掺任何会话内容）。 */
  function pageSignatureOf(songs) {
    return songs.map((song) => song.id).join("\u0000");
  }

  /** 迟到/过期响应的人话：只说这次请求过期了，不写会话、不写 token、不写上一个账号的任何信息（错误会进日志与界面）。 */
  function stalePlaylistDetailResult() {
    return err(
      "歌单详情：这次请求已经过期（会话已切换，或同一张歌单已有更新的一次请求），迟到的响应已丢弃——请重新打开歌单",
      MUSIC_ERROR_KINDS.staleResponse,
    );
  }

  function rememberPlaylistDetail(entry) {
    const key = playlistCacheKey(entry.kind, entry.playlistId);
    if (playlistDetailCache.has(key)) playlistDetailCache.delete(key);
    playlistDetailCache.set(key, entry);
    activePlaylistKinds.set(entry.playlistId, entry.kind);
    while (playlistDetailCache.size > playlistDetailCacheLimit) {
      const oldest = playlistDetailCache.keys().next().value;
      const evicted = playlistDetailCache.get(oldest);
      playlistDetailCache.delete(oldest);
      // 被上限淘汰的条目不能再在"最近解析到哪条"里留指针（那会指到不存在的东西）
      if (evicted !== undefined && activePlaylistKinds.get(evicted.playlistId) === evicted.kind) {
        activePlaylistKinds.delete(evicted.playlistId);
      }
    }
  }

  /**
   * 取一份整表缓存；`null` 表示这一页只能去问网络。只有能确定是整张歌单的响应才进缓存，命中即可切任意页。
   * `kind='auto'` 只认这张歌单最近一次解析到的端点，记不住时宁可不命中——多取一次网络好过切错一份歌单。
   */
  function cachedPlaylistDetail(id, kind) {
    if (kind !== "auto") {
      return playlistDetailCache.get(playlistCacheKey(kind, id)) ?? null;
    }
    const active = activePlaylistKinds.get(id);
    if (active === undefined) return null;
    return playlistDetailCache.get(playlistCacheKey(active, id)) ?? null;
  }

  /**
   * 会话指纹：只用于"会话换了就把缓存清掉"，不落盘、不进日志、不参与请求。
   * 用 FNV-1a 散列而非 token 原文，进程内不留可读凭据；token 与 snsUserID 分开散列，避免拼串错位。
   */
  function fingerprintOf(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }

  function sessionFingerprint() {
    const session = currentSession();
    const token = isNonEmptyString(session?.token) ? session.token : "";
    const snsUserID = isNonEmptyString(session?.snsUserID) ? session.snsUserID : "";
    return `${fingerprintOf(token)}:${fingerprintOf(snsUserID)}`;
  }

  /** 最近一次取缓存时看到的会话指纹（`null` = 还没比过）。 */
  let playlistCacheSession = null;

  /**
   * 查缓存**之前**先对一次会话指纹：变了就整张清空。
   * 返回 `true` = 这次真的清掉了东西（供测试自证"确实清过"）。
   */
  function dropPlaylistCacheIfSessionChanged() {
    const fingerprint = sessionFingerprint();
    if (playlistCacheSession === fingerprint) return false;
    playlistCacheSession = fingerprint;
    const cleared = playlistDetailCache.size > 0 || activePlaylistKinds.size > 0 || serverPlaylistRoutes.size > 0 || serverPageSignatures.size > 0;
    playlistDetailCache.clear();
    activePlaylistKinds.clear();
    serverPlaylistRoutes.clear();
    serverPageSignatures.clear();
    return cleared;
  }

  /** 整表缓存上的第 `page` 页切片（`hasMore` 只看还有没有剩下的条目）。 */
  function slicePlaylistDetail(entry, { page, pageSize, start }) {
    const end = start + pageSize;
    return ok({
      playlistId: entry.playlistId,
      // 歌单元信息是**整张歌单的身份**（第一页带回来的那份），后续页照旧给它
      playlist: entry.playlist,
      songs: entry.songs.slice(start, end),
      hasMore: end < entry.total,
      page,
      pageSize,
      /** 这一页是怎么来的：`server` = 网络分页；`local-slice` = 整份响应已下载，这一页是本地切片。 */
      pageSource: "local-slice",
      /** 这一页背后那份响应有多少首（本地切片时 = 整张歌单的条数）。只用于如实说明，不是"总数"承诺。 */
      available: entry.total,
      /**
       * 整张歌单：整份已在内存，第一页顺手交出去，页面据此让「播放全部」「加入队列」
       * 作用于**全部曲目**（不是已渲染的那一页）。只随第一页给，后续页再交一遍只是白扛序列化。
       */
      ...(page === 1 ? { fullSongs: entry.songs } : {}),
    });
  }

  /**
   * 歌单曲目：自建与收藏是两个不同端点，而通道只带 `playlistId`，所以默认先试自建、拿不到歌单元信息再试公开。
   * 响应靠 `playListInfoEx` / `musicListInfoEx` 自证身份，哪条路真的回了歌单就从哪条取。
   */
  async function getPlaylistDetail(playlistId, request = {}) {
    if (!isNonEmptyString(playlistId)) return err("歌单曲目接口需要 playlistId", MUSIC_ERROR_KINDS.missingParam);
    const id = playlistId.trim();
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const start = startOf(page, pageSize);
    const kind = request.kind ?? "auto";

    // 会话换了人或 token 就清掉整表缓存——上一轮那份属于别人的账号。
    dropPlaylistCacheIfSessionChanged();

    /**
     * 这一次请求的"身份证"：开始时的会话指纹 + 这张歌单第一页的代次。
     * 入口那次比对拦不住 HTTP 在途时会话换人或又开一次第一页，迟到的旧响应必须复查才许写缓存。
     */
    const sessionMark = sessionFingerprint();
    if (page === 1) {
      // 第一页一开就把这张歌单所有 kind 的旧条目失效——失败/空响应同样算"这一轮已经问过"。
      // 失效点必须在网络之前，放到拿到响应之后就等于让失败这一档继续沿用旧缓存。
      forgetPlaylistDetail(id);
      beginPlaylistPage1(id);
    }
    const serialMark = currentPlaylistPage1Serial(id);
    /** `await` 回来后：会话没换、这张歌单也没开更新的第一页，才许写缓存/交回调用方。 */
    const attemptIsCurrent = () =>
      sessionFingerprint() === sessionMark && currentPlaylistPage1Serial(id) === serialMark;

    // ① 后续页：整份响应已经在缓存里 → 本地切片（**不发网络**，同一页读多少次都是同一份）
    const cached = page > 1 ? cachedPlaylistDetail(id, kind) : null;
    if (cached !== null) return slicePlaylistDetail(cached, { page, pageSize, start });

    const serverRoute = page > 1 && kind === "auto" ? serverPlaylistRouteOf(id, sessionMark, serialMark) : null;
    if (page > 1 && kind === "auto" && serverRoute === null) {
      return err("歌单详情缺少第一页的服务端端点选择，请重新加载第 1 页", MUSIC_ERROR_KINDS.invalidResponse);
    }

    const failures = [];

    async function owned() {
      const result = await call("playlistDetail", { params: { playListID: id, start, limit: pageSize } });
      if (!result.ok) return { failure: result };
      const container = pickPath(result.data, "playListInfoEx");
      if (!isObject(container)) return { empty: true, result };
      const songs = extractList({ list: container.playListSongInfoList ?? [] }).map((item) => normalizeTrack(item, trackOptions)).filter((track) => track !== null);
      const playlist = normalizePlaylist({ ...(isObject(container.playListInfo) ? container.playListInfo : {}), contentType: "5" }, { isSafeUrl });
      return {
        kind: "owned",
        songs,
        playlist,
        received: Array.isArray(container.playListSongInfoList) ? container.playListSongInfoList.length : 0,
      };
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
      return {
        kind: "collected",
        songs,
        playlist,
        received: Array.isArray(container.songSimpleInfos) ? container.songSimpleInfos.length : 0,
      };
    }

    const order =
      kind === "owned"
        ? [owned]
        : kind === "collected"
          ? [collected]
          : serverRoute === "owned"
            ? [owned]
            : serverRoute === "collected"
              ? [collected]
              : [owned, collected];
    for (const attempt of order) {
      const found = await attempt();

      // `await` 回来先复查身份证：会话在途换了人或同一张歌单又开了新的第一页，这份响应属于过去，
      // 整条作废（不写缓存、不交回调用方、也不再试下一条端点）。
      if (!attemptIsCurrent()) return stalePlaylistDetailResult();

      if (found.failure) {
        failures.push(found.failure);
        continue;
      }
      if (found.empty) continue;

      /**
       * 这份响应的形状决定要不要进缓存：`received > pageSize`，或首页不满一页，才能确定它就是整张歌单。
       * 判断不了的原样交出（那是服务端自己在分页）；整页重复见 `serverPageSignatures`，收敛成没有更多。
       */
      const wholeList = found.received > pageSize || (page === 1 && found.received !== pageSize);
      if (!wholeList) {
        if (kind === "auto" && page === 1) rememberServerPlaylistRoute(id, found.kind, sessionMark, serialMark);
        const fullPage = found.received >= pageSize;
        if (fullPage) {
          const signature = pageSignatureOf(found.songs);
          const signatureKey = serverPageSignatureKey(found.kind, id, pageSize);
          const previous = serverPageSignatures.get(signatureKey);
          const sameAsBefore = previous !== undefined && previous.signature === signature;
          const repeated = sameAsBefore && (previous.repeated === true || previous.start !== start);
          rememberServerPageSignature(signatureKey, { playlistId: id, start, signature, repeated });
          if (repeated) {
            return ok({
              playlistId: id,
              playlist: found.playlist,
              // 重复的整页**不再交给调用方**：交出去界面就会把同一批歌再渲染一遍
              songs: [],
              hasMore: false,
              page,
              pageSize,
              /** `server-repeat` = 服务端这次回的整页与上一页一模一样（它没认窗口），按"没有更多"收敛。 */
              pageSource: "server-repeat",
              /** 只说这一份响应有多少条，**不**冒充这张歌单的总数（端点没给可用的总数元数据）。 */
              available: found.songs.length,
            });
          }
        }
        return ok({
          playlistId: id,
          playlist: found.playlist,
          songs: found.songs,
          hasMore: found.received >= pageSize,
          page,
          pageSize,
          pageSource: "server",
          available: found.songs.length,
        });
      }

      // 同一张歌单只留**一份**解析结果：后续页直接问网络时（缓存里没有这条 kind）也一样，
      // 否则两条端点各存一份、`auto` 就只能靠"最近一次解析"的记忆兜着，多一份旧条目就多一次切错的机会。
      forgetPlaylistDetail(id);
      const entry = {
        kind: found.kind,
        playlistId: id,
        songs: found.songs,
        playlist: found.playlist,
        total: found.songs.length,
      };
      rememberPlaylistDetail(entry);
      return slicePlaylistDetail(entry, { page, pageSize, start });
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
   * 播放地址：`contentCode`/`contentType`/`qualityType` 进 JSON 体。
   * 音质只认 standard/lossless，别的一律如实回 `quality_unsupported`——不猜也不用别的音质顶替。 */
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
   * 歌词文本：按"最可能有、最便宜"排序取——显式端点、已加载条目的 `lyricAddress`、播放响应、专辑补条目索引。
   * 之后依次试本地导入、进程内存、磁盘缓存与第三方回退；都没有就回华为那次真实失败，不把响应体当歌词。
   */
  async function getLyrics(request = {}) {
    const trackId = request.trackId ?? request.id;
    if (!isNonEmptyString(trackId)) return err("歌词接口需要 trackId", MUSIC_ERROR_KINDS.missingParam);
    const id = trackId.trim();

    // ① 本地导入（磁盘目录 lyrics-local/；端口没注入时这一跳不存在）
    const local = await readLocalLyrics(id);
    if (local !== null) {
      rememberLyrics(id, local);
      return ok({ ...local, warnings: [] });
    }

    // ② 内存缓存（本进程取过的那一份）
    const remembered = lyricMemoryCache.get(id);
    if (remembered !== undefined) {
      return ok({ ...remembered, warnings: [], cached: "memory" });
    }

    // ③ 90 天磁盘缓存
    const cached = await readCachedLyrics(id);
    if (cached !== null) {
      rememberLyrics(id, cached);
      return ok({ ...cached, warnings: [], cached: "disk" });
    }

    // ④ 华为四档
    const huawei = await huaweiLyricsOnce(id, request);
    if (huawei.ok) {
      const doc = { text: huawei.data.text, format: huawei.data.format ?? "lrc", source: "huawei" };
      await rememberAndPersist(id, doc);
      return ok({ ...doc, warnings: huawei.data.warnings ?? [] });
    }

    // ⑤ 第三方回退（只在华为侧全落空、且曲目有标题时才有意义——没有标题的回退等于盲搜）
    const third = await thirdPartyLyricsFor(id, request);
    if (third !== null) {
      await rememberAndPersist(id, third);
      return ok({ ...third, warnings: [] });
    }

    // ⑥ 如实转达华为那次的失败（`endpoint_unknown` / `session_required` / `invalid_response`…）
    return huawei;
  }

  /**
   * 华为侧四档的实现：从缓存编排的角度看，它只是第 ④ 跳。
   * 返回 `ok({text, format, warnings})` 或 `err(...)`，不带 source——source 是编排层的事。
   */
  async function huaweiLyricsOnce(id, request = {}) {
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

    // ④ 专辑补索引：播放响应里没有歌词地址，就用它给的专辑 id 去既有专辑端点拉一次详情，
    // 归一化时条目自带的 lyricAddress 顺手进索引；本进程同一对 (曲目, 专辑) 只问一次，不重复取词。
    const albumId = albumIdOf(result.data);
    if (albumId !== null && !albumAttempted(id, albumId)) {
      // 只记键名不记值（连专辑 id 的值也不记）：这条路的成败取决于播放响应里到底有没有 albumID，
      // 而那个形状一直没有实证——协议层不自造事实，留这一行给下一次真机取证。
      log(
        "歌词回落：播放响应里没有歌词地址，按专辑补一次条目索引" +
          `（只记键名，不记值）｜播放响应顶层键名：${objectKeysOf(result.data).join(", ")}` +
          `｜songInfo 键名：${objectKeysOf(result.data.songInfo).join(", ")}`,
      );
      rememberAlbumAttempt(id, albumId);
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
    /** 本地导入 / 缓存占用 / 清缓存（三条 `lyrics:*` 频道用它们）。 */
    importLyrics,
    lyricsCacheInfo,
    clearLyricsCache,
  };
}

/** 播放地址白名单校验的转发（渲染层/上层不必再 import 两个模块）。 */
export function safePlaybackUrl(value) {
  return safeMediaUrl(value);
}
