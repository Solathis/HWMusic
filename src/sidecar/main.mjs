/**
 * hwmusic-core：sidecar 入口编排（R3 最小实现；R6 接上设置与统一代理；R7 接上登录链路）。
 *
 * 职责边界：
 * - `process.stdout` 是协议通道：只写 NDJSON 帧，任何日志/报错一律走 stderr；
 * - 入向请求按频道白名单路由（src/shared/request-channels.ts）：`settings:*` 由 R6 实现，
 *   `auth:*` 由 R7 实现（`auth:login` 会一直等到登录窗收场，但**不阻塞**别的请求：
 *   等的是桥上的 pending，调度器与帧泵照常跑）；
 * - 出向宿主要求（host-services）与出向广播（`app:notice` / `auth:status`）都已接好；
 * - **启动顺序**：定数据目录 → 读设置 → **装配代理** → 建调度器/桥 → 装配登录链路 → 恢复会话。
 *   代理必须先于一切业务请求装好（R7 的 AuthManager.restore 就在其列），否则第一批请求会直连；
 *   test/proxy.test.mjs 用源码顺序扫描把这条钉死；
 * - **协议依赖**：stdin EOF → 收尸并 exit(0)。双向收尸不依赖单侧 kill：
 *   宿主退出会关掉我们的 stdin，我们退出会关掉 stdout（宿主侧帧泵 EOF → CoreGone）。
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
  AUTH_GET_STATUS,
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_QR_START,
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

/** 日志只走 stderr。 */
const log = (...parts) => {
  console.error("[hwmusic-core]", ...parts);
};

/**
 * 没有数据目录时的会话存储替身：每个动作都结构化报错。
 *
 * 刻意**不回退到 cwd**（打包后当前目录不可预测，可能只读），也刻意不"静默当作没有会话"：
 * 读不出来是一件事，"从来没登录过"是另一件事，用户看到的状态必须区分开。
 */
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

// —— 库页面数据通道（R8；R32 换血：默认端点表 + 会话注入；R41 接上歌词缓存与第三方回退）——
//
// 端点：默认值 = 参考实现的实测端点（`src/main/music-service.mjs` 的 `MUSIC_ENDPOINT_DEFAULTS`），
// 设置文档 `data.musicEndpoints` 可逐键覆盖或显式关闭（`null`）。
// 会话：**取值函数**而不是快照——这段装配发生在 `authManager` 之前，而会话要等登录/恢复之后才有。
// 没有会话时协议层如实回 `session_required`（"先登录"），绝不拿匿名请求冒充"你的库是空的"。
//
// R41 的两个歌词端口（都在**数据根**下，数据根来自宿主的 `--data-dir`；没有数据根时缓存如实报
// "不可用"，而不是假装"0 条 0 字节"）：
// - `lyricsCache`：`lyrics-cache/`（在线结果，90 天 TTL）+ `lyrics-local/`（用户导入，永远最优先）；
// - `lyricsFallback`：华为四档全落空且曲目有标题时的第三方回退（Kugou → lrclib）。
//   它走**全局 fetch**，所以设置里的代理照常生效（见 `src/main/lyrics-fallback.mjs` 的文件头）。
let musicSessionSource = null;
const lyricsCache = createLyricsCache({ dir: dataDir, log });
const lyricsFallback = createThirdPartyLyrics({ log });
const musicService = createMusicService({
  settingsData: settings.data,
  session: () => (musicSessionSource === null ? null : musicSessionSource()),
  // R40：协议层的诊断口（**只记键名**）。目前只有一处输出：歌词回落到"按专辑补索引"时，
  // 记下播放响应的键名——"播放响应里有没有 albumID"这句话得靠真机日志，不靠猜。
  log,
  lyricsCache,
  lyricsFallback,
});
for (const [channel, handler] of Object.entries(createLibraryHandlers({ api: musicService.api }))) {
  dispatcher.register(channel, handler);
}

// —— 歌词体系三条管理频道（R41）——
//
// 与 `playback:lyrics`（取词）分开：这三条是 `lyrics:import`（导入本地 .lrc/.txt）、
// `lyrics:cache-info`（两处磁盘占用）、`lyrics:cache-clear`（清缓存，可选连本地导入）。
// 三件事都经同一个 music api（协议层是唯一碰"缓存端口"的地方），处理器不自己拿 fs。
for (const [channel, handler] of Object.entries(createLyricsHandlers({ api: musicService.api }))) {
  dispatcher.register(channel, handler);
}

// —— 播放地址通道（R9）——
//
// 同一个 music 服务（同一张端点表）：`playback:resolve-url` 拿的是**当次**播放地址——
// 处理器把地址原样放进这一次的应答，不写日志、不落盘（见 src/host/playback-handlers.mjs）。
// 端点仍未配置 → 协议层如实回 `endpoint_unknown`，渲染层显示"接口尚未配置"。
for (const [channel, handler] of Object.entries(createPlaybackHandlers({ api: musicService.api }))) {
  dispatcher.register(channel, handler);
}

// —— 设置页的"测试连接"（R10）——
//
// 用的是 R6 那同一个测试器（独立 ProxyAgent，**绝不换掉全局 dispatcher**：测试连接不该把
// 整个进程的出口改掉）。它唯一一次发网络请求就发生在这里，所以凭据只经这条路出去、
// 不写日志（见 src/host/proxy-handlers.mjs 与 src/main/proxy.mjs 的凭据纪律）。
for (const [channel, handler] of Object.entries(createProxyHandlers({ testProxy: testProxyConnection }))) {
  dispatcher.register(channel, handler);
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

// —— 登录链路（R7）：会话存储（DPAPI 信封）→ 登录宿主端口 → 认证状态机 ——
//
// 位置有意排在 rpc/hostServices 之后：它要经宿主要求开登录窗、要广播登录状态；
// 而它**不在**任何业务请求之前，这正是 R6 要的装配顺序（代理先装，见文件头）。
const sessionStore =
  dataDir === null
    ? unavailableSessionStore()
    : createSessionStore({
        dir: dataDir,
        secureEncrypt: hostServices.secureEncrypt,
        secureDecrypt: hostServices.secureDecrypt,
        log,
      });

// —— 会话验证器（R37）：补上「会话验证器尚未注入」那个缺口 ——
//
// 它是 `createAuthManager` 的 `verifySession` 插座：登录刚换到音乐会话之后、以及启动恢复读回会话之后，
// 都要有一次「这个会话现在还有效吗」的判定。实现见 `src/main/session-verifier.mjs`
// （调收藏接口的**最小页**：HTTP 200 + `result.resultCode === "000000"` 才算有效；
// 服务端明确拒绝 → 踢回登录；网络错/端点关 → 保守地「没验成」）。
//
// 两处装配细节，都是顺序逼出来的：
// 1. **会话来源按调用时取**：`musicSessionSource` 的赋值在 `createAuthManager` **之后**
//    （见下面那行），所以这里传的是取值函数而不是快照——验证器每次调用时才读它；
// 2. **验证器自己一份 music api**：`createApi` 用「本次要验的那个会话」建 api。因为两个调用点
//    （`restore` / 登录收尾）传进来的都是**还没落进内存**的会话（恢复时它刚从信封读出来、
//    登录时它刚由 loginex 换到），那一刻 `currentSession().session` 里还是旧会话或 null。
//    端点表与 Digest 头仍然只有 `createMusicService` 一处实现，这里只是再装配一次。
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

// auth:login 是**长轮询**：扫码可能要好几分钟，而渲染层那条调用链（Rust core_call）有 60 秒上限。
// 所以这里立刻回"已受理"，真正的结论经 auth:status 广播送达（dispatcher 支持处理器自行答复后
// return undefined，不再写第二帧——R3 就是为这条路留的口子）。
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
      log("登录过程抛出未预期异常：", cause);
    });
  return undefined;
});
dispatcher.register(AUTH_LOGOUT, () => authManager.logout());
dispatcher.register(AUTH_CANCEL_LOGIN, () => authManager.cancelLogin());

// R16：二维码登录。引导页**自动**调这一条（界面上没有按钮），应答里带回二维码内容与有效期，
// 之后的状态变化走 `auth:qr` 广播（扫码要好几分钟，渲染层那条调用链只有 60 秒）。
// 轮询在 sidecar 里跑：渲染层只画二维码，不碰协议、不碰会话令牌。
dispatcher.register(AUTH_QR_START, () => authManager.startQrLogin());

// R19：登录状态**重查**。`auth:status` 只在启动时播一次（NoticeQueue 冲刷只发生一次），
// 渲染层 reload/崩溃重启之后那一条已经冲刷过了 → 门禁会永远停在"正在检查登录状态…"。
// 这条让渲染层每次 boot 主动问一次，应答与广播同形状；**不播广播**（有应答就不必再播一条，
// 再播只会让渲染层把同一件事处理两遍）。
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

// R27（用户三项之 3）：**启动诊断**——数据根 + 它是哪来的 + 那个根里有没有 session.enc + 恢复档位，
// 一行看全。为什么必须有：用户报"每次重启都要重登"，而最可能的原因根本不是代码——
// 调试用的根（`HWMUSIC_DATA_DIR=.tmp/live-data`）与用户自跑时读的根（`%APPDATA%\<bundle>`）
// **互不相通**，而 R27 之前那行"登录状态恢复：未登录（no_session）"看不出它读的是哪个根。
// 只查存在性、不读内容（信封里是凭据密文），见 `src/main/session-diagnostic.mjs`。
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
