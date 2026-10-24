/**
 * R45A1 · 启动第一屏的三态（**纯决定** + 外壳源码守卫）。
 *
 * 现象（用户第 10 项）：**已经登录的会话冷启动时会先闪一下登录页**。
 *
 * 根因不在二维码、也不在登录状态本身：`useAuthGate` 的初始 phase 是 `checking`
 * （「还不知道」——这个诚实是对的，不能猜），而旧的外壳把这个档位**当成未登录**，
 * 于是第一帧渲染的是整个 `LoginGate`（标题、二维码占位、提示、「正在检查登录状态…」）。
 * `auth:get-status` 的应答 / 启动期那条广播要等一次 IPC 往返才到，快照落地之后外壳才翻成
 * app-shell——那一帧的登录页就是用户看见的「闪」。
 *
 * 修法不是把登录页晚一点画（`setTimeout` / `display:none` 都只是把同一个错误藏起来），
 * 而是**让 `checking` 有自己的界面**——中性启动视图（`StartupChecking`）：
 *
 * | phase | 界面 | 二维码 |
 * |---|---|---|
 * | `checking`（还不知道） | 中性启动屏（无二维码、无标题、无任何可点元素） | 不发起 |
 * | `logged_out`（确定未登录） | `LoginGate`（原来那一页） | 此刻才自动发起 |
 * | `logged_in` | app-shell | 不发起 |
 *
 * 三件事一起才成立：
 * 1. 判定只有一处（`features/auth/startup-view.mjs` 的 `startupViewOf`），外壳不再自己猜；
 * 2. `checking` 与 `logged_out` 是两个**不同**的界面——快照到达之前屏上没有任何登录页的东西；
 * 3. 二维码仍然只在**确定未登录**之后才发起（`shouldAutoStartQr` 的四条件不变）：
 *    检查期间建单 = 覆盖已有登录态，而且那一单会换掉用户正在扫的码。
 *
 * `startup-view.mjs` 只是 `login-gate-logic.mjs` 之上的一层投影：**「能不能渲染 app-shell」
 * 仍然是 `shouldShowLoginGate` 那一条**（`startupViewOf` 直接调它），所以两个模块不会各说一套。
 *
 * 真 DOM（渲染出来的标记）由 `test/login-gate-markup.test.mjs` 的 R45A1 段钉；
 * 本文件钉纯决定、竞态序列与外壳源码顺序。先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_PHASE,
  LOGIN_OPENING_TEXT,
  initialGateState,
  reduceGateState,
  shouldAutoStartQr,
  shouldShowLoginGate,
} from "../src/renderer/features/auth/login-gate-logic.mjs";
import {
  STARTUP_CHECKING_LABEL,
  STARTUP_CHECKING_TESTID,
  STARTUP_RETRY_LABEL,
  STARTUP_RETRY_TESTID,
  STARTUP_VIEW,
  startupCheckFailed,
  startupCheckingStatusOf,
  startupViewOf,
} from "../src/renderer/features/auth/startup-view.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 只扫代码，不扫注释（注释里写「不许 setTimeout」是说明文字）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 造一个「确定未登录」的门禁状态（走真状态机，不手搓对象）。 */
function loggedOut() {
  return reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false });
}

/** 造一个「已登录」的门禁状态。 */
function loggedIn() {
  return reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: true, busy: false });
}

/**
 * 一次冷启动里，门禁钩子依次会产生的状态（R19 的既有顺序：订阅 → `rendererReady()` → 查询）。
 *
 * 第一帧**永远**是 `initialGateState()`（`useState` 的初值，effect 还没跑）；
 * 之后才是启动期那条广播 / `auth:get-status` 的应答落进来的那一帧。
 */
function coldStartFrames({ loggedIn: session }) {
  const first = initialGateState();
  return [first, reduceGateState(first, { type: LOGIN_GATE_EVENT.status, loggedIn: session, busy: false })];
}

/** `App()` 的函数体（源码守卫只看这一段：下面的 LibraryShell 是登录之后才存在的那一块）。 */
function appBody() {
  const source = read("src/renderer/App.tsx");
  const start = source.indexOf("export function App(");
  assert.ok(start > -1, "App.tsx 必须导出 App()");
  const end = source.indexOf("\n}", start);
  return { source, body: source.slice(start, end === -1 ? undefined : end) };
}

// ---------------------------------------------------------------------------
// 1. 三态：checking / logged_out / logged_in 各是哪一个界面
// ---------------------------------------------------------------------------

test("R45A1 三态：checking 是中性启动视图，不是登录页", () => {
  const initial = initialGateState();
  assert.equal(initial.phase, LOGIN_GATE_PHASE.checking, "初值仍是「还不知道」（不许猜）");
  assert.equal(startupViewOf(initial), STARTUP_VIEW.checking);
  assert.notEqual(
    startupViewOf(initial),
    STARTUP_VIEW.loginGate,
    "还不知道就把整张登录页画出来，就是用户看见的那一闪",
  );

  // 不许放行 app-shell：这一条仍是 login-gate-logic 的判决（三态是它的投影，不是第二套判定）
  assert.equal(shouldShowLoginGate(initial), true, "检查中绝不渲染 app-shell（会把没登录的用户放进主界面）");
});

test("R45A1 三态：确定未登录 → LoginGate；已登录 → app-shell（且与门禁判定同向）", () => {
  assert.equal(startupViewOf(loggedOut()), STARTUP_VIEW.loginGate);
  assert.equal(startupViewOf(loggedIn()), STARTUP_VIEW.appShell);

  for (const state of [initialGateState(), loggedOut(), loggedIn()]) {
    assert.equal(
      startupViewOf(state) === STARTUP_VIEW.appShell,
      shouldShowLoginGate(state) === false,
      "三态与门禁判定必须同向（两处各说一套就是下一个 bug）",
    );
  }
});

test("R45A1 三态：认不出的状态一律按「还不知道」处理（既不猜已登录，也不猜未登录）", () => {
  const unknown = [undefined, null, {}, { phase: "weird" }, { phase: "" }];
  for (const state of unknown) {
    assert.equal(startupViewOf(state), STARTUP_VIEW.checking, `陌生状态要落回安静启动：${JSON.stringify(state)}`);
    assert.equal(shouldShowLoginGate(state), true, "陌生状态绝不放行 app-shell");
  }

  // 只有 phase 明确是 logged_out 才出登录页；明确是 logged_in 才进 shell
  assert.equal(startupViewOf(loggedOut()), STARTUP_VIEW.loginGate);
  assert.equal(startupViewOf(loggedIn()), STARTUP_VIEW.appShell);
  assert.equal(startupViewOf({ phase: LOGIN_GATE_PHASE.loggedOut }), STARTUP_VIEW.loginGate);
});

// ---------------------------------------------------------------------------
// 2. 二维码只在确定未登录之后才发起（检查期间不建单）
// ---------------------------------------------------------------------------

test("R45A1 二维码：只在确定 loggedOut 之后自动发起（检查期间不建单）", () => {
  assert.equal(shouldAutoStartQr(initialGateState()), false, "还不知道有没有会话就建单 = 覆盖已有登录态");
  assert.equal(shouldAutoStartQr(loggedOut()), true, "确定未登录之后照老规矩自动发起");
  assert.equal(shouldAutoStartQr(loggedIn()), false);
  assert.equal(shouldAutoStartQr(failedCheck()), false, "查询失败仍是「没结论」：一张码都不建");

  // 冷启动两帧合起来看：第 0 帧谁都不发起，第 1 帧只有未登录那条路才发起
  assert.deepEqual(coldStartFrames({ loggedIn: false }).map(shouldAutoStartQr), [false, true]);
  assert.deepEqual(coldStartFrames({ loggedIn: true }).map(shouldAutoStartQr), [false, false], "已登录冷启动一张码都不建");
});

// ---------------------------------------------------------------------------
// 3. 竞态：已登录快照到达之前的那一帧不许是登录页
// ---------------------------------------------------------------------------

test("R45A1 竞态：已登录冷启动的每一帧都不是登录页（登录页出现 0 次）", () => {
  const views = coldStartFrames({ loggedIn: true }).map(startupViewOf);
  assert.deepEqual(views, [STARTUP_VIEW.checking, STARTUP_VIEW.appShell]);
  assert.equal(
    views.filter((view) => view === STARTUP_VIEW.loginGate).length,
    0,
    "首帧与之后任意一帧都在这条序列上：序列里没有 login-gate，屏上就不会闪出登录页",
  );
});

test("R45A1 竞态：未登录冷启动先安静，快照落地之后才出现登录页", () => {
  const frames = coldStartFrames({ loggedIn: false });
  assert.deepEqual(frames.map(startupViewOf), [STARTUP_VIEW.checking, STARTUP_VIEW.loginGate]);

  // 重复喂同向的快照（广播与查询都答同一件事）不改变档位（R19：两处共用一条事件）
  const repeatedOut = reduceGateState(frames[1], { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false });
  assert.equal(startupViewOf(repeatedOut), STARTUP_VIEW.loginGate);

  const repeatedIn = reduceGateState(
    coldStartFrames({ loggedIn: true })[1],
    { type: LOGIN_GATE_EVENT.status, loggedIn: true, busy: false },
  );
  assert.equal(startupViewOf(repeatedIn), STARTUP_VIEW.appShell, "已登录之后再喂一条已登录仍是 app-shell");
});

// ---------------------------------------------------------------------------
// 4. 查询失败那一档：**仍是中性启动屏**，但必须可操作（复审 R45A1 Important）
// ---------------------------------------------------------------------------
//
// 上一版把「checking + 一句人话」判成了 LoginGate（理由：网页登录那条出路口长在门禁页上）。
// 那是**违反复审合同**的：合同写的是 checking **绝不**渲染 LoginGate/二维码。失败不是"已确定
// 未登录"，把它画成登录页等于用一张可能不需要的二维码盖住一个还没查完的会话。
//
// 复审后的形态：`checking` 恒为中性启动屏；失败时这一屏**自己长出**三件东西——
// 一句原因、一个「重新检查登录状态」（真的重发 `auth:get-status`）、一个网页登录入口。
// 于是"不误判"与"不困在空转屏上"两件事同时成立。

/** 「查询失败」那一档（R19 的 failed 事件：phase 仍是 checking）。 */
function failedCheck() {
  return reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.failed,
    message: "查询登录状态失败：未知请求频道：auth:get-status",
  });
}

test("R45A1 查询失败：仍渲染中性启动屏（不是 LoginGate，也不发起二维码）", () => {
  const failed = failedCheck();
  assert.equal(failed.phase, LOGIN_GATE_PHASE.checking, "没答上来就不许下结论（未登录/已登录都不猜）");
  assert.equal(startupCheckFailed(failed), true);
  assert.equal(
    startupViewOf(failed),
    STARTUP_VIEW.checking,
    "checking 恒为中性启动屏：失败不等于「确定未登录」，画成登录页就是合同禁止的那件事",
  );
  assert.notEqual(startupViewOf(failed), STARTUP_VIEW.loginGate);
  assert.equal(shouldShowLoginGate(failed), true, "失败仍不放行 app-shell（宁可挡住，也不猜已登录）");
  assert.equal(shouldAutoStartQr(failed), false, "检查没结论之前一张码都不建（失败也是没结论）");
});

test("R45A1 查询失败：中性启动屏给出原因 + 重新检查 + 网页登录（三件都在，且只有这三件）", () => {
  const failed = startupCheckingStatusOf(failedCheck());
  assert.equal(failed.failed, true);
  assert.match(failed.text ?? "", /查询登录状态失败/, "必须说出原因（空转的「正在检查…」正是 R19 要消灭的）");
  assert.equal(failed.canRetry, true, "要有一个真的重发 auth:get-status 的动作");
  assert.equal(failed.canWebLogin, true, "还要留一条出路（网页登录那条路）");

  // 安静地检查中（没有那句话）：什么都不长，就是一枚转圈
  const quiet = startupCheckingStatusOf(initialGateState());
  assert.equal(quiet.failed, false);
  assert.equal(quiet.text, null, "安静档不许有文案");
  assert.equal(quiet.canRetry, false, "没失败就别给按钮（空转屏上多一个按钮=让人以为出错了）");
  assert.equal(quiet.canWebLogin, false);

  // 已经确定的两个档位与「失败」无关（一句残留的 message 不许把 app-shell 顶掉）
  assert.equal(startupCheckFailed(loggedIn()), false);
  assert.equal(startupCheckFailed(loggedOut()), false);
  const loggedInWithMessage = reduceGateState(loggedIn(), { type: LOGIN_GATE_EVENT.failed, message: "x" });
  assert.equal(startupViewOf(loggedInWithMessage), STARTUP_VIEW.appShell);
  assert.equal(startupCheckingStatusOf(loggedInWithMessage).failed, false);
});

test("R45A1 网页登录那条路：checking 期间按下入口 → 仍是中性启动屏，并如实说「正在打开…」", () => {
  // 失败档上的那个网页登录入口按下去之后：`started` 清掉上一条失败说明、path 转 official。
  // 那一刻 phase 仍是 checking（从没确定过未登录）——所以界面仍是中性启动屏，只是多一句
  // 「正在打开华为官方登录页…」（官方页此刻还在屏外加载）。
  const opening = reduceGateState(failedCheck(), { type: LOGIN_GATE_EVENT.started });
  assert.equal(opening.phase, LOGIN_GATE_PHASE.checking, "这条路上从没确定过未登录");
  assert.equal(opening.path, "official");
  assert.equal(opening.message, null, "按下去的那一刻上一句失败说明已经退场");
  assert.equal(startupViewOf(opening), STARTUP_VIEW.checking, "checking 就是 checking：不许换成登录页");
  assert.equal(shouldAutoStartQr(opening), false, "网页那条路在跑：不建二维码订单");

  const status = startupCheckingStatusOf(opening);
  assert.equal(status.failed, false, "这一档不是「查询失败」那一条");
  assert.equal(status.text, LOGIN_OPENING_TEXT, "如实说那一刻在等什么（不是一片空白）");
  assert.equal(status.canRetry, false, "官方页还在加载：别给一个会打断它的按钮");

  // 反例：安静的检查中（没人按任何东西）仍然是安静的启动屏
  assert.equal(startupCheckingStatusOf(initialGateState()).text, null);
});

// ---------------------------------------------------------------------------
// 5. 外壳源码守卫：三态判定排在 app-shell 之前，两个非 shell 落点各只有一处
// ---------------------------------------------------------------------------

test("R45A1 外壳：三态判定（startupViewOf）排在 app-shell 之前，落点各自唯一", () => {
  const { source, body } = appBody();

  const viewAt = body.indexOf("startupViewOf(gate.state)");
  const shellAt = body.indexOf('data-shell="app-shell"');
  assert.ok(viewAt > -1, `App() 的界面三态必须来自 startup-view.mjs 的 startupViewOf：${body}`);
  assert.ok(shellAt > -1, `App() 里要有 app-shell 挂载点（R8 的落点）：${body}`);
  assert.ok(viewAt < shellAt, "三态判定必须排在 app-shell 之前：顺序反了就是未登录先渲染主界面");

  // 检查中与确定未登录是**两个**落点：写成 `!== appShell ? LoginGate : shell` 就是原来那个闪
  assert.match(
    body,
    /view === STARTUP_VIEW\.loginGate\s*\?\s*<LoginGate gate=\{gate\} \/>\s*:\s*<StartupChecking gate=\{gate\} \/>/,
    `非 shell 的两个落点必须是「确定未登录才 LoginGate、其余中性启动屏」：${body}`,
  );
  assert.equal(
    source.split("<LoginGate").length - 1,
    1,
    "LoginGate 在 App.tsx 里只许有一个落点（多一个就是绕过三态判定）",
  );
  assert.match(
    body,
    /<StartupChecking gate=\{gate\} \/>/,
    "启动屏要拿到 gate：失败时它自己长出「重新检查登录状态」与网页登录入口（复审 R45A1）",
  );
  assert.doesNotMatch(body, /^\s*return\s+<AppShell/m, "不得绕过三态判定直接返回主界面");
});

test("R45A1 外壳：不许用定时器/隐藏来掩盖登录页（那不是修，是同一个错误的另一种画法）", () => {
  const { body } = appBody();
  for (const timer of ["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask"]) {
    assert.equal(body.includes(timer), false, `App() 里不许出现 ${timer}：延迟/隐藏登录页只是把闪烁藏起来`);
  }
  const code = stripComments(read("src/renderer/App.tsx"));
  assert.doesNotMatch(code, /LoginGate[^\n]*\bhidden\b|\bhidden\b[^\n]*LoginGate/, "不许把登录页渲染出来再藏起来");
});

test("R45A1 纯函数：startup-view.mjs 不碰 React/窗口/定时器（同一份判定渲染层与测试共用）", () => {
  const source = stripComments(read("src/renderer/features/auth/startup-view.mjs"));
  assert.match(source, /export function startupViewOf/, "三态判定必须是导出函数（唯一真源）");
  assert.match(source, /export function startupCheckFailed/, "失败档的判据也是纯函数");
  assert.match(source, /export function startupCheckingStatusOf/, "启动屏上长什么（原因/重试/网页登录）也是纯决定");
  assert.doesNotMatch(source, /from\s+["']react/, "判定模块不许 import React（它跑在 node 测试里）");
  assert.doesNotMatch(source, /window\.|document\./, "判定模块不碰 DOM");
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame|queueMicrotask/, "判定模块不碰时钟");
  assert.equal(STARTUP_CHECKING_TESTID, "startup-checking");
  assert.equal(STARTUP_RETRY_TESTID, "startup-retry-status", "重试状态的锚点是契约（浏览器守卫按它点）");
  assert.match(STARTUP_CHECKING_LABEL, /\S/, "中性启动屏要有可达名字（读屏用户也得知道在启动）");
  assert.match(STARTUP_RETRY_LABEL, /\S/, "重试按钮要有可见文案");
});

test("R45A1 启动屏源码：二维码与登录页的一切都不在它里面；三个动作各自只有一处", () => {
  const source = read("src/renderer/login-gate.tsx");
  const start = source.indexOf("export function StartupChecking");
  const end = source.indexOf("/** 引导页本体。 */");
  assert.ok(start > -1 && end > start, "要能在 login-gate.tsx 里定位启动屏那一段");
  const body = source.slice(start, end);

  for (const forbidden of [
    "QrCanvas",
    "<canvas",
    "LOGIN_GATE_TITLE",
    "QR_HINT_TEXT",
    "qrContentOf",
    "canRefreshQr",
    "ThemeControl",
    "LOGIN_VIEW_TOP_INSET",
  ]) {
    assert.equal(
      body.includes(forbidden),
      false,
      `checking 那一屏里不许出现 ${forbidden}（checking 永不渲染二维码/登录页，复审 R45A1）`,
    );
  }
  assert.match(body, /STARTUP_RETRY_TESTID/, "重试状态的锚点来自唯一真源的常量");
  assert.match(body, /gate\.refreshStatus/, "重试必须真的重发 auth:get-status（不是刷新页面、不是定时器）");
  assert.match(body, /startLogin/, "失败档要留一条网页登录的出路");
  assert.match(body, /startupCheckingStatusOf/, "这一屏长什么由纯函数决定（不在 JSX 里再猜一遍）");
});
