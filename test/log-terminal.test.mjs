/**
 * R39 · 运行日志（设置页化 + 编辑器样式 + 文本筛选）。
 *
 * 两件事在这一个文件里钉住：
 *
 * 1. **纯逻辑**：`filterNoticeEntries` / `noticeLogCountText`（`features/library/library-state.mjs`）。
 *    筛选是**文本子串**，不是级别——`app:notice` 的载荷只有 `text`（`src/shared/channels.ts`），
 *    发明一个级别列就是把"我们不知道的事"画成界面上的事实。
 * 2. **接线与形状**：入口从侧栏那个 Sheet 搬到设置页那张 Card（`App.tsx` 侧不留死 import），
 *    展示层是编辑器样式（行号 gutter + 等宽正文 + 有界 ScrollArea），上面一个 shadcn `Input`。
 *
 * 为什么用源码扫描钉第 2 条：这个仓的既有做法如此（`no-self-visual.test.mjs` /
 * `settings-page.test.mjs` 同款），而渲染层没有 DOM 测试环境——扫描能钉住"结构长什么样"，
 * 真实像素由 CDP 取证（见 task-39-report.md）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  appendNotice,
  filterNoticeEntries,
  noticeLogCountText,
} from "../src/renderer/features/library/library-state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** 三条日志的夹具（形状与 `appendNotice` 的产物一致）。 */
const ENTRIES = [
  { id: 1, text: "代理按环境变量设置生效" },
  { id: 2, text: "Proxy enabled from settings" },
  { id: 3, text: "歌词窗已打开" },
];

test("筛选：文本子串命中（大小写不敏感、只筛不排序、原样返回元素）", () => {
  assert.deepEqual(
    filterNoticeEntries(ENTRIES, "代理").map((entry) => entry.id),
    [1],
  );
  assert.deepEqual(
    filterNoticeEntries(ENTRIES, "proxy").map((entry) => entry.id),
    [2],
    "大小写不敏感：日志里混着 Proxy/proxy，区分大小写只会让人以为筛不出来",
  );
  assert.deepEqual(
    filterNoticeEntries(ENTRIES, "PROXY").map((entry) => entry.id),
    [2],
  );
  assert.deepEqual(
    filterNoticeEntries(ENTRIES, "窗").map((entry) => entry.id),
    [3],
    "子串匹配而不是前缀/全等",
  );
  assert.equal(filterNoticeEntries(ENTRIES, "代理")[0], ENTRIES[0], "命中项原样返回（不复制、不改写）");
  assert.deepEqual(
    filterNoticeEntries(ENTRIES, "日志").map((entry) => entry.id),
    [],
    "没命中就是空数组（调用方据此显示「没有匹配的日志。」）",
  );
});

test("筛选：空查询/空白查询不筛（不要把用户没提的要求当成筛掉全部）", () => {
  for (const query of ["", "   ", "\t", null, undefined, 42]) {
    assert.deepEqual(filterNoticeEntries(ENTRIES, query), ENTRIES, `查询 ${JSON.stringify(query)} 应当不筛`);
  }
  assert.deepEqual(filterNoticeEntries(ENTRIES, "  代理  "), [ENTRIES[0]], "查询首尾空白不算内容");
});

test("筛选：坏入参一律当空列表，不抛（认不出不等于要炸掉界面）", () => {
  for (const entries of [null, undefined, "nope", 42]) {
    assert.deepEqual(filterNoticeEntries(entries, "代理"), []);
    assert.deepEqual(filterNoticeEntries(entries, ""), []);
  }
  // 列表里混了坏形状的条目：它的可筛文本当空串，不会命中，也不会把整次筛选带崩
  const mixed = [{ id: 1, text: "正常" }, null, { id: 2 }, { id: 3, text: 42 }, "x"];
  assert.deepEqual(filterNoticeEntries(mixed, "正常"), [{ id: 1, text: "正常" }]);
  assert.deepEqual(filterNoticeEntries(mixed, "42"), [], "非字符串的 text 不作为可筛文本");
});

test("计数：两个数字都给（只报筛出来的条数就分不清「只有这些」与「被筛掉了」）", () => {
  assert.equal(noticeLogCountText(3, 20), "3 / 20 条");
  assert.equal(noticeLogCountText(0, 0), "0 / 0 条");
  assert.equal(noticeLogCountText(20, 20), "20 / 20 条", "不筛时两个数字相等（这不是错，是如实）");
  for (const bad of [null, undefined, -1, 1.5, "3", NaN]) {
    assert.equal(noticeLogCountText(bad, 5), "0 / 5 条", `坏入参不许漏成 NaN/undefined：${String(bad)}`);
    assert.equal(noticeLogCountText(5, bad), "5 / 0 条");
  }
});

test("数据层仍在：订阅上限与拼接逻辑一行没改（R39 只换展示）", () => {
  const source = read("src/renderer/log-terminal.tsx");
  assert.match(source, /export const LOG_ENTRY_LIMIT = 100/, "上限仍是 100（长跑进程的界面，不设上限就是缓慢的内存增长）");
  assert.match(source, /useNoticeLog/, "数据层 useNoticeLog 保留复用");
  assert.match(source, /from\s+"\.\/host-api"/, "数据入口仍是 host-api（渲染层不自己发请求）");
  assert.match(source, /APP_NOTICE/, "订阅的仍是那一条广播");
  // 载荷只有 text：读别的键就是发明字段
  const subscription = source.slice(source.indexOf("export function useNoticeLog"));
  assert.match(subscription, /payload\?\.text/, "只认载荷里的 text");
  assert.doesNotMatch(
    stripComments(subscription).slice(0, subscription.indexOf("export function LogTerminal")),
    /payload\?\.(level|severity|kind)\b/,
    "app:notice 没有级别字段，不许发明",
  );
  assert.deepEqual(
    appendNotice([], "x", 1, 1),
    [{ id: 1, text: "x" }],
    "appendNotice 的产物形状仍是筛选的输入",
  );
});

test("编辑器样式：行号 gutter + 等宽正文 + 有界 ScrollArea + shadcn Input 筛选", () => {
  const source = read("src/renderer/log-terminal.tsx");
  const code = stripComments(source);

  // 原语：筛选框与滚动区都走 shadcn，不拿裸元素拼
  assert.match(source, /from\s+"\.\/components\/ui\/input"/, "筛选框是 shadcn 的 Input");
  assert.match(source, /from\s+"\.\/components\/ui\/scroll-area"/, "日志区是 shadcn 的 ScrollArea");
  assert.match(code, /<Input\b/, "要真的用上 Input");
  assert.match(code, /<ScrollArea\b/, "要真的用上 ScrollArea");
  assert.doesNotMatch(code, /<(?:input|select|textarea)\b/, "不许拿裸标签拼输入控件");

  // 有界高度 + 面板化的边框圆角（令牌类，尺寸类沿用既有写法）
  assert.match(code, /max-h-\[60vh\]/, "日志区有界高度（不把设置页撑到无穷长）");
  assert.match(
    code, /\[&>\[data-slot=scroll-area-viewport\]\]:max-h-\[60vh\]/,
    "有界高度要落到 radix 的 viewport 上——只写在 ScrollArea 根上，viewport 的 height:100% 解不出来（R39 实测溢出）",
  );
  assert.match(code, /rounded-md border|border rounded-md/, "ScrollArea 是面板样式（border + rounded-md）");

  // 行号 gutter：显示位置（1..N）+ 等宽数字 + 弱化色；正文等宽小字可断行
  assert.match(code, /\{\s*position\s*\+\s*1\s*\}/, "行号是显示位置 1..N（跟着筛选结果走）");
  assert.match(code, /tabular-nums/, "行号用等宽数字对齐（位数变化不跳）");
  assert.match(code, /font-mono text-xs/, "正文是等宽小字（编辑器样式）");
  assert.match(code, /break-all/, "长日志要能断行（不横向撑破卡片）");
  assert.match(code, /text-muted-foreground/, "行号是弱化色（gutter 语义）");

  // 计数与筛选的接线：过滤结果由纯函数给，计数由纯函数给
  assert.match(source, /filterNoticeEntries\(/, "筛选走纯函数（UI 里不再写第二份匹配逻辑）");
  assert.match(source, /noticeLogCountText\(/, "计数文案走纯函数");
  assert.match(source, /noticeLogCountText\(shown\.length,\s*total\)/, "计数显示「筛出来的 / 总数」两个数字");

  // 三种状态各有说法，且"没有日志"与"筛空了"不是同一句话
  assert.match(source, /export const LOG_EMPTY_TEXT = "暂无日志。"?/, "无日志的文案是一处常量");
  assert.match(source, /export const LOG_NO_MATCH_TEXT = "没有匹配的日志。"?/, "筛空的文案是另一处常量");
  assert.match(code, /<EmptyState text=\{LOG_EMPTY_TEXT\}/, "无日志显示空态");
  assert.match(code, /<EmptyState text=\{LOG_NO_MATCH_TEXT\}/, "筛空显示空态（不是同一句）");
  assert.match(source, /LOG_FILTER_PLACEHOLDER = "筛选日志…"/, "筛选框占位克制（不承诺正则之类没有的能力）");
});

test("不发明级别：日志卡里没有级别列/级别筛选/按级别配色", () => {
  const code = stripComments(read("src/renderer/log-terminal.tsx"));
  assert.doesNotMatch(code, /级别|level|severity|warn|error|info/i, "app:notice 的载荷没有级别字段，界面也不许造一个");
  assert.match(code, /筛选只按文本|filterNoticeEntries/, "筛选只有文本这一条路");
});

test("入口迁移：侧栏那个 Sheet 删净（连图标与 import），订阅仍留在外壳", () => {
  const app = read("src/renderer/App.tsx");
  const code = stripComments(app);

  assert.doesNotMatch(app, /ScrollTextIcon/, "侧栏入口用的图标一并删掉（不留死 import）");
  assert.doesNotMatch(code, /运行日志/, "侧栏不再有「运行日志」这个入口（连它的标题与说明一起删）");
  assert.doesNotMatch(code, /<LogTerminal\b/, "App 不再渲染日志面板（展示在设置页那张卡里）");
  assert.doesNotMatch(code, /LogTerminal|LOG_EMPTY_TEXT|LOG_NO_MATCH_TEXT/, "展示层的东西在 App 里一处都不留");

  // 广播没人接就丢了：订阅**必须**留在常驻的外壳里，页面只渲染
  assert.match(code, /useNoticeLog\(\)/, "订阅留在外壳（设置页只在切到设置时才挂载）");
  assert.match(code, /notices=\{notices\}/, "日志数据交给设置页渲染");

  // 播放队列那个 Sheet 还在（删的是日志那一个，不是 Sheet 原语）
  assert.match(code, /<SheetContent side="right"/, "播放队列面板照旧");
  assert.match(app, /from\s+"\.\/components\/ui\/sheet"/, "Sheet 原语仍在使用（不是删成了死 import）");
});

test("设置页那张卡：标题/说明/展示组件齐备，条数上限不写第二份数字", () => {
  const page = read("src/renderer/pages.tsx");
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  const code = stripComments(settings);

  assert.match(page, /from\s+"\.\/log-terminal\.tsx"/, "设置页组合日志面板");
  assert.match(code, /<CardTitle>运行日志<\/CardTitle>/, "有一张「运行日志」Card");
  assert.match(code, /<LogTerminal entries=\{notices\}/, "卡片里渲染日志面板（数据由外壳交下来）");
  assert.match(code, /LOG_ENTRY_LIMIT/, "「最多保留最新 N 条」用的是常量（不写第二份数字）");
  assert.match(settings, /notices = \[\]/, "缺省空列表：外壳还没交下来时如实显示「暂无日志。」");
  assert.match(code, /\{`来自应用内核的提示/, "说明那句话仍在卡片上（克制，一句）");
});
