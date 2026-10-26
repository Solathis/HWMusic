/**
 * 侧栏「我的歌单」的展示投影：名字/封面/数量都从协议层归一化过的歌单读，数量数不出来就是 null。
 * 自建/收藏只认协议层的 `kind`（`normalizePlaylist` 给的 owned/collected），认不出就不标。
 */
import { playlistCoverUrlOf, playlistIdOf, playlistNameOf, playlistSongCountOf } from "./playlist-fields.mjs";

export const SIDEBAR_PLAYLISTS_LABEL = "我的歌单";
export const SIDEBAR_PLAYLISTS_EMPTY_TEXT = "还没有歌单。";
export const SIDEBAR_PLAYLISTS_RETRY_LABEL = "重试";

export const SIDEBAR_PLAYLISTS_TESTID = "sidebar-playlists";
export const SIDEBAR_PLAYLISTS_LIST_TESTID = "sidebar-playlist-list";
export const SIDEBAR_PLAYLISTS_SKELETON_TESTID = "sidebar-playlists-skeleton";
export const SIDEBAR_PLAYLISTS_FAILURE_TESTID = "sidebar-playlists-failure";
export const SIDEBAR_PLAYLISTS_EMPTY_TESTID = "sidebar-playlists-empty";
export const SIDEBAR_PLAYLIST_ITEM_TESTID = "sidebar-playlist-item";
export const SIDEBAR_PLAYLIST_NAME_TESTID = "sidebar-playlist-name";
export const SIDEBAR_PLAYLIST_META_TESTID = "sidebar-playlist-meta";

/** 协议层的 kind → 一句话标签。榜单与认不出的 kind 不标（不猜它是自建还是收藏）。 */
const KIND_LABELS = { owned: "自建", collected: "收藏" };

export function playlistKindLabel(kind) {
  return typeof kind === "string" && KIND_LABELS[kind] !== undefined ? KIND_LABELS[kind] : null;
}

/** 「自建 · 120 首」：两样都没有时回 null（不留一行空文字）。 */
export function sidebarPlaylistMetaText(playlist) {
  const parts = [];
  const label = playlistKindLabel(playlist !== null && typeof playlist === "object" ? playlist.kind : null);
  if (label !== null) parts.push(label);
  const count = playlistSongCountOf(playlist);
  if (count !== null) parts.push(`${count} 首`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 窄轨里只剩封面，tooltip 得把名字和数量都说出来（名字在前，与条目上的一致）。 */
export function sidebarPlaylistTooltipText(playlist) {
  const name = playlistNameOf(playlist);
  const meta = sidebarPlaylistMetaText(playlist);
  return meta === null ? name : `${name} · ${meta}`;
}

/**
 * 侧栏条目：没有 id 的歌单丢掉（点了也不知道该开哪一张），其余保持接口给的顺序。
 * 投影一次算好，渲染层不再各自兜底字段（与 `playlist-fields.mjs` 同一处结论）。
 */
export function sidebarPlaylistItems(playlists) {
  const list = Array.isArray(playlists) ? playlists : [];
  const items = [];
  for (const playlist of list) {
    const id = playlistIdOf(playlist);
    if (id === null) continue;
    items.push({
      id,
      name: playlistNameOf(playlist),
      coverUrl: playlistCoverUrlOf(playlist),
      metaText: sidebarPlaylistMetaText(playlist),
      tooltipText: sidebarPlaylistTooltipText(playlist),
      source: playlist,
    });
  }
  return items;
}
