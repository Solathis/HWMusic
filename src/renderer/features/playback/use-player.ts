/**
 * 播放状态的 React 接线：把模块级单例的播放运行时接进组件树。
 * 单例在模块层、不在 useRef：严格模式会双挂载，音频元素 / 媒体会话 / 广播订阅建在 ref 里就会有两个 Audio 同时出声。
 * 用 useSyncExternalStore：状态机每次变化都换新状态对象，引用比较就是可靠的「变没变」判据。
 */
import { useMemo, useSyncExternalStore } from "react";

import { createSelectorCache, selectShellView } from "./player-view.mjs";
import { getPlayerRuntime, type PlayerRuntime } from "./player-runtime.ts";

/**
 * 播放状态的形状（唯一真源是 `player.mjs` 里的状态对象）。
 * `quality` 也在那份 JSDoc 里：给的是**服务端明确声明的**音质，`null` = 没声明（界面一个字都不说）。
 */
export type PlayerState = ReturnType<PlayerRuntime["player"]["snapshot"]>;

/** 当前播放音质：直接取自状态快照（不在这里重复一份取值表）。 */
export type PlaybackQuality = PlayerState["quality"];

/** 编译期对齐：状态里的音质必须正好是这三档（`player.mjs` 多一档/少一档都会在这里报错）。 */
export type PlaybackQualityPinned = Expect<PlaybackQuality extends "standard" | "high" | "lossless" | null ? true : never>;

type Expect<Value extends true> = Value;

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

export function usePlayerSelector<T>(select: (state: PlayerState) => T): T {
  const runtime = getPlayerRuntime();
  const cache = useMemo(() => createSelectorCache(select), [select]);
  return useSyncExternalStore(
    (listener) => runtime.player.subscribe(listener),
    () => cache(runtime.player.snapshot()),
    () => cache(runtime.player.snapshot()),
  );
}

export function usePlayerShell(): { runtime: PlayerRuntime; queue: ReturnType<typeof selectShellView> } {
  const runtime = getPlayerRuntime();
  const queue = usePlayerSelector(selectShellView);
  return { runtime, queue };
}
