/**
 * 列表触底分页：**纯逻辑**，UI 只消费。
 *
 * 服务端分页走 `createPaginationState` / `beginPage` / `applyPage` / `applyFailure`；
 * 本地分批（接口本身不分页，不发请求）走 `createLocalListState` / `revealMore`。
 */

import { trackIdOf } from "./track-fields.mjs";

/** 一页取多少（与协议层 `DEFAULT_PAGE_SIZE` 同档：通道边界仍然是"页号 + 页大小"）。 */
export const PAGINATION_PAGE_SIZE = 50;

/** 哨兵进入前多少像素就取下一页（提前量，不是"滚到最底才转圈"）。 */
export const PAGINATION_ROOT_MARGIN_PX = 240;
/** 同上，IntersectionObserver 要的字符串形态（只有这一处真源）。 */
export const PAGINATION_ROOT_MARGIN = `${PAGINATION_ROOT_MARGIN_PX}px`;

/** 本地分批（歌手 / 历史）每批多少条。 */
export const LOCAL_REVEAL_BATCH = 50;

/** 哨兵与状态行的测试锚点（browser 守卫与源码扫描都按它们钉契约）。 */
export const PAGINATION_SENTINEL_TESTID = "list-pagination-sentinel";
export const PAGINATION_STATUS_TESTID = "list-pagination-status";
export const PAGINATION_FAILURE_TESTID = "list-pagination-failure";
export const PAGINATION_RETRY_TESTID = "list-pagination-retry";

/**
 * 协议层对这一页的取数方式（`null` = 还没取到任何一页）。
 */
export const PAGINATION_SOURCE = Object.freeze({ server: "server", localSlice: "local-slice", serverRepeat: "server-repeat" });

/**
 * @typedef {object} PaginationState
 * @property {unknown[]} items 已加载的条目（去重后）
 * @property {string[]} keys 已加载条目的去重键（与 items 同序）
 * @property {number} page 已经取回的页数（0 = 一页都没取回）
 * @property {boolean} hasMore 协议层是否明说还有下一页
 * @property {boolean} loading 是否正在请求
 * @property {string|null} error 上一次失败的人话（null = 没失败）
 * @property {number} duplicates 被跨页去重掉的条数
 * @property {number} skipped 被丢弃的坏条目数
 * @property {number} generation 查询代次（旧响应据此丢弃）
 * @property {boolean} armed 是否允许再次触发
 * @property {unknown} meta 第一页附带的信息，只认第一页
 * @property {unknown[]|null} full 整张列表（只认第一页）
 * @property {string|null} pageSource 这一页的取数方式（`PAGINATION_SOURCE`）
 * @property {number} available 这一页背后那份响应的条数
 */

/**
 * 空的分页状态：一页都没取回、可以取第一页。
 * @returns {PaginationState}
 */
export function createPaginationState() {
  return {
    items: [],
    keys: [],
    page: 0,
    hasMore: true,
    loading: false,
    error: null,
    duplicates: 0,
    skipped: 0,
    generation: 0,
    armed: true,
    meta: null,
    full: null,
    pageSource: null,
    available: 0,
  };
}

/**
 * 换查询：清空列表并换代，迟到旧响应由 generation 丢弃。
 * @param {PaginationState} state
 * @param {number} [generation] 显式指定的新代次；不给就是 `state.generation + 1`。
 * @returns {PaginationState}
 */
export function resetPagination(state, generation) {
  const next = Number.isInteger(generation)
    ? /** @type {number} */ (generation)
    : (Number.isInteger(state?.generation) ? state.generation : 0) + 1;
  return { ...createPaginationState(), generation: next };
}

/** 下一页的页号（从 1 开始；失败重试还是同一页）。 */
export function nextPageOf(state) {
  const page = Number.isInteger(state?.page) ? state.page : 0;
  return page + 1;
}

/** 首屏：一页都没取回、也没失败（此时不许显示"查无所获"那种假空态）。 */
export function isInitialPaging(state) {
  return (Number.isInteger(state?.page) ? state.page : 0) === 0 && state?.error == null;
}

/** 还要不要观察哨兵：协议层说没有下一页、或者上次失败了，都不观察。 */
export function shouldObserve(state) {
  return state?.hasMore === true && state?.error == null;
}

/**
 * 现在能不能发请求：还要观察 + 不在请求中 + 已上膛。
 */
export function shouldRequestNext(state) {
  return shouldObserve(state) && state?.loading !== true && state?.armed === true;
}

/**
 * 进入请求态：卸膛（一页只由用户的一次「接近底部」触发）。
 * @param {PaginationState} state
 * @returns {PaginationState}
 */
export function beginPage(state) {
  return { ...state, loading: true, error: null, armed: false };
}

/**
 * 哨兵离开触发区：重新上膛（下一次接近底部才允许取下一页）。
 * @param {PaginationState} state
 * @returns {PaginationState}
 */
export function markSentinelAway(state) {
  return state?.armed === true ? state : { ...state, armed: true };
}

/**
 * 合并一页；`generation` 对不上就整条丢弃。
 * @param {PaginationState} state
 * @param {{generation: number, items?: unknown[], hasMore?: unknown, skipped?: unknown, meta?: unknown, full?: unknown, pageSource?: unknown, available?: unknown}} answer 协议层那一页的回执。
 * @param {(item: unknown) => string|null} [keyOf] 去重键：默认按 `id`。
 * @returns {PaginationState}
 */
export function applyPage(state, answer, keyOf = trackIdOf) {
  if (answer?.generation !== state?.generation) return state;

  const incoming = Array.isArray(answer?.items) ? answer.items : [];
  const keys = [...state.keys];
  const seen = new Set(keys);
  const items = [...state.items];
  let duplicates = 0;
  let dropped = 0;

  for (const item of incoming) {
    const key = keyOf(item);
    // 没有键的行进不了列表：去重、跳转、播放队列全都要它（协议层已丢过一次，这里再兜一次）
    if (typeof key !== "string" || key === "") {
      dropped += 1;
      continue;
    }
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    keys.push(key);
    items.push(item);
  }

  const skipped = Number.isInteger(answer?.skipped) ? answer.skipped : 0;
  const source = answer?.pageSource;
  return {
    ...state,
    items,
    keys,
    page: (Number.isInteger(state.page) ? state.page : 0) + 1,
    hasMore: answer?.hasMore === true,
    loading: false,
    error: null,
    duplicates: state.duplicates + duplicates,
    skipped: state.skipped + skipped + dropped,
    armed: false,
    // 歌单元信息只认第一页给的那份（后面几页的 meta 不覆盖这张歌单的身份）
    meta: state.meta ?? answer?.meta ?? null,
    // 整张歌单同理只认第一页：后续页是切片，不该把整表覆盖成空
    full: state.full ?? (Array.isArray(answer?.full) ? answer.full : null),
    // 取数方式只认协议层给出的值（认不出就保留上一次的：绝不自己猜取数来源）
    pageSource:
      source === PAGINATION_SOURCE.localSlice ||
      source === PAGINATION_SOURCE.server ||
      source === PAGINATION_SOURCE.serverRepeat
        ? source
        : state.pageSource,
    available: Number.isInteger(answer?.available) ? answer.available : state.available,
  };
}

/**
 * 记住一次失败：不清空已加载内容，也不自动重试（重试走 `retryPagination`）。
 * @param {PaginationState} state
 * @param {{generation: number, message?: unknown}} answer
 * @returns {PaginationState}
 */
export function applyFailure(state, answer) {
  if (answer?.generation !== state?.generation) return state;
  const message = typeof answer?.message === "string" && answer.message.trim() !== "" ? answer.message : null;
  return {
    ...state,
    loading: false,
    error: message ?? "加载失败（详情见日志）。",
    armed: false,
  };
}

/**
 * 用户点了重试：清掉失败并立刻上膛（同一页，不跳页）。
 * @param {PaginationState} state
 * @returns {PaginationState}
 */
export function retryPagination(state) {
  return { ...state, error: null, loading: false, armed: true };
}

// ---------------------------------------------------------------------------
// 文案（诚实的部分）
// ---------------------------------------------------------------------------

/** `已加载 N 首`——说的是"页面上现在有多少条"，不是"这张歌单有多少首"。 */
export function loadedTracksText(count) {
  const loaded = Number.isInteger(count) && count >= 0 ? count : 0;
  return `已加载 ${loaded} 首`;
}

/**
 * 服务端分页的状态行：还有下一页才催用户滚动。
 * @param {{loaded: number, hasMore: boolean, pageSource?: unknown}} summary
 * @returns {string}
 */
export function paginationNoticeText(summary) {
  const loaded = Number.isInteger(summary?.loaded) && summary.loaded >= 0 ? summary.loaded : 0;
  if (summary?.pageSource === PAGINATION_SOURCE.serverRepeat) {
    return `服务端重复返回同一页，已停止继续加载；已加载 ${loaded} 首。请重新打开歌单后再试。`;
  }
  return summary?.hasMore === true ? `${loadedTracksText(loaded)}，继续向下滚动加载更多。` : loadedTracksText(loaded);
}

// ---------------------------------------------------------------------------
// 本地分批（歌手 / 历史：接口不分页，只本地揭示）
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LocalListState
 * @property {unknown[]} items 那**一次**网络响应的全部条目（原样保存）
 * @property {number} batch 每批揭示多少条
 * @property {number} revealed 现在已经揭示了多少条
 */

/**
 * 本地分批状态：这一次响应最多先揭示 `batch` 条。
 * @param {unknown[]} [items]
 * @param {number} [batch]
 * @returns {LocalListState}
 */
export function createLocalListState(items = [], batch = LOCAL_REVEAL_BATCH) {
  const list = Array.isArray(items) ? items : [];
  const size = Number.isInteger(batch) && batch > 0 ? batch : LOCAL_REVEAL_BATCH;
  return { items: list, batch: size, revealed: Math.min(size, list.length) };
}

/**
 * 再揭示一批（**不发任何请求**：数据早就在手里了）。
 * @param {LocalListState} state
 * @returns {LocalListState}
 */
export function revealMore(state) {
  const total = Array.isArray(state?.items) ? state.items.length : 0;
  const revealed = Number.isInteger(state?.revealed) ? state.revealed : 0;
  const batch = Number.isInteger(state?.batch) && state.batch > 0 ? state.batch : LOCAL_REVEAL_BATCH;
  return { ...state, revealed: Math.min(revealed + batch, total) };
}

/**
 * 现在该渲染哪些（已揭示的那一段）。
 * @param {LocalListState} state
 * @returns {unknown[]}
 */
export function visibleItemsOf(state) {
  const list = Array.isArray(state?.items) ? state.items : [];
  const revealed = Number.isInteger(state?.revealed) ? Math.max(0, state.revealed) : 0;
  return list.slice(0, revealed);
}

/** 还有没揭示完的吗（false = 哨兵可以撤了）。 */
export function hasRevealableItems(state) {
  const total = Array.isArray(state?.items) ? state.items.length : 0;
  const revealed = Number.isInteger(state?.revealed) ? state.revealed : 0;
  return revealed < total;
}

/** 命中里离 `row` 最近的下标（并列取靠前的）；一个都没命中回 -1。 */
function nearestIndex(list, predicate, row) {
  let best = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (!predicate(list[index])) continue;
    if (best === -1 || Math.abs(index - row) < Math.abs(best - row)) best = index;
  }
  return best;
}

/**
 * 双击一行时应放进队列的列表与起始下标：整表已在内存就排整表，否则「下一首」会在本批末尾断掉。
 * @param {unknown[]} items 已显示的那批
 * @param {unknown[]} [queueItems] 整表（缺省 = 只有这一批）
 * @param {unknown} song 被双击的那一行
 * @param {number} rowIndex 它在 `items` 里的下标
 * @returns {{queue: unknown[], index: number}}
 */
export function activationQueueOf(items, queueItems, song, rowIndex) {
  const visible = Array.isArray(items) ? items : [];
  const row = Number.isInteger(rowIndex) && rowIndex >= 0 ? rowIndex : 0;
  const fallback = { queue: visible, index: row };
  if (!Array.isArray(queueItems) || queueItems === visible) return fallback;

  const byIdentity = nearestIndex(queueItems, (entry) => entry === song, row);
  if (byIdentity !== -1) return { queue: queueItems, index: byIdentity };

  const id = trackIdOf(song);
  if (id === null) return fallback;
  const byId = nearestIndex(queueItems, (entry) => trackIdOf(entry) === id, row);
  return byId === -1 ? fallback : { queue: queueItems, index: byId };
}

// ---------------------------------------------------------------------------
// 滚动根
// ---------------------------------------------------------------------------

function defaultComputedStyle(element) {
  const scope = /** @type {any} */ (globalThis);
  return typeof scope.getComputedStyle === "function" ? scope.getComputedStyle(element) : null;
}

/**
 * 找哨兵真正该观察的滚动容器（`IntersectionObserver` 的 `root`）；用真实祖先做 root，`rootMargin` 才真的是「离底」距离。
 * @param {{parentElement?: any}|null} node 哨兵节点
 * @param {(element: any) => ({overflowY?: string}|null)} [getStyle] 计算样式（测试注入）
 * @returns {any} 滚动容器；null = 用视口
 */
export function findScrollRoot(node, getStyle = defaultComputedStyle) {
  let current = node?.parentElement ?? null;
  while (current) {
    let style = null;
    try {
      style = getStyle(current);
    } catch {
      // 脱离文档/被卸载的节点算不出样式：当作没有可滚祖先，不让整页崩在这里
      style = null;
    }
    const overflowY = style?.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return current;
    current = current.parentElement ?? null;
  }
  return null;
}
