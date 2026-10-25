/**
 * 音频元素端口（R9）：**全应用唯一 `new Audio()` 的地方**。
 *
 * 为什么单实例：媒体元素是"系统级资源"——每个实例都会在系统媒体控件、音频会话、
 * 播放设备占用上各占一份。多个 `Audio` 同时存在时，"暂停"到底暂停了谁就成了运气问题
 * （旧仓的经典 bug：切歌时旧实例还在放，两个声音叠在一起）。
 *
 * 这个端口只做两件事：
 * 1. 把 DOM 的属性/方法与状态机对齐（**单位换算只在这里**：DOM 的 `currentTime` 是秒，
 *    状态机与 AMLL 用毫秒）；
 * 2. 把 DOM 事件转成状态机认得的载荷（`{duration}` / `{currentTime}`）——状态机不碰 DOM，
 *    所以它能被完整地单元测试。
 *
 * 安全：设地址前必须过 `media-url.mjs` 闸门（状态机强制要求 `guardUrl`），
 * 这里的 `setSource` 只负责把已经放行的地址交给元素；CSP `media-src` 是最后一道网。
 */

/** 音频元素认的事件（状态机侧同名常量见 player.mjs 的 `PLAYER_AUDIO_EVENTS`）。 */
export const AUDIO_ELEMENT_EVENTS = ["ended", "error", "loadedmetadata", "durationchange", "timeupdate", "playing", "waiting"];

/** 事件 → 载荷：只有需要读数的两个事件带载荷（其余是"发生了什么"）。 */
const EVENT_PAYLOAD = {
  ended: () => undefined,
  error: () => undefined,
  loadedmetadata: (element) => ({ duration: element.duration }),
  durationchange: (element) => ({ duration: element.duration }),
  timeupdate: (element) => ({ currentTime: element.currentTime }),
  playing: () => undefined,
  waiting: () => undefined,
};

/**
 * 造音频端口（单实例：调用方只该造一次，见 `player-runtime.ts` 的单例装配）。
 *
 * @param {object} [options]
 * @param {new () => HTMLAudioElement} [options.AudioCtor] 音频构造器（测试注入假实现）
 * @param {object} [options.globalObject] 取 `Audio` 的全局对象（默认 globalThis）
 * @param {(...parts: unknown[]) => void} [options.log]
 */
export function createAudioElementPort(options = {}) {
  const globalObject = options.globalObject ?? globalThis;
  const AudioCtor = options.AudioCtor ?? globalObject?.Audio;
  const log = typeof options.log === "function" ? options.log : () => {};

  if (typeof AudioCtor !== "function") {
    throw new TypeError("createAudioElementPort 需要可用的 Audio 构造器（当前环境没有：无法播放音频）");
  }

  const element = new AudioCtor();
  // 预取元数据：没有它时长要等下载到才出现，进度条就一直是"未知总长"
  try {
    element.preload = "metadata";
  } catch (cause) {
    log("无法设置音频预取模式（不影响播放）：", String(cause));
  }

  return {
    /** 装载地址。**地址必须已经过媒体白名单闸门**（状态机强制）。 */
    setSource(url) {
      element.src = url;
    },

    /** 播放：把 DOM 的 Promise 原样交给状态机（拒绝会被收成 audio_error）。 */
    play() {
      return element.play();
    },

    pause() {
      element.pause();
    },

    /** 跳转：**毫秒 → 秒**（唯一换算点）。没有可跳转的媒体时不抛，只留痕。 */
    setCurrentTime(ms) {
      try {
        element.currentTime = Number(ms) / 1000;
      } catch (cause) {
        log("设置播放进度失败（忽略本次跳转）：", String(cause));
      }
    },

    setVolume(value) {
      element.volume = value;
    },

    setMuted(value) {
      element.muted = value;
    },

    /** 事件订阅：返回退订函数（状态机 dispose 时逐个摘掉）。 */
    on(name, handler) {
      if (!AUDIO_ELEMENT_EVENTS.includes(name)) {
        throw new TypeError(`未知的音频事件：${name}（唯一清单见 AUDIO_ELEMENT_EVENTS）`);
      }
      const listener = (event) => {
        const payloadOf = EVENT_PAYLOAD[name];
        handler(payloadOf(event?.target ?? element));
      };
      element.addEventListener(name, listener);
      return () => element.removeEventListener(name, listener);
    },
  };
}
