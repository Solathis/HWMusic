/**
 * R3 sidecar 桥 · 真进程端到端（node src/sidecar/main.mjs + NDJSON stdio）。
 *
 * 断言的是"接线真的通"：请求帧 → 未实现的结构化错误帧；stdin EOF → sidecar 以 0 退出（双向收尸）；
 * stdout 只允许出现合法 JSON 帧（日志一律走 stderr，否则会污染协议）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createBridge } from "../src/host/bridge.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sidecarEntry = `${repoRoot}src/sidecar/main.mjs`;

function startSidecar() {
  const child = spawn(process.execPath, [sidecarEntry], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const problems = [];
  const hostRequests = [];
  const frames = [];
  let raw = "";
  let hostResponder = null;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // 旁路收集 stdout 上的每一帧（广播没有 id，桥不会把它交给任何回调，只能自己看流）
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    raw += chunk;
    for (;;) {
      const newline = raw.indexOf("\n");
      if (newline === -1) break;
      const line = raw.slice(0, newline).trim();
      raw = raw.slice(newline + 1);
      if (line === "") continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        problems.push({ kind: "invalid_json_frame", line });
      }
    }
  });

  const bridge = createBridge({
    readable: child.stdout,
    writable: child.stdin,
    timeoutMs: 8000,
    onProtocolError: (problem) => problems.push(problem),
  });

  // 假装成 Rust 宿主：把宿主要求记下来，按测试给的答复回帧（默认如实回"宿主不可用"）
  bridge.onRequest((request, respond) => {
    hostRequests.push(request);
    if (hostResponder === null) {
      respond({ ok: false, error: { message: "e2e 没有真宿主", kind: "core_gone" } });
      return;
    }
    hostResponder(request, respond);
  });

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  /** 等一条广播帧（auth:status 这类结论走广播，不走响应帧）。 */
  async function waitForBroadcast(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = frames.find((frame) => frame.id === undefined && predicate(frame));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  return {
    child,
    bridge,
    problems,
    frames,
    hostRequests,
    waitForBroadcast,
    answerHostWith(responder) {
      hostResponder = responder;
    },
    exited,
    stderrText: () => stderr,
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill();
      }
      await exited;
    },
  };
}

test("端到端：auth:login 立刻回「已受理」，结论经 auth:status 广播送达；宿主要求形状正确", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 宿主（Rust 侧）在登录窗收场后答复——这里直接回一个"取消"结论
  sidecar.answerHostWith((_request, respond) => respond({ ok: true, data: { status: "cancelled" } }));

  const started = await sidecar.bridge.call("auth:login", {});
  assert.equal(started.ok, true, `auth:login 只回「已受理」：${JSON.stringify(started)}`);
  assert.equal(started.data.started, true);

  // 结论在广播里（渲染层那条 core_call 链路有 60 秒上限，等不了 10 分钟的扫码）
  const status = await sidecar.waitForBroadcast(
    (frame) => frame.channel === "auth:status" && frame.payload?.busy === false && frame.payload?.message,
  );
  assert.ok(status, `没有收到 auth:status 结论：${JSON.stringify(sidecar.frames)}`);
  assert.equal(status.payload.loggedIn, false);
  assert.match(status.payload.message, /取消/, "失败原因要能显示给用户");

  // 宿主要求的形状：官方授权页 + 一次性 partition + 顶部内缩（Rust 侧还会再校验一遍）
  const open = sidecar.hostRequests.find((request) => request.channel === "host:open-login");
  assert.ok(open, `sidecar 没有发出 host:open-login：${JSON.stringify(sidecar.hostRequests)}`);
  assert.match(open.payload.url, /^https:\/\/oauth-login1\.cloud\.huawei\.com\/oauth2\/v3\/authorize\?/);
  assert.match(open.payload.partition, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(open.payload.topInset, 48, "顶部内缩来自共享常量");
  assert.deepEqual(sidecar.problems, [], `stdout 出现非法帧：${JSON.stringify(sidecar.problems)}`);
});

test("端到端：宿主回结构化错误时，auth:status 把原始类别带出来（不改写成笼统 failed）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  sidecar.answerHostWith((_request, respond) =>
    respond({ ok: false, error: { message: "已有一次登录正在进行", kind: "login_in_progress" } }),
  );

  const started = await sidecar.bridge.call("auth:login", {});
  assert.equal(started.ok, true);

  const status = await sidecar.waitForBroadcast(
    (frame) => frame.channel === "auth:status" && frame.payload?.busy === false && frame.payload?.message,
  );
  assert.ok(status, `没有收到 auth:status 结论：${JSON.stringify(sidecar.frames)}`);
  assert.match(status.payload.message, /已有一次登录/, "宿主那句人话要原样留给用户");
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：auth:logout / auth:cancel-login 都给出结构化答复（不静默、不挂起）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 没有数据目录 → 会话清不掉，但答复必须是结构化的（不是未实现、也不是假成功）
  const logout = await sidecar.bridge.call("auth:logout", {});
  assert.equal(logout.ok, true, `logout 不该抛：${JSON.stringify(logout)}`);
  assert.equal(typeof logout.data.sessionCleared, "boolean");

  // 没有进行中的登录 → 什么都没取消，但这不是错误（用户的意图"别等了"已经满足）
  const cancel = await sidecar.bridge.call("auth:cancel-login", {});
  assert.equal(cancel.ok, true, `cancel 不该抛：${JSON.stringify(cancel)}`);
  assert.equal(cancel.data.cancelled, false);
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：auth:get-status 回当前状态快照，且**不**额外广播（R19：reload 之后门禁靠它）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 先等启动期那条 auth:status（restore 的结论）到齐：否则"没多播"可能只是"还没播"
  const startup = await sidecar.waitForBroadcast((frame) => frame.channel === "auth:status");
  assert.ok(startup, `启动期没有 auth:status 广播：${JSON.stringify(sidecar.frames)}`);
  const before = sidecar.frames.filter((frame) => frame.channel === "auth:status").length;

  const snapshot = await sidecar.bridge.call("auth:get-status", {});
  assert.equal(snapshot.ok, true, `auth:get-status 必须真的挂了处理器（不是 unimplemented）：${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.data.loggedIn, false, "没有数据目录 → 没有会话，如实说未登录（不冒充已登录）");
  assert.equal(snapshot.data.busy, false);
  assert.deepEqual(
    Object.keys(snapshot.data).sort(),
    ["busy", "loggedIn"],
    "应答形状 = auth:status 广播那一份（message 是可选的「刚发生的事」，不随快照走）",
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = sidecar.frames.filter((frame) => frame.channel === "auth:status").length;
  assert.equal(after, before, "查询**不触发广播**：再播一条只会让渲染层把同一件事处理两遍");
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：library:favorites 在端点未配置时回结构化 endpoint_unknown（不冒充空数据、不挂起）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 真进程里没有任何端点写入方（docs/API_CONTRACT.md §2.1）→ 必须如实报"接口未配"
  const favorites = await sidecar.bridge.call("library:favorites", { page: 1, pageSize: 20 });
  assert.equal(favorites.ok, false, `端点未配置不许"成功"：${JSON.stringify(favorites)}`);
  assert.equal(favorites.error.kind, "endpoint_unknown");
  assert.match(favorites.error.message, /favorites/);

  // 坏载荷（缺必填参数）不是端点问题，要在边界就被拒
  const search = await sidecar.bridge.call("library:search", { keyword: "   " });
  assert.equal(search.ok, false);
  assert.equal(search.error.kind, "invalid_payload");

  assert.deepEqual(sidecar.problems, []);
});

test("端到端：playback:resolve-url 端点未配置时回结构化 endpoint_unknown；坏载荷在边界被拒", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 真进程里没有端点写入方 → 必须如实报"接口未配"，而不是回一个假的播放地址
  const resolved = await sidecar.bridge.call("playback:resolve-url", { trackId: "1001" });
  assert.equal(resolved.ok, false, `端点未配置不许"成功"：${JSON.stringify(resolved)}`);
  assert.equal(resolved.error.kind, "endpoint_unknown");
  assert.match(resolved.error.message, /playback/);

  const bad = await sidecar.bridge.call("playback:resolve-url", { trackId: "   " });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, "invalid_payload");

  assert.deepEqual(sidecar.problems, []);
});

test("端到端：playback:lyrics 频道真的注册了；端点未配置时回结构化 endpoint_unknown（R12）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 真进程里没有端点写入方 → 必须如实报"接口未配"，而不是回一段编出来的歌词
  const lyrics = await sidecar.bridge.call("playback:lyrics", { trackId: "1001" });
  assert.equal(lyrics.ok, false, `端点未配置不许"成功"：${JSON.stringify(lyrics)}`);
  assert.equal(lyrics.error.kind, "endpoint_unknown");
  assert.match(lyrics.error.message, /lyrics/, "要说清是哪个端点没配（渲染层据此说「歌词来源尚未配置」）");

  const bad = await sidecar.bridge.call("playback:lyrics", { trackId: " " });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, "invalid_payload", "坏载荷在边界被拒，不透给协议层");
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：未知频道不被桥放行（Node dispatch 层白名单生效）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  const result = await sidecar.bridge.call("auth:not-a-channel", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "unknown_channel");
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：stdin EOF → sidecar 以 0 退出（双向收尸，不依赖单侧 kill）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  sidecar.child.stdin.end();
  const { code } = await Promise.race([
    sidecar.exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 10_000)),
  ]);
  assert.equal(code, 0, `stdin EOF 后 sidecar 未干净退出（code=${code}，stderr=${sidecar.stderrText()}）`);
});

test("端到端：半帧后 stdin EOF 同样干净退出（残余有确定结论）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  sidecar.child.stdin.write('{"id":"half","channel":"auth:login"');
  sidecar.child.stdin.end();
  const { code } = await Promise.race([
    sidecar.exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 10_000)),
  ]);
  assert.equal(code, 0, `半帧 EOF 后 sidecar 未干净退出（code=${code}，stderr=${sidecar.stderrText()}）`);
});
