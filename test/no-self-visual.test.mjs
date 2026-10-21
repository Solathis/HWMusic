/**
 * R8 主界面 · 不自绘视觉（源码扫描）；R9 起覆盖播放器接通与歌词舞台。
 *
 * 项目的 UI 约束只有一句：**只组合 shadcn 原语 + Tailwind 工具类 + 设计令牌**。
 * 这条扫描把它落到可执行的形式——本文件只管"有没有自己画"，颜色/内联样式由
 * test/theme-tokens.test.mjs 管，歌词组件的来源由 test/lyrics-panel.test.mjs 管。要点：
 *
 * 1. 界面文件必须真的组合 shadcn 原语（不是自己拿 div 拼一个表格/按钮）；
 * 2. 不许手写 `<svg>`/`<canvas>`/`dangerouslySetInnerHTML`（图形一律 lucide-react 图标）；
 * 3. 组件契约（TrackTable / PlayerBar / QueuePanel / GridSkeleton 的导出与关键接线）；
 * 4. 渲染层不 import 协议层（业务 HTTP 只在 sidecar；渲染层只走 host-api 的 core_call）；
 * 5. 播放器栏 R9 已接通状态机：`data-state` 由状态给，但**UI 层不持有音频、不碰 core**
 *    （地址与音频都在 features/playback 的运行时里；音频元素的唯一实例由
 *    test/playback-runtime.test.mjs 的扫描钉住）；
 * 6. R12：歌词窗宿主（LyricsWindow.tsx）与歌词窗入口也在网内——它只是第三个 AMLL 宿主，
 *    连 shadcn 原语都不掺（数据全靠广播进来）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/**
 * 组合 shadcn 原语的界面文件（简报 Files 一节 + R9 的舞台 + R39 补齐的三处）。
 *
 * R39 增补 `login-gate.tsx` / `login-chrome.tsx` / `theme-control.tsx`：它们是**早就存在**的
 * 主界面（引导页、两个浮动控件），却一直没进这份名单——扫描范围漏一个文件，那个文件里的
 * 自绘就永远扫不出来。补进来之后要交代的只有一处：门禁那块二维码 `<canvas>`
 * （库的渲染目标，见下面的 `CANVAS_EXCEPTION_FILES`）。
 */
const UI_FILES = [
  "src/renderer/App.tsx",
  "src/renderer/pages.tsx",
  "src/renderer/favorites-page.tsx",
  "src/renderer/components.tsx",
  "src/renderer/playlist-grid.tsx",
  "src/renderer/log-terminal.tsx",
  "src/renderer/playback-stage.tsx",
  "src/renderer/login-gate.tsx",
  "src/renderer/login-chrome.tsx",
  "src/renderer/theme-control.tsx",
];

/**
 * AMLL 宿主组件是**例外**：它们的视觉全部来自官方包（`BackgroundRender` / `LyricPlayer`），
 * 宿主只提供定位容器——所以它们不"组合 shadcn 原语"，但同样不许自绘（见 lyrics-panel.test.mjs）。
 *
 * R12 的 `LyricsWindow.tsx` 是第三处宿主：歌词窗里的一切视觉仍然是官方 `LyricPlayer` 的，
 * 它只多了一件事——把广播来的歌词与进度喂给组件（数据来自主窗转发，见 lyrics-window.test.mjs）。
 */
const AMLL_HOSTS = [
  "src/renderer/AmllBackground.tsx",
  "src/renderer/AmllLyricsPanel.tsx",
  "src/renderer/LyricsWindow.tsx",
];

/** 全部"要么组合原语、要么把视觉交给官方组件"的界面文件。 */
const ALL_UI_FILES = [...UI_FILES, ...AMLL_HOSTS];

/**
 * 手写 `<canvas>` 的唯一例外：登录门禁里那块二维码画布。
 *
 * 为什么它不算自绘：二维码没有 shadcn 原语，绘制必须由成熟库做——`qrcode`（MIT）的
 * `toCanvas` 拿到元素后自己编码、纠错、画静区，渲染层只转发内容与参数
 * （`features/auth/qr-canvas.mjs` 一处，像素由 `test/qr-render.test.mjs` 钉住）。
 * 这跟 AMLL 宿主把画布交给官方渲染器是同一类事。
 *
 * 之所以把它**写出来**而不是让扫描放行 `<canvas>`：例外是一个决定，得有名字、有边界，
 * 且下面有用例断言"全项目只有这一处"。
 */
const CANVAS_EXCEPTION_FILES = ["src/renderer/login-gate.tsx"];

/**
 * 自绘滚动容器的**例外集合**（R39 审计产物）：页面级滚动根，不是"面板"。
 *
 * 规则本身：该 `ScrollArea` 的地方（日志区、队列列表这类**面板**）不许拿 `overflow-y-auto`
 * 自己搭一个。下面三处是"整个页面/整个内容区滚不滚"的布局根，与 `ScrollArea` 的语义不同：
 *
 * - `App.tsx`：`SidebarInset` 的内容区（页面切换的落点）。换成 `ScrollArea` 会把每个页面
 *   塞进 radix 的 `display:table` 内容盒（`ScrollAreaContent`），页面里的百分比高度/`flex-1`
 *   全部失去参照——六个页面的布局要一起重验，超出本轮范围；
 * - `pages.tsx`（搜索页）：那一层 `overflow-y-auto` 在当前布局下**量不到自己的滚动**
 *   （外层内容高度是 auto，`flex-1` 不生效），页面实际由上一个根滚动——它是重复的一层；
 * - `favorites-page.tsx`：收藏页的滚动根**必须**是它自己——`IntersectionObserver` 的 `root`
 *   与 `scrollTop` 位置记忆都要那个真实元素，而 radix 的 viewport 拿不到 ref
 *   （`components/ui/scroll-area.tsx` 是生成原语，不手改）。
 *
 * 三处都记进 task-39-report.md 的「待裁决」，由 kimicode 裁决是"保留并写清理由"还是
 * "改造页面级滚动根"。用例断言**计数逐文件相等**：新写一处自绘滚动容器会红；
 * 把某处改成 `ScrollArea` 也会红（那时请连同这个集合一起改——它是一份决定记录，不是挡路的）。
 */
const SCROLL_ROOT_EXCEPTIONS = {
  "src/renderer/App.tsx": 1,
  "src/renderer/pages.tsx": 1,
  "src/renderer/favorites-page.tsx": 1,
};

const HAND_ROLLED_SCROLLER = /overflow-(?:y-)?(?:auto|scroll)\b/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("组合原语：每个界面文件都从 components/ui 引入 shadcn 原语", () => {
  for (const relative of UI_FILES) {
    const source = read(relative);
    assert.match(
      source,
      /from\s+"[@.]\/?(?:\.\/)?components\/ui\/[a-z-]+"/,
      `${relative} 必须组合 components/ui 下的 shadcn 原语（不许拿 div 拼视觉组件）`,
    );
  }
  // AMLL 宿主的视觉来自官方包：它们不许组合 shadcn（也不许自绘），但要真的在挂官方组件
  for (const relative of AMLL_HOSTS) {
    const source = read(relative);
    assert.match(source, /@applemusic-like-lyrics\/react/, `${relative} 必须用 AMLL 官方组件`);
    assert.doesNotMatch(source, /components\/ui\//, `${relative} 不掺 shadcn 原语（视觉全交官方组件）`);
  }
});

test("不自绘：无手写 svg/innerHTML（图形走 lucide-react 图标）；canvas 只有一处例外", () => {
  const canvases = [];
  for (const relative of ALL_UI_FILES) {
    const source = stripComments(read(relative));
    assert.doesNotMatch(source, /<svg[\s>]/, `${relative} 不得手写 <svg>（图标一律 lucide-react）`);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${relative} 不得注入 HTML`);
    assert.doesNotMatch(source, /<(?:table|thead|tbody|tr|th|td|button|input|select)\b/, `${relative} 的表格/按钮/输入一律走 shadcn 原语`);
    if (/<canvas[\s>]|getContext\(|createElement\(["']canvas/.test(source)) canvases.push(relative);
  }

  // 例外集合写死在这里（与 theme-tokens 那两处 AMLL 内联尺寸同款做法）：多一处就是规则被悄悄放宽
  assert.deepEqual(
    canvases.sort(),
    [...CANVAS_EXCEPTION_FILES].sort(),
    `手写 <canvas> 的例外只有登录门禁那一处（库的渲染目标）：${JSON.stringify(canvases)}`,
  );

  // 而且它不是"允许自己画"：门禁只把 canvas 交给 qr-canvas.mjs 的入口，
  // 编码/纠错/绘制全在成熟库 qrcode 里（画法与像素由 test/qr-render.test.mjs 钉住）
  const gate = stripComments(read("src/renderer/login-gate.tsx"));
  assert.match(gate, /<canvas\b/, "例外真的存在（否则把它从例外集合里删掉，别留着空豁免）");
  assert.doesNotMatch(gate, /getContext\(/, "宿主自己不碰画布上下文（不自己画）");
  assert.match(gate, /paintQrCanvas\(/, "画布只经 features/auth/qr-canvas.mjs 的那一个入口");
  assert.match(
    stripComments(read("src/renderer/features/auth/qr-canvas.mjs")),
    /QRCode\.toCanvas\(/,
    "二维码的绘制属于 qrcode 库（渲染层不碰算法）",
  );
});

test("自绘滚动容器：面板一律走 ScrollArea，页面级滚动根的例外集合写死", () => {
  const measured = {};
  for (const relative of ALL_UI_FILES) {
    const code = stripComments(read(relative));
    const hits = [...code.matchAll(HAND_ROLLED_SCROLLER)].length;
    if (hits > 0) measured[relative] = hits;
  }
  assert.deepEqual(
    measured,
    SCROLL_ROOT_EXCEPTIONS,
    `检测到的自绘滚动容器与例外集合不一致（新加一处要先问过它的语义，改掉一处要同步删例外）：${JSON.stringify(measured)}`,
  );

  // 面板级的滚动区必须真的用 ScrollArea（日志区、队列列表）——例外只管页面级滚动根，别混进来
  for (const relative of ["src/renderer/log-terminal.tsx", "src/renderer/components.tsx"]) {
    assert.match(read(relative), /from\s+"\.\/components\/ui\/scroll-area"/, `${relative} 的滚动区走 shadcn 的 ScrollArea`);
  }
});

test("边界：渲染层不 import 协议层（业务 HTTP 只在 sidecar，界面只走 core_call）", () => {
  for (const relative of ALL_UI_FILES) {
    const source = read(relative);
    assert.doesNotMatch(source, /protocols\//, `${relative} 不得引用协议层（端点与凭据不在渲染层）`);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, `${relative} 不得自己发请求（唯一通道是 host-api 的 coreCall）`);
  }

  // 取数的页面走 host-api；外壳自己不取数（它是布局与导航，不掺业务请求）
  for (const relative of ["src/renderer/pages.tsx", "src/renderer/favorites-page.tsx", "src/renderer/log-terminal.tsx"]) {
    assert.match(read(relative), /from\s+"\.\/host-api"/, `${relative} 的数据入口必须是 host-api`);
  }
  assert.doesNotMatch(read("src/renderer/App.tsx"), /\bcoreCall\(/, "App.tsx 是外壳，不直接取数（取数在页面里）");
});

test("组件契约：TrackTable / PlayerBar / QueuePanel / GridSkeleton 都在 components.tsx 里", () => {
  const source = read("src/renderer/components.tsx");
  for (const name of ["TrackTable", "PlayerBar", "QueuePanel", "GridSkeleton", "EmptyState"]) {
    assert.match(source, new RegExp(`export function ${name}\\(`), `components.tsx 必须导出 ${name}`);
  }
  // 表格用 shadcn 的 Table 原语，交互按简报：双击播放 + 键盘可达 + 收藏切换
  assert.match(source, /from\s+"\.\/components\/ui\/table"/, "TrackTable 必须用 shadcn 的 Table");
  assert.match(source, /onDoubleClick=/, "双击播放是简报要求的交互");
  assert.match(source, /onKeyDown=/, "键盘可达是简报要求的交互");
  assert.match(source, /aria-pressed=/, "收藏切换要有可读的按下状态（不是只有颜色）");
});

test("播放器栏已接通：data-state 由状态机给、UI 层不持有音频也不碰 core（R9 翻转）", () => {
  const source = read("src/renderer/components.tsx");
  const code = stripComments(source);
  assert.doesNotMatch(code, /new\s+Audio\s*\(|HTMLAudioElement|\.play\(\)/, "音频只在 features/playback/audio-element.mjs 里");
  assert.doesNotMatch(code, /coreCall\(|playback:resolve-url|PLAYBACK_RESOLVE_URL/, "地址只在运行时里取（UI 拿不到）");
  assert.doesNotMatch(code, /amll|AMLL/i, "歌词组件是 R9 的宿主文件（Amll*.tsx），组件库不掺进来");
  assert.match(code, /data-state=\{state\.status\}/, "占位态已翻转为真实状态（扫描与 review 都按它认）");
  assert.match(code, /from\s+"\.\/components\/ui\/slider"/, "进度/音量走 shadcn 的 Slider");
  assert.match(code, /disabled=/, "没有可播曲目时按钮仍是禁用的（点了没反应比禁用更糟）");
});

test("收藏页：常驻挂载 + IntersectionObserver 滚动加载 + 位置恢复锚点，且合并逻辑全部来自纯逻辑模块", () => {
  const source = read("src/renderer/favorites-page.tsx");
  assert.match(source, /favorites-pagination\.mjs/, "合并/计数逻辑必须来自 features/library/favorites-pagination.mjs");
  assert.match(source, /IntersectionObserver/, "滚动加载用 IntersectionObserver");
  assert.match(source, /FAVORITES_SENTINEL_TESTID/, "哨兵锚点来自逻辑模块的常量（改名即改契约）");
  assert.match(source, /data-scroll-root=/, "滚动容器要带 data-scroll-root 语义属性");
  assert.match(source, /FAVORITES_SCROLL_KEY/, "滚动位置记忆的键来自逻辑模块（属性值同一处）");
  assert.match(source, /\bhidden\b/, "切页时用 hidden 保留挂载（不许卸载）");
  assert.match(source, /data-resident="favorites"/, "常驻挂载要有明确标记");
  assert.doesNotMatch(source, /new Set\(|\.filter\(\(item\)/, "去重与筛选不许在 UI 里再做一遍");
});

test("外壳：侧边栏导航来自 views.mjs 的唯一真源，页面切换是 renderPage() 的 switch（无路由库）", async () => {
  const app = read("src/renderer/App.tsx");
  assert.match(app, /from\s+"\.\/features\/library\/views\.mjs"/, "视图模型必须来自 views.mjs");
  assert.match(app, /SIDEBAR_VIEWS/, "侧边栏条目来自 SIDEBAR_VIEWS");
  assert.match(app, /data-testid=\{NAV_LIST_TESTID\}/, "导航列表要挂 nav-list 锚点");
  assert.match(app, /switch\s*\(/, "页面切换用 renderPage() 的 switch");
  assert.doesNotMatch(app, /react-router|wouter|@tanstack\/router/, "不引入路由库（视图状态就是 useState）");
  assert.match(app, /data-shell="app-shell"/, "保留 R7 的 app-shell 锚点");
  assert.match(read("src/renderer/main.tsx"), /installDesktopBridge\(\)/, "宿主桥在渲染第一帧前就位");

  // 每个视图都要有落点：常驻的收藏页挂在 switch 之外（不卸载），其余每个视图一个 case
  const { VIEW, VIEW_IDS } = await import("../src/renderer/features/library/views.mjs");
  const camel = (id) => id.split("-").map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join("");
  for (const id of VIEW_IDS) {
    if (id === VIEW.favorites) continue;
    assert.match(app, new RegExp(`case VIEW\\.${camel(id)}:`), `App.tsx 缺少 ${id} 的页面分支`);
  }
  assert.match(app, /<FavoritesPage[^>]*active=/, "收藏页常驻挂载，用 active 控制显隐（不是卸载）");

  for (const relative of ["src/renderer/App.tsx", "src/renderer/pages.tsx"]) {
    assert.doesNotMatch(read(relative), /["'`]library:[a-z-]+["'`]/, `${relative} 的频道名一律 import 共享常量`);
  }
});

test("库页面的数据入口：一次一页地走 coreCall，频道名来自共享常量", () => {
  const source = read("src/renderer/pages.tsx");
  assert.match(source, /coreCall\(/, "页面数据只经 coreCall");
  for (const constant of [
    "LIBRARY_PLAYLISTS",
    "LIBRARY_PLAYLIST_DETAIL",
    "LIBRARY_SEARCH",
    "LIBRARY_ALBUM",
    "LIBRARY_ARTIST",
    "LIBRARY_HISTORY",
  ]) {
    assert.match(source, new RegExp(constant), `pages.tsx 要用共享常量 ${constant}（不写字面量频道名）`);
  }
  assert.match(source, /libraryEmptyText|libraryFailureText/, "空态/失败文案来自 library-state.mjs（克制且不冒充）");
  assert.match(
    source,
    /libraryEmptyText\(view, \{ searched: true \}\)/,
    "搜索页的「查无所获」要用 searched 那一档（不是「输入关键字开始搜索」）",
  );
});
