/**
 * R3 sidecar 桥 · 帧协议 + pending 表 + 传输接线。
 *
 * 线上只有两种帧（NDJSON：一行一帧、UTF-8、`\n` 结尾）：
 * - 请求：`{id, channel, payload}`
 * - 响应：`{id, ok, data}` 或 `{id, ok, error: {message, kind?}}`
 *
 * 本模块不认业务频道（那是 dispatcher/rpc 的事），只保证协议面的确定结论：
 * 分帧跨 read() 分片存活、半帧在 EOF 有归属、在途调用被结清、同一 id 只答复一次、
 * core 退出后调用立刻失败而不是再等超时。
 */
import { asCoreError, CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 调用超时：与 Rust 侧 `CALL_TIMEOUT_SECS` 必须相等（test/channel-parity.test.mjs 钉住）。 */
export const CALL_TIMEOUT_MS = 60_000;

/** 已答复 id 的保留上限：一次性守卫要有界，超出按插入顺序淘汰。 */
export const MAX_ANSWERED_IDS = 4096;

/** 一帧一行；payload 内的换行由 JSON 转义，不会破帧。 */
export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 分帧状态机。
 * - 完整行立即吐出（吞掉 CRLF 与空行）；
 * - 残余（半帧）留在内部等下一片；
 * - `end()` 交出残余：非空即截断帧，必须报出来而不是静默丢弃。
 */
export function createFrameDecoder({ onInvalidFrame = () => {} } = {}) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : String(chunk);
      const frames = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        try {
          frames.push(JSON.parse(line));
        } catch (cause) {
          onInvalidFrame({ reason: "invalid_json", line, cause });
        }
      }
      return frames;
    },
    end() {
      const rest = buffer.trim();
      buffer = "";
      if (rest !== "") onInvalidFrame({ reason: "truncated_frame", line: rest });
      return rest;
    },
    get remainder() {
      return buffer;
    },
  };
}

/**
 * pending 表：id → 结清函数。
 * - 同一 id 不能登记两次（id 冲突）；
 * - 同一 id 第二次结清被拒绝（返回 false），原值不被覆盖；
 * - 关闭后不再接受登记。
 */
export function createPendingTable() {
  const entries = new Map();
  let closed = false;
  let closeReason = null;

  return {
    add(id, settle) {
      if (closed) return false;
      if (entries.has(id)) return false;
      entries.set(id, settle);
      return true;
    },
    settle(id, result) {
      const settle = entries.get(id);
      if (settle === undefined) return false;
      entries.delete(id);
      settle(result);
      return true;
    },
    forget(id) {
      return entries.delete(id);
    },
    failAll(failure) {
      const waiting = [...entries.values()];
      entries.clear();
      for (const settle of waiting) settle(failure);
      return waiting.length;
    },
    close(reason) {
      closed = true;
      closeReason = reason ?? closeReason;
    },
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
    get size() {
      return entries.size;
    },
  };
}

/** 应答一次性守卫：同一请求 id 最多写出一帧响应（Deferred 语义的兜底）。 */
function createAnsweredGuard(limit = MAX_ANSWERED_IDS) {
  const seen = new Set();
  return {
    mark(id) {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        seen.delete(oldest);
      }
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * 一条双向桥。
 *
 * 入向：`readable`（sidecar stdout）→ 分帧 → 响应结清 pending / 请求交给 `onRequest`。
 * 出向：`call()` 写请求帧并登记 pending；`respond()` 写响应帧（同一 id 只写一次）。
 * 收尾：`readable` 的 end/error 或 `close()` → 结清全部在途调用、标记已收尸，之后调用立刻失败。
 */
export function createBridge({
  readable = null,
  writable,
  timeoutMs = CALL_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onProtocolError = () => {},
} = {}) {
  if (writable === undefined || writable === null || typeof writable.write !== "function") {
    throw new TypeError("createBridge 需要可写端（writable.write）");
  }

  const pending = createPendingTable();
  const answered = createAnsweredGuard();
  let requestHandler = null;
  let eofHandler = null;
  let seq = 0;

  const report = (problem) => {
    try {
      onProtocolError(problem);
    } catch {
      // 报告问题本身失败不能让协议停下来
    }
  };

  const write = (frame) => {
    try {
      writable.write(encodeFrame(frame));
      return true;
    } catch (cause) {
      report({ kind: "write_failed", cause });
      return false;
    }
  };

  const failureOf = (result) => {
    if (result !== null && typeof result === "object" && result.ok === false) {
      const error = result.error;
      if (error !== null && typeof error === "object" && typeof error.message === "string") return error;
      return asCoreError(error);
    }
    return asCoreError(result);
  };

  const resultOf = (frame) => {
    if (frame.ok) return ok(frame.data ?? null);
    const error = frame.error;
    if (error !== null && typeof error === "object" && typeof error.message === "string") {
      return typeof error.kind === "string"
        ? { ok: false, error: { message: error.message, kind: error.kind } }
        : { ok: false, error: { message: error.message } };
    }
    return err("对端返回了错误但没有可读的 message", CORE_ERROR_KINDS.invalidFrame);
  };

  const reportHandlerFailure = (channel, cause) => {
    report({ kind: "handler_failed", channel, cause });
  };

  function respond(id, result) {
    if (pending.closed) {
      report({ kind: "bridge_closed", id });
      return false;
    }
    if (typeof id !== "string" || id === "") return false; // 无 id 的帧是 fire-and-forget，无法答复
    if (!answered.mark(id)) {
      report({ kind: "duplicate_answer", id });
      return false;
    }
    const isOk = result !== null && typeof result === "object" && result.ok === true;
    return write(isOk ? { id, ok: true, data: result.data ?? null } : { id, ok: false, error: failureOf(result) });
  }

  function handleFrame(frame) {
    if (pending.closed) {
      report({ kind: "bridge_closed", frame });
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      report({ kind: "invalid_frame", reason: "not_object" });
      return;
    }
    if (typeof frame.ok === "boolean") {
      if (typeof frame.id !== "string" || frame.id === "") {
        report({ kind: "invalid_frame", reason: "response_without_id" });
        return;
      }
      if (!pending.settle(frame.id, resultOf(frame))) report({ kind: "unmatched_response", id: frame.id });
      return;
    }
    if (typeof frame.channel !== "string" || frame.channel === "") {
      report({ kind: "invalid_frame", reason: "missing_channel" });
      return;
    }

    const request = {
      id: typeof frame.id === "string" && frame.id !== "" ? frame.id : null,
      channel: frame.channel,
      payload: frame.payload ?? null,
    };
    if (requestHandler === null) {
      report({ kind: "missing_request_handler", id: request.id, channel: request.channel });
      respond(request.id, err(`桥尚未注册请求处理器（频道 ${request.channel}）`, CORE_ERROR_KINDS.internal));
      return;
    }
    try {
      const answer = requestHandler(request, (result) => respond(request.id, result));
      if (answer !== null && typeof answer === "object" && typeof answer.then === "function") {
        answer.then(undefined, (cause) => reportHandlerFailure(request.channel, cause));
      }
    } catch (cause) {
      reportHandlerFailure(request.channel, cause);
    }
  }

  function handleChunk(chunk) {
    for (const frame of decoder.push(chunk)) handleFrame(frame);
  }

  function handleEof(reason = "stdout EOF") {
    const failure = err(`core 进程已退出（${reason}）`, CORE_ERROR_KINDS.coreGone);
    const settled = pending.failAll(failure);
    pending.close(failure);
    if (eofHandler !== null) {
      try {
        eofHandler(failure);
      } catch (cause) {
        report({ kind: "eof_handler_failed", cause });
      }
    }
    return settled;
  }

  const decoder = createFrameDecoder({
    onInvalidFrame: (problem) => report({ kind: "invalid_frame", ...problem }),
  });

  function call(channel, payload = null, options = {}) {
    if (typeof channel !== "string" || channel === "") {
      return Promise.reject(new TypeError("call 需要非空 channel"));
    }
    if (pending.closed) {
      return Promise.resolve(err("core 进程已退出，调用未发送", CORE_ERROR_KINDS.coreGone));
    }

    const id = `c${++seq}`;
    const timeout = options.timeoutMs ?? timeoutMs;
    return new Promise((resolve) => {
      let timer = null;
      const finish = (result) => {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        resolve(result);
      };

      if (!pending.add(id, finish)) {
        finish(err(`请求 id 冲突：${id}`, CORE_ERROR_KINDS.internal));
        return;
      }
      timer = setTimer(() => {
        if (pending.forget(id)) finish(err(`调用 ${channel} 超时（${timeout} 毫秒）`, CORE_ERROR_KINDS.timeout));
      }, timeout);

      if (!write({ id, channel, payload })) {
        pending.forget(id);
        finish(err(`无法写出请求帧（频道 ${channel}）`, CORE_ERROR_KINDS.coreGone));
      }
    });
  }

  function attach(source = readable) {
    if (source === null || source === undefined) return api;
    if (typeof source.setEncoding === "function") source.setEncoding("utf8");
    source.on("data", (chunk) => handleChunk(chunk));
    source.on("end", () => handleEof("stdout end"));
    source.on("error", (cause) => handleEof(`stdout 读失败：${cause?.code ?? cause?.message ?? cause}`));
    return api;
  }

  const api = {
    call,
    respond,
    handleFrame,
    handleChunk,
    handleEof,
    close: (reason = "桥关闭") => handleEof(reason),
    attach,
    onRequest(handler) {
      requestHandler = handler;
      return api;
    },
    onEof(handler) {
      eofHandler = handler;
      return api;
    },
    get closed() {
      return pending.closed;
    },
    get pendingSize() {
      return pending.size;
    },
  };

  if (readable !== null && readable !== undefined) attach(readable);
  return api;
}
