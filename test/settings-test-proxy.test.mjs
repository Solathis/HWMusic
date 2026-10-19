/**
 * R10 设置页 · `settings:test-proxy` 频道（把 R6 的 `testProxyConnection` 接到界面）。
 *
 * 要钉住的四件事：
 * 1. **频道只有一份清单**：新频道必须进 `src/shared/request-channels.ts`（Rust 镜像由
 *    test/channel-parity.test.mjs 钉住；少一侧的后果是界面点"测试连接"拿到 `unknown_channel`）；
 * 2. **坏载荷在边界被拒**，且**不去打扰网络**（测试器一次都不该被调用）；
 * 3. **凭据必须原样到达测试器**（不然测的是另一个代理），但**绝不出现在任何答复文案里**；
 * 4. 测试目标 URL 是**固定常量**：不猜业务端点、也不接受调用方指定（那是把一个开放代理
 *    塞进渲染层手里）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROXY_TEST_URL,
  createProxyHandlers,
} from "../src/host/proxy-handlers.mjs";
import { REQUEST_CHANNELS, SETTINGS_TEST_PROXY } from "../src/shared/request-channels.ts";
import { CORE_ERROR_KINDS } from "../src/shared/result.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 测试用凭据：抓任何漏进文案/日志的地方。 */
const PASSWORD = "s3cret-proxy-token";

function draftProxy(overrides = {}) {
  return {
    enabled: true,
    host: "proxy.local",
    port: "8080",
    username: "proxy-user",
    password: PASSWORD,
    bypass: ["localhost"],
    ...overrides,
  };
}

/** 记录调用参数的假测试器（真测试器要发网络请求，测试里一律注入桩）。 */
function recordingTester(result = { ok: true, ms: 42, status: 200 }) {
  const calls = [];
  return {
    calls,
    testProxy: async (options) => {
      calls.push(options);
      return result;
    },
  };
}

const handlerFor = (options) => createProxyHandlers(options)[SETTINGS_TEST_PROXY];

test("频道：settings:test-proxy 进共享白名单，且处理器与频道名同源", () => {
  assert.equal(SETTINGS_TEST_PROXY, "settings:test-proxy");
  assert.ok(REQUEST_CHANNELS.includes(SETTINGS_TEST_PROXY), "新频道必须在唯一真源里");
  assert.deepEqual(
    Object.keys(createProxyHandlers({ testProxy: () => undefined })),
    [SETTINGS_TEST_PROXY],
    "处理器表的键就是频道常量（不许另写字面量）",
  );
  const source = read("src/host/proxy-handlers.mjs");
  assert.doesNotMatch(source, /["']settings:test-proxy["']/, "频道名一律 import 共享常量");
});

test("测试目标：固定常量（不接受调用方指定 URL）", () => {
  assert.equal(typeof PROXY_TEST_URL, "string");
  assert.match(PROXY_TEST_URL, /^https:\/\/[a-z0-9.-]+\/$/, `目标要是明确的 https 主机根路径：${PROXY_TEST_URL}`);
  assert.ok(
    PROXY_TEST_URL.startsWith("https://oauth-login1.cloud.huawei.com/"),
    "用 R4 已确认可达的官方授权主机（业务端点仍待联调，不许猜）",
  );

  const { calls, testProxy } = recordingTester();
  return handlerFor({ testProxy })({ channel: SETTINGS_TEST_PROXY, payload: { proxy: draftProxy(), url: "https://evil.example/" } }).then(
    () => {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, PROXY_TEST_URL, "载荷里给的 url 必须被忽略");
    },
  );
});

test("载荷：凭据原样送到测试器（测的是用户刚填的那个代理）", async () => {
  const { calls, testProxy } = recordingTester();
  const result = await handlerFor({ testProxy })({
    channel: SETTINGS_TEST_PROXY,
    payload: { proxy: draftProxy() },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ proxy: draftProxy(), url: PROXY_TEST_URL }]);
  assert.deepEqual(result.data, { result: { ok: true, ms: 42, status: 200 } }, "测试结论原样透传给渲染层");
});

test("载荷：坏载荷结构化拒绝，且一次都不去打扰网络", async () => {
  const { calls, testProxy } = recordingTester();
  const handler = handlerFor({ testProxy });

  for (const payload of [null, undefined, {}, { proxy: null }, { proxy: "proxy.local" }, { proxy: [] }, { proxy: 42 }]) {
    const result = await handler({ channel: SETTINGS_TEST_PROXY, payload });
    assert.equal(result.ok, false, `payload=${JSON.stringify(payload)} 该被拒`);
    assert.equal(result.error.kind, CORE_ERROR_KINDS.invalidPayload, JSON.stringify(result.error));
    assert.match(result.error.message, /proxy/, `文案要指明缺什么：${result.error.message}`);
  }
  assert.deepEqual(calls, [], "坏载荷不该发请求");
});

test("凭据卫生：答复文案里不出现用户名/密码，处理器也不写日志", async () => {
  const { testProxy } = recordingTester({
    ok: false,
    ms: 12,
    error: { kind: "network", message: "无法通过该代理建立连接（ECONNREFUSED）" },
  });
  const result = await handlerFor({ testProxy })({
    channel: SETTINGS_TEST_PROXY,
    payload: { proxy: draftProxy() },
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes(PASSWORD), `答复里漏进了密码：${text}`);
  assert.ok(!text.includes("proxy-user"), `答复里漏进了用户名：${text}`);

  // 坏载荷那条路也不能回显载荷内容
  const bad = await handlerFor({ testProxy })({
    channel: SETTINGS_TEST_PROXY,
    payload: { proxy: null, password: PASSWORD },
  });
  assert.ok(!JSON.stringify(bad).includes(PASSWORD), `坏载荷路径回显了密码：${JSON.stringify(bad)}`);

  const source = read("src/host/proxy-handlers.mjs");
  assert.doesNotMatch(source, /console\./, "处理器不写日志（凭据可能就在入参里）");
  assert.doesNotMatch(source, /payload\b[^\n]*\+\s*/, "错误文案不许拼接载荷内容");
});

test("注入纪律：没有测试器就不许装成能用（TypeError 立刻炸，不静默）", () => {
  for (const bad of [undefined, null, {}, "testProxy"]) {
    assert.throws(
      () => createProxyHandlers({ testProxy: bad }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /testProxy/, error.message);
        return true;
      },
      `testProxy=${JSON.stringify(bad)} 该被拒`,
    );
  }
});

test("接线：sidecar 把 R6 的 testProxyConnection 接到这个频道上（没接就是 unimplemented）", () => {
  const main = read("src/sidecar/main.mjs");
  assert.match(main, /createProxyHandlers\(/, "sidecar 要装这张处理器表");
  assert.match(main, /testProxy:\s*testProxyConnection/, "测试器就是 R6 那一个（不另写一份探测逻辑）");
  assert.match(main, /from\s+"\.\.\/main\/proxy\.mjs"/, "从 proxy.mjs 导入（唯一实现）");
  assert.match(
    main,
    /Object\.entries\(createProxyHandlers/,
    "按处理器表的键注册（频道名不在入口里再抄一遍）",
  );
});
