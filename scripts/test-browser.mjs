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

import { RUN_LOG_EMPTY_TEXT, RUN_LOG_FAILURE_TEXT } from "../src/renderer/features/settings/run-log.mjs";
import { POPOVER_PAD_DIP } from "../src/renderer/features/lyrics/lyrics-popover.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 守卫自己的中间产物（.gitignore 已含 .tmp/）。 */
export const GUARD_DIR = ".tmp/browser-guard";

/** 歌词夹具：两行，间隔 3 秒（推进进度要看得见变化）。 */
export const FIXTURE_LRC = ["[00:00.00]第一行歌词守卫", "[00:03.00]第二行歌词守卫"].join("\n");

/**
 * R46 竖排重设计的夹具。
 *
 * - `R46_MIXED_LRC`：**中英混排**（CJK + 拉丁 + 数字 + 空格）。Unicode 默认竖排方向下 CJK 直立、
 *   拉丁旋转，这条夹具是判定"到底直立还是旋转"的唯一来源；
 * - `R46_LONG_LRC`：一行刻意很长（远超一列能装下的字数），用来量"折成多列 + 沿书写方向滚动"。
 */
export const R46_MIXED_LRC = ["[00:00.00]第一行歌词 2024 hey", "[00:03.00]第二行歌词 guard test line"].join("\n");
export const R46_LONG_LRC = ["[00:00.00]这一行被刻意写得很长 hello world 2024 混排 ABCdef 0123456789 再补几个字", "[00:03.00]第二行"].join("\n");

/** R61 竖版译文夹具：同一时间戳的第二行会被适配层并成 `translatedLyric`（相邻第二列、字号略小）。 */
export const R61_TRANSLATION_LRC = ["[00:00.00]第一行歌词守卫", "[00:00.00]译文与原文同时刻", "[00:03.00]第二行歌词守卫"].join("\n");

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
  return `import { StrictMode, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { LibraryShell } from "../../src/renderer/App.tsx";
import { LyricsWindow } from "../../src/renderer/LyricsWindow.tsx";
import { PlayerBar } from "../../src/renderer/components.tsx";
import { PlaybackStage } from "../../src/renderer/playback-stage.tsx";
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
/**
 * R59：任务栏能力（宿主回报的 \`taskbar.supported\`）。
 *
 * 守卫里可以切换它，用来验"非 Windows 不渲染那张卡"：能力只能来自宿主查询，
 * 页面里不许自己判断平台。
 */
let taskbarSupported = false;
const taskbarStatus = () => ({ supported: taskbarSupported, attached: false, reason: taskbarSupported ? "disabled" : "unsupported" });
/**
 * R50：普通 settings 文档（settings:get / settings:set 的夹具后端）。
 *
 * 存在 localStorage 里是为了"重载后仍然保留"那一项：真的重新加载页面之后，夹具后端剩下什么
 * 就取决于这里——扫描用的模块内存会被重建，localStorage 不会。
 */
let settingsData = (() => {
  try { return JSON.parse(localStorage.getItem("guard-settings") || "{}") || {}; } catch { return {}; }
})();
const persistSettings = () => localStorage.setItem("guard-settings", JSON.stringify(settingsData));
/** R50：每次 settings:set 的补丁与时刻（"播放器歌词走的是普通 settings 键"按它判）。 */
const settingsWrites = [];
/** R50：settings:set 的夹具行为（拒绝几次）——写盘失败要回滚，这一项得能造出来。 */
let settingsSetPlan = { failTimes: 0 };
/**
 * R56：运行日志夹具（core_read_run_log 的返回）。
 *
 * 四条覆盖四档级别 + 一条带假 token 的行：界面必须显示打码后的星号
 * （宿主侧已脱敏，渲染层再兜一层——守卫按"DOM 里搜不到那串"判）。
 */
const GUARD_RUN_LOG_SECRET = "guardsecret123456";
const guardRunLogEntries = () => [
  { time: "2026-10-26 05:12:30", level: "info", source: "hwmusic_core", message: "已就绪（帧协议 v1）" },
  { time: "2026-10-26 05:12:31", level: "warn", source: "hwmusic_core", message: "代理不可用，按直连处理" },
  { time: "2026-10-26 05:12:32", level: "error", source: "huawei_music_desktop_lib::commands", message: "登录失败 token=" + GUARD_RUN_LOG_SECRET },
  { time: "2026-10-26 05:12:33", level: "debug", source: "tao", message: "窗口几何恢复" },
];
let runLogPlan = { failTimes: 0, mode: "entries" };
const runLogReads = [];
let dragCalls = 0;
/** R45B：官方 startResizeDragging 的方向记录（缩放手柄"真的调了官方 API"按它判）。 */
const resizeCalls = [];
/** R45B：每次 core_lyrics_configure 的补丁（窗口尺寸保存与"锁定后不保存"按它判）。 */
const configureCalls = [];
/**
 * R51：设置弹出窗的三条命令。歌词窗那一侧只该出现 open（锚点 = 齿轮矩形），
 * 另两条只有弹出窗自己会发——这里一并记下来，免得"谁发的"变成猜的。
 */
const settingsPopupOpens = [];
const settingsPopupResizes = [];
const settingsPopupCloses = [];
const mediaActions = [];
/** R45C：core_lyrics_toggle 的请求次数与每次的意图（"一次点击只发一次"按它判）。 */
const lyricsToggles = [];
/**
 * R45C：每一次 core_lyrics_toggle 的时间戳与当时的夹具延迟。
 *
 * 为什么要时间戳：简报点名"快速双击要发生在**第一次回执之前**"——两枚点击都落在
 * 夹具的延迟窗口里，这条记录才是证据（光有点击次数证明不了"回执还没回来"）。
 */
const toggleLog = [];
/**
 * R45C：开关夹具的行为（延迟多久回执 / 拒绝几次）。
 * failTimes 递减到 0 之后恢复正常——"被拒绝一次再重试成功"就是靠它造的。
 */
let togglePlan = { delayMs: 0, failTimes: 0 };
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
      case "settings:set": {
        const patch = args.payload?.patch ?? {};
        settingsWrites.push({ patch: JSON.parse(JSON.stringify(patch)), atMs: Math.round(performance.now()) });
        if (settingsSetPlan.failTimes > 0) {
          settingsSetPlan = { ...settingsSetPlan, failTimes: settingsSetPlan.failTimes - 1 };
          throw { kind: "internal", message: "守卫夹具：这一次设置写入被故意拒绝" };
        }
        settingsData = { ...settingsData, ...patch };
        persistSettings();
        return { settings: { schemaVersion: 1, data: settingsData } };
      }
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
  if (command === "plugin:window|start_resize_dragging") { resizeCalls.push(args.value ?? null); return; }
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
      configureCalls.push({ ...args.config });
      desktopConfig = { ...desktopConfig, ...args.config }; desktopRevision += 1;
      await emit("core:event", { channel: "lyrics:state", payload: { config: desktopConfig, revision: desktopRevision, visible: false, taskbar: taskbarStatus() } });
    }
    return { config: desktopConfig, revision: desktopRevision, visible: false, taskbar: taskbarStatus() };
  }
  if (command === "core_lyrics_toggle") {
    const checked = args.checked === true;
    lyricsToggles.push(checked);
    toggleLog.push({ checked, atMs: Math.round(performance.now()), delayMs: togglePlan.delayMs });
    const delayMs = togglePlan.delayMs;
    // 回执延迟：让"点下去到回执回来"这段真空真的存在（快速双击就发生在这里面）
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (togglePlan.failTimes > 0) {
      togglePlan = { ...togglePlan, failTimes: togglePlan.failTimes - 1 };
      throw { kind: "internal", message: "守卫夹具：这一次歌词开关被故意拒绝" };
    }
    return { config: desktopConfig, revision: desktopRevision, visible: checked, requestedVisible: checked };
  }
  if (command === "core_lyrics_settings_open") {
    settingsPopupOpens.push({ ...(args.anchor ?? {}) });
    return { open: true, visible: true, measured: true };
  }
  if (command === "core_lyrics_settings_resize") {
    settingsPopupResizes.push({ width: args.width, height: args.height });
    return { applied: true, visible: true };
  }
  if (command === "core_lyrics_settings_close") {
    settingsPopupCloses.push(Math.round(performance.now()));
    return { open: false };
  }
  /** R56：日志文件的夹具（失败、空文件、正常三种都由 runLogPlan 造）。 */
  if (command === "core_read_run_log") {
    runLogReads.push(Math.round(performance.now()));
    if (runLogPlan.failTimes > 0) {
      runLogPlan = { ...runLogPlan, failTimes: runLogPlan.failTimes - 1 };
      throw { kind: "internal", message: "守卫夹具：这一次日志读取被故意拒绝" };
    }
    return runLogPlan.mode === "empty" ? [] : guardRunLogEntries();
  }
  throw new Error("未提供守卫命令：" + command);
}, { shouldMockEvents: true });
const runtime = getPlayerRuntime();

function Guard() {
  const [desktop, setDesktop] = useState(false);
  /**
   * R45C：?surface=no-lyrics 挂的是**不带 lyrics binding** 的播放栏 + 沉浸页。
   *
   * 为什么另起一页而不是塞进主页面：LibraryShell 永远会造一份 binding（那是它的职责），
   * 而这一项要证的正是"没有 binding 时组件不崩、也不出现按了没反应的死按钮"——
   * 只有一个**真的不传** lyrics 的挂载点才量得到。
   */
  const surface = new URLSearchParams(location.search).get("surface");
  const live = useSyncExternalStore(
    (listener) => runtime.player.subscribe(listener),
    () => runtime.player.snapshot(),
    () => runtime.player.snapshot(),
  );
  useEffect(() => {
    window.__guard = {
      snapshot: () => runtime.player.snapshot(),
      setTime: (ms) => runtime.player.seek(ms),
      nextTrack: () => runtime.player.next(),
      prepareRepeatedQueue: () => runtime.player.playQueue([songs[0], songs[0]], 0),
      /**
       * R54：只把队列摆好、**不播**（恢复队列的样子）。音频一次都没装载，所以总时长只能来自
       * 条目元数据——正是"底栏不该显示「—」"那条路径。seconds 为 null 的条目没有时长字段。
       */
      queueWithTrackDuration(seconds) {
        const song = { id: "meta-" + (seconds === null ? "none" : seconds), name: "元数据时长曲目", artists: "守卫艺人" };
        runtime.player.setQueue([seconds === null ? song : { ...song, duration: seconds }], 0);
      },
      markRuntime() { this.markedRuntime = runtime; },
      sameRuntime: () => window.__guard.markedRuntime === getPlayerRuntime(),
      async setCoverFailure() {
        await runtime.player.playQueue(songs.map((song) => ({ ...song, coverUrl: "https://music.dbankcdn.cn/guard-cover-broken.png" })), 0);
        runtime.player.pause();
        runtime.player.seek(700);
      },
      setLyrics: (status) => runtime.player.setLyrics([], status),
      /**
       * R46：换成任意 LRC 文本（竖排的混排/长行几何需要中英混排的夹具）。
       * 走的仍是**真适配层** parseAmllLyrics，不手搓 LyricLine——否则量的就不是产品路径。
       */
      async setLrc(text) {
        const { parseAmllLyrics } = await import("../../src/renderer/features/lyrics/amll-adapter.ts");
        runtime.player.setLyrics(parseAmllLyrics(text).lines, "ready");
      },
      restoreLyrics: async () => {
        const { parseAmllLyrics } = await import("../../src/renderer/features/lyrics/amll-adapter.ts");
        runtime.player.setLyrics(parseAmllLyrics(LRC).lines, "ready");
      },
      setDesktop,
      dragCount: () => dragCalls,
      resizeCalls: () => resizeCalls.slice(),
      configureCalls: () => configureCalls.map((patch) => ({ ...patch })),
      resetConfigureCalls: () => { configureCalls.length = 0; },
      /** R51：歌词窗发出的打开请求（锚点矩形），以及它自己收到的尺寸/关闭（不该有）。 */
      settingsPopupCalls: () => settingsPopupOpens.map((anchor) => ({ ...anchor })),
      settingsPopupResizes: () => settingsPopupResizes.slice(),
      settingsPopupCloses: () => settingsPopupCloses.slice(),
      resetSettingsPopupCalls: () => { settingsPopupOpens.length = 0; settingsPopupResizes.length = 0; settingsPopupCloses.length = 0; },
      mediaActions: () => mediaActions.slice(),
      lyricsToggles: () => lyricsToggles.slice(),
      /** R45C：每次开关请求的时间戳（"第二次点击发生在第一次回执之前"照它判）。 */
      toggleLog: () => toggleLog.map((entry) => ({ ...entry })),
      /** R45C：改开关夹具（延迟多久回执、拒绝几次）。 */
      setTogglePlan: (patch) => { togglePlan = { ...togglePlan, ...(patch ?? {}) }; },
      resetLyricsToggles: () => { lyricsToggles.length = 0; toggleLog.length = 0; },
      /** R45A3：库列表分页的调用记录（频道/页号/页大小/关键字），"一页只取一次"按它判。 */
      libraryCalls: () => libraryCalls.slice(),
      resetLibraryCalls: () => { libraryCalls.length = 0; },
      /** R45A3 复审：**假上游**（每次都回整张歌单）的请求记录——"整份只取一次"按它判。 */
      playlistFetches: () => playlistProbe.fetches(),
      resetPlaylistFetches: () => { playlistProbe.reset(); },
      queueLength: () => runtime.player.snapshot().entries.length,
      pause: () => runtime.player.pause(),
      desktopConfig: () => desktopConfig,
      /**
       * R59：切换任务栏能力回报（true = Windows）。
       *
       * 必须经**真实广播**回来：能力是宿主状态的一部分，设置页读的是 lyrics:state 那一份，
       * 直接调命令不会更新桥（那样量到的就不是产品路径）。
       */
      async setTaskbarSupported(value) {
        taskbarSupported = value === true;
        await emit("core:event", { channel: "lyrics:state", payload: {
          config: desktopConfig, revision: desktopRevision, visible: false, taskbar: taskbarStatus(),
        }});
      },
      /** R50：settings 夹具后端（播放器歌词那一份）。 */
      settingsData: () => JSON.parse(JSON.stringify(settingsData)),
      /** R50：每次 settings:set 的补丁（"播放器歌词是普通键"按它判）。 */
      settingsWrites: () => settingsWrites.map((entry) => JSON.parse(JSON.stringify(entry))),
      /** R50：把 settings 夹具清空（含 localStorage——重载后不该被上一项污染）。 */
      resetSettings: () => {
        settingsData = {};
        settingsWrites.length = 0;
        settingsSetPlan = { failTimes: 0 };
        try { localStorage.removeItem("guard-settings"); } catch {}
      },
      /** R50：让接下来 N 次 settings:set 被拒绝（写盘失败 → 回滚）。 */
      setSettingsPlan: (patch) => { settingsSetPlan = { ...settingsSetPlan, ...(patch ?? {}) }; },
      /** R56：日志夹具（mode=entries|empty，failTimes）与读取次数。 */
      setRunLogPlan: (patch) => { runLogPlan = { ...runLogPlan, ...(patch ?? {}) }; },
      runLogReads: () => runLogReads.slice(),
      resetRunLog: () => { runLogPlan = { failTimes: 0, mode: "entries" }; runLogReads.length = 0; },
      /** R56：经**真实广播通道**播一条 app:notice（提示条目的来源是这条广播）。 */
      async emitNotice(text) {
        await emit("core:event", { channel: "app:notice", payload: { text } });
      },
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
      /**
       * R58：任意时刻 + 任意播放态的进度（逐字遮罩只在 playing 为真时自行前进，
       * 所以夹具必须能把"同一行、两个时刻、两种播放态"分别造出来）。
       */
      async desktopProgress(progress) {
        const next = progress !== null && typeof progress === "object" ? progress : {};
        await emit("core:event", { channel: "lyrics:progress", payload: {
          timeMs: 0, playing: false, seekGeneration: 100, ...next,
        } });
      },
      async ready() {
        await runtime.initialize();
        await runtime.player.playQueue(songs, 0);
        runtime.player.pause();
        runtime.player.seek(700);
      },
    };
  }, []);
  if (surface === "no-lyrics") {
    return (
      <TooltipProvider>
        <div className="h-full w-full" data-testid="no-binding-surface">
          <PlayerBar runtime={runtime} state={live} onOpenStage={() => {}} />
          <PlaybackStage open runtime={runtime} state={live} onClose={() => {}} />
        </div>
      </TooltipProvider>
    );
  }
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
 * IPC 只给门禁需要的那几条；三种模式（`?startup=fail` / `?startup=logged-in` / `?startup=restoring`）：
 * - `fail`：第一次 `auth:get-status` **故意失败**（延迟 400ms 再抛，让"还不知道"那一屏
 *   真的出现在屏幕上），第二次（用户点「重新检查登录状态」）才答 `loggedIn:false`
 *   → 登录页 + 二维码自动发起**恰好一次**；
 * - `logged-in`：第一次就答 `loggedIn:true` → app-shell，且**一张码都不建**。
 * - `restoring`（R53）：`auth:get-status` 答 `{loggedIn:false, restoring:true}`，测试再用
 *   `__startupGuard.emitStatus` 播一条"已登录"当作恢复结论 → 全程不许画登录页、不许建码。
 *
 * 计数（`window.__startupGuard`）是断言的核心：`auth:get-status` 次数证明"重试真的重发了"，
 * `auth:qr-start` 次数证明"二维码只在确定未登录之后才建、且只建一次"，
 * `auth:cancel-qr` 次数证明"门禁收场时真的停了一次轮询"（R53）。
 */
export function startupHarnessSource() {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { App } from "../../src/renderer/App.tsx";

/** 查询失败那一档的延迟：把"还不知道"那一屏真的拉到屏幕上（否则它可能在第一次采样前就过去了）。 */
const FIRST_STATUS_DELAY_MS = 400;
const startupMode = new URLSearchParams(location.search).get("startup");
const mode = startupMode === "logged-in" || startupMode === "restoring" ? startupMode : "fail";
const counters = { statusQueries: 0, qrStarts: 0, cancelQrCalls: 0, rendererReady: 0, qrStartAt: null };
window.__startupGuard = {
  mode,
  counters,
  /** 让测试自己"恢复落定"：播一条 auth:status（真机上这条来自 sidecar 的 announce）。 */
  emitStatus: (payload) => emit("core:event", { channel: "auth:status", payload }),
};

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
        if (mode === "restoring") return { loggedIn: false, busy: false, restoring: true };
        return { loggedIn: mode === "logged-in", busy: false };
      }
      case "auth:cancel-qr": {
        counters.cancelQrCalls += 1;
        return { cancelled: true };
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
 * R57：左下角账号区的**真浏览器**验收页（独立入口，挂的是真 `App`）。
 *
 * 四种状态由查询串给（`?variant=`）：`profile`（有名字+能加载的头像）、`empty`（老会话，
 * 载荷里没有 profile）、`vip`（会员 + 到期日 + **坏头像**，同时验首字回退）、
 * `collapsed`（`?variant=profile&collapsed=1`，侧栏窄轨）。
 *
 * 夹具里的名字是编的长名字：它必须长到被 `truncate` 切掉，否则"悬停看全名"这件事测不出来。
 */
export function accountHarnessSource() {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { App } from "../../src/renderer/App.tsx";

const LONG_NAME = "听歌的人间观察员一二三四五六七八九十";
const AVATAR_OK = "https://music.dbankcdn.cn/guard-avatar.png";
const AVATAR_BROKEN = "https://music.dbankcdn.cn/guard-avatar-broken.png";
const params = new URLSearchParams(location.search);
const variant = params.get("variant") ?? "profile";
const PROFILES = {
  profile: { userName: LONG_NAME, avatarUrl: AVATAR_OK },
  empty: null,
  vip: { userName: LONG_NAME, avatarUrl: AVATAR_BROKEN, vip: true, vipExpiresOn: "20261231235959" },
};
const profile = PROFILES[variant] === undefined ? PROFILES.profile : PROFILES[variant];
window.__accountGuard = { variant, longName: LONG_NAME, avatarOk: AVATAR_OK, avatarBroken: AVATAR_BROKEN };
window.__noop = () => {};

mockWindows("main");
mockIPC(async (command, args) => {
  if (command === "core_renderer_ready") return 0;
  if (command === "core_get_tray_available") return false;
  if (command === "core_login_chrome") return { theme: "light" };
  if (command === "core_lyrics_configure") return { config: {}, revision: 0, visible: false };
  if (command === "core_lyrics_toggle") return { config: {}, revision: 0, visible: false };
  if (command === "core_lyrics_document") return emit("core:event", { channel: "lyrics:document", payload: args.document });
  if (command === "core_call") {
    switch (args.channel) {
      case "auth:get-status":
        return profile === null ? { loggedIn: true, busy: false } : { loggedIn: true, busy: false, profile };
      case "auth:cancel-qr": return { cancelled: true };
      case "settings:get": return { settings: { schemaVersion: 1, data: {} } };
      case "library:favorites": return { songs: [], hasMore: false, skipped: 0, reportedTotal: 0 };
      case "library:playlists": return { playlists: [], hasMore: false };
      // 这一页只量账号区：其余频道给空答案，别让背景请求把控制台刷满
      default: return null;
    }
  }
  return null;
}, { shouldMockEvents: true });

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;
}

/** 账号区守卫页面（生成物，不入库）。 */
export function accountHarnessHtml() {
  return `<!doctype html>
<html lang="zh-CN" class="light">
  <head>
    <meta charset="utf-8" />
    <title>账号区浏览器守卫</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./account.js"></script>
  </body>
</html>
`;
}

/**
 * R57：左下角账号区四态的验收（有资料 / 无资料 / 有会员到期 / 窄轨只剩头像）。
 *
 * 判据只看**DOM 事实**：有没有头像 `<img>`、是不是首字兜底、名字是否真被截断、
 * 悬停是否给出全名、会员徽标文案、窄轨里除了头像还剩什么。四种状态各留一张截图。
 */
export async function checkAccountArea(page, port, guardDir, add) {
  const area = '[data-testid="account-area"]';
  const sidebar = '[data-slot="sidebar-container"]';

  /** 头像那张图的加载结果（`<img>` 不存在 = 走兜底）。 */
  const avatarState = () =>
    page.evaluate((selector) => {
      const root = document.querySelector(selector);
      const image = root?.querySelector('[data-testid="account-avatar"] img');
      const fallback = root?.querySelector('[data-testid="account-avatar"] [data-slot="avatar-fallback"]');
      return {
        src: image?.getAttribute("src") ?? null,
        naturalWidth: image?.naturalWidth ?? 0,
        fallbackText: (fallback?.textContent ?? "").trim(),
        fallbackHasIcon: Boolean(fallback?.querySelector("svg")),
      };
    }, area);

  const accountFacts = () =>
    page.evaluate((selector) => {
      const root = document.querySelector(selector);
      const name = root?.querySelector('[data-testid="account-name"]');
      const vip = root?.querySelector('[data-testid="account-vip"]');
      const visible = (node) => Boolean(node && node.getClientRects().length > 0);
      return {
        name: (name?.textContent ?? "").trim(),
        nameVisible: visible(name),
        nameTruncated: Boolean(name && name.scrollWidth > name.clientWidth + 1),
        vip: (vip?.textContent ?? "").trim(),
        vipVisible: visible(vip),
        avatarVisible: visible(root?.querySelector('[data-testid="account-avatar"]')),
        themeVisible: visible(root?.querySelector('[data-testid="theme-toggle"]')),
        logoutVisible: visible(root?.querySelector('button[aria-label="退出登录"]')),
      };
    }, area);

  /** 账号区本身的特写（审阅看的就是这一块）；另留一张整条侧栏的定位图。 */
  const shot = async (file, contextFile) => {
    await page.locator(area).screenshot({ path: path.join(guardDir, file) });
    if (contextFile === undefined) return;
    const box = await page.locator(sidebar).boundingBox();
    await page.screenshot(box === null ? { path: path.join(guardDir, contextFile) } : { clip: box, path: path.join(guardDir, contextFile) });
  };

  const open = async (query) => {
    await page.goto(`http://127.0.0.1:${port}/account.html${query}`, { waitUntil: "load" });
    await page.getByTestId("account-area").waitFor();
    await page.waitForTimeout(300);
  };

  // ——— ① 有资料：头像真的画出来，名字被截断，悬停给全名 ———
  await open("?variant=profile");
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="account-avatar"] img');
    return image !== null && image.naturalWidth > 0;
  }, null, { timeout: 10_000 });
  const withProfile = { avatar: await avatarState(), facts: await accountFacts() };
  add(
    "r57-account-profile-avatar",
    withProfile.avatar.src?.endsWith("/guard-avatar.png") === true &&
      withProfile.avatar.naturalWidth > 0 &&
      withProfile.facts.name !== "" &&
      withProfile.facts.name !== "已登录",
    JSON.stringify(withProfile),
  );
  add("r57-account-name-truncated", withProfile.facts.nameTruncated, JSON.stringify(withProfile.facts));
  await page.getByTestId("account-name").hover();
  const tooltip = page.getByRole("tooltip");
  await tooltip.waitFor({ timeout: 5_000 });
  const fullName = (await tooltip.textContent())?.trim() ?? "";
  const expectedName = await page.evaluate(() => window.__accountGuard.longName);
  add("r57-account-name-tooltip", fullName === expectedName, JSON.stringify({ fullName: fullName.length, expected: expectedName.length }));
  await shot("r57-account-profile.png", "r57-account-profile-sidebar.png");

  // ——— ② 无资料（旧会话）：兜底"已登录" + 图标占位，徽标一个都不许有 ———
  await open("?variant=empty");
  const empty = { avatar: await avatarState(), facts: await accountFacts() };
  add(
    "r57-account-empty-fallback",
    empty.facts.name === "已登录" &&
      empty.avatar.src === null &&
      empty.avatar.fallbackHasIcon &&
      empty.avatar.fallbackText === "" &&
      empty.facts.vipVisible === false,
    JSON.stringify(empty),
  );
  await shot("r57-account-empty.png");

  // ——— ③ 会员 + 到期日 + 坏头像：徽标写全日期，头像回退首字 ———
  await open("?variant=vip");
  await page.waitForFunction(() => {
    const fallback = document.querySelector('[data-testid="account-avatar"] [data-slot="avatar-fallback"]');
    return (fallback?.textContent ?? "").trim() !== "";
  }, null, { timeout: 10_000 });
  const vip = { avatar: await avatarState(), facts: await accountFacts() };
  add("r57-account-vip-expiry", vip.facts.vip === "会员 · 至 2026-12-31" && vip.facts.vipVisible, JSON.stringify(vip.facts));
  add("r57-account-avatar-letter-fallback", vip.avatar.fallbackText === "听", JSON.stringify(vip.avatar));
  await shot("r57-account-vip-expiry.png");

  // ——— ④ 窄轨：只剩头像（名字/徽标/主题/退出都不在画面上） ———
  await open("?variant=profile");
  // 收起只有一条真路：点侧栏那枚开关（provider 不读 cookie，只写 cookie）
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.waitForFunction(() => {
    const name = document.querySelector('[data-testid="account-name"]');
    return name !== null && name.getClientRects().length === 0;
  }, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  const collapsed = await accountFacts();
  add(
    "r57-account-collapsed-avatar-only",
    collapsed.avatarVisible === true &&
      collapsed.nameVisible === false &&
      collapsed.vipVisible === false &&
      collapsed.themeVisible === false &&
      collapsed.logoutVisible === false,
    JSON.stringify(collapsed),
  );
  await shot("r57-account-collapsed.png", "r57-account-collapsed-sidebar.png");

  // ——— ⑤ 展开态的两个入口仍在（主题切换 / 退出登录） ———
  await open("?variant=profile");
  const entry = {
    theme: await page.locator('[data-testid="account-area"] [data-testid="theme-toggle"]').count(),
    logout: await page.locator('[data-testid="account-area"] button[aria-label="退出登录"]').count(),
  };
  add("r57-account-controls-kept", entry.theme === 1 && entry.logout === 1, JSON.stringify(entry));
}

/**
 * R45A1（复审）：启动三态的**真浏览器**行为验收。
 *
 * 钉六件事：

 * 1. 首帧（`checking`，状态查询还没落地）**没有**登录页/二维码/任何按钮；
 * 2. 查询失败之后仍是中性启动屏：没有 LoginGate/二维码，但原因、重试、网页登录都在；
 * 3. 点「重新检查登录状态」= **真的再发一次 `auth:get-status`**（计数 +1），
 *    并且答案是未登录之后才出现登录页、二维码**恰好建一次**；
 * 4. 已登录的会话：直接 app-shell，登录页出现 0 次、二维码 0 次。
 * 5. 恢复中（`restoring:true`）同样是中性启动屏：6 次 DOM 采样里登录页/二维码/壳都是 0、
 *    `auth:qr-start` 0 次；"已登录"广播到达后直接进壳；
 * 6. 门禁从登录页切到主界面时发**一次** `auth:cancel-qr`（停掉轮询，不靠延时）。
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

  // ——— ⑤ 恢复中：快照答 restoring → 中性启动屏，一张码都不建 ———
  await page.goto(`http://127.0.0.1:${port}/startup.html?startup=restoring`, { waitUntil: "load" });
  // 只让首屏落地，**不等** `startup-checking`：它缺席本身就是断言的一部分
  await page.waitForTimeout(250);
  // 采样窗口：从首屏到模拟恢复落定之前，反复看 DOM（不只一次快照）
  const restoringSamples = [];
  for (let round = 0; round < 6; round += 1) {
    restoringSamples.push({
      loginNodes: await loginNodes(),
      loginGate: await page.getByTestId("login-qr-refresh").count(),
      startupScreens: await page.getByTestId("startup-checking").count(),
      appShell: await page.locator('[data-shell="app-shell"]').count(),
      qrStarts: (await counters()).qrStarts,
    });
    await page.waitForTimeout(80);
  }
  add(
    "startup-restoring-stays-neutral",
    restoringSamples.every(
      (sample) =>
        sample.loginNodes === 0 && sample.loginGate === 0 && sample.startupScreens === 1 && sample.appShell === 0 && sample.qrStarts === 0,
    ),
    JSON.stringify(restoringSamples),
  );
  await page.screenshot({ path: path.join(guardDir, "startup-restoring.png") });

  // 恢复落定（sidecar 播"已登录"）→ 直接进主界面，登录页与二维码依然是 0
  await page.evaluate(() => window.__startupGuard.emitStatus({ loggedIn: true, busy: false }));
  await page.locator('[data-shell="app-shell"]').waitFor();
  await page.waitForTimeout(300);
  const restored = {
    loginNodes: await loginNodes(),
    loginGate: await page.getByTestId("login-qr-refresh").count(),
    startupScreens: await page.getByTestId("startup-checking").count(),
    counters: await counters(),
  };
  add(
    "startup-restoring-then-app-shell",
    restored.loginNodes === 0 && restored.loginGate === 0 && restored.startupScreens === 0 && restored.counters.qrStarts === 0,
    JSON.stringify(restored),
  );

  // ——— ⑥ 门禁收场：切到主界面时发一次 auth:cancel-qr（把轮询停掉） ———
  // 回到有二维码的那一档（③ 之后门禁已经建过一张码），再播"已登录"。
  await page.goto(`http://127.0.0.1:${port}/startup.html?startup=fail`, { waitUntil: "load" });
  await page.getByTestId("startup-retry-status").waitFor();
  await page.getByTestId("startup-retry-status").click();
  await page.getByTestId("login-qr-refresh").waitFor();
  const beforeSwitch = await counters();
  await page.evaluate(() => window.__startupGuard.emitStatus({ loggedIn: true, busy: false }));
  await page.locator('[data-shell="app-shell"]').waitFor();
  await page.waitForTimeout(300);
  const afterSwitch = await counters();
  add(
    "startup-gate-unmount-cancels-qr",
    beforeSwitch.qrStarts === 1 && beforeSwitch.cancelQrCalls === 0 && afterSwitch.cancelQrCalls === 1,
    JSON.stringify({ beforeSwitch, afterSwitch }),
  );
}

/**
 * R45C：播放栏 / 沉浸页的快捷歌词开关与沉浸页收起（真组件 + 真 IPC 边界的**行为**验收）。
 *
 * 钉 brief C 节 + fix1 的六件事（都不看结构，只看行为）：
 * 1. 歌词窗关着时点一下能开：恰好一条 `core_lyrics_toggle(true)`；
 * 2. **回执被延迟**时快速双击：第二次点击必须取反（`true` → `false`），不是再发一个 `true`。
 *    两条请求的时间戳都落在夹具延迟窗口里，这就是"第二次点击发生在第一次回执之前"的证据
 *    （原来那版 150ms 间隔的连点证明不了这件事——回执早就回来了）；
 * 3. 两种模式：任务栏模式的标签说"任务栏歌词"，点击照样只发一条；
 * 4. 开关被拒绝：**发起面**出现一句可操作的话（原因 + 下一步）与「重试」/「知道了」，
 *    没有第二条 toast；重试之后恢复（窗口真的开起来）；
 * 5. 沉浸页那枚开关失败：提示在沉浸页，播放栏不重复印同一句；
 * 6. 收起按钮在顶部中央、可点、不压官方控件；菜单打开时 ESC 先关菜单（舞台留着），
 *    再按一次才关舞台。
 */
export async function checkPlaybackLyricsToggle(page, port, guardDir, add) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__guard !== undefined, null, { timeout: 15_000 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.evaluate(() => window.__guard.ready());
  await page.waitForFunction(() => window.__guard.snapshot().lyrics.status === "ready" && window.__guard.snapshot().durationMs > 0);
  // R46 证据：播放栏的真实截图（传输组 模式→上一首→播放→下一首，歌词开关在尾部工具区）
  const barBox = await page.getByTestId("player-bar").boundingBox();
  if (barBox) await page.screenshot({ path: path.join(guardDir, "r46-player-bar-order.png"), clip: barBox });

  /** 播放栏那枚开关的状态 + 当前所有开关请求 + 提示/ toast 的数量（一次采样看完）。 */
  const barState = () => page.evaluate(() => {
    const button = document.querySelector('[data-testid="player-lyrics-toggle"]');
    return {
      exists: Boolean(button),
      label: button?.getAttribute("aria-label") ?? null,
      pressed: button?.getAttribute("aria-pressed") ?? null,
      requests: window.__guard.toggleLog(),
      error: document.querySelector('[data-testid="lyrics-toggle-error"]')?.textContent?.trim() ?? null,
      toasts: document.querySelectorAll('[data-sonner-toast]').length,
    };
  });
  const plan = (patch) => page.evaluate((value) => window.__guard.setTogglePlan(value), patch);

  // ——— ① 歌词窗关着也能开：一次点击 = 一条 true ———
  await plan({ delayMs: 0, failTimes: 0 });
  await page.evaluate(() => window.__guard.resetLyricsToggles());
  const closed = await barState();
  await page.getByTestId("player-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().length === 1
    && document.querySelector('[data-testid="player-lyrics-toggle"]')?.getAttribute("aria-pressed") === "true");
  const opened = await barState();
  add("playback-hidden-window-opens", closed.exists && closed.label === "显示桌面歌词" && closed.pressed === "false"
    && opened.requests.length === 1 && opened.requests[0].checked === true
    && opened.pressed === "true" && opened.label === "隐藏桌面歌词",
    JSON.stringify({ closed: { label: closed.label, pressed: closed.pressed }, opened: { label: opened.label, pressed: opened.pressed, requests: opened.requests } }));

  // 关回去（等它落定），准备从"关着"开始测双击
  await page.getByTestId("player-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().at(-1)?.checked === false);

  // ——— ② 回执延迟 350ms 时的快速双击：第二次取反，不是两个 true ———
  await page.evaluate(() => { window.__guard.resetLyricsToggles(); window.__guard.setTogglePlan({ delayMs: 350, failTimes: 0 }); });
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="player-lyrics-toggle"]');
    // 同一个任务里连点两下：React 还没重渲染，意图机必须自己取反（不是读渲染快照）
    button.click();
    button.click();
  });
  const immediate = await barState();
  add("playback-double-click-before-reply-inverts",
    immediate.requests.length === 2
      && immediate.requests[0].checked === true && immediate.requests[1].checked === false
      && Math.abs(immediate.requests[1].atMs - immediate.requests[0].atMs) < 100
      && immediate.requests.every((entry) => entry.delayMs === 350)
      && immediate.pressed === "false",
    JSON.stringify({ immediate }));
  await page.waitForTimeout(1400);
  const settled = await barState();
  add("playback-double-click-settles-off",
    settled.requests.length === 2 && settled.pressed === "false" && settled.label === "显示桌面歌词" && settled.error === null,
    JSON.stringify({ settled: { pressed: settled.pressed, label: settled.label, error: settled.error, requests: settled.requests.length } }));

  // ——— ③ 两种模式：任务栏模式的标签说任务栏歌词，点击照样只发一条 ———
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "taskbar" }));
  await page.waitForFunction(() => document.querySelector('[data-testid="player-lyrics-toggle"]')?.getAttribute("aria-label") === "显示任务栏歌词");
  await page.evaluate(() => { window.__guard.resetLyricsToggles(); window.__guard.setTogglePlan({ delayMs: 0, failTimes: 0 }); });
  await page.getByTestId("player-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().length === 1);
  const taskbar = await barState();
  add("playback-taskbar-mode-label",
    taskbar.label === "隐藏任务栏歌词" && taskbar.requests.length === 1 && taskbar.requests[0].checked === true,
    JSON.stringify({ label: taskbar.label, requests: taskbar.requests }));
  await page.getByTestId("player-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().at(-1)?.checked === false);
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop" }));
  await page.waitForFunction(() => document.querySelector('[data-testid="player-lyrics-toggle"]')?.getAttribute("aria-label") === "显示桌面歌词");
  await page.evaluate(() => window.__guard.resetLyricsToggles());

  // ——— ④ 被拒绝：发起面一句可操作的话（原因 + 下一步 + 重试/关掉），没有第二条 toast ———
  await plan({ delayMs: 0, failTimes: 1 });
  await page.getByTestId("player-lyrics-toggle").click();
  await page.getByTestId("lyrics-toggle-error").waitFor();
  const failure = await barState();
  const actionable = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="lyrics-toggle-error"]');
    return {
      retry: Boolean(box?.querySelector('[data-testid="lyrics-toggle-retry"]')),
      dismiss: Boolean(box?.querySelector('[data-testid="lyrics-toggle-dismiss"]')),
      barCopy: document.querySelectorAll('[data-testid="lyrics-toggle-error"]').length,
      rawErrorLeak: (box?.textContent ?? "").includes("守卫夹具"),
    };
  });
  add("playback-toggle-failure-actionable",
    failure.requests.length === 1 && failure.pressed === "false"
      && (failure.error ?? "").includes("桌面歌词") && (failure.error ?? "").includes("重试")
      && (failure.error ?? "").includes("设置页")
      && actionable.retry && actionable.dismiss && actionable.barCopy === 1
      && failure.toasts === 0 && !actionable.rawErrorLeak,
    JSON.stringify({ failure: { error: failure.error, pressed: failure.pressed, toasts: failure.toasts }, actionable }));
  await page.screenshot({ path: path.join(guardDir, "r45c-toggle-failure.png") });

  await page.getByTestId("lyrics-toggle-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="lyrics-toggle-error"]') === null
    && document.querySelector('[data-testid="player-lyrics-toggle"]')?.getAttribute("aria-pressed") === "true");
  const recovered = await barState();
  add("playback-toggle-failure-recovers",
    recovered.requests.length === 2 && recovered.requests[1].checked === true
      && recovered.pressed === "true" && recovered.error === null && recovered.toasts === 0,
    JSON.stringify({ requests: recovered.requests, pressed: recovered.pressed, error: recovered.error }));
  await page.getByTestId("player-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().at(-1)?.checked === false);

  // ——— ⑤ 失败那句能关掉，且关掉不等于重试（不发命令） ———
  await plan({ delayMs: 0, failTimes: 1 });
  await page.evaluate(() => window.__guard.resetLyricsToggles());
  await page.getByTestId("player-lyrics-toggle").click();
  await page.getByTestId("lyrics-toggle-error").waitFor();
  await page.getByTestId("lyrics-toggle-dismiss").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="lyrics-toggle-error"]') === null);
  const dismissed = await barState();
  add("playback-toggle-failure-dismissible",
    dismissed.requests.length === 1 && dismissed.pressed === "false" && dismissed.error === null,
    JSON.stringify({ requests: dismissed.requests.length, pressed: dismissed.pressed }));

  // ——— ⑥ 沉浸页：收起按钮几何/不压官方控件，菜单 ESC 分层，开关失败在沉浸页说 ———
  await plan({ delayMs: 0, failTimes: 0 });
  await page.evaluate(() => window.__guard.resetLyricsToggles());
  await page.getByRole("button", { name: "歌词", exact: true }).click();
  const stage = page.getByTestId("playback-stage");
  await stage.waitFor();
  await page.waitForTimeout(700);
  const closeGeometry = await stage.evaluate((element) => {
    const button = element.querySelector('button[aria-label="收起歌词"]');
    if (!button) return null;
    const b = button.getBoundingClientRect();
    const center = b.x + b.width / 2;
    const hit = document.elementFromPoint(center, b.y + b.height / 2);
    const controls = document.querySelector('[data-testid="playback-stage-player"]')?.getBoundingClientRect();
    const overlapsControls = controls
      ? !(b.right <= controls.left || b.left >= controls.right || b.bottom <= controls.top || b.top >= controls.bottom)
      : true;
    return { center: Math.round(center), viewportCenter: Math.round(innerWidth / 2), top: Math.round(b.y), clickable: Boolean(hit && button.contains(hit)), overlapsControls };
  });
  add("playback-stage-close-centered",
    Boolean(closeGeometry) && closeGeometry.clickable && !closeGeometry.overlapsControls
      && Math.abs(closeGeometry.center - closeGeometry.viewportCenter) <= 2 && closeGeometry.top <= 16,
    JSON.stringify(closeGeometry));

  /**
   * R54：收起从"顶部中央一小块"扩成**顶部一整行**：宽度≈舞台宽度、箭头居中、
   * 行高只占顶部一条带（下面一点仍是歌词/封面，不被这一行挡住）。
   */
  const closeRow = await stage.evaluate((element) => {
    const row = element.querySelector('[data-testid="playback-stage-close-row"]');
    const icon = row?.querySelector("svg");
    if (!row || !icon) return { ok: false, missing: true };
    const stageRect = element.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const i = icon.getBoundingClientRect();
    const below = document.elementFromPoint(r.x + r.width / 2, r.bottom + 8);
    return {
      rowWidth: Math.round(r.width), stageWidth: Math.round(stageRect.width), top: Math.round(r.y),
      height: Math.round(r.height),
      rowCenterOffset: Math.round(r.x + r.width / 2 - innerWidth / 2),
      iconCenterOffset: Math.round(i.x + i.width / 2 - innerWidth / 2),
      belowIsRow: Boolean(below && row.contains(below)),
      label: row.getAttribute("aria-label"),
      ok: true,
    };
  });
  // 截图取舞台顶部一条带（箭头 + 下面露出的歌词/控件），供人工复核"整行"的观感
  const stageTopBox = await stage.boundingBox();
  if (stageTopBox) {
    await page.screenshot({
      path: path.join(guardDir, "r54-stage-close-row.png"),
      clip: { x: stageTopBox.x, y: stageTopBox.y, width: stageTopBox.width, height: 220 },
    });
  }
  add("r54-stage-close-row-full-width",
    closeRow.ok && closeRow.stageWidth - closeRow.rowWidth <= 2 && closeRow.top <= 2
      && Math.abs(closeRow.rowCenterOffset) <= 2 && Math.abs(closeRow.iconCenterOffset) <= 2
      && closeRow.height <= 48 && !closeRow.belowIsRow && closeRow.label === "收起歌词",
    JSON.stringify(closeRow));

  /**
   * R50（brief 第 1 项）：传输组只剩 上一首 → 播放 → 下一首，歌词开关在**下方工具行**尾部。
   *
   * 量几何而不是标记：开关的中心既不许落在"播放与下一首之间"，也不许落在传输行的高度带里；
   * 它自己约 32px（与音量/模式同档），并且与音量条/播放模式同一条水平线。
   * 「播放/下一首相邻」用"这段横带里除了它们自己没有任何其它可见按钮"来判。
   */
  const stageToggleGeometry = await stage.evaluate((element) => {
    const toggle = element.querySelector('[data-testid="stage-lyrics-toggle"]');
    const previous = element.querySelector('button[aria-label="上一首"]');
    const play = element.querySelector('button[aria-label="播放"], button[aria-label="暂停"]');
    const next = element.querySelector('button[aria-label="下一首"]');
    const mode = element.querySelector('button[aria-label^="播放模式："]');
    const volume = element.querySelector('[role="slider"][aria-label="音量"]');
    if (!toggle || !previous || !play || !next || !mode || !volume) return { ok: false, missing: true };
    const rect = (node) => node.getBoundingClientRect();
    const center = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    const t = rect(toggle), p = rect(previous), pl = rect(play), n = rect(next), m = rect(mode), v = rect(volume);
    const tc = center(t), plc = center(pl), nc = center(n), mc = center(m), vc = center(v);
    const betweenPlayAndNext = tc.x > plc.x && tc.x < nc.x;
    const inTransportRow = Math.abs(tc.y - plc.y) <= pl.height / 2;
    const rowBelow = tc.y > plc.y;
    /** 传输组里不许夹着别的按钮：播放与下一首之间的那条横带里，除它们自己没有可见按钮。 */
    const intruders = [...element.querySelectorAll("button")]
      .filter((node) => {
        const r = rect(node);
        const c = center(r);
        return r.width > 0 && c.y >= pl.top && c.y <= pl.bottom && c.x > plc.x && c.x < nc.x;
      })
      .filter((node) => node !== play && node !== next)
      .map((node) => node.getAttribute("aria-label") ?? ((node.textContent ?? "").trim() || node.tagName));
    return {
      ok: !betweenPlayAndNext && !inTransportRow && rowBelow
        && Math.abs(t.width - 32) <= 2 && Math.abs(t.height - 32) <= 2
        && Math.abs(tc.y - mc.y) <= 2 && Math.abs(tc.y - vc.y) <= 2 && tc.x > mc.x
        && plc.x < nc.x && intruders.length === 0,
      size: { width: Math.round(t.width), height: Math.round(t.height) },
      toggle: tc, previous: center(p), play: plc, next: nc, mode: mc, volume: vc,
      betweenPlayAndNext, inTransportRow, rowBelow, intruders,
    };
  });
  add("playback-stage-lyrics-toggle-tool-row", stageToggleGeometry.ok, JSON.stringify(stageToggleGeometry));

  await stage.getByRole("button", { name: /^播放模式：/ }).click();
  const menu = page.locator('[role="menu"]').first();
  await menu.waitFor();
  const menuLayering = await page.evaluate(() => {
    const menuNode = document.querySelector('[role="menu"]');
    const button = document.querySelector('[data-testid="playback-stage-close-row"]');
    // 与 Sheet 那条同理：量的是箭头的可见入口，不是整行（整行横跨舞台，与浮层相交是必然的）
    const arrow = button?.querySelector("svg");
    if (!menuNode || !button || !arrow) return { ok: false };
    const m = menuNode.getBoundingClientRect();
    const b = arrow.getBoundingClientRect();
    const hit = document.elementFromPoint(m.x + m.width / 2, m.y + m.height / 2);
    return {
      ok: Boolean(hit && menuNode.contains(hit)),
      overlapsClose: !(b.right <= m.left || b.left >= m.right || b.bottom <= m.top || b.top >= m.bottom),
    };
  });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  add("playback-stage-menu-layering",
    menuLayering.ok && !menuLayering.overlapsClose && await stage.isVisible(),
    JSON.stringify(menuLayering));
  add("playback-stage-menu-escape-keeps-stage", await stage.isVisible(), "菜单开着时 ESC 先关菜单，舞台留着");

  // Sheet 打开时：收起按钮不压上层（Sheet 走的是官方 portal/z 层），ESC 先关 Sheet
  const queueTrigger = page.getByRole("button", { name: "播放队列", exact: true });
  await queueTrigger.focus();
  await queueTrigger.press("Enter");
  const sheet = page.locator('[data-slot="sheet-content"]');
  await sheet.waitFor();
  const sheetLayering = await page.evaluate(() => {
    const content = document.querySelector('[data-slot="sheet-content"]');
    const button = document.querySelector('[data-testid="playback-stage-close-row"]');
    // 收起入口是**整行**（横跨舞台），Sheet 是右侧抽屉，必然与行本身相交；
    // 这里量的是"箭头这处可见入口没被上层盖住"，与 R45C 的意图一致。
    const arrow = button?.querySelector("svg");
    if (!content || !button || !arrow) return { ok: false };
    const s = content.getBoundingClientRect();
    const b = arrow.getBoundingClientRect();
    const hit = document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2);
    return {
      ok: Boolean(hit && content.contains(hit)),
      overlapsClose: !(b.right <= s.left || b.left >= s.right || b.bottom <= s.top || b.top >= s.bottom),
    };
  });
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  add("playback-stage-sheet-layering",
    sheetLayering.ok && !sheetLayering.overlapsClose && await stage.isVisible(),
    JSON.stringify(sheetLayering));

  await page.keyboard.press("Escape");
  add("playback-stage-escape-closes", await stage.count() === 0, "没有上层弹窗时 ESC 关闭舞台");

  // R54：行内任意位置都能收起（点在行的左端，而不是箭头所在的中线上）
  await page.getByRole("button", { name: "歌词", exact: true }).click();
  await stage.waitFor();
  await page.waitForTimeout(600);
  await stage.click({ position: { x: 40, y: 20 } });
  const closedByRow = await stage.count() === 0;
  add("r54-stage-close-row-anywhere", closedByRow, "行的左端（远离箭头）点击同样收起沉浸页");

  /**
   * R54：底栏总时长。队列摆好但一次都没播（音频没装载）时，读数要来自条目元数据秒数；
   * 条目也没有时长字段才是「—」，此时进度条保持禁用（范围未知）。
   */
  await page.evaluate(() => window.__guard.queueWithTrackDuration(184));
  await page.waitForTimeout(200);
  const barDuration = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="player-bar"]');
    const slider = bar?.querySelector('[data-slot="slider"]');
    return {
      total: document.querySelector('[data-testid="player-duration"]')?.textContent?.trim() ?? "",
      durationMs: window.__guard.snapshot().durationMs,
      sliderDisabled: slider?.hasAttribute("data-disabled") ?? true,
      sliderMax: slider?.querySelector('[data-slot="slider-thumb"]')?.getAttribute("aria-valuemax") ?? null,
    };
  });
  const durationBarBox = await page.getByTestId("player-bar").boundingBox();
  if (durationBarBox) await page.screenshot({ path: path.join(guardDir, "r54-player-bar-duration.png"), clip: durationBarBox });
  add("r54-player-bar-duration-from-metadata",
    barDuration.total === "3:04" && barDuration.durationMs === 184_000 && !barDuration.sliderDisabled,
    JSON.stringify(barDuration));

  await page.evaluate(() => window.__guard.queueWithTrackDuration(null));
  await page.waitForTimeout(200);
  const barUnknown = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="player-bar"]');
    const slider = bar?.querySelector('[data-slot="slider"]');
    return {
      total: document.querySelector('[data-testid="player-duration"]')?.textContent?.trim() ?? "",
      sliderDisabled: slider?.hasAttribute("data-disabled") ?? false,
    };
  });
  add("r54-player-bar-unknown-duration-dash", barUnknown.total === "—" && barUnknown.sliderDisabled,
    JSON.stringify(barUnknown));

  await page.getByRole("button", { name: "歌词", exact: true }).click();
  await stage.waitFor();
  await page.waitForTimeout(600);
  await plan({ delayMs: 0, failTimes: 1 });
  await page.evaluate(() => window.__guard.resetLyricsToggles());
  await stage.getByTestId("stage-lyrics-toggle").click();
  await page.getByTestId("stage-lyrics-toggle-error").waitFor();
  const stageFailure = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="stage-lyrics-toggle-error"]');
    return {
      text: box?.textContent?.trim() ?? "",
      retry: Boolean(box?.querySelector('[data-testid="stage-lyrics-toggle-retry"]')),
      dismiss: Boolean(box?.querySelector('[data-testid="stage-lyrics-toggle-dismiss"]')),
      barCopy: document.querySelectorAll('[data-testid="lyrics-toggle-error"]').length,
      toasts: document.querySelectorAll('[data-sonner-toast]').length,
    };
  });
  add("playback-stage-toggle-failure-actionable",
    stageFailure.text.includes("桌面歌词") && stageFailure.text.includes("重试") && stageFailure.text.includes("设置页")
      && stageFailure.retry && stageFailure.dismiss && stageFailure.barCopy === 0 && stageFailure.toasts === 0,
    JSON.stringify(stageFailure));
  await stage.getByTestId("stage-lyrics-toggle-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stage-lyrics-toggle-error"]') === null
    && document.querySelector('[data-testid="stage-lyrics-toggle"]')?.getAttribute("aria-pressed") === "true");
  const stageRecovered = await page.evaluate(() => ({
    requests: window.__guard.toggleLog(),
    pressed: document.querySelector('[data-testid="stage-lyrics-toggle"]')?.getAttribute("aria-pressed"),
  }));
  add("playback-stage-toggle-failure-recovers",
    stageRecovered.requests.length === 2 && stageRecovered.requests[1].checked === true && stageRecovered.pressed === "true",
    JSON.stringify(stageRecovered));
  await stage.getByTestId("stage-lyrics-toggle").click();
  await page.waitForFunction(() => window.__guard.toggleLog().at(-1)?.checked === false);
  await plan({ delayMs: 0, failTimes: 0 });
  await page.keyboard.press("Escape");
  await stage.waitFor({ state: "detached" });
}

/**
 * R45C：没有 `lyrics` binding 时，播放栏与沉浸页都不出现死按钮、也不崩。
 *
 * 挂在另一份**真的不传 lyrics** 的挂载点上（`?surface=no-lyrics`），因为 `LibraryShell`
 * 永远会造 binding——在它里面证明不了"没有 binding 会怎样"。
 */
export async function checkNoBindingSurface(page, port, add) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${port}/index.html?surface=no-lyrics`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__guard !== undefined, null, { timeout: 15_000 });
  await page.evaluate(() => window.__guard.ready());
  await page.waitForFunction(() => window.__guard.snapshot().durationMs > 0);
  await page.waitForTimeout(500);
  const surface = await page.evaluate(() => {
    const playButtons = (root) => [...document.querySelectorAll(`${root} button`)]
      .filter((button) => ["播放", "暂停"].includes(button.getAttribute("aria-label") ?? "")).length;
    return {
      bar: document.querySelectorAll('[data-testid="player-bar"]').length,
      stage: document.querySelectorAll('[data-testid="playback-stage"]').length,
      barToggles: document.querySelectorAll('[data-testid="player-lyrics-toggle"]').length,
      stageToggles: document.querySelectorAll('[data-testid="stage-lyrics-toggle"]').length,
      barPlay: playButtons('[data-testid="player-bar"]'),
      stagePlay: playButtons('[data-testid="playback-stage"]'),
      lyricsWindow: document.querySelectorAll('[data-testid="lyrics-window"]').length,
    };
  });
  add("playback-no-binding-no-dead-button",
    surface.bar === 1 && surface.stage === 1 && surface.barToggles === 0 && surface.stageToggles === 0
      && surface.barPlay === 1 && surface.stagePlay === 1 && surface.lyricsWindow === 0,
    JSON.stringify(surface));
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

/** 文字 Range 的稳定外框（等 12 帧不动才算数：AMLL 的弹簧动画会让它一直漂）。 */
async function stableTextBox(page, selector) {
  return page.locator(selector).first().evaluate(async (element) => {
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
}

/** 裁到文字 Range；与隐藏同一文字后的像素比较，不能把背景/表格误算成歌词。 */
async function textPixels(page, selector, theme, file) {
  const box = await stableTextBox(page, selector);
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

/**
 * R45B：量「墨色 vs 背景」的亮度差（只统计与"隐藏文字"不同的像素，所以背景不参与）。
 *
 * 为什么要它：桌面歌词窗是**透明窗**，官方组件还带 `mix-blend-mode: plus-lighter`，
 * 所以"字是深的还是浅的"取决于下面是桌面壁纸——截图里只能确定"字与背景差多少"。
 * 于是这一项问的是可读性本身（墨色亮度 vs 背景亮度 ≥ 40），而不是"必须比某条阈值深"。
 */
async function inkContrast(page, selector, file) {
  const box = await stableTextBox(page, selector);
  if (!box || box.width <= 0 || box.height <= 0) return { changed: 0, inkMean: null, backdropMean: null, contrast: 0, box };
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
  const luminance = (buffer, index) => buffer[index] * 0.299 + buffer[index + 1] * 0.587 + buffer[index + 2] * 0.114;
  let changed = 0;
  let inkSum = 0;
  let backdropSum = 0;
  const inkSumRgb = [0, 0, 0];
  for (let i = 0; i < a.length; i += 3) {
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) < 40) continue;
    changed += 1;
    inkSum += luminance(a, i);
    backdropSum += luminance(b, i);
    inkSumRgb[0] += a[i];
    inkSumRgb[1] += a[i + 1];
    inkSumRgb[2] += a[i + 2];
  }
  const inkMean = changed > 0 ? Math.round(inkSum / changed) : 0;
  const backdropMean = changed > 0 ? Math.round(backdropSum / changed) : 0;
  return {
    changed,
    inkMean,
    backdropMean,
    contrast: Math.abs(inkMean - backdropMean),
    inkRgb: changed > 0 ? inkSumRgb.map((value) => Math.round(value / changed)) : null,
    box,
  };
}

/** 兼容旧名字：主窗舞台那几项仍然用"深/浅两类像素"的口径（不透明舞台，含 canvas）。 */
async function inkColor(page, selector, file) {
  const box = await stableTextBox(page, selector);
  if (!box || box.width <= 0 || box.height <= 0) return { count: 0, mean: null, box };
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
  let count = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < a.length; i += 3) {
    if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) < 40) continue;
    count += 1;
    sum[0] += a[i];
    sum[1] += a[i + 1];
    sum[2] += a[i + 2];
  }
  return { count, box, mean: count > 0 ? sum.map((value) => Math.round(value / count)) : null };
}

export async function checkDesktopSurface(page, guardDir, add) {
  const desktop = page.getByTestId("lyrics-window");
  await page.evaluate(() => window.__guard.desktopDocument());
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => {
      window.__guard.setHostTheme(choice);
      document.documentElement.className = choice;
    }, theme);
    await page.setViewportSize({ width: 800, height: 128 });
    await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop", style: "panel", color: "contrast", locked: false }));
    await page.waitForTimeout(700);
    // R45B：桌面歌词窗是透明窗 + `plus-lighter`，所以可读性看"墨色与背景的亮度差"，不看绝对的深浅
    const pixels = await inkContrast(page, '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]', path.join(guardDir, `${theme}-panel-contrast.png`));
    const rawColor = await page.evaluate(() => window.__guard.desktopConfig().color);
    add(`${theme}-panel-contrast-ink`, pixels.changed > 60 && pixels.contrast > 40 && rawColor === "contrast", JSON.stringify({ ...pixels, rawColor }));
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
  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop", style: "clean", color: "foreground", showControls: true }));
}

/**
 * R58：桌面/任务栏歌词的**行内逐字扫亮**——同一行两个时刻已唱字变多、同一时刻已唱明显浓于未唱；
 * 再把 rAF 摘掉（真窗里=窗没有帧），进度消息仍必须把官方组件从暂停推到播放（这是扫描推进的前提）。
 */
export async function checkLyricsKaraoke(page, guardDir, add) {
  const activeLine = '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]';
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  /** 当前行的逐字状态：字形框、官方遮罩位置、官方逐词动画的播放态。 */
  const readWords = () => page.evaluate((selector) => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const player = stage?.querySelector(".amll-lyric-player");
    const line = document.querySelector(selector);
    const playerRect = player?.getBoundingClientRect();
    return {
      active: line?.textContent ?? null,
      player: playerRect ? { top: Math.round(playerRect.top), height: Math.round(playerRect.height) } : null,
      mode: stage?.dataset.lyricsMode ?? null,
      words: [...(line?.querySelectorAll("span") ?? [])]
        .filter((span) => span.children.length === 0 && (span.textContent ?? "").length === 1)
        .map((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          const rect = range.getBoundingClientRect();
          const fade = (span.getAnimations ? span.getAnimations() : []).find((animation) => animation.id.startsWith("fade-word"));
          return {
            text: span.textContent,
            box: [rect.left, rect.top, rect.width, rect.height],
            mask: Math.round(Number.parseFloat(getComputedStyle(span).maskPosition) || 0),
            playState: fade?.playState ?? null,
            inside: playerRect
              ? rect.top >= playerRect.top - 1 && rect.bottom <= playerRect.bottom + 1
                && rect.left >= playerRect.left - 1 && rect.right <= playerRect.right + 1
              : false,
          };
        }),
    };
  }, activeLine);
  /**
   * 一个字盒里的墨色分位：浅色主题看 p5（已唱是深墨，未唱被压到 40% 透明度而变浅），
   * 深色主题反过来看 p95。取分位而不是均值：字形只占盒子的一部分。
   */
  const charInk = async (png, box, meta) => {
    const left = Math.max(0, Math.round(box[0]));
    const top = Math.max(0, Math.round(box[1]));
    const width = Math.min(meta.width - left, Math.round(box[2]));
    const height = Math.min(meta.height - top, Math.round(box[3]));
    if (width <= 0 || height <= 0) return null;
    const raw = await sharp(png).extract({ left, top, width, height }).removeAlpha().raw().toBuffer();
    const lums = [];
    for (let index = 0; index < raw.length; index += 3) {
      lums.push(raw[index] * 0.299 + raw[index + 1] * 0.587 + raw[index + 2] * 0.114);
    }
    lums.sort((a, b) => a - b);
    const at = (quantile) => Math.round(lums[Math.min(lums.length - 1, Math.floor(lums.length * quantile))]);
    return { p5: at(0.05), p95: at(0.95) };
  };
  const sungInk = (ink, theme) => (ink === null ? null : theme === "dark" ? ink.p95 : ink.p5);
  const isSung = (value, theme) => value !== null && (theme === "dark" ? value >= 150 : value <= 120);
  /** 开一轮进度泵（每 100ms 一条，时间按真实经过推进）；下一轮会先掐掉上一轮。 */
  const startProgress = (fromMs, spanMs = 2400) => page.evaluate(({ from, span }) => {
    clearTimeout(window.__r58Driver);
    const started = performance.now();
    const tick = () => {
      const at = performance.now() - started;
      void window.__guard.desktopProgress({ timeMs: from + Math.round(at), playing: true, seekGeneration: 100 });
      if (at < span) window.__r58Driver = setTimeout(tick, 100);
    };
    tick();
  }, { from: fromMs, span: spanMs });
  const stopProgress = () => page.evaluate(() => { clearTimeout(window.__r58Driver); });
  /** 等一会儿，读逐字状态并截图。 */
  const readAt = async (label, dwellMs, theme) => {
    await page.waitForTimeout(dwellMs);
    const state = await readWords();
    const png = await page.screenshot({ type: "png", path: path.join(guardDir, `r58-${label}.png`) });
    const meta = await sharp(png).metadata();
    const inks = [];
    for (const word of state.words) inks.push(await charInk(png, word.box, meta));
    return { ...state, inks, sung: inks.map((ink) => sungInk(ink, theme)) };
  };
  const runMode = async (label, config, viewport, theme) => {
    await page.setViewportSize(viewport);
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await configure(config);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__guard.desktopDocument());
    await page.waitForTimeout(250);
    await startProgress(600);
    const early = await readAt(`${label}-t1`, 700, theme);
    const late = await readAt(`${label}-t2`, 1400, theme);
    await stopProgress();
    const earlySung = early.sung.filter((value) => isSung(value, theme)).length;
    const lateSung = late.sung.filter((value) => isSung(value, theme)).length;
    const sungValues = early.sung.filter((value) => isSung(value, theme));
    const unsungValues = early.sung.filter((value) => !isSung(value, theme));
    const contrast = sungValues.length && unsungValues.length
      ? Math.round(theme === "dark" ? Math.min(...sungValues) - Math.max(...unsungValues)
        : Math.max(...unsungValues) - Math.min(...sungValues))
      : 0;
    add(`r58-${label}-sweep`,
      early.active === late.active && Boolean(early.active) && early.words.length >= 5
        && early.words.every((word) => word.inside)
        && lateSung - earlySung >= 2 && lateSung >= 5 && contrast >= 40,
      JSON.stringify({ active: early.active, player: early.player, ink1: early.sung, ink2: late.sung,
        sung: [earlySung, lateSung], contrast, mask1: early.words.map((word) => word.mask) }));
    return late;
  };

  const baseline = { ...DESKTOP_BASELINE, locked: true, showControls: false };
  /** 重挂歌词窗：拿一份"还没有任何进度"的干净起点（这时官方组件必然是暂停态）。 */
  const remount = async () => {
    await page.evaluate(() => window.__guard.setDesktop(false));
    await page.getByTestId("lyrics-window").waitFor({ state: "detached" });
    await page.evaluate(() => window.__guard.setDesktop(true));
    await page.getByTestId("lyrics-window").waitFor();
    await page.waitForTimeout(400);
  };

  /**
   * 播放态由进度消息驱动。重挂之后官方组件停在暂停态，再把 rAF 摘掉：此后只剩进度消息能带来
   * 重渲染的时机，官方组件的逐词动画必须从 paused 变 running——否则整行扫亮停在换行那一刻。
   */
  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ ...DESKTOP_BASELINE });
  await remount();
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(400);
  const beforeStub = await readWords();
  await page.evaluate(() => { window.__r58Raf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
  for (const timeMs of [900, 1400, 1900, 2400, 2900]) {
    await page.evaluate((ms) => window.__guard.desktopProgress({ timeMs: ms, playing: true, seekGeneration: 100 }), timeMs);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
  const whilePlaying = await readWords();
  const playingLabel = await page.getByTestId("lyrics-controls").locator('[aria-label="暂停"], [aria-label="播放"]').first().getAttribute("aria-label");
  add("r58-playing-follows-progress",
    beforeStub.words.length >= 5 && beforeStub.words.every((word) => word.playState === "paused")
      && whilePlaying.words.length >= 5 && whilePlaying.words.every((word) => word.playState !== "paused")
      && playingLabel === "暂停" && whilePlaying.active === beforeStub.active,
    JSON.stringify({ before: beforeStub.words.map((word) => word.playState), maskBefore: beforeStub.words.map((word) => word.mask),
      after: whilePlaying.words.map((word) => word.playState), maskAfter: whilePlaying.words.map((word) => word.mask),
      playingLabel, active: whilePlaying.active }));
  await page.evaluate(() => { window.requestAnimationFrame = window.__r58Raf; window.__r58Raf = undefined; });
  // 帧循环是 effect 起的，摘过一次就断了：重挂一次让后来的用例有正常的帧
  await remount();

  await runMode("desktop-clean", { ...baseline }, { width: 800, height: 128 }, "light");
  await runMode("desktop-panel", { ...baseline, style: "panel", color: "contrast" }, { width: 800, height: 128 }, "dark");
  await runMode("taskbar-clean", { ...baseline, mode: "taskbar", size: "md" }, { width: 1200, height: 44 }, "light");
  // 竖版（R61 整体重做）：只记录现状，不断言（逐字/滚动由 checkDesktopInteraction 的 r61-* 判）
  await page.setViewportSize({ width: 260, height: 520 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ ...baseline, layout: "vertical" });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(300);
  await startProgress(600);
  await page.waitForTimeout(700);
  const verticalStatus = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="lyrics-vertical"]');
    const tokens = [...(root?.querySelectorAll("[data-vertical-token]") ?? [])];
    return {
      text: root?.querySelector('[data-testid="lyrics-vertical-line"]')?.textContent ?? null,
      sung: tokens.filter((token) => token.className.includes("is-sung")).length,
      states: tokens.map((token) => (token.className.match(/is-(\w+)/) ?? [])[1] ?? null),
      font: root ? Number.parseFloat(getComputedStyle(root.querySelector(".vertical-lyric__track")).fontSize) : null,
    };
  });
  await stopProgress();
  add("r58-vertical-status", true,
    JSON.stringify({ note: "竖版只记录现状（R61 重做为自渲染单列）", ...verticalStatus }));

  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ ...DESKTOP_BASELINE });
  await page.waitForTimeout(300);
}

/** 桌面歌词窗的默认起点（每一项断言前都先归位：前面的用例会一路改配置）。 */
const DESKTOP_BASELINE = {
  mode: "desktop", layout: "horizontal", style: "clean", color: "foreground", customColor: "",
  locked: false, showControls: true, size: "lg", enableBlur: true, enableScale: true, enableSpring: true,
  // R59：任务栏那一套字段与桌面各存一份（一起归位，免得上一项改过的值漏到下一项）
  taskbarSize: "txxl", taskbarColor: "foreground", taskbarCustomColor: "", taskbarKaraoke: true,
};

/**
 * R45B：桌面歌词的**交互**验收（锁定 / 缩放 / 竖排 / 逐字 / 颜色）。
 *
 * 每一项都钉一个"看起来做了、其实没做"的地方：
 * 1. 锁定时图标是 **Lock**（此前反了）、无障碍名称说清"已锁定"、按压态为 true；
 * 2. 锁定后窗口里**只剩**解锁按钮，且不悬停时不可见；悬停后可见且真的可点；
 * 3. 解锁后拖动柄/媒体/外观/缩放柄全部回来，媒体动作仍只发一次；
 * 4. 右下角缩放柄调用官方 `startResizeDragging("SouthEast")`（mock 计数），锁定/任务栏时连按钮都不存在；
 * 5. 尺寸稳定 250ms 后保存 DIP 宽高；锁定时不再保存（Rust 那边窗口也不可缩放）；
 * 6. 竖版是**真竖排**：同一列的字符 x 相同、y 严格递增（横排对照则 x 递增）——不是窄窗换行；
 * 7. 竖版下切到第二行仍是官方组件在排版，当前行整行都在播放器范围内；
 * 8. **最小窗口 240×120**（Rust 里写的下限）里当前行仍整行可读、墨迹真的画在窗口里；
 *    真滚轮往书写方向滚，被裁到窗口外的另一行能滚进来，超大的滚轮被钳住（不会越界滚到屏外）；
 * 9. 行级 LRC 推导出逐字词（一个字一个 span，行级 LRC 只会有 1 个），播放推进时行内像素变化；
 * 10. 自定义颜色真的改到了 AMLL 的像素上（墨色变绿），清空后回到设计令牌。
 */
export async function checkDesktopInteraction(page, guardDir, add) {
  const desktop = page.getByTestId("lyrics-window");
  const activeLine = '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]';
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  /**
   * 横版对照用：量 AMLL 当前行每个字的**字形框**（`Range` 选中文字本身，不是带 -1em/1em 的
   * span 盒子）。竖版不用这个辅助——竖版是自渲染的一列，量法见 `verticalGeometry`。
   */
  const charGeometry = (slack = 1) => page.evaluate((pad) => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const player = stage?.querySelector(".amll-lyric-player");
    const line = stage?.querySelector('[class*="lyricMainLine"][class*="active"]');
    const playerRect = player?.getBoundingClientRect();
    /**
     * 每个字的**字形框**（`Range` 选中文字本身），不是 span 的盒子：
     * AMLL 的每个词 span 带 `margin:-1em; padding:1em`，盒子比字形大 2em，
     * 拿盒子判"是否在窗口内"会把贴着边的一列误判成越界。
     */
    const chars = [...(line?.querySelectorAll("span") ?? [])]
      .filter((span) => span.children.length === 0 && (span.textContent ?? "").length === 1)
      .map((span) => {
        const range = document.createRange();
        range.selectNodeContents(span);
        const rect = range.getBoundingClientRect();
        const insideX = playerRect ? rect.left >= playerRect.left - pad && rect.right <= playerRect.right + pad : false;
        const insideY = playerRect ? rect.top >= playerRect.top - pad && rect.bottom <= playerRect.bottom + pad : false;
        return {
          text: span.textContent,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          insideX,
          insideY,
          inside: insideX && insideY,
        };
      });
    /**
     * 书写模式读**行内容**（竖排真正的落点），也读播放器（横版对照时两者相同）。
     * R45B fix2：竖排必须写在行内容上——写在播放器上会让官方按 `blockSize` 量出来的
     * "行高"变成"一行有多少列那么宽"，当前行就被推到窗口外（见 ⑦c）。
     */
    const lineStyle = line ? getComputedStyle(line) : null;
    const playerStyle = player ? getComputedStyle(player) : null;
    /**
     * R46：行盒（官方量高的那个 wrapper）与播放器的纵向关系。
     * 当前行必须被官方**居中**（wrap 中心 ≈ 播放器中心），且行盒不许比播放器高——
     * 高出多少，上下就会被 `overflow: hidden` 裁掉多少（这就是 brief 说的"底部剪掉"）。
     */
    const wrapper = line?.closest('[class*="lyricLineWrapper"]');
    const wrapperRect = wrapper?.getBoundingClientRect();
    return {
      chars,
      lineCount: stage?.querySelectorAll('[class*="lyricLineWrapper"] [class*="lyricMainLine"]').length ?? 0,
      writingMode: lineStyle?.writingMode ?? null,
      textOrientation: lineStyle?.textOrientation ?? null,
      /** 整行有没有被 transform 旋转（"整行旋转 90°"的假竖排判定）。 */
      lineTransform: lineStyle?.transform ?? null,
      fontSize: playerStyle ? Number.parseFloat(playerStyle.fontSize) : null,
      playerWritingMode: playerStyle?.writingMode ?? null,
      playerBox: playerRect ? { top: Math.round(playerRect.top), bottom: Math.round(playerRect.bottom), height: Math.round(playerRect.height) } : null,
      wrapperBox: wrapperRect ? {
        top: Math.round(wrapperRect.top), bottom: Math.round(wrapperRect.bottom),
        height: Math.round(wrapperRect.height), center: Math.round(wrapperRect.top + wrapperRect.height / 2),
      } : null,
      playerScroll: player ? { scrollW: player.scrollWidth, clientW: player.clientWidth, scrollLeft: player.scrollLeft, scrollH: player.scrollHeight, clientH: player.clientHeight, overflowX: getComputedStyle(player).overflowX, bar: player.offsetHeight - player.clientHeight } : null,
      activeText: line?.textContent ?? "",
      /** 每条行盒的 y（官方用 `translateY` 排版）：判断"滚轮真的动了 / 动到边界就不再动"用它。 */
      lineTops: [...(stage?.querySelectorAll('[class*="lyricLineWrapper"]') ?? [])]
        .map((wrapper) => Math.round(wrapper.getBoundingClientRect().y)),
      nextLineVisible: [...(stage?.querySelectorAll('[class*="lyricLineWrapper"]') ?? [])]
        .filter((wrapper) => !wrapper.querySelector('[class*="active"]'))
        .some((wrapper) => [...wrapper.querySelectorAll("span")].some((span) => {
          if (span.children.length > 0 || (span.textContent ?? "").length !== 1) return false;
          const range = document.createRange();
          range.selectNodeContents(span);
          const rect = range.getBoundingClientRect();
          return playerRect
            ? rect.left >= playerRect.left - pad && rect.right <= playerRect.right + pad
              && rect.top >= playerRect.top - pad && rect.bottom <= playerRect.bottom + pad
            : false;
        })),
    };
  }, slack);
  /** 同一列的字符（x 相差 ≤2px 算一列），列内 y 必须严格递增。 */
  const columnReport = (chars) => {
    const columns = [];
    for (const char of chars) {
      const column = columns.find((entry) => Math.abs(entry.x - char.x) <= 2);
      if (column) column.chars.push(char);
      else columns.push({ x: char.x, chars: [char] });
    }
    const increasing = columns.every((column) => column.chars.every((char, index) => index === 0 || char.y > column.chars[index - 1].y));
    const distinctX = new Set(columns.map((column) => column.x)).size;
    const longest = Math.max(0, ...columns.map((column) => column.chars.length));
    return { columns: columns.length, distinctX, longest, increasing };
  };

  await configure(DESKTOP_BASELINE);
  await page.setViewportSize({ width: 800, height: 128 });
  await page.waitForTimeout(500);

  // ① 未锁：完整控制都在（拖动柄 / 媒体 / 外观 / 锁定 / 右下角缩放柄）
  const grip = page.getByRole("button", { name: "拖动桌面歌词", exact: true });
  const resizeGrip = page.getByTestId("lyrics-resize-grip");
  const unlockedControls = {
    grip: await grip.count(),
    media: await desktop.locator('[data-testid="lyrics-controls"] button[aria-label="播放"], [data-testid="lyrics-controls"] button[aria-label="暂停"]').count(),
    appearance: await desktop.getByRole("button", { name: "桌面歌词外观", exact: true }).count(),
    lock: await desktop.getByRole("button", { name: "锁定桌面歌词", exact: true }).count(),
    resize: await resizeGrip.count(),
  };
  add("desktop-explicit-grip", unlockedControls.grip === 1, "AMLL 子树之外有官方 startDragging 拖柄");
  add("desktop-unlocked-full-controls", unlockedControls.media === 1 && unlockedControls.appearance === 1
    && unlockedControls.lock === 1 && unlockedControls.resize === 1, JSON.stringify(unlockedControls));

  // ② 拖动：拖柄与正文各触发一次官方 startDragging（按钮区不算拖动）
  const dragBefore = await page.evaluate(() => window.__guard.dragCount());
  await grip.click();
  await desktop.locator('[class*="lyricMainLine"]').first().click();
  const dragAfter = await page.evaluate(() => window.__guard.dragCount());
  add("desktop-drag-grip-and-body", dragAfter === dragBefore + 2, JSON.stringify({ dragBefore, dragAfter }));

  // ③ 缩放拖柄：官方 startResizeDragging("SouthEast")
  const resizeBefore = await page.evaluate(() => window.__guard.resizeCalls());
  await resizeGrip.click();
  await page.waitForTimeout(150);
  const resizeAfter = await page.evaluate(() => window.__guard.resizeCalls());
  add("desktop-resize-grip-official-call", resizeAfter.length === resizeBefore.length + 1
    && resizeAfter.at(-1) === "SouthEast", JSON.stringify({ resizeBefore, resizeAfter }));

  // ④ 锁定：图标是 Lock、只剩一个按钮、不悬停看不见
  await configure({ locked: true });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(350);
  const lockedState = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const slot = stage?.querySelector('[data-testid="lyrics-unlock-slot"]');
    const unlock = slot?.querySelector("button");
    // 「悬停才显形」是 CSS 事实：基础态 opacity 0 + 一条只在 :hover 下生效的 opacity 1 规则。
    // 断言这两条规则**真的在样式表里**，再配一条真悬停的实测（下面 hover-reveal 那一项）。
    // Tailwind 把 hover 变体包在 `@media (hover:hover)` 里，所以要递归进 CSSMediaRule。
    const collect = (rules, out = []) => {
      for (const rule of rules) {
        if (rule.selectorText) out.push({ selector: rule.selectorText, opacity: rule.style?.opacity ?? null });
        if (rule.cssRules) collect(rule.cssRules, out);
      }
      return out;
    };
    const rules = [...document.styleSheets].flatMap((sheet) => {
      try { return collect(sheet.cssRules); } catch { return []; }
    });
    const revealRule = rules.find((rule) => rule.selector.includes("group-hover") && rule.opacity === "1");
    const hiddenRule = rules.find((rule) => rule.selector.includes('[data-testid="lyrics-unlock-slot"]') && rule.opacity === "0");
    return {
      locked: stage?.getAttribute("data-lyrics-locked") ?? null,
      buttons: stage ? stage.querySelectorAll("button").length : -1,
      label: unlock?.getAttribute("aria-label") ?? null,
      pressed: unlock?.getAttribute("aria-pressed") ?? null,
      lockIcon: Boolean(unlock?.querySelector(".lucide-lock")),
      unlockIcon: Boolean(unlock?.querySelector(".lucide-lock-open")),
      baseOpacityZero: (slot?.className ?? "").includes("opacity-0"),
      revealIsHoverGated: Boolean(revealRule && revealRule.selector.includes(":hover")),
      hasBaseRule: Boolean(hiddenRule) || (slot?.className ?? "").includes("opacity-0"),
      drag: stage ? stage.querySelectorAll('button[aria-label="拖动桌面歌词"]').length : -1,
      media: stage ? stage.querySelectorAll('button[aria-label="播放"], button[aria-label="暂停"]').length : -1,
      appearance: stage ? stage.querySelectorAll('button[aria-label="桌面歌词外观"]').length : -1,
      resize: stage ? stage.querySelectorAll('[data-testid="lyrics-resize-grip"]').length : -1,
    };
  });
  add("desktop-locked-shows-lock-icon", lockedState.locked === "on" && lockedState.lockIcon && !lockedState.unlockIcon
    && lockedState.pressed === "true" && (lockedState.label ?? "").includes("已锁定"), JSON.stringify(lockedState));
  add("desktop-locked-only-unlock", lockedState.buttons === 1 && lockedState.drag === 0 && lockedState.media === 0
    && lockedState.appearance === 0 && lockedState.resize === 0 && lockedState.baseOpacityZero
    && lockedState.revealIsHoverGated && lockedState.hasBaseRule, JSON.stringify(lockedState));
  await desktop.hover();
  await page.waitForTimeout(300);
  const hoverReveal = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="lyrics-unlock-slot"]');
    const button = slot?.querySelector("button");
    const rect = button?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null;
    return { opacity: slot ? Number.parseFloat(getComputedStyle(slot).opacity) : null, clickable: Boolean(hit && button.contains(hit)) };
  });
  add("desktop-locked-hover-reveals-unlock", hoverReveal.opacity === 1 && hoverReveal.clickable, JSON.stringify(hoverReveal));

  // ⑤ 解锁：完整控制回归，媒体动作仍只发一次
  await page.getByRole("button", { name: /已锁定桌面歌词/ }).click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(350);
  const unlockedState = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const lock = stage?.querySelector("button[aria-pressed]");
    return {
      locked: stage?.getAttribute("data-lyrics-locked") ?? null,
      grip: stage ? stage.querySelectorAll('button[aria-label="拖动桌面歌词"]').length : -1,
      resize: stage ? stage.querySelectorAll('[data-testid="lyrics-resize-grip"]').length : -1,
      appearance: stage ? stage.querySelectorAll('button[aria-label="桌面歌词外观"]').length : -1,
      label: lock?.getAttribute("aria-label") ?? null,
      lockIcon: Boolean(lock?.querySelector(".lucide-lock")),
      unlockIcon: Boolean(lock?.querySelector(".lucide-lock-open")),
      pressed: lock?.getAttribute("aria-pressed") ?? null,
    };
  });
  add("desktop-unlocked-controls-return", unlockedState.locked === "off" && unlockedState.grip === 1
    && unlockedState.resize === 1 && unlockedState.appearance === 1 && unlockedState.label === "锁定桌面歌词"
    && unlockedState.unlockIcon && unlockedState.pressed === "false", JSON.stringify(unlockedState));
  const actionsBefore = await page.evaluate(() => window.__guard.mediaActions().length);
  await desktop.getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForFunction(() => window.__guard.snapshot().status === "playing");
  await page.evaluate(() => window.__guard.desktopDocument());
  const actionsAfter = await page.evaluate(() => window.__guard.mediaActions());
  add("desktop-media-once", actionsAfter.length === actionsBefore + 1 && actionsAfter.at(-1) === "toggle", JSON.stringify(actionsAfter));
  await page.evaluate(() => window.__guard.desktopDocument());

  // ⑥ 缩放保存：稳定 250ms 后发一条带 DIP 宽高的窄命令；锁定时一条都不发
  await page.evaluate(() => window.__guard.resetConfigureCalls());
  await page.setViewportSize({ width: 420, height: 300 });
  await page.waitForTimeout(800);
  const sizeCalls = await page.evaluate(() => window.__guard.configureCalls().filter((patch) => "windowWidth" in patch || "windowHeight" in patch));
  const savedConfig = await page.evaluate(() => window.__guard.desktopConfig());
  add("desktop-resize-saves-dip", sizeCalls.length >= 1 && savedConfig.windowWidth === 420 && savedConfig.windowHeight === 300,
    JSON.stringify({ sizeCalls, saved: { width: savedConfig.windowWidth, height: savedConfig.windowHeight } }));
  await configure({ locked: true });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__guard.resetConfigureCalls());
  await page.setViewportSize({ width: 500, height: 360 });
  await page.waitForTimeout(800);
  const lockedSizeCalls = await page.evaluate(() => window.__guard.configureCalls().filter((patch) => "windowWidth" in patch));
  add("desktop-locked-no-resize-save", lockedSizeCalls.length === 0, JSON.stringify({ lockedSizeCalls }));
  await configure({ locked: false });

  /**
   * R61 竖版重做（`VerticalLyricColumn` + `vertical-lyrics.mjs`）：一句一列、字号随窗口宽度、
   * 长句按演唱进度平移、逐字扫亮、译文第二列。
   *
   * 有意整块替换 R45B/R46/fix4 的竖版用例：那些量的是"给 AMLL 播放器打补丁"的行为（行盒折列、
   * 横向滚动条、RTL 滚动容器）。竖版现在自渲染，选择器与几何判据都换成新组件的 DOM。
   */
  const verticalRootSelector = '[data-testid="lyrics-vertical"]';
  const expectedFontPx = (width) => Math.round(Math.min(96, Math.max(16, width * 0.26)));
  /** 竖版几何：当前句每个字素框（Range 选中文字，不含 span 的盒子）、列、平移量、字号、译文/下一句。 */
  const verticalGeometry = (pad = 1) => page.evaluate(({ selector, tolerance }) => {
    const root = document.querySelector(selector);
    const track = root?.querySelector(".vertical-lyric__track");
    const column = root?.querySelector('[data-testid="lyrics-vertical-line"]');
    const rootRect = root?.getBoundingClientRect();
    const chars = [...(column?.querySelectorAll("[data-vertical-token]") ?? [])].map((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      const rect = range.getBoundingClientRect();
      const name = typeof span.className === "string" ? span.className : "";
      return {
        text: span.textContent ?? "",
        state: name.includes("is-sung") ? "sung" : name.includes("is-active") ? "active" : "pending",
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
        opacity: Number.parseFloat(getComputedStyle(span).opacity),
        inside: rootRect
          ? rect.left >= rootRect.left - tolerance && rect.right <= rootRect.right + tolerance
            && rect.top >= rootRect.top - tolerance && rect.bottom <= rootRect.bottom + tolerance
          : false,
      };
    });
    const columnStyle = column ? getComputedStyle(column) : null;
    const trackStyle = track ? getComputedStyle(track) : null;
    const translation = root?.querySelector('[data-testid="lyrics-vertical-translation"]');
    const next = root?.querySelector('[data-testid="lyrics-vertical-next"]');
    return {
      chars,
      activeText: column?.textContent ?? "",
      current: root?.getAttribute("data-vertical-current") ?? null,
      writingMode: columnStyle?.writingMode ?? null,
      textOrientation: columnStyle?.textOrientation ?? null,
      columnTransform: columnStyle?.transform ?? null,
      fontSize: trackStyle ? Number.parseFloat(trackStyle.fontSize) : null,
      /** 运行时写进 CSS 变量的平移量（纵向为负值 = 内容往上走）。 */
      shift: root ? Number.parseFloat(getComputedStyle(root).getPropertyValue("--vertical-lyric-shift")) || 0 : 0,
      translation: translation ? {
        text: (translation.textContent ?? "").trim(),
        fontSize: Number.parseFloat(getComputedStyle(translation).fontSize),
      } : null,
      next: next ? (next.textContent ?? "").trim() : null,
      amllPlayer: Boolean(root?.querySelector(".amll-lyric-player")),
      overflow: root ? {
        x: root.offsetWidth - root.clientWidth,
        y: root.offsetHeight - root.clientHeight,
        style: getComputedStyle(root).overflow,
      } : null,
      columnCount: new Set(chars.map((char) => char.x)).size,
    };
  }, { selector: verticalRootSelector, tolerance: pad });
  /** 定住当前句：换夹具 → 发文档 → 把时刻钉在 timeMs 上且不播放（时刻不会自己往前跑）。 */
  const showVertical = async (lrc, timeMs) => {
    await page.evaluate((text) => window.__guard.setLrc(text), lrc);
    await page.evaluate(() => window.__guard.pause());
    await page.evaluate(() => window.__guard.desktopDocument());
    await page.evaluate((ms) => window.__guard.desktopProgress({ timeMs: ms, playing: false, seekGeneration: 100 }), timeMs);
    await page.waitForTimeout(360);
  };
  const setVerticalTime = async (timeMs) => {
    await page.evaluate((ms) => window.__guard.desktopProgress({ timeMs: ms, playing: false, seekGeneration: 100 }), timeMs);
    await page.waitForTimeout(320);
  };
  const activeChar = (state) => state.chars.find((char) => char.state === "active") ?? null;

  // ⑦ 一句一列：竖版不再是 AMLL 播放器，当前句是**单独一列**（同一 x、y 严格递增），既不下沉到
  //    多列，也不出原生滚动条。
  await configure({ ...DESKTOP_BASELINE, layout: "vertical", style: "clean" });
  await page.setViewportSize({ width: 260, height: 520 });
  await showVertical(FIXTURE_LRC, 700);
  const narrow = await verticalGeometry();
  add("r61-vertical-single-column",
    narrow.amllPlayer === false && narrow.current === "0"
      && narrow.writingMode === "vertical-rl" && narrow.textOrientation === "mixed"
      && narrow.chars.length >= 5 && narrow.columnCount === 1
      && narrow.chars.every((char, index) => index === 0 || char.y > narrow.chars[index - 1].y)
      && narrow.chars.every((char) => char.inside)
      && narrow.overflow !== null && narrow.overflow.x === 0 && narrow.overflow.y === 0
      && narrow.overflow.style === "hidden",
    JSON.stringify({ ...narrow, chars: narrow.chars.map((char) => `${char.text}@${char.x},${char.y}`) }));
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-narrow.png") });

  // ⑦b 字号随窗口宽度：宽 260 → 68px，宽 380 → 96px（上限），与纯函数同一套常数
  await page.setViewportSize({ width: 380, height: 520 });
  await page.waitForTimeout(520);
  const wide = await verticalGeometry();
  add("r61-vertical-font-follows-width",
    Math.abs(narrow.fontSize - expectedFontPx(260)) <= 1.5 && Math.abs(wide.fontSize - expectedFontPx(380)) <= 1.5
      && wide.fontSize > narrow.fontSize + 10 && wide.chars.length >= 5
      && wide.overflow !== null && wide.overflow.x === 0,
    JSON.stringify({ narrow: { width: 260, font: narrow.fontSize, expected: expectedFontPx(260) },
      wide: { width: 380, font: wide.fontSize, expected: expectedFontPx(380) } }));
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-wide.png") });

  // ⑦c 方向：CJK 直立（字形框高 ≈ 字号）、拉丁/数字旋转（矮而宽）；整列没有被 transform 旋转
  await page.setViewportSize({ width: 260, height: 520 });
  await page.waitForTimeout(360);
  await showVertical(R46_MIXED_LRC, 700);
  const mixed = await verticalGeometry(2);
  const cjkChars = mixed.chars.filter((char) => /[\u3400-\u9fff]/.test(char.text));
  const latinChars = mixed.chars.filter((char) => /[A-Za-z0-9]/.test(char.text));
  add("r61-vertical-cjk-upright-latin-rotated",
    mixed.writingMode === "vertical-rl" && mixed.textOrientation === "mixed"
      && mixed.columnTransform === "none"
      && cjkChars.length >= 5 && latinChars.length >= 5
      && cjkChars.every((char) => char.h >= mixed.fontSize * 0.8)
      && latinChars.every((char) => char.h <= mixed.fontSize * 0.7 && char.w >= mixed.fontSize * 0.8),
    JSON.stringify({ writingMode: mixed.writingMode, textOrientation: mixed.textOrientation,
      columnTransform: mixed.columnTransform, fontSize: mixed.fontSize,
      cjk: cjkChars.slice(0, 4), latin: latinChars.slice(0, 4) }));

  // ⑦d 长句：一列装不下时按演唱进度沿书写方向平移，**两个时刻正在唱的字都在视口里**
  await showVertical(R46_LONG_LRC, 600);
  const longEarly = await verticalGeometry();
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-long-t1.png") });
  await setVerticalTime(2400);
  const longLate = await verticalGeometry();
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-long-t2.png") });
  const earlyActive = activeChar(longEarly);
  const lateActive = activeChar(longLate);
  add("r61-vertical-long-line-keeps-singing-char",
    longEarly.chars.length >= 20 && earlyActive !== null && lateActive !== null
      && earlyActive.inside && lateActive.inside
      && longLate.shift < longEarly.shift
      && longLate.activeText === longEarly.activeText,
    JSON.stringify({ early: { active: earlyActive, shift: longEarly.shift },
      late: { active: lateActive, shift: longLate.shift } }));

  // ⑦e 逐字扫亮：同一行两个时刻，已唱的字变多、像素有差异、未唱的字更淡
  await showVertical(FIXTURE_LRC, 400);
  const karaokeEarly = await verticalGeometry();
  const earlyPng = await page.screenshot({ path: path.join(guardDir, "r61-vertical-karaoke-early.png") });
  await setVerticalTime(2600);
  const karaokeLate = await verticalGeometry();
  const latePng = await page.screenshot({ path: path.join(guardDir, "r61-vertical-karaoke-late.png") });
  const karaokeDiff = pixelDiffRatio(await sharp(earlyPng).raw().toBuffer(), await sharp(latePng).raw().toBuffer());
  const sungOf = (state) => state.chars.filter((char) => char.state === "sung").length;
  const pendingOpacity = Math.min(...karaokeEarly.chars.filter((char) => char.state === "pending").map((char) => char.opacity));
  const sungOpacity = Math.max(...karaokeEarly.chars.filter((char) => char.state === "sung").map((char) => char.opacity), 1);
  add("r61-vertical-karaoke-sweep",
    karaokeLate.activeText === karaokeEarly.activeText && activeChar(karaokeEarly) !== null
      && sungOf(karaokeLate) > sungOf(karaokeEarly) && sungOf(karaokeLate) >= 5
      && karaokeDiff > 0.01 && pendingOpacity < sungOpacity,
    `逐字扫亮：已唱 ${sungOf(karaokeEarly)} → ${sungOf(karaokeLate)}，像素差异 ${(karaokeDiff * 100).toFixed(2)}%，未唱不透明度 ${pendingOpacity}`);

  // ⑦f 译文：同一时间戳的第二行并成译文，落在相邻的第二列、字号略小
  await showVertical(R61_TRANSLATION_LRC, 700);
  const translated = await verticalGeometry();
  add("r61-vertical-translation-column",
    translated.translation !== null && translated.translation.text === "译文与原文同时刻"
      && translated.translation.fontSize < translated.fontSize * 0.9
      && translated.chars.length >= 5,
    JSON.stringify({ translation: translated.translation, font: translated.fontSize }));
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-translation.png") });

  // ⑦g 减少动效：取消平滑滚动（直接定位）；不减少动效时那一条过渡确实在
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(120);
  const transitionOf = () => page.evaluate(() => {
    const track = document.querySelector(".vertical-lyric__track");
    const style = track ? getComputedStyle(track) : null;
    return { property: style?.transitionProperty ?? null, duration: style?.transitionDuration ?? null };
  });
  const animated = await transitionOf();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  const reducedMotion = await transitionOf();
  add("r61-vertical-reduced-motion",
    animated.property !== null && animated.property !== "none" && animated.duration !== "0s"
      && (reducedMotion.property === "none" || reducedMotion.duration === "0s"),
    JSON.stringify({ animated, reduced: reducedMotion }));
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // ⑦h 面板样式 + 深色主题：竖版在面板里同样是一列（控件/衬底/面板样式不受影响）
  await page.evaluate(() => { document.documentElement.className = "dark"; });
  await configure({ ...DESKTOP_BASELINE, layout: "vertical", style: "panel" });
  await page.waitForTimeout(420);
  const panel = await verticalGeometry(2);
  const panelCard = await desktop.locator('[data-slot="card"]').count();
  add("r61-vertical-panel-dark",
    panelCard === 1 && panel.writingMode === "vertical-rl" && panel.chars.length >= 5
      && panel.columnCount === 1 && panel.overflow !== null && panel.overflow.y === 0,
    JSON.stringify({ panelCard, columnCount: panel.columnCount, overflow: panel.overflow, font: panel.fontSize }));
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-panel-dark.png") });
  await configure({ ...DESKTOP_BASELINE, layout: "vertical", style: "clean" });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await showVertical(FIXTURE_LRC, 700);
  await page.waitForTimeout(240);

  // ⑦i 竖版下控件、拖动、缩放柄、透明衬底照旧可用；锁定后仍然只剩解锁按钮
  const verticalControlState = () => page.evaluate(() => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const count = (selector) => stage?.querySelectorAll(selector).length ?? -1;
    return {
      locked: stage?.getAttribute("data-lyrics-locked") ?? null,
      buttons: stage ? stage.querySelectorAll("button").length : -1,
      grip: count('button[aria-label="拖动桌面歌词"]'),
      media: count('[data-testid="lyrics-controls"] button[aria-label="播放"], [data-testid="lyrics-controls"] button[aria-label="暂停"]'),
      appearance: count('button[aria-label="桌面歌词外观"]'),
      lock: count('button[aria-label="锁定桌面歌词"]'),
      resize: count('[data-testid="lyrics-resize-grip"]'),
      scrim: stage?.getAttribute("data-lyrics-scrim") ?? null,
      column: count('[data-testid="lyrics-vertical-line"]'),
    };
  });
  const verticalUnlocked = await verticalControlState();
  const verticalBox = await desktop.locator('[data-testid="lyrics-vertical"]').boundingBox();
  const verticalDragBefore = await page.evaluate(() => window.__guard.dragCount());
  await page.mouse.click(verticalBox.x + 40, verticalBox.y + 70);
  await page.waitForTimeout(150);
  const verticalDragAfter = await page.evaluate(() => window.__guard.dragCount());
  const verticalResizeBefore = await page.evaluate(() => window.__guard.resizeCalls());
  await page.getByTestId("lyrics-resize-grip").click();
  await page.waitForTimeout(200);
  const verticalResizeAfter = await page.evaluate(() => window.__guard.resizeCalls());
  await page.getByRole("button", { name: "锁定桌面歌词", exact: true }).click();
  await page.waitForFunction(() => window.__guard.desktopConfig().locked === true);
  await page.waitForTimeout(220);
  const verticalLocked = await verticalControlState();
  add("r61-vertical-controls-still-usable",
    verticalUnlocked.column === 1 && verticalUnlocked.scrim === "on"
      && verticalUnlocked.grip === 1 && verticalUnlocked.media === 1 && verticalUnlocked.appearance === 1
      && verticalUnlocked.lock === 1 && verticalUnlocked.resize === 1
      && verticalDragAfter === verticalDragBefore + 1
      && verticalResizeAfter.length === verticalResizeBefore.length + 1 && verticalResizeAfter.at(-1) === "SouthEast"
      && verticalLocked.locked === "on" && verticalLocked.buttons === 1 && verticalLocked.column === 1,
    JSON.stringify({ unlocked: verticalUnlocked, drag: [verticalDragBefore, verticalDragAfter],
      resize: verticalResizeAfter.at(-1), locked: verticalLocked }));
  await page.getByRole("button", { name: /已锁定桌面歌词/ }).click();
  await page.waitForFunction(() => window.__guard.desktopConfig().locked === false);
  await configure({ ...DESKTOP_BASELINE, layout: "vertical", style: "clean" });
  await page.waitForTimeout(240);

  // ⑧ 横排对照：同一行 x 递增、y 相同（证明竖排不是"哪边都这样"）
  await configure({ layout: "horizontal" });
  await page.setViewportSize({ width: 800, height: 128 });
  await page.waitForTimeout(1000);
  const horizontal = await charGeometry();
  const horizontalColumns = columnReport(horizontal.chars);
  const sameRow = horizontal.chars.length >= 5 && horizontal.chars.every((char, index) => index === 0
    || (char.x > horizontal.chars[index - 1].x && Math.abs(char.y - horizontal.chars[0].y) <= 2));
  add("desktop-horizontal-char-geometry", horizontal.writingMode === "horizontal-tb" && sameRow
    && horizontalColumns.distinctX === horizontal.chars.length && horizontalColumns.longest === 1,
  JSON.stringify({ writingMode: horizontal.writingMode, columns: horizontalColumns, chars: horizontal.chars }));

  // ⑨ 当前句跟着时间切换：竖版只显示正在唱的那一句（第二句到来时第一句整列消失）
  await configure({ layout: "vertical", style: "clean" });
  await page.setViewportSize({ width: 260, height: 520 });
  await showVertical(FIXTURE_LRC, 3300);
  const secondLineState = await verticalGeometry();
  add("r61-vertical-follows-current-line",
    secondLineState.current === "1" && secondLineState.activeText.includes("第二行")
      && secondLineState.chars.length >= 5 && secondLineState.chars.every((char) => char.inside)
      && secondLineState.columnCount === 1,
    JSON.stringify({ current: secondLineState.current, activeText: secondLineState.activeText,
      chars: secondLineState.chars.map((char) => `${char.text}@${char.y}`) }));
  await setVerticalTime(700);

  // ⑪ 自定义颜色：真的改到竖版列的像素上；清空回设计令牌
  await configure({ layout: "vertical", style: "clean", color: "foreground" });
  await page.setViewportSize({ width: 260, height: 520 });
  await showVertical(FIXTURE_LRC, 2600);
  const verticalLineSelector = '[data-testid="lyrics-vertical-line"]';
  const tokenInk = await inkColor(page, verticalLineSelector, path.join(guardDir, "r61-vertical-color-token.png"));
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ customColor: "#00dd00" });
  await page.waitForTimeout(700);
  const customInk = await inkColor(page, verticalLineSelector, path.join(guardDir, "r61-vertical-color-custom.png"));
  const customStored = await page.evaluate(() => window.__guard.desktopConfig().customColor);
  add("r61-vertical-custom-color-pixels", customStored === "#00dd00" && customInk.count > 40
    && customInk.mean[1] > customInk.mean[0] + 60 && customInk.mean[1] > customInk.mean[2] + 60,
  JSON.stringify({ tokenInk: tokenInk.mean, customInk: customInk.mean, customStored }));
  await configure({ customColor: "" });
  await page.waitForTimeout(700);
  const restoredInk = await inkColor(page, verticalLineSelector, path.join(guardDir, "r61-vertical-color-restored.png"));
  const restoredStored = await page.evaluate(() => window.__guard.desktopConfig().customColor);
  add("r61-vertical-custom-color-restored", restoredStored === "" && restoredInk.count > 40
    && !(restoredInk.mean[1] > restoredInk.mean[0] + 60 && restoredInk.mean[1] > restoredInk.mean[2] + 60),
  JSON.stringify({ restoredInk: restoredInk.mean, restoredStored }));

  // ⑪ 自定义颜色（横版官方组件）：真的改到官方组件消费的像素上；清空回设计令牌
  await configure({ layout: "horizontal", style: "clean", color: "foreground" });
  await page.setViewportSize({ width: 800, height: 128 });
  await page.waitForTimeout(700);
  const horizontalTokenInk = await inkColor(page, activeLine, path.join(guardDir, "desktop-color-token.png"));
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ customColor: "#00dd00" });
  await page.waitForTimeout(800);
  const horizontalCustomInk = await inkColor(page, activeLine, path.join(guardDir, "desktop-color-custom.png"));
  const horizontalCustomStored = await page.evaluate(() => window.__guard.desktopConfig().customColor);
  add("desktop-custom-color-pixels", horizontalCustomStored === "#00dd00" && horizontalCustomInk.count > 40
    && horizontalCustomInk.mean[1] > horizontalCustomInk.mean[0] + 60 && horizontalCustomInk.mean[1] > horizontalCustomInk.mean[2] + 60,
  JSON.stringify({ tokenInk: horizontalTokenInk.mean, customInk: horizontalCustomInk.mean, customStored: horizontalCustomStored }));
  await configure({ customColor: "" });
  await page.waitForTimeout(700);
  const horizontalRestoredInk = await inkColor(page, activeLine, path.join(guardDir, "desktop-color-restored.png"));
  const horizontalRestoredStored = await page.evaluate(() => window.__guard.desktopConfig().customColor);
  add("desktop-custom-color-restored", horizontalRestoredStored === "" && horizontalRestoredInk.count > 40
    && !(horizontalRestoredInk.mean[1] > horizontalRestoredInk.mean[0] + 60 && horizontalRestoredInk.mean[1] > horizontalRestoredInk.mean[2] + 60),
  JSON.stringify({ restoredInk: horizontalRestoredInk.mean, restoredStored: horizontalRestoredStored }));

  // ⑫ 重挂载：旧 query 仍按权威配置显示（配置回读优先于查询串初值）
  await configure({ layout: "vertical", style: "panel" });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__guard.setDesktop(false));
  await desktop.waitFor({ state: "detached" });
  await page.evaluate(() => window.__guard.setDesktop(true));
  await desktop.waitFor();
  await page.waitForTimeout(600);
  add("desktop-old-query-authoritative-ready", await desktop.getAttribute("data-lyrics-layout") === "vertical"
    && await desktop.locator('[data-slot="card"]').count() === 1, "重挂载旧 query，受限 configure 回读最新 config");
  await configure({ ...DESKTOP_BASELINE });

  // ⑬ 空态宿主同样可拖
  await page.evaluate(() => window.__guard.desktopDocument("empty"));
  const emptyDragBefore = await page.evaluate(() => window.__guard.dragCount());
  await desktop.getByRole("status").click();
  add("desktop-empty-drag", await page.evaluate((count) => window.__guard.dragCount() === count + 1, emptyDragBefore), "空态宿主同样可拖");
  await page.evaluate(() => window.__guard.desktopDocument());

  await page.evaluate(() => window.__guard.restoreLyrics());
  await configure({ ...DESKTOP_BASELINE });
  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(400);
}

/**
 * R51（brief 第二项之一）：桌面歌词窗里**只剩那枚齿轮**——菜单内容不在这扇窗里。
 *
 * 这条**有意替换 R50 的 `checkDesktopLyricsSettings`**（内嵌菜单的"装得下/够得着/锚定齿轮/改得动"
 * 四项）：菜单整段搬到了 `LyricsSettingsPopup.tsx`，那四项跟着搬到 `checkLyricsSettingsPopup`
 * （单独一页、单独一扇窗）。这里只钉两件事：
 *
 * 1. 歌词窗的 DOM 里**没有**菜单内容（旧实现是删掉的，不是藏起来的）；
 * 2. 点齿轮 = 一笔 `core_lyrics_settings_open`，锚点正是齿轮自己的矩形（DIP / CSS 像素），
 *    而且这一下**不改配置**（它是"打开设置"，不是"改一个值"）。
 */
export async function checkDesktopLyricsSettings(page, guardDir, add) {
  const desktop = page.getByTestId("lyrics-window");
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  await configure({ ...DESKTOP_BASELINE });
  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(500);

  const leftovers = {
    panel: await desktop.getByTestId("lyrics-appearance-panel").count(),
    styles: await desktop.locator('[data-testid^="lyrics-style-"]').count(),
    sizes: await desktop.locator('[data-testid^="lyrics-size-"]').count(),
    switches: await desktop.locator('[data-testid^="lyrics-window-"]').count(),
    color: await desktop.getByTestId("lyrics-appearance-color").count(),
    menuRoles: await desktop.locator('[role="menu"]').count(),
  };
  add("r51-lyrics-window-has-no-menu",
    leftovers.panel === 0 && leftovers.styles === 0 && leftovers.sizes === 0
      && leftovers.switches === 0 && leftovers.color === 0 && leftovers.menuRoles === 0,
    JSON.stringify(leftovers));

  await page.evaluate(() => window.__guard.resetSettingsPopupCalls());
  await page.evaluate(() => window.__guard.resetConfigureCalls());
  const gearBox = await desktop.getByTestId("lyrics-appearance").boundingBox();
  await desktop.getByTestId("lyrics-appearance").click();
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => window.__guard.settingsPopupCalls());
  const anchor = opened.at(-1) ?? null;
  add("r51-lyrics-gear-opens-popup",
    opened.length === 1 && Boolean(anchor) && Boolean(gearBox)
      && Math.abs(anchor.x - gearBox.x) <= 1.5 && Math.abs(anchor.y - gearBox.y) <= 1.5
      && Math.abs(anchor.width - gearBox.width) <= 1.5 && Math.abs(anchor.height - gearBox.height) <= 1.5,
    JSON.stringify({ opened, gearBox }));
  const untouched = await page.evaluate(() => window.__guard.configureCalls());
  add("r51-lyrics-gear-does-not-configure", untouched.length === 0,
    `打开设置不该顺手改配置：${JSON.stringify(untouched)}`);
  await page.screenshot({ path: path.join(guardDir, "r51-lyrics-window-800x128.png") });

  await page.evaluate(() => window.__guard.resetSettingsPopupCalls());
  await configure({ ...DESKTOP_BASELINE });
  await page.setViewportSize({ width: 800, height: 128 });
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(400);
}

/** 弹出窗守卫页的挂载源码（生成物，不入库）；只在 Tauri IPC 边界给夹具。 */
export function lyricsSettingsHarnessSource() {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

import { LyricsSettingsPopup } from "../../src/renderer/LyricsSettingsPopup.tsx";
import { POPOVER_PAD_DIP } from "../../src/renderer/features/lyrics/lyrics-popover.mjs";
import { DEFAULT_LYRICS_CONFIG, normalizeLyricsConfig } from "../../src/renderer/features/lyrics/lyrics-window.mjs";

let config = { ...DEFAULT_LYRICS_CONFIG };
let revision = 0;
/** 每次 core_lyrics_configure 的补丁（"控件真的改了配置、且只走那条窄命令"按它判）。 */
const configureCalls = [];
/** 弹出窗报上来的尺寸（页面自己量、宿主设窗口）。 */
const resizeCalls = [];
/** 关闭请求（Esc / 点面板外面）。 */
const closeCalls = [];

/**
 * 守卫用查询串挑一种气泡几何（宿主那一侧的算法在 Rust 里，这里只给答案）：
 * centre 箭头居中 / left 左夹紧 / right 右夹紧 / top 翻到上方 / roomy 截图留出齿轮位。
 */
const BUBBLE = new URLSearchParams(window.location.search).get("bubble") ?? "centre";

function geometryFor(width) {
  const inset = 12;
  if (BUBBLE === "left") return { side: "bottom", arrow: inset, pad: POPOVER_PAD_DIP };
  if (BUBBLE === "right") return { side: "bottom", arrow: width - inset, pad: POPOVER_PAD_DIP };
  if (BUBBLE === "top") return { side: "top", arrow: width / 2, pad: POPOVER_PAD_DIP };
  if (BUBBLE === "roomy") return { side: "bottom", arrow: Math.round(width * 0.3), pad: 48 };
  return { side: "bottom", arrow: width / 2, pad: POPOVER_PAD_DIP };
}

mockWindows("lyrics-settings");
mockIPC(async (command, args) => {
  if (command === "core_lyrics_configure") {
    const patch = args.config ?? {};
    if (Object.keys(patch).length > 0) {
      configureCalls.push(JSON.parse(JSON.stringify(patch)));
      config = normalizeLyricsConfig(patch, config);
      revision += 1;
      await emit("core:event", { channel: "lyrics:state", payload: { config, revision, visible: true } });
    }
    return { config, revision, visible: true };
  }
  if (command === "core_lyrics_settings_resize") {
    resizeCalls.push({ width: args.width, height: args.height, atMs: Math.round(performance.now()) });
    return { applied: true, width: args.width, height: args.height, visible: true, geometry: geometryFor(args.width) };
  }
  if (command === "core_lyrics_settings_close") {
    closeCalls.push(Math.round(performance.now()));
    return { open: false };
  }
  throw new Error("未提供弹出窗守卫命令：" + command);
}, { shouldMockEvents: true });

window.__popupGuard = {
  configureCalls: () => configureCalls.map((patch) => ({ ...patch })),
  resizeCalls: () => resizeCalls.map((entry) => ({ ...entry })),
  closeCalls: () => closeCalls.slice(),
  config: () => ({ ...config }),
  bubble: () => BUBBLE,
  reset: () => { configureCalls.length = 0; resizeCalls.length = 0; closeCalls.length = 0; },
};

createRoot(document.getElementById("root")).render(<StrictMode><LyricsSettingsPopup /></StrictMode>);
`;
}

/** 弹出窗守卫页面（生成物，不入库）。 */
export function lyricsSettingsHarnessHtml() {
  return `<!doctype html>
<html lang="zh-CN" class="light">
  <head>
    <meta charset="utf-8" />
    <title>歌词设置弹出窗浏览器守卫</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body class="bg-transparent">
    <div id="root"></div>
    <script type="module" src="./lyrics-settings.js"></script>
  </body>
</html>
`;
}

/**
 * R60：设置面板那一页的**真浏览器**验收（气泡形态）。
 *
 * 单独一页、单独一扇窗（`?` 里不带主界面）：这一页挂的就是 `LyricsSettingsPopup`，IPC 只给
 * `core_lyrics_configure` / `core_lyrics_settings_resize` / `core_lyrics_settings_close` 三条。
 * 宿主侧的定位算法在 Rust（`bubble_placement`，纯函数单测）；这里按查询串挑几种它算得出的几何，
 * 只钉页面这一侧真的照着摆：
 *
 * 1. **面板贴在窗口留边内侧**（`(pad, pad)`），窗口尺寸 = 面板 + 四周留边，面板高度 ≤ 360 且不滚；
 * 2. **箭头指着锚点**：居中 / 左夹紧 / 右夹紧三种偏移下，箭头中心都落在 `pad + arrow` 上；
 * 3. **翻到上方**时面板底边贴留边、箭头在面板下方；
 * 4. **尺寸真的报上去了**（`resize` 的宽高 == 面板的 `offsetWidth/offsetHeight`）；
 * 5. **浅/深两色下每个控件都可见可点**（含五个字号档位）；
 * 6. **改任一项都关不掉面板**（单选组/开关/颜色：只发配置，不发关窗）；
 * 7. **Esc 真的请求关窗**，且关窗不卸面板（宿主只是 hide）；
 * 8. **色块显示主题下的真实颜色**（未设自定义色时与歌词实际颜色一致）。
 */
export async function checkLyricsSettingsPopup(page, port, guardDir, add) {
  /** 五个字号档位 + R50 那九个锚点：缺一个就等于"够不着"。 */
  const CONTROLS = [
    '[data-testid="lyrics-style-clean"]',
    '[data-testid="lyrics-style-panel"]',
    '[data-testid="lyrics-layout-horizontal"]',
    '[data-testid="lyrics-layout-vertical"]',
    '[data-testid="lyrics-size-sm"]',
    '[data-testid="lyrics-size-md"]',
    '[data-testid="lyrics-size-lg"]',
    '[data-testid="lyrics-size-xl"]',
    '[data-testid="lyrics-size-xxl"]',
    '[data-testid="lyrics-window-enableBlur"]',
    '[data-testid="lyrics-window-enableScale"]',
    '[data-testid="lyrics-window-enableSpring"]',
    '[data-testid="lyrics-window-showControls"]',
    '[data-testid="lyrics-appearance-color"]',
    '[data-testid="lyrics-appearance-color-reset"]',
  ];
  const BASE = `http://127.0.0.1:${port}/lyrics-settings.html`;
  /** 面板与箭头此刻的几何（页面坐标系 = 窗口客户区）。 */
  const geometryOf = () => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="lyrics-appearance-panel"]');
    const arrow = document.querySelector('[data-slot="popover-arrow"]');
    if (!panel || !arrow) return null;
    const box = panel.getBoundingClientRect();
    const tip = arrow.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      left: Math.round(box.left), top: Math.round(box.top),
      width: Math.ceil(panel.offsetWidth), height: Math.ceil(panel.offsetHeight),
      right: Math.round(box.right), bottom: Math.round(box.bottom),
      arrow: { x: Math.round(tip.left + tip.width / 2), top: Math.round(tip.top), bottom: Math.round(tip.bottom) },
      maxHeight: style.maxHeight, overflowY: style.overflowY,
      viewport: { width: innerWidth, height: innerHeight },
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
  /** 打开某一页（查询串换一种气泡几何就会整页重载）。 */
  const load = async (bubble) => {
    await page.goto(bubble === null ? BASE : `${BASE}?bubble=${bubble}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__popupGuard !== undefined, null, { timeout: 15_000 });
    await page.getByTestId("lyrics-appearance-panel").waitFor();
    await page.waitForTimeout(450);
  };
  /** 逐个控件：矩形在视口里，且中心点命中的就是它（被别的东西盖住 = 用户按不到）。 */
  const reachability = (selectors) => page.evaluate((list) => list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return { selector, found: false };
    const rect = node.getBoundingClientRect();
    const inViewport = rect.width > 0 && rect.height > 0
      && rect.top >= -1 && rect.left >= -1 && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { selector, found: true, inViewport, clickable: Boolean(hit && (node === hit || node.contains(hit))) };
  }), selectors);
  const setColor = (value) => page.locator('[data-testid="lyrics-appearance-color"]').evaluate((input, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  /** 一个 CSS 颜色（可能是 oklch）→ 真实 sRGB 六位（画布取像素：与渲染层的换算完全独立）。 */
  const pixelHex = (css) => page.evaluate((color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("");
  }, css);

  await page.setViewportSize({ width: 420, height: 720 });
  await load(null);

  // ① 面板贴在留边内侧；窗口尺寸 = 面板 + 四周留边；高度 ≤ 360 且不滚
  const centred = await geometryOf();
  const pad = POPOVER_PAD_DIP;
  add("r60-popup-panel-sits-inside-the-window-ring",
    Boolean(centred) && centred.left === pad && centred.top === pad,
    JSON.stringify(centred));
  add("r60-popup-panel-is-compact",
    Boolean(centred) && centred.height <= 360 && centred.height > 128 && centred.maxHeight === "none",
    `面板高度 ${centred && centred.height}（目标 ≤ 360，且明显超过歌词窗的 128）`);
  // 真实窗口 = 面板 + 两侧留边：整页没有滚动条，面板与箭头都在窗口里
  await page.setViewportSize({ width: centred.width + pad * 2, height: centred.height + pad * 2 });
  await page.waitForTimeout(250);
  const windowSized = await geometryOf();
  add("r60-popup-fits-its-window",
    Boolean(windowSized) && windowSized.left === pad && windowSized.top === pad
      && windowSized.right <= windowSized.viewport.width - pad
      && windowSized.bottom <= windowSized.viewport.height - pad
      && windowSized.scrollHeight <= windowSized.viewport.height + 1
      && windowSized.arrow.top >= 0,
    JSON.stringify({ window: windowSized && windowSized.viewport, panel: windowSized && [windowSized.left, windowSized.top, windowSized.width, windowSized.height], arrow: windowSized && windowSized.arrow }));

  // ② 箭头指着锚点：居中 / 左夹紧 / 右夹紧 / 翻到上方
  const arrowAt = async (bubble) => {
    await load(bubble);
    return geometryOf();
  };
  const centre = await arrowAt("centre");
  add("r60-popup-arrow-points-at-the-anchor",
    Boolean(centre) && Math.abs(centre.arrow.x - (centre.left + centre.width / 2)) <= 2
      && centre.arrow.top < centre.top && centre.arrow.top >= 0,
    JSON.stringify(centre && { arrow: centre.arrow, panel: [centre.left, centre.top, centre.width] }));
  const left = await arrowAt("left");
  const right = await arrowAt("right");
  add("r60-popup-arrow-follows-the-clamp",
    Boolean(left) && Boolean(right)
      && Math.abs(left.arrow.x - (left.left + 12)) <= 2 && Math.abs(right.arrow.x - (right.right - 12)) <= 2
      && left.arrow.x !== Math.round(left.left + left.width / 2),
    JSON.stringify({ left: left && left.arrow.x, right: right && right.arrow.x, panel: left && [left.left, left.width] }));
  const above = await arrowAt("top");
  add("r60-popup-flips-above-the-anchor",
    Boolean(above) && above.top === pad && Math.abs(above.arrow.x - (above.left + above.width / 2)) <= 2
      && above.arrow.bottom > above.bottom && above.arrow.bottom <= above.viewport.height,
    JSON.stringify(above && { arrow: above.arrow, panelBottom: above.bottom, viewport: above.viewport }));

  // ③ 尺寸真的报上去了（宿主按它设窗口）
  const reported = await page.evaluate(() => window.__popupGuard.resizeCalls());
  const lastReport = reported.at(-1) ?? null;
  add("r60-popup-reports-its-size",
    Boolean(above) && Boolean(lastReport) && lastReport.width === above.width && lastReport.height === above.height,
    JSON.stringify({ reported: reported.slice(-2), panel: above && { width: above.width, height: above.height } }));

  // ④ 浅/深两色：每个控件都可见可点（先选一个自定义色，让"恢复主题色"可用）
  await load(null);
  await setColor("#00dd00");
  await page.waitForFunction(() => window.__popupGuard.config().customColor === "#00dd00");
  const sized = await geometryOf();
  await page.setViewportSize({ width: sized.width + pad * 2, height: sized.height + pad * 2 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.waitForTimeout(200);
    const controls = await reachability(CONTROLS);
    add(`r60-popup-controls-reachable-${theme}`,
      controls.length === CONTROLS.length && controls.every((entry) => entry.found && entry.inViewport && entry.clickable),
      JSON.stringify({ missing: controls.filter((entry) => !entry.found).map((entry) => entry.selector),
        unreachable: controls.filter((entry) => entry.found && !(entry.inViewport && entry.clickable)) }));
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.waitForTimeout(150);

  // ⑤ 改得动，且改任一项都关不掉面板
  const c0 = await page.evaluate(() => window.__popupGuard.configureCalls().length);
  const closes0 = await page.evaluate(() => window.__popupGuard.closeCalls().length);
  await page.getByTestId("lyrics-size-xl").click();
  await page.waitForFunction(() => window.__popupGuard.config().size === "xl");
  const sizeState = await page.evaluate(() => ({
    config: window.__popupGuard.config().size,
    state: document.querySelector('[data-testid="lyrics-size-xl"]')?.getAttribute("data-state"),
    calls: window.__popupGuard.configureCalls(),
  }));
  add("r60-popup-size-applies",
    sizeState.config === "xl" && sizeState.state === "on"
      && sizeState.calls.length === c0 + 1 && sizeState.calls.at(-1)?.size === "xl",
    JSON.stringify(sizeState));
  await page.getByTestId("lyrics-style-panel").click();
  await page.waitForFunction(() => window.__popupGuard.config().style === "panel");
  await page.getByTestId("lyrics-layout-vertical").click();
  await page.waitForFunction(() => window.__popupGuard.config().layout === "vertical");
  const styleLayout = await page.evaluate(() => window.__popupGuard.configureCalls().slice(-2));
  add("r60-popup-style-layout-apply",
    styleLayout.at(-2)?.style === "panel" && styleLayout.at(-1)?.layout === "vertical",
    JSON.stringify(styleLayout));
  /**
   * R61：竖版下"字号"档位禁用，并给一句用户能懂的说明（竖版的字号随窗口宽度变化）。
   * 其余控件不受影响——样式/方向/开关/颜色在竖版下照旧可用（后面的用例继续点它们）。
   */
  const verticalSizeState = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="lyrics-size"]');
    const items = [...(group?.querySelectorAll('[data-testid^="lyrics-size-"]') ?? [])];
    const note = document.querySelector('[data-testid="lyrics-size-vertical-note"]');
    return {
      items: items.length,
      allDisabled: items.length > 0 && items.every((item) => item.hasAttribute("disabled") || item.getAttribute("data-disabled") !== null),
      note: (note?.textContent ?? "").trim(),
    };
  });
  const callsBeforeSizeClick = await page.evaluate(() => window.__popupGuard.configureCalls().length);
  await page.locator('[data-testid="lyrics-size-xxl"]').click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(200);
  const sizeClickWrote = await page.evaluate((count) => window.__popupGuard.configureCalls().length, callsBeforeSizeClick);
  add("r61-popup-size-disabled-in-vertical",
    verticalSizeState.items === 5 && verticalSizeState.allDisabled
      && verticalSizeState.note.includes("窗口宽度") && sizeClickWrote === callsBeforeSizeClick,
    JSON.stringify({ ...verticalSizeState, sizeClickWrote, callsBeforeSizeClick }));
  await page.screenshot({ path: path.join(guardDir, "r61-vertical-settings-size-disabled.png") });
  await page.getByTestId("lyrics-layout-horizontal").click();
  await page.waitForFunction(() => window.__popupGuard.config().layout === "horizontal");
  await page.getByTestId("lyrics-window-enableBlur").click();
  await page.waitForFunction(() => window.__popupGuard.config().enableBlur === false);
  add("r60-popup-switch-applies", await page.evaluate(() => window.__popupGuard.configureCalls().at(-1)?.enableBlur === false),
    JSON.stringify(await page.evaluate(() => window.__popupGuard.configureCalls().slice(-1))));
  // 再点一次已选中项（radix 给空串）：什么都不写，也不关面板
  const callsBeforeDeselect = await page.evaluate(() => window.__popupGuard.configureCalls().length);
  await page.getByTestId("lyrics-style-panel").click();
  await page.waitForTimeout(200);
  add("r60-popup-deselect-writes-nothing",
    await page.evaluate((count) => window.__popupGuard.configureCalls().length, callsBeforeDeselect) === callsBeforeDeselect
      && await page.evaluate(() => window.__popupGuard.config().style) === "panel",
    JSON.stringify({ before: callsBeforeDeselect, calls: await page.evaluate(() => window.__popupGuard.configureCalls()) }));
  add("r60-popup-changes-do-not-close",
    await page.evaluate((count) => window.__popupGuard.closeCalls().length, closes0) === closes0
      && await page.getByTestId("lyrics-appearance-panel").count() === 1,
    JSON.stringify({ closes0, closes: await page.evaluate(() => window.__popupGuard.closeCalls()) }));

  // ⑥ 颜色往返：取色器 → customColor；恢复主题色 → 空串
  await setColor("#00dd00");
  await page.waitForFunction(() => window.__popupGuard.config().customColor === "#00dd00");
  const storedColor = await page.evaluate(() => window.__popupGuard.config().customColor);
  await page.getByTestId("lyrics-appearance-color-reset").click();
  await page.waitForFunction(() => window.__popupGuard.config().customColor === "");
  add("r60-popup-color-roundtrip", storedColor === "#00dd00"
    && await page.evaluate(() => window.__popupGuard.configureCalls().some((patch) => patch.customColor === "#00dd00"))
    && await page.evaluate(() => window.__popupGuard.configureCalls().at(-1)?.customColor === ""),
    JSON.stringify({ storedColor, calls: await page.evaluate(() => window.__popupGuard.configureCalls().filter((patch) => "customColor" in patch)) }));

  // ⑦ 未设自定义色时色块 = 令牌在当前主题下的真实颜色（与歌词吃的是同一个变量）
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.waitForTimeout(300);
    const actual = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--foreground)";
      document.body.appendChild(probe);
      const css = getComputedStyle(probe).color;
      probe.remove();
      return css;
    });
    const expected = await pixelHex(actual);
    const swatch = await page.locator('[data-testid="lyrics-appearance-color"]').inputValue();
    add(`r60-popup-swatch-follows-theme-${theme}`, swatch === expected,
      JSON.stringify({ theme, swatch, expected, computed: actual }));
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.waitForTimeout(150);

  // ⑧ Esc：dismiss 回来的是"关窗命令"，页面自己不做主
  const closesBefore = await page.evaluate(() => window.__popupGuard.closeCalls().length);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  add("r60-popup-escape-requests-close",
    await page.evaluate((count) => window.__popupGuard.closeCalls().length > count, closesBefore),
    JSON.stringify(await page.evaluate(() => window.__popupGuard.closeCalls())));
  // 关窗不许把面板卸掉（宿主只是 hide：下次显示必须是同一份内容）
  add("r60-popup-stays-mounted-after-close",
    await page.getByTestId("lyrics-appearance-panel").count() === 1,
    "关闭 = 隐藏窗口，页面不重载（open 恒 true，内容不许跟着 dismiss 卸载）");

  /**
   * ⑨ 截图：浅/深各一张，**箭头指向齿轮**。
   *
   * 用 `?bubble=roomy`（留边临时放宽到 48）给"齿轮"留出可见的位置——面板与箭头的关系是同一套规则，
   * 只是把窗外那块透明留边画出来，好让白色齿轮框落在箭头正上方。
   */
  for (const theme of ["light", "dark"]) {
    await load("roomy");
    const roomy = await geometryOf();
    await page.setViewportSize({ width: roomy.width + 96, height: roomy.height + 96 });
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="lyrics-appearance-panel"]').getBoundingClientRect();
      const arrow = document.querySelector('[data-slot="popover-arrow"]').getBoundingClientRect();
      const gear = document.createElement("div");
      gear.dataset.testid = "gear-marker";
      gear.textContent = "⚙";
      gear.style.cssText = `position:fixed;display:grid;place-items:center;font-size:16px;`
        + `left:${Math.round(arrow.left + arrow.width / 2 - 14)}px;top:${Math.round(panel.top - 14 - 28)}px;`
        + "width:28px;height:28px;border:1px dashed currentColor;border-radius:6px";
      document.body.appendChild(gear);
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(guardDir, `r60-popup-bubble-${theme}.png`) });
    await page.evaluate(() => document.querySelector('[data-testid="gear-marker"]')?.remove());
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
}

/** R52：走到 设置 → 歌词（外壳里那一条真实路径）。沉浸页开着就先收起。 */
async function openSettingsLyricsPane(page) {
  const stage = page.getByTestId("playback-stage");
  if (await stage.count()) {
    await stage.getByRole("button", { name: "收起歌词", exact: true }).click();
    await stage.waitFor({ state: "detached" });
  }
  if (await page.getByTestId("sidebar-search-rail").count()) await page.getByTestId("sidebar-search-rail").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByTestId("settings-page").waitFor();
  await page.getByRole("tab", { name: "歌词", exact: true }).click();
  await page.locator("#lyrics-visible").waitFor();
}

/**
 * R46 的逐字着色验收（R52 只把颜色那半删掉，逐字这半原样保留）。
 *
 * 1. 主窗面板同样把行级 LRC 推导成逐字词（`words.length > 1`，一个字一个 span）——
 *    R45B 只接了桌面窗，同一首歌在两个面上差一代；
 * 2. 逐字高亮**真的在动**：同一条当前行在两个播放时刻的像素必须变（不是只有 DOM 里有 span）。
 */
export async function checkImmersiveKaraoke(page, guardDir, add) {
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  const themeLine = '[data-testid="amll-lyrics-panel"] [class*="lyricMainLine"][class*="active"]';
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ ...DESKTOP_BASELINE });
  await page.evaluate(() => window.__guard.resetSettings());
  await page.evaluate(() => window.__guard.restoreLyrics());
  await page.evaluate(() => window.__guard.setTime(700));
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "歌词", exact: true }).click();
  await page.getByTestId("playback-stage").waitFor();
  await page.waitForTimeout(1000);

  const wordSpans = await page.locator(`${themeLine} span`).evaluateAll((nodes) =>
    nodes.filter((node) => node.children.length === 0 && (node.textContent ?? "").length === 1).map((node) => node.textContent));
  /**
   * 逐字推导发生在**适配层**（`withKaraokeWords`），不是播放状态里：状态里的 `lines` 仍是行级的
   * （1 个词），面板渲染前才推导成逐字。所以这里判的是"官方组件真的拿到并画出了 7 个逐字 span"。
   */
  const rawWords = await page.evaluate(() => window.__guard.snapshot().lyrics.lines.map((line) => line.words.length));
  add("r46-immersive-karaoke-word-spans",
    wordSpans.length >= 5 && wordSpans.join("") === "第一行歌词守卫",
  JSON.stringify({ wordSpans, stateWordsPerLine: rawWords }));

  const karaokeBox = await stableTextBox(page, themeLine);
  const shotAt = async (timeMs, file) => {
    await page.evaluate((ms) => window.__guard.setTime(ms), timeMs);
    await page.waitForTimeout(800);
    return page.screenshot(karaokeBox ? { clip: karaokeBox, path: path.join(guardDir, file) } : { path: path.join(guardDir, file) });
  };
  const earlyShot = await shotAt(300, "r46-immersive-karaoke-early.png");
  const lateShot = await shotAt(2600, "r46-immersive-karaoke-late.png");
  const fillDiff = pixelDiffRatio(await sharp(earlyShot).raw().toBuffer(), await sharp(lateShot).raw().toBuffer());
  add("r46-immersive-karaoke-fill-progress", Boolean(karaokeBox) && fillDiff > 0.02,
    `沉浸页逐字高亮推进：行内像素差异 ${(fillDiff * 100).toFixed(2)}%`);

  await page.getByTestId("playback-stage").getByRole("button", { name: "收起歌词", exact: true }).click();
  await page.getByTestId("playback-stage").waitFor({ state: "detached" });
  await configure({ ...DESKTOP_BASELINE });
}

/**
 * R52：设置页「歌词」只剩**一张**桌面歌词卡，且没有任何外观入口。
 *
 * 判据与桌面歌词设置面同一条：每个控件滚进视口后，命中的必须是它自己（960×600 里不许被裁）。
 * 三件事各钉一处"看起来重构了、其实漏了"的地方：
 * 1. 搬进弹出窗的那些控件**不许留在页面里**（字号/方向/样式/四个效果/播放器歌词颜色）；
 * 2. 设置页**没有「外观设置」入口**：桌面歌词外观只在歌词窗自己的齿轮菜单里改，从这一页
 *    点任何东西都不该发出 `core_lyrics_settings_open`（R52 收尾按用户要求撤掉那条接线）；
 * 3. 任务栏模式下状态只有 Badge + 一句 `taskbarStatusText`，页面里也不会冒出新入口。
 */
export async function checkSettingsPageLyricsCard(page, guardDir, add) {
  const CONTROLS = ["#lyrics-visible", "#lyrics-mode", "#lyrics-locked", "#lyrics-click-through"];
  /** R52 删掉的那些控件（它们只在 R51 的弹出窗里）。 */
  const GONE = [
    "#lyrics-size", "#lyrics-layout", "#lyrics-style",
    "#lyrics-enableBlur", "#lyrics-enableScale", "#lyrics-enableSpring", "#lyrics-showControls",
    "#player-lyrics-color", "#player-lyrics-custom-color",
  ];
  await page.setViewportSize({ width: 960, height: 600 });
  await page.evaluate(() => window.__guard.pause());
  await page.evaluate(() => window.__guard.resetSettings());
  await page.evaluate(() => window.__guard.resetSettingsPopupCalls());
  await openSettingsLyricsPane(page);
  await page.getByTestId("lyrics-cache-card").waitFor();
  await page.waitForTimeout(400);

  const reachable = await page.evaluate((ids) => ids.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return { selector, found: false };
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      selector,
      found: true,
      inViewport: rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.left >= -1
        && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
      clickable: Boolean(hit && (node === hit || node.contains(hit))),
    };
  }), CONTROLS);
  add("r52-settings-lyrics-controls-reachable",
    reachable.length === CONTROLS.length && reachable.every((entry) => entry.found && entry.inViewport && entry.clickable),
    JSON.stringify({ missing: reachable.filter((entry) => !entry.found).map((entry) => entry.selector),
      unreachable: reachable.filter((entry) => entry.found && !(entry.inViewport && entry.clickable)) }));

  const leftovers = await page.evaluate((ids) => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    return {
      found: ids.filter((selector) => document.querySelectorAll(selector).length > 0),
      colorPickers: settings.querySelectorAll('input[type="color"]').length,
      cards: [...settings.querySelectorAll('[data-slot="card-title"]')].map((node) => (node.textContent ?? "").trim()),
      /** 外观入口的三种痕迹：测试钩子、按钮文案、齿轮的 aria 名称。 */
      appearanceHook: settings.querySelectorAll('[data-testid="lyrics-appearance-open"]').length,
      appearanceButtons: [...settings.querySelectorAll("button")]
        .filter((button) => (button.textContent ?? "").trim() === "外观设置").length,
      appearanceAria: settings.querySelectorAll('[aria-label*="外观"]').length,
    };
  }, GONE);
  add("r52-settings-lyrics-relocated-controls-gone",
    leftovers.found.length === 0 && leftovers.colorPickers === 0,
    JSON.stringify(leftovers));
  add("r52-settings-has-no-appearance-entry",
    leftovers.appearanceHook === 0 && leftovers.appearanceButtons === 0 && leftovers.appearanceAria === 0,
    JSON.stringify(leftovers));

  // 这一页点什么都不许发出 open（外观只有一个入口，在歌词窗的齿轮上）
  await page.getByTestId("settings-page").getByRole("tab", { name: "歌词", exact: true }).click();
  await page.locator("#lyrics-locked").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const opensFromSettings = await page.evaluate(() => window.__guard.settingsPopupCalls());
  add("r52-settings-never-opens-the-popup", opensFromSettings.length === 0,
    `设置页不该发 core_lyrics_settings_open：${JSON.stringify(opensFromSettings)}`);
  await page.screenshot({ path: path.join(guardDir, "r52-settings-page-lyrics.png") });

  // 任务栏模式：Beta 状态一句（页面里不会因此冒出新入口）
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "taskbar" }));
  await page.waitForTimeout(300);
  const taskbarUi = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="settings-page"]');
    return {
      beta: (pane?.textContent ?? "").includes("Beta"),
      status: (pane?.querySelector('[role="status"]')?.textContent ?? "").trim(),
      appearanceButtons: [...(pane?.querySelectorAll("button") ?? [])]
        .filter((button) => (button.textContent ?? "").trim() === "外观设置").length,
    };
  });
  add("r52-settings-taskbar-beta-status",
    taskbarUi.beta && taskbarUi.status.length > 0 && taskbarUi.appearanceButtons === 0,
    JSON.stringify(taskbarUi));

  // 复位：桌面模式 + 回收藏页（后面的用例从干净状态开始）
  await page.evaluate(() => window.__guard.configureDesktop({ mode: "desktop" }));
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
}

/**
 * R59：任务栏歌词的**独立外观**（颜色 / 逐字高亮 / 字号）——设置在设置页，与桌面歌词不共用。
 *
 * 五项各钉一处"看起来做了、其实没做"的地方：
 * 1. 能力回报为假（非 Windows）时那张卡**不渲染**；能力来自宿主查询，页面不判断平台；
 * 2. 卡片里的控件写进去的只有 `taskbar*` 四个键（不碰桌面字段），且每次一条窄命令；
 * 3. 任务栏模式的歌词窗按任务栏颜色/字号渲染：令牌换档 ⇒ 计算出的色值真的变，档位换档 ⇒ 字号真的变；
 * 4. 逐字关闭 ⇒ 不再有逐字 span（行级 ⇒ 官方按行渐变），但仍是官方 `LyricPlayer` 在画；
 * 5. 改任务栏字段**不影响桌面模式**（桌面窗的字号与颜色照旧）。
 */
export async function checkTaskbarLyricsSettings(page, guardDir, add) {
  const CARD = '[data-testid="taskbar-lyrics-card"]';
  const activeLineSelector = '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]';
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  const setSupported = (value) => page.evaluate((next) => window.__guard.setTaskbarSupported(next), value);
  /** 能力回报经广播回到主窗：给它一点时间重画（不给断言留"可能还没到"的口子）。 */
  const refreshStatus = async () => { await page.waitForTimeout(400); };
  /** 歌词窗此刻的外观事实（data 属性 + 计算出的变量 + 逐字 span 数）。 */
  const readStage = () => page.evaluate((selector) => {
    const stage = document.querySelector('[data-testid="lyrics-window"]');
    const line = document.querySelector(selector);
    const spans = [...(line?.querySelectorAll("span") ?? [])]
      .filter((span) => span.children.length === 0 && (span.textContent ?? "").length === 1);
    const style = stage === null ? null : getComputedStyle(stage);
    return {
      mode: stage?.dataset.lyricsMode ?? null,
      size: stage?.dataset.lyricsSize ?? null,
      karaoke: stage?.dataset.lyricsKaraoke ?? null,
      colorAttr: stage?.getAttribute("data-lyrics-color") ?? null,
      colorVar: style?.getPropertyValue("--amll-lp-color").trim() ?? null,
      fontVar: style?.getPropertyValue("--amll-lp-font-size").trim() ?? null,
      inlineColor: stage?.style.getPropertyValue("--amll-lp-color").trim() ?? "",
      player: Boolean(stage?.querySelector(".amll-lyric-player")),
      chars: spans.length,
      active: (line?.textContent ?? "").slice(0, 40),
    };
  }, activeLineSelector);

  await page.setViewportSize({ width: 960, height: 720 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.evaluate(() => window.__guard.pause());
  await openSettingsLyricsPane(page);

  // ① 能力为假：这张卡不渲染（非 Windows 的路径）
  await setSupported(false);
  await refreshStatus();
  const hiddenCards = await page.evaluate((selector) => document.querySelectorAll(selector).length, CARD);
  add("r59-taskbar-card-needs-capability", hiddenCards === 0,
    JSON.stringify({ supported: false, cards: hiddenCards }));

  // ② 能力为真：卡片出现，三组控件都在
  await setSupported(true);
  await refreshStatus();
  await page.locator(CARD).waitFor();
  const controls = await page.evaluate((selector) => {
    const card = document.querySelector(selector);
    const has = (id) => Boolean(card?.querySelector(`#${id}`));
    return {
      color: has("taskbar-lyrics-color"), size: has("taskbar-lyrics-size"), karaoke: has("taskbar-lyrics-karaoke"),
      custom: has("taskbar-lyrics-custom-color"), reset: has("taskbar-lyrics-color-reset"),
      desktopGone: Boolean(card?.querySelector("#lyrics-size, #lyrics-style, #lyrics-layout")),
      text: (card?.textContent ?? "").trim().slice(0, 80),
    };
  }, CARD);
  add("r59-taskbar-card-controls",
    controls.color && controls.size && controls.karaoke && controls.custom && controls.reset && controls.desktopGone === false,
    JSON.stringify(controls));

  // 浅/深两色各一张（卡片本体，不是整页）
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.waitForTimeout(250);
    await page.locator(CARD).screenshot({ path: path.join(guardDir, `r59-taskbar-card-${theme}.png`) }).catch(async () => {
      await page.screenshot({ path: path.join(guardDir, `r59-taskbar-card-${theme}.png`) });
    });
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.waitForTimeout(150);

  // ③ 改得动：颜色令牌 / 字号 / 逐字开关 / 自定义色与恢复主题色——每次一条窄命令，只写 taskbar*
  await page.evaluate(() => window.__guard.resetConfigureCalls());
  await page.getByTestId("taskbar-lyrics-color").click();
  await page.getByTestId("taskbar-color-primary").click();
  await page.waitForFunction(() => window.__guard.desktopConfig().taskbarColor === "primary");
  await page.getByTestId("taskbar-lyrics-size").click();
  await page.getByTestId("taskbar-size-tsm").click();
  await page.waitForFunction(() => window.__guard.desktopConfig().taskbarSize === "tsm");
  await page.getByTestId("taskbar-lyrics-karaoke").click();
  await page.waitForFunction(() => window.__guard.desktopConfig().taskbarKaraoke === false);
  await page.locator("#taskbar-lyrics-custom-color").evaluate((input, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, "#00dd00");
  await page.waitForFunction(() => window.__guard.desktopConfig().taskbarCustomColor === "#00dd00");
  const writes = await page.evaluate(() => window.__guard.configureCalls());
  const onlyTaskbarKeys = writes.length >= 4
    && writes.every((patch) => Object.keys(patch).every((key) => key.startsWith("taskbar")));
  add("r59-taskbar-card-writes-only-taskbar-keys",
    onlyTaskbarKeys
      && writes.some((patch) => patch.taskbarColor === "primary")
      && writes.some((patch) => patch.taskbarSize === "tsm")
      && writes.some((patch) => patch.taskbarKaraoke === false)
      && writes.some((patch) => patch.taskbarCustomColor === "#00dd00"),
    JSON.stringify(writes));

  // ④ 任务栏模式的歌词窗按任务栏字段渲染
  await page.evaluate(() => window.__guard.setDesktop(true));
  await page.getByTestId("lyrics-window").waitFor();
  await page.setViewportSize({ width: 1200, height: 44 });
  await configure({ ...DESKTOP_BASELINE, mode: "taskbar", taskbarColor: "primary", taskbarSize: "tsm",
    taskbarCustomColor: "", taskbarKaraoke: false });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(250);

  const taskbarFirst = await readStage();
  await page.screenshot({ path: path.join(guardDir, "r59-taskbar-color.png") });
  add("r59-taskbar-uses-its-own-color-and-size",
    taskbarFirst.mode === "taskbar" && taskbarFirst.colorAttr === "primary"
      && taskbarFirst.size === "tsm" && taskbarFirst.fontVar !== "" && taskbarFirst.player,
    JSON.stringify({ colorAttr: taskbarFirst.colorAttr, colorVar: taskbarFirst.colorVar,
      size: taskbarFirst.size, fontVar: taskbarFirst.fontVar }));

  // ⑤ 逐字关闭：没有逐字 span，但仍是官方组件画的那一行
  await page.screenshot({ path: path.join(guardDir, "r59-taskbar-karaoke-off.png") });
  add("r59-taskbar-karaoke-off-falls-back-to-lines",
    taskbarFirst.karaoke === "off" && taskbarFirst.chars === 0 && taskbarFirst.player
      && taskbarFirst.active.length > 0,
    JSON.stringify({ karaoke: taskbarFirst.karaoke, chars: taskbarFirst.chars, active: taskbarFirst.active }));

  // ⑥ 换一档字号 + 打开逐字 + 换自定义色：三样都必须真的变
  await configure({ taskbarSize: "txxl", taskbarKaraoke: true, taskbarCustomColor: "#00dd00" });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(250);
  const taskbarSecond = await readStage();
  await page.screenshot({ path: path.join(guardDir, "r59-taskbar-size.png") });
  add("r59-taskbar-size-and-karaoke-switch",
    taskbarSecond.size === "txxl" && taskbarSecond.fontVar !== taskbarFirst.fontVar
      && taskbarSecond.karaoke === "on" && taskbarSecond.chars >= 5
      && taskbarSecond.inlineColor === "#00dd00",
    JSON.stringify({ size: [taskbarFirst.size, taskbarSecond.size],
      font: [taskbarFirst.fontVar, taskbarSecond.fontVar], karaoke: taskbarSecond.karaoke,
      chars: taskbarSecond.chars, inlineColor: taskbarSecond.inlineColor }));

  // ⑦ 桌面模式不受任务栏字段影响：同一套 taskbar* 值下，桌面字号/颜色仍是桌面自己的
  await page.setViewportSize({ width: 800, height: 128 });
  await configure({ ...DESKTOP_BASELINE, mode: "desktop", size: "sm", color: "muted", customColor: "#ff8800",
    taskbarSize: "tsm", taskbarColor: "primary", taskbarCustomColor: "#00dd00", taskbarKaraoke: false });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(250);
  const desktopStage = await readStage();
  await page.screenshot({ path: path.join(guardDir, "r59-desktop-unaffected.png") });
  add("r59-desktop-unaffected-by-taskbar-fields",
    desktopStage.mode === "desktop" && desktopStage.size === "sm" && desktopStage.colorAttr === "muted"
      && desktopStage.karaoke === "on" && desktopStage.inlineColor === "#ff8800"
      && desktopStage.fontVar !== taskbarSecond.fontVar,
    JSON.stringify({ size: desktopStage.size, colorAttr: desktopStage.colorAttr, karaoke: desktopStage.karaoke,
      inlineColor: desktopStage.inlineColor, fontVar: desktopStage.fontVar }));

  // 收尾：回桌面基线、能力复位、离开歌词窗（后面的用例从干净状态开始）
  await configure({ ...DESKTOP_BASELINE });
  await page.evaluate(() => window.__guard.setDesktop(false));
  await page.getByTestId("lyrics-window").waitFor({ state: "detached" });
  await setSupported(false);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(200);
}

/**
 * R60：色块显示的是**当前主题下的真实颜色**（桌面面板与任务栏卡共用一个纯函数）。
 *
 * 这一项单独成段：守卫页里壳与歌词窗互斥（`desktop ? <LyricsWindow/> : <LibraryShell/>`），
 * 而"色块 == 歌词实际颜色"要求两边都读到——先在任务栏歌词窗里用画布取官方播放器真正用的那个
 * 颜色（独立于渲染层的换算），再回主界面读设置页那张卡的色块，两处必须是同一个十六进制值。
 */
export async function checkLyricsColorSwatches(page, guardDir, add) {
  const CARD = '[data-testid="taskbar-lyrics-card"]';
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  const setSupported = (value) => page.evaluate((next) => window.__guard.setTaskbarSupported(next), value);
  /** 官方播放器里探针继承到的颜色 → 画布取像素（与渲染层的换算完全独立）。 */
  const playerColor = () => page.evaluate(() => {
    const player = document.querySelector('[data-testid="lyrics-window"] .amll-lyric-player');
    if (!player) return null;
    const probe = document.createElement("span");
    player.appendChild(probe);
    const css = getComputedStyle(probe).color;
    probe.remove();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { computed: css, hex: "#" + [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("") };
  });

  await page.setViewportSize({ width: 1200, height: 44 });
  await setSupported(true);
  await configure({ ...DESKTOP_BASELINE, mode: "taskbar", taskbarColor: "primary", taskbarCustomColor: "",
    taskbarSize: "txxl", taskbarKaraoke: true });
  await page.evaluate(() => window.__guard.setDesktop(true));
  await page.getByTestId("lyrics-window").waitFor();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__guard.desktopDocument());
  await page.waitForTimeout(250);

  const actual = {};
  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.waitForTimeout(300);
    actual[theme] = await playerColor();
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.evaluate(() => window.__guard.setDesktop(false));
  await page.getByTestId("lyrics-window").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 960, height: 720 });
  await openSettingsLyricsPane(page);
  await page.locator(CARD).waitFor();
  await page.waitForTimeout(300);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await page.waitForTimeout(350);
    const swatch = await page.locator("#taskbar-lyrics-custom-color").inputValue();
    add(`r60-taskbar-swatch-follows-theme-${theme}`,
      actual[theme] !== null && swatch === actual[theme].hex,
      JSON.stringify({ theme, swatch, expected: actual[theme] && actual[theme].hex, computed: actual[theme] && actual[theme].computed }));
    await page.locator(CARD).screenshot({ path: path.join(guardDir, `r60-taskbar-swatch-${theme}.png`) })
      .catch(async () => { await page.screenshot({ path: path.join(guardDir, `r60-taskbar-swatch-${theme}.png`) }); });
  }
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await page.waitForTimeout(150);

  // 收尾：能力复位、回桌面基线（后面的用例从干净状态开始）
  await setSupported(false);
  await configure({ ...DESKTOP_BASELINE });
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(200);
}

/**
 * R56：设置页「日志」标签——日志文件真的显示出来、级别标识与筛选真的生效。
 *
 * 夹具覆盖四档级别 + 一条带假 token 的行；判据里"DOM 里搜不到那串"是脱敏的证据，
 * "没有横向溢出"是布局的证据（长行必须断行，不许把卡片撑破）。
 */
export async function checkSettingsLogPane(page, guardDir, add) {
  const openLogPane = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByTestId("settings-page").waitFor();
    await page.getByTestId("settings-page").getByRole("tab", { name: "日志", exact: true }).click();
    await page.getByTestId("log-terminal").waitFor();
    await page.waitForTimeout(250);
  };
  const snapshot = () => page.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-testid="log-line"]')];
    const badges = [...document.querySelectorAll('[data-testid="log-level-badge"]')];
    const pane = document.querySelector('[data-testid="log-lines"]');
    const terminal = document.querySelector('[data-testid="log-terminal"]');
    return {
      lines: lines.length,
      levels: badges.map((node) => node.getAttribute("data-level")),
      variants: badges.map((node) => node.getAttribute("data-variant")),
      lineTexts: lines.map((node) => (node.textContent ?? "").trim()),
      count: (document.querySelector('[data-testid="log-count"]')?.textContent ?? "").trim(),
      text: (terminal?.textContent ?? "").trim(),
      pressed: [...document.querySelectorAll('[data-testid^="log-level-"][aria-pressed]')]
        .map((node) => [node.getAttribute("data-testid"), node.getAttribute("aria-pressed")]),
      paneOverflowX: pane ? pane.scrollWidth - pane.clientWidth : null,
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      failure: (document.querySelector('[data-testid="log-failure"]')?.textContent ?? "").trim(),
    };
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.__guard.resetRunLog());
  await openLogPane();

  const opened = await snapshot();
  const reads = (await page.evaluate(() => window.__guard.runLogReads())).length;
  add("r56-log-reads-on-open", reads >= 1, `打开日志标签必须读一次日志文件，实际 ${reads} 次`);
  add(
    "r56-log-shows-file-entries",
    opened.lines === 3 && opened.count === "3 / 4 条",
    `默认三档（debug 关着）：${JSON.stringify({ lines: opened.lines, count: opened.count, levels: opened.levels })}`,
  );
  add(
    "r56-log-level-badges",
    opened.levels.join(",") === "info,warn,error" && opened.variants.join(",") === "secondary,default,destructive",
    `每行一个级别标识（官方变体）：${JSON.stringify({ levels: opened.levels, variants: opened.variants })}`,
  );
  add(
    "r56-log-default-level-buttons",
    opened.pressed.filter(([, pressed]) => pressed === "true").length === 3
      && opened.pressed.some(([id, pressed]) => id === "log-level-debug" && pressed === "false"),
    `默认选中 info/warn/error：${JSON.stringify(opened.pressed)}`,
  );
  await page.screenshot({ path: path.join(guardDir, "r56-log-entries.png") });

  // 打开 debug 那一档：多出一行（筛选真的按级别走，不是摆设）
  await page.getByTestId("log-level-debug").click();
  await page.waitForTimeout(200);
  const withDebug = await snapshot();
  add(
    "r56-log-debug-toggle",
    withDebug.lines === 4 && withDebug.count === "4 / 4 条" && withDebug.levels.includes("debug"),
    `勾上「调试」要多一条：${JSON.stringify({ lines: withDebug.lines, count: withDebug.count })}`,
  );

  // 文本搜索：只有那一行
  await page.getByTestId("log-filter").fill("代理");
  await page.waitForTimeout(200);
  const filtered = await snapshot();
  add(
    "r56-log-text-filter",
    filtered.lines === 1 && filtered.count === "1 / 4 条" && filtered.lineTexts[0].includes("代理"),
    `搜索「代理」只剩那条：${JSON.stringify({ lines: filtered.lines, count: filtered.count })}`,
  );
  await page.screenshot({ path: path.join(guardDir, "r56-log-filtered.png") });

  // 无命中：另一句话
  await page.getByTestId("log-filter").fill("这条不存在");
  await page.waitForTimeout(200);
  const noMatch = await snapshot();
  add(
    "r56-log-no-match",
    noMatch.lines === 0 && noMatch.count === "0 / 4 条" && noMatch.text.length > 0,
    `没命中要显示"被筛掉了"：${JSON.stringify({ count: noMatch.count, text: noMatch.text.slice(0, 40) })}`,
  );

  // 脱敏：夹具里那串假 token 一个字都不许出现在界面上
  await page.getByTestId("log-filter").fill("");
  await page.waitForTimeout(200);
  const masked = await snapshot();
  add(
    "r56-log-credentials-masked",
    !masked.text.includes("guardsecret123456") && masked.text.includes("***"),
    `界面不许出现凭据原文（宿主与渲染层各挡一次）：${JSON.stringify(masked.text.slice(0, 80))}`,
  );
  add(
    "r56-log-no-horizontal-overflow",
    masked.paneOverflowX !== null && masked.paneOverflowX <= 0 && masked.documentOverflowX <= 0,
    `日志区不许横向溢出：${JSON.stringify({ pane: masked.paneOverflowX, document: masked.documentOverflowX })}`,
  );

  // 空文件：与"被筛掉"不是同一句话（先量这一档，再播提示——提示会留在外壳状态里）
  await page.evaluate(() => window.__guard.setRunLogPlan({ mode: "empty" }));
  await page.getByTestId("log-refresh").click();
  await page.waitForTimeout(250);
  const empty = await snapshot();
  add(
    "r56-log-empty-state",
    empty.text.includes(RUN_LOG_EMPTY_TEXT) && empty.count === "0 / 0 条",
    `空文件要显示空态：${JSON.stringify({ text: empty.text.slice(0, 40), count: empty.count })}`,
  );
  await page.screenshot({ path: path.join(guardDir, "r56-log-empty.png") });

  // 提示条目：经真实广播通道进来一条，来源标「提示」
  await page.evaluate(() => window.__guard.emitNotice("守卫提示：代理按环境变量生效"));
  await page.waitForTimeout(300);
  const withNotice = await snapshot();
  add(
    "r56-log-notice-entries",
    withNotice.lines === 1 && withNotice.text.includes("提示"),
    `app:notice 的条目要标来源「提示」：${JSON.stringify({ lines: withNotice.lines, count: withNotice.count })}`,
  );

  // 读失败：一句带下一步的提示，且不留旧内容冒充新结果
  await page.evaluate(() => window.__guard.setRunLogPlan({ failTimes: 1 }));
  await page.getByTestId("log-refresh").click();
  await page.waitForTimeout(250);
  const failed = await snapshot();
  add(
    "r56-log-read-failure",
    failed.failure === RUN_LOG_FAILURE_TEXT && failed.lines <= 1,
    `读失败要说出来：${JSON.stringify({ failure: failed.failure, lines: failed.lines })}`,
  );

  // 复位：夹具与页面都回到干净状态（后面的用例从这里继续）
  await page.evaluate(() => window.__guard.resetRunLog());
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await page.waitForTimeout(150);
}

/**
 * R52：沉浸式歌词**禁止改色**——桌面歌词的颜色与它无关（R50 的 `playerLyrics` 已整段删除）。
 *
 * 三层判据（缺一层就可能是"看起来没变色，其实只是没生效"）：
 * 1. 结构：沉浸页舞台根节点没有 `data-lyrics-color`，也没有内联 `--amll-lp-color` 覆盖；
 * 2. 令牌：算出来的 `--amll-lp-color` **就是**主题前景色（`--foreground`），不是某个写死的颜色；
 * 3. 像素：把**桌面歌词**的自定义色设成绿色之后（弹出窗里那枚取色器写的就是这条命令），
 *    沉浸页当前行的墨色仍是主题前景色——不偏绿。
 */
export async function checkImmersiveLyricsColorIsFixed(page, guardDir, add) {
  const configureDesktop = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  const mainLine = '[data-testid="amll-lyrics-panel"] [class*="lyricMainLine"][class*="active"]';
  const isGreen = (ink) => Boolean(ink?.mean) && ink.count > 40
    && ink.mean[1] > ink.mean[0] + 60 && ink.mean[1] > ink.mean[2] + 60;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configureDesktop({ ...DESKTOP_BASELINE, customColor: "#00dd00" });
  await page.evaluate(() => window.__guard.restoreLyrics());
  await page.evaluate(() => { window.__guard.pause(); window.__guard.setTime(700); });
  await page.getByRole("button", { name: "打开歌词", exact: true }).click();
  await page.getByTestId("playback-stage").waitFor();
  await page.waitForTimeout(1000);

  const structure = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="amll-lyrics-panel"]');
    if (!panel) return null;
    return {
      attribute: panel.getAttribute("data-lyrics-color"),
      inline: panel.getAttribute("style") ?? "",
      token: getComputedStyle(panel).getPropertyValue("--amll-lp-color").trim(),
      foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
    };
  });
  add("r52-immersive-has-no-color-attribute",
    Boolean(structure) && structure.attribute === null && !structure.inline.includes("--amll-lp-color"),
    JSON.stringify(structure));
  add("r52-immersive-uses-the-theme-token",
    Boolean(structure) && structure.token !== "" && structure.token === structure.foreground,
    JSON.stringify(structure));

  const ink = await inkColor(page, mainLine, path.join(guardDir, "r52-immersive-color-fixed.png"));
  add("r52-immersive-ink-is-not-green", ink.count > 40 && !isGreen(ink), JSON.stringify({ ink: ink.mean, count: ink.count }));

  // 绿色确实写进了**桌面歌词**那份配置（否则上一条就是假绿）
  const stored = await page.evaluate(() => window.__guard.desktopConfig());
  add("r52-desktop-color-still-its-own", stored.customColor === "#00dd00", `桌面歌词 customColor=${stored.customColor}`);

  await page.getByTestId("playback-stage").getByRole("button", { name: "收起歌词", exact: true }).click();
  await page.getByTestId("playback-stage").waitFor({ state: "detached" });
  await configureDesktop({ ...DESKTOP_BASELINE });
}

/**
 * R50（brief 第 3 项）：透明桌面歌词的**衬底**必须让两种"最坏桌面"都读得清。
 *
 * 这个窗是透明的，所以量"可读性"只能靠像素：把页面底色当桌面壁纸，改极端的白/黑，
 * 再看墨色与背景的亮度差（`inkContrast`）。同时看结构：`data-lyrics-scrim` 与根节点算出来的
 * 背景色——`panel`（Card 自己有背景）与 `mode=taskbar`（要透出系统任务栏）都必须是透明的。
 */
export async function checkDesktopLyricsScrim(page, guardDir, add) {
  const configure = (patch) => page.evaluate((next) => window.__guard.configureDesktop(next), patch);
  const activeLine = '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]';
  /** 模拟桌面：窗口透明，页面底色就是"桌面壁纸"。 */
  const setWallpaper = (color) => page.evaluate((value) => { document.body.style.background = value; }, color);
  const rootScrim = () => page.evaluate(() => {
    const root = document.querySelector('[data-testid="lyrics-window"]');
    if (!root) return null;
    return {
      attr: root.getAttribute("data-lyrics-scrim"),
      background: getComputedStyle(root).backgroundColor,
      mode: root.getAttribute("data-lyrics-mode"),
      style: root.getAttribute("data-lyrics-style"),
    };
  });

  await page.setViewportSize({ width: 800, height: 128 });
  for (const [theme, wallpaper, label] of [["dark", "#ffffff", "white-desktop"], ["light", "#101010", "dark-desktop"]]) {
    await page.evaluate((choice) => { document.documentElement.className = choice; }, theme);
    await setWallpaper(wallpaper);
    await configure({ ...DESKTOP_BASELINE, style: "clean", mode: "desktop" });
    await page.evaluate(() => window.__guard.desktopDocument());
    await page.waitForTimeout(1000);
    const scrim = await rootScrim();
    const pixels = await inkContrast(page, activeLine, path.join(guardDir, `r50-scrim-${label}-line.png`));
    add(`r50-scrim-readable-${label}`,
      Boolean(scrim) && scrim.attr === "on" && scrim.background !== "rgba(0, 0, 0, 0)"
        && pixels.changed > 40 && pixels.contrast > 60,
      JSON.stringify({ scrim, changed: pixels.changed, contrast: pixels.contrast, ink: pixels.inkRgb }));
    await page.screenshot({ path: path.join(guardDir, `r50-scrim-${label}-window.png`) });

    for (const [style, mode] of [["panel", "desktop"], ["clean", "taskbar"]]) {
      await configure({ ...DESKTOP_BASELINE, style, mode });
      await page.waitForTimeout(500);
      const plain = await rootScrim();
      add(`r50-scrim-absent-${style}-${mode}`,
        Boolean(plain) && plain.attr === "off" && plain.background === "rgba(0, 0, 0, 0)",
        JSON.stringify(plain));
    }
  }
  await page.evaluate(() => { document.body.style.removeProperty("background"); });
  await page.evaluate(() => { document.documentElement.className = "light"; });
  await configure({ ...DESKTOP_BASELINE });
}

/**
 * R45A3：库列表触底分页的**真浏览器**验收（mockIPC 边界给夹具，组件与样式都是真的）。
 *
 * 钉七件事，每一件都是"看起来在分页、其实在撒谎"的地方：
 * 1. 首屏只有第一页（歌单 120 首只拿到 50，状态行说"已加载 50 首"，头部说"共 120 首"）；
 * 2. 没有用户手势时**一页都不多取**（不许自动连拉）；
 * 3. 触底只发一次第 2 页：请求在途期间再滚三次也被吞掉（正在请求不重复发）；
 * 4. 每页完成后要用户再次接近底部才取第 3 页；没有下一页之后哨兵消失、不再催滚动；
 * 5. "播放全部"把**整张歌单**（120 首）放进队列——整表已在内存，不再只作用于已渲染的 50 首；
 * 6. 专辑页第一次失败给出可点的重试，第二次成功（失败不自动重试、也不丢页面）；
 * 7. 换关键词时旧查询的迟到响应被丢掉；歌手/历史后端不分页，只本地分批（R55 起不挂说明文案）。
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
   * 所以下面这个数字不可能来自"夹具替我们分好了页"：
   * - `playlistFetches()` = 假上游被调用的次数 → 整份只取一次网络；
   *
   * 那句"服务端一次返回整张歌单…"的说明**不再显示**（锚点与文案一起删，R55）。
   */
  const sliceNoticeCount = await page.getByTestId("playlist-local-slice").count();
  const firstFetches = await page.evaluate(() => window.__guard.playlistFetches());
  add("pagination-first-page-is-local-slice", firstFetches.length === 1
    && sliceNoticeCount === 0
    && !detailText.includes("本地切片") && !detailText.includes("整张歌单（"),
  JSON.stringify({ fetches: firstFetches.length, sliceNoticeCount }));

  // ② 没人动它就不许自己取第 2 页（"不无限自动连续请求"）
  await page.waitForTimeout(800);
  const idleCalls = await callsOf("library:playlist-detail");
  add("pagination-no-auto-chain", idleCalls.length === 1 && (await rowCount()) === 50,
    JSON.stringify({ pages: idleCalls.map((call) => call.page) }));

  // ③ R55："播放全部"作用于**整张歌单**（120 首），不是已渲染的那 50 首
  await page.getByRole("button", { name: "播放全部", exact: true }).click();
  await page.waitForFunction((total) => window.__guard.queueLength() === total, PAGINATION_FIXTURE.total, { timeout: 5000 }).catch(() => {});
  const queued = await page.evaluate(() => window.__guard.queueLength());
  await page.evaluate(() => window.__guard.pause());
  add("pagination-play-all-whole-playlist", queued === PAGINATION_FIXTURE.total,
    `队列 ${queued} 首（整张歌单 ${PAGINATION_FIXTURE.total} 首，页面只渲染了 50 行）`);
  await page.screenshot({ path: path.join(guardDir, "r55-playlist-detail.png") });
  const queueState = () => page.evaluate(() => {
    const state = window.__guard.snapshot();
    return { length: state.entries.length, index: state.index, name: state.track?.name ?? null };
  });

  /**
   * ③b R55 修订：双击一行与「播放全部」同一基准——整表在内存就是整张表。
   * 双击第 3 行必须排出 120 首、当前曲目是第 3 首（用已显示的 50 行当队列，
   * "下一首"会在第 50 首处断掉，而界面上已没有任何一句话提这件事）。
   */
  await table.locator("tbody tr").nth(2).dblclick();
  await page.waitForFunction((total) => {
    const state = window.__guard.snapshot();
    return state.index === 2 && state.entries.length === total;
  }, PAGINATION_FIXTURE.total, { timeout: 5000 }).catch(() => {});
  const dblClickQueue = await queueState();
  await page.evaluate(() => window.__guard.pause());
  add("pagination-dblclick-whole-playlist", dblClickQueue.length === PAGINATION_FIXTURE.total
    && dblClickQueue.index === 2 && dblClickQueue.name === "歌单曲目 3", JSON.stringify(dblClickQueue));

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
  add("pagination-pages-2-3-one-network-fetch", finalFetches.length === 1
    && (await page.getByTestId("playlist-local-slice").count()) === 0,
  JSON.stringify({ fetches: finalFetches.length }));

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

  // ⑧ 歌手页：后端不分页（一次响应 120 首），本地每批 50，且不再挂说明文案（R55）
  await table.getByRole("button", { name: "守卫艺人", exact: true }).first().click();
  await visibleRowsIn(50);
  const artistStatus = await statusText();
  const artistCalls = await callsOf("library:artist");
  add("pagination-local-reveal-first-batch", artistCalls.length === 1 && (await rowCount()) === 50
    && artistStatus === "" && (await page.getByTestId("list-pagination-status").count()) === 0,
  JSON.stringify({ artistCalls: artistCalls.length, artistStatus }));
  await wheelContent(20000);
  await visibleRowsIn(100);
  const artistRevealed = await rowCount();
  const artistCallsAfter = (await callsOf("library:artist")).length;
  add("pagination-local-reveal-no-extra-network", artistCallsAfter === 1 && artistRevealed >= 100,
    `揭示 ${artistRevealed} 条，网络请求 ${artistCallsAfter} 次`);

  // ⑨ 历史页：同一类（本地分批），一次响应就是全部；R55 起不再挂说明文案
  // 先回到顶部：内容区滚到底的位置会被下一张列表继承，哨兵一挂上就在视口里 → 会立刻再揭示一批
  // （那是本地揭示、不是网络请求；但"首屏 50 条"这件事要在同一基线上量）
  await scrollToTop();
  await page.getByRole("button", { name: "播放历史", exact: true }).click();
  await visibleRowsIn(50);
  const historyStatus = await statusText();
  add("pagination-history-local-batch", (await callsOf("library:history")).length === 1
    && (await rowCount()) === 50 && historyStatus === "",
  JSON.stringify({ historyStatus }));
  await page.screenshot({ path: path.join(guardDir, "r55-playlist-history.png") });

  // ⑨b R55 修订：历史页双击第 2 行 → 队列是本页整份历史（120），当前曲目是第 2 首
  await table.locator("tbody tr").nth(1).dblclick();
  await page.waitForFunction((total) => {
    const state = window.__guard.snapshot();
    return state.index === 1 && state.entries.length === total;
  }, PAGINATION_FIXTURE.total, { timeout: 5000 }).catch(() => {});
  const historyQueue = await queueState();
  await page.evaluate(() => window.__guard.pause());
  add("pagination-dblclick-history-whole-list", historyQueue.length === PAGINATION_FIXTURE.total
    && historyQueue.index === 1 && historyQueue.name === "历史曲目 2", JSON.stringify(historyQueue));

  /**
   * ⑨c R55 修订反向项：收藏页是**服务端真分页**的来源，只有已加载的那批是已知的。
   * 双击第 2 行时队列仍等于已加载条数（行为不变，不许顺手把"未加载"当成"有"）。
   */
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await page.getByTestId("favorites-page").waitFor();
  await visibleRowsIn(36);
  const favoritesRows = await rowCount();
  await table.locator("tbody tr").nth(1).dblclick();
  await page.waitForFunction(() => window.__guard.snapshot().index === 1, null, { timeout: 5000 }).catch(() => {});
  const favoritesQueue = await queueState();
  await page.evaluate(() => window.__guard.pause());
  add("pagination-dblclick-favorites-loaded-only", favoritesRows === 36
    && favoritesQueue.length === favoritesRows && favoritesQueue.index === 1, JSON.stringify({ ...favoritesQueue, favoritesRows }));

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

/**
 * R66b：主内容区铺满。逐页量内容右边缘到可用区域右边缘的空白，要求不超过页面左内边距 + 8px，且无横向滚动。
 * 1900 宽下再人为恢复 768px 上限量一次，证明判据抓得住这类缺陷；960×600 检查设置卡片回到单列。
 * 明细写入 `.tmp/browser-guard/r66b-page-fill.json`。
 */
export async function checkPageFill(page, guardDir, add) {
  const sizes = [
    { width: 1280, height: 800 },
    { width: 1900, height: 1000 },
    { width: 960, height: 600 },
  ];
  const rows = [];
  /** 某一步点不到东西时，报错第一行要说是哪一步（否则只剩 playwright 的 "Timeout exceeded"）。 */
  const step = async (name, run) => {
    try {
      return await run();
    } catch (cause) {
      throw new Error(`步骤「${name}」：${String(cause?.message ?? cause).split("\n").slice(0, 2).join(" / ")}`);
    }
  };
  /**
   * 先回到主界面。守卫页面里 shell 与桌面歌词窗是**互斥**的（`desktop ? <LyricsWindow/> : <LibraryShell/>`），
   * 而上一轮验收（桌面歌词）留下的正是后者——那个状态下连侧栏导航都不存在，点什么都只会等到超时。
   */
  await page.setViewportSize({ width: sizes[0].width, height: sizes[0].height });
  await page.evaluate(() => window.__guard.setDesktop(false));
  await page.getByTestId("main-content").waitFor();
  await page.waitForTimeout(300);
  // 侧栏窄轨里没有导航文案：先展开；整个关着时用官方触发器（上一轮可能把它收进窄轨/Sheet）
  if (await page.getByTestId("sidebar-search-rail").count()) await page.getByTestId("sidebar-search-rail").click();
  if (await page.getByRole("button", { name: "我的收藏", exact: true }).count() === 0
    && await page.locator('[data-sidebar="trigger"]').count() > 0) {
    await page.locator('[data-sidebar="trigger"]').first().click();
  }
  await page.getByRole("button", { name: "我的收藏", exact: true }).waitFor();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.__guard.pause();
    window.__guard.resetSettings();
  });

  /**
   * 可用宽度取最近一层纵向滚动容器的 clientWidth（滚动条不算留白）；
   * 对标值用页面自己的左内边距（左右应对称），不写死 16px。
   */
  const measure = (selector, { cards = false } = {}) => page.evaluate(({ target, withCards }) => {
    const container = document.querySelector('[data-testid="main-content"]');
    if (!container) return { found: false, reason: "找不到主内容区（main-content）" };
    // 常驻页（收藏）与按视图重挂的页同时在 DOM 里：取**真的画出来**的那一份
    const node = [...document.querySelectorAll(target)].find((candidate) => candidate.getClientRects().length > 0);
    if (!node) return { found: false, reason: `没有可见的 ${target}` };
    let scrollBox = node.parentElement;
    while (scrollBox && scrollBox !== container) {
      const style = getComputedStyle(scrollBox);
      const scrolls = (style.overflowY === "auto" || style.overflowY === "scroll")
        && scrollBox.scrollHeight > scrollBox.clientHeight;
      if (scrolls) break;
      scrollBox = scrollBox.parentElement;
    }
    let usable;
    if (scrollBox === null || scrollBox === container) {
      const rect = container.getBoundingClientRect();
      usable = { left: rect.left, width: container.clientWidth };
    } else {
      usable = { left: scrollBox.getBoundingClientRect().left, width: scrollBox.clientWidth };
    }
    const usableRight = usable.left + usable.width;
    const box = node.getBoundingClientRect();
    // 设置页：页面根铺满、里面那张卡却很窄 = 同一种"没铺满"（有人把宽度上限加回卡片上）
    const cardNodes = withCards
      ? [...node.querySelectorAll('[data-slot="card"]')].filter((child) => child.getClientRects().length > 0)
      : [];
    const cardRight = cardNodes.length === 0
      ? null
      : Math.max(...cardNodes.map((child) => child.getBoundingClientRect().right));
    return {
      found: true,
      usableWidth: Math.round(usable.width),
      contentWidth: Math.round(box.width),
      leftInset: Math.round(box.left - usable.left),
      rightBlank: Math.round(usableRight - box.right),
      cardBlank: cardRight === null ? null : Math.round(usableRight - cardRight),
      cards: cardNodes.length,
      overflowX: container.scrollWidth - container.clientWidth,
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, { target: selector, withCards: cards });

  const visit = async (size, label, selector, options) => {
    const measured = await measure(selector, options);
    rows.push({ viewport: `${size.width}x${size.height}`, page: label, ...measured });
    return measured;
  };
  /** 判据：右侧空白 ≤ 页面左侧内边距 + 8px，且没有横向滚动。 */
  const filled = (row) => row.found === true && row.rightBlank <= row.leftInset + 8
    && (row.cardBlank === null || row.cardBlank === undefined || row.cardBlank <= row.leftInset + 8)
    && row.overflowX <= 0 && row.documentOverflowX <= 0;
  const brief = (list) => list.map((row) => `${row.page} 左${row.leftInset}/右${row.rightBlank}`).join(" · ");

  /** 设置页当前可见标签里的卡片排布（第一行两张卡在同一 top = 两列）。 */
  const cardLayout = () => page.evaluate(() => {
    const pane = document.querySelector('[data-testid="settings-page"]');
    if (!pane) return { found: false };
    const cards = [...pane.querySelectorAll('[data-slot="card"]')].filter((node) => node.getClientRects().length > 0);
    const tops = cards.map((node) => Math.round(node.getBoundingClientRect().top));
    return {
      found: true,
      cards: cards.length,
      rows: new Set(tops).size,
      twoColumns: tops.length >= 2 && Math.abs(tops[0] - tops[1]) < 2,
    };
  });

  const openSettings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByTestId("settings-page").waitFor();
    await page.waitForTimeout(250);
  };
  const openTab = async (label) => {
    await page.getByTestId("settings-page").getByRole("tab", { name: label, exact: true }).click();
    await page.waitForTimeout(250);
  };
  const SETTINGS_TABS_UNDER_TEST = ["通用", "网络", "歌词", "日志"];
  const layoutAt = {};
  /** 每个尺寸一次的控制实验（见下面的"人为恢复 max-w-3xl"）。 */
  const controls = [];

  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(250);
    const measured = [];

    // ① 我的收藏（常驻页：切走只是 hidden）
    await step(`${size.width} 我的收藏`, async () => {
      await page.getByRole("button", { name: "我的收藏", exact: true }).click();
      await page.getByTestId("favorites-page").waitFor();
      await page.waitForTimeout(250);
    });
    measured.push(await visit(size, "我的收藏", '[data-testid="favorites-page"]'));
    if (size.width === 1900) await page.screenshot({ path: path.join(guardDir, "r66b-favorites-1900.png") });

    // ② 我的歌单（歌单网格自己带 p-4）
    await step(`${size.width} 我的歌单`, async () => {
      await page.getByRole("button", { name: "我的歌单", exact: true }).click();
      await page.getByTestId("playlist-grid").waitFor();
      await page.waitForTimeout(250);
    });
    measured.push(await visit(size, "我的歌单", '[data-testid="playlist-grid"]'));

    // ②b 歌单详情（同一套内容区；简报只点名了五个页面，这一页顺手一起量，免得"其它页也白"没依据）
    await step(`${size.width} 歌单详情`, async () => {
      await page.getByTestId("playlist-grid").getByRole("button", { name: "打开", exact: true }).first().click();
      await page.getByTestId("playlist-detail").waitFor();
      await page.waitForTimeout(400);
    });
    measured.push(await visit(size, "歌单详情", '[data-testid="playlist-detail"]'));

    // ③ 播放历史（曲目表：外层 px-4）
    await step(`${size.width} 播放历史`, async () => {
      await page.getByRole("button", { name: "播放历史", exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="track-table"]')]
        .some((node) => node.getClientRects().length > 0 && node.querySelectorAll("tbody tr").length > 0));
      await page.waitForTimeout(200);
    });
    measured.push(await visit(size, "播放历史", '[data-testid="track-table"]'));

    // ④ 搜索结果（同一个曲目表，走的是另一条视图）
    await step(`${size.width} 搜索结果`, async () => {
      const box = page.getByRole("textbox", { name: "搜索关键字" });
      await box.fill("守卫");
      await box.press("Enter");
      await page.waitForFunction(() => document.body.textContent.includes("搜索守卫曲目 1"), null, { timeout: 15_000 });
      await page.waitForTimeout(300);
    });
    measured.push(await visit(size, "搜索结果", '[data-testid="track-table"]'));

    // ⑤ 设置 4 个标签（报告里要的是每一类自己的排布）
    await step(`${size.width} 设置页`, async () => {
      await openSettings();
      for (const label of SETTINGS_TABS_UNDER_TEST) {
        await openTab(label);
        measured.push(await visit(size, `设置/${label}`, '[data-testid="settings-page"]', { cards: true }));
        if (label === "通用" || label === "歌词") layoutAt[`${size.width}-${label}`] = await cardLayout();
      }
    });

    /**
     * 控制实验（每个尺寸一次）：把旧的 `max-w-3xl` **人为塞回去**，同一套口径必须量出右侧空白。
     * 只有这一步能证明判据抓得住原来那个缺陷——不然"改完是绿的"也可能只是判据太松。
     */
    await openTab("通用");
    const before = await measure('[data-testid="settings-page"]', { cards: true });
    const injected = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="settings-page"]');
      if (!pane) return false;
      pane.dataset.guardMaxWidth = "1";
      pane.style.maxWidth = "768px";
      return true;
    });
    await page.waitForTimeout(200);
    const control = await measure('[data-testid="settings-page"]', { cards: true });
    if (size.width === 1900) await page.screenshot({ path: path.join(guardDir, "r66b-settings-before-maxw3xl.png") });
    await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="settings-page"]');
      if (!pane) return;
      pane.style.maxWidth = "";
      delete pane.dataset.guardMaxWidth;
    });
    await page.waitForTimeout(200);
    const after = await measure('[data-testid="settings-page"]', { cards: true });
    if (size.width === 1900) await page.screenshot({ path: path.join(guardDir, "r66b-settings-after-filled.png") });
    controls.push({ size, before, control, after, injected });
    rows.push({ viewport: `${size.width}x${size.height}`, page: "设置/通用（人为恢复 max-w-3xl）", ...control });

    const bad = measured.filter((row) => !filled(row));
    add(`r66b-fill-${size.width}`, bad.length === 0,
      `${size.width}×${size.height} 主内容区可用 ${measured[0]?.usableWidth ?? "?"}px；`
        + `${bad.length === 0 ? "全部页面铺满、无横向滚动" : "未铺满：" + JSON.stringify(bad)}`
        + `\n      ${brief(measured)}`);
  }

  /**
   * 控制实验的判据：人为恢复 `max-w-3xl` 之后，内容宽度必须正好被钳在 768（窗口够宽时）——
   * 右空白也就等于"可用宽度 − 左内边距 − 768"。960 宽时可用宽度只有 704，768 根本钳不到，
   * 所以那一档的期望值是"两侧各留 16"；真正的"旧缺陷复现"由 1280/1900 两档给出（各 > 200px）。
   */
  const controlMatches = (entry) => {
    const expectedWidth = Math.min(768, entry.control.usableWidth - 32);
    return entry.injected === true
      && entry.control.contentWidth === expectedWidth
      && entry.control.rightBlank === entry.control.usableWidth - entry.control.leftInset - expectedWidth
      && filled(entry.before) && filled(entry.after)
      && entry.after.rightBlank === entry.before.rightBlank;
  };
  add("r66b-fill-metric-catches-maxw3xl",
    controls.length === sizes.length && controls.every(controlMatches)
      && controls.filter((entry) => entry.control.rightBlank > 200).length >= 2,
    controls.map((entry) => `${entry.size.width}：旧上限右空白 ${entry.control.rightBlank}px（内容 ${entry.control.contentWidth}，左内边距 ${entry.control.leftInset}）→ 现在 ${entry.after.rightBlank}px`).join("；"));

  // 宽屏两列 / 窄屏单列（只在守卫里有意义：单列回归会让长卡横贯 1800px）
  const wide = layoutAt["1900-通用"];
  const wideLyrics = layoutAt["1900-歌词"];
  const narrow = layoutAt["960-通用"];
  add("r66b-settings-card-columns",
    wide?.found === true && wide.twoColumns && wideLyrics?.twoColumns === true
      && narrow?.found === true && narrow.twoColumns === false,
    JSON.stringify({ "1900 通用": wide, "1900 歌词": wideLyrics, "960 通用": narrow }));

  await writeFile(path.join(guardDir, "r66b-page-fill.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  // 收尾：回收藏页、复位设置（后面的用例从干净状态开始）
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await page.getByTestId("favorites-page").waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
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
    /**
     * R45B fix4：**真画滚动条**。
     *
     * Playwright 默认给 Chromium 带 `--hide-scrollbars`：滚动条不画、`offsetHeight - clientHeight == 0`，
     * 于是"用户拖原生滚动条"这件事在守卫里根本无从发生（fix3 的控制实验：隐藏时 `barSpace 0`、
     * 拖条不动；去掉之后 `barSpace 12`、RTL 条真能拖）。真窗是 WebView2，滚动条是画出来的，
     * 所以这里去掉那个默认参数——⑦e 的可达性判定就是靠"按下真条、真拖"。
     * 副作用为零：本仓只有竖排小窗（xxl）才会溢出出条，其余用例量到的几何不受影响。
     */
    const options = { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"], ignoreDefaultArgs: ["--hide-scrollbars"] };
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

  // R51：歌词设置弹出窗那一页（挂真 LyricsSettingsPopup，单独一扇窗 / 单独一份 IPC 夹具）
  await writeFile(path.join(guardDir, "lyrics-settings.tsx"), lyricsSettingsHarnessSource(), "utf8");
  const builtPopup = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [`${GUARD_DIR}/lyrics-settings.tsx`],
    outfile: `${GUARD_DIR}/lyrics-settings.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  if (builtPopup.errors.length > 0) throw new Error(`弹出窗守卫页面构建失败：${JSON.stringify(builtPopup.errors)}`);
  // R57：账号区四态那一页（挂真 App，IPC 只给门禁与空列表）
  await writeFile(path.join(guardDir, "account.tsx"), accountHarnessSource(), "utf8");
  const builtAccount = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [`${GUARD_DIR}/account.tsx`],
    outfile: `${GUARD_DIR}/account.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    jsx: "automatic",
    loader: { ".css": "css", ".png": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  if (builtAccount.errors.length > 0) throw new Error(`账号区守卫页面构建失败：${JSON.stringify(builtAccount.errors)}`);
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
  await writeFile(path.join(guardDir, "lyrics-settings.html"), lyricsSettingsHarnessHtml(), "utf8");
  await writeFile(path.join(guardDir, "account.html"), accountHarnessHtml(), "utf8");
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
  /**
   * 单项检查的护栏（R46）：检查自己抛错（选择器不存在、等待超时）时记一条 FAIL 并继续。
   * 理由：RED 阶段要读到的是"哪一项行为不成立"，而不是整轮守卫崩在第一项上。
   */
  const checked = async (id, run) => {
    try {
      await run();
    } catch (cause) {
      add(id, false, `检查过程抛错：${String(cause?.message ?? cause).split("\n")[0]}`);
    }
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
      const barToggle = page.getByTestId("player-lyrics-toggle");
      const barToggleLabel = await barToggle.getAttribute("aria-label");
      const togglesBeforeBar = await page.evaluate(() => window.__guard.lyricsToggles().length);
      await barToggle.click();
      await page.waitForTimeout(150);
      const afterBarToggle = await page.evaluate(() => window.__guard.lyricsToggles());
      await page.getByTestId("player-lyrics-toggle").click();
      await page.waitForTimeout(150);
      const afterBarToggleBack = await page.evaluate(() => window.__guard.lyricsToggles());
      add(`${theme}-bar-lyrics-toggle-once`, afterBarToggle.length === togglesBeforeBar + 1
        && afterBarToggleBack.length === togglesBeforeBar + 2 && afterBarToggleBack.at(-1) === false,
      JSON.stringify({ barToggleLabel, before: togglesBeforeBar, after: afterBarToggle, back: afterBarToggleBack }));
      /**
       * R46（有意更改 R45C 的这条几何断言）：传输组回到 mode → previous → play → next，
       * 歌词开关搬到**尾部工具区**（`player-bar-trailing`，右端）。
       *
       * 量的是几何而不是标记：模式/上一首/播放/下一首从左到右严格递增；开关在下一首的**右边**
       * 且落在尾部工具区的横向范围内（不是"挂在中间某处"）。
       */
      add(`${theme}-bar-lyrics-toggle-geometry`, await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="player-bar"]');
        const toggle = bar?.querySelector('[data-testid="player-lyrics-toggle"]');
        const mode = bar?.querySelector('button[aria-label^="播放模式："]');
        const previous = bar?.querySelector('button[aria-label="上一首"]');
        const play = bar?.querySelector('button[aria-label="播放"], button[aria-label="暂停"]');
        const next = bar?.querySelector('button[aria-label="下一首"]');
        const trailing = bar?.querySelector('[data-testid="player-bar-trailing"]');
        if (!toggle || !mode || !previous || !play || !next || !trailing) return { ok: false };
        const rect = (node) => node.getBoundingClientRect();
        const t = rect(toggle);
        const m = rect(mode);
        const p = rect(previous);
        const playRect = rect(play);
        const n = rect(next);
        const trail = rect(trailing);
        const transportOrder = m.right <= p.left + 1 && p.right <= playRect.left + 1 && playRect.right <= n.left + 1;
        return {
          ok: transportOrder && t.left >= n.right - 1 && t.left >= trail.left - 1 && t.right <= trail.right + 1,
          transportOrder,
          mode: Math.round(m.left), previous: Math.round(p.left), play: Math.round(playRect.left), next: Math.round(n.left),
          nextRight: Math.round(n.right), toggle: Math.round(t.left), trailing: [Math.round(trail.left), Math.round(trail.right)],
        };
      }).then((geometry) => geometry.ok), "传输组 模式→上一首→播放→下一首；歌词开关在尾部工具区（下一首右侧）");
      await page.getByRole("button", { name: "歌词", exact: true }).click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(1000);
      const box = await stage.boundingBox();
      const covered = await page.evaluate(() => [[12, 12], [12, 400], [1250, 400], [600, 780]].every(([x, y]) =>
        document.elementFromPoint(x, y)?.closest('[data-testid="playback-stage"]')));
      add(`${theme}-full-coverage`, box?.x === 0 && box?.y === 0 && box?.width === 1280 && box?.height === 800 && covered, `舞台 ${JSON.stringify(box)}，四角命中舞台=${covered}`);
      add(`${theme}-background`, await stage.locator('[data-testid="amll-background"] canvas').count() > 0, "完整舞台内使用官方背景画布");
      /**
       * R45C：收起按钮在**顶部中央**（几何居中而不是靠内容宽度凑），并且不压住官方控件；
       * 沉浸页与播放栏的歌词开关各点一次只发一次 `core_lyrics_toggle`。
       */
      const closeGeometry = await stage.evaluate((element) => {
        const button = element.querySelector('button[aria-label="收起歌词"]');
        if (!button) return null;
        const b = button.getBoundingClientRect();
        const center = b.x + b.width / 2;
        const hit = document.elementFromPoint(center, b.y + b.height / 2);
        return { center: Math.round(center), viewportCenter: Math.round(innerWidth / 2), top: Math.round(b.y), clickable: Boolean(hit && button.contains(hit)) };
      });
      add(`${theme}-stage-close-centered`, Boolean(closeGeometry) && closeGeometry.clickable
        && Math.abs(closeGeometry.center - closeGeometry.viewportCenter) <= 2 && closeGeometry.top <= 16,
      JSON.stringify(closeGeometry));
      const stageToggle = stage.getByTestId("stage-lyrics-toggle");
      const stageToggleLabel = await stageToggle.getAttribute("aria-label");
      const togglesBeforeStage = await page.evaluate(() => window.__guard.lyricsToggles().length);
      await stageToggle.click();
      await page.waitForTimeout(150);
      const afterStageToggle = await page.evaluate(() => window.__guard.lyricsToggles());
      await stage.getByTestId("stage-lyrics-toggle").click();
      await page.waitForTimeout(150);
      const afterStageToggleBack = await page.evaluate(() => window.__guard.lyricsToggles());
      add(`${theme}-stage-lyrics-toggle-once`, afterStageToggle.length === togglesBeforeStage + 1
        && afterStageToggle.at(-1) === true && afterStageToggleBack.length === togglesBeforeStage + 2
        && afterStageToggleBack.at(-1) === false,
      JSON.stringify({ stageToggleLabel, before: togglesBeforeStage, after: afterStageToggle, back: afterStageToggleBack }));
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

      await stage.getByRole("button", { name: "收起歌词", exact: true }).click();
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
      /**
       * R46：这一项的判据从"深色墨迹"改成"**字迹画出来了**"（`changed`）。
       *
       * 为什么必须改（有意更改 R44 起的这条口径）：R46 让主窗面板也吃官方逐字时间
       * （`withKaraokeWords`），官方对"还没唱到"的词用遮罩压到 `--dark-mask-alpha`（0.2~0.4）。
       * 夹具的第二行结束时间来自 `parseLrc` 的哨兵值（59999999ms），所以 3300ms 时整行都"还没唱到"
       * ——字是画出来的，但只有四成不透明度，`luminance < 95` 这个"深色"判据必然为 0
       * （实测 `{"ink":0,"changed":1137}`）。字迹是否真的画出来用 `changed`（可见帧 vs 隐藏帧的差异像素）
       * 来判，与主题无关；"第二行激活"照旧。
       */
      const progressed = await textPixels(page, activeLine, theme, path.join(guardDir, `${theme}-seek-line.png`));
      const secondActive = await page.locator(activeLine).first().textContent().catch(() => "");
      add(`${theme}-seek-text-pixels`, progressed.changed > 200 && secondActive?.includes("第二行"),
        `${JSON.stringify(progressed)}，第二行激活=${secondActive?.includes("第二行")}`);

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
        const candidates = [element, ...element.querySelectorAll('[data-testid="playback-stage-cover"], [data-testid="playback-stage-cover"] *, [data-testid="playback-stage-player"] *, button[aria-label="收起歌词"], button[aria-label="收起歌词"] *')];
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
      await stage.getByRole("button", { name: "收起歌词", exact: true }).click();
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
     * R46 的逐字着色 + R52 的**沉浸式歌词禁止改色** + 设置页「歌词」标签的新形态。
     * 放在两轮主题之后、R45C 开关验收之前：这几项都只碰当前这一页的舞台与设置页，用后各自复位。
     *
     * 都经过 `checked()`：单项检查自己抛错（选择器还不存在、等待超时）记一条 FAIL 并继续，
     * 而不是把整轮守卫打断——RED 阶段要看到的是"哪一项不成立"，不是"脚本崩了"。
     *
     * R52 有意删除 R50 的两项（`r50-player-lyrics-separation` 与新卡片上的取色器检查）：
     * 沉浸式歌词不再有颜色入口，桌面歌词的颜色只在外观弹出窗里改（R51 那两项仍在跑）。
     */
    await checked("r46-immersive-karaoke", () => checkImmersiveKaraoke(page, guardDir, add));
    await checked("r52-settings-page-lyrics-pane", () => checkSettingsPageLyricsCard(page, guardDir, add));
    /** R59：任务栏歌词的独立外观（设置页那张卡 → 任务栏歌词窗的实际渲染）。 */
    await checked("r59-taskbar-lyrics-settings", () => checkTaskbarLyricsSettings(page, guardDir, add));
    /** R60：色块显示主题下的真实颜色（与歌词窗里实际用到的颜色逐个主题对上）。 */
    await checked("r60-lyrics-color-swatches", () => checkLyricsColorSwatches(page, guardDir, add));
    /** R56：设置页「日志」标签（日志文件条目 + 级别标识 + 筛选 + 脱敏 + 空态）。 */
    await checked("r56-settings-log-pane", () => checkSettingsLogPane(page, guardDir, add));
    await checked("r52-immersive-lyrics-color-fixed", () => checkImmersiveLyricsColorIsFixed(page, guardDir, add));
    /**
     * R45C：播放栏/沉浸页快捷开关的真行为（延迟 IPC 下的双击、拒绝后恢复、两种模式、菜单层级）。
     * 放在两轮主题之后、分页之前：它自己重新载入主页，只碰播放栏与沉浸页。
     */
    await checkPlaybackLyricsToggle(page, port, guardDir, add);
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
    await checkDesktopInteraction(page, guardDir, add);
    /** R51：歌词窗里只剩齿轮——点它把锚点交给宿主，菜单搬到了另一扇窗（下面那一项量那一页）。 */
    await checked("r51-desktop-settings-gear", () => checkDesktopLyricsSettings(page, guardDir, add));
    /** R50：透明桌面歌词的令牌衬底（白桌面/深色主题、深桌面/浅色主题都要读得清）。 */
    await checked("r50-desktop-lyrics-scrim", () => checkDesktopLyricsScrim(page, guardDir, add));
    /**
     * 官方演出开关（R44 起的既有覆盖，R45B 保留）：还能真的关掉弹簧/模糊、还能真的做缩放。
     * 放在交互验收之后：它要一段"播放中"的稳定画面。
     */
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
    await page.evaluate(() => window.__guard.configureDesktop({ enableBlur: true, enableScale: true, enableSpring: true }));
    await page.setViewportSize({ width: 800, height: 128 });
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
      const pixels = await inkContrast(page, '[data-testid="lyrics-window"] [class*="lyricMainLine"][class*="active"]', path.join(guardDir, `${theme}-desktop-line.png`));
      add(`${theme}-desktop-text-pixels`, pixels.changed > 60 && pixels.contrast > 40, JSON.stringify(pixels));
      for (const status of ["empty", "failed"]) {
        await page.evaluate((value) => window.__guard.desktopDocument(value), status);
        await page.getByTestId("lyrics-window").getByRole("status").waitFor();
        const notice = await inkContrast(page, '[data-testid="lyrics-window"] [role="status"]', path.join(guardDir, `${theme}-desktop-${status}.png`));
        add(`${theme}-desktop-${status}`, notice.changed > 30, JSON.stringify(notice));
      }
    }
    await checkDesktopSurface(page, guardDir, add);
    /** R58：行内逐字扫亮（桌面横版 clean/panel、任务栏、竖版现状、播放态随进度消息）。 */
    await checked("r58-lyrics-karaoke", () => checkLyricsKaraoke(page, guardDir, add));
    /**
     * R51：设置弹出窗那一页（真组件 + 真产物 CSS）。用**另一页**跑：它会改 viewport 与主题类，
     * 而主页面后面还有几项要用当前的桌面窗状态。
     */
    await checked("r60-lyrics-settings-popup", async () => {
      const popupPage = await browser.newPage({ viewport: { width: 420, height: 720 }, colorScheme: "light" });
      popupPage.setDefaultTimeout(15_000);
      popupPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`[popup] ${message.text()}`); });
      popupPage.on("pageerror", (error) => pageErrors.push(`[popup] ${error.message}`));
      try {
        await checkLyricsSettingsPopup(popupPage, port, guardDir, add);
      } finally {
        await popupPage.close();
      }
    });
    /** R66b：主内容区宽度。会遍历各主页面并切换窗口尺寸，所以排在倒数第二（下一项自己 goto）。 */
    await checked("r66b-page-fill", () => checkPageFill(page, guardDir, add));
    /** R57：账号区四态（另一页，挂真 App；头像的两种结局都用 page.route 造出来）。 */
    await checked("r57-account-area", async () => {
      const accountPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light", deviceScaleFactor: 2 });
      accountPage.setDefaultTimeout(15_000);
      accountPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`[account] ${message.text()}`); });
      accountPage.on("pageerror", (error) => pageErrors.push(`[account] ${error.message}`));
      const avatar = await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 90, g: 150, b: 210 } } }).png().toBuffer();
      await accountPage.route("https://music.dbankcdn.cn/guard-avatar.png", (route) => route.fulfill({
        contentType: "image/png", body: avatar, headers: { "access-control-allow-origin": "*" },
      }));
      await accountPage.route("https://music.dbankcdn.cn/guard-avatar-broken.png", (route) => route.fulfill({
        status: 200, contentType: "image/png", body: Buffer.from("invalid image"), headers: { "access-control-allow-origin": "*" },
      }));
      try {
        await checkAccountArea(accountPage, port, guardDir, add);
      } finally {
        await accountPage.close();
      }
    });
    /** R45C：没有 lyrics binding 的挂载点（另一页，见 checkNoBindingSurface 的说明）。 */
    await checkNoBindingSurface(page, port, add);
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
