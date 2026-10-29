// `npm run release:assets`：把安装包复制成英文文件名放进 bundle/release-assets/，并写只含它的 SHA256SUMS（GitHub 会删掉资产名里的中文）。
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHECKSUM_FILE, ROOT, checksumEntries, writeChecksums } from "./release-checksums.mjs";

export const ASSET_PREFIX = "HWMusic";
export const ASSETS_DIR = "release-assets";

/** 把 Tauri 产出的 `<productName>_<版本>_<架构>-setup.exe` 换成 `HWMusic_<版本>_<架构>-setup.exe`。 */
export function releaseAssetName(installerName, productName) {
  if (!installerName.startsWith(`${productName}_`)) throw new Error(`安装包「${installerName}」不以「${productName}_」开头`);
  const name = `${ASSET_PREFIX}${installerName.slice(productName.length)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`资产名「${name}」不是 ASCII，GitHub 会改写它`);
  return name;
}

/** 清空并重建 bundle/release-assets/：只放英文名安装包与它的 SHA256SUMS，避免旧版本资产混进 Release。 */
export async function stageReleaseAssets({ root = ROOT, profile = "release" } = {}) {
  const bundleDir = path.join(root, "src-tauri", "target", profile, "bundle");
  const nsisDir = path.join(bundleDir, "nsis");
  const installers = (await readdir(nsisDir)).filter((name) => name.toLowerCase().endsWith(".exe"));
  if (installers.length !== 1) throw new Error(`${path.relative(root, nsisDir)} 里应有恰好一个安装包，实际 ${installers.length} 个`);
  const { productName } = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const name = releaseAssetName(installers[0], productName);
  const outDir = path.join(bundleDir, ASSETS_DIR);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, name);
  await copyFile(path.join(nsisDir, installers[0]), dest);
  const [entry] = await checksumEntries([dest]);
  await writeChecksums({ outPath: path.join(outDir, CHECKSUM_FILE), entries: [entry] });
  return { outDir, name, sha256: entry.sha256, bytes: entry.bytes };
}

async function main() {
  const profile = process.env.HWMUSIC_BUNDLE_PROFILE ?? "release";
  const { outDir, name, sha256, bytes } = await stageReleaseAssets({ profile });
  console.log(`release:assets 完成（profile=${profile}）：${path.relative(ROOT, outDir)}`);
  console.log(`  ${sha256}  ${name}（${bytes} B）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`release:assets 失败：${cause.message}`);
    process.exit(1);
  });
}
