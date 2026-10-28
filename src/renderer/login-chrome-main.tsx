/**
 * 浮动控件的入口：一个页面、两个 kind。
 * CSS 只引 styles.css（设计令牌 + Tailwind）：页面里没有 AMLL 组件，AMLL 主题变量只许出现在 amll-theme.css。
 * 主题同步在渲染第一帧之前装上；installThemeSync 是异步的，这里不 await——第一帧按系统档画，拿到回执后补上强制档位。
 */
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { chromeKindOf } from "../shared/login-chrome.mjs"
import { installContextMenuGuard } from "./features/shell/context-menu-guard.mjs"
import { LoginChrome } from "./login-chrome.tsx"
import { installThemeSync } from "./theme-sync"

const container = document.getElementById("root")

if (!container) {
  throw new Error("浮动控件缺少 #root 挂载点")
}

void installThemeSync()

// 右键：吃掉网页默认菜单（浮动控件上没有输入框，等于一律拦掉）
installContextMenuGuard()

createRoot(container).render(
  <StrictMode>
    <LoginChrome kind={chromeKindOf(window.location.search)} />
  </StrictMode>
)
