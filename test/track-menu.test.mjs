/**
 * R63：曲目行与队列行的专属菜单——**菜单项集合**（纯逻辑 + 界面契约）。
 *
 * 曲目行三项（播放 / 下一首播放 / 加入播放队列），队列行少一项。「加入歌单」需要
 * "向已有歌单追加歌曲"的端点证据，本轮没有（docs/API_CONTRACT.md §2.13），所以菜单里没有它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ADD_TO_PLAYLIST_SUPPORTED,
  TRACK_MENU_ITEM,
  TRACK_MENU_TARGET,
  trackMenuItems,
} from "../src/renderer/features/shell/track-menu.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const idsOf = (items) => items.map((item) => item.id);

// ---------------------------------------------------------------------------
// 1. 菜单项集合
// ---------------------------------------------------------------------------

test("曲目行：播放 / 下一首播放 / 加入播放队列（顺序就是用户从快到慢的那三件事）", () => {
  const items = trackMenuItems(TRACK_MENU_TARGET.track);
  assert.deepEqual(idsOf(items), ["play", "play-next", "enqueue"]);
  assert.deepEqual(items.map((item) => item.label), ["播放", "下一首播放", "加入播放队列"]);
});

test("队列行：播放 / 下一首播放，没有「加入播放队列」（它已经在队列里）", () => {
  const items = trackMenuItems(TRACK_MENU_TARGET.queue);
  assert.deepEqual(idsOf(items), ["play", "play-next"]);
  assert.deepEqual(items.map((item) => item.label), ["播放", "下一首播放"]);
});

test("动作没接就不出那一项（不摆按下去没反应的死按钮）", () => {
  assert.deepEqual(idsOf(trackMenuItems(TRACK_MENU_TARGET.track, { play: false })), ["play-next", "enqueue"]);
  assert.deepEqual(idsOf(trackMenuItems(TRACK_MENU_TARGET.track, { playNext: false })), ["play", "enqueue"]);
  assert.deepEqual(idsOf(trackMenuItems(TRACK_MENU_TARGET.track, { enqueue: false })), ["play", "play-next"]);
  assert.deepEqual(idsOf(trackMenuItems(TRACK_MENU_TARGET.track, { play: false, playNext: false, enqueue: false })), []);
});

test("认不出的目标 / 没有目标：一项都不出（空白处不弹菜单的纯逻辑那一半）", () => {
  for (const target of [undefined, null, "nonsense", ""]) {
    assert.deepEqual(trackMenuItems(target), [], `目标 ${JSON.stringify(target)} 没有菜单`);
  }
});

test("菜单项 id 是稳定常量（界面与测试都按它认，不认文案）", () => {
  assert.deepEqual(
    { ...TRACK_MENU_ITEM },
    { play: "play", playNext: "play-next", enqueue: "enqueue", addToPlaylist: "add-to-playlist" },
  );
  assert.deepEqual({ ...TRACK_MENU_TARGET }, { track: "track-table", queue: "queue-panel" });
});

// ---------------------------------------------------------------------------
// 2. 「加入歌单」的证据闸门
// ---------------------------------------------------------------------------

test("「加入歌单」默认不出现：没有「向已有歌单追加」的端点证据就不上菜单", () => {
  assert.equal(ADD_TO_PLAYLIST_SUPPORTED, false, "证据一变（docs/API_CONTRACT.md §2.13）才许翻这个闸门");
  for (const target of [TRACK_MENU_TARGET.track, TRACK_MENU_TARGET.queue]) {
    assert.ok(!idsOf(trackMenuItems(target)).includes("add-to-playlist"), `${target} 的菜单里没有加入歌单`);
  }
});

test("闸门打开时它排在最后（证据到位那天只有这一处要改）", () => {
  const items = trackMenuItems(TRACK_MENU_TARGET.track, { addToPlaylist: true });
  assert.deepEqual(idsOf(items), ["play", "play-next", "enqueue", "add-to-playlist"]);
  assert.equal(items.at(-1).label, "加入歌单");
});

// ---------------------------------------------------------------------------
// 3. 界面契约
// ---------------------------------------------------------------------------

test("用的是 shadcn 的 ContextMenu 原语（不是手写 div 菜单）", () => {
  const menu = stripComments(read("src/renderer/track-menu.tsx"));
  for (const primitive of ["ContextMenu", "ContextMenuTrigger", "ContextMenuContent", "ContextMenuItem"]) {
    assert.match(menu, new RegExp(`\\b${primitive}\\b`), `菜单要用 shadcn 的 ${primitive}`);
  }
  assert.match(menu, /from "\.\/components\/ui\/context-menu"/, "从生成原语引入");
  assert.doesNotMatch(menu, /<div[^>]*role="menu"/, "不手搓菜单语义");
});

test("曲目表与队列面板的行都包进专属菜单，且只由纯逻辑模块决定菜单项", () => {
  const components = stripComments(read("src/renderer/components.tsx"));
  assert.match(components, /<TrackRowMenu\b/, "两处行菜单共用同一个组件");
  assert.match(components, /target=\{TRACK_MENU_TARGET\.track\}/, "曲目行走曲目行那一档");
  assert.match(components, /target=\{TRACK_MENU_TARGET\.queue\}/, "队列行走队列行那一档");
  assert.doesNotMatch(components, /加入歌单/, "没有证据的菜单项一个字都不许写在界面里");
});

test("外壳把播放运行时的那两个动作交给列表（页面拿不到音频，只拿到这两个动作）", () => {
  const app = stripComments(read("src/renderer/App.tsx"));
  assert.match(app, /const onPlayNext = useCallback/, "下一首播放的动作在外壳");
  assert.match(app, /runtime\.player\.playNext\(songs\)/, "直接转给播放运行时");
  assert.match(app, /const rowActions = \{ onPlayNext, onEnqueue \}/, "两个动作打成一份随 navigation 下发");
  assert.match(app, /\{\.\.\.rowActions\}/, "队列面板与收藏页都拿到这份动作");
  const pages = stripComments(read("src/renderer/pages.tsx"));
  assert.match(pages, /rowActions\?: TrackRowActions/, "页面只转发，不自己实现");
  assert.match(pages, /onPlayNext=\{navigation\.rowActions\?\.onPlayNext\}/, "曲目表拿到这两个动作");
  assert.doesNotMatch(app, /加歌|add-to-playlist|playlist-add-songs/, "外壳里没有加歌残留");
});
