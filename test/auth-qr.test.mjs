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
  LOGIN_OPENING_TEXT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  reduceGateState,
  shouldAutoStartQr,
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

test("二维码登录：每次会话一对新的 PKCE/state，授权页 URL 交给端口，且有会话期间不占 busy", async () => {
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
  assert.deepEqual(
    statusEvents(broadcasts),
    [],
    "R18：开一张二维码**不播** auth:status —— busy 只描述开窗那条路，二维码的进度走 auth:qr",
  );
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

test("二维码登录：会话全程 busy 都是 false（常驻入口在整个等扫码期间都点得动）", async () => {
  const { auth, broadcasts, qrPort } = managerOf();
  await auth.startQrLogin();

  // 轮询失败×3 / 10 分钟期限 / 确认链失败都走这一条（端口只发 auth:qr{failed}）
  qrPort.emit({
    status: "failed",
    message: "二维码状态轮询请求失败（连续 3 次：请检查网络或代理后重试）",
    errorKind: "network_error",
  });

  assert.equal(qrEvents(broadcasts).at(-1).status, "failed");
  assert.equal(statusEvents(broadcasts).at(-1).loggedIn, false);
  // R18：二维码那条路**不许占 busy**（busy 只描述"开窗那条路正在跑"）——
  // 否则常驻的「在网页中打开登录」会在最需要它的时刻被 disabled（R17 抓到的正是这一类）
  assert.ok(statusEvents(broadcasts).length > 0, "这条会话至少播过一次 auth:status（否则下面的断言是空转）");
  assert.ok(
    statusEvents(broadcasts).every((payload) => payload.busy === false),
    `二维码会话期间 busy 一次都不许翻成 true：${JSON.stringify(statusEvents(broadcasts))}`,
  );
});

test("二维码登录：会话中失败（协议不可用档）后，渲染层的常驻入口可点", async () => {
  const { broadcasts, qrPort, auth } = managerOf();
  await auth.startQrLogin();

  // 渲染层真实经历的那条链：status{busy:false} → qr{failed}
  let state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: false,
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
  assert.equal(
    canStartLogin(state),
    true,
    "busy 卡在 true 时那个入口 disabled —— 恰好在最需要它的场景里点不动",
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

// ---------------------------------------------------------------------------
// R18：两条路互斥（开窗之前先把二维码会话停掉）
// ---------------------------------------------------------------------------

test("互斥：发起网页登录时先把二维码会话停掉（否则两条路并发，可能各换一次码）", async () => {
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
  const { auth, broadcasts } = managerOf({ qrPort, host });
  await auth.startQrLogin();
  assert.equal(qrPort.state.cancelled, 0);

  const pending = auth.login();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(qrPort.state.cancelled, 1, "开窗之前必须停掉二维码会话：停轮询、作废待兑换的尝试");
  assert.deepEqual(
    statusEvents(broadcasts).at(-1),
    { loggedIn: false, busy: true },
    "停会话本身不另播一条 busy:false（那会让渲染层把网页那条路误判成「已收场」）",
  );

  // 停掉之后端口再冒出来的事件不该改变任何东西（它已经不属于"当前这条路"）
  const before = broadcasts.length;
  qrPort.emit({ status: "pending", content: "STALE-QR" });
  assert.equal(broadcasts.length, before + 1, "端口事件仍会被转播（渲染层按 path 忽略它）");
  assert.equal(qrEvents(broadcasts).at(-1).content, "STALE-QR");

  // 收场（否则 runLoginFlow 的 10 分钟计时器会吊着事件循环）
  settle({ status: "cancelled" });
  await pending;
  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.busy, false);
  assert.match(last.message, /取消/, "网页那条路的收场带一句给人看的话（渲染层靠它回到二维码态）");
});

test("互斥：确认之后的换码不会被迟到的二维码事件顶掉（attempt 已作废）", async () => {
  let exchangeCalls = 0;
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
  const { auth } = managerOf({
    qrPort,
    host,
    exchangeCode: async () => {
      exchangeCalls += 1;
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await auth.startQrLogin();
  const pending = auth.login();
  await new Promise((resolve) => setImmediate(resolve));

  // 手机在窗打开之后才点了确认：这条回调属于已经作废的那次尝试
  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=STALE&state=${stateOf(qrPort)}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchangeCalls, 0, "作废的二维码尝试不许再走兑换链");

  settle({ status: "cancelled" });
  await pending;
});

// ---------------------------------------------------------------------------
// R20：手动刷新（会话期间重启）与「返回扫码登录」（网页那条路的回退）
// R21（用户指令）：过期不再自动换新——sidecar 也不在过期之后自己再发一次 qr-start
// ---------------------------------------------------------------------------

test("R21 过期：sidecar 只把 expired 播出去，绝不自己重启会话（换新只能由用户点击触发）", async () => {
  const { auth, qrPort, broadcasts } = managerOf();
  await auth.startQrLogin();
  qrPort.emit({ status: "expired" });

  assert.deepEqual(
    qrEvents(broadcasts).map((payload) => payload.status),
    ["expired"],
    "过期如实播出去（渲染层的过期态与倒计时都读它），且**只有这一条**",
  );
  assert.equal(
    qrPort.state.starts.length,
    1,
    "sidecar 不替用户决定「再来一张」（R21 推翻 R16/R20 的自动换新）",
  );
  assert.equal(qrPort.state.cancelled, 0, "过期也不取消会话：端口自己会停轮询（协议层 `expired → stop`）");
});

test("R20 手动刷新：会话期间再次 auth:qr-start → 端口被再次 start（换一对新 PKCE），走的是 restart 语义", async () => {
  const { auth, qrPort } = managerOf();
  await auth.startQrLogin();
  await auth.startQrLogin();

  assert.equal(qrPort.state.starts.length, 2, "点一次二维码容器 = 再发起一次（换一张新码）");
  const first = new URL(qrPort.state.starts[0].authorizeUrl).searchParams;
  const second = new URL(qrPort.state.starts[1].authorizeUrl).searchParams;
  assert.notEqual(second.get("state"), first.get("state"), "每次会话一对新的 state");
  assert.notEqual(second.get("code_challenge"), first.get("code_challenge"), "PKCE 也是新的一对");
});

test("R20 手动刷新：旧会话迟到的确认（带第一次的 state）不会换码；当前那张照常能换", async () => {
  // ① 旧那张发的确认：属于已经作废的尝试
  const exchanged = [];
  const stale = managerOf({
    exchangeCode: async ({ code }) => {
      exchanged.push(code);
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await stale.auth.startQrLogin();
  const oldState = new URL(stale.qrPort.state.starts[0].authorizeUrl).searchParams.get("state");
  await stale.auth.startQrLogin();

  stale.qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=STALE&state=${oldState}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exchanged, [], "旧那张的确认属于已作废的尝试：一次兑换都不许发");
  assert.equal(qrEvents(stale.broadcasts).at(-1).status, "failed", "这条链收口成失败：界面才有「重试」可按");

  // ② 干净的一轮：当前那张（刷新出来的新码）照常走完整条兑换链
  const fresh = managerOf({
    exchangeCode: async ({ code }) => {
      exchanged.push(code);
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await fresh.auth.startQrLogin();
  await fresh.auth.startQrLogin();
  const currentState = new URL(fresh.qrPort.state.starts[1].authorizeUrl).searchParams.get("state");

  fresh.qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=FRESH&state=${currentState}` });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exchanged, ["FRESH"], "当前这张的确认照常兑换");
  assert.equal(fresh.auth.status().loggedIn, true);
});

test("R20 返回扫码登录：点击走 auth:cancel-login（关窗），收场广播带文案 → 渲染层回二维码态并重新发码", async () => {
  const qrPort = fakeQrPort();
  let settle;
  const host = {
    openLoginPage: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    /** 宿主关窗：Rust 把结论槽结算成 Cancelled（窗随即被拆掉） */
    cancelLogin: () => {
      settle({ status: "cancelled" });
      return Promise.resolve({ ok: true, data: { cancelled: true } });
    },
    cleanup() {},
  };
  const { auth, broadcasts, qrPort: port } = managerOf({ qrPort, host });

  // 渲染层：点了「在网页中打开登录」→ started（path=official，busy=true）
  let state = reduceGateState(reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false }), {
    type: LOGIN_GATE_EVENT.started,
  });
  const running = auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.state.cancelled, 1, "开窗之前先停掉二维码会话（R18 的互斥）");

  // 点了「返回扫码登录」→ auth:cancel-login
  const cancelled = await auth.cancelLogin();
  assert.equal(cancelled.ok, true);
  await running;
  await new Promise((resolve) => setImmediate(resolve));

  // 渲染层按广播推进（真窗守则的同一份映射：status 广播 → 状态机）
  for (const { channel, payload } of broadcasts) {
    const type = channel === AUTH_STATUS ? LOGIN_GATE_EVENT.status : LOGIN_GATE_EVENT.qr;
    state = reduceGateState(state, { type, ...payload });
  }

  const last = statusEvents(broadcasts).at(-1);
  assert.equal(last.busy, false);
  assert.match(last.message, /取消/, "收场必须带一句给人看的话（渲染层靠它判「这条路结束了」）");
  assert.equal(state.path, "qr", "回到二维码态");
  assert.equal(shouldAutoStartQr(state), true, "重新武装自动发起：眼前立刻又有一张能扫的码");
  assert.equal(canStartLogin(state), true, "入口也回到可用（不再是「返回扫码登录」那条形态）");
});

test("R20 返回扫码登录：没有进行中的登录时如实回 cancelled:false（不惊动宿主、也不假装关了什么）", async () => {
  let hostCancels = 0;
  const host = {
    openLoginPage: () => new Promise(() => undefined),
    cancelLogin: () => {
      hostCancels += 1;
      return Promise.resolve({ ok: true, data: { cancelled: true } });
    },
    cleanup() {},
  };
  const { auth } = managerOf({ host });
  const answer = await auth.cancelLogin();
  assert.equal(answer.ok, true);
  assert.equal(answer.data.cancelled, false, "什么都没取消也是如实的一句话，不是错误");
  assert.equal(hostCancels, 0, "没有进行中的登录就不去打扰宿主");
});

// ---------------------------------------------------------------------------
// R36（用户真机诊断定案 2026-10-21）：二维码确认之后的最后一跳**交给登录 webview**
//
// 真机证据（R35 的诊断日志）：`loginCallback` 页的查询里**没有 `code`**（只有 ticket/siteID/flowID
// 一类的票据参数），那份 200 的 14KB HTML 里**没有 `hms` 字样**（跳转目标是页面 JS 现拼的）。
// ⇒ 服务端 fetch **结构性地拿不到 code**，R33 的"跟随 302"与 R34 的三策略全是在猜形状 → 整体退役。
//
// 定案依据是同一个应用里的**对照组**：账号密码网页登录实证走通，走的正是
// "webview 里加载官方页 → 页面自己的 JS 执行 → 跳 `hms://` → 被导航拦截器接住"。
// 所以这条链的最后一跳也交给**登录 webview**（复用既有 `host:open-login` 那条路径）：
// 宿主加载 `codeRemoteLogin` 交回的 `callbackURL`，页面 JS 跑完跳 `hms://`，拦截器把原样 URL
// 交回 → `consumeCallback → exchangeCode → loginex → 会话落地`（**同一条兑换链**）。
//
// **选型：两流合一**——这一段的等待/取消/超时/清理**直接复用 R7 的 `runLoginFlow`**
// （auth-manager 里同一个 `startLoginFlow` 装配点），不在这一层另写一份"等 webview 结论"的循环：
// 四收场（callback/cancelled/closed/timed_out）+ failed 的语义与清理因此只有一份实现，
// 两条路不可能各自演化。QR 的 attempt 传进同一条流，**state 就是 attempt.state**（R34 已核实），
// 所以 `consumeCallback` 的校验天然成立。
// ---------------------------------------------------------------------------

/** R36 的假宿主：开窗被记下来，结论由测试自己交付（模拟宿主那条覆盖整段登录的长轮询）。 */
function qrWindowHost() {
  const windows = [];
  let settleWindow = null;
  let cancels = 0;
  return {
    windows,
    host: {
      openLoginPage(params) {
        windows.push(params);
        return new Promise((resolve) => {
          settleWindow = resolve;
        });
      },
      /** 宿主关窗：Rust 把结论槽结算成 Cancelled（真机上浮动控件的「返回扫码登录」走的就是它）。 */
      cancelLogin() {
        cancels += 1;
        if (settleWindow !== null) settleWindow({ status: "cancelled" });
        return Promise.resolve({ ok: true, data: { cancelled: true } });
      },
      cleanup() {},
    },
    /** 交付一条宿主结论（`{status, url?}`），等价于登录 webview 收场。 */
    conclude(conclusion) {
      settleWindow(conclusion);
    },
    cancelCalls: () => cancels,
  };
}

/** 让在飞的 promise 链落地（换码/开窗都是异步尾巴：微任务足够）。 */
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 真机那个形状（R35 日志）：https 的 loginCallback 收尾页，查询里**没有 `code`**。 */
const R36_CALLBACK_PAGE =
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback" +
  "?ticket=ST-1&siteID=1&flowID=FLOW-1&redirect_uri=hms%3A%2F%2Fredirect_uri&access_type=offline";

test("R36 两流合一：确认交回 https 收尾页 → 宿主开登录 webview 加载它；webview 的 hms:// 结论走同一条兑换链", async () => {
  const qrPort = fakeQrPort();
  const window = qrWindowHost();
  const exchanged = [];
  const { auth, broadcasts } = managerOf({
    qrPort,
    host: window.host,
    exchangeCode: async ({ code, codeVerifier }) => {
      exchanged.push({ code, codeVerifier });
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });

  await auth.startQrLogin();
  const state = stateOf(qrPort);
  qrPort.emit({ status: "confirmed", payload: { resultCode: "0" } });
  await flush();
  assert.deepEqual(window.windows, [], "还没确认就不许开任何窗");

  qrPort.confirm({ callbackUrl: R36_CALLBACK_PAGE });
  await flush();

  // ① 宿主被要求开一扇窗，加载的**就是** codeRemoteLogin 交回的那份地址（原样，端口不解析）
  assert.equal(window.windows.length, 1, "确认之后开一扇登录 webview");
  assert.equal(window.windows[0].url, R36_CALLBACK_PAGE);
  assert.equal(
    statusEvents(broadcasts).at(-1).busy,
    true,
    "窗在跑 → busy:true（渲染层 reload 之后只凭它也知道窗开着）",
  );

  // ② 登录 webview 里页面 JS 跳 hms:// → 拦截器把原样 URL 交回 → 同一条兑换链
  window.conclude({ status: "callback", url: `hms://redirect_uri?code=CODE-WEB&state=${state}` });
  await flush();

  assert.deepEqual(exchanged.map((entry) => entry.code), ["CODE-WEB"], "webview 交回的 code 拿去换令牌");
  assert.ok(exchanged[0].codeVerifier.length >= 43, "用的是本次二维码会话那对 PKCE（同一个 attempt）");
  assert.equal(auth.status().loggedIn, true);
  assert.deepEqual(statusEvents(broadcasts).at(-1), { loggedIn: true, busy: false });
  assert.equal(
    qrEvents(broadcasts).some((event) => event.status === "failed"),
    false,
    "成功这条路上没有失败广播",
  );
});

test("R36 直通：callbackURL 本来就是 hms:// 回调 → 不开窗，直接消费（既有链零改动）", async () => {
  const qrPort = fakeQrPort();
  const window = qrWindowHost();
  const { auth } = managerOf({ qrPort, host: window.host });
  await auth.startQrLogin();

  qrPort.confirm({ callbackUrl: `hms://redirect_uri?code=CODE-QR&state=${stateOf(qrPort)}` });
  await flush();

  assert.deepEqual(window.windows, [], "已经是回调就不必开窗（宿主那只收 https 的登录页）");
  assert.equal(auth.status().loggedIn, true);
});

test("R36 取消：用户在 webview 上返回（宿主结算 Cancelled）→ 关窗收场 + 回二维码态（可重试）", async () => {
  const qrPort = fakeQrPort();
  const window = qrWindowHost();
  const { auth, broadcasts } = managerOf({ qrPort, host: window.host });
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: R36_CALLBACK_PAGE });
  await flush();
  assert.equal(window.windows.length, 1);

  window.conclude({ status: "cancelled" });
  await flush();

  const status = statusEvents(broadcasts).at(-1);
  assert.equal(status.busy, false, "收场之后界面不忙");
  assert.match(status.message, /取消/, "收场要带一句给人看的话");
  const qr = qrEvents(broadcasts).at(-1);
  assert.equal(qr.status, "failed", "这一点也要落到二维码那条通道上：界面才有可点的东西");
  assert.match(qr.message, /取消/);
  assert.equal(auth.status().loggedIn, false);

  // 渲染层（同一份逻辑模块、零改动）：这一档「重试」可点、常驻入口也可点 → 用户能继续走
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.qrRequested });
  for (const { channel, payload } of broadcasts) {
    state = reduceGateState(state, {
      type: channel === AUTH_STATUS ? LOGIN_GATE_EVENT.status : LOGIN_GATE_EVENT.qr,
      ...payload,
    });
  }
  assert.equal(canRetryQr(state), true);
  assert.equal(canStartLogin(state), true);
});

test("R36 取消入口：二维码那条路开出来的窗也算「进行中的登录」（cancelLogin 如实叫停宿主）", async () => {
  const qrPort = fakeQrPort();
  const window = qrWindowHost();
  const { auth, broadcasts } = managerOf({ qrPort, host: window.host });
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: R36_CALLBACK_PAGE });
  await flush();

  const cancelled = await auth.cancelLogin();
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.data.cancelled, true, "窗还开着就不许回 cancelled:false");
  assert.ok(window.cancelCalls() >= 1, "取消要落到宿主那一侧（关窗是它的事）");

  await flush();
  assert.equal(auth.status().loggedIn, false);
  assert.equal(qrEvents(broadcasts).at(-1).status, "failed");
});

test("R36 失败：webview 交回的 state 不是本次 attempt → 一次兑换都不发，按关窗结算", async () => {
  const qrPort = fakeQrPort();
  const window = qrWindowHost();
  let exchangeCalls = 0;
  const { auth, broadcasts } = managerOf({
    qrPort,
    host: window.host,
    exchangeCode: async () => {
      exchangeCalls += 1;
      return { ok: true, data: ACCOUNT_TOKENS };
    },
  });
  await auth.startQrLogin();
  qrPort.confirm({ callbackUrl: R36_CALLBACK_PAGE });
  await flush();

  window.conclude({ status: "callback", url: "hms://redirect_uri?code=CODE-WEB&state=NOT-MINE" });
  await flush();

  assert.equal(exchangeCalls, 0, "陌生的 state：兑换链一步都不许走");
  assert.equal(auth.status().loggedIn, false);
  const qr = qrEvents(broadcasts).at(-1);
  assert.equal(qr.status, "failed");
  assert.equal(statusEvents(broadcasts).at(-1).busy, false);
});

test("R36 收场：webview 首载失败 / 总超时 → 原类别原文案落到 auth:qr（不假成功、也不静默）", async () => {
  const cases = [
    {
      conclusion: { status: "load_failed", message: "无法打开华为官方登录页面，请检查网络或代理后重试。" },
      kind: AUTH_ERROR_KINDS.loginPageUnavailable,
      pattern: /官方登录页面/,
    },
    {
      conclusion: { status: "timed_out", message: "登录超时（10 分钟内未完成扫码），请重试。" },
      kind: AUTH_ERROR_KINDS.timedOut,
      pattern: /超时/,
    },
  ];
  for (const one of cases) {
    const qrPort = fakeQrPort();
    const window = qrWindowHost();
    const { auth, broadcasts } = managerOf({ qrPort, host: window.host });
    await auth.startQrLogin();
    qrPort.confirm({ callbackUrl: R36_CALLBACK_PAGE });
    await flush();

    window.conclude(one.conclusion);
    await flush();

    const qr = qrEvents(broadcasts).at(-1);
    assert.equal(qr.status, "failed", `${one.conclusion.status}：界面上必须有可点的东西`);
    assert.equal(qr.errorKind, one.kind);
    assert.match(qr.message, one.pattern);
    assert.equal(statusEvents(broadcasts).at(-1).busy, false);
    assert.equal(auth.status().loggedIn, false);
  }
});

test("R36 状态行（渲染层零改动）：确认之后那一行是「已确认，正在完成登录…」，收尾完成即「已登录。」", () => {
  // 正常流程：渲染层没按过任何入口，path 仍是 qr —— 状态行跟着 qr.status 走（既有文案）
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.qrRequested });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: "scanned" });
  assert.equal(loginGateStatusLine(state), "已扫码，请在手机上确认。");

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: "confirmed" });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: true });
  assert.equal(
    loginGateStatusLine(state),
    "已确认，正在完成登录…",
    "webview 开着期间那一行就是这句既有文案（渲染层一行未改）",
  );

  // 收尾完成 → 进主界面
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: true, busy: false });
  assert.equal(loginGateStatusLine(state), "已登录。");

  /**
   * 对照（**如实登记，不改渲染层**）：网页登录那条路（渲染层自己按了入口，`path === "official"`）
   * 在 busy 期间显示的是 R27 的「正在打开华为官方登录页…」——`loginOpeningIndicator` 与
   * `loginGateStatusLine` 里那句「已在网页中打开登录。」判据完全相同（`busy && path === "official"`），
   * 前者先命中，所以后者在当前渲染层是**不可达**的一句。
   *
   * 二维码这条路更不会走到那里：渲染层没按过任何入口，`path` 一直是 `qr`。所以本轮"webview 打开后
   * 照常显示"的落点是**上面那句「已确认，正在完成登录…」**（见 task-36 报告的门禁状态行一节）。
   */
  let official = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false });
  official = reduceGateState(official, { type: LOGIN_GATE_EVENT.started });
  official = reduceGateState(official, { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: true });
  assert.equal(loginGateStatusLine(official), LOGIN_OPENING_TEXT, "busy 期间：R27 那句「正在打开…」");
  assert.equal(
    loginGateStatusLine(reduceGateState(official, { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false })),
    "官方登录页已收起（可以再打开一次）",
    "收起之后那一档照旧",
  );
});

// ---------------------------------------------------------------------------
// R53：登录态一旦确立（任何来源）就停掉在跑的二维码轮询
// ---------------------------------------------------------------------------
// `announce()` 是所有来源的收口：restore 成功 / 扫码收尾成功 / 网页登录成功。

test("R53 登录态确立：恢复成功时停掉正在跑的二维码会话（不再有后续轮询）", async () => {
  let releaseVerify;
  const verifying = new Promise((resolve) => {
    releaseVerify = resolve;
  });
  const store = {
    async saveMusicSession(session) {
      return { path: "C:\\data\\session.enc", modeApplied: true, modeNote: null };
    },
    async loadMusicSession() {
      return MUSIC_SESSION;
    },
    async clearMusicSession() {
      return true;
    },
  };
  const qrPort = fakeQrPort();
  const { auth } = managerOf({
    qrPort,
    sessionStore: store,
    verifySession: () => verifying,
  });

  const restoring = auth.restore();
  await new Promise((resolve) => setImmediate(resolve));
  // 恢复期间建一张码（正是"已登录冷启动后台还在轮询"的场景）
  const started = await auth.startQrLogin();
  assert.equal(started.ok, true, "恢复期间端口确实开了（这条测试不是空转）");
  assert.equal(qrPort.state.cancelled, 0);

  releaseVerify({ ok: true, data: { total: 3 } });
  const restored = await restoring;

  assert.equal(restored.loggedIn, true);
  assert.equal(
    qrPort.state.cancelled,
    1,
    "登录态确立时必须停掉二维码轮询（一条 cancel 就够：既停轮询也作废待兑换的尝试）",
  );
  assert.deepEqual(
    qrPort.state.starts.length,
    1,
    "只有恢复期间那一张码：登录态确立之后不许再建新的",
  );
  assert.equal(auth.statusSnapshot().loggedIn, true);
});

test("R53 只认「已登录」：结论是未登录时二维码会话照旧跑（真未登录的冷启动行为不变）", async () => {
  const qrPort = fakeQrPort();
  const { auth } = managerOf({ qrPort });

  const restored = await auth.restore();
  assert.equal(restored.loggedIn, false, "没有会话文件 = 确定未登录");

  await auth.startQrLogin();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(qrPort.state.cancelled, 0, "未登录档不许顺手停掉二维码：那正是冷启动要显示的那一张");
  assert.equal(auth.statusSnapshot().loggedIn, false);
});
