/**
 * 代理测试频道的处理器：把 `testProxyConnection` 接到界面的「测试连接」按钮上。
 * 测试目标 URL 是固定常量、不接受调用方指定；凭据只往测试器一个方向流，日志与错误文案里不回显。
 */
import { SETTINGS_TEST_PROXY } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 测试连接的目标：官方授权主机的根路径（业务端点尚未确认，所以不猜任何一个业务地址）。 */
export const PROXY_TEST_URL = "https://oauth-login1.cloud.huawei.com/";

/** 普通对象判定（数组/空值都不是载荷）。 */
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `settings:test-proxy` 的处理器表。
 * @param {object} options
 * @param {Function} options.testProxy 测试器（`src/main/proxy.mjs` 的 `testProxyConnection`），刻意不提供默认值
 * @returns {Record<string, Function>} 键就是共享常量里的频道名
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
