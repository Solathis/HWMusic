/**
 * R16/R18 渲染层登录门禁（引导页）：判定纯函数 + 外壳骨架的**顺序**契约 + 视觉原语约束。
 *
 * R16 起引导页的形态（用户指令）：**只展示二维码和提示文字**——进页面自动发起二维码
 * （`auth:qr-start`），扫码状态经 `auth:qr` 广播回来；只有出错才出现"重试"。
 *
 * R18（用户指令 2026-10-20）在这一页上改了五件事，本文件钉住其中的**判定与源码结构**：
 * 1. 提示文案换成"手机「控制中心」…"（`QR_HINT_TEXT` 唯一真源，且状态行**不再复述**它）；
 * 2. 二维码容器带边框（令牌 + 工具类，零自定义 CSS）；
 * 3. 过期自动换新（判定层：过期不自己发起、新内容直接换；像素级重画见 test/qr-render.test.mjs）；
 * 4. "在网页中打开登录"**常驻**次要入口 + 与二维码**互斥**（停轮询、窗关回二维码态）；
 * 5. 标题移到二维码正上方（`LOGIN_GATE_TITLE` 唯一真源，全页只出现一次）。
 *
 * 渲染出来的**标记**（顺序/边框/数量）由 `test/login-gate-markup.test.mjs` 用真 SSR 钉——
 * 源码扫描只能说"字符串在里面"，说不清"渲染出来是什么样"。
 *
 * R19 增补（本文件 §10）：门禁挂载时**主动查一次** `auth:get-status`——`auth:status` 只在
 * sidecar 启动时广播一次，渲染层 reload/崩溃重启之后那一条已经冲刷过了，门禁会永久停在
 * `checking`。查询应答喂**同一条** status 事件（共用 `statusEventOf` 映射），
 * 所以"查询来的状态"与"广播来的状态"不可能各有一套解释。
 *
 * R20 增补（本文件 §11，用户真机验收反馈三项）：
 * 1. header 里那句品牌与窗口标题栏重复 → 删掉（header 只剩 48px 几何占位）；
 * 2. 二维码过期：expired 到达**当场撤掉旧码**（不可扫的码不许留在屏上）、
 *    容器本身可点手动刷新（`canRefreshQr` + `aria-label`）；
 * 3. 网页登录窗铺满内容区（顶部只留 48px）时，次要入口**变形为「返回扫码登录」并挪进那条
 *    可见的 header**——它是那一刻唯一可达的控件，点击走 `auth:cancel-login`（关窗）→
 *    那条路的收场广播 → `returnToQr`（R18 已有，本文件 §4 钉住）。
 *
 * R21 增补（本文件 §12，用户指令 2026-10-20，**推翻 R16/R20 的"过期自动换新"**）：
 * 1. 过期**倒计时**：`expiresInMs` 由建单应答/广播带过来，渲染层本地按秒递减
 *    （`qrCountdownText`，钟在这一侧）；本地到 0 只是「正在确认过期…」，
 *    **过期判定仍以服务端 `expired` 广播为权威**；
 * 2. 过期态**不可扫**：expired 到达 → 撤掉旧码 + 「二维码已过期」占位 + 状态行
 *    `QR_EXPIRED_NOTICE`（R20 要求 2 的"死码不留屏"继续成立）；
 * 3. **只能手动刷新**：过期不再自动重发 `auth:qr-start`（`shouldAutoStartQr` 在这一档为假），
 *    刷新由用户点击二维码容器或过期态那个显著的「刷新二维码」按钮触发。
 *    R20 的 `qrNotice` / `QR_REFRESH_NOTICE`（"已刷新，请重新扫码"）随之删除——
 *    不再自动换新，就不存在"刚换过"这一刻。
 *
 * 五条硬要求里的前四条仍是源码扫描（R16 起）：
 * 1. 未登录**绝不渲染 app-shell**：门禁分支必须在 App() 里排在 app-shell 之前；
 * 2. 正常路径**只有一个可操作元素**（常驻的网页入口）；"重试"只在失败态出现；
 * 3. 顶部内缩不许出现第二份字面量：高度来自 src/shared/login-inset.mjs，且不许写 `h-12`；
 * 4. 二维码必须由**成熟库**（`qrcode`，MIT）渲染：不手写二维码组件、不自绘编码逻辑。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOGIN_VIEW_TOP_INSET } from "../src/shared/login-inset.mjs";
import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_PHASE,
  LOGIN_GATE_TITLE,
  QR_COUNTDOWN_TESTID,
  QR_EXPIRED_BOX_HINT,
  QR_EXPIRED_BOX_TEXT,
  QR_EXPIRED_NOTICE,
  QR_EXPIRING_TEXT,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  QR_REFRESH_LABEL,
  QR_REFRESH_TESTID,
  WEB_LOGIN_BACK_TESTID,
  WEB_LOGIN_BACK_TEXT,
  WEB_LOGIN_ENTRY_TESTID,
  WEB_LOGIN_ENTRY_TEXT,
  canRefreshQr,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  qrContentOf,
  qrCountdownText,
  reduceGateState,
  shouldAutoStartQr,
  shouldShowLoginGate,
  webLoginEntry,
} from "../src/renderer/features/auth/login-gate-logic.mjs";
import { THEME_CONTROL_TESTID } from "../src/renderer/features/theme/theme.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 递归列出渲染层源码（.tsx/.ts/.mjs）。 */
function rendererFiles(root = "src/renderer") {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(tsx|ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(child);
    }
  };
  walk(root);
  return found;
}

/** 只扫代码，不扫注释（注释里写"不许 <style>"是说明文字，不是违规）；保留 `://`。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 门禁源码（去掉注释，供结构扫描）。 */
const gateSource = () => stripComments(read("src/renderer/login-gate.tsx"));

/**
 * 门禁**渲染出来的那块 JSX**（从 `export function LoginGate(` 到文件尾）。
 *
 * 位置类断言必须用它：文件上半部分还有 `QrCanvas`（`<canvas` 在那里）与 import 名单，
 * 拿整份源码找下标会把它们算进来（"标题在二维码之前"这种断言会因此变得毫无意义）。
 */
function gateJsx() {
  const source = gateSource();
  const start = source.indexOf("export function LoginGate(");
  assert.ok(start > -1, "login-gate.tsx 必须导出 LoginGate()");
  return source.slice(start);
}

/** 造一个"确定未登录"的门禁状态。 */
function loggedOut(extra = {}) {
  return reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false, ...extra });
}

// ---------------------------------------------------------------------------
// 1. 门禁判定：未登录（含"还不知道"）都不许渲染 app-shell
// ---------------------------------------------------------------------------

test("门禁判定：只有「已登录」才放行 app-shell；检查中与未登录都显示门禁", () => {
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.checking, busy: false }), true);
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.loggedOut, busy: false }), true);
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.loggedIn, busy: false }), false);
});

test("门禁判定：状态未知时不许猜（检查中按门禁处理，绝不按已登录处理）", () => {
  const initial = initialGateState();
  assert.equal(initial.phase, LOGIN_GATE_PHASE.checking);
  assert.equal(shouldShowLoginGate(initial), true);
  assert.equal(shouldAutoStartQr(initial), false, "还不知道有没有会话就发二维码 = 覆盖已有登录态");
  assert.equal(initial.qr.status, QR_GATE_STATUS.preparing, "初始是「正在准备」而不是「失败」");
});

// ---------------------------------------------------------------------------
// 2. 自动开始：门禁内 + 不 busy + 本轮未发起 + 不在网页登录那条路上
// ---------------------------------------------------------------------------

test("自动开始：四条件齐备才发起二维码；缺任何一条都不发起", () => {
  const ready = { phase: LOGIN_GATE_PHASE.loggedOut, busy: false, qrAttempted: false, path: null };
  assert.equal(shouldAutoStartQr(ready), true);

  assert.equal(shouldAutoStartQr({ ...ready, phase: LOGIN_GATE_PHASE.checking }), false, "检查中不发起");
  assert.equal(shouldAutoStartQr({ ...ready, phase: LOGIN_GATE_PHASE.loggedIn }), false, "已登录不再扫码");
  assert.equal(shouldAutoStartQr({ ...ready, busy: true }), false, "正在登录（开窗那条路）时不起第二张码");
  assert.equal(shouldAutoStartQr({ ...ready, qrAttempted: true }), false, "本轮已经发起过（不重复建单）");
  assert.equal(
    shouldAutoStartQr({ ...ready, path: "official" }),
    false,
    "R18：网页登录那条路跑起来了就不再建单（两条路互斥）",
  );
});

test("自动开始：发起之后置位 attempted，重试时重新武装", () => {
  let state = loggedOut();
  assert.equal(shouldAutoStartQr(state), true);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.equal(state.qrAttempted, true);
  assert.equal(state.qr.status, QR_GATE_STATUS.preparing, "还没拿到内容：是「正在准备」");
  assert.equal(shouldAutoStartQr(state), false, "已经发起过了");

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrFailed, message: "建单失败", errorKind: "http_error" });
  assert.equal(state.qr.status, QR_GATE_STATUS.failed);
  assert.equal(canRetryQr(state), true, "失败之后必须能重试（否则用户唯一的出路是重启应用）");

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.equal(state.qr.status, QR_GATE_STATUS.preparing);
  assert.equal(state.qr.message, null, "重试要把上一次的错误文案清掉");
});

// ---------------------------------------------------------------------------
// 3. 状态机：auth:qr 广播是二维码状态的唯一来源
// ---------------------------------------------------------------------------

test("二维码状态：广播逐档推进 pending → scanned → confirmed", () => {
  let state = loggedOut();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=X",
    expiresInMs: 181_000,
  });
  assert.equal(qrContentOf(state), "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=X");
  assert.equal(state.qr.expiresInMs, 181_000);
  assert.match(loginGateStatusLine(state), /扫码/);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.scanned });
  assert.equal(state.qr.status, QR_GATE_STATUS.scanned);
  assert.match(loginGateStatusLine(state), /确认/);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.confirmed });
  assert.equal(state.qr.status, QR_GATE_STATUS.confirmed);
  assert.match(loginGateStatusLine(state), /正在完成登录/);
});

test("二维码状态：过期是终止档（R21：不再自动换新）——旧码撤下，界面留着「已过期」等用户点刷新", () => {
  let state = pendingState("OLD");
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(state.qr.status, QR_GATE_STATUS.expired);
  assert.equal(loginGateStatusLine(state), QR_EXPIRED_NOTICE);
  assert.equal(shouldAutoStartQr(state), false, "过期不许自动再发一次 qr-start（R21 推翻 R16/R20 的自动换新）");

  // 用户点了刷新（容器或过期态那个「刷新二维码」按钮 = startQr）之后，新码才到
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "NEW" });
  assert.equal(state.qr.content, "NEW");
  assert.equal(qrContentOf(state), "NEW", "画面要画的东西换了：painter 因此会重画（见 test/qr-render.test.mjs）");
});

test("二维码状态：认不出的状态不猜（保持原状态，不把陌生档位当成已确认）", () => {
  let state = loggedOut();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "QR" });
  const before = JSON.stringify(state.qr);
  const untouched = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: "core-went-crazy" });
  assert.equal(JSON.stringify(untouched.qr), before);

  const unknownEvent = reduceGateState(state, { type: "nope" });
  assert.deepEqual(unknownEvent, state, "未知事件不改状态（纯函数）");
});

test("失败：广播带原文案，界面给得出「重试」；网页入口与错误类别无关（R18 起常驻）", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码登录端点未配置（见 docs/API_CONTRACT.md §1.7）",
    errorKind: "missing_endpoint",
  });
  assert.match(loginGateStatusLine(state), /端点未配置/, "失败文案要显示给用户，不许只进控制台");
  assert.equal(canRetryQr(state), true);
  assert.equal(canStartLogin(state), true, "常驻入口要能点（走既有的 auth:login 开窗路径）");

  // 网络抖一下同样只给「重试」：界面上的可操作元素集合不再按错误类别分叉
  const transient = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码状态轮询请求失败（连续 3 次：请检查网络或代理后重试）",
    errorKind: "network_error",
  });
  assert.equal(canRetryQr(transient), true);
  assert.equal(canStartLogin(transient), true);
});

test("状态机：auth:status 广播是**会话**状态的唯一来源（与二维码状态各管一段）", () => {
  let state = initialGateState();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: true });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedIn);
  assert.equal(shouldShowLoginGate(state), false);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedOut);
});

test("状态机：失败带原文案，后续事件不得把它静默吞掉；纯函数不改入参", () => {
  const failed = reduceGateState(
    reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.started }),
    { type: LOGIN_GATE_EVENT.failed, message: "无法打开华为官方登录页面，请检查网络或代理后重试。" },
  );
  assert.equal(failed.busy, false);
  assert.match(loginGateStatusLine(failed), /登录页面/);

  const before = initialGateState();
  const snapshot = JSON.stringify(before);
  reduceGateState(before, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.equal(JSON.stringify(before), snapshot);
});

// ---------------------------------------------------------------------------
// 4. R18 要求 4：常驻的「在网页中打开登录」+ 与二维码互斥（停了才开窗，窗关回二维码）
// ---------------------------------------------------------------------------

test("互斥：发起网页登录时状态行说的是「已在网页中打开登录」，不再复述二维码那条失败", () => {
  let state = loggedOut();
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码登录端点未配置（见 docs/API_CONTRACT.md §1.7）",
    errorKind: "missing_endpoint",
  });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.started });
  assert.equal(state.path, "official");
  assert.equal(state.busy, true);
  assert.match(loginGateStatusLine(state), /已在网页中打开登录/);
  assert.equal(canStartLogin(state), false, "窗已经开了：入口先禁用（不然就是并排第二次）");

  // 官方页那条路也失败时，最新那一句必须盖过二维码的旧文案
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.failed, message: "官方登录页打不开：请检查网络或代理。" });
  assert.match(loginGateStatusLine(state), /官方登录页打不开/);
});

test("互斥：网页那条路结束后回到二维码态（重新武装自动发起 + 留下它为什么结束的那句话）", () => {
  let state = loggedOut();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.started });
  assert.equal(shouldAutoStartQr(state), false, "窗在跑的时候不起二维码");

  // 宿主那条路的收场广播：busy 落下来 + 带一句给人看的话（failWith 的那一条）
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: false,
    message: "登录窗口已关闭（没有完成扫码）",
  });

  assert.equal(state.path, "qr", "回到二维码态");
  assert.equal(state.qrAttempted, false, "重新武装：自动发起要能再来一次");
  assert.equal(state.busy, false);
  assert.equal(shouldAutoStartQr(state), true);
  assert.match(loginGateStatusLine(state), /登录窗口已关闭/, "回二维码态之后先说清楚那条路怎么了");

  // 新码真的到了（pending 带内容）→ 撤掉那句话，状态行回到"等待扫码…"
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.match(loginGateStatusLine(state), /登录窗口已关闭/, "准备新码的这段时间里那句话还在");
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "NEW" });
  assert.equal(state.officialNote, null, "新码到了：网页那条路的说明退场");
  assert.match(loginGateStatusLine(state), /等待扫码/);
});

test("互斥：二维码会话自己的 busy 起伏（不带文案）不许把网页那条路踢回二维码态", () => {
  let state = loggedOut();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.started });
  // 端口取消时那条 announce({busy:false})：没有文案 = 不是"这条路收场了"
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false });
  assert.equal(state.path, "official", "竞态钉：没有文案的 busy:false 不算网页那条路结束");
  assert.equal(state.qrAttempted, false);
});

test("常驻入口：任何「还没登录」的非 busy 档位下它都是「打开」形态且可点", () => {
  const states = [
    initialGateState(),
    loggedOut(),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrRequested }),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "QR" }),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired }),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.failed, message: "x" }),
  ];
  for (const state of states) {
    assert.equal(canStartLogin(state), true, `档位 ${state.qr.status} 下入口被禁用了：${loginGateStatusLine(state)}`);
    assert.equal(webLoginEntry(state).form, "open", `档位 ${state.qr.status} 下入口形态不对`);
    assert.equal(webLoginEntry(state).disabled, false);
  }
});

// ---------------------------------------------------------------------------
// 5. 外壳顺序：门禁分支必须在 app-shell 之前
// ---------------------------------------------------------------------------

test("外壳顺序：App() 里门禁分支排在 app-shell 之前（未登录绝不渲染主界面）", () => {
  const source = read("src/renderer/App.tsx");
  const start = source.indexOf("export function App(");
  assert.ok(start > -1, "App.tsx 必须导出 App()");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end === -1 ? undefined : end);

  const gate = body.indexOf("shouldShowLoginGate(");
  const shell = body.indexOf("app-shell");
  assert.ok(gate > -1, `App() 里必须用 shouldShowLoginGate 判定门禁：${body}`);
  assert.ok(shell > -1, `App() 里要有 app-shell 挂载点（R8 的落点）：${body}`);
  assert.ok(gate < shell, "门禁判定必须排在 app-shell 之前：顺序反了就是未登录先渲染主界面");
  assert.doesNotMatch(body, /^\s*return\s+<AppShell/m, "不得绕过门禁直接返回主界面");
});

test("外壳顺序：main.tsx 渲染 App（不是 R1 的空壳）并先订阅后报就绪", () => {
  const source = read("src/renderer/main.tsx");
  assert.match(source, /from\s+"\.\/App\.tsx"/, "main.tsx 必须渲染 App.tsx");
  assert.doesNotMatch(source, /function App\(\)\s*\{\s*return null/, "R1 的空壳 App 必须换掉");
  const subscribe = source.indexOf("installDesktopBridge(");
  assert.ok(subscribe > -1, "main.tsx 要挂 window.desktop（订阅与调用都经它）");
});

// ---------------------------------------------------------------------------
// 6. 顶部内缩：唯一来源是共享常量，不许再写一份
// ---------------------------------------------------------------------------

test("顶部内缩：登录条高度来自共享常量，渲染层不得出现 48 字面量或 h-12", () => {
  assert.equal(LOGIN_VIEW_TOP_INSET, 48);

  const gate = read("src/renderer/login-gate.tsx");
  const logic = read("src/renderer/features/auth/login-gate-logic.mjs");

  assert.match(
    gate,
    /import\s*\{[^}]*LOGIN_VIEW_TOP_INSET[^}]*\}\s*from\s*"\.\.\/shared\/login-inset\.mjs"/,
    "login-gate.tsx 必须从共享常量导入顶部内缩（不许自己写一份）",
  );
  assert.doesNotMatch(gate, /\bh-12\b/, "h-12 是 48px 的第二份字面量：必须用共享常量");
  assert.doesNotMatch(gate, /LOGIN_VIEW_TOP_INSET\s*=\s*\d/, "不得重新定义这个常量");
  assert.doesNotMatch(logic, /\b48\b/, "逻辑模块里不该出现像素值");

  for (const relative of rendererFiles()) {
    const source = read(relative);
    source.split("\n").forEach((line, index) => {
      if (/inset/i.test(line) && /\b48\b/.test(line)) {
        assert.fail(`${relative}:${index + 1} 顶部内缩字面量出现在共享常量之外：${line.trim()}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 7. 视觉原语约束
// ---------------------------------------------------------------------------

test("视觉约束：无 <style> 标签；内联 style 只允许几何契约与 AMLL 尺寸两处", () => {
  const AMLL_SIZE_STYLE_FILES = ["src/renderer/AmllBackground.tsx", "src/renderer/AmllLyricsPanel.tsx"];
  const AMLL_SIZE_STYLE = 'style={{ width: "100%", height: "100%" }}';

  for (const relative of rendererFiles()) {
    if (relative.endsWith("amll-theme.css")) continue;
    const source = stripComments(read(relative));
    assert.doesNotMatch(source, /<style[\s>]/, `${relative} 不得内联 <style>（CSP script-src 'self' 会阻断内联脚本，样式也不走这条路）`);

    for (const match of source.matchAll(/style=\{\{[^}]*\}\}/g)) {
      if (match[0] === AMLL_SIZE_STYLE && AMLL_SIZE_STYLE_FILES.includes(relative)) continue;
      assert.match(
        match[0],
        /^style=\{\{\s*height:\s*LOGIN_VIEW_TOP_INSET\s*\}\}$/,
        `${relative} 的内联 style 只能是几何契约（高度=共享常量）或 AMLL 的 100% 尺寸：${match[0]}`,
      );
    }
  }
});

test("视觉约束：不挂载 next-themes 的 ThemeProvider（其防闪烁内联 script 会被 CSP 阻断）", () => {
  for (const relative of rendererFiles()) {
    assert.doesNotMatch(read(relative), /<ThemeProvider/, `${relative} 不得挂载 ThemeProvider`);
  }
  for (const relative of [
    "src/renderer/App.tsx",
    "src/renderer/login-gate.tsx",
    "src/renderer/main.tsx",
    "src/renderer/features/auth/login-gate-logic.mjs",
  ]) {
    assert.doesNotMatch(read(relative), /next-themes/, `${relative} 不得引入 next-themes`);
  }
});

test("视觉约束：登录门禁只用 shadcn 原语与工具类（不手写视觉组件、不硬编码色板）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /from\s+"\.\/components\/ui\/button"/, "按钮用 shadcn 的 Button");
  assert.match(gate, /from\s+"\.\/components\/ui\/skeleton"/, "加载态用 shadcn 的 Skeleton");
  assert.doesNotMatch(gate, /from\s+"\.\/components\/ui\/card"/, "R16 起不再用 Card 铺陈（标题是语义标题元素，不是 CardTitle）");
  assert.doesNotMatch(gate, /zinc-|amber-|gray-\d{3}/, "不得硬编码色板（一律设计令牌）");
});

// ---------------------------------------------------------------------------
// 8. 接线：二维码直显（成熟库）+ 常驻次要入口 + 白名单频道
// ---------------------------------------------------------------------------

test("二维码：用成熟库 qrcode 渲染到 canvas（不手写二维码组件/不自己编码）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  const painter = read("src/renderer/features/auth/qr-canvas.mjs");
  assert.match(painter, /from\s+"qrcode"/, "二维码必须由成熟库（qrcode，MIT）渲染");
  assert.match(painter, /toCanvas|toDataURL|toString/, "要用库的渲染入口（canvas/svg），不是自己画模块矩阵");
  assert.doesNotMatch(painter, /RS_BLOCK_TABLE|getModuleCount|finderPattern/, "不得手写二维码编码逻辑");
  assert.match(gate, /<canvas/, "二维码画在 canvas 上（CSP 已放行 data:，canvas 更省一层）");
  assert.match(gate, /paintQrCanvas/, "画法只有一处：features/auth/qr-canvas.mjs（画面与测试共用同一个入口）");
});

test("二维码边框（要求 2 / R20）：宿主容器用令牌工具类，不写自定义 CSS、不硬编码颜色", () => {
  const source = gateSource();
  const jsx = gateJsx();
  // 二维码宿主 = LoginGate 里包着 QrCanvas / Skeleton 的那个 <Button>（R20 起它可点刷新）
  const qrHostAt = jsx.indexOf("<QrCanvas");
  assert.ok(qrHostAt > -1, "LoginGate 里要挂 QrCanvas");
  const containerAt = jsx.lastIndexOf("<Button", qrHostAt);
  assert.ok(containerAt > -1, "二维码要有一个宿主容器");
  const container = jsx.slice(containerAt, jsx.indexOf(">", containerAt) + 1);
  assert.match(container, /border-border\b/, `边框颜色走设计令牌（border-border）：${container}`);
  assert.match(container, /rounded-(?:md|lg|xl)\b/, `圆角走工具类：${container}`);
  assert.doesNotMatch(container, /border-(?:white|black)|#[0-9a-fA-F]{3,8}|rgb\(/, `不得硬编码颜色：${container}`);
  assert.equal(/<style[\s>]/.test(source), false, "零自定义 CSS");
});

test("标题（要求 5 / R20 要求 1）：文案来自唯一真源，全页只出现一次（header 里那份已删）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  const source = stripComments(gate);
  const jsx = gateJsx();
  assert.equal(LOGIN_GATE_TITLE, "华为账号登录");
  assert.match(jsx, /LOGIN_GATE_TITLE/, "标题文案来自逻辑模块的唯一真源");
  assert.equal(
    source.split(LOGIN_GATE_TITLE).length - 1,
    0,
    "源码里不许再写一份标题字面量（包括 header 里那份）",
  );
  // header（几何契约）那条里不许有品牌：R20 起它与**窗口标题栏**重复的那句已删，
  // header 只剩"48px 的几何占位"（走网页入口时子窗正好落在那条下面）。
  const headerAt = jsx.indexOf("<header");
  assert.ok(headerAt > -1, "顶部 header 结构必须保留（LOGIN_VIEW_TOP_INSET 的对位契约）");
  const headerTag = jsx.slice(headerAt, jsx.indexOf(">", headerAt) + 1);
  assert.match(
    headerTag,
    /style=\{\{\s*height:\s*LOGIN_VIEW_TOP_INSET\s*\}\}/,
    `header 高度仍来自共享常量（几何契约不许破）：${headerTag}`,
  );
  assert.doesNotMatch(jsx, /APP_BRAND_LABEL/, "品牌不再进引导页（窗口标题栏已经有它）");
  assert.doesNotMatch(gate, /app-name\.mjs/, "连那个 import 一起删掉（留着就是下一次被误用）");

  // 标题在二维码容器之前（自上而下的形态：标题 → 二维码 → 提示 → 状态行 → 次要入口）
  const titleAt = jsx.indexOf("LOGIN_GATE_TITLE");
  assert.ok(titleAt > -1 && titleAt < jsx.indexOf("<QrCanvas"), "标题必须排在二维码容器之前");
});

test("常驻入口（要求 4 / R20 要求 3）：那个 <Button> 不被错误条件包裹，形态与文案来自唯一真源", () => {
  const source = gateSource();
  const jsx = gateJsx();
  assert.equal(WEB_LOGIN_ENTRY_TEXT, "在网页中打开登录");
  assert.equal(WEB_LOGIN_BACK_TEXT, "返回扫码登录");
  assert.match(jsx, /\{entry\.text\}/, "入口文案来自逻辑模块的唯一真源");
  assert.match(jsx, /data-testid=\{entry\.testid\}/, "入口要有测试锚点（真窗守据点名它）");
  assert.match(jsx, /disabled=\{entry\.disabled\}/, "可用性也由逻辑模块裁决（外壳不自己算）");
  // R25：正文里只剩 open 形态（back 形态的落点搬到了浮动 webview，见 login-chrome.tsx）
  assert.match(jsx, /\{entry\.form === "open" \? entryButton : null\}/, "只有 open 形态由 gate 渲染");
  assert.doesNotMatch(source, /\{entry\.form === "back"/, "gate 里不该再有 back 形态的落点");
  assert.equal(
    jsx.split("<Button").length - 1,
    3,
    "R25 起源码里恰好三个 shadcn Button：二维码刷新容器 / 重试（失败态）/ 常驻入口" +
      "（过期态那个刷新按钮已删；主题控件在 theme-control.tsx 里，是另一个组件）",
  );
  assert.equal(
    jsx.split("{entry.text}").length - 1,
    1,
    "入口元素只有一处定义",
  );
  assert.doesNotMatch(source, /shouldOfferOfficialFallback|OFFICIAL_FALLBACK_KINDS/, "按错误类别决定入口是否出现的那套判定已删除");
});

test("接线：门禁经 coreCall 调 auth:qr-start（自动/刷新）与 auth:login（入口），并订阅 auth:qr / auth:status", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /AUTH_QR_START/, "发起二维码走 auth:qr-start 请求频道");
  assert.match(gate, /AUTH_STATUS/, "会话状态来自 auth:status 广播");
  assert.match(gate, /AUTH_QR/, "二维码状态来自 auth:qr 广播");
  assert.match(gate, /AUTH_LOGIN/, "常驻入口仍走 auth:login");
  // R25：「返回扫码登录」搬出了门禁——它浮在官方页之上（浮动 webview），走专用命令。
  // 门禁这一层不再有第二条取消路径（也就不会再 import AUTH_CANCEL_LOGIN）。
  assert.doesNotMatch(
    stripComments(gate),
    /AUTH_CANCEL_LOGIN/,
    "取消登录只剩一条入口（浮动控件 → core_login_chrome）",
  );
  assert.match(
    read("src/renderer/login-chrome.tsx"),
    /coreLoginChrome/,
    "返回控件走 core_login_chrome（它不是业务频道：core_call 的来源守卫会拒浮动 webview）",
  );
  assert.doesNotMatch(gate, /["']auth:(login|logout|cancel-login|qr-start|get-status|status|qr)["']/, "频道名一律 import 共享常量，不写字面量");
});

// ---------------------------------------------------------------------------
// 9. 提示文案（要求 1）：唯一真源 + 状态行不复述它
// ---------------------------------------------------------------------------

test("提示文案（要求 1）：换成手机控制中心/设置两条路径那句，且状态行不再复述同一句", () => {
  assert.equal(QR_HINT_TEXT, "手机「控制中心」>「扫一扫」或者系统「设置」>「华为账号」>「扫一扫」。");

  const state = reduceGateState(loggedOut(), {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content: "QR",
  });
  assert.notEqual(
    loginGateStatusLine(state),
    QR_HINT_TEXT,
    "提示文字与状态行是两行，pending 档不许把同一句话再说一遍（页面上会出现两次）",
  );
  assert.match(loginGateStatusLine(state), /扫码/);
});

// ---------------------------------------------------------------------------
// 10. R19：挂载时**主动查**一次登录状态（reload/崩溃重启不再卡 checking）
// ---------------------------------------------------------------------------
//
// 缺口：`auth:status` 只在 sidecar 启动时广播一次（经 Rust 的 NoticeQueue 冲刷）；
// 渲染层 reload/崩溃重启之后那一条已经冲刷过了 → 门禁永远停在 `checking`、
// 二维码不发起、页面上只有"正在检查登录状态…"。
// 修法：订阅就位之后 `core_call('auth:get-status')`，应答喂**同一条** status 事件。

test("重查（R19）：查询应答喂的是同一条 status 事件——未登录 → 确定未登录，自动发起照样武装", () => {
  const state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: false,
  });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedOut, "查完才知道没登录：这才是确定性获取");
  assert.equal(shouldAutoStartQr(state), true, "确定未登录之后，二维码照老规矩自动发起");
});

test("重查（R19）：已登录的会话在 reload 之后照样放行（不必等一条不会再来的启动广播）", () => {
  const state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: true,
    busy: false,
  });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedIn);
  assert.equal(shouldShowLoginGate(state), false, "已登录 → 放行 app-shell");
  assert.equal(shouldAutoStartQr(state), false, "已登录不建二维码订单");
});

test("重查（R19）：查询答 busy:true 与广播同一条判定（不起第二张码、常驻入口禁用）", () => {
  const state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: true,
  });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedOut);
  assert.equal(state.busy, true);
  assert.equal(shouldAutoStartQr(state), false, "开窗那条路正在跑：不建二维码订单");
  assert.equal(canStartLogin(state), false, "常驻入口此时禁用（与广播说的是同一件事）");
});

test("重查（R19）：查询与广播不冲突——谁后到谁说了算，两件事共用一条事件", () => {
  const query = { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false };
  const broadcast = { type: LOGIN_GATE_EVENT.status, loggedIn: true, busy: false };

  const queryFirst = reduceGateState(reduceGateState(initialGateState(), query), broadcast);
  const broadcastFirst = reduceGateState(reduceGateState(initialGateState(), broadcast), query);
  assert.equal(queryFirst.phase, LOGIN_GATE_PHASE.loggedIn, "广播后到：以广播为准");
  assert.equal(broadcastFirst.phase, LOGIN_GATE_PHASE.loggedOut, "查询后到：以查询为准（它是当前事实）");

  // 重复喂同一份（广播与查询都答"未登录"）不该把状态搅坏：门禁仍是确定的未登录
  const twice = reduceGateState(reduceGateState(initialGateState(), query), query);
  assert.equal(twice.phase, LOGIN_GATE_PHASE.loggedOut);
  assert.equal(shouldAutoStartQr(twice), true);
});

test("重查（R19）：查询失败不猜档位（仍 checking），但把原因说出来——空白 spinner 正是要消灭的现象", () => {
  const state = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.failed,
    message: "查询登录状态失败：未知请求频道：auth:get-status",
  });
  assert.equal(state.phase, LOGIN_GATE_PHASE.checking, "没答上来就不许下结论（未登录/已登录都不猜）");
  assert.match(loginGateStatusLine(state), /查询登录状态失败/, "状态行要说出原因，不能只留一句「正在检查登录状态…」");
  assert.equal(canStartLogin(state), true, "常驻入口仍在：用户至少能走网页那条路");
});

test("重查（R19）：挂载 effect 里**订阅之后**先报就绪、再查一次 auth:get-status（走共享常量）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /AUTH_GET_STATUS/, "查询频道来自共享常量表（不写字面量）");
  assert.match(
    gate,
    /import\s*\{[^}]*AUTH_GET_STATUS[^}]*\}\s*from\s*"\.\.\/shared\/request-channels\.ts"/,
    "AUTH_GET_STATUS 必须从 src/shared/request-channels.ts 导入（唯一真源）",
  );

  const effectStart = gate.indexOf("useEffect(() => {");
  const effectEnd = gate.indexOf("const startQr = useCallback");
  assert.ok(effectStart > -1 && effectEnd > effectStart, "useAuthGate 的挂载 effect 要能被定位");
  const effect = gate.slice(effectStart, effectEnd);

  const statusAt = effect.indexOf("onCoreEvent<AuthStatusPayload>(AUTH_STATUS");
  const qrAt = effect.indexOf("onCoreEvent<QrStatusPayload>(AUTH_QR");
  const readyAt = effect.indexOf("rendererReady()");
  const queryAt = effect.indexOf("coreCall<AuthStatusPayload>(AUTH_GET_STATUS");
  assert.ok(statusAt > -1, "订阅 auth:status");
  assert.ok(qrAt > -1, "订阅 auth:qr");
  assert.ok(readyAt > -1, "报就绪（冲刷启动期排队的提示）");
  assert.ok(queryAt > -1, `挂载时要主动查一次当前状态：${effect}`);
  assert.ok(statusAt < queryAt, "查询必须排在**订阅之后**：反过来的话这一段窗口里的广播就丢了");
  assert.ok(qrAt < queryAt, "二维码那条订阅同理");
  assert.ok(readyAt < queryAt, "先冲刷排队的那条广播、再查：查询的应答一定不比排队的旧");

  // 两处喂的状态事件必须是同一份映射（各写一份 = 早晚漂移）
  const mapping = gate.match(/function statusEventOf\(/g) ?? [];
  assert.equal(mapping.length, 1, "广播与查询共用同一个载荷 → 事件映射（statusEventOf）");
  assert.equal(
    (effect.match(/statusEventOf\(/g) ?? []).length,
    2,
    "effect 里广播回调与查询应答各喂一次，且都经 statusEventOf",
  );
});

// ---------------------------------------------------------------------------
// 11. R20：真机验收的三项修复（第 2 项的"自动换新"部分已由 R21 用户指令推翻，见 §12）
// ---------------------------------------------------------------------------
//
// 诊断先行（可复现证据 `.probe/qr-expiry-diag.json`，`node scripts/probe-qr.mjs --until-expired`）：
// 服务端**会**给出过期档位——建单 TTL 181s，轮询到 t+177.4s 时 `103000200` → `103000201`。
// 所以"过期没有任何变化"不是 poll 静默挂，而是**渲染层**（旧码留在屏上）。
// R20 的修法是"sidecar 自动换新 + 渲染层撤旧码"；**R21 按用户指令改成"过期停住、等用户点刷新"**，
// 于是 §12 起 `expired` 是一条终止档，`qrNotice`（"已刷新，请重新扫码"）**整条链删除**。

/** 走到"已经拿到一张码"的状态。 */
function pendingState(content = "OLD") {
  let state = reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrRequested });
  return reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content,
    expiresInMs: 181_000,
    at: 1_000_000,
  });
}

test("R20 过期：expired 到达当场撤掉旧码（不可扫的过期码绝不留在屏上让人扫）", () => {
  const expired = reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(expired.qr.status, QR_GATE_STATUS.expired);
  assert.equal(qrContentOf(expired), null, "画面必须回到占位：留着旧码就是让用户去扫一张死码");
  assert.equal(expired.qr.expiresInMs, null, "有效期一起清掉（它已经是过去时）");

  // 新码只会在**用户点了刷新**之后到（R21：没有自动换新那一跳）
  const renewed = reduceGateState(
    reduceGateState(expired, { type: LOGIN_GATE_EVENT.qrRequested }),
    { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "NEW" },
  );
  assert.equal(qrContentOf(renewed), "NEW");
});

test("R21 状态行：过期说的是「已过期，点击刷新」，失败说的是为什么（不许互相冒充）", () => {
  const expired = reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(loginGateStatusLine(expired), QR_EXPIRED_NOTICE);

  // 用户按了刷新：这句比「已过期」更贴当下
  const rearmed = reduceGateState(expired, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.match(loginGateStatusLine(rearmed), /正在准备二维码/);

  // 从网页那条路退回来（R18 的 returnToQr）：说的是**刚发生的另一件事**，不许与过期串台
  const back = reduceGateState(
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started }),
    { type: LOGIN_GATE_EVENT.status, loggedIn: false, busy: false, message: "已取消登录" },
  );
  assert.match(loginGateStatusLine(back), /取消/);
  assert.doesNotMatch(loginGateStatusLine(back), /二维码已过期/);

  // 失败档位：屏幕上要留的是"为什么失败"
  const failed = reduceGateState(expired, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.failed, message: "轮询失败" });
  assert.equal(loginGateStatusLine(failed), "轮询失败");
});

test("R20 手动刷新：二维码容器可点（等待/已扫/过期/失败都点得动；准备中、已确认、网页那条路开着时不可点）", () => {
  assert.equal(canRefreshQr(pendingState()), true, "等待扫码：点它就是换一张新码");
  assert.equal(
    canRefreshQr(reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.scanned })),
    true,
  );
  assert.equal(
    canRefreshQr(reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired })),
    true,
  );
  assert.equal(
    canRefreshQr(reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.failed, message: "x" })),
    true,
    "失败态下点容器 = 重来一张（「重试」按钮做的是同一件事）",
  );

  assert.equal(canRefreshQr(loggedOut()), false, "还没有内容（准备中）：再点一次只是重复建单");
  assert.equal(
    canRefreshQr(reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.confirmed })),
    false,
    "已确认：正在换码，这时换一张新码只会把已经成功的那次作废",
  );
  assert.equal(
    canRefreshQr(reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started })),
    false,
    "网页那条路开着：那一层被窗盖住",
  );
});

test("R20 手动刷新：文案与锚点是唯一真源，点击走 startQr（与自动发起同一条路：换一张新码）", () => {
  assert.equal(QR_REFRESH_LABEL, "刷新二维码");
  assert.equal(QR_REFRESH_TESTID, "login-qr-refresh");
  assert.equal(QR_COUNTDOWN_TESTID, "login-qr-countdown");

  const jsx = gateJsx();
  assert.match(jsx, /aria-label=\{QR_REFRESH_LABEL\}/, "可点元素要有可达名字（键盘/读屏都要能用）");
  assert.match(jsx, /data-testid=\{QR_REFRESH_TESTID\}/, "真窗守据点名它");
  assert.match(jsx, /disabled=\{!canRefreshQr\(state\)\}/, "不可点的档位由逻辑模块裁决");

  // 点击语义：容器就是唯一的换码控件（startQr = qrRequested + auth:qr-start）
  const refreshAt = jsx.indexOf("<Button", jsx.indexOf("QR_REFRESH_TESTID") - 400);
  const block = jsx.slice(refreshAt, jsx.indexOf("</Button>", refreshAt));
  assert.match(block, /onClick=\{startQr\}/, `刷新要绑 startQr：${block}`);
  assert.match(block, /onClick=\{startQr\}[\s\S]*QR_REFRESH_TESTID|QR_REFRESH_TESTID[\s\S]*onClick=\{startQr\}/, "同一个元素上");

  // R25 要求 1：过期占位只有两行，「刷新二维码」按钮删掉——源码里不该再出现它
  assert.equal(
    jsx.split("QR_REFRESH_LABEL").length - 1,
    1,
    "QR_REFRESH_LABEL 只该出现在容器那个 aria-label 上（过期态那个按钮已删）",
  );
  assert.match(jsx, /QR_EXPIRED_BOX_HINT/, "过期占位第二行来自唯一真源");
});

test("R25 返回扫码登录：形态判定仍在逻辑层，落点搬到浮动 webview（gate 里不渲染它）", () => {
  const official = reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started });
  const entry = webLoginEntry(official);
  assert.equal(entry.form, "back");
  assert.equal(entry.text, WEB_LOGIN_BACK_TEXT);
  assert.equal(entry.testid, WEB_LOGIN_BACK_TESTID);
  assert.equal(entry.disabled, false, "窗开着时它必须点得动：那是用户唯一的回退路径");

  // 非 official 档：还是原来那个常驻入口
  const normal = webLoginEntry(pendingState());
  assert.equal(normal.form, "open");
  assert.equal(normal.text, WEB_LOGIN_ENTRY_TEXT);
  assert.equal(normal.testid, WEB_LOGIN_ENTRY_TESTID);
  assert.equal(normal.disabled, false);

  // 源码：back 形态**不在** gate 里（官方页铺满整窗，gate 整个在它底下），
  // 由浮动控件渲染——文案与锚点还是同一份常量（不是各写一份）
  const jsx = gateJsx();
  assert.doesNotMatch(jsx, /\{entry\.form === "back"/, "gate 里没有 back 形态的落点");
  const chrome = read("src/renderer/login-chrome.tsx");
  assert.match(chrome, /WEB_LOGIN_BACK_TEXT/, "浮动控件用同一份文案常量");
  assert.match(chrome, /WEB_LOGIN_BACK_TESTID/, "浮动控件用同一份锚点常量");
});

test("R25 返回扫码登录：形态判据仍是 busy（不是本地那个 path）——渲染层 reload 之后照样有回去的路", () => {
  // R19 的场景：reload 之后门禁靠 auth:get-status 重建状态，那时 `path` 是 null，
  // 只有 sidecar 的 `busy:true` 说明"窗还开着"。若按 path 判形态，入口会退回"打开"形态
  // ——而它此刻点不动（官方页盖着正文），用户就没有任何回去的路。
  const afterReload = { ...initialGateState(), phase: LOGIN_GATE_PHASE.loggedOut, busy: true };
  const entry = webLoginEntry(afterReload);
  assert.equal(entry.form, "back", "窗还开着：此刻该存在的是「返回扫码登录」");
  assert.equal(entry.disabled, false);

  // 两种形态永远可点（R17 的教训：最需要它的场景里它不许是灰的）
  for (const state of [
    initialGateState(),
    loggedOut(),
    pendingState(),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrFailed, message: "建单失败" }),
    reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started }),
  ]) {
    assert.equal(webLoginEntry(state).disabled, false, `档位 ${loginGateStatusLine(state)} 下入口被禁用了`);
  }
});

test("R20 返回扫码登录：点击走 auth:cancel-login，那条路收场后回到二维码态并重新发码（R18 链不变）", () => {
  const official = reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started });
  assert.equal(shouldAutoStartQr(official), false, "窗还开着时不起二维码");

  // sidecar：cancelLogin → 宿主关窗 → 结论 cancelled → failWith("已取消登录") → 广播带文案
  const returned = reduceGateState(official, {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: false,
    message: "已取消登录",
  });
  assert.equal(returned.path, "qr", "回到二维码态");
  assert.equal(shouldAutoStartQr(returned), true, "重新武装自动发起：眼前立刻要有一张能扫的码");
  assert.match(loginGateStatusLine(returned), /取消/, "先说清那条路怎么了");
  assert.equal(webLoginEntry(returned).form, "open", "入口变回「在网页中打开登录」");

  // 同一条规矩也管本地的 `cancelled` 事件：留在 official 上而 busy 已落，
  // 入口会变回"打开"形态——窗若还开着就又没人可点（R20 自审修的那一处）
  const localCancel = reduceGateState(official, { type: LOGIN_GATE_EVENT.cancelled });
  assert.equal(localCancel.path, "qr");
  assert.equal(shouldAutoStartQr(localCancel), true);
  assert.equal(webLoginEntry(localCancel).form, "open");
});

// ---------------------------------------------------------------------------
// 12. R21（用户指令 2026-10-20）：过期倒计时 + 过期态不可扫 + **只能手动刷新**
// ---------------------------------------------------------------------------
//
// 这一轮**推翻了 R16/R20 的"过期自动换新"裁决**：sidecar 在 `expired` 上只广播 + 停轮询
// （协议层钉在 `test/qr-login.test.mjs`），于是"再来一张"只剩用户手动这一条路。
// 渲染层因此多两件事：把"还剩多久"显示出来、把过期态做成"停住 + 请用户点刷新"。
//
// **权威归属**：本地倒计时只是显示；过期判定以服务端 `expired` 广播为准
// （实测：TTL 181s、t+177.4s 收到 `103000201`，见契约 §1.8 的 R20 段）。
// 本地到 0 时**不**自行改档、也**不**撤下二维码——那一刻只是"该过期了"，
// 它显示「正在确认过期…」，等那条广播来收口（服务端提前于本地归零到达，这一档是罕见的兜底）。

/** R21 夹具：一张"还剩 `expiresInMs`"的码（`at` = 事件发生时刻，钟由调用方注入）。 */
function liveState({ expiresInMs = 181_000, at = 1_000_000, content = "QR" } = {}) {
  const waiting = reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrRequested });
  return reduceGateState(waiting, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content,
    expiresInMs,
    at,
  });
}

test("R21 倒计时：建单应答里的 expiresInMs → 秒级文案，随时间递减", () => {
  let state = liveState({ expiresInMs: 181_000, at: 1_000_000 });
  assert.equal(qrCountdownText(state), "剩 181 秒过期", "拿到码的那一刻就有倒计时（不必等第一次 tick）");

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.tick, nowMs: 1_000_000 + 30_000 });
  assert.equal(qrCountdownText(state), "剩 151 秒过期");

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.tick, nowMs: 1_000_000 + 180_500 });
  assert.equal(qrCountdownText(state), "剩 1 秒过期", "不足一秒仍显示 1 秒：不许提前说 0（0 是「正在确认」那一档）");

  // 坏时钟/没超时值时不编造：没有 expiresInMs 就没有倒计时（界面少一行，不是显示"剩 0 秒"）
  assert.equal(qrCountdownText(liveState({ expiresInMs: null })), null);
});

test("R21 倒计时：本地归零只是「正在确认过期…」，过期判定仍以服务端 expired 广播为权威", () => {
  let state = liveState({ expiresInMs: 181_000, at: 1_000_000 });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.tick, nowMs: 1_000_000 + 181_000 });
  assert.equal(qrCountdownText(state), QR_EXPIRING_TEXT);
  assert.equal(state.qr.status, QR_GATE_STATUS.pending, "本地钟不是权威：这一档仍是 pending（码还留在屏上）");
  assert.equal(qrContentOf(state), "QR", "本地归零不撤码：那张码的生死由服务端说了算");

  // 表停在到期时刻：再 tick 返回**同一个对象**（React 因此不再重渲染，本地不空转）
  const frozen = reduceGateState(state, { type: LOGIN_GATE_EVENT.tick, nowMs: 1_000_000 + 900_000 });
  assert.equal(frozen, state, "已钳到 0：后续 tick 不改状态（停表）");

  // 服务端那条广播才把它落成过期
  const expired = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(expired.qr.status, QR_GATE_STATUS.expired);
  assert.equal(qrCountdownText(expired), null, "过期态不再有倒计时");
});

test("R21 过期：只手动刷新——过期不重新武装自动发起，刷新后倒计时按新码重置", () => {
  const expired = reduceGateState(liveState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(shouldAutoStartQr(expired), false, "过期不许自动再发一次 qr-start（R21 推翻自动换新）");
  assert.equal(canRefreshQr(expired), true, "手动那条路开着：容器与过期态的按钮都点得动");
  assert.equal(loginGateStatusLine(expired), QR_EXPIRED_NOTICE);

  const refreshed = reduceGateState(expired, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.equal(refreshed.qr.status, QR_GATE_STATUS.preparing, "点了刷新 = 与自动发起同一条路（qrRequested → auth:qr-start）");
  assert.equal(qrCountdownText(refreshed), null, "新码还没到：没有倒计时可显示");

  const renewed = reduceGateState(refreshed, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content: "NEW",
    expiresInMs: 181_000,
    at: 5_000_000,
  });
  assert.equal(qrCountdownText(renewed), "剩 181 秒过期", "倒计时按**新**码的有效期重新开始（不是接着旧的数）");
});

test("R21 倒计时：钟在渲染层——门禁源码要真的开表与停表（不是只在文案上做样子）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /LOGIN_GATE_EVENT\.tick/, "每秒喂一次 tick 事件（倒计时的唯一驱动）");
  assert.match(gate, /setInterval\(/, "tick 由 setInterval 驱动");
  assert.match(gate, /clearInterval\(/, "离开这一档要停表（否则每分钟一次的重渲染跟着用户一辈子）");
  assert.match(gate, /expiresAt/, "只在有到期时刻时才开表");
  assert.doesNotMatch(gate, /qrNotice|QR_REFRESH_NOTICE/, "R20 的「已刷新」提示链已删（不再自动刷新，就没有「刚换过」这一刻）");
  // 只扫代码，不扫注释：说明文字里写着"这条链已删除"不算残留
  const logicCode = stripComments(read("src/renderer/features/auth/login-gate-logic.mjs"));
  assert.equal(
    (logicCode.match(/QR_REFRESH_NOTICE|qrNotice/g) ?? []).length,
    0,
    "QR_REFRESH_NOTICE 整条链删除（常量、状态字段、退场规则都不留）",
  );
});
