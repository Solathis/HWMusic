/**
 * 收藏页的分页合并与滚动位置记忆（R8）：**纯逻辑**，UI 只消费。
 *
 * 收藏语义（旧仓踩过的坑，见 docs/API_CONTRACT.md §2.3）：
 * - 接口**没有可信总数** → 总数 = 完整分页后的 ID 去重数；没走完就是 `null`；
 * - 接口上报的 `total` 只作记录（`reportedTotal`），**永远不参与 UI 数字**；
 * - "已加载 N 首"与"共 M 首"分开显示（`describeFavoritesCounts`）。
 *
 * 另外两条是为了不把用户坑得更深：
 * - 失败**不清空**已加载内容（把"读不到"变成"收藏是空的"比报错更糟）；
 * - 失败后**不自动重试**（离线时那是一个请求风暴）；重试要么用户点，要么重新进页面。
 */
import { trackIdOf } from "./track-fields.mjs";

export const FAVORITES_PAGE_SIZE = 50;

/** 滚动容器与哨兵的测试锚点（源码扫描按它们钉"常驻挂载 + 滚动加载"的接线）。 */
export const FAVORITES_PAGE_TESTID = "favorites-page";
export const FAVORITES_SCROLL_TESTID = "favorites-scroll-root";
export const FAVORITES_SENTINEL_TESTID = "favorites-sentinel";
/**
 * 滚动位置记忆的键，也是滚动容器上 `data-scroll-root` 的值。
 * 切页回来按它恢复位置（display:none 会丢 scrollTop，所以必须自己记）。
 */
export const FAVORITES_SCROLL_KEY = "favorites";

export function createFavoritesState() {
  return {
    songs: [],
    ids: [],
    loadedCount: 0,
    total: null,
    reportedTotal: null,
    skipped: 0,
    duplicates: 0,
    pages: 0,
    isComplete: false,
    stopReason: null,
    loading: false,
    failure: null,
  };
}

export function favoritesSummary(state) {
  return {
    loadedCount: state.loadedCount,
    total: state.total,
    isComplete: state.isComplete,
    skipped: state.skipped,
    pages: state.pages,
    loading: state.loading,
    failure: state.failure,
    hasSongs: state.songs.length > 0,
  };
}

/**
 * 合并一页（`{songs, hasMore, skipped, reportedTotal}`）。
 *
 * 走完过（isComplete）之后再来页一律忽略：页数已经定局，再收只会让总数对不上。
 */
export function mergeFavoritesPage(state, page) {
  if (state.isComplete) return state;

  const incoming = Array.isArray(page?.songs) ? page.songs : [];
  const ids = [...state.ids];
  const seen = new Set(ids);
  const songs = [...state.songs];
  let duplicates = 0;

  for (const item of incoming) {
    const id = trackIdOf(item);
    // 协议层已经丢掉无 ID 的条目；这里再兜一次，绝不把没有 id 的行放进列表（去重和跳转都要它）
    if (id === null) continue;
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    ids.push(id);
    songs.push(item);
  }

  const hasMore = page?.hasMore === true;
  const isComplete = !hasMore;
  const reported = page?.reportedTotal;
  return {
    ...state,
    songs,
    ids,
    loadedCount: songs.length,
    // 总数只有完整分页走完才敢写：它是去重后的条数，不是接口报的那个数
    total: isComplete ? songs.length : null,
    reportedTotal: typeof reported === "number" ? reported : state.reportedTotal,
    skipped: state.skipped + (Number.isInteger(page?.skipped) ? page.skipped : 0),
    duplicates: state.duplicates + duplicates,
    pages: state.pages + 1,
    isComplete,
    stopReason: isComplete ? "exhausted" : null,
    loading: false,
    failure: null,
  };
}

export function markFavoritesLoading(state, loading) {
  return { ...state, loading: loading === true };
}

/** 计数文案：总数未知时**只**说已加载数（提前说"共 M 首"就是把一页说成全部）。 */
export function describeFavoritesCounts(summary) {
  if (summary.total === null) return `已加载 ${summary.loadedCount} 首`;
  return `共 ${summary.total} 首（已加载 ${summary.loadedCount} 首）`;
}

/** 首屏提示文案（首次加载期间替掉"已加载 0 首"——那个数字看起来像"你什么都没有"）。 */
export const FAVORITES_LOADING_TEXT = "正在加载…";

/**
 * 还是首屏吗：**一页都没取回来**、且没有失败。
 *
 * 这个区分是必要的：首屏期间 `songs.length === 0`，但此时显示"还没有收藏歌曲。"
 * 就是假空态（数据还在路上）；失败时也不能算——失败有自己的说法（"接口未配置"）。
 */
export function isFavoritesInitialLoad(state) {
  return state.pages === 0 && state.failure === null;
}

export function markFavoritesFailure(state, message) {
  return {
    ...state,
    loading: false,
    failure: typeof message === "string" && message !== "" ? message : "加载失败（详情见日志）。",
    stopReason: "error",
  };
}

/** 清掉失败态但保留已加载内容（用户点"重试"时用）。 */
export function clearFavoritesFailure(state) {
  return { ...state, failure: null, stopReason: null };
}

/** 还能不能再取一页：加载中、已走完、上次失败，三者都不行。 */
export function shouldLoadNextFavoritesPage(state) {
  return state.loading !== true && state.isComplete !== true && state.failure === null;
}

/** 下一页页号（从 1 开始）。失败重试时页号不变——失败那一页要重取。 */
export function nextFavoritesPage(state) {
  return state.pages + 1;
}

/**
 * 滚动位置记忆：按视图键分开记。
 *
 * 为什么必须自己记：收藏页常驻挂载但切走时会被 `hidden`（display:none），
 * 而浏览器在这种元素上会把 scrollTop 丢掉——用户切回来就回到了列表顶部，
 * 对"滚动加载到底是滚到哪一页"的体验是毁灭性的。
 */
export function createScrollMemory() {
  const offsets = new Map();
  return {
    remember(key, offset) {
      const value = typeof offset === "number" ? offset : Number(offset);
      if (!Number.isFinite(value)) return; // 坏值不覆盖好值
      offsets.set(String(key), Math.max(0, Math.floor(value)));
    },
    offsetFor(key) {
      return offsets.get(String(key)) ?? 0;
    },
    forget(key) {
      offsets.delete(String(key));
    },
  };
}
