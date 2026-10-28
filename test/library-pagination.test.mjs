/**
 * 列表触底分页 · 纯逻辑（features/library/pagination.mjs）+ 页面接线（源码扫描）。
 *
 * 钉的是“看起来在分页、其实在撒谎”的事：合并只追加并按 id 去重；一次请求只取一页，
 * 每页完成后必须等用户再次接近底部（armed）；失败可重试但不自动重试；换查询/切页后
 * 旧响应按 generation 丢掉；无 hasMore 不再观察；滚动根是应用内容区那一层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LOCAL_REVEAL_BATCH,
  PAGINATION_PAGE_SIZE,
  PAGINATION_ROOT_MARGIN_PX,
  PAGINATION_ROOT_MARGIN,
  PAGINATION_SENTINEL_TESTID,
  PAGINATION_SOURCE,
  activationQueueOf,
  applyFailure,
  applyPage,
  beginPage,
  createLocalListState,
  createPaginationState,
  findScrollRoot,
  hasRevealableItems,
  isInitialPaging,
  loadedTracksText,
  markSentinelAway,
  nextPageOf,
  paginationNoticeText,
  resetPagination,
  retryPagination,
  revealMore,
  shouldObserve,
  shouldRequestNext,
  visibleItemsOf,
} from "../src/renderer/features/library/pagination.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const song = (id, extra = {}) => ({ id, name: `歌${id}`, ...extra });
const answer = (generation, items, extra = {}) => ({ generation, items, hasMore: false, skipped: 0, ...extra });

// ---------------------------------------------------------------------------
// 1. 合并 / 去重 / 页号
// ---------------------------------------------------------------------------

test("分页合并：只追加，按 id 去重，页号按真实取回的页递增", () => {
  let state = createPaginationState();
  assert.deepEqual(state.items, []);
  assert.equal(state.page, 0, "一页都没取回时页号是 0（第一页要取的页号是 1）");
  assert.equal(state.hasMore, true, "协议层还没说不分页 → 可以继续");
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.equal(nextPageOf(state), 1);

  state = beginPage(state);
  assert.equal(state.loading, true, "发起请求即进入加载态（按钮/哨兵都据此闭嘴）");

  state = applyPage(state, answer(state.generation, [song("a"), song("b")], { hasMore: true }));
  assert.deepEqual(state.items.map((item) => item.id), ["a", "b"]);
  assert.equal(state.page, 1);
  assert.equal(state.loading, false);
  assert.equal(state.hasMore, true);

  // 第二页与第一页有重叠（分页期间列表变了就会这样）：重复条目不许让"已加载"虚高
  state = beginPage(state);
  state = applyPage(state, answer(state.generation, [song("b"), song("c")], { hasMore: false }));
  assert.deepEqual(state.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(state.duplicates, 1);
  assert.equal(state.page, 2, "页数按真实取回的页算，不按去重后的条数算");
  assert.equal(state.hasMore, false);
});

test("分页合并：没有 id 的行不进列表（去重与跳转都要它），只计入 skipped", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, [song("a"), { name: "没有 id" }, null], { skipped: 1 }));
  assert.deepEqual(state.items.map((item) => item.id), ["a"]);
  assert.equal(state.skipped, 3, "协议层丢的 1 + 这里兜住的 2，都如实累计");
});

test("分页合并：重复播放历史由页面传入 key 决定（默认按 id 去重，历史可以保留重复）", () => {
  const history = [
    { id: "a", playedAt: 1 },
    { id: "a", playedAt: 2 },
  ];
  // 默认 key=id：第二条被当成重复（歌单/搜索/专辑正确）
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, history));
  assert.equal(state.items.length, 1);
  assert.equal(state.duplicates, 1);

  // 页面给 key（含播放时间）：同一次播放的两条记录都保留 = 历史语义
  let paged = createPaginationState();
  paged = applyPage(paged, answer(paged.generation, history), (item) => `${item.id}@${item.playedAt}`);
  assert.equal(paged.items.length, 2, "历史里的重复条目必须保留（那是真的播放了两次）");
  assert.equal(paged.duplicates, 0);
});

test("分页状态：meta 只认第一页给的那份（后续页不覆盖歌单元信息）", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, [song("a")], { hasMore: true, meta: { name: "晨跑", songCount: 1623 } }));
  assert.deepEqual(state.meta, { name: "晨跑", songCount: 1623 });
  state = applyPage(state, answer(state.generation, [song("b")], { hasMore: false, meta: { name: "另一个名字" } }));
  assert.equal(state.meta.name, "晨跑", "第一页的歌单元信息才是这张歌单的身份");
});

// ---------------------------------------------------------------------------
// 2. 门：正在请求 / 每页一次 / 无更多
// ---------------------------------------------------------------------------

test("加载门：正在请求不重复发；每页完成后要等用户再次接近底部（不无限连拉）", () => {
  let state = createPaginationState();
  assert.equal(shouldRequestNext(state), true, "初始就该取第一页");

  state = beginPage(state);
  assert.equal(shouldRequestNext(state), false, "正在请求时第二次触发必须被吞掉");

  state = applyPage(state, answer(state.generation, [song("a")], { hasMore: true }));
  assert.equal(
    shouldRequestNext(state),
    false,
    "刚取完一页：用户还没再次接近底部，不许自动连拉第 3 页",
  );
  state = markSentinelAway(state);
  assert.equal(shouldRequestNext(state), true, "离开触发区 = 重新上膛，下一次接近底部才取下一页");
  assert.equal(nextPageOf(state), 2);
});

test("无更多：hasMore=false 之后不再观察哨兵，也不再自动请求", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, [song("a")], { hasMore: false }));
  assert.equal(shouldObserve(state), false, "协议层说没有下一页了 → 哨兵不挂、不观察");
  assert.equal(shouldRequestNext(markSentinelAway(state)), false);
});

test("失败：不清空已加载内容、不自动重试；用户点重试才放行", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, [song("a"), song("b")], { hasMore: true }));
  state = beginPage(state);
  state = applyFailure(state, { generation: state.generation, message: "加载失败：网络不可达" });

  assert.equal(state.loading, false);
  assert.equal(state.error, "加载失败：网络不可达");
  assert.equal(state.items.length, 2, "回退到「列表是空的」比报错更糟");
  assert.equal(shouldObserve(state), false, "失败时不观察：否则离线时就是请求风暴");
  assert.equal(shouldRequestNext(state), false);

  state = retryPagination(state);
  assert.equal(state.error, null);
  assert.equal(shouldRequestNext(state), true, "用户点了重试 → 立刻放行同一页");
  assert.equal(nextPageOf(state), 2, "失败的是第 2 页，重试还是第 2 页");

  // 失败文案缺省也要有话说（绝不显示空错误条）
  const blank = applyFailure(createPaginationState(), { generation: 0, message: "   " });
  assert.match(blank.error, /加载失败/);
});

// ---------------------------------------------------------------------------
// 3. 竞态：旧查询的迟到响应必须丢掉
// ---------------------------------------------------------------------------

test("查询切换：重置清空列表并递增 generation，旧查询的迟到响应一律丢弃", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(state.generation, [song("a")], { hasMore: true }));
  const staleGeneration = state.generation;

  const reset = resetPagination(state);
  assert.equal(reset.generation, staleGeneration + 1, "换代：旧响应从此认不出来");
  assert.deepEqual(reset.items, [], "换关键词后列表必须清空（不能把上一个词的结果留在屏幕上）");
  assert.equal(reset.page, 0);
  assert.equal(reset.hasMore, true);
  assert.equal(reset.error, null);

  // 旧查询的响应现在才回来：一个字都不许落到新查询的列表里
  const late = applyPage(reset, answer(staleGeneration, [song("old-1"), song("old-2")], { hasMore: true }));
  assert.deepEqual(late.items, [], "旧 generation 的响应被丢弃");
  assert.equal(late.page, 0, "页号也不推进");

  const lateFailure = applyFailure(reset, { generation: staleGeneration, message: "旧的失败" });
  assert.equal(lateFailure.error, null, "旧查询的失败不许把新查询标成失败");
});

// ---------------------------------------------------------------------------
// 4. 首屏：页号 0 且没失败 = 首屏加载（不许显示假空态）
// ---------------------------------------------------------------------------

test("首屏：还没取回任何一页且没失败 = 首屏加载中（此时不能显示「查无所获」那种假空态）", () => {
  assert.equal(isInitialPaging(createPaginationState()), true);
  assert.equal(isInitialPaging(applyPage(createPaginationState(), answer(0, [], { hasMore: false }))), false, "取回空页之后空列表是真的空");
  assert.equal(isInitialPaging(applyFailure(createPaginationState(), { generation: 0, message: "x" })), false);
});

// ---------------------------------------------------------------------------
// 5. 文案：已加载 N 首 / 继续滚动 / 本地分批的诚实说明
// ---------------------------------------------------------------------------

test("文案：服务端分页说「已加载 N 首」，走完了不再催用户滚动", () => {
  assert.equal(loadedTracksText(0), "已加载 0 首");
  assert.equal(loadedTracksText(120), "已加载 120 首");

  const more = paginationNoticeText({ loaded: 50, hasMore: true });
  assert.match(more, /已加载 50 首/);
  assert.match(more, /继续向下滚动/);

  const done = paginationNoticeText({ loaded: 50, hasMore: false });
  assert.match(done, /已加载 50 首/);
  assert.doesNotMatch(done, /继续向下滚动/, "已经没有下一页了还让人滚，就是撒谎");
});

/**
 * 三句说明性文案（“只加载了前 N 首”等）不再显示，删的是整条路径：
 * 函数、常量、渲染、锚点一起走，不留死代码。
 */
test("R55：三句说明文案连同函数/常量/渲染/锚点一起删掉（不留死代码）", () => {
  const paginationSource = read("src/renderer/features/library/pagination.mjs");
  for (const gone of ["localRevealNoticeText", "playlistLocalSliceNoticeText", "PLAYLIST_SLICE_NOTICE_TESTID"]) {
    assert.ok(!paginationSource.includes(gone), `pagination.mjs 不该再有 ${gone}`);
  }
  assert.ok(
    !read("src/renderer/features/library/playlist-fields.mjs").includes("playlistPartialNoticeText"),
    "playlist-fields.mjs 不该再有 playlistPartialNoticeText",
  );

  const pages = read("src/renderer/pages.tsx");
  for (const gone of ["这一页只加载了", "服务端一次返回整张歌单", "后端一次返回", "不再发网络请求", "不减少流量", "已显示 "]) {
    assert.ok(!pages.includes(gone), `页面不该再出现「${gone}」`);
  }
});

// ---------------------------------------------------------------------------
// 6. 本地分批（歌手 / 历史）
// ---------------------------------------------------------------------------

test("本地分批：一次响应分批揭示，每批 50，不改入参、不新增网络请求", () => {
  assert.equal(LOCAL_REVEAL_BATCH, 50);
  assert.equal(PAGINATION_PAGE_SIZE, 50, "服务端分页也按 50 取（与协议层默认一致）");

  const items = Array.from({ length: 120 }, (_, index) => song(`s${index + 1}`));
  let state = createLocalListState(items);
  assert.equal(visibleItemsOf(state).length, 50, "首屏只显示第一批");
  assert.equal(hasRevealableItems(state), true);

  state = revealMore(state);
  assert.equal(visibleItemsOf(state).length, 100);
  state = revealMore(state);
  assert.equal(visibleItemsOf(state).length, 120, "最后一批不足 50 也照实显示完");
  assert.equal(hasRevealableItems(state), false, "全部揭示之后不再观察哨兵");

  assert.equal(items.length, 120, "纯函数：入参不被修改");
  assert.deepEqual(visibleItemsOf(createLocalListState([])), []);
  assert.equal(hasRevealableItems(createLocalListState([])), false);
  assert.equal(visibleItemsOf(createLocalListState(items)).length, 50, "不足一批时整批显示");
});

// ---------------------------------------------------------------------------
// 7. 滚动根：应用内容区那一层，不是页面自己再造一个
// ---------------------------------------------------------------------------

test("滚动根：从哨兵往上找真正的 overflow-y:auto/scroll 祖先（视口回落为 null）", () => {
  /** styles[0] = 哨兵的父亲，依次向外（真实 DOM 的形状）。 */
  const sentinelOver = (styles) => {
    const ancestors = styles.map((style) => ({ style, parentElement: null }));
    ancestors.forEach((node, index) => {
      node.parentElement = ancestors[index + 1] ?? null;
    });
    return { parentElement: ancestors[0] ?? null, style: { overflowY: "visible" } };
  };
  const getStyle = (node) => node.style;

  const contentRoot = { overflowY: "auto" };
  // 由近及远：可见的包装层 → hidden 的布局层（内容区外层）→ 内容区滚动根 → 更外面的 auto
  const sentinel = sentinelOver([{ overflowY: "visible" }, { overflowY: "hidden" }, contentRoot, { overflowY: "auto" }]);
  // 它自己不是滚动容器，往上第一个 auto 就是内容区那一层（而不是更外面那个）
  assert.equal(findScrollRoot(sentinel, getStyle).style, contentRoot);

  assert.equal(
    findScrollRoot(sentinelOver([{ overflowY: "visible" }, { overflowY: "hidden" }]), getStyle),
    null,
    "没有可滚祖先 → null = 视口（IntersectionObserver 的 root:null 语义）",
  );
  assert.equal(findScrollRoot(null, getStyle), null, "没有哨兵就没有根");
  assert.equal(
    findScrollRoot(sentinelOver([{ overflowY: "scroll" }]), getStyle)?.style.overflowY,
    "scroll",
    "overflow-y:scroll 同样是滚动容器",
  );
  assert.equal(
    findScrollRoot(sentinelOver([{ overflowY: "visible" }, { overflowY: "overlay" }]), getStyle)?.style.overflowY,
    "overlay",
  );
  // 计算样式可能抛（脱离文档的节点）：不许把整页打崩
  assert.equal(findScrollRoot(sentinelOver([{ overflowY: "auto" }]), () => { throw new Error("boom"); }), null);

  assert.equal(PAGINATION_ROOT_MARGIN_PX, 240, "哨兵进入前 240px 就取下一页（提前量，不是到最底才转圈）");
  assert.equal(PAGINATION_ROOT_MARGIN, "240px", "rootMargin 的字符串形态只有一处真源");
  assert.equal(PAGINATION_SENTINEL_TESTID, "list-pagination-sentinel", "哨兵锚点是契约（browser 守卫与源码扫描都认它）");
});

/**
 * 整张歌单已在内存（pageSource="local-slice"）时页面拿得到整表：
 * 「播放全部」「加入队列」因此作用于整张歌单，不是已渲染的 50 首。
 */
test("R55：整表已在内存时状态记住整张歌单，动作不再只作用于已渲染的 50 首", () => {
  const items = Array.from({ length: 120 }, (_value, index) => song(`s${index + 1}`));
  let state = applyPage(createPaginationState(), answer(0, items.slice(0, 50), {
    hasMore: true,
    pageSource: PAGINATION_SOURCE.localSlice,
    available: 120,
    full: items,
  }));
  assert.equal(state.full.length, 120, "整表在状态里（页面拿它做动作）");
  assert.equal(state.items.length, 50, "渲染仍然只有已加载的那一页");

  // 后续页的响应不带整表：整表只认第一页那份，不许被后一页覆盖成 null
  state = applyPage(state, answer(state.generation, items.slice(50, 100), {
    hasMore: true,
    pageSource: PAGINATION_SOURCE.localSlice,
    available: 120,
  }));
  assert.equal(state.full.length, 120);
  assert.equal(state.items.length, 100);

  // 换查询：整表跟着清空（下一张歌单不能继承上一张的曲目）
  const reset = resetPagination(state);
  assert.equal(reset.full, null);

  // 服务端真分页（不是整表响应）：没有整表可给，动作退回已加载的那批
  const server = applyPage(createPaginationState(), answer(0, items.slice(0, 50), {
    hasMore: true,
    pageSource: PAGINATION_SOURCE.server,
    available: 50,
  }));
  assert.equal(server.full, null);
});

/**
 * 双击行的队列基准要与「播放全部」一致：整表在内存时双击第 3 行排出整张表，
 * 当前曲目指向第 3 行。
 */
test("R55 修订：双击行的队列取整表，行号在整表里的位置按身份/id 找回", () => {
  const full = Array.from({ length: 120 }, (_value, index) => song(`s${index + 1}`));
  const items = full.slice(0, 50);

  // ① 同一个数组 / 没给整表：整表就是这一批，行号即下标
  assert.deepEqual(activationQueueOf(items, items, items[2], 2), { queue: items, index: 2 });
  assert.deepEqual(activationQueueOf(items, undefined, items[2], 2), { queue: items, index: 2 });
  assert.deepEqual(activationQueueOf(items, null, items[2], 2), { queue: items, index: 2 });

  // ② 对象身份命中：items 是整表的切片（同一批对象），行号要换算成整表下标
  const byIdentity = activationQueueOf(items, full, items[2], 2);
  assert.equal(byIdentity.queue, full, "队列用整张表（不是已显示的 50 首）");
  assert.equal(byIdentity.index, 2);

  // ③ 身份不同但 id 相同（IPC 反序列化后是另一批对象）：按 trackIdOf 找回
  const copies = items.map((item) => ({ ...item }));
  const byId = activationQueueOf(copies, full, copies[2], 2);
  assert.equal(byId.queue, full);
  assert.equal(byId.index, 2, "同一首在整表里的真实位置");

  // ④ 同一首出现多次：取离行号最近的那一个（历史里重复条目是有意义的）
  const repeated = full.map((item) => ({ ...item }));
  repeated[40] = { ...full[5] };
  const near = activationQueueOf(repeated.slice(0, 50), repeated, { ...repeated[5] }, 45);
  assert.equal(near.queue, repeated);
  assert.equal(near.index, 40, "同一 id 两处：取离行号最近的那一个");
  assert.equal(activationQueueOf(repeated.slice(0, 50), repeated, { ...repeated[5] }, 5).index, 5);
  // 身份命中出现两次时同样取近的
  const twice = [...full.slice(0, 50), full[5]];
  assert.equal(activationQueueOf(full.slice(0, 50), twice, full[5], 5).index, 5);

  // ⑤ 找不到（或 id 为空）：退回已显示的那批 + 行号
  const stranger = song("不在表里");
  assert.deepEqual(activationQueueOf(items, full, stranger, 2), { queue: items, index: 2 });
  assert.deepEqual(activationQueueOf(items, full, { name: "没有 id" }, 3), { queue: items, index: 3 });
  assert.deepEqual(activationQueueOf(items, full, null, 4), { queue: items, index: 4 });
});

test("R55 修订：整表来源接线（歌单详情/历史/歌手）传 queueItems，收藏与搜索不传", () => {
  const source = read("src/renderer/pages.tsx");
  const detail = source.slice(source.indexOf("export function PlaylistDetailPage"), source.indexOf("// 搜索：结果"));
  const artist = source.slice(source.indexOf("export function ArtistPage"), source.indexOf("export function HistoryPage"));
  const history = source.slice(source.indexOf("export function HistoryPage"), source.indexOf("// 设置（R10）"));
  const search = source.slice(source.indexOf("export function SearchPage"), source.indexOf("// 专辑 / 歌手 / 播放历史"));

  assert.match(source, /queueItems\?: unknown\[\]|queueItems\?: unknown\[\] \| undefined/, "BrowsableTrackList 有可选 queueItems");
  assert.match(source, /activationQueueOf\(/, "双击行的队列由纯函数算");
  assert.match(detail, /queueItems=\{state\.full \?\? undefined\}/, "歌单详情传整表");
  for (const [name, slice] of [["历史页", history], ["歌手页", artist]]) {
    assert.match(slice, /queueItems=\{resource\.data/, `${name}整份已在内存，传整表`);
  }
  assert.doesNotMatch(search, /queueItems=/, "搜索是服务端真分页：只有已加载的那批是已知的");
});

test("R45A fix4：server-repeat 留在分页状态，并显示停止原因但不编总数", () => {
  let state = createPaginationState();
  state = applyPage(state, answer(0, Array.from({ length: 50 }, (_value, index) => song(`s${index + 1}`)), {
    hasMore: true,
    pageSource: PAGINATION_SOURCE.server,
    available: 50,
  }));
  state = applyPage(state, answer(state.generation, [], {
    hasMore: false,
    pageSource: PAGINATION_SOURCE.serverRepeat,
    available: 50,
  }));

  assert.equal(state.pageSource, "server-repeat");
  assert.equal(state.hasMore, false);
  assert.equal(shouldObserve(state), false, "停止后不再观察哨兵");
  assert.equal(state.available, 50, "available 只保留响应条数，不作为总数显示");
  const notice = paginationNoticeText({ loaded: state.items.length, hasMore: state.hasMore, pageSource: state.pageSource });
  assert.match(notice, /服务端重复返回同一页/);
  assert.match(notice, /已停止继续加载/);
  assert.match(notice, /重新打开歌单/);
  assert.doesNotMatch(notice, /共\s*50\s*首|到底了|全部加载/);

  const page = read("src/renderer/pages.tsx");
  const detail = page.slice(page.indexOf("export function PlaylistDetailPage"), page.indexOf("// 搜索：结果"));
  assert.match(detail, /pageSource:\s*state\.pageSource/, "歌单详情把分页来源传入状态文案");
  assert.match(detail, /state\.pageSource\s*===\s*PAGINATION_SOURCE\.serverRepeat\s*\?\s*null\s*:\s*state\.meta/,
    "服务端重复停止时隐藏未经验证的歌单总数");
  assert.match(detail, /pageSource:\s*state\.pageSource/, "停止状态来自协议层，而非按页数猜测");
});

test("分页状态：pageSource / available 跟着协议层那一页走（本地切片与网络分页要分得开）", () => {
  let state = createPaginationState();
  assert.equal(state.pageSource, null, "还没取到任何一页：没有取数方式可谈");
  assert.equal(state.available, 0);

  state = applyPage(state, answer(state.generation, [song("a")], { hasMore: true, pageSource: "local-slice", available: 120 }));
  assert.equal(state.pageSource, "local-slice");
  assert.equal(state.available, 120, "整份响应的条数记在这里（文案与'还有多少'都靠它）");

  // 换查询就清空（不许把上一张歌单的取数方式留在下一张上）
  const reset = resetPagination(state);
  assert.equal(reset.pageSource, null);
  assert.equal(reset.available, 0);

  // 服务端分页那一页：pageSource=server，available = 这一页给到的条数
  const server = applyPage(createPaginationState(), answer(0, [song("a")], { hasMore: true, pageSource: "server", available: 1 }));
  assert.equal(server.pageSource, "server");
});

test("页面接线：歌单详情的动作作用于整张歌单（整表来自协议层，不从页数猜）", () => {
  const source = read("src/renderer/pages.tsx");
  const detail = source.slice(source.indexOf("export function PlaylistDetailPage"), source.indexOf("// 搜索：结果"));
  assert.ok(detail.length > 0, "要能在 pages.tsx 里找到 PlaylistDetailPage");

  assert.match(source, /state\.pageSource/, "取数方式从分页状态读（不是页面自己猜的）");
  assert.match(source, /pageSource: payload\.pageSource/, "pageAnswerOf 把协议层的 pageSource 传下去");
  assert.match(source, /Array\.isArray\(payload\.fullSongs\)/, "pageAnswerOf 把协议层交出的整表传下去");
  assert.match(detail, /state\.full/, "整表从分页状态读（协议层确认整份已在内存时才有）");
  for (const label of ["PLAYLIST_PLAY_ALL_LABEL", "PLAYLIST_ENQUEUE_LABEL"]) {
    assert.match(detail, new RegExp(`${label}`), `${label} 的文案来自纯逻辑模块`);
  }
  assert.match(detail, /onPlayAll\?\.\(\w*[Ss]ongs\)/, "「播放全部」交出去的是那批曲目");
  assert.match(detail, /onEnqueue\?\.\(\w*[Ss]ongs\)/, "「加入队列」同一份");
});

// ---------------------------------------------------------------------------
// 8. 页面接线（源码扫描）
// ---------------------------------------------------------------------------

test("页面接线：四个服务端分页的页面都走 coreCall 的 page/pageSize，哨兵与滚动根来自逻辑模块", () => {
  const source = read("src/renderer/pages.tsx");
  assert.match(source, /features\/library\/pagination\.mjs/, "分页判定必须来自 pagination.mjs（纯逻辑，跑得了测试）");
  assert.match(source, /IntersectionObserver/, "滚动加载用 IntersectionObserver");
  assert.match(source, /findScrollRoot\(/, "root 用应用内容区那个滚动容器（不是页面自己再造一层）");
  assert.match(source, /rootMargin:\s*PAGINATION_ROOT_MARGIN|rootMargin/, "提前量走常量");
  assert.match(source, /PAGINATION_SENTINEL_TESTID/, "哨兵锚点来自逻辑模块的常量");
  assert.match(source, /shouldObserve\(/, "无 hasMore 时不再观察");
  assert.match(source, /page:\s*(?:nextPageOf|page)|nextPageOf\(/, "载荷要带真实页号");
  assert.match(source, /pageSize/, "载荷要带页大小");
  assert.doesNotMatch(source, /overflow-y-auto|overflow-auto/, "页面自己不许再造滚动容器（内容区那一层才是根）");
  assert.doesNotMatch(source, /new Set\(/, "去重不许在 UI 里再做一遍");
});

test("页面接线：歌手/历史不发分页请求（后端不分页就不要假装在翻页）", () => {
  const source = read("src/renderer/pages.tsx");
  const artist = source.slice(source.indexOf("export function ArtistPage"), source.indexOf("export function HistoryPage"));
  const history = source.slice(source.indexOf("export function HistoryPage"), source.indexOf("// 设置（R10）"));
  assert.ok(artist.length > 0 && history.length > 0, "要能在 pages.tsx 里定位歌手/历史两段");

  for (const [name, slice] of [["歌手页", artist], ["历史页", history]]) {
    assert.doesNotMatch(slice, /page:\s*nextPageOf|nextPageOf\(/, `${name}不翻页：后端那一个接口不分页`);
    assert.match(slice, /useLocalReveal|createLocalListState/, `${name}用本地分批揭示`);
    assert.match(slice, /status=""/, `${name}不再挂状态行文案（R55：那几句说明不显示）`);
  }
});
