/**
 * hwmusic-core：sidecar 入口编排。启动顺序：定数据目录 → 读设置 → 装配代理 → 建调度器/桥 → 装配登录链路 → 恢复会话。
 * `process.stdout` 是协议通道：只写 NDJSON 帧，日志与报错一律走 stderr。
 * 入向请求按频道白名单路由，出向宿主要求与广播都已接好。
 * 代理必须先于一切业务请求装好，否则第一批请求会直连；test/proxy.test.mjs 用源码顺序扫描钉死这条。
 * stdin EOF → 收尸并 exit(0)：宿主退出会关掉我们的 stdin，我们退出会关掉 stdout。
 */
import { createBridge } from "../host/bridge.mjs";
import { createDispatcher } from "../host/dispatcher.mjs";
import { createLibraryHandlers } from "../host/library-handlers.mjs";
import { createLyricsHandlers } from "../host/lyrics-handlers.mjs";
import { createPlaybackHandlers } from "../host/playback-handlers.mjs";
import { createProxyHandlers } from "../host/proxy-handlers.mjs";
import { createRpc } from "../host/rpc.mjs";
import { createHostServices } from "../host/host-services.mjs";
import { createAuthManager } from "../main/auth-manager.ts";
import { dataDirFromArgv } from "../main/data-dir.mjs";
import { createLoginHost } from "../main/huawei.ts";
import { createLyricsCache } from "../main/lyrics-cache.mjs";
import { createThirdPartyLyrics } from "../main/lyrics-fallback.mjs";
import { createLocalLyricsResolver } from "../main/local-lyrics.mjs";
import { createMusicService } from "../main/music-service.mjs";
import { applyStartupProxy, testProxyConnection } from "../main/proxy.mjs";
import { createMusicSessionVerifier } from "../main/session-verifier.mjs";
import { createSessionStore } from "../main/session-store.mjs";
import {
  dataDirSource,
  readSessionFileState,
  sessionDiagnosticLine,
} from "../main/session-diagnostic.mjs";
import { createSettingsHandlers, createSettingsStore } from "../main/settings.mjs";
import { APP_NOTICE } from "../shared/channels.ts";
import {
  AUTH_CANCEL_LOGIN,
  AUTH_CANCEL_QR,
  AUTH_GET_STATUS,
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_QR_START,
  HOST_LOCAL_LYRICS_SOURCE,
  REQUEST_CHANNELS,
  SETTINGS_GET,
  SETTINGS_SET,
} from "../shared/request-channels.ts";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 各请求频道的实现任务：按前缀归类，避免在入口里再抄一份频道名清单。 */
function implementedBy(channel) {
  if (channel.startsWith("auth:")) return "R7 登录链路";
  if (channel.startsWith("settings:")) return "R6 设置与统一代理";
  if (channel.startsWith("library:")) return "R8 主界面";
  if (channel.startsWith("playback:")) return "R9 播放器";
  if (channel.startsWith("lyrics:")) return "R41 歌词体系";
  return "后续任务";
}

/** 日志只走 stderr，每行形如 `[hwmusic-core][<级别>] 正文`，宿主按这个标记把每行分档写入同一个日志文件。 */
const LOG_PREFIX = "[hwmusic-core]";
const log = (...parts) => {
  console.error(`${LOG_PREFIX}[info]`, ...parts);
};
log.warn = (...parts) => {
  console.error(`${LOG_PREFIX}[warn]`, ...parts);
};
log.error = (...parts) => {
  console.error(`${LOG_PREFIX}[error]`, ...parts);
};

/** 没有数据目录时的会话存储替身：每个动作都结构化报错，不回退到 cwd，也不静默当作「没有会话」。 */
function unavailableSessionStore() {
  const fail = () => {
    const error = new Error(
      "没有数据目录（宿主未传 --data-dir）：登录会话无法落盘，这是环境问题而不是「未登录」",
    );
    error.kind = CORE_ERROR_KINDS.internal;
    throw error;
  };
  return { saveMusicSession: fail, loadMusicSession: fail, clearMusicSession: fail };
}

// —— 启动装配：数据目录 → 设置 → 代理（顺序是硬要求，见文件头说明）——
const dataDir = dataDirFromArgv(process.argv.slice(2));
const settingsStore = createSettingsStore({ dir: dataDir, log });
const settings = await settingsStore.read();
const startupProxy = applyStartupProxy({ settings, env: process.env, log });

const dispatcher = createDispatcher({
  onHandlerError: ({ channel, error }) => log.error(`频道 ${channel} 处理失败：`, error),
});

const settingsHandlers = createSettingsHandlers({ store: settingsStore });
dispatcher.register(SETTINGS_GET, settingsHandlers.get);
dispatcher.register(SETTINGS_SET, async (request) => {
  const answer = await settingsHandlers.set(request);
  // 代理改动已落盘，但需重启应用才生效，这里再记一条日志备查。
  if (answer.ok === true && answer.data?.restartRequired === true) {
    log("代理设置已保存：sidecar 侧需重启应用后生效");
  }
  return answer;
});

// 库页面数据通道：默认端点表可被设置里的 `data.musicEndpoints` 逐键覆盖或显式关闭（`null`）。
// 会话用取值函数而不是快照（装配早于 `authManager`）；歌词两处端口都在数据根下：`lyricsCache` 与 `lyricsFallback`。
let musicSessionSource = null;
const lyricsCache = createLyricsCache({ dir: dataDir, log });
const lyricsFallback = createThirdPartyLyrics({ log });
const musicService = createMusicService({
  settingsData: settings.data,
  session: () => (musicSessionSource === null ? null : musicSessionSource()),
  // 协议层的诊断口，只记键名：歌词回落到「按专辑补索引」时记下播放响应的键名。
  log,
  lyricsCache,
  lyricsFallback,
});
for (const [channel, handler] of Object.entries(createLibraryHandlers({ api: musicService.api }))) {
  dispatcher.register(channel, handler);
}

// 歌词体系三条管理频道：`lyrics:import`（导入本地）、`lyrics:cache-info`（磁盘占用）、`lyrics:cache-clear`（清缓存）。
// 三件事都经同一个 music api，处理器不自己拿 fs。
for (const [channel, handler] of Object.entries(createLyricsHandlers({ api: musicService.api }))) {
  dispatcher.register(channel, handler);
}

// 播放地址通道：`playback:resolve-url` 拿的是当次播放地址，原样放进应答，不写日志、不落盘。
// `local:` 曲目的歌词走本地那一链，宿主要求口用惰性引用 `rpc`（装配在它之前、调用在之后）。
const localLyrics = createLocalLyricsResolver({
  cache: lyricsCache,
  localLyricsSource: (payload) => rpc.callHost(HOST_LOCAL_LYRICS_SOURCE, payload),
  log: (text) => log(text),
});
for (const [channel, handler] of Object.entries(createPlaybackHandlers({ api: musicService.api, localLyrics }))) {
  dispatcher.register(channel, handler);
}

// 设置页的「测试连接」用独立 ProxyAgent，绝不换掉全局 dispatcher：测试连接不该改掉整个进程的出口。
// 凭据只经这条路出去，不写日志。
for (const [channel, handler] of Object.entries(createProxyHandlers({ testProxy: testProxyConnection }))) {
  dispatcher.register(channel, handler);
}

const bridge = createBridge({
  readable: process.stdin,
  writable: process.stdout,
  onProtocolError: (problem) => log.error("协议异常：", problem),
});

const rpc = createRpc({ bridge, dispatcher });

// 出向宿主要求：这里只接线，不主动发起。
const hostServices = createHostServices({
  callHost: (channel, payload, options) => rpc.callHost(channel, payload, options),
});

// 登录链路：会话存储（DPAPI 信封）→ 登录宿主端口 → 认证状态机；排在 rpc/hostServices 之后，它要开登录窗、要广播状态。
// 它不在任何业务请求之前，代理先装好仍是启动顺序的前提。
const sessionStore =
  dataDir === null
    ? unavailableSessionStore()
    : createSessionStore({
        dir: dataDir,
        secureEncrypt: hostServices.secureEncrypt,
        secureDecrypt: hostServices.secureDecrypt,
        log,
      });

// 会话验证器：`createAuthManager` 的 `verifySession` 插座，登录换会话后与启动恢复后各判一次会话是否还有效。
// 会话来源按调用时取（赋值在 `createAuthManager` 之后），且用「本次要验的那个会话」再装配一份 music api。
const verifySession = createMusicSessionVerifier({
  createApi: (sessionSource) =>
    createMusicService({ settingsData: settings.data, session: sessionSource }).api,
  sessionSource: () => (musicSessionSource === null ? null : musicSessionSource()),
});

const authManager = createAuthManager({
  host: createLoginHost({ hostServices, log }),
  sessionStore,
  verifySession,
  broadcast: (channel, payload) => rpc.broadcast(channel, payload),
  notify: (text) => {
    log(`提示：${text}`);
    rpc.broadcast(APP_NOTICE, { text });
  },
  log,
});

// 音乐业务的会话来源（`currentSession()` 是内存里的活会话；登录/登出/恢复都会更新它）。
musicSessionSource = () => authManager.currentSession().session;

// `auth:login` 是长轮询：这里立刻回「已受理」，真正的结论经 `auth:status` 广播送达。
dispatcher.register(AUTH_LOGIN, (request, respond) => {
  respond(ok({ started: true, ...authManager.status() }));
  void authManager
    .login()
    .then((result) => {
      if (result !== null && typeof result === "object" && result.ok === false) {
        log(`登录未完成：${result.error.message}（已通过 auth:status 广播告知渲染层）`);
      }
    })
    .catch((cause) => {
      // auth-manager 自己会把意外抛出收成结构化失败，这里只是最后一道兜底
      log.error("登录过程抛出未预期异常：", cause);
    });
  return undefined;
});
dispatcher.register(AUTH_LOGOUT, () => authManager.logout());
dispatcher.register(AUTH_CANCEL_LOGIN, () => authManager.cancelLogin());

// 二维码登录：引导页自动调用，应答带回二维码内容与有效期，状态变化走 `auth:qr` 广播，轮询在 sidecar 里跑。
dispatcher.register(AUTH_QR_START, () => authManager.startQrLogin());

// 门禁收场时停掉这张码（渲染层那一半）：`announce` 只管"谁变成了已登录"，
// 这条管"渲染层不再需要这张码了"（切主界面 / 卸载）。
dispatcher.register(AUTH_CANCEL_QR, () => authManager.cancelQrLogin());

// 登录状态重查：`auth:status` 只在启动时播一次，渲染层 reload 之后就收不到了。
// 让渲染层每次 boot 主动问一次，应答与广播同形状，且不再播广播。
dispatcher.register(AUTH_GET_STATUS, () => ok(authManager.statusSnapshot()));

for (const channel of REQUEST_CHANNELS) {
  if (dispatcher.handlers().includes(channel)) continue;
  dispatcher.register(channel, () =>
    err(`请求频道 ${channel} 尚未实现（由${implementedBy(channel)}实现）`, CORE_ERROR_KINDS.unimplemented),
  );
}

// 启动恢复：读会话 → 验证 → 广播 auth:status（渲染层门禁靠它决定显示哪一层）。
// 渲染层此刻可能还没订阅：Rust 侧的 NoticeQueue 会排队，就绪即冲刷（不会丢掉"已登录"这个事实）。
const restored = await authManager.restore();
log(
  `登录状态恢复：${restored.loggedIn ? "已登录" : "未登录"}（${restored.reason}` +
    `${restored.verified ? "" : "，未验证"}${restored.error ? `；${restored.error.message}` : ""}）`,
);

// 启动诊断：一行看全数据根、它的来源、根里有没有 session.enc 与恢复档位。
// 只查存在性、不读内容（信封里是凭据密文），用于排查「每次重启都要重登」。
log(
  sessionDiagnosticLine({
    dataDir,
    source: dataDirSource(process.argv.slice(2)),
    sessionFile: await readSessionFileState(dataDir),
    restore: restored,
  }),
);

// 启动提示：代理是"环境变量兜底"来的（或环境变量写坏了被忽略），用户必须看得见——
// 没人希望流量悄悄换了出口。桥已就绪才广播，发不出去也要留痕，不静默。
if (startupProxy.notice !== null) {
  const announced = rpc.broadcast(APP_NOTICE, { text: startupProxy.notice });
  if (!announced.ok) log.warn(`启动提示未能广播：${announced.error.message}`);
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
  log.error("未捕获异常：", cause);
  flushAndExit(1);
});

process.on("unhandledRejection", (cause) => {
  log.error("未处理的 promise 拒绝：", cause);
});

log(
  `已就绪（帧协议 v1；入向请求频道 ${rpc.channels().length} 条；` +
    `出向宿主要求 ${Object.keys(hostServices).length} 个封装 / ${rpc.hostChannels().length} 条白名单；` +
    `代理 ${startupProxy.applied ? `${startupProxy.source} ${startupProxy.uri}` : "未启用（直连）"}）`,
);
