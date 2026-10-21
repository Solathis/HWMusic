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
// R41a：判据住在 sidecar（`src/main/lyrics-store.mjs`），这里用**真实解析器**与它对照
import { hasTimedLyricLine, sanitizeLyricsDoc } from "../src/main/lyrics-store.mjs";

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

test("等价（R41a）：hasTimedLyricLine 与真实 parseLrc 在边界矩阵上给出同一个答案", () => {
  // 为什么这条必须"用真实解析器对照"：判据住在 sidecar（进不了 AMLL 解析器，见
  // `src/main/lyrics-store.mjs` 的说明），而它的正当性只有一句话——"与 parseLrc 等价"。
  // 这句话靠读正则读不出来：R41a 就是这么发现原判据在两处说错了话的
  //（`[00:01.0000]词`：官方认、判据不认；`[00:01.00]`：判据认、官方给 0 行）。
  const agree = [
    // 时间戳形状
    "[00:01.00]词",
    "[00:01]词",
    "[0:1]词",
    "[0:0.0]词",
    "[100:01:500]词",
    "[999:99.999]词",
    "[00:01:50]词",
    "[00:01:0]词",
    "[00:01.0000]词",
    "[000:01.00]词",
    // 行首空白 / 行内空白
    "  [00:01.00]词",
    "\t[00:01.00]词",
    "[00:01.00] 词",
    "[00:01.00] 词 ",
    // 元数据行与歌词行混在一起
    "[ti:标题]\n[ar:艺人]\n[00:01.00]词",
    "[offset:500]\n[00:01.00]词",
    // 一行多个时间戳 / 逐字（增强型）
    "[00:01.00][00:05.00]词",
    "[00:01.00] [00:05.00]词",
    "[00:01.00]<00:01.00>逐字",
    "[00:01.00]词[b]",
    // 后面几行有没有词不影响（"至少一行"）
    "[00:01.00]词\n[00:05.00]",
    "[00:01.00]词\n不是时间戳",
    "[00:01.00]词\r\n[00:05.00]词",
    // 两侧都说"不是歌词"
    "",
    "   \n\t ",
    "[ti:标题]\n[ar:艺人]\n纯文本",
    "没有时间戳的一行",
    "[00:01.00]",
    "[00:01]",
    "[00:01.00]   ",
    "[00:01.00]\t",
    "[00:01.00]\u3000",
    "[00:01.00]　",
    "[00:01.00][00:05.00]",
    "[00:01][00:02]",
    "[1234:01.00]词",
    "[00:999]词",
    "[ 00:01.00]词",
    "[00:01.00 ]词",
    "[00:01,00]词",
    "[00:01.]词",
    "词 [00:01.00]词",
  ];
  for (const text of agree) {
    const timed = hasTimedLyricLine(text);
    const lines = parseLyrics(text).lineCount;
    assert.equal(
      timed,
      lines > 0,
      `两侧必须同答：${JSON.stringify(text)}（判据=${timed}，parseLrc=${lines} 行）`,
    );
  }

  // 已知的**刻意不等价**（三处，都有理由；钉住它们是为了不让正则悄悄漂移）：
  const knownDivergences = [
    // 时间戳后面跟一个"不是时间戳的方括号"：官方把它当一行（词就是那个方括号里的东西），
    // 判据说"没有词"。方向是**宁可不落盘**（把这种行当歌词缓存下来，用户看到的仍是方括号，
    // 而那份缓存 90 天挡着真正的歌词）。
    { text: "[00:01.00][Chorus]", amll: 1, timed: false },
    { text: "[00:01.00][]", amll: 1, timed: false },
    // 行首 BOM：官方解析器自己会剥（`parseLyrics` 的既有用例钉着），判据不剥——
    // 但它**到不了**判据：唯一的调用点在 `sanitizeLyricsDoc` 里，那里第一步就是剥 BOM
    //（下面一条断言钉住"那条路会剥"，所以这一处分歧在真实链路上不可达）。
    { text: "\uFEFF[00:01.00]词", amll: 1, timed: false },
  ];
  for (const { text, amll, timed } of knownDivergences) {
    assert.equal(
      parseLyrics(text).lineCount,
      amll,
      `官方解析器在这一条上的答案变了：${JSON.stringify(text)}——等价矩阵要重新对齐`,
    );
    assert.equal(
      hasTimedLyricLine(text),
      timed,
      `判据在这一条上的答案变了：${JSON.stringify(text)}——要么与官方对齐，要么显式改这张表`,
    );
  }
  // 上面那条"不可达"的说法本身也要钉住：真实链路上 BOM 先被剥掉
  const withBom = sanitizeLyricsDoc({ text: "\uFEFF[00:01.00]词" });
  assert.notEqual(withBom, null, "行首 BOM 不影响『算不算歌词』（盘上/文件里都可能有）");
  assert.equal(withBom.text, "[00:01.00]词", "剥掉的是 BOM，正文一个字符都不动");
});

test("禁止自绘：本模块必须复用 AMLL 官方 parseLrc，不得自带时间戳正则解析", () => {
  const source = readFileSync(`${repoRoot}src/protocols/lyrics.mjs`, "utf8");
  assert.match(source, /@applemusic-like-lyrics\/lyric/, "必须 import AMLL 官方歌词包");
  assert.match(source, /parseLrc/, "必须调用官方 parseLrc");
  assert.doesNotMatch(source, /\\d\{2\}:\\d\{2\}/, "不得出现自写的时间戳正则（那是自绘解析）");
});
