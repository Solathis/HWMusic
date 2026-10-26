/**
 * R65 本地曲目歌词（`src/main/local-lyrics.mjs`）：来源优先级、编码识别、字节上限、缓存。
 * 优先级是**用户意图优先**：手动导入的本地歌词（`lyrics-local/`）> 同名 `.lrc`/`.txt` > 内嵌标签；都没有就如实回"没有"。
 * 夹具全部现场生成字节（GBK 与 UTF-16 各一份），不读真实音乐文件。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LYRICS_SOURCE_MAX_BYTES,
  createLocalLyricsResolver,
  isLocalLyricsTrack,
} from "../src/main/local-lyrics.mjs";

const HEX = "0123456789abcdef0123456789abcdef";
const TRACK = `local:${HEX}`;

/** GBK 的「中文」= D6 D0 CE C4（UTF-8 解码会出替换字符，于是走 GBK 那一档）。 */
const GBK_BYTES = Buffer.concat([
  Buffer.from("[00:01.00]", "ascii"),
  Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
]);

function utf16leBytes(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** 假的宿主端口：记录每次调用的载荷，按脚本回帧。 */
function fakeHost(answers) {
  const calls = [];
  return {
    calls,
    localLyricsSource: async (payload) => {
      calls.push(payload);
      const answer = answers.shift();
      return answer ?? { ok: true, data: null };
    },
  };
}

/** 假的歌词缓存端口（只实现这个解析器要用的三个方法）。 */
function fakeCache({ local = null } = {}) {
  const written = [];
  return {
    written,
    readLocal: async () => local,
    writeCached: async (trackId, doc) => {
      written.push({ trackId, doc });
      return { written: true };
    },
  };
}

const frameWithBytes = (bytes, source = "lrc") => ({
  ok: true,
  data: { bytes: bytes.toString("base64"), source, name: "同名歌词.lrc" },
});

test("只认 local: 曲目（其余交给在线那条链，不许在这里截走）", () => {
  assert.equal(isLocalLyricsTrack(TRACK), true);
  for (const other of [HEX, "music-123", "local:zzz", null, 42]) {
    assert.equal(isLocalLyricsTrack(other), false, `必须拒绝：${String(other)}`);
  }
  assert.equal(LYRICS_SOURCE_MAX_BYTES, 512 * 1024);
});

test("优先级：用户手动导入的本地歌词压过宿主给的同名文件（不调用宿主）", async () => {
  const host = fakeHost([]);
  const cache = fakeCache({ local: { doc: { text: "[00:01.00]手动导入", format: "lrc", source: "local" }, fileName: "a.lrc" } });
  const resolve = createLocalLyricsResolver({ cache, localLyricsSource: host.localLyricsSource });

  const doc = await resolve(TRACK);
  assert.equal(doc.source, "local");
  assert.equal(doc.text, "[00:01.00]手动导入");
  assert.deepEqual(host.calls, [], "有手动导入时不该再去问宿主");
});

test("优先级：没有手动导入就问宿主；宿主没有就回 null（不编一份空歌词）", async () => {
  const host = fakeHost([{ ok: true, data: null }]);
  const cache = fakeCache();
  const resolve = createLocalLyricsResolver({ cache, localLyricsSource: host.localLyricsSource });

  assert.equal(await resolve(TRACK), null);
  assert.deepEqual(host.calls, [{ trackId: TRACK }], "载荷只有曲目 id（sidecar 不接触任何路径）");
});

test("编码：GBK 与 UTF-16LE 的字节都能解对（复用 decodeLyricsBuffer 的退化链）", async () => {
  for (const [bytes, expected] of [
    [GBK_BYTES, "[00:01.00]中文"],
    [utf16leBytes("[00:01.00]中文"), "[00:01.00]中文"],
  ]) {
    const host = fakeHost([frameWithBytes(bytes)]);
    const resolve = createLocalLyricsResolver({ cache: fakeCache(), localLyricsSource: host.localLyricsSource });
    const doc = await resolve(TRACK);
    assert.ok(doc, "这两份字节都必须能解出歌词");
    assert.equal(doc.text, expected);
    assert.equal(doc.format, "lrc");
    assert.equal(doc.source, "local-file", "来源如实标成同目录文件（不是 local 导入，也不是在线）");
  }
});

test("缓存：宿主那一路的结果按曲目写进在线缓存（下次不再问宿主）", async () => {
  const host = fakeHost([frameWithBytes(Buffer.from("[00:02.00]词", "utf8"), "embedded")]);
  const cache = fakeCache();
  const resolve = createLocalLyricsResolver({ cache, localLyricsSource: host.localLyricsSource });

  const doc = await resolve(TRACK);
  assert.equal(doc.source, "embedded", "内嵌歌词的来源要标出来（用户看得见它从哪来）");
  assert.equal(cache.written.length, 1);
  assert.equal(cache.written[0].trackId, TRACK);
  assert.equal(cache.written[0].doc.text, "[00:02.00]词");
});

test("字节上限：超过 512 KiB 的字节不解析、不进缓存（宁可没有歌词，也不吃满内存）", async () => {
  const oversized = Buffer.concat([
    Buffer.from("[00:01.00]开头", "utf8"),
    Buffer.alloc(LYRICS_SOURCE_MAX_BYTES + 1, 0x61),
  ]);
  const host = fakeHost([frameWithBytes(oversized)]);
  const cache = fakeCache();
  const resolve = createLocalLyricsResolver({ cache, localLyricsSource: host.localLyricsSource });

  assert.equal(await resolve(TRACK), null);
  assert.deepEqual(cache.written, [], "超限的东西一格缓存都不许占");
});

test("坏字节/没有时间戳/宿主报错：一律回 null（不抛，不冒充有歌词）", async () => {
  const cases = [
    [frameWithBytes(Buffer.from("这一行没有时间戳", "utf8"))],
    [frameWithBytes(Buffer.alloc(0))],
    [{ ok: false, error: { kind: "invalid_payload", message: "宿主要求缺少字符串字段" } }],
    [{ ok: true, data: { bytes: "", source: "lrc" } }],
    [{ ok: true, data: { bytes: "!!!not base64!!!", source: "lrc" } }],
  ];
  for (const answer of cases) {
    const host = fakeHost([answer]);
    const resolve = createLocalLyricsResolver({ cache: fakeCache(), localLyricsSource: host.localLyricsSource });
    assert.equal(await resolve(TRACK), null, `必须回 null：${JSON.stringify(answer).slice(0, 60)}`);
  }
});

test("宿主端口抛异常：按\"没有歌词\"收场（宿主挂了不该让播放崩溃）", async () => {
  const resolve = createLocalLyricsResolver({
    cache: fakeCache(),
    localLyricsSource: async () => {
      throw new Error("core 不可用");
    },
  });
  assert.equal(await resolve(TRACK), null);
});

test("没有缓存端口时也能工作（只少掉一层持久化，不少掉功能）", async () => {
  const host = fakeHost([frameWithBytes(Buffer.from("[00:03.00]词", "utf8"))]);
  const resolve = createLocalLyricsResolver({ localLyricsSource: host.localLyricsSource });
  const doc = await resolve(TRACK);
  assert.equal(doc.text, "[00:03.00]词");
});
