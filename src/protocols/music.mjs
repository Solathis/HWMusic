/**
 * 华为音乐业务接口（协议原型层）。
 *
 * 端点全部**注入**（`endpoints`）：具体 URL 已随旧仓删除，本模块不写任何猜测 URL，
 * 未注入的端点一律结构化 `endpoint_unknown`（而不是打到一个瞎猜的地址上）。
 * 请求参数名同样集中在可覆写的 `queryNames` 表里——真实参数名待 R7 联调确认后只改一处。
 * 探测与结论见 docs/API_CONTRACT.md。
 *
 * 三个必须守住的业务语义（旧仓踩过的坑）：
 * 1. 收藏列表没有可信的总数字段 → 总数 = **完整分页后 ID 去重**，与"已加载 N 首"分开；
 *    接口若上报了 total，只作 `reportedTotal` 记录，绝不当真值。
 * 2. playback 响应里**顶层 `fileURL` 才是音频地址**；`fileInfos` 可能是 JSON 字符串（也可能是对象）。
 * 3. `auditionTime > 0` **不能单独**判定 30 秒试听，必须再有第二个信号（标志位）才算。
 * 另：自建歌单删除必须走 `playlistDelete` 端点，不允许拿收藏端点冒充成功。
 *
 * 安全约定：错误的 message 只带 HTTP 状态/错误码/域名，不回显整段响应体。
 */
import { err, ok } from "../shared/result.ts";
import { isSafeMediaUrl, safeMediaUrl } from "./safe-media-url.mjs";

/** 业务端点键名（唯一真源；每个键都要由调用方注入，缺一个就少一个可用接口）。 */
export const MUSIC_ENDPOINT_KEYS = [
  "favorites",
  "playlistList",
  "playlistDelete",
  "search",
  "album",
  "artist",
  "history",
  "playback",
];

export const MUSIC_ERROR_KINDS = {
  /** 端点未注入/非 https —— 设计上的"端点未知"落点 */
  endpointUnknown: "endpoint_unknown",
  /** 调用方参数不齐（如空 id） */
  missingParam: "missing_param",
  httpError: "http_error",
  networkError: "network_error",
  invalidResponse: "invalid_response",
  /** HTTP 2xx 但业务错误码非 0 */
  apiError: "api_error",
  /** 播放地址不在 CDN 白名单内（渲染层反正也加载不了，早点如实报错） */
  unsafeMediaUrl: "unsafe_media_url",
};

/**
 * 请求参数名表（**待 R7 联调确认**，见 docs/API_CONTRACT.md）。集中一处便于一次改完。
 */
export const DEFAULT_QUERY_NAMES = {
  page: "page",
  pageSize: "size",
  keyword: "keyword",
  id: "id",
};

/** 能佐证"这是试听片段"的标志位候选（与 auditionTime 齐备才算试听）。 */
export const DEFAULT_AUDITION_FLAG_KEYS = ["isAudition", "audition", "tryListen", "trialFlag", "isTry"];

/** 列表可能挂在这些字段下（真实形状待联调确认，取不到就返回空数组而不是抛）。 */
export const LIST_CONTAINER_KEYS = ["list", "items", "songs", "records", "tracks"];

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_PAGES = 200;

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isSuccessCode(code) {
  return code === 0 || code === "0";
}

/** 正整数兜底（负数/NaN/0 一律回落到默认值）。 */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * 业务信封解码：`{code:"0", data}` 视为成功；非 0 错误码 → api_error。
 * 无 code 字段时把整个响应当数据（不同接口/网关形态不一，宽容读取）。
 */
export function decodeEnvelope(raw) {
  if (raw === null || typeof raw !== "object") return err("接口响应不是 JSON 对象", MUSIC_ERROR_KINDS.invalidResponse);
  if (Array.isArray(raw)) return ok(raw);

  const code = raw.code ?? raw.resultCode;
  if (code !== undefined && code !== null && code !== "" && !isSuccessCode(code)) {
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

/** 歌曲 ID：多字段兜底；取不到返回 null（调用方如实丢弃并计数，不编造 ID）。 */
export function trackIdOf(item) {
  if (item === null || typeof item !== "object") return null;
  for (const key of ["id", "songId", "musicId", "resourceId", "trackId"]) {
    const value = item[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
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
 * 只看 auditionTime 会把"整曲但带试听字段"误判成 30 秒片段（旧仓踩过）。
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

/** 查询串清洗：丢空值/NaN/对象，字符串去首尾空白。 */
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

/** 是否还有下一页：优先信显式标志，其次"整页返回即可能还有"，绝不拿 total 当真。 */
function hasMoreFrom(payload, received, pageSize) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const flag = payload.hasMore ?? payload.has_more ?? payload.more;
  if (flag === false || flag === "false") return false;
  if (flag === true || flag === "true") return true;
  const end = payload.isEnd ?? payload.is_end ?? payload.last;
  if (end === true || end === "true") return false;
  return received >= pageSize;
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
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
  return ok({
    url: fileUrl,
    fileInfos,
    format: raw.format ?? null,
    size: raw.size ?? null,
    bitrate: raw.bitrate ?? null,
    duration: raw.duration ?? null,
    auditionLikely: audition.auditionLikely,
    signals: audition.signals,
    warnings,
  });
}

/**
 * 业务接口客户端。
 *
 * @param {{endpoints?: Record<string, string>, fetchImpl?: Function,
 *          sessionHeaders?: (context: {key: string}) => Record<string, string>,
 *          pageSize?: number, maxPages?: number, queryNames?: Record<string, string>,
 *          flagKeys?: string[], isSafeUrl?: (url: string) => boolean}} options
 */
export function createMusicApi(options = {}) {
  const endpoints = options.endpoints ?? {};
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sessionHeaders = options.sessionHeaders ?? (() => ({}));
  const defaultPageSize = positiveInt(options.pageSize, DEFAULT_PAGE_SIZE);
  const maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES);
  const queryNames = { ...DEFAULT_QUERY_NAMES, ...(options.queryNames ?? {}) };
  const flagKeys = options.flagKeys ?? DEFAULT_AUDITION_FLAG_KEYS;
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;

  /** 端点解析：非 https / 空值 = "端点尚未确定"，绝不猜。 */
  function endpointOf(key) {
    const value = endpoints[key];
    if (!isNonEmptyString(value)) {
      return err(`接口端点 ${key} 尚未确定（待授权 probe / R7 联调确认，见 docs/API_CONTRACT.md）`, MUSIC_ERROR_KINDS.endpointUnknown);
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

  async function requestJson(key, request = {}) {
    const endpoint = endpointOf(key);
    if (!endpoint.ok) return endpoint;

    const url = new URL(endpoint.data);
    for (const [name, value] of Object.entries(cleanParams(request.params))) url.searchParams.set(name, value);

    const headers = { accept: "application/json", ...sessionHeaders({ key }) };
    const init = { method: request.method ?? "GET", headers };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }

    let response;
    try {
      response = await fetchImpl(url.href, init);
    } catch (cause) {
      return err(`请求 ${key} 失败：${messageOf(cause)}`, MUSIC_ERROR_KINDS.networkError);
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
    return decodeEnvelope(raw);
  }

  function favoritesParams(page, pageSize, extra) {
    return { [queryNames.page]: page, [queryNames.pageSize]: pageSize, ...(extra ?? {}) };
  }

  function listFavoritesPage(request = {}) {
    const page = positiveInt(request.page, 1);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    return requestJson("favorites", { params: favoritesParams(page, pageSize, request.params) });
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
      // 信封解出的 data 可能把 list 直接挂在 data 上，也可能再嵌一层
      const container = page !== null && typeof page === "object" ? page : {};
      const list = extractList(container);
      let added = 0;
      for (const item of list) {
        const id = trackIdOf(item);
        if (id === null) {
          skipped += 1;
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        songs.push(item);
        added += 1;
      }
      return { added, received: list.length, container };
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
      const { added, received, container } = accept(result.data);
      const reported = container.total ?? container.totalCount;
      if (typeof reported === "number" && Number.isFinite(reported)) reportedTotal = reported;

      if (hasMoreFrom(container, received, pageSize)) {
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

  async function listPlaylists(request = {}) {
    const result = await requestJson("playlistList", {
      params: { [queryNames.page]: positiveInt(request.page, 1), [queryNames.pageSize]: positiveInt(request.pageSize, defaultPageSize), ...(request.params ?? {}) },
    });
    if (!result.ok) return result;
    return ok({ playlists: extractList(result.data), hasMore: hasMoreFrom(result.data, extractList(result.data).length, positiveInt(request.pageSize, defaultPageSize)) });
  }

  /** 自建歌单删除：**只走 playlistDelete**（拿收藏端点删歌单会拿到"成功"码却没删掉）。 */
  async function deletePlaylist(playlistId, request = {}) {
    if (!isNonEmptyString(playlistId)) return err("删除歌单需要 playlistId", MUSIC_ERROR_KINDS.missingParam);
    const result = await requestJson("playlistDelete", {
      method: request.method ?? "POST",
      params: { [queryNames.id]: playlistId.trim(), ...(request.params ?? {}) },
      body: request.body,
    });
    if (!result.ok) return result;
    return ok({ deleted: true, playlistId: playlistId.trim(), detail: result.data });
  }

  async function search(keyword, request = {}) {
    if (!isNonEmptyString(keyword)) return err("搜索关键字为空", MUSIC_ERROR_KINDS.missingParam);
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const result = await requestJson("search", {
      params: {
        [queryNames.keyword]: keyword.trim(),
        [queryNames.page]: positiveInt(request.page, 1),
        [queryNames.pageSize]: request.pageSize,
        ...(request.params ?? {}),
      },
    });
    if (!result.ok) return result;
    const list = extractList(result.data);
    return ok({ songs: list, hasMore: hasMoreFrom(result.data, list.length, pageSize) });
  }

  async function getAlbum(albumId, request = {}) {
    if (!isNonEmptyString(albumId)) return err("专辑接口需要 albumId", MUSIC_ERROR_KINDS.missingParam);
    const result = await requestJson("album", {
      params: { [queryNames.id]: albumId.trim(), ...(request.params ?? {}) },
    });
    if (!result.ok) return result;
    return ok({ songs: extractList(result.data), detail: result.data });
  }

  async function getArtist(artistId, request = {}) {
    if (!isNonEmptyString(artistId)) return err("歌手接口需要 artistId", MUSIC_ERROR_KINDS.missingParam);
    const result = await requestJson("artist", {
      params: { [queryNames.id]: artistId.trim(), ...(request.params ?? {}) },
    });
    if (!result.ok) return result;
    return ok({ songs: extractList(result.data), detail: result.data });
  }

  async function getHistory(request = {}) {
    const pageSize = positiveInt(request.pageSize, defaultPageSize);
    const result = await requestJson("history", {
      params: { [queryNames.page]: positiveInt(request.page, 1), [queryNames.pageSize]: pageSize, ...(request.params ?? {}) },
    });
    if (!result.ok) return result;
    const list = extractList(result.data);
    return ok({ songs: list, hasMore: hasMoreFrom(result.data, list.length, pageSize) });
  }

  async function getPlayback(request = {}) {
    const trackId = request.trackId ?? request.id;
    if (!isNonEmptyString(trackId)) return err("播放地址接口需要 trackId", MUSIC_ERROR_KINDS.missingParam);
    const result = await requestJson("playback", {
      params: { [queryNames.id]: trackId.trim(), ...(request.params ?? {}) },
    });
    if (!result.ok) return result;
    return parsePlaybackPayload(result.data, { isSafeUrl, flagKeys });
  }

  return {
    endpointOf,
    requestJson,
    listFavoritesPage,
    createFavoritesLoader,
    loadAllFavorites,
    listPlaylists,
    deletePlaylist,
    search,
    getAlbum,
    getArtist,
    getHistory,
    getPlayback,
  };
}

/** 播放地址白名单校验的转发（渲染层/上层不必再 import 两个模块）。 */
export function safePlaybackUrl(value) {
  return safeMediaUrl(value);
}
