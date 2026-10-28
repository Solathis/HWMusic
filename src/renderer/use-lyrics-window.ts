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
  /** 我们请求它开着：待定意图优先，否则用宿主回执里的值（点下去到回执回来之间按钮必须已经翻过去）。 */
  requestedVisible?: boolean
  runtimeRevision?: number
  taskbar?: { supported: boolean; attached: boolean; reason: string }
  /** 开/关桌面歌词窗（设置页的 Switch 与托盘广播走它；目标态由调用方给）。 */
  setVisible: (next: boolean) => void
  /** 切换桌面/任务栏歌词窗；取反由意图机决定而非渲染快照，同一任务里连点两次是开、关两条命令。 */
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
  /** 本地歌词导入是否可用：没有正在播放的曲目时不可用（导入的语义是换掉这首歌的歌词）。 */
  canImport: boolean
  /** 导入一份本地歌词文件：解码、解析、落盘都在桥里，成功后歌词立刻生效；失败时 message 是给用户看的人话。 */
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

  /** 开关的待定意图：pending 是最后一次点击想让它变成什么，error 是失败人话；放在 binding 层让两枚按钮共享同一条意图。 */
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

  // 3. 歌词数据链：曲目变化 → 取文本 → 官方解析 → 主窗面板与歌词窗共用同一份行（取词时带上曲目元信息供严格匹配）。
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

  /** 开关都只经过意图机（唯一主人），不各自发 IPC；取反读意图机的待定目标，不读渲染闭包里的 on。 */
  /** 开关都只经过意图机；toggleVisible 的当前状态读意图机自己的 pending，不读渲染值，否则连点两次会重复发同一个目标。 */
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

  /** 导入本地歌词文件：桥里解码 + 解析 + 落盘，成功后立刻推给主窗面板与歌词窗；失败不动歌词，只回一句人话。 */
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
