/**
 * 发布前的检查：版本号一致、行尾固定为 LF、CI 按固定提交取参考实现、发布说明的源码地址、发布资产的英文文件名。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

test("发布：版本号 0.2.0 在 package.json、package-lock.json、tauri.conf.json、Cargo.toml / Cargo.lock 一致", () => {
  const pkg = JSON.parse(read("package.json")).version;
  assert.equal(pkg, "0.2.0");
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, pkg, "package-lock.json 顶层");
  assert.equal(lock.packages[""].version, pkg, "package-lock.json 的 packages[\"\"]");
  assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, pkg, "安装包文件名与应用版本取自 tauri.conf.json");
  assert.match(read("src-tauri/Cargo.toml"), new RegExp(`^version = "${pkg}"`, "m"));
  assert.match(read("src-tauri/Cargo.lock"), /name = "huawei-music-desktop"\s*version = "0\.2\.0"/, "Cargo.lock 根包的版本");
});

test("发布：行尾固定为 LF（Windows CI 检出默认转 CRLF，按行扫源码的测试会失配）", () => {
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf/m);
});

test("发布：CI 按固定提交取参考实现，差分测试才不会按缺席跳过（CI 要求 skipped 0）", () => {
  const workflow = read(".github/workflows/windows-nsis.yml");
  const pinned = read("docs/API_CONTRACT.md").match(/talongao\/huawei-music-desktop`，main @ `([0-9a-f]{40})`/)?.[1];
  assert.ok(pinned, "API_CONTRACT.md 里要记着参考实现的固定提交");
  assert.ok(workflow.includes("git clone --quiet https://github.com/talongao/huawei-music-desktop.git .tmp/reference-repo"), "取到差分测试读的位置");
  assert.ok(workflow.includes(`checkout --quiet --detach ${pinned}`), "检出的是文档记录的那个提交");
  assert.ok(workflow.indexOf("取参考实现") > 0 && workflow.indexOf("取参考实现") < workflow.indexOf("npm run test 2>&1"), "在单元测试之前取");
});

const TMP = `${repoRoot}.tmp/release-test`;
const productName = () => JSON.parse(read("src-tauri/tauri.conf.json")).productName;

test("发布：资产用英文文件名（GitHub 会删掉资产名里的中文：v0.2.0 草稿实测成了 _0.2.0_x64-setup.exe）", async () => {
  const { releaseAssetName } = await import("../scripts/release-assets.mjs");
  assert.equal(releaseAssetName(`${productName()}_0.2.0_x64-setup.exe`, productName()), "HWMusic_0.2.0_x64-setup.exe");
  assert.throws(() => releaseAssetName("other_0.2.0_x64-setup.exe", productName()), /不以/);
  assert.throws(() => releaseAssetName(`${productName()}_版本_x64-setup.exe`, productName()), /不是 ASCII/);
});

test("发布：release:assets 只暂存英文名安装包与只含它的 SHA256SUMS，旧资产先清掉", async (t) => {
  const { stageReleaseAssets } = await import("../scripts/release-assets.mjs");
  const root = path.join(TMP, "stage");
  rmSync(root, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const assets = path.join(root, "src-tauri", "target", "release", "bundle", "release-assets");
  mkdirSync(nsis, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: productName() }));
  writeFileSync(path.join(nsis, `${productName()}_0.2.0_x64-setup.exe`), "installer");
  writeFileSync(path.join(nsis, "SHA256SUMS"), "ignored");
  writeFileSync(path.join(assets, "HWMusic_0.1.0_x64-setup.exe"), "stale");
  const result = await stageReleaseAssets({ root, profile: "release" });
  const sha = createHash("sha256").update("installer").digest("hex");
  assert.equal(result.name, "HWMusic_0.2.0_x64-setup.exe");
  assert.equal(result.sha256, sha);
  assert.deepEqual(readdirSync(assets).sort(), ["HWMusic_0.2.0_x64-setup.exe", "SHA256SUMS"]);
  assert.equal(readFileSync(path.join(assets, "HWMusic_0.2.0_x64-setup.exe"), "utf8"), "installer");
  const sums = readFileSync(path.join(assets, "SHA256SUMS"), "utf8");
  assert.ok(sums.startsWith(`${sha}  HWMusic_0.2.0_x64-setup.exe`), sums);
  assert.equal(sums.length, `${sha}  HWMusic_0.2.0_x64-setup.exe`.length + 1, "只有这一行，末尾一个换行");
});

test("发布：打包目录里不是恰好一个安装包时 release:assets 报错，不留半套资产", async (t) => {
  const { stageReleaseAssets } = await import("../scripts/release-assets.mjs");
  const root = path.join(TMP, "bad-stage");
  rmSync(root, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: productName() }));
  writeFileSync(path.join(nsis, "SHA256SUMS"), "only sums");
  await assert.rejects(stageReleaseAssets({ root, profile: "release" }), /恰好一个安装包，实际 0 个/);
  writeFileSync(path.join(nsis, `${productName()}_0.1.0_x64-setup.exe`), "a");
  writeFileSync(path.join(nsis, `${productName()}_0.2.0_x64-setup.exe`), "b");
  await assert.rejects(stageReleaseAssets({ root, profile: "release" }), /实际 2 个/);
  assert.deepEqual(readdirSync(path.join(root, "src-tauri", "target", "release", "bundle")), ["nsis"], "失败时不建 release-assets");
});

test("发布：CI 的 Release 只传 release-assets 里的英文名资产，打包前清掉缓存里的旧安装包", () => {
  const workflow = read(".github/workflows/windows-nsis.yml");
  const releaseStep = workflow.slice(workflow.indexOf("- name: 发布 Release"));
  assert.ok(releaseStep.includes("src-tauri/target/release/bundle/release-assets/HWMusic_*.exe"), "安装包取英文名副本");
  assert.ok(releaseStep.includes("src-tauri/target/release/bundle/release-assets/SHA256SUMS"), "校验和取只含英文名的那份");
  assert.ok(!releaseStep.includes("bundle/nsis/"), "nsis 目录里是中文文件名，传上去会被 GitHub 改名");
  const assetsAt = workflow.indexOf("npm run release:assets");
  assert.ok(assetsAt > workflow.indexOf("npm run release:checksums") && assetsAt < workflow.indexOf("- name: 发布 Release"), "在校验和之后、发布之前生成");
  const cleanAt = workflow.indexOf("Remove-Item");
  assert.ok(cleanAt > 0 && cleanAt < workflow.indexOf("          npm run dist:win"), "打包前清掉 bundle，缓存恢复的旧安装包不进 check:nsis 与 Release");
  assert.equal(JSON.parse(read("package.json")).scripts["release:assets"], "node scripts/release-assets.mjs");
});

test("发布：README 与打包文档写的是 Release 上真实的英文资产名", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("HWMusic_<版本>_x64-setup.exe"), "README 下载说明用英文资产名");
  assert.ok(!readme.includes("华为音乐第三方客户端_<版本>_x64-setup.exe"), "Release 上没有中文名的资产");
  assert.ok(readme.includes("npm run release:assets"), "构建表列出 release:assets");
  assert.ok(read("docs/RUN_AND_PACKAGING.md").includes("release:assets"), "打包文档写清 release:assets");
});

test("发布：Release 说明的源码地址指向本 Release 对应的提交，不再是占位", () => {
  const workflow = read(".github/workflows/windows-nsis.yml");
  assert.doesNotMatch(workflow, /your-fork-here|占位地址/);
  assert.ok(workflow.includes("${{ github.server_url }}/${{ github.repository }}/tree/${{ github.sha }}"), "AGPL 要求拿到二进制的人能拿到对应源码");
  for (const phrase of ["未签名", "非官方", "OAuth", "AGPL"]) assert.ok(workflow.includes(phrase), `发布说明缺：${phrase}`);
});
