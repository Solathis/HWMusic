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
import { createLibraryHandlers } from "../src/host/library-handlers.mjs";
import { createMusicService, readMusicEndpoints } from "../src/main/music-service.mjs";
import { createRpc } from "../src/host/rpc.mjs";
import { createHostServices } from "../src/host/host-services.mjs";
import {
  HOST_CANCEL_LOGIN,
  HOST_NOTIFY,
  HOST_OPEN_LOGIN,
  HOST_REQUEST_CHANNELS,
  HOST_SECURE_DECRYPT,
  HOST_SECURE_ENCRYPT,
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_FAVORITES,
  LIBRARY_HISTORY,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_PLAYLISTS,
  LIBRARY_SEARCH,
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

/* ---------------------------------------------------------------------------
 * R8：library:* 七条频道的路由（注入 music 模块桩——协议层真身由 test/music.test.mjs 钉）
 * ------------------------------------------------------------------------- */

/** music.mjs 的桩：记录调用、按脚本答复。 */
function stubMusicApi(answers = {}) {
  const calls = [];
  const record = (name, ...args) => {
    calls.push({ name, args });
    return answers[name] ?? ok({ stub: name });
  };
  return {
    calls,
    api: {
      readFavoritesPage: (request) => record("readFavoritesPage", request),
      listPlaylists: (request) => record("listPlaylists", request),
      getPlaylistDetail: (id, request) => record("getPlaylistDetail", id, request),
      search: (keyword, request) => record("search", keyword, request),
      getAlbum: (id, request) => record("getAlbum", id, request),
      getArtist: (id, request) => record("getArtist", id, request),
      getHistory: (request) => record("getHistory", request),
    },
  };
}

async function dispatchLibrary(dispatcher, channel, payload) {
  const responder = createResponder();
  await dispatcher.dispatch({ id: `lib-${channel}`, channel, payload }, responder.respond);
  assert.equal(responder.answers.length, 1, `${channel} 必须恰好答复一次`);
  return responder.answers[0];
}

test("dispatcher：library:* 七条频道都注册得上并路由到 music 模块（参数逐条对上）", async () => {
  const stub = stubMusicApi();
  const dispatcher = createDispatcher();
  for (const [channel, handler] of Object.entries(createLibraryHandlers({ api: stub.api }))) {
    dispatcher.register(channel, handler);
  }

  const favorites = await dispatchLibrary(dispatcher, LIBRARY_FAVORITES, { page: 2, pageSize: 30 });
  assert.equal(favorites.ok, true);
  assert.deepEqual(stub.calls.at(-1), {
    name: "readFavoritesPage",
    args: [{ page: 2, pageSize: 30, params: undefined }],
  });

  const playlists = await dispatchLibrary(dispatcher, LIBRARY_PLAYLISTS, { page: 1 });
  assert.equal(playlists.ok, true);
  assert.equal(stub.calls.at(-1).name, "listPlaylists");

  const detail = await dispatchLibrary(dispatcher, LIBRARY_PLAYLIST_DETAIL, { playlistId: "P-1", page: 3, pageSize: 10 });
  assert.equal(detail.ok, true);
  assert.deepEqual(stub.calls.at(-1).args.slice(0, 2), ["P-1", { page: 3, pageSize: 10, params: undefined }]);

  const search = await dispatchLibrary(dispatcher, LIBRARY_SEARCH, { keyword: "  周杰伦 " });
  assert.equal(search.ok, true);
  assert.equal(stub.calls.at(-1).args[0], "周杰伦", "关键字去首尾空白");

  const album = await dispatchLibrary(dispatcher, LIBRARY_ALBUM, { albumId: "A-1" });
  assert.equal(album.ok, true);
  assert.equal(stub.calls.at(-1).name, "getAlbum");
  assert.equal(stub.calls.at(-1).args[0], "A-1");

  const artist = await dispatchLibrary(dispatcher, LIBRARY_ARTIST, { artistId: "B-1" });
  assert.equal(artist.ok, true);
  assert.equal(stub.calls.at(-1).args[0], "B-1");

  const history = await dispatchLibrary(dispatcher, LIBRARY_HISTORY, { page: 1 });
  assert.equal(history.ok, true);
  assert.equal(stub.calls.at(-1).name, "getHistory");

  assert.equal(stub.calls.length, 7, "七条频道各打一次协议层，不多不少");
});

test("dispatcher：library 的坏载荷在边界就被拒（invalid_payload），不透给协议层", async () => {
  const stub = stubMusicApi();
  const dispatcher = createDispatcher();
  for (const [channel, handler] of Object.entries(createLibraryHandlers({ api: stub.api }))) {
    dispatcher.register(channel, handler);
  }

  const cases = [
    [LIBRARY_PLAYLIST_DETAIL, {}],
    [LIBRARY_PLAYLIST_DETAIL, { playlistId: "   " }],
    [LIBRARY_SEARCH, {}],
    [LIBRARY_SEARCH, { keyword: "  " }],
    [LIBRARY_SEARCH, { keyword: 42 }],
    [LIBRARY_ALBUM, {}],
    [LIBRARY_ARTIST, { artistId: null }],
  ];
  for (const [channel, payload] of cases) {
    const answer = await dispatchLibrary(dispatcher, channel, payload);
    assert.equal(answer.ok, false, `${channel} 的坏载荷必须失败：${JSON.stringify(payload)}`);
    assert.equal(answer.error.kind, "invalid_payload", `${channel} ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(stub.calls, [], "坏载荷不许打到协议层");

  // 收藏/歌单列表/历史没有必填参数：坏页号由协议层自己归一（不在这里猜）
  const page = await dispatchLibrary(dispatcher, LIBRARY_FAVORITES, { page: "NaN" });
  assert.equal(page.ok, true);
  assert.deepEqual(stub.calls.at(-1).args, [{ page: undefined, pageSize: undefined, params: undefined }]);
});

test("dispatcher：端点未配置时 library:* 回结构化 endpoint_unknown（不是空列表、不是假成功）", async () => {
  const service = createMusicService({ settingsData: {}, fetchImpl: async () => assert.fail("不该发出请求") });
  assert.deepEqual(service.endpoints, {}, "没有任何写入方时端点表必须是空的");

  const dispatcher = createDispatcher();
  for (const [channel, handler] of Object.entries(createLibraryHandlers({ api: service.api }))) {
    dispatcher.register(channel, handler);
  }

  for (const [channel, payload] of [
    [LIBRARY_FAVORITES, { page: 1 }],
    [LIBRARY_PLAYLISTS, {}],
    [LIBRARY_PLAYLIST_DETAIL, { playlistId: "P-1" }],
    [LIBRARY_ALBUM, { albumId: "A-1" }],
    [LIBRARY_ARTIST, { artistId: "B-1" }],
    [LIBRARY_HISTORY, {}],
  ]) {
    const answer = await dispatchLibrary(dispatcher, channel, payload);
    assert.equal(answer.ok, false, `${channel} 在端点未配置时不能"成功"`);
    assert.equal(answer.error.kind, "endpoint_unknown", `${channel} 的失败类别要能被 UI 认出来`);
  }

  const search = await dispatchLibrary(dispatcher, LIBRARY_SEARCH, { keyword: "abc" });
  assert.equal(search.error.kind, "endpoint_unknown");
});

test("音乐端点注入表：只从设置文档收已知键（非 https/空值/陌生键一律丢弃，不猜）", () => {
  assert.deepEqual(readMusicEndpoints(undefined), {});
  assert.deepEqual(readMusicEndpoints({ musicEndpoints: null }), {});
  assert.deepEqual(readMusicEndpoints({ musicEndpoints: "https://example.invalid/api" }), {});
  assert.deepEqual(
    readMusicEndpoints({
      musicEndpoints: {
        favorites: "https://example.invalid/api/favorites",
        album: "  ",
        artist: 42,
        somethingElse: "https://example.invalid/api/other",
      },
    }),
    { favorites: "https://example.invalid/api/favorites" },
    "只收 MUSIC_ENDPOINT_KEYS 里的键与非空字符串值",
  );

  const service = createMusicService({
    settingsData: { musicEndpoints: { favorites: "https://example.invalid/api/favorites" } },
    fetchImpl: async () => new Response(JSON.stringify({ code: "0", data: { list: [] } }), { status: 200 }),
  });
  assert.deepEqual(service.endpoints, { favorites: "https://example.invalid/api/favorites" });
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
