/**
 * R3 桥 · 双份一致性钉死（防 Node 与 Rust 两侧频道清单/超时漂移）。
 *
 * 做法：Node 侧直接 import 共享常量；Rust 侧按源码扫描提取字面量集合，两者必须相等。
 * 另有一条"反漂移"扫描：src/host、src/sidecar、src/renderer 内不得出现频道名字面量
 * （唯一真源只有 src/shared/*.ts，Rust 是刻意的镜像副本、由本文件钉住）。
 * 先写先看红。
 *
 * R7 的两处增补（走"增补进共享常量表 + 硬钉同步改"的既有流程，不另立清单）：
 * - 宿主要求频道加 `host:cancel-login`（渲染层取消登录 → core_call auth:cancel-login → 宿主要求）；
 * - 广播频道加 `auth:status`（登录状态变化：门禁与 R8 主界面靠它知道"该显示哪一层"）。
 *
 * R8 的一处增补（同一流程：唯一真源增补 → Rust 镜像增补 → 本文件硬钉同步改）：
 * - 请求频道加 `library:*` 七条（主界面六个库页面的数据通道）。R8 之前渲染层没有任何
 *   业务请求频道，若只改一侧，`core_call` 会在 Rust 准入处被拒（用户看到"未知请求频道"）。
 *
 * R9 的两处增补（同一流程）：
 * - 请求频道加 `playback:resolve-url`：拿**当次**播放地址。地址只作当次播放结果交给渲染层，
 *   不写日志、不持久化（队列持久化只存曲目标识 + 索引）；
 * - 广播频道加 `player:command`：大屏/托盘的播放控制**预登记**（托盘在 Rust 侧，R11 接线）。
 *   预登记的理由与 R8 一次补齐 library 相同：白名单缺一项 = 那条广播被 Rust 的 FramePolicy
 *   当作白名单外帧丢掉，托盘点了没反应，而错误只出现在日志里。
 *
 * R10 的一处增补（同一流程）：
 * - 请求频道加 `settings:test-proxy`：设置页"测试连接"那条路（core 侧用独立 ProxyAgent 发一次
 *   请求）。不并进 `settings:set` 的理由见 src/shared/request-channels.ts。
 *
 * R11 的两处增补（同一流程）：
 * - 广播频道加 `lyrics:toggle`：托盘"桌面歌词"勾选的目标态（歌词窗本体是 R12）；
 * - 广播频道加 `app:open-settings`：托盘"设置…"（渲染层收到后切到设置页）。
 *   两条都是 **Rust 侧发出**（托盘菜单在 Rust 里），所以白名单少一条的后果同样是"点了没反应"。
 *
 * R12 的四处增补（同一流程）：
 * - 请求频道加 `playback:lyrics`：歌词**文本**来源（渲染层用官方 `parseLrc` 解析）；
 * - 广播频道加 `lyrics:document` / `lyrics:progress` / `lyrics:state`：主窗→歌词窗的数据链
 *   （歌词窗只订阅事件、不调业务命令，所以这三条是它唯一的数据来源）。
 *
 * R19 的一处增补（同一流程）：
 * - 请求频道加 `auth:get-status`：渲染层**主动查**当前登录状态。`auth:status` 是广播，
 *   只在 sidecar 启动时播一次（经 Rust 的 NoticeQueue 冲刷），渲染层 reload/崩溃重启之后
 *   那一条已经冲刷过了 —— 门禁会永远停在 `checking`（"正在检查登录状态…"），既不自动发起
 *   二维码，也没有任何报错。这条频道把"现在的状态是什么"变成一次**有应答的确定性查询**
 *   （与托盘可用性查询同款模式：挂载时主动问一次）。少了它的后果与 R16 那条一样直白，
 *   只是表现成"门禁卡住"而不是"频道未知"。
 *
 * R25 的一处增补（同一流程）：
 * - 广播频道加 `theme:changed`：主题三态（浅色 / 深色 / 跟随系统）的**目标态**。发送方是
 *   Rust 侧（`theme::set_theme`，由浮动控件的专用命令 `core_login_chrome` 触发），
 *   消费方是三个 webview（主窗 + 两个浮动控件）。少了它，用户点了主题只在自己那个控件上生效，
 *   别的 webview 停在旧配色——而日志里什么都看不出来（广播被当白名单外帧丢掉）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AUTH_GET_STATUS,
  AUTH_QR_START,
  HOST_REQUEST_CHANNELS,
  PLAYBACK_LYRICS,
  PLAYBACK_RESOLVE_URL,
  REQUEST_CHANNELS,
} from "../src/shared/request-channels.ts";
import {
  APP_OPEN_SETTINGS,
  AUTH_QR,
  BROADCAST_CHANNELS,
  CORE_EVENT,
  LYRICS_DOCUMENT,
  LYRICS_PROGRESS,
  LYRICS_STATE,
  LYRICS_TOGGLE,
  PLAYER_COMMAND,
  THEME_CHANGED,
} from "../src/shared/channels.ts";
import { CALL_TIMEOUT_MS } from "../src/host/bridge.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rustSource = (name) => readFileSync(`${repoRoot}src-tauri/src/${name}`, "utf8");

/** 只看生产代码：`#[cfg(test)]` 段落里的字面量是测试夹具，不算镜像副本。 */
function rustProduction(source) {
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
}

/** 从 Rust 源码里抽 `const NAME: &[&str] = &[ "a", "b" ];` 的字符串集合。 */
function rustStringArray(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*&\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `Rust 源码里找不到 ${constName} 的字面量清单`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((found) => found[1]);
}

/** 从 Rust 源码里抽所有匹配前缀的频道字面量（含路由表分支，防"清单和分支各写一份"）。 */
function rustChannelLiterals(source, prefixPattern) {
  const literal = new RegExp(`"(${prefixPattern})[a-z][a-z-]*"`, "g");
  return [...new Set([...source.matchAll(literal)].map((found) => found[0].slice(1, -1)))];
}

function rustStringConst(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*"([^"]+)"`));
  assert.ok(match, `Rust 源码里找不到常量 ${constName}`);
  return match[1];
}

function rustNumberConst(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*([0-9_]+)`));
  assert.ok(match, `Rust 源码里找不到常量 ${constName}`);
  return Number(match[1].replaceAll("_", ""));
}

function sorted(values) {
  return [...values].sort();
}

/** R8 增补的库页面请求频道（硬钉：少一条 = 某个页面点了没反应，多一条 = 白名单悄悄放宽）。 */
const LIBRARY_CHANNELS = [
  "library:album",
  "library:artist",
  "library:favorites",
  "library:history",
  "library:playlist-detail",
  "library:playlists",
  "library:search",
];

/**
 * R9 增补的播放请求频道（硬钉：多一条就等于白名单悄悄放宽了）。
 *
 * R12 增补 `playback:lyrics`：歌词**文本**来源（`{trackId}` → 原始 LRC 文本）。它与
 * `playback:resolve-url` 的分工是刻意的——地址是"当次播放结果"（不落任何痕迹），
 * 歌词文本则要交给渲染层用官方 `parseLrc` 解析，所以**返回文本而不是解析结果**。
 */
const PLAYBACK_CHANNELS = ["playback:lyrics", "playback:resolve-url"];

/** R10 增补的设置请求频道（硬钉：设置页的"测试连接"唯一要用的那一条）。 */
const SETTINGS_CHANNELS = ["settings:get", "settings:set", "settings:test-proxy"];

/**
 * 广播频道硬钉内容（两侧一起写错也能过互比，所以内容必须钉死）。
 *
 * 按字典序写：下游断言走 `sorted(...)`（R11 加了 `lyrics:toggle` 与 `app:open-settings` 之后
 * 顺序不再与"增补先后"一致，这里就按排序后的样子写，免得两边各自排序再比较）。
 */
const BROADCAST_CHANNEL_NAMES = [
  "app:notice",
  "app:open-settings",
  "auth:qr",
  "auth:status",
  "lyrics:document",
  "lyrics:progress",
  "lyrics:state",
  "lyrics:toggle",
  "player:command",
  "theme:changed",
];

test("一致性：请求频道白名单（Node 共享常量 ↔ Rust commands.rs 全部 auth:/settings:/library:/playback: 字面量）", () => {
  const rust = rustChannelLiterals(
    rustProduction(rustSource("commands.rs")),
    "(?:auth|settings|library|playback):",
  );
  assert.deepEqual(sorted(rust), sorted(REQUEST_CHANNELS));
  assert.deepEqual(sorted(REQUEST_CHANNELS), [
    "auth:cancel-login",
    "auth:get-status",
    "auth:login",
    "auth:logout",
    "auth:qr-start",
    "library:album",
    "library:artist",
    "library:favorites",
    "library:history",
    "library:playlist-detail",
    "library:playlists",
    "library:search",
    "playback:lyrics",
    "playback:resolve-url",
    "settings:get",
    "settings:set",
    "settings:test-proxy",
  ]);
});

test("一致性：settings:* 频道两侧逐条相等（R10 增补 settings:test-proxy）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "settings:");
  assert.deepEqual(sorted(rust), SETTINGS_CHANNELS);
  assert.deepEqual(
    sorted(REQUEST_CHANNELS.filter((channel) => channel.startsWith("settings:"))),
    SETTINGS_CHANNELS,
  );
});

test("一致性：playback:* 频道两侧逐条相等（R9 取地址 + R12 取歌词文本）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "playback:");
  assert.deepEqual(sorted(rust), PLAYBACK_CHANNELS);
  assert.deepEqual(
    sorted(REQUEST_CHANNELS.filter((channel) => channel.startsWith("playback:"))),
    PLAYBACK_CHANNELS,
  );
  assert.equal(PLAYBACK_RESOLVE_URL, "playback:resolve-url", "「拿当次播放地址」的频道名是契约");
  assert.equal(PLAYBACK_LYRICS, "playback:lyrics", "「拿歌词文本」的频道名是契约");
});

test("一致性：library:* 频道两侧逐条相等（R8 主界面唯一的数据通道）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "library:");
  assert.deepEqual(sorted(rust), LIBRARY_CHANNELS);
  assert.deepEqual(
    sorted(REQUEST_CHANNELS.filter((channel) => channel.startsWith("library:"))),
    LIBRARY_CHANNELS,
  );
});

test("一致性：宿主要求频道（Node 共享常量 ↔ Rust commands.rs 全部 host: 字面量）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "(?:host):");
  assert.deepEqual(sorted(rust), sorted(HOST_REQUEST_CHANNELS));
  assert.deepEqual(sorted(HOST_REQUEST_CHANNELS), [
    "host:cancel-login",
    "host:notify",
    "host:open-login",
    "host:secure-decrypt",
    "host:secure-encrypt",
  ]);
});

test("一致性：广播频道白名单（Node 共享常量 ↔ Rust bridge.rs 字面量，且两侧都钉死内容）", () => {
  const rust = rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS");
  assert.deepEqual(sorted(rust), sorted(BROADCAST_CHANNELS));
  // 内容硬钉：只做两侧互比的话，"两侧一起为空/一起写错"也能过（这正是上一轮漏掉的）
  assert.deepEqual(sorted(rust), BROADCAST_CHANNEL_NAMES);
  assert.deepEqual(sorted(BROADCAST_CHANNELS), BROADCAST_CHANNEL_NAMES);
});

test("一致性：player:command 广播（R11 托盘控制的预登记：常量 + 字面量两侧逐字相等）", () => {
  // 渲染层只认常量名；Rust 侧 `PLAYER_COMMAND` 是它的镜像副本（Rust 无法 import TS）
  assert.equal(PLAYER_COMMAND, "player:command");
  assert.equal(rustStringConst(rustSource("bridge.rs"), "PLAYER_COMMAND"), PLAYER_COMMAND);
  assert.ok(
    BROADCAST_CHANNELS.includes(PLAYER_COMMAND),
    "player:command 必须在广播白名单里：不在的话 Rust 会把这条广播当成白名单外帧丢掉",
  );
  assert.ok(
    rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS").includes(PLAYER_COMMAND),
    "Rust 侧白名单同样必须含 player:command（托盘广播就在 Rust 侧发出）",
  );
});

test("一致性：R11 托盘的两条广播（常量 + 字面量两侧逐字相等）", () => {
  // 这两条都是 Rust 侧（托盘菜单）发出的：渲染层只认常量名，Rust 侧是镜像副本（Rust 无法 import TS）
  assert.equal(LYRICS_TOGGLE, "lyrics:toggle");
  assert.equal(APP_OPEN_SETTINGS, "app:open-settings");
  assert.equal(rustStringConst(rustSource("bridge.rs"), "LYRICS_TOGGLE"), LYRICS_TOGGLE);
  assert.equal(rustStringConst(rustSource("bridge.rs"), "APP_OPEN_SETTINGS"), APP_OPEN_SETTINGS);

  const rustBroadcasts = rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS");
  for (const channel of [LYRICS_TOGGLE, APP_OPEN_SETTINGS]) {
    assert.ok(
      BROADCAST_CHANNELS.includes(channel),
      `${channel} 必须在广播白名单里：不在的话 Rust 会把这条广播当成白名单外帧丢掉`,
    );
    assert.ok(rustBroadcasts.includes(channel), `Rust 侧白名单同样必须含 ${channel}`);
  }
});

test("一致性：R12 桌面歌词窗的三条广播（常量 + 字面量两侧逐字相等）", () => {
  // 发送方是主窗侧的四条命令（Rust 侧 emit_core_event）：歌词文档 / 进度 / 配置。
  // 白名单少一条的后果是歌词窗永远收不到数据（只订阅、不请求的那个窗口只能等广播）。
  assert.equal(LYRICS_DOCUMENT, "lyrics:document");
  assert.equal(LYRICS_PROGRESS, "lyrics:progress");
  assert.equal(LYRICS_STATE, "lyrics:state");
  assert.equal(rustStringConst(rustSource("bridge.rs"), "LYRICS_DOCUMENT"), LYRICS_DOCUMENT);
  assert.equal(rustStringConst(rustSource("bridge.rs"), "LYRICS_PROGRESS"), LYRICS_PROGRESS);
  assert.equal(rustStringConst(rustSource("bridge.rs"), "LYRICS_STATE"), LYRICS_STATE);

  const rustBroadcasts = rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS");
  for (const channel of [LYRICS_DOCUMENT, LYRICS_PROGRESS, LYRICS_STATE]) {
    assert.ok(BROADCAST_CHANNELS.includes(channel), `${channel} 必须在广播白名单里`);
    assert.ok(rustBroadcasts.includes(channel), `Rust 侧白名单同样必须含 ${channel}`);
  }
});

test("一致性：漏斗事件名与调用超时两侧相等", () => {  assert.equal(rustStringConst(rustSource("bridge.rs"), "CORE_EVENT"), CORE_EVENT);  assert.equal(CORE_EVENT, "core:event");
  assert.equal(rustNumberConst(rustSource("bridge.rs"), "CALL_TIMEOUT_SECS") * 1000, CALL_TIMEOUT_MS);
  assert.equal(CALL_TIMEOUT_MS, 60_000);
});

test("反漂移：Node 运行期代码里不得出现频道名字面量（只有 src/shared 是唯一真源）", () => {
  // 递归扫 src/ 下的运行期代码：src/shared/*.ts 是唯一真源（跳过），其余一律必须 import 常量
  const scanned = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(mjs|ts|tsx)$/.test(entry.name)) continue;
      if (child.startsWith("src/shared/")) continue;
      scanned.push(child);
    }
  };
  walk("src");
  assert.ok(scanned.length >= 8, `扫描范围异常，只拿到 ${scanned.length} 个文件：${scanned.join(", ")}`);

  // 只认普通引号里的字面量：注释里用反引号写的频道名是说明文字，不是第二份清单
  // R11：`lyrics:` 与 `app:` 也纳进来（托盘那两条广播同样是"渲染层只许认常量"）
  // R25：`theme:` 同理（主题广播也是 Rust 侧发出的）
  const literal = /["']((?:auth|settings|host|library|playback|player|lyrics|app|theme):[a-z][a-z-]*)["']/g;
  const offenders = [];
  for (const relative of scanned) {
    const source = readFileSync(`${repoRoot}${relative}`, "utf8");
    for (const match of source.matchAll(literal)) offenders.push(`${relative}: ${match[1]}`);
  }
  assert.deepEqual(offenders, [], `频道名出现在运行期代码里（应从 src/shared 导入）：${offenders.join("; ")}`);
});

test("一致性：R16 二维码登录的两条频道（请求 auth:qr-start + 广播 auth:qr，两侧逐字相等）", () => {
  // 请求频道：引导页自动发起二维码会话；广播频道：二维码的生命周期（pending/scanned/…）
  assert.equal(AUTH_QR_START, "auth:qr-start");
  assert.equal(AUTH_QR, "auth:qr");
  assert.ok(
    REQUEST_CHANNELS.includes(AUTH_QR_START),
    "auth:qr-start 必须在请求白名单里：不在的话 Rust 准入直接回 unknown_channel（引导页只看到加载失败）",
  );
  assert.ok(
    rustChannelLiterals(rustProduction(rustSource("commands.rs")), "auth:").includes(AUTH_QR_START),
    "Rust 侧命令白名单同样必须含 auth:qr-start",
  );
  assert.ok(BROADCAST_CHANNELS.includes(AUTH_QR), "auth:qr 必须在广播白名单里（否则状态广播被当白名单外帧丢掉）");
  assert.ok(
    rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS").includes(AUTH_QR),
    "Rust 侧广播白名单同样必须含 auth:qr",
  );
  assert.equal(rustStringConst(rustSource("bridge.rs"), "AUTH_QR"), AUTH_QR);
});

test("一致性：R19 auth:get-status 请求频道（常量 + Rust 字面量 + 请求白名单三处逐字相等）", () => {
  // 渲染层 reload/崩溃重启之后，`auth:status` 那条启动广播已经冲刷过了；渲染层只能**主动查**。
  // 这条频道少了任何一个环节（常量表 / Rust 准入 / sidecar 处理器），门禁就还是停在 checking。
  assert.equal(AUTH_GET_STATUS, "auth:get-status");
  assert.ok(
    REQUEST_CHANNELS.includes(AUTH_GET_STATUS),
    "auth:get-status 必须在请求白名单里：不在的话处理器根本注册不上（dispatcher.register 直接抛）",
  );
  assert.ok(
    rustChannelLiterals(rustProduction(rustSource("commands.rs")), "auth:").includes(AUTH_GET_STATUS),
    "Rust 侧命令白名单同样必须含 auth:get-status（否则 core_call 在准入处就回 unknown_channel）",
  );
});

test("一致性：R25 theme:changed 广播频道（常量 + Rust 镜像 + 白名单三处逐字相等）", () => {
  // 发送方是 Rust 侧（浮动控件的 `core_login_chrome` → `theme::set_theme`），消费方是三个 webview。
  // 少了任何一个环节，用户在浮动控件上改的主题就只在那个控件里生效（别的 webview 停在旧配色）。
  assert.equal(THEME_CHANGED, "theme:changed");
  assert.equal(rustStringConst(rustSource("bridge.rs"), "THEME_CHANGED"), THEME_CHANGED);
  assert.ok(BROADCAST_CHANNELS.includes(THEME_CHANGED), "theme:changed 必须在广播白名单里");
  assert.ok(
    rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS").includes(THEME_CHANGED),
    "Rust 侧白名单同样必须含 theme:changed（它就是发送方）",
  );
});
