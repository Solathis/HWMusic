/**
 * R9 歌词适配（`features/lyrics/amll-adapter.ts`）：AMLL 官方 `parseLrc` → `LyricLine[]`，
 * 外加两处**补偿**（R4 遗留）。
 *
 * R4 实测登记的两条 AMLL 行为：
 * 1. `[offset:±ms]` 元数据被忽略（不参与时间平移）——这里补上；
 * 2. 同一时间戳的多行（译文/音译）**不会**合并进 `translatedLyric`，而是各自成行——
 *    这里按"同时间戳的第一行是正文、第二行是译文、第三行是音译"合并；再多出来的
 *    **保留为独立行**（宁可多显示一行，也不能把歌词静默吃掉）。
 *
 * 解析、时间轴、词级切分仍然是官方 `parseLrc` 的事——本文件里没有一行时间戳正则，
 * 也没有任何"自己画歌词"的东西（渲染是 AMLL 组件的职责，R9 的面板只做宿主）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LRC_OFFSET_PATTERN,
  lyricLineText,
  mergeTranslationLines,
  parseAmllLyrics,
  readLrcOffsetMs,
  shiftLyricLines,
} from "../src/renderer/features/lyrics/amll-adapter.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const PLAIN_LRC = [
  "[ti:示例曲目]",
  "[ar:示例歌手]",
  "[00:01.50]第一行歌词",
  "[00:05.00]第二行歌词",
  "[00:09.25]第三行歌词",
  "",
].join("\n");

test("真实 LRC 样本 → AMLL LyricLine[]（时间戳毫秒，形状与官方解析一致）", () => {
  const result = parseAmllLyrics(PLAIN_LRC);
  assert.equal(result.isEmpty, false);
  assert.equal(result.lines.length, 3);

  const first = result.lines[0];
  assert.equal(first.startTime, 1500, "offset 缺失时时间不动（与 R4 协议层同结论）");
  assert.equal(first.words[0].word, "第一行歌词");
  assert.equal(first.endTime, 5000, "行终点由 AMLL 用下一行起点补齐");
  assert.equal(first.translatedLyric, "");
  assert.equal(first.romanLyric, "");
  assert.equal(typeof first.isBG, "boolean");
  assert.equal(typeof first.isDuet, "boolean");
  assert.deepEqual(result.stats, { parsed: 3, merged: 0, extraKept: 0, offsetMs: 0 });
});

test("offset 补偿：`[offset:-500]` 把正文与逐字词一起前移（AMLL 官方会忽略它）", () => {
  const lrc = "[offset:-500]\n[00:02.00]前移\n[00:06.00]再次\n";
  assert.equal(readLrcOffsetMs(lrc), -500);

  const result = parseAmllLyrics(lrc);
  assert.equal(result.stats.offsetMs, -500);
  assert.equal(result.lines[0].startTime, 1500);
  assert.equal(result.lines[0].endTime, 5500);
  assert.equal(result.lines[1].startTime, 5500);
  assert.deepEqual(
    result.lines[0].words.map((word) => word.startTime),
    [1500],
    "词级时间也要跟着移，否则逐字动画会跟行错位",
  );
});

test("offset 补偿：`[offset:+250]` 后移；写法容错（空格/大小写/加号）", () => {
  assert.equal(readLrcOffsetMs("[offset:+250]\n[00:01.00]a"), 250);
  assert.equal(readLrcOffsetMs("[OFFSET: 300]\n[00:01.00]a"), 300);
  assert.equal(readLrcOffsetMs("[offset:0]\n[00:01.00]a"), 0);
  assert.equal(readLrcOffsetMs("[00:01.00]a"), 0, "没有这个标签就是 0");
  assert.equal(readLrcOffsetMs("[offset:不是数字]\n[00:01.00]a"), 0, "认不出就是 0（不猜）");
  assert.match(LRC_OFFSET_PATTERN.source, /offset/, "正则本体也是导出的常量（唯一真源）");

  const shifted = parseAmllLyrics("[offset:+250]\n[00:01.00]后移");
  assert.equal(shifted.lines[0].startTime, 1250);
});

test("offset 补偿：非常早的行被夹到 0（不产生负时间戳）", () => {
  const result = parseAmllLyrics("[offset:-5000]\n[00:01.00]会被夹住\n[00:09.00]正常\n");
  assert.equal(result.lines[0].startTime, 0);
  assert.equal(result.lines[0].endTime, 4000);
  assert.equal(result.lines[1].startTime, 4000);
  assert.ok(result.lines.every((line) => line.startTime >= 0 && line.endTime >= line.startTime));
});

test("翻译行合并：同一时间戳两行 → 一行正文 + translatedLyric", () => {
  const lrc = "[00:01.00]Hello world\n[00:01.00]你好世界\n[00:05.00]Second line\n";
  const result = parseAmllLyrics(lrc);

  assert.equal(result.lines.length, 2, "两行合成一行（AMLL 官方会各自成行）");
  assert.equal(lyricLineText(result.lines[0]), "Hello world");
  assert.equal(result.lines[0].translatedLyric, "你好世界");
  assert.equal(result.lines[0].romanLyric, "");
  assert.equal(result.lines[0].endTime, 5000);
  assert.equal(result.stats.merged, 1);
  assert.equal(result.stats.parsed, 3, "stats 里保留原始行数（便于排查）");
  // 正文的词数组不能被译文顶掉：逐字动画靠它
  assert.deepEqual(
    result.lines[0].words.map((word) => word.word),
    ["Hello world"],
  );
});

test("翻译行合并：三行同时间戳 → 正文 + 译文 + 音译", () => {
  const lrc = "[00:01.00]君の名は\n[00:01.00]你的名字\n[00:01.00]kimi no na wa\n";
  const result = parseAmllLyrics(lrc);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].translatedLyric, "你的名字");
  assert.equal(result.lines[0].romanLyric, "kimi no na wa");
  assert.equal(result.stats.merged, 2);
});

test("翻译行合并：多出来的行**保留为独立行**（宁可多一行，也不静默吃掉歌词）", () => {
  const lrc = "[00:01.00]正文\n[00:01.00]译文\n[00:01.00]音译\n[00:01.00]第四行\n";
  const result = parseAmllLyrics(lrc);
  assert.equal(result.lines.length, 2, "正文（含译/音）+ 保留的第四行");
  assert.equal(result.lines[0].translatedLyric, "译文");
  assert.equal(result.lines[0].romanLyric, "音译");
  assert.equal(lyricLineText(result.lines[1]), "第四行");
  assert.equal(result.stats.extraKept, 1);
});

test("翻译行合并：重复的同一句话不当译文（不制造重复显示）", () => {
  const lrc = "[00:01.00]副歌\n[00:01.00]副歌\n[00:02.00]下一句\n";
  const result = parseAmllLyrics(lrc);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].translatedLyric, "", "同一句话不是译文");
  assert.equal(result.stats.merged, 0);
});

test("空/畸形/非字符串输入 → 空结果且绝不抛（歌词拿不到不该拖垮播放）", () => {
  for (const value of ["", "   \n\t ", "没有时间戳\n第二行也没有", null, undefined, 42, {}, [], Symbol("lrc")]) {
    const result = parseAmllLyrics(value);
    assert.deepEqual(result.lines, [], `不得抛：${String(value)}`);
    assert.equal(result.isEmpty, true);
    assert.equal(result.stats.parsed, 0);
  }
});

test("两次解析互不影响：每次都是全新对象（AMLL 要求传入的数组不得被改）", () => {
  const first = parseAmllLyrics(PLAIN_LRC);
  const second = parseAmllLyrics(PLAIN_LRC);
  assert.notEqual(first.lines, second.lines);
  assert.notEqual(first.lines[0], second.lines[0]);
  assert.deepEqual(first.lines, second.lines);

  first.lines[0].translatedLyric = "被改了";
  first.lines.pop();
  assert.equal(parseAmllLyrics(PLAIN_LRC).lines.length, 3);
});

test("纯函数：shift 与合并都在纯函数里（面板不做这类加工）", () => {
  const base = parseAmllLyrics(PLAIN_LRC).lines;
  const shifted = shiftLyricLines(base, 1000);
  assert.equal(shifted[0].startTime, 2500);
  assert.equal(base[0].startTime, 1500, "原数组不动（不就地改）");
  assert.equal(shiftLyricLines(base, 0)[0].startTime, 1500, "offset 为 0 时不做无谓的拷贝语义变化");

  assert.deepEqual(mergeTranslationLines([]), { lines: [], merged: 0, extraKept: 0 });
  const merged = mergeTranslationLines([
    { words: [{ word: "a", startTime: 0, endTime: 10 }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 0, endTime: 10 },
    { words: [{ word: "甲", startTime: 0, endTime: 10 }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 0, endTime: 10 },
  ]);
  assert.equal(merged.lines.length, 1);
  assert.equal(merged.merged, 1);
  assert.equal(merged.lines[0].translatedLyric, "甲");
});

test("禁止自绘解析：必须复用 AMLL 官方 parseLrc，不得自带时间戳正则", () => {
  const source = readFileSync(`${repoRoot}src/renderer/features/lyrics/amll-adapter.ts`, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.match(code, /@applemusic-like-lyrics\/lyric/, "必须 import AMLL 官方歌词包");
  assert.match(code, /parseLrc\(/, "必须调用官方 parseLrc");
  assert.doesNotMatch(code, /\\d\{2\}:\\d\{2\}/, "不得出现自写的时间戳正则（那是自绘解析）");
  assert.doesNotMatch(code, /<span|<div|className/, "适配层不产生任何标记（渲染是组件的事）");
});
