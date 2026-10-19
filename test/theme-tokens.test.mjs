/**
 * R8 主界面 · 设计令牌硬约束（源码扫描）。
 *
 * 为什么用扫描而不是 review：这些都是"一眼看不出、但一旦破口就再也收不回来"的事——
 * 一个 `text-zinc-400` 进来，下一个人就会觉得"那我也可以"；一个内联 `style={{color}}`
 * 进来，主题切换（暗色）就出现了永远跟不上的角落。项目只有一套令牌，扫出来才是真的。
 *
 * 钉住四条：
 * 1. 渲染层不得出现非令牌的调色板类（zinc-/amber-/red- 之类）与裸色值（#fff、rgb()、oklch()）；
 * 2. 不得写 `<style>`；内联 `style={{}}` 只允许 R7 那处几何契约（高度 = 共享常量）；
 * 3. AMLL 变量（`--amll-*`）只许出现在 amll-theme.css（歌词主题的唯一接线点）；
 * 4. 令牌定义只在 styles.css；不得挂载 next-themes 的 ThemeProvider（CSP 会拦它的内联脚本）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 渲染层源码（.tsx/.ts/.mjs；.d.ts 是类型声明，不含样式）。 */
function rendererCodeFiles(root = "src/renderer") {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(tsx|ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(child);
    }
  };
  walk(root);
  return found;
}

/**
 * shadcn 生成物目录：R1 的约束是**不手改生成原语**，所以颜色/内联样式的规则对它们不适用
 * （例：sheet.tsx 的遮罩用 `bg-black/10`、sidebar.tsx 用内联 `--sidebar-width`，都是上游写法）。
 * 豁免范围就是这一个目录，且下面有用例钉住它不许被悄悄放大。
 */
const GENERATED_UI_PREFIX = "src/renderer/components/ui/";

/** 自己写的渲染层代码（生成原语之外的一切）。 */
function handWrittenFiles() {
  const found = rendererCodeFiles().filter((relative) => !relative.startsWith(GENERATED_UI_PREFIX));
  assert.ok(found.length >= 10, `扫描范围异常，只拿到 ${found.length} 个文件：${found.join(", ")}`);
  return found;
}

/** 渲染层全部文件（含 .css）：AMLL 变量的扫描要看 css。 */
function rendererAllFiles(root = "src/renderer") {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      found.push(child);
    }
  };
  walk(root);
  return found;
}

/** 只扫代码，不扫注释：注释里写"不许 zinc-400"是说明文字，不是违规。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 非令牌调色板：Tailwind 默认色板 + 纯黑白（项目一律走设计令牌）。 */
const PALETTE_UTILITY =
  /(?:^|[\s"'`:[])(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|decoration|caret|accent|placeholder)-(?:zinc|slate|gray|grey|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/;
const PURE_BLACK_WHITE = /(?:^|[\s"'`:[])(?:bg|text|border|ring|fill|stroke|divide|outline)-(?:white|black)\b/;

/** 裸色值：hex / rgb() / hsl() / oklch()（令牌定义在 styles.css，代码里一律引用变量）。 */
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;

test("令牌扫描范围：自己写的渲染层代码都在网内（含 R8 的主界面与 R9 的播放/歌词文件）", () => {
  const files = handWrittenFiles();
  for (const relative of [
    "src/renderer/App.tsx",
    "src/renderer/pages.tsx",
    "src/renderer/favorites-page.tsx",
    "src/renderer/components.tsx",
    "src/renderer/playlist-grid.tsx",
    "src/renderer/log-terminal.tsx",
    "src/renderer/playback-stage.tsx",
    "src/renderer/AmllBackground.tsx",
    "src/renderer/AmllLyricsPanel.tsx",
    // R12：桌面歌词窗宿主（字号/颜色档位经 data 属性交给 amll-theme.css，不走内联样式）
    "src/renderer/LyricsWindow.tsx",
    "src/renderer/lyrics-main.tsx",
  ]) {
    assert.ok(files.includes(relative), `界面文件必须在扫描范围内：${relative}`);
  }
  // 豁免范围只有 shadcn 生成物这一个目录：多豁免一个文件就等于把规则悄悄放宽
  assert.deepEqual(
    rendererCodeFiles().filter((relative) => !relative.startsWith(GENERATED_UI_PREFIX) && !files.includes(relative)),
    [],
    "除 components/ui/ 之外的文件都必须被扫描",
  );
});

test("禁止硬编码色：不出现非令牌调色板类、纯黑白工具类与裸色值", () => {
  const offenders = [];
  for (const relative of handWrittenFiles()) {
    const source = stripComments(read(relative));
    source.split("\n").forEach((line, index) => {
      if (PALETTE_UTILITY.test(line) || PURE_BLACK_WHITE.test(line) || RAW_COLOR.test(line)) {
        offenders.push(`${relative}:${index + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `一律使用设计令牌（styles.css 的 :root/.dark 变量）：\n${offenders.join("\n")}`);
});

/**
 * AMLL 宿主的 100% 尺寸例外（R9）：AMLL 的渲染器按容器尺寸建画布，官方文档要求的
 * 就是给组件一个显式尺寸的盒子。除此之外**没有第三个例外**——例外集合写死在这里，
 * 且下面有用例断言"全项目只有这两处"。
 */
const AMLL_SIZE_STYLE_FILES = ["src/renderer/AmllBackground.tsx", "src/renderer/AmllLyricsPanel.tsx"];
const AMLL_SIZE_STYLE = 'style={{ width: "100%", height: "100%" }}';

test("禁止 <style> 与内联视觉样式：内联 style 只允许几何契约与 AMLL 两处 100% 尺寸", () => {
  const amllStyles = [];
  for (const relative of handWrittenFiles()) {
    const source = stripComments(read(relative));
    assert.doesNotMatch(
      source,
      /<style[\s>]/,
      `${relative} 不得内联 <style>（CSP script-src 'self' 会阻断内联脚本，样式也不走这条路）`,
    );
    for (const match of source.matchAll(/style=\{\{[^}]*\}\}/g)) {
      if (match[0] === AMLL_SIZE_STYLE) {
        assert.ok(
          AMLL_SIZE_STYLE_FILES.includes(relative),
          `${relative} 不是 AMLL 宿主，不许写 AMLL 的 100% 尺寸内联样式：${match[0]}`,
        );
        amllStyles.push(relative);
        continue;
      }
      assert.match(
        match[0],
        /^style=\{\{\s*height:\s*LOGIN_VIEW_TOP_INSET\s*\}\}$/,
        `${relative} 的内联 style 只能是几何契约（高度=共享常量）或 AMLL 的 100% 尺寸：${match[0]}`,
      );
    }
    assert.doesNotMatch(source, /\bstyle=\{(?!\{)/, `${relative} 不得内联 style={表达式}（视觉一律走工具类）`);
  }

  // 例外只有两处（旧仓同款）：一处给背景、一处给歌词组件，多一处就是规则被悄悄放宽
  assert.deepEqual(
    amllStyles.sort(),
    [...AMLL_SIZE_STYLE_FILES].sort(),
    `AMLL 的 100% 尺寸内联样式应当恰好两处（背景 + 歌词）：${JSON.stringify(amllStyles)}`,
  );
});

test("AMLL 变量只许出现在 amll-theme.css（歌词主题的唯一接线点）", () => {
  const offenders = [];
  for (const relative of rendererAllFiles()) {
    if (relative.endsWith("amll-theme.css")) continue;
    const source = read(relative);
    if (/--amll-[a-z-]+/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `AMLL 变量是歌词主题的接线细节，只能写在 amll-theme.css：${offenders.join(", ")}`);

  const theme = read("src/renderer/amll-theme.css");
  assert.match(theme, /--amll-lp-color/, "amll-theme.css 必须真的在接 AMLL 变量（否则这条扫描就是空转）");
});

test("令牌定义只在 styles.css；渲染层不得重新定义设计令牌", () => {
  const offenders = [];
  for (const relative of rendererCodeFiles()) {
    const source = stripComments(read(relative));
    for (const match of source.matchAll(/--(?:background|foreground|primary|secondary|muted|accent|border|ring|card|popover|destructive|sidebar[a-z-]*)\s*:/g)) {
      offenders.push(`${relative}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `令牌只在 styles.css 定义：${offenders.join("; ")}`);

  const styles = read("src/renderer/styles.css");
  assert.match(styles, /--sidebar\b/, "styles.css 必须仍是 sidebar 令牌的真源（R1 交付）");
  assert.match(styles, /@import "tailwindcss"/);
});

test("不得挂载 next-themes 的 ThemeProvider（CSP 会拦它的防闪烁内联脚本）", () => {
  for (const relative of rendererCodeFiles()) {
    assert.doesNotMatch(read(relative), /<ThemeProvider/, `${relative} 不得挂载 ThemeProvider`);
  }
  for (const relative of rendererCodeFiles().filter((file) => !file.endsWith("components/ui/sonner.tsx"))) {
    assert.doesNotMatch(read(relative), /next-themes/, `${relative} 不得引入 next-themes（shadcn 生成的 sonner.tsx 除外）`);
  }
});

test("控制台只剩错误路径：渲染层不得有 console.log/info/debug", () => {
  const offenders = [];
  for (const relative of rendererCodeFiles()) {
    const source = stripComments(read(relative));
    source.split("\n").forEach((line, index) => {
      if (/console\.(log|info|debug|trace)\s*\(/.test(line)) offenders.push(`${relative}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `调试残留（只允许 console.warn/error 的错误路径）：\n${offenders.join("\n")}`);
});

/**
 * R10 裁决：**主题只跟系统**（`prefers-color-scheme`），不做手动切换。
 *
 * 最省的接法：把 `.dark` 那套令牌照原样接到 `@media (prefers-color-scheme: dark)` 的 `:root` 上
 * ——不引 next-themes（它的防闪烁内联脚本会被 CSP 拦）、不写 JS、不引入第二套配色。
 * 代价是令牌写了两份，所以**两份必须逐条一致**由测试钉住：漏一条，暗色下就有一处颜色
 * 悄悄留在亮色（这种差别在 review 里几乎看不出来）。
 */

/** 取 `from` 之后第一个 `{...}` 块的内容（按大括号配对，能处理嵌套）。 */
function blockAfter(source, from) {
  const open = source.indexOf("{", from);
  assert.ok(open !== -1, `找不到代码块：${source.slice(from, from + 40)}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("大括号没有闭合");
}

/** 块里的声明（`--name: value;` 与 `color-scheme: dark;` 一视同仁）。 */
function declarations(text) {
  return [...text.matchAll(/(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+);/g)].map(
    (found) => `${found[1].trim()}=${found[2].trim()}`,
  );
}

const PREFERS_DARK = "@media (prefers-color-scheme: dark)";

test("主题跟随系统：prefers-color-scheme 的 :root 令牌与 .dark 逐条一致", () => {
  const styles = read("src/renderer/styles.css");
  // 顶层的那一条（行首）：dark 变体块里也有一条同名媒体查询，那条查的是 `&`
  const mediaMatch = styles.match(/^@media \(prefers-color-scheme: dark\)/m);
  assert.ok(mediaMatch, `styles.css 必须把系统暗色接上（顶层 ${PREFERS_DARK}）`);

  const mediaBlock = blockAfter(styles, mediaMatch.index);
  const rootAt = mediaBlock.indexOf(":root");
  assert.ok(rootAt !== -1, "系统暗色要改的是 :root 上的令牌（不是挑个别组件改颜色）");
  const systemTokens = declarations(blockAfter(mediaBlock, rootAt));

  const darkMatch = styles.match(/^\.dark\s*\{/m);
  assert.ok(darkMatch, "styles.css 必须仍有 shadcn 的 .dark 令牌块（独立成块，不是散落各处的覆盖）");
  const darkTokens = declarations(blockAfter(styles, darkMatch.index));

  assert.ok(darkTokens.length >= 20, `令牌块缩水了（只有 ${darkTokens.length} 条），扫描就是空转`);
  assert.deepEqual(
    systemTokens.slice().sort(),
    darkTokens.slice().sort(),
    "系统暗色与 .dark 的令牌必须逐条一致：少一条 = 暗色下有一处颜色留在亮色",
  );
  assert.ok(
    systemTokens.some((entry) => entry.startsWith("color-scheme=")),
    "系统暗色要带 color-scheme: dark（原生滚动条/下拉框才会跟着暗）",
  );
});

test("主题跟随系统：dark: 变体也认系统偏好（上游原语的暗色微调不能落空）", () => {
  const styles = read("src/renderer/styles.css");
  const variantAt = styles.indexOf("@custom-variant dark");
  assert.ok(variantAt !== -1, "styles.css 要有 dark 变体的定义");
  // 变体块到下一个顶层 at-rule（`\n@`）为止：不假设它是一行式还是块式
  const rest = styles.slice(variantAt);
  const next = rest.indexOf("\n@", 1);
  const variant = next === -1 ? rest : rest.slice(0, next);
  assert.match(variant, /prefers-color-scheme/, "dark: 工具类必须跟着系统暗色（否则只有令牌换了，原语的暗色微调没换）");
  assert.match(variant, /\.dark/, "保留 .dark 类的路径（shadcn 默认写法，将来要做手动切换时直接可用）");
});

test("不做手动切换：渲染层不写 dark 类、不存主题偏好（裁决：手动切换非目标）", () => {
  for (const relative of rendererCodeFiles()) {
    const source = stripComments(read(relative));
    assert.doesNotMatch(
      source,
      /classList\.(?:add|remove|toggle)\(\s*["'`]dark/,
      `${relative} 不许自己切 dark 类（主题由系统决定）`,
    );
    assert.doesNotMatch(source, /localStorage[^\n]*theme/i, `${relative} 不许存主题偏好（没有手动切换这回事）`);
  }
});
