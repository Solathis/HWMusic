/**
 * 歌词舞台（R9；R41b 起盖满**整个程序**）：主窗里的"正在播放"层。
 *
 * 四层结构（顺序就是层次，不用 z-index 堆叠魔法）：
 * 1. `AmllBackground` —— 官方流体背景铺满；
 * 2. **压暗层** —— 一个令牌色的半透明层（`bg-background/…`），让歌词在亮背景上也读得清；
 * 3. `AmllLyricsPanel` —— 官方歌词组件（逐行滚动是它的事，见那个文件的说明）；
 * 4. **舞台自己的播放器栏** —— 复用主界面那一个 `PlayerBar` 组件（不复制实现）。
 *
 * ## R41b：为什么舞台从"内容区"挪到了"整个 SidebarInset"
 *
 * 之前它挂在内容区那一层里，于是沉浸态下还露着头部的 48px 与底部的播放器栏——
 * 那不是沉浸，只是"内容区沉浸"。现在它是 `SidebarInset` 里的最后一层（`absolute inset-0`），
 * header、内容、播放器栏全被盖住，窗口整个交给歌词。
 *
 * 三条纪律：
 * - **底下的原渲染一个都不卸载**（覆盖层只是盖住）：页面状态、滚动位置、队列都不丢；
 * - **播放控制必须在**：底部放的是同一个 `PlayerBar`（R41b 补的），沉浸态下不用退出就能
 *   暂停/切歌/拖进度。它是**同一个组件**而不是第二份控件实现——控件只有一处，改动只有一处；
 * - **关掉就回到原样**：`open=false` 直接不渲染（下面那个 `if`），底下那一层从头到尾都在。
 *
 * 三件本任务**不做**的事，都是刻意的：
 * - 不加载远程封面（字段未确认，且 AMLL 拉字符串地址会被 CSP `connect-src` 拦，见 AmllBackground）；
 * - 不自己画歌词（那正是本任务要避免的"自绘"）；
 * - 不显示假歌词（没有来源就说没有来源——文案三档分开在 `playback-state.mjs`）。
 *
 * 动画只用官方能力（tw-animate-css 的 `animate-in`/`fade-in`）并挂 `motion-safe:`：
 * 系统设了"减少动态效果"的用户拿到的是瞬时切换（`prefers-reduced-motion`）。
 */
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

  return (
    <div
      className="absolute inset-0 overflow-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
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
    </div>
  )
}
