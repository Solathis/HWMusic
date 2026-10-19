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
  AUTH_LOGOUT,
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
import { EmptyState, GridSkeleton, ListSkeleton, LoadFailed, TrackTable } from "./components"
import { coreCall, getAutostart, isCoreError, setAutostart } from "./host-api"
import { PlaylistGrid } from "./playlist-grid.tsx"
import { libraryEmptyText, libraryFailureText } from "./features/library/library-state.mjs"
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
  loginStatusText,
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
export function SettingsPage({ queue = null }: SettingsPageProps) {
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

  async function logout() {
    setFailure(null)
    try {
      await coreCall(AUTH_LOGOUT, null)
      // 不在这里自己跳回门禁页：`auth:status` 广播会把门禁层翻回来（唯一真源在 core）
    } catch (error) {
      setFailure(settingsFailureText(error))
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
            {closeBehaviorNotice(closeBehavior, { trayAvailable: TRAY_AVAILABLE })}
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
          <CardTitle>播放队列</CardTitle>
          <CardDescription>这里只显示当前状态，队列在播放队列面板里管理。</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{queueSummaryText(queueSummary(queue))}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>登录</CardTitle>
          <CardDescription>
            登录始终在华为官方的登录窗口里完成，本应用不接触你的凭据。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          {/* 设置页只存在于 app-shell 里，而 app-shell 只在门禁判定为"已登录"时渲染
              （`shouldShowLoginGate`）：这里的"已登录"是结构给的事实，不是页面自己猜的。
              退出之后 `auth:status` 广播会把门禁翻回来，这个页面随之卸载。 */}
          <span className="text-sm" role="status">
            {loginStatusText(true)}
          </span>
          <Button variant="secondary" onClick={() => void logout()}>
            退出登录
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
