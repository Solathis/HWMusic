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
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { SearchIcon } from "lucide-react"

import {
  LIBRARY_ALBUM,
  LIBRARY_ARTIST,
  LIBRARY_HISTORY,
  LIBRARY_PLAYLIST_DETAIL,
  LIBRARY_PLAYLISTS,
  LIBRARY_SEARCH,
  type RequestChannel,
} from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import { EmptyState, GridSkeleton, ListSkeleton, LoadFailed, TrackTable } from "./components"
import { coreCall, isCoreError } from "./host-api"
import { PlaylistGrid } from "./playlist-grid.tsx"
import { libraryEmptyText, libraryFailureText } from "./features/library/library-state.mjs"
import { VIEW, createView, viewParam } from "./features/library/views.mjs"

/** 页大小：收藏页有自己的常量（滚动加载），这里是一页式列表的取数大小。 */
const LIST_PAGE_SIZE = 50

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

/** 曲目列表页的公共外壳：加载 / 失败 / 空 / 表格四种渲染只写一次。 */
function TrackListView({
  emptyText,
  resource,
  onActivateTrack,
  onOpenAlbum,
  onOpenArtist,
}: {
  /** 空态文案由各页给：搜索的"查无所获"与"还没搜"不是同一句话 */
  emptyText: string
  resource: Resource<unknown[]>
  onActivateTrack: (song: unknown) => void
  onOpenAlbum: (albumId: string, song: unknown) => void
  onOpenArtist: (artistId: string, song: unknown) => void
}) {
  if (resource.status === "loading") return <ListSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />
  return (
    <TrackTable
      songs={resource.data ?? []}
      emptyText={emptyText}
      onActivate={onActivateTrack}
      onOpenAlbum={onOpenAlbum}
      onOpenArtist={onOpenArtist}
    />
  )
}

export interface PageNavigationProps {
  onActivateTrack: (song: unknown) => void
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

export function PlaylistDetailPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_PLAYLIST_DETAIL,
    { playlistId: viewParam(view, "playlistId"), page: 1, pageSize: LIST_PAGE_SIZE },
    select,
    viewParam(view, "playlistId") !== null,
  )
  return <TrackListView emptyText={libraryEmptyText(view)} resource={resource} {...navigation} />
}

// ---------------------------------------------------------------------------
// 搜索：输入 + 提交（回车也能搜）
// ---------------------------------------------------------------------------

export function SearchPage({ ...navigation }: PageNavigationProps) {
  const view = createView(VIEW.search)
  const [keyword, setKeyword] = useState("")
  const [submitted, setSubmitted] = useState<string | null>(null)
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])

  // 没提交过就不发请求：空关键字在 core 侧是 invalid_payload（那不是用户想看到的"错误"）
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_SEARCH,
    { keyword: submitted ?? "", page: 1, pageSize: LIST_PAGE_SIZE },
    select,
    submitted !== null,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-2 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = keyword.trim()
          setSubmitted(trimmed === "" ? null : trimmed)
        }}
      >
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索歌曲、歌手或专辑"
          aria-label="搜索关键字"
        />
        <Button type="submit" variant="secondary">
          <SearchIcon />
          搜索
        </Button>
      </form>
      {submitted === null ? (
        <EmptyState text={libraryEmptyText(view)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TrackListView
            emptyText={libraryEmptyText(view, { searched: true })}
            resource={resource}
            {...navigation}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 专辑 / 歌手 / 播放历史
// ---------------------------------------------------------------------------

export function AlbumPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_ALBUM,
    { albumId: viewParam(view, "albumId") },
    select,
    viewParam(view, "albumId") !== null,
  )
  return <TrackListView emptyText={libraryEmptyText(view)} resource={resource} {...navigation} />
}

export function ArtistPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_ARTIST,
    { artistId: viewParam(view, "artistId") },
    select,
    viewParam(view, "artistId") !== null,
  )
  return <TrackListView emptyText={libraryEmptyText(view)} resource={resource} {...navigation} />
}

export function HistoryPage({ ...navigation }: PageNavigationProps) {
  const view = createView(VIEW.history)
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_HISTORY,
    { page: 1, pageSize: LIST_PAGE_SIZE },
    select,
  )
  return <TrackListView emptyText={libraryEmptyText(view)} resource={resource} {...navigation} />
}

// ---------------------------------------------------------------------------
// 设置（R10 接入；本任务只给一个如实的占位）
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const view = createView(VIEW.settings)
  return (
    <Card className="m-4 max-w-xl" data-testid="settings-placeholder">
      <CardHeader>
        <CardTitle>设置</CardTitle>
        <CardDescription>{libraryEmptyText(view)}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        代理、关窗行为与开机自启会在这里配置（数据已经在 sidecar 侧可用）。
      </CardContent>
    </Card>
  )
}
