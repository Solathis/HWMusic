/**
 * 竖版桌面歌词：纯函数契约 + 新样式表的静态约束。
 * 钉三件事：竖版全部判定在 vertical-lyrics.mjs（组件只消费）、字素簇不被逐字切分拆散、
 * 竖排只在新样式表里（不写裸色值、不用 canvas、不内联视觉样式）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  VERTICAL_FONT_MAX_PX,
  VERTICAL_FONT_MIN_PX,
  VERTICAL_FONT_WIDTH_RATIO,
  activeLyricIndex,
  karaokeStates,
  karaokeTokens,
  lineProgress,
  nextColumnFits,
  verticalFontPx,
  verticalFollowOffset,
  verticalLinePlan,
  verticalScrollOffset,
} from "../src/renderer/features/lyrics/vertical-lyrics.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** 行夹具：词数组与 AMLL `LyricLine` 同形（竖版只读 startTime/endTime/words/translatedLyric）。 */
const line = (startTime, endTime, text, extra = {}) => ({
  startTime,
  endTime,
  words: Array.from(text, (char, index) => ({
    word: char,
    startTime: startTime + Math.round(((endTime - startTime) * index) / text.length),
    endTime: startTime + Math.round(((endTime - startTime) * (index + 1)) / text.length),
  })),
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. 字号：由窗口宽度决定，带上下限
// ---------------------------------------------------------------------------

test("R61 竖版字号随窗口宽度变化：比例来自宽度，上下限夹住极端窗口", () => {
  assert.equal(verticalFontPx(260), Math.round(Math.min(VERTICAL_FONT_MAX_PX, 260 * VERTICAL_FONT_WIDTH_RATIO)));
  assert.ok(verticalFontPx(380) > verticalFontPx(260), "宽窗字号必须更大");
  assert.ok(verticalFontPx(220) < verticalFontPx(260), "窄窗字号必须更小");
  assert.equal(verticalFontPx(40), VERTICAL_FONT_MIN_PX, "极窄窗口落到下限（再小就读不出字）");
  assert.equal(verticalFontPx(4000), VERTICAL_FONT_MAX_PX, "极宽窗口落到上限（一列最多一个字也读不了）");
  // 坏入参不猜：认不出宽度按下限，且不抛
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -260, "260"]) {
    assert.equal(verticalFontPx(value), VERTICAL_FONT_MIN_PX, `坏入参 ${String(value)} 必须落到下限`);
  }
  assert.equal(VERTICAL_FONT_MIN_PX, 16);
  assert.equal(VERTICAL_FONT_MAX_PX, 96);
});

// ---------------------------------------------------------------------------
// 2. 当前句 / 下一句
// ---------------------------------------------------------------------------

test("R61 竖版当前句：取时间所在的最后一行；空白行不占屏（沿时间往前找有字的行）", () => {
  const lines = [line(0, 3000, "第一句"), line(3000, 6000, "第二句"), line(6000, 9000, "")];
  assert.equal(activeLyricIndex(lines, 0), 0);
  assert.equal(activeLyricIndex(lines, 2999), 0);
  assert.equal(activeLyricIndex(lines, 3000), 1);
  assert.equal(activeLyricIndex(lines, 8000), 1, "空行落在 6000 之后：仍显示上一句有字的行");
  assert.equal(activeLyricIndex(lines, -1), -1, "还没到第一句：没有当前句");
  assert.equal(activeLyricIndex(lines, 999999), 1);
  for (const bad of [null, undefined, [], "lines"]) assert.equal(activeLyricIndex(bad, 1000), -1, "坏入参回 -1");
});

test("R61 竖版下一句：跳过空白行；没有下一句时回 -1", () => {
  const lines = [line(0, 3000, "第一句"), line(3000, 6000, ""), line(6000, 9000, "第三句")];
  assert.deepEqual(verticalLinePlan(lines, 500), { current: 0, next: 2 });
  assert.deepEqual(verticalLinePlan(lines, 7000), { current: 2, next: -1 });
  assert.deepEqual(verticalLinePlan([], 500), { current: -1, next: -1 });
  assert.deepEqual(verticalLinePlan(lines, -5), { current: -1, next: 0 }, "还没开始：没有当前句，第一句是下一句");
});

test("R61 竖版正在进行的那一句进度：按时间线性、夹在 0..1；结束时间坏掉时用下一句起点", () => {
  const current = line(3000, 6000, "六个字");
  assert.equal(lineProgress(current, 3000), 0);
  assert.equal(lineProgress(current, 4500), 0.5);
  assert.equal(lineProgress(current, 6000), 1);
  assert.equal(lineProgress(current, 9000), 1, "越过行尾仍夹在 1");
  assert.equal(lineProgress(current, 0), 0);
  const broken = { startTime: 3000, endTime: 3000 };
  assert.equal(lineProgress(broken, 4500, 6000), 0.5, "行尾等于行首时用下一句起点当结束");
  assert.equal(lineProgress(broken, 4500), 0, "连下一句都没有：停在句首（不猜时长）");
  assert.equal(lineProgress(null, 100), 0, "坏入参回 0");
});

// ---------------------------------------------------------------------------
// 3. 逐字：字素簇不被拆散
// ---------------------------------------------------------------------------

test("R61 竖版按字素簇成组：组合重音、变体选择符、零宽连接符跟随前一个字", () => {
  const words = Array.from("e\u0301❤\uFE0F👩\u200D👩中", (char) => ({ word: char, startTime: 0, endTime: 100 }));
  const tokens = karaokeTokens(words);
  assert.deepEqual(tokens.map((token) => token.text), ["e\u0301", "❤\uFE0F", "👩\u200D👩", "中"],
    "组合符号与前一个字同组；连接符（ZWJ）把两侧的字连成一组；汉字各自成组");
  assert.equal(tokens[0].startTime, 0);
  // 时间跟着合并（末字收在最后一个成员词的结束时间上）
  const timed = karaokeTokens([{ word: "a", startTime: 0, endTime: 100 }, { word: "\u0301", startTime: 100, endTime: 200 }]);
  assert.equal(timed.length, 1);
  assert.deepEqual(timed[0], { text: "a\u0301", startTime: 0, endTime: 200 });
  assert.deepEqual(karaokeTokens(null), [], "坏入参回空数组");
});

test("R61 竖版逐字进度：已唱/正在唱/未唱三态；逐字关闭或没有词时间时按整句高亮", () => {
  const current = line(0, 4000, "一二三四");
  const states = (timeMs, karaoke = true) => karaokeStates(current, timeMs, karaoke);
  assert.deepEqual(states(0), ["active", "pending", "pending", "pending"]);
  assert.deepEqual(states(1000), ["sung", "active", "pending", "pending"]);
  assert.deepEqual(states(3999), ["sung", "sung", "sung", "active"]);
  assert.deepEqual(states(4000), ["sung", "sung", "sung", "sung"]);
  assert.deepEqual(states(2000, false), ["sung", "sung", "sung", "sung"], "关掉逐字：整句一起亮");

  // 没有词时间（AMLL 会给单行补一个覆盖整行的词）：同样按整句
  const single = { startTime: 0, endTime: 4000, words: [{ word: "整句歌词", startTime: 0, endTime: 4000 }] };
  assert.deepEqual(karaokeStates(single, 2000), ["sung"], "单字时间长驻整行：整句亮");
  assert.deepEqual(karaokeStates({ ...single, words: [{ word: "整句歌词", startTime: 0, endTime: 0 }] }, 2000), ["sung"],
    "词时间全是 0 = 没有逐字时间，按整句");

  // 未唱：「当前行还没开始」时整句都是未唱
  assert.deepEqual(karaokeStates(current, -1), ["pending", "pending", "pending", "pending"]);
  assert.deepEqual(karaokeStates(null, 100), []);
});

// ---------------------------------------------------------------------------
// 4. 滚动偏移：按演唱进度沿书写方向平移 + 跟随修正
// ---------------------------------------------------------------------------

test("R61 竖版滚动偏移：装得下就停在 0；装不下按进度平移，两端有界", () => {
  const fit = { contentHeight: 400, viewportHeight: 520, progress: 0.5 };
  assert.equal(verticalScrollOffset(fit), 0, "内容比视口矮：不许平移");

  const long = { contentHeight: 2000, viewportHeight: 500 };
  assert.ok(verticalScrollOffset({ ...long, progress: 0 }) <= 0);
  const mid = verticalScrollOffset({ ...long, progress: 0.5 });
  const late = verticalScrollOffset({ ...long, progress: 1 });
  assert.ok(mid < 0 && late < mid, "进度越大越往上（沿书写方向向前）");
  assert.equal(late, -(2000 - 500), "最后停在内容末尾（底边对齐，不多滚一像素）");
  assert.ok(verticalScrollOffset({ ...long, progress: 0 }) >= -0.35 * 500 - 1e-9, "开头不许把首字推出视口");
  // 坏入参：不抛、回 0
  assert.equal(verticalScrollOffset({ contentHeight: Number.NaN, viewportHeight: 500, progress: 0.5 }), 0);
  assert.equal(verticalScrollOffset(null), 0);
});

test("R61 竖版跟随修正：正在唱的字要整块落在视口里（含上下留白），且不越界", () => {
  const base = { contentHeight: 2000, viewportHeight: 500, margin: 8 };
  // 已经在视口里：一动不动
  assert.equal(verticalFollowOffset({ ...base, offset: -200, charTop: 260, charHeight: 60 }), -200);
  // 落到视口底部之外：往下推，直到字底离视口底边留出 margin
  const below = verticalFollowOffset({ ...base, offset: -200, charTop: 700, charHeight: 60 });
  assert.equal(below, -(700 + 60 - 500 + 8));
  // 跑到视口顶边之上：往回收，直到字顶离顶边留出 margin
  const above = verticalFollowOffset({ ...base, offset: -600, charTop: 580, charHeight: 60 });
  assert.equal(above, -(580 - 8));
  // 边界：修正不许把内容推到视口之外
  assert.equal(verticalFollowOffset({ ...base, offset: 0, charTop: 10, charHeight: 60 }), 0);
  assert.equal(verticalFollowOffset({ ...base, offset: -1500, charTop: 1990, charHeight: 60 }), -1500);
  assert.equal(verticalFollowOffset({ ...base, offset: Number.NaN, charTop: 700, charHeight: 60 }), -(700 + 60 - 500 + 8),
    "平移量读不出来时当 0 处理，再按同一规则修正");
});

test("R61 竖版下一句那一列：宽度足够才显示（列厚随字号）", () => {
  assert.equal(nextColumnFits({ viewportWidth: 260, fontPx: 68, columns: 1 }), true, "一句 68px 宽 + 一句淡色：260 放得下");
  assert.equal(nextColumnFits({ viewportWidth: 260, fontPx: 68, columns: 2 }), false, "原文 + 译文已经占两列：不再塞第三列");
  assert.equal(nextColumnFits({ viewportWidth: 140, fontPx: 68, columns: 1 }), false, "窄窗放不下第二列");
  assert.equal(nextColumnFits({ viewportWidth: 600, fontPx: 68, columns: 2 }), true);
  assert.equal(nextColumnFits(null), false, "坏入参回 false（宁可不画）");
});

// ---------------------------------------------------------------------------
// 5. 样式表与组件的静态约束
// ---------------------------------------------------------------------------

test("R61 竖版样式表：标准 CSS 竖排（writing-mode/text-orientation/nowrap）+ 容器查询单位字号", () => {
  const css = stripComments(read("src/renderer/vertical-lyrics.css"));
  assert.match(css, /writing-mode:\s*vertical-rl/, "竖排必须落在新组件的列上（不再借 AMLL 行盒）");
  assert.match(css, /text-orientation:\s*mixed/, "Unicode 默认竖排方向：CJK 直立、拉丁/数字旋转");
  assert.doesNotMatch(css, /text-orientation:\s*upright/, "全 upright 会把拉丁字母拉成方块");
  assert.match(css, /white-space:\s*nowrap/, "一句一列：不许被折成多列（不再出现 R45B/R46 的折列 + 横向滚动条）");
  assert.match(css, /container-type:\s*inline-size/, "字号要用容器查询单位，容器必须自己申报");
  const font = css.match(/font-size:\s*clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)cqw\s*,\s*([\d.]+)rem\s*\)/);
  assert.ok(font, "竖版字号写成 clamp(下限, 宽度的百分比, 上限)");
  assert.equal(Number(font[1]) * 16, VERTICAL_FONT_MIN_PX, "样式表的下限必须等于 verticalFontPx 的常数");
  assert.equal(Number(font[2]), VERTICAL_FONT_WIDTH_RATIO * 100);
  assert.equal(Number(font[3]) * 16, VERTICAL_FONT_MAX_PX, "样式表的上限必须等于 verticalFontPx 的常数");
  assert.match(css, /overflow:\s*hidden/, "竖版的滚动由进度驱动，不许出现原生滚动条");
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/,
    "减少动效时取消平滑滚动（直接定位）");
  // 令牌与标准 CSS：不写裸色值、不写 Tailwind 调色板类
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/, "颜色只能来自设计令牌");
});

test("R61 竖版组件：只用纯函数与标准 CSS，不自绘 canvas、不内联视觉样式", () => {
  const source = stripComments(read("src/renderer/VerticalLyricColumn.tsx"));
  assert.doesNotMatch(source, /<canvas|getContext\(/, "竖版不是自绘画布");
  assert.doesNotMatch(source, /--amll-/, "AMLL 变量只许出现在 amll-theme.css 与适配层");
  assert.doesNotMatch(source, /style=\{\{/, "视觉一律走样式表；运行时平移量走 CSS 变量的 setProperty");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|text-(?:zinc|slate|gray|neutral|white|black)\b/,
    "颜色只来自令牌");
  for (const helper of ["verticalLinePlan", "karaokeStates", "verticalScrollOffset", "verticalFollowOffset", "nextColumnFits"]) {
    assert.match(source, new RegExp(helper), `组件必须消费纯函数 ${helper}（判定不写在组件里）`);
  }
});

test("R61 先删后写：amll-theme.css 里针对竖版的补丁规则整块删除", () => {
  const css = stripComments(read("src/renderer/amll-theme.css"));
  assert.doesNotMatch(css, /data-lyrics-layout="vertical"/, "竖版不再给 AMLL 播放器打补丁规则");
  assert.doesNotMatch(css, /calc\(100cqh\s*-\s*0\.8em\)/, "旧的折列轴已删");
  assert.doesNotMatch(css, /::-webkit-scrollbar/, "旧的细滚动条已删");
  assert.doesNotMatch(css, /overflow-x:\s*auto/, "旧的横向滚动容器已删");
  assert.doesNotMatch(css, /\[class\*="lyricMainLine"\]\s*\{[^}]*writing-mode/, "旧的假竖排落点已删");
  // 竖版颜色仍走同一个变量（自定义色的接线点不变），但变量只在 amll-theme.css 里出现
  assert.match(css, /\.vertical-lyric[\s\S]*?color:\s*var\(--amll-lp-color\)/,
    "竖版组件从同一个颜色变量取色（自定义色仍然一次 scoped 覆盖）");
});
