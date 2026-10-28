/**
 * 主题三态（浅色 / 深色 / 跟随系统）的渲染层唯一真源。
 *
 * 状态归 Rust 持有，这里只有纯函数与把类落到 html 上这一个副作用；认不出的档位不猜，按系统档处理。
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

/** 认不出档位时的落点：跟系统。 */
export const THEME_DEFAULT = THEME_CHOICE.system;

/** 会被强制加到 `<html>` 上的两个类（system 一个都不加）。 */
export const THEME_FORCED_CLASSES = [THEME_CHOICE.light, THEME_CHOICE.dark];

/**
 * 主题回执的单调 revision 合同（读回、广播、歌词窗补发共用）：比已见的旧 → 拒，同号幂等收，无编号的老形状照收但不退水位。
 * @param {number} seen 已见的最高 revision（`-1` = 还没见过）
 * @param {unknown} payload `{theme?, revision?}`
 * @returns {{accept: boolean, seen: number}}
 */
export function acceptThemePayload(seen, payload) {
  const source = payload !== null && typeof payload === "object" ? payload : {};
  const revision = Number.isSafeInteger(source.revision) ? source.revision : -1;
  const watermark = Number.isSafeInteger(seen) ? seen : -1;
  if (revision >= 0 && revision < watermark) return { accept: false, seen: watermark };
  return { accept: true, seen: Math.max(watermark, revision) };
}

/** 主题控件的测试锚点（gate 里那份与浮动那份各自挂在自己那一份 DOM 上）。 */
export const THEME_CONTROL_TESTID = "login-theme-control";

/** 某个档位按钮的测试锚点。 */
export function themeOptionTestId(choice) {
  return `login-theme-${choice}`;
}

/** 主窗左下角那枚循环切换按钮的测试锚点。 */
export const THEME_TOGGLE_TESTID = "theme-toggle";

/** 档位 → 给人看的文案（认不出时按系统档）；界面经这个入口取，不直接索引 THEME_LABELS。 */
export function themeLabel(choice) {
  return THEME_LABELS[normalizeThemeChoice(choice) ?? THEME_DEFAULT];
}

/** 循环切换的下一档：浅色 → 深色 → 跟随系统，顺序就是 THEME_CHOICES 的顺序。 */
export function nextThemeChoice(choice) {
  const current = normalizeThemeChoice(choice) ?? THEME_DEFAULT;
  const index = THEME_CHOICES.indexOf(current);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length];
}

/** 循环按钮的无障碍名称：当前是哪一档、点一下会到哪一档都要说出来。 */
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

/** 把档位落到 html 上（唯一的切类入口），返回实际生效的档位；两个类一起处理，认不出的按系统档。 */
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
