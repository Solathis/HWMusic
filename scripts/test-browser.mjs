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

/**
 * R45A3 的库列表分页夹具（脚本与守卫页共用同一份常量，避免两边各写一套数字）。
 *
 * - `total`/`pageSize`：歌单/专辑/搜索的假后端总量与页大小（首屏只该拿到一页）；
 * - `slowKeyword`/`slowDelayMs`：慢关键字（换关键词时用来制造"旧查询迟到"）；
 * - `shortKeyword`/`shortTotal`/`shortPerPage`：短列表（每页 2 首、总共 4 首），
 *   用来量"哨兵一直在视口里也不许自己连拉"。
 */
export const PAGINATION_FIXTURE = Object.freeze({
  total: 120,
  pageSize: 50,
  slowKeyword: "慢",
  slowDelayMs: 700,
  shortKeyword: "短",
  shortTotal: 4,
  shortPerPage: 2,
});

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
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { LibraryShell } from "../../src/renderer/App.tsx";
import { LyricsWindow } from "../../src/renderer/LyricsWindow.tsx";
import { TooltipProvider } from "../../src/renderer/components/ui/tooltip.tsx";
import { getPlayerRuntime } from "../../src/renderer/features/playback/player-runtime.ts";
import { DEFAULT_LYRICS_CONFIG } from "../../src/renderer/features/lyrics/lyrics-window.mjs";
import { guardMusicApi, playlistProbe } from "./protocol-fixture.mjs";

const LRC = ${JSON.stringify(FIXTURE_LRC)};
let currentTheme = "light";
const songs = Array.from({ length: 36 }, (_, index) => ({
  id: String(index + 1), name: "浏览器守卫曲目 " + (index + 1), artists: "守卫艺人", album: "守卫专辑", duration: 12,
  coverUrl: "https://music.dbankcdn.cn/guard-cover-" + (index % 2 === 0 ? "warm" : "cool") + ".png",
}));
let desktopConfig = { ...DEFAULT_LYRICS_CONFIG };
let desktopRevision = 0;
let settingsData = {};
let dragCalls = 0;
const mediaActions = [];
/**
 * R45A3：库列表分页的夹具。三件事必须能在真浏览器里量到：
 * - 一页只取一次（每次 core_call 的频道/页号记进 libraryCalls）；
 * - 首屏不是全部（歌单/专辑 120 首、每页 50）；
 * - 失败可重试、换关键词丢旧响应、短列表不自动连拉。
 */
const PAGED_TOTAL = 120;
const libraryCalls = [];
let albumFailuresLeft = 1;
const SLOW_KEYWORD = ${JSON.stringify(PAGINATION_FIXTURE.slowKeyword)};
const SLOW_SEARCH_MS = ${PAGINATION_FIXTURE.slowDelayMs};
const SHORT_KEYWORD = ${JSON.stringify(PAGINATION_FIXTURE.shortKeyword)};
const GUARD_PLAYLISTS = [
  { id: "PL-1", name: "守卫歌单", songCount: PAGED_TOTAL, coverUrl: "https://music.dbankcdn.cn/guard-cover-warm.png" },
  { id: "PL-REPEAT", name: "重复页守卫歌单", songCount: 50, coverUrl: "https://music.dbankcdn.cn/guard-cover-cool.png" },
];
function guardTracks(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: prefix + "-" + (index + 1),
    name: prefix + "曲目 " + (index + 1),
    artists: "守卫艺人", artistId: "AR-1",
    album: "守卫专辑", albumId: "AL-1",
    duration: 180 + (index % 60),
    coverUrl: null,
  }));
}
function pagedAnswer(channel, payload, prefix, options) {
  const total = options?.total ?? PAGED_TOTAL;
  const requestedPage = Math.max(1, Number(payload?.page ?? 1) || 1);
  const pageSize = Math.max(1, Number(payload?.pageSize ?? 50) || 50);
  const perPage = options?.perPage ?? pageSize;
  libraryCalls.push({ channel, page: requestedPage, pageSize, keyword: payload?.keyword ?? null });
  const start = (requestedPage - 1) * perPage;
  return {
    songs: guardTracks(prefix, total).slice(start, Math.min(start + perPage, total)),
    skipped: 0,
    reportedTotal: total,
    // 后端明说的"还有"：页面不许自己从条数猜
    hasMore: start + perPage < total,
  };
}
mockWindows("main");
mockIPC(async (command, args) => {
  if (command === "core_call") {
    switch (args.channel) {
      case "settings:get": return { settings: { schemaVersion: 1, data: settingsData } };
      case "settings:set": settingsData = { ...settingsData, ...args.payload.patch }; return { settings: { schemaVersion: 1, data: settingsData } };
      case "library:favorites": return { songs, hasMore: false, skipped: 0, reportedTotal: songs.length };
      case "library:playlists": return { playlists: GUARD_PLAYLISTS, hasMore: false };
      case "library:playlist-detail": {
        /**
         * R45A3 复审：这条**不再**由夹具自己切片——它走**真协议层**（src/protocols/music.mjs），
         * 上游是"永远忽略 start/limit、每次回整张 120 首"的假服务端（真接口的实测行为）。
         * 于是本地切片、hasMore、整份只取一次这些结论只可能来自被测代码本身。
         */
        const page = Math.max(1, Number(args.payload?.page ?? 1) || 1);
        const pageSize = Math.max(1, Number(args.payload?.pageSize ?? 50) || 50);
        const playlistId = String(args.payload?.playlistId ?? "PL-1");
        libraryCalls.push({ channel: "library:playlist-detail", page, pageSize, keyword: null, playlistId });
        // 第 2 页起慢一点：请求在途期间重复触发的去重才量得到
        if (page > 1) await new Promise((resolve) => setTimeout(resolve, 250));
        const answer = await guardMusicApi.getPlaylistDetail(playlistId, { page, pageSize });
        if (!answer.ok) throw answer.error;
        return answer.data;
      }
      case "library:album": {
        if (albumFailuresLeft > 0) {
          albumFailuresLeft -= 1;
          libraryCalls.push({ channel: "library:album", page: Number(args.payload?.page ?? 1) || 1, pageSize: Number(args.payload?.pageSize ?? 50) || 50, keyword: null });
          throw new Error("守卫专辑接口故意失败一次");
        }
        return pagedAnswer("library:album", args.payload, "专辑");
      }
      case "library:search": {
        const keyword = String(args.payload?.keyword ?? "");
        // 关键字「短」：后端只有 4 首、每页只给 2 首（列表比屏幕短，但确实还有下一页）
        if (keyword === SHORT_KEYWORD) {
          return pagedAnswer("library:search", args.payload, "搜索短", { total: ${PAGINATION_FIXTURE.shortTotal}, perPage: ${PAGINATION_FIXTURE.shortPerPage} });
        }
        const answer = pagedAnswer("library:search", args.payload, "搜索" + keyword);
        if (keyword === SLOW_KEYWORD) await new Promise((resolve) => setTimeout(resolve, SLOW_SEARCH_MS));
        return answer;
      }
      case "library:artist": {
        // 后端不分页：一次响应就是全部（协议层固定 hasMore:false）
        libraryCalls.push({ channel: "library:artist", page: 1, pageSize: 0, keyword: null });
        return { artistId: "AR-1", songs: guardTracks("歌手", PAGED_TOTAL) };
      }
      case "library:history": {
        libraryCalls.push({ channel: "library:history", page: 1, pageSize: 50, keyword: null });
        return { songs: guardTracks("历史", PAGED_TOTAL), hasMore: false, skipped: 0, reportedTotal: PAGED_TOTAL };
      }
      case "playback:resolve-url": return { url: "https://music.dbankcdn.cn/guard.wav" };
      case "playback:lyrics": return { text: LRC };
      default: throw new Error("未提供守卫 IPC：" + args.channel);
    }
  }
  if (command === "plugin:window|start_dragging") { dragCalls += 1; return; }
  if (command === "core_get_tray_available") return true;
  if (command === "core_login_chrome") return { theme: currentTheme };
  if (command === "core_lyrics_document") return emit("core:event", { channel: "lyrics:document", payload: args.document });
  if (command === "core_lyrics_progress") return emit("core:event", { channel: "lyrics:progress", payload: args.progress });
  if (command === "core_lyrics_control") {
    mediaActions.push(args.payload.action);
    return emit("core:event", { channel: "player:command", payload: { command: args.payload.action } });
  }
  if (command === "core_lyrics_configure") {
    if ((!args.restoreIfPristine || desktopRevision === 0) && Object.keys(args.config).length) {
      desktopConfig = { ...desktopConfig, ...args.config }; desktopRevision += 1;
      await emit("core:event", { channel: "lyrics:state", payload: { config: desktopConfig, revision: desktopRevision, visible: false } });
    }
    return { config: desktopConfig, revision: desktopRevision, visible: false };
  }
  if (command === "core_lyrics_toggle") return { config: desktopConfig, revision: desktopRevision, visible: args.checked };
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
      dragCount: () => dragCalls,
      mediaActions: () => mediaActions.slice(),
      /** R45A3：库列表分页的调用记录（频道/页号/页大小/关键字），"一页只取一次"按它判。 */
      libraryCalls: () => libraryCalls.slice(),
      resetLibraryCalls: () => { libraryCalls.length = 0; },
      /** R45A3 复审：**假上游**（每次都回整张歌单）的请求记录——"整份只取一次"按它判。 */
      playlistFetches: () => playlistProbe.fetches(),
      resetPlaylistFetches: () => { playlistProbe.reset(); },
      queueLength: () => runtime.player.snapshot().entries.length,
      pause: () => runtime.player.pause(),
      desktopConfig: () => desktopConfig,
      async configureDesktop(patch) {
        const { coreLyricsConfigure } = await import("../../src/renderer/host-api.ts");
        return coreLyricsConfigure(patch);
      },
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
      async desktopPlaying(playing) {
        await emit("core:event", { channel: "lyrics:progress", payload: { timeMs: 700, playing, seekGeneration: 100 } });
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
 * R45A1（复审）：启动三态的**真浏览器**验收页（独立入口，挂的是真 `App`）。
 *
 * 为什么必须另开一页：主守卫页挂的是 `LibraryShell`（登录之后那一块），它根本不经过
 * `startupViewOf` 那三道门。而这一项要证的正是"**第一帧画什么**"——只有真 `App` +
 * 真 `useAuthGate` + 真 IPC 边界才能把它量出来。
 *
 * IPC 只给门禁需要的那几条；两种模式（`?startup=fail` / `?startup=logged-in`）：
 * - `fail`：第一次 `auth:get-status` **故意失败**（延迟 400ms 再抛，让"还不知道"那一屏
 *   真的出现在屏幕上），第二次（用户点「重新检查登录状态」）才答 `loggedIn:false`
 *   → 登录页 + 二维码自动发起**恰好一次**；
 * - `logged-in`：第一次就答 `loggedIn:true` → app-shell，且**一张码都不建**。
 *
 * 计数（`window.__startupGuard`）是断言的核心：`auth:get-status` 次数证明"重试真的重发了"，
 * `auth:qr-start` 次数证明"二维码只在确定未登录之后才建、且只建一次"。
 */
export function startupHarnessSource() {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { App } from "../../src/renderer/App.tsx";

/** 查询失败那一档的延迟：把"还不知道"那一屏真的拉到屏幕上（否则它可能在第一次采样前就过去了）。 */
const FIRST_STATUS_DELAY_MS = 400;
const mode = new URLSearchParams(location.search).get("startup") === "logged-in" ? "logged-in" : "fail";
const counters = { statusQueries: 0, qrStarts: 0, rendererReady: 0, qrStartAt: null };
window.__startupGuard = { mode, counters };

mockWindows("main");
mockIPC(async (command, args) => {
  if (command === "core_renderer_ready") { counters.rendererReady += 1; return 0; }
  if (command === "core_get_tray_available") return false;
  if (command === "core_login_chrome") return { theme: "light" };
  if (command === "core_lyrics_configure") return { config: {}, revision: 0, visible: false };
  if (command === "core_lyrics_toggle") return { config: {}, revision: 0, visible: false };
  if (command === "core_lyrics_document") return emit("core:event", { channel: "lyrics:document", payload: args.document });
  if (command === "core_call") {
    switch (args.channel) {
      case "auth:get-status": {
        counters.statusQueries += 1;
        const first = counters.statusQueries === 1;
        if (mode === "fail" && first) {
          await new Promise((resolve) => setTimeout(resolve, FIRST_STATUS_DELAY_MS));
          throw { message: "未知请求频道：auth:get-status", kind: "unknown_channel" };
        }
        return { loggedIn: mode === "logged-in", busy: false };
      }
      case "auth:qr-start": {
        counters.qrStarts += 1;
        if (counters.qrStartAt === null) counters.qrStartAt = Math.round(performance.now());
        return { content: "https://example.invalid/qrcode/login.jsp?guard=1", expiresInMs: 181000 };
      }
      case "auth:login": return null;
      case "settings:get": return { settings: { schemaVersion: 1, data: {} } };
      case "library:favorites": return { songs: [], hasMore: false, skipped: 0, reportedTotal: 0 };
      case "library:playlists": return { playlists: [], hasMore: false };
      default: throw new Error("未提供启动守卫 IPC：" + args.channel);
    }
  }
  throw new Error("未提供启动守卫命令：" + command);
}, { shouldMockEvents: true });

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;
}

/** 启动守卫页面（生成物，不入库）。 */
export function startupHarnessHtml() {
  return `<!doctype html>
<html lang="zh-CN" class="light">
  <head>
    <meta charset="utf-8" />
    <title>启动三态浏览器守卫</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./startup.js"></script>
  </body>
</html>
`;
}

/**
 * R45A1（复审）：启动三态的**真浏览器**行为验收。
 *
 * 钉四件事（对应复审 brief 的测试行为清单）：
 * 1. 首帧（`checking`，状态查询还没落地）**没有**登录页/二维码/任何按钮；
 * 2. 查询失败之后仍是中性启动屏：没有 LoginGate/二维码，但原因、重试、网页登录都在；
 * 3. 点「重新检查登录状态」= **真的再发一次 `auth:get-status`**（计数 +1），
 *    并且答案是未登录之后才出现登录页、二维码**恰好建一次**；
 * 4. 已登录的会话：直接 app-shell，登录页出现 0 次、二维码 0 次。
 */
export async function checkStartupGate(page, port, guardDir, add) {
  /**
   * 登录页/二维码的节点数（**复审 R45A1 的判据**）：
   * 二维码容器、画布、遮蔽层、以及那条标题文案——这些在 `checking` 里一个都不许有。
   *
   * 「在网页中打开登录」**不算**：失败档上它必须存在（那是两条出路之一，brief 点名要的）。
   */
  const loginNodes = () =>
    page.evaluate(
      () =>
        document.querySelectorAll(
          '[data-testid="login-qr-refresh"],[data-testid="login-qr"],[data-testid="login-qr-mask"],canvas',
        ).length + (document.body.textContent?.includes("华为账号登录") ? 1 : 0),
    );
  const counters = () => page.evaluate(() => ({ ...window.__startupGuard.counters }));
  const buttonCount = () =>
    page.evaluate(
      () => [...document.querySelectorAll("button")].filter((node) => node.getClientRects().length > 0).length,
    );

  // ——— ① 失败 → 重试 → 确定未登录 ———
  await page.goto(`http://127.0.0.1:${port}/startup.html?startup=fail`, { waitUntil: "load" });
  await page.getByTestId("startup-checking").waitFor();
  // 首帧：状态查询在飞（400ms 后才失败），屏上只有一枚转圈
  const firstFrame = {
    buttons: await buttonCount(),
    loginNodes: await loginNodes(),
    text: ((await page.getByTestId("startup-checking").textContent()) ?? "").trim(),
    counters: await counters(),
  };
  add(
    "startup-first-frame-quiet",
    firstFrame.buttons === 0 && firstFrame.loginNodes === 0 && firstFrame.text === "" && firstFrame.counters.qrStarts === 0,
    JSON.stringify(firstFrame),
  );

  // ② 查询失败：还是同一屏，但原因与两个动作都在；二维码仍然 0 次
  await page.getByTestId("startup-retry-status").waitFor();
  const failed = {
    stillStartup: (await page.getByTestId("startup-checking").count()) === 1,
    loginGate: await page.getByTestId("login-qr-refresh").count(),
    loginNodes: await loginNodes(),
    notice: ((await page.getByTestId("startup-notice").textContent()) ?? "").trim(),
    buttons: await buttonCount(),
    webEntry: await page.getByTestId("login-open-web").count(),
    counters: await counters(),
  };
  add(
    "startup-failed-check-stays-neutral",
    failed.stillStartup &&
      failed.loginGate === 0 &&
      failed.loginNodes === 0 &&
      failed.webEntry === 1 &&
      failed.buttons === 2 &&
      failed.notice.includes("查询登录状态失败") &&
      failed.counters.qrStarts === 0,
    JSON.stringify(failed),
  );
  await page.screenshot({ path: path.join(guardDir, "startup-failed-check.png") });

  // ③ 点重试：真的再问一次 auth:get-status；答案是未登录 → 登录页 + 二维码恰好一次
  const beforeRetry = await counters();
  await page.getByTestId("startup-retry-status").click();
  await page.getByTestId("login-qr-refresh").waitFor();
  await page.waitForTimeout(900);
  const afterRetry = await counters();
  add(
    "startup-retry-requeries-status",
    afterRetry.statusQueries === beforeRetry.statusQueries + 1,
    JSON.stringify({ beforeRetry, afterRetry }),
  );
  add(
    "startup-logged-out-then-login-gate-once",
    afterRetry.qrStarts === 1 && (await page.getByTestId("startup-checking").count()) === 0,
    JSON.stringify({ counters: afterRetry, startupScreens: await page.getByTestId("startup-checking").count() }),
  );
  await page.screenshot({ path: path.join(guardDir, "startup-logged-out.png") });

  // ——— ④ 已登录的会话：app-shell，一张码都不建 ———
  await page.goto(`http://127.0.0.1:${port}/startup.html?startup=logged-in`, { waitUntil: "load" });
  await page.locator('[data-shell="app-shell"]').waitFor();
  await page.waitForTimeout(500);
  const loggedIn = {
    loginNodes: await loginNodes(),
    loginGate: await page.getByTestId("login-qr-refresh").count(),
    startupScreens: await page.getByTestId("startup-checking").count(),
    counters: await counters(),
  };
  add(
    "startup-logged-in-app-shell-no-qr",
    loggedIn.loginNodes === 0 && loggedIn.loginGate === 0 && loggedIn.startupScreens === 0 && loggedIn.counters.qrStarts === 0,
    JSON.stringify(loggedIn),
  );
}

/**
 * R45A3（复审）：歌单详情的**真协议边界**夹具说明。
 *
 * 上一版的 browser 夹具自己按 page/pageSize 切片（`pagedAnswer`）——那等于把"服务端已经
 * 替我们分好页"当成事实，协议层的本地切片路径一次都没被跑到。复审后的夹具是**两个东西**：
 *
 * 1. 假上游（`guardPlaylistFetch`）：**永远忽略 `start`/`limit`，每次都回整张 120 首**
 *    （真接口 2026-10-23 的实测行为）；
 * 2. 真协议层（`createMusicApi`，从 `src/protocols/music.mjs` 直接打进来）：归一化 +
 *    "整份响应缓存 + 按页本地切片"全都在浏览器里真的跑。
 *
 * 于是 `library:playlist-detail` 这条 IPC 的载荷进的是**真协议层**，页面拿到的
 * `hasMore`/切片条数只可能来自它；假上游的请求次数（`playlistFetches`）证明"整份只取了一次"。
 */
export function protocolPlaylistFixtureSource() {
  return `import { createMusicApi } from "../../src/protocols/music.mjs";

const WIRE_TOTAL = ${PAGINATION_FIXTURE.total};
const REPEAT_TOTAL = ${PAGINATION_FIXTURE.pageSize};
const wireSongs = Array.from({ length: WIRE_TOTAL }, (_, index) => ({
  contentID: "PL-1-" + (index + 1),
  contentName: "歌单曲目 " + (index + 1),
  contentType: "1",
  artistName: "守卫艺人",
  artistID: "AR-1",
  albumName: "守卫专辑",
  albumID: "AL-1",
  duration: "180",
  contentExInfo: JSON.stringify({ fileInfos: [{ quality: "1", format: "MP3", fileType: "1", duration: String(180 + (index % 60)) }] }),
}));
const repeatWireSongs = Array.from({ length: REPEAT_TOTAL }, (_, index) => ({
  contentID: "PL-REPEAT-" + (index + 1),
  contentName: "重复页曲目 " + (index + 1),
  contentType: "1",
  artistName: "守卫艺人",
  artistID: "AR-1",
  albumName: "守卫专辑",
  albumID: "AL-1",
  duration: "180",
}));

/** 假上游的请求记录：主歌单整份只取一次；重复页歌单每次返回同一个完整页。 */
const playlistFetches = [];
async function guardPlaylistFetch(url, init) {
  playlistFetches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  const playlistId = new URL(url).searchParams.get("playListID") ?? "PL-1";
  const repeated = playlistId === "PL-REPEAT";
  const body = {
    result: { resultCode: "000000" },
    playListInfoEx: {
      playListInfo: {
        contentID: playlistId,
        contentName: repeated ? "重复页守卫歌单" : "守卫歌单",
        totalCount: String(repeated ? REPEAT_TOTAL : WIRE_TOTAL),
      },
      playListSongInfoList: repeated ? repeatWireSongs : wireSongs,
    },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export const guardMusicApi = createMusicApi({
  endpoints: {
    playlistDetail: "https://example.invalid/api/playlist/detail/all",
    playlistDetailPublic: "https://example.invalid/api/playlist/public",
  },
  fetchImpl: guardPlaylistFetch,
  session: { token: "GUARD-TOKEN", snsUserID: "GUARD-SNS" },
});

/** 供守卫页读的两件事：假上游请求记录、协议层返回的最后一页形态。 */
export const playlistProbe = {
  fetches: () => playlistFetches.slice(),
  reset: () => { playlistFetches.length = 0; },
};
`;
}

/** 渲染层产物里的 CSS（Tailwind 产出 + 设计令牌 + AMLL 官方样式）。
 *
 * 守卫**必须**用真样式：`AmllLyricsPanel` 的外层是 `absolute inset-0`，没有样式就没有尺寸，
 * "面板挂上了"会变成"面板高 0"——那种失败信息会把人引到错误的方向。
 */export async function collectRendererCss(root = ROOT) {
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

export async function checkDesktopSurface(page, guardDir, add) {
  const desktop = page.getByTestId("lyrics-window");
  await page.evaluate(() => window.__guard.desktopDocument());
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => {
      window.__guard.setHostTheme(choice);
      document.documentElement.className = choice;
    }, theme);
    await page.setViewportSize({ width: 960, height: 160 });
    await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop", style: "panel", color: "contrast", locked: false }));
    await page.waitForTimeout(700);
    const pixels = await textPixels(page, '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]', theme, path.join(guardDir, `${theme}-panel-contrast.png`));
    const rawColor = await page.evaluate(() => window.__guard.desktopConfig().color);
    add(`${theme}-panel-contrast-ink`, pixels.ink > 60 && pixels.changed > 60 && rawColor === "contrast", JSON.stringify({ ...pixels, rawColor }));
    await page.setViewportSize({ width: 960, height: 44 });
    for (const style of ["clean", "panel"]) {
      for (const showControls of [true, false]) {
        await page.evaluate((config) => window.__guard.configureDesktop(config), { mode: "taskbar", style, showControls, color: "foreground" });
        await page.waitForTimeout(120);
        const box = await desktop.locator(".amll-lyric-player").boundingBox();
        add(`${theme}-taskbar-${style}-${showControls}`, await desktop.locator("button").count() === 0 && box?.height === 44,
          JSON.stringify({ box, buttons: await desktop.locator("button").count() }));
      }
    }
  }
  await page.setViewportSize({ width: 960, height: 160 });
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop", style: "clean", color: "foreground", showControls: true }));
}

/**
 * R45A3：库列表触底分页的**真浏览器**验收（mockIPC 边界给夹具，组件与样式都是真的）。
 *
 * 钉七件事，每一件都是"看起来在分页、其实在撒谎"的地方：
 * 1. 首屏只有第一页（歌单 120 首只拿到 50，状态行说"已加载 50 首"，头部说"共 120 首"）；
 * 2. 没有用户手势时**一页都不多取**（不许自动连拉）；
 * 3. 触底只发一次第 2 页：请求在途期间再滚三次也被吞掉（正在请求不重复发）；
 * 4. 每页完成后要用户再次接近底部才取第 3 页；没有下一页之后哨兵消失、不再催滚动；
 * 5. "播放全部"只把**已加载**的 50 首放进队列；
 * 6. 专辑页第一次失败给出可点的重试，第二次成功（失败不自动重试、也不丢页面）；
 * 7. 换关键词时旧查询的迟到响应被丢掉；歌手/历史后端不分页，只本地分批且明说"1 次网络请求"。
 *
 * 滚动都是**真滚轮**（`page.mouse.wheel`）：程序化改 scrollTop 证明不了"用户滚到底"这件事。
 */
export async function checkLibraryPagination(page, guardDir, add) {
  /**
   * 收藏页是**常驻挂载**的（切走只是 hidden），它的曲目表也在 DOM 里——所以一切选择器都要
   * 限定在"当前可见的那张表"，否则会把收藏页那 36 行算进歌单的 50 行里。
   */
  const table = page.locator('[data-testid="track-table"]:visible');
  const rowCount = () => table.locator("tbody tr").count();
  const visibleRowsIn = (expected) =>
    page.waitForFunction(
      (rows) => [...document.querySelectorAll('[data-testid="track-table"]')]
        .filter((node) => node.getClientRects().length > 0)
        .reduce((total, node) => total + node.querySelectorAll("tbody tr").length, 0) === rows,
      expected,
      { timeout: 15_000 },
    );
  const statusText = async () => ((await page.getByTestId("list-pagination-status").textContent().catch(() => "")) ?? "");
  const sentinelCount = () => page.getByTestId("list-pagination-sentinel").count();
  const calls = async () => page.evaluate(() => window.__guard.libraryCalls());
  const callsOf = async (channel) => (await calls()).filter((call) => call.channel === channel);
  const failure = page.getByTestId("list-pagination-failure");
  /** 指针落在内容区中间：滚轮才会滚应用内容层（而不是侧栏或播放栏） */
  const wheelContent = async (deltaY) => {
    await page.mouse.move(720, 360);
    await page.mouse.wheel(0, deltaY);
  };
  /** 回到内容区顶部（切页时会继承上一页的滚动位置） */
  const scrollToTop = async () => {
    await page.evaluate(() => {
      const target = document.querySelector('[data-guard-scroll-root="1"]');
      if (target) target.scrollTop = 0;
    });
    await page.waitForTimeout(150);
  };

  // 侧栏窄轨里没有导航文案：先展开
  if (await page.getByTestId("sidebar-search-rail").count()) await page.getByTestId("sidebar-search-rail").click();
  await page.evaluate(() => window.__guard.resetLibraryCalls());
  // 假上游（每次都回整张歌单的那个）的请求记录也要从零开始：这一项的判据之一是"整份只取一次网络"
  await page.evaluate(() => window.__guard.resetPlaylistFetches());
  await page.getByRole("button", { name: "我的歌单", exact: true }).click();
  await page.getByTestId("playlist-grid").waitFor();
  await page.getByRole("button", { name: "打开", exact: true }).first().click();
  await page.getByTestId("playlist-detail").waitFor();
  const firstPageLoaded = await visibleRowsIn(50).then(() => true).catch(() => false);
  if (!firstPageLoaded) {
    const diagnostic = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-testid="track-table"]')]
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => node.querySelectorAll("tbody tr").length),
      skeletons: document.querySelectorAll('[data-testid="list-skeleton"]').length,
      statuses: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent?.slice(0, 60)),
      calls: window.__guard.libraryCalls(),
    }));
    add("pagination-first-page", false, JSON.stringify(diagnostic));
    return;
  }

  // ① 首屏只有第一页：一页一页取，122 首不许在这一步就全来
  const firstCalls = await callsOf("library:playlist-detail");
  const firstRows = await rowCount();
  const firstStatus = await statusText();
  const detailText = (await page.getByTestId("playlist-detail").textContent()) ?? "";
  add("pagination-first-page-only", firstCalls.length === 1 && firstCalls[0].page === 1
    && firstCalls[0].pageSize === PAGINATION_FIXTURE.pageSize && firstRows === 50
    && firstStatus.includes("已加载 50 首") && firstStatus.includes("继续向下滚动")
    && detailText.includes("共 120 首 · 已加载 50 首"),
  JSON.stringify({ firstCalls, firstRows, firstStatus, header: detailText.slice(0, 40) }));

  /**
   * ①b 这一页是**本地切片**，并且"整份只取了一次网络"（R45A3 fix1）。
   *
   * 关键在夹具的形状：`library:playlist-detail` 的 IPC 走的是**真协议层**（`guardMusicApi`），
   * 它背后的假上游**永远忽略 `start`/`limit`、每次都回整张 120 首**（真接口的实测行为）。
   * 所以下面这两个数字不可能来自"夹具替我们分好了页"：
   * - `playlistFetches()` = 假上游被调用的次数 → 整份只取一次网络；
   * - 界面那句话说的 `pageSource=local-slice` → 这一页是本地切片（不是服务端分页）。
   */
  const sliceNotice = ((await page.getByTestId("playlist-local-slice").textContent().catch(() => "")) ?? "").trim();
  const firstFetches = await page.evaluate(() => window.__guard.playlistFetches());
  add("pagination-first-page-is-local-slice", firstFetches.length === 1
    && sliceNotice.includes("本地切片") && sliceNotice.includes("120 首")
    && sliceNotice.includes("不再发网络请求") && sliceNotice.includes("不减少流量")
    && sliceNotice.includes("已显示 50 首"),
  JSON.stringify({ fetches: firstFetches.length, sliceNotice }));

  // ② 没人动它就不许自己取第 2 页（"不无限自动连续请求"）
  await page.waitForTimeout(800);
  const idleCalls = await callsOf("library:playlist-detail");
  add("pagination-no-auto-chain", idleCalls.length === 1 && (await rowCount()) === 50,
    JSON.stringify({ pages: idleCalls.map((call) => call.page) }));

  // ③ "播放全部"只作用于**已加载**的 50 首（不许把队列当成整张歌单）
  await page.getByRole("button", { name: "播放全部", exact: true }).click();
  await page.waitForFunction(() => window.__guard.queueLength() === 50, null, { timeout: 5000 }).catch(() => {});
  const queued = await page.evaluate(() => window.__guard.queueLength());
  await page.evaluate(() => window.__guard.pause());
  add("pagination-play-all-loaded-only", queued === 50, `队列 ${queued} 首（页面只加载了 50 首）`);

  // ④ 滚动根就是应用内容区那一层（不是页面自己造的滚动容器）
  const root = await page.evaluate(() => {
    const sentinel = document.querySelector('[data-testid="list-pagination-sentinel"]');
    let node = sentinel?.parentElement ?? null;
    while (node) {
      const style = getComputedStyle(node);
      if (style.overflowY === "auto" || style.overflowY === "scroll") break;
      node = node.parentElement;
    }
    if (!node) return { found: false };
    node.setAttribute("data-guard-scroll-root", "1");
    return {
      found: true,
      // 页面自己的 div（playlist-detail）里**不该**有滚动容器：根必须在它外面
      outsidePage: node.closest('[data-testid="playlist-detail"]') === null,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    };
  });
  add("pagination-scroll-root-is-content", root.found && root.outsidePage && root.scrollHeight > root.clientHeight,
    JSON.stringify(root));

  // ⑤ 真滚到底：只发第 2 页一次；在途期间重复触发（滚轮 + scrollTop 连击）必须被吞掉
  await wheelContent(8000);
  const burst = await page.evaluate(() => {
    const target = document.querySelector('[data-guard-scroll-root="1"]');
    if (!target) return 0;
    let fired = 0;
    for (let index = 0; index < 3; index += 1) {
      target.scrollTop = target.scrollHeight;
      target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 900 }));
      fired += 1;
    }
    return fired;
  });
  await visibleRowsIn(100);
  const secondCalls = await callsOf("library:playlist-detail");
  add("pagination-second-page-once", secondCalls.filter((call) => call.page === 2).length === 1
    && secondCalls.length === 2 && (await rowCount()) === 100, JSON.stringify({ burst, pages: secondCalls.map((call) => call.page) }));

  // ⑥ 取完一页就停：不再自动连拉；用户再滚一次才取第 3 页，取完即"没有更多"
  const pagesBeforeIdle = (await callsOf("library:playlist-detail")).length;
  await page.waitForTimeout(800);
  const pagesAfterIdle = (await callsOf("library:playlist-detail")).length;
  add("pagination-page-then-wait", pagesAfterIdle === pagesBeforeIdle, `静置 800ms 后请求数 ${pagesBeforeIdle} → ${pagesAfterIdle}`);
  await wheelContent(20000);
  await visibleRowsIn(120);
  const thirdCalls = await callsOf("library:playlist-detail");
  const exhaustedStatus = await statusText();
  add("pagination-third-page-exhausted", thirdCalls.filter((call) => call.page === 3).length === 1
    && (await rowCount()) === 120 && (await sentinelCount()) === 0
    && exhaustedStatus.includes("已加载 120 首") && !exhaustedStatus.includes("继续向下滚动"),
  JSON.stringify({ pages: thirdCalls.map((call) => call.page), exhaustedStatus }));

  /**
   * ⑥b 第 2 页和第 3 页都是**同一份缓存上的本地切片**：假上游的请求次数必须还是 1。
   *
   * 这一条是"整表响应 → 本地分页"的核心证据：真协议层把第一页那份 120 首缓存下来，
   * 页 2/页 3 只切不发请求。若哪天有人把缓存删了（或让页面自己切片），这里的数字会立刻变 3。
   */
  const finalFetches = await page.evaluate(() => window.__guard.playlistFetches());
  const exhaustedNotice = ((await page.getByTestId("playlist-local-slice").textContent().catch(() => "")) ?? "").trim();
  add("pagination-pages-2-3-one-network-fetch", finalFetches.length === 1
    && exhaustedNotice.includes("已显示 120 首"),
  JSON.stringify({ fetches: finalFetches.length, exhaustedNotice }));

  // ⑥c 服务端重复整页：停止原因可见，不把本页数量冒充歌单总数
  await page.getByRole("button", { name: "我的歌单", exact: true }).click();
  await page.getByTestId("playlist-grid").waitFor();
  await page.getByTestId("playlist-grid").getByRole("button", { name: "打开", exact: true }).nth(1).click();
  await page.getByTestId("playlist-detail").waitFor();
  await visibleRowsIn(50);
  await wheelContent(20000);
  await page.waitForFunction(() => document.querySelector('[data-testid="list-pagination-status"]')?.textContent?.includes("服务端重复返回同一页"));
  const repeatedStatus = await statusText();
  const repeatedDetail = (await page.getByTestId("playlist-detail").textContent()) ?? "";
  add("pagination-server-repeat-visible-without-total", repeatedStatus.includes("服务端重复返回同一页")
    && repeatedStatus.includes("已停止继续加载") && repeatedStatus.includes("重新打开歌单后再试")
    && !repeatedDetail.includes("共 50 首") && (await sentinelCount()) === 0,
  JSON.stringify({ repeatedStatus, claimsTotal: repeatedDetail.includes("共 50 首"), sentinel: await sentinelCount() }));

  // ⑦ 专辑页：第一次失败 → 可点重试 → 第二次成功（失败不自动重试）
  await table.getByRole("button", { name: "守卫专辑", exact: true }).first().click();
  await failure.waitFor();
  const failureText = (await failure.textContent()) ?? "";
  await page.waitForTimeout(500);
  const albumCallsBeforeRetry = (await callsOf("library:album")).length;
  await page.getByTestId("list-pagination-retry").click();
  await visibleRowsIn(50);
  const albumCalls = await callsOf("library:album");
  add("pagination-error-retry", failureText.includes("故意失败") && albumCallsBeforeRetry === 1
    && albumCalls.length === 2 && albumCalls.every((call) => call.page === 1)
    && (await failure.count()) === 0 && (await rowCount()) === 50,
  JSON.stringify({ failureText: failureText.slice(0, 30), albumCalls: albumCalls.map((call) => call.page) }));

  // ⑧ 歌手页：后端不分页（一次响应 120 首），本地每批 50，且状态行明说"1 次网络请求"
  await table.getByRole("button", { name: "守卫艺人", exact: true }).first().click();
  await visibleRowsIn(50);
  const artistStatus = await statusText();
  const artistCalls = await callsOf("library:artist");
  add("pagination-local-reveal-first-batch", artistCalls.length === 1 && (await rowCount()) === 50
    && artistStatus.includes("后端一次返回 120 首") && artistStatus.includes("1 次网络请求")
    && artistStatus.includes("不减少流量") && artistStatus.includes("已显示 50 首"),
  JSON.stringify({ artistCalls: artistCalls.length, artistStatus }));
  await wheelContent(20000);
  await visibleRowsIn(100);
  const artistRevealed = await rowCount();
  const artistCallsAfter = (await callsOf("library:artist")).length;
  add("pagination-local-reveal-no-extra-network", artistCallsAfter === 1 && artistRevealed >= 100,
    `揭示 ${artistRevealed} 条，网络请求 ${artistCallsAfter} 次`);

  // ⑨ 历史页：同一类（本地分批），一次响应就是全部
  // 先回到顶部：内容区滚到底的位置会被下一张列表继承，哨兵一挂上就在视口里 → 会立刻再揭示一批
  // （那是本地揭示、不是网络请求；但"首屏 50 条"这件事要在同一基线上量）
  await scrollToTop();
  await page.getByRole("button", { name: "播放历史", exact: true }).click();
  await visibleRowsIn(50);
  const historyStatus = await statusText();
  add("pagination-history-local-batch", (await callsOf("library:history")).length === 1
    && (await rowCount()) === 50 && historyStatus.includes("1 次网络请求"), JSON.stringify({ historyStatus }));

  // ⑩ 换关键词：旧查询的迟到响应必须被丢掉（新结果里不许混进旧词的行）
  await scrollToTop();
  const box = page.getByRole("textbox", { name: "搜索关键字" });
  await box.fill(PAGINATION_FIXTURE.slowKeyword);
  await box.press("Enter");
  await page.waitForFunction((keyword) => window.__guard.libraryCalls().some((call) => call.channel === "library:search" && call.keyword === keyword), PAGINATION_FIXTURE.slowKeyword);
  await box.fill("快");
  await box.press("Enter");
  await page.waitForFunction(() => document.body.textContent.includes("搜索快曲目 1"), null, { timeout: 15_000 });
  await page.waitForTimeout(PAGINATION_FIXTURE.slowDelayMs + 500);
  const searchText = (await table.textContent()) ?? "";
  const searchCalls = await callsOf("library:search");
  add("pagination-query-switch-drops-stale", searchText.includes("搜索快曲目 1")
    && !searchText.includes("搜索慢曲目") && (await rowCount()) === 50
    && searchCalls.filter((call) => call.keyword === PAGINATION_FIXTURE.slowKeyword).length === 1,
  JSON.stringify({ rows: await rowCount(), keywords: searchCalls.map((call) => call.keyword).slice(-4) }));

  // ⑪ 短列表（4 首、每页 2 首）：哨兵一直在视口里也不许自己连拉；一次手势只取一页
  await scrollToTop();
  await box.fill(PAGINATION_FIXTURE.shortKeyword);
  await box.press("Enter");
  await visibleRowsIn(2);
  await page.waitForTimeout(800);
  const shortCallsIdle = (await callsOf("library:search")).filter((call) => call.keyword === PAGINATION_FIXTURE.shortKeyword);
  add("pagination-short-list-no-auto-chain", shortCallsIdle.length === 1 && (await rowCount()) === 2,
    JSON.stringify({ pages: shortCallsIdle.map((call) => call.page) }));
  await wheelContent(600);
  await visibleRowsIn(PAGINATION_FIXTURE.shortTotal);
  const shortCallsAfter = (await callsOf("library:search")).filter((call) => call.keyword === PAGINATION_FIXTURE.shortKeyword);
  add("pagination-short-list-gesture-one-page", shortCallsAfter.length === 2 && (await rowCount()) === PAGINATION_FIXTURE.shortTotal
    && (await sentinelCount()) === 0, JSON.stringify({ pages: shortCallsAfter.map((call) => call.page) }));

  await page.screenshot({ path: path.join(guardDir, "pagination-list.png") });

  /**
   * 收尾：把播放运行时放回主题循环结束时的样子（36 首完整曲目 + 暂停）。
   * 这一步是必须的——后面的桌面歌词验收按 "点播放 → playing" 判，队列被我换过就会红。
   */
  await page.evaluate(async () => {
    await window.__guard.ready();
    window.__guard.pause();
  });
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
  // R45A3 复审：真协议层的夹具模块（假上游 + createMusicApi），由守卫页 import
  await writeFile(path.join(guardDir, "protocol-fixture.mjs"), protocolPlaylistFixtureSource(), "utf8");
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

  // R45A1 复审：启动三态那一页（挂真 App，单独一个入口）
  await writeFile(path.join(guardDir, "startup.tsx"), startupHarnessSource(), "utf8");
  const builtStartup = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [`${GUARD_DIR}/startup.tsx`],
    outfile: `${GUARD_DIR}/startup.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  if (builtStartup.errors.length > 0) throw new Error(`启动守卫页面构建失败：${JSON.stringify(builtStartup.errors)}`);
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
  await writeFile(path.join(guardDir, "startup.html"), startupHarnessHtml(), "utf8");
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
    /**
     * R45A1 复审：启动三态（独立页面 + 独立错误收集）。
     *
     * 为什么独立开一页：主守卫页挂的是 `LibraryShell`（登录之后那一块），它根本不经过
     * `startupViewOf`；而这一项要证的正是"第一帧画什么"。放主页面里跑还会把它导航到炫
     * 登录页/主界面，污染后面每一项的基线。
     */
    const startupPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
    startupPage.setDefaultTimeout(15_000);
    const startupErrors = [];
    startupPage.on("console", (message) => {
      if (message.type() === "error") startupErrors.push(message.text());
    });
    startupPage.on("pageerror", (error) => startupErrors.push(error.message));
    await checkStartupGate(startupPage, port, guardDir, add);
    add("startup-no-runtime-errors", startupErrors.length === 0, JSON.stringify(startupErrors.slice(0, 3)));
    await startupPage.close();

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
    /**
     * R45A3：库列表触底分页（真滚轮 + 真 IPC 计数）。放在两轮主题之后、桌面歌词之前：
     * 它会把主界面导航到歌单/专辑/歌手/历史/搜索，之后的桌面窗验收本来就要重挂整个壳。
     */
    await checkLibraryPagination(page, guardDir, add);
    await page.evaluate(() => window.__guard.desktopBeforeMount());
    await page.getByTestId("lyrics-window").waitFor();
    await page.waitForTimeout(900);
    const earlyDocument = await page.getByTestId("lyrics-window").textContent();
    add("desktop-early-document", earlyDocument?.includes("第一行歌词守卫"), "早于 React 挂载的文档丢失后，就绪握手须补回当前快照");
    const desktop = page.getByTestId("lyrics-window");
    const grip = page.getByRole("button", { name: "拖动桌面歌词", exact: true });
    add("desktop-explicit-grip", await grip.count() === 1, "AMLL 子树之外有官方 startDragging 拖柄");
    if (await grip.count()) {
      const before = await page.evaluate(() => window.__guard.dragCount());
      await grip.click();
      const line = desktop.locator('[class*="lyricMainLine"]').first();
      await line.click();
      const after = await page.evaluate(() => window.__guard.dragCount());
      await page.getByRole("button", { name: "锁定桌面歌词", exact: true }).click();
      const lockedCount = await page.evaluate(() => window.__guard.dragCount());
      await line.click();
      add("desktop-child-drag-and-button-exclusion", after === before + 2 && lockedCount === after, JSON.stringify({ before, after, lockedCount }));
      add("desktop-lock-stops-drag", await grip.isDisabled() && await page.evaluate((count) => window.__guard.dragCount() === count, after), "锁仅禁拖，非整窗点透");
      const actionsBefore = await page.evaluate(() => window.__guard.mediaActions().length);
      await page.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(() => window.__guard.snapshot().status === "playing");
      await page.evaluate(() => window.__guard.desktopDocument());
      const actionsAfter = await page.evaluate(() => window.__guard.mediaActions());
      add("desktop-locked-media-once", actionsAfter.length === actionsBefore + 1 && actionsAfter.at(-1) === "toggle", JSON.stringify(actionsAfter));
      await page.getByRole("button", { name: "解锁桌面歌词", exact: true }).click();
      await page.getByRole("button", { name: "桌面歌词外观", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "面板", exact: true }).click();
      await page.getByRole("button", { name: "桌面歌词外观", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "竖版", exact: true }).click();
      await page.setViewportSize({ width: 320, height: 620 });
      await page.waitForTimeout(700);
      const verticalInk = await textPixels(page, '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]', "dark", path.join(guardDir, "desktop-vertical.png"));
      const verticalContent = await desktop.locator(".amll-lyric-player").boundingBox();
      add("desktop-panel-vertical", await desktop.locator('[data-slot="card"]').count() === 1 && await desktop.getAttribute("data-lyrics-layout") === "vertical" && verticalContent?.height > 400 && verticalInk.changed > 60, JSON.stringify({ verticalContent, verticalInk }));
      await page.evaluate(() => window.__guard.configureDesktop({ enableBlur: false, enableScale: false, enableSpring: false }));
      await page.evaluate(() => window.__guard.desktopPlaying(true));
      await page.waitForTimeout(900);
      const official = await desktop.locator(".amll-lyric-player").evaluate((element) => ({
        noSpring: element.className.includes("disableSpring"),
        transformed: [...element.querySelectorAll('[class*="lyricLine"]')].filter((node) => node.querySelector('[class*="lyricMainLine"]')).every((node) => {
          const transform = getComputedStyle(node).transform;
          return transform === "none" || Math.abs(new DOMMatrixReadOnly(transform).a - 1) < .001;
        }),
        noBlur: [...element.querySelectorAll('[class*="lyricLineWrapper"]')].filter((node) => node.textContent.trim()).every((node) => !getComputedStyle(node).filter.includes("blur")),
      }));
      await page.evaluate(() => window.__guard.configureDesktop({ enableScale: true }));
      await page.waitForTimeout(1200);
      const scaled = await desktop.locator('.amll-lyric-player [class*="lyricLine"]').evaluateAll((nodes) => nodes.filter((node) => node.querySelector('[class*="lyricMainLine"]')).some((node) => new DOMMatrixReadOnly(getComputedStyle(node).transform).a < .995));
      add("desktop-official-performance", official.noSpring && official.transformed && official.noBlur && scaled, JSON.stringify({ ...official, scaled }));
      await page.evaluate(() => window.__guard.desktopPlaying(false));
      await page.evaluate(() => window.__guard.setDesktop(false));
      await desktop.waitFor({ state: "detached" });
      await page.evaluate(() => window.__guard.setDesktop(true));
      await desktop.waitFor();
      await page.waitForTimeout(500);
      add("desktop-old-query-authoritative-ready", await desktop.getAttribute("data-lyrics-layout") === "vertical" && await desktop.locator('[data-slot="card"]').count() === 1, "重挂载旧 query，受限 configure 回读最新 config");
      await page.evaluate(() => window.__guard.configureDesktop({ ...window.__guard.desktopConfig(), layout: "horizontal", style: "clean", enableBlur: true, enableScale: true, enableSpring: true }));
      await page.evaluate(() => window.__guard.desktopDocument("empty"));
      const emptyCount = await page.evaluate(() => window.__guard.dragCount());
      await desktop.getByRole("status").click();
      add("desktop-empty-drag", await page.evaluate((count) => window.__guard.dragCount() === count + 1, emptyCount), "空态宿主同样可拖");
      await page.evaluate(() => window.__guard.desktopDocument());
    }
    await page.setViewportSize({ width: 960, height: 160 });
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
    await checkDesktopSurface(page, guardDir, add);
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
