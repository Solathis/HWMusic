/**
 * hwmusic-core：sidecar 入口编排（R3 最小实现；R6 接上设置与统一代理）。
 *
 * 职责边界：
 * - `process.stdout` 是协议通道：只写 NDJSON 帧，任何日志/报错一律走 stderr；
 * - 入向请求按频道白名单路由（src/shared/request-channels.ts）：`settings:*` 由 R6 实现，
 *   其余仍如实回 `{kind:"unimplemented"}`（auth:* 归 R7）；
 * - 出向宿主要求（host-services）与出向广播（`app:notice`）都已接好；
 * - **启动顺序**：定数据目录 → 读设置 → **装配代理** → 建调度器/桥。
 *   代理必须先于一切业务请求装好（R7 的 AuthManager.restore 就在其列），否则第一批请求会直连；
 *   test/proxy.test.mjs 用源码顺序扫描把这条钉死；
 * - **协议依赖**：stdin EOF → 收尸并 exit(0)。双向收尸不依赖单侧 kill：
 *   宿主退出会关掉我们的 stdin，我们退出会关掉 stdout（宿主侧帧泵 EOF → CoreGone）。
 */
import { createBridge } from "../host/bridge.mjs";
import { createDispatcher } from "../host/dispatcher.mjs";
import { createRpc } from "../host/rpc.mjs";
import { createHostServices } from "../host/host-services.mjs";
import { dataDirFromArgv } from "../main/data-dir.mjs";
import { applyStartupProxy } from "../main/proxy.mjs";
import { createSettingsHandlers, createSettingsStore } from "../main/settings.mjs";
import { APP_NOTICE } from "../shared/channels.ts";
import { REQUEST_CHANNELS, SETTINGS_GET, SETTINGS_SET } from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err } from "../shared/result.ts";

/** 各请求频道的实现任务：按前缀归类，避免在入口里再抄一份频道名清单。 */
function implementedBy(channel) {
  if (channel.startsWith("auth:")) return "R7 登录链路";
  if (channel.startsWith("settings:")) return "R6 设置与统一代理";
  return "后续任务";
}

/** 日志只走 stderr。 */
const log = (...parts) => {
  console.error("[hwmusic-core]", ...parts);
};

// —— 启动装配：数据目录 → 设置 → 代理（顺序是硬要求，见文件头说明）——
const dataDir = dataDirFromArgv(process.argv.slice(2));
const settingsStore = createSettingsStore({ dir: dataDir, log });
const settings = await settingsStore.read();
const startupProxy = applyStartupProxy({ settings, env: process.env, log });

const dispatcher = createDispatcher({
  onHandlerError: ({ channel, error }) => log(`频道 ${channel} 处理失败：`, error),
});

const settingsHandlers = createSettingsHandlers({ store: settingsStore });
dispatcher.register(SETTINGS_GET, settingsHandlers.get);
dispatcher.register(SETTINGS_SET, async (request) => {
  const answer = await settingsHandlers.set(request);
  // 代理改动落盘了，但它要重启才生效（sidecar 的全局 dispatcher 只在启动时装配一次）：
  // 回执里的 restartRequired 就是给 R10 的生效说明用的，这里再记一条日志备查。
  if (answer.ok === true && answer.data?.restartRequired === true) {
    log("代理设置已保存：sidecar 侧需重启应用后生效");
  }
  return answer;
});

for (const channel of REQUEST_CHANNELS) {
  if (dispatcher.handlers().includes(channel)) continue;
  dispatcher.register(channel, () =>
    err(`请求频道 ${channel} 尚未实现（由${implementedBy(channel)}实现）`, CORE_ERROR_KINDS.unimplemented),
  );
}

const bridge = createBridge({
  readable: process.stdin,
  writable: process.stdout,
  onProtocolError: (problem) => log("协议异常：", problem),
});

const rpc = createRpc({ bridge, dispatcher });

// 出向宿主要求：R3 只接线，不主动发起（R5/R7 起通过 hostServices.notify/openLogin/secure* 使用）。
const hostServices = createHostServices({
  callHost: (channel, payload, options) => rpc.callHost(channel, payload, options),
});

// 启动提示：代理是"环境变量兜底"来的（或环境变量写坏了被忽略），用户必须看得见——
// 没人希望流量悄悄换了出口。桥已就绪才广播，发不出去也要留痕，不静默。
if (startupProxy.notice !== null) {
  const announced = rpc.broadcast(APP_NOTICE, { text: startupProxy.notice });
  if (!announced.ok) log(`启动提示未能广播：${announced.error.message}`);
}

let shuttingDown = false;

/**
 * 退出前把 stdout 冲干净：对管道而言 stdout 是异步写入，
 * 直接 process.exit 会截断还没落到管道里的响应帧（宿主侧就成了"永久 pending"）。
 */
function flushAndExit(code) {
  const guard = setTimeout(() => process.exit(code), 500);
  guard.unref();
  if (process.stdout.writableLength === 0) {
    process.exit(code);
    return;
  }
  process.stdout.write("", () => process.exit(code));
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason}：收尸退出`);
  rpc.shutdown(reason);
  flushAndExit(0);
}

process.stdin.on("end", () => shutdown("stdin EOF"));
process.stdin.on("close", () => shutdown("stdin 关闭"));

process.on("uncaughtException", (cause) => {
  log("未捕获异常：", cause);
  flushAndExit(1);
});

process.on("unhandledRejection", (cause) => {
  log("未处理的 promise 拒绝：", cause);
});

log(
  `已就绪（帧协议 v1；入向请求频道 ${rpc.channels().length} 条；` +
    `出向宿主要求 ${Object.keys(hostServices).length} 个封装 / ${rpc.hostChannels().length} 条白名单；` +
    `代理 ${startupProxy.applied ? `${startupProxy.source} ${startupProxy.uri}` : "未启用（直连）"}）`,
);
