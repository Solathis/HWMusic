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
      pending.set(id, fn);
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    async tick() {
      const [id, fn] = [...pending.entries()][0] ?? [];
      if (fn === undefined) return false;
      pending.delete(id);
      fn();
      for (let round = 0; round < 16; round += 1) await Promise.resolve();
      return true;
    },
    size: () => pending.size,
  };
}

function build({ pageInfo = PAGE_INFO, confirm = { isSuccess: "1", callbackURL: "hms://redirect_uri?code=CODE&state=STATE" } } = {}) {
  const clock = timers();
  const world = makeFetch({ pageInfo, confirm });
  const events = [];
  const confirmations = [];
  const port = createHuaweiQrPort({
    fetchImpl: world.fetchImpl,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    log: () => undefined,
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
