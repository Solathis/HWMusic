/**
 * 歌词进度同步：rAF 逐帧推给 AMLL，并用 200ms isSeeking 窗口告诉它进度跳转。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LYRICS_SEEK_WINDOW_MS,
  createLyricSync,
  integerMsOf,
  progressPatchOf,
} from "../src/renderer/features/lyrics/lyric-sync.mjs";

/** 手动帧调度器：测试自己决定"哪一帧真的发生"。 */
function manualFrames() {
  const scheduled = new Map();
  let nextId = 0;
  return {
    requestFrame: (callback) => {
      nextId += 1;
      scheduled.set(nextId, callback);
      return nextId;
    },
    cancelFrame: (id) => {
      scheduled.delete(id);
    },
    /** 跑最早排上的那一帧。 */
    runFrame() {
      const entry = [...scheduled.entries()][0];
      if (entry === undefined) return false;
      scheduled.delete(entry[0]);
      entry[1]();
      return true;
    },
    pending: () => scheduled.size,
  };
}

function makeSync({ times = [0], windowMs } = {}) {
  const frames = manualFrames();
  const pushed = [];
  let clock = 1000;
  let reads = 0;
  const sync = createLyricSync({
    readTime: () => {
      const value = times[Math.min(reads, times.length - 1)];
      reads += 1;
      return value;
    },
    push: (patch) => pushed.push(patch),
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    now: () => clock,
    ...(windowMs === undefined ? {} : { windowMs }),
  });
  return { sync, pushed, frames, advance: (ms) => (clock += ms), reads: () => reads };
}

test("常量：isSeeking 窗口是 200ms（旧仓同款结论，写在唯一真源里）", () => {
  assert.equal(LYRICS_SEEK_WINDOW_MS, 200);
});

test("整数毫秒：AMLL 的 currentTime 必须是整数毫秒；读不到数字就不推（不跳回 0）", () => {
  assert.equal(integerMsOf(0), 0);
  assert.equal(integerMsOf(12.5), 13);
  assert.equal(integerMsOf(12.4), 12);
  assert.equal(integerMsOf(-5), 0, "负进度夹到 0");
  assert.equal(integerMsOf(Number.NaN), null);
  assert.equal(integerMsOf(Number.POSITIVE_INFINITY), null);
  assert.equal(integerMsOf(undefined), null);
  assert.equal(integerMsOf("1000"), null, "字符串不是进度：宁可不动，也不要猜");
});

test("推送判定（纯函数）：值没变就不推，值变了或 isSeeking 翻转就推", () => {
  assert.deepEqual(progressPatchOf(null, 1000, false), { time: 1000, isSeeking: false });
  assert.equal(progressPatchOf({ time: 1000, isSeeking: false }, 1000, false), null, "同一值不重复推");
  assert.deepEqual(progressPatchOf({ time: 1000, isSeeking: false }, 1001, false), { time: 1001, isSeeking: false });
  assert.deepEqual(progressPatchOf({ time: 1000, isSeeking: true }, 1000, false), { time: 1000, isSeeking: false });
});

test("逐帧推送：每帧读一次进度，值不变就不推（省一次渲染），变了就推", () => {
  const { sync, pushed, frames, reads } = makeSync({ times: [1000, 1000, 1500] });
  sync.start();
  assert.equal(frames.pending(), 1, "start 之后排了一帧");

  frames.runFrame();
  assert.deepEqual(pushed, [{ time: 1000, isSeeking: false }]);
  frames.runFrame();
  assert.equal(pushed.length, 1, "进度没变就不推（AMLL 内部会自己更新动画）");
  frames.runFrame();
  assert.deepEqual(pushed.at(-1), { time: 1500, isSeeking: false });
  assert.equal(reads(), 3, "每帧读一次进度");

  sync.stop();
  assert.equal(frames.pending(), 0, "stop 之后没有待跑的帧");
});

test("读不到进度的那一帧：不推（不是推 0）", () => {
  const { sync, pushed, frames } = makeSync({ times: [700, Number.NaN] });
  sync.start();
  frames.runFrame();
  frames.runFrame();
  assert.deepEqual(pushed, [{ time: 700, isSeeking: false }], "坏读数不该把歌词打回开头");
});

test("isSeeking 窗口：seek 之后 200ms 内的推送都带 isSeeking=true，过后自动回 false", () => {
  const { sync, pushed, frames, advance } = makeSync({ times: [1000, 2000, 3000, 4000] });
  sync.start();
  frames.runFrame();

  sync.notifySeek();
  frames.runFrame(); // 拖到 2000
  assert.deepEqual(pushed.at(-1), { time: 2000, isSeeking: true });

  advance(199);
  frames.runFrame();
  assert.equal(pushed.at(-1).isSeeking, true, "199ms 时还在拖动窗口里");

  advance(1); // 正好 200ms
  frames.runFrame();
  assert.deepEqual(pushed.at(-1), { time: 4000, isSeeking: false }, "200ms 边界之后窗口关闭");
  assert.equal(sync.isSeeking(), false);
});

test("连续拖动：每次 notifySeek 都续期（窗口不靠 pointerup，拖到窗外松手也算数）", () => {
  const { sync, pushed, frames, advance } = makeSync({ times: [1000, 2000, 3000, 4000, 5000] });
  sync.start();

  for (const _ of [0, 1, 2, 3]) {
    sync.notifySeek();
    advance(150); // 每次都在窗口过期前继续拖
    frames.runFrame();
  }
  assert.equal(pushed.every((patch) => patch.time === 1000 || patch.isSeeking), true);
  assert.equal(pushed.at(-1).isSeeking, true, "拖动过程中一直处于「在跳转」状态");
  assert.equal(sync.isSeeking(), true);

  advance(200);
  frames.runFrame();
  assert.equal(pushed.at(-1).isSeeking, false, "手停下 200ms 后自动收窗");
});

test("seek 到同一毫秒也要推一次：否则 AMLL 不会重排（用户看到歌词没跟过来）", () => {
  const { sync, pushed, frames } = makeSync({ times: [1500, 1500] });
  sync.start();
  frames.runFrame();
  assert.equal(pushed.length, 1);

  sync.notifySeek();
  frames.runFrame();
  assert.equal(pushed.length, 2, "同一位置的一次跳转仍要通知一次");
  assert.deepEqual(pushed.at(-1), { time: 1500, isSeeking: true });
});

test("start/stop 幂等：重复 start 只排一帧；stop 两次不抛；stop 后 start 能恢复", () => {
  const { sync, frames, pushed } = makeSync({ times: [1, 2, 3] });
  sync.start();
  sync.start();
  assert.equal(frames.pending(), 1, "重复 start 不该排两帧");

  sync.stop();
  sync.stop();
  assert.equal(frames.pending(), 0);
  assert.equal(sync.running(), false);

  sync.start();
  assert.equal(sync.running(), true);
  frames.runFrame();
  assert.equal(pushed.length, 1);

  sync.stop();
  assert.equal(frames.runFrame(), false, "stop 之后没有帧可跑");
});

test("窗口可注入：windowMs=0 时只有「seek 那一帧」标注跳转，下一帧立刻回落", () => {
  const { sync, pushed, frames, advance } = makeSync({ times: [100, 200, 200], windowMs: 0 });
  sync.start();
  frames.runFrame();
  assert.equal(pushed.at(-1).isSeeking, false, "没 seek 过就没什么可标注的");

  sync.notifySeek();
  frames.runFrame();
  assert.equal(pushed.at(-1).isSeeking, true, "发生 seek 的那一帧必须标注（否则 AMLL 不重排）");

  advance(1);
  frames.runFrame();
  assert.equal(pushed.at(-1).isSeeking, false, "窗口为 0：下一帧就回落");
});
