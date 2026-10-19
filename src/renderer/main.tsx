// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { App } from "./App.tsx"
import { installDesktopBridge } from "./host-api"

document.title = APP_BRAND_LABEL

// 宿主桥必须在渲染第一帧之前就位：门禁的订阅与 core_call 都走它。
// （`rendererReady()` 由 useAuthGate 在**订阅之后**调用：Rust 侧的启动期广播是排队等冲刷的。）
installDesktopBridge()

const container = document.getElementById("root")

if (!container) {
  throw new Error("主窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
