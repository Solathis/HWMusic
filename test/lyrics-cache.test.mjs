/**
 * 歌词磁盘缓存（用真目录跑）：90 天 TTL、空歌词不落盘、单文件上限、prune 按 mtime、读写失败不炸、本地导入失败要抛。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLyricsCache, LYRICS_CACHE_DIR_NAME, LYRICS_LOCAL_DIR_NAME } from "../src/main/lyrics-cache.mjs";
import { LYRICS_CACHE_TTL_MS, lyricsCacheKey } from "../src/main/lyrics-store.mjs";

const SAMPLE = "[00:01.00]第一行\n[00:05.00]第二行\n";
const SAMPLE2 = "[00:02.00]另一首\n";

/** 一个用完即删的临时数据根。 */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "hwmusic-lyrics-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("歌词缓存（R41）：写→读（同一份文档），并且落在数据根下的 lyrics-cache/", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    assert.equal(await cache.readCached("s1"), null, "还没写过就是没命中");

    const written = await cache.writeCached("s1", { text: SAMPLE, source: "huawei" });
    assert.equal(written.written, true);
    const doc = await cache.readCached("s1");
    assert.equal(doc.text, "[00:01.00]第一行\n[00:05.00]第二行");
    assert.equal(doc.source, "huawei");

    const names = readdirSync(join(root.dir, LYRICS_CACHE_DIR_NAME));
    assert.deepEqual(names, [`${lyricsCacheKey("s1")}.json`], "文件名是 sha256 键，不是原始 id");
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：90 天 TTL——过期当没命中（文件还在，不靠删文件实现）", async () => {
  const root = tempRoot();
  try {
    let clock = 1_000_000;
    const cache = createLyricsCache({ dir: root.dir, now: () => clock });
    await cache.writeCached("s1", { text: SAMPLE, source: "huawei" });

    clock += LYRICS_CACHE_TTL_MS - 1;
    assert.notEqual(await cache.readCached("s1"), null, "89 天 23 小时 59 分还命中");

    clock += 2;
    assert.equal(await cache.readCached("s1"), null, "越过 90 天就是没命中");
    assert.equal(readdirSync(join(root.dir, LYRICS_CACHE_DIR_NAME)).length, 1, "读路径不删文件（删除是 prune/clear 的事）");
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：空歌词不落盘（『没歌词』必须能被下一次尝试推翻）", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    assert.deepEqual(await cache.writeCached("s1", { text: "", source: "huawei" }), {
      written: false,
      reason: "empty_or_invalid",
    });
    assert.deepEqual(await cache.writeCached("s1", { text: "没有时间戳的一行", source: "huawei" }), {
      written: false,
      reason: "empty_or_invalid",
    });
    assert.equal(await cache.readCached("s1"), null);
    assert.deepEqual(await cache.info(), { available: true, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
    assert.equal(existsSync(join(root.dir, LYRICS_CACHE_DIR_NAME)), false, "一次都没写过 → 目录根本不该被建出来");
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：超过 512 KiB 不写（截断后的歌词会缺行，比不缓存更糟）", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    // 每行 ~200 字节 × 4000 行 ≈ 800 KB
    const huge = Array.from({ length: 4000 }, (_, index) => `[00:${String(index % 60).padStart(2, "0")}.00]${"字".repeat(60)}`).join("\n");
    const result = await cache.writeCached("s1", { text: huge, source: "huawei" });
    assert.equal(result.written, false);
    assert.ok(["too_large", "empty_or_invalid"].includes(result.reason), `reason=${result.reason}`);
    assert.equal(await cache.readCached("s1"), null);
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：坏文件 / 半截 JSON / id 对不上 / 过期字段 → 一律当没命中（不抛）", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    const dir = join(root.dir, LYRICS_CACHE_DIR_NAME);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, `${lyricsCacheKey("s1")}.json`), "{半截", "utf8");
    assert.equal(await cache.readCached("s1"), null, "坏 JSON 不抛");

    writeFileSync(join(dir, `${lyricsCacheKey("s2")}.json`), JSON.stringify({ trackId: "别的", savedAt: 1, doc: { text: SAMPLE } }), "utf8");
    assert.equal(await cache.readCached("s2"), null, "记录里的 id 对不上 = 不是我们要的那一份");

    writeFileSync(join(dir, `${lyricsCacheKey("s3")}.json`), JSON.stringify({ trackId: "s3", savedAt: "昨天", doc: { text: SAMPLE } }), "utf8");
    assert.equal(await cache.readCached("s3"), null, "savedAt 不是数字");

    // 目录本身不存在也照旧不抛
    const empty = createLyricsCache({ dir: join(root.dir, "没有这个目录") });
    assert.equal(await empty.readCached("s1"), null);
    assert.deepEqual(await empty.info(), { available: true, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：prune 按 mtime 裁最旧的，条目数回到上限内", async () => {
  const root = tempRoot();
  try {
    // maxFiles 注入成 4（默认 3000 那条由 lyrics-store 的常量测试钉住）：这里要测的是规则本身
    const cache = createLyricsCache({ dir: root.dir, maxFiles: 4 });
    const dir = join(root.dir, LYRICS_CACHE_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 7; index += 1) {
      const path = join(dir, `${lyricsCacheKey(`t${index}`)}.json`);
      writeFileSync(path, JSON.stringify({ version: 1, trackId: `t${index}`, savedAt: 1, doc: { text: SAMPLE, source: "huawei" } }), "utf8");
      // mtime 递增：t0 最旧
      const when = new Date(1_700_000_000_000 + index * 1000);
      utimesSync(path, when, when);
    }
    assert.equal(readdirSync(dir).length, 7);

    const result = await cache.prune();
    assert.equal(result.removed, 3, "只裁超出的那 3 条");
    assert.equal(readdirSync(dir).length, 4);
    assert.equal(readdirSync(dir).includes(`${lyricsCacheKey("t0")}.json`), false, "最旧的先走（mtime 最小的那几条）");
    assert.equal(readdirSync(dir).includes(`${lyricsCacheKey("t6")}.json`), true, "最新的留着");

    // 写一次顺带触发 prune：写完之后仍然在限制内
    await cache.writeCached("fresh", { text: SAMPLE2, source: "huawei" });
    assert.equal(readdirSync(dir).length, 4, "写入后自动裁剪到上限");
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：stats 只算 .json；clear 默认只删在线缓存，local:true 才连本地一起删", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    await cache.writeCached("s1", { text: SAMPLE, source: "huawei" });
    await cache.writeCached("s2", { text: SAMPLE2, source: "lrclib" });
    await cache.writeLocal("s3", { text: SAMPLE, fileName: "我的.lrc" });

    const info = await cache.info();
    assert.equal(info.available, true);
    assert.equal(info.entries, 2, "在线缓存 2 条");
    assert.equal(info.localEntries, 1, "本地导入 1 条");
    assert.ok(info.bytes > 0 && info.localBytes > 0);

    // 别的杂物不算进统计
    writeFileSync(join(root.dir, LYRICS_CACHE_DIR_NAME, "笔记.txt"), "不是缓存", "utf8");
    assert.equal((await cache.info()).entries, 2, "非 .json 不参与统计");

    const kept = await cache.clear();
    assert.equal(kept.entries, 0, "在线缓存清空");
    assert.equal(kept.localEntries, 1, "本地导入保留（默认不碰用户的文件）");
    assert.equal(await cache.readCached("s1"), null);

    const cleared = await cache.clear({ local: true });
    assert.equal(cleared.localEntries, 0, "显式 local:true 才删本地导入");
    assert.equal(await cache.readLocal("s3"), null);
    // 幂等：再清一次不抛
    assert.equal((await cache.clear({ local: true })).entries, 0);
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：本地导入——带文件名/时间读回、不被 TTL 作废、坏文本要抛", async () => {
  const root = tempRoot();
  try {
    let clock = 5_000;
    const cache = createLyricsCache({ dir: root.dir, now: () => clock });
    const written = await cache.writeLocal("s1", { text: SAMPLE, fileName: "我的歌词.lrc" });
    assert.equal(written.written, true);
    assert.equal(written.doc.source, "local");

    const found = await cache.readLocal("s1");
    assert.equal(found.doc.text, "[00:01.00]第一行\n[00:05.00]第二行");
    assert.equal(found.doc.source, "local", "本地导入永远带 source:local（它要压过在线结果）");
    assert.equal(found.fileName, "我的歌词.lrc");
    assert.equal(found.importedAt, 5000);

    // 一亿毫秒之后照旧命中（本地导入是用户的意图，不该被时间作废）
    clock += LYRICS_CACHE_TTL_MS * 100;
    assert.notEqual(await cache.readLocal("s1"), null);

    // 本地目录不参与 prune
    assert.deepEqual(readdirSync(join(root.dir, LYRICS_LOCAL_DIR_NAME)), [`${lyricsCacheKey("s1")}.json`]);
    assert.equal(await cache.removeLocal("s1"), true);
    assert.equal(await cache.removeLocal("s1"), false, "删第二次如实回 false");

    // 坏文本要抛（用户按了导入就 expect 它记住，静默失败 = 下次歌词又没了）
    await assert.rejects(() => cache.writeLocal("s2", { text: "", fileName: "空.lrc" }), /不是可用的歌词/);
    await assert.rejects(() => cache.writeLocal("s2", { text: "没有时间戳" }), /不是可用的歌词/);
    await assert.rejects(() => cache.writeLocal("", { text: SAMPLE }), /非空 trackId/);
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：在线缓存拒绝 source:local（本地那一条只许住在 lyrics-local/）", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    assert.deepEqual(await cache.writeCached("s1", { text: SAMPLE, source: "local" }), {
      written: false,
      reason: "local_never_here",
    });
    assert.deepEqual(await cache.info(), { available: true, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：没有数据目录 → available:false，读回没命中、写不落盘、导入与清缓存如实报不可用", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: null });
    assert.equal(cache.available, false);
    assert.deepEqual(await cache.info(), { available: false, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
    assert.equal(await cache.readCached("s1"), null);
    assert.equal(await cache.readLocal("s1"), null);
    assert.deepEqual(await cache.writeCached("s1", { text: SAMPLE, source: "huawei" }), {
      written: false,
      reason: "unavailable",
    });
    await assert.rejects(() => cache.writeLocal("s1", { text: SAMPLE, fileName: "x.lrc" }), /没有数据目录/);
    assert.equal(await cache.removeLocal("s1"), false);
    assert.deepEqual(await cache.clear({ local: true }), {
      available: false,
      bytes: 0,
      entries: 0,
      localBytes: 0,
      localEntries: 0,
    });
    // 一个文件都没写出去
    assert.deepEqual(readdirSync(root.dir), []);
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：写入失败不抛（缓存是『下次更快』，不是『这次能不能看』）", async () => {
  const root = tempRoot();
  try {
    const logs = [];
    // 把一个**文件**当成数据根：mkdir 会 ENOTDIR，落盘必然失败
    const fileAsRoot = join(root.dir, "这是个文件");
    writeFileSync(fileAsRoot, "x", "utf8");
    const cache = createLyricsCache({ dir: fileAsRoot, log: (line) => logs.push(line) });
    const result = await cache.writeCached("s1", { text: SAMPLE, source: "huawei" });
    assert.equal(result.written, false);
    assert.equal(result.reason, "write_failed");
    assert.equal(logs.length, 1, "失败要留一行日志（否则没人知道缓存没写进去）");
    assert.match(logs[0], /歌词缓存写入失败/);
    assert.equal(statSync(fileAsRoot).isFile(), true, "原来的文件没被破坏");
  } finally {
    root.done();
  }
});

test("歌词缓存（R41）：原子写不留临时文件（temp+rename；连写两次也只有最终那一份）", async () => {
  const root = tempRoot();
  try {
    const cache = createLyricsCache({ dir: root.dir });
    await cache.writeCached("s1", { text: SAMPLE, source: "huawei" });
    await cache.writeCached("s1", { text: SAMPLE2, source: "kugou" });
    const names = readdirSync(join(root.dir, LYRICS_CACHE_DIR_NAME));
    assert.deepEqual(names, [`${lyricsCacheKey("s1")}.json`], `不该留下 .tmp：${names.join(", ")}`);
    const stored = JSON.parse(readFileSync(join(root.dir, LYRICS_CACHE_DIR_NAME, names[0]), "utf8"));
    assert.equal(stored.doc.source, "kugou", "第二次写覆盖了第一次");
  } finally {
    root.done();
  }
});
