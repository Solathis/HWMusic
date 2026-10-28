/**
 * 登录宿主端口（Node 侧）：把开官方登录窗、取消、收尾包成 `runLoginFlow` 的宿主。
 * `host:open-login` 是长轮询，答复发生在登录窗收场之后，超时必须覆盖整段登录等待。
 * 不认识的结论一律报 `invalid_host_conclusion`，绝不猜；回调 URL 原样带出，判真伪交给 `consumeCallback`。
 */
import { randomBytes } from "node:crypto";

import { LOGIN_TIMEOUT_MS } from "../protocols/login-callback.mjs";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

import type { CoreResult } from "../shared/result.ts";

/** 宿主结论的 `status` 词表（Rust `login.rs` 的 `LoginConclusion::status` 镜像，parity 互钉）；刻意不含流程内部的 `failed`。 */
export const HOST_LOGIN_STATUS = {
  /** 拿到 `hms://` 回调（`url` 原样带出） */
  callback: "callback",
  /** 用户/渲染层取消 */
  cancelled: "cancelled",
  /** 登录窗被关闭 */
  closed: "closed",
  /** 超过总期限（10 分钟） */
  timedOut: "timed_out",
  /** 首载期限内打不开官方页（网络/代理） */
  loadFailed: "load_failed",
} as const;

export type HostLoginStatus = (typeof HOST_LOGIN_STATUS)[keyof typeof HOST_LOGIN_STATUS];

/** 首载超时文案（与 Rust `LOGIN_LOAD_TIMEOUT_MESSAGE` 逐字一致，parity 互钉）。 */
export const LOGIN_PAGE_UNAVAILABLE_MESSAGE = "无法打开华为官方登录页面，请检查网络或代理后重试。";

/** 总超时文案（与 Rust `LOGIN_TOTAL_TIMEOUT_MESSAGE` 逐字一致，parity 互钉）。 */
export const LOGIN_TIMEOUT_MESSAGE = "登录超时（10 分钟内未完成扫码），请重试。";

/** 开窗调用超时的余量：覆盖"等扫码"（10 分钟）之后的拆窗（清数据 + 退避删目录，最长约 2 秒）。 */
export const LOGIN_HOST_CALL_SLACK_MS = 60_000;

/** `host:open-login` 的调用超时（**不是**登录期限；登录期限由 `runLoginFlow` 管）。 */
export const LOGIN_HOST_TIMEOUT_MS = LOGIN_TIMEOUT_MS + LOGIN_HOST_CALL_SLACK_MS;

/** 取消失败/超时的上限：取消是"顺手关窗"，不该让渲染层的按钮等太久。 */
export const LOGIN_CANCEL_TIMEOUT_MS = 5_000;

/** 结论形状不认识时的错误类别。 */
export const INVALID_HOST_CONCLUSION_KIND = "invalid_host_conclusion";

/** 宿主交给我们的结论。 */
export interface HostConclusion {
  status: HostLoginStatus;
  /** 仅 `callback`：Rust 拦下的原始 `hms://` URL */
  url?: string;
  /** 仅 `timed_out` / `load_failed`：给用户看的文案 */
  message?: string;
}

/** `host:open-login` 的入参形状。 */
export interface OpenLoginParams {
  url: string;
  /** 一次性随机分区；缺省由 [`createPartition`] 生成 */
  partition?: string;
}

/** 宿主要求封装（`src/host/host-services.mjs` 的子集：本模块只用到这两个）。 */
export interface LoginHostServices {
  openLogin: (payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  cancelLogin: (payload?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
}

/** 交给 `runLoginFlow` 的宿主面（`auth-manager` 消费）。 */
export interface LoginHost {
  openLoginPage: (params: OpenLoginParams) => Promise<HostConclusion>;
  cancelLogin: () => Promise<CoreResult<{ cancelled: boolean }>>;
  cleanup: () => void;
}

/** 带 `kind` 的 Error：抛出后由登录流程统一结算（渲染层按 kind 分支）。 */
export function hostError(kind: string, message: string): Error & { kind: string } {
  const error = new Error(message) as Error & { kind: string };
  error.kind = kind;
  return error;
}

/** 异常 → 一段可读文本（不带堆栈、不带原始对象）。 */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  if (cause !== null && typeof cause === "object") {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "未知错误（详情见日志）";
}

/** 异常 → 错误类别（没有就返回 undefined，由调用方给默认值）。 */
export function kindOf(cause: unknown): string | undefined {
  const kind = (cause as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === "string" && kind !== "" ? kind : undefined;
}

/** 一次性登录分区：16 字节随机 → base64url 22 字符，落在 Rust 的 `[A-Za-z0-9_-]{1,64}` 校验内；每次登录一个新值，不残留上次的 cookie/缓存。 */
export function createPartition(random: (size: number) => Buffer = randomBytes): string {
  return random(16).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const STATUS_WORDS: readonly string[] = Object.values(HOST_LOGIN_STATUS);

/** 解析宿主结论：结构化错误原样透出，`ok` 但形状不认识一律 `invalid_host_conclusion`，缺文案回落到本模块常量。 */
export function parseHostConclusion(reply: unknown): CoreResult<HostConclusion> {
  if (!isRecord(reply)) {
    return err("宿主没有返回可识别的答复", INVALID_HOST_CONCLUSION_KIND);
  }
  if (reply.ok !== true) {
    const failure = isRecord(reply.error) ? reply.error : {};
    const message =
      typeof failure.message === "string" && failure.message !== ""
        ? failure.message
        : "登录宿主调用失败（详情见日志）";
    return typeof failure.kind === "string" ? err(message, failure.kind) : err(message);
  }

  const data = reply.data;
  if (!isRecord(data)) {
    return err("宿主没有给出登录结论（data 不是对象）", INVALID_HOST_CONCLUSION_KIND);
  }
  const status = data.status;
  if (typeof status !== "string" || !STATUS_WORDS.includes(status)) {
    return err(
      `宿主给出的登录结论不认识：${String(status).slice(0, 32)}（词表见 HOST_LOGIN_STATUS）`,
      INVALID_HOST_CONCLUSION_KIND,
    );
  }

  if (status === HOST_LOGIN_STATUS.callback) {
    const url = data.url;
    if (typeof url !== "string" || url === "") {
      return err("宿主报了 callback 却没有带回调 URL", INVALID_HOST_CONCLUSION_KIND);
    }
    return ok({ status: HOST_LOGIN_STATUS.callback, url });
  }

  const message = typeof data.message === "string" && data.message !== "" ? data.message : undefined;
  if (status === HOST_LOGIN_STATUS.timedOut) {
    return ok({ status: HOST_LOGIN_STATUS.timedOut, message: message ?? LOGIN_TIMEOUT_MESSAGE });
  }
  if (status === HOST_LOGIN_STATUS.loadFailed) {
    return ok({ status: HOST_LOGIN_STATUS.loadFailed, message: message ?? LOGIN_PAGE_UNAVAILABLE_MESSAGE });
  }
  return ok({ status: status as HostLoginStatus });
}

const defaultLog = (message: string) => console.error("[hwmusic-core]", message);

/**
 * 造登录宿主端口。
 *
 * @param options.hostServices 宿主要求封装（`openLogin` / `cancelLogin`）
 * @param options.partition 分区工厂（测试替换随机源用）
 * @param options.openTimeoutMs 开窗调用超时（默认覆盖整段登录等待）
 */
export function createLoginHost({
  hostServices,
  partition = createPartition,
  openTimeoutMs = LOGIN_HOST_TIMEOUT_MS,
  log = defaultLog,
}: {
  hostServices: LoginHostServices;
  partition?: () => string;
  openTimeoutMs?: number;
  log?: (message: string) => void;
}): LoginHost {
  if (!isRecord(hostServices) || typeof hostServices.openLogin !== "function") {
    throw new TypeError("createLoginHost 需要 hostServices.openLogin（见 src/host/host-services.mjs）");
  }
  if (typeof hostServices.cancelLogin !== "function") {
    throw new TypeError("createLoginHost 需要 hostServices.cancelLogin（取消是宿主要求，不是本地假装关窗）");
  }

  return {
    async openLoginPage(params: OpenLoginParams) {
      // `topInset` 从载荷里退休——官方登录页铺满整个主窗，返回扫码与主题控件改成浮在网页之上的小 webview，不再从客户区挖掉一条 header。
      const payload = {
        url: params.url,
        partition: params.partition ?? partition(),
      };
      const reply = await hostServices.openLogin(payload, { timeoutMs: openTimeoutMs });
      const conclusion = parseHostConclusion(reply);
      if (!conclusion.ok) {
        // 抛出（而不是返回错误对象）：`runLoginFlow` 把开窗失败结算成 failed，
        // 渲染层拿到的 message 就是宿主那一句人话。
        throw hostError(conclusion.error.kind ?? CORE_ERROR_KINDS.internal, conclusion.error.message);
      }
      return conclusion.data;
    },

    async cancelLogin() {
      const reply = await hostServices.cancelLogin({}, { timeoutMs: LOGIN_CANCEL_TIMEOUT_MS });
      if (!isRecord(reply) || reply.ok !== true) {
        const failure = isRecord(reply) && isRecord(reply.error) ? reply.error : {};
        return err(
          typeof failure.message === "string" ? failure.message : "取消登录失败（详情见日志）",
          typeof failure.kind === "string" ? failure.kind : CORE_ERROR_KINDS.internal,
        );
      }
      return ok({ cancelled: isRecord(reply.data) && reply.data.cancelled === true });
    },

    /** 关窗兜底（`runLoginFlow` 的清理钩子）：防止 Node 先结算而窗还开着；失败只记日志，不改写登录结论。 */
    cleanup() {
      Promise.resolve()
        .then(() => hostServices.cancelLogin({}, { timeoutMs: LOGIN_CANCEL_TIMEOUT_MS }))
        .catch((cause: unknown) => log(`登录窗关窗兜底失败：${messageOf(cause)}`));
    },
  };
}
