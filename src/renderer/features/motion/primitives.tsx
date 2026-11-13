import { createContext, useContext, useLayoutEffect, useRef } from "react"
import type { ComponentProps, ReactNode } from "react"
import { AnimatePresence, motion, useAnimationControls, useIsPresent } from "framer-motion"
import type { HTMLMotionProps } from "framer-motion"
import { Button } from "../../components/ui/button"
import { cn } from "../../lib/utils"
import { useMotionPolicy } from "./MotionProvider"
import type { MotionKind } from "./tokens.mjs"

const AnimatedButton = motion.create(Button)
interface EntryState { entering: boolean; resets: Set<() => void> }
const EntryContext = createContext<EntryState | null>(null)
export function MotionButton(props: ComponentProps<typeof AnimatedButton>) {
  const { reducedMotion, transitionFor } = useMotionPolicy()
  return <AnimatedButton {...props} data-motion-owner="js"
    animate={reducedMotion ? { scale: 1 } : props.animate ?? { scale: 1 }}
    whileTap={props.disabled || reducedMotion ? undefined : { scale: 0.96 }}
    transition={transitionFor("press")} />
}
function SwapItem({ children }: { children: ReactNode }) {
  const present = useIsPresent()
  const { transitionFor } = useMotionPolicy()
  return <motion.span className={cn("[grid-area:1/1]", !present && "pointer-events-none")}
    aria-hidden={!present || undefined} initial={{ opacity: 0, scale: 0.88 }}
    animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.88 }}
    transition={transitionFor("state")}>{children}</motion.span>
}
export function MotionSwap({ identity, children, className }: {
  identity: string | number; children: ReactNode; className?: string
}) {
  const { reducedMotion } = useMotionPolicy()
  if (reducedMotion) return <span className={cn("inline-grid place-items-center", className)}>{children}</span>
  return <span className={cn("inline-grid place-items-center", className)}>
    <AnimatePresence initial={false}><SwapItem key={identity}>{children}</SwapItem></AnimatePresence>
  </span>
}
export function MotionRegion({ identity, kind = "content", active = true, children, className, ...props }:
  Omit<HTMLMotionProps<"div">, "animate" | "initial"> & {
    identity: string | number; kind?: MotionKind; active?: boolean; children: ReactNode
  }) {
  const controls = useAnimationControls()
  const { reducedMotion, transitionFor } = useMotionPolicy()
  const parentEntry = useContext(EntryContext)
  const entry = useRef<EntryState>({ entering: kind === "page" && active && !reducedMotion, resets: new Set() })
  useLayoutEffect(() => {
    if (kind !== "content" || parentEntry === null) return
    const reset = () => { controls.stop(); controls.set({ opacity: 1, y: 0 }) }
    parentEntry.resets.add(reset)
    return () => { parentEntry.resets.delete(reset) }
  }, [kind, parentEntry, controls])
  useLayoutEffect(() => {
    if (kind === "page") {
      entry.current.entering = active && !reducedMotion
      for (const reset of entry.current.resets) reset()
    }
    if (!active || reducedMotion || (kind === "content" && parentEntry?.entering)) {
      controls.stop(); controls.set({ opacity: 1, y: 0 }); return
    }
    controls.set({ opacity: 0, y: kind === "page" ? 12 : 0 })
    let live = true
    const frame = requestAnimationFrame(() => {
      if (!live) return
      void controls.start({ opacity: 1, y: 0, transition: transitionFor(kind) }).then(() => {
        if (live) entry.current.entering = false
      })
    })
    return () => { live = false; cancelAnimationFrame(frame); entry.current.entering = false; controls.stop() }
  }, [identity, kind, active, reducedMotion, transitionFor, controls, parentEntry])
  const instant = !active || reducedMotion || (kind === "content" && parentEntry?.entering)
  const region = <motion.div {...props} className={className}
    initial={instant ? false : { opacity: 0, y: kind === "page" ? 12 : 0 }} animate={controls}>{children}</motion.div>
  return kind === "page" ? <EntryContext.Provider value={entry.current}>{region}</EntryContext.Provider> : region
}
