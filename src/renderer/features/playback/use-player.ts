/**
 * 播放状态的 React 接线（R9）：把模块级单例的播放运行时接进组件树。
 *
 * 两个刻意的选择：
 * - **单例在模块层，不在 `useRef`**：React 严格模式会双挂载组件，而音频元素、媒体会话、
 *   广播订阅都是"系统级资源"——建在 ref 里就会有两个 Audio 同时出声（旧仓的经典 bug）；
 * - **`useSyncExternalStore`**：状态机每次变化都换一个新的状态对象（`player.mjs` 里是
 *   不可变替换），所以引用比较就是可靠的"变没变"判据，不需要再抄一份 selector 逻辑。
 */
import { useSyncExternalStore } from "react";

import { getPlayerRuntime, type PlayerRuntime } from "./player-runtime.ts";

/** 播放状态的形状（唯一真源是 `player.mjs` 里的状态对象）。 */
export type PlayerState = ReturnType<PlayerRuntime["player"]["snapshot"]>;

export interface PlayerBinding {
  runtime: PlayerRuntime;
  state: PlayerState;
}

/** 订阅播放状态；返回运行时（动作直接调它的方法与状态机说话）。 */
export function usePlayer(): PlayerBinding {
  const runtime = getPlayerRuntime();
  const state = useSyncExternalStore(
    (listener) => runtime.player.subscribe(listener),
    () => runtime.player.snapshot(),
    () => runtime.player.snapshot(),
  );
  return { runtime, state };
}
