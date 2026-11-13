export async function recordVisualFrames(page, selector, action) {
  const key = "__motionFrames_" + Math.random().toString(36).slice(2);
  await page.evaluate(({ key, selector }) => {
    const record = { frames: [], done: false, finishAt: null };
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
        scale: (transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a) * (parseFloat(style?.scale) || 1),
        focused: Boolean(node?.contains(document.activeElement)),
        tableWrapperOpacity: node?.querySelector("table")?.parentElement?.parentElement
          ? Number(getComputedStyle(node.querySelector("table").parentElement.parentElement).opacity) : null,
      });
      if (record.finishAt !== null && performance.now() >= record.finishAt) record.done = true;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { key, selector });
  await action();
  await page.evaluate((key) => { window[key].finishAt = performance.now() + 650; }, key);
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
  await runOverlayMotionChecks(context);
}

export async function runOverlayMotionChecks({ page, add, theme }) {
  await page.goto(page.url().split("?")[0], { waitUntil: "load" });
  await page.waitForFunction(() => window.__guard !== undefined);
  await page.evaluate((choice) => { document.documentElement.className = choice; return window.__guard.ready(); }, theme);
  const trigger = page.getByRole("button", { name: "播放队列", exact: true });
  const opening = await recordVisualFrames(page, '[data-slot="sheet-content"]', () => trigger.click());
  const xs = opening.filter((frame) => frame.present).map((frame) => frame.rect.x);
  add(theme + "-motion-queue-space", Math.max(...xs) - Math.min(...xs) > 80, "队列从右侧完整进入");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  const free = await page.evaluate(() => ({
    dialogs: document.querySelectorAll('[data-slot="sheet-content"]').length,
    blocked: getComputedStyle(document.body).pointerEvents === "none",
  }));
  add(theme + "-motion-queue-releases-input", free.dialogs === 0 && !free.blocked, JSON.stringify(free));
  await page.evaluate(() => document.querySelector('button[aria-label="播放队列"]').click());
  await page.locator('[data-slot="sheet-content"]').waitFor();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  add(theme + "-motion-queue-clean", await page.locator('[data-slot="sheet-content"]').count() === 0
    && await page.getByTestId("queue-exit-snapshot").count() === 0
    && await trigger.evaluate((node) => document.activeElement === node), "反向开合后无残留，焦点回到入口");

  const dialogFrames = await recordVisualFrames(page, '[data-slot="alert-dialog-content"]', () =>
    page.getByRole("button", { name: "退出登录", exact: true }).click());
  add(theme + "-motion-dialog-soft", dialogFrames.some((frame) => frame.scale > 1.002), "对话框有轻微回弹");
  const backdrop = await page.locator('[data-slot="alert-dialog-overlay"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  add(theme + "-motion-dialog-backdrop", backdrop.replaceAll(" ", "") !== "rgba(0,0,0,0)", backdrop);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator('[data-slot="alert-dialog-content"]').waitFor({ state: "detached" });

  await page.mouse.move(0, 0);
  await page.getByTestId("player-bar-quality").hover();
  await page.waitForTimeout(100);
  add(theme + "-motion-tooltip-intent", await page.getByRole("tooltip").count() === 0, "短暂划过不弹提示");
  await page.waitForTimeout(400);
  add(theme + "-motion-tooltip-shows", await page.getByRole("tooltip").count() === 1, "明确悬停后显示提示");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  const avatarFrames = await recordVisualFrames(page, '[data-testid="account-avatar"]', () =>
    page.locator('[data-slot="sidebar-trigger"]').click());
  const rail = await page.locator('[data-slot="sidebar-container"]').boundingBox();
  const avatar = await page.getByTestId("account-avatar").boundingBox();
  const avatarXs = avatarFrames.filter((frame) => frame.present).map((frame) => frame.rect.x);
  add(theme + "-motion-sidebar-avatar", Math.max(...avatarXs) - Math.min(...avatarXs) <= 2
    && Math.abs(avatar.x + avatar.width / 2 - (rail.x + rail.width / 2)) <= 2, "头像折叠不跳动，窄轨保持居中");
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.waitForTimeout(350);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  await trigger.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  add(theme + "-motion-overlay-reduced", await page.locator('[data-slot="sheet-content"]').count() === 0
    && await page.getByTestId("queue-exit-snapshot").count() === 0, "减少动效立即开合并释放输入");
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await nav("我的收藏").click();
    const repeat = await recordVisualFrames(page, '[data-testid="page-scroll"]', () => nav("本地歌曲").click());
    const positions = repeat.filter((frame) => frame.present).map((frame) => frame.rect.y);
    add(theme + "-motion-page-repeat-" + attempt, Math.max(...positions) - Math.min(...positions) > 2
      && repeat.at(-1).opacity === 1, "每次新页面挂载都有完整过渡");
  }

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
