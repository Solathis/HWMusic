/**
 * 音乐会话的加密持久化（`session.enc`）。
 *
 * 分工：**加密/解密不是这个模块的事**——它通过注入的 `secureEncrypt`/`secureDecrypt`
 * （`src/host/host-services.mjs` 的两个封装，最终走宿主的 DPAPI）拿密文，自己只管落盘：
 *
 * 1. 先加密，**再**碰磁盘：加密失败就抛错并保持磁盘原样——绝不"降级"成明文写下去；
 * 2. 写临时文件（创建时即 0600）→ `rename` 原子替换。旧会话要么完整，要么被新会话完整替换，
 *    不会出现半个文件；失败时旧会话原封不动；
 * 3. 0600 是**尽力而为**：Windows 上 `chmod` 常常无效，此时记一条日志并在返回值里如实上报，
 *    不谎报"已收紧权限"，也不因此判定保存失败（用户目录 ACL 才是真正的边界）；
 * 4. 读回来的每一步失败都如实抛结构化错误：绝不把"损坏"当成"没有会话"吞掉。
 *
 * 错误类别（`SessionStoreError.kind`，与 `src/shared/result.ts` 的 `CORE_ERROR_KINDS` 同源）：
 * `invalid_payload`（调用方给的会话不是普通对象）、`secure_store_unavailable`（后端不可用）、
 * `invalid_envelope`（落盘信封坏了/版本不认识）、`invalid_cipher`（密文解不开）、
 * `internal`（读写文件的 IO 失败）。错误里**不带会话内容，也不带密文**。
 */
import * as nodeFs from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { CORE_ERROR_KINDS } from "../shared/result.ts";

/** 会话文件名（数据目录下；数据目录由宿主经 argv 给出，见 `data-dir.mjs`）。 */
export const SESSION_FILE_NAME = "session.enc";
/** 会话文件权限：只给当前用户读写。 */
export const SESSION_FILE_MODE = 0o600;
/** 数据目录权限（`mkdir` 时用；已存在则不改，避免动用户的目录）。 */
export const SESSION_DIR_MODE = 0o700;
/** 信封版本：`{schemaVersion, cipher}`。 */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** 会话持久化的结构化错误：`kind` 是给调用方分支用的，`message` 是给人看的（不含任何会话内容）。 */
export class SessionStoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "SessionStoreError";
    this.kind = kind;
  }
}

/** 抛结构化错误（写成函数是为了让"抛"这件事在调用点显式可见）。 */
function fail(kind, message) {
  throw new SessionStoreError(kind, message);
}

/** 异常 → 一段可读文本：优先用 message（fs 的 message 已含 code），不回显任何业务载荷。 */
function describe(cause) {
  if (cause instanceof Error) {
    if (typeof cause.message === "string" && cause.message !== "") return cause.message;
    if (typeof cause.code === "string" && cause.code !== "") return cause.code;
    return cause.name;
  }
  return String(cause);
}

const defaultLog = (message) => console.error("[hwmusic-core]", message);

/**
 * 造一个会话存储。
 *
 * @param {object} options
 * @param {string} options.dir            数据目录（必须绝对路径）
 * @param {Function} options.secureEncrypt host-services 的 DPAPI 加密：`({plaintext}) -> CoreResult<{cipher}>`
 * @param {Function} options.secureDecrypt host-services 的 DPAPI 解密：`({cipher}) -> CoreResult<{plaintext}>`
 * @param {object} [options.fs]           `node:fs/promises` 的子集（测试注入用）
 * @param {Function} [options.log]        尽力而为的记录的落点（默认 stderr）
 */
export function createSessionStore({
  dir,
  secureEncrypt,
  secureDecrypt,
  fs = nodeFs,
  log = defaultLog,
} = {}) {
  if (typeof dir !== "string" || dir === "" || !isAbsolute(dir)) {
    throw new TypeError("createSessionStore 需要绝对路径 dir（相对路径会随启动目录漂移）");
  }
  if (typeof secureEncrypt !== "function") {
    throw new TypeError("createSessionStore 需要 secureEncrypt（host-services 的 DPAPI 加密封装）");
  }
  if (typeof secureDecrypt !== "function") {
    throw new TypeError("createSessionStore 需要 secureDecrypt（host-services 的 DPAPI 解密封装）");
  }

  const sessionPath = () => join(dir, SESSION_FILE_NAME);

  let tempCounter = 0;
  /** 临时文件必须与目标同目录：跨分区的 rename 不是原子的。 */
  const tempPath = () => {
    tempCounter += 1;
    return join(dirname(sessionPath()), `${SESSION_FILE_NAME}.${process.pid}.${tempCounter}.tmp`);
  };

  /** 会话对象 → JSON 文本（只接受普通对象：音乐会话是凭据对象，不是数组/字符串/空值）。 */
  const serialize = (session) => {
    if (session === null || typeof session !== "object" || Array.isArray(session)) {
      fail(
        CORE_ERROR_KINDS.invalidPayload,
        "会话必须是普通对象（音乐会话是凭据对象，不接受数组/字符串/空值/函数）",
      );
    }
    try {
      return JSON.stringify(session);
    } catch (cause) {
      fail(CORE_ERROR_KINDS.invalidPayload, `会话无法序列化成 JSON（${describe(cause)}）`);
    }
  };

  /** 明文 → 密文；后端不可用/响应缺字段都在这里抛结构化错误（不落盘、不覆盖）。 */
  const encrypt = async (plaintext) => {
    const result = await secureEncrypt({ plaintext });
    if (result === null || typeof result !== "object") {
      fail(CORE_ERROR_KINDS.internal, "加密响应不是帧内结果对象");
    }
    if (result.ok !== true) {
      fail(
        result.error?.kind ?? CORE_ERROR_KINDS.internal,
        result.error?.message ?? "加密失败（详情见日志）",
      );
    }
    const cipher = result.data?.cipher;
    if (typeof cipher !== "string" || cipher === "") {
      fail(CORE_ERROR_KINDS.internal, "加密响应缺少非空 cipher 字段");
    }
    return cipher;
  };

  /** 密文 → 明文；解不开就如实抛，绝不吞成"没有会话"。 */
  const decrypt = async (cipher) => {
    const result = await secureDecrypt({ cipher });
    if (result === null || typeof result !== "object") {
      fail(CORE_ERROR_KINDS.internal, "解密响应不是帧内结果对象");
    }
    if (result.ok !== true) {
      fail(
        result.error?.kind ?? CORE_ERROR_KINDS.internal,
        result.error?.message ?? "解密失败（详情见日志）",
      );
    }
    const plaintext = result.data?.plaintext;
    if (typeof plaintext !== "string") {
      fail(CORE_ERROR_KINDS.internal, "解密响应缺少 plaintext 字段");
    }
    return plaintext;
  };

  /** 落盘信封 → 密文。信封不合法一律 invalid_envelope，且原文件保留、不猜测内容。 */
  const readEnvelope = (raw) => {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      fail(
        CORE_ERROR_KINDS.invalidEnvelope,
        `${SESSION_FILE_NAME} 不是合法 JSON（已损坏）：保留原文件，不猜测内容`,
      );
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      fail(CORE_ERROR_KINDS.invalidEnvelope, `${SESSION_FILE_NAME} 的信封不是 JSON 对象`);
    }
    if (envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
      fail(
        CORE_ERROR_KINDS.invalidEnvelope,
        `${SESSION_FILE_NAME} 的 schemaVersion=${JSON.stringify(envelope.schemaVersion)} 不受支持` +
          `（本版本只认 ${ENVELOPE_SCHEMA_VERSION}）：保留原文件`,
      );
    }
    const cipher = envelope.cipher;
    if (typeof cipher !== "string" || cipher === "") {
      fail(CORE_ERROR_KINDS.invalidEnvelope, `${SESSION_FILE_NAME} 缺少非空 cipher 字段：保留原文件`);
    }
    return cipher;
  };

  /** 0600 尽力而为：收不紧就记一条，返回给调用方如实上报。 */
  const applyBestEffortMode = async (target) => {
    try {
      await fs.chmod(target, SESSION_FILE_MODE);
      return null;
    } catch (cause) {
      const note =
        `无法把 ${basename(target)} 收紧到 0${SESSION_FILE_MODE.toString(8)}（${describe(cause)}）：` +
        "本机文件系统不支持 chmod（Windows 常见），改由用户目录 ACL 兜底";
      log(note);
      return note;
    }
  };

  /** 清掉半成品：尽力而为，清不掉也不掩盖原始错误。 */
  const discardTemp = async (temp) => {
    try {
      await fs.unlink(temp);
    } catch {
      // 故意吞掉：这是清理路径，原始失败原因更重要
    }
  };

  /**
   * 保存音乐会话：加密 → 写临时文件 → rename 原子替换。
   *
   * @returns {Promise<{path: string, modeApplied: boolean, modeNote: string|null}>}
   * @throws {SessionStoreError} 加密失败或落盘失败——**此时旧会话保持原样**
   */
  const saveMusicSession = async (session) => {
    const plaintext = serialize(session);
    const cipher = await encrypt(plaintext);
    const target = sessionPath();
    const temp = tempPath();
    const payload = `${JSON.stringify({ schemaVersion: ENVELOPE_SCHEMA_VERSION, cipher })}\n`;

    try {
      await fs.mkdir(dir, { recursive: true, mode: SESSION_DIR_MODE });
      await fs.writeFile(temp, payload, { mode: SESSION_FILE_MODE });
      await fs.rename(temp, target);
    } catch (cause) {
      await discardTemp(temp);
      fail(
        CORE_ERROR_KINDS.internal,
        `会话落盘失败（${describe(cause)}）：已保留旧会话，未做替换`,
      );
    }

    const modeNote = await applyBestEffortMode(target);
    return { path: target, modeApplied: modeNote === null, modeNote };
  };

  /**
   * 读回音乐会话。
   *
   * @returns {Promise<object|null>} 没有会话文件时是 `null`（这不是错误）
   * @throws {SessionStoreError} 文件读不了 / 信封坏了 / 解不开——都不吞
   */
  const loadMusicSession = async () => {
    let raw;
    try {
      raw = await fs.readFile(sessionPath(), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return null;
      fail(
        CORE_ERROR_KINDS.internal,
        `读取 ${SESSION_FILE_NAME} 失败（${describe(cause)}）：不当作"没有会话"处理`,
      );
    }

    const plaintext = await decrypt(readEnvelope(raw));
    try {
      return JSON.parse(plaintext);
    } catch {
      fail(CORE_ERROR_KINDS.invalidCipher, "解密出来的会话不是合法 JSON（信封被换过或已损坏）");
    }
  };

  /** 删除会话（登出用）。返回是否真的删掉了。 */
  const clearMusicSession = async () => {
    try {
      await fs.unlink(sessionPath());
      return true;
    } catch (cause) {
      if (cause?.code === "ENOENT") return false;
      fail(CORE_ERROR_KINDS.internal, `删除 ${SESSION_FILE_NAME} 失败（${describe(cause)}）`);
    }
  };

  return { sessionPath, saveMusicSession, loadMusicSession, clearMusicSession };
}
