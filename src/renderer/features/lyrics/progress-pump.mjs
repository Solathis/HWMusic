/** 订阅播放器通知推送歌词进度；不用 rAF（主窗最小化/被遮挡时帧循环会停），节流交给 pushProgress。 */
import { progressOf } from "./lyrics-window.mjs";

/** @returns {() => void} 退订函数 */
export function createProgressPump({ subscribe, readState, push }) {
  if (typeof subscribe !== "function") throw new TypeError("createProgressPump 需要 subscribe");
  if (typeof readState !== "function") throw new TypeError("createProgressPump 需要 readState");
  if (typeof push !== "function") throw new TypeError("createProgressPump 需要 push");
  const unsubscribe = subscribe(() => push(progressOf(readState())));
  // 订阅即出一帧：启动时恢复到暂停位置，之后可能一直没有新的播放器通知。
  push(progressOf(readState()));
  return () => {
    if (typeof unsubscribe === "function") unsubscribe();
  };
}
