// `npm run verify:update-signature`：用 tauri.conf.json 里的公钥验 release-assets/latest.json 对安装包的签名（与更新器同一套 minisign 规则）。
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ASSETS_DIR, MANIFEST_FILE, releaseDownloadUrl } from "./release-assets.mjs";
import { ROOT } from "./release-checksums.mjs";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** tauri 的公钥与签名是「整段 minisign 文本再 base64 一次」。 */
export function decodeTauriBase64(value) {
  return Buffer.from(String(value).trim(), "base64").toString("utf8");
}

export function parseMinisignPublicKey(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line !== "");
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment:")) throw new Error("不是 minisign 公钥");
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("minisign 公钥长度或算法不对");
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

export function parseMinisignSignature(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line !== "");
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("不是 minisign 签名");
  }
  const raw = Buffer.from(lines[1], "base64");
  const global = Buffer.from(lines[3], "base64");
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED") || global.length !== 64) throw new Error("minisign 签名长度或算法不对");
  return { algorithm, keyId: raw.subarray(2, 10), signature: raw.subarray(10, 74), trustedComment: lines[2].slice("trusted comment: ".length), globalSignature: global };
}

/** minisign 显示的密钥 ID：8 字节小端整数的十六进制大写。 */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** 验签：ED 先对数据取 BLAKE2b-512，再验主签名与覆盖「签名 + 可信注释」的全局签名。 */
export function verifyMinisign(data, signatureText, publicKeyText) {
  let sig;
  let key;
  try {
    sig = parseMinisignSignature(signatureText);
    key = parseMinisignPublicKey(publicKeyText);
  } catch (cause) {
    return { ok: false, reason: cause.message };
  }
  if (!sig.keyId.equals(key.keyId)) return { ok: false, reason: `签名的密钥 ${keyIdHex(sig.keyId)} 不是公钥 ${keyIdHex(key.keyId)}` };
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.publicKey]), format: "der", type: "spki" });
  const message = sig.algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.signature)) return { ok: false, reason: "签名与文件内容对不上" };
  if (!verify(null, Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]), publicKey, sig.globalSignature)) {
    return { ok: false, reason: "可信注释被改过" };
  }
  return { ok: true, keyId: keyIdHex(key.keyId), trustedComment: sig.trustedComment };
}

/** 验暂存目录里的 latest.json：每个平台的地址都指向本版本的安装包，签名都能被配置里的公钥验过。 */
export async function verifyStagedUpdate({ root = ROOT, profile = "release" } = {}) {
  const config = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const publicKeyText = decodeTauriBase64(config.plugins?.updater?.pubkey ?? "");
  const dir = path.join(root, "src-tauri", "target", profile, "bundle", ASSETS_DIR);
  const manifest = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
  const problems = [];
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    const name = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
    if (entry.url !== releaseDownloadUrl(manifest.version, name)) problems.push(`${platform} 的地址不是 v${manifest.version} 的下载地址：${entry.url}`);
    const result = verifyMinisign(await readFile(path.join(dir, name)), decodeTauriBase64(entry.signature), publicKeyText);
    if (!result.ok) problems.push(`${platform}：${result.reason}`);
  }
  if (Object.keys(manifest.platforms ?? {}).length === 0) problems.push("latest.json 里没有任何平台");
  return { ok: problems.length === 0, version: manifest.version, problems, keyId: keyIdHex(parseMinisignPublicKey(publicKeyText).keyId) };
}

async function main() {
  const result = await verifyStagedUpdate({ profile: process.env.HWMUSIC_BUNDLE_PROFILE ?? "release" });
  if (!result.ok) {
    console.error(`verify:update-signature 失败（v${result.version}，公钥 ${result.keyId}）：`);
    for (const problem of result.problems) console.error(`  ✖ ${problem}`);
    process.exit(1);
  }
  console.log(`verify:update-signature 通过：v${result.version} 的 latest.json 签名能被公钥 ${result.keyId} 验过`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`verify:update-signature 失败：${cause.message}`);
    process.exit(1);
  });
}
