/**
 * 桌面歌词窗的**纯逻辑**（R12）：配置、档位、拖动/点透判定、进度节流、查询串解析。
 *
 * 为什么单独一个模块：这些判定两边都要用（歌词窗渲染、主窗设置页、主窗转发桥），
 * 写在组件里就只能靠人眼对齐——而"任务栏模式字号必须 ≤ 20"这种规矩，靠人眼是守不住的。
 *
 * 三条口径（写清楚，因为它们都是裁决而不是显然）：
 * 1. **字号是档位，不是连续值**。渲染层的视觉一律走工具类/令牌，内联样式只允许
 *    几何契约与 AMLL 的 100% 尺寸那两处，所以"连续字号"这条 CSS 路本来就不存在。
 *    档位的 px 值在这里（钳制、文案用），实际字号在 `amll-theme.css` 的 `[data-lyrics-size]`
 *    规则里（rem，由测试钉住与 px 对得上）。契约里存的是**用户选的档位**；
 *    任务栏模式下再经 `effectiveSizeId` 压到 ≤ 20px——切回桌面模式时用户的选择还在。
 * 2. **颜色只认设计令牌**（`LYRICS_COLOR_TOKENS`）：不接受任意色值。
 *    渲染层把令牌 id 写进 `data-lyrics-color`，真正的 AMLL 歌词颜色变量映射在
 *    `amll-theme.css`（那些变量的唯一接线点，R9 的规矩，由扫描钉住）。
 * 3. **任务栏模式一律点透**：Windows Beta 只占任务栏已确认的安全空白；失败停显。
 *    桌面模式默认可点（要能接手拖动）。
 *
 * Rust 侧握着同一张档位表/词表（`src-tauri/src/lyrics_window.rs`），由
 * `test/lyrics-window.test.mjs` 逐条钉住两侧相等。
 */
import { normalizeThemeChoice } from "../theme/theme.mjs";

/** 桌面悬浮与 Windows 真实任务栏内嵌 Beta。 */
export const LYRICS_MODES = ["desktop", "taskbar"];

const MODE_LABELS = {
  desktop: "桌面悬浮",
  taskbar: "任务栏歌词（Beta）",
};

/**
 * 字号档位表（唯一真源）。
 *
 * 上限 56px 保留横条内多行上下文；竖版沿用同一档位表。
 * px 值必须与 `amll-theme.css` 里的 rem 规则一致（16px = 1rem，测试钉住）。
 */
export const LYRICS_FONT_STEPS = [
  { id: "sm", px: 16, label: "小" },
  { id: "md", px: 20, label: "较小" },
  { id: "lg", px: 28, label: "标准" },
  { id: "xl", px: 40, label: "大" },
  { id: "xxl", px: 56, label: "特大" },
];

/** 任务栏模式的字号上限（简报钉死：≤ 20）：贴边的一条，字不能比系统的还大。 */
export const TASKBAR_MAX_FONT_PX = 20;

/**
 * 颜色令牌表（唯一真源）：只在这几个设计令牌里选，不接受任意色值。
 *
 * 歌词窗是**透明**窗（浮在桌面/窗口之上），所以给一档"反差"（用背景色当字色）：
 * 深色壁纸上那才是唯一读得清的一档。
 */
export const LYRICS_COLOR_TOKENS = [
  { id: "foreground", label: "主题前景" },
  { id: "muted", label: "弱化" },
  { id: "primary", label: "主题色" },
  { id: "contrast", label: "反差" },
];

export const LYRICS_LAYOUTS = ["horizontal", "vertical"];
export const LYRICS_STYLES = ["clean", "panel"];
export const LYRICS_SETTING_KEY = "lyricsWindow";

/**
 * 自定义歌词颜色（R45B）：**只认 `#RRGGBB`**，空串 = 用设计令牌（`data-lyrics-color`）。
 *
 * 为什么不让任意 CSS 色值进来：这个值会被写进官方 AMLL 组件消费的那个颜色变量
 * （唯一接线点在 `amll-theme.css`；用户指定的颜色由 `amll-adapter.ts` 做一次 scoped 覆盖），
 * 能写色值就能写 `url(...)`/`expression(...)`/`;}...`——六位 hex 是唯一"写成什么都只是一块颜色"
 * 的形状。两侧（Rust `is_hex_color`）同一口径。
 */
export const CUSTOM_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 这个值是不是合法的 `#RRGGBB`（唯一真源；配置归一、设置页、适配层都用它）。 */
export function isCustomColor(value) {
  return typeof value === "string" && CUSTOM_COLOR_PATTERN.test(value);
}

/** 归一自定义颜色：合法就原样（大小写不折叠，用户输入什么样就是什么样），其余回空串。 */
export function normalizeCustomColor(value) {
  return isCustomColor(value) ? value : "";
}

/** 窗口尺寸（DIP）的合法范围：0/负数/非有限值都不是"尺寸"，超大值钳到工作区时再说。 */
export const MAX_DIP_SIZE = 100000;

/** 一个 DIP 分量：有限正数（只认真正的数字）、取整；其余回 `null`（不猜，字符串也不算）。 */
export function normalizeDipSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), MAX_DIP_SIZE);
}


/**
 * 持久化失败的**代码 → 人话**（R44e）。
 *
 * Rust 的保存任务只报稳定的代码（`settings_write_failed` / `settings_write_unconfirmed`），
 * 文案在渲染层这一处翻——两侧不必各自维护一份中文，也不会把带路径的错误原文糊到界面上。
 */
export const LYRICS_SAVE_ERRORS = {
  settings_write_failed: "桌面歌词配置未保存，本次运行仍生效。请检查数据目录后点击重试保存。",
  settings_write_unconfirmed: "桌面歌词配置未确认已保存，本次运行仍生效。请点击重试保存。",
};

export const LYRICS_SAVE_ERROR_DEFAULT = "桌面歌词配置未保存，本次运行仍生效。请点击重试保存。";

/** 保存失败代码 → 给用户看的一句话；`null`（没失败）→ `null`。 */
export function saveErrorText(code) {
  if (typeof code !== "string" || code === "") return null;
  return LYRICS_SAVE_ERRORS[code] ?? LYRICS_SAVE_ERROR_DEFAULT;
}

/**
 * 桌面歌词配置的形状（渲染层这一侧的唯一真源；Rust 侧 `LyricsConfig` 是镜像副本）。
 *
 * 为什么要写这个 typedef：`windowWidth: null` 在纯 JS 里会被推成 `null` 字面量类型，
 * 于是 `configure({ windowWidth: 320 })` 在 TS 里就是"把数字塞进 null"——而它明明是
 * `number | null`。类型写在这里，组件与设置页就不用各写一份断言。
 *
 * @typedef {object} LyricsConfig
 * @property {string} mode desktop | taskbar
 * @property {string} layout horizontal | vertical
 * @property {string} style clean | panel
 * @property {string} size 字号档位 id（见 LYRICS_FONT_STEPS）
 * @property {string} color 设计令牌 id（见 LYRICS_COLOR_TOKENS）
 * @property {string} customColor `#RRGGBB` 或空串（空 = 用 `color` 的令牌）
 * @property {number | null} windowWidth 桌面窗 DIP 宽（null = 该方向的默认尺寸）
 * @property {number | null} windowHeight 桌面窗 DIP 高
 * @property {boolean} locked
 * @property {boolean} clickThrough
 * @property {boolean} enableBlur
 * @property {boolean} enableScale
 * @property {boolean} enableSpring
 * @property {boolean} showControls
 */

/** @type {LyricsConfig} */
export const DEFAULT_LYRICS_CONFIG = {
  mode: "desktop",
  layout: "horizontal",
  style: "clean",
  size: "lg",
  color: "foreground",
  /** 自定义歌词颜色（`#RRGGBB`；空串 = 用 `color` 选的令牌）。R45B 新增。 */
  customColor: "",
  /** 桌面窗的 DIP 尺寸（未锁定时拖拽缩放后由 Rust 保存；null = 用该方向的默认尺寸）。R45B 新增。 */
  windowWidth: null,
  windowHeight: null,
  locked: false,
  clickThrough: false,
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  showControls: true,
};

/** 进度节流窗口：rAF 每帧都可能调，但只有该推的才出 IPC（≥100ms 或播放/跳转变化）。 */
export const MIN_PROGRESS_INTERVAL_MS = 100;

/** 歌词状态词表（与 `playback-state.mjs` 的文案表、播放器状态机共用的那一套）。 */
export const LYRICS_STATUS = {
  /** 没有可显示的歌词来源（端点没配 / 还没请求过） */
  unavailable: "unavailable",
  loading: "loading",
  /** 取了，这首确实没有 */
  empty: "empty",
  ready: "ready",
  /** 取不到（网络/HTTP 等）：与"没配置"是两件事 */
  failed: "failed",
};

export const LYRICS_SESSION_NOTICE =
  "桌面歌词配置会保存并在重启后恢复。锁定后只留悬停（或键盘聚焦）出现的解锁按钮：拖动柄、媒体按钮、外观与右下角缩放柄都隐藏，解锁后完整控制回归。点透后请从主窗设置关闭点透。竖版是官方 AMLL 组件上的 writing-mode 逐字竖排（不是把一整行横排折成窄窗）；窗口小到放不下时沿书写方向滚动，当前行保持可见。行级 LRC 的逐字时间是按行时长推导的（不是服务端精确卡拉 OK），词级源原样使用。任务栏歌词（Beta）仅 Windows 实验内嵌，可能随系统版本失效；无安全空白、自动隐藏或权限不符时停显，不会退为贴边浮窗。请从主窗切回桌面模式恢复拖动与控制。";

export const TASKBAR_REASONS = ["disabled", "waiting", "attached", "no_space", "uia_unknown", "timeout", "access_denied", "shell_unavailable", "auto_hide", "dpi_mismatch", "stale", "attach_failed", "unsupported", "destroy_failed"];

export function taskbarStatusText(status) {
  const labels = {
    disabled: "未启用", waiting: "等待安全空白与歌词就绪", attached: "已内嵌任务栏",
    no_space: "没有足够的安全空白，已停显", uia_unknown: "无法确认系统按钮占用，已停显",
    timeout: "系统占用查询超时，已停显并等待恢复", access_denied: "权限或完整性级别不匹配，已停显；请在正常安装环境使用",
    shell_unavailable: "任务栏暂不可用，已停显并等待恢复", auto_hide: "自动隐藏任务栏不支持，已停显",
    dpi_mismatch: "任务栏与应用 DPI 上下文不兼容，已停显", stale: "任务栏几何已变化，等待重新确认",
    attach_failed: "内嵌验证失败，已停显", unsupported: "当前平台不支持 Windows 任务栏内嵌", destroy_failed: "歌词窗清理未完成，已停显",
  };
  return labels[status?.reason] ?? labels.uia_unknown;
}

function stepOf(id) {
  return LYRICS_FONT_STEPS.find((step) => step.id === id) ?? null;
}

function tokenOf(id) {
  return LYRICS_COLOR_TOKENS.find((token) => token.id === id) ?? null;
}

/** 档位标签（认不出的按默认档位说——界面不显示空串）。 */
export function fontStepLabel(id) {
  return (stepOf(id) ?? stepOf(DEFAULT_LYRICS_CONFIG.size)).label;
}

/** 颜色令牌标签。 */
export function colorTokenLabel(id) {
  return (tokenOf(id) ?? tokenOf(DEFAULT_LYRICS_CONFIG.color)).label;
}

/** 模式标签。 */
export function modeLabel(id) {
  return MODE_LABELS[id] ?? MODE_LABELS[DEFAULT_LYRICS_CONFIG.mode];
}

/**
 * 配置归一（纯函数）：`patch` 里**认不出的值一律不猜**，落回 `base` 里那一个合法值
 * （`base` 也认不出就落默认）。布尔只认真正的布尔——`"yes"`、`1` 都不算。
 *
 * 空 patch / 坏 patch 返回 `base` 本身：设置页挂载时用空补丁读回当前配置，不该有任何副作用。
 */
export function normalizeLyricsConfig(patch, base = DEFAULT_LYRICS_CONFIG) {
  const current = base !== null && typeof base === "object" ? base : DEFAULT_LYRICS_CONFIG;
  const source = patch !== null && typeof patch === "object" ? patch : {};
  const next = { ...DEFAULT_LYRICS_CONFIG };
  const enums = { mode: LYRICS_MODES, layout: LYRICS_LAYOUTS, style: LYRICS_STYLES,
    size: LYRICS_FONT_STEPS.map((step) => step.id), color: LYRICS_COLOR_TOKENS.map((token) => token.id) };
  const valid = (key, value) => {
    if (key === "customColor") return typeof value === "string" && (value === "" || isCustomColor(value));
    if (key === "windowWidth" || key === "windowHeight") return value === null || normalizeDipSize(value) !== null;
    if (enums[key]) return enums[key].includes(value);
    return typeof value === "boolean";
  };
  const settled = (key, value) => (key === "windowWidth" || key === "windowHeight" ? (value === null ? null : normalizeDipSize(value)) : value);
  for (const [key, fallback] of Object.entries(DEFAULT_LYRICS_CONFIG)) {
    next[key] = valid(key, source[key]) ? settled(key, source[key]) : valid(key, current[key]) ? settled(key, current[key]) : fallback;
  }
  return next;
}

/**
 * 有效字号档位：任务栏模式下压到 ≤ [`TASKBAR_MAX_FONT_PX`] 的最大档位。
 *
 * 刻意**不改配置本身**（`normalizeLyricsConfig` 存的是用户选的那个档位）：
 * 用户从桌面模式切到任务栏再切回来，看到的不该是自己没选过的小字号。
 */
export function effectiveSizeId(config) {
  const normalized = normalizeLyricsConfig({}, config);
  if (normalized.mode !== "taskbar") return normalized.size;
  const allowed = LYRICS_FONT_STEPS.filter((step) => step.px <= TASKBAR_MAX_FONT_PX);
  const chosen = stepOf(normalized.size);
  if (chosen !== null && chosen.px <= TASKBAR_MAX_FONT_PX) return chosen.id;
  return allowed[allowed.length - 1].id;
}

/** 官方拖动调用的资格：仅 desktop 未锁且未点透。 */
export function dragRegionEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.mode === "desktop" && !normalized.locked && !normalized.clickThrough;
}

/**
 * 拖拽缩放的资格（R45B）：**仅未锁的桌面窗**。
 *
 * 与拖动资格分开写：点透会禁拖动（窗口收不到鼠标），但不该把"能不能缩放"这件事也顺手关掉
 * ——锁定与任务栏才是缩放的两条禁线（Rust 侧 `resizable_enabled` 是同一口径）。
 */
export function resizableEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.mode === "desktop" && !normalized.locked;
}

/** 点透开关：桌面尊重用户选项，内嵌 Beta 始终点透。 */
export function clickThroughEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.clickThrough || normalized.mode === "taskbar";
}

/**
 * 歌词窗的初值来自 URL 查询串（Rust 建窗时按当前配置拼）。
 *
 * 为什么要带进 URL 而不是"建完再发一条广播"：渲染层订阅事件是异步的，
 * 建窗那一刻它可能还没 `listen`——事件发进空气，歌词窗就会用默认档位显示，
 * 而用户在设置页里明明选过。查询串是同步到位的，没有这个缝。
 */
export function lyricsConfigFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const patch = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LYRICS_CONFIG)) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    if (typeof fallback === "boolean") {
      if (value === "1" || value === "0") patch[key] = value === "1";
    } else if (key === "windowWidth" || key === "windowHeight") {
      // 尺寸是数字：空串/坏值都不算（落 `null` = 该方向的默认尺寸）
      const size = Number(value);
      if (value !== "" && Number.isFinite(size)) patch[key] = size;
    } else {
      patch[key] = value;
    }
  }
  return normalizeLyricsConfig(patch);
}

/** 主题档位从查询串来的参数名（Rust `lyrics_window_url` 写的就是它）。 */
export const LYRICS_THEME_PARAM = "theme";

/**
 * 歌词窗的主题初值（R41）：从查询串取 `theme=`，**只认那三个字面量**，其余回 `null`。
 *
 * 为什么歌词窗的主题要走查询串：它**调不动**读主题的那条命令（`core_login_chrome` 的来源
 * 守卫只放行主窗与两个浮动控件），所以问不出"现在是哪一档"。查询串是建窗时同步到位的。
 *
 * 认不出（缺参数 / 大写 / 别的词 / 空串）一律回 `null`：调用方 `applyThemeChoice` 把 null
 * 当**系统档**处理——这是"不猜"的那一侧，与主窗"读不到就什么都不改"的纪律一致。
 * 合法性判定复用 `theme.mjs` 的 `normalizeThemeChoice`（档位词表只有那一个真源）。
 */
export function themeFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  return normalizeThemeChoice(params.get(LYRICS_THEME_PARAM));
}

/**
 * 该不该把这一帧进度推给歌词窗（纯函数）。
 *
 * 三条：第一次必推（否则歌词窗停在 0）；播放态或跳转信号变了立刻推（用户按了暂停/拖了进度，
 * 等 100ms 是能感觉到的）；否则要至少差 [`MIN_PROGRESS_INTERVAL_MS`]。
 * 算不出差值（NaN）时推一次——多推一帧的代价远小于"歌词卡住不动"。
 */
export function shouldPushProgress(previous, next) {
  if (previous === null || previous === undefined) return true;
  const before = previous;
  const after = next !== null && typeof next === "object" ? next : {};
  if (after.seekGeneration !== before.seekGeneration) return true;
  if (after.playing !== before.playing) return true;
  const delta = Math.abs(Number(after.timeMs) - Number(before.timeMs));
  return !(delta < MIN_PROGRESS_INTERVAL_MS);
}

/** 播放状态机快照 → 进度载荷（唯一出处：字段名只在这里拼一次）。 */
export function progressOf(state) {
  const source = state !== null && typeof state === "object" ? state : {};
  const timeMs = Number(source.currentTimeMs);
  return {
    timeMs: Number.isFinite(timeMs) && timeMs > 0 ? Math.round(timeMs) : 0,
    playing: source.status === "playing",
    seekGeneration: Number.isInteger(source.seekGeneration) ? source.seekGeneration : 0,
  };
}

/** 取歌词失败 → 状态档：端点没配就说没配，别的失败说"暂时取不到"（两句不同的话）。 */
export function lyricsStatusFromFailure(error) {
  const kind = error !== null && typeof error === "object" ? error.kind : null;
  return kind === "endpoint_unknown" ? LYRICS_STATUS.unavailable : LYRICS_STATUS.failed;
}

/** 歌词文档载荷（行 + 状态）。 */
export function lyricsDocumentOf(lines, status) {
  return {
    lines: Array.isArray(lines) ? lines : [],
    status: typeof status === "string" && status !== "" ? status : LYRICS_STATUS.unavailable,
  };
}

/**
 * 导入回执 → 落地计划（R41a 纯函数）：**成功的语义与失败的语义不是同一件事**。
 *
 * - 成功（`ok: true`）：这一首的歌词**现在**就是这一份——调用方把 `lines` 交给播放运行时
 *   （主窗面板）并转发给歌词窗，两处显示同一份行数组；
 * - 失败（`ok: false`）：只有一句给用户看的人话，**不带 `lines`/`status`**。失败的事实是
 *   "这首歌的歌词没有变"，所以界面必须停在原来那一份上——R41 曾在这里推一份空文档
 *   （"让界面回到事实"），那是把事实看反了：面板会从"有词"跳成"这首歌没有歌词"，
 *   而用户只是选错了文件（R41a 审查的 3/8）。
 *
 * 判据只有一条：桥在失败时一定给 `message`（它是给用户看的人话），成功时 `message` 为 null。
 * 再加一条**凭据**：成功必须真的带来行（桥在这条路上必给 ≥1 行——"没有带时间戳的歌词行"
 * 在桥里就被判失败了）。认不出的回执因此按失败处理：宁可不换，也不把面板清成"这首歌没有歌词"。
 */
export function importPlanOf(result) {
  const source = result !== null && typeof result === "object" ? result : {};
  const failure = typeof source.message === "string" && source.message.trim() !== "" ? source.message.trim() : null;
  if (failure !== null) return { ok: false, message: failure };

  const lines = Array.isArray(source.lines) ? source.lines : [];
  if (lines.length === 0) {
    return { ok: false, message: "导入没有生效（没有拿到可用的歌词行）：界面停在原来那一份上。" };
  }
  const lineCount = Number.isInteger(source.lineCount) && source.lineCount >= 0 ? source.lineCount : lines.length;
  const fileName = typeof source.fileName === "string" && source.fileName !== "" ? source.fileName : "文件";
  return {
    ok: true,
    lines,
    status: typeof source.status === "string" && source.status !== "" ? source.status : LYRICS_STATUS.failed,
    message: `已替换这首歌的歌词（${lineCount} 行，来自「${fileName}」）。`,
  };
}

/**
 * 进度插值估计（纯函数）：`lastPush` = 最近一次广播 `{timeMs, playing, atMs}`，
 * `atMs` 是**本地**收到它的时刻。
 *
 * 为什么需要它：广播是节流的（≥100ms 一条），若直接把 `timeMs` 当 `currentTime`，
 * 逐字渐变会每 100ms 跳一格。播放中按"经过的真实时间"往前推即可平滑；
 * 暂停时**停住不动**（接着推算会让歌词在暂停时继续走）。这只是同一条进度的插值，
 * 不是第二份时钟——真正的进度始终只有播放状态机那一个来源。
 */
export function estimateTimeMs(lastPush, nowMs) {
  const push = lastPush !== null && typeof lastPush === "object" ? lastPush : null;
  const base = push === null ? 0 : Number(push.timeMs);
  const anchor = Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
  if (push === null || push.playing !== true) return anchor;
  const elapsed = Number(nowMs) - Number(push.atMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return anchor;
  return anchor + Math.round(elapsed);
}

/**
 * 把插值锚点挪到"现在"（纯函数，窗从隐藏变可见时用）。
 *
 * 为什么需要它：窗被托盘藏起来的那段时间里，主窗**不推进度**（它知道窗不在，见
 * `use-lyrics-window.ts` 的进度泵），所以手里那条推送已经过期。窗再显示时若不重锚，
 * 插值会按"隐藏了多久"一次性往前跳（歌词瞬间窜到后面再被新推送拉回来）；
 * 重锚之后就是"停在上次的位置，等 100ms 内的新推送"。
 */
export function reanchorProgress(lastPush, nowMs) {
  const push = lastPush !== null && typeof lastPush === "object" ? lastPush : null;
  if (push === null) return null;
  return { ...push, atMs: Number.isFinite(Number(nowMs)) ? Number(nowMs) : push.atMs };
}
