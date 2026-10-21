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
 * 1. **认不出的 resultCode 一律按"继续轮询"，但连续 N 个就熔断**（R22）：陌生码当成功 =
 *    拿一个没确认的会话去换令牌；陌生码**一直**来 = 协议变了，无限轮询只会让界面永远停在
 *    等待态（R22 用户反馈的那次"卡住"就有这一段），所以连续 [`QR_DEFAULT_MAX_UNKNOWN_CODES`]
 *    个陌生码收口成 `failed`（带 `unknown_result_code`，停轮询）；
 * 2. **状态变化才广播**：2 秒一次 tick、扫码要好几分钟，每次 tick 都广播会把通道刷成噪声；
 * 3. **过期只报不换**（R21 用户指令，**推翻** R16/R20 的"过期自己重建"）：`expired` 是一条
 *    **终点**广播——停轮询、不建新单；换新只能由用户手动触发（渲染层再发一次 `auth:qr-start`，
 *    而"再 start"本来就是 restart 语义）。原来那条的理由是"渲染层什么都做不了"，代价却是
 *    用户眼睁睁看着码自己换掉、不知道该做什么；现在过期态明确停住，界面上写着"点击刷新"；
 * 4. **错误不静默**：建单失败、连续轮询失败都广播 `failed`（带一句人话），界面才有东西可显示。
 *
 * R20 增补第五条（手动刷新的竞态）：**取消之后落地的响应一律不广播**（`running` 复检）。
 * 用户点一下二维码容器就是"停旧会话 + 开新会话"，而旧会话可能正好有一次轮询在飞——
 * 它落地时若照常广播，会把刚画出来的新码顶掉（还会顺手再建一张）。会话自己就知道它被
 * 取消了，所以判据放在这里，而不是指望调用方在每条路上补一遍。
 * R21 之后仍需要它：过期不再自动换新，但"取消的旧会话打回过期态"照样会毁掉新那一张。
 *
 * R22（用户真机反馈两项：① 倒计时到 0 后卡在「正在确认过期…」一直不过期；② 过期时间正确性）
 * 在这一层落三件事，**渲染层一行都不用改**：
 *
 * - **A. TTL 无偏差换算**：`expiresInMs = expiredTime − qrCodeCreateTime`——两个都是**服务端值**，
 *   与本地钟无关（老公式 `expiredTime − now()` 把两个时钟相减，本地钟快 1 小时，倒计时一上来
 *   就归零 → 用户看到的正是"一直不过期"）。`qrCodeCreateTime` 缺失/非法时才回退老公式
 *   （偏差风险如实写在 [`parseQrCreate`] 的注释里），字段不可信或两个值互相矛盾 → `null`（不猜）。
 * - **B. 本地到期权威兜底**：建单/刷新时就把"到期锚 + 宽限 [`QR_LOCAL_EXPIRY_GRACE_MS`]"这一时刻
 *   排进**一次性定时器**（R26 改的落点，见下），到点时若服务端**什么话都没说**（仍 pending 或缺省/
 *   陌生码）就主动转 `expired` 并停轮询。轮询落地点那条检查**保留成第二张网**。
 *   **服务端一律优先**：它给出 `expired`/`scanned`/`confirmed` 时本地兜底让位（不抢、不改判）。
 * - **C. 轮询诊断日志**：每轮一行 resultCode（只有轮次与状态码；`qrToken`、二维码内容、
 *   cookie 一律不进日志）。真机再报"卡住"时，日志能直接指出轮询有没有在跑、服务端说了什么。
 *
 * R26（用户真机反馈之 3：倒计时到 0 之后「正在确认过期…」要等很久才变过期）只改**落点**：
 * R22 的兜底挂在**轮询落地**那一步 → 归零之后还得再排一整轮轮询（间隔 2 秒、实探往返约 8 秒），
 * 叠上 15 秒宽限，最长约 25 秒。现在到期时刻在**建单/刷新时就排进一次性定时器**，宽限同时
 * 收窄到 3 秒（理由写在 [`QR_LOCAL_EXPIRY_GRACE_MS`]）→ 倒计时归零之后**最多 3 秒**必有出口，
 * 与轮询在不在飞无关；服务端仍然优先（它说话时那张网直接撤掉）。
 *
 * 全部依赖注入（fetch/计时器/时钟），所以整条状态机在测试里跑得完，不碰网络也不碰真实时间。
 *
 * R29（用户真机反馈之 4：扫码之后轮询仍是"未扫"）在这一层只落**观测**，不落行为：
 * 诊断结论是"扫码从未关联到我们会话，而落点在手机侧"（四条证据见 `docs/API_CONTRACT.md` §1.8 的
 * R29 段：建单/轮询与官方页逐参数相同、页面代码里 `confirmQRLogin` 是唯一出向请求、手机 UA 打开
 * content URL 不翻档、真机四会话 90 轮全是 `103000200`/`"Please to login."`）。所以那一轮本层**一行行为
 * 都没改**，只把下一轮真机可判所需的两样东西记下来：
 * - **建单一行**（[`describeQrContent`]）：这张码指向哪、带哪些**非敏感**上下文参数
 *   （`qRCode` 与 token/session 类参数一律丢掉）；
 * - **轮询每行**（[`sanitizeErrorDesc`] + 时刻 + `t+…s` 节奏）：`errorDesc` 是**唯一**能拿来**推断**
 *   "压根没扫"与"扫了但手机侧没登录"的那句话——状态码 `103000200` 两种情况共用
 *   （**R31 更正措辞**：它是线索，不是判据；没有对照组，别当成"唯一能区分"的证据）。
 *
 * R31（用户指令：界面不变、不用移动端 UA、继续修自己生成的二维码）在这一层落**请求形状**，
 * 三处，全部来自探针实物（`scripts/probe-qr-fidelity.mjs`，headless Chromium 真开官方二维码页）：
 * - 建单请求的 URL **去掉查询串**（页面就是 `getqrContent.split("?")[0]`，见 [`qrCreateRequestUrl`]）；
 *   端点常量仍带模板查询串——它是六个参数的唯一真源；
 * - 建单表单可以多带 `deviceID`/`deviceType`（[`createQrSession`] 的 `createParams`：
 *   那颗 `deviceID` 是**服务端下发的 sid**，由端口层拿一份设备指纹换回来）；
 * - 建单/轮询的 `accept` 与 `Referer` 与页面同款（[`QR_PAGE_ACCEPT`] + `extraHeaders`）。
 * 本层仍然**只收注入**：cookie 罐、UA、Referer、deviceID 的来源都在端口层（`src/main/qr-login.mjs`），
 * 这样"协议形状"与"从哪拿上下文"两件事不互相牵连。
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
  /** 二维码过期（R21：**终点档**——停轮询，等用户手动再 start 换新） */
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
  /** 连续若干个认不出的 resultCode（协议变更；R22 的熔断出口） */
  unknownResultCode: "unknown_result_code",
};

/** 服务端没给间隔时的兜底（实探给的正是 2000ms；改这里等于改协议默认值，要同步契约文件）。 */
export const QR_DEFAULT_INTERVAL_MS = 2_000;
/** 连续轮询失败多少次收口（网络抖一下不算登录坏了）。 */
export const QR_DEFAULT_MAX_POLL_FAILURES = 3;

/**
 * 连续多少个**认不出**的 resultCode 就收口（R22 熔断）。
 *
 * 为什么不是"永远继续等"：陌生码当成功是最严重的误判（拿没确认的会话去换令牌），但
 * "一直陌生"同样致命——协议真变了的时候，这条会话会 2 秒一次打到总期限（10 分钟），
 * 用户全程看着一张不会变的界面，日志里也什么都没有。5 个是一段"够看出是持续异常"的
 * 观察窗（约 10~50 秒），比总期限早得多。
 */
export const QR_DEFAULT_MAX_UNKNOWN_CODES = 5;

/**
 * 本地到期兜底的宽限（R22 立、R26 收窄到 3 秒）：本地到期锚过了这么久、服务端还是
 * **什么话都没说**，就由本层裁定"过期"。
 *
 * 为什么是 3 秒（R26 用户真机反馈：倒计时到 0 之后「正在确认过期…」要等很久）：
 * 兜底**只差一个落点**。R22 把检查放在**轮询落地**那一步，而轮询间隔 2 秒、实探一次往返约 8 秒
 * （见 R22 报告 §1.3 的实探节奏），于是"归零 → 判死"之间除了宽限还要再排一整轮轮询
 * （最长约 10 秒）——用户的 ~25 秒就是这么来的。R26 改挂**一次性定时器**（建单/刷新时就算好
 * 到点时刻，见 [`createQrSession`] 的 `armLocalExpiry`），轮询在不在飞都不影响，那 10 秒先没了。
 *
 * 剩下的 3 秒只承担一件事：给"服务端那条 `expired` 正在路上"留出余量。而这个余量本身不必大
 * ——到期锚取的是**建单响应落地**那一刻（比服务端真正的到期时刻**晚**一个往返，宁晚不早，见
 * `expiresAtLocal` 的说明），判死本来就落在一个已经保守的刻度上；实探也显示服务端通常在本地
 * 归零**之前**就给 `103000201`（TTL 181s、t+177.4s 观测到），所以这一档只在服务端沉默时兜底。
 * 它同时是渲染层「正在确认过期…」那一档的**上界**：倒计时数到 0 之后最多再等 3 秒必有出口。
 */
export const QR_LOCAL_EXPIRY_GRACE_MS = 3_000;

/** 建单表单里那些"从端点模板查询串取"的参数名。 */
export const QR_CREATE_PARAMS = ["appID", "confirmFlag", "version", "reqClientType", "loginChannel", "appBrand"];

/**
 * 建单/轮询的 `accept` 头（R31：页面用的就是这一串，`application/json` 只是它的子集）。
 *
 * 为什么照抄而不是"写个等价的"：这两个请求是同一个页面、同一套 axios 发的，
 * 头里差一个字符就是"我们和页面不一样"；协议保真的价值在于**没有可解释的差异**。
 */
export const QR_PAGE_ACCEPT = "application/json, text/plain, */*";

/**
 * 建单请求的 URL（R31）：**把查询串丢掉**，只留 origin + path。
 *
 * 真源（探针 `scripts/probe-qr-fidelity.mjs`，headless Chromium 真开官方二维码页）：
 * 页面建单发的是 `POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo`——**一个查询串都没有**，
 * 那六个参数走表单。而页面自己也是这么做的：`this.localInfo.getqrContent.split("?")[0]`。
 *
 * 端点常量（[`HUAWEI_QR_ENDPOINTS.create`]）仍然带模板查询串——它是**六个参数的唯一真源**
 * （[`buildQrCreateBody`] 从它取），所以这里丢的只是"请求上多挂的那截"，不是参数本身。
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
 * `errorDesc` 进日志时的长度上限（R29）。
 *
 * 为什么要有上限：它是**服务端文案**，长度不由我们决定；超出部分对诊断没有增量信息，
 * 却能把一行日志撑成几屏。截断处留 `…`，看得出"这里被截了"。
 */
export const QR_ERROR_DESC_MAX = 80;

/**
 * 服务端 `errorDesc` → 一行可安全写进日志的文案（R29；`null` = 没有 / 全是空白）。
 *
 * 真机现场（R29）：轮询 36 轮全 `resultCode=103000200`、`errorDesc="Please to login."`——
 * 状态码只说"还没结果"，**那句话才是线索**（服务端在说"扫码那一侧还没登录"）。
 * 而 R22 起的诊断日志只记了状态码，等于把唯一有用的那句话扔了。
 *
 * 两条处理：换行/连续空白压成一个空格（一行日志必须是一行）；超长截断（见 [`QR_ERROR_DESC_MAX`]）。
 * 它**不是凭据**（固定文案，不带会话信息），所以与 qrToken/qrCode 的纪律不同，可以进日志。
 *
 * @param {unknown} value 响应里的 `errorDesc`
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
 * `content`（二维码里编码的那串 URL）→ 一行**非敏感**摘要（R29；`null` = 认不出）。
 *
 * 现场要回答的第一个问题：我们建的这张码到底指向哪、带什么上下文参数？手机扫的是**屏幕上那张**，
 * 而"扫码从不关联"最可能的两种解释（参数错位 / 手机侧没登录）都要靠这一行才能分开。所以记
 * path + 非敏感查询参数，**丢掉 `qRCode` 与任何 token/session 类参数**（见 [`isSecretParam`]）。
 *
 * 认不出（空串、不是 http(s) URL）时回 `null`：日志里不猜一个形状。
 *
 * @param {unknown} content 建单响应里的 `content`
 * @returns {string|null} 形如 `/qrcode/login.jsp?loginChannel=7000700&reqClientType=700`
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
 * **有效期（R22 要求 ②）**：优先用 `expiredTime − qrCodeCreateTime`——两个都是**服务端值**，
 * 相减得到的是服务端自己的 TTL，与本地钟偏多少无关。老公式 `expiredTime − 本地 now()` 是拿
 * 服务端纪元减本地钟，本地快 1 小时就会算出 0（倒计时一上来就归零，用户看到的是"卡在
 * 正在确认过期…"），本地慢 1 小时则会多算出 63 分钟。
 *
 * `qrCodeCreateTime` 缺失/非法时**回退**老公式——**已知偏差风险**：那一条路径下倒计时会随
 * 本地钟平移（典型症状是"早到"或"晚到"若干分钟）。回退是有意的：有偏差的倒计时仍好过没有，
 * 但这条路径必须在日志与契约里看得见（契约 §3 登记了这一点）。字段本身不可信、或两个服务端值
 * 互相矛盾（`expiredTime ≤ qrCodeCreateTime`）→ `null`：宁可界面少一行倒计时，也不猜一个数。
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
 * 有效期（毫秒）：三条路，全都写在这里，不在调用点各算一遍（R22）。
 *
 * 1. 两个服务端值都在且 `expiredTime > qrCodeCreateTime` → **差值**（免疫本地时钟偏差）；
 * 2. `expiredTime` 可信但 `qrCodeCreateTime` 缺失/非法 → 回退 `expiredTime − now()`
 *    （**偏差风险**：这条路径下倒计时随本地钟平移，R22 之前的公式就是它）；
 * 3. 其余（`expiredTime` 不可信 / 两个值矛盾）→ `null`（不猜）。
 *
 * @param {object} payload 建单响应
 * @param {() => number} now 本地钟（只有回退路径读它）
 * @returns {number|null} 毫秒；`null` = 不知道（调用方不许自己编一个）
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
 * 二维码会话（建单 + 轮询；过期只报不换，R21）。
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
     * 建单时额外带的表单字段（R31：`{deviceID, deviceType}`）。
     *
     * 为什么由调用方注入而不是本层写死：`deviceID` 是**服务端下发的 sid**（页面拿一份设备指纹
     * 去 `/CAS/IDM_W/ajaxHandler/dev` 换回来的，见 `src/protocols/device-fingerprint.mjs`），
     * 那一步需要 CAS 会话上下文（pageToken/cookie），只有端口层拿得到。本层只负责"给了就带上"。
     */
    createParams = undefined,
    /**
     * 建单/轮询额外带的请求头（R31：`{referer}`）。
     *
     * 页面这两个请求的 Referer 就是那张画着二维码的门户页；端口层知道它，本层不知道，
     * 所以同样走注入。默认不加（本层不编一个 Referer 出来）。
     */
    extraHeaders = undefined,
  } = options;

  let status = QR_LOGIN_STATUS.idle;
  let timer = null;
  let deadlineTimer = null;
  /** R26：本地到期那张**一次性**定时器（建单/刷新时算好到点时刻，与轮询在不在飞无关）。 */
  let expiryTimer = null;
  let running = false;
  let failures = 0;
  let current = null;
  /** 连续认不出的 resultCode 个数（R22 熔断；认出一个码就归零）。 */
  let unknownCodes = 0;
  /** 已轮询多少轮（R22 诊断日志的轮次；每次 start 归零）。 */
  let pollRound = 0;
  /**
   * 本次会话开始的本地时刻（R29 诊断日志的"节奏"零点；每次 start 重设）。
   *
   * 为什么记节奏而不是只记绝对时刻：真机上要回答的是"扫码那一刻，轮询到底在不在跑、
   * 隔多久一轮"。`t+…s` 与随行的本地时刻一起给，既能数节奏，也能和 sidecar 的其它日志对齐。
   */
  let startedAtLocal = null;
  /**
   * 本地到期锚（R22 兜底）：建单响应落地那一刻的本地钟 + 服务端 TTL。
   *
   * 为什么取"响应落地"而不是"请求发出"：服务端 TTL 从它的 `qrCodeCreateTime` 起算，
   * 那个时刻落在一次往返之间，取落地时刻只会**晚**判（最多晚一个往返），而晚判是安全的
   * 一侧——早判等于把一张其实还能扫的码撤掉。`null` = 建单没给出可信 TTL（此时**没有**
   * 本地权威，兜底一次都不许触发，见 [`localExpiryDue`]）。
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
    // R22 兜底锚：服务端 TTL 换成**本地**到期时刻（建单响应落地这一刻起算，宁晚不早）。
    // `expiresInMs` 为 null（建单没给出可信 TTL）时锚点也是 null：没有本地权威就不许兜底。
    expiresAtLocal = parsed.data.expiresInMs === null ? null : now() + parsed.data.expiresInMs;
    // 取消之后才落地的建单响应：不再广播（这一档属于一次已经作废的会话）
    if (!running) return parsed;
    // R29 诊断：建单成功就留一行**非敏感**摘要——真机再报"扫码不关联"时，先看这张码指向哪、
    // 带的是哪些上下文参数（qRCode 与 token 一律不进；见 describeQrContent）。
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
   * 本地到期锚 + 宽限已经过了吗？（R22 兜底；服务端**什么话都没说**时才问这一句）
   *
   * 两道闸门缺一不可：
   * 1. `expiresAtLocal !== null`——建单给了可信 TTL 才谈得上"本地知道它过期了"；
   * 2. `now() >= 锚 + 宽限`——归零那一刻不给判（服务端那条 `expired` 通常正在路上），
   *    再等 [`QR_LOCAL_EXPIRY_GRACE_MS`]。
   */
  function localExpiryDue() {
    return expiresAtLocal !== null && now() >= expiresAtLocal + QR_LOCAL_EXPIRY_GRACE_MS;
  }

  /**
   * 本地裁定过期（R22 兜底出口）：停轮询 + 只播 `expired`。
   *
   * 与 R21 那条"服务端说过期"走**同一个终点档**：渲染层因此不用区分这两种来源
   * （它那一档的处理完全一样：撤码、写"已过期，点击刷新"）。
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
   * 挂上本地到期那张**一次性**定时器（R26 修 3：把"到点"排进计时器，不再等下一次轮询落地）。
   *
   * 为什么是一次性而不是"每秒看一眼"：本地在这里**只做一次裁决**——到点那一刻服务端还没说话
   * 就是过期，之后没有"再看一次"的语义（会话已经收了）。轮询那张网仍然在（见 [`poll`]），
   * 所以即使这次定时器因为时钟异常没到点，下一轮轮询落地还会再检查一次。
   *
   * 没有可信 TTL（`expiresAtLocal === null`）时**一次都不挂**：没有本地权威就没有本地裁决。
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
   * 总期限（一次性）：等扫码期间轮询是 2 秒一次，没人扫就会一直跑下去——
   * 总期限保证"一直没人扫"有个尽头（R21 起过期本身就会停轮询，但等待期仍可能无限长）。
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
    // 取消（或重启）之后才落地的响应：**不广播、不排下一次**。
    // 没有这一道，一次在飞的轮询会在用户已经换了一张新码之后，把旧会话的 expired/scanned
    // 甚至 confirmed 播出去，把界面上那张新码顶掉（R20 手动刷新的竞态钉在 test/qr-login.test.mjs）。
    if (!running) return;
    const classified = classifyQrPoll(payload);
    const code = classified.resultCode ?? "";
    const unknown = classified.unknownResultCode !== undefined;
    if (unknown) unknownCodes += 1;
    else unknownCodes = 0;
    // R22 诊断（修 3）：**每轮一行**——真机再报"卡在正在确认过期…"时，日志要能回答
    // "轮询还在跑吗、服务端说了什么"。脱敏：轮次/时刻/节奏/状态码/errorDesc
    // （qrToken、二维码内容、cookie 都不进）。
    // R29 增补：带上本地时刻与"距本次会话开始多久"（节奏），并带上 errorDesc——状态码只说
    // "还没结果"，服务端那句话才是线索（现场原话 "Please to login."）。
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
      // R21（用户指令）：过期**不再自动换新**——只广播这一档并停轮询（连总期限计时器一起清）。
      // 换新由用户点击触发：渲染层再发一次 `auth:qr-start`，而本端口的 `start()` 就是 restart。
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
      // R22 熔断（修 1）：协议真变了的时候，无限轮询只会让用户永远停在等待态
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
    // R22 兜底：网络坏掉时服务端同样**什么都没说**——若本地到期锚 + 宽限早过了，
    // 正确答案是"这码已经过期了"，而不是把用户继续挂在「正在确认过期…」上。
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
     * 发起（或重新发起）一次二维码会话：先建单，成功后才开始轮询。
     *
     * R21 起这是**唯一**的换码路径：过期之后会话停在 `expired`（不轮询、不建单），
     * 用户点刷新 → 渲染层再发一次 `auth:qr-start` → 走到这里（旧的先取消，再建新单）。
     */
    async start() {
      stop();
      failures = 0;
      current = null;
      // R22：新会话 = 新的计数与新的到期锚（上一次那张码的这两个事实一律作废）
      unknownCodes = 0;
      pollRound = 0;
      // R29：节奏零点（诊断日志的 `t+…s` 从这里算）
      startedAtLocal = now();
      expiresAtLocal = null;
      status = QR_LOGIN_STATUS.idle;
      running = true;
      if (!endpointsReady()) return err("二维码登录端点未配置", QR_ERROR_KINDS.missingEndpoint);

      const created = await create();
      if (!created.ok) return fail(created.error.message, created.error.kind);
      armDeadline();
      schedule();
      // R26：到期那张网在**建单落地时**就挂上（延迟 = 服务端 TTL + 宽限）。
      // 排在轮询之后挂是有意的：它不影响任何语义，只是让"第一个挂上的计时器 = 第一次轮询"
      // 这个可观测顺序保持稳定（真机日志与测试都按它读）。
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
     *
     * 过期之后这里仍是**那张已作废的码**（会话不自动换新，也就没有"新的当前"）：
     * 它只给诊断与"换码链读当前那张"用，而那条链只在 `confirmed` 那一档才走
     * ——过期之后不会再有任何 confirmed，所以它读不到一份过期的凭据。
     */
    current: () =>
      current === null
        ? null
        : { content: current.content, expiresInMs: current.expiresInMs, qrCode: current.qrCode },
  };
}
