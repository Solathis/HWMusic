/**
 * 桌面歌词的设置气泡面板：一扇独立透明窗里放一个 shadcn Popover。
 * 面板必须能长到 800×128 的歌词窗外面去，窗口尺寸/位置由 Rust 按齿轮矩形算，这扇窗没有任何 window 权限。
 * 页面侧三件事：把隐形触发点摆到箭头该指的位置、量面板尺寸报给宿主、Esc 与点面板外面关窗。
 * 开合状态恒为 true：关窗 = 隐藏窗口，翻成 false 会让下次显示出来是一扇空窗。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { LYRICS_STATE, LYRICS_SETTINGS_PRESENTATION, THEME_CHANGED } from "../shared/channels.ts"
import { createPresentationAcceptor } from "./features/motion/presentation.mjs"
import { useMotionPolicy } from "./features/motion/MotionProvider"
import { MOTION_MS, MOTION_EASES } from "./features/motion/tokens.mjs"
import { MotionRegion } from "./features/motion/primitives"
import {
  coreLyricsConfigure,
  coreLyricsSettingsClose,
  coreLyricsSettingsColorPicking,
  coreLyricsSettingsResize,
  onCoreEvent,
} from "./host-api"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import {
  Popover,
  PopoverArrow,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./components/ui/popover"
import { Separator } from "./components/ui/separator"
import { Switch } from "./components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import {
  POPOVER_ARROW_DIP,
  bubbleAnchorBox,
  defaultBubbleGeometry,
  normalizeBubbleGeometry,
} from "./features/lyrics/lyrics-popover.mjs"
import {
  LYRICS_FONT_STEPS,
  fontStepLabel,
  isCustomColor,
  lyricsConfigFromSearch,
  normalizeLyricsConfig,
  saveErrorText,
} from "./features/lyrics/lyrics-window.mjs"
import { useColorInput } from "./features/lyrics/use-color-input.ts"
import { useTokenColorHex } from "./features/lyrics/use-token-color.ts"
import { createThemeAcceptor } from "./features/theme/theme-accept.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"

/** 四个演出效果开关（键来自配置本身，文案是用户看到的那个名字）。 */
const APPEARANCE_SWITCHES = [
  ["enableBlur", "模糊"],
  ["enableScale", "缩放"],
  ["enableSpring", "弹簧动画"],
  ["showControls", "媒体按钮"],
] as const

/** 松手后的宽限（毫秒）：`change` / `blur` 之后这么久内的"外面有动静"仍算在取色（焦点还在往回走）。 */
const PICKING_GRACE_MS = 150

/** 一行"标签 + 控件"。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="shrink-0 text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

export function LyricsSettingsPopup() {
  // 初值来自建窗时拼的查询串（Rust 侧按当前配置拼）：页面还没订阅事件时也不会丢配置
  const [config, setConfig] = useState(() => lyricsConfigFromSearch(window.location.search))
  const [actionError, setActionError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 权威配置读到之前不量尺寸：第一帧就得是用户真正的那份配置。 */
  const [ready, setReady] = useState(false)
  const { reducedMotion } = useMotionPolicy()
  const presentationRef = useRef<ReturnType<typeof createPresentationAcceptor> | null>(null)
  const presentationCount = useRef(0)
  if (presentationRef.current === null) presentationRef.current = createPresentationAcceptor((visible: boolean) => {
    const node = contentRef.current
    if (!node) return
    node.getAnimations().forEach((animation) => animation.cancel())
    if (visible && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.animate([{ opacity: 0, scale: "0.96" }, { opacity: 1, scale: "1" }],
        { duration: MOTION_MS.overlay, easing: "cubic-bezier(" + MOTION_EASES.enter.join(",") + ")" })
      presentationCount.current += 1
      node.dataset.presentationCount = String(presentationCount.current)
    }
  })
  /** 面板量到的 CSS 尺寸：报给宿主，也用来算触发点（`side="top"` 时要减掉面板高度）。 */
  const [panel, setPanel] = useState({ width: 0, height: 0 })
  /** 宿主算好的气泡几何（方向 / 箭头 / 留边）；还没回执时用居中箭头的默认值。 */
  const [bubble, setBubble] = useState<null | { side: string; arrow: number; pad: number }>(null)
  const revisionRef = useRef(-1)
  const contentRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (reducedMotion) contentRef.current?.getAnimations().forEach((animation) => animation.cancel())
  }, [reducedMotion])
  const [taskbarSupported, setTaskbarSupported] = useState(false)

  const themeHex = useTokenColorHex(config.color)
  const customColor = isCustomColor(config.customColor) ? config.customColor : null
  const swatchValue = customColor ?? themeHex ?? ""
  const geometry = bubble ?? defaultBubbleGeometry(panel.width)

  /** 取色中焦点被系统取色器带走会被 Radix 当成"点了外面"：置真期间（含 `PICKING_GRACE_MS` 宽限）的 dismiss 一律不认。 */
  const pickingRef = useRef(false)
  const pickingTimerRef = useRef<number | undefined>(undefined)
  /** 同一段取色只告诉宿主一次：拖动时的每一条 `input` 都续期，但宿主要知道的只是"开着/关了"。 */
  const hostPickingRef = useRef(false)

  const holdPicking = useCallback(() => {
    pickingRef.current = true
    if (pickingTimerRef.current !== undefined) window.clearTimeout(pickingTimerRef.current)
    pickingTimerRef.current = undefined
    if (hostPickingRef.current) return
    // 宿主侧的系统取色器失焦守门（页面管不到那扇窗的 Focused）：通知失败不影响取色。
    hostPickingRef.current = true
    void coreLyricsSettingsColorPicking(true).catch(() => undefined)
  }, [])

  const releasePicking = useCallback(() => {
    if (pickingTimerRef.current !== undefined) window.clearTimeout(pickingTimerRef.current)
    pickingTimerRef.current = window.setTimeout(() => {
      pickingTimerRef.current = undefined
      pickingRef.current = false
      hostPickingRef.current = false
      // 宽限过了才报"关了"：焦点回到面板之后，照旧的一次失焦也该收起气泡。
      void coreLyricsSettingsColorPicking(false).catch(() => undefined)
    }, PICKING_GRACE_MS)
  }, [])

  useEffect(() => () => {
    if (pickingTimerRef.current !== undefined) window.clearTimeout(pickingTimerRef.current)
  }, [])

  const acceptStatus = useCallback((payload: unknown) => {
    const next = payload as { ready?: boolean; config?: unknown; revision?: number; saveError?: unknown; taskbar?: { supported?: boolean } } | null
    if (next?.ready || !next?.config || !Number.isSafeInteger(next.revision) || next.revision! < revisionRef.current) return
    revisionRef.current = next.revision!
    setConfig(normalizeLyricsConfig(next.config))
    setTaskbarSupported(next.taskbar?.supported === true)
    setSaveError(saveErrorText(typeof next.saveError === "string" ? next.saveError : null))
  }, [])

  const configure = useCallback((patch: Partial<typeof config>) => {
    setActionError(null)
    void coreLyricsConfigure(patch as Record<string, unknown>)
      .then(acceptStatus)
      .catch(() => setActionError("配置未能应用，请从主窗设置重试。"))
  }, [acceptStatus])

  /** 取色器：拖动中走 `onInput` 实时改色（节流 80ms），原生 `change` / 失焦时冲刷最后一次。 */
  const colorInput = useColorInput(swatchValue, (value) => configure({ customColor: value }), releasePicking)

  useEffect(() => {
    let alive = true
    const stops: Array<() => void> = []
    const themeAcceptor = createThemeAcceptor((choice) => applyThemeChoice(document.documentElement, choice))
    const keep = (off: () => void) => {
      if (alive) stops.push(off)
      else off()
    }
    void Promise.all([
      onCoreEvent<unknown>(LYRICS_STATE, (payload) => { if (alive) acceptStatus(payload) }).then(keep),
      onCoreEvent<unknown>(LYRICS_SETTINGS_PRESENTATION, (payload) => { if (alive) presentationRef.current?.(payload) }).then(keep),
      onCoreEvent<{ theme?: string; revision?: number }>(THEME_CHANGED, (payload) => {
        themeAcceptor.accept(payload)
      }).then(keep),
    ]).then(async () => {
      if (!alive) return
      // 权威读一次（空补丁 = 纯读）：查询串可能已经旧了（窗口复用、期间改过配置）
      const authoritative = await coreLyricsConfigure({})
      if (!alive) return
      acceptStatus(authoritative)
      setReady(true)
    }).catch((cause) => {
      if (!alive) return
      // 读不到也照样把面板摆出来：配置会停在查询串那一份，用户至少能看见自己在改什么
      console.warn("[hwmusic-lyrics-settings] 歌词配置读回失败：", cause)
      setReady(true)
    })
    return () => {
      alive = false
      for (const stop of stops) stop()
    }
  }, [acceptStatus])

  /** 量面板的真实尺寸报给宿主（窗口尺寸/位置由它按锚点重算），尺寸没变就不报。 */
  useEffect(() => {
    const node = contentRef.current
    if (node === null || !ready) return undefined
    let last = { width: 0, height: 0 }
    const report = () => {
      const width = Math.ceil(node.offsetWidth)
      const height = Math.ceil(node.offsetHeight)
      if (width <= 0 || height <= 0) return
      setPanel((current) => (current.width === width && current.height === height ? current : { width, height }))
      if (width === last.width && height === last.height) return
      last = { width, height }
      void coreLyricsSettingsResize(width, height)
        .then((answer) => {
          const payload = answer as { geometry?: unknown; presentation?: unknown } | null
          setBubble(normalizeBubbleGeometry(payload?.geometry, width))
          presentationRef.current?.(payload?.presentation)
        })
        .catch(() => setActionError("设置面板没能摆好，请关掉重开。"))
    }
    const observer = new ResizeObserver(report)
    observer.observe(node)
    report()
    return () => observer.disconnect()
  }, [ready])

  /** Esc / 点面板外面：radix 的 dismiss 只负责"告诉我们该关了"，关窗是宿主的事。 */
  const requestClose = useCallback(() => {
    void coreLyricsSettingsClose().catch(() => undefined)
  }, [])

  /** 开合只有"该关了"这一支有意义：取色中的动静不算（平时的点外面照旧关）。 */
  const handleOpenChange = useCallback((open: boolean) => {
    if (open || pickingRef.current) return
    requestClose()
  }, [requestClose])

  /** 取色中的"外面有动静"直接吞掉：系统取色器会把焦点带走，那不等于用户点了外面。 */
  const keepWhilePicking = useCallback((event: { preventDefault: () => void }) => {
    if (pickingRef.current) event.preventDefault()
  }, [])

  /** 单选组的写入：radix 在"再点一次已选中项"时给空串，那一支什么都不写。 */
  const pick = useCallback((key: "style" | "layout" | "size" | "mode") => (value: string) => {
    if (value === "") return
    configure({ [key]: value })
  }, [configure])

  return (
    <Popover open modal={false} onOpenChange={handleOpenChange}>
      {/* 隐形触发点：left/width 决定箭头落在哪儿（面板左边缘被 radix 对齐到它的左边缘） */}
      <PopoverTrigger asChild>
        <span aria-hidden="true" data-testid="lyrics-settings-anchor"
          className="pointer-events-none fixed block border-0 bg-transparent p-0"
          style={bubbleAnchorBox({ side: geometry.side, arrow: geometry.arrow, panelHeight: panel.height, pad: geometry.pad })} />
      </PopoverTrigger>
      <PopoverContent ref={contentRef} side={geometry.side as "bottom" | "top"} align="start"
        sideOffset={-POPOVER_ARROW_DIP} avoidCollisions={false} className="w-[336px] gap-2 p-3"
        data-testid="lyrics-appearance-panel"
        onInteractOutside={keepWhilePicking}
        onFocusOutside={keepWhilePicking}>
        <PopoverArrow />
        <PopoverHeader>
          <PopoverTitle>桌面歌词外观</PopoverTitle>
        </PopoverHeader>
        <Separator />
        <MotionRegion identity={config.mode + "|" + config.style + "|" + config.layout + "|" + config.size}
          kind="content" className="flex flex-col gap-2">

        <Field label="位置">
          <ToggleGroup type="single" size="sm" variant="outline" value={config.mode}
            onValueChange={pick("mode")} data-testid="lyrics-target">
            <ToggleGroupItem value="desktop" data-testid="lyrics-target-desktop">桌面</ToggleGroupItem>
            <ToggleGroupItem value="taskbar" disabled={!taskbarSupported} data-testid="lyrics-target-taskbar">任务栏（Beta）</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {taskbarSupported ? null : <p className="text-xs text-muted-foreground" data-testid="lyrics-target-note">任务栏歌词仅支持 Windows</p>}

        <Field label="样式">
          <ToggleGroup type="single" size="sm" variant="outline" value={config.style}
            onValueChange={pick("style")} data-testid="lyrics-style">
            <ToggleGroupItem value="clean" data-testid="lyrics-style-clean">透明</ToggleGroupItem>
            <ToggleGroupItem value="panel" data-testid="lyrics-style-panel">面板</ToggleGroupItem>
            <ToggleGroupItem value="bare" data-testid="lyrics-style-bare">纯透明</ToggleGroupItem>
          </ToggleGroup>
        </Field>

        <Field label="方向">
          <ToggleGroup type="single" size="sm" variant="outline" value={config.layout}
            onValueChange={pick("layout")} data-testid="lyrics-layout">
            <ToggleGroupItem value="horizontal" data-testid="lyrics-layout-horizontal">横版</ToggleGroupItem>
            {/* 任务栏内嵌只支持横版（Rust 侧强制 horizontal）：这里禁用而不是假装可以选 */}
            <ToggleGroupItem value="vertical" disabled={config.mode === "taskbar"}
              data-testid="lyrics-layout-vertical">竖版</ToggleGroupItem>
          </ToggleGroup>
        </Field>

        <Field label="字号">
          <ToggleGroup type="single" size="sm" variant="outline" value={config.size}
            onValueChange={pick("size")} data-testid="lyrics-size">
            {LYRICS_FONT_STEPS.map((step) => (
              <ToggleGroupItem key={step.id} value={step.id} data-testid={`lyrics-size-${step.id}`}>
                {fontStepLabel(step.id)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Separator />

        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {APPEARANCE_SWITCHES.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <Label htmlFor={`lyrics-window-${key}`} className="text-xs text-muted-foreground">{label}</Label>
              <Switch id={`lyrics-window-${key}`} data-testid={`lyrics-window-${key}`} checked={config[key]}
                onCheckedChange={(checked) => configure({ [key]: checked })} />
            </div>
          ))}
        </div>

        <Separator />

        <Field label="颜色">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* 非受控（`defaultValue` 只给初值，**不按色值换 key**）：按色值重建 DOM 会把系统的取色器关掉。
                外部色值（切主题 / 恢复主题色）由 ref 写进 `input.value`；拖动中走 `onInput` 实时改色。
                这里**不接 React 的 `onChange`**：它跟着 `input` 每帧触发，收尾只认原生 `change`（在钩子里）。 */}
            <Input ref={colorInput.inputRef} id="lyrics-appearance-color" data-testid="lyrics-appearance-color"
              type="color" aria-label="自定义歌词颜色" className="h-7 w-10 shrink-0 p-0"
              defaultValue={swatchValue}
              onPointerDown={holdPicking}
              onInput={(event) => {
                // 拖动中的每一条 input 都在续期"还在取色"：取色器带走的焦点不许把气泡关掉
                holdPicking()
                colorInput.push(event.currentTarget.value)
              }}
              onBlur={() => {
                colorInput.flush()
                releasePicking()
              }} />
            <Button variant="ghost" size="sm" data-testid="lyrics-appearance-color-reset"
              disabled={customColor === null} onClick={() => configure({ customColor: "" })}>恢复主题色</Button>
          </div>
        </Field>
        <p className="text-xs text-muted-foreground">
          {customColor === null ? "跟随主题色" : `使用自定义颜色 ${customColor}`}
        </p>

        {/* 失败也要在这个窗里说一句：它是用户眼前唯一的东西（关掉之后才轮到歌词窗那条提示） */}
        {actionError === null ? null : <p role="alert" className="text-xs text-muted-foreground">{actionError}</p>}
        {saveError === null ? null : <p role="alert" className="text-xs text-muted-foreground">{saveError}</p>}
        </MotionRegion>
      </PopoverContent>
    </Popover>
  )
}
