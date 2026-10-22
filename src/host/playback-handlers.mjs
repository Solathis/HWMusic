/**
 * `playback:resolve-url` 与 `playback:lyrics` 两个频道的处理器（R9 / R12）：把请求翻成协议层的调用。
 *
 * 这两条与 `library:*` 有三处不同（都是刻意的），两条频道共享同一套纪律：
 * - **结果里带"当次"的东西**——播放地址与歌词文本。处理器只把它们放进这一次的应答里：
 *   不写日志（`console.*` 在这个文件里一个都没有）、不碰设置/磁盘（没有任何持久化出口）。
 *   音频地址的持久化禁令落在队列那边（只存标识、索引与安全展示快照）；歌词文本只在渲染层的内存里，
 *   由歌词窗与主窗面板共用。
 * - **不做二次校验**：白名单（CDN 后缀）在协议层 `parsePlaybackPayload` 里查，未配置端点
 *   在那里回 `endpoint_unknown`。这里只做"载荷够不够"，不重写协议层的结论——
 *   两处各判一次，早晚会判出两个不同的答案。
 * - **不缓存**：播放地址是**当次**的（可能带时效签名），缓存它等于把"这一次能用"变成
 *   "以后也能用"；歌词文本同理不缓存（换歌就该换词，缓存只会让歌词窗显示上一首的）。
 *
 * 为什么 `playback:lyrics` 返回**原始文本**而不是解析好的行：逐行滚动必须来自 AMLL 官方组件，
 * 而"文本 → 行"是官方 `parseLrc` 的职责（`features/lyrics/amll-adapter.ts` 在它之上补 offset
 * 与翻译行）。解析放在这里，渲染层拿到的就是一份"别人解析好的东西"，官方版本一变就对不上。
 */
import { PLAYBACK_LYRICS, PLAYBACK_RESOLVE_URL } from "../shared/request-channels.ts";
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
 *
 * @param {{api: object}} options `api` = src/protocols/music.mjs 的 `createMusicApi()` 产物
 * @returns {Record<string, (request: object) => Promise<object>|object>}
 */
export function createPlaybackHandlers({ api } = {}) {
  if (api === null || typeof api !== "object") {
    throw new TypeError("createPlaybackHandlers 需要注入 music api（端点未配置时它自己会回结构化错误）");
  }

  /** 两条频道共用的载荷读法：`trackId` 必填，缺了就是调用方的问题。 */
  function trackIdOf(request) {
    const payload = payloadOf(request);
    return textOf(payload.trackId) ?? textOf(payload.id);
  }

  /**
   * 第三方歌词回退要用的曲目元信息（R41）：`title` / `artist` / `durationSeconds`。
   *
   * 为什么由**渲染层**给而不是 core 自己去查：这三个值就在渲染层手里那份曲目投影里
   * （`features/library/track-fields.mjs` 已经归一好），而 core 为了拿它们得再问一次曲目接口
   * ——多一次请求、多一份可能过期的缓存，还可能问到别的曲目上。
   *
   * 三条边界：
   * - **全部可选**：一个都不给，`getLyrics` 就只是少掉第三方那一跳（没有标题的回退等于盲搜）；
   * - **认不出就不给**（不是字符串 / 不是正数 → 省略该字段），绝不编一个默认值——
   *   一个编出来的时长会把严格匹配器带偏（它可是"宁可不显示"的那一侧）；
   * - **只用于匹配**：这三个值不进日志、不落盘（落盘的是匹配到的那个候选的标题/艺人）。
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
    [PLAYBACK_LYRICS]: (request) => {
      const trackId = trackIdOf(request);
      if (trackId === null) {
        return err("歌词需要非空 trackId（曲目标识）", CORE_ERROR_KINDS.invalidPayload);
      }
      return api.getLyrics({ trackId, ...metadataOf(request) });
    },
  };
}
