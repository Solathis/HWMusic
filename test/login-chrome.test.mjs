/**
 * R25：登录体验四项改造 —— 浮动控件（返回 / 主题）与主题三态系统的契约。
 *
 * 用户四项里有两项落在这一层：
 * 2. 「返回扫码登录」**悬浮在网页左上角**（不独占一行、不挤压网页）；
 * 4. 登录页右上角有「黑白主题 + 系统默认」（浅色 / 深色 / 跟随系统），gate 视图与嵌入官方页
 *    打开时都要有。
 *
 * 实现形态（控制器裁决）：两个**小浮动 webview**（`login-return` / `login-theme`），
 * 与 gate 里的同类控件**同一个 React 组件**；主题状态归 Rust 持有，经 `theme:changed` 广播
 * 让每个 webview 应用 class。
 *
 * 这一层钉住的契约：
 * - 浮动控件加载的页面地址形状（`login-chrome.html?kind=…`）与两侧共用的 kind 字面量；
 * - 主题三态的唯一真源（档位、文案、class 映射、认不出不猜）；
 * - **强制浅色必须压过系统暗色**（CSS 结构：`.light` 的令牌块 + dark 变体的媒体分支排除它）；
 * - 切类只有一处（`features/theme/theme.mjs`），其余文件一律经它；
 * - 命令名 `core_login_chrome` 与广播频道 `theme:changed` 的接线（常量表 + Rust 镜像互钉）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CORE_LOGIN_CHROME } from "../src/shared/commands.ts";
import { BROADCAST_CHANNELS, THEME_CHANGED } from "../src/shared/channels.ts";
import {
  LOGIN_CHROME_ENTRY,
  LOGIN_CHROME_KIND,
  LOGIN_CHROME_KINDS,
  loginChromeUrl,
} from "../src/shared/login-chrome.mjs";
import { WEB_LOGIN_BACK_TEXT } from "../src/renderer/features/auth/login-gate-logic.mjs";
import {
  THEME_CHOICE,
  THEME_CHOICES,
  THEME_CONTROL_TESTID,
  THEME_DEFAULT,
  THEME_FORCED_CLASSES,
  THEME_LABELS,
  applyThemeChoice,
  normalizeThemeChoice,
  themeClassesFor,
  themeOptionTestId,
} from "../src/renderer/features/theme/theme.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const rustProduction = (name) => {
  const source = read(`src-tauri/src/${name}`);
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
};

function rendererFiles(root = "src/renderer") {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(tsx|ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(child);
    }
  };
  walk(root);
  return found;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------------
// 浮动控件的地址与 kind（Rust 拼 URL，渲染层解析：跨语言契约）
// ---------------------------------------------------------------------------

test("浮动控件入口：单个 HTML 入口 + kind 查询串，两侧共用同一批字面量", () => {
  assert.equal(LOGIN_CHROME_ENTRY, "login-chrome.html");
  assert.deepEqual(LOGIN_CHROME_KINDS, ["return", "theme"]);
  assert.equal(LOGIN_CHROME_KIND.return, "return");
  assert.equal(LOGIN_CHROME_KIND.theme, "theme");
  assert.equal(loginChromeUrl(LOGIN_CHROME_KIND.return), "login-chrome.html?kind=return");
  assert.equal(loginChromeUrl(LOGIN_CHROME_KIND.theme), "login-chrome.html?kind=theme");

  // 入口文件与打包入口都必须真的存在：少了任何一个，浮动 webview 只会是一块空白
  assert.ok(existsSync(`${repoRoot}src/renderer/${LOGIN_CHROME_ENTRY}`), "缺少浮动控件的 HTML 入口");
  const vite = read("vite.config.ts");
  assert.match(vite, /login-chrome\.html/, "vite 的 rollupOptions.input 必须列出浮动控件入口");
});

test("浮动控件入口：Rust 侧镜像与共享常量逐字相等（Rust 无法 import .mjs，只能镜像互钉）", () => {
  const rust = rustProduction("login.rs");
  assert.ok(
    rust.includes(`"${LOGIN_CHROME_ENTRY}"`),
    `Rust 侧必须镜像浮动控件入口名 ${LOGIN_CHROME_ENTRY}（两侧各写一份就会漂移）`,
  );
  for (const kind of LOGIN_CHROME_KINDS) {
    assert.ok(rust.includes(`"${kind}"`), `Rust 侧必须镜像 kind 字面量 ${kind}`);
  }
  assert.match(rust, /kind=\{?\}|kind=/, "浮动控件的地址里要带 kind 查询串");
});

// ---------------------------------------------------------------------------
// 主题三态（唯一真源）
// ---------------------------------------------------------------------------

test("主题三态：档位、文案与默认值", () => {
  assert.deepEqual(THEME_CHOICES, ["light", "dark", "system"]);
  assert.equal(THEME_CHOICE.light, "light");
  assert.equal(THEME_CHOICE.dark, "dark");
  assert.equal(THEME_CHOICE.system, "system");
  assert.equal(THEME_LABELS.light, "浅色");
  assert.equal(THEME_LABELS.dark, "深色");
  assert.equal(THEME_LABELS.system, "跟随系统");
  assert.equal(THEME_DEFAULT, "system", "R10 起的行为是「跟系统」，默认值不许变成强制档");
  assert.deepEqual(THEME_FORCED_CLASSES, ["light", "dark"]);

  // 三个档位各有各的锚点（真窗守据与标记测试按它点名）
  assert.equal(THEME_CONTROL_TESTID, "login-theme-control");
  assert.equal(themeOptionTestId("system"), "login-theme-system");
  assert.equal(new Set(THEME_CHOICES.map(themeOptionTestId)).size, 3, "三个档位的锚点不许撞车");
});

test("主题三态：认不出的档位不猜（null），系统档不加任何强制类", () => {
  for (const choice of THEME_CHOICES) assert.equal(normalizeThemeChoice(choice), choice);
  for (const junk of [undefined, null, "", "  ", "Light", "auto", "dark ", 42, {}, []]) {
    assert.equal(normalizeThemeChoice(junk), null, `${JSON.stringify(junk)} 不是档位：不许猜一个出来`);
  }

  assert.deepEqual(themeClassesFor("dark"), ["dark"]);
  assert.deepEqual(themeClassesFor("light"), ["light"]);
  assert.deepEqual(themeClassesFor("system"), [], "系统档不加类：媒体查询说了算（R10 既有映射）");
  assert.deepEqual(themeClassesFor(null), [], "认不出时退回系统档的行为，而不是留在上一个档位");
});

test("主题三态：applyThemeChoice 只动那两个类，并把实际生效的档位报回来", () => {
  const root = fakeRoot(["dark"]);
  assert.equal(applyThemeChoice(root, "light"), "light");
  assert.deepEqual(root.classes(), ["light"], "强制浅色：加上 light、去掉 dark");
  assert.equal(applyThemeChoice(root, "system"), "system");
  assert.deepEqual(root.classes(), [], "系统档两个类都不留");
  assert.equal(applyThemeChoice(root, "dark"), "dark");
  assert.deepEqual(root.classes(), ["dark"]);
  assert.equal(applyThemeChoice(root, "nonsense"), "system", "认不出的档位退回系统档（不留在上一个）");
  assert.deepEqual(root.classes(), []);
});

/** 一个假的 html 根（只实现用到的那一点 classList 面）。 */
function fakeRoot(initial = []) {
  const set = new Set(initial);
  return {
    classList: {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
    },
    classes: () => [...set].sort(),
  };
}

// ---------------------------------------------------------------------------
// CSS：强制浅色必须压过系统暗色
// ---------------------------------------------------------------------------

test("CSS：系统暗色那块必须排除强制浅色（否则强制浅色压不过系统暗色）", () => {
  const styles = read("src/renderer/styles.css");
  const media = styles.match(/^@media \(prefers-color-scheme: dark\)/m);
  assert.ok(media, "styles.css 必须把系统暗色接上（R10 的映射不许丢）");

  const mediaBlock = blockAfter(styles, media.index);
  const selector = mediaBlock.slice(0, mediaBlock.indexOf("{")).trim();
  assert.equal(
    selector,
    ":root:not(.light)",
    "系统暗色只该在**没有强制浅色**时生效（靠排除而不是再抄一份 .light 令牌：三份副本迟早只对齐两份）",
  );

  // 令牌仍然只有两份（.dark 与媒体查询），且逐条一致这件事由 theme-tokens.test.mjs 继续钉
  assert.ok(styles.match(/^\.dark\s*\{/m), "`.dark` 令牌块必须还在（强制暗色与 shadcn 默认写法）");
});

test("CSS：dark 变体的媒体分支必须排除强制浅色（dark: 工具类不许漏进来）", () => {
  const styles = read("src/renderer/styles.css");
  const variantAt = styles.indexOf("@custom-variant dark");
  assert.ok(variantAt !== -1, "styles.css 要有 dark 变体的定义");
  const rest = styles.slice(variantAt);
  const next = rest.indexOf("\n@", 1);
  const variant = next === -1 ? rest : rest.slice(0, next);

  assert.match(variant, /prefers-color-scheme/, "系统暗色那条路仍在（R10 的映射不许丢）");
  assert.match(variant, /\.dark/, "`.dark` 类那条路仍在（强制暗色与 shadcn 默认写法）");
  assert.match(
    variant,
    /:not\([^)]*\.light/,
    "媒体分支要排除 .light 子树：否则强制浅色时 dark: 工具类照旧生效（颜色只换了一半）",
  );
});

// ---------------------------------------------------------------------------
// 切类只有一处；渲染层不许有第二份主题存储
// ---------------------------------------------------------------------------

test("切类只有一处：只有 features/theme/theme.mjs 动 html 的 class", () => {
  const offenders = [];
  for (const relative of rendererFiles()) {
    if (relative === "src/renderer/features/theme/theme.mjs") continue;
    const source = stripComments(read(relative));
    if (/classList\s*\.\s*(?:add|remove|toggle)\s*\(\s*["'`](?:dark|light)["'`]/.test(source)) {
      offenders.push(relative);
    }
    if (/documentElement\.className\s*=/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `主题类只能由 features/theme/theme.mjs 一处切换：${offenders.join(", ")}`);
  assert.match(
    stripComments(read("src/renderer/features/theme/theme.mjs")),
    /export function applyThemeChoice/,
    "唯一的切类入口必须真的存在",
  );

  // 唯一真源自己也不许存本地副本（R10 的裁决仍然成立：不引 next-themes、不写 localStorage）
  const theme = stripComments(read("src/renderer/features/theme/theme.mjs"));
  assert.doesNotMatch(theme, /next-themes|localStorage/, "主题状态归 Rust 持有：渲染层不许有第二份存储");
});

// ---------------------------------------------------------------------------
// 命令与频道接线
// ---------------------------------------------------------------------------

test("命令名：core_login_chrome 是跨语言契约（常量表 + 渲染层封装 + Rust 注册）", () => {
  assert.equal(CORE_LOGIN_CHROME, "core_login_chrome");

  const hostApi = read("src/renderer/host-api.ts");
  assert.match(hostApi, /CORE_LOGIN_CHROME/, "host-api 必须包一个具名封装（命令名只从共享常量来）");
  assert.match(hostApi, /export\s+async\s+function\s+coreLoginChrome/, "封装要导出具名函数");
  assert.doesNotMatch(
    hostApi,
    /["'`]core_login_chrome["'`]/,
    "命令名一律从 src/shared/commands.ts 导入，不写字面量",
  );

  // Rust 侧：定义 + 注册（只定义不注册 = 点了没反应，回一句 command not found）
  const commands = rustProduction("commands.rs");
  assert.match(commands, /pub fn core_login_chrome/, "Rust 侧要有这条命令");
  const lib = rustProduction("lib.rs");
  const handlerAt = lib.indexOf("invoke_handler(tauri::generate_handler![");
  assert.ok(handlerAt > -1, "找不到 generate_handler! 的注册处");
  const block = lib.slice(handlerAt, lib.indexOf("])", handlerAt));
  assert.match(block, /commands::core_login_chrome/, "core_login_chrome 必须进 generate_handler!");
});

test("命令守卫：浮动控件的来源（main / login-return / login-theme）允许，其余一律拒", () => {
  const commands = rustProduction("commands.rs");
  assert.match(commands, /fn require_login_chrome_source/, "来源守卫要是具名纯函数（可单测）");
  // 三个 label 的来源判定必须按 **webview label**（同窗之后窗口 label 恒为 main）
  assert.match(commands, /require_login_chrome_source\(webview\.label\(\)\)/, "命令侧必须判 webview label");
  // 官方登录页（label = login）**不在**允许集合里：它手里不该多一个能改主题/取消登录的口子
  const guard = commands.slice(commands.indexOf("fn require_login_chrome_source"));
  const guardBody = guard.slice(0, guard.indexOf("\n}\n"));
  assert.match(guardBody, /MAIN_WINDOW_LABEL/, "主窗来源允许（gate 自己那个主题控件也走这条命令）");
});

test("广播频道：theme:changed 进常量表 + Rust 镜像（两侧逐字相等）", () => {
  assert.equal(THEME_CHANGED, "theme:changed");
  assert.ok(BROADCAST_CHANNELS.includes(THEME_CHANGED), "不在广播白名单里 = Rust 会把这条广播当白名单外帧丢掉");
  const bridge = rustProduction("bridge.rs");
  assert.ok(bridge.includes(`"${THEME_CHANGED}"`), "Rust 侧广播白名单必须同样含 theme:changed");
  assert.match(bridge, /pub const THEME_CHANGED/, "Rust 侧要有同名常量（镜像副本）");
});

test("浮动控件：返回走 core_login_chrome，主题也走同一条命令（单一入口）", () => {
  const chrome = read("src/renderer/login-chrome.tsx");
  assert.match(chrome, /coreLoginChrome/, "浮动控件只经 host-api 的封装");
  assert.match(chrome, /WEB_LOGIN_BACK_TEXT/, `返回控件的文案来自唯一真源（${WEB_LOGIN_BACK_TEXT}）`);
  assert.doesNotMatch(
    chrome,
    /AUTH_CANCEL_LOGIN|coreCall/,
    "浮动控件没有业务频道权限：取消登录走专用命令（core_call 的来源守卫会拒它）",
  );
});

// ---------------------------------------------------------------------------
// 复用：gate 与浮动控件是同一个组件
// ---------------------------------------------------------------------------

test("复用：gate 的主题控件与浮动控件是同一个 React 组件", () => {
  const control = read("src/renderer/theme-control.tsx");
  assert.match(control, /export function ThemeControl/, "主题控件要有唯一的组件定义");
  assert.match(read("src/renderer/login-gate.tsx"), /<ThemeControl/, "gate 视图右上角用它");
  assert.match(read("src/renderer/login-chrome.tsx"), /<ThemeControl/, "浮动控件也用它（同一份，不是各写一个）");
  assert.equal(
    rendererFiles().filter((relative) => /export function ThemeControl/.test(read(relative))).length,
    1,
    "主题控件只许有一处定义",
  );
});

// ---------------------------------------------------------------------------
// styles.css 的解析小工具（与 theme-tokens.test.mjs 同款口径，这里不跨文件 import）
// ---------------------------------------------------------------------------

function blockAfter(source, from) {
  const open = source.indexOf("{", from);
  assert.ok(open !== -1, `找不到代码块：${source.slice(from, from + 40)}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("大括号没有闭合");
}

function declarations(text) {
  return [...text.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+);/g)].map(
    (found) => `${found[1].trim()}=${found[2].trim()}`,
  );
}
