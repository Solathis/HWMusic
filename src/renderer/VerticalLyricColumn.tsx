/**
 * 竖版桌面歌词：一句一列，按演唱进度沿书写方向平移。
 * 判定（当前句/逐字状态/字号/平移量）全在 features/lyrics/vertical-lyrics.mjs；这里只渲染、量布局，
 * 并把平移量写进 CSS 自定义属性（视觉值在 vertical-lyrics.css）。无帧时扫亮仍按进度消息推进。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { LyricLine } from "@applemusic-like-lyrics/lyric"

import {
  karaokeStates,
  karaokeTokens,
  lineProgress,
  nextColumnFits,
  verticalFontPx,
  verticalFollowOffset,
  verticalLinePlan,
  verticalScrollOffset,
} from "./features/lyrics/vertical-lyrics.mjs"
import { cn } from "./lib/utils"

export interface VerticalLyricColumnProps {
  lines: LyricLine[]
  timeMs: number
  /** 关掉逐字高亮时按整句亮（任务栏字段不影响桌面，这里只跟随适配层的粗/细两种输入）。 */
  karaoke: boolean
}

interface TokenBox {
  top: number
  height: number
}

interface Metrics {
  contentHeight: number
  viewportHeight: number
  viewportWidth: number
  fontPx: number
  boxes: TokenBox[]
}

const EMPTY_METRICS: Metrics = { contentHeight: 0, viewportHeight: 0, viewportWidth: 0, fontPx: 0, boxes: [] }

/** 一行歌词的纯文本（词数组拼起来；没有词时给空串）。 */
function lineText(line: LyricLine | null | undefined): string {
  if (line === null || line === undefined || !Array.isArray(line.words)) return ""
  return line.words.map((word) => (typeof word?.word === "string" ? word.word : "")).join("")
}

/** 译文优先，没有译文时退到音译（两者都只作为相邻的第二列）。 */
function secondColumn(line: LyricLine | null | undefined): string | null {
  for (const value of [line?.translatedLyric, line?.romanLyric]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

function sameMetrics(left: Metrics, right: Metrics): boolean {
  if (left.contentHeight !== right.contentHeight || left.viewportHeight !== right.viewportHeight
    || left.viewportWidth !== right.viewportWidth || left.fontPx !== right.fontPx
    || left.boxes.length !== right.boxes.length) return false
  return left.boxes.every((box, index) => box.top === right.boxes[index].top && box.height === right.boxes[index].height)
}

export function VerticalLyricColumn({ lines, timeMs, karaoke }: VerticalLyricColumnProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS)

  const plan: { current: number; next: number } = useMemo(() => verticalLinePlan(lines, timeMs), [lines, timeMs])
  const currentLine = plan.current >= 0 ? lines[plan.current] ?? null : null
  const nextLine = plan.next >= 0 ? lines[plan.next] ?? null : null
  const translation = secondColumn(currentLine)

  /** 渲染用的字素簇；词数组为空时退化成整行一段文本（时间信息缺失就按整句亮）。 */
  const column = useMemo(() => {
    const derived = karaokeTokens(currentLine?.words)
    if (derived.length > 0) return derived
    const text = lineText(currentLine)
    return text.trim() === "" ? [] : [{ text, startTime: null, endTime: null }]
  }, [currentLine])
  const derivedStates: string[] = karaokeStates(currentLine, timeMs, karaoke)
  const lineStart = Number(currentLine?.startTime)
  const states = derivedStates.length === column.length
    ? derivedStates
    : column.map(() => (Number.isFinite(lineStart) && timeMs >= lineStart ? "sung" : "pending"))

  const columns = translation === null ? 1 : 2
  const showNext = nextLine !== null && column.length > 0
    && nextColumnFits({ viewportWidth: metrics.viewportWidth, fontPx: metrics.fontPx, columns })

  /**
   * 量布局：列高与当前句每个字的纵向位置。
   *
   * 用元素矩形差而非 `offsetTop`：竖排下 `offsetTop` 是块轴（横向），量不到书写方向。
   */
  useLayoutEffect(() => {
    const root = viewportRef.current
    const track = trackRef.current
    if (root === null || track === null) return undefined
    const measure = () => {
      const trackRect = track.getBoundingClientRect()
      const boxes = [...track.querySelectorAll<HTMLElement>("[data-vertical-token]")].map((node) => {
        const rect = node.getBoundingClientRect()
        return { top: Math.round(rect.top - trackRect.top), height: Math.round(rect.height) }
      })
      const contentHeight = Math.max(0, ...[...track.children].map((child) => Math.round(child.getBoundingClientRect().height)))
      const next: Metrics = {
        contentHeight,
        viewportHeight: root.clientHeight,
        viewportWidth: root.clientWidth,
        fontPx: Number.parseFloat(getComputedStyle(track).fontSize) || 0,
        boxes,
      }
      setMetrics((previous) => (sameMetrics(previous, next) ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(track)
    return () => observer.disconnect()
  }, [currentLine, column.length, translation, showNext])

  /** 时间驱动的基座位置 + 量出来的字位跟随修正（正在唱的字必须整块在视口里）。 */
  const progress = lineProgress(currentLine, timeMs, plan.next >= 0 ? Number(lines[plan.next]?.startTime) : null)
  const singing = states.indexOf("active")
  const box = singing >= 0 ? metrics.boxes[singing] : undefined
  const base = verticalScrollOffset({
    contentHeight: metrics.contentHeight,
    viewportHeight: metrics.viewportHeight,
    progress,
  })
  const offset = box === undefined ? base : verticalFollowOffset({
    offset: base,
    charTop: box.top,
    charHeight: box.height || verticalFontPx(metrics.viewportWidth),
    contentHeight: metrics.contentHeight,
    viewportHeight: metrics.viewportHeight,
  })

  useLayoutEffect(() => {
    viewportRef.current?.style.setProperty("--vertical-lyric-shift", `${Number(offset.toFixed(1))}px`)
  }, [offset])

  return (
    <div ref={viewportRef} className="vertical-lyric" data-testid="lyrics-vertical" data-vertical-current={plan.current}>
      <div ref={trackRef} className="vertical-lyric__track">
        {currentLine === null ? null : (
          <div className="vertical-lyric__column" data-testid="lyrics-vertical-line">
            {column.map((token, index) => (
              <span
                key={`${index}-${token.text}`}
                data-vertical-token
                className={cn("vertical-lyric__word", `is-${states[index] ?? "pending"}`)}
              >{token.text}</span>
            ))}
          </div>
        )}
        {translation === null ? null : (
          <div className="vertical-lyric__column vertical-lyric__column--translation" data-testid="lyrics-vertical-translation">
            {translation}
          </div>
        )}
        {showNext ? (
          <div className="vertical-lyric__column vertical-lyric__next" data-testid="lyrics-vertical-next">
            {lineText(nextLine)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
