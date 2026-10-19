/**
 * 播放队列的条目投影与持久化记录（R9）。
 *
 * 两件事，各自只有一处实现：
 *
 * **条目投影**（`queueEntryOf`）：队列面板要显示的东西就四项——标识、标题、艺人、时长。
 * 字段候选表仍然只在 `features/library/track-fields.mjs`（那份表与协议层同结论，由
 * `test/library-views.test.mjs` 差分钉住）；这里**不建第二份兜底表**，只把"取不到"
 * 如实留成 `null`——界面要显示"未知歌曲"是界面的事。
 *
 * **持久化记录**（`queueRecordOf` / `sanitizeQueueRecord`）：控制器的裁决是
 * "只存曲目标识 + 当前索引"。所以记录**结构上只有 `ids` 与 `index` 两个键**：
 * - 播放地址不存（当次有效、可能带时效签名，存下来等于存了个很快失效的秘密）；
 * - 标题/艺人不存（裁决没让存；队列面板对恢复出来的条目如实显示标识）；
 * - 反向也一样：任何输入都洗不出第三个键，历史/手工改坏的记录（哪怕带 url）也进不来。
 *
 * 键名 `QUEUE_SETTING_KEY` 是唯一真源：写盘走 `settings:set` 的 `{patch: {queue: ...}}`，
 * `null` = 删除该键（`src/main/settings.mjs` 的既有语义，这里与它对齐）。
 */
import {
  trackArtistsOrNull,
  trackDurationOf,
  trackIdOf,
  trackNameOrNull,
} from "../library/track-fields.mjs";

/** 设置文档里的键名（`data.queue`）。 */
export const QUEUE_SETTING_KEY = "queue";

/** 非空字符串（去首尾空白）；其余一律 null。 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 索引夹到 `[0, length-1]`；不是有限数就是 0（坏索引不该让下次启动播错歌）。 */
function clampIndex(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const index = Math.trunc(number);
  if (index < 0) return 0;
  return index > length - 1 ? length - 1 : index;
}

/**
 * 单条队列条目：**没有标识就没有条目**（没标识就取不到播放地址，收进来只会是个点了没反应的幽灵行）。
 * @returns {{id: string, name: string|null, artists: string|null, duration: number|null} | null}
 */
export function queueEntryOf(item) {
  const id = trackIdOf(item);
  if (id === null) return null;
  return {
    id,
    name: trackNameOrNull(item),
    artists: trackArtistsOrNull(item),
    duration: trackDurationOf(item),
  };
}

/** 列表投影：逐条转换并丢掉没有标识的条目，保持原顺序（不排序、不去重：同一首歌可以出现两次）。 */
export function queueEntriesOf(items) {
  if (!Array.isArray(items)) return [];
  const entries = [];
  for (const item of items) {
    const entry = queueEntryOf(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * 状态 → 持久化记录（空队列回 `null` = 删除该键）。
 * @returns {{ids: string[], index: number} | null}
 */
export function queueRecordOf(entries, index) {
  const list = Array.isArray(entries) ? entries : [];
  const ids = [];
  for (const entry of list) {
    const id = textOf(entry?.id);
    if (id !== null) ids.push(id);
  }
  if (ids.length === 0) return null;
  return { ids, index: clampIndex(index, ids.length) };
}

/**
 * 持久化记录 → 可信记录（认不出就是 `null`）。
 *
 * 宽容读取、严格出口：只取 `ids` 与 `index`，其余一律丢掉——"手工改坏的 settings.json"
 * 不该把不相干的东西带进内存。
 * @returns {{ids: string[], index: number} | null}
 */
export function sanitizeQueueRecord(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.ids)) return null;
  const ids = [];
  for (const value of raw.ids) {
    const id = textOf(value);
    if (id !== null) ids.push(id);
  }
  if (ids.length === 0) return null;
  return { ids, index: clampIndex(raw.index, ids.length) };
}

/**
 * 记录 → 内存条目。**标题/艺人/时长都是 null**：记录里只有标识，
 * 界面如实显示"只知道是哪一首"（编一个标题比空着更糟）。
 */
export function restoredEntries(record) {
  const ids = Array.isArray(record?.ids) ? record.ids : [];
  return ids.map((id) => ({ id, name: null, artists: null, duration: null }));
}
