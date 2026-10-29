/**
 * 沉浸页的主窗外框：Windows 上收起系统标题栏，页面画拖动区与窗口按钮；标题栏在退出与重载前装回。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CORE_MAIN_CHROME } from "../src/shared/commands.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const rustProduction = (source) => (source.includes("#[cfg(test)]") ? source.slice(0, source.indexOf("#[cfg(test)]")) : source);

test("R80 命令名：core_main_chrome 是跨语言契约（常量 + 渲染层封装 + Rust 注册与主窗守卫）", () => {
  assert.equal(CORE_MAIN_CHROME, "core_main_chrome");
  const host = read("src/renderer/host-api.ts");
  assert.match(host, /export async function coreMainChrome\(action: MainChromeAction\): Promise<MainChromeState>/);
  assert.match(host, /invoke<MainChromeState>\(CORE_MAIN_CHROME, \{ payload: \{ action \} \}\)/);
  const chrome = rustProduction(read("src-tauri/src/main_chrome.rs"));
  const command = chrome.slice(chrome.indexOf("pub async fn core_main_chrome("));
  assert.ok(command.indexOf("require_main_webview(webview.label())") > 0, "只接受主窗");
  assert.ok(command.indexOf("require_main_webview(") < command.indexOf("parse_action("), "先验来源再解析载荷");
  assert.match(chrome, /pub const FRAMELESS_SUPPORTED: bool = cfg!\(windows\);/, "只有 Windows 收起标题栏");
  assert.match(chrome, /ChromeAction::Immersive if FRAMELESS_SUPPORTED => window\.set_decorations\(false\)/);
  assert.match(chrome, /ChromeAction::Normal => window\.set_decorations\(true\)/);
  assert.match(chrome, /ChromeAction::Close => window\.close\(\)/, "关闭与系统关闭键同一条路（先触发 CloseRequested）");
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /^mod main_chrome;/m);
  const registered = lib.slice(lib.indexOf("invoke_handler(tauri::generate_handler!["));
  assert.ok(registered.slice(0, registered.indexOf("])")).includes("main_chrome::core_main_chrome"), "命令进 generate_handler!");
});

test("R80 外框不持久化：退出前与页面重载时都把标题栏装回去（window-state 存的是内尺寸）", () => {
  const lib = rustProduction(read("src-tauri/src/lib.rs"));
  const commit = lib.split("fn commit_exit<")[1].split("fn abort_exit<")[0];
  assert.ok(commit.includes("main_chrome::restore_frame(&window)"), "退出前装回标题栏");
  assert.ok(commit.indexOf("main_chrome::restore_frame(") < commit.indexOf("app.exit(0)"), "装回在 app.exit 之前（插件在 Exit 时存窗口尺寸）");
  const pageLoad = lib.slice(lib.indexOf("builder = builder.on_page_load("), lib.indexOf("let window = builder.build()?;"));
  assert.match(pageLoad, /PageLoadEvent::Started/);
  assert.ok(pageLoad.includes("main_chrome::restore_frame(&window)"), "重载时装回标题栏（沉浸页已不在了）");
  assert.match(read("src-tauri/src/main_chrome.rs"), /pub fn restore_frame<R: Runtime>\(window: &WebviewWindow<R>\) \{\s*if let Err\(error\) = window\.set_decorations\(true\)/);
});

test("R80 沉浸页：收起行悬停是淡色半透明；标题栏收起时这一行兼作拖动区，窗口按钮只在收起时出现", () => {
  const stage = stripComments(read("src/renderer/playback-stage.tsx"));
  const hookAt = stage.indexOf("const chrome = useMainChrome(open)");
  assert.ok(hookAt > 0 && hookAt < stage.indexOf("if (!open) return null"), "hook 在提前返回之前调用");
  const tint = "hover:bg-background/30 dark:hover:bg-foreground/10";
  assert.ok(stage.includes(`className="absolute inset-x-0 top-0 h-10 w-full rounded-none ${tint} `), "收起行悬停是淡色半透明");
  assert.ok(stage.includes(`const chromeButton = "h-10 w-11 rounded-none px-0 ${tint}"`), "窗口按钮同一种悬停");
  assert.doesNotMatch(stage, /hover:bg-muted/, "不再用 ghost 默认那条近白的悬停底");
  const row = stage.match(/<Button[^>]*aria-label="收起歌词"[^>]*>/)?.[0] ?? "";
  for (const part of [tint, "onPointerDown={startRowPress}", "onPointerMove={trackRowPress}", "onClick={clickRow}"]) {
    assert.ok(row.includes(part), `收起行缺 ${part}`);
  }
  assert.match(stage, /rowPress\.current = chrome\.frameless && event\.button === 0/, "只有标题栏收起时才当拖动区");
  assert.match(stage, /< 4\) return/, "移动不到 4px 仍算点击");
  assert.match(stage, /getCurrentWindow\(\)\.startDragging\(\)/, "拖窗走官方 startDragging（主窗已有这一条窗口权限）");
  assert.match(stage, /const dragged = rowDragged\.current && event\.detail > 0[\s\S]*if \(!dragged\) onClose\(\)/, "拖完松手不收起，键盘回车仍收起");
  const start = stage.indexOf("{chrome.frameless ? (");
  const controls = stage.slice(start, stage.indexOf(") : null}", start));
  assert.match(controls, /data-testid="playback-stage-window-controls"/);
  for (const [label, action] of [["最小化", "minimize"], ['{chrome.maximized ? "还原" : "最大化"}', "toggle-maximize"], ["关闭窗口", "close"]]) {
    assert.ok(controls.includes(label) && controls.includes(`chrome.act("${action}")`), `窗口按钮缺 ${label}`);
  }
  const hook = read("src/renderer/use-main-chrome.ts");
  assert.match(hook, /void request\("immersive"\)/, "打开沉浸页请宿主收起标题栏");
  assert.match(hook, /void request\("normal"\)/, "关闭或卸载时装回");
  assert.match(hook, /queue\.then\(\(\) => coreMainChrome\(action\)\)/, "请求排队，快速开关不乱序");
  assert.deepEqual(
    JSON.parse(read("src-tauri/capabilities/main.json")).permissions.filter((entry) => entry.startsWith("core:window:")),
    ["core:window:allow-start-dragging"],
    "窗口按钮走专命令，主窗不加窗口权限",
  );
});
