/**
 * R6 统一代理 · sidecar 侧装配与 Rust 侧接线。
 *
 * 钉住四件事：
 * 1. 判定与清洗：enabled=false 字段再全也不算配；host/port 坏形状绝不猜（夹具与 Rust 共用）；
 * 2. 凭据卫生：**只进 undici 的 auth（proxy-authorization）**，不进 uri、不进日志、不进 notice、不回显；
 * 3. 装配顺序：main.mjs 里代理装配先于桥/调度器（源码顺序扫描，见用例注释）；
 * 4. 接线：主窗必须 `proxy_url`（旧仓审计出的缺陷 K6），装配走 `webview_proxy::resolve_for_webview`。
 * 本地假代理 + 本地直连服务器，全程不碰外网。先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher } from "undici";

import { createBridge } from "../src/host/bridge.mjs";
import { createRpc } from "../src/host/rpc.mjs";
import {
  agentOptions,
  applySettingsProxy,
  applyStartupProxy,
  createProxyDispatcher,
  describePlan,
  dispatcherOptions,
  proxyPlan,
  readEnvProxy,
  redactProxyValue,
  testProxyConnection,
} from "../src/main/proxy.mjs";
import { APP_NOTICE, BROADCAST_CHANNELS } from "../src/shared/channels.ts";
import { CORE_ERROR_KINDS } from "../src/shared/result.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sidecarEntry = join(repoRoot, "src", "sidecar", "main.mjs");
const USERNAME = "proxy-user";
const PASSWORD = "s3cret-proxy-token";

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");
const decode = (value) => Buffer.from(value, "base64").toString("utf8");

/** 把继承来的环境清干净：让每条用例的代理来源完全由自己决定。 */
const NEUTRAL_ENV = {
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  NO_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  no_proxy: "",
  all_proxy: "",
  HWMUSIC_DATA_DIR: "",
};

function configuredProxy(overrides = {}) {
  return {
    enabled: true,
    host: "proxy.local",
    port: 8080,
    username: USERNAME,
    password: PASSWORD,
    bypass: ["localhost", "127.0.0.1"],
    ...overrides,
  };
}

function settingsDoc(proxy) {
  return { schemaVersion: 1, data: { proxy, closeBehavior: "tray" } };
}

let dirCounter = 0;
async function tempDir(label) {
  dirCounter += 1;
  const dir = join(repoRoot, ".tmp", `proxy-${label}-${process.pid}-${dirCounter}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 假 setGlobalDispatcher：只记下收到的东西，不真装。 */
function dispatcherSpy() {
  const seen = [];
  return { seen, setGlobalDispatcher: (dispatcher) => seen.push(dispatcher) };
}

function collectingLog() {
  const lines = [];
  return { lines, log: (message) => lines.push(String(message)) };
}

/** 假 HTTP 代理：记下收到的请求并直接答复（不转发，也就不需要外网）。 */
async function fakeProxy({ status = 200, body = "proxied-ok", hang = false } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, method: request.method, headers: { ...request.headers } });
    if (hang) return; // 故意不回包：测超时
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    seen,
    port,
    uri: `http://127.0.0.1:${port}`,
    // closeAllConnections：超时用例会留一个"不回包"的连接，不清掉 close() 会一直等它
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 本地直连服务器（noProxy 命中时请求该落到这里）。 */
async function localOrigin() {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: { ...request.headers } });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("direct-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 真 sidecar 进程 + NDJSON 桥（收尾一致：关 stdin 等它自己退出）。 */
function startSidecar(args = [], env = NEUTRAL_ENV) {
  const child = spawn(process.execPath, [sidecarEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  const stderr = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") frames.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return {
    child,
    frames,
    stderrText: () => stderr.join(""),
    async waitForNotice(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find((frame) => frame.channel === APP_NOTICE);
        if (found !== undefined) return found;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async stop() {
      child.stdin.end();
      const exited = new Promise((resolve) => child.on("close", resolve));
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill();
    },
    bridge(timeoutMs = 8000) {
      return createBridge({ readable: child.stdout, writable: child.stdin, timeoutMs });
    },
  };
}

// ---------------------------------------------------------------------------
// 判定与清洗：enabled 与「字段齐全」是两回事
// ---------------------------------------------------------------------------

test("enabled=false 时字段再全也不算配（不装配、不建 agent）", () => {
  const plan = proxyPlan(configuredProxy({ enabled: false }));
  assert.equal(plan, null);
  assert.equal(dispatcherOptions(plan), null);
  assert.equal(agentOptions(plan), null);
  assert.equal(describePlan(plan), null);
});

test("字段没填全当没配：缺 host / 缺 port / host 带协议前缀", () => {
  const broken = [
    configuredProxy({ host: "" }),
    configuredProxy({ port: null }),
    configuredProxy({ port: 0 }),
    configuredProxy({ host: "http://proxy.local" }),
    configuredProxy({ host: "proxy.local:8080" }),
    {},
    null,
    "proxy.local",
  ];
  for (const candidate of broken) {
    assert.equal(proxyPlan(candidate), null, `${JSON.stringify(candidate)} 应视为没配`);
  }
});

test("完整配置：uri 只有 host:port，凭据绝不进 uri（undici 的 auth 才是凭据通道）", () => {
  const plan = proxyPlan(configuredProxy());
  assert.deepEqual({ host: plan.host, port: plan.port }, { host: "proxy.local", port: 8080 });
  assert.equal(describePlan(plan), "proxy.local:8080");

  const options = agentOptions(plan);
  assert.equal(options.uri, "http://proxy.local:8080");
  const parsed = new URL(options.uri);
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.host, "proxy.local:8080");
  assert.ok(!options.uri.includes(USERNAME), "用户名不进 uri");
  assert.ok(!options.uri.includes(PASSWORD), "密码不进 uri");
  assert.equal(decode(options.auth), `${USERNAME}:${PASSWORD}`, "auth 是 base64 的 user:password");
});

test("没有凭据时不给 auth 字段（不让 undici 以为要认证）", () => {
  const plan = proxyPlan(configuredProxy({ username: "", password: "" }));
  assert.equal(agentOptions(plan).auth, undefined);
  assert.equal(dispatcherOptions(plan).auth, undefined);
  assert.equal(describePlan(plan), "proxy.local:8080");
});

test("只有用户名没密码也发 Basic（user:）：密码为空不等于没凭据", () => {
  const plan = proxyPlan(configuredProxy({ username: USERNAME, password: "" }));
  assert.equal(decode(agentOptions(plan).auth), `${USERNAME}:`);
});

test("带方括号 IPv6 的 host 能拼出合法 uri；裸 IPv6 已被清洗拒绝", () => {
  const plan = proxyPlan(configuredProxy({ host: "[::1]", port: 3128 }));
  assert.equal(agentOptions(plan).uri, "http://[::1]:3128");
  assert.equal(proxyPlan(configuredProxy({ host: "::1" })), null);
});

test("bypass 进 noProxy（直连例外不是摆设），空例外 = 全部走代理", () => {
  assert.deepEqual(proxyPlan(configuredProxy()).noProxy, ["localhost", "127.0.0.1"]);
  assert.equal(dispatcherOptions(proxyPlan(configuredProxy())).noProxy, "localhost,127.0.0.1");
  assert.equal(dispatcherOptions(proxyPlan(configuredProxy({ bypass: [] }))).noProxy, "");
  assert.equal(
    dispatcherOptions(proxyPlan(configuredProxy({ bypass: "localhost , 127.0.0.1" }))).noProxy,
    "localhost,127.0.0.1",
  );
});

// ---------------------------------------------------------------------------
// 环境变量兜底（纯函数）
// ---------------------------------------------------------------------------

test("环境变量：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY，大小写都认，空白 = 没设置", () => {
  const pick = (env) => readEnvProxy(env).plan;
  const env = { HTTPS_PROXY: "http://p1:1", HTTP_PROXY: "http://p2:2", ALL_PROXY: "http://p3:3" };
  assert.equal(pick(env).source, "HTTPS_PROXY");
  assert.equal(pick({ HTTP_PROXY: "http://p2:2", ALL_PROXY: "http://p3:3" }).source, "HTTP_PROXY");
  assert.equal(pick({ ALL_PROXY: "http://p3:3" }).source, "ALL_PROXY");
  assert.equal(pick({ https_proxy: "http://p1:1" }).source, "HTTPS_PROXY");
  assert.equal(pick({ all_proxy: "http://p3:3" }).host, "p3");
  assert.equal(pick({ HTTPS_PROXY: "   " }), null);
  assert.equal(pick({}), null);
  assert.deepEqual(pick({ HTTPS_PROXY: "http://p1:1" }).noProxy, []);
});

test("环境变量：uri 里的凭据被剥出来进 auth（绝不留在 uri），百分号编码要还原", () => {
  const { plan } = readEnvProxy({ HTTPS_PROXY: "http://env-user:p%40ss@env-proxy:3128" });
  const uri = agentOptions(plan).uri;
  assert.equal(uri, "http://env-proxy:3128");
  assert.ok(!uri.includes("env-user") && !uri.includes("p%40ss"), `uri 不得带凭据：${uri}`);
  assert.equal(decode(plan.auth), "env-user:p@ss");
  assert.equal(describePlan(plan), "env-proxy:3128");
});

test("环境变量：NO_PROXY 归一成 noProxy 列表；缺端口按协议默认", () => {
  const { plan } = readEnvProxy({ HTTPS_PROXY: "http://env-proxy", NO_PROXY: "localhost, .corp.example ,localhost" });
  assert.equal(plan.port, 80);
  assert.deepEqual(plan.noProxy, ["localhost", ".corp.example"]);
  assert.equal(readEnvProxy({ HTTPS_PROXY: "https://env-proxy" }).plan.port, 443);
  assert.equal(readEnvProxy({ HTTPS_PROXY: "socks5://env-proxy:1080" }).plan.port, 1080, "socks5 是合法代理");
});

test("环境变量：不可解析的值被忽略并给出结构化原因（不静默、不猜）", () => {
  const cases = ["env-proxy:3128", "not a url", "ftp://env-proxy:2100", "http://"];
  for (const value of cases) {
    const { plan, problem } = readEnvProxy({ HTTP_PROXY: value });
    assert.equal(plan, null, `${value} 不该被当成代理`);
    assert.ok(problem, `${value} 必须报告「被忽略」`);
    assert.equal(problem.variable, "HTTP_PROXY");
  }
  // 回显只给**剥离后的形态**：能解析出主机时是 scheme://host:port（有用且不含凭据），
  // 解析不出主机时是固定短语——原文一律不回显（原文可能就是 `user:pass`）。
  assert.ok(
    readEnvProxy({ HTTP_PROXY: "ftp://env-proxy:2100" }).problem.reason.includes("ftp://env-proxy:2100"),
    "能解析出主机的坏值要回显剥离后的 scheme://host:port",
  );
  for (const value of ["env-proxy:3128", "not a url", "http://"]) {
    const { problem } = readEnvProxy({ HTTP_PROXY: value });
    assert.ok(!problem.reason.includes(value), `原因不得回显原文：${problem.reason}`);
    assert.ok(problem.reason.includes("不予回显"), `要么给剥离形态、要么明说不回显：${problem.reason}`);
  }
});

test("环境变量：带内联凭据的坏值绝不回显原文（日志与启动提示都不得出现用户名/密码）", () => {
  const LEAK_USER = "leak-user";
  const LEAK_SECRET = "leak-secret-9f3a";
  const cases = [
    // userinfo 在 URL 里：剥离成 scheme://host:port 再回显
    [`socks4://${LEAK_USER}:${LEAK_SECRET}@proxy.local:1080`, "socks4://proxy.local:1080"],
    // 连 URL 都解析不了：只说"不回显"，绝不拼原文
    [`http://${LEAK_USER}:${LEAK_SECRET}@not a url`, "不予回显"],
    // 整个值就是用户误贴的 user:pass（没有 @，也没有 host）：同样不许回显
    [`${LEAK_USER}:${LEAK_SECRET}`, "不予回显"],
  ];

  for (const [value, expected] of cases) {
    const { plan, problem } = readEnvProxy({ HTTP_PROXY: value });
    assert.equal(plan, null, `${value} 不该被当成代理`);
    assert.ok(problem.reason.includes(expected), `应回显剥离后形态 ${expected}：${problem.reason}`);
    assert.ok(!problem.reason.includes(LEAK_USER), `原因里出现了用户名：${problem.reason}`);
    assert.ok(!problem.reason.includes(LEAK_SECRET), `原因里出现了密码：${problem.reason}`);
  }

  // 同一条路径上的日志与启动提示（用户能看见的那两个出口）
  const { lines, log } = collectingLog();
  const result = applyStartupProxy({
    settings: null,
    env: { HTTP_PROXY: cases[1][0] },
    setGlobalDispatcher: dispatcherSpy().setGlobalDispatcher,
    agentFactory: (options) => new EnvHttpProxyAgent(options),
    log,
  });
  assert.equal(result.applied, false);
  const text = [...lines, result.notice ?? ""].join("\n");
  assert.ok(result.notice, "忽略了一个代理设置却一声不吭");
  for (const secret of [LEAK_USER, LEAK_SECRET]) {
    assert.ok(!text.includes(secret), `日志/提示里出现了凭据片段 ${secret}：\n${text}`);
  }

  // 剥离函数本身：坏值原文（含凭据）绝不作为返回值出现
  assert.ok(redactProxyValue(cases[0][0]).includes("socks4://proxy.local:1080"));
  for (const [value] of cases) {
    const shown = redactProxyValue(value);
    assert.ok(!shown.includes(LEAK_USER) && !shown.includes(LEAK_SECRET), `剥离后仍带凭据：${shown}`);
  }
  assert.ok(redactProxyValue("http://proxy.local:8080").includes("http://proxy.local:8080"), "好值原样给");
});

// ---------------------------------------------------------------------------
// 装配：全局 dispatcher
// ---------------------------------------------------------------------------

test("applySettingsProxy：配了就装（选项来自设置），没配就不碰全局 dispatcher", () => {
  const captured = [];
  const spy = dispatcherSpy();
  const agentFactory = (options) => {
    captured.push(options);
    return new EnvHttpProxyAgent(options);
  };

  const applied = applySettingsProxy({
    proxy: configuredProxy(),
    setGlobalDispatcher: spy.setGlobalDispatcher,
    agentFactory,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.source, "settings");
  assert.equal(applied.uri, "http://proxy.local:8080");
  assert.equal(spy.seen.length, 1, "必须真的装到全局 dispatcher 上");
  assert.deepEqual(
    { httpProxy: captured[0].httpProxy, httpsProxy: captured[0].httpsProxy, noProxy: captured[0].noProxy },
    {
      httpProxy: "http://proxy.local:8080",
      httpsProxy: "http://proxy.local:8080",
      noProxy: "localhost,127.0.0.1",
    },
  );
  assert.equal(decode(captured[0].auth), `${USERNAME}:${PASSWORD}`);
  assert.ok(!JSON.stringify(captured[0]).includes(PASSWORD), "装配选项里不得有明文密码");

  const untouched = dispatcherSpy();
  const skipped = applySettingsProxy({
    proxy: configuredProxy({ enabled: false }),
    setGlobalDispatcher: untouched.setGlobalDispatcher,
    agentFactory,
  });
  assert.equal(skipped.applied, false);
  assert.equal(skipped.uri, null);
  assert.deepEqual(untouched.seen, [], "没配代理时绝不动全局 dispatcher");
});

test("applyStartupProxy：设置优先于环境变量；只有环境变量时回落并说明「为什么走了代理」", () => {
  const env = { HTTPS_PROXY: "http://env-proxy:3128" };

  const fromSettings = applyStartupProxy({
    settings: settingsDoc(configuredProxy()),
    env,
    setGlobalDispatcher: dispatcherSpy().setGlobalDispatcher,
    agentFactory: (options) => new EnvHttpProxyAgent(options),
  });
  assert.equal(fromSettings.source, "settings");
  assert.equal(fromSettings.uri, "http://proxy.local:8080");
  assert.ok(fromSettings.notice.includes("proxy.local:8080"), fromSettings.notice);
  assert.ok(!fromSettings.notice.includes("env-proxy"), "设置生效时不该提环境变量");

  const spy = dispatcherSpy();
  const fromEnv = applyStartupProxy({
    settings: settingsDoc({ enabled: false, host: "", port: null, username: "", password: "", bypass: [] }),
    env,
    setGlobalDispatcher: spy.setGlobalDispatcher,
    agentFactory: (options) => new EnvHttpProxyAgent(options),
  });
  assert.equal(fromEnv.source, "env");
  assert.equal(spy.seen.length, 1, "环境变量兜底也必须真的装上");
  assert.equal(fromEnv.uri, "http://env-proxy:3128");
  assert.ok(fromEnv.notice.includes("HTTPS_PROXY"), `提示要说清是哪来的：${fromEnv.notice}`);
  assert.ok(fromEnv.notice.includes("env-proxy:3128"), fromEnv.notice);
});

test("applyStartupProxy：都没有代理时什么都不做（不静默安装、也不发无意义提示）", () => {
  const spy = dispatcherSpy();
  const result = applyStartupProxy({
    settings: settingsDoc({ enabled: false, host: "", port: null, username: "", password: "", bypass: [] }),
    env: {},
    setGlobalDispatcher: spy.setGlobalDispatcher,
    agentFactory: (options) => new EnvHttpProxyAgent(options),
  });
  assert.equal(result.applied, false);
  assert.equal(result.source, null);
  assert.equal(result.notice, null);
  assert.deepEqual(spy.seen, []);
});

test("applyStartupProxy：环境变量的值不可解析 → 不装配，但必须给出可见提示", () => {
  const result = applyStartupProxy({
    settings: null,
    env: { HTTP_PROXY: "env-proxy:3128" },
    setGlobalDispatcher: dispatcherSpy().setGlobalDispatcher,
    agentFactory: (options) => new EnvHttpProxyAgent(options),
  });
  assert.equal(result.applied, false);
  assert.equal(result.source, null);
  assert.ok(result.notice, "忽略了一个代理设置却不能一声不吭");
  assert.ok(result.notice.includes("HTTP_PROXY"), result.notice);
});

test("日志卫生：设置与环境变量两条路径的日志/提示都不含凭据", () => {
  const { lines, log } = collectingLog();
  const withCredentials = { HTTPS_PROXY: `http://env-user:${PASSWORD}@env-proxy:3128` };
  const results = [
    applyStartupProxy({
      settings: settingsDoc(configuredProxy()),
      env: withCredentials,
      setGlobalDispatcher: dispatcherSpy().setGlobalDispatcher,
      agentFactory: (options) => new EnvHttpProxyAgent(options),
      log,
    }),
    applyStartupProxy({
      settings: null,
      env: withCredentials,
      setGlobalDispatcher: dispatcherSpy().setGlobalDispatcher,
      agentFactory: (options) => new EnvHttpProxyAgent(options),
      log,
    }),
  ];

  const text = [...lines, ...results.map((result) => result.notice ?? "")].join("\n");
  for (const secret of [PASSWORD, USERNAME, "env-user", base64(`${USERNAME}:${PASSWORD}`)]) {
    assert.ok(!text.includes(secret), `日志/提示里出现了凭据片段 ${secret}：\n${text}`);
  }
  assert.ok(text.includes("proxy.local:8080"), "该说的 host:port 还是要说");
  assert.ok(text.includes("env-proxy:3128"), "环境变量那条也要说清 host:port");
});

// ---------------------------------------------------------------------------
// 真 dispatcher 行为：本地假代理 + 本地直连服务器（不碰外网）
// ---------------------------------------------------------------------------

test("凭据只发给代理：假代理收到 proxy-authorization，直连路径一个凭据都没有", async (t) => {
  const proxy = await fakeProxy();
  const origin = await localOrigin();
  t.after(async () => {
    await proxy.close();
    await origin.close();
  });

  // 测试专用：关掉隧道，好让假代理以绝对形式请求被观察到（生产路径仍是默认的隧道模式）
  const tunneling = { agentFactory: (options) => new EnvHttpProxyAgent({ ...options, proxyTunnel: false }) };

  const viaProxy = createProxyDispatcher(
    dispatcherOptions(proxyPlan(configuredProxy({ host: "127.0.0.1", port: proxy.port, bypass: [] }))),
    tunneling,
  );
  const response = await fetch(`${origin.url}/proxied`, { dispatcher: viaProxy });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "proxied-ok");
  assert.equal(origin.seen.length, 0, "有代理时不该直连目标");
  assert.equal(proxy.seen.length, 1);
  assert.equal(proxy.seen[0].url, `${origin.url}/proxied`, "代理应收到绝对形式的请求行");
  assert.equal(proxy.seen[0].headers["proxy-authorization"], `Basic ${base64(`${USERNAME}:${PASSWORD}`)}`);
  assert.equal(proxy.seen[0].headers.authorization, undefined, "凭据只给代理，不给目标");

  const direct = createProxyDispatcher(
    dispatcherOptions(proxyPlan(configuredProxy({ host: "127.0.0.1", port: proxy.port, bypass: ["127.0.0.1"] }))),
    tunneling,
  );
  const directResponse = await fetch(`${origin.url}/direct`, { dispatcher: direct });
  assert.equal(await directResponse.text(), "direct-ok");
  assert.equal(origin.seen.length, 1, "例外列表命中就该直连");
  assert.equal(origin.seen[0].headers.authorization, undefined, "直连请求绝不带代理凭据");
  assert.equal(origin.seen[0].headers["proxy-authorization"], undefined);
});

test("testProxyConnection：假代理回 200 → ok；407 → 代理认证失败；拒连 → network", async (t) => {
  const ok = await fakeProxy({ status: 200, body: "pong" });
  const unauthorized = await fakeProxy({ status: 407, body: "proxy auth required" });
  t.after(async () => {
    await ok.close();
    await unauthorized.close();
  });
  const plain = { agentFactory: (options) => new ProxyAgent({ ...options, proxyTunnel: false }) };

  const viaOk = await testProxyConnection({
    proxy: configuredProxy({ host: "127.0.0.1", port: ok.port }),
    url: "http://target.invalid/",
    ...plain,
  });
  assert.equal(viaOk.ok, true, JSON.stringify(viaOk.error ?? null));
  assert.equal(viaOk.status, 200);
  assert.equal(ok.seen.length, 1, "测试连接必须真的走代理");
  assert.equal(ok.seen[0].headers["proxy-authorization"], `Basic ${base64(`${USERNAME}:${PASSWORD}`)}`);

  const viaUnauthorized = await testProxyConnection({
    proxy: configuredProxy({ host: "127.0.0.1", port: unauthorized.port }),
    url: "http://target.invalid/",
    ...plain,
  });
  assert.equal(viaUnauthorized.ok, false);
  assert.equal(viaUnauthorized.error.kind, "proxy_auth_required", JSON.stringify(viaUnauthorized.error));
  assert.ok(!JSON.stringify(viaUnauthorized).includes(PASSWORD), "结果里不得回显凭据");

  const refused = await testProxyConnection({
    proxy: configuredProxy({ host: "127.0.0.1", port: 1 }),
    url: "http://target.invalid/",
    timeoutMs: 3000,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.kind, "network", JSON.stringify(refused.error));
  assert.ok(!JSON.stringify(refused).includes(PASSWORD));
});

test("testProxyConnection：未配置 / 坏 URL / 超时都有结构化结论，且不动全局 dispatcher", async (t) => {
  const hanging = await fakeProxy({ hang: true });
  t.after(() => hanging.close());

  const before = getGlobalDispatcher();
  const notConfigured = await testProxyConnection({
    proxy: configuredProxy({ enabled: false }),
    url: "http://target.invalid/",
  });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.error.kind, "not_configured");

  const badUrl = await testProxyConnection({
    proxy: configuredProxy({ host: "127.0.0.1", port: hanging.port }),
    url: "不是 URL",
  });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.error.kind, "invalid_url");

  const timedOut = await testProxyConnection({
    proxy: configuredProxy({ host: "127.0.0.1", port: hanging.port }),
    url: "http://target.invalid/",
    timeoutMs: 150,
    agentFactory: (options) => new ProxyAgent({ ...options, proxyTunnel: false }),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.kind, "timeout", JSON.stringify(timedOut.error));

  assert.equal(getGlobalDispatcher(), before, "测试连接必须用独立 agent，绝不换掉全局 dispatcher");
});

// ---------------------------------------------------------------------------
// 广播（app:notice）：启动提示的出口
// ---------------------------------------------------------------------------

test("广播帧形状：{channel, payload}，没有 id 也没有 ok（Rust classify_line 只认这个形状）", () => {
  const frames = [];
  const bridge = createBridge({ writable: { write: (chunk) => frames.push(chunk) } });
  const rpc = createRpc({ bridge, dispatcher: { dispatch: () => {} } });

  const result = rpc.broadcast(APP_NOTICE, { text: "已启用代理" });
  assert.equal(result.ok, true);
  const frame = JSON.parse(frames[0]);
  assert.deepEqual(Object.keys(frame).sort(), ["channel", "payload"], `广播帧多/少了字段：${frames[0]}`);
  assert.equal(frame.channel, APP_NOTICE);
  assert.deepEqual(frame.payload, { text: "已启用代理" });
  assert.deepEqual(
    [...BROADCAST_CHANNELS],
    [APP_NOTICE, "auth:status", "player:command"],
    "R7 增补 auth:status（登录状态）、R9 预登记 player:command（R11 托盘）",
  );
});

test("广播白名单外一律拒绝；桥已关闭时如实报错（不静默丢提示）", () => {
  const frames = [];
  const bridge = createBridge({ writable: { write: (chunk) => frames.push(chunk) } });
  const rpc = createRpc({ bridge, dispatcher: { dispatch: () => {} } });

  const rejected = rpc.broadcast("app:not-a-channel", { text: "x" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.kind, CORE_ERROR_KINDS.unknownChannel);
  assert.deepEqual(frames, []);

  bridge.close("测试收尸");
  const closed = rpc.broadcast(APP_NOTICE, { text: "x" });
  assert.equal(closed.ok, false);
  assert.equal(closed.error.kind, CORE_ERROR_KINDS.coreGone);
});

// ---------------------------------------------------------------------------
// 装配顺序与 Rust 接线（源码扫描：按关键字在源码里的出现位置比较先后）
// ---------------------------------------------------------------------------

test("装配顺序：main.mjs 里代理装配先于桥/调度器创建（先于一切业务请求）", async () => {
  const source = await readFile(sidecarEntry, "utf8");
  const positions = {
    读取设置: source.indexOf("settingsStore.read("),
    代理装配: source.indexOf("applyStartupProxy("),
    调度器: source.indexOf("createDispatcher("),
    桥: source.indexOf("createBridge("),
  };
  for (const [label, index] of Object.entries(positions)) {
    assert.ok(index > -1, `main.mjs 里找不到「${label}」（关键字扫描失败）`);
  }
  assert.ok(positions.读取设置 < positions.代理装配, "先读设置再装配");
  assert.ok(
    positions.代理装配 < positions.调度器 && positions.代理装配 < positions.桥,
    `代理装配必须在桥与调度器之前：${JSON.stringify(positions)}`,
  );
});

test("Rust 接线：主窗建窗处必须接 proxy_url（旧仓审计缺陷 K6：主窗漏接则封面/音频绕过代理）", async () => {
  const source = await readFile(join(repoRoot, "src-tauri", "src", "lib.rs"), "utf8");
  const start = source.indexOf("pub fn create_main_window");
  assert.ok(start > -1, "找不到 create_main_window");
  const end = source.indexOf("\npub fn ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);

  assert.ok(body.includes("data_directory("), "这段是建主窗的地方（data_directory 是锚点）");
  assert.ok(body.includes("webview_proxy::resolve_for_webview("), "主窗必须经 webview_proxy 解析代理");
  assert.ok(body.includes(".proxy_url("), "解析出来的代理必须真的接到 builder.proxy_url 上");
  assert.ok(body.includes("MAIN_WINDOW_LABEL"), "窗口 tag 用共享常量，不写裸字符串");
});

test("Rust 接线：webview_proxy 提供四个约定函数，且生产代码的日志不碰凭据字段", async () => {
  const source = await readFile(join(repoRoot, "src-tauri", "src", "webview_proxy.rs"), "utf8");
  for (const needle of [
    "pub fn webview_proxy_url",
    "pub fn parse_settings",
    "pub fn read_proxy",
    "pub fn resolve_for_webview",
  ]) {
    assert.ok(source.includes(needle), `webview_proxy.rs 缺 ${needle}`);
  }
  const production = source.slice(0, source.indexOf("#[cfg(test)]"));
  assert.ok(!/log::[a-z]+!\([^)]*password/.test(production), "日志里不得出现 password");
  assert.ok(!/log::[a-z]+!\([^)]*username/.test(production), "日志里不得出现 username");
});

// ---------------------------------------------------------------------------
// 端到端：真 sidecar 启动时按设置/环境变量兜底，并把启动提示发出来
// ---------------------------------------------------------------------------

test("端到端：设置里有代理 → 启动提示说清来源与 host:port，且不含凭据", async (t) => {
  const dir = await tempDir("e2e-settings");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "settings.json"), JSON.stringify(settingsDoc(configuredProxy())), "utf8");

  const sidecar = startSidecar(["--data-dir", dir], { ...NEUTRAL_ENV, HTTPS_PROXY: "http://env-proxy:3128" });
  t.after(() => sidecar.stop());
  const notice = await sidecar.waitForNotice();
  assert.ok(notice, `启动后没有收到 app:notice；stdout=${JSON.stringify(sidecar.frames)}`);
  const text = notice.payload.text;
  assert.ok(text.includes("proxy.local:8080"), text);
  assert.ok(!text.includes("env-proxy"), `设置优先于环境变量：${text}`);

  const all = `${JSON.stringify(sidecar.frames)}\n${sidecar.stderrText()}`;
  for (const secret of [PASSWORD, USERNAME]) {
    assert.ok(!all.includes(secret), `凭据漏进了协议或日志：${secret}`);
  }
});

test("端到端：设置没代理 + 环境变量有代理 → 兜底生效并提示为什么走了代理", async (t) => {
  const dir = await tempDir("e2e-env");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sidecar = startSidecar(["--data-dir", dir], {
    ...NEUTRAL_ENV,
    HTTPS_PROXY: `http://env-user:${PASSWORD}@env-proxy:3128`,
  });
  t.after(() => sidecar.stop());
  const notice = await sidecar.waitForNotice();
  assert.ok(notice, `启动后没有收到 app:notice；stdout=${JSON.stringify(sidecar.frames)}`);
  const text = notice.payload.text;
  assert.ok(text.includes("HTTPS_PROXY"), text);
  assert.ok(text.includes("env-proxy:3128"), text);
  assert.ok(!text.includes(PASSWORD) && !text.includes("env-user"), `提示里不得回显凭据：${text}`);

  const all = `${JSON.stringify(sidecar.frames)}\n${sidecar.stderrText()}`;
  assert.ok(!all.includes(PASSWORD), "凭据不得出现在协议或日志里");
  assert.ok(!all.includes("env-user"), "用户名不得出现在协议或日志里");
});

test("端到端：坏环境变量值里的凭据既不进 stderr，也不进启动提示", async (t) => {
  const LEAK_USER = "leak-user";
  const LEAK_SECRET = "leak-secret-9f3a";
  const dir = await tempDir("e2e-env-leak");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sidecar = startSidecar(["--data-dir", dir], {
    ...NEUTRAL_ENV,
    ALL_PROXY: `socks4://${LEAK_USER}:${LEAK_SECRET}@proxy.local:1080`,
  });
  t.after(() => sidecar.stop());
  const notice = await sidecar.waitForNotice();
  assert.ok(notice, `坏环境变量也必须有一条可见提示；stdout=${JSON.stringify(sidecar.frames)}`);
  assert.ok(notice.payload.text.includes("ALL_PROXY"), notice.payload.text);
  assert.ok(
    notice.payload.text.includes("socks4://proxy.local:1080"),
    `提示要给剥离后的 host:port：${notice.payload.text}`,
  );

  const all = `${JSON.stringify(sidecar.frames)}\n${sidecar.stderrText()}`;
  for (const secret of [LEAK_USER, LEAK_SECRET]) {
    assert.ok(!all.includes(secret), `凭据漏进了协议或 stderr：${secret}\n${all}`);
  }
});

test("端到端：没有代理时不起哄（没有 app:notice，也不把空白环境变量当代理）", async (t) => {
  const dir = await tempDir("e2e-none");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sidecar = startSidecar(["--data-dir", dir], NEUTRAL_ENV);
  t.after(() => sidecar.stop());
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(sidecar.frames.filter((frame) => frame.channel === APP_NOTICE), [], "没有代理时不该发提示");
  assert.ok(!sidecar.stderrText().includes(PASSWORD));
});

test("端到端：settings:get / settings:set 已真的实现（不是 unimplemented），凭据能存能读", async (t) => {
  const dir = await tempDir("e2e-channels");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sidecar = startSidecar(["--data-dir", dir]);
  t.after(() => sidecar.stop());
  const bridge = sidecar.bridge();

  const got = await bridge.call("settings:get", null);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.data.settings.schemaVersion, 1);
  assert.equal(got.data.settings.data.proxy.enabled, false);

  const saved = await bridge.call("settings:set", { patch: { proxy: configuredProxy() } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data.restartRequired, true, "代理改动要重启才生效");
  const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  assert.equal(onDisk.data.proxy.host, "proxy.local");
  assert.equal(onDisk.data.proxy.password, PASSWORD, "磁盘是单一真源：凭据要能存下来");
  assert.deepEqual(onDisk.data.proxy.bypass, ["localhost", "127.0.0.1"]);
  assert.equal(onDisk.data.closeBehavior, "tray", "closeBehavior 本任务只存不消费（R11 读）");
});

test("端到端：没有数据目录时 settings:set 不谎报成功（也不回显凭据）", async (t) => {
  const sidecar = startSidecar([]);
  t.after(() => sidecar.stop());
  const bridge = sidecar.bridge();

  const saved = await bridge.call("settings:set", { patch: { proxy: configuredProxy() } });
  assert.equal(saved.ok, false, JSON.stringify(saved));
  assert.ok(!JSON.stringify(saved).includes(PASSWORD), "错误里不得回显凭据");
  assert.ok(saved.error.message.includes("数据目录"), saved.error.message);
});
