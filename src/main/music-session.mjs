/**
 * 音乐会话兑换（旧仓称 `loginex`）：账号 AT → 音乐会话凭据。
 * 端点与请求形状来自公开契约，端点存在性本机实测；兑换成功仍未实测。
 * 纪律：凭据不进日志/错误，端点由调用方注入。
 */
import { randomBytes } from "node:crypto";

import { err, ok } from "../shared/result.ts";
import { isSafeMediaUrl } from "../protocols/safe-media-url.mjs";
import { normalizeVipExpiry } from "../shared/vip-expiry.mjs";

/** 音乐业务域（公开契约 §1"业务域"）。 */
export const HUAWEI_MUSIC_BASE = "https://api-drcn.music.dbankcloud.cn";

/** 音乐会话兑换路径（公开契约 §2.3）。 */
export const HUAWEI_MUSIC_LOGINEX_PATH = "/music-odpapp-service/v5/service/userinfo/loginex";

/** 音乐会话兑换端点（拼好的绝对 URL；也是 `auth-manager` 的默认值来源）。 */
export const HUAWEI_MUSIC_LOGINEX_ENDPOINT = `${HUAWEI_MUSIC_BASE}${HUAWEI_MUSIC_LOGINEX_PATH}`;

/**
 * Digest 头的 `username`：公开契约 §1"音乐会话请求头"里那个固定值。
 *
 * 它不是凭据（是服务端认的"应用基线"标识），但仍然只在请求头里出现、不进日志。
 */
export const MUSIC_SESSION_DIGEST_USERNAME = "app-music-baseline";

/** 业务成功码（公开契约 §1："业务成功通常要求 HTTP 成功且 `result.resultCode === "000000"`"）。 */
export const MUSIC_BUSINESS_OK = "000000";

/** 本模块的错误类别（与 `protocols/auth.mjs` 同名同义，避免跨层 import 造成的环）。 */
export const MUSIC_SESSION_ERROR_KINDS = {
  missingEndpoint: "missing_endpoint",
  missingParam: "missing_param",
  networkError: "network_error",
  httpError: "http_error",
  invalidResponse: "invalid_response",
  /** HTTP 通了但业务码不是 000000（带服务端 resultCode，不含任何凭据） */
  businessError: "loginex_failed",
};

/** 请求超时（与公开契约"只读调用 timeout=25 秒"同量级）。 */
export const MUSIC_SESSION_TIMEOUT_MS = 25_000;

/**
 * 构造 `Authorization: Digest …` 头。
 * `created` 必须是无毫秒的 UTC ISO8601，`nonce` 每请求随机。
 * @param {{nonce: string, created: string, token?: string|null}} params
 */
export function buildMusicDigestHeader({ nonce, created, token = null }) {
  if (typeof nonce !== "string" || nonce.trim() === "") throw new TypeError("Digest nonce 不能为空");
  if (typeof created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)) {
    throw new TypeError("Digest created 必须是「无毫秒的 UTC ISO8601」（YYYY-MM-DDTHH:MM:SSZ）");
  }
  // 头注入防护：token 里出现换行或逗号就能往头里塞第二段。
  if (token !== null && /[\r\n,]/.test(String(token))) throw new TypeError("音乐会话令牌格式无效");
  const suffix = token === null ? "" : `, token=${token}`;
  return `Digest username=${MUSIC_SESSION_DIGEST_USERNAME}, nonce=${nonce}, created=${created}${suffix}`;
}

/** `Date` → 无毫秒的 UTC ISO8601（契约要的那个形状）。 */
export function digestCreatedAt(now = new Date()) {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 非空字符串（去首尾空白）；其余一律 null。 */
function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * profile（名字/头像/VIP）的候选键，防御式取键，取到才存。
 * 会员只认有证据的数值规则，认不出的值一律不存，宁可显示兜底。
 */
export const MUSIC_PROFILE_NAME_KEYS = ["userName", "nickName", "nickname"];
export const MUSIC_PROFILE_AVATAR_KEYS = ["headUrl", "headImage", "avatarUrl", "avatar", "head"];
/** 明确的布尔/0-1 标志位（`true`/`1`/`"1"`/`"true"` → 会员）。 */
export const MUSIC_PROFILE_VIP_FLAG_KEYS = ["vipFlag", "isVip", "memberFlag", "vip"];
/** 会员类别字段（有证据：`memberShip`，官方 H5 把含 6 的值当会员类别）。 */
export const MUSIC_PROFILE_MEMBER_KEYS = ["memberShip"];
export const MUSIC_PROFILE_MEMBER_MARK = "6";
/** profile 可能挂在这些容器下（候选容器；都取不到就看顶层）。 */
export const MUSIC_PROFILE_CONTAINER_KEYS = ["data", "userInfo", "userInfoEx"];
/**
 * `loginex` 响应里两个有名字的容器：`queryAllSubInfoResp` / `queryAppConfigDetailResp`。
 * 对它们做一层读取并把键名记进日志，属于防御式接线而非证据。
 */
export const MUSIC_PROFILE_NESTED_CONTAINER_KEYS = ["queryAllSubInfoResp", "queryAppConfigDetailResp"];
/**
 * id_token claims 里的名字/头像候选，只认这四个键。
 * 没有证据的键不猜：猜错就会显示错人。
 */
export const MUSIC_PROFILE_CLAIM_NAME_KEYS = ["name", "nickname"];
export const MUSIC_PROFILE_CLAIM_AVATAR_KEYS = ["picture", "avatar"];
/** 键名日志里每个容器最多报多少个子容器（防止一整棵配置树把日志刷满）。 */
export const MUSIC_PROFILE_NESTED_LOG_LIMIT = 8;
/** 名字的显示上限（字段长度未知；截断只为不让界面被撑破）。 */
export const MUSIC_PROFILE_NAME_MAX = 40;

/** 明确的布尔（`true`/`1`/`"1"`/`"true"` → true；`false`/`0`/`"0"`/`"false"` → false；其余 null）。 */
function flagOf(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "1" || text === "true") return true;
    if (text === "0" || text === "false") return false;
  }
  return null;
}

/** profile 的候选容器：响应本体在前，其次是那几个可能的容器（都是对象才算）。 */
function profileContainersOf(payload) {
  const containers = [payload];
  for (const key of MUSIC_PROFILE_CONTAINER_KEYS) {
    const nested = payload[key];
    if (isObject(nested)) containers.push(nested);
  }
  // 两个有名字的容器再做一层（容器自己 + 一层子对象 + 一层数组元素）
  for (const key of MUSIC_PROFILE_NESTED_CONTAINER_KEYS) {
    const container = payload[key];
    if (!isObject(container)) continue;
    containers.push(container);
    for (const value of Object.values(container)) {
      if (isObject(value)) containers.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) if (isObject(item)) containers.push(item);
      }
    }
  }
  return containers;
}

/**
 * 两个容器的**一层嵌套键名**诊断。
 * 只报键名不报值，数组元素里的键名也记一行。
 * @param {unknown} payload loginex 响应
 * @returns {string[]} 每个容器/子容器一行
 */
export function nestedContainerKeyNamesOf(payload) {
  if (!isObject(payload)) return [];
  const lines = [];
  for (const key of MUSIC_PROFILE_NESTED_CONTAINER_KEYS) {
    const container = payload[key];
    if (!isObject(container)) continue;
    lines.push(`${key}: ${Object.keys(container).sort().join(", ")}`);
    let shown = 0;
    for (const [childKey, value] of Object.entries(container)) {
      // 数组：只看首个对象元素（与读取侧"一层数组里的对象元素"同一口径；空数组/纯标量数组跳过）
      const element = Array.isArray(value) ? value.find((item) => isObject(item)) : value;
      if (!isObject(element)) continue;
      if (shown >= MUSIC_PROFILE_NESTED_LOG_LIMIT) break;
      shown += 1;
      const label = Array.isArray(value) ? `${key}.${childKey}[0]` : `${key}.${childKey}`;
      lines.push(`${label}: ${Object.keys(element).sort().join(", ")}`);
    }
  }
  return lines;
}

/**
 * 从响应里抠 profile（取到才存）。
 * @param {object} payload loginex 响应
 * @param {{isSafeUrl?: (url: string) => boolean}} [options] 头像 URL 的白名单校验（默认 `isSafeMediaUrl`）
 * @returns {{userName?: string, avatarUrl?: string, vip?: boolean}} 可能为空对象（= 认不出任何一项）
 */
export function profileFromResponse(payload, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  const profile = {};
  if (!isObject(payload)) return profile;

  for (const container of profileContainersOf(payload)) {
    if (profile.userName === undefined) {
      for (const key of MUSIC_PROFILE_NAME_KEYS) {
        const name = textOf(container[key]);
        if (name !== null) {
          profile.userName = name.slice(0, MUSIC_PROFILE_NAME_MAX);
          break;
        }
      }
    }
    if (profile.avatarUrl === undefined) {
      for (const key of MUSIC_PROFILE_AVATAR_KEYS) {
        const value = textOf(container[key]);
        // 头像要过媒体白名单：渲染层只认 CSP `img-src` 里那些域，白名单外的地址画不出来
        if (value !== null && isSafeUrl(value)) {
          profile.avatarUrl = value;
          break;
        }
      }
    }
    if (profile.vip === undefined) {
      for (const key of MUSIC_PROFILE_VIP_FLAG_KEYS) {
        const flag = flagOf(container[key]);
        if (flag === true) {
          profile.vip = true;
          break;
        }
      }
      if (profile.vip === undefined) {
        for (const key of MUSIC_PROFILE_MEMBER_KEYS) {
          const raw = container[key];
          if (raw === undefined || raw === null || raw === "") continue;
          const text = String(raw).trim();
          // 只认有证据的那条规则（含 6 = 会员类别）；0 是"明确不是"，其余数值认不出就不显示
          if (text.includes(MUSIC_PROFILE_MEMBER_MARK)) profile.vip = true;
          else if (Number(text) === 0) profile.vip = false;
          break;
        }
      }
    }
  }

  // 明确的"不是会员"不进载荷（界面只在为真时才显示徽标，缺省与 false 是同一件事）
  if (profile.vip === false) delete profile.vip;
  return profile;
}

/** profile 是否有可展示的内容（空对象 = 什么都没认出来）。 */
export function hasProfileContent(profile) {
  return isObject(profile) && (profile.userName !== undefined || profile.avatarUrl !== undefined || profile.vip === true);
}

/**
 * id_token 的 claims → profile（取到才存，与 `profileFromResponse` 同一份纪律）。
 * 只取名字与头像，头像需过媒体白名单；VIP 不从 claims 取。
 * @param {unknown} claims `idTokenClaimsOf` 的产物
 * @param {{isSafeUrl?: (url: string) => boolean}} [options]
 * @returns {{userName?: string, avatarUrl?: string}} 可能为空对象
 */
export function profileFromClaims(claims, options = {}) {
  const isSafeUrl = options.isSafeUrl ?? isSafeMediaUrl;
  const profile = {};
  if (!isObject(claims)) return profile;

  for (const key of MUSIC_PROFILE_CLAIM_NAME_KEYS) {
    const name = textOf(claims[key]);
    if (name !== null) {
      profile.userName = name.slice(0, MUSIC_PROFILE_NAME_MAX);
      break;
    }
  }
  for (const key of MUSIC_PROFILE_CLAIM_AVATAR_KEYS) {
    const value = textOf(claims[key]);
    if (value !== null && isSafeUrl(value)) {
      profile.avatarUrl = value;
      break;
    }
  }
  return profile;
}

/**
 * 合并两份 profile：前者优先，后者只补空缺。
 * 业务域数据比 OIDC claims 更贴近「这个应用里显示谁」。
 */
export function mergeProfiles(primary, fallback) {
  const base = isObject(primary) ? primary : {};
  const extra = isObject(fallback) ? fallback : {};
  const merged = { ...base };
  if (merged.userName === undefined && extra.userName !== undefined) merged.userName = extra.userName;
  if (merged.avatarUrl === undefined && extra.avatarUrl !== undefined) merged.avatarUrl = extra.avatarUrl;
  if (merged.vip === undefined && extra.vip === true) merged.vip = true;
  return merged;
}

/**
 * 把 id_token claims 里认出的 profile 补进会话记录。
 * 只补空缺、只多一个 `profile` 键；claims 原文不落盘，认不出就返回原对象。
 * @param {unknown} record `parseMusicSessionResponse` 的产物
 * @param {unknown} claims id_token 的 claims（null 就是没有）
 * @param {{isSafeUrl?: (url: string) => boolean}} [options]
 * @returns {unknown} 合并后的记录（没有可补的就是原对象）
 */
export function attachClaimProfile(record, claims, options = {}) {
  if (!isObject(record)) return record;
  const fromClaims = profileFromClaims(claims, options);
  if (!hasProfileContent(fromClaims)) return record;
  const merged = mergeProfiles(record.profile, fromClaims);
  return { ...record, profile: merged };
}

/**
 * 会话记录里的 profile → `auth:status` 载荷里的可选 profile。
 * 只搬名字/头像/VIP 三个键，旧记录没有这一格则返回 null，不造假数据。
 */
export function profileOfSessionRecord(value) {
  if (!isObject(value)) return null;
  const raw = value.profile;
  if (!isObject(raw)) return null;
  const profile = {};
  const userName = textOf(raw.userName);
  if (userName !== null) profile.userName = userName.slice(0, MUSIC_PROFILE_NAME_MAX);
  const avatarUrl = textOf(raw.avatarUrl);
  if (avatarUrl !== null) profile.avatarUrl = avatarUrl;
  if (raw.vip === true) profile.vip = true;
  // 到期日是本项目自己的字段，只搬认得出那一天的值
  const vipExpiresOn = normalizeVipExpiry(raw.vipExpiresOn);
  if (vipExpiresOn !== null) profile.vipExpiresOn = vipExpiresOn;
  return Object.keys(profile).length === 0 ? null : profile;
}

/** 响应体顶层键名（**只记键名，绝不记值**；诊断用）。 */
export function topLevelKeysOf(payload, limit = 40) {
  if (!isObject(payload)) return [];
  return Object.keys(payload).sort().slice(0, Math.max(1, limit));
}

/**
 * loginex 响应 → 本项目的会话形状（token / userId / expireTime / profile）。
 * 保留 14 位原始串（整数也转成串），到期时刻由 `musicSessionExpiresAt` 在读取时按北京时间换算。
 */
export function parseMusicSessionResponse(payload, options = {}) {
  if (payload === null || typeof payload !== "object") {
    return err("音乐会话兑换响应不是 JSON 对象", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }
  const resultCode = payload?.result?.resultCode;
  if (typeof resultCode !== "string") {
    return err("音乐会话兑换响应缺少 result.resultCode（形状与契约不符）", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }
  if (resultCode !== MUSIC_BUSINESS_OK) {
    // 只带业务码：服务端 resultMessage 可能回显请求内容，不进错误（错误会进日志与界面）
    return err(`音乐会话兑换被服务端拒绝（业务码 ${resultCode.slice(0, 16)}）`, MUSIC_SESSION_ERROR_KINDS.businessError);
  }

  const token = payload.token;
  if (typeof token !== "string" || token.trim() === "") {
    return err("音乐会话兑换响应里没有 token", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }

  const snsUserID = payload.snsUserID;
  const expireTime = Number.isSafeInteger(payload.expireTime) ? String(payload.expireTime) : payload.expireTime;
  const profile = profileFromResponse(payload, options);
  return ok({
    musicSession: token,
    ...(typeof snsUserID === "string" && snsUserID.trim() !== "" ? { userId: snsUserID } : {}),
    ...(typeof expireTime === "string" && expireTime.trim() !== "" ? { expireTime } : {}),
    ...(hasProfileContent(profile) ? { profile } : {}),
  });
}

/** `expireTime` 按北京时间（UTC+8）解读：华为中国区服务，实测到期时刻与此吻合，官方未确认。 */
export const MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES = 480;

/**
 * 会话记录的到期时刻（UTC 毫秒）；没有 `expireTime` 或认不出就是 null，不猜。
 * @param {unknown} record
 * @returns {number | null}
 */
export function musicSessionExpiresAt(record) {
  const raw = isObject(record) ? record.expireTime : undefined;
  const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d{14}$/.test(text)) return null;
  const part = (start, length) => Number(text.slice(start, start + length));
  const [year, month, day, hour, minute, second] = [part(0, 4), part(4, 2), part(6, 2), part(8, 2), part(10, 2), part(12, 2)];
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (year < 2000 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null;
  return wall - MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES * 60_000;
}

/**
 * 到期后给用户看的那句话（北京时间的月日时分）。
 * @param {number} expiresAt UTC 毫秒
 * @returns {string}
 */
export function musicSessionExpiredText(expiresAt) {
  const wall = new Date(expiresAt + MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES * 60_000);
  const pad = (value) => String(value).padStart(2, "0");
  return `音乐会话已于 ${wall.getUTCMonth() + 1}月${wall.getUTCDate()}日 ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())} 到期，请重新扫码登录。`;
}

/**
 * 诊断日志里的那一行：`expireTime` 原文、北京时间的到期时刻、还剩或已过多久；不含令牌。
 * @param {unknown} record
 * @param {number} nowMs
 * @returns {string}
 */
export function sessionExpiryLine(record, nowMs) {
  const raw = isObject(record) ? record.expireTime : undefined;
  if (raw === undefined || raw === null || raw === "") return "会话到期：会话记录里没有 expireTime，无法按到期时刻判断";
  const expiresAt = musicSessionExpiresAt(record);
  if (expiresAt === null) return `会话到期：expireTime=${String(raw).slice(0, 20)} 认不出（不是 14 位 yyyyMMddHHmmss），不按它判断`;
  const wall = new Date(expiresAt + MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 16).replace("T", " ");
  const hours = (Math.abs(nowMs - expiresAt) / 3_600_000).toFixed(1);
  const distance = nowMs >= expiresAt ? `已过 ${hours} 小时` : `还剩 ${hours} 小时`;
  return `会话到期：expireTime=${raw}（按北京时间 ${wall}），${distance}`;
}

/**
 * 造一个真发请求的音乐会话端口（`auth-manager` 的 `exchangeMusicSession` 插座）。
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 注入 fetch（默认全局 fetch）
 * @param {Function} [options.random] 注入随机源（默认 node:crypto）
 * @param {Function} [options.now] 注入时钟（默认 `() => new Date()`）
 * @param {number} [options.timeoutMs] 单次请求超时
 * @param {Function} [options.log] 只记**键名**的诊断口（默认不记）
 * @param {Function} [options.isSafeUrl] 头像 URL 的白名单校验（默认 `isSafeMediaUrl`）
 * @returns {(params: {accessToken: string, endpoint: string}) => Promise<import("../shared/result.ts").CoreResult<unknown>>}
 */
export function createHuaweiMusicSessionPort({
  fetchImpl = globalThis.fetch,
  random = randomBytes,
  now = () => new Date(),
  timeoutMs = MUSIC_SESSION_TIMEOUT_MS,
  log = () => undefined,
  isSafeUrl = isSafeMediaUrl,
} = {}) {
  return async function exchangeMusicSession({ accessToken, endpoint } = {}) {
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      return err(
        "音乐会话兑换端点未确定：调用方必须在发请求之前收口（本模块不猜 URL、不发请求）",
        MUSIC_SESSION_ERROR_KINDS.missingEndpoint,
      );
    }
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return err("账号访问令牌为空，无法兑换音乐会话", MUSIC_SESSION_ERROR_KINDS.missingParam);
    }

    let headers;
    try {
      headers = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: buildMusicDigestHeader({
          nonce: random(24).toString("base64url"),
          created: digestCreatedAt(now()),
        }),
      };
    } catch (cause) {
      return err(`音乐会话请求头构造失败：${messageOf(cause)}`, MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }

    let response;
    try {
      response = await fetchImpl(endpoint.trim(), {
        method: "POST",
        headers,
        body: JSON.stringify({ accessToken }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      return err(`请求音乐会话端点失败：${messageOf(cause)}`, MUSIC_SESSION_ERROR_KINDS.networkError);
    }

    if (!response || typeof response.ok !== "boolean") {
      return err("音乐会话端点未返回可识别的响应", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }
    if (!response.ok) {
      return err(`音乐会话端点返回 HTTP ${response.status}`, MUSIC_SESSION_ERROR_KINDS.httpError);
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return err("音乐会话端点响应不是 JSON", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }
    // 只记键名（不记任何值）：下一次真机登录就能看出 profile 到底叫什么名字。
    log(`loginex 响应顶层键名（只记键名，不记值）：${topLevelKeysOf(payload).join(", ")}`);
    // 顶层已证实没有名字/头像，所以再看一层容器键名；同样只记键名不记值。
    for (const line of nestedContainerKeyNamesOf(payload)) {
      log(`loginex 容器一层键名（只记键名，不记值）：${line}`);
    }
    return parseMusicSessionResponse(payload, { isSafeUrl });
  };
}
