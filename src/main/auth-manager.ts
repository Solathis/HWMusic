/**
 * 认证状态机（Node 侧）：登录 / 恢复 / 登出三条路径 + `sessionEpoch` 过渡。
 *
 * 分工：**本模块不碰 HTTP、不碰窗口、不碰磁盘**——全部端口注入（宿主、令牌兑换、音乐会话兑换、
 * 会话存储、会话验证、广播），所以整条链路可以在没有网络、没有窗口、没有磁盘的测试里跑完，
 * 失败路径（超时/取消/兑换失败/端点未知/存盘失败）也都能被钉住。
 *
 * 登录链（与简报逐条对应）：
 * `createAttempt`（PKCE）→ 宿主开官方登录窗 → `runLoginFlow` 等回调 →
 * `consumeCallback`（state 常量时间比对）→ 账号令牌兑换（R4 已确认的 token 端点）→
 * 音乐会话兑换（loginex，**注入式**：端点未知 → 结构化「待联调」，绝不猜 URL）→
 * `favorites` 验证会话 → 存盘（R5 DPAPI 信封）→ 广播 `auth:status`。
 *
 * R16 增补**二维码路径**（`startQrLogin` / `cancelQrLogin`）：引导页直接显示二维码，
 * 端口（`src/main/qr-login.mjs`）在 sidecar 里建单 + 轮询，状态变化经 `auth:qr` 广播；
 * 用户手机确认后端口交回**同一个 shape 的回调 URL**，于是"确认之后"的部分与开窗路径
 * **共用同一条兑换链**（`completeWithCode`）——两条路不可能各自演化出不同的登录语义。
 *
 * 三条不妥协的诚实性规矩：
 * 1. **没验过的会话不广播"已登录"**：验证失败有两大类——"会话失效"与"没法验证"（端点还没确定），
 *    两者在返回值里分开报（`session_invalid` / `verify_unavailable`），绝不混成一个"未登录"。
 * 2. **存盘失败保留旧会话**：新会话写不进去时，磁盘与内存都保持原样（R5 的原子替换语义），
 *    epoch 不前进——在途请求继续绑旧会话，而不是绑一个没落盘的会话。
 * 3. **端点未知就是未知**：`loginex` 没有默认值；缺端点时返回结构化错误，一次请求都不发。
 */
import { createAttempt, exchangeAuthorizationCode, AUTH_ERROR_KINDS as OAUTH_ERROR_KINDS } from "../protocols/auth.mjs";
import {
  LOGIN_ERROR_KINDS,
  LOGIN_FLOW_STATUS,
  LOGIN_TIMEOUT_MS,
  consumeCallback,
  runLoginFlow,
} from "../protocols/login-callback.mjs";
import { AUTH_QR, AUTH_STATUS } from "../shared/channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

import { QR_LOGIN_STATUS } from "../protocols/qr-login.mjs";
import { createHuaweiQrPort } from "./qr-login.mjs";
import {
  HOST_LOGIN_STATUS,
  LOGIN_PAGE_UNAVAILABLE_MESSAGE,
  LOGIN_TIMEOUT_MESSAGE,
  kindOf,
  messageOf,
} from "./huawei.ts";

import type { CoreFail, CoreResult } from "../shared/result.ts";
import type { HostConclusion, LoginHost } from "./huawei.ts";

/**
 * OAuth 端点：R4 探针**已确认**的值（登记在 `docs/API_CONTRACT.md` §1.2/§1.3，含可复现证据）。
 *
 * 为什么要在这里写默认值：`src/protocols/auth.mjs` 坚持"端点一律注入、代码里不写死"，
 * 而总得有人把已确认的事实注入进去——本模块就是那个调用方。默认值可被构造参数覆盖
 * （探针更新后改一处），`test/auth-manager.test.mjs` 会拿契约文件反查这两个字面量。
 */
export const HUAWEI_OAUTH_ENDPOINTS = {
  authorize: "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize",
  token: "https://oauth-login1.cloud.huawei.com/oauth2/v3/token",
} as const;

/** 端点配置（`loginex` **没有默认值**：未知就是 `null`）。 */
export interface AuthEndpoints {
  authorize: string;
  token: string;
  /** 音乐会话兑换端点（旧仓称 loginex）：待授权联调确定，缺省 `null` */
  loginex: string | null;
}

/** 认证链路的错误类别（渲染层按它分支；与 `src/shared/result.ts` 的通用类别并存）。 */
export const AUTH_ERROR_KINDS = {
  /** 用户/渲染层取消 */
  cancelled: "cancelled",
  /** 登录窗被关闭（没扫完码） */
  closed: "closed",
  /** 超过总期限（10 分钟） */
  timedOut: "timed_out",
  /** 首载期限内打不开官方页（网络/代理） */
  loginPageUnavailable: "login_page_unavailable",
  /** 已有一次登录在进行中 */
  loginInProgress: "login_in_progress",
  /** 已经有会话了：再发一次二维码没有意义（渲染层此时本来也不该在门禁里） */
  alreadyLoggedIn: "already_logged_in",
  /** 音乐会话兑换（loginex）端点未确定：待联调，绝不猜 URL */
  loginexPending: "loginex_pending",
  /** 会话验证明确判定失效 */
  sessionInvalid: "session_invalid",
} as const;

/** loginex 缺端点时的结构化说明（**不猜 URL**：猜出来的端点只会变成下一次事故的根因）。 */
export const LOGINEX_PENDING_MESSAGE =
  "音乐会话兑换（loginex）的端点与请求形状待联调确定（见 docs/API_CONTRACT.md §1.5）：端点未知时不猜 URL、不发请求。";

/**
 * 会话验证失败里**明确表示"会话无效"**的类别；其余（端点未注入、网络、超时）只是"没验成"。
 *
 * 真实业务端点的错误类别要等授权联调才能补齐（本任务 untested），所以这里显式列举 +
 * 默认走"没验成"：宁可少报失效（用户还能进主界面，业务请求自己会报端点缺口），
 * 也不要把网络抖动当成"会话失效"把用户踢回登录页。
 */
export const SESSION_INVALID_KINDS: readonly string[] = [
  "session_invalid",
  "invalid_session",
  "unauthorized",
  "forbidden",
  "auth_failed",
];

export interface AuthSessionStore {
  saveMusicSession: (session: unknown) => Promise<unknown>;
  loadMusicSession: () => Promise<unknown>;
  clearMusicSession: () => Promise<unknown>;
}

/** 二维码端口的广播事件（`auth:qr` 载荷的来源；`payload` 只在 confirmed 那一档有）。 */
export interface QrEvent {
  status: string;
  content?: string;
  expiresInMs?: number | null;
  message?: string;
  errorKind?: string;
  /**
   * 已确认那一档的**原始响应**（含 `code`/`userAccount` 等兑换所需字段）。
   *
   * **绝不进广播**：`broadcastQr` 只挑 status/content/expiresInMs/message/errorKind 五个字段，
   * 这个载荷只在本进程内交给兑换链（渲染层拿不到任何凭据，与"渲染层拿不到 Token"同一条红线）。
   */
  payload?: unknown;
}

/**
 * 二维码登录端口（R16）：建单 + 轮询 + 已确认后的换码。
 *
 * 生产实现是 `src/main/qr-login.mjs` 的 `createHuaweiQrPort`（探针确认的端点）；
 * 测试注入假端口，于是"确认/失败/过期"这些档位都能被钉住，不需要真机扫码。
 */
export interface QrLoginPort {
  start: (params: {
    authorizeUrl: string;
    onEvent: (event: QrEvent) => void;
    onConfirmed: (result: { callbackUrl: string }) => void;
  }) => Promise<CoreResult<{ content: string; expiresInMs: number | null }>>;
  cancel: () => unknown;
  status: () => string;
}

export interface AuthManagerDeps {
  /** 登录宿主端口（`createLoginHost` 的产物） */
  host: LoginHost;
  /** 会话存储（R5 `createSessionStore` 的产物） */
  sessionStore: AuthSessionStore;
  /** 端点配置覆盖（默认取 [`HUAWEI_OAUTH_ENDPOINTS`] + `loginex: null`） */
  endpoints?: Partial<AuthEndpoints>;
  /** 授权码兑换（默认 R4 的 `exchangeAuthorizationCode`） */
  exchangeCode?: (params: {
    endpoint: string;
    code: string;
    codeVerifier: string;
  }) => Promise<CoreResult<Record<string, unknown>>>;
  /** 音乐会话兑换（默认：结构化「待联调」，绝不发请求） */
  exchangeMusicSession?: (params: {
    accessToken: string;
    endpoint: string | null;
  }) => Promise<CoreResult<unknown>>;
  /** 会话验证（默认：结构化「验证器未注入」——不谎报有效） */
  verifySession?: (session: unknown) => Promise<CoreResult<unknown>>;
  /** 二维码登录端口（R16；默认用探针确认的华为端点） */
  qrPort?: QrLoginPort;
  /** 个人数据缓存清理（登出用；未注入时如实报告"没清"） */
  clearPersonalCache?: () => Promise<CoreResult<unknown> | void> | void;
  /** 向渲染层广播（默认不广播，只记日志） */
  broadcast?: (channel: string, payload: unknown) => unknown;
  /** 用户可见提示（默认走 stderr 日志） */
  notify?: (text: string) => unknown;
  log?: (message: string) => void;
}

/** `restore()` 的结论：**分开报"验过了"与"没验成"**。 */
export interface RestoreStatus {
  loggedIn: boolean;
  verified: boolean;
  sessionKept: boolean;
  reason:
    | "no_session"
    | "verified"
    | "session_invalid"
    | "verify_unavailable"
    | "session_unreadable";
  epoch: number;
  error?: { message: string; kind?: string };
}

const defaultLog = (message: string) => console.error("[hwmusic-core]", message);

/** 默认的音乐会话兑换：**什么都不做，如实说"待联调"**（端点未知时不许猜）。 */
export async function exchangeMusicSessionPending(): Promise<CoreResult<unknown>> {
  return err(LOGINEX_PENDING_MESSAGE, AUTH_ERROR_KINDS.loginexPending);
}

/** 默认的会话验证：没有验证器就说没有，返回"没验成"而不是"无效"。 */
async function verifySessionUnavailable(): Promise<CoreResult<unknown>> {
  return err(
    "会话验证器尚未注入（收藏接口的端点待确认，见 docs/API_CONTRACT.md §2.1）：本次不判定会话有效",
    "endpoint_unknown",
  );
}

/**
 * 造认证状态机。
 *
 * @returns `login()` / `cancelLogin()` / `restore()` / `logout()` / `currentSession()` / `status()` / `endpoints()`
 */
export function createAuthManager(deps: AuthManagerDeps) {
  const { host, sessionStore } = deps;
  if (host === undefined || typeof host.openLoginPage !== "function") {
    throw new TypeError("createAuthManager 需要 host（createLoginHost 的产物）");
  }
  if (sessionStore === undefined || typeof sessionStore.loadMusicSession !== "function") {
    throw new TypeError("createAuthManager 需要 sessionStore（R5 createSessionStore 的产物）");
  }

  const endpoints: AuthEndpoints = {
    authorize: deps.endpoints?.authorize ?? HUAWEI_OAUTH_ENDPOINTS.authorize,
    token: deps.endpoints?.token ?? HUAWEI_OAUTH_ENDPOINTS.token,
    loginex: deps.endpoints?.loginex ?? null,
  };
  const exchangeCode = deps.exchangeCode ?? exchangeAuthorizationCode;
  const exchangeMusicSession = deps.exchangeMusicSession ?? exchangeMusicSessionPending;
  const verifySession = deps.verifySession ?? verifySessionUnavailable;
  const broadcast = deps.broadcast ?? (() => undefined);
  const notify = deps.notify ?? ((text: string) => log(`提示：${text}`));
  const log = deps.log ?? defaultLog;
  const qrPort: QrLoginPort =
    deps.qrPort ?? (createHuaweiQrPort({ log }) as QrLoginPort);

  let epoch = 0;
  let session: unknown = null;
  let inFlight: Promise<CoreResult<{ session: unknown; epoch: number }>> | null = null;
  /** 当前二维码会话的 PKCE 尝试（确认后兑换要用它的 code_verifier 与 state） */
  let qrAttempt: ReturnType<typeof createAttempt> | null = null;

  /** 宿主交付物：结论，或"开窗本身就失败了"（后者的类别比任何结论都具体，别被改写成笼统的 failed）。 */
  type Deliverable =
    | { kind: "conclusion"; conclusion: HostConclusion }
    | { kind: "openFailure"; message: string; errorKind: string };

  /** 状态广播：载荷 `{loggedIn, busy, message?}`（渲染层门禁按它决定显示哪一层）。 */
  function announce(extra: { busy?: boolean; message?: string } = {}): void {
    const payload: { loggedIn: boolean; busy: boolean; message?: string } = {
      loggedIn: session !== null,
      busy: extra.busy ?? false,
    };
    if (typeof extra.message === "string" && extra.message !== "") payload.message = extra.message;
    try {
      broadcast(AUTH_STATUS, payload);
    } catch (cause) {
      // 广播失败不该把登录结果改写成失败：状态本身已经落定，渲染层下一次问就能拿到
      log(`登录状态广播失败：${messageOf(cause)}`);
    }
  }

  /** 失败收口：广播"空闲 + 原因文案"（渲染层的状态行就靠这句话），然后原样返回失败。 */
  function failWith(failure: CoreFail): CoreFail {
    announce({ busy: false, message: failure.error.message });
    return failure;
  }

  /** 收场结论 → 渲染层能用的错误（kind 与文案都是"下一步该干什么"的线索）。 */
  function failureOf(settled: Record<string, unknown>): CoreFail {
    switch (settled.status) {
      case LOGIN_FLOW_STATUS.cancelled:
        return err("已取消登录", AUTH_ERROR_KINDS.cancelled);
      case LOGIN_FLOW_STATUS.closed:
        return err("登录窗口已关闭（没有完成扫码）", AUTH_ERROR_KINDS.closed);
      case LOGIN_FLOW_STATUS.timedOut:
        return err(LOGIN_TIMEOUT_MESSAGE, AUTH_ERROR_KINDS.timedOut);
      case LOGIN_FLOW_STATUS.failed: {
        const failure = (settled.error ?? {}) as { message?: string; kind?: string };
        return err(
          failure.message ?? "登录失败（详情见日志）",
          failure.kind ?? CORE_ERROR_KINDS.internal,
        );
      }
      default:
        return err("登录未完成（收场状态不认识，详情见日志）", CORE_ERROR_KINDS.internal);
    }
  }

  /**
   * 宿主交付物 → 流程收场。
   *
   * **双来源**（旧仓缺陷 C1）：Rust 侧导航拦截（callback）与关窗路径（closed/cancelled）
   * 都会把结论送过来；流程已结算时对迟到结论只会回 `already_settled`，这里刻意忽略。
   */
  function applyDeliverable(flow: ReturnType<typeof runLoginFlow>, deliverable: Deliverable): void {
    if (deliverable.kind === "openFailure") {
      flow.fail({ message: deliverable.message, kind: deliverable.errorKind });
      return;
    }
    const conclusion = deliverable.conclusion;
    switch (conclusion.status) {
      case HOST_LOGIN_STATUS.callback: {
        const consumed = flow.consumeCallback(conclusion.url ?? "");
        if (!consumed.ok && !flow.isSettled()) {
          // 不是可用回调（普通 hms:// 跳转 / 陈旧 state）：窗已经离开了，按"关窗"结算——
          // 否则等待方会一直等到 10 分钟超时（旧仓"扫码成功却等超时"的另一面）。
          log(`宿主交回的回调不可用（${consumed.error.kind}）：按关窗结算本次登录`);
          flow.close();
        }
        return;
      }
      case HOST_LOGIN_STATUS.cancelled:
        flow.cancel();
        return;
      case HOST_LOGIN_STATUS.closed:
        flow.close();
        return;
      case HOST_LOGIN_STATUS.timedOut:
        flow.timedOut();
        return;
      case HOST_LOGIN_STATUS.loadFailed:
        flow.fail({
          message: conclusion.message ?? LOGIN_PAGE_UNAVAILABLE_MESSAGE,
          kind: AUTH_ERROR_KINDS.loginPageUnavailable,
        });
        return;
      default:
        flow.fail({ message: "宿主给出了不认识的登录结论（详情见日志）", kind: CORE_ERROR_KINDS.internal });
    }
  }

  /** 登录正体（`inFlight` 只由 `login()` 管）。 */
  async function performLogin(): Promise<CoreResult<{ session: unknown; epoch: number }>> {
    const attempt = createAttempt({ authorizeEndpoint: endpoints.authorize });

    // 流程对象在 openLogin 里被同步调用，而结论只能从 promise 回调里到达 —— 所以
    // `flowRef` 一定先就位。这里仍然留一个缓冲：它是廉价的保险，省掉一整类"靠时序侥幸成立"。
    let flowRef: ReturnType<typeof runLoginFlow> | null = null;
    let buffered: Deliverable | null = null;
    const deliver = (deliverable: Deliverable) => {
      if (flowRef === null) {
        buffered = deliverable;
        return;
      }
      applyDeliverable(flowRef, deliverable);
    };

    const flow = runLoginFlow({
      authorizeUrl: attempt.authorizeUrl,
      expectedState: attempt.state,
      timeoutMs: LOGIN_TIMEOUT_MS,
      host: {
        openLogin: (url: string) => {
          let opening: Promise<HostConclusion>;
          try {
            opening = Promise.resolve(host.openLoginPage({ url }));
          } catch (cause) {
            opening = Promise.reject(cause);
          }
          opening.then(
            (conclusion) => deliver({ kind: "conclusion", conclusion }),
            (cause: unknown) =>
              deliver({
                kind: "openFailure",
                message: messageOf(cause),
                // 宿主给的 `login_in_progress` 之类对渲染层是有意义的分支（"已有一窗"≠"建窗炸了"）
                errorKind: kindOf(cause) ?? LOGIN_ERROR_KINDS.openFailed,
              }),
          );
          // 不让 runLoginFlow 把类别统一改写成 open_failed：上面那条路已经把原始类别带出来了
          return opening.catch(() => undefined);
        },
        closeLogin: () => {
          host.cancelLogin().catch(() => undefined);
        },
        cleanup: () => host.cleanup(),
      },
    });
    flowRef = flow;
    if (buffered !== null) {
      applyDeliverable(flow, buffered);
      buffered = null;
    }

    const settled = (await flow.settled) as Record<string, unknown>;
    if (settled.status !== LOGIN_FLOW_STATUS.callback) {
      return failWith(failureOf(settled));
    }

    const code = typeof settled.code === "string" ? settled.code : "";
    if (code === "") {
      return failWith(err("回调里没有授权码（详情见日志）", CORE_ERROR_KINDS.internal));
    }
    return completeWithCode(code, attempt);
  }

  /**
   * **授权码之后的那半条链**（开窗路径与二维码路径共用）。
   *
   * 抽出来的理由不是"少写几行"，而是让两条路不可能各自演化：谁能登录、什么算登录成功、
   * 存盘失败怎么办，只有这一份实现。
   */
  async function completeWithCode(
    code: string,
    attempt: ReturnType<typeof createAttempt>,
  ): Promise<CoreResult<{ session: unknown; epoch: number }>> {
    const tokens = await exchangeCode({
      endpoint: endpoints.token,
      code,
      codeVerifier: attempt.codeVerifier,
    });
    if (!tokens.ok) {
      return failWith(err(tokens.error.message, tokens.error.kind ?? CORE_ERROR_KINDS.internal));
    }
    const accessToken = (tokens.data as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== "string" || accessToken === "") {
      return failWith(err("令牌响应里没有 access_token（详情见日志）", OAUTH_ERROR_KINDS.invalidResponse));
    }

    const music = await exchangeMusicSession({ accessToken, endpoint: endpoints.loginex });
    if (!music.ok) {
      return failWith(err(music.error.message, music.error.kind ?? CORE_ERROR_KINDS.internal));
    }

    const verified = await verifySession(music.data);
    if (!verified.ok) {
      // 没验过的会话不许广播"已登录"：失败的类别原样上报（区分"失效"与"没验成"）
      return failWith(err(verified.error.message, verified.error.kind ?? CORE_ERROR_KINDS.internal));
    }

    // epoch 过渡：**存盘成功之后**才把会话与 epoch 一起翻过去（在途请求继续绑旧会话）
    const nextEpoch = epoch + 1;
    try {
      await sessionStore.saveMusicSession(music.data);
    } catch (cause) {
      return failWith(
        err(
          `登录成功但会话保存失败：${messageOf(cause)}（已保留上一次的会话，本次未替换）`,
          kindOf(cause) ?? CORE_ERROR_KINDS.internal,
        ),
      );
    }
    session = music.data;
    epoch = nextEpoch;
    announce({ busy: false });
    return ok({ session, epoch });
  }

  /**
   * 二维码状态广播（R16）：`auth:qr` 的载荷**只带渲染层要用的东西**——
   * 二维码内容、有效期、状态、以及失败时那一句人话；会话令牌（qrToken）留在 sidecar 里。
   *
   * **`failed` 必须顺带把 `busy` 落下来**（修复轮 1/5）：二维码会话的失败（轮询失败×3、
   * 10 分钟期限、确认链拿不到页面配置）只发这一条广播，`auth:status` 那条**不会**再响——
   * 而渲染层的官方页回退按钮是 `disabled={!canStartLogin(state)}`（只看 `busy`）。
   * 不复位就等于：**恰好在最需要回退的场景（协议不可用）里，那个按钮是灰的**，
   * 且页面上再没有别的路能把它弄回来。
   */
  function broadcastQr(event: {
    status?: unknown;
    content?: unknown;
    expiresInMs?: unknown;
    message?: unknown;
    errorKind?: unknown;
  }): void {
    const payload: Record<string, unknown> = {
      status: typeof event?.status === "string" ? event.status : "failed",
    };
    if (typeof event?.content === "string") payload.content = event.content;
    if (typeof event?.expiresInMs === "number") payload.expiresInMs = event.expiresInMs;
    if (typeof event?.message === "string" && event.message !== "") payload.message = event.message;
    if (typeof event?.errorKind === "string" && event.errorKind !== "") payload.errorKind = event.errorKind;
    // 先播状态再播二维码：二维码那条万一抛出去，busy 也已经复位了
    if (payload.status === QR_LOGIN_STATUS.failed) announce({ busy: false });
    try {
      broadcast(AUTH_QR, payload);
    } catch (cause) {
      log(`二维码状态广播失败：${messageOf(cause)}`);
    }
  }

  /**
   * 二维码路径的失败收口（修复轮 1/5）：`failWith` 只让 `auth:status` 说"空闲 + 原因"，
   * 而渲染层的**可操作元素**（重试 / 官方页入口）只看 `qr.status`。
   *
   * 少了后半条，确认之后收尾失败（state 不符、loginex 缺端点、令牌兑换失败）会让界面
   * 停在"已确认，正在完成登录…"：错误行有、按钮一个没有，自动重启也不会来
   * （`qrAttempted` 仍为 true）。所以失败时一并把 `auth:qr` 落到 `failed`。
   */
  function failQrWith(failure: CoreFail): CoreFail {
    broadcastQr({
      status: QR_LOGIN_STATUS.failed,
      message: failure.error.message,
      errorKind: failure.error.kind,
    });
    return failWith(failure);
  }

  /**
   * 二维码确认之后收尾：端口交回的**是同形的回调 URL**（`hms://redirect_uri?code=…&state=…`），
   * 所以判真伪、比 state、兑换都走与开窗路径完全一样的那一条链。
   *
   * 三条失败出口（尝试丢了 / state 不符 / `completeWithCode` 里任何一步）都经 `failQrWith`：
   * 二维码这条路**每一步失败都得让界面知道"这条路走完了"**，用户才有"重试"可按。
   *
   * 注意 `completeWithCode` 是开窗路径共用的，它**不**播 `auth:qr`（那条路上没有二维码）——
   * 所以"补一条二维码失败广播"的责任落在本函数里。
   */
  async function finishQrLogin(callbackUrl: string): Promise<CoreResult<{ session: unknown; epoch: number }>> {
    const attempt = qrAttempt;
    if (attempt === null) {
      return failQrWith(err("二维码登录的授权尝试已丢失（详情见日志）", CORE_ERROR_KINDS.internal));
    }
    const consumed = consumeCallback(callbackUrl, {
      expectedState: attempt.state,
      createdAt: attempt.createdAt,
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (!consumed.ok) {
      return failQrWith(err(consumed.error.message, consumed.error.kind ?? CORE_ERROR_KINDS.internal));
    }
    qrAttempt = null;
    const completed = await completeWithCode(consumed.data.code, attempt);
    // 到这里 busy 已经由 completeWithCode 里的 failWith 复位过了，缺的只是 `auth:qr` 那一条
    return completed.ok ? completed : failQrWith(completed);
  }

  /** 上一次开窗失败的原始类别（`openLogin` 与流程收场之间的一次性传话）。 */
  return {
    /**
     * 发起登录（并排第二次直接拒：宿主那侧也会拒绝，这里先拦一道）。
     *
     * 立刻广播 `busy:true`：渲染层的 `auth:login` 调用只拿到"已受理"（那条链路有 60 秒上限），
     * 它要知道"登录正在进行"就得靠这条广播。真正的结论随后由
     * `announce({busy:false, message?})` 送达。
     */
    login(): Promise<CoreResult<{ session: unknown; epoch: number }>> {
      if (inFlight !== null) {
        return Promise.resolve(
          err("已有一次登录正在进行（登录窗口会被拉到前台）", AUTH_ERROR_KINDS.loginInProgress),
        );
      }
      // 兜住任何意料之外的抛出：一次"没人接住的异常"会让渲染层永远停在"正在登录"，
      // 而结构化失败 + 一条带文案的广播，用户至少知道发生了什么、能再来一次。
      const running = performLogin().catch((cause: unknown) =>
        failWith(err(`登录过程异常：${messageOf(cause)}`, kindOf(cause) ?? CORE_ERROR_KINDS.internal)),
      );
      inFlight = running.finally(() => {
        inFlight = null;
      });
      announce({ busy: true });
      return inFlight;
    },

    /**
     * 发起二维码登录（R16）：引导页**自动**调这一条，界面上没有任何按钮。
     *
     * 立刻广播 `busy:true`（渲染层的状态行要知道"正在准备/等待扫码"），随后二维码会话的每一步
     * 状态变化经 `auth:qr` 广播送达。返回值只带"这一张二维码是什么"（内容 + 有效期）——
     * 渲染层拿它立刻就能画出来，不必等广播。
     */
    async startQrLogin(): Promise<CoreResult<{ content: string; expiresInMs: number | null }>> {
      if (session !== null) {
        const failure = err("已经登录了，无需再扫码", AUTH_ERROR_KINDS.alreadyLoggedIn);
        announce({ busy: false, message: failure.error.message });
        return failure;
      }
      if (inFlight !== null) {
        // 并排第二次：开窗那条路正在跑，再开一张二维码只会让"点了没反应"更难查
        return err("已有一次登录正在进行（登录窗口会被拉到前台）", AUTH_ERROR_KINDS.loginInProgress);
      }

      // 每次二维码会话一对**新的** PKCE/state：重开一次旧的就作废（与开窗路径同一语义）
      const attempt = createAttempt({ authorizeEndpoint: endpoints.authorize });
      qrAttempt = attempt;
      announce({ busy: true });

      const started = await qrPort.start({
        authorizeUrl: attempt.authorizeUrl,
        onEvent: (event) => broadcastQr(event),
        onConfirmed: (result) => {
          void finishQrLogin(result.callbackUrl);
        },
      });
      if (!started.ok) {
        // 建单失败要说给用户听：界面显示不了二维码时必须有人知道为什么
        return failWith(err(started.error.message, started.error.kind ?? CORE_ERROR_KINDS.internal));
      }
      return started;
    },

    /**
     * 停下进行中的二维码会话（门禁收起、用户取消、进程收尾都走这条）。
     *
     * 没有进行中的会话时**不去打扰端口**：什么都没停不是错误。
     */
    async cancelQrLogin(): Promise<CoreResult<{ cancelled: boolean }>> {
      qrAttempt = null;
      try {
        qrPort.cancel();
      } catch (cause) {
        log(`停止二维码会话失败：${messageOf(cause)}`);
      }
      announce({ busy: false });
      return ok({ cancelled: true });
    },

    /**
     * 取消进行中的登录（窗在 Rust 手里，这里只是把要求转过去）。
     *
     * 没有进行中的登录时**不去打扰宿主**：什么都没取消不是错误（用户的意图"别等了"已经满足），
     * 重复点取消按钮不该看到一个报错，也不该在宿主不可用时弹一条假故障。
     */
    async cancelLogin(): Promise<CoreResult<{ cancelled: boolean }>> {
      if (inFlight === null) return ok({ cancelled: false });
      return host.cancelLogin();
    },

    /**
     * 启动期恢复：读会话 → 验证 → 如实报状态（**不是**布尔）。
     */
    async restore(): Promise<RestoreStatus> {
      let loaded: unknown;
      try {
        loaded = await sessionStore.loadMusicSession();
      } catch (cause) {
        const error = { message: messageOf(cause), kind: kindOf(cause) ?? CORE_ERROR_KINDS.internal };
        session = null;
        notify(`读取上次的登录会话失败：${error.message}（不当作"没有会话"处理）`);
        announce({ busy: false });
        return {
          loggedIn: false,
          verified: false,
          sessionKept: false,
          reason: "session_unreadable",
          epoch,
          error,
        };
      }

      if (loaded === null || loaded === undefined) {
        session = null;
        announce({ busy: false });
        return { loggedIn: false, verified: false, sessionKept: false, reason: "no_session", epoch };
      }

      let verified: CoreResult<unknown>;
      try {
        verified = await verifySession(loaded);
      } catch (cause) {
        // 验证器自己炸了不是"会话失效"：会话留着，如实报"没验成"（网络/端点缺口的处置在下面）
        verified = err(`会话验证器抛错：${messageOf(cause)}`, kindOf(cause) ?? CORE_ERROR_KINDS.internal);
      }
      if (verified.ok) {
        session = loaded;
        epoch += 1;
        announce({ busy: false });
        return { loggedIn: true, verified: true, sessionKept: true, reason: "verified", epoch };
      }

      const kind = verified.error.kind ?? "";
      const error = { message: verified.error.message, kind: verified.error.kind };
      if (SESSION_INVALID_KINDS.includes(kind)) {
        // 明确失效：不留在内存里（也不删盘上的文件——网络抖动的误判不该抹掉用户的会话）
        session = null;
        announce({ busy: false });
        return {
          loggedIn: false,
          verified: false,
          sessionKept: false,
          reason: "session_invalid",
          epoch,
          error,
        };
      }

      // 没法验证（端点未注入、网络、超时）：会话仍在，但如实说自己没验过
      session = loaded;
      epoch += 1;
      announce({ busy: false });
      return {
        loggedIn: true,
        verified: false,
        sessionKept: true,
        reason: "verify_unavailable",
        epoch,
        error,
      };
    },

    /** 登出：清会话 + 清个人数据缓存（两件事的成败各自如实上报）。 */
    async logout(): Promise<
      CoreResult<{ sessionCleared: boolean; cacheCleared: boolean; notes: string[] }>
    > {
      const notes: string[] = [];

      let sessionCleared = false;
      try {
        sessionCleared = (await sessionStore.clearMusicSession()) !== false;
      } catch (cause) {
        notes.push(`登录会话文件未能删除：${messageOf(cause)}`);
      }

      let cacheCleared = false;
      if (typeof deps.clearPersonalCache === "function") {
        try {
          const result = await deps.clearPersonalCache();
          if (result === undefined || (result as CoreResult<unknown>).ok !== false) {
            cacheCleared = true;
          } else {
            const failure = (result as { error?: { message?: string } }).error;
            notes.push(`个人数据缓存未能清除：${failure?.message ?? "详情见日志"}`);
          }
        } catch (cause) {
          notes.push(`个人数据缓存未能清除：${messageOf(cause)}`);
        }
      } else {
        notes.push("个人数据缓存清理尚未接入（R8+ 的音乐缓存建好之后接上）：本次只清了登录会话");
      }

      session = null;
      epoch += 1;
      announce({ busy: false });
      return ok({ sessionCleared, cacheCleared, notes });
    },

    /** 当前会话 + 它属于哪一代（R8+ 的业务请求用它绑定凭据）。 */
    currentSession(): { session: unknown; epoch: number } {
      return { session, epoch };
    },

    status(): { loggedIn: boolean; epoch: number; loginInFlight: boolean } {
      return { loggedIn: session !== null, epoch, loginInFlight: inFlight !== null };
    },

    /** 生效的端点配置（**loginex 为 null 就是"未知"**，不是"待会儿补"）。 */
    endpoints(): AuthEndpoints {
      return { ...endpoints };
    },
  };
}
