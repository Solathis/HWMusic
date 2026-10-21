/**
 * 第三方歌词**回退**（R41；移植自参考实现 `.tmp/reference-repo/src/main/lyrics-fallback.ts`）。
 *
 * ## 什么时候会用到这里
 *
 * 华为那条链四档全部取不到歌词、**且曲目有标题**时（见 `src/protocols/music.mjs` 的 `getLyrics`）。
 * 华为侧对相当一部分曲目确实没有词，而"没有词"与"这首歌本来就没词"是两件事——
 * 这是**再试一个来源**，不是"编一份歌词出来"。
 *
 * ## 三条硬边界
 *
 * 1. **失败静默**：任何一个第三方服务的超时/5xx/坏 JSON 都不抛、不打断播放、**不缓存**
 *    （缓存一份"这次没有"就等于把这个来源永久关掉，见 `src/main/lyrics-cache.mjs` 纪律 4）。
 *    "静默"指**不打扰用户**（没有弹窗、没有播放中断）：每条失败路径仍在运行日志里留一行
 *    结论级的话（服务名 + 阶段，R41a 补上），否则真机上没人说得清"为什么没取到词"。
 * 2. **匹配严格**：候选必须过 `lyrics-provider.mjs` 的严格匹配器（标题 + 艺人 + 时长），
 *    宁可回 null 也不显示一首别的歌的词。
 * 3. **出口克制**：`user-agent` 只报"这是什么客户端"，**不带任何本项目凭据**（没有令牌、
 *    没有账号标识、没有会话头）；请求走 **sidecar 的全局 fetch**，所以设置里的代理照常生效。
 *
 * ## 出口域是新的（要说不清楚的那件事）
 *
 * `songsearch.kugou.com` / `krcs.kugou.com` / `lyrics.kugou.com` / `lrclib.net` 是**第三方公开
 * 歌词库**，不是华为 CDN。这里**不需要动任何白名单**，理由是查过的：
 * - sidecar 侧的出口**没有域名白名单**（`src/main/proxy.mjs` 只管代理与例外列表）；
 * - `tauri.conf.json` 的 CSP `connect-src` 只约束**渲染层**的 fetch，而这两个请求都发生在
 *   sidecar 进程里，歌词文本经 IPC 回来——渲染层一次网络请求都不发（与 `playback:lyrics` 同路）；
 * - 媒体白名单（`safe-media-url.mjs`）管的是 `<audio>`/`<img>` 能加载哪些域，与这里无关。
 *
 * ## 超时与体积
 *
 * 8 秒超时（蓝本同值：歌词回退是"顺带试一下"，不该让取词拖到华为接口那样的 25 秒）、
 * 单响应 512 KiB 上限（`content-length` 声明与实读各查一次）、不跟随跳转。
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
   * 读一个 JSON 响应；**任何问题一律回 null**（超时、非 2xx、坏 JSON、过大）。
   *
   * 每条失败路径各留**一行结论级**日志（R41a）：以前这里全是 `catch { return null }`，
   * 真机上"第三方歌词为什么没取到"只能靠猜（服务挂了？接口改了？被墙了？）。日志里
   * **不带凭据、不带响应体、不带请求 URL 的查询串**——只带服务名与结论（状态码/阶段），
   * 那正是排障要的那个信息，而别的都属于"不该进日志的东西"。
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
   *
   * 索引那一步的挑选按蓝本那条注释办：**哈希已经锁定了录音**，所以即使索引里的标题带着
   * `(Live)`/`(remaster)` 之类的后缀、过不了严格匹配，第一个条目仍然是同一首歌——
   * 严格匹配优先，匹配不上才退到第一个（这是唯一一处"不严格"，理由是哈希）。
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
   *
   * 只有 `syncedLyrics` 一条路：`plainLyrics`（没有时间戳的纯文本）**暂不支持**——
   * 落盘判据要求"至少一行带时间戳"，纯文本必然被判空（见 `lrclibCandidates` 的说明），
   * 所以候选那一层就把它丢掉了，这里也就不必再退。
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
