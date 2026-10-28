/**
 * 本地歌词导入的渲染层那一半：选文件 → 解码 → 交给官方解析器验一遍 → 交给 core 落盘。
 * 解码放在渲染层：文件本就以 `ArrayBuffer` 到手，sidecar 只收解码后的文本，少一条信任边界；中文 `.lrc` 大量是 GBK。
 * 三条边界：512 KB 上限、空文件/空白文本拒绝、必须真的解析出歌词行（判据是官方解析器）。
 */

/** 与 `src/main/lyrics-store.mjs` / `lyrics:import` 频道同一口径的字节上限。 */
export const LYRICS_IMPORT_MAX_BYTES = 512 * 1024;

/** 文件选择控件接受的扩展名（与文案里说的那两种一致）。 */
export const LYRICS_IMPORT_ACCEPT = ".lrc,.txt";

/** 导入结果的类别（界面按它选文案；`kind` 是结构化的事实，`message` 是给用户看的人话）。 */
export const LYRICS_IMPORT_ERROR_KINDS = Object.freeze({
  unreadable: "unreadable",
  emptyFile: "empty_file",
  tooLarge: "too_large",
  emptyText: "empty_text",
  noLyricLines: "no_lyric_lines",
});

/** 字节 → 文本（BOM 探测 → UTF-8 严格 → GBK 退化），与 sidecar 侧同一条退化链；不抛，认不出回空串。 */
export function decodeLyricsBytes(value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return "";
  if (bytes.length === 0) return "";

  const has = (a, b) => bytes.length >= 2 && bytes[0] === a && bytes[1] === b;
  if (has(0xff, 0xfe)) return decodeWith("utf-16le", bytes.subarray(2));
  if (has(0xfe, 0xff)) return decodeWith("utf-16be", bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeWith("utf-8", bytes.subarray(3));
  }

  const utf8 = decodeWith("utf-8", bytes);
  if (!utf8.includes("\uFFFD")) return utf8;
  // 出过 U+FFFD 才退化：GBK 是中文 .lrc 最常见的另一种编码
  const gbk = decodeWith("gbk", bytes);
  return gbk === "" ? utf8 : gbk;
}

/** 一次 `TextDecoder` 解码；编码不被环境支持时回空串（调用方自己决定退到哪一份）。 */
function decodeWith(encoding, bytes) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return "";
  }
}

/** 文件大小的可读说法（KB，一位小数）。 */
function kbText(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fail(kind, message) {
  return { ok: false, error: { kind, message } };
}

/**
 * 读一个用户选的歌词文件。
 * @param {unknown} file `File`（浏览器）或 `{name, size, arrayBuffer()}`（测试桩）
 * @param {{parseLines?: (text: string) => number}} [deps] `parseLines` = 官方解析适配
 * @returns {Promise<{ok: true, data: {text: string, fileName: string, lineCount: number}} | {ok: false, error: {kind: string, message: string}}>}
 */
export async function readLyricsFile(file, deps = {}) {
  const name = typeof file?.name === "string" && file.name.trim() !== "" ? file.name.trim().slice(0, 200) : "未命名文件";
  const size = Number(file?.size);
  if (Number.isFinite(size) && size === 0) {
    return fail(LYRICS_IMPORT_ERROR_KINDS.emptyFile, `「${name}」是空文件（0 字节）：换一个有内容的 .lrc 或 .txt。`);
  }
  if (Number.isFinite(size) && size > LYRICS_IMPORT_MAX_BYTES) {
    return fail(
      LYRICS_IMPORT_ERROR_KINDS.tooLarge,
      `「${name}」有 ${kbText(size)}，超过上限 ${Math.round(LYRICS_IMPORT_MAX_BYTES / 1024)} KB：换一个更小的歌词文件。`,
    );
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (cause) {
    return fail(
      LYRICS_IMPORT_ERROR_KINDS.unreadable,
      `读不到「${name}」的内容（${cause?.message ?? "未知原因"}）：确认文件还在、并且有读权限，再试一次。`,
    );
  }
  if (buffer instanceof ArrayBuffer && buffer.byteLength > LYRICS_IMPORT_MAX_BYTES) {
    return fail(
      LYRICS_IMPORT_ERROR_KINDS.tooLarge,
      `「${name}」有 ${kbText(buffer.byteLength)}，超过上限 ${Math.round(LYRICS_IMPORT_MAX_BYTES / 1024)} KB：换一个更小的歌词文件。`,
    );
  }

  const text = decodeLyricsBytes(buffer).replace(/^\uFEFF/, "");
  if (text.trim() === "") {
    return fail(
      LYRICS_IMPORT_ERROR_KINDS.emptyText,
      `「${name}」解出来是空白（可能是编码认不出）：换一个 .lrc 或 .txt 歌词文件。`,
    );
  }

  const parseLines = typeof deps.parseLines === "function" ? deps.parseLines : null;
  if (parseLines === null) {
    return fail(LYRICS_IMPORT_ERROR_KINDS.unreadable, "歌词解析器没有接上（这是应用内部的问题）：请把这一条报给开发者。");
  }
  const lineCount = Number(parseLines(text));
  if (!Number.isFinite(lineCount) || lineCount <= 0) {
    return fail(
      LYRICS_IMPORT_ERROR_KINDS.noLyricLines,
      `「${name}」里没有带时间戳的歌词行（LRC 形如 [00:12.34]某一行）：纯文本歌词暂时显示不了，换一份 LRC。`,
    );
  }

  return { ok: true, data: { text, fileName: name, lineCount: Math.trunc(lineCount) } };
}

/** 导入成功之后的确认文案（说清"它已经生效了"，而不是只说"成功"）。 */
export function lyricsImportSuccessText(fileName, lineCount) {
  const name = typeof fileName === "string" && fileName !== "" ? fileName : "歌词文件";
  return `已用「${name}」替换这首歌的歌词（${lineCount} 行）。本地导入优先于任何在线结果。`;
}

/** 歌词缓存占用的可读说法（"N 条 / X MB"）：调用失败、还没问到、宿主任说没有数据目录，三种状态必须分得开。 */
export function lyricsCacheSizeText(info, { failed = false } = {}) {
  if (failed === true) return "读不到缓存占用（详情见运行日志）：缓存是否可用还没确定。";
  if (info === null || info === undefined) return "正在读取缓存占用…";
  const source = info;
  if (source.available !== true) {
    return "缓存不可用：宿主没有给出数据目录（--data-dir 没传对），歌词与本地导入都没地方落盘。";
  }
  const mb = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(2)} MB`;
  const entries = Number(source.entries) || 0;
  const localEntries = Number(source.localEntries) || 0;
  return `在线缓存 ${entries} 条 / ${mb(source.bytes)}；本地导入 ${localEntries} 条 / ${mb(source.localBytes)}`;
}

/** 清缓存之后的确认文案（说清**这次动了哪些**：本地导入默认不删）。 */
export function lyricsCacheClearedText(info, { local = false } = {}) {
  const head = local ? "已清除在线歌词缓存与本地导入。" : "已清除在线歌词缓存（本地导入保留）。";
  return `${head}当前${lyricsCacheSizeText(info)}`;
}
