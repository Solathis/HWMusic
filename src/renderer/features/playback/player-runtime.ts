/**
 * 播放运行时：把状态机、音频元素、地址闸门、队列持久化、媒体会话与 `player:command` 广播装配成一个单例。
 * `player.mjs` 是纯逻辑，这个文件是它的端口实现；地址只出现在 `resolveUrl` 那条调用里，不进状态、不写日志、不落盘。
 * 单例建在模块层：音频元素与媒体会话都是系统级资源，多份会互相打架，而 React 严格模式会双挂载。
 */
import { toast } from "sonner";
import { PLAYER_COMMAND } from "../../../shared/channels.ts";import { PLAYBACK_RESOLVE_URL, SETTINGS_GET, SETTINGS_SET } from "../../../shared/request-channels.ts";
import { LOCAL_TRACK_PREFIX, isLocalTrackId, localHexId } from "../../../shared/local-track.ts";
import { coreCall, onCoreEvent } from "../../host-api.ts";
import { fetchLocalLibrary, localBaseUrlCached } from "../library/local-bridge.ts";
import { describeSkippedLocalTracks, localMediaUrl } from "../library/local-library.mjs";
import { createAudioElementPort } from "./audio-element.mjs";
import { guardMediaUrl } from "./media-url.mjs";
import { createMediaSession } from "./media-session.mjs";
import { createPlayer } from "./player.mjs";
import { applyPlayerCommand } from "./player-commands.mjs";
import { dropUnavailableLocalEntries, QUEUE_SETTING_KEY } from "./queue.mjs";

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
  /** 主窗 document（隐藏前落盘进度用；测试注入假实现，不传则取全局） */
  documentHost?: DocumentHost | null;
  /** 主窗 window（pagehide 时落盘；测试注入假实现，不传则取全局） */
  windowHost?: WindowHost | null;
  /**
   * 本地曲目的协议基址（不传则问宿主一次并缓存，见 `localBaseUrlCached`）。
   * 注入点存在的原因：`local:` 曲目的播放地址只由它拼出来，这条路径必须能在 node 里测。
   */
  localBaseUrl?: () => Promise<string | null>;
  /** 本地曲库快照（只取 id 与可用性；不传则问宿主）。恢复队列时用它判"文件还在不在" */
  localLibraryIds?: () => Promise<{ id: string; available: boolean }[]>;
  /** 一句话提示（队列里有本歌曲目被跳过时用；不传则只留痕） */
  notify?: (text: string) => void;
  log?: (...parts: unknown[]) => void;
}

/** 监听器只需要这两件事（node 里没有 document/window，所以是可注入的端口）。 */
export interface DocumentHost {
  readonly visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export type WindowHost = Omit<DocumentHost, "visibilityState">;

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

  /** 本地曲库的协议基址（注入点优先；默认问宿主一次并缓存）。 */
  const localBaseUrl = deps.localBaseUrl ?? localBaseUrlCached;

  /** 本地曲库快照（注入点优先；默认问宿主）。恢复队列时只用到 id 与可用性。 */
  const readLocalTracks =
    deps.localLibraryIds ?? (async () => (await fetchLocalLibrary()).tracks.map((song) => ({ id: song.localId, available: song.available })));

  /** 恢复队列时用得上的本地曲目：只取 id 与可用性；问不到时回 `null` = 这一次不判，不动用户的队列。 */
  async function localAvailableIds(): Promise<Set<string> | null> {
    try {
      const tracks = await readLocalTracks();
      if (!Array.isArray(tracks)) return null;
      return new Set(
        tracks
          .filter((track) => track !== null && typeof track === "object" && track.available !== false)
          .map((track) => `${LOCAL_TRACK_PREFIX}${String(track.id ?? "")}`),
      );
    } catch (cause) {
      log("本地曲库这次读不到（队列里的本地曲目按原样保留）：", cause);
      return null;
    }
  }

  const player = createPlayer({
    audio: createAudio() as never,
    // coreCall 成功时直接给 data；失败时**抛出** core 错误（kind/message 会被状态机原样保留）
    resolveUrl: async (trackId: string) => {
      if (isLocalTrackId(trackId)) {
        // 本地曲目**不走在线的 playback:resolve-url**：那个 id 在华为侧不存在，
        // 问了只会换来一个陌生错误。地址由协议按 id 拼（拖进度靠协议的 Range 支持）。
        const baseUrl = await localBaseUrl();
        const hexId = localHexId(trackId);
        const url = baseUrl === null || hexId === null ? null : localMediaUrl(baseUrl, hexId);
        return url === null
          ? { ok: false as const, error: { kind: "local_unavailable", message: "本地曲库不可用（这首歌现在打不开）" } }
          : { ok: true as const, data: { url } as never };
      }
      return { ok: true as const, data: (await callCore(PLAYBACK_RESOLVE_URL, { trackId })) as never };
    },
    guardUrl: deps.guardUrl ?? guardMediaUrl,
    persistQueue: async (record: import("./queue.mjs").QueueRecord | null) => {
      await callCore(SETTINGS_SET, { patch: { [QUEUE_SETTING_KEY]: record } });
    },
    loadQueue: async () => {
      const answer = (await callCore(SETTINGS_GET)) as SettingsAnswer | null;
      const data = answer?.settings?.data;
      const record = data !== null && typeof data === "object" ? (data[QUEUE_SETTING_KEY] ?? null) : null;
      // 恢复时跳过「文件已不在」的本地曲目；曲库读不到（`null`）就整段跳过判定。
      const availableIds = await localAvailableIds();
      const filtered =
        availableIds === null ? { record, skipped: 0 } : dropUnavailableLocalEntries(record, availableIds);
      if (filtered.skipped > 0) {
        const text = describeSkippedLocalTracks(filtered.skipped);
        if (typeof deps.notify === "function") deps.notify(text);
        else log(text);
      }
      return filtered.record;
    },
    log,
  });

  /**
   * 主窗隐藏到托盘 / 关闭前最后落盘一次进度。
   * WebView2 里 visibilitychange 是否必达没有证据（见报告），"暂停"那条路才是主要保障。
   */
  const documentHost = deps.documentHost === undefined ? (typeof document === "undefined" ? null : document) : deps.documentHost;
  const windowHost = deps.windowHost === undefined ? (typeof window === "undefined" ? null : window) : deps.windowHost;
  const flushOnHide = () => {
    player.flushPosition();
  };
  const onVisibilityChange = () => {
    if (documentHost?.visibilityState === "hidden") flushOnHide();
  };
  documentHost?.addEventListener("visibilitychange", onVisibilityChange);
  windowHost?.addEventListener("pagehide", flushOnHide);

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

  // `player:command` 是别人发来的广播：任何坏载荷都不许把播放器打崩。
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
    documentHost?.removeEventListener("visibilitychange", onVisibilityChange);
    windowHost?.removeEventListener("pagehide", flushOnHide);
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
    runtime = createPlayerRuntime({
      // 一句话提示走 shadcn 的 Toaster：队列里「文件已不在」的本地曲目要在界面上说出来。
      notify: (text) => toast(text),
    });
    void runtime.initialize();
  }
  return runtime;
}

if (import.meta.hot) import.meta.hot.dispose(() => { runtime?.dispose(); runtime = null; });
