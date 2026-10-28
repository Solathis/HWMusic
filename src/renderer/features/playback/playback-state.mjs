/**
 * 播放器的文案：状态标签、失败人话、歌词占位文案。
 *
 * 与 `library-state.mjs` 同一条纪律——不冒充：接口没配置就说未配置，队列空就说下一步做什么，
 * 歌词 `unavailable`（没有来源）与 `empty`（确实没有）必须分开。
 */

/** 失败类别 → 一句话（类别来自状态机的结构化错误，core 的类别原样透传）。 */
export const PLAYBACK_FAILURE_TEXT = {
  queue_empty: "播放队列是空的（先在列表里双击一首歌）。",
  no_track: "没有选中可播放的曲目。",
  endpoint_unknown: "播放接口尚未配置（待联调确认）。",
  unimplemented: "该功能尚未接入（后续任务实现）。",
  unsafe_media_url: "播放地址不在允许的域名内，已拒绝装载。",
  invalid_response: "播放接口没有给出可用的音频地址。",
  network_error: "取播放地址失败（网络不通）。",
  http_error: "取播放地址失败（服务端返回错误）。",
  api_error: "取播放地址失败（接口返回业务错误）。",
  resolve_failed: "取播放地址失败（详情见日志）。",
  audio_error: "音频播放失败（音源不可用或格式不支持）。",
  core_unavailable: "内核尚未就绪，暂时无法播放。",
  core_gone: "内核已退出，重开应用后再试。",
  timeout: "请求超时，稍后再试。",
};

const UNKNOWN_FAILURE_TEXT = "播放失败（详情见日志）。";

/** 结构化错误 → 显示文案（认不出的类别带上 core 给的那句话，别丢掉唯一线索）。 */
export function playbackFailureText(error) {
  if (error === null || typeof error !== "object") return UNKNOWN_FAILURE_TEXT;
  const known = PLAYBACK_FAILURE_TEXT[error.kind];
  if (typeof known === "string") return known;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  if (message === "") return UNKNOWN_FAILURE_TEXT;
  return `播放失败：${message}`;
}

/** 播放器栏的状态副标题（与状态一一对应；不显示"错误"两个字，错误另有文案）。 */
export const PLAYER_STATUS_TEXT = {
  idle: "未在播放。",
  loading: "正在准备…",
  playing: "正在播放。",
  paused: "已暂停。",
  ended: "播放完毕。",
  error: "播放出错。",
};

/** 状态 → 副标题；有错误时优先显示错误的人话。 */
export function playerStatusText(state) {
  if (state !== null && typeof state === "object" && state.error !== null && state.error !== undefined) {
    return playbackFailureText(state.error);
  }
  const status = state !== null && typeof state === "object" ? state.status : null;
  return PLAYER_STATUS_TEXT[status] ?? PLAYER_STATUS_TEXT.idle;
}

/** 曲目标题：只知道标识时就显示标识——说"曲目 1001"才是实话，说"未知歌曲"会让人以为队列坏了。 */
export function trackTitleOf(track) {
  if (track === null || typeof track !== "object") return "未在播放";
  const name = typeof track.name === "string" && track.name.trim() !== "" ? track.name.trim() : null;
  if (name !== null) return name;
  const id = typeof track.id === "string" && track.id.trim() !== "" ? track.id.trim() : null;
  return id === null ? "未知歌曲" : `曲目 ${id}`;
}

/** 曲目艺人：取不到就是"未知艺人"（与 TrackTable 的展示投影同口径）。 */
export function trackArtistOf(track) {
  if (track === null || typeof track !== "object") return "";
  return typeof track.artists === "string" && track.artists.trim() !== "" ? track.artists.trim() : "未知艺人";
}

/** 歌词区的占位文案：没有来源 ≠ 取不到 ≠ 这首歌没有歌词，四档分开说。 */
export const LYRICS_NOTICE_TEXT = {
  unavailable: "歌词来源尚未配置。",
  loading: "正在取歌词…",
  empty: "这首歌没有歌词。",
  failed: "歌词暂时取不到（详情见日志）。",
};

/** 歌词状态 → 占位文案；有词时返回 `null`（界面不该再压一行字在歌词上）。 */
export function lyricsNoticeText(lyrics) {
  const status = lyrics !== null && typeof lyrics === "object" ? lyrics.status : null;
  if (status === "ready") return null;
  return LYRICS_NOTICE_TEXT[status] ?? LYRICS_NOTICE_TEXT.unavailable;
}

/** 播放模式的界面标签（值的唯一真源是播放器的 `PLAYBACK_MODES`）。 */
export const PLAYBACK_MODE_LABELS = {
  sequential: "顺序播放",
  "list-loop": "列表循环",
  "single-loop": "单曲循环",
  shuffle: "随机播放",
};

export function playbackModeLabel(mode) {
  return PLAYBACK_MODE_LABELS[mode] ?? PLAYBACK_MODE_LABELS.sequential;
}
