/**
 * 本地歌词导入：渲染层的解码与校验 + 桥的导入链 + core 的频道边界校验。
 *
 * 三段是一条链：选文件 → 字节 → 文本（BOM/UTF-8/GBK）→ 官方解析判有无歌词行；桥只把文本交给 core。
 * 空文件、纯空白、没有时间戳的纯文本歌词都要被拒且说清原因，520 KB 的文件在渲染层就被拦下。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LYRICS_IMPORT_ACCEPT,
  LYRICS_IMPORT_ERROR_KINDS,
  LYRICS_IMPORT_MAX_BYTES,
  decodeLyricsBytes,
  lyricsCacheClearedText,
  lyricsCacheSizeText,
  readLyricsFile,
} from "../src/renderer/features/lyrics/lyrics-import.mjs";
import { createLyricsBridge } from "../src/renderer/features/lyrics/lyrics-bridge.mjs";
import { createLyricsHandlers } from "../src/host/lyrics-handlers.mjs";
import { LYRICS_CACHE_CLEAR, LYRICS_CACHE_INFO, LYRICS_IMPORT } from "../src/shared/request-channels.ts";
import { CORE_ERROR_KINDS } from "../src/shared/result.ts";

const LRC = "[00:01.00]第一行\n[00:05.00]第二行\n";

/** 一个假 File（够 readLyricsFile 用：name/size/arrayBuffer）。 */
function fakeFile(name, bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
  return { name, size: buffer.byteLength, arrayBuffer: async () => buffer };
}

/** 官方解析适配的桩：按"有没有时间戳行"给行数（与 amll-adapter 的结论同形）。 */
const parseLines = (text) => (typeof text === "string" && /^\s*\[\d+:\d+/m.test(text) ? text.trim().split("\n").length : 0);

test("导入（R41）：解码退化链——BOM 优先、UTF-8 严格、出 U+FFFD 才退 GBK", () => {
  const utf8 = new TextEncoder().encode(LRC);
  assert.equal(decodeLyricsBytes(utf8), LRC);

  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.equal(decodeLyricsBytes(bomBytes), LRC, "UTF-8 BOM 被剥掉");

  const utf16 = new Uint8Array([0xff, 0xfe, ...utf8]); // 这里只验"认出了 BOM 分支"，内容按 utf16le 解
  assert.notEqual(decodeLyricsBytes(utf16), "", "UTF-16LE BOM 走 utf16le 分支（不是空）");

  // GBK 的「中文」两字节不是合法 UTF-8 → 出 U+FFFD → 退化
  const gbk = new Uint8Array([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  assert.equal(decodeLyricsBytes(gbk), "[00:01.00]中文\n", "GBK 退化解码");

  assert.equal(decodeLyricsBytes(new Uint8Array()), "", "空字节回空串（不抛）");
  assert.equal(decodeLyricsBytes("不是字节"), "", "非字节输入回空串（不抛）");
});

test("导入（R41）：读文件——四种拒绝各有一句人话（空文件 / 过大 / 空白 / 没有时间戳）", async () => {
  const ok = await readLyricsFile(fakeFile("我的.lrc", new TextEncoder().encode(LRC)), { parseLines });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.fileName, "我的.lrc");
  assert.equal(ok.data.lineCount, 2);
  assert.equal(ok.data.text, LRC);

  const empty = await readLyricsFile(fakeFile("空.lrc", new Uint8Array()), { parseLines });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.kind, LYRICS_IMPORT_ERROR_KINDS.emptyFile);
  assert.match(empty.error.message, /空文件/);

  const huge = await readLyricsFile({ name: "巨大.lrc", size: LYRICS_IMPORT_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) }, { parseLines });
  assert.equal(huge.ok, false);
  assert.equal(huge.error.kind, LYRICS_IMPORT_ERROR_KINDS.tooLarge);
  assert.match(huge.error.message, /512 KB/);

  const blank = await readLyricsFile(fakeFile("空白.lrc", new TextEncoder().encode("   \n\n")), { parseLines });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.kind, LYRICS_IMPORT_ERROR_KINDS.emptyText);

  const plain = await readLyricsFile(fakeFile("纯文本.txt", new TextEncoder().encode("这是纯文本歌词，没有时间戳\n")), { parseLines });
  assert.equal(plain.ok, false);
  assert.equal(plain.error.kind, LYRICS_IMPORT_ERROR_KINDS.noLyricLines);
  assert.match(plain.error.message, /没有带时间戳的歌词行/, "要说清为什么（纯文本歌词显示不了）");
  assert.match(plain.error.message, /换一份 LRC/, "要给下一步");

  // 读不出来（权限/文件消失）
  const unreadable = await readLyricsFile(
    { name: "读不了.lrc", size: 10, arrayBuffer: async () => { throw new Error("EACCES"); } },
    { parseLines },
  );
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.error.kind, LYRICS_IMPORT_ERROR_KINDS.unreadable);

  // 解析器没接上：如实说这是应用内部问题，不假装是用户的文件有问题
  const noParser = await readLyricsFile(fakeFile("a.lrc", new TextEncoder().encode(LRC)), {});
  assert.equal(noParser.ok, false);
  assert.equal(noParser.error.kind, LYRICS_IMPORT_ERROR_KINDS.unreadable);

  assert.equal(LYRICS_IMPORT_ACCEPT, ".lrc,.txt", "文件控件的 accept 是契约");
});

test("导入（R41）：占用/清除文案——三种状态分得开、两处分别说、清完说清动了哪些", () => {
  const ok = { available: true, entries: 12, bytes: 3 * 1024 * 1024, localEntries: 2, localBytes: 1024 };
  assert.match(lyricsCacheSizeText(ok), /在线缓存 12 条 \/ 3\.00 MB/);
  assert.match(lyricsCacheSizeText(ok), /本地导入 2 条/);
  // 三种「没有数字」的状态不许互相冒充：还没问到 ≠ 读不到 ≠ 没有数据目录。
  assert.match(lyricsCacheSizeText(null), /正在读取/, "还没问到 ≠ 读不到 ≠ 没有数据目录");
  assert.match(lyricsCacheSizeText(null, { failed: true }), /读不到缓存占用/, "调用失败要说失败");
  assert.doesNotMatch(lyricsCacheSizeText(null, { failed: true }), /数据目录/, "失败时不许编一个原因");
  assert.match(lyricsCacheSizeText({ available: false }), /没有给出数据目录/, "宿主明确说没有数据目录时才这么说");

  const clearedKept = lyricsCacheClearedText({ available: true, entries: 0, bytes: 0, localEntries: 2, localBytes: 10 });
  assert.match(clearedKept, /本地导入保留/);
  const clearedAll = lyricsCacheClearedText({ available: true, entries: 0, bytes: 0, localEntries: 0, localBytes: 0 }, { local: true });
  assert.match(clearedAll, /与本地导入/);
});

test("导入（R41）：桥——把**文本**交给 core；成功后立刻把这一份推给面板与歌词窗", async () => {
  const calls = [];
  const bridge = createLyricsBridge({
    callCore: async (channel, payload) => {
      calls.push({ channel, payload });
      return { text: LRC, format: "lrc", source: "local", fileName: "我的.lrc" };
    },
    callCommand: async (command, args) => {
      calls.push({ command, args });
      return { config: {}, visible: true };
    },
    subscribeCoreEvent: async () => () => {},
  });

  const result = await bridge.importLyrics({ trackId: "s9", file: fakeFile("我的.lrc", new TextEncoder().encode(LRC)) });
  assert.equal(result.status, "ready");
  assert.equal(result.source, "local");
  assert.equal(result.lineCount, 2);
  assert.equal(result.message, null);

  const request = calls.find((call) => call.channel === LYRICS_IMPORT);
  assert.deepEqual(request.payload, { trackId: "s9", text: LRC, fileName: "我的.lrc" }, "只发文本，不发路径");

  // 导入**本身**不转发（与 loadLyrics 同一条纪律：桥只回答"这一份是什么"，
  // 推给面板与歌词窗是外壳那一步的事——它还要顺手把行数组交给播放运行时）
  assert.equal(calls.some((call) => call.command === "core_lyrics_document"), false);
  await bridge.pushDocument({ lines: result.lines, status: result.status });
  assert.ok(calls.some((call) => call.command === "core_lyrics_document"), "外壳推一次就到位");
});

test("导入（R41）：桥——本地校验失败就不打 core（省一次 IPC，也省一次说不清的失败）", async () => {
  const calls = [];
  const bridge = createLyricsBridge({
    callCore: async (channel, payload) => {
      calls.push({ channel, payload });
      return { text: LRC };
    },
    callCommand: async () => ({ config: {}, visible: false }),
    subscribeCoreEvent: async () => () => {},
  });

  const bad = await bridge.importLyrics({ trackId: "s9", file: fakeFile("纯文本.txt", new TextEncoder().encode("没有时间戳\n")) });
  assert.equal(bad.status, "failed");
  assert.match(bad.message, /没有带时间戳的歌词行/);
  assert.deepEqual(calls, [], "坏文件一次 IPC 都不发");

  // 没有当前曲目
  const noTrack = await bridge.importLyrics({ trackId: "", file: fakeFile("a.lrc", new TextEncoder().encode(LRC)) });
  assert.equal(noTrack.status, "unavailable");
  assert.match(noTrack.message, /先播一首/);

  // core 报错：把 core 的消息原样交出去（它本来就是给用户看的）
  const rejecting = createLyricsBridge({
    callCore: async () => {
      const error = new Error("本地歌词无法保存：没有可用的数据目录");
      error.kind = "cache_unavailable";
      throw error;
    },
    callCommand: async () => ({ config: {}, visible: false }),
    subscribeCoreEvent: async () => () => {},
  });
  const failed = await rejecting.importLyrics({ trackId: "s9", file: fakeFile("a.lrc", new TextEncoder().encode(LRC)) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "本地歌词无法保存：没有可用的数据目录");
});

test("导入（R41）：桥——取词时把曲目元信息带上（第三方严格匹配要用），认不出就不带", async () => {
  const calls = [];
  const bridge = createLyricsBridge({
    callCore: async (channel, payload) => {
      calls.push({ channel, payload });
      return { text: LRC, source: "huawei" };
    },
    callCommand: async () => ({ config: {}, visible: true }),
    subscribeCoreEvent: async () => () => {},
  });

  const withMeta = await bridge.loadLyrics({ trackId: "s9", title: "安静", artist: "周杰伦", durationSeconds: 327 });
  assert.deepEqual(calls[0].payload, { trackId: "s9", title: "安静", artist: "周杰伦", durationSeconds: 327 });
  assert.equal(withMeta.source, "huawei");
  assert.equal(withMeta.status, "ready");

  // 认不出的值不带（绝不编一个默认值去喂匹配器）
  await bridge.loadLyrics({ trackId: "s10", title: "", artist: null, durationSeconds: 0 });
  assert.deepEqual(calls[1].payload, { trackId: "s10" });

  // 旧的字符串入参形态仍然兼容。
  await bridge.loadLyrics("s11");
  assert.deepEqual(calls[2].payload, { trackId: "s11" });
});

test("导入（R41）：core 边界——坏载荷在频道边界被拒，好载荷原样转给 api", async () => {
  const seen = [];
  const api = {
    importLyrics: async (request) => {
      seen.push(request);
      return { ok: true, data: { text: LRC, source: "local" } };
    },
    lyricsCacheInfo: async () => ({ ok: true, data: { available: true } }),
    clearLyricsCache: async (options) => {
      seen.push(options);
      return { ok: true, data: { available: true } };
    },
  };
  const handlers = createLyricsHandlers({ api });

  const missingId = handlers[LYRICS_IMPORT]({ payload: { text: LRC } });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.error.kind, CORE_ERROR_KINDS.invalidPayload);
  assert.match(missingId.error.message, /trackId/);

  const notText = handlers[LYRICS_IMPORT]({ payload: { trackId: "s9", text: 123 } });
  assert.equal(notText.ok, false);
  assert.equal(notText.error.kind, CORE_ERROR_KINDS.invalidPayload);

  const tooLarge = handlers[LYRICS_IMPORT]({ payload: { trackId: "s9", text: "x".repeat(LYRICS_IMPORT_MAX_BYTES + 1) } });
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error.message, /过大/);

  const ok = await handlers[LYRICS_IMPORT]({ payload: { trackId: "s9", text: LRC, fileName: "我的.lrc" } });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen[0], { trackId: "s9", text: LRC, fileName: "我的.lrc" });

  assert.deepEqual(await handlers[LYRICS_CACHE_INFO]({ payload: null }), { ok: true, data: { available: true } });

  // 清缓存：只有明确的 true 才连本地导入一起删（认不出的一律按更保守的那一侧）
  await handlers[LYRICS_CACHE_CLEAR]({ payload: { local: true } });
  await handlers[LYRICS_CACHE_CLEAR]({ payload: {} });
  await handlers[LYRICS_CACHE_CLEAR]({ payload: { local: "yes" } });
  assert.deepEqual(seen.slice(1), [{ local: true }, { local: false }, { local: false }]);
});
