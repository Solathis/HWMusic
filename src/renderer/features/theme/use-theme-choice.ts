/**
 * 主题档位的**唯一接线**：读回当前档位、跟着 `theme:changed` 走、把一次选择写回去。
 * 先订阅再读回；写只走 `coreLoginChrome` 的 `theme` 动作；高亮跟回执与广播走，不做乐观切换。
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

/** 建一份接受器：`apply` 收到「被接受的那一档」，只由它推界面副作用；单调规则只写一遍。 */
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
