/**
 * 歌词落盘的**纯助手**（R41；移植自参考实现 `.tmp/reference-repo/src/main/lyrics-store.mjs`，
 * 按本项目形态改写——见下面"与蓝本的一处刻意分歧"）。
 *
 * 本模块只做四件**没有副作用、可以单独测**的事：
 * 1. 曲目标识 → 文件名安全键（`lyricsCacheKey`）；
 * 2. 用户选的歌词文件字节 → 文本（`decodeLyricsBuffer`：BOM 探测 + 编码退化链）；
 * 3. "这段文本到底算不算歌词"（`hasTimedLyricLine`）；
 * 4. 从磁盘读回来的文档**再过一遍形状校验**（`sanitizeLyricsDoc`）——盘上文件是**不可信输入**：
 *    它可能被手改过、被半截写入过、是上一个版本写的，甚至是别人放进来的。
 *
 * ## 与蓝本的一处刻意分歧（本项目形态）
 *
 * 蓝本的 `LyricsDoc` 是**解析后的行数组**（`{synced, lines:[{timeMs, text, translation?, segments?}]}`），
 * 因为参考实现把解析放在主进程。本项目的分工不是这样：`playback:lyrics` 的契约是**原始 LRC 文本**
 * （`{text, format, warnings}`），"文本 → 行"由渲染层的官方 `parseLrc` 负责
 * （见 `src/shared/request-channels.ts` 的 `PLAYBACK_LYRICS` 与 `features/lyrics/amll-adapter.ts`）。
 *
 * 所以这里的落盘文档是**文本 + 来源元数据**：
 *
 * ```json
 * {"version":1,"trackId":"…","savedAt":1712345678901,
 *  "doc":{"text":"[00:01.00]…","format":"lrc","source":"kugou",
 *         "matchedTitle":"…","matchedArtist":"…"}}
 * ```
 *
 * 这样缓存/本地导入与在线那条路**交出同一种形状**：渲染层不必知道这个词是从哪来的，
 * 也不必有两套消费路径（一套吃行数组、一套吃文本——那种分裂早晚会让两条路显示不一样的东西）。
 * 代价是"空歌词不落盘"这句话要靠 `hasTimedLyricLine` 判（见该函数的说明），
 * 而不是靠"解析出来的行数为 0"。
 *
 * 本地导入的文档多两个键：`fileName` / `importedAt`（谁导入的、什么时候——用户回头要认得出）。
 */

import { createHash } from "node:crypto";

/** 歌词文本的字节上限（与协议层的 `LYRICS_MAX_BYTES` 同一口径：512 KiB）。 */
export const LYRICS_TEXT_MAX_BYTES = 512 * 1024;

/** 在线结果的保质期（90 天）：歌词几乎不变，但"永远有效"是另一件事（见 `readCached` 的说明）。 */
export const LYRICS_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** 缓存目录的条目上限（没有索引文件，靠 mtime 裁剪，见 `prune`）。 */
export const LYRICS_CACHE_MAX_FILES = 3000;

/** 来源标记的取值集合（写入方用的词汇表；读到认不出的来源按字符串留着，不当成坏文件）。 */
export const LYRICS_SOURCES = Object.freeze(["huawei", "kugou", "lrclib", "local"]);

/** 元数据字符串（来源 / 匹配到的标题/艺人 / 文件名）的存储上限。 */
export const LYRICS_META_TEXT_MAX = 200;

/**
 * 曲目标识 → 文件名安全键。
 *
 * 为什么不能直接拿曲目 id 当文件名：真接口的 id 形态不受我们控制（可能带 `/`、`:`、`..`、
 * 大小写冲突），拼进路径就是一次目录穿越或一次静默覆盖。sha256 前 32 位十六进制既安全又稳定
 * （同一个 id 永远同一个文件），碰撞概率对本用途可以忽略。
 */
export function lyricsCacheKey(trackId) {
  return createHash("sha256").update(String(trackId ?? "")).digest("hex").slice(0, 32);
}

/**
 * 用户选的歌词文件（字节）→ 文本。
 *
 * 为什么需要一条退化链：中文 `.lrc` 在野外**大量是 GBK**（Windows 记事本的历史包袱），
 * 而用户不会知道自己的文件是什么编码——"导入的文件是乱码"看起来就是这个功能坏了。
 * 顺序按"越前面越确定"排：
 *
 * 1. BOM 是**明确声明**（`FF FE` = UTF-16LE、`FE FF` = UTF-16BE、`EF BB BF` = UTF-8）；
 * 2. 没有 BOM 时按 UTF-8 严格解码：**只要不出 U+FFFD 就收**（非法字节序列才会产生它）；
 * 3. 出过 U+FFFD 才退化到 GBK（本项目运行在 Node 上，`TextDecoder('gbk')` 由完整 ICU 提供；
 *    环境里没有就原样交回 UTF-8 的结果——乱码，但**不抛**）。
 *
 * 任何输入都不抛（空/非 Buffer 一律回空串）：解码失败不该让导入流程炸掉。
 */
export function decodeLyricsBuffer(buffer) {
  if (!buffer || typeof buffer.length !== "number" || buffer.length === 0) return "";
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE：先按 16 位交换成小端，再走 Node 的 utf16le。
    //
    // 奇数长度（BOM 之后落单一个字节）怎么办：**丢掉那一个字节**再交换（R41a）。
    // 另一条路是"拒绝解码"（回空串），选丢掉的理由是那正是 UTF-16 解码器自己的行为
    // （末尾不完整的码元无法解码，就当它不存在），而且"少半个字"比"整份导入被判成空文件"
    // 更接近事实——文件多半只是被截断了，前面的词是好的。
    // 顺带一件必须做的事：`swap16()` 遇到奇数长度会**抛**（ERR_INVALID_ARG_VALUE），
    // 所以真正交换的是截出来的偶数长度视图（那个 1 字节的尾巴连交换都参与不了）。
    const body = Buffer.from(bytes.subarray(2));
    const swapped = body.subarray(0, body.length - (body.length % 2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }

  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    return utf8;
  }
}

/**
 * LRC 行首的时间戳 + **同一行里真的有词**。
 *
 * 形状与官方 `parseLrc` 对齐（R41a 逐条比对过，`test/lyrics.test.mjs` 有那张矩阵）：
 * - `[mm:ss]`：分钟 1–3 位、秒 1–2 位（`[00:999]` 官方也不认）；
 * - 小数/百分秒分隔符 `.` 或 `:`，位数**不定**（`.0`、`.00000`、`:500` 都算，`[00:01.]` 不算）；
 * - 括号里不许有空格（`[ 00:01.00]` 不算），多个时间戳可以连写（`[00:01.00][00:05.00]词`）；
 * - **时间戳之后要有非空白的词**：只有时间戳的行（`[00:01.00]`）官方给不出歌词行，这里也不算
 *   ——这一条不是洁癖：判据是"空歌词不落盘"的闸门（见 [`sanitizeLyricsDoc`]），
 *   放一份"只有时间戳"的文档进缓存等于把这首曲子 90 天锁成"没有歌词"。
 */
const LRC_TIMESTAMP = /^[ \t]*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d+)?\][ \t]*)+[^\s[]/m;

/**
 * 这段文本**算不算歌词**（"空行列表不落盘"的判据）。
 *
 * 为什么不用官方 `parseLrc`：它住在 `@applemusic-like-lyrics/lyric` 里，而 sidecar 是个
 * **SEA 单文件二进制**（`scripts/build-sidecar.mjs`：除了 `node:*` 全部打进包里）——
 * 为了一个"有没有歌词行"的布尔值把整个 AMLL 解析器拖进 sidecar，代价与收益不成比例。
 *
 * 这个正则与官方解析器在本项目里的既有结论**等价**（R41a 用真实 `parseLrc` 逐条比对，
 * 矩阵在 `test/lyrics.test.mjs`）：`test/lyrics.test.mjs` 钉住的行为是"没有时间戳的行 →
 * 空结果"，而 LRC 的行要么带时间戳、要么（`[ti:]`/`[ar:]` 这类元数据、纯文本行）不产生歌词行。
 * 所以"至少有一行是『时间戳 + 词』" ⇔ "`parseLrc` 至少给出一行"。它是**廉价的等价判据**，
 * 不是"另一份解析器"：一行都不改文本，只看行首那一小段。
 *
 * 已知的**刻意不等价**只有一族（都是"整份文件只有时间戳、没有词"的垃圾输入）：
 * `[00:01.00][Chorus]` 这种"时间戳后面跟一个不是时间戳的方括号"的行——官方把它当成一行
 * （词就是 `[Chorus]`），这里的判据说没有词。方向是**宁可不落盘**：把这种行当歌词缓存下来，
 * 用户看到的仍是那些方括号标注（不是词），而代价是那份缓存 90 天挡着真正的歌词。
 *
 * 渲染层在导入前仍会用官方解析器再判一次（那是给用户看"这个文件里没有歌词"那句话的地方）。
 */
export function hasTimedLyricLine(text) {
  return typeof text === "string" && LRC_TIMESTAMP.test(text);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 元数据字符串：非空才收，按上限截断（不 trim 内容，只 trim 两端空白）。 */
function metaTextOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, LYRICS_META_TEXT_MAX);
}

/**
 * 落盘文档的形状校验（**写入前与读出后都过这一遍**）。
 *
 * 为什么读回来还要再校验一次：盘上的文件是不可信输入（手改、半截写入、旧版本、别的程序放的）。
 * 一份"看起来像歌词"的坏文档塞进渲染层，轻则歌词窗一片空白，重则解析器当场抛错——而那时
 * 谁都不会想到问题出在一个缓存文件上。
 *
 * 判据（认不出就回 `null`，调用方按"这一次没有命中"处理，继续往下走）：
 * - `text` 必须是非空字符串、≤ 512 KiB、且至少有一行带时间戳的歌词行；
 * - `format` 只留字符串（截断；本项目只有 `lrc` 一种，但不必因此判死一个旧文件）；
 * - `source` 只留字符串（截断）——**认不出的来源不当成坏文件**：来源只是"这句词从哪来"的
 *   说明文字，为了一个不认识的名字把整份歌词丢掉，是把元数据的重要性排在内容之上；
 * - `matchedTitle` / `matchedArtist` / `fileName` 同上（截断）；`importedAt` 只认有限数字。
 */
export function sanitizeLyricsDoc(value) {
  if (!isObject(value)) return null;
  if (typeof value.text !== "string") return null;

  // 只去掉开头可能残留的 BOM 与两端空白：正文一个字符都不动。
  const text = value.text.replace(/^\uFEFF/, "").trim();
  if (text === "") return null;
  if (Buffer.byteLength(text, "utf8") > LYRICS_TEXT_MAX_BYTES) return null;
  if (!hasTimedLyricLine(text)) return null;

  const doc = { text, format: metaTextOf(value.format) ?? "lrc" };
  const source = metaTextOf(value.source);
  doc.source = source ?? "huawei";
  for (const key of ["matchedTitle", "matchedArtist", "fileName"]) {
    const meta = metaTextOf(value[key]);
    if (meta !== null) doc[key] = meta;
  }
  if (typeof value.importedAt === "number" && Number.isFinite(value.importedAt) && value.importedAt > 0) {
    doc.importedAt = value.importedAt;
  }
  return doc;
}

/** 非负有限时间戳（毫秒）；其余一律 null。 */
function timeOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 磁盘文档记录（`{version, trackId, savedAt, doc, fileName?, importedAt?}`）的形状校验
 * ——坏形状一律当"没命中"（调用方继续往下走，而不是把半份东西交出去）。
 *
 * `trackId` 必须与**我们要的那个 id 完全相等**：文件名是 sha256 前 32 位，虽然碰撞概率可忽略，
 * 但"文件里的 id 与文件名对不上"只有一种解释——它不是我们要的那一份（或者被改过）。
 */
export function sanitizeStoredRecord(value, trackId) {
  if (!isObject(value)) return null;
  if (value.trackId !== trackId) return null;
  const savedAt = timeOf(value.savedAt);
  if (savedAt === null) return null;
  const doc = sanitizeLyricsDoc(value.doc);
  if (doc === null) return null;
  return { savedAt, doc, fileName: metaTextOf(value.fileName), importedAt: timeOf(value.importedAt) };
}
