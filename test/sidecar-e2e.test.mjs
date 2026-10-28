/**
 * sidecar 桥 · 真进程端到端（node src/sidecar/main.mjs + NDJSON stdio）。
 * 断言的是"接线真的通"：请求帧 → 未实现的结构化错误帧；stdin EOF → sidecar 以 0 退出。
 * stdout 只允许出现合法 JSON 帧（日志一律走 stderr，否则会污染协议）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBridge } from "../src/host/bridge.mjs";
import { MUSIC_ENDPOINT_KEYS } from "../src/protocols/music.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sidecarEntry = `${repoRoot}src/sidecar/main.mjs`;

/**
 * 真进程的数据目录：里面写一份"全部业务端点显式关闭"的设置。
 * 默认端点表是满的，显式关闭（`musicEndpoints: {key: null}`）给出的正是"确定性不可用"那一档。
 */
function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "hwmusic-e2e-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      data: { musicEndpoints: Object.fromEntries(MUSIC_ENDPOINT_KEYS.map((key) => [key, null])) },
    }),
  );
  return dir;
}

function startSidecar() {
  const dataDir = makeDataDir();
  const child = spawn(process.execPath, [sidecarEntry, "--data-dir", dataDir], {
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
    dataDir,
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

  // 宿主要求的形状：官方授权页 + 一次性 partition（Rust 侧还会再校验一遍）。
  // 载荷里**没有** topInset：官方登录页铺满整个主窗。
  const open = sidecar.hostRequests.find((request) => request.channel === "host:open-login");
  assert.ok(open, `sidecar 没有发出 host:open-login：${JSON.stringify(sidecar.hostRequests)}`);
  assert.match(open.payload.url, /^https:\/\/oauth-login\.platform\.hicloud\.com\/oauth2\/v3\/authorize\?/);
  assert.match(open.payload.partition, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(open.payload, "topInset"),
    false,
    "topInset 已退休（登录页铺满整窗）",
  );
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

test("端到端：auth:cancel-qr 真的挂了处理器（R53：门禁收场时停下来，不是 unknown_channel）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 等启动期恢复的结论落定：恢复期间快照带 `restoring`，那之后才是普通快照
  await sidecar.waitForBroadcast((frame) => frame.channel === "auth:status");

  const cancelled = await sidecar.bridge.call("auth:cancel-qr", {});
  assert.equal(
    cancelled.ok,
    true,
    `auth:cancel-qr 必须真的挂了处理器（不是 unimplemented / unknown_channel）：${JSON.stringify(cancelled)}`,
  );
  assert.equal(cancelled.data.cancelled, true, "没有会话也回「已停」（用户的意图已经满足，不是错误）");

  // 恢复结束之后快照不再带 restoring 这一格
  const snapshot = await sidecar.bridge.call("auth:get-status", {});
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.data.loggedIn, false);
  assert.equal(snapshot.data.restoring, undefined, "恢复落定之后不许再挂「恢复中」");
  assert.deepEqual(sidecar.problems, []);
});

test("端到端：library:favorites 在端点被关闭时回结构化 endpoint_unknown（不冒充空数据、不挂起）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 这次的数据目录里把业务端点全关了（见 makeDataDir）→ 必须如实报"接口没配"
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

test("端到端：playback:resolve-url 端点被关闭时回结构化 endpoint_unknown；坏载荷在边界被拒", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 业务端点全关 → 必须如实报"接口没配"，而不是回一个假的播放地址
  const resolved = await sidecar.bridge.call("playback:resolve-url", { trackId: "1001" });
  assert.equal(resolved.ok, false, `端点未配置不许"成功"：${JSON.stringify(resolved)}`);
  assert.equal(resolved.error.kind, "endpoint_unknown");
  assert.match(resolved.error.message, /playback/);

  const bad = await sidecar.bridge.call("playback:resolve-url", { trackId: "   " });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, "invalid_payload");

  assert.deepEqual(sidecar.problems, []);
});

test("端到端：playback:lyrics 频道真的注册了；端点被关闭时回结构化 endpoint_unknown（R12）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  // 歌词**从播放响应推导**：这条路上第一个缺的端点就是 playback
  const lyrics = await sidecar.bridge.call("playback:lyrics", { trackId: "1001" });
  assert.equal(lyrics.ok, false, `端点未配置不许"成功"：${JSON.stringify(lyrics)}`);
  assert.equal(lyrics.error.kind, "endpoint_unknown");
  assert.match(lyrics.error.message, /playback/, "要说清是哪个端点没配（歌词走的就是播放端点）");

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

test("端到端：lyrics:* 三条频道真的注册了（R41：导入 → 占用 → 清缓存，走真进程与真数据目录）", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  const lrc = "[00:01.00]第一行\n[00:05.00]第二行\n";

  // 占用：一开始两处都是 0 条（数据目录是新的）
  const empty = await sidecar.bridge.call("lyrics:cache-info", null);
  assert.equal(empty.ok, true, `lyrics:cache-info 必须真的挂了处理器：${JSON.stringify(empty)}`);
  assert.deepEqual(empty.data, { available: true, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });

  // 坏载荷在边界被拒
  const missing = await sidecar.bridge.call("lyrics:import", { text: lrc });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, "invalid_payload");

  const notLyrics = await sidecar.bridge.call("lyrics:import", { trackId: "1001", text: "没有时间戳的一行" });
  assert.equal(notLyrics.ok, false);
  assert.equal(notLyrics.error.kind, "invalid_response", "这段文本不是歌词：如实回，并留下原因");
  assert.match(notLyrics.error.message, /不是可用的歌词/);

  // 正常导入：落进数据根下的 lyrics-local/
  const imported = await sidecar.bridge.call("lyrics:import", { trackId: "1001", text: lrc, fileName: "我的.lrc" });
  assert.equal(imported.ok, true, `导入必须成功：${JSON.stringify(imported)}`);
  assert.equal(imported.data.source, "local");
  assert.equal(imported.data.fileName, "我的.lrc");

  const after = await sidecar.bridge.call("lyrics:cache-info", null);
  assert.equal(after.data.localEntries, 1, "本地导入目录里多了一条");
  assert.ok(after.data.localBytes > 0);
  const files = readdirSync(join(sidecar.dataDir, "lyrics-local"));
  assert.equal(files.length, 1, `落盘的文件名是 sha256 键：${files.join(", ")}`);

  // 导入之后取词：本地那一条压过一切（端点全关也照样有歌词）
  const lyrics = await sidecar.bridge.call("playback:lyrics", { trackId: "1001" });
  assert.equal(lyrics.ok, true, `本地导入必须压过在线那条路：${JSON.stringify(lyrics)}`);
  assert.equal(lyrics.data.source, "local");
  assert.match(lyrics.data.text, /第一行/);

  // 清缓存：默认只清在线缓存 → 本地导入留着
  const kept = await sidecar.bridge.call("lyrics:cache-clear", {});
  assert.equal(kept.ok, true);
  assert.equal(kept.data.localEntries, 1, "默认不删用户导入的文件");

  const cleared = await sidecar.bridge.call("lyrics:cache-clear", { local: true });
  assert.equal(cleared.data.localEntries, 0, "local:true 才连本地导入一起删");
  assert.equal(existsSync(join(sidecar.dataDir, "lyrics-local")), false);

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

/**
 * stderr 每一行都要带级别标记——宿主按它把 sidecar 的日志分档写进同一个日志文件。
 * 标记就是契约：`[hwmusic-core][info|warn|error|debug] 正文`。
 */
test("端到端：stderr 每行都带 [hwmusic-core][级别] 标记，启动行是 info", async (t) => {
  const sidecar = startSidecar();
  t.after(() => sidecar.cleanup());

  await sidecar.bridge.call("auth:get-status", {});
  // 「已就绪」是启动装配的最后一行：等到它，才谈得上"每一行"都齐了
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !sidecar.stderrText().includes("已就绪")) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const lines = sidecar
    .stderrText()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  assert.ok(lines.length > 0, "启动期就该有日志：空 stderr 说明日志根本没写");

  const marker = /^\[hwmusic-core\]\[(info|warn|error|debug)\] .+/;
  for (const line of lines) {
    assert.match(line, marker, `每行都必须带级别标记（宿主靠它分档）：${line}`);
  }
  const ready = lines.filter((line) => line.includes("已就绪"));
  assert.equal(ready.length, 1, `启动那一行必须恰好一条：${JSON.stringify(lines)}`);
  assert.match(ready[0], /^\[hwmusic-core\]\[info\]/, `启动行是 info：${ready[0]}`);
});

test("级别标记：错误路径用 warn/error（不是所有行都一个档）", async () => {
  const main = readFileSync(`${repoRoot}src/sidecar/main.mjs`, "utf8");
  assert.match(main, /\[info\]/, "log 默认写 info 标记");
  assert.match(main, /\[warn\]/, "log.warn 写 warn 标记");
  assert.match(main, /\[error\]/, "log.error 写 error 标记");

  // 未捕获异常 / 未处理的拒绝 / 处理器抛错：这三处必须是 error（日志面板的红色从这来）
  for (const anchor of ["uncaughtException", "unhandledRejection", "onHandlerError"]) {
    const at = main.indexOf(anchor);
    assert.ok(at > 0, `找不到 ${anchor}`);
    const window = main.slice(at, at + 400);
    assert.match(window, /log\.error\(/, `${anchor} 这一档要用 log.error 而不是 log：${window}`);
  }
});
