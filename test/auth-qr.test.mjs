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
// ---------------------------------------------------------------------------

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
