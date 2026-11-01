/**
 * README 与仓库卫生：本地文档目录不入库，入库的代码、测试、CI 与 README 也不读、不链它；README 的图都是仓库里真实存在的文件。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const LOCAL_DOCS = "doc" + "s/";
const TEXT = /\.(mjs|js|cjs|ts|tsx|rs|ya?ml|json|css|html|md)$/;

function sourceFiles(dir) {
  return readdirSync(path.join(ROOT, dir), { recursive: true })
    .map((name) => `${dir}/${String(name).split(path.sep).join("/")}`)
    .filter((file) => TEXT.test(file) && statSync(path.join(ROOT, file)).isFile());
}

/** 文本里指向本地文档目录的位置；外部网址里的同名路径不算。 */
function localDocsRefs(text) {
  const hits = [];
  let at = text.indexOf(LOCAL_DOCS);
  while (at >= 0) {
    const token = text.slice(Math.max(0, at - 200), at).split(/[\s"'`(（「]/).at(-1);
    if (!token.includes("://")) hits.push(text.slice(Math.max(0, at - 30), at + 40).replace(/\s+/g, " "));
    at = text.indexOf(LOCAL_DOCS, at + LOCAL_DOCS.length);
  }
  return hits;
}

test("仓库卫生：本地文档目录不入库，入库的代码、测试、CI 与 README 不读也不链它（CI 上没有这个目录）", () => {
  assert.ok(read(".gitignore").split(/\r?\n/).includes("/" + LOCAL_DOCS), ".gitignore 要忽略根目录的文档目录");
  const files = ["README.md", "package.json", ...[".github", "scripts", "src", "src-tauri/src", "test"].flatMap(sourceFiles)];
  const offenders = files.flatMap((file) => localDocsRefs(read(file)).map((hit) => `${file}：${hit}`));
  assert.deepEqual(offenders, [], "这些地方还在引用本地文档目录");
});

test("README：图片都是仓库里真实存在的文件，不放在本地文档目录，也不再用演示数据假图", () => {
  const readme = read("README.md");
  const images = [];
  let at = readme.indexOf("![");
  while (at >= 0) {
    const open = readme.indexOf("](", at);
    const close = readme.indexOf(")", open + 2);
    if (open < 0 || close < 0) break;
    images.push(readme.slice(open + 2, close));
    at = readme.indexOf("![", close);
  }
  for (const image of images.filter((src) => !src.includes("://"))) {
    assert.ok(!image.startsWith(LOCAL_DOCS), `${image} 在本地文档目录里，GitHub 上看不到`);
    assert.ok(existsSync(path.join(ROOT, image)), `README 引用的 ${image} 不存在`);
  }
  assert.doesNotMatch(readme, /演示数据/, "截图必须是实机截图");
  assert.ok(!existsSync(path.join(ROOT, "scripts/readme-screenshots.mjs")), "演示数据截图生成器已删除");
});

test("README：简短，参考项目与地址齐全", () => {
  const readme = read("README.md");
  assert.ok(readme.split("\n").length <= 120, `README 应简短（现在 ${readme.split("\n").length} 行）`);
  for (const url of [
    "https://github.com/talongao/huawei-music-desktop",
    "https://github.com/ANYNC/TaskbarLyrics",
    "https://github.com/Mai-icy/Spotify-lyrics-window",
    "https://github.com/amll-dev/applemusic-like-lyrics",
    "https://github.com/shadcn-ui/ui",
  ]) {
    assert.ok(readme.includes(url), `README 缺参考项目 ${url}`);
  }
  assert.ok(readme.includes("[CHANGELOG.md](CHANGELOG.md)"), "更新内容指向 CHANGELOG");
});
