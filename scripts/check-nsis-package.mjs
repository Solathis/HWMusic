#!/usr/bin/env node
/**
 * `npm run check:nsis`：对打包产物做静态校验（不执行安装包）——真装一次要写系统目录、注册表、开始菜单，在 CI 里等于给每个 PR 装一次应用。
 * 所以只验「东西在不在、是不是它、脏东西进没进去」：安装包与 sidecar 存在且是 PE、sidecar 名没漏三元组、
 * 暂存目录能枚举、暂存里的 sidecar 剥过三元组后缀、bundle 输入与暂存目录都不许混进 `.local`/`research`（真实凭据与现场笔记不能进发布物）。
 * 验证对象是暂存层 `src-tauri/target/<profile>/`，默认 `release`，`HWMUSIC_BUNDLE_PROFILE=debug` 时拿开发期产物验骨架。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 主程序 exe 名与 dist:win 的新鲜度检查是同一处事实（都读 Cargo.toml 的 `[[bin]] name`），各写一份必然漂移；
// productName 只是显示名，暂存目录里的 exe 叫 `huawei-music-desktop.exe`。
import { appExeName } from "./dist-win.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BINARIES_DIR = "src-tauri/binaries";
/** 暂存目录里出现这些路径段就是"私人数据进了发布物"。 */
export const SENSITIVE_PATH_SEGMENTS = [".local", "research"];

/** 校验项 id（顺序即报告顺序；外部按它断言清单完整）。 */
export const CHECK_IDS = [
  "installer-unique",
  "installer-pe",
  "sidecar-triple-name",
  "sidecar-pe",
  "staging-enumeration",
  "staged-sidecar",
  "bundle-config",
  "staging-sensitive",
];

/** 已知的目标三元组后缀（用来剥 externalBin 复制后的名字，而不是写死一个名字）。 */
const TRIPLE_SUFFIXES = [
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "i686-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
];

/**
 * 剥掉三元组后缀：`hwmusic-core-x86_64-pc-windows-msvc.exe` → `hwmusic-core.exe`。
 * Tauri 复制 externalBin 到应用同目录时会这么做，所以**暂存名不能写死**；推导错了会在文件明明在时报失败。
 */
export function stripTripleSuffix(fileName) {
  const ext = path.extname(fileName);
  const stem = ext === "" ? fileName : fileName.slice(0, -ext.length);
  for (const triple of TRIPLE_SUFFIXES) {
    if (stem.endsWith(`-${triple}`)) return `${stem.slice(0, -triple.length - 1)}${ext}`;
  }
  return fileName;
}

/** 读 PE 头：`MZ` + `e_lfanew` 处的 `PE\0\0`。 */
export function peHeader(buffer) {
  const result = { mz: false, pe: false };
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40) return result;
  result.mz = buffer[0] === 0x4d && buffer[1] === 0x5a;
  if (!result.mz) return result;
  const offset = buffer.readUInt32LE(0x3c);
  if (offset + 4 > buffer.length) return result;
  result.pe = buffer[offset] === 0x50 && buffer[offset + 1] === 0x45 && buffer[offset + 2] === 0 && buffer[offset + 3] === 0;
  return result;
}

/** bundle 配置里指向 `.local`/`research` 的输入（配置锚：不进发布物的东西不许被列进去）。 */
export function sensitiveBundleInputs(bundleConfig) {
  const offenders = [];
  const walk = (value, trail) => {
    if (typeof value === "string") {
      const normalized = value.replace(/\\/g, "/");
      for (const segment of SENSITIVE_PATH_SEGMENTS) {
        if (normalized.split("/").includes(segment) || normalized.includes(`${segment}/`)) {
          offenders.push(`${trail} = ${value}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, `${trail}.${key}`);
    }
  };
  walk(bundleConfig, "bundle");
  return offenders;
}

/** 暂存文件路径里出现 `.local`/`research` 路径段 = 私人数据进了发布物。 */
export function sensitiveStagedPaths(relativePaths) {
  const offenders = [];
  for (const relative of relativePaths) {
    const segments = relative.replace(/\\/g, "/").split("/");
    for (const sensitive of SENSITIVE_PATH_SEGMENTS) {
      if (segments.includes(sensitive)) offenders.push(`${relative}（命中 ${sensitive}）`);
    }
  }
  return offenders;
}

/** 枚举暂存目录：**读不了就报失败**——吞掉 readdir 的异常，后面所有「暂存里有没有 X」的检查都会在空列表上通过，那种绿比红更危险。 */
export async function enumerateStaging(stagingDir) {
  try {
    const entries = await readdir(stagingDir, { withFileTypes: true });
    return { ok: true, files: entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name) };
  } catch (cause) {
    return { ok: false, error: cause?.message ?? String(cause), files: [] };
  }
}

/** 计算文件 SHA256（打印给发布说明用）。 */
export function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 安装包候选：bundle/nsis 下的 exe。 */
export async function findInstallers(nsisDir) {
  try {
    const entries = await readdir(nsisDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
      .map((entry) => path.join(nsisDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * 跑完整套静态校验。
 *
 * @returns {Promise<{results: Array<{id: string, ok: boolean, detail: string}>, ok: boolean}>}
 */
export async function checkPackage({
  root = ROOT,
  profile = process.env.HWMUSIC_BUNDLE_PROFILE ?? "release",
  binaryName,
} = {}) {
  const results = [];
  const add = (id, ok, detail) => results.push({ id, ok, detail });

  const conf = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const targetDir = path.join(root, "src-tauri", "target");
  const stagingDir = path.join(targetDir, profile);
  const nsisDir = path.join(stagingDir, "bundle", "nsis");

  // 1/2. 安装包：恰好一个，且是 PE
  const installers = await findInstallers(nsisDir);
  add(
    "installer-unique",
    installers.length === 1,
    installers.length === 1
      ? path.relative(root, installers[0])
      : `期望恰好一个安装包，实际 ${installers.length} 个：${JSON.stringify(installers.map((file) => path.relative(root, file)))}`,
  );
  if (installers.length === 1) {
    const head = peHeader(await readFile(installers[0]));
    add("installer-pe", head.mz && head.pe, `MZ=${head.mz} PE=${head.pe}；SHA256=${sha256Of(await readFile(installers[0]))}`);
  } else {
    add("installer-pe", false, "没有可校验的安装包（先看上一条）");
  }

  // 3/4. sidecar：按三元组命名 + 是 PE
  const expectedName = binaryName ?? null;
  const sidecarCandidates = (await enumerateStaging(path.join(root, BINARIES_DIR))).files.filter((file) =>
    /^hwmusic-core-.+\.(exe|bin)$/.test(file),
  );
  const sidecarOnly = sidecarCandidates.length === 1 ? sidecarCandidates[0] : expectedName;
  add(
    "sidecar-triple-name",
    sidecarCandidates.length === 1 && /^hwmusic-core-[a-z0-9_]+-[a-z0-9_-]+\.(exe|bin)$/.test(sidecarCandidates[0] ?? ""),
    sidecarCandidates.length === 1
      ? `${BINARIES_DIR}/${sidecarCandidates[0]}`
      : `期望恰好一个 hwmusic-core-<triple> 产物，实际 ${JSON.stringify(sidecarCandidates)}`,
  );
  if (sidecarCandidates.length === 1) {
    const head = peHeader(await readFile(path.join(root, BINARIES_DIR, sidecarCandidates[0])));
    add("sidecar-pe", head.mz && head.pe, `MZ=${head.mz} PE=${head.pe}（SEA 注入后的 node.exe 副本）`);
  } else {
    add("sidecar-pe", false, "没有可校验的 sidecar（先看上一条）");
  }

  // 5/6. 暂存目录：能枚举、含主程序与剥后缀的 sidecar
  const staging = await enumerateStaging(stagingDir);
  add(
    "staging-enumeration",
    staging.ok && staging.files.length > 0,
    staging.ok ? `${path.relative(root, stagingDir)}：${staging.files.length} 个文件` : `读不了暂存目录：${staging.error}`,
  );
  if (staging.ok && sidecarOnly !== null) {
    const stagedSidecar = stripTripleSuffix(sidecarOnly);
    const appExe = await appExeName(root);
    const missing = [appExe, stagedSidecar].filter((name) => !staging.files.includes(name));
    add(
      "staged-sidecar",
      missing.length === 0,
      missing.length === 0
        ? `暂存里有 ${appExe} 与 ${stagedSidecar}（后缀已剥）`
        : `暂存里缺 ${JSON.stringify(missing)}（现有：${JSON.stringify(staging.files.slice(0, 20))}）`,
    );
  } else {
    add("staged-sidecar", false, "暂存目录枚举失败，无法证明 sidecar 被复制进去了");
  }

  // 7. 配置锚：bundle 输入不许指向 .local/research
  const configOffenders = sensitiveBundleInputs(conf.bundle ?? {});
  add(
    "bundle-config",
    configOffenders.length === 0,
    configOffenders.length === 0
      ? "bundle 输入不含 .local/research"
      : `bundle 输入命中敏感路径：${configOffenders.join("；")}`,
  );

  // 8. 暂存扫描：暂存目录里不许有 .local/research 的文件
  const stagedOffenders = sensitiveStagedPaths([
    ...(staging.files ?? []),
    ...(await findInstallers(nsisDir)).map((file) => path.relative(root, file)),
  ]);
  add(
    "staging-sensitive",
    stagedOffenders.length === 0,
    stagedOffenders.length === 0 ? "暂存目录不含 .local/research" : `暂存命中敏感路径：${stagedOffenders.join("；")}`,
  );

  const ordered = CHECK_IDS.map((id) => results.find((result) => result.id === id)).filter(Boolean);
  return { results: ordered, ok: ordered.every((result) => result.ok) };
}

async function main() {
  const profile = process.env.HWMUSIC_BUNDLE_PROFILE ?? "release";
  const { results, ok } = await checkPackage({ profile });
  console.log(`check:nsis 静态校验（profile=${profile}，不执行安装包）`);
  for (const result of results) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.id.padEnd(20)} ${result.detail}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (!ok) {
    console.error(`\ncheck:nsis 失败：${failed.length} 项（${failed.map((result) => result.id).join("、")}）`);
    if (profile === "release" && failed.some((result) => result.id === "installer-unique")) {
      console.error("提示：release 安装包只能由 npm run dist:win（= tauri build）产生；本机跑不了就如实记 untested，CI 是执行点。");
    }
    process.exit(1);
  }
  console.log(`check:nsis 完成：${results.length}/${results.length} 项通过`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`check:nsis 失败：${cause.message}`);
    process.exit(1);
  });
}
