/**
 * `library:*` 频道的处理器：把渲染层的库页面请求翻成 src/protocols/music.mjs 的调用。
 * 不猜端点：端点没配就把协议层的结构化 `endpoint_unknown` 原样转达，绝不改写成空列表。
 * 必填参数在这里校验，坏载荷回 `invalid_payload`，不透给协议层。
 * 分页结论不在这一层：`hasMore` 与收藏总数由协议层和完整分页去重给出。
 */
import {
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_FAVORITES,
  LIBRARY_HISTORY,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_PLAYLISTS,
  LIBRARY_SEARCH,
} from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err } from "../shared/result.ts";

/** 请求载荷：不是对象就当成空对象（缺什么由各自的必填校验说话）。 */
function payloadOf(request) {
  const payload = request?.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

/** 非空字符串（去首尾空白）；其余一律 null（空串、空白、数字都不是"用户填了值"）。 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 正整数（页号/页大小）：不是正整数就交给协议层归一，这里不猜。 */
function positiveOf(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** 三个分页频道的共同入参形状（`page` 由协议层换算成真接口的 `start`）。 */
function pageRequest(payload) {
  return { page: positiveOf(payload.page), pageSize: positiveOf(payload.pageSize) };
}

/** 需要一个 id 的频道：缺了就是调用方的问题，如实回 invalid_payload（并指明缺哪个字段）。 */
function requireId(payload, field, message) {
  const candidates = field === "playlistId" ? [payload.playlistId, payload.id] : [payload[field]];
  for (const candidate of candidates) {
    const value = textOf(candidate);
    if (value !== null) return { ok: true, value };
  }
  return { ok: false, result: err(message, CORE_ERROR_KINDS.invalidPayload) };
}

/**
 * 造 library 频道的处理器表（`dispatcher.register` 直接消费）。
 * @param {{api: object}} options `api` = music.mjs 的 `createMusicApi()` 产物（测试注入桩）
 * @returns {Record<string, (request: object) => Promise<object>|object>}
 */
export function createLibraryHandlers({ api } = {}) {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createLibraryHandlers 需要注入 music api（端点未配置时它自己会回结构化错误）");
  }

  return {
    [LIBRARY_FAVORITES]: (request) => api.readFavoritesPage(pageRequest(payloadOf(request))),

    [LIBRARY_PLAYLISTS]: (request) => api.listPlaylists(pageRequest(payloadOf(request))),

    [LIBRARY_PLAYLIST_DETAIL]: (request) => {
      const payload = payloadOf(request);
      const id = requireId(payload, "playlistId", "歌单详情需要 playlistId（歌单列表条目里的 id）");
      if (!id.ok) return id.result;
      return api.getPlaylistDetail(id.value, pageRequest(payload));
    },

    [LIBRARY_SEARCH]: (request) => {
      const payload = payloadOf(request);
      const keyword = textOf(payload.keyword);
      if (keyword === null) {
        return err("搜索需要非空 keyword", CORE_ERROR_KINDS.invalidPayload);
      }
      return api.search(keyword, pageRequest(payload));
    },

    [LIBRARY_ALBUM]: (request) => {
      const payload = payloadOf(request);
      const id = requireId(payload, "albumId", "专辑页需要 albumId");
      if (!id.ok) return id.result;
      return api.getAlbum(id.value, { page: positiveOf(payload.page), pageSize: positiveOf(payload.pageSize) });
    },

    [LIBRARY_ARTIST]: (request) => {
      const payload = payloadOf(request);
      const id = requireId(payload, "artistId", "歌手页需要 artistId");
      if (!id.ok) return id.result;
      return api.getArtist(id.value, {});
    },

    [LIBRARY_HISTORY]: (request) => api.getHistory(pageRequest(payloadOf(request))),
  };
}
