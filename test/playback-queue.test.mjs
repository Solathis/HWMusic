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

const COVER = "https://music.dbankcdn.cn/cover/1.jpg";
const SONG = { id: "1001", name: "示例曲目", singer: "示例歌手", albumId: "album-1", albumName: "示例专辑", duration: 215, coverUrl: COVER };
const SNAPSHOT = { id: "1001", name: "示例曲目", artists: "示例歌手", duration: 215, coverUrl: COVER, albumId: "album-1", albumName: "示例专辑" };
const emptyEntry = (id) => ({ id, name: null, artists: null, duration: null, coverUrl: null, albumId: null, albumName: null });

test("队列投影保留安全封面与专辑，只输出白名单字段", () => {
  const entry = queueEntryOf({ ...SONG, audioURL: "https://secret.invalid/signed?token=secret", token: "secret", raw: { credentials: "secret" } });
  assert.deepEqual(entry, SNAPSHOT);
  assert.doesNotMatch(JSON.stringify(entry), /audioURL|secret|token|raw/);
  assert.equal(queueEntryOf({ name: "无 id" }), null);
  assert.equal(queueEntryOf(null), null);
  assert.equal(queueEntryOf("不是对象"), null);
  assert.deepEqual(queueEntryOf({ id: "2" }), emptyEntry("2"));
});

test("危险 coverUrl 不进队列，包括 userinfo、非白名单、明文和 data URL", () => {
  for (const coverUrl of ["https://evil.invalid/a.jpg", "https://user:pass@music.dbankcdn.cn/a.jpg", "http://music.dbankcdn.cn/a.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
    assert.equal(queueEntryOf({ ...SONG, coverUrl }).coverUrl, null);
  }
});

test("条目列表保持顺序和重复，只丢无标识项", () => {
  const entries = queueEntriesOf([SONG, { name: "无 id" }, { id: "1002" }, SONG, null]);
  assert.deepEqual(entries.map((entry) => entry.id), ["1001", "1002", "1001"]);
});

test("持久化带按 ids 对齐的可选白名单 metadata，signed 音频 URL 与凭据永不落盘", () => {
  const record = queueRecordOf([{ ...SONG, audioURL: "https://secret.invalid", url: "https://music.dbankcdn.cn/audio.mp3?token=secret", token: "secret" }, { id: "1002" }], 1);
  assert.deepEqual(record, { ids: ["1001", "1002"], index: 1, metadata: [SNAPSHOT, null] });
  assert.doesNotMatch(JSON.stringify(record), /audioURL|audio\.mp3|secret|token|"url"/);
  assert.deepEqual(queueRecordOf([{ id: "1002" }], 0), { ids: ["1002"], index: 0 }, "空元信息不写 metadata");
  assert.equal(queueRecordOf([], 0), null);
  assert.equal(queueRecordOf(null, 3), null);
});

test("索引夹到合法范围；元信息数量不超过有效队列长度", () => {
  const entries = queueEntriesOf([SONG, { id: "1002" }]);
  for (const [raw, expected] of [[99, 1], [-5, 0], [1.7, 1], [null, 0]]) {
    assert.equal(queueRecordOf(entries, raw).index, expected);
  }
  assert.equal(QUEUE_SETTING_KEY, "queue");
});

test("旧 ids/index 记录兼容，顶层任意字段不带进恢复结果", () => {
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "2"], index: 9 }), { ids: ["1", "2"], index: 1 });
  assert.deepEqual(sanitizeQueueRecord({ ids: ["1", "  ", ""], index: -1, url: COVER }), { ids: ["1"], index: 0 });
  for (const bad of [null, undefined, 42, "queue", [], {}, { ids: [] }, { ids: "1" }, { ids: [1, 2] }, { index: 0 }]) {
    assert.equal(sanitizeQueueRecord(bad), null);
  }
  assert.deepEqual(restoredEntries({ ids: ["1001", "1002"], index: 1 }), [emptyEntry("1001"), emptyEntry("1002")]);
  assert.deepEqual(restoredEntries(null), []);
});

test("metadata 仅收对应 id 的安全快照，过滤坏 id 时仍保留原始位置对应", () => {
  const raw = {
    ids: ["1001", "", "1002", "1003"], index: 0,
    metadata: [
      { ...SNAPSHOT, audioURL: "https://secret.invalid", token: "secret", avatarUrl: "https://evil.invalid/a.jpg" },
      { ...SNAPSHOT, id: "1002" },
      { ...SNAPSHOT, id: "wrong" },
      { ...SNAPSHOT, id: "1003", coverUrl: "https://evil.invalid/a.jpg" },
      SNAPSHOT,
    ],
  };
  const clean = sanitizeQueueRecord(raw);
  assert.deepEqual(clean, { ids: ["1001", "1002", "1003"], index: 0, metadata: [SNAPSHOT, null, { ...SNAPSHOT, id: "1003", coverUrl: null }] });
  assert.deepEqual(restoredEntries(raw), [SNAPSHOT, emptyEntry("1002"), { ...SNAPSHOT, id: "1003", coverUrl: null }]);
  assert.doesNotMatch(JSON.stringify(clean), /secret|token|audioURL|avatarUrl|evil/);
});

test("metadata 访问器不执行，也不从继承字段恢复元信息", () => {
  let reads = 0;
  const metadata = { id: "1", name: "真实名" };
  for (const field of ["coverUrl", "artists", "duration", "albumId", "albumName", "audioURL"]) {
    Object.defineProperty(metadata, field, { enumerable: true, get() { reads += 1; throw new Error("不能调用访问器"); } });
  }
  const clean = sanitizeQueueRecord({ ids: ["1", "2"], index: 0, metadata: [metadata, Object.create({ id: "2", name: "继承名", coverUrl: COVER })] });
  assert.deepEqual(clean, { ids: ["1", "2"], index: 0, metadata: [{ ...emptyEntry("1"), name: "真实名" }, null] });
  assert.equal(reads, 0);
  const accessorRecord = Object.defineProperty({}, "ids", { get() { reads += 1; return ["1"]; } });
  assert.equal(sanitizeQueueRecord(accessorRecord), null);
  assert.equal(reads, 0);
});
