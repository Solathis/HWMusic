/**
 * 已知下架曲目的判据（纯函数）：状态机在入队、插队、整队替换、切歌时都经这里判。
 * 判据只有已知下架清单（服务端对这首歌回过下架/不存在）；不凭列表里未经验证的字段猜。
 */
import { trackIdOf } from "../library/track-fields.mjs";

/** 整队替换时一首能播的都没有：队列不动，只说这一句。 */
export const ALL_OFFLINE_TEXT = "这些歌曲都已下架，无法播放";

/** @param {number} count 入队时剔除的已知下架曲目数 */
export function offlineSkippedText(count) {
  return `已跳过 ${count} 首已下架的歌曲`;
}

/**
 * 下架清单 → 集合：只收非空字符串，去首尾空白；不是数组就是空集合。
 * @param {unknown} ids
 * @returns {Set<string>}
 */
export function offlineSetOf(ids) {
  const offline = new Set();
  if (!Array.isArray(ids)) return offline;
  for (const value of ids) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id !== "") offline.add(id);
  }
  return offline;
}

/**
 * 取 id 的口径与 `track-fields.mjs` 的 `trackIdOf` 相同；取不到 id 的条目不算下架。
 * @param {unknown} item
 * @param {Set<string>} offline
 */
export function isOfflineItem(item, offline) {
  const id = trackIdOf(item);
  return id !== null && offline.has(id);
}

/**
 * 剔除已知下架的条目：保持原序，如实计数；不是数组按空列表。
 * @param {unknown[]} items
 * @param {Set<string>} offline
 * @returns {{playable: unknown[], dropped: number}}
 */
export function partitionPlayable(items, offline) {
  const playable = [];
  let dropped = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (isOfflineItem(item, offline)) dropped += 1;
    else playable.push(item);
  }
  return { playable, dropped };
}

/**
 * 起点在 `partitionPlayable` 的 `playable` 里的下标：起点能播就是它自己；起点下架就取它后面最近一首能播的，
 * 后面没有就取它前面最近一首；一首都不能播是 -1。起点先按整队替换的口径取整、夹进列表范围。
 * @param {unknown[]} items
 * @param {number} startIndex
 * @param {Set<string>} offline
 */
export function playableStartIndex(items, startIndex, offline) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return -1;
  const start = Math.min(Math.max(Math.trunc(Number(startIndex) || 0), 0), list.length - 1);
  let before = 0;
  for (let position = 0; position < start; position += 1) {
    if (!isOfflineItem(list[position], offline)) before += 1;
  }
  for (let position = start; position < list.length; position += 1) {
    if (!isOfflineItem(list[position], offline)) return before;
  }
  return before - 1;
}
