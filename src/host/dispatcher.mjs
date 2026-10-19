/**
 * 请求频道的白名单路由。
 *
 * 唯一准入集合来自 src/shared/request-channels.ts（Rust 侧 commands.rs 是镜像副本，
 * 由 test/channel-parity.test.mjs 钉住一致）。这里只做三件事：
 * 白名单外的频道回结构化错误、处理器异常回结构化错误（详情只进日志）、
 * 处理器自己答复时不再写第二次。
 */
import { REQUEST_CHANNELS, isRequestChannel } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 默认错误日志：一律走 stderr——stdout 是协议通道，写日志进去会污染分帧。 */
export const logHandlerError = ({ channel, error }) => {
  console.error(`[hwmusic-core] 请求频道 ${channel} 处理失败：`, error);
};

export function createDispatcher({ onHandlerError = logHandlerError } = {}) {
  const table = new Map();

  const register = (channel, handler) => {
    if (!isRequestChannel(channel)) {
      throw new TypeError(`非白名单请求频道：${channel}（唯一真源 src/shared/request-channels.ts）`);
    }
    if (typeof handler !== "function") {
      throw new TypeError(`请求频道 ${channel} 的处理器必须是函数`);
    }
    table.set(channel, handler);
  };

  const isResult = (value) => value !== null && typeof value === "object" && typeof value.ok === "boolean";

  /**
   * 一次请求 → 一次答复。
   * 处理器可以 return 结果（普通值收成 ok，`{ok,...}` 原样），也可以自己调用 respond 后 return undefined
   * （= 已有人负责答复，dispatch 不再写第二帧；R7 的长轮询登录就靠这个）。
   */
  async function dispatch(request, respond) {
    const channel = request.channel;
    if (!isRequestChannel(channel)) {
      respond(err(`未知请求频道：${channel}`, CORE_ERROR_KINDS.unknownChannel));
      return;
    }

    const handler = table.get(channel);
    if (handler === undefined) {
      respond(err(`请求频道 ${channel} 尚无处理器`, CORE_ERROR_KINDS.unimplemented));
      return;
    }

    try {
      const answer = await handler(request, respond);
      if (answer === undefined) return; // 处理器已自行答复（或稍后答复）
      respond(isResult(answer) ? answer : ok(answer));
    } catch (cause) {
      onHandlerError({ channel, request, error: cause });
      respond(err(`请求频道 ${channel} 处理失败（详情见日志）`, CORE_ERROR_KINDS.internal));
    }
  }

  return {
    /** 白名单成员判定（不等于「已挂处理器」）。 */
    has: (channel) => isRequestChannel(channel),
    channels: () => [...REQUEST_CHANNELS],
    handlers: () => [...table.keys()],
    register,
    dispatch,
  };
}
