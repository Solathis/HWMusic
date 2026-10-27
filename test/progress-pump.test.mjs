import assert from "node:assert/strict";
import test from "node:test";

import { createProgressPump } from "../src/renderer/features/lyrics/progress-pump.mjs";
import { progressOf } from "../src/renderer/features/lyrics/lyrics-window.mjs";

/** 夹具照播放器的形状：subscribe 返回退订函数，push 记下每一帧（节流不在这里测）。 */
function harness(initialState) {
  const listeners = new Set();
  let state = initialState;
  const pushed = [];
  const stop = createProgressPump({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readState: () => state,
    push: (progress) => pushed.push(progress),
  });
  return {
    pushed,
    subscribers: () => listeners.size,
    /** 播放器发一次通知（先换状态，再叫醒订阅者，与 `publish` 同序）。 */
    notify(next) {
      if (next !== undefined) state = next;
      for (const listener of [...listeners]) listener(state);
    },
    stop,
  };
}

const PAUSED = { currentTimeMs: 700, status: "paused", seekGeneration: 0 };

test("进度泵全程不碰 requestAnimationFrame", () => {
  const frames = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return 0;
  };
  try {
    const pump = harness(PAUSED);
    pump.notify({ currentTimeMs: 1200, status: "playing", seekGeneration: 0 });
    pump.notify({ currentTimeMs: 2200, status: "playing", seekGeneration: 0 });
    pump.stop();
    assert.equal(pump.subscribers(), 0, "退订后不该还挂着订阅");
  } finally {
    globalThis.requestAnimationFrame = original;
  }
  assert.deepEqual(frames, [], "进度泵不该再排帧回调");
});

test("播放、时间更新、暂停、跳转各推一帧，且值就是 progressOf 的结果", () => {
  const states = [
    { currentTimeMs: 700, status: "playing", seekGeneration: 0 },
    { currentTimeMs: 1700, status: "playing", seekGeneration: 0 },
    { currentTimeMs: 1700, status: "paused", seekGeneration: 0 },
    { currentTimeMs: 3000, status: "playing", seekGeneration: 1 },
  ];
  const pump = harness(PAUSED);
  for (const state of states) pump.notify(state);
  pump.stop();

  assert.equal(pump.pushed.length, states.length, "每次通知推一帧，不多不少");
  assert.deepEqual(pump.pushed, states.map((state) => progressOf(state)));
  assert.deepEqual(pump.pushed, [
    { timeMs: 700, playing: true, seekGeneration: 0 },
    { timeMs: 1700, playing: true, seekGeneration: 0 },
    { timeMs: 1700, playing: false, seekGeneration: 0 },
    { timeMs: 3000, playing: true, seekGeneration: 1 },
  ]);
});

test("退订之后不再推送", () => {
  const pump = harness(PAUSED);
  pump.notify({ currentTimeMs: 1000, status: "playing", seekGeneration: 0 });
  pump.stop();
  const afterStop = pump.pushed.length;
  pump.notify({ currentTimeMs: 2000, status: "playing", seekGeneration: 0 });
  assert.equal(afterStop, 1);
  assert.equal(pump.pushed.length, 1, "退订后的通知不该再推");
});
