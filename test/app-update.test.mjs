/**
 * 在线更新：渲染层状态机与文案、发布说明分组、命令与广播同源、最小权限、正常退出里的安装顺序、更新器配置。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  CHECK_FAILED_FALLBACK,
  INSTALL_FAILED_FALLBACK,
  RELEASE_NOTE_LIMIT,
  UPDATE_IDLE,
  failureText,
  progressPercent,
  progressText,
  releaseNoteGroups,
  updateReducer,
  updateView,
} from "../src/renderer/features/settings/update-state.mjs";
import { CORE_UPDATE_CHECK, CORE_UPDATE_INSTALL } from "../src/shared/commands.ts";
import { BROADCAST_CHANNELS, UPDATE_PROGRESS } from "../src/shared/channels.ts";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const run = (actions, start = UPDATE_IDLE) => actions.reduce(updateReducer, start);
const available = { available: true, currentVersion: "0.2.0", version: "0.3.0", notes: "### 新增\n- 关于页" };

test("在线更新：检查 → 已是最新 / 发现新版本，任何时候只有一个主按钮", () => {
  assert.deepEqual(updateView(UPDATE_IDLE).actionLabel, "检查更新");
  const checking = run([{ type: "check" }]);
  assert.equal(updateView(checking).busy, true, "检查中按钮禁用");
  const latest = run([{ type: "check" }, { type: "checked", answer: { available: false, currentVersion: "0.3.0" } }]);
  assert.equal(updateView(latest).status, "已是最新版本");
  assert.equal(updateView(latest).actionLabel, "检查更新");
  const found = run([{ type: "check" }, { type: "checked", answer: available }]);
  assert.equal(updateView(found).status, "发现新版本 0.3.0");
  assert.equal(updateView(found).actionLabel, "下载并安装", "有新版本时主按钮就是安装，不再并排一个「检查更新」");
  assert.equal(updateView(found).notes, available.notes);
});

test("在线更新：下载进度跟着宿主广播走，进入安装后不再显示进度条", () => {
  const found = run([{ type: "check" }, { type: "checked", answer: available }]);
  const downloading = run([{ type: "install" }, { type: "progress", event: { phase: "downloading", downloaded: 2000000, total: 4000000 } }], found);
  const view = updateView(downloading);
  assert.equal(view.busy, true);
  assert.equal(view.showProgress, true);
  assert.equal(view.percent, 50);
  assert.equal(view.progressText, "已下载 1.9 MB / 3.8 MB");
  const installing = run([{ type: "progress", event: { phase: "installing" } }], downloading);
  assert.equal(updateView(installing).status, "正在安装，完成后应用会自动重启。");
  assert.equal(updateView(installing).showProgress, false);
  assert.equal(updateView(installing).busy, true, "安装中不许再点");
  assert.deepEqual(run([{ type: "progress", event: { phase: "downloading", downloaded: 5 } }]), UPDATE_IDLE, "没在下载时进度广播不改状态");
});

test("在线更新：失败说原因与下一步，重试回到对应的那一步", () => {
  const failedCheck = run([{ type: "check" }, { type: "check-failed", message: "连不上 GitHub 的更新服务器：检查网络，或在「网络」里配置 HTTP 代理后重试。" }]);
  assert.equal(updateView(failedCheck).failureTitle, "检查更新失败");
  assert.match(updateView(failedCheck).failureMessage, /HTTP 代理/);
  assert.equal(updateView(failedCheck).actionLabel, "检查更新", "检查失败就重新检查（不另放一个「重试」）");
  assert.equal(run([{ type: "install" }], failedCheck), failedCheck, "检查失败时没有可装的版本");

  const found = run([{ type: "check" }, { type: "checked", answer: available }]);
  const failedInstall = run([{ type: "install" }, { type: "progress", event: { phase: "failed", message: "配置还没全部保存（超时），更新没有安装。请再点一次「下载并安装」。" } }], found);
  assert.equal(updateView(failedInstall).failureTitle, "更新没能完成");
  assert.equal(updateView(failedInstall).actionLabel, "下载并安装", "安装失败就重新下载安装");
  assert.equal(updateView(failedInstall).status, "新版本 0.3.0");
  assert.equal(run([{ type: "install" }], failedInstall).phase, "downloading");
  assert.equal(run([{ type: "install-failed" }], run([{ type: "install" }], found)).message, INSTALL_FAILED_FALLBACK, "没给原因时用兜底文案");
  assert.equal(run([{ type: "check" }, { type: "check-failed" }]).message, CHECK_FAILED_FALLBACK);
});

test("在线更新：只原样显示宿主翻译好的 update 类失败，原始错误不进界面", () => {
  assert.equal(failureText({ kind: "update", message: "请先检查更新。" }, CHECK_FAILED_FALLBACK), "请先检查更新。");
  assert.equal(failureText({ kind: "internal", message: "command core_update_check not found" }, CHECK_FAILED_FALLBACK), CHECK_FAILED_FALLBACK);
  assert.equal(failureText(new Error("reqwest error"), INSTALL_FAILED_FALLBACK), INSTALL_FAILED_FALLBACK);
  assert.equal(failureText({ kind: "update", message: "  " }, INSTALL_FAILED_FALLBACK), INSTALL_FAILED_FALLBACK);
});

test("在线更新：进度百分比与文案（总大小未知时只说已下载多少）", () => {
  assert.equal(progressPercent(0, 4000000), 0);
  assert.equal(progressPercent(4000000, 4000000), 100);
  assert.equal(progressPercent(5000000, 4000000), 100, "不超过 100");
  assert.equal(progressPercent(100, null), null);
  assert.equal(progressText(1048576, null), "已下载 1.0 MB");
});

test("在线更新：发布说明按「### 分类」分组，条目去掉列表符号", () => {
  assert.deepEqual(releaseNoteGroups("### 新增\n- 关于页\n- 在线更新\n\n### 修复\n* 时长显示"), [
    { title: "新增", items: ["关于页", "在线更新"] },
    { title: "修复", items: ["时长显示"] },
  ]);
  assert.deepEqual(releaseNoteGroups("- 只有条目"), [{ title: "", items: ["只有条目"] }]);
  assert.deepEqual(releaseNoteGroups("### 空分类\n### 新增\n- 一条"), [{ title: "新增", items: ["一条"] }], "空分类不显示");
  assert.deepEqual(releaseNoteGroups(""), []);
  assert.deepEqual(releaseNoteGroups(null), []);
  const many = ["### 新增", ...Array.from({ length: 20 }, (_, index) => `- 第 ${index} 条`)].join("\n");
  assert.equal(releaseNoteGroups(many)[0].items.length, RELEASE_NOTE_LIMIT);
});

test("在线更新：两条命令与进度广播同源；插件只从 Rust 调，webview 没有 updater 权限", () => {
  assert.equal(CORE_UPDATE_CHECK, "core_update_check");
  assert.equal(CORE_UPDATE_INSTALL, "core_update_install");
  assert.equal(UPDATE_PROGRESS, "update:progress");
  assert.ok(BROADCAST_CHANNELS.includes(UPDATE_PROGRESS), "进度广播在白名单里");
  assert.match(read("src-tauri/src/bridge.rs"), /pub const UPDATE_PROGRESS: &str = "update:progress";/);

  const hostApi = read("src/renderer/host-api.ts");
  assert.match(hostApi, /invoke<UpdateCheck>\(CORE_UPDATE_CHECK\)/);
  assert.match(hostApi, /invoke<void>\(CORE_UPDATE_INSTALL\)/);

  const lib = read("src-tauri/src/lib.rs");
  const handlers = lib.slice(lib.indexOf("invoke_handler(tauri::generate_handler!["), lib.indexOf("])", lib.indexOf("invoke_handler(tauri::generate_handler![")));
  assert.match(handlers, /app_update::core_update_check/);
  assert.match(handlers, /app_update::core_update_install/);
  assert.match(lib, /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
  assert.match(lib, /app\.manage\(app_update::UpdateState::default\(\)\)/);

  const rust = read("src-tauri/src/app_update.rs");
  assert.equal(rust.match(/require_main_webview\(webview\.label\(\)\)\?/g)?.length, 2, "两条命令都过主窗来源守卫");
  assert.match(rust, /read_update_proxy/, "更新请求读设置里的代理");
  assert.match(rust, /None => builder\.no_proxy\(\)/, "没配代理就直连（与 sidecar 一致）");

  for (const file of readdirSync(new URL("../src-tauri/capabilities/", import.meta.url))) {
    assert.doesNotMatch(read(`src-tauri/capabilities/${file}`), /updater:/, `${file} 不许给 updater 权限`);
  }
  assert.match(read("src-tauri/Cargo.toml"), /^tauri-plugin-updater = "=2\.14\.1"$/m);
});

test("在线更新：安装挂在正常退出里——收掉 sidecar 之后、退出之前；准备失败就收回安装包，提示只说一次", () => {
  const lib = read("src-tauri/src/lib.rs");
  const commit = lib.slice(lib.indexOf("fn commit_exit<"), lib.indexOf("fn abort_exit<"));
  const shutdown = commit.indexOf("commands::shutdown_core(");
  const install = commit.indexOf("app_update::install_pending(app)");
  const exit = commit.indexOf("app.exit(0)", install);
  assert.ok(shutdown > -1 && install > shutdown, "sidecar 收尸之后才安装（否则安装程序覆盖不了正在运行的内核）");
  assert.ok(exit > install, "安装在 app.exit(0) 之前");
  assert.ok(commit.indexOf(".store(true, std::sync::atomic::Ordering::Release)") < install, "先标记已提交退出，安装失败时的重启不会被拦下");

  const abort = lib.slice(lib.indexOf("fn abort_exit<"), lib.indexOf("fn run_exit<"));
  assert.match(abort, /if !app_update::abort_pending\(app, reason\) \{/, "为安装更新而退出时，只由更新区说明失败");
  assert.match(abort, /APP_NOTICE/, "普通退出失败仍有可操作提示");

  const rust = read("src-tauri/src/app_update.rs");
  const installPending = rust.slice(rust.indexOf("pub fn install_pending<"), rust.indexOf("pub fn abort_pending<"));
  assert.match(installPending, /update\.install\(&bytes\)/);
  assert.match(installPending, /app\.restart\(\)/, "装不上也要重启回当前版本，不留半关的应用");
});

test("在线更新：更新器只信本仓库 Releases 的 latest.json，公钥是 minisign 公钥，Windows 用 passive 安装", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const updater = config.plugins?.updater;
  assert.deepEqual(updater?.endpoints, ["https://github.com/Solathis/HWMusic/releases/latest/download/latest.json"]);
  assert.equal(updater?.windows?.installMode, "passive");
  assert.match(Buffer.from(updater?.pubkey ?? "", "base64").toString("utf8"), /^untrusted comment: minisign public key: [0-9A-F]{16}\r?\n[A-Za-z0-9+/=]{56}\r?\n?$/);
  assert.notEqual(config.bundle?.createUpdaterArtifacts, true, "签名产物只在有私钥的构建里打开（见 dist:win）");
});
