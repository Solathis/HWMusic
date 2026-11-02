/**
 * 代理测试频道的处理器：把 `testProxyConnection` 接到界面的「测试连接」按钮上。
 * 测试目标按作用范围取两个固定常量之一、不接受调用方指定；凭据只往测试器一个方向流，日志与错误文案里不回显。
 */
import { proxyModeAndScope } from "../shared/proxy-mode.mjs";
import { SETTINGS_TEST_PROXY } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 「全部请求」的测试目标：官方授权主机的根路径（业务端点尚未确认，所以不猜任何一个业务地址）。 */
export const PROXY_TEST_URL = "https://oauth-login1.cloud.huawei.com/";

/** 「仅检查更新」的测试目标：更新器读的同一份清单（tauri.conf.json 的 updater 端点）。 */
export const UPDATE_PROXY_TEST_URL = "https://github.com/Solathis/HWMusic/releases/latest/download/latest.json";

/** 普通对象判定（数组/空值都不是载荷）。 */
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `settings:test-proxy` 的处理器表。
 * @param {object} options
 * @param {Function} options.testProxy 测试器（`src/main/proxy.mjs` 的 `testProxyConnection`），刻意不提供默认值
 * @param {object} [options.env] 交给测试器读系统代理的环境变量（sidecar 传 process.env）
 * @returns {Record<string, Function>} 键就是共享常量里的频道名
 */
export function createProxyHandlers({ testProxy, env = {} } = {}) {
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

      // 凭据原样进测试器（测的就是用户刚填的那组），目标 URL 由本模块按作用范围决定
      const url = proxyModeAndScope(payload.proxy).scope === "update" ? UPDATE_PROXY_TEST_URL : PROXY_TEST_URL;
      const result = await testProxy({ proxy: payload.proxy, url, env });
      return ok({ result });
    },
  };
}
