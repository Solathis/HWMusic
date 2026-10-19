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

test("令牌扫描范围：自己写的渲染层代码都在网内（含 R8 的主界面六个文件）", () => {
  const files = handWrittenFiles();
  for (const relative of [
    "src/renderer/App.tsx",
    "src/renderer/pages.tsx",
    "src/renderer/favorites-page.tsx",
    "src/renderer/components.tsx",
    "src/renderer/playlist-grid.tsx",
    "src/renderer/log-terminal.tsx",
  ]) {
    assert.ok(files.includes(relative), `R8 的界面文件必须在扫描范围内：${relative}`);
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

test("禁止 <style> 与内联视觉样式：内联 style 只允许 R7 那处几何契约", () => {
  for (const relative of handWrittenFiles()) {
    const source = stripComments(read(relative));
    assert.doesNotMatch(
      source,
      /<style[\s>]/,
      `${relative} 不得内联 <style>（CSP script-src 'self' 会阻断内联脚本，样式也不走这条路）`,
    );
    for (const match of source.matchAll(/style=\{\{[^}]*\}\}/g)) {
      assert.match(
        match[0],
        /^style=\{\{\s*height:\s*LOGIN_VIEW_TOP_INSET\s*\}\}$/,
        `${relative} 的内联 style 只能是几何契约（高度=共享常量）：${match[0]}`,
      );
    }
    assert.doesNotMatch(source, /\bstyle=\{(?!\{)/, `${relative} 不得内联 style={表达式}（视觉一律走工具类）`);
  }
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
