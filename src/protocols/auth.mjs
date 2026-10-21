/**
 * OAuth/PKCE 协议原型（华为帐号 OAuth，授权码 + PKCE S256）。
 *
 * 端点一律**注入**：本模块不写死任何 URL——端点值由调用方给（生产默认值住在
 * `src/main/auth-manager.ts` 的 `HUAWEI_OAUTH_ENDPOINTS`，登记在 `docs/API_CONTRACT.md` §1）。
 *
 * R32 换血（对齐公开参考实现 `talongao/huawei-music-desktop` 的**实测**事实，见 §1.2/§1.3）：
 * authorize 与 token 是**两个不同的主机**（此前我们都打在 `oauth-login1` 上，授权页能开、
 * 但请求参数集与端点都不是实测那一组）；授权页参数补齐 `countryCode=cn` 与 `ui_locales=zh-cn`；
 * `scope` 换成用户指令给出的**完整清单**（参考实现默认只用 `openid`，那是它自己的最小实验集）。
 *
 * 协议事实（照抄任务书，勿改）：
 * client_id = 101444301（非本项目注册身份）、redirect_uri = hms://redirect_uri、
 * access_type = offline、response_type = code、PKCE S256。
 *
 * 安全约定：返回值里的错误消息**只带端点/HTTP 状态/错误码**，绝不回显 code、code_verifier、
 * access_token、refresh_token（这些值进日志就等于泄漏）。
 */
import { createHash, randomBytes } from "node:crypto";

import { err, ok } from "../shared/result.ts";

export const OAUTH_CLIENT_ID = "101444301";
export const OAUTH_REDIRECT_URI = "hms://redirect_uri";
/**
 * 授权页的 `scope`：**完整清单**（用户指令逐字给出，顺序即此顺序）。
 *
 * 为什么不是参考实现默认的 `['openid']`：参考那份是它做最小实验时用的集合，
 * 而用户指令点名了要这一整串（音乐业务要用到的账号域资料都在里面）。
 * 空格分隔是 OAuth 2.0 的规定形态（`scope` 参数值）；这里存**数组**，
 * 拼串只发生在 `buildAuthorizeUrl` 一处，避免两处各拼一遍拼出两个样子。
 */
export const OAUTH_SCOPES = Object.freeze([
  "openid",
  "https://www.huawei.com/auth/account/mobile.number",
  "https://www.huawei.com/auth/account/guardian.uid",
  "https://www.huawei.com/auth/account/country",
  "https://www.huawei.com/auth/account/base.profile",
  "https://www.huawei.com/auth/account/birthday",
  "https://www.huawei.com/auth/pay/walletinfo",
  "https://www.huawei.com/auth/account/gender",
  "https://www.huawei.com/auth/drive.file",
  "https://www.huawei.com/auth/account/accountlist.anonymous",
  "https://www.huawei.com/auth/account/accountlist",
  "https://www.huawei.com/default/scopes",
]);

/** `scope` 参数的线上形态（空格分隔）。 */
export const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");

export const OAUTH_ACCESS_TYPE = "offline";
export const OAUTH_RESPONSE_TYPE = "code";
/** 授权页的地区/语言（参考实现实测参数：`countryCode=cn&ui_locales=zh-cn`）。 */
export const OAUTH_COUNTRY_CODE = "cn";
export const OAUTH_UI_LOCALES = "zh-cn";
export const PKCE_CODE_CHALLENGE_METHOD = "S256";
export const OAUTH_GRANT_TYPE_AUTHORIZATION_CODE = "authorization_code";
export const OAUTH_GRANT_TYPE_REFRESH_TOKEN = "refresh_token";

/** 默认随机字节数：32 字节 → base64url 43 字符，正好是 RFC 7636 的下限。 */
export const PKCE_VERIFIER_BYTES = 32;
export const STATE_BYTES = 16;

/** 到期判定的提前量：临界期宁多刷一次，不要拿着马上过期的 AT 去发请求。 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const AUTH_ERROR_KINDS = {
  /** 端点未注入/不合法（不是 https）——设计上的"端点未知"落点 */
  missingEndpoint: "missing_endpoint",
  /** 调用方参数不齐（code / code_verifier / refresh_token） */
  missingParam: "missing_param",
  /** 端点返回非 2xx */
  httpError: "http_error",
  /** 连接层失败（DNS/超时/代理不可达） */
  networkError: "network_error",
  /** 2xx 但响应不是 JSON 或缺必需字段 */
  invalidResponse: "invalid_response",
};

export function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return buffer.toString("base64url");
}

/** RFC 7636：code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))。 */
export function codeChallengeS256(codeVerifier) {
  return base64UrlEncode(createHash("sha256").update(String(codeVerifier), "utf8").digest());
}

/** code_verifier：43–128 个 unreserved 字符（base64url 字母表是它的子集）。 */
export function createCodeVerifier(random = randomBytes) {
  return base64UrlEncode(random(PKCE_VERIFIER_BYTES));
}

/** state：一次性、随机、回调时用 timingSafeEqual 比对（见 login-callback.mjs）。 */
export function createState(random = randomBytes) {
  return base64UrlEncode(random(STATE_BYTES));
}

function isHttpsEndpoint(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function endpointError(label) {
  return err(
    `${label} 未确定：端点 URL 必须由调用方注入（待授权 probe / R7 联调确认，见 docs/API_CONTRACT.md）`,
    AUTH_ERROR_KINDS.missingEndpoint,
  );
}

/** 供 createAttempt 使用：拿不到合法端点属于编程错误，直接抛（启动期就该炸）。 */
function assertHttpsEndpoint(value, label) {
  if (!isHttpsEndpoint(value)) {
    throw new TypeError(`${label} 必须是 https 端点 URL（端点未知时不猜 URL，见 docs/API_CONTRACT.md）`);
  }
  return value.trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/** 拼授权页 URL（参数名与取值 = 参考实现实测那一组，端点本身由调用方给）。 */
export function buildAuthorizeUrl({ authorizeEndpoint, clientId = OAUTH_CLIENT_ID, codeChallenge, state, extraParams = {} }) {
  const endpoint = assertHttpsEndpoint(authorizeEndpoint, "authorizeEndpoint");
  const url = new URL(endpoint);
  url.searchParams.set("response_type", OAUTH_RESPONSE_TYPE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("access_type", OAUTH_ACCESS_TYPE);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", PKCE_CODE_CHALLENGE_METHOD);
  url.searchParams.set("state", state);
  // 地区与语言：参考实现的授权 URL 里有这两个（少了它们授权页按别的区域渲染，
  // 后续 CAS 落地页也就跟着换域——R16 那类"窗里停在空壳"的故障与域判定强相关）。
  url.searchParams.set("countryCode", OAUTH_COUNTRY_CODE);
  url.searchParams.set("ui_locales", OAUTH_UI_LOCALES);
  for (const [name, value] of Object.entries(extraParams)) url.searchParams.set(name, String(value));
  return url.href;
}

/**
 * 新建一次登录尝试：PKCE 对（verifier/challenge）+ state + 授权页 URL。
 * 消费它的是 login-callback.mjs 的 runLoginFlow（一次性、10 分钟过期）。
 *
 * @param {{authorizeEndpoint: string, random?: Function, now?: number}} [options]
 *        `authorizeEndpoint` 必须由调用方注入（已确认值见 docs/API_CONTRACT.md §1.2）；
 *        `now` 是**这次尝试的创建时刻**（纪元毫秒，**是值不是时钟函数**）——它原样存进
 *        `createdAt`，消费它的是 `consumeCallback`/`runLoginFlow` 的过期判定
 *        （R36 起二维码那条路也把 `attempt.createdAt` 传进 `runLoginFlow`：
 *        attempt 建立在前、登录窗开在后，"过期"必须锚在尝试上）。
 */
export function createAttempt({ authorizeEndpoint, random = randomBytes, now = Date.now() } = {}) {
  const endpoint = assertHttpsEndpoint(authorizeEndpoint, "authorizeEndpoint");
  const codeVerifier = createCodeVerifier(random);
  const codeChallenge = codeChallengeS256(codeVerifier);
  const state = createState(random);
  return {
    authorizeUrl: buildAuthorizeUrl({ authorizeEndpoint: endpoint, codeChallenge, state }),
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: PKCE_CODE_CHALLENGE_METHOD,
    state,
    redirectUri: OAUTH_REDIRECT_URI,
    clientId: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
    accessType: OAUTH_ACCESS_TYPE,
    responseType: OAUTH_RESPONSE_TYPE,
    createdAt: now,
  };
}

/** 表单正文（token 端点按 RFC 6749 用 application/x-www-form-urlencoded）。 */
async function postForm({ endpoint, params, fetchImpl, signal }) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  };
  if (signal !== undefined) init.signal = signal;

  let response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch (cause) {
    return err(`请求 ${endpoint} 失败：${messageOf(cause)}`, AUTH_ERROR_KINDS.networkError);
  }

  if (!response || typeof response.ok !== "boolean") {
    return err(`请求 ${endpoint} 未返回可识别的响应`, AUTH_ERROR_KINDS.invalidResponse);
  }
  if (!response.ok) {
    // 只取 OAuth 标准错误码/描述；不读整段响应体，避免把不该进日志的东西带出来
    let detail = "";
    try {
      const body = await response.json();
      const code = body?.error ?? body?.error_code;
      if (code !== undefined && code !== null) detail = `：${String(code).slice(0, 64)}`;
    } catch {
      detail = "";
    }
    return err(`token 端点返回 HTTP ${response.status}${detail}`, AUTH_ERROR_KINDS.httpError);
  }

  try {
    const text = await response.text();
    return ok(JSON.parse(text));
  } catch {
    return err("token 端点响应不是 JSON", AUTH_ERROR_KINDS.invalidResponse);
  }
}

/** 令牌响应 → 内部形状；缺 access_token 视为无效响应。 */
function toTokenSet(payload, { now, previousRefreshToken = null }) {
  if (!payload || typeof payload !== "object") return null;
  const accessToken = payload.access_token ?? payload.accessToken;
  if (!isNonEmptyString(accessToken)) return null;

  const rawExpiresIn = payload.expires_in ?? payload.expiresIn;
  const expiresIn = Number.isFinite(Number(rawExpiresIn)) && Number(rawExpiresIn) > 0 ? Number(rawExpiresIn) : 0;
  const refreshToken = payload.refresh_token ?? payload.refreshToken ?? previousRefreshToken;

  return {
    accessToken,
    refreshToken: isNonEmptyString(refreshToken) ? refreshToken : null,
    idToken: isNonEmptyString(payload.id_token) ? payload.id_token : null,
    expiresIn,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : null,
    tokenType: isNonEmptyString(payload.token_type) ? payload.token_type : null,
    scope: isNonEmptyString(payload.scope) ? payload.scope : null,
  };
}

/**
 * `id_token`（OIDC JWT）→ claims 对象（**只解码，不验签**；解不出就是 `null`）。
 *
 * R40 增补。为什么需要它：`loginex` 响应顶层**没有**用户名/头像（真机实证：顶层只有
 * `ageLevel/expireTime/gender/queryAllSubInfoResp/queryAppConfigDetailResp/realNameAuth/
 * realNameLevel/result/snsUserID/token/userFlag/userHC/userID`），而 token 响应里有
 * `id_token`——OIDC 的 claims 段才是账号资料（名字/头像）的标准载体。
 *
 * 四条边界，每条都是刻意的：
 * 1. **不验签**：这是一个刚从 TLS 连接上拿到的响应，不是从不可信来源转发的 token；
 *    验签要 JWKS（另一个端点、另一份缓存），本轮不发明那个端点；
 * 2. **只认三段式**（`header.payload.signature`）且 payload 段是 base64url：别的形状一律
 *    `null`——`id_token` 未必永远是 JWT，猜着解只会得到一个乱码对象；
 * 3. **不抛异常**：坏形状（少段、非法字符、不是 JSON、JSON 不是对象）全部回 `null`，
 *    调用方据此走兜底（登录链不能因为一个诊断字段把整次登录搞崩）；
 * 4. **不记值**：本函数只返回对象，日志一律由调用方只记**键名**（claims 里有 `sub` 这类标识）。
 *
 * @param {unknown} idToken
 * @returns {Record<string, unknown> | null}
 */
export function idTokenClaimsOf(idToken) {
  if (!isNonEmptyString(idToken)) return null;
  const parts = String(idToken).trim().split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === "" || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;

  let decoded;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  try {
    const claims = JSON.parse(decoded);
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * `id_token` 的 claims 键名（排序，只键名）——**只给日志用**。
 *
 * 与 `idTokenClaimsOf` 分开的理由：调用方要的是"这次响应里有哪些 claim"，
 * 而不是"claims 里有什么值"；写成两件事，才不会有人在日志里顺手把 claims 打出来。
 */
export function idTokenClaimKeysOf(idToken, limit = 40) {
  const claims = idTokenClaimsOf(idToken);
  if (claims === null) return [];
  return Object.keys(claims).sort().slice(0, Math.max(1, limit));
}

/**
 * 令牌响应顶层键名的**键名日志**（R38 诊断；只记键名、绝不记值）。
 *
 * 为什么需要它：`token` 端点的响应里到底有没有用户资料字段（名字/头像/VIP）从来没有实证——
 * 登录链成功后只取了 `access_token`。把键名记下来，下一次真机登录就有真实形状可依，
 * 而不是继续往候选表里加猜测键。回调默认空实现（协议层自己不写日志）。
 */
function reportResponseKeys(payload, onResponseKeys) {
  if (typeof onResponseKeys !== "function") return;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const keys = Object.keys(payload).sort().slice(0, 40);
  if (keys.length === 0) return;
  onResponseKeys(keys);
}

/**
 * 授权码兑换（token endpoint，带 code_verifier）。
 * @param {{endpoint: string, code: string, codeVerifier: string, redirectUri?: string, clientId?: string,
 *          fetchImpl?: Function, now?: number, signal?: AbortSignal,
 *          onResponseKeys?: (keys: string[]) => void}} params
 *   `onResponseKeys`（R38）：拿到了响应体就把**顶层键名**交出去（只记键名，见 `reportResponseKeys`）。
 * @returns {Promise<{ok: true, data: object} | {ok: false, error: {message: string, kind: string}}>}
 */
export async function exchangeAuthorizationCode({
  endpoint,
  code,
  codeVerifier,
  redirectUri = OAUTH_REDIRECT_URI,
  clientId = OAUTH_CLIENT_ID,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal,
  onResponseKeys,
} = {}) {
  if (!isHttpsEndpoint(endpoint)) return endpointError("token 端点");
  if (!isNonEmptyString(code)) return err("授权码为空", AUTH_ERROR_KINDS.missingParam);
  if (!isNonEmptyString(codeVerifier)) return err("code_verifier 为空", AUTH_ERROR_KINDS.missingParam);

  const response = await postForm({
    endpoint: endpoint.trim(),
    params: {
      // 字段集与顺序逐字对齐参考实现（`grant_type/client_id/redirect_uri/code/code_verifier`）；
      // 表单编码下顺序本身不影响服务端，但"与契约长得一样"让差分测试能逐字段比对。
      grant_type: OAUTH_GRANT_TYPE_AUTHORIZATION_CODE,
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    },
    fetchImpl,
    signal,
  });
  if (!response.ok) return response;

  reportResponseKeys(response.data, onResponseKeys);
  const tokenSet = toTokenSet(response.data, { now });
  if (tokenSet === null) return err("token 端点响应里没有 access_token", AUTH_ERROR_KINDS.invalidResponse);
  return ok(tokenSet);
}

/**
 * 刷新账号 AT。响应不发新 RT 时沿用旧 RT（华为可能不轮换，清空它等于把会话丢了）。
 */
export async function refreshAccessToken({
  endpoint,
  refreshToken,
  clientId = OAUTH_CLIENT_ID,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal,
  onResponseKeys,
} = {}) {
  if (!isHttpsEndpoint(endpoint)) return endpointError("token 端点");
  if (!isNonEmptyString(refreshToken)) return err("refresh_token 为空", AUTH_ERROR_KINDS.missingParam);

  const response = await postForm({
    endpoint: endpoint.trim(),
    params: {
      grant_type: OAUTH_GRANT_TYPE_REFRESH_TOKEN,
      client_id: clientId,
      refresh_token: refreshToken,
    },
    fetchImpl,
    signal,
  });
  if (!response.ok) return response;

  reportResponseKeys(response.data, onResponseKeys);
  const tokenSet = toTokenSet(response.data, { now, previousRefreshToken: refreshToken });
  if (tokenSet === null) return err("token 端点响应里没有 access_token", AUTH_ERROR_KINDS.invalidResponse);
  return ok(tokenSet);
}

/**
 * 是否该刷新：过期、临界（默认提前 1 分钟）、以及**不知道到期时间**（按过期处理，宁多刷一次）。
 */
export function isTokenExpired(tokenSet, { now = Date.now(), skewMs = TOKEN_EXPIRY_SKEW_MS } = {}) {
  if (!tokenSet || typeof tokenSet !== "object") return true;
  const { expiresAt } = tokenSet;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true;
  return expiresAt - skewMs <= now;
}
