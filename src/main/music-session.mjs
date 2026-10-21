/**
 * 音乐会话兑换（旧仓称 `loginex`）：账号 AT → 音乐会话凭据。
 *
 * ## 这次凭什么敢写端点（R17）
 *
 * R4 起这条链的最后一环一直是**结构化「待联调」**，理由是"端点 URL、请求形状、Digest 细节
 * 均无公开证据"。R17 的 bundle/公开源挖掘把三件事都找到了，并且**本机实测**了其中能实测的部分：
 *
 * 1. **端点与请求形状**：来自公开仓库 `talongao/huawei-music-desktop` 的
 *    `docs/API_CONTRACT.md`（2026-10-14 的本人账号实验记录）与 `src/auth.mjs`：
 *    `POST /music-odpapp-service/v5/service/userinfo/loginex`，体 `{"accessToken":"<账号 AT>"}`，
 *    头 `Authorization: Digest username=app-music-baseline, nonce=<随机>, created=<UTC ISO8601 无毫秒>`
 *    （**不带** token 段）。业务成功 = HTTP 2xx 且 `result.resultCode === "000000"`。
 * 2. **端点存在性**：R17 本机无凭据实测（`.tmp/r17-loginex-live.mjs`，结果记在
 *    `docs/API_CONTRACT.md` §1.5）：业务域 `api-drcn.music.dbankcloud.cn` 可解析；
 *    `GET` 该路径 **405 Method Not Allowed**（路径存在、只收 POST），而同一域下一个故意写错的
 *    对照路径回 **404**；`POST` 一个无效 AT 回 **200 + `result.resultCode = "990000"`**
 *    （请求被业务受理并拒绝）。
 * 3. **没有实测的**（如实登记，见报告 untested 清单）：拿**有效** AT 换到真会话的往返
 *    （需要用户授权扫码 → 只有用户在场才可能）。所以本模块的"形状"来自公开证据，
 *    "端点存在"来自本机实测，**"兑换成功"仍然未实测**。
 *
 * ## 纪律
 *
 * - **凭据绝不进日志/错误**：`accessToken`、音乐 `token` 都不出现在 message 里；
 *   错误只带 HTTP 状态、业务码、以及一句人话。
 * - **端点仍由调用方注入**：默认值住在 `auth-manager.ts`（与 authorize/token 同一处），
 *   本模块只认参数里的 `endpoint`。`endpoint` 为空时由调用方在发请求**之前**收口
 *   （见 auth-manager 的 `LOGINEX_PENDING_MESSAGE` 分支）——本模块不发这种请求。
 */
import { randomBytes } from "node:crypto";

import { err, ok } from "../shared/result.ts";
import { isSafeMediaUrl } from "../protocols/safe-media-url.mjs";

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
 *
 * `created` 必须是 **UTC ISO8601 且不带毫秒**（公开契约明写；带毫秒服务端认不认未实测，
 * 所以按已证形状去掉毫秒）；`nonce` 每请求随机（契约："不要从日志或抓包中硬编码旧头信息"）。
 *
 * @param {{nonce: string, created: string, token?: string|null}} params
 */
export function buildMusicDigestHeader({ nonce, created, token = null }) {
  if (typeof nonce !== "string" || nonce.trim() === "") throw new TypeError("Digest nonce 不能为空");
  if (typeof created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)) {
    throw new TypeError("Digest created 必须是「无毫秒的 UTC ISO8601」（YYYY-MM-DDTHH:MM:SSZ）");
  }
  // 头注入防护：token 里出现换行/逗号就能往头里塞第二段（与旧仓 musicHeaders 同一条判据）
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
 * profile（名字/头像/VIP）的**候选键**（R38；防御式取键，取到才存）。
 *
 * 为什么是"候选 + 认不出就不显示"而不是写死三个字段名：`loginex` 端点的**响应形状没有实测
 * 证据**（公开契约只登记了 `token`/`snsUserID`/`expireTime` 三项，参考实现也只取 token）。
 * 唯一一条真机线索是参考仓库的功能验证里那句"本人资料接口返回 `memberShip=6`，H5 代码把含 6
 * 的值映射为会员类别"——所以会员标记只认 `memberShip` 这一个**有证据**的数值规则，
 * `vipLevel`/`vipType` 之类**没有枚举证据的数值字段不猜**（猜错会把非会员标成会员）。
 *
 * 名字/头像取到就用；类型不对、不在媒体白名单内、认不出的值一律**不存**——
 * 界面宁可显示兜底（头像占位 + "已登录"），也不显示一个编出来的名字。
 */
export const MUSIC_PROFILE_NAME_KEYS = ["userName", "nickName", "nickname"];
export const MUSIC_PROFILE_AVATAR_KEYS = ["headUrl", "headImage", "avatarUrl", "avatar", "head"];
/** 明确的布尔/0-1 标志位（`true`/`1`/`"1"`/`"true"` → 会员）。 */
export const MUSIC_PROFILE_VIP_FLAG_KEYS = ["vipFlag", "isVip", "memberFlag", "vip"];
/** 会员类别字段（实测证据：`memberShip`，官方 H5 把"含 6"的值当会员类别）。 */
export const MUSIC_PROFILE_MEMBER_KEYS = ["memberShip"];
export const MUSIC_PROFILE_MEMBER_MARK = "6";
/** profile 可能挂在这些容器下（候选容器；都取不到就看顶层）。 */
export const MUSIC_PROFILE_CONTAINER_KEYS = ["data", "userInfo", "userInfoEx"];
/**
 * R40：`loginex` 响应里两个**有名字的容器**（真机实证的顶层键名里就有它们，
 * 见 `.tmp/dev-visible.log` 15:52 那行）：`queryAllSubInfoResp` / `queryAppConfigDetailResp`。
 *
 * 顶层没有用户名/头像（R38 的候选键因此全扑空），账号资料最可能就在这两个容器**里面**
 * ——所以 R40 对它们做**一层**读取（容器自己、它的一层子对象、一层数组里的对象元素），
 * 并把键名记进日志。这是**简报指定的防御式接线，不是证据**：读到什么算什么，读不到就兜底。
 */
export const MUSIC_PROFILE_NESTED_CONTAINER_KEYS = ["queryAllSubInfoResp", "queryAppConfigDetailResp"];
/**
 * id_token claims 里的名字/头像候选（R40；简报点名的四个键）。
 *
 * 只认这四个：OIDC 标准里还有 `preferred_username`/`given_name` 之类，但**没有证据**说明
 * 华为的 id_token 里有它们——少认一个键的代价是暂时不显示，多认一个猜错的键的代价是显示错人。
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
  // R40：两个有名字的容器再做**一层**（容器自己 + 一层子对象 + 一层数组元素）
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
 * `queryAllSubInfoResp` / `queryAppConfigDetailResp` 的**一层嵌套键名**（R40 诊断）。
 *
 * 只报键名、**不报值**：这两个容器里可能就有账号资料（名字/头像/会员档位），
 * 值是用户的个人信息，键名才是"下一步该读哪个字段"的证据。
 *
 * R41 补一处盲区：**数组元素里的键名**。`profileContainersOf` 早就把"一层数组里的对象元素"
 * 当候选容器读（账号资料很可能挂在 `xxxList[0]` 这种形状下），而这份键名日志此前只走对象分支
 * ——于是"读得到却看不见"：日志里永远只有那个数组名，看不出元素里到底有哪些键。
 * 现在对数组取**首个对象元素**记一行（`容器.键[0]: ...`），与读取侧的一层口径对齐。
 *
 * @param {unknown} payload loginex 响应
 * @returns {string[]} 每个容器/子容器一行（`容器名: a, b, c` / `容器名.键[0]: a, b, c`）
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
 * 从响应里抠 profile（**取到才存**）。
 *
 * @param {object} payload loginex 响应
 * @param {{isSafeUrl?: (url: string) => boolean}} [options] 头像 URL 的白名单校验（默认 `isSafeMediaUrl`）
 * @returns {{userName?: string, avatarUrl?: string, vip?: boolean}} 可能为空对象（空对象 = 认不出任何一项）
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
 * id_token 的 claims → profile（R40；**取到才存**，与 `profileFromResponse` 同一份纪律）。
 *
 * 只取名字与头像：
 * - 头像同样**必须过媒体白名单**（白名单外的地址渲染层画不出来，存了也只是个死地址）；
 * - **VIP 不从 claims 取**：claims 里没有"有证据"的会员字段（`memberShip` 那条规则属于
 *   loginex 响应），猜一个 `vip`/`is_premium` 出来就是拿用户的会员身份开玩笑——宁可少显示。
 *
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
 * 合并两份 profile：**前者优先**，后者只补空缺（R40）。
 *
 * 为什么 loginex 优先于 id_token：前者是音乐业务自己的账号数据（VIP 规则也在那边），
 * 后者是账号域的 OIDC claims——同一件事有两个来源时，业务域那份更贴近"这个应用里显示谁"。
 * claims 的价值在于**补空缺**（loginex 顶层根本没有名字/头像）。
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
 * 把 id_token claims 里认出的 profile **补进**会话记录（R40）。
 *
 * 只补空缺、只多一个 `profile` 键：其余字段（音乐 token、userId、expireTime）原样带过。
 * 认不出任何东西时返回**原来的对象**（不制造"多了一个空 profile"的假变化）。
 *
 * **不落盘原始 token**：`claims` 本身不进记录，只有从里面提取出的名字/头像/vip 三个键进
 * ——会话记录会随 DPAPI 信封落盘，凭据与 claims 原文都不该在那里。
 *
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
 * 会话记录里的 profile → `auth:status` 载荷里的可选 profile（R38）。
 *
 * 只搬**白名单内那三个键**（名字/头像/VIP），其余一律不带：载荷是渲染层的输入，
 * 不该把整份会话记录（里面有音乐 token）之类的东西递出去。旧会话（R38 之前建的）没有
 * `profile` 这一格 → 返回 null，界面照旧显示兜底（头像占位 + "已登录"），**不造假数据**。
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
  return Object.keys(profile).length === 0 ? null : profile;
}

/** 响应体顶层键名（**只记键名，绝不记值**；诊断用）。 */
export function topLevelKeysOf(payload, limit = 40) {
  if (!isObject(payload)) return [];
  return Object.keys(payload).sort().slice(0, Math.max(1, limit));
}

/**
 * loginex 响应 → 本项目的会话形状。
 *
 * 映射（公开契约 §2.3 的"响应关注"三项 + 本仓既有会话形状）：
 * - `token`      → `musicSession`（**会话凭据**，进 DPAPI 信封，不进日志）
 * - `snsUserID`  → `userId`
 * - `expireTime` → 原样保留为 14 位 `yyyyMMddHHmmss` 字符串
 * - profile（R38）→ `profile`（名字/头像/VIP，**取到才存**：见 `profileFromResponse`）
 *
 * **刻意不把它换算成 `expiresAt` 毫秒**：契约明写"时区尚未完全确认"，换算错了就是一个
 * 看起来精确、实际偏 8 小时的时间戳；而这个项目的续期本来就没打通（失效要重扫）。
 * 原始串留下，等真机联调确认时区后再决定怎么用。
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
  const expireTime = payload.expireTime;
  const profile = profileFromResponse(payload, options);
  return ok({
    musicSession: token,
    ...(typeof snsUserID === "string" && snsUserID.trim() !== "" ? { userId: snsUserID } : {}),
    ...(typeof expireTime === "string" && expireTime.trim() !== "" ? { expireTime } : {}),
    ...(hasProfileContent(profile) ? { profile } : {}),
  });
}

/**
 * 造一个真发请求的音乐会话端口（`auth-manager` 的 `exchangeMusicSession` 插座）。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]  注入 fetch（测试用；默认全局 fetch）
 * @param {Function} [options.random]     注入随机源（测试用；默认 node:crypto）
 * @param {Function} [options.now]       注入时钟（测试用；默认 `() => new Date()`）
 * @param {number}   [options.timeoutMs]  单次请求超时
 * @param {Function} [options.log]        只记**键名**的诊断口（R38；默认不记）
 * @param {Function} [options.isSafeUrl]  头像 URL 的白名单校验（默认 `isSafeMediaUrl`）
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
    // R38：**只记键名**（不记任何值）——这条链的响应形状一直没有实证，
    // 下一次真机登录就能从这一行看出"profile 到底叫什么名字"，而不是继续猜候选键。
    log(`loginex 响应顶层键名（只记键名，不记值）：${topLevelKeysOf(payload).join(", ")}`);
    // R40：顶层已经证实没有名字/头像（真机 15:52 那次的键名日志），所以再看一层——
    // 两个"容器"对象的键名（含一层子容器）。同样只记键名：里面是账号资料，值是用户的个人信息。
    for (const line of nestedContainerKeyNamesOf(payload)) {
      log(`loginex 容器一层键名（只记键名，不记值）：${line}`);
    }
    return parseMusicSessionResponse(payload, { isSafeUrl });
  };
}
