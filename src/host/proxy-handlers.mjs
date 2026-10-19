/**
 * 代理测试频道的处理器（R10）：把 R6 的 `testProxyConnection` 接到界面的"测试连接"按钮上。
 *
 * 两个刻意的边界：
 *
 * 1. **测试目标 URL 是固定常量**，且不接受调用方指定。让渲染层传 URL = 把一个开放代理
 *    （能带凭据出去的代理）塞进渲染层手里；而这个功能的语义只是"我填的这组代理能不能通"，
 *    所以目标就用 R4 已确认可达的官方授权主机根路径——**不猜业务端点**（业务端点全部待联调确认）。
 * 2. **凭据只往一个方向流**：载荷里的用户名/密码必须**原样**送到测试器（不然测的是另一个代理），
 *    但处理器自己的日志与错误文案里**一个字都不许回显**——包括坏载荷那条路
 *    （`{proxy:null, password:"..."}` 这种载荷就是来抓回显的）。
 */
import { SETTINGS_TEST_PROXY } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/**
 * 测试连接的目标：官方授权主机的根路径。
 *
 * `https://oauth-login1.cloud.huawei.com/` 是 R4 已实测可达的官方主机；业务端点尚未确认，
 * 所以这里**不猜**任何一个业务地址（猜错的后果是"测试连接失败"被误读成"代理配错了"）。
 */
export const PROXY_TEST_URL = "https://oauth-login1.cloud.huawei.com/";

/** 普通对象判定（数组/空值都不是载荷）。 */
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `settings:test-proxy` 的处理器表。
 *
 * @param {object} options
 * @param {Function} options.testProxy 测试器（`src/main/proxy.mjs` 的 `testProxyConnection`）。
 *   刻意**不提供默认值**：没有测试器就装成"能用"，比直接报错糟糕得多（界面会显示"连通"或卡住）。
 * @returns {Record<string, Function>} 键就是共享常量里的频道名（入口不再抄一遍频道名）。
 */
export function createProxyHandlers({ testProxy } = {}) {
  if (typeof testProxy !== "function") {
    throw new TypeError("createProxyHandlers 需要 testProxy（src/main/proxy.mjs 的 testProxyConnection）");
  }

  return {
    [SETTINGS_TEST_PROXY]: async (request) => {
      const payload = request?.payload;
      if (!isPlainObject(payload) || !isPlainObject(payload.proxy)) {
        // 不回显载荷内容：坏载荷里同样可能有凭据（`{proxy:null, password:"…"}`）
        return err("settings:test-proxy 需要 {proxy:{...}} 载荷", CORE_ERROR_KINDS.invalidPayload);
      }

      // 凭据原样进测试器（测的就是用户刚填的那组），目标 URL 由本模块决定
      const result = await testProxy({ proxy: payload.proxy, url: PROXY_TEST_URL });
      return ok({ result });
    },
  };
}
