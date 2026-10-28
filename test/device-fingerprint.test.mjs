/**
 * 设备指纹编码器（src/protocols/device-fingerprint.mjs）的离线测试。
 * deviceID 是页面拿浏览器指纹去 POST /CAS/IDM_W/ajaxHandler/dev 换回的 sid，编码器必须逐字节复刻页面逻辑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVICE_FINGERPRINT_FIELDS,
  decodeFingerprint,
  deviceFingerprintFields,
  encodeFingerprint,
  fingerprintChecksum,
  serializeFingerprint,
} from "../src/protocols/device-fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_FIXTURE = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "test", "fixtures", "r31-page-fingerprint.json"), "utf8"),
);

const sha1 = (text) => createHash("sha1").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// 1. 序列化：非空值、按名排序、percent-encode
// ---------------------------------------------------------------------------

test("指纹序列化：只带非空值，按字段名排序（页面就是这么排的）", () => {
  assert.equal(serializeFingerprint({ b: "2", a: "1", empty: "", zero: 0, nil: null }), "a=1&b=2");
  assert.equal(serializeFingerprint({ nlg: "zh-CN", npf: "Win32" }), "nlg=zh-CN&npf=Win32");
  assert.equal(serializeFingerprint({}), "");
});

test("指纹序列化：值走 percent-encode（页面用 encodeURIComponent，两边必须一样）", () => {
  assert.equal(serializeFingerprint({ ips: "127.0.0.1 10.0.0.1" }), "ips=127.0.0.1%2010.0.0.1");
  assert.equal(serializeFingerprint({ devs: "a&b=c" }), "devs=a%26b%3Dc");
});

// ---------------------------------------------------------------------------
// 2. 编码器：`&cs=` + 滚动 XOR + base64，且必须是可逆的
// ---------------------------------------------------------------------------

test("指纹编码：尾部挂 `&cs=`，它就是 sha1(去掉 cs 的那半截)", () => {
  const encoded = encodeFingerprint({ nlg: "zh-CN", npf: "Win32" });
  const decoded = decodeFingerprint(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.body, "nlg=zh-CN&npf=Win32");
  assert.equal(decoded.checksum, fingerprintChecksum("nlg=zh-CN&npf=Win32"));
  assert.equal(decoded.checksum, sha1("nlg=zh-CN&npf=Win32"));
});

test("指纹编码：编码 → 解码 → 再编码，逐字节回到原样（滚动 XOR 与 base64 都对称）", () => {
  const fields = { canvas: sha1("canvas-x"), sw: "1920", sh: "1080", nce: "true" };
  const encoded = encodeFingerprint(fields);
  const decoded = decodeFingerprint(encoded);
  assert.deepEqual(decoded.fields, {
    canvas: sha1("canvas-x"),
    nce: "true",
    sh: "1080",
    sw: "1920",
  });
  assert.equal(encodeFingerprint(decoded.fields), encoded);
});

test("指纹解码：认不出来的一律 null（不抛、不猜半份）", () => {
  assert.equal(decodeFingerprint("").ok, false);
  assert.equal(decodeFingerprint(null).ok, false);
  assert.equal(decodeFingerprint("不是 base64 的形状！！！").ok, false);
  // 有内容但没有 cs：也当认不出（服务端不认这种）。
  assert.equal(decodeFingerprint(Buffer.from("a=1", "binary").toString("base64")).ok, false);
});

// ---------------------------------------------------------------------------
// 3. 与页面逐字节一致（本模块存在的理由）
// ---------------------------------------------------------------------------

test("契约：探针抓到的那份页面指纹，解回来再编回去必须**逐字节**相同", () => {
  const raw = PAGE_FIXTURE.fingerprint;
  const decoded = decodeFingerprint(raw);
  assert.equal(decoded.ok, true);
  /**
   * 页面那份里 `ips`/`devs` 是**空数组**（编码时算真值，所以线上能看到 `devs=&ips=`），
   * 而解码只能还出空串。按页面那种类型还原一下，才能比"逐字节"。
   */
  const pagePayload = { ...decoded.fields, ips: [], devs: [] };
  assert.equal(serializeFingerprint(pagePayload), decoded.body, "序列化那一步（排序 + percent-encode + 空值规则）与页面一致");
  assert.equal(
    encodeFingerprint(pagePayload),
    raw,
    "我们的编码器与页面 bundle 里那段（序列化 → &cs= → 滚动 XOR → base64）必须一模一样",
  );
});

test("契约：解码出来的字段表与探针记下的形状一致（19 个字段、canvas/webgl/fonts 是 40 位 hex）", () => {
  const decoded = decodeFingerprint(PAGE_FIXTURE.fingerprint);
  assert.deepEqual(Object.keys(decoded.fields).sort(), [...DEVICE_FINGERPRINT_FIELDS].sort());
  for (const name of ["canvas", "webgl", "fonts", "ep"]) {
    assert.match(decoded.fields[name], /^[0-9a-f]{40}$/i, `${name} 在页面那份里就是 40 位 hex`);
  }
  assert.equal(decoded.checksum.length, 40, "cs 是 40 位 hex（sha1）");
});

// ---------------------------------------------------------------------------
// 4. 我们能诚实给出的那份字段表
// ---------------------------------------------------------------------------

test("字段表：与我们自己发的字段集合一致——页面带什么，我们就带什么，一个不多一个不少", () => {
  const fields = deviceFingerprintFields({ now: 1_700_000_000_000, lang: "zh-cn" });
  assert.deepEqual(Object.keys(fields).sort(), [...DEVICE_FINGERPRINT_FIELDS].sort());
  // 线上字段数也要一样：探针抓到的那份是 19 个（`devs=`/`ips=` 是空数组，照样进编码）
  const wire = serializeFingerprint(fields).split("&").map((pair) => pair.slice(0, pair.indexOf("=")));
  assert.deepEqual(wire.sort(), [...DEVICE_FINGERPRINT_FIELDS].sort());
  const body = decodeFingerprint(encodeFingerprint(fields)).body;
  assert.equal(body.includes("devs=&"), true, "空数组照样进编码（页面那份里就有 devs=）");
  assert.equal(body.includes("ips=&") || body.endsWith("ips="), true, "ips 同理");
});

test("字段表：能真取到的就真取（语言/时区/时刻），取不到的给同形状的固定值并写清楚", () => {
  const fields = deviceFingerprintFields({ now: 1_700_000_000_000, lang: "zh-cn" });
  assert.equal(fields.ett, "1700000000000", "ett = 采集时刻（注入的 now）");
  assert.equal(fields.etz, String(-new Date(1_700_000_000_000).getTimezoneOffset()));
  assert.equal(fields.nlg, "zh-cn");
  // canvas/webgl/fonts/ep 是页面用真浏览器算出来的哈希；sidecar 只能给同形状（40 位 hex）的固定值，服务端按形状收。
  for (const name of ["canvas", "webgl", "fonts", "ep"]) {
    assert.match(fields[name], /^[0-9a-f]{40}$/, `${name} 必须是 40 位 hex（与服务端收下的形状一致）`);
  }
  assert.equal(fields.canvas, deviceFingerprintFields({ now: 1, lang: "zh-cn" }).canvas, "同一台设备每次报同一个（设备标识要稳定）");
});

test("字段表：注入项能覆盖（屏幕尺寸/浏览器名），空值不冒充真值", () => {
  const fields = deviceFingerprintFields({ now: 1, lang: "zh-cn", width: 1280, height: 800, browserName: "Mozilla", platform: "Win32" });
  assert.equal(fields.sw, "1280");
  assert.equal(fields.sh, "800");
  assert.equal(fields.saw, "1280");
  assert.equal(fields.sah, "800");
  assert.equal(fields.nacn, "Mozilla");
  assert.equal(fields.npf, "Win32");
  const encoded = encodeFingerprint(fields);
  assert.equal(decodeFingerprint(encoded).ok, true, "我们给的那份也必须是可解、可发的形状");
});
