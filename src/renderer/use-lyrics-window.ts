/** 主窗观察单例歌词桥的权威配置/保存状态，并转发唯一播放器的文档与进度。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getLyricsBridge } from "./features/lyrics/lyrics-bridge.mjs"
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_STATUS,
  importPlanOf,
  progressOf,
} from "./features/lyrics/lyrics-window.mjs"
import { trackArtistsOrNull, trackDurationOf, trackNameOrNull } from "./features/library/track-fields.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

export interface LyricsWindowBinding {
  /** Rust 运行权威配置的投影，持久化由单例桥代理。 */
  config: typeof DEFAULT_LYRICS_CONFIG
  /** 歌词窗此刻是不是开着（宿主回执里的观测值，不是"我们请求它开着"）。 */
  visible: boolean
  requestedVisible?: boolean
  runtimeRevision?: number
  taskbar?: { supported: boolean; attached: boolean; reason: string }
  /** 开/关桌面歌词窗。 */
  setVisible: (next: boolean) => void
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

  /** 播放状态的最新值：rAF 进度泵读它（不把状态放进 effect 依赖，否则每帧重订阅）。 */
  const stateRef = useRef(state)
  stateRef.current = state

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

  // 4. 进度泵：rAF 每帧读状态机；该不该出 IPC 由桥里的纯函数决定
  //    （推失败在桥里吞掉并留一行 warn：进度是"下一帧还会再来"的东西，不该打断用户）
  //
  // **只在窗真的开着时跑**：窗藏起来之后没人看进度，而 10 次/秒的 IPC 是白烧的
  // （`visible` 来自宿主的回执，不是"我们请求它开着"）。
  useEffect(() => {
    if (!visible) return undefined
    let handle = 0
    const tick = () => {
      void bridge.pushProgress(progressOf(stateRef.current))
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [bridge, visible])

  const setVisible = useCallback((next: boolean) => {
    void bridge.setVisible(next).catch((cause: unknown) => log("桌面歌词开关失败：", cause))
  }, [bridge])

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
    () => ({ config, visible, requestedVisible, taskbar, setVisible, updateConfig, saveError, retrySave, canImport: trackId !== null, importFile }),
    [config, visible, requestedVisible, taskbar, setVisible, updateConfig, saveError, retrySave, trackId, importFile],
  )
}
