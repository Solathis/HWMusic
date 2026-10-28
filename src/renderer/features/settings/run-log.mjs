/**
 * 设置页运行日志的纯逻辑：级别归一、两路来源合并、筛选、脱敏兜底、文案。
 * 两路来源统一成 `{id, time, level, source, message, masked}`。
 * 宿主的日志文件返回前已按 `run_log.rs` 脱敏；`app:notice` 广播一律 info。
 * 界面不发明级别，也不发明“有日志”：筛出 0 条与一条都没有是两句不同的话。
 */

/** 设置页一次读多少条（与 Rust 侧的 `run_log::READ_LIMIT` 同一个数，由测试钉住）。 */
export const RUN_LOG_READ_LIMIT = 500;

/** 四档级别（界面上的筛选项就是这四档，顺序即展示顺序）。 */
export const RUN_LOG_LEVELS = ["debug", "info", "warn", "error"];

/** 默认显示的级别：debug 是排障档，默认关着（打开它会淹掉用户真正要看的那几行）。 */
export const RUN_LOG_DEFAULT_LEVELS = ["info", "warn", "error"];

/** @type {Record<string, string>} */
export const RUN_LOG_LEVEL_LABELS = {
  debug: "调试",
  info: "信息",
  warn: "警告",
  error: "错误",
};

/** 日志范围：本次启动（默认）或整份日志文件。 */
export const RUN_LOG_SCOPES = ["session", "all"];
export const RUN_LOG_SCOPE_LABELS = { session: "本次启动", all: "全部" };

/** 级别 → shadcn `Badge` 的**官方**变体（不写自定义颜色类）。 */
/** @type {Record<string, "default" | "secondary" | "destructive" | "outline" | "ghost" | "link">} */
export const RUN_LOG_LEVEL_BADGE = {
  debug: "ghost",
  info: "secondary",
  warn: "default",
  error: "destructive",
};

/** `app:notice` 那些条目的来源名：它们不是日志文件里的行。 */
export const NOTICE_SOURCE = "提示";

export const RUN_LOG_EMPTY_TEXT = "暂无运行日志。应用启动或操作后会写进日志文件，也可以点「刷新」再看。";
export const RUN_LOG_NO_MATCH_TEXT = "没有匹配的日志。可以放宽级别或清空搜索词。";
export const RUN_LOG_FAILURE_TEXT = "读不到运行日志。点「刷新」重试一次；仍不行就重开设置页。";
export const RUN_LOG_FILTER_PLACEHOLDER = "搜索日志…";

const NOTICE_LEVEL = "info";

/** 级别归一：认不出的一律 info（界面不发明第五档，也不把未知画成警告）。 */
export function levelOf(raw) {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (name === "error") return "error";
  if (name === "warn" || name === "warning") return "warn";
  if (name === "debug" || name === "trace") return "debug";
  return "info";
}

/** 界面这一层再挡一次凭据：只认 `Bearer <令牌>` 与白名单键的 `键=值`，值太短不动，重复调用稳定。 */
const SECRET_KEY_PATTERN =
  /(bearer)\s+([^\s"'&,;)\]}]{6,})|([?&;\s"'](?:token|access_token|refresh_token|id_token|code|ticket|sign|signature|sig|sessionid|session_id|devicedata|accesskeyid|password|passwd|pwd|secret)=)([^\s&;,"')}\]]{4,})/gi;

export function maskSecrets(text) {
  if (typeof text !== "string" || text === "") return typeof text === "string" ? text : "";
  return text.replace(SECRET_KEY_PATTERN, (match, bearer, bearerValue, keyPrefix, keyValue) =>
    bearer !== undefined ? `${bearer} ***` : `${keyPrefix}***`,
  );
}

/**
 * 宿主载荷（数组，或 `{entries:[…]}`）→ 统一条目；坏形状给空列表。
 *
 * `message` 存的就是**打码之后**的文本：不留原文，界面与筛选都只碰这一份。
 */
export function normalizeRunLogEntries(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
  const entries = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.message !== "string" || item.message.trim() === "") continue;
    entries.push({
      id: `file-${entries.length}`,
      time: typeof item.time === "string" ? item.time : "",
      level: levelOf(item.level),
      source: typeof item.source === "string" ? item.source : "",
      message: maskSecrets(item.message),
    });
  }
  return entries;
}

/** `app:notice` 的条目（`{id, text}`）→ 统一条目（级别 info、来源「提示」）。 */
export function noticeEntriesToRunLog(notices) {
  const list = Array.isArray(notices) ? notices : [];
  const entries = [];
  for (const notice of list) {
    const text = typeof notice?.text === "string" ? notice.text.trim() : "";
    if (text === "") continue;
    entries.push({
      id: `notice-${entries.length}`,
      time: "",
      level: NOTICE_LEVEL,
      source: NOTICE_SOURCE,
      message: maskSecrets(text),
    });
  }
  return entries;
}

/** 两路来源 → 一份列表：文件条目在前、提示条目在后，归一化只在这一处发生。 */
export function mergeRunLogEntries(filePayload, notices) {
  return [...normalizeRunLogEntries(filePayload), ...noticeEntriesToRunLog(notices)];
}

/** 这一档现在显不显示（坏形状当"不筛"，与筛选函数同一口径）。 */
export function isLevelVisible(levels, level) {
  if (!Array.isArray(levels)) return true;
  return levels.includes(levelOf(level));
}

/** 点一下某档：加上或去掉；**最后一档不许取消**（否则界面成了永远筛出 0 条）。 */
export function toggleLevel(levels, level) {
  const current = Array.isArray(levels) ? RUN_LOG_LEVELS.filter((item) => levels.includes(item)) : [];
  const target = levelOf(level);
  if (current.includes(target)) {
    return current.length <= 1 ? current : current.filter((item) => item !== target);
  }
  return RUN_LOG_LEVELS.filter((item) => current.includes(item) || item === target);
}

function searchTextOf(entry) {
  if (entry === null || typeof entry !== "object") return "";
  const message = typeof entry.message === "string" ? entry.message : "";
  const source = typeof entry.source === "string" ? entry.source : "";
  return `${message}\n${source}`;
}

/** 级别多选 + 文本子串筛选：`levels` 不是数组 = 不按级别筛，空数组 = 什么都不显示；文本匹配 message 与 source，空白查询不筛。 */
export function filterRunLogEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const levels = Array.isArray(options?.levels) ? options.levels.map(levelOf) : null;
  const needle = typeof options?.query === "string" ? options.query.trim().toLowerCase() : "";
  return list.filter((entry) => {
    if (levels !== null && !levels.includes(levelOf(entry?.level))) return false;
    if (needle === "") return true;
    return searchTextOf(entry).toLowerCase().includes(needle);
  });
}

/** 「N / 总数 条」：两个数字都给，否则分不清"只有这些"与"被筛掉了"。 */
export function runLogCountText(shown, total) {
  const safeShown = Number.isInteger(shown) && shown >= 0 ? shown : 0;
  const safeTotal = Number.isInteger(total) && total >= 0 ? total : 0;
  return `${safeShown} / ${safeTotal} 条`;
}

/** 时间显示：`YYYY-MM-DD HH:MM:SS` → `HH:MM:SS`（认不出的原样给，绝不画 Invalid Date）。 */
export function runLogTimeLabel(time) {
  if (typeof time !== "string") return "";
  const match = /(\d{2}:\d{2}:\d{2})/.exec(time);
  return match === null ? time : match[1];
}
