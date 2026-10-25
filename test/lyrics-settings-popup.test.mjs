/**
 * R51：桌面歌词设置**弹出窗**（独立小窗）与紧凑默认尺寸的契约。
 *
 * 这里钉的是"跨层的那几件事"——纯几何在 Rust 单测（`lyrics_settings.rs`），真交互在浏览器守卫
 * （`scripts/test-browser.mjs` 的 `checkLyricsSettingsPopup`），本文件管：
 *
 * 1. 入口齐了（Vite 第四个入口 + HTML + main），CSS 顺序与歌词窗逐字一致；
 * 2. 菜单本体仍是**官方 shadcn `DropdownMenu`**（强制 open / modal=false / 窗口原点锚点 /
 *    不避让碰撞 / 不设最大高度），不是拿 Card 仿的；内容与 R50 逐项相同，并新增字号单选；
 * 3. 尺寸与关闭都走宿主命令：页面只 `ResizeObserver` 量尺寸上报、只把 dismiss 变成"关窗"，
 *    自己一个窗口 API 都不碰（那扇窗也没有任何 window 权限）；
 * 4. Rust 那侧的窗口属性、数据目录、命令注册与来源守卫（配置放行、媒体控制不放行）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LYRICS_FONT_STEPS } from "../src/renderer/features/lyrics/lyrics-window.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const rustSource = (name) => read(`src-tauri/src/${name}`);
const rustProduction = (source) => {
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
};
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const POPUP = "src/renderer/LyricsSettingsPopup.tsx";

// ---------------------------------------------------------------------------
// 1. 入口
// ---------------------------------------------------------------------------

test("R51 入口：lyrics-settings.html + lyrics-settings-main.tsx 进 Vite 第四个入口", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /lyricsSettings: fileURLToPath\(new URL\("\.\/src\/renderer\/lyrics-settings\.html"/,
    "第四入口要在 rollupOptions.input 里显式声明（漏了就构建不出这个页面，真窗直接白屏）");
  for (const file of ["src/renderer/lyrics-settings.html", "src/renderer/lyrics-settings-main.tsx"]) {
    assert.ok(readdirSync(`${repoRoot}src/renderer`).includes(file.split("/").at(-1)), `${file} 必须存在`);
  }
  const html = read("src/renderer/lyrics-settings.html");
  assert.match(html, /src="\/lyrics-settings-main\.tsx"/, "HTML 指向新入口");
  assert.match(html, /bg-transparent/, "透明窗：页面不画底色（桌面要透出来）");
  assert.match(html, /<title>桌面歌词设置<\/title>/, "标题（Alt+Tab 里看到的那一个）");

  const entry = read("src/renderer/lyrics-settings-main.tsx");
  assert.match(entry, /LyricsSettingsPopup/, "入口挂载弹出窗组件");
  assert.match(entry, /themeFromSearch\(window\.location\.search\)/, "主题初值走查询串（与歌词窗同一机制）");
  assert.match(entry, /applyThemeChoice\(document\.documentElement/, "切类只经 theme.mjs 的那一个入口");
  assert.doesNotMatch(entry, /coreLoginChrome|installThemeSync/, "不许为了主题去调读主题那条命令");
});

test("R51 入口：CSS 引入顺序与歌词窗逐字一致（core → full → amll-theme → styles）", () => {
  const cssImports = (file) => [...read(file).matchAll(/^import "([^"]+\.css)"/gm)].map((match) => match[1]);
  assert.deepEqual(cssImports("src/renderer/lyrics-settings-main.tsx"), cssImports("src/renderer/lyrics-main.tsx"));
});

// ---------------------------------------------------------------------------
// 2. 菜单本体：官方组件、强制 open、窗口原点锚点
// ---------------------------------------------------------------------------

test("R51 弹出窗用的是官方 DropdownMenu 本身（不是拿 Card 仿的）", () => {
  const code = stripComments(read(POPUP));
  assert.match(code, /from "\.\/components\/ui\/dropdown-menu"/, "菜单来自 shadcn 原语");
  assert.match(code, /<DropdownMenu open modal=\{false\}/, "强制 open（页面里没有第二个可点的开合状态）+ 非模态");
  assert.match(code, /<DropdownMenuTrigger asChild>/, "触发点是窗口原点上的隐形锚点");
  assert.match(code, /className="pointer-events-none absolute left-0 top-0 size-0/, "锚点 0×0 且不吃点击");
  assert.match(code, /<DropdownMenuContent[^>]*side="bottom"/, "内容从锚点下方开始（= 窗口原点）");
  assert.match(code, /<DropdownMenuContent[^>]*align="start"/, "左对齐锚点（菜单左上角 = 窗口原点）");
  assert.match(code, /<DropdownMenuContent[^>]*sideOffset=\{0\}/, "不做偏移（窗口位置由 Rust 定）");
  assert.match(code, /<DropdownMenuContent[^>]*avoidCollisions=\{false\}/,
    "不避让碰撞：radix 不许自己移位（那会让菜单与窗口错开、被裁）");
  assert.match(code, /className="w-64 max-h-none"/, "固定宽度 + 取消 radix 的可用高度上限（高度交给窗口）");
  assert.match(code, /data-testid="lyrics-appearance-panel"/, "菜单内容体锚点保留");
  // 不许仿造：Card/自绘面板/手写滚动容器
  assert.doesNotMatch(code, /components\/ui\/card|<Card\b/, "不许用 Card 仿下拉菜单外观");
  assert.doesNotMatch(code, /overflow-[xy]-(?:auto|scroll)/, "不许自搭滚动容器");
  assert.doesNotMatch(code, /style=\{\{/, "不许内联视觉样式");
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/, "不写裸色值");
});

test("R51 菜单内容：样式/方向/字号/四开关/颜色，锚点与 R50 一致", () => {
  const code = stripComments(read(POPUP));
  for (const label of ["桌面歌词外观", "透明", "面板", "横版", "竖版", "字号", "模糊", "缩放", "弹簧动画", "媒体按钮", "颜色"]) {
    assert.ok(code.includes(label), `弹出窗必须包含「${label}」`);
  }
  assert.match(code, /<DropdownMenuRadioGroup/, "单选组来自 shadcn 原语");
  for (const testid of [
    "lyrics-style-clean", "lyrics-style-panel", "lyrics-layout-horizontal", "lyrics-layout-vertical",
    "lyrics-appearance-color", "lyrics-appearance-color-reset",
  ]) {
    assert.ok(code.includes(testid), `R50 的稳定锚点必须保留：${testid}`);
  }
  assert.match(code, /data-testid=\{`lyrics-window-\$\{key\}`\}/, "开关的 testid 仍由 key 生成");
  for (const key of ["enableBlur", "enableScale", "enableSpring", "showControls"]) {
    assert.ok(code.includes(`["${key}", `), `四个开关保留 ${key}`);
  }

  // 字号（R51 新增）：档位来自唯一真源，一项一个 radio item，点它走同一条窄命令
  assert.match(code, /LYRICS_FONT_STEPS\.map/, "字号档位来自 lyrics-window.mjs（不另抄一张表）");
  assert.match(code, /data-testid=\{`lyrics-size-\$\{step\.id\}`\}/, "每个档位有自己的锚点");
  assert.match(code, /onValueChange=\{\(size\) => configure\(\{ size \}\)\}/, "字号走 configure 窄命令");
  assert.match(code, /fontStepLabel\(step\.id\)/, "档位文案来自纯逻辑模块（不在这里另写一份中文）");
  assert.equal(LYRICS_FONT_STEPS.length, 5, "五档（sm/md/lg/xl/xxl）");

  // 写入仍只走窄命令；读取是空补丁读 + 状态订阅；颜色仍是同一个 customColor 字段
  assert.match(code, /coreLyricsConfigure\(\{\}\)/, "挂载时空补丁读一次权威配置");
  assert.match(code, /onCoreEvent<unknown>\(LYRICS_STATE/, "订阅 lyrics:state 跟进配置变化");
  assert.match(code, /configure\(\{ customColor/, "颜色写的是同一个 customColor 字段");
  assert.match(code, /isCustomColor/, "合法 hex 判定来自纯逻辑模块");
  assert.match(code, /恢复主题色/, "要能一键回到主题色");
  assert.doesNotMatch(code, /localStorage|sessionStorage/, "不许自建存储（落盘仍由 Rust 拥有）");
  // 它能改外观，但没有任何理由替用户按播放键/读业务频道
  assert.doesNotMatch(code, /coreLyricsControl|coreLyricsDocument|coreLyricsToggle|coreCall\(|invoke\(/,
    "弹出窗只改配置：不发媒体控制、不碰业务频道、不直接 invoke");
});

// ---------------------------------------------------------------------------
// 3. 尺寸与关闭：都归宿主，页面只上报
// ---------------------------------------------------------------------------

test("R51 弹出窗只上报尺寸、只请求关闭，自己不碰窗口", () => {
  const code = stripComments(read(POPUP));
  assert.match(code, /new ResizeObserver\(/, "尺寸靠 ResizeObserver 量（菜单内容变了要重新摆）");
  assert.match(code, /Math\.ceil\(node\.offsetWidth\)/, "宽度向上取整（少一个像素就裁掉一列）");
  assert.match(code, /Math\.ceil\(node\.offsetHeight\)/, "高度向上取整（少一个像素就裁掉半行）");
  assert.match(code, /coreLyricsSettingsResize\(width, height\)/, "量到的尺寸经命令交给宿主");
  assert.match(code, /if \(width === last\.width && height === last\.height\) return/, "尺寸没变就不重复上报");
  assert.match(code, /onOpenChange=\{requestClose\}/, "radix 的 dismiss（Esc / 点外面）只用来请求关窗");
  assert.match(code, /coreLyricsSettingsClose\(\)/, "关窗走宿主命令");
  assert.doesNotMatch(code, /@tauri-apps\/api\/window|getCurrentWindow|setSize|setPosition|\.hide\(\)|\.close\(\)/,
    "页面不碰任何窗口 API（那扇窗没有 window 权限，尺寸与位置全由 Rust 定）");
  // 关窗 = 隐藏而不是卸载：open 恒为 true，内容不许跟着 dismiss 卸掉（否则下次显示是空窗）
  assert.doesNotMatch(code, /setOpen|useState<boolean>\(true\)/, "开合状态不跟着 dismiss 翻转");
});

// ---------------------------------------------------------------------------
// 4. Rust 那侧：窗口属性、数据目录、命令与守卫
// ---------------------------------------------------------------------------

test("R51 Rust 弹出窗：独立数据目录 + 无边框透明置顶不进任务栏 + 不缩放", () => {
  const rust = rustProduction(rustSource("lyrics_settings.rs"));
  for (const required of [
    ".title(SETTINGS_POPUP_TITLE)",
    ".decorations(false)",
    ".transparent(true)",
    ".shadow(false)",
    ".always_on_top(true)",
    ".skip_taskbar(true)",
    ".resizable(false)",
    ".focused(false)",
    ".visible(false)",
    ".data_directory(",
    "proxy_url(",
    "resolve_for_webview(",
  ]) {
    assert.ok(rust.includes(required), `弹出窗建窗契约缺一项：${required}`);
  }
  assert.match(rust, /join\("webview2"\)\.join\("lyrics-settings"\)/, "数据目录口径是 <数据根>/webview2/lyrics-settings");
  assert.match(rust, /window\.hide\(\)/, "关闭 = hide（不销毁）");
  assert.match(rust, /window\.set_focus\(\)/, "显示时取焦点（失焦才会关）");
  assert.match(rust, /tauri::WindowEvent::Focused\(false\)/, "失焦要关");
  assert.match(rust, /api\.prevent_close\(\)/, "系统关闭也只隐藏");
  // 几何与失焦判定是纯函数（真值矩阵在 Rust 单测里）
  for (const name of [
    "pub fn settings_popup_placement",
    "pub fn anchor_rect",
    "pub fn settings_popup_content_size",
    "pub fn settings_popup_window_rect",
    "pub fn reopen_suppressed",
    "pub fn parse_anchor",
  ]) {
    assert.ok(rust.includes(name), `几何/判定必须是可单测的纯函数：${name}`);
  }
  assert.match(rust, /SETTINGS_REOPEN_SUPPRESS_MS/, "齿轮二次点击的短窗口是常量，不是散落的魔法数");
  assert.match(rust, /pub fn close</, "歌词窗隐藏/销毁/锁定/切任务栏都调这一处");
  assert.match(rust, /pub fn shutdown</, "退出直接销毁（不排队、不等待）");
});

test("R51 Rust 来源守卫：配置放行弹出窗，媒体控制不放行；窗口 label 与歌词窗同处定义", () => {
  const lyrics = rustProduction(rustSource("lyrics_window.rs"));
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /pub const LYRICS_SETTINGS_WINDOW_LABEL: &str = "lyrics-settings"/);

  const configureGuard = lyrics.slice(lyrics.indexOf("pub fn require_lyrics_source"), lyrics.indexOf("pub fn require_lyrics_control_source"));
  assert.match(configureGuard, /crate::LYRICS_SETTINGS_WINDOW_LABEL/, "配置守卫点名列出了弹出窗");
  const controlGuard = lyrics.slice(lyrics.indexOf("pub fn require_lyrics_control_source"), lyrics.indexOf("pub fn validate_configure"));
  assert.doesNotMatch(controlGuard, /LYRICS_SETTINGS_WINDOW_LABEL/, "媒体控制不放行弹出窗");
  assert.match(lyrics, /pub fn control_payload[\s\S]{0,120}require_lyrics_control_source\(/, "control 用的是那条更窄的守卫");
  // 打开限 main/lyrics，尺寸与关闭只限它自己
  const popup = rustProduction(rustSource("lyrics_settings.rs"));
  const openGuard = popup.slice(popup.indexOf("pub fn require_settings_open_source"), popup.indexOf("pub fn require_settings_self_source"));
  assert.match(openGuard, /MAIN_WINDOW_LABEL, crate::LYRICS_WINDOW_LABEL/, "打开只放行主窗与歌词窗");
  assert.doesNotMatch(openGuard, /LYRICS_SETTINGS_WINDOW_LABEL/, "弹出窗自己不能要求再打开一次");
  assert.match(popup, /pub fn require_settings_self_source[\s\S]{0,160}LYRICS_SETTINGS_WINDOW_LABEL/, "尺寸/关闭只有它自己能发");
});

test("R51 能力文件：弹出窗只订阅事件，一条 window 权限都没有", () => {
  const permission = JSON.parse(read("src-tauri/capabilities/lyrics-settings.json"));
  assert.deepEqual(permission.windows, ["lyrics-settings"]);
  assert.deepEqual(permission.permissions, ["core:event:default"], "尺寸/位置/关闭全由 Rust 定 ⇒ 不给窗口权限");
  assert.ok(permission.description.includes("Rust"), "文件里写清为什么不用窗口权限");
  // 既有的两份能力文件不许被顺手放宽
  assert.deepEqual(JSON.parse(read("src-tauri/capabilities/lyrics.json")).windows, ["lyrics"]);
  assert.deepEqual(JSON.parse(read("src-tauri/capabilities/main.json")).windows, ["main"]);
});
