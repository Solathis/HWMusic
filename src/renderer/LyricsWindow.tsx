/** AMLL 只消费主窗文档/进度；配置与媒体入口走受限专命令，不创建播放器或音频。 */
import { LyricPlayer } from "@applemusic-like-lyrics/react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
// 缩放拖柄用 `MoveDiagonal2`：brief 点名的 `GripDiagonal` 在本仓钉住的 lucide-react 0.468.0
// 里不存在（只有 Grip / GripHorizontal / GripVertical），而"不新增依赖"是硬约束——
// 对角双箭头正是缩放手柄的形状，语义与几何都对（报告里如实登记了这处替换）。
import { MoveDiagonal2, GripHorizontal, Lock, Unlock, Pause, Play, SkipBack, SkipForward, Settings2 } from "lucide-react"

import { LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts"
import { coreLyricsConfigure, coreLyricsControl, onCoreEvent, signalLyricsReady } from "./host-api"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import { ScrollArea } from "./components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet"
import { Switch } from "./components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { LYRICS_SEEK_WINDOW_MS } from "./features/lyrics/lyric-sync.mjs"
import {
  LYRICS_STATUS,
  dragRegionEnabled,
  effectiveSizeId,
  estimateTimeMs,
  isCustomColor,
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

/**
 * R45B fix4：这一下是不是按在**歌词播放器自己的原生滚动条**上。
 *
 * 桌面歌词窗的歌词区整块都在 `onMouseDownCapture={startDrag}` 里（按住正文就拖窗口）。
 * 竖排小窗（240×120 + 特大字号）装不下整行时，播放器底边会画出浏览器自己的横向滚动条——
 * 那条滚动条在真窗里必须归浏览器：按下它若还去调 `startDragging()`，OS 的窗口移动循环会接管指针，
 * 滚动条就永远拖不动（fix3 实测：按下滚动条的 mousedown 确实落在 `.amll-lyric-player` 上）。
 *
 * 判据只用**滚动条真正占掉的那一条**，不放宽整块歌词区：
 * - 目标在 `.amll-lyric-player` 里（它自己或子树——命中测试会把条算在它头上）；
 * - 位置落在它的滚动条带上：横向条贴底边（`offsetHeight - clientHeight` 那么厚），
 *   纵向条贴右边（`offsetWidth - clientWidth`）。没有条（厚度 0）时这里恒为 false。
 * 缩放拖柄自己 `stopPropagation`，与本函数无关。
 */
function lyricScrollbarHit(target: Element, event: { clientX: number; clientY: number }): boolean {
  const player = target.closest<HTMLElement>(".amll-lyric-player")
  if (player === null) return false
  const rect = player.getBoundingClientRect()
  const barY = player.offsetHeight - player.clientHeight
  const barX = player.offsetWidth - player.clientWidth
  return (barY > 0 && event.clientY >= rect.top + player.clientHeight)
    || (barX > 0 && event.clientX >= rect.left + player.clientWidth)
}

/**
 * 拖拽缩放后多久算"尺寸稳定"（R45B）：拖动过程中每一帧都保存会把配置刷成几百条，
 * 而用户要的只是**最后**那一次。250ms 是"手一松就到了"的量级，也不至于让重启前的
 * 快速拖拽丢尺寸。
 */
export const RESIZE_SAVE_DELAY_MS = 250

export function LyricsWindow() {
  // 初值来自建窗时拼的查询串（Rust 侧按当前配置拼）：渲染层还没订阅事件时也不会丢配置
  const [config, setConfig] = useState(() => lyricsConfigFromSearch(window.location.search))
  const [lyricDocument, setLyricDocument] = useState<LyricsDocument>(INITIAL_DOCUMENT)
  const [frame, setFrame] = useState({ time: 0, isSeeking: false })

  const progressRef = useRef<LyricsProgress | null>(null)
  const seekDeadlineRef = useRef(0)
  const seekSeenRef = useRef(0)
  const revisionRef = useRef(-1)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // R44e：持久化状态由 Rust 报告（这一层不保存任何东西）。保存失败也要在这个窗里看得见、点得动。
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
    // R44e：主题也走共享的单调接受器（旧广播/旧回执不许盖掉新主题）
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
        },
      ).then(keep),
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

  // R45B：自定义颜色只写在**这一个容器**上（一次 scoped 变量覆盖，变量名与写法都在适配层），
  // 空值就撤掉覆盖回设计令牌；变量的接线点仍然只在 css 与适配层（这里不出现 AMLL 变量名）。
  useEffect(() => {
    applyCustomColor(stageRef.current, config.customColor)
  }, [config.customColor])

  /**
   * R45B：尺寸稳定 250ms 后保存 DIP 宽高（保存与落盘仍由 Rust 拥有，这里只发一条窄命令）。
   *
   * 三条克制：
   * - 只在**未锁的桌面窗**上装监听（锁定/任务栏时 Rust 把窗口设成不可缩放，装监听等于存噪声）；
   * - 与已保存的值相同就不发（程序化摆几何、方向切换后的重排都不产生无谓的写入）；
   * - `configure` 是稳定引用、依赖只列四个标量——否则每帧 `frame` 重渲染都会把计时器清掉，
   *   250ms 永远等不到。
   */
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

  const size = effectiveSizeId(config)
  const hasLyric = lyricDocument.lines.length > 0
  const notice = lyricsNoticeText(lyricDocument)
  const canDrag = dragRegionEnabled(config)
  // R45B：行级 LRC 在这里推导出逐字词（纯函数；词级源原样保留），官方组件负责着色
  const playerLines = useMemo(() => withKaraokeWords(lyricDocument.lines), [lyricDocument.lines])
  const canResize = resizableEnabled(config)
  const startDrag = (event: MouseEvent, grip = false) => {
    if (!canDrag || event.button !== 0) return
    if (!grip && (event.target as Element).closest('button, input, select, textarea, a, [role="button"], [role="slider"], [role="menu"], [role="switch"]')) return
    // fix4：按在播放器的原生滚动条上 = 用户在滚歌词，不许变成拖窗口（也不 preventDefault，条自己拖）
    if (!grip && lyricScrollbarHit(event.target as Element, event)) return
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
  /**
   * 锁定开关（R45B）：`locked=true` 显示 **Lock**（表示已锁），未锁显示 Unlock（表示可以锁）。
   *
   * 无障碍名称把"现在是什么 + 点下去会怎样"说全：`aria-pressed` 让人知道这是个按压态开关。
   */
  /**
   * R46：外观设置面。
   *
   * 为什么不再是 DropdownMenu：这个窗默认只有 160px 高（960×160），菜单是"往下长"的浮层，
   * 样式 2 项 + 方向 2 项 + 4 个复选框根本装不下——`.tmp/probe/settings-lyrics.png` 抓到的就是
   * 被窗口底边切断的菜单（最后两个开关点不到）。换成 shadcn 的 Sheet：面板高度以**窗口**为上限
   * （`max-h-[100dvh]`），正文区用 shadcn `ScrollArea` 自己滚（仓里的规矩：面板不许自搭滚动容器），
   * 每个控件都够得着。
   *
   * 颜色（brief 第 3 项）：原生 `type=color` + 「恢复主题色」，写的是既有的 `customColor` 字段
   * （合法 hex 判定来自 `lyrics-window.mjs` 的 `isCustomColor`，这里不另抄正则），
   * 落盘仍由 Rust 拥有——这里只发一条窄 `core_lyrics_configure`。
   */
  const customColorValue = isCustomColor(config.customColor) ? config.customColor : null
  /**
   * 面板开合状态**提到这一层**（受控）：换样式会把 `controls` 所在的子树从 `<div>` 换成 `<Card>`
   * （结构变了，React 会重挂），面板若自己持有开合状态就会在点「面板」的瞬间自己关掉。
   */
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  /** 样式/方向的档位按钮：两枚按压态按钮在 160px 高的窗里比下拉菜单稳（菜单会被窗口裁掉）。 */
  const choiceButton = (active: boolean, label: string, onPick: () => void, testId: string, disabled = false) => (
    <Button variant={active ? "secondary" : "ghost"} size="sm" aria-pressed={active} data-testid={testId}
      disabled={disabled} onClick={onPick}>{label}</Button>
  )
  const appearancePanel = (
    <Sheet open={appearanceOpen} onOpenChange={setAppearanceOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="桌面歌词外观" data-testid="lyrics-appearance"><Settings2 /></Button>
      </SheetTrigger>
      <SheetContent side="right" data-testid="lyrics-appearance-panel"
        className="w-72 max-w-[calc(100%-0.5rem)] max-h-[100dvh] gap-0 p-0">
        <SheetHeader className="shrink-0 gap-1 p-3 pb-1">
          <SheetTitle>桌面歌词外观</SheetTitle>
          <SheetDescription>小窗里也能改：内容可滚动，设置立即生效并保存。</SheetDescription>
        </SheetHeader>
        <ScrollArea data-testid="lyrics-appearance-scroll" className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3 pt-2">
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">样式</p>
              <div className="flex flex-wrap gap-1">
                {choiceButton(config.style === "clean", "透明", () => configure({ style: "clean" }), "lyrics-style-clean")}
                {choiceButton(config.style === "panel", "面板", () => configure({ style: "panel" }), "lyrics-style-panel")}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">方向（竖版为逐字竖排）</p>
              <div className="flex flex-wrap gap-1">
                {choiceButton(config.layout === "horizontal", "横版", () => configure({ layout: "horizontal" }), "lyrics-layout-horizontal")}
                {choiceButton(config.layout === "vertical", "竖版", () => configure({ layout: "vertical" }), "lyrics-layout-vertical", config.mode === "taskbar")}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {([["enableBlur", "模糊"], ["enableScale", "缩放"], ["enableSpring", "弹簧动画"], ["showControls", "媒体按钮"]] as const).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <Label htmlFor={`lyrics-window-${key}`}>{label}</Label>
                  <Switch id={`lyrics-window-${key}`} data-testid={`lyrics-window-${key}`} checked={config[key]}
                    onCheckedChange={(checked) => configure({ [key]: checked })} />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="lyrics-appearance-color">颜色</Label>
              <div className="flex items-center gap-2">
                {/* 非受控（`defaultValue` + 按存档值换 key）：`type=color` 的受控值必须始终合法，
                    而"还没选过"不该由页面编一个色值出来（颜色一律来自令牌或用户自己选的那个）。 */}
                <Input key={customColorValue ?? "theme"} id="lyrics-appearance-color" data-testid="lyrics-appearance-color"
                  type="color" aria-label="自定义歌词颜色" className="h-8 w-14 shrink-0 p-0"
                  defaultValue={customColorValue ?? undefined}
                  onChange={(event) => {
                    const value = event.target.value
                    if (!isCustomColor(value)) return
                    configure({ customColor: value })
                  }} />
                <Button variant="ghost" size="sm" data-testid="lyrics-appearance-color-reset" disabled={customColorValue === null}
                  onClick={() => configure({ customColor: "" })}>恢复主题色</Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {customColorValue === null ? "现在用设计令牌里的颜色" : `使用自定义颜色 ${customColorValue}`}
              </p>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
  const lockButton = (
    <Button variant="ghost" size="icon-sm" aria-pressed={config.locked}
      aria-label={config.locked ? "已锁定桌面歌词（点击解锁）" : "锁定桌面歌词"}
      onClick={() => configure({ locked: !config.locked })}>{config.locked ? <Lock /> : <Unlock />}</Button>
  )
  /** 锁定后的全部控制：只有一个解锁按钮，且要**悬停或键盘聚焦**才显形（`group-hover`/`focus-within`）。 */
  const lockedControls = (
    <div className="flex shrink-0 items-center justify-center" data-testid="lyrics-locked-actions">
      <div data-testid="lyrics-unlock-slot"
        className="opacity-0 transition-opacity duration-150 group-hover/locked:opacity-100 group-focus-within/locked:opacity-100">
        {lockButton}
      </div>
    </div>
  )
  const controls = config.locked ? lockedControls : (
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
      {lockButton}
      {appearancePanel}
    </div>
  )
  const content = (
    <div className="relative isolate min-h-0 flex-1" onMouseDownCapture={startDrag}>
      {hasLyric ? <LyricPlayer className="h-full w-full" lyricLines={playerLines}
        currentTime={frame.time} isSeeking={frame.isSeeking} playing={progressRef.current?.playing === true}
        enableBlur={config.enableBlur} enableScale={config.enableScale} enableSpring={config.enableSpring}
        alignAnchor="center" alignPosition={0.5} /> : null}
      {notice === null ? null : <div className="absolute inset-0 flex items-center justify-center p-2">
        <p role="status" className="text-center text-sm text-muted-foreground">{notice}</p>
      </div>}
    </div>
  )

  return <TooltipProvider>
    <div ref={stageRef} className="amll-lyrics-stage group/locked absolute inset-0 isolate flex flex-col overflow-hidden"
      data-testid="lyrics-window" data-lyrics-mode={config.mode}
      data-lyrics-layout={config.mode === "taskbar" ? "horizontal" : config.layout}
      data-lyrics-style={config.style} data-lyrics-size={size}
      data-lyrics-color={config.style === "panel" && config.color === "contrast" ? "foreground" : config.color}
      data-lyrics-locked={config.locked ? "on" : "off"}>
      {config.style === "panel" ? <Card size="sm" className="h-full min-h-0 gap-0 py-0">
        {config.mode === "desktop" ? <CardHeader className={config.locked ? "shrink-0 px-2 py-0" : "shrink-0 px-2 py-1"}>
          <CardTitle className="sr-only">桌面歌词</CardTitle>
          <CardDescription className="sr-only">媒体控制与歌词滚动区（竖版为逐字竖排）</CardDescription>
          {controls}
        </CardHeader> : null}
        <CardContent className="flex min-h-0 flex-1 flex-col px-0">{content}</CardContent>
      </Card> : <>{config.mode === "desktop" ? <div className="shrink-0 p-1">{controls}</div> : null}{content}</>}
      {/* R45B：右下角缩放拖柄（未锁的桌面窗才有；锁定/任务栏连按钮都不存在） */}
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
