/**
 * 桌面歌词的设置**气泡面板**（R60）：一扇独立透明窗里放一个 shadcn `Popover`。
 *
 * 为什么还在单独一扇窗：面板必须能长到 800×128 的歌词窗外面去。窗口尺寸/位置由 Rust 按齿轮的
 * 矩形算（`lyrics_settings.rs` 的 `bubble_placement`），这扇窗**没有任何 window 权限**。
 *
 * 三件事只在页面这一侧：
 * 1. **箭头指着齿轮**：面板贴在窗口留边内侧（Rust 保证），这里把隐形触发点摆到箭头该指的位置
 *    （`bubbleAnchorBox`）——radix 让面板对齐触发点左边缘、箭头对准触发点中心；
 * 2. **量尺寸**：`ResizeObserver` 把面板的 CSS 尺寸报给宿主，位置随之重算；
 * 3. **关窗**：Esc 与点面板外面交给 radix 的 dismiss → `core_lyrics_settings_close`。失焦（点到窗口
 *    外面）、锁定、歌词窗隐藏/切任务栏、退出都由 Rust 那一侧收。
 *
 * 开合状态**恒为 true**：关窗 = 隐藏窗口，页面不重载、React 不重挂（把 `open` 翻成 false 会让下次
 * 显示出来是一扇空窗）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts"
import {
  coreLyricsConfigure,
  coreLyricsSettingsClose,
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
  /** 面板量到的 CSS 尺寸：报给宿主，也用来算触发点（`side="top"` 时要减掉面板高度）。 */
  const [panel, setPanel] = useState({ width: 0, height: 0 })
  /** 宿主算好的气泡几何（方向 / 箭头 / 留边）；还没回执时用居中箭头的默认值。 */
  const [bubble, setBubble] = useState<null | { side: string; arrow: number; pad: number }>(null)
  const revisionRef = useRef(-1)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const themeHex = useTokenColorHex(config.color)
  const customColor = isCustomColor(config.customColor) ? config.customColor : null
  const swatchValue = customColor ?? themeHex ?? ""
  const geometry = bubble ?? defaultBubbleGeometry(panel.width)
  /** 竖版的字号由窗口宽度决定，档位在竖版下不生效。 */
  const sizeByWidth = config.mode === "desktop" && config.layout === "vertical"

  const acceptStatus = useCallback((payload: unknown) => {
    const next = payload as { ready?: boolean; config?: unknown; revision?: number; saveError?: unknown } | null
    if (next?.ready || !next?.config || !Number.isSafeInteger(next.revision) || next.revision! < revisionRef.current) return
    revisionRef.current = next.revision!
    setConfig(normalizeLyricsConfig(next.config))
    setSaveError(saveErrorText(typeof next.saveError === "string" ? next.saveError : null))
  }, [])

  const configure = useCallback((patch: Partial<typeof config>) => {
    setActionError(null)
    void coreLyricsConfigure(patch as Record<string, unknown>)
      .then(acceptStatus)
      .catch(() => setActionError("配置未能应用，请从主窗设置重试。"))
  }, [acceptStatus])

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

  /**
   * 量面板的**真实尺寸**报给宿主（窗口尺寸/位置由它按锚点重算），并留下几何回执。
   *
   * 量 `offsetWidth/offsetHeight`（不被打开动画的 `scale` 影响），向上取整——少一个像素就会
   * 裁掉面板最后一行。尺寸没变就不报（配置变化不该反复摆窗口）。
   */
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
          const payload = answer as { geometry?: unknown } | null
          setBubble(normalizeBubbleGeometry(payload?.geometry, width))
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

  /** 单选组的写入：radix 在"再点一次已选中项"时给空串，那一支什么都不写。 */
  const pick = useCallback((key: "style" | "layout" | "size") => (value: string) => {
    if (value === "") return
    configure({ [key]: value })
  }, [configure])

  return (
    <Popover open modal={false} onOpenChange={requestClose}>
      {/* 隐形触发点：left/width 决定箭头落在哪儿（面板左边缘被 radix 对齐到它的左边缘） */}
      <PopoverTrigger asChild>
        <span aria-hidden="true" data-testid="lyrics-settings-anchor"
          className="pointer-events-none fixed block border-0 bg-transparent p-0"
          style={bubbleAnchorBox({ side: geometry.side, arrow: geometry.arrow, panelHeight: panel.height, pad: geometry.pad })} />
      </PopoverTrigger>
      <PopoverContent ref={contentRef} side={geometry.side as "bottom" | "top"} align="start"
        sideOffset={-POPOVER_ARROW_DIP} avoidCollisions={false} className="w-[336px] gap-2 p-3"
        data-testid="lyrics-appearance-panel">
        <PopoverArrow />
        <PopoverHeader>
          <PopoverTitle>桌面歌词外观</PopoverTitle>
        </PopoverHeader>
        <Separator />

        <Field label="样式">
          <ToggleGroup type="single" size="sm" variant="outline" value={config.style}
            onValueChange={pick("style")} data-testid="lyrics-style">
            <ToggleGroupItem value="clean" data-testid="lyrics-style-clean">透明</ToggleGroupItem>
            <ToggleGroupItem value="panel" data-testid="lyrics-style-panel">面板</ToggleGroupItem>
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
          {/* 竖版字号由窗口宽度决定（容器查询单位），档位在竖版下没法生效：禁用并说清原因 */}
          <ToggleGroup type="single" size="sm" variant="outline" value={config.size}
            disabled={sizeByWidth} onValueChange={pick("size")} data-testid="lyrics-size">
            {LYRICS_FONT_STEPS.map((step) => (
              <ToggleGroupItem key={step.id} value={step.id} data-testid={`lyrics-size-${step.id}`}>
                {fontStepLabel(step.id)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        {sizeByWidth ? (
          <p className="text-xs text-muted-foreground" data-testid="lyrics-size-vertical-note">
            竖版的字号随窗口宽度变化：拉宽窗口字就变大，这里不用挑档位。
          </p>
        ) : null}

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
            {/* 非受控（`defaultValue` + 按色值换 key）：`type=color` 的受控值必须始终合法，
                而"跟随主题"时显示的是当前主题下的真实颜色（`swatchValue`），不是浏览器默认黑。 */}
            <Input key={swatchValue} id="lyrics-appearance-color" data-testid="lyrics-appearance-color"
              type="color" aria-label="自定义歌词颜色" className="h-7 w-10 shrink-0 p-0"
              defaultValue={swatchValue}
              onChange={(event) => {
                const value = event.target.value
                if (!isCustomColor(value)) return
                configure({ customColor: value })
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
      </PopoverContent>
    </Popover>
  )
}
