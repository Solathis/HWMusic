/**
 * 歌曲条目的展示投影（R8）：把"字段名不确定"的原始条目翻成能渲染的几项。
 *
 * 为什么渲染层还要一份候选表：接口响应里的字段名待联调确认（docs/API_CONTRACT.md §2.3），
 * 而协议层的 `trackIdOf` 只在 Node 侧跑。渲染层这里**不重建对象**——只做读取兜底，
 * 取不到就如实回占位（"未知歌曲"/"—"），绝不编一个看起来像真的值。
 *
 * 与协议层的关系：id 的候选顺序必须与 `src/protocols/music.mjs` 的 `trackIdOf` **同结论**，
 * test/library-views.test.mjs 用同一批夹具对两处做差分钉——分开演进就会让"能显示的 id"
 * 和"能去重的 id"分家（列表里出现删不掉的幽灵行）。
 */

/** 与协议层同序的 id 候选（差分测试钉住）。 */
const ID_KEYS = ["id", "songId", "musicId", "resourceId", "trackId"];
const NAME_KEYS = ["name", "songName", "title", "musicName"];
const ARTIST_TEXT_KEYS = ["singer", "singers", "artistNames", "artistName"];
const ALBUM_NAME_KEYS = ["albumName", "album"];
const ALBUM_ID_KEYS = ["albumId"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 曲目 id：与协议层 `trackIdOf` 同结论；取不到回 null（UI 侧不编 id）。 */
export function trackIdOf(item) {
  if (!isObject(item)) return null;
  for (const key of ID_KEYS) {
    const value = textOf(item[key]);
    if (value !== null) return value;
  }
  return null;
}

export function trackNameOf(item) {
  return trackNameOrNull(item) ?? "未知歌曲";
}

/**
 * 曲名（**取不到就是 null**，不造文案）。
 *
 * 队列快照需要区分"标题未知"与"标题是未知歌曲"——前者是数据层的事实，后者是界面上的说法。
 * 文案只该出现在 UI 层，
 * 所以把"可空"的读取单独暴露出来，键候选表仍然只有这一份（`trackNameOf` 也走它）。
 */
export function trackNameOrNull(item) {
  if (!isObject(item)) return null;
  for (const key of NAME_KEYS) {
    const value = textOf(item[key]);
    if (value !== null) return value;
  }
  return null;
}

/** 艺人（字符串/字符串数组/对象数组/嵌套 artist 对象）；**取不到就是 null**。 */
export function trackArtistsOrNull(item) {
  if (!isObject(item)) return null;

  const fromList = (list) => {
    const names = [];
    for (const entry of list) {
      const name = isObject(entry) ? textOf(entry.name) ?? textOf(entry.artistName) : textOf(entry);
      if (name !== null) names.push(name);
    }
    return names;
  };

  for (const key of ARTIST_TEXT_KEYS) {
    const value = item[key];
    const direct = textOf(value);
    if (direct !== null) return direct;
    if (Array.isArray(value)) {
      const names = fromList(value);
      if (names.length > 0) return names.join("、");
    }
  }

  for (const key of ["artist", "artists"]) {
    const value = item[key];
    const direct = isObject(value) ? textOf(value.name) : textOf(value);
    if (direct !== null) return direct;
    if (Array.isArray(value)) {
      const names = fromList(value);
      if (names.length > 0) return names.join("、");
    }
  }

  return null;
}

/** 艺人：可能是字符串、字符串数组、对象数组（`[{name}]`），也可能是嵌套的 `artist` 对象。 */
export function trackArtistsOf(item) {
  return trackArtistsOrNull(item) ?? "未知艺人";
}

export function trackAlbumOf(item) {
  return trackAlbumOrNull(item) ?? "未知专辑";
}

export function trackAlbumOrNull(item) {
  if (!isObject(item)) return null;
  for (const key of ALBUM_NAME_KEYS) {
    const value = item[key];
    const name = isObject(value) ? textOf(value.name) ?? textOf(value.albumName) : textOf(value);
    if (name !== null) return name;
  }
  return null;
}

/** 专辑 id：只有名字时回 null——专辑页打不开，就不在界面上装作能打开。 */
export function trackAlbumIdOf(item) {
  if (!isObject(item)) return null;
  const album = item.album;
  if (isObject(album)) {
    const nested = textOf(album.id) ?? textOf(album.albumId);
    if (nested !== null) return nested;
  }
  for (const key of ALBUM_ID_KEYS) {
    const value = textOf(item[key]);
    if (value !== null) return value;
  }
  return null;
}

/** 歌手 id：同上，从嵌套的 artist(s) 对象里找。 */
export function trackArtistIdOf(item) {
  if (!isObject(item)) return null;
  const candidates = [item.artistId, isObject(item.artist) ? item.artist.id : null];
  const list = Array.isArray(item.artists) ? item.artists : [];
  candidates.push(...list.map((entry) => (isObject(entry) ? entry.id : null)));
  for (const candidate of candidates) {
    const value = textOf(candidate);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 封面地址（R38 接线）。
 *
 * 协议层 `normalizeTrack` 产出的曲目**只在自己的白名单里**才会带 `coverUrl`
 * （`picture.bigImgURL` 等 → 白名单外的地址在投影时就被丢掉），所以这里读到的要么是
 * 一个 CDN 白名单内的地址，要么是 null。渲染层只把它交给 `<img src>`——**绝不 fetch**
 * （CSP 的 `connect-src` 只有 self/ipc，见 docs/API_CONTRACT.md §2.4）。
 *
 * 候选表与歌单那边同形（`playlistCoverUrlOf`）：字段名多一个不多，取不到就回 null，
 * 由调用方决定占位（界面上不留碎图）。
 */
export function trackCoverUrlOf(item) {
  if (!isObject(item)) return null;
  for (const key of ["coverUrl", "cover", "picUrl", "imageUrl"]) {
    const value = textOf(item[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 时长读数：**只认 `duration` 秒数**（协议层 durationOfEntry 已从可信顶层或标准 MP3 资源归一化）。
 * `times` 不具时长资格，任何层都不按它的量级猜单位。
 *
 * 这里不再猜别的名字：单位与键名换算都在协议层一处收口，渲染层只认内部形状。
 */
export function trackDurationOf(item) {
  if (!isObject(item)) return null;
  const raw = item.duration;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

/**
 * 时长格式化：只显示归一化后的秒数，不猜其他单位。
 * 取不到就是占位符——不显示 0:00（那看起来像"这首歌真的 0 秒"）。
 */
export function formatDuration(value) {
  // null/空串会被 Number() 悄悄变成 0（显示成 0:00，看起来像"这首歌真的 0 秒"）：先挡掉
  if (value === null || value === undefined || value === "") return "—";
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
