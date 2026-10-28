/**
 * 播放状态机（`features/playback/player.mjs`）：单 Audio 实例的全部路径，端口全部注入，node 里可跑完。
 * 地址闸门强制、地址不进状态与日志、双击取地址先发后到丢弃、播完按四种模式走。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PLAYBACK_MODE,
  DEFAULT_VOLUME,
  PLAYBACK_MODES,
  PLAYER_ERROR_KINDS,
  PLAYER_STATUS,
  POSITION_WRITE_INTERVAL_MS,
  RESUME_TAIL_MS,
  createPlayer,
} from "../src/renderer/features/playback/player.mjs";
import { PLAYER_COMMANDS, applyPlayerCommand, isPlayerCommand } from "../src/renderer/features/playback/player-commands.mjs";

const SAFE_URL = "https://music.dbankcdn.cn/song/1.mp3";
const OTHER_SAFE_URL = "https://music.dbankcdn.cn/song/2.mp3";

/** 假音频端口：记录每条指令，"事件"由测试手动派发。 */
function fakeAudio() {
  const handlers = new Map();
  const calls = { sources: [], play: 0, pause: 0, seeks: [], volumes: [], muted: [], disposed: 0, timeline: [] };
  const audio = {
    setSource: (src) => {
      calls.sources.push(src);
      calls.timeline.push("source");
    },
    play: () => {
      calls.play += 1;
      calls.timeline.push("play");
      return Promise.resolve();
    },
    pause: () => {
      calls.pause += 1;
      calls.timeline.push("pause");
    },
    setCurrentTime: (ms) => {
      calls.seeks.push(ms);
      calls.timeline.push(`seek:${ms}`);
    },
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

/**
 * 假时钟 + 假定时器：节流按注入的 now() 计时，尾随写由测试手动触发。
 * `fireDue()` 只跑已到期的那几个（按到期时刻）。
 */
function fakeClock(start = 0) {
  let time = start;
  const timers = [];
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
    schedule(callback, delayMs) {
      const entry = { callback, at: time + delayMs };
      timers.push(entry);
      return () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    fireDue() {
      let fired = 0;
      for (const entry of [...timers].sort((a, b) => a.at - b.at)) {
        if (entry.at > time) continue;
        const index = timers.indexOf(entry);
        if (index < 0) continue;
        timers.splice(index, 1);
        entry.callback();
        fired += 1;
      }
      return fired;
    },
    pending: () => timers.length,
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
  const clock = options.clock ?? fakeClock();
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
    now: clock.now,
    schedule: clock.schedule,
  });
  return { player, fake, log, persisted, resolved, clock };
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
  // 条目和音频都没给时长：这里要的是"什么都不知道"的那条路径
  player.setQueue([{ id: "2401", name: "无时长曲目", singer: "歌手" }], 0);
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

test("持久化：队列/索引变化时写 ids/index 与安全展示快照，音频地址不写", async () => {
  const { player, persisted } = makePlayer();
  player.setQueue(songs(3), 0);
  assert.equal(persisted.length, 1);
  const metadata = [
    { id: "1000", name: "歌0", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "1001", name: "歌1", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "1002", name: "歌2", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
  ];
  assert.deepEqual(persisted[0], { ids: ["1000", "1001", "1002"], index: 0, metadata });

  await player.playAt(1);
  assert.equal(persisted.length, 2);
  assert.deepEqual(persisted[1], { ids: ["1000", "1001", "1002"], index: 1, metadata });
  assert.doesNotMatch(JSON.stringify(persisted), /http|dbankcdn/, "地址绝不落盘");

  player.setMode("list-loop");
  assert.equal(persisted.length, 2, "改模式不算队列变化，模式不持久化");

  player.seek(1000);
  assert.equal(persisted.length, 2, "拖进度不逐帧写盘：5 秒节流 + 拖完的尾随写（见恢复进度那一组）");

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

// —— 加入队列：追加到队尾，不动正在播的那一首（与整队替换是两件事） ——

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
  assert.deepEqual(persisted.at(-1), { ids: ["1000", "1001", "2000", "2001", "2002"], index: 0, metadata: [
    { id: "1000", name: "歌0", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "1001", name: "歌1", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "2000", name: "歌0", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "2001", name: "歌1", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
    { id: "2002", name: "歌2", artists: "歌手", duration: 200, coverUrl: null, albumId: null, albumName: null },
  ] });
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

// —— 下一首播放：插到当前曲目之后（索引与正在播的那一首都不动） ——

test("R63 playNext：插到当前曲目之后，索引与正在播的那一首都不动", async () => {
  const { player, fake, resolved, persisted } = makePlayer();
  await player.playQueue(songs(4), 1);
  assert.equal(player.snapshot().track.id, "1001");
  const sourcesBefore = fake.calls.sources.length;
  const playBefore = fake.calls.play;

  const inserted = player.playNext([{ id: "9001", name: "插队曲目" }]);
  assert.equal(inserted.ok, true);
  assert.deepEqual(inserted.data, { added: 1, queueLength: 5, index: 1 });

  const state = player.snapshot();
  assert.deepEqual(state.entries.map((entry) => entry.id), ["1000", "1001", "9001", "1002", "1003"]);
  assert.equal(state.index, 1, "当前索引不动（插在后面，不换歌）");
  assert.equal(state.status, "playing", "正在播的那一首继续响");
  assert.equal(state.loaded, true);
  assert.equal(fake.calls.sources.length, sourcesBefore, "不重新装载音频源");
  assert.equal(fake.calls.play, playBefore, "不重新播放");
  assert.deepEqual(resolved, ["1001"], "只取过被点那首的地址");
  assert.equal(persisted.length, 2, "插队也要写盘");
});

test("R63 playNext：顺序模式下 next() 走的正是插进去的那一首", async () => {
  const { player } = makePlayer();
  await player.playQueue(songs(3), 0);
  player.playNext([{ id: "9001", name: "插队曲目" }]);
  await player.next();
  assert.equal(player.snapshot().track.id, "9001", "下一首 = 刚插进去的那一首");
  await player.next();
  assert.equal(player.snapshot().track.id, "1001", "之后回到原来的顺序");
});

test("R63 playNext：随机模式下也真的排在当前曲目后面（排列表跟着移动，不是碰运气）", async () => {
  const { player } = makePlayer();
  await player.playQueue(songs(4), 0);
  player.setMode("shuffle");
  await player.next();
  const beforeInsert = player.snapshot().track.id;

  player.playNext([{ id: "9001", name: "插队曲目" }]);
  await player.next();
  const afterInsert = player.snapshot().track.id;
  assert.notEqual(afterInsert, beforeInsert, "换了一首");
  assert.equal(afterInsert, "9001", "随机播放的「下一首」同样认这次插队");
});

test("R63 playNext：空队列时插队 = 建立队列并停在第一首，但**不自动出声**", () => {
  const { player, fake } = makePlayer();
  const inserted = player.playNext(songs(2));
  assert.deepEqual(inserted.data, { added: 2, queueLength: 2, index: 0 });
  const state = player.snapshot();
  assert.equal(state.index, 0);
  assert.equal(state.status, "idle");
  assert.equal(fake.calls.play, 0, "没有用户手势的自动出声是打扰");
});

test("R63 playNext：没有标识的条目 / 空列表一律不产生变化（不写盘）", () => {
  const { player, persisted } = makePlayer();
  player.playNext([{ name: "没有 id" }]);
  assert.deepEqual(player.snapshot().entries, []);
  assert.equal(persisted.length, 0);

  player.setQueue(songs(1), 0);
  const before = persisted.length;
  assert.deepEqual(player.playNext([]).data, { added: 0, queueLength: 1, index: 0 });
  assert.equal(persisted.length, before, "空插入不写盘");
});

test("R63 playNext：与 enqueue 同一条去重规则——同一首歌可以出现两次（插队不去重）", () => {
  const { player } = makePlayer();
  player.setQueue(songs(2), 0);
  player.playNext([{ id: "1000", name: "歌0" }]);
  assert.deepEqual(player.snapshot().entries.map((entry) => entry.id), ["1000", "1000", "1001"]);
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

test("播放代次隔离旧交互：同 id 重复条目、重播、自动循环与换队列均作废旧代次", async () => {
  const { player, fake } = makePlayer();
  const duplicate = songs(1)[0];
  await player.playQueue([duplicate, duplicate], 0);
  const first = player.snapshot().playbackGeneration;
  assert.ok(Number.isInteger(first) && first > 0, "首次播放有可捕获的代次");
  player.seek(4000);
  player.setVolume(0.5);
  player.pause();
  await player.play();
  assert.equal(player.snapshot().playbackGeneration, first, "进度、音量、暂停/恢复不作废当前拖动");
  await player.next();
  const second = player.snapshot().playbackGeneration;
  assert.equal(player.snapshot().track.id, duplicate.id);
  assert.equal(player.snapshot().index, 1);
  assert.ok(second > first, "id 相同但条目不同仍是新代次");
  await player.playAt(1);
  const repeated = player.snapshot().playbackGeneration;
  assert.ok(repeated > second, "同一条目被重新选择也取消旧交互");
  player.setMode("single-loop");
  fake.emit("ended");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const looped = player.snapshot().playbackGeneration;
  assert.ok(looped > repeated, "自然单曲循环重新开播是新代次");
  player.setQueue([duplicate], 0);
  const replaced = player.snapshot().playbackGeneration;
  assert.ok(replaced > looped, "换队列但复用同 id 也取消旧交互");
  player.clear();
  assert.ok(player.snapshot().playbackGeneration > replaced, "清空队列作废旧交互");
});

/** 总时长不显示「—」：音频报 Infinity/NaN/0 时退到曲目元数据，再退到 0。 */
test("总时长：音频报 Infinity/NaN/0 时用曲目元数据（秒 → 毫秒）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue([{ id: "2101", name: "元数据曲目", singer: "歌手", duration: 184 }], 0);
  await player.playAt(0);

  for (const reported of [Number.POSITIVE_INFINITY, Number.NaN, 0]) {
    fake.emit("loadedmetadata", { duration: reported });
    assert.equal(player.snapshot().durationMs, 184_000, `音频报 ${reported} 时用元数据时长`);
  }
});

test("总时长：音频报有限正值时以音频为准（元数据只是兜底）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue([{ id: "2102", name: "元数据曲目", singer: "歌手", duration: 184 }], 0);
  await player.playAt(0);

  fake.emit("loadedmetadata", { duration: 181.5 });
  assert.equal(player.snapshot().durationMs, 181_500, "音频报的数才是真的可播范围");
});

test("总时长：durationchange 更新（先报 Infinity、之后报真实值）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue([{ id: "2103", name: "元数据曲目", singer: "歌手", duration: 184 }], 0);
  await player.playAt(0);

  fake.emit("durationchange", { duration: Number.POSITIVE_INFINITY });
  assert.equal(player.snapshot().durationMs, 184_000, "Infinity 不覆盖元数据");
  fake.emit("durationchange", { duration: 176 });
  assert.equal(player.snapshot().durationMs, 176_000, "真实值到了就以它为准");
});

test("总时长：没有任何时长来源时仍是 0（界面显示「—」，不编一个数）", async () => {
  const { player, fake } = makePlayer();
  player.setQueue([{ id: "2104", name: "无时长曲目", singer: "歌手" }], 0);
  await player.playAt(0);
  assert.equal(player.snapshot().durationMs, 0);

  fake.emit("loadedmetadata", { duration: Number.NaN });
  fake.emit("durationchange", { duration: Number.POSITIVE_INFINITY });
  assert.equal(player.snapshot().durationMs, 0, "坏读数不冒充时长");
});

test("总时长：恢复的队列没播过也有元数据时长，seek 夹在它里面", async () => {
  const record = {
    ids: ["2201", "2202"],
    index: 1,
    metadata: [
      { id: "2201", name: "甲", artists: "歌手", duration: 200 },
      { id: "2202", name: "乙", artists: "歌手", duration: 245 },
    ],
  };
  const { player } = makePlayer({ loadQueue: async () => record });
  await player.restore();

  assert.equal(player.snapshot().status, PLAYER_STATUS.idle, "恢复仍不自动播放");
  assert.equal(player.snapshot().durationMs, 245_000, "恢复队列的总时长来自条目元数据");
  assert.equal(player.seek(999_999).data.currentTimeMs, 245_000, "进度条可拖到元数据给的范围内");
});

test("总时长：换到没有元数据的曲目时，上一首的时长不残留", async () => {
  const { player, fake } = makePlayer();
  await player.playQueue([{ id: "2301", name: "甲", singer: "歌手", duration: 200 }, { id: "2302", name: "乙", singer: "歌手" }], 0);
  fake.emit("loadedmetadata", { duration: 200 });
  assert.equal(player.snapshot().durationMs, 200_000);

  await player.next();
  assert.equal(player.snapshot().durationMs, 0, "新曲目一没元数据二没读数：回到未知，不显示上一首的时长");
});

// —— 播放进度的保存与恢复 ——

/** 带位置的记录（index 与 positionTrackId 必须对上，sanitize 才肯收）。 */
function resumeRecord(positionMs, { duration = 200, ids = ["3001", "3002"], index = 0 } = {}) {
  const metadata = ids.map((id) => ({ id, name: `曲目${id}`, artists: "歌手", duration }));
  return { ids, index, metadata, positionMs, positionTrackId: ids[index] };
}

test("进度写盘：播放中最多每 5 秒一次（按注入的 now 计时），暂停/切歌/清空立即写", async () => {
  const { player, fake, persisted, clock } = makePlayer();
  player.setQueue(songs(2), 0);
  await player.playAt(0);
  const written = persisted.length;

  fake.emit("timeupdate", { currentTime: 1 });
  clock.advance(POSITION_WRITE_INTERVAL_MS - 1000);
  fake.emit("timeupdate", { currentTime: 4 });
  assert.equal(persisted.length, written, "节流窗口内不写盘");

  clock.advance(1000);
  fake.emit("timeupdate", { currentTime: 5 });
  assert.equal(persisted.length, written + 1, "满 5 秒写一次");
  assert.deepEqual(
    { positionMs: persisted.at(-1).positionMs, positionTrackId: persisted.at(-1).positionTrackId },
    { positionMs: 5000, positionTrackId: "1000" },
  );

  // 暂停是用户动作：不让节流压着，那一刻的位置立刻落盘
  fake.emit("timeupdate", { currentTime: 9 });
  player.pause();
  assert.equal(persisted.at(-1).positionMs, 9000);
  const afterPause = persisted.length;

  // 暂停中的 timeupdate（浏览器 seek 后也会发）不该再写
  fake.emit("timeupdate", { currentTime: 9000 });
  assert.equal(persisted.length, afterPause);

  // 切歌：新的一首从 0 开始，位置字段整对消失
  await player.next();
  assert.equal(persisted.at(-1).index, 1);
  assert.equal("positionMs" in persisted.at(-1), false, "切歌后上一首的位置不许跟着走");
  assert.equal("positionTrackId" in persisted.at(-1), false);

  player.clear();
  assert.equal(persisted.at(-1), null, "清空 = 删除这个键");
});

test("拖动进度：拖动过程中不写盘，拖完的最终位置一定落盘（尾随写）", async () => {
  const { player, fake, persisted, clock } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);
  clock.advance(POSITION_WRITE_INTERVAL_MS);
  fake.emit("timeupdate", { currentTime: 10 });
  const written = persisted.length;
  assert.equal(persisted.at(-1).positionMs, 10_000);

  for (const ms of [2000, 5000, 8000, 12_000, 15_000]) player.seek(ms);
  assert.equal(persisted.length, written, "拖动过程中一次都不写（拖一次写一次 = 把磁盘当进度条）");
  assert.equal(clock.pending(), 1, "只挂一个尾随写");

  clock.advance(POSITION_WRITE_INTERVAL_MS);
  assert.equal(clock.fireDue(), 1);
  assert.equal(persisted.length, written + 1, "松手后补一次");
  assert.equal(persisted.at(-1).positionMs, 15_000, "落盘的是最后一次位置");
  assert.equal(persisted.at(-1).positionTrackId, "1000");
});

test("主窗隐藏前 flushPosition：立刻落盘，不等节流", async () => {
  const { player, fake, persisted, clock } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);
  fake.emit("timeupdate", { currentTime: 7 });
  assert.equal(persisted.at(-1).positionMs ?? null, null, "节流窗口内还没写");

  player.flushPosition();
  assert.equal(persisted.at(-1).positionMs, 7000);
  assert.equal(clock.pending(), 0, "立刻写完就不要留尾随任务");
});

test("恢复：底栏读数就是保存的位置与时长，状态 idle（暂停），一次都不碰音频", async () => {
  const { player, fake } = makePlayer({ loadQueue: async () => resumeRecord(51_234) });
  await player.restore();

  const state = player.snapshot();
  assert.equal(state.currentTimeMs, 51_234);
  assert.equal(state.durationMs, 200_000);
  assert.equal(state.status, PLAYER_STATUS.idle, "恢复 = 暂停等播放键（idle 与既有语义一致）");
  assert.equal(state.loaded, false);
  assert.equal(state.track.id, "3001");
  assert.equal(fake.calls.play, 0, "启动不出声");
  assert.deepEqual(fake.calls.seeks, [], "没装载就不碰音频");
  assert.deepEqual(fake.calls.sources, []);
});

test("首次播放：先取地址再 seek 到保存位置，加载期间进度不闪回 0", async () => {
  const { player, fake } = makePlayer({ loadQueue: async () => resumeRecord(51_234) });
  await player.restore();

  // 装载期间每一帧都拿着保存的位置（否则进度条会先闪回 0:00）
  player.subscribe((state) => {
    if (state.status === PLAYER_STATUS.loading) {
      assert.ok(state.currentTimeMs >= 51_234, `加载中进度闪回了 ${state.currentTimeMs}`);
    }
  });
  await player.playAt(0);

  const interesting = fake.calls.timeline;
  assert.deepEqual(interesting, ["source", "seek:51234", "play"], "顺序：取地址 → 设源 → seek → 播");
  assert.equal(player.snapshot().currentTimeMs, 51_234);
  assert.equal(player.snapshot().status, PLAYER_STATUS.playing);
});

test("恢复后先拖进度再播放：以用户位置为准，保存的位置不再使用", async () => {
  const { player, fake } = makePlayer({ loadQueue: async () => resumeRecord(51_234) });
  await player.restore();

  player.seek(20_000);
  assert.deepEqual(fake.calls.seeks, [], "还没装载时拖进度只是改待恢复位置");
  assert.equal(player.snapshot().currentTimeMs, 20_000);

  await player.play();
  assert.deepEqual(fake.calls.seeks, [20_000], "只 seek 用户选的那一处");
  assert.equal(player.snapshot().currentTimeMs, 20_000);
});

test("取地址期间用户拖进度：装载后从用户选的位置开始（不许被盘上的位置盖回去）", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { player, fake } = makePlayer({
    loadQueue: async () => resumeRecord(51_234),
    resolveUrl: async () => {
      await gate;
      return { ok: true, data: { url: "https://music.dbankcdn.cn/song/3001.mp3" } };
    },
  });
  await player.restore();
  const playing = player.playAt(0);
  player.seek(20_000);
  release();
  await playing;

  assert.deepEqual(fake.calls.seeks, [20_000], "只 seek 用户选的那一处");
  assert.equal(player.snapshot().currentTimeMs, 20_000);
});


test("装载后用户再拖进度：待恢复位置作废，loadedmetadata 不会把它改回去", async () => {
  const { player, fake } = makePlayer({
    loadQueue: async () => ({ ids: ["4003"], index: 0, positionMs: 10_000, positionTrackId: "4003" }),
  });
  await player.restore();
  await player.playAt(0);
  player.seek(2000);
  fake.emit("loadedmetadata", { duration: 11 });
  assert.equal(player.snapshot().currentTimeMs, 2_000, "用户的位置说了算");
  assert.deepEqual(fake.calls.seeks, [10_000, 2_000], "没有第二次纠正");
});

test("恢复边界：距结尾不足 3 秒、id 不对、位置非法都从 0 开始", async () => {
  const nearEnd = makePlayer({ loadQueue: async () => resumeRecord(200_000 - RESUME_TAIL_MS + 1) });
  await nearEnd.player.restore();
  assert.equal(nearEnd.player.snapshot().currentTimeMs, 0, "快听完了就不必从结尾接着放");

  const exactly = makePlayer({ loadQueue: async () => resumeRecord(200_000 - RESUME_TAIL_MS) });
  await exactly.player.restore();
  assert.equal(exactly.player.snapshot().currentTimeMs, 200_000 - RESUME_TAIL_MS, "正好剩 3 秒仍算可恢复");

  const beyond = makePlayer({ loadQueue: async () => resumeRecord(999_999) });
  await beyond.player.restore();
  assert.equal(beyond.player.snapshot().currentTimeMs, 0, "超出时长 = 非法");

  const mismatched = makePlayer({
    loadQueue: async () => ({ ...resumeRecord(51_234), positionTrackId: "3002" }),
  });
  await mismatched.player.restore();
  assert.equal(mismatched.player.snapshot().currentTimeMs, 0, "id 与 index 对不上：宁可从头放");

  // 从 0 开始的恢复：首次播放也不该多一次 seek
  await mismatched.player.playAt(0);
  assert.deepEqual(mismatched.fake.calls.seeks, []);
});

test("时长未知：先显示保存的位置，loadedmetadata 报出真实时长后再按结尾门修正", async () => {
  const noDuration = (ids) => ({ ids, index: 0, positionMs: 10_000, positionTrackId: ids[0] });
  const keep = makePlayer({ loadQueue: async () => noDuration(["4001"]) });
  await keep.player.restore();
  assert.equal(keep.player.snapshot().currentTimeMs, 10_000, "时长未知时按保存的位置显示");
  await keep.player.playAt(0);
  assert.deepEqual(keep.fake.calls.seeks, [10_000]);
  keep.fake.emit("loadedmetadata", { duration: 30 });
  assert.equal(keep.player.snapshot().currentTimeMs, 10_000, "距结尾还有 20 秒：保持");
  assert.deepEqual(keep.fake.calls.seeks, [10_000], "不需要再纠正一次");

  const snap = makePlayer({ loadQueue: async () => noDuration(["4002"]) });
  await snap.player.restore();
  await snap.player.playAt(0);
  snap.fake.emit("loadedmetadata", { duration: 11 });
  assert.equal(snap.player.snapshot().currentTimeMs, 0, "真实时长只有 11 秒：距结尾不足 3 秒，从头放");
  assert.deepEqual(snap.fake.calls.seeks, [10_000, 0], "已经 seek 过就先要回 0");
});

test("播放中恢复的位置不重复写盘：读回来的东西不立刻写回去", async () => {
  const { player, persisted } = makePlayer({ loadQueue: async () => resumeRecord(51_234) });
  await player.restore();
  assert.equal(persisted.length, 0, "恢复不写盘（同内容重写只是多一次磁盘写入的机会）");
  await player.playAt(0);
  assert.equal(persisted.length, 0, "播放同一个位置也还是同一条记录");
});

test("异常退出最多丢 5 秒：节流窗口一到，最近的位置一定已经在盘上", async () => {
  const { player, fake, persisted, clock } = makePlayer();
  player.setQueue(songs(1), 0);
  await player.playAt(0);
  for (let second = 1; second <= 12; second += 1) {
    clock.advance(1000);
    fake.emit("timeupdate", { currentTime: second });
  }
  const last = persisted.at(-1).positionMs;
  assert.ok(last !== undefined && last >= 7_000, `最后落盘的位置太旧：${last}`);
  assert.ok(12_000 - last <= POSITION_WRITE_INTERVAL_MS, "异常退出丢掉的不超过一个节流窗口");
});
