/**
 * R4 协议原型层 · OAuth/PKCE（src/protocols/auth.mjs）。
 *
 * 关键断言：RFC 7636 附录 B 向量逐位相等、attempt 充分随机、端点 URL 一律注入（不硬编码猜测）、
 * 兑换/刷新的成功与失败路径都返回结构化结果且**错误文本绝不含 code/verifier/token**。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AUTH_ERROR_KINDS,
  OAUTH_ACCESS_TYPE,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  OAUTH_RESPONSE_TYPE,
  OAUTH_SCOPE,
  PKCE_CODE_CHALLENGE_METHOD,
  base64UrlEncode,
  codeChallengeS256,
  createAttempt,
  createCodeVerifier,
  createState,
  exchangeAuthorizationCode,
  isTokenExpired,
  refreshAccessToken,
} from "../src/protocols/auth.mjs";

/** 端点一律由调用方注入：测试用的合成端点，不代表真实 URL（真实值见 docs/API_CONTRACT.md）。 */
const AUTHORIZE_ENDPOINT = "https://example.invalid/oauth2/v3/authorize";
const TOKEN_ENDPOINT = "https://example.invalid/oauth2/v3/token";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 注入 fetch：记录调用并让测试决定响应。 */
function captureFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

/** 表单正文 → 便于断言的字典（同键多值保留最后一个）。 */
function formOf(init) {
  return Object.fromEntries(new URLSearchParams(init.body));
}

test("PKCE：RFC 7636 附录 B 测试向量逐位相等", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(codeChallengeS256(verifier), expected);
});

test("PKCE：code_challenge = BASE64URL(SHA256(verifier))，且是 URL 安全的无填充形式", () => {
  const verifier = createCodeVerifier();
  const digest = createHash("sha256").update(verifier, "utf8").digest();
  assert.equal(codeChallengeS256(verifier), digest.toString("base64url"));
  const challenge = codeChallengeS256(verifier);
  assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  assert.doesNotMatch(challenge, /[=+/]/);
  assert.equal(base64UrlEncode(Buffer.from([251, 255, 191])), "-_-_");
});

test("PKCE：verifier 长度与字符集符合 RFC 7636（43–128，unreserved）", () => {
  for (let round = 0; round < 32; round += 1) {
    const verifier = createCodeVerifier();
    assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/, `第 ${round} 轮的 verifier 不合规：${verifier}`);
  }
  assert.equal(createCodeVerifier().length, 43, "默认 32 字节随机 → 43 字符（RFC 下限）");
});

test("PKCE：随机源可注入（测试确定性），默认两次调用必须不同", () => {
  const zeros = () => Buffer.alloc(32, 0);
  assert.equal(createCodeVerifier(zeros), createCodeVerifier(zeros), "注入同一随机源必须可复现");
  assert.equal(createState(zeros), createState(zeros));
  assert.notEqual(createCodeVerifier(), createCodeVerifier(), "默认随机源两次必须不同");
  assert.notEqual(createState(), createState(), "state 默认随机源两次必须不同");
});

test("attempt：授权页端点必须注入（不硬编码猜测 URL），缺失或非 https 直接抛 TypeError", () => {
  assert.throws(() => createAttempt(), TypeError);
  assert.throws(() => createAttempt({}), TypeError);
  assert.throws(() => createAttempt({ authorizeEndpoint: "http://example.invalid/a" }), TypeError, "只接受 https");
  assert.throws(() => createAttempt({ authorizeEndpoint: "not-a-url" }), TypeError);
});

test("attempt：协议事实照抄（client_id/redirect/scope/access_type/PKCE S256）", () => {
  const attempt = createAttempt({ authorizeEndpoint: AUTHORIZE_ENDPOINT });
  assert.equal(attempt.clientId, OAUTH_CLIENT_ID);
  assert.equal(attempt.clientId, "101444301");
  assert.equal(attempt.redirectUri, OAUTH_REDIRECT_URI);
  assert.equal(attempt.redirectUri, "hms://redirect_uri");
  assert.equal(attempt.scope, OAUTH_SCOPE);
  assert.equal(
    attempt.scope,
    [
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
    ].join(" "),
    "R32：scope 是用户指令给出的完整清单（空格分隔的线上形态）",
  );
  assert.equal(attempt.accessType, OAUTH_ACCESS_TYPE);
  assert.equal(attempt.accessType, "offline");
  assert.equal(attempt.responseType, OAUTH_RESPONSE_TYPE);
  assert.equal(attempt.responseType, "code");
  assert.equal(attempt.codeChallengeMethod, PKCE_CODE_CHALLENGE_METHOD);
  assert.equal(attempt.codeChallengeMethod, "S256");
  assert.equal(attempt.codeChallenge, codeChallengeS256(attempt.codeVerifier));
  assert.equal(typeof attempt.createdAt, "number");

  const url = new URL(attempt.authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_ENDPOINT);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "101444301");
  assert.equal(url.searchParams.get("redirect_uri"), "hms://redirect_uri");
  assert.equal(url.searchParams.get("scope"), OAUTH_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("countryCode"), "cn", "R32：参考实测参数，缺了授权页按别的区域渲染");
  assert.equal(url.searchParams.get("ui_locales"), "zh-cn");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), attempt.codeChallenge);
  assert.equal(url.searchParams.get("state"), attempt.state);
  // redirect_uri 里的 hms:// 必须被百分号编码，否则授权页会把它当第二个 URL
  assert.match(attempt.authorizeUrl, /redirect_uri=hms%3A%2F%2Fredirect_uri/);
  assert.doesNotMatch(attempt.authorizeUrl, /redirect_uri=hms:\/\//);
});

test("attempt：两次 attempt 的 verifier/state/challenge 互不相同（防重放）", () => {
  const first = createAttempt({ authorizeEndpoint: AUTHORIZE_ENDPOINT });
  const second = createAttempt({ authorizeEndpoint: AUTHORIZE_ENDPOINT });
  assert.notEqual(first.codeVerifier, second.codeVerifier);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.codeChallenge, second.codeChallenge);
  assert.notEqual(first.authorizeUrl, second.authorizeUrl);
});

test("兑换：成功路径用注入端点与表单正文，映射字段并算出 expiresAt", async () => {
  const now = 1_700_000_000_000;
  const { calls, fetchImpl } = captureFetch(() =>
    jsonResponse({ access_token: "AT-1", refresh_token: "RT-1", id_token: "ID-1", expires_in: 3600, token_type: "Bearer", scope: "openid" }),
  );

  const result = await exchangeAuthorizationCode({
    endpoint: TOKEN_ENDPOINT,
    code: "CODE-1",
    codeVerifier: "VERIFIER-1",
    fetchImpl,
    now,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    accessToken: "AT-1",
    refreshToken: "RT-1",
    idToken: "ID-1",
    expiresIn: 3600,
    expiresAt: now + 3_600_000,
    tokenType: "Bearer",
    scope: "openid",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_ENDPOINT, "端点必须原样使用（注入式，不做拼接猜测）");
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers["content-type"], /application\/x-www-form-urlencoded/);
  assert.deepEqual(formOf(calls[0].init), {
    grant_type: "authorization_code",
    client_id: "101444301",
    code: "CODE-1",
    code_verifier: "VERIFIER-1",
    redirect_uri: "hms://redirect_uri",
  });
});

test("兑换：缺少端点/授权码/verifier → 结构化错误，且不发起请求", async () => {
  const { calls, fetchImpl } = captureFetch(() => jsonResponse({ access_token: "nope" }));
  const base = { endpoint: TOKEN_ENDPOINT, code: "C", codeVerifier: "V", fetchImpl };

  for (const [label, patch, kind] of [
    ["端点为空", { endpoint: "" }, AUTH_ERROR_KINDS.missingEndpoint],
    ["端点未注入", { endpoint: undefined }, AUTH_ERROR_KINDS.missingEndpoint],
    ["端点非 https", { endpoint: "http://example.invalid/token" }, AUTH_ERROR_KINDS.missingEndpoint],
    ["授权码为空", { code: "" }, AUTH_ERROR_KINDS.missingParam],
    ["verifier 为空", { codeVerifier: "" }, AUTH_ERROR_KINDS.missingParam],
  ]) {
    const result = await exchangeAuthorizationCode({ ...base, ...patch });
    assert.equal(result.ok, false, `${label} 必须失败`);
    assert.equal(result.error.kind, kind, `${label} 的错误类别`);
  }
  assert.equal(calls.length, 0, "参数不齐时一个请求都不该发出去");
});

test("兑换：HTTP 4xx/5xx → http_error，文本含错误码但不回显 code/verifier", async () => {
  const { fetchImpl } = captureFetch(() =>
    jsonResponse({ error: "invalid_grant", error_description: "authorization code invalid" }, 400),
  );
  const result = await exchangeAuthorizationCode({
    endpoint: TOKEN_ENDPOINT,
    code: "SECRET-CODE",
    codeVerifier: "SECRET-VERIFIER",
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, AUTH_ERROR_KINDS.httpError);
  assert.match(result.error.message, /400/);
  assert.match(result.error.message, /invalid_grant/);
  assert.doesNotMatch(result.error.message, /SECRET-CODE/);
  assert.doesNotMatch(result.error.message, /SECRET-VERIFIER/);
});

test("兑换：网络异常 → network_error；响应非 JSON / 缺 access_token → invalid_response", async () => {
  const boom = captureFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const network = await exchangeAuthorizationCode({
    endpoint: TOKEN_ENDPOINT,
    code: "C",
    codeVerifier: "SECRET-VERIFIER",
    fetchImpl: boom.fetchImpl,
  });
  assert.equal(network.ok, false);
  assert.equal(network.error.kind, AUTH_ERROR_KINDS.networkError);
  assert.match(network.error.message, /ECONNREFUSED/);
  assert.doesNotMatch(network.error.message, /SECRET-VERIFIER/);

  const html = captureFetch(() => new Response("<html>proxy login</html>", { status: 200 }));
  const notJson = await exchangeAuthorizationCode({
    endpoint: TOKEN_ENDPOINT,
    code: "C",
    codeVerifier: "V",
    fetchImpl: html.fetchImpl,
  });
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error.kind, AUTH_ERROR_KINDS.invalidResponse);

  const empty = captureFetch(() => jsonResponse({ token_type: "Bearer" }));
  const missing = await exchangeAuthorizationCode({
    endpoint: TOKEN_ENDPOINT,
    code: "C",
    codeVerifier: "V",
    fetchImpl: empty.fetchImpl,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, AUTH_ERROR_KINDS.invalidResponse);
});

test("刷新：grant_type=refresh_token，RT 轮换与不轮换两种响应都正确", async () => {
  const rotating = captureFetch(() => jsonResponse({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 }));
  const rotated = await refreshAccessToken({ endpoint: TOKEN_ENDPOINT, refreshToken: "RT-1", fetchImpl: rotating.fetchImpl });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.data.accessToken, "AT-2");
  assert.equal(rotated.data.refreshToken, "RT-2");
  assert.deepEqual(formOf(rotating.calls[0].init), {
    grant_type: "refresh_token",
    client_id: "101444301",
    refresh_token: "RT-1",
  });

  const keeping = captureFetch(() => jsonResponse({ access_token: "AT-3", expires_in: 60 }));
  const kept = await refreshAccessToken({ endpoint: TOKEN_ENDPOINT, refreshToken: "RT-9", fetchImpl: keeping.fetchImpl });
  assert.equal(kept.ok, true);
  assert.equal(kept.data.refreshToken, "RT-9", "响应不发新 RT 时沿用旧 RT（不要把它清成 undefined）");

  const noEndpoint = await refreshAccessToken({ endpoint: "", refreshToken: "RT-1", fetchImpl: keeping.fetchImpl });
  assert.equal(noEndpoint.ok, false);
  assert.equal(noEndpoint.error.kind, AUTH_ERROR_KINDS.missingEndpoint);
});

test("刷新：失败路径同样不回显 refresh_token", async () => {
  const { fetchImpl } = captureFetch(() => jsonResponse({ error: "invalid_request" }, 400));
  const result = await refreshAccessToken({ endpoint: TOKEN_ENDPOINT, refreshToken: "SECRET-RT", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, AUTH_ERROR_KINDS.httpError);
  assert.doesNotMatch(result.error.message, /SECRET-RT/);
});

test("过期判定：过期/临界/未知一律算过期（宁多刷一次），远期不算", () => {
  const now = 1_000_000;
  assert.equal(isTokenExpired({ expiresAt: now - 1 }, { now }), true);
  assert.equal(isTokenExpired({ expiresAt: now + 3_600_000 }, { now }), false);
  assert.equal(isTokenExpired({ expiresAt: now + 30_000 }, { now, skewMs: 60_000 }), true, "临界期提前刷新");
  assert.equal(isTokenExpired({}, { now }), true, "没有到期字段 → 按过期处理");
  assert.equal(isTokenExpired(null, { now }), true);
});
