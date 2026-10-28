/**
 * 华为业务接口的数据形状（协议层的类型说明，供 TS 侧消费）。
 * 线上形状见 `docs/API_CONTRACT.md` §2，协议层负责翻成这些内部形状（`contentID → id`、`contentName → name`…）。
 * 运行时实现是 src/protocols/music.mjs；这里只做类型声明，不含逻辑。
 */
import type { CoreResult } from "./shared/result.ts";

/** 歌曲条目（协议层归一化后的产物；id 一定有，其余缺失即未知）。 */
export interface Song {
  id: string;
  /** 兼容字段：`trackIdOf` 仍按序兜底旧形状（手工注入的响应） */
  songId?: string | number;
  musicId?: string | number;
  resourceId?: string | number;
  name?: string;
  singer?: string;
  albumId?: string;
  albumName?: string;
  coverUrl?: string;
  /** 秒（真接口的字段单位未变） */
  duration?: number;
  [key: string]: unknown;
}

/** 歌单条目（`kind` 来自 contentType：4=收藏、5=自建、7=榜单）。 */
export interface Playlist {
  id: string;
  name: string;
  kind?: "collected" | "owned" | "chart" | "unknown";
  count?: number;
  coverUrl?: string;
  description?: string;
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
  /** 接口回的音质码（"1"=standard、"3"=lossless） */
  playQuality?: string;
  /** 声明的内容类型（mp3/flac…）：**与 playQuality 对得上才算"已确认音质"** */
  type?: string;
  songInfo?: { duration?: number | string; [key: string]: unknown };
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
  /** 声明的音质与实际返回对得上才算确认；否则 "unknown"（不虚标） */
  actualQuality: "standard" | "lossless" | "unknown";
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

/** 端点表：键名是实现里的 `MUSIC_ENDPOINT_KEYS`，值必须是 https URL（`null` = 显式关闭）。 */
export type MusicEndpoints = Partial<Record<
  | "favorites"
  | "playlistList"
  | "playlistDetail"
  | "playlistDetailPublic"
  | "playlistDelete"
  | "search"
  | "album"
  | "artist"
  | "history"
  | "playback"
  | "lyrics",
  string | null
>>;

/** 单页收藏读取：**没有 total**——总数只能来自完整分页后的 ID 去重。 */
export interface FavoritesPage {
  page: number;
  pageSize: number;
  /** 已剔除无 ID 的条目（不编 ID），每条都带可用 id */
  songs: Song[];
  skipped: number;
  /** 接口上报的 total（不可信，只作记录）；没报就是 null */
  reportedTotal: number | null;
  /** 分页结论由协议层给出（渲染层不自己猜） */
  hasMore: boolean;
}

/** 会话注入：协议层不知道凭据长什么样，头由主进程按实测的 Digest 形状造。 */
export type SessionHeadersFactory = (context: { key: string; authenticated: boolean }) => Record<string, string>;

/** 收藏加载器。 */
export interface FavoritesLoader {
  loadNext(): Promise<CoreResult<FavoritesStep>>;
  loadAll(): Promise<CoreResult<FavoritesSnapshot>>;
  snapshot(): FavoritesSnapshot;
}

/** 音乐接口客户端（`createMusicApi` 的返回形状）。 */
export interface MusicApi {
  endpointOf(key: string): CoreResult<string>;
  call(key: string, request?: { params?: Record<string, unknown>; retry?: boolean }): Promise<CoreResult<unknown>>;
  listFavoritesPage(request?: { page?: number; pageSize?: number; contentTypes?: string[] }): Promise<CoreResult<unknown>>;
  readFavoritesPage(request?: { page?: number; pageSize?: number }): Promise<CoreResult<FavoritesPage>>;
  createFavoritesLoader(options?: { pageSize?: number; maxPages?: number }): FavoritesLoader;
  loadAllFavorites(options?: { pageSize?: number; maxPages?: number }): Promise<CoreResult<FavoritesSnapshot>>;
  listPlaylists(request?: { page?: number; pageSize?: number }): Promise<CoreResult<{ playlists: Playlist[]; hasMore: boolean; scanned: number }>>;
  getPlaylistDetail(playlistId: string, request?: { page?: number; pageSize?: number; kind?: "auto" | "owned" | "collected" }): Promise<CoreResult<{ playlistId: string; playlist: Playlist | null; songs: Song[]; hasMore: boolean }>>;
  deletePlaylist(playlistId: string): Promise<CoreResult<{ deleted: true; playlistId: string }>>;
  search(keyword: string, request?: { page?: number; pageSize?: number }): Promise<CoreResult<{ songs: Song[]; skipped: number; reportedTotal: number | null; hasMore: boolean }>>;
  getAlbum(albumId: string, request?: { page?: number; pageSize?: number }): Promise<CoreResult<{ albumId: string; songs: Song[]; detail: unknown; hasMore: boolean }>>;
  getArtist(artistId: string, request?: { songNum?: number; albumNum?: number }): Promise<CoreResult<{ artistId: string; songs: Song[]; detail: unknown }>>;
  getHistory(request?: { page?: number; pageSize?: number }): Promise<CoreResult<{ songs: Song[]; skipped: number; reportedTotal: number | null; hasMore: boolean }>>;
  getPlayback(request?: { trackId?: string; id?: string; quality?: "standard" | "lossless" }): Promise<CoreResult<PlaybackInfo>>;
  getLyrics(request?: { trackId?: string; id?: string; quality?: "standard" | "lossless" }): Promise<CoreResult<{ text: string; format: string; warnings: string[] }>>;
}
