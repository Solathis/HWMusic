#!/usr/bin/env node
/**
 * 二维码（DimensionalCode）登录链路探针（R16 / A 部分）。
 *
 * **只请求外网公开页面与公开的二维码建单接口**：不登录任何账号、不提交任何凭据、不扫码。
 * 建立的二维码会话由本脚本自己丢弃（不轮询到 confirm，也就拿不到任何可用凭据）。
 *
 * 协议的来路（可复现）：
 * 1. `oauth-login1.cloud.huawei.com` 的授权页是 Vue3 SPA，它 POST `/oauth2/ajax/getLoginWay`
 *    （头 `interfaceVersion: v3`）后按 `loginType` 决定渲染哪条路；对 client 101444301 返回
 *    `cas.casLoginRedirectUrl` → 302 到 `id1.cloud.huawei.com/CAS/portal/loginAuth.html`；
 * 2. CAS 门户页的页面配置由 `POST /CAS/IDM_W/ajaxHandler/login/getPageInfo` 下发（带 pageToken）；
 *    桌面版门户（`/CAS/mobile/` vs `/CAS/portal/`）**只在移动版登录页**下发二维码配置：
 *    `localInfo.getqrContent`（建单端点，自带 appID/loginChannel/reqClientType/version/appBrand）、
 *    `localInfo.asyncURL`（轮询端点）、`localInfo.qrcodeRequestInterval`（轮询间隔毫秒）；
 * 3. 建单：`POST <getqrContent 的路径部分>`，表单 `{appID, confirmFlag, version, reqClientType,
 *    loginChannel, appBrand}`（可带 `deviceID`/`deviceType`），响应
 *    `{content, qrCode, qrToken, sessionID, qrCodeCreateTime, expiredTime, version}`——
 *    `content` 就是二维码要编码的字符串（指向 `/qrcode/login.jsp?...`）；
 * 4. 轮询：`POST <asyncURL>&t=<随机数>`，表单 `{qrToken}`，响应 `{resultCode, errorDesc}`：
 *    `0` = 已确认（携带 userAccount/code 等，**本探针不会走到**）、`103000202` = 已扫待确认、
 *    `103000201` = 过期、其余按"继续轮询"处理。
 *
 * 落盘只留**形状**：端点、字段名、长度、resultCode 序列；`content`/`qrToken` 一律不入结果。
 *
 * 用法：
 *   node scripts/probe-qr.mjs                     # 默认：建单 + 轮询 3 次（间隔取页面配置）
 *   node scripts/probe-qr.mjs --polls 1           # 只轮询一次
 *   node scripts/probe-qr.mjs --out .probe/qr.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { redactUrl, summarizeResponse, verdictOf } from "./probe-lib.mjs";

/** 桌面浏览器 UA（页面按它决定门户版本；探测的是"桌面 client 能不能拿到二维码配置"）。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 协议事实照抄任务书（client_id 是公开标识符，不是凭据）。 */
const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const OAUTH_ORIGIN = "https://oauth-login1.cloud.huawei.com";
const CAS_ORIGIN = "https://id1.cloud.huawei.com";
/** CAS 门户接口前缀（页面里 `_utils.getAjaxPath()` 的返回值）。 */
const CAS_AJAX_PATH = "/CAS/IDM_W/ajaxHandler/";
/** getLoginWay 的接口版本头（页面里 `interfaceVersion`；写错会得到 1101/20314）。 */
const INTERFACE_VERSION = "v3";
/** 门户页版本（页面 URL 里的 cVersion，缺失也接受）。 */
const CAS_CVERSION = "UP_CAS_6.26.3.100";

const TIMEOUT_MS = 20_000;
const PAUSE_MS = 400;

const args = new Set(process.argv.slice(2));
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/qr-probe.json" : process.argv[outIndex + 1];
const pollCount = (() => {
  const index = process.argv.indexOf("--polls");
  const value = index === -1 ? 3 : Number(process.argv[index + 1]);
  return Number.isInteger(value) && value >= 0 ? value : 3;
})();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 极简 cookie jar：门户接口靠 cookie 关联 pageToken/session，探针只在**本次**运行内保留。 */
const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
function absorbCookies(response) {
  const lines = response.headers.getSetCookie?.() ?? [];
  for (const line of lines) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}
/** 只记 cookie 名，不记值（值里可能有会话信息）。 */
const cookieNames = () => [...jar.keys()].sort();

async function request(url, init = {}) {
  const headers = { "user-agent": DESKTOP_UA, ...(jar.size > 0 ? { cookie: cookieHeader() } : {}), ...(init.headers ?? {}) };
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const code = cause?.cause?.code ?? cause?.code ?? cause?.name ?? "unknown";
    return { status: null, location: null, contentType: null, body: "", error: String(code).slice(0, 80), cookies: [] };
  }
  absorbCookies(response);
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type"),
    body,
    error: null,
    cookies: cookieNames(),
  };
}

function jsonOf(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

/** 值本身不入结果：只记长度与前 8 位 sha256（用于证明"两次拿到的是不同的东西"）。 */
function fingerprint(value) {
  const text = String(value ?? "");
  if (text === "") return { present: false };
  return {
    present: true,
    length: text.length,
    sha256_8: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8),
  };
}

/** 只读形状：origin + path + 查询参数名（值一律不记，`qRCode` 那种一次性标识尤其不能留）。 */
function shapeOfUrl(raw) {
  try {
    const url = new URL(String(raw));
    return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort() };
  } catch {
    return null;
  }
}

const steps = [];
function step(label, detail) {
  steps.push({ label, ...detail });
  console.log(`${String(detail.status ?? "ERR").padEnd(4)} ${label.padEnd(34)} ${detail.note ?? ""}`.trimEnd());
}

// ---------------------------------------------------------------------------
// ① 授权页 → getLoginWay → CAS 跳转
// ---------------------------------------------------------------------------

console.log("二维码登录链路探针：只读公开页面 + 建单/轮询自己的二维码会话（不扫码、不登录）\n");

const authorizeQuery = new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: "openid",
  access_type: "offline",
  code_challenge: DUMMY_CODE_CHALLENGE,
  code_challenge_method: "S256",
  state: "probe-state",
  display: "page",
  lang: "zh-cn",
  prompt: "login",
}).toString();

const getLoginWay = await request(
  `${OAUTH_ORIGIN}/oauth2/ajax/getLoginWay?reflushCode=${Math.random()}&display=page`,
  {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      fromLoginAuth: "false",
      interfaceVersion: INTERFACE_VERSION,
      origin: OAUTH_ORIGIN,
      referer: `${OAUTH_ORIGIN}/oauth2/v3/authorize?${authorizeQuery}`,
    },
    body: authorizeQuery,
  },
);
const loginWay = jsonOf(getLoginWay);
step("① POST getLoginWay", {
  status: getLoginWay.status,
  verdict: verdictOf(getLoginWay.status),
  note: `loginType=${loginWay?.loginInteractInfo?.loginType ?? "(无 → 走 TICKET/CAS 跳转)"}`,
  keys: loginWay ? Object.keys(loginWay) : [],
  cookies: getLoginWay.cookies,
});

const casUrl = loginWay?.loginInteractInfo?.cas?.casLoginRedirectUrl;
if (typeof casUrl !== "string" || casUrl === "") {
  console.error("\n拿不到 CAS 跳转地址：getLoginWay 的响应形状变了（见上面记录）。");
  writeReport({ blocked: "get_login_way_no_cas_url", casInfo: loginWay?.loginInteractInfo ?? null });
  process.exit(1);
}

const casLogin = await request(casUrl);
const portalUrl = casLogin.location ? new URL(casLogin.location, casUrl).href : null;
step("② GET CAS remoteLogin", {
  status: casLogin.status,
  verdict: verdictOf(casLogin.status),
  note: portalUrl ? new URL(portalUrl).pathname : "(没有跳转)",
  cookies: casLogin.cookies,
});
if (portalUrl === null) {
  console.error("\nCAS remoteLogin 没有给出门户页地址：链路形状变了。");
  writeReport({ blocked: "cas_no_portal_location" });
  process.exit(1);
}

const portal = new URL(portalUrl);
/** CAS 门户接口调用（与页面一致：查询串带 reflushCode/cVersion，表单带整串页面参数 + pageToken）。 */
async function pageInfo(pageName, targetUrl) {
  const parsed = new URL(targetUrl);
  const form = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) form.set(name, value);
  form.set("pageName", pageName);
  form.set("urlParam", parsed.search.slice(1));
  form.set("languageCode", parsed.searchParams.get("lang") ?? "zh-cn");
  const response = await request(
    `${CAS_ORIGIN}${CAS_AJAX_PATH}login/getPageInfo?reflushCode=${Math.random()}&cVersion=${CAS_CVERSION}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: CAS_ORIGIN,
        referer: targetUrl,
      },
      body: form.toString(),
    },
  );
  return { response, json: jsonOf(response), pageName };
}

// 桌面门户页（门户版本决定页面：/CAS/portal/loginAuth.html）
await request(portalUrl);
const desktopInfo = await pageInfo("loginAuth", portalUrl);
const desktopLocal = desktopInfo.json?.localInfo ?? {};
step("③ getPageInfo 桌面门户", {
  status: desktopInfo.response.status,
  verdict: verdictOf(desktopInfo.response.status),
  note: `isQrlogin=${desktopLocal.isQrlogin} getqrContent=${typeof desktopLocal.getqrContent}`,
  qrConfigKeys: Object.keys(desktopLocal).filter((key) => /qr|dimensional/i.test(key)),
});

// 移动登录页（同一 client 的二维码配置只在它这里下发：urlQuery 原样带过去）
const mobileUrl = `${CAS_ORIGIN}/CAS/mobile/standard/login.html${portal.search}`;
await request(mobileUrl);
const mobileInfo = await pageInfo("login", mobileUrl);
const mobile = mobileInfo.json?.localInfo ?? {};
step("④ getPageInfo 移动登录页", {
  status: mobileInfo.response.status,
  verdict: verdictOf(mobileInfo.response.status),
  note: `isOpenDimensionalCode=${mobile.isOpenDimensionalCode} interval=${mobile.qrcodeRequestInterval}ms`,
  qrConfigKeys: Object.keys(mobile).filter((key) => /qr|dimensional/i.test(key)),
});

const createEndpoint = typeof mobile.getqrContent === "string" ? mobile.getqrContent : null;
const pollEndpoint = typeof mobile.asyncURL === "string" ? mobile.asyncURL : null;
if (createEndpoint === null || pollEndpoint === null) {
  console.error("\n移动登录页没有下发二维码配置（getqrContent/asyncURL）：协议不可达。");
  writeReport({ blocked: "no_qr_config", mobileQrKeys: Object.keys(mobile).filter((k) => /qr/i.test(k)) });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ② 建单（只建自己的二维码会话，不扫码）
// ---------------------------------------------------------------------------

const createBase = createEndpoint.split("?")[0];
const createTemplate = new URL(createEndpoint).searchParams;
const deviceId = jar.get("hwid_cas_sid") ?? "";
const createForm = new URLSearchParams({
  appID: createTemplate.get("appID") ?? "",
  confirmFlag: createTemplate.get("confirmFlag") ?? "",
  version: createTemplate.get("version") ?? "",
  reqClientType: createTemplate.get("reqClientType") ?? "",
  loginChannel: createTemplate.get("loginChannel") ?? "",
  appBrand: createTemplate.get("appBrand") ?? "",
});
if (deviceId !== "") {
  createForm.set("deviceID", deviceId);
  createForm.set("deviceType", "7");
}

const created = await request(createBase, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: CAS_ORIGIN,
    referer: mobileUrl,
  },
  body: createForm.toString(),
});
const qr = jsonOf(created);
const qrToken = typeof qr?.qrToken === "string" ? qr.qrToken : "";
const content = typeof qr?.content === "string" ? qr.content : "";
step("⑤ POST 二维码建单", {
  status: created.status,
  verdict: verdictOf(created.status),
  note: qr ? `keys=${Object.keys(qr).join(",")}` : "响应不是 JSON",
  responseKeys: qr ? Object.keys(qr) : [],
});

if (qrToken === "") {
  console.error("\n建单响应里没有 qrToken：无法继续轮询（协议形状变了）。");
  writeReport({ blocked: "no_qr_token", createStatus: created.status, createKeys: qr ? Object.keys(qr) : [] });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ③ 轮询（永远停在"未扫/已扫待确认"这一档；扫与确认是用户在场授权的事）
// ---------------------------------------------------------------------------

const intervalMs = Number.isFinite(Number(mobile.qrcodeRequestInterval)) ? Number(mobile.qrcodeRequestInterval) : 2000;
const polls = [];
for (let index = 0; index < pollCount; index += 1) {
  if (index > 0) await sleep(intervalMs);
  const polled = await request(`${pollEndpoint}&t=${Math.random()}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: CAS_ORIGIN,
      referer: mobileUrl,
    },
    body: new URLSearchParams({ qrToken }).toString(),
  });
  const body = jsonOf(polled);
  const entry = {
    index,
    status: polled.status,
    verdict: verdictOf(polled.status),
    resultCode: body?.resultCode ?? null,
    errorCode: body?.errorCode ?? null,
    /** 服务端给的说明文案（非凭据，但在结果里只留长度与前 8 位指纹，避免夹带标识） */
    errorDesc: fingerprint(body?.errorDesc),
    responseKeys: body ? Object.keys(body) : [],
  };
  polls.push(entry);
  step(`⑥ 轮询 #${index + 1}`, {
    status: polled.status,
    verdict: entry.verdict,
    note: `resultCode=${entry.resultCode}`,
  });
}

/** 状态码语义（从页面 bundle 里读出来的口径，避免把"继续轮询"当成失败）。 */
const RESULT_CODE_MEANING = {
  "0": "confirmed（已确认，响应携带兑换所需载荷——本探针不会到达这一档）",
  "103000200": "pending（未扫/会话未就绪；页面把它按「继续轮询」处理）",
  "103000201": "expired（二维码过期，需要重新建单）",
  "103000202": "scanned（已扫码，等待手机确认）",
};

writeReport({
  ok: true,
  protocol: {
    authorize: `${OAUTH_ORIGIN}/oauth2/v3/authorize`,
    getLoginWay: { endpoint: `${OAUTH_ORIGIN}/oauth2/ajax/getLoginWay`, interfaceVersion: INTERFACE_VERSION },
    casRemoteLogin: shapeOfUrl(casUrl),
    casPortal: shapeOfUrl(portalUrl),
    pageInfo: { endpoint: `${CAS_ORIGIN}${CAS_AJAX_PATH}login/getPageInfo`, cVersion: CAS_CVERSION },
    qrCreate: {
      endpoint: `${shapeOfUrl(createBase)?.origin}${shapeOfUrl(createBase)?.path}`,
      templateQueryKeys: [...createTemplate.keys()].sort(),
      formKeys: [...createForm.keys()],
      responseKeys: qr ? Object.keys(qr) : [],
      content: { ...fingerprint(content), target: shapeOfUrl(content) },
      qrToken: fingerprint(qrToken),
      qrCode: fingerprint(qr?.qrCode),
      sessionId: fingerprint(qr?.sessionID),
      expiredTime: qr?.expiredTime ?? null,
      version: qr?.version ?? null,
    },
    qrPoll: {
      endpoint: shapeOfUrl(pollEndpoint),
      formKeys: ["qrToken"],
      intervalMs,
      resultCodeMeaning: RESULT_CODE_MEANING,
      samples: polls,
    },
  },
  desktopPortalQrKeys: Object.keys(desktopLocal).filter((key) => /qr|dimensional/i.test(key)),
  mobilePortalQrKeys: Object.keys(mobile).filter((key) => /qr|dimensional/i.test(key)),
  note: "二维码会话由本脚本自己创建并丢弃；不扫码、不确认，因此拿不到任何可用凭据。",
});

function writeReport({ blocked = null, ...rest }) {
  const report = {
    tool: "scripts/probe-qr.mjs",
    generatedAt: new Date().toISOString(),
    mode: "public-pages + own-qr-session (no account, no scan)",
    disclaimer:
      "只请求外网公开页面与公开的二维码建单/轮询接口；不登录账号、不提交凭据、不扫码；二维码内容与会话令牌一律不入结果（只留长度与指纹）。",
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    blocked,
    cookieNames: cookieNames(),
    steps,
    ...rest,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n摘要已写入 ${outPath}（二维码内容与会话令牌不入结果）。`);
  void summarizeResponse;
  void redactUrl;
}
