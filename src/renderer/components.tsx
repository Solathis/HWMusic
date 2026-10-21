/**
 * 主界面的展示组件（R8）：**只组合 shadcn 原语 + Tailwind 工具类 + 设计令牌**。
 * R9 把 `PlayerBar` / `QueuePanel` 从占位骨架翻成接通播放状态机的真实组件。
 *
 * 分工（照简报）：
 * - `TrackTable`：曲目表的唯一实现（双击播放、键盘可达、艺人/专辑跳转、收藏槽位）；
 * - `PlayerBar`：播放/暂停、上下曲、进度（拖动走 200ms isSeeking 窗口）、音量、模式切换。
 *   **它不持有音频、不认识 core**：动作全部转给 `features/playback` 的运行时，
 *   所以 UI 层既拿不到播放地址，也不可能出现第二个 `Audio`；
 * - `QueuePanel`：真实队列（当前项高亮、点击跳播、清空）；恢复出来的条目只有标识，
 *   标题如实显示"曲目 &lt;id&gt;"（见 playback-state.mjs）；
 * - `EmptyState` / `LoadFailed` / `GridSkeleton` / `ListSkeleton`：空态、失败态与骨架屏，
 *   文案一律由调用方从 features/library 的纯逻辑模块取（这里不造第二套文案）。
 *
 * 收藏槽位的诚实处理：收藏的**写入**接口还没确认（docs/API_CONTRACT.md §2.1），
 * 所以没接 `onToggleFavorite` 时按钮是禁用的，无障碍名称直接说明原因——
 * 不做"点了看起来成功、其实什么都没存"的乐观更新。
 */
import { useState } from "react"
import type { ComponentType } from "react"
import {
  HeartIcon,
  ListMusicIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"

import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Card } from "./components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { ScrollArea } from "./components/ui/scroll-area"
import { Skeleton } from "./components/ui/skeleton"
import { Slider } from "./components/ui/slider"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table"
import {
  trackAlbumIdOf,
  trackAlbumOf,
  trackArtistIdOf,
  trackArtistsOf,
  trackCoverUrlOf,
  trackDurationOf,
  trackIdOf,
  trackNameOf,
  formatDuration,
} from "./features/library/track-fields.mjs"
import { PLAYBACK_MODES } from "./features/playback/player.mjs"
import {
  playbackModeLabel,
  playerStatusText,
  trackArtistOf,
  trackTitleOf,
} from "./features/playback/playback-state.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

/** 空态：一句话（文案来自纯逻辑模块，克制且不冒充）。 */
export function EmptyState({ text }: { text: string }) {
  return (
    <p className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">
      {text}
    </p>
  )
}

/**
 * 封面（R38）：`<img>` + 兜底占位。
 *
 * 三条硬约束（docs/API_CONTRACT.md §2.4）：
 * - **只用 `<img src>`，绝不 fetch**：图片走 CSP 的 `img-src` 白名单，而 `connect-src`
 *   只有 self/ipc——`fetch` 那张封面一定被拦掉，界面上表现为一片空白（比占位更糟）；
 * - **加载失败落回占位**：白名单内的地址也可能 404/过期，`onError` 之后不再留碎图；
 * - **地址由协议层筛过**（`normalizeTrack`/`normalizePlaylist` 只带 CDN 白名单内的地址），
 *   这里的 `coverUrl === null` 是常态（无封面/未投影），不是错误。
 *
 * 视觉只有令牌类与 lucide 图标，尺寸由调用方给（`size-9`/`size-10` 之类）。
 */
export function CoverArt({
  coverUrl,
  className,
  iconClassName,
  icon: Icon = MusicIcon,
}: {
  coverUrl: string | null
  /** 尺寸/圆角等令牌类（由调用方给，例如 `size-10 rounded-md`） */
  className?: string
  /** 占位图标的尺寸类（默认 `size-5`） */
  iconClassName?: string
  /** 占位图标（默认音符；歌单卡用清单图标，与它自己的语义一致） */
  icon?: ComponentType<{ className?: string }>
}) {
  // 失败状态记的是**哪一个地址**失败过，而不是一个裸布尔：地址一换就自动重新给一次机会。
  // 裸布尔会粘死 `PlayerBar`（:338）那一个跨曲目常驻的实例——一首歌的封面 404 一次，
  // 之后每一首都永久落图标占位。TrackTable / QueuePanel 的行按条目重挂、`key` 一变就复位，
  // 所以这个 bug 只在 PlayerBar 露头（R38 审查 §1）。
  // 用"从 props 推"而不是 `useEffect(..., [coverUrl])` 复位：effect 在**绘制之后**才跑，
  // 换歌那一帧会先画出上一首留下的占位图标（React 官方的 "You Might Not Need an Effect" 也推荐前者）。
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = coverUrl !== null && failedUrl !== coverUrl

  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted ${className ?? ""}`}>
      {showImage ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailedUrl(coverUrl)}
        />
      ) : (
        <Icon className={`text-muted-foreground ${iconClassName ?? "size-5"}`} />
      )}
    </div>
  )
}

/** 失败态：结构化错误的人话（core 侧已清洗过 message，这里不做二次编造）。 */
export function LoadFailed({ text }: { text: string }) {
  return (
    <Alert variant="destructive" className="m-4" data-testid="load-failed">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/** 网格骨架（歌单等卡片列表的加载态）。 */
export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4 p-4" data-testid="grid-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} size="sm">
          <Skeleton className="mx-3 aspect-square" />
          <Skeleton className="mx-3 h-4 w-2/3" />
          <Skeleton className="mx-3 h-3 w-1/3" />
        </Card>
      ))}
    </div>
  )
}

/** 列表骨架（曲目表的加载态）。 */
export function ListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="list-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  )
}

export interface TrackTableProps {
  songs: unknown[]
  emptyText: string
  /** 双击（或回车/空格）播放：带上行下标——播放器要用**整张列表**当队列 */
  onActivate?: (song: unknown, index: number) => void
  onOpenAlbum?: (albumId: string, song: unknown) => void
  onOpenArtist?: (artistId: string, song: unknown) => void
  /** 未接（默认）：收藏写入接口还没确认，按钮如实禁用 */
  onToggleFavorite?: (song: unknown) => void
  favoritedIds?: string[]
}

/**
 * 曲目表。
 *
 * 键盘可达：行本身可聚焦，回车/空格等于双击（鼠标用户与键盘用户拿到同一件事）。
 * 艺人/专辑是 shadcn 的 link 按钮——跳不过去（缺 id）时禁用，而不是点了没反应。
 */
export function TrackTable({
  songs,
  emptyText,
  onActivate,
  onOpenAlbum,
  onOpenArtist,
  onToggleFavorite,
  favoritedIds = [],
}: TrackTableProps) {
  if (songs.length === 0) return <EmptyState text={emptyText} />

  const favorited = new Set(favoritedIds)

  return (
    <Table data-testid="track-table">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10 text-center">#</TableHead>
          <TableHead>标题</TableHead>
          <TableHead className="w-40">艺人</TableHead>
          <TableHead className="w-40">专辑</TableHead>
          <TableHead className="w-16 text-right">时长</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {songs.map((song, index) => {
          const id = trackIdOf(song)
          const albumId = trackAlbumIdOf(song)
          const artistId = trackArtistIdOf(song)
          const isFavorited = id !== null && favorited.has(id)
          return (
            <TableRow
              key={id ?? `row-${index}`}
              tabIndex={0}
              aria-label={`${trackNameOf(song)}，双击播放`}
              onDoubleClick={() => onActivate?.(song, index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onActivate?.(song, index)
              }}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <TableCell className="text-center tabular-nums text-muted-foreground">{index + 1}</TableCell>
              <TableCell className="font-medium">
                {/* R38：小封面（`<img>` + 占位兜底见 CoverArt）——地址来自协议层的白名单投影 */}
                <div className="flex min-w-0 items-center gap-2">
                  <CoverArt coverUrl={trackCoverUrlOf(song)} className="size-9 rounded-md" iconClassName="size-4" />
                  <span className="truncate">{trackNameOf(song)}</span>
                </div>
              </TableCell>
              <TableCell>
                <Button
                  variant="link"
                  size="sm"
                  className="max-w-full truncate"
                  disabled={onOpenArtist === undefined || artistId === null}
                  onClick={() => {
                    if (artistId === null) return
                    onOpenArtist?.(artistId, song)
                  }}
                >
                  {trackArtistsOf(song)}
                </Button>
              </TableCell>
              <TableCell>
                <Button
                  variant="link"
                  size="sm"
                  className="max-w-full truncate"
                  disabled={onOpenAlbum === undefined || albumId === null}
                  onClick={() => {
                    if (albumId === null) return
                    onOpenAlbum?.(albumId, song)
                  }}
                >
                  {trackAlbumOf(song)}
                </Button>
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatDuration(trackDurationOf(song))}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={isFavorited}
                  disabled={onToggleFavorite === undefined}
                  aria-label={
                    onToggleFavorite === undefined
                      ? "收藏（写入接口待联调确认）"
                      : isFavorited
                        ? "取消收藏"
                        : "收藏"
                  }
                  onClick={() => onToggleFavorite?.(song)}
                >
                  <HeartIcon className={isFavorited ? "fill-current" : undefined} />
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * 播放器栏（R9 接通状态机）。
 *
 * `data-state` 直接写状态机的状态（`idle`/`loading`/`playing`/`paused`/`ended`/`error`）：
 * 它是给测试与 review 的锚点，也是"界面现在到底是什么状态"的唯一说法。
 *
 * 进度条的拖动是**本地优先**的：拖动期间滑块显示手上的值（`dragMs`），松手后回到
 * 状态机的进度。每一次变化都真的 seek 一次（旧仓同款：拖动即试听），并因此让状态机
 * 递增 `seekGeneration` —— 歌词面板据此在 200ms 窗口内标注 `isSeeking`。
 */
export interface PlayerBarProps {
  runtime: PlayerRuntime
  state: PlayerState
}

/** 播放模式 → 图标（四种模式的取值唯一真源是 player.mjs 的 PLAYBACK_MODES）。 */
const MODE_ICONS = {
  sequential: ListMusicIcon,
  "list-loop": RepeatIcon,
  "single-loop": Repeat1Icon,
  shuffle: ShuffleIcon,
}

export function PlayerBar({ runtime, state }: PlayerBarProps) {
  const [dragMs, setDragMs] = useState<number | null>(null)
  const player = runtime.player

  const playing = state.status === "playing"
  const hasTrack = state.track !== null
  const durationMs = state.durationMs
  const shownMs = dragMs ?? state.currentTimeMs
  const ModeIcon = MODE_ICONS[state.mode as keyof typeof MODE_ICONS] ?? ListMusicIcon
  const VolumeIcon = state.muted ? VolumeXIcon : state.volume === 0 ? VolumeXIcon : state.volume < 0.5 ? Volume1Icon : Volume2Icon

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t bg-background px-4 py-2"
      data-state={state.status}
      data-testid="player-bar"
    >
      <div className="flex items-center gap-3">
        {/* R38：当前曲目封面（播放中本来就有 coverUrl 投影；没有就是图标占位） */}
        <CoverArt coverUrl={trackCoverUrlOf(state.track)} className="size-10 rounded-md" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{trackTitleOf(state.track)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {state.track === null ? playerStatusText(state) : `${trackArtistOf(state.track)} · ${playerStatusText(state)}`}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`播放模式：${playbackModeLabel(state.mode)}`}>
                <ModeIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={state.mode}
                onValueChange={(mode) => {
                  player.setMode(mode)
                }}
              >
                {PLAYBACK_MODES.map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    {playbackModeLabel(mode)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="ghost"
            size="icon"
            aria-label="上一首"
            disabled={!hasTrack}
            onClick={() => void player.previous()}
          >
            <SkipBackIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={playing ? "暂停" : "播放"}
            disabled={!hasTrack}
            onClick={() => void player.toggle()}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="下一首"
            disabled={!hasTrack}
            onClick={() => void player.next()}
          >
            <SkipForwardIcon />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatDuration(shownMs / 1000)}
        </span>
        <Slider
          className="min-w-0 flex-1"
          // 总长还不知道（元数据没来）时禁用进度条：拖动一个范围未知的滑块，
          // 落点是没有任何意义的；左边的读数仍然是真实进度。
          value={[durationMs > 0 ? Math.min(shownMs, durationMs) : 0]}
          max={durationMs > 0 ? durationMs : 1}
          disabled={!hasTrack || durationMs <= 0}
          aria-label="播放进度"
          onValueChange={(values) => {
            const next = values[0] ?? 0
            setDragMs(next)
            player.seek(next)
          }}
          onValueCommit={() => setDragMs(null)}
        />
        <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
          {durationMs > 0 ? formatDuration(durationMs / 1000) : "—"}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={state.muted ? "取消静音" : "静音"}
          onClick={() => player.toggleMute()}
        >
          <VolumeIcon />
        </Button>
        <Slider
          className="w-24 shrink-0"
          value={[state.muted ? 0 : state.volume * 100]}
          max={100}
          aria-label="音量"
          onValueChange={(values) => {
            player.setVolume((values[0] ?? 0) / 100)
          }}
        />
      </div>
    </div>
  )
}

/** 播放队列面板（R9 接通）：真实队列 + 点击跳播 + 清空。 */
export interface QueuePanelProps {
  entries: PlayerState["entries"]
  index: number
  onSelect?: (index: number) => void
  onClear?: () => void
}

export function QueuePanel({ entries, index, onSelect, onClear }: QueuePanelProps) {
  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4" data-testid="queue-panel">
        <p className="text-sm text-muted-foreground">队列为空。</p>
        <p className="text-xs text-muted-foreground">在任意列表里双击一首歌开始播放。</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4" data-testid="queue-panel">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{`队列 ${entries.length} 首`}</p>
        <Button variant="ghost" size="sm" onClick={() => onClear?.()} disabled={onClear === undefined}>
          清空
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-1">
          {entries.map((entry, position) => (
            <li key={`${entry.id}-${position}`}>
              <Button
                variant={position === index ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-start"
                aria-current={position === index ? "true" : undefined}
                onClick={() => onSelect?.(position)}
              >
                {/* R38：队列行的小封面（恢复出来的条目只有标识，占位是常态） */}
                <CoverArt coverUrl={trackCoverUrlOf(entry)} className="size-6 rounded-sm" iconClassName="size-3.5" />
                <span className="truncate">{trackTitleOf(entry)}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{trackArtistOf(entry)}</span>
              </Button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
}
