/**
 * 主窗外壳：三态判定在最前，未登录（含「还不知道」）绝不渲染 app-shell。
 *
 * checking → 中性启动屏；logged_out → LoginGate；logged_in → app-shell（LibraryShell 必须晚于判定挂载）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  FileMusicIcon,
  HistoryIcon,
  HeartIcon,
  ListMusicIcon,
  LogOutIcon,
  MicVocalIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react"

import { APP_OPEN_SETTINGS } from "../shared/channels.ts"
import { LoginGate, StartupChecking, useAuthGate } from "./login-gate"
import type { AccountProfile } from "./login-gate"
import { Button } from "./components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar"
import { Badge } from "./components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar"
import { TooltipProvider } from "./components/ui/tooltip"
import { EmptyState, PlayerBar, QueuePanel } from "./components"
import { Toaster } from "./components/ui/sonner"
import { SidebarPlaylists } from "./sidebar-playlists.tsx"
import { PlaybackStage } from "./playback-stage.tsx"
import { ThemeToggle } from "./theme-toggle.tsx"
import { AccountNameTooltip } from "./account-name-tooltip.tsx"
import { FavoritesPage } from "./favorites-page.tsx"
import { useNoticeLog } from "./log-terminal.tsx"
import {
  AlbumPage,
  ArtistPage,
  HistoryPage,
  LocalSongsPage,
  PlaylistDetailPage,
  SearchPage,
  SettingsPage,
} from "./pages.tsx"
import { STARTUP_VIEW, startupViewOf } from "./features/auth/startup-view.mjs"
import {
  ACCOUNT_AREA_TESTID,
  ACCOUNT_AVATAR_TESTID,
  ACCOUNT_LOGOUT_CANCEL,
  ACCOUNT_LOGOUT_CONFIRM,
  ACCOUNT_LOGOUT_DESCRIPTION,
  ACCOUNT_LOGOUT_TITLE,
  ACCOUNT_VIP_TESTID,
  accountAvatarFallbackText,
  accountAvatarUrl,
  accountLogoutFailureText,
  accountNameText,
  accountVipText,
} from "./features/auth/account.mjs"
import { usePlayer } from "./features/playback/use-player.ts"
import { useLyricsWindow } from "./use-lyrics-window.ts"
import {
  NAV_LIST_TESTID,
  SIDEBAR_VIEWS,
  VIEW,
  createView,
  isResidentView,
  normalizeView,
  viewParam,
  viewTitle,
} from "./features/library/views.mjs"
import { libraryEmptyText } from "./features/library/library-state.mjs"
import { playlistNameOf } from "./features/library/playlist-fields.mjs"
import { trackAlbumOf, trackArtistsOf } from "./features/library/track-fields.mjs"
import { getTrayAvailable, coreLogout, onCoreEvent } from "./host-api"
import { TRAY_AVAILABLE, trayAvailabilityFromAnswer } from "./features/settings/settings-form.mjs"

export function App() {
  const gate = useAuthGate()
  /**
   * 三态判定只有一处（features/auth/startup-view.mjs 的纯函数）：app-shell 只在已登录时渲染。
   * checking（含状态查询失败）恒为中性启动屏，失败时那屏自带重新检查与网页登录两条出路。
   */
  const view = startupViewOf(gate.state)

  if (view !== STARTUP_VIEW.appShell) {
    // 确定未登录 → 登录门禁；还不知道（含查询失败）→ 中性启动屏（它自己带可操作的两条出路）
    return view === STARTUP_VIEW.loginGate ? <LoginGate gate={gate} /> : <StartupChecking gate={gate} />
  }

  // app-shell：登录之后才存在的那一块。
  return (
    /* TooltipProvider 包在最外层：侧栏收起成图标轨后导航项只剩图标，radix Tooltip 没有 Provider 会直接抛错。 */
    <TooltipProvider>
      <div className="h-full w-full" data-shell="app-shell">
        <LibraryShell profile={gate.profile} sessionExpiresAt={gate.sessionExpiresAt} />
      </div>
      {/* 一句话提示的唯一出口：shadcn 的 Toaster，样式全走主题变量。 */}
      <Toaster position="bottom-center" />
    </TooltipProvider>
  )
}

/**
 * 侧边栏图标的唯一映射表，这里只有图标；条目、标签、顺序都来自 views.mjs 的 SIDEBAR_VIEWS。
 */
const NAV_ICONS = {
  [VIEW.favorites]: HeartIcon,
  [VIEW.local]: FileMusicIcon,
  [VIEW.history]: HistoryIcon,
  [VIEW.settings]: SettingsIcon,
}

/**
 * 侧栏顶部的常驻搜索入口，必须是一个在 SidebarProvider 之内的组件（useSidebar 只在那里可用）。
 * 窄轨形态只留一枚图标按钮：点它先展开侧栏，再把光标交给输入框。
 */
function SidebarSearch({
  keyword,
  onKeywordChange,
  onSubmit,
}: {
  keyword: string
  onKeywordChange: (value: string) => void
  onSubmit: (value: string) => void
}) {
  const sidebar = useSidebar()
  const railCollapsed = sidebar.state === "collapsed" && !sidebar.isMobile
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const focusSearchAfterExpand = useRef(false)

  // 展开之后（输入框重新挂上）再把光标交给它。放在 effect 里而不是点击那一刻：
  // 点击时输入框还没渲染出来（收起态下它不在 DOM 里）。
  useEffect(() => {
    if (railCollapsed || !focusSearchAfterExpand.current) return
    focusSearchAfterExpand.current = false
    searchInputRef.current?.focus()
  }, [railCollapsed])

  if (railCollapsed) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="mx-auto"
        aria-label="搜索"
        data-testid="sidebar-search-rail"
        onClick={() => {
          focusSearchAfterExpand.current = true
          sidebar.setOpen(true)
        }}
      >
        <SearchIcon />
      </Button>
    )
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(keyword)
      }}
    >
      <SidebarInput
        ref={searchInputRef}
        value={keyword}
        onChange={(event) => onKeywordChange(event.target.value)}
        placeholder="搜索歌曲、歌手或专辑"
        aria-label="搜索关键字"
      />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="搜索" disabled={keyword.trim() === ""}>
        <SearchIcon />
      </Button>
    </form>
  )
}

export function LibraryShell({ profile = null, sessionExpiresAt = null }: { profile?: AccountProfile; sessionExpiresAt?: number | null }) {
  const [view, setView] = useState(() => createView(VIEW.favorites))
  const [stageOpen, setStageOpen] = useState(false)
  /**
   * 侧栏搜索框里的文字，只活在输入框里；真正的检索词随 VIEW.search 的视图参数走。
   */
  const [keyword, setKeyword] = useState("")
  /** 退出登录失败那一句（用户主动点的动作，失败必须看得见；成功时界面由 auth:status 广播接管） */
  const [logoutFailure, setLogoutFailure] = useState<string | null>(null)
  // 托盘可用性：null = **还没取到**（不是"不可用"，也不是"可用"）
  const [trayAvailable, setTrayAvailable] = useState<boolean | null>(null)
  /**
   * 运行日志：订阅留在这里（设置页只在切到设置时挂载），外壳收、页面只渲染。
   */
  const notices = useNoticeLog()
  // 播放运行时是模块级单例（音频/媒体会话/广播都只能有一份），hook 只负责订阅状态
  const { runtime, state: playback } = usePlayer()
  /**
   * 桌面歌词窗的接线：托盘勾选 → 建/显/隐窗口，歌词文本与进度推送共用 player.setLyrics。
   */
  const lyrics = useLyricsWindow(runtime, playback)

  const navigate = useCallback((next: unknown) => {
    setView(normalizeView(next))
  }, [])

  /**
   * 提交一次搜索：关键字放进 VIEW.search 的视图参数，空白关键字不发请求。
   */
  const submitSearch = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      setKeyword(trimmed)
      navigate(createView(VIEW.search, { keyword: trimmed }))
    },
    [navigate],
  )

  /**
   * 托盘可用性：启动时问宿主一次，查不到就用 TRAY_AVAILABLE 兜底（保守的「不可用」）。
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
   * 托盘的「设置…」：订阅 app:open-settings 后由渲染层自己切到设置页。
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

  /** 双击一首歌 = 整张列表进队列，并从那一首开始。 */
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

  /** 歌单详情页的两个动作：整队替换 / 追加，全部转给播放运行时。 */
  const onPlayAll = useCallback(
    (songs: unknown[]) => {
      void runtime.player.playQueue(songs, 0)
    },
    [runtime],
  )

  const onEnqueue = useCallback(
    (songs: unknown[]) => {
      runtime.player.enqueue(songs)
    },
    [runtime],
  )

  /** 「下一首播放」：插到当前曲目之后，不动正在播的那一首。 */
  const onPlayNext = useCallback(
    (songs: unknown[]) => {
      runtime.player.playNext(songs)
    },
    [runtime],
  )

  /** 行菜单的动作包：页面够不到播放运行时，外壳随 `navigation` 一起交下去。 */
  const rowActions = { onPlayNext, onEnqueue }
  const navigation = { onActivateTrack, onOpenAlbum, onOpenArtist, rowActions }

  /** 账号资料的四项投影（缺什么兜什么，绝不编：见 features/auth/account.mjs）。 */
  const accountName = accountNameText(profile)
  const accountAvatar = accountAvatarUrl(profile)
  const accountInitial = accountAvatarFallbackText(profile)
  const accountVipLabel = accountVipText(profile)

  /** 退出登录：确认框防误触，调用走 `host-api` 的 `coreLogout`，不做任何跳转。 */
  async function confirmLogout() {
    setLogoutFailure(null)
    try {
      await coreLogout()
    } catch (cause) {
      setLogoutFailure(accountLogoutFailureText(cause))
    }
  }

  /** 页面切换：一个 switch，没有路由库。收藏页常驻，所以这里没有它的分支。 */
  function renderPage() {
    switch (view.id) {
      case VIEW.playlistDetail:
        return <PlaylistDetailPage view={view} onPlayAll={onPlayAll} onEnqueue={onEnqueue} {...navigation} />
      case VIEW.search:
        // 关键字从视图参数来（侧栏那个常驻输入框提交的就是它）：页面自己不存检索词，见 submitSearch
        return <SearchPage view={view} {...navigation} />
      case VIEW.album:
        return <AlbumPage view={view} {...navigation} />
      case VIEW.artist:
        return <ArtistPage view={view} {...navigation} />
      case VIEW.history:
        return <HistoryPage {...navigation} />
      case VIEW.local:
        // 本地歌曲：页面自己向宿主取快照，外壳只交双击播放与行菜单两个动作。
        return <LocalSongsPage {...navigation} />
      case VIEW.settings:
        // 设置页只读地显示队列状态，状态由外壳交下去，页面不自己取；
        // 托盘可用性、桌面歌词配置、运行日志同理：查一次、交下去。
        return (
          <SettingsPage
            queue={playback}
            trayAvailable={trayAvailable ?? TRAY_AVAILABLE}
            lyrics={lyrics}
            notices={notices}
          />
        )
      default:
        // 认不出的视图（正常不会发生）：给一句空态，绝不白屏
        return <EmptyState text={libraryEmptyText(view)} />
    }
  }

  return (
    <SidebarProvider className="h-full min-h-0">
      {/* `collapsible="icon"`：收起后留一条 48px 图标轨，导航项变成图标 + 悬停 tooltip。 */}
      <Sidebar collapsible="icon">
        {/* 侧栏顶部的常驻搜索框：入口在这里，结果在内容区。 */}
        <SidebarHeader>
          <SidebarSearch keyword={keyword} onKeywordChange={setKeyword} onSubmit={submitSearch} />
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
                      {/* `tooltip` 是 shadcn sidebar 官方给窄轨的形态：收起时（且非移动端）
                          悬停显示标签，展开时不显示——标签本来就在按钮上 */}
                      <SidebarMenuButton
                        tooltip={entry.label}
                        isActive={view.id === entry.id}
                        onClick={() => navigate(createView(entry.id))}
                      >
                        <Icon />
                        <span>{entry.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* 侧栏「我的歌单」：组件自己取数并兜住三态，外壳只交当前歌单与"点开"。 */}
          <SidebarPlaylists
            activePlaylistId={view.id === VIEW.playlistDetail ? viewParam(view, "playlistId") : null}
            onOpen={onOpenPlaylist}
          />
        </SidebarContent>
        <SidebarFooter>
          {/* 账号区：头像 + 名字 + 会员徽标 + 主题 + 退出登录；窄轨里只留头像。 */}
          <div
            className="flex items-center gap-2 px-1 py-0.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            data-testid={ACCOUNT_AREA_TESTID}
          >
            <Avatar size="sm" data-testid={ACCOUNT_AVATAR_TESTID}>
              {accountAvatar === null ? null : <AvatarImage src={accountAvatar} alt="" />}
              <AvatarFallback>
                {accountInitial === null ? (
                  <UserIcon className="size-3.5" />
                ) : (
                  <span className="text-xs font-medium">{accountInitial}</span>
                )}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <AccountNameTooltip name={accountName} sessionExpiresAt={sessionExpiresAt} />
              {accountVipLabel === null ? null : (
                <Badge variant="secondary" className="mt-0.5 w-fit" data-testid={ACCOUNT_VIP_TESTID}>
                  {accountVipLabel}
                </Badge>
              )}
            </div>
            {/* 主题三态循环：与设置页「外观」卡的 Select 同源同向。 */}
            <ThemeToggle className="shrink-0 group-data-[collapsible=icon]:hidden" />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={ACCOUNT_LOGOUT_TITLE}
                  className="shrink-0 group-data-[collapsible=icon]:hidden"
                >
                  <LogOutIcon />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{ACCOUNT_LOGOUT_TITLE}</AlertDialogTitle>
                  <AlertDialogDescription>{ACCOUNT_LOGOUT_DESCRIPTION}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{ACCOUNT_LOGOUT_CANCEL}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void confirmLogout()}>
                    {ACCOUNT_LOGOUT_CONFIRM}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          {logoutFailure === null ? null : (
            <p className="px-1 text-xs text-destructive" role="alert">
              {logoutFailure}
            </p>
          )}
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
                  {...rowActions}
                />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {/* 收藏页常驻（切走只是 hidden），其余页面按视图重挂 */}
        <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="main-content">
          {isResidentView(view) ? null : <div className="h-full min-h-0 overflow-y-auto">{renderPage()}</div>}
          <FavoritesPage
            active={isResidentView(view)}
            onActivateTrack={onActivateTrack}
            onOpenAlbum={onOpenAlbum}
            onOpenArtist={onOpenArtist}
            {...rowActions}
          />
        </div>

        {/* 封面/曲目信息也是进入播放页的入口；`lyrics` 是外壳唯一的 binding，两处共用。 */}
        <PlayerBar runtime={runtime} state={playback} onOpenStage={() => setStageOpen(true)} lyrics={lyrics} />
      </SidebarInset>
      <PlaybackStage
        open={stageOpen}
        runtime={runtime}
        state={playback}
        onClose={() => setStageOpen(false)}
        lyrics={lyrics}
      />
    </SidebarProvider>
  )
}
