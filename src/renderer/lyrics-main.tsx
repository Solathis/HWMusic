// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { LyricsWindow } from "./LyricsWindow.tsx"

const container = document.getElementById("root")

if (!container) {
  throw new Error("歌词窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <LyricsWindow />
  </StrictMode>
)
