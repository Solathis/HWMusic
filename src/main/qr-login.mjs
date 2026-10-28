/**
 * 二维码登录端口：把协议层的状态机接到华为真实端点上，用户手机确认之后把授权码交回登录链路。
 * 端点全部来自探针实探（证据登记在 docs/API_CONTRACT.md §1.7）：建单/轮询无状态，确认后的换码链
 * 需要页面会话，二维码配置只由移动登录页下发；实测扫码链全通，最后一跳由宿主的登录 webview 完成。
 * 迟到的旧会话事件按身份丢弃，换码链读当前那张码的 qrCode，轮询每轮一行脱敏诊断日志。
 * 降级是硬约束：上下文任何一步失败只记一行日志，绝不挡界面，拿不到 sid 也不猜一个。
 */
import { LOGIN_TIMEOUT_MS } from "../protocols/login-callback.mjs";
import { deviceFingerprintFields, encodeFingerprint } from "../protocols/device-fingerprint.mjs";
import { QR_LOGIN_STATUS, QR_PAGE_ACCEPT, createQrSession } from "../protocols/qr-login.mjs";
import { err, ok } from "../shared/result.ts";

/**
 * 探针确认的端点与参数（**改这里必须同步 docs/API_CONTRACT.md §1.7/§1.8 与 test/qr-*.test.mjs**）。
 */
export const HUAWEI_QR_ENDPOINTS = {
  /**
   * 建单端点：查询串是服务端下发的模板（六个表单参数从它取），真正发出去的 URL 不带查询串。
   */
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
  /** 二维码配置所在的移动登录页（换码链用它拿 service/pageToken） */
  mobileLoginPath: "/CAS/mobile/standard/login.html",
  /**
   * 画着二维码的那张页：建单/轮询的 Referer，也是会话上下文（cookie + pageToken）的来源。
   */
  portalLoginPath: "/CAS/portal/loginAuth.html",
  /** 页面配置接口（下发 service / pageToken / getqrContent …） */
  pageInfoPath: "/CAS/IDM_W/ajaxHandler/login/getPageInfo",
  /** 页面版本（实探值；缺省也接受） */
  cVersion: "UP_CAS_6.26.3.100",
  /**
   * 设备指纹接口：拿一份指纹 fp 换 {sid}，它就是建单时发出的 deviceID（与同名 cookie/localStorage）。
   */
  deviceFingerPath: "/CAS/IDM_W/ajaxHandler/dev",
  /** 已确认 → 换授权码的接口 */
  confirmPath: "/CAS/IDM_W/ajaxHandler/codeRemoteLogin",
};

/**
 * 二维码链路上所有 HTTP 请求的 UA（协议保真，不是应用 webview 的 UA）。
 * 二维码只由桌面门户页渲染，所以“像页面一样说话”就是像桌面浏览器一样说话。
 */
export const QR_HTTP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

/**
 * 一条 callbackURL 的形状摘要，只为日志存在：先判这一轮回的是收尾页还是一条回调。
 * 只带 scheme + host + path，查询串里的 code/state/ticket 一个字符都不进日志。
 * @param {unknown} value
 * @returns {string}
 */
function describeCallbackUrlShape(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol.replace(/:$/, "")}://${url.host}${url.pathname}`;
  } catch {
    return "认不出的形状（连 URL 都不是）";
  }
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

  /**
   * 本模块所有出向请求的唯一出口（同一口 cookie 罐、同一套协议保真头、同一道超时）。
   * redirect: "manual" 是必须的：CAS 链要的就是那颗 Location，自动跟随会丢掉中间每一跳。
   */
  async function request(url, init = {}) {
    const headers = {
      "user-agent": QR_HTTP_USER_AGENT,
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

  /**
   * 给协议层用的 fetch：建单/轮询也要带 UA 与 cookie，并把响应种下的 cookie 收回来。
   * 不复用 request 只因为协议层要原始 Response（它自己判 ok/status/text）。
   */
  async function protocolFetch(url, init = {}) {
    const headers = {
      "user-agent": QR_HTTP_USER_AGENT,
      ...(jar.size() > 0 ? { cookie: jar.header() } : {}),
      ...(init.headers ?? {}),
    };
    const response = await fetchImpl(url, { ...init, headers });
    jar.absorb(response);
    return response;
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
   * 走到 CAS 门户（两处共用）：建单前要门户页的 cookie 与 pageToken，确认后要换码的 service/pageToken。
   * @param {string} authorizeUrl 授权页地址（决定 CAS 跳转里那一串参数）
   */
  async function walkToCasPortal(authorizeUrl) {
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
        "登录方式接口没有给出 CAS 跳转地址（响应形状变了？见 docs/API_CONTRACT.md §1.8）",
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
    return ok({ casUrl, portalUrl });
  }

  /**
   * 建单之前的会话上下文：cookie 罐 + 门户页地址 + pageToken + 服务端下发的 deviceID。
   * 不抛异常、不挡界面：任何一步失败都返回 {ok:false, reason}，调用方降级成照旧建单。
   * @param {string} authorizeUrl 授权页地址
   */
  async function resolveQrSessionContext(authorizeUrl) {
    try {
      const entry = await walkToCasPortal(authorizeUrl);
      if (!entry.ok) return { ok: false, reason: entry.error.message };
      const { portalUrl } = entry.data;

      // 先真把那张门户页取回来：响应会种下 CAS 会话 cookie（页面的 cookie 就是这么来的）
      const portalPage = await request(portalUrl.href);
      if (!portalPage.ok) return { ok: false, reason: portalPage.error.message };

      const form = new URLSearchParams();
      for (const [name, value] of portalUrl.searchParams) form.set(name, value);
      form.set("languageCode", form.get("lang") ?? "zh-cn");
      form.set("pageName", "login");
      form.set("interfaceName", "login/getPageInfo");
      form.set("supportHarmonyTheme", "false");
      form.set("urlParam", portalUrl.search.slice(1));

      const pageInfo = await requestJson(
        `${endpoints.casOrigin}${endpoints.pageInfoPath}?reflushCode=${random()}&cVersion=${endpoints.cVersion}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: QR_PAGE_ACCEPT,
            origin: endpoints.casOrigin,
            referer: portalUrl.href,
          },
          body: form.toString(),
        },
      );
      if (!pageInfo.ok) return { ok: false, reason: pageInfo.error.message };

      const localInfo = isRecord(pageInfo.data?.localInfo) ? pageInfo.data.localInfo : {};
      const pageToken = typeof pageInfo.data?.pageToken === "string" ? pageInfo.data.pageToken : "";
      const pageTokenKey = typeof pageInfo.data?.pageTokenKey === "string" ? pageInfo.data.pageTokenKey : "";
      const device = await resolveDeviceIdentity({
        portalUrl,
        pageToken,
        pageTokenKey,
        lang: typeof localInfo.lang === "string" ? localInfo.lang : "zh-cn",
      });
      return {
        ok: true,
        data: {
          portalUrl: portalUrl.href,
          pageToken,
          pageTokenKey,
          device: device.ok ? device.data : null,
          deviceReason: device.ok ? null : device.reason,
          cookieCount: jar.size(),
        },
      };
    } catch (cause) {
      return { ok: false, reason: `上下文那一步抛了：${messageOf(cause)}` };
    }
  }

  /**
   * 用一份设备指纹换服务端下发的 sid，它就是页面建单时带的 deviceID。
   * 服务端回空 sid 就是“不认这份指纹”，所以空 sid 一律当失败——绝不自己编一个。
   */
  async function resolveDeviceIdentity({ portalUrl, pageToken, pageTokenKey, lang }) {
    if (pageToken === "" || pageTokenKey === "") {
      return { ok: false, reason: "门户页没给出 pageToken/pageTokenKey（指纹接口要它）" };
    }
    const form = new URLSearchParams();
    // 页面那份公共上下文（探针实测的字段表），只这几个，不多带
    for (const name of ["reqClientType", "loginChannel", "clientID", "lang", "state", "terminalType"]) {
      const value = portalUrl.searchParams.get(name);
      if (value !== null && value !== "") form.set(name, value);
    }
    form.set("languageCode", form.get("lang") ?? lang ?? "zh-cn");
    form.set("pageToken", pageToken);
    form.set("pageTokenKey", pageTokenKey);
    form.set(
      "fp",
      encodeFingerprint(
        deviceFingerprintFields({
          now: now(),
          lang: form.get("lang") ?? "zh-cn",
          platform: process.platform === "win32" ? "Win32" : process.platform,
        }),
      ),
    );

    const answer = await requestJson(
      `${endpoints.casOrigin}${endpoints.deviceFingerPath}?reflushCode=${random()}&cVersion=${endpoints.cVersion}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: QR_PAGE_ACCEPT,
          origin: endpoints.casOrigin,
          referer: portalUrl.href,
        },
        body: form.toString(),
      },
    );
    if (!answer.ok) return { ok: false, reason: answer.error.message };
    const sid = answer.data?.sid;
    if (typeof sid !== "string" || sid.length <= 1) {
      return { ok: false, reason: "服务端没给出 sid（=不认这份指纹）" };
    }
    return ok({ deviceID: sid, deviceType: "7" });
  }

  /**
   * 走一遍 CAS 链，拿“确认之后换码”所需的页面配置；只在确认之后调用，失败代价最小。
   */
  async function resolveCasContext(authorizeUrl) {
    const entry = await walkToCasPortal(authorizeUrl);
    if (!entry.ok) return entry;
    const { portalUrl } = entry.data;

    // 同一串参数换到移动登录页：换码所需的页面配置在那张页上
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

  /** 已确认 → 走 CAS 门户接口换回 callbackURL，原样交给登录链路，本模块不解析它。 */
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
      // 换码带被确认的那张码的 qrCode：读确认会话自己的 current()。
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

    /**
     * 原样交给登录链路：最后一跳由宿主的登录 webview 完成，服务端 fetch 结构性地拿不到 code。
     * 这里不发请求、不判形状——判真伪归 isCallback/parseCallback，开窗归宿主白名单，日志只记形状。
     */
    log(
      `二维码换码：callbackURL 形状=${describeCallbackUrlShape(callbackUrl)} → 原样交给登录链路` +
        "（最后一跳由登录 webview 加载该地址完成：页面 JS 跳 hms://，被宿主导航拦截接住）",
    );
    return ok({ callbackUrl });
  }

  return {
    /**
     * 发起一次二维码会话（重新发起 = 停旧会话 + 开新会话），旧会话的迟到事件按身份 session !== mine 丢弃。
     * @param {{authorizeUrl: string, onEvent: (event: object) => void,
     *          onConfirmed: (result: {callbackUrl: string}) => void}} params
     *        onConfirmed 收到的是 codeRemoteLogin 交回的 callbackURL 原文：本模块不解析它、也不判它的形状。
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

      /**
       * 建单前先取会话上下文（CAS 链 → 门户页 → getPageInfo → 指纹换 sid）：拿到就用，拿不到就降级。
       */
      const context = await resolveQrSessionContext(authorizeUrl);
      if (context.ok) {
        const device = context.data.device;
        log(
          `二维码建单上下文（R31 全保真）：门户页=${new URL(context.data.portalUrl).pathname}；` +
            `cookie=${context.data.cookieCount} 项；` +
            (device === null
              ? `deviceID 降级：${context.data.deviceReason}`
              : `deviceID=服务端 sid（${device.deviceID.length} 位 hex）`),
        );
      } else {
        log(`二维码建单上下文（R31 全保真）降级：${context.reason}；照旧建单（不带 deviceID/cookie）`);
      }

      mine = createSession({
        createUrl: endpoints.create,
        pollUrl: endpoints.poll,
        intervalMs: endpoints.intervalMs,
        deadlineMs: timeoutMs,
        fetchImpl: protocolFetch,
        now,
        setTimer,
        clearTimer,
        random,
        log,
        // 建单表单的额外字段：服务端下发的 deviceID + deviceType=7（页面就是这么带的）
        createParams: context.ok && context.data.device !== null ? context.data.device : undefined,
        // 建单/轮询的 Referer：那张画着二维码的门户页
        extraHeaders: context.ok ? { referer: context.data.portalUrl } : undefined,
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
