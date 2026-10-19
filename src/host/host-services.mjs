/**
 * 宿主要求（core → 宿主）的业务封装。
 *
 * 频道名一律 import 共享常量；payload 形状：
 * - `host:notify`：`{text}`（R3 已在 Rust 侧接通系统通知）；
 * - `host:secure-encrypt`：入 `{plaintext}` → 出 `{cipher}`（base64 的 DPAPI 信封，R5）；
 * - `host:secure-decrypt`：入 `{cipher}` → 出 `{plaintext}`（R5）；
 * - `host:open-login`（R7）：入 `{url, partition, topInset}` → 出登录结论（长轮询：窗收场后才答复）；
 * - `host:cancel-login`（R7）：入 `{}` → 出 `{cancelled}`。
 *
 * 返回值是帧内结果（`{ok:true,data}` / `{ok:false,error}`），这里原样透传：不改写成成功、不吞错。
 * 消费方见 `src/main/session-store.mjs`（只认 `data.cipher` / `data.plaintext`）与
 * `src/main/huawei.ts`（登录窗：`options.timeoutMs` 要覆盖整段等待，默认 60 秒不够）。
 */
import {
  HOST_CANCEL_LOGIN,
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
    /** 打开官方登录子窗；payload 由 R7 定形，答复发生在登录窗收场之后。 */
    openLogin: (payload = {}, options) => callHost(HOST_OPEN_LOGIN, payload, options),
    /** 取消进行中的登录（R7）：把宿主的登录窗拆掉并让等待方结算。 */
    cancelLogin: (payload = {}, options) => callHost(HOST_CANCEL_LOGIN, payload, options),
    /** DPAPI 加密；payload 由 R5 定形。 */
    secureEncrypt: (payload = {}) => callHost(HOST_SECURE_ENCRYPT, payload),
    /** DPAPI 解密；payload 由 R5 定形。 */
    secureDecrypt: (payload = {}) => callHost(HOST_SECURE_DECRYPT, payload),
  };
}
