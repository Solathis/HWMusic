#!/usr/bin/env node
/**
 * 手机侧二维码页探针（R29）：回答"扫码之后为什么桌面端还停在未扫档"。
 *
 * 背景（R29 真机现场）：用户扫码后桌面端轮询 36 轮以上全部 `resultCode=103000200`、
 * `errorDesc="Please to login."`——连 `103000202`（已扫待确认）都没出现过。也就是说
 * **扫码从未关联到我们会话**。桌面侧已经实测健康（建单 → 轮询 → 服务端正常应答），
 * 所以问题的落点只可能在"手机打开那张码之后发生了什么"。
 *
 * 本探针把手机侧那条路走一遍，**只读公开页面**（不登录账号、不提交任何凭据、不扫码确认）：
 *
 * 1. 建一个**本脚本自己的**二维码会话（与 `scripts/probe-qr.mjs` 同一条链）；
 * 2. 记下 content URL 的**非敏感**参数（`qRCode` 只留指纹）；
 * 3. 用**手机 UA** 打开 content URL，看它跳到哪一页（实探：`/CAS/mobile/confirmQRLogin.html`）；
 * 4. 打开前后各轮询一次，如实记下 `resultCode`/`errorDesc`——"光把页面打开"到底会不会翻档；
 * 5. 顺着手机页的静态资源链（shell → `hwidConfig.js` → 该页的 entry bundle）把**手机页自己
 *    会发什么请求**读出来（接口名计数），因为"扫码上报"是它发的还是 App 发的，决定了
 *    我们能修什么、不能修什么。
 *
 * **不承诺**：本探针不会、也不能产生一次真实的"已扫/已确认"——那需要一个已登录华为账号的
 * 手机（用户在场的授权动作）。它只回答"不登录的手机会怎样"和"手机页的代码长什么样"。
 *
 * 落盘只留形状：端点、参数名与非敏感参数值、resultCode、errorDesc 文案、接口名计数；
 * `qRCode`/`qrToken`/二维码内容一律只留长度与指纹。
 *
 * 用法：
 *   node scripts/probe-qr-phone.mjs                 # 默认写 .probe/r29-phone.json
 *   node scripts/probe-qr-phone.mjs --out .probe/x.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { HUAWEI_QR_ENDPOINTS } from "../src/main/qr-login.mjs";

/** 协议事实照抄任务书与 R16 的实探（client_id 是公开标识符，不是凭据）。 */
const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const OAUTH_ORIGIN = "https://oauth-login1.cloud.huawei.com";
const CAS_ORIGIN = "https://id1.cloud.huawei.com";
const CAS_AJAX_PATH = "/CAS/IDM_W/ajaxHandler/";
const INTERFACE_VERSION = "v3";
const CAS_CVERSION = "UP_CAS_6.26.3.100";
const TIMEOUT_MS = 20_000;

/** 手机 UA：手机页会按它决定渲染哪一档（这里只换 UA，不带任何账号凭据）。 */
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 12; HUAWEI P50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36";
/** 桌面 UA：建单链路上页面按它决定门户版本（与 scripts/probe-qr.mjs 同款）。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 手机页代码里值得数一数的接口名（读它就知道"扫码上报"归谁发）。 */
const API_WORDS = [
  "confirmQRLogin",
  "qrRemoteLogin",
  "codeRemoteLogin",
  "getqrInfo",
  "DimensionalCode",
  "scanQRCode",
  "qRCode",
  "qrCodeIsExpired",
  "callBackUrl",
  "withCredentials",
];

const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/r29-phone.json" : process.argv[outIndex + 1];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
function absorbCookies(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function request(url, init = {}) {
  const headers = {
    "user-agent": init.mobile === true ? MOBILE_UA : DESKTOP_UA,
    ...(jar.size > 0 ? { cookie: cookieHeader() } : {}),
    ...(init.headers ?? {}),
  };
  try {
    const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
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
      setCookies: (response.headers.getSetCookie?.() ?? []).map((line) => line.split("=")[0].trim()),
      body,
      error: null,
    };
  } catch (cause) {
    const code = cause?.cause?.code ?? cause?.code ?? cause?.name ?? "unknown";
    return { status: null, location: null, contentType: null, setCookies: [], body: "", error: String(code).slice(0, 80) };
  }
}

const jsonOf = (response) => {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
};
/** 值本身不入结果：只留长度与前 8 位 sha256（证明"两次拿到的是不同的东西"）。 */
function fingerprint(value) {
  const text = String(value ?? "");
  if (text === "") return { present: false };
  return { present: true, length: text.length, sha256_8: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8) };
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
/** 一次性凭据类的参数名（摘要里一律丢掉）。 */
const isSecretParam = (name) => /token/i.test(name) || /qrcode/i.test(name) || /^code$/i.test(name) || /^session/i.test(name) || /ticket/i.test(name);

const steps = [];
function step(label, detail) {
  steps.push({ label, ...detail });
  console.log(`${String(detail.status ?? "ERR").padEnd(4)} ${label.padEnd(36)} ${detail.note ?? ""}`.trimEnd());
}

console.log("手机侧二维码页探针：只读公开页面 + 建一个自己的二维码会话（不登录、不扫码确认）\n");

// ---------------------------------------------------------------------------
// ① 建一个我们自己的会话（与 scripts/probe-qr.mjs 同一条链）
// ---------------------------------------------------------------------------

const authorizeQuery = new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: "openid",
  access_type: "offline",
  code_challenge: DUMMY_CODE_CHALLENGE,
  code_challenge_method: "S256",
  state: "r29-phone-state",
  display: "page",
  lang: "zh-cn",
  prompt: "login",
}).toString();

const loginWay = await request(`${OAUTH_ORIGIN}/oauth2/ajax/getLoginWay?reflushCode=${Math.random()}&display=page`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    fromLoginAuth: "false",
    interfaceVersion: INTERFACE_VERSION,
    origin: OAUTH_ORIGIN,
    referer: `${OAUTH_ORIGIN}/oauth2/v3/authorize?${authorizeQuery}`,
  },
  body: authorizeQuery,
});
const casUrl = jsonOf(loginWay)?.loginInteractInfo?.cas?.casLoginRedirectUrl;
step("① getLoginWay", { status: loginWay.status, note: casUrl ? "拿到 CAS 跳转" : "没有 CAS 跳转" });
if (typeof casUrl !== "string" || casUrl === "") {
  writeReport({ blocked: "get_login_way_no_cas_url" });
  process.exit(1);
}

const casEntry = await request(casUrl);
const portalUrl = casEntry.location ? new URL(casEntry.location, casUrl).href : null;
if (portalUrl === null) {
  writeReport({ blocked: "cas_no_portal_location" });
  process.exit(1);
}
await request(portalUrl);

const mobileUrl = `${CAS_ORIGIN}/CAS/mobile/standard/login.html${new URL(portalUrl).search}`;
await request(mobileUrl);
const pageInfoForm = new URLSearchParams();
for (const [name, value] of new URL(mobileUrl).searchParams) pageInfoForm.set(name, value);
pageInfoForm.set("pageName", "login");
pageInfoForm.set("urlParam", new URL(mobileUrl).search.slice(1));
pageInfoForm.set("languageCode", pageInfoForm.get("lang") ?? "zh-cn");
const pageInfo = await request(`${CAS_ORIGIN}${CAS_AJAX_PATH}login/getPageInfo?reflushCode=${Math.random()}&cVersion=${CAS_CVERSION}`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: CAS_ORIGIN, referer: mobileUrl },
  body: pageInfoForm.toString(),
});
const localInfo = jsonOf(pageInfo)?.localInfo ?? {};
const createEndpoint = typeof localInfo.getqrContent === "string" ? localInfo.getqrContent : null;
const pollEndpoint = typeof localInfo.asyncURL === "string" ? localInfo.asyncURL : null;
if (createEndpoint === null || pollEndpoint === null) {
  writeReport({ blocked: "no_qr_config" });
  process.exit(1);
}

/** 建单：参数从服务端下发的模板查询串里取（唯一真源），路径部分单独取（页面就是这么发的）。 */
const createBase = createEndpoint.split("?")[0];
const template = new URL(createEndpoint).searchParams;
const createForm = new URLSearchParams(
  ["appID", "confirmFlag", "version", "reqClientType", "loginChannel", "appBrand"].map((name) => [name, template.get(name) ?? ""]),
);
const created = await request(createBase, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: CAS_ORIGIN, referer: mobileUrl },
  body: createForm.toString(),
});
const qr = jsonOf(created);
const qrToken = typeof qr?.qrToken === "string" ? qr.qrToken : "";
const content = typeof qr?.content === "string" ? qr.content : "";
step("② 建单（自有会话）", {
  status: created.status,
  note: qr ? `content=${fingerprint(content).length}B keys=${Object.keys(qr).join(",")}` : "响应不是 JSON",
});
if (qrToken === "") {
  writeReport({ blocked: "no_qr_token", createStatus: created.status });
  process.exit(1);
}

async function poll() {
  const response = await request(`${pollEndpoint}&t=${Math.random()}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: CAS_ORIGIN, referer: mobileUrl },
    body: new URLSearchParams({ qrToken }).toString(),
  });
  const body = jsonOf(response);
  return { status: response.status, resultCode: body?.resultCode ?? null, errorDesc: body?.errorDesc ?? null, responseKeys: body ? Object.keys(body) : [] };
}

/**
 * 建单保真度：**今天**页面下发的模板 vs 我们硬编码的端点，逐参数比一遍。
 *
 * 这是 R29 简报方向 ① 的直接答案（"我们的参数与页面是否一致"）——不靠历史探针的记录，
 * 每次跑都当场取、当场比。`localInfo` 里另有一套 `reqClientType`/`loginChannel`（OAuth 客户端
 * 的上下文），**二维码建单不用那一套**：页面用的是 `getqrContent` 里自带的值（下面比的就是它）。
 */
function compareCreateFidelity() {
  const live = new URL(createEndpoint);
  const ours = new URL(HUAWEI_QR_ENDPOINTS.create);
  const names = [...new Set([...live.searchParams.keys(), ...ours.searchParams.keys()])].sort();
  const params = names.map((name) => ({
    name,
    live: live.searchParams.get(name),
    ours: ours.searchParams.get(name),
    same: live.searchParams.get(name) === ours.searchParams.get(name),
  }));
  return {
    /** 页面取的是 `getqrContent.split("?")[0]`，我们把这个路径也留在 URL 上（偏差之一，登记在契约里） */
    path: { live: live.pathname, ours: ours.pathname, same: live.pathname === ours.pathname },
    params,
    allParamsSame: params.every((entry) => entry.same),
    pollUrl: { live: pollEndpoint, ours: HUAWEI_QR_ENDPOINTS.poll, same: pollEndpoint === HUAWEI_QR_ENDPOINTS.poll },
    intervalMs: { live: Number(localInfo.qrcodeRequestInterval), ours: HUAWEI_QR_ENDPOINTS.intervalMs, same: Number(localInfo.qrcodeRequestInterval) === HUAWEI_QR_ENDPOINTS.intervalMs },
  };
}

const fidelity = compareCreateFidelity();
step("②b 建单保真度（今天页面 vs 我们的常量）", {
  status: "—",
  note: `path ${fidelity.path.same ? "✓" : "✗"}、六个参数 ${fidelity.allParamsSame ? "全等 ✓" : "有差异 ✗"}、轮询端点 ${fidelity.pollUrl.same ? "✓" : "✗"}、间隔 ${fidelity.intervalMs.same ? "✓" : "✗"}（${fidelity.intervalMs.live}ms）`,
});

// ---------------------------------------------------------------------------
// ② 手机打开 content URL 之前 / 之后：档位到底会不会动
// ---------------------------------------------------------------------------

const before = await poll();
step("③ 打开 content URL 之前的轮询", { status: before.status, note: `resultCode=${before.resultCode}` });

const phoneOpen = await request(content, { mobile: true, headers: { "accept-language": "zh-CN,zh;q=0.9" } });
step("④ 手机 UA 打开 content URL", {
  status: phoneOpen.status,
  note: `${shapeOfUrl(phoneOpen.location ?? content)?.path ?? "(无跳转)"} setCookie=${phoneOpen.setCookies.join(",") || "(无)"}`,
});
const confirmUrl = phoneOpen.location ? new URL(phoneOpen.location, content).href : null;
const shell = confirmUrl === null ? null : await request(confirmUrl, { mobile: true });
if (shell !== null) {
  step("⑤ 手机侧确认页 shell", {
    status: shell.status,
    note: `${shell.body.length}B 引用的脚本=${[...shell.body.matchAll(/src="([^"]+)"/g)].map((m) => m[1]).join(",") || "(无)"}`,
  });
}

// 等一轮（服务端记一次"打开"也要时间），再连采两次，别把"刚好没到"读成"永远不会"
await sleep(2_100);
const after = await poll();
await sleep(2_100);
const after2 = await poll();
step("⑥ 打开之后的轮询（关键）", { status: after.status, note: `resultCode=${after.resultCode} errorDesc=${JSON.stringify(after.errorDesc)}` });
step("⑦ 再等一轮", { status: after2.status, note: `resultCode=${after2.resultCode}` });

// ---------------------------------------------------------------------------
// ③ 手机页的代码：它自己发什么请求（静态资源，公开）
// ---------------------------------------------------------------------------

/** 顺着 shell → hwidConfig.js → 该页的 loader → entry bundle 读手机页的调用面（每一跳都读页面自己的声明）。 */
const assets = [...(shell?.body ?? "").matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const configUrl = assets.find((value) => value.includes("hwidConfig.js")) ?? null;
let pageCode = null;
if (configUrl !== null) {
  const config = await request(new URL(configUrl, confirmUrl).href, { mobile: true });
  // 手机页自己声明了资源前缀、缓存版本号与"哪个 html 用哪个 loader"（都在这一份配置里）
  const filePrefix = /var filePrefix="([^"]+)"/.exec(config.body)?.[1] ?? null;
  const cluster = /wiseContentCluster:"([^"]+)"/.exec(config.body)?.[1] ?? null;
  const cacheVersion = /catheVersion:"([^"]+)"/.exec(config.body)?.[1] ?? null;
  const htmlPath = new URL(confirmUrl).pathname;
  const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loaderPath = new RegExp(`"${escapeForRegExp(htmlPath)}":"([^"]+)"`).exec(config.body)?.[1] ?? null;
  step("⑧ hwidConfig.js", {
    status: config.status,
    note: `filePrefix=${filePrefix} cluster=${cluster} catheVersion=${cacheVersion} 本页 loader=${loaderPath}`,
  });

  // 页面真实请求的形状：前缀按集群补一段 static_rss/<cluster>，loader 就是"前缀 + 映射值"
  // （映射值自己以 `/js/` 开头，所以这里不再补一段 js）
  const prefixed = filePrefix === null || cluster === null ? filePrefix : filePrefix.replace("static_rss", `static_rss/${cluster}`);
  const loaderUrl =
    prefixed === null || loaderPath === null
      ? null
      : `${CAS_ORIGIN}${prefixed}${loaderPath}${cacheVersion === null ? "" : `?${cacheVersion}`}`;
  const loader = loaderUrl === null ? null : await request(loaderUrl, { mobile: true });
  const flow = loader === null ? null : /var flowFilePath="([^"]+)"/.exec(loader.body)?.[1] ?? null;
  // loader 只负责说"这一页的入口是哪个文件"；真正的页面代码在 vuebuild/js/<flow>-entry-legacy.js
  const bundleUrl =
    prefixed === null || flow === null
      ? null
      : `${CAS_ORIGIN}${prefixed}/vuebuild/js/${flow}-entry-legacy.js${cacheVersion === null ? "" : `?${cacheVersion}`}`;
  if (bundleUrl !== null) {
    const bundle = await request(bundleUrl, { mobile: true });
    const counts = Object.fromEntries(API_WORDS.map((word) => [word, bundle.body.split(word).length - 1]));
    step("⑨ 手机页 entry bundle", {
      status: bundle.status,
      note: bundle.status === 200 ? `${bundle.body.length}B 接口名计数=${JSON.stringify(counts)}` : "没取到（路径拼法随版本变）",
    });
    pageCode = {
      url: shapeOfUrl(bundleUrl),
      status: bundle.status,
      bytes: bundle.body.length,
      apiWordCounts: counts,
      /** 手机页把"确认登录"按钮接到哪个接口（本次实探：confirmQRLogin，参数只有 qRCode） */
      confirmCallSite: /confirmQRLogin\(t,/.test(bundle.body),
    };
  }
}

writeReport({
  ok: true,
  createEndpoint: shapeOfUrl(createBase),
  createTemplateQueryKeys: [...template.keys()].sort(),
  /** 方向 ① 的答案：今天下发的模板 vs 我们的常量，逐参数 */
  createFidelity: fidelity,
  pollEndpoint: shapeOfUrl(pollEndpoint),
  /** 页面 localInfo 里与二维码/站点有关的上下文（非敏感；`reqClientType`/`loginChannel` 那一套是 OAuth 的，建单不用） */
  mobileLocalInfo: {
    isUsedDeviceFingerSite: localInfo.isUsedDeviceFingerSite,
    isOpenDimensionalCode: localInfo.isOpenDimensionalCode,
    qrcodeRequestInterval: localInfo.qrcodeRequestInterval,
    currentSiteID: localInfo.currentSiteID,
    urlCountrySiteID: localInfo.urlCountrySiteID,
    oauthReqClientType: localInfo.reqClientType,
    oauthLoginChannel: localInfo.loginChannel,
  },
  session: {
    createStatus: created.status,
    createFormKeys: [...createForm.keys()],
    createResponseKeys: qr ? Object.keys(qr) : [],
    content: { ...fingerprint(content), target: shapeOfUrl(content) },
    /** content URL 的非敏感参数（qRCode 丢掉；真源就是服务端下发的模板） */
    contentPublicParams: Object.fromEntries(
      [...new URL(content).searchParams.entries()].filter(([name]) => !isSecretParam(name)).sort((a, b) => a[0].localeCompare(b[0])),
    ),
    qrCode: fingerprint(qr?.qrCode),
    sessionId: fingerprint(qr?.sessionID),
  },
  contentOpenedByPhoneUa: {
    status: phoneOpen.status,
    location: shapeOfUrl(phoneOpen.location),
    setCookies: phoneOpen.setCookies,
  },
  phoneConfirmPage: confirmUrl === null ? null : { shape: shapeOfUrl(confirmUrl), shell: shell === null ? null : { status: shell.status, bytes: shell.body.length } },
  pageCode,
  tierBeforeOpen: before,
  tierAfterOpen: after,
  tierAfterOpenAgain: after2,
  /** 结论口径：光"打开"（没有登录态）会不会翻档 */
  openingAloneChangedTier: before.resultCode !== after.resultCode || before.resultCode !== after2.resultCode,
  cookieNames: [...jar.keys()].sort(),
  note: "本探针不会产生真实的已扫/已确认：那需要一个已登录华为账号的手机（用户在场的授权动作）。",
});

function writeReport({ blocked = null, ...rest }) {
  const report = {
    tool: "scripts/probe-qr-phone.mjs",
    generatedAt: new Date().toISOString(),
    mode: "public pages + own qr session opened with a mobile UA (no account, no credentials, no confirm)",
    disclaimer:
      "只请求公开页面/公开静态资源与公开的二维码建单/轮询接口；不登录账号、不提交凭据、不确认。qRCode/qrToken/二维码内容一律只留长度与指纹。",
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    blocked,
    steps,
    ...rest,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n摘要已写入 ${outPath}（二维码内容与会话令牌不入结果）。`);
}
