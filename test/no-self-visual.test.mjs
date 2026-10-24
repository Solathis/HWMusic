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
  // R41b：左下角那枚主题循环按钮（图标 + tooltip 都是 shadcn/lucide，没有自绘）
  "src/renderer/theme-toggle.tsx",
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
 * - `favorites-page.tsx`：收藏页的滚动根**必须**是它自己——`IntersectionObserver` 的 `root`
 *   与 `scrollTop` 位置记忆都要那个真实元素，而 radix 的 viewport 拿不到 ref
 *   （`components/ui/scroll-area.tsx` 是生成原语，不手改）。
 *
 * **R40 删掉了 `pages.tsx` 那一处**（R39 待裁决 ② 的落地）：它是搜索页里那层包住结果的
 * `overflow-y-auto`，而搜索页的输入框已经搬到侧栏——结果直接落在 `App.tsx` 那个页面级滚动根里，
 * 重复的一层随之消失（采集函数也真的量不到它自己的滚动，R39 已记）。所以例外集合现在是两处。
 *
 * 用例断言**计数逐文件相等**：新写一处自绘滚动容器会红；把某处改成 `ScrollArea` 也会红
 * （那时请连同这个集合一起改——它是一份决定记录，不是挡路的）。
 */
const SCROLL_ROOT_EXCEPTIONS = {
  "src/renderer/App.tsx": 1,
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
  // 歌词始终来自官方包；桌面控制与 surface 允许组合 shadcn。
  for (const relative of AMLL_HOSTS) {
    const source = read(relative);
    assert.match(source, /@applemusic-like-lyrics\/react/, `${relative} 必须用 AMLL 官方组件`);
    if (relative === "src/renderer/LyricsWindow.tsx") assert.match(source, /components\/ui\//, "桌面控件/surface 使用 shadcn，歌词仍由 AMLL 渲染");
    else assert.doesNotMatch(source, /components\/ui\//, `${relative} 不掺 shadcn 原语（视觉全交官方组件）`);
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

  /**
   * R40 第 5 项：曲目表**不许出现横向滚动**。
   *
   * 真机取证（`.tmp/r40-table-baseline.json`）说明默认的 `auto` 布局就是根因：列宽由内容决定，
   * 表格在 1024 宽的内容区里长到 1361 px。所以这里钉三件事：
   * ① table-fixed；② 标题/艺人百分比宽度只有一处真源，专辑吃余量；③ 固定小列不变、长内容截断。
   */
  assert.match(source, /<Table className="table-fixed"/, "曲目表必须是 table-fixed（auto 布局会被 nowrap 内容撑破）");
  assert.match(source, /const TRACK_COLUMN_WIDTHS = \{/, "列宽配比要有名字（一处真源，不是散落的魔法值）");
  assert.match(source, /title: "w-\[32%\]"/, "标题固定为 32%（不再吃全部余量）");
  assert.match(source, /artist: "w-\[24%\]"/, "艺人固定为 24%（按容器收，不按内容撑）");
  assert.match(source, /<TableHead className=\{TRACK_COLUMN_WIDTHS.title\}>标题<\/TableHead>/);
  assert.match(source, /<TableHead>专辑<\/TableHead>/, "专辑是唯一的余量列");
  assert.doesNotMatch(source, /album: "w-\[/, "专辑不再有固定百分比");
  for (const [key, width] of [["index", "w-10"], ["duration", "w-16"], ["favorite", "w-12"]]) {
    assert.ok(source.includes(`${key}: "${width}"`), `${key} 固定小列不变`);
  }
  assert.doesNotMatch(
    stripComments(source),
    /w-40/,
    "旧的固定 160px 列宽已删（它正是溢出的那一版）——注释里提它是说明文字，代码里不许再有",
  );
  assert.match(source, /max-w-full truncate/, "列内内容要真截断（ellipsis），不是只靠列宽");

  /**
   * R41b 排版两项（brief 第 4 项），都落在**调用点**而不是生成的 `components/ui/table.tsx`：
   *
   * ① **页面级横向留白**：曲目表此前是贴边的（真机量：表格左边缘 256 = 内容区左边缘），
   *    而歌单网格（`p-4`）、设置页（`m-4`）、空态（`px-4`）都在 16px 上——同一栏内容翻页时左边缘跳。
   * ② **表头 sticky**：生成的 `Table` 外面套着一层 `overflow-x-auto` 容器，一个轴 auto 会让另一个轴
   *    的 visible 也算成 auto，于是那层容器成了滚动容器，`sticky top-0` 只相对它定位（它自己从不
   *    纵向滚动）——真机量的 `position: static`，表头照样滚走。这里在调用点把那层容器的 overflow
   *    放开，让表头跟着页面那个滚动根走。
   */
  assert.match(
    stripComments(source),
    /className="px-4 \[&>\[data-slot=table-container\]\]:overflow-visible"/,
    "表格要跟其余页面一样吃 16px 留白，并在调用点放开生成容器的 overflow（表头 sticky 的前提）",
  );
  assert.match(
    stripComments(source),
    /<TableHeader className="sticky top-0 z-10 bg-background">/,
    "表头 sticky + 令牌底色（滚下去之后列名还在，且不透明才不会透出下面的行）",
  );
  // 生成原语一个字都不许改：覆盖必须留在调用点（改了下一个 `shadcn add` 就把它冲掉）
  assert.match(
    read("src/renderer/components/ui/table.tsx"),
    /className="relative w-full overflow-x-auto"/,
    "components/ui/table.tsx 是生成物，不许手改",
  );

  /**
   * 骨架屏占的是"真实内容的位置"：曲目表真实行高 = `p-2` + `size-9` 封面 = 52~53px（真机量 53px），
   * 而 `h-6`（24px）+ `gap-2` 只有 32px 一行——加载完的那一瞬间内容往下长一倍。
   * 现在 44 + 8 = 52px/行，与真实行高对齐。
   */
  assert.match(
    stripComments(source),
    /<Skeleton key=\{index\} className="h-11 w-full" \/>/,
    "列表骨架的行高要与真实行高（52~53px）对齐",
  );
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

/**
 * R40 第 4 项：搜索入口只有一个——侧栏顶部那个常驻框。
 *
 * 这条扫描钉的是"delete-then-rewrite"真的发生了：入口在外壳（`SidebarInput` + 提交时切视图），
 * 页面只剩结果（**没有第二个输入框**，也不再自己存检索词）。留两个输入入口的下场是
 * 侧栏显示 A、内容区显示 B 的结果，用户不知道哪个算数。
 */
test("R40 搜索布局：入口只有侧栏那个常驻框，搜索页里没有第二个输入框", () => {
  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /<SidebarHeader>/, "常驻搜索框放在侧栏顶部（shadcn 官方位置）");
  assert.match(app, /<SidebarInput\b/, "用 shadcn sidebar 的 SidebarInput 原语");
  assert.match(app, /createView\(VIEW\.search, \{ keyword/, "提交时把关键字放进搜索视图的参数（结果页据此取数）");
  assert.match(app, /<SearchPage view=\{view\}/, "搜索页要拿到视图（关键字从那里来）");
  // 导航图标表里不许再有搜索（它是"导航项"的图标表；搜索已经不是导航项）
  const navIcons = app.slice(app.indexOf("const NAV_ICONS"), app.indexOf("export function LibraryShell"));
  assert.ok(navIcons.length > 0, "要能在 App.tsx 里定位 NAV_ICONS");
  assert.doesNotMatch(navIcons, /VIEW\.search/, "搜索图标不再进导航图标表（它已经不是导航项）");

  const pages = stripComments(read("src/renderer/pages.tsx"));
  const searchPage = pages.slice(pages.indexOf("export function SearchPage"), pages.indexOf("export function AlbumPage"));
  assert.ok(searchPage.length > 0, "要在 pages.tsx 里找到 SearchPage 这一段");
  assert.doesNotMatch(searchPage, /<Input\b/, "搜索页里不许再有输入框（入口已搬到侧栏）");
  assert.doesNotMatch(searchPage, /<form\b/, "表单也随输入框一起走");
  assert.match(searchPage, /viewParam\(view, "keyword"\)/, "检索词从视图参数读（不自己存一份）");
  assert.match(searchPage, /libraryEmptyText\(view, \{ searched: true \}\)/, "「查无所获」那一档照旧");

  // 歌单详情页（R40 第 2 项）：头部 + 两个动作 + 表格，且动作只作用于已加载的曲目
  const detail = pages.slice(pages.indexOf("export function PlaylistDetailPage"), pages.indexOf("// 搜索：结果"));
  assert.match(detail, /PLAYLIST_PLAY_ALL_LABEL/, "「播放全部」的文案来自纯逻辑模块");
  assert.match(detail, /PLAYLIST_ENQUEUE_LABEL/, "「加入队列」同理");
  assert.match(detail, /playlistPartialNoticeText/, "分页没走完要有一句说明（不把已加载说成全部）");
  assert.match(detail, /<AmllBackground/, "头部底景用 AMLL 官方流体背景");
  assert.match(
    detail,
    /<BrowsableTrackList/,
    "正文仍是那一个曲目表（R45A3 起包在触底分页的外壳里：外壳与四页共用同一份渲染）",
  );
  // 外壳里必须还是那一个 TrackTable（把正文换成别的东西会让双击播放/键盘可达一起消失）
  const shell = pages.slice(pages.indexOf("function BrowsableTrackList"), pages.indexOf("export interface PageNavigationProps"));
  assert.ok(shell.length > 0, "要能在 pages.tsx 里找到 BrowsableTrackList");
  assert.match(shell, /<TrackTable/, "分页外壳的正文仍是 TrackTable");
  assert.doesNotMatch(detail, /\bfetch\s*\(/, "封面仍然只能走 <img>/new Image（不 fetch）");
});

/**
 * R41b 第 1 项：侧栏收起 = **图标轨**，不是整块滑出。
 *
 * 根因是 shadcn sidebar 的默认 `collapsible = "offcanvas"`（收起时整块移到 `left: -16rem`），
 * 而 `<Sidebar>` 没传参数——"收起侧栏"于是与"关掉侧栏"在界面上完全一样，导航再也点不到。
 * 判据不是"看起来还在"（那要靠真机量），而是**结构上就是官方那一档**：
 * `collapsible="icon"` + 导航项的官方 `tooltip` + 窄轨里搜索的官方降级形态。
 *
 * 另外钉住 `TooltipProvider`：radix 的 `Tooltip` 没有 Provider 会**直接抛错**
 * （"must be used within TooltipProvider"），而全项目此前一处 tooltip 都没用上——
 * 少了这一层，整个主界面会白屏。
 */
test("R41b 侧栏：collapsible=icon + 导航 tooltip + 窄轨里搜索只剩一枚图标按钮", () => {
  const app = stripComments(read("src/renderer/App.tsx"));

  assert.match(app, /<Sidebar collapsible="icon">/, "收起要留图标轨（offcanvas 是整块滑出，导航就没了）");
  assert.match(app, /<TooltipProvider>/, "导航 tooltip 需要 Provider（radix 没有它会直接抛错）");
  assert.match(
    app,
    /<SidebarMenuButton\s+tooltip=\{entry\.label\}/,
    "窄轨里导航项只剩图标：tooltip 用官方的那个参数（不是自己搭一个悬浮层）",
  );

  // 窄轨里的搜索：输入框与提交按钮在那个宽度里没有可用形态 → 官方做法是收起时不渲染它
  assert.match(app, /const railCollapsed = sidebar\.state === "collapsed" && !sidebar\.isMobile/, "收起态判定要排除移动端（Sheet 形态没有窄轨）");
  assert.match(app, /data-testid="sidebar-search-rail"/, "窄轨里必须留一枚搜索图标按钮（入口不能消失）");
  assert.match(app, /sidebar\.setOpen\(true\)/, "点它先展开侧栏（然后光标才落得到输入框上）");
  assert.match(app, /searchInputRef\.current\?\.focus\(\)/, "展开后把光标交给输入框（用户点的是「搜索」）");
  // 账号区在窄轨里竖排、名字与 VIP 徽标隐藏（三个图标在 32px 宽的轨道里横着放不下）
  assert.match(app, /group-data-\[collapsible=icon\]:flex-col/, "窄轨里账号区竖排");
  assert.match(app, /group-data-\[collapsible=icon\]:hidden/, "窄轨里名字/徽标隐藏（官方 SidebarGroupLabel 同款做法）");
});

/**
 * R41b 第 3 项：左下角的主题按钮**在退出登录左边**，且是纯图标。
 *
 * 位置这件事只能靠源码顺序钉（DOM 顺序就是视觉顺序）：`<ThemeToggle>` 必须出现在那个
 * `AlertDialog`（退出登录）之前。图标本身是 lucide，颜色是令牌类（theme-tokens 扫）。
 */
test("R41b 左下角：主题图标按钮在退出登录左边（DOM 顺序 = 视觉顺序）", () => {
  const app = stripComments(read("src/renderer/App.tsx"));
  const footer = app.slice(app.indexOf("<SidebarFooter>"), app.indexOf("</SidebarFooter>"));
  assert.ok(footer.length > 0, "要能在 App.tsx 里定位 SidebarFooter");

  const themeAt = footer.indexOf("<ThemeToggle");
  const logoutAt = footer.indexOf("ACCOUNT_LOGOUT_TITLE");
  assert.ok(themeAt > -1, "账号区要有主题按钮");
  assert.ok(logoutAt > -1, "账号区要有退出登录按钮");
  assert.ok(themeAt < logoutAt, "主题按钮必须在退出登录**左边**");

  const toggle = read("src/renderer/theme-toggle.tsx");
  assert.match(toggle, /from\s+"lucide-react"/, "图标走 lucide（禁自绘）");
  assert.match(toggle, /size="icon-sm"/, "纯图标按钮（shadcn Button 原语）");
  assert.match(toggle, /aria-label=\{label\}/, "纯图标按钮必须有无障碍名称（说清当前档位与下一步）");
  assert.match(toggle, /\.\/components\/ui\/tooltip/, "窄轨里那枚图标靠 tooltip 说人话");
});
