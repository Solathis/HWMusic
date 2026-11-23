import assert from "node:assert/strict";

const port = Number(process.env.HWMUSIC_DEBUG_PORT ?? 9334);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(target => target.type === "page" && !target.url.startsWith("devtools:"));
assert.ok(target, "需要已启动并登录的桌面主窗口");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
try {
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("底部位置验证超时")), 25000);
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { awaitPromise: true, returnByValue: true, expression: `(${async function (maximize) {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const click = label => {
        const button = document.querySelector('button[aria-label="' + label + '"]');
        if (!button) throw new Error("找不到按钮：" + label);
        button.click();
      };
      if (innerWidth < 600 || innerHeight < 400) throw new Error("请先还原主窗口");
      if (document.querySelector('[data-testid="playback-stage"]')?.getAttribute("aria-hidden") === "false") { click("收起歌词"); await delay(800); }
      const chrome = action => window.__TAURI_INTERNALS__.invoke("core_main_chrome", { payload: { action } });
      const original = await chrome("read");
      const changed = maximize && !original.maximized;
      if (changed) { await chrome("toggle-maximize"); await delay(500); }
      try {
      const runs = [];
      for (const opening of [true, false, true, false]) {
        const frames = [];
        const start = performance.now();
        const sample = () => {
          const bar = document.querySelector('[data-testid="player-bar"]').getBoundingClientRect();
          const content = document.querySelector('[data-testid="main-content"]').getBoundingClientRect();
          frames.push({ time: Math.round(performance.now() - start), height: innerHeight, screenY, bottom: screenY + bar.bottom, width: innerWidth, contentTop: content.top, contentHeight: content.height, outerHeight, screenX });
        };
        sample();
        click(opening ? "歌词" : "收起歌词");
        await new Promise(resolve => {
          const frame = () => { sample(); if (performance.now() - start < 1100) requestAnimationFrame(frame); else resolve(); };
          requestAnimationFrame(frame);
        });
        if (opening) {
          const stage = document.querySelector('[data-testid="playback-stage"]').getBoundingClientRect();
          if (stage.x !== 0 || stage.y !== 0 || stage.width !== innerWidth || stage.height !== innerHeight) throw new Error("沉浸歌词没有覆盖整个应用视口");
          if (!(await chrome("read")).frameless) throw new Error("Windows 沉浸页仍有系统标题栏");
        }
        runs.push({ opening, frames });
        await delay(150);
      }
      return runs.map(({ opening, frames }) => ({ opening, bottomRange: Math.max(...frames.map(frame => frame.bottom)) - Math.min(...frames.map(frame => frame.bottom)), widths: [...new Set(frames.map(frame => frame.width))], heights: [...new Set(frames.map(frame => frame.height))], layouts: [...new Set(frames.map(frame => [frame.contentTop, frame.contentHeight, frame.outerHeight, frame.screenX, frame.screenY].join(',')))], startBottom: frames[0].bottom, endBottom: frames.at(-1).bottom }));
      } finally {
        if (changed && (await chrome("read")).maximized) await chrome("toggle-maximize");
      }
    }})(${process.argv.includes("--maximized")})` } }));
  });
  console.log(JSON.stringify(result, null, 2));
  for (const run of result) {
    assert.ok(run.bottomRange <= 1, `${run.opening ? "打开" : "关闭"}歌词时底部移动了 ${run.bottomRange}px`);
    assert.equal(run.widths.length, 1, "开合歌词不能改变页面宽度");
    assert.equal(run.heights.length, 1, "开合歌词不能改变页面高度");
    assert.equal(run.layouts.length, 1, "开合歌词不能移动窗口或改变内容区布局");
  }
  console.log("PASS: 沉浸歌词占满应用，连续开合时窗口、视口、内容区和底部保持稳定");
} finally { socket.close(); }
