/**
 * 渲染层的媒体地址闸门（R9）：**渲染层唯一允许 import 协议层的地方**。
 *
 * 为什么破这条边界：白名单必须与 CSP `media-src` 同源，而那份清单的唯一真源是
 * `src/protocols/safe-media-url.mjs`（由 `test/safe-media-url.test.mjs` 解析
 * `tauri.conf.json` 的 CSP 行钉死）。抄一份到渲染层 = 第二份清单，早晚与 CSP 漂移，
 * 而漂移的表现是"某些歌突然放不出来"。
 *
 * 为什么这个文件是安全的例外：`safe-media-url.mjs` 是**纯函数**（无 HTTP、无凭据、
 * 无状态），渲染层用了它拿不到任何业务能力——红线"业务 HTTP 只在 sidecar、渲染层拿不到
 * Token"依旧成立。业务请求（库页面、播放地址）仍然只走 `host-api` 的 `coreCall`。
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
