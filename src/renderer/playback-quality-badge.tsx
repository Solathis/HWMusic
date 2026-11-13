import { Badge } from "./components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import { playbackQualityBadgeView } from "./features/playback/playback-state.mjs"
import type { PlayerState } from "./features/playback/use-player"
import { MotionRegion } from "./features/motion/primitives"

export function PlaybackQualityBadge({ state, surface }: {
  state: PlayerState
  surface: "player-bar" | "playback-stage"
}) {
  const view = playbackQualityBadgeView(state)
  if (view === null) return null
  return (
    <TooltipProvider>
    <MotionRegion identity={view.text} kind="content" className="w-fit shrink-0">
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="w-fit shrink-0 whitespace-nowrap"
          data-testid={surface + "-quality"} data-quality-kind={view.kind}
          aria-label={view.text + "，" + view.description}>
          {view.text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{view.description}</TooltipContent>
    </Tooltip>
    </MotionRegion>
    </TooltipProvider>
  )
}
