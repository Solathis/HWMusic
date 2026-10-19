/**
 * 主窗侧的歌词窗接线（R12）：把"托盘/设置页的意图"与"播放器的歌词数据"接成一条链。
 *
 * 四件事，全在 effect 里（挂载一次，不在每次渲染里重复订阅）：
 * 1. **读回状态**：挂载时用 `core_lyrics_configure` 的空补丁读当前配置与窗可见性
 *    （宿主握着唯一一份会话内配置；渲染层自己记一份就会与窗口实际显示的字号不一致）；
 * 2. **托盘的勾选**：订阅 `lyrics:toggle` 的**目标态** → `core_lyrics_toggle`
 *    （没人订阅 = 托盘那个勾选项点了没反应）；
 * 3. **歌词数据链**：曲目变化 → `playback:lyrics`（新频道）→ 官方解析适配
 *    → `player.setLyrics(...)`（主窗面板）**与** `core_lyrics_document`（歌词窗）**共用同一份行**；
 * 4. **进度**：rAF 读播放状态机 → 桥里的节流（≥100ms 或播放/跳转变化）→ `core_lyrics_progress`。
 *
 * 失败一律不吵用户：命令失败时宿主已经发了 `app:notice`（并把托盘勾选翻回实际状态），
 * 这里只留一行 warn（渲染层不许有 console.log，见 theme-tokens 的扫描）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getLyricsBridge } from "./features/lyrics/lyrics-bridge.mjs"
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_STATUS,
  normalizeLyricsConfig,
  progressOf,
} from "./features/lyrics/lyrics-window.mjs"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import type { PlayerState } from "./features/playback/use-player.ts"

export interface LyricsWindowBinding {
  /** 当前配置（会话内；宿主持有唯一一份，这里只是它的投影）。 */
  config: typeof DEFAULT_LYRICS_CONFIG
  /** 歌词窗此刻是不是开着（宿主回执里的观测值，不是"我们请求它开着"）。 */
  visible: boolean
  /** 开/关桌面歌词窗。 */
  setVisible: (next: boolean) => void
  /** 改配置（字号/颜色/模式/锁定/点透）。 */
  updateConfig: (patch: Partial<typeof DEFAULT_LYRICS_CONFIG>) => void
}

const log = (...parts: unknown[]) => console.warn("[hwmusic-lyrics]", ...parts)

export function useLyricsWindow(runtime: PlayerRuntime, state: PlayerState): LyricsWindowBinding {
  const bridge = getLyricsBridge()
  const [config, setConfig] = useState(() => DEFAULT_LYRICS_CONFIG)
  const [visible, setVisibleState] = useState(false)
  const trackId = state.track?.id ?? null

  /** 播放状态的最新值：rAF 进度泵读它（不把状态放进 effect 依赖，否则每帧重订阅）。 */
  const stateRef = useRef(state)
  stateRef.current = state

  // 1. 读回宿主的会话内配置（空补丁 = 读；宿主侧不广播、不改窗口）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const status = await bridge.readStatus()
        if (!alive) return
        setConfig(status.config)
        setVisibleState(status.visible)
      } catch (cause) {
        log("读取歌词窗配置失败（用默认配置继续）：", cause)
      }
    })()
    return () => {
      alive = false
    }
  }, [bridge])

  // 2. 托盘的"桌面歌词"勾选：目标态 → 命令（命令失败时由宿主提示并翻回勾选）
  useEffect(() => {
    let alive = true
    let stop: (() => void) | null = null
    void (async () => {
      const off = await bridge.subscribeToggle((checked: boolean) => {
        void (async () => {
          try {
            const status = await bridge.setVisible(checked)
            setConfig(status.config)
            setVisibleState(status.visible)
          } catch (cause) {
            // 勾选态由宿主翻回（它才握着 CheckMenuItem），这里只留痕
            log("桌面歌词开关失败（详情见运行日志）：", cause)
          }
        })()
      })
      if (alive) stop = off
      else off()
    })()
    return () => {
      alive = false
      if (stop !== null) stop()
    }
  }, [bridge])

  // 3. 歌词数据链：曲目变化 → 取文本 → 官方解析 → 主窗面板与歌词窗共用同一份行
  useEffect(() => {
    let alive = true
    void (async () => {
      if (trackId === null) {
        runtime.player.setLyrics([], LYRICS_STATUS.unavailable)
        await bridge.pushDocument({ lines: [], status: LYRICS_STATUS.unavailable })
        return
      }
      // 先落"正在取"（并把上一首的行清掉：换歌时留着上一首的歌词只会显示错的人名）
      runtime.player.setLyrics([], LYRICS_STATUS.loading)
      await bridge.pushDocument({ lines: [], status: LYRICS_STATUS.loading })

      const result = await bridge.loadLyrics(trackId)
      if (!alive) return
      runtime.player.setLyrics(result.lines, result.status)
      await bridge.pushDocument({ lines: result.lines, status: result.status })
      if (result.status === LYRICS_STATUS.unavailable || result.status === LYRICS_STATUS.failed) {
        log(`歌词未能取得（${result.status}）：曲目 ${trackId}`)
      }
    })().catch((cause) => log("歌词数据链失败（不影响播放）：", cause))
    return () => {
      alive = false
    }
  }, [bridge, runtime, trackId])

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

  const setVisible = useCallback(
    (next: boolean) => {
      void (async () => {
        try {
          const status = await bridge.setVisible(next)
          setConfig(status.config)
          setVisibleState(status.visible)
        } catch (cause) {
          log("桌面歌词开关失败（详情见运行日志）：", cause)
        }
      })()
    },
    [bridge],
  )

  const updateConfig = useCallback(
    (patch: Partial<typeof DEFAULT_LYRICS_CONFIG>) => {
      // 配置的合并与钳制的**最终判定在 Rust 侧**：这里先按同一份纯逻辑乐观归一（界面立刻响应，
      // 且乐观值也保证合法——认不出的值连界面都进不去），回执回来再以宿主的为准。
      setConfig((current) => normalizeLyricsConfig(patch, current))
      void (async () => {
        try {
          const status = await bridge.applyConfig(patch)
          setConfig(status.config)
          setVisibleState(status.visible)
        } catch (cause) {
          log("歌词窗配置没能应用（详情见运行日志）：", cause)
        }
      })()
    },
    [bridge],
  )

  return useMemo(
    () => ({ config, visible, setVisible, updateConfig }),
    [config, visible, setVisible, updateConfig],
  )
}
