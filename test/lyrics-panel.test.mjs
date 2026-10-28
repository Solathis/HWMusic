/**
 * 歌词面板与播放器接通 · 源码扫描（**逐行滚动必须来自 AMLL 官方组件**）。
 * `LyricPlayer` / `BackgroundRender` **只能**来自 `@applemusic-like-lyrics/react`，禁自绘。
 * 宿主的职责只有三件：定位容器、rAF 逐帧推 `currentTime`、标注 `isSeeking`，不渲染歌词文本。
 * 进度同步走 `features/lyrics/lyric-sync.mjs`；播放器栏接通状态机但不持有音频元素、不碰 core。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 只扫代码，不扫注释（注释里写"禁自绘"是说明文字）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 渲染层的全部手写源码（排除 shadcn 生成物）。 */
function rendererFiles() {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(tsx|ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(child);
    }
  };
  walk("src/renderer");
  return found.filter((relative) => !relative.startsWith("src/renderer/components/ui/"));
}

const AMLL_HOSTS = [
  "src/renderer/AmllBackground.tsx",
  "src/renderer/AmllLyricsPanel.tsx",
  // 桌面歌词窗也是 AMLL 宿主（进度来自广播而不是本地音频）
  "src/renderer/LyricsWindow.tsx",
];
const STAGE = "src/renderer/playback-stage.tsx";

test("官方组件：背景与歌词都来自 @applemusic-like-lyrics/react（不是自己画的）", () => {
  const background = read("src/renderer/AmllBackground.tsx");
  const panel = read("src/renderer/AmllLyricsPanel.tsx");

  assert.match(background, /import\s*\{[^}]*BackgroundRender[^}]*\}\s*from\s*"@applemusic-like-lyrics\/react"/);
  assert.match(panel, /import\s*\{[^}]*LyricPlayer[^}]*\}\s*from\s*"@applemusic-like-lyrics\/react"/);
  assert.match(background, /<BackgroundRender/, "背景必须由官方组件渲染（流体/模糊都是它的事）");
  assert.match(panel, /<LyricPlayer/, "逐行滚动必须由官方 LyricPlayer 渲染");
});

test("禁自绘：渲染层不得自己实现 LyricPlayer / BackgroundRender（同名组件一律算越界）", () => {
  for (const relative of rendererFiles()) {
    const code = stripComments(read(relative));
    assert.doesNotMatch(
      code,
      /(?:export\s+)?(?:function|const|class)\s+(?:LyricPlayer|BackgroundRender)\b/,
      `${relative} 自己实现了 AMLL 组件名（禁自绘：逐行滚动只能来自官方包）`,
    );
  }
});

test("禁自绘动画：宿主里没有画布、没有手写时间戳、没有自己渲染歌词文本", () => {
  for (const relative of [...AMLL_HOSTS, STAGE]) {
    const code = stripComments(read(relative));
    assert.doesNotMatch(code, /<canvas[\s>]|getContext\(|createElement\(["']canvas/, `${relative} 不得自绘画布`);
    assert.doesNotMatch(code, /<svg[\s>]/, `${relative} 的图形一律走 lucide 图标`);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/, `${relative} 不得注入 HTML`);
    assert.doesNotMatch(code, /\\d\{2\}:\\d\{2\}/, `${relative} 不得出现手写时间戳正则（那是自绘解析）`);
    assert.doesNotMatch(code, /\.words\b|words\.map/, `${relative} 不得自己渲染歌词文本（交 LyricPlayer）`);
    assert.doesNotMatch(code, /setInterval\(/, `${relative} 不得用定时器推进度（用 rAF，见 lyric-sync）`);
  }
});

test("宿主职责：LyricPlayer 收到 lyricLines/currentTime/isSeeking/playing（受控推进）", () => {
  const panel = read("src/renderer/AmllLyricsPanel.tsx");
  assert.match(panel, /lyricLines=\{/, "歌词数组由宿主推给它");
  assert.match(panel, /currentTime=\{/, "进度由宿主逐帧推（AMLL 不自己读音频）");
  assert.match(panel, /isSeeking=\{/, "跳转要标注，否则拖进度时歌词会自己飞");
  assert.match(panel, /playing=\{/, "播放/暂停状态要传（间奏动画靠它）");
  assert.match(panel, /from\s*"\.\/features\/lyrics\/lyric-sync\.mjs"/, "进度泵必须来自纯逻辑模块");
  assert.match(panel, /createLyricSync\(/, "用那个模块，不另写一份");
  assert.match(panel, /requestAnimationFrame/, "rAF 逐帧");
  assert.match(panel, /cancelAnimationFrame/, "卸载要停帧（否则后台一直烧 CPU）");
  assert.match(panel, /notifySeek\(\)/, "seek 要通知进度泵（200ms 窗口在模块里）");
  assert.match(panel, /seekGeneration/, "跳转信号来自状态机（不是自己猜的时间差）");
  assert.doesNotMatch(stripComments(panel), /\b200\b/, "200ms 窗口只许写在 lyric-sync.mjs（唯一真源）");
  assert.match(read("src/renderer/features/lyrics/lyric-sync.mjs"), /LYRICS_SEEK_WINDOW_MS\s*=\s*200/);
});

test("歌词舞台：定位容器 + 压暗层 + 文案来自纯逻辑模块（不自造说法）", () => {
  const stage = read(STAGE);
  assert.match(stage, /<AmllBackground/, "舞台要有 AMLL 背景");
  assert.match(stage, /<AmllLyricsPanel/, "舞台要有 AMLL 歌词");
  assert.match(stage, /absolute inset-0/, "舞台是定位容器（覆盖内容区）");
  assert.match(stage, /bg-background\//, "压暗层用设计令牌（背景之上、歌词之下）");
  assert.match(stage, /lyricsNoticeText/, "占位文案来自 playback-state.mjs（三档不混）");
  assert.doesNotMatch(stripComments(stage), /歌词来源|还没有歌词|敬请期待/, "文案不许在组件里另写一份");
  assert.match(stage, /<Button[\s\S]*?aria-label="收起歌词"/, "沉浸页收起用 shadcn Button（官方组件，不手写可点 div）");
});

/** 全应用遮挡与字迹像素由 scripts/test-browser.mjs 的完整组合回归验证。 */
test("沉浸舞台：官方 full 控件复用同一 runtime、尊重 prefers-reduced-motion", () => {
  const stage = stripComments(read(STAGE));
  assert.doesNotMatch(stage, /<PlayerBar|import.*PlayerBar/, "主界面的 shadcn 底栏不复制进沉浸舞台");
  for (const component of ["AutoLyricLayout", "Cover", "MusicInfo", "MediaButton", "BouncingSlider", "VolumeControl"]) {
    assert.match(stage, new RegExp(`<${component}\\b`), `沉浸视觉使用官方 ${component}`);
  }
  assert.match(stage, /from "@applemusic-like-lyrics\/react-full"/, "控件来自官方 full 包");
  assert.doesNotMatch(stage, /new Audio|HTMLAudioElement|coreCall\(/, "沉浸控件不重建音频或业务请求");
  assert.match(stage, /runtime\.player/, "只转发到已有播放器运行时");

  // 3. 关闭入口与动画
  assert.match(stage, /aria-label="收起歌词"/, "收起按钮保留（R45C：顶部中央的下拉箭头，不再右上角叉号）");
  assert.match(stage, /motion-safe:animate-in/, "打开动效用官方能力，并且只在允许动效时播");
  assert.match(stage, /motion-safe:fade-in/, "淡入用官方的 fade-in 工具类");
  assert.match(stage, /<MotionConfig reducedMotion="user">/, "官方 full 的 framer 布局动效也必须尊重用户设置");
  assert.match(stage, /motion-reduce:transition-none/, "官方 Cover 的 CSS 过渡使用 Tailwind motion-reduce");
  assert.doesNotMatch(stage, /@keyframes|animation:\s/, "不许自己写关键帧（动效只走官方能力）");
});

test("播放器栏接通：data-state 由状态机给（不再是 placeholder），但 UI 不持有音频、不碰 core", () => {
  const components = stripComments(read("src/renderer/components.tsx"));

  assert.doesNotMatch(components, /data-state="placeholder"/, "占位态已翻转为真实状态");
  assert.match(components, /data-state=\{/, "data-state 由状态机状态给（扫描与 review 都按它认）");
  assert.doesNotMatch(components, /new\s+Audio\s*\(|HTMLAudioElement/, "音频元素在 features/playback/audio-element.mjs");
  assert.doesNotMatch(components, /coreCall\(/, "地址只在运行时里取（UI 层碰不到它）");
  assert.doesNotMatch(components, /PLAYBACK_RESOLVE_URL|playback:resolve-url/, "频道名也不该出现在 UI 层");

  assert.match(components, /from\s*"\.\/components\/ui\/slider"/, "进度与音量用 shadcn 的 Slider");
  assert.match(components, /from\s*"\.\/components\/ui\/dropdown-menu"/, "播放模式切换用 shadcn 的菜单");
  assert.match(components, /aria-label=\{?["`]?播放|aria-label="播放"/, "播放/暂停要有无障碍名称");
  assert.match(components, /playerStatusText/, "状态文案来自 playback-state.mjs");
  assert.match(components, /player\.seek\(/, "拖动要真的 seek（跳转信号由状态机递增，歌词面板据此标 isSeeking）");

  // 双击播放的承诺必须成立：onActivate 要带上下标
  assert.match(components, /onDoubleClick=\{\(\)\s*=>\s*onActivate\?\.\(song,\s*index\)\}/, "双击要把行下标一起给出去");
  assert.match(components, /onActivate\?\.\(song,\s*index\)/, "键盘激活同理（回车/空格）");
});

/**
 * 控件居中，不随左侧内容宽度漂移。
 * 判据是**结构上就是中间**：控件组用绝对定位钉在 50% 上（`left-1/2 -translate-x-1/2`）。
 */
test("R40 播放器栏三区：控件组绝对居中 + 封面/曲目信息是「进入播放页」的入口", () => {
  const components = stripComments(read("src/renderer/components.tsx"));

  assert.match(components, /data-testid="player-controls"/, "控件组要有锚点（CDP/测试按它量中点）");
  assert.match(
    components,
    /className="absolute left-1\/2 flex -translate-x-1\/2 items-center gap-1"/,
    "控件组必须绝对居中（left-1/2 + -translate-x-1/2）：等分两侧做不到真居中",
  );
  assert.doesNotMatch(components, /ml-auto flex items-center gap-1/, "旧的「控件挂右」布局已删（那是用户报的问题）");
  assert.match(components, /data-testid="player-track-info"/, "左区（封面 + 曲目信息）要有锚点");
  assert.match(components, /onOpenStage/, "左区可点 = 打开歌词舞台（同一个 state）");
  assert.match(components, /min-w-0/, "左区要能在窄窗里收缩（truncate 的前提）");
  assert.match(components, /data-testid="player-bar-trailing"/, "右区是明确的空占位（三区语义不塌）");

  // 外壳把它接到与头部按钮**同一个** state 上
  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /onOpenStage=\{\(\)\s*=>\s*setStageOpen\(true\)\}/, "封面点击开舞台（与头部「歌词」同一个 setStageOpen）");
  assert.match(app, /aria-label="歌词"/, "头部那枚按钮仍在（两个入口，一个 state）");

  // 舞台底景带上当前曲目的封面（地址经 AmllBackground 的 new Image() 加载 = img-src 路径）
  const stage = stripComments(read("src/renderer/playback-stage.tsx"));
  assert.match(stage, /albumUrl=\{trackCoverUrlOf\(state\.track\)\}/, "舞台背景用当前曲目的封面");
  const background = stripComments(read("src/renderer/AmllBackground.tsx"));
  assert.match(background, /new Image\(\)/, "封面由宿主用 new Image() 载入（AMLL 只认 HTMLImageElement）");
  assert.doesNotMatch(background, /\bfetch\s*\(/, "**不是 fetch**（CSP connect-src 只有 self/ipc，会被拦）");
  assert.match(background, /addEventListener\(\s*"error"/, "加载失败要回退（不留碎图、不抛）");
  /**
   * `crossOrigin` 必须在 `src` 之前设。设晚了这张跨域图会把画布 taint，AMLL 采样时抛 SecurityError。
   */
  assert.match(background, /image\.crossOrigin = "anonymous"/, "跨域封面必须带 crossOrigin=anonymous（否则 AMLL 采样会抛 SecurityError）");
  assert.ok(
    background.indexOf('image.crossOrigin = "anonymous"') < background.indexOf("image.src = url"),
    "crossOrigin 必须在 src 之前设（设晚了这次请求已经发出去了）",
  );
});

test("外壳：App 挂载运行时、队列面板真实数据、歌词开关与舞台接线", () => {
  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /usePlayer\(/, "播放运行时经 hook 挂载（单例在模块层）");
  assert.match(app, /playQueue\(/, "双击曲目 = 整张列表当队列并从那一首开始");
  assert.match(app, /<PlaybackStage/, "舞台挂在内容区（绝对定位覆盖）");
  assert.match(app, /<PlayerBar/, "播放器栏接线");
  assert.match(app, /<QueuePanel/, "队列面板接线");
  assert.match(app, /entries=\{playback\.entries\}/, "队列面板显示真实队列");
  assert.match(app, /index=\{playback\.index\}/, "队列面板高亮当前项");
  assert.match(app, /aria-label="歌词"/, "要有一个入口打开歌词舞台（否则面板永远看不见）");
  assert.doesNotMatch(app, /\bcoreCall\(/, "外壳不直接取数（R8 的边界不变）");
});

/**
 * 逐字着色保留：主窗面板把行级 LRC 推导成逐字词（`withKaraokeWords`），组件不自己造第二份。
 */
test("R46 主窗面板：withKaraokeWords 逐字（组件不自己渲染歌词文本）", () => {
  const panel = stripComments(read("src/renderer/AmllLyricsPanel.tsx"));
  assert.match(panel, /withKaraokeWords/, "主窗面板也要把行级 LRC 推导成逐字词（否则官方只做整行渐变）");
  assert.match(panel, /useMemo\(\(\) => withKaraokeWords\(lines\), \[lines\]\)/,
    "推导结果按 lines 记忆：每帧新建数组会让官方反复重排");
  assert.match(panel, /lyricLines=\{playerLines\}/, "传给官方组件的是推导后的行");
  assert.doesNotMatch(panel, /--amll-/, "组件里仍不出现 AMLL 变量名");
  assert.doesNotMatch(panel, /style\.setProperty|cssText/, "不自己拼 CSS 文本");
  assert.doesNotMatch(panel, /\.words\b|words\.map/, "仍不自己渲染歌词文本（逐字着色是官方组件的事）");
});

/**
 * **沉浸式歌词禁止改色**：面板不收颜色 prop、不写 `data-lyrics-color`、不调 `applyCustomColor`。
 * 颜色恒为 `amll-theme.css` 里 `.amll-lyrics-stage` 的令牌基线与 AMLL 官方默认。
 */
test("R52 沉浸式歌词不改色：面板没有颜色 prop / data-lyrics-color / applyCustomColor", () => {
  const panel = stripComments(read("src/renderer/AmllLyricsPanel.tsx"));
  assert.doesNotMatch(panel, /customColor/, "面板不再有自定义颜色（沉浸页禁止改色）");
  assert.doesNotMatch(panel, /applyCustomColor/, "面板不调适配层的颜色覆盖（那是桌面歌词窗的事）");
  assert.doesNotMatch(panel, /data-lyrics-color/, "面板不写颜色令牌档位");
  assert.doesNotMatch(panel, /\bcolor\?:/, "props 里不再有 color 字段");
  assert.doesNotMatch(panel, /playerLyrics|use-player-lyrics/, "与 R50 的播放器歌词配置彻底断开");

  const stage = stripComments(read(STAGE));
  assert.doesNotMatch(stage, /customColor|\bcolor=\{/, "沉浸页不再把任何颜色交给面板");
  assert.doesNotMatch(stage, /playerLyrics|use-player-lyrics/, "沉浸页不认识播放器歌词配置（R50 的接线已删）");
  assert.match(stage, /<AmllLyricsPanel\s+runtime=\{runtime\}\s+lines=\{state\.lyrics\.lines\}/,
    "面板只收运行时/行/播放态/跳转信号这四样");
});
