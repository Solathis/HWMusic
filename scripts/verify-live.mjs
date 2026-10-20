#!/usr/bin/env node
/**
 * `npm run verify:live`：**真应用**里的门禁页守卫（playwright-core 经 CDP 驱动主窗 webview）。
 *
 * ## 为什么要它
 *
 * R1–R16 的渲染层证据都停在"注入式/SSR/静态标记"这一层：它们证明得了状态机与结构，
 * 证明不了"真 webview 里二维码**真的画出了墨迹**、正常路径**真的只有那一个入口**、
 * 真机上**一条 console error 都没有**"。这一条把最后那段补上——它驱动的是
 * `npm run dev` 起出来的那个真窗口。
 *
 * ## 前置（脚本不会替你起应用）
 *
 * ```powershell
 * $env:HWMUSIC_DATA_DIR = "E:\Projects\华为云音乐桌面端\.tmp\r17-data"
 * $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
 * npm run dev
 * ```
 *
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 是 WebView2 官方认的"给底层 Chromium 加参数"旋钮；
 * 没有它，`9223` 上不会有人监听，本脚本会如实报连不上而不是静默跳过。
 *
 * **`npm run dev` 不重建 sidecar**：改了 sidecar 源码（`src/main/**`、`src/protocols/**`）之后
 * 必须先 `npm run dist:sidecar`，否则跑的是上一次的 `hwmusic-core.exe`，门禁页会显示
 * "未知请求频道：auth:qr-start"（详见 docs/RUN_AND_PACKAGING.md §1）。
 *
 * ## 断言（像素/几何/行为级，不放水）
 *
 * R17 起：二维码 canvas 真**有墨迹**（暗像素占比落在二维码的合理区间，空白画布会红）、
 * 三个**定位图案**都在、状态行文案是门禁状态机里的**已知档位**之一、**零 console error /
 * 零 pageerror**；证据落盘（主窗截图 + DOM 摘要）。
 *
 * R18 增补（用户指令的五项里"页面上长什么样"那几项，在真窗上量）：
 * - **标题**"华为账号登录"全页只出现一次、且几何上在二维码**正上方**、与二维码**同轴居中**；
 * - 二维码容器的**计算边框**非零（量 `getComputedStyle`，不是"类名里有 border"）；
 * - 提示文字就是唯一真源那一句、且只出现一次（状态行不许复述它）；
 * - 「在网页中打开登录」**常驻且可点**（正常路径恰好这一个按钮，"重试"只在失败态出现）；
 * - 自上而下的几何顺序：标题 → 二维码 → 提示 → 状态行 → 次要入口。
 *
 * ## R17 审查的三项修正（同批）
 *
 * 1. "渲染层已出内容"原来写成 `!Loading || length>0`——**恒真**（空串也过）。现在要求
 *    "非空 **且** 不是加载态文案"；
 * 2. 截图落盘从"一条断言"降为**信息输出**（它证明不了任何行为，不该计入 PASS 数）；
 * 3. console 捕获窗口：监听器是 attach 之后才挂上的，**启动期**的错误抓不到。选 reload 方案
 *    ——挂好监听器后 `page.reload()`，让从第一帧起的错误都落进缓冲区（顺带证明"重新加载
 *    之后二维码还会重新建单并画出来"）。
 *
 * ## R19 增补
 *
 * R18 的 reload 方案真的踩中了那个缺口：`auth:status` 只在 sidecar 启动时广播一次，渲染层
 * reload 之后拿不到 → 门禁停在 `checking`、二维码不发起。修法是渲染层挂载时主动查一次
 * `auth:get-status`（与托盘可用性查询同款模式）。守卫这边对应地把"等二维码"从
 * `waitForSelector(canvas)` 换成 [`waitForQrTier`]：轮询 canvas **与状态行**，等不到就把
 * 卡住的那一档报出来（"当时状态行「正在检查登录状态…」"），而不是只留一句"canvas 没出现"。
 * 断言条数不变（同一个位置，成功/失败两种证据）。
 *
 * ## R20 增补（用户真机验收反馈三项；可量的两项都在这里量）
 *
 * 1. header 里那句品牌已删 → 量的是**渲染后的可见文字**（`headerText` 必须是空串），
 *    不是"类名里没有某个字符串"；
 * 2. 二维码容器本身可点刷新 → 量它的 `aria-label`（可达名字）与 `disabled`，并把
 *    "正常路径恰好两个可操作元素（刷新容器 + 常驻入口）"钉住；
 * 3. 「返回扫码登录」要先把网页登录窗打开才量得到——那会真的开一个子窗、走一次真实网络，
 *    而且守卫必须在收尾前把它关回去，所以它是**显式开关**：
 *    `node scripts/verify-live.mjs --check-back-path`（默认不跑）。跑起来的那一段：
 *    点入口 → 等 header 里出现「返回扫码登录」→ 点它 → 等回到二维码态。
 *
 * 用法：`node scripts/verify-live.mjs [--port 9223] [--out .tmp/r17-live] [--timeout 60000]
 *        [--check-back-path]`
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 门禁页的二维码选择器（`src/renderer/login-gate.tsx` 的 `data-testid`）。 */
export const QR_TESTID = "login-qr";

/**
 * 暗像素占比的合理区间。
 *
 * 一个成型的二维码（含 1 模块静区、纠错 L）实测约 0.45–0.55；空白画布是 0。
 * 区间取得比实测宽，是为了容忍不同内容/版本，同时仍然把"空白"和"几乎全黑"挡在外面。
 */
export const INK_COVERAGE_RANGE = [0.15, 0.8];

/** 定位图案所在角落（左上/右上/左下）的暗像素占比下限：这三个是二维码的结构签名。 */
export const FINDER_MIN_DARK_RATIO = 0.3;

/** 标题与二维码"同轴居中"的容差（CSS 像素）：居中排版下两者的中心横坐标应当几乎相等。 */
export const CENTER_TOLERANCE_PX = 2;

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const PORT = Number(argValue("--port", "9223"));
const OUT_DIR = argValue("--out", ".tmp/r17-live");
const TIMEOUT_MS = Number(argValue("--timeout", "60000"));
/** R20：显式开关——开着才会真的点开网页登录窗（会开子窗、走真实网络，收尾前必须关回去）。 */
const CHECK_BACK_PATH = args.includes("--check-back-path");
const CDP_URL = `http://127.0.0.1:${PORT}`;

const results = [];
const record = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** 信息输出：证明不了行为的证据（截图、路径）不该计入 PASS/FAIL。 */
const info = (name, detail) => console.log(`INFO  ${name}${detail ? `  — ${detail}` : ""}`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 等 CDP 端点出现（应用还没起来时如实等待，不静默跳过）。 */
export async function waitForCdp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "还没试过";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.cause?.code ?? error.name;
    }
    await sleep(1000);
  }
  throw new Error(`${url}/json/version 在 ${timeoutMs}ms 内没有就绪（最后错误：${lastError}）`);
}

export function formatSummary({ pass, fail }) {
  return `verify:live 结果：PASS ${pass} / SKIP 0 / FAIL ${fail}`;
}

/**
 * 在页面里量二维码墨迹：整体覆盖率 + 三个定位图案的暗像素占比。
 *
 * 必须是**真函数**（不是字符串）：`page.evaluate` 收到字符串时按"表达式"求值，
 * 一个箭头函数字面量只会求值成函数对象、结果是 undefined。函数会被序列化送进页面，
 * 所以它**不许闭包引用外部变量**（参数之外的一切都得在这里面重新取）。
 */
export function measureQrInPage(testid) {
  const canvas = document.querySelector('[data-testid="' + testid + '"]');
  if (canvas === null) return { found: false };
  const ctx = canvas.getContext("2d");
  if (ctx === null) return { found: true, error: "no-2d-context" };
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  let darkCount = 0;
  let opaqueCount = 0;
  for (let i = 0; i < dark.length; i += 1) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    opaqueCount += 1;
    const luminance = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (luminance < 128) {
      dark[i] = 1;
      darkCount += 1;
    }
  }
  const cornerRatio = (x0, y0) => {
    const size = Math.round(Math.min(width, height) * 0.14);
    let d = 0;
    let n = 0;
    for (let y = y0; y < Math.min(y0 + size, height); y += 1) {
      for (let x = x0; x < Math.min(x0 + size, width); x += 1) {
        n += 1;
        d += dark[y * width + x];
      }
    }
    return n === 0 ? 0 : d / n;
  };
  // 静区约 1 个模块：先跳过画布边缘 6% 再取角落块
  const inset = Math.round(Math.min(width, height) * 0.06);
  const block = Math.round(width * 0.14);
  const blockY = Math.round(height * 0.14);
  return {
    found: true,
    width,
    height,
    darkCount,
    opaqueCount,
    coverage: opaqueCount === 0 ? 0 : darkCount / opaqueCount,
    finders: {
      topLeft: cornerRatio(inset, inset),
      topRight: cornerRatio(width - inset - block, inset),
      bottomLeft: cornerRatio(inset, height - inset - blockY),
    },
  };
}

/**
 * 在页面里量**布局与视觉**：标题/二维码/提示/状态行/入口的盒子、容器计算边框、按钮清单。
 *
 * 全部在页面里现取（同 measureQrInPage 的理由：函数会被序列化送进页面，不许闭包）。
 */
export function measureGateLayoutInPage(params) {
  const { testid, entryTestid, titleText, hintText } = params;
  const rectOf = (element) => {
    if (element === null || element === undefined) return null;
    const box = element.getBoundingClientRect();
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      centerX: Math.round(box.x + box.width / 2),
    };
  };
  const textOf = (element) => (element === null ? "" : (element.textContent ?? "").trim());

  const canvas = document.querySelector('[data-testid="' + testid + '"]');
  const container = canvas === null ? null : canvas.parentElement;
  const containerStyle = container === null ? null : getComputedStyle(container);

  const headings = [...document.querySelectorAll("h1, h2, h3")];
  const titleNodes = headings.filter((node) => textOf(node) === titleText);
  const paragraphs = [...document.querySelectorAll("p")];
  const hintNodes = paragraphs.filter((node) => textOf(node) === hintText);
  const status = document.querySelector('[role="status"]');
  const entry = document.querySelector('[data-testid="' + entryTestid + '"]');
  const buttons = [...document.querySelectorAll("button")];
  const header = document.querySelector("header");

  return {
    titleCount: titleNodes.length,
    headings: headings.map((node) => textOf(node)),
    titleBox: rectOf(titleNodes[0] ?? null),
    qrBox: rectOf(canvas),
    hintCount: hintNodes.length,
    hintBox: rectOf(hintNodes[0] ?? null),
    statusText: textOf(status),
    statusBox: rectOf(status),
    entryText: textOf(entry),
    entryBox: rectOf(entry),
    entryDisabled: entry === null ? null : entry.disabled === true,
    /** R20：header 里渲染后的可见文字（品牌那句删掉之后必须是空串） */
    headerText: textOf(header),
    headerBox: rectOf(header),
    paragraphs: paragraphs.map((node) => textOf(node)),
    containerBorder: containerStyle === null
      ? null
      : {
          width: containerStyle.borderTopWidth,
          style: containerStyle.borderTopStyle,
          radius: containerStyle.borderTopLeftRadius,
        },
    /** R20：可操作元素的形状——文案 / 可达名字（aria-label）/ 锚点 / 是否禁用 */
    buttons: buttons.map((node) => ({
      text: textOf(node),
      label: node.getAttribute("aria-label") ?? "",
      testid: node.getAttribute("data-testid") ?? "",
      disabled: node.disabled === true,
    })),
  };
}

/**
 * R19：等门禁真的走到 QR 档（画布出现），最多等 `timeoutMs`。
 *
 * 为什么不能只等 canvas：`auth:status` 只在 sidecar 启动时广播一次，渲染层 reload 之后收不到
 * → 门禁停在 `checking`（"正在检查登录状态…"）→ 既不自动发起二维码、也没有画布。那时
 * "canvas 没出现"这条红是**对的**，但它说不清卡在哪一档。所以这里同时轮询**状态行**，
 * 超时时把它原样带出来（"门禁停在「正在检查登录状态…」"直接指认根因）。
 *
 * 判到达只看 **canvas**，不看状态行文案：`preparing` 那一档（"正在准备二维码…"）在内容
 * 还没回来时就已经出现了——拿它当"到了"，后面那几条像素断言就会在二维码还没画出来时抢跑，
 * 变成随机假红。状态行在这里只承担"说清为什么没到"。
 *
 * 页面读不到（`evaluate` 抛错，例如正在导航）当成"还没到"继续轮询，不把守卫自己炸掉。
 *
 * @returns `{seen, reason, canvas, status}`；`reason` ∈ `canvas`（到了）/ `timeout`（没到）
 */
export async function waitForQrTier(page, { testid, timeoutMs, pollMs = 400 }) {
  const readView = () =>
    page
      .evaluate(
        (id) => ({
          canvas: document.querySelector('[data-testid="' + id + '"]') !== null,
          status: (document.querySelector('[role="status"]')?.textContent ?? "").trim(),
        }),
        testid,
      )
      .catch(() => ({ canvas: false, status: "" }));

  const deadline = Date.now() + timeoutMs;
  let view = { canvas: false, status: "" };
  for (;;) {
    view = await readView();
    if (view.canvas) return { seen: true, reason: "canvas", ...view };
    if (Date.now() >= deadline) return { seen: false, reason: "timeout", ...view };
    await sleep(pollMs);
  }
}

/**
 * R20：量「返回扫码登录」那一条（只在 `--check-back-path` 下跑）。
 *
 * 三条一起判：文案是逻辑模块那份唯一真源、它**在 header 里**（网页登录窗铺满内容区时，
 * 那条 48px 是唯一还看得见、点得到的地方）、此刻可点；同时"打开"形态必须已经退场
 * （同一时刻只有一个入口形态）。
 *
 * 同其余 measure* 函数的纪律：会被序列化送进页面，不许闭包引用外部变量。
 */
export function measureBackEntryInPage(params) {
  const { backTestid, openTestid, backText } = params;
  const textOf = (element) => (element === null ? "" : (element.textContent ?? "").trim());
  const back = document.querySelector('[data-testid="' + backTestid + '"]');
  const openEntry = document.querySelector('[data-testid="' + openTestid + '"]');
  const header = document.querySelector("header");
  return {
    found: back !== null,
    text: textOf(back),
    expectedText: backText,
    disabled: back === null ? null : back.disabled === true,
    inHeader: back !== null && header !== null && header.contains(back),
    openEntryGone: openEntry === null,
  };
}

async function main() {
  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  let version;
  try {
    version = await waitForCdp(CDP_URL, TIMEOUT_MS);
  } catch (error) {
    record(false, `CDP 端点 ${CDP_URL} 可连`, String(error.message ?? error));
    console.log(formatSummary({ pass: 0, fail: results.length }));
    process.exitCode = 1;
    return;
  }
  record(true, `CDP 端点 ${CDP_URL} 可连`, `${version.Browser ?? "?"} / ${version["WebKit-Version"] ?? "?"}`);

  // 门禁状态机的文案真源：断言拿的就是界面读到的那一份
  const {
    LOGIN_GATE_TITLE,
    QR_HINT_TEXT,
    QR_REFRESH_LABEL,
    QR_REFRESH_TESTID,
    WEB_LOGIN_BACK_TEXT,
    WEB_LOGIN_BACK_TESTID,
    WEB_LOGIN_ENTRY_TESTID,
    WEB_LOGIN_ENTRY_TEXT,
  } = await import(pathToFileURL(path.join(ROOT, "src/renderer/features/auth/login-gate-logic.mjs")).href);

  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    record(pages.length > 0, "拿到主窗页面对象", `${pages.length} 个页面`);
    if (pages.length === 0) {
      console.log(formatSummary({ pass: results.length - 1, fail: 1 }));
      process.exitCode = 1;
      return;
    }

    // 主窗 = 加载 devUrl 的那个页面（歌词窗是另一个 label/页面）
    const page = pages.find((candidate) => /localhost:1420|tauri:\/\/|index\.html/.test(candidate.url())) ?? pages[0];
    record(true, "主窗 URL", page.url());

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error).slice(0, 300)));

    // R17 审查 3/3：监听器挂好之后**重新加载**一次——只捕捉 attach 之后的事件会漏掉启动期
    // 那几条（正是最可能报错的地方）。顺带证明"重新加载之后二维码会重新建单并画出来"。
    await page.reload({ waitUntil: "load" });
    // 等渲染层真的画出东西（Vite 的模块图 + React 首帧）：等不到就让下面那条断言如实报红
    await page
      .waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: TIMEOUT_MS })
      .catch(() => undefined);
    info("已重新加载主窗", "console 捕获窗口从第一帧起（R17 审查 3/3：reload 方案）");

    // 渲染层已出内容：**真断言**（R17 审查 1/3：原来的 `!Loading || length>0` 恒真）
    const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => "")).trim();
    record(
      bodyText.length > 0 && !/正在加载|Loading/i.test(bodyText),
      "渲染层已出内容（非空且不是加载态）",
      `${bodyText.replace(/\s+/g, " ").slice(0, 70)}`,
    );

    // 等门禁进 QR 档（自动发起 auth:qr-start → 建单 → 画码，允许一点时间）。
    //
    // R19：这一步是"断言前先把门禁等到位"。reload 之后渲染层要重新问一次
    // `auth:get-status` 才知道该显示哪一层（旧版靠一条一次性广播 → 会卡在 checking），
    // 所以等待必须带上**状态行**：等不到时把当时那一档报出来，日志直接指认"卡在检查登录状态…"。
    const qrTier = await waitForQrTier(page, { testid: QR_TESTID, timeoutMs: TIMEOUT_MS });
    const canvasSeen = qrTier.seen;
    record(
      canvasSeen,
      `二维码 canvas 出现（[data-testid="${QR_TESTID}"]）`,
      canvasSeen ? "已进入 QR 档" : `等 ${TIMEOUT_MS}ms 没进入 QR 档；当时状态行「${qrTier.status || "（空）"}」`,
    );

    let measurement = { found: false };
    if (canvasSeen) {
      // 画码是 useEffect 里的异步（库编码 + 绘制），量之前给它一点时间
      const deadline = Date.now() + 15000;
      do {
        measurement = await page.evaluate(measureQrInPage, QR_TESTID);
        if (measurement.found && measurement.coverage > 0) break;
        await sleep(500);
      } while (Date.now() < deadline);
      record(measurement.found, "画布尺寸与像素可读", measurement.found ? `${measurement.width}×${measurement.height}, 不透明 ${measurement.opaqueCount}px` : "读不到");

      const [low, high] = INK_COVERAGE_RANGE;
      const coverage = measurement.coverage ?? 0;
      record(
        coverage >= low && coverage <= high,
        "二维码**有墨迹**：暗像素占比在二维码合理区间内（空白画布会红）",
        `coverage=${coverage.toFixed(4)}（区间 ${low}–${high}），暗像素 ${measurement.darkCount}`,
      );

      const finders = measurement.finders ?? {};
      const finderOk = ["topLeft", "topRight", "bottomLeft"].every((k) => (finders[k] ?? 0) >= FINDER_MIN_DARK_RATIO);
      record(
        finderOk,
        "三个定位图案都在（真二维码的结构签名，不只是「有黑点」）",
        `左上 ${(finders.topLeft ?? 0).toFixed(3)} / 右上 ${(finders.topRight ?? 0).toFixed(3)} / 左下 ${(finders.bottomLeft ?? 0).toFixed(3)}（下限 ${FINDER_MIN_DARK_RATIO}）`,
      );
    }

    // 状态行文案：必须是门禁状态机的已知档位之一
    const { QR_GATE_STATUS, LOGIN_GATE_PHASE, loginGateStatusLine, initialGateState } = await import(
      pathToFileURL(path.join(ROOT, "src/renderer/features/auth/login-gate-logic.mjs")).href
    );
    // 合成每个二维码档位下的状态行（phase 必须是确定的"未登录"：checking 会盖住二维码那一支）
    const knownLines = new Set(
      Object.values(QR_GATE_STATUS).map((status) =>
        loginGateStatusLine({
          ...initialGateState(),
          phase: LOGIN_GATE_PHASE.loggedOut,
          path: "qr",
          qr: { ...initialGateState().qr, status },
        }),
      ),
    );
    const statusText = await page.evaluate(() => document.querySelector('[role="status"]')?.textContent?.trim() ?? "");
    record(knownLines.has(statusText), "状态行文案是已知档位之一", `"${statusText}"`);

    // R18：布局与视觉（标题/边框/提示/几何顺序/常驻入口）在真窗上量
    const layout = await page.evaluate(measureGateLayoutInPage, {
      testid: QR_TESTID,
      entryTestid: WEB_LOGIN_ENTRY_TESTID,
      titleText: LOGIN_GATE_TITLE,
      hintText: QR_HINT_TEXT,
    });

    record(
      layout.titleCount === 1,
      "标题在全页只出现一次（header 里那份已移除）",
      `标题元素 ${layout.titleCount} 个；页面标题元素：${JSON.stringify(layout.headings)}`,
    );
    record(
      layout.hintCount === 1 && layout.paragraphs.includes(QR_HINT_TEXT),
      "提示文案与唯一真源一致、且只出现一次（状态行不复述它）",
      `期望 "${QR_HINT_TEXT}"，页面 p 文案 ${JSON.stringify(layout.paragraphs)}`,
    );

    const border = layout.containerBorder;
    const borderWidth = border === null ? 0 : Number.parseFloat(border.width);
    record(
      Number.isFinite(borderWidth) && borderWidth > 0 && border.style !== "none" && border.style !== "",
      "二维码容器的**计算边框**非零（量的是渲染后的样式，不是类名）",
      border === null ? "读不到容器样式" : `border: ${border.width} ${border.style}；圆角 ${border.radius}`,
    );

    record(
      layout.entryText === WEB_LOGIN_ENTRY_TEXT && layout.entryDisabled === false,
      "「在网页中打开登录」常驻且可点（正常路径也不再只有错误态才有它）",
      `入口文案 "${layout.entryText}"，disabled=${layout.entryDisabled}`,
    );

    // R20 要求 1：header 里那句品牌与窗口标题栏重复 → 删掉。量的是**渲染后的可见文字**
    record(
      layout.headerText === "",
      "header 里没有任何可见文字（R20：与窗口标题栏重复的品牌已删）",
      layout.headerText === "" ? "空" : `header 文本「${layout.headerText}」`,
    );

    // R20 要求 2：二维码容器本身可点刷新（可达名字 + 当前可点）
    const refresh = layout.buttons.find((button) => button.testid === QR_REFRESH_TESTID);
    record(
      refresh !== undefined && refresh.label === QR_REFRESH_LABEL && refresh.disabled === false,
      "二维码容器可点刷新（有可达名字，等待扫码时可点）",
      refresh === undefined
        ? `页面里没有 [data-testid="${QR_REFRESH_TESTID}"]：${JSON.stringify(layout.buttons)}`
        : `aria-label="${refresh.label}"，disabled=${refresh.disabled}`,
    );

    // R20 要求 2 的另一半：正常路径的可操作元素集合（「重试」只在失败态出现）
    const buttonIds = layout.buttons.map((button) => button.testid || button.text);
    record(
      buttonIds.length === 2 && buttonIds[0] === QR_REFRESH_TESTID && buttonIds[1] === WEB_LOGIN_ENTRY_TESTID,
      "正常路径恰好两个可操作元素：二维码刷新容器 + 常驻入口",
      `实际 ${layout.buttons.length} 个：${JSON.stringify(layout.buttons)}`,
    );

    const boxes = {
      title: layout.titleBox,
      qr: layout.qrBox,
      hint: layout.hintBox,
      status: layout.statusBox,
      entry: layout.entryBox,
    };
    const missing = Object.entries(boxes).filter(([, box]) => box === null).map(([name]) => name);
    const stacked =
      missing.length === 0 &&
      boxes.title.y < boxes.qr.y &&
      boxes.qr.y < boxes.hint.y &&
      boxes.hint.y < boxes.status.y &&
      boxes.status.y < boxes.entry.y;
    record(
      stacked,
      "自上而下的几何顺序：标题 → 二维码 → 提示 → 状态行 → 次要入口",
      missing.length > 0 ? `量不到这些元素的盒子：${missing.join("、")}` : Object.entries(boxes).map(([name, box]) => `${name}@y=${box.y}`).join(" → "),
    );

    const alignedAndAbove =
      boxes.title !== null &&
      boxes.qr !== null &&
      boxes.title.y + boxes.title.height <= boxes.qr.y + 1 &&
      Math.abs(boxes.title.centerX - boxes.qr.centerX) <= CENTER_TOLERANCE_PX;
    record(
      alignedAndAbove,
      "标题在二维码**正上方**且与之同轴居中",
      boxes.title === null || boxes.qr === null
        ? "量不到标题或二维码的盒子"
        : `标题底 ${boxes.title.y + boxes.title.height} ≤ 二维码顶 ${boxes.qr.y}；中心横坐标 ${boxes.title.centerX} vs ${boxes.qr.centerX}（容差 ${CENTER_TOLERANCE_PX}px）`,
    );

    // R20 要求 3（显式开关）：网页登录窗铺满内容区时，header 里那条「返回扫码登录」是
    // 用户唯一能点到的控件——点开它、量它、再点它，看门禁是不是回到二维码态。
    if (CHECK_BACK_PATH) {
      const entrySelector = `[data-testid="${WEB_LOGIN_ENTRY_TESTID}"]`;
      const backSelector = `[data-testid="${WEB_LOGIN_BACK_TESTID}"]`;
      let opened = false;
      let openDetail = "";
      try {
        await page.click(entrySelector, { timeout: TIMEOUT_MS });
        await page.waitForSelector(backSelector, { timeout: TIMEOUT_MS });
        opened = true;
        openDetail = "header 里出现了返回控件";
      } catch (error) {
        openDetail = String(error.message ?? error).slice(0, 200);
      }
      record(opened, "点开网页登录之后，header 里出现「返回扫码登录」", openDetail);

      if (opened) {
        const back = await page.evaluate(measureBackEntryInPage, {
          backTestid: WEB_LOGIN_BACK_TESTID,
          openTestid: WEB_LOGIN_ENTRY_TESTID,
          backText: WEB_LOGIN_BACK_TEXT,
        });
        record(
          back.found && back.text === WEB_LOGIN_BACK_TEXT && back.inHeader && back.disabled === false && back.openEntryGone,
          "「返回扫码登录」文案正确、在 header 里、可点，且「打开」形态已退场",
          JSON.stringify(back),
        );

        let returned = { seen: false, status: "" };
        try {
          await page.click(backSelector, { timeout: TIMEOUT_MS });
          returned = await waitForQrTier(page, { testid: QR_TESTID, timeoutMs: TIMEOUT_MS });
        } catch (error) {
          returned = { seen: false, status: String(error.message ?? error).slice(0, 200) };
        }
        record(
          returned.seen,
          "点「返回扫码登录」之后回到二维码态（新码重新发出来，状态行不再是那条路）",
          returned.seen ? "新二维码已画出来" : `没回到二维码态；当时状态行「${returned.status || "（空）"}」`,
        );
      }
    }

    // 证据落盘（信息，不是断言）
    const shot = path.join(ROOT, OUT_DIR, "main-window.png");
    await page.screenshot({ path: shot });
    info("主窗截图已落盘", path.relative(ROOT, shot));

    await sleep(1500); // 让延迟到达的 console error 有机会被记下来
    record(
      consoleErrors.length === 0,
      "console 零 error（reload 之后从第一帧起）",
      consoleErrors.length === 0 ? "无" : JSON.stringify(consoleErrors),
    );
    record(pageErrors.length === 0, "零 pageerror（未捕获异常）", pageErrors.length === 0 ? "无" : JSON.stringify(pageErrors));

    const domSummary = {
      url: page.url(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      bodyText: bodyText.slice(0, 500),
      statusText,
      paragraphs: layout.paragraphs,
      buttons: layout.buttons,
      layout: { ...layout, containerBorder: border },
      measurement,
      consoleErrors,
      pageErrors,
    };
    await writeFile(path.join(ROOT, OUT_DIR, "gate-dom.json"), JSON.stringify(domSummary, null, 2), "utf8");

    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n${formatSummary({ pass, fail })}`);
    info("证据", `${OUT_DIR}/main-window.png、${OUT_DIR}/gate-dom.json`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify-live.mjs")) {
  await main();
}
