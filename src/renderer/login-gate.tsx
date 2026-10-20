/**
 * 登录门禁（引导页）：主窗在"未登录"时显示的唯一界面。
 *
 * R16 起这一页的形态（用户指令）：**只展示二维码和提示文字**。
 * - 进页面**自动**发起二维码会话（`auth:qr-start`），正常路径**一个按钮都没有**；
 * - 二维码由成熟库 `qrcode`（MIT）渲染到 canvas——不手写二维码组件、不自己编码；
 * - 状态行克制地说清现在到哪一步了（等待扫码 / 已扫待确认 / 已刷新 / 正在完成登录）；
 * - **只有出错**才出现可操作的东西：`重试`（再发一次 `auth:qr-start`，sidecar 会换一张新码），
 *   以及"二维码这条路本身用不了"时的次要入口 `在华为官方页面打开登录`（既有的 `auth:login` 路径）。
 *
 * 顶部那条 header 的高度 = `LOGIN_VIEW_TOP_INSET`（与 Rust 子窗让出的位置**同一常量**）：
 * 走官方页次要入口时子窗正好落在那条下面，正文不被遮住；纯二维码路径下它就是标题条。
 *
 * 视觉只用 shadcn 原语 + Tailwind 工具类：不写 `<style>`、不写内联视觉样式
 * （唯一的例外就是那条几何契约的 `style={{height: LOGIN_VIEW_TOP_INSET}}`——它是几何不是视觉）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import QRCode from "qrcode"

import { AUTH_QR, AUTH_STATUS } from "../shared/channels.ts"
import { LOGIN_VIEW_TOP_INSET } from "../shared/login-inset.mjs"
import { AUTH_LOGIN, AUTH_QR_START } from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { Skeleton } from "./components/ui/skeleton"
import { coreCall, isCoreError, onCoreEvent, rendererReady } from "./host-api"
import {
  LOGIN_GATE_EVENT,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  reduceGateState,
  shouldAutoStartQr,
  shouldOfferOfficialFallback,
} from "./features/auth/login-gate-logic.mjs"

/** 二维码画布边长（CSS 像素）：与实探里官方页用的 208px 同量级，留出静区后手机好扫）。 */
const QR_SIZE_PX = 208

/** `auth:status` 广播的载荷（与 src/shared/channels.ts 的说明同源）。 */
export interface AuthStatusPayload {
  loggedIn: boolean
  busy: boolean
  message?: string
}

/** `auth:qr` 广播的载荷（二维码的生命周期，与 sidecar 的 QR_LOGIN_STATUS 同值）。 */
export interface QrStatusPayload {
  status: string
  content?: string
  expiresInMs?: number
  message?: string
  errorKind?: string
}

export interface AuthGate {
  state: ReturnType<typeof initialGateState>
  /** 发起 / 重新发起二维码（自动开始与"重试"都走这一条） */
  startQr: () => void
  /** 次要入口：打开华为官方登录窗（既有的 auth:login 路径） */
  startLogin: () => void
}

/**
 * 门禁状态钩子：订阅 `auth:status` 与 `auth:qr`、自动发起二维码、暴露两个动作。
 *
 * 顺序是硬要求：**先订阅再 `rendererReady()`**。Rust 侧的启动期广播是排队等冲刷的
 * （渲染层没就绪时 emit 会发进空气），反过来的话"已登录"这个事实就丢了；
 * `auth:qr` 同理——二维码状态是门禁唯一的输入。
 */
export function useAuthGate(): AuthGate {
  const [state, setState] = useState(initialGateState)
  /** 自动开始只发起一次（StrictMode 会重复跑 effect：两次建单 = 白白换掉一张用户正在扫的码） */
  const qrStartedRef = useRef(false)

  useEffect(() => {
    let disposed = false
    let unlistenStatus: (() => void) | null = null
    let unlistenQr: (() => void) | null = null

    void (async () => {
      try {
        unlistenStatus = await onCoreEvent<AuthStatusPayload>(AUTH_STATUS, (payload) => {
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
        unlistenQr = await onCoreEvent<QrStatusPayload>(AUTH_QR, (payload) => {
          if (disposed) return
          setState((current) =>
            reduceGateState(current, {
              type: LOGIN_GATE_EVENT.qr,
              status: payload?.status,
              content: typeof payload?.content === "string" ? payload.content : undefined,
              expiresInMs: typeof payload?.expiresInMs === "number" ? payload.expiresInMs : undefined,
              message: typeof payload?.message === "string" ? payload.message : undefined,
              errorKind: typeof payload?.errorKind === "string" ? payload.errorKind : undefined,
            }),
          )
        })
        await rendererReady()
      } catch {
        // 外壳起不来（例如 core 没启动）不该让界面白屏：门禁照常显示，
        // 用户手里的"重试"会拿到结构化错误（那一句会显示在状态行里）。
      }
    })()

    return () => {
      disposed = true
      unlistenStatus?.()
      unlistenQr?.()
    }
  }, [])

  const startQr = useCallback(() => {
    setState((current) => reduceGateState(current, { type: LOGIN_GATE_EVENT.qrRequested }))
    void (async () => {
      try {
        // 这条调用回的是"这一张二维码是什么"（内容 + 有效期），界面立刻就能画出来；
        // 之后的状态变化经 auth:qr 广播送达（扫码要好几分钟，而这条链路有 60 秒上限）。
        const answer = await coreCall<{ content?: string; expiresInMs?: number }>(AUTH_QR_START, null)
        setState((current) =>
          reduceGateState(current, {
            type: LOGIN_GATE_EVENT.qr,
            status: QR_GATE_STATUS.pending,
            content: typeof answer?.content === "string" ? answer.content : undefined,
            expiresInMs: typeof answer?.expiresInMs === "number" ? answer.expiresInMs : undefined,
          }),
        )
      } catch (failure) {
        setState((current) =>
          reduceGateState(current, {
            type: LOGIN_GATE_EVENT.qrFailed,
            message: isCoreError(failure) ? failure.message : "二维码登录未能开始（详情见日志）",
            errorKind: isCoreError(failure) ? failure.kind : undefined,
          }),
        )
      }
    })()
  }, [])

  const startLogin = useCallback(() => {
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

  // 自动发起：三条件齐备才发起（见 login-gate-logic.mjs）；界面上没有任何按钮做这件事
  useEffect(() => {
    if (!shouldAutoStartQr(state)) return
    if (qrStartedRef.current) return
    qrStartedRef.current = true
    startQr()
  }, [state, startQr])

  return { state, startQr, startLogin }
}

/** 二维码画布：内容换一张就重画（编码与纠错全交给库，这里不碰二维码算法）。 */
function QrCanvas({ content }: { content: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    // 画失败（例如内容异常）不弹错：状态行会说明现在到哪一步，用户还能点"重试"
    void QRCode.toCanvas(canvas, content, {
      width: QR_SIZE_PX,
      margin: 1,
      errorCorrectionLevel: "L",
    }).catch(() => undefined)
  }, [content])

  return (
    <canvas
      ref={canvasRef}
      width={QR_SIZE_PX}
      height={QR_SIZE_PX}
      data-testid="login-qr"
      aria-label="华为账号登录二维码"
      className="rounded-md"
    />
  )
}

/** 引导页本体。 */
export function LoginGate({ gate }: { gate: AuthGate }) {
  const { state, startQr, startLogin } = gate
  const status = loginGateStatusLine(state)
  const content = typeof state.qr.content === "string" && state.qr.content !== "" ? state.qr.content : null

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* 几何契约：这条的高度就是 Rust 登录子窗顶部让出的那一块（同一共享常量） */}
      <header className="flex items-center px-4" style={{ height: LOGIN_VIEW_TOP_INSET }}>
        <span className="text-sm text-muted-foreground">华为账号登录</span>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        {/* 还没有内容时给一块同尺寸的占位：界面不跳、用户知道"马上就来" */}
        {content === null ? (
          <Skeleton className="h-52 w-52 rounded-md" />
        ) : (
          <QrCanvas content={content} />
        )}

        <p className="text-sm text-muted-foreground">{QR_HINT_TEXT}</p>
        <p className="text-sm text-muted-foreground" role="status">
          {status}
        </p>

        {canRetryQr(state) ? (
          <Button variant="secondary" onClick={startQr}>
            重试
          </Button>
        ) : null}

        {shouldOfferOfficialFallback(state) ? (
          <Button variant="link" onClick={startLogin} disabled={!canStartLogin(state)}>
            在华为官方页面打开登录
          </Button>
        ) : null}
      </div>
    </div>
  )
}
