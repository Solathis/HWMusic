/**
 * 启动诊断：**登录态持久化为什么不生效**一条日志看明白。
 * 那一行里必须同时有：数据根路径、它是哪来的、根里有没有 `session.enc`、恢复走到哪一档。
 * 三条纪律：只查存在性不读内容；读不到 ≠ 不存在（`ENOENT` 与 `EACCES` 分开）；日志是一行。
 */
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR_ARG, DATA_DIR_ENV } from "./data-dir.mjs";
import { SESSION_FILE_NAME } from "./session-store.mjs";

/** 这一行日志的开头（真机排障时按它 grep）。 */
export const SESSION_DIAG_LABEL = "登录态持久化诊断";

/**
 * 数据目录的三个来源，与 `data-dir.mjs` 的解析逐档对应：`--data-dir` 参数 → 环境旋钮 → 都没有。
 */
export const DATA_DIR_SOURCE = {
  /** 宿主传的 `--data-dir`（正常路径：Rust 侧三级回退做完之后交给 sidecar） */
  argv: "argv",
  /** 开发期兜底旋钮 `HWMUSIC_DATA_DIR`（手跑 sidecar / 控制器隔离根用） */
  env: "env",
  /** 两者都没有（没有数据目录 → 会话无法落盘） */
  none: "none",
};

/** 数据根是哪来的 → 给人看的一小段（日志里要能直接读出"该去哪儿看"）。 */
export function dataDirSourceLabel(source) {
  switch (source) {
    case DATA_DIR_SOURCE.argv:
      return `宿主参数 ${DATA_DIR_ARG}`;
    case DATA_DIR_SOURCE.env:
      return `环境旋钮 ${DATA_DIR_ENV}`;
    default:
      return "默认（宿主未传参数，环境旋钮也没设）";
  }
}

/**
 * 数据目录的来源判定（只看「参数在不在 / 旋钮有没有值」，**不校验合法性**）。
 * 判据极窄、与 `dataDirFromArgv` 同一套常量，逐档对照用例会兜住漂移。
 */
export function dataDirSource(argv = [], { env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes(DATA_DIR_ARG)) return DATA_DIR_SOURCE.argv;
  const fallback = typeof env?.[DATA_DIR_ENV] === "string" ? env[DATA_DIR_ENV].trim() : "";
  return fallback === "" ? DATA_DIR_SOURCE.none : DATA_DIR_SOURCE.env;
}

/** 异常 → 一段可读文本（fs 的 message 已含 code；不回显任何凭据内容——我们本来也没读内容）。 */
function reasonOf(cause) {
  if (cause instanceof Error) {
    if (typeof cause.message === "string" && cause.message !== "") return cause.message;
    if (typeof cause.code === "string" && cause.code !== "") return cause.code;
    return cause.name;
  }
  return String(cause);
}

/**
 * 查 `session.enc` 的存在性（`stat` 可注入）。
 * 三档语义不同：`true` 有会话；`false` 这个根里没有（`ENOENT`）；`null` 不知道（没数据根或 `stat` 失败）。
 */
export async function readSessionFileState(dir, { stat = nodeFs.stat } = {}) {
  if (typeof dir !== "string" || dir.trim() === "") {
    return { exists: null, size: null, mtime: null, error: undefined };
  }
  try {
    const info = await stat(join(dir, SESSION_FILE_NAME));
    const mtimeMs = typeof info?.mtimeMs === "number" ? info.mtimeMs : null;
    return {
      exists: true,
      size: typeof info?.size === "number" ? info.size : null,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      error: undefined,
    };
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      // 没有会话文件是**正常**的一件事（第一次启动就是这样），不该记成错误
      return { exists: false, size: null, mtime: null, error: undefined };
    }
    return { exists: null, size: null, mtime: null, error: reasonOf(cause) };
  }
}

/** `session.enc` 那一格（见 [`readSessionFileState`] 的三档）。 */
function sessionFileSegment(state) {
  if (state === null || state === undefined) return `${SESSION_FILE_NAME}=(未查)`;
  if (state.exists === true) {
    const size = typeof state.size === "number" ? `${state.size} 字节` : "大小未知";
    const mtime = typeof state.mtime === "string" ? `，写于 ${state.mtime}` : "";
    return `${SESSION_FILE_NAME} 存在（${size}${mtime}）`;
  }
  if (state.exists === false) {
    return (
      `${SESSION_FILE_NAME} 不存在（这个数据根里没有可恢复的会话：` +
      "要么从没在这里登录过，要么上次登录用的是**另一个**数据根）"
    );
  }
  return (
    `${SESSION_FILE_NAME} 查不了（${state.error ?? "原因未知"}）` +
    "——读不到 ≠ 没有，这一档不能当成「从没登录过」"
  );
}

/** 恢复档位那一格（`restore` 是 `auth-manager.restore()` 的返回）。 */
function restoreSegment(restore) {
  if (restore === null || restore === undefined) {
    return "恢复档位=未执行（本次启动没有跑 restore）";
  }
  const head = restore.loggedIn === true ? "已登录" : "未登录";
  const verified = restore.verified === true ? "" : "，未验证";
  const reason = typeof restore.reason === "string" && restore.reason !== "" ? restore.reason : "原因未知";
  const kind = typeof restore.error?.kind === "string" ? `${restore.error.kind}: ` : "";
  const detail = typeof restore.error?.message === "string" ? `；${kind}${restore.error.message}` : "";
  return `恢复档位=${head}（${reason}${verified}${detail}）`;
}

/**
 * 那一行启动诊断（**一行**，见文件头第 3 条纪律）。
 *
 * @param {object} facts
 * @param {string|null} facts.dataDir 宿主给的数据目录（`null` = 没有）
 * @param {string} facts.source [`DATA_DIR_SOURCE`] 之一
 * @param {object|null} facts.sessionFile [`readSessionFileState`] 的结果
 * @param {object|null} facts.restore `auth-manager.restore()` 的结果（没跑就是 `null`）
 * @returns {string} 落 stderr 的那一行
 */
export function sessionDiagnosticLine({ dataDir = null, source = DATA_DIR_SOURCE.none, sessionFile = null, restore = null } = {}) {
  const root = typeof dataDir === "string" && dataDir.trim() !== "" ? dataDir : null;
  const segments = [
    root === null
      ? "数据根=(没有)"
      : `数据根=${root}（来源：${dataDirSourceLabel(source)}）`,
    root === null
      ? `${SESSION_FILE_NAME} 无从查起（没有数据根，会话根本落不了盘）`
      : sessionFileSegment(sessionFile),
    restoreSegment(restore),
  ];
  return `${SESSION_DIAG_LABEL}：${segments.join(" ｜ ")}`;
}
