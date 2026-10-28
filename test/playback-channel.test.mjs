/**
 * 播放地址通道（`playback:resolve-url`）：边界、结构化错误、地址不外泄。
 *
 * 与库页面频道不同，它的正常结果里本就带播放地址，所以要钉的是：地址只出现在当次应答里
 * （不写日志、不持久化）、失败路径不回显整段地址、坏载荷在边界被拒、端点未配置返回结构化 `endpoint_unknown`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPlaybackHandlers } from "../src/host/playback-handlers.mjs";
import { createMusicApi } from "../src/protocols/music.mjs";
import { PLAYBACK_LYRICS, PLAYBACK_RESOLVE_URL } from "../src/shared/request-channels.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 只扫代码，不扫注释：注释里写"不许 console"、写频道名都是说明文字，不是违规。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SAFE_URL = "https://music.dbankcdn.cn/song/1.mp3";
const UNSAFE_URL = "https://evil.example.com/song/1.mp3";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 注入 fetch：playback 端点回脚本化的业务信封，并记录调用。 */
function scriptedApi(payload, { endpoints = { playback: "https://example.invalid/api/playback" } } = {}) {
  const calls = [];
  const api = createMusicApi({
    endpoints,
    // 播放地址是带凭据的调用（真接口要求音乐会话），所以注入一个假会话。
    session: { token: "MUSIC-TOKEN", snsUserID: "SNS-1" },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init, body: init.body === undefined ? null : JSON.parse(init.body) });
      return jsonResponse({ result: { resultCode: "000000" }, ...payload });
    },
  });
  return { api, calls };
}

/** 用真 api（端点未配置）造处理器：`endpoint_unknown` 的真实来源。 */
function handlerWith(api) {
  return createPlaybackHandlers({ api })[PLAYBACK_RESOLVE_URL];
}

test("频道名来自共享常量：处理器表的键就是那两个 playback 频道（不另立字面量）", () => {
  const handlers = createPlaybackHandlers({ api: { getPlayback: async () => ({ ok: true, data: {} }) } });
  assert.deepEqual(Object.keys(handlers), [PLAYBACK_RESOLVE_URL, PLAYBACK_LYRICS]);
  assert.equal(PLAYBACK_RESOLVE_URL, "playback:resolve-url");
  assert.equal(PLAYBACK_LYRICS, "playback:lyrics", "R12 的歌词文本次通道（同一个处理器表，不另立清单）");

  const source = read("src/host/playback-handlers.mjs");
  assert.match(source, /PLAYBACK_RESOLVE_URL/, "处理器必须 import 共享常量");
  assert.doesNotMatch(stripComments(source), /["'`]playback:(?:resolve-url|lyrics)["'`]/, "不得出现第二份频道名字面量");
});

test("正常路径：{trackId} → 协议层 getPlayback，当次应答里带着放行过的地址", async () => {
  const { api, calls } = scriptedApi({ fileURL: SAFE_URL, duration: 215 });
  const answer = await handlerWith(api)({ payload: { trackId: " 101 " } });

  assert.equal(answer.ok, true, `正常路径应当成功：${JSON.stringify(answer)}`);
  assert.equal(answer.data.url, SAFE_URL, "地址只作当次播放结果交给渲染层");
  assert.equal(answer.data.duration, 215);
  assert.equal(calls.length, 1, "只打一次播放端点");
  // 参数进 JSON 体（真接口的 POST 形状），不再是查询串。
  assert.deepEqual(calls[0].body, { contentCode: "101", contentType: "1", qualityType: "1" }, "trackId 去空白后作为 contentCode");
});

test("坏载荷在边界被拒：缺/空白/非字符串 trackId → invalid_payload，且不打协议层", async () => {
  let called = 0;
  const handler = handlerWith({
    getPlayback: async () => {
      called += 1;
      return { ok: true, data: {} };
    },
  });

  for (const payload of [{}, { trackId: "" }, { trackId: "   " }, { trackId: 42 }, { trackId: null }, null, "nope", 7]) {
    const answer = await handler({ payload });
    assert.equal(answer.ok, false, `坏载荷不许成功：${JSON.stringify(payload)}`);
    assert.equal(answer.error.kind, "invalid_payload", `类别要能分支：${JSON.stringify(answer)}`);
    assert.match(answer.error.message, /trackId/);
  }
  assert.equal(called, 0, "坏参数不该被透给协议层（那只会拼出一个必然失败的请求）");
});

test("端点未配置：结构化 endpoint_unknown（不冒充已实现、不猜 URL）", async () => {
  const answer = await handlerWith(createMusicApi({ endpoints: {}, fetchImpl: async () => jsonResponse({}) }))({
    payload: { trackId: "1" },
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.kind, "endpoint_unknown");
  assert.match(answer.error.message, /playback/, "要说清是哪个端点没配");
});

test("白名单外的播放地址：unsafe_media_url，且失败文案回显的只有域名、不是整段地址", async () => {
  const { api } = scriptedApi({ fileURL: UNSAFE_URL });
  const answer = await handlerWith(api)({ payload: { trackId: "1" } });

  assert.equal(answer.ok, false);
  assert.equal(answer.error.kind, "unsafe_media_url");
  assert.ok(
    !answer.error.message.includes(UNSAFE_URL),
    `失败文案不许回显整段地址（泄漏面）：${answer.error.message}`,
  );
  assert.match(answer.error.message, /evil\.example\.com/, "但要说清是哪个域名不合格，否则没法排查");
});

test("缺顶层 fileURL（fileInfos 只是音质列表）：invalid_response —— 不猜别的字段当音频", async () => {
  const { api } = scriptedApi({ fileInfos: JSON.stringify([{ format: "flac" }]), bitrate: 999 });
  const answer = await handlerWith(api)({ payload: { trackId: "1" } });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.kind, "invalid_response");
});

test("地址不落痕迹：整条链路（成功 + 各失败路径）一次 console.error/log 都不写", async () => {
  const errors = [];
  const infos = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.warn = (...args) => infos.push(args.map(String).join(" "));
  try {
    const { api } = scriptedApi({ fileURL: SAFE_URL });
    const handler = handlerWith(api);
    await handler({ payload: { trackId: "1" } });
    await handler({ payload: {} });
    await handlerWith(scriptedApi({ fileURL: UNSAFE_URL }).api)({ payload: { trackId: "2" } });
    await handlerWith(createMusicApi({ endpoints: {}, fetchImpl: async () => jsonResponse({}) }))({
      payload: { trackId: "3" },
    });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.deepEqual(errors, [], "播放地址的处理过程不许写日志（stdout/stderr 都可能被收集）");
  assert.deepEqual(infos, []);

  // 源码层同样钉一次：这个文件里根本没有日志与持久化出口
  const source = stripComments(read("src/host/playback-handlers.mjs"));
  assert.doesNotMatch(source, /console\./, "不许有 console 出口");
  assert.doesNotMatch(source, /settings|writeFile|node:fs/, "不许有任何持久化出口（地址不落盘）");
});
