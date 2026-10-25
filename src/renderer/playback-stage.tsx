import { AutoLyricLayout, BouncingSlider, Cover, MediaButton, MusicInfo, VolumeControl } from "@applemusic-like-lyrics/react-full"
import { MotionConfig } from "framer-motion"
import { useEffect, useRef } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { CaptionsIcon, ChevronDownIcon, Disc3Icon, ListMusicIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, VolumeXIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "./components/ui/avatar"
import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu"
import { AmllBackground, useAlbumImage } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { lyricsToggleView } from "./components.tsx"
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
  /**
   * 桌面/任务栏歌词的快捷开关（R45C）：与播放栏**同一个** binding（外壳那一份），
   * 这里只读状态、只转一次 `setVisible`。不传 = 不渲染这枚按钮。
   */
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
      {/*
        R50：传输组只放传输控件 —— 上一首 → 播放 → 下一首。
        R45C 那枚歌词开关曾夹在"播放"与"下一首"之间，把这段肌肉记忆劈成两半（播放栏 R46
        已经搬走，沉浸页漏了这一处）；现在它和音量/静音/播放模式一起排在下面的工具行。
      */}
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
        {/* R50：歌词开关落在工具行尾部，与音量/模式同档（size-8 + 图标 size-4）。
            语义一个字没变：状态/标签来自 components.tsx 的 lyricsToggleView，取反交给
            binding 的意图机（渲染快照在同一次任务里连点两次时是旧的）。 */}
        {lyricsView === null ? null : (
          <MediaButton className="size-8 shrink-0" aria-label={lyricsView.label} aria-pressed={lyricsView.on} data-testid="stage-lyrics-toggle" onClick={() => lyrics?.toggleVisible("playback-stage")}>
            <CaptionsIcon className="size-4" />
          </MediaButton>
        )}
      </div>
      {/*
        R45C：开关失败就在**沉浸页这枚按钮下面**说清（原因 + 下一步 + 重试/关掉）。
        它挂在官方布局的 `controlsSlot` 里（我们自己那一列），不另起浮层、不弹 toast；
        `toggleErrorSurface` 保证同一个失败只在这一面印一句（播放栏那份不会同时冒出来）。
      */}
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
        {/*
          收起 = **顶部整行**：行高只占顶部一条带，箭头居中，行内任意位置可点。
          不用右上角叉号：在沉浸页里它像是"关掉这首歌"，而这里只是回到主界面。ESC 行为不变（见上面的 keydown）。
        */}
        <Button
          variant="ghost"
          className="absolute inset-x-0 top-0 h-10 w-full rounded-none motion-reduce:transition-none! motion-reduce:duration-0!"
          aria-label="收起歌词"
          data-testid="playback-stage-close-row"
          onClick={onClose}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </div>
    </MotionConfig>,
    document.body,
  )
}
