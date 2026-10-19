#!/usr/bin/env node
/**
 * 生成应用图标源：把 Lucide 的 "music" 字形栅格化为 build/icon.png（1024，供 `tauri icon`）
 * 与 build/tray.png（32×32，供托盘 include_bytes!）。只重新着色/缩放，不改字形数据。
 *
 * 幂等：每次运行覆盖三个产物；只读 node_modules，不写入。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const GLYPH_MODULE = "node_modules/lucide-react/dist/esm/icons/music.js"
const LUCIDE_LICENSE = "node_modules/lucide-react/LICENSE"
const BUILD_DIR = path.join(ROOT, "build")

const ICON_SIZE = 1024
const TRAY_SIZE = 32
// 华为红：UI 主题为中性色，图标需要一个可辨识的品牌色
const GLYPH_COLOR = "#cf0a2c"
// Lucide 画布为 24×24，四周留白 2 单位，避免描边贴边被裁切
const CANVAS = 24
const PAD = 2

/** 从 Lucide ESM 模块源码中取出图标节点数组（attr 对象转 JSON 后解析）。 */
async function readIconNodes() {
  const source = await readFile(path.join(ROOT, GLYPH_MODULE), "utf8")
  const body = source.match(/createLucideIcon\(\s*"[^"]+",\s*(\[[\s\S]*?\])\s*\)/)
  if (!body) throw new Error(`${GLYPH_MODULE}: 未找到 createLucideIcon 节点数组`)
  const json = body[1].replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
  const nodes = JSON.parse(json)
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`${GLYPH_MODULE}: 节点数组为空`)
  return nodes
}

function buildSvg(nodes) {
  const shapes = nodes
    .map(([tag, attrs]) => {
      const { key, ...rest } = attrs // key 只用于 React diff，不进 SVG
      const pairs = Object.entries(rest)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ")
      return `  <${tag} ${pairs}/>`
    })
    .join("\n")
  const viewBox = `${-PAD} ${-PAD} ${CANVAS + PAD * 2} ${CANVAS + PAD * 2}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="${viewBox}" fill="none" stroke="${GLYPH_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
${shapes}
</svg>
`
}

async function buildLicenseText() {
  const isc = (await readFile(path.join(ROOT, LUCIDE_LICENSE), "utf8")).trim()
  return `图标归属声明（build/icon.png、build/tray.png）
================================================

本目录下的图标由 Lucide 的 "music" 字形生成：scripts/make-icon.mjs 读取
node_modules/lucide-react/dist/esm/icons/music.js（lucide-react 0.468.0）中的
SVG path/circle 数据，仅重新着色（#cf0a2c）并按尺寸栅格化，未改形状。

Lucide 以 ISC 许可发布，许可全文如下：

${isc}
`
}

async function main() {
  const nodes = await readIconNodes()
  const svg = buildSvg(nodes)
  await mkdir(BUILD_DIR, { recursive: true })

  const iconPath = path.join(BUILD_DIR, "icon.png")
  const trayPath = path.join(BUILD_DIR, "tray.png")
  const licensePath = path.join(BUILD_DIR, "icon.LICENSE.txt")

  const icon = await sharp(Buffer.from(svg)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer()
  const tray = await sharp(Buffer.from(svg)).resize(TRAY_SIZE, TRAY_SIZE).png().toBuffer()
  await writeFile(iconPath, icon)
  await writeFile(trayPath, tray)
  await writeFile(licensePath, await buildLicenseText())

  console.log(`icon:    ${path.relative(ROOT, iconPath)} (${ICON_SIZE}×${ICON_SIZE}, ${icon.length} B)`)
  console.log(`tray:    ${path.relative(ROOT, trayPath)} (${TRAY_SIZE}×${TRAY_SIZE}, ${tray.length} B)`)
  console.log(`license: ${path.relative(ROOT, licensePath)}`)
}

await main()
