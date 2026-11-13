// Synthetic contract fixtures; none of these are claimed as live account evidence.
export const PLAYBACK_QUALITY_CASES = Object.freeze({
  standard: { fields: { playQuality: "1", type: "mp3" }, text: "标准音质" },
  high: { fields: { playQuality: "2", type: "mp3" }, text: "高音质" },
  lossless: { fields: { playQuality: "3", type: "flac" }, text: "无损音质" },
  format_only: { fields: { playQuality: "2", format: "MP3" }, text: "高音质" },
  empty_primary: { fields: { playQuality: "", qualityType: 2, type: "mp3" }, text: "高音质" },
  conflict: { fields: { playQuality: "3", type: "flac", format: "mp3" }, text: "音质未知" },
  missing: { fields: {}, text: "音质未知" },
  slow_high: { fields: { playQuality: "2", format: "mp3" }, delayMs: 250, text: "高音质" },
  local: { fields: {}, text: "本地音频" },
  error: { fields: { fileURL: "https://invalid.example/fixture" }, text: null },
});

export async function runPlaybackQualityChecks({ page, add, theme }) {
  for (const key of ["standard", "high", "lossless", "format_only", "empty_primary", "conflict", "missing"]) {
    const expected = PLAYBACK_QUALITY_CASES[key].text;
    await page.evaluate((caseKey) => window.__guard.playQualityCase(caseKey), key);
    await page.waitForFunction((text) => document.querySelector('[data-testid="player-bar-quality"]')?.textContent?.trim() === text, expected);
    if (await page.getByTestId("playback-stage").count() === 0) {
      await page.getByRole("button", { name: "歌词", exact: true }).click();
    }
    await page.waitForFunction((text) => document.querySelector('[data-testid="playback-stage-quality"]')?.textContent?.trim() === text, expected);
    const values = await page.evaluate(() => ({
      bar: document.querySelector('[data-testid="player-bar-quality"]')?.textContent?.trim(),
      stage: document.querySelector('[data-testid="playback-stage-quality"]')?.textContent?.trim(),
      quality: window.__guard.snapshot().quality,
    }));
    add(theme + "-quality-wire-" + key, values.bar === expected && values.stage === expected, JSON.stringify(values));
  }

  await page.evaluate(async () => {
    const earlier = window.__guard.playQualityCase("slow_high");
    await window.__guard.playQualityCase("standard");
    await earlier;
  });
  const last = await page.evaluate(() => ({
    track: window.__guard.snapshot().track?.id,
    quality: window.__guard.snapshot().quality,
  }));
  add(theme + "-quality-latest-request", last.track === "quality-standard" && last.quality === "standard", JSON.stringify(last));

  await page.evaluate(() => window.__guard.playQualityCase("local"));
  await page.waitForFunction(() => document.querySelector('[data-testid="player-bar-quality"]')?.textContent?.trim() === "本地音频");
  add(theme + "-quality-local", await page.getByTestId("playback-stage-quality").textContent() === "本地音频", "本地曲目有中性标识");

  await page.evaluate(() => window.__guard.playQualityCase("error"));
  await page.waitForFunction(() => window.__guard.snapshot().status === "error");
  add(theme + "-quality-error-clears", await page.getByTestId("player-bar-quality").count() === 0
    && await page.getByTestId("playback-stage-quality").count() === 0, "失败清除上一首档位");

  await page.getByRole("button", { name: "收起歌词", exact: true }).click();
  await page.getByTestId("playback-stage").waitFor({ state: "detached" });
  await page.evaluate(async () => {
    window.__guard.setResolvedQuality("lossless");
    await window.__guard.queueWithLongArtist("很长的艺人名字".repeat(30));
  });
  await page.setViewportSize({ width: 960, height: 720 });
  const geometry = await page.evaluate(() => {
    const badge = document.querySelector('[data-testid="player-bar-quality"]');
    const controls = document.querySelector('[data-testid="player-controls"]');
    const trigger = document.querySelector('[data-testid="player-track-info"]');
    return {
      width: badge?.getBoundingClientRect().width ?? 0,
      right: badge?.getBoundingClientRect().right ?? 0,
      controlsLeft: controls?.getBoundingClientRect().left ?? 0,
      nested: Boolean(trigger?.contains(badge)),
    };
  });
  add(theme + "-quality-narrow-independent", geometry.width > 0 && geometry.right < geometry.controlsLeft && !geometry.nested, JSON.stringify(geometry));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { window.__guard.setResolvedQuality(null); return window.__guard.ready(); });
}
