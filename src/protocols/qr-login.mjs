/**
 * 二维码登录协议与轮询状态机：建单 + 轮询两跳，端点全部由调用方注入，本层不写死任何 URL。
 * 认不出的 resultCode 继续轮询，但连续若干个就熔断；只在状态变化时广播；过期是终点档，停轮询、等用户手动换码。
 * 到期以服务端为准：TTL 用 expiredTime − qrCodeCreateTime 换算，服务端沉默时由本地一次性定时器 + 3 秒宽限兜底。
 * 建单/轮询的请求形状对齐官方页（去查询串、可带 deviceID/deviceType、页面同款 accept 与 Referer）。
 * 全部依赖注入（fetch/计时器/时钟），状态机在测试里跑得完，不碰网络也不碰真实时间。
 */
import { err, ok } from "../shared/result.ts";

/** 二维码会话的状态词表（广播 `auth:qr` 的 `status` 字段就是它）。 */
export const QR_LOGIN_STATUS = {
  /** 还没开始（渲染层不会看到这一档） */
  idle: "idle",
  /** 已建单，等待扫码 */
  pending: "pending",
  /** 已扫码，等待手机确认 */
  scanned: "scanned",
  /** 已确认（载荷交给兑换链） */
  confirmed: "confirmed",
  /** 二维码过期：终点档，停轮询，等用户手动再 start 换新。 */
  expired: "expired",
  /** 出错（网络/端点/服务器拒绝） */
  failed: "failed",
};

/** 轮询结果码（实探口径；未列出的码按"继续轮询"处理）。 */
export const QR_RESULT_CODES = {
  confirmed: "0",
  scanned: "103000202",
  expired: "103000201",
};

/** 本模块的错误类别。 */
export const QR_ERROR_KINDS = {
  /** 端点未注入（不猜地址） */
  missingEndpoint: "missing_endpoint",
  /** 端点返回非 2xx */
  httpError: "http_error",
  /** 连接层失败（DNS/超时/代理不可达） */
  networkError: "network_error",
  /** 2xx 但响应不是 JSON 或缺必需字段 */
  invalidResponse: "invalid_response",
  /** 建单/轮询收口成的失败（广播出去的那一档） */
  failed: "qr_failed",
  /** 连续若干个认不出的 resultCode（协议变更的熔断出口）。 */
  unknownResultCode: "unknown_result_code",
};

/** 服务端没给间隔时的兜底（实探给的正是 2000ms；改这里等于改协议默认值，要同步契约文件）。 */
export const QR_DEFAULT_INTERVAL_MS = 2_000;
/** 连续轮询失败多少次收口（网络抖一下不算登录坏了）。 */
export const QR_DEFAULT_MAX_POLL_FAILURES = 3;

/**
 * 连续多少个认不出的 resultCode 就收口熔断。
 * 陌生码当成功是最严重的误判，而一直陌生会 2 秒一次打到总期限；5 个是够看出持续异常的观察窗。
 */
export const QR_DEFAULT_MAX_UNKNOWN_CODES = 5;

/**
 * 本地到期兜底的宽限：到期锚过了这么久、服务端还是什么话都没说，就由本层裁定过期。
 * 3 秒只给服务端那条 expired 留余量：兜底已改为一次性定时器，与轮询是否在飞无关。
 */
export const QR_LOCAL_EXPIRY_GRACE_MS = 3_000;

/** 建单表单里那些"从端点模板查询串取"的参数名。 */
export const QR_CREATE_PARAMS = ["appID", "confirmFlag", "version", "reqClientType", "loginChannel", "appBrand"];

/**
 * 建单/轮询的 accept 头照抄官方页那一串，application/json 只是它的子集。
 * 这两个请求由同一个页面、同一套 axios 发出，差一个字符就是可解释的差异。
 */
export const QR_PAGE_ACCEPT = "application/json, text/plain, */*";

/**
 * 建单请求的 URL：丢掉查询串，只留 origin + path，页面自己也是这么做的。
 * 端点常量仍带模板查询串（六个参数的唯一真源），这里丢的只是请求上多挂的那一截。
 *
 * @param {string} createUrl 端点模板（可能带查询串）
 * @returns {string} 真正要打的地址（认不出的串原样返回，不猜一个 URL 出来）
 */
export function qrCreateRequestUrl(createUrl) {
  try {
    const url = new URL(String(createUrl));
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return String(createUrl);
  }
}

/**
 * 服务端 errorDesc 进日志时的长度上限。
 * 它是服务端文案，长度不由我们决定；超出部分对诊断没有增量信息，却能把一行日志撑成几屏。
 */
export const QR_ERROR_DESC_MAX = 80;

/**
 * 服务端 errorDesc → 一行可安全写进日志的文案（null = 没有 / 全是空白）。
 * 换行与连续空白压成一个空格、超长截断；它不是凭据（固定文案），所以与 qrToken 的纪律不同。
 *
 * @param {unknown} value 响应里的 errorDesc
 * @param {number} [max] 长度上限
 * @returns {string|null}
 */
export function sanitizeErrorDesc(value, max = QR_ERROR_DESC_MAX) {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 摘要里要丢掉的参数名（一次性凭据：留着就等于把会话令牌写进日志）。 */
function isSecretParam(name) {
  return /token/i.test(name) || /^qrcode$/i.test(name) || /^code$/i.test(name) || /^session/i.test(name) || /ticket/i.test(name);
}

/**
 * content（二维码里编码的那串 URL）→ 一行非敏感摘要（null = 认不出）。
 * 只记 path 与非敏感查询参数，丢掉 qRCode 与任何 token/session 类参数；认不出时不猜一个形状。
 *
 * @param {unknown} content 建单响应里的 content
 * @returns {string|null} 形如 /qrcode/login.jsp?loginChannel=7000700&reqClientType=700
 */
export function describeQrContent(content) {
  if (typeof content !== "string" || content.trim() === "") return null;
  let url;
  try {
    url = new URL(content);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const safe = [...url.searchParams.entries()].filter(([name]) => !isSecretParam(name));
  const query = safe.map(([name, value]) => `${name}=${value}`).join("&");
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

/** 日志里的钟（本地时刻 `HH:MM:SS`）；只用于人读日志，不参与任何判定。 */
function clockText(ms) {
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/**
 * 轮询结果分类：认不出的码原样带出，熔断计数由调用方做。
 *
 * @param {{resultCode?: unknown}} payload 轮询响应
 * @returns {{status: string, payload?: object, resultCode?: string, unknownResultCode?: string}}
 */
export function classifyQrPoll(payload) {
  const raw = isRecord(payload) ? payload.resultCode : undefined;
  const code = raw === undefined || raw === null ? "" : String(raw);

  if (code === QR_RESULT_CODES.confirmed) return { status: QR_LOGIN_STATUS.confirmed, payload, resultCode: code };
  if (code === QR_RESULT_CODES.scanned) return { status: QR_LOGIN_STATUS.scanned, payload, resultCode: code };
  if (code === QR_RESULT_CODES.expired) return { status: QR_LOGIN_STATUS.expired, payload, resultCode: code };
  // 没有码（响应还没成形）与实探见到的 "103000200"（服务端原话 "Please to login."）都是"继续等"。
  if (code === "" || code === "103000200") return { status: QR_LOGIN_STATUS.pending, payload, resultCode: code };
  // 陌生的码：按"继续等"处理，但**带出来**——协议要是变了，日志与契约文件里得看得见。
  return { status: QR_LOGIN_STATUS.pending, payload, resultCode: code, unknownResultCode: code };
}

/**
 * 建单响应 → 内部形状。
 * 有效期优先用 expiredTime − qrCodeCreateTime（两个服务端值相减，免疫本地钟偏）；缺失才回退本地钟，值矛盾则给 null。
 *
 * @param {unknown} payload 建单响应
 * @param {{now?: () => number}} [options]
 * @returns {{ok: true, data: object} | {ok: false, error: {message: string, kind: string}}}
 */
export function parseQrCreate(payload, options = {}) {
  const now = options.now ?? Date.now;
  if (!isRecord(payload)) {
    return err("二维码建单响应不是 JSON 对象（响应形状变了？）", QR_ERROR_KINDS.invalidResponse);
  }
  const content = payload.content;
  if (typeof content !== "string" || content.trim() === "") {
    return err("二维码建单响应里没有 content：拿不到要编码进二维码的内容", QR_ERROR_KINDS.invalidResponse);
  }
  const qrToken = payload.qrToken;
  if (typeof qrToken !== "string" || qrToken.trim() === "") {
    return err("二维码建单响应里没有 qrToken：无法轮询扫码状态", QR_ERROR_KINDS.invalidResponse);
  }

  const expiresInMs = resolveExpiresInMs(payload, now);

  return ok({
    content,
    /** 会话令牌：**只在本进程内用**，不进广播、不写日志 */
    qrToken,
    qrCode: typeof payload.qrCode === "string" ? payload.qrCode : null,
    sessionId: typeof payload.sessionID === "string" ? payload.sessionID : null,
    version: payload.version === undefined || payload.version === null ? null : String(payload.version),
    expiresInMs,
  });
}

/** 服务端时间戳字段（纪元毫秒）：只认有限且为正的数（`"1792482545561"` 这种字符串也认）。 */
function serverTimestampMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 有效期（毫秒）：三条路都写在这里，不在调用点各算一遍。
 * 两个服务端值都在 → 差值；只有 expiredTime → 回退 expiredTime − now()（有偏差风险）；其余 → null，不猜。
 *
 * @param {object} payload 建单响应
 * @param {() => number} now 本地钟（只有回退路径读它）
 * @returns {number|null} 毫秒；null = 不知道（调用方不许自己编一个）
 */
function resolveExpiresInMs(payload, now) {
  const expiredAt = serverTimestampMs(payload.expiredTime);
  if (expiredAt === null) return null;

  const createdAt = serverTimestampMs(payload.qrCodeCreateTime);
  if (createdAt !== null) {
    // 两个服务端值互相矛盾（到期不晚于建单）：这不是"快到期"，是数据不可信 —— 不猜
    if (expiredAt <= createdAt) return null;
    return expiredAt - createdAt;
  }

  // 回退路径（已知偏差风险，见本函数说明与 docs/API_CONTRACT.md §3）
  return Math.max(0, expiredAt - now());
}

/** 建单表单：参数从端点模板的查询串里取（唯一真源是契约文件登记的那个模板）。 */
export function buildQrCreateBody(createUrl, options = {}) {
  const template = new URL(String(createUrl)).searchParams;
  const form = new URLSearchParams();
  for (const name of QR_CREATE_PARAMS) {
    const value = template.get(name);
    if (value !== null) form.set(name, value);
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined && value !== null && String(value) !== "") form.set(name, String(value));
  }
  return form.toString();
}

/** 轮询表单：只有 qrToken（多带字段就是第二份协议猜测）。 */
export function buildQrPollBody(qrToken) {
  return new URLSearchParams({ qrToken: String(qrToken) }).toString();
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * 二维码会话（建单 + 轮询；过期只报不换）。
 *
 * @param {{
 *   createUrl: string, pollUrl: string, intervalMs?: number, maxPollFailures?: number,
 *   deadlineMs?: number|null,
 *   fetchImpl?: Function, now?: () => number, setTimer?: Function, clearTimer?: Function,
 *   onEvent?: (event: object) => void, log?: (message: string) => void,
 *   random?: () => number,
 * }} options
 * @returns {{start(): Promise<object>, cancel(): void, isRunning(): boolean, status(): string,
 *           current(): object}}
 */
export function createQrSession(options = {}) {
  const {
    createUrl,
    pollUrl,
    intervalMs = QR_DEFAULT_INTERVAL_MS,
    maxPollFailures = QR_DEFAULT_MAX_POLL_FAILURES,
    maxUnknownCodes = QR_DEFAULT_MAX_UNKNOWN_CODES,
    deadlineMs = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onEvent = () => undefined,
    log = () => undefined,
    random = Math.random,
    /**
     * 建单时额外带的表单字段 {deviceID, deviceType}。
     * deviceID 是服务端下发的 sid（要用设备指纹 + CAS 上下文去换），只有端口层拿得到，所以走注入。
     */
    createParams = undefined,
    /**
     * 建单/轮询额外带的请求头（{referer}）。
     * 页面这两个请求的 Referer 就是画着二维码的门户页；端口层知道它，本层不知道，默认不加。
     */
    extraHeaders = undefined,
  } = options;

  let status = QR_LOGIN_STATUS.idle;
  let timer = null;
  let deadlineTimer = null;
  /** 本地到期那张一次性定时器（建单/刷新时算好到点时刻，与轮询是否在飞无关）。 */
  let expiryTimer = null;
  let running = false;
  let failures = 0;
  let current = null;
  /** 连续认不出的 resultCode 个数（熔断用；认出一个码就归零）。 */
  let unknownCodes = 0;
  /** 已轮询多少轮（诊断日志的轮次；每次 start 归零）。 */
  let pollRound = 0;
  /**
   * 本次会话开始的本地时刻（诊断日志的节奏零点；每次 start 重设）。
   * t+…s 与随行的本地时刻一起给，既能数节奏，也能和 sidecar 的其它日志对齐。
   */
  let startedAtLocal = null;
  /**
   * 本地到期锚：建单响应落地那一刻的本地钟 + 服务端 TTL。
   * 取落地而非发出只会晚判（最多晚一个往返），晚判安全；null = 没有本地权威，兜底一次都不许触发。
   */
  let expiresAtLocal = null;

  function emit(event) {
    try {
      onEvent(event);
    } catch (cause) {
      // 广播失败不改写会话状态：状态本身是事实，下一次广播还会带上它
      log(`二维码状态广播失败：${messageOf(cause)}`);
    }
  }

  function stop() {
    running = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (deadlineTimer !== null) {
      clearTimer(deadlineTimer);
      deadlineTimer = null;
    }
    clearLocalExpiry();
  }

  /** 只有状态真的变了才广播（轮询 2 秒一次，重复播报只会把通道刷成噪声）。 */
  function moveTo(next, payload = {}) {
    const changed = status !== next;
    status = next;
    if (changed) emit({ status: next, ...payload });
    return changed;
  }

  function fail(message, kind = QR_ERROR_KINDS.failed) {
    stop();
    moveTo(QR_LOGIN_STATUS.failed, { message, errorKind: kind });
    return err(message, kind);
  }

  /** 端点缺一个就不发请求：猜一个地址打过去只会变成下一次事故的根因。 */
  function endpointsReady() {
    if (isHttpUrl(createUrl) && isHttpUrl(pollUrl)) return true;
    fail(
      "二维码登录端点未配置（建单/轮询地址由探针确认后注入，见 docs/API_CONTRACT.md §1.7）",
      QR_ERROR_KINDS.missingEndpoint,
    );
    return false;
  }

  async function create() {
    let response;
    try {
      response = await fetchImpl(qrCreateRequestUrl(createUrl), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: QR_PAGE_ACCEPT,
          ...(extraHeaders ?? {}),
        },
        body: buildQrCreateBody(createUrl, { extra: createParams }),
      });
    } catch (cause) {
      return err(`二维码建单请求失败：${messageOf(cause)}`, QR_ERROR_KINDS.networkError);
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    if (!response.ok) {
      return err(`二维码建单端点返回 HTTP ${response.status}`, QR_ERROR_KINDS.httpError);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return err("二维码建单响应不是 JSON", QR_ERROR_KINDS.invalidResponse);
    }

    const parsed = parseQrCreate(payload, { now });
    if (!parsed.ok) return parsed;
    current = parsed.data;
    failures = 0;
    unknownCodes = 0;
    pollRound = 0;
    // 兜底锚：服务端 TTL 换成本地到期时刻（建单响应落地起算，宁晚不早）。
    // expiresInMs 为 null 时锚点也是 null：没有本地权威就不许兜底。
    expiresAtLocal = parsed.data.expiresInMs === null ? null : now() + parsed.data.expiresInMs;
    // 取消之后才落地的建单响应：不再广播（这一档属于一次已经作废的会话）
    if (!running) return parsed;
    // 诊断：建单成功就留一行非敏感摘要——先看这张码指向哪、带哪些上下文参数。
    // qRCode 与 token 一律不进（见 describeQrContent）。
    log(
      `二维码建单：content=${describeQrContent(parsed.data.content) ?? "不是 HTTP URL（形状变了？）"}` +
        (parsed.data.expiresInMs === null ? "" : `；有效期=${Math.round(parsed.data.expiresInMs / 1_000)}s`),
    );
    moveTo(QR_LOGIN_STATUS.pending, {
      content: parsed.data.content,
      expiresInMs: parsed.data.expiresInMs,
      version: parsed.data.version,
    });
    return parsed;
  }

  /**
   * 本地到期锚 + 宽限已经过了吗？（服务端什么话都没说时才问这一句）
   * 两道闸门缺一不可：有可信锚点，且 now() ≥ 锚 + 宽限（归零那一刻不判，给在途的 expired 留余量）。
   */
  function localExpiryDue() {
    return expiresAtLocal !== null && now() >= expiresAtLocal + QR_LOCAL_EXPIRY_GRACE_MS;
  }

  /**
   * 本地裁定过期：停轮询 + 只播 expired。
   * 与服务端说过期走同一个终点档，渲染层因此不用区分这两种来源。
   */
  function expireLocally(reason) {
    log(`二维码本地到期兜底：${reason}（到期锚 + ${Math.round(QR_LOCAL_EXPIRY_GRACE_MS / 1000)}s 宽限已过），主动转 expired 并停轮询`);
    stop();
    moveTo(QR_LOGIN_STATUS.expired, {});
  }

  /** 撤掉本地到期那张网（服务端说了话、或整场收尾时都要撤）。 */
  function clearLocalExpiry() {
    if (expiryTimer === null) return;
    clearTimer(expiryTimer);
    expiryTimer = null;
  }

  /**
   * 挂上本地到期那张一次性定时器（到点直接裁决，不再等下一次轮询落地）。
   * 本地只做一次裁决，所以不用每秒看一眼；没有可信 TTL 时一次都不挂——没有本地权威就没有本地裁决。
   */
  function armLocalExpiry() {
    if (expiresAtLocal === null) return;
    const delay = expiresAtLocal + QR_LOCAL_EXPIRY_GRACE_MS - now();
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      if (!running) return;
      // 服务端说过话就让位：`scanned`/`confirmed` 到达时这张网已经撤了，这里再兜一道
      if (status === QR_LOGIN_STATUS.scanned || status === QR_LOGIN_STATUS.confirmed) return;
      if (!localExpiryDue()) return;
      expireLocally("到期定时器到点");
    }, Math.max(0, delay));
  }

  /**
   * 总期限（一次性）：等待期轮询 2 秒一次，没人扫就会一直跑下去。
   * 总期限保证一直没人扫有尽头（过期本身会停轮询，但等待期仍可能无限长）。
   */
  function armDeadline() {
    if (deadlineMs === null || !Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
    deadlineTimer = setTimer(() => {
      deadlineTimer = null;
      fail(`二维码登录超时（${Math.round(deadlineMs / 60_000)} 分钟内没有完成扫码），请重试。`, QR_ERROR_KINDS.failed);
    }, deadlineMs);
  }

  function schedule() {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      void poll();
    }, intervalMs);
  }

  async function poll() {
    if (!running) return;

    pollRound += 1;
    const round = pollRound;
    const url = `${pollUrl}${pollUrl.includes("?") ? "&" : "?"}t=${random()}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: QR_PAGE_ACCEPT,
          ...(extraHeaders ?? {}),
        },
        body: buildQrPollBody(current?.qrToken ?? ""),
      });
    } catch (cause) {
      onPollFailure(`二维码状态轮询请求失败：${messageOf(cause)}`, QR_ERROR_KINDS.networkError);
      return;
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    if (!response.ok) {
      onPollFailure(`二维码状态轮询返回 HTTP ${response.status}`, QR_ERROR_KINDS.httpError);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      onPollFailure("二维码状态轮询响应不是 JSON", QR_ERROR_KINDS.invalidResponse);
      return;
    }

    failures = 0;
    // 取消（或重启）之后才落地的响应：不广播、不排下一次。
    // 没有这道闸，一次在飞的轮询会把旧会话的 expired/scanned/confirmed 播出去，顶掉界面上的新码。
    if (!running) return;
    const classified = classifyQrPoll(payload);
    const code = classified.resultCode ?? "";
    const unknown = classified.unknownResultCode !== undefined;
    if (unknown) unknownCodes += 1;
    else unknownCodes = 0;
    // 诊断：每轮一行，日志要能回答“轮询还在跑吗、服务端说了什么”。
    // 只记轮次/时刻/节奏/状态码/errorDesc；qrToken、二维码内容、cookie 都不进。
    const atLocal = now();
    const elapsedText = startedAtLocal === null ? "" : `，t+${((atLocal - startedAtLocal) / 1_000).toFixed(1)}s`;
    const descText = sanitizeErrorDesc(isRecord(payload) ? payload.errorDesc : undefined);
    log(
      `二维码轮询 #${round}（${clockText(atLocal)}${elapsedText}）：resultCode=${code === "" ? "（响应里没有）" : code}` +
        (descText === null ? "" : `（errorDesc="${descText}"）`) +
        (unknown ? `（认不出的码，连续 ${unknownCodes}/${maxUnknownCodes}）` : ""),
    );

    if (classified.status === QR_LOGIN_STATUS.confirmed) {
      stop();
      moveTo(QR_LOGIN_STATUS.confirmed, { payload: classified.payload });
      return;
    }
    if (classified.status === QR_LOGIN_STATUS.expired) {
      // 过期不再自动换新：只广播这一档并停轮询（连总期限计时器一起清）。
      // 换新由用户点击触发：渲染层再发一次 auth:qr-start，而本端口的 start() 就是 restart。
      stop();
      moveTo(QR_LOGIN_STATUS.expired, {});
      return;
    }
    if (classified.status === QR_LOGIN_STATUS.scanned) {
      // 服务端**在说话**（已扫码、等确认）：本地兜底让位——把一条还活着的会话判死，
      // 代价是用户手机上那句"确认"按下去也没有了着落。
      if (expiryTimer !== null) {
        clearLocalExpiry();
        log("服务端说已扫码：撤掉本地到期那张网（服务端是权威，不抢判）");
      }
      moveTo(QR_LOGIN_STATUS.scanned, { payload: classified.payload });
      schedule();
      return;
    }

    // 到这一档时服务端**什么都没说**（未扫 / 缺省 / 认不出的码）：这是本地兜底唯一该出手的场合
    if (localExpiryDue()) {
      expireLocally(`服务端在第 ${round} 轮仍未给出 expired（resultCode=${code === "" ? "缺省" : code}）`);
      return;
    }
    if (unknown && unknownCodes >= maxUnknownCodes) {
      // 熔断：协议真变了的时候，无限轮询只会让用户永远停在等待态。
      log(`二维码轮询连续 ${unknownCodes} 次返回认不出的 resultCode（最后一次 ${code}）：停止轮询`);
      fail(
        `二维码轮询连续 ${unknownCodes} 次返回认不出的 resultCode（最后一次 ${code}）：协议可能变了，请更新后重试。`,
        QR_ERROR_KINDS.unknownResultCode,
      );
      return;
    }
    moveTo(classified.status, {});
    schedule();
  }

  function onPollFailure(message, kind) {
    // 兜底：网络坏掉时服务端同样什么都没说——本地锚 + 宽限早过了就该判过期。
    // 而不是把用户继续挂在「正在确认过期…」上。
    if (localExpiryDue()) {
      expireLocally(`轮询失败且已过本地到期锚（${message}）`);
      return;
    }
    failures += 1;
    if (failures >= maxPollFailures) {
      fail(`${message}（连续 ${failures} 次：请检查网络或代理后重试）`, kind);
      return;
    }
    log(`${message}（第 ${failures} 次，继续重试）`);
    schedule();
  }

  return {
    /**
     * 发起（或重新发起）一次会话：先建单，成功后才开始轮询。
     * 这是唯一的换码路径：过期后会话停在 expired，用户点刷新 → 渲染层再发 auth:qr-start → 走到这里。
     */
    async start() {
      stop();
      failures = 0;
      current = null;
      // 新会话 = 新的计数与新的到期锚（上一次那张码的这两个事实一律作废）。
      unknownCodes = 0;
      pollRound = 0;
      // 节奏零点（诊断日志的 t+…s 从这里算）。
      startedAtLocal = now();
      expiresAtLocal = null;
      status = QR_LOGIN_STATUS.idle;
      running = true;
      if (!endpointsReady()) return err("二维码登录端点未配置", QR_ERROR_KINDS.missingEndpoint);

      const created = await create();
      if (!created.ok) return fail(created.error.message, created.error.kind);
      armDeadline();
      schedule();
      // 到期那张网在建单落地时就挂上（延迟 = 服务端 TTL + 宽限）。
      // 排在轮询之后挂是有意的：不影响语义，只让“第一个计时器 = 第一次轮询”的顺序保持稳定。
      armLocalExpiry();
      return ok({ content: created.data.content, expiresInMs: created.data.expiresInMs });
    },

    /** 停下（门禁关掉、已登录、进程收尾都走这条）：不再轮询、不再广播。 */
    cancel() {
      stop();
      return ok({ cancelled: true });
    },

    isRunning: () => running,
    status: () => status,
    /**
     * 当前二维码的内容与有效期（只读投影；qrToken 不外传）。
     * 过期之后这里仍是那张作废的码：只给诊断与换码链用，而换码链只在 confirmed 一档才走。
     */
    current: () =>
      current === null
        ? null
        : { content: current.content, expiresInMs: current.expiresInMs, qrCode: current.qrCode },
  };
}
