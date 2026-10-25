/**
 * 库页面（R8）：歌单 / 歌单详情 / 搜索 / 专辑 / 歌手 / 播放历史，加上留给 R10 的设置页。
 *
 * 收藏页不在这里——它是常驻挂载的（favorites-page.tsx），挂在 `renderPage()` 之外。
 *
 * 所有页面的数据都走同一条路：`coreCall(共享常量里的 library:* 频道, 载荷)`，
 * 一次只取一页（`hasMore` 由 sidecar 侧的协议层给，页面不自己猜）。
 * 三种状态分开渲染，且**绝不互相冒充**：
 * - 加载中 → Skeleton；
 * - 失败 → 结构化错误的人话（`libraryFailureText`：端点没配就说"未配置"，不显示空态）；
 * - 真的空 → 一句克制的空态（`libraryEmptyText`）。
 *
 * 端点目前全部未配置（docs/API_CONTRACT.md §2.1），所以"接口尚未配置（待联调确认）。"
 * 就是这些页面今天最常显示的那句话——这是如实，不是坏掉。
 *
 * R45A3（简报第 12 项"歌曲列表触底加载，不一次加载全部"）：列表分成两种，**不许混为一谈**——
 * - 歌单详情 / 搜索 / 专辑：接口真的认 `page`/`pageSize`，滚到离底 240px 取**下一页**；
 * - 歌手 / 历史：接口**本身不分页**，一次响应就是全部，UI 只本地分批揭示 50 条，
 *   而且明说"后端一次返回 N 首（1 次网络请求）"——分批显示**不减少任何字节**。
 * 判定（合并/去重/竞态/重试/上膛）全在 `features/library/pagination.mjs`，这里只接线。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { ListPlusIcon, ListMusicIcon, PlayIcon } from "lucide-react"

import {
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_HISTORY,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_PLAYLISTS,
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
import { CoverArt, EmptyState, GridSkeleton, ListSkeleton, LoadFailed, TrackTable } from "./components"
import { AmllBackground } from "./AmllBackground.tsx"
import { LOG_ENTRY_LIMIT, LogTerminal } from "./log-terminal.tsx"
import type { LogEntry } from "./log-terminal.tsx"
import { LyricsCacheCard } from "./lyrics-cache-card.tsx"
import { coreCall, getAutostart, isCoreError, setAutostart } from "./host-api"
import { PlaylistGrid } from "./playlist-grid.tsx"
import { libraryEmptyText, libraryFailureText } from "./features/library/library-state.mjs"
import {
  PLAYLIST_ENQUEUE_LABEL,
  PLAYLIST_PLAY_ALL_LABEL,
  playlistCoverUrlOf,
  playlistDetailMetaText,
  playlistDetailTitleOf,
  playlistPartialNoticeText,
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
  PLAYLIST_SLICE_NOTICE_TESTID,
  applyFailure,
  applyPage,
  beginPage,
  createLocalListState,
  createPaginationState,
  findScrollRoot,
  hasRevealableItems,
  isInitialPaging,
  localRevealNoticeText,
  markSentinelAway,
  nextPageOf,
  paginationNoticeText,
  playlistLocalSliceNoticeText,
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

/**
 * 页大小（收藏页有自己的常量）：与协议层默认的 50 同档。
 *
 * 曲目列表触底分页另用 `PAGINATION_PAGE_SIZE`（pagination.mjs 里的同一档数字，
 * 那里是唯一真源——页面与测试都按它算"一页几首"）。
 */
const LIST_PAGE_SIZE = PAGINATION_PAGE_SIZE

/** 视图对象（与 features/library/views.mjs 的 createView 产物同形）。 */
export interface View {
  id: string
  params: Record<string, string>
}

interface Resource<T> {
  status: "loading" | "ready" | "error"
  data: T | null
  failure: { message: string; kind?: string } | null
}

/**
 * 一次一页的资源取数。
 *
 * 两个刻意的细节：
 * - 载荷用 JSON 做依赖键：调用点写对象字面量是常事，而 effect 的依赖比较是引用比较，
 *   直接把对象放进依赖里就是每渲染一次取一次数；
 * - `select` 放进 ref 而不是依赖数组：它同样是每次渲染都新建的函数，
 *   放进依赖会得到和上面一样的死循环。取值函数不参与"该不该重新取"的判断。
 */
function useLibraryResource<T>(
  channel: RequestChannel,
  payload: unknown,
  select: (data: never) => T,
  enabled = true,
): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ status: "loading", data: null, failure: null })
  const selectRef = useRef(select)
  selectRef.current = select
  const key = JSON.stringify(payload)

  useEffect(() => {
    if (!enabled) {
      setState({ status: "ready", data: null, failure: null })
      return
    }
    let alive = true
    setState({ status: "loading", data: null, failure: null })
    void (async () => {
      try {
        const data = await coreCall(channel, JSON.parse(key))
        if (!alive) return
        setState({ status: "ready", data: selectRef.current(data as never), failure: null })
      } catch (failure) {
        if (!alive) return
        // 错误路径才写控制台；结构化错误的人话由 libraryFailureText 给（这里不编）
        console.warn(`库页面请求失败（${channel}）：`, failure)
        setState({
          status: "error",
          data: null,
          failure: isCoreError(failure) ? failure : { message: libraryFailureText(failure) },
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [channel, key, enabled])

  return state
}

// ---------------------------------------------------------------------------
// 触底分页（R45A3）：判定全在 pagination.mjs，这里只做 React 接线
// ---------------------------------------------------------------------------

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
    // 这一页是怎么来的（`server` / `local-slice` / `server-repeat`）与背后那份响应的条数：两者都由协议层说，
    // 渲染层既不猜"这是本地切片"，也不自己数总数（R45A3 fix1）
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
 * 服务端分页的列表取数（歌单详情 / 搜索 / 专辑）。
 *
 * 三件刻意的接线：
 * 1. **查询换代**：`holder.key` 与当前查询键不一致时**渲染期就给空状态**——切关键词的那一帧
 *    绝不能把上一个词的结果留在屏幕上（那是最容易"看起来对、其实在撒谎"的一处）；
 * 2. **正在请求不重复发**：`inFlightRef` 按"查询代次 + 页号"记在途请求，观察器/重试/首屏
 *    三条路同时触发也只发一次；
 * 3. **root 是应用内容区那个滚动容器**（`findScrollRoot` 从哨兵往上找 `overflow-y:auto`），
 *    页面自己不再造一层滚动容器——那是 `no-self-visual` 的例外集合写死的东西。
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
   * 哨兵：进入前 240px 取下一页。
   *
   * "不无限连拉"靠 `armed`（pagination.mjs）：一页取完先卸膛，**离开触发区**才重新上膛。
   * 观察器只在 `observe`/查询/`rescan` 变化时重建——重建会立刻回调一次当前相交状态，
   * 所以"取完一页还停在底部"不会被自己再触发一次。
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
   * 用户手势（滚轮 / 触摸）= "再次接近底部"，也是短列表唯一能继续取页的路。
   *
   * 为什么不只靠观察器：一页取完后哨兵如果**还**在视口里（列表比屏幕短），相交状态不再变化，
   * 观察器就再也不会回调——用户明明想往下看，却没有下一页。所以一次真实手势就重新上膛并
   * 请求观察器"再看一眼"，仍然一次手势只取一页（`rescan` 只在需要上膛时才动，滚动期间不重建）。
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
 * 本地分批（歌手 / 历史）：接口**不分页**，一次响应就是全部，这里只按批揭示。
 *
 * `revealMore` 不发任何请求（纯渲染策略）；换歌手/重进历史页时换成新的一份，
 * 重置发生在**渲染期**（effect 会晚一帧，那一帧会闪一次空态）。
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
 * 曲目列表的外壳：骨架 / 失败（带重试）/ 空 / 表格 + 状态行 + 哨兵。
 *
 * 服务端分页与本地分批**共用这一份渲染**（两者的区别只在喂进来的 `status` 文案与
 * `observe` 的真假）：两套渲染早晚会长出两种不一致的空态/失败态。
 */
function BrowsableTrackList({
  items,
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
  emptyText: string
  navigation: PageNavigationProps
  /** 状态行：已加载 N 首（服务端分页）/ 后端一次返回 N 首（本地分批） */
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
          // 队列要用**整张已加载列表**（只播一首会让"下一首"永远没有下一首）
          onActivate={(song, index) => navigation.onActivateTrack(song, index, items)}
          onOpenAlbum={navigation.onOpenAlbum}
          onOpenArtist={navigation.onOpenArtist}
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
}

// ---------------------------------------------------------------------------
// 歌单：网格 + 详情
// ---------------------------------------------------------------------------

export function PlaylistsPage({
  onOpenPlaylist,
}: {
  onOpenPlaylist: (playlistId: string, playlist: unknown) => void
}) {
  const view = createView(VIEW.playlists)
  const select = useCallback((data: { playlists?: unknown[] }) => data.playlists ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_PLAYLISTS,
    { page: 1, pageSize: LIST_PAGE_SIZE },
    select,
  )

  if (resource.status === "loading") return <GridSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />
  return <PlaylistGrid playlists={resource.data ?? []} emptyText={libraryEmptyText(view)} onOpen={onOpenPlaylist} />
}

/**
 * 歌单详情页（R40 **删除重写**；R45A3 改成真分页）。
 *
 * 旧版只有一个曲目表：没有歌单名、没有封面、没有"播放全部"——点进一张歌单像是掉进了一份
 * 无名列表。现在三块：
 *
 * 1. **头部**：大封面 + 歌单名 + 元信息（共几首 / 已加载几首）+ 动作按钮。头部底景用 AMLL
 *    官方的 `BackgroundRender`（`AmllBackground`）：封面地址交给它之前先由宿主用 `new Image()`
 *    加载成 `HTMLImageElement`——**不是 fetch**（CSP 的 `connect-src` 只有 self/ipc，
 *    字符串地址会被 AMLL 拿去 fetch 而撞墙；图片走的是 `img-src`）；
 * 2. **动作**：`播放全部` = 用**已加载**的曲目整队替换并从第一首开始（`playQueue`）；
 *    `加入队列` = 追加到队尾、不动正在播的那一首（`enqueue`）。两个都**只作用于已加载的曲目**，
 *    分页没走完时页面上有一句说明（不把"前 50 首"说成"整张歌单"）；
 * 3. **正文**：曲目表（沿用 `TrackTable`：双击播放、键盘可达、艺人/专辑跳转），
 *    R45A3 起滚到离底 240px 就取下一页（`LIBRARY_PLAYLIST_DETAIL` 的 `page`/`pageSize`）。
 *
 * 数据来源仍是**一次一页**的歌单详情频道（载荷 `{playlistId, page, pageSize}`）：
 * `data.playlist` 是协议层归一化过的歌单元信息（名字/封面/曲目数都从它读，不在渲染层再解析
 * 一份原始响应）；分页纯逻辑只认**第一页**带回的那份（后续页不覆盖这张歌单的身份）。
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
  /** 播放全部：把**已加载**的曲目整队替换并播放第一首 */
  onPlayAll?: (songs: unknown[]) => void
  /** 加入队列：追加到队尾（不动正在播的那一首），同样只作用于已加载的曲目 */
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
  const actionsDisabled = songs.length === 0
  /**
   * 这一页是怎么来的——**只从分页状态读**（它记的是协议层说的 `pageSource`），页面不自己猜
   * "这就是本地切片"。歌单详情那个端点实测一次回整张歌单，所以第 2 页起是本地切片：
   * 那句话必须说出来（含"不再发网络请求"与"不减少流量"两条），见 `playlistLocalSliceNoticeText`。
   */
  const sliceNotice = playlistLocalSliceNoticeText({
    source: state.pageSource,
    available: state.available,
    loaded: songs.length,
  })

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
              <Button disabled={actionsDisabled || onPlayAll === undefined} onClick={() => onPlayAll?.(songs)}>
                <PlayIcon />
                {PLAYLIST_PLAY_ALL_LABEL}
              </Button>
              <Button
                variant="secondary"
                disabled={actionsDisabled || onEnqueue === undefined}
                onClick={() => onEnqueue?.(songs)}
              >
                <ListPlusIcon />
                {PLAYLIST_ENQUEUE_LABEL}
              </Button>
            </div>
            {hasMore ? (
              <p className="text-xs text-muted-foreground">{playlistPartialNoticeText(songs.length)}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* 服务端一次回整张歌单时的如实说明（本地切片 ≠ 网络分页，也 ≠ 省流量） */}
      {sliceNotice === null ? null : (
        <p className="mx-4 mb-2 text-xs text-muted-foreground" data-testid={PLAYLIST_SLICE_NOTICE_TESTID}>
          {sliceNotice}
        </p>
      )}

      <BrowsableTrackList
        items={songs}
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
// 搜索：结果（输入框在侧栏顶部，R40 从页内搬走）
// ---------------------------------------------------------------------------

/**
 * 搜索结果页（R40 删掉页内输入框，只剩结果；R45A3 加触底分页）。
 *
 * 检索词**由外壳经视图参数交下来**（`VIEW.search` 的 `keyword`）：入口在侧栏的常驻搜索框，
 * 结果在内容区，两处必须是同一条数据——页面自己存一份就会出现"侧栏显示 A、内容区显示 B"。
 * 所以这里既不渲染输入框，也不持有 keyword 状态：没提交过（没有 keyword）就显示
 * "输入关键字开始搜索。"，提交过就按同一档规则显示结果或「查无所获」。
 *
 * 换关键词 = 换查询：`usePaginatedTracks` 的查询键变了就换代清空并丢掉旧响应
 * （上一个词的迟到结果绝不许落到新结果里）。
 *
 * 页面本身不自带滚动容器：结果直接落在内容区那一个滚动根里（哨兵也观察那一层）。
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
 * 歌手页：**后端不分页**（协议层 `artist` 只认 `songNum`/`albumNum`，没有 start/limit）。
 *
 * 所以这里只发**一次**请求，拿到的那一份就是全部；UI 每批揭示 50 条，哨兵每批再加 50。
 * 状态行必须明说"后端一次返回 N 首（1 次网络请求）"——分批显示**不减少任何字节**，
 * 说成"减少流量/节省请求"就是撒谎（简报点名的边界）。
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
      emptyText={libraryEmptyText(view)}
      navigation={navigation}
      status={localRevealNoticeText(reveal.state)}
      sentinelRef={reveal.sentinelRef}
      observe={hasRevealableItems(reveal.state)}
    />
  )
}

/**
 * 播放历史：与歌手页同一类——接口只给"一条查询的一次响应"（协议层固定 `hasMore:false`），
 * 所以同样只请求一次、本地分批揭示。
 *
 * 历史里的**重复条目是有意义的**（同一首歌今天听了两次），所以这一层不做任何去重；
 * 有的列表按 id 去重会把它抹成一条，那是在改历史。
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
      emptyText={libraryEmptyText(view)}
      navigation={navigation}
      status={localRevealNoticeText(reveal.state)}
      sentinelRef={reveal.sentinelRef}
      observe={hasRevealableItems(reveal.state)}
    />
  )
}

// ---------------------------------------------------------------------------
// 设置（R10）
// ---------------------------------------------------------------------------

/**
 * `settings:get` / `settings:set` 回执的形状（与 `src/main/settings.mjs` 同源）。
 *
 * 页面**只把整份文档交给 `proxyFormFromSettings`**，自己不去读 `data.proxy` 里的任何字段：
 * 凭据不回显这件事靠投影函数结构性保证，而不是靠这里"小心一点"。
 */
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
  /**
   * 托盘是否真的可用（R11）：由外壳启动时查一次 `core_get_tray_available` 交下来。
   *
   * 默认值取那个保守常量（`TRAY_AVAILABLE = false`）：外壳还没查到时界面上说的是
   * "托盘当前不可用"——这是**如实**（那一刻确实还没有答案，而 Rust 侧的 fail-safe
   * 此刻也按"不可用"处理），比先画一个"能用"的饼再改口要好。
   */
  trayAvailable?: boolean
  /**
   * 桌面歌词窗的绑定（R12）：由外壳的 `useLyricsWindow` 交下来。
   *
   * 页面不自己问宿主：Rust 为运行配置权威，单例桥代理恢复/保存；页面只渲染并提交意图。
   * 缺省 `null` = 外壳还没挂上（设置页不该因为少一个 prop 就崩）。
   */
  lyrics?: LyricsWindowBinding | null
  /**
   * 运行日志（R39）：由外壳的 `useNoticeLog()` 交下来。
   *
   * 订阅留在外壳是**必须的**，不是风格问题：`app:notice` 是广播，没人订阅那一刻的提示就丢了，
   * 而设置页只在切到设置时才挂载——在这里订阅等于"打开设置页之前的日志全丢"。
   * 缺省 `[]` = 外壳还没交下来（这时如实显示"暂无日志。"，不编内容）。
   */
  notices?: LogEntry[]
}

/**
 * 设置页的二级分类（R41b）：**单页 Tabs 切换，不新开视图、不加路由**。
 *
 * 分法只有一条依据——**"用户要决定的到底是哪一件事"**：
 * - `通用`：日常使用里会被改的四件（关窗行为 / 开机自启 / 外观 / 播放队列只读摘要）；
 * - `网络`：代理（连不上网时才来看的那一类，与上面四件没有共同前提）；
 * - `歌词`：桌面歌词窗与歌词缓存/导入（同一件事的两半：在哪显示 / 从哪来）；
 * - `日志`：运行日志。
 *
 * **为什么日志单独成一类**（简报让我定并写理由）：它根本不是"设置"——没有可选项，
 * 是一块只读的诊断面板，而且很高（等宽正文 + 自己的滚动区 + 筛选框）。
 * 挂在「通用」尾部的话，用户想找"开机自启"要先划过一整块日志终端；
 * 反过来找日志的人也要先划过四张卡。给它一类，两类人都少滚一次。
 *
 * 这张表是 **trigger 与 content 的唯一真源**：两边各写一个字面量就会出现
 * "点了标签、内容区是空的"（radix 只认 `value` 相等，认不出就等于没配）。
 */
export const SETTINGS_TABS = [
  { id: "general", label: "通用" },
  { id: "network", label: "网络" },
  { id: "lyrics", label: "歌词" },
  { id: "log", label: "日志" },
]

/**
 * 设置页：二级分类下的代理表单、关窗行为、开机自启、外观、队列（只读）、桌面歌词、歌词缓存与日志。
 *
 * 三条纪律（沿 R8/R9 的做法）：
 * - 所有文案与判定都在 `features/settings/settings-form.mjs`（纯函数，跑得了测试）；
 *   页面只做"把状态塞进去、把返回值渲染出来"。
 * - 凭据只写不读：密码字段永远是 `type="password"`、永远从空开始，回执里有密码但**不进表单**。
 * - 不冒充：没测过不给测试结论、读不到自启状态就说"未取到"、保存回执按 `restartRequired`
 *   如实说"要重启"，主机没通过清洗就说"仍是直连"。
 *
 * R41b：卡片按 `SETTINGS_TABS` 分到四个标签页里（**卡片内部一个字都没改**，只是搬了位置）。
 * 失败/提示那两行留在标签页**之上**（页面级）：它们说的是"刚才那次保存的结果"，
 * 跟着某一张卡藏到标签页里，用户切过去才看得见——那时他已经不知道这句话在说哪次操作了。
 */
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
  /**
   * 主题档位（R41b 的「外观」卡）：与左下角那枚循环图标按钮、登录页那个控件**同一份接线**
   * ——读回档位、订阅 `theme:changed`、写回档位都在 `useThemeChoice` 里，
   * 页面自己不监听也不自己写（各写一份就会出现"两处显示不同档位"）。
   */
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
      } catch (error) {
        if (alive) setAutostartFailure(autostartStatusFailureText(error))
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

      {/* R41b 二级分类：单页 Tabs，不新开视图（分法与「日志为什么单独一类」见 SETTINGS_TABS） */}
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
                {/* 可用性来自宿主（R11）：`trayAvailable` 由外壳启动时查一次交下来 */}
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
              <p className="text-xs text-muted-foreground">
                {autostartReady ? autostartStateText(autostartEnabled) : "正在读取当前状态…"}
              </p>
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
                {/*
                  R41b：三态落在这里（与左下角那枚循环图标按钮、登录页的控件**同源同向**——
                  读回档位、订阅 theme:changed、写回档位全在 useThemeChoice 那一份接线里，
                  写入口是 Rust 侧唯一的 core_login_chrome 的 theme 动作）。
                */}
                <Select value={themeChoice} onValueChange={selectTheme}>
                  <SelectTrigger id="theme-choice" aria-label="主题" className="w-full max-w-xs">
                    {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案（R10 的同一个坑） */}
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
          {/*
            R52：这一页只放**必须在主窗操作**的行为项——显示 / 窗口位置 / 锁定 / 鼠标穿透。
            外观（样式 / 方向 / 字号 / 效果 / 颜色）只在桌面歌词窗自己的齿轮菜单里改：同一项设置
            有两个入口，用户会以为两边都该改得对，而其中一处迟早会落后。主窗设置不代管那扇窗的外观，
            任务栏歌词的设置后续在设置页单独给（不与桌面歌词共用）。
            沉浸式歌词（播放器歌词）的颜色**不可改**：`AmllLyricsPanel` 恒用 AMLL 默认 + 主题令牌。
          */}
          <Card>
            <CardHeader>
              <CardTitle>桌面歌词</CardTitle>
              <CardDescription>桌面上的独立歌词窗：在哪显示、怎么拖。</CardDescription>
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
                    {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案（R10 的同一个坑） */}
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

              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Switch
                    id="lyrics-locked"
                    checked={lyrics?.config.locked === true}
                    disabled={lyrics === null}
                    onCheckedChange={(checked) => lyrics?.updateConfig({ locked: checked })}
                  />
                  <Label htmlFor="lyrics-locked">锁定位置</Label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    id="lyrics-click-through"
                    checked={lyrics?.config.clickThrough === true}
                    disabled={lyrics === null}
                    onCheckedChange={(checked) => lyrics?.updateConfig({ clickThrough: checked })}
                  />
                  <Label htmlFor="lyrics-click-through">鼠标穿透</Label>
                  {/* 点透之后鼠标事件不再落到那扇窗上：这里是唯一的关闭处（一句话，不讲原理） */}
                  <span className="text-xs text-muted-foreground">开启后需在这里关闭</span>
                </div>
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

          {/* 歌词缓存 / 一键清除 / 导入本地歌词（R41）：与上面那张卡同一件事的两半（显示 vs 存放） */}
          <LyricsCacheCard lyrics={lyrics} />
        </TabsContent>

        {/* 日志：只读的诊断面板（不是设置项——理由见 SETTINGS_TABS 的注释）；终端始终整宽 */}
        <TabsContent value="log" className="grid grid-cols-1 items-start gap-4">
          {/*
            运行日志（R39 从侧栏那个 Sheet 搬到这里）。
            展示与筛选全在 `LogTerminal` 里（编辑器样式：行号 gutter + 等宽正文 + ScrollArea，
            上面一个文本筛选框与「N / 总数 条」计数）；这里只给卡片外壳与那句说明。
            `app:notice` 的载荷只有 text，**没有级别**——所以筛选只按文本，不发明级别列。
          */}
          <Card>
            <CardHeader>
              <CardTitle>运行日志</CardTitle>
              <CardDescription>{`来自应用内核的提示（最多保留最新 ${LOG_ENTRY_LIMIT} 条）。`}</CardDescription>
            </CardHeader>
            <CardContent>
              <LogTerminal entries={notices} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
