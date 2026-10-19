/**
 * R3 sidecar 桥 · 帧协议与 pending 表。
 *
 * 覆盖简报点名的六类失败面：分帧 / 半帧 / EOF / pending 命中 / 同一 id 二次回调拒绝 / 超时（注入计时器）。
 * 本文件先于 src/host/bridge.mjs 存在而书写：实现缺席时必须失败（TDD RED）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  CALL_TIMEOUT_MS,
  createBridge,
  createFrameDecoder,
  createPendingTable,
  encodeFrame,
} from "../src/host/bridge.mjs";

/** 假写入端：收集桥写出的字节。 */
function createRecorder() {
  const written = [];
  return {
    written,
    write(chunk) {
      written.push(String(chunk));
      return true;
    },
    frames() {
      return written
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    },
  };
}

/** 注入计时器：不让测试真的等 60 秒，同时能断言默认超时值。 */
function createFakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    scheduled() {
      return [...timers.values()];
    },
    get size() {
      return timers.size;
    },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const timer of all) timer.fn();
    },
  };
}

function createHarness(overrides = {}) {
  const recorder = createRecorder();
  const problems = [];
  const timers = createFakeTimers();
  const bridge = createBridge({
    writable: recorder,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onProtocolError: (problem) => problems.push(problem),
    ...overrides,
  });
  return { bridge, recorder, problems, timers };
}

test("分帧：一个 chunk 多帧、跨 chunk 半帧、CRLF 与空行都被吞掉", () => {
  const decoder = createFrameDecoder();
  assert.deepEqual(decoder.push('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);

  // 半帧：残余留在解码器里，不吐半个对象
  assert.deepEqual(decoder.push('{"id":"x","ok":true,"data":'), []);
  assert.equal(decoder.remainder, '{"id":"x","ok":true,"data":');
  assert.deepEqual(decoder.push('{"n":1}}'), []);

  // 补齐换行后一次吐出；CRLF 与空行不产生垃圾帧
  assert.deepEqual(decoder.push('\r\n\n{"c":3}\n'), [{ id: "x", ok: true, data: { n: 1 } }, { c: 3 }]);
  assert.equal(decoder.remainder, "");
});

test("EOF 半帧：残余帧给出确定结论（truncated_frame），不抛异常也不静默丢弃", () => {
  const problems = [];
  const decoder = createFrameDecoder({ onInvalidFrame: (problem) => problems.push(problem) });
  decoder.push('{"id":"half"');
  const rest = decoder.end();

  assert.equal(rest, '{"id":"half"');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "truncated_frame");
  assert.equal(decoder.remainder, "", "残余已被消费，EOF 有确定结论");
  assert.equal(decoder.end(), "", "重复 end() 不再重复报告");
});

test("非法 JSON 行：报告 invalid_json 且后续帧照常解析", () => {
  const problems = [];
  const decoder = createFrameDecoder({ onInvalidFrame: (problem) => problems.push(problem) });
  const frames = decoder.push('not json\n{"a":1}\n');

  assert.deepEqual(frames, [{ a: 1 }]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "invalid_json");
  assert.ok(problems[0].excerpt.includes("not json"), "短行在 64 字节上限内可见，够排障");
});

test("非法帧脱敏：超过 64 字节的行只给摘要，哑凭据绝不进日志", () => {
  const problems = [];
  const decoder = createFrameDecoder({ onInvalidFrame: (problem) => problems.push(problem) });
  const secret = "dummy-secret-do-not-log";
  // 前半截是垃圾字节 → 整行是非法的；哑凭据刻意放在第 64 字节**之后**（这就是"凭据邻接"的形状）
  const line = `${"x".repeat(80)}{"password":"${secret}"}`;
  decoder.push(`${line}\n`);

  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "invalid_json");
  const logged = JSON.stringify(problems[0]);
  assert.ok(!logged.includes(secret), `非法帧不得全文进日志（凭据在里面）：${logged}`);
  assert.ok(!logged.includes("x".repeat(65)), `摘要不得超过 64 字节：${logged}`);
  assert.ok(problems[0].excerpt.includes("已截断"), problems[0].excerpt);
  assert.equal(problems[0].bytes, Buffer.byteLength(line, "utf8"), "总字节数如实报出");
  assert.equal(problems[0].line, undefined, "旧字段 line 带的是全文，必须从报告里消失");
});

test("截断帧脱敏：EOF 半帧的报告只给 64 字节摘要，哑凭据绝不进日志", () => {
  const problems = [];
  const decoder = createFrameDecoder({ onInvalidFrame: (problem) => problems.push(problem) });
  const secret = "dummy-secret-do-not-log";
  const head = `{"id":"half","channel":"host:secure-store-get","payload":{"key":"${"p".repeat(40)}","password":"`;
  const half = `${head}${secret}"`;
  decoder.push(half);
  const rest = decoder.end();

  assert.equal(rest, half, "协议层照旧拿到完整残余（摘要只作用于日志）");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "truncated_frame");
  const logged = JSON.stringify(problems[0]);
  assert.ok(!logged.includes(secret), `截断帧不得全文进日志（凭据在里面）：${logged}`);
  assert.equal(problems[0].excerpt, `${half.slice(0, 64)}…（已截断，共 ${Buffer.byteLength(half, "utf8")} 字节）`);
});

test("脱敏摘要按 UTF-8 字符边界切：不产生半个汉字、不超 64 字节", () => {
  const problems = [];
  const decoder = createFrameDecoder({ onInvalidFrame: (problem) => problems.push(problem) });
  // 每字 3 字节 → 第 64 字节正好落在一个汉字中间
  decoder.push(`{"text":"${"中".repeat(40)}"}`);
  decoder.end();

  const [head] = problems[0].excerpt.split("…");
  assert.ok(!problems[0].excerpt.includes("\uFFFD"), `不许留半个汉字：${problems[0].excerpt}`);
  assert.ok(Buffer.byteLength(head, "utf8") <= 64, `摘要头仍要 ≤64 字节：${head}`);
  assert.ok(problems[0].excerpt.includes("已截断"), problems[0].excerpt);
});

test("encodeFrame 往返：payload 内的换行不破坏分帧", () => {
  const decoder = createFrameDecoder();
  const line = encodeFrame({ id: "1", channel: "host:notify", payload: { text: "a\nb" } });
  assert.ok(line.endsWith("\n"));
  assert.equal(line.split("\n").length, 2, "一帧恰好一个换行");
  assert.deepEqual(decoder.push(line), [{ id: "1", channel: "host:notify", payload: { text: "a\nb" } }]);
});

test("pending 命中：call 写出请求帧，响应帧结清调用并清理计时器", async () => {
  const { bridge, recorder, timers } = createHarness();
  const inflight = bridge.call("host:notify", { text: "hi" });

  const frames = recorder.frames();
  assert.equal(frames.length, 1);
  assert.equal(typeof frames[0].id, "string");
  assert.ok(frames[0].id.length > 0);
  assert.equal(frames[0].channel, "host:notify");
  assert.deepEqual(frames[0].payload, { text: "hi" });
  assert.equal(bridge.pendingSize, 1);

  bridge.handleFrame({ id: frames[0].id, ok: true, data: { shown: true } });
  assert.deepEqual(await inflight, { ok: true, data: { shown: true } });
  assert.equal(bridge.pendingSize, 0);
  assert.equal(timers.size, 0, "结清后不留悬空计时器");
});

test("响应帧 error：结清为结构化错误（message + kind）", async () => {
  const { bridge, recorder } = createHarness();
  const inflight = bridge.call("host:open-login", {});
  const [{ id }] = recorder.frames();

  bridge.handleFrame({ id, ok: false, error: { message: "未实现", kind: "unimplemented" } });
  const result = await inflight;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "unimplemented");
  assert.equal(result.error.message, "未实现");
});

test("同一 id 二次回调被拒绝：原值不被覆盖且报 unmatched_response", async () => {
  const { bridge, recorder, problems } = createHarness();
  const inflight = bridge.call("host:notify", {});
  const [{ id }] = recorder.frames();

  bridge.handleFrame({ id, ok: true, data: "first" });
  bridge.handleFrame({ id, ok: true, data: "second" });

  assert.deepEqual(await inflight, { ok: true, data: "first" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "unmatched_response");
  assert.equal(problems[0].id, id);
});

test("pending 表：重复 id 登记被拒、二次 settle 被拒、failAll 逐个结清", () => {
  const table = createPendingTable();
  const seen = [];

  assert.equal(table.add("a", (value) => seen.push(value)), true);
  assert.equal(table.add("a", (value) => seen.push(value)), false, "同一 id 不能登记两次");
  assert.equal(table.size, 1);

  assert.equal(table.settle("a", "one"), true);
  assert.equal(table.settle("a", "two"), false, "二次回调被拒绝");
  assert.deepEqual(seen, ["one"]);
  assert.equal(table.settle("missing", "x"), false);

  table.add("b", (value) => seen.push(value));
  table.add("c", (value) => seen.push(value));
  assert.equal(table.failAll("gone"), 2);
  assert.deepEqual(seen, ["one", "gone", "gone"]);
  assert.equal(table.size, 0);
});

test("超时：默认 60 秒、注入计时器触发后报 timeout 并清空 pending", async () => {
  const { bridge, timers } = createHarness();
  assert.equal(CALL_TIMEOUT_MS, 60_000);

  const inflight = bridge.call("host:notify", {});
  const scheduled = timers.scheduled();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, CALL_TIMEOUT_MS);

  timers.fire();
  const result = await inflight;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "timeout");
  assert.equal(bridge.pendingSize, 0);
});

test("按调用覆盖超时：per-call timeoutMs 生效，不影响默认值", async () => {
  const { bridge, timers } = createHarness();
  const inflight = bridge.call("host:notify", {}, { timeoutMs: 1234 });
  assert.equal(timers.scheduled()[0].ms, 1234);
  timers.fire();
  assert.equal((await inflight).error.kind, "timeout");
  assert.equal(CALL_TIMEOUT_MS, 60_000);
});

test("EOF 收尸：结清在途调用、之后调用立刻失败（不排 60 秒计时器、不再写帧）", async () => {
  const { bridge, recorder, timers } = createHarness();
  const inflight = bridge.call("host:notify", { text: "x" });
  assert.equal(bridge.handleEof("stdout end"), 1);

  const result = await inflight;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "core_gone");
  assert.equal(bridge.closed, true);

  const after = await bridge.call("host:notify", { text: "y" });
  assert.equal(after.ok, false);
  assert.equal(after.error.kind, "core_gone");
  assert.equal(timers.size, 0, "已收尸就不该再等 60 秒");
  assert.equal(recorder.frames().length, 1, "收尸后不再写帧");
});

test("应答一次性：同一 id 第二次 respond 被拒绝（Deferred 语义的守卫）", () => {
  const { bridge, recorder, problems } = createHarness();
  assert.equal(bridge.respond("r1", { ok: true, data: null }), true);
  assert.equal(bridge.respond("r1", { ok: true, data: null }), false);
  assert.equal(recorder.frames().length, 1);
  assert.equal(problems.at(-1).kind, "duplicate_answer");
  assert.equal(bridge.respond(null, { ok: true, data: null }), false, "无 id 的帧无法答复");
});

test("请求帧路由：onRequest 收到 {id,channel,payload}，respond 绑定该 id", () => {
  const { bridge, recorder, problems } = createHarness();
  const seen = [];
  bridge.onRequest((request, respond) => {
    seen.push(request);
    respond({ ok: true, data: "pong" });
  });

  bridge.handleFrame({ id: "r9", channel: "auth:login", payload: { step: 1 } });
  assert.deepEqual(seen, [{ id: "r9", channel: "auth:login", payload: { step: 1 } }]);
  assert.deepEqual(recorder.frames()[0], { id: "r9", ok: true, data: "pong" });

  bridge.handleFrame({ id: "r10", payload: {} });
  assert.equal(problems.at(-1).kind, "invalid_frame");
  assert.equal(problems.at(-1).reason, "missing_channel");

  bridge.handleFrame("not an object");
  assert.equal(problems.at(-1).kind, "invalid_frame");
});

test("attach：真实可读流的分片/EOF 自动接线（data → 帧、end → 收尸）", async () => {
  const stdout = new PassThrough();
  const recorder = createRecorder();
  const bridge = createBridge({ readable: stdout, writable: recorder, timeoutMs: 2000 });

  const inflight = bridge.call("host:notify", {});
  const { id } = recorder.frames()[0];

  stdout.write(`{"id":"${id}","ok":true,"da`);
  stdout.write('ta":1}\n');
  assert.deepEqual(await inflight, { ok: true, data: 1 });

  const eof = new Promise((resolve) => bridge.onEof(resolve));
  stdout.end();
  await eof;
  assert.equal(bridge.closed, true);
});
