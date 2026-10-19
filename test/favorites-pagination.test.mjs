/**
 * R8 收藏页 · 分页合并与滚动位置记忆（纯逻辑，UI 只消费）。
 *
 * 钉的是收藏语义里最容易骗人的两条（旧仓踩过）：
 * 1. **"已加载 N 首"与"共 M 首"是两件事**：总数只有完整分页走完（去重后）才有值，
 *    没走完就必须是 null —— 提前写"共 50 首"就是把一页说成了全部；
 * 2. **接口上报的 total 不可信**：它只作记录，永远不参与 UI 数字。
 *
 * 另外两条工程约束：失败不清空已加载内容（回退到"收藏是空的"比报错更糟），
 * 以及失败后不自动重试（否则离线时就是一个请求风暴）——重试要么用户点、要么切页回来。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FAVORITES_LOADING_TEXT,
  FAVORITES_PAGE_SIZE,
  createFavoritesState,
  createScrollMemory,
  describeFavoritesCounts,
  favoritesSummary,
  isFavoritesInitialLoad,
  markFavoritesFailure,
  markFavoritesLoading,
  mergeFavoritesPage,
  nextFavoritesPage,
  shouldLoadNextFavoritesPage,
} from "../src/renderer/features/library/favorites-pagination.mjs";

const song = (id, extra = {}) => ({ id, name: `歌${id}`, ...extra });
const page = (songs, extra = {}) => ({ page: 1, pageSize: FAVORITES_PAGE_SIZE, songs, skipped: 0, reportedTotal: null, hasMore: true, ...extra });

test("分页合并：跨页按 id 去重，已加载数只数真实歌曲", () => {
  let state = createFavoritesState();
  assert.deepEqual(favoritesSummary(state), {
    loadedCount: 0,
    total: null,
    isComplete: false,
    skipped: 0,
    pages: 0,
    loading: false,
    failure: null,
    hasSongs: false,
  });

  state = mergeFavoritesPage(state, page([song("a"), song("b")]));
  assert.equal(state.loadedCount, 2);
  assert.equal(state.pages, 1);
  assert.equal(state.songs.map((item) => item.id).join(","), "a,b");

  // 第二页与第一页有重复（分页期间列表变了就会这样）：重复条目不许让"已加载"虚高
  state = mergeFavoritesPage(state, page([song("b"), song("c")]));
  assert.equal(state.loadedCount, 3);
  assert.equal(state.duplicates, 1);
  assert.deepEqual(state.songs.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(state.pages, 2, "页数按实际取回的页算，不按去重后的条数算");
});

test("总数语义：没走完分页就是 null（不许把一页说成全部），走完才冻结去重总数", () => {
  let state = createFavoritesState();
  state = mergeFavoritesPage(state, page([song("a"), song("b")], { hasMore: true, reportedTotal: 999 }));

  assert.equal(favoritesSummary(state).total, null, "还有下一页 → 总数未知");
  assert.equal(state.reportedTotal, 999, "接口上报的 total 只作记录");
  assert.equal(
    describeFavoritesCounts(favoritesSummary(state)),
    "已加载 2 首",
    "总数未知时只显示已加载数，绝不显示接口上报的那个数",
  );

  state = mergeFavoritesPage(state, page([song("c")], { hasMore: false }));
  assert.equal(state.isComplete, true);
  assert.equal(state.stopReason, "exhausted");
  assert.equal(favoritesSummary(state).total, 3, "总数 = 完整分页后的 ID 去重数");
  assert.equal(describeFavoritesCounts(favoritesSummary(state)), "共 3 首（已加载 3 首）");

  // 走完之后再来一页（理论上不该发生）：不得改动总数
  const frozen = mergeFavoritesPage(state, page([song("d")], { hasMore: true }));
  assert.equal(frozen.loadedCount, 3, "走完之后不该再收页面（UI 侧也不该再请求）");
});

test("总数语义：短页即到底；无 ID 条目被计入 skipped 而不进列表", () => {
  let state = createFavoritesState();
  state = mergeFavoritesPage(state, page([song("a")], { hasMore: false, skipped: 2 }));
  assert.equal(state.isComplete, true);
  assert.equal(favoritesSummary(state).total, 1);
  assert.equal(state.skipped, 2, "被丢弃的条目数如实累计（它解释了「为什么列表比接口说过的少」）");
});

test("加载门：加载中/已完成/上次失败都不再自动请求（失败不自动重试，避免离线时打请求风暴）", () => {
  let state = createFavoritesState();
  assert.equal(shouldLoadNextFavoritesPage(state), true, "初始就该取第一页");
  assert.equal(nextFavoritesPage(state), 1);

  state = markFavoritesLoading(state, true);
  assert.equal(state.loading, true);
  assert.equal(shouldLoadNextFavoritesPage(state), false, "加载中不许重复发起");

  state = mergeFavoritesPage(markFavoritesLoading(state, false), page([song("a")], { hasMore: false }));
  assert.equal(shouldLoadNextFavoritesPage(state), false, "已完成就不再请求");
  assert.equal(nextFavoritesPage(state), 2, "页号仍然如实递增（重试用）");

  const failed = markFavoritesFailure(createFavoritesState(), "接口尚未配置（待联调确认）。");
  assert.equal(failed.loading, false);
  assert.equal(failed.failure, "接口尚未配置（待联调确认）。");
  assert.equal(failed.stopReason, "error");
  assert.equal(shouldLoadNextFavoritesPage(failed), false, "失败后不自动重试");

  const retried = markFavoritesLoading(createFavoritesState(), false);
  assert.equal(shouldLoadNextFavoritesPage(retried), true, "重新创建/清空失败态后可以再试");
});

test("失败不清空已加载内容：出错时保留歌曲，只是标上原因", () => {
  let state = mergeFavoritesPage(createFavoritesState(), page([song("a"), song("b")]));
  state = markFavoritesFailure(state, "加载失败：网络不可达");
  assert.equal(state.songs.length, 2, "回退到「收藏是空的」比报错更糟");
  assert.equal(state.failure, "加载失败：网络不可达");
  assert.equal(favoritesSummary(state).hasSongs, true);
  assert.equal(describeFavoritesCounts(favoritesSummary(state)), "已加载 2 首");
});

test("首屏：还没取回任何一页且没失败 = 「首次加载」（此时不许显示「还没有收藏」，那是假空态）", () => {
  const fresh = createFavoritesState();
  assert.equal(isFavoritesInitialLoad(fresh), true);

  // 取回一页（哪怕是空的）之后就不再是"首次加载"：此时空列表是真的空
  const empty = mergeFavoritesPage(fresh, page([], { hasMore: false }));
  assert.equal(isFavoritesInitialLoad(empty), false);
  assert.equal(favoritesSummary(empty).hasSongs, false);

  // 失败也不是"首次加载"：失败有自己的说法（"接口未配置"），不能跟空态混
  assert.equal(isFavoritesInitialLoad(markFavoritesFailure(createFavoritesState(), "接口尚未配置（待联调确认）。")), false);
});

test("计数文案：首次加载期间不显示「已加载 0 首」（那看起来像「你什么都没有」）", () => {
  assert.equal(isFavoritesInitialLoad(createFavoritesState()), true);
  assert.match(FAVORITES_LOADING_TEXT, /加载/);
  assert.doesNotMatch(FAVORITES_LOADING_TEXT, /0 首|还没有/);
});

test("纯函数：合并不改写入参（React 的 state 不可变）", () => {
  const before = createFavoritesState();
  const snapshot = JSON.stringify({ ...before, songs: [], seen: [] });
  mergeFavoritesPage(before, page([song("a")]));
  assert.equal(before.loadedCount, 0);
  assert.equal(before.songs.length, 0);
  assert.equal(JSON.stringify({ ...before, songs: [], seen: [] }), snapshot);
});

test("滚动位置记忆：按视图键分开记、非法值归零，切页回来还能回到原处", () => {
  const memory = createScrollMemory();
  assert.equal(memory.offsetFor("favorites"), 0, "没记过就是 0（新页面从头开始）");

  memory.remember("favorites", 1234);
  memory.remember("playlist-detail?playlistId=P1", 88);
  assert.equal(memory.offsetFor("favorites"), 1234);
  assert.equal(memory.offsetFor("playlist-detail?playlistId=P1"), 88, "不同视图各记各的");

  memory.remember("favorites", Number.NaN);
  assert.equal(memory.offsetFor("favorites"), 1234, "坏值不覆盖好值");

  memory.remember("favorites", -20);
  assert.equal(memory.offsetFor("favorites"), 0, "负偏移归零");

  memory.remember("favorites", 999);
  memory.forget("favorites");
  assert.equal(memory.offsetFor("favorites"), 0, "忘记之后回到 0（例如列表被重新加载过）");
});
