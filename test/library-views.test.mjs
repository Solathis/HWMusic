/**
 * R8 主界面 · View 模型与展示投影（纯逻辑，不碰 DOM）。
 *
 * 钉的是三件事：
 * 1. **导航只有一个真源**：侧边栏条目、可导航视图枚举、标题、常驻页判定都来自 views.mjs，
 *    UI 里不许再抄一份（抄一份的下场是"加了个页面但导航里没有"）；
 * 2. **不许白屏**：认不出的视图 id 回落到收藏页，而不是渲染空白；
 * 3. **会话字段名是未知的**：展示投影按候选字段兜底，且与协议层的 `trackIdOf` 对同一批
 *    夹具必须给出一致结论（跨层差分钉：两处各自演进就会让"能显示的 id"和"能去重的 id"分家）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { trackIdOf as protocolTrackIdOf } from "../src/protocols/music.mjs";
import {
  LIBRARY_FAILURE_TEXT,
  appendNotice,
  libraryEmptyText,
  libraryFailureText,
} from "../src/renderer/features/library/library-state.mjs";
import {
  PLAYLIST_ENQUEUE_LABEL,
  PLAYLIST_PLAY_ALL_LABEL,
  playlistDetailMetaText,
  playlistDetailTitleOf,
  playlistIdOf,
  playlistNameOf,
  playlistPartialNoticeText,
  playlistSongCountOf,
} from "../src/renderer/features/library/playlist-fields.mjs";
import {
  NAV_LIST_TESTID,
  SIDEBAR_VIEWS,
  VIEW,
  VIEW_IDS,
  createView,
  isResidentView,
  isViewId,
  normalizeView,
  viewKey,
  viewParam,
  viewTitle,
} from "../src/renderer/features/library/views.mjs";
import {
  formatDuration,
  trackAlbumIdOf,
  trackAlbumOf,
  trackArtistIdOf,
  trackArtistsOf,
  trackDurationOf,
  trackIdOf,
  trackNameOf,
} from "../src/renderer/features/library/track-fields.mjs";

// ---------------------------------------------------------------------------
// 1. 视图枚举与侧边栏导航（唯一真源）
// ---------------------------------------------------------------------------

test("视图枚举：六个页面 + 设置都在枚举里，且侧边栏条目全部落在枚举内", () => {
  assert.deepEqual([...VIEW_IDS].sort(), [
    "album",
    "artist",
    "favorites",
    "history",
    "playlist-detail",
    "playlists",
    "search",
    "settings",
  ]);

  assert.ok(SIDEBAR_VIEWS.length >= 4, "侧边栏至少要覆盖收藏/歌单/历史/设置");
  const seen = new Set();
  for (const entry of SIDEBAR_VIEWS) {
    assert.equal(isViewId(entry.id), true, `侧边栏条目必须是已知视图：${entry.id}`);
    assert.equal(seen.has(entry.id), false, `侧边栏不许出现两次：${entry.id}`);
    seen.add(entry.id);
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0 && entry.label.length <= 6, `文案要克制：${entry.label}`);
    assert.doesNotMatch(entry.label, /[。！!]/, `导航标签不带句号：${entry.label}`);
  }
  // 只能从表格/网格跳进去的页面不必在侧边栏里，但也不能凭空多出来
  for (const id of ["album", "artist", "playlist-detail"]) {
    assert.equal(seen.has(id), false, `${id} 是"从别处跳进来"的页面，不该占侧边栏`);
  }
  /**
   * R40 裁决（**改写**了 R8 那条"侧边栏要覆盖搜索"）：搜索入口从导航项换成侧栏顶部的常驻
   * 输入框（`SidebarInput`），所以 `VIEW.search` **必须不再**占导航的一行——否则界面上会有
   * 两个搜索入口（一个常驻框 + 一条导航项），点哪个都说不清。
   * `VIEW.search` 仍是合法视图（内容区的结果页用它），只是不进 `SIDEBAR_VIEWS`。
   */
  assert.equal(
    SIDEBAR_VIEWS.some((entry) => entry.id === VIEW.search),
    false,
    "搜索不再是导航项（入口是侧栏顶部的常驻搜索框）",
  );
  assert.equal(isViewId(VIEW.search), true, "搜索仍是一个可用的视图（结果页要用它）");
  assert.equal(NAV_LIST_TESTID, "nav-list", "导航列表的测试锚点是契约（源码扫描也钉它）");
});

test("视图归一：认不出的 id 回落到收藏页（绝不渲染空白），参数原样保留", () => {
  assert.deepEqual(normalizeView(createView(VIEW.album, { albumId: "A1" })), { id: "album", params: { albumId: "A1" } });
  assert.deepEqual(normalizeView({ id: "not-a-view" }), { id: "favorites", params: {} });
  assert.deepEqual(normalizeView(null), { id: "favorites", params: {} });
  assert.deepEqual(normalizeView({ id: VIEW.search, params: "nope" }), { id: "search", params: {} });

  assert.equal(viewParam(createView(VIEW.album, { albumId: "A1" }), "albumId"), "A1");
  assert.equal(viewParam(createView(VIEW.album, { albumId: 42 }), "albumId"), "42", "参数统一成字符串");
  assert.equal(viewParam(createView(VIEW.album), "albumId"), null);
});

test("视图键：参数顺序不影响同一个键（滚动位置按它记），参数不同就是不同键", () => {
  const first = viewKey(createView(VIEW.playlistDetail, { playlistId: "P1", name: "晨跑" }));
  const reordered = viewKey(createView(VIEW.playlistDetail, { name: "晨跑", playlistId: "P1" }));
  assert.equal(first, reordered);
  assert.notEqual(first, viewKey(createView(VIEW.playlistDetail, { playlistId: "P2", name: "晨跑" })));
  assert.equal(viewKey(createView(VIEW.favorites)), "favorites");
  assert.match(first, /^playlist-detail\?/);
});

test("视图标题：有名字用名字，没名字用兜底（永不返回空串）", () => {
  assert.equal(viewTitle(createView(VIEW.playlistDetail, { name: "晨跑" })), "晨跑");
  assert.equal(viewTitle(createView(VIEW.playlistDetail)), "歌单");
  assert.equal(viewTitle(createView(VIEW.album, { name: "范特西" })), "范特西");
  assert.equal(viewTitle(createView(VIEW.album)), "专辑");
  assert.equal(viewTitle(createView(VIEW.artist, { name: "周杰伦" })), "周杰伦");
  assert.equal(viewTitle(createView(VIEW.artist)), "歌手");
  assert.equal(viewTitle(createView(VIEW.favorites)), "我的收藏");
  assert.equal(viewTitle(createView(VIEW.settings)), "设置");
  for (const id of VIEW_IDS) assert.ok(viewTitle(createView(id)).length > 0, `${id} 的标题不能是空`);
});

test("常驻挂载：只有收藏页常驻（切走不卸载），其余页面按视图重挂", () => {
  assert.equal(isResidentView(createView(VIEW.favorites)), true);
  for (const id of VIEW_IDS.filter((value) => value !== VIEW.favorites)) {
    assert.equal(isResidentView(createView(id)), false, `${id} 不该常驻挂载`);
  }
});

// ---------------------------------------------------------------------------
// 2. 展示投影（字段名未知 → 候选兜底；与协议层同一结论）
// ---------------------------------------------------------------------------

test("展示投影：id 的兜底顺序与协议层一致（跨层差分钉，避免两处各自演进）", () => {
  const fixtures = [
    { id: "1" },
    { songId: 2 },
    { musicId: "3" },
    { resourceId: "4" },
    { trackId: "5" },
    { id: "", songId: "6" },
    { name: "没有 id" },
    { id: null },
    { songId: Number.NaN },
    { id: "a", songId: "b" },
    null,
    "not-an-object",
  ];
  for (const fixture of fixtures) {
    assert.equal(
      trackIdOf(fixture),
      protocolTrackIdOf(fixture),
      `渲染层的 id 兜底必须和协议层同结论：${JSON.stringify(fixture)}`,
    );
  }
});

test("展示投影：名称/艺人/专辑按候选字段兜底，取不到如实回占位而不是编一个", () => {
  assert.equal(trackNameOf({ name: "晴天" }), "晴天");
  assert.equal(trackNameOf({ songName: "稻香" }), "稻香");
  assert.equal(trackNameOf({ title: "七里香" }), "七里香");
  assert.equal(trackNameOf({}), "未知歌曲");
  assert.equal(trackNameOf(null), "未知歌曲");

  assert.equal(trackArtistsOf({ singer: "周杰伦" }), "周杰伦");
  assert.equal(trackArtistsOf({ singers: "周杰伦/方文山" }), "周杰伦/方文山");
  assert.equal(trackArtistsOf({ artist: { name: "周杰伦" } }), "周杰伦");
  assert.equal(trackArtistsOf({ artists: [{ name: "周杰伦" }, { name: "阿信" }] }), "周杰伦、阿信");
  assert.equal(trackArtistsOf({ artistNames: ["A", "B"] }), "A、B");
  assert.equal(trackArtistsOf({}), "未知艺人");

  assert.equal(trackAlbumOf({ album: "叶惠美" }), "叶惠美");
  assert.equal(trackAlbumOf({ albumName: "十一月的萧邦" }), "十一月的萧邦");
  assert.equal(trackAlbumOf({ album: { name: "七里香" } }), "七里香");
  assert.equal(trackAlbumOf({}), "未知专辑");

  assert.equal(trackAlbumIdOf({ album: { id: "AL1" } }), "AL1");
  assert.equal(trackAlbumIdOf({ albumId: "AL2" }), "AL2");
  assert.equal(trackAlbumIdOf({ album: "叶惠美" }), null, "只有专辑名时不给假 id（专辑页打不开就别装作能开）");
  assert.equal(trackArtistIdOf({ artistId: "AR1" }), "AR1");
  assert.equal(trackArtistIdOf({ singer: "周杰伦" }), null);
  assert.equal(trackArtistIdOf({ artists: [{ id: "AR2", name: "周杰伦" }] }), "AR2");
});

test("时长格式：只做显示；拿不到就是占位（待联调确认单位前不猜、不显示 0:00）", () => {
  assert.equal(trackDurationOf({ duration: 245 }), 245);
  assert.equal(trackDurationOf({ duration: "245" }), 245, "字符串数字也认（接口形态不定）");
  assert.equal(trackDurationOf({ durationMs: 245000 }), null, "单位不明的字段不认——宁可不显示，也不显示错的时长");
  assert.equal(trackDurationOf({}), null);
  assert.equal(trackDurationOf(null), null);

  assert.equal(formatDuration(245), "4:05");
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(59.6), "0:59", "小数秒向下取整，不四舍五入到下一分钟");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(undefined), "—");
  assert.equal(formatDuration("abc"), "—");
  assert.equal(formatDuration(-1), "—");
});

// ---------------------------------------------------------------------------
// 3. 失败/空态文案（克制，且不冒充"确实没有数据"）
// ---------------------------------------------------------------------------

test("失败文案：「端点未配置」说未配置，「内核不可用」说内核，认不出的类别带上内核那句话", () => {
  assert.match(libraryFailureText({ kind: "endpoint_unknown", message: "接口端点 favorites 尚未确定" }), /未配置|待联调/);
  assert.doesNotMatch(
    libraryFailureText({ kind: "endpoint_unknown", message: "接口端点 favorites 尚未确定" }),
    /没有|暂无数据/,
    "接口没配 ≠ 收藏是空的：文案不许把两者说成一回事",
  );
  assert.match(libraryFailureText({ kind: "core_gone", message: "core 已退出" }), /内核/);
  assert.match(libraryFailureText({ kind: "unimplemented", message: "x" }), /未接入|后续/);
  assert.match(libraryFailureText({ kind: "unheard-of", message: "内核给的说明" }), /内核给的说明/);
  assert.equal(libraryFailureText(null), "加载失败（详情见日志）。");
  assert.equal(libraryFailureText({ kind: "unheard-of", message: "   " }), "加载失败（详情见日志）。");
  assert.equal(LIBRARY_FAILURE_TEXT.endpoint_unknown, libraryFailureText({ kind: "endpoint_unknown" }));

  for (const kind of Object.keys(LIBRARY_FAILURE_TEXT)) {
    const text = LIBRARY_FAILURE_TEXT[kind];
    assert.ok(text.length <= 28, `空态文案要克制（${kind}）：${text}`);
    assert.doesNotMatch(text, /敬请期待|即将上线|马上就来|努力开发中/, `不许给用户画饼（${kind}）：${text}`);
  }
});

test("歌单投影：名字/曲目数/封面地址的兜底；拿不到的曲目数不显示假 0", () => {
  assert.equal(playlistIdOf({ id: "P1" }), "P1");
  assert.equal(playlistIdOf({ playlistId: 7 }), "7");
  assert.equal(playlistIdOf({}), null);
  assert.equal(playlistIdOf(null), null);

  assert.equal(playlistNameOf({ name: "晨跑" }), "晨跑");
  assert.equal(playlistNameOf({ playlistName: "夜跑" }), "夜跑");
  assert.equal(playlistNameOf({}), "未命名歌单");

  assert.equal(playlistSongCountOf({ songCount: 12 }), 12);
  assert.equal(playlistSongCountOf({ songCount: "12" }), 12);
  assert.equal(playlistSongCountOf({}), null, "数不出来就说不知道（不许显示「0 首」）");
  assert.equal(playlistSongCountOf({ songCount: -3 }), null);
});

test("R40 歌单详情头部：标题/元信息/「只加载了一部分」的说明（不把已加载说成全部）", () => {
  // 标题：接口那份优先，其次视图参数带过来的名字，两个都没有才是兜底
  assert.equal(playlistDetailTitleOf({ name: "接口的名字" }, "卡片的名字"), "接口的名字");
  assert.equal(playlistDetailTitleOf({}, "卡片的名字"), "卡片的名字", "接口没给就用卡片带来的（界面不显示空标题）");
  assert.equal(playlistDetailTitleOf(null, null), "未命名歌单");
  assert.equal(playlistDetailTitleOf({ name: "   " }, "  "), "未命名歌单", "空白不算名字");

  // 元信息：有总数说总数；分页没走完才补"已加载"；没有总数只说已加载
  assert.equal(playlistDetailMetaText({ songCount: 1623 }, 50, true), "共 1623 首 · 已加载 50 首");
  assert.equal(playlistDetailMetaText({ songCount: 22 }, 22, false), "共 22 首", "分页走完时两个数字相等，不写两遍");
  assert.equal(playlistDetailMetaText(null, 50, true), "已加载 50 首", "没有总数就不说「共」");
  assert.equal(playlistDetailMetaText(null, 0, false), "已加载 0 首");
  assert.equal(playlistDetailMetaText({ songCount: "abc" }, 3, false), "已加载 3 首", "坏总数按没有总数处理");

  // 「只加载了一部分」的说明：必须说出来（否则用户以为"播放全部"是整张歌单）
  assert.match(playlistPartialNoticeText(50), /前 50 首/);
  assert.match(playlistPartialNoticeText(50), /已加载/);
  assert.match(playlistPartialNoticeText(3), /^这一页只加载了前 3 首/);

  // 两个按钮的文案只有这一处真源
  assert.equal(PLAYLIST_PLAY_ALL_LABEL, "播放全部");
  assert.equal(PLAYLIST_ENQUEUE_LABEL, "加入队列");
});

test("运行日志：只收非空文本、最新的在最后、条数有上限（长跑不涨内存）", () => {
  let entries = appendNotice([], "代理已按环境变量设置", 3, 1);
  assert.deepEqual(entries, [{ id: 1, text: "代理已按环境变量设置" }]);

  entries = appendNotice(entries, "   ", 3, 2);
  assert.equal(entries.length, 1, "空白文本不产生一条空日志");

  entries = appendNotice(entries, "二", 3, 2);
  entries = appendNotice(entries, "三", 3, 3);
  entries = appendNotice(entries, "四", 3, 4);
  assert.deepEqual(entries.map((entry) => entry.text), ["二", "三", "四"], "超出上限时丢最旧的");
  assert.deepEqual(entries.map((entry) => entry.id), [2, 3, 4]);

  const untouched = appendNotice(entries, 42, 3, 5);
  assert.deepEqual(untouched, entries, "非字符串不进门");
  assert.equal(appendNotice(null, "x", 3, 1).length, 1, "坏入参当空列表");
});

test("空态文案：每个视图一句，句末带句号，且不承诺未实现的功能", () => {
  for (const id of VIEW_IDS) {
    const text = libraryEmptyText(createView(id));
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, `${id} 的空态不能是空串`);
    assert.ok(text.length <= 24, `空态一句话就够（${id}）：${text}`);
    assert.match(text, /。$/, `空态用句号收尾（${id}）：${text}`);
    assert.doesNotMatch(text, /敬请期待|即将上线|努力开发中/, `不许画饼（${id}）：${text}`);
  }
  assert.equal(libraryEmptyText(createView(VIEW.search)), "输入关键字开始搜索。");
  assert.equal(libraryEmptyText({ id: "not-a-view" }), libraryEmptyText(createView(VIEW.favorites)), "认不出的视图回落到收藏页文案");
});

test("空态文案：搜过之后再用「输入关键字开始搜索」就是骗人（那是没搜过的文案）", () => {
  const searched = libraryEmptyText(createView(VIEW.search), { searched: true });
  assert.equal(searched, "没有找到相关歌曲。");
  assert.notEqual(searched, libraryEmptyText(createView(VIEW.search)));
  assert.ok(searched.length <= 24);
  assert.match(searched, /。$/);

  // 其他页面没有"检索"这回事：给了 searched 也还是同一句话
  for (const id of VIEW_IDS.filter((value) => value !== VIEW.search)) {
    assert.equal(
      libraryEmptyText(createView(id), { searched: true }),
      libraryEmptyText(createView(id)),
      `${id} 不是检索页面，不该有两套空态`,
    );
  }
});
