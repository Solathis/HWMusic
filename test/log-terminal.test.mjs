/**
 * R56 · 设置页「运行日志」：宿主日志文件 + `app:notice` 两路来源，级别标识与筛选。
 *
 * 钉住三件事：
 * 1. **数据来源**：日志文件走新命令（`readRunLog` → `core_read_run_log`），
 *    `app:notice` 仍由外壳订阅（广播没人接就丢了，见 `useNoticeLog`）；
 * 2. **展示**：编辑器样式（行号 gutter + 等宽正文 + 有界 ScrollArea），每行一个官方 `Badge`
 *    标级别，四档筛选 + 文本搜索 + 刷新（含自动刷新开关）；
 * 3. **克制**：不提供导出/复制（没有 dialog/fs/clipboard 权限），空态/筛空/读失败各有说法。
 *
 * 为什么用源码扫描钉展示：渲染层没有 DOM 测试环境（本仓既有做法），真实像素由浏览器守卫取证。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUN_LOG_DEFAULT_LEVELS,
  RUN_LOG_LEVELS,
  RUN_LOG_LEVEL_BADGE,
  RUN_LOG_READ_LIMIT,
} from "../src/renderer/features/settings/run-log.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const TERMINAL_FILE = "src/renderer/log-terminal.tsx";

test("数据来源：日志文件走 host-api 的新命令，提示仍由外壳订阅后交下来", () => {
  const source = read(TERMINAL_FILE);
  const code = stripComments(source);
  assert.match(source, /from\s+"\.\/host-api"/, "渲染层不自己发请求");
  assert.match(code, /readRunLog\(/, "日志文件走 host-api 的 readRunLog");
  assert.match(code, /useNoticeLog/, "app:notice 的订阅仍在（广播没人接就丢了）");
  assert.match(code, /notices/, "外壳把订阅到的提示交下来");

  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /useNoticeLog\(\)/, "订阅留在常驻的外壳里");
  assert.match(app, /notices=\{notices\}/, "设置页只负责渲染");
});

test("命令与 Rust 侧同源：名字逐字相等，条数上限两边一致", () => {
  const commands = read("src/shared/commands.ts");
  assert.match(commands, /CORE_READ_RUN_LOG = "core_read_run_log"/);

  const hostApi = read("src/renderer/host-api.ts");
  assert.match(hostApi, /CORE_READ_RUN_LOG/, "host-api 用共享常量（不写字面量）");
  assert.match(hostApi, /invoke<[^>]*>\(\s*CORE_READ_RUN_LOG\s*\)/, "封装真的调了那条命令");

  const rust = read("src-tauri/src/run_log.rs");
  assert.match(rust, new RegExp(`pub const READ_LIMIT: usize = ${RUN_LOG_READ_LIMIT};`),
    "渲染层说的条数必须就是 Rust 侧的条数");
  assert.match(read("src-tauri/src/lib.rs"), /commands::core_read_run_log/, "命令必须进 generate_handler 白名单");
});

test("编辑器样式：行号 gutter + 等宽正文 + 有界 ScrollArea + 官方原语", () => {
  const source = read(TERMINAL_FILE);
  const code = stripComments(source);

  assert.match(source, /from\s+"\.\/components\/ui\/input"/, "搜索框是 shadcn 的 Input");
  assert.match(source, /from\s+"\.\/components\/ui\/scroll-area"/, "日志区是 shadcn 的 ScrollArea");
  assert.match(source, /from\s+"\.\/components\/ui\/badge"/, "级别标识是 shadcn 的 Badge");
  assert.match(source, /from\s+"\.\/components\/ui\/button"/, "筛选项与刷新是 shadcn 的 Button");
  assert.match(source, /from\s+"\.\/components\/ui\/switch"/, "自动刷新是 shadcn 的 Switch");
  assert.doesNotMatch(code, /<(?:input|select|textarea|button)\b/, "不许拿裸标签拼控件");

  assert.match(code, /max-h-\[60vh\]/, "日志区有界高度");
  assert.match(code, /\[&>\[data-slot=scroll-area-viewport\]\]:max-h-\[60vh\]/, "有界高度要落到 radix viewport 上");
  assert.match(code, /\{\s*position\s*\+\s*1\s*\}/, "行号是显示位置 1..N");
  assert.match(code, /tabular-nums/, "行号等宽数字");
  assert.match(code, /font-mono/, "正文等宽");
  assert.match(code, /break-all/, "长行要能断（不横向撑破卡片）");
  assert.doesNotMatch(code, /overflow-x-auto|whitespace-pre(?!-wrap)/, "不许靠横向滚动兜底");
});

test("级别标识：每行一个 Badge，变体只用官方那几种", () => {
  const code = stripComments(read(TERMINAL_FILE));
  assert.match(code, /<Badge\b/, "真的渲染 Badge");
  assert.match(code, /RUN_LOG_LEVEL_BADGE\[/, "变体来自纯逻辑模块的映射（不在这里发明颜色）");
  assert.match(code, /data-testid="log-level-badge"/, "守卫要能数出每行的级别标识");
  assert.doesNotMatch(
    code,
    /(?:bg|text|border)-(?:red|amber|yellow|green|blue|orange|rose|emerald|slate|gray)-\d{3}/,
    "不许写自定义颜色类（Badge 只用官方 variant）",
  );

  // 映射表本身：四档四个不同变体，且都在官方集合里
  const official = ["default", "secondary", "destructive", "outline", "ghost", "link"];
  for (const level of RUN_LOG_LEVELS) {
    assert.ok(official.includes(RUN_LOG_LEVEL_BADGE[level]), `${level}: ${RUN_LOG_LEVEL_BADGE[level]}`);
  }
});

test("筛选：四档多选按钮 + 文本搜索，默认三档（debug 关着）", () => {
  const source = read(TERMINAL_FILE);
  const code = stripComments(source);

  assert.match(code, /RUN_LOG_LEVELS\.map\(/, "筛选项由四档常量生成（不写四份）");
  assert.match(code, /data-testid=\{`log-level-\$\{level\}`\}/, "每档一个可点的筛选项");
  assert.match(code, /aria-pressed=\{/, "开关状态要能被读屏与守卫读到");
  assert.match(code, /toggleLevel\(/, "点击走纯函数（最后一档不许取消）");
  assert.match(code, /filterRunLogEntries\(/, "筛选走纯函数（UI 里不写第二份匹配逻辑）");
  assert.match(code, /runLogCountText\(/, "计数文案走纯函数");
  assert.match(code, /useState[^\n]*\.\.\.RUN_LOG_DEFAULT_LEVELS/, "默认显示 info/warn/error");
  assert.match(code, /<Input\b/, "文本搜索是 Input");
  assert.match(source, /LOG_FILTER_PLACEHOLDER/, "占位文案是一处常量");
});

test("刷新：按钮 + 自动刷新开关，失败与空态各有说法", () => {
  const source = read(TERMINAL_FILE);
  const code = stripComments(source);

  assert.match(code, /data-testid="log-refresh"/, "有「刷新」按钮");
  assert.match(code, /onClick=\{\(\) => void refresh\(\)\}|onClick=\{refresh\}/, "刷新按钮真的再读一次");
  assert.match(code, /<Switch\b/, "自动刷新是 Switch");
  assert.match(code, /setInterval\(/, "自动刷新用定时器，且要清掉");
  assert.match(code, /clearInterval\(/, "卸载时清定时器（不许泄漏）");

  assert.match(code, /RUN_LOG_EMPTY_TEXT/, "空态文案是一处常量");
  assert.match(code, /RUN_LOG_NO_MATCH_TEXT/, "筛空是另一句");
  assert.match(code, /RUN_LOG_FAILURE_TEXT/, "读失败是第三句");
  assert.match(code, /<EmptyState text=\{RUN_LOG_EMPTY_TEXT\}/, "空态真的显示出来");
  assert.match(code, /<EmptyState text=\{RUN_LOG_NO_MATCH_TEXT\}/, "筛空真的显示出来");
});

test("不提供导出/复制：没有新增 dialog/fs/clipboard 的能力面", () => {
  const source = read(TERMINAL_FILE);
  const code = stripComments(source);
  assert.doesNotMatch(code, /clipboard|writeText|navigator\.clipboard/i, "不引入剪贴板（要加 capabilities 权限）");
  assert.doesNotMatch(code, /save\(|download|showSaveFilePicker/, "不提供导出文件");
  assert.doesNotMatch(code, /@tauri-apps\/plugin-(?:dialog|fs)/, "不新增插件权限");

  const capabilities = read("src-tauri/capabilities/main.json");
  for (const forbidden of ["dialog:", "fs:", "clipboard"]) {
    assert.ok(!capabilities.includes(forbidden), `主窗能力面不许新增 ${forbidden}`);
  }
});
