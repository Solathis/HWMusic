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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const bridge = createBridge({
    readable: child.stdout,
    writable: child.stdin,
    timeoutMs: 8000,
    onProtocolError: (problem) => problems.push(problem),
  });

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    bridge,
    problems,
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

test("端到端：auth:login 返回未实现的结构化错误（stdout 只有合法帧）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  const result = await sidecar.bridge.call("auth:login", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "unimplemented");
  assert.ok(typeof result.error.message === "string" && result.error.message.length > 0);
  assert.deepEqual(sidecar.problems, [], `stdout 出现非法帧：${JSON.stringify(sidecar.problems)}`);
});

test("端到端：其余白名单频道同样给出结构化答复（不静默、不挂起）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  for (const channel of ["auth:logout", "auth:cancel-login", "settings:get", "settings:set"]) {
    const result = await sidecar.bridge.call(channel, {});
    assert.equal(result.ok, false, `${channel} 不该成功`);
    assert.equal(result.error.kind, "unimplemented", `${channel} 的错误类别不对`);
  }
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
