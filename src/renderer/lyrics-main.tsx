// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → full → amll-theme.css → styles.css
// 竖版自渲染组件只在这扇窗里出现，它的样式追加在最后。
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
import { LyricsWindow } from "./LyricsWindow.tsx"

/** 歌词窗的主题初值：建窗时由 Rust 拼进查询串，订阅就绪后由主窗补发当前主题；不 await 任何东西，主题类要在第一帧之前落地。 */
applyThemeChoice(document.documentElement, themeFromSearch(window.location.search))

// 右键：吃掉网页默认菜单（这扇窗没有输入框，等于一律拦掉）
installContextMenuGuard()

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsWindow />
  </StrictMode>
)
