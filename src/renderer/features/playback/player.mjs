/**
 * 播放状态机（R9）：**一个 Audio 实例**的全部行为都在这里，但这里没有 Audio。
 *
 * 端口全部注入（所以每条路径都能在 node 里跑完，也让"地址闸门"成为不可绕过的结构）：
 * - `audio`：音频端口（`setSource/play/pause/setCurrentTime/setVolume/setMuted/on`）。
 *   真实实现是 `features/playback/audio-element.mjs`——**全应用只有那里 new Audio()**；
 * - `resolveUrl(trackId)`：取**当次**播放地址（走 core 的 `playback:resolve-url`）；
 * - `guardUrl(url)`：地址闸门（`features/playback/media-url.mjs` → CSP 的 media-src 白名单）。
 *   **构造时缺它就抛**：闸门不能是可选参数，否则"忘了校验"会变成默认放行；
 * - `persistQueue` / `loadQueue`：队列持久化（只存曲目标识 + 当前索引，见 queue.mjs）；
 * - `log`：只写**不该打扰用户**的失败（落盘失败、恢复失败），**绝不写播放地址**；
 * - `random`：随机的注入点（测试用确定序列）。
 *
 * 四条设计裁决：
 * 1. **状态里没有地址**。地址只活在 `loadedId` 与音频元素之间；快照里只有 `loaded: boolean`。
 *    这样"地址不写日志/不进 UI/不落盘"是结构事实，而不是靠人自觉。
 * 2. **双击不打架**：每次装载领一个令牌，取地址回来后令牌对不上就整包丢掉（网络乱序是常态）。
 * 3. **播完按模式走**：顺序（播完即停）/ 列表循环 / 单曲循环 / 随机；随机走**轮换排列**——
 *    "上一首"在随机模式下才有意义（真随机退不回去），且一轮内不重复。
 * 4. **换队列 = 停止播放**：队列被替换后，音频里装着的还是上一首，装作没发生只会播错歌。
 */
import { queueEntriesOf, queueRecordOf, restoredEntries, sanitizeQueueRecord } from "./queue.mjs";
import { LYRICS_STATUS } from "../lyrics/lyrics-window.mjs";

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

/** 音频端口会发的事件（真实元素的适配见 audio-element.mjs）。 */
export const PLAYER_AUDIO_EVENTS = ["ended", "error", "loadedmetadata", "timeupdate", "playing", "waiting"];

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
 *
 * @param {object} options
 * @param {object} options.audio 音频端口（单实例！真实实现见 audio-element.mjs）
 * @param {(trackId: string) => Promise<{ok: true, data: {url?: unknown}} | {ok: false, error: {message?: string, kind?: string}}>} options.resolveUrl
 * @param {(url: string) => (string|null)} options.guardUrl 媒体白名单闸门（放行回归一化地址，否则 null）
 * @param {(record: object|null) => unknown} [options.persistQueue]
 * @param {() => Promise<unknown>} [options.loadQueue]
 * @param {(...parts: unknown[]) => void} [options.log]
 * @param {() => number} [options.random]
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

  /** 当前装载进音频元素的曲目标识（**地址不留在状态里**，所以这里只记标识）。 */
  let loadedId = null;
  /** 装载令牌：取地址回来时对不上就丢弃（双击连点/快速切歌的乱序保护）。 */
  let token = 0;
  /** 上次真正写盘的记录（去重：拖进度、改音量都不该写盘，队列没变更不该写）。 */
  let persistedKey = "\u0000initial";
  /** 随机模式的轮换排列与游标（一轮内不重复，且"上一首"退得回去）。 */
  let order = [];
  let cursor = 0;

  /**
   * 状态是**不可变替换**的：React 的 useSyncExternalStore 靠引用比较认变化。
   * 形状写在 JSDoc 里，TS 侧（use-player.ts / 组件 props）才拿得到准确的类型——
   * 否则 `entries: []` 会被推断成 `never[]`，界面上取字段就会红。
   *
   * @type {{
   *   status: string,
   *   error: {kind: string, message: string}|null,
   *   entries: Array<{id: string, name: string|null, artists: string|null, duration: number|null}>,
   *   index: number,
   *   track: {id: string, name: string|null, artists: string|null, duration: number|null}|null,
   *   loaded: boolean,
   *   currentTimeMs: number,
   *   durationMs: number,
   *   volume: number,
   *   muted: boolean,
   *   mode: string,
   *   seekGeneration: number,
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

  /** 写盘：同步发起（不阻塞状态更新），失败只记日志且不含地址。 */
  function persist() {
    const record = queueRecordOf(state.entries, state.index);
    const key = JSON.stringify(record);
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
    publish({ currentTimeMs: 0, seekGeneration: state.seekGeneration + 1, error: null });
    if (state.status === PLAYER_STATUS.playing) return playAudio();
    return done({ status: state.status, index: state.index });
  }

  /**
   * 装载并播放第 `index` 首。
   *
   * `manual: true`（用户点的）在随机模式下会**以这一首开头重开一轮**——否则用户点了第 5 首，
   * 下一首会跳到某个随机位置，"我点的那首去哪了"。
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
    publish({
      index,
      track: entry,
      error: null,
      ...(sameLoaded
        ? {}
        : { loaded: false, currentTimeMs: 0, durationMs: 0, status: PLAYER_STATUS.loading }),
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
      publish({ currentTimeMs: 0 });
    }
    return playAudio();
  }

  function pause() {
    if (state.status !== PLAYER_STATUS.playing && state.status !== PLAYER_STATUS.loading) {
      return done({ status: state.status });
    }
    audio.pause();
    publish({ status: PLAYER_STATUS.paused });
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
      publish({ currentTimeMs: 0, seekGeneration: state.seekGeneration + 1, error: null });
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
    stopAudio();
    publish({
      entries,
      index,
      track: index >= 0 ? entries[index] : null,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: 0,
      durationMs: 0,
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
   * 往队列**末尾追加**（R40；歌单详情页的「加入队列」）。
   *
   * 与 `setQueue`/`playQueue` 的区别只有一件事：**不动正在播的那一首**。整队替换会把音频
   * 里装着的上一首打回停止（换队列 = 停止播放，那是对的语义），而"加入队列"不是换队列——
   * 用户要的是"这些排到后面去"，正在响的那一首必须继续响。
   *
   * 四条边界：
   * 1. **空队列时追加 = 建立队列并停在第一首**（`index` 从 -1 变成 0，出现可播曲目），
   *    但**不自动开播**：没有用户手势的出声是打扰（与 `restore` 同一条纪律）；
   * 2. **不去重、不排序**：同一首歌在队列里出现两次是合法的（`queueEntriesOf` 的既有语义），
   *    追加的语义就是"把这一批原样排到后面"；
   * 3. **已装载的那一首不动**：`loadedId` 与音频源都不碰（只有整队替换才需要作废它们）；
   * 4. 空列表/没有标识的条目一律不产生变化（`added: 0`），不写盘（`persist` 自己会去重）。
   *
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
    publish({
      entries,
      index,
      track: entries[index] ?? null,
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
    stopAudio();
    publish({
      entries: [],
      index: -1,
      track: null,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: 0,
      durationMs: 0,
      error: null,
    });
    persist();
    return done({ queueLength: 0 });
  }

  /** 恢复上次的队列：**只还原队列与索引，不开始播放**（没有用户手势的自动出声是打扰）。 */
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
    token += 1;
    loadedId = null;
    order = [];
    cursor = 0;
    publish({
      entries,
      index: clean.index,
      track: entries[clean.index] ?? null,
      status: PLAYER_STATUS.idle,
      loaded: false,
      currentTimeMs: 0,
      durationMs: 0,
      error: null,
      restored: true,
    });
    // 读回来的东西不写回去：同内容重写只是多一次磁盘写入（写坏 settings.json 的机会 +1）
    persistedKey = JSON.stringify(queueRecordOf(entries, clean.index));
    return done({ restored: true, queueLength: entries.length });
  }

  function seek(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return rejectCommand("seek 需要毫秒数字");
    const upper = state.durationMs > 0 ? state.durationMs : Math.max(0, value);
    const target = Math.round(clamp(value, 0, upper));
    audio.setCurrentTime(target);
    publish({ currentTimeMs: target, seekGeneration: state.seekGeneration + 1 });
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
   * 歌词行（AMLL 的 `LyricLine[]`）：状态机只做**搬运**，解析在 features/lyrics/amll-adapter.ts。
   * `status` 是"不冒充"的关键：`unavailable`（来源没配/还没请求）、`loading`（正在取）、
   * `empty`（取了，这首没有）、`failed`（取不到）、`ready`。把前者说成后者，就是替接口撒谎。
   *
   * R12 增补第二个参数：主窗在"还没有行但要说清是哪一档"的情形（loading / failed /
   * unavailable）下把状态显式给出来。给的值必须出自 `LYRICS_STATUS`（同一份词表），
   * 认不出的按行数推断（绝不把任意字符串当状态发给界面）。
   *
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
  listen("loadedmetadata", (payload) => {
    const durationMs = millisOfSeconds(payload?.duration);
    publish({ durationMs: durationMs ?? 0 });
  });
  listen("timeupdate", (payload) => {
    const currentTimeMs = millisOfSeconds(payload?.currentTime);
    if (currentTimeMs !== null) publish({ currentTimeMs });
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
    playAt: (index) => start(index, { manual: true }),
    play,
    pause,
    toggle,
    next,
    previous,
    seek,
    setVolume,
    setMuted,
    toggleMute,
    setMode,
    setLyrics,
    clear,
    restore,
  };
}
