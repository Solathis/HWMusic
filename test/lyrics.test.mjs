/**
 * R4 协议原型层 · 歌词解析（src/protocols/lyrics.mjs）。
 *
 * 只做 AMLL 官方 `parseLrc` 的封装：真实 LRC 样本 → AMLL `LyricLine[]`；
 * 空/畸形/非字符串输入返回空结果且**绝不抛**（歌词拉不到时播放器要能继续放歌）。
 * 另有一条"禁止自绘解析"的源码扫描：本模块必须 import 官方解析器，不得自带时间戳正则。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseLyrics, parseLyricsOrEmpty } from "../src/protocols/lyrics.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 真实形状的 LRC（带元数据头、毫秒两位、末尾一条空行时间戳）。 */
const SAMPLE_LRC = [
  "[ti:示例曲目]",
  "[ar:示例歌手]",
  "[al:示例专辑]",
  "[by:lrc作者]",
  "[offset:0]",
  "[00:01.50]第一行歌词",
  "[00:05.00]第二行歌词",
  "[00:09.25]第三行歌词",
  "",
].join("\n");

test("parseLyrics：真实 LRC 样本 → AMLL LyricLine 结构（时间戳毫秒、行间首尾相接）", () => {
  const result = parseLyrics(SAMPLE_LRC);
  assert.equal(result.lineCount, 3);
  assert.equal(result.isEmpty, false);
  assert.equal(result.lines.length, 3);

  const first = result.lines[0];
  assert.equal(first.words.length, 1);
  assert.equal(first.words[0].word, "第一行歌词");
  assert.equal(first.startTime, 1500);
  assert.equal(first.endTime, 5000, "AMLL 用下一行的起点补上一行的终点");
  assert.equal(first.translatedLyric, "");
  assert.equal(first.romanLyric, "");
  assert.equal(first.isBG, false);
  assert.equal(first.isDuet, false);

  assert.equal(result.lines[1].startTime, 5000);
  assert.equal(result.lines[1].words[0].word, "第二行歌词");
  assert.equal(result.lines[2].startTime, 9250);
  assert.equal(result.lines[2].words[0].word, "第三行歌词");
  assert.ok(result.lines[2].endTime >= 9250, "末行终点由 AMLL 给定哨兵值，不早于起点");
});

test("parseLyrics：每一行都是完整 LyricLine（渲染层不必再补字段）", () => {
  const { lines } = parseLyrics(SAMPLE_LRC);
  for (const line of lines) {
    assert.equal(typeof line.startTime, "number");
    assert.equal(typeof line.endTime, "number");
    assert.equal(typeof line.translatedLyric, "string");
    assert.equal(typeof line.romanLyric, "string");
    assert.equal(typeof line.isBG, "boolean");
    assert.equal(typeof line.isDuet, "boolean");
    assert.ok(Array.isArray(line.words) && line.words.length >= 1);
    for (const word of line.words) {
      assert.equal(typeof word.word, "string");
      assert.equal(typeof word.startTime, "number");
      assert.equal(typeof word.endTime, "number");
    }
  }
});

test("parseLyrics：逐字（增强型）LRC 的同一行多词被保留", () => {
  const enhanced = "[00:01.00]<00:01.00>逐<00:01.50>字<00:02.00>歌词\n[00:03.00]下一行\n";
  const { lines, lineCount } = parseLyrics(enhanced);
  assert.equal(lineCount, 2);
  assert.ok(lines[0].words.length >= 3, `逐字行应保留多个 word，实际 ${lines[0].words.length}`);
  assert.equal(lines[0].words.map((word) => word.word).join(""), "逐字歌词");
});

test("parseLyrics：CRLF 与 BOM 不影响解析结果", () => {
  const crlf = parseLyrics("[00:01.00]a\r\n[00:02.00]b\r\n");
  assert.equal(crlf.lineCount, 2);
  assert.equal(crlf.lines[0].words[0].word, "a");
  assert.equal(crlf.lines[1].words[0].word, "b");

  const bom = parseLyrics("\uFEFF[00:01.00]a\n[00:02.00]b\n");
  assert.equal(bom.lineCount, 2);
  assert.equal(bom.lines[0].words[0].word, "a");
});

test("parseLyrics：空/纯空白/无时间戳/非字符串 → 空结果且绝不抛", () => {
  for (const value of ["", "   \n\t ", "这里没有时间戳\n第二行也没有", null, undefined, 42, {}, [], Symbol("lrc")]) {
    assert.doesNotThrow(() => parseLyrics(value), `不得抛：${String(value)}`);
    const result = parseLyrics(value);
    assert.deepEqual(result.lines, []);
    assert.equal(result.lineCount, 0);
    assert.equal(result.isEmpty, true);
  }
});

test("parseLyrics：同一输入两次解析互不影响（不共享可变缓存）", () => {
  const first = parseLyrics(SAMPLE_LRC);
  const second = parseLyrics(SAMPLE_LRC);
  assert.notEqual(first.lines, second.lines);
  assert.deepEqual(first.lines, second.lines);
  first.lines.pop();
  assert.equal(parseLyrics(SAMPLE_LRC).lineCount, 3, "上一次的改动不得污染下一次");
});

test("parseLyricsOrEmpty：任何异常都降级为空数组（播放器不因歌词挂掉）", () => {
  assert.deepEqual(parseLyricsOrEmpty(null), []);
  assert.deepEqual(parseLyricsOrEmpty(SAMPLE_LRC).length, 3);
});

test("禁止自绘：本模块必须复用 AMLL 官方 parseLrc，不得自带时间戳正则解析", () => {
  const source = readFileSync(`${repoRoot}src/protocols/lyrics.mjs`, "utf8");
  assert.match(source, /@applemusic-like-lyrics\/lyric/, "必须 import AMLL 官方歌词包");
  assert.match(source, /parseLrc/, "必须调用官方 parseLrc");
  assert.doesNotMatch(source, /\\d\{2\}:\d\{2\}/, "不得出现自写的时间戳正则（那是自绘解析）");
});
