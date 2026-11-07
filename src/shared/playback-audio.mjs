/**
 * 音量与静音的判定真源（主进程的设置归一、播放状态机的默认值与启动恢复都读这一份）。
 * 纯常量与纯函数、不引 node：渲染层与主进程两侧都要能直接 import。
 *
 * 两条不能靠"假值"判的规矩：`0` 是**合法的音量**（用户真的拖到底了），`false` 是**合法的静音状态**；
 * 认不出的值一律 `false`，由调用方决定是回默认还是拒绝写盘。
 */

/** 默认音量：不加不减地放出来（"默认 70%"是拍脑袋，用户没调过就别替他调）。 */
export const DEFAULT_PLAYER_VOLUME = 1;

/** 默认不静音。 */
export const DEFAULT_PLAYER_MUTED = false;

/** 音量：只认 0..1 的有限数字（字符串 "0.5"、NaN、越界都不算"用户设过音量"）。 */
export function isPlayerVolume(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 静音：只认布尔（"true"、1、0 都不是）。 */
export function isPlayerMuted(value) {
  return typeof value === "boolean";
}
