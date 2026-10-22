/**
 * 主题档位的**唯一接线**（R41b）：读回当前档位、跟着 `theme:changed` 走、把一次选择写回去。
 *
 * 为什么要有这一层：R41b 之后"改主题"有三个形态的入口——门禁/浮动控件的三态平铺（R25）、
 * 主窗左下角那枚循环图标按钮、设置页「外观」卡里的 Select。它们必须**读同一份状态、写同一条路**。
 * 各写一遍 `listen` + `invoke` 的后果不是风格问题：一处订阅了广播、另一处没订阅，界面上就会出现
 * "设置页写着深色、左下角还画着太阳"这种自相矛盾的两份真相。
 *
 * 三条纪律（与 R25 的 `theme-control.tsx` 逐字一致，这里只是把它从组件里提出来共用）：
 *
 * 1. **先订阅、再读回**（顺序是硬要求）：反过来的话，两步之间发生的一次改动就丢了，
 *    界面会一直显示旧档位；
 * 2. 写走 `coreLoginChrome` 的 `theme` 动作——那是 Rust 侧**唯一**的主题写入口，
 *    落盘 `settings.json`、更新内存里的档位、广播 `theme:changed` 三件事在同一处完成。
 *    **不走 `settings:set`**：那条路只写盘（`mergeSettings` 把未知键原样透传），
 *    Rust 内存里的档位与那条广播都不会跟着动——界面会亮、重启就变回去；
 * 3. 高亮跟着回执与宿主广播走，不做乐观切换；写盘失败保持原样，原生部分失败保留已保存主题并报告错误。
 *
 * 每个用到它的组件各自订阅一次（左下角那枚、设置页那张卡、门禁那个控件各有自己的生命周期，
 * 挂载/卸载互不相干）；状态的**真源**始终是 Rust 的那一份 + `theme:changed` 广播，
 * 所以订阅几份都只会得到同一个结论。
 */
import { useCallback, useEffect, useState } from "react"

import { THEME_CHANGED } from "../../../shared/channels.ts"
import { coreLoginChrome, onCoreEvent } from "../../host-api"
import { applyTheme, type ThemePayload } from "../../theme-sync"
import { THEME_DEFAULT } from "./theme.mjs"

export interface ThemeChoiceBinding {
  /** 当前档位：来自 Rust 的回执与广播，认不出的档位按系统档（见 theme.mjs） */
  choice: string
  /** 选一档：走唯一写入口，以回执与宿主广播为准；部分失败仍保留诊断。 */
  select: (next: string) => void
}

export function useThemeChoice(): ThemeChoiceBinding {
  const [choice, setChoice] = useState<string>(THEME_DEFAULT)

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null

    void (async () => {
      try {
        const unsubscribe = await onCoreEvent<ThemePayload>(THEME_CHANGED, (payload) => {
          if (disposed) return
          // 别的入口（另一个 webview、托盘之后的设置页）改了主题：跟着变
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

  const select = useCallback((next: string) => {
    void (async () => {
      try {
        const answer = await coreLoginChrome<{ theme?: string }>({ action: "theme", theme: next })
        setChoice(applyTheme(answer?.theme))
      } catch (failure) {
        console.warn("主题切换未全部完成（以宿主广播为准，详情见错误）", failure)
      }
    })()
  }, [])

  return { choice, select }
}
