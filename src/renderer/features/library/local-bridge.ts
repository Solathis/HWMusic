/**
 * 本地曲库的渲染层端口：基址只问宿主一次并缓存，回答形状在这一层统一收口。
 * 基址认不出来时不猜：回 null，调用方说「本地播放不可用」，而不是拼一个注定 404 的地址。
 */
import { coreLocalBaseUrl, coreLocalImport, coreLocalList, coreLocalRemove } from "../../host-api.ts";
import { normalizeLocalAnswer, normalizeLocalBaseUrl } from "./local-library.mjs";

/** 基址的进程内缓存（`undefined` = 还没问过；`null` = 问过但宿主没给可用的值）。 */
let cachedBaseUrl: string | null | undefined;
let inflight: Promise<string | null> | null = null;

/** 取协议基址（只问宿主一次；后续都走缓存）。 */
export async function localBaseUrlCached() {
  if (cachedBaseUrl !== undefined) return cachedBaseUrl;
  if (inflight === null) {
    inflight = coreLocalBaseUrl()
      .then((answer) => normalizeLocalBaseUrl(answer?.baseUrl))
      .catch(() => null)
      .then((base) => {
        cachedBaseUrl = base;
        inflight = null;
        return base;
      });
  }
  return inflight;
}

/** 清掉基址缓存（守卫与测试用：每个用例都从"还没问过"开始）。 */
export function resetLocalBaseUrlCache() {
  cachedBaseUrl = undefined;
  inflight = null;
}

/** 导入回执里的那几个计数：宿主回的是 unknown，形状不对就当 0 / 空表。 */
function importCounters(answer: unknown) {
  const record = typeof answer === "object" && answer !== null ? answer : {};
  const fields = record as { added?: unknown; updated?: unknown; rejected?: unknown };
  return {
    added: Number(fields.added) || 0,
    updated: Number(fields.updated) || 0,
    rejected: Array.isArray(fields.rejected) ? fields.rejected : [],
  };
}

/** 曲库快照 → `{baseUrl, tracks, available}`（基址拿不到时 `tracks` 为空、`available` 为 `false`）。 */
export async function fetchLocalLibrary() {
  const baseUrl = await localBaseUrlCached();
  if (baseUrl === null) return { baseUrl: null, tracks: [], available: false };
  const answer = await coreLocalList();
  return normalizeLocalAnswer(answer, baseUrl);
}

/** 导入：paths 省略 = 开系统对话框；folder: true 是「导入文件夹」。回执里的 tracks 是导入之后的整库快照，页面直接替换列表，不必再请求一次。 */
export async function importLocalTracks(payload = {}) {
  const baseUrl = await localBaseUrlCached();
  if (baseUrl === null) throw { kind: "unavailable", message: "本地曲库不可用（宿主没有给出协议基址）" };
  const answer = await coreLocalImport(payload);
  return { ...normalizeLocalAnswer(answer, baseUrl), ...importCounters(answer) };
}

/** 移除一条（不碰用户的文件）。 */
export async function removeLocalTrack(id: string) {
  const baseUrl = await localBaseUrlCached();
  if (baseUrl === null) throw { kind: "unavailable", message: "本地曲库不可用（宿主没有给出协议基址）" };
  const answer = await coreLocalRemove(id);
  const removed = (answer as { removed?: unknown } | null)?.removed === true;
  return { removed, ...normalizeLocalAnswer(answer, baseUrl) };
}
