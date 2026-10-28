/**
 * 库页面：歌单详情 / 搜索 / 专辑 / 歌手 / 播放历史，加上设置页。
 *
 * 所有页面都走 `useLibraryResource` 一次取一页；加载中 / 失败 / 真空调分开渲染。
 * 歌单详情 / 搜索 / 专辑走服务端分页，歌手 / 历史接口本身不分页，只本地分批揭示。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { ListPlusIcon, ListMusicIcon, PlayIcon } from "lucide-react"

import {
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_HISTORY,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_SEARCH,
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_TEST_PROXY,
  type RequestChannel,
} from "../shared/request-channels.ts"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Badge } from "./components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select"
import { Switch } from "./components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { CoverArt, EmptyState, ListSkeleton, LoadFailed, TrackTable } from "./components"
import { AmllBackground } from "./AmllBackground.tsx"
import type { TrackRowActions } from "./track-menu.tsx"
import { LogTerminal } from "./log-terminal.tsx"
import type { LogEntry } from "./log-terminal.tsx"
import { RUN_LOG_READ_LIMIT } from "./features/settings/run-log.mjs"
import { LyricsCacheCard } from "./lyrics-cache-card.tsx"
import { TaskbarLyricsCard } from "./taskbar-lyrics-card.tsx"
import { coreCall, getAutostart, setAutostart } from "./host-api"
import { libraryEmptyText, libraryFailureText } from "./features/library/library-state.mjs"
import {
  describeImportSummary,
  describeRejectedImports,
  unavailableLocalSongIds,
} from "./features/library/local-library.mjs"
import { fetchLocalLibrary, importLocalTracks, removeLocalTrack } from "./features/library/local-bridge.ts"
import { useLibraryResource } from "./features/library/use-library-resource.ts"
import {
  PLAYLIST_ENQUEUE_LABEL,
  PLAYLIST_PLAY_ALL_LABEL,
  playlistCoverUrlOf,
  playlistDetailMetaText,
  playlistDetailTitleOf,
} from "./features/library/playlist-fields.mjs"
import {
  APPEARANCE_NOTICE_TEXT,
  CLOSE_BEHAVIORS,
  TRAY_AVAILABLE,
  autostartFailureText,
  autostartStateText,
  autostartStatusFailureText,
  closeBehaviorFromSettings,
  closeBehaviorLabel,
  closeBehaviorNotice,
  closeBehaviorPatch,
  passwordHint,
  proxyFormFromSettings,
  proxyPatchFromForm,
  proxySaveNotice,
  proxyTestResultText,
  queueSummary,
  queueSummaryText,
  settingsFailureText,
  validateProxyForm,
} from "./features/settings/settings-form.mjs"
import {
  PAGINATION_FAILURE_TESTID,
  PAGINATION_PAGE_SIZE,
  PAGINATION_SOURCE,
  PAGINATION_RETRY_TESTID,
  PAGINATION_ROOT_MARGIN,
  PAGINATION_SENTINEL_TESTID,
  PAGINATION_STATUS_TESTID,
  applyFailure,
  applyPage,
  beginPage,
  createLocalListState,
  activationQueueOf,
  createPaginationState,
  findScrollRoot,
  hasRevealableItems,
  isInitialPaging,
  markSentinelAway,
  nextPageOf,
  paginationNoticeText,
  resetPagination,
  retryPagination,
  revealMore,
  shouldObserve,
  shouldRequestNext,
  visibleItemsOf,
} from "./features/library/pagination.mjs"
import { VIEW, createView, viewParam } from "./features/library/views.mjs"
import { THEME_CHOICES, themeLabel } from "./features/theme/theme.mjs"
import { useThemeChoice } from "./features/theme/use-theme-choice.ts"
import {
  LYRICS_MODES,
  modeLabel,
  taskbarStatusText,
} from "./features/lyrics/lyrics-window.mjs"
import type { LyricsWindowBinding } from "./use-lyrics-window.ts"

/** 页大小：与协议层默认的 50 同档。 */
const LIST_PAGE_SIZE = PAGINATION_PAGE_SIZE

/** 视图对象（与 features/library/views.mjs 的 createView 产物同形）。 */
export interface View {
  id: string
  params: Record<string, string>
}

// ---------------------------------------------------------------------------
// 触底分页：判定全在 pagination.mjs，这里只做 React 接线

/** 分页状态（与 pagination.mjs 的产物同形）。 */
type PaginationState = ReturnType<typeof createPaginationState>
/** 本地分批状态（歌手/历史：一次响应，分批揭示）。 */
type LocalListState = ReturnType<typeof createLocalListState>

/** 空数组的稳定身份：`data ?? []` 每次渲染都给新数组，会把重置 effect 变成死循环。 */
const NO_ITEMS: unknown[] = []

/** 协议层一页的回执 → 分页纯逻辑要的形状（渲染层不再解析原始响应）。 */
function pageAnswerOf(data: unknown) {
  const payload = (data ?? {}) as {
    songs?: unknown
    hasMore?: unknown
    skipped?: unknown
    playlist?: unknown
    fullSongs?: unknown
    pageSource?: unknown
    available?: unknown
  }
  return {
    items: Array.isArray(payload.songs) ? payload.songs : [],
    // 只有协议层明说"还有下一页"才算更多（渲染层不自己从条数猜）
    hasMore: payload.hasMore === true,
    skipped: Number.isInteger(payload.skipped) ? (payload.skipped as number) : 0,
    // 歌单详情的歌单元信息跟着第一页过来（分页纯逻辑只认第一页那份）
    meta: payload.playlist ?? null,
    // 整张歌单（协议层确认整份已在内存时才给）：两个动作据此作用于全部曲目
    full: Array.isArray(payload.fullSongs) ? payload.fullSongs : null,
    // 这一页是怎么来的（server / local-slice / server-repeat）与响应条数都由协议层说，渲染层不猜。
    pageSource: payload.pageSource,
    available: payload.available,
  }
}

interface Paging {
  state: PaginationState
  /** 哨兵：接近它（进入前 240px）取下一页 */
  sentinelRef: RefObject<HTMLDivElement | null>
  /** 失败重试：用户在错误条上点的那一下（不自动重试，见 pagination.mjs） */
  retry: () => void
}

/**
 * 服务端分页取数（歌单详情 / 搜索 / 专辑）：查询换代即清空，在途请求不重复发。
 */
function usePaginatedTracks({
  channel,
  params,
  enabled = true,
  pageSize = PAGINATION_PAGE_SIZE,
  keyOf,
}: {
  channel: RequestChannel
  /** 载荷里除 `page`/`pageSize` 之外的部分（关键字/歌单 id/专辑 id） */
  params: Record<string, unknown>
  enabled?: boolean
  pageSize?: number
  /** 去重键（默认按 id；历史/同类列表可以传"含播放时间"的键保留重复） */
  keyOf?: (item: unknown) => string | null
}): Paging {
  const paramsKey = JSON.stringify(params)
  const queryKey = `${channel}\u0000${paramsKey}\u0000${enabled ? 1 : 0}`
  const [holder, setHolder] = useState<{ key: string; state: PaginationState }>(() => ({
    key: queryKey,
    state: createPaginationState(),
  }))
  // 换代的那一帧还没跑 effect：这时先给空状态，别让旧查询的结果继续挂在屏幕上
  const state = holder.key === queryKey ? holder.state : createPaginationState()
  const stateRef = useRef(state)
  stateRef.current = state
  const keyOfRef = useRef(keyOf)
  keyOfRef.current = keyOf
  const generationRef = useRef(0)
  const inFlightRef = useRef<{ generation: number; page: number } | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  /** 本查询代次的写状态入口：查询换过（key 不匹配）的迟到响应一律写不进去。 */
  const patch = useCallback(
    (update: (previous: PaginationState) => PaginationState) => {
      setHolder((previous) => (previous.key === queryKey ? { ...previous, state: update(previous.state) } : previous))
    },
    [queryKey],
  )

  const fetchPage = useCallback(
    async (generation: number, page: number) => {
      const inFlight = inFlightRef.current
      // 正在请求不重复发：同一代次同一页的第二条触发直接吞掉（页号由 state 决定，不会跳页）
      if (inFlight !== null && inFlight.generation === generation) return
      inFlightRef.current = { generation, page }
      patch((previous) => beginPage(previous))
      try {
        const data = await coreCall<unknown>(channel, { ...JSON.parse(paramsKey), page, pageSize })
        const answer = pageAnswerOf(data)
        patch((previous) => applyPage(previous, { generation, ...answer }, keyOfRef.current))
      } catch (failure) {
        // 错误路径才写控制台（结构化错误的人话由 libraryFailureText 给，这里不编）
        console.warn(`库列表分页请求失败（${channel}，第 ${page} 页）：`, failure)
        patch((previous) => applyFailure(previous, { generation, message: libraryFailureText(failure) }))
      } finally {
        const current = inFlightRef.current
        if (current !== null && current.generation === generation && current.page === page) inFlightRef.current = null
      }
    },
    [channel, paramsKey, pageSize, patch],
  )

  // 查询变化（换关键词/换歌单/换专辑/换页）或启用状态变化：换代清空，取第一页
  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    inFlightRef.current = null
    setHolder({ key: queryKey, state: resetPagination(createPaginationState(), generation) })
    // 没启用（没有关键字/没有 id）就不发请求：那不是错误，是"还没到取数的时候"
    if (enabled) void fetchPage(generation, 1)
  }, [queryKey, enabled, fetchPage])

  /**
   * 哨兵：进入前 240px 取下一页；`armed` 保证一页只取一次，离开触发区才重新上膛。
   */
  const [rescan, setRescan] = useState(0)
  const observe = shouldObserve(state)
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || !observe) return
    const root = findScrollRoot(sentinel)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          setHolder((previous) => (previous.key === queryKey ? { ...previous, state: markSentinelAway(previous.state) } : previous))
          return
        }
        const current = stateRef.current
        if (!shouldRequestNext(current)) return
        void fetchPage(generationRef.current, nextPageOf(current))
      },
      { root, rootMargin: PAGINATION_ROOT_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [observe, queryKey, rescan, fetchPage])

  /**
   * 用户手势即"再次接近底部"：短列表里哨兵一直可见，只有真实手势能继续取页。
   */
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || !observe) return
    const root = findScrollRoot(sentinel)
    const target: any = root ?? (typeof window === "undefined" ? null : window)
    if (target === null) return
    const onGesture = () => {
      if (stateRef.current.armed === true) return
      setHolder((previous) => (previous.key === queryKey ? { ...previous, state: markSentinelAway(previous.state) } : previous))
      setRescan((value) => value + 1)
    }
    target.addEventListener("wheel", onGesture, { passive: true })
    target.addEventListener("touchmove", onGesture, { passive: true })
    return () => {
      target.removeEventListener("wheel", onGesture)
      target.removeEventListener("touchmove", onGesture)
    }
  }, [observe, queryKey])

  const retry = useCallback(() => {
    const current = stateRef.current
    if (current.loading) return
    const ready = retryPagination(current)
    patch(() => ready)
    void fetchPage(generationRef.current, nextPageOf(ready))
  }, [fetchPage, patch])

  return { state, sentinelRef, retry }
}

/**
 * 本地分批（歌手 / 历史）：接口不分页，一次响应就是全部，这里只按批揭示。
 */
function useLocalReveal(items: unknown[]): {
  state: LocalListState
  sentinelRef: RefObject<HTMLDivElement | null>
} {
  const [state, setState] = useState<LocalListState>(() => createLocalListState(items))
  const [sourceItems, setSourceItems] = useState(items)
  if (sourceItems !== items) {
    setSourceItems(items)
    setState(createLocalListState(items))
  }
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const more = hasRevealableItems(state)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || !more) return
    const root = findScrollRoot(sentinel)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setState((previous) => revealMore(previous))
      },
      { root, rootMargin: PAGINATION_ROOT_MARGIN },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [more, state.revealed])

  return { state, sentinelRef }
}

/**
 * 曲目列表外壳：骨架 / 失败（带重试）/ 空 / 表格 + 状态行 + 哨兵，两种分页共用。
 */
function BrowsableTrackList({
  items,
  queueItems,
  emptyText,
  navigation,
  status,
  sentinelRef,
  loading = false,
  initialLoading = false,
  error = null,
  onRetry,
  observe = false,
}: {
  items: unknown[]
  /** 整表已在内存时给整份：双击某行排的是整表（不传 = 只有已显示的这批是已知的） */
  queueItems?: unknown[]
  emptyText: string
  navigation: PageNavigationProps
  /** 状态行：已加载 N 首（服务端分页）；空串 = 这一页不挂状态行（歌手/历史） */
  status: string
  sentinelRef: RefObject<HTMLDivElement | null>
  loading?: boolean
  initialLoading?: boolean
  error?: string | null
  onRetry?: () => void
  observe?: boolean
}) {
  return (
    <div className="flex flex-col">
      {error === null ? null : (
        <Alert variant="destructive" className="mx-4 mb-3" data-testid={PAGINATION_FAILURE_TESTID}>
          <AlertDescription>{error}</AlertDescription>
          {onRetry === undefined ? null : (
            <AlertAction>
              <Button variant="secondary" size="sm" onClick={onRetry} data-testid={PAGINATION_RETRY_TESTID}>
                重试
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {items.length === 0 ? (
        // 四种"还没有歌"要分开：首屏加载 / 翻页加载 → 骨架；失败 → 上面那条 Alert 已说原因；
        // 真的空 → 空态。把前三种显示成"还没有歌曲"都是假空态。
        error !== null ? null : loading || initialLoading ? (
          <ListSkeleton />
        ) : (
          <EmptyState text={emptyText} />
        )
      ) : (
        <TrackTable
          songs={items}
          emptyText={emptyText}
          // 队列与「播放全部」同一个基准：整表在内存就是整张表，否则是已加载的这批
          onActivate={(song, index) => {
            const target = activationQueueOf(items, queueItems, song, index)
            navigation.onActivateTrack(song, target.index, target.queue)
          }}
          onOpenAlbum={navigation.onOpenAlbum}
          onOpenArtist={navigation.onOpenArtist}
          onPlayNext={navigation.rowActions?.onPlayNext}
          onEnqueue={navigation.rowActions?.onEnqueue}
        />
      )}

      {loading && items.length > 0 ? <ListSkeleton count={2} /> : null}
      {status === "" ? null : (
        <p
          className="px-4 py-3 text-xs text-muted-foreground"
          role="status"
          data-testid={PAGINATION_STATUS_TESTID}
        >
          {status}
        </p>
      )}
      {observe ? (
        <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" data-testid={PAGINATION_SENTINEL_TESTID} />
      ) : null}
    </div>
  )
}

export interface PageNavigationProps {
  /** 双击曲目：`songs` 是**已加载**的完整列表（播放器用它当队列） */
  onActivateTrack: (song: unknown, index: number, songs: unknown[]) => void
  onOpenAlbum: (albumId: string, song: unknown) => void
  onOpenArtist: (artistId: string, song: unknown) => void
  /** 行菜单的两个播放动作（外壳提供，页面只转给曲目表，不自己实现） */
  rowActions?: TrackRowActions
}

// ---------------------------------------------------------------------------
// 歌单详情
// ---------------------------------------------------------------------------

/**
 * 歌单详情页：头部（封面 / 名称 / 元信息）+ 动作（播放全部 / 加入队列）+ 触底分页的曲目表。
 */
export interface PlaylistDetailData {
  songs: unknown[]
  playlist: unknown
  hasMore: boolean
}

export function PlaylistDetailPage({
  view,
  onPlayAll,
  onEnqueue,
  ...navigation
}: {
  view: View
  /** 播放全部：把整张歌单的曲目整队替换并播放第一首 */
  onPlayAll?: (songs: unknown[]) => void
  /** 加入队列：追加到队尾（不动正在播的那一首），同样作用于整张歌单 */
  onEnqueue?: (songs: unknown[]) => void
} & PageNavigationProps) {
  const playlistId = viewParam(view, "playlistId")
  const paging = usePaginatedTracks({
    channel: LIBRARY_PLAYLIST_DETAIL,
    params: { playlistId },
    enabled: playlistId !== null,
  })

  const state = paging.state
  const songs = state.items
  // 歌单元信息只认第一页；重复整页停止时不把元信息里未经验证的 count 当成总数
  const playlist = state.pageSource === PAGINATION_SOURCE.serverRepeat ? null : state.meta
  const hasMore = state.hasMore === true
  const coverUrl = playlistCoverUrlOf(playlist)
  const title = playlistDetailTitleOf(playlist, viewParam(view, "name"))
  /** 两个动作的曲目：整表在内存时就是整张歌单，否则退回已加载的那批。 */
  const actionSongs = state.full ?? songs
  const actionsDisabled = actionSongs.length === 0

  return (
    <div className="flex flex-col" data-testid="playlist-detail">
      <Card className="relative m-4 overflow-hidden">
        {/* 头部底景：AMLL 官方流体背景（封面经 new Image() 载入 = img-src 路径，不是 fetch） */}
        <div className="absolute inset-0" aria-hidden="true">
          <AmllBackground playing={false} hasLyric albumUrl={coverUrl} />
        </div>
        {/* 压暗层：令牌色的半透明层，保证名字在任意封面上都读得清（与歌词舞台同一手法） */}
        <div className="absolute inset-0 bg-background/75" aria-hidden="true" />

        <CardContent className="relative flex flex-col gap-4 sm:flex-row sm:items-end">
          <CoverArt
            coverUrl={coverUrl}
            className="size-32 shrink-0 rounded-lg"
            iconClassName="size-10"
            icon={ListMusicIcon}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <CardTitle className="truncate text-2xl">{title}</CardTitle>
            <CardDescription>{playlistDetailMetaText(playlist, songs.length, hasMore)}</CardDescription>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button disabled={actionsDisabled || onPlayAll === undefined} onClick={() => onPlayAll?.(actionSongs)}>
                <PlayIcon />
                {PLAYLIST_PLAY_ALL_LABEL}
              </Button>
              <Button
                variant="secondary"
                disabled={actionsDisabled || onEnqueue === undefined}
                onClick={() => onEnqueue?.(actionSongs)}
              >
                <ListPlusIcon />
                {PLAYLIST_ENQUEUE_LABEL}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <BrowsableTrackList
        items={songs}
        queueItems={state.full ?? undefined}
        emptyText={libraryEmptyText(view)}
        navigation={navigation}
        status={paginationNoticeText({ loaded: songs.length, hasMore, pageSource: state.pageSource })}
        sentinelRef={paging.sentinelRef}
        loading={state.loading}
        initialLoading={isInitialPaging(state)}
        error={state.error}
        onRetry={paging.retry}
        observe={shouldObserve(state)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 搜索：结果（输入框在侧栏顶部）

/**
 * 搜索结果页：检索词由视图参数交下来，页面既不渲染输入框也不持有 keyword。
 */
export function SearchPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const keyword = viewParam(view, "keyword")
  // 没提交过（keyword 为 null）就不发请求：空关键字在 core 侧是 invalid_payload，
  // 那不是用户想看到的"错误"（"输入关键字开始搜索。"才是实话）
  const paging = usePaginatedTracks({
    channel: LIBRARY_SEARCH,
    params: { keyword: keyword ?? "" },
    enabled: keyword !== null,
  })

  if (keyword === null) return <EmptyState text={libraryEmptyText(view)} />

  return (
    <BrowsableTrackList
      items={paging.state.items}
      emptyText={libraryEmptyText(view, { searched: true })}
      navigation={navigation}
      status={paginationNoticeText({ loaded: paging.state.items.length, hasMore: paging.state.hasMore })}
      sentinelRef={paging.sentinelRef}
      loading={paging.state.loading}
      initialLoading={isInitialPaging(paging.state)}
      error={paging.state.error}
      onRetry={paging.retry}
      observe={shouldObserve(paging.state)}
    />
  )
}

// ---------------------------------------------------------------------------
// 专辑 / 歌手 / 播放历史
// ---------------------------------------------------------------------------

/**
 * 专辑页：**服务端分页**（协议层的 `album` 认 `start`/`limit`，通道边界仍是 `page`/`pageSize`）。
 * 滚动接近底就取下一页，`hasMore` 只认协议层那句"还有"。
 */
export function AlbumPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const albumId = viewParam(view, "albumId")
  const paging = usePaginatedTracks({
    channel: LIBRARY_ALBUM,
    params: { albumId },
    enabled: albumId !== null,
  })
  return (
    <BrowsableTrackList
      items={paging.state.items}
      emptyText={libraryEmptyText(view)}
      navigation={navigation}
      status={paginationNoticeText({ loaded: paging.state.items.length, hasMore: paging.state.hasMore })}
      sentinelRef={paging.sentinelRef}
      loading={paging.state.loading}
      initialLoading={isInitialPaging(paging.state)}
      error={paging.state.error}
      onRetry={paging.retry}
      observe={shouldObserve(paging.state)}
    />
  )
}

/**
 * 歌手页：后端不分页，只发一次请求，UI 每批揭示 50 条。
 */
export function ArtistPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const artistId = viewParam(view, "artistId")
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_ARTIST,
    { artistId },
    select,
    artistId !== null,
  )
  const reveal = useLocalReveal(resource.data ?? NO_ITEMS)

  if (resource.status === "loading") return <ListSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />

  return (
    <BrowsableTrackList
      items={visibleItemsOf(reveal.state)}
      queueItems={resource.data ?? undefined}
      emptyText={libraryEmptyText(view)}
      navigation={navigation}
      status=""
      sentinelRef={reveal.sentinelRef}
      observe={hasRevealableItems(reveal.state)}
    />
  )
}

/**
 * 播放历史：同样只请求一次、本地分批揭示；重复条目有意义，这一层不去重。
 */
export function HistoryPage({ ...navigation }: PageNavigationProps) {
  const view = createView(VIEW.history)
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(LIBRARY_HISTORY, { page: 1, pageSize: LIST_PAGE_SIZE }, select)
  const reveal = useLocalReveal(resource.data ?? NO_ITEMS)

  if (resource.status === "loading") return <ListSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />

  return (
    <BrowsableTrackList
      items={visibleItemsOf(reveal.state)}
      queueItems={resource.data ?? undefined}
      emptyText={libraryEmptyText(view)}
      navigation={navigation}
      status=""
      sentinelRef={reveal.sentinelRef}
      observe={hasRevealableItems(reveal.state)}
    />
  )
}

// ---------------------------------------------------------------------------
// 本地歌曲

/**
 * 本地歌曲页：移除只删曲库记录、不删文件；列表跟着命令回执里的整库快照走。
 */
export function LocalSongsPage({ ...navigation }: PageNavigationProps) {
  const view = createView(VIEW.local)
  const [state, setState] = useState<{ tracks: unknown[]; baseUrl: string | null; available: boolean }>({
    tracks: [],
    baseUrl: null,
    available: true,
  })
  const [status, setStatus] = useState("")
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const apply = useCallback((answer: { tracks: unknown[]; baseUrl: string | null; available?: boolean }) => {
    setState({ tracks: answer.tracks, baseUrl: answer.baseUrl, available: answer.available !== false })
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setFailure(null)
    try {
      apply(await fetchLocalLibrary())
    } catch (cause) {
      setFailure(libraryFailureText(cause))
    } finally {
      setLoading(false)
    }
  }, [apply])

  useEffect(() => {
    void reload()
  }, [reload])

  const onImport = useCallback(
    async (folder: boolean) => {
      if (busy) return
      setBusy(true)
      setFailure(null)
      try {
        const answer = await importLocalTracks(folder ? { folder: true } : {})
        apply(answer)
        const summary = describeImportSummary(answer)
        const rejected = describeRejectedImports(answer.rejected)
        setStatus(rejected === "" ? summary : `${summary}${rejected}`)
      } catch (cause) {
        setFailure(libraryFailureText(cause))
      } finally {
        setBusy(false)
      }
    },
    [apply, busy],
  )

  const onRemove = useCallback(
    async (song: unknown) => {
      const id = typeof song === "object" && song !== null ? String((song as { id?: unknown }).id ?? "") : ""
      if (id === "") return
      setFailure(null)
      try {
        const answer = await removeLocalTrack(id)
        apply(answer)
        setStatus(answer.removed ? "已从本地曲库移除（文件仍在原处）。" : "这条记录已经不在了。")
      } catch (cause) {
        setFailure(libraryFailureText(cause))
      }
    },
    [apply],
  )

  const unavailableIds = unavailableLocalSongIds(state.tracks)

  return (
    <div className="flex flex-col" data-testid="local-songs-page">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className="text-sm text-muted-foreground" data-testid="local-songs-status">
          {status === "" ? (state.tracks.length === 0 ? "" : `共 ${state.tracks.length} 首本地歌曲。`) : status}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onImport(false)} data-testid="local-import-files">
            导入文件…
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onImport(true)} data-testid="local-import-folder">
            导入文件夹…
          </Button>
        </div>
      </div>

      {failure === null ? null : (
        <Alert variant="destructive" className="mx-4 mb-3" data-testid="local-songs-failure">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <ListSkeleton />
      ) : (
        <TrackTable
          songs={state.tracks}
          emptyText={libraryEmptyText(view)}
          onActivate={(song, index) => navigation.onActivateTrack(song, index, state.tracks)}
          onPlayNext={navigation.rowActions?.onPlayNext}
          onEnqueue={navigation.rowActions?.onEnqueue}
          showFavorite={false}
          unavailableIds={unavailableIds}
          onRemove={(song) => void onRemove(song)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 设置

/** `settings:get` / `settings:set` 回执的形状：页面只把整份文档交给 `proxyFormFromSettings`，凭据不回显由投影函数保证。 */
interface SettingsAnswer {
  settings: { schemaVersion: number; data: Record<string, unknown> }
  restartRequired?: boolean
}

export interface SettingsPageProps {
  /**
   * 播放状态（只读摘录用）。设置页**不做任何队列管理**：队列有专门的播放队列面板，
   * 这里只是把"现在有几首、在放哪首"如实显示出来。
   */
  queue?: { entries?: unknown[]; track?: unknown } | null
  /** 托盘是否可用：由外壳启动时查一次 `core_get_tray_available` 交下来；缺省取保守常量 `TRAY_AVAILABLE`，还没答案时如实显示不可用。 */
  trayAvailable?: boolean
  /** 桌面歌词窗的绑定：由外壳的 `useLyricsWindow` 交下来，页面只渲染并提交意图；缺省 `null` = 外壳还没挂上。 */
  lyrics?: LyricsWindowBinding | null
  /** 运行日志：由外壳的 `useNoticeLog()` 交下来——订阅必须留在外壳，否则打开设置页之前的 `app:notice` 全丢；缺省 `[]` 如实显示“暂无日志。”。 */
  notices?: LogEntry[]
}

/** 设置页的二级分类：单页 Tabs 切换，不新开视图、不加路由；这张表是 trigger 与 content 的唯一真源（radix 只认 `value` 相等）。 */
export const SETTINGS_TABS = [
  { id: "general", label: "通用" },
  { id: "network", label: "网络" },
  { id: "lyrics", label: "歌词" },
  { id: "log", label: "日志" },
]

/** 设置页：所有文案与判定都在 `features/settings/settings-form.mjs`（纯函数），页面只塞状态、渲染返回值；凭据只写不读，失败与提示按回执如实说。 */
export function SettingsPage({
  queue = null,
  trayAvailable = TRAY_AVAILABLE,
  lyrics = null,
  notices = [],
}: SettingsPageProps) {
  const [form, setForm] = useState(() => proxyFormFromSettings(null))
  const [closeBehavior, setCloseBehavior] = useState(() => closeBehaviorFromSettings(null))
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null)
  const [autostartReady, setAutostartReady] = useState(false)
  const [autostartBusy, setAutostartBusy] = useState(false)
  const [autostartFailure, setAutostartFailure] = useState<string | null>(null)
  const [autostartReadFailed, setAutostartReadFailed] = useState(false)
  /** 主题档位：与左下角循环按钮、登录页控件同一份接线——读回档位、订阅 `theme:changed`、写回档位全在 `useThemeChoice` 里。 */
  const { choice: themeChoice, select: selectTheme } = useThemeChoice()

  // 读设置：挂载时一次（表单是本地状态，之后的编辑不再打请求）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const answer = await coreCall<SettingsAnswer>(SETTINGS_GET, null)
        if (!alive) return
        setForm(proxyFormFromSettings(answer.settings))
        setCloseBehavior(closeBehaviorFromSettings(answer.settings))
        setLoaded(true)
      } catch (error) {
        if (!alive) return
        setFailure(settingsFailureText(error))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 读开机自启状态：挂载时一次。读不到就不猜（开关显示"未取到"并禁用）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const current = await getAutostart()
        if (alive) setAutostartEnabled(current)
      } catch {
        // core 的原文由 Rust 侧记进运行日志；界面只说那一句（不重复说两遍）
        if (alive) {
          setAutostartReadFailed(true)
          setAutostartFailure(autostartStatusFailureText())
        }
      } finally {
        // "还在读"与"读不到"是两件事：没读完就说"未取到"是把读的过程说成失败
        if (alive) setAutostartReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 保存代理：先本地校验（坏端口先拦下），再落盘，最后按回执重建表单与提示。 */
  async function saveProxy() {
    const invalid = validateProxyForm(form)
    if (invalid !== null) {
      setFailure(invalid)
      setNotice(null)
      return
    }
    setSaving(true)
    setFailure(null)
    setNotice(null)
    try {
      const answer = await coreCall<SettingsAnswer>(SETTINGS_SET, { patch: proxyPatchFromForm(form) })
      // 按回执重建表单：写的和显示的下一次是同一条数据（密码字段随之回到空）
      setForm(proxyFormFromSettings(answer.settings))
      setCloseBehavior(closeBehaviorFromSettings(answer.settings))
      setNotice(proxySaveNotice(answer.settings, answer.restartRequired === true))
    } catch (error) {
      setFailure(settingsFailureText(error))
    } finally {
      setSaving(false)
    }
  }

  /** 恢复默认：**只回默认代理**（整份 reset 会把关窗行为一起打回默认，用户没要求那件事）。 */
  async function restoreDefaultProxy() {
    setSaving(true)
    setFailure(null)
    setNotice(null)
    setTestResult(null)
    try {
      const answer = await coreCall<SettingsAnswer>(SETTINGS_SET, { patch: { proxy: null } })
      setForm(proxyFormFromSettings(answer.settings))
      setCloseBehavior(closeBehaviorFromSettings(answer.settings))
      setNotice(proxySaveNotice(answer.settings, answer.restartRequired === true))
    } catch (error) {
      setFailure(settingsFailureText(error))
    } finally {
      setSaving(false)
    }
  }

  /** 测试连接：用**表单当前的草稿**（用户想验证的是刚填的这组，不是已保存的旧值）。 */
  async function testConnection() {
    const invalid = validateProxyForm(form)
    if (invalid !== null) {
      setFailure(invalid)
      return
    }
    setTesting(true)
    setFailure(null)
    setTestResult(null)
    try {
      const answer = await coreCall<{ result: unknown }>(SETTINGS_TEST_PROXY, {
        proxy: proxyPatchFromForm(form).proxy,
      })
      setTestResult(proxyTestResultText(answer.result))
    } catch (error) {
      setFailure(settingsFailureText(error))
    } finally {
      setTesting(false)
    }
  }

  async function chooseCloseBehavior(value: string) {
    const previous = closeBehavior
    const next = closeBehaviorPatch(value).closeBehavior
    setSaving(true)
    setCloseBehavior(next)
    setFailure(null)
    setNotice(null)
    try {
      const answer = await coreCall<SettingsAnswer>(SETTINGS_SET, { patch: closeBehaviorPatch(next) })
      setCloseBehavior(closeBehaviorFromSettings(answer.settings))
      setNotice(proxySaveNotice(answer.settings, answer.restartRequired === true))
    } catch (error) {
      // 没写成就把选择拨回去：界面上停在一个"没保存的值"，跟撒谎只差一步
      setCloseBehavior(previous)
      setFailure(settingsFailureText(error))
    } finally {
      setSaving(false)
    }
  }

  /** 自启开关：显示的是 core **回报的实际状态**（乐观翻转会在写入失败时撒谎）。 */
  async function applyAutostart(next: boolean) {
    setAutostartBusy(true)
    setAutostartFailure(null)
    try {
      setAutostartEnabled(await setAutostart(next))
    } catch (error) {
      setAutostartFailure(autostartFailureText(error))
    } finally {
      setAutostartBusy(false)
    }
  }

  const busy = saving || testing

  return (
    /* 不加宽度上限：宽屏由各标签页的 xl 两列网格分配宽度 */
    <div className="m-4 flex flex-col gap-4" data-testid="settings-page">
      {failure !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {/* 二级分类：单页 Tabs，不新开视图（分法与「日志为什么单独一类」见 SETTINGS_TABS） */}
      <Tabs defaultValue={SETTINGS_TABS[0].id} className="flex flex-col gap-4" data-testid="settings-tabs">
        <TabsList aria-label="设置分类">
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* 通用：日常使用里会被改的四件（宽屏两列、窄屏单列；items-start 让高矮不同的卡不互相拉齐） */}
        <TabsContent value="general" className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>关窗行为</CardTitle>
              <CardDescription>点关闭按钮时做什么。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Select
                value={closeBehavior}
                disabled={!loaded || saving}
                onValueChange={(value) => void chooseCloseBehavior(value)}
              >
                <SelectTrigger aria-label="关窗行为" className="w-full max-w-xs">
                  {/* 直接把标签写进 SelectValue：radix 在没有展开过内容时拿不到选项文案
                      （选项文本要等它挂载），触发器就会是空的——受控值 + 自绘标签才稳定 */}
                  <SelectValue>{closeBehaviorLabel(closeBehavior)}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="start" sideOffset={4}>
                  <SelectGroup>
                    {CLOSE_BEHAVIORS.map((behavior) => (
                      <SelectItem key={behavior} value={behavior}>
                        {closeBehaviorLabel(behavior)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {/* 可用性来自宿主：`trayAvailable` 由外壳启动时查一次交下来 */}
                {closeBehaviorNotice(closeBehavior, { trayAvailable })}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>开机自启</CardTitle>
              <CardDescription>登录系统后自动启动本应用（写入系统自启项）。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="autostart-enabled"
                  checked={autostartEnabled === true}
                  disabled={!autostartReady || autostartEnabled === null || autostartBusy}
                  onCheckedChange={(checked) => void applyAutostart(checked)}
                />
                <Label htmlFor="autostart-enabled">随系统启动</Label>
              </div>
              {/* 读失败时状态行让位给下面那一句：同一个失败不说两遍 */}
              {autostartReadFailed ? null : (
                <p className="text-xs text-muted-foreground">
                  {autostartReady ? autostartStateText(autostartEnabled) : "正在读取当前状态…"}
                </p>
              )}
              {autostartFailure !== null ? (
                <p className="text-xs text-destructive" role="alert">
                  {autostartFailure}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>外观</CardTitle>
              <CardDescription>{APPEARANCE_NOTICE_TEXT}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-1">
                <Label htmlFor="theme-choice">主题</Label>
                {/* 三态落在这里：与左下角循环按钮、登录页控件同源同向，接线全在 `useThemeChoice` */}
                <Select value={themeChoice} onValueChange={selectTheme}>
                  <SelectTrigger id="theme-choice" aria-label="主题" className="w-full max-w-xs">
                    {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案 */}
                    <SelectValue>{themeLabel(themeChoice)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" sideOffset={4}>
                    <SelectGroup>
                      {THEME_CHOICES.map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {themeLabel(choice)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>播放队列</CardTitle>
              <CardDescription>这里只显示当前状态，队列在播放队列面板里管理。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{queueSummaryText(queueSummary(queue))}</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 网络：单张表单卡保持整宽，放进半栏会把主机/端口/账号字段挤窄 */}
        <TabsContent value="network" className="grid grid-cols-1 items-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>网络与代理</CardTitle>
              <CardDescription>
                代理只对本应用的请求生效。凭据写入本机配置文件，界面上不回显。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="proxy-enabled"
                  checked={form.enabled}
                  disabled={!loaded || busy}
                  onCheckedChange={(checked) => setForm((current) => ({ ...current, enabled: checked }))}
                />
                <Label htmlFor="proxy-enabled">使用代理</Label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="proxy-host">主机</Label>
                  <Input
                    id="proxy-host"
                    value={form.host}
                    disabled={!loaded || busy}
                    placeholder="proxy.example.com"
                    onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="proxy-port">端口</Label>
                  <Input
                    id="proxy-port"
                    value={form.portText}
                    disabled={!loaded || busy}
                    inputMode="numeric"
                    placeholder="8080"
                    onChange={(event) => setForm((current) => ({ ...current, portText: event.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="proxy-username">用户名</Label>
                  <Input
                    id="proxy-username"
                    value={form.username}
                    disabled={!loaded || busy}
                    autoComplete="off"
                    onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="proxy-password">密码</Label>
                  <Input
                    id="proxy-password"
                    type="password"
                    value={form.password}
                    disabled={!loaded || busy}
                    autoComplete="new-password"
                    onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                  />
                  <span className="text-xs text-muted-foreground">{passwordHint(form)}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="proxy-bypass">例外列表</Label>
                <Input
                  id="proxy-bypass"
                  value={form.bypassText}
                  disabled={!loaded || busy}
                  placeholder="localhost, 127.0.0.1"
                  onChange={(event) => setForm((current) => ({ ...current, bypassText: event.target.value }))}
                />
                <span className="text-xs text-muted-foreground">
                  逗号分隔：这些地址不走代理（例外只在应用内核侧生效）。
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void saveProxy()} disabled={!loaded || busy}>
                  {saving ? "正在保存…" : "保存"}
                </Button>
                <Button variant="secondary" onClick={() => void testConnection()} disabled={!loaded || busy}>
                  {testing ? "正在测试…" : "测试连接"}
                </Button>
                <Button variant="ghost" onClick={() => void restoreDefaultProxy()} disabled={!loaded || busy}>
                  恢复默认代理
                </Button>
              </div>

              {testResult !== null ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {testResult}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 歌词：桌面歌词窗口（在哪显示）+ 歌词缓存/导入（从哪来）——两半本来就可以并排看 */}
        <TabsContent value="lyrics" className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {/* 只放必须在主窗操作的行为项（显示 / 窗口位置）：桌面歌词外观只在它自己的齿轮菜单里改，主窗不代管那扇窗的外观 */}
          <Card>
            <CardHeader>
              <CardTitle>桌面歌词</CardTitle>
              <CardDescription>桌面上的独立歌词窗：开关与显示位置。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="lyrics-visible"
                  checked={(lyrics?.requestedVisible ?? lyrics?.visible) === true}
                  disabled={lyrics === null}
                  onCheckedChange={(checked) => lyrics?.setVisible(checked)}
                />
                <Label htmlFor="lyrics-visible">显示桌面歌词</Label>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="lyrics-mode">窗口位置</Label>
                <Select
                  value={lyrics?.config.mode ?? LYRICS_MODES[0]}
                  disabled={lyrics === null}
                  onValueChange={(value) => lyrics?.updateConfig({ mode: value })}
                >
                  <SelectTrigger id="lyrics-mode" className="w-full max-w-xs">
                    {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案 */}
                    <SelectValue>{modeLabel(lyrics?.config.mode)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" sideOffset={4}>
                    <SelectGroup>
                      {LYRICS_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {modeLabel(mode)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {/* Beta 标记 + Rust 报的那一句状态（认不出按"已停显"说，界面不出现空串） */}
                {lyrics?.config.mode === "taskbar" ? (
                  <div role="status" className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">Beta</Badge>
                    <span className="text-xs text-muted-foreground">{taskbarStatusText(lyrics.taskbar)}</span>
                  </div>
                ) : null}
              </div>

              {lyrics?.saveError ? (
                <Alert>
                  <AlertTitle>桌面歌词配置未保存</AlertTitle>
                  <AlertDescription>{lyrics.saveError}</AlertDescription>
                  <AlertAction>
                    <Button variant="outline" size="sm" onClick={lyrics.retrySave}>
                      重试保存
                    </Button>
                  </AlertAction>
                </Alert>
              ) : null}
            </CardContent>
          </Card>

          {/* 任务栏歌词的外观（颜色 / 逐字 / 字号）——与桌面歌词各存一份，只在 Windows 渲染 */}
          <TaskbarLyricsCard lyrics={lyrics} />

          {/* 歌词缓存 / 一键清除 / 导入本地歌词：与上面那张卡是同一件事的两半（显示 vs 存放） */}
          <LyricsCacheCard lyrics={lyrics} />
        </TabsContent>

        {/* 日志：只读的诊断面板（不是设置项——理由见 SETTINGS_TABS 的注释）；终端始终整宽 */}
        <TabsContent value="log" className="grid grid-cols-1 items-start gap-4">
          {/* 运行日志：宿主的日志文件（含 sidecar 那一侧）+ `app:notice` 的提示；级别、筛选与脱敏全在 `LogTerminal` 里 */}
          <Card>
            <CardHeader>
              <CardTitle>运行日志</CardTitle>
              <CardDescription>{`来自应用内核与宿主的日志（最近 ${RUN_LOG_READ_LIMIT} 条，凭据已打码）。`}</CardDescription>
            </CardHeader>
            <CardContent>
              <LogTerminal notices={notices} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
