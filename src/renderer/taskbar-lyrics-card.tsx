/**
 * 设置页的「任务栏歌词（Beta）」卡：颜色 / 逐字高亮 / 字号。
 * 任务栏歌词与桌面歌词是两套配置，共用一处会互相改写；而任务栏窗整窗点透，没有可点的控件。
 * 单独一个组件：设置页不膨胀，桌面歌词的外观控件也不会与这里混在一起。
 * 平台判断走宿主回报的 taskbar.supported，非 Windows 连这张卡都不渲染。
 */
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select"
import { Switch } from "./components/ui/switch"
import {
  LYRICS_COLOR_TOKENS,
  TASKBAR_FONT_STEPS,
  colorTokenLabel,
  isCustomColor,
  taskbarFontStepLabel,
} from "./features/lyrics/lyrics-window.mjs"
import { useColorInput } from "./features/lyrics/use-color-input.ts"
import { useTokenColorHex } from "./features/lyrics/use-token-color.ts"
import type { LyricsWindowBinding } from "./use-lyrics-window.ts"

export function TaskbarLyricsCard({ lyrics }: { lyrics: LyricsWindowBinding | null }) {
  /** 令牌颜色跟着主题走（取色器非受控：换了主题靠 ref 同步进 DOM，不重建输入框）。 */
  const themeHex = useTokenColorHex(lyrics?.config.taskbarColor ?? "foreground")
  const storedColor = lyrics?.config.taskbarCustomColor ?? null
  const customColor = isCustomColor(storedColor) ? storedColor : null
  /** 未设自定义色时色块显示的是**主题下的真实颜色**，不是浏览器给 `type=color` 的默认黑。 */
  const swatchValue = customColor ?? themeHex ?? ""
  // 钩子得在早退之前调用（这张卡不渲染时这份接线只是不用）
  const colorInput = useColorInput(swatchValue, (value) => lyrics?.updateConfig({ taskbarCustomColor: value }))
  if (lyrics === null || lyrics.taskbar?.supported !== true) return null
  const config = lyrics.config

  return (
    <Card data-testid="taskbar-lyrics-card">
      <CardHeader>
        <CardTitle>任务栏歌词（Beta）</CardTitle>
        <CardDescription>贴在任务栏上的那条歌词：颜色、字号、逐字高亮。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="taskbar-lyrics-color">颜色</Label>
          <Select value={config.taskbarColor} onValueChange={(value) => lyrics.updateConfig({ taskbarColor: value })}>
            <SelectTrigger id="taskbar-lyrics-color" data-testid="taskbar-lyrics-color" className="w-full max-w-xs">
              {/* 标签直接写进 SelectValue：radix 在没展开过内容时拿不到选项文案。 */}
              <SelectValue>{colorTokenLabel(config.taskbarColor)}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start" sideOffset={4}>
              <SelectGroup>
                {LYRICS_COLOR_TOKENS.map((token) => (
                  <SelectItem key={token.id} value={token.id} data-testid={`taskbar-color-${token.id}`}>
                    {colorTokenLabel(token.id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-2">
            {/* 非受控且不按色值换 key（被重建的输入框会关掉系统取色器）：`onInput` 边拖边改，原生 `change` 与失焦收尾。 */}
            <Input ref={colorInput.inputRef} id="taskbar-lyrics-custom-color" data-testid="taskbar-lyrics-custom-color"
              type="color" aria-label="任务栏歌词自定义颜色" className="h-8 w-14 shrink-0 p-0"
              defaultValue={swatchValue}
              onInput={(event) => colorInput.push(event.currentTarget.value)}
              onBlur={() => colorInput.flush()} />
            <Button id="taskbar-lyrics-color-reset" data-testid="taskbar-lyrics-color-reset" variant="ghost" size="sm"
              disabled={customColor === null} onClick={() => lyrics.updateConfig({ taskbarCustomColor: "" })}>
              恢复主题色
            </Button>
            <span className="text-xs text-muted-foreground">
              {customColor === null ? "跟随上方选择的颜色" : `使用自定义颜色 ${customColor}`}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Switch id="taskbar-lyrics-karaoke" data-testid="taskbar-lyrics-karaoke" checked={config.taskbarKaraoke}
            onCheckedChange={(checked) => lyrics.updateConfig({ taskbarKaraoke: checked })} />
          <Label htmlFor="taskbar-lyrics-karaoke">逐字高亮</Label>
          <span className="text-xs text-muted-foreground">关闭后整行点亮</span>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="taskbar-lyrics-size">字号</Label>
          <Select value={config.taskbarSize} onValueChange={(value) => lyrics.updateConfig({ taskbarSize: value })}>
            <SelectTrigger id="taskbar-lyrics-size" data-testid="taskbar-lyrics-size" className="w-full max-w-xs">
              <SelectValue>{taskbarFontStepLabel(config.taskbarSize)}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="start" sideOffset={4}>
              <SelectGroup>
                {TASKBAR_FONT_STEPS.map((step) => (
                  <SelectItem key={step.id} value={step.id} data-testid={`taskbar-size-${step.id}`}>
                    {taskbarFontStepLabel(step.id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}
