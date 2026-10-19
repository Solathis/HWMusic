/**
 * 主窗外壳（R7 搭骨架，R8 接主界面）。
 *
 * **顺序是契约**：门禁判定在最前，未登录（含"还不知道"）绝不渲染 app-shell——
 * `test/login-gate.test.mjs` 扫源码钉住这个顺序（顺序反了就是把没登录的用户放进主界面，
 * 然后每个请求都失败，用户只会看到一堆报错）。
 *
 * 主界面本身（`LibraryShell`）**必须晚于门禁挂载**：它一挂载就开始取库数据，
 * 未登录时那些请求只会全部失败。门禁通过才渲染，是从结构上保证这件事，而不是靠判断。
 *
 * 页面切换没有路由库：视图就是一个 `useState` + `renderPage()` 的 switch
 * （页面只有八个，路由库在这里只有依赖和"浏览器历史语义不适用"的麻烦）。
 * 唯一的例外是收藏页：它常驻挂载（切页不卸载），所以挂在 switch 之外、用 active 控制显隐。
 */
import { useCallback, useState } from "react"
import { HistoryIcon, HeartIcon, ListMusicIcon, SearchIcon, SettingsIcon, ScrollTextIcon } from "lucide-react"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { LoginGate, useAuthGate } from "./login-gate"
import { Button } from "./components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar"
import { EmptyState, PlayerBar, QueuePanel } from "./components"
import { FavoritesPage } from "./favorites-page.tsx"
import { LogTerminal, useNoticeLog } from "./log-terminal.tsx"
import {
  AlbumPage,
  ArtistPage,
  HistoryPage,
  PlaylistDetailPage,
  PlaylistsPage,
  SearchPage,
  SettingsPage,
} from "./pages.tsx"
import { shouldShowLoginGate } from "./features/auth/login-gate-logic.mjs"
import {
  NAV_LIST_TESTID,
  SIDEBAR_VIEWS,
  VIEW,
  createView,
  isResidentView,
  normalizeView,
  viewTitle,
} from "./features/library/views.mjs"
import { libraryEmptyText } from "./features/library/library-state.mjs"
import { playlistNameOf } from "./features/library/playlist-fields.mjs"
import { trackAlbumOf, trackArtistsOf, trackNameOf } from "./features/library/track-fields.mjs"

export function App() {
  const gate = useAuthGate()

  if (shouldShowLoginGate(gate.state)) {
    return <LoginGate gate={gate} />
  }

  // app-shell：登录之后才存在的那一块（R7 的测试锚点，R8 保留）
  return (
    <div className="h-full w-full" data-shell="app-shell">
      <LibraryShell />
    </div>
  )
}

/**
 * 侧边栏图标的唯一映射表。
 *
 * 这里**只有图标**：导航条目、标签、顺序全部来自 views.mjs 的 SIDEBAR_VIEWS——
 * 再抄一份条目列表，就会出现"导航里有个页面上没有的入口"这种漂移。
 */
const NAV_ICONS = {
  [VIEW.favorites]: HeartIcon,
  [VIEW.playlists]: ListMusicIcon,
  [VIEW.history]: HistoryIcon,
  [VIEW.search]: SearchIcon,
  [VIEW.settings]: SettingsIcon,
}

export function LibraryShell() {
  const [view, setView] = useState(() => createView(VIEW.favorites))
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null)
  const notices = useNoticeLog()

  const navigate = useCallback((next: unknown) => {
    setView(normalizeView(next))
  }, [])

  const onActivateTrack = useCallback((song: unknown) => {
    // 播放是 R9 的事：这里只记下"选了哪首"（点击不该假装开始播放）
    setSelectedTrack(trackNameOf(song))
  }, [])

  const onOpenAlbum = useCallback(
    (albumId: string, song: unknown) => {
      navigate(createView(VIEW.album, { albumId, name: trackAlbumOf(song) }))
    },
    [navigate],
  )

  const onOpenArtist = useCallback(
    (artistId: string, song: unknown) => {
      navigate(createView(VIEW.artist, { artistId, name: trackArtistsOf(song) }))
    },
    [navigate],
  )

  const onOpenPlaylist = useCallback(
    (playlistId: string, playlist: unknown) => {
      // 名字只用于标题，仍走展示投影这一处（不在这里读 playlist.name，那是第二份字段兜底）
      navigate(createView(VIEW.playlistDetail, { playlistId, name: playlistNameOf(playlist) }))
    },
    [navigate],
  )

  const navigation = { onActivateTrack, onOpenAlbum, onOpenArtist }

  /** 页面切换：一个 switch，没有路由库。收藏页常驻，所以这里没有它的分支。 */
  function renderPage() {
    switch (view.id) {
      case VIEW.playlists:
        return <PlaylistsPage onOpenPlaylist={onOpenPlaylist} />
      case VIEW.playlistDetail:
        return <PlaylistDetailPage view={view} {...navigation} />
      case VIEW.search:
        return <SearchPage {...navigation} />
      case VIEW.album:
        return <AlbumPage view={view} {...navigation} />
      case VIEW.artist:
        return <ArtistPage view={view} {...navigation} />
      case VIEW.history:
        return <HistoryPage {...navigation} />
      case VIEW.settings:
        return <SettingsPage />
      default:
        // 认不出的视图（正常不会发生）：给一句空态，绝不白屏
        return <EmptyState text={libraryEmptyText(view)} />
    }
  }

  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar>
        <SidebarHeader className="px-3 py-2">
          <span className="truncate text-sm font-medium">{APP_BRAND_LABEL}</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>音乐库</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu data-testid={NAV_LIST_TESTID}>
                {SIDEBAR_VIEWS.map((entry) => {
                  const Icon = NAV_ICONS[entry.id] ?? ListMusicIcon
                  return (
                    <SidebarMenuItem key={entry.id}>
                      <SidebarMenuButton isActive={view.id === entry.id} onClick={() => navigate(createView(entry.id))}>
                        <Icon />
                        <span>{entry.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          {/* 运行日志：core 经 app:notice 上来的真实提示（代理生效、启动提示……） */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start">
                <ScrollTextIcon />
                <span>运行日志</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[60vh]">
              <SheetHeader>
                <SheetTitle>运行日志</SheetTitle>
                <SheetDescription>来自应用内核的提示（最多保留最新 100 条）。</SheetDescription>
              </SheetHeader>
              <LogTerminal entries={notices} />
            </SheetContent>
          </Sheet>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="flex h-full min-h-0 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <h1 className="truncate text-sm font-medium">{viewTitle(view)}</h1>
          <div className="ml-auto flex items-center gap-1">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="播放队列">
                  <ListMusicIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>播放队列</SheetTitle>
                  <SheetDescription>播放器接入后这里显示队列。</SheetDescription>
                </SheetHeader>
                <QueuePanel selectedTrackName={selectedTrack} />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {/* 收藏页常驻（切走只是 hidden），其余页面按视图重挂 */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {isResidentView(view) ? null : <div className="h-full min-h-0 overflow-y-auto">{renderPage()}</div>}
          <FavoritesPage
            active={isResidentView(view)}
            onActivateTrack={onActivateTrack}
            onOpenAlbum={onOpenAlbum}
            onOpenArtist={onOpenArtist}
          />
        </div>

        <PlayerBar />
      </SidebarInset>
    </SidebarProvider>
  )
}
