/**
 * `lyrics:*` 三条频道的处理器（R41）：把渲染层的"管理歌词存放"的请求翻成音乐服务的调用。
 *
 * 三条频道对应三个**用户动作**（与 `library:*` / `playback:*` 同一套处置纪律）：
 *
 * | 频道 | 载荷 | 应答 `data` |
 * |---|---|---|
 * | `lyrics:import` | `{trackId, text, fileName?}` | 生效的歌词文档（`source: "local"`） |
 * | `lyrics:cache-info` | `null` | `{available, bytes, entries, localBytes, localEntries}` |
 * | `lyrics:cache-clear` | `{local?: boolean}` | 清完之后的**新**占用（同上形状） |
 *
 * 三条边界：
 * 1. **坏载荷在这一层拒**（缺 trackId / text 不是字符串 / 文本超上限），结构化 `invalid_payload`
 *    ——不把一份 8 MB 的字符串递给磁盘模块再指望它在里面报错；
 * 2. **歌词内容不进日志**：这里 `console.*` 一个都没有（与 `playback-handlers.mjs` 同一条纪律）。
 *    磁盘模块自己的日志只记"写入失败"这类结论，不记文本；
 * 3. **不做二次校验**：文本"算不算歌词"的判定在磁盘模块（`sanitizeLyricsDoc`）一处，
 *    这里只做"载荷形状够不够"——两处各判一次，早晚会判出两个不同的答案。
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
 *
 * @param {{api: object}} options `api` = `src/protocols/music.mjs` 的 `createMusicApi()` 产物
 *   （三件事都走它：协议层是唯一碰"缓存端口"的地方，处理器不自己拿 fs）
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
