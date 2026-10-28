/**
 * `lyrics:*` 三条频道的处理器：把渲染层「管理歌词存放」的请求翻成音乐服务的调用。
 * 坏载荷在这一层拒（结构化 `invalid_payload`），歌词内容不进日志，文本算不算歌词由磁盘模块一处判定。
 */
import { LYRICS_CACHE_CLEAR, LYRICS_CACHE_INFO, LYRICS_IMPORT } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err } from "../shared/result.ts";

/** 导入文本的字节上限（与 `src/main/lyrics-store.mjs` 的 `LYRICS_TEXT_MAX_BYTES` 同一口径）。 */
export const LYRICS_IMPORT_MAX_BYTES = 512 * 1024;

/** 请求载荷：不是对象就当成空对象（缺什么由下面的必填校验说话）。 */
function payloadOf(request) {
  const payload = request?.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

/** 非空字符串（去首尾空白）；其余一律 null。 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 造 `lyrics:*` 三条频道的处理器表（`dispatcher.register` 直接消费）。
 * @param {{api: object}} options `api` = `src/protocols/music.mjs` 的 `createMusicApi()` 产物
 */
export function createLyricsHandlers({ api } = {}) {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createLyricsHandlers 需要注入 music api（缓存不可用时它自己会回结构化错误）");
  }

  return {
    [LYRICS_IMPORT]: (request) => {
      const payload = payloadOf(request);
      const trackId = textOf(payload.trackId) ?? textOf(payload.id);
      if (trackId === null) {
        return err("导入本地歌词需要非空 trackId（要替换哪一首的歌词）", CORE_ERROR_KINDS.invalidPayload);
      }
      if (typeof payload.text !== "string") {
        return err("导入本地歌词需要 text（渲染层解码后的歌词文本）", CORE_ERROR_KINDS.invalidPayload);
      }
      if (Buffer.byteLength(payload.text, "utf8") > LYRICS_IMPORT_MAX_BYTES) {
        return err(`歌词文本过大（上限 ${Math.round(LYRICS_IMPORT_MAX_BYTES / 1024)} KB）`, CORE_ERROR_KINDS.invalidPayload);
      }
      const fileName = textOf(payload.fileName);
      return api.importLyrics({ trackId, text: payload.text, ...(fileName === null ? {} : { fileName }) });
    },

    [LYRICS_CACHE_INFO]: () => api.lyricsCacheInfo(),

    [LYRICS_CACHE_CLEAR]: (request) => {
      const payload = payloadOf(request);
      // 只有明确的 `true` 才连本地导入一起删（认不出的一律按"只清在线缓存"——那是更保守的那一侧）
      return api.clearLyricsCache({ local: payload.local === true });
    },
  };
}
