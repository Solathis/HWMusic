/**
 * 宿主要求（core → 宿主）的业务封装；频道名一律 import 共享常量。
 * 频道覆盖通知、DPAPI 加解密、登录子窗、本地歌词字节。
 * 返回值是帧内结果（`{ok:true,data}` / `{ok:false,error}`），这里原样透传：不改写成成功、不吞错。
 */
import {
  HOST_CANCEL_LOGIN,
  HOST_LOCAL_LYRICS_SOURCE,
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
    /** 打开官方登录子窗；答复发生在登录窗收场之后。 */
    openLogin: (payload = {}, options) => callHost(HOST_OPEN_LOGIN, payload, options),
    /** 取消进行中的登录：把宿主的登录窗拆掉并让等待方结算。 */
    cancelLogin: (payload = {}, options) => callHost(HOST_CANCEL_LOGIN, payload, options),
    /** DPAPI 加密。 */
    secureEncrypt: (payload = {}) => callHost(HOST_SECURE_ENCRYPT, payload),
    /** DPAPI 解密。 */
    secureDecrypt: (payload = {}) => callHost(HOST_SECURE_DECRYPT, payload),
    /** 本地曲目的歌词原始字节：`{trackId}` → `{bytes, source, name?}`；不指定超时，返回的是帧，调用方自己判 `ok`。 */
    localLyricsSource: (payload = {}, options) => callHost(HOST_LOCAL_LYRICS_SOURCE, payload, options),
  };
}
