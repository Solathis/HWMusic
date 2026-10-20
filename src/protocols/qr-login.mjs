/**
 * 二维码登录协议与轮询状态机（R16 / B 部分）。
 *
 * 协议形状不是猜的：R16 的 `scripts/probe-qr.mjs` 在公开页面上实探到了完整链路
 * （证据与可复现步骤登记在 `docs/API_CONTRACT.md` §1.7）：
 *
 * ```
 * 建单  POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo?appID=…&loginChannel=…
 *       &reqClientType=…&confirmFlag=1&version=40200&appBrand=HUAWEI
 *       表单 {appID, confirmFlag, version, reqClientType, loginChannel, appBrand}
 *       → {content, qrToken, qrCode, sessionID, qrCodeCreateTime, expiredTime, version}
 *       其中 content 就是要编码进二维码的字符串（指向 /qrcode/login.jsp?qRCode=…）
 * 轮询  POST https://id1.cloud.huawei.com/DimensionalCode/async?version=40200&t=<随机>
 *       表单 {qrToken} → {resultCode, errorDesc}
 *       resultCode: 0=已确认 / 103000202=已扫待确认 / 103000201=过期 / 其余=继续轮询
 * ```
 *
 * 本模块**不写死任何 URL**（与 `src/protocols/auth.mjs` 同一条纪律）：端点由调用方注入，
 * 已确认的值登记在契约文件里、由 `src/main/qr-login.mjs` 从配置表传入。
 *
 * 四条不妥协的规矩：
 * 1. **认不出的 resultCode 一律按"继续轮询"**：陌生码当成功 = 拿一个没确认的会话去换令牌；
 * 2. **状态变化才广播**：2 秒一次 tick、扫码要好几分钟，每次 tick 都广播会把通道刷成噪声；
 * 3. **过期自己重建**（选 sidecar 侧的理由）：二维码过期后渲染层什么都做不了，让它为"再来一张"
 *    再发一次 `auth:qr-start` 只会多一条出错路径；广播通道保持"当前二维码"的唯一事实来源；
 * 4. **错误不静默**：建单失败、连续轮询失败都广播 `failed`（带一句人话），界面才有东西可显示。
 *
 * 全部依赖注入（fetch/计时器/时钟），所以整条状态机在测试里跑得完，不碰网络也不碰真实时间。
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
  /** 二维码过期（随后会自动重建，所以这一档会紧跟一条 pending） */
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
};

/** 服务端没给间隔时的兜底（实探给的正是 2000ms；改这里等于改协议默认值，要同步契约文件）。 */
export const QR_DEFAULT_INTERVAL_MS = 2_000;
/** 连续轮询失败多少次收口（网络抖一下不算登录坏了）。 */
export const QR_DEFAULT_MAX_POLL_FAILURES = 3;

/** 建单表单里那些"从端点模板查询串取"的参数名。 */
export const QR_CREATE_PARAMS = ["appID", "confirmFlag", "version", "reqClientType", "loginChannel", "appBrand"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/**
 * 轮询结果分类。
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

  const expiredAt = Number(payload.expiredTime);
  const expiresInMs =
    Number.isFinite(expiredAt) && expiredAt > 0 ? Math.max(0, expiredAt - now()) : null;

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
 * 二维码会话（建单 + 轮询 + 过期自动重建）。
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
    deadlineMs = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onEvent = () => undefined,
    log = () => undefined,
    random = Math.random,
  } = options;

  let status = QR_LOGIN_STATUS.idle;
  let timer = null;
  let deadlineTimer = null;
  let running = false;
  let failures = 0;
  let current = null;

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
      response = await fetchImpl(createUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: buildQrCreateBody(createUrl, { extra: options.createParams }),
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
    moveTo(QR_LOGIN_STATUS.pending, {
      content: parsed.data.content,
      expiresInMs: parsed.data.expiresInMs,
      version: parsed.data.version,
    });
    return parsed;
  }

  /**
   * 总期限（一次性）：二维码会自动续期（过期就重建），所以"一直没人扫"必须有尽头——
   * 否则后台每 2 秒一次请求会无限跑下去，用户却看不到任何变化。
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

    const url = `${pollUrl}${pollUrl.includes("?") ? "&" : "?"}t=${random()}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
    const classified = classifyQrPoll(payload);
    if (classified.unknownResultCode !== undefined) {
      log(`二维码轮询返回了不认识的 resultCode=${classified.unknownResultCode}（按"继续等待"处理）`);
    }

    if (classified.status === QR_LOGIN_STATUS.confirmed) {
      stop();
      moveTo(QR_LOGIN_STATUS.confirmed, { payload: classified.payload });
      return;
    }
    if (classified.status === QR_LOGIN_STATUS.expired) {
      moveTo(QR_LOGIN_STATUS.expired, {});
      // 过期自己重建：用户那边什么都做不了，让渲染层再发一次请求只会多一条出错路径。
      const renewed = await create();
      if (!renewed.ok) fail(renewed.error.message, renewed.error.kind);
      else schedule();
      return;
    }
    moveTo(classified.status, { payload: classified.status === QR_LOGIN_STATUS.scanned ? classified.payload : undefined });
    schedule();
  }

  function onPollFailure(message, kind) {
    failures += 1;
    if (failures >= maxPollFailures) {
      fail(`${message}（连续 ${failures} 次：请检查网络或代理后重试）`, kind);
      return;
    }
    log(`${message}（第 ${failures} 次，继续重试）`);
    schedule();
  }

  return {
    /** 发起（或重新发起）一次二维码会话：先建单，成功后才开始轮询。 */
    async start() {
      stop();
      failures = 0;
      current = null;
      status = QR_LOGIN_STATUS.idle;
      running = true;
      if (!endpointsReady()) return err("二维码登录端点未配置", QR_ERROR_KINDS.missingEndpoint);

      const created = await create();
      if (!created.ok) return fail(created.error.message, created.error.kind);
      armDeadline();
      schedule();
      return ok({ content: created.data.content, expiresInMs: created.data.expiresInMs });
    },

    /** 停下（门禁关掉、已登录、进程收尾都走这条）：不再轮询、不再广播。 */
    cancel() {
      stop();
      return ok({ cancelled: true });
    },

    isRunning: () => running,
    status: () => status,
    /** 当前二维码的内容与有效期（只读投影；qrToken 不外传）。 */
    current: () =>
      current === null
        ? null
        : { content: current.content, expiresInMs: current.expiresInMs, qrCode: current.qrCode },
  };
}
