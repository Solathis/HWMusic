/**
 * 主窗配置代理：只订阅/转发 Rust 的运行状态与权威配置，不再自己写 settings。
 *
 * 配置落盘由 Rust 的保存任务负责，与 WebView 是否还活着无关；这一层只剩订阅广播、发窄命令、把权威状态投影给界面。
 */
import { LYRICS_STATE, LYRICS_TOGGLE } from "../../../shared/channels.ts";
import {
  CORE_LYRICS_CONFIGURE,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_TOGGLE,
} from "../../../shared/commands.ts";
import { LYRICS_CACHE_CLEAR, LYRICS_CACHE_INFO, LYRICS_IMPORT, PLAYBACK_LYRICS } from "../../../shared/request-channels.ts";
import {
  coreLyricsConfigure,
  coreLyricsDocument,
  coreLyricsProgress,
  coreLyricsToggle,
  coreCall,
  onCoreEvent,
  syncLyricsTheme,
} from "../../host-api.ts";
import { parseAmllLyrics } from "./amll-adapter.ts";
import { readLyricsFile } from "./lyrics-import.mjs";
import {
  LYRICS_STATUS,
  lyricsDocumentOf,
  lyricsStatusFromFailure,
  normalizeLyricsConfig,
  progressOf,
  saveErrorText,
  shouldPushProgress,
} from "./lyrics-window.mjs";

/** 指令面的默认实现：命令名 → host-api 的具名封装（命令名字面量只在共享常量里）。 */
async function defaultCallCommand(command, args) {
  const payload = args !== null && typeof args === "object" ? args : {};
  switch (command) {
    case CORE_LYRICS_TOGGLE:
      return coreLyricsToggle(payload.checked === true);
    case CORE_LYRICS_CONFIGURE:
      return coreLyricsConfigure(payload.config ?? {}, payload.retrySave === true ? true : undefined);
    case CORE_LYRICS_DOCUMENT:
      return coreLyricsDocument(payload.document ?? {});
    case CORE_LYRICS_PROGRESS:
      return coreLyricsProgress(payload.progress ?? {});
    default:
      // 认不出的命令不猜（抛结构化错误：调用方会记一行，用户侧不会看到假的成功）
      throw { kind: "internal", message: `认不出的歌词窗命令：${String(command)}` };
  }
}

/**
 * 曲目元信息 → `playback:lyrics` 的载荷字段：只用于第三方回退的严格匹配，认不出就不带（不编默认值）。
 */
function metadataPayload(query) {
  const payload = {};
  if (typeof query.title === "string" && query.title.trim() !== "") payload.title = query.title.trim();
  if (typeof query.artist === "string" && query.artist.trim() !== "") payload.artist = query.artist.trim();
  const duration = Number(query.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) payload.durationSeconds = duration;
  return payload;
}

/** 失败 → 一句人话：core 的错误消息本来就是给用户看的（带原因与下一步），有就用它。 */
function failureText(error) {
  const message = error !== null && typeof error === "object" ? error.message : null;
  if (typeof message === "string" && message.trim() !== "") return message;
  return "导入失败（详情见运行日志）。";
}

/** 进度载荷归一（字段名只在这里拼一次）。 */
function normalizeProgress(progress) {
  const source = progress !== null && typeof progress === "object" ? progress : {};
  const timeMs = Number(source.timeMs);
  return {
    timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
    playing: source.playing === true,
    seekGeneration: Number.isInteger(source.seekGeneration) ? source.seekGeneration : 0,
  };
}

/**
 * 造歌词窗桥。
 *
 * @param {object} [deps] 端口注入（测试用桩）
 * @param {(channel: string, payload?: unknown) => Promise<unknown>} [deps.callCore]
 * @param {(command: string, args?: unknown) => Promise<unknown>} [deps.callCommand]
 * @param {(channel: string, handler: (payload: unknown) => void) => Promise<() => void>} [deps.subscribeCoreEvent]
 * @param {(text: unknown) => {lines?: unknown[]}} [deps.parseLyrics] 官方解析适配（默认 amll-adapter）
 * @param {() => Promise<void>} [deps.syncTheme] 主窗读真实主题并广播，不写配置
 */
export function createLyricsBridge(deps = {}) {
  const callCore = deps.callCore ?? ((channel, payload) => coreCall(channel, payload));
  const callCommand = deps.callCommand ?? defaultCallCommand;
  const subscribeCoreEvent = deps.subscribeCoreEvent ?? onCoreEvent;
  const parseLyrics = deps.parseLyrics ?? ((text) => parseAmllLyrics(text));
  const syncTheme = deps.syncTheme ?? syncLyricsTheme;
  const log = deps.log ?? ((...parts) => console.warn("[hwmusic-lyrics]", ...parts));

  /** 上一次**推出去**的进度：节流的比较基准（没推的那个不算，否则永远差 20ms）。 */
  let lastProgress = null;

  let status = { config: normalizeLyricsConfig({}), visible: false, requestedVisible: false, taskbar: { supported: false, attached: false, reason: "disabled" }, revision: -1, runtimeRevision: -1, dirty: false, saveError: null, saveErrorCode: null, initialized: false };
  let initialization = null;
  let generation = 0;
  let readyReader = null;
  const observers = new Map();
  const stops = [];
  const notify = () => { for (const handler of observers.keys()) handler(status); };
  const publish = (patch) => { status = { ...status, ...patch }; notify(); };

  function acceptStatus(answer) {
    if (answer?.ready === true || !answer?.config || !Number.isSafeInteger(answer.revision) || answer.revision < status.revision) return status;
    const runtimeRevision = Number.isSafeInteger(answer.runtimeRevision) ? answer.runtimeRevision : -1;
    if (runtimeRevision < (status.runtimeRevision ?? -1)) return status;
    const config = normalizeLyricsConfig(answer.config);
    const saveErrorCode = typeof answer.saveError === "string" && answer.saveError !== "" ? answer.saveError : null;
    publish({
      config,
      visible: answer.visible === true,
      requestedVisible: answer.requestedVisible === true || (answer.requestedVisible === undefined && answer.visible === true),
      taskbar: answer.taskbar ?? status.taskbar,
      revision: answer.revision,
      runtimeRevision,
      // 持久化状态由 Rust 报告（脏/失败都不藏在渲染层里），失败代码在这一层翻成人话。
      dirty: answer.dirty === true,
      saveErrorCode,
      saveError: saveErrorText(saveErrorCode),
    });
    return status;
  }

  /** 重试保存：**窄命令**（空 config + retrySave），落盘由 Rust 的保存任务执行。 */
  async function retrySave() {
    await initialize();
    if (status.saveErrorCode === null) return status;
    return statusCommand(CORE_LYRICS_CONFIGURE, { config: {}, retrySave: true });
  }

  function initialize() {
    if (initialization) return initialization;
    const mine = generation;
    const keep = (off) => { if (mine === generation) stops.push(off); else off(); };
    initialization = (async () => {
      await Promise.all([
        subscribeCoreEvent(LYRICS_STATE, (payload) => {
          if (mine !== generation) return;
          if (payload?.ready === true) return replayReady();
          acceptStatus(payload);
        }).then(keep),
        subscribeCoreEvent(LYRICS_TOGGLE, (payload) => {
          if (mine === generation) void setVisible(payload?.checked === true).catch((cause) => log("桌面歌词开关失败：", cause));
        }).then(keep),
      ]);
      if (mine !== generation) return status;
      // 启动配置由 Rust 只读恢复（`LyricsWindowState::restore`），这里只**读回权威状态**：
      // 不再 bootstrap 写盘，也就没有"渲染层拿旧盘覆盖运行值"这条缝。
      const current = await callCommand(CORE_LYRICS_CONFIGURE, { config: {} });
      if (mine !== generation) return status;
      if (!current?.config || !Number.isSafeInteger(current.revision) || current.revision < 0) {
        throw { kind: "invalid_response", message: "歌词配置缺少权威 revision" };
      }
      acceptStatus(current);
      publish({ initialized: true });
      return status;
    })().catch((cause) => {
      if (mine === generation) {
        publish({ saveError: "桌面歌词配置未能恢复（Rust 回执缺少权威 revision），本次运行按默认配置显示。请稍后重试。", saveErrorCode: "state_unreadable" });
        generation += 1;
        for (const stop of stops.splice(0)) stop();
        initialization = null;
      }
      throw cause;
    });
    return initialization;
  }

  function observe(handler, readState) {
    observers.set(handler, readState);
    handler(status);
    void initialize().catch((cause) => log("歌词配置初始化失败：", cause));
    return () => {
      observers.delete(handler);
      queueMicrotask(() => { if (observers.size === 0 && !readyReader) dispose(); });
    };
  }

  async function statusCommand(command, args) {
    const mine = generation;
    await initialize();
    if (mine !== generation) return status;
    const answer = await callCommand(command, args);
    return mine === generation ? acceptStatus(answer) : status;
  }

  function readStatus() {
    return statusCommand(CORE_LYRICS_CONFIGURE, { config: {} });
  }

  function setVisible(checked) {
    return statusCommand(CORE_LYRICS_TOGGLE, { checked: checked === true });
  }

  function applyConfig(patch) {
    return statusCommand(CORE_LYRICS_CONFIGURE, { config: patch ?? {} });
  }

  function dispose() {
    generation += 1;
    for (const stop of stops.splice(0)) stop();
    observers.clear();
    initialization = null;
    readyReader = null;
  }

  /**
   * 取歌词文本并解析（唯一入口）：`playback:lyrics` → 官方 `parseLrc` 适配。
   *
   * 失败分类如实分开：端点没配说尚未配置，别的失败说暂时取不到。
   *
   * 入参可带曲目元信息（`title` / `artist` / `durationSeconds`），只用于第三方回退的严格匹配：缺了那一跳就不发生，所以只传确实有的值。
   */
  async function loadLyrics(target) {
    const query = target !== null && typeof target === "object" ? target : { trackId: target };
    const id = typeof query.trackId === "string" ? query.trackId.trim() : "";
    if (id === "") return { status: LYRICS_STATUS.unavailable, lines: [], source: null };

    const payload = { trackId: id, ...metadataPayload(query) };
    let answer;
    try {
      answer = await callCore(PLAYBACK_LYRICS, payload);
    } catch (error) {
      return { status: lyricsStatusFromFailure(error), lines: [], source: null };
    }
    const record = answer !== null && typeof answer === "object" ? answer : {};
    const text = typeof record.text === "string" ? record.text : "";
    const parsed = parseLyrics(text);
    const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
    return {
      status: lines.length > 0 ? LYRICS_STATUS.ready : LYRICS_STATUS.empty,
      lines,
      // 来源只作说明（界面与日志用）：认不出就是 null，不编一个"未知来源"出来
      source: typeof record.source === "string" && record.source !== "" ? record.source : null,
    };
  }

  /**
   * 导入本地歌词文件：解码与能否解析出歌词行都在 `lyrics-import.mjs` 判，通过了才把文本交给 core 落盘。
   *
   * 返回值与 `loadLyrics` 同形：导入成功即这一首的歌词立刻生效，调用方不必再取一次词。
   */
  async function importLyrics({ trackId, file } = {}) {
    const id = typeof trackId === "string" ? trackId.trim() : "";
    if (id === "") {
      return { status: LYRICS_STATUS.unavailable, lines: [], source: null, message: "没有正在播放的曲目：先播一首，再导入歌词。" };
    }
    const read = await readLyricsFile(file, { parseLines: (text) => parseLyrics(text)?.lines?.length ?? 0 });
    if (read.ok !== true) {
      return { status: LYRICS_STATUS.failed, lines: [], source: null, message: read.error.message };
    }

    let answer;
    try {
      answer = await callCore(LYRICS_IMPORT, { trackId: id, text: read.data.text, fileName: read.data.fileName });
    } catch (error) {
      return { status: lyricsStatusFromFailure(error), lines: [], source: null, message: failureText(error) };
    }
    // 落盘成功的回执就是"这一份现在生效"：用它确认（`source` 一定是 local），再本地解析一次
    const accepted = answer !== null && typeof answer === "object" && answer.source === "local";
    const parsed = parseLyrics(read.data.text);
    const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
    return {
      status: lines.length > 0 ? LYRICS_STATUS.ready : LYRICS_STATUS.empty,
      lines,
      source: "local",
      message: null,
      accepted,
      fileName: read.data.fileName,
      lineCount: read.data.lineCount,
    };
  }

  /** 读两处磁盘占用（`lyrics:cache-info`）——设置页那张卡用它。 */
  async function readCacheInfo() {
    return callCore(LYRICS_CACHE_INFO, null);
  }

  /** 清缓存（`lyrics:cache-clear`）；`local: true` 才连本地导入一起删。 */
  async function clearCache(options = {}) {
    return callCore(LYRICS_CACHE_CLEAR, { local: options.local === true });
  }

  /** 把歌词文档转发给歌词窗（主窗面板与歌词窗共用同一份行数组）。 */
  async function pushDocument(document) {
    const source = document !== null && typeof document === "object" ? document : {};
    await callCommand(CORE_LYRICS_DOCUMENT, { document: lyricsDocumentOf(source.lines, source.status) });
  }

  /** 推进度（播放器每次通知都可能调；不该推的直接丢掉，不出 IPC）。 */
  async function pushProgress(progress) {
    const next = normalizeProgress(progress);
    if (!shouldPushProgress(lastProgress, next)) return { pushed: false };
    lastProgress = next;
    try {
      await callCommand(CORE_LYRICS_PROGRESS, { progress: next });
      return { pushed: true };
    } catch (cause) {
      // 进度是"下一帧还会再来"的东西：失败不打扰用户，只留一行痕（宿主命令失败时的用户提示
      // 由开关那条路负责——那才是用户按下去等结果的动作）。
      log("进度没能推给歌词窗（下一帧继续试）：", cause);
      return { pushed: false };
    }
  }

  async function replayReady() {
    const mine = generation;
    try {
      await readStatus();
      if (mine !== generation) return;
      const reader = [...observers.values()].at(-1) ?? readyReader;
      if (reader) {
        const state = reader();
        await pushDocument(state.lyrics);
        lastProgress = null;
        await pushProgress(progressOf(state));
      }
      await syncTheme();
    } catch (cause) {
      log("歌词窗就绪后同步失败：", cause);
    }
  }

  async function subscribeReady(readState) {
    readyReader = readState;
    await initialize();
    return () => { if (readyReader === readState) readyReader = null; };
  }

  return {
    initialize,
    snapshot: () => status,
    observe,
    dispose,
    retrySave,
    readStatus,
    setVisible,
    applyConfig,
    subscribeReady,
    loadLyrics,
    importLyrics,
    readCacheInfo,
    clearCache,
    pushDocument,
    pushProgress,
  };
}

/** 单例：广播订阅是"系统级资源"，多份会互相打架（同 player-runtime 的理由）。 */
let bridge = null;

export function getLyricsBridge() {
  if (bridge === null) bridge = createLyricsBridge();
  return bridge;
}

if (import.meta.hot) import.meta.hot.dispose(() => { bridge?.dispose(); bridge = null; });
