/** 主窗观察单例歌词桥的权威配置/保存状态（落盘归 Rust），并转发唯一播放器的文档与进度。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getLyricsBridge } from "./features/lyrics/lyrics-bridge.mjs"
import { createLyricsToggleIntent, toggleFailureText } from "./features/lyrics/lyrics-toggle-intent.mjs"
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_STATUS,
  importPlanOf,
  lyricsTargetPlan,
} from "./features/lyrics/lyrics-window.mjs"
import { createProgressPump } from "./features/lyrics/progress-pump.mjs"
import { trackArtistsOrNull, trackDurationOf, trackNameOrNull } from "./features/library/track-fields.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

/** 开关是从哪一面按的（决定失败提示印在哪里；不在播放面上的失败只进日志）。 */
export type LyricsToggleSurface = "player-bar" | "playback-stage"

export interface LyricsWindowBinding {
  /** Rust 运行权威配置的投影（持久化由 Rust 的保存任务拥有，桥只读回状态）。 */
  config: typeof DEFAULT_LYRICS_CONFIG
  /** 歌词窗此刻是不是开着（宿主回执里的观测值，不是"我们请求它开着"）。 */
  visible: boolean
  /**
   * "我们请求它开着"：**待定意图优先**（见 [`toggleVisible`]），否则是宿主回执里的值。
   *
   * 为什么不是直接用宿主的 `requestedVisible`：点下去到回执回来之间有一段真空，
   * 那段时间里按钮必须已经翻过去（否则第二次点击会按旧状态再算一次同一个目标）。
   */
  requestedVisible?: boolean
  runtimeRevision?: number
  taskbar?: { supported: boolean; attached: boolean; reason: string }
  /** 开/关桌面歌词窗（设置页的 Switch 与托盘广播走它；目标态由调用方给）。 */
  setVisible: (next: boolean) => void
  /**
   * 切换桌面/任务栏歌词窗（播放栏与沉浸页那两枚快捷开关走它）。
   *
   * **取反由意图机决定，不由渲染快照决定**：同一个任务里连点两次时，第二次拿到的渲染状态
   * 还是第一次之前的那一份；意图机记得最后一次意图（`pending`），所以第二次仍然取反
   * ——两条命令是"开、关"，不是"开、开"（见 `features/lyrics/lyrics-toggle-intent.mjs`）。
   *
   * `surface` 说明是哪一面按的：失败时那句话只印在那一面（同一个失败在界面上只有一句）。
   */
  toggleVisible: (surface?: LyricsToggleSurface) => void
  /** 直接切到关闭 / 桌面歌词 / 任务栏歌词（先改模式，再开窗；失败只记日志）。 */
  selectTarget: (target: "off" | "desktop" | "taskbar", surface?: LyricsToggleSurface) => void
  /**
   * 上一次开关失败的人话（原因 + 下一步）；`null` = 没有失败。
   * 播放栏与沉浸页在**发起面**直接显示它（不另弹 toast，也不只写 console）。
   */
  toggleError: string | null
  /** 失败是从哪一面发起的（`null` = 设置页/托盘，或没有失败）。 */
  toggleErrorSurface: LyricsToggleSurface | null
  /** 重试最后那一次开关意图（失败之后的「重试」）。 */
  retryToggle: () => void
  /** 关掉失败提示（不发命令、不改窗口）。 */
  dismissToggleError: () => void
  /** 改配置（字号/颜色/模式/锁定/点透）。 */
  updateConfig: (patch: Partial<typeof DEFAULT_LYRICS_CONFIG>) => void
  saveError?: string | null
  retrySave?: () => void
  /**
   * 本地歌词导入是否可用（R41）：**没有正在播放的曲目时不可用**。
   *
   * 为什么以"当前曲目"为准（而不是让用户先挑歌再挑文件）：导入的语义是"换掉**这首歌**的歌词"，
   * 没有这首歌就无从换起。界面据此禁用入口并说清原因，而不是让用户选完文件才被告知失败。
   */
  canImport: boolean
  /**
   * 导入一份本地歌词文件（R41）：解码、官方解析、落盘全在桥里，成功后歌词**立刻**生效。
   * 回执 `{ok, message}` —— 失败时 `message` 是给用户看的人话（带原因与下一步）。
   */
  importFile: (file: unknown) => Promise<{ ok: boolean; message: string }>
}

const log = (...parts: unknown[]) => console.warn("[hwmusic-lyrics]", ...parts)

export function useLyricsWindow(runtime: PlayerRuntime, state: PlayerState): LyricsWindowBinding {
  const bridge = getLyricsBridge()
  const [windowStatus, setWindowStatus] = useState(() => bridge.snapshot())
  const { config, visible, requestedVisible, taskbar, saveError } = windowStatus
  const trackId = state.track?.id ?? null
  const title = trackNameOrNull(state.track)
  const artist = trackArtistsOrNull(state.track)
  const durationSeconds = trackDurationOf(state.track)
  const trackQuery = useMemo(
    () => trackId === null ? null : { trackId, title, artist, durationSeconds },
    [trackId, title, artist, durationSeconds],
  )

  /** 播放状态的最新值：歌词窗就绪重放时读它（不进 effect 依赖）。 */
  const stateRef = useRef(state)
  stateRef.current = state

  /** 宿主状态的最新值：意图机按它算"当前是开还是关"（异步回执里读，不能用渲染闭包）。 */
  const statusRef = useRef(windowStatus)
  statusRef.current = windowStatus

  /**
   * 开关的待定意图（R45C）：`pending` 是"最后一次点击想让它变成什么"，`error` 是失败人话。
   *
   * 为什么状态在这里、而不在按钮里：播放栏与沉浸页是**两枚按钮、同一个歌词窗**。意图放在
   * binding 这一层，两枚按钮才共享同一条"还没回执的意图"，也不会各自记一份"我以为开着"。
   */
  const [toggleState, setToggleState] = useState<{
    pending: boolean | null
    error: string | null
    surface: string | null
  }>({
    pending: null,
    error: null,
    surface: null,
  })
  const intentRef = useRef<ReturnType<typeof createLyricsToggleIntent> | null>(null)
  if (intentRef.current === null) {
    intentRef.current = createLyricsToggleIntent({
      send: async (target: boolean) => {
        try {
          return await bridge.setVisible(target)
        } catch (cause) {
          // 诊断留在日志里（不含歌名/账号/签名 URL）：界面只拿一句人话，见 toggleFailureText
          log("桌面歌词开关失败：", cause)
          throw cause
        }
      },
      onChange: (next: { pending: boolean | null; error: string | null; surface: string | null }) => setToggleState(next),
      failureText: (target: boolean) => toggleFailureText(target, statusRef.current.config?.mode),
    })
  }
  const intent = intentRef.current

  useEffect(() => bridge.observe(setWindowStatus, () => stateRef.current), [bridge])

  // 3. 歌词数据链：曲目变化 → 取文本 → 官方解析 → 主窗面板与歌词窗共用同一份行
  //
  // R41：取词时把**曲目元信息**（标题/艺人/时长）一并交上去——那是第三方回退做严格匹配要用的
  // 三个值，就在渲染层手里这份曲目投影里（不必让 sidecar 再问一次曲目接口）。
  useEffect(() => {
    let alive = true
    void (async () => {
      if (trackQuery === null) {
        runtime.player.setLyrics([], LYRICS_STATUS.unavailable)
        await bridge.pushDocument({ lines: [], status: LYRICS_STATUS.unavailable })
        return
      }
      // 同 id 元信息更新也清掉旧匹配，进度帧不参与请求依赖。
      runtime.player.setLyrics([], LYRICS_STATUS.loading)
      await bridge.pushDocument({ lines: [], status: LYRICS_STATUS.loading })
      if (!alive) return

      const result = await bridge.loadLyrics(trackQuery)
      if (!alive) return
      runtime.player.setLyrics(result.lines, result.status)
      await bridge.pushDocument({ lines: result.lines, status: result.status })
      if (result.status === LYRICS_STATUS.unavailable || result.status === LYRICS_STATUS.failed) {
        log(`歌词未能取得（${result.status}）：曲目 ${trackQuery.trackId}`)
      }
    })().catch((cause) => log("歌词数据链失败（不影响播放）：", cause))
    return () => {
      alive = false
    }
  }, [bridge, runtime, trackQuery])

  // 4. 进度泵：跟播放器通知推送，不用 rAF（主窗最小化/被遮挡时帧循环会停），也不按 visible 掐断。
  useEffect(
    () =>
      createProgressPump({
        subscribe: runtime.player.subscribe,
        readState: runtime.player.snapshot,
        push: (progress: { timeMs: number; playing: boolean; seekGeneration: number }) =>
          void bridge.pushProgress(progress),
      }),
    [bridge, runtime],
  )

  /**
   * 开关：`setVisible` / `toggleVisible` 都只经过意图机（唯一主人），不各自发 IPC。
   *
   * `toggleVisible` 在这里用**意图机的待定目标**取反，而不是读渲染闭包里的 `on`：
   * 同一任务里的第二次点击拿到的渲染状态还是第一次之前那一份（React 还没重渲染），
   * 按它取反就会把同一个 `true` 再发一遍（brief 明确要修的那件事）。
   */
  /**
   * 开关：`setVisible` / `toggleVisible` 都只经过意图机（唯一主人），不各自发 IPC。
   *
   * `toggleVisible` 的"当前状态"读的是**意图机自己的 pending**（同步、权威），不是渲染闭包里的
   * `toggleState.pending`：同一个任务里连点两次时，React 还没把第一次的状态渲染回来，
   * 读渲染值会拿到旧的那一份，于是第二次又把同一个 `true` 发出去（浏览器守卫抓到的正是这个）。
   */
  const setVisible = useCallback((next: boolean) => {
    void intent.request(next)
  }, [intent])

  const toggleVisible = useCallback((surface?: LyricsToggleSurface) => {
    const { pending } = intent.snapshot()
    const current = pending ?? statusRef.current.requestedVisible ?? statusRef.current.visible
    void intent.request(!current, surface ?? null)
  }, [intent])

  const selectTarget = useCallback((target: "off" | "desktop" | "taskbar", surface?: LyricsToggleSurface) => {
    const { pending } = intent.snapshot()
    const on = (pending ?? statusRef.current.requestedVisible ?? statusRef.current.visible) === true
    const plan = lyricsTargetPlan(on, statusRef.current.config?.mode, target)
    void (async () => {
      if (plan.mode !== null) await bridge.applyConfig({ mode: plan.mode })
      if (plan.visible !== null) await intent.request(plan.visible, surface ?? null)
    })().catch((cause: unknown) => log("歌词显示目标没能切换：", cause))
  }, [bridge, intent])

  const retryToggle = useCallback(() => {
    void intent.retry()
  }, [intent])

  const dismissToggleError = useCallback(() => {
    intent.dismiss()
  }, [intent])

  const updateConfig = useCallback((patch: Partial<typeof DEFAULT_LYRICS_CONFIG>) => {
    void bridge.applyConfig(patch).catch((cause: unknown) => log("歌词窗配置没能应用：", cause))
  }, [bridge])

  const retrySave = useCallback(() => {
    void bridge.retrySave().catch((cause: unknown) => log("歌词配置保存重试失败：", cause))
  }, [bridge])

  /**
   * 导入一份本地歌词文件（R41）：桥里解码 + 官方解析 + 落盘，成功之后**立刻**把这一份推给
   * 主窗面板与桌面歌词窗（同一份行数组，两处不可能显示两首歌）。
   *
   * **失败不动歌词**（R41a）：失败的事实是"这首歌的歌词没变"，所以既不 `setLyrics` 也不
   * `pushDocument`——推进一份空文档会让面板从"有词"跳成"这首歌没有歌词"，那是把事实看反了
   * （用户只是选错了文件）。失败只回一句人话，界面照旧显示原来那一份。
   * 判据与文案在纯函数 `importPlanOf` 里（`features/lyrics/lyrics-window.mjs`），有单测。
   */
  const importFile = useCallback(
    async (file: unknown) => {
      if (trackId === null) return { ok: false, message: "没有正在播放的曲目：先播一首，再导入歌词。" }
      const plan = importPlanOf(await bridge.importLyrics({ trackId, file }))
      if (!plan.ok) {
        log(`本地歌词导入失败（歌词没变，面板与歌词窗都停在原来那一份上）：${plan.message}`)
        return { ok: false, message: plan.message }
      }
      runtime.player.setLyrics(plan.lines, plan.status)
      await bridge.pushDocument({ lines: plan.lines, status: plan.status })
      return { ok: true, message: plan.message }
    },
    [bridge, runtime, trackId],
  )

  return useMemo(
    () => ({
      config,
      visible,
      // 待定目标优先于宿主的 requestedVisible：点下去那一刻按钮就该翻过去
      requestedVisible: toggleState.pending ?? requestedVisible,
      taskbar,
      setVisible,
      toggleVisible,
      selectTarget,
      toggleError: toggleState.error,
      toggleErrorSurface: (toggleState.surface as LyricsToggleSurface | null) ?? null,
      retryToggle,
      dismissToggleError,
      updateConfig,
      saveError,
      retrySave,
      canImport: trackId !== null,
      importFile,
    }),
    [
      config,
      visible,
      toggleState.pending,
      toggleState.error,
      toggleState.surface,
      requestedVisible,
      taskbar,
      setVisible,
      toggleVisible,
      selectTarget,
      retryToggle,
      dismissToggleError,
      updateConfig,
      saveError,
      retrySave,
      trackId,
      importFile,
    ],
  )
}
