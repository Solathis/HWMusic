/**
 * 渲染层的媒体地址闸门：渲染层唯一允许 import 协议层的地方。
 * 为什么破例：白名单必须与 CSP media-src 同源，唯一真源是 src/protocols/safe-media-url.mjs（由测试解析 CSP 行钉死）。
 * 抄一份到渲染层就是第二份清单，早晚与 CSP 漂移（表现是「某些歌突然放不出来」）。
 * 为什么安全：safe-media-url.mjs 是纯函数（无 HTTP、无凭据、无状态）；业务请求仍只走 host-api 的 coreCall。
 */
import { MEDIA_URL_REASONS, isSafeMediaUrl, parseSafeMediaUrl, safeMediaUrl } from "../../../protocols/safe-media-url.mjs";

export { MEDIA_URL_REASONS, isSafeMediaUrl, parseSafeMediaUrl, safeMediaUrl };

/**
 * 地址闸门：放行时返回**归一化后**的地址，不合格返回 `null`。
 *
 * 状态机把它当构造参数（缺了就抛），所以"忘了校验"不是一种可能的写法。
 */
export function guardMediaUrl(value) {
  return safeMediaUrl(value);
}
