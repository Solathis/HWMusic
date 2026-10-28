/**
 * 库页面的失败/空态文案：一句话，克制，且不冒充。
 * “接口没配” ≠ “确实没有数据”：端点未配置时只能说“未配置/待联调”，不能说“还没有收藏歌曲”。
 * 也不许画饼：“敬请期待/即将上线”之类的话在本文件里被测试禁掉。
 */
import { VIEW, normalizeView } from "./views.mjs";

/** 各失败类别的文案（类别来自 core 侧的结构化错误 kind）。 */
export const LIBRARY_FAILURE_TEXT = {
  endpoint_unknown: "接口尚未配置（待联调确认）。",
  unimplemented: "该功能尚未接入（后续任务实现）。",
  core_unavailable: "内核尚未就绪，暂时无法加载。",
  core_gone: "内核已退出，重开应用后再试。",
  timeout: "请求超时，稍后再试。",
  unknown_channel: "请求通道未接通，请更新应用。",
};

const UNKNOWN_FAILURE_TEXT = "加载失败（详情见日志）。";

/** 失败 → 显示文案：认不出的类别带上 core 已清洗过的那句话，不换成“未知错误”。 */
export function libraryFailureText(error) {
  if (error === null || typeof error !== "object") return UNKNOWN_FAILURE_TEXT;
  const known = LIBRARY_FAILURE_TEXT[error.kind];
  if (typeof known === "string") return known;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (message === "") return UNKNOWN_FAILURE_TEXT;
  return `加载失败：${message}`;
}

/** 端点未配置（UI 用它决定是否显示"待联调"这类说明，而不是空态）。 */
export function isEndpointUnconfigured(error) {
  return error !== null && typeof error === "object" && error.kind === "endpoint_unknown";
}

/** 各页面的空态（都是"确实没有数据"的语气，只有真拿到了空列表才会显示）。 */
const EMPTY_TEXT = {
  [VIEW.favorites]: "还没有收藏歌曲。",
  // 本地歌曲的空态只说"还没导入"：这句话是可以照着做一件事的（导入按钮就在旁边）
  [VIEW.local]: "还没有导入本地歌曲。",
  [VIEW.playlistDetail]: "这个歌单还没有歌曲。",
  [VIEW.history]: "还没有播放记录。",
  [VIEW.search]: "输入关键字开始搜索。",
  [VIEW.album]: "这张专辑还没有歌曲。",
  [VIEW.artist]: "这位歌手还没有歌曲。",
  [VIEW.settings]: "设置项将在后续任务接入。",
};

/** 检索类页面的“查无所获”文案：它跟“还没输入关键字”是两件事。 */
const NO_RESULT_TEXT = {
  [VIEW.search]: "没有找到相关歌曲。",
};

export function libraryEmptyText(view, options = {}) {
  const id = normalizeView(view).id;
  if (options.searched === true && NO_RESULT_TEXT[id] !== undefined) return NO_RESULT_TEXT[id];
  return EMPTY_TEXT[id] ?? EMPTY_TEXT[VIEW.favorites];
}

/** 往运行日志里加一条（纯函数）：只收非空文本，条数有上限且丢最旧的。 */
export function appendNotice(entries, text, limit = 100, id = 0) {
  const current = Array.isArray(entries) ? entries : [];
  if (typeof text !== "string") return current;
  const trimmed = text.trim();
  if (trimmed === "") return current;
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const next = [...current, { id, text: trimmed }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
