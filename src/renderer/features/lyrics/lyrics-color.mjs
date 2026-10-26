/**
 * 设计令牌 → 当前主题下的**真实颜色**（`#rrggbb`）。桌面歌词设置面板与任务栏歌词卡共用这一处。
 *
 * 为什么需要它：`<input type=color>` 显示的是一个具体色值，没有值时浏览器给的是纯黑。歌词未设
 * 自定义色时跟随令牌（`--foreground` 等），深色主题下实际是浅色字——色块必须显示那个真实颜色，
 * 否则用户以为歌词是黑的。
 *
 * 取色的口径：**读令牌在当前主题下的计算值**（`getComputedStyle`，值可能是 oklch 这类写法），
 * 再由纯函数换算成 sRGB 字节。换算不依赖画布，Node 里可以直接单测。
 */
import { LYRICS_COLOR_TOKENS } from "./lyrics-window.mjs"

/**
 * 令牌 id → 设计令牌变量名（与 `amll-theme.css` 的颜色档位逐条对应，单测钉住）。
 *
 * 不认识的 id 落到 `foreground`：与 `colorTokenLabel` 同一条纪律——界面不显示空白。
 */
export const LYRICS_COLOR_VARS = {
  foreground: "--foreground",
  muted: "--muted-foreground",
  primary: "--primary",
  contrast: "--background",
}

/** 令牌 id 对应的设计令牌变量名（认不出按默认档位）。 */
export function colorVarOf(token) {
  return LYRICS_COLOR_VARS[token] ?? LYRICS_COLOR_VARS.foreground
}

/** 支持的颜色写法：sRGB 三元组、oklab、oklch（令牌表用的就是最后一档）。 */
const FUNCTION_COLORS = new Set(["rgb", "rgba", "oklch", "oklab"])

const byteOf = (value) => Math.max(0, Math.min(255, Math.round(value)))
const pairOf = (byte) => byte.toString(16).padStart(2, "0").toLowerCase()
const hexOf = (bytes) => "#" + bytes.map(pairOf).join("")

/** 线性光照 → sRGB 传输函数（规范值，两段式）。 */
function encodeSrgb(linear) {
  const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
  return byteOf(value * 255)
}

/** oklab → sRGB 字节（CSS Color 4 的矩阵；`a`/`b` 为直角坐标）。 */
function oklabBytes(lightness, a, b) {
  const l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(lightness - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

/** 一个分量：数字或百分比（`50%` 按满量程折算）；认不出回 `null`。 */
function numberChannel(text, fullScale) {
  const raw = text.trim()
  if (raw === "" || raw === "none") return raw === "none" ? 0 : null
  const percent = raw.endsWith("%")
  const value = Number(percent ? raw.slice(0, -1) : raw)
  if (!Number.isFinite(value)) return null
  return percent ? (value / 100) * fullScale : value
}

/** `#rgb` / `#rrggbb`（`#rrggbbaa` 取前六位）；坏长度或非十六进制回 `null`。 */
function hexFromDigits(digits) {
  const text = digits.trim()
  if (!/^[0-9a-f]+$/.test(text)) return null
  if (text.length === 3) return hexOf([...text].map((one) => parseInt(one + one, 16)))
  if (text.length !== 6 && text.length !== 8) return null
  return hexOf([0, 2, 4].map((at) => parseInt(text.slice(at, at + 2), 16)))
}

/** `L C h / a` 这类函数写法 → `#rrggbb`；认不出（含半透明）回 `null`。 */
function hexFromFunction(name, body) {
  const [channelsPart, alphaPart] = body.split("/")
  let alpha = alphaPart === undefined ? null : numberChannel(alphaPart, 1)
  const channels = channelsPart.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean)
  // 旧写法把透明度放在第四个逗号分量里（`rgba(r, g, b, a)`）
  if (name === "rgb" && alpha === null && channels.length === 4) alpha = numberChannel(channels.pop(), 1)
  if (alpha !== null && !(alpha > 0.5)) return null
  if (channels.length !== 3) return null
  if (name === "rgb") {
    const bytes = channels.map((one) => numberChannel(one, 255))
    if (bytes.some((byte) => byte === null)) return null
    return hexOf(bytes.map(byteOf))
  }
  const lightness = numberChannel(channels[0], 1)
  const a = numberChannel(channels[1], 0.4)
  const b = numberChannel(channels[2], 0.4)
  if (lightness === null || a === null || b === null) return null
  if (name === "oklch") {
    const angle = (numberChannel(channels[2], 1) ?? 0) * (Math.PI / 180)
    return hexOf(oklabBytes(lightness, a * Math.cos(angle), a * Math.sin(angle)))
  }
  return hexOf(oklabBytes(lightness, a, b))
}

/**
 * CSS 颜色写法 → `#rrggbb`（小写，与 `input.value` 口径一致）；认不出回 `null`（不猜颜色）。
 *
 * 只认令牌与计算值实际会用到的那些写法；`hsl()`、`color-mix()` 之类回 `null`，由调用方决定退路。
 */
export function hexFromCssColor(value) {
  if (typeof value !== "string") return null
  const text = value.trim().toLowerCase()
  if (text === "") return null
  if (text.startsWith("#")) return hexFromDigits(text.slice(1))
  const open = text.indexOf("(")
  if (open <= 0 || !text.endsWith(")")) return null
  const name = text.slice(0, open).trim().replace(/^.*\s/, "")
  if (!FUNCTION_COLORS.has(name)) return null
  return hexFromFunction(name === "rgba" ? "rgb" : name, text.slice(open + 1, -1))
}

/**
 * 令牌 id → `#rrggbb`；`readVariable` 是"读一个设计令牌变量"的注入点（DOM 里就是 `getComputedStyle`）。
 *
 * 读不到/认不出回 `null`——调用方据此保留浏览器默认，而不是编一个颜色出来。
 */
export function resolveTokenColorHex(token, readVariable) {
  if (typeof readVariable !== "function") return null
  try {
    return hexFromCssColor(readVariable(colorVarOf(token)))
  } catch {
    return null
  }
}

/** 浏览器里读一个令牌在当前主题下的真实颜色（`root` 必须挂在主题起作用的那棵树上）。 */
export function readTokenColorHex(token, root = typeof document === "undefined" ? null : document.documentElement) {
  if (root === null || root === undefined) return null
  return resolveTokenColorHex(token, (name) => getComputedStyle(root).getPropertyValue(name))
}

/** 令牌表里所有 id（供测试遍历，与 `LYRICS_COLOR_TOKENS` 同源）。 */
export function colorTokenIds() {
  return LYRICS_COLOR_TOKENS.map((token) => token.id)
}
