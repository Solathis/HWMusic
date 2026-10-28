/**
 * 本地曲库渲染层的纯投影，判据钉在「不可猜 / 不冒充」。
 * id 形状不对的字符串不当成本地曲目；协议地址只按 id 拼；读不到元数据就用占位。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_AUDIO_FORMATS,
  LOCAL_TRACK_PREFIX,
  describeImportSummary,
  describeRejectedImports,
  describeSkippedLocalTracks,
  isLocalTrackId,
  localCoverUrl,
  localHexId,
  localMediaPath,
  localMediaUrl,
  localSongOf,
  localTrackId,
  normalizeLocalAnswer,
  normalizeLocalBaseUrl,
  unavailableLocalSongIds,
} from "../src/renderer/features/library/local-library.mjs";

/** 128 位随机数的十六进制形状（Rust 侧 `new_track_id` 的产物）。 */
const HEX = "0123456789abcdef0123456789abcdef";

test("前缀与 id 形状：只认 32 位小写十六进制，别的一律不当本地曲目", () => {
  assert.equal(LOCAL_TRACK_PREFIX, "local:");
  assert.equal(localTrackId(HEX), `local:${HEX}`);
  assert.equal(isLocalTrackId(`local:${HEX}`), true);

  for (const bad of [
    null,
    undefined,
    42,
    `local:${HEX.toUpperCase()}`,
    `local:${HEX.slice(0, 31)}`,
    `local:${HEX}0`,
    `local:${HEX}/cover`,
    `local:../../etc/passwd`,
    "local:",
    "local",
    HEX,
    `LOCAL:${HEX}`,
  ]) {
    assert.equal(isLocalTrackId(bad), false, `必须拒绝：${String(bad)}`);
    assert.equal(localHexId(bad), null, `取不出 hex：${String(bad)}`);
  }
  assert.equal(localHexId(`local:${HEX}`), HEX);
  assert.equal(localTrackId("not-a-shape"), null, "形状不对时不许拼一个假 id 出来");
});

test("协议地址：只按 id 拼，路径只有两种形状（音频 / 封面）", () => {
  assert.equal(localMediaPath(HEX, "audio"), `/${HEX}`);
  assert.equal(localMediaPath(HEX, "cover"), `/${HEX}/cover`);
  assert.equal(localMediaPath("nope", "audio"), null);
  assert.equal(localMediaPath(HEX, "traversal"), null);

  // 基址由宿主给（`core_local_base_url`），渲染层只校验形态：Windows 一种、mac/Linux 一种
  assert.equal(normalizeLocalBaseUrl("http://hwlocal.localhost"), "http://hwlocal.localhost");
  assert.equal(normalizeLocalBaseUrl("hwlocal://localhost"), "hwlocal://localhost");
  assert.equal(normalizeLocalBaseUrl("http://hwlocal.localhost/"), "http://hwlocal.localhost", "末尾斜杠要吞掉");
  for (const bad of [null, "", "https://evil.example", "http://localhost", "hwlocal://evil.example", 42]) {
    assert.equal(normalizeLocalBaseUrl(bad), null, `必须拒绝基址：${String(bad)}`);
  }

  assert.equal(localMediaUrl("http://hwlocal.localhost", HEX), `http://hwlocal.localhost/${HEX}`);
  assert.equal(localCoverUrl("hwlocal://localhost", HEX), `hwlocal://localhost/${HEX}/cover`);
  // 基址末尾多一个斜杠不该拼出双斜杠（宿主给什么都要能吞下）
  assert.equal(localMediaUrl("http://hwlocal.localhost/", HEX), `http://hwlocal.localhost/${HEX}`);
  assert.equal(localMediaUrl(null, HEX), null, "没有基址就不给地址（绝不回落到写死的域）");
  assert.equal(localMediaUrl("https://evil.example", HEX), null, "基址形状不对就不拼");
});

test("行投影：Rust 命令的应答 → 曲目表的行（id 带前缀、封面走协议）", () => {
  const song = localSongOf(
    {
      id: HEX,
      title: "夜的第七章",
      artists: "周杰伦",
      album: "依然范特西",
      duration: 287.5,
      format: "flac",
      available: true,
      hasCover: true,
    },
    "http://hwlocal.localhost",
  );

  assert.deepEqual(song, {
    id: `local:${HEX}`,
    localId: HEX,
    name: "夜的第七章",
    artists: "周杰伦",
    albumName: "依然范特西",
    duration: 287.5,
    coverUrl: `http://hwlocal.localhost/${HEX}/cover`,
    format: "flac",
    available: true,
  });
});

test("行投影：读不到元数据就如实占位，不编标题；没有封面就不给地址", () => {
  const song = localSongOf(
    { id: HEX, title: null, artists: null, album: null, duration: null, format: "mp3", available: false, hasCover: false },
    "http://hwlocal.localhost",
  );
  assert.equal(song.name, "未知歌曲");
  assert.equal(song.artists, "未知艺人");
  assert.equal(song.albumName, null, "专辑没有就是没有：不写占位（表格里那一列会空着）");
  assert.equal(song.duration, null);
  assert.equal(song.coverUrl, null);
  assert.equal(song.available, false);
});

test("行投影：认不出的记录直接丢掉（不造半行数据）", () => {
  assert.equal(localSongOf(null, "http://hwlocal.localhost"), null);
  assert.equal(localSongOf({ id: "short" }, "http://hwlocal.localhost"), null);
  assert.equal(localSongOf({ id: HEX }, null), null, "没有基址就拼不出封面：整行不做（不假装能播）");
});

test("命令应答归一：tracks/available 两档，坏形状回空列表而不是抛", () => {
  const answer = normalizeLocalAnswer(
    { tracks: [{ id: HEX, title: "A", available: true }, { id: "bad" }], available: true },
    "http://hwlocal.localhost",
  );
  assert.equal(answer.tracks.length, 1, "形状不对的记录不进列表");
  assert.deepEqual(answer.baseUrl, "http://hwlocal.localhost");
  assert.deepEqual(normalizeLocalAnswer(null, "http://hwlocal.localhost").tracks, []);
  assert.deepEqual(normalizeLocalAnswer({}, "http://hwlocal.localhost").tracks, []);
});

test("不可用的行要被点出来（文件不在 = 不能播，但还在库里，可以移除）", () => {
  const songs = [
    localSongOf({ id: HEX, title: "A", available: false }, "http://hwlocal.localhost"),
    localSongOf({ id: "f".repeat(32), title: "B", available: true }, "http://hwlocal.localhost"),
  ];
  assert.deepEqual(unavailableLocalSongIds(songs), [`local:${HEX}`]);
  assert.deepEqual(unavailableLocalSongIds([]), []);
  assert.deepEqual(unavailableLocalSongIds(null), []);
});

test("格式白名单与 Rust 侧同源（只有这些能进库：WebView2 放不出来的格式在导入时就拒绝）", () => {
  assert.deepEqual([...LOCAL_AUDIO_FORMATS], ["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"]);
});

test("导入结果文案：说清加了几首、跳过了什么，理由带格式后缀", () => {
  assert.equal(describeImportSummary({ added: 2, updated: 1, rejected: [] }), "已导入 2 首（1 首已在库中，已更新信息）");
  assert.equal(describeImportSummary({ added: 0, updated: 0, rejected: [] }), "没有导入新的歌曲。");
  assert.equal(
    describeRejectedImports([{ name: "song.ape", reason: "格式不支持" }]),
    "「song.ape」没有导入：格式不支持",
  );
  assert.equal(describeRejectedImports([]), "");
  assert.equal(describeRejectedImports(null), "");
  assert.equal(
    describeRejectedImports([
      { name: "a.ape", reason: "格式不支持" },
      { name: "b.wma", reason: "格式不支持" },
    ]),
    "「a.ape」「b.wma」没有导入：格式不支持",
  );
});

test("队列恢复的提示：跳过几首要说一句，一句都不跳就别说", () => {
  assert.equal(describeSkippedLocalTracks(0), "");
  assert.equal(describeSkippedLocalTracks(2), "2 首本地歌曲的文件已不在，已从队列跳过。");
  assert.equal(describeSkippedLocalTracks(null), "");
});
