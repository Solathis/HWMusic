/**
 * 登录门禁（引导页）：主窗在"未登录"时显示的唯一界面。
 *
 * R16 起这一页（用户指令）：只展示二维码和提示文字，进页面**自动**发起二维码会话
 * （`auth:qr-start`），扫码状态经 `auth:qr` 广播回来。
 *
 * R18 起（用户指令 2026-10-20）形态是**自上而下居中一列**：
 *
 * ```
 *   ┌ 顶部 header（高度 = LOGIN_VIEW_TOP_INSET，品牌）────────────┐
 *   │  华为账号登录                                               │ ← 标题（只在正上方这一处）
 *   │  ┌───────────┐                                             │
 *   │  │  二维码    │  ← 带边框的容器（令牌 + 工具类，零自定义 CSS）  │
 *   │  └───────────┘                                             │
 *   │  手机「控制中心」>「扫一扫」…。（提示文字，唯一真源）            │
 *   │  等待扫码…（状态行，克制一行）                                │
 *   │  [重试]（只在失败态）                                        │
 *   │  在网页中打开登录（**常驻**次要入口，走既有 auth:login 路径）    │
 *   └────────────────────────────────────────────────────────────┘
 * ```
 *
 * 三条要点：
 * - 二维码由成熟库 `qrcode`（MIT）渲染到 canvas——不手写二维码组件、不自己编码；
 *   画法只有 `features/auth/qr-canvas.mjs` 一处（内容一换就重画：过期自动换新靠这一跳）；
 * - **只有出错**才出现 `重试`；"在网页中打开登录"是常驻的次要入口（克制的 link 形态），
 *   点了走 R7 的官方登录子窗；**两条路互斥**——sidecar 开窗前会停掉二维码会话，
 *   窗关掉/失败之后界面自动回到二维码态（判定见 `login-gate-logic.mjs` 的不变量 6）；
 * - 顶部那条 header 的高度 = `LOGIN_VIEW_TOP_INSET`（与 Rust 子窗让出的位置**同一常量**）：
 *   走网页入口时子窗正好落在那条下面，正文不被遮住。R18 起标题搬到了二维码正上方，
 *   header 里只剩品牌——**标题全页只出现一次**。
 *
 * 视觉只用 shadcn 原语 + Tailwind 工具类：不写 `<style>`、不写内联视觉样式
 * （唯一的例外就是那条几何契约的 `style={{height: LOGIN_VIEW_TOP_INSET}}`——它是几何不是视觉）。
 *
 * R19：挂载时除了订阅 `auth:status`，还要**主动查一次** `auth:get-status`。`auth:status` 只在
 * sidecar 启动时播一次（Rust 的排队冲刷也只发生一次），渲染层 reload/崩溃重启之后就再也收不到
 * ——门禁会永久停在 checking。查询的应答与广播喂同一个 `statusEventOf` 映射。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { AUTH_QR, AUTH_STATUS } from "../shared/channels.ts"
import { LOGIN_VIEW_TOP_INSET } from "../shared/login-inset.mjs"
import { AUTH_LOGIN, AUTH_GET_STATUS, AUTH_QR_START } from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { Skeleton } from "./components/ui/skeleton"
import { coreCall, isCoreError, onCoreEvent, rendererReady } from "./host-api"
import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_TITLE,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  WEB_LOGIN_ENTRY_TESTID,
  WEB_LOGIN_ENTRY_TEXT,
  canRetryQr,
  canStartLogin,
  initialGateState,
  loginGateStatusLine,
  qrContentOf,
  reduceGateState,
  shouldAutoStartQr,
} from "./features/auth/login-gate-logic.mjs"
import { QR_SIZE_PX, paintQrCanvas } from "./features/auth/qr-canvas.mjs"

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
  /** 次要入口：打开华为官方登录窗（既有的 auth:login 路径；sidecar 会先停掉二维码会话） */
  startLogin: () => void
}

/**
 * 一份 `auth:status` 形状的载荷 → 门禁认得的那条状态事件。
 *
 * 广播回调与 R19 的查询应答**都走这一个映射**：两处各写一份，早晚会出现"广播那条改了、
 * 查询这条没跟上"——而它们说的是同一件事（会话有没有、开窗那条路忙不忙）。
 */
function statusEventOf(payload: AuthStatusPayload | null | undefined) {
  return {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: payload?.loggedIn === true,
    busy: payload?.busy === true,
    message: typeof payload?.message === "string" ? payload.message : undefined,
  }
}

/**
 * 门禁状态钩子：订阅 `auth:status` 与 `auth:qr`、**主动重查一次**登录状态、自动发起二维码、
 * 暴露两个动作。
 *
 * 顺序是硬要求：**先订阅再 `rendererReady()`**。Rust 侧的启动期广播是排队等冲刷的
 * （渲染层没就绪时 emit 会发进空气），反过来的话"已登录"这个事实就丢了；
 * `auth:qr` 同理——二维码状态是门禁唯一的输入。
 *
 * R19：报完就绪还要经 `coreCall` 用共享常量 `AUTH_GET_STATUS` 问一次**当前**状态。理由是这个缺口是真的：
 * `auth:status` 只在 sidecar 启动时播一次，而 Rust 的冲刷**只发生一次**——渲染层 reload /
 * 崩溃重启之后那一条已经冲刷过了，门禁于是永远停在 `checking`（"正在检查登录状态…"），
 * 既不自动发起二维码，也没有任何报错。广播答不了"现在的状态是什么"，那要靠一次查询。
 * 查询排在冲刷**之后**：这样它的答案一定不比队列里那条旧广播更旧。
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
          setState((current) => reduceGateState(current, statusEventOf(payload)))
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
        // 订阅就位、启动期队列冲刷过之后，主动问一次当前状态（见本钩子的说明）
        const snapshot = await coreCall<AuthStatusPayload>(AUTH_GET_STATUS, null)
        if (disposed) return
        setState((current) => reduceGateState(current, statusEventOf(snapshot)))
      } catch (failure) {
        // 外壳起不来（core 没启动、查询频道还不存在）不该让界面白屏，但**也不许猜档位**：
        // 查不到是"还不知道"，不是"未登录"。如实把那句话放到状态行上——空转的
        // "正在检查登录状态…"正是 R19 要消灭的那个现象，用户至少还看得见原因，
        // 并且能走常驻的「在网页中打开登录」。
        if (disposed) return
        setState((current) =>
          reduceGateState(current, {
            type: LOGIN_GATE_EVENT.failed,
            message: isCoreError(failure)
              ? `查询登录状态失败：${failure.message}`
              : "查询登录状态失败（详情见日志）",
          }),
        )
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
        // 真正的结论经 auth:status 广播送达。停二维码轮询在 sidecar 里做（两条路互斥）。
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

  // 自动发起：四条件齐备才发起（见 login-gate-logic.mjs）；界面上没有任何按钮做这件事。
  //
  // StrictMode 会把 effect 跑两遍（第二遍拿到的还是同一份旧状态），所以用 ref 挡住重复建单
  // ——两次建单 = 白白换掉一张用户正在扫的码。R18 从网页那条路退回来时**必须**能再发起一次：
  // 那种状态带着 `officialNote`（"那条路怎么了"），它就是"这一轮该重新发码"的标记。
  useEffect(() => {
    if (!shouldAutoStartQr(state)) return
    if (qrStartedRef.current && state.officialNote === null) return
    qrStartedRef.current = true
    startQr()
  }, [state, startQr])

  return { state, startQr, startLogin }
}

/** 二维码画布：内容换一张就重画（编码与纠错全交给库，这里不碰二维码算法）。 */
function QrCanvas({ content }: { content: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    // 画失败（例如内容异常）不弹错：状态行会说明现在到哪一步，用户还能点"重试"。
    // 依赖是**内容本身**：过期换新（expired → 新 pending）就是靠这里重画的。
    void paintQrCanvas(canvasRef.current, content).catch(() => undefined)
  }, [content])

  return (
    <canvas
      ref={canvasRef}
      width={QR_SIZE_PX}
      height={QR_SIZE_PX}
      data-testid="login-qr"
      aria-label="登录二维码"
      className="rounded-md"
    />
  )
}

/** 引导页本体。 */
export function LoginGate({ gate }: { gate: AuthGate }) {
  const { state, startQr, startLogin } = gate
  const status = loginGateStatusLine(state)
  const content = qrContentOf(state)

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* 几何契约：这条的高度就是 Rust 登录子窗顶部让出的那一块（同一共享常量）。
          R18 起标题搬到二维码正上方，这条只留品牌——标题全页只出现一次。 */}
      <header className="flex items-center px-4" style={{ height: LOGIN_VIEW_TOP_INSET }}>
        <span className="text-sm font-medium">{APP_BRAND_LABEL}</span>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        {/* 标题：居中放在二维码**正上方**（语义标题元素，不是 CardTitle：这一页不用 Card 铺陈） */}
        <h1 className="text-center text-lg font-medium">{LOGIN_GATE_TITLE}</h1>

        {/* 二维码容器：边框与圆角走设计令牌 + 工具类（零自定义 CSS）；还没有内容时给同尺寸占位，
            界面不跳、用户知道"马上就来" */}
        <div className="rounded-lg border border-border bg-card p-3">
          {content === null ? (
            <Skeleton className="h-52 w-52 rounded-md" />
          ) : (
            <QrCanvas content={content} />
          )}
        </div>

        <p className="max-w-xs text-center text-sm text-muted-foreground">{QR_HINT_TEXT}</p>
        <p className="text-center text-sm text-muted-foreground" role="status">
          {status}
        </p>

        {canRetryQr(state) ? (
          <Button variant="secondary" size="sm" onClick={startQr}>
            重试
          </Button>
        ) : null}

        <Button
          variant="link"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={startLogin}
          disabled={!canStartLogin(state)}
          data-testid={WEB_LOGIN_ENTRY_TESTID}
        >
          {WEB_LOGIN_ENTRY_TEXT}
        </Button>
      </div>
    </div>
  )
}
