/**
 * 第三方歌词的**纯匹配器**（R41；移植自参考实现 `.tmp/reference-repo/src/main/lyrics-provider.mjs`）。
 *
 * 网络访问不在这里（见 `src/main/lyrics-fallback.mjs`）：本模块只有"给定候选与查询，选哪一个"
 * 这一类**确定性**判断，所以能整片跑单测。
 *
 * ## 为什么匹配必须严格
 *
 * 第三方库是**公开歌词库**，它按关键字模糊搜索：搜"安静 周杰伦"很可能先给你"安静下来"或者
 * 别人的翻唱。**显示错歌的词比没有词更糟**——用户会以为播放器串台了。所以：
 *
 * 1. **艺人硬错配一律拒绝**（查询里有艺人时，候选必须至少有一个艺人宽松匹配）；
 * 2. **标题不精确时必须有时长佐证**（`|Δ| ≤ 8 秒`）——"安静下来"包含"安静"，
 *    只有时长对得上才可能是同一首；
 * 3. 最后还要过一道**分数门槛**（`MIN_SCORE = 1.5`）：三条信号（准确标题 + 准确艺人 + 时长接近）
 *    至少凑够两条半才算数。
 *
 * 时长只认"两边都 > 30 秒"的样本（30 秒以下多半是试听片段/铃声，那个时长不构成佐证）。
 */

const BRACKETS = /[([【（][^)\]】）]*[)\]】）]/g;
const NOISE = /[\s\-_·・.,，。!！?？'"“”‘’:：/\\|、]/g;

/** 归一化：去掉括号注释（`(Live)`/`【伴奏】`）、大小写、标点与空白。 */
export function normalizeName(value) {
  return String(value ?? "")
    .replace(BRACKETS, "")
    .toLowerCase()
    .replace(NOISE, "");
}

/** 多艺人：`A、B` / `A/B` / `A & B` / `A feat. B` 都算多个（真接口里这几种都出现过）。 */
function splitArtists(value) {
  return String(value ?? "")
    .split(/[、/&,;]| feat\.? | ft\.? /i)
    .map((part) => normalizeName(part))
    .filter(Boolean);
}

/**
 * 给一个候选打分（`0` = 用不了、越大越好）；**硬错配回 `null`**（连比较都不必）。
 *
 * 三条信号与权重（与蓝本逐条相同，不做"看起来更聪明"的改动——这是一份可测的约定）：
 * - 标题精确 `+1.3` / 宽松（互相包含）`+0.9`；
 * - 艺人精确 `+0.9` / 宽松（互相包含）`+0.6`；
 * - 时长差 `≤3s` `+0.6`、`≤8s` `+0.3`、`>25s` `−0.5`。
 */
export function scoreCandidate(candidate, query) {
  const candidateTitle = normalizeName(candidate?.title);
  const wantedTitle = normalizeName(query?.title);
  if (!candidateTitle || !wantedTitle) return null;
  const exactTitle = candidateTitle === wantedTitle;
  const looseTitle = candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle);
  if (!exactTitle && !looseTitle) return null;

  const wantedArtists = splitArtists(query?.artist);
  const candidateArtists = Array.isArray(candidate?.artists)
    ? candidate.artists.map((name) => normalizeName(name)).filter(Boolean)
    : splitArtists(candidate?.artist);
  const artistExact = wantedArtists.length > 0 && candidateArtists.some((name) => wantedArtists.includes(name));
  const artistLoose =
    wantedArtists.length > 0 &&
    candidateArtists.some((name) => wantedArtists.some((wanted) => name.includes(wanted) || wanted.includes(name)));
  if (wantedArtists.length && !artistLoose) return null;

  const wantedDuration = Number(query?.durationSeconds);
  const candidateDuration = Number(candidate?.durationSeconds);
  const bothDurations =
    Number.isFinite(wantedDuration) && wantedDuration > 30 && Number.isFinite(candidateDuration) && candidateDuration > 30;
  const delta = bothDurations ? Math.abs(candidateDuration - wantedDuration) : null;
  const durationClose = delta !== null && delta <= 8;
  // 标题不精确时，时长的佐证是**必需**的（见文件头第 2 条）
  if (!exactTitle && !durationClose) return null;

  let score = exactTitle ? 1.3 : 0.9;
  if (artistExact) score += 0.9;
  else if (artistLoose) score += 0.6;
  if (delta !== null) {
    if (delta <= 3) score += 0.6;
    else if (delta <= 8) score += 0.3;
    else if (delta > 25) score -= 0.5;
  }
  return score;
}

/** 愿意显示的最低分（见文件头：错词比没有词更糟）。 */
export const MIN_SCORE = 1.5;

/** 从候选里挑最好的那个；一个都不过门槛就回 `null`（**不降级取第一个**）。 */
export function pickCandidate(candidates, query) {
  if (!Array.isArray(candidates)) return null;
  let best = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query);
    if (score === null || score < MIN_SCORE) continue;
    if (!best || score > best.score) best = { score, candidate };
  }
  return best ? { ...best.candidate, score: best.score } : null;
}

/** 酷狗搜索 URL（关键字 = 标题 + 艺人；`filter=10` 与蓝本一致）。 */
export function kugouSearchUrl(query) {
  const params = new URLSearchParams({
    keyword: [query?.title, query?.artist].filter(Boolean).join(" ").trim(),
    page: "1",
    pagesize: "20",
    platform: "WebFilter",
    userid: "0",
    clientver: "2000",
    iscorrection: "1",
    privilege_filter: "0",
    filter: "10",
  });
  return `https://songsearch.kugou.com/song_search_v2?${params}`;
}

/** 酷狗搜索响应 → 公共候选形状（`Duration` 是**秒**；哈希是后续两步的钥匙）。 */
export function kugouCandidates(payload) {
  const lists = payload?.data?.lists;
  if (!Array.isArray(lists)) return [];
  return lists
    .map((row) => ({
      title: typeof row?.SongName === "string" ? row.SongName : "",
      artists:
        typeof row?.SingerName === "string"
          ? row.SingerName.split(/[、/&,]/).map((name) => name.trim()).filter(Boolean)
          : [],
      durationSeconds: Number(row?.Duration) || undefined,
      hash: typeof row?.FileHash === "string" ? row.FileHash : "",
    }))
    .filter((candidate) => candidate.title && candidate.hash);
}

/** 按哈希问歌词索引（这一步的候选带 id/accesskey，是下载歌词的钥匙）。 */
export function kugouLyricSearchUrl(hash) {
  const params = new URLSearchParams({
    ver: "1",
    man: "yes",
    client: "mobi",
    keyword: "",
    duration: "",
    hash: String(hash ?? ""),
  });
  return `https://krcs.kugou.com/search?${params}`;
}

/** 歌词索引响应 → 候选（`duration` 是**毫秒**，这里换成秒与别处同一口径）。 */
export function kugouCandidatesById(payload) {
  const candidates = payload?.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((row) => ({
      id: String(row?.id ?? ""),
      accesskey: String(row?.accesskey ?? ""),
      title: typeof row?.song === "string" ? row.song : "",
      artists:
        typeof row?.singer === "string" ? row.singer.split(/[、/&,]/).map((name) => name.trim()).filter(Boolean) : [],
      durationSeconds: Number(row?.duration) ? Number(row.duration) / 1000 : undefined,
    }))
    .filter((candidate) => candidate.id && candidate.accesskey);
}

/** 下载 URL（`fmt=lrc`、`charset=utf8`）。 */
export function kugouDownloadUrl(id, accesskey) {
  const params = new URLSearchParams({
    ver: "1",
    client: "pc",
    id: String(id ?? ""),
    accesskey: String(accesskey ?? ""),
    fmt: "lrc",
    charset: "utf8",
  });
  return `https://lyrics.kugou.com/download?${params}`;
}

/** 下载响应把歌词放在 `content` 里（**base64**；有的版本还会在解出来的文本前再放一个 BOM）。 */
export function decodeKugouLyrics(payload) {
  const content = payload?.content;
  if (typeof content !== "string" || !content) return null;
  try {
    const text = Buffer.from(content, "base64").toString("utf8").replace(/^\uFEFF/, "");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** lrclib 搜索 URL（`q` = 标题 + 艺人）。 */
export function lrclibSearchUrl(query) {
  const params = new URLSearchParams({ q: [query?.title, query?.artist].filter(Boolean).join(" ").trim() });
  return `https://lrclib.net/api/search?${params}`;
}

/**
 * lrclib 响应 → 候选。
 *
 * 两条过滤：**纯音乐（`instrumental`）跳过**（"这首歌没有词"是它的正当结论，不是我们要的歌词），
 * 以及必须真的有 `syncedLyrics`（两者都没有就没什么可显示的）。
 *
 * ## 只有同步歌词（`plainLyrics`）的候选为什么不算（R41a）
 *
 * lrclib 的条目可能只带 `plainLyrics`（没有时间戳的纯文本）。这条路在本项目里**走不通**，
 * 而且是**必然**走不通、不是"偶尔取不到"：落盘与显示的判据都要求"至少一行带时间戳"
 * （`lyrics-store.mjs` 的 `hasTimedLyricLine`，`sanitizeLyricsDoc` 拿它当闸门），纯文本过不了，
 * 于是候选即便选中也只会被判空——白等一次请求，还多一次"看起来有词却什么都没有"的困惑。
 *
 * 所以 `plainLyrics` **在候选这一层就丢掉**：不是"暂时不用"，是**非同步歌词暂不支持**。
 * 将来要做的话，得先在渲染层定"没有时间戳的行怎么显示、进度怎么对齐"——那是另一件事。
 */
export function lrclibCandidates(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((row) => ({
      title: typeof row?.trackName === "string" ? row.trackName : "",
      artists:
        typeof row?.artistName === "string"
          ? row.artistName.split(/[、/&,]/).map((name) => name.trim()).filter(Boolean)
          : [],
      durationSeconds: Number(row?.duration) || undefined,
      syncedLyrics: typeof row?.syncedLyrics === "string" ? row.syncedLyrics : null,
      instrumental: row?.instrumental === true,
    }))
    .filter((candidate) => candidate.title && !candidate.instrumental && candidate.syncedLyrics);
}
