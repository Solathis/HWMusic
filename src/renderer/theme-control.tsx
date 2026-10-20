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
 * 高亮的真源是 **Rust 回的当前档位**，不是本地猜的：点一下先经 `core_login_chrome` 落盘 + 广播，
 * 再按回执更新自己，同时订阅 `theme:changed` 与别的 webview 保持一致
 * （浮动控件改完主题，gate 里这一份的高亮也要跟着变——两份各记一份状态就会漂移）。
 *
 * 视觉只用 shadcn 原语 + 令牌工具类：零自定义 CSS、零内联样式（`<style>`/`style={{}}` 都不写）。
 */
import { useCallback, useEffect, useState } from "react"

import { THEME_CHANGED } from "../shared/channels.ts"
import { Button } from "./components/ui/button"
import {
  THEME_CHOICES,
  THEME_CONTROL_TESTID,
  THEME_DEFAULT,
  THEME_LABELS,
  themeOptionTestId,
} from "./features/theme/theme.mjs"
import { cn } from "./lib/utils"
import { applyTheme } from "./theme-sync"
import { coreLoginChrome, onCoreEvent } from "./host-api"

/** `theme:changed` 的载荷（与 `src/shared/channels.ts` 同源）。 */
interface ThemePayload {
  theme?: string
}

export function ThemeControl({ className }: { className?: string }) {
  const [choice, setChoice] = useState<string>(THEME_DEFAULT)

  /**
   * 挂载：**先订阅再读回**（顺序是硬要求，与门禁的 auth:status 同一条纪律）——
   * 反过来的话，两步之间发生的一次改动就丢了，界面会一直高亮旧档位。
   */
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null

    void (async () => {
      try {
        const unsubscribe = await onCoreEvent<ThemePayload>(THEME_CHANGED, (payload) => {
          if (disposed) return
          // 别的 webview 改了主题：跟着变（认不出的档位按系统档，见 theme.mjs）
          setChoice(applyTheme(payload?.theme))
        })
        if (disposed) unsubscribe()
        else stop = unsubscribe

        const answer = await coreLoginChrome<{ theme?: string }>({ action: "theme" })
        if (disposed) return
        setChoice(applyTheme(answer?.theme))
      } catch (failure) {
        // 读不到**不改界面**：宿主还没起来时保持"跟随系统"这一档（与门禁的"不猜档位"同一条纪律）
        if (!disposed) setChoice(THEME_DEFAULT)
        console.warn("主题档位读不到（保持跟随系统）", failure)
      }
    })()

    return () => {
      disposed = true
      if (stop) stop()
    }
  }, [])

  /**
   * 点一下某档：走**唯一入口** `core_login_chrome`（Rust 持有状态 + 落盘 + 广播）。
   *
   * 高亮跟着**回执**走而不是跟着点击走：写盘失败时界面不该显示一个不存在的结果
   * （那正是"设置页说改了、实际没改"这类缺陷的形状）。
   */
  const select = useCallback((next: string) => {
    void (async () => {
      try {
        const answer = await coreLoginChrome<{ theme?: string }>({ action: "theme", theme: next })
        setChoice(applyTheme(answer?.theme))
      } catch (failure) {
        console.warn("主题档位没能改（保持原档位）", failure)
      }
    })()
  }, [])

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
