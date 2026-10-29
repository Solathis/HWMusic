/** 沉浸页的主窗外框：打开时请宿主收起标题栏（只有 Windows 真收），关闭或卸载时装回；请求排队，快速开关不会乱序。 */
import { useCallback, useEffect, useState } from "react"

import { coreMainChrome, type MainChromeAction, type MainChromeState } from "./host-api"

const FRAMED: MainChromeState = { frameless: false, maximized: false }

let queue: Promise<unknown> = Promise.resolve()

function request(action: MainChromeAction): Promise<MainChromeState | undefined> {
  const next = queue.then(() => coreMainChrome(action)).catch(() => undefined)
  queue = next
  return next
}

export function useMainChrome(open: boolean) {
  const [chrome, setChrome] = useState<MainChromeState>(FRAMED)
  useEffect(() => {
    if (!open) return undefined
    let live = true
    let timer: number | undefined
    const accept = (state: MainChromeState | undefined) => { if (live) setChrome(state ?? FRAMED) }
    void request("immersive").then(accept)
    // 最大化 / 还原后窗口尺寸会变：读回实际状态，图标跟着换
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void request("read").then(accept) }, 120)
    }
    window.addEventListener("resize", onResize)
    return () => {
      live = false
      window.clearTimeout(timer)
      window.removeEventListener("resize", onResize)
      setChrome(FRAMED)
      void request("normal")
    }
  }, [open])
  const act = useCallback((action: "minimize" | "toggle-maximize" | "close") => {
    void request(action).then((state) => { if (state) setChrome(state) })
  }, [])
  return { ...chrome, act }
}
