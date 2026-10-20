/**
 * R18：引导页**渲染出来的标记**（真 SSR，不是源码扫描）。
 *
 * 为什么要这一层：用户这一轮提的五项里有四项是"页面上长什么样"——标题在不在二维码正上方、
 * 二维码有没有边框、提示文字是不是那一句且只说一次、次要入口是不是常驻。源码扫描只能说
 * "字符串在文件里"，说不清"渲染出来是什么样"（顺序、数量、同一条文案出现几次）。
 *
 * 做法：用 esbuild（devDependency，`scripts/test-browser.mjs` 同款）把**真组件**
 * `LoginGate` 打成一个 ESM 包，再用 `react-dom/server` 渲静态标记，然后在标记上断言。
 * 与真窗守卫（`npm run verify:live`，CDP 驱动 WebView2）分工：这里不依赖窗口、不依赖登录，
 * 是"门禁页结构"这一层的可复现证据；像素与真机行为仍归 verify:live。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_TITLE,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  WEB_LOGIN_ENTRY_TESTID,
  WEB_LOGIN_ENTRY_TEXT,
  initialGateState,
  reduceGateState,
} from "../src/renderer/features/auth/login-gate-logic.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 中间产物落在 .tmp（已 gitignore），与 test-browser.mjs 的守卫目录同一个约定。 */
const OUT_DIR = ".tmp/r18-gate-markup";
const ENTRY = `${OUT_DIR}/entry.tsx`;
const BUNDLE = `${OUT_DIR}/entry.mjs`;

/** 守卫入口（生成物，不入库）：只把真组件包一层，状态由测试给。 */
function entriesSource() {
  return `import { renderToStaticMarkup } from "react-dom/server";

import { LoginGate } from "../../src/renderer/login-gate.tsx";

/**
 * 把一份门禁状态渲染成静态标记。
 * 副作用（自动发起二维码、订阅广播）不会在 SSR 里跑：本文件只问"这份状态长什么样"。
 */
export function renderGate(state) {
  return renderToStaticMarkup(
    <LoginGate gate={{ state, startQr() {}, startLogin() {} }} />,
  );
}
`;
}

let bundlePromise = null;

/** 打一次包并 import（同一个进程里只做一次）。 */
function gateRenderer() {
  bundlePromise ??= (async () => {
    // 沙箱/CI 的 %TEMP% 可能指向不可写处（R17 §8 实测），esbuild 的临时文件留在仓内
    const temp = path.join(ROOT, ".tmp/temp");
    await mkdir(temp, { recursive: true });
    process.env.TEMP = temp;
    process.env.TMP = temp;

    await rm(path.join(ROOT, OUT_DIR), { recursive: true, force: true });
    await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
    await writeFile(path.join(ROOT, ENTRY), entriesSource(), "utf8");

    await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: [ENTRY],
      outfile: BUNDLE,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      jsx: "automatic",
      // 依赖留在 node_modules 里按真包解析：打进来会把 react-dom 的 CJS 动态 require 搅坏
      packages: "external",
      logLevel: "warning",
    });

    return import(pathToFileURL(path.join(ROOT, BUNDLE)).href);
  })();
  return bundlePromise;
}

/** 去标签 + 反转义 → 页面上那串可见文本。 */
function visibleText(html) {
  return html
    .replace(/<[^>]*>/g, "\u0001")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 某个文案在页面上出现几次（只看可见文本，属性里的不算）。 */
function occurrences(html, text) {
  return visibleText(html).split(text).length - 1;
}

/**
 * 文案在标记里的下标。
 *
 * 提示文字里有 `>`（"「控制中心」>「扫一扫」"），React 会把它转义成 `&gt;`——
 * 所以位置类断言必须找**转义之后**的那串（否则"页面里找不到提示文字"）。
 */
function indexOfText(html, text) {
  return html.indexOf(escaped(text));
}

function escaped(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** 状态行（`role="status"` 那一条）的可见文本。 */
function statusTextOf(html) {
  const match = html.match(/<p[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/);
  return match === null ? null : visibleText(match[1]).replaceAll("\u0001", "");
}

/** 页面上所有按钮的可见文案（按出现顺序）。 */
function buttonLabels(html) {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(
    (match) => visibleText(match[1]).replaceAll("\u0001", "").trim(),
  );
}

/** 从某个位置往前找最近的 `<div ...>` 开标签。 */
function openDivTagAt(html, at) {
  const start = html.lastIndexOf("<div", at);
  assert.ok(start > -1, `这个位置之前没有 <div>：${html.slice(Math.max(0, at - 200), at + 50)}`);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** 二维码的宿主容器：有 canvas 时是它外面的那个 div，加载态时是包着 Skeleton 的那个 div。 */
function qrContainerTag(html) {
  const canvasAt = html.indexOf("<canvas");
  if (canvasAt > -1) return openDivTagAt(html, canvasAt);
  const skeletonAt = html.indexOf('data-slot="skeleton"');
  assert.ok(skeletonAt > -1, `既没有 canvas 也没有 Skeleton：${html.slice(0, 400)}`);
  // Skeleton 自己的 <div> 在它的 data-slot 之前：再往前一个才是宿主容器
  return openDivTagAt(html, html.lastIndexOf("<div", skeletonAt) - 1);
}

// ---- 状态夹具（用真状态机造，不手搓对象） --------------------------------

function loggedOut() {
  return reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
}

function preparingState() {
  return reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrRequested });
}

function pendingState(content = "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=OLD") {
  return reduceGateState(preparingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content });
}

function expiredState() {
  return reduceGateState(pendingState(), { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.expired });
}

function failedState() {
  return reduceGateState(preparingState(), {
    type: LOGIN_GATE_EVENT.qrFailed,
    message: "二维码登录端点未配置（见 docs/API_CONTRACT.md §1.7）",
    errorKind: "missing_endpoint",
  });
}

// ---------------------------------------------------------------------------
// 要求 5：标题移到二维码正上方、居中、全页只出现一次
// ---------------------------------------------------------------------------

test("标记：标题在二维码正上方、居中，且全页只出现一次（顶部 header 里那份已移除）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());

  assert.equal(occurrences(html, LOGIN_GATE_TITLE), 1, `标题出现了不止一次：${visibleText(html).replaceAll("\u0001", "|")}`);

  const titleAt = html.indexOf(`>${LOGIN_GATE_TITLE}<`);
  assert.ok(titleAt > -1, "标题是独立的元素（不是 v18 那种挤在别的文本里）");
  const titleTag = html.slice(html.lastIndexOf("<", titleAt), html.indexOf(">", titleAt) + 1);
  assert.match(titleTag, /^<h[12]\b/, `标题要是语义标题元素：${titleTag}`);
  assert.match(titleTag, /text-center/, `标题要居中：${titleTag}`);

  const canvasAt = html.indexOf("<canvas");
  assert.ok(titleAt < canvasAt, "标题必须排在二维码之前（正上方）");

  // header（顶部那条 48px 的几何契约）里不许再出现标题：它只剩品牌
  const headerMatch = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/);
  assert.ok(headerMatch !== null, "顶部 header 结构必须保留（LOGIN_VIEW_TOP_INSET 的对位契约）");
  assert.match(headerMatch[0], /style="height:48px"/, "header 高度仍来自共享常量（48px）");
  assert.doesNotMatch(headerMatch[0], new RegExp(LOGIN_GATE_TITLE), "标题在 header 里重复了");
});

// ---------------------------------------------------------------------------
// 要求 2：二维码带边框（令牌 + 工具类）
// ---------------------------------------------------------------------------

test("标记：二维码容器带边框（border + border-border + 圆角工具类，零自定义 CSS）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());
  const container = qrContainerTag(html);

  assert.match(container, /class="[^"]*\bborder\b/, `容器要有边框：${container}`);
  assert.match(container, /border-border\b/, `边框颜色必须是设计令牌：${container}`);
  assert.match(container, /rounded-(?:md|lg|xl)\b/, `圆角要用工具类：${container}`);
  assert.doesNotMatch(container, /border-(?:white|black)\b|#[0-9a-fA-F]{3,8}\b|rgba?\(/, `不得硬编码颜色：${container}`);
  assert.doesNotMatch(html, /<style[\s>]/, "零自定义 CSS");
});

// ---------------------------------------------------------------------------
// 要求 1：提示文字是那一句，且只出现一次（状态行不复述它）
// ---------------------------------------------------------------------------

test("标记：提示文字就是要求里那一句，页面上只出现一次", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());

  assert.equal(QR_HINT_TEXT, "手机「控制中心」>「扫一扫」或者系统「设置」>「华为账号」>「扫一扫」。");
  assert.equal(occurrences(html, QR_HINT_TEXT), 1, `提示文字出现了 ${occurrences(html, QR_HINT_TEXT)} 次：${visibleText(html).replaceAll("\u0001", "|")}`);

  const status = statusTextOf(html);
  assert.notEqual(status, QR_HINT_TEXT, "状态行与提示文字是两行，不许同一句说两遍");
  assert.match(status ?? "", /扫码/);
});

// ---------------------------------------------------------------------------
// 要求 4：常驻次要入口（每一档都在）+ 重试只在失败态
// ---------------------------------------------------------------------------

test("标记：常驻入口在每一档都在；「重试」只在失败态多出来", async () => {
  const { renderGate } = await gateRenderer();
  const cases = [
    ["正在准备", preparingState()],
    ["等待扫码", pendingState()],
    ["已刷新", expiredState()],
    ["失败", failedState()],
  ];
  for (const [label, state] of cases) {
    const html = renderGate(state);
    const labels = buttonLabels(html);
    assert.ok(
      labels.includes(WEB_LOGIN_ENTRY_TEXT),
      `${label} 档少了常驻入口（实际按钮：${JSON.stringify(labels)}）`,
    );
    assert.match(html, new RegExp(`data-testid="${WEB_LOGIN_ENTRY_TESTID}"`), `${label} 档入口缺测试锚点`);
    const retries = labels.filter((text) => text === "重试");
    assert.equal(retries.length, label === "失败" ? 1 : 0, `${label} 档的「重试」数量不对：${JSON.stringify(labels)}`);
  }
});

test("标记：入口是次要形态（link/ghost 小号 muted），不是又一个主按钮", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());
  const entryAt = html.indexOf(`>${WEB_LOGIN_ENTRY_TEXT}<`);
  const buttonTag = html.slice(html.lastIndexOf("<button", entryAt), entryAt);
  assert.match(buttonTag, /text-muted-foreground/, `入口要克制（muted 文字）：${buttonTag}`);
  assert.match(buttonTag, /data-variant="link"/, `入口是 link 形态的 shadcn 原语：${buttonTag}`);
});

// ---------------------------------------------------------------------------
// 布局形态：自上而下 标题 → 二维码 → 提示 → 状态行 → 次要入口
// ---------------------------------------------------------------------------

test("标记：自上而下的顺序与简报的布局形态一致", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());

  const titleAt = html.indexOf(`>${LOGIN_GATE_TITLE}<`);
  const qrAt = html.indexOf("<canvas");
  const hintAt = indexOfText(html, QR_HINT_TEXT);
  const statusAt = html.indexOf('role="status"');
  const entryAt = html.indexOf(WEB_LOGIN_ENTRY_TEXT);

  const order = [
    ["标题", titleAt],
    ["二维码", qrAt],
    ["提示文字", hintAt],
    ["状态行", statusAt],
    ["次要入口", entryAt],
  ];
  for (const [label, index] of order) assert.ok(index > -1, `页面里找不到${label}`);
  const indices = order.map(([, index]) => index);
  assert.deepEqual(
    indices.slice().sort((a, b) => a - b),
    indices,
    `自上而下的顺序不对：${order.map(([label, index]) => `${label}@${index}`).join(" → ")}`,
  );
});

test("标记：加载态给同尺寸占位（不是空白也不是跳一下）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(preparingState());
  assert.doesNotMatch(html, /<canvas/, "还没有内容时不该有 canvas");
  assert.match(html, /animate-pulse/, "加载态是 shadcn 的 Skeleton");
  assert.match(qrContainerTag(html), /\bborder\b/, "占位也在那个带边框的容器里（尺寸不跳）");
  assert.equal(occurrences(html, QR_HINT_TEXT), 1, "加载态下提示文字照样在");
  assert.ok(buttonLabels(html).includes(WEB_LOGIN_ENTRY_TEXT), "加载态下常驻入口也在");
});
