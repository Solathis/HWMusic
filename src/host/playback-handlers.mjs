/**
 * `playback:resolve-url` 与 `playback:lyrics` 两个频道的处理器：把请求翻成协议层的调用。
 * 播放地址与歌词文本是当次的：不写日志、不落盘、不缓存，校验只做载荷形状。
 */
import { PLAYBACK_LYRICS, PLAYBACK_RESOLVE_URL } from "../shared/request-channels.ts";
import { isLocalTrackId } from "../shared/local-track.ts";
import { CORE_ERROR_KINDS, err } from "../shared/result.ts";

/** 请求载荷：不是对象就当成空对象（缺什么由下面的必填校验说话）。 */
function payloadOf(request) {
  const payload = request?.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

/** 非空字符串（去首尾空白）；其余一律 null——数字 id 不是"调用方填了值"（id 可能是 0，猜不得）。 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 造 `playback:resolve-url` / `playback:lyrics` 的处理器表（`dispatcher.register` 直接消费）。
 * @param {{api: object, localLyrics?: Function|null}} options `api` = music api 产物；`localLyrics` = 本地曲目的取词口。
 * @returns {Record<string, (request: object) => Promise<object>|object>}
 */
export function createPlaybackHandlers({ api, localLyrics = null } = {}) {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createPlaybackHandlers 需要注入 music api（端点未配置时它自己会回结构化错误）");
  }

  /** 两条频道共用的载荷读法：`trackId` 必填，缺了就是调用方的问题。 */
  function trackIdOf(request) {
    const payload = payloadOf(request);
    return textOf(payload.trackId) ?? textOf(payload.id);
  }

  /**
   * 第三方歌词回退要用的曲目元信息：`title` / `artist` / `durationSeconds`，全部可选且只用于匹配。
   */
  function metadataOf(request) {
    const payload = payloadOf(request);
    const meta = {};
    const title = textOf(payload.title);
    if (title !== null) meta.title = title;
    const artist = textOf(payload.artist);
    if (artist !== null) meta.artist = artist;
    for (const key of ["durationSeconds", "duration"]) {
      const value = Number(payload[key]);
      if (Number.isFinite(value) && value > 0) {
        meta.durationSeconds = value;
        break;
      }
    }
    return meta;
  }

  return {
    [PLAYBACK_RESOLVE_URL]: (request) => {
      const trackId = trackIdOf(request);
      if (trackId === null) {
        return err("播放地址需要非空 trackId（曲目标识）", CORE_ERROR_KINDS.invalidPayload);
      }
      return api.getPlayback({ trackId });
    },
    [PLAYBACK_LYRICS]: async (request) => {
      const trackId = trackIdOf(request);
      if (trackId === null) {
        return err("歌词需要非空 trackId（曲目标识）", CORE_ERROR_KINDS.invalidPayload);
      }
      // 本地曲目走本地那一链（手动导入 → 同名文件/内嵌标签 → 没有）。**绝不落到在线那一侧**：
      // 那个 id 在华为侧根本不存在，问它只会换来一个"这首歌没有可用的歌词"以外的噪声错误。
      if (isLocalTrackId(trackId)) {
        const doc =
          typeof localLyrics === "function"
            ? await localLyrics(trackId).catch(() => null)
            : null;
        if (doc === null || typeof doc !== "object") {
          return err(
            "这首歌没有可用的歌词（同名 .lrc / .txt 与内嵌歌词都没有，也可以手动导入一份）",
            "invalid_response",
          );
        }
        return { ok: true, data: { ...doc, warnings: [] } };
      }
      return api.getLyrics({ trackId, ...metadataOf(request) });
    },
  };
}
