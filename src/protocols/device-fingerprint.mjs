/**
 * 设备指纹编码器（R31）：把"页面用浏览器指纹换 deviceID"那一步的**编码格式**抄准。
 *
 * ## 为什么需要它（真源是探针，不是推测）
 *
 * R29 只知道"页面在 `isUsedDeviceFingerSite` 为真时会带 `deviceID`/`deviceType`"，不知道
 * `deviceID` 从哪来。R31 的探针（`scripts/probe-qr-fidelity.mjs`，headless Chromium 真开官方
 * 二维码页）把它抓下来了：页面先发
 *
 * ```
 * POST /CAS/IDM_W/ajaxHandler/dev?reflushCode=…&cVersion=…
 * 正文：pageToken=…&pageTokenKey=…&reqClientType=…&loginChannel=…&clientID=…&lang=…&languageCode=…&state=…&fp=<这一段>
 * 响应：{"isSuccess":1,"sid":"204937…（84 位 hex）"}
 * ```
 *
 * 然后把这个 `sid` 写进 `localStorage.hwid_cas_sid` 与同名 cookie，建单时作为
 * `deviceID=<sid>&deviceType=7` 发给 `/DimensionalCode/getqrInfo`。所以 **deviceID = 服务端下发的 sid**，
 * 不是页面本地算出来的哈希。
 *
 * `fp` 的编码在页面 bundle 里是三步（本模块逐字节复刻，`test/device-fingerprint.test.mjs`
 * 用探针抓到的那份真值钉住"解回来再编回去完全相同"）：
 *
 * 1. `k=v` 逐个 percent-encode，**丢掉空值**，再按字段名排序拼成 `a=1&b=2`；
 * 2. 尾部挂 `&cs=<sha1(上面那半截)>`（40 位 hex。探针实测：`cs` 写错、不写、或写成别的东西，
 *    服务端一律回 `{"isSuccess":1,"sid":""}`——**空 sid 就是拒绝**）；
 * 3. 从种子 211 起做**滚动 XOR**（`b = 255 & (ch ^ (prev - 1))`，`prev = b`），再整体 base64。
 *
 * ## 我们发出去的那份指纹：哪些是真值，哪些是同形状的固定值（如实写在下面）
 *
 * - **真值**：`ett`（采集时刻）、`etz`（时区偏移）、`nlg`（语言）、屏幕/视口尺寸（调用方注入）、
 *   浏览器名/平台（调用方注入）。
 * - **同形状的固定值**：`canvas`/`webgl`/`fonts`/`ep`——页面在真浏览器里画一遍 canvas、跑一段
 *   WebGL、量一遍字体表算出来的哈希。sidecar 是 Node 进程，**没有浏览器引擎**，算不出这些；
 *   探针实测服务端**按形状收**（把 canvas 换成一个别的 40 位 hex 照样发 sid），所以这里给
 *   sha1 出来的固定值，并且**同一台设备每次报同一份**（设备标识要稳定才谈得上"同一台设备"）。
 *   这不假装成某台真机：除了上面那些真值，我们没有任何浏览器侧的熵可报。
 * - `ips`/`devs`：页面那份里是**空数组**（不是空串）——数组是"真值"，所以编码时**照样进**
 *   （`devs=&ips=`），这一点是从探针抓到的那份真值上读出来的（`test/fixtures/r31-page-fingerprint.json`），
 *   这里跟着用 `[]`，否则我们会比页面少两个字段。
 */
import { createHash } from "node:crypto";

/**
 * 页面那份指纹的字段表（探针实测的 19 个，一个不多一个不少）。
 *
 * 顺序就是页面对象里的声明顺序；编码时按字段名排序，所以这里保留原顺序只为"读起来像页面"，
 * 以及给测试一个可比对的完整清单。
 */
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

/**
 * 指纹字段 → `k=v&…`（页面 `s()` 的逐字复刻）。
 *
 * 两条细节都是页面定的，不能改：**空值不进**（`""`/`0`/`null` 全丢），**按字段名排序**
 * （所以字段顺序变了不影响结果）。
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
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
 *
 * @param {Record<string, unknown>} fields
 * @returns {string} base64 文本
 */
export function encodeFingerprint(fields) {
  const body = serializeFingerprint(fields);
  return xorThenBase64(`${body}&cs=${fingerprintChecksum(body)}`);
}

/**
 * 编码的逆运算（诊断与测试用；探针也用它把页面那份 fp 读出来）。
 *
 * `ok: false` 的三种情形：不是字符串/空串、base64 解不出东西、解出来**没有 `&cs=`**
 * （服务端对这种一律回空 sid，所以"认不出"就是认不出，不猜半份）。
 *
 * @param {unknown} value 线上那一串
 * @returns {{ok: true, body: string, checksum: string, fields: Record<string, string>} |
 *           {ok: false, reason: string}}
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
 * 我们能诚实给出的那份指纹（字段表与页面**完全一致**，值见文件头的分工说明）。
 *
 * @param {{
 *   now?: number, lang?: string, width?: number, height?: number,
 *   browserName?: string, browserAppName?: string, platform?: string,
 *   timezoneOffsetMinutes?: number,
 * }} [overrides]
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
