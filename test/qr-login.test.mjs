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
 * 3. **过期自己重建**：拿回来的是一张死二维码，用户那边什么都做不了——重建是 sidecar 的职责
 *    （理由写明：渲染层不该为"再来一张"再走一次请求/响应，广播通道保持唯一事实来源）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  QR_ERROR_KINDS,
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
  assert.equal(parsed.data.expiresInMs, 181_000, "有效期 = expiredTime - 建单时刻");
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

test("会话：二维码过期 → 广播 expired 并自动重新建单（新内容广播出来）", async () => {
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
  // 一次 tick = 一次轮询：拿到"过期"后当场重建（同一 tick 内换新二维码）
  await world.tick();

  assert.deepEqual(
    world.events.map((event) => event.status),
    [QR_LOGIN_STATUS.pending, QR_LOGIN_STATUS.expired, QR_LOGIN_STATUS.pending],
    "过期要如实报出来，然后自己换一张新的（渲染层零动作）",
  );
  assert.match(world.events.at(-1).content, /qRCode=SECOND/);
  assert.equal(session.isRunning(), true, "新二维码还在等扫码");
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
    "取消之后到达的「过期」不许广播（否则它会顺手再建一张新码，把刷新出来的那张顶掉）",
  );
  assert.equal(polls, 1, "挂住的那次轮询确实发出去过（这条断言不是空转）");
  assert.equal(session.isRunning(), false);
});

test("会话：过期自动换新之后 current() 报的是新那张（换码链要带当前这张的 qrCode）", async () => {
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
  await world.tick(); // 过期 → 当场重建
  assert.match(session.current().content, /qRCode=NEW/);
  assert.equal(session.current().qrCode, "R-NEW", "换新之后当前那张是新码：拿旧 qrCode 去换码只会换回一次失败");
});
