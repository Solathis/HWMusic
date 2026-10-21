/**
 * R9 播放状态机（`features/playback/player.mjs`）：单 Audio 实例的全部路径。
 *
 * 这个模块刻意**不碰 DOM、不碰 React、不碰 core_call**：音频端口（audio）、取地址（resolveUrl）、
 * 地址闸门（guardUrl）、持久化（persistQueue/loadQueue）全部注入，所以每条路径都能在 node 里跑完。
 * 四条最要紧的钉：
 * 1. **地址闸门是强制的**（构造时缺 guardUrl 直接 TypeError）：不放行的地址永远不会被装载；
 * 2. **地址不进状态、不进日志**：快照里没有 url（UI 也拿不到），日志里没有域名之外的痕迹；
 * 3. **双击不打架**：两次连点取地址是竞态的，先发后到的结果必须被丢掉（旧仓的经典 bug）；
 * 4. **播完按模式走**：顺序（播完即停）/ 列表循环 / 单曲循环 / 随机，四种各自的下一首不同。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PLAYBACK_MODE,
  DEFAULT_VOLUME,
  PLAYBACK_MODES,
  PLAYER_ERROR_KINDS,
  PLAYER_STATUS,
  createPlayer,
} from "../src/renderer/features/playback/player.mjs";
import { PLAYER_COMMANDS, applyPlayerCommand, isPlayerCommand } from "../src/renderer/features/playback/player-commands.mjs";

const SAFE_URL = "https://music.dbankcdn.cn/song/1.mp3";
const OTHER_SAFE_URL = "https://music.dbankcdn.cn/song/2.mp3";

/** 假音频端口：记录每条指令，"事件"由测试手动派发。 */
function fakeAudio() {
  const handlers = new Map();
  const calls = { sources: [], play: 0, pause: 0, seeks: [], volumes: [], muted: [], disposed: 0 };
  const audio = {
    setSource: (src) => calls.sources.push(src),
    play: () => {
      calls.play += 1;
      return Promise.resolve();
    },
    pause: () => {
      calls.pause += 1;
    },
    setCurrentTime: (ms) => calls.seeks.push(ms),
    setVolume: (value) => calls.volumes.push(value),
    setMuted: (value) => calls.muted.push(value),
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        calls.disposed += 1;
        handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
      };
    },
  };
  return {
    audio,
    calls,
    emit(name, payload) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(payload);
    },
  };
}

const songs = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: String(1000 + index), name: `歌${index}`, singer: "歌手", duration: 200 }));

/** 测试用地址闸门：只放行白名单域（与 CSP media-src 同口径的替身）。 */
const guardUrl = (url) => (typeof url === "string" && url.startsWith("https://music.dbankcdn.cn/") ? url : null);

function makePlayer(options = {}) {
  const fake = fakeAudio();
  const log = [];
  const persisted = [];
  const resolved = [];
  const player = createPlayer({
    audio: fake.audio,
    resolveUrl:
      options.resolveUrl ??
      (async (trackId) => {
        resolved.push(trackId);
        return { ok: true, data: { url: `https://music.dbankcdn.cn/song/${trackId}.mp3` } };
      }),
    guardUrl: options.guardUrl ?? guardUrl,
    persistQueue: options.persistQueue ?? (async (record) => persisted.push(record)),
    loadQueue: options.loadQueue ?? (async () => null),
    log: options.log ?? ((...parts) => log.push(parts.map(String).join(" "))),
    random: options.random ?? (() => 0),
  });
  return { player, fake, log, persisted, resolved };
}

test("构造：音频端口、取地址、地址闸门三者缺一不可（闸门是强制的，不是可选项）", () => {
  const fake = fakeAudio();
  const base = { audio: fake.audio, resolveUrl: async () => ({ ok: true, data: { url: SAFE_URL } }) };

  assert.throws(() => createPlayer({ resolveUrl: base.resolveUrl, guardUrl }), /audio/, "缺 audio 要立刻报错");
  assert.throws(() => createPlayer({ audio: fake.audio, guardUrl }), /resolveUrl/);
  assert.throws(
    () => createPlayer(base),
    /guardUrl/,
    "缺地址闸门必须抛：否则「没人校验」会变成默认放行，CSP 是最后一道而不是第一道",
  );
});

test("初始状态：idle、空队列、默认顺序模式、默认音量，没有错误也没有地址", () => {
  const { player } = makePlayer();
  const state = player.snapshot();
  assert.equal(state.status, PLAYER_STATUS.idle);
  assert.equal(state.error, null);
  assert.deepEqual(state.entries, []);
  assert.equal(state.index, -1);
  assert.equal(state.track, null);
  assert.equal(state.mode, DEFAULT_PLAYBACK_MODE);
  assert.equal(DEFAULT_PLAYBACK_MODE, "sequential");
  assert.equal(state.volume, DEFAULT_VOLUME);
  assert.equal(state.muted, false);
  assert.equal(state.currentTimeMs, 0);
  assert.equal(state.durationMs, 0);
  assert.equal(state.loaded, false);
  assert.equal(state.seekGeneration, 0);
  assert.deepEqual(PLAYBACK_MODES, ["sequential", "list-loop", "single-loop", "shuffle"]);
  assert.doesNotMatch(JSON.stringify(state), /http/i, "状态里不许有播放地址");
});

test("空队列：play()/next() 都是结构化 queue_empty（不静默、不装作在放）", async () => {
  const { player, fake } = makePlayer();
  const played = await player.play();
  assert.equal(played.ok, false);
  assert.equal(played.error.kind, PLAYER_ERROR_KINDS.queueEmpty);
  assert.equal(player.snapshot().error.kind, "queue_empty", "错误要进状态，UI 才有东西可显示");
  assert.equal(player.snapshot().status, PLAYER_STATUS.idle);
  assert.equal(fake.calls.play, 0, "没曲目就不该动音频");

  const next = await player.next();
  assert.equal(next.ok, false);
  assert.equal(next.error.kind, PLAYER_ERROR_KINDS.queueEmpty);
});

test("播放：取地址 → 过闸门 → 装载 → play，状态变 playing；地址不进快照", async () => {
  const { player, fake, resolved } = makePlayer();
  player.setQueue(songs(3), 0);

  const result = await player.playAt(0);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(resolved, ["1000"], "只取当次要播的那一首");
  assert.deepEqual(fake.calls.sources, ["https://music.dbankcdn.cn/song/1000.mp3"], "装载的是闸门归一后的地址");
  assert.equal(fake.calls.play, 1);

  const state = player.snapshot();
  assert.equal(state.status, PLAYER_STATUS.playing);
  assert.equal(state.loaded, true);
  assert.equal(state.error, null);
  assert.equal(state.track.id, "1000");
  assert.equal(state.index, 0);
  assert.doesNotMatch(JSON.stringify(state), /dbankcdn|http/, "地址不许进状态（UI 与日志都拿不到它）");
});

test("地址闸门：不放行的地址既不装载也不播放，报结构化 unsafe_media_url", async () => {
  const { player, fake } = makePlayer({
    resolveUrl: async () => ({ ok: true, data: { url: "https://evil.example.com/a.mp3" } }),
  });
  player.setQueue(songs(1), 0);

  const result = await player.playAt(0);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, PLAYER_ERROR_KINDS.unsafeMediaUrl);
  assert.deepEqual(fake.calls.sources, [], "闸门没放行就不许装载");
  assert.equal(fake.calls.play, 0);
  assert.equal(player.snapshot().status, PLAYER_STATUS.error);
  assert.doesNotMatch(JSON.stringify(player.snapshot()), /evil\.example\.com/, "连域名也不进状态");
});

test("双击竞态：先发的取地址后返回时，它的结果被丢掉（最终以后点的为准）", async () => {
  const pending = [];
  const { player, fake } = makePlayer({
    resolveUrl: (trackId) =>
      new Promise((resolve) => {
        pending.push({ trackId, resolve });
      }),
  });
  player.setQueue(songs(3), 0);

  const first = player.playAt(0);
  const second = player.playAt(1);

  // 后点的先返回，先点的后返回（真实网络里这是常态）
  pending[1].resolve({ ok: true, data: { url: OTHER_SAFE_URL } });
  await second;
  pending[0].resolve({ ok: true, data: { url: SAFE_URL } });
  await first;

  const state = player.snapshot();
  assert.equal(state.index, 1, "最终播的是后点的那一首");
  assert.equal(state.track.id, "1001");
  assert.deepEqual(fake.calls.sources, [OTHER_SAFE_URL], "过期结果不许装载（否则会听到前一首，界面显示后一首）");
});

test("取地址失败：core 的结构化类别原样带出来（endpoint_unknown 说「没配」，不冒充别的原因）", async () => {
  const { player, fake } = makePlayer({
    resolveUrl: async () => ({ ok: false, error: { kind: "endpoint_unknown", message: "接口端点 playback 尚未确定" } }),
  });
  player.setQueue(songs(1), 0);

  const result = await player.playAt(0);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "endpoint_unknown");
  assert.match(result.error.message, /playback/);
  assert.equal(player.snapshot().status, PLAYER_STATUS.error);
  assert.equal(player.snapshot().error.kind, "endpoint_unknown");
  assert.equal(fake.calls.play, 0);
});

test("取地址抛异常 / 结果没有 url：都收成 resolve_failed（错误类别不能靠猜）", async () => {
  const throwing = makePlayer({
    resolveUrl: async () => {
      throw { kind: "core_unavailable", message: "内核尚未就绪" };
    },
  });
  throwing.player.setQueue(songs(1), 0);
  const a = await throwing.player.playAt(0);
  assert.equal(a.ok, false);
  assert.equal(a.error.kind, "core_unavailable", "抛出物上的 kind 要保留（内核未就绪 ≠ 取地址失败）");

  const flat = makePlayer({ resolveUrl: async () => ({ ok: true, data: {} }) });
  flat.player.setQueue(songs(1), 0);
  const b = await flat.player.playAt(0);
  assert.equal(b.ok, false);
  assert.equal(b.error.kind, PLAYER_ERROR_KINDS.resolveFailed);
  assert.deepEqual(flat.fake.calls.sources, []);
});

test("音频拒绝播放 / audio error 事件：audio_error（不假装在播）", async () => {
  const rejected = makePlayer();
  rejected.fake.audio.play = () => Promise.reject(new Error("NotAllowedError"));
  rejected.player.setQueue(songs(1), 0);
  const result = await rejected.player.playAt(0);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, PLAYER_ERROR_KINDS.audioError);
  assert.equal(rejected.player.snapshot().status, PLAYER_STATUS.error);

  const broken = makePlayer();
  broken.player.setQueue(songs(1), 0);
  await broken.player.playAt(0);
  broken.fake.emit("error", { message: "decode failed" });
  assert.equal(broken.player.snapshot().status, PLAYER_STATUS.error);
  assert.equal(broken.player.snapshot().error.kind, PLAYER_ERROR_KINDS.audioError);
});

test("暂停/恢复：pause() 幂等；恢复播放不重新取地址（同一首不重复请求）", async () => {
  const { player, fake, resolved } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);
  assert.equal(resolved.length, 1);

  player.pause();
  assert.equal(player.snapshot().status, PLAYER_STATUS.paused);
  player.pause();
  assert.equal(fake.calls.pause, 1, "重复 pause 不该重复下发指令");

  await player.play();
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
  assert.equal(resolved.length, 1, "恢复播放不该再取一次地址");
  assert.equal(fake.calls.sources.length, 1, "也不该重新装载");
  assert.equal(fake.calls.play, 2);

  await player.toggle();
  assert.equal(player.snapshot().status, PLAYER_STATUS.paused);
});

test("上一首/下一首（顺序模式）：走列表，末端不环绕（播完即停）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue(songs(3), 0);
  await player.playAt(0);

  await player.next();
  assert.equal(player.snapshot().index, 1);
  await player.next();
  assert.equal(player.snapshot().index, 2);
  await player.next();
  assert.equal(player.snapshot().index, 2, "顺序模式末端不再前进");
  assert.equal(player.snapshot().status, PLAYER_STATUS.ended);
  assert.equal(fake.calls.pause, 1, "停下来就要真的把音频停下");

  // 播完之后按播放 = 从头放这一首（不重新取地址）
  await player.play();
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
  assert.deepEqual(fake.calls.seeks.at(-1), 0, "从头播放要把进度归零");
});

test("上一首：首曲不环绕，重放当前曲（00:00）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue(songs(3), 0);
  await player.playAt(0);

  const result = await player.previous();
  assert.equal(result.ok, true);
  assert.equal(player.snapshot().index, 0);
  assert.deepEqual(fake.calls.seeks.at(-1), 0);
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
});

test("播完自动下一首：顺序模式走到下一首；末首停住（ended）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue(songs(3), 0);
  await player.playAt(0);

  fake.emit("ended");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.snapshot().index, 1, "播完自动接下一首");
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
});

test("四种模式的下一首：顺序/列表循环/单曲循环/随机各自不同", async () => {
  // 顺序：末首播完即停
  const sequential = makePlayer();
  sequential.player.setQueue(songs(2), 0);
  await sequential.player.playAt(0);
  await sequential.player.next();
  sequential.fake.emit("ended");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sequential.player.snapshot().status, PLAYER_STATUS.ended);
  assert.equal(sequential.player.snapshot().index, 1);

  // 列表循环：末首播完回到第一首
  const looping = makePlayer();
  looping.player.setMode("list-loop");
  looping.player.setQueue(songs(2), 1);
  await looping.player.playAt(1);
  looping.fake.emit("ended");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(looping.player.snapshot().index, 0);
  assert.equal(looping.player.snapshot().status, PLAYER_STATUS.playing);

  // 单曲循环：播完重放同一首（进度归零）
  const single = makePlayer();
  single.player.setMode("single-loop");
  single.player.setQueue(songs(3), 1);
  await single.player.playAt(1);
  single.fake.emit("ended");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(single.player.snapshot().index, 1);
  assert.deepEqual(single.fake.calls.seeks.at(-1), 0);
  assert.equal(single.fake.calls.play, 2);

  // 随机：走的是另一首（不是列表里的下一首），且一个周期内不重复
  const shuffled = makePlayer({ random: () => 0 });
  shuffled.player.setMode("shuffle");
  shuffled.player.setQueue(songs(4), 0);
  await shuffled.player.playAt(0);
  const visited = [shuffled.player.snapshot().track.id];
  for (let step = 0; step < 3; step += 1) {
    await shuffled.player.next();
    visited.push(shuffled.player.snapshot().track.id);
  }
  assert.equal(new Set(visited).size, 4, `随机一个周期内不该重复：${visited.join(",")}`);
  // 周期走完后再下一首：重新洗牌，且不立刻重播刚听过的那一首
  await shuffled.player.next();
  assert.notEqual(shuffled.player.snapshot().track.id, visited.at(-1));
});

test("进度：seek 夹在 [0, duration]；seekGeneration 递增（歌词同步靠它认「这是一次跳转」）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);

  const negative = player.seek(-100);
  assert.equal(negative.ok, true);
  assert.equal(negative.data.currentTimeMs, 0);
  assert.deepEqual(fake.calls.seeks.at(-1), 0);

  // 时长未知（元数据还没来）：只夹下界，不假装知道结尾
  const beyond = player.seek(999_999);
  assert.equal(beyond.data.currentTimeMs, 999_999);
  assert.equal(player.snapshot().durationMs, 0);

  fake.emit("loadedmetadata", { duration: 200 });
  assert.equal(player.snapshot().durationMs, 200_000, "时长用毫秒（与 AMLL 的 currentTime 同单位）");
  const clamped = player.seek(999_999);
  assert.equal(clamped.data.currentTimeMs, 200_000, "知道总长之后就要夹住");

  assert.equal(player.snapshot().seekGeneration, 3, "每次 seek 都是一次跳转信号");
});

test("进度与状态由音频事件驱动：timeupdate 推进进度，loadedmetadata 给时长", async () => {
  const { player, fake } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);

  fake.emit("timeupdate", { currentTime: 12.5 });
  assert.equal(player.snapshot().currentTimeMs, 12_500, "毫秒取整（AMLL 要求整数）");
  fake.emit("timeupdate", { currentTime: "bad" });
  assert.equal(player.snapshot().currentTimeMs, 12_500, "坏事件不该把进度打回 0");
  fake.emit("waiting");
  assert.equal(player.snapshot().status, PLAYER_STATUS.loading, "缓冲中要说「正在准备」，不假装在播");
  fake.emit("playing");
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
});

test("音量与静音：夹在 0..1；NaN 不收（invalid_command），且不污染播放错误", () => {
  const { player, fake } = makePlayer();

  assert.equal(player.setVolume(0.5).ok, true);
  assert.equal(player.snapshot().volume, 0.5);
  player.setVolume(2);
  assert.equal(player.snapshot().volume, 1);
  player.setVolume(-1);
  assert.equal(player.snapshot().volume, 0);
  assert.deepEqual(fake.calls.volumes, [0.5, 1, 0]);

  const bad = player.setVolume(Number.NaN);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, "invalid_command");
  assert.equal(player.snapshot().volume, 0, "坏输入不改变音量");
  assert.equal(player.snapshot().error, null, "调用方的参数错误不该显示成播放故障");

  player.setMuted(true);
  assert.equal(player.snapshot().muted, true);
  assert.deepEqual(fake.calls.muted, [true]);
  player.toggleMute();
  assert.equal(player.snapshot().muted, false);
});

test("模式：认不出的模式被拒（invalid_command）且状态不变", () => {
  const { player } = makePlayer();
  assert.equal(player.setMode("random").ok, false);
  assert.equal(player.setMode("random").error.kind, "invalid_command");
  assert.equal(player.snapshot().mode, DEFAULT_PLAYBACK_MODE);
  assert.equal(player.setMode("shuffle").ok, true);
  assert.equal(player.snapshot().mode, "shuffle");
});

test("持久化：只在队列/索引变化时写，写的是 ids + index（没有地址、没有标题）", async () => {
  const { player, persisted } = makePlayer();
  player.setQueue(songs(3), 0);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], { ids: ["1000", "1001", "1002"], index: 0 });

  await player.playAt(1);
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[1], { ids: ["1000", "1001", "1002"], index: 1 });
  assert.doesNotMatch(JSON.stringify(persisted), /http|dbankcdn/, "地址绝不落盘");

  player.setMode("list-loop");
  assert.equal(persisted.length, 2, "改模式不算队列变化（模式不持久化：裁决只写了标识 + 索引）");

  player.seek(1000);
  assert.equal(persisted.length, 2, "拖进度不写盘（那会把磁盘当进度条用）");

  await player.next();
  assert.equal(persisted.length, 3);
  assert.equal(persisted[2].index, 2);

  player.clear();
  assert.equal(persisted.length, 4);
  assert.equal(persisted[3], null, "清空 = 删除这个键（settings 的 null 语义）");
  assert.deepEqual(player.snapshot().entries, []);
  assert.equal(player.snapshot().index, -1);
});

test("持久化失败只记日志：不抛、不改状态（队列是体验，不是正确性）", async () => {
  const { player, log } = makePlayer({
    persistQueue: async () => {
      throw new Error("磁盘只读");
    },
  });
  player.setQueue(songs(1), 0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(player.snapshot().entries.length, 1, "写盘失败不影响内存里的队列");
  assert.equal(player.snapshot().error, null, "也不该显示成播放故障");
  assert.ok(
    log.some((line) => line.includes("磁盘只读")),
    `失败要留痕（否则用户以为队列记住了）：${JSON.stringify(log)}`,
  );
});

test("恢复：从记录恢复队列与索引，**不自动播放**（没有用户手势的自动出声是打扰）", async () => {
  const { player, fake } = makePlayer({ loadQueue: async () => ({ ids: ["2001", "2002"], index: 1 }) });
  const result = await player.restore();

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { restored: true, queueLength: 2 });
  const state = player.snapshot();
  assert.deepEqual(
    state.entries.map((entry) => entry.id),
    ["2001", "2002"],
  );
  assert.equal(state.index, 1);
  assert.equal(state.status, PLAYER_STATUS.idle, "恢复只还原队列，不开始播放");
  assert.equal(fake.calls.play, 0);
  assert.equal(state.restored, true);

  // 恢复一个坏记录 = 没有队列（不是"空队列"，更不是假成功）
  const bad = makePlayer({ loadQueue: async () => ({ ids: "nope" }) });
  assert.deepEqual((await bad.player.restore()).data, { restored: false, queueLength: 0 });

  // 读不出来也只记日志（离线启动不该把应用拦住）
  const broken = makePlayer({
    loadQueue: async () => {
      throw new Error("读设置失败");
    },
  });
  assert.deepEqual((await broken.player.restore()).data, { restored: false, queueLength: 0 });
  assert.ok(broken.log.some((line) => line.includes("读设置失败")));
});

test("不写地址进日志：整条链路（成功 + 各种失败）跑完后日志里没有地址", async () => {
  const { player, log, fake } = makePlayer({
    persistQueue: async () => {
      throw new Error("落盘失败");
    },
  });
  player.setQueue(songs(2), 0);
  await player.playAt(0);
  fake.emit("ended");
  await player.playAt(1);
  fake.emit("error", { message: "boom" });
  await player.restore();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const joined = log.join("\n");
  assert.doesNotMatch(joined, /http|dbankcdn|mp3/, `日志里出现了地址：${joined}`);
});

test("订阅：状态变化通知订阅者，退订后不再通知；dispose 后事件不再改状态", async () => {
  const { player, fake } = makePlayer();
  const seen = [];
  const unsubscribe = player.subscribe((state) => seen.push(state.status));

  player.setQueue(songs(1), 0);
  await player.playAt(0);
  assert.ok(seen.length >= 2, `订阅者应当收到多次通知：${JSON.stringify(seen)}`);
  assert.equal(seen.at(-1), PLAYER_STATUS.playing);

  unsubscribe();
  const count = seen.length;
  player.pause();
  assert.equal(seen.length, count, "退订后不该再通知");

  player.dispose();
  fake.emit("ended");
  assert.equal(player.snapshot().status, PLAYER_STATUS.paused, "dispose 之后事件不再改状态");
  assert.equal(fake.calls.disposed > 0, true, "dispose 要真的把音频监听摘掉");
});

test("playTracks/playQueue：双击列表里的某一首 = 用整个列表当队列并从那一首开始", async () => {
  const { player, resolved } = makePlayer();
  const result = await player.playQueue(songs(4), 2);

  assert.equal(result.ok, true);
  assert.deepEqual(resolved, ["1002"], "只取被点那首的地址");
  const state = player.snapshot();
  assert.equal(state.entries.length, 4, "整张列表进队列（这样才有上一首/下一首）");
  assert.equal(state.index, 2);
  assert.equal(state.track.name, "歌2");
});

// —— R40：加入队列（歌单详情页的「加入队列」） -----------------------------------------

test("R40 enqueue：追加到队尾、**不动正在播的那一首**（与整队替换是两件事）", async () => {
  const { player, fake, resolved, persisted } = makePlayer();
  await player.playQueue(songs(2), 0);
  assert.equal(player.snapshot().status, "playing");
  const sourcesBefore = fake.calls.sources.length;
  const playBefore = fake.calls.play;

  const added = player.enqueue(songs(3).map((song, index) => ({ ...song, id: String(2000 + index) })));
  assert.equal(added.ok, true);
  assert.deepEqual(added.data, { added: 3, queueLength: 5, index: 0 });

  const state = player.snapshot();
  assert.equal(state.entries.length, 5, "原来 2 首 + 新来 3 首");
  assert.deepEqual(state.entries.map((entry) => entry.id), ["1000", "1001", "2000", "2001", "2002"], "追加在后面，顺序不变");
  assert.equal(state.index, 0, "当前索引不动");
  assert.equal(state.status, "playing", "正在播的那一首不许被打回停止（换队列才停，加入队列不停）");
  assert.equal(state.loaded, true, "已装载的状态也不许被作废");
  assert.equal(fake.calls.sources.length, sourcesBefore, "不重新装载音频源");
  assert.equal(fake.calls.play, playBefore, "不重新播放");
  assert.deepEqual(resolved, ["1000"], "只取过被点那首的地址");
  assert.equal(persisted.length, 2, "队列变了要写盘（第二次是追加）");
  assert.deepEqual(persisted.at(-1), { ids: ["1000", "1001", "2000", "2001", "2002"], index: 0 });
});

test("R40 enqueue：空队列时追加 = 建立队列并停在第一首，但**不自动出声**", async () => {
  const { player, fake } = makePlayer();
  const added = player.enqueue(songs(2));

  assert.deepEqual(added.data, { added: 2, queueLength: 2, index: 0 });
  const state = player.snapshot();
  assert.equal(state.index, 0, "索引指向第一首（否则「播放/下一首」都没有落点）");
  assert.equal(state.track.id, "1000");
  assert.equal(state.status, "idle", "没有用户手势的自动出声是打扰（与 restore 同一条纪律）");
  assert.equal(fake.calls.play, 0);
  assert.equal(fake.calls.sources.length, 0, "还没取地址、没装载");
});

test("R40 enqueue：没有标识的条目 / 空列表一律不产生变化（不写盘、不改状态）", () => {
  const { player, persisted } = makePlayer();
  player.enqueue([{ name: "没有 id" }]);
  assert.deepEqual(player.snapshot().entries, []);
  assert.equal(persisted.length, 0, "什么都没变就不写盘");

  player.enqueue(songs(1));
  const before = persisted.length;
  const after = player.enqueue([]);
  assert.deepEqual(after.data, { added: 0, queueLength: 1, index: 0 });
  assert.equal(persisted.length, before, "空追加不写盘");
});

test("R40 enqueue：同一首歌可以出现两次（不去重、不排序——追加的语义就是「原样排到后面」）", () => {
  const { player } = makePlayer();
  player.enqueue(songs(1));
  player.enqueue(songs(1));
  assert.deepEqual(player.snapshot().entries.map((entry) => entry.id), ["1000", "1000"]);
});

test("player:command（R11 托盘预登记）：命令表是唯一真源，认不出的命令结构化拒绝", async () => {
  assert.deepEqual(PLAYER_COMMANDS, ["play", "pause", "toggle", "next", "previous"]);
  assert.equal(isPlayerCommand("toggle"), true);
  assert.equal(isPlayerCommand("stop"), false);

  const called = [];
  const stub = {
    play: async () => (called.push("play"), { ok: true }),
    pause: () => (called.push("pause"), { ok: true }),
    toggle: async () => (called.push("toggle"), { ok: true }),
    next: async () => (called.push("next"), { ok: true }),
    previous: async () => (called.push("previous"), { ok: true }),
  };
  for (const command of PLAYER_COMMANDS) {
    const result = await applyPlayerCommand(stub, { command });
    assert.equal(result.ok, true, `${command} 应当被接受`);
  }
  assert.deepEqual(called, PLAYER_COMMANDS);

  const unknown = await applyPlayerCommand(stub, { command: "seek-to-42" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.kind, "invalid_command");
  for (const payload of [null, undefined, "toggle", 42, {}, { command: 7 }]) {
    const result = await applyPlayerCommand(stub, payload);
    assert.equal(result.ok, false, `坏载荷必须被拒：${JSON.stringify(payload)}`);
  }
  assert.deepEqual(called, PLAYER_COMMANDS, "被拒的命令一个都不许执行");
});
