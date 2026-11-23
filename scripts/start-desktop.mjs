import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { appExePath } from "./tauri-smoke.mjs";
import { stageDesktopRuntime } from "./desktop-runtime.mjs";

async function main() {
  const executable = await stageDesktopRuntime(await appExePath());
  const env = { ...process.env };
  delete env.HWMUSIC_SIDECAR_SCRIPT;
  delete env.HWMUSIC_NODE_BIN;
  const child = spawn(executable, [], { cwd: path.dirname(executable), env, detached: true, stdio: "ignore", windowsHide: false });
  await once(child, "spawn");
  child.unref();
  console.log(`桌面程序已启动（PID ${child.pid}）：${executable}`);
}

main().catch(cause => { console.error(`启动失败：${cause.message}；请先运行 npm run dist:win。`); process.exitCode = 1; });
