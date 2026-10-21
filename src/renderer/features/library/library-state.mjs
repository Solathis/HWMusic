/**
 * 库页面的失败/空态文案（R8）：一句话，克制，且**不冒充**。
 *
 * 运行日志（`app:notice` 收上来的那些提示）的**纯列表逻辑**也在这里：`appendNotice`（R8）
 * 与 R39 的 `filterNoticeEntries` / `noticeLogCountText`。R39 起日志的展示在设置页那张卡里，
 * 但"怎么拼、怎么筛、计数怎么说"仍然只有这一个模块一处实现（UI 只 setState 与渲染）。
 *
 * 最重要的一条区分（R4 K1 风险的 UI 面）：**"接口没配" ≠ "确实没有数据"**。
 * 端点未配置时必须说"未配置/待联调"，绝不能显示"还没有收藏歌曲"——
 * 那会让用户以为自己的收藏空了，而事实是我们连不上（旧仓的"假空态"就是这种坑）。
 *
 * 同理不许画饼："敬请期待/即将上线"之类的话在本文件里被测试禁掉：
 * 页面已经在那里了，唯一诚实的说法是"未配置"（缺配置）或"未接入"（缺实现）。
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

/**
 * 失败 → 显示文案。
 *
 * 认不出的类别带上 core 给的那句话——那句话已经在 core 侧清洗过（不带堆栈、不回显响应体），
 * 把它丢掉换成"未知错误"才是真的让用户没法自查。
 */
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
  [VIEW.playlists]: "还没有歌单。",
  [VIEW.playlistDetail]: "这个歌单还没有歌曲。",
  [VIEW.history]: "还没有播放记录。",
  [VIEW.search]: "输入关键字开始搜索。",
  [VIEW.album]: "这张专辑还没有歌曲。",
  [VIEW.artist]: "这位歌手还没有歌曲。",
  [VIEW.settings]: "设置项将在后续任务接入。",
};

/**
 * 检索类页面的"查无所获"文案。
 *
 * 只有搜索有这一档：它跟"还没输入关键字"是两件事——把没结果说成"输入关键字开始搜索。"
 * 就是让用户对着一句"你还没搜"发呆（他明明刚搜过）。
 */
const NO_RESULT_TEXT = {
  [VIEW.search]: "没有找到相关歌曲。",
};

export function libraryEmptyText(view, options = {}) {
  const id = normalizeView(view).id;
  if (options.searched === true && NO_RESULT_TEXT[id] !== undefined) return NO_RESULT_TEXT[id];
  return EMPTY_TEXT[id] ?? EMPTY_TEXT[VIEW.favorites];
}

/**
 * 往运行日志里加一条（纯函数，UI 只 setState）。
 *
 * 只收非空文本：一条空日志只会让人以为"日志功能坏了"。
 * 条数有上限且丢最旧的：这是长跑进程的界面，没有上限就是缓慢的内存泄漏。
 */
export function appendNotice(entries, text, limit = 100, id = 0) {
  const current = Array.isArray(entries) ? entries : [];
  if (typeof text !== "string") return current;
  const trimmed = text.trim();
  if (trimmed === "") return current;
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const next = [...current, { id, text: trimmed }];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 一条日志的可筛文本（坏形状一律当空串：认不出不等于要抛出去）。 */
function noticeTextOf(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.text === "string" ? entry.text : "";
}

/**
 * 按**文本子串**筛选日志（R39）。
 *
 * `app:notice` 的载荷只有 `text`（没有级别字段），所以筛选只按文本做——**不发明级别**。
 * 大小写不敏感：日志里混着 `Proxy`/`proxy` 这类英文词，区分大小写只会让人以为"筛不出来"。
 * 空白查询等于不筛（返回原数组），与搜索页"空关键字不发请求"是同一条纪律：
 * 不要把用户没提的要求当成一次筛掉全部。
 */
export function filterNoticeEntries(entries, query) {
  const current = Array.isArray(entries) ? entries : [];
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle === "") return current;
  return current.filter((entry) => noticeTextOf(entry).toLowerCase().includes(needle));
}

/**
 * 「N / 总数 条」计数文案（设置页那张日志卡）。
 *
 * 两个数字都给：只报筛出来的条数，用户就没法知道"是库里只有这些，还是筛选把它们挡住了"。
 * 坏入参当 0（不显示 `NaN / undefined`——那是把内部形状漏到界面上）。
 */
export function noticeLogCountText(shown, total) {
  const safeShown = Number.isInteger(shown) && shown >= 0 ? shown : 0;
  const safeTotal = Number.isInteger(total) && total >= 0 ? total : 0;
  return `${safeShown} / ${safeTotal} 条`;
}
