import { useEffect, useRef } from "react"
import { motion } from "framer-motion"
import { useMotionPolicy } from "./MotionProvider"
import { MOTION_MS } from "./tokens.mjs"

export type Rect = { x: number; y: number; width: number; height: number }
export type CoverFlightRequest = {
  id: number; phase: "open" | "close"; src: string; from: Rect; to: Rect
  fromRadius?: number; toRadius?: number
}
export function CoverFlight({ request, onComplete }: {
  request: CoverFlightRequest | null; onComplete: (id: number) => void
}) {
  const base = useRef<Rect | null>(null)
  const { reducedMotion, transitionFor } = useMotionPolicy()
  useEffect(() => {
    if (!request) { base.current = null; return }
    const timer = window.setTimeout(() => onComplete(request.id), reducedMotion ? 0 : MOTION_MS.settleLimit)
    return () => window.clearTimeout(timer)
  }, [request, reducedMotion, onComplete])
  if (!request || reducedMotion) return null
  if (!base.current) base.current = request.from
  const origin = base.current
  const sx = request.to.width / origin.width
  const sy = request.to.height / origin.height
  return <motion.img src={request.src} alt="" aria-hidden="true" data-testid="cover-flight"
    data-motion-owner="js" className="pointer-events-none fixed left-0 top-0 z-50 origin-top-left object-cover"
    initial={{ x: request.from.x, y: request.from.y, width: origin.width, height: origin.height,
      scaleX: request.from.width / origin.width, scaleY: request.from.height / origin.height,
      borderRadius: request.fromRadius ?? 8 }}
    animate={{ x: request.to.x, y: request.to.y, scaleX: sx, scaleY: sy,
      borderRadius: (request.toRadius ?? 12) / Math.max(sx, sy) }}
    transition={transitionFor(request.phase === "open" ? "cover" : "stageExit")}
    onError={() => onComplete(request.id)}
    onAnimationComplete={(definition) => {
      if (typeof definition === "object" && !Array.isArray(definition) && definition.x === request.to.x && definition.y === request.to.y) onComplete(request.id)
    }} />
}
