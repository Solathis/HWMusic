/**
 * 桌面/任务栏歌词开关的**待定意图机**（R45C）：点下去到宿主回执之间的那段时间归它管。
 *
 * ## 为什么需要这一层（不是多加一层抽象）
 *
 * 开关的目标态来自宿主的权威回执（`visible` / `requestedVisible`），而一条 IPC 要来回一趟。
 * 用户手快、或者宿主慢的时候，这两次点击都发生在**第一次回执之前**：如果第二次点击仍然按
 * "渲染出来的那一份状态"取反，它算出来的还是第一次那个 `true`——于是窗口收到两条一样的命令，
 * 用户看到的是"点了两下，只翻了一下"，随后又被迟到的回执拽回原状。
 *
 * 所以"下一次该发什么"必须由一个**单一主人**回答：它记得最后一次意图（`pending`），
 * 第二次点击按它取反；另外，**迟到的旧回执不许清掉更新的意图**（用序号裁定先后，
 * 而不是用到达顺序猜）。
 *
 * 这个模块是纯逻辑（不 import React、不发 IPC、不碰计时器）：
 * - `send(target)` 是注入的"真发一条命令"，返回 Promise；
 * - `onChange(snapshot)` 让界面跟着 `{pending, error}` 走；
 * - 失败只产出一句**给用户看的人话**（[`toggleFailureText`]：原因 + 下一步），
 *   原始错误由调用方记日志——界面不该出现"宿主内部错误码"这种话。
 */

/**
 * 失败文案（唯一的出处）。三个成分缺一不可：**哪个歌词**、**为什么没成**、**下一步怎么办**。
 *
 * 刻意不带原始错误消息：那条消息只进日志（`[hwmusic-lyrics]`）。用户要的是"我该怎么办"，
 * 而不是一次 IPC 的内部措辞；而且原始消息可能带回执里的路径/标识，不该糊到界面上。
 *
 * @param {boolean} target 这一次想把它变成什么（true = 打开）
 * @param {"desktop" | "taskbar" | string} [mode] 当前模式（认不出的按桌面说，与开关标签同一条口径）
 * @returns {string}
 */
export function toggleFailureText(target, mode) {
  const surface = mode === "taskbar" ? "任务栏歌词" : "桌面歌词";
  const action = target === true ? "打开" : "关上";
  const next = target === true ? "到设置页确认歌词窗可用" : "到设置页关闭桌面歌词";
  return `${surface}没能${action}：宿主没有确认这次操作。请点「重试」再发一次；仍然失败时${next}。`;
}

/**
 * 造一个意图机。
 *
 * @param {object} options
 * @param {(target: boolean) => Promise<unknown>} options.send 真发一条"把它变成 target"的命令
 * @param {(snapshot: {pending: boolean | null, error: string | null, surface: string | null}) => void} [options.onChange]
 * @param {(target: boolean) => string} [options.failureText] 失败 → 人话（默认 {@link toggleFailureText}）
 */
export function createLyricsToggleIntent({ send, onChange, failureText = toggleFailureText } = {}) {
  /** 最后一次意图的目标态；`null` = 没有待定意图（界面回到权威回执）。 */
  let pending = null;
  /** 给用户看的那一句；`null` = 没有失败。 */
  let error = null;
  /** 最后一次点击的意图（重试重发的是它，不是"当前状态取反"）。 */
  let lastTarget = null;
  /**
   * 这一次意图是从哪个界面发起的（`player-bar` / `playback-stage` / `null` = 设置页或托盘）。
   *
   * 为什么记它：失败的那句话要出现在**按下去的那一面**，而不是两处各印一遍——
   * 同一个失败在界面上只能有一句（toast 也同理，所以这一层不弹 toast）。
   */
  let surface = null;
  let lastSurface = null;
  /** 意图序号：**只有最后那一次的回执**才有权改状态。 */
  let sequence = 0;

  const snapshot = () => ({ pending, error, surface, lastTarget });
  const emit = () => {
    if (typeof onChange === "function") onChange(snapshot());
  };

  /**
   * 发起一次意图（`next` = 想让它变成什么；`from` = 哪一面按的）。
   *
   * 回执回来时：
   * - 我仍是最后一个意图 → 清掉待定（界面交回权威回执）；
   * - 已经有更新的意图 → 什么都不做（旧回执不能把新意图抹掉）；
   * - 失败且我仍是最后一个 → 清待定 + 一句人话（可重试/可关掉）。
   *
   * @param {boolean} next
   * @param {string | null} [from] 哪一面按的（`null` = 设置页/托盘）
   */
  async function request(next, from = null) {
    const target = next === true;
    const mine = ++sequence;
    lastTarget = target;
    lastSurface = typeof from === "string" && from !== "" ? from : null;
    pending = target;
    surface = lastSurface;
    error = null;
    emit();

    try {
      await send(target);
    } catch {
      if (mine !== sequence) return { ok: false, superseded: true, error: null };
      pending = null;
      error = typeof failureText === "function" ? failureText(target) : toggleFailureText(target);
      emit();
      return { ok: false, superseded: false, error };
    }

    if (mine === sequence) {
      pending = null;
      surface = null;
      emit();
    }
    return { ok: true, superseded: mine !== sequence };
  }

  return {
    request,
    /** 重试最后那一次意图（失败之后按钮走这条；发起面不变）。 */
    retry() {
      if (lastTarget === null) return Promise.resolve({ ok: false, superseded: false, error: null });
      return request(lastTarget, lastSurface);
    },
    /** 用户关掉那句提示（不发命令、不改窗口）。 */
    dismiss() {
      if (error === null) return;
      error = null;
      emit();
    },
    snapshot,
  };
}
