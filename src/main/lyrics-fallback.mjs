/**
 * 第三方歌词回退：华为那条链四档全取不到、且曲目有标题时，再试一个来源。
 * 三条硬边界：失败静默（不抛、不打断播放、不缓存）、匹配严格（标题 + 艺人 + 时长）、
 * 出口克制（不带任何本项目凭据，请求走 sidecar 的全局 fetch，代理照常生效）。
 * 8 秒超时、单响应 512 KiB 上限、不跟随跳转。
 */
import {
  decodeKugouLyrics,
  kugouCandidates,
  kugouCandidatesById,
  kugouDownloadUrl,
  kugouLyricSearchUrl,
  kugouSearchUrl,
  lrclibCandidates,
  lrclibSearchUrl,
  pickCandidate,
} from "./lyrics-provider.mjs";
import { LYRICS_TEXT_MAX_BYTES, sanitizeLyricsDoc } from "./lyrics-store.mjs";

/** 只报"这是什么客户端"：**不带任何凭据/账号信息**（见文件头边界 3）。 */
export const LYRICS_FALLBACK_USER_AGENT = "HuaweiMusicDesktop/0.0.1 (unofficial study client)";

/** 回退请求的超时（8 秒）。 */
export const LYRICS_FALLBACK_TIMEOUT_MS = 8_000;

/**
 * 造第三方歌词回退器。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 注入 fetch（测试）；默认全局 fetch（**代理设置因此生效**）
 * @param {number} [options.timeoutMs] 单请求超时
 * @param {Function} [options.log] 只记结论的日志口（**不记歌词内容、不记请求 URL 的查询串**）
 * @returns {(query: {title?: string, artist?: string, durationSeconds?: number}) => Promise<object|null>}
 */
export function createThirdPartyLyrics({
  fetchImpl = globalThis.fetch,
  timeoutMs = LYRICS_FALLBACK_TIMEOUT_MS,
  log = () => undefined,
} = {}) {
  const maxBytes = LYRICS_TEXT_MAX_BYTES;

  /**
   * 读一个 JSON 响应；任何问题一律回 null（超时、非 2xx、坏 JSON、过大），每条失败路径留一行结论级日志。
   * 日志不带凭据、响应体与查询串，只带服务名与结论（状态码 / 阶段）。
   */
  async function readJson(service, url, headers = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json,text/plain,*/*", "user-agent": LYRICS_FALLBACK_USER_AGENT, ...headers },
      });
    } catch {
      log(`第三方歌词（${service}）请求未完成：超时或网络不通`);
      return null;
    }
    if (!response || typeof response.ok !== "boolean") {
      log(`第三方歌词（${service}）响应形状不对：拿到的不是 fetch 响应`);
      return null;
    }
    if (!response.ok) {
      const status = Number(response.status);
      log(`第三方歌词（${service}）请求被拒：HTTP ${Number.isFinite(status) ? status : "未知状态码"}`);
      await response.body?.cancel?.().catch?.(() => undefined);
      return null;
    }
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      log(`第三方歌词（${service}）响应过大：声明 ${declared} 字节，超过上限 ${maxBytes}`);
      await response.body?.cancel?.().catch?.(() => undefined);
      return null;
    }
    let text;
    try {
      text = await response.text();
    } catch {
      log(`第三方歌词（${service}）响应体读取失败`);
      return null;
    }
    if (typeof text !== "string") {
      log(`第三方歌词（${service}）响应体不是文本`);
      return null;
    }
    if (text.length > maxBytes) {
      log(`第三方歌词（${service}）响应体过大：实读超过上限 ${maxBytes}`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      log(`第三方歌词（${service}）响应不是 JSON`);
      return null;
    }
  }

  /** 一次候选 → 文档（不满足"真有歌词行"就回 null，与落盘同一条判据）。 */
  function docOf(text, source, match) {
    if (typeof text !== "string") return null;
    return sanitizeLyricsDoc({
      text,
      format: "lrc",
      source,
      matchedTitle: match?.title,
      matchedArtist: Array.isArray(match?.artists) ? match.artists.join(" / ") : undefined,
    });
  }

  /**
   * 酷狗：搜索 → （按哈希）问歌词索引 → 下载 → base64 解码。
   * 哈希已锁定录音，所以严格匹配优先，匹配不上才退到索引里的第一个条目。
   */
  async function fromKugou(query) {
    const headers = { referer: "https://www.kugou.com/" };
    const search = await readJson("kugou", kugouSearchUrl(query), headers);
    const match = pickCandidate(kugouCandidates(search), query);
    if (!match?.hash) return null;
    const index = await readJson("kugou", kugouLyricSearchUrl(match.hash), headers);
    const lyrics = kugouCandidatesById(index);
    const picked = pickCandidate(lyrics, query) ?? lyrics[0];
    if (!picked) return null;
    const downloaded = await readJson("kugou", kugouDownloadUrl(picked.id, picked.accesskey), headers);
    const text = decodeKugouLyrics(downloaded);
    if (!text) return null;
    return docOf(text, "kugou", match);
  }

  /**
   * lrclib：搜索 → 严格匹配 → 取**同步**歌词。
   * 只走 `syncedLyrics`：`plainLyrics` 必然被判空，候选那一层就丢掉了。
   */
  async function fromLrclib(query) {
    const search = await readJson("lrclib", lrclibSearchUrl(query));
    const match = pickCandidate(lrclibCandidates(search), query);
    if (!match) return null;
    const text = match.syncedLyrics;
    if (!text) return null;
    return docOf(text, "lrclib", match);
  }

  /**
   * 依次试每个公开歌词库；**任何一个失败都静默落到下一个**，全不行就回 null。
   *
   * 没有标题就不试：第三方库全靠关键字搜索，没有标题等于盲搜，那种"命中"没有意义。
   */
  return async function thirdPartyLyrics(query) {
    const title = typeof query?.title === "string" ? query.title.trim() : "";
    if (title === "") return null;
    const wanted = {
      title,
      artist: typeof query?.artist === "string" ? query.artist.trim() : "",
      durationSeconds: Number(query?.durationSeconds),
    };
    for (const [name, provider] of [
      ["kugou", fromKugou],
      ["lrclib", fromLrclib],
    ]) {
      try {
        const doc = await provider(wanted);
        if (doc !== null) return doc;
      } catch (cause) {
        // 一个歌词服务挂了绝不能打断播放（也不缓存这次失败）
        log(`第三方歌词回退 ${name} 失败（继续试下一个）：${cause?.message ?? cause}`);
      }
    }
    return null;
  };
}
