/**
 * R9 播放器文案（`features/playback/playback-state.mjs`）：**克制、不冒充、可执行**。
 *
 * 与 R8 的 `library-state.mjs` 同一条纪律，三类不能混：
 * 1. **接口没配**（`endpoint_unknown`）≠ "这首歌放不了"——后者听起来像歌的问题；
 * 2. **队列空** ≠ "播放失败"——前者要告诉用户下一步做什么；
 * 3. **还没有歌词来源** ≠ "这首歌没有歌词"——把前者说成后者，就是替没接上的接口撒谎。
 *
 * 另外两条硬约束：句长克制、禁画饼（"敬请期待/即将上线"这类词由本测试禁掉）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PLAYBACK_FAILURE_TEXT,
  PLAYBACK_MODE_LABELS,
  PLAYER_STATUS_TEXT,
  LYRICS_NOTICE_TEXT,
  lyricsNoticeText,
  playbackFailureText,
  playbackModeLabel,
  playerStatusText,
  trackArtistOf,
  trackTitleOf,
} from "../src/renderer/features/playback/playback-state.mjs";
import { PLAYBACK_MODES, PLAYER_STATUS } from "../src/renderer/features/playback/player.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(`${repoRoot}src/renderer/features/playback/playback-state.mjs`, "utf8");
/** 只扫代码不扫注释：注释里写"禁画饼"是说明文字。 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("失败文案：接口没配说「未配置」，队列空说下一步做什么（两种不许混成一句话）", () => {
  assert.match(PLAYBACK_FAILURE_TEXT.endpoint_unknown, /尚未配置/);
  assert.match(PLAYBACK_FAILURE_TEXT.endpoint_unknown, /待联调确认/);
  assert.doesNotMatch(PLAYBACK_FAILURE_TEXT.endpoint_unknown, /播放失败|这首歌/);

  assert.match(PLAYBACK_FAILURE_TEXT.queue_empty, /双击/, "空队列要告诉用户怎么开始，而不是报错");
  assert.doesNotMatch(PLAYBACK_FAILURE_TEXT.queue_empty, /失败/);

  assert.match(PLAYBACK_FAILURE_TEXT.unsafe_media_url, /拒绝装载/);
  assert.match(PLAYBACK_FAILURE_TEXT.audio_error, /音频播放失败/);
});

test("失败文案的形态：句末句号、长度克制、不画饼", () => {
  const entries = Object.entries(PLAYBACK_FAILURE_TEXT).filter(([kind]) => kind !== "audio_error");
  for (const [kind, text] of entries) {
    assert.ok(text.length <= 30, `${kind} 的文案太长（${text.length}）：${text}`);
    assert.ok(text.endsWith("。") || text.endsWith("…"), `${kind} 的文案要以句号收尾：${text}`);
  }
  assert.doesNotMatch(code, /敬请期待|即将上线|稍后支持|coming soon/i, "页面已经在那里了，不画饼");
});

test("playbackFailureText：认得的类别走表，认不得的带上 core 那句话（不丢掉唯一线索）", () => {
  assert.equal(playbackFailureText({ kind: "endpoint_unknown" }), PLAYBACK_FAILURE_TEXT.endpoint_unknown);
  assert.equal(playbackFailureText({ kind: "queue_empty" }), PLAYBACK_FAILURE_TEXT.queue_empty);
  assert.equal(
    playbackFailureText({ kind: "login_required", message: "会话已过期" }),
    "播放失败：会话已过期",
    "认不出的类别要带上原因，否则用户无从自查",
  );
  assert.match(playbackFailureText(null), /详情见日志/);
  assert.match(playbackFailureText({ kind: "whatever", message: "   " }), /详情见日志/);
});

test("playerStatusText：有错误时优先说错误（接口未配置不会被「未在播放」盖住）", () => {
  assert.equal(playerStatusText({ status: PLAYER_STATUS.playing, error: null }), PLAYER_STATUS_TEXT.playing);
  assert.equal(playerStatusText({ status: PLAYER_STATUS.paused, error: null }), PLAYER_STATUS_TEXT.paused);
  assert.equal(
    playerStatusText({ status: PLAYER_STATUS.error, error: { kind: "endpoint_unknown" } }),
    PLAYBACK_FAILURE_TEXT.endpoint_unknown,
  );
  assert.equal(playerStatusText({ status: "认不出的状态", error: null }), PLAYER_STATUS_TEXT.idle);
  assert.equal(playerStatusText(null), PLAYER_STATUS_TEXT.idle);
  for (const status of Object.values(PLAYER_STATUS)) {
    assert.equal(typeof PLAYER_STATUS_TEXT[status], "string", `每个状态都要有文案：${status}`);
  }
});

test("标题：只知道标识就显示标识（恢复出来的队列不许显示成「未知歌曲」）", () => {
  assert.equal(trackTitleOf({ id: "1001", name: "晴天" }), "晴天");
  assert.equal(trackTitleOf({ id: "1001", name: null }), "曲目 1001", "裁决只存了标识：如实显示标识");
  assert.equal(trackTitleOf({ id: "1001", name: "  " }), "曲目 1001");
  assert.equal(trackTitleOf({ name: null }), "未知歌曲");
  assert.equal(trackTitleOf(null), "未在播放");
});

test("艺人：取不到就「未知艺人」；没有曲目时给空串（不显示一行「未知艺人」占位）", () => {
  assert.equal(trackArtistOf({ artists: "周杰伦" }), "周杰伦");
  assert.equal(trackArtistOf({ artists: null }), "未知艺人");
  assert.equal(trackArtistOf(null), "");
});

test("歌词占位：三档分开（没有来源 ≠ 这首歌没有歌词）", () => {
  // R12 起频道已接上，所以"尚未接入"不再成立——端点是可能缺的那一环，文案改说"尚未配置"；
  // 其他失败（网络/HTTP）另有一档，不许冒充成"没配置"。
  assert.match(LYRICS_NOTICE_TEXT.unavailable, /尚未配置/);
  assert.match(LYRICS_NOTICE_TEXT.empty, /没有歌词/);
  assert.match(LYRICS_NOTICE_TEXT.loading, /正在取|取歌词/);
  assert.ok(!/尚未配置/.test(LYRICS_NOTICE_TEXT.failed), "取不到 ≠ 没配置（两句不同的话）");
  assert.equal(lyricsNoticeText({ status: "ready", lines: [{}] }), null, "有词时不该再压一行占位字");
  assert.equal(lyricsNoticeText({ status: "empty" }), LYRICS_NOTICE_TEXT.empty);
  assert.equal(lyricsNoticeText({ status: "unavailable" }), LYRICS_NOTICE_TEXT.unavailable);
  assert.equal(lyricsNoticeText({ status: "failed" }), LYRICS_NOTICE_TEXT.failed);
  assert.equal(lyricsNoticeText(null), LYRICS_NOTICE_TEXT.unavailable, "状态不知道时按「没有来源」说，不替接口撒谎");
});

test("模式标签：四种模式都有中文标签（与状态机的模式表逐个对齐）", () => {
  for (const mode of PLAYBACK_MODES) {
    assert.equal(typeof PLAYBACK_MODE_LABELS[mode], "string", `模式 ${mode} 缺标签`);
  }
  assert.deepEqual(Object.keys(PLAYBACK_MODE_LABELS).sort(), [...PLAYBACK_MODES].sort(), "标签表不许有第五种模式");
  assert.equal(playbackModeLabel("shuffle"), "随机播放");
  assert.equal(playbackModeLabel("认不出的模式"), PLAYBACK_MODE_LABELS.sequential, "认不出就按默认说");
});
