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
}
