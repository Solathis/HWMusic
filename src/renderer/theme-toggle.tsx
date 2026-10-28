/**
 * 主题循环按钮：主窗左下角账号区里那枚纯图标按钮，点一下换下一档（浅色 → 深色 → 跟随系统）。
 * 状态与写入口都在 `features/theme/use-theme-choice.ts`，与设置页「外观」卡是同一份接线。
 * 纯图标按钮必须有说法：`aria-label` 与 tooltip 说清当前哪一档、点一下到哪一档；视觉只用 shadcn 原语与令牌类。
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

/** 档位 → 图标的表；档位、顺序与文案的真源在 `theme.mjs`，这张表只回答「画哪个图标」。 */
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
