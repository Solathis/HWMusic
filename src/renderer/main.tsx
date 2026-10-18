// CSS 引入顺序契约（两个入口逐字一致）：AMLL core → amll-theme.css → styles.css
import "@applemusic-like-lyrics/core/style.css"
import "./amll-theme.css"
import "./styles.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"

/** R1 只做最小挂载：真实页面在 R8 起接入（pages.tsx）。 */
function App() {
  return null
}

document.title = APP_BRAND_LABEL

const container = document.getElementById("root")

if (!container) {
  throw new Error("主窗缺少 #root 挂载点")
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
