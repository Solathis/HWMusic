#!/usr/bin/env node
/**
 * `npm run test:browser`：**真浏览器**里的 AMLL 守卫（playwright-core + Chromium）。
 *
 * ## 守什么
 *
 * R8/R9/R12 的冒烟都是 `react-dom/server` 渲静态标记——它证明不了"AMLL 组件在真浏览器里
 * 真的挂上、真的画出了像素、真的跟着进度动"。这里补上这一段：
 *
 * 1. 用**真组件**（`AmllLyricsPanel` / `AmllBackground`，不是替身）+ 真 `parseAmllLyrics` 适配器
 *    在 Chromium 里挂载；
 * 2. DOM 级：面板/背景宿主尺寸非零、AMLL 把歌词文本渲进了 DOM；
 * 3. 像素级：截图裁到面板区域，用 sharp 算熵（空白面板熵≈0）与**两帧差异**
 *    （推进进度后必须变——受控组件 + rAF 进度泵真的在跑）；
 * 4. 运行期错误（console error / pageerror）一条都不许有。
 *
 * ## 口径：SKIP 不算成功
 *
 * 没有 Chromium 可用时**判 FAIL**，不静默跳过：CI 里"跳过的守卫"和"没有守卫"是同义词。
 * 本机可能只有旧 revision 的 Chromium（playwright 自带的那个版本号对不上），所以浏览器按
 * 候选顺序找：`PLAYWRIGHT_CHROMIUM_EXECUTABLE` → playwright 自带 → 系统 Chrome → 系统 Edge。
 * 判据是"能不能真跑起来"（真启动 + 真渲染），不是"配置文件里写着有"。
 *
 * ## 被测产物
 *
 * 守卫跑在**构建产物**上（先 `npm run dist:sidecar` + `vite build`，CI 里就是这么排的）：
 * 渲染层产物存在与否在这里只作为"环境就绪"的证据记录下来，真正的断言在被挂载的组件上。
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";
import { chromium } from "playwright-core";
import sharp from "sharp";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 守卫自己的中间产物（.gitignore 已含 .tmp/）。 */
export const GUARD_DIR = ".tmp/browser-guard";

/** 歌词夹具：两行，间隔 3 秒（推进进度要看得见变化）。 */
export const FIXTURE_LRC = ["[00:00.00]第一行歌词守卫", "[00:03.00]第二行歌词守卫"].join("\n");

/** 判定：有 FAIL 或有 SKIP 都算不过（SKIP 不算成功）。 */
export function guardVerdict({ pass, fail, skipped }) {
  if (fail > 0) return "FAIL";
  if (skipped > 0) return "FAIL";
  return pass > 0 ? "PASS" : "FAIL";
}

/** 汇总行（CI 直接断言这一行）。 */
export function formatGuardSummary({ pass, fail, skipped }) {
  return `test:browser 结果：PASS ${pass} / SKIP ${skipped} / FAIL ${fail}`;
}

/**
 * Chromium 候选（顺序即优先级）。
 *
 * 每一项都是"怎么启动"，不是"文件在不在"——只有真启动成功才算找到浏览器。
 */
export function chromiumCandidates({ env = process.env } = {}) {
  const candidates = [];
  const override = typeof env.PLAYWRIGHT_CHROMIUM_EXECUTABLE === "string" ? env.PLAYWRIGHT_CHROMIUM_EXECUTABLE.trim() : "";
  if (override !== "") candidates.push({ kind: "env", executablePath: override });
  candidates.push({ kind: "playwright" });
  candidates.push({ kind: "channel:chrome", channel: "chrome" });
  candidates.push({ kind: "channel:msedge", channel: "msedge" });
  return candidates;
}

/** 守卫页面的挂载源码（生成物，不入库）。 */
export function harnessSource() {
  return `import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { AmllBackground } from "../../src/renderer/AmllBackground.tsx";
import { AmllLyricsPanel } from "../../src/renderer/AmllLyricsPanel.tsx";
import { parseAmllLyrics } from "../../src/renderer/features/lyrics/amll-adapter.ts";

const LRC = ${JSON.stringify(FIXTURE_LRC)};
const lines = parseAmllLyrics(LRC).lines;

// 真组件要的运行时替身：只提供 LyricPlayer 受控组件需要的那一个读数
let currentTimeMs = 0;
const runtime = { player: { snapshot: () => ({ currentTimeMs }) } };

function Guard() {
  const [seekGeneration] = useState(0);
  useEffect(() => {
    window.__guard = {
      lineCount: lines.length,
      lineTexts: lines.map((line) => (line.words ?? []).map((word) => word.word).join("")),
      setTime(ms) {
        currentTimeMs = ms;
      },
      readTime: () => currentTimeMs,
    };
  }, []);
  return (
    <div style={{ position: "relative", width: 900, height: 420, background: "#141018" }}>
      <AmllBackground playing hasLyric albumArt={undefined} />
      <AmllLyricsPanel runtime={runtime} lines={lines} playing seekGeneration={seekGeneration} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Guard />
  </StrictMode>,
);
`;
}

/** 守卫页面（生成物，不入库）。 */
export function harnessHtml(hasCss) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>R14 AMLL 浏览器守卫</title>
    <link rel="stylesheet" href="./app.css" />
    ${hasCss ? "" : "<!-- 渲染层样式缺失：面板量不出尺寸，守卫会判失败 -->"}
    <style>
      html, body { margin: 0; padding: 0; background: #141018; }
      #root { padding: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./guard.js"></script>
  </body>
</html>
`;
}

/**
 * 渲染层产物里的 CSS（Tailwind 产出 + 设计令牌 + AMLL 官方样式）。
 *
 * 守卫**必须**用真样式：`AmllLyricsPanel` 的外层是 `absolute inset-0`，没有样式就没有尺寸，
 * "面板挂上了"会变成"面板高 0"——那种失败信息会把人引到错误的方向。
 */
export async function collectRendererCss(root = ROOT) {
  const assets = path.join(root, "out/renderer/assets");
  let entries = [];
  try {
    entries = await readdir(assets);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".css")).map((name) => path.join(assets, name)).sort();
}

/** 极简静态服务：守卫页面只需要 html/js/css。 */
function startServer(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(dir, path.normalize(relative).replace(/^([/\\])+/, ""));
    if (!file.startsWith(dir)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** 截图裁到元素区域，返回 PNG 缓冲。 */
async function shot(page, selector) {
  const box = await page.locator(selector).boundingBox();
  if (box === null) return null;
  return page.screenshot({ clip: box, type: "png" });
}

/**
 * 像素特征：熵 + "字迹比例"（与画面主色不同的像素占比）。
 *
 * 为什么两个都要：面板绝大部分是背景，整幅图的熵天然很低（实测约 0.1），单看熵会误判
 * "什么都没画"；字迹比例直接回答"有没有东西被画上去"。
 */
async function pixelStats(buffer) {
  const stats = await sharp(buffer).stats();
  const raw = await sharp(buffer).raw().toBuffer();
  const histogram = new Map();
  for (let index = 0; index + 3 < raw.length; index += 4) {
    const key = (raw[index] << 16) | (raw[index + 1] << 8) | raw[index + 2];
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const total = [...histogram.values()].reduce((sum, count) => sum + count, 0);
  const modal = Math.max(0, ...histogram.values());
  return { entropy: stats.entropy, inkRatio: total === 0 ? 0 : 1 - modal / total, raw };
}

/** 两帧像素差异比例（0..1）。 */
function pixelDiffRatio(a, b) {
  if (a.length !== b.length) return 1;
  let differing = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) differing += 1;
  }
  return differing / a.length;
}

async function launchChromium(candidates, log) {
  const failures = [];
  for (const candidate of candidates) {
    const options = { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] };
    if (candidate.executablePath) options.executablePath = candidate.executablePath;
    if (candidate.channel) options.channel = candidate.channel;
    try {
      const browser = await chromium.launch(options);
      log(`浏览器：${candidate.kind}（真启动成功）`);
      return { browser, kind: candidate.kind };
    } catch (cause) {
      failures.push(`${candidate.kind}: ${cause.message.split("\n")[0]}`);
    }
  }
  return { browser: null, failures };
}

/** 跑全部检查，返回 {pass, fail, skipped, checks}。 */
export async function runGuard({ root = ROOT, log = console.log } = {}) {
  const guardDir = path.join(root, GUARD_DIR);
  await rm(guardDir, { recursive: true, force: true });
  await mkdir(guardDir, { recursive: true });

  // 沙箱只给工作区内的可删范围（R9 实测）：esbuild 的临时文件也得落在仓内
  const temp = path.join(root, ".tmp/temp");
  await mkdir(temp, { recursive: true });
  process.env.TEMP = temp;
  process.env.TMP = temp;

  await writeFile(path.join(guardDir, "guard.tsx"), harnessSource(), "utf8");
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [`${GUARD_DIR}/guard.tsx`],
    outfile: `${GUARD_DIR}/guard.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  if (built.errors.length > 0) throw new Error(`守卫页面构建失败：${JSON.stringify(built.errors)}`);
  const hasCss = existsSync(path.join(guardDir, "guard.css"));

  // 真样式：把渲染层产物里的 CSS 合成一份喂给守卫页面（没样式就没有布局，见 collectRendererCss）
  const cssFiles = await collectRendererCss(root);
  if (cssFiles.length === 0) {
    return {
      pass: 0,
      fail: 1,
      skipped: 0,
      checks: [
        {
          id: "renderer-styles",
          ok: false,
          detail: "out/renderer/assets 里没有 CSS：守卫要真样式才量得出面板尺寸，先跑 npm run build:web（CI 里 dist:sidecar/渲染层构建在前）",
        },
      ],
    };
  }
  const css = (await Promise.all(cssFiles.map((file) => readFile(file, "utf8")))).join("\n");
  await writeFile(path.join(guardDir, "app.css"), css, "utf8");
  await writeFile(path.join(guardDir, "index.html"), harnessHtml(true), "utf8");
  log(`样式：${cssFiles.map((file) => path.relative(root, file)).join("、")}（${css.length} 字符）`);

  const rendererProduct = path.join(root, "out/renderer/index.html");
  log(`渲染层产物：${existsSync(rendererProduct) ? "out/renderer 就绪" : "out/renderer/index.html 不存在"}`);

  const candidates = chromiumCandidates();
  const launched = await launchChromium(candidates, log);
  if (launched.browser === null) {
    log("浏览器不可用（没有 Chromium / Chrome / Edge 能真启动）：");
    for (const failure of launched.failures) log(`  ${failure}`);
    return { pass: 0, fail: 1, skipped: 0, checks: [{ id: "chromium-available", ok: false, detail: "无浏览器可用 = FAIL（SKIP 不算成功）" }] };
  }

  const browser = launched.browser;
  const { server, port } = await startServer(guardDir);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__guard !== undefined, null, { timeout: 15_000 });
    await page.waitForTimeout(400);

    // 1. 夹具：真适配器把 LRC 解析成了两行
    const fixture = await page.evaluate(() => ({ lines: window.__guard.lineCount, texts: window.__guard.lineTexts }));
    add("fixture-parsed", fixture.lines === 2, `parseAmllLyrics 解析出 ${fixture.lines} 行：${JSON.stringify(fixture.texts)}`);

    // 2. DOM：面板宿主与背景宿主都挂上了，且尺寸非零
    const panelBox = await page.locator('[data-testid="amll-lyrics-panel"]').boundingBox();
    const backgroundBox = await page.locator('[data-testid="amll-background"]').boundingBox();
    add(
      "hosts-mounted",
      panelBox !== null && panelBox.width > 0 && panelBox.height > 0 && backgroundBox !== null && backgroundBox.width > 0,
      `面板 ${JSON.stringify(panelBox)}；背景 ${JSON.stringify(backgroundBox)}`,
    );

    // 3. DOM：AMLL 把歌词文本渲进了 DOM（不是空壳宿主）
    const panelText = (await page.locator('[data-testid="amll-lyrics-panel"]').textContent()) ?? "";
    add(
      "lyric-text-rendered",
      panelText.includes("第一行歌词守卫"),
      `面板 textContent 长度 ${panelText.length}，含首行歌词：${panelText.includes("第一行歌词守卫")}`,
    );

    // 4. DOM：背景宿主里有 AMLL 自建的画布（官方组件真的装了渲染器）
    const canvasCount = await page.locator('[data-testid="amll-background"] canvas').count();
    add("background-renderer", canvasCount >= 1, `[data-testid="amll-background"] 里的 canvas 数：${canvasCount}`);

    // 5. 像素：面板区域真的被画了东西（有字迹才有非主色像素）
    const before = await shot(page, '[data-testid="amll-lyrics-panel"]');
    const beforeStats = before === null ? null : await pixelStats(before);
    add(
      "panel-pixels",
      beforeStats !== null && beforeStats.inkRatio > 0.002 && beforeStats.entropy > 0.03,
      beforeStats === null
        ? "面板截不出来"
        : `面板区域字迹比例 ${(beforeStats.inkRatio * 100).toFixed(2)}%、熵 ${beforeStats.entropy.toFixed(3)}（空白面板两项都≈0）`,
    );

    // 6. 像素：推进进度后画面必须变（受控组件 + rAF 进度泵真的在跑）
    await page.evaluate(() => window.__guard.setTime(3300));
    await page.waitForTimeout(600);
    const after = await shot(page, '[data-testid="amll-lyrics-panel"]');
    const afterStats = after === null ? null : await pixelStats(after);
    const diff = beforeStats && afterStats ? pixelDiffRatio(beforeStats.raw, afterStats.raw) : 0;
    const afterText = (await page.locator('[data-testid="amll-lyrics-panel"]').textContent()) ?? "";
    add(
      "progress-advances",
      diff > 0.001 && afterText.includes("第二行歌词守卫"),
      `推进到 3300ms：像素差异 ${(diff * 100).toFixed(2)}%、第二行在 DOM 里=${afterText.includes("第二行歌词守卫")}`,
    );

    // 7. 运行期干净：console error / pageerror 一条都不许有
    add(
      "no-runtime-errors",
      consoleErrors.length === 0 && pageErrors.length === 0,
      `console error ${consoleErrors.length} 条、pageerror ${pageErrors.length} 条${[...consoleErrors, ...pageErrors].slice(0, 3).map((text) => `\n      ${text.slice(0, 200)}`).join("")}`,
    );

    if (process.env.R14_GUARD_DOM_PROBE === "1") {
      const html = await page.locator('[data-testid="amll-lyrics-panel"]').innerHTML();
      add("dom-probe", true, html.slice(0, 3000));
    }
  } finally {
    await browser.close();
    server.close();
  }

  const pass = checks.filter((check) => check.ok).length;
  const fail = checks.filter((check) => !check.ok).length;
  for (const check of checks) log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.id.padEnd(22)} ${check.detail}`);
  return { pass, fail, skipped: 0, checks };
}

async function main() {
  const { pass, fail, skipped, checks } = await runGuard();
  console.log(formatGuardSummary({ pass, fail, skipped }));
  const verdict = guardVerdict({ pass, fail, skipped });
  if (verdict !== "PASS") {
    console.error(`test:browser ${verdict}：${checks.filter((check) => !check.ok).map((check) => check.id).join("、")}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`test:browser 失败：${cause.message}`);
    process.exit(1);
  });
}
