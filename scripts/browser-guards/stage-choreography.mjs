async function sampleTransition(page, opening) {
  return page.evaluate(async opening => {
    const samples = [];
    const read = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
      const rect = element.getBoundingClientRect();
      return { opacity: Number(style.opacity), y: matrix.m42, scale: matrix.a, visible: style.visibility === "visible", width: rect.width };
    };
    const start = performance.now();
    const sample = () => samples.push({
      at: performance.now() - start,
      root: read('[data-testid="playback-stage"]'),
      lyrics: read('[data-testid="playback-stage-lyrics-slot"]'),
      controls: read('[data-testid="playback-stage-player"]') ?? null,
      background: read('[data-testid="playback-stage-background"]'),
      cover: read('[data-testid="playback-stage-cover-anchor"]') ?? read('[data-testid="playback-stage-cover"]'),
      flight: read('[data-testid="cover-flight"]'),
      source: read('[data-testid="player-track-info"] img'),
    });
    document.querySelector(opening ? 'button[aria-label="打开歌词"]' : 'button[aria-label="收起歌词"]').click();
    await new Promise(resolve => {
      const frame = () => { sample(); if (performance.now() - start < 850) requestAnimationFrame(frame); else resolve(); };
      requestAnimationFrame(frame);
    });
    return samples;
  }, opening);
}

export async function runStageChoreographyChecks({ page, add, theme }) {
  await page.evaluate(() => window.__guard.ready());
  await page.waitForFunction(() => document.querySelector('[data-testid="player-track-info"] img')?.naturalWidth > 0);
  const avatar = page.getByTestId("account-avatar");
  const expanded = await avatar.boundingBox();
  add(theme + "-avatar-larger", expanded.width === 40 && expanded.height === 40, JSON.stringify(expanded));
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.waitForTimeout(350);
  const collapsed = await avatar.boundingBox();
  const rail = await page.locator('[data-slot="sidebar-container"]').boundingBox();
  add(theme + "-avatar-rail-centered", collapsed.width === 32 && Math.abs(collapsed.x + collapsed.width / 2 - rail.x - rail.width / 2) <= 2, JSON.stringify({ collapsed, rail }));
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.waitForTimeout(350);
  const enter = await sampleTransition(page, true);
  const movingIn = enter.filter(frame => frame.lyrics?.opacity > 0.02 && frame.lyrics?.opacity < 0.98);
  add(theme + "-stage-entry-lift", movingIn.some(frame => frame.lyrics.y > 8) && movingIn.length >= 3, JSON.stringify({ frames: movingIn.length, offsets: movingIn.slice(0, 4).map(frame => frame.lyrics.y) }));
  add(theme + "-stage-single-opacity-owner", movingIn.every(frame => frame.root.opacity === 1), "正文透明度不会再与根节点透明度相乘");
  const movingCover = enter.filter(frame => frame.flight?.visible);
  add(theme + "-stage-cover-enters-continuously", movingCover.length >= 3 && new Set(movingCover.map(frame => Math.round(frame.flight.width))).size >= 3,
    JSON.stringify({ flightFrames: movingCover.length }));
  const exit = await sampleTransition(page, false);
  const movingOut = exit.filter(frame => frame.lyrics?.opacity > 0.02 && frame.lyrics?.opacity < 0.98 && frame.root.visible);
  add(theme + "-stage-exit-lift", movingOut.some(frame => frame.lyrics.y > 4) && movingOut.length >= 3, JSON.stringify({ frames: movingOut.length, offsets: movingOut.slice(0, 4).map(frame => frame.lyrics.y) }));
  add(theme + "-stage-exit-settled", !await page.getByTestId("playback-stage").isVisible() && await page.getByTestId("cover-flight").count() === 0, "退场完成后隐藏，无飞行封面残留");
  const lingeringCover = exit.filter(frame => frame.background?.opacity < 0.02 && (frame.cover?.visible && frame.cover.opacity > 0 || frame.flight?.visible && frame.flight.width > (frame.source?.width ?? 40) * 1.15));
  add(theme + "-stage-no-cover-after-background", lingeringCover.length === 0, JSON.stringify({ lingeringFrames: lingeringCover.length }));
  await page.evaluate(() => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const width = innerWidth;
    document.querySelector('button[aria-label="打开歌词"]').click();
    setTimeout(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width + 16 });
      window.dispatchEvent(new Event("resize"));
      if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth); else delete window.innerWidth;
      window.dispatchEvent(new Event("resize"));
    }, 60);
  });
  await page.waitForTimeout(130);
  add(theme + "-stage-ignores-transient-resize", await page.getByTestId("cover-flight").count() === 1, "窗口外框切换产生的瞬时尺寸不会打断飞行封面");
  await page.waitForTimeout(650);
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
  await page.evaluate(() => document.querySelector('button[aria-label="打开歌词"]').click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelector('button[aria-label="收起歌词"]').click());
  await page.waitForTimeout(65);
  await page.evaluate(() => document.querySelector('button[aria-label="打开歌词"]').click());
  await page.waitForTimeout(750);
  add(theme + "-stage-reverse-clean", await page.getByTestId("playback-stage").isVisible() && await page.getByTestId("cover-flight").count() === 0, "反向开合后最终状态与用户意图一致");
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  const reduced = await sampleTransition(page, true);
  add(theme + "-stage-reduced-immediate", reduced.every(frame => frame.lyrics?.opacity === 1 && frame.lyrics.y === 0) && await page.getByTestId("cover-flight").count() === 0, "减少动效时立即到位");
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.querySelector('button[aria-label="打开歌词"]').click();
    setTimeout(() => document.querySelector('button[aria-label="收起歌词"]')?.click(), 5);
  });
  await page.waitForTimeout(750);
  add(theme + "-stage-cancel-before-entry", !await page.getByTestId("playback-stage").isVisible() && await page.getByTestId("cover-flight").count() === 0, "准备期间立即关闭，也不留下舞台或封面");
  await page.getByTestId("player-bar").getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForTimeout(700);
  const playingEntry = await sampleTransition(page, true);
  const landed = playingEntry.filter(frame => frame.flight).at(-1)?.flight.width;
  const playingCover = await page.getByTestId("playback-stage-cover").boundingBox();
  add(theme + "-playing-cover-handoff-size", landed !== undefined && Math.abs(landed - playingCover.width) < 3,
    JSON.stringify({ landed, actual: playingCover.width }));
  await page.keyboard.press("Escape");
  await page.getByTestId("playback-stage").waitFor({ state: "hidden" });
  await page.evaluate(() => window.__guard.pause());
}
