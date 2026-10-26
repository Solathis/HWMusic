// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → full → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "@applemusic-like-lyrics/react-full/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { App } from "./App.tsx"
import { installContextMenuGuard } from "./features/shell/context-menu-guard.mjs"
import { installDesktopBridge } from "./host-api"
import { installThemeSync } from "./theme-sync"

document.title = APP_BRAND_LABEL

// 右键：吃掉网页默认菜单（可编辑元素保留原生编辑菜单），行上的专属菜单由 ContextMenu 弹
installContextMenuGuard()

// 宿主桥必须在渲染第一帧之前就位：门禁的订阅与 core_call 都走它。
// （`rendererReady()` 由 useAuthGate 在**订阅之后**调用：Rust 侧的启动期广播是排队等冲刷的。）
installDesktopBridge()

// 主题（R25）：主题档位存在 Rust 侧，这里挂上"订阅 theme:changed + 应用一次当前档位"。
// 不 await：第一帧按系统档画（R10 起的既有行为），拿到回执后立刻补上强制档位。
void installThemeSync()

const container = document.getElementById("root")

if (!container) {
  throw new Error("主窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
