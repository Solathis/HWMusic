/**
 * 华为业务接口的数据形状（R4 协议原型层的类型说明，供 R7/R8 的 TS 侧消费）。
 *
 * 这些形状**不是**从官方文档抄来的：字段名以旧仓审计事实与探针观测为准，
 * 未确认处已标注 `待 R7 联调确认`（见 docs/API_CONTRACT.md）。
 * 运行时实现是 src/protocols/music.mjs（.mjs，Node 侧直接跑；这里只做类型声明，不含逻辑）。
 */
import type { CoreResult } from "./shared/result.ts";

/** 歌曲条目（只列本项目用得到的字段；原始对象整体保留，不做重建）。 */
export interface Song {
  id?: string | number;
  /** 兼容字段：不同接口用不同名字指同一件事，`trackIdOf` 按序兜底 */
  songId?: string | number;
  musicId?: string | number;
  resourceId?: string | number;
  name?: string;
  singer?: string;
  album?: string;
  duration?: number;
  [key: string]: unknown;
}

/** 歌单条目。 */
export interface Playlist {
  id?: string | number;
  name?: string;
  coverUrl?: string;
  songCount?: number;
  [key: string]: unknown;
}

/** 播放地址接口的原始响应（**顶层 `fileURL` 才是音频地址**）。 */
export interface PlaybackPayload {
  fileURL?: string;
  /** 可能是 JSON 字符串，也可能是已解析对象/数组 */
  fileInfos?: string | unknown[] | Record<string, unknown>;
  format?: string;
  size?: number;
  bitrate?: number;
  duration?: number;
  /** 试听时长（秒）；**不能单独**作为试听判定依据，见 `classifyAudition` */
  auditionTime?: number;
  isAudition?: boolean;
  [key: string]: unknown;
}

/** `getPlayback` 解码后的结果。 */
export interface PlaybackInfo {
  url: string;
  fileInfos: unknown;
  format: string | null;
  size: number | null;
  bitrate: number | null;
  duration: number | null;
  /** 仅当 auditionTime 与标志位两个信号齐备时为 true */
  auditionLikely: boolean;
  signals: string[];
  warnings: string[];
}

/** 收藏渐进加载快照。 */
export interface FavoritesSnapshot {
  songs: Song[];
  /** 已加载 N 首（UI 显示用） */
  loadedCount: number;
  /** 完整分页走完后的去重总数；未走完为 null（UI 不许提前写"共 M 首"） */
  total: number | null;
  /** 接口上报的 total（不可信，只作记录） */
  reportedTotal: number | null;
  /** 无 ID 被丢弃的条目数 */
  skipped: number;
  pages: number;
  isComplete: boolean;
  stopReason: "exhausted" | "max_pages" | "error" | null;
}

/** 分页加载的一步结果。 */
export interface FavoritesStep {
  added: number;
  loadedCount: number;
  total: number | null;
  isComplete: boolean;
  stopReason: FavoritesSnapshot["stopReason"];
}

/** 端点表：键名是实现里的 `MUSIC_ENDPOINT_KEYS`，值必须是 https URL。 */
export type MusicEndpoints = Partial<Record<
  "favorites" | "playlistList" | "playlistDelete" | "search" | "album" | "artist" | "history" | "playback",
  string
>>;

/** 请求参数名表（真实参数名待 R7 联调确认）。 */
export interface QueryNames {
  page: string;
  pageSize: string;
  keyword: string;
  id: string;
}

/** 会话头注入：真实凭据方案由 R7 在探针确认后提供，协议层默认不带任何凭据。 */
export type SessionHeadersFactory = (context: { key: string }) => Record<string, string>;

/** 收藏加载器。 */
export interface FavoritesLoader {
  loadNext(): Promise<CoreResult<FavoritesStep>>;
  loadAll(): Promise<CoreResult<FavoritesSnapshot>>;
  snapshot(): FavoritesSnapshot;
}

/** 音乐接口客户端（`createMusicApi` 的返回形状）。 */
export interface MusicApi {
  endpointOf(key: string): CoreResult<string>;
  requestJson(key: string, request?: { method?: string; params?: Record<string, unknown>; body?: unknown }): Promise<CoreResult<unknown>>;
  listFavoritesPage(request?: { page?: number; pageSize?: number; params?: Record<string, unknown> }): Promise<CoreResult<unknown>>;
  createFavoritesLoader(options?: { pageSize?: number; maxPages?: number }): FavoritesLoader;
  loadAllFavorites(options?: { pageSize?: number; maxPages?: number }): Promise<CoreResult<FavoritesSnapshot>>;
  listPlaylists(request?: { page?: number; pageSize?: number; params?: Record<string, unknown> }): Promise<CoreResult<{ playlists: Playlist[]; hasMore: boolean }>>;
  deletePlaylist(playlistId: string, request?: { method?: string; params?: Record<string, unknown>; body?: unknown }): Promise<CoreResult<{ deleted: true; playlistId: string; detail: unknown }>>;
  search(keyword: string, request?: { page?: number; pageSize?: number; params?: Record<string, unknown> }): Promise<CoreResult<{ songs: Song[]; hasMore: boolean }>>;
  getAlbum(albumId: string, request?: { params?: Record<string, unknown> }): Promise<CoreResult<{ songs: Song[]; detail: unknown }>>;
  getArtist(artistId: string, request?: { params?: Record<string, unknown> }): Promise<CoreResult<{ songs: Song[]; detail: unknown }>>;
  getHistory(request?: { page?: number; pageSize?: number; params?: Record<string, unknown> }): Promise<CoreResult<{ songs: Song[]; hasMore: boolean }>>;
  getPlayback(request?: { trackId?: string; id?: string; params?: Record<string, unknown> }): Promise<CoreResult<PlaybackInfo>>;
}
