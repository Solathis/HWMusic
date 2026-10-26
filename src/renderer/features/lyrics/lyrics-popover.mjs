/**
 * 桌面歌词设置气泡（R60）的**页面侧几何**：面板窗口里怎么摆、隐形触发点摆在哪。
 *
 * 分工：面板位置/尺寸/窗口矩形由 Rust 算（`lyrics_settings.rs` 的 `bubble_placement`），它只回报
 * `{ side, arrow, pad }`（CSS 像素）。页面这一侧唯一要做的是把**隐形触发点**放在箭头该指向的位置——
 * radix 把浮层贴着触发点摆、箭头对准触发点的中心，于是"箭头指着齿轮"只由这一个点决定。
 *
 * 触发点宽度 = 2×箭头偏移：`align="start"` 让面板左边缘对齐触发点的左边缘，而箭头对准触发点中心，
 * 两者相差正好一半宽度（面板左边缘在窗口留边处，见 `bubbleAnchorBox`）。
 */

/** 窗口四周留的一圈（DIP，阴影与箭头都在这一圈里）。必须与 Rust 的 `SETTINGS_POPUP_PAD_DIP` 相等。 */
export const POPOVER_PAD_DIP = 14

/**
 * 官方箭头元素的边长（DIP，即 `size-2.5`）。
 *
 * radix 在主轴上加的是 `sideOffset + 箭头高度`，所以面板要贴回留边内侧就得把它减回来
 * （`sideOffset={-POPOVER_ARROW_DIP}`），箭头正好探进那一圈留边里。
 */
export const POPOVER_ARROW_DIP = 10

/** 面板宽度（DIP）：页面与 Rust 的默认值口径，真实宽度仍以量到的为准。 */
export const POPOVER_WIDTH_DIP = 336

/** 气泡的两个方向（与 Rust `BubbleSide` 的字符串一致）。 */
export const BUBBLE_SIDES = ["bottom", "top"]

/** 没有任何几何信息的第一帧用的默认值：面板下方、箭头居中。 */
export function defaultBubbleGeometry(panelWidth = POPOVER_WIDTH_DIP) {
  const width = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : POPOVER_WIDTH_DIP
  return { side: "bottom", arrow: width / 2, pad: POPOVER_PAD_DIP }
}

/**
 * 宿主回执 → 可用的几何；坏值（缺字段/非有限/箭头跑到面板外）回 `null`。
 *
 * `null` 时调用方退回 `defaultBubbleGeometry`：宁可箭头居中，也不要拿坏数把面板摆到窗口外面。
 */
export function normalizeBubbleGeometry(payload, panelWidth = POPOVER_WIDTH_DIP) {
  if (payload === null || typeof payload !== "object") return null
  const side = payload.side
  const arrow = payload.arrow
  const pad = payload.pad
  if (!BUBBLE_SIDES.includes(side)) return null
  if (typeof arrow !== "number" || !Number.isFinite(arrow) || arrow <= 0) return null
  if (typeof pad !== "number" || !Number.isFinite(pad) || pad < 0) return null
  const width = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : POPOVER_WIDTH_DIP
  if (arrow > width) return null
  return { side, arrow, pad }
}

/**
 * 隐形触发点的内联几何（`left/top/width`）：左边缘在窗口留边处，宽度是箭头偏移的两倍。
 *
 * `top` 随方向走：面板在下方时触发点就是面板顶边（`side="bottom"` 让面板从触发点往下长），
 * 面板在上方时触发点是面板底边。
 */
export function bubbleAnchorBox({ side, arrow, panelHeight, pad = POPOVER_PAD_DIP }) {
  const height = Number.isFinite(panelHeight) && panelHeight > 0 ? Math.round(panelHeight) : 0
  const offset = Number.isFinite(arrow) && arrow > 0 ? arrow : POPOVER_WIDTH_DIP / 2
  return {
    left: pad,
    top: side === "top" ? pad + height : pad,
    width: Math.max(1, Math.round(offset * 2)),
  }
}
