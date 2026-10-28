/**
 * 歌词适配：AMLL 官方 `parseLrc` → `LyricLine[]`，外加 `[offset:±ms]` 平移与同时间戳多行合并两处补偿。
 * 解析、时间轴、逐字切分全是官方 `parseLrc` 的事；逐行滚动与排版归 AMLL 组件，宿主只做定位容器与进度推送。
 */
import { parseLrc, type LyricLine } from "@applemusic-like-lyrics/lyric";

import { normalizeCustomColor } from "./lyrics-window.mjs";

/** 官方 AMLL 歌词颜色变量名；用户选自定义颜色时，只在歌词窗上做一次 scoped 覆盖。 */
export const AMLL_COLOR_VAR = "--amll-lp-color";

/** 把自定义颜色写到容器上（scoped 覆盖）；空/非法值 = 撤掉覆盖回令牌，只用 `style.setProperty` 写已验证的 `#RRGGBB`。 */
export function applyCustomColor(element: HTMLElement | null | undefined, customColor: unknown): void {
  if (element === null || element === undefined) return;
  const color = normalizeCustomColor(customColor);
  if (color === "") {
    element.style.removeProperty(AMLL_COLOR_VAR);
    return;
  }
  element.style.setProperty(AMLL_COLOR_VAR, color);
}

/** `[offset:±ms]` 标签（唯一真源；`readLrcOffsetMs` 用它，扫描测试也认它）。 */
export const LRC_OFFSET_PATTERN = /\[offset:\s*([+-]?\d+)\s*\]/i;

/** 时间轴与逐字时间的下限：负时间戳会被渲染成"还没开始就唱完了"。 */
const MIN_TIME_MS = 0;

/** 解析统计（给排查用，也给测试钉：失去统计就只能靠猜"合并到底有没有生效"）。 */
export interface LyricParseStats {
  /** 官方解析器给出的原始行数 */
  parsed: number;
  /** 被合并进 translatedLyric/romanLyric 的行数 */
  merged: number;
  /** 合并不完、保留为独立行的行数 */
  extraKept: number;
  /** 生效的 offset（毫秒；没有该标签就是 0） */
  offsetMs: number;
}

export interface LyricsResult {
  lines: LyricLine[];
  stats: LyricParseStats;
  isEmpty: boolean;
}

/** 一行歌词的纯文本（词级数组拼起来；译文/音译不在其中）。 */
export function lyricLineText(line: LyricLine | null | undefined): string {
  if (line === null || line === undefined || !Array.isArray(line.words)) return "";
  return line.words.map((word) => (typeof word?.word === "string" ? word.word : "")).join("");
}

/** 读 `[offset:±ms]`：认不出/没有都回 0（**不猜**，与协议层"不编值"同一条纪律）。 */
export function readLrcOffsetMs(text: unknown): number {
  if (typeof text !== "string") return 0;
  const match = LRC_OFFSET_PATTERN.exec(text);
  if (match === null) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 0;
}

function shiftTime(value: number, offsetMs: number): number {
  const shifted = Number(value) + offsetMs;
  if (!Number.isFinite(shifted)) return MIN_TIME_MS;
  return Math.max(MIN_TIME_MS, Math.round(shifted));
}

/** offset 平移（纯函数）：一律重建行、词数组与词对象，传进去的数组及其内容不得再改。 */
export function shiftLyricLines(lines: LyricLine[], offsetMs: number): LyricLine[] {
  if (!Array.isArray(lines)) return [];
  if (offsetMs === 0) return lines.map((line) => cloneLine(line));
  return lines.map((line) => {
    const words = Array.isArray(line.words)
      ? line.words.map((word) => ({
          ...word,
          startTime: shiftTime(word.startTime, offsetMs),
          endTime: shiftTime(word.endTime, offsetMs),
        }))
      : [];
    return {
      ...line,
      words,
      startTime: shiftTime(line.startTime, offsetMs),
      endTime: shiftTime(line.endTime, offsetMs),
    };
  });
}

function cloneLine(line: LyricLine): LyricLine {
  return {
    ...line,
    words: Array.isArray(line.words) ? line.words.map((word) => ({ ...word })) : [],
  };
}

/** 同时间戳多行合并：第一行正文、第二行译文、第三行音译，第四行及以后保留为独立行。 */
export function mergeTranslationLines(lines: LyricLine[]): { lines: LyricLine[]; merged: number; extraKept: number } {
  if (!Array.isArray(lines) || lines.length === 0) return { lines: [], merged: 0, extraKept: 0 };

  const out: LyricLine[] = [];
  let merged = 0;
  let extraKept = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const group: LyricLine[] = [lines[cursor]];
    let next = cursor + 1;
    while (next < lines.length && lines[next].startTime === lines[cursor].startTime) {
      group.push(lines[next]);
      next += 1;
    }

    if (group.length === 1) {
      out.push(cloneLine(group[0]));
      cursor = next;
      continue;
    }

    // 正文取"第一行有文字的"：全空时退化成第一行（不制造没有正文的空壳）
    const main = group.find((line) => lyricLineText(line).trim() !== "") ?? group[0];
    const mainText = lyricLineText(main).trim();
    const mergedLine = cloneLine(main);
    const slots: Array<"translatedLyric" | "romanLyric"> = ["translatedLyric", "romanLyric"];
    const seen = new Set([mainText]);
    /** 译文/音译槽位用完之后的剩余行：**排在合并行之后**（顺序不能乱，否则歌词会倒着唱）。 */
    const leftovers: LyricLine[] = [];

    for (const line of group) {
      if (line === main) continue;
      const text = lyricLineText(line).trim();
      if (text === "" || seen.has(text)) continue;
      seen.add(text);
      const slot = slots.shift();
      if (slot === undefined) {
        leftovers.push(cloneLine(line));
        extraKept += 1;
        continue;
      }
      mergedLine[slot] = text;
      merged += 1;
    }

    out.push(mergedLine, ...leftovers);
    cursor = next;
  }

  return { lines: out, merged, extraKept };
}

const EMPTY_STATS: LyricParseStats = { parsed: 0, merged: 0, extraKept: 0, offsetMs: 0 };

/** 有限毫秒值，认不出回 `null`（不猜：`NaN`/`Infinity`/字符串一律不算时间）。 */
function finiteMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** 逐字高亮：把行级歌词按行时长线性推导出逐字词数组；已有词级时间原样保留，坏时间不伪造。 */
export function withKaraokeWords(lines: LyricLine[]): LyricLine[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => karaokeLine(line));
}

function karaokeLine(line: LyricLine): LyricLine {
  const words = Array.isArray(line?.words) ? line.words : [];
  const cloned = words.map((word) => ({ ...word }));
  const next: LyricLine = { ...line, words: cloned };
  if (cloned.length !== 1) return next;

  const first = cloned[0];
  const text = typeof first.word === "string" ? first.word : "";
  const chars = Array.from(text);
  if (chars.length === 0) return next;

  const wordStart = finiteMs(first.startTime);
  const wordEnd = finiteMs(first.endTime);
  // AMLL 自己会把 (0,0) 的词时间按行时间补齐（`resetLineTimestamps`），所以那也是"没写"而不是坏值
  const wordTimingOk = (wordStart === 0 && wordEnd === 0) || (wordStart !== null && wordEnd !== null && wordStart < wordEnd);
  const lineStart = finiteMs(line.startTime);
  const lineEnd = finiteMs(line.endTime);
  if (!wordTimingOk || lineStart === null || lineEnd === null || lineStart >= lineEnd) return next;

  const total = lineEnd - lineStart;
  next.words = chars.map((char, index) => ({
    ...first,
    word: char,
    startTime: lineStart + Math.round((total * index) / chars.length),
    endTime: lineStart + Math.round((total * (index + 1)) / chars.length),
  }));
  return next;
}

/** 歌词文本 → AMLL 行数组（唯一入口）：先平移 offset，再合并同时间戳的行。 */
export function parseAmllLyrics(text: unknown): LyricsResult {
  if (typeof text !== "string") return { lines: [], stats: { ...EMPTY_STATS }, isEmpty: true };
  const trimmed = text.replace(/^\uFEFF/, "");
  if (trimmed.trim() === "") return { lines: [], stats: { ...EMPTY_STATS }, isEmpty: true };

  let parsed: LyricLine[] = [];
  try {
    const result = parseLrc(trimmed);
    if (Array.isArray(result)) parsed = result;
  } catch {
    // 解析器对畸形输入抛错时按"没有歌词"处理：一行歌词不该把播放链路炸掉
    return { lines: [], stats: { ...EMPTY_STATS }, isEmpty: true };
  }
  if (parsed.length === 0) return { lines: [], stats: { ...EMPTY_STATS }, isEmpty: true };

  const offsetMs = readLrcOffsetMs(trimmed);
  const shifted = shiftLyricLines(parsed, offsetMs);
  const merged = mergeTranslationLines(shifted);

  return {
    lines: merged.lines,
    stats: { parsed: parsed.length, merged: merged.merged, extraKept: merged.extraKept, offsetMs },
    isEmpty: merged.lines.length === 0,
  };
}
