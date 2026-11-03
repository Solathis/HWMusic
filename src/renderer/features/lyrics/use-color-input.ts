/** 取色器的「边拖边改色」接线（气泡与任务栏卡共用）：`input` 节流写配置，只有原生 `change` / 失焦才收尾，输入框非受控且被操作时不同步。 */
import { useCallback, useEffect, useRef, useState } from "react"

import { isCustomColor } from "./lyrics-window.mjs"

/** 拖动时的最小写入间隔（毫秒）：够跟手，也不至于每一帧都发一条命令。 */
export const COLOR_COMMIT_INTERVAL_MS = 80

export type ColorInput = {
  /** 挂到 `<input type="color">` 的 `ref` 上：外部色值同步与原生 `change` 都认这个节点。 */
  inputRef: (node: HTMLInputElement | null) => void
  /** `onInput`：拖动中实时改色（节流）。 */
  push: (raw: string) => void
  /** `onBlur`：最后一次值立即落地；不带参数时冲刷还没落地的那一次。 */
  flush: (raw?: string) => void
}

/** `value` 是外部色值（自定义色或主题色），`onPick` 把它写进配置，`onDone` 在原生 `change` 之后收尾。 */
export function useColorInput(
  value: string,
  onPick: (value: string) => void,
  onDone?: () => void,
): ColorInput {
  const [node, setNode] = useState<HTMLInputElement | null>(null)
  const pickRef = useRef(onPick)
  const doneRef = useRef(onDone)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const lastWriteRef = useRef(0)

  // 写配置 / 收尾的回调每次渲染都是新的（闭包里带着最新配置）：定时器尾巴与原生监听都用最新那份
  useEffect(() => {
    pickRef.current = onPick
    doneRef.current = onDone
  }, [onPick, onDone])

  const cancel = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const flush = useCallback((raw?: string) => {
    const next = raw ?? pendingRef.current
    cancel()
    pendingRef.current = null
    if (next === null || !isCustomColor(next)) return
    lastWriteRef.current = performance.now()
    pickRef.current(next)
  }, [cancel])

  const push = useCallback((raw: string) => {
    if (!isCustomColor(raw)) return
    pendingRef.current = raw
    // 已经排了尾巴就等它：拖动期间的写入次数只由间隔决定
    if (timerRef.current !== undefined) return
    const wait = COLOR_COMMIT_INTERVAL_MS - (performance.now() - lastWriteRef.current)
    if (wait <= 0) {
      flush(raw)
      return
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      flush()
    }, wait)
  }, [flush])

  // 卸载：还没落地的那一次直接丢（没有组件再关心它了）
  useEffect(() => cancel, [cancel])

  // 原生 `change`（系统取色器确认那一下）→ 立刻冲刷，再告诉调用方"这次取色结束了"
  useEffect(() => {
    if (node === null) return undefined
    const onCommit = () => {
      flush(node.value)
      doneRef.current?.()
    }
    node.addEventListener("change", onCommit)
    return () => node.removeEventListener("change", onCommit)
  }, [node, flush])

  // 外部色值变化 → 写回 DOM；输入框正在被操作时不碰它（那颗色块正被系统取色器拿着）
  useEffect(() => {
    if (node === null || value === "" || document.activeElement === node) return
    if (node.value !== value) node.value = value
  }, [node, value])

  return { inputRef: setNode, push, flush }
}
