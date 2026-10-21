/**
 * R12 桌面歌词窗与任务栏降级：跨语言契约 + 纯逻辑 + 无注入扫描。
 *
 * 这个文件钉三类"写错只有用户能发现"的事：
 *
 * 1. **跨语言名字**：新增请求频道 `playback:lyrics`、三条广播（`lyrics:document` /
 *    `lyrics:progress` / `lyrics:state`）、四条 tauri 命令（toggle/configure/document/progress）。
 *    名字写错一个字母 = "点了没反应"或"invoke 报 command not found"，都要到运行时才知道；
 * 2. **窗口与几何的口径**：建窗属性一次到位（无边框/透明/置顶/不进任务栏/不可缩放/隐藏后 show）、
 *    独立 webview 数据目录、代理三窗收口、**隐藏不销毁**、任务栏贴 work_area 下沿（降级实现）；
 * 3. **无注入红线**：任务栏歌词只允许"独立透明窗 + 贴边"，源码扫描必须 0 命中
 *    系统钩子 / explorer 注入一类 API —— 这是本项目的硬红线（简报与计划都写了）。
 *
 * 几何矩阵、配置钳制、命令失败收口这些**判定**在 Rust 内联单测里（`cargo test`，
 * 与 tray.rs/close_behavior.rs 同款做法）；这里扫的是"接线在不在、两侧一不一致"。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BROADCAST_CHANNELS,
  LYRICS_DOCUMENT,
  LYRICS_PROGRESS,
  LYRICS_STATE,
} from "../src/shared/channels.ts";
import {
  CORE_LYRICS_CONFIGURE,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_TOGGLE,
} from "../src/shared/commands.ts";
import { PLAYBACK_LYRICS, REQUEST_CHANNELS } from "../src/shared/request-channels.ts";
import { THEME_CHANGED } from "../src/shared/channels.ts";
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_COLOR_TOKENS,
  LYRICS_FONT_STEPS,
  LYRICS_MODES,
  LYRICS_SESSION_NOTICE,
  LYRICS_STATUS,
  MIN_PROGRESS_INTERVAL_MS,
  TASKBAR_MAX_FONT_PX,
  clickThroughEnabled,
  colorTokenLabel,
  dragRegionEnabled,
  effectiveSizeId,
  estimateTimeMs,
  fontStepLabel,
  importPlanOf,
  lyricsConfigFromSearch,
  lyricsStatusFromFailure,
  modeLabel,
  normalizeLyricsConfig,
  progressOf,
  reanchorProgress,
  shouldPushProgress,
  themeFromSearch,
} from "../src/renderer/features/lyrics/lyrics-window.mjs";
import { createLyricsBridge } from "../src/renderer/features/lyrics/lyrics-bridge.mjs";
import { createPlayer } from "../src/renderer/features/playback/player.mjs";
import { createPlaybackHandlers } from "../src/host/playback-handlers.mjs";
import { createMusicApi } from "../src/protocols/music.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const rustSource = (name) => read(`src-tauri/src/${name}`);
/** 只看生产代码：`#[cfg(test)]` 段里的字面量是测试夹具，不算镜像副本。 */
const rustProduction = (source) => {
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
};
/** 只扫代码，不扫注释（注释里写频道名、写"不许注入"都是说明文字）。 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. 频道
// ---------------------------------------------------------------------------

test("频道：playback:lyrics 进请求白名单（共享常量 ↔ Rust 镜像字面量）", () => {
  assert.equal(PLAYBACK_LYRICS, "playback:lyrics");
  assert.ok(
    REQUEST_CHANNELS.includes(PLAYBACK_LYRICS),
    "新频道必须在唯一真源里：不在的话请求在 Rust 准入处就被拒（unknown_channel）",
  );
  assert.match(
    rustProduction(rustSource("commands.rs")),
    /"playback:lyrics"/,
    "Rust 侧的 REQUEST_CHANNELS 是刻意的镜像副本，必须同步增补",
  );
});

test("频道：三条 lyrics:* 广播进白名单，且与 Rust 镜像逐字相等", () => {
  assert.equal(LYRICS_DOCUMENT, "lyrics:document");
  assert.equal(LYRICS_PROGRESS, "lyrics:progress");
  assert.equal(LYRICS_STATE, "lyrics:state");

  const bridge = rustProduction(rustSource("bridge.rs"));
  for (const [constant, name] of [
    ["LYRICS_DOCUMENT", LYRICS_DOCUMENT],
    ["LYRICS_PROGRESS", LYRICS_PROGRESS],
    ["LYRICS_STATE", LYRICS_STATE],
  ]) {
    assert.ok(
      BROADCAST_CHANNELS.includes(name),
      `${name} 必须在广播白名单里：不在的话这条广播会被当成白名单外帧丢掉`,
    );
    assert.match(
      bridge,
      new RegExp(`${constant}\\s*:\\s*&str\\s*=\\s*"${name}"`),
      `Rust 侧的 ${constant} 必须是与共享常量逐字相同的镜像副本`,
    );
    assert.match(
      bridge,
      new RegExp(`"${name}"`),
      `${name} 也要进 Rust 的 BROADCAST_CHANNELS 数组（channel-parity 会逐条比）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 命令面
// ---------------------------------------------------------------------------

test("命令名：四条命令一份真源，host-api 只用常量、不写字面量", () => {
  assert.equal(CORE_LYRICS_TOGGLE, "core_lyrics_toggle");
  assert.equal(CORE_LYRICS_CONFIGURE, "core_lyrics_configure");
  assert.equal(CORE_LYRICS_DOCUMENT, "core_lyrics_document");
  assert.equal(CORE_LYRICS_PROGRESS, "core_lyrics_progress");

  const hostApi = read("src/renderer/host-api.ts");
  assert.match(hostApi, /from\s+"\.\.\/shared\/commands\.ts"/, "命令名必须从共享真源导入");
  for (const name of [
    "core_lyrics_toggle",
    "core_lyrics_configure",
    "core_lyrics_document",
    "core_lyrics_progress",
  ]) {
    assert.doesNotMatch(hostApi, new RegExp(`["']${name}["']`), `host-api 里不许出现 ${name} 字面量`);
    assert.match(
      hostApi,
      new RegExp(`CORE_LYRICS_|\\b${name}\\b`),
      `host-api 要用上 ${name}（常量或具名封装，二者之一）`,
    );
  }
  // 四条命令都要有具名封装（页面/桥不直接 invoke）
  for (const wrapper of ["coreLyricsToggle", "coreLyricsConfigure", "coreLyricsDocument", "coreLyricsProgress"]) {
    assert.match(hostApi, new RegExp(`export async function ${wrapper}\\(`), `渲染层要有具名封装 ${wrapper}`);
  }
});

test("Rust：四条命令都是 async、都过主窗来源守卫、都进了 generate_handler!", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const lib = read("src-tauri/src/lib.rs");

  for (const name of ["core_lyrics_toggle", "core_lyrics_configure", "core_lyrics_document", "core_lyrics_progress"]) {
    assert.match(
      rust,
      new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}?pub async fn ${name}\\(`),
      `${name} 必须是 async 命令：WebviewWindowBuilder 的 build 要走主线程往返，同步命令会死锁`,
    );
    // 主窗来源守卫（R23：判 webview label —— 歌词窗/托盘/主窗里的登录页一律拒绝）
    const body = rust.slice(rust.indexOf(`pub async fn ${name}(`));
    const guardAt = body.indexOf("require_main_webview(webview.label())");
    assert.ok(
      guardAt !== -1 && guardAt < 900,
      `${name} 必须过 require_main_webview（守卫要在最前面，且判的是 webview label）`,
    );
    assert.match(lib, new RegExp(`lyrics_window::${name}\\b`), `${name} 必须进 generate_handler!`);
  }
});

test("Rust：建窗属性一次到位（无边框/透明/无阴影/置顶/不进任务栏/不可缩放/不聚焦/隐藏后 show）", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const builder = rust.slice(rust.indexOf("WebviewWindowBuilder::new"), rust.indexOf("WebviewWindowBuilder::new") + 1600);

  for (const [call, why] of [
    [".decorations(false)", "无边框"],
    [".transparent(true)", "透明"],
    [".shadow(false)", "无阴影"],
    [".always_on_top(true)", "置顶"],
    [".skip_taskbar(true)", "不进任务栏"],
    [".resizable(false)", "不可缩放"],
    [".focused(false)", "不抢焦点"],
    [".visible(false)", "先建出来是隐藏的（防闪默认样式，按配置再 show）"],
  ]) {
    assert.ok(builder.includes(call), `歌词窗必须 ${call}（${why}）`);
  }
  assert.match(builder, /WebviewUrl::App\(/, "歌词窗加载的是应用内的 lyrics.html");
  assert.match(rust, /lyrics\.html\?/, "入口就是 lyrics-main.tsx 那一份（R1 已建双入口），配置经查询串带过去");
  assert.match(builder, /data_directory\(/, "独立 webview 数据目录（与主窗分开）");
  assert.match(rust, /webview2["']?\)[\s\S]{0,60}?join\(["']lyrics["']\)|join\("webview2"\)\s*\.join\("lyrics"\)/, "数据目录口径是 <数据根>/webview2/lyrics");

  // 建后隐藏再 show：`visible(false)` 建、`show()` 显
  assert.match(rust, /\.show\(\)/, "建完之后按配置 show 出来");
  assert.match(rust, /set_ignore_cursor_events\(/, "点透是窗口属性（不是在渲染层假装）");
});

test("Rust：代理三窗收口——歌词窗也接 proxy_url（不接就是绕过设置直连）", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  assert.match(rust, /proxy_url/, "歌词窗建窗要接 proxy_url（R6 的审计缺口：不接则封面/音频直连）");
  assert.match(
    rust,
    /crate::webview_proxy::resolve_for_webview\([^)]*LYRICS_WINDOW_LABEL[^)]*\)|resolve_for_webview\([^)]*"lyrics"[^)]*\)/,
    "取值链必须走 webview_proxy::resolve_for_webview（与主窗/登录窗同一处）",
  );
  assert.match(rust, /crate::proxy_url_argument\(/, "解析失败一律降级成「没配」，绝不把建窗带崩");
});

test("Rust：隐藏不销毁（没有 destroy/close，也没有第二份窗口表）", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  assert.match(rust, /\.hide\(\)/, "关闭桌面歌词 = 隐藏（保住 webview 与进度）");
  for (const forbidden of [".destroy(", ".close(", "unstable"]) {
    assert.ok(!rust.includes(forbidden), `歌词窗模块不许出现 ${forbidden}（隐藏不销毁）`);
  }
  assert.ok(
    !rust.includes("Mutex<Option<WebviewWindow>>") && !rust.includes("Vec<WebviewWindow>"),
    "窗口归属 tauri 的窗口表（get_webview_window 现问），不许自己再记一份镜像",
  );
});

// ---------------------------------------------------------------------------
// 3. 几何（判定矩阵在 Rust 内联单测；这里钉"函数在不在、口径对不对"）
// ---------------------------------------------------------------------------

test("几何：taskbar_position / desktop_position 是纯函数，常量与钳制口径都在", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  for (const name of ["pub fn taskbar_position", "pub fn desktop_position"]) {
    assert.ok(rust.includes(name), `几何必须是可单测的纯函数：${name}`);
  }
  assert.match(rust, /pub const TASKBAR_SIZE/, "任务栏模式的窗口尺寸是契约（如 1200×44）");
  assert.match(rust, /pub const DESKTOP_LIFT|DESKTOP_LIFT_PX|const DESKTOP_LIFT/, "桌面模式在任务栏位置之上再抬一段");
  assert.match(rust, /\.max\(0\.0\)/, "负偏移钳 0（窗口比工作区还宽时不许把内容推出屏幕）");
  assert.match(rust, /\.max\(area\.y\)|\.max\(area\.top\(\)\)/, "桌面模式要夹回工作区顶部");
  // 多显示器口径：优先主窗所在显示器，退主屏
  assert.match(rust, /current_monitor\(\)/, "优先主窗 current_monitor()");
  assert.match(rust, /primary_monitor\(\)/, "取不到就退主屏（绝不猜一个坐标）");
});

// ---------------------------------------------------------------------------
// 4. 配置：TS ↔ Rust 两侧同一张表
// ---------------------------------------------------------------------------

test("配置：字号档位 / 颜色令牌 / 上限在 TS 与 Rust 两侧逐条相等", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));

  for (const step of LYRICS_FONT_STEPS) {
    assert.match(
      rust,
      new RegExp(`\\("${step.id}",\\s*${step.px}\\)`),
      `Rust 的字号档位表必须含 (${step.id}, ${step.px})（两侧一张表）`,
    );
  }
  for (const token of LYRICS_COLOR_TOKENS) {
    assert.match(rust, new RegExp(`"${token.id}"`), `Rust 的颜色令牌表必须含 ${token.id}`);
  }
  assert.match(
    rust,
    new RegExp(`TASKBAR_MAX_FONT_PX\\s*:\\s*u32\\s*=\\s*${TASKBAR_MAX_FONT_PX}\\b`),
    "任务栏模式的字号上限两侧同值（简报：字号 ≤ 20）",
  );
  assert.equal(TASKBAR_MAX_FONT_PX, 20);
  assert.match(rust, /"desktop"/, "模式词表两侧同源");
  assert.match(rust, /"taskbar"/);
  assert.deepEqual([...LYRICS_MODES], ["desktop", "taskbar"]);
});

test("配置：CSS 里每个档位都有字号规则，且 rem 值与 px 对得上", () => {
  const css = read("src/renderer/amll-theme.css");
  for (const step of LYRICS_FONT_STEPS) {
    const match = css.match(new RegExp(`\\[data-lyrics-size="${step.id}"\\][^{]*\\{[^}]*--amll-lp-font-size:\\s*([0-9.]+)rem`));
    assert.ok(match, `amll-theme.css 必须给档位 ${step.id} 一条 --amll-lp-font-size 规则（否则设置项点了没反应）`);
    assert.equal(Number(match[1]) * 16, step.px, `档位 ${step.id} 的 rem 与 px 对不上（16px = 1rem）`);
  }
  for (const token of LYRICS_COLOR_TOKENS) {
    assert.match(
      css,
      new RegExp(`\\[data-lyrics-color="${token.id}"\\][^{]*\\{[^}]*--amll-lp-color:\\s*var\\(--[a-z-]+\\)`),
      `颜色令牌 ${token.id} 必须映射到设计令牌（AMLL 变量只许出现在这里）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. 无注入红线（简报：任务栏歌词是降级实现，绝不注入/Hook）
// ---------------------------------------------------------------------------

test("无注入：全源码扫描——系统钩子 / explorer 注入类 API 零命中", () => {
  const banned = [
    "SetWindowsHookEx",
    "UnhookWindowsHookEx",
    "SetWinEventHook",
    "WH_KEYBOARD",
    "WH_MOUSE",
    "Shell_TrayWnd",
    "Shell_NotifyIcon",
    "FindWindowW",
    "FindWindowExW",
    "SetParent",
    "SendInput",
    "keybd_event",
    "mouse_event",
    "explorer.exe",
    "inject_",
  ];
  const scanned = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["node_modules", "target", "out", "gen"].includes(entry.name)) continue;
        walk(child);
        continue;
      }
      if (!/\.(rs|ts|tsx|mjs|js)$/.test(entry.name)) continue;
      scanned.push(child);
    }
  };
  walk("src");
  walk("src-tauri/src");
  assert.ok(scanned.length >= 40, `扫描范围异常，只拿到 ${scanned.length} 个文件`);

  const offenders = [];
  for (const relative of scanned) {
    const source = read(relative);
    for (const token of banned) {
      if (source.includes(token)) offenders.push(`${relative}: ${token}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `任务栏歌词只允许「独立透明窗 + 贴 work_area 下沿」这一种降级实现（三端无公开文字 API）：\n${offenders.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// 6. 纯逻辑：配置 / 节流 / 状态
// ---------------------------------------------------------------------------

test("配置纯逻辑：认不出的值一律不猜（落回上一个合法值）", () => {
  const base = { ...DEFAULT_LYRICS_CONFIG, mode: "desktop", size: "xl", color: "primary", locked: true, clickThrough: true };

  assert.deepEqual(normalizeLyricsConfig({}, base), base, "空 patch = 原样（设置页挂载时读回当前配置）");
  assert.deepEqual(normalizeLyricsConfig(null, base), base, "坏 patch 同样不猜");
  assert.deepEqual(normalizeLyricsConfig("nope", base), base);

  const patch = normalizeLyricsConfig({ mode: "taskbar", size: "md", color: "muted", locked: false, clickThrough: false }, base);
  assert.deepEqual(patch, { mode: "taskbar", size: "md", color: "muted", locked: false, clickThrough: false });

  const bogus = normalizeLyricsConfig({ mode: "floating", size: "999", color: "#fff", locked: "yes", clickThrough: 1 }, base);
  assert.deepEqual(bogus, base, "认不出的模式/档位/颜色/布尔都不许猜（尤其不许把字符串当真）");

  // 首帧（没有任何上一个合法值）落默认
  assert.deepEqual(normalizeLyricsConfig({ mode: "floating" }, null), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(normalizeLyricsConfig(undefined, undefined), DEFAULT_LYRICS_CONFIG);
});

test("配置纯逻辑：任务栏模式的有效字号 ≤ 20px（配置值本身保留，切回来能还原）", () => {
  const big = { ...DEFAULT_LYRICS_CONFIG, size: "xxl" };
  assert.equal(effectiveSizeId(big), "xxl", "桌面模式按用户选的档位");
  assert.equal(effectiveSizeId({ ...big, mode: "taskbar" }), "md", "任务栏模式压到 ≤20px 的最大档位");
  assert.equal(effectiveSizeId({ ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", size: "sm" }), "sm", "本来就小就不动它");

  // 保留配置值：切回桌面模式还是用户选的那个
  const taskbar = normalizeLyricsConfig({ mode: "taskbar" }, big);
  assert.equal(taskbar.size, "xxl");
  assert.equal(effectiveSizeId(taskbar), "md");

  for (const step of LYRICS_FONT_STEPS) {
    const effective = effectiveSizeId({ ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", size: step.id });
    const px = LYRICS_FONT_STEPS.find((entry) => entry.id === effective).px;
    assert.ok(px <= TASKBAR_MAX_FONT_PX, `任务栏模式下 ${step.id} 的有效字号必须 ≤ ${TASKBAR_MAX_FONT_PX}px，实际 ${px}`);
  }
});

test("配置纯逻辑：拖动区与点透（锁定时不挂拖动区；任务栏模式一律点透）", () => {
  const base = DEFAULT_LYRICS_CONFIG;
  assert.equal(dragRegionEnabled(base), true, "桌面模式默认可拖");
  assert.equal(dragRegionEnabled({ ...base, locked: true }), false, "锁定就不挂 data-tauri-drag-region");
  assert.equal(dragRegionEnabled({ ...base, mode: "taskbar" }), false, "任务栏模式贴在边上，不给拖");

  assert.equal(clickThroughEnabled(base), false, "桌面模式默认可点（要能接手拖动）");
  assert.equal(clickThroughEnabled({ ...base, clickThrough: true }), true, "用户显式开点透就点透");
  assert.equal(
    clickThroughEnabled({ ...base, mode: "taskbar" }),
    true,
    "任务栏模式是贴在屏幕下沿的一条显示带：默认点透，别挡住底下窗口的点击",
  );
});

test("配置纯逻辑：查询串解析（歌词窗的初值；认不出的值落默认）", () => {
  assert.deepEqual(lyricsConfigFromSearch(""), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(lyricsConfigFromSearch(null), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(
    lyricsConfigFromSearch("?mode=taskbar&size=md&color=primary&locked=1&clickThrough=1"),
    { mode: "taskbar", size: "md", color: "primary", locked: true, clickThrough: true },
  );
  assert.deepEqual(
    lyricsConfigFromSearch("?mode=taskbar&locked=0&clickThrough=0"),
    { ...DEFAULT_LYRICS_CONFIG, mode: "taskbar" },
    "0/1 才是布尔；别的写法不算（不许把任意字符串当真）",
  );
  assert.deepEqual(
    lyricsConfigFromSearch("?mode=floating&size=99&color=%23fff&locked=yes"),
    { ...DEFAULT_LYRICS_CONFIG, locked: false },
    "认不出的值落默认，改造过的查询串不该把窗搞坏",
  );

  // Rust 侧拼的就是这几个键（两侧同一份契约）
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  for (const key of ["mode", "size", "color", "locked", "clickThrough"]) {
    assert.match(rust, new RegExp(`${key}=`), `Rust 拼的歌词窗 URL 必须带 ${key} 参数`);
  }
  assert.match(rust, /lyrics\.html\?/, "初值经 URL 查询串交给渲染层：渲染层还没订阅事件时也不会丢配置");
});

test("进度节流：≥100ms 或 播放/跳转变化 才推（纯逻辑，唯一真源）", () => {
  assert.equal(MIN_PROGRESS_INTERVAL_MS, 100);

  const first = { timeMs: 1000, playing: true, seekGeneration: 0 };
  assert.equal(shouldPushProgress(null, first), true, "第一次必须推（否则歌词窗停在 0）");
  assert.equal(shouldPushProgress(first, { timeMs: 1050, playing: true, seekGeneration: 0 }), false, "50ms 内不推");
  assert.equal(shouldPushProgress(first, { timeMs: 1100, playing: true, seekGeneration: 0 }), true, "满 100ms 就推");
  assert.equal(shouldPushProgress(first, { timeMs: 1000, playing: false, seekGeneration: 0 }), true, "播放态变了立刻推");
  assert.equal(shouldPushProgress(first, { timeMs: 1000, playing: true, seekGeneration: 1 }), true, "跳转要立刻推");
  assert.equal(shouldPushProgress(first, { timeMs: 1000, playing: true, seekGeneration: 0 }), false, "什么都没变不推");
  assert.equal(shouldPushProgress(first, { timeMs: Number.NaN, playing: true, seekGeneration: 0 }), true, "算不出差值就推一次（宁可多推）");
});

test("歌词状态：端点是「没配」而不是「取不到」——两条路说两句不同的话", () => {
  assert.equal(lyricsStatusFromFailure({ kind: "endpoint_unknown", message: "x" }), LYRICS_STATUS.unavailable);
  assert.equal(lyricsStatusFromFailure({ kind: "network_error", message: "x" }), LYRICS_STATUS.failed);
  assert.equal(lyricsStatusFromFailure(null), LYRICS_STATUS.failed, "认不出的失败按「暂时取不到」说");
  assert.equal(lyricsStatusFromFailure("boom"), LYRICS_STATUS.failed);
  assert.deepEqual(
    Object.keys(LYRICS_STATUS).sort(),
    ["empty", "failed", "loading", "ready", "unavailable"],
    "状态词表是契约（播放器状态机与文案表都按它认）",
  );

  const playing = { status: "playing", currentTimeMs: 4321, seekGeneration: 7 };
  assert.deepEqual(progressOf(playing), { timeMs: 4321, playing: true, seekGeneration: 7 }, "进度载荷由纯函数造");
  assert.deepEqual(progressOf({ status: "paused", currentTimeMs: 0, seekGeneration: 0 }), {
    timeMs: 0,
    playing: false,
    seekGeneration: 0,
  });
  assert.deepEqual(progressOf(null), { timeMs: 0, playing: false, seekGeneration: 0 }, "没有状态就给个安全的零值");
});

test("进度插值：广播之间按真实时间平滑（暂停时停住不动）", () => {
  assert.equal(estimateTimeMs(null, 1000), 0, "还没收到任何进度就是 0");
  assert.equal(estimateTimeMs({ timeMs: 5000, playing: true, atMs: 1000 }, 1000), 5000, "刚收到：原值");
  assert.equal(estimateTimeMs({ timeMs: 5000, playing: true, atMs: 1000 }, 1050), 5050, "过了 50ms 就往前推 50ms");
  assert.equal(estimateTimeMs({ timeMs: 5000, playing: false, atMs: 1000 }, 9000), 5000, "暂停时不许继续走");
  assert.equal(estimateTimeMs({ timeMs: 5000, playing: true, atMs: 1000 }, 900), 5000, "时钟回拨/坏值就落在原值上");
  assert.equal(estimateTimeMs({ timeMs: Number.NaN, playing: true, atMs: 1000 }, 1000), 0, "坏进度落 0");
});

test("进度重锚：窗从隐藏变可见时把锚点挪到当下（不许一次性窜到后面）", () => {
  const push = { timeMs: 5000, playing: true, seekGeneration: 3, atMs: 1000 };
  const anchored = reanchorProgress(push, 90000);
  assert.equal(anchored.timeMs, 5000, "时间值不动（真正的进度只有主窗那条推送一个来源）");
  assert.equal(anchored.atMs, 90000, "锚点换成当下");
  assert.equal(estimateTimeMs(anchored, 90000), 5000, "重锚之后停在原处（等 100ms 内的新推送）");
  assert.equal(reanchorProgress(null, 1), null, "还没收到进度就是 null");
  assert.equal(reanchorProgress(push, Number.NaN).atMs, 1000, "坏时钟保持原锚点");
});

test("文案：会话内说明如实（不持久化这件事必须写在设置项旁边）", () => {
  assert.match(LYRICS_SESSION_NOTICE, /本次运行|这一次|重启/, `要说清"只在本次运行内生效"：${LYRICS_SESSION_NOTICE}`);
  assert.match(
    LYRICS_SESSION_NOTICE,
    /不会保存|不会写入|不写进|不落盘|不记忆/,
    `也要说清"不写进设置文件"：${LYRICS_SESSION_NOTICE}`,
  );
  assert.ok(!/敬请期待|即将上线/.test(LYRICS_SESSION_NOTICE), "禁画饼");
  for (const step of LYRICS_FONT_STEPS) assert.ok(fontStepLabel(step.id).trim() !== "");
  for (const token of LYRICS_COLOR_TOKENS) assert.ok(colorTokenLabel(token.id).trim() !== "");
  for (const mode of LYRICS_MODES) assert.ok(modeLabel(mode).trim() !== "");
  assert.equal(fontStepLabel("nope"), fontStepLabel(DEFAULT_LYRICS_CONFIG.size), "认不出的档位按默认说");
});

// ---------------------------------------------------------------------------
// 7. 歌词窗渲染层
// ---------------------------------------------------------------------------

test("歌词窗：逐行渲染来自 AMLL 官方组件；只订阅事件、不调任何业务命令", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  const code = stripComments(source);

  assert.match(
    code,
    /import\s*\{[^}]*LyricPlayer[^}]*\}\s*from\s*"@applemusic-like-lyrics\/react"/,
    "逐行滚动只能来自官方 LyricPlayer（禁自绘）",
  );
  assert.match(code, /<LyricPlayer/, "必须真的把官方组件挂上去");
  assert.doesNotMatch(code, /(?:export\s+)?(?:function|const|class)\s+(?:LyricPlayer|BackgroundRender)\b/, "禁自绘：不许自己实现 AMLL 组件");
  assert.doesNotMatch(code, /<canvas[\s>]|getContext\(/, "不得自绘画布");
  assert.doesNotMatch(code, /\.words\b|words\.map/, "不得自己渲染歌词文本");
  assert.doesNotMatch(code, /\\d\{2\}:\\d\{2\}/, "不得出现手写时间戳正则");

  // 只订阅：不调 core_call、不 invoke 命令（歌词窗没有业务频道权限）
  assert.doesNotMatch(code, /coreCall\(|invoke\(|CORE_LYRICS_|CORE_CALL/, "歌词窗只订阅事件（数据由主窗转发）");
  assert.match(source, /from\s+"\.\/host-api"/, "订阅走 host-api 的封装");
  assert.match(code, /onCoreEvent/, "数据经 core:event 漏斗事件进来");
  for (const channel of [LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE]) {
    assert.match(source, new RegExp(channel), `歌词窗要订阅 ${channel}`);
  }
  assert.doesNotMatch(code, /fetch\s*\(|XMLHttpRequest|WebSocket/, "歌词窗不发请求");

  // 视觉约束：不写 AMLL 变量、不拿色值拼样式
  assert.doesNotMatch(code, /--amll-/, "AMLL 变量只许出现在 amll-theme.css");
  assert.doesNotMatch(code, /style=\{\{/, "不许内联视觉样式（AMLL 100% 尺寸例外只有那两处宿主）");
});

test("歌词窗：data 属性全部来自纯逻辑模块（字号/颜色/模式/拖动/点透）", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  assert.match(source, /lyrics-window\.mjs/, "配置与判定必须来自纯逻辑模块（可单测）");
  for (const helper of ["normalizeLyricsConfig", "effectiveSizeId", "dragRegionEnabled", "lyricsConfigFromSearch"]) {
    assert.match(source, new RegExp(helper), `歌词窗要用 ${helper}（不在这里另写一份判定）`);
  }
  assert.match(source, /data-lyrics-size=/, "字号档位经 data 属性交给 CSS（内联样式禁令的必然结果）");
  assert.match(source, /data-lyrics-color=/, "颜色令牌同理");
  assert.match(source, /data-lyrics-mode=/, "模式（桌面/任务栏）同理");
  assert.match(source, /data-tauri-drag-region/, "拖动靠 tauri 的拖动区属性（capabilities 已给 allow-start-dragging）");
  assert.match(source, /lyricsNoticeText/, "占位文案来自 playback-state.mjs（不在这里另写一份）");
});

test("歌词窗入口：lyrics-main.tsx 挂载 LyricsWindow（双入口那一份不再是空壳）", () => {
  const entry = read("src/renderer/lyrics-main.tsx");
  assert.match(entry, /LyricsWindow/, "歌词窗入口必须挂载 LyricsWindow");
  assert.match(entry, /import\s*\{[^}]*LyricsWindow[^}]*\}\s*from\s*"\.\/LyricsWindow\.tsx"/, "从 LyricsWindow.tsx 导入");
  // CSS 引入顺序契约（两个入口逐字一致）
  for (const line of [
    '@applemusic-like-lyrics/core/style.css',
    "./amll-theme.css",
    "./styles.css",
  ]) {
    assert.ok(entry.includes(line), `入口必须保持 CSS 引入顺序契约：${line}`);
  }
});

test("歌词窗主题（R41）：初值走查询串、变化走广播，且**不新增命令**", () => {
  const entry = read("src/renderer/lyrics-main.tsx");
  // 初值：建窗时 Rust 拼进 URL（歌词窗调不动读主题的那条命令，只能这么同步给它）
  assert.match(entry, /themeFromSearch\(window\.location\.search\)/, "主题初值从查询串读");
  assert.match(entry, /applyThemeChoice\(document\.documentElement/, "切类只经 theme.mjs 的那一个入口");
  // 变化：订阅 `theme:changed` 广播（订阅不需要权限）
  assert.match(entry, new RegExp(THEME_CHANGED), "跟随 theme:changed 广播");
  assert.match(entry, /onCoreEvent</, "订阅走 host-api 的封装");
  // 不许为了主题把命令权限放宽（那条命令还能取消登录）
  // 注：只扫**调用形状**——注释里出现 `installThemeSync()` 是在解释"为什么不那么做"，不算调用。
  assert.doesNotMatch(entry, /coreLoginChrome\s*[(<]|coreCall\(/, "歌词窗不许调命令（主题也不例外）");

  // 纯函数那一半：认不出/缺参数一律回 null（调用方按"系统档"处理，不猜）
  assert.equal(themeFromSearch("?theme=dark"), "dark");
  assert.equal(themeFromSearch("?mode=desktop&theme=light"), "light");
  assert.equal(themeFromSearch("?theme="), null, "空值不算");
  assert.equal(themeFromSearch(""), null);
  assert.equal(themeFromSearch("?theme=DARK"), null, "大小写不同不算（与 theme.mjs 的严格口径一致）");
  assert.equal(themeFromSearch(null), null, "坏入参不抛");
});

test("桌窗文档重发（R41a）：改由 Rust 在页面加载完成时重发，渲染层不再重推", () => {
  const hook = read("src/renderer/use-lyrics-window.ts");
  // R41 曾在渲染层补推一次（visible false→true）；那一次**必然太早**（reload 是异步的，
  // 主窗拿到回执时新页还在加载），所以删掉——真正的时机只有"页面加载完成"。
  assert.doesNotMatch(
    hook,
    /const opened = visible && !wasVisible\.current/,
    "渲染层不再在窗口打开时重推（那一推落在新页订阅之前）",
  );
  assert.doesNotMatch(hook, /wasVisible/, "基准 ref 也一并删掉（留着会让人以为还有第二次机会）");
  // 重发的三个要件在 Rust 侧（同样的规矩由同时刻可见的那一侧执行）
  const rust = read("src-tauri/src/lyrics_window.rs");
  assert.match(rust, /window\.reload\(\)/, "显示已有窗口前仍要重新加载页面（不然重发没有意义）");
  assert.match(rust, /\.on_page_load\(/, "重发挂在页面加载回调上（唯一知道新页就绪的时刻）");
  assert.match(rust, /PageLoadEvent::Finished/, "只认加载完成：Started 时页面里的 JS 还没跑");
  assert.match(rust, /webview\.label\(\) != LYRICS_WINDOW_LABEL/, "按 label 过滤（这条广播只发给歌词窗）");
  assert.match(rust, /fn replay_document/, "重发是一个单独的函数（页面加载回调与命令各用各的一半）");
  // 缓存发生在发出去那一刻：core_lyrics_document 里"留一份"要在"发出去"之前
  const command = rust.slice(rust.indexOf("pub async fn core_lyrics_document("));
  const kept = command.indexOf("remember_document(");
  const emitted = command.indexOf("emit_core_event(");
  assert.ok(kept > 0 && emitted > kept, "先留一份再发出去（缓存住的必须是用户本来能看到的那一份）");
  assert.match(command.slice(0, kept), /return Err\(/, "归一失败如实报错，不缓存半个文档");
  // 日志里不许出现文档内容（歌词文本进日志 = 把用户的歌单抄进日志文件）
  const replay = rust.slice(rust.indexOf("pub fn replay_document"));
  const logStart = replay.indexOf('log::info!("');
  const logEnd = replay.indexOf('")', logStart);
  assert.ok(logStart > 0 && logEnd > logStart, "重发要留一行日志（不然真机上无从取证）");
  assert.doesNotMatch(replay.slice(logStart, logEnd), /document|\{/, "重发的日志不带文档本身（也不带格式化占位符）");
});

test("导入落地（R41a）：成功才动歌词；失败什么工具都不碰（失败的事实是歌词没变）", () => {
  // 成功：行 + 状态 + 一句带文件名与行数的回执（文案与 R41 逐字一致）
  const done = importPlanOf({ status: "ready", lines: [{ startTime: 0 }], source: "local", message: null, fileName: "我的.lrc", lineCount: 2 });
  assert.equal(done.ok, true);
  assert.deepEqual(done.lines, [{ startTime: 0 }]);
  assert.equal(done.status, "ready");
  assert.equal(done.message, "已替换这首歌的歌词（2 行，来自「我的.lrc」）。");

  // 失败：**不带 lines/status**（调用方因此不可能"顺手"推一份空文档出去）
  const failed = importPlanOf({ status: "failed", lines: [], source: null, message: "这个文件里没有带时间戳的歌词行。" });
  assert.equal(failed.ok, false);
  assert.equal(failed.message, "这个文件里没有带时间戳的歌词行。");
  assert.equal("lines" in failed, false, "失败的计划里没有行（界面停在原来那一份上）");
  assert.equal("status" in failed, false, "失败的计划里也没有状态（不把面板打成『没有歌词』）");

  // 认不出的回执（没有 message，也没有行）：按失败处理（宁可不换，也不假装换成功了）
  for (const bad of [null, undefined, "nope", {}, { lines: [] }, { message: "   " }]) {
    const plan = importPlanOf(bad);
    assert.equal(plan.ok, false, `认不出的回执按失败：${JSON.stringify(bad)}`);
    assert.ok(plan.message.length > 0, "失败也要有一句人话");
    assert.equal("lines" in plan, false, "失败的计划不带行（调用方不可能顺手清空面板）");
  }

  // 缺文件名/行数时如实兜底（不编一个像样的名字）
  const thin = importPlanOf({ status: "ready", lines: [{}, {}], message: null });
  assert.equal(thin.message, "已替换这首歌的歌词（2 行，来自「文件」）。", "行数按行数组算，文件名兜底成「文件」");
});

test("主窗面板共用：同一份行经 setLyrics 进播放状态（五档词表，认不出的按行数推断）", () => {
  // 造一个最小音频端口（状态机只把它当端口用；这里不需要它真的出声）
  const audio = {
    setSource: () => {},
    play: async () => {},
    pause: () => {},
    setCurrentTime: () => {},
    setVolume: () => {},
    setMuted: () => {},
    on: () => () => {},
  };
  const player = createPlayer({
    audio,
    resolveUrl: async () => ({ ok: true, data: { url: "https://music.dbankcdn.cn/x.mp3" } }),
    guardUrl: (url) => url,
  });

  assert.equal(player.snapshot().lyrics.status, "unavailable", "挂载初期：还没有歌词来源可用");

  player.setLyrics([], LYRICS_STATUS.loading);
  assert.deepEqual(player.snapshot().lyrics, { status: "loading", lines: [] }, "先落「正在取」（并清掉上一首的行）");

  player.setLyrics([{ startTime: 0, endTime: 1, words: [] }]);
  assert.equal(player.snapshot().lyrics.status, "ready", "有行 = ready");

  player.setLyrics([]);
  assert.equal(player.snapshot().lyrics.status, "empty", "取了但没行 = 这首没有歌词");

  player.setLyrics([], LYRICS_STATUS.failed);
  assert.equal(player.snapshot().lyrics.status, "failed");

  player.setLyrics([], "随便什么字符串");
  assert.equal(player.snapshot().lyrics.status, "empty", "认不出的状态不许写进状态（按行数推断）");
  player.dispose();
});

// ---------------------------------------------------------------------------
// 8. 主窗侧：转发（注入桩）与接线
// ---------------------------------------------------------------------------

/** 记录型桩：把每条命令/请求/订阅都记下来，供断言"转发对不对"。 */
function stubBridge(overrides = {}) {
  const calls = [];
  const listeners = new Map();
  const bridge = createLyricsBridge({
    callCore: async (channel, payload) => {
      calls.push({ channel, payload });
      if (overrides.callCore) return overrides.callCore(channel, payload);
      return { text: "[00:01.00]第一行\n[00:05.00]第二行" };
    },
    callCommand: async (command, args) => {
      calls.push({ command, args });
      if (overrides.callCommand) return overrides.callCommand(command, args);
      return { config: DEFAULT_LYRICS_CONFIG, visible: true };
    },
    subscribeCoreEvent: async (channel, handler) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
    parseLyrics: overrides.parseLyrics,
  });
  return { bridge, calls, listeners };
}

test("主窗转发：四条命令各走各的命令名，回执经纯函数归一", async () => {
  const { bridge, calls } = stubBridge();

  const status = await bridge.readStatus();
  assert.deepEqual(calls[0], { command: CORE_LYRICS_CONFIGURE, args: { config: {} } }, "读配置 = 空 patch 的 configure");
  assert.equal(status.visible, true);
  assert.deepEqual(status.config, DEFAULT_LYRICS_CONFIG);

  await bridge.setVisible(true);
  assert.deepEqual(calls[1], { command: CORE_LYRICS_TOGGLE, args: { checked: true } }, "开关走 core_lyrics_toggle");

  await bridge.applyConfig({ mode: "taskbar" });
  assert.equal(calls[2].command, CORE_LYRICS_CONFIGURE);
  assert.deepEqual(calls[2].args, { config: { mode: "taskbar" } }, "配置补丁原样交给宿主（钳制在 Rust 侧做）");

  await bridge.pushDocument({ lines: [], status: LYRICS_STATUS.empty });
  assert.deepEqual(calls[3], { command: CORE_LYRICS_DOCUMENT, args: { document: { lines: [], status: "empty" } } });

  await bridge.pushProgress({ timeMs: 1500, playing: true, seekGeneration: 0 });
  assert.deepEqual(calls[4], { command: CORE_LYRICS_PROGRESS, args: { progress: { timeMs: 1500, playing: true, seekGeneration: 0 } } });

  // 回执坏形状不许把设置页搞崩：落默认 + visible=false（保守）
  const broken = createLyricsBridge({
    callCore: async () => ({}),
    callCommand: async () => null,
    subscribeCoreEvent: async () => () => {},
  });
  assert.deepEqual((await broken.readStatus()).config, DEFAULT_LYRICS_CONFIG);
  assert.equal((await broken.readStatus()).visible, false);
});

test("主窗转发：进度节流在桥里（rAF 每帧调它，只有该推的才出 IPC）", async () => {
  const { bridge, calls } = stubBridge();
  await bridge.pushProgress({ timeMs: 0, playing: true, seekGeneration: 0 });
  await bridge.pushProgress({ timeMs: 20, playing: true, seekGeneration: 0 });
  await bridge.pushProgress({ timeMs: 40, playing: true, seekGeneration: 0 });
  await bridge.pushProgress({ timeMs: 200, playing: true, seekGeneration: 0 });
  const pushes = calls.filter((call) => call.command === CORE_LYRICS_PROGRESS);
  assert.equal(pushes.length, 2, `只有第 1 帧与满 100ms 的那一帧该出 IPC：${JSON.stringify(pushes)}`);
  assert.deepEqual(pushes[1].args.progress, { timeMs: 200, playing: true, seekGeneration: 0 });
});

test("主窗转发：歌词文本链路——playback:lyrics 取文本、官方 parseLrc 解析、再喂歌词窗", async () => {
  const { bridge, calls } = stubBridge();
  const result = await bridge.loadLyrics("1001");

  assert.deepEqual(calls[0], { channel: PLAYBACK_LYRICS, payload: { trackId: "1001" } }, "取歌词走新频道");
  assert.equal(result.status, LYRICS_STATUS.ready);
  assert.equal(result.lines.length, 2, "文本经 features/lyrics 的适配层解析成 AMLL 行");

  const empty = stubBridge({ callCore: async () => ({ text: "" }) });
  assert.equal((await empty.bridge.loadLyrics("1001")).status, LYRICS_STATUS.empty, "取了但没有词 = 这首歌没有歌词");

  const unconfigured = stubBridge({
    callCore: async () => {
      throw { kind: "endpoint_unknown", message: "接口端点 lyrics 尚未确定" };
    },
  });
  const failed = await unconfigured.bridge.loadLyrics("1001");
  assert.equal(failed.status, LYRICS_STATUS.unavailable, "端点没配就说没配（不冒充「这首歌没有歌词」）");
  assert.deepEqual(failed.lines, []);

  const broken = stubBridge({
    callCore: async () => {
      throw { kind: "network_error", message: "网络不通" };
    },
  });
  assert.equal((await broken.bridge.loadLyrics("1001")).status, LYRICS_STATUS.failed);

  // 空 trackId 不发请求（省一趟必然失败的调用）
  const skipped = stubBridge();
  await skipped.bridge.loadLyrics(null);
  await skipped.bridge.loadLyrics("   ");
  assert.deepEqual(skipped.calls, []);
});

test("主窗转发：托盘 lyrics:toggle 的订阅把目标态翻成 core_lyrics_toggle", async () => {
  const { bridge, calls, listeners } = stubBridge();
  const off = await bridge.subscribeToggle(() => {});
  const handler = listeners.get("lyrics:toggle");
  assert.ok(handler, "必须订阅 lyrics:toggle（没人订阅 = 托盘那个勾选项点了没反应）");
  assert.equal(typeof off, "function", "订阅要能退订（组件卸载时）");

  // 目标态语义：勾上 = 要开，取消 = 要关（不做"切换一下"）
  const seen = [];
  const off2 = await bridge.subscribeToggle((checked) => seen.push(checked));
  assert.equal(typeof off2, "function");
  await bridge.setVisible(true);
  await bridge.setVisible(false);
  assert.deepEqual(
    calls.filter((call) => call.command === CORE_LYRICS_TOGGLE).map((call) => call.args.checked),
    [true, false],
  );
});

test("主窗接线：App 用 use-lyrics-window 的 hook，且设置页有桌面歌词一节", () => {
  const app = read("src/renderer/App.tsx");
  assert.match(app, /useLyricsWindow\(/, "外壳必须挂上歌词窗的接线（订阅 + 歌词数据链）");
  assert.match(app, /lyrics=\{[^}]*\}/, "把歌词窗绑定交给设置页（设置项要能改字号/颜色/模式）");

  const hook = read("src/renderer/use-lyrics-window.ts");
  assert.match(hook, /useEffect\(/, "订阅与数据链都在 effect 里（挂载一次）");
  assert.match(hook, /setLyrics\(/, "解析出来的行要喂给播放器状态（主窗面板与歌词窗共用同一份）");
  assert.match(hook, /pushDocument\(/, "同一份行也转发给歌词窗");
  assert.match(hook, /requestAnimationFrame/, "进度用 rAF 推（不另起定时器）");
  assert.match(hook, /lyrics-window\.mjs/, "判定来自纯逻辑模块");

  const page = read("src/renderer/pages.tsx");
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  assert.match(settings, /桌面歌词/, "设置页要有桌面歌词一节（否则字号颜色没法调）");
  assert.match(settings, /LYRICS_SESSION_NOTICE/, "会话内说明文案来自纯逻辑模块（不在这里另写一份）");
  for (const helper of ["LYRICS_MODES", "LYRICS_FONT_STEPS", "LYRICS_COLOR_TOKENS"]) {
    assert.match(settings, new RegExp(helper), `选项来自纯逻辑模块 ${helper}（不另抄一份清单）`);
  }
  assert.match(page, /from\s+"\.\/components\/ui\/switch"/, "开关走 shadcn 原语");
});

// ---------------------------------------------------------------------------
// 9. 协议与 host 侧
// ---------------------------------------------------------------------------

test("playback:lyrics 处理器：{trackId} → 协议层 getLyrics（文本只作当次应答）", async () => {
  const handlers = createPlaybackHandlers({ api: { getPlayback: async () => ({ ok: true, data: {} }), getLyrics: async () => ({ ok: true, data: { text: "x" } }) } });
  assert.ok(handlers[PLAYBACK_LYRICS], "处理器表里必须有这条频道");

  const calls = [];
  const api = createMusicApi({
    // R32：注入过独立歌词端点就直接打它（默认那条路是"从播放响应推导"）
    endpoints: { lyrics: "https://example.invalid/api/lyric" },
    session: { token: "MUSIC-TOKEN", snsUserID: "SNS-1" },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, body: init.body === undefined ? null : JSON.parse(init.body) });
      return new Response(JSON.stringify({ result: { resultCode: "000000" }, lyric: "[00:01.00]一行" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const answer = await createPlaybackHandlers({ api })[PLAYBACK_LYRICS]({ payload: { trackId: " 1001 " } });
  assert.equal(answer.ok, true, `正常路径应当成功：${JSON.stringify(answer)}`);
  assert.equal(answer.data.text, "[00:01.00]一行");
  // 独立歌词端点是 GET（形状未实测，按"读一条文本"的最小形状发起），参数在查询串里
  assert.equal(new URL(calls[0].url).searchParams.get("contentID"), "1001", "trackId 去空白后作为请求参数");

  // 坏载荷在边界被拒（不透给协议层拼一个必然失败的请求）
  let called = 0;
  const guard = createPlaybackHandlers({
    api: {
      getLyrics: async () => {
        called += 1;
        return { ok: true, data: { text: "" } };
      },
    },
  })[PLAYBACK_LYRICS];
  for (const payload of [{}, { trackId: "" }, { trackId: "  " }, { trackId: 42 }, null, "nope"]) {
    const bad = await guard({ payload });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, "invalid_payload");
  }
  assert.equal(called, 0);

  // 端点未配置：结构化 endpoint_unknown（不冒充已实现、不猜 URL）
  // R32：默认那条路是"从播放响应推导"，所以第一个缺的端点是 playback
  const unconfigured = await createPlaybackHandlers({ api: createMusicApi({ endpoints: {} }) })[PLAYBACK_LYRICS]({
    payload: { trackId: "1" },
  });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.error.kind, "endpoint_unknown");
  assert.match(unconfigured.error.message, /playback/, "要说清是哪个端点没配（歌词走的就是播放端点）");

  // 歌词文本不进日志、不落盘（与播放地址同一条纪律）
  const source = stripComments(read("src/host/playback-handlers.mjs"));
  assert.doesNotMatch(source, /console\./, "处理器不许有 console 出口");
  assert.doesNotMatch(source, /writeFile|node:fs/, "不许有任何持久化出口");
});
