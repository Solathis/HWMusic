/**
 * R16 渲染层登录门禁（引导页）：判定纯函数 + 外壳骨架的**顺序**契约 + 视觉原语约束。
 *
 * 用户指令推翻了 R7 的"按钮流"裁决：引导页**只展示二维码和提示文字**——
 * 进页面就自动发起二维码（`auth:qr-start`，零按钮），扫码状态经 `auth:qr` 广播回来；
 * 只有**出错**时才出现可操作的东西（重试），以及"二维码不可用"时的次要入口（官方页面）。
 *
 * 四条硬要求：
 * 1. 未登录**绝不渲染 app-shell**：门禁分支必须在 App() 里排在 app-shell 之前（源码顺序扫描）；
 * 2. 正常路径**零按钮**：源码里只允许出现"重试"与"在华为官方页面打开登录"两处可操作元素，
 *    且都必须挂在 `qr.status === failed` 的分支里；
 * 3. 顶部内缩不许出现第二份字面量：高度来自 src/shared/login-inset.mjs，且不许写 `h-12`；
 * 4. 二维码必须由**成熟库**渲染（`qrcode`，MIT）：不手写二维码组件、不自绘编码逻辑。
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
  OFFICIAL_FALLBACK_KINDS,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  reduceGateState,
  shouldAutoStartQr,
  shouldOfferOfficialFallback,
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
// 2. 自动开始：门禁内 + 不 busy + 本轮未发起（三条件缺一不可），全程没有按钮
// ---------------------------------------------------------------------------

test("自动开始：三条件齐备才发起二维码；缺任何一条都不发起", () => {
  const ready = { phase: LOGIN_GATE_PHASE.loggedOut, busy: false, qrAttempted: false };
  assert.equal(shouldAutoStartQr(ready), true);

  assert.equal(shouldAutoStartQr({ ...ready, phase: LOGIN_GATE_PHASE.checking }), false, "检查中不发起");
  assert.equal(shouldAutoStartQr({ ...ready, phase: LOGIN_GATE_PHASE.loggedIn }), false, "已登录不再扫码");
  assert.equal(shouldAutoStartQr({ ...ready, busy: true }), false, "正在登录（开窗那条路）时不起第二张码");
  assert.equal(shouldAutoStartQr({ ...ready, qrAttempted: true }), false, "本轮已经发起过（不重复建单）");
});

test("自动开始：发起之后置位 attempted，重试时重新武装", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
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
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qrRequested });
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=X",
    expiresInMs: 181_000,
  });
  assert.equal(state.qr.content, "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=X");
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
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "OLD" });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
  assert.equal(state.qr.status, QR_GATE_STATUS.expired);
  assert.match(loginGateStatusLine(state), /二维码已刷新/);

  // 紧接着 sidecar 会广播新的 pending（新内容），界面直接换成新码
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "NEW" });
  assert.equal(state.qr.content, "NEW");
});

test("二维码状态：认不出的状态不猜（保持原状态，不把陌生档位当成已确认）", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "QR" });
  const before = JSON.stringify(state.qr);
  const untouched = reduceGateState(state, { type: LOGIN_GATE_EVENT.qr, status: "core-went-crazy" });
  assert.equal(JSON.stringify(untouched.qr), before);

  const unknownEvent = reduceGateState(state, { type: "nope" });
  assert.deepEqual(unknownEvent, state, "未知事件不改状态（纯函数）");
});

test("失败：广播带原文案；协议不可用那一类才给官方页面这条次要入口", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码登录端点未配置（见 docs/API_CONTRACT.md §1.7）",
    errorKind: "missing_endpoint",
  });
  assert.match(loginGateStatusLine(state), /端点未配置/, "失败文案要显示给用户，不许只进控制台");
  assert.equal(shouldOfferOfficialFallback(state), true);
  assert.equal(canStartLogin(state), true, "次要入口要能点（走既有的 auth:login 开窗路径）");
  assert.ok(OFFICIAL_FALLBACK_KINDS.includes("missing_endpoint"));

  // 网络抖一下不算"二维码不可用"：只给重试，不给"退回官方页"这条更重的路
  const transient = reduceGateState(initialGateState(), {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码状态轮询请求失败（连续 3 次：请检查网络或代理后重试）",
    errorKind: "network_error",
  });
  assert.equal(shouldOfferOfficialFallback(transient), false);
  assert.equal(canRetryQr(transient), true);
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
  assert.equal(failed.message, "无法打开华为官方登录页面，请检查网络或代理后重试。");
  assert.match(loginGateStatusLine(failed), /登录页面/);

  const before = initialGateState();
  const snapshot = JSON.stringify(before);
  reduceGateState(before, { type: LOGIN_GATE_EVENT.qrRequested });
  assert.equal(JSON.stringify(before), snapshot);
});

test("次要入口：点了官方页入口之后，状态行说的是「窗已打开」，不再复述二维码那条失败", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  state = reduceGateState(state, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.failed,
    message: "二维码登录端点未配置（见 docs/API_CONTRACT.md §1.7）",
    errorKind: "missing_endpoint",
  });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.started });
  assert.match(loginGateStatusLine(state), /官方登录页/);

  // 官方页那条路也失败时，最新那一句必须盖过二维码的旧文案
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.failed, message: "官方登录页打不开：请检查网络或代理。" });
  assert.match(loginGateStatusLine(state), /官方登录页打不开/);
});

// ---------------------------------------------------------------------------
// 4. 外壳顺序：门禁分支必须在 app-shell 之前
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
// 5. 顶部内缩：唯一来源是共享常量，不许再写一份
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
// 6. 视觉原语约束
// ---------------------------------------------------------------------------

/**
 * 只扫代码，不扫注释：注释里写"不许 <style> / 不许内联视觉样式"是说明文字，不是违规。
 * 保留 `://`（URL 里的双斜杠前面是冒号，不算行注释）。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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
  assert.match(gate, /from\s+"\.\/components\/ui\/button"/, "按钮用 shadcn 的 Button（错误路径的重试/次要入口）");
  assert.doesNotMatch(gate, /from\s+"\.\/components\/ui\/card"/, "R16 起不再用 Card 铺陈（引导页只有二维码与一行提示）");
  assert.doesNotMatch(gate, /zinc-|amber-|gray-\d{3}/, "不得硬编码色板（一律设计令牌）");
});

// ---------------------------------------------------------------------------
// 7. 接线：二维码直显（成熟库）+ 零按钮正常路径 + 白名单频道
// ---------------------------------------------------------------------------

test("二维码：用成熟库 qrcode 渲染到 canvas（不手写二维码组件/不自己编码）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /from\s+"qrcode"/, "二维码必须由成熟库（qrcode，MIT）渲染");
  assert.match(gate, /toCanvas|toDataURL|toString/, "要用库的渲染入口（canvas/svg），不是自己画模块矩阵");
  assert.doesNotMatch(gate, /RS_BLOCK_TABLE|getModuleCount|finderPattern/, "不得手写二维码编码逻辑");
  assert.match(gate, /<canvas/, "二维码画在 canvas 上（CSP 已放行 data:，canvas 更省一层）");
});

test("正常路径零按钮：两处可操作元素都挂在失败分支里（重试 / 官方页次要入口）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  const source = stripComments(gate);

  // 先钉文案：正常路径不许出现"打开"这类按钮文案
  assert.equal(QR_HINT_TEXT, "请使用华为手机上的华为账号扫码登录。");
  assert.match(gate, /QR_HINT_TEXT/, "提示文字来自逻辑模块的唯一真源（文案改动要能测）");

  // 按钮只允许出现在失败分支之后：把"第一个失败判定"的位置当作分界
  const retryAt = source.indexOf("canRetryQr(");
  const fallbackAt = source.indexOf("shouldOfferOfficialFallback(");
  assert.ok(retryAt > -1, "重试按钮要由 canRetryQr 判定");
  assert.ok(fallbackAt > -1, "官方页入口要由 shouldOfferOfficialFallback 判定");

  const buttons = [...source.matchAll(/<Button\b/g)].map((match) => match.index);
  assert.equal(buttons.length, 2, `正常路径零按钮：只允许"重试"与"官方页次要入口"两个（实际 ${buttons.length} 个）`);
  for (const index of buttons) {
    assert.ok(
      index > Math.min(retryAt, fallbackAt),
      "按钮必须排在失败判定之后（正常路径上它们不渲染）",
    );
  }
  assert.doesNotMatch(source, />\s*打开官方登录页\s*</, "旧按钮流必须删掉");
});

test("接线：门禁经 coreCall 调 auth:qr-start（自动）与 auth:login（仅次要入口），并订阅 auth:qr / auth:status", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /AUTH_QR_START/, "发起二维码走 auth:qr-start 请求频道");
  assert.match(gate, /AUTH_STATUS/, "会话状态来自 auth:status 广播");
  assert.match(gate, /AUTH_QR/, "二维码状态来自 auth:qr 广播");
  assert.match(gate, /AUTH_LOGIN/, "官方页次要入口仍走 auth:login");
  assert.equal(
    gate.includes("AUTH_CANCEL_LOGIN"),
    false,
    "R16 起引导页没有取消按钮（正常路径零按钮）：不再需要 auth:cancel-login",
  );
  assert.doesNotMatch(gate, /["']auth:(login|logout|cancel-login|qr-start|status|qr)["']/, "频道名一律 import 共享常量，不写字面量");
});
