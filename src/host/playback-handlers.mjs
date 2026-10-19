/**
 * `playback:resolve-url` 频道处理器（R9）：把"当次播放地址"的请求翻成协议层的 `getPlayback`。
 *
 * 这个频道与 `library:*` 的三处不同（都是刻意的）：
 * - **结果里带播放地址**——这是它的全部意义。处理器只把它放进这一次的应答里：
 *   不写日志（`console.*` 在这个文件里一个都没有）、不碰设置/磁盘（没有任何持久化出口）。
 *   地址的持久化禁令落在队列那边：队列只存曲目标识 + 索引。
 * - **不做二次校验**：白名单（CDN 后缀）在协议层 `parsePlaybackPayload` 里查，未配置端点
 *   在那里回 `endpoint_unknown`。这里只做"载荷够不够"，不重写协议层的结论——
 *   两处各判一次，早晚会判出两个不同的答案。
 * - **不缓存**：播放地址是**当次**的（可能带时效签名），缓存它等于把"这一次能用"变成
 *   "以后也能用"。所以没有 map、没有 memo。
 */
import { PLAYBACK_RESOLVE_URL } from "../shared/request-channels.ts";
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
 * 造 `playback:resolve-url` 的处理器表（`dispatcher.register` 直接消费）。
 *
 * @param {{api: object}} options `api` = src/protocols/music.mjs 的 `createMusicApi()` 产物
 * @returns {Record<string, (request: object) => Promise<object>|object>}
 */
export function createPlaybackHandlers({ api } = {}) {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createPlaybackHandlers 需要注入 music api（端点未配置时它自己会回结构化错误）");
  }

  return {
    [PLAYBACK_RESOLVE_URL]: (request) => {
      const payload = payloadOf(request);
      const trackId = textOf(payload.trackId) ?? textOf(payload.id);
      if (trackId === null) {
        return err("播放地址需要非空 trackId（曲目标识）", CORE_ERROR_KINDS.invalidPayload);
      }
      return api.getPlayback({ trackId });
    },
  };
}
