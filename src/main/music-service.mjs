/**
 * 音乐业务的装配：默认端点表 + 会话注入。
 * 默认值来自协议层的 `MUSIC_ENDPOINT_PATHS`（本模块只拼业务域）；设置文档 `data.musicEndpoints`
 * 可逐键覆盖，值写 `null` 表示显式关闭该键，陌生键与空串丢弃。
 * 会话形如 `{token, snsUserID}`：前者进 Digest 头、后者当 `targetSnsUserID`，令牌不进日志与错误消息。
 */
import { randomBytes } from "node:crypto";

import { buildMusicDigestHeader, digestCreatedAt } from "./music-session.mjs";
import { MUSIC_ENDPOINT_KEYS, MUSIC_ENDPOINT_PATHS, createMusicApi } from "../protocols/music.mjs";

/** 设置文档里的端点注入键（`data.musicEndpoints`）。 */
export const MUSIC_ENDPOINTS_SETTING_KEY = "musicEndpoints";

// 业务域（实测值；协议层只认路径，绝对 URL 在这里拼）。
export const MUSIC_BASE_ENDPOINT = "https://api-drcn.music.dbankcloud.cn";

// 默认端点表：业务域 + 实测路径（没有路径的键如 `lyrics` 不进这张表）。
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

/** 音乐会话 → `{token, snsUserID}`：会话可传对象或函数，这里是两套命名唯一的翻译点。 */
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
 * @param {object} options
 * @param {object} [options.settingsData] 设置文档的 `data`（端点覆盖/关闭的来源）
 * @param {Function} [options.fetchImpl] 注入 fetch（测试）
 * @param {object|Function} [options.session] 音乐会话：`{token, snsUserID}`
 * @param {Function} [options.sessionHeaders] 覆盖默认的会话头构造（测试/特殊网关）
 * @param {number} [options.pageSize] 默认页大小
 * @param {Function} [options.random] 注入随机源（Digest nonce）
 * @param {Function} [options.now] 注入时钟（Digest created）
 * @param {object} [options.lyricsCache] 歌词磁盘缓存端口
 * @param {Function} [options.lyricsFallback] 第三方歌词回退
 */
export function createMusicService({
  settingsData,
  fetchImpl,
  session = null,
  sessionHeaders,
  pageSize,
  random = randomBytes,
  now = () => new Date(),
  log,
  lyricsCache,
  lyricsFallback,
} = {}) {
  const { endpoints, disabled } = resolveMusicEndpoints(settingsData);

  /**
   * 默认会话头 `Authorization: Digest username=app-music-baseline, nonce=…, created=…`（有会话时追加 `token=`）。
   * nonce/created 每请求新生成、禁止复用旧抓包头；无 token 的调用也带这个基线头。
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
    // 诊断口：只记键名；协议层不写日志，装配处不给就没有输出。
    ...(typeof log === "function" ? { log } : {}),
    // 歌词的磁盘缓存与第三方回退（都是可选端口：不给就是默认行为）。
    ...(lyricsCache === undefined || lyricsCache === null ? {} : { lyricsCache }),
    ...(typeof lyricsFallback === "function" ? { lyricsFallback } : {}),
  });
  return { api, endpoints, disabled, configured: Object.keys(endpoints).length > 0 };
}
