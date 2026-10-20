/**
 * 音乐业务的装配：**默认端点表（参考实测值）+ 会话注入**（R32 换血）。
 *
 * ## 端点：默认值不再是"空表"
 *
 * R8 时这张表是空的（业务端点全部待确认），于是每个 `library:*` 请求都由协议层如实回
 * `endpoint_unknown`，UI 显示"接口尚未配置"。**这是 R4 遗留的诚实落点，但一条业务链都不通**。
 *
 * R32 起默认值 = 公开参考实现 `talongao/huawei-music-desktop` 的实测端点（业务域 + 路径），
 * 逐键来自 `src/protocols/music.mjs` 的 `MUSIC_ENDPOINT_PATHS`：
 *
 * | 键 | 端点 |
 * |---|---|
 * | `favorites` / `playlistList` | `POST /music-userbehavior-service/v3/service/favorite/simple/all` |
 * | `playlistDetail` | `GET /music-userbehavior-service/v1/service/playlist/detail/all` |
 * | `playlistDetailPublic` | `POST /music-operation-service/v2/service/musiclist/detail/bymusiclistid` |
 * | `playlistDelete` | `POST /music-userbehavior-service/v1/service/playlist/delete` |
 * | `search` | `POST /music-search-service/v10/service/fuzzysearch` |
 * | `album` | `GET /music-metacontent-service/v1/service/album/detail/byalbumcode` |
 * | `artist` | `POST /music-metacontent-service/v2/service/artist/detail/byartistcode` |
 * | `history` | `GET /music-userbehavior-service/v1/service/recentlyplayed/query` |
 * | `playback` | `POST /music-play-service/v3/service/file/bycontentcode` |
 *
 * 逐字路径见协议层的 `MUSIC_ENDPOINT_PATHS`（那边是唯一真源，这里只负责拼业务域）。
 *
 * ## 覆盖与关闭（设置文档 `data.musicEndpoints`）
 *
 * - 键值是非空字符串 → 覆盖该键的端点（联调发现域名变化时**不用改代码**）；
 * - 键值是 `null` → **显式关闭**该键（离线/排障/测试要一个"确定性不可用"的状态，
 *   与 `auth-manager` 的 `endpoints.loginex = null` 同一套语义）；
 * - 陌生键、空串一律丢弃（多收了会让人以为某个接口能用）。
 *
 * ## 会话：凭据只在主进程里流动
 *
 * `session` 传进来（可以是对象，也可以是**函数**——顶层装配时它多半还是 null，登录在之后才发生），
 * 形如 `{token, snsUserID}`：
 * - `snsUserID` → 收藏/歌单发现的 `targetSnsUserID`（缺它这两个接口没法发）；
 * - `token` → `Authorization: Digest …`（请求头里带 `token=` 段），由本模块按 R17 已实测的
 *   Digest 形状构造。**令牌不进日志、不进错误消息**：这里只把它交给头构造器。
 *
 * `lyrics` 键默认**没有**端点：参考实现里歌词从播放响应推导（见协议层的 `getLyrics`）；
 * 若将来真的出现独立歌词端点，在设置里注入即可。
 */
import { randomBytes } from "node:crypto";

import { buildMusicDigestHeader, digestCreatedAt } from "./music-session.mjs";
import { MUSIC_ENDPOINT_KEYS, MUSIC_ENDPOINT_PATHS, createMusicApi } from "../protocols/music.mjs";

/** 设置文档里的端点注入键（`data.musicEndpoints`）。 */
export const MUSIC_ENDPOINTS_SETTING_KEY = "musicEndpoints";

/** 业务域（参考实现实测；协议层只认路径，绝对 URL 在这里拼）。 */
export const MUSIC_BASE_ENDPOINT = "https://api-drcn.music.dbankcloud.cn";

/** 默认端点表：业务域 + 参考实测路径（没有路径的键——如 `lyrics`——不进这张表）。 */
export const MUSIC_ENDPOINT_DEFAULTS = Object.freeze(
  Object.fromEntries(
    MUSIC_ENDPOINT_KEYS.filter((key) => typeof MUSIC_ENDPOINT_PATHS[key] === "string").map((key) => [
      key,
      `${MUSIC_BASE_ENDPOINT}${MUSIC_ENDPOINT_PATHS[key]}`,
    ]),
  ),
);

/**
 * 从设置文档的 `data` 里收端点覆盖与关闭项。
 *
 * @returns {{overrides: Record<string, string>, disabled: string[]}}
 */
export function readMusicEndpoints(settingsData) {
  const source = settingsData !== null && typeof settingsData === "object" ? settingsData : {};
  const raw = source[MUSIC_ENDPOINTS_SETTING_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { overrides: {}, disabled: [] };
  const overrides = {};
  const disabled = [];
  for (const key of MUSIC_ENDPOINT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    // 显式 null = "这次不要这个端点"（与 auth-manager 的 loginex:null 同义）
    if (value === null) {
      disabled.push(key);
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") overrides[key] = value.trim();
  }
  return { overrides, disabled };
}

/** 默认值 + 设置覆盖 − 显式关闭 = 这次真正生效的端点表。 */
export function resolveMusicEndpoints(settingsData) {
  const { overrides, disabled } = readMusicEndpoints(settingsData);
  const endpoints = { ...MUSIC_ENDPOINT_DEFAULTS, ...overrides };
  for (const key of disabled) delete endpoints[key];
  return { endpoints, disabled };
}

/**
 * 音乐会话 → `{token, snsUserID}`（会话可以传对象或函数，两种都认）。
 *
 * 两个键名都认是有原因的：**存盘的会话是 loginex 的原样形状**
 * （`{musicSession, userId, expireTime}`，见 `music-session.mjs` 的
 * `parseMusicSessionResponse`），而协议层要的是 `{token, snsUserID}`
 * （参考实现的名字）。这段映射就是那唯一的翻译点——两边都不必知道对方怎么叫。
 */
function sessionOf(session) {
  const value = typeof session === "function" ? session() : session;
  if (value === null || typeof value !== "object") return null;
  const pick = (...names) => {
    for (const name of names) {
      const candidate = value[name];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
    return null;
  };
  const token = pick("token", "musicSession");
  const snsUserID = pick("snsUserID", "userId");
  return token === null && snsUserID === null ? null : { token, snsUserID };
}

/**
 * 造音乐服务。
 *
 * @param {object} options
 * @param {object} [options.settingsData] 设置文档的 `data`（端点覆盖/关闭的来源）
 * @param {Function} [options.fetchImpl]  注入 fetch（测试）
 * @param {object|Function} [options.session] 音乐会话：`{token, snsUserID}`（对象或函数）
 * @param {Function} [options.sessionHeaders] 覆盖默认的会话头构造（测试/特殊网关用）
 * @param {number} [options.pageSize]     默认页大小（协议层另有默认）
 * @param {Function} [options.random]     注入随机源（Digest nonce；测试用）
 * @param {Function} [options.now]        注入时钟（Digest created；测试用）
 */
export function createMusicService({
  settingsData,
  fetchImpl,
  session = null,
  sessionHeaders,
  pageSize,
  random = randomBytes,
  now = () => new Date(),
} = {}) {
  const { endpoints, disabled } = resolveMusicEndpoints(settingsData);

  /**
   * 默认会话头：`Authorization: Digest username=app-music-baseline, nonce=…, created=…`
   * （带音乐会话的业务调用才追加 `, token=<音乐 token>`）。
   *
   * 无 token 调用也带这个头（参考实现就是这么发的：Digest 是"应用基线"标识，不是凭据）；
   * **nonce 每请求新随机、created 每请求更新**——契约明确禁止复用抓包里的旧头信息。
   */
  const digestHeaders = ({ authenticated }) => {
    const current = sessionOf(session);
    const token = authenticated ? current?.token ?? null : null;
    return {
      authorization: buildMusicDigestHeader({
        nonce: random(24).toString("base64url"),
        created: digestCreatedAt(now()),
        token,
      }),
    };
  };

  const api = createMusicApi({
    endpoints,
    disabledEndpoints: disabled,
    session: () => sessionOf(session),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    sessionHeaders: sessionHeaders ?? digestHeaders,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return { api, endpoints, disabled, configured: Object.keys(endpoints).length > 0 };
}
