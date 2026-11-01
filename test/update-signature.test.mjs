/**
 * 更新签名的验签：与更新器同一套 minisign 规则（ED 预哈希 / Ed 旧格式、全局签名覆盖可信注释、密钥 ID 对得上）。
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { releaseDownloadUrl, updaterManifest } from "../scripts/release-assets.mjs";
import { decodeTauriBase64, keyIdHex, parseMinisignPublicKey, verifyMinisign, verifyStagedUpdate } from "../scripts/update-signature.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 造一对 minisign 密钥：返回公钥文本与签名函数（只在测试里用，不碰真实私钥）。 */
function minisignPair(keyId = Buffer.from("0123456789abcdef", "hex")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKeyText = `untrusted comment: minisign public key: ${keyIdHex(keyId)}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  const signText = (data, { algorithm = "ED", trusted = "timestamp:1761955200\tfile:HWMusic_0.3.0_x64-setup.exe", signer = keyId } = {}) => {
    const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    const signature = sign(null, message, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
    return `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from(algorithm), signer, signature]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
  };
  return { publicKeyText, signText };
}

test("更新签名：ED（预哈希）与 Ed（旧格式）都能验过，改了文件、可信注释或换了密钥都不行", () => {
  const { publicKeyText, signText } = minisignPair();
  const data = Buffer.from("installer bytes");
  assert.equal(verifyMinisign(data, signText(data), publicKeyText).ok, true);
  assert.equal(verifyMinisign(data, signText(data, { algorithm: "Ed" }), publicKeyText).ok, true);
  assert.match(verifyMinisign(Buffer.from("tampered"), signText(data), publicKeyText).reason, /对不上/);
  const forged = signText(data).replace("trusted comment: timestamp", "trusted comment: timestamq");
  assert.match(verifyMinisign(data, forged, publicKeyText).reason, /可信注释/);
  const other = signText(data, { signer: Buffer.from("fedcba9876543210", "hex") });
  assert.match(verifyMinisign(data, other, publicKeyText).reason, /不是公钥/);
  assert.equal(verifyMinisign(data, "not a signature", publicKeyText).ok, false, "认不出的签名不算通过");
});

test("更新签名：仓库里的公钥是 minisign 公钥，注释里的密钥 ID 与内容一致", () => {
  const config = JSON.parse(readFileSync(`${repoRoot}src-tauri/tauri.conf.json`, "utf8"));
  const text = decodeTauriBase64(config.plugins.updater.pubkey);
  const shown = text.split(/\r?\n/)[0].split(": ").at(-1);
  assert.equal(keyIdHex(parseMinisignPublicKey(text).keyId), shown);
});

test("更新签名：verify:update-signature 验暂存目录里的 latest.json，安装包被改过就失败", async (t) => {
  const root = path.join(repoRoot, ".tmp", "update-signature-test");
  rmSync(root, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { publicKeyText, signText } = minisignPair();
  const assets = path.join(root, "src-tauri", "target", "release", "bundle", "release-assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ plugins: { updater: { pubkey: Buffer.from(publicKeyText).toString("base64") } } }));
  const name = "HWMusic_0.3.0_x64-setup.exe";
  writeFileSync(path.join(assets, name), "installer");
  const manifest = updaterManifest({ version: "0.3.0", notes: "", pubDate: "2026-11-01T00:00:00Z", signature: Buffer.from(signText(Buffer.from("installer"))).toString("base64"), url: releaseDownloadUrl("0.3.0", name) });
  writeFileSync(path.join(assets, "latest.json"), JSON.stringify(manifest));
  assert.deepEqual((await verifyStagedUpdate({ root })).problems, []);
  writeFileSync(path.join(assets, name), "tampered");
  const result = await verifyStagedUpdate({ root });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2, "两个平台键都报");
});
