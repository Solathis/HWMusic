/**
 * R9 队列与持久化（`features/playback/queue.mjs`）：条目投影 + **只存曲目标识 + 索引**。
 *
 * 这一条是控制器的裁决，也是本任务最容易被"顺手做多"的地方：
 * 队列可以持久化，但**只存曲目标识 + 当前索引**——不存播放地址（时效签名，存下来等于存了个
 * 很快会失效的秘密），也不存标题（裁决写的是"曲目标识 + 当前索引"，多的字段不写）。
 * 这条测试把它钉成结构：写出来的记录**只有两个键**，且任何输入都洗不出第三个键。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_SETTING_KEY,
  queueEntriesOf,
  queueEntryOf,
  queueRecordOf,
  restoredEntries,
  sanitizeQueueRecord,
} from "../src/renderer/features/playback/queue.mjs";

const SONG = {
  id: "1001",
  name: "示例曲目",
  singer: "示例歌手",
  albumName: "示例专辑",
  duration: 215,
};

test("条目投影：id/名/艺人/时长来自展示投影（取不到就是 null，不编值）", () => {
  const entry = queueEntryOf(SONG);
  assert.equal(entry.id, "1001");
  assert.equal(entry.name, "示例曲目");
  assert.equal(entry.artists, "示例歌手");
  assert.equal(entry.duration, 215);
  assert.deepEqual(Object.keys(entry).sort(), ["artists", "duration", "id", "name"]);

  // 缺 id 的条目不存在（没有标识就没法取播放地址）：如实回 null
  assert.equal(queueEntryOf({ name: "无 id" }), null);
  assert.equal(queueEntryOf(null), null);
  assert.equal(queueEntryOf("不是对象"), null);

  // 名字取不到就是 null（不是"未知歌曲"这种文案——文案是 UI 的事，数据层不造文案）
  assert.equal(queueEntryOf({ id: "2" }).name, null);
  assert.equal(queueEntryOf({ id: "2" }).artists, null);
});

test("条目列表：丢掉没有标识的条目（不编 id），保持原顺序", () => {
  const entries = queueEntriesOf([SONG, { name: "无 id" }, { id: "1002", name: "第二首" }, null]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["1001", "1002"],
  );
});

test("持久化记录：**只有 ids + index 两个键**，且绝不含播放地址", () => {
  const entries = queueEntriesOf([SONG, { id: "1002", name: "第二首" }]);
  const record = queueRecordOf(entries, 1);

  assert.deepEqual(Object.keys(record).sort(), ["ids", "index"], "裁决：只存曲目标识 + 当前索引");
  assert.deepEqual(record.ids, ["1001", "1002"]);
  assert.equal(record.index, 1);

  // 结构上不可能带地址：序列化后不含任何 http 痕迹
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /http/i, `记录里出现了疑似地址：${serialized}`);
  assert.doesNotMatch(serialized, /dbankcdn|tingmall|kuke/, "CDN 域同样不许出现");
});

test("持久化记录：空队列 → null（语义 = 删除这个键，settings 的既有约定）", () => {
  assert.equal(queueRecordOf([], 0), null);
  assert.equal(queueRecordOf(null, 3), null);
});

test("持久化记录：索引越界被夹到合法范围（坏索引不该让下次启动播错歌）", () => {
  const entries = queueEntriesOf([SONG, { id: "1002" }]);
  assert.equal(queueRecordOf(entries, 99).index, 1);
  assert.equal(queueRecordOf(entries, -5).index, 0);
  assert.equal(queueRecordOf(entries, 1.7).index, 1, "非整数索引向下取整到合法值");
  assert.equal(queueRecordOf(entries, null).index, 0);
});

test("设置键名是唯一真源里的常量（不是散落的字面量）", () => {
  assert.equal(QUEUE_SETTING_KEY, "queue");
});

test("恢复：任何形状的输入都洗成 null 或 {ids, index}（不允许第三个键漏出去）", () => {
  // 认识得出来
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "2"], index: 1 }), { ids: ["1", "2"], index: 1 });
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "2"], index: 9 }), { ids: ["1", "2"], index: 1 });
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "2"], index: -1 }), { ids: ["1", "2"], index: 0 });

  // 认不出来的一律 null（"没恢复出队列"而不是"恢复出一个空队列"）
  for (const bad of [null, undefined, 42, "queue", [], {}, { ids: [] }, { ids: "1" }, { ids: [1, 2] }, { index: 0 }]) {
    assert.equal(sanitizeQueueRecord(bad), null, `应当洗成 null：${JSON.stringify(bad)}`);
  }

  // 历史/手工写坏的记录：多余的键（含地址）被丢掉，绝不带进内存
  const polluted = sanitizeQueueRecord({ ids: ["1"], index: 0, url: "https://music.dbankcdn.cn/a.mp3", name: "标题" });
  assert.deepEqual(Object.keys(polluted).sort(), ["ids", "index"]);
  assert.equal(polluted.url, undefined);

  // 空白 id 丢掉；全空 → null
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "  ", ""], index: 0 }), { ids: ["1"], index: 0 });
  assert.equal(sanitizeQueueRecord({ ids: ["  "], index: 0 }), null);
});

test("恢复条目：只有标识时标题如实为空（不知道标题就不编一个）", () => {
  const entries = restoredEntries({ ids: ["1001", "1002"], index: 1 });
  assert.deepEqual(entries, [
    { id: "1001", name: null, artists: null, duration: null },
    { id: "1002", name: null, artists: null, duration: null },
  ]);
  assert.deepEqual(restoredEntries(null), []);
});
