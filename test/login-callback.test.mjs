/**
 * R4 协议原型层 · 登录回调与登录流程编排（src/protocols/login-callback.mjs）。
 *
 * 关键断言：回调识别精确（hms://redirect_uri）、state 常量时间比较、一次性消费、10 分钟过期、
 * 四收场（callback/cancelled/closed/timed_out）各自只结算一次，且**任何收场都必然清理**。
 * 计时器与宿主全部注入，测试不碰真实时钟/真实窗口。先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOGIN_ERROR_KINDS,
  LOGIN_FLOW_STATUS,
  LOGIN_TERMINAL_CALLBACK_ERROR_KINDS,
  LOGIN_TIMEOUT_MS,
  consumeCallback,
  createCallbackConsumer,
  isCallback,
  isAllowedLoginUrl,
  parseCallback,
  runLoginFlow,
} from "../src/protocols/login-callback.mjs";

const OK_URL = "hms://redirect_uri?code=CODE-1&state=STATE-1";

/** 假宿主：记录调用，可按需让某个方法抛错。 */
function fakeHost({ throwOnClose = false, throwOnCleanup = false, openLoginRejects = false } = {}) {
  const calls = [];
  return {
    calls,
    count(name) {
      return calls.filter((entry) => entry.name === name).length;
    },
    openLogin(url) {
      calls.push({ name: "openLogin", url });
      return openLoginRejects ? Promise.reject(new Error("建窗失败")) : undefined;
    },
    closeLogin() {
      calls.push({ name: "closeLogin" });
      if (throwOnClose) throw new Error("closeLogin 炸了");
    },
    cleanup() {
      calls.push({ name: "cleanup" });
      if (throwOnCleanup) throw new Error("cleanup 炸了");
    },
  };
}

/** 假计时器：把回调攥在手里，测试自己决定何时超时。 */
function fakeTimer() {
  const pending = new Map();
  const delays = [];
  const cleared = [];
  let seq = 0;
  return {
    delays,
    cleared,
    setTimer(fn, ms) {
      seq += 1;
      const handle = { id: seq, ms };
      delays.push(ms);
      pending.set(handle, fn);
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
      pending.delete(handle);
    },
    pendingCount: () => pending.size,
    fire() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, fn] of entries) fn();
    },
  };
}

function flowOf(options = {}) {
  const host = options.host ?? fakeHost();
  const timer = options.timer ?? fakeTimer();
  const flow = runLoginFlow({
    authorizeUrl: "https://example.invalid/authorize?state=STATE-1",
    expectedState: "STATE-1",
    host,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...options.flow,
  });
  return { flow, host, timer };
}

test("isCallback：只认 hms://redirect_uri（精确匹配，不放行同形钓鱼）", () => {
  for (const url of [
    "hms://redirect_uri?code=a&state=b",
    "hms://redirect_uri",
    "hms://redirect_uri/",
    "HMS://REDIRECT_URI?code=a",
  ]) {
    assert.equal(isCallback(url), true, `应识别为回调：${url}`);
  }
  for (const url of [
    "hms://redirect_uri.evil.com?code=a",
    "hms://evil.com/?code=a",
    "hms://other?code=a",
    "https://redirect_uri?code=a",
    "hms://user@redirect_uri?code=a",
    "hms://redirect_uri:8080?code=a",
    "hms://redirect_uri/other?code=a",
    "hms:/redirect_uri?code=a",
    "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=a",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isCallback(url), false, `不该识别为回调：${String(url)}`);
  }
});

test("parseCallback：正常回调解析出 code/state；缺参/重复参/错误参各归各类", () => {
  const good = parseCallback(OK_URL);
  assert.equal(good.ok, true);
  assert.deepEqual(good.data, { code: "CODE-1", state: "STATE-1" });

  const noCode = parseCallback("hms://redirect_uri?state=STATE-1");
  assert.equal(noCode.ok, false);
  assert.equal(noCode.error.kind, LOGIN_ERROR_KINDS.missingParams);

  const noState = parseCallback("hms://redirect_uri?code=CODE-1");
  assert.equal(noState.ok, false);
  assert.equal(noState.error.kind, LOGIN_ERROR_KINDS.missingParams);

  const dupCode = parseCallback("hms://redirect_uri?code=A&code=B&state=STATE-1");
  assert.equal(dupCode.ok, false);
  assert.equal(dupCode.error.kind, LOGIN_ERROR_KINDS.duplicateParams);

  const dupState = parseCallback("hms://redirect_uri?code=A&state=STATE-1&state=STATE-2");
  assert.equal(dupState.ok, false);
  assert.equal(dupState.error.kind, LOGIN_ERROR_KINDS.duplicateParams);

  const notCallback = parseCallback("https://example.invalid/?code=A&state=B");
  assert.equal(notCallback.ok, false);
  assert.equal(notCallback.error.kind, LOGIN_ERROR_KINDS.notCallback);
});

test("parseCallback：授权页回 error（如 access_denied）→ oauth_error，且错误文本不回显原始 URL 里的 code", () => {
  const denied = parseCallback("hms://redirect_uri?error=access_denied&error_description=user%20denied&state=STATE-1");
  assert.equal(denied.ok, false);
  assert.equal(denied.error.kind, LOGIN_ERROR_KINDS.oauthError);
  assert.match(denied.error.message, /access_denied/);

  const withCode = parseCallback("hms://redirect_uri?error=server_error&code=SECRET-CODE&state=STATE-1");
  assert.equal(withCode.ok, false);
  assert.equal(withCode.error.kind, LOGIN_ERROR_KINDS.oauthError);
  assert.doesNotMatch(withCode.error.message, /SECRET-CODE/);
});

test("consumeCallback：一次性消费 —— 同一 attempt 第二次必然 already_consumed", () => {
  const session = { expectedState: "STATE-1", now: () => 1_000 };
  const first = consumeCallback(OK_URL, session);
  assert.equal(first.ok, true);
  assert.equal(first.data.code, "CODE-1");

  const second = consumeCallback(OK_URL, session);
  assert.equal(second.ok, false);
  assert.equal(second.error.kind, LOGIN_ERROR_KINDS.alreadyConsumed);
});

test("consumeCallback：state 不匹配被拒（长度不同也不抛），且不消耗这次 attempt", () => {
  const session = { expectedState: "STATE-1", now: () => 1_000 };
  const mismatched = consumeCallback("hms://redirect_uri?code=C&state=STATE-2", session);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error.kind, LOGIN_ERROR_KINDS.stateMismatch);

  const differentLength = consumeCallback("hms://redirect_uri?code=C&state=STATE-1-LONGER", session);
  assert.equal(differentLength.ok, false);
  assert.equal(differentLength.error.kind, LOGIN_ERROR_KINDS.stateMismatch);

  assert.equal(consumeCallback(OK_URL, session).ok, true, "被拒的请求不算消耗");
});

test("consumeCallback：超过 10 分钟过期；边界两侧各自成立", () => {
  const at = (elapsed) => ({ expectedState: "S", createdAt: 1_000, now: () => 1_000 + elapsed });

  assert.equal(consumeCallback("hms://redirect_uri?code=C&state=S", at(LOGIN_TIMEOUT_MS - 1)).ok, true);
  assert.equal(consumeCallback("hms://redirect_uri?code=C&state=S", at(LOGIN_TIMEOUT_MS + 1)).error.kind, LOGIN_ERROR_KINDS.expired);
  assert.equal(LOGIN_TIMEOUT_MS, 10 * 60_000);
  assert.equal(LOGIN_TIMEOUT_MS, 600_000);
});

test("createCallbackConsumer：先看已消费、再看格式、最后比 state（错误类别稳定）", () => {
  const consumer = createCallbackConsumer({ expectedState: "S", now: () => 0 });
  assert.equal(consumer.isConsumed(), false);
  assert.equal(consumer.consume("https://example.invalid/?code=C&state=S").error.kind, LOGIN_ERROR_KINDS.notCallback);
  assert.equal(consumer.consume("hms://redirect_uri?state=S").error.kind, LOGIN_ERROR_KINDS.missingParams);
  assert.equal(consumer.consume("hms://redirect_uri?code=C&state=X").error.kind, LOGIN_ERROR_KINDS.stateMismatch);
  assert.equal(consumer.consume("hms://redirect_uri?code=C&state=S").ok, true);
  assert.equal(consumer.isConsumed(), true);
  assert.equal(consumer.consume("hms://redirect_uri?code=C&state=S").error.kind, LOGIN_ERROR_KINDS.alreadyConsumed);
});

test("isAllowedLoginUrl：华为登录域放行、精确例外放行；oauth-login2 与同形钓鱼域不放行", () => {
  assert.equal(isAllowedLoginUrl("https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?client_id=1"), true);
  assert.equal(isAllowedLoginUrl("https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=a"), true);
  assert.equal(isAllowedLoginUrl("https://login.cloud.huawei.com/"), true);
  assert.equal(isAllowedLoginUrl("https://oauth-login2.cloud.huawei.com/oauth2/v3/authorize"), false, "换区域主机必须复发故障前的显式决策，不默认放行");
  assert.equal(isAllowedLoginUrl("https://evil-huawei.com/"), false);
  assert.equal(isAllowedLoginUrl("https://huawei.com.evil.com/"), false);
  assert.equal(isAllowedLoginUrl("http://oauth-login1.cloud.huawei.com/oauth2/v3/authorize"), false, "降级到 http 一律不放行");
  assert.equal(isAllowedLoginUrl("hms://redirect_uri?code=a"), false, "回调不进导航白名单（由 isCallback 单独拦）");
  assert.equal(isAllowedLoginUrl(""), false);
  assert.equal(isAllowedLoginUrl(null), false);
});

test("runLoginFlow：开登录窗后回调交付 → callback + 一次性清理", async () => {
  const { flow, host } = flowOf();
  assert.equal(host.calls[0].name, "openLogin");
  assert.match(host.calls[0].url, /^https:\/\/example\.invalid\/authorize/);

  const consumed = flow.consumeCallback(OK_URL);
  assert.equal(consumed.ok, true);

  const settled = await flow.settled;
  assert.equal(settled.status, LOGIN_FLOW_STATUS.callback);
  assert.equal(settled.code, "CODE-1");
  assert.equal(settled.state, "STATE-1");
  assert.equal(flow.isSettled(), true);
  assert.equal(host.count("cleanup"), 1, "结束必清理一次");
  assert.equal(host.count("closeLogin"), 1);

  flow.cancel();
  flow.close();
  assert.equal(host.count("cleanup"), 1, "已结算后不得再清理");
  assert.equal(flow.consumeCallback(OK_URL).error.kind, LOGIN_ERROR_KINDS.alreadySettled, "结算后的回调一律拒收");
  assert.equal(host.count("cleanup"), 1);
});

test("runLoginFlow：取消/关闭/超时三条收场各自成立，且都清理并撤掉计时器", async () => {
  const cancelled = flowOf();
  assert.equal(cancelled.flow.cancel().ok, true);
  assert.equal((await cancelled.flow.settled).status, LOGIN_FLOW_STATUS.cancelled);
  assert.equal(cancelled.host.count("cleanup"), 1);

  const closed = flowOf();
  assert.equal(closed.flow.close().ok, true);
  assert.equal((await closed.flow.settled).status, LOGIN_FLOW_STATUS.closed);
  assert.equal(closed.host.count("cleanup"), 1);

  const timedOut = flowOf();
  assert.equal(timedOut.timer.pendingCount(), 1, "开窗即挂上超时计时器");
  timedOut.timer.fire();
  assert.equal((await timedOut.flow.settled).status, LOGIN_FLOW_STATUS.timedOut);
  assert.equal(timedOut.host.count("cleanup"), 1);
  assert.equal(timedOut.timer.pendingCount(), 0, "结算后不留悬挂计时器");
  assert.equal(timedOut.timer.cleared.length, 1, "计时器句柄要被显式清掉");
});

test("runLoginFlow：超时时长可注入，默认取 LOGIN_TIMEOUT_MS（10 分钟单一真源）", async () => {
  const custom = flowOf({ flow: { timeoutMs: 5_000 } });
  assert.deepEqual(custom.timer.delays, [5_000], "注入的 timeoutMs 生效");
  custom.flow.cancel();
  await custom.flow.settled;

  const defaults = flowOf({ flow: { timeoutMs: undefined } });
  assert.deepEqual(defaults.timer.delays, [LOGIN_TIMEOUT_MS], "显式 undefined 也必须回落到默认 10 分钟");
  defaults.flow.cancel();
  await defaults.flow.settled;
});

test("runLoginFlow：宿主把窗内每个导航 URL 都喂进来（not_callback）不结算 —— 登录流照常等真回调", async () => {
  const { flow, host, timer } = flowOf();

  for (const url of [
    "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?client_id=101444301",
    "https://login.cloud.huawei.com/",
    "about:blank",
    "hms://evil.com/?code=C&state=STATE-1",
  ]) {
    const rejected = flow.consumeCallback(url);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.kind, LOGIN_ERROR_KINDS.notCallback, `普通导航应归 not_callback：${url}`);
    assert.equal(flow.isSettled(), false, `普通导航不得结算登录流（否则一次页面跳转就永久杀死登录）：${url}`);
  }
  assert.equal(host.count("cleanup"), 0, "未结算就不得清理：清理只发生在收场");
  assert.equal(timer.pendingCount(), 1, "超时计时器仍在等，没有被误撤");

  assert.equal(flow.consumeCallback(OK_URL).ok, true, "宿主预滤或不预滤都救得回来：真回调仍然成功");
  const settled = await flow.settled;
  assert.equal(settled.status, LOGIN_FLOW_STATUS.callback);
  assert.equal(settled.code, "CODE-1");
  assert.equal(host.count("cleanup"), 1);
});

test("runLoginFlow：外来 state 不符的回调不结算（陈旧/攻击性回调不得杀死正在等的 attempt）", async () => {
  const { flow, host } = flowOf();

  const foreign = flow.consumeCallback("hms://redirect_uri?code=FOREIGN&state=OTHER-STATE");
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.kind, LOGIN_ERROR_KINDS.stateMismatch);
  assert.equal(flow.isSettled(), false, "state 不符只是拒掉这一次回调，不终局");
  assert.equal(host.count("cleanup"), 0);

  assert.equal(flow.consumeCallback(OK_URL).ok, true, "用户的真回调随后仍然成功");
  const settled = await flow.settled;
  assert.equal(settled.status, LOGIN_FLOW_STATUS.callback);
  assert.equal(settled.code, "CODE-1", "成功用的是真回调的 code，不是外来回调的");
  assert.equal(host.count("cleanup"), 1);
});

test("runLoginFlow：终局错误边界 —— 授权页拒绝→cancelled，回调残缺→failed（这些确实不该再等）", async () => {
  const denied = flowOf();
  denied.flow.consumeCallback("hms://redirect_uri?error=access_denied&state=STATE-1");
  const deniedResult = await denied.flow.settled;
  assert.equal(deniedResult.status, LOGIN_FLOW_STATUS.cancelled);
  assert.equal(denied.host.count("cleanup"), 1);

  const missing = flowOf();
  const missingResult = missing.flow.consumeCallback("hms://redirect_uri?state=STATE-1");
  assert.equal(missingResult.error.kind, LOGIN_ERROR_KINDS.missingParams);
  assert.equal((await missing.flow.settled).status, LOGIN_FLOW_STATUS.failed);
  assert.equal(missing.host.count("cleanup"), 1);

  const duplicated = flowOf();
  duplicated.flow.consumeCallback("hms://redirect_uri?code=A&code=B&state=STATE-1");
  assert.equal((await duplicated.flow.settled).status, LOGIN_FLOW_STATUS.failed);
  assert.equal(duplicated.host.count("cleanup"), 1);
});

test("终局错误分类：显式钉住哪些回调错误会结算登录流（新增 kind 必须显式归类，不许默认终局）", () => {
  assert.deepEqual(LOGIN_TERMINAL_CALLBACK_ERROR_KINDS, [
    LOGIN_ERROR_KINDS.oauthError,
    LOGIN_ERROR_KINDS.missingParams,
    LOGIN_ERROR_KINDS.duplicateParams,
    LOGIN_ERROR_KINDS.expired,
  ]);
  for (const kind of [LOGIN_ERROR_KINDS.notCallback, LOGIN_ERROR_KINDS.stateMismatch]) {
    assert.equal(LOGIN_TERMINAL_CALLBACK_ERROR_KINDS.includes(kind), false, `不得把 ${kind} 当终局：会杀死正在等的登录流`);
  }
  // 穷尽归类：每个错误类别要么在终局表里，要么在"不结算"一侧被点名
  const nonTerminal = Object.values(LOGIN_ERROR_KINDS)
    .filter((kind) => !LOGIN_TERMINAL_CALLBACK_ERROR_KINDS.includes(kind))
    .sort();
  assert.deepEqual(nonTerminal, [
    LOGIN_ERROR_KINDS.alreadyConsumed,
    LOGIN_ERROR_KINDS.alreadySettled,
    LOGIN_ERROR_KINDS.notCallback,
    LOGIN_ERROR_KINDS.openFailed,
    LOGIN_ERROR_KINDS.stateMismatch,
  ].sort(), "新增 kind 时必须显式决定它是否终局，而不是落到「默认结算」");
});

test("runLoginFlow：开窗失败也如实结算 failed 并清理（不假装在等扫码）", async () => {
  const { flow, host } = flowOf({ host: fakeHost({ openLoginRejects: true }) });
  const settled = await flow.settled;
  assert.equal(settled.status, LOGIN_FLOW_STATUS.failed);
  assert.equal(host.count("cleanup"), 1);
});

test("runLoginFlow：清理自身抛错不吞掉主结论，但仍如实记录（清理必发生）", async () => {
  const { flow, host } = flowOf({ host: fakeHost({ throwOnClose: true, throwOnCleanup: true }) });
  flow.consumeCallback(OK_URL);
  const settled = await flow.settled;
  assert.equal(settled.status, LOGIN_FLOW_STATUS.callback, "清理失败不得改写收场结论");
  assert.equal(host.count("closeLogin"), 1);
  assert.equal(host.count("cleanup"), 1, "closeLogin 抛错后 cleanup 仍必须被调用");
  assert.ok(settled.cleanupError, "清理失败要如实带出，不能静默");
});

test("runLoginFlow：宿主缺少必需方法 → 构造期就抛（不静默跑一半）", () => {
  assert.throws(() => runLoginFlow({ authorizeUrl: "https://example.invalid/a", expectedState: "S", host: {} }), TypeError);
  assert.throws(
    () => runLoginFlow({ authorizeUrl: "https://example.invalid/a", expectedState: "S", host: { openLogin() {}, closeLogin() {} } }),
    TypeError,
  );
  assert.throws(() => runLoginFlow({ authorizeUrl: "", expectedState: "S", host: fakeHost() }), TypeError);
  assert.throws(() => runLoginFlow({ authorizeUrl: "https://example.invalid/a", expectedState: "", host: fakeHost() }), TypeError);
});
