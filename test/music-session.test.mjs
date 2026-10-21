/**
 * R17/C：音乐会话兑换（loginex）端口的形状与纪律。
 *
 * 这一层的证据分两级，测试也按这两级分开钉：
 * - **本机实测过**的：端点存在性（405/POST-only，对照路径 404）、无效 AT 回 200 + 业务码。
 *   这些体现在"端口真的会 POST 到那个 URL、并把业务码当结论"上；
 * - **只有公开证据**的：请求体 `{accessToken}`、Digest 头形状、成功响应字段。
 *   这些用假 fetch 钉形状——**不碰真网络**（真会话兑换要用户授权扫码）。
 *
 * 全程不碰网络、不碰时钟、不碰随机源：三样都是注入的。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  HUAWEI_MUSIC_BASE,
  HUAWEI_MUSIC_LOGINEX_ENDPOINT,
  HUAWEI_MUSIC_LOGINEX_PATH,
  MUSIC_BUSINESS_OK,
  MUSIC_PROFILE_CLAIM_AVATAR_KEYS,
  MUSIC_PROFILE_CLAIM_NAME_KEYS,
  MUSIC_PROFILE_NESTED_CONTAINER_KEYS,
  MUSIC_SESSION_DIGEST_USERNAME,
  MUSIC_SESSION_ERROR_KINDS,
  attachClaimProfile,
  buildMusicDigestHeader,
  createHuaweiMusicSessionPort,
  digestCreatedAt,
  mergeProfiles,
  nestedContainerKeyNamesOf,
  parseMusicSessionResponse,
  profileFromClaims,
  profileFromResponse,
  profileOfSessionRecord,
  topLevelKeysOf,
} from "../src/main/music-session.mjs";

const AT = "AT-SECRET-VALUE";
const MUSIC_TOKEN = "user$SECRET-TOKEN";

/** 假 fetch：记录调用并回一个可控响应。 */
function fakeFetch({ status = 200, body = "", throwError = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throwError !== null) throw throwError;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { impl, calls };
}

function portOf(options) {
  return createHuaweiMusicSessionPort({
    fetchImpl: options.fetchImpl,
    random: () => Buffer.alloc(24, 7),
    now: () => new Date("2026-10-20T03:44:56.789Z"),
    ...(options.portOptions ?? {}),
  });
}

// —— 1. 端点常量（与公开证据逐字对齐） ------------------------------------------------

test("端点常量：业务域 + loginex 路径，拼出来的就是默认端点", () => {
  assert.equal(HUAWEI_MUSIC_BASE, "https://api-drcn.music.dbankcloud.cn");
  assert.equal(HUAWEI_MUSIC_LOGINEX_PATH, "/music-odpapp-service/v5/service/userinfo/loginex");
  assert.equal(HUAWEI_MUSIC_LOGINEX_ENDPOINT, `${HUAWEI_MUSIC_BASE}${HUAWEI_MUSIC_LOGINEX_PATH}`);
  assert.equal(MUSIC_BUSINESS_OK, "000000");
  assert.equal(MUSIC_SESSION_DIGEST_USERNAME, "app-music-baseline");
});

// —— 2. Digest 头形状 ----------------------------------------------------------------

test("Digest 头：固定 username、每请求 random nonce、created 是无毫秒 UTC ISO8601", () => {
  const header = buildMusicDigestHeader({ nonce: "N1", created: "2026-10-20T03:44:56Z" });
  assert.equal(header, "Digest username=app-music-baseline, nonce=N1, created=2026-10-20T03:44:56Z");
  assert.ok(!header.includes("token="), "loginex 这一步的 Digest 头**不带** token 段（契约明写）");
});

test("Digest 头：带音乐会话的调用才追加 token 段（契约里的另一半）", () => {
  const header = buildMusicDigestHeader({ nonce: "N2", created: "2026-10-20T03:44:56Z", token: "T-1" });
  assert.ok(header.endsWith(", token=T-1"), header);
});

test("Digest 头：created 必须是无毫秒的 UTC ISO8601（带毫秒/带偏移一律拒绝）", () => {
  for (const bad of [
    "2026-10-20T03:44:56.789Z",
    "2026-10-20T03:44:56+08:00",
    "2026-10-20 03:44:56Z",
    "2026-10-20T03:44:56",
    "",
  ]) {
    assert.throws(() => buildMusicDigestHeader({ nonce: "N", created: bad }), /created/, `应拒绝 ${bad}`);
  }
  assert.equal(buildMusicDigestHeader({ nonce: "N", created: "2026-10-20T03:44:56Z" }).includes("2026-10-20T03:44:56Z"), true);
});

test("Digest 头：nonce 不许为空；token 里的换行/逗号是头注入，必须拒绝", () => {
  assert.throws(() => buildMusicDigestHeader({ nonce: "", created: "2026-10-20T03:44:56Z" }), /nonce/);
  for (const bad of ["T\r\nX: y", "T,username=evil", "T\n"]) {
    assert.throws(
      () => buildMusicDigestHeader({ nonce: "N", created: "2026-10-20T03:44:56Z", token: bad }),
      /令牌/,
      `头注入必须被拦住：${JSON.stringify(bad)}`,
    );
  }
});

test("digestCreatedAt：Date → 无毫秒 UTC（毫秒被截掉而不是四舍五入）", () => {
  assert.equal(digestCreatedAt(new Date("2026-10-20T03:44:56.789Z")), "2026-10-20T03:44:56Z");
  assert.equal(digestCreatedAt(new Date("2026-10-20T03:44:59.999Z")), "2026-10-20T03:44:59Z");
});

// —— 3. 响应解析 ---------------------------------------------------------------------

test("响应解析：成功 → 本仓会话形状（token→musicSession、snsUserID→userId、expireTime 原样留）", () => {
  const result = parseMusicSessionResponse({
    result: { resultCode: MUSIC_BUSINESS_OK },
    token: MUSIC_TOKEN,
    snsUserID: "42",
    expireTime: "20261027120000",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, { musicSession: MUSIC_TOKEN, userId: "42", expireTime: "20261027120000" });
});

test("响应解析：**不**把 14 位 expireTime 换算成 expiresAt（时区未确认，宁可留原样）", () => {
  const result = parseMusicSessionResponse({
    result: { resultCode: MUSIC_BUSINESS_OK },
    token: MUSIC_TOKEN,
    expireTime: "20261027120000",
  });
  assert.equal(result.ok, true);
  assert.ok(!("expiresAt" in result.data), "时区未确认就不许造一个看起来精确的时间戳");
});

test("响应解析：业务码不是 000000 → 结构化失败，且错误里不含令牌", () => {
  const result = parseMusicSessionResponse({
    result: { resultCode: "990000", resultMessage: "System error!" },
    token: "SHOULD-NOT-APPEAR",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_SESSION_ERROR_KINDS.businessError);
  assert.match(result.error.message, /990000/);
  assert.ok(!result.error.message.includes("SHOULD-NOT-APPEAR"), "错误里不许回显令牌");
});

test("响应解析：缺 result / 缺 token / 非对象 → invalid_response（不猜成功）", () => {
  for (const payload of [{}, { token: MUSIC_TOKEN }, { result: { resultCode: MUSIC_BUSINESS_OK } }, null, "x", { result: {} }]) {
    const result = parseMusicSessionResponse(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error.kind, MUSIC_SESSION_ERROR_KINDS.invalidResponse, JSON.stringify(payload));
  }
});

test("响应解析：成功码但 token 是空串 → invalid_response（空令牌不算会话）", () => {
  const result = parseMusicSessionResponse({ result: { resultCode: MUSIC_BUSINESS_OK }, token: "   " });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, MUSIC_SESSION_ERROR_KINDS.invalidResponse);
});

// —— 3.5 profile（R38：名字/头像/VIP 只收认得出的，认不出不显示） ----------------------

test("profile：名字/头像/VIP 都取到 → 进会话记录（头像必须过 CDN 白名单）", () => {
  const result = parseMusicSessionResponse({
    result: { resultCode: MUSIC_BUSINESS_OK },
    token: MUSIC_TOKEN,
    snsUserID: "SNS-1",
    userName: "听歌的人",
    headUrl: "https://music-pics-drcn.dbankcdn.cn/avatar.jpg",
    memberShip: 6,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.profile, {
    userName: "听歌的人",
    avatarUrl: "https://music-pics-drcn.dbankcdn.cn/avatar.jpg",
    vip: true,
  });
});

test("profile：头像不在白名单 / 类型不对 / 空串一律不存（界面走兜底，不留碎图）", () => {
  const foreign = parseMusicSessionResponse({
    result: { resultCode: MUSIC_BUSINESS_OK },
    token: MUSIC_TOKEN,
    nickname: "名字",
    avatarUrl: "https://evil.example.com/a.jpg",
  });
  assert.equal(foreign.ok, true);
  assert.deepEqual(foreign.data.profile, { userName: "名字" }, "白名单外的头像不许进会话记录");

  for (const bad of [{ avatar: 42 }, { head: { url: "https://cdn.dbankcdn.cn/a.jpg" } }, { headUrl: "   " }]) {
    const result = parseMusicSessionResponse({ result: { resultCode: MUSIC_BUSINESS_OK }, token: MUSIC_TOKEN, ...bad });
    assert.equal(result.data.profile, undefined, `坏形状的头像不存：${JSON.stringify(bad)}`);
  }
});

test("profile：VIP 只认明确的布尔或有证据的数值（memberShip 含 6）；其余不猜", () => {
  const ok = (fields) => parseMusicSessionResponse({ result: { resultCode: MUSIC_BUSINESS_OK }, token: MUSIC_TOKEN, ...fields });

  assert.equal(ok({ vipFlag: true }).data.profile.vip, true);
  assert.equal(ok({ isVip: "1" }).data.profile.vip, true);
  assert.equal(ok({ memberFlag: 1 }).data.profile.vip, true);
  assert.equal(ok({ memberShip: "16" }).data.profile.vip, true, "官方 H5 把含 6 的值当会员类别");

  // 认不出的：0/缺省/没证据的数值字段（vipLevel、vipType）→ **不显示**（不猜枚举）
  assert.equal(ok({ memberShip: 0 }).data.profile, undefined, "数值 0 是明确不是会员 → 不携带");
  assert.equal(ok({ vipFlag: "yes" }).data.profile, undefined, "只认 0/1/true/false 这几种明确写法");
  assert.equal(ok({ vipLevel: 3 }).data.profile, undefined, "vipLevel 没有枚举证据 → 不猜（宁可少显示）");
  assert.equal(ok({ vipType: "2" }).data.profile, undefined);
  assert.equal(ok({}).data.profile, undefined, "什么都没有就不带 profile 这个键");
});

test("profile：响应为空对象 / 坏形状 → 不抛、不造假（返回空对象）", () => {
  for (const bad of [null, undefined, 42, "x", []]) {
    assert.deepEqual(profileFromResponse(bad), {}, String(bad));
  }
  assert.deepEqual(profileFromResponse({ data: { userName: "嵌在 data 里" } }), { userName: "嵌在 data 里" });
});

test("profile：会话记录里的 profile 只搬那三个键（旧会话没有这一格 → null，界面走兜底）", () => {
  assert.equal(profileOfSessionRecord({ musicSession: MUSIC_TOKEN, userId: "SNS-1" }), null, "R38 之前建的会话没有 profile");
  assert.equal(profileOfSessionRecord(null), null);
  assert.deepEqual(
    profileOfSessionRecord({ musicSession: MUSIC_TOKEN, profile: { userName: "名字", avatarUrl: "https://cdn.dbankcdn.cn/a.jpg", vip: true, extra: "不该带" } }),
    { userName: "名字", avatarUrl: "https://cdn.dbankcdn.cn/a.jpg", vip: true },
    "白名单外的键不许跟着载荷出去",
  );
  assert.equal(profileOfSessionRecord({ profile: { vip: false } }), null, "只有 false 等于什么都没认出来");
});

test("诊断：顶层键名日志只给键名（排序、限量），值一个都不出现", async () => {
  const logged = [];
  const { impl } = fakeFetch({
    body: { result: { resultCode: MUSIC_BUSINESS_OK }, token: MUSIC_TOKEN, snsUserID: "SNS-1", userName: "听歌的人" },
  });
  const exchange = portOf({ fetchImpl: impl, portOptions: { log: (line) => logged.push(line) } });
  await exchange({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });

  assert.equal(logged.length, 1, "每次兑换一条（成功路径一条 INFO；没有容器就只这一条）");
  assert.match(logged[0], /result, snsUserID, token, userName/, "键名按字典序给出（这就是要看的东西）");
  assert.ok(!logged[0].includes(MUSIC_TOKEN), "令牌值不许进日志");
  assert.ok(!logged[0].includes(AT), "AT 不许进日志");
  assert.ok(!logged[0].includes("听歌的人"), "资料值也不进日志（只要键名）");
  assert.deepEqual(topLevelKeysOf({ b: 1, a: 2, c: 3 }), ["a", "b", "c"]);
  assert.deepEqual(topLevelKeysOf(null), []);
});

// —— 3.6 profile 的第二来源（R40：loginex 一层容器 + id_token claims） -----------------

test("R40 诊断：loginex 两个容器的一层键名日志（只记键名，值一个都不出现）", async () => {
  const logged = [];
  const { impl } = fakeFetch({
    body: {
      result: { resultCode: MUSIC_BUSINESS_OK },
      token: MUSIC_TOKEN,
      queryAllSubInfoResp: { userInfo: { userName: "听歌的人" }, level: 3 },
      queryAppConfigDetailResp: { configList: [{ vipType: "2" }] },
    },
  });
  const exchange = portOf({ fetchImpl: impl, portOptions: { log: (line) => logged.push(line) } });
  await exchange({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });

  const nested = logged.filter((line) => line.includes("容器一层键名"));
  assert.equal(nested.length, 3, `两个容器各一条 + 一层子对象一条：${JSON.stringify(logged)}`);
  assert.match(nested[0], /queryAllSubInfoResp: level, userInfo/, "容器自己的键名（排序）");
  assert.match(nested[1], /queryAllSubInfoResp\.userInfo: userName/, "一层子对象的键名也报（资料最可能在这里）");
  assert.match(nested[2], /queryAppConfigDetailResp: configList/);
  const joined = logged.join("\n");
  assert.ok(!joined.includes("听歌的人"), "资料值不进日志");
  assert.ok(!joined.includes(MUSIC_TOKEN), "令牌不进日志");

  assert.deepEqual(MUSIC_PROFILE_NESTED_CONTAINER_KEYS, ["queryAllSubInfoResp", "queryAppConfigDetailResp"], "容器名来自真机键名日志");
  assert.deepEqual(nestedContainerKeyNamesOf({ b: 1 }), [], "响应对不上就什么都不报（不抛）");
  assert.deepEqual(nestedContainerKeyNamesOf({ queryAllSubInfoResp: { z: 1, a: 2 } }), ["queryAllSubInfoResp: a, z"], "键名排序");
});

test("R40 profile：往 queryAllSubInfoResp / queryAppConfigDetailResp 里读一层（防御式接线）", () => {
  const viaChild = profileFromResponse({
    queryAllSubInfoResp: { userInfo: { userName: "嵌两层的人", headUrl: "https://music-pics-drcn.dbankcdn.cn/a.jpg" } },
  });
  assert.deepEqual(viaChild, { userName: "嵌两层的人", avatarUrl: "https://music-pics-drcn.dbankcdn.cn/a.jpg" });

  const viaArray = profileFromResponse({ queryAppConfigDetailResp: { items: [{ nickName: "数组里的人" }] } });
  assert.deepEqual(viaArray, { userName: "数组里的人" }, "一层数组里的对象元素也算一层");

  // 白名单仍然管用：容器里那个头像地址不在 CDN 白名单内 → 不存
  assert.deepEqual(
    profileFromResponse({ queryAllSubInfoResp: { avatar: "https://evil.example.com/a.jpg", userName: "有名字" } }),
    { userName: "有名字" },
  );
  // VIP 的判据也没有放宽：容器里的 memberShip 含 6 照样认（同一份候选表）
  assert.deepEqual(profileFromResponse({ queryAllSubInfoResp: { memberShip: 6 } }), { vip: true });
});

test("R40 profile：id_token claims 只取 name/nickname 与 picture/avatar（VIP 不从 claims 取）", () => {
  assert.deepEqual(MUSIC_PROFILE_CLAIM_NAME_KEYS, ["name", "nickname"]);
  assert.deepEqual(MUSIC_PROFILE_CLAIM_AVATAR_KEYS, ["picture", "avatar"]);

  assert.deepEqual(
    profileFromClaims({ sub: "不该带", name: "账号名", picture: "https://music-pics-drcn.dbankcdn.cn/p.jpg" }),
    { userName: "账号名", avatarUrl: "https://music-pics-drcn.dbankcdn.cn/p.jpg" },
  );
  assert.deepEqual(profileFromClaims({ nickname: "昵称" }), { userName: "昵称" }, "name 缺就用 nickname");
  assert.deepEqual(profileFromClaims({ name: "账号名", nickname: "昵称" }), { userName: "账号名" }, "name 优先");
  assert.deepEqual(
    profileFromClaims({ picture: "https://evil.example.com/p.jpg" }),
    {},
    "白名单外的头像不进 profile（存了也只是个画不出来的死地址）",
  );
  // claims 里有会员样子的字段也不认：**没有证据**（memberShip 那条规则属于 loginex 响应）
  assert.deepEqual(profileFromClaims({ vip: true, is_premium: true, memberShip: 6 }), {}, "VIP 不从 claims 取");
  for (const bad of [null, undefined, 42, "x", []]) assert.deepEqual(profileFromClaims(bad), {}, String(bad));
});

test("R40 profile 合并：loginex 优先、claims 只补空缺；认不出就不动原记录", () => {
  assert.deepEqual(mergeProfiles({ userName: "loginex" }, { userName: "claims" }), { userName: "loginex" });
  assert.deepEqual(mergeProfiles({ avatarUrl: "a" }, { userName: "claims", avatarUrl: "b" }), {
    userName: "claims",
    avatarUrl: "a",
  });
  assert.deepEqual(mergeProfiles({ vip: true }, {}), { vip: true });

  const record = { musicSession: MUSIC_TOKEN, userId: "SNS-1", expireTime: "20261121000000" };
  const merged = attachClaimProfile(record, { name: "账号名", picture: "https://cdn.dbankcdn.cn/p.jpg", sub: "不该带" });
  assert.deepEqual(merged, {
    musicSession: MUSIC_TOKEN,
    userId: "SNS-1",
    expireTime: "20261121000000",
    profile: { userName: "账号名", avatarUrl: "https://cdn.dbankcdn.cn/p.jpg" },
  });
  assert.equal("sub" in (merged.profile ?? {}), false, "claims 里的其余键一个都不进记录");
  assert.equal("id_token" in merged, false, "**claims 原文不落盘**（记录会进 DPAPI 信封）");

  // 有 profile 时只补空缺，不覆盖
  const both = attachClaimProfile({ musicSession: MUSIC_TOKEN, profile: { userName: "loginex 的名字" } }, { name: "claims 的名字" });
  assert.deepEqual(both.profile, { userName: "loginex 的名字" });

  // 认不出 / 没有 claims → **同一个对象**（不制造"多了一个空 profile"的假变化）
  assert.equal(attachClaimProfile(record, { sub: "只有 sub" }), record);
  assert.equal(attachClaimProfile(record, null), record);
  assert.equal(attachClaimProfile(null, { name: "x" }), null, "坏记录原样返回，不抛");

  // 合并出来的 profile 与载荷投影同形（三个键，能被 profileOfSessionRecord 认出来）
  assert.deepEqual(profileOfSessionRecord(merged), { userName: "账号名", avatarUrl: "https://cdn.dbankcdn.cn/p.jpg" });
});

// —— 4. 端口行为 ---------------------------------------------------------------------

test("端口：真发 POST —— URL、方法、JSON 体、Digest 头、Content-Type 逐项钉住", async () => {
  const { impl, calls } = fakeFetch({ body: { result: { resultCode: MUSIC_BUSINESS_OK }, token: MUSIC_TOKEN } });
  const exchange = portOf({ fetchImpl: impl });
  const result = await exchange({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1, "一次兑换只发一次请求（不自动重试）");
  assert.equal(calls[0].url, HUAWEI_MUSIC_LOGINEX_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { accessToken: AT });
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.match(calls[0].init.headers.authorization, /^Digest username=app-music-baseline, nonce=\S+, created=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("端口：端点为空 → 结构化 missing_endpoint，**一次请求都不发**", async () => {
  const { impl, calls } = fakeFetch({ body: {} });
  const exchange = portOf({ fetchImpl: impl });
  for (const endpoint of [null, undefined, "", "   "]) {
    const result = await exchange({ accessToken: AT, endpoint });
    assert.equal(result.ok, false, String(endpoint));
    assert.equal(result.error.kind, MUSIC_SESSION_ERROR_KINDS.missingEndpoint);
    assert.ok(!result.error.message.includes(AT), "错误里不许回显 AT");
  }
  assert.equal(calls.length, 0, "端点缺失时绝不发请求（不猜 URL）");
});

test("端口：AT 为空 → missing_param，同样不发请求", async () => {
  const { impl, calls } = fakeFetch({ body: {} });
  const exchange = portOf({ fetchImpl: impl });
  for (const accessToken of [null, undefined, "", "  "]) {
    const result = await exchange({ accessToken, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });
    assert.equal(result.ok, false, String(accessToken));
    assert.equal(result.error.kind, MUSIC_SESSION_ERROR_KINDS.missingParam);
  }
  assert.equal(calls.length, 0);
});

test("端口：连接层失败 / HTTP 非 2xx / 非 JSON → 三种类别分开报，且不含凭据", async () => {
  const network = portOf({ fetchImpl: fakeFetch({ throwError: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }).impl });
  const networkResult = await network({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });
  assert.equal(networkResult.error.kind, MUSIC_SESSION_ERROR_KINDS.networkError);
  assert.ok(!networkResult.error.message.includes(AT));

  const http = portOf({ fetchImpl: fakeFetch({ status: 500, body: "boom" }).impl });
  const httpResult = await http({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });
  assert.equal(httpResult.error.kind, MUSIC_SESSION_ERROR_KINDS.httpError);
  assert.match(httpResult.error.message, /500/);

  const notJson = portOf({ fetchImpl: fakeFetch({ body: "<html>nope</html>" }).impl });
  const notJsonResult = await notJson({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });
  assert.equal(notJsonResult.error.kind, MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  assert.ok(!notJsonResult.error.message.includes(AT));
});

test("端口：没有任何一条错误消息会带出 AT 或音乐令牌", async () => {
  const bodies = [
    { result: { resultCode: "990000", resultMessage: AT }, token: MUSIC_TOKEN },
    { result: { resultCode: MUSIC_BUSINESS_OK } },
    { token: AT },
    {},
  ];
  for (const body of bodies) {
    const exchange = portOf({ fetchImpl: fakeFetch({ body }).impl });
    const result = await exchange({ accessToken: AT, endpoint: HUAWEI_MUSIC_LOGINEX_ENDPOINT });
    if (!result.ok) {
      assert.ok(!result.error.message.includes(AT), `错误带出了 AT：${result.error.message}`);
      assert.ok(!result.error.message.includes(MUSIC_TOKEN), `错误带出了音乐令牌：${result.error.message}`);
    }
  }
});

// —— 5. 跨层：默认端口真的接上了（auth-manager 不注入时走的就是它） --------------------

test("跨层：createAuthManager 的默认 loginex 端口真的会发请求（拦 globalThis.fetch 验一次完整登录）", async () => {
  const { createAuthManager, HUAWEI_OAUTH_ENDPOINTS } = await import("../src/main/auth-manager.ts");
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { resultCode: MUSIC_BUSINESS_OK }, token: MUSIC_TOKEN, snsUserID: "42" }),
    };
  };
  try {
    const opened = [];
    const saved = [];
    let settle;
    // 假宿主：形状与 test/auth-manager.test.mjs 的 fakeHost 一致（结论是 `{status, url}`）
    const host = {
      openLoginPage(params) {
        opened.push(params);
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
      cancelLogin: async () => ({ ok: true, data: { cancelled: true } }),
      cleanup() {},
    };
    const sessionStore = {
      async saveMusicSession(session) {
        saved.push(session);
        return { path: "x", modeApplied: true, modeNote: null };
      },
      async loadMusicSession() {
        return null;
      },
      async clearMusicSession() {
        return true;
      },
    };
    const auth = createAuthManager({
      host,
      sessionStore,
      // 刻意**不注入** exchangeMusicSession / endpoints.loginex：走的就是默认值
      exchangeCode: async () => ({ ok: true, data: { accessToken: AT, refreshToken: "RT-1" } }),
      verifySession: async () => ({ ok: true, data: { total: 3 } }),
      log: () => {},
    });

    assert.equal(auth.endpoints().loginex, HUAWEI_OAUTH_ENDPOINTS.loginex);
    const pending = auth.login();
    await new Promise((resolve) => setImmediate(resolve));
    const state = new URL(opened[0].url).searchParams.get("state");
    settle({ status: "callback", url: `hms://redirect_uri?code=CODE-1&state=${state}` });
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result));

    assert.equal(sent.length, 1, "默认端口必须真的发了一次请求");
    assert.equal(sent[0].url, HUAWEI_MUSIC_LOGINEX_ENDPOINT);
    assert.deepEqual(JSON.parse(sent[0].init.body), { accessToken: AT });
    assert.deepEqual(saved, [{ musicSession: MUSIC_TOKEN, userId: "42" }], "落盘的会话来自真实解析结果");
  } finally {
    globalThis.fetch = original;
  }
});
