/**
 * 主题三态（浅色 / 深色 / 跟随系统）的**渲染层唯一真源**（R25 用户四项之 4）。
 *
 * 三者怎么落到 CSS 上：
 *
 * | 档位 | `<html>` 上的类 | 谁决定颜色 |
 * |---|---|---|
 * | `light` | `light` | `.light` 令牌块（**特异性高于**媒体查询里的 `:root`，压过系统暗色） |
 * | `dark` | `dark` | `.dark` 令牌块（shadcn 默认写法） |
 * | `system` | 无 | `@media (prefers-color-scheme: dark)`（R10 既有映射，原样保留） |
 *
 * 三条纪律：
 * 1. **状态归 Rust 持有**（`settings.json` 的 `theme` 键 + `theme:changed` 广播）；这里只有
 *    纯函数与"把类落到 html 上"这一个副作用，不存第二份（不引 next-themes、不写 localStorage
 *    ——R10 的裁决里那条"防闪烁内联脚本会被 CSP 拦"的理由仍然成立）；
 * 2. **认不出的档位不猜**：`normalizeThemeChoice` 返回 `null`，调用方按系统档处理
 *    （退回"跟系统"是安全的默认，猜成强制档会让用户的机器突然变色）；
 * 3. **切类只有这一处**：`applyThemeChoice` 是唯一的入口（由 `test/login-chrome.test.mjs` 扫描钉住），
 *    其余文件一律经它——两个 webview 各切一遍类是"两处早晚会漂移"的典型形状。
 */

/** 三个档位（磁盘与广播上的字面量，Rust 侧镜像同值）。 */
export const THEME_CHOICE = {
  light: "light",
  dark: "dark",
  system: "system",
};

/** 展示顺序（控件里的排列）：两档强制在前，系统档在后。 */
export const THEME_CHOICES = [THEME_CHOICE.light, THEME_CHOICE.dark, THEME_CHOICE.system];

/** 控件上的文案（唯一真源；三档都要说清"点了会怎样"）。 */
export const THEME_LABELS = {
  [THEME_CHOICE.light]: "浅色",
  [THEME_CHOICE.dark]: "深色",
  [THEME_CHOICE.system]: "跟随系统",
};

/** 认不出档位时的落点：跟系统（R10 起的行为，也是"什么都不强制"的那一档）。 */
export const THEME_DEFAULT = THEME_CHOICE.system;

/** 会被强制加到 `<html>` 上的两个类（system 一个都不加）。 */
export const THEME_FORCED_CLASSES = [THEME_CHOICE.light, THEME_CHOICE.dark];

/** 主题控件的测试锚点（gate 里那份与浮动那份各自挂在自己那一份 DOM 上）。 */
export const THEME_CONTROL_TESTID = "login-theme-control";

/** 某个档位按钮的测试锚点。 */
export function themeOptionTestId(choice) {
  return `login-theme-${choice}`;
}

/** 主窗左下角那枚**循环切换**按钮的测试锚点（R41b：窄轨收起后它仍在）。 */
export const THEME_TOGGLE_TESTID = "theme-toggle";

/**
 * 档位 → 给人看的文案（**认不出时按系统档**，与 `applyThemeChoice` 的落点逐字一致）。
 *
 * 与 `settings-form.mjs` 的 `closeBehaviorLabel` / `lyrics-window.mjs` 的 `modeLabel` 同款：
 * 界面不直接拿字符串去索引 `THEME_LABELS`，而是经这个入口——那两处的教训是"控件里多写一次
 * `LABELS[值]`，就等于多一处要自己保证值一定在表里"。
 */
export function themeLabel(choice) {
  return THEME_LABELS[normalizeThemeChoice(choice) ?? THEME_DEFAULT];
}

/**
 * 循环切换的下一档（R41b 左下角那枚图标按钮）：浅色 → 深色 → 跟随系统 → 浅色。
 *
 * 顺序**就是** `THEME_CHOICES` 的顺序（展示顺序 = 点击顺序），不另写一张表：
 * 两处各写一份，早晚出现"控件里排 A、点一下跳到 B"。
 *
 * 认不出的档位按系统档起步（与 `applyThemeChoice` 的落点逐字一致）：界面上那时显示的就是
 * 跟随系统，点一下就该走到浅色——从"上一个合法档位"接着走会跳过一个用户没选过的档。
 */
export function nextThemeChoice(choice) {
  const current = normalizeThemeChoice(choice) ?? THEME_DEFAULT;
  const index = THEME_CHOICES.indexOf(current);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length];
}

/**
 * 循环按钮的无障碍名称：**当前是哪一档、点一下会到哪一档**都要说出来。
 *
 * 纯图标按钮没有可见文字，`aria-label` 就是它唯一的说法——只写"主题"等于让读屏用户
 * 靠猜（点三下才知道转到哪）。文案与档位标签同源（`THEME_LABELS`），不另抄一份。
 */
export function themeToggleLabel(choice) {
  const current = normalizeThemeChoice(choice) ?? THEME_DEFAULT;
  return `当前${themeLabel(current)}，点击切换到${themeLabel(nextThemeChoice(current))}`;
}

/** 磁盘/广播上的字面量 → 档位；认不出一律 `null`（不猜、不 trim、不忽略大小写）。 */
export function normalizeThemeChoice(raw) {
  return THEME_CHOICES.includes(raw) ? raw : null;
}

/** 档位 → 该往 `<html>` 上加的类（system 与"认不出"都是空数组）。 */
export function themeClassesFor(choice) {
  const normalized = normalizeThemeChoice(choice);
  return normalized === null || normalized === THEME_DEFAULT ? [] : [normalized];
}

/**
 * 把档位落到 `<html>` 上（**唯一的切类入口**），返回**实际生效**的档位。
 *
 * 两个类一起处理（要加的那个加上、另一个去掉）而不是"只加不去"：否则从强制暗色切到强制浅色时
 * 两个类会同时在，谁赢取决于 CSS 顺序——那是最难查的一类主题 bug。
 *
 * 认不出的档位按系统档处理并如实返回 `"system"`（调用方据此更新界面上的高亮，不许留在旧档位）。
 */
export function applyThemeChoice(root, choice) {
  const applied = normalizeThemeChoice(choice) ?? THEME_DEFAULT;
  const wanted = themeClassesFor(applied);
  if (root !== null && typeof root === "object" && root.classList) {
    for (const name of THEME_FORCED_CLASSES) {
      if (wanted.includes(name)) root.classList.add(name);
      else root.classList.remove(name);
    }
  }
  return applied;
}
