/**
 * 帧内结果的唯一构造入口（Node 侧）。
 *
 * 帧载荷不受信任：错误只带 message（+ 可选 kind），不回显堆栈、凭据或整段 payload。
 * Rust 侧对应的类型是 src-tauri/src/bridge.rs 的 `CoreError`（同形）。
 */

/** 已知错误类别（两侧共用；Rust 侧为同名字符串字面量）。 */
export const CORE_ERROR_KINDS = {
  /** 通道已留、实现留待后续任务（R5/R6/R7） */
  unimplemented: "unimplemented",
  /** 频道不在白名单内 */
  unknownChannel: "unknown_channel",
  /** 请求载荷不合法（宿主侧校验） */
  invalidPayload: "invalid_payload",
  /** 处理器内部异常（详情只进日志） */
  internal: "internal",
  /** 调用超时 */
  timeout: "timeout",
  /** core（sidecar 进程）已退出 */
  coreGone: "core_gone",
  /** 没有可用的 core（起不来或已收尸） */
  coreUnavailable: "core_unavailable",
  /** 调用来源不是主窗（Rust 侧守卫） */
  forbiddenSource: "forbidden_source",
  /** 帧本身不合法 */
  invalidFrame: "invalid_frame",
  /** 安全存储后端不可用（非 Windows / DPAPI 拒绝加密）：会话只留内存，绝不写明文（R5） */
  secureStoreUnavailable: "secure_store_unavailable",
  /** 密文不合法：不是本机本用户的 DPAPI 信封、或被破坏（R5） */
  invalidCipher: "invalid_cipher",
  /** 落盘信封不合法：不是合法 JSON / schemaVersion 不认识 / 缺 cipher 字段（R5） */
  invalidEnvelope: "invalid_envelope",
} as const;

export interface CoreError {
  message: string;
  kind?: string;
}

export interface CoreOk<T = unknown> {
  ok: true;
  data: T;
}

export interface CoreFail {
  ok: false;
  error: CoreError;
}

export type CoreResult<T = unknown> = CoreOk<T> | CoreFail;

export function ok<T = null>(data: T = null as T): CoreOk<T> {
  return { ok: true, data };
}

export function err(message: string, kind?: string): CoreFail {
  return kind === undefined ? { ok: false, error: { message } } : { ok: false, error: { message, kind } };
}

/**
 * 把任意抛出物归一成帧内错误：只保留一段可读文本，绝不带堆栈或原始对象。
 * 这是"错误不回显敏感内容"的落点。
 */
export function asCoreError(value: unknown, kind: string = CORE_ERROR_KINDS.internal): CoreError {
  if (typeof value === "string" && value.trim() !== "") return { message: value, kind };
  if (value instanceof Error && value.message.trim() !== "") return { message: value.message, kind };
  if (value !== null && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return { message, kind };
  }
  return { message: "未知错误（详情见日志）", kind };
}
