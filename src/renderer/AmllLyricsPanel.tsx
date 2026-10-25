/**
 * AMLL 歌词面板（R9）：AMLL 官方 `LyricPlayer` 的**宿主**。
 *
 * **逐行滚动、逐字渐变、弹簧动画、模糊——全部由官方组件负责**。宿主只做两件事：
 * 1. **定位容器**：给 LyricPlayer 一个 100% 尺寸的盒子（它按容器尺寸排版）；
 * 2. **rAF 逐帧推进度**：`LyricPlayer` 是受控组件，自己不读音频，宿主每帧把
 *    `currentTime`（整数毫秒）推给它，并在跳转时标注 `isSeeking`
 *    ——窗口逻辑在 `features/lyrics/lyric-sync.mjs`（唯一真源），这里只接线。
 *
 * 为什么 `seekGeneration` 来自状态机而不是"比较这一帧与上一帧的进度差"：差值判跳转
 * 会把"卡了一下"也当成拖动（歌词被重排一次，看起来像抽了一下）。seek 是**动作**，
 * 让发起动作的那一层标出来最准。
 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useEffect, useMemo, useRef, useState } from "react"

import { createLyricSync } from "./features/lyrics/lyric-sync.mjs"
import { applyCustomColor, withKaraokeWords } from "./features/lyrics/amll-adapter.ts"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"

export interface AmllLyricsPanelProps {
  runtime: PlayerRuntime
  /** AMLL 的歌词行（由 features/lyrics/amll-adapter.ts 从 LRC 解析而来） */
  lines: LyricLine[]
  playing: boolean
  /** 状态机里的跳转信号：变了就通知进度泵（200ms 窗口在 lyric-sync 里） */
  seekGeneration: number
  /**
   * 自定义歌词颜色（R46）：`#RRGGBB` 或空串。
   *
   * 空串 = 用设计令牌（`amll-theme.css` 的 `[data-lyrics-color]`）；非空时由适配层的
   * `applyCustomColor` 在**这一面**的容器上做一次 scoped 变量覆盖——与桌面歌词窗走的是同一个
   * 函数、同一个配置字段（`lyrics.config.customColor`），不存在第二份颜色状态。
   */
  customColor?: string
}

export function AmllLyricsPanel({ runtime, lines, playing, seekGeneration, customColor = "" }: AmllLyricsPanelProps) {
  const player = runtime.player
  const [frame, setFrame] = useState({ time: 0, isSeeking: false })
  const syncRef = useRef<ReturnType<typeof createLyricSync> | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // 进度泵：挂载就开跑，卸载就停帧（后台页不留 rAF）
  useEffect(() => {
    const sync = createLyricSync({
      readTime: () => player.snapshot().currentTimeMs,
      push: (patch: { time: number; isSeeking: boolean }) => setFrame(patch),
      requestFrame: (callback: () => void) => requestAnimationFrame(callback),
      cancelFrame: (handle: number) => cancelAnimationFrame(handle),
    })
    syncRef.current = sync
    sync.start()
    return () => {
      sync.stop()
      syncRef.current = null
    }
  }, [player])

  // 每一次 seek 都通知一次：连续拖动会不断续期，手停 200ms 后窗口自然关闭。
  // 挂载那一次不算：那时并没有发生跳转，标成 isSeeking 只会让 AMLL 白重排一次。
  const seekSeen = useRef(seekGeneration)
  useEffect(() => {
    if (seekSeen.current === seekGeneration) return
    seekSeen.current = seekGeneration
    syncRef.current?.notifySeek()
  }, [seekGeneration])

  /**
   * R46：行级 LRC → 逐字词（与桌面歌词窗**同一个**纯函数）。
   *
   * 官方 `LyricPlayer` 只在 `words.length > 1` 且词时间不同时才逐字着色；行级 LRC 在官方解析里
   * 只有 1 个词，所以 R45B 之后主窗面板一直只有整行渐变。推导结果按 `lines` 记忆：每帧新建数组
   * 会让官方反复重排（AMLL 的铁律是传进去的数组内容不得再改）。
   */
  const playerLines = useMemo(() => withKaraokeWords(lines), [lines])

  /**
   * R46：自定义颜色只写在**这一个容器**上（一次 scoped 变量覆盖，变量名与写法都在适配层）。
   * 空值就撤掉覆盖回设计令牌——与桌面歌词窗完全同一条路（`applyCustomColor`）。
   */
  useEffect(() => {
    applyCustomColor(stageRef.current, customColor)
  }, [customColor])

  return (
    <div ref={stageRef} className="amll-lyrics-stage absolute inset-0 isolate" data-testid="amll-lyrics-panel">
      <LyricPlayer
        lyricLines={playerLines}
        currentTime={frame.time}
        isSeeking={frame.isSeeking}
        playing={playing}
        alignAnchor="center"
        alignPosition={0.5}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
