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
 * R20 增补三项（用户真机验收反馈）：header 里那句品牌已删（与窗口标题栏重复）、
 * 过期之后旧码必须从屏上消失、二维码容器本身可点刷新（有可达名字）、
 * 网页登录窗开着时入口变形为「返回扫码登录」并挪进那条唯一可见的 48px header。
 *
 * R21 增补（用户指令，**推翻自动换新**）：二维码下方多一行**过期倒计时**（秒级，
 * 只在"码在屏上等着被扫"那一档出现）；过期态是**不可扫**的——canvas 撤下、原位写
 * 「二维码已过期」，并多出一个显著的「刷新二维码」按钮（手动刷新是唯一的换码方式）。
 * R20 那句「二维码已刷新，请重新扫码。」随自动换新一起删除。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

import { APP_BRAND_LABEL } from "../src/shared/app-name.mjs";
import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_TITLE,
  QR_COUNTDOWN_TESTID,
  QR_EXPIRED_BOX_TEXT,
  QR_EXPIRED_NOTICE,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  QR_REFRESH_ACTION_TESTID,
  QR_REFRESH_LABEL,
  QR_REFRESH_TESTID,
  WEB_LOGIN_BACK_TESTID,
  WEB_LOGIN_BACK_TEXT,
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
    <LoginGate gate={{ state, startQr() {}, startLogin() {}, backToQr() {} }} />,
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

/** 按钮的形状：可见文案 / 可达名字（aria-label）/ 测试锚点 / 是否禁用。 */
function buttonSummaries(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    text: visibleText(match[2]).replaceAll("\u0001", "").trim(),
    label: match[1].match(/aria-label="([^"]*)"/)?.[1] ?? "",
    testid: match[1].match(/data-testid="([^"]*)"/)?.[1] ?? "",
    disabled: /\sdisabled(?:=""|=|>|\s|$)/.test(match[1]),
  }));
}

/** 从 `at` 往前找最近的 `<tag` 开标签（带属性）。 */
function openTagBefore(html, at, tag) {
  const start = html.lastIndexOf(tag, at);
  assert.ok(start > -1, `这个位置之前没有 ${tag}：${html.slice(Math.max(0, at - 200), at + 50)}`);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** 从某个位置往前找最近的 `<div ...>` 开标签。 */
function openDivTagAt(html, at) {
  return openTagBefore(html, at, "<div");
}

/**
 * 二维码的**宿主元素**：R20 起它是包着 canvas/Skeleton 的那个 `<button>`（容器本身可点刷新）。
 */
function qrHostTag(html) {
  const canvasAt = html.indexOf("<canvas");
  if (canvasAt > -1) return openTagBefore(html, canvasAt, "<button");
  const skeletonAt = html.indexOf('data-slot="skeleton"');
  if (skeletonAt > -1) return openTagBefore(html, skeletonAt, "<button");
  const expiredAt = html.indexOf(`data-testid="${QR_REFRESH_TESTID}"`);
  assert.ok(expiredAt > -1, `既没有 canvas、Skeleton，也没有二维码容器：${html.slice(0, 400)}`);
  return openTagBefore(html, html.indexOf(">", expiredAt), "<button");
}

/**
 * 二维码容器**里**的内容（含自己的开标签）。
 *
 * R21 起过期态要在那个位置写「二维码已过期」——只看"页面上有没有这几个字"会被状态行里
 * 那句更长的文案命中，所以必须把容器自己的那一块抠出来看。
 */
function qrHostBlock(html) {
  const match = html.match(
    new RegExp(`<button[^>]*data-testid="${QR_REFRESH_TESTID}"[^>]*>[\\s\\S]*?</button>`),
  );
  assert.ok(match !== null, `找不到二维码容器：${html.slice(0, 400)}`);
  return match[0];
}

/** header 那条 48px 几何契约的标记（含内容）。 */
function headerTag(html) {
  const match = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/);
  assert.ok(match !== null, `页面里没有 header：${html.slice(0, 200)}`);
  return match[0];
}

// ---- 状态夹具（用真状态机造，不手搓对象） --------------------------------

function loggedOut() {
  return reduceGateState(initialGateState(), { type: LOGIN_GATE_EVENT.status, loggedIn: false });
}

function preparingState() {
  return reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.qrRequested });
}

/** R21：`at` = 事件发生时刻（钟由调用方注入），倒计时据此算出到期时刻。 */
const QR_AT_MS = 1_000_000;

function pendingState(content = "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=OLD") {
  return reduceGateState(preparingState(), {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content,
    expiresInMs: 181_000,
    at: QR_AT_MS,
  });
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

  // header（顶部那条 48px 的几何契约）里不许再出现标题
  const header = headerTag(html);
  assert.match(header, /style="height:48px"/, "header 高度仍来自共享常量（48px）");
  assert.doesNotMatch(header, new RegExp(LOGIN_GATE_TITLE), "标题在 header 里重复了");
});

// ---------------------------------------------------------------------------
// R20 要求 1：header 里那句品牌与窗口标题栏重复 → 删掉（几何契约仍在）
// ---------------------------------------------------------------------------

test("标记：header 里没有任何可见文字（品牌与窗口标题栏重复的那句已删），48px 几何契约不破", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());
  const header = headerTag(html);

  assert.equal(
    visibleText(header.replace(/^<header\b[^>]*>/, "").replace(/<\/header>$/, "")).replaceAll("\u0001", "").trim(),
    "",
    `header 里不许有可见文字：${header}`,
  );
  assert.doesNotMatch(html, new RegExp(APP_BRAND_LABEL), "品牌不进引导页（窗口标题栏已经有它）");
  assert.match(header, /style="height:48px"/, `高度仍来自共享常量：${header}`);
  assert.equal(occurrences(html, APP_BRAND_LABEL), 0, "同一句话全页不许出现（省得又变回两处）");
});

// ---------------------------------------------------------------------------
// 要求 2：二维码带边框（令牌 + 工具类）
// ---------------------------------------------------------------------------

test("标记：二维码容器带边框（border + border-border + 圆角工具类，零自定义 CSS）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());
  const container = qrHostTag(html);

  assert.match(container, /class="[^"]*\bborder\b/, `容器要有边框：${container}`);
  assert.match(container, /border-border\b/, `边框颜色必须是设计令牌：${container}`);
  assert.match(container, /rounded-(?:md|lg|xl)\b/, `圆角要用工具类：${container}`);
  assert.doesNotMatch(container, /border-(?:white|black)\b|#[0-9a-fA-F]{3,8}\b|rgba?\(/, `不得硬编码颜色：${container}`);
  assert.doesNotMatch(html, /<style[\s>]/, "零自定义 CSS");
});

// ---------------------------------------------------------------------------
// R20 要求 2 / R21 要求 1+2：过期码不留屏、过期态不可扫、倒计时在二维码下方
// ---------------------------------------------------------------------------

test("标记：过期态不可扫——canvas 撤下、二维码区域自己写着「二维码已过期」，并给一个显著的刷新按钮", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(expiredState());

  assert.doesNotMatch(html, /<canvas/, "过期码绝不能留在屏上让人扫（那是必然扫不动的死码）");
  assert.doesNotMatch(qrHostBlock(html), /<canvas/, "二维码容器里也不许有 canvas");
  assert.match(qrHostBlock(html), new RegExp(QR_EXPIRED_BOX_TEXT), `二维码区域要写明已过期：${qrHostBlock(html)}`);
  assert.doesNotMatch(html, /animate-pulse/, "过期不是「加载中」：占位说的是已过期，不是马上就来");
  assert.equal(statusTextOf(html), QR_EXPIRED_NOTICE, "状态行给的是可操作的下一句（点击刷新）");

  // R21 要求 3：过期态那个显著的「刷新二维码」按钮（手动刷新是唯一的换码方式）
  const action = buttonSummaries(html).find((button) => button.testid === QR_REFRESH_ACTION_TESTID);
  assert.ok(action, `过期态要有显著的刷新入口：${JSON.stringify(buttonSummaries(html))}`);
  assert.equal(action.text, QR_REFRESH_LABEL, "按钮文案与容器的可达名字同源");
  assert.equal(action.disabled, false, "它是这个档位唯一的出路：不许是灰的");

  // 过期态没有倒计时可显示（"剩 0 秒"是错的：那一刻的权威是服务端那条广播）
  assert.doesNotMatch(html, new RegExp(`data-testid="${QR_COUNTDOWN_TESTID}"`), "过期态不该有倒计时");
});

test("标记：倒计时在二维码下方（秒级文案，来自建单应答的 expiresInMs）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(pendingState());

  const countdown = html.match(
    new RegExp(`<p[^>]*data-testid="${QR_COUNTDOWN_TESTID}"[^>]*>([\\s\\S]*?)</p>`),
  );
  assert.ok(countdown, `二维码下方要有倒计时那一行：${visibleText(html).replaceAll("\u0001", "|")}`);
  assert.equal(visibleText(countdown[1]).replaceAll("\u0001", ""), "剩 181 秒过期");

  const qrAt = html.indexOf(`data-testid="${QR_REFRESH_TESTID}"`);
  const countdownAt = html.indexOf(`data-testid="${QR_COUNTDOWN_TESTID}"`);
  const hintAt = indexOfText(html, QR_HINT_TEXT);
  assert.ok(qrAt > -1 && countdownAt > qrAt, "倒计时排在二维码**下方**");
  assert.ok(countdownAt < hintAt, "倒计时紧贴二维码（提示文字在它之后）");
});

test("标记：没有倒计时可显示时那一行不出现（准备中 / 过期 / 失败）", async () => {
  const { renderGate } = await gateRenderer();
  const cases = [
    ["正在准备", preparingState()],
    ["已过期", expiredState()],
    ["失败", failedState()],
  ];
  for (const [label, state] of cases) {
    assert.doesNotMatch(
      renderGate(state),
      new RegExp(`data-testid="${QR_COUNTDOWN_TESTID}"`),
      `${label}档不该有倒计时（宁可少一行，也不显示"剩 0 秒"这种假话）`,
    );
  }
});

test("标记：时间走到本地归零 → 那一行说「正在确认过期…」，码仍留在屏上等服务端收口", async () => {
  const { renderGate } = await gateRenderer();
  const atZero = reduceGateState(pendingState(), {
    type: LOGIN_GATE_EVENT.tick,
    nowMs: QR_AT_MS + 181_000,
  });
  const html = renderGate(atZero);

  assert.match(html, /<canvas/, "本地归零**不是**过期：这张码还在屏上（过期判定以服务端 expired 广播为权威）");
  const countdown = html.match(new RegExp(`data-testid="${QR_COUNTDOWN_TESTID}"[^>]*>([^<]*)<`));
  assert.ok(countdown, `归零那一档仍要有那一行：${visibleText(html).replaceAll("\u0001", "|")}`);
  assert.equal(countdown[1], "正在确认过期…");
});

test("标记：过期态点刷新 → 新码画出来、过期文案与那个按钮一起退场、倒计时重新开始", async () => {
  const { renderGate } = await gateRenderer();
  const refreshed = reduceGateState(expiredState(), { type: LOGIN_GATE_EVENT.qrRequested });
  const waiting = reduceGateState(refreshed, {
    type: LOGIN_GATE_EVENT.qr,
    status: QR_GATE_STATUS.pending,
    content: "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=NEW",
    expiresInMs: 181_000,
    at: 5_000_000,
  });
  const html = renderGate(waiting);

  assert.match(html, /<canvas/, "新码要画出来");
  assert.doesNotMatch(html, new RegExp(QR_EXPIRED_BOX_TEXT), "过期文案退场（它是过期专属的一档）");
  assert.doesNotMatch(html, new RegExp(`data-testid="${QR_REFRESH_ACTION_TESTID}"`), "过期态那个按钮同时退场");
  assert.equal(statusTextOf(html), "等待扫码…");
  assert.match(visibleText(html), /剩 181 秒过期/, "倒计时按新码的有效期重新开始");
});

test("标记：二维码容器本身可点刷新（真 <button> + 可达名字 + 测试锚点），准备中禁用、过期态仍可点", async () => {
  const { renderGate } = await gateRenderer();
  const pending = renderGate(pendingState());
  const host = qrHostTag(pending);
  assert.match(host, /^<button\b/, `宿主元素要是按钮（键盘可达）：${host}`);
  assert.match(host, new RegExp(`aria-label="${QR_REFRESH_LABEL}"`), `要有可达名字：${host}`);
  assert.match(host, new RegExp(`data-testid="${QR_REFRESH_TESTID}"`), `真窗守据点名它：${host}`);

  const refresh = buttonSummaries(pending).find((button) => button.testid === QR_REFRESH_TESTID);
  assert.ok(refresh, `找不到刷新控件：${JSON.stringify(buttonSummaries(pending))}`);
  assert.equal(refresh.disabled, false, "等待扫码时点它就是换一张新码");
  assert.equal(refresh.label, QR_REFRESH_LABEL);

  // 还没有内容（正在准备）：按钮在，但点不动——不然就是重复建单
  const preparing = buttonSummaries(renderGate(preparingState())).find(
    (button) => button.testid === QR_REFRESH_TESTID,
  );
  assert.ok(preparing, "加载态下容器仍在（尺寸不跳）");
  assert.equal(preparing.disabled, true, "已经有一次请求在飞：再点一次只是重复建单");

  // R21：过期态容器照样可点（它是"再来一张"那条手动路的一部分）
  const expired = buttonSummaries(renderGate(expiredState())).find(
    (button) => button.testid === QR_REFRESH_TESTID,
  );
  assert.equal(expired?.disabled, false, "过期态：容器本身就是用户想点的那块地方");
});

test("标记：可操作元素集合 = 刷新容器 + 常驻入口；过期态多一个「刷新二维码」；「重试」只在失败态", async () => {
  const { renderGate } = await gateRenderer();
  const pending = buttonSummaries(renderGate(pendingState()));
  assert.deepEqual(
    pending.map((button) => button.testid || button.text),
    [QR_REFRESH_TESTID, WEB_LOGIN_ENTRY_TESTID],
    `正常路径只有这两个可操作元素：${JSON.stringify(pending)}`,
  );

  // R21 要求 3：过期态多一个**显著**的刷新按钮（换码只剩手动这一条路）
  const expired = buttonSummaries(renderGate(expiredState()));
  assert.deepEqual(
    expired.map((button) => button.testid || button.text),
    [QR_REFRESH_TESTID, QR_REFRESH_ACTION_TESTID, WEB_LOGIN_ENTRY_TESTID],
    `过期态要有那个刷新按钮：${JSON.stringify(expired)}`,
  );

  const failed = buttonSummaries(renderGate(failedState()));
  assert.deepEqual(
    failed.map((button) => button.testid || button.text),
    [QR_REFRESH_TESTID, "重试", WEB_LOGIN_ENTRY_TESTID],
    `失败态多一个「重试」：${JSON.stringify(failed)}`,
  );
});

// ---------------------------------------------------------------------------
// R20 要求 3：网页登录窗开着 → 入口变形为「返回扫码登录」并挪进那条可见的 48px header
// ---------------------------------------------------------------------------

/** 网页登录那条路正在跑（窗铺满内容区，顶部只留 header）。 */
function officialState() {
  return reduceGateState(loggedOut(), { type: LOGIN_GATE_EVENT.started });
}

test("标记：网页登录窗开着时，入口变形为「返回扫码登录」，且落在 header 里（那一刻唯一可见的一条）", async () => {
  const { renderGate } = await gateRenderer();
  const html = renderGate(officialState());

  const back = buttonSummaries(html).find((button) => button.testid === WEB_LOGIN_BACK_TESTID);
  assert.ok(back, `找不到返回控件：${JSON.stringify(buttonSummaries(html))}`);
  assert.equal(back.text, WEB_LOGIN_BACK_TEXT, "文案是「返回扫码登录」");
  assert.equal(back.disabled, false, "窗开着时它必须点得动（用户唯一的回退路径）");
  // 注意用**按钮文案**判形态，不能拿整页可见文本找：状态行那句"已在网页中打开登录。"里就有它
  assert.equal(
    buttonSummaries(html).filter((button) => button.text === WEB_LOGIN_ENTRY_TEXT).length,
    0,
    `同一时刻只有一个入口形态（不许两个都在）：${JSON.stringify(buttonSummaries(html))}`,
  );
  assert.doesNotMatch(html, new RegExp(`data-testid="${WEB_LOGIN_ENTRY_TESTID}"`), "开窗形态同时退场");

  // 位置：在 header 里（网页窗盖住正文的那 48px），且 header 仍在页面最上方、高度契约不变
  const header = headerTag(html);
  assert.match(header, new RegExp(`data-testid="${WEB_LOGIN_BACK_TESTID}"`), `返回控件要在 header 里：${header}`);
  assert.match(header, /style="height:48px"/, "header 高度契约不变");
  assert.ok(html.indexOf("<header") < html.indexOf(`>${LOGIN_GATE_TITLE}<`), "header 仍在最上方");
});

test("标记：渲染层 reload 之后（path 丢了、只剩 busy:true）返回控件照样在 header 里", async () => {
  const { renderGate } = await gateRenderer();
  // R19 的场景：门禁状态靠 auth:get-status 应答重建，`path` 是 null，只有 sidecar 的 busy
  const afterReload = { ...loggedOut(), busy: true };
  assert.equal(afterReload.path, null, "这份夹具要的正是「没有本地 path」那一档");
  const html = renderGate(afterReload);

  const header = headerTag(html);
  assert.match(header, new RegExp(`data-testid="${WEB_LOGIN_BACK_TESTID}"`), `窗还开着就必须有回去的路：${header}`);
  const back = buttonSummaries(html).find((button) => button.testid === WEB_LOGIN_BACK_TESTID);
  assert.equal(back?.disabled, false, "这条路不许是灰的");
});

test("标记：回到二维码态之后入口变回「在网页中打开登录」（正文里那一份，顺序契约不变）", async () => {
  const { renderGate } = await gateRenderer();
  const back = reduceGateState(officialState(), {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: false,
    busy: false,
    message: "已取消登录",
  });
  const html = renderGate(reduceGateState(back, { type: LOGIN_GATE_EVENT.qr, status: QR_GATE_STATUS.pending, content: "NEW" }));

  assert.equal(occurrences(html, WEB_LOGIN_ENTRY_TEXT), 1, "变回常驻入口");
  assert.doesNotMatch(html, new RegExp(WEB_LOGIN_BACK_TEXT), "返回控件退场");
  assert.doesNotMatch(headerTag(html), /<button/, "header 里不再留控件（回到无文字的那条占位）");

  const entryAt = html.indexOf(WEB_LOGIN_ENTRY_TEXT);
  const statusAt = html.indexOf('role="status"');
  assert.ok(statusAt > -1 && statusAt < entryAt, "入口仍在状态行之后（R18 的顺序契约）");
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
    ["已过期", expiredState()],
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
  assert.match(qrHostTag(html), /\bborder\b/, "占位也在那个带边框的容器里（尺寸不跳）");
  assert.equal(occurrences(html, QR_HINT_TEXT), 1, "加载态下提示文字照样在");
  assert.ok(buttonLabels(html).includes(WEB_LOGIN_ENTRY_TEXT), "加载态下常驻入口也在");
});
