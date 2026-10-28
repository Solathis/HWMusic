/**
 * 主题的宿主接线：读回当前档位、订阅 `theme:changed`、把类落到 `<html>` 上。
 *
 * 先订阅、再读回（顺序是硬要求）；档位一律经 `applyThemeChoice` 落地；读不到时什么都不改（`<html>` 无类 = 系统档）。
 * 广播与读回都带 `revision`，经共享的 `createThemeAcceptor` 单调落地：旧回执不许盖掉新档位。
 */
import { THEME_CHANGED } from "../shared/channels.ts"
import { coreLoginChrome, onCoreEvent } from "./host-api"
import { acceptThemePayload, applyThemeChoice, THEME_DEFAULT } from "./features/theme/theme.mjs"

/** `theme:changed` 的载荷形状（与 `src/shared/channels.ts` 的说明同源）。 */
export interface ThemePayload {
  theme?: string
  revision?: number
}

/** 装好主题同步并应用一次当前档位，返回退订函数；调用方在渲染第一帧之前调用。 */
export async function installThemeSync(): Promise<() => void> {
  let stop: (() => void) | null = null
  let disposed = false
  // 共享的单调合同（`acceptThemePayload`）：旧广播/旧读回不许盖掉新档位。
  let seen = -1
  const land = (payload: unknown) => {
    const verdict = acceptThemePayload(seen, payload)
    if (!verdict.accept) return false
    seen = verdict.seen
    const source = payload !== null && typeof payload === "object" ? (payload as ThemePayload) : null
    applyThemeChoice(document.documentElement, source?.theme)
    return true
  }

  const unsubscribe = await onCoreEvent<ThemePayload>(THEME_CHANGED, (payload) => {
    land(payload)
  })
  if (disposed) unsubscribe()
  else stop = unsubscribe

  try {
    const answer = await coreLoginChrome<ThemePayload>({ action: "theme" })
    land(answer)
  } catch {
    // 宿主还没起来（core 未启动/命令不可达）：保持系统档，不猜、不报错刷屏。
    // 已收到带编号的回执时不许回落（那是把权威答案冲掉）。
    if (seen < 0) applyThemeChoice(document.documentElement, THEME_DEFAULT)
  }

  return () => {
    disposed = true
    if (stop) stop()
  }
}

/** 供界面用：把一次选择落到 `<html>` 上，返回实际生效的档位（认不出的按系统档）。 */
export function applyTheme(choice: unknown): string {
  return applyThemeChoice(document.documentElement, choice)
}
