/**
 * R9 播放运行时（`features/playback/player-runtime.ts`）与它的两个端口：
 * 音频元素（`audio-element.mjs`，**全应用唯一 new Audio() 的地方**）
 * 与媒体地址闸门（`media-url.mjs`，渲染层唯一的协议层引用）。
 *
 * 这个文件钉四件事：
 * 1. **单 Audio 实例**：源码扫描全渲染层只有一处 `new Audio(`，且事件/单位适配正确
 *    （DOM 的 currentTime 是秒，状态机与 AMLL 用毫秒——这里换算，别处不许再算）；
 * 2. **地址闸门**：`guardMediaUrl` 与协议层 `safeMediaUrl` 同结论（CSP media-src 同源），
 *    渲染层放行地址只走它；
 * 3. **装配**：取地址走 `playback:resolve-url`（通道名来自共享常量）、队列持久化只写
 *    `settings:set` 的 `patch.queue`（且不含地址）、`player:command` 广播接到状态机上；
 * 4. **地址不外泄**：日志里不出现地址，持久化里不出现地址。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAudioElementPort } from "../src/renderer/features/playback/audio-element.mjs";
import { guardMediaUrl } from "../src/renderer/features/playback/media-url.mjs";
import { createPlayerRuntime } from "../src/renderer/features/playback/player-runtime.ts";
import { QUEUE_SETTING_KEY } from "../src/renderer/features/playback/queue.mjs";
import { PLAYER_STATUS } from "../src/renderer/features/playback/player.mjs";
import { PLAYBACK_RESOLVE_URL, SETTINGS_GET, SETTINGS_SET } from "../src/shared/request-channels.ts";
import { PLAYER_COMMAND } from "../src/shared/channels.ts";
import { safeMediaUrl } from "../src/protocols/safe-media-url.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 假的 Audio 元素类：够 audio-element.mjs 用（addEventListener/属性）。 */
function fakeAudioClass() {
  const created = [];
  class FakeAudio {
    constructor() {
      this.listeners = new Map();
      this.src = "";
      this.currentTime = 0;
      this.volume = 1;
      this.muted = false;
      this.playCalls = 0;
      created.push(this);
    }
    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? [];
      list.push(handler);
      this.listeners.set(name, list);
    }
    removeEventListener(name, handler) {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter((entry) => entry !== handler));
    }
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    }
    pause() {}
    dispatch(name) {
      for (const handler of [...(this.listeners.get(name) ?? [])]) handler({ target: this });
    }
  }
  return { FakeAudio, created };
}

const SAFE_URL = "https://music.dbankcdn.cn/song/1.mp3";

test("音频端口：一个实例、单位换算（毫秒↔秒）、事件转成状态机认的载荷", async () => {
  const { FakeAudio, created } = fakeAudioClass();
  const port = createAudioElementPort({ AudioCtor: FakeAudio, log: () => {} });
  assert.equal(created.length, 1, "端口只造一个音频元素（单实例）");

  port.setSource(SAFE_URL);
  assert.equal(created[0].src, SAFE_URL);
  port.setCurrentTime(12_500);
  assert.equal(created[0].currentTime, 12.5, "DOM 用秒，状态机用毫秒：只在适配层换算");
  port.setVolume(0.4);
  assert.equal(created[0].volume, 0.4);
  port.setMuted(true);
  assert.equal(created[0].muted, true);
  await port.play();
  assert.equal(created[0].playCalls, 1);
  port.pause();

  const seen = [];
  const off = port.on("timeupdate", (payload) => seen.push(payload));
  created[0].currentTime = 3.25;
  created[0].dispatch("timeupdate");
  assert.deepEqual(seen, [{ currentTime: 3.25 }], "事件载荷要带出 target 上的读数（状态机不碰 DOM）");
  created[0].dispatch("loadedmetadata");
  off();
  created[0].dispatch("timeupdate");
  assert.equal(seen.length, 1, "退订之后不再回调");
});

test("音频端口：没有可用的 Audio 实现时如实报错（而不是留一个半死的播放器）", () => {
  assert.throws(
    () => createAudioElementPort({ AudioCtor: undefined, globalObject: {}, log: () => {} }),
    /Audio/,
    "拿不到 Audio 构造器要立刻说清楚（这是环境问题，不是播放失败）",
  );
});

test("地址闸门：与协议层同结论（白名单域放行并归一化，其余一律 null）", () => {
  const samples = [
    "https://music.dbankcdn.cn/song/1.mp3",
    "https://a.b.c.kuke.com/x.mp3",
    "http://music.dbankcdn.cn/1.mp3",
    "https://evil-dbankcdn.cn/1.mp3",
    "https://user:pass@music.dbankcdn.cn/1.mp3",
    "https://music.dbankcdn.cn:8443/1.mp3",
    "不是地址",
    "",
    null,
    42,
  ];
  for (const sample of samples) {
    assert.equal(guardMediaUrl(sample), safeMediaUrl(sample), `闸门与协议层真源必须同结论：${String(sample)}`);
  }
  assert.equal(guardMediaUrl("https://music.dbankcdn.cn/song/1.mp3"), "https://music.dbankcdn.cn/song/1.mp3");
});

/** 装配一个假 core：按频道回脚本化结果，并记录每一次调用。 */
function fakeCore({ resolve = { url: SAFE_URL }, settings = {}, resolveError = null } = {}) {
  const calls = [];
  return {
    calls,
    callCore: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === PLAYBACK_RESOLVE_URL) {
        if (resolveError !== null) throw resolveError;
        return resolve;
      }
      if (channel === SETTINGS_GET) return { settings: { schemaVersion: 1, data: settings } };
      if (channel === SETTINGS_SET) return { settings: { schemaVersion: 1, data: settings }, restartRequired: false };
      throw { message: `未脚本化的频道：${channel}`, kind: "unexpected" };
    },
    of: (channel) => calls.filter((call) => call.channel === channel),
  };
}

function fakeSession() {
  const handlers = new Map();
  const metadata = [];
  let playbackState = "none";
  return {
    session: {
      setActionHandler(action, handler) {
        handlers.set(action, handler);
      },
      set metadata(value) {
        metadata.push(value);
      },
      get metadata() {
        return metadata.at(-1) ?? null;
      },
      get playbackState() {
        return playbackState;
      },
      set playbackState(value) {
        playbackState = value;
      },
    },
    handlers,
    metadata,
    state: () => playbackState,
  };
}

/** 假 MediaMetadata（node 里没有这个全局；不注入它就只能测到"没写元数据"）。 */
class FakeMetadata {
  constructor(init) {
    this.init = init;
  }
}

/** 等一次微任务：广播处理器是"发出去就不管"的（`void`），断言前要让它跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRuntime({ core = fakeCore(), audio = fakeAudioClass(), session = fakeSession(), log = [] } = {}) {
  const subscribed = [];
  const runtime = createPlayerRuntime({
    callCore: core.callCore,
    subscribeCoreEvent: async (channel, handler) => {
      subscribed.push({ channel, handler });
      return () => subscribed.splice(subscribed.indexOf(channel), 1);
    },
    createAudio: () => createAudioElementPort({ AudioCtor: audio.FakeAudio, log: () => {} }),
    mediaSession: session.session,
    metadataCtor: FakeMetadata,
    log: (...parts) => log.push(parts.join(" ")),
  });
  return { runtime, core, audio, session, log, subscribed };
}

test("装配：取地址走 playback:resolve-url（通道名来自共享常量），地址过闸门后才装载", async () => {
  const { runtime, core, audio } = makeRuntime();
  const songs = [
    { id: "1001", name: "第一首", singer: "歌手", duration: 200 },
    { id: "1002", name: "第二首", singer: "歌手", duration: 210 },
  ];

  const result = await runtime.player.playQueue(songs, 1);
  assert.equal(result.ok, true, JSON.stringify(result));

  assert.equal(core.of(PLAYBACK_RESOLVE_URL).length, 1);
  assert.equal(core.of(PLAYBACK_RESOLVE_URL)[0].channel, "playback:resolve-url");
  assert.deepEqual(core.of(PLAYBACK_RESOLVE_URL)[0].payload, { trackId: "1002" });
  assert.equal(audio.created.length, 1, "整个运行时只有一个音频元素");
  assert.equal(audio.created[0].src, SAFE_URL, "装载的是当次取回的地址");
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.playing);
  assert.doesNotMatch(JSON.stringify(runtime.player.snapshot()), /dbankcdn|http/, "地址不进状态");
});

test("取地址失败：core 的结构化错误原样落到状态里（UI 才说得出「接口尚未配置」）", async () => {
  const { runtime, audio } = makeRuntime({
    core: fakeCore({ resolveError: { message: "接口端点 playback 尚未确定", kind: "endpoint_unknown" } }),
  });
  runtime.player.setQueue([{ id: "1", name: "x" }], 0);
  const result = await runtime.player.playAt(0);

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "endpoint_unknown");
  assert.equal(runtime.player.snapshot().error.kind, "endpoint_unknown");
  assert.equal(audio.created[0].src, "", "没拿到地址就什么都不装载");
});

test("队列持久化：只写 settings:set 的 patch.queue（只有 ids + index，绝不含地址）", async () => {
  const { runtime, core } = makeRuntime();
  await runtime.player.playQueue(
    [
      { id: "1001", name: "第一首" },
      { id: "1002", name: "第二首" },
    ],
    0,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const writes = core.of(SETTINGS_SET);
  assert.ok(writes.length >= 1, `队列变化必须写盘：${JSON.stringify(core.calls)}`);
  const patch = writes.at(-1).payload;
  assert.deepEqual(Object.keys(patch), ["patch"], "settings:set 的载荷形状是 {patch}");
  assert.deepEqual(Object.keys(patch.patch), [QUEUE_SETTING_KEY]);
  assert.deepEqual(patch.patch.queue, { ids: ["1001", "1002"], index: 0 });
  assert.doesNotMatch(JSON.stringify(writes), /http|dbankcdn/, "地址绝不落盘");

  // 清空 = 删除该键（null 语义由 settings.mjs 承担）
  runtime.player.clear();
  assert.equal(core.of(SETTINGS_SET).at(-1).payload.patch.queue, null);
});

test("初始化：从 settings 恢复队列与索引，且不自动开始播放", async () => {
  const { runtime, core } = makeRuntime({
    core: fakeCore({ settings: { [QUEUE_SETTING_KEY]: { ids: ["2001", "2002"], index: 1 } } }),
  });
  await runtime.initialize();

  assert.equal(core.of(SETTINGS_GET).length, 1);
  const state = runtime.player.snapshot();
  assert.deepEqual(
    state.entries.map((entry) => entry.id),
    ["2001", "2002"],
  );
  assert.equal(state.index, 1);
  assert.equal(state.status, PLAYER_STATUS.idle, "恢复不自动播放");
  assert.equal(core.of(PLAYBACK_RESOLVE_URL).length, 0, "恢复不该顺手取地址（用户还没要求播放）");
});

test("player:command 广播（R11 托盘预登记）：订阅共享常量频道，命令落到状态机上", async () => {
  const { runtime, subscribed } = makeRuntime();
  runtime.player.setQueue([{ id: "1", name: "第一首" }], 0);

  assert.equal(subscribed.length, 1, "只订阅这一条广播");
  assert.equal(subscribed[0].channel, PLAYER_COMMAND);
  assert.equal(PLAYER_COMMAND, "player:command");

  await subscribed[0].handler({ command: "play" });
  await flush();
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.playing);

  await subscribed[0].handler({ command: "pause" });
  await flush();
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.paused);

  await subscribed[0].handler({ command: "toggle" });
  await flush();
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.playing);
});

test("player:command 的坏命令：只记日志（广播是别人发来的，不该把播放器打崩）", async () => {
  const { runtime, subscribed, log } = makeRuntime();
  runtime.player.setQueue([{ id: "1", name: "第一首" }], 0);

  await subscribed[0].handler({ command: "stop-everything" });
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.idle, "认不出的命令不改状态");
  assert.equal(log.length > 0, true, "要留痕，否则「托盘点了没反应」没法查");
});

test("媒体会话：曲目/状态变化才更新系统控件；进度与音量不打扰它", async () => {
  const session = fakeSession();
  const { runtime } = makeRuntime({ session });
  runtime.player.setQueue([{ id: "1001", name: "第一首", singer: "歌手" }], 0);
  await runtime.player.playAt(0);

  assert.equal(session.state(), "playing");
  const afterPlay = session.metadata.length;
  assert.ok(afterPlay >= 1, "播放开始后系统控件里要有这一首");
  assert.equal(session.metadata.at(-1).init.title, "第一首");

  // 进度是每帧都在变的东西：不许每帧都去写系统控件
  runtime.player.seek(1000);
  assert.equal(session.metadata.length, afterPlay, "拖进度不是媒体会话的事");

  runtime.player.setVolume(0.3);
  assert.equal(session.metadata.length, afterPlay, "音量不是媒体会话的事");

  runtime.player.pause();
  assert.equal(session.state(), "paused");
  assert.equal(session.metadata.length, afterPlay + 1, "状态变了才写一次");

  // 系统控件（耳机按键）回调必须真的作用在状态机上
  assert.equal(typeof session.handlers.get("play"), "function");
  session.handlers.get("pause")();
  assert.equal(runtime.player.snapshot().status, PLAYER_STATUS.paused);
});

test("dispose：退订广播、摘掉媒体会话（不留幽灵）", async () => {
  const session = fakeSession();
  const { runtime, subscribed } = makeRuntime({ session });
  runtime.player.setQueue([{ id: "1", name: "第一首" }], 0);
  await runtime.player.playAt(0);
  assert.equal(session.state(), "playing");

  runtime.dispose();
  assert.equal(subscribed.length, 0, "广播订阅已退订");
  assert.equal(session.state(), "none", "媒体会话清空");
});

test("源码扫描：单 Audio 实例（只有 audio-element.mjs 里 new Audio）", () => {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(child);
    }
  };
  walk("src/renderer");

  const offenders = files.filter(
    (relative) =>
      /new\s+Audio(?:Ctor)?\s*\(/.test(stripComments(read(relative))) &&
      relative !== "src/renderer/features/playback/audio-element.mjs",
  );
  assert.deepEqual(offenders, [], "全应用只能有一个音频元素：new Audio() 只许出现在 audio-element.mjs");
  assert.match(
    stripComments(read("src/renderer/features/playback/audio-element.mjs")),
    /new\s+Audio(?:Ctor)?\s*\(/,
    "audio-element.mjs 必须真的在造音频元素（否则上面那条扫描就是空转）",
  );
});

test("源码扫描：渲染层引用协议层只有媒体地址闸门这一处（业务 HTTP 仍只在 sidecar）", () => {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(child);
    }
  };
  walk("src/renderer");

  const offenders = files.filter(
    (relative) => /protocols\//.test(stripComments(read(relative))) && relative !== "src/renderer/features/playback/media-url.mjs",
  );
  assert.deepEqual(offenders, [], "协议层（业务 HTTP/端点/凭据）不许进渲染层；唯一例外是纯函数地址闸门");
  assert.match(read("src/renderer/features/playback/media-url.mjs"), /protocols\/safe-media-url\.mjs/);
});

test("源码扫描：地址只在当次应答里流转（渲染层不得缓存/打印地址）", () => {
  const runtime = stripComments(read("src/renderer/features/playback/player-runtime.ts"));
  assert.doesNotMatch(runtime, /console\.(log|info|debug)/, "调试输出会带上地址（渲染层控制台也进日志文件）");
  assert.doesNotMatch(runtime, /localStorage|sessionStorage|indexedDB/, "地址不落任何本地存储");
  // 持久化只经 settings:set 的 patch.queue，别的地方不许碰 settings 写入
  const setters = runtime.match(/callCore\(\s*SETTINGS_SET/g) ?? [];
  assert.equal(setters.length, 1, `settings:set 只该有一处（队列持久化）：${setters.length}`);
});

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
