/**
 * 主界面的视图模型：唯一的页面枚举与侧边栏导航真源。
 * 刻意不引用路由库：页面只有七个，状态就是 useState + renderPage() 的 switch。
 * 导航条目、标题、常驻页判定都从这里取；认不出的视图 id 回落到收藏页。
 * 视图键同时是滚动位置与 React key 的依据：参数顺序不同但语义相同必须是同一个键。
 */

/** 页面枚举（view id 的唯一真源）。 */
export const VIEW = {
  favorites: "favorites",
  /** 本地歌曲（导入的本机音频文件，曲库由 Rust 拥有，渲染层只拿 id）。 */
  local: "local",
  playlistDetail: "playlist-detail",
  search: "search",
  album: "album",
  artist: "artist",
  history: "history",
  settings: "settings",
};

export const VIEW_IDS = Object.freeze(Object.values(VIEW));

/** 侧边栏导航（顺序即显示顺序）：专辑/歌手/歌单详情不占导航，「搜索」与「我的歌单」也不再是导航项。 */
export const SIDEBAR_VIEWS = Object.freeze([
  { id: VIEW.favorites, label: "我的收藏" },
  { id: VIEW.local, label: "本地歌曲" },
  { id: VIEW.history, label: "播放历史" },
  { id: VIEW.settings, label: "设置" },
]);

/** 导航列表的测试锚点：源码扫描与 e2e 都按它找导航（改名就是改契约）。 */
export const NAV_LIST_TESTID = "nav-list";

export const DEFAULT_VIEW_ID = VIEW.favorites;

/** 没给名字时各页的标题（不许空串）。 */
const FALLBACK_TITLES = {
  [VIEW.favorites]: "我的收藏",
  [VIEW.local]: "本地歌曲",
  [VIEW.playlistDetail]: "歌单",
  [VIEW.search]: "搜索",
  [VIEW.album]: "专辑",
  [VIEW.artist]: "歌手",
  [VIEW.history]: "播放历史",
  [VIEW.settings]: "设置",
};

/** 造一个视图（参数为 null/数组/非对象时当空）。 */
export function createView(id, params = {}) {
  const source = params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
  const cleaned = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    cleaned[key] = String(value);
  }
  return { id: isViewId(id) ? id : DEFAULT_VIEW_ID, params: cleaned };
}

export function isViewId(value) {
  return typeof value === "string" && VIEW_IDS.includes(value);
}

/** 归一：认不出的一律回落到收藏页（未登录之外的第二道"绝不白屏"保险）。 */
export function normalizeView(view) {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return createView(DEFAULT_VIEW_ID);
  return createView(view.id, view.params);
}

export function viewParam(view, key) {
  const params = view?.params;
  if (params === null || typeof params !== "object") return null;
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function viewTitle(view) {
  const normalized = normalizeView(view);
  const named = viewParam(normalized, "name");
  if (named !== null) return named;
  return FALLBACK_TITLES[normalized.id] ?? "华为云音乐";
}

/**
 * 视图键：id + 排序后的参数。滚动位置、React key 都用它。
 * 排序是必须的——同一个歌单用不同顺序的参数进来，是同一个位置。
 */
export function viewKey(view) {
  const normalized = normalizeView(view);
  const entries = Object.entries(normalized.params).sort(([left], [right]) => (left < right ? -1 : 1));
  if (entries.length === 0) return normalized.id;
  return `${normalized.id}?${entries.map(([key, value]) => `${key}=${value}`).join("&")}`;
}

/** 常驻挂载的视图（切走不卸载）：本任务只有收藏页需要——滚动加载的进度不该切一次页就丢。 */
export function isResidentView(view) {
  return normalizeView(view).id === VIEW.favorites;
}
