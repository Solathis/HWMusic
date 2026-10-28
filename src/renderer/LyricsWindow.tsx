/** AMLL 只消费主窗文档/进度；配置与媒体入口走受限专命令，不创建播放器或音频。 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
// 缩放拖柄用 `MoveDiagonal2`：`GripDiagonal` 在钉住的 lucide-react 0.468.0 里不存在，且不新增依赖。
// 对角双箭头正好是缩放手柄的形状。
import { MoveDiagonal2, GripHorizontal, Lock, Unlock, Pause, Play, SkipBack, SkipForward, Settings2 } from "lucide-react"

import { LYRICS_DOCUMENT, LYRICS_POINTER, LYRICS_PROGRESS, LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts"
import { coreLyricsConfigure, coreLyricsControl, coreLyricsSettingsOpen, coreLyricsUnlockZone, onCoreEvent, signalLyricsReady } from "./host-api"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { LYRICS_SEEK_WINDOW_MS } from "./features/lyrics/lyric-sync.mjs"
import {
  LYRICS_STATUS,
  dragRegionEnabled,
  estimateTimeMs,
  karaokeFrame,
  lyricsAppearance,
  lyricsBackdrop,
  lyricsConfigFromSearch,
  normalizeLyricsConfig,
  reanchorProgress,
  resizableEnabled,
  saveErrorText,
} from "./features/lyrics/lyrics-window.mjs"
import { applyCustomColor, withKaraokeWords } from "./features/lyrics/amll-adapter.ts"
import { lyricsNoticeText } from "./features/playback/playback-state.mjs"
import { createThemeAcceptor } from "./features/theme/theme-accept.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"
import { cn } from "./lib/utils"
import { VerticalLyricColumn } from "./VerticalLyricColumn.tsx"

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

/** 拖拽缩放后 250ms 内没有新变化才保存，避免拖动过程中每帧都写配置。 */
export const RESIZE_SAVE_DELAY_MS = 250

export function LyricsWindow() {
  // 初值来自建窗时拼的查询串（Rust 侧按当前配置拼）：渲染层还没订阅事件时也不会丢配置
  const [config, setConfig] = useState(() => lyricsConfigFromSearch(window.location.search))
  // 光标是否落在歌词窗里（锁定后窗不接收鼠标，这个事实只能由 Rust 轮询广播过来）
  const [pointerInside, setPointerInside] = useState(false)
  const unlockSlotRef = useRef<HTMLDivElement | null>(null)
  // 这份配置实际画成什么样由纯逻辑模块决定（任务栏只读任务栏那四个字段，桌面只读原字段）。
  const appearance = useMemo(() => lyricsAppearance(config), [config])
  const [lyricDocument, setLyricDocument] = useState<LyricsDocument>(INITIAL_DOCUMENT)
  const [frame, setFrame] = useState({ time: 0, isSeeking: false, playing: false })

  const progressRef = useRef<LyricsProgress | null>(null)
  const seekDeadlineRef = useRef(0)
  const seekSeenRef = useRef(0)
  const revisionRef = useRef(-1)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // 持久化状态由 Rust 报告，这一层不保存任何东西；保存失败也要在这个窗里看得见、点得动。
  const [saveError, setSaveError] = useState<string | null>(null)
  const acceptStatus = useCallback((payload: unknown) => {
    const next = payload as { ready?: boolean; config?: unknown; revision?: number; saveError?: unknown } | null
    if (next?.ready || !next?.config || !Number.isSafeInteger(next.revision) || next.revision! < revisionRef.current) return
    revisionRef.current = next.revision!
    setConfig(normalizeLyricsConfig(next.config))
    setSaveError(saveErrorText(typeof next.saveError === "string" ? next.saveError : null))
  }, [])
  const configure = useCallback((patch: Partial<typeof config>) => {
    setActionError(null)
    void coreLyricsConfigure(patch as Record<string, unknown>).then(acceptStatus).catch(() => setActionError("配置未能应用，请从主窗设置重试。"))
  }, [acceptStatus])
  const retrySave = () => {
    setActionError(null)
    void coreLyricsConfigure({}, true)
      .then(acceptStatus)
      .catch(() => setActionError("保存重试未能发出，请从主窗设置重试。"))
  }

  useEffect(() => {
    let alive = true
    const stops: Array<() => void> = []
    // 主题也走共享的单调接受器：旧广播或旧回执不许盖掉新主题。
    const themeAcceptor = createThemeAcceptor((choice) => applyThemeChoice(document.documentElement, choice))
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
      onCoreEvent<unknown>(LYRICS_STATE, (payload) => { if (alive) acceptStatus(payload) }).then(keep),
      onCoreEvent<{ theme?: string; revision?: number }>(THEME_CHANGED, (payload) => {
        themeAcceptor.accept(payload)
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
          // 播放态与时刻**当场**进状态：官方组件的逐字扫亮由它驱动，等帧循环就等于把推进
          // 绑架在帧率上（置顶窗被遮挡、挂到任务栏下的子窗都可能长时间没有帧）
          setFrame(karaokeFrame(progressRef.current, Date.now(), Date.now() < seekDeadlineRef.current))
        },
      ).then(keep),
      onCoreEvent<{ inside?: unknown }>(LYRICS_POINTER, (payload) => { setPointerInside(payload?.inside === true) }).then(keep),
    ]).then(async () => {
      if (!alive) return
      const authoritative = await coreLyricsConfigure({})
      if (!alive) return
      acceptStatus(authoritative)
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

  // 逐帧把估计时间推给组件（rAF；卸载停帧，后台不留循环）。
  // 只更新时刻与跳转窗，`playing` 由进度消息自己更新——那才是唯一来源。
  useEffect(() => {
    let handle = 0
    const tick = () => {
      const now = Date.now()
      setFrame((previous) => ({
        ...previous,
        time: estimateTimeMs(progressRef.current, now),
        isSeeking: now < seekDeadlineRef.current,
      }))
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

  // 自定义颜色只写在当前容器上（空值撤掉覆盖回设计令牌），变量接线点只在 css 与适配层。
  // 颜色取哪一份（桌面 / 任务栏）由纯逻辑模块决定。
  useEffect(() => {
    applyCustomColor(stageRef.current, appearance.customColor)
  }, [appearance.customColor])

  /** 尺寸稳定 250ms 后保存 DIP 宽高；只在未锁的桌面窗上装监听，与已保存的值相同就不发。 */
  const savedWidth = config.windowWidth
  const savedHeight = config.windowHeight
  const { mode, locked, layout } = config
  useEffect(() => {
    if (!resizableEnabled({ mode, layout, locked })) return undefined
    let timer = 0
    const save = () => {
      timer = 0
      const width = Math.round(window.innerWidth)
      const height = Math.round(window.innerHeight)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
      if (width === savedWidth && height === savedHeight) return
      configure({ windowWidth: width, windowHeight: height })
    }
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(save, RESIZE_SAVE_DELAY_MS)
    }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("resize", onResize)
      window.clearTimeout(timer)
    }
  }, [mode, locked, savedWidth, savedHeight, configure])

  // 锁定的桌面歌词把解锁按钮所在区域交给 Rust：光标落到那里时由它临时放开鼠标。
  useEffect(() => {
    const report = () => {
      const node = unlockSlotRef.current
      const rect = node?.getBoundingClientRect()
      const zone = rect === undefined ? null : { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height }
      void coreLyricsUnlockZone(zone).catch((cause: unknown) => console.warn("[hwmusic-lyrics] 解锁区没能上报：", cause))
    }
    if (config.mode !== "desktop" || !config.locked) {
      report()
      return undefined
    }
    report()
    const observer = new ResizeObserver(report)
    if (unlockSlotRef.current !== null) observer.observe(unlockSlotRef.current)
    window.addEventListener("resize", report)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", report)
    }
  }, [config.mode, config.locked])

  // 这一份配置实际画成什么样由纯逻辑模块决定（任务栏只读任务栏那四个字段，桌面只读原字段）。
  const size = appearance.size
  const hasLyric = lyricDocument.lines.length > 0
  const notice = lyricsNoticeText(lyricDocument)
  const canDrag = dragRegionEnabled(config)
  // 行级 LRC 在这里推导出逐字词（纯函数；词级源原样保留），官方组件负责着色。
  // 任务栏关掉逐字高亮时不推导，交给官方组件按行渐变。
  const playerLines = useMemo(
    () => (appearance.karaoke ? withKaraokeWords(lyricDocument.lines) : lyricDocument.lines),
    [lyricDocument.lines, appearance.karaoke],
  )
  const canResize = resizableEnabled(config)
  const startDrag = (event: MouseEvent, grip = false) => {
    if (!canDrag || event.button !== 0) return
    if (!grip && (event.target as Element).closest('button, input, select, textarea, a, [role="button"], [role="slider"], [role="menu"], [role="switch"]')) return
    event.preventDefault()
    void getCurrentWindow().startDragging().catch(() => setActionError("拖动未能开始，请解锁后重试。"))
  }
  const startResize = () => {
    if (!canResize) return
    setActionError(null)
    void getCurrentWindow().startResizeDragging("SouthEast").catch(() => setActionError("缩放未能开始，请解锁后重试。"))
  }
  const control = (action: "toggle" | "previous" | "next") => {
    setActionError(null)
    void coreLyricsControl(action).catch(() => setActionError("媒体动作未能发出，请从主窗重试。"))
  }
  /** 外观设置是另一扇独立小窗（`lyrics-settings`）：齿轮把自己客户区里的 DIP 矩形交给宿主，位置、尺寸、关闭全由 Rust 定。 */
  const openAppearance = (event: MouseEvent<HTMLButtonElement>) => {
    setActionError(null)
    const rect = event.currentTarget.getBoundingClientRect()
    void coreLyricsSettingsOpen({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      .catch(() => setActionError("设置窗口未能打开，请重试。"))
  }
  const appearanceButton = (
    <Button variant="ghost" size="icon-sm" aria-label="桌面歌词外观" data-testid="lyrics-appearance"
      onClick={openAppearance}><Settings2 /></Button>
  )
  /** 锁定开关：`locked=true` 显示 **Lock**（已锁），未锁显示 Unlock；`aria-pressed` 让人知道这是按压态开关。 */
  const lockButton = (
    <Button variant="ghost" size="icon-sm" aria-pressed={config.locked}
      aria-label={config.locked ? "已锁定桌面歌词（点击解锁）" : "锁定桌面歌词"}
      onClick={() => configure({ locked: !config.locked })}>{config.locked ? <Lock /> : <Unlock />}</Button>
  )
  /** 锁定后只有一个解锁按钮：光标进入歌词窗（Rust 广播）、悬停或键盘聚焦时才显示。 */
  const lockedControls = (
    <div className="flex shrink-0 items-center justify-center" data-testid="lyrics-locked-actions">
      <div ref={unlockSlotRef} data-testid="lyrics-unlock-slot"
        className="opacity-0 transition-opacity duration-150 group-hover/locked:opacity-100 group-focus-within/locked:opacity-100 group-data-[pointer=inside]/locked:opacity-100">
        {lockButton}
      </div>
    </div>
  )
  const controls = config.locked ? lockedControls : (
    <div className="flex shrink-0 items-center justify-center gap-0.5" data-testid="lyrics-controls">
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
        <Button variant="ghost" size="icon-sm" aria-label={frame.playing ? "暂停" : "播放"} onClick={() => control("toggle")}>
          {frame.playing ? <Pause /> : <Play />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="下一首" onClick={() => control("next")}><SkipForward /></Button>
      </> : null}
      {lockButton}
      {appearanceButton}
    </div>
  )
  /** 竖版（桌面模式）改由自渲染的单列承担，横版与任务栏仍是官方 `LyricPlayer`。 */
  const vertical = config.mode === "desktop" && config.layout === "vertical"
  const content = (
    <div className="relative isolate min-h-0 flex-1" onMouseDownCapture={startDrag}>
      {hasLyric && vertical ? <VerticalLyricColumn lines={playerLines} timeMs={frame.time} karaoke={appearance.karaoke} /> : null}
      {hasLyric && !vertical ? <LyricPlayer className="h-full w-full" lyricLines={playerLines}
        currentTime={frame.time} isSeeking={frame.isSeeking} playing={frame.playing}
        enableBlur={config.enableBlur} enableScale={config.enableScale} enableSpring={config.enableSpring}
        alignAnchor="center" alignPosition={0.5} /> : null}
      {notice === null ? null : <div className="absolute inset-0 flex items-center justify-center p-2">
        <p role="status" className="text-center text-sm text-muted-foreground">{notice}</p>
      </div>}
    </div>
  )

  /** 透明窗的可读性衬底：clean 用令牌底色、锁定时更淡；panel 锁定时卡片更淡；bare 不加衬底，只给歌词加阴影。 */
  const backdrop = lyricsBackdrop(config)
  const scrim = config.style === "clean" && backdrop !== "none"

  return <TooltipProvider>
    <div
      ref={stageRef}
      className={cn("amll-lyrics-stage group/locked absolute inset-0 isolate flex flex-col overflow-hidden",
        scrim && (backdrop === "light" ? "bg-background/35" : "bg-background/60"),
        config.mode === "desktop" && config.style === "bare" && "drop-shadow-md")}
      data-testid="lyrics-window"
      data-lyrics-scrim={scrim ? "on" : "off"}
      data-lyrics-backdrop={backdrop}
      data-pointer={pointerInside ? "inside" : "outside"}
      data-lyrics-mode={config.mode}
      data-lyrics-layout={config.mode === "taskbar" ? "horizontal" : config.layout}
      data-lyrics-style={config.style} data-lyrics-size={size}
      data-lyrics-color={config.style === "panel" && appearance.color === "contrast" ? "foreground" : appearance.color}
      data-lyrics-karaoke={appearance.karaoke ? "on" : "off"}
      data-lyrics-locked={config.locked ? "on" : "off"}>
      {config.style === "panel" ? <Card size="sm" className={cn("h-full min-h-0 gap-0 py-0", backdrop === "light" && "bg-card/65")}>
        {config.mode === "desktop" ? <CardHeader className={config.locked ? "shrink-0 px-1.5 py-0" : "shrink-0 px-1.5 py-0.5"}>
          <CardTitle className="sr-only">桌面歌词</CardTitle>
          <CardDescription className="sr-only">媒体控制与歌词滚动区（竖版为逐字竖排）</CardDescription>
          {controls}
        </CardHeader> : null}
        <CardContent className="flex min-h-0 flex-1 flex-col px-0">{content}</CardContent>
      </Card> : <>{config.mode === "desktop" ? <div className="shrink-0 px-0.5 pt-0.5">{controls}</div> : null}{content}</>}
      {/* 右下角缩放拖柄（未锁的桌面窗才有） */}
      {canResize ? <div className="absolute bottom-0 right-0 z-10 p-0.5" data-testid="lyrics-resize-handle">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="调整桌面歌词大小" data-testid="lyrics-resize-grip"
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); startResize() }}><MoveDiagonal2 /></Button>
          </TooltipTrigger>
          <TooltipContent side="left">拖动调整大小（锁定后禁用）</TooltipContent>
        </Tooltip>
      </div> : null}
      {actionError ? <p role="alert" className="shrink-0 text-sm text-muted-foreground">{actionError}</p> : null}
      {saveError ? <div role="alert" data-testid="lyrics-save-error" className="flex shrink-0 items-center justify-center gap-2 p-1">
        <p className="text-center text-xs text-muted-foreground">{saveError}</p>
        <Button variant="ghost" size="icon-sm" aria-label="重试保存桌面歌词配置" onClick={retrySave}>重试</Button>
      </div> : null}
    </div>
  </TooltipProvider>
}
