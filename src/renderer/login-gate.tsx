/**
 * 登录门禁（引导页）：主窗在"未登录"时显示的唯一界面。
 *
 * 职责边界（照着审计结论走）：
 * - **官方登录页不在这个文件里**：它在华为自己的子窗里由官方页面渲染（二维码也由官方页渲染），
 *   本项目不引入二维码库、不自绘登录页——那等于自实现登录协议，触碰身份边界；
 * - 这里只有引导、状态行与两个按钮（打开官方登录页 / 取消）；
 * - 顶部那条 header 的高度 = `LOGIN_VIEW_TOP_INSET`（与 Rust 子窗让出的位置**同一常量**），
 *   子窗盖上来时正好落在那条下面，正文不被遮住。
 *
 * 视觉只用 shadcn 原语 + Tailwind 工具类：不写 `<style>`、不写内联视觉样式
 * （唯一的例外就是那条几何契约的 `style={{height: LOGIN_VIEW_TOP_INSET}}`——它是几何不是视觉）。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { AUTH_STATUS } from "../shared/channels.ts"
import { LOGIN_VIEW_TOP_INSET } from "../shared/login-inset.mjs"
import { AUTH_CANCEL_LOGIN, AUTH_LOGIN } from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { coreCall, isCoreError, onCoreEvent, rendererReady } from "./host-api"
import {
  LOGIN_GATE_EVENT,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  reduceGateState,
  shouldAutoStartLogin,
} from "./features/auth/login-gate-logic.mjs"

/** `auth:status` 广播的载荷（与 src/shared/channels.ts 的说明同源）。 */
export interface AuthStatusPayload {
  loggedIn: boolean
  busy: boolean
  message?: string
}

export interface AuthGate {
  state: ReturnType<typeof initialGateState>
  startLogin: () => void
  cancelLogin: () => void
}

/**
 * 门禁状态钩子：订阅 `auth:status`、自动发起登录、暴露两个动作。
 *
 * 顺序是硬要求：**先订阅再 `rendererReady()`**。Rust 侧的启动期广播是排队等冲刷的
 * （渲染层没就绪时 emit 会发进空气），反过来的话"已登录"这个事实就丢了。
 */
export function useAuthGate(): AuthGate {
  const [state, setState] = useState(initialGateState)
  const startedRef = useRef(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    void (async () => {
      try {
        unlisten = await onCoreEvent<AuthStatusPayload>(AUTH_STATUS, (payload) => {
          if (disposed) return
          setState((current) =>
            reduceGateState(current, {
              type: LOGIN_GATE_EVENT.status,
              loggedIn: payload?.loggedIn === true,
              busy: payload?.busy === true,
              message: typeof payload?.message === "string" ? payload.message : undefined,
            }),
          )
        })
        await rendererReady()
      } catch {
        // 外壳起不来（例如 core 没启动）不该让界面白屏：门禁照常显示，
        // 用户点"打开官方登录页"会拿到结构化错误（那一句会显示在状态行里）。
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const startLogin = useCallback(() => {
    startedRef.current = true
    setState((current) => reduceGateState(current, { type: LOGIN_GATE_EVENT.started }))
    void (async () => {
      try {
        // 这条调用只回"已受理"（渲染层链路有 60 秒上限，而扫码要好几分钟）：
        // 真正的结论经 auth:status 广播送达。
        await coreCall(AUTH_LOGIN, null)
      } catch (failure) {
        setState((current) =>
          reduceGateState(current, {
            type: LOGIN_GATE_EVENT.failed,
            message: isCoreError(failure) ? failure.message : "登录未开始（详情见日志）",
          }),
        )
      }
    })()
  }, [])

  const cancelLogin = useCallback(() => {
    setState((current) => reduceGateState(current, { type: LOGIN_GATE_EVENT.cancelled }))
    void coreCall(AUTH_CANCEL_LOGIN, null).catch(() => {
      // 取消失败不值得再弹一次错：宿主那侧收场时本来也会把窗拆掉
    })
  }, [])

  // 自动发起：三条件齐备才发起（见 login-gate-logic.mjs）
  useEffect(() => {
    if (!shouldAutoStartLogin(state)) return
    if (startedRef.current) return
    startLogin()
  }, [state, startLogin])

  return { state, startLogin, cancelLogin }
}

/** 引导页本体。 */
export function LoginGate({ gate }: { gate: AuthGate }) {
  const { state, startLogin, cancelLogin } = gate
  const status = loginGateStatusLine(state)

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* 几何契约：这条的高度就是 Rust 登录子窗顶部让出的那一块（同一共享常量） */}
      <header className="flex items-center px-4" style={{ height: LOGIN_VIEW_TOP_INSET }}>
        <span className="text-sm text-muted-foreground">华为账号登录</span>
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>登录后才能使用</CardTitle>
            <CardDescription>
              登录在华为官方的登录窗口里完成：二维码与密码都只由官方页面处理，本应用不接触。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground" role="status">
              {status}
            </p>
            <div className="flex gap-2">
              <Button onClick={startLogin} disabled={!canStartLogin(state)}>
                {state.busy ? "等待扫码…" : "打开官方登录页"}
              </Button>
              {state.busy ? (
                <Button variant="secondary" onClick={cancelLogin}>
                  取消登录
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
