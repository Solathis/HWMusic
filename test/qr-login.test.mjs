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
 * 3. **本地到期兜底**：到期锚 + 15 秒宽限的**边界逐个钉**（锚前不触发 / +14.999s 不触发 /
 *    +15s 触发 / 服务端先到或仍在说话时一律让位 / 没有可信 TTL 就不设锚），外加每轮诊断日志的脱敏。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  QR_DEFAULT_MAX_UNKNOWN_CODES,
  QR_ERROR_KINDS,
  QR_LOCAL_EXPIRY_GRACE_MS,
  QR_LOGIN_STATUS,
  QR_RESULT_CODES,
  buildQrCreateBody,
  buildQrPollBody,
  classifyQrPoll,
  createQrSession,
  parseQrCreate,
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
    timers.set(id, fn);
    scheduled.push(ms);
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  /** 跑到下一个挂起的计时器（一次只推进一步：状态机的每一步都单独可断言）。 */
  const tick = async () => {
    const [id, fn] = [...timers.entries()][0] ?? [];
    if (fn === undefined) return false;
    timers.delete(id);
    fn();
    // 被测代码是一串 await（fetch → text → 事件 → 排下一次轮询）：把微任务队列抽干再断言
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
  return { setTimer, clearTimer, tick, fetchImpl, calls, events, intervalMs, scheduled };
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
  await world.tick(); // 第一个挂起的计时器就是总期限

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

test("R22 兜底：服务端一直说 pending，本地到期锚 + 15s 宽限到点 → 主动转 expired 并停轮询", async () => {
  const at = expiryWorld({ pollResponses: [{ body: { resultCode: "103000200", errorDesc: "Please to login." } }] });
  assert.equal(QR_LOCAL_EXPIRY_GRACE_MS, 15_000, "宽限是契约值：15 秒");
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
