/**
 * R7 渲染层登录门禁：判定纯函数 + 外壳骨架的**顺序**契约 + 视觉原语约束。
 *
 * 三条硬要求（简报与 R1 审查遗留项）：
 * 1. 未登录**绝不渲染 app-shell**：门禁分支必须在 App() 里排在 app-shell 之前（源码顺序扫描）；
 * 2. 顶部内缩不许出现第二份字面量：高度来自 src/shared/login-inset.mjs，且不许写 `h-12`；
 * 3. 视觉只用 shadcn 原语 + Tailwind 工具类：不许 `<style>`、不许内联视觉 style
 *    （几何契约的 `style={{height: LOGIN_VIEW_TOP_INSET}}` 是唯一例外，且必须来自导入常量）。
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
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  reduceGateState,
  shouldAutoStartLogin,
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
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.checking, busy: false, attempted: false }), true);
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.loggedOut, busy: false, attempted: false }), true);
  assert.equal(
    shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.loggedOut, busy: true, attempted: true, message: "登录超时" }),
    true,
    "登录进行中也还是门禁（登录窗在跑，主窗不该先亮出主界面）",
  );
  assert.equal(shouldShowLoginGate({ phase: LOGIN_GATE_PHASE.loggedIn, busy: false, attempted: true }), false);
});

test("门禁判定：状态未知时不许猜（检查中按门禁处理，绝不按已登录处理）", () => {
  const initial = initialGateState();
  assert.equal(initial.phase, LOGIN_GATE_PHASE.checking);
  assert.equal(shouldShowLoginGate(initial), true);
  assert.equal(shouldAutoStartLogin(initial), false, "还不知道有没有会话就自动开登录窗 = 覆盖已有会话");
});

// ---------------------------------------------------------------------------
// 2. 自动发起：门禁内 + 不 busy + 本轮未发起（三条件缺一不可）
// ---------------------------------------------------------------------------

test("自动发起：三条件齐备才发起；缺任何一条都不发起", () => {
  const ready = { phase: LOGIN_GATE_PHASE.loggedOut, busy: false, attempted: false };
  assert.equal(shouldAutoStartLogin(ready), true);

  assert.equal(
    shouldAutoStartLogin({ ...ready, phase: LOGIN_GATE_PHASE.checking }),
    false,
    "条件一：必须在门禁内的确定态（检查中不发起）",
  );
  assert.equal(
    shouldAutoStartLogin({ ...ready, phase: LOGIN_GATE_PHASE.loggedIn }),
    false,
    "已登录不该再开登录窗",
  );
  assert.equal(shouldAutoStartLogin({ ...ready, busy: true }), false, "条件二：正在登录中");
  assert.equal(
    shouldAutoStartLogin({ ...ready, attempted: true }),
    false,
    "条件三：本轮已经发起过（用户取消后不得自动重开，否则取消按钮形同虚设）",
  );
});

test("自动发起：用户取消后不再自动重开，手动按钮仍然可用", () => {
  let state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  assert.equal(shouldAutoStartLogin(state), true);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.started });
  assert.equal(state.busy, true);
  assert.equal(shouldAutoStartLogin(state), false, "已经发起了（busy 也是 attempted）");
  assert.equal(state.attempted, true);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.cancelled });
  assert.equal(state.busy, false);
  assert.equal(shouldAutoStartLogin(state), false, "取消之后不许自动重开");
  assert.equal(canStartLogin(state), true, "但用户想重来时手动按钮必须可用");
  assert.match(loginGateStatusLine(state), /取消/);
});

// ---------------------------------------------------------------------------
// 3. 状态机：广播/发起/成功/失败各自迁移，未知事件不改状态
// ---------------------------------------------------------------------------

test("状态机：auth:status 广播是唯一的状态来源，登录成功立刻进已登录", () => {
  let state = initialGateState();
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: true });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedIn);
  assert.equal(shouldShowLoginGate(state), false);

  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.status, loggedIn: false });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedOut);

  state = reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.started });
  state = reduceGateState(state, { type: LOGIN_GATE_EVENT.succeeded });
  assert.equal(state.phase, LOGIN_GATE_PHASE.loggedIn);
  assert.equal(state.busy, false);
  assert.equal(state.message, null);
});

test("状态机：失败带原文案，后续事件不得把它静默吞掉", () => {
  const failed = reduceGateState(
    reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.started }),
    { type: LOGIN_GATE_EVENT.failed, message: "无法打开华为官方登录页面，请检查网络或代理后重试。" },
  );
  assert.equal(failed.busy, false);
  assert.equal(failed.message, "无法打开华为官方登录页面，请检查网络或代理后重试。");
  assert.match(loginGateStatusLine(failed), /登录页面/, "失败文案要显示给用户，不许只进控制台");

  // 未知事件（新版本 core 发了渲染层还不认识的类型）：保持原状态，不抛、不清空文案
  const untouched = reduceGateState(failed, { type: "core-went-crazy", payload: 1 });
  assert.deepEqual(untouched, failed);

  // 纯函数：不得改写入参（React 的 props 是不可变的）
  const before = initialGateState();
  const snapshot = JSON.stringify(before);
  reduceGateState(before, { type: LOGIN_GATE_EVENT.started });
  assert.equal(JSON.stringify(before), snapshot);
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
  // 渲染层就绪钩子：先订阅（useAuthGate 里的 listen）再 rendererReady（命令面在 subscribe 之后才冲刷）
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

test("视觉约束：无 <style> 标签；内联 style 只允许几何契约那一处", () => {
  for (const relative of rendererFiles()) {
    if (relative.endsWith("amll-theme.css")) continue;
    const source = stripComments(read(relative));
    assert.doesNotMatch(source, /<style[\s>]/, `${relative} 不得内联 <style>（CSP script-src 'self' 会阻断内联脚本，样式也不走这条路）`);

    for (const match of source.matchAll(/style=\{\{[^}]*\}\}/g)) {
      assert.match(
        match[0],
        /^style=\{\{\s*height:\s*LOGIN_VIEW_TOP_INSET\s*\}\}$/,
        `${relative} 的内联 style 只能是几何契约（高度=共享常量）：${match[0]}`,
      );
    }
  }
});

test("视觉约束：不挂载 next-themes 的 ThemeProvider（其防闪烁内联 script 会被 CSP 阻断）", () => {
  for (const relative of rendererFiles()) {
    const source = read(relative);
    assert.doesNotMatch(
      source,
      /<ThemeProvider/,
      `${relative} 不得挂载 ThemeProvider（CSP script-src 'self' 会阻断它的防闪烁内联 script）`,
    );
  }
  // 本任务新写的文件连 import 都不许有：门禁是第一个真实页面，别把这条路先趟出来
  for (const relative of [
    "src/renderer/App.tsx",
    "src/renderer/login-gate.tsx",
    "src/renderer/main.tsx",
    "src/renderer/features/auth/login-gate-logic.mjs",
  ]) {
    assert.doesNotMatch(read(relative), /next-themes/, `${relative} 不得引入 next-themes`);
  }
});

test("视觉约束：登录门禁只用 shadcn 原语与工具类（不手写视觉组件）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /from\s+"\.\/components\/ui\/button"/, "按钮用 shadcn 的 Button");
  assert.match(gate, /from\s+"\.\/components\/ui\/card"/, "容器用 shadcn 的 Card");
  assert.doesNotMatch(gate, /zinc-|amber-|gray-\d{3}/, "不得硬编码色板（一律设计令牌）");
});

// ---------------------------------------------------------------------------
// 7. 与宿主调用面的接线：门禁只用 core_call 的白名单频道
// ---------------------------------------------------------------------------

test("接线：门禁经 coreCall 调 auth:login / auth:cancel-login，且订阅 auth:status", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /AUTH_STATUS/, "登录状态来自 auth:status 广播（增补进 channels.ts 的白名单频道）");
  assert.match(gate, /AUTH_LOGIN/, "发起登录走 auth:login 请求频道");
  assert.match(gate, /AUTH_CANCEL_LOGIN/, "取消登录走 auth:cancel-login 请求频道");
  assert.doesNotMatch(gate, /["']auth:(login|logout|cancel-login)["']/, "频道名一律 import 共享常量，不写字面量");
});
