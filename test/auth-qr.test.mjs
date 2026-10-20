/**
 * R16 · B 部分：认证状态机的二维码路径（`auth-manager.startQrLogin` / `cancelQrLogin`）。
 *
 * 端口（`src/main/qr-login.mjs`）注入成假实现：本文件只钉 auth-manager 的职责——
 * **每次二维码会话一对新的 PKCE/state、确认后走同一条兑换链、失败如实广播**。
 * 真实网络链路由 test/qr-port.test.mjs 覆盖（离线）；真机扫码是用户在场的验证，不在测试里。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AUTH_QR, AUTH_STATUS } from "../src/shared/channels.ts";
import { AUTH_ERROR_KINDS, HUAWEI_OAUTH_ENDPOINTS, createAuthManager } from "../src/main/auth-manager.ts";
import {
  LOGIN_GATE_EVENT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  reduceGateState,
  shouldOfferOfficialFallback,
} from "../src/renderer/features/auth/login-gate-logic.mjs";

const MUSIC_SESSION = { musicSession: "user$abc", userId: "42" };
const ACCOUNT_TOKENS = { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: 1_700_000_000_000 };

/** 假二维码端口：测试自己决定什么时候"已确认"。 */
function fakeQrPort({ startResult } = {}) {
  const state = { starts: [], cancelled: 0, handlers: null };
  return {
    state,
    start(params) {
      state.starts.push(params);
      state.handlers = params;
      return Promise.resolve(startResult ?? { ok: true, data: { content: "QR-CONTENT", expiresInMs: 181_000 } });
    },
    cancel() {
      state.cancelled += 1;
      return { ok: true, data: { cancelled: true } };
    },
    status: () => "pending",
    /** 广播一次端口事件（pending/scanned/expired/failed/confirmed 都由它来） */
    emit(event) {
      state.handlers.onEvent(event);
    },
    /** 交付"已确认之后换回来的回调 URL" */
    confirm(result) {
      state.handlers.onConfirmed(result);
    },
  };
}

function fakeHost() {
  const host = {
    openLoginPage: () => new Promise(() => undefined),
    cancelLogin: () => Promise.resolve({ ok: true, data: { cancelled: true } }),
    cleanup() {},
  };
  return host;
}

function fakeSessionStore({ saved = [] } = {}) {
  return {
    saved,
    async saveMusicSession(session) {
      saved.push(session);
      return { path: "C:\\data\\session.enc", modeApplied: true, modeNote: null };
    },
    async loadMusicSession() {
      return null;
    },
    async clearMusicSession() {
      return true;
    },
  };
}

function managerOf(overrides = {}) {
  const broadcasts = [];
  const notices = [];
  const store = overrides.sessionStore ?? fakeSessionStore();
  const qrPort = overrides.qrPort ?? fakeQrPort();
  const auth = createAuthManager({
    host: overrides.host ?? fakeHost(),
    sessionStore: store,
    qrPort,
    exchangeCode: overrides.exchangeCode ?? (async () => ({ ok: true, data: ACCOUNT_TOKENS })),
    exchangeMusicSession: overrides.exchangeMusicSession ?? (async () => ({ ok: true, data: MUSIC_SESSION })),
    verifySession: overrides.verifySession ?? (async () => ({ ok: true, data: { total: 3 } })),
    broadcast: (channel, payload) => {
      broadcasts.push({ channel, payload });
      return { ok: true, data: null };
    },
    notify: (text) => {
      notices.push(text);
      return { ok: true, data: null };
    },
    log: () => {},
  });
  return { auth, store, broadcasts, notices, qrPort };
}

/** 从二维码会话的授权页 URL 里取本次 attempt 的 state（真回调必须带它）。 */
function stateOf(qrPort) {
  return new URL(qrPort.state.starts[0].authorizeUrl).searchParams.get("state");
}

const qrEvents = (broadcasts) => broadcasts.filter((entry) => entry.channel === AUTH_QR).map((entry) => entry.payload);
const statusEvents = (broadcasts) => broadcasts.filter((entry) => entry.channel === AUTH_STATUS).map((entry) => entry.payload);

test("二维码登录：每次会话一对新的 PKCE/state，授权页 URL 交给端口，busy 立刻广播", async () => {
  const { auth, broadcasts, qrPort } = managerOf();
  const started = await auth.startQrLogin();

  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.data.content, "QR-CONTENT");
  assert.equal(started.data.expiresInMs, 181_000);

  const url = new URL(qrPort.state.starts[0].authorizeUrl);
  assert.equal(url.origin + url.pathname, HUAWEI_OAUTH_ENDPOINTS.authorize);
  assert.equal(url.searchParams.get("client_id"), "101444301");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 43, "PKCE challenge 要在授权页 URL 里");
  assert.ok((url.searchParams.get("state") ?? "").length > 0);
  assert.deepEqual(statusEvents(broadcasts).at(-1), { loggedIn: false, busy: true });
});

test("二维码登录：端口的状态变化原样经 auth:qr 广播（渲染层只看这一条通道）", async () => {
  const { auth, broadcasts, qrPort } = managerOf();
  await auth.startQrLogin();

  qrPort.emit({ status: "scanned" });
  qrPort.emit({ status: "expired" });
  qrPort.emit({ status: "pending", content: "QR-CONTENT-2", expiresInMs: 180_000 });

  assert.deepEqual(
    qrEvents(broadcasts).map((payload) => payload.status),
    ["scanned", "expired", "pending"],
  );
  assert.equal(qrEvents(broadcasts).at(-1).content, "QR-CONTENT-2");
});

test("二维码登录：确认载荷不进广播（渲染层拿不到 code/userAccount —— 与「渲染层拿不到 Token」同一条红线）", async () => {
  const { auth, broadcasts, qrPort } = managerOf();
  await auth.startQrLogin();

  qrPort.emit({
    status: "confirmed",
    payload: { resultCode: "0", code: "SECRET-CODE", userAccount: "SECRET-ACCOUNT", qrToken: "SECRET-TOKEN" },
  });

  const confirmed = qrEvents(broadcasts).at(-1);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(Object.keys(confirmed).sort(), ["status"], "确认那一档只播状态，载荷留在 sidecar");
  assert.equal(JSON.stringify(qrEvents(broadcasts)).includes("SECRET"), false);
});

test("二维码登录：已确认 → 回调交给同一条兑换链（换 AT → 音乐会话 → 验证 → 存盘 → 广播已登录）", async () => {
  const exchanged = [];
  const { auth, broadcasts, store, qrPort } = managerOf({
    exchangeCode: async ({ code, codeVerifier }) => {
      exchanged.push({ code, codeVerifier });
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await auth.startQrLogin();
  qrPort.emit({ status: "confirmed", payload: { resultCode: "0" } });
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=CODE-QR&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(exchanged.length, 1);
  assert.equal(exchanged[0].code, "CODE-QR");
  assert.ok(exchanged[0].codeVerifier.length >= 43, "兑换要用本次会话的 code_verifier");
  assert.deepEqual(store.saved, [MUSIC_SESSION]);
  assert.equal(auth.status().loggedIn, true);
  assert.deepEqual(statusEvents(broadcasts).at(-1), { loggedIn: true, busy: false });
});

test("二维码登录：回调带回陌生的 state → 结构化失败广播出去，一次兑换都不发", async () => {
  let exchangeCalls = 0;
  const { auth, broadcasts, qrPort } = managerOf({
    exchangeCode: async () => {
      exchangeCalls += 1;
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: "hms://redirect_uri?code=CODE-QR&state=NOT-MINE" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(exchangeCalls, 0, "state 不是本次会话的：兑换链一步都不许走");
  assert.equal(auth.status().loggedIn, false);
  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.busy, false);
  assert.match(last.message, /state/);
  // 收尾失败也要把二维码这条路落到 failed：否则界面停在「已确认，正在完成登录…」上，零按钮
  const lastQr = qrEvents(broadcasts).at(-1);
  assert.equal(lastQr.status, "failed");
  assert.match(lastQr.message, /state/);
});

test("二维码登录：确认之后 loginex 缺端点 → 如实报结构化错误（不假装已登录）", async () => {
  const { auth, broadcasts, qrPort } = managerOf({
    exchangeMusicSession: async () => ({
      ok: false,
      error: { message: "音乐会话兑换（loginex）端点待联调", kind: AUTH_ERROR_KINDS.loginexPending },
    }),
  });
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=CODE-QR&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(auth.status().loggedIn, false);
  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.loggedIn, false);
  assert.match(last.message, /loginex/);
});

test("二维码登录：建单失败 → 结构化错误 + busy:false 文案广播，端口不再被调用", async () => {
  const { auth, broadcasts } = managerOf({
    qrPort: fakeQrPort({ startResult: { ok: false, error: { message: "建单端点返回 HTTP 502", kind: "http_error" } } }),
  });
  const started = await auth.startQrLogin();

  assert.equal(started.ok, false);
  assert.equal(started.error.kind, "http_error");
  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.busy, false);
  assert.match(last.message, /502/);
});

test("二维码登录：已有一次登录在进行 → login_in_progress（不开第二张二维码）", async () => {
  const qrPort = fakeQrPort();
  let settle;
  const host = {
    openLoginPage: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    cancelLogin: () => Promise.resolve({ ok: true, data: { cancelled: true } }),
    cleanup() {},
  };
  const { auth } = managerOf({ qrPort, host });
  const pending = auth.login();
  await new Promise((resolve) => setImmediate(resolve));

  const started = await auth.startQrLogin();
  assert.equal(started.ok, false);
  assert.equal(started.error.kind, AUTH_ERROR_KINDS.loginInProgress);
  assert.deepEqual(qrPort.state.starts, [], "并排第二次不许真的去建单");

  // 收场（否则 runLoginFlow 的 10 分钟计时器会吊着事件循环）
  settle({ status: "cancelled" });
  await pending;
});

test("二维码登录：已登录就不再扫码（already_logged_in）", async () => {
  const { auth, qrPort } = managerOf();
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=C&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.status().loggedIn, true);

  const again = await auth.startQrLogin();
  assert.equal(again.ok, false);
  assert.equal(again.error.kind, AUTH_ERROR_KINDS.alreadyLoggedIn);
});

// ---------------------------------------------------------------------------
// 修复轮 1/5：两条"错误路径卡死界面"的回归钉（都先红后绿）
// ---------------------------------------------------------------------------

test("二维码登录：会话中端口报失败 → busy 同时复位（否则回退按钮卡在禁用）", async () => {
  const { auth, broadcasts, qrPort } = managerOf();
  await auth.startQrLogin();
  assert.deepEqual(statusEvents(broadcasts).at(-1), { loggedIn: false, busy: true });

  // 轮询失败×3 / 10 分钟期限 / 确认链失败都走这一条（端口只发 auth:qr{failed}）
  qrPort.emit({
    status: "failed",
    message: "二维码状态轮询请求失败（连续 3 次：请检查网络或代理后重试）",
    errorKind: "network_error",
  });

  assert.equal(qrEvents(broadcasts).at(-1).status, "failed");
  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.loggedIn, false);
  assert.equal(last.busy, false, "失败是「这条路走完了」：busy 必须跟着落下来");
});

test("二维码登录：会话中失败（协议不可用档）后，渲染层的官方页回退按钮可点", async () => {
  const { broadcasts, qrPort, auth } = managerOf();
  await auth.startQrLogin();

  // 渲染层真实经历的那条链：status{busy:true} → qr{failed}
  let state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: true,
  });
  qrPort.emit({
    status: "failed",
    message: "窗口配置里没有 service（换授权码要用它），二维码登录无法收尾",
    errorKind: "qr_config_unavailable",
  });
  for (const { channel, payload } of broadcasts) {
    const type = channel === AUTH_STATUS ? LOGIN_GATE_EVENT.status : LOGIN_GATE_EVENT.qr;
    state = reduceGateState(state, { type, ...payload });
  }

  assert.equal(canRetryQr(state), true);
  assert.equal(shouldOfferOfficialFallback(state), true);
  assert.equal(
    canStartLogin(state),
    true,
    "busy 卡在 true 时回退按钮 disabled —— 恰好在最需要它的场景里点不动",
  );
});

test("二维码登录：确认之后兑换失败（loginex）→ auth:qr 落到 failed，界面才有「重试」", async () => {
  const { auth, broadcasts, qrPort } = managerOf({
    exchangeMusicSession: async () => ({
      ok: false,
      error: { message: "音乐会话兑换（loginex）端点待联调", kind: AUTH_ERROR_KINDS.loginexPending },
    }),
  });
  await auth.startQrLogin();
  qrPort.emit({ status: "confirmed", payload: { resultCode: "0" } });
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=C&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));

  const lastQr = qrEvents(broadcasts).at(-1);
  assert.equal(
    lastQr.status,
    "failed",
    "停在 confirmed 的话：错误行有了，重试与回退却都不出现，也没有自动重启",
  );
  assert.match(lastQr.message, /loginex/);
  assert.equal(lastQr.errorKind, AUTH_ERROR_KINDS.loginexPending);
  assert.equal(statusEvents(broadcasts).at(-1).busy, false);
});

test("二维码登录：确认之后兑换失败 → 渲染层同一状态链下「重试」可点", async () => {
  const { auth, broadcasts, qrPort } = managerOf({
    exchangeMusicSession: async () => ({
      ok: false,
      error: { message: "音乐会话兑换（loginex）端点待联调", kind: AUTH_ERROR_KINDS.loginexPending },
    }),
  });
  await auth.startQrLogin();
  qrPort.emit({ status: "confirmed", payload: { resultCode: "0" } });
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=C&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));

  let state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: true,
  });
  for (const { channel, payload } of broadcasts) {
    const type = channel === AUTH_STATUS ? LOGIN_GATE_EVENT.status : LOGIN_GATE_EVENT.qr;
    state = reduceGateState(state, { type, ...payload });
  }

  assert.equal(state.qr.status, "failed");
  assert.equal(canRetryQr(state), true, "「重试」是这条路上唯一能让用户继续走下去的东西");
  assert.equal(canStartLogin(state), true);
});

test("二维码登录：取消 → 端口被叫停 + busy:false（用户关了门禁就别在后台轮询）", async () => {
  const qrPort = fakeQrPort();
  const { auth, broadcasts } = managerOf({ qrPort });
  await auth.startQrLogin();

  const cancelled = await auth.cancelQrLogin();
  assert.equal(cancelled.ok, true);
  assert.equal(qrPort.state.cancelled, 1);
  assert.deepEqual(statusEvents(broadcasts).at(-1), { loggedIn: false, busy: false });
});
