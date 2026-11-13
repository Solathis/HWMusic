import { AutoLyricLayout, BouncingSlider, Cover, MediaButton, MusicInfo, VolumeControl } from "@applemusic-like-lyrics/react-full"
import { AnimatePresence, motion } from "framer-motion"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react"
import { createPortal } from "react-dom"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { ChevronDownIcon, CopyIcon, Disc3Icon, ListMusicIcon, MinusIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, SquareIcon, VolumeXIcon, XIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "./components/ui/avatar"
import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu"
import { AmllBackground, useCoverImage } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { LyricsTargetMenu, LyricsToggleIcon, lyricsToggleView } from "./components.tsx"
import { useMainChrome } from "./use-main-chrome.ts"
import { lyricsNoticeText, playbackModeLabel } from "./features/playback/playback-state.mjs"
import { PlaybackQualityBadge } from "./playback-quality-badge"
import { useMotionPolicy } from "./features/motion/MotionProvider"
import { MotionRegion, MotionSwap } from "./features/motion/primitives"
import { CoverFlight, type CoverFlightRequest } from "./features/motion/cover-flight"
import { PLAYBACK_MODES } from "./features/playback/player.mjs"
import { formatDuration, trackAlbumOf, trackArtistsOf, trackCoverUrlOf, trackNameOf } from "./features/library/track-fields.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"
import type { LyricsWindowBinding } from "./use-lyrics-window.ts"

export interface PlaybackStageProps {
  open: boolean
  runtime: PlayerRuntime
  state: PlayerState
  onClose: () => void
  coverSourceRef?: RefObject<HTMLDivElement | null>
  openerRef?: RefObject<HTMLElement | null>
  /** 桌面/任务栏歌词的快捷开关：与播放栏共用同一个 binding，这里只读状态、只转一次 `setVisible`。 */
  lyrics?: LyricsWindowBinding | null
}

function sliderKeyValue(event: ReactKeyboardEvent<HTMLDivElement>, value: number, max: number, step: number): number | null {
  switch (event.key) {
    case "ArrowRight":
    case "ArrowUp": return Math.min(max, value + step)
    case "ArrowLeft":
    case "ArrowDown": return Math.max(0, value - step)
    case "Home": return 0
    case "End": return max
    default: return null
  }
}

export function PlaybackStage({ open, runtime, state, onClose, coverSourceRef, openerRef, lyrics = null }: PlaybackStageProps) {
  const coverUrl = trackCoverUrlOf(state.track)
  // 退场 220ms 内保持画面：此时 open 已为 false，不能直接拿它取封面；演完 onExitComplete 再放开
  const [exiting, setExiting] = useState(false)
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) setExiting(true)
  }
  const [flight, setFlight] = useState<CoverFlightRequest | null>(null)
  const stageVisible = open || exiting || flight !== null
  // 显示与取色分开：封面能不能显示只看普通图片加载（无 ACAO 的 CDN 图照样显示），
  // 背景取色仍是 AmllBackground 里那条带 CORS 的加载；坏图/缺图才落到「暂无封面」占位。
  const coverImage = useCoverImage(stageVisible ? coverUrl : null)
  // 用户要求减少动效时不走过场：时长 0，直接到位
  const { reducedMotion: reduceMotion, transitionFor } = useMotionPolicy()
  const stageRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const coverTargetRef = useRef<HTMLDivElement>(null)
  const hiddenAnchors = useRef<Array<{ node: HTMLElement; visibility: string }>>([])
  const flightGeneration = useRef(0)
  const intent = useRef({ open: !open, url: coverUrl, done: false, at: 0 })
  const restoreAnchors = useCallback(() => {
    for (const item of hiddenAnchors.current) item.node.style.visibility = item.visibility
    hiddenAnchors.current = []
  }, [])
  const finishFlight = useCallback((id: number) => {
    if (id !== flightGeneration.current) return
    if (stageRef.current) stageRef.current.dataset.coverMotion = "idle"
    restoreAnchors()
    setFlight(null)
  }, [restoreAnchors])
  useLayoutEffect(() => {
    if (stageRef.current) {
      stageRef.current.inert = !open
      stageRef.current.dataset.stageActive = String(open)
    }
    if (open) closeRef.current?.focus({ preventScroll: true })
    else openerRef?.current?.focus({ preventScroll: true })
  }, [open, openerRef, stageVisible])
  useLayoutEffect(() => {
    if (intent.current.open !== open) {
      flightGeneration.current += 1
      const image = coverSourceRef?.current?.querySelector("img")
      intent.current = { open, url: coverUrl, done: open && !(image?.complete && image.naturalWidth > 0), at: performance.now() }
      if (stageRef.current) stageRef.current.dataset.coverMotion = intent.current.done ? "idle" : "pending"
    }
    if (intent.current.url !== coverUrl) {
      intent.current.url = coverUrl
      intent.current.done = true
      flightGeneration.current += 1
      restoreAnchors(); setFlight(null)
      return
    }
    if (reduceMotion) { intent.current.done = true; flightGeneration.current += 1; restoreAnchors(); setFlight(null); if (stageRef.current) stageRef.current.dataset.coverMotion = "idle"; return }
    if (intent.current.done || !coverUrl || !coverSourceRef?.current) return
    const measurementIntent = intent.current
    const measurementGeneration = flightGeneration.current
    let second = 0
    const first = requestAnimationFrame(() => {
      if (intent.current !== measurementIntent || measurementIntent.done || flightGeneration.current !== measurementGeneration) return
      second = requestAnimationFrame(function measure() {
        if (intent.current !== measurementIntent || measurementIntent.done || flightGeneration.current !== measurementGeneration) return
        const source = coverSourceRef.current
        const target = coverTargetRef.current
        if (!source || !target) {
          intent.current.done = true; restoreAnchors(); setFlight(null)
          if (stageRef.current) stageRef.current.dataset.coverMotion = "idle"
          return
        }
        const sourceImage = source.querySelector("img") ?? source
        const targetImage = target.querySelector<HTMLElement>('[role="img"]')
        if (!targetImage) {
          if (open && performance.now() - intent.current.at < 2000) { second = requestAnimationFrame(measure); return }
          intent.current.done = true; restoreAnchors(); setFlight(null)
          if (stageRef.current) stageRef.current.dataset.coverMotion = "idle"
          return
        }
        const from = (open ? sourceImage : targetImage).getBoundingClientRect()
        const to = (open ? targetImage : sourceImage).getBoundingClientRect()
        if (!from.width || !from.height || !to.width || !to.height) {
          intent.current.done = true
          if (stageRef.current) stageRef.current.dataset.coverMotion = "idle"
          return
        }
        const radius = (node: HTMLElement, width: number) => {
          let current: HTMLElement | null = node
          while (current) {
            const value = parseFloat(getComputedStyle(current).borderTopLeftRadius)
            if (value > 0) return value * width / (current.offsetWidth || width)
            current = current.parentElement
          }
          return 8
        }
        if (hiddenAnchors.current.length === 0) {
          for (const node of [source, target]) { hiddenAnchors.current.push({ node, visibility: node.style.visibility }); node.style.visibility = "hidden" }
        }
        intent.current.done = true
        if (stageRef.current) stageRef.current.dataset.coverMotion = "running"
        setFlight({ id: ++flightGeneration.current, phase: open ? "open" : "close", src: coverUrl,
          from: { x: from.x, y: from.y, width: from.width, height: from.height },
          to: { x: to.x, y: to.y, width: to.width, height: to.height },
          fromRadius: radius(open ? sourceImage : targetImage, from.width),
          toRadius: radius(open ? targetImage : sourceImage, to.width) })
      })
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [open, coverUrl, coverSourceRef, reduceMotion, restoreAnchors])
  useEffect(() => {
    const cancel = () => { flightGeneration.current += 1; intent.current.done = true; restoreAnchors(); setFlight(null); if (stageRef.current) stageRef.current.dataset.coverMotion = "idle" }
    window.addEventListener("resize", cancel)
    return () => { window.removeEventListener("resize", cancel); restoreAnchors() }
  }, [restoreAnchors])
  const lyricsView = lyricsToggleView(lyrics)
  const seekOwner = useRef<number | null>(null)
  const chrome = useMainChrome(open)
  const rowPress = useRef<{ x: number; y: number } | null>(null)
  const rowDragged = useRef(false)
  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]')) return
      if (event.key === "Escape") { event.preventDefault(); onClose(); return }
      if (event.key !== "Tab" || !stageRef.current) return
      const targets = [...stageRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], input:not([disabled])')]
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
      const target = event.shiftKey ? targets.at(-1) : targets[0]
      if (!stageRef.current.contains(document.activeElement) || document.activeElement === (event.shiftKey ? targets[0] : targets.at(-1))) {
        event.preventDefault(); target?.focus()
      }
    }
    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  }, [open, onClose])
  // 退场演完才卸载：舞台与它的 portal 一并移除（playback-stage 节点随之 detached）
  if (!stageVisible) return null

  const player = runtime.player
  const notice = lyricsNoticeText(state.lyrics)
  const hasLyric = state.lyrics.lines.length > 0
  const playing = state.status === "playing"
  const hasTrack = state.track !== null
  const durationMs = state.durationMs
  const volume = state.muted ? 0 : state.volume * 100
  const setVolume = (value: number) => {
    player.setMuted(false)
    player.setVolume(value / 100)
  }
  const info = (
    <div className="flex min-w-0 flex-col gap-1">
      <MusicInfo
        className="text-foreground! [&>button]:hidden!"
        name={trackNameOf(state.track)}
        artists={[trackArtistsOf(state.track)]}
        album={trackAlbumOf(state.track)}
      />
      {/* 音质小字紧跟 MusicInfo：文案与播放栏同一份，没声明音质就整行不渲染（不留空位） */}
      <PlaybackQualityBadge state={state} surface="playback-stage" />
    </div>
  )
  const controls = (
    <div className="isolate flex w-full flex-col gap-3 text-foreground motion-reduce:[&_*]:animate-none! motion-reduce:[&_*]:transition-none! motion-reduce:[&_*]:duration-0!" data-testid="playback-stage-player">
      <div
        role="slider"
        tabIndex={durationMs > 0 ? 0 : -1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={durationMs}
        aria-valuenow={Math.min(state.currentTimeMs, durationMs)}
        aria-valuetext={formatDuration(state.currentTimeMs / 1000)}
        aria-disabled={durationMs <= 0}
        onKeyDown={(event) => {
          if (durationMs <= 0) return
          const next = sliderKeyValue(event, state.currentTimeMs, durationMs, 1000)
          if (next === null) return
          event.preventDefault()
          player.seek(next)
        }}
        className="data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
        data-disabled={durationMs <= 0}
      >
        <BouncingSlider
          key={state.playbackGeneration}
          className="[&>div]:bg-foreground/20! [&>div>div]:bg-foreground!"
          min={0}
          max={durationMs > 0 ? durationMs : 1}
          value={Math.min(state.currentTimeMs, durationMs)}
          isPlaying={playing}
          onBeforeChange={() => { seekOwner.current = state.playbackGeneration }}
          onAfterChange={(value) => {
            const generation = seekOwner.current
            seekOwner.current = null
            if (generation !== state.playbackGeneration || generation !== player.snapshot().playbackGeneration) return
            player.seek(value)
          }}
        />
      </div>
      <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
        <span>{formatDuration(state.currentTimeMs / 1000)}</span>
        <span>{durationMs > 0 ? formatDuration(durationMs / 1000) : "—"}</span>
      </div>
      {/* 传输组只放传输控件：上一首 → 播放 → 下一首；歌词开关与音量等一起排在下面的工具行。 */}
      <div className="flex items-center justify-evenly">
        <MediaButton className="size-10" aria-label="上一首" disabled={!hasTrack} onClick={() => void player.previous()}><SkipBackIcon /></MediaButton>
        <MediaButton className="size-14" aria-label={playing ? "暂停" : "播放"} disabled={!hasTrack} onClick={() => void player.toggle()}>
          <MotionSwap identity={state.status}>{playing ? <PauseIcon className="size-8" /> : <PlayIcon className="size-8" />}</MotionSwap>
        </MediaButton>
        <MediaButton className="size-10" aria-label="下一首" disabled={!hasTrack} onClick={() => void player.next()}><SkipForwardIcon /></MediaButton>
      </div>
      <div className="flex items-center gap-2">
        <MediaButton className="size-8 shrink-0" aria-label={state.muted ? "取消静音" : "静音"} onClick={() => player.toggleMute()}><VolumeXIcon className="size-4" /></MediaButton>
        <div
          className="min-w-0 flex-1 [&>div>div]:bg-foreground/20! [&>div>div>div]:bg-foreground! [&_svg]:text-foreground!"
          role="slider"
          tabIndex={0}
          aria-label="音量"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={volume}
          onKeyDown={(event) => {
            const next = sliderKeyValue(event, volume, 100, 5)
            if (next === null) return
            event.preventDefault()
            setVolume(next)
          }}
        >
          <VolumeControl
            min={0}
            max={100}
            value={volume}
            onAfterChange={setVolume}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MediaButton className="size-8 shrink-0" aria-label={`播放模式：${playbackModeLabel(state.mode)}`}><ListMusicIcon className="size-4" /></MediaButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={state.mode} onValueChange={(mode) => player.setMode(mode)}>
              {PLAYBACK_MODES.map((mode: string) => <DropdownMenuRadioItem key={mode} value={mode}>{playbackModeLabel(mode)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 歌词开关与显示目标落在工具行尾部，与音量、模式同档 */}
        {lyricsView === null ? null : lyrics === null ? null : (
          <>
            <MediaButton className="size-8 shrink-0" aria-label={lyricsView.label} aria-pressed={lyricsView.on} data-testid="stage-lyrics-toggle" onClick={() => lyrics?.toggleVisible("playback-stage")}>
              <LyricsToggleIcon view={lyricsView} className="size-4" />
            </MediaButton>
            <LyricsTargetMenu lyrics={lyrics} surface="playback-stage" trigger={
              <MediaButton className="size-8 shrink-0" aria-label="选择歌词显示位置" data-testid="stage-lyrics-target"><ChevronDownIcon className="size-4" /></MediaButton>
            } />
          </>
        )}
      </div>
      {/* 开关失败就在这枚按钮下面说清（原因 + 下一步 + 重试）：挂在 `controlsSlot` 里，不另起浮层；`toggleErrorSurface` 保证同一失败只在一面印一句。 */}
      {lyrics?.toggleError && lyrics.toggleErrorSurface === "playback-stage" ? (
        <Alert variant="destructive" className="flex flex-wrap items-center gap-2 py-2 text-left" data-testid="stage-lyrics-toggle-error">
          <AlertDescription className="min-w-0 flex-1">{lyrics.toggleError}</AlertDescription>
          <Button variant="outline" size="sm" data-testid="stage-lyrics-toggle-retry" onClick={() => lyrics?.retryToggle?.()}>
            重试
          </Button>
          <Button variant="ghost" size="sm" data-testid="stage-lyrics-toggle-dismiss" onClick={() => lyrics?.dismissToggleError?.()}>
            知道了
          </Button>
        </Alert>
      ) : null}
    </div>
  )
  const musicControls = <MotionRegion identity={state.track?.id ?? "none"} kind="page" active={open}
    className="isolate flex min-w-0 flex-col gap-4">{info}{controls}</MotionRegion>

  // 窗口按钮与收起行同一种淡色半透明悬停
  const chromeButton = "h-10 w-11 rounded-none px-0 hover:bg-background/30 dark:hover:bg-foreground/10"
  // 标题栏收起时这一行兼作拖动区：按下后移动超过 4px 才算拖窗，否则仍是点击收起
  const startRowPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    rowDragged.current = false
    rowPress.current = chrome.frameless && event.button === 0 ? { x: event.clientX, y: event.clientY } : null
  }
  const trackRowPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = rowPress.current
    if (start === null || (event.buttons & 1) === 0) return
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) < 4) return
    rowPress.current = null
    rowDragged.current = true
    void getCurrentWindow().startDragging().catch(() => undefined)
  }
  const clickRow = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const dragged = rowDragged.current && event.detail > 0
    rowDragged.current = false
    if (!dragged) onClose()
  }

  return createPortal(
    <>
      {/* 背景、正文和封面各自过渡，正文保持原尺寸。 */}
      <AnimatePresence onExitComplete={() => setExiting(false)}>
        {open ? (
          <motion.div
            key="playback-stage"
            ref={stageRef} role="dialog" aria-modal="true" aria-label="沉浸歌词"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitionFor("stageExit")}
            className="fixed inset-0 isolate z-40 overflow-hidden bg-background"
            data-testid="playback-stage"
          >
            <motion.div className="absolute inset-0" aria-hidden="true" initial={{ opacity: reduceMotion ? 1 : 0 }}
              animate={{ opacity: 1 }} transition={transitionFor("page")}>
            <AmllBackground playing={playing} hasLyric={hasLyric} albumUrl={trackCoverUrlOf(state.track)} />
            <div className="absolute inset-0 bg-background/40" data-testid="playback-stage-dim" aria-hidden="true" />
            </motion.div>
            <AutoLyricLayout
              className="relative isolate h-full w-full"
              data-testid="playback-stage-layout"
              coverSlot={<div ref={coverTargetRef} className="size-full">{coverImage ? (
                <Cover
                  coverUrl={coverUrl ?? undefined}
                  musicPaused={!playing}
                  className="motion-reduce:transition-none! motion-reduce:duration-0! motion-reduce:[&_*]:transition-none! motion-reduce:[&_*]:duration-0!"
                  data-testid="playback-stage-cover"
                  role="img"
                  aria-label={`${trackNameOf(state.track)}封面`}
                />
              ) : (
                <Avatar className="size-full rounded-md" data-testid="playback-stage-cover-fallback">
                  <AvatarFallback className="rounded-md" aria-label="暂无封面"><Disc3Icon className="size-12" /></AvatarFallback>
                </Avatar>
              )}</div>}
              controlsSlot={musicControls}
              smallControlsSlot={musicControls}
              lyricSlot={(
                <MotionRegion identity={state.track?.id ?? "none"} kind="page" active={open} className="relative isolate h-full min-h-0 w-full" data-testid="playback-stage-lyrics-slot">
                  {hasLyric ? (
                    <AmllLyricsPanel
                      runtime={runtime}
                      lines={state.lyrics.lines}
                      playing={playing}
                      seekGeneration={state.seekGeneration}
                    />
                  ) : null}
                  {notice === null ? null : (
                    <div className="absolute inset-0 flex items-center justify-center p-6">
                      <p role="status" className="max-w-md text-center text-sm text-foreground">{notice}</p>
                    </div>
                  )}
                </MotionRegion>
              )}
            />
            {/* 收起 = 顶部整行：行高只占顶部一条带，箭头居中，行内任意位置可点（不用右上角叉号）。 */}
            <Button
              ref={closeRef}
              variant="ghost"
              className="absolute inset-x-0 top-0 h-10 w-full rounded-none hover:bg-background/30 dark:hover:bg-foreground/10 motion-reduce:transition-none! motion-reduce:duration-0!"
              aria-label="收起歌词"
              onPointerDown={startRowPress}
              onPointerMove={trackRowPress}
              data-testid="playback-stage-close-row"
              onClick={clickRow}
            >
              <ChevronDownIcon className="size-4" />
            </Button>
            {chrome.frameless ? (
              <div className="absolute right-0 top-0 flex" data-testid="playback-stage-window-controls">
                <Button variant="ghost" className={chromeButton} aria-label="最小化" onClick={() => chrome.act("minimize")}>
                  <MinusIcon className="size-4" />
                </Button>
                <Button variant="ghost" className={chromeButton} aria-label={chrome.maximized ? "还原" : "最大化"} onClick={() => chrome.act("toggle-maximize")}>
                  {chrome.maximized ? <CopyIcon className="size-3.5" /> : <SquareIcon className="size-3.5" />}
                </Button>
                <Button variant="ghost" className={chromeButton} aria-label="关闭窗口" onClick={() => chrome.act("close")}>
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <CoverFlight request={flight} onComplete={finishFlight} />
    </>,
    document.body,
  )
}
