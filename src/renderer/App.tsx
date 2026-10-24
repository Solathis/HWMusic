/**
 * 主窗外壳（R7 搭骨架，R8 接主界面，R11 接托盘联动）。
 *
 * **顺序是契约**：界面三态判定在最前，未登录（含"还不知道"）绝不渲染 app-shell——
 * `test/login-gate.test.mjs` 扫源码钉住这个顺序（顺序反了就是把没登录的用户放进主界面，
 * 然后每个请求都失败，用户只会看到一堆报错）。
 *
 * R45A1（用户第 10 项）：**"还不知道"有自己的界面**。`checking` 不等于未登录——
 * 它是"core 还没答上来"（首帧状态，等一次 IPC 往返）。旧版把这一档也画成 `LoginGate`，
 * 于是已登录的会话冷启动时第一帧就是整张登录页，快照落地才翻成主界面 → 用户看见"闪一下
 * 登录页"。现在三态各有一个落点（判定唯一真源：`features/auth/startup-view.mjs`）：
 *
 * ```
 *   checking     → 中性启动屏（StartupChecking：一枚转圈，无二维码、无文案、无可点元素）
 *   logged_out   → LoginGate（原来那一页；二维码到这一刻才自动发起）
 *   logged_in    → app-shell
 * ```
 *
 * 主界面本身（`LibraryShell`）**必须晚于三态判定挂载**：它一挂载就开始取库数据，
 * 未登录时那些请求只会全部失败。判定放行才渲染，是从结构上保证这件事，而不是靠判断。
 *
 * 页面切换没有路由库：视图就是一个 `useState` + `renderPage()` 的 switch
 * （页面只有八个，路由库在这里只有依赖和"浏览器历史语义不适用"的麻烦）。
 * 唯一的例外是收藏页：它常驻挂载（切页不卸载），所以挂在 switch 之外、用 active 控制显隐。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  CrownIcon,
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
import { PlaybackStage } from "./playback-stage.tsx"
import { ThemeToggle } from "./theme-toggle.tsx"
import { FavoritesPage } from "./favorites-page.tsx"
import { useNoticeLog } from "./log-terminal.tsx"
import {
  AlbumPage,
  ArtistPage,
  HistoryPage,
  PlaylistDetailPage,
  PlaylistsPage,
  SearchPage,
  SettingsPage,
} from "./pages.tsx"
import { STARTUP_VIEW, startupViewOf } from "./features/auth/startup-view.mjs"
import {
  ACCOUNT_AREA_TESTID,
  ACCOUNT_LOGOUT_CANCEL,
  ACCOUNT_LOGOUT_CONFIRM,
  ACCOUNT_LOGOUT_DESCRIPTION,
  ACCOUNT_LOGOUT_TITLE,
  ACCOUNT_NAME_TESTID,
  ACCOUNT_VIP_LABEL,
  ACCOUNT_VIP_TESTID,
  accountAvatarUrl,
  accountIsVip,
  accountLogoutFailureText,
  accountNameText,
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
   * R45A1（用户第 10 项）：**三态**，不是两态。
   *
   * `checking`（还不知道：等 `auth:status` / `auth:get-status` 的应答）**不是**未登录，
   * 它有自己的界面（`StartupChecking` 那块安静的骨架）。旧代码在这里只问"能不能渲染
   * app-shell"，把 `checking` 一并画成 `LoginGate`——已登录的会话冷启动时，那第一帧就是
   * 用户看见的"闪一下登录页"（快照要等一次 IPC 往返才到）。
   *
   * 判定只有一处（`features/auth/startup-view.mjs`，纯函数）：
   * - 检查中不建二维码订单（`shouldAutoStartQr` 只认**确定未登录**）；
   * - app-shell 仍然只在**已登录**时渲染（"能不能渲染 shell"仍由 `shouldShowLoginGate` 判，
   *   `startupViewOf` 直接读它，两个模块不可能各说一套）；
   * - **复审 R45A1**：`checking` 恒为中性启动屏——包括状态查询真的失败那一档。失败时那屏
   *   自己长出「重新检查登录状态」（真的重发 `auth:get-status`）与网页登录入口，
   *   所以"不许画成登录页"与"不许困在空转的屏上"同时成立（见 `startupCheckingStatusOf`）。
   */
  const view = startupViewOf(gate.state)

  if (view !== STARTUP_VIEW.appShell) {
    // 确定未登录 → 登录门禁；还不知道（含查询失败）→ 中性启动屏（它自己带可操作的两条出路）
    return view === STARTUP_VIEW.loginGate ? <LoginGate gate={gate} /> : <StartupChecking gate={gate} />
  }

  // app-shell：登录之后才存在的那一块（R7 的测试锚点，R8 保留）
  return (
    /*
      R41b：`TooltipProvider` 包在最外层——侧栏收起成图标轨之后，导航项只剩图标，
      shadcn sidebar 的官方做法是 `SidebarMenuButton` 的 `tooltip` 参数（rack 里悬停给标签）。
      radix 的 `Tooltip` 没有 Provider 会直接抛错（"must be used within TooltipProvider"），
      而全项目此前一处 tooltip 都没用上，所以这一层是新加的、也是唯一的一层。
    */
    <TooltipProvider>
      <div className="h-full w-full" data-shell="app-shell">
        <LibraryShell profile={gate.profile} />
      </div>
    </TooltipProvider>
  )
}

/**
 * 侧边栏图标的唯一映射表。
 *
 * 这里**只有图标**：导航条目、标签、顺序全部来自 views.mjs 的 SIDEBAR_VIEWS——
 * 再抄一份条目列表，就会出现"导航里有个页面上没有的入口"这种漂移。
 *
 * R40：`VIEW.search` 没有图标了（它不是导航项），搜索入口是侧栏顶部那个常驻输入框。
 */
const NAV_ICONS = {
  [VIEW.favorites]: HeartIcon,
  [VIEW.playlists]: ListMusicIcon,
  [VIEW.history]: HistoryIcon,
  [VIEW.settings]: SettingsIcon,
}

/**
 * 侧栏顶部的常驻搜索入口（R40 取代了原来那条「搜索」导航项；R41b 补上窄轨形态）。
 *
 * **它必须是一个在 `SidebarProvider` 之内的组件**：`useSidebar()` 只在这个上下文里拿得到
 * 收起态，而外壳 `LibraryShell` 在 Provider **之外**（Provider 是它自己渲染的）——
 * 在外壳里调 `useSidebar()` 会当场抛 "must be used within a SidebarProvider"（真机上撞过）。
 *
 * 两种形态（同一个入口，不是一个东西两处实现）：
 * - 展开（或移动端）：`SidebarInput` + 提交按钮，回车提交（关键字交回外壳的 `onSubmit`）；
 * - 窄轨（`collapsible="icon"`，48px）：输入框与按钮在那个宽度里没有可用形态，
 *   官方做法就是收起时不渲染它——只留一枚图标按钮，点它先**展开侧栏**，再把光标交给输入框
 *   （用户点的是"搜索"，落点就该是能打字的地方）。
 *
 * 关键字**不进这里**：它在 `onSubmit` 里被放进 `VIEW.search` 的视图参数（见 LibraryShell 的注释），
 * 这一层只负责"输入框里显示什么"与"什么时候提交"。
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

export function LibraryShell({ profile = null }: { profile?: AccountProfile }) {
  const [view, setView] = useState(() => createView(VIEW.favorites))
  const [stageOpen, setStageOpen] = useState(false)
  /**
   * 侧栏搜索框里的文字（R40）。
   *
   * 它**只活在输入框里**：真正的检索词随视图走（`VIEW.search` 的 `keyword` 参数），
   * 这样"搜过什么"与"内容区正在显示什么"永远是同一条数据。输入框保留最后一次提交的文字，
   * 用户抬眼就能看见自己在搜什么（清空输入框不会把结果清掉——那是两件事）。
   */
  const [keyword, setKeyword] = useState("")
  /** 退出登录失败那一句（用户主动点的动作，失败必须看得见；成功时界面由 auth:status 广播接管） */
  const [logoutFailure, setLogoutFailure] = useState<string | null>(null)
  // 托盘可用性：null = **还没取到**（不是"不可用"，也不是"可用"）
  const [trayAvailable, setTrayAvailable] = useState<boolean | null>(null)
  /**
   * 运行日志（R39 展示在设置页那张卡里）。
   *
   * 订阅**留在这里**而不是挪进设置页：`app:notice` 是广播，没人订阅的那一刻提示就没了，
   * 而设置页只在用户切到设置时才挂载——那样"打开设置页之前的日志"会全丢。
   * 与 `trayAvailable`/`lyrics` 同一条纪律：外壳收，页面只渲染。
   */
  const notices = useNoticeLog()
  // 播放运行时是模块级单例（音频/媒体会话/广播都只能有一份），hook 只负责订阅状态
  const { runtime, state: playback } = usePlayer()
  /**
   * 桌面歌词窗的接线（R12）：托盘勾选 → 建/显/隐窗口、歌词文本 → 地面歌词窗，
   * 以及进度推送。数据链与主窗里的歌词面板**共用同一份行**（`player.setLyrics`）。
   */
  const lyrics = useLyricsWindow(runtime, playback)

  const navigate = useCallback((next: unknown) => {
    setView(normalizeView(next))
  }, [])

  /**
   * 提交一次搜索（R40）：把关键字放进 **`VIEW.search` 的视图参数**，内容区随之切到结果页。
   *
   * 为什么关键字走视图参数而不是留在搜索页的组件状态里：入口在侧栏（外壳），结果在内容区（页面），
   * 两者必须是同一条数据——页面自己存一份就会出现"侧栏显示 A、内容区显示 B 的结果"。
   * 空白关键字不发请求（core 侧那是 `invalid_payload`），此时切到搜索页显示"输入关键字开始搜索。"。
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

  /**
   * 歌单详情页的两个动作（R40）：都是**整队替换 / 追加**，动作全部转给播放运行时
   * （页面拿不到音频，也拿不到地址——与双击播放同一条纪律）。
   *
   * `playAll` 用 `playQueue`（整队替换 + 从第一首开播）；`enqueue` 用 `enqueue`
   * （追加到队尾、不动正在播的那一首）。两者都只作用于页面交上来的那批曲目。
   */
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

  /** 账号资料的三项投影（缺什么兜什么，绝不编：见 features/auth/account.mjs）。 */
  const accountName = accountNameText(profile)
  const accountAvatar = accountAvatarUrl(profile)
  const accountVip = accountIsVip(profile)

  /**
   * 退出登录（R38 从设置页搬到这里）。
   *
   * 三件事都只有一处实现：确认框（`AlertDialog`）负责"防误触"，真正的调用走
   * `host-api` 的 `coreLogout`（唯一的 `auth:logout` 出口），失败只在这里显示一句人话。
   * **不做任何跳转**：`auth:status` 广播会把门禁翻回来（成功后这个组件随之卸载）。
   */
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
      case VIEW.playlists:
        return <PlaylistsPage onOpenPlaylist={onOpenPlaylist} />
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
      case VIEW.settings:
        // 设置页只读地显示队列状态（管理队列在播放队列面板里）：状态由外壳交下去，页面不自己取；
        // 托盘可用性同理（R11：查一次、交下去，页面不自己问宿主）；
        // 桌面歌词配置同理（Rust 权威，单例桥代理恢复/保存）；
        // 运行日志同理（R39：订阅在外壳——广播没人接就丢了，页面只渲染，见 useNoticeLog 的注释）
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
      {/*
        R41b：`collapsible="icon"`。
        shadcn sidebar 的默认模式是 `offcanvas`——收起 = **整块滑出**（`left: -16rem`），
        于是"收起侧栏"与"关掉侧栏"在界面上一模一样，导航就再也点不到了。
        `icon` 是官方为常驻导航准备的那一档：收起后侧栏留着一条 48px 的图标轨
        （`--sidebar-width-icon`），导航项变成图标 + 悬停 tooltip，展开即恢复。
      */}
      <Sidebar collapsible="icon">
        {/*
          侧栏顶部的常驻搜索框（R40 取代了原来那条「搜索」导航项）：入口在这里，结果在内容区。
          R41b 把它的两种形态（展开时的输入框 / 窄轨里的一枚图标按钮）收进 `SidebarSearch`
          ——那一层在 `SidebarProvider` 里，才拿得到收起态。
        */}
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
        </SidebarContent>
        <SidebarFooter>
          {/*
            账号区（R38）：头像 + 名字 + VIP 徽标 + 主题 + 退出登录。
            资料来自 `auth:status` 载荷的可选 `profile`（门禁那一层解析后交下来）——
            旧会话没有 profile 时这里显示兜底（头像占位 + "已登录"），**不造假数据**。
            退出走 `AlertDialog` 二次确认：误触的代价是重新扫码。

            R41b：主题那枚纯图标按钮挂在「退出登录」**左边**（`ml-auto` 把两个按钮一起推到右端），
            窄轨里账号区改成竖排（三个 24~28px 的图标在 32px 宽的轨道里横着放不下）——
            名字与 VIP 徽标在窄轨里隐藏（官方 `SidebarGroupLabel` 同款做法：收起时 `hidden`）。
          */}
          <div
            className="flex flex-wrap items-center gap-2 px-1 py-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0"
            data-testid={ACCOUNT_AREA_TESTID}
          >
            <Avatar size="sm">
              {accountAvatar === null ? null : <AvatarImage src={accountAvatar} alt="" />}
              <AvatarFallback>
                <UserIcon className="size-3.5" />
              </AvatarFallback>
            </Avatar>
            <span
              className="min-w-0 truncate text-sm group-data-[collapsible=icon]:hidden"
              data-testid={ACCOUNT_NAME_TESTID}
            >
              {accountName}
            </span>
            {accountVip ? (
              <CrownIcon
                className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
                aria-label={ACCOUNT_VIP_LABEL}
                data-testid={ACCOUNT_VIP_TESTID}
              />
            ) : null}
            {/* 主题三态循环（R41b）：与设置页「外观」卡的 Select 同源同向（同一份接线） */}
            <ThemeToggle className="ml-auto group-data-[collapsible=icon]:ml-0" />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={ACCOUNT_LOGOUT_TITLE}>
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
                />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        {/* 收藏页常驻（切走只是 hidden），其余页面按视图重挂 */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {isResidentView(view) ? null : <div className="h-full min-h-0 overflow-y-auto">{renderPage()}</div>}
          <FavoritesPage
            active={isResidentView(view)}
            onActivateTrack={onActivateTrack}
            onOpenAlbum={onOpenAlbum}
            onOpenArtist={onOpenArtist}
          />
        </div>

        {/* R40：封面/曲目信息也是"进入播放页（歌词舞台）"的入口，与头部那枚按钮同一个 state */}
        <PlayerBar runtime={runtime} state={playback} onOpenStage={() => setStageOpen(true)} />
      </SidebarInset>
      <PlaybackStage
        open={stageOpen}
        runtime={runtime}
        state={playback}
        onClose={() => setStageOpen(false)}
      />
    </SidebarProvider>
  )
}
