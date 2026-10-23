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
 *    落盘 `settings.json`（经 sidecar 的单一写者）、更新内存里的档位、广播 `theme:changed`
 *    三件事在同一笔事务里完成。**不走 `settings:set`**（R44e 起那条路也明确拒保留键 `theme`：
 *    它不更新 Rust 内存、不广播，界面会亮、重启就变回去）；
 * 3. 高亮跟着回执与宿主广播走，不做乐观切换；写盘失败保持原样，原生部分失败保留已保存主题并报告错误。
 *
 * R44e：广播与读回都带 `revision`，落地经共享的 [`createThemeAcceptor`]（单调）——异步读回的
 * 旧回执不许盖掉刚收到的新广播。**写回的回执也走同一个接受器**（fix1 / review finding 3）：
 * 快速连点两下时，第一笔的 invoke 回执可能晚于第二笔的广播到达，直接 `setChoice(回执)` 会把
 * 页面与被选中的控件一起拉回旧档位。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { THEME_CHANGED } from "../../../shared/channels.ts"
import { coreLoginChrome, onCoreEvent } from "../../host-api.ts"
// 只借类型：声明由 `theme-sync.ts` 拥有，运行时不需要它（本文件要能被 node 测试直接 import）
import type { ThemePayload } from "../../theme-sync.ts"
import { applyThemeChoice, THEME_DEFAULT } from "./theme.mjs"
import { createThemeAcceptor } from "./theme-accept.mjs"

/**
 * 把档位落到 `<html>` 上（切类仍只经 `theme.mjs` 的 `applyThemeChoice`，这里只补 document 根），
 * 返回**实际生效**的档位。
 */
const applyTheme = (choice: unknown): string => applyThemeChoice(document.documentElement, choice)

/** 一次落地的**唯一接受器**：广播、读回、写回回执共用它（同一个 revision 水位）。 */
export interface ThemeChoiceTracker {
  /** 最近一次被接受的档位（= 控件高亮该显示的那一档） */
  choice(): string
  /** 见过的最高 revision（`-1` = 还没收到带编号的回执） */
  revision(): number
  /** 广播 / 读回 / 选择回执：旧回执返回 `false`（一次都不落地） */
  accept(payload: unknown): boolean
}

/**
 * 建一份接受器：`apply` 收到"被接受的那一档"，只由它推界面副作用。
 *
 * 单调规则本身**只写一遍**（[`acceptThemePayload`]，经 `theme-accept.mjs` 的
 * `createThemeAcceptor`）；这里加的是"当前档位"这一格，好让控件高亮与页面类共用同一个答案。
 */
export function createThemeChoiceTracker(apply: (choice: string) => void): ThemeChoiceTracker {
  let choice = THEME_DEFAULT
  const acceptor = createThemeAcceptor((next: string) => {
    choice = next
    apply(next)
  })
  return {
    choice: () => choice,
    revision: () => acceptor.revision(),
    accept: (payload) => acceptor.accept(payload),
  }
}

export interface ThemeChoiceBinding {
  /** 当前档位：来自 Rust 的回执与广播，认不出的档位按系统档（见 theme.mjs） */
  choice: string
  /** 选一档：走唯一写入口，以回执与宿主广播为准；部分失败仍保留诊断。 */
  select: (next: string) => void
}

export function useThemeChoice(): ThemeChoiceBinding {
  const [choice, setChoice] = useState<string>(THEME_DEFAULT)
  // 接受器要在多次渲染与两条异步路（广播 / 写回）之间保持同一个水位
  const tracker = useRef<ThemeChoiceTracker | null>(null)
  if (tracker.current === null) {
    tracker.current = createThemeChoiceTracker((applied) => setChoice(applyTheme(applied)))
  }

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null
    const track = tracker.current as ThemeChoiceTracker

    void (async () => {
      try {
        const unsubscribe = await onCoreEvent<ThemePayload>(THEME_CHANGED, (payload) => track.accept(payload))
        if (disposed) unsubscribe()
        else stop = unsubscribe

        const answer = await coreLoginChrome<ThemePayload>({ action: "theme" })
        track.accept(answer)
      } catch (failure) {
        // 读不到**不改界面**：宿主还没起来时保持"跟随系统"这一档（与门禁的"不猜档位"同一条纪律）
        if (!disposed && track.revision() < 0) setChoice(THEME_DEFAULT)
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
        // 回执是**这一笔事务自己提交的** `{theme, revision}`，过同一个接受器：
        // 迟到的旧回执（revision 更低）不会把页面与控件高亮拉回旧档位。
        const answer = await coreLoginChrome<ThemePayload>({ action: "theme", theme: next })
        tracker.current?.accept(answer)
      } catch (failure) {
        console.warn("主题切换未全部完成（以宿主广播为准，详情见错误）", failure)
      }
    })()
  }, [])

  return { choice, select }
}
