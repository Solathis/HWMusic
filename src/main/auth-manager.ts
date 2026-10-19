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
  runLoginFlow,
} from "../protocols/login-callback.mjs";
import { AUTH_STATUS } from "../shared/channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

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

  let epoch = 0;
  let session: unknown = null;
  let inFlight: Promise<CoreResult<{ session: unknown; epoch: number }>> | null = null;

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
