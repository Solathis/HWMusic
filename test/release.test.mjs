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

test("发布：版本号在 package.json、package-lock.json、tauri.conf.json、Cargo.toml / Cargo.lock 一致，CHANGELOG 有这一版", () => {
  const pkg = JSON.parse(read("package.json")).version;
  assert.match(pkg, /^[0-9]+[.][0-9]+[.][0-9]+$/);
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, pkg, "package-lock.json 顶层");
  assert.equal(lock.packages[""].version, pkg, "package-lock.json 的 packages[\"\"]");
  assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, pkg, "安装包文件名与应用版本取自 tauri.conf.json");
  assert.match(read("src-tauri/Cargo.toml"), new RegExp(`^version = "${pkg}"`, "m"));
  const cargoLock = read("src-tauri/Cargo.lock");
  const root = cargoLock.indexOf('name = "huawei-music-desktop"');
  assert.ok(root > -1 && cargoLock.slice(root).split("\n")[1] === `version = "${pkg}"`, "Cargo.lock 根包的版本");
  assert.ok(read("CHANGELOG.md").includes(`## [${pkg}] - `), "CHANGELOG.md 要有这一版（Release 正文从这里取）");
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

test("发布：Release 正文只列本版本的新增 / 改进 / 修复，免责声明与源码地址在 README", () => {
  const workflow = read(".github/workflows/windows-nsis.yml");
  const releaseStep = workflow.slice(workflow.indexOf("- name: 发布 Release"));
  assert.ok(releaseStep.includes("body_path: src-tauri/target/release/bundle/release-assets/RELEASE_NOTES.md"), "正文取自 CHANGELOG 生成的 RELEASE_NOTES.md");
  assert.doesNotMatch(releaseStep, /^\s+body: \|/m, "不再在工作流里写整段说明");
  const readme = read("README.md");
  for (const phrase of ["未签名", "非官方", "OAuth", "AGPL"]) assert.ok(readme.includes(phrase), `README 缺：${phrase}`);
  assert.ok(readme.includes("https://github.com/Solathis/HWMusic"), "README 给出源码地址");
});

test("发布：CHANGELOG 每一节只有「新增 / 改进 / 修复」三类条目，没有成段的话", () => {
  const changelog = read("CHANGELOG.md");
  const body = changelog.slice(changelog.indexOf("\n## ["));
  for (const line of body.split("\n").filter((text) => text.trim() !== "")) {
    if (line.startsWith("## [")) {
      assert.match(line, /^## \[[0-9]+[.][0-9]+[.][0-9]+\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$/, `版本标题格式不对：${line}`);
    } else if (line.startsWith("### ")) {
      assert.ok(["### 新增", "### 改进", "### 修复"].includes(line), `分类只能是新增 / 改进 / 修复：${line}`);
    } else {
      assert.ok(line.startsWith("- "), `每一节里只放条目：${line}`);
    }
  }
});

test("发布：changelogSection 取版本那一节到下一节为止，没有就是 null", async () => {
  const { changelogSection } = await import("../scripts/release-assets.mjs");
  const markdown = "# 更新日志\n\n## [0.3.0] - 2026-11-01\n\n### 新增\n\n- 关于页\n\n## [0.2.0] - 2026-10-29\n\n### 新增\n\n- 扫码登录\n";
  assert.equal(changelogSection(markdown, "0.3.0"), "### 新增\n\n- 关于页");
  assert.equal(changelogSection(markdown, "0.2.0"), "### 新增\n\n- 扫码登录");
  assert.equal(changelogSection(markdown, "0.1.0"), null);
  assert.equal(changelogSection(markdown, "0.3"), null, "版本号要完整匹配");
});

test("发布：有更新签名时 release:assets 写 latest.json（两个平台键都指向本标签的安装包）与 RELEASE_NOTES.md", async (t) => {
  const { stageReleaseAssets } = await import("../scripts/release-assets.mjs");
  const root = path.join(TMP, "signed");
  rmSync(root, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: productName() }));
  writeFileSync(path.join(root, "CHANGELOG.md"), "# 更新日志\n\n## [0.3.0] - 2026-11-01\n\n### 新增\n\n- 关于页\n");
  writeFileSync(path.join(nsis, `${productName()}_0.3.0_x64-setup.exe`), "installer");
  writeFileSync(path.join(nsis, `${productName()}_0.3.0_x64-setup.exe.sig`), "c2lnbmF0dXJl\n");
  const result = await stageReleaseAssets({ root, profile: "release", strict: true, now: new Date("2026-11-01T08:00:00.123Z") });
  const assets = result.outDir;
  assert.deepEqual(readdirSync(assets).sort(), ["HWMusic_0.3.0_x64-setup.exe", "RELEASE_NOTES.md", "SHA256SUMS", "latest.json"]);
  const url = "https://github.com/Solathis/HWMusic/releases/download/v0.3.0/HWMusic_0.3.0_x64-setup.exe";
  assert.deepEqual(JSON.parse(readFileSync(path.join(assets, "latest.json"), "utf8")), {
    version: "0.3.0",
    notes: "### 新增\n\n- 关于页",
    pub_date: "2026-11-01T08:00:00Z",
    platforms: { "windows-x86_64": { signature: "c2lnbmF0dXJl", url }, "windows-x86_64-nsis": { signature: "c2lnbmF0dXJl", url } },
  });
  assert.equal(readFileSync(path.join(assets, "RELEASE_NOTES.md"), "utf8"), "### 新增\n\n- 关于页\n");
  assert.ok(readFileSync(path.join(assets, "SHA256SUMS"), "utf8").trim().endsWith("HWMusic_0.3.0_x64-setup.exe"), "校验和仍只有安装包");
});

test("发布：标签构建缺更新签名或缺本版本的 CHANGELOG 就报错，不留半套资产", async (t) => {
  const { stageReleaseAssets } = await import("../scripts/release-assets.mjs");
  const root = path.join(TMP, "strict");
  rmSync(root, { recursive: true, force: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nsis = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: productName() }));
  writeFileSync(path.join(nsis, `${productName()}_0.3.0_x64-setup.exe`), "installer");
  await assert.rejects(stageReleaseAssets({ root, profile: "release", strict: true }), /没有更新签名/);
  writeFileSync(path.join(nsis, `${productName()}_0.3.0_x64-setup.exe.sig`), "c2ln");
  await assert.rejects(stageReleaseAssets({ root, profile: "release", strict: true }), /CHANGELOG\.md 里没有 ## \[0\.3\.0\]/);
  assert.deepEqual(readdirSync(path.join(root, "src-tauri", "target", "release", "bundle")), ["nsis"], "失败时不建 release-assets");
});
