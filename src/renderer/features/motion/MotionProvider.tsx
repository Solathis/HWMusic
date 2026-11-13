import { createContext, useCallback, useContext, useInsertionEffect, useMemo, useSyncExternalStore } from "react"
import type { ReactNode } from "react"
import { MotionConfig } from "framer-motion"
import type { Transition } from "framer-motion"
import { motionCssVariables, resolveMotionTransition } from "./tokens.mjs"
import type { MotionKind } from "./tokens.mjs"

const readReduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches
const readVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden"
const subscribeReduced = (notify: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {}
  const query = window.matchMedia("(prefers-reduced-motion: reduce)")
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}
const subscribeVisible = (notify: () => void) => {
  if (typeof document === "undefined") return () => {}
  document.addEventListener("visibilitychange", notify)
  return () => document.removeEventListener("visibilitychange", notify)
}
interface MotionPolicy {
  reducedMotion: boolean
  decorationsActive: boolean
  transitionFor: (kind: MotionKind) => Transition
}
const MotionContext = createContext<MotionPolicy>({
  reducedMotion: false, decorationsActive: true,
  transitionFor: (kind) => resolveMotionTransition(kind, false),
})
export const useMotionPolicy = () => useContext(MotionContext)

export function MotionProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useSyncExternalStore(subscribeReduced, readReduced, () => false)
  const visible = useSyncExternalStore(subscribeVisible, readVisible, () => true)
  const transitionFor = useCallback((kind: MotionKind) => resolveMotionTransition(kind, reducedMotion), [reducedMotion])
  const policy = useMemo(() => ({ reducedMotion, decorationsActive: visible && !reducedMotion, transitionFor }),
    [reducedMotion, visible, transitionFor])
  useInsertionEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const variables = motionCssVariables()
    const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, root.style.getPropertyValue(name)]))
    const previousMode = root.getAttribute("data-motion")
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
    root.dataset.motion = reducedMotion ? "reduced" : "full"
    return () => {
      for (const [name, value] of Object.entries(previous)) value ? root.style.setProperty(name, value) : root.style.removeProperty(name)
      previousMode === null ? root.removeAttribute("data-motion") : root.setAttribute("data-motion", previousMode)
    }
  }, [reducedMotion])
  return <MotionContext.Provider value={policy}>
    <MotionConfig reducedMotion={reducedMotion ? "always" : "never"}>{children}</MotionConfig>
  </MotionContext.Provider>
}
