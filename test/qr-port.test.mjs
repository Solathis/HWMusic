/**
 * R16 · B 部分：二维码端口（`src/main/qr-login.mjs`）的**离线**全链测试。
 *
 * 拿一份注入的假 fetch 把整条链跑完：建单 → 轮询 → 已确认 → getLoginWay → CAS 302 →
 * 移动登录页 → getPageInfo → codeRemoteLogin → callbackURL。
 * 真实扫码那一步（手机确认）不可能在测试里发生，所以它是 untested，已如实登记在报告与契约文件里。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { HUAWEI_QR_ENDPOINTS, QR_PORT_ERROR_KINDS, createHuaweiQrPort } from "../src/main/qr-login.mjs";
import { createAttempt } from "../src/protocols/auth.mjs";
import {
  LOGIN_ERROR_KINDS,
  LOGIN_TIMEOUT_MS,
  consumeCallback,
  parseCallback,
} from "../src/protocols/login-callback.mjs";
import { QR_LOGIN_STATUS } from "../src/protocols/qr-login.mjs";
import { decodeFingerprint, fingerprintChecksum } from "../src/protocols/device-fingerprint.mjs";

const AUTHORIZE_URL =
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize?response_type=code&client_id=101444301" +
  "&redirect_uri=hms%3A%2F%2Fredirect_uri&scope=openid&access_type=offline&code_challenge=CHALLENGE" +
  "&code_challenge_method=S256&state=STATE";

const CREATE_PAYLOAD = {
  content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=R1&loginChannel=7000700&reqClientType=700",
  qrCode: "R1",
  qrToken: "qr-token-1",
  sessionID: "s1",
  qrCodeCreateTime: 1_700_000_000_000,
  expiredTime: 1_700_000_181_000,
  version: "40200",
};

const CAS_REDIRECT =
  "https://id1.cloud.huawei.com/CAS/remoteLogin?service=https%3A%2F%2Foauth-login1.cloud.huawei.com%2Foauth2%2Fv3%2FloginCallback";
const PORTAL_URL =
  "https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html?reqClientType=90&loginChannel=90000300" +
  "&clientID=101444301&state=STATE&lang=zh-cn&service=https%3A%2F%2Foauth-login1.cloud.huawei.com%2Foauth2%2Fv3%2FloginCallback";

/**
 * 假 fetch：按 URL 关键字路由。返回体形状与实探一致（含 `headers.getSetCookie`，
 * 因为端口会收 cookie 并带着它继续走 CAS 链）。
 */
function makeFetch({ pageInfo, confirm }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: init.headers ?? {},
    });
    const answer = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => headers[name.toLowerCase()] ?? null,
        getSetCookie: () => headers["set-cookie-list"] ?? [],
      },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body ?? {});
      },
    });

    if (target.includes("/DimensionalCode/getqrInfo")) {
      return answer(200, CREATE_PAYLOAD, { "set-cookie-list": ["JSESSIONID=abc; Path=/"] });
    }
    if (target.includes("/DimensionalCode/async")) {
      return answer(200, pollResponse());
    }
    if (target.includes("/oauth2/ajax/getLoginWay")) {
      return answer(200, { isSuccess: "true", loginInteractInfo: { cas: { casLoginRedirectUrl: CAS_REDIRECT } } });
    }
    if (target.startsWith("https://id1.cloud.huawei.com/CAS/remoteLogin")) {
      return answer(302, "", { location: PORTAL_URL });
    }
    if (target.includes("/CAS/mobile/standard/login.html")) {
      return answer(200, "<html></html>");
    }
    if (target.includes("/login/getPageInfo")) {
      return answer(200, pageInfo);
    }
    if (target.includes("/codeRemoteLogin")) {
      return answer(200, confirm);
    }
    throw new Error(`假 fetch 不认识这个地址：${target}`);
  };
  // 让"第一次轮询 = 未扫、第二次 = 已确认"成为默认剧本
  let pollCount = 0;
  const pollResponse = () => (pollCount++ === 0 ? { resultCode: "103000200" } : { resultCode: "0", userAccount: "u", code: "c", userID: "1", siteID: "1", accountType: "1", opType: "4" });
  return { fetchImpl, calls };
}

const PAGE_INFO = {
  isSuccess: 1,
  pageToken: "PAGE-TOKEN",
  pageTokenKey: "PAGE-TOKEN-KEY",
  localInfo: {
    service: "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?state=STATE",
    loginUrl: "https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html",
    reqClientType: "90",
    loginChannel: "90000300",
    lang: "zh-cn",
    getqrContent: "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo?appID=com.huawei.hwidweb",
    asyncURL: "https://id1.cloud.huawei.com/DimensionalCode/async?version=40200",
    qrcodeRequestInterval: 2000,
  },
};

/** 手动推进的计时器（与 test/qr-login.test.mjs 同一套最小实现）。 */
function timers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, delay: ms });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    /**
     * 跑到**最早到点**的那个挂起计时器。
     *
     * R26 起会话里同时挂着轮询（2 秒）与本地到期兜底（TTL + 宽限）两张网，按"谁先挂上谁先跑"
     * 推会让"下一次轮询"变成那张远未来的网——真实时间是按到点先后走的，这里跟着它走。
     */
    async tick() {
      let pick = null;
      for (const [id, entry] of pending) {
        if (pick === null || entry.delay < pick.entry.delay) pick = { id, entry };
      }
      if (pick === null) return false;
      pending.delete(pick.id);
      pick.entry.fn();
      for (let round = 0; round < 16; round += 1) await Promise.resolve();
      return true;
    },
    size: () => pending.size,
  };
}

function build({
  pageInfo = PAGE_INFO,
  confirm = { isSuccess: "1", callbackURL: "hms://redirect_uri?code=CODE&state=STATE" },
  now = () => 1_700_000_000_000,
  log = () => undefined,
} = {}) {
  const clock = timers();
  const world = makeFetch({ pageInfo, confirm });
  const events = [];
  const confirmations = [];
  const port = createHuaweiQrPort({
    fetchImpl: world.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now,
    random: () => 0.5,
    log,
    // 总期限关掉：本文件要手动推进"下一次轮询"，总期限计时器会插在队列最前面
    timeoutMs: null,
  });
  return { port, world, events, confirmations, clock };
}

test("端口：建单打的是无状态的二维码端点（URL 无查询串、六个参数从模板取），pending 广播带二维码内容", async () => {
  const { port, world, events, clock } = build();
  const started = await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });

  assert.equal(started.ok, true);
  assert.match(started.data.content, /qrcode\/login\.jsp/);
  assert.equal(started.data.expiresInMs, 181_000);
  assert.deepEqual(events.map((event) => event.status), [QR_LOGIN_STATUS.pending]);

  const create = world.calls.find((call) => call.url.includes("getqrInfo"));
  /**
   * R31 改了断言（行为也随之改了，理由在 `docs/API_CONTRACT.md` §1.8 的 R31 段）：
   * **请求上不再挂模板查询串**——探针实测页面发的是 `getqrContent.split("?")[0]`。
   * 端点常量本身仍然带查询串，因为它是六个参数的唯一真源（`buildQrCreateBody` 从它取）。
   */
  assert.equal(create.url, "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo");
  const body = new URLSearchParams(create.body);
  assert.equal(body.get("appID"), "com.huawei.hwidweb");
  assert.equal(body.get("version"), "40200");
  assert.equal(body.get("confirmFlag"), "1");
  assert.equal(
    world.calls.some((call) => call.url.includes("codeRemoteLogin")),
    false,
    "还没有人确认，换码那一步一步都不许走",
  );
  port.cancel();
  assert.equal(clock.size(), 0);
});

test("端口：已确认 → 走 CAS 链换回带 code 的回调（各步请求形状逐条对齐实探）", async () => {
  const { port, world, events, confirmations, clock } = build();
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });

  await clock.tick(); // 未扫：状态不变
  assert.deepEqual(events.map((event) => event.status), [QR_LOGIN_STATUS.pending]);

  await clock.tick(); // 已确认 → 触发换码链
  for (let round = 0; round < 8; round += 1) await Promise.resolve();

  assert.equal(confirmations.length, 1, "确认之后要把回调交给登录链路");
  assert.equal(confirmations[0].callbackUrl, "hms://redirect_uri?code=CODE&state=STATE");

  const loginWay = world.calls.find((call) => call.url.includes("getLoginWay"));
  assert.ok(loginWay, "要经过 getLoginWay 才能拿到 CAS 跳转");
  assert.equal(loginWay.headers.interfaceVersion, "v3");
  assert.equal(loginWay.headers.fromLoginAuth, "false");
  assert.match(loginWay.body, /client_id=101444301/);
  assert.match(loginWay.body, /state=STATE/);

  const pageInfo = world.calls.find((call) => call.url.includes("/login/getPageInfo"));
  assert.ok(pageInfo);
  const pageInfoBody = new URLSearchParams(pageInfo.body);
  assert.equal(pageInfoBody.get("pageName"), "login", "二维码配置只在移动登录页上下发");
  assert.equal(
    pageInfoBody.get("service"),
    "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback",
    "页面参数原样带过去（service 由 CAS 跳转给出）",
  );
  assert.equal(pageInfo.url.includes("cVersion="), true);

  const confirm = world.calls.find((call) => call.url.includes("/codeRemoteLogin"));
  assert.ok(confirm);
  const confirmBody = new URLSearchParams(confirm.body);
  assert.equal(confirmBody.get("pageToken"), "PAGE-TOKEN");
  assert.equal(confirmBody.get("pageTokenKey"), "PAGE-TOKEN-KEY");
  assert.equal(confirmBody.get("service"), PAGE_INFO.localInfo.service);
  assert.equal(confirmBody.get("appID"), "com.huawei.hwidweb");
  assert.equal(confirmBody.get("qrCode"), "R1", "换码要带上建单时的 qrCode");
  assert.equal(confirmBody.get("code"), "c", "确认载荷里的字段原样带上（页面自己也是这么传的）");
  assert.equal(confirmBody.get("userAccount"), "u");

  assert.equal(port.status(), QR_LOGIN_STATUS.confirmed);
  port.cancel();
  assert.equal(clock.size(), 0);
});

test("端口：CAS 页面配置里没有 service → 结构化 qr_config_unavailable（不猜一个 service 出来）", async () => {
  const { port, events, clock } = build({ pageInfo: { isSuccess: 1, localInfo: {}, pageToken: "T", pageTokenKey: "K" } });
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: () => undefined,
  });
  await clock.tick();
  await clock.tick();
  for (let round = 0; round < 8; round += 1) await Promise.resolve();

  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.qrConfigUnavailable);
  assert.match(failure.message, /service/);
});

test("端口：换码返回业务错误码 → failed 带码（不是静默当成功）", async () => {
  const { port, events, clock } = build({ confirm: { isSuccess: "1", errorCode: "70001203", errorDesc: "cross site" } });
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: () => undefined,
  });
  await clock.tick();
  await clock.tick();
  for (let round = 0; round < 8; round += 1) await Promise.resolve();

  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.confirmFailed);
  assert.match(failure.message, /70001203/);
});

test("端口：CAS 跳到白名单外的域 → 明确报出来（导航白名单要同步增补）", async () => {
  const clock = timers();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, body: String(init.body ?? "") });
    const answer = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null, getSetCookie: () => [] },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body ?? {});
      },
    });
    if (target.includes("getqrInfo")) return answer(200, CREATE_PAYLOAD);
    if (target.includes("DimensionalCode/async")) return answer(200, { resultCode: "0", code: "c" });
    if (target.includes("getLoginWay")) {
      return answer(200, {
        loginInteractInfo: { cas: { casLoginRedirectUrl: "https://evil.example.com/CAS/remoteLogin?x=1" } },
      });
    }
    return answer(404, {});
  };
  const events = [];
  const port = createHuaweiQrPort({
    fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: () => undefined,
    timeoutMs: null,
  });

  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: (event) => events.push(event), onConfirmed: () => undefined });
  await clock.tick();
  for (let round = 0; round < 8; round += 1) await Promise.resolve();

  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.qrConfigUnavailable);
  assert.match(failure.message, /evil\.example\.com/);
});

// ---------------------------------------------------------------------------
// R20：活动会话期间重启（手动刷新）——迟到的旧会话事件按身份丢弃
// R21（用户指令）：过期不再自动换新，"换一张新码"只剩手动这一条路
// ---------------------------------------------------------------------------

/** 建单响应里带一个可区分的 qrCode/qrToken（用来证明"换码带的是当前这张"）。 */
const createPayloadFor = (round) => ({
  ...CREATE_PAYLOAD,
  content: `https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=R${round}&loginChannel=7000700`,
  qrCode: `R${round}`,
  qrToken: `qr-token-${round}`,
});

test("端口：活动会话期间再次 start（手动刷新）→ 停旧会话 + 新会话；旧会话迟到的事件与建单一律丢弃", async () => {
  const clock = timers();
  let creates = 0;
  let polls = 0;
  let releaseOldPoll;
  const oldPollInFlight = new Promise((resolve) => {
    releaseOldPoll = resolve;
  });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    const answer = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null, getSetCookie: () => [] },
      async text() {
        return JSON.stringify(body ?? {});
      },
    });
    if (target.includes("getqrInfo")) {
      creates += 1;
      return answer(200, createPayloadFor(creates));
    }
    if (target.includes("DimensionalCode/async")) {
      polls += 1;
      if (polls === 1) {
        // 第一次 start 那条会话的轮询：挂住 —— 模拟"旧码的那次请求正在飞"
        await oldPollInFlight;
        return answer(200, { resultCode: "103000201" });
      }
      return answer(200, { resultCode: "103000200", errorDesc: "Please to login." });
    }
    throw new Error(`假 fetch 不认识这个地址：${target}`);
  };

  const eventsOld = [];
  const eventsNew = [];
  const port = createHuaweiQrPort({
    fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: () => undefined,
    timeoutMs: null,
  });

  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: (event) => eventsOld.push(event), onConfirmed: () => undefined });
  await clock.tick(); // 旧会话的轮询发出（挂着）
  assert.equal(polls, 1);

  // 用户点了二维码容器（手动刷新）：restart 语义——停旧会话、开新会话
  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: (event) => eventsNew.push(event), onConfirmed: () => undefined });
  assert.equal(creates, 2, "重新 start 要真的换一张新码");
  assert.deepEqual(eventsOld.map((event) => event.status), [QR_LOGIN_STATUS.pending]);

  releaseOldPoll();
  for (let round = 0; round < 16; round += 1) await Promise.resolve();

  assert.deepEqual(
    eventsOld.map((event) => event.status),
    [QR_LOGIN_STATUS.pending],
    "旧会话迟到的「过期」不许广播：它会把刚刷出来的新码顶掉（而且会再建一张）",
  );
  assert.equal(creates, 2, "旧会话的 expired 不许触发第三次建单");
  assert.equal(port.status(), QR_LOGIN_STATUS.pending, "当前这条会话还在等扫码");
  assert.deepEqual(eventsNew.map((event) => event.status), [QR_LOGIN_STATUS.pending]);
});

test("端口：过期不再自动换新（只播 expired、停轮询）；用户手动再 start 才换新码，换码带的是新那张的 qrCode", async () => {
  const clock = timers();
  let creates = 0;
  let polls = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, body: String(init.body ?? "") });
    const answer = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null, getSetCookie: () => [] },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body ?? {});
      },
    });
    if (target.includes("getqrInfo")) {
      creates += 1;
      return answer(200, createPayloadFor(creates));
    }
    if (target.includes("DimensionalCode/async")) {
      polls += 1;
      // 第一张过期（R21：端口只报不换）→ 用户手动刷新出第二张，第二张被扫确认
      return polls === 1
        ? answer(200, { resultCode: "103000201" })
        : answer(200, { resultCode: "0", userAccount: "u", code: "c", userID: "1", siteID: "1", accountType: "1", opType: "4" });
    }
    if (target.includes("/oauth2/ajax/getLoginWay")) {
      return answer(200, { isSuccess: "true", loginInteractInfo: { cas: { casLoginRedirectUrl: CAS_REDIRECT } } });
    }
    if (target.startsWith("https://id1.cloud.huawei.com/CAS/remoteLogin")) {
      return answer(302, "", { location: PORTAL_URL });
    }
    if (target.includes("/CAS/mobile/standard/login.html")) return answer(200, "<html></html>");
    if (target.includes("/login/getPageInfo")) return answer(200, PAGE_INFO);
    if (target.includes("/codeRemoteLogin")) {
      return answer(200, { isSuccess: "1", callbackURL: "hms://redirect_uri?code=CODE&state=STATE" });
    }
    throw new Error(`假 fetch 不认识这个地址：${target}`);
  };

  const events = [];
  const confirmations = [];
  const port = createHuaweiQrPort({
    fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: () => undefined,
    timeoutMs: null,
  });
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });

  await clock.tick(); // 过期
  assert.deepEqual(
    events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.expired],
    "过期只报这一档：端口不再自己建新单（R21 用户指令）",
  );
  assert.equal(creates, 1, "过期不许自己再建一张单");
  assert.equal(clock.size(), 0, "过期之后一个挂起的计时器都不剩（轮询停了）");
  assert.equal(confirmations.length, 0);

  // 用户点了「刷新二维码」：渲染层再发一次 auth:qr-start → 端口 restart
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });
  assert.equal(creates, 2, "手动刷新才换第二张码");
  assert.equal(port.status(), QR_LOGIN_STATUS.pending);

  await clock.tick(); // 第二张：已确认 → 换码
  for (let round = 0; round < 8; round += 1) await Promise.resolve();

  assert.equal(confirmations.length, 1);
  const confirmCall = calls.find((call) => call.url.includes("/codeRemoteLogin"));
  assert.ok(confirmCall, "确认之后要走换码链");
  assert.equal(
    new URLSearchParams(confirmCall.body).get("qrCode"),
    "R2",
    "带的是**手动刷新之后**那张的 qrCode（旧那张已经作废）",
  );
});

// ---------------------------------------------------------------------------
// R22（用户真机反馈两项）：端口这一层要证明"渲染层拿到的那个数是对的"
// ---------------------------------------------------------------------------

test("端口（R22）：本地钟快 1 小时，交回渲染层的 expiresInMs 仍是服务端 TTL（倒计时不被平移）", async () => {
  // 建单响应给的是服务端纪元：建单 1_700_000_000_000、到期 +181s（两个字段都在）
  const localSkew = 3_600_000;
  const { port, events, clock } = build({ now: () => CREATE_PAYLOAD.qrCodeCreateTime + localSkew });

  const started = await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: () => undefined,
  });

  assert.equal(
    started.data.expiresInMs,
    181_000,
    "本地钟偏 1 小时不影响有效期（老公式在这里会算出 0 → 倒计时一上来就归零）",
  );
  assert.equal(events[0].expiresInMs, 181_000, "广播给渲染层的也是同一个数（两侧一个真源）");
  port.cancel();
  assert.equal(clock.size(), 0);
});

test("端口（R22）：轮询诊断日志经端口落到注入的 log（stderr）——只有轮次与状态码", async () => {
  const logs = [];
  const { port, clock } = build({ log: (message) => logs.push(message) });

  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: () => undefined,
    onConfirmed: () => undefined,
  });
  await clock.tick(); // 未扫（103000200）
  await clock.tick(); // 已确认（0）

  const rounds = logs.filter((line) => line.includes("轮询 #"));
  assert.equal(rounds.length, 2, "每轮一行：两侧（协议层与端口注入的 log）确实是同一条通路");
  assert.match(rounds[0], /#1/);
  assert.match(rounds[0], /resultCode=103000200/);
  assert.match(rounds.at(-1), /resultCode=0/);
  assert.equal(logs.join("\n").includes(CREATE_PAYLOAD.qrToken), false, "日志不带 qrToken（会话令牌只在进程内用）");
});

// ---------------------------------------------------------------------------
// R31 全保真：建单/轮询的**上下文**补齐（探针实测的三处缺口）
//
// `scripts/probe-qr-fidelity.mjs` 用 headless Chromium 真开了官方二维码页（桌面门户
// `/CAS/portal/loginAuth.html`），抓到页面自己发的三个请求：
//
// 1. **建单**：`POST /DimensionalCode/getqrInfo`（**无查询串**）、表单 = 模板六参数
//    **+ deviceID + deviceType=7**、带 cookie（CAS 会话那串）、Referer 就是门户页；
// 2. **轮询**：`POST /DimensionalCode/async?version=40200&t=<随机>`、表单只有 qrToken、
//    带 cookie（**连建单响应自己设的 `qRCode`/`expiredTime`/`qrCodeCreateTime` 都带上了**）；
// 3. **设备指纹**：`POST /CAS/IDM_W/ajaxHandler/dev`，正文 `{pageToken, pageTokenKey, …, fp}`，
//    响应 `{isSuccess:1, sid:"<84 位 hex>"}`——**deviceID 就是这颗 sid**（页面写进
//    `localStorage.hwid_cas_sid` 与同名 cookie）。
//
// 于是端口层多两件事：① 建单前先把"会话上下文"拿到（CAS 链 → 门户页 → getPageInfo → dev），
// ② 让建单/轮询走**同一个 cookie 罐**（并带上页面 UA / Referer）。**失败一律降级**：
// 链走不通就照旧建单显示二维码——界面不能因为"保真"而变脆（R31 的硬约束：界面不变）。
// ---------------------------------------------------------------------------

/** 探针实测：页面的 deviceID 是服务端下发的一颗 84 位 hex（这里用假世界编一颗同形状的）。 */
const R31_SID = "a".repeat(84);

/** R31 的假世界：门户链 + 指纹 + 建单/轮询（每一步都能断言到请求头）。 */
function makeR31World({ deviceSid = R31_SID, portalFails = false, sidEmpty = false } = {}) {
  const calls = [];
  const cookieJar = [];
  const makeCookies = () => (cookieJar.length === 0 ? {} : { cookie: cookieJar.join("; ") });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const headers = { ...(init.headers ?? {}) };
    calls.push({ url: target, method: init.method ?? "GET", body: String(init.body ?? ""), headers });
    const answer = (status, body, extraHeaders = {}) => {
      for (const line of extraHeaders["set-cookie-list"] ?? []) cookieJar.push(line.split(";")[0]);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
          get: (name) => extraHeaders[name.toLowerCase()] ?? null,
          getSetCookie: () => extraHeaders["set-cookie-list"] ?? [],
        },
        async text() {
          return typeof body === "string" ? body : JSON.stringify(body ?? {});
        },
      };
    };

    if (target.includes("/oauth2/ajax/getLoginWay")) {
      if (portalFails) throw new Error("假装网络断了（R31 降级用例）");
      return answer(200, { isSuccess: "true", loginInteractInfo: { cas: { casLoginRedirectUrl: CAS_REDIRECT } } });
    }
    if (target.startsWith("https://id1.cloud.huawei.com/CAS/remoteLogin")) {
      return answer(302, "", { location: PORTAL_URL });
    }
    if (target.includes("/CAS/portal/loginAuth.html")) {
      // 门户页：它自己会下发一份会话 cookie（页面就是这么拿到的）
      return answer(200, "<html></html>", { "set-cookie-list": ["JSESSIONID=portal-session; Path=/"] });
    }
    if (target.includes("/CAS/mobile/standard/login.html")) return answer(200, "<html></html>");
    if (target.includes("/login/getPageInfo")) return answer(200, PAGE_INFO);
    if (target.includes("/ajaxHandler/dev")) {
      return answer(200, { isSuccess: 1, sid: sidEmpty ? "" : deviceSid });
    }
    if (target.includes("/DimensionalCode/getqrInfo")) {
      // 建单响应自己会设 cookie（探针实测：轮询把它们带回去了）
      return answer(200, CREATE_PAYLOAD, { "set-cookie-list": ["qRCode=R1; Path=/", "expiredTime=1; Path=/"] });
    }
    if (target.includes("/DimensionalCode/async")) return answer(200, { resultCode: "103000200" });
    if (target.includes("/codeRemoteLogin")) return answer(200, { isSuccess: "1", callbackURL: "hms://redirect_uri?code=CODE" });
    throw new Error(`假 fetch 不认识这个地址：${target}`);
  };
  return { fetchImpl, calls };
}

function buildR31(options = {}, config = {}) {
  const clock = timers();
  const world = makeR31World(config);
  const logs = [];
  const events = [];
  const port = createHuaweiQrPort({
    fetchImpl: world.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: (message) => logs.push(message),
    timeoutMs: null,
    ...options,
  });
  return { port, world, clock, logs, events };
}

test("R31 建单：先拿会话上下文（CAS 链 → 门户页 → getPageInfo → 指纹 dev），再按页面形状建单", async () => {
  const { port, world, clock, events, logs } = buildR31();
  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: (event) => events.push(event), onConfirmed: () => undefined });

  // 端点表里登记的就是探针抓到的那两条（改路径要连契约一起改）
  assert.equal(HUAWEI_QR_ENDPOINTS.deviceFingerPath, "/CAS/IDM_W/ajaxHandler/dev");
  assert.equal(HUAWEI_QR_ENDPOINTS.portalLoginPath, "/CAS/portal/loginAuth.html");

  // ① 指纹那一步：URL/正文都是页面的形状
  const dev = world.calls.find((call) => call.url.includes("/ajaxHandler/dev"));
  assert.ok(dev, `建单之前要先用指纹换 deviceID：${JSON.stringify(world.calls.map((call) => call.url))}`);
  assert.match(dev.url, /reflushCode=.*&cVersion=/);
  const devBody = new URLSearchParams(dev.body);
  assert.equal(devBody.get("pageToken"), PAGE_INFO.pageToken);
  assert.equal(devBody.get("pageTokenKey"), PAGE_INFO.pageTokenKey);
  const fp = decodeFingerprint(devBody.get("fp"));
  assert.equal(fp.ok, true, "fp 必须是页面那种可解的形状");
  assert.equal(fp.checksum, fingerprintChecksum(fp.body), "cs 就是去掉 cs 那半截的 sha1（服务端就认它）");

  // ② 建单：URL 无查询串、表单与页面逐字段一致、deviceID 用的是服务端给的 sid
  const create = world.calls.find((call) => call.url.includes("/DimensionalCode/getqrInfo"));
  assert.equal(create.url, "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo");
  const body = new URLSearchParams(create.body);
  assert.deepEqual([...body.keys()].sort(), [
    "appBrand",
    "appID",
    "confirmFlag",
    "deviceID",
    "deviceType",
    "loginChannel",
    "reqClientType",
    "version",
  ]);
  assert.equal(body.get("deviceID"), R31_SID, "deviceID 必须是服务端下发的那颗 sid（不是我们自己编的）");
  assert.equal(body.get("deviceType"), "7");
  assert.equal(body.get("appID"), "com.huawei.hwidweb");

  // ③ 三个请求都带页面那套头：UA（协议保真，不是应用 webview 的 UA）+ Referer + cookie
  for (const call of [dev, create]) {
    assert.match(call.headers["user-agent"] ?? "", /Chrome\/131\.0\.0\.0/, "UA 复刻页面（桌面 Chrome）");
    assert.match(call.headers.referer ?? "", /\/CAS\/portal\/loginAuth\.html/, "Referer 就是那张画着二维码的页");
  }
  assert.match(create.headers.cookie ?? "", /JSESSIONID=portal-session/, "建单带着 CAS 会话的 cookie（探针实测页面带着）");
  assert.equal(create.headers.accept, "application/json, text/plain, */*");

  // ④ 轮询：同一个罐，而且**建单响应自己设的 cookie** 也要回来
  await clock.tick();
  const poll = world.calls.find((call) => call.url.includes("DimensionalCode/async"));
  assert.match(poll.url, /^https:\/\/id1\.cloud\.huawei\.com\/DimensionalCode\/async\?version=40200&t=/);
  assert.deepEqual([...new URLSearchParams(poll.body).keys()], ["qrToken"]);
  assert.match(poll.headers.cookie ?? "", /JSESSIONID=portal-session/);
  assert.match(poll.headers.cookie ?? "", /qRCode=R1/, "建单响应设的 qRCode cookie 要跟着回来（页面就是这样）");
  assert.match(poll.headers.cookie ?? "", /expiredTime=1/);

  assert.deepEqual(events.map((event) => event.status), [QR_LOGIN_STATUS.pending]);
  assert.equal(
    logs.some((line) => line.includes("二维码") && line.includes("R31")),
    true,
    `上下文那一步要留一行可判的日志：${JSON.stringify(logs)}`,
  );
  assert.equal(logs.join("\n").includes(R31_SID), false, "deviceID 是设备标识，但没必要进日志（只记形状/来源）");
  port.cancel();
  assert.equal(clock.size(), 0);
});

test("R31 降级：CAS/门户链走不通时照样建单显示二维码（不带 deviceID、不带 cookie，界面不受影响）", async () => {
  const { port, world, clock, events, logs } = buildR31({}, { portalFails: true });
  const started = await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: () => undefined,
  });

  assert.equal(started.ok, true, "链走不通也必须把二维码显示出来（保真不能变成新的故障点）");
  const create = world.calls.find((call) => call.url.includes("/DimensionalCode/getqrInfo"));
  assert.ok(create, "照旧建单");
  const body = new URLSearchParams(create.body);
  assert.equal(body.get("deviceID"), null, "拿不到服务端那颗 sid 就不许自己编一个");
  assert.equal(body.get("deviceType"), null);
  assert.equal(create.headers.cookie, undefined, "没有会话上下文就一个 cookie 都不带");
  assert.equal(create.headers["user-agent"] !== undefined, true, "但 UA 是协议保真，与上下文成败无关");
  assert.deepEqual(events.map((event) => event.status), [QR_LOGIN_STATUS.pending]);
  assert.equal(logs.some((line) => line.includes("降级")), true, `降级要留一行说明：${JSON.stringify(logs)}`);
  port.cancel();
  assert.equal(clock.size(), 0);
});

test("R31 不猜：dev 回了空 sid（服务端不认这份指纹）→ 建单不带 deviceID，二维码照常显示", async () => {
  const { port, world, events, logs } = buildR31({}, { sidEmpty: true });
  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: (event) => events.push(event), onConfirmed: () => undefined });

  const create = world.calls.find((call) => call.url.includes("/DimensionalCode/getqrInfo"));
  const body = new URLSearchParams(create.body);
  assert.equal(body.get("deviceID"), null);
  assert.equal(body.get("deviceType"), null);
  assert.deepEqual(events.map((event) => event.status), [QR_LOGIN_STATUS.pending]);
  assert.equal(logs.some((line) => line.includes("降级")), true);
  port.cancel();
});

// ---------------------------------------------------------------------------
// R33（用户真机证据 2026-10-21）：确认链的**最后一跳**
//
// 真机事实链：扫码 + 手机确认**已经走通**（R31 保真生效——轮询见到 `0`、`codeRemoteLogin`
// 真的回了 `callbackURL`），卡在最后一步的报错是「不是登录回调 URL（只接受 hms://redirect_uri）」。
// 根因：`callbackURL` 是 **https 的 loginCallback 中转页**
// （`oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?…redirect_uri=hms%3A%2F%2Fredirect_uri`），
// 浏览器里它 302 到 `hms://redirect_uri?code&state`；我们直接把它喂给了只认 hms:// 的 `parseCallback`。
//
// 这一节把"跟随"这一跳的形状钉死：`hms://` 直通、`https://` 按 `redirect:"manual"` 抓 Location
// （带 QR 链的 cookie 罐与同款头）、最多 5 跳；形状对不上就**结构化报错，不猜**。
// ---------------------------------------------------------------------------

/** 真实形状（真机证据里那条）：https 的 loginCallback 中转页。 */
const R33_RELAY_URL =
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?state=STATE&code=CODE" +
  "&redirect_uri=hms%3A%2F%2Fredirect_uri&access_type=offline";
/** 它在浏览器里 302 去的地方（唯一被接受的收场形状）。 */
const R33_HMS_CALLBACK = "hms://redirect_uri?code=CODE&state=STATE";

/**
 * R34 起：`R33_RELAY_URL`（查询里带 `code`）会被**策略①参数直构**当场收下（那正是真机要的修法），
 * 于是它**不再**经过"跟随"那条路。要单独钉住策略②（302 Location），剧本必须换一个
 * **查询里没有 `code`** 的 https 中转页——真实世界里它就是"code 还没落到参数上"的那一跳。
 */
const R34_PLAIN_RELAY_URL =
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?state=STATE&redirect_uri=hms%3A%2F%2Fredirect_uri";

/**
 * R33 的假世界：`codeRemoteLogin` 交回一份**可编排**的 callbackURL，中转页的每一跳按剧本回答。
 *
 * @param {{callbackURL?: string, relay?: (url: string, hop: number) => ({status: number, location?: string, body?: string}) | null}} [config]
 */
function makeR33World({ callbackURL = R33_RELAY_URL, relay = () => ({ status: 302, location: R33_HMS_CALLBACK }) } = {}) {
  const calls = [];
  let polls = 0;
  let hops = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: init.headers ?? {},
      redirect: init.redirect ?? null,
    });
    const answer = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => headers[name.toLowerCase()] ?? null,
        getSetCookie: () => headers["set-cookie-list"] ?? [],
      },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body ?? {});
      },
    });

    if (target.includes("/DimensionalCode/getqrInfo")) {
      return answer(200, CREATE_PAYLOAD, { "set-cookie-list": ["JSESSIONID=qr-session; Path=/"] });
    }
    if (target.includes("/DimensionalCode/async")) {
      polls += 1;
      return answer(
        200,
        polls === 1
          ? { resultCode: "103000200" }
          : { resultCode: "0", userAccount: "u", code: "c", userID: "1", siteID: "1", accountType: "1", opType: "4" },
      );
    }
    if (target.includes("/oauth2/ajax/getLoginWay")) {
      return answer(200, { isSuccess: "true", loginInteractInfo: { cas: { casLoginRedirectUrl: CAS_REDIRECT } } });
    }
    if (target.startsWith("https://id1.cloud.huawei.com/CAS/remoteLogin")) {
      return answer(302, "", { location: PORTAL_URL });
    }
    if (target.includes("/CAS/mobile/standard/login.html")) {
      return answer(200, "<html></html>", { "set-cookie-list": ["CASTGC=cas-ticket; Path=/"] });
    }
    if (target.includes("/CAS/portal/loginAuth.html")) {
      return answer(200, "<html></html>", { "set-cookie-list": ["JSESSIONID=portal-session; Path=/"] });
    }
    if (target.includes("/ajaxHandler/dev")) return answer(200, { isSuccess: 1, sid: R31_SID });
    if (target.includes("/login/getPageInfo")) return answer(200, PAGE_INFO);
    if (target.includes("/codeRemoteLogin")) return answer(200, { isSuccess: "1", callbackURL });

    // 只有中转页那一条链交给剧本；别的地址一律**响亮地**不认识（免得"没路由到"被悄悄当成一跳）
    if (!target.includes("/loginCallback")) throw new Error(`假 fetch 不认识这个地址：${target}`);
    hops += 1;
    const scripted = relay(target, hops);
    if (scripted === null) throw new Error(`剧本没有覆盖这一跳：${target}`);
    return answer(scripted.status, scripted.body ?? "", { location: scripted.location });
  };
  return { fetchImpl, calls, relayCalls: () => calls.filter((call) => call.url.includes("/loginCallback")) };
}

/** 跑一遍"建单 → 未扫 → 已确认 → 换码 → 收尾"，把三样证据交回。 */
async function runR33(config = {}) {
  const clock = timers();
  const world = makeR33World(config);
  const events = [];
  const confirmations = [];
  const logs = [];
  const port = createHuaweiQrPort({
    fetchImpl: world.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: (message) => logs.push(message),
    timeoutMs: null,
  });
  await port.start({
    authorizeUrl: AUTHORIZE_URL,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });
  await clock.tick(); // 未扫
  await clock.tick(); // 已确认 → 换码链（含最后一跳的跟随）
  for (let round = 0; round < 40; round += 1) await Promise.resolve();
  return { port, world, clock, events, confirmations, logs };
}

test("R33：callbackURL 本来就是 hms:// → 直通（一个多余请求都不发）", async () => {
  const { port, world, confirmations, events } = await runR33({ callbackURL: R33_HMS_CALLBACK });

  assert.equal(confirmations.length, 1, "确认之后仍然要把回调交给登录链路");
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK, "hms:// 原样交回（既有链零改动）");
  assert.equal(world.relayCalls().length, 0, "本来就是回调地址，不必去跟随任何东西");
  assert.equal(events.at(-1).status, QR_LOGIN_STATUS.confirmed);
  port.cancel();
});

test("R33：https 中转页 302 → Location 是 hms:// 回调 → 跟随一跳（manual + 同一罐 cookie + 同款头）", async () => {
  const { port, world, confirmations, events } = await runR33({ callbackURL: R34_PLAIN_RELAY_URL });

  assert.equal(confirmations.length, 1, `真实形状必须能收尾：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK, "交回登录链路的必须是 hms:// 的那一条");

  const relay = world.relayCalls();
  assert.equal(relay.length, 1, "只跟随一跳");
  assert.equal(relay[0].url, R34_PLAIN_RELAY_URL, "跟随的就是 codeRemoteLogin 交回的那个地址");
  /**
   * `redirect: "manual"` 是这一跳的**关键**：自动跟随的话 302 会被换成 hms:// 那次导航的失败
   * （Electron/undici 跟不了自定义 scheme），Location 也就读不到了。
   */
  assert.equal(relay[0].redirect, "manual", "必须自己读 Location，不许让 fetch 自动跟随");
  assert.match(relay[0].headers["user-agent"] ?? "", /Chrome\/131\.0\.0\.0/, "同一套协议保真 UA");
  assert.match(relay[0].headers.cookie ?? "", /JSESSIONID=qr-session/, "带 QR 链那口 cookie 罐");
  assert.match(relay[0].headers.cookie ?? "", /CASTGC=cas-ticket/, "CAS 换码那一步种下的 cookie 也要带上");
  assert.match(relay[0].headers.referer ?? "", /\/CAS\/mobile\/standard\/login\.html/, "Referer 与换码那一步同款");
  assert.equal(events.at(-1).status, QR_LOGIN_STATUS.confirmed);
  port.cancel();
});

test("R33：两跳（https → https → hms://）也要跟到底", async () => {
  const second = "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?step=2&code=CODE";
  const { port, world, confirmations, events } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: (url) => (url === R34_PLAIN_RELAY_URL ? { status: 302, location: second } : { status: 302, location: R33_HMS_CALLBACK }),
  });

  assert.equal(confirmations.length, 1, `两跳中转也要收尾：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.deepEqual(world.relayCalls().map((call) => call.url), [R34_PLAIN_RELAY_URL, second]);
  port.cancel();
});

test("R33：中转页最多跟 5 跳（第 5 跳拿到 hms:// 收尾；第 6 跳要不到就结构化报错）", async () => {
  const hopUrl = (n) => `https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?hop=${n}`;
  const { port, world, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    // 连着 5 次 https 中转，第 5 跳的 Location 才是回调 —— 边界以内，必须收尾
    relay: (_url, hop) => ({ status: 302, location: hop === 5 ? R33_HMS_CALLBACK : hopUrl(hop) }),
  });
  assert.equal(confirmations.length, 1, "5 跳是允许的上限");
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.equal(world.relayCalls().length, 5);
  port.cancel();

  // 一直给 https 中转（永远不给回调）→ 到第 5 跳就停，结构化报错（不猜、也不无限跟）
  const stuck = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: (_url, hop) => ({ status: 302, location: hopUrl(hop + 1) }),
  });
  assert.equal(stuck.confirmations.length, 0, "跟不到回调就不许把任何东西当成功交出去");
  const failure = stuck.events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.match(failure.message, /跳|中转/);
  assert.equal(stuck.world.relayCalls().length, 5, "上限就是 5 次跟随");
  stuck.port.cancel();
});

test("R33：中转页 200（没有 Location、响应体里也没有回调字面量）→ 结构化报错，不回显 URL", async () => {
  const { port, events, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 200, body: "<html>请重新登录</html>" }),
  });

  assert.equal(confirmations.length, 0);
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.match(failure.message, /200/, "状态码本身不是凭据，要说出来（好判）");
  assert.equal(failure.message.includes("oauth-login1"), false, "文案不许回显 URL（凭据边界）");
  assert.equal(failure.message.includes("redirect_uri="), false);
  port.cancel();
});

test("R33：Location 是别的 hms 域（不是 redirect_uri 回调）→ 结构化报错，不猜", async () => {
  const { port, events, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 302, location: "hms://evil.example.com/steal?code=CODE&state=STATE" }),
  });

  assert.equal(confirmations.length, 0, "钓鱼形状的地址一律不许当回调交出去");
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.match(failure.message, /不是登录回调/);
  assert.equal(failure.message.includes("evil.example.com"), false, "文案不许回显那个地址");
  port.cancel();
});

test("R33：跟随那一跳网络失败 → network_error（与换码接口失败分得清）", async () => {
  /**
   * R34 起这条剧本必须用**查询里没有 `code`** 的中转页：带 `code` 的那些会被策略①当场收下、
   * 一个请求都不发（那正是策略①要的效果），"跟随那一跳失败"根本无从发生。
   */
  const { port, events, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => {
      throw new Error("假装网络断了");
    },
  });

  assert.equal(confirmations.length, 0);
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.networkError);
  assert.match(failure.message, /请求失败/);
  assert.equal(failure.message.includes("loginCallback?"), false, "文案不许回显 URL");
  port.cancel();
});

test("R33：连 hms:// 也不认的 callbackURL 形状（既非 https 也非回调）→ 结构化报错，不外发请求", async () => {
  const { port, world, events, confirmations } = await runR33({ callbackURL: "http://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=CODE" });

  assert.equal(confirmations.length, 0);
  assert.equal(world.relayCalls().length, 0, "形状不认就不许往外发请求");
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.equal(failure.message.includes("oauth-login1"), false);
  port.cancel();
});

test("R31 上下文只拿一次：start 不会为了建单打两遍 CAS 链（换码那一步仍然留给确认之后）", async () => {
  const { port, world, clock } = buildR31();
  await port.start({ authorizeUrl: AUTHORIZE_URL, onEvent: () => undefined, onConfirmed: () => undefined });
  await clock.tick();

  const loginWayCalls = world.calls.filter((call) => call.url.includes("getLoginWay")).length;
  assert.equal(loginWayCalls, 1, `建单这条链只走一遍：${loginWayCalls}`);
  assert.equal(
    world.calls.some((call) => call.url.includes("/codeRemoteLogin")),
    false,
    "没有人确认过，换码链一步都不许走",
  );
  port.cancel();
});

// ---------------------------------------------------------------------------
// R34（用户指令 2026-10-21）：最后一跳**三策略按证据序**收尾
//
// R33 把"跟随 302"这条路修对了，但真机那条链**没有**走到它：`callbackURL` 是 https 中转页，
// 服务端 fetch 它拿到的是 **HTTP 200**（HTML 页面，浏览器里靠页面自己的 JS 跳 `hms://`），
// 没有 Location。而 R16 契约里那句"`callbackURL` 带 code"是**读 bundle 的推断**——
// 用户本轮澄清：它只是参考，当时**未实测**。所以不再押注任何单一路径，按证据序实现三条：
//
//   ① **参数直构**（最省、证据最强）：中转页的查询参数里既有 `code`、又有 `redirect_uri`
//      解码后等于 `hms://redirect_uri` → 我们自己就是那份 redirect_uri 的处理者，
//      直接构造 `hms://redirect_uri?code&state` 交回，**一个请求都不发**；
//      （`code` 不在查询里 → 策略①不成立，落 ②；state 缺省时只带 `code`，
//        "形状对不对"交给下游 `parseCallback`/`consumeCallback` 判，这里不编一个 state）
//   ② **302 Location 跟随**（R33 已有，保留）：服务端哪天真改回直跳仍然成立；
//   ③ **200 响应体提取**：跟随的那一跳回 2xx、体里带着 `hms://redirect_uri?` 字面量
//      （页面 JS 跳转的目标）→ 提取**原文**交回（不加不减）。
//
// 三败 → 既有结构化错误（`qr_callback_redirect_failed`）：不猜、不回显 URL（凭据边界）。
// 顺序 ① → ② → ③：① 不成立才发请求，② 拿到 2xx 才看体。
//
// 驱动复用 R33 的 `runR33`：同一条"建单 → 未扫 → 已确认 → 换码 → 收尾"，只是剧本换了。
// ---------------------------------------------------------------------------

test("R34 策略①：中转页查询里 code + redirect_uri=hms://redirect_uri → 直接构造回调，一个请求都不发", async () => {
  const { port, world, confirmations, events } = await runR33({ callbackURL: R33_RELAY_URL });

  assert.equal(confirmations.length, 1, `参数齐备就要当场收尾：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.equal(world.relayCalls().length, 0, "code 与 redirect_uri 都在参数里，中转页根本不必再打一次");
  assert.equal(events.at(-1).status, QR_LOGIN_STATUS.confirmed);
  port.cancel();
});

test("R34 策略①：查询里没有 code → 不直构（无中生有一个 code 是最坏的猜法），落策略②", async () => {
  const { port, world, confirmations, events } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 302, location: R33_HMS_CALLBACK }),
  });

  assert.equal(confirmations.length, 1, `没有 code 就按 302 跟随收尾：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.equal(world.relayCalls().length, 1, "策略①不成立 → 照旧跟随那一跳");
  port.cancel();
});

test("R34 策略①：redirect_uri 解码后不是 hms://redirect_uri → 不直构（不把 code 塞进别人的回调）", async () => {
  const { port, world, confirmations, events } = await runR33({
    callbackURL:
      "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=CODE" +
      "&redirect_uri=https%3A%2F%2Fevil.example.com%2Fcb",
    relay: () => ({ status: 200, body: "<html>请重新登录</html>" }),
  });

  assert.equal(confirmations.length, 0, "redirect_uri 不是我们的回调，就不许拿它的 code 构造一条 hms:// 回调");
  assert.equal(world.relayCalls().length, 1, "策略①不成立才轮到策略②（跟随那一跳要照常发出）");
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.equal(failure.message.includes("evil.example.com"), false, "文案不许回显那个地址");
  port.cancel();
});

test("R34 策略①：查询里没有 state → 只带 code（不编一个 state 出来；形状留给下游判）", async () => {
  const { port, confirmations, events } = await runR33({
    callbackURL: "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=CODE&redirect_uri=hms%3A%2F%2Fredirect_uri",
  });

  assert.equal(confirmations.length, 1, `参数够构造就收尾：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, "hms://redirect_uri?code=CODE", "参数里有什么就是什么，一个字符都不加");
  assert.equal(events.at(-1).status, QR_LOGIN_STATUS.confirmed);

  // 形状"不完整"这件事**不在这里判**：parseCallback 才是判真伪的地方（R34 的口径：只构造，不裁决）
  const parsed = parseCallback("hms://redirect_uri?code=CODE");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.kind, LOGIN_ERROR_KINDS.missingParams);
  port.cancel();
});

test("R34 策略①：code/state 的编码原样搬过去（不做解码再编码）", async () => {
  const { port, confirmations } = await runR33({
    callbackURL:
      "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=A%2BB%2Fc&state=S%2B1" +
      "&redirect_uri=hms%3A%2F%2Fredirect_uri",
  });

  assert.equal(confirmations.length, 1);
  assert.equal(
    confirmations[0].callbackUrl,
    "hms://redirect_uri?code=A%2BB%2Fc&state=S%2B1",
    "解码再编码会把 `%2B` 变成 `+`（服务端看到的就不是同一个字符了）：只搬原文",
  );
  port.cancel();
});

test("R34 策略①：302 跳到一条**带 code** 的 loginCallback（链终点）→ 也直构，不再多打一次", async () => {
  const { port, world, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: (url) =>
      url === R34_PLAIN_RELAY_URL
        ? { status: 302, location: R33_RELAY_URL }
        : { status: 200, body: "<html>链终点那条已经带着 code，走到这里就是多打了一次</html>" },
  });

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.deepEqual(
    world.relayCalls().map((call) => call.url),
    [R34_PLAIN_RELAY_URL],
    "链终点那条 URL 自己带着 code + redirect_uri，不必再去 fetch 它",
  );
  port.cancel();
});

test("R34 策略③：跟随那一跳回 200、体里带着 hms://redirect_uri? 字面量 → 提取原文交回", async () => {
  const { port, world, confirmations, events } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({
      status: 200,
      body: '<html><script>window.location.href="hms://redirect_uri?code=CODE&state=STATE"</script></html>',
    }),
  });

  assert.equal(confirmations.length, 1, `真机上就是这个形状（200 + 页面自己跳）：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK, "提取的就是那串字面量原文（不加不减）");
  assert.equal(world.relayCalls().length, 1, "只打了跟随那一跳（体就在它的响应里）");
  assert.equal(events.at(-1).status, QR_LOGIN_STATUS.confirmed);
  port.cancel();
});

test("R34 策略③：字面量被 JS/HTML 包装（引号、尖括号、分号）→ 边界处不加不减", async () => {
  const literal = "hms://redirect_uri?code=C%2BD&state=S1";
  const { port, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 200, body: `<html>\n<script>\n  location.replace('${literal}');\n</script>\n</html>` }),
  });

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].callbackUrl, literal, "两侧的引号/分号/尖括号都不是回调的一部分");
  port.cancel();
});

test("R34 策略③：跟了两跳才拿到 200 页面 → 体里提取（跳数与提取来自同一跳）", async () => {
  const second = "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?step=2";
  const { port, world, confirmations, events } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: (url) =>
      url === R34_PLAIN_RELAY_URL
        ? { status: 302, location: second }
        : { status: 200, body: '<script>location.href="hms://redirect_uri?code=CODE&state=STATE"</script>' },
  });

  assert.equal(confirmations.length, 1, `第二跳的体里也要能提取：${JSON.stringify(events.at(-1))}`);
  assert.equal(confirmations[0].callbackUrl, R33_HMS_CALLBACK);
  assert.deepEqual(world.relayCalls().map((call) => call.url), [R34_PLAIN_RELAY_URL, second]);
  port.cancel();
});

test("R34 策略③：体里只有别的 hms 域（钓鱼形状）→ 不提取、结构化报错、不回显", async () => {
  const { port, events, confirmations } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 200, body: '<a href="hms://evil.example.com/steal?code=CODE&state=STATE">继续</a>' }),
  });

  assert.equal(confirmations.length, 0, "正则锚的是 hms://redirect_uri 精确开头：别的 hms 域一个字都不许提");
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.match(failure.message, /200/);
  assert.equal(failure.message.includes("evil.example.com"), false, "文案不许回显那个地址");
  port.cancel();
});

test("R34 三策略全败：200、体里没有字面量、参数里也没有 code → 结构化错误（不猜、不回显）", async () => {
  const { port, world, confirmations, events } = await runR33({
    callbackURL: R34_PLAIN_RELAY_URL,
    relay: () => ({ status: 200, body: "<html>登录超时，请回到首页重新发起</html>" }),
  });

  assert.equal(confirmations.length, 0);
  assert.equal(world.relayCalls().length, 1, "三条策略都试过一遍（②发请求、③看体）才认输");
  const failure = events.at(-1);
  assert.equal(failure.status, QR_LOGIN_STATUS.failed);
  assert.equal(failure.errorKind, QR_PORT_ERROR_KINDS.callbackRedirectFailed);
  assert.match(failure.message, /200/);
  assert.equal(failure.message.includes("loginCallback"), false, "文案不许回显 URL");
  assert.equal(failure.message.includes("redirect_uri="), false);
  port.cancel();
});

// ---------------------------------------------------------------------------
// R34 state 接线核实（简报点名必须核实的那一处）
//
// 问题：QR 链的 state 与 OAuth attempt 的 state 是不是**同一个**？不是同一个的话，
// `consumeCallback(expectedState: attempt.state)` 会把真机上正确的回调拒掉。
//
// 证据（真机探针存档，两条都点名了 state）：
// - `.tmp/getLoginWay.json`：CAS 跳转里的 `service` 已经嵌着**我们那张授权页查询串**，
//   包括 `state=probe-state`（probe 自己传的值）——CAS 侧是**原样回带**，不是自己另生成一个；
// - `.tmp/cas-getPageInfo-mobile.json`：移动登录页下发回来的 `localInfo.service` 同样带着
//   `state=probe-state`，而这一串就是换码请求里 `service` 字段的来源。
//
// 代码路径（一处都没换过 state）：`attempt.authorizeUrl`（含 attempt.state）
//   → `walkToCasPortal` 把整串查询当表单正文 POST 给 getLoginWay
//   → 门户页/移动页 URL（同一串参数）→ `getPageInfo` 表单 → `localInfo.service`
//   → `codeRemoteLogin` 的 `service` → `callbackURL` 的 `state` → 策略①直构 → `consumeCallback` 比对。
//
// 结论：**已经是同一个 state，不需要改接线**。下面这条用例把它钉住：
// 假世界照真机那样**从我们发出去的那串参数里取 state 回带**，最后交给**真的** consumeCallback 判。
// ---------------------------------------------------------------------------

/** CAS 门户域（`HUAWEI_QR_ENDPOINTS.casOrigin` 的字面量；白名单校验认的就是它的 origin）。 */
const CAS_ORIGIN = "https://id1.cloud.huawei.com";

/** R34 state 接线用的假世界：CAS 侧从 getLoginWay 的正文里取 state，一路原样回带（探针实测的形状）。 */
function makeR34StateWorld() {
  const calls = [];
  const loginCallbackBase = "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback";
  /** 服务端"记住"的那份授权上下文（真机上 CAS 就是这么把它嵌进 service 的）。 */
  let state = "";
  let polls = 0;

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: init.headers ?? {},
    });
    const answer = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) => headers[name.toLowerCase()] ?? null,
        getSetCookie: () => headers["set-cookie-list"] ?? [],
      },
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body ?? {});
      },
    });

    if (target.includes("/oauth2/ajax/getLoginWay")) {
      // 真机实测（.tmp/getLoginWay.json）：CAS 跳转的 service 里嵌着**我们发出去的那串参数**
      state = new URLSearchParams(String(init.body ?? "")).get("state") ?? "";
      const service =
        `${loginCallbackBase}?state=${encodeURIComponent(state)}` +
        `&redirect_uri=${encodeURIComponent("hms://redirect_uri")}&access_type=offline`;
      return answer(200, {
        isSuccess: "true",
        loginInteractInfo: { cas: { casLoginRedirectUrl: `${CAS_ORIGIN}/CAS/remoteLogin?service=${encodeURIComponent(service)}` } },
      });
    }
    if (target.startsWith(`${CAS_ORIGIN}/CAS/remoteLogin`)) {
      const service = new URL(target).searchParams.get("service") ?? "";
      return answer(302, "", {
        location:
          `${CAS_ORIGIN}:443/CAS/portal/loginAuth.html?reqClientType=90&loginChannel=90000300` +
          `&clientID=101444301&lang=zh-cn&state=${encodeURIComponent(state)}&service=${encodeURIComponent(service)}`,
      });
    }
    if (target.includes("/CAS/portal/loginAuth.html")) {
      return answer(200, "<html></html>", { "set-cookie-list": ["JSESSIONID=portal-session; Path=/"] });
    }
    if (target.includes("/CAS/mobile/standard/login.html")) {
      return answer(200, "<html></html>", { "set-cookie-list": ["CASTGC=cas-ticket; Path=/"] });
    }
    if (target.includes("/login/getPageInfo")) {
      const form = new URLSearchParams(String(init.body ?? ""));
      const service = form.get("service") ?? "";
      return answer(200, {
        isSuccess: 1,
        pageToken: PAGE_INFO.pageToken,
        pageTokenKey: PAGE_INFO.pageTokenKey,
        localInfo: {
          // 真机实测（.tmp/cas-getPageInfo-mobile.json）：这一串**带本次 state**
          service,
          state: form.get("state") ?? "",
          loginUrl: `${CAS_ORIGIN}:443/CAS/portal/loginAuth.html`,
          reqClientType: "90",
          loginChannel: "90000300",
          lang: "zh-cn",
          getqrContent: PAGE_INFO.localInfo.getqrContent,
          asyncURL: PAGE_INFO.localInfo.asyncURL,
          qrcodeRequestInterval: 2000,
        },
      });
    }
    if (target.includes("/ajaxHandler/dev")) return answer(200, { isSuccess: 1, sid: R31_SID });
    if (target.includes("/DimensionalCode/getqrInfo")) {
      return answer(200, CREATE_PAYLOAD, { "set-cookie-list": ["JSESSIONID=qr-session; Path=/"] });
    }
    if (target.includes("/DimensionalCode/async")) {
      polls += 1;
      return answer(
        200,
        polls === 1
          ? { resultCode: "103000200" }
          : { resultCode: "0", userAccount: "u", code: "c", userID: "1", siteID: "1", accountType: "1", opType: "4" },
      );
    }
    if (target.includes("/codeRemoteLogin")) {
      const service = new URLSearchParams(String(init.body ?? "")).get("service") ?? "";
      const echoed = new URL(service).searchParams.get("state") ?? "";
      // 真机那个形状：state 与 code 都在参数里（策略①据此直构）
      return answer(200, {
        isSuccess: "1",
        callbackURL: `${loginCallbackBase}?state=${encodeURIComponent(echoed)}&code=CODE&redirect_uri=${encodeURIComponent("hms://redirect_uri")}&access_type=offline`,
      });
    }
    // 注意：这里**没有** `/loginCallback` 这条路由——策略①成立时它一个请求都不该发
    throw new Error(`假 fetch 不认识这个地址：${target}`);
  };
  return { fetchImpl, calls };
}

/** 跑一遍完整的确认链（真 `createAttempt` 造的授权页 URL → 换码 → 收尾）。 */
async function runR34State(authorizeUrl) {
  const clock = timers();
  const world = makeR34StateWorld();
  const events = [];
  const confirmations = [];
  const logs = [];
  const port = createHuaweiQrPort({
    fetchImpl: world.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: (message) => logs.push(message),
    timeoutMs: null,
  });
  await port.start({
    authorizeUrl,
    onEvent: (event) => events.push(event),
    onConfirmed: (result) => confirmations.push(result),
  });
  await clock.tick(); // 未扫
  await clock.tick(); // 已确认 → 换码链
  for (let round = 0; round < 40; round += 1) await Promise.resolve();
  return { port, world, events, confirmations, logs };
}

test("R34 state 接线：确认链交回的回调，state 就是 attempt.state（一路原样回带 → consumeCallback 通过）", async () => {
  const attempt = createAttempt({ authorizeEndpoint: "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize" });
  const { port, world, confirmations, events, logs } = await runR34State(attempt.authorizeUrl);

  assert.equal(confirmations.length, 1, `state 接线通了才有回调：${JSON.stringify(events.at(-1))}`);

  // ① 我们把 attempt.state 交出去了（getLoginWay 的正文就是授权页那串查询）
  const loginWay = world.calls.find((call) => call.url.includes("getLoginWay"));
  assert.ok(loginWay);
  assert.equal(new URLSearchParams(loginWay.body).get("state"), attempt.state);

  // ② 页面配置接口（建单前那次 + 换码那次）带的是同一个 state
  const pageInfoCalls = world.calls.filter((call) => call.url.includes("/login/getPageInfo"));
  assert.ok(pageInfoCalls.length >= 2, `建单上下文一次、换码一次：${pageInfoCalls.length}`);
  for (const call of pageInfoCalls) {
    assert.equal(new URLSearchParams(call.body).get("state"), attempt.state, "state 只有一个真源：attempt.state");
  }

  // ③ 换码请求的 `service` 里也带着它（真机上它就是 localInfo.service 那一串）
  const confirm = world.calls.find((call) => call.url.includes("/codeRemoteLogin"));
  const service = new URLSearchParams(confirm.body).get("service");
  assert.equal(new URL(service).searchParams.get("state"), attempt.state);

  // ④ 策略①直构出来的回调，state 正是 attempt.state；且**没有**为中转页发过任何请求
  assert.equal(confirmations[0].callbackUrl, `hms://redirect_uri?code=CODE&state=${attempt.state}`);
  assert.equal(world.calls.some((call) => call.url.includes("/loginCallback")), false);

  // ⑤ 交给**真的** consumeCallback（auth-manager 的 finishQrLogin 用的就是它）——必须通过
  const consumed = consumeCallback(confirmations[0].callbackUrl, {
    expectedState: attempt.state,
    createdAt: attempt.createdAt,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  assert.equal(consumed.ok, true, `确认链交回的回调必须过 state 校验：${JSON.stringify(consumed)}`);
  assert.equal(consumed.data.code, "CODE");

  // 反面控制：换一个 state 就拒 —— 证明上面那条不是"校验形同虚设"
  const foreign = consumeCallback(confirmations[0].callbackUrl, {
    expectedState: "不是这一次的-state",
    createdAt: attempt.createdAt,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.kind, LOGIN_ERROR_KINDS.stateMismatch);

  assert.equal(
    logs.join("\n").includes(attempt.state),
    false,
    "state 是这次尝试的凭据，日志里一个字都不许出现",
  );
  port.cancel();
});
