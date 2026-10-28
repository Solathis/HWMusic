/**
 * 颜色色块显示当前主题下的真实颜色：纯函数把令牌算成 #rrggbb、映射与 amll-theme.css 一致、两个控件共用读色函数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LYRICS_COLOR_TOKENS } from "../src/renderer/features/lyrics/lyrics-window.mjs";
import {
  LYRICS_COLOR_VARS,
  colorTokenIds,
  colorVarOf,
  hexFromCssColor,
  readTokenColorHex,
  resolveTokenColorHex,
} from "../src/renderer/features/lyrics/lyrics-color.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const POPUP = "src/renderer/LyricsSettingsPopup.tsx";
const TASKBAR_CARD = "src/renderer/taskbar-lyrics-card.tsx";

// ---------------------------------------------------------------------------
// 1. 纯函数：颜色写法 → #rrggbb
// ---------------------------------------------------------------------------

test("R60 换算：设计令牌实际用的 oklch 写法落到 sRGB（与 Tailwind neutral 档逐条对上）", () => {
  // 期望值独立可核：这四档正是中性色 950/50/900/500/400 的 sRGB 值
  assert.equal(hexFromCssColor("oklch(0.145 0 0)"), "#0a0a0a", "浅色主题的 --foreground");
  assert.equal(hexFromCssColor("oklch(0.985 0 0)"), "#fafafa", "深色主题的 --foreground");
  assert.equal(hexFromCssColor("oklch(0.205 0 0)"), "#171717", "浅色主题的 --primary");
  assert.equal(hexFromCssColor("oklch(0.556 0 0)"), "#737373", "浅色主题的 --muted-foreground");
  assert.equal(hexFromCssColor("oklch(0.708 0 0)"), "#a1a1a1", "深色主题的 --muted-foreground");
  assert.equal(hexFromCssColor("  oklch(1 0 0)  "), "#ffffff", "首尾空白照吃");
  assert.equal(hexFromCssColor("OKLCH(0 0 0)"), "#000000", "函数名大小写不敏感");
});

test("R60 换算：rgb/rgba/hex 也认，半透明与认不出的写法回 null（不猜颜色）", () => {
  assert.equal(hexFromCssColor("rgb(250, 250, 250)"), "#fafafa");
  assert.equal(hexFromCssColor("rgb(250 250 250)"), "#fafafa");
  assert.equal(hexFromCssColor("rgba(250, 250, 250, 1)"), "#fafafa");
  assert.equal(hexFromCssColor("rgb(100% 0% 0%)"), "#ff0000", "百分比分量按满量程折算");
  assert.equal(hexFromCssColor("#FFF"), "#ffffff");
  assert.equal(hexFromCssColor("#00DD00"), "#00dd00", "输出一律小写（与 input.value 同口径）");
  assert.equal(hexFromCssColor("#00dd0080"), "#00dd00", "八位hex取前六位");
  assert.equal(hexFromCssColor("oklab(0.145 0 0)"), "#0a0a0a", "oklab 同样认");

  for (const bad of [
    "", "   ", "#12", "#12345", "#gggggg", "hsl(0 0% 0%)", "color-mix(in srgb, red, blue)",
    "rgba(0, 0, 0, 0)", "oklch(0.5 0.1 30 / 0.2)", "transparent", "inherit",
  ]) {
    assert.equal(hexFromCssColor(bad), null, `不是可显示的颜色：${JSON.stringify(bad)}`);
  }
  for (const notString of [null, undefined, 42, {}, []]) {
    assert.equal(hexFromCssColor(notString), null, `非字符串一律 null：${JSON.stringify(notString)}`);
  }
  // 有彩色的写法仍落在六位 hex 上（数值由矩阵决定，这里只钉形状）
  assert.match(hexFromCssColor("oklch(0.7 0.15 30)"), /^#[0-9a-f]{6}$/);
});

// ---------------------------------------------------------------------------
// 2. 令牌 → 变量：与 amll-theme.css 的颜色档位同源
// ---------------------------------------------------------------------------

test("R60 令牌变量表覆盖全部颜色档位，且与 amll-theme.css 的映射逐条一致", () => {
  const ids = colorTokenIds();
  assert.deepEqual(ids, LYRICS_COLOR_TOKENS.map((token) => token.id), "令牌 id 来自唯一真源");
  assert.deepEqual(Object.keys(LYRICS_COLOR_VARS).sort(), [...ids].sort(), "每个令牌都要有变量名");
  const css = read("src/renderer/amll-theme.css");
  for (const id of ids) {
    const name = colorVarOf(id);
    assert.match(
      css,
      new RegExp(`\\[data-lyrics-color="${id}"\\]\\s*\\{\\s*--amll-lp-color:\\s*var\\(${name}\\)`),
      `amll-theme.css 里 ${id} 必须就是 var(${name})`,
    );
  }
  assert.equal(colorVarOf("nope"), LYRICS_COLOR_VARS.foreground, "认不出的令牌按默认档位");
});

test("R60 读令牌颜色：注入的读取函数说了算，读不到/抛错都回 null", () => {
  const variables = { "--foreground": "oklch(0.145 0 0)", "--background": "oklch(1 0 0)" };
  assert.equal(resolveTokenColorHex("foreground", (name) => variables[name]), "#0a0a0a");
  assert.equal(resolveTokenColorHex("contrast", (name) => variables[name]), "#ffffff");
  assert.equal(resolveTokenColorHex("primary", () => "oklch(0 0 0)"), "#000000", "只认它读回来的值");
  assert.equal(resolveTokenColorHex("foreground", () => ""), null);
  assert.equal(resolveTokenColorHex("foreground", () => "currentcolor"), null);
  assert.equal(resolveTokenColorHex("foreground", () => { throw new Error("boom"); }), null, "读不到不该炸");
  assert.equal(resolveTokenColorHex("foreground", null), null, "没有读取函数就回 null");
  // Node 里没有 document：不猜、不炸
  assert.equal(readTokenColorHex("foreground"), null);
});

// ---------------------------------------------------------------------------
// 3. 两个控件都用它
// ---------------------------------------------------------------------------

test("R60 桌面设置面板：色块未设自定义色时显示令牌真实颜色，自定义色时显示自定义色", () => {
  const code = stripComments(read(POPUP));
  assert.match(code, /useTokenColorHex\(/, "取色器要跟着主题算颜色（主题变了要重算）");
  assert.match(code, /customColor \?\? themeHex/, "有自定义色就用它，否则用令牌算出来的颜色");
  assert.match(code, /defaultValue=\{swatchValue/, "色块的初值必须是算出来的那个颜色（不是 undefined=浏览器默认黑）");
  assert.match(code, /isCustomColor/, "写好之后仍只认 #RRGGBB");
  assert.doesNotMatch(code, /现在用设计令牌里的颜色/, "旧提示文案（开发术语）必须删掉");
  assert.match(code, /跟随主题色/, "未设自定义色时的提示是用户能懂的话");
  assert.match(code, /使用自定义颜色/, "设了自定义色时说同一句话（两张卡一致）");
});

test("R60 任务栏卡：同一个读色函数、同一句自定义色文案、没有令牌术语", () => {
  const code = stripComments(read(TASKBAR_CARD));
  assert.match(code, /useTokenColorHex\(/, "与桌面面板共用同一处读色");
  assert.match(code, /customColor \?\? themeHex/, "同样的取值顺序");
  assert.match(code, /defaultValue=\{swatchValue/, "同样不许让浏览器给默认黑");
  assert.doesNotMatch(code, /用上面选的令牌/, "旧提示文案（开发术语）必须删掉");
  assert.match(code, /跟随上方选择的颜色/, "未设自定义色时的提示是用户能懂的话");
  assert.match(code, /使用自定义颜色/, "与弹出窗同一句话");
});

test("R60 取色器只写自定义色字段：用户在色块里选色才写入", () => {
  for (const [relative, field] of [[POPUP, "customColor"], [TASKBAR_CARD, "taskbarCustomColor"]]) {
    const code = stripComments(read(relative));
    assert.match(code, new RegExp(`\\{ ${field}: value \\}`), `${relative} 选色只写 ${field}`);
    assert.doesNotMatch(code, /onChange=[^>]*colorTokenLabel|onChange=\{[^}]*taskbarColor:/,
      `${relative} 选色不许顺手改令牌`);
  }
});

test("R60 读色模块不写裸色值（设计令牌只在 styles.css）", () => {
  for (const relative of [
    "src/renderer/features/lyrics/lyrics-color.mjs",
    "src/renderer/features/lyrics/use-token-color.ts",
  ]) {
    const code = stripComments(read(relative));
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${relative} 不得出现裸 hex`);
    assert.doesNotMatch(code, /\boklch\(|\boklab\(|\brgba?\(/, `${relative} 不得写死颜色函数调用`);
  }
});
