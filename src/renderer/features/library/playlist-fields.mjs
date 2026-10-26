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
 * 封面地址：交给侧栏歌单条目（`sidebar-playlists.mjs` 的 `sidebarPlaylistItems`）与歌单详情页头部
 * （`pages.tsx` 的 `CoverArt` 与 AMLL 底景）显示。
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

// ---------------------------------------------------------------------------
// 歌单详情页头部（R40）：标题、元信息与两个动作的文案
// ---------------------------------------------------------------------------
//
// 为什么要单列这几条纯函数：头部会显示"共几首 / 已加载几首"，而那两个数字来自两处
// （接口上报的总数、页面已加载的条数）。写进组件里就只能靠人眼核对——而"把已加载 50 首
// 说成共 50 首"正是这类页面最容易撒的谎（歌单可能有 1623 首）。

/** 「播放全部」按钮文案（唯一出处：组件不再抄一份）。 */
export const PLAYLIST_PLAY_ALL_LABEL = "播放全部";
/** 「加入队列」按钮文案。 */
export const PLAYLIST_ENQUEUE_LABEL = "加入队列";
/** 列表没有名字时的兜底标题（与歌单卡一致：不显示空壳）。 */
export const PLAYLIST_FALLBACK_NAME = "未命名歌单";

/**
 * 头部标题：优先用接口给的歌单名，没有歌单对象时回落到视图参数里的名字（从歌单卡带过来的）。
 * 两个都没有才是兜底文案——**不显示空标题**。
 *
 * @param {unknown} playlist 协议层归一化过的歌单对象（可能是 null/坏形状）
 * @param {string|null} [fallbackName] 视图参数里的名字（歌单卡带过来的）
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
 * 头部那行元信息。
 *
 * - 接口上报了总数 → "共 N 首"；**只在真的分页没走完时**再补一句"已加载 M 首"
 *   （分页走完时两个数字必然相等，写两遍只是噪音）；
 * - 没有总数 → 就说已加载多少（"已加载 M 首"），不说"共"。
 *
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
