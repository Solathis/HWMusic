/**
 * 会话验证器（src/main/session-verifier.mjs）：拿收藏接口的最小页判「这个音乐会话还有效吗」。
 * 三档结论——有效判通过；服务端明确拒绝判失效（踢回登录）；网络错误、端点没配或没验成的**不判失效**（宁可少报）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MUSIC_ENDPOINT_DEFAULTS, createMusicService } from "../src/main/music-service.mjs";
import { createMusicSessionVerifier } from "../src/main/session-verifier.mjs";
import { MUSIC_BUSINESS_OK } from "../src/protocols/music.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/**
 * 会话夹具：**存盘/内存里的那个形状**（`parseMusicSessionResponse` 的产物，
 * 见 `src/main/music-session.mjs`）——`musicSession` 是令牌，`userId` 是 snsUserID。
 */
const SESSION = { musicSession: "SESSION-TOKEN", userId: "U-1", expireTime: "20990101000000" };

/** 一条 HTTP 响应替身（只实现协议层真的用到的那两处：ok/status/json）。 */
function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/** 业务成功信封（真接口的收藏响应形状：顶层平铺 + `result.resultCode`）。 */
function okBody(extra = {}) {
  return { result: { resultCode: MUSIC_BUSINESS_OK }, favoriteInfos: [], ...extra };
}

/**
 * 造一个「接线与 sidecar 一样」的验证器：`createApi` 就是 `createMusicService(...)`，
 * 于是**端点表、Digest 头、会话映射**全是生产那一份（测试只替换 fetch）。
 */
function verifierOver(handler, { settingsData, sessionSource = () => null, calls = [] } = {}) {
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const verifySession = createMusicSessionVerifier({
    createApi: (source) => createMusicService({ settingsData, fetchImpl, session: source }).api,
    sessionSource,
  });
  return { verifySession, calls };
}

// ---------------------------------------------------------------------------
// 1. 有效那一档：HTTP 200 + 业务码 000000
// ---------------------------------------------------------------------------

test("有效：HTTP 200 + resultCode 000000 → ok，且请求就是参考的收藏最小页（POST 体 / Digest 头）", async () => {
  const { verifySession, calls } = verifierOver(async () => jsonResponse(okBody()));

  const result = await verifySession(SESSION);
  assert.equal(result.ok, true, JSON.stringify(result));

  assert.equal(calls.length, 1, "最小页 = 一次请求");
  const [{ url, init }] = calls;
  assert.equal(url, MUSIC_ENDPOINT_DEFAULTS.favorites, "端点就是 §2.2 的收藏端点（默认表那一份）");
  assert.equal(init.method, "POST", "收藏是 POST（R32 的裁决：POST 用 JSON 体，不是查询串）");
  assert.deepEqual(
    JSON.parse(init.body),
    { targetSnsUserID: "U-1", start: 0, limit: 1, contentTypes: ["1"] },
    "参数与参考的 favorites({start:0,limit:1}) 同形（limit=1 就是「最小页」）",
  );
  assert.match(
    init.headers.authorization,
    /^Digest username=app-music-baseline, nonce=.+, created=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z, token=SESSION-TOKEN$/,
    "Digest 头形状同 loginex，且带音乐会话令牌",
  );
});

// ---------------------------------------------------------------------------
// 2. 失效那一档：服务端明确拒绝
// ---------------------------------------------------------------------------

test("失效：业务码不是 000000 → session_invalid（文案说清原因与下一步，且不含凭据）", async () => {
  const { verifySession } = verifierOver(async () =>
    jsonResponse({ result: { resultCode: "990000", resultMessage: "System error!" } }),
  );

  const result = await verifySession(SESSION);
  assert.equal(result.ok, false);
  assert.equal(
    result.error.kind,
    "session_invalid",
    "这是「服务端确认无效」那一档：auth-manager 按它踢回登录",
  );
  assert.match(result.error.message, /990000/, "要说清是哪一条理由（业务码）");
  assert.match(result.error.message, /请重新登录/, "还要给出下一步");
  assert.doesNotMatch(result.error.message, /SESSION-TOKEN/, "凭据绝不进错误文案（它会进日志与界面）");
  assert.doesNotMatch(result.error.message, /System error/, "服务端 resultMessage 可能回显请求内容，不回显它");
});

test("失效：HTTP 拒绝（401/403/5xx 都是服务端明确拒绝）→ session_invalid，不带响应体", async () => {
  for (const status of [401, 403, 500]) {
    const { verifySession } = verifierOver(async () => jsonResponse({ secret: "inner" }, { status }));
    const result = await verifySession(SESSION);
    assert.equal(result.ok, false, `HTTP ${status} 不该判有效`);
    assert.equal(result.error.kind, "session_invalid", `HTTP ${status} 是服务端明确拒绝`);
    assert.match(result.error.message, /请重新登录/);
    assert.doesNotMatch(result.error.message, /inner/, "不读也不回显响应体");
  }
});

// ---------------------------------------------------------------------------
// 3. 没验成那一档：网络错 / 端点关 / 缺标识 / 200 但没有业务码
// ---------------------------------------------------------------------------

test("没验成：网络错误 → verify_unavailable（绝不判失效：网络抖动不是会话失效）", async () => {
  const { verifySession } = verifierOver(async () => {
    throw new Error("fetch failed");
  });

  const result = await verifySession(SESSION);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "verify_unavailable");
  assert.notEqual(result.error.kind, "session_invalid", "判错这一档的代价是把用户踢回登录页");
});

test("没验成：收藏端点被显式关掉（settings.musicEndpoints.favorites = null）→ 一次请求都不发", async () => {
  const { verifySession, calls } = verifierOver(async () => jsonResponse(okBody()), {
    settingsData: { musicEndpoints: { favorites: null } },
  });

  const result = await verifySession(SESSION);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "verify_unavailable");
  assert.equal(calls.length, 0, "端点都没配：不猜 URL、不发请求（与 loginex 的端点纪律同一条）");
});

test("没验成：会话里没有 SNS 用户标识 → verify_unavailable，且一次请求都不发", async () => {
  const { verifySession, calls } = verifierOver(async () => jsonResponse(okBody()));

  const result = await verifySession({ musicSession: "SESSION-TOKEN" });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "verify_unavailable", "缺标识是「发不出去」，不是「服务端说无效」");
  assert.equal(calls.length, 0);
});

test("没验成：HTTP 200 但响应里没有业务码 → 不认（成功判据是 000000，不是「HTTP 通了」）", async () => {
  const { verifySession } = verifierOver(async () => jsonResponse({ favoriteInfos: [] }));

  const result = await verifySession(SESSION);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "verify_unavailable", "看不懂的 200 只能算「没验成」（不许当成有效）");
});

// ---------------------------------------------------------------------------
// 4. 会话来源：参数优先，来源兜底（装配顺序的后果）
// ---------------------------------------------------------------------------

test("会话来源：验证的就是**传进来的那一个**（登录/恢复那一刻内存会话还没翻过去）", async () => {
  const { verifySession, calls } = verifierOver(async () => jsonResponse(okBody()), {
    // sidecar 里 `musicSessionSource` 读的是 `authManager.activeSession()`，
    // 而登录/恢复调用验证器时，那个格子里装的还是**旧会话或 null**（新会话要验过才落进去）。
    sessionSource: () => ({ musicSession: "STALE-TOKEN", userId: "STALE-USER" }),
  });

  const result = await verifySession(SESSION);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    JSON.parse(calls[0].init.body).targetSnsUserID,
    "U-1",
    "参数里的会话必须赢（否则登录那一刻会拿一个还没生效的会话去验，永远验不过）",
  );
  assert.match(calls[0].init.headers.authorization, /token=SESSION-TOKEN$/, "令牌同理");
});

test("会话来源：没传会话时回落到来源函数（按调用时取，不按装配时取）", async () => {
  let current = null;
  const { verifySession, calls } = verifierOver(async () => jsonResponse(okBody()), {
    sessionSource: () => current,
  });

  current = SESSION;
  const result = await verifySession();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.parse(calls[0].init.body).targetSnsUserID, "U-1");

  // 换一个会话（登录/登出都会换）：下一次调用取到的必须是新的那个
  current = { musicSession: "TOKEN-2", userId: "U-2" };
  await verifySession();
  assert.equal(JSON.parse(calls[1].init.body).targetSnsUserID, "U-2");
});

// 5. 端到端（进程内）：注入真验证器之后，登录链真的能走完。
// 除宿主窗口与 HTTP 是替身，其余全是真的（真 auth-manager、真验证器、真 music-service）。

/** 假宿主：开窗那一刻把结论交回来（真窗的行为归 src-tauri 与 verify:live）。 */
function fakeLoginHost(conclusion) {
  const opened = [];
  let settle;
  const host = {
    opened,
    openLoginPage(params) {
      opened.push(params);
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    cancelLogin: async () => ({ ok: true, data: { cancelled: true } }),
    cleanup() {},
  };
  return {
    host,
    opened,
    /** 交付结论：state 必须是**本次 attempt** 的（回调按它校验，别的 state 会被丢） */
    deliver: (status) => {
      const state = new URL(opened[0].url).searchParams.get("state");
      settle({ status, url: `hms://redirect_uri?code=CODE-1&state=${state}` });
    },
  };
}

function loginOver(handler, { status = "callback" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const verifySession = createMusicSessionVerifier({
    createApi: (source) => createMusicService({ fetchImpl, session: source }).api,
  });

  const saved = [];
  const broadcasts = [];
  const loginHost = fakeLoginHost();
  return import("../src/main/auth-manager.ts").then(({ createAuthManager }) => {
    const auth = createAuthManager({
      host: loginHost.host,
      sessionStore: {
        saveMusicSession: async (session) => {
          saved.push(session);
          return { path: "x", modeApplied: true, modeNote: null };
        },
        loadMusicSession: async () => null,
        clearMusicSession: async () => true,
      },
      // 账号令牌兑换按真形状给（PKCE 校验归 protocols/auth.mjs，不在这里核）。
      exchangeCode: async () => ({ ok: true, data: { accessToken: "AT-1" } }),
      // loginex 的产物形状（`parseMusicSessionResponse` 的产物：musicSession/userId/expireTime）
      exchangeMusicSession: async () => ({ ok: true, data: SESSION }),
      verifySession,
      broadcast: (channel, payload) => {
        broadcasts.push({ channel, payload });
      },
      log: () => {},
    });
    const pending = auth.login();
    return { auth, pending, loginHost, saved, broadcasts, calls, status };
  });
}

test("端到端：会话有效 → 登录链走完（换码 → loginex → 收藏接口验会话 → 落盘 → 已登录）", async () => {
  const { auth, pending, loginHost, saved, broadcasts, calls } = await loginOver(async () =>
    jsonResponse(okBody()),
  );
  // 等 attempt 真的开了窗再交付回调（`login()` 是异步起窗的）
  await new Promise((resolve) => setImmediate(resolve));
  loginHost.deliver("callback");

  const result = await pending;
  assert.equal(result.ok, true, `登录必须能走完（用户报的就是卡在这一步）：${JSON.stringify(result)}`);
  assert.deepEqual(saved, [SESSION], "验过的会话才落盘");
  assert.equal(auth.status().loggedIn, true);
  assert.deepEqual(broadcasts.at(-1).payload, { loggedIn: true, busy: false, sessionExpiresAt: Date.UTC(2099, 0, 1) }, "收口广播：已登录 + 空闲（会话记录带 expireTime，所以带到期时刻）");
  assert.equal(calls[0].url, MUSIC_ENDPOINT_DEFAULTS.favorites, "验证打的就是收藏端点");
});

test("端到端：服务端说会话无效 → 登录不落地（踢回登录，消息克制）", async () => {
  const { pending, loginHost, saved, broadcasts } = await loginOver(async () =>
    jsonResponse({ secret: "inner" }, { status: 401 }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  loginHost.deliver("callback");

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "session_invalid", "auth-manager 按这个 kind 踢回登录");
  assert.match(result.error.message, /请重新登录/);
  assert.deepEqual(saved, [], "没验过的会话绝不落盘");
  assert.equal(broadcasts.at(-1).payload.loggedIn, false, "更不许广播「已登录」");
});

test("端到端：没验成（网络错）→ 登录照旧不落地，但类别如实是缺口而不是失效", async () => {
  const { pending, loginHost, saved } = await loginOver(async () => {
    throw new Error("fetch failed");
  });
  await new Promise((resolve) => setImmediate(resolve));
  loginHost.deliver("callback");

  const result = await pending;
  assert.equal(result.ok, false, "没验过的会话不许广播已登录（auth-manager 不变量 1）");
  assert.equal(result.error.kind, "verify_unavailable");
  assert.notEqual(result.error.kind, "session_invalid", "上层要能区分「没验」与「验不过」");
  assert.deepEqual(saved, []);
});

// ---------------------------------------------------------------------------
// 6. 装配钉：sidecar 真的把验证器注进去了（否则用户看到的还是「验证器尚未注入」）
// ---------------------------------------------------------------------------

test("装配：sidecar 给 createAuthManager 传的是**真验证器**（不是留空、不是默认那个占位）", () => {
  const source = read("src/sidecar/main.mjs");
  const at = source.indexOf("createAuthManager({");
  assert.ok(at > -1, "sidecar 必须装配认证状态机");
  const args = source.slice(at, source.indexOf("});", at));

  assert.match(args, /verifySession/, "缺口就在这里：不注入 verifySession，登录链走到会话验证就断");
  assert.match(
    args,
    /verifySession\s*[,:]/,
    "传进去的必须是上面那个真验证器（不是随手写的空函数）",
  );
  assert.match(source, /createMusicSessionVerifier/, "验证器来自 src/main/session-verifier.mjs 的工厂");
  assert.match(
    source,
    /createMusicSessionVerifier\(\{/,
    "验证器要**构造**出来（端点表与会话来源都在装配处给）",
  );

  // 那条「仍不注入验证器」的旧注释不许留着冒充现状（它会让人以为缺口还在）
  assert.doesNotMatch(
    source,
    /仍不注入验证器/,
    "R32 那条「如实登记的缺口」已经补上了：注释不更新就等于文档在说谎",
  );

  const verifier = read("src/main/session-verifier.mjs");
  assert.doesNotMatch(verifier, /\bfetch\s*\(/, "验证器不自己发请求：HTTP 全走 music-service 的 api");
  assert.doesNotMatch(verifier, /console\./, "验证器不打印（凭据纪律：谁都不许把它写进日志）");
});

// 7. 文档钉：docs/KNOWN_LIMITATIONS.md 里那条「刻意没注入」必须随之改口。
// 留着它，下一个人会以为缺口还在。

test("文档：KNOWN_LIMITATIONS 不再说「会话验证器刻意没注入」，且如实留下仍未实测的那一半", () => {
  const doc = read("docs/KNOWN_LIMITATIONS.md");

  assert.doesNotMatch(
    doc,
    /会话验证器\*\*刻意没注入\*\*/,
    "R37 起验证器已注入（侧车装配见 §6）：这一行留着就是文档在说谎",
  );
  assert.match(doc, /会话验证器[^\n]*R37/, "这条连带影响要写明口径是 R37 改的（谁改的、改成什么）");
  assert.match(doc, /src\/main\/session-verifier\.mjs/, "要说清实现落在哪个文件");
  assert.match(doc, /verify_unavailable/, "「没验成不判失效」这条保守口径仍要留着（它才是这一档的实质）");
  assert.match(
    doc,
    /SESSION_INVALID_KINDS/,
    "那条「按现有证据拟定的待确认清单」的自我披露也不许被顺手删掉",
  );
  assert.match(doc, /未实测/, "仍未实测的那一半（真机上「失效会话回什么业务码」）必须留在同一段里");
});
