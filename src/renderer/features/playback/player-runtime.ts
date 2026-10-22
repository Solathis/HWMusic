/**
 * 播放运行时（R9）：把状态机、音频元素、地址闸门、队列持久化、媒体会话、
 * `player:command` 广播**装配成一个单例**。
 *
 * 分工：`player.mjs` 是纯逻辑（不知道 core、不知道 DOM），这个文件是它的**端口实现**。
 * 具体接的线：
 * - `resolveUrl`：`coreCall(PLAYBACK_RESOLVE_URL, {trackId})`——通道名来自共享常量；
 *   地址只在这条调用里出现，**不进状态、不写日志、不落盘**；
 * - `guardUrl`：`media-url.mjs`（CSP `media-src` 同源的白名单）；
 * - `persistQueue` / `loadQueue`：`settings:set` 的 `patch.queue`（标识 + 索引 + 安全展示快照）
 *   与 `settings:get` 的同一键（`null` = 删除，语义在 `src/main/settings.mjs`）；
 * - 媒体会话：只在该更新的时候更新（曲目或播放状态变化），避免每帧都去写系统控件；
 * - `player:command`：R11 托盘用的播放控制广播（预登记），认不出的命令只留痕。
 *
 * 单例的原因：音频元素、媒体会话、广播订阅都是"系统级资源"，多份会互相打架
 * （两个 Audio 同时出声、系统控件指向另一个实例）。React 严格模式会双挂载，
 * 所以单例必须建在模块层，而不是组件的 ref 里。
 */
import { PLAYER_COMMAND } from "../../../shared/channels.ts";
import { PLAYBACK_RESOLVE_URL, SETTINGS_GET, SETTINGS_SET } from "../../../shared/request-channels.ts";
import { coreCall, onCoreEvent } from "../../host-api.ts";
import { createAudioElementPort } from "./audio-element.mjs";
import { guardMediaUrl } from "./media-url.mjs";
import { createMediaSession } from "./media-session.mjs";
import { createPlayer } from "./player.mjs";
import { applyPlayerCommand } from "./player-commands.mjs";
import { QUEUE_SETTING_KEY } from "./queue.mjs";

/** core 调用的返回形状（`settings:get` / `settings:set`）。 */
interface SettingsAnswer {
  settings?: { schemaVersion?: number; data?: Record<string, unknown> };
}

export interface PlayerRuntimeDeps {
  callCore?: (channel: unknown, payload?: unknown) => Promise<unknown>;
  subscribeCoreEvent?: (channel: string, handler: (payload: unknown) => void) => Promise<() => void>;
  createAudio?: () => unknown;
  guardUrl?: (url: string) => string | null;
  /** `navigator.mediaSession`（显式 null = 这个环境没有；不传则取全局） */
  mediaSession?: object | null;
  /** `MediaMetadata` 构造器（测试注入假实现；不传则取全局） */
  metadataCtor?: new (init: object) => object;
  log?: (...parts: unknown[]) => void;
}

export interface PlayerRuntime {
  player: ReturnType<typeof createPlayer>;
  initialize: () => Promise<void>;
  dispose: () => void;
}

/** 与状态机同形的错误形状（core 的错误是这个形状，`coreCall` 抛出它）。 */
function coreFailureOf(cause: unknown): { kind?: string; message: string } {
  if (cause !== null && typeof cause === "object") {
    const value = cause as { kind?: unknown; message?: unknown };
    return {
      ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
      message: typeof value.message === "string" && value.message !== "" ? value.message : "请求播放地址失败",
    };
  }
  return { message: typeof cause === "string" && cause !== "" ? cause : "请求播放地址失败" };
}

/**
 * 造播放运行时。
 *
 * @param {PlayerRuntimeDeps} deps 全部端口可注入（测试用假 core/假音频/假媒体会话）
 */
export function createPlayerRuntime(deps: PlayerRuntimeDeps = {}): PlayerRuntime {
  const callCore =
    deps.callCore ?? ((channel: unknown, payload?: unknown) => coreCall(channel as never, payload));
  const subscribeCoreEvent = deps.subscribeCoreEvent ?? onCoreEvent;
  const createAudio = deps.createAudio ?? (() => createAudioElementPort({ log }));
  // 只在错误路径留痕（`console.warn` 是既有约定；`console.log` 被扫描禁止）
  const log: (...parts: unknown[]) => void = deps.log ?? ((...parts) => console.warn("[hwmusic-renderer]", ...parts));

  const player = createPlayer({
    audio: createAudio() as never,
    // coreCall 成功时直接给 data；失败时**抛出** core 错误（kind/message 会被状态机原样保留）
    resolveUrl: async (trackId: string) => ({ ok: true as const, data: (await callCore(PLAYBACK_RESOLVE_URL, { trackId })) as never }),
    guardUrl: deps.guardUrl ?? guardMediaUrl,
    persistQueue: async (record: import("./queue.mjs").QueueRecord | null) => {
      await callCore(SETTINGS_SET, { patch: { [QUEUE_SETTING_KEY]: record } });
    },
    loadQueue: async () => {
      const answer = (await callCore(SETTINGS_GET)) as SettingsAnswer | null;
      const data = answer?.settings?.data;
      return data !== null && typeof data === "object" ? (data[QUEUE_SETTING_KEY] ?? null) : null;
    },
    log,
  });

  const mediaSession = createMediaSession({
    ...(deps.mediaSession === undefined ? {} : { session: deps.mediaSession }),
    ...(deps.metadataCtor === undefined ? {} : { metadataCtor: deps.metadataCtor }),
    log,
  });

  // 媒体会话只在"曲目或播放状态"真的变了的时候更新：每帧都写系统控件是白烧 CPU 与日志
  let lastMediaKey = "";
  const unsubscribeState = player.subscribe((state: ReturnType<typeof player.snapshot>) => {
    const track = state.track;
    const key = JSON.stringify([state.status, track?.id, track?.name, track?.artists, track?.albumName, track?.coverUrl]);
    if (key === lastMediaKey) return;
    lastMediaKey = key;
    mediaSession.update({ track: state.track, status: state.status });
  });

  mediaSession.attach({
    play: () => void player.play(),
    pause: () => player.pause(),
    next: () => void player.next(),
    previous: () => void player.previous(),
    seek: (ms: number) => player.seek(ms),
  });

  // `player:command`（R11 托盘的预登记频道）：广播是别人发来的，任何坏载荷都不许把播放器打崩
  let unlisten: (() => void) | null = null;
  let disposed = false;
  const subscription = subscribeCoreEvent(PLAYER_COMMAND, (payload: unknown) => {
    if (disposed) return;
    void applyPlayerCommand(player, payload).then((answer: { ok: boolean; error?: { message: string } }) => {
      if (!answer.ok) log(`媒体播放命令未受理：${answer.error?.message ?? "未知原因"}`);
    });
  });
  void subscription.then((off) => {
    if (disposed) off();
    else unlisten = off;
  });

  let initialized = false;

  async function initialize(): Promise<void> {
    if (initialized) return;
    initialized = true;
    await player.restore();
  }

  function dispose(): void {
    disposed = true;
    unsubscribeState();
    if (unlisten !== null) unlisten();
    player.pause();
    player.dispose();
    mediaSession.clear();
  }

  return { player, initialize, dispose };
}

/** 单例：模块级（不是组件 ref）——React 严格模式会双挂载组件，而音频只能有一个。 */
let runtime: PlayerRuntime | null = null;

/** 取（首次调用时创建并恢复队列的）播放运行时。 */
export function getPlayerRuntime(): PlayerRuntime {
  if (runtime === null) {
    runtime = createPlayerRuntime();
    void runtime.initialize();
  }
  return runtime;
}

if (import.meta.hot) import.meta.hot.dispose(() => { runtime?.dispose(); runtime = null; });
