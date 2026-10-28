#!/usr/bin/env node
/**
 * `npm run test:acceptance`：六条关键路径的验收（源码级 / 纯函数级），退出码 0 = 六条路径零 FAIL。
 * **不复制断言逻辑**：每条路径都**引用既有测试文件**并跑一遍，外加少量**源码锚点**（正则），锚点只用来回答这条路径的落点还在不在。
 * **SKIP 不算 PASS**：引用的测试里有 `skipped > 0` 就判失败。
 * **锚点缺失要停**：测试文件或锚点文件不见了，直接失败并点名，绝不静默跳过；Rust 源码先剥注释再断言，否则注释里的自我约束会被数成命中。
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
 * 无注入 token 的真源：解析已钉的那份清单而不抄一份；扫描范围是生产树 + scripts，**不含 `test/`**，否则清单会命中自己。
 * 本文件的 canary 同理用拼接写法，免得扫描器命中自己写的字面量。
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
      { file: "src/renderer/App.tsx", pattern: /startupViewOf\(gate\.state\)/, why: "外壳真的按三态判定挡在渲染之前（R45A1：checking 是中性启动屏，不是登录页）" },
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

/**
 * Rust 注释剥离**认得字面量**：字符串 / raw / 字符字面量里的 `//`、`/*` 是内容；未闭合串余下原文照抄、不剥注释（fail closed）。
 * 块注释可以嵌套（按深度计数），遇到第一个收尾就停会让后面的 `//` 把真实写整行剥掉；注释一律换分隔空白，绝不删除。
 */
function stripRustComments(source) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const raw = rustRawString(source, i);
    if (raw !== null) {
      // 未结束的 raw：原样留到末尾（交给扫描阶段 fail closed），剥注释不做任何猜测。
      const end = raw.close < 0 ? source.length - 1 : raw.end;
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = ch === '"' ? rustStringEnd(source, i) : rustCharEnd(source, i);
      if (end < 0) {
        // 多行普通串已经由 `rustStringEnd` 认下来（裸 LF 合法），走到这里只剩字符/生命周期（当一个普通字节照抄），或者**未闭合/裸 CR** 的普通字符串。
        // 后者绝不许把余下源码当代码继续剥注释——那正是「注释剥离删掉真实写」的入口；余下原文一字不改地照抄，交给扫描阶段 fail closed。
        if (ch === '"') {
          out += source.slice(i);
          break;
        }
        out += ch;
        continue;
      }
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      // 注释一律换成**分隔空白**，不是「删掉」：注释是 token 分隔符，删掉会让 `SetParent/**\/as` 黏成一个标识符。
      // 换行照旧留给下一轮原样输出，行结构不变。
      out += " ";
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? source.length - 1 : newline - 1; // 换行保留，行结构不变
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      // Rust 块注释**可以嵌套**：深度计数到配对的 `*/`；取第一个 `*/` 会让
      // `/* outer /* inner */ // ignored */ real_write` 里的 `//` 把真实写剥掉。
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (source[j] === "*" && source[j + 1] === "/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      // 同上：已经删到末尾（未闭合，非法 Rust）时也吐一个分隔空白。
      const end = depth === 0 ? j : source.length;
      const newlines = source.slice(i, end).split("\n").length - 1;
      out += ` ${"\n".repeat(newlines)}`; // 分隔空白 + 原有换行（行结构不变）
      // 未闭合（非法 Rust）：吃到末尾；换行仍按原数量保留，只是内容换成空白。
      i = depth === 0 ? j - 1 : source.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Rust/TS 注释剥离：自我约束常写在注释里，不能把注释数成命中；注释一律换成**分隔空白**而不是删除。
 * 注释是 token 分隔符，删掉会把 `SetParent/**\/as` 黏成一个标识符。 */
export function stripComments(source, file = "") {
  if (file.endsWith(".rs")) return stripRustComments(source).replace(/\r\n/g, "\n");
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlock.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 从既有测试里解析「禁止出现的 token 清单」：引用而不是复制，真源是那条红线的测试，这里只读出来做**更大范围**的扫描。 */
export function parseBannedTokens(source) {
  const match = /const banned = \[([\s\S]*?)\];/.exec(source);
  if (match === null) return [];
  const tokens = [];
  for (const found of match[1].matchAll(/"([^"]+)"/g)) tokens.push(found[1]);
  return tokens;
}

/** 锚点是否**负向**（这个东西不该再出现）：显式 `absent: true`，或 `why` 里已写明不存在 / 不该 / 不许 / 绝不 / 不得 / 没有。 */
export function isAbsenceAnchor(anchor) {
  if (anchor?.absent === true) return true;
  return /不存在|不该|不许|绝不|不得|没有/.test(anchor?.why ?? "");
}

/** 锚点检查（纯函数）：返回没命中的锚点描述。正向锚点（默认）源码里**找不到**就是没命中；负向锚点（见 `isAbsenceAnchor`）源码里**找到了**才算没命中。 */
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

/** 写目标必须在调用现场当场复核（参数名不是凭证）：只放行 `self::ensure_own(...)` 和 `self::own_top_level(...)`。
 * `own_top_level` **只给 `SetWindowSubclass`**；样式/位置/父/显隐那几种写**不许**拿它当挡箭牌，实参必须恰好是 `self::<guard>(...)?`。 */
const WRITE_GUARDS = ["ensure_own", "own_top_level"];
const OPENERS = { "(": ")", "[": "]", "{": "}" };

/** 从 `open`（左括号）处扫到配对右括号，同时记下**顶层**（只在外层括号里）的第一个逗号。
 * 字面量整体跳过，raw 字符串按**同样多个 `#` 的引号**收尾；`close = -1` 表示不平衡，调用方必须按违规处理，绝不猜。 */
function scanBracket(text, open) {
  const stack = [];
  let firstComma = -1;
  for (let i = open; i < text.length; i += 1) {
    const raw = rustRawString(text, i);
    if (raw !== null) {
      // 未结束的 raw 不是"跨行普通字符串"，是解析失败：整段实参按未受核处理。
      if (raw.close < 0) return { close: -1, firstComma };
      i = raw.end;
      continue;
    }
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = ch === '"' ? rustStringEnd(text, i) : rustCharEnd(text, i);
      if (end < 0) {
        // 普通字符串跨行是合法的（裸 LF 是内容），所以走到这里只有"未闭合/裸 CR"这种解析失败。
        if (ch === '"') return { close: -1, firstComma };
        continue;
      }
      i = end;
      continue;
    }
    if (OPENERS[ch] !== undefined) {
      stack.push(OPENERS[ch]);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return { close: -1, firstComma };
      if (stack.length === 0) return { close: i, firstComma };
      continue;
    }
    if (ch === "," && stack.length === 1 && firstComma < 0) firstComma = i;
  }
  return { close: -1, firstComma };
}

/**
 * `text[start]` 起是不是 Rust raw 字符串（`r"…"`、`r#"…"#`、`br#"…"#`、`cr#"…"#`）。
 * 返回 `{ open, close, end }`：未结束 `close = -1`，不是 raw 开头返回 null；收尾须是**同样多个** `#` 紧跟引号，内部不处理反斜杠。
 * 前缀按 rustc 认 `r`/`br`/`cr`，另**故意**多认不合法的 `rb`：判据侧只会更保守。
 */
const RAW_PREFIXES = ["cr", "br", "rb", "r"];

function rustRawString(text, start) {
  const before = start === 0 ? "" : text[start - 1];
  if (/[A-Za-z0-9_]/.test(before)) return null; // 紧跟在标识符里：不是 raw 开头
  for (const prefix of RAW_PREFIXES) {
    if (!text.startsWith(prefix, start)) continue;
    const hashesStart = start + prefix.length;
    let quote = hashesStart;
    while (text[quote] === "#") quote += 1;
    if (text[quote] !== '"') continue;
    const hashes = quote - hashesStart;
    const close = text.indexOf(`"${"#".repeat(hashes)}`, quote + 1);
    return close < 0 ? { open: quote, close: -1, end: -1 } : { open: quote, close, end: close + hashes };
  }
  return null;
}

/** `text[start]` 是 `"`；返回收尾引号下标，未闭合返回 -1。裸 LF 是内容（跨行串），CRLF 是合法行尾，**裸 CR** 非法 → `-1`。
 * 规则照 rustc：`\` 加换行是**续行**，其它 `\x` 转义照旧跳过；解析失败调用方 fail closed 记账。 */
function rustStringEnd(text, start) {
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      const escaped = text[i + 1];
      if (escaped === undefined) return -1; // `\` 后没有字节：转义不完整
      if (escaped === "\r" && text[i + 2] !== "\n") return -1; // `\` + 裸 CR：不是合法转义
      i += 1; // 跳掉被转义的字节（`\` + LF 因此成为续行；`\` + CR + LF 里的 CR 也在这里被吃掉）
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] !== "\n") return -1; // 裸 CR 不是行尾：rustc 非法，fail closed
      i += 1; // CRLF 算一个行尾
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}

/** `text[start] === "'"`；是字符字面量就返回收尾下标，是生命周期/普通字符就返回 -1。 */
function rustCharEnd(text, start) {
  if (text[start + 1] === "\\") {
    const close = text.indexOf("'", start + 2);
    return close < 0 || close - start > 12 ? -1 : close;
  }
  const single = text[start + 1] !== undefined && text[start + 1] !== "'" && text[start + 2] === "'";
  return single ? start + 2 : -1;
}

/** 整个实参必须**恰好**是 `self::<guard>(...)?`；返回 guard 名，否则 null。**必须带 `self::`**：裸名可被 shadow。
 * 裸名 `ensure_own(...)` 会被同作用域绑定 shadow 掉，于是前缀检查全绿而写到外来句柄，`self::` 才走本模块的定义。 */
function exactGuardCall(argument) {
  const space = (from) => {
    let i = from;
    while (i < argument.length && /\s/.test(argument[i])) i += 1;
    return i;
  };
  for (const guard of WRITE_GUARDS) {
    let i = space(0);
    if (!argument.startsWith("self", i)) continue;
    i += 4;
    if (/[A-Za-z0-9_]/.test(argument[i] ?? "")) continue; // `selfish::…` 不是模块路径
    i = space(i);
    if (argument[i] !== ":" || argument[i + 1] !== ":") continue;
    i = space(space(i + 2));
    if (!argument.startsWith(guard, i)) continue;
    i = space(i + guard.length);
    if (argument[i] !== "(") return null;
    const close = scanBracket(argument, i).close;
    if (close < 0) return null;
    i = space(close + 1);
    if (argument[i] !== "?") return null;
    return argument.slice(i + 1).trim() === "" ? guard : null;
  }
  return null;
}

export function guardedWriteTarget(name, target) {
  const guard = exactGuardCall(target);
  if (guard === null) return false;
  if (guard === "ensure_own") return true;
  return name === "SetWindowSubclass";
}

/**
 * 写 API 的真名清单：对 HWND 的直接改写入口，HWND 是第一个实参；**只许扩、不许缩**，不是 Win32 全集。
 * `SetParent` 用拼接写，免得本文件被自己的 token 表扫到；类级写入口不在这里，归 `BLANKET_FORBIDDEN_APIS`。
 */
const MUTATION_APIS = [
  "Set" + "Parent",
  "SetWindowPos",
  "SetWindowLongPtrW",
  "ShowWindow",
  "SetWindowSubclass",
  "EnableWindow",
  "MoveWindow",
  "SetWindowLongW",
  "SetWindowLongA",
  "DestroyWindow",
  "SendMessageW",
  "SendMessageA",
  "ShowWindowAsync",
  "PostMessageW",
  "PostMessageA",
  "SendMessageTimeoutW",
  "SendMessageTimeoutA",
  "SetWindowLongPtrA",
  "SetWindowTextW",
  "SetWindowTextA",
  "AnimateWindow",
  "SetWindowPlacement",
  "SetLayeredWindowAttributes",
  "SetWindowRgn",
  "SetWindowTheme",
  "SetPropW",
  "SetPropA",
  "SetWindowContextHelpId",
  "SetWindowDisplayAffinity",
];

/**
 * **一律禁用**的批量 / 多窗口 / 类级写：出现即违规，连 canonical 第一实参也不放行——首参自窗守卫证明不了只影响自窗。
 * 清单是**枚举式**的；真要引入，必须另给**单独测过的**精确安全形态，不许在这里加「看着像守卫」的例外。
 */
const BLANKET_FORBIDDEN_APIS = [
  "DeferWindowPos",
  "EndDeferWindowPos",
  "LockWindowUpdate",
  "SetClassLongPtrW",
  "SetClassLongPtrA",
  "SetClassLongW",
  "SetClassLongA",
  "SetClassWord",
];

/** 把字面量整体抹成空格（**长度不变**），得到「只看代码」的视图。用途只有一个：判断某处标识符是不是**调用形态**——字面量里的 `SetParent(` 是内容，不能算调用、也不能算别名。 */
function blankLiterals(text) {
  const chars = text.split("");
  const blank = (from, to) => { for (let k = from; k <= to && k < chars.length; k += 1) chars[k] = " "; };
  let i = 0;
  while (i < text.length) {
    const raw = rustRawString(text, i);
    if (raw !== null) {
      const end = raw.close < 0 ? text.length - 1 : raw.end;
      blank(i, end);
      i = end + 1;
      continue;
    }
    if (text[i] === '"') {
      const end = rustStringEnd(text, i);
      if (end < 0) { blank(i, text.length - 1); break; } // 解析失败：余下不猜，交给写扫描 fail closed
      blank(i, end);
      i = end + 1;
      continue;
    }
    if (text[i] === "'") {
      const end = rustCharEnd(text, i);
      if (end >= 0) { blank(i, end); i = end + 1; continue; } // 否则是生命周期，照旧当代码
    }
    i += 1;
  }
  return chars.join("");
}

const RUST_IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** 跳过空白后的下一个字节 / 上一个 / 下一个标识符。 */
function nextByte(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i < text.length ? text[i] : "";
}

/** 跳过空白后的前一个 / 后一个标识符（没有就是空串）。 */
function prevWord(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i])) i -= 1;
  return i + 1 === end ? "" : text.slice(i + 1, end);
}
/** 跳过空白后的前一个字节（没有就是空串）。 */
function prevByte(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return i >= 0 ? text[i] : "";
}
function nextWord(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const start = i;
  while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
  return text.slice(start, i);
}

/** `start` 处的标识符是不是模块路径写法 `self::<name>`（`self :: name` 也认）。 */
function selfQualified(text, start) {
  let i = start - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 1 || text[i] !== ":" || text[i - 1] !== ":") return false;
  return prevWord(text, i - 1) === "self";
}

/** `start` 处的标识符是不是 **raw identifier** 写法 `r#name`（`r#` 紧贴，前面不是标识符字符）。
 * rustc 里 `r#ensure_own` 与 `ensure_own` 是**同一个名字**，两种写法都必须计入守卫定义唯一性。 */
function rawIdentifierPrefix(text, start) {
  if (start < 2) return false;
  if (text.slice(start - 2, start) !== "r#") return false;
  return start < 3 || !/[A-Za-z0-9_]/.test(text[start - 3]);
}

/**
 * `use` 条目的区间（`use …;`）。`blank` 已经抹掉字面量，所以这里不会命中字符串里的 use。
 */
function useItemRanges(blank) {
  const ranges = [];
  for (const hit of blank.matchAll(/\buse\b[^;]*;/g)) ranges.push({ start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
  return ranges;
}

/**
 * 唯一一份 `lyrics_proc` 子类回调的函数体区间（`{ … }`）；0 处或 ≥2 处都返回 null（fail closed）。
 *
 * `blank` 已抹掉字面量，`scanBracket` 能正确跨过参数表里的 `::`/泛型与嵌套调用。
 */
function subclassCallbackBody(blank) {
  const hits = [...blank.matchAll(/\bfn\s+lyrics_proc\s*\(/g)];
  if (hits.length !== 1) return null;
  const open = hits[0].index + hits[0][0].length - 1;
  const close = scanBracket(blank, open).close;
  if (close < 0) return null;
  const brace = blank.indexOf("{", close);
  if (brace < 0) return null;
  const end = scanBracket(blank, brace).close;
  return end < 0 ? null : { start: brace, end };
}

/** 回调自己的三个实参：`window`（回调收到的 HWND）、`Some(lyrics_proc)`（本回调）、`id`（本子类 id）。 */
const SUBCLASS_REMOVAL_CALL = ["window", "Some(lyrics_proc)", "id"];

/** 按**顶层**逗号切实参（括号里的逗号不算）；`blank` 已抹掉字面量，所以不会把串里的逗号当分隔符。 */
function callArguments(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth -= 1; continue; }
    if (ch === "," && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  args.push(text.slice(start));
  return args;
}

/**
 * `start` 处的 `RemoveWindowSubclass` 是不是**唯一放行形态**：在唯一一份 `lyrics_proc` 回调体内，
 * 三个实参逐 token 是回调自己的 `window` / `lyrics_proc` / `id`；其余出现一律 fail closed。
 * 不走 `self::ensure_own(...)?`：`WM_NCDESTROY` 分支先把 liveness 置 false 再摘子类，那一刻写资格已失效。
 */
function exactSubclassRemoval(blank, start, end, callback) {
  if (callback === null || start <= callback.start || start >= callback.end) return false;
  if (prevByte(blank, start) === ".") return false; // `recv.RemoveWindowSubclass(…)`：接收者来源不可证
  const open = blank.indexOf("(", end);
  if (open < 0 || blank.slice(end, open).trim() !== "") return false;
  const close = scanBracket(blank, open).close;
  if (close < 0) return false;
  const args = callArguments(blank.slice(open + 1, close)).map((arg) => arg.replace(/\s+/g, ""));
  return args.length === SUBCLASS_REMOVAL_CALL.length && SUBCLASS_REMOVAL_CALL.every((expected, index) => args[index] === expected);
}

/** 名字级规则：写 API 清单、两个守卫名、回调自撤（`RemoveWindowSubclass`），除**受核调用形态**外不许出现；形态之外一律 fail closed。
 * 写 API 只允许直接调用与无 `as` 的 `use` 导入，别名、`[SetParent]`、方法形态均命中；批量/类级写出现即违规；守卫名只允许定义、`self::`、非写位置调用。 */
function referenceViolations(code) {
  const blank = blankLiterals(code);
  const uses = useItemRanges(blank);
  const callback = subclassCallbackBody(blank);
  const violations = [];
  const definitions = new Map(WRITE_GUARDS.map((guard) => [guard, 0]));
  for (const hit of blank.matchAll(RUST_IDENTIFIER)) {
    const word = hit[0];
    const start = hit.index;
    const end = start + word.length;
    const rawPrefixed = rawIdentifierPrefix(blank, start);
    if (word === "RemoveWindowSubclass") {
      // 回调自撤是**唯一**放行形态（见 `exactSubclassRemoval`）：导入（无 as）与回调体内的
      // 自身移除；别名、非 windows 导入、方法形态、回调外、别家的窗/proc/id 一律点名。
      const item = uses.find((range) => start > range.start && end < range.end);
      if (item !== undefined) {
        const aliased = prevWord(blank, start) === "as" || nextWord(blank, end) === "as";
        if (aliased) violations.push(`${word}: (use 里用 as 改名的别名引用)`);
        else if (!/^\s*use\s+windows::/.test(item.text)) violations.push(`${word}: (use 导入不是 windows:: 路径，绑定到哪份实现不可证)`);
        continue;
      }
      if (!exactSubclassRemoval(blank, start, end, callback)) {
        violations.push(`${word}: (只允许唯一一份 lyrics_proc 子类回调撤自己的子类：实参必须是 window, Some(lyrics_proc), id)`);
      }
      continue;
    }
    if (BLANKET_FORBIDDEN_APIS.includes(word)) {
      // 不看形态：导入、别名、方法、直接调用、裸引用都点名（第一实参守卫对这类调用没有意义）。
      violations.push(`${word}: (本模块一律禁用：批量/多窗口/类级写，第一实参守卫证明不了效果只波及自窗)`);
      continue;
    }
    if (MUTATION_APIS.includes(word)) {
      const item = uses.find((range) => start > range.start && end < range.end);
      if (item !== undefined) {
        const aliased = prevWord(blank, start) === "as" || nextWord(blank, end) === "as";
        if (aliased) violations.push(`${word}: (use 里用 as 改名的别名引用)`);
        else if (!/^\s*use\s+windows::/.test(item.text)) violations.push(`${word}: (use 导入不是 windows:: 路径，绑定到哪份实现不可证)`);
        continue;
      }
      // 关联方法形态（`recv.SetParent(…)`）：写目标是**接收者**，第一实参守卫管不到它，词法扫描器又不解析接收者来源，所以一律 fail closed。
      // `windows::…::SetParent(…)` 是 `::` 结尾，不受影响。
      if (prevByte(blank, start) === ".") {
        violations.push(`${word}: (关联方法形态：写目标是接收者，第一实参守卫管不到)`);
        continue;
      }
      if (nextByte(blank, end) === "(") continue; // 直接调用形态：目标由第一实参守卫核
      violations.push(`${word}: (非调用形态的引用：疑似函数指针/别名)`);
      continue;
    }
    if (!definitions.has(word)) continue;
    if (selfQualified(blank, start)) continue;
    // `fn r#ensure_own`：raw 前缀属于名字本身，判定「前面是不是 fn」要跳过它。
    if (prevWord(blank, rawPrefixed ? start - 2 : start) === "fn") {
      definitions.set(word, definitions.get(word) + 1);
      continue;
    }
    if (nextByte(blank, end) === "(") continue; // 非写位置的裸名自查调用：不决定写目标
    violations.push(`${word}: (不是 fn 定义 / self:: 调用 / 直接调用：本地绑定能 shadow 守卫)`);
  }
  for (const [guard, count] of definitions) {
    if (count > 1) violations.push(`${guard}: (守卫定义出现 ${count} 次，必须唯一)`);
  }
  return violations;
}

export function taskbarWriteViolations(source) {
  const code = stripComments(source, TASKBAR_NATIVE_FILE);
  const mutations = MUTATION_APIS;
  const violations = [];
  for (const name of mutations) {
    for (const hit of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
      const open = hit.index + hit[0].length - 1;
      const { close, firstComma } = scanBracket(code, open);
      const argumentEnd = firstComma >= 0 && (close < 0 || firstComma < close) ? firstComma : close;
      const argument = code.slice(open + 1, argumentEnd < 0 ? Math.min(code.length, open + 120) : argumentEnd).trim();
      if (close < 0) {
        // 不平衡/未闭合：解析不出来的实参一律按"未复核"处理，绝不猜。
        violations.push(`${name}: ${argument} (调用未闭合)`);
        continue;
      }
      if (!guardedWriteTarget(name, argument)) violations.push(`${name}: ${argument}`);
    }
  }
  // 名字级：别名引用 / 守卫绑定；写调用形态本身不在这里重复记账。
  violations.push(...referenceViolations(code));
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
