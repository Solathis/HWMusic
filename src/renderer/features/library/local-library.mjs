/**
 * 本地曲库在渲染层的纯投影：local: id、协议地址、命令应答 → 表格行与文案（不碰 React/Tauri）。
 * id 与地址只按形状拼（调用方塞进来的路径片段进不了 URL）；没有基址就不产地址，不回落写死的域。
 * 读不到就说读不到：没有标题写「未知歌曲」，没有专辑就留空。
 */
import {
  LOCAL_AUDIO_FORMATS,
  LOCAL_MEDIA_SCHEME,
  LOCAL_TRACK_HEX_LENGTH,
  LOCAL_TRACK_PREFIX,
  isLocalTrackId,
  localHexId,
  localTrackId,
} from "../../../shared/local-track.ts";
import { formatDuration, trackNameOrNull } from "./track-fields.mjs";

export {
  LOCAL_AUDIO_FORMATS,
  LOCAL_MEDIA_SCHEME,
  LOCAL_TRACK_HEX_LENGTH,
  LOCAL_TRACK_PREFIX,
  isLocalTrackId,
  localHexId,
  localTrackId,
};

/** 协议路径的两种形状（唯一真源；Rust 侧的 `parse_protocol_path` 是镜像副本）。 */
export const LOCAL_MEDIA_KINDS = Object.freeze({ audio: "audio", cover: "cover" });

/**
 * 基址归一并校验：只去末尾斜杠、只认宿主给的那两种形态（Windows `http://hwlocal.localhost`，
 * mac/Linux `hwlocal://localhost`）。渲染层不按平台名自己推——推错的表现是"封面和音频全都 404"。
 */
export function normalizeLocalBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string") return null;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^(?:http:\/\/hwlocal\.localhost|hwlocal:\/\/localhost)$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 协议路径：`/<id>`（音频）或 `/<id>/cover`（封面）。
 * id 形状不对、类型认不出都回 `null`——路径只有这两种，没有第三种。
 */
export function localMediaPath(hexId, kind = LOCAL_MEDIA_KINDS.audio) {
  if (typeof hexId !== "string" || !/^[0-9a-f]{32}$/.test(hexId)) return null;
  if (kind === LOCAL_MEDIA_KINDS.audio) return `/${hexId}`;
  if (kind === LOCAL_MEDIA_KINDS.cover) return `/${hexId}/cover`;
  return null;
}

/** 曲目音频地址（拖进度就靠它：协议支持 Range）。 */
export function localMediaUrl(baseUrl, hexId) {
  const base = normalizeLocalBaseUrl(baseUrl);
  const path = localMediaPath(hexId, LOCAL_MEDIA_KINDS.audio);
  return base === null || path === null ? null : `${base}${path}`;
}

/** 曲目封面地址（与音频同一个协议；`img-src` 里放行的那一条）。 */
export function localCoverUrl(baseUrl, hexId) {
  const base = normalizeLocalBaseUrl(baseUrl);
  const path = localMediaPath(hexId, LOCAL_MEDIA_KINDS.cover);
  return base === null || path === null ? null : `${base}${path}`;
}

/**
 * 一条 Rust 记录 → 曲目表的一行（形状对齐 `track-fields.mjs` 读的那套键，可直接喂 `TrackTable` 与队列）。
 * 记录形状不对、或者没有基址（拼不出封面/音频）都回 `null`：不做半行数据。
 */
export function localSongOf(track, baseUrl) {
  if (track === null || typeof track !== "object" || Array.isArray(track)) return null;
  const hex = typeof track.id === "string" ? track.id : null;
  const id = localTrackId(hex);
  const base = normalizeLocalBaseUrl(baseUrl);
  if (id === null || base === null) return null;

  const duration = Number(track.duration);
  return {
    id,
    localId: hex,
    name: trackNameOrNull({ name: track.title }) ?? "未知歌曲",
    artists: trackNameOrNull({ name: track.artists }) ?? "未知艺人",
    albumName: trackNameOrNull({ name: track.album }),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    coverUrl: track.hasCover === true ? localCoverUrl(base, hex) : null,
    format: typeof track.format === "string" ? track.format : null,
    available: track.available !== false,
  };
}

/** 命令应答归一（`{tracks, available}`）：坏形状回空列表，绝不抛。 */
export function normalizeLocalAnswer(answer, baseUrl) {
  const base = normalizeLocalBaseUrl(baseUrl);
  const records = answer !== null && typeof answer === "object" && Array.isArray(answer.tracks) ? answer.tracks : [];
  const tracks = [];
  for (const record of records) {
    const song = localSongOf(record, base);
    if (song !== null) tracks.push(song);
  }
  return { baseUrl: base, tracks, available: answer?.available !== false };
}

/** 不可用的行（文件已不在）的 id 列表：页面据此标出"这一行现在的状态"。 */
export function unavailableLocalSongIds(songs) {
  if (!Array.isArray(songs)) return [];
  return songs.filter((song) => song !== null && typeof song === "object" && song.available === false).map((song) => song.id);
}

/** 导入结果的一句话：加了几首、几首是已在库里的（更新了元数据）。 */
export function describeImportSummary(result) {
  const added = Number(result?.added) || 0;
  const updated = Number(result?.updated) || 0;
  if (added === 0 && updated === 0) return "没有导入新的歌曲。";
  const head = `已导入 ${added} 首`;
  return updated > 0 ? `${head}（${updated} 首已在库中，已更新信息）` : `${head}。`;
}

/** 被拒的文件一句话（Rust 侧已经给好理由，这里只负责拼句子）。 */
export function describeRejectedImports(rejected) {
  if (!Array.isArray(rejected) || rejected.length === 0) return "";
  const parts = rejected
    .filter((entry) => entry !== null && typeof entry === "object")
    .map((entry) => `「${String(entry.name ?? "未命名")}」`);
  if (parts.length === 0) return "";
  const reason = String(rejected[0]?.reason ?? "无法导入");
  return `${parts.join("")}没有导入：${reason}`;
}

/** 队列恢复时的那一句提示（一首都没跳过就闭嘴）。 */
export function describeSkippedLocalTracks(count) {
  const skipped = Number(count);
  if (!Number.isFinite(skipped) || skipped <= 0) return "";
  return `${skipped} 首本地歌曲的文件已不在，已从队列跳过。`;
}

/** 时长的展示口径与在线曲目同一套（取不到就是占位，不显示 0:00）。 */
export { formatDuration };
