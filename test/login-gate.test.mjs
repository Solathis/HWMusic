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
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  WEB_LOGIN_ENTRY_TESTID,
  WEB_LOGIN_ENTRY_TEXT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  qrContentOf,
  reduceGateState,
  shouldAutoStartQr,
  shouldShowLoginGate,
} from "../src/renderer/features/auth/login-gate-logic.mjs";

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

test("二维码状态：过期由 sidecar 自动换新（渲染层只显示「已刷新」，不自己发起）", () => {
  let state = loggedOut();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "OLD" });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(state.qr.status, QR_GATE_STATUS.expired);
  assert.match(loginGateStatusLine(state), /二维码已刷新/);

  // 紧接着 sidecar 会广播新的 pending（新内容），界面直接换成新码
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

test("常驻入口：任何「还没登录」的档位下它都可点（只有开窗那条路在跑时才禁用）", () => {
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

test("二维码边框（要求 2）：容器用令牌工具类，不写自定义 CSS、不硬编码颜色", () => {
  const source = gateSource();
  const jsx = gateJsx();
  // 二维码容器 = LoginGate 里包着 QrCanvas / Skeleton 的那个 <div>
  const qrHostAt = jsx.indexOf("<QrCanvas");
  assert.ok(qrHostAt > -1, "LoginGate 里要挂 QrCanvas");
  const containerAt = jsx.lastIndexOf("<div", qrHostAt);
  assert.ok(containerAt > -1, "二维码要有一个容器 div");
  const container = jsx.slice(containerAt, jsx.indexOf(">", containerAt) + 1);
  assert.match(container, /className="[^"]*\bborder\b/, `二维码容器要有边框宽度类：${container}`);
  assert.match(container, /border-border\b/, `边框颜色走设计令牌（border-border）：${container}`);
  assert.match(container, /rounded-(?:md|lg|xl)\b/, `圆角走工具类：${container}`);
  assert.doesNotMatch(container, /border-(?:white|black)|#[0-9a-fA-F]{3,8}|rgb\(/, `不得硬编码颜色：${container}`);
  assert.equal(/<style[\s>]/.test(source), false, "零自定义 CSS");
});

test("标题（要求 5）：文案来自唯一真源，且本文件里只出现一次（header 里那份已删）", () => {
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
  // header（几何契约）那条里不许再有标题：R18 起它只剩品牌
  const headerAt = jsx.indexOf("<header");
  const headerTag = jsx.slice(headerAt, jsx.indexOf("</header>", headerAt));
  assert.match(headerTag, /APP_BRAND_LABEL/, `header 只留品牌：${headerTag}`);
  assert.doesNotMatch(headerTag, /LOGIN_GATE_TITLE/, "标题不许留在 header 里（全页只出现一次）");

  // 标题在二维码容器之前（自上而下的形态：标题 → 二维码 → 提示 → 状态行 → 次要入口）
  const titleAt = jsx.indexOf("LOGIN_GATE_TITLE");
  assert.ok(titleAt > -1 && titleAt < jsx.indexOf("<QrCanvas"), "标题必须排在二维码容器之前");
});

test("常驻入口（要求 4）：源码里那个 <Button> 不被条件包裹，且走既有 auth:login 路径", () => {
  const source = gateSource();
  const jsx = gateJsx();
  assert.equal(WEB_LOGIN_ENTRY_TEXT, "在网页中打开登录");
  assert.match(jsx, /\{WEB_LOGIN_ENTRY_TEXT\}/, "入口文案来自逻辑模块的唯一真源");
  assert.match(jsx, /data-testid=\{WEB_LOGIN_ENTRY_TESTID\}/, "常驻入口要有测试锚点（真窗守据点名它）");

  const entryAt = jsx.indexOf("{WEB_LOGIN_ENTRY_TEXT}");
  const retryConditional = jsx.indexOf(") : null}", jsx.indexOf("canRetryQr("));
  assert.ok(retryConditional > -1, "「重试」仍是条件渲染（只在失败态出现）");
  assert.ok(entryAt > retryConditional, "形态顺序：…状态行 → 重试（失败态）→ 常驻入口");
  assert.doesNotMatch(
    jsx.slice(retryConditional, entryAt),
    /\?/,
    "入口之前没有第二个条件渲染：它是常驻的（不再是「只在协议不可用时出现」）",
  );
  assert.doesNotMatch(source, /shouldOfferOfficialFallback|OFFICIAL_FALLBACK_KINDS/, "按错误类别决定入口是否出现的那套判定已删除");
});

test("入口与重试的数量：源码里恰好两个 <Button>（正常路径只有常驻入口那一个）", () => {
  const source = gateJsx();
  const buttons = [...source.matchAll(/<Button\b/g)].map((match) => match.index);
  assert.equal(buttons.length, 2, `只允许「重试」与常驻入口两个（实际 ${buttons.length} 个）`);
  assert.doesNotMatch(source, />\s*打开官方登录页\s*</, "旧按钮流必须删掉");
});

test("接线：门禁经 coreCall 调 auth:qr-start（自动）与 auth:login（常驻入口），并订阅 auth:qr / auth:status", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /AUTH_QR_START/, "发起二维码走 auth:qr-start 请求频道");
  assert.match(gate, /AUTH_STATUS/, "会话状态来自 auth:status 广播");
  assert.match(gate, /AUTH_QR/, "二维码状态来自 auth:qr 广播");
  assert.match(gate, /AUTH_LOGIN/, "常驻入口仍走 auth:login");
  assert.equal(
    gate.includes("AUTH_CANCEL_LOGIN"),
    false,
    "引导页没有取消按钮：停二维码轮询由 sidecar 在开窗时自己做（两条路互斥，见 auth-manager.login）",
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
