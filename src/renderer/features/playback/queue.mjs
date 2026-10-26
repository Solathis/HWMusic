/** 队列只保留展示白名单；持久化兼容旧 ids/index，绝不保存音频地址（进度只存毫秒数）。 */
import {
  trackAlbumIdOf,
  trackAlbumOrNull,
  trackArtistsOrNull,
  trackDurationOf,
  trackIdOf,
  trackNameOrNull,
} from "../library/track-fields.mjs";
import { guardMediaUrl } from "./media-url.mjs";

/** @typedef {{id: string, name: string|null, artists: string|null, duration: number|null, coverUrl: string|null, albumId: string|null, albumName: string|null}} QueueEntry */
/** @typedef {{trackId: string, positionMs: number}} QueuePosition */
/** @typedef {{ids: string[], index: number, metadata?: Array<QueueEntry|null>, positionMs?: number, positionTrackId?: string}} QueueRecord */

export const QUEUE_SETTING_KEY = "queue";
const METADATA_KEYS = ["name", "artists", "duration", "coverUrl", "albumId", "albumName"];

function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function ownValue(raw, key) {
  if (raw === null || typeof raw !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function clampIndex(value, length) {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Math.trunc(number), length - 1));
}

/** @returns {QueueEntry|null} */
export function queueEntryOf(item) {
  const id = trackIdOf(item);
  if (id === null) return null;
  const duration = trackDurationOf(item);
  return {
    id,
    name: trackNameOrNull(item),
    artists: trackArtistsOrNull(item),
    duration: duration !== null && duration >= 0 ? duration : null,
    coverUrl: guardMediaUrl(ownValue(item, "coverUrl")),
    albumId: trackAlbumIdOf(item),
    albumName: trackAlbumOrNull(item),
  };
}

export function queueEntriesOf(items) {
  if (!Array.isArray(items)) return [];
  const entries = [];
  for (const item of items) {
    const entry = queueEntryOf(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 读盘只取自有数据字段，不执行访问器，不接受别名或嵌套对象。 */
function snapshotOf(raw, id) {
  if (Array.isArray(raw) || textOf(ownValue(raw, "id")) !== id) return null;
  const duration = ownValue(raw, "duration");
  const entry = {
    id,
    name: textOf(ownValue(raw, "name")),
    artists: textOf(ownValue(raw, "artists")),
    duration: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    coverUrl: guardMediaUrl(ownValue(raw, "coverUrl")),
    albumId: textOf(ownValue(raw, "albumId")),
    albumName: textOf(ownValue(raw, "albumName")),
  };
  return METADATA_KEYS.some((key) => entry[key] !== null) ? entry : null;
}

/**
 * 位置只跟当前曲目绑定：id 必须就是这一索引的曲目，否则整对字段都不算数。
 * 0 与"没有位置"是同一件事（从头开始），所以不写。
 * @returns {QueuePosition|null}
 */
function positionOf(value, trackId) {
  if (value === null || typeof value !== "object") return null;
  const positionMs = ownValue(value, "positionMs");
  const positionTrackId = textOf(ownValue(value, "trackId"));
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs <= 0) return null;
  return positionTrackId === trackId ? { trackId: positionTrackId, positionMs: Math.round(positionMs) } : null;
}

/** @returns {QueueRecord|null} */
export function queueRecordOf(entries, index, position = null) {
  const projected = queueEntriesOf(entries);
  if (projected.length === 0) return null;
  const metadata = projected.map((entry) => snapshotOf(entry, entry.id));
  const at = clampIndex(index, projected.length);
  const resume = positionOf(position, projected[at].id);
  return {
    ids: projected.map((entry) => entry.id),
    index: at,
    ...(metadata.some((entry) => entry !== null) ? { metadata } : {}),
    ...(resume === null ? {} : { positionMs: resume.positionMs, positionTrackId: resume.trackId }),
  };
}

/** @returns {QueueRecord|null} */
export function sanitizeQueueRecord(raw) {
  if (Array.isArray(raw)) return null;
  const sourceIds = ownValue(raw, "ids");
  if (!Array.isArray(sourceIds)) return null;
  const sourceMetadata = ownValue(raw, "metadata");
  const ids = [];
  const metadata = [];
  for (let position = 0; position < sourceIds.length; position += 1) {
    const id = textOf(ownValue(sourceIds, position));
    if (id === null) continue;
    ids.push(id);
    metadata.push(Array.isArray(sourceMetadata) ? snapshotOf(ownValue(sourceMetadata, position), id) : null);
  }
  if (ids.length === 0) return null;
  const index = clampIndex(ownValue(raw, "index"), ids.length);
  const positionMs = ownValue(raw, "positionMs");
  const positionTrackId = textOf(ownValue(raw, "positionTrackId"));
  const hasPosition =
    typeof positionMs === "number" && Number.isFinite(positionMs) && positionMs > 0 && positionTrackId === ids[index];
  return {
    ids,
    index,
    ...(metadata.some((entry) => entry !== null) ? { metadata } : {}),
    ...(hasPosition ? { positionMs: Math.round(positionMs), positionTrackId } : {}),
  };
}

/** @returns {QueueEntry[]} */
export function restoredEntries(record) {
  const clean = sanitizeQueueRecord(record);
  if (clean === null) return [];
  return clean.ids.map((id, index) => clean.metadata?.[index] ?? {
    id, name: null, artists: null, duration: null, coverUrl: null, albumId: null, albumName: null,
  });
}
