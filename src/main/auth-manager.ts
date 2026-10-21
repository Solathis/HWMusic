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
 * 音乐会话兑换（loginex，**注入式**：端点值住在 [`HUAWEI_OAUTH_ENDPOINTS`]，R17 起有确认值；
 * 显式注入 `null` 时回到结构化「待联调」，绝不猜 URL）→
 * `favorites` 验证会话 → 存盘（R5 DPAPI 信封）→ 广播 `auth:status`。
 *
 * R16 增补**二维码路径**（`startQrLogin` / `cancelQrLogin`）：引导页直接显示二维码，
 * 端口（`src/main/qr-login.mjs`）在 sidecar 里建单 + 轮询，状态变化经 `auth:qr` 广播；
 * 用户手机确认后端口交回 `callbackURL`，于是"确认之后"的部分与开窗路径
 * **共用同一条兑换链**（`completeWithCode`）——两条路不可能各自演化出不同的登录语义。
 *
 * R36 增补**二维码确认之后的最后一跳改走登录 webview**（用户真机诊断定案）：
 * 端口交回的 `callbackURL` 是 **https 的登录收尾页**（查询里没有 `code`、200 的体里没有 `hms` 字样），
 * **服务端 fetch 结构性地拿不到授权码**（R33 的跟随 / R34 的三策略 / R35 的诊断全部因此退役）。
 * 唯一被实证走通的路子是**账号密码网页登录**那条："webview 里加载官方页 → 页面自己的 JS 执行 →
 * 跳 `hms://` → 被导航拦截器接住"。所以 `finishQrLogin` 现在：已经是回调就照旧消费（既有链零改动），
 * 是收尾页就**经宿主要求开一扇登录 webview**加载它（复用既有 `host:open-login` 那条路径），
 * webview 的结论回到同一条兑换链上。**选型是两流合一**：这一段的流直接复用 R7 的 `runLoginFlow`
 * （同一个 `startLoginFlow` 装配点），两条路共用一份收场/清理实现。
 * 那一扇窗在 [`qrWindow`] 上登记着，于是 `login()` 会如实拒、`cancelLogin()` 也关得掉它。
 *
 * R18 增补**两条路互斥**：`login()` 开窗之前先 `stopQrSession()`（停轮询 + 作废待兑换的尝试），
 * 迟到的二维码确认由 `onConfirmed` 的身份比对丢掉；`busy` 只描述开窗那条路（二维码等待期间
 * 不占），否则引导页那枚**常驻**的「在网页中打开登录」会被禁用。
 *
 * R19 增补**状态快照**（`statusSnapshot()`）：`auth:status` 只在启动时播一次，渲染层
 * reload/崩溃重启之后拿不到 → 门禁永久卡在 `checking`。快照与广播共用 `statusPayload`
 * （同一份载荷构造），所以"查到的"与"播出去的"不可能各说各话。
 *
 * 三条不妥协的诚实性规矩：
 * 1. **没验过的会话不广播"已登录"**：验证失败有两大类——"会话失效"与"没法验证"（端点还没确定），
 *    两者在返回值里分开报（`session_invalid` / `verify_unavailable`），绝不混成一个"未登录"。
 * 2. **存盘失败保留旧会话**：新会话写不进去时，磁盘与内存都保持原样（R5 的原子替换语义），
 *    epoch 不前进——在途请求继续绑旧会话，而不是绑一个没落盘的会话。
 * 3. **端点未知就是未知**：`loginex` 的**默认值只在有公开证据时才写**（R17 之前是 `null`）；
 *    显式注入 `null` 时返回结构化错误，一次请求都不发。
 */
import { createAttempt, exchangeAuthorizationCode, AUTH_ERROR_KINDS as OAUTH_ERROR_KINDS } from "../protocols/auth.mjs";
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
import { HUAWEI_MUSIC_LOGINEX_ENDPOINT, createHuaweiMusicSessionPort } from "./music-session.mjs";
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
 * OAuth 端点：**R32 起取参考实现实测的那一组**（登记在 `docs/API_CONTRACT.md` §1.2/§1.3）。
 *
 * 为什么要在这里写默认值：`src/protocols/auth.mjs` 坚持"端点一律注入、代码里不写死"，
 * 而总得有人把已确认的事实注入进去——本模块就是那个调用方。默认值可被构造参数覆盖
 * （探针更新后改一处），`test/auth-manager.test.mjs` 会拿契约文件反查这两个字面量。
 *
 * **换血原因（R32 的真机结论）**：R4 探针把 authorize/token 都登记成
 * `oauth-login1.cloud.huawei.com`——那只证明"该域可达且路径存在"，不证明"这就是客户端该用的端点"。
 * 参考实现（公开仓库 `talongao/huawei-music-desktop`，2026-10-14 本人账号实验）用的是
 * **两个不同主机**：授权在 `oauth-login.platform.hicloud.com`，兑换在 `oauth-login.cloud.huawei.com`。
 * 用错主机的后果不是"报错"，而是授权页照常打开、`hms://` 照常回调，之后整条链拿不到能用的令牌
 * ——所以这里以参考的实测值为准。
 *
 * `loginex`（R17 补上）：值来自 `src/main/music-session.mjs`；"拿有效 AT 换到真会话"仍未本机实测
 * （要用户授权），端点形状与 Digest 头形状来自同一份公开来源。
 */
export const HUAWEI_OAUTH_ENDPOINTS = {
  authorize: "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize",
  token: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
  loginex: HUAWEI_MUSIC_LOGINEX_ENDPOINT,
} as const;

/** 端点配置（`loginex` 显式注入 `null` = "这条路这次不用"，不是"待会儿补"）。 */
export interface AuthEndpoints {
  authorize: string;
  token: string;
  /** 音乐会话兑换端点（旧仓称 loginex）：R17 起默认值是确认过的值，可注入 `null` 关掉 */
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

/** loginex 端点被显式关掉（注入 `null`）时的结构化说明（**不猜 URL**）。 */
export const LOGINEX_PENDING_MESSAGE =
  "音乐会话兑换（loginex）端点被显式关闭（注入 endpoints.loginex = null）：不猜 URL、不发请求。";

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
 *
 * R36：`onConfirmed` 交回的是 `codeRemoteLogin` 的 **`callbackURL` 原文**——真机形状是 https 的
 * 登录收尾页（那一跳由登录 webview 完成），也可能是 `hms://` 回调（[`finishQrLogin`] 两条分支）。
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
  /** 端点配置覆盖（默认取 [`HUAWEI_OAUTH_ENDPOINTS`]，含 R17 确认的 `loginex`） */
  endpoints?: Partial<AuthEndpoints>;
  /** 授权码兑换（默认 R4 的 `exchangeAuthorizationCode`） */
  exchangeCode?: (params: {
    endpoint: string;
    code: string;
    codeVerifier: string;
  }) => Promise<CoreResult<Record<string, unknown>>>;
  /**
   * 音乐会话兑换（默认：R17 接通的 [`createHuaweiMusicSessionPort`]——真发请求。
   * 端点被显式注入 `null` 时**在调用它之前**就收口成结构化「待联调」，一次请求都不发）
   */
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

/**
 * 「端点被关掉」那一档的兑换实现：**什么都不做，如实说"待联调"**（不许猜 URL、不许发请求）。
 *
 * R17 起这不再是默认值——默认值换成了真发请求的 [`createHuaweiMusicSessionPort`]。
 * 留在这里是为了让"显式注入 `endpoints.loginex = null`"这条路仍有一个诚实的落点
 * （离线/受限环境排障、以及将来端点失效时的降级）。
 */
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
    // 注意 `??` 与 `in` 的区别：显式传 `loginex: null` 是**有意的关闭**（保留 null），
    // 没传才取 R17 确认的默认值。写成 `?? HUAWEI_OAUTH_ENDPOINTS.loginex` 会让"关掉"变成"打开"。
    loginex: "loginex" in (deps.endpoints ?? {}) ? (deps.endpoints?.loginex ?? null) : HUAWEI_OAUTH_ENDPOINTS.loginex,
  };
  const exchangeCode = deps.exchangeCode ?? exchangeAuthorizationCode;
  const exchangeMusicSession = deps.exchangeMusicSession ?? createHuaweiMusicSessionPort();
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
  /**
   * "开窗那条路正在跑"这一事实的**唯一内存真源**（`auth:status.busy` 与状态快照共用）。
   *
   * 为什么不让快照现读 `inFlight`：`inFlight` 的清理挂在 promise 的 `finally` 上，比收场那条
   * 广播**晚一个微任务**——两处各算一份就会出现"广播说空闲、查询说忙"的一瞬。查询（R19）正是
   * 渲染层 reload 之后来问的，它必须与广播说同一句话，所以两者同源。
   */
  let busy = false;
  /**
   * **二维码那条路开出来的那扇登录 webview**（R36）：跑着的时候它占在 `qrWindow` 上。
   *
   * 为什么要有这一格：R36 起二维码确认之后的最后一跳由宿主开一扇登录 webview 完成
   * （`finishQrLogin`），那扇窗与"网页登录"那条路开的是**同一扇宿主窗**——所以：
   * - `login()` 在它跑着的时候必须拒（宿主那侧会回 `login_in_progress`，这里先拦一道）；
   * - `cancelLogin()` 必须能关掉它（否则那句"没有进行中的登录"就是假话）。
   * 收场（成功/失败/取消/超时）由 `finally` 清空。
   */
  let qrWindow: ReturnType<typeof runLoginFlow> | null = null;

  /** 宿主交付物：结论，或"开窗本身就失败了"（后者的类别比任何结论都具体，别被改写成笼统的 failed）。 */
  type Deliverable =
    | { kind: "conclusion"; conclusion: HostConclusion }
    | { kind: "openFailure"; message: string; errorKind: string };

  /**
   * `auth:status` 的载荷形状（**广播与 `auth:get-status` 的应答共用这一处**）。
   *
   * 共用的理由不是"少写几行"：R19 那条查询频道的契约就是"与广播同形状"，两处各拼一份载荷，
   * 早晚会出现"广播多了个字段、查询没跟上"——而渲染层是按广播载荷读它的。
   *
   * `message` 只有真有事说的时候才出现（对象里没有这个键 ≠ 值是 undefined）：
   * 渲染层靠 `typeof payload.message === "string"` 判"这条广播带话"。
   */
  function statusPayload(extra: { busy?: boolean; message?: string } = {}): {
    loggedIn: boolean;
    busy: boolean;
    message?: string;
  } {
    const payload: { loggedIn: boolean; busy: boolean; message?: string } = {
      loggedIn: session !== null,
      busy: extra.busy ?? false,
    };
    if (typeof extra.message === "string" && extra.message !== "") payload.message = extra.message;
    return payload;
  }

  /** 状态广播：载荷 `{loggedIn, busy, message?}`（渲染层门禁按它决定显示哪一层）。 */
  function announce(extra: { busy?: boolean; message?: string } = {}): void {
    const payload = statusPayload(extra);
    // 广播与查询同源：播出去的这一份就是"当前状态"，`busy` 也跟着它走
    busy = payload.busy;
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

  /**
   * 起一条"开窗 → 等结论"的登录流（R7 的 [`runLoginFlow`]），并把宿主交付物接到它身上。
   *
   * **R36：两条路共用这一处**——网页登录那条路（[`performLogin`]）与二维码确认之后的最后一跳
   * （[`finishQrLogin`]）都是"宿主开一扇 webview、等它给出结论"。抽取的理由不是"少写几行"，
   * 而是**两处不可能各自演化**：开窗失败/回调/取消/关窗/超时/首载失败六种交付物的结算、
   * 以及"结束必清理"的语义只有一份实现（`applyDeliverable` + `failureOf`）。
   *
   * `flowRef` 缓冲那一小段是 R4 就有的保险：流程对象在 `openLogin` 里被**同步**调用，
   * 而结论只能从 promise 回调里到达——缓冲省掉一整类"靠时序侥幸成立"。
   *
   * @param {{url: string, expectedState: string, createdAt?: number}} params
   *        `createdAt` = 这次**尝试**的建立时刻（R36：二维码那条路的 attempt 建立在前、窗开在后，
   *        所以过期必须锚在 attempt 上，而不是锚在"窗开了多久"——见 `runLoginFlow` 的说明）
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

    // 端点被显式关掉时**在兑换之前**收口：一次请求都不发（"不猜 URL"这条不变的落点）。
    // 放在这里而不是交给端口：端口只管"拿到端点怎么发"，"能不能发"是状态机的决定。
    if (endpoints.loginex === null) {
      return failWith(err(LOGINEX_PENDING_MESSAGE, AUTH_ERROR_KINDS.loginexPending));
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
   * **`failed` 仍要顺带播一条 `busy:false`**：R18 起二维码等待期间本来就不占 `busy`
   * （见 `startQrLogin`），这一条因此多半是幂等的；留着是因为它守的是"失败之后界面一定是
   * 非忙态"这条不变量——失败路径不许把用户留在"正在准备"上（`canStartLogin` / `canRetryQr`
   * 都读这份状态，R17 抓到过"最需要它时按钮恰好是灰的"）。
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
   * 二维码确认之后的**最后一跳**（R36 重写：从"服务端解析 callbackURL"改成"交给登录 webview"）。
   *
   * 真机诊断定案（R35 日志）：端口交回的那个 `callbackURL` 是 **https 的登录收尾页**，而它的
   * 查询里**没有 `code`**（只有 ticket/siteID/flowID 一类的票据参数）、200 那份 14KB HTML 里
   * **没有 `hms` 字样**（跳转目标是页面自己的 JS 现拼的）⇒ **服务端 fetch 结构性地拿不到 code**。
   * 同一个应用里的对照组给出了唯一被实证的走法：**账号密码网页登录**能走通，靠的正是
   * "webview 里加载官方页 → 页面自己的 JS 执行 → 跳 `hms://` → 被导航拦截器接住"。
   *
   * 所以这里两条分支：
   *
   * 1. **本来就是回调**（`hms://redirect_uri?code&state`）→ 不必开窗，`consumeCallback` 之后照旧
   *    走兑换链（既有链零改动；宿主那侧也只收 https 的登录页，喂 hms:// 给它是白跑一趟）；
   * 2. **https 的登录收尾页**（真机形状）→ **经宿主要求开登录 webview 加载它**（复用既有
   *    `host:open-login` 那条路径）：页面 JS 跳 `hms://`，导航拦截器把原样 URL 交回，
   *    那条结论回到**同一条兑换链**（`consumeCallback → exchangeCode → loginex → 会话落地`）。
   *
   * **选型：两流合一**——第 2 条**直接复用 R7 的 [`runLoginFlow`]**（同一个 [`startLoginFlow`]
   * 装配点），而不是在这一层另写一份"等 webview 结论"的循环：开窗/取消/关窗/超时/首载失败的
   * 收场与清理只有一份实现，两条路不可能各自演化。QR 的 attempt 通过 `expectedState` 与
   * `createdAt` 传进同一条流（**同一个 OAuth attempt**：R34 已核实建单链的 state 就是
   * `attempt.state`），所以 `consumeCallback` 的校验天然成立、过期也仍然只说"这次尝试的寿命到了"。
   *
   * 收场与既有语义逐条一致：非 callback 的四收场走 `failureOf`（已取消 / 关窗 / 超时 / 首载失败），
   * 一律经 `failQrWith` —— 二维码这条路**每一步失败都得让界面知道"这条路走完了"**，用户才有
   * "重试"可按。
   *
   * 注意 `completeWithCode` 是两条路共用的，它**不**播 `auth:qr`（那条路上没有二维码）——
   * 所以"补一条二维码失败广播"的责任落在本函数里。
   *
   * R18：`attempt` 由调用方传进来（而不是读当前的 `qrAttempt`）——**迟到的确认**（用户改走
   * 网页那条路之后手机才点了确认）必须能被认出来并丢掉，否则一次作废的会话会去换一次码。
   */
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
    // 窗真的开了：`busy` 描述的就是"开窗那条路正在跑"（R18 的口径），此刻它确实在跑。
    // 渲染层因此把状态行留在「已确认，正在完成登录…」（QR 这条路的既有文案），
    // 而渲染层 reload 之后只凭 busy 也知道有一扇窗开着。
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

  /**
   * 停掉当前的二维码会话（R18 的互斥用）。
   *
   * **不广播**：它是"开窗之前的一次内部清场"（`login()` 紧接着就播 `busy:true`），
   * 多播一条 `busy:false` 会让渲染层把网页那条路误判成"已收场"（见 login-gate-logic 的不变量 6）。
   * 用户主动取消那条路（`cancelQrLogin`）在它之上补一条广播。
   */
  function stopQrSession(): void {
    qrAttempt = null;
    try {
      qrPort.cancel();
    } catch (cause) {
      log(`停止二维码会话失败：${messageOf(cause)}`);
    }
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
      // R36：二维码确认之后开出来的那扇登录 webview 也算"一次登录在进行"——
      // 宿主同一时刻只有一扇登录窗，再开一扇只会撞上它的 `login_in_progress`，这里先如实拦一道。
      if (qrWindow !== null) {
        return Promise.resolve(
          err("二维码确认后正在用登录窗口完成收尾（窗口会被拉到前台）", AUTH_ERROR_KINDS.loginInProgress),
        );
      }
      // R18：两条路互斥——先把二维码会话停掉（停轮询、作废待兑换的尝试）再开窗。
      // 不停的话两条路会并发：手机恰好在窗打开之后点了确认，就会多换一次码（迟到的确认
      // 由 onConfirmed 里的身份比对丢掉，见 startQrLogin）。这一句**不广播**（见 stopQrSession）。
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

    /**
     * 发起二维码登录（R16）：引导页**自动**调这一条，界面上只有"重试"会在失败态出现。
     *
     * **R18 起不再播 `busy:true`**：`busy` 只描述"开窗那条路正在跑"。等扫码期间占着 busy，
     * 常驻的「在网页中打开登录」就会被 `disabled`（R17 抓到的正是这一类"最需要它时点不动"）。
     * 二维码自己的进度经 `auth:qr` 广播说（渲染层按它显示"正在准备/等待扫码…"）。
     *
     * 返回值只带"这一张二维码是什么"（内容 + 有效期）——渲染层拿它立刻就能画出来，不必等广播。
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

      const started = await qrPort.start({
        authorizeUrl: attempt.authorizeUrl,
        onEvent: (event) => broadcastQr(event),
        onConfirmed: (result) => {
          // 迟到的确认（R18）：这次会话已经被停掉（用户改走网页那条路，或又开了一张新码）时，
          // 回调属于一次作废的尝试——不换码、不广播（否则会在窗还开着的时候把界面踢回二维码态）
          if (qrAttempt !== attempt) {
            log("二维码确认到达时那次尝试已作废：不换码、不广播（迟到的确认不属于当前这条路）");
            return;
          }
          qrAttempt = null;
          // R36：这一次收尾可能开一扇登录 webview（`finishQrLogin`），所以把异常也收在这里——
          // 一次没人接住的抛出会让界面永远停在「已确认，正在完成登录…」（失败广播就不会来了）。
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

    /**
     * 取消进行中的登录（窗在 Rust 手里，这里只是把要求转过去）。
     *
     * 没有进行中的登录时**不去打扰宿主**：什么都没取消不是错误（用户的意图"别等了"已经满足），
     * 重复点取消按钮不该看到一个报错，也不该在宿主不可用时弹一条假故障。
     *
     * R36：二维码确认之后开出来的那扇登录 webview（[`qrWindow`]）也算"进行中的登录"——
     * 它是一扇真实的宿主登录窗，用户能看见、也该能取消。看不见它会让这条 API 说谎
     * （"没有进行中的登录"而窗明明开着），也会让 sidecar 收尾时漏掉一扇没关的窗。
     */
    async cancelLogin(): Promise<CoreResult<{ cancelled: boolean }>> {
      if (inFlight === null && (qrWindow === null || qrWindow.isSettled())) return ok({ cancelled: false });
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

    /**
     * 当前状态**快照**（R19）：`auth:get-status` 的应答体，与 `auth:status` 广播**同形状**
     * （同一个 `statusPayload` 构造点，所以两边不可能长成两个样子）。
     *
     * 存在理由：广播只在**变化时**说话，而"渲染层 reload/崩溃重启之后现在的状态是什么"
     * 是一个没有事件可等的提问——`NoticeQueue` 的启动期冲刷只发生一次，错过了就永远错过了，
     * 门禁会一直停在 `checking`。这条查询让渲染层每次 boot 都能确定性地拿到答案。
     *
     * 它**不广播**（有应答就不需要再播一条），也**不带 message**：那是"刚发生的那件事"，
     * 属于广播；快照只答"现在是什么"。
     */
    statusSnapshot(): { loggedIn: boolean; busy: boolean; message?: string } {
      return statusPayload({ busy });
    },

    /** 生效的端点配置（**loginex 为 null 就是"未知"**，不是"待会儿补"）。 */
    endpoints(): AuthEndpoints {
      return { ...endpoints };
    },
  };
}
