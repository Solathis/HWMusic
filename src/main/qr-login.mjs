/**
 * 二维码登录端口（R16 / B 部分）：把 `src/protocols/qr-login.mjs` 的状态机接到华为的**真实**端点上，
 * 并在用户手机上确认之后把授权码交回登录链路。
 *
 * 端点值全部来自 R16 的实探（`scripts/probe-qr.mjs` 的可复现证据，登记在 docs/API_CONTRACT.md §1.7）：
 *
 * ```
 * ① 建单/轮询（**无状态**：实探证明它们不依赖任何 cookie 会话，只认 qrToken；
 *    R31 起**照样带上** cookie/UA/Referer 与 `deviceID`——那是"像页面一样说话"，不是"服务端要求"）
 *    POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo（**R31：不带查询串**）
 *    POST https://id1.cloud.huawei.com/DimensionalCode/async?version=40200&t=<随机>
 * ①b 建单**之前**的上下文（R31 增补；失败降级，不挡界面）
 *    GET  https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?…（画着二维码的那张页，也是 Referer 的来源）
 *    POST /CAS/IDM_W/ajaxHandler/login/getPageInfo → localInfo（含 getqrContent）+ pageToken/pageTokenKey
 *    POST /CAS/IDM_W/ajaxHandler/dev → {sid}（拿一份设备指纹换；**deviceID = 这颗 sid**）
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
 * **实测状态（R36 定案）**：扫码链**全通**——用户扫码 + 手机确认之后轮询见到 `0`、
 * `codeRemoteLogin` 跑通并交回 `callbackURL`。最后一跳**由宿主开的登录 webview 完成**
 * （R36；`callbackURL` 在本模块里只是**搬运**，见文件末尾的 R36 段与 `src/main/auth-manager.ts`
 * 的 `finishQrLogin`）：宿主加载它、页面自己的 JS 执行后跳 `hms://`、被导航拦截器接住 →
 * `consumeCallback → exchangeCode → loginex`（同一条兑换链）。
 * 仍然只有真机能验的是**那条 webview 里的收尾页会不会再要求一步确认**（页面自己呈现，我们不猜）。
 *
 * R20 增补（手动刷新 = 活动会话期间重启）：
 * - `start()` 天然就是"停旧会话 + 开新会话"（旧会话 `cancel()`，新会话新 qrToken/qrCode）；
 * - 迟到的旧会话事件按**身份**（`session !== mine`）丢弃：旧码那次在飞的轮询落地时，
 *   不许把界面上那张新码顶掉（协议层另有一道 `running` 复检，见 src/protocols/qr-login.mjs）；
 * - 换码链读的是**当前**那张的 `qrCode`（`session.current()`），不是建单时的一份快照——
 *   过期自动换新之后，旧 qrCode 已经作废。
 *
 * R22 增补（用户真机反馈两项：① 倒计时到 0 后卡在「正在确认过期…」一直不过期；② 过期时间正确性）：
 * 三处修法都落在**协议层**（`src/protocols/qr-login.mjs`），本端口只负责把它们接上真端点：
 * - TTL 由两个服务端值相减（`expiredTime − qrCodeCreateTime`），本地钟偏多少都不会平移倒计时；
 * - 本地到期锚 + 15 秒宽限兜底、连续陌生 `resultCode` 熔断——界面那档「正在确认过期…」必有出口；
 * - 轮询每轮一行脱敏 `resultCode` 诊断日志，落点是本端口注入的 `log`
 *   （sidecar 默认 `console.error` → **stderr**，见 `src/main/auth-manager.ts` 的 `defaultLog`）。
 * 所以这个 `log` 参数不是可选的装饰：真机再报"卡住"时，它是唯一的现场记录。
 *
 * R29 增补（用户真机反馈之 4：扫码之后轮询仍是"未扫"）：诊断结论是"扫码从未关联到我们会话，
 * 而落点在**手机侧**"，因此**本文件的参数与链路一处未改**——为什么不动见
 * `docs/API_CONTRACT.md` §1.8 的 R29 段（建单/轮询与官方页逐参数相同，三处偏差登记在案）。
 * 交付的是**可判性**：协议层现在多记两样东西（建单一行 content 非敏感摘要、轮询行带时刻/节奏/
 * `errorDesc`），本端口只是把 `log` 照旧传下去。下一轮真机扫码时，日志里那句
 * `errorDesc="Please to login."` 就是"手机侧那台设备没有登录华为账号"的原话
 * （**R31 更正**：这是线索不是判据，见契约同段）。
 *
 * R31 增补（用户指令 2026-10-21：界面不变、不用移动端 UA、继续修自己生成的二维码）：
 * R29 登记的三处保真度缺口**在这一轮补齐了**，依据不是推断而是探针实物
 * （`scripts/probe-qr-fidelity.mjs`：headless Chromium 真开官方二维码页，抓下它自己发的请求）：
 *
 * - **建单 URL 去查询串**：协议层 `qrCreateRequestUrl` 只留 origin+path（页面行为）；
 * - **补 `deviceID`/`deviceType`**：真源是 `POST /CAS/IDM_W/ajaxHandler/dev` 下发的 `sid`——
 *   页面拿一份浏览器指纹（`fp`）换它。本端口在建单前把上下文走一遍
 *   （[`resolveQrSessionContext`]：CAS 链 → 门户页 → `getPageInfo` → [`resolveDeviceIdentity`]），
 *   指纹编码逐字节复刻在 `src/protocols/device-fingerprint.mjs`；
 * - **cookie 罐**：建单/轮询走 [`protocolFetch`]（同一个罐 + 页面 UA），所以 CAS 会话那串 cookie、
 *   `dev` 种下的 `hwid_cas_sid`、以及**建单响应自己种下的** `qRCode`/`expiredTime` 都会跟着回来
 *   ——最后这一条是探针实测的页面行为，也是"罐"最硬的理由。
 *
 * **降级是硬约束**：上下文那一步的任何失败都只记一行日志，绝不挡界面（二维码必须能显示出来）——
 * 拿不到就照旧建单（不带 deviceID/cookie），拿不到 sid 就**不猜**一个（自己编的骗不过服务端）。
 * 界面与 UA 一处未动：渲染层零改动、登录 webview 保持宿主默认 UA；这里的 `QR_HTTP_USER_AGENT`
 * 只是**请求头层面的协议保真**。"补上这些到底有没有用"要真手机 + 真账号才能验
 * （`docs/KNOWN_LIMITATIONS.md` B21）。
 *
 * R36 增补（用户真机诊断定案 2026-10-21）：**确认链的最后一跳改走 webview，服务端解析整体退役**。
 *
 * 真机证据把形状钉死了（R35 的诊断日志 + 用户交回的现场）：`loginCallback` 页的查询里
 * **没有 `code`**（带的是 ticket/siteID/flowID 一类的 OAuth 票据参数），那份 200 的 14KB HTML 里
 * **没有 `hms` 字样**（跳转目标是页面自己的 JS 现拼的）。⇒ **服务端 fetch 结构性地拿不到 code**：
 * R33 的"跟随 302"、R34 的三策略（参数直构 / 302 跟随 / 响应体提取）、R35 的脱敏诊断
 * **全都建立在"那一跳能在服务端收场"这个已被证伪的假设上**，所以**整体退役**
 * （`test/qr-port.test.mjs` 有一条源码扫描钉住它们不再出现）。
 *
 * 定案依据是**同一个应用里的对照组**：账号密码网页登录实证走通，走的正是
 * "登录 webview 里加载官方页 → 页面自己的 JS 执行 → 跳 `hms://` → 被导航拦截器接住"。
 * 所以这条链的最后一跳也交给**登录 webview**：本模块把 `callbackURL` **原样**交给登录链路
 * （`onConfirmed`），`src/main/auth-manager.ts` 的 `finishQrLogin` 经宿主要求开一扇登录 webview
 * 加载它（复用既有 `host:open-login` 那条路径），webview 的结论
 * （`LoginConclusion::Callback{url}`）回到**同一条兑换链**上。
 *
 * **本模块的职责边界因此收窄成"搬运"**：
 * - 一个多余请求都不发（不 fetch 那份收尾页）；
 * - 一个形状判断都不做——判真伪是 `isCallback`/`parseCallback` 的唯一职责
 *   （`src/protocols/login-callback.mjs`），能不能开窗是宿主白名单的职责
 *   （Rust `login.rs` 的 `parse_config`：只收 https 且在白名单里的地址）；
 * - 日志只记**形状**（scheme + host + path，标准模板见 [`describeCallbackUrlShape`]），
 *   查询串里的 code/state/ticket 一个字符都不进日志（R35 立的凭据纪律照旧）。
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
   * 建单端点：查询串就是服务端下发的模板（表单参数从它里面取，不另写一份）。
   *
   * R31：真正发出去的 URL **不带查询串**（页面是 `getqrContent.split("?")[0]`）——
   * 转换由协议层的 `qrCreateRequestUrl` 做，这里保留模板是因为六个参数要从它取。
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
   * **画着二维码的那张页**（R31 探针实测：屏幕上那张码是它画的，建单/轮询也是它发的）。
   *
   * 它同时是建单/轮询的 Referer，也是"会话上下文"（cookie + pageToken）的来源。
   */
  portalLoginPath: "/CAS/portal/loginAuth.html",
  /** 页面配置接口（下发 service / pageToken / getqrContent …） */
  pageInfoPath: "/CAS/IDM_W/ajaxHandler/login/getPageInfo",
  /** 页面版本（实探值；缺省也接受） */
  cVersion: "UP_CAS_6.26.3.100",
  /**
   * 设备指纹接口（R31）：拿一份指纹 `fp` 换 `{sid}` —— **deviceID 就是这颗 sid**。
   *
   * 页面把它写进 `localStorage.hwid_cas_sid`（与同名 cookie），建单时作为 `deviceID` 发出去。
   * 编码格式见 `src/protocols/device-fingerprint.mjs`（探针实物逐字节复刻）。
   */
  deviceFingerPath: "/CAS/IDM_W/ajaxHandler/dev",
  /** 已确认 → 换授权码的接口 */
  confirmPath: "/CAS/IDM_W/ajaxHandler/codeRemoteLogin",
};

/**
 * 二维码这条链上所有 HTTP 请求的 UA（R31 明确：这是**协议保真**，不是应用 webview 的 UA）。
 *
 * 为什么是桌面 UA：二维码只由**桌面门户页**渲染（探针实测：手机 UA 下那张页面根本没有二维码，
 * 一个建单请求都不发）。所以"像页面一样说话"= 像桌面浏览器一样说话。
 * 同时这是用户指令的一部分：登录 webview 也**不许**改成移动 UA（界面/页面观感不变）。
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
 * R36：一条 `callbackURL` 的**形状摘要**，只为日志存在。
 *
 * 为什么值得留：真机再出问题时，第一件要判的事是"`codeRemoteLogin` 这一轮回的是收尾页，
 * 还是已经是一条回调"——这一行说清它。而它**只带 scheme + host + path**：
 * 查询串里可能是 `code`/`state`/`ticket` 一类的一次性凭据，一个字符都不进日志
 * （R35 立的凭据纪律，R36 照旧）。认不出（连 URL 都不是）就如实说认不出，不猜一个形状。
 *
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

  /**
   * 本模块所有出向请求的**唯一出口**（同一口 cookie 罐 + 同一套协议保真头 + 同一道超时）。
   *
   * `redirect: "manual"` 是**必须**的：CAS 那条链要的就是那颗 `Location`
   * （`walkToCasPortal`：`/CAS/remoteLogin` 的 302 指向门户页）——让 fetch 自动跟随，
   * 我们只会看到"跟到最后一站的那个响应"，中间每一跳的地址就丢了。
   * （R33/R34 曾借同一颗开关"跟随回调中转页"，那条路线 R36 已整体退役；
   * 这一句留在这里的理由现在是 CAS 链，与回调页无关。）
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
   * 给**协议层**用的 fetch（R31）：建单/轮询也要像页面一样带着 UA 与 cookie，并把响应种的 cookie 收回来。
   *
   * 为什么单独写一个而不是复用 [`request`]：协议层要的是**原始 Response**
   * （它自己判 `ok`/`status`/`text()`），而 `request()` 返回的是本模块包装过的 `{ok, data}`。
   * 两者的差别只在这里，UA/cookie/吸收这三件事是同一套。
   *
   * 探针实测这一条不是"锦上添花"：页面的轮询请求带着**建单响应自己种下的** cookie
   * （`qRCode`/`expiredTime`/`qrCodeCreateTime`）——我们此前把它们全丢了。
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
   * 走到 CAS 门户（R31 抽出来给两处用）：`getLoginWay` → CAS 302 → 门户地址。
   *
   * 两处用它的理由不同但路径相同：
   * - **建单前**（[`resolveQrSessionContext`]）：要那张画着二维码的门户页的 cookie 与 pageToken；
   * - **确认后**（[`resolveCasContext`]）：要换授权码所需的 service/pageToken。
   *
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
   * 建单**之前**的会话上下文（R31）：cookie 罐 + 门户页地址 + pageToken + 服务端下发的 deviceID。
   *
   * 为什么值得在建单前多走几步：探针（`scripts/probe-qr-fidelity.mjs`）把官方二维码页在两个
   * 请求上做的事抓了个全——它的建单**带 cookie、带 `deviceID`/`deviceType=7`、Referer 是门户页**，
   * 轮询还会把**建单响应种下的** cookie 带回来。我们此前这三样一个都没有。
   *
   * **不抛异常、不挡界面**：任何一步失败都返回 `{ok:false, reason}`，调用方降级成"照旧建单"
   * （二维码必须能显示出来——保真不能变成新的故障点）。
   *
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
   * 用一份设备指纹换服务端下发的 `sid`（R31）——它就是页面建单时带的 `deviceID`。
   *
   * 形状来自探针抓到的实物请求（`test/fixtures/r31-page-fingerprint.json` 就是它）：
   * `POST /CAS/IDM_W/ajaxHandler/dev?reflushCode=…&cVersion=…`，正文是
   * `{pageToken, pageTokenKey, <页面公共上下文>, fp}`，响应 `{isSuccess:1, sid:"<84 位 hex>"}`。
   *
   * **服务端回空 sid 就是"不认这份指纹"**（探针实测：cs 写错/不写/内容不合形状一律空串），
   * 所以空 sid 一律当失败——宁可建单时不带 `deviceID`，也不自己编一个（编的那个骗不过服务端，
   * 只会让"扫码不关联"更难查）。
   */
  async function resolveDeviceIdentity({ portalUrl, pageToken, pageTokenKey, lang }) {
    if (pageToken === "" || pageTokenKey === "") {
      return { ok: false, reason: "门户页没给出 pageToken/pageTokenKey（指纹接口要它）" };
    }
    const form = new URLSearchParams();
    // 页面那份公共上下文（探针实测的字段表：只这几个，不多带）
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
   * 走一遍 CAS 链，拿"确认之后换码"所需的页面配置。
   *
   * 只在**已经确认**之后才调用：二维码的显示与轮询本身不依赖它（实探证明那两个端点是无状态的），
   * 所以链路的任何失败都发生在"用户已经扫码"之后，代价最小。
   */
  async function resolveCasContext(authorizeUrl) {
    const entry = await walkToCasPortal(authorizeUrl);
    if (!entry.ok) return entry;
    const { portalUrl } = entry.data;

    // 同一串参数换到移动登录页：换码所需的页面配置在那张页上（R16 实测）
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

  /** 已确认 → 走 CAS 门户接口换回 `callbackURL`（R36 起**原样**交给登录链路，本模块不解析它）。 */
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

    /**
     * R36：**原样**交给登录链路——最后一跳由宿主开的**登录 webview** 完成（见文件头 R36 段）。
     *
     * R33/R34/R35 的三条策略（参数直构 / 302 跟随 / 响应体提取）与那套脱敏诊断已**整体退役**：
     * 真机诊断（R35 日志）证明那一页靠**自己的 JS**跳 `hms://`（查询里没有 `code`、200 那份
     * 14KB HTML 里连 `hms` 字样都没有），**服务端 fetch 结构性地拿不到 code**。
     * 所以这里一个请求都不发、一个形状判断都不做：
     * - 判真伪是 `isCallback`/`parseCallback` 的唯一职责（下游 `consumeCallback`）；
     * - 能不能开窗是宿主白名单的职责（Rust `parse_config`：只收 https 且在白名单里的地址）；
     * - 日志只记形状（[`describeCallbackUrlShape`]：scheme + host + path，**不含查询串**）。
     */
    log(
      `二维码换码：callbackURL 形状=${describeCallbackUrlShape(callbackUrl)} → 原样交给登录链路` +
        "（最后一跳由登录 webview 加载该地址完成：页面 JS 跳 hms://，被宿主导航拦截接住）",
    );
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
     *        `onConfirmed` 收到的是 `codeRemoteLogin` 交回的 **`callbackURL` 原文**（R36）：
     *        它可能是 https 的登录收尾页（真机形状），调用方（`auth-manager.finishQrLogin`）
     *        负责把它交给登录 webview 走完最后一跳。本模块不解析它、也不判它的形状。
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
       * R31：建单前先取"会话上下文"（CAS 链 → 门户页 → getPageInfo → 指纹换 sid）。
       *
       * 拿到就用它（cookie 罐 + `deviceID`/`deviceType` + Referer），拿不到就**降级**——
       * 二维码必须照常显示：这一步只是"像页面一样说话"，不是显示二维码的前提。
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
