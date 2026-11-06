/**
 * `settings.json`：设置真源；播放队列单独落在 `queue.json`（读/清洗/归一/落盘）。
 *
 * 磁盘形状是固定契约（Rust `webview_proxy.rs` 读同一份），三条不猜的规矩：
 * 形状不认识就当没配；凭据原样保留且绝不进日志；认不出的文件不覆盖（写时报结构化错误并保留原文件）。
 */
import * as nodeFs from "node:fs/promises";
import { isIPv6 } from "node:net";
import { basename, isAbsolute, join } from "node:path";

import { DEFAULT_PLAYBACK_QUALITY, PLAYBACK_QUALITIES, isPlaybackQuality } from "../shared/playback-quality.mjs";
import { proxyModeAndScope } from "../shared/proxy-mode.mjs";
import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 设置文件名（Rust `webview_proxy.rs` 的同名字面量，两侧由测试互钉）。 */
export const SETTINGS_FILE_NAME = "settings.json";
/** 播放队列文件名：队列更新不应重写 Rust 读取的设置文件。 */
export const QUEUE_FILE_NAME = "queue.json";
/** 设置文档中队列字段的键名（与渲染层各自定义，靠测试互钉）。 */
export const QUEUE_DATA_KEY = "queue";
/** schema 版本：只认这一个（Rust 侧同名字面量）。 */
export const SETTINGS_SCHEMA_VERSION = 1;
/** 文件权限：只给当前用户读写（文件里有代理密码）。 */
export const SETTINGS_FILE_MODE = 0o600;
/** 数据目录权限（`mkdir` 时用；已存在则不改）。 */
export const SETTINGS_DIR_MODE = 0o700;
/** 关窗行为枚举；第一个是默认值。 */
export const CLOSE_BEHAVIORS = ["tray", "quit"];
export const DEFAULT_CLOSE_BEHAVIOR = CLOSE_BEHAVIORS[0];
/** 下架曲目清单的上限（只用于"变灰"，多了就是坏数据：真下架也不会一次两千首）。 */
export const OFFLINE_TRACKS_LIMIT = 2000;
/** 代理默认值：跟随系统代理、只用于检查更新；`enabled` 由方式派生（mode === "custom"），照写给旧版读。 */
export const DEFAULT_PROXY = Object.freeze({
  mode: "system",
  scope: "update",
  enabled: false,
  host: "",
  port: null,
  username: "",
  password: "",
  bypass: [],
});

/** 设置读写的结构化错误：`kind` 给调用方分支（与 `src/shared/result.ts` 同源）。 */
export class SettingsStoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "SettingsStoreError";
    this.kind = kind;
  }
}

function fail(kind, message) {
  throw new SettingsStoreError(kind, message);
}

/** 异常 → 一段可读文本（fs 的 message 已含错误码），不回显任何业务载荷。 */
function describe(cause) {
  if (cause instanceof Error) {
    if (typeof cause.message === "string" && cause.message !== "") return cause.message;
    if (typeof cause.code === "string" && cause.code !== "") return cause.code;
    return cause.name;
  }
  return String(cause);
}

const defaultLog = (message) => console.error("[hwmusic-core]", message);

/** 普通对象判定：数组/空值/字符串都不是设置文档。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const HOST_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * host 清洗：只接受主机名/裸 IPv4/带方括号的 IPv6，拒绝协议前缀、路径、凭据、空白与非 ASCII；
 * 方括号那段还要求结构上是 IPv6。与 Rust `clean_host` 逐条对齐，不确定就返回 `null`（= 没填）。
 */
export function cleanHost(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (SCHEME_PREFIX.test(trimmed)) return null;
  if (/[/?#@]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith("[")) {
    if (!BRACKETED_IPV6.test(trimmed)) return null;
    // 字符集合法 ≠ 结构合法：`[1.2.3.4]`、`[::::]` 能过正则却拼不出可解析的代理 URL，结构闸门用标准库 isIPv6。
    return isIPv6(trimmed.slice(1, -1)) ? trimmed : null;
  }
  if (trimmed.includes(":")) return null;
  if (!HOST_CHARSET.test(trimmed)) return null;
  if (!/[A-Za-z0-9]/.test(trimmed)) return null;
  return trimmed;
}

/** 端口清洗：数字与数字串都收；0/空/小数/越界一律 `null`（= 没填）。 */
export function cleanPort(raw) {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value >= 1 && value <= 65535 ? value : null;
}

/**
 * 例外列表归一：逗号分隔串或数组 → 去空白、丢空项与非字符串、**大小写不敏感去重**（保留首次写法）。
 * `localhost,127.0.0.1`、`*.corp.example`、`10.0.0.0/8` 这类写法原样保留。
 */
export function normalizeBypass(raw) {
  const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const entry = part.trim();
    if (entry === "") continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** 代理对象归一：方式与作用范围按共享规则补齐，enabled 由方式派生，其余字段各自清洗（坏值 = 没填），未知子字段丢掉。 */
export function normalizeProxy(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const { mode, scope } = proxyModeAndScope(source);
  return {
    mode,
    scope,
    enabled: mode === "custom",
    host: cleanHost(source.host) ?? "",
    port: cleanPort(source.port),
    username: typeof source.username === "string" ? source.username : "",
    password: typeof source.password === "string" ? source.password : "",
    bypass: normalizeBypass(source.bypass),
  };
}

/**
 * 下架曲目清单归一：只留非空字符串、去空白去重、上限 2000（多出来的丢弃）。
 * 这份清单只用来把行变灰 —— 认不出的形状一律当没有，绝不让它影响别的键。
 */
export function normalizeOfflineTracks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= OFFLINE_TRACKS_LIMIT) break;
  }
  return out;
}

/**
 * 设置文档归一。认不出（非对象 / schemaVersion ≠ 1 / data 不是对象）时整份当没配；认得出时未知键原样带过。
 */
export function normalizeSettingsDocument(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const recognized =
    source.schemaVersion === SETTINGS_SCHEMA_VERSION && isPlainObject(source.data);
  const data = recognized ? source.data : {};
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    data: {
      ...data,
      proxy: normalizeProxy(data.proxy),
      closeBehavior: data.closeBehavior === "minimize"
        ? "tray"
        : CLOSE_BEHAVIORS.includes(data.closeBehavior) ? data.closeBehavior : DEFAULT_CLOSE_BEHAVIOR,
      playbackQuality: isPlaybackQuality(data.playbackQuality) ? data.playbackQuality : DEFAULT_PLAYBACK_QUALITY,
      offlineTracks: normalizeOfflineTracks(data.offlineTracks),
    },
  };
}

/**
 * 把 `patch` 合进当前文档（`settings:set` 的语义）：`null` = 该键回默认，未知键原样写入；类型不对则结构化报错。
 */
export function mergeSettings(document, patch) {
  if (!isPlainObject(patch)) {
    fail(CORE_ERROR_KINDS.invalidPayload, "设置 patch 必须是普通对象");
  }
  const data = { ...document.data };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "proxy") {
      if (value === null) {
        data.proxy = { ...DEFAULT_PROXY };
        continue;
      }
      if (!isPlainObject(value)) {
        fail(CORE_ERROR_KINDS.invalidPayload, "proxy 必须是对象（要清空请传 null）");
      }
      data.proxy = normalizeProxy(value);
      continue;
    }
    if (key === "closeBehavior") {
      if (value === null) {
        data.closeBehavior = DEFAULT_CLOSE_BEHAVIOR;
        continue;
      }
      if (!CLOSE_BEHAVIORS.includes(value)) {
        fail(
          CORE_ERROR_KINDS.invalidPayload,
          `closeBehavior 只接受 ${CLOSE_BEHAVIORS.join(" / ")}（收到 ${JSON.stringify(value)}）`,
        );
      }
      data.closeBehavior = value;
      continue;
    }
    if (key === "playbackQuality") {
      if (value === null) {
        data.playbackQuality = DEFAULT_PLAYBACK_QUALITY;
        continue;
      }
      if (!isPlaybackQuality(value)) {
        fail(
          CORE_ERROR_KINDS.invalidPayload,
          `playbackQuality 只接受 ${PLAYBACK_QUALITIES.join(" / ")} 三档（收到 ${JSON.stringify(value)}）`,
        );
      }
      data.playbackQuality = value;
      continue;
    }
    if (key === "offlineTracks") {
      if (value === null) {
        data.offlineTracks = [];
        continue;
      }
      if (!Array.isArray(value)) {
        fail(CORE_ERROR_KINDS.invalidPayload, "offlineTracks 必须是字符串数组（要清空请传 null 或空数组）");
      }
      if (!value.every((entry) => typeof entry === "string")) {
        fail(CORE_ERROR_KINDS.invalidPayload, "offlineTracks 的元素只能是字符串（曲目 id）");
      }
      data.offlineTracks = normalizeOfflineTracks(value);
      continue;
    }
    if (value === null) {
      delete data[key];
      continue;
    }
    data[key] = value;
  }
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, data };
}

/**
 * rename 的可重试错误码：Windows 上目标还有打开的句柄时替换会 `EPERM`/`EACCES`/`EBUSY`。
 * 这种占用常只持续几毫秒，所以有限重试是最小、最可解释的修复。
 */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** 默认重试间隔（毫秒）：1 次 + 3 次重试 = 最多 4 次尝试，最长多等 170ms。 */
export const DEFAULT_RENAME_RETRY_DELAYS_MS = Object.freeze([20, 50, 100]);

/**
 * 设置存储。
 *
 * @param {object} options
 * @param {string|null} options.dir 数据目录（宿主的 `--data-dir`，绝对路径；`null` = 没有数据目录）
 * @param {object} [options.fs] `node:fs/promises` 的子集（测试注入用）
 * @param {Function} [options.log] 日志落点（默认 stderr）
 * @param {number[]} [options.renameRetryDelaysMs] rename 的重试间隔（测试注入 0 = 不等）
 */
export function createSettingsStore({
  dir = null,
  fs = nodeFs,
  log = defaultLog,
  renameRetryDelaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS,
} = {}) {
  const persistent = typeof dir === "string" && dir !== "";
  if (persistent && !isAbsolute(dir)) {
    throw new TypeError("createSettingsStore 的数据目录必须是绝对路径（相对路径会随启动目录漂移）");
  }
  if (!persistent && dir !== null && dir !== undefined) {
    throw new TypeError("createSettingsStore 的 dir 只能是绝对路径或 null");
  }
  if (!persistent) {
    log("没有数据目录：设置只给内存里的默认值，保存会失败（宿主必须传 --data-dir）");
  }

  const settingsPath = () => (persistent ? join(dir, SETTINGS_FILE_NAME) : null);
  const queuePath = () => (persistent ? join(dir, QUEUE_FILE_NAME) : null);
  let tempCounter = 0;
  /** 临时文件必须与目标同目录：跨分区的 rename 不是原子的。 */
  const tempPath = (fileName) => {
    tempCounter += 1;
    return join(dir, `${fileName}.${process.pid}.${tempCounter}.tmp`);
  };

  /**
   * 读 queue.json：坏文件按没有队列处理，不阻断 settings.json。
   * `exists` 区分「还没迁移的旧队列」与「已有坏队列文件」。
   */
  async function loadQueue() {
    if (!persistent) return { exists: false, queue: undefined };

    let text;
    try {
      text = await fs.readFile(queuePath(), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { exists: false, queue: undefined };
      log(`读取 ${QUEUE_FILE_NAME} 失败（${describe(cause)}）：按「没有队列」处理`);
      return { exists: true, queue: undefined };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      log(`${QUEUE_FILE_NAME} 不是合法 JSON：按「没有队列」处理`);
      return { exists: true, queue: undefined };
    }
    if (
      !isPlainObject(parsed) ||
      parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
      !isPlainObject(parsed.queue)
    ) {
      log(`${QUEUE_FILE_NAME} 的形状不认识：按「没有队列」处理`);
      return { exists: true, queue: undefined };
    }
    return { exists: true, queue: parsed.queue };
  }

  /**
   * 读磁盘 + 判定能否写回去。
   *
   * @returns {Promise<{document: object, queueExists: boolean, blocked: {kind: string, message: string}|null}>}
   *   `blocked` 非空 = 原文件不该被覆盖（坏 JSON / 读不了 / schemaVersion 不认识）。
   */
  async function applyQueue(document) {
    const legacyQueue = document.data[QUEUE_DATA_KEY];
    const loaded = await loadQueue();
    if (loaded.exists) {
      if (loaded.queue === undefined) delete document.data[QUEUE_DATA_KEY];
      else document.data[QUEUE_DATA_KEY] = loaded.queue;
    }
    return { document, queueExists: loaded.exists, legacyQueue };
  }

  async function load() {
    if (!persistent) return { document: normalizeSettingsDocument(null), blocked: null, queueExists: false };

    let text;
    try {
      text = await fs.readFile(settingsPath(), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        return { ...(await applyQueue(normalizeSettingsDocument(null))), blocked: null };
      }
      const message = `读取 ${SETTINGS_FILE_NAME} 失败（${describe(cause)}）：本次按「没配」处理，且不覆盖原文件`;
      log(message);
      return { ...(await applyQueue(normalizeSettingsDocument(null))), blocked: { kind: CORE_ERROR_KINDS.internal, message } };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const message = `${SETTINGS_FILE_NAME} 不是合法 JSON：本次按「没配」处理，且不覆盖原文件（请手工修好或删掉）`;
      log(message);
      return {
        ...(await applyQueue(normalizeSettingsDocument(null))),
        blocked: { kind: CORE_ERROR_KINDS.invalidEnvelope, message },
      };
    }

    const recognized =
      isPlainObject(parsed) &&
      parsed.schemaVersion === SETTINGS_SCHEMA_VERSION &&
      isPlainObject(parsed.data);
    if (!recognized) {
      const message =
        `${SETTINGS_FILE_NAME} 的形状不认识（schemaVersion=${JSON.stringify(parsed?.schemaVersion)}，` +
        `本版本只认 ${SETTINGS_SCHEMA_VERSION}）：本次按「没配」处理，且不覆盖原文件`;
      log(message);
      return {
        ...(await applyQueue(normalizeSettingsDocument(parsed))),
        blocked: { kind: CORE_ERROR_KINDS.invalidEnvelope, message },
      };
    }
    return { ...(await applyQueue(normalizeSettingsDocument(parsed))), blocked: null };
  }

  /**
   * rename 替换目标，对 Windows 的瞬时占用重试：只重试 `EPERM`/`EACCES`/`EBUSY`，其余错误一次都不多试。
   * 每次重试之间等 `renameRetryDelaysMs` 里对应的那一档（20/50/100ms 足够）；注入 `[0,0,0]` 的测试不真的等。
   */
  async function renameInto(from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fs.rename(from, to);
      } catch (cause) {
        const delay = renameRetryDelaysMs[attempt];
        if (delay === undefined || !RETRYABLE_RENAME_CODES.has(cause?.code)) throw cause;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** 原子写：临时文件（创建即 0600）→ rename 替换。失败保留原文件。 */
  async function writeFileAtomically(fileName, document) {
    const target = join(dir, fileName);
    const temp = tempPath(fileName);
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await fs.mkdir(dir, { recursive: true, mode: SETTINGS_DIR_MODE });
      await fs.writeFile(temp, payload, { mode: SETTINGS_FILE_MODE });
      await renameInto(temp, target);
    } catch (cause) {
      try {
        await fs.unlink(temp);
      } catch {
        // 清理路径：原始失败原因更重要
      }
      throw cause;
    }
    try {
      await fs.chmod(target, SETTINGS_FILE_MODE);
    } catch (cause) {
      // 尽力而为：Windows 上 chmod 常常无效，真正的边界是用户目录 ACL（与 session.enc 同口径）
      log(
        `无法把 ${basename(target)} 收紧到 0${SETTINGS_FILE_MODE.toString(8)}（${describe(cause)}）：` +
          "文件里有代理密码，改由用户目录 ACL 兜底",
      );
    }
  }

  async function writeDocument(document) {
    try {
      await writeFileAtomically(SETTINGS_FILE_NAME, document);
    } catch (cause) {
      fail(CORE_ERROR_KINDS.internal, `设置落盘失败（${describe(cause)}）：已保留原文件`);
    }
  }

  async function writeQueue(queue) {
    try {
      await writeFileAtomically(QUEUE_FILE_NAME, { schemaVersion: SETTINGS_SCHEMA_VERSION, [QUEUE_DATA_KEY]: queue });
    } catch (cause) {
      fail(CORE_ERROR_KINDS.internal, `queue.json 写入失败（${describe(cause)}）：已保留原文件`);
    }
  }

  async function deleteQueue() {
    try {
      await fs.unlink(queuePath());
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        fail(CORE_ERROR_KINDS.internal, `queue.json 删除失败（${describe(cause)}）：已保留原文件`);
      }
    }
  }

  /**
   * 读写共用的同一条 promise 队列。读也让出事件循环的话，插进来的 `save()` 会带并发读写，
   * 而 Node 的读句柄在 Windows 上会阻止 `MoveFileEx` 替换目标（`rename` 报 `EPERM`）。
   * 队列本身已 `catch` 过（一次失败不该毒化后面所有请求），失败的那一笔由调用方收结构化错误。
   */
  let queueTail = Promise.resolve();
  function enqueue(operation) {
    const accepted = queueTail.then(operation);
    queueTail = accepted.catch(() => {});
    return accepted;
  }

  /**
   * 读设置。读不到、读坏了都回默认文档，并把原因记一条日志——不抛、不砸文件。
   * 本函数是排空屏障：排在已受理的写之后读盘，所以刚受理的写不会被读回旧文档骗过。
   * 屏障只在 `read` 上排队：`save`/`reset` 内部继续直接 `load()`，否则会等自己那条尾链（自等死锁）。
   */
  function read() {
    return enqueue(load).then((loaded) => loaded.document);
  }

  /**
   * 合并保存（`settings:set` 的落点）。
   *
   * @throws {SettingsStoreError} 没有数据目录 / 原文件认不出或读不了 / patch 不合法
   */
  function save(patch) {
    return enqueue(async () => {
      if (!persistent) {
        fail(CORE_ERROR_KINDS.internal, "没有数据目录：设置无法落盘（宿主必须把 --data-dir 交给 sidecar）");
      }
      const { document, queueExists, legacyQueue, blocked } = await load();
      if (blocked !== null) fail(blocked.kind, blocked.message);
      if (!isPlainObject(patch)) {
        fail(CORE_ERROR_KINDS.invalidPayload, "设置 patch 必须是普通对象");
      }

      const hasQueue = Object.prototype.hasOwnProperty.call(patch, QUEUE_DATA_KEY);
      const legacyQueueForMigration = !queueExists ? legacyQueue : undefined;
      const nextPatch = hasQueue ? Object.fromEntries(
        Object.entries(patch).filter(([key]) => key !== QUEUE_DATA_KEY),
      ) : patch;
      const next = mergeSettings(document, nextPatch);
      delete next.data[QUEUE_DATA_KEY];

      if (hasQueue) {
        if (patch[QUEUE_DATA_KEY] === null) await deleteQueue();
        else await writeQueue(patch[QUEUE_DATA_KEY]);
        if (legacyQueue !== undefined) await writeDocument(next);
        else if (Object.keys(nextPatch).length > 0) await writeDocument(next);
      } else if (legacyQueueForMigration !== undefined) {
        try {
          await writeQueue(legacyQueueForMigration);
        } catch (cause) {
          log(`queue.json 写入失败（旧队列仍留在 settings.json）：${describe(cause)}`);
          const preserved = { ...next, data: { ...next.data, [QUEUE_DATA_KEY]: legacyQueueForMigration } };
          await writeDocument(preserved);
          return preserved;
        }
        await writeDocument(next);
      } else if (legacyQueue !== undefined) {
        await writeDocument(next);
      } else {
        await writeDocument(next);
      }

      return {
        ...next,
        data: {
          ...next.data,
          ...(hasQueue && patch[QUEUE_DATA_KEY] !== null ? { [QUEUE_DATA_KEY]: patch[QUEUE_DATA_KEY] } : {}),
          ...(!hasQueue && legacyQueueForMigration !== undefined ? { [QUEUE_DATA_KEY]: legacyQueueForMigration } : {}),
          ...(!hasQueue && queueExists && document.data[QUEUE_DATA_KEY] !== undefined
            ? { [QUEUE_DATA_KEY]: document.data[QUEUE_DATA_KEY] }
            : {}),
        },
      };
    });
  }

  /** 恢复默认：已知键回默认，未知键保留。 */
  async function reset() {
    return save({ proxy: null, closeBehavior: null });
  }

  return { settingsPath, persistent, read, save, reset };
}

/**
 * `settings:get` / `settings:set` 的处理器；答复 `{ok:true, data:{settings}}`，`set` 另带 `restartRequired`。
 * 失败回 `{ok:false, error:{message, kind}}`，message 里不含凭据。
 */
export function createSettingsHandlers({ store } = {}) {
  if (store === undefined || typeof store.read !== "function") {
    throw new TypeError("createSettingsHandlers 需要 createSettingsStore 的返回值");
  }

  return {
    get: async () => ok({ settings: await store.read() }),

    set: async (request) => {
      const plan = planSettingsWrite(request?.payload);
      if (plan.error !== null) return err(plan.error.message, plan.error.kind);
      try {
        const settings = plan.reset ? await store.reset() : await store.save(plan.patch);
        return ok({ settings, restartRequired: plan.touchesProxy });
      } catch (cause) {
        if (cause instanceof SettingsStoreError) return err(cause.message, cause.kind);
        throw cause;
      }
    },
  };
}

/**
 * `settings:set` 载荷 → 写入计划（纯函数）：`{patch:{...}}` 或 `{reset:true}`，两者二选一。
 * 两个都给、都不给、类型不对 → 结构化 `invalid_payload`，不写盘。
 */
export function planSettingsWrite(payload) {
  const invalid = (message) => ({ error: { kind: CORE_ERROR_KINDS.invalidPayload, message }, reset: false, patch: null, touchesProxy: false });

  if (!isPlainObject(payload)) {
    return invalid("settings:set 需要对象载荷：{patch:{...}} 或 {reset:true}");
  }
  const hasReset = payload.reset === true;
  const hasPatch = Object.prototype.hasOwnProperty.call(payload, "patch");
  if (hasReset && hasPatch) return invalid("settings:set 的 reset 与 patch 只能给一个");
  if (hasReset) return { error: null, reset: true, patch: null, touchesProxy: true };
  if (!hasPatch) return invalid("settings:set 需要 patch（合并）或 reset:true（回默认）");
  if (!isPlainObject(payload.patch)) return invalid("settings:set 的 patch 必须是普通对象");

  return {
    error: null,
    reset: false,
    patch: payload.patch,
    touchesProxy: Object.prototype.hasOwnProperty.call(payload.patch, "proxy"),
  };
}
