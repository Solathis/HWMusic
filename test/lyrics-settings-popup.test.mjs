/**
 * R60：桌面歌词设置**气泡面板**（独立小窗里的 shadcn `Popover`）与气泡定位的契约。
 *
 * 纯几何在 Rust 单测（`lyrics_settings.rs` 的 `bubble_*`），真观感与箭头指向在浏览器守卫
 * （`scripts/test-browser.mjs` 的 `checkLyricsSettingsPopup`），本文件管：
 *
 * 1. 面板本体是**官方 Popover + 官方箭头**，不再有 DropdownMenu 那一套；
 * 2. 内容紧凑化（样式/方向/字号单选组、四个开关、颜色一行），改任一项都**不关面板**；
 * 3. 尺寸只上报、位置只听宿主：面板在页面里的左边缘与箭头偏移都由 `lyrics-popover.mjs` 算；
 * 4. Rust 那侧的气泡定位纯函数、窗口属性、命令注册与来源守卫。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LYRICS_FONT_STEPS } from "../src/renderer/features/lyrics/lyrics-window.mjs";
import {
  BUBBLE_SIDES,
  POPOVER_PAD_DIP,
  bubbleAnchorBox,
  defaultBubbleGeometry,
  normalizeBubbleGeometry,
} from "../src/renderer/features/lyrics/lyrics-popover.mjs";

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
// 0. 页面侧几何纯函数
// ---------------------------------------------------------------------------

test("R60 气泡几何：触发点宽度是箭头偏移的两倍，方向决定贴在面板的哪一边", () => {
  const bottom = bubbleAnchorBox({ side: "bottom", arrow: 100, panelHeight: 300, pad: POPOVER_PAD_DIP });
  assert.deepEqual(bottom, { left: POPOVER_PAD_DIP, top: POPOVER_PAD_DIP, width: 200 });
  const top = bubbleAnchorBox({ side: "top", arrow: 100, panelHeight: 300, pad: POPOVER_PAD_DIP });
  assert.deepEqual(top, { left: POPOVER_PAD_DIP, top: POPOVER_PAD_DIP + 300, width: 200 }, "翻到上方时贴在面板底边");
  // 坏值不许 produce 负宽度/NaN：退回居中
  assert.equal(bubbleAnchorBox({ side: "bottom", arrow: 0, panelHeight: Number.NaN }).width, 336);
  assert.equal(bubbleAnchorBox({ side: "bottom", arrow: -5, panelHeight: 10 }).top, POPOVER_PAD_DIP);

  const fallback = defaultBubbleGeometry(320);
  assert.deepEqual(fallback, { side: "bottom", arrow: 160, pad: POPOVER_PAD_DIP }, "没有回执时箭头居中");
  assert.equal(defaultBubbleGeometry(0).arrow, 336 / 2, "量不到宽度就按面板默认宽度");
});

test("R60 气泡几何：宿主回执坏值一律回 null（宁可箭头居中，也不把面板摆到窗口外）", () => {
  const good = { side: "top", arrow: 120, pad: 14 };
  assert.deepEqual(normalizeBubbleGeometry(good, 336), good);
  for (const bad of [
    null, undefined, "top", {}, { side: "left", arrow: 100, pad: 14 }, { side: "bottom", arrow: 0, pad: 14 },
    { side: "bottom", arrow: Number.NaN, pad: 14 }, { side: "bottom", arrow: 400, pad: 14 },
    { side: "bottom", arrow: 100, pad: -1 }, { side: "bottom", arrow: 100 },
  ]) {
    assert.equal(normalizeBubbleGeometry(bad, 336), null, `不是可用几何：${JSON.stringify(bad)}`);
  }
  assert.deepEqual(BUBBLE_SIDES, ["bottom", "top"], "方向字符串与 Rust `BubbleSide::as_str` 同口径");
});

// ---------------------------------------------------------------------------
// 1. 入口
// ---------------------------------------------------------------------------

test("R60 入口：lyrics-settings.html + lyrics-settings-main.tsx 进 Vite 第四个入口", () => {
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
  assert.match(entry, /LyricsSettingsPopup/, "入口挂载面板组件");
  assert.match(entry, /themeFromSearch\(window\.location\.search\)/, "主题初值走查询串（与歌词窗同一机制）");
  assert.match(entry, /applyThemeChoice\(document\.documentElement/, "切类只经 theme.mjs 的那一个入口");
  assert.doesNotMatch(entry, /coreLoginChrome|installThemeSync/, "不许为了主题去调读主题那条命令");
});

test("R60 入口：CSS 引入顺序与歌词窗逐字一致（core → full → amll-theme → styles）", () => {
  const cssImports = (file) => [...read(file).matchAll(/^import "([^"]+\.css)"/gm)].map((match) => match[1]);
  assert.deepEqual(cssImports("src/renderer/lyrics-settings-main.tsx"), cssImports("src/renderer/lyrics-main.tsx"));
});

// ---------------------------------------------------------------------------
// 2. 面板本体：官方 Popover + 官方箭头
// ---------------------------------------------------------------------------

test("R60 面板是官方 Popover（不是 Card，也不是 DropdownMenu），带指向齿轮的箭头", () => {
  const code = stripComments(read(POPUP));
  assert.match(code, /from "\.\/components\/ui\/popover"/, "面板来自 shadcn 原语");
  assert.match(code, /<Popover open modal=\{false\}/, "强制 open（页面里没有第二个可点的开合状态）+ 非模态");
  assert.match(code, /<PopoverTrigger asChild>/, "触发点是隐形锚点");
  assert.match(code, /<PopoverArrow \/>/, "圆角面板要带官方箭头（视觉上明确'从齿轮弹出'）");
  assert.match(code, /<PopoverContent[^>]*side=\{geometry\.side/, "方向由宿主算（下方优先，放不下翻上方）");
  assert.match(code, /<PopoverContent[^>]*align="start"/, "左边缘对齐触发点（触发点宽度因此决定箭头偏移）");
  assert.match(code, /<PopoverContent[^>]*sideOffset=\{-POPOVER_ARROW_DIP\}/,
    "抵消 radix 在主轴上加的箭头高度（面板要贴在窗口留边内侧，箭头探进留边里）");
  assert.match(code, /<PopoverContent[^>]*avoidCollisions=\{false\}/,
    "不避让碰撞：radix 不许自己移位（那会让面板与箭头错开、被窗边裁掉）");
  assert.match(code, /className="w-\[336px\]/, "固定宽度（与 Rust 的默认宽度同口径）");
  assert.match(code, /data-testid="lyrics-appearance-panel"/, "面板内容体锚点保留");

  // 先删后写：DropdownMenu 那一套整段删掉，不留两套
  assert.doesNotMatch(code, /dropdown-menu|DropdownMenu/, "旧的下拉菜单实现必须整段删除");
  assert.doesNotMatch(code, /components\/ui\/card|<Card\b/, "不许用 Card 仿气泡外观");
  assert.doesNotMatch(code, /overflow-[xy]-(?:auto|scroll)/, "不许自搭滚动容器");
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/, "不写裸色值");
});

test("R60 面板内容紧凑化：三个单选组 + 四个开关 + 颜色一行，锚点与 R50/R51 一致", () => {
  const code = stripComments(read(POPUP));
  for (const label of ["桌面歌词外观", "样式", "位置", "方向", "字号", "透明", "面板", "横版", "竖版",
    "模糊", "缩放", "弹簧动画", "媒体按钮", "颜色"]) {
    assert.ok(code.includes(label), `面板必须包含「${label}」`);
  }
  // 位置 / 样式 / 方向 / 字号：单选组（不是菜单项，点一下不该关面板）
  assert.equal((code.match(/<ToggleGroup type="single"/g) ?? []).length, 4, "四组单选：位置、样式、方向、字号");
  assert.match(code, /from "\.\/components\/ui\/toggle-group"/, "单选组来自 shadcn 原语");
  for (const testid of [
    "lyrics-style-clean", "lyrics-style-panel", "lyrics-layout-horizontal", "lyrics-layout-vertical",
    "lyrics-appearance-color", "lyrics-appearance-color-reset",
    "lyrics-target-desktop", "lyrics-target-taskbar",
  ]) {
    assert.ok(code.includes(testid), `R50 的稳定锚点必须保留：${testid}`);
  }
  assert.match(code, /data-testid=\{`lyrics-window-\$\{key\}`\}/, "开关的 testid 仍由 key 生成");
  for (const key of ["enableBlur", "enableScale", "enableSpring", "showControls"]) {
    assert.ok(code.includes(`["${key}", `), `四个开关保留 ${key}`);
  }
  // 字号（R51 新增）：档位来自唯一真源，一项一个按钮
  assert.match(code, /LYRICS_FONT_STEPS\.map/, "字号档位来自 lyrics-window.mjs（不另抄一张表）");
  assert.match(code, /data-testid=\{`lyrics-size-\$\{step\.id\}`\}/, "每个档位有自己的锚点");
  assert.match(code, /fontStepLabel\(step\.id\)/, "档位文案来自纯逻辑模块（不在这里另写一份中文）");
  assert.equal(LYRICS_FONT_STEPS.length, 5, "五档（sm/md/lg/xl/xxl）");

  // 写入仍只走窄命令；读取是空补丁读 + 状态订阅；颜色仍是同一个 customColor 字段
  assert.match(code, /coreLyricsConfigure\(\{\}\)/, "挂载时空补丁读一次权威配置");
  assert.match(code, /onCoreEvent<unknown>\(LYRICS_STATE/, "订阅 lyrics:state 跟进配置变化");
  assert.match(code, /configure\(\{ customColor/, "颜色写的是同一个 customColor 字段");
  assert.match(code, /isCustomColor/, "合法 hex 判定来自纯逻辑模块");
  assert.match(code, /恢复主题色/, "要能一键回到主题色");
  assert.doesNotMatch(code, /localStorage|sessionStorage/, "不许自建存储（落盘仍由 Rust 拥有）");
  assert.doesNotMatch(code, /coreLyricsControl|coreLyricsDocument|coreLyricsToggle|coreCall\(|invoke\(/,
    "面板只改配置：不发媒体控制、不碰业务频道、不直接 invoke");
});

test("R60 改任一项都不关面板：单选组/开关只写配置，关窗只有三条 dismiss 路径", () => {
  const code = stripComments(read(POPUP));
  // 单选组：空串（再点一次已选中项）什么都不写
  assert.match(code, /if \(value === ""\) return/, "radix 去选中给的空串不许写进配置");
  // 关窗：只有 radix 的 dismiss 与 Esc
  assert.equal((code.match(/coreLyricsSettingsClose\(/g) ?? []).length, 1, "关窗命令只有一处调用");
  assert.match(code, /onOpenChange=\{requestClose\}/, "radix 的 dismiss（Esc / 点外面）只用来请求关窗");
  assert.doesNotMatch(code, /setOpen|useState<boolean>\(true\)/, "开合状态不跟着 dismiss 翻转（关窗=隐藏窗口）");
  assert.doesNotMatch(code, /onCheckedChange=\{[^}]*requestClose|onValueChange=\{[^}]*requestClose/,
    "改配置的控件不许顺手请求关窗");
});

// ---------------------------------------------------------------------------
// 3. 尺寸与关闭：都归宿主，页面只上报
// ---------------------------------------------------------------------------

test("R60 面板只上报尺寸、只请求关闭，自己不碰窗口", () => {
  const code = stripComments(read(POPUP));
  assert.match(code, /new ResizeObserver\(/, "尺寸靠 ResizeObserver 量（内容变了要重新摆）");
  assert.match(code, /Math\.ceil\(node\.offsetWidth\)/, "宽度向上取整（少一个像素就裁掉一列）");
  assert.match(code, /Math\.ceil\(node\.offsetHeight\)/, "高度向上取整（少一个像素就裁掉半行）");
  assert.match(code, /coreLyricsSettingsResize\(width, height\)/, "量到的尺寸经命令交给宿主");
  assert.match(code, /normalizeBubbleGeometry\(/, "宿主回执里的几何经纯函数校验后才用");
  assert.match(code, /bubbleAnchorBox\(/, "触发点位置由纯函数算（箭头偏移 → 触发点宽度）");
  assert.match(code, /if \(width === last\.width && height === last\.height\) return/, "尺寸没变就不重复上报");
  assert.match(code, /coreLyricsSettingsClose\(\)/, "关窗走宿主命令");
  assert.doesNotMatch(code, /@tauri-apps\/api\/window|getCurrentWindow|setSize|setPosition|\.hide\(\)|\.close\(\)/,
    "页面不碰任何窗口 API（那扇窗没有 window 权限，尺寸与位置全由 Rust 定）");
});

// ---------------------------------------------------------------------------
// 4. Rust 那侧：气泡定位纯函数、窗口属性、命令与守卫
// ---------------------------------------------------------------------------

test("R60 Rust 气泡定位：纯函数一套（方向/夹紧/箭头/窗口），旧的右对齐规则删干净", () => {
  const rust = rustProduction(rustSource("lyrics_settings.rs"));
  for (const name of [
    "pub fn bubble_placement",
    "pub fn bubble_content_size",
    "pub fn arrow_offset",
    "pub fn anchor_rect",
    "pub fn parse_anchor",
    "pub fn reopen_suppressed",
  ]) {
    assert.ok(rust.includes(name), `几何/判定必须是可单测的纯函数：${name}`);
  }
  assert.match(rust, /pa\s*=\s*SETTINGS_BUBBLE_GAP|SETTINGS_BUBBLE_GAP_DIP/, "间距是常量，不是散落的魔法数");
  assert.match(rust, /SETTINGS_ARROW_INSET_DIP/, "箭头两端的留边是常量");
  assert.match(rust, /SETTINGS_POPUP_PAD_DIP/, "窗口留边是常量");
  assert.doesNotMatch(rust, /settings_popup_placement|settings_popup_window_rect/, "旧的右对齐定位规则必须整段删掉");
  assert.match(rust, /"geometry": geometry_payload|geometry_payload\(&geometry/, "回执要带上页面要用的几何");
  for (const field of ['"side"', '"arrow"', '"pad"']) {
    assert.ok(rust.includes(field), `几何回执缺一项：${field}`);
  }
  assert.equal(
    Number(rust.match(/pub const SETTINGS_POPUP_PAD_DIP: f64 = ([\d.]+)/)?.[1]),
    POPOVER_PAD_DIP,
    "窗口留边在两侧必须相等（页面按它摆触发点）",
  );
});

test("R60 Rust 弹出窗：独立数据目录 + 无边框透明置顶不进任务栏 + 不缩放", () => {
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
  assert.match(rust, /pub fn close</, "歌词窗隐藏/销毁/锁定/切任务栏都调这一处");
  assert.match(rust, /pub fn shutdown</, "退出直接销毁（不排队、不等待）");
});

test("R60 Rust 来源守卫：配置放行弹出窗，媒体控制不放行；窗口 label 与歌词窗同处定义", () => {
  const lyrics = rustProduction(rustSource("lyrics_window.rs"));
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /pub const LYRICS_SETTINGS_WINDOW_LABEL: &str = "lyrics-settings"/);

  const configureGuard = lyrics.slice(lyrics.indexOf("pub fn require_lyrics_source"), lyrics.indexOf("pub fn require_lyrics_control_source"));
  assert.match(configureGuard, /crate::LYRICS_SETTINGS_WINDOW_LABEL/, "配置守卫点名列出了弹出窗");
  const controlGuard = lyrics.slice(lyrics.indexOf("pub fn require_lyrics_control_source"), lyrics.indexOf("pub fn validate_configure"));
  assert.doesNotMatch(controlGuard, /LYRICS_SETTINGS_WINDOW_LABEL/, "媒体控制不放行弹出窗");
  // 打开限 main/lyrics，尺寸与关闭只限它自己
  const popup = rustProduction(rustSource("lyrics_settings.rs"));
  const openGuard = popup.slice(popup.indexOf("pub fn require_settings_open_source"), popup.indexOf("pub fn require_settings_self_source"));
  assert.match(openGuard, /MAIN_WINDOW_LABEL, crate::LYRICS_WINDOW_LABEL/, "打开只放行主窗与歌词窗");
  assert.doesNotMatch(openGuard, /LYRICS_SETTINGS_WINDOW_LABEL/, "弹出窗自己不能要求再打开一次");
  assert.match(popup, /pub fn require_settings_self_source[\s\S]{0,160}LYRICS_SETTINGS_WINDOW_LABEL/, "尺寸/关闭只有它自己能发");
});

test("R60 能力文件：弹出窗只订阅事件，一条 window 权限都没有", () => {
  const permission = JSON.parse(read("src-tauri/capabilities/lyrics-settings.json"));
  assert.deepEqual(permission.windows, ["lyrics-settings"]);
  assert.deepEqual(permission.permissions, ["core:event:default"], "尺寸/位置/关闭全由 Rust 定 ⇒ 不给窗口权限");
  assert.ok(permission.description.includes("Rust"), "文件里写清为什么不用窗口权限");
  // 既有的两份能力文件不许被顺手放宽
  assert.deepEqual(JSON.parse(read("src-tauri/capabilities/lyrics.json")).windows, ["lyrics"]);
  assert.deepEqual(JSON.parse(read("src-tauri/capabilities/main.json")).windows, ["main"]);
});
