/**
 * 主题控件：浅色 / 深色 / 跟随系统三态。
 * 一份定义、两处落点：gate 视图登录页右上角与浮动 login-theme webview 右上角；不做下拉菜单（webview 只有几十像素见方，面板会被裁掉）。
 * 接线（订阅广播 / 读回档位 / 写回档位）在 features/theme/use-theme-choice.ts，三处形态不同、状态与写入口只有一套。
 * 视觉只用 shadcn 原语 + 令牌工具类：零自定义 CSS、零内联样式。
 */
import { Button } from "./components/ui/button"
import {
  THEME_CHOICES,
  THEME_CONTROL_TESTID,
  THEME_LABELS,
  themeOptionTestId,
} from "./features/theme/theme.mjs"
import { useThemeChoice } from "./features/theme/use-theme-choice.ts"
import { cn } from "./lib/utils"

export function ThemeControl({ className }: { className?: string }) {
  const { choice, select } = useThemeChoice()

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5",
        className,
      )}
      role="group"
      aria-label="主题"
      data-testid={THEME_CONTROL_TESTID}
    >
      {THEME_CHOICES.map((option) => (
        <Button
          key={option}
          variant={choice === option ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={choice === option}
          data-testid={themeOptionTestId(option)}
          onClick={() => select(option)}
        >
          {THEME_LABELS[option]}
        </Button>
      ))}
    </div>
  )
}
