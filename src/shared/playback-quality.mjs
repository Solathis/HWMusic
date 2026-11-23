/**
 * 播放音质的枚举真源（主进程的设置、渲染层的设置表单、协议层的档位映射都读这一份）。
 * 常量与已确认播放信息的白名单投影，不引 node：渲染层与 sidecar 两侧都要能直接 import。
 */

/** 三档音质（顺序即"由低到高"；官方 H5 的档位码见 `MUSIC_QUALITY_TYPES`）。 */
export const PLAYBACK_QUALITIES = ["standard", "high", "lossless"];

/** 默认档：高音质（大多数曲目都能给到；无损要会员，标准档等于白白降质）。 */
export const DEFAULT_PLAYBACK_QUALITY = "high";

/** 界面上的一行中文（设置页下拉与其它地方的说明共用）。 */
export const PLAYBACK_QUALITY_LABELS = { standard: "标准", high: "高", lossless: "无损" };

/** 认不认这一档（设置里的取值闸门；认不出就不写进文档）。 */
export function isPlaybackQuality(value) {
  return PLAYBACK_QUALITIES.includes(value);
}

function ownValue(raw, key) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function playbackAudioDetailsOf(raw) {
  const format = ownValue(raw, "format");
  const normalized = typeof format === "string" ? format.trim().toUpperCase() : null;
  if (normalized !== "MP3" && normalized !== "FLAC") return null;
  const positiveNumber = (key) => {
    const value = ownValue(raw, key);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    format: normalized,
    sampleRate: positiveNumber("sampleRate"),
    fileSize: positiveNumber("fileSize"),
    duration: positiveNumber("duration"),
  };
}

export function playbackSnapshotOf(raw, trackId) {
  if (typeof trackId !== "string" || trackId === "" || trackId.startsWith("local:")) return null;
  if (ownValue(raw, "trackId") !== trackId) return null;
  const quality = ownValue(raw, "quality");
  if (!isPlaybackQuality(quality)) return null;
  return { trackId, quality, audioDetails: playbackAudioDetailsOf(ownValue(raw, "audioDetails")) };
}
