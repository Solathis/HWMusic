/**
 * R11 托盘与关窗行为：跨语言契约 + 渲染层联动。
 *
 * Rust 侧的内联单测（`src-tauri/src/tray.rs`、`close_behavior.rs`、`lib.rs`）钉的是**本模块的判定**；
 * 这里钉的是**跨语言那半边**——两边各写一份时最容易漂移、而漂移的后果只有用户能发现的东西：
 *
 * 1. **频道与命令名**：托盘发的是 `lyrics:toggle` / `app:open-settings` 两条新广播，
 *    问宿主的是 `core_get_tray_available`。名字写错一个字母的后果是"点了没反应"或
 *    "invoke 报 command not found"，都要到运行时才知道；
 * 2. **播放命令词**：Rust 托盘发出的 `toggle`/`previous`/`next` 必须是渲染层命令表里的词
 *    （R9 的执行器"认不出就拒绝"，不会猜——所以词表必须对上）；
 * 3. **托盘模块的纪律**：不发事件信封（唯一构造点 `commands::emit_core_event`）、
 *    装不上不 panic、图标走 `include_bytes!`；
 * 4. **关窗行为的退化方向**：形状不认识一律 `quit`（猜 `tray` 会让用户关一次窗就再也找不回）；
 * 5. **渲染层联动**：App 启动查一次可用性并交给设置页；托盘的"设置…"有人消费
 *    （没人订阅的广播 = 一个点了没反应的菜单项）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { APP_OPEN_SETTINGS, BROADCAST_CHANNELS, LYRICS_TOGGLE, PLAYER_COMMAND } from "../src/shared/channels.ts";
import { CORE_GET_TRAY_AVAILABLE } from "../src/shared/commands.ts";
import {
  CLOSE_BEHAVIORS,
  TRAY_AVAILABLE,
  closeBehaviorFromSettings,
  closeBehaviorNotice,
  trayAvailabilityFromAnswer,
} from "../src/renderer/features/settings/settings-form.mjs";
import { PLAYER_COMMANDS } from "../src/renderer/features/playback/player-commands.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const rustSource = (name) => read(`src-tauri/src/${name}`);
/** 只看生产代码：`#[cfg(test)]` 段里的字面量是测试夹具，不算镜像副本。 */
const rustProduction = (source) => {
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
};

const HOST_API_FILE = "src/renderer/host-api.ts";
const APP_FILE = "src/renderer/App.tsx";
const PAGE_FILE = "src/renderer/pages.tsx";

// ---------------------------------------------------------------------------
// 1. 频道：R11 增补的两条广播
// ---------------------------------------------------------------------------

test("频道：托盘的两条广播在共享常量表里，值与 Rust 镜像逐字相等", () => {
  assert.equal(LYRICS_TOGGLE, "lyrics:toggle");
  assert.equal(APP_OPEN_SETTINGS, "app:open-settings");

  assert.ok(
    BROADCAST_CHANNELS.includes(LYRICS_TOGGLE),
    "lyrics:toggle 必须在广播白名单里：不在的话那条广播会被当成白名单外帧丢掉",
  );
  assert.ok(BROADCAST_CHANNELS.includes(APP_OPEN_SETTINGS), "app:open-settings 同理");
  assert.ok(BROADCAST_CHANNELS.includes(PLAYER_COMMAND), "R9 预登记的 player:command 也不能掉");

  const bridge = rustProduction(rustSource("bridge.rs"));
  assert.match(
    bridge,
    /LYRICS_TOGGLE\s*:\s*&str\s*=\s*"lyrics:toggle"/,
    "Rust 侧的 lyrics:toggle 必须是与共享常量逐字相同的镜像副本",
  );
  assert.match(
    bridge,
    /APP_OPEN_SETTINGS\s*:\s*&str\s*=\s*"app:open-settings"/,
    "Rust 侧的 app:open-settings 同理",
  );
});

// ---------------------------------------------------------------------------
// 2 + 3. 命令名：core_get_tray_available
// ---------------------------------------------------------------------------

test("命令名：一条真源（共享常量），渲染层与 Rust 两侧都只用它", () => {
  assert.equal(CORE_GET_TRAY_AVAILABLE, "core_get_tray_available");

  const hostApi = read(HOST_API_FILE);
  assert.match(hostApi, /from\s+"\.\.\/shared\/commands\.ts"/, "命令名必须从共享真源导入");
  assert.doesNotMatch(
    hostApi,
    /["']core_get_tray_available["']/,
    "host-api 里不许出现命令名字面量（那是第二份真源）",
  );
  assert.match(
    hostApi,
    /invoke<boolean>\(\s*CORE_GET_TRAY_AVAILABLE\s*\)/,
    "可用性查询走独立命令，回执是 boolean（R10 的 TRAY_AVAILABLE 常量从此有真来源）",
  );
  assert.match(hostApi, /export async function getTrayAvailable\(/, "渲染层要有具名封装（页面不直接 invoke）");
  assert.match(hostApi, /normalizeFailure\(/, "命令失败要归一成 CoreError 形状");

  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /commands::core_get_tray_available\b/, "Rust 侧必须真的注册（只定义不注册 = 点了没反应）");
});

test("Rust 侧：命令挂主窗来源守卫，且用的是活的托盘事实（不是第二份镜像）", () => {
  const commands = rustProduction(rustSource("commands.rs"));
  assert.match(
    commands,
    /#\[tauri::command\][\s\S]{0,400}?pub fn core_get_tray_available\(/,
    "core_get_tray_available 必须是 tauri command",
  );
  const start = commands.indexOf("pub fn core_get_tray_available");
  assert.ok(start !== -1);
  const body = commands.slice(start, start + 600);
  // R23：守卫判的是 **webview label**（同窗之后窗口 label 恒为 main，按窗口判会被登录页绕过）
  assert.match(
    body,
    /require_main_webview\(webview\.label\(\)\)/,
    "与自启那两条同一个门：非主窗（含主窗里的登录页）问不了托盘",
  );
  assert.match(body, /crate::tray::available\(/, "可用性要现问 tauri 的托盘表（自己记一份只会漂移）");
});

// ---------------------------------------------------------------------------
// 4. 托盘模块的纪律（Rust 内联测试也钉了，这里从跨语言一侧再看一眼）
// ---------------------------------------------------------------------------

test("托盘模块：不发事件信封、装不上不 panic、图标内嵌", () => {
  const tray = rustProduction(rustSource("tray.rs"));

  assert.ok(!tray.includes("app.emit(") && !tray.includes(".emit("), "托盘不许自己 emit（唯一构造点在 commands）");
  assert.match(tray, /commands::emit_core_event\(/, "三条广播都要经 emit_core_event");
  for (const forbidden of [".unwrap()", ".expect(", "panic!(", "todo!(", "unreachable!("]) {
    assert.ok(!tray.includes(forbidden), `装不上时要降级，不许 ${forbidden}`);
  }

  assert.match(tray, /include_bytes!\("\.\.\/icons\/icon\.ico"\)/, "Windows 用多尺寸 ico");
  assert.match(tray, /include_bytes!\("\.\.\/icons\/32x32\.png"\)/, "非 Windows 用 32×32 png");
  assert.match(tray, /icon_as_template\(/, "macOS 叠模板图标（跟着系统亮暗反色）");
});

// ---------------------------------------------------------------------------
// 5. 菜单表与关窗决议（跨语言可见的契约）
// ---------------------------------------------------------------------------

test("菜单契约：9 槽位 / 7 项 / 2 分隔线，id 前缀 tray:，认不出的 id 不猜", () => {
  const tray = rustProduction(rustSource("tray.rs"));

  // 只看槽位表那一段（`build_menu` 里也有 `MenuSlot::Item {` 的匹配臂，整份数会数重）
  const tableStart = tray.indexOf("pub const MENU_SLOTS");
  const tableEnd = tray.indexOf("/// 托盘菜单项 → 动作");
  assert.ok(tableStart !== -1 && tableEnd > tableStart, "必须能找到 MENU_SLOTS 槽位表");
  const table = tray.slice(tableStart, tableEnd);

  const ids = [...table.matchAll(/id:\s*(ID_[A-Z_]+)/g)].map((found) => found[1]);
  const separators = [...table.matchAll(/MenuSlot::Separator\b/g)].length;
  assert.equal(ids.length, 7, "7 个可点的项（显示窗口/播放·暂停/上一首/下一首/桌面歌词/设置…/退出程序）");
  assert.equal(separators, 2, "2 条分隔线");
  assert.equal(new Set(ids).size, 7, `菜单 id 必须互不相同：${ids.join(", ")}`);
  assert.equal(ids.length + separators, 9, "合起来 9 槽位");

  assert.match(tray, /MENU_ID_PREFIX\s*:\s*&str\s*=\s*"tray:"/, "id 前缀是 tray:");
  for (const id of ids) {
    const literal = new RegExp(`${id}\\s*:\\s*&str\\s*=\\s*"tray:[a-z-]+"`);
    assert.match(tray, literal, `${id} 必须带 tray: 前缀（前缀是"这个 id 归托盘管"的判据）`);
  }
  assert.match(tray, /_ => None,/, "认不出的 id 走 None（不猜不 panic）");

  const decision = tray.slice(tray.indexOf("pub fn decide_close("), tray.indexOf("pub fn tray_notice("));
  assert.match(decision, /behavior: CloseBehavior/, "决策使用关窗枚举");
  assert.match(decision, /CloseBehavior::Tray if tray_available => CloseAction::PreventAndHide/);
  assert.doesNotMatch(decision, /PreventAndMinimize|CloseBehavior::Minimize/, "旧值应在读盘时迁移 tray");
  assert.match(decision, /CloseBehavior::Tray \| CloseBehavior::Quit => CloseAction::Quit/);
  const dispatch = tray.slice(tray.indexOf("fn dispatch<"));
  assert.match(dispatch, /crate::request_app_exit\(app\)/, "托盘 Quit 与关窗共用一次性入口");
  assert.doesNotMatch(dispatch, /app\.exit\(/, "不在托盘事件中同步退出");
});

test("播放命令词：托盘发出的三个词必须是渲染层命令表里的词（认不出就拒绝，不会猜）", () => {
  const tray = rustProduction(rustSource("tray.rs"));
  for (const command of ["toggle", "previous", "next"]) {
    assert.match(
      tray,
      new RegExp(`Some\\("${command}"\\)`),
      `托盘要发出 ${command}（Rust 侧的 player_command_for）`,
    );
    assert.ok(
      PLAYER_COMMANDS.includes(command),
      `${command} 必须也在渲染层的命令表里（不在的话点一下只会拿到 invalid_command）`,
    );
  }
  assert.match(tray, /PLAYER_COMMAND/, "播放命令走 R9 预登记的 player:command 频道（不新增 IPC）");
});

// ---------------------------------------------------------------------------
// 6. 关窗行为：schema 闸门 + 退化方向保守
// ---------------------------------------------------------------------------

test("关窗行为（Rust 读盘）：schema 闸门与渲染层/core 枚举同源，退化方向保守", () => {
  const close = rustProduction(rustSource("close_behavior.rs"));

  assert.match(close, /SETTINGS_SCHEMA_VERSION/, "与 webview_proxy 同一套 schema 闸门");
  assert.match(close, /SETTINGS_FILE_NAME/, "同一个设置文件名（读的是同一份盘）");
  assert.match(
    close,
    /CONSERVATIVE_CLOSE_BEHAVIOR\s*:\s*CloseBehavior\s*=\s*CloseBehavior::Quit/,
    "形状认不出时落 quit：猜 tray 而托盘装不上 = 用户关一次窗再也找不回应用",
  );
  const rustLiterals = [...close.matchAll(/pub const CLOSE_BEHAVIOR_[A-Z]+\s*:\s*&str\s*=\s*"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rustLiterals, ["tray", "quit"]);
  assert.deepEqual([...CLOSE_BEHAVIORS], rustLiterals, "core/UI/Rust 正常枚举两态逐条同源");
});

test("关窗行为：设置里还没有这一项时，Rust 必须跟 core 的默认说同一句话", () => {
  // 「文件不在」（用户还没选过）与「文件在但认不出」（有人动过盘）是两档：
  // 前者要跟 core 的默认一致（设置页此刻显示的就是它），后者才保守落 quit。
  // 混成一档的后果正是那种"界面说藏起来、关窗却退出了"的谎话。
  assert.equal(
    closeBehaviorFromSettings(null),
    "tray",
    "core 的默认是枚举第一项 = tray（设置页在「没这一项」时显示的就是它）",
  );
  assert.match(
    rustProduction(rustSource("close_behavior.rs")),
    /CORE_DEFAULT_CLOSE_BEHAVIOR\s*:\s*CloseBehavior\s*=\s*CloseBehavior::Tray/,
    "Rust 侧的「用户还没选」必须也落 tray（与 closeBehaviorFromSettings(null) 同向）",
  );
});

// ---------------------------------------------------------------------------
// 7. 可用性纯函数（渲染层）
// ---------------------------------------------------------------------------

test("可用性：只认 true，其余（false / 坏形状 / 没答）一律保守值", () => {
  assert.equal(trayAvailabilityFromAnswer(true), true);
  assert.equal(trayAvailabilityFromAnswer(false), false);
  for (const broken of [undefined, null, "true", 1, 0, {}, [], "yes"]) {
    assert.equal(
      trayAvailabilityFromAnswer(broken),
      false,
      `认不出的回执按"不可用"处理（保守方向与 decide_close 的 fail-safe 一致）：${JSON.stringify(broken)}`,
    );
  }
  // R10 那个写死的常量现在是**兜底值**：宿主还没答或答不上来时用它
  assert.equal(TRAY_AVAILABLE, false, "兜底值仍是 false（不许改成乐观的 true）");
});

test("关窗文案：托盘可用 / 不可用 / 选退出是三句话，不许互相冒充", () => {
  const ready = closeBehaviorNotice("tray", { trayAvailable: true });
  assert.match(ready, /托盘/, ready);
  assert.ok(!/回退|不可用/.test(ready), `可用时不该再说回退：${ready}`);

  const fallback = closeBehaviorNotice("tray", { trayAvailable: false });
  assert.match(fallback, /托盘/, fallback);
  assert.match(fallback, /退出/, `要说清关窗会直接退出：${fallback}`);
  assert.notEqual(fallback, ready);

  const quit = closeBehaviorNotice("quit", { trayAvailable: true });
  assert.ok(!/托盘/.test(quit), `选退出与托盘无关：${quit}`);
  for (const text of [ready, fallback, quit]) {
    assert.ok(!/敬请期待|即将上线/.test(text), `禁画饼：${text}`);
  }
});

// ---------------------------------------------------------------------------
// 8. 渲染层联动
// ---------------------------------------------------------------------------

test("App 启动：查一次托盘可用性，结果交给设置页（R10 的占位接真值）", () => {
  const app = read(APP_FILE);

  assert.match(app, /getTrayAvailable\(\)/, "启动时要问宿主一次（那条命令是唯一来源）");
  assert.match(app, /useEffect\(/, "查询发生在 effect 里（挂载一次，不是每次渲染一趟）");
  assert.match(app, /trayAvailabilityFromAnswer\(/, "回执要经纯函数投影（只认 true）");
  assert.match(app, /trayAvailable=\{[^}]*\}/, "设置页要用查到的值");
  assert.match(
    app,
    /useState<boolean \| null>\(null\)|useState\(null\)/,
    "初始是「还没取到」（null），不是乐观的 true",
  );

  const page = read(PAGE_FILE);
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  assert.match(settings, /trayAvailable/, "设置页要收这个值（不再读写死的常量）");
  assert.match(
    settings,
    /closeBehaviorNotice\([^)]*trayAvailable/,
    "提示要按真实可用性说话",
  );
  assert.doesNotMatch(
    settings,
    /closeBehaviorNotice\([^)]*TRAY_AVAILABLE/,
    "提示不许再直接吃那个兜底常量（那就回到「永远说托盘不可用」了）",
  );
});

test("托盘菜单“设置…”：有人消费 app:open-settings（没人订阅 = 点了没反应）", () => {
  const app = read(APP_FILE);

  assert.match(app, /from\s+"\.\.\/shared\/channels\.ts"/, "频道名从共享真源导入");
  assert.match(app, /\bAPP_OPEN_SETTINGS\b/, "要订阅 app:open-settings");
  assert.match(app, /onCoreEvent\(/, "订阅走 host-api 的封装");
  assert.match(
    app,
    /createView\(\s*VIEW\.settings\s*\)/,
    "收到之后切到设置页（复用既有的视图切换，不新增路由）",
  );
});
