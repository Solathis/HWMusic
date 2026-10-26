/**
 * R65 本地曲目在播放队列里的持久化与恢复（`src/renderer/features/playback/queue.mjs`）。
 * 恢复时多一道闸：文件已经不在的那几首跳过（并给一句提示），不给用户一个永远播不出来的位置。
 * 判据：非本地条目的顺序、当前曲目、进度一律不许被这道闸改动。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dropUnavailableLocalEntries, queueRecordOf, restoredEntries } from "../src/renderer/features/playback/queue.mjs";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const C = "aaaabbbbccccddddeeeeffff00001111";

const local = (hex) => `local:${hex}`;

/** 一条混合队列：在线 → 本地 A → 本地 B → 在线。 */
function mixedRecord(overrides = {}) {
  return {
    ids: ["music-1", local(A), local(B), "music-2"],
    index: 2,
    metadata: [
      { id: "music-1", name: "在线一", artists: "某人", duration: 200 },
      { id: local(A), name: "本地 A", artists: "某人", duration: 100 },
      { id: local(B), name: "本地 B", artists: "某人", duration: 100 },
      { id: "music-2", name: "在线二", artists: "某人", duration: 200 },
    ],
    ...overrides,
  };
}

test("全都还在：队列顺序与当前位置一个字都不改（这道闸只在文件不见时才动手）", () => {
  const record = mixedRecord({ positionMs: 5000, positionTrackId: local(B) });
  const result = dropUnavailableLocalEntries(record, [local(A), local(B)]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.record.ids, record.ids);
  assert.equal(result.record.index, record.index);
  assert.equal(result.record.positionMs, 5000);
  assert.equal(result.record.positionTrackId, local(B));
});

test("当前曲目之前的本地曲目不见了：顺序保持，当前曲目仍然是那一首", () => {
  const result = dropUnavailableLocalEntries(mixedRecord(), [local(B)]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.record.ids, ["music-1", local(B), "music-2"]);
  assert.equal(result.record.ids[result.record.index], local(B), "当前曲目不许因为前面少了一首而漂移");
  assert.deepEqual(
    result.record.metadata.map((entry) => entry.name),
    ["在线一", "本地 B", "在线二"],
    "展示快照跟着 id 一起走（不许错位）",
  );
});

test("当前曲目本身就是不见的那一首：落到前一首上（还在就绝不空手）", () => {
  const result = dropUnavailableLocalEntries(mixedRecord(), [local(A)]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.record.ids, ["music-1", local(A), "music-2"]);
  assert.equal(result.record.ids[result.record.index], local(A), "前一首还在，就退到它");
});

test("进度只跟着活下来的那首走：被丢掉的那首的进度不许留给别人", () => {
  const record = mixedRecord({ positionMs: 42000, positionTrackId: local(B) });
  const result = dropUnavailableLocalEntries(record, [local(A)]);
  assert.equal(result.record.positionMs, undefined);
  assert.equal(result.record.positionTrackId, undefined);
});

test("全都是本地且全都丢了：队列为空（null），跳过数如实统计", () => {
  const onlyLocal = { ids: [local(A), local(B)], index: 1, metadata: [{ id: local(A), name: "A" }] };
  const result = dropUnavailableLocalEntries(onlyLocal, []);
  assert.equal(result.record, null);
  assert.equal(result.skipped, 2);
});

test("非本地条目不受影响（在线曲目没有\"文件在不在\"这回事）", () => {
  const record = { ids: ["music-1", "music-2"], index: 1, metadata: [{ id: "music-1", name: "一" }] };
  const result = dropUnavailableLocalEntries(record, []);
  assert.deepEqual(result.record.ids, ["music-1", "music-2"]);
  assert.equal(result.record.index, 1);
  assert.equal(result.skipped, 0);
});

test("坏记录/空记录：回 null 且不计跳过（不抛）", () => {
  for (const bad of [null, undefined, {}, [], { ids: [] }, { ids: "nope" }]) {
    const result = dropUnavailableLocalEntries(bad, [local(A)]);
    assert.equal(result.record, null, `坏记录必须落下：${String(bad)}`);
    assert.equal(result.skipped, 0);
  }
});

test("过滤后的记录还能重新拼成队列条目（顺序与展示快照都对得上）", () => {
  const result = dropUnavailableLocalEntries(mixedRecord(), [local(A)]);
  const entries = restoredEntries(result.record);
  assert.deepEqual(entries.map((entry) => entry.id), ["music-1", local(A), "music-2"]);
  assert.deepEqual(entries.map((entry) => entry.name), ["在线一", "本地 A", "在线二"]);
  // 再写一次盘也不该长出别的东西（这道闸的输出是合法队列记录）
  assert.deepEqual(queueRecordOf(entries, result.record.index).ids, result.record.ids);
});

test("跳过的提示文案只按数量说话（0 首就闭嘴）", () => {
  const three = { ids: [local(A), local(B), local(C)], index: 0 };
  const result = dropUnavailableLocalEntries(three, [local(C)]);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.record.ids, [local(C)]);
  assert.equal(result.record.index, 0);
});
