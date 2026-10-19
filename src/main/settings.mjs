/**
 * `settings.json`：设置的单一真源（读/清洗/归一/落盘）。
 *
 * 磁盘形状（简报钉死，Rust `webview_proxy.rs` 读同一份）：
 *
 * ```json
 * { "schemaVersion": 1, "data": { "proxy": { "enabled", "host", "port", "username", "password", "bypass" },
 *                                 "closeBehavior": "tray" | "quit", ... } }
 * ```
 *
 * 三条不猜的规矩：
 * 1. **形状不认识就成了"没配"**：非 JSON、`schemaVersion ≠ 1`、缺 `data`、`proxy` 不是对象、host 可疑、
 *    port 越界 —— 一律当没配（代理直连），而不是"尽力猜一个"。`closeBehavior` 不认识则回默认，
 *    但**从不猜的边界上不静默写回**（见第 3 条）。
 * 2. **凭据原样保留、绝不改写**（不 trim：空格可能是密码的一部分），也**绝不进日志/错误文案**——
 *    `settings.json` 本身含代理密码，所以写盘按 `session.enc` 同口径尽力收到 0600。
 * 3. **认不出的文件不覆盖**：读的时候当没配，写的时候直接报结构化错误并保留原文件。
 *    宁可不写，也不能砸掉新版（或手工编辑）写的文件。
 *
 * `closeBehavior` 本任务**只存不消费**（R11 的托盘读它）；R10 的表单经 `settings:set` 写它。
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
/** 关窗行为枚举（R11 消费）；第一个是默认值。 */
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
 * host 清洗：只接受"主机名/裸 IPv4/带方括号的 IPv6"。
 *
 * 拒绝协议前缀、路径、查询串、片段、userinfo（凭据只走 auth 字段）、多冒号（`host:port` 写法与裸 IPv6
 * 都无法与端口区分）、任何空白、非 ASCII（不做 IDN 猜测）。方括号那段还要**结构上是 IPv6**：
 * 字符集合格但结构不合法的 `[1.2.3.4]` / `[::::]` 同样拒绝（它们拼不出可解析的代理 URL）。
 * **不确定就返回 `null`（= 没填）**。
 * 规则与 Rust `webview_proxy::clean_host` 逐条对齐，由 `test/fixtures/proxy-host-cases.json` 跨语言钉住。
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
    // 字符集合法 ≠ 结构合法：`[1.2.3.4]`、`[::::]` 能过正则，却拼不出可解析的代理 URL ——
    // 放行它们会让 Rust 建窗时 Url::parse 失败（主窗建不起来）。结构闸门用标准库 isIPv6，
    // 与 Rust 侧 std::net::Ipv6Addr 解析对齐，两侧由 test/fixtures/proxy-host-cases.json 钉住。
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
 * 代理对象归一：只认 `enabled === true`，其余字段各自清洗（坏值 = 没填）。
 *
 * `proxy` 里的未知子字段会被丢掉（本层只认 enabled/host/port/username/password/bypass 六个）：
 * 这一层的形状由简报钉死，R10 的表单不会写别的；`data` 层的未知键则原样保留（见下）。
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
 * 设置文档归一。认不出（非对象 / schemaVersion ≠ 1 / data 不是对象）时**整份当没配**：
 * 代理回默认、`closeBehavior` 回默认，绝不从"看不懂的东西"里猜值。
 * 认得出时，`data` 里的未知键原样带过（R10/R11 各自的字段不被吃掉）。
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
      closeBehavior: CLOSE_BEHAVIORS.includes(data.closeBehavior)
        ? data.closeBehavior
        : DEFAULT_CLOSE_BEHAVIOR,
    },
  };
}

/**
 * 把 `patch` 合进当前文档（`settings:set` 的语义）。
 *
 * - 只碰给出的键；`null` = 该键回默认（`proxy: null` 就是"恢复默认代理"）；
 * - 未知键原样写入（前向兼容：将来加字段不必改这里）；
 * - `proxy` 给了非对象非 null → 结构化错误（写路径不替调用方猜）；`closeBehavior` 不在枚举里同理。
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
 * 设置存储。
 *
 * @param {object} options
 * @param {string|null} options.dir 数据目录（宿主的 `--data-dir`，绝对路径；`null` = 没有数据目录）
 * @param {object} [options.fs]     `node:fs/promises` 的子集（测试注入用）
 * @param {Function} [options.log]  日志落点（默认 stderr）
 */
export function createSettingsStore({ dir = null, fs = nodeFs, log = defaultLog } = {}) {
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
   * 读磁盘 + 判定"能不能写回去"。
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

  /** 原子写：临时文件（创建即 0600）→ rename 替换。失败保留原文件。 */
  async function writeDocument(document) {
    const target = settingsPath();
    const temp = tempPath();
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await fs.mkdir(dir, { recursive: true, mode: SETTINGS_DIR_MODE });
      await fs.writeFile(temp, payload, { mode: SETTINGS_FILE_MODE });
      await fs.rename(temp, target);
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
   * 读设置。**读不到、读坏了都回默认文档**（代理当没配），并把原因记一条日志——不抛、不砸文件。
   */
  async function read() {
    return (await load()).document;
  }

  /**
   * 合并保存（`settings:set` 的落点）。
   *
   * @throws {SettingsStoreError} 没有数据目录 / 原文件认不出或读不了 / patch 不合法
   */
  async function save(patch) {
    if (!persistent) {
      fail(CORE_ERROR_KINDS.internal, "没有数据目录：设置无法落盘（宿主必须把 --data-dir 交给 sidecar）");
    }
    const { document, blocked } = await load();
    if (blocked !== null) fail(blocked.kind, blocked.message);
    const next = mergeSettings(document, patch);
    await writeDocument(next);
    return next;
  }

  /** 恢复默认：已知键回默认，未知键保留。 */
  async function reset() {
    return save({ proxy: null, closeBehavior: null });
  }

  return { settingsPath, persistent, read, save, reset };
}

/**
 * `settings:get` / `settings:set` 的处理器（注册进 dispatcher；频道名由调用方从共享常量给）。
 *
 * 答复形状（R10 照这个接）：
 * - `settings:get` → `{ok:true, data:{settings: <归一后的完整文档>}}`；
 * - `settings:set` → `{ok:true, data:{settings: <保存后的文档>, restartRequired: boolean}}`
 *   （`restartRequired`：改动里带了 `proxy` 就要重启 sidecar 才生效，R10 用它写生效说明）；
 * - 失败 → `{ok:false, error:{message, kind}}`，message 里**不含凭据**。
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
 * `settings:set` 载荷 → 写入计划（纯函数）。
 *
 * 载荷形状只有两种，二选一：`{patch:{...}}`（合并）或 `{reset:true}`（已知键回默认）。
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
