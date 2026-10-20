/**
 * 登录回调与登录流程编排（Node 侧）。
 *
 * 三个职责，彼此不重叠：
 * 1. `isCallback`：**回调识别唯一真源**——只认 `hms://redirect_uri`（精确到 scheme+authority+空路径）。
 *    识别过宽（例如 `hms://redirect_uri.evil.com`）就是钓鱼面，识别过窄就是 R7 的老故障：
 *    扫码成功后停在 CAS 页、`hms://` 永不触发。
 * 2. `consumeCallback` / `createCallbackConsumer`：一次性消费 + state **常量时间**比对 + 10 分钟过期。
 * 3. `runLoginFlow`：把"开窗 → 等回调"编排成四收场（callback/cancelled/closed/timed_out）
 *    外加 failed，**任何收场都恰好结算一次、都必然清理**（清浏览数据与临时目录由注入的宿主动作完成，
 *    R7 的 Rust 侧实现）。计时器与宿主全部可注入，测试不碰真实时钟。
 *    R7 补齐了两个**宿主结论**入口：`timedOut()` 与 `fail({message, kind})`——宿主（Rust 登录窗）
 *    自己也会结算超时/首载失败，流程要能按对应状态收场，而不是把它们伪装成 cancel/close。
 *
 * **宿主契约（R7 必读）**：`runLoginFlow().consumeCallback` 可以安全地喂进登录窗的**每一个导航 URL**——
 * 宿主**不必**先用 `isCallback` 预滤（预滤也正确，只是白名单导航与拦截是两件事）。
 * 只有终局错误（`LOGIN_TERMINAL_CALLBACK_ERROR_KINDS`：授权页明确拒绝 / 回调残缺 / 已过期）才结算流程；
 * `not_callback`（普通页面跳转）与 `state_mismatch`（陈旧或外来的回调）**只拒绝这一次、不结算**，
 * 流程继续等——否则一次普通导航就会永久杀死登录流。
 *
 * 导航白名单（`isAllowedLoginUrl`）是显式条目表，不是 `*.huawei.com` 通配：
 * oauth-login1 是例外里点名的域；oauth-login2 之类换区域主机不默认放行（复发同类故障要么显式加，要么不改）。
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { err, ok } from "../shared/result.ts";
import { OAUTH_REDIRECT_URI } from "./auth.mjs";

/**
 * 登录超时的唯一真源：10 分钟。
 * Rust 侧（R7 的 login.rs）实现同一语义；`test/login-parity.test.mjs` 在 login.rs 落地后自动互钉。
 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

export const LOGIN_FLOW_STATUS = {
  /** 拿到授权码（唯一成功收场） */
  callback: "callback",
  /** 用户/授权页主动取消（含 access_denied） */
  cancelled: "cancelled",
  /** 登录窗被关闭 */
  closed: "closed",
  /** 超过 LOGIN_TIMEOUT_MS */
  timedOut: "timed_out",
  /** 协议或宿主错误（回调残缺、开窗失败等；state 不符不再算收场原因） */
  failed: "failed",
};

export const LOGIN_ERROR_KINDS = {
  notCallback: "not_callback",
  oauthError: "oauth_error",
  missingParams: "missing_params",
  duplicateParams: "duplicate_params",
  stateMismatch: "state_mismatch",
  expired: "expired",
  alreadyConsumed: "already_consumed",
  alreadySettled: "already_settled",
  openFailed: "open_failed",
};

/**
 * **终局**的回调错误：出现即结算登录流（再等下去也不可能成功）。
 * - `oauth_error`：授权页明确拒绝（access_denied 等）→ cancelled；
 * - `missing_params` / `duplicate_params`：回调落在 hms:// 上但本身残缺 → failed；
 * - `expired`：回调来晚了，本次 attempt 已过期 → failed（真实时钟下超时计时器通常先一步结算 timed_out）。
 *
 * 不在此表的错误类别（`not_callback`、`state_mismatch`、…）**只拒绝这一次调用，不结算**：
 * 宿主可以把窗内每个导航 URL 都喂进来，普通页面跳转/陈旧回调不会杀死正在等的登录流。
 * 新增 kind 时必须显式决定归属（`test/login-callback.test.mjs` 有穷尽归类断言）。
 */
export const LOGIN_TERMINAL_CALLBACK_ERROR_KINDS = Object.freeze([
  LOGIN_ERROR_KINDS.oauthError,
  LOGIN_ERROR_KINDS.missingParams,
  LOGIN_ERROR_KINDS.duplicateParams,
  LOGIN_ERROR_KINDS.expired,
]);

/**
 * 登录子窗导航白名单（显式条目，逐条有出处；不放 `*.huawei.com` 通配）。
 *
 * R32 换血：条目 = 参考实现（公开仓库 `talongao/huawei-music-desktop` 的 `src/auth.mjs`）
 * `LOGIN_HOSTS` 那五个域。**为什么必须换**：授权端点换成
 * `oauth-login.platform.hicloud.com` 之后，整条跳转链的域也跟着换（授权域 → 账号 CAS 门户 →
 * 老的 `consumer/account` 页），而 R16 那条"补 id1"的教训恰恰说明：**漏一个域 = 窗里一片空白**，
 * 且只在真机上才看得出来。所以这里按参考那份**实测走通**的清单来，而不是按我们旧的观测补丁。
 *
 * 三条不再出现在这一层的东西（保留它们在历史里的地位）：
 * - `oauth-login1.cloud.huawei.com` 原本作为**整域**放行；现在只有它的
 *   `loginCallback` 精确例外（见 `LOGIN_ALLOWED_URLS`）——那是"扫码后 hms:// 才会触发"
 *   的关键落点，与参考的 regional callback 例外同义（旧仓"卡在 CAS 页"的根因）；
 * - `login.cloud.huawei.com`（旧 CAS 域）：参考清单里没有它；oauth-login1 那条链才需要。
 *
 * 证据与更新纪律见 docs/API_CONTRACT.md 的"登录域"一节；probe 观测到新跳转域时
 * **追加条目并同步测试**（`test/login-parity.test.mjs` + `src-tauri/tests/login_policy.rs`）。
 */
export const LOGIN_ALLOWED_ORIGINS = [
  "https://oauth-login.platform.hicloud.com", // 授权入口域（authorize 端点所在主机）
  "https://oauth-login.cloud.huawei.com", // 令牌兑换域（token 端点所在主机）
  /**
   * R16 增补、R32 保留：`getLoginWay` 的实探响应把浏览器送到这里——
   * `loginInteractInfo.cas.casLoginRedirectUrl = https://id1.cloud.huawei.com:443/CAS/remoteLogin?…`
   * 授权页（自身是空壳 SPA）拿到 `loginType = TICKET` 后就 `location.href = <casLoginRedirectUrl>`；
   * 这条导航被拦下 → 窗里永远停在什么也没渲染的授权页上（真机"登录窗一片空白"的根因）。
   */
  "https://id1.cloud.huawei.com", // 华为帐号 CAS 门户域（授权页的落地页）
  "https://account.huawei.com", // 账号域（参考清单条目）
  "https://consumer.huawei.com", // 消费者域（参考清单条目）
];

/**
 * 精确例外：扫码成功后回调落到这里，漏掉它就会卡在 CAS 页（旧仓历史故障根因）。
 * 显式整条列出（而不是"该域全放行"），并用 `?code=...` 也不受影响（比对时忽略 query）。
 * 与参考实现的 `regionalCallback` 判据同义（主机 + 路径都点名）。
 */
export const LOGIN_ALLOWED_URLS = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"];

const CALLBACK_SCHEME = "hms";
/** redirect_uri 的 authority 由 auth.mjs 的唯一真源解析而来，避免此处再写一份字面量。 */
const CALLBACK_AUTHORITY = new URL(OAUTH_REDIRECT_URI).hostname;

/** 精确回调识别：`hms://redirect_uri`（可带空路径或 `/`），authority 不许有 userinfo/端口/子域。 */
export function isCallback(value) {
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (raw === "") return false;

  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(raw);
  if (!match) return false;
  const [, scheme, authority, path] = match;
  if (scheme.toLowerCase() !== CALLBACK_SCHEME) return false;
  if (authority.toLowerCase() !== CALLBACK_AUTHORITY) return false;
  return path === "" || path === "/";
}

/** 取 `?` 之后的查询串（`#` 之后不算）。 */
function queryOf(value) {
  const withoutFragment = value.split("#", 1)[0];
  const index = withoutFragment.indexOf("?");
  return index === -1 ? "" : withoutFragment.slice(index + 1);
}

/**
 * 解析回调 URL：先看授权页是否回了 error，再查重复参数，最后校验 code/state 齐备。
 * 返回结构里只带 code/state 本身，消息里不回显原始 URL（里面可能有敏感参数）。
 */
export function parseCallback(value) {
  if (!isCallback(value)) {
    return err(`不是登录回调 URL（只接受 ${OAUTH_REDIRECT_URI}）`, LOGIN_ERROR_KINDS.notCallback);
  }

  const params = new URLSearchParams(queryOf(value.trim()));

  const errorCode = params.get("error");
  if (errorCode !== null && errorCode !== "") {
    const description = params.get("error_description");
    const suffix = description ? `（${String(description).slice(0, 120)}）` : "";
    return err(`授权页返回错误：${String(errorCode).slice(0, 64)}${suffix}`, LOGIN_ERROR_KINDS.oauthError);
  }

  for (const key of ["code", "state"]) {
    if (params.getAll(key).length > 1) return err(`回调参数 ${key} 重复出现`, LOGIN_ERROR_KINDS.duplicateParams);
  }

  const code = params.get("code");
  const state = params.get("state");
  if (code === null || code === "" || state === null || state === "") {
    return err("回调缺少 code 或 state", LOGIN_ERROR_KINDS.missingParams);
  }
  return ok({ code, state });
}

/** state 常量时间比对：先各自哈希定长，再 timingSafeEqual（长度不等也不抛）。 */
function statesMatch(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = createHash("sha256").update(actual, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * 一次性回调消费者：先看是否已消费，再看是否过期，再解析，最后比 state。
 * 只有**成功**才标记已消费（被拒的请求不算消耗，用户仍可重扫）。
 */
export function createCallbackConsumer(options = {}) {
  const { expectedState } = options;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const createdAt = options.createdAt ?? now();
  let consumed = false;

  return {
    expectedState,
    isConsumed: () => consumed,
    consume(value) {
      if (consumed) return err("该登录尝试的回调已被消费（回调只接受一次）", LOGIN_ERROR_KINDS.alreadyConsumed);
      if (now() - createdAt > timeoutMs) return err("登录尝试已过期（超过 10 分钟）", LOGIN_ERROR_KINDS.expired);

      const parsed = parseCallback(value);
      if (!parsed.ok) return parsed;
      if (!statesMatch(parsed.data.state, expectedState)) {
        return err("state 不匹配：该回调不属于本次登录尝试", LOGIN_ERROR_KINDS.stateMismatch);
      }
      consumed = true;
      return parsed;
    },
  };
}

/**
 * 便捷入口：一次性语义记在传入的 `session` 上（`{expectedState, createdAt, timeoutMs, now}`）。
 * 需要独立状态时用 `createCallbackConsumer`。
 */
export function consumeCallback(value, session = {}) {
  if (session.consumed === true) {
    return err("该登录尝试的回调已被消费（回调只接受一次）", LOGIN_ERROR_KINDS.alreadyConsumed);
  }
  const consumer = createCallbackConsumer({
    expectedState: session.expectedState,
    createdAt: session.createdAt,
    timeoutMs: session.timeoutMs,
    now: session.now,
  });
  const result = consumer.consume(value);
  if (result.ok) session.consumed = true;
  return result;
}

/** 导航白名单：https + 显式 origin 条目，或显式整条 URL 例外。 */
export function isAllowedLoginUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (LOGIN_ALLOWED_ORIGINS.includes(url.origin)) return true;
  return LOGIN_ALLOWED_URLS.includes(`${url.origin}${url.pathname}`);
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/**
 * 登录流程编排。
 *
 * @param {{authorizeUrl: string, expectedState: string,
 *          host: {openLogin(url): unknown, closeLogin(): void, cleanup(): void},
 *          timeoutMs?: number, now?: () => number,
 *          setTimer?: Function, clearTimer?: Function}} options
 * @returns {{settled: Promise<object>, isSettled(): boolean,
 *           consumeCallback(url: string): {ok: true, data: {code: string, state: string}} | {ok: false, error: {message: string, kind: string}},
 *           cancel(): {ok: boolean}, close(): {ok: boolean},
 *           timedOut(): {ok: boolean}, fail(error?: {message: string, kind?: string}): {ok: boolean}}}
 */
export function runLoginFlow(options = {}) {
  const {
    authorizeUrl,
    expectedState,
    host,
    timeoutMs = LOGIN_TIMEOUT_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  if (typeof authorizeUrl !== "string" || authorizeUrl.trim() === "") {
    throw new TypeError("runLoginFlow 需要非空 authorizeUrl");
  }
  if (typeof expectedState !== "string" || expectedState === "") {
    throw new TypeError("runLoginFlow 需要非空 expectedState");
  }
  if (!host || typeof host !== "object") throw new TypeError("runLoginFlow 需要注入宿主 host");
  if (typeof host.openLogin !== "function") throw new TypeError("host.openLogin 必须是函数");
  if (typeof host.closeLogin !== "function") throw new TypeError("host.closeLogin 必须是函数");
  if (typeof host.cleanup !== "function") throw new TypeError("host.cleanup 必须是函数（结束必清浏览数据与临时目录）");

  const effectiveTimeout = timeoutMs ?? LOGIN_TIMEOUT_MS;
  const consumer = createCallbackConsumer({ expectedState, timeoutMs: effectiveTimeout, now });

  let settled = false;
  let timerHandle = null;
  let resolveSettled;
  const settledPromise = new Promise((resolve) => {
    resolveSettled = resolve;
  });

  /**
   * 清理必发生：closeLogin 抛错也要继续走到 cleanup；两者的失败都如实带出，但**不改写收场结论**。
   * 已知收场原因不能因为"关窗失败"变成 failed——那会让上层误判登录结果。
   */
  function cleanup() {
    let failure = null;
    try {
      host.closeLogin();
    } catch (cause) {
      failure = messageOf(cause);
    }
    try {
      host.cleanup();
    } catch (cause) {
      failure = failure ?? messageOf(cause);
    }
    return failure;
  }

  function finish(outcome) {
    if (settled) return err("本次登录流程已结算", LOGIN_ERROR_KINDS.alreadySettled);
    settled = true;
    if (timerHandle !== null) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    const cleanupError = cleanup();
    resolveSettled(cleanupError === null ? { ...outcome } : { ...outcome, cleanupError });
    return ok(outcome.status);
  }

  timerHandle = setTimer(() => {
    finish({ status: LOGIN_FLOW_STATUS.timedOut });
  }, effectiveTimeout);

  try {
    const opening = host.openLogin(authorizeUrl.trim());
    if (opening && typeof opening.then === "function") {
      opening.catch((cause) => {
        finish({ status: LOGIN_FLOW_STATUS.failed, error: { message: messageOf(cause), kind: LOGIN_ERROR_KINDS.openFailed } });
      });
    }
  } catch (cause) {
    finish({ status: LOGIN_FLOW_STATUS.failed, error: { message: messageOf(cause), kind: LOGIN_ERROR_KINDS.openFailed } });
  }

  return {
    settled: settledPromise,
    isSettled: () => settled,
    /**
     * 交付一次导航 URL。允许（并鼓励）宿主把窗内每个导航都喂进来：
     * - 成功 → callback 收场；
     * - 终局错误（见 LOGIN_TERMINAL_CALLBACK_ERROR_KINDS）→ 结算（oauth_error = cancelled，其余 failed）；
     * - 非终局错误（not_callback / state_mismatch）→ **只把错误返回，不结算**，流程继续等；
     * - 已结算 → already_settled。
     */
    consumeCallback(value) {
      if (settled) return err("本次登录流程已结算", LOGIN_ERROR_KINDS.alreadySettled);
      const parsed = consumer.consume(value);
      if (parsed.ok) {
        finish({ status: LOGIN_FLOW_STATUS.callback, code: parsed.data.code, state: parsed.data.state });
        return parsed;
      }
      if (!LOGIN_TERMINAL_CALLBACK_ERROR_KINDS.includes(parsed.error.kind)) {
        return parsed;
      }
      if (parsed.error.kind === LOGIN_ERROR_KINDS.oauthError) {
        finish({ status: LOGIN_FLOW_STATUS.cancelled, error: parsed.error });
        return parsed;
      }
      finish({ status: LOGIN_FLOW_STATUS.failed, error: parsed.error });
      return parsed;
    },
    cancel() {
      return finish({ status: LOGIN_FLOW_STATUS.cancelled });
    },
    close() {
      return finish({ status: LOGIN_FLOW_STATUS.closed });
    },
    /**
     * R7 增补：宿主报来的**总超时**收口（`timed_out`）。
     *
     * 计时器到点时走的就是这条收场（内部同一个 `finish`），但宿主（Rust 登录窗）自己也会在
     * 10 分钟到点时结算并把它交回 Node——那时流程必须按"超时"结算，**不能伪装成 cancel/close**：
     * 上层要能分清"窗口被关了"（用户主动）与"等超时了"（该劝用户重扫/查网络）。
     */
    timedOut() {
      return finish({ status: LOGIN_FLOW_STATUS.timedOut });
    },
    /**
     * R7 增补：宿主报来的**失败**收口（`failed` + 宿主给的 `{message, kind}`）。
     *
     * 用在"连官方页都没打开"这类宿主侧结论上（Rust 的首载 30 秒期限）：文案由宿主给，
     * 上层原样显示——比笼统的"登录失败"更能告诉用户下一步该干什么（查网络还是查代理）。
     */
    fail(error) {
      return finish({ status: LOGIN_FLOW_STATUS.failed, error: error ?? undefined });
    },
  };
}
