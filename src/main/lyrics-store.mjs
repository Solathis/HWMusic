/**
 * 歌词落盘的纯助手：标识换键、字节解码、歌词判据与文档形状校验，全部无副作用、可单测。
 * 落盘文档是「原始歌词文本 + 来源元数据」，与在线、本地导入两条路交出同一种形状。
 */

import { createHash } from "node:crypto";

/** 歌词文本的字节上限（与协议层的 `LYRICS_MAX_BYTES` 同一口径：512 KiB）。 */
export const LYRICS_TEXT_MAX_BYTES = 512 * 1024;

/** 在线结果的保质期（90 天）：歌词几乎不变，但"永远有效"是另一件事（见 `readCached` 的说明）。 */
export const LYRICS_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** 缓存目录的条目上限（没有索引文件，靠 mtime 裁剪，见 `prune`）。 */
export const LYRICS_CACHE_MAX_FILES = 3000;

/** 来源标记的取值集合（写入方用的词汇表；读到认不出的来源按字符串留着，不当成坏文件）。 */
export const LYRICS_SOURCES = Object.freeze(["huawei", "kugou", "lrclib", "local"]);

/** 元数据字符串（来源 / 匹配到的标题/艺人 / 文件名）的存储上限。 */
export const LYRICS_META_TEXT_MAX = 200;

/** 曲目标识 → 文件名安全键：sha256 前 32 位十六进制，安全、稳定，不把 id 里的怪字符拼进路径。 */
export function lyricsCacheKey(trackId) {
  return createHash("sha256").update(String(trackId ?? "")).digest("hex").slice(0, 32);
}

/** 用户选的歌词文件字节 → 文本：BOM 优先，其次严格 UTF-8，出现 U+FFFD 才退化到 GBK。任何输入都不抛。 */
export function decodeLyricsBuffer(buffer) {
  if (!buffer || typeof buffer.length !== "number" || buffer.length === 0) return "";
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE：先按 16 位交换成小端再走 utf16le；奇数长度丢掉落单那一个字节，交换只用偶数长度视图。
    const body = Buffer.from(bytes.subarray(2));
    const swapped = body.subarray(0, body.length - (body.length % 2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }

  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    return utf8;
  }
}

/** LRC 行首的时间戳，且同一行里真的有词；形状与官方 `parseLrc` 对齐，是「空歌词不落盘」的闸门。 */
const LRC_TIMESTAMP = /^[ \t]*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d+)?\][ \t]*)+[^\s[]/m;

/** 这段文本算不算歌词：至少一行「时间戳 + 词」，等价于 `parseLrc` 至少给出一行。用它而不是拖整个 AMLL 解析器进 sidecar。 */
export function hasTimedLyricLine(text) {
  return typeof text === "string" && LRC_TIMESTAMP.test(text);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 元数据字符串：非空才收，按上限截断（不 trim 内容，只 trim 两端空白）。 */
function metaTextOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, LYRICS_META_TEXT_MAX);
}

/** 落盘文档的形状校验，写入前与读出后都过这一遍：盘上文件是不可信输入，认不出就回 `null` 当没命中。 */
export function sanitizeLyricsDoc(value) {
  if (!isObject(value)) return null;
  if (typeof value.text !== "string") return null;

  // 只去掉开头可能残留的 BOM 与两端空白：正文一个字符都不动。
  const text = value.text.replace(/^\uFEFF/, "").trim();
  if (text === "") return null;
  if (Buffer.byteLength(text, "utf8") > LYRICS_TEXT_MAX_BYTES) return null;
  if (!hasTimedLyricLine(text)) return null;

  const doc = { text, format: metaTextOf(value.format) ?? "lrc" };
  const source = metaTextOf(value.source);
  doc.source = source ?? "huawei";
  for (const key of ["matchedTitle", "matchedArtist", "fileName"]) {
    const meta = metaTextOf(value[key]);
    if (meta !== null) doc[key] = meta;
  }
  if (typeof value.importedAt === "number" && Number.isFinite(value.importedAt) && value.importedAt > 0) {
    doc.importedAt = value.importedAt;
  }
  return doc;
}

/** 非负有限时间戳（毫秒）；其余一律 null。 */
function timeOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 磁盘文档记录 `{version, trackId, savedAt, doc, fileName?, importedAt?}` 的形状校验，坏形状当没命中。
 * `trackId` 必须与要的那个 id 完全相等。
 */
export function sanitizeStoredRecord(value, trackId) {
  if (!isObject(value)) return null;
  if (value.trackId !== trackId) return null;
  const savedAt = timeOf(value.savedAt);
  if (savedAt === null) return null;
  const doc = sanitizeLyricsDoc(value.doc);
  if (doc === null) return null;
  return { savedAt, doc, fileName: metaTextOf(value.fileName), importedAt: timeOf(value.importedAt) };
}
