import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";

const outDir = resolve(".tmp/r44a-consumers");
await mkdir(outDir, { recursive: true });
const bundle = async (name, source, plugins = []) => {
  const path = resolve(outDir, `${name}.mjs`);
  await build({ stdin: { contents: source, resolveDir: resolve("."), loader: "tsx" }, outfile: path, bundle: true, format: "esm", platform: "node", target: "node22", jsx: "automatic", packages: "external", plugins, logLevel: "warning" });
  return import(pathToFileURL(path).href);
};

test("真实 PlayerBar 与 QueuePanel 渲染安全封面，信息按钮不再吃满左区", async () => {
  const { render } = await bundle("components", `
    import { renderToStaticMarkup } from "react-dom/server";
    import { PlayerBar, QueuePanel } from "./src/renderer/components.tsx";
    import { createPlayer } from "./src/renderer/features/playback/player.mjs";
    export function render() {
      const player = createPlayer({ audio: { setSource() {}, play: async () => {}, pause() {}, setCurrentTime() {}, setVolume() {}, setMuted() {}, on: () => () => {} }, resolveUrl: async () => ({}), guardUrl: () => null });
      player.setQueue([{ id: "1", name: "真实标题", artists: "艺人", coverUrl: "https://music.dbankcdn.cn/cover.jpg" }]);
      const state = player.snapshot();
      return renderToStaticMarkup(<><PlayerBar runtime={{ player }} state={state} onOpenStage={() => {}} /><QueuePanel entries={state.entries} index={0} /></>);
    }`);
  const markup = render();
  assert.equal((markup.match(/<img[^>]+src="https:\/\/music\.dbankcdn\.cn\/cover.jpg"/g) ?? []).length, 2, "两个真实组件都消费投影封面");
  const button = markup.match(/<button[^>]*data-testid="player-track-info"[^>]*>/)?.[0];
  assert.ok(button);
  assert.doesNotMatch(button, /\bflex-1\b/);
  assert.match(button, /\bw-fit\b/);
  assert.match(button, /\bmax-w-full\b/);
});

test("R44c review taskbar 无论 clean/panel 与 showControls 都不渲染控件带", async () => {
  const prior = { window: globalThis.window, MouseEvent: globalThis.MouseEvent };
  globalThis.MouseEvent ??= class extends Event {};
  try {
    const { renderLyricsWindow } = await bundle("desktop-window", `
      import { renderToStaticMarkup } from "react-dom/server";
      import { LyricsWindow } from "./src/renderer/LyricsWindow.tsx";
      export function renderLyricsWindow() { return renderToStaticMarkup(<LyricsWindow />); }
    `);
    for (const style of ["clean", "panel"]) {
      for (const showControls of ["1", "0"]) {
        globalThis.window = { location: { search: "?mode=taskbar&style=" + style + "&showControls=" + showControls } };
        const html = renderLyricsWindow();
        assert.doesNotMatch(html, /data-testid="lyrics-controls"|<button\b|data-slot="card-header"/, `${style}/${showControls} 不应挤占 44px 单行窗口`);
        assert.match(html, /data-lyrics-layout="horizontal"/);
      }
    }
  } finally { Object.assign(globalThis, prior); }
});

test("同 id 的歌词匹配元信息变化重新请求，进度/音量/封面变化不重复请求", async () => {
  const calls = [];
  const slots = [];
  let cursor = 0;
  let effects = [];
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  globalThis.__r44aHooks = {
    bridge: {
      snapshot: () => ({ config: {}, visible: false, saveError: null }), observe: () => () => {},
      pushDocument: async () => {}, loadLyrics: async (query) => { calls.push(query); return { lines: [], status: "empty" }; },
    },
    useRef: (value) => { const i = cursor++; return slots[i] ??= { current: value }; },
    useState: (init) => { const i = cursor++; slots[i] ??= { value: typeof init === "function" ? init() : init }; return [slots[i].value, (next) => { slots[i].value = next; }]; },
    useMemo: (fn, deps) => { const i = cursor++; if (!equalDeps(slots[i]?.deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback: (fn, deps) => globalThis.__r44aHooks.useMemo(() => fn, deps),
    useEffect: (fn, deps) => { const i = cursor++; if (!equalDeps(slots[i]?.deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  const { useLyricsWindow } = await bundle("hook", `export { useLyricsWindow } from "./src/renderer/use-lyrics-window.ts";`, [{ name: "ports", setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "r44a" }));
    builder.onResolve({ filter: /lyrics-bridge\.mjs$/ }, () => ({ path: "bridge", namespace: "r44a" }));
    builder.onLoad({ filter: /.*/, namespace: "r44a" }, ({ path }) => ({ contents: path === "react" ? "export const { useRef, useState, useMemo, useCallback, useEffect } = globalThis.__r44aHooks;" : "export const getLyricsBridge = () => globalThis.__r44aHooks.bridge;" }));
  } }]);
  const runtime = { player: { setLyrics() {} } };
  const render = async (track, progress = 0, volume = 1) => { cursor = 0; effects = []; useLyricsWindow(runtime, { track, currentTimeMs: progress, volume }); for (const effect of effects) effect(); await new Promise((done) => setTimeout(done, 0)); };
  try {
    await render({ id: "1", name: "旧名", artists: "旧艺人", duration: 10 });
    await render({ id: "1", name: "新名", artists: "新艺人", duration: 20 });
    assert.deepEqual(calls, [
      { trackId: "1", title: "旧名", artist: "旧艺人", durationSeconds: 10 },
      { trackId: "1", title: "新名", artist: "新艺人", durationSeconds: 20 },
    ]);
    await render({ id: "1", name: "新名", artists: "新艺人", duration: 20, coverUrl: "https://music.dbankcdn.cn/new.jpg" }, 1000);
    assert.equal(calls.length, 2);
    await render({ id: "1", name: "新名", artists: "新艺人", duration: 20 }, 1000, 0.4);
    assert.equal(calls.length, 2, "只改音量不重新请求");
    await render({ id: "1", name: "新名", artists: "新艺人", duration: 21 });
    assert.equal(calls.length, 3, "只变时长也重新匹配");
    assert.deepEqual(calls.at(-1), { trackId: "1", title: "新名", artist: "新艺人", durationSeconds: 21 });
  } finally {
    for (const slot of slots) slot?.cleanup?.();
    delete globalThis.__r44aHooks;
  }
});
