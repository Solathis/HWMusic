// CSS 引入顺序契约（三个入口逐字一致）：AMLL core → full → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "@applemusic-like-lyrics/react-full/style.css"
import "./amll-theme.css"
import "./styles.css"
import "./vertical-lyrics.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { themeFromSearch } from "./features/lyrics/lyrics-window.mjs"
import { installContextMenuGuard } from "./features/shell/context-menu-guard.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"
import { LyricsSettingsPopup } from "./LyricsSettingsPopup.tsx"

/** 歌词设置弹出窗的主题初值：建窗时由 Rust 拼进查询串，之后的变化由 theme:changed 广播补上；不 await，主题类要在第一帧之前落地。 */
applyThemeChoice(document.documentElement, themeFromSearch(window.location.search))

// 右键：吃掉网页默认菜单（弹出窗里没有输入框，等于一律拦掉）
installContextMenuGuard()

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词设置弹出窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsSettingsPopup />
  </StrictMode>
)
