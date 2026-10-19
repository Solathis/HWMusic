/**
 * 歌词舞台（R9）：主窗里的"正在播放"层。
 *
 * 三层结构（顺序就是层次，不用 z-index 堆叠魔法）：
 * 1. `AmllBackground` —— 官方流体背景铺满；
 * 2. **压暗层** —— 一个令牌色的半透明层（`bg-background/…`），让歌词在亮背景上也读得清；
 * 3. `AmllLyricsPanel` —— 官方歌词组件（逐行滚动是它的事，见那个文件的说明）。
 *
 * 三件本任务**不做**的事，都是刻意的：
 * - 不加载远程封面（字段未确认，且 AMLL 拉字符串地址会被 CSP `connect-src` 拦，见 AmllBackground）；
 * - 不自己画歌词（那正是本任务要避免的"自绘"）；
 * - 不显示假歌词（没有来源就说没有来源——文案三档分开在 `playback-state.mjs`）。
 *
 * 舞台是覆盖层：它盖住内容区，但**不盖**播放器栏（关闭入口与播放控制始终在）。
 */
import { XIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { AmllBackground } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { lyricsNoticeText } from "./features/playback/playback-state.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

export interface PlaybackStageProps {
  open: boolean
  runtime: PlayerRuntime
  state: PlayerState
  onClose: () => void
}

export function PlaybackStage({ open, runtime, state, onClose }: PlaybackStageProps) {
  if (!open) return null

  const notice = lyricsNoticeText(state.lyrics)
  const hasLyric = state.lyrics.lines.length > 0

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="playback-stage">
      <AmllBackground playing={state.status === "playing"} hasLyric={hasLyric} />
      <div className="absolute inset-0 bg-background/80" data-testid="playback-stage-dim" aria-hidden="true" />

      {hasLyric ? (
        <AmllLyricsPanel
          runtime={runtime}
          lines={state.lyrics.lines}
          playing={state.status === "playing"}
          seekGeneration={state.seekGeneration}
        />
      ) : null}

      {notice === null ? null : (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p role="status" className="max-w-md text-center text-sm text-muted-foreground">
            {notice}
          </p>
        </div>
      )}

      <div className="absolute right-4 top-4">
        <Button variant="ghost" size="icon" aria-label="关闭歌词" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </div>
  )
}
