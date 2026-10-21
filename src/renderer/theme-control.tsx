/**
 * 主题控件（R25 用户四项之 4）：**浅色 / 深色 / 跟随系统**三态。
 *
 * **一份定义、两处落点**（同一 React 组件，这是刻意的）：
 * - gate 视图：登录页自己的右上角（那条 48px header 里）；
 * - 嵌入官方页打开时：浮动 `login-theme` webview 浮在网页右上角。
 *
 * 为什么不做成下拉菜单：这个浮动 webview 只有控件那么大（几十像素见方），
 * 下拉面板会被 webview 的边界裁掉——三态平铺成一排小按钮是唯一能在那个盒子里点全的形态。
 *
 * **接线（订阅广播 / 读回档位 / 写回档位）在 `features/theme/use-theme-choice.ts`**（R41b 提取）：
 * 主窗左下角那枚循环图标按钮与设置页「外观」卡的 Select 用的是同一份接线，三处的形态不同、
 * 状态与写入口只有一套——各写一份必然漂移（"浮动控件改完主题，gate 里这一份的高亮也要跟着变"）。
 *
 * 视觉只用 shadcn 原语 + 令牌工具类：零自定义 CSS、零内联样式（`<style>`/`style={{}}` 都不写）。
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
