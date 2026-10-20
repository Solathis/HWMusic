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
import { QR_LOGIN_STATUS } from "../src/protocols/qr-login.mjs";

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

test("端口：建单只打无状态的二维码端点（不碰 CAS 链），pending 广播带二维码内容", async () => {
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

  const create = world.calls[0];
  assert.equal(create.url, HUAWEI_QR_ENDPOINTS.create, "建单端点就是探针登记的那一条（模板查询串原样带上）");
  const body = new URLSearchParams(create.body);
  assert.equal(body.get("appID"), "com.huawei.hwidweb");
  assert.equal(body.get("version"), "40200");
  assert.equal(body.get("confirmFlag"), "1");
  assert.equal(
    world.calls.some((call) => call.url.includes("getLoginWay")),
    false,
    "显示二维码不该先走 CAS 链：链路的失败要留到用户已经扫码之后",
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
