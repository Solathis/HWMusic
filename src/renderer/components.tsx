/**
 * 主界面的展示组件（R8）：**只组合 shadcn 原语 + Tailwind 工具类 + 设计令牌**。
 *
 * 分工（照简报）：
 * - `TrackTable`：曲目表的唯一实现（双击播放、键盘可达、艺人/专辑跳转、收藏槽位）；
 * - `PlayerBar` / `QueuePanel`：**本任务只有骨架**。播放状态机与歌词是 R9，
 *   所以这里所有按钮都是 `data-state="placeholder"` 下的**禁用**态——点了没反应比禁用更糟；
 * - `EmptyState` / `LoadFailed` / `GridSkeleton` / `ListSkeleton`：空态、失败态与骨架屏，
 *   文案一律由调用方从 features/library 的纯逻辑模块取（这里不造第二套文案）。
 *
 * 收藏槽位的诚实处理：收藏的**写入**接口还没确认（docs/API_CONTRACT.md §2.1），
 * 所以没接 `onToggleFavorite` 时按钮是禁用的，无障碍名称直接说明原因——
 * 不做"点了看起来成功、其实什么都没存"的乐观更新。
 */
import {
  HeartIcon,
  MusicIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react"

import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Card } from "./components/ui/card"
import { Skeleton } from "./components/ui/skeleton"
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
  trackDurationOf,
  trackIdOf,
  trackNameOf,
  formatDuration,
} from "./features/library/track-fields.mjs"

/** 空态：一句话（文案来自纯逻辑模块，克制且不冒充）。 */
export function EmptyState({ text }: { text: string }) {
  return (
    <p className="px-4 py-10 text-center text-sm text-muted-foreground" role="status">
      {text}
    </p>
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
  /** 双击（或回车/空格）播放：R9 接通播放器前，调用方只做"选中"这种不冒充的事 */
  onActivate?: (song: unknown) => void
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
              onDoubleClick={() => onActivate?.(song)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                onActivate?.(song)
              }}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <TableCell className="text-center tabular-nums text-muted-foreground">{index + 1}</TableCell>
              <TableCell className="font-medium">{trackNameOf(song)}</TableCell>
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
 * 播放器栏骨架（R9 接通）。
 *
 * `data-state="placeholder"` 是给测试与 review 的锚点：这里只有布局与禁用按钮，
 * 没有 Audio 实例、没有进度、没有队列状态——那些是播放状态机的事。
 */
export function PlayerBar() {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-t bg-background px-4 py-3"
      data-state="placeholder"
      data-testid="player-bar"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <MusicIcon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">未在播放</span>
        <span className="truncate text-xs text-muted-foreground">播放器将在后续任务接入。</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" disabled aria-label="上一首">
          <SkipBackIcon />
        </Button>
        <Button variant="ghost" size="icon" disabled aria-label="播放">
          <PlayIcon />
        </Button>
        <Button variant="ghost" size="icon" disabled aria-label="下一首">
          <SkipForwardIcon />
        </Button>
      </div>
    </div>
  )
}

/** 播放队列面板骨架（R9 接通）：只有"选了哪首"这一条本任务能诚实提供的信息。 */
export function QueuePanel({ selectedTrackName }: { selectedTrackName?: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4" data-testid="queue-panel">
      {selectedTrackName ? (
        <p className="text-sm text-muted-foreground">已选曲目：{selectedTrackName}</p>
      ) : null}
      <p className="text-sm text-muted-foreground">队列为空。</p>
      <p className="text-xs text-muted-foreground">播放器接入后这里显示队列。</p>
    </div>
  )
}
