/**
 * R52：重构设置「歌词」页 + 沉浸式歌词禁止改色。
 *
 * 这里钉的是"跨层的那几件事"——真交互在浏览器守卫（`scripts/test-browser.mjs` 的
 * `checkSettingsPageLyricsCard` / `checkImmersiveLyricsColorIsFixed`），本文件管：
 *
 * 1. 设置页「歌词」标签**只剩一张桌面歌词卡**：显示 / 窗口位置 / 锁定 / 鼠标穿透。
 *    样式/方向/字号/效果/颜色的控件 id 一个都不许留在页面里（它们只在 R51 弹出窗里），
 *    也**没有**「外观设置」按钮——桌面歌词外观只在歌词窗自己的齿轮菜单里改（R52 收尾还原）；
 * 2. 沉浸式歌词禁止改色：`AmllLyricsPanel` 没有颜色 prop、不写 `data-lyrics-color`、不调
 *    `applyCustomColor`；外壳不再挂 `usePlayerLyrics`；R50 那三个文件已删除；
 * 3. `LYRICS_SESSION_NOTICE` 那段解释性长文整段删除（文案克制）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const exists = (relative) => existsSync(`${repoRoot}${relative}`);

const PAGES = "src/renderer/pages.tsx";
const PANEL = "src/renderer/AmllLyricsPanel.tsx";
const STAGE = "src/renderer/playback-stage.tsx";

/** 设置页「歌词」那个标签页的源码段（从 `value="lyrics"` 到它的 `</TabsContent>`）。 */
function lyricsPane() {
  const page = read(PAGES);
  const start = page.indexOf('<TabsContent value="lyrics"');
  assert.ok(start > -1, "要能找到「歌词」标签页");
  const end = page.indexOf("</TabsContent>", start);
  assert.ok(end > start, "「歌词」页没有收口");
  return page.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. 设置页「歌词」标签
// ---------------------------------------------------------------------------

test("R52 设置页「歌词」：只留一张桌面歌词卡（没有外观入口）", () => {
  const pane = lyricsPane();
  // 必须在主窗做的四件事（id 是浏览器守卫与真机取证的锚点）
  for (const id of ["lyrics-visible", "lyrics-mode", "lyrics-locked", "lyrics-click-through"]) {
    assert.ok(pane.includes(`id="${id}"`), `歌词页要有 #${id}（必须在主窗操作的行为项）`);
  }
  for (const label of ["显示桌面歌词", "窗口位置", "锁定位置", "鼠标穿透"]) {
    assert.ok(pane.includes(label), `控件文案：${label}`);
  }
  // 只剩一张卡（桌面歌词）+ 缓存卡：卡片标题不许再出现第二个
  const titles = [...pane.matchAll(/<CardTitle>([^<]+)<\/CardTitle>/g)].map((found) => found[1]);
  assert.deepEqual(titles, ["桌面歌词"], "歌词页只剩一张卡");
  assert.ok(pane.includes("<LyricsCacheCard lyrics={lyrics} />"), "缓存卡保持不动（R41 的挂点）");

  // 搬进弹出窗的那些控件一个都不许留下（"两个入口"= 用户会以为哪里都能改对）
  for (const gone of [
    'id="lyrics-size"', 'id="lyrics-layout"', 'id="lyrics-style"',
    'id="lyrics-enableBlur"', 'id="lyrics-enableScale"', 'id="lyrics-enableSpring"', 'id="lyrics-showControls"',
    'id="player-lyrics-color"', 'id="player-lyrics-custom-color"',
    "LYRICS_FONT_STEPS", "LYRICS_COLOR_TOKENS", "fontStepLabel", "colorTokenLabel",
  ]) {
    assert.equal(pane.includes(gone), false, `设置页不许再有 ${gone}（它只在弹出窗里）`);
  }
  // 字号/方向/样式/四个效果这些字面量也不该在页面里出现（避免"控件删了但清单还在"）
  for (const gone of ["playerLyrics", "player-lyrics"]) {
    assert.equal(pane.includes(gone), false, `播放器歌词的颜色入口已删除：${gone}`);
  }
});

/**
 * R52 收尾（用户新要求）：**桌面歌词的外观只在歌词窗自己的设置里改**。
 *
 * 上一轮曾在设置页放了一枚「外观设置」按钮（调 `core_lyrics_settings_open`，锚点取按钮矩形）。
 * 用户明确要求任务栏歌词的设置不与桌面歌词共用、桌面歌词外观只归歌词窗，所以那枚按钮与它的
 * 整条接线（`coreLyricsSettingsOpen` 的导入与处理函数）一起删掉，这里做反向钉子防回潮。
 */
test("R52 设置页没有「外观设置」按钮：桌面歌词外观只在歌词窗自己的菜单里改", () => {
  const pane = lyricsPane();
  const page = read(PAGES);
  for (const gone of ["外观设置", "lyrics-appearance-open", "openLyricsAppearance", "coreLyricsSettingsOpen"]) {
    assert.equal(pane.includes(gone), false, `歌词页不许再有 ${gone}`);
    assert.equal(page.includes(gone), false, `设置页源码不许再有 ${gone}（整条接线已删）`);
  }
  // 弹出窗本身还在（R51 的能力不跟着删）：唯一入口是歌词窗的齿轮
  const window_ = read("src/renderer/LyricsWindow.tsx");
  assert.match(window_, /coreLyricsSettingsOpen\(/, "歌词窗齿轮仍是弹出窗的入口");
  assert.match(window_, /data-testid="lyrics-appearance"/, "齿轮按钮还在");
});

test("R52 任务栏 Beta：Badge + 一句 taskbarStatusText（不写长段说明）", () => {
  const pane = lyricsPane();
  assert.match(pane, /<Badge variant="secondary">Beta<\/Badge>/, "Beta 标记还在");
  assert.match(pane, /taskbarStatusText\(lyrics\.taskbar\)/, "状态只有一句（来自纯逻辑模块）");
  assert.match(pane, /mode === "taskbar"/, "只在任务栏模式下显示");
  assert.match(pane, /role="status"/, "状态区是 role=status（无障碍可读）");
});

test("R52 保存失败 Alert 语义不变（真源仍是 lyrics.saveError / retrySave）", () => {
  const pane = lyricsPane();
  assert.match(pane, /lyrics\?\.saveError/, "失败来自绑定的 saveError");
  assert.match(pane, /<AlertTitle>桌面歌词配置未保存<\/AlertTitle>/, "标题不变");
  assert.match(pane, /onClick=\{lyrics\.retrySave\}/, "重试保存接回同一条命令");
});

test("R52 文案克制：提示都在控件旁、每句不超过一行，且不再有解释性段落", () => {
  const pane = lyricsPane();
  // 只量**写死的**提示文字：`{taskbarStatusText(...)}` 那种是状态（文案由纯函数给）
  const hints = [...pane.matchAll(/<span className="text-xs text-muted-foreground">([^<{]*)<\/span>/g)]
    .map((found) => found[1])
    .filter((hint) => hint.trim() !== "");
  assert.ok(hints.length >= 1, `控件旁要有必要提示（拿到 ${hints.length} 句）`);
  for (const hint of hints) {
    assert.ok(hint.trim().length > 0 && hint.trim().length <= 20, `提示要短（≤20 字）：${hint}`);
  }
  // 卡片描述一句话（不带句号以外的第二句）
  const description = pane.match(/<CardDescription>([^<]*)<\/CardDescription>/)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length <= 30, `卡片描述只一句：${description}`);
  assert.ok((description.match(/。/g) ?? []).length <= 1, "描述收在一句里（不写解释性文案）");
  assert.equal(pane.includes("LYRICS_SESSION_NOTICE"), false, "会话说明长段落不再出现在设置页");
});

// ---------------------------------------------------------------------------
// 2. 沉浸式歌词禁止改色
// ---------------------------------------------------------------------------

test("R52 沉浸式歌词不改色：面板与沉浸页都没有颜色入口", () => {
  const panel = read(PANEL);
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const gone of ["customColor", "applyCustomColor", "data-lyrics-color", "color?", "playerLyrics"]) {
    assert.equal(code.includes(gone), false, `面板不许再有 ${gone}`);
  }
  assert.match(code, /withKaraokeWords/, "逐字推导保留（R46 的能力不跟着颜色一起删）");

  const stage = read(STAGE);
  const stageCode = stage.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert.equal(stageCode.includes("customColor"), false, "沉浸页不再传自定义颜色");
  assert.equal(stageCode.includes("playerLyrics"), false, "沉浸页不再认识播放器歌词配置");
  assert.equal(/color=\{/.test(stageCode), false, "沉浸页不再传颜色令牌");
});

test("R52 R50 的那三个文件已删除，外壳不再挂 usePlayerLyrics", () => {
  for (const gone of [
    "src/renderer/features/lyrics/player-lyrics.mjs",
    "src/renderer/use-player-lyrics.ts",
    "test/player-lyrics.test.mjs",
  ]) {
    assert.equal(exists(gone), false, `${gone} 应当已删除`);
  }
  const app = read("src/renderer/App.tsx");
  assert.equal(app.includes("usePlayerLyrics"), false, "外壳不再持有播放器歌词配置");
  assert.equal(read(PAGES).includes("use-player-lyrics"), false, "设置页不再收那份 binding");

  // 全渲染层再扫一遍：不许有第二份"播放器歌词颜色"
  const files = [
    "src/renderer/App.tsx", PAGES, STAGE, PANEL,
    "src/renderer/LyricsWindow.tsx", "src/renderer/LyricsSettingsPopup.tsx",
    "src/renderer/features/lyrics/lyrics-window.mjs",
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes("playerLyrics"), false, `${file} 不许再引用 playerLyrics`);
    assert.equal(source.includes("LYRICS_SESSION_NOTICE"), false, `${file} 不许再引用会话说明长段落`);
  }
});

test("R52 颜色只剩桌面歌词窗一个使用者（AmllLyricsPanel 落到主题令牌基线）", () => {
  const css = read("src/renderer/amll-theme.css");
  assert.match(css, /\.amll-lyrics-stage\s*\{[^}]*--amll-lp-color:\s*var\(--foreground\)/,
    "舞台基线就是前景色令牌（沉浸页没有 data-lyrics-color 时就落这条）");
  const window_ = read("src/renderer/LyricsWindow.tsx");
  assert.match(window_, /data-lyrics-color=\{config\./, "桌面歌词窗仍按自己的配置写令牌档位");
  assert.match(window_, /applyCustomColor\(/, "桌面歌词窗仍支持自定义颜色（本任务不动它）");
});

// ---------------------------------------------------------------------------
// 3. Rust：主窗入口撤回后回到 R51 的关闭路径（本任务不动 Rust）
// ---------------------------------------------------------------------------

/**
 * R52 收尾：Rust 侧**不保留**上一轮为主窗打开路径加的改动（`caller` 记录 /
 * `close_for_lyrics_lifecycle` / `closes_after_config_change`）。
 *
 * 为什么可以整段撤回：R51 的"当前是锁定/任务栏就收菜单"只在**从主窗打开、且当前已处于**
 * 这两种状态时才会误收；而「外观」入口回到只有歌词窗齿轮之后，齿轮本身只在
 * `mode === "desktop" && !locked` 时渲染（`LyricsWindow.tsx` 的 `controls`），那两种状态下
 * 根本打不开这个窗——误收的前提不存在了。锁定的那一刻仍由同一判定收窗，语义与 R51 一致。
 */
test("R52 Rust 回到 R51：主窗入口的专用改动不许留在树里", () => {
  const settings = read("src-tauri/src/lyrics_settings.rs");
  const window_ = read("src-tauri/src/lyrics_window.rs");
  for (const gone of ["closes_after_config_change", "close_for_lyrics_lifecycle", "opens_from_lyrics_window"]) {
    assert.equal(settings.includes(gone), false, `lyrics_settings.rs 不许再有 ${gone}（为主窗入口而加）`);
    assert.equal(window_.includes(gone), false, `lyrics_window.rs 不许再有 ${gone}`);
  }
  assert.equal(settings.includes("state.caller"), false, "弹出窗不再记录发起者（只有齿轮一个入口）");
  // R51 的四条关闭路径仍在（这是本任务不该碰的那部分）
  assert.match(window_, /crate::lyrics_settings::close\(app\)/, "歌词窗隐藏时收弹出窗");
  assert.match(window_, /crate::lyrics_settings::close\(&events\)/, "歌词窗销毁时收弹出窗");
  assert.match(window_, /crate::lyrics_settings::close\(&app\)/, "锁定 / 切任务栏后收弹出窗");
  assert.match(window_, /crate::lyrics_settings::shutdown\(app\)/, "退出时销毁弹出窗");
});
