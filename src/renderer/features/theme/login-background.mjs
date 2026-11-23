const DARK_PALETTE = Object.freeze({
  glowColor: "#8b5cf6",
  lineColor: "#dfd1fc",
  secondaryColor: "#6f4ac5",
  lightMode: false,
});

const LIGHT_PALETTE = Object.freeze({
  glowColor: "#5b3a9e",
  lineColor: "#45316f",
  secondaryColor: "#116b73",
  lightMode: true,
});

export function loginBackgroundPaletteOf({ dark = false, light = false, prefersDark = false } = {}) {
  if (dark) return DARK_PALETTE;
  if (light) return LIGHT_PALETTE;
  return prefersDark ? DARK_PALETTE : LIGHT_PALETTE;
}
