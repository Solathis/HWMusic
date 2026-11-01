// `npm run docs:screenshots`：用演示数据给 README 拍三张图（主界面 / 播放页 / 设置「关于」），存到 docs/assets/screenshots/。
// 挂的是真的 App，夹具只在 Tauri IPC 边界；无头浏览器，不动鼠标键盘、不抢焦点，不联网、不用任何真实账号。
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { ROOT, chromiumCandidates, collectRendererCss } from "./test-browser.mjs";

export const SCREENSHOT_DIR = "docs/assets/screenshots";
export const SCREENSHOTS = ["main.png", "player.png", "settings.png"];
export const VIEWPORT = { width: 1280, height: 800 };
const DEMO_DIR = ".tmp/readme-demo";
const CDN = "https://music.dbankcdn.cn/demo";
const COVERS = [["#ff7a59", "#7b2ff7"], ["#2bc0e4", "#1e3c72"], ["#f7971e", "#c0392b"], ["#43cea2", "#185a9d"], ["#ee9ca7", "#6a3093"], ["#56ab2f", "#1d4350"]];

/** 演示用的原创歌词（不取任何真实歌曲的歌词）。 */
export const DEMO_LRC = [
  "[00:00.00]清晨的光落在窗台",
  "[00:06.00]风把昨天轻轻吹开",
  "[00:12.00]我们沿着河岸慢慢走",
  "[00:18.00]说起那些还没写完的歌",
  "[00:24.00]街角的灯一盏一盏亮起",
  "[00:30.00]远处有人在唱同一首歌",
  "[00:36.00]你说不必着急",
  "[00:42.00]把明天写进口袋",
  "[00:48.00]等夜色落下来",
  "[00:54.00]再一起回家",
  "[01:00.00]清晨的光落在窗台",
  "[01:06.00]风把昨天轻轻吹开",
].join("\n");

const TITLES = ["清晨的光", "河岸慢行", "街角的灯", "云层之上", "晚风来信", "旧城地图", "雨后操场", "海边的公交", "第七个夏天", "纸飞机", "慢慢走", "星期日下午", "长路", "远方来电", "夜航", "回家"];
const ARTISTS = ["演示歌手 A", "演示歌手 B", "演示乐队", "演示歌手 C"];

export function demoSongs() {
  return TITLES.map((name, index) => ({
    id: `demo-${index + 1}`,
    name,
    artists: ARTISTS[index % ARTISTS.length],
    album: `演示专辑 ${Math.floor(index / 4) + 1}`,
    duration: 180 + ((index * 37) % 90),
    coverUrl: `${CDN}/cover-${index % COVERS.length}.png`,
  }));
}

export function demoPlaylists() {
  return [["通勤路上", 42], ["周末慢歌", 28], ["深夜电台", 35], ["雨天", 19], ["跑步节奏", 24], ["收藏的现场", 16]].map(([name, songCount], index) => ({
    id: `demo-pl-${index + 1}`,
    name,
    songCount,
    kind: index < 4 ? "owned" : "collected",
    coverUrl: `${CDN}/cover-${(index + 2) % COVERS.length}.png`,
  }));
}

/** 演示页面的挂载源码（生成物，不入库）：真 App + 只在 IPC 边界的演示夹具。 */
export function demoHarnessSource({ version, tauriVersion }) {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { App } from "../../src/renderer/App.tsx";
import { getPlayerRuntime } from "../../src/renderer/features/playback/player-runtime.ts";
import { DEFAULT_LYRICS_CONFIG } from "../../src/renderer/features/lyrics/lyrics-window.mjs";

const SONGS = ${JSON.stringify(demoSongs())};
const PLAYLISTS = ${JSON.stringify(demoPlaylists())};
const LRC = ${JSON.stringify(DEMO_LRC)};
const PROFILE = { userName: "演示用户", avatarUrl: "${CDN}/avatar.png", vip: true, vipExpiresOn: "20270630235959" };
const SESSION_EXPIRES_AT = Date.now() + 6 * 86400000;
const APP_INFO = { version: ${JSON.stringify(version)}, tauriVersion: ${JSON.stringify(tauriVersion)}, webviewVersion: "131.0.2903.70", os: "windows", arch: "x86_64" };
let settingsData = {};
const page = (songs) => ({ songs, hasMore: false, skipped: 0, reportedTotal: songs.length });

mockWindows("main");
mockIPC(async (command, args) => {
  if (command === "core_renderer_ready") return 0;
  if (command === "core_get_tray_available") return true;
  if (command === "core_app_info") return APP_INFO;
  if (command === "core_login_chrome") return { theme: "light" };
  if (command === "core_lyrics_configure" || command === "core_lyrics_toggle") {
    return { config: { ...DEFAULT_LYRICS_CONFIG }, revision: 0, visible: false, taskbar: { supported: true, attached: false, reason: "disabled" } };
  }
  if (command === "core_lyrics_document") return emit("core:event", { channel: "lyrics:document", payload: args.document });
  if (command === "core_update_check") return { available: false, currentVersion: APP_INFO.version, version: null, notes: null, date: null };
  if (command === "core_get_autostart") return false;
  if (command === "core_read_run_log") return [];
  if (command === "core_local_base_url") return { baseUrl: "http://hwlocal.localhost" };
  if (command === "core_local_list") return { tracks: [], available: true };
  if (command === "core_main_chrome") return { frameless: false, maximized: false };
  if (command === "core_call") {
    switch (args.channel) {
      case "auth:get-status": return { loggedIn: true, busy: false, profile: PROFILE, sessionExpiresAt: SESSION_EXPIRES_AT };
      case "auth:cancel-qr": return { cancelled: true };
      case "settings:get": return { settings: { schemaVersion: 1, data: settingsData } };
      case "settings:set": settingsData = { ...settingsData, ...(args.payload?.patch ?? {}) }; return { settings: { schemaVersion: 1, data: settingsData } };
      case "library:favorites": return page(SONGS);
      case "library:playlists": return { playlists: PLAYLISTS, hasMore: false };
      case "library:playlist-detail": return page(SONGS.slice(0, 8));
      case "library:history": return page(SONGS.slice().reverse());
      case "library:search": return page(SONGS.slice(0, 6));
      case "playback:resolve-url": return { url: "${CDN}/audio.wav" };
      case "playback:lyrics": return { text: LRC };
      case "lyrics:cache-info": return { entries: 0, bytes: 0 };
      default: return null;
    }
  }
  return null;
}, { shouldMockEvents: true });

const runtime = getPlayerRuntime();
window.__demo = {
  play: () => runtime.player.playQueue(SONGS, 0),
  seek: (ms) => runtime.player.seek(ms),
  pause: () => runtime.player.pause(),
  snapshot: () => runtime.player.snapshot(),
};
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;
}

export function demoHarnessHtml() {
  return '<!doctype html>\n<html lang="zh-CN" class="light">\n  <head>\n    <meta charset="utf-8" />\n    <title>HWMusic 演示</title>\n    <link rel="stylesheet" href="./app.css" />\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="./demo.js"></script>\n  </body>\n</html>\n';
}

/** 演示音频：静音的 16 位单声道 WAV（够长，进度条看起来像一首真歌）。 */
export function silentWav(seconds = 240, rate = 8000) {
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function launch() {
  const failures = [];
  for (const candidate of chromiumCandidates()) {
    const options = { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] };
    if (candidate.executablePath) options.executablePath = candidate.executablePath;
    if (candidate.channel) options.channel = candidate.channel;
    try {
      return await chromium.launch(options);
    } catch (cause) {
      failures.push(`${candidate.kind}：${String(cause?.message ?? cause).split("\n")[0]}`);
    }
  }
  throw new Error(`没有可用的 Chromium：${failures.join("；")}`);
}

function serve(dir) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const server = createServer(async (request, response) => {
    const relative = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/+/, "") || "index.html";
    try {
      response.writeHead(200, { "content-type": types[path.extname(relative)] ?? "application/octet-stream" }).end(await readFile(path.join(dir, relative)));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function gradient([from, to], size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function takeScreenshots({ root = ROOT, log = console.log } = {}) {
  const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  const cargoLock = await readFile(path.join(root, "src-tauri", "Cargo.lock"), "utf8");
  const tauriVersion = cargoLock.slice(cargoLock.indexOf('name = "tauri"\n')).split("\n")[1].replace(/^version = "|"$/g, "");
  const cssFiles = await collectRendererCss(root);
  if (cssFiles.length === 0) throw new Error("out/renderer/assets 里没有 CSS：先跑 npm run build:web");

  const dir = path.join(root, DEMO_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "demo.tsx"), demoHarnessSource({ version, tauriVersion }), "utf8");
  await writeFile(path.join(dir, "index.html"), demoHarnessHtml(), "utf8");
  await writeFile(path.join(dir, "app.css"), (await Promise.all(cssFiles.map((file) => readFile(file, "utf8")))).join("\n"), "utf8");
  const built = await esbuild.build({
    absWorkingDir: root, entryPoints: [`${DEMO_DIR}/demo.tsx`], outfile: `${DEMO_DIR}/demo.js`, bundle: true, format: "esm", platform: "browser",
    target: "chrome120", jsx: "automatic", loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning",
  });
  if (built.errors.length > 0) throw new Error(`演示页面构建失败：${JSON.stringify(built.errors)}`);

  const out = path.join(root, SCREENSHOT_DIR);
  await mkdir(out, { recursive: true });
  const server = await serve(dir);
  const browser = await launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: "light", deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [index, colors] of COVERS.entries()) {
      const body = await gradient(colors, 512);
      await page.route(`${CDN}/cover-${index}.png`, (route) => route.fulfill({ contentType: "image/png", body, headers: { "access-control-allow-origin": "*" } }));
    }
    const avatar = await gradient(["#8e9eab", "#4b6cb7"], 128);
    await page.route(`${CDN}/avatar.png`, (route) => route.fulfill({ contentType: "image/png", body: avatar, headers: { "access-control-allow-origin": "*" } }));
    const audio = silentWav();
    await page.route(`${CDN}/audio.wav`, (route) => {
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", body: audio.subarray(start, end + 1), headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${audio.length}` } : {}) } });
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__demo !== undefined);
    await page.getByRole("button", { name: "我的收藏", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="favorites-page"] tbody tr').length >= 10
      && document.querySelectorAll('[data-testid="sidebar-playlist-item"]').length >= 5);
    await page.evaluate(() => window.__demo.play());
    await page.waitForFunction(() => window.__demo.snapshot().status === "playing" && window.__demo.snapshot().durationMs > 0);
    await page.evaluate(() => { window.__demo.pause(); window.__demo.seek(45000); });
    await page.waitForFunction(() => window.__demo.snapshot().status === "paused" && Math.abs(window.__demo.snapshot().currentTimeMs - 45000) < 1000);
    await page.waitForTimeout(800);
    const shot = (name) => page.screenshot({ path: path.join(out, name), type: "png" });
    await shot("main.png");

    await page.getByRole("button", { name: "打开歌词", exact: true }).click();
    await page.getByTestId("playback-stage").waitFor();
    await page.waitForTimeout(2500);
    await shot("player.png");
    await page.getByTestId("playback-stage-close-row").click();
    await page.getByTestId("playback-stage").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByTestId("settings-page").getByRole("tab", { name: "关于", exact: true }).click();
    await page.waitForFunction((wanted) => document.querySelector('dd[data-testid="about-version"]')?.textContent === wanted, version);
    await page.waitForTimeout(400);
    await shot("settings.png");
  } finally {
    await browser.close();
    server.close();
  }
  if (errors.length > 0) throw new Error(`演示页面有运行时错误：${errors.slice(0, 3).join(" | ")}`);
  for (const name of SCREENSHOTS) {
    const file = path.join(out, name);
    const png = await sharp(file).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    await writeFile(file, png);
    log(`  ${path.relative(root, file)}（${png.length} 字节）`);
  }
  return SCREENSHOTS.map((name) => path.join(out, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  takeScreenshots()
    .then(() => console.log("docs:screenshots 完成：三张截图都用演示数据"))
    .catch((cause) => {
      console.error(`docs:screenshots 失败：${cause.message}`);
      process.exit(1);
    });
}
