/** AMLL 只消费主窗文档/进度；配置与媒体入口走受限专命令，不创建播放器或音频。 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { GripHorizontal, Lock, Unlock, Pause, Play, SkipBack, SkipForward, Settings2 } from "lucide-react"

import { LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts"
import { coreLyricsConfigure, coreLyricsControl, onCoreEvent, signalLyricsReady } from "./host-api"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu"
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
import { applyThemeChoice } from "./features/theme/theme.mjs"

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
  const [lyricDocument, setLyricDocument] = useState<LyricsDocument>(INITIAL_DOCUMENT)
  const [frame, setFrame] = useState({ time: 0, isSeeking: false })

  const progressRef = useRef<LyricsProgress | null>(null)
  const seekDeadlineRef = useRef(0)
  const seekSeenRef = useRef(0)
  const revisionRef = useRef(-1)
  const [actionError, setActionError] = useState<string | null>(null)
  const acceptConfig = useCallback((payload: unknown) => {
    const next = payload as { ready?: boolean; config?: unknown; revision?: number } | null
    if (next?.ready || !next?.config || !Number.isSafeInteger(next.revision) || next.revision! < revisionRef.current) return
    revisionRef.current = next.revision!
    setConfig(normalizeLyricsConfig(next.config))
  }, [])

  useEffect(() => {
    let alive = true
    const stops: Array<() => void> = []
    const keep = (off: () => void) => {
      if (alive) stops.push(off)
      else off()
    }

    void Promise.all([
      onCoreEvent<LyricsDocument>(LYRICS_DOCUMENT, (payload) => {
        setLyricDocument({
          lines: Array.isArray(payload?.lines) ? payload.lines : [],
          status: typeof payload?.status === "string" ? payload.status : LYRICS_STATUS.unavailable,
        })
      }).then(keep),
      onCoreEvent<unknown>(LYRICS_STATE, (payload) => { if (alive) acceptConfig(payload) }).then(keep),
      onCoreEvent<{ theme?: string }>(THEME_CHANGED, (payload) => {
        applyThemeChoice(document.documentElement, payload?.theme)
      }).then(keep),
      onCoreEvent<{ timeMs?: unknown; playing?: unknown; seekGeneration?: unknown }>(
        LYRICS_PROGRESS,
        (payload) => {
          const timeMs = Number(payload?.timeMs)
          const seekGeneration = Number(payload?.seekGeneration)
          if (Number.isInteger(seekGeneration) && seekGeneration !== seekSeenRef.current) {
            seekSeenRef.current = seekGeneration
            seekDeadlineRef.current = Date.now() + LYRICS_SEEK_WINDOW_MS
          }
          progressRef.current = {
            timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
            playing: payload?.playing === true,
            seekGeneration: Number.isInteger(seekGeneration) ? seekGeneration : 0,
            atMs: Date.now(),
          }
        },
      ).then(keep),
    ]).then(async () => {
      if (!alive) return
      const authoritative = await coreLyricsConfigure({})
      if (!alive) return
      acceptConfig(authoritative)
      await signalLyricsReady()
    }).catch((cause) => {
      if (alive) {
        setLyricDocument({ lines: [], status: LYRICS_STATUS.failed })
        console.warn("[hwmusic-lyrics] 歌词订阅未能就绪：", cause)
      }
    })

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
  const canDrag = dragRegionEnabled(config)
  const startDrag = (event: MouseEvent, grip = false) => {
    if (!canDrag || event.button !== 0) return
    if (!grip && (event.target as Element).closest('button, input, select, textarea, a, [role="button"], [role="slider"], [role="menu"], [role="switch"]')) return
    event.preventDefault()
    void getCurrentWindow().startDragging().catch(() => setActionError("拖动未能开始，请解锁后重试。"))
  }
  const configure = (patch: Partial<typeof config>) => {
    setActionError(null)
    void coreLyricsConfigure(patch).then(acceptConfig).catch(() => setActionError("配置未能应用，请从主窗设置重试。"))
  }
  const control = (action: "toggle" | "previous" | "next") => {
    setActionError(null)
    void coreLyricsControl(action).catch(() => setActionError("媒体动作未能发出，请从主窗重试。"))
  }
  const controls = (
    <div className="flex shrink-0 items-center justify-center gap-1" data-testid="lyrics-controls">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" aria-label="拖动桌面歌词" disabled={!canDrag}
              onMouseDown={(event) => startDrag(event, true)}><GripHorizontal /></Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{canDrag ? "拖动桌面歌词" : "锁定或点透时不可拖动"}</TooltipContent>
      </Tooltip>
      {config.showControls ? <>
        <Button variant="ghost" size="icon-sm" aria-label="上一首" onClick={() => control("previous")}><SkipBack /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={progressRef.current?.playing ? "暂停" : "播放"} onClick={() => control("toggle")}>
          {progressRef.current?.playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="下一首" onClick={() => control("next")}><SkipForward /></Button>
      </> : null}
      <Button variant="ghost" size="icon-sm" aria-label={config.locked ? "解锁桌面歌词" : "锁定桌面歌词"}
        aria-pressed={config.locked} onClick={() => configure({ locked: !config.locked })}>{config.locked ? <Unlock /> : <Lock />}</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="桌面歌词外观"><Settings2 /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuGroup>
            <DropdownMenuLabel>样式</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={config.style} onValueChange={(style) => configure({ style })}>
              <DropdownMenuRadioItem value="clean">透明</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="panel">面板</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>方向（竖版为窄高滚动窗）</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={config.layout} onValueChange={(layout) => configure({ layout })}>
              <DropdownMenuRadioItem value="horizontal">横版</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="vertical" disabled={config.mode === "taskbar"}>竖版</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem checked={config.enableBlur} onCheckedChange={(enableBlur) => configure({ enableBlur })}>模糊</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={config.enableScale} onCheckedChange={(enableScale) => configure({ enableScale })}>缩放</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={config.enableSpring} onCheckedChange={(enableSpring) => configure({ enableSpring })}>弹簧动画</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={config.showControls} onCheckedChange={(showControls) => configure({ showControls })}>媒体按钮</DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
  const content = (
    <div className="relative isolate min-h-0 flex-1" onMouseDownCapture={startDrag}>
      {hasLyric ? <LyricPlayer className="h-full w-full" lyricLines={lyricDocument.lines}
        currentTime={frame.time} isSeeking={frame.isSeeking} playing={progressRef.current?.playing === true}
        enableBlur={config.enableBlur} enableScale={config.enableScale} enableSpring={config.enableSpring}
        alignAnchor="center" alignPosition={0.5} /> : null}
      {notice === null ? null : <div className="absolute inset-0 flex items-center justify-center p-2">
        <p role="status" className="text-center text-sm text-muted-foreground">{notice}</p>
      </div>}
    </div>
  )

  return <TooltipProvider>
    <div className="amll-lyrics-stage absolute inset-0 isolate flex flex-col overflow-hidden"
      data-testid="lyrics-window" data-lyrics-mode={config.mode}
      data-lyrics-layout={config.mode === "taskbar" ? "horizontal" : config.layout}
      data-lyrics-style={config.style} data-lyrics-size={size}
      data-lyrics-color={config.style === "panel" && config.color === "contrast" ? "foreground" : config.color}
      data-lyrics-locked={config.locked ? "on" : "off"}>
      {config.style === "panel" ? <Card size="sm" className="h-full min-h-0 gap-0 py-0">
        {config.mode === "desktop" ? <CardHeader className="shrink-0 px-2 py-1">
          <CardTitle className="sr-only">桌面歌词</CardTitle>
          <CardDescription className="sr-only">媒体控制与窄高歌词滚动窗</CardDescription>
          {controls}
        </CardHeader> : null}
        <CardContent className="flex min-h-0 flex-1 flex-col px-0">{content}</CardContent>
      </Card> : <>{config.mode === "desktop" ? <div className="shrink-0 p-1">{controls}</div> : null}{content}</>}
      {actionError ? <p role="alert" className="shrink-0 text-sm text-muted-foreground">{actionError}</p> : null}
    </div>
  </TooltipProvider>
}
