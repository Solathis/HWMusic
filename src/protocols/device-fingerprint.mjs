/**
 * 设备指纹编码器：把页面用浏览器指纹换 deviceID 那一步的编码格式抄准。`deviceID` 是服务端下发的 sid，不是本地哈希。
 * `fp` 的编码是三步：1. `k=v` 逐个 percent-encode、丢掉空值、按字段名排序拼成 `a=1&b=2`；
 * 2. 尾部挂 `&cs=<sha1(上面那半截)>`（40 位 hex，cs 写错或不写服务端一律回空 sid，空 sid 就是拒绝）；
 * 3. 从种子 211 起做滚动 XOR（`b = 255 & (ch ^ (prev - 1))`），再整体 base64。
 */
import { createHash } from "node:crypto";

/** 页面那份指纹的字段表（探针实测的 19 个，一个不多一个不少）；顺序只为读起来像页面，编码时按字段名排序。 */
export const DEVICE_FINGERPRINT_FIELDS = [
  "bsh",
  "bsw",
  "canvas",
  "devs",
  "ep",
  "ett",
  "etz",
  "fonts",
  "ips",
  "nacn",
  "nan",
  "nce",
  "nlg",
  "npf",
  "sah",
  "saw",
  "sh",
  "sw",
  "webgl",
];

/** 滚动 XOR 的种子（页面 bundle 里写死的 211）。 */
const XOR_SEED = 211;

/** 我们算不出来的那几个哈希（见文件头："同形状的固定值"）。 */
const FIXED_HASHES = {
  canvas: createHash("sha1").update("hwmusic-desktop/canvas（无浏览器引擎，同形状固定值）", "utf8").digest("hex"),
  webgl: createHash("sha1").update("hwmusic-desktop/webgl（无浏览器引擎，同形状固定值）", "utf8").digest("hex"),
  fonts: createHash("sha1").update("hwmusic-desktop/fonts（无浏览器引擎，同形状固定值）", "utf8").digest("hex"),
  /** 插件表：page 那份里是 sha1("")（一个插件都没有也是事实） */
  ep: createHash("sha1").update("", "utf8").digest("hex"),
};

/** 屏幕/视口的合约默认值（sidecar 那层拿不到真窗口尺寸时用它；真值可由调用方注入）。 */
export const DEVICE_FINGERPRINT_DEFAULT_SCREEN = { width: 1920, height: 1080 };

/** `cs` 的算法：**sha1**（40 位 hex）。名字写出来是为了让"服务端认哪个值"这件事只有一个真源。 */
export function fingerprintChecksum(body) {
  return createHash("sha1").update(String(body ?? ""), "utf8").digest("hex");
}

/** 指纹字段 → `k=v&…`（页面 `s()` 的逐字复刻）：空值不进、按字段名排序。 @param {Record<string, unknown>} fields @returns {string} */
export function serializeFingerprint(fields) {
  const parts = [];
  for (const name of Object.keys(fields ?? {})) {
    const value = fields[name];
    if (!value) continue;
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.sort().join("&");
}

/** 滚动 XOR + base64（页面 `l()` 的后半步）。 */
function xorThenBase64(text) {
  let previous = XOR_SEED;
  let scrambled = "";
  for (let index = 0; index < text.length; index += 1) {
    const byte = 255 & (text.charCodeAt(index) ^ (previous - 1));
    scrambled += String.fromCharCode(byte);
    previous = byte;
  }
  return Buffer.from(scrambled, "binary").toString("base64");
}

/** base64 + 滚动 XOR 的逆（只给 `decodeFingerprint` 用；对称性由测试钉住）。 */
function base64ThenUnxor(value) {
  const scrambled = Buffer.from(String(value), "base64").toString("binary");
  let previous = XOR_SEED;
  let text = "";
  for (let index = 0; index < scrambled.length; index += 1) {
    const byte = scrambled.charCodeAt(index) & 255;
    text += String.fromCharCode(255 & (byte ^ (previous - 1)));
    previous = byte;
  }
  return text;
}

/**
 * 指纹字段 → 服务端收的那一串（页面 `l(s(n))` 的逐字复刻）。
 * @param {Record<string, unknown>} fields
 * @returns {string} base64 文本
 */
export function encodeFingerprint(fields) {
  const body = serializeFingerprint(fields);
  return xorThenBase64(`${body}&cs=${fingerprintChecksum(body)}`);
}

/**
 * 编码的逆运算（诊断与测试用）：非字符串、base64 解不出、缺 `&cs=` 一律算认不出，不猜半份。
 * @param {unknown} value 线上那一串
 * @returns {{ok: true, body: string, checksum: string, fields: Record<string, string>} | {ok: false, reason: string}}
 */
export function decodeFingerprint(value) {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, reason: "empty" };
  let text;
  try {
    text = base64ThenUnxor(value);
  } catch {
    return { ok: false, reason: "not_base64" };
  }
  const at = text.lastIndexOf("&cs=");
  if (at <= 0) return { ok: false, reason: "no_checksum" };
  const body = text.slice(0, at);
  const checksum = text.slice(at + 4);
  const fields = {};
  for (const pair of body.split("&")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    try {
      fields[decodeURIComponent(pair.slice(0, index))] = decodeURIComponent(pair.slice(index + 1));
    } catch {
      fields[pair.slice(0, index)] = pair.slice(index + 1);
    }
  }
  return { ok: true, body, checksum, fields };
}

/**
 * 我们能诚实给出的那份指纹（字段表与页面完全一致，值见文件头的分工说明）。
 * @param {{ now?: number, lang?: string, width?: number, height?: number, browserName?: string, browserAppName?: string, platform?: string, timezoneOffsetMinutes?: number, }} [overrides]
 * @returns {Record<string, string>}
 */
export function deviceFingerprintFields(overrides = {}) {
  const now = overrides.now ?? Date.now();
  const width = overrides.width ?? DEVICE_FINGERPRINT_DEFAULT_SCREEN.width;
  const height = overrides.height ?? DEVICE_FINGERPRINT_DEFAULT_SCREEN.height;
  return {
    bsh: String(height),
    bsw: String(width),
    canvas: FIXED_HASHES.canvas,
    /** 空数组（不是空串）：页面那份就是这么发的，空值会被丢掉、空数组不会 */
    devs: [],
    ep: FIXED_HASHES.ep,
    ett: String(now),
    /** 页面的 etz 是 `-getTimezoneOffset()`（东八区 = -480） */
    etz: String(overrides.timezoneOffsetMinutes ?? -new Date(now).getTimezoneOffset()),
    fonts: FIXED_HASHES.fonts,
    /** 同 `devs`：空数组照样进编码 */
    ips: [],
    nacn: overrides.browserName ?? "Mozilla",
    nan: overrides.browserAppName ?? "Netscape",
    nce: "true",
    nlg: overrides.lang ?? "zh-cn",
    npf: overrides.platform ?? "Win32",
    sah: String(height),
    saw: String(width),
    sh: String(height),
    sw: String(width),
    webgl: FIXED_HASHES.webgl,
  };
}
