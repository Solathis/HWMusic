/** 歌词跨语言契约、配置保存与运行状态；原生几何/代次/退出行为在 Rust 测试。
 * Windows Beta 只授权 taskbar_lyrics.rs 对精确自窗附着，DLL/全局 Hook 仍全树禁止。
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
  CORE_LYRICS_CONTROL,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_SETTINGS_CLOSE,
  CORE_LYRICS_SETTINGS_OPEN,
  CORE_LYRICS_SETTINGS_RESIZE,
  CORE_LYRICS_TOGGLE,
} from "../src/shared/commands.ts";
import { PLAYBACK_LYRICS, REQUEST_CHANNELS } from "../src/shared/request-channels.ts";
import { THEME_CHANGED } from "../src/shared/channels.ts";
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_COLOR_TOKENS,
  LYRICS_FONT_STEPS,
  LYRICS_MODES,
  LYRICS_STATUS,
  LYRICS_TARGETS,
  MIN_PROGRESS_INTERVAL_MS,
  TASKBAR_FONT_STEPS,
  TASKBAR_MAX_FONT_PX,
  TASKBAR_REASONS,
  taskbarStatusText,
  clickThroughEnabled,
  colorTokenLabel,
  dragRegionEnabled,
  effectiveSizeId,
  estimateTimeMs,
  fontStepLabel,
  importPlanOf,
  isCustomColor,
  karaokeFrame,
  lyricsAppearance,
  lyricsBackdrop,
  lyricsConfigFromSearch,
  lyricsStatusFromFailure,
  lyricsTargetOf,
  lyricsTargetPlan,
  modeLabel,
  normalizeLyricsConfig,
  progressOf,
  reanchorProgress,
  resizableEnabled,
  shouldPushProgress,
  taskbarFontStepLabel,
  themeFromSearch,
} from "../src/renderer/features/lyrics/lyrics-window.mjs";
import { createLyricsBridge } from "../src/renderer/features/lyrics/lyrics-bridge.mjs";
import { createPlayer } from "../src/renderer/features/playback/player.mjs";
import { createPlaybackHandlers } from "../src/host/playback-handlers.mjs";
import { createMusicApi } from "../src/protocols/music.mjs";

const flushBridge = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferredBridge = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

/** 假 Rust 后端：settings.json 的唯一写者是 sidecar，歌词保存由 Rust 拥有。 */
function revisionBridge({ disk = {}, configureGate = null, saveGate = null, saveFailure = null } = {}) {
  const listeners = new Map();
  const commands = [];
  const settingsCalls = [];
  const persisted = [];
  const saves = [];
  let config = normalizeLyricsConfig(disk);
  let saved = normalizeLyricsConfig(disk);
  let revision = 0;
  let saveError = null;
  let pending = 0;
  let inflight = false;
  let failure = saveFailure;
  const status = () => ({
    config, revision, visible: false,
    dirty: pending > 0 || inflight || JSON.stringify(saved) !== JSON.stringify(config),
    saveError,
  });

  function scheduleSave() {
    if (inflight) return;
    inflight = true;
    saves.push("start");
    void (async () => {
      if (saveGate && saves.length === 1) await saveGate.promise;
      if (failure !== null) saveError = failure;
      else { saved = config; saveError = null; persisted.push(saved); }
      inflight = false;
      pending = 0;
      saves.push("end");
      for (const handler of [...(listeners.get(LYRICS_STATE) ?? [])]) await handler(status());
    })();
  }

  const bridge = createLyricsBridge({
    callCore: async (channel) => {
      if (String(channel).startsWith("settings:")) {
        settingsCalls.push({ channel });
        throw new Error(`渲染层不许自己写配置：${channel}`);
      }
      throw new Error(`Unexpected ${channel}`);
    },
    callCommand: async (command, args) => {
      commands.push({ command, args });
      if (command !== CORE_LYRICS_CONFIGURE) return { ...status(), visible: true };
      if (configureGate && args.config?.color === "primary") await configureGate.promise;
      if (args.retrySave === true) {
        saveError = null;
        pending += 1;
        scheduleSave();
        return status();
      }
      const next = normalizeLyricsConfig(args.config, config);
      if (JSON.stringify(next) !== JSON.stringify(config)) {
        config = next;
        revision += 1;
        pending += 1;
        scheduleSave();
      }
      return status();
    },
    subscribeCoreEvent: async (channel, handler) => {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler); listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    syncTheme: async () => {}, log: () => {},
  });
  const emit = async (payload) => { for (const handler of listeners.get(LYRICS_STATE) ?? []) await handler(payload); };
  return {
    bridge, commands, settingsCalls, persisted, saves, emit, listeners,
    /** 后端（= Rust 保存任务）下一次保存失败/成功由它控制。 */
    setFailure: (next) => { failure = next; },
    stored: () => saved,
    // writes 只是 persisted 的旧名字，保留是为了既有的状态用例不必改写。
    get writes() { return persisted; },
  };
}

test("R44c 配置 JSON/query 保留布局样式与 AMLL 开关，点透不等于锁定", () => {
  const config = normalizeLyricsConfig({ layout: "vertical", style: "panel", enableBlur: false, enableScale: false, enableSpring: false, showControls: false });
  assert.equal(config.layout, "vertical");
  assert.equal(config.style, "panel");
  assert.equal(config.enableBlur, false);
  assert.equal(config.enableScale, false);
  assert.equal(config.enableSpring, false);
  assert.equal(config.showControls, false);
  assert.deepEqual(lyricsConfigFromSearch("?layout=vertical&style=panel&enableBlur=0&enableScale=0&enableSpring=0&showControls=0"), config);
  assert.deepEqual(normalizeLyricsConfig(JSON.parse(JSON.stringify(config))), config);
  assert.equal(dragRegionEnabled({ ...DEFAULT_LYRICS_CONFIG, locked: true }), false);
  assert.equal(clickThroughEnabled({ ...DEFAULT_LYRICS_CONFIG, locked: true }), true);
});

test("R44e 启动只读：桥不读也不写 settings，恢复由 Rust 只读完成，只读一次权威状态", async () => {
  const env = revisionBridge({ disk: { style: "panel", layout: "vertical", bogus: "drop" } });
  const first = env.bridge.initialize();
  const second = env.bridge.initialize();
  await Promise.all([first, second]);
  assert.deepEqual(env.settingsCalls, [], "桥不许用 settings:get / settings:set 自己读盘或写盘（唯一写者是 sidecar）");
  assert.equal(env.commands.length, 1, "初始化只读一次权威状态（并发 initialize 合并成一次）");
  assert.deepEqual(env.commands[0].args, { config: {} }, "读回不带 restoreIfPristine（那个参数已取消）");
  assert.equal(env.bridge.snapshot().config.style, "panel");
  assert.equal(env.bridge.snapshot().config.layout, "vertical");
  assert.equal("bogus" in env.bridge.snapshot().config, false, "未知字段不进运行配置");
  assert.deepEqual(env.persisted, [], "启动不许写默认值（那会把用户盘上的旧配置覆盖掉）");
  env.bridge.dispose();
});

test("R44e 配置改动只发窄命令：Rust 回执与广播是唯一状态来源，桥不排队也不落盘", async () => {
  const configureGate = deferredBridge();
  const env = revisionBridge({ configureGate });
  await env.bridge.initialize();
  const old = env.bridge.applyConfig({ color: "primary" });
  await flushBridge();
  await env.emit({ revision: 5, visible: true, config: { ...DEFAULT_LYRICS_CONFIG, layout: "vertical", style: "panel" } });
  await env.emit({ revision: 6, visible: true, config: { ...DEFAULT_LYRICS_CONFIG, layout: "vertical", style: "panel", locked: true } });
  await flushBridge();
  configureGate.resolve(); await old;
  await flushBridge();
  assert.equal(env.bridge.snapshot().revision, 6, "迟到的旧 configure 回执不能把界面/配置退回旧值");
  assert.equal(env.bridge.snapshot().config.color, "foreground");
  assert.deepEqual(env.settingsCalls, [], "整条链路没有渲染层写者");
  assert.equal(
    env.commands.filter((call) => call.command === CORE_LYRICS_CONFIGURE).length,
    2,
    "每次改动一条窄命令（桥里没有第二套保存队列）",
  );
  env.bridge.dispose();
});

test("R44e 保存失败由 Rust 记账：saveError 翻成人话、retrySave 只发 {config:{},retrySave:true}", async () => {
  const env = revisionBridge({ saveFailure: "settings_write_failed" });
  await env.bridge.initialize();
  await env.bridge.applyConfig({ locked: true });
  await flushBridge();
  assert.equal(env.bridge.snapshot().config.locked, true, "保存失败保运行配置（本次运行仍生效）");
  assert.match(env.bridge.snapshot().saveError ?? "", /未保存/, "保存失败要让人看得见");
  assert.equal(env.bridge.snapshot().dirty, true, "失败保 dirty");
  assert.deepEqual(env.settingsCalls, [], "失败也不是渲染层去补写");
  env.setFailure(null);
  await env.bridge.retrySave();
  await flushBridge();
  const retry = env.commands.at(-1);
  assert.equal(retry.command, CORE_LYRICS_CONFIGURE);
  assert.deepEqual(retry.args, { config: {}, retrySave: true }, "重试是窄命令：重存当前运行配置，不是又改一次值");
  assert.equal(env.bridge.snapshot().saveError, null);
  assert.equal(env.bridge.snapshot().dirty, false);
  assert.deepEqual(env.stored(), { ...DEFAULT_LYRICS_CONFIG, locked: true });
  env.bridge.dispose();
});

test("R50 回归：保存失败之后**下一笔成功保存**会清掉旧的 saveError（不用重试也能自愈）", async () => {
  const env = revisionBridge({ saveFailure: "settings_write_failed" });
  await env.bridge.initialize();
  await env.bridge.applyConfig({ locked: true });
  await flushBridge();
  assert.match(env.bridge.snapshot().saveError ?? "", /未保存/, "先造一个失败");

  env.setFailure(null);
  await env.bridge.applyConfig({ locked: false });
  await flushBridge();
  assert.equal(env.bridge.snapshot().saveError, null, "下一笔成功保存要把旧的失败提示清掉（R44e 的 settle 逻辑）");
  assert.equal(env.bridge.snapshot().dirty, false, "落定之后不再是脏的");
  assert.deepEqual(env.stored(), { ...DEFAULT_LYRICS_CONFIG, locked: false }, "盘上的就是最后这一份");
  env.bridge.dispose();
});

test("R44c 取消初始化时迟到监听立即退订，重新挂载只有一套状态订阅", async () => {
  const gate = deferredBridge();
  let active = 0;
  let disposed = false;
  const bridge = createLyricsBridge({
    callCore: async () => ({ settings: { data: {} } }),
    callCommand: async () => ({ revision: 1, config: DEFAULT_LYRICS_CONFIG, visible: false }),
    subscribeCoreEvent: async () => { active += 1; await gate.promise; return () => { active -= 1; }; },
    syncTheme: async () => {}, log: () => {},
  });
  const initializing = bridge.initialize();
  await flushBridge(); bridge.dispose(); disposed = true;
  gate.resolve(); await initializing;
  assert.equal(disposed, true);
  assert.equal(active, 0, "旧 generation 不能留下 listener");
});

test("R44c 旧 generation configure 回执与失败初始化的迟到 listener 不得复活", async () => {
  const gate = deferredBridge();
  const env = revisionBridge({ configureGate: gate });
  await env.bridge.initialize();
  const old = env.bridge.applyConfig({ color: "primary" });
  await flushBridge();
  env.bridge.dispose();
  gate.resolve(); await old;
  assert.equal(env.bridge.snapshot().config.color, "foreground", "dispose 之后的旧回执不能改投影");

  const late = deferredBridge();
  let active = 0;
  let first = true;
  const bridge = createLyricsBridge({
    callCore: async () => ({ settings: { data: {} } }),
    callCommand: async () => ({ revision: 1, config: DEFAULT_LYRICS_CONFIG, visible: false }),
    subscribeCoreEvent: async () => {
      if (first) { first = false; throw new Error("listen failed"); }
      active += 1; await late.promise; return () => { active -= 1; };
    }, log: () => {},
  });
  await assert.rejects(bridge.initialize(), /listen failed/);
  late.resolve(); await flushBridge();
  assert.equal(active, 0);
});

test("R44c StrictMode 观察取消重挂只一套系统订阅，lyrics 广播实时更新设置投影", async () => {
  const env = revisionBridge();
  const previous = [];
  const current = [];
  const off = env.bridge.observe((status) => previous.push(status));
  off();
  const stop = env.bridge.observe((status) => current.push(status));
  await env.bridge.initialize();
  assert.equal(env.listeners.get(LYRICS_STATE).size, 1);
  assert.equal(env.listeners.get("lyrics:toggle").size, 1);
  await env.emit({ revision: 3, config: { ...DEFAULT_LYRICS_CONFIG, locked: true, layout: "vertical" }, visible: true });
  assert.equal(current.at(-1).config.layout, "vertical");
  assert.equal(current.at(-1).config.locked, true);
  assert.equal(previous.length, 1, "取消观察不收迟到状态");
  stop(); env.bridge.dispose();
  assert.equal(env.listeners.get(LYRICS_STATE).size, 0);
});

test("R44e 读回没有权威 revision：不采用、不假称已恢复，并给出可重试的错误", async () => {
  const bridge = createLyricsBridge({
    callCore: async (channel) => { throw new Error(`渲染层不许自己读写设置：${channel}`); },
    callCommand: async () => null, subscribeCoreEvent: async () => () => {}, log: () => {},
  });
  await assert.rejects(bridge.initialize());
  assert.match(bridge.snapshot().saveError, /未能恢复/);
  bridge.dispose();
});

test("R44c 最后主窗观察卸载后清理系统订阅，StrictMode 同步重挂不重复", async () => {
  const env = revisionBridge();
  const stop = env.bridge.observe(() => {});
  await env.bridge.initialize();
  stop(); await flushBridge();
  assert.equal(env.listeners.get(LYRICS_STATE).size, 0);
  assert.equal(env.listeners.get("lyrics:toggle").size, 0);
});

test("R44e 桥不合并也不重放：两次快速改动各一条窄命令，状态只认 Rust 回执 revision", async () => {
  const env = revisionBridge();
  await env.bridge.initialize();
  await env.bridge.applyConfig({ style: "panel" });
  await env.bridge.applyConfig({ layout: "vertical" });
  await flushBridge();
  const updates = env.commands.filter((call) => call.command === CORE_LYRICS_CONFIGURE);
  assert.equal(updates.length, 3, "初始化读回 + 两次改动，一次一条（桥里没有 latestPending 队列）");
  assert.deepEqual(updates[1].args, { config: { style: "panel" } });
  assert.deepEqual(updates[2].args, { config: { layout: "vertical" } });
  assert.equal(env.bridge.snapshot().revision, 2, "revision 只由 Rust 权威回执推进");
  assert.deepEqual(env.stored(), { ...DEFAULT_LYRICS_CONFIG, style: "panel", layout: "vertical" });
  env.bridge.dispose();
});

test("R44e 卸载所有渲染层观察者后保存仍在：桥不写盘，Rust 保存任务继续把最新配置落盘", async () => {
  const gate = deferredBridge();
  const env = revisionBridge({ saveGate: gate });
  const stop = env.bridge.observe(() => {});
  await env.bridge.initialize();
  await env.bridge.applyConfig({ style: "panel" });
  await env.bridge.applyConfig({ layout: "vertical" });
  stop(); await flushBridge();
  assert.equal(env.listeners.get(LYRICS_STATE).size, 0, "卸载系统监听，不留幽灵回调");
  assert.deepEqual(env.settingsCalls, [], "保存从不经渲染层（logout 之后也一样）");
  gate.resolve(); await flushBridge(); await flushBridge();
  assert.equal(env.bridge.snapshot().config.layout, "vertical");
  assert.equal(env.stored().layout, "vertical", "已接受配置不能在 logout/LibraryShell 卸载时丢盘");
  assert.equal(env.stored().style, "panel");
  assert.equal(env.persisted.at(-1).layout, "vertical", "最后一笔由 Rust 保存任务落盘（不是桥）");
  assert.equal(env.bridge.snapshot().saveError, null);
  env.bridge.dispose();
});

test("R44e 重挂只重接监听：不重新读盘也不并发第二个写者，旧监听不得复活", async () => {
  const gate = deferredBridge();
  const env = revisionBridge({ saveGate: gate });
  const off = env.bridge.observe(() => {});
  await env.bridge.initialize();
  await env.bridge.applyConfig({ style: "panel" });
  await env.bridge.applyConfig({ layout: "vertical" });
  const oldListeners = [...env.listeners.get(LYRICS_STATE)];
  off(); await flushBridge();
  const stop = env.bridge.observe(() => {});
  await env.bridge.initialize();
  for (const callback of oldListeners) await callback({ revision: 999, config: DEFAULT_LYRICS_CONFIG, visible: true });
  assert.equal(env.bridge.snapshot().revision, 2, "卸载的旧监听不能以高 revision 复活覆盖当前态");
  assert.equal(env.commands.filter((call) => call.args?.restoreIfPristine !== undefined).length, 0, "restoreIfPristine 已取消");
  assert.equal(env.listeners.get(LYRICS_STATE).size, 1);
  assert.equal(env.bridge.snapshot().config.layout, "vertical");
  assert.deepEqual(env.settingsCalls, []);
  gate.resolve(); await flushBridge(); await flushBridge();
  assert.equal(env.stored().layout, "vertical");
  stop(); env.bridge.dispose();
});

test("R44e 卸载后的保存失败仍可见，重挂后手动重试走窄命令并清掉错误", async () => {
  const env = revisionBridge({ saveFailure: "settings_write_unconfirmed" });
  const off = env.bridge.observe(() => {});
  await env.bridge.initialize();
  await env.bridge.applyConfig({ style: "panel" });
  await flushBridge();
  off(); await flushBridge();
  assert.match(env.bridge.snapshot().saveError ?? "", /未确认/, "卸载渲染层之后错误仍留在 Rust 状态里");
  env.setFailure(null);
  const stop = env.bridge.observe(() => {});
  await env.bridge.initialize();
  assert.match(env.bridge.snapshot().saveError ?? "", /未确认/, "重挂看得到上一次的失败");
  await env.bridge.retrySave();
  await flushBridge();
  assert.deepEqual(env.commands.at(-1).args, { config: {}, retrySave: true });
  assert.equal(env.bridge.snapshot().saveError, null);
  assert.equal(env.stored().style, "panel");
  stop(); env.bridge.dispose();
});

test("R44d taskbar 状态独立于 config/revision 透传，不持久化原生状态或 handles", async () => {
  const env = revisionBridge(); await env.bridge.initialize();
  const config = { ...DEFAULT_LYRICS_CONFIG, mode: "taskbar" };
  await env.emit({ revision: 2, config, visible: false, requestedVisible: true, taskbar: { supported: true, attached: false, reason: "access_denied" } });
  await flushBridge();
  assert.deepEqual(env.bridge.snapshot().taskbar, { supported: true, attached: false, reason: "access_denied" });
  assert.equal(env.bridge.snapshot().requestedVisible, true);
  const writes = env.writes.length;
  await env.emit({ revision: 2, config, visible: true, requestedVisible: true, taskbar: { supported: true, attached: true, reason: "attached" } });
  await flushBridge();
  assert.equal(env.bridge.snapshot().taskbar.attached, true, "同 config revision 的独立 D 状态必须可更新");
  assert.equal(env.writes.length, writes, "纯 D 状态不写 settings");
  assert.equal("taskbar" in env.stored(), false);
  assert.equal(modeLabel("taskbar"), "任务栏歌词（Beta）");
  await env.emit({ revision: 1, config: DEFAULT_LYRICS_CONFIG, visible: false, taskbar: { attached: false, reason: "disabled", supported: false } });
  assert.equal(env.bridge.snapshot().taskbar.attached, true, "旧 revision 的 D 状态也不得覆盖新配置");
  env.bridge.dispose();
});

test("R44d D5 同配置 revision 的迟到 waiting 回执不能覆盖新 attached，反向也拒旧", async () => {
  const gate = deferredBridge(); const env = revisionBridge({ configureGate: gate }); await env.bridge.initialize();
  const old = env.bridge.applyConfig({ color: "primary" }); await flushBridge();
  const config = { ...DEFAULT_LYRICS_CONFIG, color: "primary", mode: "taskbar" };
  await env.emit({ revision: 2, runtimeRevision: 8, config, visible: true, requestedVisible: true, taskbar: { supported: true, attached: true, reason: "attached" } });
  await env.emit({ revision: 2, runtimeRevision: 7, config, visible: false, requestedVisible: true, taskbar: { supported: true, attached: false, reason: "waiting" } });
  gate.resolve(); await old;
  assert.equal(env.bridge.snapshot().visible, true);
  assert.equal(env.bridge.snapshot().taskbar.attached, true);
  assert.equal(env.bridge.snapshot().runtimeRevision, 8);
  await env.emit({ revision: 2, runtimeRevision: 9, config, visible: false, requestedVisible: true, taskbar: { supported: true, attached: false, reason: "timeout" } });
  await env.emit({ revision: 2, runtimeRevision: 8, config, visible: true, requestedVisible: true, taskbar: { supported: true, attached: true, reason: "attached" } });
  assert.equal(env.bridge.snapshot().visible, false);
  assert.equal(env.bridge.snapshot().taskbar.reason, "timeout");
  await flushBridge(); assert.equal("runtimeRevision" in env.stored(), false); env.bridge.dispose();
});

test("R44d Rust 与 renderer 独立状态词表一致，未知原因不假称已内嵌", () => {
  const source = rustSource("taskbar_lyrics.rs");
  const mapping = source.slice(source.indexOf("pub fn as_str"), source.indexOf("pub fn payload"));
  assert.deepEqual([...mapping.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]), TASKBAR_REASONS);
  for (const reason of TASKBAR_REASONS) assert.ok(taskbarStatusText({ reason }).length > 0);
  assert.match(taskbarStatusText({ reason: "access_denied" }), /权限.*停显/);
  assert.doesNotMatch(taskbarStatusText({ reason: "new-unknown" }), /已内嵌/);
});

test("R44d config 白名单不接受 renderer 伪造 taskbar 状态或原生目标", () => {
  const config = normalizeLyricsConfig({ mode: "taskbar", taskbar: { attached: true }, parent: 123, hwnd: 123 });
  assert.equal(config.mode, "taskbar");
  assert.equal("taskbar" in config, false); assert.equal("parent" in config, false); assert.equal("hwnd" in config, false);
});

test("R44e 歌词桥里没有第二个 settings 写者：SETTINGS_GET/SET、bootstrap 恢复与 JS 保存队列都不在了", () => {
  const bridge = stripComments(read("src/renderer/features/lyrics/lyrics-bridge.mjs"));
  assert.doesNotMatch(bridge, /SETTINGS_(GET|SET)/, "桥不许再引 settings:get / settings:set 常量");
  assert.doesNotMatch(bridge, /restoreIfPristine/, "启动恢复由 Rust 只读完成，桥不再发那条参数");
  assert.doesNotMatch(bridge, /queueSave|latestPending|savedConfig|saveEnabled/, "桥里不再有第二套保存队列");
  assert.doesNotMatch(bridge, /localStorage|sessionStorage/, "渲染层不存第二份配置");

  // 保存任务在 Rust：唯一的内部写口子是 commands::settings_write_owned，且歌词不可自己写盘
  const lyrics = rustProduction(rustSource("lyrics_window.rs"));
  assert.match(lyrics, /settings_write_owned/, "歌词落盘走内部 settings:set（与主题/代理同一条尾链）");
  assert.doesNotMatch(lyrics, /std::fs::write|std::fs::rename/, "歌词模块不许自己写 settings.json");
});

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

test("命令名：歌词专命令共享真源、注册与最小 capability 一致", () => {
  assert.equal(CORE_LYRICS_TOGGLE, "core_lyrics_toggle");
  assert.equal(CORE_LYRICS_CONFIGURE, "core_lyrics_configure");
  assert.equal(CORE_LYRICS_CONTROL, "core_lyrics_control");
  assert.equal(CORE_LYRICS_DOCUMENT, "core_lyrics_document");
  assert.equal(CORE_LYRICS_PROGRESS, "core_lyrics_progress");
  // 设置弹出窗的三条命令：打开 / 报尺寸 / 关闭自己
  assert.equal(CORE_LYRICS_SETTINGS_OPEN, "core_lyrics_settings_open");
  assert.equal(CORE_LYRICS_SETTINGS_RESIZE, "core_lyrics_settings_resize");
  assert.equal(CORE_LYRICS_SETTINGS_CLOSE, "core_lyrics_settings_close");
  const hostApi = read("src/renderer/host-api.ts");
  for (const [constant, wrapper] of [["TOGGLE","Toggle"], ["CONFIGURE","Configure"], ["CONTROL","Control"], ["DOCUMENT","Document"], ["PROGRESS","Progress"], ["SETTINGS_OPEN","SettingsOpen"], ["SETTINGS_RESIZE","SettingsResize"], ["SETTINGS_CLOSE","SettingsClose"]]) {
    assert.match(hostApi, new RegExp(`invokeLyrics\\(CORE_LYRICS_${constant}`));
    assert.match(hostApi, new RegExp(`export async function coreLyrics${wrapper}\\(`));
  }
  assert.doesNotMatch(hostApi, /["']core_lyrics_[a-z]+["']/);
  const permission = JSON.parse(read("src-tauri/capabilities/lyrics.json"));
  assert.deepEqual(permission.windows, ["lyrics"]);
  assert.deepEqual(
    permission.permissions,
    // 右下角拖柄调官方 startResizeDragging ⇒ 只加这一条窗口权限（不放开 ACL，不提权）
    ["core:event:default", "core:window:allow-start-dragging", "core:window:allow-start-resize-dragging"],
  );
  assert.deepEqual(JSON.parse(read("src-tauri/capabilities/main.json")).windows, ["main"]);
  // 设置弹出窗没有任何 window 权限（尺寸/位置/关闭都由 Rust 的专命令负责）
  const popupPermission = JSON.parse(read("src-tauri/capabilities/lyrics-settings.json"));
  assert.deepEqual(popupPermission.windows, ["lyrics-settings"]);
  assert.deepEqual(popupPermission.permissions, ["core:event:default"]);
  assert.doesNotMatch(JSON.stringify(popupPermission), /allow-start|allow-set-(size|position)|allow-close/, "弹出窗不许有窗口权限");
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  for (const [name, values] of [["LYRICS_LAYOUTS", ["horizontal","vertical"]], ["LYRICS_STYLES", ["clean","panel","bare"]], ["LYRICS_CONTROL_ACTIONS", ["toggle","previous","next"]]]) {
    const body = rust.match(new RegExp(`${name}[^=]*=\\s*&\\[([^\\]]+)\\]`))[1];
    assert.deepEqual([...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]), values);
  }
});

test("Rust：歌词专命令都 async、正确来源守卫且注册", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const lib = read("src-tauri/src/lib.rs");
  for (const [name, guard] of [
    ["core_lyrics_toggle", "require_main_webview(webview.label())"],
    ["core_lyrics_document", "require_main_webview(webview.label())"],
    ["core_lyrics_progress", "require_main_webview(webview.label())"],
    ["core_lyrics_configure", "validate_configure(webview.label()"],
    ["core_lyrics_control", "control_payload(webview.label()"],
    ["core_lyrics_unlock_zone", "webview.label() != LYRICS_WINDOW_LABEL"],
  ]) {
    assert.match(rust, new RegExp(`pub async fn ${name}\\(`));
    const body = rust.slice(rust.indexOf(`pub async fn ${name}(`));
    assert.ok(body.indexOf(guard) >= 0 && body.indexOf(guard) < 900);
    assert.match(lib, new RegExp(`lyrics_window::${name}\\b`));
  }
  // 弹出窗的三条命令在 lyrics_settings.rs 里，注册在同一个 generate_handler!
  const popup = rustProduction(rustSource("lyrics_settings.rs"));
  for (const [name, guard] of [
    ["core_lyrics_settings_open", "require_settings_open_source(webview.label())"],
    ["core_lyrics_settings_resize", "require_settings_self_source(webview.label())"],
    ["core_lyrics_settings_close", "require_settings_self_source(webview.label())"],
  ]) {
    assert.match(popup, new RegExp(`pub async fn ${name}\\(`));
    assert.ok(popup.indexOf(guard) >= 0, `${name} 必须过窄守卫 ${guard}`);
    assert.match(lib, new RegExp(`lyrics_settings::${name}\\b`), `${name} 要注册`);
  }
  // 配置放行弹出窗，媒体控制不放行（它能改外观，没有理由替用户按播放键）
  assert.match(rust, /pub fn require_lyrics_source/);
  assert.match(rust, /LYRICS_SETTINGS_WINDOW_LABEL/, "配置守卫里点名了弹出窗");
  assert.match(rust, /pub fn require_lyrics_control_source/, "媒体控制有自己那条更窄的守卫");
  assert.match(lib, /pub const LYRICS_SETTINGS_WINDOW_LABEL: &str = "lyrics-settings"/, "窗口 label 与歌词窗常量放在同一处");
});

test("Rust：建窗属性一次到位（无边框/透明/无阴影/置顶/不进任务栏/按锁定可缩放/不聚焦/隐藏后 show）", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const builder = rust.slice(rust.indexOf("WebviewWindowBuilder::new"), rust.indexOf("WebviewWindowBuilder::new") + 1800);

  for (const [call, why] of [
    [".decorations(false)", "无边框"],
    [".transparent(true)", "透明"],
    [".shadow(false)", "无阴影"],
    [".always_on_top(desktop_topmost(config))", "仅桌面置顶"],
    [".skip_taskbar(true)", "不进任务栏"],
    // 缩放资格按配置算（未锁的桌面窗可拖大小；锁定/任务栏不可），最小尺寸 240×120
    [".resizable(resizable_enabled(config))", "可缩放资格按配置算（锁定/任务栏不可）"],
    [".min_inner_size(MIN_WINDOW_WIDTH_DIP, MIN_WINDOW_HEIGHT_DIP)", "最小尺寸由窗口层兜住"],
    [".focused(false)", "不抢焦点"],
    [".visible(false)", "先建出来是隐藏的（防闪默认样式，按配置再 show）"],
  ]) {
    assert.ok(builder.includes(call), `歌词窗必须 ${call}（${why}）`);
  }
  assert.match(rust, /window\.set_resizable\(resizable_enabled\(config\)\)/, "锁定配置落下去时也要收回缩放资格");
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

test("Rust：普通开关隐藏不销毁，换模式与退出走受控销毁", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const toggle = rust.slice(rust.indexOf("fn apply_toggle"), rust.indexOf("pub struct ToggleFailurePlan"));
  assert.match(toggle, /\.hide\(\)/, "普通关闭保留 webview 与进度");
  assert.doesNotMatch(toggle, /\.destroy\(|\.close\(/);
  assert.match(rust, /rebuild_window/);
  assert.ok(
    !rust.includes("Mutex<Option<WebviewWindow>>") && !rust.includes("Vec<WebviewWindow>"),
    "窗口归属 tauri 的窗口表（get_webview_window 现问），不许自己再记一份镜像",
  );
});

test("R44d D3：桌面重开不 reload/show 已 revoke 的旧代次，先受控销毁再由新代次重建", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  const taskbar = rustProduction(rustSource("taskbar_lyrics.rs"));
  // 判定是纯函数（真值表在 Rust 单测里），命令体只按它走路
  assert.match(rust, /pub fn desktop_reopen\(/, "「这扇窗能不能沿用」要是可单测的纯函数");
  const toggle = rust.slice(
    rust.indexOf("pub async fn core_lyrics_toggle("),
    rust.indexOf("pub async fn core_lyrics_configure("),
  );
  const plan = toggle.indexOf("desktop_reopen(");
  const applied = toggle.indexOf("apply_toggle(");
  assert.ok(plan >= 0, "开关命令必须先问判定，不能直接 apply_toggle");
  assert.ok(applied > plan, "判定要在 apply_toggle（reload/show）之前");
  const branch = toggle.indexOf("DesktopReopen::ReplaceRevoked");
  assert.ok(branch > plan, "被 revoke 的旧代次要有单独一条路");
  const replaced = toggle.slice(branch);
  const rebuild = replaced.indexOf("rebuild_window(");
  assert.ok(rebuild >= 0 && rebuild < 900, "旧代次走既有的受控 detach/restore/destroy 后重建");
  assert.doesNotMatch(replaced.slice(0, rebuild), /\.show\(\)|\.reload\(\)/, "那条路不许显示/重新加载旧 HWND");
  assert.match(toggle, /lock\(&state\.lifecycle\)\.requested = checked/, "重建后按目标态重新打开（rebuild_window 只看 requested）");
  assert.match(taskbar, /pub fn revoked_live\(/, "宿主给窄只读口子：已 revoke 的代次是否仍活着");
  assert.ok(rust.includes("fn revoked_window"), "撤销态只读地取自宿主");
  // 真正 reload/show 的那一步也得先问撤销态（命令层判定之后、显示之前被 revoke 的竞态）。
  // 行为级证据在 Rust 单测（假宿主 + 数 show/reload 次数的假窗），这里只钉接线位置。
  const seamAt = rust.indexOf("pub fn open_desktop(");
  assert.ok(seamAt >= 0, "显示那一步要是窄收口（行为测试才能数 show/reload 次数）");
  const seam = rust.slice(seamAt, rust.indexOf("\n}", seamAt));
  const gate = seam.indexOf("if revoked");
  assert.ok(gate >= 0, "窄收口必须先问撤销态");
  assert.ok(gate < seam.indexOf("reload()"), "撤销态判定必须挡在 reload 之前");
  assert.ok(gate < seam.indexOf("show()"), "撤销态判定必须挡在 show 之前");
  assert.ok(
    rust.includes("open_desktop(revoked_window(app)"),
    "沿用的那条路只许从窄收口显示，且撤销态取自宿主",
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
  // 任务栏有自己的档位表（44px 高的槽位只放得下一行），两侧同样逐条相等
  for (const step of TASKBAR_FONT_STEPS) {
    assert.match(
      rust,
      new RegExp(`\\("${step.id}",\\s*${step.px}\\)`),
      `Rust 的任务栏档位表必须含 (${step.id}, ${step.px})`,
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
  assert.equal(Math.max(...TASKBAR_FONT_STEPS.map((step) => step.px)), TASKBAR_MAX_FONT_PX,
    "任务栏档位表的最高一档就是上限（表不许偷偷长大）");
  // 默认值两侧同源：任何一个默认值对不上，重启后的观感就会与本次运行不同
  for (const [name, value] of [
    ["DEFAULT_TASKBAR_SIZE", DEFAULT_LYRICS_CONFIG.taskbarSize],
    ["DEFAULT_TASKBAR_COLOR", DEFAULT_LYRICS_CONFIG.taskbarColor],
  ]) {
    assert.match(rust, new RegExp(`pub const ${name}: &str = "${value}"`), `两侧默认值要一致：${name}`);
  }
  assert.match(rust, /"desktop"/, "模式词表两侧同源");
  assert.match(rust, /"taskbar"/);
  assert.deepEqual([...LYRICS_MODES], ["desktop", "taskbar"]);
});

test("配置：CSS 里每个档位都有字号规则，且 rem 值与 px 对得上", () => {
  const css = read("src/renderer/amll-theme.css");
  // 桌面档位与任务栏档位各一套规则（id 不重叠，所以选择器不需要模式限定）
  for (const step of [...LYRICS_FONT_STEPS, ...TASKBAR_FONT_STEPS]) {
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
    "CreateRemoteThread",
    "WriteProcessMemory",
    "VirtualAllocEx",
    "QueueUserAPC",
    "NtCreateThreadEx",
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
      const allowed = relative === "src-tauri/src/taskbar_lyrics.rs" && ["Shell_TrayWnd", "FindWindowW", "FindWindowExW", "SetParent", "explorer.exe"].includes(token);
      if (source.includes(token) && !allowed) offenders.push(`${relative}: ${token}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `仅 taskbar_lyrics.rs 有精确自窗内嵌例外，DLL/全局 Hook 仍全树禁止：\n${offenders.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// 6. 纯逻辑：配置 / 节流 / 状态
// ---------------------------------------------------------------------------

test("配置纯逻辑：认不出的值一律不猜（落回上一个合法值）", () => {
  const base = { ...DEFAULT_LYRICS_CONFIG, mode: "desktop", size: "xl", color: "primary", locked: true };

  assert.deepEqual(normalizeLyricsConfig({}, base), base, "空 patch = 原样（设置页挂载时读回当前配置）");
  assert.deepEqual(normalizeLyricsConfig(null, base), base, "坏 patch 同样不猜");
  assert.deepEqual(normalizeLyricsConfig("nope", base), base);

  const patch = normalizeLyricsConfig({ mode: "taskbar", size: "md", color: "muted", locked: false }, base);
  assert.deepEqual(patch, { ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", size: "md", color: "muted", locked: false });

  const bogus = normalizeLyricsConfig({ mode: "floating", size: "999", color: "#fff", locked: "yes", clickThrough: 1 }, base);
  assert.deepEqual(bogus, base, "认不出的模式/档位/颜色/布尔都不许猜（尤其不许把字符串当真）");

  // 首帧（没有任何上一个合法值）落默认
  assert.deepEqual(normalizeLyricsConfig({ mode: "floating" }, null), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(normalizeLyricsConfig(undefined, undefined), DEFAULT_LYRICS_CONFIG);
});

/** 任务栏模式读自己的档位表，桌面选的档位原样保留、不再参与任务栏渲染。 */
test("配置纯逻辑：任务栏模式读任务栏档位（桌面档位原样保留，两边互不改写）", () => {
  const big = { ...DEFAULT_LYRICS_CONFIG, size: "xxl" };
  assert.equal(effectiveSizeId(big), "xxl", "桌面模式按用户选的档位");
  assert.equal(effectiveSizeId({ ...big, mode: "taskbar" }), DEFAULT_LYRICS_CONFIG.taskbarSize,
    "任务栏模式只读 taskbarSize（桌面档位不参与）");
  assert.equal(effectiveSizeId({ ...big, mode: "taskbar", taskbarSize: "tsm" }), "tsm", "任务栏自己的档位照收");
  assert.equal(effectiveSizeId({ ...big, mode: "taskbar", taskbarSize: "huge" }),
    DEFAULT_LYRICS_CONFIG.taskbarSize, "认不出的任务栏档位落默认（绝不猜）");

  // 保留配置值：切回桌面模式还是用户选的那个
  const taskbar = normalizeLyricsConfig({ mode: "taskbar" }, big);
  assert.equal(taskbar.size, "xxl");
  assert.equal(effectiveSizeId(taskbar), DEFAULT_LYRICS_CONFIG.taskbarSize);

  for (const step of TASKBAR_FONT_STEPS) {
    const effective = effectiveSizeId({ ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", taskbarSize: step.id });
    const px = TASKBAR_FONT_STEPS.find((entry) => entry.id === effective).px;
    assert.ok(px <= TASKBAR_MAX_FONT_PX, `任务栏档位 ${step.id} 的实际字号必须 ≤ ${TASKBAR_MAX_FONT_PX}px，实际 ${px}`);
  }
});

test("配置纯逻辑：任务栏外观四字段（默认 / 坏值不猜 / 两模式各读各的）", () => {
  // 默认值：逐字高亮默认开。
  assert.equal(DEFAULT_LYRICS_CONFIG.taskbarSize, "txxl");
  assert.equal(DEFAULT_LYRICS_CONFIG.taskbarColor, "foreground");
  assert.equal(DEFAULT_LYRICS_CONFIG.taskbarCustomColor, "");
  assert.equal(DEFAULT_LYRICS_CONFIG.taskbarKaraoke, true);
  assert.equal(TASKBAR_FONT_STEPS.find((step) => step.id === "txxl").px, 20,
    "默认任务栏字号 = R58 渲染出来的 20px");

  const base = { ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", taskbarSize: "tlg", taskbarColor: "primary",
    taskbarCustomColor: "#112233", taskbarKaraoke: false };
  assert.deepEqual(normalizeLyricsConfig({}, base), base, "空 patch = 原样");
  // 坏值一个都不许覆盖：桌面档位不是任务栏档位、色值不是令牌、自定义色不是 hex、布尔只认真正的布尔
  assert.deepEqual(
    normalizeLyricsConfig({ taskbarSize: "lg", taskbarColor: "#fff", taskbarCustomColor: "red", taskbarKaraoke: "yes" }, base),
    base,
  );
  const patched = normalizeLyricsConfig(
    { taskbarSize: "tsm", taskbarColor: "muted", taskbarCustomColor: "#00dd00", taskbarKaraoke: true }, base);
  assert.equal(patched.taskbarSize, "tsm");
  assert.equal(patched.taskbarColor, "muted");
  assert.equal(patched.taskbarCustomColor, "#00dd00");
  assert.equal(patched.taskbarKaraoke, true);

  // 查询串：Rust 建窗时把四个键拼进去，渲染层按同一条解析链读回
  const fromQuery = lyricsConfigFromSearch(
    "?mode=taskbar&taskbarSize=txl&taskbarColor=muted&taskbarCustomColor=%2300DD00&taskbarKaraoke=0");
  assert.equal(fromQuery.taskbarSize, "txl");
  assert.equal(fromQuery.taskbarColor, "muted");
  assert.equal(fromQuery.taskbarCustomColor, "#00DD00");
  assert.equal(fromQuery.taskbarKaraoke, false);
  assert.deepEqual(lyricsConfigFromSearch("?taskbarSize=huge&taskbarKaraoke=yes"),
    DEFAULT_LYRICS_CONFIG, "查询串里的坏值落默认");

  // 两模式各读各的：任务栏模式只读任务栏四字段，桌面模式只读原字段
  const taskbarView = lyricsAppearance({ ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", size: "xl", color: "contrast",
    customColor: "#ff0000", taskbarSize: "tsm", taskbarColor: "primary", taskbarCustomColor: "#00dd00", taskbarKaraoke: false });
  assert.deepEqual(taskbarView, { size: "tsm", color: "primary", customColor: "#00dd00", karaoke: false });
  const desktopView = lyricsAppearance({ ...DEFAULT_LYRICS_CONFIG, size: "xl", color: "contrast",
    customColor: "#ff0000", taskbarSize: "tsm", taskbarColor: "primary", taskbarCustomColor: "#00dd00", taskbarKaraoke: false });
  assert.deepEqual(desktopView, { size: "xl", color: "contrast", customColor: "#ff0000", karaoke: true },
    "桌面模式读原字段，且逐字高亮恒开（任务栏的开关不许影响它）");

  // 档位标签：认不出的按默认档位说（界面不出现空串）
  for (const step of TASKBAR_FONT_STEPS) {
    assert.equal(taskbarFontStepLabel(step.id), step.label);
  }
  assert.equal(taskbarFontStepLabel("huge"), TASKBAR_FONT_STEPS.find((step) => step.id === DEFAULT_LYRICS_CONFIG.taskbarSize).label);
});

test("配置纯逻辑：拖动区与点透（锁定时不挂拖动区；任务栏模式一律点透）", () => {
  const base = DEFAULT_LYRICS_CONFIG;
  assert.equal(dragRegionEnabled(base), true, "桌面模式默认可拖");
  assert.equal(dragRegionEnabled({ ...base, locked: true }), false, "锁定就不挂 data-tauri-drag-region");
  assert.equal(dragRegionEnabled({ ...base, mode: "taskbar" }), false, "任务栏模式贴在边上，不给拖");

  assert.equal(clickThroughEnabled(base), false, "未锁定的桌面歌词要能接收鼠标");
  assert.equal(clickThroughEnabled({ ...base, locked: true }), true, "锁定的桌面歌词不接收鼠标");
  assert.equal(
    clickThroughEnabled({ ...base, mode: "taskbar" }),
    true,
    "任务栏模式是贴在屏幕下沿的一条显示带：默认点透，别挡住底下窗口的点击",
  );
});

test("配置纯逻辑：衬底深浅（锁定的桌面歌词更淡，纯透明与任务栏没有衬底）", () => {
  assert.equal(lyricsBackdrop({ ...DEFAULT_LYRICS_CONFIG, mode: "desktop", style: "clean" }), "normal");
  assert.equal(lyricsBackdrop({ ...DEFAULT_LYRICS_CONFIG, mode: "desktop", style: "clean", locked: true }), "light");
  assert.equal(lyricsBackdrop({ ...DEFAULT_LYRICS_CONFIG, mode: "desktop", style: "panel", locked: true }), "light");
  assert.equal(lyricsBackdrop({ ...DEFAULT_LYRICS_CONFIG, mode: "desktop", style: "bare" }), "none");
  assert.equal(lyricsBackdrop({ ...DEFAULT_LYRICS_CONFIG, mode: "taskbar" }), "none");
});

test("歌词窗：锁定时按光标位置显形解锁按钮，并把解锁区上报给 Rust", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  for (const token of [
    "LYRICS_POINTER",
    "coreLyricsUnlockZone",
    "group-data-[pointer=inside]/locked:opacity-100",
    "data-lyrics-backdrop",
  ]) {
    assert.ok(source.includes(token), `歌词窗源码必须包含 ${token}`);
  }
});

test("配置纯逻辑：查询串解析（歌词窗的初值；认不出的值落默认）", () => {
  assert.deepEqual(lyricsConfigFromSearch(""), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(lyricsConfigFromSearch(null), DEFAULT_LYRICS_CONFIG);
  assert.deepEqual(
    lyricsConfigFromSearch("?mode=taskbar&size=md&color=primary&locked=1"),
    { ...DEFAULT_LYRICS_CONFIG, mode: "taskbar", size: "md", color: "primary", locked: true },
  );
  assert.deepEqual(
    lyricsConfigFromSearch("?mode=taskbar&locked=0"),
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
  for (const key of ["mode", "size", "color", "locked"]) {
    assert.match(rust, new RegExp(`${key}=`), `Rust 拼的歌词窗 URL 必须带 ${key} 参数`);
  }
  assert.doesNotMatch(rust, /clickThrough=/, "已删除的 clickThrough 不再出现在歌词窗 URL 里");
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

test("逐字帧状态：playing 跟着进度消息走（不等帧循环）", () => {
  const push = { timeMs: 5000, playing: true, seekGeneration: 3, atMs: 1000 };
  assert.deepEqual(karaokeFrame(push, 1050), { time: 5050, isSeeking: false, playing: true }, "播放中：时刻插值 + 播放态");
  assert.equal(karaokeFrame({ ...push, playing: false }, 9000).playing, false, "暂停消息立刻就是 false");
  assert.equal(karaokeFrame({ ...push, playing: false }, 9000).time, 5000, "暂停时时刻停住");
  assert.deepEqual(karaokeFrame(null, 1000, true), { time: 0, isSeeking: true, playing: false }, "还没收到进度：零值 + 跳转窗透传");
  assert.equal(karaokeFrame({ timeMs: 5000, playing: "yes", atMs: 0 }, 0).playing, false, "只有真正的 true 才算播放");
});

test("配置提示与档位标签可读", () => {
  for (const step of LYRICS_FONT_STEPS) assert.ok(fontStepLabel(step.id).trim() !== "");
  for (const token of LYRICS_COLOR_TOKENS) assert.ok(colorTokenLabel(token.id).trim() !== "");
  for (const mode of LYRICS_MODES) assert.ok(modeLabel(mode).trim() !== "");
  assert.equal(fontStepLabel("nope"), fontStepLabel(DEFAULT_LYRICS_CONFIG.size), "认不出的档位按默认说");
  /** 界面提示词克制：不显示冗余说明段落，必要的状态改成控件旁一行。
   * 这条用例是反向钉子——那段会话说明文案不许再回来。 */
  assert.equal(
    read("src/renderer/features/lyrics/lyrics-window.mjs").includes("LYRICS_SESSION_NOTICE"),
    false,
    "会话说明长段落已删除（R52 的文案克制）",
  );
  assert.equal(
    read("src/renderer/pages.tsx").includes("LYRICS_SESSION_NOTICE"),
    false,
    "设置页也不再引用它",
  );
});

// ---------------------------------------------------------------------------
// 7. 歌词窗渲染层
// ---------------------------------------------------------------------------

test("歌词窗：官方 AMLL 渲染与受限命令，不调任意业务请求", () => {
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

  assert.doesNotMatch(code, /coreCall\(|invoke\(|CORE_LYRICS_|CORE_CALL/, "歌词窗不直接 invoke 或任意 coreCall，仅用具名受限封装");
  assert.match(source, /from\s+"\.\/host-api"/, "订阅走 host-api 的封装");
  assert.match(code, /onCoreEvent/, "数据经 core:event 漏斗事件进来");
  for (const channel of ["LYRICS_DOCUMENT", "LYRICS_PROGRESS", "LYRICS_STATE"]) {
    assert.match(code, new RegExp(`onCoreEvent(?:<[\\s\\S]*?>)?\\(\\s*${channel}\\b`), `歌词窗要订阅 ${channel}`);
  }
  assert.doesNotMatch(code, /fetch\s*\(|XMLHttpRequest|WebSocket/, "歌词窗不发请求");

  // 视觉约束：不写 AMLL 变量、不拿色值拼样式
  assert.doesNotMatch(code, /--amll-/, "AMLL 变量只许出现在 amll-theme.css");
  assert.doesNotMatch(code, /style=\{\{/, "不许内联视觉样式（AMLL 100% 尺寸例外只有那两处宿主）");
});

test("歌词窗：data 属性全部来自纯逻辑模块（字号/颜色/模式/拖动/点透）", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  assert.match(source, /lyrics-window\.mjs/, "配置与判定必须来自纯逻辑模块（可单测）");
  for (const helper of ["normalizeLyricsConfig", "lyricsAppearance", "dragRegionEnabled", "lyricsConfigFromSearch"]) {
    assert.match(source, new RegExp(helper), `歌词窗要用 ${helper}（不在这里另写一份判定）`);
  }
  assert.match(source, /data-lyrics-size=/, "字号档位经 data 属性交给 CSS（内联样式禁令的必然结果）");
  assert.match(source, /data-lyrics-color=/, "颜色令牌同理");
  assert.match(source, /data-lyrics-mode=/, "模式（桌面/任务栏）同理");
  assert.match(source, /startDragging\(/, "官方 startDragging 由明确拖柄与非交互宿主调用");
  assert.match(source, /lyricsNoticeText/, "占位文案来自 playback-state.mjs（不在这里另写一份）");
});

test("歌词窗入口：lyrics-main.tsx 挂载 LyricsWindow（双入口那一份不再是空壳）", () => {
  const entry = read("src/renderer/lyrics-main.tsx");
  assert.match(entry, /LyricsWindow/, "歌词窗入口必须挂载 LyricsWindow");
  assert.match(entry, /import\s*\{[^}]*LyricsWindow[^}]*\}\s*from\s*"\.\/LyricsWindow\.tsx"/, "从 LyricsWindow.tsx 导入");
  const expectedCss = [
    "@applemusic-like-lyrics/core/style.css",
    "@applemusic-like-lyrics/react-full/style.css",
    "./amll-theme.css",
    "./styles.css",
  ];
  // 弹出窗入口用同一份样式表（菜单视觉必须与歌词窗里那份逐像素一致）
  // 歌词窗与它的设置面板多一份竖版组件样式（主窗不渲染竖版歌词，不引）
  const expectedCssByFile = {
    "src/renderer/main.tsx": expectedCss,
    "src/renderer/lyrics-settings-main.tsx": [...expectedCss, "./vertical-lyrics.css"],
    "src/renderer/lyrics-main.tsx": [...expectedCss, "./vertical-lyrics.css"],
  };
  for (const [file, expected] of Object.entries(expectedCssByFile)) {
    const imports = [...read(file).matchAll(/^import "([^"]+\.css)"/gm)].map((match) => match[1]);
    assert.deepEqual(imports, expected, `${file}：core → full → 变量接线 → 应用样式（+ 歌词窗的竖版样式）`);
  }
});

test("歌词窗主题（R41）：初值走查询串、变化走广播，且**不新增命令**", () => {
  const entry = read("src/renderer/lyrics-main.tsx");
  // 初值：建窗时 Rust 拼进 URL（歌词窗调不动读主题的那条命令，只能这么同步给它）
  assert.match(entry, /themeFromSearch\(window\.location\.search\)/, "主题初值从查询串读");
  assert.match(entry, /applyThemeChoice\(document\.documentElement/, "切类只经 theme.mjs 的那一个入口");
  // 变化：订阅 `theme:changed` 广播（订阅不需要权限）
  const host = read("src/renderer/LyricsWindow.tsx");
  assert.match(host, /onCoreEvent<[^\n]+>\(THEME_CHANGED/, "主题订阅与文档/进度一起确认就绪");
  assert.match(host, /onCoreEvent</, "订阅走 host-api 的封装");
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

test("桌窗文档重发：保留 Rust 加载重发，不在 visible 翻转时盲推", () => {
  const hook = read("src/renderer/use-lyrics-window.ts");
  // 渲染层不在窗口打开时重推（reload 是异步的，那一推必然太早）
  // 实际订阅就绪由新页握手确认。
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
  assert.match(rust, /fn replay_after_page_load/, "重发是一个单独的函数（页面加载回调与命令各用各的一半）");
  // 缓存发生在发出去那一刻：core_lyrics_document 里"留一份"要在"发出去"之前
  const command = rust.slice(rust.indexOf("pub async fn core_lyrics_document("));
  const kept = command.indexOf("remember_document(");
  const emitted = command.indexOf("emit_core_event(");
  assert.ok(kept > 0 && emitted > kept, "先留一份再发出去（缓存住的必须是用户本来能看到的那一份）");
  assert.match(command.slice(0, kept), /return Err\(/, "归一失败如实报错，不缓存半个文档");
  // 日志里不许出现文档内容（歌词文本进日志 = 把用户的歌单抄进日志文件）
  const replay = rust.slice(rust.indexOf("pub fn replay_after_page_load"));
  const logStart = replay.indexOf('log::info!("');
  const logEnd = replay.indexOf('")', logStart);
  assert.ok(logStart > 0 && logEnd > logStart, "重发要留一行日志（不然真机上无从取证）");
  assert.doesNotMatch(replay.slice(logStart, logEnd), /document|\{/, "重发的日志不带文档本身（也不带格式化占位符）");
});

test("导入落地（R41a）：成功才动歌词；失败什么工具都不碰（失败的事实是歌词没变）", () => {
  // 成功：行 + 状态 + 一句带文件名与行数的回执
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
      return { config: DEFAULT_LYRICS_CONFIG, visible: true, revision: 1 };
    },
    subscribeCoreEvent: async (channel, handler) => {
      listeners.set(channel, handler);
      return () => listeners.delete(channel);
    },
    parseLyrics: overrides.parseLyrics,
    syncTheme: async () => { calls.push({ themeSynced: true }); },
  });
  return { bridge, calls, listeners };
}

test("主窗转发：四条命令各走各的命令名，回执经纯函数归一", async () => {
  const { bridge, calls } = stubBridge();
  await bridge.initialize();
  calls.length = 0;
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
  await assert.rejects(broken.readStatus(), (error) => error.kind === "invalid_response");
  assert.equal(broken.snapshot().visible, false);
  assert.deepEqual(broken.snapshot().config, DEFAULT_LYRICS_CONFIG);
});

test("桌面歌词就绪握手：只在订阅回执之后重发最新文档与暂停进度", async () => {
  const { bridge, calls, listeners } = stubBridge();
  let current = { lyrics: { status: "empty", lines: [] }, status: "paused", currentTimeMs: 7000, seekGeneration: 3 };
  const stop = await bridge.subscribeReady(() => current);
  const onReady = listeners.get(LYRICS_STATE);
  assert.equal(typeof stop, "function");
  calls.length = 0;
  await onReady({ visible: true, config: DEFAULT_LYRICS_CONFIG, revision: 1 });
  assert.equal(calls.length, 0, "配置变化不是订阅就绪，不重发");
  current = { ...current, lyrics: { status: "ready", lines: [{ startTime: 0, endTime: 8000, words: [] }] } };
  await onReady({ ready: true });
  assert.deepEqual(calls.slice(0, 3).map((call) => call.command), [CORE_LYRICS_CONFIGURE, CORE_LYRICS_DOCUMENT, CORE_LYRICS_PROGRESS]);
  assert.deepEqual(calls[1].args.document, current.lyrics);
  assert.deepEqual(calls[2].args.progress, { timeMs: 7000, playing: false, seekGeneration: 3 });
  assert.deepEqual(calls[3], { themeSynced: true });
  calls.length = 0;
  await onReady({ ready: true });
  assert.deepEqual(calls.slice(0, 3).map((call) => call.command), [CORE_LYRICS_CONFIGURE, CORE_LYRICS_DOCUMENT, CORE_LYRICS_PROGRESS]);
  stop(); bridge.dispose();
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
  await bridge.initialize();
  const handler = listeners.get("lyrics:toggle");
  assert.equal(typeof handler, "function");
  handler({ checked: true });
  await flushBridge();
  handler({ checked: false });
  await flushBridge();
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
  // 进度由播放器订阅推送（见 progress-pump.mjs），不再用 rAF。
  assert.match(hook, /createProgressPump\(/, "进度泵走播放器的订阅");
  assert.doesNotMatch(hook, /requestAnimationFrame/, "主窗不再排帧推进度");
  assert.match(hook, /lyrics-window\.mjs/, "判定来自纯逻辑模块");

  const page = read("src/renderer/pages.tsx");
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  /** 设置页「歌词」标签只留一张桌面歌词卡：外观控件都在弹出窗里，故断言页面只认模式词表、不认那些控件 id。 */
  assert.match(settings, /桌面歌词/, "设置页要有桌面歌词一节");
  assert.match(settings, /LYRICS_MODES/, "窗口位置选项来自纯逻辑模块（不另抄一份清单）");
  for (const gone of ["LYRICS_FONT_STEPS", "LYRICS_COLOR_TOKENS", "fontStepLabel", "colorTokenLabel", "coreLyricsSettingsOpen"]) {
    assert.equal(settings.includes(gone), false, `${gone} 只在弹出窗里用（设置页不再出现那些控件/入口）`);
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
    // 注入过独立歌词端点就直接打它（默认那条路是从播放响应推导）。
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
  // 独立歌词端点是 GET，参数在查询串里。
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

  // 端点未配置时返回结构化 endpoint_unknown；默认路径第一个缺的端点是 playback。
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

// 10. 歌词颜色 / 窗口尺寸 / 锁定交互 / 竖排 / 逐字

test("R45B 配置：customColor 只认 #RRGGBB（其余一律落回上一个合法值）", () => {
  assert.equal(DEFAULT_LYRICS_CONFIG.customColor, "", "默认不用自定义色（走设计令牌）");
  assert.equal(isCustomColor("#a1b2c3"), true);
  assert.equal(isCustomColor("#A1B2C3"), true, "大写 hex 同样合法");
  for (const bad of ["#fff", "fff", "#12345", "#1234567", "#12345g", "# a1b2c", "red", "rgb(0,0,0)", "", null, 42, {}, true]) {
    assert.equal(isCustomColor(bad), false, `不算合法 #RRGGBB：${JSON.stringify(bad)}`);
  }

  const base = { ...DEFAULT_LYRICS_CONFIG, customColor: "#102030" };
  assert.equal(normalizeLyricsConfig({ customColor: "#ff8800" }, base).customColor, "#ff8800", "合法值照收");
  for (const bad of ["#fff", "tomato", 123, null, {}, []]) {
    assert.equal(
      normalizeLyricsConfig({ customColor: bad }, base).customColor,
      "#102030",
      `坏值不许覆盖上一个合法值：${JSON.stringify(bad)}`,
    );
  }
  assert.equal(normalizeLyricsConfig({ customColor: "" }, base).customColor, "", "空串 = 恢复主题色");
  assert.deepEqual(normalizeLyricsConfig({}, base), base, "空补丁仍然是纯读");

  // 查询串初值（Rust 拼 %23 出来，URLSearchParams 解回 #）
  assert.equal(lyricsConfigFromSearch("?customColor=%23A1B2C3").customColor, "#A1B2C3");
  assert.equal(lyricsConfigFromSearch("?customColor=red").customColor, "", "认不出就落默认");
  assert.equal(lyricsConfigFromSearch("?customColor=").customColor, "");
});

test("R45B 配置：windowWidth/windowHeight 是 DIP 正整数或 null（0/负/字符串/Infinity 都不算）", () => {
  assert.equal(DEFAULT_LYRICS_CONFIG.windowWidth, null, "没拖过就是 null（不是 0）");
  assert.equal(DEFAULT_LYRICS_CONFIG.windowHeight, null);

  const sized = normalizeLyricsConfig({ windowWidth: 360, windowHeight: 480 });
  assert.equal(sized.windowWidth, 360);
  assert.equal(sized.windowHeight, 480);
  assert.equal(normalizeLyricsConfig({ windowWidth: 359.6 }).windowWidth, 360, "DIP 存整像素");

  const base = { ...DEFAULT_LYRICS_CONFIG, windowWidth: 320, windowHeight: 620 };
  for (const bad of [0, -10, "320", Number.NaN, Number.POSITIVE_INFINITY, {}, true, []]) {
    const next = normalizeLyricsConfig({ windowWidth: bad, windowHeight: bad }, base);
    assert.equal(next.windowWidth, 320, `windowWidth 坏值不覆盖：${String(bad)}`);
    assert.equal(next.windowHeight, 620, `windowHeight 坏值不覆盖：${String(bad)}`);
  }
  // null 是「没有自定义尺寸」这个**有意义**的值（Rust 换方向时就是用 null 清掉上一方向的尺寸）
  const cleared = normalizeLyricsConfig({ windowWidth: null, windowHeight: null }, base);
  assert.equal(cleared.windowWidth, null);
  assert.equal(cleared.windowHeight, null);
  assert.deepEqual(lyricsConfigFromSearch("?windowWidth=320&windowHeight=620"), { ...DEFAULT_LYRICS_CONFIG, windowWidth: 320, windowHeight: 620 });
  assert.deepEqual(lyricsConfigFromSearch("?windowWidth=&windowHeight=abc"), DEFAULT_LYRICS_CONFIG, "空/坏值落默认（null）");
});

test("R45B 纯逻辑：锁定隐藏全部控制、只有悬停/聚焦才给解锁；可缩放只在未锁的桌面窗", () => {
  const base = DEFAULT_LYRICS_CONFIG;
  assert.equal(resizableEnabled(base), true, "未锁的桌面窗可以拖拽缩放");
  assert.equal(resizableEnabled({ ...base, locked: true }), false, "锁定不可缩放");
  assert.equal(resizableEnabled({ ...base, mode: "taskbar" }), false, "任务栏那一条不可缩放");
});

test("R52 设置页文案克制：不再有解释性长段落，只有控件旁的一行状态", () => {
  const settings = read("src/renderer/pages.tsx").slice(read("src/renderer/pages.tsx").indexOf("export function SettingsPage("));
  const lyricsPane = settings.slice(settings.indexOf('<TabsContent value="lyrics"'), settings.indexOf("</TabsContent>", settings.indexOf('<TabsContent value="lyrics"')));
  assert.ok(lyricsPane.length > 100, "歌词页要能找到");
  // 卡片描述一句话；控件旁提示各一行、且没有长段落（>80 字的说明文字一律不许）
  const paragraphs = [...lyricsPane.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((found) => found[1].trim());
  assert.deepEqual(paragraphs, [], "歌词页里不许再有 <p> 说明段落");
  // 设置页不再有「外观设置」入口，锁定与点透也不是主窗设置项，这里已无旁注提示。
  for (const chatter of ["互不影响", "并非中文竖排", "重启后恢复", "推导", "敬请期待", "外观设置"]) {
    assert.equal(lyricsPane.includes(chatter), false, `解释性/画饼/外观入口文案不许回来：${chatter}`);
  }
});

test("R45B Rust 与渲染层同步：三个新字段进 payload/persisted/query，且校验拒绝坏值", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  for (const key of ["customColor", "windowWidth", "windowHeight"]) {
    assert.match(rust, new RegExp(`"${key}"`), `Rust 侧必须认识 ${key}`);
  }
  const payload = rust.slice(rust.indexOf("pub fn payload("), rust.indexOf("pub fn persisted("));
  const persisted = rust.slice(rust.indexOf("pub fn persisted("), rust.indexOf("pub fn restored("));
  const query = rust.slice(rust.indexOf("pub fn query("), rust.indexOf("pub fn ", rust.indexOf("pub fn query(") + 20));
  for (const [name, body] of [["payload", payload], ["persisted", persisted], ["query", query]]) {
    for (const key of ["customColor", "windowWidth", "windowHeight"]) {
      assert.match(body, new RegExp(key), `${name} 必须带上 ${key}`);
    }
  }
  // 校验：合法 hex/正数/null 收，坏值拒（拒掉 = 保留上一次合法值）
  const validate = rust.slice(rust.indexOf("pub fn validate_configure("), rust.indexOf("pub fn control_payload("));
  assert.match(validate, /"customColor"/, "validate 要认识 customColor");
  assert.match(validate, /"windowWidth"/, "validate 要认识 windowWidth");
  assert.match(validate, /"windowHeight"/, "validate 要认识 windowHeight");
  assert.match(validate, /is_null\(\)/, "窗口尺寸可以用 null 清空");
  assert.match(rust, /fn is_hex_color|fn custom_color_ok/, "合法 hex 的判定在 Rust 侧也要有一个真源函数");
  // 保留键数一致：DEFAULT_LYRICS_CONFIG 的每个字面键都在 persisted 里
  for (const key of Object.keys(DEFAULT_LYRICS_CONFIG)) {
    assert.match(persisted, new RegExp(`"${key}"`), `落盘合同必须包含 ${key}`);
  }
});

test("R45B 歌词窗：Lock 图标表示已锁、悬停只留解锁、缩放拖柄只给未锁桌面、颜色与逐字走纯函数/适配层", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  const code = stripComments(source);

  // 锁定语义：locked ⇒ Lock（不是 Unlock）；动作名说清当前状态
  assert.match(code, /config\.locked\s*\?\s*<Lock\b/, "locked 时主图标必须是 Lock（此前是反的）");
  assert.match(code, /:\s*<Unlock\b/, "未锁时给 Unlock（表示可以锁）");
  assert.match(code, /已锁定/, "无障碍名称要说清「已锁定」");
  assert.match(code, /aria-pressed=\{config\.locked\}/, "锁定是按压态开关");
  // 悬停只给解锁：group + group-hover/focus-within 的显隐
  assert.match(code, /group\/locked|className="group/, "锁定时要有一个 hover 容器");
  assert.match(code, /group-hover(?:\/locked)?:opacity-100/, "悬停才显示解锁按钮");
  assert.match(code, /group-focus-within(?:\/locked)?:opacity-100|focus-within:opacity-100/, "键盘聚焦同样能看见解锁按钮");
  // 锁定后隐藏：拖动柄、媒体、外观、缩放柄都在「未锁」那一支里
  assert.match(code, /config\.locked \? lockedControls :/, "锁定态只渲染解锁槽，完整控制在另一支");
  // 缩放：官方 startResizeDragging + GripDiagonal，且只在 resizableEnabled 时渲染
  assert.match(code, /resizableEnabled\(/, "缩放资格来自纯逻辑模块（不在这里另写判定）");
  assert.match(code, /canResize \?/, "缩放拖柄按资格挂载（锁定/任务栏连按钮都不存在）");
  assert.match(code, /startResizeDragging\("SouthEast"\)/, "缩放拖柄调用官方 startResizeDragging");
  assert.match(code, /MoveDiagonal2/, "右下角用 Lucide 的 MoveDiagonal2（brief 点名的 GripDiagonal 在本仓钉住的 lucide-react 0.468.0 里不存在，且不许加依赖）");
  // 自定义颜色：经适配层的 scoped 变量覆盖，不在组件里拼 CSS 文本
  assert.match(code, /applyCustomColor/, "自定义颜色经 amll-adapter 的 scoped 变量覆盖");
  assert.doesNotMatch(code, /--amll-/, "AMLL 变量的接线点仍然只有 css 与适配层");
  assert.doesNotMatch(code, /style=\{\{/, "不许内联视觉样式");
  assert.doesNotMatch(code, /cssText|setAttribute\("style"/, "不许注入 CSS 文本");
  // 逐字：行级推导由适配层的纯函数做，组件只消费
  assert.match(code, /withKaraokeWords/, "逐字高亮来自 amll-adapter 的纯函数");
  assert.doesNotMatch(code, /\.words\b|words\.map/, "组件仍不自己渲染歌词文本");
  // 窗口尺寸：resize 稳定 250ms 后保存 DIP
  assert.match(code, /addEventListener\("resize"/, "窗尺寸变化要监听");
  assert.match(source, /250/, "稳定 250ms 才保存（拖动过程中不许刷配置）");
});

test("R61 竖版改自渲染：只有桌面竖版走 VerticalLyricColumn，横版与任务栏仍是官方 LyricPlayer", () => {
  /** 竖版改由独立组件 VerticalLyricColumn 渲染，这里只钉接线契约；行为在 vertical-lyrics.test.mjs 与浏览器守卫里。 */
  const code = stripComments(read("src/renderer/LyricsWindow.tsx"));
  assert.match(code, /import \{ VerticalLyricColumn \} from "\.\/VerticalLyricColumn\.tsx"/, "竖版组件从独立文件导入");
  assert.match(code, /const vertical = config\.mode === "desktop" && config\.layout === "vertical"/,
    "竖版只对桌面模式生效（任务栏由 Rust 强制 horizontal）");
  assert.match(code, /hasLyric && vertical \? <VerticalLyricColumn/, "竖版挂自渲染的单列");
  assert.match(code, /hasLyric && !vertical \? <LyricPlayer/, "横版继续用官方组件（渲染路径没动）");
  assert.doesNotMatch(code, /lyricScrollbarHit/, "竖版不再有原生滚动条，那条拖动豁免跟着删");

  const css = stripComments(read("src/renderer/amll-theme.css"));
  assert.doesNotMatch(css, /data-lyrics-layout="vertical"/, "AMLL 主题里不再有竖版补丁规则");
  assert.match(read("src/renderer/lyrics-main.tsx"), /import "\.\/vertical-lyrics\.css"/, "歌词窗入口引入竖版样式表");
});


/** 设置页没有任何颜色控件：沉浸式歌词禁止改色，桌面歌词颜色只在弹出窗里改（反向钉子）。 */
test("R52 设置页没有颜色控件（沉浸页禁止改色，桌面歌词颜色只在弹出窗里改）", () => {
  const page = read("src/renderer/pages.tsx");
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  // 任务栏歌词颜色在 taskbar-lyrics-card.tsx 里，设置页文件本身仍不许出现桌面歌词那套颜色控件。
  for (const gone of ['type="color"', "恢复主题色", "customColor", "isCustomColor"]) {
    assert.equal(settings.includes(gone), false, `设置页不许再有 ${gone}`);
  }
  assert.equal(/0-9a-fA-F\]\{6\}|\[0-9a-f\]\{6\}/.test(settings), false, "也不许自己抄 hex 正则（本来就不该有）");

  // 颜色控件仍在弹出窗里（删除的是"设置页那一份"，不是能力本身）
  const popup = read("src/renderer/LyricsSettingsPopup.tsx");
  assert.match(popup, /type="color"/, "桌面歌词的取色器在弹出窗里");
  assert.match(popup, /恢复主题色/, "一键回主题色也在那里");
  assert.match(popup, /isCustomColor/, "合法 hex 判定仍来自纯逻辑模块");
});

/** 桌面歌词的设置面搬到独立小窗 LyricsSettingsPopup：歌词窗里没有菜单内容，齿轮把锚点矩形交给宿主。 */
test("R51 歌词窗只剩齿轮：不再内嵌菜单内容，点它把锚点交给弹出窗", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  const code = stripComments(source);

  // 内嵌菜单整段删掉：旧实现不许留一半。
  assert.doesNotMatch(code, /components\/ui\/dropdown-menu/, "歌词窗不再引下拉菜单原语");
  assert.doesNotMatch(code, /<DropdownMenu/, "歌词窗里不再有 DropdownMenu");
  assert.doesNotMatch(code, /DropdownMenuContent|DropdownMenuRadioGroup|lyrics-style-clean|lyrics-appearance-color/, "菜单内容整段搬走");
  assert.doesNotMatch(code, /components\/ui\/sheet|<Sheet\b|ScrollArea/, "Sheet/ScrollArea 两条旧路都不许回来");
  assert.doesNotMatch(code, /overflow-[xy]-(?:auto|scroll)/, "不许在这里自搭滚动容器（面板的规矩见 no-self-visual）");

  // 齿轮：普通按钮 + 打开命令 + 按钮自己的矩形当锚点
  assert.match(code, /aria-label="桌面歌词外观"/, "触发按钮的无障碍名称不变");
  assert.match(code, /data-testid="lyrics-appearance"/, "测试锚点保留（浏览器守卫按它点）");
  assert.match(code, /coreLyricsSettingsOpen\(/, "齿轮走弹出窗的打开命令");
  assert.match(code, /getBoundingClientRect\(\)/, "锚点取按钮自己的矩形（简报指定的口径）");
  assert.match(code, /x: rect\.x, y: rect\.y, width: rect\.width, height: rect\.height/, "锚点是客户区 CSS 像素 {x,y,width,height}");
  assert.match(code, /onClick=\{openAppearance\}/, "点击才发命令（不是挂在渲染上）");
  assert.doesNotMatch(code, /\.hide\(\)|\.close\(\)|setSize|setPosition/,
    "歌词窗不摆弹出窗（尺寸/位置/关闭全归宿主；拖动与缩放那两条官方调用不在此列）");
});

/** 默认尺寸收紧成紧凑一档（横版 800×128、竖版 240×600），最小 / 任务栏 / 自定义尺寸不变。 */
test("R51 默认尺寸紧凑：Rust 常量与几何入口都换了，最小/任务栏/自定义尺寸不动", () => {
  const rust = rustProduction(rustSource("lyrics_window.rs"));
  assert.match(rust, /pub const DESKTOP_SIZE: Size = Size \{\s*width: 800\.0,\s*height: 128\.0,/, "横版默认 800×128");
  assert.match(rust, /pub const DESKTOP_VERTICAL_SIZE: Size = Size \{\s*width: 240\.0,\s*height: 600\.0,/, "竖版默认 240×600");
  assert.match(rust, /width: 1200\.0,\s*height: 44\.0/, "任务栏尺寸不变");
  assert.match(rust, /MIN_WINDOW_WIDTH_DIP: f64 = 240\.0/, "最小宽度不变");
  assert.match(rust, /MIN_WINDOW_HEIGHT_DIP: f64 = 120\.0/, "最小高度不变");
  const geometry = rust.slice(rust.indexOf("pub fn geometry_plan"), rust.indexOf("pub fn apply_window_effects"));
  assert.match(geometry, /DESKTOP_VERTICAL_SIZE/, "竖版默认值只有一处真源（几何入口引用常量，不写第二份数字）");
  assert.doesNotMatch(geometry, /width: 320\.0/, "旧的 320×620 已删");
});

/** 桌面 clean 模式的可读性衬底：根节点挂令牌 bg-background/60 + data-lyrics-scrim，panel 与任务栏不加。 */
test("R50 clean+desktop 的令牌衬底：bg-background/60 + data-lyrics-scrim，panel/任务栏不加", () => {
  const code = stripComments(read("src/renderer/LyricsWindow.tsx"));
  assert.match(code, /data-lyrics-scrim=/, "根节点要有衬底锚点（守卫按它判有没有衬底）");
  assert.match(code, /bg-background\/60/, "衬底用设计令牌（不写裸色值）");
  assert.match(code, /const backdrop = lyricsBackdrop\(config\)/, "衬底深浅交给纯逻辑的 lyricsBackdrop");
  assert.match(code, /config\.style === "clean" && backdrop !== "none"/,
    "只有 clean 且不是纯透明才加衬底（面板已有 Card 背景；任务栏要透出系统栏）");
  assert.match(code, /bg-background\/35/, "锁定后衬底更淡（同一条令牌的另一档透明度）");
  assert.match(code, /cn\(/, "条件类名走 cn（不拼字符串）");
  assert.doesNotMatch(code, /bg-black|bg-white|#[0-9a-fA-F]{3,8}\b/, "不写裸色值");
  // 衬底挂在既有根节点上：不另起一层 div（否则控件条与歌词区一定会漏掉一处）
  const rootAt = code.indexOf("<div\n      ref={stageRef}");
  const rootTag = rootAt === -1 ? "" : code.slice(rootAt, code.indexOf(">", rootAt) + 1);
  assert.match(rootTag, /data-lyrics-scrim=/, "衬底锚点就在根节点上（不另起一层 div）");
  assert.match(rootTag, /data-lyrics-backdrop=\{backdrop\}/, "衬底深浅也挂在根节点上，守卫按它判档");
  assert.match(rootTag, /data-testid="lyrics-window"/, "就是那个既有的根节点");
});

// 7. 任务栏歌词的独立设置（颜色 / 逐字高亮 / 字号）

const TASKBAR_CARD = "src/renderer/taskbar-lyrics-card.tsx";

/** 歌词窗按模式读外观：任务栏只读那四个字段，桌面读原字段；逐字关闭时行不经 withKaraokeWords 推导。 */
test("R59 歌词窗：外观按模式分流，逐字关闭时不经 withKaraokeWords", () => {
  const source = read("src/renderer/LyricsWindow.tsx");
  const code = stripComments(source);

  assert.match(code, /lyricsAppearance\(/, "外观来自纯逻辑模块 lyricsAppearance（组件里不写第二份判定）");
  assert.match(code, /appearance\.karaoke/, "逐字开关来自它");
  assert.match(code, /appearance\.color/, "颜色来自它");
  assert.match(code, /appearance\.customColor/, "自定义颜色来自它");
  assert.match(code, /data-lyrics-karaoke=/, "逐字开关要有 data 锚点（守卫按它判）");
  // 逐字关闭 = 不推导，但仍交给官方组件
  assert.match(code, /appearance\.karaoke\s*\?\s*withKaraokeWords\(/, "开着才推导逐字词");
  assert.match(code, /useMemo\([\s\S]{0,200}withKaraokeWords/, "推导结果仍进 useMemo（不每帧重算）");
  assert.match(code, /<LyricPlayer/, "两种模式都仍由官方 LyricPlayer 渲染");
  assert.doesNotMatch(code, /data-lyrics-(?:size|color)=\{config\.(?:size|color|customColor)/,
    "外观值不再直读桌面字段（必须经 appearance；`config.style` 不是外观色/字号的来源）");
});

test("R59 设置页「任务栏歌词（Beta）」卡：令牌 Select + 自定义色 + 恢复主题色 + 逐字开关 + 字号", () => {
  const card = read(TASKBAR_CARD);
  const code = stripComments(card);

  // 只挂在设置页的歌词标签里，且是独立组件。
  const pages = read("src/renderer/pages.tsx");
  assert.match(pages, /import \{ TaskbarLyricsCard \} from "\.\/taskbar-lyrics-card\.tsx"/, "卡片是独立组件");
  const pane = pages.slice(pages.indexOf('<TabsContent value="lyrics"'), pages.indexOf("</TabsContent>", pages.indexOf('<TabsContent value="lyrics"')));
  assert.match(pane, /<TaskbarLyricsCard lyrics=\{lyrics\} \/>/, "挂在「歌词」标签页里");

  // 控件：颜色（令牌 Select + 自定义色 + 恢复主题色）、逐字开关、字号 Select
  for (const id of ["taskbar-lyrics-color", "taskbar-lyrics-size", "taskbar-lyrics-karaoke",
    "taskbar-lyrics-custom-color", "taskbar-lyrics-color-reset"]) {
    assert.ok(card.includes(`id="${id}"`) || card.includes(`data-testid="${id}"`), `卡片要有 #${id}`);
  }
  for (const component of ["Card", "CardHeader", "CardTitle", "CardContent", "Select", "SelectTrigger", "SelectItem", "Switch", "Button", "Label", "Input"]) {
    assert.ok(card.includes(component), `只用仓里已有的 shadcn/ui 组件：缺 ${component}`);
  }
  assert.match(code, /LYRICS_COLOR_TOKENS\.map/, "颜色令牌来自纯逻辑模块的唯一真源");
  assert.match(code, /TASKBAR_FONT_STEPS\.map/, "任务栏字号档位来自纯逻辑模块");
  assert.match(code, /colorTokenLabel\(/, "令牌文案来自纯逻辑模块（不在这里另写一份中文）");
  assert.match(code, /taskbarFontStepLabel\(/, "档位文案同理");
  assert.match(code, /isCustomColor/, "合法 hex 判定仍来自纯逻辑模块");
  assert.match(code, /type="color"/, "自定义色沿用桌面歌词的取色器做法");
  assert.match(code, /恢复主题色/, "一键回设计令牌");
  assert.doesNotMatch(code, /style=\{\{/, "不许内联视觉样式");
  assert.doesNotMatch(code, /<p\b/, "不写说明性段落（一行提示足够）");

  // 写入：只发 taskbar* 四个键，且走既有窄命令（壳层绑定）
  assert.match(code, /updateConfig\(\{ taskbarColor/, "令牌 Select 写 taskbarColor");
  assert.match(code, /updateConfig\(\{ taskbarSize/, "字号 Select 写 taskbarSize");
  assert.match(code, /updateConfig\(\{ taskbarKaraoke/, "逐字 Switch 写 taskbarKaraoke");
  assert.match(code, /updateConfig\(\{ taskbarCustomColor/, "取色器与恢复按钮写 taskbarCustomColor");
  for (const desktopKey of ["customColor:", "size:", "color:", "locked:", "mode:"]) {
    assert.equal(code.includes(`{ ${desktopKey}`), false, `任务栏卡不许写桌面字段：${desktopKey}`);
  }

  // 只在 Windows 显示：走既有能力查询（不得在 UI 里硬编码平台判断）
  assert.match(code, /taskbar\?\.supported/, "能力来自宿主回报的 taskbar.supported");
  for (const hardcoded of ["navigator.platform", "navigator.userAgent", 'navigator.userAgentData', "win32", "Windows NT"]) {
    assert.equal(code.includes(hardcoded), false, `不许在 UI 里硬编码平台判断：${hardcoded}`);
  }
});

test("R59 桌面歌词设置面板不含任务栏字段（两套配置各有各的入口）", () => {
  const popup = read("src/renderer/LyricsSettingsPopup.tsx");
  // 弹出窗认识 `mode === "taskbar"`（竖版在任务栏下禁用），但**不认识**任务栏那四个外观字段
  for (const field of ["taskbarSize", "taskbarColor", "taskbarCustomColor", "taskbarKaraoke"]) {
    assert.equal(popup.includes(field), false, `桌面歌词的齿轮菜单不许出现 ${field}`);
  }
  const card = read(TASKBAR_CARD);
  assert.equal(card.includes("coreLyricsSettingsOpen"), false, "任务栏卡不去开桌面歌词的弹出窗");
  assert.equal(card.includes("coreLyricsConfigure"), false, "卡片不直接发命令（写入经壳层绑定）");
});

test("歌词显示目标：目标词表与开关计划只看模式与开关，开着换模式不重复开窗", () => {
  assert.deepEqual(LYRICS_TARGETS, ["off", "desktop", "taskbar"], "三个目标就是关闭/桌面/任务栏");
  assert.equal(lyricsTargetOf(false, "taskbar"), "off", "没开就是关闭");
  assert.equal(lyricsTargetOf(true, "taskbar"), "taskbar", "开着且模式是任务栏");
  assert.equal(lyricsTargetOf(true, "desktop"), "desktop", "开着且模式是桌面");
  assert.equal(lyricsTargetOf(true, undefined), "desktop", "模式缺失按桌面算");
  assert.deepEqual(lyricsTargetPlan(false, "desktop", "desktop"), { mode: null, visible: true }, "关着选桌面：只开窗");
  assert.deepEqual(lyricsTargetPlan(false, "desktop", "taskbar"), { mode: "taskbar", visible: true }, "关着选任务栏：先改模式再开窗");
  assert.deepEqual(lyricsTargetPlan(true, "desktop", "taskbar"), { mode: "taskbar", visible: null }, "开着换任务栏：只改模式，不重复开窗");
  assert.deepEqual(lyricsTargetPlan(true, "taskbar", "taskbar"), { mode: null, visible: null }, "已经在这个目标上：什么都不发");
  assert.deepEqual(lyricsTargetPlan(true, "taskbar", "off"), { mode: null, visible: false }, "开着选关闭：只关窗");
  assert.deepEqual(lyricsTargetPlan(false, "desktop", "off"), { mode: null, visible: null }, "本来就关着再选关闭：什么都不发");
  assert.deepEqual(lyricsTargetPlan(true, "desktop", "bogus"), { mode: null, visible: null }, "认不出的目标不猜");
});

test("歌词显示目标：两处快捷菜单 + 设置面板的位置切换 + binding 的 selectTarget 都在", () => {
  const components = read("src/renderer/components.tsx");
  assert.match(components, /export function LyricsTargetMenu/, "播放栏与沉浸页共用同一个菜单组件");
  assert.match(components, /data-testid="player-lyrics-target"/, "播放栏有那枚小下拉按钮");
  const stage = read("src/renderer/playback-stage.tsx");
  assert.match(stage, /LyricsTargetMenu/, "沉浸页用同一个菜单");
  assert.match(stage, /data-testid="stage-lyrics-target"/, "沉浸页有那枚小下拉按钮");
  const popup = read("src/renderer/LyricsSettingsPopup.tsx");
  assert.match(popup, /data-testid="lyrics-target-taskbar"/, "设置面板有位置切换");
  assert.match(popup, /disabled=\{!taskbarSupported\}/, "平台不支持时任务栏那一项禁用");
  assert.match(read("src/renderer/use-lyrics-window.ts"), /selectTarget/, "binding 直接给出 selectTarget");
});
