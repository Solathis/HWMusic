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
 *
 * **不在这里重推歌词文档**（R41a）：宿主每次显示歌词窗都会重新加载它的页面，而"补一份当前
 * 文档"这件事必须发生在**新页面订阅之后**——那是 Rust 侧的时刻（`on_page_load(Finished)` 的
 * `replay_document`，见 `src-tauri/src/lyrics_window.rs`），这里推的任何一次都太早。见下面第 5 段。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getLyricsBridge } from "./features/lyrics/lyrics-bridge.mjs"
import {
  DEFAULT_LYRICS_CONFIG,
  LYRICS_STATUS,
  importPlanOf,
  normalizeLyricsConfig,
  progressOf,
} from "./features/lyrics/lyrics-window.mjs"
import { trackArtistsOrNull, trackDurationOf, trackNameOrNull } from "./features/library/track-fields.mjs"
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

/**
 * 曲目 + id → `playback:lyrics` 的查询形状（R41）。
 *
 * 元信息一律走 `track-fields.mjs` 的 **`…OrNull`** 那几个（**取不到就是 null**）：
 * 界面上的兜底文案（"未知歌曲"/"未知歌手"）**绝不能进匹配器**——把"未知歌手"当成艺人去匹配，
 * 等于给第三方库一个假信号，而匹配器是"宁可不显示"的那一侧。
 */
function trackQueryOf(trackId: string, track: unknown) {
  return {
    trackId,
    title: trackNameOrNull(track),
    artist: trackArtistsOrNull(track),
    durationSeconds: trackDurationOf(track),
  }
}

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
  //
  // R41：取词时把**曲目元信息**（标题/艺人/时长）一并交上去——那是第三方回退做严格匹配要用的
  // 三个值，就在渲染层手里这份曲目投影里（不必让 sidecar 再问一次曲目接口）。
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

      const result = await bridge.loadLyrics(trackQueryOf(trackId, stateRef.current.track))
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

  // 5. 窗口刚打开时**不**在这里重推文档（R41a 删掉的那一次）。
  //
  // R41 曾在这里补过一次推（`visible` 从 false 变 true 时 `pushDocument`），理由是"宿主每次显示
  // 都会重新加载歌词窗的页面，重载后页面回到初始态"。方向没错，**时机必然太早**：`reload()` 是
  // 异步的，等这条命令的回执回到主窗时，新页面还在加载——文档落在新页 `listen()` 之前，
  // 之后再没有任何补发路径，用户看到的是占位文案，直到换歌（R41a 审查的 1/8）。
  //
  // 现在这件事由**知道页面何时就绪**的那一侧做：Rust 在 `core_lyrics_document` 里留一份最后
  // 发出去的文档，页面加载完成（`on_page_load(Finished)`）时重发（`src-tauri/src/lyrics_window.rs`
  // 的 `replay_document`）。留在这里的那次重推在任何时序下都不落在可用的那一刻，只会让人以为
  // 它在起作用，所以删掉——**不是**把它挪到别处再来一次。

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
    () => ({ config, visible, setVisible, updateConfig, canImport: trackId !== null, importFile }),
    [config, visible, setVisible, updateConfig, trackId, importFile],
  )
}
