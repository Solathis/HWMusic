/**
 * 主题循环按钮（R41b）：主窗左下角账号区里那枚**纯图标**按钮（在「退出登录」左边）。
 *
 * 为什么是"点一下换下一档"而不是三个按钮或下拉：
 * - 账号区那一行在窄轨（`collapsible="icon"`，48px）里只剩图标，三态平铺塞不下；
 * - 下拉面板要从一个 32px 宽的按钮里弹出，在这么窄的地方反而是负担。
 * 循环顺序 **浅色 → 深色 → 跟随系统**（`nextThemeChoice`：顺序就是 `THEME_CHOICES` 的顺序），
 * 三下转一圈，图标始终画着**当前**档位（太阳 / 月亮 / 显示器）。
 *
 * 三条纪律：
 * 1. **状态与写入口都不是这里定的**：读回档位、订阅 `theme:changed`、写回档位全在
 *    `features/theme/use-theme-choice.ts`——设置页「外观」卡的 Select 用的是同一份接线，
 *    两处改的是同一份状态（R41b 的"同源同向"）；
 * 2. **纯图标按钮必须有说法**：`aria-label`（与 tooltip）用 `themeToggleLabel` 说清
 *    "当前是哪一档、点一下到哪一档"——只写"主题"等于让读屏用户点三下才知道转到哪；
 * 3. 视觉只用 shadcn 原语 + 令牌类：零自定义 CSS、零内联样式、零硬编码色。
 */
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import type { ComponentType } from "react"

import { Button } from "./components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
import {
  THEME_CHOICE,
  THEME_TOGGLE_TESTID,
  nextThemeChoice,
  themeToggleLabel,
} from "./features/theme/theme.mjs"
import { useThemeChoice } from "./features/theme/use-theme-choice.ts"

/**
 * 档位 → 图标（**只有图标**的一张表）。
 *
 * 档位、顺序、文案的真源都在 `theme.mjs`；这张表只回答"画哪个图标"。
 * 认不出的档位不会走到这里（`useThemeChoice` 一律经 `applyTheme` 归一），兜底给显示器
 * ——那正是"跟随系统"的画法，也是认不出时的落点。
 */
const THEME_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  [THEME_CHOICE.light]: SunIcon,
  [THEME_CHOICE.dark]: MoonIcon,
  [THEME_CHOICE.system]: MonitorIcon,
}

export function ThemeToggle({ className }: { className?: string }) {
  const { choice, select } = useThemeChoice()
  const Icon = THEME_ICONS[choice] ?? MonitorIcon
  const label = themeToggleLabel(choice)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={label}
          data-testid={THEME_TOGGLE_TESTID}
          // 当前档位同时挂成数据属性：CDP 取证与测试按它认状态，不必去认图标
          data-theme-choice={choice}
          onClick={() => select(nextThemeChoice(choice))}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
