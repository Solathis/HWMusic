/**
 * 登录门禁（引导页）：主窗「未登录」时显示的唯一界面，自上而下居中的二维码一列。
 * 二维码由 `qrcode` 渲染（画法只在 `features/auth/qr-canvas.mjs` 一处），扫码状态经 `auth:qr` 广播回来。
 * 只有出错才出现「重试」；「在网页中打开登录」是常驻次要入口，与二维码会话互斥（关窗后自动回到二维码态）。
 * 视觉只用 shadcn 原语 + Tailwind 工具类；header 高度 = `LOGIN_VIEW_TOP_INSET`。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon } from "lucide-react"

import { AUTH_QR, AUTH_STATUS } from "../shared/channels.ts"
import { LOGIN_VIEW_TOP_INSET } from "../shared/login-inset.mjs"
import {
  AUTH_CANCEL_QR,
  AUTH_GET_STATUS,
  AUTH_LOGIN,
  AUTH_QR_START,
} from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { Skeleton } from "./components/ui/skeleton"
import { coreCall, isCoreError, onCoreEvent, rendererReady } from "./host-api"
import { profileFromStatusPayload } from "./features/auth/account.mjs"

/**
 * 账号资料的渲染层形状（与 `features/auth/account.mjs` 的投影同形；`null` = 认不出任何一项）。
 */
export type AccountProfile = { userName?: string; avatarUrl?: string; vip?: boolean; vipExpiresOn?: string } | null
import {
  LOGIN_GATE_EVENT,
  LOGIN_GATE_PHASE,
  LOGIN_GATE_TITLE,
  LOGIN_OPENING_TESTID,
  LOGIN_OPENING_TEXT,
  QR_COUNTDOWN_TESTID,
  QR_COUNTDOWN_TICK_MS,
  QR_EXPIRED_BOX_HINT,
  QR_EXPIRED_BOX_TEXT,
  QR_GATE_STATUS,
  QR_HINT_TEXT,
  QR_MASK_TESTID,
  QR_REFRESH_LABEL,
  QR_REFRESH_TESTID,
  canRefreshQr,
  canRetryQr,
  initialGateState,
  loginGateStatusLine,
  loginOpeningIndicator,
  qrContentOf,
  qrCountdownText,
  qrMaskText,
  reduceGateState,
  shouldAutoStartQr,
  statusEventOf,
  webLoginEntry,
} from "./features/auth/login-gate-logic.mjs"
import { QR_SIZE_PX, paintQrCanvas } from "./features/auth/qr-canvas.mjs"
import {
  STARTUP_CHECKING_LABEL,
  STARTUP_CHECKING_TESTID,
  STARTUP_NOTICE_TESTID,
  STARTUP_RETRY_LABEL,
  STARTUP_RETRY_TESTID,
  startupCheckingStatusOf,
} from "./features/auth/startup-view.mjs"
import { ThemeControl } from "./theme-control"

/**
 * `auth:status` 广播的载荷（与 src/shared/channels.ts 的说明同源）。
 */
export interface AuthStatusPayload {
  loggedIn: boolean
  busy: boolean
  message?: string
  profile?: {
    userName?: string
    avatarUrl?: string
    vip?: boolean
    vipExpiresOn?: string
  }
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
  /**
   * 账号资料：名字/头像/VIP 三项的可渲染投影，认不出任何一项就是 `null`。
   */
  profile: AccountProfile
  /** 发起 / 重新发起二维码（自动开始、二维码容器点击、"重试"都走这一条） */
  startQr: () => void
  /**
   * 次要入口（打开形态）：打开华为官方登录页（既有的 auth:login 路径；sidecar 会先停掉二维码会话）。
   */
  startLogin: () => void
  /**
   * 重查一次登录状态：真的再发一次 `auth:get-status`，与挂载时那次首查共用 `queryStatus`。
   */
  refreshStatus: () => void
}

/**
 * 一次「查登录状态失败」→ 门禁认得的那条事件（唯一一处构造这句人话）。
 */
function statusFailureEvent(failure: unknown) {
  return {
    type: LOGIN_GATE_EVENT.failed,
    message: isCoreError(failure)
      ? `查询登录状态失败：${failure.message}`
      : "查询登录状态失败（详情见日志）",
  }
}

/**
 * 门禁状态钩子：订阅 `auth:status` 与 `auth:qr`、主动重查一次登录状态、自动发起二维码。
 * 顺序是硬要求：先订阅再 `rendererReady()`，否则排队的启动期广播会丢。
 */
export function useAuthGate(): AuthGate {
  const [state, setState] = useState(initialGateState)
  /** 账号资料：与登录状态来自同一份 `auth:status` 载荷，只是各存一份投影。 */
  const [profile, setProfile] = useState<AccountProfile>(null)
  /** 自动开始只发起一次（StrictMode 会重复跑 effect：两次建单 = 白白换掉一张用户正在扫的码） */
  const qrStartedRef = useRef(false)

  /**
   * 一份 `auth:status` 载荷 → 状态机 + 账号资料（唯一一处 apply）。
   */
  const applyStatusPayload = useCallback((payload: AuthStatusPayload | null | undefined) => {
    setState((current) => reduceGateState(current, statusEventOf(payload)))
    setProfile(profileFromStatusPayload(payload))
  }, [])

  /**
   * 问一次「现在是什么状态」：挂载时的首查与启动屏上的「重新检查登录状态」共用这一处。
   */
  const queryStatus = useCallback(async () => {
    const snapshot = await coreCall<AuthStatusPayload>(AUTH_GET_STATUS, null)
    applyStatusPayload(snapshot)
  }, [applyStatusPayload])

  useEffect(() => {
    let disposed = false
    let unlistenStatus: (() => void) | null = null
    let unlistenQr: (() => void) | null = null

    void (async () => {
      try {
        unlistenStatus = await onCoreEvent<AuthStatusPayload>(AUTH_STATUS, (payload) => {
          if (disposed) return
          applyStatusPayload(payload)
        })
        unlistenQr = await onCoreEvent<QrStatusPayload>(AUTH_QR, (payload) => {
          if (disposed) return
          setState((current) =>
            reduceGateState(current, {
              type: LOGIN_GATE_EVENT.qr,
              status: payload?.status,
              content: typeof payload?.content === "string" ? payload.content : undefined,
              expiresInMs: typeof payload?.expiresInMs === "number" ? payload.expiresInMs : undefined,
              // 到期时刻由「收到这条的时刻 + 有效期」算出来（钟只有这一侧有）
              at: Date.now(),
              message: typeof payload?.message === "string" ? payload.message : undefined,
              errorKind: typeof payload?.errorKind === "string" ? payload.errorKind : undefined,
            }),
          )
        })
        await rendererReady()
        // 订阅就位、启动期队列冲刷过之后，主动问一次当前状态（见本钩子的说明）
        await queryStatus()
      } catch (failure) {
        // 外壳起不来（core 没启动、查询频道还不存在）不该让界面白屏，但也不许猜档位：
        // 查不到是「还不知道」，如实放到启动屏上，别空转。
        if (disposed) return
        setState((current) => reduceGateState(current, statusFailureEvent(failure)))
      }
    })()

    return () => {
      disposed = true
      unlistenStatus?.()
      unlistenQr?.()
    }
  }, [applyStatusPayload, queryStatus])

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
            // 倒计时的起点就是这条应答落地的时刻（新码 + 倒计时一起重置）
            at: Date.now(),
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

  /**
   * 「重新检查登录状态」真的再发一次 `auth:get-status`，不猜档位。
   */
  const refreshStatus = useCallback(() => {
    void (async () => {
      try {
        await queryStatus()
      } catch (failure) {
        setState((current) => reduceGateState(current, statusFailureEvent(failure)))
      }
    })()
  }, [queryStatus])

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

  /**
   * 「返回扫码登录」已搬出本文件，现在浮在官方页之上。
   */

  // 自动发起：四条件齐备才发起，用 ref 挡住 StrictMode 的重复建单。
  useEffect(() => {
    if (!shouldAutoStartQr(state)) return
    if (qrStartedRef.current && state.officialNote === null) return
    qrStartedRef.current = true
    startQr()
  }, [state, startQr])

  /**
   * 门禁离开（阶段变"已登录" / 组件卸载）就停掉自己发起的那张码——继续轮询只是在替
   * 一张没人看的码空转。`qrStartedRef` 守卫：没发起过就不发，StrictMode 双挂载也不会多发。
   */
  const loggedIn = state.phase === LOGIN_GATE_PHASE.loggedIn
  useEffect(() => {
    if (!loggedIn || !qrStartedRef.current) return
    qrStartedRef.current = false
    void coreCall(AUTH_CANCEL_QR, null).catch(() => undefined)
  }, [loggedIn])

  useEffect(() => {
    return () => {
      if (!qrStartedRef.current) return
      qrStartedRef.current = false
      void coreCall(AUTH_CANCEL_QR, null).catch(() => undefined)
    }
  }, [])

  /**
   * 倒计时每秒喂一次 `tick`，只在有到期时刻可数时开表。
   */
  const expiresAt = state.qr.expiresAt
  useEffect(() => {
    if (expiresAt === null) return
    const timer = setInterval(() => {
      setState((current) => reduceGateState(current, { type: LOGIN_GATE_EVENT.tick, nowMs: Date.now() }))
    }, QR_COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [expiresAt])

  return { state, profile, startQr, startLogin, refreshStatus }
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

/**
 * 启动第一屏：`checking` 那一档的安静中性界面，只有一枚转圈。
 * 查询真的失败时长出原因、重新检查与在网页中打开登录两条出路。
 */
export function StartupChecking({ gate }: { gate: AuthGate }) {
  const notice = startupCheckingStatusOf(gate.state)
  // 网页登录入口的形态/文案/锚点仍由门禁逻辑给（唯一真源）：这一刻它只可能是"打开"
  const entry = webLoginEntry(gate.state)

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6"
      data-testid={STARTUP_CHECKING_TESTID}
      role="status"
      aria-busy="true"
      aria-label={STARTUP_CHECKING_LABEL}
    >
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      {notice.text === null ? null : (
        <p className="max-w-sm text-center text-sm text-muted-foreground" data-testid={STARTUP_NOTICE_TESTID}>
          {notice.text}
        </p>
      )}
      {notice.canRetry ? (
        <Button variant="secondary" size="sm" onClick={gate.refreshStatus} data-testid={STARTUP_RETRY_TESTID}>
          {STARTUP_RETRY_LABEL}
        </Button>
      ) : null}
      {notice.canWebLogin && entry.form === "open" ? (
        <Button
          variant="link"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={gate.startLogin}
          data-testid={entry.testid}
        >
          {entry.text}
        </Button>
      ) : null}
    </div>
  )
}

/** 引导页本体。 */
export function LoginGate({ gate }: { gate: AuthGate }) {
  const { state, startQr, startLogin } = gate
  const status = loginGateStatusLine(state)
  const content = qrContentOf(state)
  const countdown = qrCountdownText(state)
  const expired = state.qr.status === QR_GATE_STATUS.expired
  const entry = webLoginEntry(state)
  /** 官方页还在屏外加载那一刻（文案与转圈读同一个判定）。 */
  const opening = loginOpeningIndicator(state)
  /** 扫到之后盖在二维码上的那句话。 */
  const maskText = qrMaskText(state)

  /**
   * 次要入口（只有一处定义）：打开官方登录页；`back` 已搬到浮动 webview。
   */
  const entryButton = (
    <Button
      variant="link"
      size="sm"
      className="text-xs text-muted-foreground"
      onClick={startLogin}
      disabled={entry.disabled}
      data-testid={entry.testid}
    >
      {entry.text}
    </Button>
  )

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* 顶部是门禁自己的标题区，右上角放主题控件。 */}
      <header className="flex items-center justify-end px-4" style={{ height: LOGIN_VIEW_TOP_INSET }}>
        <ThemeControl />
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        {/* 标题：居中放在二维码**正上方**（语义标题元素，不是 CardTitle：这一页不用 Card 铺陈） */}
        <h1 className="text-center text-lg font-medium">{LOGIN_GATE_TITLE}</h1>

        {/* 二维码容器：容器本身可点换码，过期给「已过期」占位，已扫过的码盖一层遮罩。 */}
        <Button
          variant="ghost"
          className="h-auto rounded-lg border-border bg-card p-3 hover:bg-card"
          onClick={startQr}
          disabled={!canRefreshQr(state)}
          aria-label={QR_REFRESH_LABEL}
          data-testid={QR_REFRESH_TESTID}
        >
          {content === null ? (
            expired ? (
              <div className="flex h-52 w-52 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border">
                <span className="text-sm text-muted-foreground">{QR_EXPIRED_BOX_TEXT}</span>
                <span className="text-sm text-muted-foreground">{QR_EXPIRED_BOX_HINT}</span>
              </div>
            ) : (
              <Skeleton className="h-52 w-52 rounded-md" />
            )
          ) : (
            // `relative` 是遮蔽层的定位上下文。
            <span className="relative block">
              <QrCanvas content={content} />
              {maskText === null ? null : (
                <span
                  className="absolute inset-0 flex items-center justify-center rounded-md bg-background/85 px-4 text-center text-sm text-foreground backdrop-blur-sm"
                  data-testid={QR_MASK_TESTID}
                >
                  {maskText}
                </span>
              )}
            </span>
          )}
        </Button>

        {/* 倒计时：二维码下方那一行，本地归零时说「正在确认过期…」。 */}
        {countdown === null ? null : (
          <p className="text-center text-sm text-muted-foreground" data-testid={QR_COUNTDOWN_TESTID}>
            {countdown}
          </p>
        )}

        <p className="max-w-xs text-center text-sm text-muted-foreground">{QR_HINT_TEXT}</p>
        {/* 状态行：`null` 的档整行不渲染；官方页加载中显示转圈与提示。 */}
        {status === null ? null : (
          <p className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground" role="status">
            {opening.showing ? (
              <Loader2Icon
                className="size-4 animate-spin"
                aria-hidden="true"
                data-testid={LOGIN_OPENING_TESTID}
              />
            ) : null}
            {status}
          </p>
        )}

        {canRetryQr(state) ? (
          <Button variant="secondary" size="sm" onClick={startQr}>
            重试
          </Button>
        ) : null}

        {/* 正文只剩「在网页中打开登录」这一种形态。 */}
        {entry.form === "open" ? entryButton : null}
      </div>
    </div>
  )
}
