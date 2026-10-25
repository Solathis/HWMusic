/**
 * 桌面歌词的设置**弹出窗**（R51）：一扇独立的小透明窗，里面就是那一个 shadcn `DropdownMenu`。
 *
 * ## 为什么菜单在窗口外面
 *
 * 桌面歌词窗默认只有 800×128。R50 的设置面是歌词窗**内嵌**的下拉菜单，radix 会把浮层限制在窗口的
 * 可用高度里（`--radix-dropdown-menu-content-available-height`）——菜单只能滚。用户要的是"允许突破
 * 桌面歌词大小限制"，所以菜单搬进这扇窗：窗口多大、放哪儿由 Rust 定（`lyrics_settings.rs`），
 * 这里的职责只有两条：**画出和 R50 一模一样的菜单**，以及**把它的真实尺寸量给宿主**。
 *
 * ## 三条接线
 *
 * 1. **外观就是官方组件**：`DropdownMenu` 强制 `open`、`modal={false}`，触发点是窗口原点上一枚 0×0
 *    的隐形锚点，内容 `side="bottom" align="start" sideOffset={0} avoidCollisions={false} max-h-none`
 *    —— 于是菜单左上角贴着窗口原点，窗口尺寸 = 菜单尺寸（Rust 拿到尺寸后再定位/显示）。
 * 2. **配置仍然只走那条窄命令**：写入 `core_lyrics_configure`（落盘由 Rust 拥有），读取是空补丁读
 *    一次 + 订阅 `lyrics:state`；初始值另有查询串（建窗时 Rust 拼的当前配置），第一帧就是对的。
 * 3. **关窗**：Esc 与点菜单外面由 radix 的 dismiss 回来 → `core_lyrics_settings_close`。
 *    失焦（= 点到窗口外面）、锁定、歌词窗隐藏/切任务栏、退出都由 Rust 那一侧收——这扇窗**没有任何**
 *    window 权限，它甚至不该知道窗口能移动。
 *
 * 开合状态**恒为 true**（`open` 不跟着 dismiss 翻下去）：关窗 = 隐藏，页面不重载、React 不重挂。
 * 若把 `open` 翻成 false，下次显示出来会是一扇空窗（内容已被卸载，而窗口只是被 hide 过）。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { LYRICS_STATE, THEME_CHANGED } from "../shared/channels.ts"
import {
  coreLyricsConfigure,
  coreLyricsSettingsClose,
  coreLyricsSettingsResize,
  onCoreEvent,
} from "./host-api"
import { Button } from "./components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import { Switch } from "./components/ui/switch"
import {
  LYRICS_FONT_STEPS,
  fontStepLabel,
  isCustomColor,
  lyricsConfigFromSearch,
  normalizeLyricsConfig,
  saveErrorText,
} from "./features/lyrics/lyrics-window.mjs"
import { createThemeAcceptor } from "./features/theme/theme-accept.mjs"
import { applyThemeChoice } from "./features/theme/theme.mjs"

export function LyricsSettingsPopup() {
  // 初值来自建窗时拼的查询串（Rust 侧按当前配置拼）：页面还没订阅事件时也不会丢配置
  const [config, setConfig] = useState(() => lyricsConfigFromSearch(window.location.search))
  const [actionError, setActionError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 权威配置读到之前不量尺寸：第一帧就得是用户真正的那份配置（否则会按默认值把窗口摆错宽度）。 */
  const [ready, setReady] = useState(false)
  const revisionRef = useRef(-1)
  const contentRef = useRef<HTMLDivElement | null>(null)

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
      // 读不到也照样把菜单摆出来：配置会停在查询串那一份，用户至少能看见自己在改什么
      console.warn("[hwmusic-lyrics-settings] 歌词配置读回失败：", cause)
      setReady(true)
    })
    return () => {
      alive = false
      for (const stop of stops) stop()
    }
  }, [acceptStatus])

  /**
   * 把菜单的**真实尺寸**报给 Rust（窗口尺寸/位置由它按锚点重算）。
   *
   * 量的是 `offsetWidth/offsetHeight`（不被打开动画的 `scale`/`translate` 影响），向上取整——
   * 少一个像素就会把菜单最后一行裁掉半行。尺寸没变就不报（配置变化不该反复摆窗口）。
   */
  useEffect(() => {
    const node = contentRef.current
    if (node === null || !ready) return undefined
    let last = { width: 0, height: 0 }
    const report = () => {
      const width = Math.ceil(node.offsetWidth)
      const height = Math.ceil(node.offsetHeight)
      if (width <= 0 || height <= 0) return
      if (width === last.width && height === last.height) return
      last = { width, height }
      void coreLyricsSettingsResize(width, height).catch(() => {
        setActionError("设置窗口没能摆好，请关掉重开。")
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(node)
    report()
    return () => observer.disconnect()
  }, [ready])

  /** Esc / 点菜单外面：radix 的 dismiss 只负责"告诉我们该关了"，关窗是宿主的事。 */
  const requestClose = useCallback(() => {
    void coreLyricsSettingsClose().catch(() => undefined)
  }, [])

  const customColorValue = isCustomColor(config.customColor) ? config.customColor : null

  return (
    <DropdownMenu open modal={false} onOpenChange={requestClose}>
      {/* 窗口原点上的隐形锚点：内容左上角 = 窗口原点 = 菜单左上角（Rust 只摆窗口，不摆菜单） */}
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" tabIndex={-1} aria-hidden="true" data-testid="lyrics-settings-anchor"
          className="pointer-events-none absolute left-0 top-0 size-0 border-0 bg-transparent p-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={contentRef} side="bottom" align="start" sideOffset={0} avoidCollisions={false}
        className="w-64 max-h-none" data-testid="lyrics-appearance-panel">
        <DropdownMenuLabel>桌面歌词外观</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>样式</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={config.style} onValueChange={(style) => configure({ style })}>
          <DropdownMenuRadioItem value="clean" data-testid="lyrics-style-clean">透明</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="panel" data-testid="lyrics-style-panel">面板</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>方向（竖版为逐字竖排）</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={config.layout} onValueChange={(layout) => configure({ layout })}>
          <DropdownMenuRadioItem value="horizontal" data-testid="lyrics-layout-horizontal">横版</DropdownMenuRadioItem>
          {/* 任务栏内嵌只支持横版（Rust 侧强制 horizontal）：这里禁用而不是假装可以选 */}
          <DropdownMenuRadioItem value="vertical" disabled={config.mode === "taskbar"} data-testid="lyrics-layout-vertical">
            竖版
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>字号</DropdownMenuLabel>
        {/* R51：字号档位在弹出窗里直接可改（R50 之前只有主窗设置页能改，小窗用户要跑两处） */}
        <DropdownMenuRadioGroup value={config.size} onValueChange={(size) => configure({ size })}>
          {LYRICS_FONT_STEPS.map((step) => (
            <DropdownMenuRadioItem key={step.id} value={step.id} data-testid={`lyrics-size-${step.id}`}>
              {fontStepLabel(step.id)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>演出效果</DropdownMenuLabel>
        {/* 开关用 shadcn `Switch`：它们不是菜单项，点一下不该关掉菜单 */}
        <div className="flex flex-col gap-1 px-1.5 py-1">
          {([["enableBlur", "模糊"], ["enableScale", "缩放"], ["enableSpring", "弹簧动画"], ["showControls", "媒体按钮"]] as const).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <Label htmlFor={`lyrics-window-${key}`}>{label}</Label>
              <Switch id={`lyrics-window-${key}`} data-testid={`lyrics-window-${key}`} checked={config[key]}
                onCheckedChange={(checked) => configure({ [key]: checked })} />
            </div>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>颜色</DropdownMenuLabel>
        <div className="flex flex-col gap-1 px-1.5 py-1">
          <div className="flex items-center gap-2">
            {/* 非受控（`defaultValue` + 按存档值换 key）：`type=color` 的受控值必须始终合法，
                而"还没选过"不该由页面编一个色值出来。 */}
            <Input key={customColorValue ?? "theme"} id="lyrics-appearance-color" data-testid="lyrics-appearance-color"
              type="color" aria-label="自定义歌词颜色" className="h-8 w-14 shrink-0 p-0"
              defaultValue={customColorValue ?? undefined}
              onChange={(event) => {
                const value = event.target.value
                if (!isCustomColor(value)) return
                configure({ customColor: value })
              }} />
            <Button variant="ghost" size="sm" data-testid="lyrics-appearance-color-reset" disabled={customColorValue === null}
              onClick={() => configure({ customColor: "" })}>恢复主题色</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {customColorValue === null ? "现在用设计令牌里的颜色" : `使用自定义颜色 ${customColorValue}`}
          </p>
        </div>
        {/* 失败也要在这个窗里说一句：它是用户眼前唯一的东西（关掉之后才轮到歌词窗那条提示） */}
        {actionError === null ? null : <p role="alert" className="px-1.5 py-1 text-xs text-muted-foreground">{actionError}</p>}
        {saveError === null ? null : <p role="alert" className="px-1.5 py-1 text-xs text-muted-foreground">{saveError}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
