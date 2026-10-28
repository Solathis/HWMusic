/**
 * 桌面/任务栏歌词开关的待定意图机：点下去到宿主回执之间的那段时间归它管。
 * 由一个单一主人记得最后一次意图（`pending`），迟到的旧回执不许清掉更新的意图（用序号裁定先后）。
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
 * @param {object} options
 * @param {(target: boolean) => Promise<unknown>} options.send 真发一条「把它变成 target」的命令
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
   * 发起一次意图（`next` = 想让它变成什么；`from` = 哪一面按的），只有最后那一次的回执才有权改状态。
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
