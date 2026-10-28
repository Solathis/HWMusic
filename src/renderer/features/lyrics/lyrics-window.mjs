/**
 * 桌面歌词窗的**纯逻辑**：配置、档位、拖动/点透判定、进度节流、查询串解析。
 * 字号是档位不是连续值；颜色只认设计令牌；任务栏模式一律点透。
 */
import { normalizeThemeChoice } from "../theme/theme.mjs";

/** 桌面悬浮与 Windows 真实任务栏内嵌 Beta。 */
export const LYRICS_MODES = ["desktop", "taskbar"];

const MODE_LABELS = {
  desktop: "桌面悬浮",
  taskbar: "任务栏歌词（Beta）",
};

/** 字号档位表（唯一真源）；px 值必须与 `amll-theme.css` 里的 rem 规则一致（16px = 1rem）。 */
export const LYRICS_FONT_STEPS = [
  { id: "sm", px: 16, label: "小" },
  { id: "md", px: 20, label: "较小" },
  { id: "lg", px: 28, label: "标准" },
  { id: "xl", px: 40, label: "大" },
  { id: "xxl", px: 56, label: "特大" },
];

/** 任务栏模式的字号上限（简报钉死：≤ 20）：贴边的一条，字不能比系统的还大。 */
export const TASKBAR_MAX_FONT_PX = 20;

/** 任务栏专用字号档位（≤ 20px）；id 与桌面档位不重叠，两张表互不通用。 */
export const TASKBAR_FONT_STEPS = [
  { id: "tsm", px: 12, label: "小" },
  { id: "tmd", px: 14, label: "较小" },
  { id: "tlg", px: 16, label: "标准" },
  { id: "txl", px: 18, label: "大" },
  { id: "txxl", px: 20, label: "特大" },
];

/** 任务栏的默认字号：取上限那一档。 */
export const DEFAULT_TASKBAR_SIZE = "txxl";

/** 颜色令牌表（唯一真源）：只在这几个设计令牌里选，不接受任意色值。 */
export const LYRICS_COLOR_TOKENS = [
  { id: "foreground", label: "主题前景" },
  { id: "muted", label: "弱化" },
  { id: "primary", label: "主题色" },
  { id: "contrast", label: "反差" },
];

export const LYRICS_LAYOUTS = ["horizontal", "vertical"];
export const LYRICS_STYLES = ["clean", "panel", "bare"];
export const LYRICS_SETTING_KEY = "lyricsWindow";

/** 自定义歌词颜色：**只认 `#RRGGBB`**，空串 = 用设计令牌（两侧同一口径）。 */
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


/** 持久化失败的**代码 → 人话**：Rust 只报稳定代码，文案在渲染层这一处翻。 */
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
 * @typedef {object} LyricsConfig
 * @property {string} mode desktop | taskbar
 * @property {string} layout horizontal | vertical
 * @property {string} style clean | panel | bare（纯透明：无衬底）
 * @property {string} size 字号档位 id（见 LYRICS_FONT_STEPS）
 * @property {string} color 设计令牌 id（见 LYRICS_COLOR_TOKENS）
 * @property {string} customColor `#RRGGBB` 或空串（空 = 用 `color` 的令牌）
 * @property {number | null} windowWidth 桌面窗 DIP 宽（null = 该方向的默认尺寸）
 * @property {number | null} windowHeight 桌面窗 DIP 高
 * @property {boolean} locked
 * @property {boolean} enableBlur
 * @property {boolean} enableScale
 * @property {boolean} enableSpring
 * @property {boolean} showControls
 * @property {string} taskbarSize 任务栏字号档位 id（见 TASKBAR_FONT_STEPS；与桌面档位不通用）
 * @property {string} taskbarColor 任务栏颜色令牌 id
 * @property {string} taskbarCustomColor 任务栏自定义颜色 `#RRGGBB` 或空串
 * @property {boolean} taskbarKaraoke 任务栏逐字高亮（关掉 = 官方组件按行渐变）
 */

/** @type {LyricsConfig} */
export const DEFAULT_LYRICS_CONFIG = {
  mode: "desktop",
  layout: "horizontal",
  style: "clean",
  size: "lg",
  color: "foreground",
  /** 自定义歌词颜色（`#RRGGBB`；空串 = 用 `color` 选的令牌）。 */
  customColor: "",
  /** 桌面窗的 DIP 尺寸（未锁定时拖拽缩放后由 Rust 保存；null = 用该方向的默认尺寸）。 */
  windowWidth: null,
  windowHeight: null,
  locked: false,
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  showControls: true,
  /** 任务栏那扇窗的外观：与桌面各存一份，改一边不许动另一边。 */
  taskbarSize: DEFAULT_TASKBAR_SIZE,
  taskbarColor: "foreground",
  taskbarCustomColor: "",
  taskbarKaraoke: true,
};

/** 进度节流窗口：每次播放通知都可能调，但只有该推的才出 IPC（≥100ms 或播放/跳转变化）。 */
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

function taskbarStepOf(id) {
  return TASKBAR_FONT_STEPS.find((step) => step.id === id) ?? null;
}

/** 任务栏档位标签（认不出的按默认档位说——界面不显示空串）。 */
export function taskbarFontStepLabel(id) {
  return (taskbarStepOf(id) ?? taskbarStepOf(DEFAULT_LYRICS_CONFIG.taskbarSize)).label;
}

/** 模式标签。 */
export function modeLabel(id) {
  return MODE_LABELS[id] ?? MODE_LABELS[DEFAULT_LYRICS_CONFIG.mode];
}

/** 歌词显示目标：off（关闭）、desktop（桌面悬浮）、taskbar（任务栏）。 */
export const LYRICS_TARGETS = ["off", "desktop", "taskbar"];

/** 当前目标：没开就是 off，开着就看模式。 */
export function lyricsTargetOf(on, mode) {
  if (on !== true) return "off";
  return mode === "taskbar" ? "taskbar" : "desktop";
}

/** 切到某个目标要做什么：mode 为 null 表示不改模式，visible 为 null 表示不改开关。 */
export function lyricsTargetPlan(on, mode, target) {
  const current = mode === "taskbar" ? "taskbar" : "desktop";
  if (target === "off") return { mode: null, visible: on === true ? false : null };
  if (target !== "desktop" && target !== "taskbar") return { mode: null, visible: null };
  return { mode: target === current ? null : target, visible: on === true ? null : true };
}

/** 配置归一（纯函数）：`patch` 里认不出的值一律不猜，落回 `base` 里那一个合法值。 */
export function normalizeLyricsConfig(patch, base = DEFAULT_LYRICS_CONFIG) {
  const current = base !== null && typeof base === "object" ? base : DEFAULT_LYRICS_CONFIG;
  const source = patch !== null && typeof patch === "object" ? patch : {};
  const next = { ...DEFAULT_LYRICS_CONFIG };
  const enums = { mode: LYRICS_MODES, layout: LYRICS_LAYOUTS, style: LYRICS_STYLES,
    size: LYRICS_FONT_STEPS.map((step) => step.id), color: LYRICS_COLOR_TOKENS.map((token) => token.id),
    taskbarSize: TASKBAR_FONT_STEPS.map((step) => step.id),
    taskbarColor: LYRICS_COLOR_TOKENS.map((token) => token.id) };
  const valid = (key, value) => {
    if (key === "customColor" || key === "taskbarCustomColor") {
      return typeof value === "string" && (value === "" || isCustomColor(value));
    }
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

/** 有效字号档位：两种模式各读自己那一列，刻意不改配置本身。 */
export function effectiveSizeId(config) {
  const normalized = normalizeLyricsConfig({}, config);
  if (normalized.mode !== "taskbar") return normalized.size;
  const known = TASKBAR_FONT_STEPS.some((step) => step.id === normalized.taskbarSize);
  return known ? normalized.taskbarSize : DEFAULT_LYRICS_CONFIG.taskbarSize;
}

/** 这一份配置**实际要画成什么样**（纯函数）：歌词窗只消费一个结果，不在组件里写三元分支。 */
export function lyricsAppearance(config) {
  const normalized = normalizeLyricsConfig({}, config);
  if (normalized.mode === "taskbar") {
    return {
      size: effectiveSizeId(normalized),
      color: normalized.taskbarColor,
      customColor: normalized.taskbarCustomColor,
      karaoke: normalized.taskbarKaraoke,
    };
  }
  return {
    size: normalized.size,
    color: normalized.color,
    customColor: normalized.customColor,
    karaoke: true,
  };
}

/** 官方拖动调用的资格：仅未锁的桌面窗。 */
export function dragRegionEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.mode === "desktop" && !normalized.locked;
}

/** 拖拽缩放的资格：仅未锁的桌面窗（与 Rust 的 resizable_enabled 同一口径）。 */
export function resizableEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.mode === "desktop" && !normalized.locked;
}

/** 窗口是否不接收鼠标：任务栏一律如此，锁定的桌面歌词也是（解锁按钮所在区域由 Rust 轮询临时放开）。 */
export function clickThroughEnabled(config) {
  const normalized = normalizeLyricsConfig({}, config);
  return normalized.mode === "taskbar" || normalized.locked;
}

/** 衬底深浅：桌面 clean/panel 未锁为 normal、锁定为 light；纯透明与任务栏为 none。 */
export function lyricsBackdrop(config) {
  const normalized = normalizeLyricsConfig({}, config);
  if (normalized.mode !== "desktop" || normalized.style === "bare") return "none";
  return normalized.locked ? "light" : "normal";
}

/** 歌词窗的初值来自 URL 查询串：渲染层订阅事件是异步的，查询串同步到位没有这个缝。 */
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

/** 歌词窗的主题初值：只认那三个字面量，其余回 `null`（调用方当系统档处理）。 */
export function themeFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  return normalizeThemeChoice(params.get(LYRICS_THEME_PARAM));
}

/** 该不该把这一帧进度推给歌词窗（纯函数）：第一次必推，状态变了立刻推，否则按最小间隔。 */
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

/** 导入回执 → 落地计划（纯函数）：成功带行数组，失败只带一句人话、绝不清空面板。 */
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

/** 进度插值估计（纯函数）：播放中按经过的真实时间前推，暂停时停住不动。 */
export function estimateTimeMs(lastPush, nowMs) {
  const push = lastPush !== null && typeof lastPush === "object" ? lastPush : null;
  const base = push === null ? 0 : Number(push.timeMs);
  const anchor = Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
  if (push === null || push.playing !== true) return anchor;
  const elapsed = Number(nowMs) - Number(push.atMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return anchor;
  return anchor + Math.round(elapsed);
}

/** 窗从隐藏变可见时把插值锚点挪到"现在"，免得按隐藏时长一次性往前跳。 */
export function reanchorProgress(lastPush, nowMs) {
  const push = lastPush !== null && typeof lastPush === "object" ? lastPush : null;
  if (push === null) return null;
  return { ...push, atMs: Number.isFinite(Number(nowMs)) ? Number(nowMs) : push.atMs };
}

/** 进度消息 → 官方歌词组件要的那一帧 `{time, isSeeking, playing}`；`playing` 只认 true。 */
export function karaokeFrame(lastPush, nowMs, isSeeking) {
  return {
    time: estimateTimeMs(lastPush, nowMs),
    isSeeking: isSeeking === true,
    playing: lastPush !== null && typeof lastPush === "object" && lastPush.playing === true,
  };
}
