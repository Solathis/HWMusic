/**
 * 曲目行 / 队列行的专属菜单：**菜单项由这里决定**（界面只负责把它们画成 shadcn 的项）。
 * 队列行少一件「加入播放队列」；动作没接就不出那一项——按下去什么都不发生的按钮比没有更糟。
 * 「加入歌单」要有"向已有歌单追加歌曲"的官方端点证据（docs/API_CONTRACT.md §2.13），没有就不上菜单。
 */

export const TRACK_MENU_TARGET = Object.freeze({
  track: "track-table",
  queue: "queue-panel",
});

export const TRACK_MENU_ITEM = Object.freeze({
  play: "play",
  playNext: "play-next",
  enqueue: "enqueue",
  addToPlaylist: "add-to-playlist",
});

/** 加歌端点的证据状态（唯一开关：证据落地才翻，翻的时候同步 docs/API_CONTRACT.md）。 */
export const ADD_TO_PLAYLIST_SUPPORTED = false;

/** 菜单本体与单项的锚点（守卫按它找，文案改动不许影响断言）。 */
export const TRACK_MENU_TESTID = "row-context-menu";
export const trackMenuItemTestId = (id) => `row-menu-${id}`;

const ITEM_ORDER = Object.freeze({
  [TRACK_MENU_TARGET.track]: [
    { id: TRACK_MENU_ITEM.play, label: "播放", option: "play" },
    { id: TRACK_MENU_ITEM.playNext, label: "下一首播放", option: "playNext" },
    { id: TRACK_MENU_ITEM.enqueue, label: "加入播放队列", option: "enqueue" },
  ],
  [TRACK_MENU_TARGET.queue]: [
    { id: TRACK_MENU_ITEM.play, label: "播放", option: "play" },
    { id: TRACK_MENU_ITEM.playNext, label: "下一首播放", option: "playNext" },
  ],
});

/**
 * @param {string} target `TRACK_MENU_TARGET` 的取值（认不出就没有菜单）
 * @param {{play?: boolean, playNext?: boolean, enqueue?: boolean, addToPlaylist?: boolean}} [options] 显式 `false` 的动作不出项
 * @returns {{id: string, label: string}[]}
 */
export function trackMenuItems(target, options = {}) {
  const order = Object.hasOwn(ITEM_ORDER, target ?? "") ? ITEM_ORDER[target] : null;
  if (order === null) return [];
  const available = (option) => (Object.hasOwn(options, option) ? options[option] !== false : true);
  const items = order.filter((entry) => available(entry.option)).map(({ id, label }) => ({ id, label }));
  const addToPlaylist = Object.hasOwn(options, "addToPlaylist") ? options.addToPlaylist : ADD_TO_PLAYLIST_SUPPORTED;
  if (addToPlaylist === true) items.push({ id: TRACK_MENU_ITEM.addToPlaylist, label: "加入歌单" });
  return items;
}
