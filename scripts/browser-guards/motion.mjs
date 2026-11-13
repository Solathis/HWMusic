export async function recordVisualFrames(page, selector, action) {
  const key = "__motionFrames_" + Math.random().toString(36).slice(2);
  await page.evaluate(({ key, selector }) => {
    const record = { frames: [], done: false };
    window[key] = record;
    const start = performance.now();
    const tick = () => {
      const node = document.querySelector(selector);
      const rect = node?.getBoundingClientRect();
      const style = node ? getComputedStyle(node) : null;
      const transform = style?.transform ?? "none";
      record.frames.push({
        timeMs: performance.now() - start,
        present: Boolean(node && node.getClientRects().length),
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        opacity: style ? Number(style.opacity) : null, transform,
        scale: transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a,
        focused: Boolean(node?.contains(document.activeElement)),
        tableWrapperOpacity: node?.querySelector("table")?.parentElement?.parentElement
          ? Number(getComputedStyle(node.querySelector("table").parentElement.parentElement).opacity) : null,
      });
      if (performance.now() - start >= 650) record.done = true;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { key, selector });
  await action();
  await page.waitForFunction((key) => window[key]?.done, key);
  return page.evaluate((key) => { const frames = window[key].frames; delete window[key]; return frames; }, key);
}

export async function runMotionPolicyChecks({ page, add, theme }) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "full");
  const button = page.getByTestId("motion-probe-press");
  const frames = await recordVisualFrames(page, '[data-testid="motion-probe-press"]', async () => {
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  });
  const count = Number(await page.getByTestId("motion-probe-count").textContent());
  add(theme + "-motion-press", frames.some((frame) => frame.scale < 0.99)
    && Math.abs(frames.at(-1).scale - 1) < 0.001 && count === 1,
    JSON.stringify({ minScale: Math.min(...frames.map((frame) => frame.scale)), lastScale: frames.at(-1).scale,
      minWidth: Math.min(...frames.filter((frame) => frame.rect).map((frame) => frame.rect.width)),
      lastWidth: frames.at(-1).rect?.width, count, samples: frames.length }));
  await page.getByTestId("motion-probe-disabled").evaluate((node) => node.click());
  add(theme + "-motion-disabled", Number(await page.getByTestId("motion-probe-count").textContent()) === 1, "禁用按钮不发动作");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  const reduced = await recordVisualFrames(page, '[data-testid="motion-probe-region"]', () => button.click());
  add(theme + "-motion-reduced", reduced.filter((frame) => frame.present).every((frame) => frame.opacity === 1 && frame.transform === "none")
    && Number(await page.getByTestId("motion-probe-count").textContent()) === 2, "运行中改变系统偏好，内容直接到位且动作正常");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "full");
}
export async function runMotionChecks(context) {
  await runMotionPolicyChecks(context);
  await runPageMotionChecks(context);
}

export async function runPageMotionChecks({ page, add, theme }) {
  await page.goto(page.url().split("?")[0], { waitUntil: "load" });
  await page.waitForFunction(() => window.__guard !== undefined);
  await page.evaluate((choice) => { document.documentElement.className = choice; return window.__guard.ready(); }, theme);
  const favorites = page.getByTestId("favorites-page");
  await favorites.locator("tbody tr").first().waitFor();
  const rows = await favorites.locator("tbody tr").count();
  const requests = await page.evaluate(() => window.__guard.favoritesRequestCount());
  const scroll = page.getByTestId("favorites-scroll-root");
  await scroll.evaluate((node) => { node.scrollTop = 450; node.dispatchEvent(new Event("scroll")); });
  const offset = await scroll.evaluate((node) => node.scrollTop);
  const nav = (name) => page.getByTestId("nav-list").getByRole("button", { name, exact: true });

  const frames = await recordVisualFrames(page, '[data-testid="page-scroll"]', () => nav("本地歌曲").click());
  const ys = frames.filter((frame) => frame.present).map((frame) => frame.rect.y);
  add(theme + "-motion-page-entry", Math.max(...ys) - Math.min(...ys) > 2 && frames.at(-1).opacity === 1,
    JSON.stringify({ range: Math.max(...ys) - Math.min(...ys), lastOpacity: frames.at(-1).opacity }));
  add(theme + "-motion-single-content-layer", frames.filter((frame) => frame.tableWrapperOpacity !== null)
    .every((frame) => frame.tableWrapperOpacity === 1), "新页面与表格不叠两层透明度");

  await recordVisualFrames(page, '[data-testid="favorites-page"]', () => nav("我的收藏").click());
  add(theme + "-motion-resident-preserved", await favorites.locator("tbody tr").count() === rows
    && await scroll.evaluate((node) => node.scrollTop) === offset
    && await page.evaluate(() => window.__guard.favoritesRequestCount()) === requests, "常驻收藏与滚动位置保留，不重复取第一页");

  await page.evaluate(async () => {
    const labels = ["播放历史", "本地歌曲", "设置"];
    for (const label of labels) {
      const buttons = [...document.querySelectorAll('[data-testid="nav-list"] button')];
      buttons.find((node) => node.textContent.trim() === label).click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await page.getByTestId("settings-page").waitFor();
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector('[data-testid="page-scroll"]'));
    return style.opacity === "1" && style.transform === "none";
  });
  add(theme + "-motion-last-navigation", await page.getByTestId("settings-page").isVisible(), "快速切换服从最后输入");
  add(theme + "-motion-settings-default", await page.getByRole("tab", { name: "通用", exact: true }).getAttribute("aria-selected") === "true", "设置初次进入默认通用类");
  const tabs = await recordVisualFrames(page, '[role="tabpanel"][data-state="active"]', () =>
    page.getByRole("tab", { name: "网络", exact: true }).click());
  add(theme + "-motion-settings-tab", tabs.some((frame) => frame.opacity > 0 && frame.opacity < 1)
    && tabs.at(-1).opacity === 1, "设置内容切换有过渡");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  const reduced = await recordVisualFrames(page, '[data-testid="page-scroll"]', () => nav("本地歌曲").click());
  add(theme + "-motion-page-reduced", reduced.filter((frame) => frame.present)
    .every((frame) => frame.opacity === 1 && frame.transform === "none"), "减少动效时换页直接到位");
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
