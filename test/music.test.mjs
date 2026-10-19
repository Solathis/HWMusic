/**
 * R4 协议原型层 · 华为业务接口（src/protocols/music.mjs）。
 *
 * 端点一律注入（真实 URL 待授权探针/R7 联调确认，见 docs/API_CONTRACT.md），测试用注入 fetch：
 * - 收藏无直报总数 → 总数 = 完整分页后 ID 去重，与"已加载 N 首"分开；
 * - playback 顶层 fileURL 才是音频，fileInfos 可能是 JSON 字符串；
 * - auditionTime 不能单独判 30 秒试听（需第二信号）；
 * - 自建歌单删除必须 playlistDelete 端点，不允许拿收藏端点冒充成功。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MUSIC_ENDPOINT_KEYS,
  MUSIC_ERROR_KINDS,
  classifyAudition,
  createMusicApi,
  decodeEnvelope,
  extractList,
  parseFileInfos,
  trackIdOf,
} from "../src/protocols/music.mjs";

/** 合成端点：不代表真实 URL（真实值见 docs/API_CONTRACT.md）。 */
const ENDPOINTS = {
  favorites: "https://example.invalid/api/favorites",
  playlistList: "https://example.invalid/api/playlist/list",
  playlistDelete: "https://example.invalid/api/playlist/delete",
  search: "https://example.invalid/api/search",
  album: "https://example.invalid/api/album",
  artist: "https://example.invalid/api/artist",
  history: "https://example.invalid/api/history",
  playback: "https://example.invalid/api/playback",
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 注入 fetch：按 URL 片段分发脚本化响应，并记录全部调用。 */
function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const hit = routes.find((route) => url.includes(route.match));
    calls.push({ url, init, matched: hit ? hit.match : null });
    if (!hit) throw new Error(`未脚本化的请求：${url}`);
    const answer = typeof hit.reply === "function" ? hit.reply(calls.length) : hit.reply;
    if (answer instanceof Error) throw answer;
    return answer.clone();
  };
  return { calls, fetchImpl };
}

const song = (id, extra = {}) => ({ id, name: `歌${id}`, ...extra });
const envelope = (data, extra = {}) => ({ code: "0", data, ...extra });

function apiOf(options = {}) {
  const fetchImpl = options.fetchImpl ?? (async () => jsonResponse(envelope({ list: [] })));
  return createMusicApi({ endpoints: options.endpoints ?? ENDPOINTS, fetchImpl, ...options.api });
}

test("端点注入：清单是唯一真源；缺端点的方法返回结构化 endpoint_unknown（绝不猜 URL）", async () => {
  assert.deepEqual([...MUSIC_ENDPOINT_KEYS].sort(), [
    "album",
    "artist",
    "favorites",
    "history",
    "playback",
    "playlistDelete",
    "playlistList",
    "search",
  ]);

  const api = apiOf({ endpoints: {} });
  const result = await api.listFavoritesPage();
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);
  assert.match(result.error.message, /favorites/);

  const bad = apiOf({ endpoints: { favorites: "http://example.invalid/api/favorites" } });
  const insecure = await bad.listFavoritesPage();
  assert.equal(insecure.ok, false);
  assert.equal(insecure.error.kind, MUSIC_ERROR_KINDS.endpointUnknown, "非 https 端点一律视为未确定");
});

test("响应解码：code 0/缺失为成功；非 0 → api_error（带码与简短说明，不回显整段响应体）", () => {
  assert.deepEqual(decodeEnvelope({ code: "0", data: { list: [1] } }), { ok: true, data: { list: [1] } });
  assert.deepEqual(decodeEnvelope({ code: 0, data: {} }), { ok: true, data: {} });
  assert.deepEqual(decodeEnvelope({ list: [1] }), { ok: true, data: { list: [1] } }, "无 code 字段视为直给数据");
  assert.deepEqual(decodeEnvelope([1, 2]), { ok: true, data: [1, 2] });

  const failure = decodeEnvelope({ code: "10001", msg: "参数错误", data: { secret: "SHOULD-NOT-LEAK" } });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.kind, MUSIC_ERROR_KINDS.apiError);
  assert.match(failure.error.message, /10001/);
  assert.match(failure.error.message, /参数错误/);
  assert.doesNotMatch(failure.error.message, /SHOULD-NOT-LEAK/);

  const notObject = decodeEnvelope("<html>502</html>");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
});

test("列表提取与歌曲 ID：兼容多种容器命名，无 ID 的条目如实丢弃", () => {
  assert.deepEqual(extractList([1, 2]), [1, 2]);
  assert.deepEqual(extractList({ list: [1] }), [1]);
  assert.deepEqual(extractList({ items: [1] }), [1]);
  assert.deepEqual(extractList({ songs: [1] }), [1]);
  assert.deepEqual(extractList({ records: [1] }), [1]);
  assert.deepEqual(extractList({ data: { list: [1] } }), [1]);
  assert.deepEqual(extractList({ nothing: true }), []);
  assert.deepEqual(extractList(null), []);

  assert.equal(trackIdOf({ id: "1" }), "1");
  assert.equal(trackIdOf({ songId: 2 }), "2");
  assert.equal(trackIdOf({ musicId: "3" }), "3");
  assert.equal(trackIdOf({ resourceId: "4" }), "4");
  assert.equal(trackIdOf({ name: "无 ID" }), null);
  assert.equal(trackIdOf(null), null);
});

test("收藏分页：总数 = 完整分页后 ID 去重；与已加载数分开；上报总数不可信", async () => {
  const pages = [
    { match: "page=1", reply: jsonResponse(envelope({ list: [song("s1"), song("s2")], hasMore: true, total: 9999 })) },
    { match: "page=2", reply: jsonResponse(envelope({ list: [song("s2"), song("s3")], hasMore: false, total: 9999 })) },
  ];
  const { calls, fetchImpl } = scriptedFetch(pages);
  const api = apiOf({ fetchImpl, api: { pageSize: 2 } });

  const result = await api.loadAllFavorites();
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.songs.map((item) => item.id), ["s1", "s2", "s3"], "去重且保持首次出现顺序");
  assert.equal(result.data.loadedCount, 3);
  assert.equal(result.data.total, 3, "总数只能来自完整分页后的去重结果");
  assert.equal(result.data.reportedTotal, 9999, "接口上报的 total 只作记录，不当真值");
  assert.equal(result.data.isComplete, true);
  assert.equal(result.data.pages, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/example\.invalid\/api\/favorites\?/);
});

test("收藏分页：渐进加载时 total 未知（null），完成那一刻才有值", async () => {
  const { fetchImpl } = scriptedFetch([
    { match: "page=1", reply: jsonResponse(envelope({ list: [song("s1"), song("s2")], hasMore: true })) },
    { match: "page=2", reply: jsonResponse(envelope({ list: [song("s3")], hasMore: false })) },
  ]);
  const api = apiOf({ fetchImpl, api: { pageSize: 2 } });
  const loader = api.createFavoritesLoader();

  const first = await loader.loadNext();
  assert.equal(first.ok, true);
  assert.equal(first.data.loadedCount, 2);
  assert.equal(first.data.added, 2);
  assert.equal(first.data.total, null, "没走完分页就不许报总数");
  assert.equal(first.data.isComplete, false);

  const second = await loader.loadNext();
  assert.equal(second.ok, true);
  assert.equal(second.data.added, 1);
  assert.equal(second.data.total, 3);
  assert.equal(second.data.isComplete, true);
  assert.equal(second.data.stopReason, "exhausted");

  assert.deepEqual(loader.snapshot(), {
    songs: [song("s1"), song("s2"), song("s3")],
    loadedCount: 3,
    total: 3,
    reportedTotal: null,
    skipped: 0,
    pages: 2,
    isComplete: true,
    stopReason: "exhausted",
  });

  const third = await loader.loadNext();
  assert.equal(third.ok, true);
  assert.equal(third.data.added, 0, "已完成后不再发请求");
});

test("收藏分页：短页即到底（接口不发 hasMore 时）；页数上限如实标记未走完", async () => {
  const shortPage = scriptedFetch([
    { match: "page=1", reply: jsonResponse(envelope({ list: [song("s1")] })) },
  ]);
  const shortApi = apiOf({ fetchImpl: shortPage.fetchImpl, api: { pageSize: 2 } });
  const short = await shortApi.loadAllFavorites();
  assert.equal(short.data.isComplete, true, "返回条数少于一页 → 到底");
  assert.equal(short.data.stopReason, "exhausted");
  assert.equal(short.data.total, 1);

  let page = 0;
  const endless = apiOf({
    fetchImpl: async () => {
      page += 1;
      return jsonResponse(envelope({ list: [song(`s${page}`)], hasMore: true }));
    },
    api: { pageSize: 1, maxPages: 3 },
  });
  const capped = await endless.loadAllFavorites();
  assert.equal(capped.ok, true);
  assert.equal(capped.data.pages, 3);
  assert.equal(capped.data.isComplete, false, "触到上限就是没走完，不许假装完整");
  assert.equal(capped.data.stopReason, "max_pages");
  assert.equal(capped.data.total, null, "未走完 → 总数仍未知");
});

test("收藏分页：无 ID 条目被丢弃并计数；中途失败保留已加载内容并如实报错", async () => {
  const withJunk = scriptedFetch([
    { match: "page=1", reply: jsonResponse(envelope({ list: [song("s1"), { name: "没有 id" }], hasMore: false })) },
  ]);
  const junkApi = apiOf({ fetchImpl: withJunk.fetchImpl, api: { pageSize: 2 } });
  const junk = await junkApi.loadAllFavorites();
  assert.deepEqual(junk.data.songs.map((item) => item.id), ["s1"]);
  assert.equal(junk.data.skipped, 1);

  const broken = scriptedFetch([
    { match: "page=1", reply: jsonResponse(envelope({ list: [song("s1")], hasMore: true })) },
    { match: "page=2", reply: jsonResponse({ message: "boom" }, 500) },
  ]);
  const brokenApi = apiOf({ fetchImpl: broken.fetchImpl, api: { pageSize: 1 } });
  const failed = await brokenApi.loadAllFavorites();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, MUSIC_ERROR_KINDS.httpError);
  const loader = brokenApi.createFavoritesLoader();
  await loader.loadNext();
  await loader.loadNext();
  assert.deepEqual(loader.snapshot().songs.map((item) => item.id), ["s1"], "失败不清空已加载内容");
  assert.equal(loader.snapshot().stopReason, "error");
});

test("会话头注入：默认不带任何凭据，注入的 headers 原样进请求", async () => {
  const plain = scriptedFetch([{ match: "api/favorites", reply: jsonResponse(envelope({ list: [], hasMore: false })) }]);
  await apiOf({ fetchImpl: plain.fetchImpl }).listFavoritesPage();
  assert.deepEqual(plain.calls[0].init.headers, { accept: "application/json" });

  const withSession = scriptedFetch([{ match: "api/favorites", reply: jsonResponse(envelope({ list: [], hasMore: false })) }]);
  const api = apiOf({ fetchImpl: withSession.fetchImpl, api: { sessionHeaders: () => ({ "x-hw-session": "SESSION-1" }) } });
  await api.listFavoritesPage();
  assert.equal(withSession.calls[0].init.headers["x-hw-session"], "SESSION-1");
  assert.equal(withSession.calls[0].init.headers.accept, "application/json");
});

test("参数清洗：空值/空白关键字/非有限数字被剔除，关键字去首尾空白", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    { match: "api/search", reply: jsonResponse(envelope({ list: [song("s1")], hasMore: false })) },
  ]);
  const api = apiOf({ fetchImpl });
  const result = await api.search("  周杰伦  ", { page: undefined, pageSize: Number.NaN, params: { extra: "", keep: "v" } });

  assert.equal(result.ok, true);
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get("keyword"), "周杰伦");
  assert.equal(query.has("pageSize"), false, "NaN 不许进查询串");
  assert.equal(query.get("extra"), null, "空串不许进查询串");
  assert.equal(query.get("keep"), "v");
  assert.equal(query.get("page"), "1", "缺页号补默认第 1 页");
});

test("请求参数名集中在可覆写表里（真实参数名待 R7 联调确认）", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    { match: "api/search", reply: jsonResponse(envelope({ list: [], hasMore: false })) },
  ]);
  const api = apiOf({ fetchImpl, api: { queryNames: { keyword: "q", page: "p", pageSize: "n" } } });
  await api.search("abc", { page: 2, pageSize: 20 });
  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get("q"), "abc");
  assert.equal(query.get("p"), "2");
  assert.equal(query.get("n"), "20");
});

test("歌单：列表解码与删除必须走 playlistDelete 端点（不得用收藏端点冒充成功）", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    { match: "api/playlist/list", reply: jsonResponse(envelope({ list: [{ id: "p1", name: "我喜欢的音乐" }] })) },
    { match: "api/playlist/delete", reply: jsonResponse(envelope({ code: "0", data: { deleted: true } })) },
  ]);
  const api = apiOf({ fetchImpl });

  const playlists = await api.listPlaylists();
  assert.equal(playlists.ok, true);
  assert.deepEqual(playlists.data.playlists, [{ id: "p1", name: "我喜欢的音乐" }]);

  const deleted = await api.deletePlaylist("p1");
  assert.equal(deleted.ok, true);
  assert.match(calls[1].url, /^https:\/\/example\.invalid\/api\/playlist\/delete\?/);
  assert.equal(new URL(calls[1].url).searchParams.get("id"), "p1", "删除必须带上报删的歌单 id");
  assert.equal(calls.some((call) => call.url.startsWith(ENDPOINTS.favorites)), false, "删歌单不得走收藏端点");

  const empty = await api.deletePlaylist("");
  assert.equal(empty.ok, false);
  assert.equal(empty.error.kind, MUSIC_ERROR_KINDS.missingParam);

  const withoutEndpoint = apiOf({ endpoints: { ...ENDPOINTS, playlistDelete: undefined } });
  const refused = await withoutEndpoint.deletePlaylist("p1");
  assert.equal(refused.ok, false);
  assert.equal(refused.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);
});

test("专辑/歌手/历史：各走自己的端点并带上 id 参数", async () => {
  const albumFetch = scriptedFetch([{ match: "api/album", reply: jsonResponse(envelope({ list: [song("a1")], name: "专辑" })) }]);
  const albumApi = apiOf({ fetchImpl: albumFetch.fetchImpl, api: { queryNames: { id: "albumId" } } });
  const album = await albumApi.getAlbum("AL-1");
  assert.equal(album.ok, true);
  assert.equal(new URL(albumFetch.calls[0].url).searchParams.get("albumId"), "AL-1", "参数名可覆写");
  assert.deepEqual(album.data.songs.map((item) => item.id), ["a1"]);

  const { calls, fetchImpl } = scriptedFetch([
    { match: "api/artist", reply: jsonResponse(envelope({ list: [song("b1")], name: "歌手" })) },
    { match: "api/history", reply: jsonResponse(envelope({ list: [song("h1")], hasMore: false })) },
  ]);
  const api = apiOf({ fetchImpl });

  const artist = await api.getArtist("AR-1");
  assert.equal(artist.ok, true);
  assert.equal(new URL(calls[0].url).searchParams.get("id"), "AR-1", "未覆写时用默认参数名");

  const history = await api.getHistory({ page: 3 });
  assert.equal(history.ok, true);
  assert.equal(new URL(calls[1].url).searchParams.get("page"), "3");
});

test("playback 语义：顶层 fileURL 才是音频；fileInfos 可能是 JSON 字符串", async () => {
  const payload = {
    fileURL: "https://cdn.dbankcdn.cn/music/a.mp3",
    fileInfos: '[{"format":"mp3","size":1024,"bitrate":320}]',
    format: "mp3",
    size: 1024,
    bitrate: 320,
    auditionTime: 0,
  };
  const { fetchImpl } = scriptedFetch([{ match: "api/playback", reply: jsonResponse(envelope(payload)) }]);
  const api = apiOf({ fetchImpl });

  const result = await api.getPlayback({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.url, "https://cdn.dbankcdn.cn/music/a.mp3");
  assert.deepEqual(result.data.fileInfos, [{ format: "mp3", size: 1024, bitrate: 320 }]);
  assert.equal(result.data.format, "mp3");
  assert.equal(result.data.auditionLikely, false);

  assert.deepEqual(parseFileInfos('[{"a":1}]'), { ok: true, value: [{ a: 1 }] });
  assert.deepEqual(parseFileInfos({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.equal(parseFileInfos("{oops").ok, false, "坏 JSON 不得抛");
  assert.equal(parseFileInfos(null).ok, false);
});

test("playback 陷阱：fileInfos 坏 JSON → 降级为 null 并记警告，不影响出音频地址", async () => {
  const { fetchImpl } = scriptedFetch([
    {
      match: "api/playback",
      reply: jsonResponse(envelope({ fileURL: "https://cdn.dbankcdn.cn/music/a.mp3", fileInfos: "{oops", auditionTime: 0 })),
    },
  ]);
  const result = await apiOf({ fetchImpl }).getPlayback({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.url, "https://cdn.dbankcdn.cn/music/a.mp3");
  assert.equal(result.data.fileInfos, null);
  assert.deepEqual(result.data.warnings, ["file_infos_unparsable"]);
});

test("playback 陷阱：auditionTime 不能单独判试听（需第二信号）；两者齐备才判试听", () => {
  assert.deepEqual(classifyAudition({ auditionTime: 30_000 }), { auditionLikely: false, signals: ["auditionTime"] });
  assert.deepEqual(classifyAudition({}), { auditionLikely: false, signals: [] });
  assert.deepEqual(classifyAudition({ isAudition: true }), { auditionLikely: false, signals: ["flag"] }, "只有标记没有时长同样不足以判定");
  assert.deepEqual(classifyAudition({ auditionTime: 30_000, isAudition: true }), { auditionLikely: true, signals: ["auditionTime", "flag"] });
  assert.deepEqual(classifyAudition({ auditionTime: "30000", audition: true }), { auditionLikely: true, signals: ["auditionTime", "flag"] });
  assert.deepEqual(
    classifyAudition({ auditionTime: 30_000, trialFlag: true }, { flagKeys: ["trialFlag"] }),
    { auditionLikely: true, signals: ["auditionTime", "flag"] },
  );
});

test("playback 拒绝：缺 fileURL、非白名单 CDN 域", async () => {
  const empty = scriptedFetch([{ match: "api/playback", reply: jsonResponse(envelope({ fileURL: "", auditionTime: 0 })) }]);
  const missing = await apiOf({ fetchImpl: empty.fetchImpl }).getPlayback({ trackId: "s1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, MUSIC_ERROR_KINDS.invalidResponse);

  const foreign = scriptedFetch([{ match: "api/playback", reply: jsonResponse(envelope({ fileURL: "https://evil.example.com/a.mp3" })) }]);
  const unsafe = await apiOf({ fetchImpl: foreign.fetchImpl }).getPlayback({ trackId: "s1" });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.kind, MUSIC_ERROR_KINDS.unsafeMediaUrl);
  assert.match(unsafe.error.message, /evil\.example\.com/);

  const whitelisted = scriptedFetch([{ match: "api/playback", reply: jsonResponse(envelope({ fileURL: "https://a.b.c.dbankcdn.cn/a.mp3" })) }]);
  assert.equal((await apiOf({ fetchImpl: whitelisted.fetchImpl }).getPlayback({ trackId: "s1" })).ok, true);
});

test("HTTP/网络失败：结构化错误，且绝不把响应体整段当消息回显", async () => {
  const http = scriptedFetch([{ match: "api/favorites", reply: jsonResponse({ message: "内部堆栈 SECRET-STACK" }, 502) }]);
  const httpResult = await apiOf({ fetchImpl: http.fetchImpl }).listFavoritesPage();
  assert.equal(httpResult.ok, false);
  assert.equal(httpResult.error.kind, MUSIC_ERROR_KINDS.httpError);
  assert.match(httpResult.error.message, /502/);
  assert.doesNotMatch(httpResult.error.message, /SECRET-STACK/);

  const network = scriptedFetch([{ match: "api/favorites", reply: new Error("getaddrinfo ENOTFOUND") }]);
  const networkResult = await apiOf({ fetchImpl: network.fetchImpl }).listFavoritesPage();
  assert.equal(networkResult.ok, false);
  assert.equal(networkResult.error.kind, MUSIC_ERROR_KINDS.networkError);
  assert.match(networkResult.error.message, /ENOTFOUND/);
});

test("music.mjs 不含任何真实端点字面量（端点只能来自注入）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../src/protocols/music.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /https?:\/\/[a-z0-9.-]*(huawei|dbankcdn|tingmall|kuke)\./i, "不得硬编码猜测端点");
  assert.doesNotMatch(source, /msc\.|music-api\.|api\.huawei/i);
});
