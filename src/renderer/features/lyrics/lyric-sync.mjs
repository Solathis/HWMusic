/**
 * 歌词进度同步：rAF 逐帧把进度推给 AMLL `LyricPlayer`，外加 200ms 的 `isSeeking` 窗口。
 * `LyricPlayer` 是受控组件：宿主每帧推一次整数毫秒的 `currentTime`，并标注这次变化是否由跳转造成。
 * 拖动窗口取「最后一次 seek 之后 200ms」：连续拖动不断续期，手一停窗口自然过期。
 */

/** `isSeeking` 窗口（毫秒）：最后一次 seek 之后的这段时间内，推送都标注为"跳转中"。 */
export const LYRICS_SEEK_WINDOW_MS = 200;

/** 进度读数 → 整数毫秒；读不到数字回 `null`（那一帧不推），而不是推 0。 */
export function integerMsOf(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.round(number));
}

/**
 * 该不该推（纯函数，便于单独钉）。
 * @param {{time: number, isSeeking: boolean}|null} previous 上一次推出去的值
 * @returns {{time: number, isSeeking: boolean} | null} `null` = 这一帧不用推
 */
export function progressPatchOf(previous, time, isSeeking) {
  if (previous !== null && previous.time === time && previous.isSeeking === isSeeking) return null;
  return { time, isSeeking };
}

/**
 * 造一个歌词进度泵。
 * @param {object} options
 * @param {() => number} options.readTime 读当前进度（毫秒）
 * @param {(patch: {time: number, isSeeking: boolean}) => void} options.push 推送（组件里 = setState）
 * @param {(callback: () => void) => number} options.requestFrame 帧调度（组件里 = requestAnimationFrame）
 * @param {(handle: number) => void} options.cancelFrame
 * @param {() => number} [options.now] 时钟（毫秒；只用来判窗口）
 * @param {number} [options.windowMs]
 */
export function createLyricSync(options = {}) {
  const { readTime, push, requestFrame, cancelFrame } = options;
  if (typeof readTime !== "function" || typeof push !== "function") {
    throw new TypeError("createLyricSync 需要 readTime 与 push");
  }
  if (typeof requestFrame !== "function") {
    throw new TypeError("createLyricSync 需要注入 requestFrame（组件里传 requestAnimationFrame）");
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : LYRICS_SEEK_WINDOW_MS;

  /** 上一次 seek 的时刻；`-Infinity` = 从来没 seek 过（窗口自然是关的）。 */
  let lastSeekAt = Number.NEGATIVE_INFINITY;
  /** seek 之后的第一帧必须推（哪怕进度值没变）：否则"拖到同一位置"不会让 AMLL 重排。 */
  let forced = false;
  let handle = null;
  let running = false;
  let previous = null;

  function isSeeking() {
    return now() - lastSeekAt < windowMs;
  }

  function frame() {
    handle = null;
    if (!running) return;

    const time = integerMsOf(readTime());
    if (time !== null) {
      const seeking = isSeeking() || forced;
      const patch = forced ? { time, isSeeking: true } : progressPatchOf(previous, time, seeking);
      if (patch !== null) {
        previous = patch;
        push(patch);
      }
    }
    forced = false;

    if (running) handle = requestFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    handle = requestFrame(frame);
  }

  function stop() {
    running = false;
    if (handle !== null) {
      if (typeof cancelFrame === "function") cancelFrame(handle);
      handle = null;
    }
  }

  /** 告诉进度泵"刚刚发生了一次跳转"：窗口续期，且下一帧一定推一次。 */
  function notifySeek() {
    lastSeekAt = now();
    forced = true;
  }

  return {
    start,
    stop,
    notifySeek,
    isSeeking,
    running: () => running,
  };
}
