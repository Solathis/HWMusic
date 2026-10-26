/**
 * 登录门禁（引导页）：主窗在"未登录"时显示的唯一界面。
 *
 * R16 起这一页（用户指令）：只展示二维码和提示文字，进页面**自动**发起二维码会话
 * （`auth:qr-start`），扫码状态经 `auth:qr` 广播回来。
 *
 * R18 起（用户指令 2026-10-20）形态是**自上而下居中一列**：
 *
 * ```
 *   ┌ 顶部 header（高度 = LOGIN_VIEW_TOP_INSET，R20 起**没有任何文字**）─────────┐
 *   │  华为账号登录                                               │ ← 标题（只在正上方这一处）
 *   │  ┌───────────┐                                             │
 *   │  │  二维码    │  ← 带边框的容器（令牌 + 工具类，零自定义 CSS）  │
 *   │  └───────────┘     R20 起它本身是个 <button>：点它就是刷新      │
 *   │  手机「控制中心」>「扫一扫」…。（提示文字，唯一真源）            │
 *   │  等待扫码…（状态行，克制一行）                                │
 *   │  [重试]（只在失败态）                                        │
 *   │  在网页中打开登录（**常驻**次要入口，走既有 auth:login 路径）    │
 *   └────────────────────────────────────────────────────────────┘
 * ```
 *
 * R20（用户真机验收反馈三项）在这一页上改了四处：
 * 1. **header 里那句品牌删掉**——它与窗口标题栏重复；header 结构保留（48px 契约、对位），
 *    只是不再有任何可见文字；
 * 2. **二维码容器可点刷新**：容器本身是 shadcn 的 `Button`（键盘可达、有可达名字
 *    [`QR_REFRESH_LABEL`]），点击 = `startQr`（换一张新码）；
 * 3. **过期码不留屏**：`expired` 到达时逻辑层撤掉内容 → 这里自然回到同尺寸占位
 *    （死码留在屏上=让用户去扫一张必然没反应的码）；
 * 4. **网页登录窗开着时入口变形**：子窗铺满内容区（顶部只留那条 header），正文里的一切都
 *    在窗底下——所以「返回扫码登录」这一形态**挪进 header**（那一刻唯一可达的控件），
 *    点击走 `auth:cancel-login`（关窗）→ 那条路的收场广播 → R18 的 `returnToQr` 链回到二维码态
 *    并重新发码。入口元素只有一处定义（`entry`），两种形态共用它。
 *
 * R21（用户指令 2026-10-20，**推翻 R16/R20 的"过期自动换新"**）在这一页上加了三处：
 * 1. **倒计时**：二维码下方那一行（[`qrCountdownText`]），由本页自己的 `setInterval`
 *    每秒喂一条 `tick` 事件驱动——只在"有到期时刻"时才开表，本地数到 0 之后 reducer
 *    返回同一个状态对象，React 不再重渲染（表停在那里等服务端的 `expired`）；
 * 2. **过期态不可扫**：`expired` 时容器里不再是 Skeleton（那读起来像"马上就来"），
 *    而是一块同尺寸的过期占位（[`QR_EXPIRED_BOX_TEXT`]）——canvas 撤下，屏上没有任何
 *    可扫的东西；
 * 3. **过期态多一个显著的「刷新二维码」按钮**（文案复用 [`QR_REFRESH_LABEL`]）：sidecar
 *    不再自动换新，所以换码只剩手动这一条路；它走的是与容器、自动发起同一个 `startQr`。
 *
 * 三条要点：
 * - 二维码由成熟库 `qrcode`（MIT）渲染到 canvas——不手写二维码组件、不自己编码；
 *   画法只有 `features/auth/qr-canvas.mjs` 一处（内容一换就重画）；
 * - **只有出错**才出现 `重试`；"在网页中打开登录"是常驻的次要入口（克制的 link 形态），
 *   点了走 R7 的官方登录子窗；**两条路互斥**——sidecar 开窗前会停掉二维码会话，
 *   窗关掉/失败之后界面自动回到二维码态（判定见 `login-gate-logic.mjs` 的不变量 6）；
 * - 顶部那条 header 的高度 = `LOGIN_VIEW_TOP_INSET`（与 Rust 子窗让出的位置**同一常量**）：
 *   走网页入口时子窗正好落在那条下面，正文不被遮住；R20 起它同时是"返回"控件在窗开着时的
 *   唯一落点。
 *
 * 视觉只用 shadcn 原语 + Tailwind 工具类：不写 `<style>`、不写内联视觉样式
 * （唯一的例外就是那条几何契约的 `style={{height: LOGIN_VIEW_TOP_INSET}}`——它是几何不是视觉）。
 *
 * R19：挂载时除了订阅 `auth:status`，还要**主动查一次** `auth:get-status`。`auth:status` 只在
 * sidecar 启动时播一次（Rust 的排队冲刷也只发生一次），渲染层 reload/崩溃重启之后就再也收不到
 * ——门禁会永久停在 checking。查询的应答与广播喂同一个 `statusEventOf` 映射。
 *
 * R25（用户指令 2026-10-20，登录体验四项改造）在这一页上又改了四处：
 * 1. **过期遮罩只有两行**：「二维码已过期」/「点击刷新」（[`QR_EXPIRED_BOX_HINT`]）；
 * 2. **过期态那个「刷新二维码」按钮删掉**——二维码容器本身就是刷新控件（R20 起可点），
 *    它一直可点，不需要第二个入口；
 * 3. **右上角放主题控件**（[`ThemeControl`]，浅色 / 深色 / 跟随系统；用户四项之 4 的 gate 侧）；
 * 4. **「返回扫码登录」搬出门禁**：官方页 R25 起铺满整个主窗，这一层整个在它底下，
 *    那个控件现在由浮动 webview `login-return` 渲染（`login-chrome.tsx`）。
 *    于是这一页不再 import `AUTH_CANCEL_LOGIN`，也不再暴露 `backToQr`——
 *    取消登录只剩**一条**入口（浮动控件 → `core_login_chrome {action:"return"}`）。
 *
 * 顶部那条 header（高度仍 = [`LOGIN_VIEW_TOP_INSET`]）现在只是门禁自己的标题区：
 * R25 起登录页**不再**从它下面开始（官方页铺满整窗），它不再是"给子窗让位"的几何契约。
 *
 * R37（用户真机反馈之 2）在这一页上补了一处：**已经扫过的那张二维码要被遮住**。
 * 用户报的现象是"已经扫了码，屏上那张码看起来还能扫"（再扫一次会发生什么没人知道）——
 * 所以 `scanned`/`confirmed` 两档在 canvas 上叠一层（半透明令牌背景 + 状态文案，判定与文案
 * 都在逻辑模块里：[`qrMaskText`]），同时容器不可点。码本身仍然画在底下：手机那边正在确认的
 * 就是它，动态二维码没有"半张"这一说。
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
 *
 * 类型写在 TS 这一侧而不是从 `.mjs` 里 import：那个模块是纯 JS（跑在 node 测试里），
 * 形状的唯一真源是它的 `profileFromStatusPayload`——类型只是给编辑器用的镜像。
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
 *
 * R38 增补可选 `profile`（名字/头像/VIP）：**旧载荷没有这个键也必须能认**——
 * 它是可选字段，解析一律走 `profileFromStatusPayload`（认不出就返回 `null`，界面走兜底）。
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
   * 账号资料（R38）：名字/头像/VIP 三项的**可渲染投影**，认不出任何一项就是 `null`。
   *
   * 为什么由门禁这一层给出：`auth:status` 的订阅与 R19 的那次主动查询都在这里，
   * 资料与登录状态**来自同一份载荷**——另起一处订阅会让"状态说已登录、资料说没登录"这种事
   * 有地方长出来。左下角账号区（App 的 SidebarFooter）只是它的消费者。
   */
  profile: AccountProfile
  /** 发起 / 重新发起二维码（自动开始、二维码容器点击、"重试"都走这一条） */
  startQr: () => void
  /**
   * 次要入口（打开形态）：打开华为官方登录页（既有的 auth:login 路径；sidecar 会先停掉二维码会话）。
   *
   * R25：「返回扫码登录」**不在这里**——它浮在官方页之上（浮动 webview `login-return`），
   * 走的是专用命令 `core_login_chrome {action:"return"}`（见 `login-chrome.tsx`）。
   * 门禁这一层在官方页开着时整个被盖住，在这儿留一条取消路径等于留一条点不到的路径。
   */
  startLogin: () => void
  /**
   * 重查一次登录状态（复审 R45A1）：真的再发一次 `auth:get-status`。
   *
   * 谁调它：中性启动屏上那条「重新检查登录状态」（`checking` + 查询失败时唯一可操作的动作之一）。
   * 与挂载时那次首查**同一处实现**（`queryStatus`）——两处各写一份 `coreCall` 的下场是
   * "按钮看起来一样、发的是另一条请求"。失败时仍落回同一句失败说明（不猜档位）。
   */
  refreshStatus: () => void
}

/**
 * 一次"查登录状态失败" → 门禁认得的那条事件（**唯一一处**构造这句人话）。
 *
 * 两处会走到这里：挂载时的首查失败、启动屏上「重新检查登录状态」失败。两处说的是同一件事
 * （"没答上来，但别猜"），所以文案与事件形状只有这一份。
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
  /** 账号资料（R38）：与登录状态来自**同一份** `auth:status` 载荷，只是各存一份投影。 */
  const [profile, setProfile] = useState<AccountProfile>(null)
  /** 自动开始只发起一次（StrictMode 会重复跑 effect：两次建单 = 白白换掉一张用户正在扫的码） */
  const qrStartedRef = useRef(false)

  /**
   * 一份 `auth:status` 载荷 → 状态机 + 账号资料（**唯一一处 apply**）。
   *
   * 广播回调与 `auth:get-status` 的应答（无论首查还是「重新检查」）都经它：两处各写一份，
   * 早晚会出现"广播那条改了、查询这条没跟上"——而它们说的是同一件事。
   */
  const applyStatusPayload = useCallback((payload: AuthStatusPayload | null | undefined) => {
    setState((current) => reduceGateState(current, statusEventOf(payload)))
    setProfile(profileFromStatusPayload(payload))
  }, [])

  /**
   * 问一次"现在是什么状态"（R19 增补，复审 R45A1 起有**两个**调用者）：
   * 挂载时的首查（effect 里，排在订阅与 `rendererReady` 之后）与启动屏上的「重新检查登录状态」。
   *
   * 为什么必须只有这一处：那个按钮的语义就是"再问一次同一个问题"。另写一份 `coreCall`
   * 会让两处请求的参数/映射悄悄分叉，而用户看不出区别（按钮长得一样）。
   * 失败**不在这里吞**：交给调用方决定说什么（挂载那次与重试那次说的是同一句，
   * 见 `statusFailureEvent`）。
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
              // R21：到期时刻由"收到这条的时刻 + 有效期"算出来（钟只有这一侧有）
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
        // 外壳起不来（core 没启动、查询频道还不存在）不该让界面白屏，但**也不许猜档位**：
        // 查不到是"还不知道"，不是"未登录"。如实把那句话放到启动屏上——空转的
        // "正在检查登录状态…"正是 R19 要消灭的那个现象，用户至少还看得见原因，
        // 并且能按「重新检查登录状态」或走网页登录那条路。
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
            // R21：倒计时的起点就是这条应答落地的时刻（新码 + 倒计时一起重置）
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
   * 「重新检查登录状态」（复审 R45A1）：真的再发一次 `auth:get-status`。
   *
   * 只在启动屏（`checking` + 查询失败）上出现：那一档不许画成登录页，但也不能让用户困在
   * 一张永远安静的屏上。失败照旧落回同一句说明（`statusFailureEvent`），**不猜档位**——
   * 猜"未登录"会白建一张码，猜"已登录"会把没登录的用户放进主界面。
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
   * 「返回扫码登录」（R20）在 R25 里**搬出了这个文件**：它现在浮在官方页**之上**
   * （浮动 webview `login-return` → `login-chrome.tsx` → 专用命令 `core_login_chrome{action:"return"}`）。
   *
   * 为什么不能留在这一层：官方页 R25 起铺满整个主窗，门禁这棵子树整个在它底下——
   * 在这儿渲染的"返回"用户看得见才怪。搬走同时消掉了第二条取消路径
   *（原来是 `auth:cancel-login`，现在是同一条命令落到**同一个结论槽** `login::cancel_login`）。
   */

  // 自动发起：四条件齐备才发起（见 login-gate-logic.mjs）；界面上没有任何按钮做这件事。
  //
  // StrictMode 会把 effect 跑两遍（第二遍拿到的还是同一份旧状态），所以用 ref 挡住重复建单
  // ——两次建单 = 白白换掉一张用户正在扫的码。R18 从网页那条路退回来时**必须**能再发起一次：
  // 那种状态带着 `officialNote`（"那条路怎么了"），它就是"这一轮该重新发码"的标记。
  // R21：过期**不在**这条路上（`qrAttempted` 不会被过期打回 false）——换码只能由用户点击触发。
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
   * 倒计时（R21）：每秒喂一次 `tick`，钟由这一侧提供（逻辑模块是纯函数，不读真实时钟）。
   *
   * 只在"有到期时刻可数"时开表：其余档位（没有码、已经过期、失败）一秒一次的重渲染纯属浪费。
   * 本地数到 0 之后 reducer 会把钟钳在到期时刻并返回**同一个状态对象**，React 因此不再重渲染
   * ——表停在那里等 sidecar 那条 `expired` 广播（过期判定不在这一侧）。
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
 * R45A1（用户第 10 项）· **启动第一屏**：`checking` 那一档的安静中性界面。
 *
 * 为什么需要它：已登录的会话冷启动时，门禁的第一帧是 `checking`（"还不知道"）——
 * 那是 `useAuthGate` 的 `useState` 初值，`auth:status` 广播 / `auth:get-status` 应答
 * 要等一次 IPC 往返才到。旧外壳把这一档与"未登录"画成同一个界面，于是**第一帧就是整张
 * 登录页**（标题、二维码占位、提示、"正在检查登录状态…"），快照落地才翻成主界面——
 * 用户看见的就是"启动先闪一下登录页"。
 *
 * 这一屏的形态是**有意的克制**（用户要求"安静中性"）：
 * - 只有一枚既有图标库的转圈（`Loader2Icon` + `animate-spin`，muted 前景色）；
 *   **没有二维码、没有标题、没有提示、没有主题控件**——那些都是"确定未登录"之后才该出现的东西；
 * - `role="status"` + `aria-busy` + `aria-label`（[`STARTUP_CHECKING_LABEL`]）让读屏用户
 *   知道应用在启动。
 *
 * **复审 R45A1**：安静 ≠ 无声地空转。查询**真的失败**时这一屏自己长出三件东西
 * （判定见 `startupCheckingStatusOf`，纯函数）：
 *
 * 1. 一句原因（失败说明，来自状态机唯一那处构造）；
 * 2. 「重新检查登录状态」——真的再发一次 `auth:get-status`（`gate.refreshStatus`）；
 * 3. 「在网页中打开登录」——原来那条出路（同一条 `auth:login`）。
 *
 * 为什么不能像上一版那样把失败档画成 `LoginGate`：合同要求 `checking` **绝不**渲染
 * LoginGate/二维码。失败不是"确定未登录"，那样做等于用一张可能不需要的码盖住一个还没查完
 * 的会话——而且二维码会在那一刻被自动建单（`shouldAutoStartQr` 只认确定未登录，这里不会）。
 *
 * 它**不延长任何东西**：没有延迟、没有隐藏、没有定时器（`test/startup-view.test.mjs` 钉）。
 * 状态一到就换成 app-shell 或登录页——它只是"还不知道"那一刻本来的样子。
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
  /** R27：官方页还在屏外加载那一刻（那一行的文案与转圈读**同一个判定**）。 */
  const opening = loginOpeningIndicator(state)
  /** R37：扫到之后盖在二维码上的那句话（`null` = 这一档不盖；判定见逻辑模块）。 */
  const maskText = qrMaskText(state)

  /**
   * 次要入口（**只有一处定义**）。
   *
   * `open`：打开官方登录页（既有的 auth:login）。
   * `back`（R20）：**R25 起不再由这里渲染**——「返回扫码登录」要浮在官方页**之上**
   * （用户指令：不独占一行、不挤压网页），落点是浮动 webview `login-return`
   * （`login-chrome.tsx`，文案与锚点是同一份常量）。gate 这一层此刻整个被官方页盖着，
   * 在这儿画它等于画在别人的地板底下。
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
      {/* 顶部那条仍然是页面自己的 header（高度 = 共享常量 `LOGIN_VIEW_TOP_INSET`）。
          R25：登录页**不再**让出这一条（它铺满整窗），所以这条不再是"给子窗让位"的几何契约，
          而是门禁自己的标题区；右上角放主题控件（用户四项之 4：gate 视图也要有）。
          它被官方页盖住时不可见也无碍——那一刻主题控件由浮动 `login-theme` webview 顶上。 */}
      <header className="flex items-center justify-end px-4" style={{ height: LOGIN_VIEW_TOP_INSET }}>
        <ThemeControl />
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        {/* 标题：居中放在二维码**正上方**（语义标题元素，不是 CardTitle：这一页不用 Card 铺陈） */}
        <h1 className="text-center text-lg font-medium">{LOGIN_GATE_TITLE}</h1>

        {/* 二维码容器：边框与圆角走设计令牌 + 工具类（零自定义 CSS）；还没有内容时给同尺寸占位，
            界面不跳、用户知道"马上就来"。R20 起容器本身可点（换一张新码）；R21 起过期态
            也点得动——**那是唯一的换码路径**（sidecar 不再自动换新）。
            过期时给的是"已过期"占位而不是 Skeleton：Skeleton 读起来像"马上就来"，而这一档
            要等的正是用户点一下。canvas 撤下 → 屏上没有任何可扫的东西。
            R25（用户指令）：过期占位**只有两行**——「二维码已过期」/「点击刷新」；原来那个显著的
            「刷新二维码」按钮删掉（容器自己就是那个控件，它一直可点）。
            R37（用户真机反馈）：**已经扫过的那张码会被遮住**——码还在画布上（它还有用，手机那边
            正在确认），但上面叠一层，用户一眼看出"这块地方用过了"；那一刻容器也不可点
            （`canRefreshQr` 在 scanned 档为假），否则手一抖就把这次扫码作废。 */}
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
            // R37：`relative` 是遮蔽层的定位上下文（它要正好盖住画布那一块，不多不少）
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

        {/* R21 倒计时：二维码**下方**那一行（秒级）。只在"码在屏上等着被扫"那一档出现；
            本地归零时它说的是「正在确认过期…」，等 sidecar 那条 expired 广播收口。 */}
        {countdown === null ? null : (
          <p className="text-center text-sm text-muted-foreground" data-testid={QR_COUNTDOWN_TESTID}>
            {countdown}
          </p>
        )}

        <p className="max-w-xs text-center text-sm text-muted-foreground">{QR_HINT_TEXT}</p>
        {/* 状态行：`null` 的那一档（R26：二维码过期）**整行不渲染**——遮罩上那两行已经是全部提示，
            再复述一遍等于同一句话说两次，还会把用户的选择挤下去。空着的那一行不是"留白"，是
            白白多占一个 gap-3 的间距（所以是隐掉整行，不是渲染一句空话）。

            R27（用户真机反馈之 2）、R28 改判据：官方页**还在加载**那一刻（页在屏外，见 Rust 侧
            `login::offscreen_rect`；摆进内容区的判据是"静默窗走完"——每次加载完成之后 1.5 秒内
            没有新导航）这一行说的是「正在打开华为官方登录页…」，并在前面加一个
            转圈——那几秒里用户看到的不能再是一片白。两个东西在**同一个 `role="status"` 区域**里：
            读屏听到的就是他看到的那句（判定见 `loginOpeningIndicator`，与文案只有一个真源）。 */}
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

        {/* R25：正文里只剩「在网页中打开登录」这一种形态。「返回扫码登录」**不再由 gate 渲染**
            ——它要浮在官方页**之上**（用户指令：不独占一行、不挤压网页），落点是浮动 webview
            `login-return`（`login-chrome.tsx`，文案与锚点是同一份常量）。gate 这一层此刻整个
            被官方页盖着，在这儿画它等于画在别人的地板底下。 */}
        {entry.form === "open" ? entryButton : null}
      </div>
    </div>
  )
}
