#!/usr/bin/env node
/**
 * `npm run dist:win`：**唯一的打包编排入口**。
 *
 * ## 为什么不直接 `tauri build`
 *
 * `tauri.conf.json` 的 `beforeBuildCommand` 是空串（R2 裁决，见该文件注释）。直接跑 `tauri build`
 * 时 Tauri **不会**构建渲染层：它把 `frontendDist`（`out/renderer`）里**已有的**产物原样嵌进 exe——
 * 旧仓的实际故障是"改了界面却发布出旧界面，而且退出码 0"。所以顺序在这里写死：
 *
 * ```
 * build:web     vite build            → out/renderer
 * dist:sidecar  esbuild + SEA         → src-tauri/binaries/hwmusic-core-<triple>.exe
 * tauri:build   cargo + NSIS 打包
 * ```
 *
 * 并且打包**之后再验一遍**（`mtime 新鲜度检查`）：每个被打包进去的输入都必须**不晚于** exe 的
 * mtime。谁晚于 exe，谁就没进这一个 exe（Tauri 复用了旧的 exe，或者产物顺序被绕开），
 * 这时退出码必须非 0——"看起来成功"正是这条检查要防的东西。
 *
 * ## 子进程环境
 *
 * 子进程的 `TEMP`/`TMP` 指到工作区内的 `.tmp/temp`（沙箱只给工作区内的可删范围，R9 实测；
 * 详见 docs/RUN_AND_PACKAGING.md 的"本机环境限制"）。不改用户环境，只改本进程派生的子进程。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 渲染层产物目录（与 tauri.conf.json 的 frontendDist 同一处事实）。 */
export const RENDERER_DIR = "out/renderer";
/** sidecar 二进制所在目录（与 tauri.conf.json 的 externalBin 前缀一致）。 */
export const BINARIES_DIR = "src-tauri/binaries";

/**
 * 编排的三步（参数不含 shell：`npm run a && npm run b` 在 npm 的 script-shell 是 PowerShell 时
 * 语义会变，而且失败容易被吞；这里由 Node 逐步 spawn 并逐步查退出码）。
 */
export function backendSteps() {
  return [
    {
      id: "build:web",
      why: "渲染层产物只能由 vite build 生成（tauri 不会替你构建，见文件头）",
      command: process.execPath,
      args: ["node_modules/vite/bin/vite.js", "build"],
    },
    {
      id: "dist:sidecar",
      why: "sidecar 必须先于 tauri build：Tauri 只是**复制** externalBin，不会替你构建",
      command: process.execPath,
      args: ["scripts/build-sidecar.mjs"],
    },
    {
      id: "tauri:build",
      why: "最后才是 cargo 编译 + NSIS 打包（这一步会把上面两份产物嵌进/放进安装包）",
      command: process.execPath,
      args: ["node_modules/@tauri-apps/cli/tauri.js", "build"],
    },
  ];
}

/** 保持 BACKEND_STEPS 这个名字可用（外部按顺序断言编排）。 */
export const BACKEND_STEPS = backendSteps();

/**
 * cargo 的 target 目录（唯一真源是 `CARGO_TARGET_DIR`，没有才落回 `src-tauri/target`）。
 *
 * 相对值的基准是 `src-tauri`：cargo 是由 tauri CLI 在 `src-tauri` 下启动的。
 * CI 里给的是绝对路径（`${{ github.workspace }}/src-tauri/target`），这里两种都认。
 */
export function resolveTargetDir({ root = ROOT, env = process.env } = {}) {
  const configured = typeof env.CARGO_TARGET_DIR === "string" ? env.CARGO_TARGET_DIR.trim() : "";
  if (configured === "") return path.join(root, "src-tauri", "target");
  return path.isAbsolute(configured) ? configured : path.resolve(root, "src-tauri", configured);
}

/**
 * mtime 新鲜度检查的**判定**（纯函数，好测）。
 *
 * 规则只有一条：每个被打包进去的输入都必须**不晚于** exe。输入比 exe 新 = 这个 exe 里是旧东西。
 */
export function freshnessProblems({ appExe, rendererArtifacts }) {
  const problems = [];
  if (appExe === null || appExe === undefined || typeof appExe.mtimeMs !== "number") {
    problems.push("找不到主程序 exe：没有东西可以证明渲染层产物被打了进去");
  }
  if (!Array.isArray(rendererArtifacts) || rendererArtifacts.length === 0) {
    problems.push(`渲染层产物为空（${RENDERER_DIR}）：tauri build 会把一个空目录嵌进去，必须先跑 build:web`);
    return problems;
  }
  if (problems.length > 0) return problems;

  for (const artifact of rendererArtifacts) {
    if (typeof artifact.mtimeMs !== "number") {
      problems.push(`产物 ${artifact.path} 没有 mtime，无法判断新鲜度`);
      continue;
    }
    if (artifact.mtimeMs > appExe.mtimeMs) {
      problems.push(
        `${artifact.path} 比 ${appExe.path} 新（产物 ${new Date(artifact.mtimeMs).toISOString()} > ` +
          `exe ${new Date(appExe.mtimeMs).toISOString()}）：这个 exe 里不是这份产物`,
      );
    }
  }
  return problems;
}

/** 递归列出目录下的文件（暂存/产物目录都不深，够用）。 */
export async function listFiles(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      found.push(child);
    }
  };
  await walk(dir);
  return found;
}

/**
 * 真读盘做一次新鲜度检查。
 *
 * `extraInputs` 是"同样会被打进安装包"的其他产物（sidecar 二进制）——同一条规则管它们。
 */
export async function collectFreshnessProblems({ appExePath, rendererDir, extraInputs = [] }) {
  let appExe = null;
  try {
    const info = await stat(appExePath);
    appExe = { path: path.relative(ROOT, appExePath), mtimeMs: info.mtimeMs };
  } catch {
    appExe = { path: path.relative(ROOT, appExePath), mtimeMs: Number.NaN };
    return [`主程序不存在：${appExe.path}`];
  }

  let artifacts = [];
  try {
    const files = await listFiles(rendererDir);
    artifacts = await Promise.all(
      files.map(async (file) => ({ path: path.relative(ROOT, file), mtimeMs: (await stat(file)).mtimeMs })),
    );
  } catch {
    artifacts = [];
  }

  const inputs = [...artifacts];
  const problems = [];
  for (const extra of extraInputs) {
    try {
      inputs.push({ path: path.relative(ROOT, extra), mtimeMs: (await stat(extra)).mtimeMs });
    } catch {
      problems.push(`输入不存在（没有被 build 出来，也就不可能被打进安装包）：${path.relative(ROOT, extra)}`);
    }
  }
  return [...problems, ...freshnessProblems({ appExe, rendererArtifacts: inputs })];
}

/** 跑一步；继承 stdio（构建日志要看得见），返回退出码。 */
function runStep(step, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: ROOT, stdio: "inherit", env, shell: false });
    child.on("error", (cause) => reject(new Error(`${step.id} 起不来：${cause.message}`)));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * 主程序 exe 的名字主干：来自 `src-tauri/Cargo.toml` 的 `[[bin]] name`。
 *
 * **不是** `tauri.conf.json` 的 `productName`——那是显示名（`华为音乐第三方客户端`），
 * 用来做快捷方式与安装包文件名；cargo 产出的可执行文件叫 `huawei-music-desktop.exe`。
 * 2026-10-19 实测：`tauri build` 生成的 `installer.nsi` 里写的是
 * `!define MAINBINARYNAME "huawei-music-desktop"`、`File "/oname=hwmusic-core.exe"`，
 * 与 `target/release/` 暂存目录里的文件名一致。按 productName 去 stat 会 ENOENT——
 * 上一版就是这样把一次**成功**的打包判成了失败。
 */
export async function appBinaryStem(root = ROOT) {
  const cargo = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const binSection = /\[\[bin\]\]([\s\S]*?)(?=\n\s*\[|$)/.exec(cargo);
  const binName = binSection === null ? null : /^\s*name\s*=\s*"([^"]+)"/m.exec(binSection[1]);
  if (binName !== null) return binName[1];
  const pkgName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo);
  return pkgName === null ? "app" : pkgName[1];
}

/** 主程序 exe 名（暂存目录与 NSIS 脚本里的那个名字）。 */
export async function appExeName(root = ROOT) {
  return `${await appBinaryStem(root)}.exe`;
}

async function main() {
  const temp = path.join(ROOT, ".tmp/temp");
  await mkdir(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp };

  for (const step of backendSteps()) {
    console.log(`\n=== ${step.id} ===\n${step.why}`);
    const code = await runStep(step, env);
    if (code !== 0) {
      console.error(`\ndist:win 失败：${step.id} 退出码 ${code}（后面的步骤不再执行）`);
      process.exit(1);
    }
  }

  const targetDir = resolveTargetDir();
  const appExePath = path.join(targetDir, "release", await appExeName());
  const rendererDir = path.join(ROOT, RENDERER_DIR);
  // sidecar 产物名按三元组推导（不写死平台），与 build-sidecar.mjs 的命名同一处事实
  const sidecarBinaries = (await listFiles(path.join(ROOT, BINARIES_DIR)).catch(() => []))
    .filter((file) => /^hwmusic-core-.+\.exe$/.test(path.basename(file)))
    .sort();

  const problems = await collectFreshnessProblems({
    appExePath,
    rendererDir,
    extraInputs: sidecarBinaries,
  });
  if (sidecarBinaries.length !== 1) {
    problems.push(
      `externalBin 产物应当恰好一个（src-tauri/binaries/hwmusic-core-<triple>.exe），实际 ${sidecarBinaries.length} 个：` +
        `${JSON.stringify(sidecarBinaries.map((file) => path.relative(ROOT, file)))}`,
    );
  }

  const exeInfo = await stat(appExePath);
  console.log(
    `\n=== mtime 新鲜度检查 ===\n` +
      `exe      ${path.relative(ROOT, appExePath)}（${exeInfo.size} B，${new Date(exeInfo.mtimeMs).toISOString()}）\n` +
      `渲染层   ${RENDERER_DIR}（${(await listFiles(rendererDir)).length} 个产物）\n` +
      `sidecar  ${sidecarBinaries.map((file) => path.relative(ROOT, file)).join("、")}`,
  );

  if (problems.length > 0) {
    console.error("\ndist:win 失败：exe 里有比它更新的输入（旧界面/旧 sidecar 被嵌进去，且退出码本来是 0）");
    for (const problem of problems) console.error(`  ✖ ${problem}`);
    process.exit(1);
  }

  console.log(`dist:win 完成：${path.relative(ROOT, appExePath)} 里是最新产物（mtime 检查通过）`);
  console.log("提示：安装包与静态校验见 npm run check:nsis（不执行安装包）");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`dist:win 失败：${cause.message}`);
    process.exit(1);
  });
}
