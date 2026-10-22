/**
 * 主窗的正在播放层：portal 覆盖应用内容，底下的页面保持挂载。
 * 不透明语义底色之上保留 AMLL 流体背景与 scrim，歌词和 PlayerBar 仍复用原组件。
 */
import { createPortal } from "react-dom"
import { XIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { PlayerBar } from "./components"
import { AmllBackground } from "./AmllBackground.tsx"
import { AmllLyricsPanel } from "./AmllLyricsPanel.tsx"
import { lyricsNoticeText } from "./features/playback/playback-state.mjs"
import { trackCoverUrlOf } from "./features/library/track-fields.mjs"
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

  return createPortal(
    <div
      className="fixed inset-0 isolate z-40 overflow-hidden bg-background motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      data-testid="playback-stage"
    >
      {/*
        底景（R40 起带上当前曲目的封面）：地址交给 `AmllBackground` 之后由**它**用
        `new Image()` 载入（`img-src` 白名单内的地址，不是 fetch）——这一层不碰图片加载。
      */}
      <AmllBackground playing={state.status === "playing"} hasLyric={hasLyric} albumUrl={trackCoverUrlOf(state.track)} />
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

      {/*
        关闭按钮：与头部那排图标按钮**同一个高度**（`top-2` = 48px header 里 32px 按钮的居中位置），
        点开与点关落在一起——用户不会为了找关闭按钮而移动视线。
      */}
      <div className="absolute right-4 top-2">
        <Button variant="ghost" size="icon" aria-label="关闭歌词" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      {/*
        舞台底部的播放控制（R41b）：复用主界面那一个 `PlayerBar`，全宽贴在舞台最下面。
        它自己有封面/曲目信息、进度条、播放控件与音量——沉浸态下这些一样都不少。
        不传 `onOpenStage`：已经在舞台上了，那块信息不该再是一个"打开歌词"的按钮。
      */}
      <div className="absolute inset-x-0 bottom-0" data-testid="playback-stage-player">
        <PlayerBar runtime={runtime} state={state} />
      </div>
    </div>,
    document.body,
  )
}
