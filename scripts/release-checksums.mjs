#!/usr/bin/env node
/**
 * `npm run release:checksums`：给**发布产物**算 SHA256 并写出 `SHA256SUMS`。
 *
 * ## 为什么校验和也算一道闸
 *
 * 发布出去的东西是"安装包 + sidecar 二进制"两份文件，下载页上只写一个版本号是无法验证的。
 * `SHA256SUMS` 让人能回答"我下到的这份就是 CI 打出来的那份吗"——没有它，
 * 中间任何一跳（镜像、缓存、二手转存）换掉文件都没人发现。
 *
 * ## 口径
 *
 * - 行格式用 `sha256sum` 的通用形状：`<sha256>  <文件名>`（两个空格）；**按文件名排序**，
 *   同一次构建重跑不会产生无意义的 diff。
 * - 只收**真产物**：安装包（`bundle/nsis/*.exe`）与 sidecar（`binaries/hwmusic-core-*`）。
 *   **一个都没有就报错退出**——写出一个空的 `SHA256SUMS` 比不写更糟：它看起来像"校验过了"。
 * - 文件名只取 basename：`SHA256SUMS` 是要跟产物放一起发布的，带路径的行在下载页上没法用。
 * - 默认写到安装包旁边（`bundle/nsis/SHA256SUMS`）；`--out` 可指定别处（CI 收集用）。
 *
 * `profile` 与 `check-nsis-package.mjs` 同一处事实：默认 `release`，
 * `HWMUSIC_BUNDLE_PROFILE=debug` 时拿开发期产物验骨架。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 校验和文件名（发布物之一）。 */
export const CHECKSUM_FILE = "SHA256SUMS";
/** sidecar 产物目录（与 tauri.conf.json 的 externalBin 前缀一致）。 */
export const BINARIES_DIR = "src-tauri/binaries";

/** 缓冲区的 SHA256 十六进制（小写）。 */
export function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * `SHA256SUMS` 的正文行：`<sha>  <name>`，按名字稳定排序。
 *
 * 排序是刻意的：产物顺序受 readdir 影响（不同文件系统的返回顺序不一样），
 * 不排序的话同一份构建在不同机器上算出的文件内容不同，diff 会一直"有变化"。
 */
export function checksumLines(entries) {
  return [...entries]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.name}`);
}

/** 列出目录下匹配的文件（读不了就当空，由调用方判"产物缺失"）。 */
async function listMatching(dir, predicate) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 收集发布产物（安装包 + sidecar 二进制）。
 *
 * 返回的是**绝对路径**；调用方负责算 SHA 与取 basename。
 */
export async function collectReleaseArtifacts({ root = ROOT, profile = "release" } = {}) {
  const nsisDir = path.join(root, "src-tauri", "target", profile, "bundle", "nsis");
  const installers = await listMatching(nsisDir, (name) => name.toLowerCase().endsWith(".exe"));
  const sidecars = await listMatching(path.join(root, BINARIES_DIR), (name) =>
    /^hwmusic-core-.+\.(exe|bin)$/.test(name),
  );
  return [...installers, ...sidecars];
}

/** 把一组文件变成 `[{name, sha256, bytes}]`。 */
export async function checksumEntries(files) {
  const entries = [];
  for (const file of files) {
    const contents = await readFile(file);
    entries.push({ name: path.basename(file), sha256: sha256Of(contents), bytes: contents.length, path: file });
  }
  return entries;
}

/** 写出 `SHA256SUMS`（末尾一个换行；空行会被 `sha256sum -c` 当成错误）。 */
export async function writeChecksums({ outPath, entries }) {
  const body = `${checksumLines(entries).join("\n")}\n`;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, body, "utf8");
  return body;
}

/** 默认输出位置：跟第一批产物放一起（下载页上两者相邻，不容易走散）。 */
export function defaultOutPath(files, { root = ROOT, profile = "release" } = {}) {
  const dir =
    files.length > 0 && path.dirname(files[0]).includes(`${path.sep}bundle${path.sep}`)
      ? path.dirname(files[0])
      : path.join(root, "src-tauri", "target", profile, "bundle", "nsis");
  return path.join(dir, CHECKSUM_FILE);
}

function parseArgs(argv) {
  const options = { out: null, profile: process.env.HWMUSIC_BUNDLE_PROFILE ?? "release" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      options.out = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argv[index] === "--profile") {
      options.profile = argv[index + 1] ?? options.profile;
      index += 1;
    }
  }
  return options;
}

async function main() {
  const { out, profile } = parseArgs(process.argv.slice(2));
  const files = await collectReleaseArtifacts({ profile });
  if (files.length === 0) {
    console.error(
      `release:checksums 失败：profile=${profile} 下没有任何发布产物（installer/sidecar 都没有）。\n` +
        "先跑 npm run dist:win（+ 本机跑不了 tauri build 时如实记 untested，CI 是执行点）。\n" +
        "不写出空的 SHA256SUMS：一个空清单看起来像「校验过了」。",
    );
    process.exit(1);
  }

  const entries = await checksumEntries(files);
  const outPath = out === null ? defaultOutPath(files, { profile }) : path.resolve(out);
  const body = await writeChecksums({ outPath, entries });

  console.log(`release:checksums 完成（profile=${profile}）：${entries.length} 个产物`);
  for (const entry of entries) {
    console.log(`  ${entry.sha256}  ${entry.name}（${entry.bytes} B）`);
  }
  console.log(`写入 ${path.relative(ROOT, outPath)}：\n${body.trimEnd()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`release:checksums 失败：${cause.message}`);
    process.exit(1);
  });
}
