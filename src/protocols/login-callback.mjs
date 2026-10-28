/**
 * 登录回调与登录流程编排（Node 侧）。
 *
 * `isCallback` 是回调识别唯一真源（只认 `hms://redirect_uri`）。
 * `consumeCallback` 一次性消费、常量时间比对、10 分钟过期。
 * `runLoginFlow` 编排「开窗 → 等回调」。
 * 四收场外加 failed，**任何收场都恰好结算一次、都必然清理**。
 * 宿主契约：`consumeCallback` 可安全喂进登录窗每个导航 URL，不必先预滤。
 * 只有终局错误才结算；`not_callback`、`state_mismatch` 只拒绝这一次，流程继续等。
 * 导航白名单是显式条目表，不是 `*.huawei.com` 通配。
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { err, ok } from "../shared/result.ts";
import { OAUTH_REDIRECT_URI } from "./auth.mjs";

/**
 * 登录超时的唯一真源：10 分钟；Rust 侧（`login.rs`）同语义，由 `test/login-parity.test.mjs` 互钉。
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
 * **终局**的回调错误：出现即结算登录流（`oauth_error` → cancelled，其余 → failed）。
 * 不在此表的错误类别（`not_callback`、`state_mismatch`、…）**只拒绝这一次调用，不结算**。
 */
export const LOGIN_TERMINAL_CALLBACK_ERROR_KINDS = Object.freeze([
  LOGIN_ERROR_KINDS.oauthError,
  LOGIN_ERROR_KINDS.missingParams,
  LOGIN_ERROR_KINDS.duplicateParams,
  LOGIN_ERROR_KINDS.expired,
]);

/**
 * 登录子窗导航白名单（显式条目，逐条有出处；不放 `*.huawei.com` 通配）。
 * 漏一个域 = 窗里一片空白，且只有真机才看得出来；probe 观测到新跳转域时追加条目并同步两侧测试。
 */
export const LOGIN_ALLOWED_ORIGINS = [
  "https://oauth-login.platform.hicloud.com", // 授权入口域（authorize 端点所在主机）
  "https://oauth-login.cloud.huawei.com", // 令牌兑换域（token 端点所在主机）
  /**
   * 授权页拿到 `loginType = TICKET` 后跳到 CAS 门户（`id1.cloud.huawei.com`）；拦下这条导航，窗里就永远停在空白授权页。
   */
  "https://id1.cloud.huawei.com", // 华为帐号 CAS 门户域（授权页的落地页）
  "https://account.huawei.com", // 账号域（参考清单条目）
  "https://consumer.huawei.com", // 消费者域（参考清单条目）
];

/**
 * 精确例外：扫码成功后回调落到这里，漏掉就会卡在 CAS 页（主机 + 路径都点名，比对时忽略 query）。
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
 *          timeoutMs?: number, createdAt?: number, now?: () => number,
 *          setTimer?: Function, clearTimer?: Function}} options
 *        `createdAt` 是这次登录**尝试**的建立时刻，默认 = 开窗那一刻。
 *        二维码那条路要先建尝试再开窗。
 * @returns {{settled: Promise<object>, isSettled(): boolean,
 *           consumeCallback(url: string):
 *             {ok: true, data: {code: string, state: string}}
 *             | {ok: false, error: {message: string, kind: string}},
 *           cancel(): {ok: boolean}, close(): {ok: boolean},
 *           timedOut(): {ok: boolean},
 *           fail(error?: {message: string, kind?: string}): {ok: boolean}}}
 */
export function runLoginFlow(options = {}) {
  const {
    authorizeUrl,
    expectedState,
    host,
    timeoutMs = LOGIN_TIMEOUT_MS,
    createdAt,
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
  const consumer = createCallbackConsumer({ expectedState, timeoutMs: effectiveTimeout, now, createdAt });

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
     * 交付一次导航 URL：成功 → callback 收场；终局错误 → 结算；非终局错误 → 只返回错误、流程继续等。
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
     * 宿主报来的**总超时**收口（`timed_out`）：不能伪装成 cancel/close，上层要能分清「窗口被关了」与「等超时了」。
     */
    timedOut() {
      return finish({ status: LOGIN_FLOW_STATUS.timedOut });
    },
    /**
     * 宿主报来的**失败**收口（`failed` + 宿主给的 `{message, kind}`）；文案由宿主给，上层原样显示。
     */
    fail(error) {
      return finish({ status: LOGIN_FLOW_STATUS.failed, error: error ?? undefined });
    },
  };
}
