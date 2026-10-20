/**
 * R7 认证状态机（src/main/auth-manager.ts）：login / restore / logout 三条路径 + sessionEpoch 过渡。
 *
 * 全部外部依赖注入（宿主、令牌兑换、音乐会话兑换、会话存储、验证、广播），测试不碰真实时钟、
 * 真实网络与真实磁盘。重点钉住的是**失败路径的诚实性**：
 * - 四收场（callback/cancelled/closed/timed_out）各自映射成面向用户的 kind 与文案；
 * - 首载超时（打不开官方页）与总超时是两条不同的结论、两句不同的话；
 * - loginex 端点未知 → 结构化「待联调」错误，绝不猜 URL、绝不发请求；
 * - 保存失败但有旧会话 → 保留旧会话并如实报错（R5 语义）；
 * - restore 的失效与「无法验证」必须分开报（网络抖动不等于会话失效）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAttempt } from "../src/protocols/auth.mjs";
import { LOGIN_TIMEOUT_MS } from "../src/protocols/login-callback.mjs";
import { APP_NOTICE, AUTH_STATUS } from "../src/shared/channels.ts";
import {
  AUTH_ERROR_KINDS,
  HUAWEI_OAUTH_ENDPOINTS,
  createAuthManager,
} from "../src/main/auth-manager.ts";
import { LOGIN_PAGE_UNAVAILABLE_MESSAGE, LOGIN_TIMEOUT_MESSAGE } from "../src/main/huawei.ts";

const AUTHORIZE_URL = `${HUAWEI_OAUTH_ENDPOINTS.authorize}?client_id=101444301&state=S`;
const MUSIC_SESSION = { musicSession: "user$abc", userId: "42" };
const ACCOUNT_TOKENS = { accessToken: "AT-1", refreshToken: "RT-1", expiresAt: 1_700_000_000_000 };

/**
 * 造一个"真回调"URL：state 必须是**本次 attempt** 的 state。
 *
 * 这条 helper 本身就是契约的体现：宿主交回的是官方页跳到的那个 URL，state 由 attempt 生成，
 * 测试要是自己编一个 state，测的就是"state 不匹配"那条路（也值得测，但别混进成功链）。
 */
function callbackUrl(host, code = "CODE-1") {
  const state = new URL(host.opened[0].url).searchParams.get("state");
  return `hms://redirect_uri?code=${code}&state=${state}`;
}

/**
 * 假宿主：`openLoginPage` 的结论由测试用 resolve 显式交付（模拟 Rust 窗关闭后答复）。
 *
 * 交付的是**已经解析好的宿主结论**（`{status, url?, message?}`）：线上形状的解析归
 * `src/main/huawei.ts`，由 test/huawei.test.mjs 单独钉住；auth-manager 只面对端口形状。
 */
function fakeHost() {
  const opened = [];
  let settle;
  const host = {
    opened,
    openLoginPage(params) {
      opened.push(params);
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    cancelLogin: () => Promise.resolve({ ok: true, data: { cancelled: true } }),
    cleanup() {},
  };
  return {
    host,
    conclude: (conclusion) => settle.resolve(conclusion),
    failOpen: (error) => settle.reject(error),
    opened,
  };
}

function fakeSessionStore({ saved = [], loaded = null, failSave = null } = {}) {
  const calls = [];
  return {
    calls,
    saved,
    async saveMusicSession(session) {
      calls.push(["save", session]);
      if (failSave) throw failSave;
      saved.push(session);
      return { path: "C:\\data\\session.enc", modeApplied: true, modeNote: null };
    },
    async loadMusicSession() {
      calls.push(["load"]);
      return loaded;
    },
    async clearMusicSession() {
      calls.push(["clear"]);
      return true;
    },
  };
}

/** 造一个管理器：默认全成功的端口，按需覆写。 */
function managerOf(overrides = {}) {
  const host = overrides.host ?? fakeHost();
  const broadcasts = [];
  const notices = [];
  const store = overrides.sessionStore ?? fakeSessionStore();
  const auth = createAuthManager({
    host: host.host ?? host,
    sessionStore: store,
    exchangeCode: overrides.exchangeCode ?? (async () => ({ ok: true, data: ACCOUNT_TOKENS })),
    exchangeMusicSession: overrides.exchangeMusicSession ?? (async () => ({ ok: true, data: MUSIC_SESSION })),
    verifySession: overrides.verifySession ?? (async () => ({ ok: true, data: { total: 3 } })),
    clearPersonalCache: overrides.clearPersonalCache,
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
  return { auth, host, store, broadcasts, notices };
}

/**
 * 起一个登录并交付指定结论。
 *
 * `conclusion` 可以是结论对象，也可以是 `(host) => 结论`——回调类结论必须从开窗参数里取
 * 本次 attempt 的 state（见 `callbackUrl`）。
 */
async function loginWith(conclusion, overrides = {}) {
  const context = managerOf(overrides);
  const pending = context.auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  context.host.conclude(typeof conclusion === "function" ? conclusion(context.host) : conclusion);
  const result = await pending;
  return { ...context, result };
}

/** 真回调结论（state 取自本次 attempt）。 */
function realCallback(host) {
  return { status: "callback", url: callbackUrl(host) };
}

test("login 成功链：createAttempt → 开窗 → 回调 → 换 AT → 换音乐会话 → 验证 → 存盘 → 广播", async () => {
  const exchanged = [];
  const { auth, host, store, broadcasts, result } = await loginWith(
    realCallback,
    {
      exchangeCode: async ({ endpoint, code, codeVerifier }) => {
        exchanged.push({ endpoint, code, codeVerifier });
        return { ok: true, data: ACCOUNT_TOKENS };
      },
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.session, MUSIC_SESSION);
  assert.equal(typeof result.data.epoch, "number");

  // 开窗参数：官方授权页 + 一次性的 partition + 顶部内缩（Rust 侧再校验一遍）
  assert.equal(host.opened.length, 1);
  assert.match(host.opened[0].url, /^https:\/\/oauth-login1\.cloud\.huawei\.com\/oauth2\/v3\/authorize\?/);
  assert.match(host.opened[0].url, /code_challenge_method=S256/);
  assert.equal(typeof host.opened[0].partition, "undefined");
  assert.deepEqual(
    Object.keys(host.opened[0]),
    ["url"],
    "分区与顶部内缩由 huawei.ts 统一填（auth-manager 不写第二份）",
  );

  // 兑换用的是 R4 已确认的 token 端点与本次 attempt 的 code_verifier（PKCE 不许串台）
  assert.equal(exchanged.length, 1);
  assert.equal(exchanged[0].endpoint, HUAWEI_OAUTH_ENDPOINTS.token);
  assert.equal(exchanged[0].code, "CODE-1");
  assert.match(exchanged[0].codeVerifier, /^[A-Za-z0-9_-]{43}$/);

  assert.deepEqual(store.calls, [["save", MUSIC_SESSION]], "成功链恰好存一次盘");
  assert.deepEqual(
    broadcasts.at(-1),
    { channel: AUTH_STATUS, payload: { loggedIn: true, busy: false } },
    "成功收口：已登录 + 空闲（结论只在广播里，auth:login 那条链路只回「已受理」）",
  );
  assert.ok(
    broadcasts.every((entry) => entry.channel === AUTH_STATUS),
    "登录状态只走 auth:status 广播（app:notice 留给宿主级提示）",
  );
});

test("login：四收场各自映射成面向用户的 kind 与文案（哪一条都不许说成「成功」）", async () => {
  const cancelled = await loginWith({ status: "cancelled" });
  assert.equal(cancelled.result.ok, false);
  assert.equal(cancelled.result.error.kind, AUTH_ERROR_KINDS.cancelled);
  assert.deepEqual(cancelled.store.calls, []);
  assert.equal(cancelled.broadcasts.at(-1).payload.loggedIn, false);

  const closed = await loginWith({ status: "closed" });
  assert.equal(closed.result.error.kind, AUTH_ERROR_KINDS.closed);

  const timedOut = await loginWith({ status: "timed_out", message: LOGIN_TIMEOUT_MESSAGE });
  assert.equal(timedOut.result.error.kind, AUTH_ERROR_KINDS.timedOut);
  assert.equal(timedOut.result.error.message, LOGIN_TIMEOUT_MESSAGE);

  // 首载超时（打不开官方页）与总超时必须是两条不同的结论、两句不同的话
  const loadFailed = await loginWith({ status: "load_failed", message: LOGIN_PAGE_UNAVAILABLE_MESSAGE });
  assert.equal(loadFailed.result.error.kind, AUTH_ERROR_KINDS.loginPageUnavailable);
  assert.equal(loadFailed.result.error.message, LOGIN_PAGE_UNAVAILABLE_MESSAGE);
  assert.notEqual(loadFailed.result.error.message, timedOut.result.error.message);
});

test("login：宿主开窗失败（结构化错误）→ open_failed，不假装在等扫码", async () => {
  const context = managerOf();
  const pending = context.auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  context.host.failOpen({ message: "已有一次登录正在进行", kind: "login_in_progress" });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "login_in_progress");
});

test("login：令牌兑换失败 / loginex 端点被显式关掉 / 会话验证失败 都在存盘之前停下", async () => {
  const exchangeFailed = await loginWith(
    realCallback,
    { exchangeCode: async () => ({ ok: false, error: { message: "token 端点返回 HTTP 400", kind: "http_error" } }) },
  );
  assert.equal(exchangeFailed.result.ok, false);
  assert.equal(exchangeFailed.result.error.kind, "http_error");
  assert.deepEqual(exchangeFailed.store.calls, [], "兑换失败不得落盘");

  // loginex：端点被**显式注入 null** → 结构化「待联调」，且**一次请求都不发**。
  //
  // R17 之前这条测的是"没注入时的默认行为"（那时默认值就是 null）。R17 把默认值换成
  // R17 确认过的真端点之后，"不猜 URL、不发请求"这条不变式就搬到了**显式关掉**这一档：
  // 这里注入 `endpoints: { loginex: null }`，并注入一个**一旦被调用就失败**的兑换端口——
  // 于是"没发请求"不再靠"默认实现恰好什么都不做"来保证，而是被直接钉住。
  const host = fakeHost();
  const store = fakeSessionStore();
  let exchanged = 0;
  const auth = createAuthManager({
    host: host.host,
    sessionStore: store,
    endpoints: { loginex: null },
    exchangeMusicSession: async () => {
      exchanged += 1;
      return { ok: false, error: { message: "不该被调用", kind: "internal" } };
    },
    exchangeCode: async () => ({ ok: true, data: ACCOUNT_TOKENS }),
    verifySession: async () => ({ ok: true, data: { total: 1 } }),
    log: () => {},
  });
  const pending = auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  host.conclude(realCallback(host));
  const loginexResult = await pending;
  assert.equal(loginexResult.ok, false, JSON.stringify(loginexResult));
  assert.equal(loginexResult.error.kind, AUTH_ERROR_KINDS.loginexPending);
  assert.match(loginexResult.error.message, /不猜 URL/);
  assert.equal(exchanged, 0, "端点被关掉时兑换端口一次都不许被调用");
  assert.deepEqual(store.calls, [], "端点关闭时连会话都不该落盘");

  const verifyFailed = await loginWith(
    realCallback,
    { verifySession: async () => ({ ok: false, error: { message: "会话无效", kind: "session_invalid" } }) },
  );
  assert.equal(verifyFailed.result.ok, false);
  assert.equal(verifyFailed.result.error.kind, AUTH_ERROR_KINDS.sessionInvalid);
  assert.deepEqual(verifyFailed.store.calls, []);
});

test("login：会话验证因端点未注入而失败 → 按原样上报缺口，不伪装成会话失效", async () => {
  const { result, broadcasts } = await loginWith(
    realCallback,
    { verifySession: async () => ({ ok: false, error: { message: "端点未注入", kind: "endpoint_unknown" } }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "endpoint_unknown", "验证缺口的类别要原样上报（上层才能区分「没验」与「验不过」）");
  assert.notEqual(result.error.kind, AUTH_ERROR_KINDS.sessionInvalid);
  assert.equal(broadcasts.at(-1).payload.loggedIn, false, "没验过就不许广播已登录");
});

test("login：保存失败但有旧会话 → 保留旧会话并如实报错（R5 语义），epoch 不前进", async () => {
  const store = fakeSessionStore({ failSave: Object.assign(new Error("落盘失败"), { kind: "internal" }) });
  const { auth, broadcasts, result } = await loginWith(
    realCallback,
    { sessionStore: store },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "internal");
  assert.match(result.error.message, /落盘失败/);
  assert.equal(broadcasts.at(-1).payload.loggedIn, false, "存盘没成功就不能广播已登录");
  assert.equal(auth.status().epoch, 0, "保存失败不得推进 epoch（在途请求仍绑旧会话）");
});

test("login：取消链（渲染层主动取消）→ 宿主取消 + 结构化 cancelled", async () => {
  const context = managerOf();
  const pending = context.auth.login();
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = await context.auth.cancelLogin();
  assert.equal(cancelled.ok, true);
  context.host.conclude({ status: "cancelled" });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, AUTH_ERROR_KINDS.cancelled);
});

test("login：并排第二次登录被拒（结构化），不会开出第二个窗", async () => {
  const context = managerOf();
  const first = context.auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await context.auth.login();
  assert.equal(second.ok, false);
  assert.equal(second.error.kind, AUTH_ERROR_KINDS.loginInProgress);
  assert.equal(context.host.opened.length, 1, "第二次不得再开窗");

  context.host.conclude({ status: "cancelled" });
  await first;
});

test("restore：没有会话文件 → 未登录（这不是错误，也不广播宿主级提示）", async () => {
  const { auth, notices, broadcasts } = managerOf();
  const status = await auth.restore();
  assert.equal(status.loggedIn, false);
  assert.equal(status.reason, "no_session");
  assert.equal(status.verified, false);
  assert.deepEqual(notices, [], "没有会话是正常状态：不该弹提示");
  assert.deepEqual(broadcasts.at(-1), {
    channel: AUTH_STATUS,
    payload: { loggedIn: false, busy: false },
  });
});

test("restore：会话有效 → 验证通过 → 已登录；epoch 从 1 开始（内存会话也带 epoch）", async () => {
  const store = fakeSessionStore({ loaded: MUSIC_SESSION });
  const verified = [];
  const { auth, broadcasts } = managerOf({
    sessionStore: store,
    verifySession: async (session) => {
      verified.push(session);
      return { ok: true, data: { total: 1 } };
    },
  });
  const status = await auth.restore();
  assert.equal(status.loggedIn, true);
  assert.equal(status.verified, true);
  assert.deepEqual(verified, [MUSIC_SESSION]);
  const current = auth.currentSession();
  assert.deepEqual(current.session, MUSIC_SESSION);
  assert.ok(current.epoch >= 1);
  assert.deepEqual(
    broadcasts.at(-1),
    { channel: AUTH_STATUS, payload: { loggedIn: true, busy: false } },
    "成功收口：已登录 + 空闲（结论只在广播里，auth:login 那条链路只回「已受理」）",
  );
});

test("restore：会话失效（验证被拒）与无法验证（端点未知）是两件事，分开如实报", async () => {
  const invalid = managerOf({
    sessionStore: fakeSessionStore({ loaded: MUSIC_SESSION }),
    verifySession: async () => ({ ok: false, error: { message: "会话无效", kind: "session_invalid" } }),
  });
  const invalidStatus = await invalid.auth.restore();
  assert.equal(invalidStatus.loggedIn, false);
  assert.equal(invalidStatus.reason, "session_invalid");
  assert.equal(invalidStatus.sessionKept, false, "失效会话不留在内存里");

  const unverifiable = managerOf({
    sessionStore: fakeSessionStore({ loaded: MUSIC_SESSION }),
    verifySession: async () => ({ ok: false, error: { message: "端点未注入", kind: "endpoint_unknown" } }),
  });
  const unverifiableStatus = await unverifiable.auth.restore();
  assert.equal(unverifiableStatus.loggedIn, true, "无法验证不是失效：会话仍在，界面照常进主界面");
  assert.equal(unverifiableStatus.verified, false, "但必须如实说自己没验过");
  assert.equal(unverifiableStatus.reason, "verify_unavailable");
  assert.equal(
    unverifiable.auth.currentSession().session.musicSession,
    MUSIC_SESSION.musicSession,
    "未验证的会话仍在内存里（业务请求会自己报端点缺口）",
  );
});

test("restore：会话文件打不开（信封坏了 / 后端不可用）→ 如实报错，不当成「没有会话」", async () => {
  const broken = managerOf({
    sessionStore: {
      async saveMusicSession() {},
      async loadMusicSession() {
        throw Object.assign(new Error("session.enc 已损坏"), { kind: "invalid_envelope" });
      },
      async clearMusicSession() {
        return true;
      },
    },
  });
  const status = await broken.auth.restore();
  assert.equal(status.loggedIn, false);
  assert.equal(status.reason, "session_unreadable");
  assert.equal(status.error.kind, "invalid_envelope");
  assert.match(status.error.message, /损坏/);
  assert.ok(
    broken.notices.some((text) => text.includes("会话")),
    "读不出来的会话必须让用户看见（不能静默降级成「未登录」）",
  );
});

test("logout：清会话 + 清个人数据缓存 + 广播未登录；两件事的成败各自如实上报", async () => {
  const store = fakeSessionStore({ loaded: MUSIC_SESSION });
  const cleared = [];
  const { auth, broadcasts } = managerOf({
    sessionStore: store,
    clearPersonalCache: async () => {
      cleared.push(Date.now());
      return { ok: true, data: { cleared: 3 } };
    },
  });
  await auth.restore();
  const result = await auth.logout();

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.sessionCleared, true);
  assert.equal(result.data.cacheCleared, true);
  assert.equal(cleared.length, 1);
  assert.deepEqual(store.calls.filter((call) => call[0] === "clear").length, 1);
  assert.equal(auth.currentSession().session, null);
  assert.deepEqual(broadcasts.at(-1), {
    channel: AUTH_STATUS,
    payload: { loggedIn: false, busy: false },
  });

  // 缓存清理器抛错：会话照样清掉，但如实报告缓存没清
  const failing = managerOf({
    sessionStore: fakeSessionStore({ loaded: MUSIC_SESSION }),
    clearPersonalCache: async () => {
      throw new Error("缓存目录被占用");
    },
  });
  await failing.auth.restore();
  const partial = await failing.auth.logout();
  assert.equal(partial.ok, true);
  assert.equal(partial.data.cacheCleared, false);
  assert.match(partial.data.notes.join("；"), /缓存/);
});

test("epoch 过渡：每次会话变更 epoch 前进一次，在途请求绑的是旧 epoch", async () => {
  const store = fakeSessionStore({ loaded: MUSIC_SESSION });
  const { auth, host } = managerOf({ sessionStore: store });
  await auth.restore();
  const restored = auth.currentSession();

  const pending = auth.login();
  await new Promise((resolve) => setImmediate(resolve));
  host.conclude(realCallback(host));
  await pending;

  const afterLogin = auth.currentSession();
  assert.ok(afterLogin.epoch > restored.epoch, "登录成功必须推进 epoch");
  assert.deepEqual(afterLogin.session, MUSIC_SESSION);

  await auth.logout();
  const afterLogout = auth.currentSession();
  assert.equal(afterLogout.session, null);
  assert.ok(afterLogout.epoch > afterLogin.epoch, "登出也要推进 epoch（清掉个人数据缓存的依据）");
});

test("边界：认证状态机自己不发 HTTP（兑换与验证全部由调用方注入）", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/main/auth-manager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "auth-manager 不得自己发请求：端点与请求形状都必须注入");
  assert.doesNotMatch(source, /undici/, "也不得自己挑 HTTP 客户端");
});

test("端点真源：默认端点就是 docs/API_CONTRACT.md 登记的值（含 R17 确认的 loginex）", async () => {
  const contract = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../docs/API_CONTRACT.md", import.meta.url), "utf8"),
  );
  assert.ok(contract.includes(HUAWEI_OAUTH_ENDPOINTS.authorize), "authorize 端点必须是契约里登记的那一条");
  assert.ok(contract.includes(HUAWEI_OAUTH_ENDPOINTS.token), "token 端点必须是契约里登记的那一条");
  // R17：loginex 从「待联调」升到"有确认值"——默认值必须在契约里逐字出现（文档与代码不许各说各话）
  assert.ok(
    contract.includes(HUAWEI_OAUTH_ENDPOINTS.loginex),
    "loginex 端点必须是契约 §1.5 里登记的那一条（R17 确认值）",
  );
  assert.ok(
    contract.includes("api-drcn.music.dbankcloud.cn"),
    "契约里要写明音乐业务域（端点就是它拼出来的）",
  );

  const { auth } = managerOf();
  const attempt = createAttempt({ authorizeEndpoint: HUAWEI_OAUTH_ENDPOINTS.authorize });
  assert.match(attempt.authorizeUrl, /^https:\/\/oauth-login1\.cloud\.huawei\.com\/oauth2\/v3\/authorize/);
  assert.equal(LOGIN_TIMEOUT_MS, 600_000);
  assert.equal(
    auth.endpoints().loginex,
    HUAWEI_OAUTH_ENDPOINTS.loginex,
    "没注入时取默认值：R17 确认的 loginex 端点",
  );
  // 显式注入 null 是"关掉"而不是"取默认"：这一条钉住 `??` 与 `in` 的区别
  const closed = createAuthManager({
    host: fakeHost().host,
    sessionStore: fakeSessionStore(),
    endpoints: { loginex: null },
    log: () => {},
  });
  assert.equal(closed.endpoints().loginex, null, "显式注入 null 必须是「关掉」，不许被默认值顶掉");
});

// ---------------------------------------------------------------------------
// R19：状态快照（`auth:get-status` 的应答体）—— 与 `auth:status` 广播**同形状**
// ---------------------------------------------------------------------------
//
// 为什么需要它：`auth:status` 只在 sidecar 启动时广播一次（渲染层没就绪时由 Rust 排队），
// 渲染层 reload/崩溃重启之后那一条**已经冲刷过了**，门禁于是永远停在 `checking`。
// 这三条钉住"查询拿到的就是当前事实"：未登录 / 已登录 / 开窗那条路正在跑（busy）。

test("状态快照（R19）：没有会话时如实说未登录 + 空闲（不猜、也不带编出来的文案）", () => {
  const { auth } = managerOf();
  assert.deepEqual(auth.statusSnapshot(), { loggedIn: false, busy: false });
});

test("状态快照（R19）：有会话时如实说已登录（reload 之后门禁靠它放行，不必等一条不会再来的广播）", async () => {
  const { auth } = managerOf({ sessionStore: fakeSessionStore({ loaded: MUSIC_SESSION }) });
  const restored = await auth.restore();
  assert.equal(restored.loggedIn, true);
  assert.deepEqual(auth.statusSnapshot(), { loggedIn: true, busy: false });
});

test("状态快照（R19）：开窗那条路正在跑时 busy 为真，且与刚播出去的那条广播逐字一致", async () => {
  const context = managerOf();
  const pending = context.auth.login();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.deepEqual(
      context.broadcasts,
      [{ channel: AUTH_STATUS, payload: { loggedIn: false, busy: true } }],
      "login() 立刻播一条 busy:true（渲染层据此禁用常驻入口）",
    );
    assert.deepEqual(
      context.auth.statusSnapshot(),
      context.broadcasts[0].payload,
      "快照与广播必须是同一份事实：两边各算一份（例如现读 inFlight）早晚会漂移",
    );
  } finally {
    // 无论上面哪条红，都要把这次登录收场：`runLoginFlow` 挂着一枚 600 秒的期限定时器，
    // 不收场的话测试进程会一直挂在那里（失败的测试不该顺带把整轮 test 卡住）
    context.host.conclude(realCallback(context.host));
    await pending;
  }

  assert.deepEqual(context.auth.statusSnapshot(), { loggedIn: true, busy: false });
});

test("状态快照（R19）：形状就是广播那一份（只多不许少），文案**不进**快照", async () => {
  const { auth, broadcasts } = await loginWith({ status: "cancelled" });
  const last = broadcasts.at(-1);
  assert.equal(last.channel, AUTH_STATUS);
  assert.ok(last.payload.message, "失败那条广播带一句给人看的话");

  const snapshot = auth.statusSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["busy", "loggedIn"]);
  for (const key of Object.keys(snapshot)) {
    assert.ok(
      ["loggedIn", "busy", "message"].includes(key),
      `快照多出了广播形状里没有的字段：${key}（渲染层是按广播载荷读它的）`,
    );
  }
  assert.equal(snapshot.loggedIn, false, "取消之后没有会话");
});
