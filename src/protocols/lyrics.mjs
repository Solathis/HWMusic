/**
 * 歌词解析（AMLL 官方 `parseLrc` 的薄封装），只做解析，渲染交给 AMLL 官方组件。
 * 契约：任何输入都不抛——歌词拉不到时播放链路必须继续。
 * 时间戳一律毫秒；同一时间戳的多行（译文/音译）各自成行，不合并成 translatedLyric。
 */
import { parseLrc } from "@applemusic-like-lyrics/lyric";

/** 空结果：形状与非空结果一致，消费方不必分支。 */
function emptyResult() {
  return { lines: [], lineCount: 0, isEmpty: true };
}

/**
 * 解析 LRC 家族歌词文本。
 * @param {unknown} value 原始歌词文本（网络/磁盘来源，一律按不可信处理）
 * @returns {{lines: Array<object>, lineCount: number, isEmpty: boolean}}
 */
export function parseLyrics(value) {
  if (typeof value !== "string") return emptyResult();
  const text = value.replace(/^\uFEFF/, "");
  if (text.trim() === "") return emptyResult();

  let lines = [];
  try {
    const parsed = parseLrc(text);
    if (Array.isArray(parsed)) lines = parsed;
  } catch {
    // 解析器对畸形输入抛错时按"没有歌词"处理，不让它冒泡到播放链路
    return emptyResult();
  }

  return { lines, lineCount: lines.length, isEmpty: lines.length === 0 };
}

/** 只要行数组的便捷入口（消费方不关心诊断字段时用）。 */
export function parseLyricsOrEmpty(value) {
  return parseLyrics(value).lines;
}
