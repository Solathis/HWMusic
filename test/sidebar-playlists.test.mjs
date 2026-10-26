/**
 * R62：侧栏「我的歌单」——展示投影（纯逻辑）+ 侧栏源码契约。
 *
 * 判据分两层：条目投影能不能把协议层的歌单翻成"封面/名字/数量"，
 * 以及那一组界面是不是真的用 shadcn 侧栏原语搭的（tooltip、Skeleton、ScrollArea、高亮）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SIDEBAR_PLAYLIST_ITEM_TESTID,
  SIDEBAR_PLAYLISTS_EMPTY_TESTID,
  SIDEBAR_PLAYLISTS_EMPTY_TEXT,
  SIDEBAR_PLAYLISTS_FAILURE_TESTID,
  SIDEBAR_PLAYLISTS_LABEL,
  SIDEBAR_PLAYLISTS_LIST_TESTID,
  SIDEBAR_PLAYLISTS_RETRY_LABEL,
  SIDEBAR_PLAYLISTS_SKELETON_TESTID,
  playlistKindLabel,
  sidebarPlaylistItems,
  sidebarPlaylistMetaText,
  sidebarPlaylistTooltipText,
} from "../src/renderer/features/library/sidebar-playlists.mjs";
import { notifyPlaylistsChanged, onPlaylistsChanged } from "../src/renderer/features/library/playlist-refresh.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const GUARD_PLAYLISTS = [
  { id: "PL-1", name: "守卫歌单", count: 120, kind: "owned", coverUrl: "https://music.dbankcdn.cn/a.png" },
  { id: "PL-2", name: "重复页守卫歌单", count: 50, kind: "collected", coverUrl: null },
];

// ---------------------------------------------------------------------------
// 1. 展示投影
// ---------------------------------------------------------------------------

test("侧栏条目：有 id 的才留下（点了才知道开哪一张），顺序照接口给的", () => {
  const items = sidebarPlaylistItems([
    ...GUARD_PLAYLISTS,
    { name: "没有 id 的歌单" },
    { id: "", name: "空 id" },
    null,
  ]);
  assert.deepEqual(items.map((item) => item.id), ["PL-1", "PL-2"]);
  assert.deepEqual(items.map((item) => item.name), ["守卫歌单", "重复页守卫歌单"]);
  assert.equal(items[0].coverUrl, "https://music.dbankcdn.cn/a.png");
  assert.equal(items[1].coverUrl, null, "没有封面就是 null（由界面画占位图标）");
  assert.equal(items[0].source, GUARD_PLAYLISTS[0], "条目不丢原对象（打开详情时标题要用它）");
  assert.deepEqual(sidebarPlaylistItems(null), []);
  assert.deepEqual(sidebarPlaylistItems("nope"), []);
});

test("数量：数不出来就说不知道，绝不显示「0 首」（真的空歌单才有 0）", () => {
  assert.equal(sidebarPlaylistMetaText({ songCount: 0 }), "0 首");
  assert.equal(sidebarPlaylistMetaText({ count: "12" }), "12 首");
  assert.equal(sidebarPlaylistMetaText({}), null, "两样都没有时不留一行空文字");
});

test("分类沿用协议层的 kind：自建/收藏标出来，榜单与认不出的一律不猜", () => {
  assert.equal(playlistKindLabel("owned"), "自建");
  assert.equal(playlistKindLabel("collected"), "收藏");
  assert.equal(playlistKindLabel("chart"), null);
  assert.equal(playlistKindLabel("unknown"), null);
  assert.equal(playlistKindLabel(undefined), null);

  assert.equal(sidebarPlaylistMetaText({ kind: "owned", count: 120 }), "自建 · 120 首");
  assert.equal(sidebarPlaylistMetaText({ kind: "collected" }), "收藏");
  assert.equal(sidebarPlaylistMetaText({ kind: "chart", count: 8 }), "8 首");
});

test("窄轨 tooltip：名字在前，数量跟着（收起时那是唯一一份文字）", () => {
  assert.equal(sidebarPlaylistTooltipText({ id: "P", name: "晨跑", kind: "owned", count: 120 }), "晨跑 · 自建 · 120 首");
  assert.equal(sidebarPlaylistTooltipText({ id: "P", name: "晨跑", count: 12 }), "晨跑 · 12 首");
  assert.equal(sidebarPlaylistTooltipText({ id: "P", name: "晨跑" }), "晨跑", "数不出来就只说名字，不编数量");
  assert.equal(sidebarPlaylistTooltipText(null), "未命名歌单");
});

// ---------------------------------------------------------------------------
// 2. 刷新入口（加歌之后侧栏要重取）
// ---------------------------------------------------------------------------

test("歌单变化通知：订阅者都收到，退订之后不再收到", () => {
  const calls = [];
  const stopFirst = onPlaylistsChanged(() => calls.push("first"));
  const stopSecond = onPlaylistsChanged(() => calls.push("second"));
  notifyPlaylistsChanged();
  assert.deepEqual(calls, ["first", "second"]);

  stopFirst();
  notifyPlaylistsChanged();
  assert.deepEqual(calls, ["first", "second", "second"]);

  stopSecond();
  notifyPlaylistsChanged();
  assert.deepEqual(calls, ["first", "second", "second"], "都退订之后没有人再被叫醒");
  assert.equal(typeof onPlaylistsChanged("not-a-function"), "function", "坏订阅回一个空退订，不抛");
});

// ---------------------------------------------------------------------------
// 3. 侧栏源码契约（界面是不是真的用 shadcn 侧栏原语搭的）
// ---------------------------------------------------------------------------

test("侧栏那一组：组标题 + 菜单项 + 骨架 + tooltip，状态文案都从纯逻辑模块来", () => {
  const source = stripComments(read("src/renderer/sidebar-playlists.tsx"));
  for (const primitive of [
    "SidebarGroupLabel",
    "SidebarGroupContent",
    "SidebarMenuButton",
    "SidebarMenuItem",
    "SidebarMenuSkeleton",
    "ScrollArea",
    "Tooltip",
    "Button",
  ]) {
    assert.match(source, new RegExp(`\\b${primitive}\\b`), `侧栏歌单要用 shadcn 的 ${primitive}`);
  }
  assert.match(source, /tooltip=\{item\.tooltipText\}/, "窄轨里名字与数量走 SidebarMenuButton 的官方 tooltip 参数");
  assert.match(source, /isActive=\{item\.id === activePlaylistId\}/, "当前打开的歌单要标成高亮");
  assert.match(source, /libraryFailureText\(resource\.failure\)/, "失败只说一句人话（文案来自 library-state.mjs）");
  assert.match(source, /SIDEBAR_PLAYLISTS_RETRY_LABEL/, "失败态给「重试」");
  assert.match(source, /SIDEBAR_PLAYLISTS_EMPTY_TEXT/, "没有歌单给一句空态");
  assert.match(source, /SIDEBAR_PLAYLISTS_SKELETON_TESTID/, "加载中是骨架，不是空态");
  assert.match(source, /onPlaylistsChanged\(reload\)/, "歌单变了要有人叫醒它重取");
  assert.match(source, /LIBRARY_PLAYLISTS/, "走共享常量里的那条 library:playlists（不新增端点）");
  assert.doesNotMatch(source, /["'`]library:[a-z-]+["'`]/, "频道名一律 import 共享常量");
  // 列表自己滚（手写 overflow 是 no-self-visual 禁的，面板一律 ScrollArea）
  assert.doesNotMatch(source, /overflow-(?:y-)?(?:auto|scroll)/, "滚动交给 ScrollArea，不手搓滚动容器");
});

test("外壳只交视图与动作：App.tsx 不再认识「我的歌单」这一页", () => {
  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /<SidebarPlaylists\b/, "侧栏要挂上歌单这一组");
  assert.match(app, /activePlaylistId=\{view\.id === VIEW\.playlistDetail \? viewParam\(view, "playlistId"\) : null\}/,
    "高亮的那一张 = 当前打开的 playlist-detail");
  assert.match(app, /onOpen=\{onOpenPlaylist\}/, "点开歌单走外壳那一条导航（标题/参数一处生成）");
  assert.doesNotMatch(app, /PlaylistsPage/, "「我的歌单」页已经删除");
  assert.doesNotMatch(app, /VIEW\.playlists\b/, "视图枚举里没有 playlists 了");
  assert.doesNotMatch(app, /\bcoreCall\(/, "外壳不直接取数（取数在侧栏组件与页面里）");
  assert.equal(existsSync(`${repoRoot}src/renderer/playlist-grid.tsx`), false, "旧歌单网格随页面一起删除");
  assert.doesNotMatch(stripComments(read("src/renderer/pages.tsx")), /PlaylistGrid|PlaylistsPage/, "pages.tsx 里没有旧歌单页的残留");
});

test("无占位空文案：标签与空态是克制的一句话", () => {
  assert.equal(SIDEBAR_PLAYLISTS_LABEL, "我的歌单");
  assert.equal(SIDEBAR_PLAYLISTS_EMPTY_TEXT, "还没有歌单。");
  assert.equal(SIDEBAR_PLAYLISTS_RETRY_LABEL, "重试");
  for (const token of [SIDEBAR_PLAYLISTS_EMPTY_TEXT, SIDEBAR_PLAYLISTS_LABEL]) {
    assert.doesNotMatch(token, /敬请期待|即将上线/, "不画饼");
  }
  for (const name of [
    "SIDEBAR_PLAYLISTS_LIST_TESTID",
    "SIDEBAR_PLAYLISTS_SKELETON_TESTID",
    "SIDEBAR_PLAYLISTS_FAILURE_TESTID",
    "SIDEBAR_PLAYLISTS_EMPTY_TESTID",
    "SIDEBAR_PLAYLIST_ITEM_TESTID",
  ]) {
    assert.match(
      read("src/renderer/sidebar-playlists.tsx"),
      new RegExp(name),
      `界面要挂锚点 ${name}（守卫按它找那一组）`,
    );
  }
});
