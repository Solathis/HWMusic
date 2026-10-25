/**
 * 播放器歌词外观的**唯一接线**（R50）：启动读一次 `settings:get`，改动写 `settings:set`。
 *
 * 为什么不是"借桌面歌词那份配置"：R45B 起主窗面板吃的是 `lyrics.config.customColor`
 * （Rust 的桌面歌词配置），改桌面颜色就会顺手改掉主窗——两件事被绑成一件。这里让播放器歌词
 * 有自己的**普通 settings 键** `playerLyrics`：它不进 Rust 的 `lyricsWindow` 保留键，
 * 也不经过 `core_lyrics_configure`。
 *
 * 三条纪律：
 * 1. **读一次**（挂载时）：这份配置只影响颜色，读失败就停在默认值（不把"读不到"画成第二种可选项）；
 * 2. **乐观更新**（点了就变）：颜色是即时可感的设置，等一次 IPC 往返会让色板看起来"没反应"；
 * 3. **失败回滚并抛错**：写盘没成功时界面必须回到上一份（否则用户看到的颜色不存在于磁盘上），
 *    错误交给设置页显示——本层只在日志里留一行诊断。
 */
import { useCallback, useEffect, useState } from "react"

import { SETTINGS_GET, SETTINGS_SET } from "../shared/request-channels.ts"
import { coreCall, isCoreError } from "./host-api"
import {
  DEFAULT_PLAYER_LYRICS,
  normalizePlayerLyrics,
  playerLyricsFromSettings,
  playerLyricsPatch,
} from "./features/lyrics/player-lyrics.mjs"

/**
 * 生效中/待写的播放器歌词外观。
 *
 * 形状的**真源**是 `player-lyrics.mjs` 的 `DEFAULT_PLAYER_LYRICS`（归一、读写都在那里）；
 * 这里只把它投影成 TS 类型，避免组件层各写一份字段表。
 */
export type PlayerLyricsConfig = typeof DEFAULT_PLAYER_LYRICS

/** `settings:get` / `settings:set` 的回执形状（R10 起就是这个信封）。 */
interface SettingsAnswer {
  settings: { schemaVersion: number; data: Record<string, unknown> }
}

export interface PlayerLyricsBinding {
  /** 生效中的配置（乐观更新之后就是磁盘上将要有的那一份）。 */
  config: PlayerLyricsConfig
  /**
   * 改配置：先落地到界面，再写 `settings:set`。
   *
   * 失败时回滚并把错误**抛给调用方**（设置页据此显示一句人话）——静默失败会让界面
   * 停在"存不下来的颜色"上，那比报错更糟。
   */
  updateConfig: (patch: Partial<PlayerLyricsConfig>) => Promise<void>
}

const log = (...parts: unknown[]) => console.warn("[hwmusic-player-lyrics]", ...parts)

export function usePlayerLyrics(): PlayerLyricsBinding {
  const [config, setConfig] = useState<PlayerLyricsConfig>(() => ({ ...DEFAULT_PLAYER_LYRICS }))

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const answer = await coreCall<SettingsAnswer>(SETTINGS_GET, null)
        if (alive) setConfig(playerLyricsFromSettings(answer?.settings))
      } catch (cause) {
        // 读不到就停在默认值：颜色没有"读失败"这一档可选项，界面上不该长出一个错误状态
        if (alive) log("播放器歌词颜色读不到（用默认值）：", isCoreError(cause) ? cause.message : cause)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const updateConfig = useCallback(async (patch: Partial<PlayerLyricsConfig>) => {
    const previous = config
    const next = normalizePlayerLyrics({ ...previous, ...patch }, previous)
    setConfig(next)
    try {
      await coreCall<SettingsAnswer>(SETTINGS_SET, { patch: playerLyricsPatch(next) })
    } catch (cause) {
      setConfig(previous)
      log("播放器歌词颜色没能保存（已回滚）：", isCoreError(cause) ? cause.message : cause)
      throw cause
    }
  }, [config])

  return { config, updateConfig }
}
