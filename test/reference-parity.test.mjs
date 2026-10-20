/**
 * R32 协议层差分测试：**以参考实现为契约**逐字段比对。
 *
 * 契约来源：公开仓库 `talongao/huawei-music-desktop`（克隆在 `.tmp/reference-repo/`，只读）——
 * 它的 `src/auth.mjs` / `src/music.mjs` / `src/main/{library,track-quality,lyric-resource}.mjs`
 * 是"授权 → 兑换 → 音乐会话 → 收藏/歌单/搜索/播放"这条链**实测走通过**的那一份。
 *
 * 两段断言，缺一不可：
 *
 * 1. **内嵌事实表**（永远跑）：把参考里那些**关键串**固化成期望值，逐条对我们代码里的常量。
 *    它不依赖 `.tmp/` 是否存在——所以 CI/别的机器上这段同样有效，而且**改动必须同步改这里**
 *    （"悄悄放宽协议"会立刻红）。
 * 2. **源码差分**（参考仓库在场时才跑）：直接读参考源码，把它的端点字面量、方法、参数名、
 *    响应容器名、Digest 头形状抽出来，与我们的一一比对。参考仓库不在时**如实跳过**
 *    （`t.skip` + 原因），不假装验过。
 *
 * 参考仓库是**只读**的：本文件只 `readFile`，一个字节都不写。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { HUAWEI_OAUTH_ENDPOINTS } from "../src/main/auth-manager.ts";
import { MUSIC_BASE_ENDPOINT, MUSIC_ENDPOINT_DEFAULTS } from "../src/main/music-service.mjs";
import { MUSIC_SESSION_DIGEST_USERNAME, buildMusicDigestHeader } from "../src/main/music-session.mjs";
import {
  OAUTH_CLIENT_ID,
  OAUTH_COUNTRY_CODE,
  OAUTH_REDIRECT_URI,
  OAUTH_UI_LOCALES,
} from "../src/protocols/auth.mjs";
import { LOGIN_ALLOWED_ORIGINS, LOGIN_ALLOWED_URLS } from "../src/protocols/login-callback.mjs";
import {
  LIST_CONTAINER_KEYS,
  MUSIC_BUSINESS_OK,
  MUSIC_ENDPOINT_KEYS,
  MUSIC_ENDPOINT_METHODS,
  MUSIC_ENDPOINT_PATHS,
  MUSIC_LIBRARY_CONTENT_TYPES,
  MUSIC_QUALITY_TYPES,
  MUSIC_SONG_CONTENT_TYPES,
  confirmedPlaybackQuality,
  lyricAddressOf,
} from "../src/protocols/music.mjs";

/**
 * 参考实现里的关键事实（**逐字**）。
 * 出处：`.tmp/reference-repo/src/auth.mjs`、`src/music.mjs`、`src/main/library.mjs`、
 * `src/main/track-quality.mjs`、`src/main/lyric-resource.mjs`、`docs/API_CONTRACT.md`（2026-10-14 核验）。
 */
const REFERENCE = {
  authorize: "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize",
  token: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
  musicBase: "https://api-drcn.music.dbankcloud.cn",
  clientId: "101444301",
  redirectUri: "hms://redirect_uri",
  loginHosts: [
    "oauth-login.platform.hicloud.com",
    "id1.cloud.huawei.com",
    "oauth-login.cloud.huawei.com",
    "account.huawei.com",
    "consumer.huawei.com",
  ],
  regionalCallbackHost: "oauth-login1.cloud.huawei.com",
  regionalCallbackPath: "/oauth2/v3/loginCallback",
  digestUsername: "app-music-baseline",
  businessOk: "000000",
  paths: {
    favorites: "/music-userbehavior-service/v3/service/favorite/simple/all",
    playlistList: "/music-userbehavior-service/v3/service/favorite/simple/all",
    playlistDetail: "/music-userbehavior-service/v1/service/playlist/detail/all",
    playlistDetailPublic: "/music-operation-service/v2/service/musiclist/detail/bymusiclistid",
    playlistDelete: "/music-userbehavior-service/v1/service/playlist/delete",
    search: "/music-search-service/v10/service/fuzzysearch",
    album: "/music-metacontent-service/v1/service/album/detail/byalbumcode",
    artist: "/music-metacontent-service/v2/service/artist/detail/byartistcode",
    history: "/music-userbehavior-service/v1/service/recentlyplayed/query",
    playback: "/music-play-service/v3/service/file/bycontentcode",
  },
  /** 参考里显式写了 `method:'GET'` 的那些（其余默认 POST）。 */
  getPaths: [
    "/music-userbehavior-service/v1/service/playlist/detail/all",
    "/music-userbehavior-service/v1/service/recentlyplayed/query",
    "/music-metacontent-service/v1/service/album/detail/byalbumcode",
  ],
  /**
   * 参考有、我们**故意没接**的路径（写操作与"每日推荐"）。
   * 列出来是为了让"参考新增了一条路径而我们没跟上"能被这条差分抓住——
   * 未列出的新路径会让测试红，而不是悄悄溜过去。
   */
  notImplementedPaths: [
    "/music-userbehavior-service/v1/service/favorite/simple/exist",
    "/music-userbehavior-service/v1/service/favorite/create",
    "/music-userbehavior-service/v1/service/favorite/delete",
    "/music-userbehavior-service/v1/service/playlist/create",
    "/music-userbehavior-service/v1/service/playlist/update",
    "/music-userbehavior-service/v1/service/recentlyplayed/create",
  ],
  /** 每个端点请求体里的参数名（参考的调用点逐字）。 */
  params: {
    favorites: ["targetSnsUserID", "start", "limit", "contentTypes"],
    playlistList: ["targetSnsUserID", "start", "limit", "contentTypes"],
    playlistDetail: ["start", "limit", "playListID"],
    playlistDetailPublic: ["musicListID", "copyrightSwitch", "start", "limit"],
    playlistDelete: ["playListID"],
    search: ["contentType", "correct", "queryWord", "start", "limit"],
    album: ["albumCode", "start", "limit"],
    artist: ["artistCode", "songNum", "albumNum"],
    history: ["contentType"],
    playback: ["contentCode", "contentType", "qualityType"],
  },
  contentTypes: { song: ["1"], library: ["1", "4", "5", "7"] },
  quality: { standard: "1", lossless: "3" },
  /** 列表容器（必须是 `LIST_CONTAINER_KEYS` 的条目）。 */
  listContainers: ["favoriteInfos", "songSimpleInfos", "contentSimpleInfos"],
  /** 响应信封（是对象不是数组，所以走 `pickPath` 而不是容器候选表）。 */
  responseEnvelopes: ["playListInfoEx", "musicListInfoEx"],
  /** 播放列表内的数组字段（嵌套在信封里）。 */
  nestedLists: ["playListSongInfoList", "songSimpleInfos"],
  lyricAddressFields: ["lyricAddress", "lyricAddres", "lineByLineLyric"],
};

const REFERENCE_ROOT = new URL("../.tmp/reference-repo/", import.meta.url);
const referenceFile = (relative) => new URL(relative, REFERENCE_ROOT);
const hasReference = existsSync(referenceFile("src/auth.mjs")) && existsSync(referenceFile("src/music.mjs"));
const readReference = (relative) => readFileSync(referenceFile(relative), "utf8");

// ---------------------------------------------------------------------------
// 1. 内嵌事实表：永远跑（不依赖 .tmp/）
// ---------------------------------------------------------------------------

test("协议事实：授权/兑换/业务域就是参考实测的那三条", () => {
  assert.equal(HUAWEI_OAUTH_ENDPOINTS.authorize, REFERENCE.authorize);
  assert.equal(HUAWEI_OAUTH_ENDPOINTS.token, REFERENCE.token);
  assert.equal(MUSIC_BASE_ENDPOINT, REFERENCE.musicBase);
  assert.equal(OAUTH_CLIENT_ID, REFERENCE.clientId);
  assert.equal(OAUTH_REDIRECT_URI, REFERENCE.redirectUri);
  assert.equal(MUSIC_BUSINESS_OK, REFERENCE.businessOk);
  assert.equal(MUSIC_SESSION_DIGEST_USERNAME, REFERENCE.digestUsername);
});

test("协议事实：授权页的地区/语言参数（参考实测那两个）", () => {
  assert.equal(OAUTH_COUNTRY_CODE, "cn");
  assert.equal(OAUTH_UI_LOCALES, "zh-cn");
});

test("协议事实：导航白名单 = 参考的五个主机 + regional callback 精确例外", () => {
  assert.deepEqual(
    [...LOGIN_ALLOWED_ORIGINS].sort(),
    REFERENCE.loginHosts.map((host) => `https://${host}`).sort(),
    "白名单条目必须逐字等于参考的 LOGIN_HOSTS（多一条少一条都要在这里说清楚）",
  );
  assert.deepEqual(LOGIN_ALLOWED_URLS, [`https://${REFERENCE.regionalCallbackHost}${REFERENCE.regionalCallbackPath}`]);
});

test("协议事实：每个端点的路径与方法（键集合也要一致，`lyrics` 是唯一没有独立端点的键）", () => {
  for (const [key, path] of Object.entries(REFERENCE.paths)) {
    assert.equal(MUSIC_ENDPOINT_PATHS[key], path, `${key} 的路径`);
    const expectedMethod = REFERENCE.getPaths.includes(path) ? "GET" : "POST";
    assert.equal(MUSIC_ENDPOINT_METHODS[key], expectedMethod, `${key} 的方法`);
  }
  const withPaths = MUSIC_ENDPOINT_KEYS.filter((key) => MUSIC_ENDPOINT_PATHS[key] !== null);
  assert.deepEqual([...withPaths].sort(), Object.keys(REFERENCE.paths).sort(), "有端点的键集合");
  assert.equal(MUSIC_ENDPOINT_PATHS.lyrics, null, "参考没有独立歌词端点 → 歌词从播放响应推导");
});
test("协议事实：默认端点表 = 业务域 + 参考路径（一个不多、一个不少）", () => {
  const expected = Object.fromEntries(
    Object.entries(REFERENCE.paths).map(([key, path]) => [key, `${REFERENCE.musicBase}${path}`]),
  );
  assert.deepEqual(MUSIC_ENDPOINT_DEFAULTS, expected);
});

test("协议事实：收藏/歌单发现的内容类型与音质码", () => {
  assert.deepEqual(MUSIC_SONG_CONTENT_TYPES, REFERENCE.contentTypes.song);
  assert.deepEqual(MUSIC_LIBRARY_CONTENT_TYPES, REFERENCE.contentTypes.library);
  assert.deepEqual(MUSIC_QUALITY_TYPES, REFERENCE.quality);
  assert.equal(confirmedPlaybackQuality("1", "mp3"), "standard");
  assert.equal(confirmedPlaybackQuality("3", "flac"), "lossless");
  assert.equal(confirmedPlaybackQuality("3", "mp3"), "unknown", "声明与返回对不上就不虚标");
});

test("协议事实：响应容器名至少覆盖参考用到的那些", () => {
  for (const container of [...REFERENCE.listContainers, ...REFERENCE.nestedLists]) {
    assert.ok(LIST_CONTAINER_KEYS.includes(container), `列表容器候选里要有 ${container}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 源码差分：参考仓库在场时才跑
// ---------------------------------------------------------------------------

test("差分（源码）：auth.mjs 的端点与客户端常量逐字一致", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  const source = readReference("src/auth.mjs");

  for (const literal of [REFERENCE.authorize, REFERENCE.token, REFERENCE.musicBase, REFERENCE.redirectUri]) {
    assert.ok(source.includes(`'${literal}'`) || source.includes(`"${literal}"`), `参考源码里没有 ${literal}`);
  }
  for (const host of REFERENCE.loginHosts) {
    assert.ok(source.includes(`'${host}'`), `参考的 LOGIN_HOSTS 里没有 ${host}`);
  }
  assert.ok(source.includes(REFERENCE.regionalCallbackHost), "参考的 regional callback 主机");
  assert.ok(source.includes(REFERENCE.regionalCallbackPath), "参考的 regional callback 路径");
  assert.ok(source.includes(REFERENCE.digestUsername), "参考的 Digest username");
  assert.ok(source.includes(REFERENCE.businessOk), "参考的业务成功码");
  assert.match(source, /countryCode:\s*'cn'/, "参考的授权页参数 countryCode");
  assert.match(source, /ui_locales:\s*'zh-cn'/, "参考的授权页参数 ui_locales");
  assert.match(source, /grant_type:\s*'authorization_code'/, "参考的授权码兑换 grant");
  assert.match(source, /grant_type:\s*'refresh_token'/, "参考的刷新 grant");
});

test("差分（源码）：music.mjs 的每条路径与方法都在我们表里（且方法一致）", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  const source = readReference("src/music.mjs");

  const referencePaths = new Set([...source.matchAll(/'(?<path>\/music-[a-z0-9/-]+)'/g)].map((match) => match.groups.path));
  assert.ok(referencePaths.size >= 10, `参考里的业务路径太少（${referencePaths.size}），解析规则可能过期了`);

  // 参考里 `method:'GET'` 的那些（用于逐键核对我们登记的方法）
  const referenceGet = new Set(
    [...source.matchAll(/'(?<path>\/music-[a-z0-9/-]+)'[\s\S]{0,160}?method:\s*'GET'/g)].map((match) => match.groups.path),
  );

  // 正向：我们接的每条路径都真的在参考里，且方法一致
  for (const [key, path] of Object.entries(REFERENCE.paths)) {
    assert.ok(referencePaths.has(path), `参考源码里没有这条路径：${path}`);
    assert.equal(MUSIC_ENDPOINT_METHODS[key], referenceGet.has(path) ? "GET" : "POST", `${key} 的方法`);
  }

  // 反向：参考里剩下的路径只许是"我们故意没接"的那批（新出现的路径会让这条红）
  const ours = new Set(Object.values(MUSIC_ENDPOINT_PATHS).filter((path) => path !== null));
  const unaccounted = [...referencePaths].filter(
    (path) => !ours.has(path) && !REFERENCE.notImplementedPaths.includes(path),
  );
  assert.deepEqual(unaccounted, [], `参考有这些路径，我们既没接也没登记为「故意没接」：${unaccounted.join(", ")}`);
});

test("差分（源码）：每个端点的参数名逐个对得上（含位置：POST 体 / GET 查询串）", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  const source = readReference("src/music.mjs");

  for (const [key, params] of Object.entries(REFERENCE.params)) {
    const path = REFERENCE.paths[key];
    const at = source.indexOf(`'${path}'`);
    assert.ok(at > -1, `参考源码里没有 ${path}`);
    // 取路径之后的一段（到下一个端点调用为止），参数名必须都在这一窗里
    const window = source.slice(at, at + 400);
    for (const param of params) {
      assert.ok(window.includes(param), `${key}（${path}）的请求里没有参数 ${param}`);
    }
  }
});

test("差分（源码）：响应容器名与歌词字段名逐字一致", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  const library = existsSync(referenceFile("src/main/library.mjs")) ? readReference("src/main/library.mjs") : "";
  const lyrics = existsSync(referenceFile("src/main/lyric-resource.mjs")) ? readReference("src/main/lyric-resource.mjs") : "";
  const huawei = existsSync(referenceFile("src/main/huawei.ts")) ? readReference("src/main/huawei.ts") : "";

  for (const container of [...REFERENCE.listContainers, ...REFERENCE.responseEnvelopes]) {
    assert.ok(
      library.includes(container) || huawei.includes(container),
      `参考的响应处理里没有容器 ${container}`,
    );
  }
  for (const field of REFERENCE.lyricAddressFields) {
    assert.ok(lyrics.includes(field), `参考的歌词地址字段清单里没有 ${field}`);
  }
  // 歌词地址必须过 CDN 白名单（两边同一条纪律）
  assert.match(lyrics, /isSafeResourceUrl/, "参考的歌词地址要过 CDN 白名单");
});

test("差分（源码）：Digest 头的形状两边一致（username/nonce/created[/token]）", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  const source = readReference("src/auth.mjs");
  assert.ok(
    source.includes("Digest username=app-music-baseline, nonce=${nonce}, created=${created}"),
    "参考的 Digest 头形状（本测试的解析目标）：username/nonce/created 三段，token 段可选",
  );
  assert.match(source, /token \? `, token=\$\{token\}` : ''/, "参考只在有 token 时追加 token 段");

  const head = buildMusicDigestHeader({ nonce: "N", created: "2026-10-21T00:00:00Z" });
  const withToken = buildMusicDigestHeader({ nonce: "N", created: "2026-10-21T00:00:00Z", token: "T" });
  const shape = /^Digest username=([^,]+), nonce=([^,]+), created=([^,]+?)(, token=(.+))?$/;
  const parsed = shape.exec(head);
  assert.ok(parsed, `我们的 Digest 头形状与参考不同：${head}`);
  assert.equal(parsed[1], REFERENCE.digestUsername);
  assert.equal(parsed[4], undefined, "无 token 调用**不带** token 段（参考：无音乐会话就不加）");
  assert.equal(shape.exec(withToken)[4], ", token=T", "带音乐会话时追加 token 段");
});

test("差分（源码）：参考的轨迹里没有我们缺的容器/字段（歌词地址只认白名单内的）", (t) => {
  if (!hasReference) return t.skip("参考仓库不在（.tmp/reference-repo/）：按缺席跳过，不假装验过");
  // 歌词地址：白名单外的地址不认（与参考的 isSafeResourceUrl 同一判据）
  assert.equal(lyricAddressOf({ lyricAddress: "https://cdn.dbankcdn.cn/a.lrc" }), "https://cdn.dbankcdn.cn/a.lrc");
  assert.equal(lyricAddressOf({ lyricAddress: "https://evil.example.com/a.lrc" }), null);
});
