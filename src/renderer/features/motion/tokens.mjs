/** Shared, dependency-free motion policy. Durations are milliseconds here. */
export const MOTION_MS = Object.freeze({
  press: 120, state: 180, page: 240, content: 180, overlay: 180, overlayExit: 120,
  dialog: 280, dialogExit: 160, sidebar: 280, sheetExit: 200, stage: 420,
  stageExit: 260, theme: 220, settleLimit: 650,
});
export const MOTION_SPRINGS = Object.freeze({
  press: Object.freeze({ stiffness: 520, damping: 30, mass: 0.7 }),
  panel: Object.freeze({ stiffness: 360, damping: 30, mass: 1 }),
  cover: Object.freeze({ stiffness: 280, damping: 28, mass: 1 }),
});
export const MOTION_EASES = Object.freeze({
  enter: [0.22, 1, 0.36, 1], exit: [0.4, 0, 1, 1], move: [0.4, 0, 0.2, 1],
});
/** @typedef {"press"|"state"|"page"|"content"|"overlay"|"overlayExit"|"dialog"|"dialogExit"|"sidebar"|"panel"|"cover"|"sheetExit"|"stageExit"|"theme"} MotionKind */
/** @param {MotionKind} kind @param {boolean} reducedMotion @returns {import("framer-motion").Transition} */
export function resolveMotionTransition(kind, reducedMotion) {
  if (reducedMotion) return { type: "tween", duration: 0 };
  if (Object.hasOwn(MOTION_SPRINGS, kind)) {
    return { type: "spring", ...MOTION_SPRINGS[kind], restDelta: 0.01, restSpeed: 0.1 };
  }
  return {
    type: "tween", duration: (MOTION_MS[kind] ?? MOTION_MS.content) / 1000,
    ease: MOTION_EASES[kind.toLowerCase().includes("exit") ? "exit" : "enter"],
  };
}
/** @returns {Record<string, string>} */
export function motionCssVariables() {
  const variables = {};
  for (const [name, value] of Object.entries(MOTION_MS)) {
    variables["--motion-" + name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())] = value + "ms";
  }
  for (const [name, value] of Object.entries(MOTION_EASES)) {
    variables["--ease-" + name] = "cubic-bezier(" + value.join(",") + ")";
  }
  return variables;
}
