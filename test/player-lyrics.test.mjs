/**
 * R50（brief 第 2 项）：**播放器歌词外观与桌面歌词外观彻底分开**。
 *
 * 钉四件事：
 * 1. 纯模块 `features/lyrics/player-lyrics.mjs`：默认值、坏值回默认、合法 hex、设置文档形状；
 *    颜色令牌词表与 hex 判定都必须**复用** `lyrics-window.mjs`（不另抄正则、不另立词表）；
 * 2. 存的是**普通 settings 键** `playerLyrics`（不是 Rust 的 `lyricsWindow` 保留键）；
 * 3. 主窗面板只吃 `playerLyrics`，桌面窗只吃 `lyrics.config`——`playback-stage.tsx`
 *    里那句 `lyrics?.config.customColor` 必须删掉（R50 之前它让改桌面颜色顺手改掉主窗）；
 * 4. 设置页：「播放器歌词」区块写 `playerLyrics`，桌面歌词卡里不再有颜色/自定义颜色控件。
 *
 * 真浏览器（主窗只跟播放器颜色变、桌面窗只跟桌面颜色变、重载后保留、写盘失败回滚）由
 * `scripts/test-browser.mjs` 验证。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 只扫代码，不扫注释（注释里写"不另抄正则"是说明文字）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const MODULE = "src/renderer/features/lyrics/player-lyrics.mjs";
const HOOK = "src/renderer/use-player-lyrics.ts";
const STAGE = "src/renderer/playback-stage.tsx";
const PANEL = "src/renderer/AmllLyricsPanel.tsx";
const DESKTOP = "src/renderer/LyricsWindow.tsx";
const PAGES = "src/renderer/pages.tsx";
const APP = "src/renderer/App.tsx";

const load = () => import(pathToFileURL(resolve(repoRoot, MODULE)).href);

test("R50 播放器歌词：默认值、坏值回默认、合法 hex（复用 isCustomColor）", async () => {
  const {
    DEFAULT_PLAYER_LYRICS,
    normalizePlayerLyrics,
    PLAYER_LYRICS_COLOR_IDS,
    PLAYER_LYRICS_SETTING_KEY,
  } = await load();

  assert.equal(PLAYER_LYRICS_SETTING_KEY, "playerLyrics", "普通 settings 键叫 playerLyrics");
  assert.deepEqual({ ...DEFAULT_PLAYER_LYRICS }, { color: "foreground", customColor: "" });
  assert.deepEqual(PLAYER_LYRICS_COLOR_IDS, ["foreground", "muted", "primary", "contrast"], "颜色令牌词表与桌面歌词同一套");

  // 认不出 = 回默认（不猜）
  for (const junk of [undefined, null, 0, "", "primary", [], { color: "nope" }, { color: 3 }]) {
    assert.deepEqual(normalizePlayerLyrics(junk), { ...DEFAULT_PLAYER_LYRICS }, `坏值回默认：${JSON.stringify(junk)}`);
  }

  // 四个令牌都收
  for (const color of PLAYER_LYRICS_COLOR_IDS) {
    assert.deepEqual(normalizePlayerLyrics({ color }), { color, customColor: "" });
  }

  // 自定义颜色：只认六位 hex，合法值原样（大小写不折叠），其余清空
  assert.deepEqual(normalizePlayerLyrics({ color: "muted", customColor: "#00FF00" }), { color: "muted", customColor: "#00FF00" });
  assert.equal(normalizePlayerLyrics({ customColor: "#00ff0" }).customColor, "");
  assert.equal(normalizePlayerLyrics({ customColor: "#00ff00ff" }).customColor, "");
  assert.equal(normalizePlayerLyrics({ customColor: "red" }).customColor, "");
  assert.equal(normalizePlayerLyrics({ customColor: "url(#x)" }).customColor, "");
  assert.equal(normalizePlayerLyrics({ customColor: 0 }).customColor, "");

  // 补丁只有一半时，另一半沿用 base（设置页只改颜色不该把自定义色清掉）
  const base = { color: "contrast", customColor: "#123456" };
  assert.deepEqual(normalizePlayerLyrics({ color: "primary" }, base), { color: "primary", customColor: "#123456" });
  assert.deepEqual(normalizePlayerLyrics({ customColor: "" }, base), { color: "contrast", customColor: "" });
  assert.deepEqual(normalizePlayerLyrics({ color: "nope" }, base), { color: "contrast", customColor: "#123456" },
    "认不出的值落回 base，而不是把 base 也丢掉");
});

test("R50 设置文档：playerLyricsFromSettings / playerLyricsPatch 的形状", async () => {
  const { DEFAULT_PLAYER_LYRICS, normalizePlayerLyrics, playerLyricsFromSettings, playerLyricsPatch } = await load();

  const document = { schemaVersion: 1, data: { playerLyrics: { color: "contrast", customColor: "#123456" } } };
  assert.deepEqual(playerLyricsFromSettings(document), { color: "contrast", customColor: "#123456" });

  for (const missing of [undefined, null, {}, { data: null }, { schemaVersion: 2, data: {} }, { schemaVersion: 1, data: {} }, { schemaVersion: 1, data: { playerLyrics: "x" } }]) {
    assert.deepEqual(playerLyricsFromSettings(missing), { ...DEFAULT_PLAYER_LYRICS }, `读不到就回默认：${JSON.stringify(missing)}`);
  }

  assert.deepEqual(playerLyricsPatch({ color: "primary", customColor: "#112233" }), {
    playerLyrics: { color: "primary", customColor: "#112233" },
  });
  // 只写这两个键：多余的字段不许跟着落盘（配置形状只有一份）
  assert.deepEqual(playerLyricsPatch({ color: "muted", customColor: "", bogus: 1, mode: "taskbar" }), {
    playerLyrics: { color: "muted", customColor: "" },
  });
  assert.deepEqual(playerLyricsPatch(null), { playerLyrics: { ...DEFAULT_PLAYER_LYRICS } });
  assert.deepEqual(Object.keys(playerLyricsPatch({})), ["playerLyrics"]);
  assert.equal(normalizePlayerLyrics({ color: "primary" }).color, "primary");
});

test("R50 纯模块复用既有真源：isCustomColor / 颜色令牌词表都在 lyrics-window.mjs", () => {
  const source = read(MODULE);
  const code = stripComments(source);
  assert.match(source, /from "\.\/lyrics-window\.mjs"/, "令牌与 hex 判定都从 lyrics-window.mjs 取（唯一真源）");
  assert.match(code, /isCustomColor/, "hex 合法性复用 isCustomColor");
  assert.doesNotMatch(code, /0-9a-fA-F\]\{6\}|\^#\[\w-]/, "不许另抄一份 hex 正则");
  assert.match(code, /LYRICS_COLOR_TOKENS/, "颜色令牌词表复用 lyrics-window.mjs 的那一份");
  assert.doesNotMatch(code, /lyricsWindow/, "playerLyrics 不是桌面歌词的保留键（不碰 Rust 配置）");
  // 与 theme-tokens.test.mjs 同一条口径：代码里不出现裸色值（这个模块只搬令牌 id）
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/, "模块里不写裸色值");
});

test("R50 主窗面板只吃 playerLyrics，桌面窗只吃 lyrics.config（跨配置接线已删）", () => {
  const stage = stripComments(read(STAGE));
  const panel = stripComments(read(PANEL));
  const desktop = stripComments(read(DESKTOP));

  // ① 沉浸页：新增 playerLyrics prop，删掉那条跨配置接线
  assert.match(stage, /playerLyrics\?: PlayerLyricsConfig \| null/, "PlaybackStage 收 playerLyrics（R50 的唯一来源）");
  assert.doesNotMatch(stage, /lyrics\?\.config\.customColor/, "R50：主窗面板不再引用桌面歌词的 customColor");
  assert.doesNotMatch(stage, /lyrics\.config\.customColor/, "同上（不带可选链的写法也不许）");
  assert.match(stage, /<AmllLyricsPanel[^>]*color=\{/, "颜色令牌交给面板");
  assert.match(stage, /<AmllLyricsPanel[^>]*customColor=\{playerLyrics/, "自定义颜色也来自 playerLyrics");

  // ② 面板：color prop → data-lyrics-color（令牌由 amll-theme.css 接线）+ 既有的 scoped 覆盖
  assert.match(panel, /color\?: string/, "AmllLyricsPanel 增加 color prop");
  assert.match(panel, /data-lyrics-color=\{color\}/, "根节点写 data-lyrics-color（amll-theme.css 按令牌映射）");
  assert.match(panel, /applyCustomColor\(stageRef\.current, customColor\)/, "自定义颜色仍走适配层的 scoped 覆盖");
  assert.doesNotMatch(panel, /--amll-/, "组件里仍不出现 AMLL 变量名");

  // ③ 桌面歌词窗：仍然是自己的 config（一条都没改）
  assert.match(desktop, /config\.customColor/, "桌面窗仍用 config.customColor");
  assert.match(desktop, /data-lyrics-color=\{config\.style === "panel"/, "桌面窗仍用 config.color 档位");
  assert.doesNotMatch(desktop, /playerLyrics/, "桌面窗不认识 playerLyrics（两边彻底分开）");
});

test("R50 usePlayerLyrics：外壳单例，启动读一次 settings:get，写 settings:set 的 playerLyrics 普通键", () => {
  const hook = stripComments(read(HOOK));
  const app = stripComments(read(APP));

  assert.match(hook, /export function usePlayerLyrics/, "hook 是导出的一层");
  assert.equal([...hook.matchAll(/SETTINGS_GET, null\)/g)].length, 1, "启动只读一次 settings:get");
  assert.match(hook, /SETTINGS_SET/, "写走 settings:set");
  assert.match(hook, /playerLyricsPatch\(/, "写进 settings 的是 playerLyricsPatch 的形状（普通键）");
  assert.doesNotMatch(hook, /coreLyricsConfigure|lyricsWindow/, "不碰 Rust 的桌面歌词配置");
  assert.match(hook, /setConfig\(next\)/, "乐观更新（界面先跟着走）");
  assert.match(hook, /catch[\s\S]{0,400}setConfig\(previous\)/, "失败回滚到上一份配置");
  assert.match(hook, /throw /, "失败要把错误抛给设置页（不是只写 console）");

  assert.match(app, /usePlayerLyrics\(\)/, "外壳持有唯一一份播放器歌词配置");
  const stageUse = app.slice(app.indexOf("<PlaybackStage"), app.indexOf("</SidebarProvider>"));
  assert.match(stageUse, /playerLyrics=\{playerLyrics\.config\}/, "沉浸页拿到播放器歌词配置");
  const settingsUse = app.slice(app.indexOf("<SettingsPage"), app.indexOf("<PlayerBar"));
  assert.match(settingsUse, /playerLyrics=\{playerLyrics\}/, "设置页拿到同一份 binding（不存在第二份状态）");
});

test("R50 设置页：「播放器歌词」区块写 playerLyrics，桌面歌词卡里不再有颜色控件", () => {
  const page = read(PAGES);
  const settings = page.slice(page.indexOf("export function SettingsPage("));
  const code = stripComments(settings);

  // 播放器歌词区块
  assert.match(code, /播放器歌词/, "设置页有「播放器歌词」区块");
  assert.match(code, /playerLyrics/, "区块写的是 playerLyrics 绑定");
  assert.match(code, /id="player-lyrics-color"/, "颜色令牌选择器有稳定 id");
  assert.match(code, /id="player-lyrics-custom-color"/, "自定义颜色选择器有稳定 id");
  assert.match(code, /type="color"/, "自定义颜色仍用原生取色器");
  assert.match(code, /恢复主题色/, "能一键回到主题色");
  assert.match(code, /isCustomColor/, "合法 hex 判定来自纯逻辑模块");
  assert.doesNotMatch(code, /0-9a-fA-F\]\{6\}|\[0-9a-f\]\{6\}/, "页面里不另抄 hex 正则");

  // 桌面歌词卡里删掉颜色控件（桌面颜色只在桌面歌词窗自己的外观面板里改）
  assert.doesNotMatch(code, /id="lyrics-color"/, "桌面歌词卡的颜色选择器已删");
  assert.doesNotMatch(code, /id="lyrics-custom-color"/, "桌面歌词卡的自定义颜色控件已删");
  assert.doesNotMatch(code, /updateConfig\(\{ color/, "桌面歌词卡不再改 color");
  assert.doesNotMatch(code, /updateConfig\(\{ customColor/, "桌面歌词卡不再改 customColor");
  // 其余行为项仍在（模式/锁定/点透/尺寸/方向/样式/四个开关）
  for (const id of ["lyrics-visible", "lyrics-mode", "lyrics-size", "lyrics-locked", "lyrics-click-through", "lyrics-layout", "lyrics-style"]) {
    assert.match(code, new RegExp(`id="${id}"`), `桌面歌词卡仍保留 ${id}`);
  }
  assert.match(code, /LYRICS_SESSION_NOTICE/, "会话说明仍在");
});
