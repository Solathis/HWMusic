/**
 * 主窗外壳（R7 只搭最小骨架，真实主界面在 R8）。
 *
 * **顺序是契约**：门禁判定在最前，未登录（含"还不知道"）绝不渲染 app-shell——
 * `test/login-gate.test.mjs` 扫源码钉住这个顺序（顺序反了就是把没登录的用户放进主界面，
 * 然后每个请求都失败，用户只会看到一堆报错）。
 *
 * app-shell 里那个 `data-shell="app-shell"` 是**测试锚点**（R8 换掉这一块时保留它，
 * 或同步改测试）：它标出"未登录时不该出现的那一块"。
 */
import { LoginGate, useAuthGate } from "./login-gate"
import { shouldShowLoginGate } from "./features/auth/login-gate-logic.mjs"

export function App() {
  const gate = useAuthGate()

  if (shouldShowLoginGate(gate.state)) {
    return <LoginGate gate={gate} />
  }

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground" data-shell="app-shell">
      {/* R8 的主界面落点（侧边栏 + 收藏页 + 播放条）。R7 只证明"登录之后才走到这里"。 */}
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">已登录。主界面将由后续任务接入。</p>
      </div>
    </div>
  )
}
