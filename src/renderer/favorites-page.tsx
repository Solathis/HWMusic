/**
 * 收藏页（R8）：本任务唯一"有状态"的页面，三条约定都在这里落地。
 *
 * 1. **常驻挂载、切页不卸载**：滚动加载了几十页、滚到第几百首，切去歌单再切回来，
 *    不该从头再来一遍。所以它是 App 里唯一一个挂在 `renderPage()` 之外的页面，
 *    用 `hidden` 控制显隐（`hidden` + 工具类的坑见下面注释）。
 * 2. **滚动到哨兵就加载下一页**（IntersectionObserver，root 是本页的滚动容器）：
 *    一次一页地走 `library:favorites`；分页结论由协议层给，合并/去重/计数全在
 *    features/library/favorites-pagination.mjs（纯逻辑，UI 只消费）。
 * 3. **总数与已加载数分开显示**：收藏没有可信总数，走完分页才有"共 M 首"。
 *    没走完、或者失败，都只能说"已加载 N 首"——这不是文案问题，是不许把一页说成全部。
 *
 * 失败不清空已加载内容，且**不自动重试**（离线时那是请求风暴）：失败态给一个"重试"按钮。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { EmptyState, ListSkeleton, TrackTable } from "./components"
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

export interface FavoritesPageProps {
  /** 当前是否显示中（常驻挂载靠它控制显隐，而不是卸载） */
  active: boolean
  onActivateTrack: (song: unknown) => void
  onOpenAlbum: (albumId: string, song: unknown) => void
  onOpenArtist: (artistId: string, song: unknown) => void
}

export function FavoritesPage({ active, onActivateTrack, onOpenAlbum, onOpenArtist }: FavoritesPageProps) {
  const [state, setState] = useState<FavoritesState>(createFavoritesState)
  const stateRef = useRef(state)
  const loadingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  stateRef.current = state

  /**
   * 取下一页。
   *
   * 显式把"当前状态"作为入参而不是从 ref 里读：重试按钮是先清失败态、再立刻发起，
   * 两步之间 React 还没重渲染，从 ref 读到的仍是"失败中"的旧状态（守卫会把重试吞掉）。
   */
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

  /**
   * 位置恢复：切回来时把 scrollTop 写回去。
   *
   * 两个刻意的选择：
   * - **只在变可见时写**，切走时**不读** scrollTop：`hidden`（display:none）会让浏览器把
   *   滚动位置丢掉，等 effect 跑到时读到的可能已经是 0——那会把记忆里的好值覆盖成 0，
   *   下次切回来就真的回到顶部了。真正的记录来自 `onScroll`（滚动时一直在写）。
   * - 用 `useLayoutEffect`：在浏览器绘制前写回，用户看不到"先顶部、再跳回去"的闪动。
   */
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
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm text-muted-foreground" data-testid="favorites-counts">
            {initial ? FAVORITES_LOADING_TEXT : describeFavoritesCounts(summary)}
          </p>
          {summary.failure === null ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const cleared = clearFavoritesFailure(stateRef.current)
                setState(cleared)
                void requestNextPage(cleared)
              }}
            >
              重试
            </Button>
          )}
        </div>

        {summary.failure === null ? null : (
          <Alert variant="destructive" className="mx-4 mb-3" data-testid="favorites-failure">
            <AlertDescription>{summary.failure}</AlertDescription>
          </Alert>
        )}

        <div
          ref={scrollRef}
          onScroll={(event) => rememberScroll(event.currentTarget.scrollTop)}
          className="min-h-0 flex-1 overflow-y-auto"
          data-scroll-root={FAVORITES_SCROLL_KEY}
          data-testid={FAVORITES_SCROLL_TESTID}
        >
          {state.songs.length === 0 ? (
            // 四种"还没有歌"要分开：首屏加载（骨架）、翻页加载（骨架）、失败（上面那条 Alert
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
              onActivate={onActivateTrack}
              onOpenAlbum={onOpenAlbum}
              onOpenArtist={onOpenArtist}
            />
          )}
          {summary.loading && state.songs.length > 0 ? <ListSkeleton /> : null}
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
