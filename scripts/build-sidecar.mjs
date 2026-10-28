#!/usr/bin/env node
/**
 * `npm run dist:sidecar`：把 Node sidecar 打成单文件 SEA 二进制（`src-tauri/binaries/hwmusic-core-<triple>.exe`）。
 * 两层 esbuild：SEA 只支持 CJS，入口又用了顶层 await（代理须先于业务请求装好），`--format=cjs` 报错——先包 shim 用 ESM 打包再转 CJS。
 * 自验证：注入成功不等于能跑（`SHA` 相同就是没注入），须真跑产物，`memory-only`/`secure` 各一条；断言只碰结论。
 * 只给工作区内可删范围：子进程用默认 `%TEMP%` 会失败（`Access is denied`），故把 `TEMP`/`TMP` 指向 `.tmp/temp`（只在进程内）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

import { createBridge } from "../src/host/bridge.mjs";

const require = createRequire(import.meta.url);

/** 仓库根（脚本在 scripts/ 下）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** sidecar 二进制的名字主干；与 Rust `sidecar.rs`、`tauri.conf.json` 的 externalBin 同一处事实。 */
export const SIDECAR_STEM = "hwmusic-core";
/** Tauri 的 externalBin 目录。 */
export const BINARIES_DIR = "src-tauri/binaries";
/** sidecar 的入口脚本（SEA 打包的起点）。 */
export const SIDECAR_ENTRY = "src/sidecar/main.mjs";
/** 中间产物目录（.gitignore 已含 .tmp/）。 */
export const WORK_DIR = ".tmp/sidecar";
/** SEA 的资源名（Node 的 postject 注入约定）。 */
export const SEA_BLOB_RESOURCE_NAME = "NODE_SEA_BLOB";
/** SEA 的熔丝：Node 启动时按它判断"这个可执行文件里嵌了 SEA blob"。 */
export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** 平台/架构 → Rust 目标三元组（Tauri 的 externalBin 命名用它）。 */
const TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/**
 * 当前平台的目标三元组。
 *
 * 不认识的组合**抛错**：猜一个三元组只会让 Tauri 在打包时找不到 externalBin（报错点离这里很远）。
 */
export function hostTriple(platform = process.platform, arch = process.arch) {
  const triple = TRIPLES[`${platform}-${arch}`];
  if (triple === undefined) {
    throw new Error(
      `不支持的平台组合 ${platform}-${arch}：没有已知的目标三元组（本仓只在 Windows 上打包，见 docs/RUN_AND_PACKAGING.md）`,
    );
  }
  return triple;
}

/** externalBin 的产物名：`hwmusic-core-<triple>.exe`。 */
export function sidecarBinaryName(triple, platform = process.platform) {
  return `${SIDECAR_STEM}-${triple}${platform === "win32" ? ".exe" : ""}`;
}

/**
 * 两层 esbuild 的参数（第一层 ESM、第二层 CJS）。
 *
 * 只把 `node:*` 留作外部：SEA 进程里没有 node_modules，任何漏进去的外部依赖都会在启动时炸。
 */
export function esbuildPasses() {
  return [
    {
      entryPoints: [`${WORK_DIR}/sidecar-shim.mjs`],
      outfile: `${WORK_DIR}/bundle.esm.mjs`,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["node:*"],
      logLevel: "warning",
      legalComments: "inline",
    },
    {
      entryPoints: [`${WORK_DIR}/bundle.esm.mjs`],
      outfile: `${WORK_DIR}/bundle.cjs`,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["node:*"],
      logLevel: "warning",
      legalComments: "inline",
    },
  ];
}

/** 双模式自验证的用例表；`secure` 预置信封是因为没有 `session.enc` 时 `loadMusicSession` 在读文件那步就返回 `null`，DPAPI 那条路就走不到。 */
export function selfCheckModes({ dataDir, cipher = "R14-self-check-cipher", plaintext = '{"musicSession":"r14"}' } = {}) {
  return [
    {
      id: "memory-only",
      title: "没有数据目录：会话只留内存",
      args: [],
      sessionFile: null,
      expectStderr: /没有数据目录/,
      expectHostChannel: null,
    },
    {
      id: "secure",
      title: "有数据目录：DPAPI 信封经宿主要求解回来",
      args: ["--data-dir", dataDir],
      sessionFile: {
        name: "session.enc",
        contents: `${JSON.stringify({ schemaVersion: 1, cipher })}\n`,
      },
      hostReply: { plaintext },
      expectStderr: /登录状态恢复：已登录/,
      expectHostChannel: "host:secure-decrypt",
    },
  ];
}

/** 文件（或缓冲区）的 SHA256 十六进制。 */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** 打包链自己用工作区内的临时目录（沙箱只给工作区内的可删范围，见文件头）。 */
async function useWorkspaceTemp() {
  const temp = path.join(ROOT, ".tmp/temp");
  await mkdir(temp, { recursive: true });
  process.env.TEMP = temp;
  process.env.TMP = temp;
  return temp;
}

/** 第一层的 shim（生成物，不入库）：顶层 await 靠它落进异步闭包。 */
function shimSource(entryRelative) {
  const target = entryRelative.startsWith(".") ? entryRelative : `./${entryRelative}`;
  return [
    "// 由 scripts/build-sidecar.mjs 生成（不入库）。",
    "// SEA 的嵌入入口只支持 CJS，而真入口用了顶层 await —— 动态 import 让 esbuild",
    "// 把真入口包成 __esm(async () => …)，第二层才能转 CJS。",
    `import(${JSON.stringify(target)}).catch((cause) => {`,
    '  console.error("[hwmusic-core] 启动失败：", cause);',
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

/** 跑一层 esbuild；失败直接抛（构建链任何一步失败都不许静默）。 */
async function bundle(pass) {
  const options = { ...pass, absWorkingDir: ROOT };
  const result = await esbuild.build(options);
  if (result.errors.length > 0) {
    throw new Error(`esbuild 打包失败（${pass.outfile}）：${JSON.stringify(result.errors)}`);
  }
  return result;
}

/** 一次子进程调用；把 stdout/stderr 带回来，非 0 抛错。 */
export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  const printable = `${command} ${args.join(" ")}`;
  if (result.error) throw new Error(`${printable} 起不来：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${printable} 退出码 ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 真跑一次产物，断言「结论」而非「实现」：`settings:get` 回 ok、该模式 stderr 结论行、宿主通道是否真走过、stdin EOF 后干净退出、无未捕获异常。 */
export async function runSelfCheck({ exePath, mode, root = ROOT, timeoutMs = 15_000 }) {
  const dataDir = mode.args[1] ?? null;
  if (dataDir !== null) {
    await mkdir(dataDir, { recursive: true });
    if (mode.sessionFile !== null) {
      await writeFile(path.join(dataDir, mode.sessionFile.name), mode.sessionFile.contents, "utf8");
    }
  }

  // 进程内环境旋钮必须清掉：`HWMUSIC_DATA_DIR` 会把 memory-only 模式变成 secure 模式
  const env = { ...process.env };
  delete env.HWMUSIC_DATA_DIR;

  const child = spawn(exePath, mode.args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], env });
  const problems = [];
  const frames = [];
  const hostRequests = [];
  let stderr = "";
  let raw = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    raw += chunk;
    for (;;) {
      const newline = raw.indexOf("\n");
      if (newline === -1) break;
      const line = raw.slice(0, newline).trim();
      raw = raw.slice(newline + 1);
      if (line === "") continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        problems.push(`stdout 出现非法帧（协议被污染）：${line.slice(0, 120)}`);
      }
    }
  });

  const bridge = createBridge({
    readable: child.stdout,
    writable: child.stdin,
    timeoutMs,
    onProtocolError: (problem) => problems.push(`协议异常：${JSON.stringify(problem)}`),
  });

  // 假装成宿主：DPAPI 解密那条路回一个明文会话；其余坦白"这里没有真宿主"
  bridge.onRequest((request, respond) => {
    hostRequests.push(request.channel);
    if (mode.expectHostChannel !== null && request.channel === mode.expectHostChannel && mode.hostReply) {
      respond({ ok: true, data: mode.hostReply });
      return;
    }
    respond({ ok: false, error: { message: "R14 自验证没有真宿主", kind: "core_gone" } });
  });

  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  const failures = [];
  try {
    const answer = await bridge.call("settings:get", {});
    if (answer?.ok !== true) failures.push(`settings:get 没有成功答复：${JSON.stringify(answer)}`);
  } catch (cause) {
    failures.push(`settings:get 没走通：${cause.message}`);
  }

  // 启动期恢复是**异步**的：它要经宿主解一个信封（secure 模式），所以关 stdin 之前必须等到它的结论广播，
  // 否则收尸会把在途的宿主要求判成「宿主没答复」，自验证就变成了「验收尸」而不是「验解密链路」。
  const status = await waitFor(
    () => frames.find((frame) => frame.id === undefined && frame.channel === "auth:status" && frame.payload?.busy === false),
    timeoutMs,
  );
  child.stdin.end();
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);

  if (code !== 0) failures.push(`stdin EOF 后没有干净退出（code=${code}）`);
  if (!mode.expectStderr.test(stderr)) {
    failures.push(`stderr 缺少该模式的结论（期望 ${mode.expectStderr}）：${stderr.trim().slice(0, 400)}`);
  }
  if (mode.expectHostChannel !== null && !hostRequests.includes(mode.expectHostChannel)) {
    failures.push(`宿主通道 ${mode.expectHostChannel} 没有被走到（收到的宿主要求：${JSON.stringify(hostRequests)}）`);
  }
  if (/未捕获异常|启动失败/.test(stderr)) {
    failures.push(`stderr 出现未捕获异常：${stderr.trim().slice(-400)}`);
  }
  failures.push(...problems);

  const authStatus = status;
  if (mode.id === "secure" && authStatus?.payload?.loggedIn !== true) {
    failures.push(`secure 模式没有恢复出登录状态：${JSON.stringify(authStatus)}`);
  }
  if (mode.id === "memory-only" && authStatus?.payload?.loggedIn !== false) {
    failures.push(`memory-only 模式不该有登录状态：${JSON.stringify(authStatus)}`);
  }

  return { id: mode.id, ok: failures.length === 0, failures, hostRequests, stderr, frames };
}

/** 等一个条件成立（轮询；超时返回 undefined，由调用方判失败）。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = predicate();
    if (found !== undefined && found !== null) return found;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 生成 SEA blob 配置（`main` 是第二层的 CJS 包体）。 */
export function seaConfig({ mainPath, blobPath }) {
  return {
    main: mainPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
}

async function main() {
  await useWorkspaceTemp();
  const workDir = path.join(ROOT, WORK_DIR);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const triple = hostTriple();
  const binaryName = sidecarBinaryName(triple);
  const exePath = path.join(ROOT, BINARIES_DIR, binaryName);

  // —— 两层打包 ——
  const entryRelative = path
    .relative(workDir, path.join(ROOT, SIDECAR_ENTRY))
    .split(path.sep)
    .join("/");
  await writeFile(path.join(workDir, "sidecar-shim.mjs"), shimSource(entryRelative), "utf8");
  const passes = esbuildPasses();
  for (const pass of passes) await bundle(pass);
  console.log(`打包：${SIDECAR_ENTRY} → ${passes[0].outfile}（ESM）→ ${passes[1].outfile}（CJS，SEA 入口只认 CJS）`);

  // —— SEA blob ——
  const blobPath = path.join(workDir, "sea-prep.blob");
  const configPath = path.join(workDir, "sea-config.json");
  const bundlePath = path.join(ROOT, passes[1].outfile);
  await writeFile(
    configPath,
    `${JSON.stringify(seaConfig({ mainPath: bundlePath, blobPath }), null, 2)}\n`,
    "utf8",
  );
  runSync(process.execPath, ["--experimental-sea-config", configPath]);

  // —— 注入到 node.exe 的副本 ——
  await mkdir(path.dirname(exePath), { recursive: true });
  await copyFile(process.execPath, exePath);
  const { inject } = require("postject");
  await inject(exePath, SEA_BLOB_RESOURCE_NAME, await readFile(blobPath), { sentinelFuse: SEA_FUSE });

  // —— 负向对照：SHA 必须异于原 node.exe（相同 = blob 没进去，或注到了别处）——
  const nodeSha = sha256(await readFile(process.execPath));
  const exeSha = sha256(await readFile(exePath));
  if (nodeSha === exeSha) {
    throw new Error("产物 SHA256 与 node.exe 完全相同：blob 没有注入成功（postject 静默失败或写到了别的文件）");
  }
  const [nodeSize, exeSize] = [(await stat(process.execPath)).size, (await stat(exePath)).size];
  if (exeSize <= nodeSize) {
    throw new Error(`产物比 node.exe 还小（${exeSize} ≤ ${nodeSize}）：blob 不可能在里`);
  }
  console.log(
    `注入：${BINARIES_DIR}/${binaryName}（${exeSize} B；node.exe ${nodeSize} B）\n` +
      `      SHA256 ${exeSha}\n` +
      `      node  ${nodeSha}（必须不同：负向对照）`,
  );

  // —— 双模式自验证 ——
  const dataDir = path.join(ROOT, ".tmp/self-check-data");
  await rm(dataDir, { recursive: true, force: true });
  const results = [];
  for (const mode of selfCheckModes({ dataDir })) {
    const result = await runSelfCheck({ exePath, mode });
    results.push(result);
    console.log(`自验证 ${mode.id}（${mode.title}）：${result.ok ? "PASS" : "FAIL"}`);
    for (const failure of result.failures) console.log(`      ✖ ${failure}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(`SEA 自验证失败 ${failed.length} 项（${failed.map((result) => result.id).join("、")}）`);
  }

  console.log(`dist:sidecar 完成：自验证 PASS ${results.length}/2（memory-only、secure）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`dist:sidecar 失败：${cause.message}`);
    process.exit(1);
  });
}
