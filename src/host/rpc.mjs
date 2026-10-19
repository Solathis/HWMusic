/**
 * RPC 契约层：把桥的入帧交给 dispatcher，并给出 core → 宿主 的出向调用面。
 *
 * 桥只管帧与 pending；这里管"谁能被调用"：入向按请求白名单路由，
 * 出向只放行宿主要求频道（host:*），非白名单当场回结构化错误、不写帧。
 */
import { HOST_REQUEST_CHANNELS, REQUEST_CHANNELS, isHostRequestChannel } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err } from "../shared/result.ts";

export function createRpc({ bridge, dispatcher }) {
  if (bridge === undefined || typeof bridge.onRequest !== "function") {
    throw new TypeError("createRpc 需要一个桥（createBridge 的返回值）");
  }
  if (dispatcher === undefined || typeof dispatcher.dispatch !== "function") {
    throw new TypeError("createRpc 需要 dispatcher");
  }

  bridge.onRequest((request, respond) => dispatcher.dispatch(request, respond));

  return {
    /** 入向白名单（渲染层可调的请求频道）。 */
    channels: () => [...REQUEST_CHANNELS],
    /** 出向白名单（core 可向宿主发起的宿主要求频道）。 */
    hostChannels: () => [...HOST_REQUEST_CHANNELS],
    /** 向宿主发起宿主要求；返回 CoreResult（超时/收尸/未实现都是 err，不抛）。 */
    callHost(channel, payload = null, options) {
      if (!isHostRequestChannel(channel)) {
        return Promise.resolve(err(`未知宿主要求频道：${channel}`, CORE_ERROR_KINDS.unknownChannel));
      }
      return bridge.call(channel, payload, options);
    },
    /** 收尸：结清在途调用、此后入帧不再处理、出向调用立刻失败。 */
    shutdown(reason = "sidecar 收尸") {
      return bridge.close(reason);
    },
  };
}
