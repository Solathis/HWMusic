/**
 * 桌面歌词窗（R12）：**只订阅事件**的第三个 AMLL 宿主。
 *
 * 三件事，一件都不多做：
 * 1. **订阅**三条广播（`lyrics:document` 歌词行 / `lyrics:progress` 进度 / `lyrics:state` 配置）。
 *    歌词窗**没有业务频道权限**（`core_call` 只收主窗来源），也不该有——它不需要知道内核、端点、
 *    凭据的任何东西，只需要"现在该显示哪一行、多大、什么颜色"；
 * 2. **交给官方组件**：逐行滚动、逐字渐变、弹簧动画全部由 `@applemusic-like-lyrics/react` 的
 *    `LyricPlayer` 负责（禁自绘）；这里只提供定位容器与逐帧的 `currentTime`；
 * 3. **进度自己平滑一下**：广播是节流的（≥100ms 一条），直接把它当 `currentTime` 会让逐字渐变
 *    每 100ms 跳一格。所以本地按"上次推送 + 经过的真实时间"估计当前时间（纯函数
 *    `estimateTimeMs`，`playing` 为假时停住不动）——这只是把同一条进度插值，不是第二份时钟。
 *
 * 视觉约束（与主窗一致）：颜色/字号经 `data-lyrics-*` 属性交给 `amll-theme.css` 的 AMLL 变量
 * 映射（不写内联样式、不写 AMLL 的歌词变量名），拖动靠 `data-tauri-drag-region`（锁定/任务栏模式不挂）。
 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useEffect, useRef, useState } from "react"

import { LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE } from "../shared/channels.ts"
import { onCoreEvent } from "./host-api"
import { LYRICS_SEEK_WINDOW_MS } from "./features/lyrics/lyric-sync.mjs"
import {
  LYRICS_STATUS,
  dragRegionEnabled,
  effectiveSizeId,
  estimateTimeMs,
  lyricsConfigFromSearch,
  normalizeLyricsConfig,
  reanchorProgress,
} from "./features/lyrics/lyrics-window.mjs"
import { lyricsNoticeText } from "./features/playback/playback-state.mjs"

/** 广播进来的歌词文档（主窗转发的那一份）。 */
interface LyricsDocument {
  lines: LyricLine[]
  status: string
}

/** 广播进来的进度。`atMs` 是**本地**收到的时刻，只在插值时用，不进任何状态。 */
interface LyricsProgress {
  timeMs: number
  playing: boolean
  seekGeneration: number
  atMs: number
}

const INITIAL_DOCUMENT: LyricsDocument = { lines: [], status: LYRICS_STATUS.unavailable }

export function LyricsWindow() {
  // 初值来自建窗时拼的查询串（Rust 侧按当前配置拼）：渲染层还没订阅事件时也不会丢配置
  const [config, setConfig] = useState(() => lyricsConfigFromSearch(window.location.search))
  // 名字不叫 `document`：那会遮蔽全局 `document`（visibilitychange 那条监听要的就是它）
  const [lyricDocument, setLyricDocument] = useState<LyricsDocument>(INITIAL_DOCUMENT)
  const [frame, setFrame] = useState({ time: 0, isSeeking: false })

  const progressRef = useRef<LyricsProgress | null>(null)
  const seekDeadlineRef = useRef(0)
  const seekSeenRef = useRef(0)

  useEffect(() => {
    let alive = true
    const stops: Array<() => void> = []
    const keep = (off: () => void) => {
      if (alive) stops.push(off)
      else off()
    }

    void onCoreEvent<LyricsDocument>(LYRICS_DOCUMENT, (payload) => {
      setLyricDocument({
        lines: Array.isArray(payload?.lines) ? payload.lines : [],
        status: typeof payload?.status === "string" ? payload.status : LYRICS_STATUS.unavailable,
      })
    }).then(keep)

    void onCoreEvent<{ config?: unknown }>(LYRICS_STATE, (payload) => {
      setConfig((current) => normalizeLyricsConfig(payload?.config, current))
    }).then(keep)

    void onCoreEvent<{ timeMs?: unknown; playing?: unknown; seekGeneration?: unknown }>(
      LYRICS_PROGRESS,
      (payload) => {
        const timeMs = Number(payload?.timeMs)
        const seekGeneration = Number(payload?.seekGeneration)
        if (Number.isInteger(seekGeneration) && seekGeneration !== seekSeenRef.current) {
          seekSeenRef.current = seekGeneration
          // 跳转：给 AMLL 一段"正在被拖动"的窗口，手停之后自动收（窗口常量在 lyric-sync.mjs）
          seekDeadlineRef.current = Date.now() + LYRICS_SEEK_WINDOW_MS
        }
        progressRef.current = {
          timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
          playing: payload?.playing === true,
          seekGeneration: Number.isInteger(seekGeneration) ? seekGeneration : 0,
          atMs: Date.now(),
        }
      },
    ).then(keep)

    return () => {
      alive = false
      for (const stop of stops) stop()
    }
  }, [])

  // 逐帧把估计时间推给组件（rAF；卸载停帧，后台不留循环）
  useEffect(() => {
    let handle = 0
    const tick = () => {
      const now = Date.now()
      setFrame({ time: estimateTimeMs(progressRef.current, now), isSeeking: now < seekDeadlineRef.current })
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [])

  // 窗从隐藏变可见：把插值锚点挪到"现在"（藏起来那段时间主窗不推进度，
  // 不重锚的话插值会一次性跳到后面，再被新推送拉回来——看起来像抽了一下）
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        progressRef.current = reanchorProgress(progressRef.current, Date.now())
      }
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [])

  const size = effectiveSizeId(config)
  const hasLyric = lyricDocument.lines.length > 0
  const notice = lyricsNoticeText(lyricDocument)
  // 拖动区只在桌面模式且未锁定时挂（任务栏模式下这条显示带贴在屏幕边上，不给拖）
  const dragAttributes: Record<string, string> = dragRegionEnabled(config)
    ? { "data-tauri-drag-region": "" }
    : {}

  return (
    <div
      {...dragAttributes}
      className="amll-lyrics-stage absolute inset-0 overflow-hidden"
      data-testid="lyrics-window"
      data-lyrics-mode={config.mode}
      data-lyrics-size={size}
      data-lyrics-color={config.color}
      data-lyrics-locked={config.locked ? "on" : "off"}
    >
      {hasLyric ? (
        <LyricPlayer
          className="h-full w-full"
          lyricLines={lyricDocument.lines}
          currentTime={frame.time}
          isSeeking={frame.isSeeking}
          playing={progressRef.current?.playing === true}
          alignAnchor="center"
          alignPosition={0.5}
        />
      ) : null}

      {notice === null ? null : (
        <div className="absolute inset-0 flex items-center justify-center p-2">
          <p role="status" className="text-center text-sm text-muted-foreground">
            {notice}
          </p>
        </div>
      )}
    </div>
  )
}
