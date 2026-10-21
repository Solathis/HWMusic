/**
 * 歌词的**磁盘持久化**（R41；移植自参考实现 `.tmp/reference-repo/src/main/lyrics-cache.ts`）。
 *
 * 两个目录，都挂在**宿主给的数据根**下（`--data-dir`，见 `src/main/data-dir.mjs`）：
 *
 * | 目录 | 内容 | 谁写 | 优先级 |
 * |---|---|---|---|
 * | `lyrics-cache/` | 在线取到的歌词（华为那条链 + 第三方回退） | `getLyrics` 命中即写 | 低于本地导入 |
 * | `lyrics-local/` | 用户**自己导入**的 `.lrc`/`.txt` | `lyrics:import` 频道 | **永远压过任何在线结果** |
 *
 * ## 六条纪律（每条都有理由，不是"照着蓝本抄"）
 *
 * 1. **TTL 90 天**：歌词几乎不变，所以缓存活得比会话长（换账号、重启都不影响）；
 *    但"永远有效"是另一件事——一个曲目 id 将来可能指向别的录音，过期即**当成没命中**
 *    （不删文件：删除是 `prune` 与"清除缓存"的职责，读路径只做判断）。
 * 2. **原子写**（temp + rename）：写一半被杀进程留下半份 JSON，下次读就是"文件在但解析不了"。
 *    rename 在同一个目录内是原子的，所以读到的要么是旧的完整文件、要么是新的完整文件。
 * 3. **单文件上限 512 KiB**：超了就**不写**（不是截断——截断后的歌词会缺行，看起来像"歌词坏了"）。
 * 4. **空歌词不落盘**：`sanitizeLyricsDoc` 里那条"至少一行带时间戳"就是它。
 *    "没歌词"必须能被下一次尝试推翻（第三方回退、用户后来导入），落盘就把这个可能性焊死了。
 * 5. **prune 上限 3000 条**：没有索引文件，靠 mtime 裁最旧的（一个听歌很多年的用户也不会
 *    让这个目录无界增长）。
 * 6. **写缓存失败不打扰用户**：缓存是"下次更快"，不是"这次能不能听"——写失败只留一行日志。
 *    **本地导入相反**：用户按了导入就expect它落盘，失败必须如实报出来（`writeLocal` 会抛）。
 *
 * ## 没有数据目录时（`dir === null`）
 *
 * 与 `session-store` 同一条诚实纪律：**不静默当作"没有缓存"**。`available: false`，
 * 读一律回"没命中"、写一律不落盘，`info()` 明确回报不可用——设置页据此说"缓存不可用
 * （宿主没有传数据目录）"，而不是显示"0 条 / 0 B"那种看起来正常的假数字。
 */

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  LYRICS_CACHE_MAX_FILES,
  LYRICS_CACHE_TTL_MS,
  LYRICS_TEXT_MAX_BYTES,
  lyricsCacheKey,
  sanitizeLyricsDoc,
  sanitizeStoredRecord,
} from "./lyrics-store.mjs";

/** 数据根下的两个目录名（唯一真源；测试与文档都引用它）。 */
export const LYRICS_CACHE_DIR_NAME = "lyrics-cache";
export const LYRICS_LOCAL_DIR_NAME = "lyrics-local";

/** 读文件时的体积闸门：比单文件上限宽松一倍（超出的文件根本不该存在，连读都不读）。 */
const READ_SIZE_GUARD_BYTES = LYRICS_TEXT_MAX_BYTES * 2;

/**
 * 造歌词缓存。
 *
 * @param {object} [options]
 * @param {string|null} [options.dir] 宿主给的数据根（`null` = 没有数据目录，缓存不可用）
 * @param {Function} [options.log] 日志口（**只记结论与数量，不记歌词内容**）
 * @param {Function} [options.now] 注入时钟（TTL 单测用）
 * @param {number} [options.maxFiles] 目录条目上限（默认 `LYRICS_CACHE_MAX_FILES`；单测注入小值）
 */
export function createLyricsCache({
  dir = null,
  log = () => undefined,
  now = () => Date.now(),
  maxFiles = LYRICS_CACHE_MAX_FILES,
} = {}) {
  const available = typeof dir === "string" && dir.trim() !== "";
  const cacheDir = available ? join(dir, LYRICS_CACHE_DIR_NAME) : null;
  const localDir = available ? join(dir, LYRICS_LOCAL_DIR_NAME) : null;
  const fileLimit = Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : LYRICS_CACHE_MAX_FILES;

  /** 读一个 JSON 文件；不存在/坏形状/过大一律回 null（读缓存不是"能不能启动"的事，不抛）。 */
  async function readJsonFile(path) {
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile() || stat.size > READ_SIZE_GUARD_BYTES) return null;
      const parsed = JSON.parse(await fs.readFile(path, "utf8"));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 原子写：先写同目录下的临时文件，再 rename 顶替（见文件头纪律 2）。 */
  async function writeAtomic(path, text) {
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, text, { mode: 0o600 });
      await fs.rename(temporary, path);
    } catch (cause) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  /** 一个目录的占用（只算 `.json`：临时文件与别的杂物不参与统计）。 */
  async function directoryStats(directory) {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      // 目录还不存在 = 0 条 0 字节（不是错误：第一次运行就是这样）
      return { bytes: 0, entries: 0 };
    }
    let bytes = 0;
    let entries = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const stat = await fs.stat(join(directory, name));
        if (!stat.isFile()) continue;
        bytes += stat.size;
        entries += 1;
      } catch {
        // 读目录与 stat 之间文件可能已经消失（prune 或用户在文件管理器里删了）——跳过
      }
    }
    return { bytes, entries };
  }

  /** 两个目录的占用（设置页那张卡要显示的就是它）。 */
  async function info() {
    if (!available) return { available: false, bytes: 0, entries: 0, localBytes: 0, localEntries: 0 };
    const cache = await directoryStats(cacheDir);
    const local = await directoryStats(localDir);
    return { available: true, ...cache, localBytes: local.bytes, localEntries: local.entries };
  }

  /**
   * 读在线缓存（过期/坏形状/对不上 id 一律当"没命中"）。
   *
   * 返回的文档**已经过 `sanitizeStoredRecord`**：调用方拿到的要么是一份可用的歌词，要么是 null。
   */
  async function readCached(trackId) {
    if (!available || typeof trackId !== "string" || trackId === "") return null;
    const stored = sanitizeStoredRecord(await readJsonFile(join(cacheDir, `${lyricsCacheKey(trackId)}.json`)), trackId);
    if (stored === null) return null;
    if (now() - stored.savedAt > LYRICS_CACHE_TTL_MS) return null;
    return stored.doc;
  }

  /** 写在线缓存（空歌词不写、过大不写、失败只留一行日志；见文件头纪律 3/4/6）。 */
  async function writeCached(trackId, doc) {
    if (!available || typeof trackId !== "string" || trackId === "") return { written: false, reason: "unavailable" };
    const clean = sanitizeLyricsDoc(doc);
    if (clean === null) return { written: false, reason: "empty_or_invalid" };
    if (clean.source === "local") return { written: false, reason: "local_never_here" };
    const payload = JSON.stringify({ version: 1, trackId, savedAt: now(), doc: clean });
    if (Buffer.byteLength(payload, "utf8") > LYRICS_TEXT_MAX_BYTES) return { written: false, reason: "too_large" };
    try {
      await writeAtomic(join(cacheDir, `${lyricsCacheKey(trackId)}.json`), payload);
    } catch (cause) {
      log(`歌词缓存写入失败（不影响这次显示）：${cause?.message ?? cause}`);
      return { written: false, reason: "write_failed" };
    }
    await prune().catch(() => undefined);
    return { written: true };
  }

  /**
   * 裁剪缓存目录（条目数超上限时删 mtime 最旧的）。
   *
   * 为什么按 mtime 而不是 savedAt：savedAt 是我们自己写的字段，而 mtime 是**这个文件最后被碰过**
   * 的事实——`prune` 要裁的正是"最久没被写过的那一份"，两者在这里同义，但前者不依赖文件内容可读。
   */
  async function prune() {
    if (!available) return { removed: 0 };
    let names;
    try {
      names = (await fs.readdir(cacheDir)).filter((name) => name.endsWith(".json"));
    } catch {
      return { removed: 0 };
    }
    if (names.length <= fileLimit) return { removed: 0 };
    const stats = [];
    for (const name of names) {
      try {
        stats.push({ name, mtime: (await fs.stat(join(cacheDir, name))).mtimeMs });
      } catch {
        // 消失的文件不用裁
      }
    }
    stats.sort((a, b) => a.mtime - b.mtime);
    const doomed = stats.slice(0, Math.max(1, stats.length - fileLimit));
    for (const entry of doomed) {
      await fs.rm(join(cacheDir, entry.name), { force: true }).catch(() => undefined);
    }
    return { removed: doomed.length };
  }

  /** 读本地导入（**永远压过在线结果**，所以调用方要在最前面问它）。 */
  async function readLocal(trackId) {
    if (!available || typeof trackId !== "string" || trackId === "") return null;
    const stored = sanitizeStoredRecord(await readJsonFile(join(localDir, `${lyricsCacheKey(trackId)}.json`)), trackId);
    if (stored === null) return null;
    return {
      doc: { ...stored.doc, source: "local" },
      fileName: stored.fileName ?? "",
      importedAt: stored.importedAt ?? stored.savedAt,
    };
  }

  /**
   * 写本地导入。
   *
   * 与 `writeCached` 的三处不同，都是刻意的：
   * - **失败抛出去**：用户按了"导入"就 expect 它记住，静默失败 = 下次打开这首歌歌词又没了；
   * - **不设 TTL**：本地导入是用户的意图，不该被时间作废；
   * - **不参与 prune**：目录大小由用户自己决定（他只导自己想要的几首），自动删用户的文件是越界。
   */
  async function writeLocal(trackId, { text, fileName = "", importedAt } = {}) {
    if (!available) {
      const error = new Error("没有数据目录（宿主未传 --data-dir）：本地歌词无法落盘");
      error.kind = "unavailable";
      throw error;
    }
    if (typeof trackId !== "string" || trackId === "") {
      const error = new Error("本地歌词需要非空 trackId");
      error.kind = "invalid_payload";
      throw error;
    }
    const doc = sanitizeLyricsDoc({ text, format: "lrc", source: "local", fileName });
    if (doc === null) {
      const error = new Error("这段文本不是可用的歌词（没有带时间戳的歌词行，或文本为空/过大）");
      error.kind = "invalid_payload";
      throw error;
    }
    const savedAt = now();
    const payload = JSON.stringify({
      version: 1,
      trackId,
      savedAt,
      fileName: String(fileName ?? "").slice(0, 200),
      importedAt: typeof importedAt === "number" && Number.isFinite(importedAt) ? importedAt : savedAt,
      doc,
    });
    await writeAtomic(join(localDir, `${lyricsCacheKey(trackId)}.json`), payload);
    return { written: true, doc };
  }

  /** 删掉某一首的本地导入（返回是否真的删掉了一份）。 */
  async function removeLocal(trackId) {
    if (!available || typeof trackId !== "string" || trackId === "") return false;
    const path = join(localDir, `${lyricsCacheKey(trackId)}.json`);
    try {
      await fs.access(path);
    } catch {
      return false;
    }
    await fs.rm(path, { force: true });
    return true;
  }

  /**
   * 清缓存：删**整个** `lyrics-cache/` 目录；`options.local === true` 时连 `lyrics-local/` 一起删。
   *
   * 为什么是"删目录"而不是"逐个删文件"：目录里可能还有临时残留与将来别的索引文件，
   * "清除缓存"的用户意图是**这块地方回到干净状态**，不是"删掉我认识的那些文件"。
   * 本地导入是**用户的文件**，所以默认不碰（要删必须显式说 `local: true`，界面上也要多问一句）。
   */
  async function clear(options = {}) {
    if (!available) return info();
    await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    if (options.local === true) await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    return info();
  }

  return { available, info, readCached, writeCached, readLocal, writeLocal, removeLocal, clear, prune };
}
