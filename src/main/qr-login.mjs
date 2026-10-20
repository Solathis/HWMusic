/**
 * 二维码登录端口（R16 / B 部分）：把 `src/protocols/qr-login.mjs` 的状态机接到华为的**真实**端点上，
 * 并在用户手机上确认之后把授权码交回登录链路。
 *
 * 端点值全部来自 R16 的实探（`scripts/probe-qr.mjs` 的可复现证据，登记在 docs/API_CONTRACT.md §1.7）：
 *
 * ```
 * ① 建单/轮询（**无状态**：实探证明它们不依赖任何 cookie 会话，只认 qrToken）
 *    POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo?appID=…&version=40200
 *    POST https://id1.cloud.huawei.com/DimensionalCode/async?version=40200&t=<随机>
 * ② 确认之后的换码链（**需要页面会话**：pageToken 由 getPageInfo 下发）
 *    POST https://oauth-login1.cloud.huawei.com/oauth2/ajax/getLoginWay?reflushCode=…
 *         → loginInteractInfo.cas.casLoginRedirectUrl（对 client 101444301 一律是 TICKET/CAS 跳转）
 *    GET  <casLoginRedirectUrl> → 302 → /CAS/portal/loginAuth.html?…
 *    GET  /CAS/mobile/standard/login.html?…（**同一串参数**；二维码配置只在这张移动页上下发）
 *    POST /CAS/IDM_W/ajaxHandler/login/getPageInfo  → localInfo.service / pageToken / pageTokenKey
 *    POST /CAS/IDM_W/ajaxHandler/codeRemoteLogin    → {callbackURL}（回调里带 code，交给 PKCE 兑换）
 * ```
 *
 * 为什么要走"移动页"这一步：桌面门户（`/CAS/portal/loginAuth.html`）对本 client 返回
 * `isQrlogin:false` 且**不下发** `getqrContent`/`asyncURL`（实探记录），二维码配置只在
 * 移动登录页的 `localInfo` 里。这不是绕路，是华为自己页面之间的同一条链。
 *
 * **未实测的一档（如实登记）**：`codeRemoteLogin` 之后的 `callbackURL → code → 令牌兑换`需要
 * 一次**真实扫码 + 手机确认**（用户在场的授权动作），本任务交付到"轮询状态机就绪"为止；
 * 那一步的形状来自页面 bundle 的调用代码，且失败时是结构化错误（不猜、不静默）。
 *
 * R20 增补（手动刷新 = 活动会话期间重启）：
 * - `start()` 天然就是"停旧会话 + 开新会话"（旧会话 `cancel()`，新会话新 qrToken/qrCode）；
 * - 迟到的旧会话事件按**身份**（`session !== mine`）丢弃：旧码那次在飞的轮询落地时，
 *   不许把界面上那张新码顶掉（协议层另有一道 `running` 复检，见 src/protocols/qr-login.mjs）；
 * - 换码链读的是**当前**那张的 `qrCode`（`session.current()`），不是建单时的一份快照——
 *   过期自动换新之后，旧 qrCode 已经作废。
 */
import { LOGIN_TIMEOUT_MS } from "../protocols/login-callback.mjs";
import { QR_LOGIN_STATUS, createQrSession } from "../protocols/qr-login.mjs";
import { err, ok } from "../shared/result.ts";

/**
 * 探针确认的端点与参数（**改这里必须同步 docs/API_CONTRACT.md §1.7 与 test/qr-port.test.mjs**）。
 */
export const HUAWEI_QR_ENDPOINTS = {
  /** 建单端点：查询串就是服务端下发的模板（表单参数从它里面取，不另写一份） */
  create:
    "https://id1.cloud.huawei.com/DimensionalCode/getqrInfo?appID=com.huawei.hwidweb&loginChannel=7000700&reqClientType=700&confirmFlag=1&version=40200&appBrand=HUAWEI",
  /** 轮询端点（调用方再拼 `&t=<随机数>`） */
  poll: "https://id1.cloud.huawei.com/DimensionalCode/async?version=40200",
  /** 服务端给的轮询间隔（实探 2000ms） */
  intervalMs: 2_000,
  /** 授权页 SPA 的登录方式接口（拿 CAS 跳转地址） */
  loginWay: "https://oauth-login1.cloud.huawei.com/oauth2/ajax/getLoginWay",
  /** getLoginWay 的接口版本头（写错会得到 1101/20314） */
  interfaceVersion: "v3",
  /** CAS 门户域（实探：授权页最终把浏览器送到这里） */
  casOrigin: "https://id1.cloud.huawei.com",
  /** 二维码配置所在的移动登录页 */
  mobileLoginPath: "/CAS/mobile/standard/login.html",
  /** 页面配置接口（下发 service / pageToken / getqrContent …） */
  pageInfoPath: "/CAS/IDM_W/ajaxHandler/login/getPageInfo",
  /** 页面版本（实探值；缺省也接受） */
  cVersion: "UP_CAS_6.26.3.100",
  /** 已确认 → 换授权码的接口 */
  confirmPath: "/CAS/IDM_W/ajaxHandler/codeRemoteLogin",
};

/** 本模块的错误类别（渲染层按它决定"能不能重试"）。 */
export const QR_PORT_ERROR_KINDS = {
  networkError: "network_error",
  httpError: "http_error",
  invalidResponse: "invalid_response",
  /** CAS 链路里没有给出二维码所需的页面配置 */
  qrConfigUnavailable: "qr_config_unavailable",
  /** 已确认但换码失败（含跨站/风险控制等业务码） */
  confirmFailed: "qr_confirm_failed",
};

const REQUEST_TIMEOUT_MS = 20_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/** 极简 cookie jar：CAS 门户的 getPageInfo/换码要靠会话 cookie 关联（值不进日志）。 */
function createCookieJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
    size: () => jar.size,
    absorb(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const index = pair.indexOf("=");
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/**
 * 造二维码登录端口。
 *
 * @param {{
 *   endpoints?: typeof HUAWEI_QR_ENDPOINTS,
 *   fetchImpl?: Function, log?: (message: string) => void,
 *   createSession?: Function, now?: () => number,
 *   setTimer?: Function, clearTimer?: Function, random?: () => number,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {{start(options: object): Promise<object>, cancel(): void, status(): string}}
 */
export function createHuaweiQrPort(options = {}) {
  const {
    endpoints = HUAWEI_QR_ENDPOINTS,
    fetchImpl = globalThis.fetch,
    log = () => undefined,
    createSession = createQrSession,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    timeoutMs = LOGIN_TIMEOUT_MS,
  } = options;

  const jar = createCookieJar();
  let session = null;

  async function request(url, init = {}) {
    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ...(jar.size() > 0 ? { cookie: jar.header() } : {}),
      ...(init.headers ?? {}),
    };
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      return err(`请求失败：${messageOf(cause)}`, QR_PORT_ERROR_KINDS.networkError);
    }
    jar.absorb(response);
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    return ok({
      status: response.status,
      location: response.headers.get("location"),
      ok: response.ok === true,
      text,
    });
  }

  async function requestJson(url, init) {
    const answer = await request(url, init);
    if (!answer.ok) return answer;
    if (answer.data.ok !== true) {
      return err(`端点返回 HTTP ${answer.data.status}`, QR_PORT_ERROR_KINDS.httpError);
    }
    try {
      return ok(JSON.parse(answer.data.text));
    } catch {
      return err("端点响应不是 JSON", QR_PORT_ERROR_KINDS.invalidResponse);
    }
  }

  /**
   * 走一遍 CAS 链，拿"确认之后换码"所需的页面配置。
   *
   * 只在**已经确认**之后才调用：二维码的显示与轮询完全不依赖它（实探证明那两个端点是无状态的），
   * 所以链路的任何失败都发生在"用户已经扫码"之后，代价最小。
   */
  async function resolveCasContext(authorizeUrl) {
    const authorize = new URL(String(authorizeUrl));
    const query = authorize.search.slice(1);

    const loginWay = await requestJson(`${endpoints.loginWay}?reflushCode=${random()}&display=page`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        fromLoginAuth: "false",
        interfaceVersion: endpoints.interfaceVersion,
        origin: authorize.origin,
        referer: authorize.href,
      },
      body: query,
    });
    if (!loginWay.ok) return loginWay;

    const casUrl = loginWay.data?.loginInteractInfo?.cas?.casLoginRedirectUrl;
    if (typeof casUrl !== "string" || casUrl === "") {
      return err(
        "登录方式接口没有给出 CAS 跳转地址（响应形状变了？见 docs/API_CONTRACT.md §1.7）",
        QR_PORT_ERROR_KINDS.invalidResponse,
      );
    }

    const casEntry = await request(casUrl);
    if (!casEntry.ok) return casEntry;
    const portalUrl = casEntry.data.location ? new URL(casEntry.data.location, casUrl) : new URL(casUrl);
    if (portalUrl.origin !== endpoints.casOrigin) {
      return err(
        `CAS 跳转落到了白名单外的域（${portalUrl.origin}）：导航白名单要同步增补`,
        QR_PORT_ERROR_KINDS.qrConfigUnavailable,
      );
    }

    // 同一串参数换到移动登录页：二维码配置（getqrContent/asyncURL）只在那一张页面上
    const mobileUrl = `${endpoints.casOrigin}${endpoints.mobileLoginPath}${portalUrl.search}`;
    const mobilePage = await request(mobileUrl);
    if (!mobilePage.ok) return mobilePage;

    const form = new URLSearchParams();
    for (const [name, value] of new URL(mobileUrl).searchParams) form.set(name, value);
    form.set("pageName", "login");
    form.set("urlParam", new URL(mobileUrl).search.slice(1));
    form.set("languageCode", form.get("lang") ?? "zh-cn");

    const pageInfo = await requestJson(
      `${endpoints.casOrigin}${endpoints.pageInfoPath}?reflushCode=${random()}&cVersion=${endpoints.cVersion}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: endpoints.casOrigin,
          referer: mobileUrl,
        },
        body: form.toString(),
      },
    );
    if (!pageInfo.ok) return pageInfo;

    const localInfo = pageInfo.data?.localInfo;
    const service = isRecord(localInfo) ? localInfo.service : undefined;
    if (typeof service !== "string" || service === "") {
      return err(
        "窗口配置里没有 service（换授权码要用它），二维码登录无法收尾",
        QR_PORT_ERROR_KINDS.qrConfigUnavailable,
      );
    }
    return ok({
      service,
      loginUrl: typeof localInfo.loginUrl === "string" ? localInfo.loginUrl : "",
      reqClientType: localInfo.reqClientType === undefined ? "" : String(localInfo.reqClientType),
      loginChannel: localInfo.loginChannel === undefined ? "" : String(localInfo.loginChannel),
      lang: typeof localInfo.lang === "string" ? localInfo.lang : "zh-cn",
      pageToken: typeof pageInfo.data.pageToken === "string" ? pageInfo.data.pageToken : "",
      pageTokenKey: typeof pageInfo.data.pageTokenKey === "string" ? pageInfo.data.pageTokenKey : "",
    });
  }

  /** 已确认 → 用 CAS 门户接口换回带 code 的回调 URL。 */
  async function exchangeForCallback(authorizeUrl, payload, session) {
    const context = await resolveCasContext(authorizeUrl);
    if (!context.ok) return context;
    const chain = context.data;

    const body = new URLSearchParams({
      pageToken: chain.pageToken,
      pageTokenKey: chain.pageTokenKey,
      loginUrl: chain.loginUrl,
      reqClientType: chain.reqClientType,
      service: chain.service,
      loginChannel: chain.loginChannel,
      lang: chain.lang,
      appID: new URL(endpoints.create).searchParams.get("appID") ?? "",
      // **当前**那张码的 qrCode：过期自动换新之后，最早建单那一张已经作废，
      // 拿它的 qrCode 去换码只会白跑一趟（R20 修：原来读的是 start() 时的一份快照）
      qrCode: session?.current()?.qrCode ?? "",
    });
    // 确认载荷里的字段原样带上（页面自己也是这么传的：userID/siteID/accountType/code/userAccount/opType）
    for (const name of ["userID", "siteID", "accountType", "code", "userAccount", "opType"]) {
      const value = isRecord(payload) ? payload[name] : undefined;
      if (value !== undefined && value !== null && String(value) !== "") body.set(name, String(value));
    }

    const answer = await requestJson(
      `${endpoints.casOrigin}${endpoints.confirmPath}?reflushCode=${random()}&cVersion=${endpoints.cVersion}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: endpoints.casOrigin,
          referer: `${endpoints.casOrigin}${endpoints.mobileLoginPath}`,
        },
        body: body.toString(),
      },
    );
    if (!answer.ok) return answer;

    const callbackUrl = answer.data?.callbackURL;
    if (typeof callbackUrl !== "string" || callbackUrl === "") {
      const code = answer.data?.errorCode ?? answer.data?.error ?? "未知";
      return err(
        `扫码已确认，但换取授权码失败（errorCode=${String(code).slice(0, 32)}）`,
        QR_PORT_ERROR_KINDS.confirmFailed,
      );
    }
    return ok({ callbackUrl });
  }

  return {
    /**
     * 发起一次二维码会话（**重新发起 = 停旧会话 + 开新会话**）。
     *
     * 手动刷新（用户点二维码容器，R20）走的就是"再调一次 start"：新码一到，旧码作废。
     * 旧会话当时可能正有一次轮询在飞，所以**每一条出向通路都按身份比对**
     * （`session !== mine` 就丢弃）——包括那个"确认之后再换码"的异步尾巴：
     * 它落地时如果会话已经换了一轮，那次换码的结果不属于现在这条路。
     *
     * @param {{authorizeUrl: string, onEvent: (event: object) => void,
     *          onConfirmed: (result: {callbackUrl: string}) => void}} params
     */
    async start({ authorizeUrl, onEvent, onConfirmed }) {
      session?.cancel();
      /** 这一轮会话的身份（迟到的事件/换码结果按它丢弃）。 */
      let mine = null;
      const emit = (event) => {
        if (session !== mine) {
          log("二维码事件到达时那次会话已作废：不广播（迟到的旧码不属于现在这一张）");
          return;
        }
        onEvent(event);
      };
      mine = createSession({
        createUrl: endpoints.create,
        pollUrl: endpoints.poll,
        intervalMs: endpoints.intervalMs,
        deadlineMs: timeoutMs,
        fetchImpl,
        now,
        setTimer,
        clearTimer,
        random,
        log,
        onEvent: (event) => {
          emit(event);
          if (event.status !== QR_LOGIN_STATUS.confirmed) return;
          // 确认之后的换码链是"用户已经动过手"的时刻才走：失败也只是这一次的失败
          void (async () => {
            const exchanged = await exchangeForCallback(authorizeUrl, event.payload, mine);
            // 换码期间用户又刷了一次：这一次的结果作废（不广播失败、也不交回调）
            if (session !== mine) {
              log("换码结果到达时会话已作废：丢弃（用户已经换了一张新码）");
              return;
            }
            if (!exchanged.ok) {
              log(`二维码换码失败：${exchanged.error.message}`);
              emit({
                status: QR_LOGIN_STATUS.failed,
                message: exchanged.error.message,
                errorKind: exchanged.error.kind,
              });
              return;
            }
            onConfirmed({ callbackUrl: exchanged.data.callbackUrl });
          })();
        },
      });
      session = mine;

      const started = await session.start();
      if (!started.ok) return started;
      return started;
    },

    cancel() {
      session?.cancel();
      return ok({ cancelled: true });
    },

    status: () => session?.status() ?? QR_LOGIN_STATUS.idle,
  };
}
