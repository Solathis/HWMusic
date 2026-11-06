/**
 * 收藏页：唯一常驻挂载的页面，切页不卸载（只切 `hidden`），滚动加载的进度不丢。
 * 滚动到哨兵就加载下一页；总数与已加载数分开显示——没走完分页只能说"已加载 N 首"。
 * 失败不清空已加载内容、不自动重试（离线时那是请求风暴），只给一个重试按钮。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "./components/ui/button"
import { EmptyState, ListSkeleton, LoadFailed, TrackListToolbar, TrackTable } from "./components"
import type { TrackRowActions } from "./track-menu.tsx"
import { coreCall } from "./host-api"
import { LIBRARY_FAVORITES } from "../shared/request-channels.ts"
import { libraryEmptyText, libraryFailureText } from "./features/library/library-state.mjs"
import { VIEW, createView } from "./features/library/views.mjs"
import {
  FAVORITES_LOADING_TEXT,
  FAVORITES_PAGE_SIZE,
  FAVORITES_PAGE_TESTID,
  FAVORITES_SCROLL_KEY,
  FAVORITES_SCROLL_TESTID,
  FAVORITES_SENTINEL_TESTID,
  clearFavoritesFailure,
  createFavoritesState,
  createScrollMemory,
  describeFavoritesCounts,
  favoritesSummary,
  isFavoritesInitialLoad,
  markFavoritesFailure,
  markFavoritesLoading,
  mergeFavoritesPage,
  nextFavoritesPage,
  shouldLoadNextFavoritesPage,
} from "./features/library/favorites-pagination.mjs"

/** 滚动位置的记忆是**模块级**的：这个页面常驻，全应用只有这一个滚动容器。 */
const scrollMemory = createScrollMemory()

type FavoritesState = ReturnType<typeof createFavoritesState>

export interface FavoritesPageProps extends TrackRowActions {
  /** 当前是否显示中（常驻挂载靠它控制显隐，而不是卸载） */
  active: boolean
  /** 双击曲目：`songs` 是已加载的完整列表（播放器用它当队列） */
  onActivateTrack: (song: unknown, index: number, songs: unknown[]) => void
  onOpenAlbum: (albumId: string, song: unknown) => void
  onOpenArtist: (artistId: string, song: unknown) => void
  /** 已知下架的曲目 id（外壳从播放状态交下来）：这些行变灰、不许激活 */
  offlineIds?: string[]
}

function FavoritesPageView({
  active,
  onActivateTrack,
  onOpenAlbum,
  onOpenArtist,
  onPlayNext,
  onEnqueue,
  offlineIds = [],
}: FavoritesPageProps) {
  const [state, setState] = useState<FavoritesState>(createFavoritesState)
  const stateRef = useRef(state)
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  stateRef.current = state

  /** 取下一页：显式把当前状态作为入参而不是从 ref 读——重试时 React 还没重渲染，从 ref 会读到旧的失败态。 */
  const requestNextPage = useCallback(async (current: FavoritesState) => {
    if (loadingRef.current) return
    if (!shouldLoadNextFavoritesPage(current)) return
    loadingRef.current = true
    setState((previous) => markFavoritesLoading(previous, true))
    try {
      const page = await coreCall<{ songs: unknown[]; hasMore: boolean; skipped: number; reportedTotal: number | null }>(
        LIBRARY_FAVORITES,
        { page: nextFavoritesPage(current), pageSize: FAVORITES_PAGE_SIZE },
      )
      setState((previous) => mergeFavoritesPage(markFavoritesLoading(previous, false), page))
    } catch (failure) {
      // 错误路径才写控制台（其余一律不留调试输出）
      console.warn("收藏分页请求失败：", failure)
      setState((previous) => markFavoritesFailure(previous, libraryFailureText(failure)))
    } finally {
      loadingRef.current = false
    }
  }, [])

  // 首次挂载取第一页（失败之后不再自动重试：见文件头）
  useEffect(() => {
    void requestNextPage(stateRef.current)
  }, [requestNextPage])

  // 滚动到哨兵就取下一页；root 是本页的滚动容器（切走时它被 hidden，观察器自然不会误触发）
  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (root === null || sentinel === null) return
    const observer = new IntersectionObserver(
      (observed) => {
        if (!observed.some((entry) => entry.isIntersecting)) return
        void requestNextPage(stateRef.current)
      },
      { root, rootMargin: "240px" },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [requestNextPage])

  /** 位置恢复：只在变可见时把 scrollTop 写回去（`hidden` 会丢滚动位置，切走时不读），用 `useLayoutEffect` 避免闪动。 */
  useLayoutEffect(() => {
    if (!active) return
    const element = scrollRef.current
    if (element === null) return
    element.scrollTop = scrollMemory.offsetFor(FAVORITES_SCROLL_KEY)
  }, [active])

  const rememberScroll = useCallback((offset: number) => {
    scrollMemory.remember(FAVORITES_SCROLL_KEY, offset)
  }, [])

  const summary = favoritesSummary(state)
  const initial = isFavoritesInitialLoad(state)
  const view = createView(VIEW.favorites)

  return (
    // 外层只管显隐：`hidden` 属性是 UA 的 display:none，一旦同一个元素上再写 `flex`，
    // 作者样式的 display:flex 会盖过它 —— 元素就"隐藏不掉"了。所以显隐层与布局层分开。
    <div className="h-full min-h-0" data-resident="favorites" hidden={!active}>
      <div className="flex h-full min-h-0 flex-col" data-testid={FAVORITES_PAGE_TESTID}>
        <TrackListToolbar
          status={initial ? FAVORITES_LOADING_TEXT : describeFavoritesCounts(summary)}
          statusTestId="favorites-counts"
        />
        {summary.failure === null ? null : (
          <LoadFailed
            text={summary.failure}
            testId="favorites-failure"
            onRetry={() => {
              const cleared = clearFavoritesFailure(stateRef.current)
              setState(cleared)
              void requestNextPage(cleared)
            }}
          />
        )}

        <div
          ref={scrollRef}
          onScroll={(event) => rememberScroll(event.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-y-auto"
          data-scroll-root={FAVORITES_SCROLL_KEY}
          data-testid={FAVORITES_SCROLL_TESTID}
        >
          {state.songs.length === 0 ? (
            // 四种"还没有歌"要分开：首屏加载（骨架）、翻页加载（骨架）、失败（上面那条失败态
            // 已经说了原因）、真的空（空态文案）。把前三种显示成"还没有收藏歌曲"都是假空态。
            initial || summary.loading ? (
              <ListSkeleton />
            ) : summary.failure === null ? (
              <EmptyState text={libraryEmptyText(view)} />
            ) : null
          ) : (
            <TrackTable
              songs={state.songs}
              emptyText={libraryEmptyText(view)}
              onActivate={(song, index) => onActivateTrack(song, index, state.songs)}
              onOpenAlbum={onOpenAlbum}
              onOpenArtist={onOpenArtist}
              onPlayNext={onPlayNext}
              onEnqueue={onEnqueue}
              offlineIds={offlineIds}
            />
          )}
          {summary.loading && state.songs.length > 0 ? <ListSkeleton count={2} /> : null}
          {summary.isComplete ? null : (
            <div
              ref={sentinelRef}
              className="h-px w-full"
              aria-hidden="true"
              data-testid={FAVORITES_SENTINEL_TESTID}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export const FavoritesPage = memo(FavoritesPageView)
