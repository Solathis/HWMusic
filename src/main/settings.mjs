/**
 * `settings.json`：设置的单一真源（读/清洗/归一/落盘）。
 *
 * 磁盘形状由简报钉死（Rust `webview_proxy.rs` 读同一份），三条不猜的规矩：
 * 形状不认识就当没配；凭据原样保留且绝不进日志；认不出的文件不覆盖（写时报结构化错误并保留原文件）。
 */
import * as nodeFs from "node:fs/promises";
import { isIPv6 } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";

import { CORE_ERROR_KINDS, err, ok } from "../shared/result.ts";

/** 设置文件名（Rust `webview_proxy.rs` 的同名字面量，两侧由测试互钉）。 */
export const SETTINGS_FILE_NAME = "settings.json";
/** schema 版本：只认这一个（Rust 侧同名字面量）。 */
export const SETTINGS_SCHEMA_VERSION = 1;
/** 文件权限：只给当前用户读写（文件里有代理密码）。 */
export const SETTINGS_FILE_MODE = 0o600;
/** 数据目录权限（`mkdir` 时用；已存在则不改）。 */
export const SETTINGS_DIR_MODE = 0o700;
/** 关窗行为枚举；第一个是默认值。 */
export const CLOSE_BEHAVIORS = ["tray", "quit"];
export const DEFAULT_CLOSE_BEHAVIOR = CLOSE_BEHAVIORS[0];
/** 代理默认值 = "没配"：`enabled:false`、端口 `null`、例外列表空。 */
export const DEFAULT_PROXY = Object.freeze({
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

/**
 * 代理对象归一：只认 `enabled === true`，其余字段各自清洗（坏值 = 没填）；未知子字段会被丢掉。
 */
export function normalizeProxy(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    host: cleanHost(source.host) ?? "",
    port: cleanPort(source.port),
    username: typeof source.username === "string" ? source.username : "",
    password: typeof source.password === "string" ? source.password : "",
    bypass: normalizeBypass(source.bypass),
  };
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
  let tempCounter = 0;
  /** 临时文件必须与目标同目录：跨分区的 rename 不是原子的。 */
  const tempPath = () => {
    tempCounter += 1;
    return join(dirname(settingsPath()), `${SETTINGS_FILE_NAME}.${process.pid}.${tempCounter}.tmp`);
  };

  /**
   * 读磁盘 + 判定能否写回去。
   *
   * @returns {Promise<{document: object, blocked: {kind: string, message: string}|null}>}
   *   `blocked` 非空 = 原文件不该被覆盖（坏 JSON / 读不了 / schemaVersion 不认识）。
   */
  async function load() {
    if (!persistent) return { document: normalizeSettingsDocument(null), blocked: null };

    let text;
    try {
      text = await fs.readFile(settingsPath(), "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") return { document: normalizeSettingsDocument(null), blocked: null };
      const message = `读取 ${SETTINGS_FILE_NAME} 失败（${describe(cause)}）：本次按「没配」处理，且不覆盖原文件`;
      log(message);
      return { document: normalizeSettingsDocument(null), blocked: { kind: CORE_ERROR_KINDS.internal, message } };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const message = `${SETTINGS_FILE_NAME} 不是合法 JSON：本次按「没配」处理，且不覆盖原文件（请手工修好或删掉）`;
      log(message);
      return {
        document: normalizeSettingsDocument(null),
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
        document: normalizeSettingsDocument(parsed),
        blocked: { kind: CORE_ERROR_KINDS.invalidEnvelope, message },
      };
    }
    return { document: normalizeSettingsDocument(parsed), blocked: null };
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
  async function writeDocument(document) {
    const target = settingsPath();
    const temp = tempPath();
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
      fail(CORE_ERROR_KINDS.internal, `设置落盘失败（${describe(cause)}）：已保留原文件`);
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
      const { document, blocked } = await load();
      if (blocked !== null) fail(blocked.kind, blocked.message);
      const next = mergeSettings(document, patch);
      await writeDocument(next);
      return next;
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
