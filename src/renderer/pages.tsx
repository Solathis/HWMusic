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
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select"
import { Switch } from "./components/ui/switch"
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
import { VIEW, createView, viewParam } from "./features/library/views.mjs"
import {
  LYRICS_COLOR_TOKENS,
  LYRICS_FONT_STEPS,
  LYRICS_MODES,
  LYRICS_SESSION_NOTICE,
  colorTokenLabel,
  fontStepLabel,
  modeLabel,
} from "./features/lyrics/lyrics-window.mjs"
import type { LyricsWindowBinding } from "./use-lyrics-window.ts"

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
  onActivateTrack: (song: unknown, index: number, songs: unknown[]) => void
  onOpenAlbum: (albumId: string, song: unknown) => void
  onOpenArtist: (artistId: string, song: unknown) => void
}) {
  if (resource.status === "loading") return <ListSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />
  const songs = resource.data ?? []
  return (
    <TrackTable
      songs={songs}
      emptyText={emptyText}
      // 队列要用**整张列表**（只播一首会让"下一首"永远没有下一首）：列表只有页面手里有
      onActivate={(song, index) => onActivateTrack(song, index, songs)}
      onOpenAlbum={onOpenAlbum}
      onOpenArtist={onOpenArtist}
    />
  )
}

export interface PageNavigationProps {
  /** 双击曲目：`songs` 是这一页当前的完整列表（播放器用它当队列） */
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
 * 歌单详情页（R40 **删除重写**）。
 *
 * 旧版只有一个曲目表：没有歌单名、没有封面、没有"播放全部"——点进一张歌单像是掉进了一份
 * 无名列表。现在三块：
 *
 * 1. **头部**：大封面 + 歌单名 + 元信息（共几首 / 已加载几首）+ 动作按钮。头部底景用 AMLL
 *    官方的 `BackgroundRender`（`AmllBackground`）：封面地址交给它之前先由宿主用 `new Image()`
 *    加载成 `HTMLImageElement`——**不是 fetch**（CSP 的 `connect-src` 只有 self/ipc，
 *    字符串地址会被 AMLL 拿去 fetch 而撞墙；图片走的是 `img-src`）；
 * 2. **动作**：`播放全部` = 用这一页的曲目整队替换并从第一首开始（`playQueue`）；
 *    `加入队列` = 追加到队尾、不动正在播的那一首（`enqueue`）。两个都**只作用于已加载的曲目**，
 *    分页没走完时页面上有一句说明（不把"前 50 首"说成"整张歌单"）；
 * 3. **正文**：曲目表（沿用 `TrackTable`：双击播放、键盘可达、艺人/专辑跳转）。
 *
 * 数据来源仍是**一次一页**的歌单详情频道（`LIBRARY_PLAYLIST_DETAIL`，载荷 `{playlistId, page,
 * pageSize}`）：`data.playlist` 是协议层归一化过的歌单元信息（名字/封面/曲目数都从它读，
 * 不在渲染层再解析一份原始响应）。
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
  /** 播放全部：把这一页的曲目整队替换并播放第一首 */
  onPlayAll?: (songs: unknown[]) => void
  /** 加入队列：追加到队尾（不动正在播的那一首） */
  onEnqueue?: (songs: unknown[]) => void
} & PageNavigationProps) {
  const playlistId = viewParam(view, "playlistId")
  const select = useCallback(
    (data: { songs?: unknown[]; playlist?: unknown; hasMore?: unknown }): PlaylistDetailData => ({
      songs: data.songs ?? [],
      playlist: data.playlist ?? null,
      // 只有协议层明说"还有下一页"才算更多（渲染层不自己从条数猜）
      hasMore: data.hasMore === true,
    }),
    [],
  )
  const resource = useLibraryResource<PlaylistDetailData>(
    LIBRARY_PLAYLIST_DETAIL,
    { playlistId, page: 1, pageSize: LIST_PAGE_SIZE },
    select,
    playlistId !== null,
  )

  if (resource.status === "loading") return <ListSkeleton />
  if (resource.status === "error") return <LoadFailed text={libraryFailureText(resource.failure)} />

  const data = resource.data
  const songs = data?.songs ?? []
  const playlist = data?.playlist ?? null
  const hasMore = data?.hasMore === true
  const coverUrl = playlistCoverUrlOf(playlist)
  const title = playlistDetailTitleOf(playlist, viewParam(view, "name"))
  const actionsDisabled = songs.length === 0

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

      <TrackTable
        songs={songs}
        emptyText={libraryEmptyText(view)}
        onActivate={(song, index) => navigation.onActivateTrack(song, index, songs)}
        onOpenAlbum={navigation.onOpenAlbum}
        onOpenArtist={navigation.onOpenArtist}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 搜索：结果（输入框在侧栏顶部，R40 从页内搬走）
// ---------------------------------------------------------------------------

/**
 * 搜索结果页（R40 删掉页内输入框，只剩结果）。
 *
 * 检索词**由外壳经视图参数交下来**（`VIEW.search` 的 `keyword`）：入口在侧栏的常驻搜索框，
 * 结果在内容区，两处必须是同一条数据——页面自己存一份就会出现"侧栏显示 A、内容区显示 B"。
 * 所以这里既不渲染输入框，也不持有 keyword 状态：没提交过（没有 keyword）就显示
 * "输入关键字开始搜索。"，提交过就按同一档规则显示结果或「查无所获」。
 *
 * 页面本身不再自带滚动容器：结果直接落在内容区那一个滚动根里（R39 已记待裁决的重复层，
 * 这里随输入框一起去掉）。
 */
export function SearchPage({ view, ...navigation }: { view: View } & PageNavigationProps) {
  const keyword = viewParam(view, "keyword")
  const select = useCallback((data: { songs?: unknown[] }) => data.songs ?? [], [])

  // 没提交过（keyword 为 null/空）就不发请求：空关键字在 core 侧是 invalid_payload，
  // 那不是用户想看到的"错误"（"输入关键字开始搜索。"才是实话）
  const resource = useLibraryResource<unknown[]>(
    LIBRARY_SEARCH,
    { keyword: keyword ?? "", page: 1, pageSize: LIST_PAGE_SIZE },
    select,
    keyword !== null,
  )

  if (keyword === null) return <EmptyState text={libraryEmptyText(view)} />

  return (
    <TrackListView
      emptyText={libraryEmptyText(view, { searched: true })}
      resource={resource}
      {...navigation}
    />
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
   * 页面**不自己问宿主**（与 `trayAvailable` 同一条纪律）：配置的唯一真源在 Rust 侧
   * （会话内），外壳读回来之后交下来，页面只负责把值渲染出来、把改动交回去。
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
 * 设置页：代理表单、关窗行为、开机自启、外观、队列（只读）、登录状态与退出。
 *
 * 三条纪律（沿 R8/R9 的做法）：
 * - 所有文案与判定都在 `features/settings/settings-form.mjs`（纯函数，跑得了测试）；
 *   页面只做"把状态塞进去、把返回值渲染出来"。
 * - 凭据只写不读：密码字段永远是 `type="password"`、永远从空开始，回执里有密码但**不进表单**。
 * - 不冒充：没测过不给测试结论、读不到自启状态就说"未取到"、保存回执按 `restartRequired`
 *   如实说"要重启"，主机没通过清洗就说"仍是直连"。
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
    setCloseBehavior(next)
    setFailure(null)
    try {
      const answer = await coreCall<SettingsAnswer>(SETTINGS_SET, { patch: closeBehaviorPatch(next) })
      setNotice(proxySaveNotice(answer.settings, answer.restartRequired === true))
    } catch (error) {
      // 没写成就把选择拨回去：界面上停在一个"没保存的值"，跟撒谎只差一步
      setCloseBehavior(previous)
      setFailure(settingsFailureText(error))
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
    <div className="m-4 flex max-w-3xl flex-col gap-4" data-testid="settings-page">
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
            <SelectTrigger aria-label="关窗行为" className="w-64">
              {/* 直接把标签写进 SelectValue：radix 在没有展开过内容时拿不到选项文案
                  （选项文本要等它挂载），触发器就会是空的——受控值 + 自绘标签才稳定 */}
              <SelectValue>{closeBehaviorLabel(closeBehavior)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CLOSE_BEHAVIORS.map((behavior) => (
                <SelectItem key={behavior} value={behavior}>
                  {closeBehaviorLabel(behavior)}
                </SelectItem>
              ))}
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
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{APPEARANCE_NOTICE_TEXT}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>桌面歌词</CardTitle>
          <CardDescription>桌面上的独立歌词窗（无边框、置顶、可拖可锁）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="lyrics-visible"
              checked={lyrics?.visible === true}
              disabled={lyrics === null}
              onCheckedChange={(checked) => lyrics?.setVisible(checked)}
            />
            <Label htmlFor="lyrics-visible">显示桌面歌词</Label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="lyrics-mode">窗口位置</Label>
              <Select
                value={lyrics?.config.mode ?? LYRICS_MODES[0]}
                disabled={lyrics === null}
                onValueChange={(value) => lyrics?.updateConfig({ mode: value })}
              >
                <SelectTrigger id="lyrics-mode" className="w-full">
                  {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案（R10 的同一个坑） */}
                  <SelectValue>{modeLabel(lyrics?.config.mode)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LYRICS_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {modeLabel(mode)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="lyrics-size">字号</Label>
              <Select
                value={lyrics?.config.size ?? LYRICS_FONT_STEPS[0].id}
                disabled={lyrics === null}
                onValueChange={(value) => lyrics?.updateConfig({ size: value })}
              >
                <SelectTrigger id="lyrics-size" className="w-full">
                  <SelectValue>{fontStepLabel(lyrics?.config.size)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LYRICS_FONT_STEPS.map((step) => (
                    <SelectItem key={step.id} value={step.id}>
                      {fontStepLabel(step.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="lyrics-color">颜色</Label>
              <Select
                value={lyrics?.config.color ?? LYRICS_COLOR_TOKENS[0].id}
                disabled={lyrics === null}
                onValueChange={(value) => lyrics?.updateConfig({ color: value })}
              >
                <SelectTrigger id="lyrics-color" className="w-full">
                  <SelectValue>{colorTokenLabel(lyrics?.config.color)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LYRICS_COLOR_TOKENS.map((token) => (
                    <SelectItem key={token.id} value={token.id}>
                      {colorTokenLabel(token.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col justify-end gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="lyrics-locked"
                  checked={lyrics?.config.locked === true}
                  disabled={lyrics === null}
                  onCheckedChange={(checked) => lyrics?.updateConfig({ locked: checked })}
                />
                <Label htmlFor="lyrics-locked">锁定（不可拖动）</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="lyrics-click-through"
                  checked={lyrics?.config.clickThrough === true}
                  disabled={lyrics === null}
                  onCheckedChange={(checked) => lyrics?.updateConfig({ clickThrough: checked })}
                />
                <Label htmlFor="lyrics-click-through">鼠标穿透</Label>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {/* 会话内这件事必须写在设置项旁边（已知限制，见 docs/API_CONTRACT.md §2.9） */}
            {LYRICS_SESSION_NOTICE}
          </p>
        </CardContent>
      </Card>

      {/* 歌词缓存 / 一键清除 / 导入本地歌词（R41）：与上面那张卡同一件事的两半（显示 vs 存放） */}
      <LyricsCacheCard lyrics={lyrics} />

      <Card>
        <CardHeader>
          <CardTitle>播放队列</CardTitle>
          <CardDescription>这里只显示当前状态，队列在播放队列面板里管理。</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{queueSummaryText(queueSummary(queue))}</p>
        </CardContent>
      </Card>

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
    </div>
  )
}
