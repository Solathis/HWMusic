/**
 * OAuth/PKCE 协议原型（华为帐号 OAuth，授权码 + PKCE S256）。
 * 端点一律注入，本模块不写死任何 URL（生产默认值在 `src/main/auth-manager.ts`，见 `docs/API_CONTRACT.md` §1）。
 * 协议事实：client_id = 101444301、redirect_uri = hms://redirect_uri、access_type = offline、response_type = code。
 * 安全约定：错误消息只带端点/HTTP 状态/错误码，绝不回显 code、code_verifier、access_token、refresh_token。
 */
import { createHash, randomBytes } from "node:crypto";

import { err, ok } from "../shared/result.ts";

export const OAUTH_CLIENT_ID = "101444301";
export const OAUTH_REDIRECT_URI = "hms://redirect_uri";
// 授权页 scope 的完整清单（顺序即此顺序）；拼空格分隔串只发生在 `buildAuthorizeUrl` 一处。
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
/** 授权页的地区/语言（实测参数：`countryCode=cn&ui_locales=zh-cn`）。 */
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

/** 拼授权页 URL（参数名与取值 = 实测那一组，端点本身由调用方给）。 */
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
  // 地区与语言：少了这两个参数，授权页按别的区域渲染，后续 CAS 落地页也跟着换域。
  url.searchParams.set("countryCode", OAUTH_COUNTRY_CODE);
  url.searchParams.set("ui_locales", OAUTH_UI_LOCALES);
  for (const [name, value] of Object.entries(extraParams)) url.searchParams.set(name, String(value));
  return url.href;
}

/**
 * 新建一次登录尝试：PKCE 对（verifier/challenge）+ state + 授权页 URL；一次性、10 分钟过期。
 * @param {{authorizeEndpoint: string, random?: Function, now?: number}} [options] `authorizeEndpoint` 由调用方注入，`now` 是这次尝试的创建时刻（值而非时钟函数）。
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
 * `id_token`（OIDC JWT）→ claims 对象：只解码不验签，坏形状一律 `null`，本函数只返回值、不记值。
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

/** `id_token` 的 claims 键名（排序，只键名）——只给日志用，避免有人在日志里顺手把值打出来。 */
export function idTokenClaimKeysOf(idToken, limit = 40) {
  const claims = idTokenClaimsOf(idToken);
  if (claims === null) return [];
  return Object.keys(claims).sort().slice(0, Math.max(1, limit));
}

/** 令牌响应顶层键名的键名日志（只记键名、绝不记值）；回调默认空实现，协议层自己不写日志。 */
function reportResponseKeys(payload, onResponseKeys) {
  if (typeof onResponseKeys !== "function") return;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const keys = Object.keys(payload).sort().slice(0, 40);
  if (keys.length === 0) return;
  onResponseKeys(keys);
}

/**
 * 授权码兑换（token endpoint，带 code_verifier）；`onResponseKeys` 只交出响应顶层键名。
 * @param {{endpoint: string, code: string, codeVerifier: string, redirectUri?: string, clientId?: string, fetchImpl?: Function, now?: number, signal?: AbortSignal, onResponseKeys?: (keys: string[]) => void}} params
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
