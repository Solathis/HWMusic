/**
 * 主题的宿主接线（R25）：读回当前档位、订阅 `theme:changed`、把类落到 `<html>` 上。
 *
 * 状态在 Rust 侧（`settings.json` 的 `theme` 键），这一层只做三件事：
 *
 * 1. **先订阅、再读回**（顺序是硬要求）：反过来的话，两步之间发生的一次改动就丢了；
 * 2. 读到（或收到）的档位一律经 `applyThemeChoice` 落地——切类只有那一处；
 * 3. 读不到时**什么都不改**：宿主还没起来（core 没启动）不该让界面自己猜一个档位，
 *    这时 `<html>` 上没有类 = 系统档，与 R10 起的既有行为逐字一致。
 *
 * 谁用：主窗（`main.tsx`，覆盖门禁与登录后的主界面）与浮动控件（`login-chrome-main.tsx`）。
 * 官方登录页不在这里：那是**零注入**的硬边界，它的文档不该被我们碰（见 `src-tauri/src/login.rs`）。
 */
import { THEME_CHANGED } from "../shared/channels.ts"
import { coreLoginChrome, onCoreEvent } from "./host-api"
import { applyThemeChoice, THEME_DEFAULT } from "./features/theme/theme.mjs"

/** `theme:changed` 的载荷形状（与 `src/shared/channels.ts` 的说明同源）。 */
export interface ThemePayload {
  theme?: string
}

/**
 * 装好主题同步并**应用一次当前档位**；返回退订函数。
 *
 * 调用方（两个入口文件）在渲染第一帧之前调用它——主题没落地的第一帧按系统档画，
 * 这一步结束后（一次 IPC 往返）立刻补上强制档位。
 */
export async function installThemeSync(): Promise<() => void> {
  let stop: (() => void) | null = null
  let disposed = false

  const unsubscribe = await onCoreEvent<ThemePayload>(THEME_CHANGED, (payload) => {
    applyThemeChoice(document.documentElement, payload?.theme)
  })
  if (disposed) unsubscribe()
  else stop = unsubscribe

  try {
    const answer = await coreLoginChrome<{ theme?: string }>({ action: "theme" })
    applyThemeChoice(document.documentElement, answer?.theme)
  } catch {
    // 宿主还没起来（core 未启动/命令不可达）：保持系统档，不猜、不报错刷屏。
    // 门禁的状态行会把"查不到"这件事说清楚，主题这一层不需要第二条报错路径。
    applyThemeChoice(document.documentElement, THEME_DEFAULT)
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
