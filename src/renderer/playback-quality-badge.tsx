import { Badge } from "./components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { playbackAudioDetailsText, playbackQualityBadgeView } from "./features/playback/playback-state.mjs"
import type { PlayerState } from "./features/playback/use-player"
import { MotionRegion } from "./features/motion/primitives"

export function PlaybackQualityBadge({ state, surface }: {
  state: PlayerState
  surface: "player-bar" | "playback-stage"
}) {
  const view = playbackQualityBadgeView(state)
  if (view === null) return null
  const audioDetails = view.kind === "confirmed" ? playbackAudioDetailsText(state.audioDetails) : null
  const accessibleDescription = audioDetails === null ? view.description : `${view.description}，${audioDetails}`
  return (
    <TooltipProvider>
    <MotionRegion identity={view.text} kind="content" className="w-fit shrink-0">
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="w-fit shrink-0 whitespace-nowrap"
          data-testid={surface + "-quality"} data-quality-kind={view.kind}
          aria-label={view.text + "，" + accessibleDescription}>
          {view.text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-1">
          <span>{view.description}</span>
          {audioDetails === null ? null : <span className="text-muted-foreground">{audioDetails}</span>}
          {state.track?.albumName ? <span className="text-muted-foreground">专辑：{state.track.albumName}</span> : null}
        </div>
      </TooltipContent>
    </Tooltip>
    </MotionRegion>
    </TooltipProvider>
  )
}
