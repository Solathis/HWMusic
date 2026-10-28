/**
 * 播放状态机：一个 Audio 实例的全部行为都在这里，但这里没有 Audio。
 * 端口全部注入：`audio`、`resolveUrl(trackId)`、`guardUrl(url)`（缺它就抛，闸门不能可选）、
 * `persistQueue`/`loadQueue`、`log`（只写该打扰的失败，绝不写播放地址）、`random`/`now`/`schedule`。
 * 状态里没有音频地址；每次装载领一个令牌，乱序应答整包丢掉；换队列 = 停止播放。
 */
import { queueEntriesOf, queueRecordOf, restoredEntries, sanitizeQueueRecord } from "./queue.mjs";
import { LYRICS_STATUS } from "../lyrics/lyrics-window.mjs";
import { trackDurationOf } from "../library/track-fields.mjs";

/** 歌词状态词表（唯一真源在 features/lyrics/lyrics-window.mjs）：认不出的值一律不写进状态。 */
const LYRICS_STATUSES = Object.values(LYRICS_STATUS);

/** 播放模式（顺序是默认；随机也叫"打乱播放"）。 */
export const PLAYBACK_MODES = ["sequential", "list-loop", "single-loop", "shuffle"];
export const DEFAULT_PLAYBACK_MODE = "sequential";

/** 状态机的状态。`loading` 兼顾"取地址中"与"缓冲中"——对用户是同一件事：还没出声音。 */
export const PLAYER_STATUS = {
  idle: "idle",
  loading: "loading",
  playing: "playing",
  paused: "paused",
  ended: "ended",
  error: "error",
};

/** 结构化错误类别（UI 按 kind 取文案；core 的错误类别原样透传，不在这里改写）。 */
export const PLAYER_ERROR_KINDS = {
  /** 队列是空的：播放本身没问题，是没得放 */
  queueEmpty: "queue_empty",
  /** 没有选中曲目（索引越界/未装载） */
  noTrack: "no_track",
  /** 取地址失败（兜底类别；core 给了具体类别就用它的） */
  resolveFailed: "resolve_failed",
  /** 地址没通过媒体白名单（CSP media-src），拒绝装载 */
  unsafeMediaUrl: "unsafe_media_url",
  /** 音频元素报错或拒绝播放 */
  audioError: "audio_error",
  /** 调用方参数不合法（模式/音量）——**不是播放故障**，不进 state.error */
  invalidCommand: "invalid_command",
};

/** 默认音量：不加不减地放出来（"默认 70%"是拍脑袋，用户没调过就别替他调）。 */
export const DEFAULT_VOLUME = 1;

/** 进度写盘的最短间隔：播放中每 5 秒最多一次；异常退出最多丢掉这个窗口的进度。 */
export const POSITION_WRITE_INTERVAL_MS = 5000;

/** 恢复位置至少要留下这么多可播时间；离结尾更近就当"听完了"，从 0 开始。 */
export const RESUME_TAIL_MS = 3000;

/** 音频端口会发的事件（真实元素的适配见 audio-element.mjs）。 */
export const PLAYER_AUDIO_EVENTS = ["ended", "error", "loadedmetadata", "durationchange", "timeupdate", "playing", "waiting"];

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 秒 → 整数毫秒（AMLL 的 currentTime 要求整数毫秒）；非有限/负数 → null。 */
function millisOfSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * 有效总时长（毫秒）：音频报的有限正值 → 曲目元数据秒数 → 0（界面显示「—」）。
 * @param {{duration?: unknown}|null} track
 * @param {number} reportedMs 音频元素最近报的时长（毫秒，0 = 没报到可用值）
 */
export function totalDurationMsOf(track, reportedMs) {
  if (typeof reportedMs === "number" && Number.isFinite(reportedMs) && reportedMs > 0) return Math.round(reportedMs);
  const seconds = trackDurationOf(track);
  return seconds === null ? 0 : Math.round(seconds * 1000);
}

/**
 * 恢复位置的门：距结尾不足 3 秒（或超出时长）就当作"听完了"，从 0 开始。
 * 时长未知（0）时原样交出——真实时长要等 `loadedmetadata` 才判得了。
 */
export function resumableMs(positionMs, durationMs) {
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs <= 0) return 0;
  if (!(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)) return Math.round(positionMs);
  return positionMs > durationMs - RESUME_TAIL_MS ? 0 : Math.round(positionMs);
}

function textOf(cause) {
  if (cause instanceof Error && typeof cause.message === "string" && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  if (cause !== null && typeof cause === "object" && typeof cause.message === "string" && cause.message.trim() !== "") {
    return cause.message;
  }
  return "未知错误（详情见日志）";
}

function kindOf(cause) {
  return cause !== null && typeof cause === "object" && typeof cause.kind === "string" ? cause.kind : null;
}

/**
 * 造播放状态机。
 * @param {object} options
 * @param {object} options.audio 音频端口（单实例！真实实现见 audio-element.mjs）
 * @param {(trackId: string) => Promise<{ok: true, data: {url?: unknown}} | {ok: false, error: {message?: string, kind?: string}}>} options.resolveUrl
 * @param {(url: string) => (string|null)} options.guardUrl 媒体白名单闸门（放行回归一化地址，否则 null）
 * @param {(record: import("./queue.mjs").QueueRecord|null) => unknown} [options.persistQueue]
 * @param {() => Promise<unknown>} [options.loadQueue]
 * @param {(...parts: unknown[]) => void} [options.log]
 * @param {() => number} [options.random]
 * @param {() => number} [options.now]
 * @param {(callback: () => void, delayMs: number) => (() => void)} [options.schedule]
 */
export function createPlayer(options = {}) {
  const { audio, resolveUrl, guardUrl } = options;

  if (audio === null || typeof audio !== "object") {
    throw new TypeError("createPlayer 需要注入 audio 端口（唯一实例见 features/playback/audio-element.mjs）");
  }
  for (const method of ["setSource", "play", "pause", "setCurrentTime", "setVolume", "setMuted", "on"]) {
    if (typeof audio[method] !== "function") {
      throw new TypeError(`createPlayer 的 audio 端口缺少 ${method}()（端口契约见文件头）`);
    }
  }
  if (typeof resolveUrl !== "function") {
    throw new TypeError("createPlayer 需要注入 resolveUrl（取当次播放地址；地址不缓存）");
  }
  if (typeof guardUrl !== "function") {
    throw new TypeError(
      "createPlayer 需要注入 guardUrl（媒体白名单闸门）：不放行的地址永不装载，" +
        "缺了它就没有第二道防线，只剩 CSP",
    );
  }

  const persistQueue = typeof options.persistQueue === "function" ? options.persistQueue : async () => null;
  const loadQueue = typeof options.loadQueue === "function" ? options.loadQueue : async () => null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const random = typeof options.random === "function" ? options.random : Math.random;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const schedule =
    typeof options.schedule === "function"
      ? options.schedule
      : (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        };

  /** 当前装载进音频元素的曲目标识（**地址不留在状态里**，所以这里只记标识）。 */
  let loadedId = null;
  /** 装载令牌：取地址回来时对不上就丢弃（双击连点/快速切歌的乱序保护）。 */
  let token = 0;
  /** 上次真正写盘的记录（去重：拖进度、改音量都不该写盘，队列没变更不该写）。 */
  let persistedKey = "\u0000initial";
  /** 随机模式的轮换排列与游标（一轮内不重复，且"上一首"退得回去）。 */
  let order = [];
  let cursor = 0;
  /** 音频元素最近报的时长（毫秒；0 = 没报到可用值）。有效总时长见 `totalDurationMsOf`。 */
  let reportedDurationMs = 0;
  /**
   * 还没被装载消费的恢复位置（`saved` = 来自磁盘，仍要按真实时长复核结尾门）。
   * 用户一拖进度就以用户为准（`saved: false`），不再受结尾门约束。
   */
  let resume = null;
  /** 上次写盘尝试的时刻（节流口径）：一次"写盘机会"过了 5 秒才给下一次。 */
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  /** 位置变了但还没落盘的标记，以及那次尾随写的取消句柄。 */
  let positionDirty = false;
  let trailingCancel = null;

  /**
   * 状态是不可变替换的：React 的 useSyncExternalStore 靠引用比较认变化。
   * 形状写在 JSDoc 里，TS 侧才拿得到准确类型，否则 `entries: []` 会被推断成 `never[]`。
   * @type {{
   *   status: string,
   *   error: {kind: string, message: string}|null,
   *   entries: Array<import("./queue.mjs").QueueEntry>,
   *   index: number,
   *   track: import("./queue.mjs").QueueEntry|null,
   *   loaded: boolean,
   *   currentTimeMs: number,
   *   durationMs: number,
   *   volume: number,
   *   muted: boolean,
   *   mode: string,
   *   seekGeneration: number,
   *   playbackGeneration: number,
   *   restored: boolean,
   *   lyrics: {status: string, lines: Array<import("@applemusic-like-lyrics/lyric").LyricLine>},
   * }}
   */
  let state = Object.freeze({
    status: PLAYER_STATUS.idle,
    error: null,
    entries: [],
    index: -1,
    track: null,
    loaded: false,
    currentTimeMs: 0,
    durationMs: 0,
    volume: DEFAULT_VOLUME,
    muted: false,
    mode: DEFAULT_PLAYBACK_MODE,
    seekGeneration: 0,
    playbackGeneration: 0,
    restored: false,
    lyrics: { status: "unavailable", lines: [] },
  });

  const listeners = new Set();

  /** 状态是不可变替换的：React 的 useSyncExternalStore 靠引用比较认变化。 */
  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener(state);
  }

  /** 播放真故障：进状态、给 UI 显示。 */
  function failPlayback(kind, message) {
    const error = { kind, message };
    publish({ status: PLAYER_STATUS.error, error });
    return { ok: false, error };
  }

  /** "没得放"（空队列/没选中）：同样是结构化错误，但**不是故障**，状态保持不变。 */
  function failEmpty(kind, message) {
    const error = { kind, message };
    publish({ error });
    return { ok: false, error };
  }

  /** 调用方参数不合法：只回结构化错误，**不进状态**（这是程序 bug，不是播放故障）。 */
  function rejectCommand(message) {
    return { ok: false, error: { kind: PLAYER_ERROR_KINDS.invalidCommand, message } };
  }

  function done(data) {
    return { ok: true, data };
  }

  /** 当前曲目的进度（只存毫秒；0 与"没有位置"是同一件事）。 */
  function currentPosition() {
    if (state.track === null || state.currentTimeMs <= 0) return null;
    return { trackId: state.track.id, positionMs: state.currentTimeMs };
  }

  /** 写盘：同步发起（不阻塞状态更新），失败只记日志且不含地址。 */
  function persist() {
    const record = queueRecordOf(state.entries, state.index, currentPosition());
    const key = JSON.stringify(record);
    lastWriteAt = now();
    if (key === persistedKey) return;
    persistedKey = key;
    try {
      const answer = persistQueue(record);
      if (answer !== null && typeof answer === "object" && typeof answer.then === "function") {
        answer.catch((cause) => log("队列持久化失败（队列仍在内存里，下次启动恢复不了）：", textOf(cause)));
      }
    } catch (cause) {
      log("队列持久化失败（队列仍在内存里，下次启动恢复不了）：", textOf(cause));
    }
  }

  function cancelTrailing() {
    if (trailingCancel === null) return;
    const cancel = trailingCancel;
    trailingCancel = null;
    try {
      cancel();
    } catch {
      // 定时器自己的失败不该拦住写盘
    }
  }

  /** 立刻落盘（暂停、切歌、清空、窗口隐藏这些"可能马上就没机会写"的时刻不走节流）。 */
  function flushPosition() {
    cancelTrailing();
    positionDirty = false;
    persist();
    return done({ currentTimeMs: state.currentTimeMs });
  }

  /** 进度变化：最多 5 秒写一次，并尾随补一次——拖动松手后的最终位置必须落盘。 */
  function notePosition() {
    positionDirty = true;
    const elapsed = now() - lastWriteAt;
    if (elapsed >= POSITION_WRITE_INTERVAL_MS) {
      flushPosition();
      return;
    }
    if (trailingCancel !== null) return;
    trailingCancel = schedule(() => {
      trailingCancel = null;
      if (positionDirty) flushPosition();
    }, POSITION_WRITE_INTERVAL_MS - elapsed);
  }

  /** 真实时长到了：复核待恢复位置是否已到结尾（元数据没给时长时才需要这一步）。 */
  function settleResume() {
    const pending = resume !== null && resume.trackId === state.track?.id ? resume : null;
    if (pending === null) return;
    resume = null;
    if (!pending.saved) return;
    const settled = resumableMs(pending.positionMs, totalDurationMsOf(state.track, reportedDurationMs));
    if (settled === pending.positionMs) return;
    audio.setCurrentTime(settled);
    publish({ currentTimeMs: settled, seekGeneration: state.seekGeneration + 1 });
  }

  /** 随机排列：注入 random（Fisher–Yates）。`leadIndex` 会把"用户刚点的那首"排到本轮开头。 */
  function rebuildOrder(leadIndex) {
    const indexes = state.entries.map((_, index) => index);
    for (let i = indexes.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = indexes[i];
      indexes[i] = indexes[j];
      indexes[j] = swap;
    }
    if (Number.isInteger(leadIndex) && leadIndex >= 0 && indexes.length > 1) {
      const at = indexes.indexOf(leadIndex);
      if (at > 0) {
        indexes.splice(at, 1);
        indexes.unshift(leadIndex);
      }
    }
    order = indexes;
    cursor = 0;
  }

  function shuffleNext() {
    if (order.length !== state.entries.length) rebuildOrder(state.index >= 0 ? state.index : undefined);
    cursor += 1;
    if (cursor >= order.length) {
      // 一轮走完：换一轮新的，且不把刚听完的那首再放一遍（随机播放最招人烦的就是这个）
      const previous = state.index;
      rebuildOrder();
      if (order.length > 1 && order[0] === previous) {
        const swap = order[1];
        order[1] = order[0];
        order[0] = swap;
      }
      cursor = 0;
    }
    return order[cursor];
  }

  function shufflePrevious() {
    if (order.length !== state.entries.length) rebuildOrder(state.index >= 0 ? state.index : undefined);
    if (cursor <= 0) return -1;
    cursor -= 1;
    return order[cursor];
  }

  /**
   * 取地址 → 过闸门。任何一步失败都回结构化错误，**且消息里没有地址**。
   * @returns {Promise<{ok: true, url: string} | {ok: false, error: {kind: string, message: string}}>}
   */
  async function resolveAddress(trackId) {
    let answer;
    try {
      answer = await resolveUrl(trackId);
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: kindOf(cause) ?? PLAYER_ERROR_KINDS.resolveFailed,
          message: textOf(cause),
        },
      };
    }
    if (answer === null || typeof answer !== "object" || answer.ok !== true) {
      const error = answer !== null && typeof answer === "object" ? answer.error : null;
      const kind = error !== null && typeof error === "object" && typeof error.kind === "string" ? error.kind : null;
      const message =
        error !== null && typeof error === "object" && typeof error.message === "string" && error.message.trim() !== ""
          ? error.message
          : "取播放地址失败（详情见日志）";
      return { ok: false, error: { kind: kind ?? PLAYER_ERROR_KINDS.resolveFailed, message } };
    }

    const raw = answer.data !== null && typeof answer.data === "object" ? answer.data.url : null;
    if (typeof raw !== "string" || raw.trim() === "") {
      return {
        ok: false,
        error: { kind: PLAYER_ERROR_KINDS.resolveFailed, message: "播放接口没有给出音频地址（响应里没有可用的 url）" },
      };
    }

    // 闸门出错 = 不放行（fail closed）：宁可报"拒绝了"，也不能因为闸门自己炸了就放行
    let safe = null;
    try {
      safe = guardUrl(raw);
    } catch (cause) {
      log("媒体地址闸门抛出异常（按拒绝处理）：", textOf(cause));
      safe = null;
    }
    if (typeof safe !== "string" || safe.trim() === "") {
      return {
        ok: false,
        error: {
          kind: PLAYER_ERROR_KINDS.unsafeMediaUrl,
          message: "播放地址不在允许的媒体域名内，已拒绝装载。",
        },
      };
    }
    return { ok: true, url: safe };
  }

  /** 让音频真的出声（令牌对不上就丢弃：那是过期请求）。 */
  async function playAudio(activeToken) {
    try {
      await audio.play();
    } catch (cause) {
      if (activeToken !== undefined && activeToken !== token) return done({ stale: true });
      return failPlayback(PLAYER_ERROR_KINDS.audioError, `音频播放失败：${textOf(cause)}`);
    }
    if (activeToken !== undefined && activeToken !== token) return done({ stale: true });
    publish({ status: PLAYER_STATUS.playing, error: null });
    return done({ status: PLAYER_STATUS.playing });
  }

  function stopAtEnd() {
    audio.pause();
    publish({ status: PLAYER_STATUS.ended, error: null });
    return done({ status: PLAYER_STATUS.ended, index: state.index });
  }

  /** 重放当前曲（首曲按"上一首"、播完之后按"播放"都走这条）。 */
  function restartCurrent() {
    if (!state.loaded) return start(state.index, { manual: false });
    audio.setCurrentTime(0);
    publish({ currentTimeMs: 0, seekGeneration: state.seekGeneration + 1, playbackGeneration: state.playbackGeneration + 1, error: null });
    if (state.status === PLAYER_STATUS.playing) return playAudio();
    return done({ status: state.status, index: state.index });
  }

  /**
   * 装载并播放第 `index` 首（`manual: true` 在随机模式下以这一首开头重开一轮）。
   */
  async function start(index, { manual = true } = {}) {
    if (state.entries.length === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    if (!Number.isInteger(index) || index < 0 || index >= state.entries.length) {
      return failEmpty(PLAYER_ERROR_KINDS.noTrack, "没有选中可播放的曲目");
    }

    const entry = state.entries[index];
    const sameLoaded = loadedId === entry.id && state.loaded === true;
    if (state.mode === "shuffle" && manual) rebuildOrder(index);

    const activeToken = (token += 1);
    const resumeMs = !sameLoaded && resume !== null && resume.trackId === entry.id ? resume.positionMs : null;
    // 换到别的曲目：盘上的那个位置只属于恢复时的这一首，不许跟着走
    if (resume !== null && resume.trackId !== entry.id) resume = null;
    // 新曲目没装载前，音频的读数属于上一首：清掉，让总时长退回条目元数据
    if (!sameLoaded) reportedDurationMs = 0;
    publish({
      index,
      track: entry,
      playbackGeneration: state.playbackGeneration + 1,
      error: null,
      ...(sameLoaded
        ? {}
        : {
            loaded: false,
            currentTimeMs: resumeMs ?? 0,
            durationMs: totalDurationMsOf(entry, reportedDurationMs),
            status: PLAYER_STATUS.loading,
          }),
    });
    persist();

    if (!sameLoaded) {
      const resolved = await resolveAddress(entry.id);
      if (activeToken !== token) return done({ stale: true });
      if (!resolved.ok) return failPlayback(resolved.error.kind, resolved.error.message);

      loadedId = entry.id;
      audio.setSource(resolved.url);
      audio.setVolume(state.volume);
      audio.setMuted(state.muted);
      // 元数据之前写入是规范里的「默认起播位置」：真实元素装载后从这里开始。
      const pendingMs = resume !== null && resume.trackId === entry.id ? resume.positionMs : null;
      if (pendingMs !== null) {
        audio.setCurrentTime(pendingMs);
        publish({ currentTimeMs: pendingMs, seekGeneration: state.seekGeneration + 1 });
      }
      publish({ loaded: true });
    }

    return playAudio(activeToken);
  }

  async function play() {
    if (state.entries.length === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    if (state.index < 0 || state.track === null) {
      return failEmpty(PLAYER_ERROR_KINDS.noTrack, "没有选中可播放的曲目");
    }
    if (!state.loaded) return start(state.index, { manual: false });
    if (state.status === PLAYER_STATUS.ended) {
      audio.setCurrentTime(0);
      publish({ currentTimeMs: 0, playbackGeneration: state.playbackGeneration + 1 });
      notePosition();
    }
    return playAudio();
  }

  function pause() {
    if (state.status !== PLAYER_STATUS.playing && state.status !== PLAYER_STATUS.loading) {
      return done({ status: state.status });
    }
    audio.pause();
    publish({ status: PLAYER_STATUS.paused });
    // 暂停是"可能就此关掉应用"的时刻：那一刻的位置立刻落盘，不等节流
    flushPosition();
    return done({ status: PLAYER_STATUS.paused });
  }

  async function toggle() {
    return state.status === PLAYER_STATUS.playing ? pause() : play();
  }

  /** 播完的自动接续（与手动"下一首"的区别：顺序模式末端停住，列表循环/随机继续走）。 */
  async function autoAdvance() {
    if (state.entries.length === 0) return done({ status: state.status });
    if (state.mode === "single-loop") {
      audio.setCurrentTime(0);
      publish({ currentTimeMs: 0, seekGeneration: state.seekGeneration + 1, playbackGeneration: state.playbackGeneration + 1, error: null });
      return playAudio();
    }
    if (state.mode === "shuffle") return start(shuffleNext(), { manual: false });
    if (state.mode === "list-loop") return start((state.index + 1) % state.entries.length, { manual: false });
    if (state.index + 1 < state.entries.length) return start(state.index + 1, { manual: false });
    return stopAtEnd();
  }

  async function next() {
    if (state.entries.length === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    if (state.index < 0) return failEmpty(PLAYER_ERROR_KINDS.noTrack, "没有选中可播放的曲目");
    if (state.mode === "shuffle") return start(shuffleNext(), { manual: false });
    if (state.mode === "list-loop") return start((state.index + 1) % state.entries.length, { manual: false });
    // 单曲循环下手动"下一首"仍然去下一首：重复是"放完自动重来"，不是"按了也不动"
    if (state.index + 1 >= state.entries.length) return stopAtEnd();
    return start(state.index + 1, { manual: false });
  }

  async function previous() {
    if (state.entries.length === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    if (state.index < 0) return failEmpty(PLAYER_ERROR_KINDS.noTrack, "没有选中可播放的曲目");
    if (state.mode === "shuffle") {
      const target = shufflePrevious();
      if (target >= 0) return start(target, { manual: false });
      return restartCurrent();
    }
    if (state.index === 0) return restartCurrent();
    return start(state.index - 1, { manual: false });
  }

  /** 停止出声（只在真的有声可停时才下发指令：空转的 pause 会污染"指令条数"这类观测）。 */
  function stopAudio() {
    if (state.status === PLAYER_STATUS.playing || state.status === PLAYER_STATUS.loading) audio.pause();
  }

  function setQueue(items, startIndex = 0) {
    const entries = queueEntriesOf(items);
    const index = entries.length === 0 ? -1 : clamp(Math.trunc(Number(startIndex) || 0), 0, entries.length - 1);
    // 换队列 = 停止播放：音频里装着的还是上一首，装作没发生只会播错歌
    token += 1;
    loadedId = null;
    order = [];
    cursor = 0;
    reportedDurationMs = 0;
    resume = null;
    stopAudio();
    publish({
      entries,
      index,
      track: index >= 0 ? entries[index] : null,
      playbackGeneration: state.playbackGeneration + 1,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: 0,
      durationMs: totalDurationMsOf(index >= 0 ? entries[index] : null, 0),
      error: null,
    });
    persist();
    return done({ queueLength: entries.length, index });
  }

  async function playQueue(items, startIndex = 0) {
    const queued = setQueue(items, startIndex);
    if (!queued.ok) return queued;
    if (queued.data.queueLength === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    return start(queued.data.index, { manual: true });
  }

  /**
   * 往队列末尾追加：只动落点，不动正在播的那一首。
   * 空队列时追加 = 建立队列并停在第一首（不自动开播），不去重、不排序，已装载的那首不动；空列表不写盘。
   * @returns {{ok: true, data: {added: number, queueLength: number, index: number}}}
   */
  function enqueue(items) {
    const appended = queueEntriesOf(items);
    if (appended.length === 0) {
      return done({ added: 0, queueLength: state.entries.length, index: state.index });
    }
    const entries = [...state.entries, ...appended];
    // 原本空队列：索引指向新队列的第一首（状态从"没得放"变成"可以放"，但仍不自动开播）
    const index = state.index < 0 ? 0 : state.index;
    if (state.index < 0) reportedDurationMs = 0;
    publish({
      entries,
      index,
      track: entries[index] ?? null,
      durationMs: totalDurationMsOf(entries[index] ?? null, reportedDurationMs),
      error: null,
    });
    persist();
    return done({ added: appended.length, queueLength: entries.length, index });
  }

  /**
   * 插到当前曲目之后（「下一首播放」）：与 `enqueue` 只差落点，其余纪律一致。
   */
  function playNext(items) {
    const appended = queueEntriesOf(items);
    if (appended.length === 0) {
      return done({ added: 0, queueLength: state.entries.length, index: state.index });
    }
    const at = state.index < 0 ? 0 : state.index + 1;
    const shiftOrder = state.index >= 0 && order.length === state.entries.length;
    const entries = [...state.entries.slice(0, at), ...appended, ...state.entries.slice(at)];
    const index = state.index < 0 ? 0 : state.index;
    if (shiftOrder) {
      const moved = order.map((value) => (value >= at ? value + appended.length : value));
      const inserted = appended.map((_, position) => at + position);
      order = moved.slice(0, cursor + 1).concat(inserted, moved.slice(cursor + 1));
    }
    if (state.index < 0) reportedDurationMs = 0;
    publish({
      entries,
      index,
      track: entries[index] ?? null,
      durationMs: totalDurationMsOf(entries[index] ?? null, reportedDurationMs),
      error: null,
    });
    persist();
    return done({ added: appended.length, queueLength: entries.length, index });
  }

  function clear() {
    token += 1;
    loadedId = null;
    order = [];
    cursor = 0;
    reportedDurationMs = 0;
    resume = null;
    stopAudio();
    publish({
      entries: [],
      index: -1,
      track: null,
      playbackGeneration: state.playbackGeneration + 1,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: 0,
      durationMs: 0,
      error: null,
    });
    persist();
    return done({ queueLength: 0 });
  }

  /**
   * 恢复上次的队列与进度：**只还原，不开始播放**（没有用户手势的自动出声是打扰）。
   * 进度按条目元数据先过一遍结尾门；元数据没有时长时留给 `loadedmetadata` 再判。
   */
  async function restore() {
    let record = null;
    try {
      record = await loadQueue();
    } catch (cause) {
      log("读取上次的播放队列失败（按没有队列处理）：", textOf(cause));
      record = null;
    }

    const clean = sanitizeQueueRecord(record);
    if (clean === null) {
      publish({ restored: true });
      return done({ restored: false, queueLength: 0 });
    }

    const entries = restoredEntries(clean);
    const track = entries[clean.index] ?? null;
    const durationMs = totalDurationMsOf(track, 0);
    const positionMs = resumableMs(clean.positionMs ?? 0, durationMs);
    const savedPosition =
      positionMs > 0 && track !== null && clean.positionTrackId === track.id
        ? { trackId: track.id, positionMs, saved: true }
        : null;
    token += 1;
    loadedId = null;
    order = [];
    cursor = 0;
    reportedDurationMs = 0;
    resume = savedPosition;
    publish({
      entries,
      index: clean.index,
      track,
      playbackGeneration: state.playbackGeneration + 1,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: positionMs,
      durationMs,
      error: null,
      restored: true,
    });
    // 读回来的东西不写回去：同内容重写只是多一次磁盘写入（写坏 settings.json 的机会 +1）
    persistedKey = JSON.stringify(queueRecordOf(entries, clean.index, savedPosition));
    return done({ restored: true, queueLength: entries.length });
  }

  function seek(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return rejectCommand("seek 需要毫秒数字");
    const upper = state.durationMs > 0 ? state.durationMs : Math.max(0, value);
    const target = Math.round(clamp(value, 0, upper));
    // 还没装载时拖进度只是改"待恢复位置"：此刻对音频说什么都没有意义，用户的选择优先
    if (resume !== null && !state.loaded && state.track !== null) {
      resume = { trackId: state.track.id, positionMs: target, saved: false };
      publish({ currentTimeMs: target, seekGeneration: state.seekGeneration + 1 });
      notePosition();
      return done({ currentTimeMs: target });
    }
    audio.setCurrentTime(target);
    publish({ currentTimeMs: target, seekGeneration: state.seekGeneration + 1 });
    // 用户自己动了进度：待恢复的那份到此为止，结尾门也不再管它
    resume = null;
    notePosition();
    return done({ currentTimeMs: target });
  }

  function setVolume(value) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return rejectCommand("音量必须是 0..1 之间的数字");
    const volume = clamp(number, 0, 1);
    audio.setVolume(volume);
    publish({ volume });
    return done({ volume });
  }

  function setMuted(value) {
    const muted = value === true;
    audio.setMuted(muted);
    publish({ muted });
    return done({ muted });
  }

  function toggleMute() {
    return setMuted(!state.muted);
  }

  function setMode(mode) {
    if (!PLAYBACK_MODES.includes(mode)) {
      return rejectCommand(`认不出的播放模式（只接受 ${PLAYBACK_MODES.join(" / ")}）`);
    }
    if (mode === "shuffle") rebuildOrder(state.index >= 0 ? state.index : undefined);
    publish({ mode });
    return done({ mode });
  }

  /**
   * 歌词行（AMLL 的 `LyricLine[]`）：状态机只做搬运，解析在 features/lyrics/amll-adapter.ts。
   * `status` 是「不冒充」的关键：`unavailable` / `loading` / `empty` / `failed` / `ready`。
   * @param {Array<import("@applemusic-like-lyrics/lyric").LyricLine>|null|undefined} lines
   * @param {string} [status]
   */
  function setLyrics(lines, status) {
    const list = Array.isArray(lines) ? lines : [];
    const inferred = list.length > 0 ? LYRICS_STATUS.ready : LYRICS_STATUS.empty;
    const resolved =
      typeof status === "string" && LYRICS_STATUSES.includes(status) ? status : inferred;
    publish({ lyrics: { status: resolved, lines: list } });
    return done({ lineCount: list.length, status: resolved });
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe 需要函数");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // —— 音频事件接线 —— //
  const detachers = [];
  const listen = (event, handler) => {
    const off = audio.on(event, handler);
    if (typeof off === "function") detachers.push(off);
  };

  listen("ended", () => {
    void autoAdvance();
  });
  listen("error", () => {
    failPlayback(PLAYER_ERROR_KINDS.audioError, "音频播放失败（音源不可用或格式不支持）");
  });
  /**
   * 时长读数（`loadedmetadata` / `durationchange` 同一个处理）：流媒体常先报 `Infinity`，
   * 之后 `durationchange` 才报真实值——只听前者就会一直停在元数据兜底上。
   */
  listen("loadedmetadata", (payload) => {
    reportedDurationMs = millisOfSeconds(payload?.duration) ?? 0;
    publish({ durationMs: totalDurationMsOf(state.track, reportedDurationMs) });
    settleResume();
  });
  listen("durationchange", (payload) => {
    reportedDurationMs = millisOfSeconds(payload?.duration) ?? 0;
    publish({ durationMs: totalDurationMsOf(state.track, reportedDurationMs) });
  });
  listen("timeupdate", (payload) => {
    const currentTimeMs = millisOfSeconds(payload?.currentTime);
    if (currentTimeMs === null) return;
    publish({ currentTimeMs });
    if (state.status === PLAYER_STATUS.playing) notePosition();
  });
  listen("playing", () => {
    publish({ status: PLAYER_STATUS.playing });
  });
  listen("waiting", () => {
    // 只有"本来在播"才降级成缓冲：暂停时的 waiting 不该把状态改成"正在准备"
    if (state.status === PLAYER_STATUS.playing) publish({ status: PLAYER_STATUS.loading });
  });

  function dispose() {
    token += 1;
    cancelTrailing();
    for (const detach of detachers) {
      try {
        detach();
      } catch {
        // 卸载路径：音频端口自己报错不该拦住收尾
      }
    }
    detachers.length = 0;
    listeners.clear();
  }

  return {
    snapshot: () => state,
    subscribe,
    dispose,
    setQueue,
    playQueue,
    enqueue,
    playNext,
    playAt: (index) => start(index, { manual: true }),
    play,
    pause,
    toggle,
    next,
    previous,
    seek,
    flushPosition,
    setVolume,
    setMuted,
    toggleMute,
    setMode,
    setLyrics,
    clear,
    restore,
  };
}
