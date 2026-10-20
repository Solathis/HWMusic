/**
 * 浮动控件的入口（R25）：一个页面、两个 kind。
 *
 * CSS 只引 `styles.css`（设计令牌 + Tailwind）：这个页面里没有 AMLL 组件，
 * 而 AMLL 的主题变量只许出现在 `amll-theme.css`（`test/theme-tokens.test.mjs` 钉住）。
 *
 * 主题同步在**渲染第一帧之前**装上：浮动控件自己也要跟着主题变
 * （用户在第 4 项里要的就是这个控件，它自己停在错的配色上很难看）。
 * `installThemeSync` 是异步的（一次 IPC 往返），这里不 await——第一帧按系统档画，
 * 拿到回执后立刻补上强制档位，与主窗 `main.tsx` 同一条纪律。
 */
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { chromeKindOf } from "../shared/login-chrome.mjs"
import { LoginChrome } from "./login-chrome.tsx"
import { installThemeSync } from "./theme-sync"

const container = document.getElementById("root")

if (!container) {
  throw new Error("浮动控件缺少 #root 挂载点")
}

void installThemeSync()

createRoot(container).render(
  <StrictMode>
    <LoginChrome kind={chromeKindOf(window.location.search)} />
  </StrictMode>
)
