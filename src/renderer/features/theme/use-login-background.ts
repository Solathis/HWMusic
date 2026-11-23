import { useSyncExternalStore } from "react"

import { loginBackgroundPaletteOf } from "./login-background.mjs"

const readPalette = () => loginBackgroundPaletteOf({
  dark: document.documentElement.classList.contains("dark"),
  light: document.documentElement.classList.contains("light"),
  prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
})

function subscribePalette(onChange: () => void) {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {}
  const root = document.documentElement
  const observer = new MutationObserver(onChange)
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  observer.observe(root, { attributes: true, attributeFilter: ["class"] })
  media.addEventListener("change", onChange)
  return () => {
    observer.disconnect()
    media.removeEventListener("change", onChange)
  }
}

export function useLoginBackgroundPalette() {
  return useSyncExternalStore(subscribePalette, readPalette, () => loginBackgroundPaletteOf())
}
