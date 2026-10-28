/**
 * 歌单条目的展示投影：字段名待联调确认，取不到就如实回占位。
 * 歌单与歌曲是两种资源，单列一个文件避免串味的兜底。
 */

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function playlistIdOf(playlist) {
  if (!isObject(playlist)) return null;
  for (const key of ["id", "playlistId", "listId", "resourceId"]) {
    const value = textOf(playlist[key]);
    if (value !== null) return value;
  }
  return null;
}

export function playlistNameOf(playlist) {
  if (!isObject(playlist)) return "未命名歌单";
  for (const key of ["name", "playlistName", "title"]) {
    const value = textOf(playlist[key]);
    if (value !== null) return value;
  }
  return "未命名歌单";
}

/** 曲目数：数不出来回 null（UI 显示"曲目数待联调"而不是假的「0 首」）。 */
export function playlistSongCountOf(playlist) {
  if (!isObject(playlist)) return null;
  for (const key of ["songCount", "songNum", "trackCount", "count"]) {
    const raw = playlist[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value) && value >= 0 && String(raw).trim() !== "") return Math.floor(value);
  }
  return null;
}

/**
 * 封面地址：只读协议层白名单内的 `coverUrl`，交给 `<img src>`，**绝不 fetch**；取不到回 null。
 */
export function playlistCoverUrlOf(playlist) {
  if (!isObject(playlist)) return null;
  for (const key of ["coverUrl", "cover", "picUrl", "imageUrl"]) {
    const value = textOf(playlist[key]);
    if (value !== null) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 歌单详情页头部：标题、元信息与两个动作的文案
// ---------------------------------------------------------------------------
// 「共几首」与「已加载几首」来自两处数据，纯函数化才便于断言。

/** 「播放全部」按钮文案（唯一出处：组件不再抄一份）。 */
export const PLAYLIST_PLAY_ALL_LABEL = "播放全部";
/** 「加入队列」按钮文案。 */
export const PLAYLIST_ENQUEUE_LABEL = "加入队列";
/** 列表没有名字时的兜底标题（与歌单卡一致：不显示空壳）。 */
export const PLAYLIST_FALLBACK_NAME = "未命名歌单";

/**
 * 头部标题：接口给的歌单名优先，其次视图参数里的名字，都没有才兜底——**不显示空标题**。
 * @param {unknown} playlist 协议层归一化过的歌单对象
 * @param {string|null} [fallbackName] 视图参数里的名字
 * @returns {string}
 */
export function playlistDetailTitleOf(playlist, fallbackName = null) {
  if (isObject(playlist)) {
    for (const key of ["name", "playlistName", "title"]) {
      const value = textOf(playlist[key]);
      if (value !== null) return value;
    }
  }
  return textOf(fallbackName) ?? PLAYLIST_FALLBACK_NAME;
}

/**
 * 头部那行元信息：有总数说「共 N 首」，分页没走完再补「已加载 M 首」；没有总数只说已加载。
 * @param {unknown} playlist 协议层归一化过的歌单对象
 * @param {number} loadedCount 页面已加载的曲目条数
 * @param {boolean} [hasMore] 协议层是否明说还有下一页
 * @returns {string}
 */
export function playlistDetailMetaText(playlist, loadedCount, hasMore = false) {
  const loaded = Number.isInteger(loadedCount) && loadedCount >= 0 ? loadedCount : 0;
  const total = playlistSongCountOf(playlist);
  if (total === null) return `已加载 ${loaded} 首`;
  if (hasMore && loaded < total) return `共 ${total} 首 · 已加载 ${loaded} 首`;
  return `共 ${total} 首`;
}
