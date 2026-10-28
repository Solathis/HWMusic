/**
 * 歌词适配（features/lyrics/amll-adapter.ts）：AMLL 官方 parseLrc → LyricLine[]，外加两处补偿。
 * 补上被忽略的 [offset:±ms]；同一时间戳的多行按正文/译文/音译合并，多出来的保留为独立行。
 * 解析、时间轴、词级切分仍归官方 parseLrc。
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
  withKaraokeWords,
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

// 逐字高亮（withKaraokeWords）：词级源原样使用，行级 LRC 的逐字时间按行时长线性推导。
// 这一组钉的是「推导怎么分」，不是「唱得准不准」。

/** 把「词」列成 `[文本, 起, 止]` 三元组，断言读起来就是一张表。 */
const wordTable = (line) => line.words.map((word) => [word.word, word.startTime, word.endTime]);

test("逐字推导（中文）：行级 LRC 每个字一个词，时间线性，末字正好收在行尾", () => {
  const [line] = parseAmllLyrics("[00:00.00]一二三四五\n[00:05.00]下一行").lines;
  const [karaoke] = withKaraokeWords([line]);

  assert.deepEqual(wordTable(karaoke), [
    ["一", 0, 1000],
    ["二", 1000, 2000],
    ["三", 2000, 3000],
    ["四", 3000, 4000],
    ["五", 4000, 5000],
  ]);
  assert.equal(karaoke.startTime, 0, "行时间不动（改时间轴不是这件事的职责）");
  assert.equal(karaoke.endTime, 5000);
  assert.equal(lyricLineText(karaoke), "一二三四五", "拼回去还是原来那一行");
});

test("逐字推导（英文/标点/空格）：按 code point 切，拼接后与原行逐字相等", () => {
  const text = "Hello, world!";
  const line = { words: [{ word: text, startTime: 1000, endTime: 3400 }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 1000, endTime: 3400 };
  const [karaoke] = withKaraokeWords([line]);

  assert.equal(karaoke.words.length, Array.from(text).length, "一个 code point 一个词");
  assert.equal(lyricLineText(karaoke), text, "空格与标点都在（不吞字、不重排）");
  assert.equal(karaoke.words[0].startTime, 1000, "首词起 = 行起");
  assert.equal(karaoke.words.at(-1).endTime, 3400, "末词止 = 行止（总时长一毫秒不差）");
  for (const [, start, end] of wordTable(karaoke)) {
    assert.ok(Number.isInteger(start) && Number.isInteger(end), `词时间是整数毫秒：${start}/${end}`);
    assert.ok(end >= start, `词区间不许倒挂：${start}..${end}`);
  }
  for (let index = 1; index < karaoke.words.length; index += 1) {
    assert.equal(karaoke.words[index].startTime, karaoke.words[index - 1].endTime, "相邻词首尾相接（没有洞）");
  }
});

test("逐字推导（emoji）：代理对不被劈成半个字", () => {
  const line = { words: [{ word: "歌🙂唱", startTime: 0, endTime: 3000 }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 0, endTime: 3000 };
  const [karaoke] = withKaraokeWords([line]);

  assert.equal(karaoke.words.length, 3, "🙂 是一个 code point（不是两个 UTF-16 单元）");
  assert.deepEqual(karaoke.words.map((word) => word.word), ["歌", "🙂", "唱"]);
  for (const word of karaoke.words) {
    assert.equal(Array.from(word.word).length, 1, `每个词都是完整的字：${JSON.stringify(word.word)}`);
  }
  assert.equal(lyricLineText(karaoke), "歌🙂唱");
});

test("已有词级时间**原样保留**：不重切、不改时间", () => {
  const line = {
    words: [
      { word: "逐", startTime: 0, endTime: 300, romanWord: "zhu" },
      { word: "字", startTime: 300, endTime: 700 },
      { word: "高亮", startTime: 700, endTime: 1600 },
    ],
    translatedLyric: "per-char", romanLyric: "zhuzi", isBG: false, isDuet: false, startTime: 0, endTime: 1700,
  };
  const [karaoke] = withKaraokeWords([line]);
  assert.deepEqual(karaoke.words, line.words, "词级源就是精确的那一份：一个词都不许重切");
  assert.equal(karaoke.endTime, 1700);
});

test("逐字推导保留译文/音译/背景/对唱与行时间，只换 words", () => {
  const line = { words: [{ word: "君の名", startTime: 500, endTime: 1500 }], translatedLyric: "你的名字", romanLyric: "kimi no na", isBG: true, isDuet: true, startTime: 500, endTime: 1500 };
  const [karaoke] = withKaraokeWords([line]);

  assert.equal(karaoke.translatedLyric, "你的名字", "译文不许丢");
  assert.equal(karaoke.romanLyric, "kimi no na", "音译不许丢");
  assert.equal(karaoke.isBG, true);
  assert.equal(karaoke.isDuet, true);
  assert.equal(karaoke.startTime, 500);
  assert.equal(karaoke.endTime, 1500);
  assert.equal(karaoke.words.length, 3);
});

test("坏时间/空行不伪造逐字：不是有限区间就原样留给 AMLL", () => {
  const cases = [
    { words: [{ word: "没有终点", startTime: 0, endTime: Number.POSITIVE_INFINITY }] },
    { words: [{ word: "坏起点", startTime: Number.NaN, endTime: 1000 }] },
    { words: [{ word: "零长", startTime: 1000, endTime: 1000 }] },
    { words: [{ word: "倒挂", startTime: 2000, endTime: 1000 }] },
    { words: [{ word: "", startTime: 0, endTime: 1000 }] },
    { words: [], startTime: 0, endTime: 1000 },
  ];
  for (const partial of cases) {
    const line = { translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 0, endTime: 1000, ...partial };
    const [karaoke] = withKaraokeWords([line]);
    assert.deepEqual(karaoke.words, line.words.map((word) => ({ ...word })), `不该伪造逐字：${JSON.stringify(partial.words)}`);
  }
});

test("不修改入参：AMLL 的铁律（传进去的数组与内容不得再改）", () => {
  const line = { words: [{ word: "不改我", startTime: 0, endTime: 2000 }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime: 0, endTime: 2000 };
  const input = [line];
  const before = JSON.stringify(input);
  const result = withKaraokeWords(input);

  assert.equal(JSON.stringify(input), before, "入参一个字段都没动");
  assert.notEqual(result, input, "返回的是新数组");
  assert.notEqual(result[0], line, "行也是新对象");
  assert.notEqual(result[0].words, line.words, "词数组也是新的");
  assert.notEqual(result[0].words[0], line.words[0], "词对象也是新的");
  assert.deepEqual(withKaraokeWords(result)[0].words, result[0].words, "幂等：已经逐字的不再重切");
  assert.deepEqual(withKaraokeWords(null), []);
  assert.deepEqual(withKaraokeWords("nope"), []);
});

test("逐字推导覆盖整行区间：不同时长下都是首词起=行起、末词止=行止、单调", () => {
  for (const [startTime, endTime] of [[0, 1234], [700, 800], [15300, 41234]]) {
    const line = { words: [{ word: "abcdefg七", startTime, endTime }], translatedLyric: "", romanLyric: "", isBG: false, isDuet: false, startTime, endTime };
    const [karaoke] = withKaraokeWords([line]);
    assert.equal(karaoke.words[0].startTime, startTime, `${startTime}..${endTime} 的起点`);
    assert.equal(karaoke.words.at(-1).endTime, endTime, `${startTime}..${endTime} 的终点`);
    let previous = startTime;
    for (const [, start, end] of wordTable(karaoke)) {
      assert.ok(start >= previous, "词起点单调不减");
      assert.ok(end >= start);
      previous = end;
    }
    assert.equal(lyricLineText(karaoke), "abcdefg七");
  }
});

test("禁止自绘解析：必须复用 AMLL 官方 parseLrc，不得自带时间戳正则", () => {
  const source = readFileSync(`${repoRoot}src/renderer/features/lyrics/amll-adapter.ts`, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.match(code, /@applemusic-like-lyrics\/lyric/, "必须 import AMLL 官方歌词包");
  assert.match(code, /parseLrc\(/, "必须调用官方 parseLrc");
  assert.doesNotMatch(code, /\\d\{2\}:\\d\{2\}/, "不得出现自写的时间戳正则（那是自绘解析）");
  assert.doesNotMatch(code, /<span|<div|className/, "适配层不产生任何标记（渲染是组件的事）");
});

/** 自定义颜色的 scoped 覆盖两面共用同一个函数：只写 AMLL 那一个变量、只写已验证的 #RRGGBB、空值就撤掉覆盖。 */
test("R46 applyCustomColor：只写 AMLL 变量、只写已验证 hex、空值撤回覆盖", async () => {
  const { AMLL_COLOR_VAR, applyCustomColor } = await import("../src/renderer/features/lyrics/amll-adapter.ts");
  assert.equal(AMLL_COLOR_VAR, "--amll-lp-color", "变量名仍只有适配层这一处真源");

  const makeElement = () => {
    const written = [];
    const removed = [];
    return {
      written, removed,
      style: {
        setProperty: (name, value) => written.push([name, value]),
        removeProperty: (name) => removed.push(name),
      },
    };
  };

  const custom = makeElement();
  applyCustomColor(custom, "#00dd00");
  assert.deepEqual(custom.written, [[AMLL_COLOR_VAR, "#00dd00"]], "只写那一个变量（不拼 CSS 文本、不碰别的属性）");
  assert.deepEqual(custom.removed, []);

  const empty = makeElement();
  applyCustomColor(empty, "");
  assert.deepEqual(empty.written, [], "空值不写任何东西");
  assert.deepEqual(empty.removed, [AMLL_COLOR_VAR], "空值 = 撤掉覆盖，回到设计令牌");

  for (const bad of ["#fff", "red", "rgb(0,0,0)", ";}body{display:none", 42, null, undefined, true, {}]) {
    const rejected = makeElement();
    applyCustomColor(rejected, bad);
    assert.deepEqual(rejected.written, [], `非法值不许写进样式：${JSON.stringify(bad)}`);
    assert.deepEqual(rejected.removed, [AMLL_COLOR_VAR], `非法值按"没有自定义色"处理：${JSON.stringify(bad)}`);
  }

  // 没有元素（未挂载/已卸载）时静默返回：这条路上抛错会炸掉整个面板
  assert.doesNotThrow(() => applyCustomColor(null, "#00dd00"));
  assert.doesNotThrow(() => applyCustomColor(undefined, "#00dd00"));
});
