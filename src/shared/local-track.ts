/**
 * 本地曲目标识的形状：渲染层、sidecar 与文档共用这一份。
 * id 是 128 位随机数的十六进制（32 位小写），与文件路径无关；渲染层的 `local:` 前缀只是分流标记，不是安全边界。
 */

/** 渲染层的本地曲目 id 前缀。 */
export const LOCAL_TRACK_PREFIX = "local:";

/** id 的十六进制长度（128 位 = 16 字节）。 */
export const LOCAL_TRACK_HEX_LENGTH = 32;

/** 自定义 URI 协议的 scheme（Rust 侧 `local_library::PROTOCOL_SCHEME` 是它的镜像副本）。 */
export const LOCAL_MEDIA_SCHEME = "hwlocal";

/** 能导入的格式：WebView2/Chromium 能原生播放的那一档；不在表里的在导入时就拒绝并说明原因。 */
export const LOCAL_AUDIO_FORMATS = Object.freeze(["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"]);

const HEX_ID = new RegExp(`^[0-9a-f]{${LOCAL_TRACK_HEX_LENGTH}}$`);

/** 裸 id（32 位小写十六进制）是不是合法形状。 */
export function isLocalHexId(value: unknown) {
  return typeof value === "string" && HEX_ID.test(value);
}

/** 裸 id → 渲染层 id（形状不对回 `null`，绝不拼一个假 id）。 */
export function localTrackId(hexId: unknown) {
  return isLocalHexId(hexId) ? `${LOCAL_TRACK_PREFIX}${hexId}` : null;
}

/** 渲染层 id → 裸 id（不是本地曲目就回 `null`）。 */
export function localHexId(trackId: unknown) {
  if (typeof trackId !== "string" || !trackId.startsWith(LOCAL_TRACK_PREFIX)) return null;
  const hex = trackId.slice(LOCAL_TRACK_PREFIX.length);
  return isLocalHexId(hex) ? hex : null;
}

/** 是不是本地曲目 id（形状不对的一律不算：`local:../../etc/passwd` 不是本地曲目）。 */
export function isLocalTrackId(value: unknown) {
  return localHexId(value) !== null;
}
