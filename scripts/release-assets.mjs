// `npm run release:assets`：把安装包复制成英文文件名放进 bundle/release-assets/，写只含它的 SHA256SUMS（GitHub 会删掉资产名里的中文）；
// 有签名时再写更新器的 latest.json，CHANGELOG.md 里有本版本一节时写 RELEASE_NOTES.md（Release 正文）。
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHECKSUM_FILE, ROOT, checksumEntries, writeChecksums } from "./release-checksums.mjs";

export const ASSET_PREFIX = "HWMusic";
export const ASSETS_DIR = "release-assets";
export const REPOSITORY = "https://github.com/Solathis/HWMusic";
export const MANIFEST_FILE = "latest.json";
export const NOTES_FILE = "RELEASE_NOTES.md";
/** 更新器先找带安装器类型的键，再找通用键；两个都写，开发版与安装版都认得。 */
export const UPDATER_TARGETS = ["windows-x86_64", "windows-x86_64-nsis"];

/** 把 Tauri 产出的 `<productName>_<版本>_<架构>-setup.exe` 换成 `HWMusic_<版本>_<架构>-setup.exe`。 */
export function releaseAssetName(installerName, productName) {
  if (!installerName.startsWith(`${productName}_`)) throw new Error(`安装包「${installerName}」不以「${productName}_」开头`);
  const name = `${ASSET_PREFIX}${installerName.slice(productName.length)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`资产名「${name}」不是 ASCII，GitHub 会改写它`);
  return name;
}

export function releaseDownloadUrl(version, assetName) {
  return `${REPOSITORY}/releases/download/v${version}/${assetName}`;
}

/** CHANGELOG.md 里 `## [版本]` 那一节的正文（到下一个 `## ` 为止）；没有这一节回 null。 */
export function changelogSection(markdown, version) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** 更新器读的 latest.json：签名是 `.sig` 文件的原文，签的是安装包字节，所以改名不影响验签。 */
export function updaterManifest({ version, notes, pubDate, signature, url }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: Object.fromEntries(UPDATER_TARGETS.map((target) => [target, { signature, url }])),
  };
}

/** 安装包文件名里的版本号（`<名字>_<版本>_<架构>-setup.exe`）。 */
export function installerVersion(installerName) {
  const found = installerName.match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_[^_]+-setup\.exe$/i);
  if (!found) throw new Error(`读不出安装包「${installerName}」的版本号`);
  return found[1];
}

/**
 * 清空并重建 bundle/release-assets/：英文名安装包、只含它的 SHA256SUMS，以及（有就写）latest.json 与 RELEASE_NOTES.md。
 * `strict`（标签构建）时缺签名或缺本版本的 CHANGELOG 一节就报错；所有检查都在动目录之前，失败不留半套资产。
 */
export async function stageReleaseAssets({ root = ROOT, profile = "release", strict = false, now = new Date() } = {}) {
  const bundleDir = path.join(root, "src-tauri", "target", profile, "bundle");
  const nsisDir = path.join(bundleDir, "nsis");
  const installers = (await readdir(nsisDir)).filter((name) => name.toLowerCase().endsWith(".exe"));
  if (installers.length !== 1) throw new Error(`${path.relative(root, nsisDir)} 里应有恰好一个安装包，实际 ${installers.length} 个`);
  const { productName } = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = releaseAssetName(installers[0], productName);
  const version = installerVersion(installers[0]);

  const signaturePath = path.join(nsisDir, `${installers[0]}.sig`);
  const signature = existsSync(signaturePath) ? (await readFile(signaturePath, "utf8")).trim() : null;
  if (strict && signature === null) throw new Error(`没有更新签名 ${path.relative(root, signaturePath)}：标签构建必须带 TAURI_SIGNING_PRIVATE_KEY`);
  const changelogPath = path.join(root, "CHANGELOG.md");
  const notes = existsSync(changelogPath) ? changelogSection(await readFile(changelogPath, "utf8"), version) : null;
  if (strict && notes === null) throw new Error(`CHANGELOG.md 里没有 ## [${version}] 这一节：Release 正文与更新说明都从这里取`);

  const outDir = path.join(bundleDir, ASSETS_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, name);
  await copyFile(path.join(nsisDir, installers[0]), dest);
  const [entry] = await checksumEntries([dest]);
  await writeChecksums({ outPath: path.join(outDir, CHECKSUM_FILE), entries: [entry] });
  if (notes !== null) await writeFile(path.join(outDir, NOTES_FILE), `${notes}\n`, "utf8");
  if (signature !== null) {
    const manifest = updaterManifest({
      version,
      notes: notes ?? "",
      pubDate: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      signature,
      url: releaseDownloadUrl(version, name),
    });
    await writeFile(path.join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return { outDir, name, version, sha256: entry.sha256, bytes: entry.bytes, manifest: signature !== null, notes: notes !== null };
}

async function main() {
  const profile = process.env.HWMUSIC_BUNDLE_PROFILE ?? "release";
  const strict = process.env.HWMUSIC_REQUIRE_RELEASE_METADATA === "true";
  const { outDir, name, sha256, bytes, manifest, notes } = await stageReleaseAssets({ profile, strict });
  console.log(`release:assets 完成（profile=${profile}）：${path.relative(ROOT, outDir)}`);
  console.log(`  ${sha256}  ${name}（${bytes} B）`);
  console.log(`  ${MANIFEST_FILE}：${manifest ? "已写（有更新签名）" : "未写（没有更新签名）"}；${NOTES_FILE}：${notes ? "已写" : "未写（CHANGELOG 里没有本版本）"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`release:assets 失败：${cause.message}`);
    process.exit(1);
  });
}
