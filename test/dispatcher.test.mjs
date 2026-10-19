/**
 * R3 sidecar 桥 · 频道白名单路由（dispatcher）、RPC 契约层（rpc）与宿主要求封装（host-services）。
 *
 * 关键断言：白名单是唯一真源（与共享常量同集合）、未知频道与处理器异常都变成结构化错误、
 * 宿主要求的 unimplemented 原样回传（不 panic、不静默）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createDispatcher } from "../src/host/dispatcher.mjs";
import { createRpc } from "../src/host/rpc.mjs";
import { createHostServices } from "../src/host/host-services.mjs";
import {
  HOST_CANCEL_LOGIN,
  HOST_NOTIFY,
  HOST_OPEN_LOGIN,
  HOST_REQUEST_CHANNELS,
  HOST_SECURE_DECRYPT,
  HOST_SECURE_ENCRYPT,
  REQUEST_CHANNELS,
} from "../src/shared/request-channels.ts";
import { err, ok } from "../src/shared/result.ts";
import { createBridge } from "../src/host/bridge.mjs";

function createResponder() {
  const answers = [];
  return {
    answers,
    respond(result) {
      answers.push(result);
      return true;
    },
  };
}

test("dispatcher：频道清单与共享常量同集合（不另立清单）", () => {
  const dispatcher = createDispatcher();
  assert.deepEqual(dispatcher.channels(), [...REQUEST_CHANNELS]);
  for (const channel of REQUEST_CHANNELS) assert.equal(dispatcher.has(channel), true);
  assert.equal(dispatcher.has("auth:not-a-channel"), false);
});

test("dispatcher：注册非白名单频道直接抛 TypeError（开发期就炸，不进运行期）", () => {
  const dispatcher = createDispatcher();
  assert.throws(() => dispatcher.register("auth:not-a-channel", () => ok(null)), TypeError);
  assert.throws(() => dispatcher.register("host:notify", () => ok(null)), TypeError, "宿主要求频道不属于请求白名单");
});

test("dispatcher：命中处理器 → 结果包成响应帧（ok 与 err 都原样）", async () => {
  const dispatcher = createDispatcher();
  dispatcher.register("settings:get", () => ok({ proxy: null }));
  dispatcher.register("auth:login", () => err("登录由 R7 实现", "unimplemented"));

  const first = createResponder();
  await dispatcher.dispatch({ id: "1", channel: "settings:get", payload: {} }, first.respond);
  assert.deepEqual(first.answers, [ok({ proxy: null })]);

  const second = createResponder();
  await dispatcher.dispatch({ id: "2", channel: "auth:login", payload: {} }, second.respond);
  assert.equal(second.answers.length, 1);
  assert.equal(second.answers[0].ok, false);
  assert.equal(second.answers[0].error.kind, "unimplemented");
});

test("dispatcher：未知频道 → 结构化 unknown_channel（不静默、不抛）", async () => {
  const dispatcher = createDispatcher();
  const responder = createResponder();
  await dispatcher.dispatch({ id: "3", channel: "auth:not-a-channel", payload: {} }, responder.respond);

  assert.equal(responder.answers.length, 1);
  assert.equal(responder.answers[0].ok, false);
  assert.equal(responder.answers[0].error.kind, "unknown_channel");
  assert.ok(responder.answers[0].error.message.includes("auth:not-a-channel"));
});

test("dispatcher：白名单频道没挂处理器 → unimplemented，而不是当未知频道", async () => {
  const dispatcher = createDispatcher();
  const responder = createResponder();
  await dispatcher.dispatch({ id: "4", channel: "settings:set", payload: {} }, responder.respond);

  assert.equal(responder.answers[0].error.kind, "unimplemented");
});

test("dispatcher：处理器抛错/拒绝 → internal 结构化错误，帧内不回显异常正文与堆栈", async () => {
  const logged = [];
  const dispatcher = createDispatcher({ onHandlerError: (detail) => logged.push(detail) });
  dispatcher.register("auth:logout", () => {
    throw new Error("secret-token-abc123 at internal.js:1:1");
  });
  dispatcher.register("auth:cancel-login", async () => {
    throw new Error("also-secret at other.js:2:2");
  });

  const first = createResponder();
  await dispatcher.dispatch({ id: "5", channel: "auth:logout", payload: {} }, first.respond);
  const frame = first.answers[0];
  assert.equal(frame.ok, false);
  assert.equal(frame.error.kind, "internal");
  assert.ok(!frame.error.message.includes("secret-token-abc123"), "错误正文不得回显");
  assert.ok(!frame.error.message.includes("at "), "堆栈不得回显");
  assert.ok(frame.error.message.includes("auth:logout"), "至少要指明是哪个频道失败");

  const second = createResponder();
  await dispatcher.dispatch({ id: "6", channel: "auth:cancel-login", payload: {} }, second.respond);
  assert.equal(second.answers[0].error.kind, "internal");

  assert.equal(logged.length, 2);
  assert.equal(logged[0].channel, "auth:logout");
  assert.ok(String(logged[0].error.message).includes("secret-token-abc123"), "详情进日志而不是帧");
});

test("dispatcher：handler 返回普通值也收成 ok；异步处理器被 await", async () => {
  const dispatcher = createDispatcher();
  dispatcher.register("settings:get", () => ({ schemaVersion: 1 }));
  dispatcher.register("settings:set", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return ok("saved");
  });

  const first = createResponder();
  await dispatcher.dispatch({ id: "7", channel: "settings:get", payload: {} }, first.respond);
  assert.deepEqual(first.answers, [ok({ schemaVersion: 1 })]);

  const second = createResponder();
  await dispatcher.dispatch({ id: "8", channel: "settings:set", payload: {} }, second.respond);
  assert.deepEqual(second.answers, [ok("saved")]);
});

test("dispatcher：处理器只答复一次——内部重复答复会写两帧，由桥的一次性守卫兜底", async () => {
  const dispatcher = createDispatcher();
  const answers = [];
  dispatcher.register("settings:get", (_request, respond) => {
    respond(ok("first"));
    respond(ok("second"));
    return undefined;
  });
  await dispatcher.dispatch({ id: "9", channel: "settings:get", payload: {} }, (result) => answers.push(result));
  assert.deepEqual(answers, [ok("first"), ok("second")], "dispatcher 不吞答复，重复答复交由桥拒绝");
});

test("rpc：入帧经 dispatcher 变成响应帧（id 回填），未知频道也回结构化错误", async () => {
  const written = [];
  const bridge = createBridge({
    writable: { write: (chunk) => written.push(String(chunk)) },
  });
  const dispatcher = createDispatcher();
  dispatcher.register("settings:get", () => ok({ schemaVersion: 1 }));
  const rpc = createRpc({ bridge, dispatcher });

  assert.deepEqual(rpc.channels(), [...REQUEST_CHANNELS]);

  bridge.handleFrame({ id: "11", channel: "settings:get", payload: {} });
  bridge.handleFrame({ id: "12", channel: "auth:not-a-channel", payload: {} });
  await new Promise((resolve) => setImmediate(resolve));

  const frames = written
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const byId = new Map(frames.map((frame) => [frame.id, frame]));

  // 不假定响应先后（处理器要 await，未知频道是同步答复）
  assert.equal(frames.length, 2);
  assert.deepEqual(byId.get("11"), { id: "11", ok: true, data: { schemaVersion: 1 } });
  assert.equal(byId.get("12").ok, false);
  assert.equal(byId.get("12").error.kind, "unknown_channel");
});

test("rpc.callHost：宿主要求频道白名单准入，非白名单立即结构化错误且不写帧", async () => {
  const written = [];
  const bridge = createBridge({ writable: { write: (chunk) => written.push(String(chunk)) } });
  const rpc = createRpc({ bridge, dispatcher: createDispatcher() });

  const rejected = await rpc.callHost("host:not-a-channel", {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.kind, "unknown_channel");
  assert.equal(written.length, 0);

  const inflight = rpc.callHost(HOST_NOTIFY, { text: "x" });
  const sent = JSON.parse(written.join("").trim());
  assert.equal(sent.channel, HOST_NOTIFY);
  assert.deepEqual(sent.payload, { text: "x" });
  bridge.handleFrame({ id: sent.id, ok: true, data: null });
  assert.deepEqual(await inflight, ok(null));
});

test("rpc.shutdown：收尸后出向调用立刻失败、入帧不再处理", async () => {
  const written = [];
  const bridge = createBridge({ writable: { write: (chunk) => written.push(String(chunk)) } });
  const dispatcher = createDispatcher();
  dispatcher.register("settings:get", () => ok(null));
  const rpc = createRpc({ bridge, dispatcher });

  rpc.shutdown("应用退出");
  const result = await rpc.callHost(HOST_NOTIFY, { text: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "core_gone");

  const before = written.length;
  bridge.handleFrame({ id: "13", channel: "settings:get", payload: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, before, "收尸后不再写帧");
});

test("host-services：notify 走 host:notify 且文本透传", async () => {
  const calls = [];
  const services = createHostServices({
    callHost: async (channel, payload) => {
      calls.push({ channel, payload });
      return ok({ shown: true });
    },
  });

  assert.deepEqual(await services.notify("已复制链接"), ok({ shown: true }));
  assert.deepEqual(calls, [{ channel: HOST_NOTIFY, payload: { text: "已复制链接" } }]);
});

test("host-services：登录三频道 + secure-* 频道名正确、payload/选项透传、宿主错误原样返回不抛", async () => {
  const calls = [];
  const services = createHostServices({
    callHost: async (channel, payload, options) => {
      calls.push({ channel, payload, options });
      return err("宿主不可用（e2e 没有真宿主）", "core_gone");
    },
  });

  const login = await services.openLogin({ partition: "login-1" }, { timeoutMs: 660_000 });
  const cancel = await services.cancelLogin({});
  const enc = await services.secureEncrypt({ plaintext: "x" });
  const dec = await services.secureDecrypt({ ciphertext: "y" });

  for (const result of [login, cancel, enc, dec]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "core_gone");
  }
  assert.deepEqual(
    calls.map((call) => call.channel),
    [HOST_OPEN_LOGIN, HOST_CANCEL_LOGIN, HOST_SECURE_ENCRYPT, HOST_SECURE_DECRYPT],
  );
  assert.deepEqual(calls[0].payload, { partition: "login-1" });
  // 开窗是长轮询：调用超时必须能透传到桥上（默认 60 秒会把"还在扫码"判成超时）
  assert.deepEqual(calls[0].options, { timeoutMs: 660_000 });
  assert.deepEqual(calls[1].payload, {}, "取消没有载荷");
  assert.deepEqual(HOST_REQUEST_CHANNELS.length, 5);
});
