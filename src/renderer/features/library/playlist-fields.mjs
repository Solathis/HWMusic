/**
 * 歌单条目的展示投影（R8）：与歌曲一样，字段名待联调确认，取不到就如实回占位。
 *
 * 单独一个文件而不是塞进 track-fields：歌单与歌曲是两种资源，
 * 混在一起早晚会出现"给歌单读 songId"这种串味的兜底。
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
 * 封面地址（R38 起真的被 `PlaylistGrid` 用上了）。
 *
 * 协议层 `normalizePlaylist` 只在 CDN 白名单内才带 `coverUrl`（白名单外的地址在那边就被丢掉），
 * 所以这里读到的要么是白名单内的地址，要么是 null。渲染层只把它交给 `<img src>`——
 * **绝不 fetch**（CSP `connect-src` 只有 self/ipc；图片走 `img-src`，见 §2.4）。
 * 取不到回 null，由调用方决定占位（界面上不留碎图）。
 */
export function playlistCoverUrlOf(playlist) {
  if (!isObject(playlist)) return null;
  for (const key of ["coverUrl", "cover", "picUrl", "imageUrl"]) {
    const value = textOf(playlist[key]);
    if (value !== null) return value;
  }
  return null;
}
