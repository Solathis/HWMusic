/**
 * AMLL 歌词面板：官方 `LyricPlayer` 的宿主，逐行滚动、逐字渐变、弹簧动画、模糊全由官方组件负责。
 * 宿主只做两件事：给一个 100% 尺寸的定位容器；每帧把 `currentTime`（整数毫秒）推给它，并在跳转时标注 `isSeeking`。
 * 沉浸式歌词禁止改色：颜色恒为官方默认变量 + `amll-theme.css` 的令牌基线，改色能力只留给桌面歌词窗。
 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useEffect, useMemo, useRef, useState } from "react"

import { createLyricSync } from "./features/lyrics/lyric-sync.mjs"
import { withKaraokeWords } from "./features/lyrics/amll-adapter.ts"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"

export interface AmllLyricsPanelProps {
  runtime: PlayerRuntime
  /** AMLL 的歌词行（由 features/lyrics/amll-adapter.ts 从 LRC 解析而来） */
  lines: LyricLine[]
  playing: boolean
  /** 状态机里的跳转信号：变了就通知进度泵（200ms 窗口在 lyric-sync 里） */
  seekGeneration: number
}

export function AmllLyricsPanel({ runtime, lines, playing, seekGeneration }: AmllLyricsPanelProps) {
  const player = runtime.player
  const [frame, setFrame] = useState({ time: 0, isSeeking: false })
  const syncRef = useRef<ReturnType<typeof createLyricSync> | null>(null)

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

  /** 行级 LRC → 逐字词（与桌面歌词窗同一个纯函数）；结果按 `lines` 记忆，每帧新建数组会让官方反复重排。 */
  const playerLines = useMemo(() => withKaraokeWords(lines), [lines])

  return (
    <div className="amll-lyrics-stage absolute inset-0 isolate" data-testid="amll-lyrics-panel">
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
