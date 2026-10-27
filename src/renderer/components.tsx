/**
 * 主界面的展示组件（R8）：**只组合 shadcn 原语 + Tailwind 工具类 + 设计令牌**。
 * R9 把 `PlayerBar` / `QueuePanel` 从占位骨架翻成接通播放状态机的真实组件。
 *
 * 分工（照简报）：
 * - `TrackTable`：曲目表的唯一实现（双击播放、键盘可达、艺人/专辑跳转、收藏槽位）；
 * - `PlayerBar`：播放/暂停、上下曲、进度（拖动走 200ms isSeeking 窗口）、音量、模式切换。
 *   **它不持有音频、不认识 core**：动作全部转给 `features/playback` 的运行时，
 *   所以 UI 层既拿不到播放地址，也不可能出现第二个 `Audio`；
 * - `QueuePanel`：真实队列（当前项高亮、点击跳播、清空）；旧记录只有标识时，
 *   标题如实显示"曲目 &lt;id&gt;"（见 playback-state.mjs）；
 * - 曲目表与队列的每一行都带专属右键菜单（`TrackRowMenu`）：播放 / 下一首播放 / 加入播放队列；
 * - `EmptyState` / `LoadFailed` / `ListSkeleton`：空态、失败态与骨架屏，
 *   文案一律由调用方从 features/library 的纯逻辑模块取（这里不造第二套文案）。
 *
 * 收藏槽位的诚实处理：收藏的**写入**接口还没确认（docs/API_CONTRACT.md §2.1），
 * 所以没接 `onToggleFavorite` 时按钮是禁用的，无障碍名称直接说明原因——
 * 不做"点了看起来成功、其实什么都没存"的乐观更新。
 */
import { useState } from "react"
import type { ComponentType, ReactElement } from "react"
import {
  CaptionsIcon,
  ChevronDownIcon,
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
  TrashIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react"

import { Alert, AlertDescription } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
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
import { lyricsTargetOf } from "./features/lyrics/lyrics-window.mjs"
import { TRACK_MENU_TARGET } from "./features/shell/track-menu.mjs"
import {
  playbackModeLabel,
  playerStatusText,
  trackArtistOf,
  trackTitleOf,
} from "./features/playback/playback-state.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"
import type { LyricsToggleSurface, LyricsWindowBinding } from "./use-lyrics-window.ts"
import { TrackRowMenu, type TrackRowActions } from "./track-menu.tsx"

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

/**
 * 列表骨架（曲目表的加载态）。
 *
 * R41b：行高从 `h-6`（24px）改成 `h-11`（44px）+ `gap-2`（8px）——**一行骨架 = 52px**，
 * 与真实行高（`p-2` + `size-9` 封面 = 52~53px，真机量的 53px）对齐。
 * 原来是 24 + 8 = 32px 一行：加载完的那一瞬间内容会往下长出一倍，用户看到的是"页面跳了一下"。
 * 骨架屏的职责就是占住真实内容的位置，占错位置比不占更糟。
 */
export function ListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="list-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  )
}

export interface TrackTableProps extends TrackRowActions {
  songs: unknown[]
  emptyText: string
  /** 双击（或回车/空格）播放：带上行下标——播放器要用**整张列表**当队列 */
  onActivate?: (song: unknown, index: number) => void
  onOpenAlbum?: (albumId: string, song: unknown) => void
  onOpenArtist?: (artistId: string, song: unknown) => void
  /** 未接（默认）：收藏写入接口还没确认，按钮如实禁用 */
  onToggleFavorite?: (song: unknown) => void
  favoritedIds?: string[]
  /**
   * 收藏心形这一列要不要出现（默认出现）。本地歌曲传 `false`：
   * "收藏一首本机文件"没有语义（收藏是账号侧的东西），摆一个按不动的按钮只会让人以为坏了。
   */
  showFavorite?: boolean
  /**
   * 文件已经不在的曲目 id（R65）：这些行被标出来（那句"文件不在"就写在行里），
   * 而**不是**从列表里消失——用户在曲库里得看得见它，才能决定要不要移除。
   */
  unavailableIds?: string[]
  /** 移除这一行（本地歌曲那一列：占的正是收藏心形的位置） */
  onRemove?: (song: unknown, index: number) => void
}

/**
 * 曲目表的列宽配比（R40；`table-fixed` 下这就是真实列宽）。
 *
 * **为什么要 `table-fixed`**（真机取证，`.tmp/r40-table-baseline.json`）：默认的 `auto` 布局里
 * 列宽由内容决定，`w-40` 只是一个"建议"——艺人/专辑那两列被 nowrap 的长名字撑到 318 / 479 px，
 * 表格实测长到 1361 px 而内容区只有 1024 px（视口 1280 − 侧栏 256），于是整张表横向溢出，
 * 用户必须右滑才能看完（这正是用户报的那件事）。固定布局下**列宽由这张表说了算**，
 * 内容再长也只在列内截断。
 *
 * 配比：`#`／时长／收藏是固定小列，标题 32%、艺人 24%，专辑是唯一的余量列。
 */
const TRACK_COLUMN_WIDTHS = {
  index: "w-10",
  title: "w-[32%]",
  artist: "w-[24%]",
  duration: "w-16",
  favorite: "w-12",
}

/**
 * 曲目表。
 *
 * 键盘可达：行本身可聚焦，回车/空格等于双击（鼠标用户与键盘用户拿到同一件事）。
 * 艺人/专辑是 shadcn 的 link 按钮——跳不过去（缺 id）时禁用，而不是点了没反应。
 *
 * R40：`table-fixed` + 显式列宽配比 + cell 内真截断，**任何窗宽都不出现横向滚动**
 * （见 `TRACK_COLUMN_WIDTHS` 的说明）。行 key 带上行号：列表里出现同一首歌两次是合法的
 * （收藏/历史都可能有重复），只按 id 做 key 会让 React 报重复 key 并可能少渲染一行
 * ——真机上抓到过 200 条这种警告（`.tmp/r40-dupe-keys.json`）。
 */
export function TrackTable({
  songs,
  emptyText,
  onActivate,
  onOpenAlbum,
  onOpenArtist,
  onToggleFavorite,
  onPlayNext,
  onEnqueue,
  favoritedIds = [],
  showFavorite = true,
  unavailableIds = [],
  onRemove,
}: TrackTableProps) {
  if (songs.length === 0) return <EmptyState text={emptyText} />

  const favorited = new Set(favoritedIds)
  const unavailable = new Set(unavailableIds)

  return (
    /*
      R41b 排版两处（都只为"与其余页面一致 / 表头看得见"）：
      1. **页面级横向留白**：`px-4`。此前曲目表是**贴边**的（真机量的表格左边缘 = 内容区左边缘
         256px），而歌单网格（`p-4`）、设置页（`m-4`）、空态（`px-4`）都在 16px 上——
         同一栏内容在不同页面里左边缘差 16px，翻页时看得出来。留白加在这一层而不是行内，
         是为了让行的 hover 底色仍然铺满整栏（Spotify 那种"行满宽、内容有边距"的形态）。
      2. **表头 sticky**：shadcn 生成的 `Table` 外面套着一层 `overflow-x-auto` 的容器
         （`data-slot="table-container"`）。一个轴上是 `auto` 时另一个轴的 `visible` 会被算成
         `auto`——那层容器于是成了**滚动容器**，表头的 `sticky top-0` 只会相对它定位，
         而它自己从不纵向滚动 = 表头照样滚走（真机量的 `position: static`）。
         这里在调用点把那层容器的 `overflow` 放开（`[&>[data-slot=table-container]]:overflow-visible`），
         表头就跟着页面那个滚动根走。R40 的 `table-fixed` 已经保证不再横向溢出
         （真机量的 `scrollWidth == clientWidth`），所以放开它不会把内容顶出去。
         不改生成原语：这是调用点的覆盖，`components/ui/table.tsx` 一个字都没动。
    */
    <div className="px-4 [&>[data-slot=table-container]]:overflow-visible">
      <Table className="table-fixed" data-testid="track-table">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className={`${TRACK_COLUMN_WIDTHS.index} text-center`}>#</TableHead>
            <TableHead className={TRACK_COLUMN_WIDTHS.title}>标题</TableHead>
            <TableHead className={TRACK_COLUMN_WIDTHS.artist}>艺人</TableHead>
            <TableHead>专辑</TableHead>
            <TableHead className={`${TRACK_COLUMN_WIDTHS.duration} text-right`}>时长</TableHead>
            {showFavorite || onRemove !== undefined ? <TableHead className={TRACK_COLUMN_WIDTHS.favorite} /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {songs.map((song, index) => {
            const id = trackIdOf(song)
            const albumId = trackAlbumIdOf(song)
            const artistId = trackArtistIdOf(song)
            const isFavorited = id !== null && favorited.has(id)
            const isUnavailable = id !== null && unavailable.has(id)
            return (
              <TrackRowMenu
                key={`${id ?? "row"}-${index}`}
                target={TRACK_MENU_TARGET.track}
                songs={[song]}
                canPlay={onActivate !== undefined}
                onPlay={() => onActivate?.(song, index)}
                onPlayNext={onPlayNext}
                onEnqueue={onEnqueue}
              >
                <TableRow
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
                      {/* R65：文件不在就写在这里。行本身留着（用户还看得见它、还能移除它） */}
                      {isUnavailable ? (
                        <Badge variant="outline" className="shrink-0" data-testid="track-unavailable">
                          文件不在
                        </Badge>
                      ) : null}
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
                  {onRemove !== undefined ? (
                    // 本地曲目：这一格是「移除」（不是心形）。移除只把这条记录从曲库里去掉，不碰用户的文件。
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="从本地曲库移除"
                        data-testid="track-remove"
                        onClick={() => onRemove(song, index)}
                      >
                        <TrashIcon />
                      </Button>
                    </TableCell>
                  ) : showFavorite ? (
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
                  ) : null}
                </TableRow>
              </TrackRowMenu>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * 播放栏（R9 接通状态机）。
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
  /**
   * 打开歌词舞台（R40）：**封面与曲目信息整块**都是入口，与头部那枚「歌词」按钮**同一个 state**
   * （用户直觉是"点正在播放这一条进播放页"，而头部的图标按钮不一定被注意到）。
   * 不传就是不接（按钮语义不变，也不会出现"点了没反应"的死区——那时整块只是不可点）。
   */
  onOpenStage?: () => void
  /**
   * 桌面/任务栏歌词的快捷开关（R45C）：播放栏与沉浸页**共用外壳那一个** binding
   * （`useLyricsWindow` 的唯一实例），这里只读状态、只转一次 `setVisible`。
   *
   * 不传 = 不渲染这枚按钮：没有歌词窗接线时放一个按下去什么都不发生的图标，
   * 比没有按钮更糟（用户会以为是自己点错了）。
   */
  lyrics?: LyricsWindowBinding | null
}

/** 播放模式 → 图标（四种模式的取值唯一真源是 player.mjs 的 PLAYBACK_MODES）。 */
const MODE_ICONS = {
  sequential: ListMusicIcon,
  "list-loop": RepeatIcon,
  "single-loop": Repeat1Icon,
  shuffle: ShuffleIcon,
}

/**
 * 歌词快捷开关的**唯一语义**（R45C）：播放栏与沉浸页都读它，不许各写一份。
 *
 * 两条判据，都有理由：
 * 1. **状态取 `requestedVisible ?? visible`**：`visible` 是宿主的回执（它此刻真的开着），
 *    `requestedVisible` 是"我们请求它开着"（binding 里已把**待定意图**排在它前面）。
 *    点下去到回执回来之间有一小段，用回执会让按钮先弹回原状再翻过来（看起来像点了没反应）。
 *    设置页那个 Switch 用的也是这一条。
 * 2. **标签说模式**：同一个图标在桌面模式是"桌面歌词"，在任务栏模式是"任务栏歌词"——
 *    用户看不见歌词窗挂在哪里，只能靠这句话。
 *
 * **这里刻意不产出"下一次该发什么"**：目标态由 binding 的意图机决定（`toggleVisible`）。
 * 渲染快照里的 `!on` 在"同一个任务里连点两次"时是陈旧的——那正是 R45C 要修的那个 bug。
 *
 * 没有 binding 时返回 `null`（没有语义），而不是"假装它是关着的"。
 */
export function lyricsToggleView(lyrics?: LyricsWindowBinding | null): {
  on: boolean
  mode: "desktop" | "taskbar"
  label: string
} | null {
  if (lyrics === null || lyrics === undefined) return null
  const on = (lyrics.requestedVisible ?? lyrics.visible) === true
  const mode = lyrics.config?.mode === "taskbar" ? "taskbar" : "desktop"
  const surface = mode === "taskbar" ? "任务栏歌词" : "桌面歌词"
  return { on, mode, label: `${on ? "隐藏" : "显示"}${surface}` }
}

/** 歌词显示目标的快捷切换（播放栏与沉浸页共用，触发按钮由调用方给出）。 */
export function LyricsTargetMenu({ lyrics, surface, trigger }: {
  lyrics: LyricsWindowBinding
  surface: LyricsToggleSurface
  trigger: ReactElement
}) {
  const view = lyricsToggleView(lyrics)
  const target = lyricsTargetOf(view?.on, view?.mode)
  const taskbarSupported = lyrics.taskbar?.supported === true
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52" data-testid={`${surface}-lyrics-target-menu`}>
        <DropdownMenuRadioGroup value={target} onValueChange={(next) => lyrics.selectTarget(next as "off" | "desktop" | "taskbar", surface)}>
          <DropdownMenuRadioItem value="off">关闭歌词</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desktop">桌面歌词</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="taskbar" disabled={!taskbarSupported}>任务栏歌词（Beta）</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {taskbarSupported ? null : <p className="px-2 py-1.5 text-xs text-muted-foreground">任务栏歌词仅支持 Windows</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PlayerBar({ runtime, state, onOpenStage, lyrics = null }: PlayerBarProps) {
  const [dragMs, setDragMs] = useState<number | null>(null)
  const player = runtime.player
  const lyricsView = lyricsToggleView(lyrics)

  const playing = state.status === "playing"
  const hasTrack = state.track !== null
  const durationMs = state.durationMs
  const shownMs = dragMs ?? state.currentTimeMs
  const ModeIcon = MODE_ICONS[state.mode as keyof typeof MODE_ICONS] ?? ListMusicIcon
  const VolumeIcon = state.muted ? VolumeXIcon : state.volume === 0 ? VolumeXIcon : state.volume < 0.5 ? Volume1Icon : Volume2Icon

  /** 左区：封面 + 曲目信息（R40 起整块可点 = 进歌词舞台）。 */
  const trackInfo = (
    <>
      <CoverArt coverUrl={trackCoverUrlOf(state.track)} className="size-10 rounded-md" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{trackTitleOf(state.track)}</span>
        <span className="truncate text-xs text-muted-foreground">
          {state.track === null ? playerStatusText(state) : `${trackArtistOf(state.track)} · ${playerStatusText(state)}`}
        </span>
      </div>
    </>
  )

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t bg-background px-4 py-2"
      data-state={state.status}
      data-testid="player-bar"
    >
      {/*
        R45C：开关失败就**在按下去的这一条上**说清（原因 + 下一步），带「重试」与「知道了」两条路。
        不另弹 toast、也不把这件事只留在设置页：用户按的是这里，答案就该出现在这里。
        `toggleErrorSurface` 保证同一个失败只在**一处**印：沉浸页发起的那次由沉浸页说，
        播放栏不重复；反过来从设置页/别处发起的（`null`）由这条常驻的播放栏兜住。
        失败文案来自 binding（`toggleError`，由纯函数 `toggleFailureText` 生成，原始错误只在日志里）。
      */}
      {lyrics?.toggleError && lyrics.toggleErrorSurface !== "playback-stage" ? (
        <Alert variant="destructive" className="flex flex-wrap items-center gap-2 py-2" data-testid="lyrics-toggle-error">
          <AlertDescription className="min-w-0 flex-1">{lyrics.toggleError}</AlertDescription>
          <Button variant="outline" size="sm" data-testid="lyrics-toggle-retry" onClick={() => lyrics?.retryToggle?.()}>
            重试
          </Button>
          <Button variant="ghost" size="sm" data-testid="lyrics-toggle-dismiss" onClick={() => lyrics?.dismissToggleError?.()}>
            知道了
          </Button>
        </Alert>
      ) : null}
      {/*
        三区布局（R40 用户要求"控件居中"）：
        左 = 封面 + 曲目信息（min-w-0 + truncate，窄窗先牺牲它）；中 = 播放控件组；
        右 = 附加区（本轮为空占位，保持左中右三段的语义不塌成一团）。

        **控件用绝对定位实现真居中**（`left-1/2 -translate-x-1/2`），而不是
        `flex-1 basis-0` 的两侧等分：两侧内容天然不等宽（左边是封面 + 两行文字，右边是空占位），
        等分只能让"剩余空间"相等，控件的实际中点仍会随左侧文字长度漂移。
        左区预留中控的半宽与间距；长文字先截断，不覆盖中控。
      */}
      <div className="relative flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0 max-w-[calc(100%-6rem)]">
            {onOpenStage === undefined ? (
              <div className="flex w-fit min-w-0 max-w-full items-center gap-3" data-testid="player-track-info">
                {trackInfo}
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="flex h-auto w-fit min-w-0 max-w-full items-center justify-start gap-3 px-1 py-1 text-left"
                aria-label="打开歌词"
                data-testid="player-track-info"
                onClick={onOpenStage}
              >
                {trackInfo}
              </Button>
            )}
          </div>
        </div>

        <div
          className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1"
          data-testid="player-controls"
        >
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
          {/*
            R46：传输组只放传输控件 —— 模式 → 上一首 → 播放 → 下一首。
            R45C 那枚歌词开关已搬到尾部工具区（见下面的 `player-bar-trailing`）。
          */}
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

        {/* 歌词开关与显示目标在尾部工具区，与传输组隔开 */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1" data-testid="player-bar-trailing">
          {lyricsView === null ? null : lyrics === null ? null : (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={lyricsView.label}
                aria-pressed={lyricsView.on}
                data-testid="player-lyrics-toggle"
                onClick={() => lyrics?.toggleVisible("player-bar")}
              >
                <CaptionsIcon />
              </Button>
              <LyricsTargetMenu lyrics={lyrics} surface="player-bar" trigger={
                <Button variant="ghost" size="icon-sm" aria-label="选择歌词显示位置" data-testid="player-lyrics-target">
                  <ChevronDownIcon />
                </Button>
              } />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatDuration(shownMs / 1000)}
        </span>
        <Slider
          className="min-w-0 flex-1"
          // 总长拿不到（音频没读数、条目也没有时长）时禁用进度条：拖动一个范围未知的滑块，
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
        <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="player-duration">
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

/** 播放队列面板（R9 接通）：真实队列 + 点击跳播 + 清空 + 行的专属右键菜单（R63）。 */
export interface QueuePanelProps extends TrackRowActions {
  entries: PlayerState["entries"]
  index: number
  onSelect?: (index: number) => void
  onClear?: () => void
}

export function QueuePanel({ entries, index, onSelect, onClear, onPlayNext, onEnqueue }: QueuePanelProps) {
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
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <ul className="flex min-w-0 flex-col gap-1 [&>li]:min-w-0">
          {entries.map((entry, position) => (
            <li key={`${entry.id}-${position}`}>
              <TrackRowMenu
                target={TRACK_MENU_TARGET.queue}
                songs={[entry]}
                canPlay={onSelect !== undefined}
                onPlay={() => onSelect?.(position)}
                onPlayNext={onPlayNext}
              >
                <Button
                  variant={position === index ? "secondary" : "ghost"}
                  size="sm"
                  className="w-full min-w-0 max-w-full justify-start"
                  aria-current={position === index ? "true" : undefined}
                  onClick={() => onSelect?.(position)}
                >
                  <CoverArt coverUrl={trackCoverUrlOf(entry)} className="size-6 rounded-sm" iconClassName="size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-left">{trackTitleOf(entry)}</span>
                  <span className="ml-auto min-w-0 max-w-1/3 truncate text-xs text-muted-foreground">{trackArtistOf(entry)}</span>
                </Button>
              </TrackRowMenu>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
}
