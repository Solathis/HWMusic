/**
 * 播放器歌词的外观（R50）：**主窗歌词面板自己的颜色**，与桌面歌词窗的 `LyricsConfig` 无关。
 *
 * 为什么单独一份（而不是继续借桌面歌词的颜色）：R45B 起，主窗面板吃的是
 * `lyrics.config.customColor`——也就是 Rust 那份桌面歌词配置。于是"把桌面歌词改成绿色"
 * 会顺手把主窗歌词也染绿，用户没法只调一个。R50 让两边各有一份：
 *
 * - 桌面歌词：`lyricsWindow`（Rust 保留键，落盘由 Rust 的保存任务拥有）；
 * - 播放器歌词：**普通 settings 键** `playerLyrics`（本模块），走 `settings:get`/`settings:set`。
 *
 * 三条口径：
 * 1. **颜色令牌不另立一套**：直接复用 `lyrics-window.mjs` 的 `LYRICS_COLOR_TOKENS`
 *    （`foreground`/`muted`/`primary`/`contrast`），渲染层写进 `data-lyrics-color`，
 *    真正的颜色变量映射仍只在 `amll-theme.css` 那一处。
 * 2. **自定义颜色仍只认 `#RRGGBB`**，判定复用 `isCustomColor`（唯一真源，不另抄正则）；
 *    空串 = 用上面选的令牌。
 * 3. **认不出就回默认**（不猜）：坏值不会变成"上一份"以外的第三种状态。
 *
 * @typedef {object} PlayerLyricsConfig
 * @property {string} color 设计令牌 id（见 lyrics-window.mjs 的 LYRICS_COLOR_TOKENS）
 * @property {string} customColor `#RRGGBB` 或空串（空 = 用 color 令牌）
 */
import { LYRICS_COLOR_TOKENS, isCustomColor } from "./lyrics-window.mjs";

/** 设置文档里的键名（普通键：`settings:set` 的保留键闸门只拦 `theme`/`lyricsWindow`）。 */
export const PLAYER_LYRICS_SETTING_KEY = "playerLyrics";

/** 颜色令牌 id 列表（顺序即设置页的展示顺序）。 */
export const PLAYER_LYRICS_COLOR_IDS = LYRICS_COLOR_TOKENS.map((token) => token.id);

/** @type {PlayerLyricsConfig} */
export const DEFAULT_PLAYER_LYRICS = Object.freeze({ color: "foreground", customColor: "" });

/**
 * 归一（纯函数）：认不出的值落回 `base` 里那一个合法值（`base` 也认不出就落默认）。
 *
 * `base` 让"只改一半"的补丁成立：设置页换令牌时不该把用户选过的自定义颜色清掉。
 */
export function normalizePlayerLyrics(raw, base = DEFAULT_PLAYER_LYRICS) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const current = base !== null && typeof base === "object" ? base : DEFAULT_PLAYER_LYRICS;
  const pick = (key) => {
    const value = source[key];
    if (key === "customColor") {
      if (value === "") return "";
      return isCustomColor(value) ? value : isCustomColor(current[key]) ? current[key] : "";
    }
    return PLAYER_LYRICS_COLOR_IDS.includes(value)
      ? value
      : PLAYER_LYRICS_COLOR_IDS.includes(current[key]) ? current[key] : DEFAULT_PLAYER_LYRICS[key];
  };
  return { color: pick("color"), customColor: pick("customColor") };
}

/**
 * 设置文档（`settings:get` 的回执）→ 播放器歌词配置。
 *
 * 读不到 / 形状不认识都回默认：这一份配置只是颜色，没有"能不能用"的分支，
 * 所以不需要像代理那样把"读失败"当成另一种状态去报错。
 */
export function playerLyricsFromSettings(document) {
  const data = document !== null && typeof document === "object" ? document.data : null;
  const stored = data !== null && typeof data === "object" ? data[PLAYER_LYRICS_SETTING_KEY] : null;
  return normalizePlayerLyrics(stored);
}

/**
 * 播放器歌词配置 → `settings:set` 的 patch。
 *
 * 只有这一个键、只有两个字段：配置的形状只有一份（本模块），调用方不自己拼对象字面量
 * ——否则"多写一个字段"这种漂移就没有地方拦得住。
 */
export function playerLyricsPatch(config) {
  return { [PLAYER_LYRICS_SETTING_KEY]: normalizePlayerLyrics(config) };
}
