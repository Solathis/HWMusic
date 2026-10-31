/**
 * 设置「关于」：外链两侧同源、技术栈版本与锁文件一致、运行环境如实显示、命令走最小权限。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  PROJECT_LINKS,
  REFERENCE_LINKS,
  TECH_STACK,
  UNKNOWN_TEXT,
  osLabel,
  runtimeRows,
  techVersionText,
} from "../src/renderer/features/settings/about-info.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("关于：外链表两侧同源（Rust 只认表里的键，渲染层的地址与它逐条相等）", () => {
  const rust = read("src-tauri/src/about.rs");
  const table = rust.slice(rust.indexOf("pub const LINKS"), rust.indexOf("];"));
  const rustLinks = [...table.matchAll(/\("([a-z0-9-]+)", "([^"]+)"\)/g)].map((found) => [found[1], found[2]]);
  const rendererLinks = [...PROJECT_LINKS, ...REFERENCE_LINKS].map((link) => [link.key, link.url]);
  assert.ok(rustLinks.length >= 9, `Rust 侧要有固定表：${rustLinks.length}`);
  assert.deepEqual(rendererLinks, rustLinks, "键与地址逐条一致、顺序一致");
  assert.equal(new Set(rendererLinks.map(([key]) => key)).size, rendererLinks.length, "键不许重复");
  for (const [key, url] of rendererLinks) assert.match(url, /^https:\/\/github\.com\//, `${key} 只放 GitHub 的 https 地址`);
});

test("关于：开源地址就是本仓库，Releases / Issues / 许可证都从它派生", () => {
  const byKey = Object.fromEntries(PROJECT_LINKS.map((link) => [link.key, link.url]));
  assert.equal(byKey.repository, "https://github.com/Solathis/HWMusic");
  assert.equal(byKey.releases, `${byKey.repository}/releases`);
  assert.equal(byKey.issues, `${byKey.repository}/issues`);
  assert.equal(byKey.license, `${byKey.repository}/blob/main/LICENSE`);
  assert.match(read("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/, "许可证文案说的是 AGPL，文件也是");
});

test("关于：技术栈版本与 package-lock.json 逐条一致（升级依赖忘了改这里会红）", () => {
  const packages = JSON.parse(read("package-lock.json")).packages;
  const pinned = TECH_STACK.filter((entry) => entry.package !== undefined);
  assert.ok(pinned.length >= 7, "至少列出界面、类型、构建、样式、组件、原语、歌词");
  for (const entry of pinned) {
    assert.equal(entry.version, packages[`node_modules/${entry.package}`]?.version, `${entry.name}（${entry.package}）`);
  }
  for (const name of ["Tauri", "React", "TypeScript", "Vite", "Tailwind CSS", "shadcn/ui", "AMLL", "Node.js"]) {
    assert.ok(TECH_STACK.some((entry) => entry.name === name), `技术栈缺 ${name}`);
  }
});

test("关于：Tauri 版本来自宿主回报，没回报就显示占位，不写死", () => {
  const tauri = TECH_STACK.find((entry) => entry.name === "Tauri");
  assert.equal(tauri.source, "host");
  assert.equal(tauri.version, undefined, "不在渲染层写死 Tauri 版本");
  assert.equal(techVersionText(tauri, { tauriVersion: "2.12.4" }), "2.12.4");
  assert.equal(techVersionText(tauri, null), UNKNOWN_TEXT);
  assert.equal(techVersionText(tauri, { tauriVersion: "" }), UNKNOWN_TEXT);
  assert.equal(techVersionText(TECH_STACK.find((entry) => entry.name === "Node.js"), null), "内置");
});

test("关于：版本 / 系统 / WebView 三行如实显示宿主回报，缺值显示占位", () => {
  const full = runtimeRows({ version: "0.2.0", tauriVersion: "2.12.4", webviewVersion: "131.0.2903.70", os: "windows", arch: "x86_64" });
  assert.deepEqual(full.map((row) => [row.id, row.label, row.value]), [
    ["version", "版本", "0.2.0"],
    ["os", "系统", "Windows x86_64"],
    ["webview", "WebView", "131.0.2903.70"],
  ]);
  assert.deepEqual(runtimeRows(null).map((row) => row.value), [UNKNOWN_TEXT, UNKNOWN_TEXT, UNKNOWN_TEXT]);
  assert.equal(runtimeRows({ version: "0.2.0", webviewVersion: null }).at(2).value, UNKNOWN_TEXT, "WebView 取不到时不编一个");
  assert.equal(osLabel("macos"), "macOS");
  assert.equal(osLabel("freebsd"), "freebsd", "认不出的系统名原样显示");
});

test("关于：两条命令同源、进白名单、过主窗守卫；外链只传键，opener 不注册、不给 webview 权限", () => {
  const commands = read("src/shared/commands.ts");
  assert.match(commands, /CORE_APP_INFO = "core_app_info"/);
  assert.match(commands, /CORE_OPEN_LINK = "core_open_link"/);

  const hostApi = read("src/renderer/host-api.ts");
  assert.match(hostApi, /invoke<AppInfo>\(CORE_APP_INFO\)/, "版本信息走共享常量");
  assert.match(hostApi, /invoke<void>\(CORE_OPEN_LINK, \{ key \}\)/, "外链只传键");

  const lib = read("src-tauri/src/lib.rs");
  const handlers = lib.slice(lib.indexOf("invoke_handler(tauri::generate_handler!["), lib.indexOf("])", lib.indexOf("invoke_handler(tauri::generate_handler![")));
  assert.match(handlers, /about::core_app_info/);
  assert.match(handlers, /about::core_open_link/);
  assert.match(lib, /^mod about;$/m);
  assert.doesNotMatch(lib, /tauri_plugin_opener/, "不注册 opener 插件（注册会给登录页也注入点击拦截脚本）");

  const about = read("src-tauri/src/about.rs");
  assert.equal(about.match(/require_main_webview\(webview\.label\(\)\)\?/g)?.length, 2, "两条命令都过主窗来源守卫");
  assert.match(about, /pub async fn core_open_link\(webview: Webview, key: String\)/, "参数是键，不是 URL");
  assert.match(about, /tauri_plugin_opener::open_url\(url, None::<&str>\)/);

  for (const file of readdirSync(new URL("../src-tauri/capabilities/", import.meta.url))) {
    assert.doesNotMatch(read(`src-tauri/capabilities/${file}`), /opener:/, `${file} 不许给 opener 权限`);
  }
  assert.match(read("src-tauri/Cargo.toml"), /^tauri-plugin-opener = "=2\.7\.2"$/m);
});

test("关于：第五类设置，只用 shadcn 原语，链接一律交宿主打开", () => {
  const pages = read("src/renderer/pages.tsx");
  assert.ok(pages.includes('import { AboutPane } from "./about-pane.tsx"'));
  assert.match(pages, /<TabsContent value="about"[^>]*>\s*<AboutPane \/>\s*<\/TabsContent>/);

  const pane = read("src/renderer/about-pane.tsx");
  for (const module of ["./components/ui/card", "./components/ui/table", "./components/ui/button"]) {
    assert.ok(pane.includes(`from "${module}"`), `用 shadcn 的 ${module}`);
  }
  assert.ok(pane.includes("getAppInfo") && pane.includes("openLink"), "版本问宿主、外链交宿主");
  assert.doesNotMatch(pane, /<a\s|window\.open|location\.href|target="_blank"/, "不在 webview 里直接导航");
  assert.doesNotMatch(pane, /style=\{/, "不写行内样式");
  assert.match(pane, /aria-label=\{`打开\$\{link\.label\}`\}/, "每个「打开」按钮说清打开的是什么");
});
