/**
 * 宿主要求（core → 宿主）的业务封装。
 *
 * 频道名一律 import 共享常量；payload 形状由消费任务定义（本任务不替 R5/R7 拍板）：
 * - `host:notify`：R3 已在 Rust 侧接通系统通知，`{text}`；
 * - `host:open-login`（R7）、`host:secure-encrypt/decrypt`（R5）：宿主如实回
 *   `{kind:"unimplemented"}`，这里原样透传，不改写成成功、不吞错。
 */
import {
  HOST_NOTIFY,
  HOST_OPEN_LOGIN,
  HOST_SECURE_DECRYPT,
  HOST_SECURE_ENCRYPT,
} from "../shared/request-channels.ts";

export function createHostServices({ callHost }) {
  if (typeof callHost !== "function") {
    throw new TypeError("createHostServices 需要 callHost（由 rpc 提供）");
  }
  return {
    /** 系统通知（走 tauri-plugin-notification，不进渲染层 UI）。 */
    notify: (text) => callHost(HOST_NOTIFY, { text }),
    /** 打开官方登录子窗；payload 由 R7 定形。 */
    openLogin: (payload = {}) => callHost(HOST_OPEN_LOGIN, payload),
    /** DPAPI 加密；payload 由 R5 定形。 */
    secureEncrypt: (payload = {}) => callHost(HOST_SECURE_ENCRYPT, payload),
    /** DPAPI 解密；payload 由 R5 定形。 */
    secureDecrypt: (payload = {}) => callHost(HOST_SECURE_DECRYPT, payload),
  };
}
