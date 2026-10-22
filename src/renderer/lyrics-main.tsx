// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → full → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "@applemusic-like-lyrics/react-full/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { themeFromSearch } from "./features/lyrics/lyrics-window.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"
import { LyricsWindow } from "./LyricsWindow.tsx"

/**
 * 歌词窗的**主题初值**（R41）：建窗时由 Rust 拼进查询串（`lyrics_window_url`）。
 *
 * 为什么不照主窗那样 `installThemeSync()`：那条路要经 `core_login_chrome({action:"theme"})`
 * **读一次**当前档位，而那条命令的来源守卫只放行主窗与两个浮动控件——歌词窗调不动它，
 * 也不该为了一个主题值被放进去（同一条命令还带 `action:"return"` = 取消登录）。
 * 查询串提供初值；宿主订阅就绪后由主窗补发当前主题，避免重开还用建窗时的旧查询串。
 *
 * 不 await 任何东西：主题类要在第一帧之前落地，否则会先按浅色画一帧再翻黑。
 */
applyThemeChoice(document.documentElement, themeFromSearch(window.location.search))

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsWindow />
  </StrictMode>
)
