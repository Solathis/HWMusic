/**
 * 设置页的纯逻辑（R10）：代理表单的清洗/投影/载荷、关窗行为、队列只读摘要、失败文案。
 *
 * 为什么这一层是独立的 `.mjs`（与 R8 的 `library-state.mjs`、R9 的 `playback-state.mjs` 同款）：
 * 这些全是"看起来对、其实在撒谎"的判定，而 JSX 里的判定既跑不了测试，也会被后来的人各写一份。
 * 界面只做两件事：把状态塞进这层函数、把返回值渲染出来。
 *
 * 三条纪律：
 *
 * 1. **凭据单向流动**：`settings:get` 的回执里**带**代理密码（磁盘形状如此，R6 定的），
 *    所以"不回显"必须由 `proxyFormFromSettings` 结构性地保证——表单对象里根本没有密码这一项，
 *    只有一个 `hasStoredPassword` 布尔；密码字段永远从空开始，留空保存等于清除（`passwordHint` 说清）。
 * 2. **归一只有一份**：这里只做"拆逗号、去空白、丢空项"；大小写去重、端口与主机的字符集清洗
 *    全部归 core 的 `normalizeProxy`（`src/main/settings.mjs`）。第二份实现 = 两份会漂移的真相。
 * 3. **不冒充**：没测过就不给结论、读不到自启状态就说"没取到"、登录状态只认一个布尔
 *    （`auth:status` 的载荷里没有可显示的身份字段，R10 不为显示去扩协议）。
 *
 * 枚举与文案的"同一份真源"：`CLOSE_BEHAVIORS` 与 `src/main/settings.mjs` 的同名常量是刻意的
 * 两份（渲染层不能 import 那个模块：它带 node:fs/node:net/node:path，进不了浏览器包），
 * 由 `test/close-behavior.test.mjs` 钉住逐条相等。
 */
import { trackTitleOf } from "../playback/playback-state.mjs";

/** 普通对象判定（数组/空值都不是表单）。 */
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** 取一个对象的字符串字段（类型不对当没填）。 */
const text = (value) => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------
// 代理表单：读 → 表单（凭据在这一步就被丢掉）
// ---------------------------------------------------------------------------

/**
 * 设置文档 → 表单状态。**密码不进表单**，只以 `hasStoredPassword` 告知"存过没有"。
 *
 * 坏文档（null / proxy 不是对象 / 字段类型不对）一律当"没配"：设置读坏了也要能打开设置页，
 * 而不是白屏或显示 `null` 这样的字面量。
 */
export function proxyFormFromSettings(document) {
  const proxy = isPlainObject(document?.data) && isPlainObject(document.data.proxy) ? document.data.proxy : {};
  return {
    enabled: proxy.enabled === true,
    host: text(proxy.host),
    // 端口以**文本**进表单：用户的输入就是文本，清洗规则只有 core 一份（`8080x` 不该被这里静默丢掉）
    portText: typeof proxy.port === "number" ? String(proxy.port) : text(proxy.port),
    username: text(proxy.username),
    // 只写字段：永远从空开始（留空保存 = 清除，见 passwordHint）
    password: "",
    bypassText: Array.isArray(proxy.bypass)
      ? proxy.bypass.filter((entry) => typeof entry === "string").join(", ")
      : text(proxy.bypass),
    hasStoredPassword: text(proxy.password) !== "",
  };
}

/** 密码字段下面那行提示：存过密码就必须说清"留空会清除"，没存过就不吓唬人。 */
export function passwordHint(form) {
  return form?.hasStoredPassword === true
    ? "已保存密码：留空保存会清除它（这组代理将不再带凭据）。"
    : "密码不填就是不使用认证（凭据只写不显，界面上永远看不到它）。";
}

// ---------------------------------------------------------------------------
// 表单 → 保存载荷
// ---------------------------------------------------------------------------

/** 例外列表：只拆逗号、去空白、丢空项（去重与大小写归 core 的 `normalizeBypass`）。 */
function splitBypass(raw) {
  const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const entry = part.trim();
    if (entry !== "") out.push(entry);
  }
  return out;
}

/**
 * 表单 → `settings:set` 的 patch（形状与磁盘一致：六个字段一个不少）。
 *
 * 注意两处**刻意的不清洗**：用户名与密码原样送去（空格可能是名字/密码的一部分，core 同口径），
 * 主机只去两端空白（中间不动，字符集由 core 判）。端口原样发文本——清洗规则只有 core 一份。
 */
export function proxyPatchFromForm(form) {
  const source = isPlainObject(form) ? form : {};
  return {
    proxy: {
      enabled: source.enabled === true,
      host: text(source.host).trim(),
      port: text(source.portText).trim(),
      username: text(source.username),
      password: text(source.password),
      bypass: splitBypass(source.bypassText),
    },
  };
}

/**
 * 保存前的校验：坏输入先拦下（core 会把 `8080x` 静默当成"没填"——用户以为端口填了，其实没有）。
 *
 * @returns {string|null} 一句话（说明原因 + 下一步）；`null` = 可以保存。
 */
export function validateProxyForm(form) {
  const source = isPlainObject(form) ? form : {};

  const portText = text(source.portText).trim();
  if (portText !== "") {
    const numeric = /^[0-9]+$/.test(portText);
    const value = numeric ? Number(portText) : Number.NaN;
    if (!numeric || value < 1 || value > 65535) {
      return "端口要填 1–65535 之间的整数（留空 = 不填端口）。";
    }
  }

  if (source.enabled === true && text(source.host).trim() === "") {
    return "启用了代理但没填主机：这样等于直连。请填主机地址，或关掉代理开关。";
  }

  return null;
}

/**
 * 保存回执 → 一句话。
 *
 * `restartRequired` 来自 core 的 `settings:set`（改代理要重启才生效）。另外**主机被清洗掉**这件事
 * 必须说出来：保存是成功的（如实说"已保存"），但代理不会生效（如实说"仍是直连"）——
 * 只报"已保存"等于让用户以为代理通了。
 */
export function proxySaveNotice(settings, restartRequired) {
  const proxy = isPlainObject(settings?.data) && isPlainObject(settings.data.proxy) ? settings.data.proxy : {};
  const hostMissing = proxy.enabled === true && text(proxy.host).trim() === "";

  const parts = ["设置已保存。"];
  if (hostMissing) parts.push("但代理主机没通过检查：代理不会生效（仍是直连）。");
  if (restartRequired === true) parts.push("代理改动要重启应用才生效；登录窗口下次打开即生效。");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// 测试连接
// ---------------------------------------------------------------------------

/** 认得的失败类别（认不出时优先用 core 给的那句话——它是唯一线索）。 */
export const PROXY_TEST_FAILURE_TEXT = {
  not_configured: "代理没开或没填全（主机与端口都要有）。",
  invalid_url: "测试地址不可用。",
  timeout: "测试超时：代理可能不通，或网络被挡住。",
  http_status: "代理连上了，但目标站点返回了错误。",
  network: "连不上该代理（请检查主机、端口与网络）。",
};

/**
 * 测试结论 → 一句话（`null` = 还没测过，界面上什么都不显示）。
 *
 * **绝不回显凭据**：core 的结论里本来就只有状态与错误摘要，这里只做措辞，不拼任何入参。
 */
export function proxyTestResultText(result) {
  if (!isPlainObject(result)) return null;

  if (result.ok === true) {
    const status = typeof result.status === "number" ? `HTTP ${result.status}` : "已响应";
    const ms = typeof result.ms === "number" && Number.isFinite(result.ms) ? result.ms : null;
    return ms === null ? `代理连通（${status}）。` : `代理连通（${status}，耗时 ${ms} 毫秒）。`;
  }

  const message = isPlainObject(result.error) ? text(result.error.message).trim() : "";
  if (message !== "") return `代理未连通：${message}`;
  const known = PROXY_TEST_FAILURE_TEXT[result.error?.kind];
  return `代理未连通：${typeof known === "string" ? known : "原因未识别，请查看运行日志"}`;
}

// ---------------------------------------------------------------------------
// 关窗行为（tray / quit）
// ---------------------------------------------------------------------------

/** 关窗行为枚举（与 core 的同名常量逐条相等，由测试钉住）。 */
export const CLOSE_BEHAVIORS = ["tray", "quit"];

/** 宿主还没答/答不上来时保守按托盘不可用；仅 tray 受此 fail-safe 约束。 */
export const TRAY_AVAILABLE = false;

/** 宿主回执 → 可用性（只认 true，其余形状一律保守）。 */
export function trayAvailabilityFromAnswer(answer) {
  return answer === true;
}

export const CLOSE_BEHAVIOR_LABELS = {
  tray: "最小化到托盘",
  quit: "退出应用",
};

/** 关窗行为的选项文案（认不出的值给退出那一档，与 closeBehaviorPatch 同口径）。 */
export function closeBehaviorLabel(behavior) {
  return CLOSE_BEHAVIOR_LABELS[behavior] ?? CLOSE_BEHAVIOR_LABELS.quit;
}

/** 认不出的 UI 值保守回落 quit；core 写入路径仍结构化拒绝越界值。 */
export function closeBehaviorPatch(value) {
  return { closeBehavior: CLOSE_BEHAVIORS.includes(value) ? value : "quit" };
}

/** 精确旧 minimize 读迁移 tray；其余坏值与 core 默认一致。 */
export function closeBehaviorFromSettings(document) {
  const stored = isPlainObject(document?.data) ? document.data.closeBehavior : null;
  if (stored === "minimize") return "tray";
  return CLOSE_BEHAVIORS.includes(stored) ? stored : CLOSE_BEHAVIORS[0];
}

/** tray 必须如实说明托盘不可用时会退出。 */
export function closeBehaviorNotice(behavior, options = {}) {
  if (behavior !== "tray") return "关窗即退出应用（正在播放的音乐会停止）。";
  return options?.trayAvailable === true
    ? "关窗后应用继续在托盘运行：托盘菜单里可以退出。"
    : "托盘当前不可用（没装上或状态没取到，详情见运行日志）：现在关窗会直接退出，选「最小化到托盘」等同于退出。";
}

// ---------------------------------------------------------------------------
// 队列只读摘要与外观说明
// ---------------------------------------------------------------------------

/**
 * 播放状态 → 只读摘要 `{count, current}`（设置页只显示，不做任何队列管理）。
 *
 * 没有播放状态就是空队列（不抛）；当前曲的显示规则复用 `trackTitleOf`：
 * 旧队列只有标识时显示"曲目 1003"（"未知歌曲"会让人以为队列坏了）。
 */
export function queueSummary(state) {
  const source = isPlainObject(state) ? state : {};
  const entries = Array.isArray(source.entries) ? source.entries : [];
  return {
    count: entries.length,
    current: isPlainObject(source.track) ? trackTitleOf(source.track) : null,
  };
}

/** 队列摘要的文案（空队列给下一步，不是"播放失败"）。 */
export function queueSummaryText(summary) {
  const count = Number.isInteger(summary?.count) && summary.count > 0 ? summary.count : 0;
  if (count === 0) return "播放队列是空的（在列表里双击曲目会把整个列表放进队列）。";
  const current = typeof summary?.current === "string" && summary.current !== "" ? summary.current : null;
  return current === null
    ? `队列里有 ${count} 首曲目，当前没有在播放的曲目。`
    : `队列里有 ${count} 首曲目，当前播放：${current}。`;
}

/**
 * 外观说明（**R41b 改写**：这里以前写的是"本版本不提供手动切换"）。
 *
 * 那句话在 R25 就不成立了：主题三态（浅色 / 深色 / 跟随系统）从那时起就有手动档，
 * 只是入口只在登录页与浮动控件上——设置页这张卡一直留在 R10 的口径上。
 * R41b 把三态放进这张卡（与左下角那枚循环图标按钮同源同向），文案随之改成**现在的事实**：
 * 三档可选，跟随系统那一档的亮暗由系统的深色模式决定。
 */
export const APPEARANCE_NOTICE_TEXT = "浅色 / 深色 / 跟随系统三选一；跟随系统时，亮暗由系统的深色模式决定。";

// ---------------------------------------------------------------------------
// 开机自启（core_set_autostart / core_get_autostart）
// ---------------------------------------------------------------------------

/** 自启开关的状态文案：开 / 关 / **没取到**是三档，不许互相冒充。 */
export function autostartStateText(enabled) {
  if (enabled === true) return "已开启：登录系统后自动启动。";
  if (enabled === false) return "已关闭：不会随系统启动。";
  return "状态未取到。";
}

/**
 * 自启切换失败的文案。
 *
 * core 的那句话是唯一线索（它已经在 Rust 侧清洗过，不带堆栈），丢掉它换成"操作失败"才是真的没法排查。
 */
export function autostartFailureText(error) {
  const message = isPlainObject(error) ? text(error.message).trim() : "";
  return message === ""
    ? "没能改动开机自启（详情见运行日志）：开关显示的是实际状态，可以稍后重试。"
    : `没能改动开机自启：${message}`;
}

/**
 * 读自启状态失败的文案：**一句**话说完原因与下一步。
 *
 * 状态行这时不渲染（见 `pages.tsx`）：同一个失败说两遍，用户只会以为坏了两处。
 * core 的技术原文不进界面，它已经由 Rust 侧记进运行日志（`commands::logged`）。
 */
export const AUTOSTART_STATUS_FAILURE_TEXT =
  "读不到开机自启状态，开关暂不可用：可以稍后重开设置页再试，详情见运行日志。";

export function autostartStatusFailureText() {
  return AUTOSTART_STATUS_FAILURE_TEXT;
}

// ---------------------------------------------------------------------------
// 失败文案
// ---------------------------------------------------------------------------

/**
 * 认得的失败类别（类别来自 core 的结构化错误 kind）。
 *
 * 每一句都要回答用户最关心的那个问题：**我的设置到底有没有保存**。
 * 这句文案同时用在"读设置"与"写设置"两条路上，所以措辞不能只说"读不到"。
 */
export const SETTINGS_FAILURE_TEXT = {
  core_unavailable: "内核尚未就绪：这次设置操作没完成（多半没保存），稍后重开应用再试。",
  core_gone: "内核已退出：设置没有保存，重开应用后再试。",
  timeout: "请求超时：设置可能没保存，稍后再试。",
  unknown_channel: "请求通道未接通：设置没有保存，请更新应用。",
  unimplemented: "该功能尚未接入（后续任务实现）：设置没有改动。",
};

const UNKNOWN_SETTINGS_FAILURE_TEXT = "设置操作失败（详情见运行日志）。";

/**
 * 设置失败 → 显示文案。
 *
 * 与库页面的 `libraryFailureText` 分开：那边是"加载失败"，这里是"没保存"——两件事的下一步不同。
 * 认不出的类别带上 core 给的那句话，并明说**没有写盘**（用户最需要知道的是"我的设置还在不在"）。
 */
export function settingsFailureText(error) {
  if (!isPlainObject(error)) return UNKNOWN_SETTINGS_FAILURE_TEXT;
  const known = SETTINGS_FAILURE_TEXT[error.kind];
  if (typeof known === "string") return known;
  const message = text(error.message).trim();
  if (message === "") return UNKNOWN_SETTINGS_FAILURE_TEXT;
  return `设置未保存：${message}`;
}
