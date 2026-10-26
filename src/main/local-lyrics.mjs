/**
 * 本地曲目的歌词来源（R65）：用户导入的本地歌词 → 同目录 `.lrc`/`.txt`/内嵌标签 → 如实回 `null`。
 * **sidecar 不接触任何路径**（载荷只有曲目 id）；解码复用 `decodeLyricsBuffer`（中文 `.lrc` 野外多是 GBK）。
 * 字节上限 512 KiB 在这里再判一次：宿主侧那道闸挡不住"两边各自以为对方挡了"。
 */
import {
  LYRICS_TEXT_MAX_BYTES,
  decodeLyricsBuffer,
  sanitizeLyricsDoc,
} from "./lyrics-store.mjs";
import { isLocalTrackId } from "../shared/local-track.ts";

/** 本地歌词来源的字节上限（与 `LYRICS_TEXT_MAX_BYTES` 同一口径，导出成这个名字是为了文档好引用）。 */
export const LYRICS_SOURCE_MAX_BYTES = LYRICS_TEXT_MAX_BYTES;

/** 宿主回来的来源标记 → 我们自己落盘的来源标记（用户回头要认得出这句词从哪来）。 */
const SOURCE_LABELS = { lrc: "local-file", txt: "local-file", embedded: "embedded" };

/** 这个曲目 id 是不是本地曲目（不是就交给在线那条链）。 */
export function isLocalLyricsTrack(trackId) {
  return isLocalTrackId(trackId);
}

/** base64 → Buffer；不是合法 base64 就回 `null`（不抛）。 */
function bytesOf(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const buffer = Buffer.from(value, "base64");
    return buffer.length === 0 ? null : buffer;
  } catch {
    return null;
  }
}

/**
 * 造本地歌词解析器（缺 `localLyricsSource` 就只剩"用户导入的本地歌词"这一跳）。
 * @param {{cache?: object, localLyricsSource?: Function, log?: Function}} [options]
 * @returns {(trackId: string) => Promise<object|null>} 一份可用的歌词文档，或 `null`
 */
export function createLocalLyricsResolver({ cache = null, localLyricsSource = null, log = () => undefined } = {}) {
  async function fromLocalImport(trackId) {
    if (cache === null || typeof cache.readLocal !== "function") return null;
    try {
      const found = await cache.readLocal(trackId);
      return found !== null && typeof found === "object" && found.doc !== null && typeof found.doc === "object"
        ? { ...found.doc, source: "local" }
        : null;
    } catch (cause) {
      log(`本地导入的歌词读不出来（当作没有）：${cause?.message ?? cause}`);
      return null;
    }
  }

  async function fromHost(trackId) {
    if (typeof localLyricsSource !== "function") return null;
    let frame;
    try {
      frame = await localLyricsSource({ trackId });
    } catch (cause) {
      log(`本地歌词来源请求失败（当作没有歌词）：${cause?.message ?? cause}`);
      return null;
    }
    if (frame === null || typeof frame !== "object" || frame.ok !== true) {
      // 宿主说"没有"是正常情形（这首歌确实没配歌词），不刷错误日志
      return null;
    }

    const data = frame.data !== null && typeof frame.data === "object" ? frame.data : null;
    const bytes = bytesOf(data?.bytes);
    if (bytes === null) return null;
    if (bytes.length > LYRICS_SOURCE_MAX_BYTES) {
      log(`本地歌词超过上限（${bytes.length} B > ${LYRICS_SOURCE_MAX_BYTES} B），当作没有歌词`);
      return null;
    }

    const doc = sanitizeLyricsDoc({
      text: decodeLyricsBuffer(bytes),
      format: "lrc",
      source: SOURCE_LABELS[data?.source] ?? "local-file",
      ...(typeof data?.name === "string" ? { fileName: data.name } : {}),
    });
    if (doc === null) {
      log("本地歌词解出来不是可用的歌词（没有带时间戳的行），当作没有歌词");
      return null;
    }
    return doc;
  }

  /** 拿到的第二跳结果进在线缓存：换歌再回来就不必再问宿主（TTL 与在线那一档同一套）。 */
  async function remember(trackId, doc) {
    if (cache === null || typeof cache.writeCached !== "function") return;
    try {
      await cache.writeCached(trackId, doc);
    } catch (cause) {
      log(`本地歌词进缓存失败（不影响这次显示）：${cause?.message ?? cause}`);
    }
  }

  return async function resolve(trackId) {
    if (!isLocalTrackId(trackId)) return null;

    const imported = await fromLocalImport(trackId);
    if (imported !== null) return imported;

    const sourced = await fromHost(trackId);
    if (sourced === null) return null;
    await remember(trackId, sourced);
    return sourced;
  };
}
