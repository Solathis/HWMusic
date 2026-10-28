#!/usr/bin/env node
/**
 * `npm run smoke:build`：把**真的打包产物**起一次，看主窗是不是真建起来了——前面几道闸只证明东西在、是 PE、比 exe 新，
 * 都不证明这个 exe 能起来（一启动就死在建窗那一步时打包链照样退出码 0）。
 * 三种结论绝不混为一谈：`PASS`=0（进程活着且主窗句柄非 0）、`FAIL`=1（进程自己死了或超时都没建出窗）、
 * `UNTESTED`=2（本机起不了交互式窗口，**不是通过**——把「本机测不了」写成 0 就是伪造验收）。
 * 隔离：`HWMUSIC_DATA_DIR` 指到 `.tmp/smoke-data`，冒烟不许碰用户真实的设置与会话文件。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 主程序 exe 名与 dist:win / check:nsis **同一处事实**（Cargo.toml 的 [[bin]] name）。
// 按 tauri.conf.json 的 productName 找会 ENOENT：那个是显示名，不是 cargo 产物名。
import { appExeName } from "./dist-win.mjs";

// 名字口径对外可见（测试要断言"三个脚本同一处事实"，而不是各读各的）
export { appExeName };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 冒烟用的数据目录（.gitignore 已含 .tmp/）。 */
export const SMOKE_DATA_DIR = ".tmp/smoke-data";

/** 三种结论（外部按它断言；2 不是通过）。 */
export const VERDICTS = { pass: "PASS", fail: "FAIL", untested: "UNTESTED" };

/**
 * 结束码约定：PASS 0 / FAIL 1 / UNTESTED 2。
 *
 * UNTESTED 单独一个码，是为了让调用方**不可能**把"没测"当成"过了"（`if ($LASTEXITCODE)` 就分开）。
 */
export function exitCodeFor(verdict) {
  if (verdict === VERDICTS.pass) return 0;
  if (verdict === VERDICTS.fail) return 1;
  return 2;
}

/** 汇总行（人读与 CI 断言同一处事实）。 */
export function formatSmokeSummary({ verdict, reason }) {
  return `smoke:build 结果：${verdict}（${reason}）`;
}

/** 主程序 exe 的路径（名字来自 Cargo.toml，目录来自 CARGO_TARGET_DIR）。 */
export async function appExePath({ root = ROOT, profile = "release" } = {}) {
  // 与 dist-win.mjs 的 resolveTargetDir 同一口径：CARGO_TARGET_DIR 是唯一真源，
  // 相对值的基准是 src-tauri（cargo 由 tauri CLI 在 src-tauri 下启动）。
  const configured = process.env.CARGO_TARGET_DIR?.trim() ?? "";
  const targetDir =
    configured === ""
      ? path.join(root, "src-tauri", "target")
      : path.isAbsolute(configured)
        ? configured
        : path.resolve(root, "src-tauri", configured);
  return path.join(targetDir, profile, await appExeName(root));
}

/**
 * 读进程的主窗句柄（Windows：`MainWindowHandle`）：只有真建了顶层窗口才非 0，进程活着但建窗失败时它是 0。
 * 读不到（没有 powershell）返回 `null`：那时只断言进程还活着，并在结论里写明 window 句柄没能查（不假称查过）。
 */
export function windowHandleOf(pid, { spawnSyncImpl = spawnSync } = {}) {
  const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).MainWindowHandle`;
  const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const value = Number.parseInt((result.stdout ?? "").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * stderr 里有没有「本机环境拒绝访问」的指纹：沙箱拒写 `%LOCALAPPDATA%` 的日志目录 → `os error 5` → panic 退出码 101。
 * **这不是产物坏了**，所以判 UNTESTED 而不是 FAIL；但指纹必须窄（只认拒绝访问这一类），否则任何崩溃都会被「环境」二字吃掉。
 */
export function environmentDenial(stderr) {
  const match = /os error 5|拒绝访问|Access is denied|access is denied/.exec(typeof stderr === "string" ? stderr : "");
  return match === null ? null : match[0];
}

/** stderr 的尾巴（结论里带一句原因就够，不要把整段 backtrace 塞进汇总行）。 */
export function stderrTail(stderr, limit = 240) {
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (text === "") return "（没有 stderr 输出：发布版是 windows 子系统，panic 也可能无处可写）";
  const flattened = text.replace(/\s+/g, " ");
  return flattened.length <= limit ? flattened : `…${flattened.slice(-limit)}`;
}

/** 判结论的纯函数（好测）：窗口/存活/环境三种输入 → 三种结论。 */
export function smokeVerdict({
  spawnFailed,
  alive,
  windowHandle,
  windowProbeAvailable,
  elapsedMs,
  timeoutMs,
  exitCode,
  stderr,
}) {
  if (spawnFailed) return { verdict: VERDICTS.untested, reason: `本机起不了进程：${spawnFailed}` };
  if (!alive) {
    const denial = environmentDenial(stderr);
    if (denial !== null) {
      return {
        verdict: VERDICTS.untested,
        reason: `进程退出码 ${exitCode}，原因是本机环境拒绝访问（${denial}）——不是通过：${stderrTail(stderr)}`,
      };
    }
    return {
      verdict: VERDICTS.fail,
      reason: `进程在冒烟窗口期内自己退出了（exit=${exitCode}）：${stderrTail(stderr)}`,
    };
  }
  if (windowProbeAvailable === false) {
    return {
      verdict: VERDICTS.pass,
      reason: `进程 ${elapsedMs}ms 后仍存活；本机查不到窗口句柄（未作窗口断言）`,
    };
  }
  if (windowHandle === 0) {
    return { verdict: VERDICTS.fail, reason: `到了 ${timeoutMs}ms 主窗句柄仍是 0：进程活着但窗口没建出来` };
  }
  return { verdict: VERDICTS.pass, reason: `主窗句柄 ${windowHandle}（${elapsedMs}ms）` };
}

/** 结束进程树（GUI 进程没有 stdin EOF 这种优雅退出方式）。 */
function killTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

async function main() {
  const profileIndex = process.argv.indexOf("--profile");
  const profile = profileIndex === -1 ? (process.env.HWMUSIC_SMOKE_PROFILE ?? "release") : (process.argv[profileIndex + 1] ?? "release");
  const exePath = await appExePath({ profile });

  try {
    await stat(exePath);
  } catch {
    console.error(
      `smoke:build FAIL：找不到 ${path.relative(ROOT, exePath)}——先跑 npm run dist:win（本机跑不了 tauri build 时如实记 untested，CI 是执行点）`,
    );
    process.exit(exitCodeFor(VERDICTS.fail));
  }

  const temp = path.join(ROOT, ".tmp/temp");
  const dataDir = path.join(ROOT, SMOKE_DATA_DIR);
  await mkdir(temp, { recursive: true });
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const env = { ...process.env, TEMP: temp, TMP: temp, HWMUSIC_DATA_DIR: dataDir };
  const timeoutMs = 20_000;
  const started = Date.now();
  // stderr 要接管道：发布版是 windows 子系统（没有控制台），但 panic 仍会写给**继承来的句柄**，
  // 不接住就只剩一个退出码 101，判不出"环境拒绝访问"和"产物真坏了"的区别。
  const child = spawn(exePath, [], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env, detached: false, windowsHide: false });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stderr += chunk;
  });

  let spawnFailed = null;
  child.on("error", (cause) => {
    spawnFailed = cause?.message ?? String(cause);
  });

  let alive = true;
  let exitInfo = { code: null, signal: null };
  child.on("exit", (code, signal) => {
    alive = false;
    exitInfo = { code, signal };
  });

  let windowHandle = null;
  let windowProbeAvailable = true;
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (spawnFailed !== null || !alive) break;
    const probe = windowHandleOf(child.pid);
    if (probe === null) {
      windowProbeAvailable = false;
      break;
    }
    if (probe !== 0) {
      windowHandle = probe;
      break;
    }
  }

  const elapsedMs = Date.now() - started;
  const { verdict, reason } = smokeVerdict({
    spawnFailed,
    alive: alive && spawnFailed === null,
    windowHandle,
    windowProbeAvailable,
    elapsedMs,
    timeoutMs,
    exitCode: exitInfo.code,
    stderr,
  });

  if (alive && child.pid !== undefined) killTree(child.pid);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});

  console.log(formatSmokeSummary({ verdict, reason }));
  if (exitInfo.code !== null && verdict !== VERDICTS.pass) {
    console.log(`      退出信息：code=${exitInfo.code} signal=${exitInfo.signal}`);
  }
  if (verdict === VERDICTS.untested) {
    console.log("      这是环境限制，**不是通过**：本机没验证到「窗口真的建起来了」这件事。");
  }
  if (verdict === VERDICTS.fail) {
    console.error(
      "提示：本机（沙箱）起不了交互式窗口时应当是 UNTESTED(2) 而不是 FAIL——先看上面这条原因属于哪一种。",
    );
  }
  process.exit(exitCodeFor(verdict));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`smoke:build 失败：${cause.message}`);
    process.exit(1);
  });
}
