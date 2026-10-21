// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { THEME_CHANGED } from "../shared/channels.ts"
import { themeFromSearch } from "./features/lyrics/lyrics-window.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"
import { onCoreEvent } from "./host-api"
import { LyricsWindow } from "./LyricsWindow.tsx"

/**
 * 歌词窗的**主题初值**（R41）：建窗时由 Rust 拼进查询串（`lyrics_window_url`）。
 *
 * 为什么不照主窗那样 `installThemeSync()`：那条路要经 `core_login_chrome({action:"theme"})`
 * **读一次**当前档位，而那条命令的来源守卫只放行主窗与两个浮动控件——歌词窗调不动它，
 * 也不该为了一个主题值被放进去（同一条命令还带 `action:"return"` = 取消登录）。
 * 查询串同步到位（第一帧就对）+ 广播跟变化，两条路都不需要新权限。
 *
 * 不 await 任何东西：主题类要在第一帧之前落地，否则会先按浅色画一帧再翻黑。
 */
applyThemeChoice(document.documentElement, themeFromSearch(window.location.search))

// 之后的变化（用户在设置页/浮动控件里改档位）：`theme:changed` 是**广播**，订阅不需要权限。
// 失败只留一行 warn——主题没跟上不该让歌词窗整个坏掉（与主窗 theme-sync 的克制一致）。
void onCoreEvent<{ theme?: string }>(THEME_CHANGED, (payload) => {
  applyThemeChoice(document.documentElement, payload?.theme)
}).catch((cause) => {
  console.warn("[hwmusic-lyrics] 主题订阅失败（按查询串里那一档显示）：", cause)
})

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsWindow />
  </StrictMode>
)
