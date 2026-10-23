#!/usr/bin/env node
/**
 * `npm run test:acceptance`：六条关键路径的验收（源码级 / 纯函数级）。
 *
 * ## 口径
 *
 * - **不复制断言逻辑**：每条路径都**引用既有测试文件**（R3–R13 已钉的那些）并跑一遍，
 *   外加少量**源码锚点**（正则），锚点只用来回答"这条路径的落点还在不在"。
 *   把断言抄第二份必然漂移——漂移的那一份才是"验收通过"的假证据。
 * - **SKIP 不算 PASS**：引用的测试里有 `skipped > 0` 就判失败。跳过等于没验，
 *   而"没验"不能算过。
 * - **锚点缺失要停**：`Rx` 的测试文件或锚点文件不见了，直接失败并点名，
 *   绝不静默跳过（静默跳过的验收脚本比没有验收脚本更糟）。
 * - **Rust 源码先剥注释再断言**：本项目的源码注释里写满了"绝不 SetWindowsHookEx"这类
 *   自我约束，grep 会把注释数成命中。
 * - 退出码 0 = 六条路径零 FAIL。
 *
 * ## 六条路径
 *
 * | id | 路径 | 它证明什么 |
 * |---|---|---|
 * | `login-gate` | 登录门禁 | 未登录不渲染主界面；扫码回调只拦 `hms://` |
 * | `proxy` | 代理 | 单一真源 settings.json + 三窗接线 + 凭据纪律 |
 * | `tray` | 托盘 | 托盘 9 槽位 + 关窗 fail-safe（托盘真装上才藏窗口） |
 * | `desktop-lyrics` | 桌面歌词 | 独立透明窗 + 几何纯函数 + 不回写 |
 * | `taskbar-fallback-no-injection` | Windows 内嵌 Beta | 保留路径 id；仅新模块受限自窗授权，禁 DLL/全局 Hook |
 * | `settings-persistence` | 设置持久化 | settings.json 形状 + DPAPI 会话信封 |
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 无注入扫描扫这棵树。 */
export const SCAN_ROOTS = ["src", "src-tauri/src", "src-tauri/tests", "scripts"];
/** 不扫这些目录（生成物 / 依赖 / 会话资料）。 */
export const SCAN_SKIP_DIRS = ["node_modules", "target", "out", "gen", ".git", ".tmp", ".superpowers", "dist"];
/**
 * 无注入 token 的真源：R12 已钉的那份清单（这里解析它，不抄一份）。
 *
 * 扫描范围是"生产树 + scripts"，**不含 `test/`**：那条红线自己的 token 清单就写在测试文件里
 * （`test/lyrics-window.test.mjs` 的 `banned` 数组），把 test/ 也扫进去等于让清单命中自己。
 * 同理，本文件里的 canary 用拼接写法——否则扫描器会命中它自己写的那个字面量。
 */
export const BANNED_TOKEN_SOURCE = "test/lyrics-window.test.mjs";
/** canary：清单解析成功的最低证据（拼接写，见上）。 */
const CANARY_TOKEN = ["SetWindows", "HookEx"].join("");

/**
 * 六条关键路径。
 *
 * `anchors` 是"落点还在不在"的正则；`scanTree` 只有那条无注入路径有。
 */
export const ACCEPTANCE_PATHS = [
  {
    id: "login-gate",
    title: "登录门禁：未登录不渲染主界面",
    why: "官方登录页没有应用权限，所以门禁必须在渲染层真的挡住主界面；回调只拦 hms://",
    tests: ["test/login-gate.test.mjs", "test/login-callback.test.mjs"],
    anchors: [
      { file: "src/renderer/features/auth/login-gate-logic.mjs", pattern: /export function shouldShowLoginGate/, why: "门禁判定是纯函数（唯一真源）" },
      { file: "src/renderer/App.tsx", pattern: /shouldShowLoginGate\(gate\.state\)/, why: "外壳真的按判定挡在渲染之前" },
      { file: "src/renderer/App.tsx", pattern: /<LoginGate gate=\{gate\} \/>/, why: "挡住时渲染登录门禁" },
      { file: "src/renderer/login-gate.tsx", pattern: /reduceGateState/, why: "门禁状态机来自纯逻辑模块" },
    ],
  },
  {
    id: "proxy",
    title: "代理：单一真源 + 三窗接线",
    why: "漏接任一窗口的 proxy_url，封面图与音频流就会绕过用户设置的代理直连（旧仓实际缺陷）",
    tests: ["test/proxy.test.mjs", "test/proxy-settings.test.mjs", "test/settings-test-proxy.test.mjs"],
    anchors: [
      { file: "src/main/proxy.mjs", pattern: /ProxyAgent/, why: "sidecar 出口走 undici 的 ProxyAgent" },
      { file: "src/renderer/features/settings/settings-form.mjs", pattern: /proxy/, why: "设置页的形状校验来自纯逻辑模块" },
      { file: "src-tauri/src/webview_proxy.rs", pattern: /pub fn describe/, why: "webview 侧只吃 http://host:port（凭据必须丢弃）" },
    ],
  },
  {
    id: "tray",
    title: "托盘与关窗行为",
    why: "托盘没装上却把窗口藏了 = 用户关一次窗就再也找不回应用（旧仓缺陷）",
    tests: ["test/tray.test.mjs", "test/close-behavior.test.mjs"],
    anchors: [
      { file: "src-tauri/src/tray.rs", pattern: /let Some\(tray\) = app\.tray_by_id\(crate::TRAY_ID\) else \{ return false; \}/, why: "关窗决策现场查托盘句柄，缺失就不可用" },
      { file: "src-tauri/src/tray.rs", pattern: /return check_registration\(tray\.rect\(\)\.map_err\(\|error\| error\.to_string\(\)\)\)\.is_ok\(\)/, why: "Windows 还须查真实 Shell 注册位置，不能仅凭内部句柄" },
      { file: "src-tauri/src/tray.rs", pattern: /CloseAction::PreventAndHide/, why: "托盘可用才藏窗口" },
      { file: "src-tauri/src/close_behavior.rs", pattern: /CLOSE_BEHAVIOR_TRAY/, why: "closeBehavior 字面量与 settings 同源" },
    ],
  },
  {
    id: "desktop-lyrics",
    title: "桌面歌词窗",
    why: "歌词窗是独立透明窗（不注入、不共享会话），几何是纯函数",
    tests: ["test/lyrics-window.test.mjs", "test/lyrics-panel.test.mjs"],
    anchors: [
      { file: "src-tauri/src/lyrics_window.rs", pattern: /pub fn desktop_position/, why: "桌面模式几何是纯函数" },
      { file: "src-tauri/src/lyrics_window.rs", pattern: /pub fn taskbar_position/, why: "任务栏模式几何是纯函数" },
      { file: "src/renderer/LyricsWindow.tsx", pattern: /@applemusic-like-lyrics\/react/, why: "歌词窗视觉全部来自 AMLL 官方组件" },
    ],
  },
  {
    id: "taskbar-fallback-no-injection",
    title: "Windows 任务栏歌词 Beta（受限自窗内嵌）",
    why: "仅新 taskbar 模块获精确自窗附着授权；未知占用停显，仍禁注入与全局系统钩子",
    tests: ["test/lyrics-window.test.mjs"],
    anchors: [
      { file: "src-tauri/src/taskbar_lyrics.rs", pattern: /pub fn safe_slot/, why: "父客户区与占用差集决定安全空白" },
      { file: "src-tauri/src/taskbar_lyrics.rs", pattern: /fn ensure_own/, why: "所有原生写前核自窗创建代次与 owner 线程" },
    ],
    scanTree: { roots: SCAN_ROOTS, skipDirs: SCAN_SKIP_DIRS, tokenSource: BANNED_TOKEN_SOURCE, minFiles: 40 },
  },
  {
    id: "settings-persistence",
    title: "设置持久化",
    why: "设置是单一真源 settings.json；会话是 DPAPI 信封（读不出来要说清楚，不能当「没登录」）",
    tests: ["test/settings-test-proxy.test.mjs", "test/session-store.test.mjs", "test/settings-page.test.mjs"],
    anchors: [
      { file: "src/main/settings.mjs", pattern: /export const SETTINGS_SCHEMA_VERSION = 1/, why: "schema 版本与 Rust 侧同名字面量" },
      { file: "src/main/settings.mjs", pattern: /SETTINGS_FILE_NAME = "settings\.json"/, why: "落盘文件名是常量真源" },
      { file: "src-tauri/src/secure_store.rs", pattern: /CryptProtectData/, why: "会话加密走 DPAPI" },
      { file: "src-tauri/src/secure_store.rs", pattern: /CryptUnprotectData/, why: "会话解密走 DPAPI" },
    ],
  },
];

/** Rust/TS 注释剥离：自我约束常写在注释里，不能把注释数成命中。 */
export function stripComments(source, file = "") {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if (file.endsWith(".rs")) {
    return withoutBlock
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }
  return withoutBlock.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * 从既有测试里解析"禁止出现的 token 清单"。
 *
 * 引用而不是复制：清单的真源是 R12 的测试（它才是钉住这条红线的那份断言），
 * 这里只把它读出来做**更大范围**的扫描（多扫 `src-tauri/tests/` 与 `scripts/`）。
 */
export function parseBannedTokens(source) {
  const match = /const banned = \[([\s\S]*?)\];/.exec(source);
  if (match === null) return [];
  const tokens = [];
  for (const found of match[1].matchAll(/"([^"]+)"/g)) tokens.push(found[1]);
  return tokens;
}

/**
 * 锚点是不是**负向**的（"这个东西不该再出现"，例如无注入那条红线的补充锚点）。
 *
 * 判据两选一，都写在锚点自己身上：
 * - 显式 `absent: true`（新锚点优先这么写）；
 * - 或者 `why` 里已经写明"不存在 / 不该 / 不许 / 绝不 / 不得 / 没有"——这类锚点的**落点是"没有"**，
 *   命中反而是坏消息。判据只看锚点声明，不去猜被扫源码的语义。
 */
export function isAbsenceAnchor(anchor) {
  if (anchor?.absent === true) return true;
  return /不存在|不该|不许|绝不|不得|没有/.test(anchor?.why ?? "");
}

/**
 * 锚点检查（纯函数）：返回没命中的锚点描述。
 *
 * 正向锚点（默认）：源码里**找不到**就是没命中。
 * 负向锚点（见 `isAbsenceAnchor`）：源码里**找到了**才算没命中——"绝不 SetWindowsHookEx"
 * 这类自我约束必须能表达成断言，否则只能扫 token 表，漏一个就是一个洞。
 */
export function anchorMisses(anchors, readSource) {
  const misses = [];
  for (const anchor of anchors) {
    let source;
    try {
      source = readSource(anchor.file);
    } catch (cause) {
      misses.push(`${anchor.file} 读不了：${cause?.message ?? cause}（锚点：${anchor.why}）`);
      continue;
    }
    const hit = anchor.pattern.test(stripComments(source, anchor.file));
    if (isAbsenceAnchor(anchor)) {
      if (hit) misses.push(`${anchor.file} 里出现了本该没有的 ${anchor.pattern}（负向锚点：${anchor.why}）`);
      continue;
    }
    if (!hit) {
      misses.push(`${anchor.file} 里找不到 ${anchor.pattern}（锚点：${anchor.why}）`);
    }
  }
  return misses;
}

/** 一条路径的判定：有 FAIL 或**有 SKIP**都算不过。 */
export function pathVerdict({ pass, fail, skipped }) {
  if (fail > 0) return "FAIL";
  if (skipped > 0) return "FAIL";
  return pass > 0 ? "PASS" : "FAIL";
}

/** 汇总行：`PASS n / SKIP 0 / FAIL m`（CI 直接断言这一行）。 */
export function formatSummary(pathResults) {
  const passed = pathResults.filter((result) => result.verdict === "PASS").length;
  const failed = pathResults.filter((result) => result.verdict === "FAIL").length;
  const skippedTests = pathResults.reduce((total, result) => total + (result.counts?.skipped ?? 0), 0);
  return `acceptance 六路径：PASS ${passed} / SKIP ${skippedTests} / FAIL ${failed}`;
}

/** 列出扫描范围内的源码文件。 */
export function scanFiles(roots = SCAN_ROOTS, skipDirs = SCAN_SKIP_DIRS, root = ROOT) {
  const files = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        walk(child);
        continue;
      }
      if (/\.(rs|ts|tsx|mjs|js)$/.test(entry.name)) files.push(child);
    }
  };
  for (const relative of roots) walk(relative);
  return files;
}

export const TASKBAR_NATIVE_FILE = "src-tauri/src/taskbar_lyrics.rs";
const TASKBAR_ALLOWED = new Set([["Set", "Parent"], ["Find", "WindowW"], ["Find", "WindowExW"], ["Shell_", "TrayWnd"], ["explorer", ".exe"]].map((parts) => parts.join("")));
export function nativeTokenAllowed(file, token) { return file === TASKBAR_NATIVE_FILE && TASKBAR_ALLOWED.has(token); }

export function taskbarWriteViolations(source) {
  const code = stripComments(source, TASKBAR_NATIVE_FILE);
  const mutations = ["Set" + "Parent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "SetWindowSubclass", "EnableWindow"];
  const violations = [];
  for (const name of mutations) {
    for (const hit of code.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*([^,\\n]*)`, "g"))) {
      const target = hit[1].trim();
      if (!/^ensure_own\(/.test(target)) violations.push(`${name}: ${target}`);
    }
  }
  return violations;
}

/** 全源码扫描：返回命中项（token 清单来自既有测试）。 */
export function scanForTokens({ root = ROOT, tokens, roots = SCAN_ROOTS, skipDirs = SCAN_SKIP_DIRS } = {}) {
  const files = scanFiles(roots, skipDirs, root);
  const offenders = [];
  for (const relative of files) {
    const source = stripComments(readFileSync(path.join(root, relative), "utf8"), relative);
    for (const token of tokens) {
      if (source.includes(token) && !nativeTokenAllowed(relative, token)) offenders.push(`${relative}: ${token}`);
    }
    if (relative === TASKBAR_NATIVE_FILE) offenders.push(...taskbarWriteViolations(source).map((v) => `${relative}: foreign-write ${v}`));
  }
  return { files, offenders };
}

/** 跑一组测试文件，解析 TAP 计数（npm test 用的是同一套 reporter，口径一致）。 */
export function runTests(files, { root = ROOT, timeoutMs = 600_000 } = {}) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const count = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, "m").exec(output);
    return match === null ? 0 : Number(match[1]);
  };
  return {
    code: result.status,
    pass: count("pass"),
    fail: count("fail"),
    skipped: count("skipped"),
    output,
  };
}

/** 逐条跑六条路径。 */
export async function runAcceptance({ root = ROOT, log = console.log } = {}) {
  const results = [];
  for (const acceptancePath of ACCEPTANCE_PATHS) {
    const tests = runTests(acceptancePath.tests, { root });
    const misses = anchorMisses(acceptancePath.anchors, (file) => readFileSync(path.join(root, file), "utf8"));

    const problems = [];
    const notes = [];
    const counts = { pass: tests.pass, fail: tests.fail, skipped: tests.skipped };
    if (tests.code !== 0) problems.push(`引用的测试退出码 ${tests.code}（pass ${tests.pass} / fail ${tests.fail} / skip ${tests.skipped}）`);
    if (tests.pass === 0) problems.push("引用的测试一个都没跑起来（文件没被解析？）");
    problems.push(...misses);

    if (acceptancePath.scanTree) {
      const tokens = parseBannedTokens(readFileSync(path.join(root, acceptancePath.scanTree.tokenSource), "utf8"));
      if (!tokens.includes(CANARY_TOKEN)) {
        problems.push(`无注入 token 表解析失败（真源 ${acceptancePath.scanTree.tokenSource} 的形状变了）——扫描等于没扫`);
      }
      const { files, offenders } = scanForTokens({
        root,
        tokens,
        roots: acceptancePath.scanTree.roots,
        skipDirs: acceptancePath.scanTree.skipDirs,
      });
      if (files.length < acceptancePath.scanTree.minFiles) {
        problems.push(`扫描范围异常：只有 ${files.length} 个文件（下限 ${acceptancePath.scanTree.minFiles}）`);
      }
      problems.push(...offenders.map((offender) => `注入红线命中：${offender}`));
      notes.push(`无注入扫描：${tokens.length} 类 token × ${files.length} 个文件 → ${offenders.length} 命中`);
    }

    const verdict = problems.length > 0 ? "FAIL" : pathVerdict(counts);
    const record = { id: acceptancePath.id, title: acceptancePath.title, verdict, counts, problems, notes };
    results.push(record);

    log(`${verdict.padEnd(4)} ${acceptancePath.id.padEnd(30)} ${acceptancePath.title}`);
    log(`     R3–R13 引用测试：pass ${counts.pass} / fail ${counts.fail} / skip ${counts.skipped}`);
    for (const note of notes) log(`     ${note}`);
    for (const problem of problems) log(`     ✖ ${problem}`);
  }

  log("");
  log(formatSummary(results));
  return results;
}

async function main() {
  const results = await runAcceptance();
  const failed = results.filter((result) => result.verdict === "FAIL");
  if (failed.length > 0) {
    console.error(`acceptance 失败 ${failed.length} 条：${failed.map((result) => result.id).join("、")}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`acceptance 失败：${cause.message}`);
    process.exit(1);
  });
}
