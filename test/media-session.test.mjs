/**
 * R9 Media Session 对接（`features/playback/media-session.mjs`）。
 *
 * 这是**浏览层能力**（不涉新权限、不起新窗口）：系统媒体控件/耳机按键/SMTC 通过
 * `navigator.mediaSession` 把"播放/暂停/上一首/下一首/跳到某一秒"交给我们。
 *
 * 三条纪律：
 * 1. **没有这个 API 就静默降级**（Linux webview 与部分环境没有它）：不抛、不报错、
 *    只回"没接上"，播放本身照常；
 * 2. **不支持的动作要跳过但留痕**：`setActionHandler` 对未知动作会抛（规范如此），
 *    一个动作失败不该让其余动作一起失效；
 * 3. **元数据里不放封面**：封面地址字段尚未确认，而 AMLL/系统的取图路径要过 CSP
 *    （`connect-src`/`img-src`）——没有的字段就别编一个 URL 出来。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_SESSION_ACTIONS,
  createMediaSession,
  mediaPlaybackStateOf,
} from "../src/renderer/features/playback/media-session.mjs";
import { PLAYER_STATUS } from "../src/renderer/features/playback/player.mjs";

/** 假的 navigator.mediaSession：记录接线与元数据。 */
function fakeSession({ reject = [] } = {}) {
  const handlers = new Map();
  const assigned = [];
  let playbackState = "none";
  const session = {
    setActionHandler(action, handler) {
      if (reject.includes(action)) throw new Error(`不支持的媒体动作：${action}`);
      handlers.set(action, handler);
    },
    set metadata(value) {
      assigned.push(value);
    },
    get metadata() {
      return assigned.at(-1) ?? null;
    },
    get playbackState() {
      return playbackState;
    },
    set playbackState(value) {
      playbackState = value;
    },
  };
  return { session, handlers, assigned, state: () => playbackState };
}

class FakeMetadata {
  constructor(init) {
    this.init = init;
  }
}

const TRACK = { id: "1001", name: "示例曲目", artists: "示例歌手", duration: 215 };

test("动作表是唯一真源：播放/暂停/上一首/下一首/跳转五项", () => {
  assert.deepEqual(MEDIA_SESSION_ACTIONS, ["play", "pause", "nexttrack", "previoustrack", "seekto"]);
});

test("状态映射：playing → playing，paused/loading → paused，其余 → none（不假装在播）", () => {
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.playing), "playing");
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.paused), "paused");
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.loading), "paused");
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.idle), "none");
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.ended), "none");
  assert.equal(mediaPlaybackStateOf(PLAYER_STATUS.error), "none");
  assert.equal(mediaPlaybackStateOf("认不出的状态"), "none");
});

test("没有 mediaSession 的环境：静默降级（不抛、不接线、update 回 false）", () => {
  const log = [];
  const lib = createMediaSession({ session: null, log: (...parts) => log.push(parts.join(" ")) });

  assert.deepEqual(lib.attach({ play: () => {} }), { attached: false, actions: [] });
  assert.equal(lib.update({ track: TRACK, status: PLAYER_STATUS.playing }), false);
  assert.equal(lib.clear(), false);
  assert.deepEqual(log, [], "没有这个能力不是错误，不该刷日志");
});

test("接线：五个动作都注册上，触发 handler 就回调宿主（seekto 的秒要换算成毫秒）", () => {
  const { session, handlers } = fakeSession();
  const calls = [];
  const lib = createMediaSession({ session, metadataCtor: FakeMetadata, log: () => {} });

  const attached = lib.attach({
    play: () => calls.push(["play"]),
    pause: () => calls.push(["pause"]),
    next: () => calls.push(["next"]),
    previous: () => calls.push(["previous"]),
    seek: (ms) => calls.push(["seek", ms]),
  });

  assert.equal(attached.attached, true);
  assert.deepEqual([...attached.actions].sort(), [...MEDIA_SESSION_ACTIONS].sort());

  handlers.get("play")();
  handlers.get("pause")();
  handlers.get("nexttrack")();
  handlers.get("previoustrack")();
  handlers.get("seekto")({ seekTime: 12.5 });
  handlers.get("seekto")({});
  assert.deepEqual(calls, [
    ["play"],
    ["pause"],
    ["next"],
    ["previous"],
    ["seek", 12_500],
    ["seek", 0],
  ]);
});

test("不支持的动作：跳过并留痕，其余动作照常接线（一个失败不带倒全部）", () => {
  const { session, handlers } = fakeSession({ reject: ["seekto"] });
  const log = [];
  const lib = createMediaSession({ session, metadataCtor: FakeMetadata, log: (...parts) => log.push(parts.join(" ")) });

  const attached = lib.attach({ play: () => {}, seek: () => {} });
  assert.equal(attached.attached, true);
  assert.deepEqual(attached.actions.includes("seekto"), false);
  assert.ok(attached.actions.includes("play"));
  assert.equal(handlers.has("play"), true);
  assert.ok(
    log.some((line) => line.includes("seekto")),
    `跳过的动作要留痕（否则"系统里没有快进"永远查不出来）：${JSON.stringify(log)}`,
  );
});

test("update：元数据只有标题/艺人（不编封面、不编专辑），playbackState 跟着状态走", () => {
  const { session, assigned, state } = fakeSession();
  const lib = createMediaSession({ session, metadataCtor: FakeMetadata, log: () => {} });

  assert.equal(lib.update({ track: TRACK, status: PLAYER_STATUS.playing }), true);
  assert.deepEqual(assigned.at(-1).init, { title: "示例曲目", artist: "示例歌手" });
  assert.equal("artwork" in assigned.at(-1).init, false, "封面地址字段未确认，不许编一个 URL");
  assert.equal(state(), "playing");

  lib.update({ track: TRACK, status: PLAYER_STATUS.paused });
  assert.equal(state(), "paused");

  // 恢复出来的队列只有标识：标题如实显示"曲目 <id>"，不冒充歌名
  lib.update({ track: { id: "2002", name: null, artists: null }, status: PLAYER_STATUS.paused });
  assert.equal(assigned.at(-1).init.title, "曲目 2002");

  lib.update({ track: null, status: PLAYER_STATUS.idle });
  assert.equal(assigned.at(-1).init.title, "未在播放");
  assert.equal(state(), "none");
});

test("clear：摘掉全部动作、元数据清空、状态回 none（暂停收场时系统控件不该留着一个幽灵）", () => {
  const { session, handlers, assigned, state } = fakeSession();
  const lib = createMediaSession({ session, metadataCtor: FakeMetadata, log: () => {} });
  lib.attach({ play: () => {}, pause: () => {} });
  lib.update({ track: TRACK, status: PLAYER_STATUS.playing });

  const cleared = lib.clear();
  assert.equal(cleared, true);
  assert.equal(assigned.at(-1), null, "元数据置空");
  assert.equal(state(), "none");
  for (const action of MEDIA_SESSION_ACTIONS) {
    assert.equal(handlers.get(action), null, `${action} 应当被摘掉（传 null）`);
  }
});
