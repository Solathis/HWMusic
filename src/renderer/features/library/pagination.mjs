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
 *   UI 每批只揭示 50 条，**不重复发网络请求**——所以文案必须明说
 *   "后端一次返回 N 首（1 次网络请求）"，**不许**说"分批减少流量"
 *   （字节一个都没少，那是假话）。走 `createLocalListState` / `revealMore`。
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
/** 歌单详情「整表响应 → 本地切片」那句说明的锚点（browser 守卫按它读文案）。 */
export const PLAYLIST_SLICE_NOTICE_TESTID = "playlist-local-slice";

/**
 * 协议层对这一页的取数方式（`null` = 还没取到任何一页）。
 *
 * - `"server"`：服务端按 `start`/`limit` 返回了这一页（搜索/专辑，或歌单详情正好整页返回）；
 * - `"local-slice"`：**整张歌单已经随第一页一次取回**，这一页是本地切片（歌单详情的实测形状）；
 * - `"server-repeat"`：服务端重复返回同一页，停止继续请求但不推断歌单总数。
 *
 * 为什么要把这件事带到界面这一层：这两种形状对用户的意义不同（前者"还在取"，
 * 后者"整份已经下载过，滚动只是显示更多"）。文案不许把后者说成"省流量"——字节一个都没少。
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
 *          pageSource?: unknown, available?: unknown}} answer
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

/** `已加载 N 首`——歌单详情的动作按钮只作用于这批曲目，所以这句话必须说。 */
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

/**
 * 本地分批（歌手 / 历史）的状态行。
 *
 * 两句话都是必须的：
 * - "后端一次返回 N 首" —— 这个接口**不分页**，用户有权知道这不是完整翻页；
 * - "1 次网络请求 / 不减少流量" —— 分批显示只是渲染策略，**字节一个都没少**，
 *   不许把它说成"减少流量"（那是假话，也是本简报点名的边界）。
 *
 * @param {{items: unknown[], revealed: number}} state
 * @returns {string}
 */
export function localRevealNoticeText(state) {
  const total = Array.isArray(state?.items) ? state.items.length : 0;
  const revealed = Number.isInteger(state?.revealed) ? Math.min(state.revealed, total) : 0;
  return `后端一次返回 ${total} 首（1 次网络请求，分批显示不减少流量），已显示 ${revealed} 首。`;
}

/**
 * 歌单详情「整表响应 → 本地切片」的说明（R45A3 fix1）。
 *
 * 事实（2026-10-23 真机只读取证）：`library:playlist-detail` 请求 `pageSize=50`，服务端一次回了
 * **整张歌单的全部条目**——它不认 `start`/`limit`。于是界面上的"第 2 页 / 第 3 页"是**本地切片**，
 * 不是网络分页。这句话必须同时说清三件事，少一件就会误导：
 *
 * 1. **服务端的行为**：整张一次取回（不是"每次只取一页"）；
 * 2. **滚动做了什么事**：本地切片，**不再发网络请求**（这是承诺，也是事实）；
 * 3. **滚动没做什么事**：**不减少流量**——整份早就下载完了，把"分批显示"说成"省流量/省内存"
 *    是假话（简报点名的边界）。
 *
 * `source` 只认协议层给的那两个值：服务端真的按页给（`"server"`）时没有这句话，两种形状不许混成一句。
 * 条数不明（`available` 不是正整数）时**不编数字**，只说"整张歌单"。
 *
 * @param {{source?: unknown, available?: unknown, loaded?: unknown}} [summary]
 * @returns {string|null} 该说的话；`null` = 这一页不是本地切片，不必说
 */
export function playlistLocalSliceNoticeText(summary) {
  if (summary?.source !== PAGINATION_SOURCE.localSlice) return null;
  const loaded = Number.isInteger(summary?.loaded) && summary.loaded >= 0 ? summary.loaded : 0;
  const available = Number.isInteger(summary?.available) && summary.available > 0 ? summary.available : null;
  const whole = available === null ? "服务端一次返回整张歌单（条数未给出）" : `服务端一次返回整张歌单（${available} 首）`;
  return `${whole}：滚动只是本地切片，不再发网络请求，也不减少流量（整份已经下载过）。已显示 ${loaded} 首。`;
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
