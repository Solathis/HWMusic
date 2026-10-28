/**
 * Media Session 对接：系统媒体控件 / 耳机按键 / SMTC 的播放控制入口，纯浏览层能力。
 *
 * 能力缺失就静默降级；不支持的动作跳过但留痕；不编元数据（标题/艺人/专辑来自队列快照）。
 */
import { PLAYER_STATUS } from "./player.mjs";
import { guardMediaUrl } from "./media-url.mjs";
import { trackArtistOf, trackTitleOf } from "./playback-state.mjs";

/** 接线的动作（唯一真源：测试与运行时都从这里取）。 */
export const MEDIA_SESSION_ACTIONS = ["play", "pause", "nexttrack", "previoustrack", "seekto"];

/** 状态 → 系统控件的播放状态（MediaSession 只认这三个值）。 */
export function mediaPlaybackStateOf(status) {
  if (status === PLAYER_STATUS.playing) return "playing";
  if (status === PLAYER_STATUS.paused || status === PLAYER_STATUS.loading) return "paused";
  return "none";
}

function describe(cause) {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return String(cause);
}

/**
 * 造 Media Session 端口。
 * @param {object} [options]
 * @param {object|null} [options.session] `navigator.mediaSession`（默认取全局；显式 null = 环境没有）
 * @param {new (init: object) => object} [options.metadataCtor] `MediaMetadata`
 * @param {(...parts: unknown[]) => void} [options.log]
 */
export function createMediaSession(options = {}) {
  const session =
    options.session !== undefined ? options.session : (globalThis.navigator?.mediaSession ?? null);
  const MetadataCtor =
    options.metadataCtor !== undefined ? options.metadataCtor : (globalThis.MediaMetadata ?? null);
  const log = typeof options.log === "function" ? options.log : () => {};

  /** 已接上的动作（clear 时按这份清单摘）。 */
  let wired = [];

  function setHandler(action, handler) {
    try {
      session.setActionHandler(action, handler);
      return true;
    } catch (cause) {
      log(`媒体会话不支持 ${action}（已跳过这一项）：`, describe(cause));
      return false;
    }
  }

  /**
   * 接线：把系统控件/耳机按键的动作转到宿主的方法上。
   * @param {{play?: Function, pause?: Function, next?: Function, previous?: Function, seek?: (ms: number) => void}} hooks
   * @returns {{attached: boolean, actions: string[]}}
   */
  function attach(hooks = {}) {
    if (session === null || typeof session.setActionHandler !== "function") {
      return { attached: false, actions: [] };
    }

    const plan = [
      ["play", () => hooks.play?.()],
      ["pause", () => hooks.pause?.()],
      ["nexttrack", () => hooks.next?.()],
      ["previoustrack", () => hooks.previous?.()],
      // seekto 的 seekTime 单位是**秒**（规范如此），状态机用毫秒
      ["seekto", (details) => hooks.seek?.(Math.round((Number(details?.seekTime) || 0) * 1000))],
    ];

    wired = [];
    for (const [action, handler] of plan) {
      if (setHandler(action, handler)) wired.push(action);
    }
    return { attached: wired.length > 0, actions: [...wired] };
  }

  /**
   * 更新系统控件（曲目 / 状态）。返回是否真的写进去了（环境没有这个能力时 false）。
   *
   * @param {{track?: {id?: string, name?: string|null, artists?: string|null, albumName?: string|null, coverUrl?: string|null}|null, status?: string}} [options]
   */
  function update({ track = null, status = PLAYER_STATUS.idle } = {}) {
    if (session === null) return false;

    if (typeof session.metadata !== "undefined" || MetadataCtor !== null) {
      if (MetadataCtor !== null) {
        const coverUrl = guardMediaUrl(track?.coverUrl);
        const init = {
          title: trackTitleOf(track),
          artist: trackArtistOf(track),
          ...(track?.albumName ? { album: track.albumName } : {}),
          ...(coverUrl === null ? {} : { artwork: [{ src: coverUrl }] }),
        };
        try {
          session.metadata = new MetadataCtor(init);
        } catch (cause) {
          log("写入媒体元数据失败（系统控件将只显示状态）：", describe(cause));
        }
      }
    }
    try {
      session.playbackState = mediaPlaybackStateOf(status);
    } catch (cause) {
      log("写入媒体播放状态失败（忽略）：", describe(cause));
    }
    return true;
  }

  /** 收场：摘掉动作、清空元数据、状态回 none（不留一个点了没反应的幽灵控件）。 */
  function clear() {
    if (session === null || typeof session.setActionHandler !== "function") return false;
    for (const action of wired) setHandler(action, null);
    wired = [];
    try {
      session.metadata = null;
      session.playbackState = "none";
    } catch (cause) {
      log("清空媒体会话失败（忽略）：", describe(cause));
    }
    return true;
  }

  return { attach, update, clear, supported: session !== null };
}
