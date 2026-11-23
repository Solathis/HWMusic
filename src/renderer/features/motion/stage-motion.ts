import type { TargetAndTransition, Transition } from "framer-motion"

type StageLayer = "background" | "controls" | "lyrics" | "chrome"

const layers = {
  background: { y: 0, scale: 1, enter: 0.5, exit: 0.42, delay: 0 },
  controls: { y: 24, scale: 1, enter: 0.46, exit: 0.28, delay: 0.025 },
  lyrics: { y: 36, scale: 1, enter: 0.5, exit: 0.32, delay: 0.045 },
  chrome: { y: -8, scale: 1, enter: 0.32, exit: 0.22, delay: 0.08 },
}

export function stageLayerMotion(part: StageLayer, open: boolean, reducedMotion: boolean): TargetAndTransition {
  const layer = layers[part]
  return {
    opacity: open ? 1 : 0,
    y: open || reducedMotion ? 0 : layer.y,
    scale: open || reducedMotion ? 1 : layer.scale,
    transition: {
      type: "tween",
      duration: reducedMotion ? 0 : open ? layer.enter : layer.exit,
      delay: open && !reducedMotion ? layer.delay : 0,
      ease: open ? [0.22, 1, 0.36, 1] : [0.32, 0, 0.2, 1],
    },
  }
}

export function stageCoverTransition(phase: "open" | "close", reducedMotion: boolean): Transition {
  return {
    type: "tween",
    duration: reducedMotion ? 0 : phase === "open" ? 0.5 : 0.3,
    ease: phase === "open" ? [0.22, 1, 0.36, 1] : [0.32, 0, 0.2, 1],
  }
}
