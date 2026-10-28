/**
 * 本地歌曲的入口与页面：侧栏那一行、视图枚举、空态文案，页面须复用 `TrackTable`。
 * 页面结构靠源码扫描钉住，真正的渲染与播放由 `npm run test:browser` 覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VIEW, VIEW_IDS, SIDEBAR_VIEWS, createView, isResidentView, viewTitle } from "../src/renderer/features/library/views.mjs";
import { libraryEmptyText } from "../src/renderer/features/library/library-state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("视图枚举：本地歌曲是一个合法视图，且侧栏「音乐库」组里有它", () => {
  assert.equal(VIEW.local, "local");
  assert.ok(VIEW_IDS.includes(VIEW.local), "认不出的 id 会回落到收藏页：本地歌曲必须在枚举里");

  const ids = SIDEBAR_VIEWS.map((entry) => entry.id);
  assert.ok(ids.includes(VIEW.local), "导航列表里必须有本地歌曲（否则用户点不进去）");
  assert.equal(ids[ids.indexOf(VIEW.favorites) + 1], VIEW.local, "它排在「我的收藏」后面（同属音乐库）");
  assert.equal(SIDEBAR_VIEWS.find((entry) => entry.id === VIEW.local).label, "本地歌曲");
});

test("标题与空态：有名字、空态说清\"本地\"而不是笼统的\"还没有歌\"", () => {
  assert.equal(viewTitle(createView(VIEW.local)), "本地歌曲");
  assert.equal(libraryEmptyText(createView(VIEW.local)), "还没有导入本地歌曲。");
  assert.equal(isResidentView(createView(VIEW.local)), false, "本地页不需要常驻（它每次都从宿主取一遍）");
});

test("页面源码：复用 TrackTable，有导入与移除，且不显示收藏心形", () => {
  const page = readFileSync(`${repoRoot}src/renderer/pages.tsx`, "utf8");
  const factory = page.slice(page.indexOf("export function LocalSongsPage"), page.indexOf("export function SettingsPage"));
  assert.ok(factory.length > 200, "pages.tsx 里必须有 LocalSongsPage");

  for (const needle of ["TrackTable", "onRemove", "unavailableIds", "importLocalTracks", "removeLocalTrack", "fetchLocalLibrary"]) {
    assert.ok(factory.includes(needle), `LocalSongsPage 必须用到 ${needle}`);
  }
  assert.ok(factory.includes("showFavorite={false}"), "本地曲目没有收藏这回事：心形列不许出现");
});

test("曲目表：不可用的行要能标出来，移除按钮占的是原来收藏那一列", () => {
  const source = readFileSync(`${repoRoot}src/renderer/components.tsx`, "utf8");
  const table = source.slice(source.indexOf("export function TrackTable"), source.indexOf("export interface PlayerBarProps"));

  for (const needle of ["unavailableIds", "onRemove", "showFavorite"]) {
    assert.ok(table.includes(needle), `TrackTable 必须支持 ${needle}`);
  }
  assert.ok(table.includes("文件不在"), "不可用的行要有一句看得懂的说明");
  assert.ok(
    table.includes("showFavorite = true"),
    "收藏列的开关要有默认值 true（其余页面照旧显示心形）",
  );
});

test("外壳：renderPage 里有本地歌曲这一档，导航图标表也补齐（缺了会静默用兜底图标）", () => {
  const app = readFileSync(`${repoRoot}src/renderer/App.tsx`, "utf8");
  assert.ok(app.includes("case VIEW.local:"), "renderPage 必须能渲染本地页（否则切进去是空态）");
  assert.ok(app.includes("LocalSongsPage"), "本地页必须在 renderPage 里被使用");
  assert.ok(/NAV_ICONS[\s\S]{0,400}VIEW\.local/.test(app), "导航图标表里要有本地歌曲的图标");
});

test("宿主命令名只有一处真源：本地曲库的四条命令都在 commands.ts 里", () => {
  const commands = readFileSync(`${repoRoot}src/shared/commands.ts`, "utf8");
  for (const name of ["core_local_list", "core_local_import", "core_local_remove", "core_local_base_url"]) {
    assert.ok(commands.includes(`"${name}"`), `commands.ts 里必须有 ${name}`);
  }
});
