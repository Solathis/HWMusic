/**
 * 认证状态机（Node 侧）：登录 / 恢复 / 登出 + `sessionEpoch` 过渡；不碰 HTTP / 窗口 / 磁盘，端口全注入。
 * 登录链：`createAttempt` → 宿主开窗 → `runLoginFlow` → `consumeCallback` → 令牌兑换 → 会话兑换 → 验证 → 存盘 → 广播。
 * 二维码只共用兑换链（`completeWithCode`）；确认后最后一跳由宿主登录 webview 完成，复用 `runLoginFlow`。
 * 三条规矩：没验过不广播“已登录”；存盘失败保留旧会话（epoch 不前移）；端点未知就报未知，不发请求。
 */
import {
  createAttempt,
  exchangeAuthorizationCode,
  idTokenClaimKeysOf,
  idTokenClaimsOf,
  AUTH_ERROR_KINDS as OAUTH_ERROR_KINDS,
} from "../protocols/auth.mjs";
import {
  LOGIN_ERROR_KINDS,
  LOGIN_FLOW_STATUS,
  LOGIN_TIMEOUT_MS,
  consumeCallback,
  isCallback,
  runLoginFlow,
} from "../protocols/login-callback.mjs";
import { AUTH_QR, AUTH_STATUS } from "../shared/channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

import { QR_LOGIN_STATUS } from "../protocols/qr-login.mjs";
import {
  HUAWEI_MUSIC_LOGINEX_ENDPOINT,
  attachClaimProfile,
  createHuaweiMusicSessionPort,
  musicSessionExpiredText,
  musicSessionExpiresAt,
  profileOfSessionRecord,
  sessionExpiryLine,
} from "./music-session.mjs";
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

/** OAuth 端点默认值：授权在 `oauth-login.platform.hicloud.com`、兑换在 `oauth-login.cloud.huawei.com`（实测）。
 * `loginex` 取 `src/main/music-session.mjs` 的值；端点可被构造参数覆盖，测试拿契约文件反查字面量。 */
export const HUAWEI_OAUTH_ENDPOINTS = {
  authorize: "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize",
  token: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
  loginex: HUAWEI_MUSIC_LOGINEX_ENDPOINT,
} as const;

/** 端点配置（`loginex` 显式注入 `null` = "这条路这次不用"，不是"待会儿补"）。 */
export interface AuthEndpoints {
  authorize: string;
  token: string;
  /** 音乐会话兑换端点（旧仓称 loginex）：默认值是确认过的值，注入 `null` 可关掉 */
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
  /** 音乐会话已过 `expireTime` */
  sessionExpired: "session_expired",
} as const;

/** loginex 端点被显式关掉（注入 `null`）时的结构化说明（**不猜 URL**）。 */
export const LOGINEX_PENDING_MESSAGE =
  "音乐会话兑换（loginex）端点被显式关闭（注入 endpoints.loginex = null）：不猜 URL、不发请求。";

/** 会话验证失败里明确表示“会话无效”的类别；其余（端点未注入、网络、超时）只是“没验成”。
 * 默认走“没验成”：宁可少报失效，也不要把网络抖动当成会话失效把用户踢回登录页。 */
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
  /** 已确认那一档的**原始响应**（含 `code`/`userAccount` 等兑换所需字段）。
   * **绝不进广播**：`broadcastQr` 只挑五个字段，凭据只在本进程内交给兑换链。 */
  payload?: unknown;
}

/** 二维码登录端口：建单 + 轮询 + 已确认后的换码；生产实现是 `createHuaweiQrPort`，测试注入假端口。
 * `onConfirmed` 交回 `codeRemoteLogin` 的 `callbackURL` 原文：可能是 https 收尾页，也可能是 `hms://` 回调。 */
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
  /** 会话存储（`createSessionStore` 的产物） */
  sessionStore: AuthSessionStore;
  /** 端点配置覆盖（默认取 `HUAWEI_OAUTH_ENDPOINTS`，含确认的 `loginex`） */
  endpoints?: Partial<AuthEndpoints>;
  /** 授权码兑换（默认 `exchangeAuthorizationCode`） */
  exchangeCode?: (params: {
    endpoint: string;
    code: string;
    codeVerifier: string;
  }) => Promise<CoreResult<Record<string, unknown>>>;
  /** 音乐会话兑换（默认 `createHuaweiMusicSessionPort`，真发请求；端点显式 `null` 则先收口成「待联调」，不发请求） */
  exchangeMusicSession?: (params: {
    accessToken: string;
    endpoint: string | null;
  }) => Promise<CoreResult<unknown>>;
  /** 会话验证（默认：结构化「验证器未注入」——不谎报有效） */
  verifySession?: (session: unknown) => Promise<CoreResult<unknown>>;
  /** 二维码登录端口（默认用探针确认的华为端点） */
  qrPort?: QrLoginPort;
  /** 个人数据缓存清理（登出用；未注入时如实报告"没清"） */
  clearPersonalCache?: () => Promise<CoreResult<unknown> | void> | void;
  /** 向渲染层广播（默认不广播，只记日志） */
  broadcast?: (channel: string, payload: unknown) => unknown;
  /** 用户可见提示（默认走 stderr 日志） */
  notify?: (text: string) => unknown;
  /** 时钟（判会话到期用；默认 `Date.now`） */
  now?: () => number;
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
    | "session_expired"
    | "verify_unavailable"
    | "session_unreadable";
  epoch: number;
  error?: { message: string; kind?: string };
}

/** `auth:status` 载荷里那一格 `profile`：**认不出就没有这个键**，界面照旧显示兜底。
 * 取值只来自 `statusPayload`；形状与 `AccountProfile`、`docs/API_CONTRACT.md` §2.6 一致。 */
export type AuthProfile = { userName?: string; avatarUrl?: string; vip?: boolean; vipExpiresOn?: string };

/** `auth:status` 的载荷形状（**广播与 `auth:get-status` 应答共用，唯一一处定义**）。
 * `message` 只有真有事说的时候才出现（没有这个键 ≠ 值是 undefined）；`profile` 同理。 */
export type AuthStatusPayload = {
  loggedIn: boolean;
  busy: boolean;
  /**
   * 启动恢复尚未落定：快照与广播都可能带它，渲染层保持中性启动屏。
   * 见到它只表示"还不知道"，不能当"未登录"去画登录页或建码。
   */
  restoring?: true;
  message?: string;
  profile?: AuthProfile;
};

const defaultLog = (message: string) => console.error("[hwmusic-core]", message);

/** 「端点被关掉」那一档的兑换实现：**什么都不做，如实说“待联调”**（不猜 URL、不发请求）。
 * 默认值已是真发请求的 `createHuaweiMusicSessionPort`；留它是给显式 `loginex = null` 一个诚实落点。 */
export async function exchangeMusicSessionPending(): Promise<CoreResult<unknown>> {
  return err(LOGINEX_PENDING_MESSAGE, AUTH_ERROR_KINDS.loginexPending);
}

/** 默认的会话验证：没有验证器就说没有，返回“没验成”而不是“无效”。
 * 生产路径由装配处注入 `src/main/session-verifier.mjs`；留着它是让装配缺口仍然说实话。 */
async function verifySessionUnavailable(): Promise<CoreResult<unknown>> {
  return err(
    "会话验证器尚未注入（装配处必须经 deps.verifySession 传入，见 src/main/session-verifier.mjs）：本次不判定会话有效",
    "endpoint_unknown",
  );
}

/** 造认证状态机。
 * @returns `login` / `cancelLogin` / `restore` / `logout` / `currentSession` / `activeSession` / `status` / `endpoints` */
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
    // 注意 `??` 与 `in` 的区别：显式传 `loginex: null` 是**有意的关闭**（保留 null）；
    // 没传才取确认的默认值。写成 `?? HUAWEI_OAUTH_ENDPOINTS.loginex` 会让“关掉”变成“打开”。
    loginex: "loginex" in (deps.endpoints ?? {}) ? (deps.endpoints?.loginex ?? null) : HUAWEI_OAUTH_ENDPOINTS.loginex,
  };
  /** 授权码兑换（默认 `exchangeAuthorizationCode`）。
   * 默认实现多接一个**只记键名**的诊断口：token 响应的顶层键名（名字/头像/VIP），实证用户资料形状。 */
  const exchangeCode =
    deps.exchangeCode ??
    ((params: { endpoint: string; code: string; codeVerifier: string }) =>
      exchangeAuthorizationCode({
        ...params,
        onResponseKeys: (keys) => log(`token 响应顶层键名（只记键名，不记值）：${keys.join(", ")}`),
      }));
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const exchangeMusicSession = deps.exchangeMusicSession ?? createHuaweiMusicSessionPort({ log });
  const verifySession = deps.verifySession ?? verifySessionUnavailable;
  const broadcast = deps.broadcast ?? (() => undefined);
  const notify = deps.notify ?? ((text: string) => log(`提示：${text}`));
  const qrPort: QrLoginPort =
    deps.qrPort ?? (createHuaweiQrPort({ log }) as QrLoginPort);

  let epoch = 0;
  let session: unknown = null;
  let inFlight: Promise<CoreResult<{ session: unknown; epoch: number }>> | null = null;
  /** 当前二维码会话的 PKCE 尝试（确认后兑换要用它的 code_verifier 与 state） */
  let qrAttempt: ReturnType<typeof createAttempt> | null = null;
  /** “开窗那条路正在跑”的**唯一内存真源**（`auth:status.busy` 与状态快照共用）。
   * 不现读 `inFlight`：它挂在 promise 的 `finally` 上，比收场广播晚一个微任务，两处各算会有一瞬不一致。 */
  let busy = false;
  /**
   * 启动恢复尚未落定：期间快照与广播都带 `restoring:true`，渲染层保持中性启动屏。
   * 只由 [`concludeRestore`] 清位（`restore()` 的 `finally` 兜异常）。
   */
  let restoring = false;
  /** **二维码那条路开出来的登录 webview**：跑着的时候占在 `qrWindow` 上。
   * 与网页登录共用同一扇宿主窗：`login()` 先拦一道，`cancelLogin()` 必须能关掉它；收场由 `finally` 清空。 */
  let qrWindow: ReturnType<typeof runLoginFlow> | null = null;

  /** 宿主交付物：结论，或"开窗本身就失败了"（后者的类别比任何结论都具体，别被改写成笼统的 failed）。 */
  type Deliverable =
    | { kind: "conclusion"; conclusion: HostConclusion }
    | { kind: "openFailure"; message: string; errorKind: string };

  /** 会话里的 profile → `auth:status` 载荷里的可选 profile。
   * **null 就不带这个键**：旧会话没有这一格，界面照旧显示兜底；**不造假数据**：认不出名字就不给名字。 */
  function profileOfSession(): AuthProfile | null {
    return profileOfSessionRecord(session);
  }

  /** `auth:status` 的载荷形状（**广播与 `auth:get-status` 的应答共用这一处**）。
   * 共用是为了“查询与广播同形状”；`message` 与 `profile` 都是没有就**不带这个键**。 */
  function statusPayload(extra: { busy?: boolean; message?: string } = {}): AuthStatusPayload {
    const payload: AuthStatusPayload = {
      loggedIn: session !== null,
      busy: extra.busy ?? false,
    };
    // `session` 已经不是 null 时不加这一格：结论其实已经出来了，再挂"恢复中"就自相矛盾
    if (restoring && session === null) payload.restoring = true;
    if (typeof extra.message === "string" && extra.message !== "") payload.message = extra.message;
    const profile = profileOfSession();
    if (profile !== null) payload.profile = profile;
    return payload;
  }

  /**
   * 状态广播（与快照同源）。载荷为已登录时顺带停掉在跑的二维码会话。
   * 不碰 `restoring`：恢复期间别的广播都不是结论，只有 [`concludeRestore`] 能清位。
   */
  function announce(extra: { busy?: boolean; message?: string } = {}): void {
    const payload = statusPayload(extra);
    // 广播与查询同源：播出去的这一份就是"当前状态"，`busy` 也跟着它走
    busy = payload.busy;
    // 已登录 → 二维码那条路没有存在的理由了（还没有会话时才停，避免空转调用端口）
    if (payload.loggedIn) stopQrIfRunning();
    try {
      broadcast(AUTH_STATUS, payload);
    } catch (cause) {
      // 广播失败不该把登录结果改写成失败：状态本身已经落定，渲染层下一次问就能拿到
      log(`登录状态广播失败：${messageOf(cause)}`);
    }
  }

  /**
   * 恢复落定：清 `restoring` 之后播那条结论（恢复期间**只有这一处**能清位）。
   *
   * 调用点必须先落定 `session`，否则播出去的"未登录"就是错的结论。
   */
  function concludeRestore(extra: { busy?: boolean; message?: string } = { busy: false }): void {
    restoring = false;
    announce(extra);
  }

  /** 内存里的会话过了 `expireTime` 就收回并回到登录页（服务端对到期会话照样回 200 + 空数据）；返回是否刚收回。 */
  function expireIfDue(): boolean {
    const expiresAt = musicSessionExpiresAt(session);
    const at = now();
    if (session === null || expiresAt === null || at < expiresAt) return false;
    log(`${sessionExpiryLine(session, at)}：运行中收回会话，回到登录页`);
    session = null;
    epoch += 1;
    announce({ busy: false, message: musicSessionExpiredText(expiresAt) });
    return true;
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

  /** 宿主交付物 → 流程收场。 */
  // 双来源：Rust 导航拦截（callback）与关窗路径（closed/cancelled）都会送来结论，流程已结算时迟到结论只回 `already_settled`，故刻意忽略。
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
          // 不是可用回调（普通 hms:// 跳转 / 陈旧 state）：窗已经离开了，按“关窗”结算，否则等待方会一直等到 10 分钟超时。
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

  /**
   * 起一条“开窗 → 等结论”的登录流（runLoginFlow），网页登录与二维码最后一跳共用，六种结算只有一份实现。
   * @param {{url: string, expectedState: string, createdAt?: number}} params  createdAt = 这次尝试的建立时刻（锚在 attempt）
   */
  function startLoginFlow(params: {
    url: string;
    expectedState: string;
    createdAt?: number;
  }): ReturnType<typeof runLoginFlow> {
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
      authorizeUrl: params.url,
      expectedState: params.expectedState,
      createdAt: params.createdAt,
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
    return flow;
  }

  /** 登录正体（`inFlight` 只由 `login()` 管）。 */
  async function performLogin(): Promise<CoreResult<{ session: unknown; epoch: number }>> {
    const attempt = createAttempt({ authorizeEndpoint: endpoints.authorize });
    const flow = startLoginFlow({
      url: attempt.authorizeUrl,
      expectedState: attempt.state,
      createdAt: attempt.createdAt,
    });

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

  /** token 响应里的 id_token → claims：解码只认三段式 base64url，坏形状回 null，不抛。 */
  // 真机证据：loginex 顶层无名字/头像，OIDC claims 是账号资料最可能的载体；日志只记键名。
  function claimsOfIdToken(idToken: unknown): Record<string, unknown> | null {
    if (typeof idToken !== "string" || idToken.trim() === "") return null;
    const claims = idTokenClaimsOf(idToken) as Record<string, unknown> | null;
    if (claims === null) {
      log("id_token 解码失败（不是三段式 JWT）：本次不从 claims 取账号资料，界面照旧走兜底");
      return null;
    }
    log(`id_token claims 键名（只记键名，不记值）：${idTokenClaimKeysOf(idToken).join(", ")}`);
    return claims;
  }

  /** 授权码之后的那半条链（开窗路径与二维码路径共用）。 */
  // 抽出来不是为少写几行：谁能登录、什么算登录成功、存盘失败怎么办，只有这一份实现。
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
    // id_token 的 claims（名字/头像的第二来源）。解码失败只是没有它，不影响登录。
    const claims = claimsOfIdToken((tokens.data as { idToken?: unknown }).idToken);

    // 端点被显式关掉时**在兑换之前**收口：一次请求都不发（"不猜 URL"这条不变的落点）。
    // 放在这里而不是交给端口：端口只管"拿到端点怎么发"，"能不能发"是状态机的决定。
    if (endpoints.loginex === null) {
      return failWith(err(LOGINEX_PENDING_MESSAGE, AUTH_ERROR_KINDS.loginexPending));
    }

    const music = await exchangeMusicSession({ accessToken, endpoint: endpoints.loginex });
    if (!music.ok) {
      return failWith(err(music.error.message, music.error.kind ?? CORE_ERROR_KINDS.internal));
    }

    // 把 claims 里认出的名字/头像补进会话记录（loginex 优先，claims 只补空缺）。
    // 只有提取出的三个键随会话记录进 DPAPI 信封；claims 原文与 id_token 都不落盘。
    const sessionRecord = attachClaimProfile(music.data, claims);

    const verified = await verifySession(sessionRecord);
    if (!verified.ok) {
      // 没验过的会话不许广播"已登录"：失败的类别原样上报（区分"失效"与"没验成"）
      return failWith(err(verified.error.message, verified.error.kind ?? CORE_ERROR_KINDS.internal));
    }

    // epoch 过渡：**存盘成功之后**才把会话与 epoch 一起翻过去（在途请求继续绑旧会话）
    const nextEpoch = epoch + 1;
    try {
      await sessionStore.saveMusicSession(sessionRecord);
    } catch (cause) {
      return failWith(
        err(
          `登录成功但会话保存失败：${messageOf(cause)}（已保留上一次的会话，本次未替换）`,
          kindOf(cause) ?? CORE_ERROR_KINDS.internal,
        ),
      );
    }
    session = sessionRecord;
    epoch = nextEpoch;
    log(sessionExpiryLine(session, now()));
    announce({ busy: false });
    return ok({ session, epoch });
  }

  /** 二维码状态广播：auth:qr 的载荷只带渲染层要用的东西（内容、有效期、状态、失败文案），qrToken 留在 sidecar。 */
  // failed 仍顺带播 busy:false：守的是“失败之后界面一定非忙态”（canStartLogin/canRetryQr 都读这份状态）。
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

  /** 二维码路径的失败收口：failWith 只让 auth:status 说“空闲 + 原因”，而可操作元素只看 qr.status。 */
  // 少了后半条，确认之后收尾失败会让界面停在“已确认，正在完成登录…”：错误行有、按钮没有。
  function failQrWith(failure: CoreFail): CoreFail {
    broadcastQr({
      status: QR_LOGIN_STATUS.failed,
      message: failure.error.message,
      errorKind: failure.error.kind,
    });
    return failWith(failure);
  }

  /** 二维码确认之后的最后一跳：服务端 fetch 结构性拿不到 code（callbackURL 是 https 收尾页），故交给登录 webview。 */
  // 两流合一：本来就是回调就直接兑换链，https 收尾页则复用 runLoginFlow（startLoginFlow 装配），收场与清理只一份。
  async function finishQrLogin(
    callbackUrl: string,
    attempt: ReturnType<typeof createAttempt>,
  ): Promise<CoreResult<{ session: unknown; epoch: number }>> {
    // ① 已经是回调：既有链零改动（不开窗——宿主那只收 https 的登录页）
    if (isCallback(callbackUrl)) {
      const consumed = consumeCallback(callbackUrl, {
        expectedState: attempt.state,
        createdAt: attempt.createdAt,
        timeoutMs: LOGIN_TIMEOUT_MS,
      });
      if (!consumed.ok) {
        return failQrWith(err(consumed.error.message, consumed.error.kind ?? CORE_ERROR_KINDS.internal));
      }
      const completed = await completeWithCode(consumed.data.code, attempt);
      return completed.ok ? completed : failQrWith(completed);
    }

    // ② https 的登录收尾页：开登录 webview 走最后一跳
    if (qrWindow !== null) {
      // 同一时刻只可能有一扇宿主登录窗（两条路互斥）：这里如实报，不去开第二扇
      return failQrWith(err("已有一扇登录窗在跑（详情见日志）", AUTH_ERROR_KINDS.loginInProgress));
    }
    log("二维码已确认：开登录 webview 加载收尾页（最后一跳由页面 JS 跳 hms://，宿主拦截后交回）");
    // 窗真的开了：busy 描述的就是“开窗那条路正在跑”，此刻它确实在跑。
    // 渲染层因此把状态行留在「已确认，正在完成登录…」，而 reload 之后只凭 busy 也知道有一扇窗开着。
    announce({ busy: true });
    const flow = startLoginFlow({
      url: callbackUrl,
      expectedState: attempt.state,
      createdAt: attempt.createdAt,
    });
    qrWindow = flow;
    try {
      const settled = (await flow.settled) as Record<string, unknown>;
      if (settled.status !== LOGIN_FLOW_STATUS.callback) {
        return failQrWith(failureOf(settled));
      }
      const code = typeof settled.code === "string" ? settled.code : "";
      if (code === "") {
        return failQrWith(err("回调里没有授权码（详情见日志）", CORE_ERROR_KINDS.internal));
      }
      const completed = await completeWithCode(code, attempt);
      return completed.ok ? completed : failQrWith(completed);
    } finally {
      // 到这里 busy 已经由 completeWithCode 里的 announce/failWith 复位过了
      qrWindow = null;
    }
  }

  /** 停掉当前的二维码会话（互斥用）。 */
  // 不广播：这是“开窗之前的一次内部清场”，多播一条 busy:false 会让渲染层把网页那条路误判成已收场。
  function stopQrSession(): void {
    qrAttempt = null;
    try {
      qrPort.cancel();
    } catch (cause) {
      log(`停止二维码会话失败：${messageOf(cause)}`);
    }
  }

  /**
   * 有在跑的二维码会话就停掉它；没有就什么都不做——调用方是高频的状态广播，不该空转打扰端口。
   */
  function stopQrIfRunning(): boolean {
    if (qrAttempt === null) return false;
    stopQrSession();
    return true;
  }

  /**
   * 启动恢复的真实实现（"恢复中"开关在外层 `restore()`）。
   * 每条收场路径都先落定 `session` 再 `concludeRestore()`，播出去的因此永远是结论。
   */
  async function performRestore(): Promise<RestoreStatus> {
    let loaded: unknown;
    try {
      loaded = await sessionStore.loadMusicSession();
    } catch (cause) {
      const error = { message: messageOf(cause), kind: kindOf(cause) ?? CORE_ERROR_KINDS.internal };
      session = null;
      notify(`读取上次的登录会话失败：${error.message}（不当作"没有会话"处理）`);
      concludeRestore();
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
      concludeRestore();
      return { loggedIn: false, verified: false, sessionKept: false, reason: "no_session", epoch };
    }

    const restoredAt = now();
    log(sessionExpiryLine(loaded, restoredAt));
    const expiresAt = musicSessionExpiresAt(loaded);
    if (expiresAt !== null && restoredAt >= expiresAt) {
      // 到期会话验证器验不出来，不发验证请求；盘上的文件不删（时区是推断，留着可挽回）
      session = null;
      const message = musicSessionExpiredText(expiresAt);
      concludeRestore({ busy: false, message });
      return {
        loggedIn: false,
        verified: false,
        sessionKept: false,
        reason: "session_expired",
        epoch,
        error: { message, kind: AUTH_ERROR_KINDS.sessionExpired },
      };
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
      concludeRestore();
      return { loggedIn: true, verified: true, sessionKept: true, reason: "verified", epoch };
    }

    const kind = verified.error.kind ?? "";
    const error = { message: verified.error.message, kind: verified.error.kind };
    if (SESSION_INVALID_KINDS.includes(kind)) {
      // 明确失效：不留在内存里（也不删盘上的文件——网络抖动的误判不该抹掉用户的会话）
      session = null;
      concludeRestore();
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
    concludeRestore();
    return {
      loggedIn: true,
      verified: false,
      sessionKept: true,
      reason: "verify_unavailable",
      epoch,
      error,
    };
  }

  /** 上一次开窗失败的原始类别（`openLogin` 与流程收场之间的一次性传话）。 */
  return {
    /** 发起登录（并排第二次直接拒：宿主那侧也会拒绝，这里先拦一道）。 */
    // 立刻广播 busy:true：auth:login 只拿到“已受理”，结论随后由 announce({busy:false, message?}) 送达。
    login(): Promise<CoreResult<{ session: unknown; epoch: number }>> {
      if (inFlight !== null) {
        return Promise.resolve(
          err("已有一次登录正在进行（登录窗口会被拉到前台）", AUTH_ERROR_KINDS.loginInProgress),
        );
      }
      // 二维码确认之后开出来的那扇登录 webview 也算“一次登录在进行”——宿主同时只有一扇登录窗，再开只会撞 login_in_progress。
      if (qrWindow !== null) {
        return Promise.resolve(
          err("二维码确认后正在用登录窗口完成收尾（窗口会被拉到前台）", AUTH_ERROR_KINDS.loginInProgress),
        );
      }
      // 两条路互斥：先把二维码会话停掉（停轮询、作废待兑换的尝试）再开窗，否则手机恰在窗开后确认会多换一次码。
      // 这一句不广播（见 stopQrSession）。
      stopQrSession();
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

    /** 发起二维码登录：引导页自动调这一条，界面上只有“重试”会在失败态出现；返回值带内容与有效期。 */
    // 不再播 busy:true：busy 只描述“开窗那条路正在跑”，等扫码期间占着它会让「在网页中打开登录」变灰。
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

      const started = await qrPort.start({
        authorizeUrl: attempt.authorizeUrl,
        onEvent: (event) => broadcastQr(event),
        onConfirmed: (result) => {
          // 迟到的确认：这次会话已被停掉（改走网页那条路，或又开了新码）时不换码、不广播。
          // 否则会在窗还开着的时候把界面踢回二维码态。
          if (qrAttempt !== attempt) {
            log("二维码确认到达时那次尝试已作废：不换码、不广播（迟到的确认不属于当前这条路）");
            return;
          }
          qrAttempt = null;
          // 这一次收尾可能开一扇登录 webview（finishQrLogin），所以异常也收在这里——
          // 一次没人接住的抛出会让界面永远停在「已确认，正在完成登录…」，失败广播就不会来了。
          void finishQrLogin(result.callbackUrl, attempt).catch((cause: unknown) =>
            failQrWith(err(`二维码收尾异常：${messageOf(cause)}`, kindOf(cause) ?? CORE_ERROR_KINDS.internal)),
          );
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
      stopQrSession();
      announce({ busy: false });
      return ok({ cancelled: true });
    },

    /** 取消进行中的登录（窗在 Rust 手里，这里只是把要求转过去）；没有进行中的登录时不打扰宿主。 */
    // 二维码确认后开出的登录 webview（qrWindow）也算进行中的登录：用户看得见、也该能取消。
    async cancelLogin(): Promise<CoreResult<{ cancelled: boolean }>> {
      if (inFlight === null && (qrWindow === null || qrWindow.isSettled())) return ok({ cancelled: false });
      return host.cancelLogin();
    },

    /** 启动期恢复：读会话 → 验证 → 如实报状态（不是布尔）；这一层只管 restoring 的开与关。 */
    // 结论逻辑全在 performRestore；sidecar 先注册 auth:get-status 再 await restore()，那一问必落在恢复期间。
    async restore(): Promise<RestoreStatus> {
      // 同步置位（不能晚一个 await）：渲染层那一问可能已经排在队列里了
      restoring = true;
      try {
        return await performRestore();
      } finally {
        // 结论已落定（`session` 该有就有、该空就空），快照从此照实答
        restoring = false;
      }
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

    /** 当前会话 + 它属于哪一代（业务请求用它绑定凭据）。 */
    currentSession(): { session: unknown; epoch: number } {
      return { session, epoch };
    },

    /** 业务请求用的会话：先判到期，到期就收回并回到登录页，返回 null。 */
    activeSession(): unknown {
      expireIfDue();
      return session;
    },

    status(): { loggedIn: boolean; epoch: number; loginInFlight: boolean } {
      return { loggedIn: session !== null, epoch, loginInFlight: inFlight !== null };
    },

    /** 当前状态快照：auth:get-status 的应答体，与 auth:status 广播同形状（同一个 statusPayload 构造点）。 */
    // 广播只在变化时说话，而渲染层 reload/崩溃重启后“现在是什么”无处可等；先判到期（到期时那条广播带原因），快照本身不带 message。
    statusSnapshot(): AuthStatusPayload {
      expireIfDue();
      return statusPayload({ busy });
    },

    /** 生效的端点配置（**loginex 为 null 就是"未知"**，不是"待会儿补"）。 */
    endpoints(): AuthEndpoints {
      return { ...endpoints };
    },
  };
}
