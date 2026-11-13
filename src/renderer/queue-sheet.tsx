import { useLayoutEffect, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { createPortal } from "react-dom"
import { motion } from "framer-motion"
import { XIcon } from "lucide-react"
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "./components/ui/sheet"
import { MotionButton } from "./features/motion/primitives"
import { useMotionPolicy } from "./features/motion/MotionProvider"

type Snapshot = {
  id: number
  clone: HTMLElement
  rect: { x: number; y: number; width: number; height: number }
  scroll: Array<{ node: HTMLElement; top: number; left: number }>
}
const AnimatedContent = motion.create(SheetContent)

/** The exit view is decorative; Radix can release focus and input immediately. */
function snapshotOf(source: HTMLElement, id: number): Snapshot | null {
  const clone = source.cloneNode(true)
  if (!(clone instanceof HTMLElement)) return null
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")]
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")]
  const scroll = originals.flatMap((node, index) => node.scrollTop || node.scrollLeft
    ? [{ node: copies[index], top: node.scrollTop, left: node.scrollLeft }] : [])
  clone.querySelectorAll("script,style,audio,video,iframe").forEach((node) => node.remove())
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    node.removeAttribute("id")
    node.removeAttribute("role")
    node.removeAttribute("data-testid")
    node.removeAttribute("aria-labelledby")
    node.removeAttribute("aria-describedby")
  }
  clone.removeAttribute("data-slot")
  clone.removeAttribute("data-state")
  clone.className = "flex size-full flex-col gap-4 border-l bg-popover text-sm text-popover-foreground shadow-lg"
  clone.removeAttribute("style")
  const { x, y, width, height } = source.getBoundingClientRect()
  return { id, clone, rect: { x, y, width, height }, scroll }
}
function ExitSnapshot({ snapshot, hostRef, onComplete }: {
  snapshot: Snapshot; hostRef: React.RefObject<HTMLDivElement | null>; onComplete: () => void
}) {
  const { transitionFor } = useMotionPolicy()
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren(snapshot.clone)
    for (const item of snapshot.scroll) { item.node.scrollTop = item.top; item.node.scrollLeft = item.left }
    return () => { host.replaceChildren() }
  }, [snapshot, hostRef])
  return <>
    <motion.div className="pointer-events-none fixed inset-0 z-50 bg-overlay" aria-hidden="true"
      initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={transitionFor("overlayExit")} />
    <motion.div ref={hostRef} inert aria-hidden="true" data-testid="queue-exit-snapshot"
      data-motion-owner="js" className="pointer-events-none fixed left-0 top-0 z-50"
      initial={{ ...snapshot.rect, opacity: 1 }} animate={{ x: window.innerWidth + 4, opacity: 0 }}
      transition={transitionFor("sheetExit")} onAnimationComplete={onComplete} />
  </>
}
export function QueueSheet({ children, trigger, open, onOpenChange }: {
  children: ReactNode; trigger: ReactElement; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const { reducedMotion, transitionFor } = useMotionPolicy()
  const contentRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const latestOpen = useRef(open)
  latestOpen.current = open
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [entryX, setEntryX] = useState<number | string>("100%")
  const changeOpen = (next: boolean) => {
    const id = ++generation.current
    if (next) {
      const rect = ghostRef.current?.getBoundingClientRect()
      setEntryX(rect ? Math.max(0, rect.x - (window.innerWidth - rect.width)) : "100%")
      setSnapshot(null)
    } else {
      setSnapshot(!reducedMotion && contentRef.current ? snapshotOf(contentRef.current, id) : null)
    }
    onOpenChange(next)
  }
  useLayoutEffect(() => {
    if (reducedMotion) setSnapshot(null)
  }, [reducedMotion])
  return <>
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      {open ? <AnimatedContent ref={contentRef} side="right" showCloseButton={false}
        data-motion-owner="js" initial={{ x: reducedMotion ? 0 : entryX }}
        animate={{ x: 0 }} transition={transitionFor("panel")}
        onCloseAutoFocus={(event) => { if (latestOpen.current) event.preventDefault() }}>
        {children}
        <SheetClose asChild>
          <MotionButton variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="关闭播放队列">
            <XIcon />
          </MotionButton>
        </SheetClose>
      </AnimatedContent> : null}
    </Sheet>
    {snapshot && !reducedMotion ? createPortal(<ExitSnapshot snapshot={snapshot} hostRef={ghostRef}
      onComplete={() => setSnapshot((current) => current?.id === snapshot.id ? null : current)} />, document.body) : null}
  </>
}
