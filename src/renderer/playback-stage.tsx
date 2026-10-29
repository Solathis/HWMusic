import { AutoLyricLayout, BouncingSlider, Cover, MediaButton, MusicInfo, VolumeControl } from "@applemusic-like-lyrics/react-full"
import { MotionConfig } from "framer-motion"
import { useEffect, useRef } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { CaptionsIcon, ChevronDownIcon, CopyIcon, Disc3Icon, ListMusicIcon, MinusIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, SquareIcon, VolumeXIcon, XIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "./components/ui/avatar"
import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu"
import { AmllBackground, useAlbumImage } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { LyricsTargetMenu, lyricsToggleView } from "./components.tsx"
import { useMainChrome } from "./use-main-chrome.ts"
import { lyricsNoticeText, playbackModeLabel } from "./features/playback/playback-state.mjs"
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

export function PlaybackStage({ open, runtime, state, onClose, lyrics = null }: PlaybackStageProps) {
  const coverUrl = trackCoverUrlOf(state.track)
  const coverImage = useAlbumImage(open ? coverUrl : null)
  const lyricsView = lyricsToggleView(lyrics)
  const seekOwner = useRef<number | null>(null)
  const chrome = useMainChrome(open)
  const rowPress = useRef<{ x: number; y: number } | null>(null)
  const rowDragged = useRef(false)
  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      onClose()
    }
    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  }, [open, onClose])
  if (!open) return null

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
    <MusicInfo
      className="text-foreground! [&>button]:hidden!"
      name={trackNameOf(state.track)}
      artists={[trackArtistsOf(state.track)]}
      album={trackAlbumOf(state.track)}
    />
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
          {playing ? <PauseIcon className="size-8" /> : <PlayIcon className="size-8" />}
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
              <CaptionsIcon className="size-4" />
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
  const musicControls = <div className="isolate flex min-w-0 flex-col gap-4">{info}{controls}</div>

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
    <MotionConfig reducedMotion="user">
      <div
        className="fixed inset-0 isolate z-40 overflow-hidden bg-background motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
        data-testid="playback-stage"
      >
        <AmllBackground playing={playing} hasLyric={hasLyric} albumUrl={trackCoverUrlOf(state.track)} />
        <div className="absolute inset-0 bg-background/40" data-testid="playback-stage-dim" aria-hidden="true" />
        <AutoLyricLayout
          className="relative isolate h-full w-full"
          data-testid="playback-stage-layout"
          coverSlot={coverImage ? (
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
          )}
          controlsSlot={musicControls}
          smallControlsSlot={musicControls}
          lyricSlot={(
            <div className="relative isolate h-full min-h-0 w-full" data-testid="playback-stage-lyrics-slot">
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
            </div>
          )}
        />
        {/* 收起 = 顶部整行：行高只占顶部一条带，箭头居中，行内任意位置可点（不用右上角叉号）。 */}
        <Button
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
      </div>
    </MotionConfig>,
    document.body,
  )
}
