/**
 * 发布前的三件事：版本号在四处一致、仓库行尾固定为 LF、发布说明的源码地址指向本 Release 对应的提交。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("发布：Release 说明的源码地址指向本 Release 对应的提交，不再是占位", () => {
  const workflow = read(".github/workflows/windows-nsis.yml");
  assert.doesNotMatch(workflow, /your-fork-here|占位地址/);
  assert.ok(workflow.includes("${{ github.server_url }}/${{ github.repository }}/tree/${{ github.sha }}"), "AGPL 要求拿到二进制的人能拿到对应源码");
  for (const phrase of ["未签名", "非官方", "OAuth", "AGPL"]) assert.ok(workflow.includes(phrase), `发布说明缺：${phrase}`);
});
