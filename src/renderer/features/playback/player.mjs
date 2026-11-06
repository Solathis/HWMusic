/**
 * 播放状态机：一个 Audio 实例的全部行为都在这里，但这里没有 Audio。
 * 端口全部注入：`audio`、`resolveUrl(trackId)`、`guardUrl(url)`（缺它就抛，闸门不能可选）、
 * `persistQueue`/`loadQueue`、`log`（只写该打扰的失败，绝不写播放地址）、`notify`（一句话提示，缺省写日志）、`random`/`now`/`schedule`。
 * 状态里没有音频地址；每次装载领一个令牌，乱序应答整包丢掉；换队列 = 停止播放。
 * 取不到地址时按当前模式自动跳下一首（连续最多 3 首），用 `notice` 说明而非错误；都失败才停回 error。
 * 服务端已判定的下架/不存在曲目不占那 3 首（另有 30 首的天花板），换档与重试对它们没有意义。
 * 这些曲目的 id 会进状态的 `offlineIds`（列表据此变灰并禁播），并尽力落盘到设置里；这份清单用于灰显、入队过滤与本地跳过。
 * 入队、插队、整队替换时剔除已知下架的曲目并用 `notify` 说一句，轮到已知下架的那首就本地跳过、不再请求播放地址。
 * 音质只说服务端明确声明的那一档（`actualQuality`）：`unknown` / 缺失 / 本地曲目一律是 null，界面不许虚标。
 */
import { queueEntriesOf, queueRecordOf, restoredEntries, sanitizeQueueRecord } from "./queue.mjs";
import { ALL_OFFLINE_TEXT, offlineSkippedText, partitionPlayable, playableStartIndex } from "./offline.mjs";
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

/** 连续跳歌上限：三首都取不到地址就停住，把最后那个失败交给界面。 */
export const MAX_CONSECUTIVE_SKIPS = 3;

/** 服务端已判定不可播（下架/不存在）：换档与短重试都无意义。 */
const UNPLAYABLE_SKIP_KINDS = new Set(["content_offline", "content_unavailable"]);
/** 连续下架曲目的跳过上限（防止整张失效歌单把请求刷到底）。 */
export const MAX_UNPLAYABLE_SKIPS = 30;
/** 下架曲目清单的上限（与 core 的归一同一口径：只留最近的 2000 首）。 */
export const MAX_OFFLINE_IDS = 2000;

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
 * 服务端明确声明的音质：只认 "standard" / "high" / "lossless"。
 * parser 判的 "unknown"、缺字段、本地曲目（协议按 id 拼地址，没有这个字段）一律 null——不确定就不说。
 * @returns {"standard"|"high"|"lossless"|null}
 */
function declaredQualityOf(value) {
  return value === "standard" || value === "high" || value === "lossless" ? value : null;
}

/** 提示里的曲目称呼：有名字用名字，没有就用标识。 */
function trackLabelOf(entry) {
  if (entry !== null && typeof entry === "object") {
    if (typeof entry.name === "string" && entry.name.trim() !== "") return entry.name.trim();
    if (typeof entry.id === "string" && entry.id.trim() !== "") return entry.id.trim();
  }
  return "当前曲目";
}

/**
 * 下架曲目 id 清单归一：只留非空字符串、去重、最多 `MAX_OFFLINE_IDS` 首。
 * @param {unknown} values
 * @returns {string[]}
 */
function offlineIdsOf(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_OFFLINE_IDS) break;
  }
  return out;
}

/** 跳歌说明：不是错误，状态仍是 playing（下架/不存在说成"下架或不可用"，不谎称稍后还能播）。 */
function skipNoticeOf(skipped) {
  const labels = skipped.map((item) => `「${item.label}」`).join("、");
  if (skipped.every((item) => UNPLAYABLE_SKIP_KINDS.has(item.kind))) {
    return `${labels}已在华为音乐下架或不可用，已跳过`;
  }
  return `${labels}暂时无法播放，已跳到下一首`;
}

/**
 * 造播放状态机。
 * @param {object} options
 * @param {object} options.audio 音频端口（单实例！真实实现见 audio-element.mjs）
 * @param {(trackId: string) => Promise<{ok: true, data: {url?: unknown, actualQuality?: unknown}} | {ok: false, error: {message?: string, kind?: string}}>} options.resolveUrl
 * @param {(url: string) => (string|null)} options.guardUrl 媒体白名单闸门（放行回归一化地址，否则 null）
 * @param {(record: import("./queue.mjs").QueueRecord|null) => unknown} [options.persistQueue]
 * @param {() => Promise<unknown>} [options.loadQueue]
 * @param {string[]} [options.initialOfflineIds] 启动时已知的下架曲目 id（读设置得到；之后靠 hydrateOfflineIds 补）
 * @param {(ids: string[]) => unknown} [options.persistOfflineIds] 下架曲目清单变长时落盘（fire-and-forget）
 * @param {(...parts: unknown[]) => void} [options.log]
 * @param {(text: string) => void} [options.notify] 一句话提示（入队时剔除了已知下架曲目；不给就写日志）
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
  /** 下架清单的落盘口（不给就只在本次进程里认得这些曲目，重启后重新"第一次遇到"再记一次）。 */
  const persistOfflineIds = typeof options.persistOfflineIds === "function" ? options.persistOfflineIds : null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const notify = typeof options.notify === "function" ? options.notify : (text) => log(text);
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
  const initialOfflineIds = offlineIdsOf(options.initialOfflineIds);
  /** 已知下架曲目的集合：与 `state.offlineIds` 同源、一起更新（入队过滤与本地跳过按它查）。 */
  let offlineSet = new Set(initialOfflineIds);

  /**
   * 状态是不可变替换的：React 的 useSyncExternalStore 靠引用比较认变化。
   * 形状写在 JSDoc 里，TS 侧才拿得到准确类型，否则 `entries: []` 会被推断成 `never[]`。
   * @type {{
   *   status: string,
   *   error: {kind: string, message: string}|null,
   *   notice: string|null,
   *   entries: Array<import("./queue.mjs").QueueEntry>,
   *   index: number,
   *   track: import("./queue.mjs").QueueEntry|null,
   *   loaded: boolean,
   *   quality: "standard"|"high"|"lossless"|null,
   *   offlineIds: string[],
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
    notice: null,
    entries: [],
    index: -1,
    track: null,
    loaded: false,
    quality: null,
    offlineIds: initialOfflineIds,
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

  /**
   * 记住一首"服务端已判下架/不存在"的曲目：用于灰显、入队过滤与本地跳过，并 fire-and-forget 落盘。
   * 写不进去只是下次启动少了灰显，绝不影响这一首的跳歌——所以只记一行日志。
   */
  function rememberOffline(trackId) {
    if (typeof trackId !== "string" || trackId.trim() === "") return;
    const id = trackId.trim();
    if (offlineSet.has(id)) return;
    // 超过上限时丢最旧的：这份清单只求"最近见过的下架曲目"
    const offlineIds = [...state.offlineIds, id].slice(-MAX_OFFLINE_IDS);
    offlineSet = new Set(offlineIds);
    publish({ offlineIds });
    if (persistOfflineIds === null) return;
    try {
      const answer = persistOfflineIds(offlineIds);
      if (answer !== null && typeof answer === "object" && typeof answer.then === "function") {
        answer.catch((cause) => log("下架曲目清单没能落盘（只影响下次启动的灰显）：", textOf(cause)));
      }
    } catch (cause) {
      log("下架曲目清单没能落盘（只影响下次启动的灰显）：", textOf(cause));
    }
  }

  /**
   * 启动时把设置里那份下架清单并进状态（与运行中累积的那份合并去重）。
   * 只读不写：读回来的东西不写回去（同 `restore()` 的纪律）。
   * @param {unknown} ids
   */
  function hydrateOfflineIds(ids) {
    const merged = offlineIdsOf([...state.offlineIds, ...offlineIdsOf(ids)]);
    offlineSet = new Set(merged);
    if (merged.length !== state.offlineIds.length) publish({ offlineIds: merged });
    return done({ offlineCount: merged.length });
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
   * 取不到地址时"下一首"落在哪（按当前模式）；单曲循环也前进，到头同样停住，没有下一首就是 `null`。
   * @returns {number|null}
   */
  function skipTargetOf(index) {
    const length = state.entries.length;
    if (length <= 1) return null;
    const target =
      state.mode === "shuffle"
        ? shuffleNext()
        : state.mode === "list-loop"
          ? (index + 1) % length
          : index + 1;
    // 绕回自己（只有单曲队列会这样，上面已经挡掉）或越界都不算"还有下一首"
    if (!Number.isInteger(target) || target < 0 || target >= length || target === index) return null;
    return target;
  }

  /**
   * 取地址 → 过闸门。任何一步失败都回结构化错误，**且消息里没有地址**。
   * @returns {Promise<{ok: true, url: string, quality: "standard"|"high"|"lossless"|null} | {ok: false, error: {kind: string, message: string}}>}
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

    const data = answer.data !== null && typeof answer.data === "object" ? answer.data : null;
    const raw = data === null ? null : data.url;
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
    return { ok: true, url: safe, quality: declaredQualityOf(data === null ? null : data.actualQuality) };
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
   * 已知失败后按原有跳歌上限继续，或在无目标/到上限时停在错误态。
   */
  function skipOrFail(index, entry, error, skipped, { local = false } = {}) {
    const skippedItems = [...skipped, { label: trackLabelOf(entry), kind: error.kind }];
    const transient = skippedItems.filter((item) => !UNPLAYABLE_SKIP_KINDS.has(item.kind)).length;
    const unplayable = skippedItems.length - transient;
    const exhausted = transient >= MAX_CONSECUTIVE_SKIPS || unplayable >= MAX_UNPLAYABLE_SKIPS;
    const target = exhausted ? null : skipTargetOf(index);
    if (target === null) {
      if (!local) {
        log(`播放地址取不到，不再跳歌：${entry.id}｜${error.kind}｜临时失败 ${transient} 首、不可播 ${unplayable} 首`);
      }
      return failPlayback(error.kind, error.message);
    }
    if (!local) {
      log(`播放地址取不到，自动跳下一首：${entry.id}｜${error.kind}｜临时失败 ${transient} 首、不可播 ${unplayable} 首`);
    }
    return start(target, { manual: false, skipped: skippedItems });
  }

  /**
   * 装载并播放第 `index` 首（`manual: true` 在随机模式下以这一首开头重开一轮）。
   * `skipped` 只在自动跳歌的递归里传（已跳过的曲目 `{label, kind}` 列表）。
   */
  async function start(index, { manual = true, skipped = [] } = {}) {
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
    if (offlineSet.has(entry.id)) {
      return skipOrFail(
        index,
        entry,
        { kind: "content_offline", message: "已知已下架，本地跳过（未请求播放地址）" },
        skipped,
        { local: true },
      );
    }
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
      // 一次新的开始 = 上一条跳歌说明到此为止（真跳过的会在装载成功后重新写上）
      notice: null,
      ...(sameLoaded
        ? {}
        : {
            loaded: false,
            // 新曲目还没装载：上一首的音质到此为止（装载成功后按解析结果重新写）
            quality: null,
            currentTimeMs: resumeMs ?? 0,
            durationMs: totalDurationMsOf(entry, reportedDurationMs),
            status: PLAYER_STATUS.loading,
          }),
    });
    persist();

    if (!sameLoaded) {
      const resolved = await resolveAddress(entry.id);
      if (activeToken !== token) return done({ stale: true });
      if (!resolved.ok) {
        // 服务端已判下架/不存在：记进清单（列表据此变灰并禁播），再按原有规则决定跳不跳
        if (UNPLAYABLE_SKIP_KINDS.has(resolved.error.kind)) rememberOffline(entry.id);
        return skipOrFail(index, entry, resolved.error, skipped);
      }

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
      publish({ loaded: true, quality: resolved.quality });
    }

    // 说清跳过了哪几首：这是说明不是故障，状态照常进 playing
    if (skipped.length > 0) publish({ notice: skipNoticeOf(skipped) });
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
    // 暂停了：上一条跳歌说明也过时了
    publish({ status: PLAYER_STATUS.paused, notice: null });
    // 暂停后可能就此关掉应用：位置立刻落盘，不等节流
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
    const { playable, dropped } = partitionPlayable(items, offlineSet);
    if (playable.length === 0 && dropped > 0) {
      notify(ALL_OFFLINE_TEXT);
      return { ok: false, error: { kind: "content_offline", message: ALL_OFFLINE_TEXT } };
    }
    if (dropped > 0) notify(offlineSkippedText(dropped));
    const entries = queueEntriesOf(playable);
    const index = entries.length === 0 ? -1 : playableStartIndex(items, startIndex, offlineSet);
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
      quality: null,
      currentTimeMs: 0,
      durationMs: totalDurationMsOf(index >= 0 ? entries[index] : null, 0),
      error: null,
      notice: null,
    });
    persist();
    return done({ queueLength: entries.length, index, ...(dropped > 0 ? { skippedOffline: dropped } : {}) });
  }

  async function playQueue(items, startIndex = 0) {
    const queued = setQueue(items, startIndex);
    if (!queued.ok) return queued;
    if (queued.data.queueLength === 0) {
      return failEmpty(PLAYER_ERROR_KINDS.queueEmpty, "播放队列是空的（先在列表里双击一首歌）");
    }
    const result = await start(queued.data.index, { manual: true });
    if (queued.data.skippedOffline === undefined) return result;
    return { ...result, data: { ...(result.data ?? {}), skippedOffline: queued.data.skippedOffline } };
  }

  /**
   * 往队列末尾追加：只动落点，不动正在播的那一首。
   * 空队列时追加 = 建立队列并停在第一首（不自动开播），不去重、不排序，已装载的那首不动；空列表不写盘。
   * @returns {{ok: true, data: {added: number, queueLength: number, index: number, skippedOffline?: number}}}
   */
  function enqueue(items) {
    const { playable, dropped } = partitionPlayable(items, offlineSet);
    if (dropped > 0) notify(offlineSkippedText(dropped));
    const appended = queueEntriesOf(playable);
    if (appended.length === 0) {
      return done({ added: 0, queueLength: state.entries.length, index: state.index, ...(dropped > 0 ? { skippedOffline: dropped } : {}) });
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
    return done({ added: appended.length, queueLength: entries.length, index, ...(dropped > 0 ? { skippedOffline: dropped } : {}) });
  }

  /**
   * 插到当前曲目之后（「下一首播放」）：与 `enqueue` 只差落点，其余纪律一致。
   */
  function playNext(items) {
    const { playable, dropped } = partitionPlayable(items, offlineSet);
    if (dropped > 0) notify(offlineSkippedText(dropped));
    const appended = queueEntriesOf(playable);
    if (appended.length === 0) {
      return done({ added: 0, queueLength: state.entries.length, index: state.index, ...(dropped > 0 ? { skippedOffline: dropped } : {}) });
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
    return done({ added: appended.length, queueLength: entries.length, index, ...(dropped > 0 ? { skippedOffline: dropped } : {}) });
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
      quality: null,
      currentTimeMs: 0,
      durationMs: 0,
      error: null,
      notice: null,
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
      quality: null,
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
    hydrateOfflineIds,
    clear,
    restore,
  };
}
