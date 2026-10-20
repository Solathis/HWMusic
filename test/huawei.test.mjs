/**
 * R7 登录宿主端口（src/main/huawei.ts）：openLoginPage / cancelLogin / cleanup 的 payload 形状、
 * 宿主结论的解析（status 分支 + 未知结论不猜）、partition 的一次性随机隔离，以及
 * `host:open-login` 的调用超时必须覆盖整段登录等待（默认 60 秒会把 10 分钟的扫码判成超时）。
 *
 * 为什么单独一个文件：这是 Node 与 Rust 之间**唯一的线上契约面**，形状错一点就是
 * "扫码成功却等超时"那类故障（C1）。宿主要求封装全部注入，测试不碰真窗口。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LOGIN_TIMEOUT_MS } from "../src/protocols/login-callback.mjs";
import { HOST_CANCEL_LOGIN, HOST_OPEN_LOGIN } from "../src/shared/request-channels.ts";
import {
  HOST_LOGIN_STATUS,
  LOGIN_HOST_TIMEOUT_MS,
  LOGIN_PAGE_UNAVAILABLE_MESSAGE,
  LOGIN_TIMEOUT_MESSAGE,
  createLoginHost,
  createPartition,
  parseHostConclusion,
} from "../src/main/huawei.ts";

/** 假 host-services：记录调用，可编程返回（形状与 src/host/host-services.mjs 一致）。 */
function fakeHostServices(replies = {}) {
  const calls = [];
  const invoke = (channel, method) => (payload = {}, options) => {
    calls.push({ channel, method, payload, options });
    const reply = replies[channel];
    if (typeof reply === "function") return Promise.resolve(reply(payload, options));
    return Promise.resolve(reply ?? { ok: true, data: null });
  };
  return {
    calls,
    openLogin: invoke(HOST_OPEN_LOGIN, "openLogin"),
    cancelLogin: invoke(HOST_CANCEL_LOGIN, "cancelLogin"),
  };
}

const AUTHORIZE_URL = "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?client_id=101444301&state=S";

test("分区：每次都是一次性随机值，且落在 Rust 的 [A-Za-z0-9_-]{1,64} 字符集内", () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const partition = createPartition();
    assert.match(partition, /^[A-Za-z0-9_-]{1,64}$/, `partition 不合 Rust 校验：${partition}`);
    assert.equal(seen.has(partition), false, "partition 必须一次性（同一个值复用等于没隔离）");
    seen.add(partition);
  }
  assert.ok(seen.size >= 190, "随机性不能退化成常量");
});

test("开窗：payload 形状 {url, partition}——R25 起 topInset 退休（登录页铺满整窗）", async () => {
  const services = fakeHostServices({ [HOST_OPEN_LOGIN]: { ok: true, data: { status: "cancelled" } } });
  const host = createLoginHost({ hostServices: services, partition: () => "p-test" });

  const conclusion = await host.openLoginPage({ url: AUTHORIZE_URL });
  assert.deepEqual(conclusion, { status: "cancelled" }, "宿主结论按解析后的形状交给流程");
  assert.equal(services.calls.length, 1);
  assert.equal(services.calls[0].channel, HOST_OPEN_LOGIN);
  assert.deepEqual(services.calls[0].payload, {
    url: AUTHORIZE_URL,
    partition: "p-test",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(services.calls[0].payload, "topInset"),
    false,
    "topInset 已从载荷里退休（用户四项之 3：网页不再被挤压）：留一个永远是 0 的旋钮只会让下一个人摆错页面",
  );
  assert.equal(LOGIN_HOST_TIMEOUT_MS > LOGIN_TIMEOUT_MS, true, "开窗调用要等满 10 分钟");
  assert.equal(services.calls[0].options.timeoutMs, LOGIN_HOST_TIMEOUT_MS);
});

test("开窗：调用方可以显式覆盖 partition（一次性隔离由调用方说了算时）", async () => {
  const services = fakeHostServices({ [HOST_OPEN_LOGIN]: { ok: true, data: { status: "closed" } } });
  const host = createLoginHost({ hostServices: services, partition: () => "unused" });
  await host.openLoginPage({ url: AUTHORIZE_URL, partition: "explicit-1" });
  assert.deepEqual(services.calls[0].payload, { url: AUTHORIZE_URL, partition: "explicit-1" });
});

test("开窗：宿主回结构化错误时如实抛出（不假装开好了）", async () => {
  const services = fakeHostServices({
    [HOST_OPEN_LOGIN]: { ok: false, error: { message: "已有一次登录正在进行", kind: "login_in_progress" } },
  });
  const host = createLoginHost({ hostServices: services, partition: () => "p1" });

  await assert.rejects(
    () => host.openLoginPage({ url: AUTHORIZE_URL }),
    (failure) => failure.kind === "login_in_progress" && /已有一次登录/.test(failure.message),
  );
});

test("开窗：宿主答复不是结论形状时结构化报错（不猜、不静默）", async () => {
  const services = fakeHostServices({ [HOST_OPEN_LOGIN]: { ok: true, data: { whatever: true } } });
  const host = createLoginHost({ hostServices: services, partition: () => "p1" });
  await assert.rejects(
    () => host.openLoginPage({ url: AUTHORIZE_URL }),
    (failure) => failure.kind === "invalid_host_conclusion",
  );
});

test("取消：走 host:cancel-login 宿主要求（不是本地假装关窗），payload 为空", async () => {
  const services = fakeHostServices({ [HOST_CANCEL_LOGIN]: { ok: true, data: { cancelled: true } } });
  const host = createLoginHost({ hostServices: services, partition: () => "p1" });

  const result = await host.cancelLogin();
  assert.equal(services.calls.length, 1);
  assert.equal(services.calls[0].channel, HOST_CANCEL_LOGIN);
  assert.equal(services.calls[0].method, "cancelLogin");
  assert.deepEqual(services.calls[0].payload, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.cancelled, true);
});

test("清理兜底：cleanup 请求宿主取消（防 Node 先结算而窗还开着），失败只记日志不外抛", async () => {
  const ok = fakeHostServices({ [HOST_CANCEL_LOGIN]: { ok: true, data: { cancelled: false } } });
  const host = createLoginHost({ hostServices: ok, partition: () => "p1" });
  host.cleanup();
  host.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ok.calls.length, 2, "cleanup 是幂等的兜底请求，不是只做一次");
  assert.ok(ok.calls.every((call) => call.channel === HOST_CANCEL_LOGIN));

  // 宿主已经不可用（core 收尸）：cleanup 不得把异常抛回结算路径（收场结论比兜底重要）
  const broken = fakeHostServices({
    [HOST_CANCEL_LOGIN]: () => {
      throw new Error("core 已退出");
    },
  });
  const host2 = createLoginHost({ hostServices: broken, partition: () => "p1" });
  assert.doesNotThrow(() => host2.cleanup());
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("宿主结论解析：五个 status 各自成形，缺 url 的 callback 与未知 status 一律结构化错误", () => {
  const callback = parseHostConclusion({
    ok: true,
    data: { status: "callback", url: "hms://redirect_uri?code=C&state=S" },
  });
  assert.equal(callback.ok, true);
  assert.deepEqual(callback.data, { status: "callback", url: "hms://redirect_uri?code=C&state=S" });

  for (const status of [HOST_LOGIN_STATUS.cancelled, HOST_LOGIN_STATUS.closed]) {
    const parsed = parseHostConclusion({ ok: true, data: { status } });
    assert.deepEqual(parsed, { ok: true, data: { status } });
  }

  const timedOut = parseHostConclusion({ ok: true, data: { status: "timed_out", message: LOGIN_TIMEOUT_MESSAGE } });
  assert.equal(timedOut.ok, true);
  assert.equal(timedOut.data.message, LOGIN_TIMEOUT_MESSAGE);

  const loadFailed = parseHostConclusion({
    ok: true,
    data: { status: "load_failed", message: LOGIN_PAGE_UNAVAILABLE_MESSAGE },
  });
  assert.equal(loadFailed.ok, true);
  assert.equal(loadFailed.data.message, LOGIN_PAGE_UNAVAILABLE_MESSAGE);

  // 文案缺省时回落到本模块的常量（宿主只回 status 也要能出人话）
  assert.equal(parseHostConclusion({ ok: true, data: { status: "timed_out" } }).data.message, LOGIN_TIMEOUT_MESSAGE);
  assert.equal(
    parseHostConclusion({ ok: true, data: { status: "load_failed" } }).data.message,
    LOGIN_PAGE_UNAVAILABLE_MESSAGE,
  );

  for (const bad of [
    { ok: true, data: { status: "callback" } },
    { ok: true, data: { status: "callback", url: "" } },
    { ok: true, data: { status: "callback", url: 42 } },
    { ok: true, data: { status: "not_a_status" } },
    { ok: true, data: { status: "failed" } },
    { ok: true, data: {} },
    { ok: true, data: null },
    { ok: true },
    null,
    undefined,
  ]) {
    const parsed = parseHostConclusion(bad);
    assert.equal(parsed.ok, false, `坏结论必须结构化报错：${JSON.stringify(bad)}`);
    assert.equal(parsed.error.kind, "invalid_host_conclusion");
  }

  // 宿主侧的结构化错误原样透出（错误类别保留，便于上层分支）
  const transport = parseHostConclusion({ ok: false, error: { message: "core 进程已退出", kind: "core_gone" } });
  assert.equal(transport.ok, false);
  assert.equal(transport.error.kind, "core_gone");

  // 没有 kind 的错误也不能变成一个"看起来成功"的东西
  const noKind = parseHostConclusion({ ok: false, error: { message: "炸了" } });
  assert.equal(noKind.ok, false);
  assert.equal(noKind.error.message, "炸了");
});

test("文案与词表：两条期限文案彼此不同（用户要能分清「打不开官方页」与「扫码超时」）", () => {
  assert.notEqual(LOGIN_PAGE_UNAVAILABLE_MESSAGE, LOGIN_TIMEOUT_MESSAGE);
  assert.match(LOGIN_PAGE_UNAVAILABLE_MESSAGE, /登录页面/);
  assert.match(LOGIN_TIMEOUT_MESSAGE, /超时/);
  assert.deepEqual(Object.values(HOST_LOGIN_STATUS).sort(), [
    "callback",
    "cancelled",
    "closed",
    "load_failed",
    "timed_out",
  ]);
});
