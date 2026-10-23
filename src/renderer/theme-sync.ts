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
 * R44e：广播与读回都带 `revision`，落地经共享的 [`createThemeAcceptor`]（**单调**）——
 * 读回是异步的，慢半拍的旧回执不许把刚收到的新广播盖掉；读回失败也不许在已经收到过
 * 带编号的答案之后把界面打回系统档。
 *
 * 谁用：主窗（`main.tsx`，覆盖门禁与登录后的主界面）与浮动控件（`login-chrome-main.tsx`）。
 * 官方登录页不在这里：那是**零注入**的硬边界，它的文档不该被我们碰（见 `src-tauri/src/login.rs`）。
 */
import { THEME_CHANGED } from "../shared/channels.ts"
import { coreLoginChrome, onCoreEvent } from "./host-api"
import { acceptThemePayload, applyThemeChoice, THEME_DEFAULT } from "./features/theme/theme.mjs"

/** `theme:changed` 的载荷形状（与 `src/shared/channels.ts` 的说明同源）。 */
export interface ThemePayload {
  theme?: string
  revision?: number
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
    // 门禁的状态行会把"查不到"这件事说清楚，主题这一层不需要第二条报错路径。
    // 已经收到带编号的回执时**不许**回落（那是把权威答案冲掉）。
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
