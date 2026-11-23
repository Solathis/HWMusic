export async function runOpenPerformanceChecks({ page, add, theme }) {
  await page.evaluate(() => window.__guard.ready());
  await page.evaluate(() => window.__guard.prepareLargeQueue(2000, 1400));
  const trigger = page.getByRole("button", { name: "播放队列", exact: true });
  await trigger.click();
  const panel = page.getByTestId("queue-panel");
  await panel.waitFor();
  await page.waitForTimeout(400);
  const queue = await panel.evaluate(node => {
    const active = node.querySelector('[aria-current="true"]');
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]');
    const rect = active?.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return { rows: node.querySelectorAll("li").length, currentVisible: !!rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1 };
  });
  add(theme + "-large-queue-bounded", queue.rows < 80 && queue.currentVisible, JSON.stringify(queue));
  await panel.locator('[data-slot="scroll-area-viewport"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await panel.getByRole("button", { name: /队列曲目 1999/ }).waitFor();
  add(theme + "-large-queue-scroll-end", await panel.locator("li").count() < 80, "滚动到第 2000 首仍只挂载可见行");
  await panel.getByRole("button", { name: /队列曲目 1999/ }).focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  add(theme + "-queue-keyboard-home", await page.evaluate(() => document.activeElement?.textContent?.includes("队列曲目 0")), "Home 定位并聚焦队首");
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  add(theme + "-queue-keyboard-end", await page.evaluate(() => document.activeElement?.textContent?.includes("队列曲目 1999")), "End 定位并聚焦队尾");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__guard.snapshot().index === 1999);
  add(theme + "-queue-select-original-index", true, "虚拟列表点击第 2000 首，播放索引仍为 1999");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  add(theme + "-queue-focus-return", await trigger.evaluate(node => document.activeElement === node), "关闭后焦点回到入口");
  await page.evaluate(() => window.__guard.ready());
  await page.evaluate(() => window.__guard.setLrc(Array.from({ length: 80 }, (_, index) => `[${String(Math.floor(index * 3 / 60)).padStart(2, "0")}:${String(index * 3 % 60).padStart(2, "0")}.00]这是用于检查歌词重复打开的第${index}行歌词`).join("\n")));
  const stageTrigger = page.getByRole("button", { name: "歌词", exact: true });
  await stageTrigger.click();
  await page.getByTestId("amll-lyrics-panel").waitFor();
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__openingLyrics = document.querySelector(".amll-lyric-player"); window.__openingCanvas = document.querySelector('[data-testid="amll-background"] canvas'); });
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
  await page.waitForTimeout(700);
  const hiddenFrames = await page.evaluate(async () => {
    const original = window.requestAnimationFrame;
    let frames = 0;
    window.requestAnimationFrame = callback => { frames += 1; return original.call(window, callback); };
    try { await new Promise(resolve => setTimeout(resolve, 250)); }
    finally { window.requestAnimationFrame = original; }
    return frames;
  });
  add(theme + "-hidden-stage-stops-frames", hiddenFrames < 5, JSON.stringify({ hiddenFrames }));
  await stageTrigger.click();
  await page.getByTestId("playback-stage").waitFor();
  const reuse = await page.evaluate(() => ({ lyrics: !!window.__openingLyrics && window.__openingLyrics === document.querySelector(".amll-lyric-player"), background: !!window.__openingCanvas && window.__openingCanvas === document.querySelector('[data-testid="amll-background"] canvas') }));
  add(theme + "-stage-reuses-renderers", reuse.lyrics && reuse.background, JSON.stringify(reuse));
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
}
