/**
 * R16 · B 部分：二维码登录协议与轮询状态机（`src/protocols/qr-login.mjs`）。
 *
 * 协议形状来自 R16 的实探（`scripts/probe-qr.mjs` 的可复现证据，登记在 docs/API_CONTRACT.md §1.7）：
 * 建单 `POST <getqrInfo>` 表单 `{appID, confirmFlag, version, reqClientType, loginChannel, appBrand}`
 * → `{content, qrToken, qrCode, sessionID, qrCodeCreateTime, expiredTime, version}`；
 * 轮询 `POST <asyncURL>&t=<随机>` 表单 `{qrToken}` → `{resultCode, errorDesc}`：
 * `0` = 已确认 / `103000202` = 已扫待确认 / `103000201` = 过期 / 其余（实探见 `103000200`）= 继续轮询。
 *
 * 三条硬要求（先写先看红）：
 * 1. **认不出的 resultCode 不许当成功**：一律按"继续轮询"处理并留痕（把陌生码当 confirmed
 *    就是拿一个没确认的会话去换令牌）；
 * 2. **状态变化才广播**：轮询 2 秒一次、扫码要几分钟，每次 tick 都广播会把通道刷成噪声；
 * 3. **过期只报不换**（R21 用户指令 **推翻** R16/R20 的"过期自己重建"）：过期是一条**终点**
 *    广播——停轮询、不建新单，换新只能由用户手动触发（渲染层再发一次 `auth:qr-start`，
 *    端口本来就是 restart 语义）。原来的理由是"渲染层什么都做不了"，但那样用户会看到码
 *    在眼皮底下自己换掉、却不知道自己该做什么；现在过期态明确停住并请用户点刷新。
 *
 * R22（用户真机反馈两项：① 倒计时到 0 后卡在「正在确认过期…」一直不过期；② 过期时间正确性）
 * 增补三组断言，都写在文件末尾：
 * 1. **TTL 无偏差换算**：两个服务端值相减（本地钟偏多少都不平移倒计时）、缺 `qrCodeCreateTime`
 *    才回退老公式（偏差风险已知）、字段不可信或两值矛盾 → `null`（不猜）；
 * 2. **熔断**：连续 5 个认不出的 `resultCode` → `failed`（`unknown_result_code`）+ 停轮询，
 *    中间认出一个码就重新计数；
 * 3. **本地到期兜底**：到期锚 + 宽限的**边界逐个钉**（锚前不触发 / 差 1ms 不触发 /
 *    到点触发 / 服务端先到或仍在说话时一律让位 / 没有可信 TTL 就不设锚），外加每轮诊断日志的脱敏。
 *
 * R26（用户真机反馈之 3：倒计时到 0 之后「正在确认过期…」要等很久才变过期）把兜底的**落点**
 * 换了：R22 挂在**轮询落地点**上（轮询间隔 2 秒、实探一次往返 ~8 秒 + 15 秒宽限 → 最长 ~25 秒），
 * R26 改成**建单/刷新时就挂一个一次性定时器**（到期锚 + 3 秒），到点即裁决；轮询落地点那条路
 * 保留成第二张网；**服务端一律优先**（它说过 expired/scanned/confirmed 时这张网让位）。文件末尾
 * 的 R26 段用"按延迟精确取用"的假计时器钉住它（与 `harness` 的"推进一步"语义分开，互不干扰）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  QR_DEFAULT_MAX_UNKNOWN_CODES,
  QR_ERROR_DESC_MAX,
  QR_ERROR_KINDS,
  QR_LOCAL_EXPIRY_GRACE_MS,
  QR_LOGIN_STATUS,
  QR_RESULT_CODES,
  buildQrCreateBody,
  buildQrPollBody,
  classifyQrPoll,
  createQrSession,
  describeQrContent,
  parseQrCreate,
  qrCreateRequestUrl,
  sanitizeErrorDesc,
} from "../src/protocols/qr-login.mjs";

/** 建单端点的实探形状（探针里的模板查询串原样搬来）。 */
const CREATE_URL =
  "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo?appID=com.huawei.hwidweb&loginChannel=7000700&reqClientType=700&confirmFlag=1&version=40200&appBrand=HUAWEI";
const POLL_URL = "https://id1.cloud.huawei.com/DimensionalCode/async?version=40200";

const createPayload = (overrides = {}) => ({
  content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=PROBE&loginChannel=7000700&reqClientType=700",
  qrCode: "PROBE-QR-CODE",
  qrToken: "0123456789abcdef0123456789abcdef",
  sessionID: "session-1",
  qrCodeCreateTime: 1_700_000_000_000,
  expiredTime: 1_700_000_000_000 + 181_000,
  version: "40200",
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. 轮询结果分类：认不出的码按"继续轮询"，绝不猜成功
// ---------------------------------------------------------------------------

test("分类：0=已确认 / 103000202=已扫待确认 / 103000201=过期 / 其余=继续轮询", () => {
  assert.equal(classifyQrPoll({ resultCode: "0" }).status, QR_LOGIN_STATUS.confirmed);
  assert.equal(classifyQrPoll({ resultCode: "103000202" }).status, QR_LOGIN_STATUS.scanned);
  assert.equal(classifyQrPoll({ resultCode: "103000201" }).status, QR_LOGIN_STATUS.expired);
  // 实探见到的这一档（服务端原话 "Please to login."）：未扫 = 继续轮询
  assert.equal(classifyQrPoll({ resultCode: "103000200" }).status, QR_LOGIN_STATUS.pending);
});

test("分类：认不出的 resultCode 按继续轮询处理并留痕，绝不当作已确认", () => {
  const unknown = classifyQrPoll({ resultCode: "999999999" });
  assert.equal(unknown.status, QR_LOGIN_STATUS.pending);
  assert.equal(unknown.unknownResultCode, "999999999", "陌生的码要带出来，便于排查协议变更");
  assert.equal(classifyQrPoll({ resultCode: 0 }).status, QR_LOGIN_STATUS.confirmed, "数字 0 也是确认");
  assert.equal(classifyQrPoll({}).status, QR_LOGIN_STATUS.pending, "没有 resultCode = 还没结果，不是成功");
  assert.equal(classifyQrPoll(null).status, QR_LOGIN_STATUS.pending);
  assert.equal(QR_RESULT_CODES.confirmed, "0");
  assert.equal(QR_RESULT_CODES.expired, "103000201");
  assert.equal(QR_RESULT_CODES.scanned, "103000202");
});

test("分类：已确认时把整份载荷带出来（兑换链要 userAccount/code 这些字段）", () => {
  const payload = { resultCode: "0", userAccount: "u***", code: "c", siteID: "1", accountType: "1" };
  const classified = classifyQrPoll(payload);
  assert.equal(classified.status, QR_LOGIN_STATUS.confirmed);
  assert.equal(classified.payload, payload, "确认载荷原样交给上层，本层不挑字段");
});

// ---------------------------------------------------------------------------
// 2. 建单响应解析
// ---------------------------------------------------------------------------

test("建单解析：content/qrToken 齐备才算成功，有效期由 expiredTime 给出", () => {
  const now = 1_700_000_000_000;
  const parsed = parseQrCreate(createPayload(), { now: () => now });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.content.endsWith("qRCode=PROBE&loginChannel=7000700&reqClientType=700"), true);
  assert.equal(parsed.data.qrToken, "0123456789abcdef0123456789abcdef");
  assert.equal(parsed.data.expiresInMs, 181_000, "有效期 = expiredTime − qrCodeCreateTime（R22 起走双服务端值；本夹具两值之差恰为 181s）");
  assert.equal(parsed.data.qrCode, "PROBE-QR-CODE");
});

test("建单解析：缺 content 或 qrToken 一律结构化失败（半份数据不能去渲染二维码）", () => {
  for (const overrides of [{ content: "" }, { qrToken: "" }, { content: undefined }, { qrToken: undefined }]) {
    const parsed = parseQrCreate(createPayload(overrides), { now: () => 1_700_000_000_000 });
    assert.equal(parsed.ok, false, `缺字段必须失败：${JSON.stringify(overrides)}`);
    assert.equal(parsed.error.kind, QR_ERROR_KINDS.invalidResponse);
  }
  assert.equal(parseQrCreate(null).ok, false);
  assert.equal(parseQrCreate("not-an-object").ok, false);
});

test("建单解析：expiredTime 不可信时不编造有效期（回落到 null，由调用方用自己的期限）", () => {
  const parsed = parseQrCreate(createPayload({ expiredTime: "soon" }), { now: () => 1_700_000_000_000 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.expiresInMs, null);
});

// ---------------------------------------------------------------------------
// 3. 请求体构造：参数从端点模板里取，不在这里写死第二份
// ---------------------------------------------------------------------------

test("建单表单：六个参数从端点模板查询串里取（唯一真源是探针登记的那个模板）", () => {
  const body = new URLSearchParams(buildQrCreateBody(CREATE_URL));
  assert.deepEqual([...body.keys()].sort(), [
    "appBrand",
    "appID",
    "confirmFlag",
    "loginChannel",
    "reqClientType",
    "version",
  ]);
  assert.equal(body.get("appID"), "com.huawei.hwidweb");
  assert.equal(body.get("version"), "40200");
  assert.equal(buildQrCreateBody(CREATE_URL, { extra: { deviceID: "d1", deviceType: "7" } }).includes("deviceID=d1"), true);
});

test("轮询表单：只有 qrToken（多带字段就是第二份协议猜测）", () => {
  assert.equal(buildQrPollBody("tok"), "qrToken=tok");
});

// ---------------------------------------------------------------------------
// 4. 会话状态机（注入 fetch/计时器/时钟：不碰真实网络与真实时间）
// ---------------------------------------------------------------------------

/** 假世界：手动推进的计时器 + 可编排的 fetch 响应。 */
function harness({ createResponses, pollResponses, intervalMs = 2000 }) {
  const timers = new Map();
  let nextTimerId = 1;
  const scheduled = [];
  const setTimer = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, delay: ms });
    scheduled.push(ms);
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  /**
   * 跑到**最早到点**的那个挂起计时器（一次只推进一步：状态机的每一步都单独可断言）。
   *
   * 按延迟排序而不是"谁先挂上谁先跑"（R26 改）：真实时间是这么走的，而 R26 起会话里同时挂着
   * 轮询（2 秒）与本地到期兜底（TTL + 宽限，几分钟后）两张网——按插入顺序推会让"下一步"变成
   * 那张远未来的网，每个用例的每一步都错位。
   */
  const tick = async () => {
    let pick = null;
    for (const [id, entry] of timers) {
      if (pick === null || entry.delay < pick.entry.delay) pick = { id, entry };
    }
    if (pick === null) return false;
    timers.delete(pick.id);
    pick.entry.fn();
    // 被测代码是一串 await（fetch → text → 事件 → 排下一次轮询）：把微任务队列抽干再断言
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
    return true;
  };
  /** 按**延迟**精确跑一个挂起的计时器（专给"远未来"的那张网：总期限 / 本地到期）。 */
  const fireDelay = async (ms) => {
    const found = [...timers.entries()].find(([, entry]) => entry.delay === ms);
    assert.ok(found !== undefined, `没有延迟为 ${ms} 的挂起计时器：${JSON.stringify([...timers.values()].map((e) => e.delay))}`);
    timers.delete(found[0]);
    found[1].fn();
    for (let round = 0; round < 12; round += 1) await Promise.resolve();
    return true;
  };

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const isCreate = String(url).includes("getqrInfo");
    const queue = isCreate ? createResponses : pollResponses;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      async text() {
        return typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
      },
    };
  };

  const events = [];
  return { setTimer, clearTimer, tick, fireDelay, fetchImpl, calls, events, intervalMs, scheduled };
}

test("会话：start 建单 → 广播 pending（带二维码内容）→ 轮询到已扫/已确认各广播一次", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [
      { body: { resultCode: "103000200", errorDesc: "Please to login." } },
      { body: { resultCode: "103000202" } },
      { body: { resultCode: "0", userAccount: "u", code: "c", siteID: "1", accountType: "1" } },
      { body: { resultCode: "0" } },
    ],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  const started = await session.start();
  assert.equal(started.ok, true);
  assert.equal(world.events.length, 1);
  assert.equal(world.events[0].status, QR_LOGIN_STATUS.pending);
  assert.equal(world.events[0].expiresInMs, 181_000);
  assert.match(world.events[0].content, /qrcode\/login\.jsp/);
  assert.equal(world.scheduled[0], world.intervalMs, "第一次轮询按服务端给的间隔（2 秒）");

  await world.tick(); // pending：状态没变 → 不重复广播
  assert.equal(world.events.length, 1, "未扫的这一档不该每 2 秒刷一条广播");

  await world.tick(); // scanned
  await world.tick(); // confirmed
  assert.deepEqual(
    world.events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.scanned, QR_LOGIN_STATUS.confirmed],
  );
  assert.equal(world.events.at(-1).payload.code, "c", "确认载荷要交给兑换链");
  assert.equal(session.isRunning(), false, "确认之后必须停下：不能再轮询，也不能留着计时器");
  assert.equal(await world.tick(), false, "确认后没有挂起的轮询");
  assert.equal(String(world.calls.at(-1).body), "qrToken=0123456789abcdef0123456789abcdef");
});

test("会话：二维码过期 → 只广播 expired 并停轮询，不再自动换新（R21 用户指令推翻 R16/R20）", async () => {
  const world = harness({
    createResponses: [
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=FIRST", qrToken: "tok-1" }) },
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=SECOND", qrToken: "tok-2" }) },
    ],
    pollResponses: [{ body: { resultCode: "103000201" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  // 一次 tick = 一次轮询：拿到"过期"
  await world.tick();

  assert.deepEqual(
    world.events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.expired],
    "过期是终点档：不许紧跟着再播一张新码（换新只能由用户手动触发）",
  );
  assert.equal(
    world.calls.filter((call) => call.url.includes("getqrInfo")).length,
    1,
    "过期不许自己再建一张单（R21 删掉的就是这一步）",
  );
  assert.equal(session.isRunning(), false, "过期之后停轮询：不再每 2 秒在后台打点");
  assert.equal(await world.tick(), false, "过期之后一个挂起的计时器都不剩（轮询与总期限都停）");
  assert.equal(session.status(), QR_LOGIN_STATUS.expired);
});

test("会话：过期之后由**用户**再 start 才换新码，倒计时/轮询随之重新开始", async () => {
  const world = harness({
    createResponses: [
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=FIRST", qrToken: "tok-1" }) },
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=SECOND", qrToken: "tok-2" }) },
    ],
    pollResponses: [{ body: { resultCode: "103000201" } }, { body: { resultCode: "103000200" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  await world.tick(); // 过期：停下
  assert.equal(session.isRunning(), false);

  const restarted = await session.start(); // 用户点了「刷新二维码」
  assert.equal(restarted.ok, true);
  assert.match(session.current().content, /qRCode=SECOND/);
  assert.equal(session.isRunning(), true, "手动刷新之后重新开始轮询");

  await world.tick(); // 新会话的第一次轮询：仍是"未扫"
  assert.equal(
    world.events.at(-1).status,
    QR_LOGIN_STATUS.pending,
    "新码仍停在 pending（状态没变所以不重复广播）——它是一张真的、可扫的码",
  );
});

test("会话：连续网络失败按次数收口成 failed（不无限重试，也不假装还活着）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [new Error("ECONNRESET")],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    maxPollFailures: 2,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  await world.tick();
  assert.equal(world.events.length, 1, "第一次失败还留着机会（网络抖一下不等于登录坏了）");
  await world.tick();
  assert.equal(world.events.at(-1).status, QR_LOGIN_STATUS.failed);
  assert.equal(session.isRunning(), false);
  assert.equal(await world.tick(), false, "收口后不再安排轮询");
});

test("会话：建单本身就失败 → start 返回结构化错误 + 广播 failed（不是静默不显示二维码）", async () => {
  const world = harness({ createResponses: [{ body: { error: "nope" }, status: 200 }], pollResponses: [] });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  const started = await session.start();
  assert.equal(started.ok, false);
  assert.equal(world.events.at(-1).status, QR_LOGIN_STATUS.failed);
  assert.equal(session.isRunning(), false);
});

test("会话：端点没配就是结构化 missing_endpoint，一次请求都不发", async () => {
  const world = harness({ createResponses: [], pollResponses: [] });
  const session = createQrSession({
    createUrl: "",
    pollUrl: POLL_URL,
    fetchImpl: world.fetchImpl,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });
  const started = await session.start();
  assert.equal(started.ok, false);
  assert.equal(started.error.kind, QR_ERROR_KINDS.missingEndpoint);
  assert.deepEqual(world.calls, [], "端点未知不许猜一个地址打过去");
});

test("会话：cancel 之后不再轮询、不再广播（用户关了门禁就别在后台刷）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103000200" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  session.cancel();
  assert.equal(session.isRunning(), false);
  assert.equal(await world.tick(), false, "取消后没有挂起的轮询");
  assert.equal(world.events.length, 1);
});

test("会话：总期限到了就收口成 failed（二维码会自动续期，不能无限在后台轮询）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103000200" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    deadlineMs: 10 * 60_000,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  assert.equal(world.scheduled.includes(10 * 60_000), true, "总期限要真的排上（否则过期重建会让它永远跑下去）");
  await world.fireDelay(10 * 60_000); // 总期限到点（按延迟精确取用：轮询那张 2 秒的更早，不该替它先跑）

  assert.equal(world.events.at(-1).status, QR_LOGIN_STATUS.failed);
  assert.match(world.events.at(-1).message, /超时/);
  assert.equal(session.isRunning(), false);
  assert.equal(await world.tick(), false, "收口后连轮询计时器一起清掉");
});

test("会话：start 之前的状态是 idle，重复 start 不会开出第二条轮询链", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103000200" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  assert.equal(session.status(), QR_LOGIN_STATUS.idle);
  await session.start();
  await session.start();
  assert.equal(world.calls.filter((call) => call.url.includes("getqrInfo")).length, 2, "第二次 start 是重新建单（用户重试语义）");
  assert.equal(session.isRunning(), true);
});

// ---------------------------------------------------------------------------
// R20：活动会话期间重启（手动刷新）—— 迟到的旧会话事件一律不许广播
// R21（用户指令）：过期不再自动换新，于是"换一张新码"这条路只剩手动一条
// ---------------------------------------------------------------------------

test("会话：取消之后才落地的轮询响应不再广播（迟到的「过期」不许顶掉新码）", async () => {
  const world = harness({ createResponses: [{ body: createPayload() }], pollResponses: [] });
  let releasePoll;
  const inFlight = new Promise((resolve) => {
    releasePoll = resolve;
  });
  let polls = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("getqrInfo")) {
      return { ok: true, status: 200, async text() { return JSON.stringify(createPayload()); } };
    }
    polls += 1;
    await inFlight; // 这一次轮询挂住：模拟"请求在飞的时候用户按了刷新"
    return { ok: true, status: 200, async text() { return JSON.stringify({ resultCode: "103000201" }); } };
  };
  const events = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => events.push(event),
  });

  await session.start();
  await world.tick(); // 轮询发出（挂在 inFlight 上）
  session.cancel();
  releasePoll();
  for (let round = 0; round < 16; round += 1) await Promise.resolve();

  assert.deepEqual(
    events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending],
    "取消之后到达的「过期」不许广播（否则界面上刚刷出来的那张新码会被这一档打回过期态）",
  );
  assert.equal(polls, 1, "挂住的那次轮询确实发出去过（这条断言不是空转）");
  assert.equal(session.isRunning(), false);
});

test("会话：过期之后手动刷新，current() 报的是新那张（换码链要带当前这张的 qrCode）", async () => {
  const world = harness({
    createResponses: [
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=OLD", qrCode: "R-OLD", qrToken: "tok-old" }) },
      { body: createPayload({ content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=NEW", qrCode: "R-NEW", qrToken: "tok-new" }) },
    ],
    pollResponses: [{ body: { resultCode: "103000201" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: () => undefined,
  });

  await session.start();
  assert.equal(session.current().qrCode, "R-OLD");
  await world.tick(); // 过期：停轮询（R21 起不换新，手上仍是那张已作废的码）
  assert.equal(session.current().qrCode, "R-OLD", "过期本身不换码：作废的那张留着只为诊断，不会再有 confirmed 去读它");

  await session.start(); // 用户手动刷新
  assert.match(session.current().content, /qRCode=NEW/);
  assert.equal(session.current().qrCode, "R-NEW", "换新之后当前那张是新码：拿旧 qrCode 去换码只会换回一次失败");
});

// ---------------------------------------------------------------------------
// R22（用户真机反馈两项）· A：TTL 无偏差换算
//
// 老公式 `expiredTime − 本地 now()` 把**两个时钟**相减，本地钟偏多少、倒计时就平移多少
// （RED 实测：本地钟快 1 小时 → `expiresInMs` 直接 0，倒计时一上来就归零；慢 1 小时 →
// 63 分钟）。R22 改成两个**都是服务端值**的字段相减：`expiredTime − qrCodeCreateTime`。
// ---------------------------------------------------------------------------

test("R22 建单解析：有效期取两个服务端值之差——本地钟偏多少都不平移倒计时", () => {
  const server = 1_700_000_000_000;
  const payload = createPayload({ qrCodeCreateTime: server, expiredTime: server + 181_000 });
  // 0 = 对表；±1 分钟 = 小偏差；±1 小时 / +1 天 = 真机上见得到的偏差档
  for (const skew of [0, 60_000, -60_000, 3_600_000, -3_600_000, 86_400_000]) {
    const parsed = parseQrCreate(payload, { now: () => server + skew });
    assert.equal(parsed.ok, true);
    assert.equal(
      parsed.data.expiresInMs,
      181_000,
      `本地钟偏 ${skew}ms 不该改变有效期（老公式在这里会给出 181000 - ${skew}，还可能直接 ≤ 0）`,
    );
  }
});

test("R22 建单解析：qrCodeCreateTime 缺失/非法 → 回退 expiredTime − now()（偏差风险写在源码注释里）", () => {
  const server = 1_700_000_000_000;
  for (const broken of [undefined, null, "", "soon", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = parseQrCreate(createPayload({ qrCodeCreateTime: broken }), { now: () => server });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.expiresInMs, 181_000, `回退路径要真的给出有效期：qrCodeCreateTime=${String(broken)}`);
  }
  // 回退路径**确实**以本地钟为基准（这正是它的代价：钟偏多少，倒计时平移多少）
  const skewed = parseQrCreate(createPayload({ qrCodeCreateTime: undefined }), { now: () => server + 60_000 });
  assert.equal(skewed.data.expiresInMs, 121_000, "缺 createTime 时只能拿本地 now() 当基准（已知偏差风险，不是意外）");
});

test("R22 建单解析：字段不可信/互相矛盾一律 null（不猜一个 TTL 出来）", () => {
  const server = 1_700_000_000_000;
  for (const broken of [undefined, null, "", "soon", 0, -1]) {
    const parsed = parseQrCreate(createPayload({ expiredTime: broken }), { now: () => server });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.expiresInMs, null, `expiredTime=${String(broken)} 时不许编造有效期`);
  }
  // 两个服务端值互相矛盾（到期不晚于建单）：宁可没有倒计时，也不猜一个数出来
  for (const expiredTime of [server, server - 1_000]) {
    const parsed = parseQrCreate(createPayload({ qrCodeCreateTime: server, expiredTime }), { now: () => server });
    assert.equal(parsed.data.expiresInMs, null, "矛盾的一对服务端值不猜");
  }
});

// ---------------------------------------------------------------------------
// R22 · B1：未知 resultCode 熔断
//
// RED 实测：连着 5 个陌生码，会话仍在轮询（`isRunning: true`）。协议真要变了，
// 这条会话会一直 2 秒一次打到总期限，用户全程看着一张不会变的界面。
// ---------------------------------------------------------------------------

test("R22 熔断：连续 5 个不认识的 resultCode → failed 带 unknownResultCode 并停轮询", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103009999", errorDesc: "?" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  assert.equal(QR_DEFAULT_MAX_UNKNOWN_CODES, 5, "熔断阈值是契约值：连续 5 个陌生码");
  for (let round = 1; round <= QR_DEFAULT_MAX_UNKNOWN_CODES - 1; round += 1) {
    await world.tick();
    assert.equal(session.isRunning(), true, `还只见到 ${round} 个陌生码：给协议变更留出余量，不许急着判死`);
  }

  await world.tick(); // 第 5 个
  const last = world.events.at(-1);
  assert.equal(last.status, QR_LOGIN_STATUS.failed, "连续陌生码是一条终点：不能无限轮询下去");
  assert.equal(last.errorKind, QR_ERROR_KINDS.unknownResultCode, "失败类别要说清是「认不出的码」");
  assert.match(last.message, /103009999/, "把那颗陌生的码带进文案（排查协议变更的第一手线索）");
  assert.equal(session.isRunning(), false);
  assert.equal(await world.tick(), false, "熔断之后不再安排轮询");
  assert.equal(
    world.calls.filter((call) => call.url.includes("DimensionalCode/async")).length,
    QR_DEFAULT_MAX_UNKNOWN_CODES,
    "整整 5 次请求：熔断判据是「连续」，不是提前收口",
  );
});

test("R22 熔断：中间认出一个码就重新计数（陌生的码不跨档累计）", async () => {
  const unknown = { body: { resultCode: "103009999" } };
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [
      unknown,
      unknown,
      unknown,
      unknown,
      { body: { resultCode: "103000200", errorDesc: "Please to login." } }, // 认得出 → 计数归零
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  for (let round = 1; round <= 9; round += 1) await world.tick(); // 4 陌生 + 1 认得 + 4 陌生
  assert.equal(session.isRunning(), true, "「连续」是字面意思：中间那条 103000200 让计数归零");
  assert.equal(session.status(), QR_LOGIN_STATUS.pending);

  await world.tick(); // 归零之后的第 5 个陌生码
  assert.equal(session.status(), QR_LOGIN_STATUS.failed);
  assert.equal(session.isRunning(), false);
});

test("R22 熔断：阈值可注入（时钟之外，判据本身也是注入的）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "1" } }],
  });
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    maxUnknownCodes: 2,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
  });

  await session.start();
  await world.tick();
  assert.equal(session.isRunning(), true);
  await world.tick();
  assert.equal(session.status(), QR_LOGIN_STATUS.failed);
});

// ---------------------------------------------------------------------------
// R22 · B2：本地到期权威兜底
//
// 用户那句"卡在正在确认过期…一直不过期"要有一个**必有**的出口：`expiredTime` 已过 +
// 宽限 15 秒仍未收到服务端 `expired` → 主动转 `expired`（停轮询 + 广播）。
// 边界全部注入时钟钉死：过期前不触发 / 过期 +14.999s 不触发 / +15s 触发 /
// 服务端先到（或仍在说话：scanned/confirmed）以服务端为准。
// ---------------------------------------------------------------------------

/**
 * R22 兜底专用的假世界：**钟可以被推**（到期锚是一条时间线，跨过它才谈得上兜底），
 * 其余与 `harness` 同一套（手动计时器 + 编排好的轮询响应）。
 *
 * @param {{pollResponses: Array<object|Error>, ttlMs?: number, startMs?: number,
 *          createOverrides?: object}} options
 */
function expiryWorld({ pollResponses, ttlMs = 181_000, startMs = 1_700_000_000_000, createOverrides = {} }) {
  const world = harness({
    createResponses: [{ body: createPayload({ qrCodeCreateTime: startMs, expiredTime: startMs + ttlMs, ...createOverrides }) }],
    pollResponses,
  });
  let clock = startMs;
  const logs = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => clock,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: (event) => world.events.push(event),
    log: (message) => logs.push(message),
  });
  return {
    world,
    session,
    logs,
    /** 本地到期锚 = 建单响应落地那一刻的本地钟 + 服务端 TTL（`expiresInMs`）。 */
    anchor: () => startMs + ttlMs,
    at: (value) => {
      clock = value;
    },
  };
}

test("R22 兜底：服务端一直说 pending，本地到期锚 + 宽限到点 → 主动转 expired 并停轮询", async () => {
  const at = expiryWorld({ pollResponses: [{ body: { resultCode: "103000200", errorDesc: "Please to login." } }] });
  assert.equal(QR_LOCAL_EXPIRY_GRACE_MS, 3_000, "宽限是契约值（R26 起 3 秒：R22 那 15 秒是在替「轮询落地点」那条路补时间，现在由一次性定时器顶上）");
  await at.session.start();

  // 到期锚**之前**：本地不许抢跑（服务端还没说过期，码也许还能扫）
  at.at(at.anchor() - 1);
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending);
  assert.equal(at.session.isRunning(), true);

  // 过期 +14.999s：仍在宽限里，继续等服务端
  at.at(at.anchor() + QR_LOCAL_EXPIRY_GRACE_MS - 1);
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending, "还差 1ms 才到宽限：不许提前判死");
  assert.equal(at.session.isRunning(), true);

  // 过期 +15s：必须出口（「正在确认过期…」最长挂 15 秒）
  at.at(at.anchor() + QR_LOCAL_EXPIRY_GRACE_MS);
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.expired, "到期 + 宽限到点：本地兜底收回这一次会话");
  assert.equal(at.session.isRunning(), false);
  assert.equal(await at.world.tick(), false, "兜底转过期之后一个挂起的计时器都不剩");
  assert.deepEqual(
    at.world.events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.expired],
    "expired 是终点档：兜底这条路也只播这一条",
  );
  assert.equal(
    at.logs.some((line) => line.includes("本地到期")),
    true,
    "兜底是一次**主动裁决**：日志里要留下它（否则线上看不出这次 expired 从哪来）",
  );
});

test("R22 兜底：服务端先给出 expired → 以服务端为准（本地锚还没到也照收）", async () => {
  const at = expiryWorld({ pollResponses: [{ body: { resultCode: "103000201" } }] });
  await at.session.start();
  at.at(at.anchor() - 60_000); // 本地还早得很

  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.expired, "服务端说了过期就是过期");
  assert.equal(at.session.isRunning(), false);
  assert.equal(
    at.logs.some((line) => line.includes("本地到期")),
    false,
    "服务端先到：兜底那条路根本不该被走到（服务端广播优先）",
  );
});

test("R22 兜底：服务端仍在说话（scanned / confirmed）时不许抢——服务端是权威", async () => {
  // 已经本地过期一小时，但服务端说"已扫码"：会话还活着，本地不许把它判死
  const scanned = expiryWorld({ pollResponses: [{ body: { resultCode: "103000202" } }] });
  await scanned.session.start();
  scanned.at(scanned.anchor() + 3_600_000);
  await scanned.world.tick();
  assert.equal(scanned.session.status(), QR_LOGIN_STATUS.scanned);
  assert.equal(scanned.session.isRunning(), true, "服务端有话说的时候，本地兜底让位（继续轮询到服务端收口）");

  // 同理：兜底绝不许把一次已经成功的确认打回过期
  const confirmed = expiryWorld({ pollResponses: [{ body: { resultCode: "0", code: "c" } }] });
  await confirmed.session.start();
  confirmed.at(confirmed.anchor() + 3_600_000);
  await confirmed.world.tick();
  assert.equal(confirmed.session.status(), QR_LOGIN_STATUS.confirmed);
  assert.equal(confirmed.session.isRunning(), false);
});

test("R22 兜底：建单没给出可信 TTL 时**不设锚点** → 一次都不主动判过期（不猜）", async () => {
  const at = expiryWorld({
    pollResponses: [{ body: { resultCode: "103000200" } }],
    createOverrides: { expiredTime: "soon" },
  });
  await at.session.start();
  at.at(at.anchor() + 3_600_000); // 锚点根本不存在，推多远都不该有本地裁决
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending);
  assert.equal(at.session.isRunning(), true, "没有可信 TTL 就没有本地权威：宁可等服务端");
});

test("R22 兜底：网络断了又确实过了期 → 也走 expired 出口（不是把用户挂在等待上）", async () => {
  const at = expiryWorld({ pollResponses: [new Error("ECONNRESET")] });
  await at.session.start();

  // 还没到期：网络失败照旧按次数收口（既有语义不变）
  at.at(at.anchor() - 1_000);
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending);

  at.at(at.anchor() + QR_LOCAL_EXPIRY_GRACE_MS);
  await at.world.tick();
  assert.equal(at.session.status(), QR_LOGIN_STATUS.expired, "到期 + 宽限已过：网络坏不坏都不该让用户继续等");
  assert.equal(at.session.isRunning(), false);
});

// ---------------------------------------------------------------------------
// R22 · B3：轮询诊断日志（脱敏）
//
// RED 实测：轮询里除了"陌生码"那一句，没有一行 resultCode。真机卡住时，日志上看不出
// 是在轮询、还是轮询早就断了。R22 起**每轮记一行**：只有轮次与状态码。
// ---------------------------------------------------------------------------

test("R22 诊断：每轮 resultCode 进日志（只有轮次与状态码，没有 qrToken、没有二维码内容）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103000200", errorDesc: "Please to login." } }],
  });
  const logs = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: () => undefined,
    log: (message) => logs.push(message),
  });

  await session.start();
  await world.tick();
  await world.tick();
  await world.tick();

  const rounds = logs.filter((line) => line.includes("轮询 #"));
  assert.equal(rounds.length, 3, "每轮一行：真机卡住时要看得出轮询到底有没有在跑");
  assert.match(rounds[0], /轮询 #1/);
  assert.match(rounds.at(-1), /轮询 #3/);
  for (const line of rounds) assert.match(line, /resultCode=103000200/);
  const joined = logs.join("\n");
  assert.equal(joined.includes(createPayload().qrToken), false, "日志里不许出现 qrToken（会话令牌只在进程内用）");
  assert.equal(joined.includes("qRCode=PROBE"), false, "日志里不许出现二维码内容");
});

test("R22 诊断：认不出的码每轮都留痕，并记下它连续第几个（熔断前一目了然）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103009999" } }],
  });
  const logs = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: () => undefined,
    log: (message) => logs.push(message),
  });

  await session.start();
  await world.tick();
  await world.tick();

  assert.equal(
    logs.some((line) => line.includes("103009999") && line.includes("连续 2/5")),
    true,
    `连续计数要写进日志：${JSON.stringify(logs)}`,
  );
  assert.equal(
    logs.some((line) => line.includes("停止轮询")),
    false,
    "还没到阈值：这一轮只是继续等，不喊停",
  );
});

test("R22 诊断：熔断那一刻留下一条说明（为什么停）", async () => {
  const world = harness({
    createResponses: [{ body: createPayload() }],
    pollResponses: [{ body: { resultCode: "103009999" } }],
  });
  const logs = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => 1_700_000_000_000,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: () => undefined,
    log: (message) => logs.push(message),
  });

  await session.start();
  for (let round = 0; round < QR_DEFAULT_MAX_UNKNOWN_CODES; round += 1) await world.tick();

  assert.equal(
    logs.filter((line) => line.includes("停止轮询")).length,
    1,
    "熔断是一条一次性说明，不是每轮都喊",
  );
});

// ---------------------------------------------------------------------------
// R26 · 用户真机反馈之 3：过期出口太慢（兜底改挂一次性定时器）
//
// RED（用户真机）：倒计时数到 0 之后「正在确认过期…」要等**很久**才变过期。根因是落点：
// R22 的兜底只在**轮询落地**那一步检查（轮询间隔 2 秒、实探一次往返 ~8 秒），再叠 15 秒宽限
// → 最长 ~25 秒。R26 改成"建单/刷新时就把那个时刻**排进计时器**"（到期锚 + 3 秒），到点即裁决，
// 与轮询在不在飞、飞多久都无关；轮询落地点仍是第二张网；服务端一律优先。
//
// 为什么单独一套假计时器：`harness.tick()` 是"推进一步"的顺序语义（第一个挂上的先跑），
// 多挂一个远未来的计时器会把既有用例的每一步都错位；R26 要断言的是**延迟本身**与
// "到点那一刻发生了什么"，所以这里按延迟精确取用。
// ---------------------------------------------------------------------------

/**
 * R26 到期定时器专用假世界：`setTimer` 把 `(fn, 延迟)` 都记下来，测试可以按延迟精确触发。
 *
 * @param {{ttlMs?: number, startMs?: number, createOverrides?: object,
 *          pollResponses?: Array<object|Error>}} [options]
 */
function expiryTimerWorld({
  ttlMs = 181_000,
  startMs = 1_700_000_000_000,
  createOverrides = {},
  pollResponses = [{ body: { resultCode: "103000200", errorDesc: "Please to login." } }],
} = {}) {
  const pending = new Map();
  let nextId = 1;
  let clock = startMs;
  let pollRound = 0;
  const events = [];
  const logs = [];

  const setTimer = (fn, delay) => {
    const id = nextId++;
    pending.set(id, { delay, fn });
    return id;
  };
  const clearTimer = (id) => {
    pending.delete(id);
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("getqrInfo")) {
      const body = createPayload({ qrCodeCreateTime: startMs, expiredTime: startMs + ttlMs, ...createOverrides });
      return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    }
    const next = pollResponses.length > 1 ? pollResponses[Math.min(pollRound++, pollResponses.length - 1)] : pollResponses[0];
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, async text() { return JSON.stringify(next.body ?? {}); } };
  };

  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: 2_000,
    fetchImpl,
    now: () => clock,
    setTimer,
    clearTimer,
    onEvent: (event) => events.push(event),
    log: (message) => logs.push(message),
  });

  const world = {
    session,
    events,
    logs,
    /** 本地到期锚 = 建单响应落地那一刻的本地钟 + 服务端 TTL。 */
    anchor: () => startMs + ttlMs,
    at: (value) => {
      clock = value;
    },
    /** 挂起的计时器（延迟列表，升序）。 */
    timers: () => [...pending.values()].map((entry) => entry.delay).sort((left, right) => left - right),
    /** 按延迟精确触发一个挂起的计时器（轮询那张 = 2000；到期那张 = TTL + 宽限）。 */
    async fire(delay) {
      const found = [...pending.entries()].find(([, entry]) => entry.delay === delay);
      assert.ok(found !== undefined, `没有延迟为 ${delay} 的挂起计时器：${JSON.stringify(world.timers())}`);
      pending.delete(found[0]);
      found[1].fn();
      for (let round = 0; round < 12; round += 1) await Promise.resolve();
      return true;
    },
    /** 走一轮轮询（轮询那张计时器到点）。 */
    poll: () => world.fire(2_000),
  };
  return world;
}

test("R26 宽限：契约值 3 秒，且建单落地就挂上一次性到期定时器（延迟 = 服务端 TTL + 宽限）", async () => {
  const at = expiryTimerWorld();
  await at.session.start();

  assert.equal(QR_LOCAL_EXPIRY_GRACE_MS, 3_000, "宽限是契约值：3 秒");
  assert.deepEqual(
    at.timers(),
    [2_000, 181_000 + QR_LOCAL_EXPIRY_GRACE_MS],
    "两个计时器各就各位：轮询那张 2 秒、到期那张一次性（TTL + 宽限）",
  );
});

test("R26 出口：时钟跨过 到期锚 + 宽限 之后，**不依赖任何轮询落地**就转过期", async () => {
  const at = expiryTimerWorld();
  await at.session.start();

  // 只推钟 + 让那张一次性到期计时器到点：一次轮询都不发生（真机上轮询可能有 8 秒往返在飞）
  at.at(at.anchor() + QR_LOCAL_EXPIRY_GRACE_MS);
  await at.fire(181_000 + QR_LOCAL_EXPIRY_GRACE_MS);

  assert.equal(at.session.status(), QR_LOGIN_STATUS.expired, "到点即裁决：出口不再等下一次轮询落地");
  assert.equal(at.session.isRunning(), false);
  assert.deepEqual(
    at.events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.expired],
    "expired 是终点档：这条路也只播这一条",
  );
  assert.deepEqual(at.timers(), [], "裁决之后一个挂起的计时器都不剩（轮询那张一起清）");
  assert.equal(
    at.logs.some((line) => line.includes("本地到期")),
    true,
    "本地裁决要留痕：日志里看得出这次 expired 不是服务端说的",
  );
});

test("R26 边界：还没到 到期锚 + 宽限 就到点的定时器**不判死**（码也许还能扫）", async () => {
  const at = expiryTimerWorld();
  await at.session.start();

  at.at(at.anchor() + QR_LOCAL_EXPIRY_GRACE_MS - 1);
  await at.fire(181_000 + QR_LOCAL_EXPIRY_GRACE_MS);

  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending, "本地钟不是权威：没到线就不许把会话判死");
  assert.equal(at.session.isRunning(), true);
  assert.equal(at.logs.some((line) => line.includes("本地到期")), false);
});

test("R26 服务端优先：服务端说过 expired / scanned / confirmed 时，本地那张网让位", async () => {
  // 服务端自己说过期：本地兜底那条路根本不该被走到
  const server = expiryTimerWorld({ pollResponses: [{ body: { resultCode: "103000201" } }] });
  await server.session.start();
  await server.poll();
  assert.equal(server.session.status(), QR_LOGIN_STATUS.expired);
  assert.deepEqual(server.timers(), [], "服务端收口：到期那张一次性计时器一起清掉");
  assert.equal(server.logs.some((line) => line.includes("本地到期")), false, "服务端先到，本地不抢");

  // 服务端说"已扫码"：会话还活着（用户手机上那句话还没按），本地不许判死，且撤掉这张网
  const scanned = expiryTimerWorld({ pollResponses: [{ body: { resultCode: "103000202" } }] });
  await scanned.session.start();
  await scanned.poll();
  assert.equal(scanned.session.status(), QR_LOGIN_STATUS.scanned);
  assert.equal(scanned.session.isRunning(), true);
  assert.deepEqual(scanned.timers(), [2_000], "scanned 之后只剩轮询那张：本地到期网撤掉（服务端是权威）");

  // 服务端说"已确认"：整场收口，一次成功的登录绝不能被本地打回过期
  const confirmed = expiryTimerWorld({ pollResponses: [{ body: { resultCode: "0", code: "c" } }] });
  await confirmed.session.start();
  await confirmed.poll();
  assert.equal(confirmed.session.status(), QR_LOGIN_STATUS.confirmed);
  assert.deepEqual(confirmed.timers(), []);
});

test("R26 不猜：建单没给出可信 TTL 时不挂到期定时器（没有本地权威就没有本地裁决）", async () => {
  const at = expiryTimerWorld({ createOverrides: { expiredTime: "soon" } });
  await at.session.start();

  assert.deepEqual(at.timers(), [2_000], "只有轮询那张：一个到期计时器都不许挂");
  at.at(at.anchor() + 3_600_000);
  assert.equal(at.session.status(), QR_LOGIN_STATUS.pending);
  assert.equal(at.session.isRunning(), true);
});

test("R26 收尾：cancel / 新建会话之后到期定时器不残留（不留下一条会改判的死计时器）", async () => {
  const at = expiryTimerWorld();
  await at.session.start();
  assert.equal(at.timers().includes(181_000 + QR_LOCAL_EXPIRY_GRACE_MS), true, "先确认它真的挂着");

  at.session.cancel();
  assert.deepEqual(at.timers(), [], "取消之后一个挂起的计时器都不剩");

  // 再建一次（手动刷新的语义）：新会话重新挂一张，旧的那张不许复活
  await at.session.start();
  assert.deepEqual(at.timers(), [2_000, 181_000 + QR_LOCAL_EXPIRY_GRACE_MS]);
});

// ---------------------------------------------------------------------------
// R29 诊断加强：真机扫码之后轮询仍停在"未扫"（103000200，服务端原话 "Please to login."）
// 时，日志要能回答两个问题——① 我们建的这张码到底指向哪、带什么上下文参数；
// ② 每一轮是什么时候发的、服务端除了状态码还说了什么。
//
// 两条纪律不变：**日志里不许出现 qrToken / qrCode / 整串 content**（它们是一次性凭据），
// 而 errorDesc 是服务端的固定文案，它恰恰是"手机侧登没登录"的唯一线索，所以要记。
// ---------------------------------------------------------------------------

const R29_CONTENT =
  "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=R29-SECRET-CODE&loginChannel=7000700&reqClientType=700&qrSiteID=1&appBrand=HUAWEI&familySharing=0";

/** R29 的假世界：一个可手动推进的钟（轮询时刻要能算出来）+ 可编排的响应。 */
function r29World({ createOverrides = {}, pollResponses } = {}) {
  const world = harness({
    createResponses: [{ body: createPayload({ content: R29_CONTENT, qrCode: "R29-SECRET-CODE", ...createOverrides }) }],
    pollResponses,
  });
  let clock = 1_700_000_000_000;
  const logs = [];
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl: world.fetchImpl,
    now: () => clock,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    onEvent: () => undefined,
    log: (message) => logs.push(message),
  });
  return {
    ...world,
    session,
    logs,
    /** 让本地钟走这么多毫秒（轮询的"节奏"就是它算出来的）。 */
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("R29 诊断：errorDesc 压成一行并截断（服务端文案要能进日志，但不许把日志撑破或注入换行）", () => {
  assert.equal(sanitizeErrorDesc("Please to login."), "Please to login.");
  assert.equal(sanitizeErrorDesc(undefined), null, "没有 errorDesc 就不写空壳");
  assert.equal(sanitizeErrorDesc(""), null);
  assert.equal(sanitizeErrorDesc("   "), null);

  const injected = sanitizeErrorDesc("boom\nsecond line");
  assert.equal(injected.includes("\n"), false, "换行要压平：一行日志就是一行");

  const long = sanitizeErrorDesc("x".repeat(500));
  assert.equal(long.length <= QR_ERROR_DESC_MAX + 1, true, `超长要截断：${long.length}`);
  assert.equal(long.endsWith("…"), true, "截断要看得出来（省略号）");
});

test("R29 诊断：content 的摘要只留非敏感参数（qRCode 与整串 content 都不进日志）", () => {
  const summary = describeQrContent(R29_CONTENT);
  assert.ok(summary.includes("/qrcode/login.jsp"), `要能看出这张码指向哪个页面：${summary}`);
  for (const pair of ["loginChannel=7000700", "reqClientType=700", "qrSiteID=1", "appBrand=HUAWEI", "familySharing=0"]) {
    assert.ok(summary.includes(pair), `非敏感参数要逐个记下来：${pair}`);
  }
  assert.equal(summary.includes("R29-SECRET-CODE"), false, "qRCode 是一次性凭据，不许出现在摘要里");
  assert.equal(summary.includes(R29_CONTENT), false, "整串 content 也不许出现");
  assert.equal(describeQrContent(""), null, "没有内容就没有摘要");
  assert.equal(describeQrContent("not-a-url"), null, "认不出的东西不猜");
});

test("R29 诊断：建单时留一行 content 摘要（真机再报「未扫」时，先看这张码指向哪）", async () => {
  const world = r29World({ pollResponses: [{ body: { resultCode: "103000200" } }] });
  await world.session.start();

  const lines = world.logs.filter((line) => line.includes("二维码建单"));
  assert.equal(lines.length, 1, `建单只记一行：${JSON.stringify(world.logs)}`);
  const line = lines[0];
  assert.ok(line.includes("/qrcode/login.jsp"));
  assert.ok(line.includes("loginChannel=7000700"));
  assert.ok(line.includes("qrSiteID=1"));
  assert.ok(line.includes("181s"), `建单给了可信 TTL 就要记下来：${line}`);

  const joined = world.logs.join("\n");
  assert.equal(joined.includes("R29-SECRET-CODE"), false, "qRCode 不许进日志");
  assert.equal(joined.includes(R29_CONTENT), false, "整串 content 不许进日志");
  assert.equal(joined.includes(createPayload().qrToken), false, "qrToken 不许进日志");
});

test("R29 诊断：轮询行带时刻与节奏（t+…s），真机看得出轮询到底有没有在跑、隔多久一轮", async () => {
  const world = r29World({ pollResponses: [{ body: { resultCode: "103000200", errorDesc: "Please to login." } }] });
  await world.session.start();

  world.advance(3_400);
  await world.tick();
  world.advance(2_600);
  await world.tick();

  const rounds = world.logs.filter((line) => line.includes("轮询 #"));
  assert.equal(rounds.length, 2);
  assert.match(rounds[0], /轮询 #1（\d{2}:\d{2}:\d{2}，t\+3\.4s）/, `第一轮的节奏要看得出来：${rounds[0]}`);
  assert.match(rounds[1], /轮询 #2（\d{2}:\d{2}:\d{2}，t\+6\.0s）/, `第二轮同理：${rounds[1]}`);
  for (const line of rounds) assert.match(line, /resultCode=103000200/);
  for (const line of rounds) {
    assert.ok(line.includes('errorDesc="Please to login."'), `服务端原话是判"手机侧登没登录"的线索：${line}`);
  }
  assert.equal(world.logs.join("\n").includes(createPayload().qrToken), false);
});

test("R29 诊断：认不出的码那一行照样带时刻与 errorDesc（熔断前后都留痕，格式不分叉）", async () => {
  const world = r29World({ pollResponses: [{ body: { resultCode: "103009999", errorDesc: "protocol changed" } }] });
  await world.session.start();
  world.advance(1_250);
  await world.tick();

  const round = world.logs.find((line) => line.includes("轮询 #"));
  assert.match(round, /t\+1\.3s/, `四舍五入到 0.1 秒：${round}`);
  assert.ok(round.includes("103009999"));
  assert.ok(round.includes("连续 1/5"), `陌生码的连续计数要在同一行：${round}`);
  assert.ok(round.includes('errorDesc="protocol changed"'));
});

// ---------------------------------------------------------------------------
// R31 全保真：探针（headless Chromium 真开官方二维码页）实测到的请求形态逐项对齐
//
// 实测（`scripts/probe-qr-fidelity.mjs` → `.probe/r31-fidelity.json`）：
// - 建单 **POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo**——**没有查询串**；
//   表单 = 模板六参数 + `deviceID` + `deviceType=7`；
// - 轮询 `POST …/DimensionalCode/async?version=40200&t=<随机>`，表单只有 `qrToken`；
// - 两个请求都带 `accept: application/json, text/plain, */*` 与页面自己的 Referer；
// - 两者都带 cookie（建单带 CAS 那些、轮询还带**建单响应自己设的** `qRCode`/`expiredTime`）。
//
// 本层只负责"我们发出去的那一串"对不对；cookie 罐、UA、设备标识从哪来，是端口层的事
// （见 test/qr-port.test.mjs 的 R31 段）。
// ---------------------------------------------------------------------------

/** 那张画着二维码的页（探针实测：建单/轮询的 Referer 就是它）。 */
const R31_REFERER = "https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?x=1";

/** R31 的假世界：把请求头也记下来（harness 只记 URL 与正文）。 */
function r31SessionWorld({ pollResponses = [{ body: { resultCode: "103000200" } }] } = {}) {
  const world = harness({ createResponses: [{ body: createPayload() }], pollResponses });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), headers: init?.headers ?? {} });
    return world.fetchImpl(url, init);
  };
  const session = createQrSession({
    createUrl: CREATE_URL,
    pollUrl: POLL_URL,
    intervalMs: world.intervalMs,
    fetchImpl,
    setTimer: world.setTimer,
    clearTimer: world.clearTimer,
    now: () => 1_700_000_000_000,
    log: () => undefined,
    createParams: { deviceID: "R31-DEVICE-ID", deviceType: "7" },
    extraHeaders: { referer: R31_REFERER },
  });
  return { session, calls, tick: world.tick };
}

test("R31 建单 URL：查询串丢掉（页面是 getqrContent.split('?')[0]），模板仍是六个参数的唯一真源", () => {
  assert.equal(qrCreateRequestUrl(CREATE_URL), "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo");
  assert.equal(CREATE_URL.includes("?"), true, "端点常量本身仍带模板查询串（六个参数从它取）");
  const body = new URLSearchParams(buildQrCreateBody(CREATE_URL));
  assert.equal(body.get("appID"), "com.huawei.hwidweb");
  assert.equal(body.get("loginChannel"), "7000700");
  // 认不出的串不许编一个 URL 出来
  assert.equal(qrCreateRequestUrl("not-a-url"), "not-a-url");
});

test("R31 建单请求：URL 无查询串、accept 与页面同款、设备标识进正文、Referer 由调用方注入", async () => {
  const world = r31SessionWorld({});
  await world.session.start();
  await world.tick();

  const create = world.calls.find((call) => call.url.includes("getqrInfo"));
  assert.equal(create.url, "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo", "建单 URL 一个查询串都不带");
  assert.equal(create.headers.accept, "application/json, text/plain, */*", "页面用的就是这一串");
  assert.equal(create.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(create.headers.referer, "https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?x=1", "Referer 就是那张画着二维码的页");
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
  assert.equal(body.get("deviceType"), "7");
});

test("R31 轮询请求：URL 带 &t=、表单只有 qrToken、请求头与建单同一套（含 Referer）", async () => {
  const world = r31SessionWorld({});
  await world.session.start();
  await world.tick();
  await world.tick();

  const polls = world.calls.filter((call) => call.url.includes("DimensionalCode/async"));
  assert.ok(polls.length >= 2, `至少两轮：${JSON.stringify(world.calls.map((call) => call.url))}`);
  for (const poll of polls) {
    assert.match(poll.url, /^https:\/\/id1\.cloud\.huawei\.com\/DimensionalCode\/async\?version=40200&t=/);
    assert.deepEqual([...new URLSearchParams(poll.body).keys()], ["qrToken"]);
    assert.equal(poll.headers.accept, "application/json, text/plain, */*");
    assert.equal(poll.headers.referer, "https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?x=1");
  }
});
