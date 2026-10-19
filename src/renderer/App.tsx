/**
 * 主窗外壳（R7 搭骨架，R8 接主界面，R11 接托盘联动）。
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
import { useCallback, useEffect, useState } from "react"
import {
  HistoryIcon,
  HeartIcon,
  ListMusicIcon,
  MicVocalIcon,
  SearchIcon,
  SettingsIcon,
  ScrollTextIcon,
} from "lucide-react"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { APP_OPEN_SETTINGS } from "../shared/channels.ts"
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
import { PlaybackStage } from "./playback-stage.tsx"
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
import { usePlayer } from "./features/playback/use-player.ts"
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
import { trackAlbumOf, trackArtistsOf } from "./features/library/track-fields.mjs"
import { getTrayAvailable, onCoreEvent } from "./host-api"
import { TRAY_AVAILABLE, trayAvailabilityFromAnswer } from "./features/settings/settings-form.mjs"

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
  const [stageOpen, setStageOpen] = useState(false)
  // 托盘可用性：null = **还没取到**（不是"不可用"，也不是"可用"）
  const [trayAvailable, setTrayAvailable] = useState<boolean | null>(null)
  const notices = useNoticeLog()
  // 播放运行时是模块级单例（音频/媒体会话/广播都只能有一份），hook 只负责订阅状态
  const { runtime, state: playback } = usePlayer()

  const navigate = useCallback((next: unknown) => {
    setView(normalizeView(next))
  }, [])

  /**
   * 托盘可用性：启动时问宿主一次（R11）。
   *
   * 为什么要有这一步：设置页的关窗行为提示要么说"关窗后应用继续在托盘运行"，要么说
   * "现在关窗会直接退出"——这两句话不能猜。R10 的 `TRAY_AVAILABLE` 常量现在是**兜底**：
   * 查不到（宿主那条命令失败）就用它，落地的仍是保守的"不可用"。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const answer = await getTrayAvailable()
        if (alive) setTrayAvailable(trayAvailabilityFromAnswer(answer))
      } catch {
        // 查不到就落兜底常量（与 Rust 侧 fail-safe 同方向）：界面上不出现"托盘能用"的假话
        if (alive) setTrayAvailable(TRAY_AVAILABLE)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /**
   * 托盘的"设置…"（R11）：宿主发一条 `app:open-settings`，渲染层切到设置页。
   *
   * 没有这一条订阅，那个菜单项就是"点了没反应"——广播发出去没人接，从界面上看不出任何异常。
   * 视图状态在渲染层，所以切页只能由渲染层自己做（宿主发的是意图，不是命令式的"你跳到某页"）。
   */
  useEffect(() => {
    let alive = true
    let stop: (() => void) | null = null
    void (async () => {
      const unlisten = await onCoreEvent(APP_OPEN_SETTINGS, () => {
        navigate(createView(VIEW.settings))
      })
      // 订阅是异步拿到的：组件已经卸载就当场退订（不然监听器会留在宿主侧）
      if (alive) stop = unlisten
      else unlisten()
    })()
    return () => {
      alive = false
      if (stop) stop()
    }
  }, [navigate])

  /**
   * 双击一首歌 = **整张列表进队列**并从那一首开始。
   *
   * 只播那一首而不是整张列表，会让"下一首"永远没有下一首——列表就在用户眼前，
   * 队列用同一份顺序才符合预期（`songs` 由页面在点击点给出，见 pages.tsx 的注释）。
   */
  const onActivateTrack = useCallback(
    (song: unknown, index: number, songs: unknown[]) => {
      void runtime.player.playQueue(songs.length > 0 ? songs : [song], index)
    },
    [runtime],
  )

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
        // 设置页只读地显示队列状态（管理队列在播放队列面板里）：状态由外壳交下去，页面不自己取；
        // 托盘可用性同理（R11：查一次、交下去，页面不自己问宿主）
        return <SettingsPage queue={playback} trayAvailable={trayAvailable ?? TRAY_AVAILABLE} />
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
            <Button
              variant="ghost"
              size="icon"
              aria-label="歌词"
              aria-pressed={stageOpen}
              onClick={() => setStageOpen((open) => !open)}
            >
              <MicVocalIcon />
            </Button>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="播放队列">
                  <ListMusicIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>播放队列</SheetTitle>
                  <SheetDescription>双击列表里的曲目会替换整个队列。</SheetDescription>
                </SheetHeader>
                <QueuePanel
                  entries={playback.entries}
                  index={playback.index}
                  onSelect={(position) => {
                    void runtime.player.playAt(position)
                  }}
                  onClear={() => {
                    runtime.player.clear()
                  }}
                />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {/* 收藏页常驻（切走只是 hidden），其余页面按视图重挂；歌词舞台盖在这一层之上 */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {isResidentView(view) ? null : <div className="h-full min-h-0 overflow-y-auto">{renderPage()}</div>}
          <FavoritesPage
            active={isResidentView(view)}
            onActivateTrack={onActivateTrack}
            onOpenAlbum={onOpenAlbum}
            onOpenArtist={onOpenArtist}
          />
          <PlaybackStage
            open={stageOpen}
            runtime={runtime}
            state={playback}
            onClose={() => setStageOpen(false)}
          />
        </div>

        <PlayerBar runtime={runtime} state={playback} />
      </SidebarInset>
    </SidebarProvider>
  )
}
