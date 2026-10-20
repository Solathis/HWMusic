/**
 * R10 设置页 · 开机自启（`core_set_autostart` / `core_get_autostart`）。
 *
 * 为什么绕开插件自带的 `plugin:autostart|enable` 而自己写两条命令（裁决）：插件命令要走
 * capabilities 的 `autostart:allow-*` 权限，等于**为渲染层开一个直接改系统自启的入口**；
 * 自己写命令则把它收在主窗来源守卫（`require_main_webview`，R23 起判 webview label）后面，
 * 与 `core_call` 同一个门。
 *
 * 要钉住的五件事：
 * 1. **命令名一份真源**：`src/shared/commands.ts` 导出、`host-api.ts` 只用常量
 *    （写错一个字母的后果是 invoke 报 "command not found"，而那要到运行时才知道）；
 * 2. **Rust 侧真的注册了**：命令在 `commands.rs` 里、且进 `generate_handler!` 白名单
 *    （只定义不注册 = 渲染层点了没反应）；
 * 3. **报的是观测到的状态**：`apply_autostart` 先 enable/disable 再 `is_enabled`，
 *    开关跟着**观测值**走（把请求回显成成功，就是让界面替系统撒谎）；
 * 4. **权限前置条件**：本应用没有 app 级 ACL manifest → 自定义命令不走 ACL（Tauri 2.12 语义，
 *    证据见 src-tauri/src/commands.rs 的注释）；这条把前置条件本身钉住；
 * 5. **JS 侧纯逻辑**：状态文案三档（开/关/**没取到**）不许互相冒充，失败文案要带原因。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CORE_CALL,
  CORE_GET_AUTOSTART,
  CORE_RENDERER_READY,
  CORE_SET_AUTOSTART,
} from "../src/shared/commands.ts";
import {
  autostartFailureText,
  autostartStateText,
  autostartStatusFailureText,
} from "../src/renderer/features/settings/settings-form.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

const HOST_API_FILE = "src/renderer/host-api.ts";
const PAGE_FILE = "src/renderer/pages.tsx";

// ---------------------------------------------------------------------------
// 1. 命令名：一份真源 + 渲染层只用常量
// ---------------------------------------------------------------------------

test("命令名：共享常量是真源，字面量逐字钉死（改字符串就是改契约）", () => {
  assert.equal(CORE_SET_AUTOSTART, "core_set_autostart");
  assert.equal(CORE_GET_AUTOSTART, "core_get_autostart");
  assert.equal(CORE_CALL, "core_call");
  assert.equal(CORE_RENDERER_READY, "core_renderer_ready");

  const hostApi = read(HOST_API_FILE);
  assert.match(hostApi, /from\s+"\.\.\/shared\/commands\.ts"/, "host-api 的命令名必须 import 共享常量");
  assert.doesNotMatch(
    hostApi,
    /["']core_(?:set|get)_autostart["']/,
    "host-api 里不许出现命令名字面量（那是第二份真源）",
  );
  assert.doesNotMatch(
    hostApi,
    /["']core_call["']|["']core_renderer_ready["']/,
    "既有的两条命令名也一并收进共享常量（同一份真源）",
  );
});

test("载荷与回执：setAutostart 只发 {enabled}，且返回的是 core 报的状态", () => {
  const hostApi = read(HOST_API_FILE);
  assert.match(
    hostApi,
    /invoke<boolean>\(\s*CORE_SET_AUTOSTART\s*,\s*\{\s*enabled\s*\}\s*\)/,
    "写入载荷只有 enabled 一个字段（没有额外的路径/参数旋钮）",
  );
  assert.match(
    hostApi,
    /invoke<boolean>\(\s*CORE_GET_AUTOSTART\s*\)/,
    "读取走独立的命令：开关的初始状态不能靠猜",
  );
  assert.match(hostApi, /export async function setAutostart\(/, "渲染层要有具名封装（页面不直接 invoke）");
  assert.match(hostApi, /export async function getAutostart\(/, "读取也要封装");
  // 失败归一：与 coreCall 同一条路（Tauri 的 command 错误不是 Error 实例）
  assert.match(hostApi, /normalizeFailure\(/, "命令失败要归一成 CoreError 形状，不许把原始错误抛给界面");
});

// ---------------------------------------------------------------------------
// 2 + 3. Rust 侧：注册 + 观测状态
// ---------------------------------------------------------------------------

test("Rust 侧：两条命令都在，且都进了 generate_handler 白名单", () => {
  const commands = read("src-tauri/src/commands.rs");
  const lib = read("src-tauri/src/lib.rs");

  assert.match(
    commands,
    /#\[tauri::command\][\s\S]{0,200}?pub fn core_set_autostart\(/,
    "core_set_autostart 必须是 tauri command",
  );
  assert.match(
    commands,
    /#\[tauri::command\][\s\S]{0,200}?pub fn core_get_autostart\(/,
    "core_get_autostart 必须是 tauri command",
  );
  for (const name of ["core_set_autostart", "core_get_autostart"]) {
    assert.match(
      lib,
      new RegExp(`commands::${name}\\b`),
      `${name} 必须进 generate_handler!（只定义不注册 = 点了没反应）`,
    );
  }
});

test("Rust 侧：报的是观测到的状态（先 enable/disable，再 is_enabled）", () => {
  const commands = read("src-tauri/src/commands.rs");
  const start = commands.indexOf("pub fn apply_autostart");
  const end = commands.indexOf("pub fn read_autostart");
  assert.ok(start !== -1, "必须有一个可单测的纯函数 apply_autostart（不依赖 tauri app / mock runtime）");
  assert.ok(end > start, "apply_autostart 后面紧跟着 read_autostart（读取路径也抽成纯函数）");
  const body = commands.slice(start, end);
  assert.match(body, /\.enable\(\)|\.disable\(\)/, "写入路径要调插件的 enable/disable");
  assert.match(body, /is_enabled\(\)/, "写完必须回读实际状态（请求被受理 ≠ 真的打开了）");
  assert.ok(
    body.indexOf("is_enabled()") > body.indexOf("enable()"),
    "回读要在写入之后：先回读再写，报的就是旧状态",
  );
});

test("Rust 侧：插件已注册，且命令用的是插件托管的 AutoLaunchManager", () => {
  assert.match(
    read("src-tauri/Cargo.toml"),
    /tauri-plugin-autostart/,
    "Cargo.toml 要有 tauri-plugin-autostart（R2 已装）",
  );
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /tauri_plugin_autostart::init\(/, "插件必须在 run() 里注册（状态由它的 setup 托管）");
  const commands = read("src-tauri/src/commands.rs");
  assert.match(
    commands,
    /try_state::<tauri_plugin_autostart::AutoLaunchManager>\(\)/,
    "取托管状态要用 try_state：插件没注册时结构化报错，而不是 panic",
  );
  assert.doesNotMatch(
    commands,
    /ManagerExt::autolaunch\(\)|\.autolaunch\(\)/,
    "不用插件扩展 trait 的 autolaunch()（它在没注册时直接 panic）",
  );
});

// ---------------------------------------------------------------------------
// 4. 权限：不需要 capabilities 条目——但前置条件必须成立
// ---------------------------------------------------------------------------

test("权限：不改 capabilities（自定义命令不走 ACL），前置条件本身被钉住", () => {
  const capabilities = JSON.parse(read("src-tauri/capabilities/main.json"));
  const permissions = capabilities.permissions ?? [];
  assert.deepEqual(
    permissions.filter((entry) => /autostart/.test(entry)),
    [],
    "不为自启加权限条目（那是给渲染层开一个直接改系统自启的口子）",
  );

  // Tauri 2.12：自定义命令只在「app 定义了 ACL manifest」或「来源是远程 URL」时才查 ACL
  // （src-tauri/src/commands.rs 的注释里有逐行出处）。前置条件一旦被改动，上面那条结论就不再成立。
  const build = read("src-tauri/build.rs");
  assert.doesNotMatch(
    build,
    /app_manifest\s*\(|commands\s*\(\s*&\[/,
    "build.rs 一旦声明 app 级 manifest，自定义命令就会开始走 ACL —— 那时必须同步加权限条目",
  );
  assert.equal(
    existsSync(`${repoRoot}src-tauri/permissions`),
    false,
    "src-tauri/permissions 目录一旦出现，同样意味着 app 级 ACL 生效（见上）",
  );
});

// ---------------------------------------------------------------------------
// 5. JS 纯逻辑：三档状态与失败文案
// ---------------------------------------------------------------------------

test("状态文案：开 / 关 / 没取到 是三档，不许互相冒充", () => {
  const on = autostartStateText(true);
  const off = autostartStateText(false);
  const unknown = autostartStateText(null);

  assert.notEqual(on, off);
  assert.notEqual(off, unknown, "读不到状态说成「已关闭」就是替系统撒谎");
  assert.match(on, /已开启|开启/, on);
  assert.match(off, /已关闭|关闭/, off);
  assert.match(unknown, /未取到|未知|读不到/, unknown);

  for (const text of [on, off, unknown]) {
    assert.ok(text.trim() !== "", "空文案等于什么都没说");
    assert.ok(!/敬请期待|即将上线/.test(text), `禁画饼：${text}`);
  }
  // undefined（还没读）与 null 同档
  assert.equal(autostartStateText(undefined), unknown);
});

test("失败文案：带上 core 给的原因，且说清开关显示的是实际状态", () => {
  const withMessage = autostartFailureText({
    kind: "internal",
    message: "开机自启设置失败（拒绝访问）",
  });
  assert.match(withMessage, /拒绝访问/, "core 的那句话是唯一线索，不许丢掉");
  assert.match(withMessage, /自启/, `要说清是哪件事没成：${withMessage}`);

  const bare = autostartFailureText(null);
  assert.equal(typeof bare, "string");
  assert.ok(bare.trim() !== "");
  assert.match(bare, /日志|重试|稍后/, `给出下一步：${bare}`);
  assert.ok(!/敬请期待|即将上线/.test(bare));
});

test("失败文案：读不到状态与改不动是两句不同的话（下一步不同）", () => {
  const read = autostartStatusFailureText({ kind: "internal", message: "插件未注册" });
  assert.match(read, /插件未注册/, read);
  assert.match(read, /读不到|读取/, `要指明是读这一侧的问题：${read}`);
  assert.notEqual(read, autostartFailureText({ kind: "internal", message: "插件未注册" }));

  const bare = autostartStatusFailureText(null);
  assert.match(bare, /日志|稍后|重试/, bare);
  assert.ok(!/敬请期待|即将上线/.test(bare));
});

// ---------------------------------------------------------------------------
// 6. 页面接线
// ---------------------------------------------------------------------------

test("页面接线：开关走 host-api 封装，显示的状态来自 core 的回报", () => {
  const page = read(PAGE_FILE);
  const settingsPage = page.slice(page.indexOf("export function SettingsPage("));
  assert.ok(settingsPage.length > 100, "必须在 pages.tsx 里找到 SettingsPage");

  assert.match(settingsPage, /getAutostart\(/, "挂载时读一次实际状态");
  assert.match(settingsPage, /await setAutostart\(/, "切换走封装（不直接 invoke）");
  assert.match(
    settingsPage,
    /setAutostartEnabled\(\s*await\s+setAutostart\(/,
    "开关的显示值是 core 回报的状态，不是用户点的那一下（乐观翻转会在失败时撒谎）",
  );
  assert.match(settingsPage, /autostartStateText\(/, "状态文案来自纯逻辑模块");
  assert.match(settingsPage, /autostartFailureText\(/, "失败文案来自纯逻辑模块");
  assert.match(settingsPage, /autostartStatusFailureText\(/, "读失败与写失败是两句不同的话（各走各的文案）");
});
