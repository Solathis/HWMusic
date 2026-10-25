// CSS 引入顺序契约（三个入口逐字一致）：AMLL core → full → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "@applemusic-like-lyrics/react-full/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { themeFromSearch } from "./features/lyrics/lyrics-window.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"
import { LyricsSettingsPopup } from "./LyricsSettingsPopup.tsx"

/**
 * 歌词设置弹出窗的主题初值（R51）：与歌词窗同一条路——建窗时由 Rust 拼进查询串
 * （`lyrics_settings::popup_url`），之后的变化由 `theme:changed` 广播补上。
 *
 * 这扇窗只有 `core:event:default` 权限（不读主题那条命令、不碰任何窗口属性），所以查询串
 * 与广播就是它仅有的两个输入。不 await 任何东西：主题类要在第一帧之前落地。
 */
applyThemeChoice(document.documentElement, themeFromSearch(window.location.search))

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词设置弹出窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsSettingsPopup />
  </StrictMode>
)
