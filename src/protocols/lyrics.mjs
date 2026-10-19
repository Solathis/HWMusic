/**
 * 歌词解析（AMLL 官方 `parseLrc` 的薄封装）。
 *
 * 边界：**只做解析**，不做渲染、不做布局（自绘歌词属越界，渲染一律交给 AMLL 官方组件，R9/R12 消费）。
 * 契约：任何输入都不抛——歌词拉不到时播放器必须能继续放歌，不能因为一行歌词把播放链路炸掉。
 *
 * 已知行为（实测，见 task-4-report.md 自审）：
 * - 时间戳一律毫秒；行的终点由 AMLL 用下一行起点补齐，末行终点是 AMLL 的"无穷"哨兵（59999999）；
 * - `[offset:±ms]` 元数据被 AMLL 忽略（不参与时间平移）；
 * - 同一时间戳的多行（译文/音译）**不会**被合并成 translatedLyric，而是各自成行——多语言适配留给消费方。
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
