import { AutoLyricLayout, BouncingSlider, Cover, MediaButton, MusicInfo, VolumeControl } from "@applemusic-like-lyrics/react-full"
import { MotionConfig } from "framer-motion"
import { useEffect, useRef } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { Disc3Icon, ListMusicIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, VolumeXIcon, XIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "./components/ui/avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu"
import { AmllBackground, useAlbumImage } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { lyricsNoticeText, playbackModeLabel } from "./features/playback/playback-state.mjs"
import { PLAYBACK_MODES } from "./features/playback/player.mjs"
import { formatDuration, trackAlbumOf, trackArtistsOf, trackCoverUrlOf, trackNameOf } from "./features/library/track-fields.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

export interface PlaybackStageProps {
  open: boolean
  runtime: PlayerRuntime
  state: PlayerState
  onClose: () => void
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

export function PlaybackStage({ open, runtime, state, onClose }: PlaybackStageProps) {
  const coverUrl = trackCoverUrlOf(state.track)
  const coverImage = useAlbumImage(open ? coverUrl : null)
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
      </div>
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
              {hasLyric ? <AmllLyricsPanel runtime={runtime} lines={state.lyrics.lines} playing={playing} seekGeneration={state.seekGeneration} /> : null}
              {notice === null ? null : (
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <p role="status" className="max-w-md text-center text-sm text-foreground">{notice}</p>
                </div>
              )}
            </div>
          )}
        />
        <div className="absolute right-4 top-2">
          <MediaButton className="size-8 motion-reduce:animate-none! motion-reduce:transition-none! motion-reduce:duration-0! motion-reduce:[&_*]:animate-none! motion-reduce:[&_*]:transition-none! motion-reduce:[&_*]:duration-0!" aria-label="关闭歌词" onClick={onClose}><XIcon className="size-4" /></MediaButton>
        </div>
      </div>
    </MotionConfig>,
    document.body,
  )
}
