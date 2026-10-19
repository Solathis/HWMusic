/**
 * 歌词适配（R9）：AMLL 官方 `parseLrc` → `LyricLine[]`，外加两处**补偿**。
 *
 * R4 的实测结论（协议层 `src/protocols/lyrics.mjs` 的文件头登记了它）：
 * 1. `[offset:±ms]` 元数据被 AMLL 忽略（不参与时间平移）——这里补上；
 * 2. 同一时间戳的多行（译文/音译）不会被合并进 `translatedLyric`，而是各自成行——这里合并。
 *
 * 边界（与协议层同一条）：**解析、时间轴、逐字切分全是官方 `parseLrc` 的事**。
 * 本文件里没有一行时间戳正则、没有任何标记输出，也没有"自己画歌词"的东西——
 * 逐行滚动与排版是 AMLL 组件（`AmllLyricsPanel` 里的 `LyricPlayer`）的职责，
 * 宿主只做定位容器与进度推送。任何输入都不抛：歌词拿不到时播放必须照常。
 *
 * 语义约定（写清楚，因为它没有权威文档）：
 * - `offset` 取**加**到时间戳上的解释（`[offset:+250]` = 歌词整体后 250ms 出现）。
 *   真实样本若证明是反的，改动只有 `shiftLyricLines` 里的一处符号。
 * - 时间戳夹在 ≥ 0：负时间戳不是"更早"，只是解析器与渲染器都不认的坏值。
 */
import { parseLrc, type LyricLine } from "@applemusic-like-lyrics/lyric";

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

/**
 * offset 平移（纯函数，返回**新对象**）。
 *
 * AMLL 的铁律是"传进去的数组及其内容不得再改"，所以这里一律重建：行、词数组、词对象
 * 全部是新引用——复用旧引用会让上一份解析结果被就地改掉。
 */
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

/**
 * 同时间戳多行合并（纯函数）：第一行是正文，第二行进 `translatedLyric`，第三行进 `romanLyric`。
 *
 * 两条克制：
 * - 与正文**完全相同**的行不当译文（同一句话被重复标注是数据问题，不是译文）；
 * - 第四行及以后**保留为独立行**：宁可多显示一行，也不能静默吃掉歌词
 *   （"显示得丑"看得见，"少了一句"看不见）。
 */
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

/**
 * 歌词文本 → AMLL 行数组（**唯一入口**，面板只消费它）。
 *
 * 顺序是刻意的：先平移 offset（同时间戳的等值关系不受影响），再合并同时间戳的行。
 * 反过来的话，合并后的行会被平移到不同的时间戳上，"译文跟着正文走"这件事就断了。
 */
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
