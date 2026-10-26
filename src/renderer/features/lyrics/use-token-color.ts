/**
 * 令牌颜色跟着主题走。
 *
 * 主题是 `<html>` 上的类（跟随系统时没有类），换主题不经过 React——所以这里自己盯住那两处变化
 * （类名/系统配色偏好）再重算一次，取色器才不会停在旧主题的颜色上。
 */
import { useEffect, useState } from "react"

import { readTokenColorHex } from "./lyrics-color.mjs"

/** 令牌 id → 当前主题下的 `#rrggbb`（读不到回 `null`）。 */
export function useTokenColorHex(token: string): string | null {
  const [hex, setHex] = useState<string | null>(() => readTokenColorHex(token))
  useEffect(() => {
    const update = () => setHex(readTokenColorHex(token))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", update)
    return () => {
      observer.disconnect()
      media.removeEventListener("change", update)
    }
  }, [token])
  return hex
}
