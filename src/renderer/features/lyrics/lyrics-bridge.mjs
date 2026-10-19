/**
 * 桌面歌词窗的**主窗侧接线**（R12）：四条命令的转发 + 歌词文本链路 + 进度节流。
 *
 * 为什么单独一个模块（而不是全塞进 `use-lyrics-window.ts`）：这里每一件事都能用注入桩跑完
 * ——"托盘勾上去了，主窗到底发了哪条命令""歌词文本取回来有没有过官方解析器""rAF 每帧调它，
 * 是不是每帧都出 IPC"。放进 React hook 里这些就只能靠人眼。
 *
 * 端口全部注入（同 `player-runtime.ts` 的做法）：`callCore`（请求频道）、`callCommand`
 * （四条命令）、`subscribeCoreEvent`（广播订阅）、`parseLyrics`（官方解析适配）。
 *
 * 边界（与简报一致）：
 * - 歌词窗**没有**业务频道权限，四条命令全在主窗侧调用；歌词窗只订阅事件；
 * - 进度节流在这里（`shouldPushProgress`）：rAF 每帧都调 `pushProgress`，只有该推的才出 IPC；
 * - 歌词文本只在**这一次**调用里出现：不写日志、不落盘（与播放地址同一条纪律）。
 */
import { LYRICS_TOGGLE } from "../../../shared/channels.ts";
import {
  CORE_LYRICS_CONFIGURE,
  CORE_LYRICS_DOCUMENT,
  CORE_LYRICS_PROGRESS,
  CORE_LYRICS_TOGGLE,
} from "../../../shared/commands.ts";
import { PLAYBACK_LYRICS } from "../../../shared/request-channels.ts";
import {
  coreLyricsConfigure,
  coreLyricsDocument,
  coreLyricsProgress,
  coreLyricsToggle,
  coreCall,
  onCoreEvent,
} from "../../host-api.ts";
import { parseAmllLyrics } from "./amll-adapter.ts";
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_STATUS,
  lyricsDocumentOf,
  lyricsStatusFromFailure,
  normalizeLyricsConfig,
  shouldPushProgress,
} from "./lyrics-window.mjs";

/** 指令面的默认实现：命令名 → host-api 的具名封装（命令名字面量只在共享常量里）。 */
async function defaultCallCommand(command, args) {
  const payload = args !== null && typeof args === "object" ? args : {};
  switch (command) {
    case CORE_LYRICS_TOGGLE:
      return coreLyricsToggle(payload.checked === true);
    case CORE_LYRICS_CONFIGURE:
      return coreLyricsConfigure(payload.config ?? {});
    case CORE_LYRICS_DOCUMENT:
      return coreLyricsDocument(payload.document ?? {});
    case CORE_LYRICS_PROGRESS:
      return coreLyricsProgress(payload.progress ?? {});
    default:
      // 认不出的命令不猜（抛结构化错误：调用方会记一行，用户侧不会看到假的成功）
      throw { kind: "internal", message: `认不出的歌词窗命令：${String(command)}` };
  }
}

/** 宿主回执 → 状态（形状不认识就落默认 + `visible=false`：保守，与托盘可用性同一方向）。 */
export function lyricsStatusFromAnswer(answer) {
  const source = answer !== null && typeof answer === "object" ? answer : {};
  return {
    config: normalizeLyricsConfig(source.config, DEFAULT_LYRICS_CONFIG),
    visible: source.visible === true,
  };
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
 */
export function createLyricsBridge(deps = {}) {
  const callCore = deps.callCore ?? ((channel, payload) => coreCall(channel, payload));
  const callCommand = deps.callCommand ?? defaultCallCommand;
  const subscribeCoreEvent = deps.subscribeCoreEvent ?? onCoreEvent;
  const parseLyrics = deps.parseLyrics ?? ((text) => parseAmllLyrics(text));
  const log = deps.log ?? ((...parts) => console.warn("[hwmusic-lyrics]", ...parts));

  /** 上一次**推出去**的进度：节流的比较基准（没推的那个不算，否则永远差 20ms）。 */
  let lastProgress = null;

  /** 读回当前状态（四条命令里没有第五条"读配置"：空补丁的 configure 就是它）。 */
  async function readStatus() {
    return lyricsStatusFromAnswer(await callCommand(CORE_LYRICS_CONFIGURE, { config: {} }));
  }

  /** 开关歌词窗（**目标态**：托盘的 `lyrics:toggle` 给的就是它）。 */
  async function setVisible(checked) {
    return lyricsStatusFromAnswer(await callCommand(CORE_LYRICS_TOGGLE, { checked: checked === true }));
  }

  /** 改配置（补丁；钳制与合并的最终判定在 Rust 侧，这里原样交上去）。 */
  async function applyConfig(patch) {
    return lyricsStatusFromAnswer(await callCommand(CORE_LYRICS_CONFIGURE, { config: patch ?? {} }));
  }

  /** 订阅托盘的 `lyrics:toggle`（目标态度，不做"切换一下"）。 */
  function subscribeToggle(handler) {
    return subscribeCoreEvent(LYRICS_TOGGLE, (payload) => {
      const checked = payload !== null && typeof payload === "object" ? payload.checked : null;
      handler(checked === true);
    });
  }

  /**
   * 取歌词文本并解析（**唯一入口**）：`playback:lyrics` → 官方 `parseLrc` 适配。
   *
   * 失败分类如实分开：端点没配（`endpoint_unknown`）说"尚未配置"，别的失败说"暂时取不到"
   * ——把后者说成前者，用户会去设置里找一个本来就填好的端点。
   */
  async function loadLyrics(trackId) {
    const id = typeof trackId === "string" ? trackId.trim() : "";
    if (id === "") return { status: LYRICS_STATUS.unavailable, lines: [] };

    let answer;
    try {
      answer = await callCore(PLAYBACK_LYRICS, { trackId: id });
    } catch (error) {
      return { status: lyricsStatusFromFailure(error), lines: [] };
    }
    const text = answer !== null && typeof answer === "object" && typeof answer.text === "string" ? answer.text : "";
    const parsed = parseLyrics(text);
    const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
    return { status: lines.length > 0 ? LYRICS_STATUS.ready : LYRICS_STATUS.empty, lines };
  }

  /** 把歌词文档转发给歌词窗（主窗面板与歌词窗共用同一份行数组）。 */
  async function pushDocument(document) {
    const source = document !== null && typeof document === "object" ? document : {};
    await callCommand(CORE_LYRICS_DOCUMENT, { document: lyricsDocumentOf(source.lines, source.status) });
  }

  /** 推进度（rAF 每帧都可能调；不该推的直接丢掉，不出 IPC）。 */
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

  return {
    readStatus,
    setVisible,
    applyConfig,
    subscribeToggle,
    loadLyrics,
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
