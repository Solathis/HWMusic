/**
 * 协议层 · 华为业务接口（src/protocols/music.mjs）。
 *
 * R32 换血后，本文件断言的是**参考实测的线上形状**：
 * - POST 用 JSON 体（不是查询串）、GET 用查询串；
 * - 分页是 `start`/`limit`（通道那边仍然是"页号"，换算在协议层）；
 * - 业务成功 = `result.resultCode === "000000"`；
 * - 线上字段（`contentID`/`contentName`…）**归一化**成内部形状（`id`/`name`…）；
 * - 收藏/歌单发现要音乐会话的 `snsUserID`；其余带凭据的调用要 `token`。
 *
 * 而且守住三条业务语义（旧仓踩过的坑）：
 * 收藏无直报总数、playback 顶层 fileURL 才是音频、auditionTime 不能单独判试听。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MUSIC_ENDPOINT_KEYS,
  MUSIC_ENDPOINT_PATHS,
  MUSIC_ERROR_KINDS,
  classifyAudition,
  createMusicApi,
  decodeEnvelope,
  extractList,
  inlineLyricsOf,
  lyricAddressOf,
  normalizePlaylist,
  normalizeTrack,
  parseFileInfos,
  parsePlaybackPayload,
  trackIdOf,
} from "../src/protocols/music.mjs";

/** 合成端点：不代表真实 URL（真实默认值见 src/main/music-service.mjs）。 */
const ENDPOINTS = {
  favorites: "https://example.invalid/api/favorites",
  playlistList: "https://example.invalid/api/library",
  playlistDetail: "https://example.invalid/api/playlist/detail",
  playlistDetailPublic: "https://example.invalid/api/playlist/public",
  playlistDelete: "https://example.invalid/api/playlist/delete",
  search: "https://example.invalid/api/search",
  album: "https://example.invalid/api/album",
  artist: "https://example.invalid/api/artist",
  history: "https://example.invalid/api/history",
  playback: "https://example.invalid/api/playback",
};

const SESSION = { token: "MUSIC-TOKEN", snsUserID: "SNS-1" };

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 业务成功信封（真实形状：`result.resultCode`，数据平铺在顶层）。 */
const okBody = (fields = {}) => ({ result: { resultCode: "000000" }, ...fields });

/** 线上歌曲条目（真实字段名）。 */
const wireSong = (id, extra = {}) => ({
  contentID: id,
  contentName: `歌${id}`,
  contentType: "1",
  artistName: "艺人",
  albumName: "专辑",
  duration: "180",
  ...extra,
});

/** 线上歌单条目。 */
const wirePlaylist = (id, contentType = "5", extra = {}) => ({
  contentID: id,
  contentName: `歌单${id}`,
  contentType,
  totalCount: "7",
  ...extra,
});

/** 注入 fetch：`handler(url, init, calls)` 返回 Response（或抛错即网络失败）。 */
function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body === undefined ? null : JSON.parse(init.body) });
    return handler(url, init, calls);
  };
  return { calls, fetchImpl };
}

/** 按"第 n 次调用"给响应（分页用例靠它）。 */
function sequenceFetch(replies) {
  return scriptedFetch((_url, _init, calls) => {
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error(`未脚本化的第 ${calls.length} 次请求`);
    if (reply instanceof Error) throw reply;
    return reply.clone();
  });
}

/**
 * 手动收发的注入 fetch（R45A3 fix3）：每次调用的响应先挂起，由用例决定**何时、以什么内容**回。
 *
 * 为什么非要有它：`scriptedFetch`/`sequenceFetch` 都是"调用即回"，复现不了"第一页的 HTTP 在途时
 * 会话换了 / 又开了一次第一页"这种竞态——而那正是复审点名的洞（迟到的旧响应写回缓存）。
 */
function deferredFetch() {
  const calls = [];
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve) => {
      calls.push({ url, init, body: init.body === undefined ? null : JSON.parse(init.body), resolve });
    });
  return { calls, fetchImpl };
}

/** 让在途的 `getPlaylistDetail` 真的把请求发出来（一轮宏任务足够）。 */
const flushFetch = () => new Promise((resolve) => setImmediate(resolve));

/** 一页回执里的歌曲 id 序列（"是不是同一份整页"的判据；顺序也算）。 */
const pageIdsOf = (page) => (page?.data?.songs ?? []).map((song) => song.id);

function apiOf(options = {}) {
  const fetchImpl = options.fetchImpl ?? (async () => jsonResponse(okBody({ favoriteInfos: [] })));
  return createMusicApi({
    endpoints: options.endpoints ?? ENDPOINTS,
    fetchImpl,
    session: "session" in options ? options.session : SESSION,
    ...options.api,
  });
}

test("端点清单：键是唯一真源，每个键都登记了路径与方法（歌词是「从播放响应推导」的例外）", () => {
  assert.deepEqual([...MUSIC_ENDPOINT_KEYS].sort(), [
    "album",
    "artist",
    "favorites",
    "history",
    "lyrics",
    "playback",
    "playlistDelete",
    "playlistDetail",
    "playlistDetailPublic",
    "playlistList",
    "search",
  ]);
  for (const key of MUSIC_ENDPOINT_KEYS) {
    if (key === "lyrics") {
      assert.equal(MUSIC_ENDPOINT_PATHS[key], null, "歌词没有独立端点（参考实现从播放响应里取）");
      continue;
    }
    assert.match(MUSIC_ENDPOINT_PATHS[key], /^\/[a-z0-9-]+\/v\d+\/service\//, `${key} 的路径形状`);
  }
});

test("端点注入：缺端点的方法返回结构化 endpoint_unknown（绝不猜 URL）", async () => {
  const api = apiOf({ endpoints: {} });
  const result = await api.readFavoritesPage({ page: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);
  assert.match(result.error.message, /favorites/);

  const bad = apiOf({ endpoints: { favorites: "http://example.invalid/api/favorites" } });
  const insecure = await bad.listFavoritesPage();
  assert.equal(insecure.ok, false);
  assert.equal(insecure.error.kind, MUSIC_ERROR_KINDS.endpointUnknown, "非 https 端点一律视为未确定");
});

test("端点显式关闭：报的是「被设置关闭」而不是「尚未确定」（两种状态不互相冒充）", async () => {
  const api = createMusicApi({
    endpoints: { ...ENDPOINTS, favorites: undefined },
    disabledEndpoints: ["favorites"],
    fetchImpl: async () => assert.fail("被关闭的端点不该发出请求"),
    session: SESSION,
  });
  const result = await api.readFavoritesPage({ page: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);
  assert.match(result.error.message, /显式关闭/);
});

test("响应解码：result.resultCode 为 000000 才算成功；非 000000 → api_error（不回显响应体）", () => {
  assert.deepEqual(decodeEnvelope({ result: { resultCode: "000000" }, favoriteInfos: [1] }), {
    ok: true,
    data: { result: { resultCode: "000000" }, favoriteInfos: [1] },
  });

  const failure = decodeEnvelope({ result: { resultCode: "990000", resultMessage: "System error!" } });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.kind, MUSIC_ERROR_KINDS.apiError);
  assert.match(failure.error.message, /990000/);
  assert.doesNotMatch(failure.error.message, /System error/, "服务端 resultMessage 可能回显请求内容，不进错误");

  // 没有 result 的两种老形态仍然宽容（手工注入的响应/网关包装）
  assert.deepEqual(decodeEnvelope({ code: "0", data: { list: [1] } }), { ok: true, data: { list: [1] } });
  assert.deepEqual(decodeEnvelope({ list: [1] }), { ok: true, data: { list: [1] } });
  assert.deepEqual(decodeEnvelope([1, 2]), { ok: true, data: [1, 2] });

  const notObject = decodeEnvelope("<html>502</html>");
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
});

test("列表提取与归一化：真实容器名（favoriteInfos/songSimpleInfos/contentSimpleInfos）优先", () => {
  assert.deepEqual(extractList({ favoriteInfos: [1] }), [1]);
  assert.deepEqual(extractList({ songSimpleInfos: [1] }), [1]);
  assert.deepEqual(extractList({ contentSimpleInfos: [1] }), [1]);
  assert.deepEqual(extractList({ list: [1] }), [1], "旧候选仍兼容（手工注入的响应）");
  assert.deepEqual(extractList([1, 2]), [1, 2]);
  assert.deepEqual(extractList({ nothing: true }), []);
  assert.deepEqual(extractList(null), []);

  assert.deepEqual(normalizeTrack(wireSong("s1")), {
    id: "s1",
    name: "歌s1",
    singer: "艺人",
    albumName: "专辑",
    duration: 180,
  });
  assert.equal(normalizeTrack({ contentName: "没有 id" }), null, "无 ID 一律丢弃（不编 id）");
  assert.equal(normalizeTrack(null), null);

  // artistNamePairs 优先，且按参考的口径用「、」连接（不按逗号切名字）
  assert.equal(
    normalizeTrack(wireSong("s2", { artistName: "被忽略", artistNamePairs: [{ artistName: "甲" }, { artistName: "乙" }] })).singer,
    "甲、乙",
  );
  // 封面只在 CDN 白名单内才认
  assert.equal(normalizeTrack(wireSong("s3", { picture: { bigImgURL: "https://img.dbankcdn.cn/a.jpg" } })).coverUrl, "https://img.dbankcdn.cn/a.jpg");
  assert.equal(normalizeTrack(wireSong("s4", { picture: { bigImgURL: "https://evil.example.com/a.jpg" } })).coverUrl, undefined);


  assert.deepEqual(normalizePlaylist(wirePlaylist("p1")), { id: "p1", name: "歌单p1", kind: "owned", contentType: "5", count: 7 });
  assert.equal(normalizePlaylist(wirePlaylist("p2", "4")).kind, "collected");
  assert.equal(normalizePlaylist(wirePlaylist("p3", "7")).kind, "chart");
  assert.equal(normalizePlaylist({ contentID: "x", contentType: "5" }), null, "没有名字的歌单不显示（不编「未命名」）");

  assert.equal(trackIdOf({ id: "1" }), "1");
  assert.equal(trackIdOf({ songId: 2 }), "2");
  assert.equal(trackIdOf({ name: "无 ID" }), null);
  assert.equal(trackIdOf(null), null);
});

const standardResource = (duration, extra = {}) => ({ quality: "1", format: "MP3", mediaFileType: "MP3", duration, ...extra });
const videoResources = {
  "15": { quality: "15", format: "MKV", mediaFileType: "MKV", duration: "204" },
  "17": { quality: "17", format: "MKV", mediaFileType: "MKV", duration: "204" },
};
const durationTrack = (extra) => normalizeTrack(wireSong("duration", { duration: undefined, ...extra }));

/**
 * 2026-10-23 只读取证的**线上资源形状**（已登录会话，歌单详情一页 1623 条；只记类型，不记曲名）。
 *
 * - 条目键：`albumID/albumName/artistID/artistName/category/contentExInfo/contentID/contentName/
 *   contentType/cpID/createTime/deviceType/extendInfo/keyName/picture/quality/status/subTitle/times`
 *   ——**没有顶层 `duration`，也没有 `songInfo`**；`quality` 是字符串（"0"/"1"/"2"/"3"）。
 * - `contentExInfo` 是 **JSON 字符串**；这一页里**没有 `completeFileInfos`**，时长只在
 *   `fileInfos[]`（数组）里，元素形如
 *   `{quality:"1", format:"MP3", fileType:"1", duration:"240", bitRate, fileSize, drm, sampleRate, streaming}`。
 * - `duration` 一律是**秒的数字串**；`fileType` 是数字档位（"1"/"17"），**不是编码名**；
 *   `mediaFileType` 这一页不存在。
 * - 同一首的各档（1/2/3/5/6/7、以及只有 "0" 档的老歌）`duration` **完全相同**（383/383 一致）；
 *   但**取哪一档是合同问题**（口径按 R45A2 fix1 用户裁定，见本文件后面的时长用例与
 *   `docs/API_CONTRACT.md` §2.3.1）：**显式且一致的 MP3 是硬条件**、档位必须显式声明，
 *   标准档 `quality="1"` 排第一顺位、其余显式档兜底——所以只有 "0" 档的老歌现在**也有**秒数，
 *   真正显示「—」的是那一批"没有任何一档显式声明 MP3"的条目（M4A/FLAC/空 `format`）。
 *   视频档是 MKV（15/17），永远排除。
 */
const realFileInfo = (quality, format, duration) => ({
  quality,
  format,
  fileType: "1",
  duration,
  bitRate: "128000",
  fileSize: "3600000",
  drm: "0",
  sampleRate: "44100",
  streaming: "1",
});

/** 真实条目 → 只关心 duration 的归一化。 */
const realEntry = (fileInfos, extra = {}) =>
  normalizeTrack({
    contentID: "s1",
    contentName: "歌",
    contentType: "1",
    artistName: "艺人",
    quality: "3",
    times: "32894214",
    contentExInfo: JSON.stringify({ fileInfos, quality: "3", explicit: "0" }),
    ...extra,
  });

test("列表时长：真实条目没有顶层 duration/songInfo，秒数只在 contentExInfo.fileInfos 的显式 MP3 里", () => {
  assert.equal(
    realEntry([realFileInfo("1", "MP3", "240"), realFileInfo("2", "MP3", "240"), realFileInfo("3", "FLAC", "240"), realFileInfo("7", "FLAC", "240")]).duration,
    240,
  );
  assert.equal(realEntry([realFileInfo("1", "MP3", "195")]).duration, 195);
  // R45A2 fix1（用户裁定）：**任意显式档位**的 MP3 都能给秒数（真机 167 条只有 quality "0" 的老歌属于这一档）
  assert.equal(realEntry([realFileInfo("0", "MP3", "202")]).duration, 202);
  // M4A / FLAC / 未声明编码：不是显式 MP3，不猜（真机 87 条 format 为空）
  assert.equal(realEntry([realFileInfo("3", "M4A", "203"), realFileInfo("7", "M4A", "203")]).duration, undefined);
  assert.equal(realEntry([realFileInfo("3", "FLAC", "203")]).duration, undefined);
  assert.equal(realEntry([{ quality: "1", format: "", duration: "203" }]).duration, undefined);
  // MKV 视频档（204 秒，比音频的 203 多一秒）永远不当时长；同一条目里的 MP3 档照旧可用
  assert.equal(realEntry([videoResources["15"], videoResources["17"]]).duration, undefined);
  assert.equal(realEntry([videoResources["15"], realFileInfo("1", "MP3", "203")]).duration, 203);
  assert.equal(realEntry([videoResources["17"], realFileInfo("0", "MP3", "203")]).duration, 203, "兜底档取的是 MP3 的 203，不是视频的 204");
});

test("列表时长：quality 数字 1 与字符串 \"1\" 等价；completeFileInfos 对象/数组与 fileInfos 都读", () => {
  const viaExtra = (contentExInfo) => durationTrack({ contentExInfo }).duration;
  const mp3 = (quality, duration = "203") => ({ quality, format: "MP3", mediaFileType: "MP3", duration });
  assert.equal(viaExtra({ completeFileInfos: { "1": mp3("1") } }), 203);
  assert.equal(viaExtra({ completeFileInfos: { "1": mp3(1) } }), 203, "数字 quality 也算标准档");
  assert.equal(viaExtra({ completeFileInfos: [mp3(1)] }), 203);
  assert.equal(viaExtra({ completeFileInfos: [mp3("1")] }), 203);
  assert.equal(viaExtra({ fileInfos: [mp3(1)] }), 203);
  assert.equal(viaExtra({ fileInfos: { anyKey: mp3("1") } }), 203);
  // completeFileInfos 的 key 就是音质档（对象形态）：资源自己没写 quality 时按 key 读
  assert.equal(viaExtra({ completeFileInfos: { "1": { format: "MP3", duration: "195" } } }), 195);
  assert.equal(viaExtra({ completeFileInfos: { "0": { format: "MP3", duration: "195" } } }), 195, "对象 key 是显式档位，非标准档也可兜底");
  // 只声明 mediaFileType（早期真机样本两个字段都有）也认
  assert.equal(viaExtra({ fileInfos: [{ quality: "1", mediaFileType: "mp3", duration: "240" }] }), 240);
  // 两个编码字段都存在时必须都读作 MP3（互相矛盾的资源不认）
  assert.equal(viaExtra({ fileInfos: [{ quality: "1", format: "MP3", mediaFileType: "FLAC", duration: "240" }] }), undefined);
  assert.equal(viaExtra({ fileInfos: [{ quality: "1", format: "MKV", duration: "240" }] }), undefined);
  // 档位缺失**不等于**某个档位：数组形态没有 key 可当档位，`qualityType` 不是 `quality`、不参与判档
  assert.equal(viaExtra({ completeFileInfos: [standardResource("203", { quality: undefined, qualityType: "1" })] }), undefined);
});

/**
 * R45A2 fix1（用户裁定，2026-10-23 记录在 progress.md）：**"所有歌曲时长"是原需求**，
 * 而只认标准档 `quality="1"` 会让真机约 167 条只有 `quality:"0"` 的老歌永远显示「—」。
 * 用户明确授权把选源放宽到"**任意明确声明 MP3 的音质档**"，仍然是秒数、仍然排除 M4A/FLAC/MKV/
 * 未声明编码/矛盾格式，`times` 仍然一个字节都不读。
 *
 * 两条纪律（放宽不等于乱猜）：
 * 1. **标准档仍是第一顺位**：它在的时候先用它（真机各档同值，这条只防"哪天不同值"）；
 * 2. **档位必须显式存在且形如华为的音质标识**（数字或数字串）：数组形态里没有 quality 的资源
 *    仍然不算——那是"没声明档位"，不是"某个未知档位"。
 */
test("列表时长（用户裁定）：任意显式档位 + 显式一致 MP3 都给秒数，标准档优先", () => {
  const viaFileInfos = (fileInfos) => durationTrack({ contentExInfo: JSON.stringify({ fileInfos }) }).duration;

  // ① 独立字面量夹具：只有标准档 / 只有兜底档（不共用 helper，免得"夹具跟着实现走"）
  assert.equal(
    durationTrack({ contentExInfo: JSON.stringify({ fileInfos: [{ quality: "1", format: "MP3", duration: "240" }] }) }).duration,
    240,
    "标准档 MP3 → 240",
  );
  assert.equal(
    durationTrack({ contentExInfo: JSON.stringify({ fileInfos: [{ quality: "0", format: "MP3", duration: "202" }] }) }).duration,
    202,
    "兜底档（quality 0）MP3 → 202（真机 167 条只有这一档）",
  );
  assert.equal(
    durationTrack({ contentExInfo: JSON.stringify({ fileInfos: [{ quality: "2", format: "MP3", duration: "241" }] }) }).duration,
    241,
    "兜底档 quality 2 → 241",
  );
  // 数字形态与字符串形态是同一档（华为真机给的是字符串，早期样本有数字）
  assert.equal(viaFileInfos([{ quality: 2, format: "MP3", duration: 241 }]), 241);
  // 未知但显式的数字档位：按"明确声明 MP3"收下（档位本身不是我们认识的那个，但编码是明确的）
  assert.equal(viaFileInfos([{ quality: "9", format: "MP3", duration: "201" }]), 201);

  // ② 标准档优先：两档都在且值不同 → 取标准档
  assert.equal(viaFileInfos([{ quality: "2", format: "MP3", duration: "241" }, { quality: "1", format: "MP3", duration: "240" }]), 240);
  assert.equal(viaFileInfos([{ quality: "1", format: "MP3", duration: "240" }, { quality: "2", format: "MP3", duration: "241" }]), 240);
  // 标准档在但坏了（编码不符 / 缺秒数 / 坏秒数）→ 兜底到其他显式 MP3 档（不再一票否决）
  assert.equal(viaFileInfos([{ quality: "1", format: "M4A", duration: "240" }, { quality: "0", format: "MP3", duration: "239" }]), 239);
  assert.equal(viaFileInfos([{ quality: "1", format: "", duration: "240" }, { quality: "0", format: "MP3", duration: "239" }]), 239);
  assert.equal(viaFileInfos([{ quality: "1", format: "MP3" }, { quality: "0", format: "MP3", duration: "239" }]), 239);
  assert.equal(viaFileInfos([{ quality: "1", format: "MP3", duration: "0" }, { quality: "0", format: "MP3", duration: "239" }]), 239);

  // ③ 档位缺失 / 不是音质标识形状 → 不猜（这不是"未知档位"，是"没声明"）
  assert.equal(viaFileInfos([{ format: "MP3", duration: "240" }]), undefined, "数组形态没有档位");
  for (const quality of [undefined, null, "", "  ", "best", true, false, {}, []]) {
    assert.equal(viaFileInfos([{ quality, format: "MP3", duration: "240" }]), undefined, `quality=${JSON.stringify(quality)} 不是音质标识`);
  }
  assert.equal(viaFileInfos([{ quality: "high", format: "MP3", duration: "240" }, { quality: "1", format: "MP3", duration: "238" }]), 238, "认不出的档位不挡标准档");

  // ④ 编码证据必须明确且一致（这些档位再明确也不收）
  assert.equal(viaFileInfos([{ quality: "0", format: "M4A", duration: "240" }]), undefined, "M4A");
  assert.equal(viaFileInfos([{ quality: "0", format: "FLAC", duration: "240" }]), undefined, "FLAC");
  assert.equal(viaFileInfos([{ quality: "15", format: "MKV", duration: "204" }]), undefined, "MKV 视频档");
  assert.equal(viaFileInfos([{ quality: "0", format: "", duration: "240" }]), undefined, "空 format = 没声明编码");
  assert.equal(viaFileInfos([{ quality: "0", duration: "240" }]), undefined, "缺 format");
  assert.equal(viaFileInfos([{ quality: "0", format: "MP3", mediaFileType: "M4A", duration: "240" }]), undefined, "两个编码字段矛盾");
  assert.equal(viaFileInfos([{ quality: "0", format: "MP3", mediaFileType: "", duration: "240" }]), 240, "空串不算第二个声明");

  // ⑤ 秒数边界与 times 的老规矩不变（放宽的是档位，不是单位）
  for (const duration of [0, "0", -1, "86400", 86400, "", "bad", null]) {
    assert.equal(viaFileInfos([{ quality: "0", format: "MP3", duration }]), undefined, `duration=${String(duration)} 不收`);
  }
  assert.equal(durationTrack({ times: "32894214" }).duration, undefined, "times 永远不当时长");
  assert.equal(durationTrack({ times: "32894214", contentExInfo: { fileInfos: [{ quality: "0", format: "MP3", duration: "202" }] } }).duration, 202);
});

test("R45A fix4：quality ID 只接受非负整数或纯数字字符串", () => {
  const viaQuality = (quality) =>
    durationTrack({ contentExInfo: { fileInfos: [{ quality, format: "MP3", duration: "240" }] } }).duration;

  for (const quality of [0, 1, 17, "0", "1", "17"]) {
    assert.equal(viaQuality(quality), 240, `quality=${String(quality)} 是有效非负整数 ID`);
  }
  for (const quality of [-1, 0.5, Infinity, -Infinity, NaN, "-1", "0.5", "1.0", "NaN", "Infinity", "1x", "", "  ", " 17 "]) {
    assert.equal(viaQuality(quality), undefined, `quality=${String(quality)} 不是有效 quality ID`);
  }
});

test("列表时长：可信顶层秒数优先；坏顶层允许回落显式 MP3，但 times 永远没有时长资格", () => {
  const contentExInfo = { fileInfos: [realFileInfo("1", "MP3", "240")] };
  assert.equal(durationTrack({ duration: "200.5", times: "32894214", contentExInfo }).duration, 200.5);
  for (const duration of [undefined, null, true, false, "", "bad", [], [200], {}, 0, -1, 86400, Infinity, NaN]) {
    assert.equal(durationTrack({ duration, contentExInfo }).duration, 240, String(duration));
  }
  for (const times of ["245", 245000, "32894214", "32894206", "1900445", "7604032", Number.MAX_VALUE, "0", -1, null]) {
    assert.equal(durationTrack({ times }).duration, undefined, `times=${times} 不能当时长`);
    assert.equal(durationTrack({ times, contentExInfo }).duration, 240, `times=${times} 不影响显式 MP3`);
  }
});

test("列表时长：无显式 MP3 的资源、坏 JSON/容器一律未知，不拿 MKV 204 秒替代", () => {
  const invalidExtras = [
    "{bad", "null", "[]", null, true, [],
    { completeFileInfos: videoResources },
    { completeFileInfos: { "1": { ...videoResources["15"] } } },
    { fileInfos: [{ quality: "1", duration: "203" }] },
    { fileInfos: [standardResource("203", { format: undefined, mediaFileType: undefined })] },
    { fileInfos: [standardResource("203", { format: "M4A", mediaFileType: "M4A" })] },
    { fileInfos: [standardResource("203", { format: "FLAC" })] },
    { quality: "1", duration: "240" },
  ];
  for (const contentExInfo of invalidExtras) {
    assert.equal(durationTrack({ contentExInfo }).duration, undefined, JSON.stringify(contentExInfo));
  }
});

test("列表时长：秒数严格为有限正数字/数字串且小于 24h；坏档位退到别的显式 MP3 档", () => {
  for (const duration of [0, "0", -1, "-1", 86400, "86400", 86401, Infinity, NaN, null, true, false, "", " ", "bad", [], [203], {}]) {
    assert.equal(durationTrack({ duration }).duration, undefined, String(duration));
    assert.equal(durationTrack({ contentExInfo: { fileInfos: [realFileInfo("1", "MP3", duration)] } }).duration, undefined, String(duration));
    // R45A2 fix1：坏的标准档退到别的显式 MP3 档（放宽的是档位，不是秒数）
    assert.equal(
      durationTrack({ contentExInfo: { fileInfos: [realFileInfo("1", "MP3", duration), realFileInfo("2", "MP3", "195")] } }).duration,
      195,
      `${String(duration)}：标准档秒数坏了 → 取 quality 2 的 MP3`,
    );
    assert.equal(
      durationTrack({ contentExInfo: { fileInfos: [realFileInfo("1", "MP3", duration), realFileInfo("2", "MP3", duration)] } }).duration,
      undefined,
      `${String(duration)}：每一档的秒数都坏 → 真的没有时长`,
    );
  }
  for (const duration of [0.1, "0.1", 86399.5, "86399.5"]) {
    assert.equal(durationTrack({ duration }).duration, Number(duration));
    assert.equal(durationTrack({ contentExInfo: { fileInfos: [realFileInfo("1", "MP3", duration)] } }).duration, Number(duration));
  }
});

/**
 * 复审 R45A2 与 **R45A2 fix1（用户裁定）** 的关系（读这两组时必须一起看）：
 *
 * - 上一版（复审）把口径收回到合同原文"只认显式标准档 `quality="1"` 的 MP3"，因为选源代码
 *   不该单方面放宽合同；那是对的**程序**，代价是真机约 167 条只有 `quality:"0"` 的老歌
 *   继续显示「—」。
 * - 本版（fix1）用户已经明确授权放宽到"任意**明确声明 MP3** 的音质档"（记录在 progress.md）。
 *   所以下面这一组从"非标准档一律不取"改成"非标准档可以取，但必须有显式档位 + 显式一致 MP3"。
 * - 仍然**不可**妥协的部分：M4A/FLAC/MKV/缺 format/矛盾 format 一律不取；`times` 永不读；
 *   秒数有限正数 < 24h；栏位缺失（没有 quality）不猜。
 */
test("复审 R45A2 + fix1：标准档优先，非标准档只作为显式 MP3 的兜底", () => {
  const viaExtra = (contentExInfo) => durationTrack({ contentExInfo }).duration;
  const viaFileInfos = (fileInfos) => viaExtra({ fileInfos });

  // ① 标准档（字符串 "1" / 数字 1）+ 显式 MP3 → 秒
  assert.equal(viaFileInfos([realFileInfo("1", "MP3", "240")]), 240);
  assert.equal(viaFileInfos([{ quality: 1, format: "MP3", duration: 195 }]), 195, "数字 quality 与字符串 \"1\" 同档");

  // ② 非标准档的显式 MP3：现在**收**（用户裁定），并且标准档在时仍然先取标准档
  for (const quality of ["0", 0, "2", 2, "3", "5", "6", "7"]) {
    assert.equal(
      viaFileInfos([{ quality, format: "MP3", duration: "240" }]),
      240,
      `quality=${String(quality)} 的显式 MP3 可以兜底（fix1 用户裁定）`,
    );
    assert.equal(
      viaFileInfos([{ quality, format: "MP3", duration: "240" }, { quality: "1", format: "MP3", duration: "239" }]),
      239,
      `quality=${String(quality)} 在标准档面前让位`,
    );
  }
  // ③ 编码证据不符 / 缺失 / 矛盾的档位：档位再明确也不收
  assert.equal(viaFileInfos([{ quality: "0", format: "M4A", duration: "240" }]), undefined);
  assert.equal(viaFileInfos([{ quality: "0", format: "FLAC", duration: "240" }]), undefined);
  assert.equal(viaFileInfos([{ quality: "0", format: "", duration: "240" }]), undefined);
  assert.equal(viaFileInfos([{ quality: "0", format: "MP3", mediaFileType: "FLAC", duration: "240" }]), undefined);
  // ④ 档位缺失不猜：数组形态没有 key 可当档位
  assert.equal(viaFileInfos([{ format: "MP3", mediaFileType: "MP3", duration: "240" }]), undefined);

  // ⑤ 标准档编码不符、兜底档正常 → 取兜底档（这是 fix1 与复审版的唯一行为差异）
  assert.equal(viaFileInfos([{ quality: "1", format: "M4A", duration: "240" }, { quality: "0", format: "MP3", duration: "202" }]), 202);
  // ⑥ 但"兜底档也不合格"时仍然没有时长（不退成任何编码）
  assert.equal(viaFileInfos([{ quality: "1", format: "FLAC", duration: "240" }, { quality: "3", format: "M4A", duration: "240" }]), undefined);
});

/**
 * 复审 R45A2（Important）：合同 §2.3.1 与 KNOWN_LIMITATIONS A5 曾只认**显式标准档 `quality="1"` 的
 * MP3**。上一版把"任意档的显式 MP3"都收下，等于拿非标准音质的资源冒充标准档的证据；
 * 复审把口径钉回合同是对的**程序**。
 *
 * **R45A2 fix1（用户裁定）**：用户已明确授权放宽到"任意**明确声明 MP3** 的音质档"
 * （记录在 progress.md），理由是原需求就是"所有歌曲都要有播放时长"，而真机约 167 条
 * 只有 `quality:"0"` 的老歌在旧口径下永远显示「—」。所以本组断言编码的是**新口径**：
 * 放宽档位、不放宽编码证据（M4A/FLAC/MKV/缺 format/矛盾 format 仍然一个都不收）。
 */
test("复审 R45A2 + fix1（用户裁定）：显式 MP3 的任意档位都算，标准档仍排第一", () => {
  const viaFileInfos = (fileInfos) => durationTrack({ contentExInfo: JSON.stringify({ fileInfos }) }).duration;

  // ① 标准档优先（值不同也取标准档）
  assert.equal(viaFileInfos([{ quality: "1", format: "MP3", duration: "240" }, { quality: "0", format: "MP3", duration: "202" }]), 240);
  // ② 只有兜底档时取兜底档
  assert.equal(viaFileInfos([{ quality: "0", format: "MP3", duration: "202" }]), 202);
  assert.equal(viaFileInfos([{ quality: "7", format: "MP3", duration: "199" }]), 199);
  // ③ 完全没有任何显式 MP3 → 没有时长（不猜单位、不猜编码）
  assert.equal(viaFileInfos([{ quality: "0", format: "M4A", duration: "202" }]), undefined);
  assert.equal(viaFileInfos([{ quality: "7", format: "MKV", duration: "204" }]), undefined);

  // ④ 两个容器各有一份时可以互补（不是"降级"）
  assert.equal(
    durationTrack({ contentExInfo: { completeFileInfos: { "0": { format: "MP3", duration: "bad" } }, fileInfos: [{ quality: "0", format: "MP3", duration: "202" }] } }).duration,
    202,
  );
  // 对象形态的 key 就是档位：key 下的资源没写 quality 也按 key 判档
  assert.equal(durationTrack({ contentExInfo: { completeFileInfos: { "1": { format: "MP3", duration: "195" } } } }).duration, 195);
  assert.equal(durationTrack({ contentExInfo: { completeFileInfos: { "0": { format: "MP3", duration: "195" } } } }).duration, 195);
});

test("列表时长：收藏/歌单/搜索/专辑/歌手/历史共用归一化且不逐曲请求", async () => {
  const entries = ["240", "195", "202"].map((duration, index) =>
    wireSong(`s${index}`, {
      duration: undefined,
      times: ["32894214", "1900445", "7604032"][index],
      contentExInfo: JSON.stringify({
        fileInfos: [realFileInfo("1", "MP3", duration), realFileInfo("3", "FLAC", duration), realFileInfo("7", "FLAC", duration)],
      }),
    }),
  );
  const cases = [
    { body: { favoriteInfos: entries }, load: (api) => api.readFavoritesPage({ page: 1 }) },
    { body: { playListInfoEx: { playListSongInfoList: entries } }, load: (api) => api.getPlaylistDetail("p1", { kind: "owned" }) },
    { body: { musicListInfoEx: { songSimpleInfos: entries } }, load: (api) => api.getPlaylistDetail("p1", { kind: "collected" }) },
    { body: { songSimpleInfos: entries }, load: (api) => api.search("时长") },
    { body: { albumInfoEx: { songSimpleInfos: entries } }, load: (api) => api.getAlbum("a1") },
    { body: { artistInfoEx: { songSimpleInfos: entries } }, load: (api) => api.getArtist("ar1") },
    { body: { contentSimpleInfos: entries }, load: (api) => api.getHistory() },
  ];
  for (const { body, load } of cases) {
    const { calls, fetchImpl } = scriptedFetch(() => jsonResponse(okBody(body)));
    const result = await load(apiOf({ fetchImpl }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.songs.map((song) => song.duration), [240, 195, 202]);
    assert.equal(calls.length, 1, "元数据只来自该页响应，没有逐曲补请求");
  }
});

test("收藏一页：POST JSON 体带 targetSnsUserID/start/limit/contentTypes；page 换算成 start", async () => {
  const { calls, fetchImpl } = scriptedFetch(() =>
    jsonResponse(okBody({ favoriteInfos: [wireSong("s1"), wireSong("s2")], totalCount: 9999 })),
  );
  const api = apiOf({ fetchImpl });

  const page = await api.readFavoritesPage({ page: 3, pageSize: 2 });
  assert.equal(page.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST", "收藏是 POST");
  assert.equal(new URL(calls[0].url).search, "", "参数进 JSON 体，不拼查询串");
  assert.deepEqual(calls[0].body, {
    targetSnsUserID: "SNS-1",
    start: 4,
    limit: 2,
    contentTypes: ["1"],
  });
  assert.deepEqual(page.data.songs.map((item) => item.id), ["s1", "s2"]);
  assert.equal(page.data.reportedTotal, 9999, "接口上报的 total 只作记录");
  assert.equal("total" in page.data, false, "协议层不替渲染层给总数：总数只能来自完整分页后的 ID 去重");
  assert.equal(page.data.hasMore, true, "整页返回 → 可能还有下一页（真接口不发 hasMore）");
});

test("收藏一页：没有音乐会话 → session_required（不拿匿名请求冒充「你的收藏是空的」）", async () => {
  const api = apiOf({ session: null, fetchImpl: async () => assert.fail("没有会话就不该发请求") });
  const result = await api.readFavoritesPage({ page: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_ERROR_KINDS.sessionRequired);
});

test("收藏分页：总数 = 完整分页后 ID 去重；与已加载数分开", async () => {
  const { fetchImpl } = sequenceFetch([
    jsonResponse(okBody({ favoriteInfos: [wireSong("s1"), wireSong("s2")] })),
    jsonResponse(okBody({ favoriteInfos: [wireSong("s2"), wireSong("s3")] })),
    // 第三页：整页返回 = "可能还有下一页"，所以还要再问一次（这一页空 → 到底）
    jsonResponse(okBody({ favoriteInfos: [] })),
  ]);
  const api = apiOf({ fetchImpl, api: { pageSize: 2 } });

  const result = await api.loadAllFavorites();
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.songs.map((item) => item.id), ["s1", "s2", "s3"], "去重且保持首次出现顺序");
  assert.equal(result.data.loadedCount, 3);
  assert.equal(result.data.total, 3, "总数只能来自完整分页后的去重结果");
  assert.equal(result.data.isComplete, true);
  assert.equal(result.data.stopReason, "exhausted");
  assert.equal(result.data.pages, 3);
});

test("收藏分页：渐进加载时 total 未知（null），完成那一刻才有值；无 ID 条目被丢弃并计数", async () => {
  const { fetchImpl } = sequenceFetch([
    jsonResponse(okBody({ favoriteInfos: [wireSong("s1"), { contentName: "没有 id" }] })),
    jsonResponse(okBody({ favoriteInfos: [wireSong("s2")] })),
  ]);
  const api = apiOf({ fetchImpl, api: { pageSize: 2 } });
  const loader = api.createFavoritesLoader();

  const first = await loader.loadNext();
  assert.equal(first.data.loadedCount, 1);
  assert.equal(first.data.total, null, "没走完分页就不许报总数");
  assert.equal(loader.snapshot().skipped, 1, "无 ID 的条目如实计数");

  const second = await loader.loadNext();
  assert.equal(second.data.total, 2, "走完之后的总数 = 去重后的歌曲数（无 ID 的那条不算）");
  assert.equal(second.data.stopReason, "exhausted");
  assert.equal(second.data.isComplete, true);
});

test("收藏分页：中途失败保留已加载内容并如实报错；页数上限如实标记未走完", async () => {
  const broken = sequenceFetch([
    jsonResponse(okBody({ favoriteInfos: [wireSong("s1")] })),
    jsonResponse({ message: "boom" }, 500),
  ]);
  const api = apiOf({ fetchImpl: broken.fetchImpl, api: { pageSize: 1 } });
  const loader = api.createFavoritesLoader();
  await loader.loadNext();
  const failed = await loader.loadNext();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, MUSIC_ERROR_KINDS.httpError);
  assert.deepEqual(loader.snapshot().songs.map((item) => item.id), ["s1"], "失败不清空已加载内容");
  assert.equal(loader.snapshot().stopReason, "error");
  assert.equal(loader.snapshot().total, null);

  const endless = apiOf({
    fetchImpl: (() => {
      let page = 0;
      return async () => {
        page += 1;
        return jsonResponse(okBody({ favoriteInfos: [wireSong(`s${page}`)] }));
      };
    })(),
    api: { pageSize: 1, maxPages: 3 },
  });
  const capped = await endless.loadAllFavorites();
  assert.equal(capped.data.pages, 3);
  assert.equal(capped.data.isComplete, false, "触到上限就是没走完，不许假装完整");
  assert.equal(capped.data.stopReason, "max_pages");
  assert.equal(capped.data.total, null);
});

test("歌单列表：翻页扫完整列表，跳过歌曲条目、按 contentType:id 去重（不把「首页全是歌」当成「没有歌单」）", async () => {
  const { calls, fetchImpl } = scriptedFetch((_url, _init, all) => {
    if (all.length === 1) {
      // 首页整页都是新歌：**不算"没有进展"**，必须继续翻（这正是 R32 前会显示"还没有歌单"的坑）
      return jsonResponse(okBody({ favoriteInfos: [wireSong("s1"), wireSong("s2")] }));
    }
    return jsonResponse(okBody({ favoriteInfos: [wirePlaylist("p1", "5"), wirePlaylist("p2", "4")] }));
  });
  const api = apiOf({ fetchImpl, api: { discoveryLimit: 2 } });

  const result = await api.listPlaylists({ page: 1 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, "第 3 页全是重复条目 → 没有进展 → 停（truncated=false）");
  assert.deepEqual(calls[0].body, {
    targetSnsUserID: "SNS-1",
    start: 0,
    limit: 2,
    contentTypes: ["1", "4", "5", "7"],
  });
  assert.equal(calls[1].body.start, 2);
  assert.deepEqual(result.data.playlists.map((item) => item.id), ["p1", "p2"], "重复的条目只出现一次");
  assert.deepEqual(result.data.playlists.map((item) => item.kind), ["owned", "collected"]);
  assert.equal(result.data.hasMore, false, "没有进展而停 → 扫完了");
});

test("歌单列表：短页即到底（一次就停）", async () => {
  const { calls, fetchImpl } = scriptedFetch(() =>
    jsonResponse(okBody({ favoriteInfos: [wirePlaylist("p1", "5")] })),
  );
  const api = apiOf({ fetchImpl, api: { discoveryLimit: 2 } });
  const result = await api.listPlaylists({ page: 1 });
  assert.equal(calls.length, 1);
  assert.equal(result.data.hasMore, false);
  assert.deepEqual(result.data.playlists.map((item) => item.id), ["p1"]);
});

test("歌单列表：翻到上限仍未到底 → hasMore=true（如实说「没扫完」）", async () => {
  const { fetchImpl, calls } = scriptedFetch((_url, _init, all) =>
    jsonResponse(
      okBody({
        favoriteInfos: Array.from({ length: 2 }, (_value, index) => wirePlaylist(`p${all.length}-${index}`, "5")),
      }),
    ),
  );
  const api = apiOf({ fetchImpl, api: { discoveryLimit: 2, discoveryPageCap: 3 } });
  const result = await api.listPlaylists({ page: 1 });
  assert.equal(calls.length, 3);
  assert.equal(result.data.hasMore, true);
  assert.equal(result.data.playlists.length, 6);
});

test("歌单列表：端点没配先报端点（顺序是从外到里），再报没登录", async () => {
  const noEndpoint = apiOf({ endpoints: {}, session: null });
  const refused = await noEndpoint.listPlaylists({ page: 1 });
  assert.equal(refused.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);

  const noSession = apiOf({ session: null, fetchImpl: async () => assert.fail("没有会话就不该发请求") });
  const needsLogin = await noSession.listPlaylists({ page: 1 });
  assert.equal(needsLogin.error.kind, MUSIC_ERROR_KINDS.sessionRequired);
});

test("歌单曲目：自建走 GET playlist/detail/all（playListID/start/limit），拿不到再试公开那条", async () => {
  const ownedOnly = scriptedFetch(() =>
    jsonResponse(
      okBody({
        playListInfoEx: {
          playListInfo: { contentID: "P-9", contentName: "我的歌单", totalCount: "2" },
          playListSongInfoList: [wireSong("t1"), wireSong("t2")],
        },
      }),
    ),
  );
  const owned = await apiOf({ fetchImpl: ownedOnly.fetchImpl }).getPlaylistDetail("P-9", { page: 1, pageSize: 20 });
  assert.equal(owned.ok, true);
  assert.equal(ownedOnly.calls[0].init.method, "GET", "自建歌单详情是 GET");
  const query = new URL(ownedOnly.calls[0].url).searchParams;
  assert.equal(query.get("playListID"), "P-9");
  assert.equal(query.get("start"), "0");
  assert.equal(query.get("limit"), "20");
  assert.deepEqual(owned.data.songs.map((item) => item.id), ["t1", "t2"]);
  assert.deepEqual(owned.data.playlist, { id: "P-9", name: "我的歌单", kind: "owned", contentType: "5", count: 2 });
  assert.equal(owned.data.hasMore, false);

  // 收藏歌单（type=4）：自建那条路回了个"没有 playListInfoEx"的空壳 → 自动改走公开那条
  const fallback = scriptedFetch((url) => {
    if (url.includes("/playlist/detail")) return jsonResponse(okBody({ result: { resultCode: "000000" } }));
    return jsonResponse(
      okBody({
        musicListInfoEx: {
          musicListDetail: { contentID: "L-1", contentName: "收藏的歌单", contentType: "4" },
          songSimpleInfos: [wireSong("c1")],
        },
      }),
    );
  });
  const collected = await apiOf({ fetchImpl: fallback.fetchImpl }).getPlaylistDetail("L-1", { page: 1, pageSize: 20 });
  assert.equal(collected.ok, true);
  assert.equal(fallback.calls.length, 2, "先自建、再公开");
  assert.equal(fallback.calls[1].init.method, "POST");
  assert.deepEqual(fallback.calls[1].body, { musicListID: "L-1", copyrightSwitch: "1", start: 0, limit: "20" });
  assert.deepEqual(collected.data.playlist, { id: "L-1", name: "收藏的歌单", kind: "collected", contentType: "4" });
  assert.deepEqual(collected.data.songs.map((item) => item.id), ["c1"]);

  // kind 显式给了就只走那一条
  const explicit = scriptedFetch(() => jsonResponse(okBody({})));
  await apiOf({ fetchImpl: explicit.fetchImpl }).getPlaylistDetail("L-1", { kind: "collected", pageSize: 20 });
  assert.equal(explicit.calls.length, 1);
  assert.match(explicit.calls[0].url, /playlist\/public/);

  const missingId = await apiOf({}).getPlaylistDetail("   ");
  assert.equal(missingId.ok, false);
  assert.equal(missingId.error.kind, MUSIC_ERROR_KINDS.missingParam);

  const noEndpoint = apiOf({ endpoints: { ...ENDPOINTS, playlistDetail: undefined, playlistDetailPublic: undefined } });
  const refused = await noEndpoint.getPlaylistDetail("P-9");
  assert.equal(refused.ok, false);
  assert.equal(refused.error.kind, MUSIC_ERROR_KINDS.endpointUnknown);
});

/**
 * R45A3 fix1（复审 Important）：歌单详情是**整表响应**端点——2026-10-23 真机一页
 * `pageSize=50` 拿回 **1623 条**，而旧实现把这 1623 条整份交给渲染层、`hasMore` 说是"还有"，
 * 于是"触底加载"变成一次全量渲染 + 一个永远为真的 hasMore。浏览器夹具当时还自己按页切片，
 * 把这条路径整个遮住了。
 *
 * 复审后的契约（协议层唯一真源）：
 * - **整份只取一次网络**：第一页的响应（无论服务端给了多少）进**实例内存缓存**（键 = 端点 kind + 歌单 id，
 *   不落盘、不进设置、不进日志）；
 * - 后续页是**本地切片** `[(page-1)*pageSize, page*pageSize)`，重复读同一页不再发请求；
 * - `hasMore` 由缓存里的剩余条数决定（`end < total`），`pageSource` 如实说是本地切片还是服务端分页；
 * - **第一页的歌单元信息**在后续页保留（它不是"这一页"的属性，是整张歌单的身份）。
 */
test("歌单详情（整表响应）：整份只取一次网络，page/pageSize 本地切片 50/50/20", async () => {
  const items = Array.from({ length: 120 }, (_value, index) =>
    wireSong(`t${index + 1}`, { contentExInfo: JSON.stringify({ fileInfos: [{ quality: "1", format: "MP3", duration: "180" }] }) }),
  );
  const fullBody = () =>
    okBody({
      playListInfoEx: {
        playListInfo: { contentID: "P-1", contentName: "整表歌单", totalCount: "120" },
        playListSongInfoList: items,
      },
    });
  // 假上游**忽略 start/limit**：每次都回整张 120 首（真接口的实测行为）
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse(fullBody()));
  const api = apiOf({ fetchImpl });

  const page1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 50 });
  assert.equal(page1.ok, true);
  assert.deepEqual(page1.data.songs.map((song) => song.id), items.slice(0, 50).map((song) => song.contentID));
  assert.equal(page1.data.hasMore, true, "后面还有 70 首");
  assert.equal(page1.data.pageSource, "local-slice", "这一页已经是整份响应里的切片");
  assert.equal(page1.data.available, 120, "整份响应有 120 首（这个数字来自缓存，不是猜的）");
  assert.deepEqual(page1.data.playlist, { id: "P-1", name: "整表歌单", kind: "owned", contentType: "5", count: 120 });
  assert.equal(calls.length, 1, "第一页只发一次网络");

  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 50 });
  assert.deepEqual(page2.data.songs.map((song) => song.id), items.slice(50, 100).map((song) => song.contentID));
  assert.equal(page2.data.hasMore, true, "还剩 20 首");
  assert.equal(page2.data.pageSource, "local-slice");
  assert.deepEqual(page2.data.playlist, page1.data.playlist, "第一页的歌单元信息在后续页保留");
  assert.equal(calls.length, 1, "第 2 页是本地切片：**没有再发请求**");

  const page3 = await api.getPlaylistDetail("P-1", { page: 3, pageSize: 50 });
  assert.deepEqual(page3.data.songs.map((song) => song.id), items.slice(100, 120).map((song) => song.contentID));
  assert.equal(page3.data.songs.length, 20);
  assert.equal(page3.data.hasMore, false, "end(150) 已经越过后端总条数(120) → 没有更多");
  assert.equal(calls.length, 1, "整份 120 首只取了一次网络");

  // 三页之间没有重复、合起来就是整张歌单
  const seen = new Set([...page1.data.songs, ...page2.data.songs, ...page3.data.songs].map((song) => song.id));
  assert.equal(seen.size, 120, "三页 50/50/20 无重复且覆盖全部");

  // 重复读同一页：同一份切片，仍然不发请求
  const again = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 50 });
  assert.deepEqual(again.data.songs.map((song) => song.id), page2.data.songs.map((song) => song.id));
  assert.equal(calls.length, 1, "同一页再读一次也只可能是同一份缓存");

  // 走过头的一页：空切片 + 没有更多（不是"再问一次后端"）
  const beyond = await api.getPlaylistDetail("P-1", { page: 9, pageSize: 50 });
  assert.deepEqual(beyond.data.songs, []);
  assert.equal(beyond.data.hasMore, false);
  assert.equal(calls.length, 1);

  // 全新的一页 1 请求会**替换**缓存（服务端内容可能变了）：这是唯一会重建缓存的一档
  const shrunk = scriptedFetch(() => jsonResponse(okBody({
    playListInfoEx: {
      playListInfo: { contentID: "P-1", contentName: "整表歌单", totalCount: "60" },
      playListSongInfoList: items.slice(0, 60),
    },
  })));
  const refreshed = apiOf({ fetchImpl: shrunk.fetchImpl });
  const fresh = await refreshed.getPlaylistDetail("P-1", { page: 1, pageSize: 50 });
  assert.equal(fresh.data.available, 60);
  const freshPage2 = await refreshed.getPlaylistDetail("P-1", { page: 2, pageSize: 50 });
  assert.equal(freshPage2.data.songs.length, 10, "第二页跟着新缓存走（不是旧的 120 首）");
  assert.equal(freshPage2.data.hasMore, false);
  assert.equal(shrunk.calls.length, 1, "两页仍然只发了一次网络");
});

test("歌单详情：缓存键含端点 kind 与歌单 id（互不串味），且**不跨实例**", async () => {
  const owned = [];
  const collected = [];
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/playlist/detail")) {
      return jsonResponse(okBody({
        playListInfoEx: {
          playListInfo: { contentID: "P-1", contentName: "自建", totalCount: "0" },
          playListSongInfoList: owned,
        },
      }));
    }
    return jsonResponse(okBody({
      musicListInfoEx: {
        musicListDetail: { contentID: "P-1", contentName: "收藏", contentType: "4" },
        songSimpleInfos: collected,
      },
    }));
  });
  const api = apiOf({ fetchImpl });

  // 同一份歌单 id、两条端点：第一页永远各问各的（缓存键里含 kind，两边的曲目不会串）
  owned.push(...Array.from({ length: 3 }, (_value, index) => wireSong(`owned-${index}`)));
  collected.push(...Array.from({ length: 4 }, (_value, index) => wireSong(`collected-${index}`)));
  const ownedPage = await api.getPlaylistDetail("P-1", { kind: "owned", page: 1, pageSize: 2 });
  const collectedPage = await api.getPlaylistDetail("P-1", { kind: "collected", page: 1, pageSize: 2 });
  assert.equal(ownedPage.data.available, 3);
  // R45A3 fix2：这张歌单的缓存条目**只留最近一次解析**（上一次第一页那份 owned 随之失效），
  // 但两条端点的第一页本身仍是各自去问（次数见 fixed-order 那一组用例）
  assert.equal(collectedPage.data.available, 4, "两条端点各问各的，第一页不走缓存");

  // 换一个歌单 id：不复用别的歌单的缓存
  const other = scriptedFetch(() => jsonResponse(okBody({
    playListInfoEx: {
      playListInfo: { contentID: "P-2", contentName: "另一张", totalCount: "5" },
      playListSongInfoList: Array.from({ length: 5 }, (_value, index) => wireSong(`other-${index}`)),
    },
  })));
  const otherApi = apiOf({ fetchImpl: other.fetchImpl });
  const otherPage = await otherApi.getPlaylistDetail("P-2", { kind: "owned", page: 1, pageSize: 2 });
  assert.equal(otherPage.data.available, 5);
  assert.equal(other.calls.length, 1);
  // 新实例没有旧实例的缓存：它必须自己去取（缓存是实例私有的，不是全局/磁盘的）
  const second = apiOf({ fetchImpl: scriptedFetch(() => jsonResponse(okBody({
    playListInfoEx: { playListInfo: { contentID: "P-1", contentName: "自建" }, playListSongInfoList: [wireSong("fresh-1")] },
  }))).fetchImpl });
  const secondPage2 = await second.getPlaylistDetail("P-1", { kind: "owned", page: 2, pageSize: 2 });
  assert.equal(secondPage2.data.available, 1, "另一个实例的第 2 页自己取了那一份响应那（没有沾到上面那张 3 首的缓存）");
});

/**
 * R45A3 fix2（复审 Important）：**整表缓存不许跨解析路径 / 跨会话残留**。
 *
 * 这一档为什么危险：`kind='auto'` 是"先自建（owned）、再公开（collected）"，而同一份
 * `playlistId` 在两条端点上的曲目**可以完全不同**。旧实现的第一页只失效"这一轮解析到的
 * 那个 kind"的条目，于是：
 * - 第一轮 owned 回整份（进了缓存）→ 路由/会话变了，第一页这次由 collected 解析 →
 *   缓存里 owned 那份**还在** → 第 2 页按固定顺序 `["owned","collected"]` 一撞就撞到
 *   上一轮的 owned 列表：同一张歌单的页 1 与页 2 来自两条不同路由。
 * - 换账号/换 token 之后同理：上一轮那份是**别人的**歌单内容。
 *
 * 契约（本轮修法，行为级验证——调真的 `createMusicApi`，不是扫源码）：
 * 1. 第一页（不论解析到哪条 kind、也不论形状）先把这张歌单**所有** kind 的条目一起失效；
 * 2. 后续页只认"这张歌单最近一次解析到的那条 kind"，两条都在时也不按固定顺序撞运气；
 * 3. 会话身份（`token`/`snsUserID`）变了 → 整张缓存先清掉再查。
 */

/** 一张歌单的"整份响应"（服务端忽略 start/limit：一次给全）。 */
const wholePlaylistBody = (fakeId, tag, count) =>
  okBody({
    playListInfoEx: {
      playListInfo: { contentID: fakeId, contentName: `歌单${tag}`, totalCount: String(count) },
      playListSongInfoList: Array.from({ length: count }, (_value, index) => wireSong(`${tag}-${index + 1}`)),
    },
  });

const wholeCollectedBody = (fakeId, tag, count) =>
  okBody({
    musicListInfoEx: {
      musicListDetail: { contentID: fakeId, contentName: `歌单${tag}`, contentType: "4" },
      songSimpleInfos: Array.from({ length: count }, (_value, index) => wireSong(`${tag}-${index + 1}`)),
    },
  });

test("R45A3 fix2：解析路径从 owned 换成 collected 之后，第 2 页不得再读上一轮的 owned 条目", async () => {
  /** 自建端点这一轮还回不回歌单：`false` = 路由变了，只剩公开那条能解析到。 */
  let ownedResolves = true;
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/playlist/detail")) {
      // 不回歌单时就是真机上那条"空壳"响应（没有 playListInfoEx）——自动改走公开端点
      return jsonResponse(ownedResolves ? wholePlaylistBody("P-1", "owned", 3) : okBody({}));
    }
    return jsonResponse(wholeCollectedBody("P-1", "collected", 4));
  });
  const api = apiOf({ fetchImpl });

  // 第一轮：自建端点解析成功 → 缓存里是 owned 那份（3 首）
  const ownedPage1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.equal(ownedPage1.ok, true);
  assert.equal(ownedPage1.data.available, 3);
  assert.deepEqual(ownedPage1.data.songs.map((song) => song.id), ["owned-1", "owned-2"]);

  // 路由变了：这次第一页只能由公开端点解析（4 首）
  ownedResolves = false;
  const collectedPage1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.equal(collectedPage1.ok, true);
  assert.equal(collectedPage1.data.available, 4, "第一页这次解析到的是公开那条");
  assert.deepEqual(collectedPage1.data.songs.map((song) => song.id), ["collected-1", "collected-2"]);

  // 关键：第 2 页必须跟**这次**的解析走，不许切到上一轮那份 owned 的 3 首里
  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.deepEqual(
    page2.data.songs.map((song) => song.id),
    ["collected-3", "collected-4"],
    "第 2 页来自上一轮的 owned 缓存（跨解析路径的旧条目）",
  );
  assert.equal(page2.data.available, 4, "第 2 页背后那份响应必须是这次解析到的那一份");
  assert.equal(page2.data.pageSource, "local-slice");
  // 请求次数把"第 2 页是本地切片"也钉住：3 = 第一轮 owned(1) + 第二轮 owned 空壳(1) + collected(1)，
  // 第 2 页 **0 次**
  assert.equal(calls.length, 3, `第 2 页不许再发网络（实际共 ${calls.length} 次）`);
});

test("R45A3 fix2：同一歌单 id 的两次第一页（owned / collected）互斥——第 2 页跟最近一次解析", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) =>
    url.includes("/playlist/detail")
      ? jsonResponse(wholePlaylistBody("P-1", "owned", 3))
      : jsonResponse(wholeCollectedBody("P-1", "collected", 4)),
  );
  const api = apiOf({ fetchImpl });

  const ownedPage1 = await api.getPlaylistDetail("P-1", { kind: "owned", page: 1, pageSize: 2 });
  assert.equal(ownedPage1.data.available, 3);
  const collectedPage1 = await api.getPlaylistDetail("P-1", { kind: "collected", page: 1, pageSize: 2 });
  assert.equal(collectedPage1.data.available, 4, "两条端点各问各的（第一页永远走网络）");

  // auto 的第 2 页：只认最近一次解析到的那条（collected），不许按固定顺序撞到 owned
  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.deepEqual(page2.data.songs.map((song) => song.id), ["collected-3", "collected-4"],
    "第 2 页命中了上一轮的 owned 条目（固定顺序优先于最近一次解析）");
  assert.equal(page2.data.available, 4);

  // 显式 kind 仍然只读那条自己的缓存：collected 的第 2 页不发网络
  const explicitPage2 = await api.getPlaylistDetail("P-1", { kind: "collected", page: 2, pageSize: 2 });
  assert.deepEqual(explicitPage2.data.songs.map((song) => song.id), ["collected-3", "collected-4"]);
  assert.equal(calls.length, 2, `两条第一页共 2 次网络，两个第 2 页都是本地切片（实际 ${calls.length} 次）`);
});

test("R45A3 fix2：会话换了（token / snsUserID）→ 上一轮的整表缓存先清掉，第 2 页重新取", async () => {
  let session = { token: "TOKEN-A", snsUserID: "SNS-A" };
  let generation = "A";
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (generation === "A") return jsonResponse(wholePlaylistBody("P-1", generation, 6));
    const start = Number(new URL(url).searchParams.get("start"));
    return jsonResponse(okBody({ playListInfoEx: {
      playListInfo: { contentID: "P-1", contentName: "歌单B", totalCount: "6" },
      playListSongInfoList: Array.from({ length: 2 }, (_value, index) => wireSong(`B-${start + index + 1}`)),
    } }));
  });
  // `session` 传函数：装配时它多半还是 null，运行期才会变（真机就是这条路）
  const api = apiOf({ fetchImpl, session: () => session });

  const page1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.deepEqual(page1.data.songs.map((song) => song.id), ["A-1", "A-2"]);
  assert.equal(calls.length, 1);

  // 换人（也是换 token）：上一轮那份属于上一个账号，第 2 页不许再切它
  session = { token: "TOKEN-B", snsUserID: "SNS-B" };
  generation = "B";
  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.equal(page2.ok, false, "会话变化清掉整表与分页路由后，auto 页 2 必须要求重取第一页");
  assert.equal(page2.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(calls.length, 1, "缺少 route pin 时不能猜端点");

  const explicitPage2 = await api.getPlaylistDetail("P-1", { kind: "owned", page: 2, pageSize: 2 });
  assert.deepEqual(explicitPage2.data.songs.map((song) => song.id), ["B-3", "B-4"],
    "显式 kind 仍可在缓存失效后重新取当前会话的页面");
  assert.equal(explicitPage2.data.available, 2);
  assert.equal(calls.length, 2);

  // 同一会话内再来一次：缺省 auto 仍不知道 fresh 请求的分页路由，不得猜
  const again = await api.getPlaylistDetail("P-1", { page: 3, pageSize: 2 });
  assert.equal(again.ok, false);
  assert.equal(calls.length, 2);
});

test("R45A3 fix2：整表缓存仍然**有上限**——第 5 张歌单把最旧的一张挤出去，它下次只能重新取", async () => {
  const ids = ["P-1", "P-2", "P-3", "P-4", "P-5"];
  const { calls, fetchImpl } = scriptedFetch((url) => {
    const id = new URL(url).searchParams.get("playListID") ?? "P-?";
    return jsonResponse(wholePlaylistBody(id, id.toLowerCase(), 3));
  });
  const api = apiOf({ fetchImpl });

  for (const id of ids) {
    const page1 = await api.getPlaylistDetail(id, { page: 1, pageSize: 2 });
    assert.equal(page1.data.available, 3, `${id} 的第一页拿到整份 3 首`);
  }
  assert.equal(calls.length, 5);

  // 上限是 4 张：最旧的 P-1 已经被挤出去，第 2 页只能去问网络（顺手证明"没被无界缓存吞掉"）
  const evictedPage2 = await api.getPlaylistDetail("P-1", { kind: "owned", page: 2, pageSize: 2 });
  assert.equal(calls.length, 6, "被淘汰的整表缓存必须重新取网络（缓存有上限）");
  assert.deepEqual(evictedPage2.data.songs.map((song) => song.id), ["p-1-3"], "取回来的是它自己的第 2 页");

  // 刚放进去的那张还在：本地切片，不再发请求（这次淘汰的是 P-2，不是 P-5）
  const freshPage2 = await api.getPlaylistDetail("P-5", { kind: "owned", page: 2, pageSize: 2 });
  assert.deepEqual(freshPage2.data.songs.map((song) => song.id), ["p-5-3"]);
  assert.equal(calls.length, 6, "最新放进去的那张仍是本地切片");
});

/**
 * R45A3 fix3（复审 Important + Minor）：**在途 / 失败 / 空 / 恰好一整页**这四档。
 *
 * 复审说得很具体：
 * 1. 会话 A 的第一页在途时切到会话 B；B 的第一页先回来并建好缓存；A 的旧响应**迟到**后
 *    把缓存改写成 A 的列表（而 `playlistCacheSession` 记的已经是 B）→ B 的第 2 页从 A 那份
 *    列表里切出来。根因：指纹只在**请求入口**对一次，`await` 之后什么都没复查。
 * 2. 第一页**失败或回空**时提前 `return`，上一轮的整表缓存**没有**失效 → 第 2 页照旧切片。
 * 3. "响应条数 == pageSize"这一档分不清"服务端真分页"与"服务端忽略窗口、每次回同一份"：
 *    后者会让触底加载反复取同一页，永远滚不完。
 *
 * 修法（下面每条用例都直接调真的 `createMusicApi`，不是扫源码）：
 * - 每次请求记下"开始时的会话指纹 + 这张歌单第一页的代次"，`await` 回来后两者都要对得上；
 *   对不上就**整条作废**（结构化 `stale_response`），既不写缓存、也不交回调用方；
 * - 第一页一开（早于网络）就把这张歌单**所有** kind 的旧条目失效，失败/空响应同样算；
 * - 恰好一整页的响应记住归一化 ID 序列；下一份整页序列**完全相同**（窗口起点不同）就收敛成
 *   "没有更多"（`pageSource: "server-repeat"`），不猜总数。
 *
 * 指纹只做**内存内的不透明比较**（FNV-1a 散列）：不进缓存数据、不进日志、不进设置、不落盘。
 */
test("R45A3 fix3：会话在途切换——旧会话迟到的第一页响应作废，不得写进新会话的缓存", async () => {
  let session = { token: "TOKEN-A", snsUserID: "SNS-A" };
  const deferred = deferredFetch();
  const api = apiOf({ fetchImpl: deferred.fetchImpl, session: () => session });

  // 会话 A 的第一页发出去，响应先挂住
  const pendingA = api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  await flushFetch();
  assert.equal(deferred.calls.length, 1, "A 的第一页真的发出去了");

  // 期间换人（token 与 snsUserID 都换）：B 的第一页也发出去
  session = { token: "TOKEN-B", snsUserID: "SNS-B" };
  const pendingB = api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  await flushFetch();
  assert.equal(deferred.calls.length, 2, "B 的第一页也真的发出去了");

  // B 先回（6 首整份）：这是新会话该看到的那一份
  deferred.calls[1].resolve(jsonResponse(wholePlaylistBody("P-1", "B", 6)));
  const bPage1 = await pendingB;
  assert.equal(bPage1.ok, true);
  assert.equal(bPage1.data.available, 6);
  assert.deepEqual(pageIdsOf(bPage1), ["B-1", "B-2"]);

  // A 的旧响应现在才回：整条作废（不许当成功交回，更不许写缓存）
  deferred.calls[0].resolve(jsonResponse(wholePlaylistBody("P-1", "A", 3)));
  const lateA = await pendingA;
  assert.equal(lateA.ok, false, "迟到的旧会话响应不许当成功交回");
  assert.equal(lateA.error.kind, MUSIC_ERROR_KINDS.staleResponse);
  assert.doesNotMatch(JSON.stringify(lateA), /TOKEN-|SNS-/, "错误里不许带会话内容/凭据");

  // 关键：B 的第 2 页仍是 B 那一份（旧响应既没覆盖缓存、也没改"最近解析到哪个端点"）
  const bPage2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.deepEqual(pageIdsOf(bPage2), ["B-3", "B-4"], "第 2 页切到了上一个会话那份列表（旧响应迟到了）");
  assert.equal(bPage2.data.available, 6, "第 2 页背后必须是 B 的那一份");
  assert.equal(deferred.calls.length, 2, "第 2 页是本地切片，不再发请求");

  // 迟到响应也不许把缓存清成空的：B 的第 3 页仍在同一份切片上
  const bPage3 = await api.getPlaylistDetail("P-1", { page: 3, pageSize: 2 });
  assert.deepEqual(pageIdsOf(bPage3), ["B-5", "B-6"]);
  assert.equal(deferred.calls.length, 2);
});

test("R45A3 fix3：同一会话里两次第一页在途——先发的那条迟到响应同样作废（不覆盖新缓存）", async () => {
  const deferred = deferredFetch();
  const api = apiOf({ fetchImpl: deferred.fetchImpl });

  const older = api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  await flushFetch();
  const newer = api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  await flushFetch();
  assert.equal(deferred.calls.length, 2);

  // 后发的那条先回（4 首）：它才是"这一轮的最新事实"
  deferred.calls[1].resolve(jsonResponse(wholePlaylistBody("P-1", "new", 4)));
  const newerPage1 = await newer;
  assert.equal(newerPage1.ok, true);
  assert.equal(newerPage1.data.available, 4);

  // 先发的那条迟到：同样作废（不许把上一轮那份 3 首写回缓存）
  deferred.calls[0].resolve(jsonResponse(wholePlaylistBody("P-1", "old", 3)));
  const olderPage1 = await older;
  assert.equal(olderPage1.ok, false);
  assert.equal(olderPage1.error.kind, MUSIC_ERROR_KINDS.staleResponse);

  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.deepEqual(pageIdsOf(page2), ["new-3", "new-4"], "第 2 页被先发那条的迟到响应带回了旧内容");
  assert.equal(page2.data.available, 4);
  assert.equal(deferred.calls.length, 2, "两次第一页共 2 次网络，第 2 页是本地切片");
});

test("R45A3 fix3：第一页失败时旧的整表缓存一起失效——第 2 页不许再读出上一轮那份内容", async () => {
  /** `first` = 上一轮那份（old 3 首）；`fail` = 两条端点都业务失败；`fresh` = 新的 4 首。 */
  let mode = "first";
  const { calls, fetchImpl } = scriptedFetch(() => {
    if (mode === "fail") return jsonResponse({ result: { resultCode: "990000", resultMessage: "系统错误" } });
    if (mode === "fresh") return jsonResponse(wholePlaylistBody("P-1", "fresh", 4));
    return jsonResponse(wholePlaylistBody("P-1", "old", 3));
  });
  const api = apiOf({ fetchImpl });

  const page1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.deepEqual(pageIdsOf(page1), ["old-1", "old-2"]);
  assert.equal(calls.length, 1, "整份 3 首只取一次网络");

  // 第一页失败（自建、公开两条端点都失败）：旧的整表缓存必须已经失效
  mode = "fail";
  const failed = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, MUSIC_ERROR_KINDS.apiError);
  assert.equal(calls.length, 3, "auto 依次问了两条端点");

  // 第 2 页：旧缓存与 auto 路由都已失效 → 要求重新取第一页，不猜 endpoint
  mode = "fresh";
  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.equal(page2.ok, false);
  assert.equal(page2.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.match(page2.error.message, /第 1 页/);
  assert.equal(calls.length, 3, "缺少新第一页 route pin 时不请求网络");

  const explicitPage2 = await api.getPlaylistDetail("P-1", { kind: "owned", page: 2, pageSize: 2 });
  assert.deepEqual(pageIdsOf(explicitPage2), ["fresh-3", "fresh-4"]);
  assert.equal(calls.length, 4, "显式 kind 仍按调用方选择的端点请求");
});

test("R45A3 fix3：第一页回空（两条端点都没有歌单元信息）同样让旧的整表缓存失效", async () => {
  let mode = "first";
  const { calls, fetchImpl } = scriptedFetch(() => {
    if (mode === "empty") return jsonResponse(okBody({}));
    if (mode === "fresh") return jsonResponse(wholePlaylistBody("P-1", "fresh", 4));
    return jsonResponse(wholePlaylistBody("P-1", "old", 3));
  });
  const api = apiOf({ fetchImpl });

  await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.equal(calls.length, 1);

  mode = "empty";
  const empty = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 2 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(calls.length, 3, "两条端点都问了，都只回了空壳");

  mode = "fresh";
  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 2 });
  assert.equal(page2.ok, false, "空的第一页会清掉 auto 分页端点选择");
  assert.equal(page2.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.match(page2.error.message, /第 1 页/);
  assert.equal(calls.length, 3, "缺少 route pin 时不猜端点或发网络请求");

  const explicitPage2 = await api.getPlaylistDetail("P-1", { kind: "owned", page: 2, pageSize: 2 });
  assert.deepEqual(pageIdsOf(explicitPage2), ["fresh-3", "fresh-4"]);
  assert.equal(calls.length, 4, "显式 kind 仍可在第一页失败后重新请求");
});

test("R45A3 fix3：恰好一整页且服务端忽略 start/limit——第二次整页完全相同就收敛，不无限循环", async () => {
  // 恰好 50 首、服务端忽略窗口：每页都回同一份 50 首（复现"滚到底反复取同一页"）
  const items = Array.from({ length: 50 }, (_value, index) => wireSong(`s${index + 1}`));
  const { calls, fetchImpl } = scriptedFetch(() =>
    jsonResponse(
      okBody({
        playListInfoEx: {
          playListInfo: { contentID: "P-1", contentName: "恰好一页", totalCount: "50" },
          playListSongInfoList: items,
        },
      }),
    ),
  );
  const api = apiOf({ fetchImpl });

  const page1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 50 });
  assert.equal(page1.data.songs.length, 50);
  assert.equal(page1.data.pageSource, "server", "恰好一整页：分不清是不是真分页，不许自称本地切片");
  assert.equal(page1.data.hasMore, true, "第一页还不能断言没有更多（不编后端没给的结论）");

  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 50 });
  assert.equal(calls.length, 2, "这一档本来就得问一次（第一页看不出来）");
  assert.deepEqual(pageIdsOf(page2), [], "重复的整页不再交给调用方（否则界面把同一批歌再渲染一遍）");
  assert.equal(page2.data.hasMore, false, "整页重复 → 收敛成没有更多（不许无限循环）");
  assert.equal(page2.data.pageSource, "server-repeat");
  assert.equal(page2.data.available, 50, "只说这一份响应有多少条，不冒充总数");

  // 第 3 页即使被问，也不会再把同一份交回来
  const page3 = await api.getPlaylistDetail("P-1", { page: 3, pageSize: 50 });
  assert.equal(calls.length, 3);
  assert.deepEqual(pageIdsOf(page3), []);
  assert.equal(page3.data.hasMore, false);

  // 重新打开歌单（新的第一页）→ 重复判据重置：仍按"恰好一整页"照常交回，不被永久判死
  const again = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 50 });
  assert.equal(calls.length, 4);
  assert.equal(again.data.songs.length, 50);
  assert.equal(again.data.hasMore, true);
});

test("R45A fix4：auto 服务端分页固定第一页端点，失败不回退到另一来源", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/playlist/detail")) {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return jsonResponse(wholePlaylistBody("P-pin", "owned", 2));
      return jsonResponse({ message: "owned endpoint unavailable" }, 503);
    }
    return jsonResponse(wholeCollectedBody("P-pin", "collected", 4));
  };
  const api = apiOf({ fetchImpl });

  const first = await api.getPlaylistDetail("P-pin", { page: 1, pageSize: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.data.pageSource, "server");
  assert.deepEqual(first.data.songs.map((song) => song.id), ["owned-1", "owned-2"]);

  const second = await api.getPlaylistDetail("P-pin", { page: 2, pageSize: 2 });
  assert.equal(second.ok, false, "第一页选中的 owned 端点失败时，不能拿 collected 结果补页");
  assert.equal(second.error.kind, MUSIC_ERROR_KINDS.httpError);
  assert.equal(calls.length, 2, "失败后只请求 pinned owned，不调用 collected");
  assert.ok(calls.every((url) => url.includes("/playlist/detail")));
});

test("R45A fix4：auto 首页解析到 collected 后，服务端后续页仍固定 collected", async () => {
  const { calls, fetchImpl } = scriptedFetch((_url, init) => {
    if (_url.includes("/playlist/detail")) return jsonResponse(okBody({}));
    const start = JSON.parse(init.body).start;
    return jsonResponse(okBody({ musicListInfoEx: {
      musicListDetail: { contentID: "P-collected", contentName: "收藏歌单", contentType: "4" },
      songSimpleInfos: Array.from({ length: 2 }, (_value, index) => wireSong(`collected-${start + index + 1}`)),
    } }));
  });
  const api = apiOf({ fetchImpl });

  const first = await api.getPlaylistDetail("P-collected", { page: 1, pageSize: 2 });
  const second = await api.getPlaylistDetail("P-collected", { page: 2, pageSize: 2 });
  assert.equal(first.data.pageSource, "server");
  assert.deepEqual(first.data.songs.map((song) => song.id), ["collected-1", "collected-2"]);
  assert.deepEqual(second.data.songs.map((song) => song.id), ["collected-3", "collected-4"]);
  assert.equal(calls.length, 3, "owned 空壳一次，collected 的第一页与第二页各一次");
  assert.ok(calls[1].url.includes("/playlist/public"));
  assert.ok(calls[2].url.includes("/playlist/public"));
});

test("R45A fix4：服务端路由映射有界，超限后续页要求重新取第一页", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    const id = new URL(url).searchParams.get("playListID");
    return jsonResponse(wholePlaylistBody(id, id, 2));
  });
  const api = apiOf({ fetchImpl });

  for (let index = 1; index <= 20; index += 1) {
    const first = await api.getPlaylistDetail(`P-route-${index}`, { page: 1, pageSize: 2 });
    assert.equal(first.ok, true);
    assert.equal(first.data.pageSource, "server");
  }

  const oldest = await api.getPlaylistDetail("P-route-1", { page: 2, pageSize: 2 });
  assert.equal(oldest.ok, false, "淘汰路由后不能猜端点或重新走 auto fallback");
  assert.equal(oldest.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.match(oldest.error.message, /第 1 页/);
  assert.equal(calls.length, 20, "缺少映射时不再发网络请求");
});

test("R45A fix4：失败的重开第一页与会话变化都清除旧服务端路由", async () => {
  let session = { token: "TOKEN-A", snsUserID: "SNS-A" };
  let mode = "server";
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (mode === "empty") return jsonResponse(okBody({}));
    const id = new URL(url).searchParams.get("playListID") ?? "P-route-reset";
    return jsonResponse(wholePlaylistBody(id, "owned", 2));
  });
  const api = apiOf({ fetchImpl, session: () => session });

  await api.getPlaylistDetail("P-route-reset", { page: 1, pageSize: 2 });
  mode = "empty";
  const failedFirst = await api.getPlaylistDetail("P-route-reset", { page: 1, pageSize: 2 });
  assert.equal(failedFirst.ok, false);
  const callsAfterFailedFirst = calls.length;
  const afterFailure = await api.getPlaylistDetail("P-route-reset", { page: 2, pageSize: 2 });
  assert.equal(afterFailure.ok, false, "新第一页失败后不再使用之前的路由选择");
  assert.equal(afterFailure.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(calls.length, callsAfterFailedFirst);

  mode = "server";
  await api.getPlaylistDetail("P-session-route", { page: 1, pageSize: 2 });
  session = { token: "TOKEN-B", snsUserID: "SNS-B" };
  const callsBeforeSessionPage = calls.length;
  const afterSessionChange = await api.getPlaylistDetail("P-session-route", { page: 2, pageSize: 2 });
  assert.equal(afterSessionChange.ok, false, "会话变化后旧路由必须失效并要求重取第一页");
  assert.equal(afterSessionChange.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(calls.length, callsBeforeSessionPage);
});

test("歌单详情：服务端真的认 start/limit 时退回网络分页（不被本地切片吞掉）", async () => {
  const items = Array.from({ length: 120 }, (_value, index) => wireSong(`t${index + 1}`));
  const { calls, fetchImpl } = scriptedFetch((url) => {
    const query = new URL(url).searchParams;
    const start = Number(query.get("start") ?? 0);
    const limit = Number(query.get("limit") ?? 50);
    return jsonResponse(okBody({
      playListInfoEx: {
        playListInfo: { contentID: "P-1", contentName: "诚实分页的歌单", totalCount: "120" },
        playListSongInfoList: items.slice(start, start + limit),
      },
    }));
  });
  const api = apiOf({ fetchImpl });

  const page1 = await api.getPlaylistDetail("P-1", { page: 1, pageSize: 50 });
  assert.equal(page1.data.songs.length, 50);
  assert.equal(page1.data.pageSource, "server", "整页返回 = 这个端点可能真的在分页（不假称本地切片）");
  assert.equal(page1.data.hasMore, true);

  const page2 = await api.getPlaylistDetail("P-1", { page: 2, pageSize: 50 });
  assert.equal(calls.length, 2, "服务端认窗口时第 2 页必须再发一次网络");
  assert.deepEqual(page2.data.songs.map((song) => song.id), items.slice(50, 100).map((song) => song.contentID));
  assert.equal(page2.data.hasMore, true);
  assert.equal(page2.data.pageSource, "server");

  const page3 = await api.getPlaylistDetail("P-1", { page: 3, pageSize: 50 });
  assert.equal(calls.length, 3);
  assert.deepEqual(page3.data.songs.map((song) => song.id), items.slice(100, 120).map((song) => song.contentID));
  assert.equal(page3.data.hasMore, false, "最后一页不足一页 → 没有更多");
});

test("歌单删除：只走 playlistDelete 端点（不得用收藏端点冒充成功）、不自动重试", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse(okBody()));
  const api = apiOf({ fetchImpl });

  const deleted = await api.deletePlaylist("p1");
  assert.equal(deleted.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { playListID: "p1" });
  assert.equal(new URL(calls[0].url).pathname, "/api/playlist/delete");

  const empty = await api.deletePlaylist("");
  assert.equal(empty.ok, false);
  assert.equal(empty.error.kind, MUSIC_ERROR_KINDS.missingParam);

  // 写操作不自动重试：网络失败一次就如实报错（超时可能已经在服务端生效了）
  const flaky = scriptedFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const failing = await apiOf({ fetchImpl: flaky.fetchImpl }).deletePlaylist("p1");
  assert.equal(failing.ok, false);
  assert.equal(failing.error.kind, MUSIC_ERROR_KINDS.networkError);
  assert.equal(flaky.calls.length, 1, "写操作绝不自动重发");
});

test("会话头注入：默认带 Digest 头（由主进程注入），注入的 headers 原样进请求", async () => {
  const withSession = scriptedFetch(() => jsonResponse(okBody({ favoriteInfos: [] })));
  const api = apiOf({ fetchImpl: withSession.fetchImpl, api: { sessionHeaders: () => ({ "x-hw-session": "SESSION-1" }) } });
  await api.listFavoritesPage();
  assert.equal(withSession.calls[0].init.headers["x-hw-session"], "SESSION-1");
  assert.equal(withSession.calls[0].init.headers["content-type"], "application/json");

  // sessionHeaders 拿得到"这次是不是带凭据的调用"
  const seen = [];
  const spying = scriptedFetch(() => jsonResponse(okBody({ songSimpleInfos: [] })));
  const spyApi = apiOf({
    fetchImpl: spying.fetchImpl,
    api: { sessionHeaders: (context) => (seen.push(context), {}) },
  });
  await spyApi.search("abc");
  await spyApi.readFavoritesPage({ page: 1 });
  assert.deepEqual(seen, [
    { key: "search", authenticated: false },
    { key: "favorites", authenticated: true },
  ]);
});

test("只读请求：网络失败重试一次（真接口偶发抖动），第二次成功就算成功", async () => {
  const { calls, fetchImpl } = scriptedFetch((_url, _init, all) => {
    if (all.length === 1) throw new Error("socket hang up");
    return jsonResponse(okBody({ favoriteInfos: [] }));
  });
  const result = await apiOf({ fetchImpl }).listFavoritesPage();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test("搜索：POST JSON 体（contentType/correct/queryWord/start/limit）；hasNextPage 决定 hasMore", async () => {
  const { calls, fetchImpl } = scriptedFetch(() =>
    jsonResponse(okBody({ songSimpleInfos: [wireSong("s1")], hasNextPage: "1", totalNum: 42 })),
  );
  const api = apiOf({ fetchImpl });
  const result = await api.search("  周杰伦  ", { page: 2, pageSize: 20 });

  assert.equal(result.ok, true);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { contentType: "1", correct: "1", queryWord: "周杰伦", start: "20", limit: "20" });
  assert.deepEqual(result.data.songs.map((item) => item.id), ["s1"]);
  assert.equal(result.data.hasMore, true);
  assert.equal(result.data.reportedTotal, 42);

  const emptyKeyword = await api.search("   ");
  assert.equal(emptyKeyword.ok, false);
  assert.equal(emptyKeyword.error.kind, MUSIC_ERROR_KINDS.missingParam);
});

test("专辑/歌手/历史：各走自己的端点与方法、带上自己的参数名", async () => {
  const albumFetch = scriptedFetch(() =>
    jsonResponse(okBody({ albumInfoEx: { albumInfo: { albumCode: "AL-1" }, songSimpleInfos: [wireSong("a1")] } })),
  );
  const album = await apiOf({ fetchImpl: albumFetch.fetchImpl }).getAlbum("AL-1", { page: 1, pageSize: 50 });
  assert.equal(album.ok, true);
  assert.equal(albumFetch.calls[0].init.method, "GET", "专辑详情是 GET");
  const albumQuery = new URL(albumFetch.calls[0].url).searchParams;
  assert.equal(albumQuery.get("albumCode"), "AL-1");
  assert.equal(albumQuery.get("start"), "0");
  assert.equal(albumQuery.get("limit"), "50");
  assert.deepEqual(album.data.songs.map((item) => item.id), ["a1"]);

  const artistFetch = scriptedFetch(() =>
    jsonResponse(
      okBody({
        artistInfoEx: { artistInfo: { artistCode: "AR-1" }, songSimpleInfos: [wireSong("b1")], albumSimpleInfos: [] },
      }),
    ),
  );
  const artist = await apiOf({ fetchImpl: artistFetch.fetchImpl }).getArtist("AR-1");
  assert.equal(artist.ok, true);
  assert.equal(artistFetch.calls[0].init.method, "POST");
  assert.deepEqual(artistFetch.calls[0].body, { artistCode: "AR-1", songNum: 20, albumNum: 20 });
  assert.deepEqual(artist.data.songs.map((item) => item.id), ["b1"]);

  const historyFetch = scriptedFetch(() =>
    jsonResponse(okBody({ contentSimpleInfos: [wireSong("h1")] })),
  );
  const history = await apiOf({ fetchImpl: historyFetch.fetchImpl }).getHistory();
  assert.equal(history.ok, true);
  assert.equal(historyFetch.calls[0].init.method, "GET", "播放历史是 GET");
  assert.equal(new URL(historyFetch.calls[0].url).searchParams.get("contentType"), "1");
  assert.deepEqual(history.data.songs.map((item) => item.id), ["h1"]);
  assert.equal(history.data.hasMore, false, "参考只验证了这一条查询，不承诺无限翻页");
});

test("playback：POST JSON 体（contentCode/contentType/qualityType）；顶层 fileURL 才是音频", async () => {
  const payload = {
    fileURL: "https://cdn.dbankcdn.cn/music/a.mp3",
    fileInfos: '[{"format":"mp3","size":1024,"bitrate":320}]',
    format: "mp3",
    size: 1024,
    bitrate: 320,
    playQuality: "1",
    type: "mp3",
    songInfo: { duration: 203.885714 },
    auditionTime: 0,
  };
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse(okBody(payload)));
  const api = apiOf({ fetchImpl });

  const result = await api.getPlayback({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { contentCode: "s1", contentType: "1", qualityType: "1" });
  assert.equal(result.data.url, "https://cdn.dbankcdn.cn/music/a.mp3");
  assert.deepEqual(result.data.fileInfos, [{ format: "mp3", size: 1024, bitrate: 320 }]);
  assert.equal(result.data.actualQuality, "standard", "声明的 mp3 + playQuality=1 才算确认音质");
  assert.equal(result.data.duration, 203.885714, "没有顶层 duration 时取 songInfo.duration");
  assert.equal(result.data.auditionLikely, false);

  const lossless = await apiOf({
    fetchImpl: scriptedFetch(() => jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.flac", playQuality: "3", type: "flac" }))).fetchImpl,
  }).getPlayback({ trackId: "s1", quality: "lossless" });
  assert.equal(lossless.data.actualQuality, "lossless");

  const lying = await apiOf({
    fetchImpl: scriptedFetch(() => jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", playQuality: "3", type: "mp3" }))).fetchImpl,
  }).getPlayback({ trackId: "s1", quality: "lossless" });
  assert.equal(lying.data.actualQuality, "unknown", "声明与返回对不上就不虚标音质");

  const unsupported = await api.getPlayback({ trackId: "s1", quality: "hires" });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.kind, MUSIC_ERROR_KINDS.qualityUnsupported);

  assert.deepEqual(parseFileInfos('[{"a":1}]'), { ok: true, value: [{ a: 1 }] });
  assert.deepEqual(parseFileInfos({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.equal(parseFileInfos("{oops").ok, false, "坏 JSON 不得抛");
  assert.equal(parseFileInfos(null).ok, false);
});

test("playback 陷阱：fileInfos 坏 JSON → 降级为 null 并记警告，不影响出音频地址", async () => {
  const { fetchImpl } = scriptedFetch(() =>
    jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/music/a.mp3", fileInfos: "{oops", auditionTime: 0 })),
  );
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
});

test("playback 拒绝：缺 fileURL、非白名单 CDN 域", async () => {
  const empty = scriptedFetch(() => jsonResponse(okBody({ fileURL: "", auditionTime: 0 })));
  const missing = await apiOf({ fetchImpl: empty.fetchImpl }).getPlayback({ trackId: "s1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.kind, MUSIC_ERROR_KINDS.invalidResponse);

  const foreign = scriptedFetch(() => jsonResponse(okBody({ fileURL: "https://evil.example.com/a.mp3" })));
  const unsafe = await apiOf({ fetchImpl: foreign.fetchImpl }).getPlayback({ trackId: "s1" });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error.kind, MUSIC_ERROR_KINDS.unsafeMediaUrl);
  assert.match(unsafe.error.message, /evil\.example\.com/);

  const direct = parsePlaybackPayload({ fileURL: "https://a.b.c.dbankcdn.cn/a.mp3" });
  assert.equal(direct.ok, true);
});

test("歌词：从播放响应推导——有 lyricAddress 就下载文本（只认白名单地址）", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", lyricAddress: "https://cdn.dbankcdn.cn/a.lrc" }));
    }
    return new Response("[00:01.00]第一行\n[00:02.00]第二行", { status: 200 });
  });
  const result = await apiOf({ fetchImpl }).getLyrics({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.match(result.data.text, /第一行/);
  assert.equal(calls.length, 2, "一次播放响应 + 一次歌词资源");
  assert.equal(calls[1].init.method, "GET");
});

test("歌词：白名单外的地址不下载，回退到内嵌歌词（contentExInfo 是 JSON 字符串）", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    assert.match(url, /playback/, "不该去下载白名单外的歌词地址");
    return jsonResponse(
      okBody({
        fileURL: "https://cdn.dbankcdn.cn/a.mp3",
        lyricAddress: "https://evil.example.com/a.lrc",
        contentExInfo: JSON.stringify({ lyrics: JSON.stringify({ lyric: "[00:01.00]内嵌" }) }),
      }),
    );
  });
  const result = await apiOf({ fetchImpl }).getLyrics({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.text, "[00:01.00]内嵌", "内嵌歌词最多剥两层 JSON");
  assert.equal(calls.length, 1);
});

test("歌词：既没有地址也没有内嵌 → invalid_response（不把整段响应体当歌词）", async () => {
  const { fetchImpl } = scriptedFetch(() => jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3" })));
  const result = await apiOf({ fetchImpl }).getLyrics({ trackId: "s1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.match(result.error.message, /歌词/);
});

test("歌词：注入过独立歌词端点就直接打它（宽容读候选键；形状不对就如实报）", async () => {
  const { calls, fetchImpl } = scriptedFetch(() => jsonResponse(okBody({ lyric: "[00:01.00]独立端点" })));
  const api = apiOf({ endpoints: { ...ENDPOINTS, lyrics: "https://example.invalid/api/lyrics" }, fetchImpl });
  const result = await api.getLyrics({ trackId: "s1" });
  assert.equal(result.ok, true);
  assert.equal(result.data.text, "[00:01.00]独立端点");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\/lyrics/);

  const junk = apiOf({
    endpoints: { ...ENDPOINTS, lyrics: "https://example.invalid/api/lyrics" },
    fetchImpl: scriptedFetch(() => jsonResponse(okBody({ nothing: true }))).fetchImpl,
  });
  const refused = await junk.getLyrics({ trackId: "s1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
});

test("歌词（R38）：已加载的曲目条目自带 lyricAddress → 直接用那条地址，不再问播放端点", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playlist/detail")) {
      return jsonResponse(
        okBody({
          playListInfoEx: {
            playListInfo: { contentID: "p1", contentName: "歌单" },
            playListSongInfoList: [wireSong("s1", { lyricAddress: "https://cdn.dbankcdn.cn/s1.lrc" })],
          },
        }),
      );
    }
    if (url.endsWith("/s1.lrc")) return new Response("[00:01.00]条目里的歌词", { status: 200 });
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  // 先加载列表（条目里的地址在这一步进索引）
  const detail = await api.getPlaylistDetail("p1");
  assert.equal(detail.ok, true);

  const lyrics = await api.getLyrics({ trackId: "s1" });
  assert.equal(lyrics.ok, true, "列表条目里的歌词地址应当能取到歌词");
  assert.match(lyrics.data.text, /条目里的歌词/);
  assert.equal(
    calls.some((call) => call.url.includes("/api/playback")),
    false,
    "命中索引就不该再打播放端点（官方 H5 也是拿列表里那条地址）",
  );
});

// —— R40：第 4 档「按专辑补条目索引」（重启后直接播恢复出来的队列那一档） -----------------

test("歌词（R40）：索引里没有 + 播放响应给了 albumID → 用既有专辑端点补一次条目索引，取到歌词", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      // 播放响应：没有歌词地址，但内嵌的 songInfo 给了专辑 id（与 songSimpleInfos 同形）
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", albumID: "A9" } }));
    }
    if (url.includes("/api/album")) {
      const query = new URL(url).searchParams;
      if (query.get("albumCode") !== "A9") throw new Error(`专辑 id 不对：${url}`);
      // 专辑响应里的条目自带 lyricAddress（真机实测：albumInfoEx.songSimpleInfos[] 3/3 都有）
      return jsonResponse(
        okBody({ albumInfoEx: { albumInfo: { contentID: "A9", contentName: "专辑" }, songSimpleInfos: [wireSong("s9", { albumID: "A9", lyricAddress: "https://cdn.dbankcdn.cn/s9.lrc" })] } }),
      );
    }
    if (url.endsWith("/s9.lrc")) return new Response("[00:01.00]专辑补来的歌词", { status: 200 });
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, true, JSON.stringify(lyrics));
  assert.match(lyrics.data.text, /专辑补来的歌词/);
  assert.ok(
    calls.some((call) => call.url.includes("/api/album")),
    "第 4 档真的去问了既有专辑端点（不发明端点）",
  );
  // 顺序：先播放响应，再专辑，最后下载歌词
  assert.deepEqual(
    calls.map((call) => (call.url.includes("/api/playback") ? "playback" : call.url.includes("/api/album") ? "album" : "lrc")),
    ["playback", "album", "lrc"],
  );
});

test("歌词（R40）：播放响应没给专辑 id → 不打专辑端点，照旧如实回 invalid_response（不猜 id）", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3" }));
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(calls.some((call) => call.url.includes("/api/album")), false, "没有专辑 id 就不该瞎试");
});

test("歌词（R40）：专辑里没有这一首（或专辑端点失败）→ 仍然如实回 invalid_response，并把原因记进 warnings", async () => {
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", albumID: "A9" } }));
    }
    if (url.includes("/api/album")) {
      // 专辑响应里只有别的曲目（没有 s9）
      return jsonResponse(okBody({ albumInfoEx: { songInfo: {}, songSimpleInfos: [wireSong("other", { albumID: "A9", lyricAddress: "https://cdn.dbankcdn.cn/other.lrc" })] } }));
    }
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
});

test("歌词（R40）：回落那一档只记键名（值不进日志）——专辑 id 与响应内容都不许出现在日志里", async () => {
  const logs = [];
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(
        okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", albumID: "A9", albumName: "不该进日志的专辑名" } }),
      );
    }
    if (url.includes("/api/album")) return jsonResponse(okBody({ albumInfoEx: { songSimpleInfos: [] } }));
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl, api: { log: (line) => logs.push(line) } });

  await api.getLyrics({ trackId: "s9" });
  const line = logs.find((entry) => entry.includes("歌词回落"));
  assert.ok(line, `要有一行回落诊断：${JSON.stringify(logs)}`);
  assert.match(line, /albumID/, "播放响应的键名要给出来（这就是要看的东西）");
  assert.match(line, /songInfo 键名/, "内嵌 songInfo 的键名也要（专辑 id 最可能在那里）");
  assert.ok(!line.includes("不该进日志的专辑名"), "响应里的值不进日志");
  assert.ok(!line.includes("A9"), "连专辑 id 的值也不进日志（只记键名）");
});

test("歌词（R40）：日志口默认不存在时也不崩（协议层自己不写日志）", async () => {
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", albumID: "A9" }));
    if (url.includes("/api/album")) return jsonResponse(okBody({ albumInfoEx: { songSimpleInfos: [] } }));
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });
  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, false, "没有 log 注入位时照旧走完这条链");
});

test("歌词（R41）：第 4 档的失败进会话内负缓存——同一首重复取词不再重放那次专辑请求", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", albumID: "A9" } }));
    }
    if (url.includes("/api/album")) {
      // 这张专辑里没有这一首：第 4 档的"失败"，但它是**结论**（下次问也一样）
      return jsonResponse(okBody({ albumInfoEx: { songSimpleInfos: [wireSong("other", { albumID: "A9" })] } }));
    }
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  const first = await api.getLyrics({ trackId: "s9" });
  assert.equal(first.ok, false);
  const second = await api.getLyrics({ trackId: "s9" });
  assert.equal(second.ok, false, "第二次照旧如实失败（负缓存不是把失败改写成成功）");

  const albumCalls = calls.filter((call) => call.url.includes("/api/album"));
  assert.equal(albumCalls.length, 1, `同一对 (曲目, 专辑) 每进程只问一次：${albumCalls.length} 次`);
  assert.equal(
    calls.filter((call) => call.url.includes("/api/playback")).length,
    2,
    "前几档照旧每次都走（负缓存只管第 4 档那一次额外请求）",
  );
});

test("歌词（R41）：负缓存的键是 (曲目, 专辑) 这一对——换了专辑 id 就是一次没试过的请求", async () => {
  let albumCode = "A1";
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", albumID: albumCode } }));
    }
    if (url.includes("/api/album")) return jsonResponse(okBody({ albumInfoEx: { songSimpleInfos: [] } }));
    throw new Error(`不该请求：${url}`);
  });
  const api = apiOf({ fetchImpl });

  await api.getLyrics({ trackId: "s9" });
  albumCode = "A2";
  await api.getLyrics({ trackId: "s9" });
  assert.equal(
    calls.filter((call) => call.url.includes("/api/album")).length,
    2,
    "换了专辑 id 就该再问一次（旧结论挡不住另一张专辑）",
  );
});

test("歌词（R38）：白名单外的条目地址不进索引（不会被下载）", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playlist/detail")) {
      return jsonResponse(
        okBody({
          playListInfoEx: {
            playListInfo: { contentID: "p1", contentName: "歌单" },
            playListSongInfoList: [wireSong("s1", { lyricAddress: "https://evil.example.com/s1.lrc" })],
          },
        }),
      );
    }
    assert.match(url, /playback/, "白名单外的地址绝不能被下载");
    return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3" }));
  });
  const api = apiOf({ fetchImpl });
  await api.getPlaylistDetail("p1");

  const lyrics = await api.getLyrics({ trackId: "s1" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(
    calls.some((call) => call.url.includes("evil.example.com")),
    false,
    "白名单外的地址一次都不许发出去",
  );
});

test("歌词（R38）：索引里的地址过期（下载失败）→ 回落播放响应那条路", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playlist/detail")) {
      return jsonResponse(
        okBody({
          playListInfoEx: {
            playListInfo: { contentID: "p1", contentName: "歌单" },
            playListSongInfoList: [wireSong("s1", { lyricAddress: "https://cdn.dbankcdn.cn/stale.lrc" })],
          },
        }),
      );
    }
    if (url.endsWith("/stale.lrc")) return new Response("gone", { status: 403 });
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", lyricAddress: "https://cdn.dbankcdn.cn/fresh.lrc" }));
    }
    return new Response("[00:01.00]新地址", { status: 200 });
  });
  const api = apiOf({ fetchImpl });
  await api.getPlaylistDetail("p1");

  const lyrics = await api.getLyrics({ trackId: "s1" });
  assert.equal(lyrics.ok, true, "过期地址不是结论：要继续走播放响应那条路");
  assert.match(lyrics.data.text, /新地址/);
  assert.equal(calls.at(-1).url.endsWith("/fresh.lrc"), true);
});

test("歌词（R38）：播放响应内嵌的 songInfo 按同一份候选表读（含 contentExInfo 是 JSON 字符串）", () => {
  assert.equal(
    lyricAddressOf({ songInfo: { lyricAddress: "https://cdn.dbankcdn.cn/in.lrc" } }),
    "https://cdn.dbankcdn.cn/in.lrc",
    "songInfo 就是列表里那种曲目条目：它自带的 lyricAddress 要认",
  );
  assert.equal(lyricAddressOf({ songInfo: { lyricAddress: "https://evil.example.com/in.lrc" } }), null);
  assert.equal(
    lyricAddressOf({ songInfo: { contentExInfo: JSON.stringify({ lyrics: { lyricAddress: "https://cdn.dbankcdn.cn/ex.lrc" } }) } }),
    "https://cdn.dbankcdn.cn/ex.lrc",
  );
  assert.equal(
    inlineLyricsOf({ songInfo: { contentExInfo: JSON.stringify({ lyrics: "[00:01.00]内嵌在 songInfo" }) } }),
    "[00:01.00]内嵌在 songInfo",
  );
});

test("歌词（R38）：索引有上限（FIFO）——超限时最旧一条被淘汰，新条目照旧命中", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playlist/detail")) {
      return jsonResponse(
        okBody({
          playListInfoEx: {
            playListInfo: { contentID: "p1", contentName: "歌单" },
            playListSongInfoList: [1, 2, 3].map((n) =>
              wireSong(`s${n}`, { lyricAddress: `https://cdn.dbankcdn.cn/s${n}.lrc` }),
            ),
          },
        }),
      );
    }
    if (url.endsWith("/s3.lrc")) return new Response("[00:01.00]最新一条", { status: 200 });
    // 淘汰之后只许回落播放响应；被淘汰的 s1.lrc 一次都不许再请求
    if (!url.includes("/api/playback")) throw new Error(`不该请求：${url}`);
    return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3" }));
  });
  // 上限压到 2：进 3 条时只该留下最后两条（s1 是被淘汰的那一条）
  const api = apiOf({ fetchImpl, api: { lyricIndexLimit: 2 } });
  await api.getPlaylistDetail("p1");

  const newest = await api.getLyrics({ trackId: "s3" });
  assert.equal(newest.ok, true, "上限内的条目应当命中索引并下到歌词");
  assert.match(newest.data.text, /最新一条/);
  assert.equal(
    calls.some((call) => call.url.includes("/api/playback")),
    false,
    "命中索引就不该问播放端点",
  );

  const evicted = await api.getLyrics({ trackId: "s1" });
  assert.equal(evicted.ok, false, "s1 已被淘汰：只剩播放响应那条路（那里没有歌词）");
  assert.equal(evicted.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.equal(
    calls.some((call) => call.url.endsWith("/s1.lrc")),
    false,
    "被淘汰的地址不该再被下载（否则上限就是摆设）",
  );
  assert.equal(
    calls.some((call) => call.url.includes("/api/playback")),
    true,
    "淘汰后如实回落播放响应，而不是凭空变出歌词",
  );
});

test("HTTP/网络失败：结构化错误，且绝不把响应体整段当消息回显", async () => {
  const http = scriptedFetch(() => jsonResponse({ message: "内部堆栈 SECRET-STACK" }, 502));
  const httpResult = await apiOf({ fetchImpl: http.fetchImpl }).listFavoritesPage();
  assert.equal(httpResult.ok, false);
  assert.equal(httpResult.error.kind, MUSIC_ERROR_KINDS.httpError);
  assert.match(httpResult.error.message, /502/);
  assert.doesNotMatch(httpResult.error.message, /SECRET-STACK/);

  const network = scriptedFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const networkResult = await apiOf({ fetchImpl: network.fetchImpl }).listFavoritesPage();
  assert.equal(networkResult.ok, false);
  assert.equal(networkResult.error.kind, MUSIC_ERROR_KINDS.networkError);
  assert.match(networkResult.error.message, /ENOTFOUND/);

  const business = scriptedFetch(() => jsonResponse({ result: { resultCode: "990000" } }));
  const businessResult = await apiOf({ fetchImpl: business.fetchImpl }).listFavoritesPage();
  assert.equal(businessResult.ok, false);
  assert.equal(businessResult.error.kind, MUSIC_ERROR_KINDS.apiError);
});

test("music.mjs 只登记路径形状，不含任何域名与凭据字面量", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../src/protocols/music.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /https?:\/\//, "端点只能来自注入（绝对 URL 的默认值住在 src/main/music-service.mjs）");
  assert.doesNotMatch(source, /dbankcdn|tingmall|kuke/i, "CDN 白名单只许出现在 safe-media-url.mjs");
});

// —— R41：歌词的六跳编排（本地 → 内存 → 磁盘 → 华为四档 → 第三方 → invalid_response） ---------

const CACHED_TEXT = "[00:01.00]磁盘缓存里的词\n";
const LOCAL_TEXT = "[00:01.00]我自己导入的词";
const THIRD_TEXT = "[00:01.00]第三方来的词\n";

/** 一个记账用的内存缓存端口（形状与 src/main/lyrics-cache.mjs 的产物一致）。 */
function stubCache({ local = null, cached = null } = {}) {
  const writes = [];
  const clears = [];
  return {
    writes,
    clears,
    readLocal: async (trackId) => (local === null ? null : { doc: { text: LOCAL_TEXT, format: "lrc", source: "local" }, fileName: "我的.lrc", importedAt: 7, ...(local[trackId] ?? {}) }),
    readCached: async () => (cached === null ? null : { text: CACHED_TEXT, format: "lrc", source: "huawei" }),
    writeCached: async (trackId, doc) => {
      writes.push({ trackId, doc });
      return { written: true };
    },
    writeLocal: async () => ({ written: true, doc: { text: LOCAL_TEXT, format: "lrc", source: "local" } }),
    info: async () => ({ available: true, bytes: 10, entries: 1, localBytes: 20, localEntries: 2 }),
    clear: async (options) => {
      clears.push(options);
      return { available: true, bytes: 0, entries: 0, localBytes: options.local === true ? 0 : 20, localEntries: options.local === true ? 0 : 2 };
    },
  };
}

/** 华为侧取不到歌词的 fetch：播放响应既没有地址也没有内嵌歌词（也没有专辑 id） */
const missFetch = () =>
  scriptedFetch((url) => {
    if (url.includes("/api/playback")) return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3" }));
    throw new Error(`不该请求：${url}`);
  });

test("歌词（R41）：本地导入压过一切——命中本地就一次网络请求都不发", async () => {
  const { calls, fetchImpl } = missFetch();
  const cache = stubCache({ local: { s9: {} } });
  const api = apiOf({ fetchImpl, api: { lyricsCache: cache, lyricsFallback: async () => ({ text: THIRD_TEXT, source: "kugou" }) } });

  const lyrics = await api.getLyrics({ trackId: "s9", title: "歌" });
  assert.equal(lyrics.ok, true);
  assert.equal(lyrics.data.text, "[00:01.00]我自己导入的词");
  assert.equal(lyrics.data.source, "local");
  assert.equal(lyrics.data.fileName, "我的.lrc", "本地导入带上文件名（用户要认得出是哪一份）");
  assert.deepEqual(calls, [], "本地命中就该短路——在线那几跳一次都不走");
});

test("歌词（R41）：内存缓存在磁盘之前命中（同一个进程里取第二次不打磁盘）", async () => {
  const { fetchImpl } = missFetch();
  let reads = 0;
  const cache = {
    readLocal: async () => null,
    readCached: async () => {
      reads += 1;
      return { text: CACHED_TEXT, format: "lrc", source: "huawei" };
    },
    writeCached: async () => ({ written: true }),
  };
  const api = apiOf({ fetchImpl, api: { lyricsCache: cache } });

  const first = await api.getLyrics({ trackId: "s9" });
  assert.equal(first.data.cached, "disk", "第一次是磁盘命中");
  const second = await api.getLyrics({ trackId: "s9" });
  assert.equal(second.data.text, CACHED_TEXT);
  assert.equal(second.data.cached, "memory", "第二次起走内存（磁盘读只发生一次）");
  assert.equal(reads, 1, `磁盘只被读了一次：${reads}`);
});

test("歌词（R41）：磁盘缓存在华为那条链之前命中——命中就不打业务接口", async () => {
  const { calls, fetchImpl } = missFetch();
  const api = apiOf({ fetchImpl, api: { lyricsCache: stubCache({ cached: true }) } });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.data.text, CACHED_TEXT);
  assert.equal(lyrics.data.cached, "disk");
  assert.equal(lyrics.data.source, "huawei", "来源仍是它当初被取回来的那个来源");
  assert.deepEqual(calls, [], "缓存命中不该再发请求");
});

test("歌词（R41）：华为四档命中 → 写内存 + 写磁盘，并注明 source:huawei", async () => {
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", lyricAddress: "https://cdn.dbankcdn.cn/s9.lrc" } }));
    }
    if (url.endsWith("/s9.lrc")) return new Response("[00:01.00]华为给的词", { status: 200 });
    throw new Error(`不该请求：${url}`);
  });
  const cache = stubCache();
  const api = apiOf({ fetchImpl, api: { lyricsCache: cache } });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, true);
  assert.equal(lyrics.data.source, "huawei");
  assert.match(lyrics.data.text, /华为给的词/);
  assert.equal(cache.writes.length, 1, "命中之后写了一次磁盘");
  assert.equal(cache.writes[0].trackId, "s9");
  assert.equal(cache.writes[0].doc.source, "huawei");
});

test("歌词（R41）：华为全落空 + 有标题 → 第三方回退命中，记 source 并写缓存", async () => {
  const { fetchImpl } = missFetch();
  const cache = stubCache();
  const queries = [];
  const api = apiOf({
    fetchImpl,
    api: {
      lyricsCache: cache,
      lyricsFallback: async (query) => {
        queries.push(query);
        return { text: THIRD_TEXT, source: "lrclib", matchedTitle: "歌", matchedArtist: "艺人" };
      },
    },
  });

  const lyrics = await api.getLyrics({ trackId: "s9", title: "歌", artist: "艺人", durationSeconds: 200 });
  assert.equal(lyrics.ok, true);
  assert.equal(lyrics.data.source, "lrclib");
  assert.equal(lyrics.data.matchedTitle, "歌");
  assert.deepEqual(queries, [{ title: "歌", artist: "艺人", durationSeconds: 200 }], "元信息原样交给匹配器");
  assert.equal(cache.writes[0].doc.source, "lrclib", "第三方命中也落盘（下次不必再搜）");
});

test("歌词（R41）：没有标题就不试第三方（盲搜不算机会），如实回华为那次的失败", async () => {
  const { fetchImpl } = missFetch();
  let asked = 0;
  const api = apiOf({
    fetchImpl,
    api: {
      lyricsFallback: async () => {
        asked += 1;
        return { text: THIRD_TEXT, source: "kugou" };
      },
    },
  });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse, "回的是华为那次的失败（不是笼统的『没有歌词』）");
  assert.equal(asked, 0, "没有标题时第三方端口一次都不该被调");
});

test("歌词（R41a）：既没有艺人、也没有可用时长就**不发请求**（匹配器的最高分必然不过门槛）", async () => {
  const { fetchImpl } = missFetch();
  const logs = [];
  let asked = 0;
  const api = apiOf({
    fetchImpl,
    api: {
      log: (line) => logs.push(line),
      lyricsFallback: async () => {
        asked += 1;
        return { text: THIRD_TEXT, source: "kugou" };
      },
    },
  });

  // 只有标题：艺人没有、时长也没有 → 最高分是"标题精确"那 1.3 < MIN_SCORE 1.5。
  // 结果是注定的，代价却是两个服务各一次往返 + 各 8 秒超时（最坏 16 秒），所以干脆不问。
  const bare = await api.getLyrics({ trackId: "s9", title: "歌" });
  assert.equal(bare.ok, false);
  assert.equal(bare.error.kind, MUSIC_ERROR_KINDS.invalidResponse, "照旧回华为那次的失败（不是笼统的『没有歌词』）");
  assert.equal(asked, 0, "一次都不该问");
  assert.ok(
    logs.some((line) => line.includes("第三方歌词回退跳过")),
    `跳过要留一行痕（不然"这次为什么没试第三方"没人说得清）：${JSON.stringify(logs)}`,
  );

  // 时长 ≤ 30 秒不构成佐证（`scoreCandidate` 只认"两边都 > 30 秒"的样本）→ 与"没有时长"同档
  await api.getLyrics({ trackId: "s9", title: "歌", durationSeconds: 25 });
  assert.equal(asked, 0, "太短的时长不算佐证，同样不问");

  // 但"只有艺人"（标题精确 1.3 + 艺人宽松 0.6 = 1.9）与"只有可用时长"（1.3 + 0.6）都能过门槛：
  // 短路条件只在这一种组合上，不是"三个值必须齐全"
  const withArtist = await api.getLyrics({ trackId: "s9", title: "歌", artist: "艺人" });
  assert.equal(withArtist.ok, true);
  assert.equal(asked, 1, "有艺人就照旧试（换成别的曲目 id：内存缓存会短路同一首的第二次）");
  const withDuration = await api.getLyrics({ trackId: "s9b", title: "歌", durationSeconds: 200 });
  assert.equal(withDuration.ok, true);
  assert.equal(asked, 2, "有可用时长也照旧试");
});

test("歌词（R41）：第三方也没命中 → 回华为那次的失败；失败不写缓存", async () => {
  const { fetchImpl } = missFetch();
  const cache = stubCache();
  const api = apiOf({
    fetchImpl,
    api: { lyricsCache: cache, lyricsFallback: async () => null },
  });

  const lyrics = await api.getLyrics({ trackId: "s9", title: "歌" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.deepEqual(cache.writes, [], "没有歌词就绝不落盘（『没歌词』必须能被下一次尝试推翻）");
});

test("歌词（R41）：第三方端口抛错不影响这条链（静默回华为那次的失败）", async () => {
  const { fetchImpl } = missFetch();
  const logs = [];
  const api = apiOf({
    fetchImpl,
    api: {
      log: (line) => logs.push(line),
      lyricsFallback: async () => {
        throw new Error("第三方库挂了");
      },
    },
  });
  // 带上艺人：这一条钉的是"端口抛错"（R41a 之后，只有标题+无可用时长的曲目根本不会问端口）
  const lyrics = await api.getLyrics({ trackId: "s9", title: "歌", artist: "艺人" });
  assert.equal(lyrics.ok, false);
  assert.equal(lyrics.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.ok(logs.some((line) => line.includes("第三方歌词回退失败")), JSON.stringify(logs));
});

test("歌词（R41）：缓存端口抛错 / 坏形状 → 当作没命中，照旧走在线那条路（缓存不该挡路）", async () => {
  const { fetchImpl, calls } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", lyricAddress: "https://cdn.dbankcdn.cn/s9.lrc" } }));
    }
    if (url.endsWith("/s9.lrc")) return new Response("[00:01.00]华为给的词", { status: 200 });
    throw new Error(`不该请求：${url}`);
  });
  const broken = {
    readLocal: async () => {
      throw new Error("本地目录读不动");
    },
    readCached: async () => ({ text: "" }),
    writeCached: async () => {
      throw new Error("磁盘写不动");
    },
  };
  const logs = [];
  const api = apiOf({ fetchImpl, api: { lyricsCache: broken, log: (line) => logs.push(line) } });

  const lyrics = await api.getLyrics({ trackId: "s9" });
  assert.equal(lyrics.ok, true, "缓存坏了不该让取词失败");
  assert.match(lyrics.data.text, /华为给的词/);
  assert.ok(calls.some((call) => call.url.includes("/api/playback")));
  assert.equal(logs.length, 2, `两条都要留痕（本地读失败 + 写盘失败）：${JSON.stringify(logs)}`);
});

test("歌词（R41）：内存缓存有上限（FIFO）——超限时最旧一条被淘汰", async () => {
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      const id = new URL(url).searchParams.get("contentCode");
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: id, lyricAddress: `https://cdn.dbankcdn.cn/${id}.lrc` } }));
    }
    return new Response(`[00:01.00]词 ${new URL(url).pathname}`, { status: 200 });
  });
  let reads = 0;
  const cache = {
    readLocal: async () => null,
    readCached: async () => {
      reads += 1;
      return null;
    },
    writeCached: async () => ({ written: true }),
  };
  const api = apiOf({ fetchImpl, api: { lyricsCache: cache, lyricMemoryLimit: 2 } });

  await api.getLyrics({ trackId: "s1" });
  await api.getLyrics({ trackId: "s2" });
  await api.getLyrics({ trackId: "s3" });
  await api.getLyrics({ trackId: "s1" }); // s1 已被淘汰 → 这一次要重新走在线那条路
  assert.equal((await api.getLyrics({ trackId: "s3" })).data?.cached, "memory", "最新的那条在内存里");
  assert.equal((await api.getLyrics({ trackId: "s1" })).data?.cached, "memory", "s1 被重新取过，又在内存里了");
  assert.equal(reads, 4, `内存上限 2 → 六次取词里只有四次穿透到磁盘：${reads}`);
});

test("歌词（R41）：importLyrics 写本地 + 立刻进内存 + 没有缓存端口时如实报 cache_unavailable", async () => {
  const cache = stubCache();
  const api = apiOf({ api: { lyricsCache: cache } });
  const imported = await api.importLyrics({ trackId: "s9", text: "[00:01.00]导入的词", fileName: "我的.lrc" });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.source, "local");
  assert.equal(imported.data.fileName, "我的.lrc");

  // 导入之后再取词：命中本地那一条（端口给的是固定文本，这里只验链路真的短路过）
  const again = await api.getLyrics({ trackId: "s9" });
  assert.equal(again.data.source, "local");

  // 参数校验
  assert.equal((await api.importLyrics({ text: "x" })).error.kind, MUSIC_ERROR_KINDS.missingParam);
  assert.equal((await api.importLyrics({ trackId: "s9", text: "   " })).error.kind, MUSIC_ERROR_KINDS.invalidResponse);

  // 端口写失败（坏文本）：kind 映射成 invalid_response，并且把原因带上
  const rejecting = apiOf({
    api: {
      lyricsCache: {
        writeLocal: async () => {
          const error = new Error("这段文本不是可用的歌词");
          error.kind = "invalid_payload";
          throw error;
        },
      },
    },
  });
  const bad = await rejecting.importLyrics({ trackId: "s9", text: "无时间戳" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, MUSIC_ERROR_KINDS.invalidResponse);
  assert.match(bad.error.message, /不是可用的歌词/);

  // 根本没有缓存端口（没有数据目录）：如实报"存不下来"，不假装成功
  const noCache = apiOf({});
  const unavailable = await noCache.importLyrics({ trackId: "s9", text: "[00:01.00]词" });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.kind, MUSIC_ERROR_KINDS.cacheUnavailable);
});

test("歌词（R41）：lyricsCacheInfo / clearLyricsCache——清了在线缓存会顺手清内存，但留下本地那几首", async () => {
  const cache = stubCache();
  const { fetchImpl } = scriptedFetch((url) => {
    if (url.includes("/api/playback")) {
      return jsonResponse(okBody({ fileURL: "https://cdn.dbankcdn.cn/a.mp3", songInfo: { contentID: "s9", lyricAddress: "https://cdn.dbankcdn.cn/s9.lrc" } }));
    }
    return new Response("[00:01.00]华为给的词", { status: 200 });
  });
  const api = apiOf({ fetchImpl, api: { lyricsCache: cache } });

  assert.deepEqual(await api.lyricsCacheInfo(), { ok: true, data: { available: true, bytes: 10, entries: 1, localBytes: 20, localEntries: 2 } });

  // 先取一次词把内存填上，再清（默认只清在线缓存）
  await api.getLyrics({ trackId: "s9" });
  const cleared = await api.clearLyricsCache({});
  assert.equal(cleared.ok, true);
  assert.deepEqual(cache.clears, [{ local: false }]);
  assert.equal((await api.getLyrics({ trackId: "s9" })).data?.cached, undefined, "内存里那一份也清了（否则用户以为清除没生效）");

  const withLocal = await api.clearLyricsCache({ local: true });
  assert.equal(withLocal.ok, true);
  assert.deepEqual(cache.clears[1], { local: true });

  // 没有端口时：两个方法都如实报不可用，不假装成功
  const none = apiOf({});
  assert.deepEqual((await none.lyricsCacheInfo()).data, { available: false, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 });
  assert.equal((await none.clearLyricsCache({})).error.kind, MUSIC_ERROR_KINDS.cacheUnavailable);
});
