#!/usr/bin/env node
/**
 * `npm run test:browser`：**真浏览器**里的 AMLL 守卫（playwright-core + Chromium）。
 *
 * ## 守什么
 *
 * R8/R9/R12 的冒烟都是 `react-dom/server` 渲静态标记——它证明不了"AMLL 组件在真浏览器里
 * 真的挂上、真的画出了像素、真的跟着进度动"。这里补上这一段：
 *
 * 1. 真 LibraryShell → PlaybackStage → AMLL/PlayerBar 组合，只在 Tauri IPC 边界给夹具；
 * 2. 浅/暗语义主题，文字 Range 截图与隐藏文字后的同区域对比，不能把背景误算成歌词；
 * 3. 反转下层侧栏/header/列表/播放器，舞台像素必须不受影响；
 * 4. 暂停打开/重开、播放/seek、菜单与 Sheet/Dialog 真交互，桌面歌词也测字迹；
 * 5. 运行期错误（console error / pageerror）一条都不许有。
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
 * 使用 build:web 产出的真实 CSS 与 esbuild 打包的生产组件；Tauri IPC 与音频响应为夹具。
 * 这不替代真实 WebView2 的在线取词取证，真窗验证另行记录。
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

/** 守卫页面的挂载源码（生成物，不入库）；只在 Tauri IPC 边界提供夹具。 */
export function harnessSource() {
  return `import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { LibraryShell } from "../../src/renderer/App.tsx";
import { LyricsWindow } from "../../src/renderer/LyricsWindow.tsx";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip.tsx";
import { getPlayerRuntime } from "../../src/renderer/features/playback/player-runtime.ts";
import { DEFAULT_LYRICS_CONFIG } from "../../src/renderer/features/lyrics/lyrics-window.mjs";

const LRC = ${JSON.stringify(FIXTURE_LRC)};
let currentTheme = "light";
const songs = Array.from({ length: 36 }, (_, index) => ({
  id: String(index + 1), name: "浏览器守卫曲目 " + (index + 1), artists: "守卫艺人", album: "守卫专辑", duration: 12,
  coverUrl: "https://music.dbankcdn.cn/guard-cover-" + (index % 2 === 0 ? "warm" : "cool") + ".png",
}));
mockIPC((command, args) => {
  if (command === "core_call") {
    switch (args.channel) {
      case "settings:get": return { settings: { schemaVersion: 1, data: {} } };
      case "settings:set": return { settings: { schemaVersion: 1, data: args.payload.patch } };
      case "library:favorites": return { songs, hasMore: false, skipped: 0, reportedTotal: songs.length };
      case "playback:resolve-url": return { url: "https://music.dbankcdn.cn/guard.wav" };
      case "playback:lyrics": return { text: LRC };
      default: throw new Error("未提供守卫 IPC：" + args.channel);
    }
  }
  if (command === "core_get_tray_available") return true;
  if (command === "core_login_chrome") return { theme: currentTheme };
  if (command === "core_lyrics_document") return emit("core:event", { channel: "lyrics:document", payload: args.document });
  if (command === "core_lyrics_progress") return emit("core:event", { channel: "lyrics:progress", payload: args.progress });
  if (command.startsWith("core_lyrics_")) return { config: DEFAULT_LYRICS_CONFIG, visible: false };
  throw new Error("未提供守卫命令：" + command);
}, { shouldMockEvents: true });
const runtime = getPlayerRuntime();

function Guard() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    window.__guard = {
      snapshot: () => runtime.player.snapshot(),
      setTime: (ms) => runtime.player.seek(ms),
      nextTrack: () => runtime.player.next(),
      prepareRepeatedQueue: () => runtime.player.playQueue([songs[0], songs[0]], 0),
      markRuntime() { this.markedRuntime = runtime; },
      sameRuntime: () => window.__guard.markedRuntime === getPlayerRuntime(),
      async setCoverFailure() {
        await runtime.player.playQueue(songs.map((song) => ({ ...song, coverUrl: "https://music.dbankcdn.cn/guard-cover-broken.png" })), 0);
        runtime.player.pause();
        runtime.player.seek(700);
      },
      setLyrics: (status) => runtime.player.setLyrics([], status),
      restoreLyrics: async () => {
        const { parseAmllLyrics } = await import("../../src/renderer/features/lyrics/amll-adapter.ts");
        runtime.player.setLyrics(parseAmllLyrics(LRC).lines, "ready");
      },
      setDesktop,
      setHostTheme(choice) { currentTheme = choice; },
      async desktopBeforeMount() {
        const { getLyricsBridge } = await import("../../src/renderer/features/lyrics/lyrics-bridge.mjs");
        await getLyricsBridge().subscribeReady(() => runtime.player.snapshot());
        const state = runtime.player.snapshot();
        await emit("core:event", { channel: "lyrics:document", payload: state.lyrics });
        setDesktop(true);
      },
      async desktopDocument(status = "ready") {
        const state = runtime.player.snapshot();
        await emit("core:event", { channel: "lyrics:document", payload: {
          status, lines: status === "ready" ? state.lyrics.lines : [],
        }});
        await emit("core:event", { channel: "lyrics:progress", payload: {
          timeMs: state.currentTimeMs, playing: false, seekGeneration: state.seekGeneration,
        }});
      },
      async ready() {
        await runtime.initialize();
        await runtime.player.playQueue(songs, 0);
        runtime.player.pause();
        runtime.player.seek(700);
      },
    };
  }, []);
  return desktop ? <LyricsWindow /> : (
    <TooltipProvider>
      <div className="h-full w-full" data-shell="app-shell">
        <LibraryShell />
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")).render(<StrictMode><Guard /></StrictMode>);
`;
}

/** 守卫页面（生成物，不入库）。 */
export function harnessHtml(hasCss) {
  return `<!doctype html>
<html lang="zh-CN" class="light">
  <head>
    <meta charset="utf-8" />
    <title>AMLL 完整舞台浏览器守卫</title>
    <link rel="stylesheet" href="./app.css" />
    ${hasCss ? "" : "<!-- 渲染层样式缺失：面板量不出尺寸，守卫会判失败 -->"}
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

/** 裁到文字 Range；与隐藏同一文字后的像素比较，不能把背景/表格误算成歌词。 */
async function textPixels(page, selector, theme, file) {
  const box = await page.locator(selector).first().evaluate(async (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    let previous = "";
    let stable = 0;
    let box;
    for (let frame = 0; frame < 240; frame += 1) {
      await new Promise(requestAnimationFrame);
      const rect = range.getBoundingClientRect();
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      box = { x, y, width: Math.min(innerWidth, Math.ceil(rect.right)) - x, height: Math.min(innerHeight, Math.ceil(rect.bottom)) - y };
      const next = JSON.stringify(box);
      stable = previous === next ? stable + 1 : 0;
      if (stable >= 12) break;
      previous = next;
    }
    return box;
  }).catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return { ink: 0, changed: 0, box };
  const target = page.locator(selector).first();
  const visible = await page.screenshot({ clip: box, path: file, type: "png" });
  let hidden;
  try {
    await target.evaluate((element) => { element.style.visibility = "hidden"; });
    hidden = await page.screenshot({ clip: box, type: "png" });
  } finally {
    await target.evaluate((element) => { element.style.removeProperty("visibility"); });
  }
  const a = await sharp(visible).removeAlpha().raw().toBuffer();
  const b = await sharp(hidden).removeAlpha().raw().toBuffer();
  let ink = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) < 40) continue;
    changed += 1;
    const luminance = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
    if (theme === "light" ? luminance < 95 : luminance > 160) ink += 1;
  }
  return { ink, changed, box };
}

function fixtureAudio() {
  const samples = 8000 * 12;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
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
  const add = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    log(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(22)} ${detail}`);
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
    page.setDefaultTimeout(15_000);
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const audio = fixtureAudio();
    await page.route("https://music.dbankcdn.cn/guard.wav", (route) => {
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({
        status: range ? 206 : 200, contentType: "audio/wav", body: audio.subarray(start, end + 1),
        headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${audio.length}` } : {}) },
      });
    });

    for (const [name, background] of [["warm", { r: 230, g: 72, b: 32 }], ["cool", { r: 24, g: 100, b: 232 }]]) {
      const cover = await sharp({ create: { width: 256, height: 256, channels: 3, background } }).png().toBuffer();
      await page.route(`https://music.dbankcdn.cn/guard-cover-${name}.png`, (route) => route.fulfill({
        contentType: "image/png", body: cover, headers: { "access-control-allow-origin": "*" },
      }));
    }
    await page.route("https://music.dbankcdn.cn/guard-cover-broken.png", (route) => route.fulfill({
      status: 200, contentType: "image/png", body: Buffer.from("invalid image"), headers: { "access-control-allow-origin": "*" },
    }));
    const stage = page.getByTestId("playback-stage");
    const activeLine = '[data-testid="amll-lyrics-panel"] [class*="lyricMainLine"][class*="active"]';
    const underlay = '[data-slot="sidebar-container"], [data-slot="sidebar-inset"] > header, [data-slot="sidebar-inset"] > .relative, [data-slot="sidebar-inset"] > [data-testid="player-bar"]';
    for (const theme of ["light", "dark"]) {
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__guard !== undefined, null, { timeout: 15_000 });
      await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
      await page.evaluate(() => window.__guard.ready());
      await page.waitForFunction(() => window.__guard.snapshot().lyrics.status === "ready" && window.__guard.snapshot().durationMs > 0);
      add(`${theme}-fixture`, await page.evaluate(() => window.__guard.snapshot().lyrics.lines.length === 2), "真 IPC 边界夹具 → useLyricsWindow → 官方解析 → 2 行");
      await page.getByTestId("sidebar-search-rail").count().then(async (count) => {
        if (count) await page.getByTestId("sidebar-search-rail").click();
      });
      await page.getByRole("textbox", { name: "搜索关键字", exact: true }).fill("保留页面状态");
      await page.getByTestId("favorites-scroll-root").evaluate((element) => { element.scrollTop = 180; });
      const scrollTop = await page.getByTestId("favorites-scroll-root").evaluate((element) => element.scrollTop);
      await page.getByRole("button", { name: "歌词", exact: true }).click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(1000);
      const box = await stage.boundingBox();
      const covered = await page.evaluate(() => [[12, 12], [12, 400], [1250, 400], [600, 780]].every(([x, y]) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="playback-stage"]')));
      add(`${theme}-full-coverage`, box?.x === 0 && box?.y === 0 && box?.width === 1280 && box?.height === 800 && covered, `舞台 ${JSON.stringify(box)}，四角命中舞台=${covered}`);
      add(`${theme}-background`, await stage.locator('[data-testid="amll-background"] canvas').count() > 0, "完整舞台内使用官方背景画布");
      const unnamedButtons = await stage.locator("button").evaluateAll((buttons) => buttons.filter((button) =>
        button.getBoundingClientRect().width > 0 && !button.getAttribute("aria-label") && !button.textContent?.trim()).length);
      add(`${theme}-no-unwired-controls`, unnamedButtons === 0, `未接线/无名称的可见按钮 ${unnamedButtons} 个`);
      const officialControls = await stage.evaluate((element) => ({
        mediaButton: Boolean(element.querySelector('button[aria-label="播放"][class*="mediaButton"]')),
        progress: Boolean(element.querySelector('[aria-label="播放进度"] [class*="nowPlayingSlider"]')),
        volume: Boolean(element.querySelector('[aria-label="音量"] [class*="volumeControl"]')),
        legacyBar: Boolean(element.querySelector('[data-testid="player-bar"]')),
      }));
      add(`${theme}-official-player-controls`, officialControls.mediaButton && officialControls.progress && officialControls.volume
        && !officialControls.legacyBar, JSON.stringify(officialControls));
      const coverGeometry = await page.evaluate(async () => {
        const cover = document.querySelector('[data-testid="playback-stage-cover"]');
        const lyric = document.querySelector('[data-testid="amll-lyrics-panel"]');
        const rect = (element) => {
          if (!element) return null;
          const b = element.getBoundingClientRect();
          return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const art = cover && [cover, ...cover.querySelectorAll("*")].find((e) => getComputedStyle(e).backgroundImage.includes("guard-cover-warm.png"));
        const url = window.__guard.snapshot().track.coverUrl;
        const image = new Image();
        image.crossOrigin = "anonymous";
        const loaded = await new Promise((resolve) => { image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = url; });
        return { cover: rect(cover), lyric: rect(lyric), backgroundMatches: Boolean(art), loaded };
      });
      add(`${theme}-cover-left-lyrics-right`, Boolean(coverGeometry.cover && coverGeometry.lyric
        && coverGeometry.cover.width > 150 && coverGeometry.cover.height > 150
        && coverGeometry.cover.right <= coverGeometry.lyric.x && coverGeometry.lyric.width > 300
        && coverGeometry.lyric.right <= 1280), JSON.stringify(coverGeometry));
      let coverPixels = { mean: [], visible: false };
      if (coverGeometry.cover?.width > 0) {
        const { x, y, width, height } = coverGeometry.cover;
        const shot = await page.screenshot({ clip: { x: Math.round(x + width * .25), y: Math.round(y + height * .25), width: Math.round(width * .5), height: Math.round(height * .5) } });
        const stats = await sharp(shot).stats();
        const mean = stats.channels.slice(0, 3).map((channel) => Math.round(channel.mean));
        coverPixels = { mean, visible: mean[0] > mean[1] + 80 && mean[0] > mean[2] + 100 };
      }
      add(`${theme}-cover-loaded-pixels`, coverGeometry.loaded && coverGeometry.backgroundMatches && coverPixels.visible, JSON.stringify(coverPixels));
      const pixels = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-paused-line.png`));
      add(`${theme}-paused-text-pixels`, pixels.ink > 60, JSON.stringify(pixels));
      await page.screenshot({ path: path.join(guardDir, `${theme}-stage.png`) });

      const before = await page.screenshot();
      await page.locator(underlay).evaluateAll((elements) => elements.forEach((element) => { element.style.filter = "invert(1)"; }));
      const inverted = await page.screenshot();
      await page.locator(underlay).evaluateAll((elements) => elements.forEach((element) => { element.style.removeProperty("filter"); }));
      const diff = pixelDiffRatio(await sharp(before).raw().toBuffer(), await sharp(inverted).raw().toBuffer());
      add(`${theme}-opaque-underlay`, diff < 0.0001, `反转侧栏/header/列表/原底栏后整窗像素差异 ${(diff * 100).toFixed(4)}%（必须≈0）`);

      const backgroundMean = async () => {
        const shot = await page.screenshot({ clip: { x: 700, y: 24, width: 400, height: 24 } });
        return (await sharp(shot).stats()).channels.slice(0, 3).map((channel) => Math.round(channel.mean));
      };
      const warm = await backgroundMean();
      await stage.getByRole("button", { name: "下一首", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().index === 1 && window.__guard.snapshot().status === "playing");
      await page.waitForTimeout(1800);
      await stage.getByRole("button", { name: "暂停", exact: true }).click();
      const cool = await backgroundMean();
      const colorDistance = Math.hypot(...warm.map((value, index) => value - cool[index]));
      add(`${theme}-cover-theme-color`, colorDistance > 60 && Math.max(...warm) - Math.min(...warm) > 50
        && Math.max(...cool) - Math.min(...cool) > 50, JSON.stringify({ warm, cool, colorDistance }));
      await stage.getByRole("button", { name: "上一首", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().index === 0 && window.__guard.snapshot().status === "playing");
      await page.waitForTimeout(1000);
      await stage.getByRole("button", { name: "暂停", exact: true }).click();
      await page.evaluate(() => window.__guard.setTime(700));

      await stage.getByRole("button", { name: "关闭歌词", exact: true }).click();
      const retained = await page.getByRole("textbox", { name: "搜索关键字", exact: true }).inputValue() === "保留页面状态"
        && await page.getByTestId("favorites-scroll-root").evaluate((element) => element.scrollTop) === scrollTop;
      add(`${theme}-page-retained`, retained, "关闭后搜索输入与收藏滚动位置未丢失");
      await page.getByRole("button", { name: "打开歌词", exact: true }).click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(800);
      const reopened = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-reopened-line.png`));
      add(`${theme}-paused-reopen`, reopened.ink > 60, JSON.stringify(reopened));
      await page.keyboard.press("Escape");
      const escaped = await stage.count() === 0;
      add(`${theme}-escape-close`, escaped, "无上层弹窗时 ESC 关闭舞台");
      if (escaped) {
        await page.getByRole("button", { name: "打开歌词", exact: true }).click();
        await page.waitForTimeout(800);
      }

      await stage.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().status === "playing");
      await page.waitForTimeout(300);
      const playingPixels = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-playing-line.png`));
      add(`${theme}-playing-text-pixels`, playingPixels.ink > 60, JSON.stringify(playingPixels));
      await stage.getByRole("button", { name: "暂停", exact: true }).click();
      await page.evaluate(() => window.__guard.setTime(3300));
      await page.waitForTimeout(800);
      const progressed = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-seek-line.png`));
      const secondActive = await page.locator(activeLine).first().textContent().catch(() => "");
      add(`${theme}-seek-text-pixels`, progressed.ink > 60 && secondActive?.includes("第二行"), `${JSON.stringify(progressed)}，第二行激活=${secondActive?.includes("第二行")}`);

      await stage.getByRole("button", { name: "下一首", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().index === 1 && window.__guard.snapshot().status === "playing");
      await stage.getByRole("button", { name: "上一首", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().index === 0 && window.__guard.snapshot().status === "playing");
      await stage.getByRole("button", { name: "暂停", exact: true }).click();
      const slider = stage.getByRole("slider", { name: "播放进度", exact: true });
      const oldTime = await page.evaluate(() => window.__guard.snapshot().currentTimeMs);
      await slider.focus();
      await slider.press("ArrowRight");
      add(`${theme}-player-controls`, await page.evaluate((old) => window.__guard.snapshot().currentTimeMs > old, oldTime), "舞台内播放/暂停/前后切歌/进度 Slider 真交互成功");
      const officialSlider = slider.locator('[class*="nowPlayingSlider"]').first();
      const sliderBox = await officialSlider.boundingBox();
      if (sliderBox) {
        await page.mouse.move(sliderBox.x + sliderBox.width * .2, sliderBox.y + sliderBox.height / 2);
        await page.mouse.down();
        let timer;
        try {
          await Promise.race([
            page.mouse.move(sliderBox.x + sliderBox.width * .7, sliderBox.y + sliderBox.height / 2, { steps: 12 }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("官方进度拖动阻塞超过 8 秒")), 8000); }),
          ]);
        } finally { clearTimeout(timer); }
        await page.mouse.up();
      }
      await page.waitForTimeout(200);
      const seekMs = await page.evaluate(() => window.__guard.snapshot().currentTimeMs);
      add(`${theme}-official-progress-drag`, Boolean(sliderBox) && seekMs > 6500 && seekMs < 9500, `官方 BouncingSlider 拖动后 ${seekMs}ms（总长 12000ms）`);
      const volumeSlider = stage.getByRole("slider", { name: "音量", exact: true });
      await volumeSlider.focus();
      await volumeSlider.press("ArrowLeft");
      const keyboardVolume = await page.evaluate(() => window.__guard.snapshot().volume);
      const volumeBox = await volumeSlider.locator('[class*="inner"]').first().boundingBox();
      if (volumeBox) await page.mouse.click(volumeBox.x + volumeBox.width * .4, volumeBox.y + volumeBox.height / 2);
      await page.waitForTimeout(200);
      const pointerVolume = await page.evaluate(() => window.__guard.snapshot().volume);
      if (volumeBox) {
        await page.mouse.move(volumeBox.x + volumeBox.width * .4, volumeBox.y + volumeBox.height / 2);
        await page.mouse.down();
        let timer;
        try {
          await Promise.race([
            page.mouse.move(volumeBox.x + volumeBox.width * .6, volumeBox.y + volumeBox.height / 2, { steps: 8 }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("官方音量拖动阻塞超过 8 秒")), 8000); }),
          ]);
        } finally { clearTimeout(timer); }
        await page.mouse.up();
      }
      await page.waitForTimeout(200);
      const draggedVolume = await page.evaluate(() => window.__guard.snapshot().volume);
      add(`${theme}-official-volume-drag`, Boolean(volumeBox) && draggedVolume > .5 && draggedVolume < .7, JSON.stringify({ draggedVolume }));
      await stage.getByRole("button", { name: "静音", exact: true }).click();
      const muted = await page.evaluate(() => window.__guard.snapshot().muted);
      await stage.getByRole("button", { name: "取消静音", exact: true }).click();
      add(`${theme}-official-volume`, keyboardVolume < 1 && pointerVolume > .25 && pointerVolume < .55 && muted
        && await page.evaluate(() => !window.__guard.snapshot().muted), JSON.stringify({ keyboardVolume, pointerVolume, muted }));
      for (const repeated of [false, true]) {
        await page.evaluate(() => window.__guard.markRuntime());
        if (repeated) await page.evaluate(() => window.__guard.prepareRepeatedQueue());
        else await stage.getByRole("button", { name: "播放", exact: true }).click();
        await page.waitForFunction(() => window.__guard.snapshot().status === "playing" && window.__guard.snapshot().durationMs > 0);
        const previousIndex = await page.evaluate(() => window.__guard.snapshot().index);
        const gestureBox = await slider.locator('[class*="nowPlayingSlider"]').first().boundingBox();
        if (gestureBox) {
          await page.mouse.move(gestureBox.x + gestureBox.width * .2, gestureBox.y + gestureBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(gestureBox.x + gestureBox.width * .8, gestureBox.y + gestureBox.height / 2, { steps: 12 });
          await page.waitForTimeout(100);
        }
        await page.evaluate(() => window.__guard.nextTrack());
        await page.waitForFunction((index) => window.__guard.snapshot().index === index + 1
          && window.__guard.snapshot().status === "playing", previousIndex);
        const afterNext = await page.evaluate(() => ({ index: window.__guard.snapshot().index, timeMs: window.__guard.snapshot().currentTimeMs,
          seekGeneration: window.__guard.snapshot().seekGeneration }));
        await page.mouse.up();
        await page.waitForTimeout(200);
        const released = await page.evaluate(() => ({ index: window.__guard.snapshot().index, timeMs: window.__guard.snapshot().currentTimeMs,
          seekGeneration: window.__guard.snapshot().seekGeneration, sameRuntime: window.__guard.sameRuntime() }));
        add(`${theme}-drag-next-${repeated ? "same-id" : "new-id"}`, Boolean(gestureBox) && released.index === afterNext.index
          && released.seekGeneration === afterNext.seekGeneration && released.timeMs < afterNext.timeMs + 2000 && released.sameRuntime,
        JSON.stringify({ afterNext, released }));
        await stage.getByRole("button", { name: "暂停", exact: true }).click();
      }
      await page.evaluate(() => window.__guard.ready());
      await stage.getByRole("button", { name: /^播放模式：/ }).click();
      await page.getByRole("menuitemradio", { name: "列表循环", exact: true }).click();
      add(`${theme}-menu-stack`, await page.evaluate(() => window.__guard.snapshot().mode === "list-loop"), "官方 MediaButton 触发的模式菜单 portal 在舞台上可点");
      const queueTrigger = page.getByRole("button", { name: "播放队列", exact: true });
      await queueTrigger.focus();
      await queueTrigger.press("Enter");
      await page.locator('[data-slot="sheet-content"]').waitFor();
      await page.keyboard.press("Escape");
      await page.locator('[data-slot="sheet-content"]').waitFor({ state: "detached" });
      add(`${theme}-sheet-escape-keeps-stage`, await stage.isVisible(), "ESC 先关闭上层 Sheet，不关闭舞台");
      const logoutTrigger = page.getByRole("button", { name: "退出登录", exact: true });
      await logoutTrigger.focus();
      await logoutTrigger.press("Enter");
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });
      add(`${theme}-overlapping-overlays`, await stage.isVisible(), "舞台仍打开时键盘激活 Sheet/Dialog，指针可关闭上层，舞台保留");

      for (const status of ["empty", "failed", "loading", "unavailable"]) {
        await page.evaluate((value) => window.__guard.setLyrics(value), status);
        const notice = stage.getByRole("status");
        await notice.waitFor();
        const statusPixels = await textPixels(page, '[data-testid="playback-stage"] [role="status"]', theme, path.join(guardDir, `${theme}-${status}.png`));
        add(`${theme}-notice-${status}`, statusPixels.changed > 30 && (await notice.textContent())?.length > 0, JSON.stringify(statusPixels));
      }
      await page.evaluate(() => window.__guard.restoreLyrics());
      await page.emulateMedia({ reducedMotion: "reduce" });
      await stage.getByRole("button", { name: "播放", exact: true }).click();
      const reducedMotion = await stage.evaluate((element) => {
        const candidates = [element, ...element.querySelectorAll('[data-testid="playback-stage-cover"], [data-testid="playback-stage-cover"] *, [data-testid="playback-stage-player"] *, button[aria-label="关闭歌词"], button[aria-label="关闭歌词"] *')];
        const nonzero = (value) => value.split(",").some((duration) => Number.parseFloat(duration) > 0);
        const offenders = candidates.filter((node) => {
          const style = getComputedStyle(node);
          return nonzero(style.transitionDuration) || nonzero(style.animationDuration);
        }).map((node) => ({ tag: node.tagName, className: node.getAttribute("class"), transition: getComputedStyle(node).transitionDuration,
          animation: getComputedStyle(node).animationDuration }));
        return { reduce: matchMedia("(prefers-reduced-motion: reduce)").matches, checked: candidates.length, offenders };
      });
      add(`${theme}-reduced-motion-computed`, reducedMotion.reduce && reducedMotion.checked > 10
        && reducedMotion.offenders.length === 0, JSON.stringify(reducedMotion));
      await stage.getByRole("button", { name: "暂停", exact: true }).click();
      await page.setViewportSize({ width: 600, height: 900 });
      await page.waitForTimeout(1200);
      const portrait = await page.evaluate(() => {
        const cover = document.querySelector('[data-testid="playback-stage-cover"]')?.getBoundingClientRect();
        const lyric = document.querySelector('[data-testid="amll-lyrics-panel"]')?.getBoundingClientRect();
        return { cover: cover?.toJSON(), lyric: lyric?.toJSON(), scrollWidth: document.documentElement.scrollWidth };
      });
      const portraitInk = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-portrait-line.png`));
      add(`${theme}-official-portrait`, Boolean(portrait.cover && portrait.lyric && portrait.cover.width >= 40
        && portrait.cover.bottom <= portrait.lyric.y + 1 && portrait.lyric.width > 200
        && portrait.scrollWidth <= 600 && portraitInk.ink > 60), JSON.stringify({ ...portrait, ink: portraitInk.ink }));
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(() => window.__guard.setCoverFailure());
      await page.waitForTimeout(1200);
      const fallback = await stage.getByTestId("playback-stage-cover-fallback").count();
      const fallbackInk = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-cover-fallback-line.png`));
      add(`${theme}-cover-fallback`, fallback === 1 && fallbackInk.ink > 60, JSON.stringify({ fallback, ink: fallbackInk.ink }));
      await stage.getByRole("button", { name: "关闭歌词", exact: true }).click();
      await page.getByRole("button", { name: "播放队列", exact: true }).click();
      await page.locator('[data-slot="sheet-content"]').waitFor();
      await page.locator('[data-slot="sheet-close"]').click();
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached" });
      add(`${theme}-overlay-stack`, await page.getByRole("alertdialog").count() === 0 && await stage.count() === 0, "关闭舞台后 Sheet 打开/关闭、AlertDialog 打开/取消均可真点测");
    }

    await page.evaluate(() => window.__guard.restoreLyrics());
    await page.evaluate(() => window.__guard.desktopBeforeMount());
    await page.getByTestId("lyrics-window").waitFor();
    await page.waitForTimeout(900);
    const earlyDocument = await page.getByTestId("lyrics-window").textContent();
    add("desktop-early-document", earlyDocument?.includes("第一行歌词守卫"), "早于 React 挂载的文档丢失后，就绪握手须补回当前快照");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((choice) => window.__guard.setHostTheme(choice), theme);
      await page.evaluate(() => window.__guard.setDesktop(false));
      await page.getByTestId("lyrics-window").waitFor({ state: "detached" });
      await page.evaluate(() => {
        document.documentElement.className = "light";
        window.__guard.setDesktop(true);
      });
      await page.getByTestId("lyrics-window").waitFor();
      await page.waitForFunction((choice) => document.documentElement.classList.contains(choice)
        && document.querySelector('[data-testid="lyrics-window"]')?.textContent.includes("第一行歌词守卫"), theme);
      await page.waitForTimeout(900);
      const pixels = await textPixels(page, '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]', theme, path.join(guardDir, `${theme}-desktop-line.png`));
      add(`${theme}-desktop-text-pixels`, pixels.ink > 60, JSON.stringify(pixels));
      for (const status of ["empty", "failed"]) {
        await page.evaluate((value) => window.__guard.desktopDocument(value), status);
        await page.getByTestId("lyrics-window").getByRole("status").waitFor();
        const notice = await textPixels(page, '[data-testid="lyrics-window"] [role="status"]', theme, path.join(guardDir, `${theme}-desktop-${status}.png`));
        add(`${theme}-desktop-${status}`, notice.changed > 30, JSON.stringify(notice));
      }
    }
    add("no-runtime-errors", consoleErrors.length === 0 && pageErrors.length === 0,
      `console error ${consoleErrors.length} 条、pageerror ${pageErrors.length} 条${[...consoleErrors, ...pageErrors].slice(0, 3).map((text) => `\n      ${text.slice(0, 200)}`).join("")}`);
  } finally {
    await browser.close();
    server.close();
  }

  const pass = checks.filter((check) => check.ok).length;
  const fail = checks.filter((check) => !check.ok).length;
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
