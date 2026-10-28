/**
 * player:command 广播的执行侧：命令表（唯一真源）+ 一个只会拒绝不会猜的执行器。
 * 广播白名单是硬白名单，不在名单里的频道会被 Rust 的 FramePolicy 当白名单外帧丢掉。
 * 认不出的命令不执行也不猜，回结构化 invalid_command。
 * 命令是意图不是状态：结果由状态机自己的快照说话，返回值只用来判断有没有受理。
 */
import { PLAYER_ERROR_KINDS } from "./player.mjs";

/** 命令表（托盘/快捷键/桌面歌词窗都从这里取，不另立清单）。 */
export const PLAYER_COMMANDS = ["play", "pause", "toggle", "next", "previous"];

/** 载荷里的命令名是不是已知命令。 */
export function isPlayerCommand(value) {
  return typeof value === "string" && PLAYER_COMMANDS.includes(value);
}

/**
 * 执行一条 player:command 广播载荷。
 * @param {object} player 播放状态机（`createPlayer` 的产物）
 * @param {unknown} payload 广播载荷：`{command: "play" | "pause" | "toggle" | "next" | "previous"}`
 * @returns {Promise<{ok: true, data: unknown} | {ok: false, error: {kind: string, message: string}}>}
 */
export async function applyPlayerCommand(player, payload) {
  const reject = (message) => ({
    ok: false,
    error: { kind: PLAYER_ERROR_KINDS.invalidCommand, message },
  });

  if (player === null || typeof player !== "object") {
    return reject("player:command 需要播放状态机实例");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return reject("player:command 的载荷必须是 {command} 对象");
  }
  if (!isPlayerCommand(payload.command)) {
    return reject(`认不出的播放命令（只接受 ${PLAYER_COMMANDS.join(" / ")}）`);
  }

  switch (payload.command) {
    case "play":
      return player.play();
    case "pause":
      return player.pause();
    case "toggle":
      return player.toggle();
    case "next":
      return player.next();
    case "previous":
      return player.previous();
    default:
      // 命令表加了新项却忘了在这里接线：宁可如实拒绝，也不要静默什么都不做
      return reject("该播放命令尚未接线（命令表与执行器不同步）");
  }
}
