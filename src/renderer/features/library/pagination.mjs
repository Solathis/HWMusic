/**
 * 列表触底分页（R45A3）：**纯逻辑**，UI 只消费。
 *
 * 简报第 12 项（"歌曲列表触底加载，不一次加载全部"）的判定全部收在这里，页面只负责
 * 把 `state` 渲染出来、把哨兵交给 IntersectionObserver。为什么非要单列一个模块：
 * 分页里最容易骗人的几件事（"已加载 N 首"被说成"共 N 首"、旧查询的迟到响应覆盖新查询、
 * 失败后自动重试打成请求风暴、短列表自己无限连拉）都不是排版问题，靠肉眼看界面看不出来。
 *
 * ## 两条完全不同的"分页"
 *
 * - **服务端分页**（歌单详情 / 搜索 / 专辑）：接口真的认 `page`/`pageSize`，
 *   一次只取一页，`hasMore` 由协议层给（页面不自己从条数猜）。
 *   走 `createPaginationState` / `beginPage` / `applyPage` / `applyFailure`。
 * - **本地分批**（歌手 / 历史）：接口**本身不分页**，一次响应就是全部。
 *   UI 每批只揭示 50 条，**不重复发网络请求**。走 `createLocalListState` / `revealMore`。
 *
 * 状态行只说"已加载 N 首"（不再解释取数方式）；歌单详情的整表曲目由协议层交到
 * `state.full`，两个动作据此作用于**整张歌单**。
 *
 * ## 不无限连拉
 *
 * `armed` 是那条纪律的唯一实现：一页取完先"卸膛"，**用户再次接近底部**
 * （哨兵先离开触发区 = `markSentinelAway`）才允许取下一页。少了它，
 * 首屏比视口矮的列表会自己把整张歌单拉完——那正是简报禁止的事。
 *
 * ## 竞态
 *
 * 每次查询变化都 `resetPagination`（generation + 1）。迟到的旧响应带着旧 generation
 * 回来，`applyPage` / `applyFailure` 一眼认出并整条丢弃：换关键词之后屏幕上绝不
 * 出现上一个词的结果，也不会被旧失败标红。
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
 *
 * - `"server"`：服务端按 `start`/`limit` 返回了这一页（搜索/专辑，或歌单详情正好整页返回）；
 * - `"local-slice"`：**整张歌单已经随第一页一次取回**，这一页是本地切片（歌单详情的实测形状）；
 * - `"server-repeat"`：服务端重复返回同一页，停止继续请求但不推断歌单总数。
 *
 * 为什么要把这件事带到界面这一层：两种形状对"动作作用于多少曲目"不同——
 * `local-slice` 时整张歌单已在内存（`state.full`），`server` 时只有已加载的那批。
 */
export const PAGINATION_SOURCE = Object.freeze({ server: "server", localSlice: "local-slice", serverRepeat: "server-repeat" });

/**
 * @typedef {object} PaginationState
 * @property {unknown[]} items 已加载的条目（去重后）
 * @property {string[]} keys 已加载条目的去重键（与 items 同序，便于调试/断言）
 * @property {number} page 已经取回的页数（0 = 一页都没取回；下一页 = page + 1）
 * @property {boolean} hasMore 协议层是否明说还有下一页
 * @property {boolean} loading 是否正在请求
 * @property {string|null} error 上一次失败的人话（null = 没失败）
 * @property {number} duplicates 被跨页去重掉的条数
 * @property {number} skipped 被丢弃的坏条目数（没有 id 之类）
 * @property {number} generation 查询代次（换查询就 +1，旧响应据此丢弃）
 * @property {boolean} armed 是否允许再次触发（离开触发区才重新上膛）
 * @property {unknown} meta 第一页附带的信息（歌单详情的歌单元信息），只认第一页
 * @property {unknown[]|null} full 整张列表（协议层确认整份已在内存时才给；只认第一页）
 * @property {string|null} pageSource 这一页的取数方式（`PAGINATION_SOURCE`；`null` = 还没取到）
 * @property {number} available 这一页背后那份响应的条数（本地切片时 = 整张歌单的条数）
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
 * 换查询（换关键词 / 换歌单 / 换专辑 / 切页）：清空列表并换代。
 *
 * 为什么必须清空而不是"合并进新列表"：上一个词的结果留在屏幕上，用户会以为
 * 那就是这次搜的东西。旧响应的丢弃交给 generation（见 `applyPage`）。
 *
 * @param {PaginationState} state
 * @param {number} [generation] 显式指定的新代次（UI 的 ref 是那条真源时用）；
 *   不给就是 `state.generation + 1`。
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
 * 现在能不能发请求：还要观察 + 不在请求中 + 已上膛（用户再次接近底部）。
 *
 * 三条分开看是故意的——它们对应三种不同的"不该发"：没有下一页、正在请求、
 * 刚取完一页还没等用户操作。
 */
export function shouldRequestNext(state) {
  return shouldObserve(state) && state?.loading !== true && state?.armed === true;
}

/**
 * 进入请求态：卸膛（一页只由用户的一次"接近底部"触发）。
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
 * 合并一页。
 *
 * @param {PaginationState} state
 * @param {{generation: number, items?: unknown[], hasMore?: unknown, skipped?: unknown, meta?: unknown,
 *          full?: unknown, pageSource?: unknown, available?: unknown}} answer
 *   协议层那一页的回执；`generation` 是发请求时的那一代（对不上就整条丢弃）。
 * @param {(item: unknown) => string|null} [keyOf] 去重键：默认按 `id`（与协议层同源）；
 *   历史/同类列表传"含播放时间"的键即可保留重复播放语义。
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
 * 记住一次失败：**不清空已加载内容**（把"读不到"变成"列表是空的"比报错更糟），
 * 也**不自动重试**（离线时那是一个请求风暴）。重试按钮走 `retryPagination`。
 *
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
 * 服务端分页的状态行：还有下一页才催用户滚动（走完了还催，就是撒谎）。
 *
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
 * @property {unknown[]} items 那**一次**网络响应的全部条目（原样保存，不改、不重排）
 * @property {number} batch 每批揭示多少条
 * @property {number} revealed 现在已经揭示了多少条
 */

/**
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
 * 双击一行时应放进队列的列表与起始下标：整表已在内存就排整表（否则"下一首"会在
 * 已显示的这批末尾断掉）。行对象可能不是整表里的同一引用（IPC 反序列化），
 * 所以先按身份、再按 id 找；同一首多处出现取离行号最近的那个。
 *
 * @param {unknown[]} items 已显示的那批
 * @param {unknown[]} [queueItems] 整表（缺省 = 只有这一批是已知的）
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
 * 找哨兵真正该观察的滚动容器（`IntersectionObserver` 的 `root`）。
 *
 * 为什么不是"页面自己再造一个 `overflow-y-auto`"：
 * - 内容区那一层（`App.tsx` 的页面落点）本来就是全应用唯一的页面级滚动根，
 *   页面里再套一层会让"滚到底"分成两级（外层先滚完、内层才开始），
 *   也会被 `no-self-visual` 的例外集合抓住（那里写死了"只有 App 与收藏页"）；
 * - 而且用真实祖先做 root，`rootMargin` 的 240px 才真的是"离底 240px"。
 *
 * @param {{parentElement?: any}|null} node 哨兵节点
 * @param {(element: any) => ({overflowY?: string}|null)} [getStyle] 计算样式（测试注入）
 * @returns {any} 滚动容器；null = 没有可滚祖先，用视口（`root: null` 的官方语义）
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
