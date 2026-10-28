/**
 * 歌词落盘的纯助手：文件名键、编码退化链、读出后再校验——三者的失败都不响。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LYRICS_CACHE_MAX_FILES,
  LYRICS_CACHE_TTL_MS,
  LYRICS_TEXT_MAX_BYTES,
  decodeLyricsBuffer,
  hasTimedLyricLine,
  lyricsCacheKey,
  sanitizeLyricsDoc,
  sanitizeStoredRecord,
} from "../src/main/lyrics-store.mjs";

const SAMPLE = "[00:01.00]第一行\n[00:05.00]第二行\n";

test("歌词（R41）：缓存键是 sha256 前 32 位十六进制——危险字符进不了文件名", () => {
  const key = lyricsCacheKey("../../etc/passwd");
  assert.match(key, /^[0-9a-f]{32}$/, `键必须是十六进制：${key}`);
  assert.equal(lyricsCacheKey("s1"), lyricsCacheKey("s1"), "同一个 id 永远同一个键");
  assert.notEqual(lyricsCacheKey("s1"), lyricsCacheKey("s2"));
  assert.equal(lyricsCacheKey(null), lyricsCacheKey(""), "空值归一成同一个键（不抛）");
  assert.match(lyricsCacheKey("a/b:c*?"), /^[0-9a-f]{32}$/);
});

test("歌词（R41）：编码退化链——BOM 声明优先，无 BOM 走 UTF-8，出 U+FFFD 才退 GBK", () => {
  const text = "[00:01.00]中文歌词\n";

  const utf8 = Buffer.from(text, "utf8");
  assert.equal(decodeLyricsBuffer(utf8), text, "合法 UTF-8 原样解出");

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.equal(decodeLyricsBuffer(withBom), text, "UTF-8 BOM 被剥掉（文本里不该残留 \\uFEFF）");

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  assert.equal(decodeLyricsBuffer(utf16le), text, "UTF-16LE BOM 走 utf16le");

  const utf16beBody = Buffer.from(text, "utf16le");
  utf16beBody.swap16();
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]);
  assert.equal(decodeLyricsBuffer(utf16be), text, "UTF-16BE BOM 先交换字节序再解");

  // UTF-16BE 奇数长度（BOM 之后落单一个字节）：截尾再交换，绝不抛。
  const truncated = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody, Buffer.from([0x41])]);
  assert.doesNotThrow(() => decodeLyricsBuffer(truncated), "奇数长度不许抛（swap16 对奇数长度会抛）");
  assert.equal(decodeLyricsBuffer(truncated), text, "落单的那一个字节丢掉，前面完整的字照旧解出来");
  assert.equal(
    decodeLyricsBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x41])])),
    "",
    "BOM 之后只有一个字节 → 没有任何完整码元，回空串（不抛）",
  );
  assert.equal(decodeLyricsBuffer(Buffer.from([0xfe, 0xff])), "", "只有 BOM → 空串");
  // 调用方的 buffer 不许被就地改掉（swap16 是原地交换，所以必须先复制）
  const original = Buffer.from(truncated);
  decodeLyricsBuffer(truncated);
  assert.deepEqual(truncated, original, "解码不该就地改动调用方的字节");

  // GBK：`中文` 的 GBK 字节不是合法 UTF-8，所以会出 U+FFFD → 退化
  const gbk = Buffer.from([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeLyricsBuffer(gbk), "[00:01.00]中文", "GBK 退化解码");

  assert.equal(decodeLyricsBuffer(Buffer.alloc(0)), "", "空 buffer 回空串（不抛）");
  assert.equal(decodeLyricsBuffer(null), "", "非 buffer 回空串（不抛）");
});

test("歌词（R41）：『算不算歌词』的判据是『至少一行带 LRC 时间戳』（空结果的等价判据）", () => {
  assert.equal(hasTimedLyricLine("[00:01.00]词"), true);
  assert.equal(hasTimedLyricLine("[00:01]词"), true, "没有百分秒也算");
  assert.equal(hasTimedLyricLine("[100:01:500]词"), true, "分钟/百分秒位数不定也算");
  assert.equal(hasTimedLyricLine("[ti:标题]\n[ar:艺人]\n纯文本一行"), false, "只有元数据/纯文本 → 不算歌词");
  assert.equal(hasTimedLyricLine(""), false);
  assert.equal(hasTimedLyricLine(null), false, "非字符串不抛");
});

test("歌词（R41）：落盘文档校验——认不出就回 null（调用方按『没命中』继续往下走）", () => {
  assert.deepEqual(sanitizeLyricsDoc({ text: SAMPLE, source: "huawei" }), {
    text: "[00:01.00]第一行\n[00:05.00]第二行",
    format: "lrc",
    source: "huawei",
  });

  // 元数据带上一份（第三方命中时记的是"匹配到的那一条"）
  assert.deepEqual(
    sanitizeLyricsDoc({ text: SAMPLE, source: "kugou", matchedTitle: "歌", matchedArtist: "A / B" }),
    { text: "[00:01.00]第一行\n[00:05.00]第二行", format: "lrc", source: "kugou", matchedTitle: "歌", matchedArtist: "A / B" },
  );

  // 本地导入多两个键
  const local = sanitizeLyricsDoc({ text: SAMPLE, source: "local", fileName: "我的.lrc", importedAt: 123 });
  assert.equal(local.fileName, "我的.lrc");
  assert.equal(local.importedAt, 123);

  // 六种坏形状一律 null
  for (const bad of [
    null,
    "text",
    [],
    {},
    { text: "" },
    { text: "   " },
    { text: 123 },
    { text: "没有时间戳的一行" },
    { text: "x".repeat(LYRICS_TEXT_MAX_BYTES + 1) + "\n[00:01.00]词" },
  ]) {
    assert.equal(sanitizeLyricsDoc(bad), null, `坏形状必须回 null：${JSON.stringify(bad).slice(0, 40)}`);
  }

  // 认不出的来源**不当成坏文件**（来源只是说明文字，内容的可用性不以它为条件）
  assert.equal(sanitizeLyricsDoc({ text: SAMPLE, source: "future_provider" }).source, "future_provider");
  // 没有来源时按 huawei 记（本仓最常见的来源），不编一个"unknown"
  assert.equal(sanitizeLyricsDoc({ text: SAMPLE }).source, "huawei");
  // 来源/标题超长会被截断（不让元数据把文件撑大）
  assert.equal(sanitizeLyricsDoc({ text: SAMPLE, source: "s".repeat(500) }).source.length, 200);
});

test("歌词（R41）：磁盘记录校验——id 对不上就是不命中（文件名与内容必须自证同一份）", () => {
  const record = { version: 1, trackId: "s1", savedAt: 1000, doc: { text: SAMPLE, source: "huawei" } };
  assert.deepEqual(sanitizeStoredRecord(record, "s1"), {
    savedAt: 1000,
    doc: { text: "[00:01.00]第一行\n[00:05.00]第二行", format: "lrc", source: "huawei" },
    fileName: null,
    importedAt: null,
  });
  assert.equal(sanitizeStoredRecord(record, "s2"), null, "id 对不上 = 不是我们要的那一份");
  assert.equal(sanitizeStoredRecord({ ...record, savedAt: "昨天" }, "s1"), null, "savedAt 必须是数字");
  assert.equal(sanitizeStoredRecord({ ...record, savedAt: 0 }, "s1"), null, "0 不是时间戳");
  assert.equal(sanitizeStoredRecord({ ...record, doc: { text: "无时间戳" } }, "s1"), null);
  assert.equal(sanitizeStoredRecord(null, "s1"), null);

  const localRecord = { ...record, fileName: "我的.lrc", importedAt: 999 };
  assert.equal(sanitizeStoredRecord(localRecord, "s1").fileName, "我的.lrc");
  assert.equal(sanitizeStoredRecord({ ...record, importedAt: -1 }, "s1").importedAt, null, "负数时间戳当没有");
});

test("歌词（R41）：三个常量是契约（TTL 90 天 / 单文件 512 KiB / 上限 3000 条）", () => {
  assert.equal(LYRICS_CACHE_TTL_MS, 90 * 24 * 60 * 60 * 1000);
  assert.equal(LYRICS_TEXT_MAX_BYTES, 512 * 1024);
  assert.equal(LYRICS_CACHE_MAX_FILES, 3000);
});
