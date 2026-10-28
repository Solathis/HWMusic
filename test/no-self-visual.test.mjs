/**
 * 主界面 · 不自绘视觉（源码扫描）：项目的 UI 约束只有一句——只组合 shadcn 原语 + Tailwind 工具类 + 设计令牌。
 *
 * 本文件只管「有没有自己画」：颜色与内联样式归 theme-tokens.test.mjs，歌词组件来源归 lyrics-panel.test.mjs。
 * AMLL 宿主与歌词窗是例外，同样不许自绘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 组合 shadcn 原语的界面文件名单：扫描范围漏一个文件，那个文件里的自绘就永远扫不出来。 */
const UI_FILES = [
  "src/renderer/App.tsx",
  "src/renderer/pages.tsx",
  "src/renderer/favorites-page.tsx",
  "src/renderer/components.tsx",
  // 侧栏「我的歌单」这一组（原「我的歌单」页与 playlist-grid.tsx 一起删除）
  "src/renderer/sidebar-playlists.tsx",
  "src/renderer/log-terminal.tsx",
  "src/renderer/playback-stage.tsx",
  "src/renderer/login-gate.tsx",
  "src/renderer/login-chrome.tsx",
  "src/renderer/theme-control.tsx",
  // 左下角那枚主题循环按钮（图标 + tooltip 都是 shadcn/lucide，没有自绘）
  "src/renderer/theme-toggle.tsx",
  // 歌词设置弹出窗（菜单本体是官方 DropdownMenu，控件全是 shadcn 原语）
  "src/renderer/LyricsSettingsPopup.tsx",
];

/** AMLL 宿主是例外：视觉全部来自官方包（BackgroundRender / LyricPlayer），宿主只提供定位容器，同样不许自绘。 */
const AMLL_HOSTS = [
  "src/renderer/AmllBackground.tsx",
  "src/renderer/AmllLyricsPanel.tsx",
  "src/renderer/LyricsWindow.tsx",
];

/** 全部"要么组合原语、要么把视觉交给官方组件"的界面文件。 */
const ALL_UI_FILES = [...UI_FILES, ...AMLL_HOSTS];

/** 手写 canvas 的唯一例外：登录门禁的二维码画布，绘制交给 qrcode 库；下面有用例断言全项目只有这一处。 */
const CANVAS_EXCEPTION_FILES = ["src/renderer/login-gate.tsx"];

/** 自绘滚动容器的例外集合：页面级滚动根（App 内容区、收藏页），不是面板；用例断言计数逐文件相等。 */
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

test("组件契约：TrackTable / PlayerBar / QueuePanel 都在 components.tsx 里", () => {
  const source = read("src/renderer/components.tsx");
  for (const name of ["TrackTable", "PlayerBar", "QueuePanel", "EmptyState"]) {
    assert.match(source, new RegExp(`export function ${name}\\(`), `components.tsx 必须导出 ${name}`);
  }
  // 表格用 shadcn 的 Table 原语，交互：双击播放 + 键盘可达 + 收藏切换
  assert.match(source, /from\s+"\.\/components\/ui\/table"/, "TrackTable 必须用 shadcn 的 Table");
  assert.match(source, /onDoubleClick=/, "双击播放是简报要求的交互");
  assert.match(source, /onKeyDown=/, "键盘可达是简报要求的交互");
  assert.match(source, /aria-pressed=/, "收藏切换要有可读的按下状态（不是只有颜色）");

  /** 曲目表不许出现横向滚动：table-fixed、列宽配比只有一处真源、长内容截断。 */
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

  /** 表格在调用点吃 16px 页面留白，并放开生成容器的 overflow，让表头 sticky 跟着页面滚动根走。 */
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

  /** 骨架屏占的是真实内容的位置：行高 52px 与真实行高对齐，加载完不再往下长。 */
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
  // 取数实现在一处（页面与侧栏歌单共用），所以 coreCall 的断言跟着它走
  const hook = read("src/renderer/features/library/use-library-resource.ts");
  assert.match(hook, /coreCall\(/, "库数据只经 coreCall");
  assert.match(hook, /from\s+"\.\.\/\.\.\/host-api"/, "取数的唯一入口是 host-api");
  const source = read("src/renderer/pages.tsx");
  for (const constant of [
    "LIBRARY_PLAYLIST_DETAIL",
    "LIBRARY_SEARCH",
    "LIBRARY_ALBUM",
    "LIBRARY_ARTIST",
    "LIBRARY_HISTORY",
  ]) {
    assert.match(source, new RegExp(constant), `pages.tsx 要用共享常量 ${constant}（不写字面量频道名）`);
  }
  assert.match(
    read("src/renderer/sidebar-playlists.tsx"),
    /LIBRARY_PLAYLISTS/,
    "歌单列表的取数在侧栏，也用共享常量（不写字面量频道名）",
  );
  assert.match(source, /libraryEmptyText|libraryFailureText/, "空态/失败文案来自 library-state.mjs（克制且不冒充）");
  assert.match(
    source,
    /libraryEmptyText\(view, \{ searched: true \}\)/,
    "搜索页的「查无所获」要用 searched 那一档（不是「输入关键字开始搜索」）",
  );
});

/** 搜索入口只有一个：侧栏顶部那个常驻框，搜索页里没有第二个输入框。 */
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

  // 歌单详情页：头部 + 两个动作 + 表格，说明「只加载了一部分」的文案已整条删除
  const detail = pages.slice(pages.indexOf("export function PlaylistDetailPage"), pages.indexOf("// 搜索：结果"));
  assert.match(detail, /PLAYLIST_PLAY_ALL_LABEL/, "「播放全部」的文案来自纯逻辑模块");
  assert.match(detail, /PLAYLIST_ENQUEUE_LABEL/, "「加入队列」同理");
  assert.doesNotMatch(detail, /playlistPartialNoticeText/, "R55：说明文案不再渲染");
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

/** 侧栏收起 = 图标轨：collapsible=icon + 导航 tooltip + 窄轨里搜索降级成图标按钮；全项目必须有 TooltipProvider。 */
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
  // 窄轨里账号区只留头像（48px 轨道塞不下三个图标）
  assert.match(app, /group-data-\[collapsible=icon\]:justify-center/, "窄轨里账号区居中放那一个头像");
  assert.match(app, /group-data-\[collapsible=icon\]:hidden/, "窄轨里名字/徽标/主题/退出隐藏");
  assert.doesNotMatch(app, /group-data-\[collapsible=icon\]:flex-col/, "不再把三个图标竖排进窄轨（R57 改成只剩头像）");
});

/** 左下角主题按钮必须在退出登录之前（DOM 顺序 = 视觉顺序），且是纯图标。 */
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
