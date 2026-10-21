#!/usr/bin/env node
/**
 * 二维码全保真探针（R31）：用 **headless Chromium 真开官方二维码页**，把"页面自己发的建单/轮询请求"
 * 逐字节抓下来——URL（查询串有没有）、全部请求头（UA / Referer / Content-Type / Accept / Cookie 名单）、
 * 全部表单字段与值形态（`deviceID`/`deviceType` 长什么样、**从哪来**）。
 *
 * ## 为什么这次要真浏览器（R29 的教训）
 *
 * R29 的探针是 Node `fetch` 手搓链路：它只能证明"我们发的东西服务端收"，永远看不到**页面自己发的是什么**。
 * 于是"deviceID 从哪来"这种问题在那一轮只能是推断（"页面有 localStorage.hwid_cas_sid 时补 deviceID"）。
 * 真浏览器一开，答案当场落地：**建单不在移动页上，而在桌面门户页上**，而 deviceID 是
 * `POST /CAS/IDM_W/ajaxHandler/dev` 用一份**浏览器指纹 fp** 换回来的 `sid`（下面每一步都有实测）。
 *
 * ## 两相位
 *
 * 1. **移动页相位**（手机 UA 开 `/CAS/mobile/standard/login.html`）：它不是二维码页——记录它渲染什么、
 *    以及它**一个 DimensionalCode 请求都不发**（推翻"建单在移动页上"的想当然）；
 * 2. **二维码页相位**（桌面 UA 走 `getLoginWay → CAS → /CAS/portal/loginAuth.html`）：这一张页面上
 *    真的画出了二维码，也真的发了建单与轮询——被拦截的请求就是本探针要的完整形态。
 *
 * ## 纪律（与 R29 同）
 *
 * - **只读公开页面**：不登录账号、不提交任何凭据、不按"确认"；建单产生的那张码用完即弃、不扫不确认；
 * - `qRCode` / `qrToken` / 整串 content 只留长度与 sha256 前 8 位；`deviceID` 同样只留形状
 *   （它是一条**服务端下发的设备标识**，虽不含账号信息，但没必要落盘原值）；
 * - 探针自己的匿名会话（它的 cookie、指纹），与 sidecar 的会话无关。
 *
 * 用法：
 *   node scripts/probe-qr-fidelity.mjs                 # 写 .probe/r31-fidelity.json
 *   node scripts/probe-qr-fidelity.mjs --out .probe/x.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { chromium } from "playwright-core";

import { HUAWEI_QR_ENDPOINTS, QR_HTTP_USER_AGENT } from "../src/main/qr-login.mjs";
import { decodeFingerprint as decodeProductFingerprint, deviceFingerprintFields } from "../src/protocols/device-fingerprint.mjs";
import * as protocol from "../src/protocols/qr-login.mjs";

/** 公开协议事实（client_id 是公开标识符，不是凭据）。 */
const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH_ORIGIN = "https://oauth-login1.cloud.huawei.com";
const CAS_ORIGIN = "https://id1.cloud.huawei.com";

/** 桌面 UA：官方门户页按它决定"这是 PC 版登录页"（也才有屏幕上那张二维码）。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** 手机 UA：只用来证明"手机版页面不画二维码、也不建单"。 */
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; HUAWEI P60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/** 页面按 `getqrContent` 的查询串取的六个建单参数（唯一真源）。 */
const CREATE_TEMPLATE_PARAMS = ["appID", "confirmFlag", "version", "reqClientType", "loginChannel", "appBrand"];

const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/r31-fidelity.json" : process.argv[outIndex + 1];

/** 一次性凭据类的参数名（摘要里一律丢掉）。 */
const isSecretParam = (name) =>
  /token/i.test(name) || /qrcode/i.test(name) || /^code$/i.test(name) || /^session/i.test(name) || /ticket/i.test(name);

const fingerprint = (value) => {
  const text = String(value ?? "");
  if (text === "") return { present: false };
  return { present: true, length: text.length, sha256_8: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8) };
};
/** 只记形状：长度 + 是不是 hex + 前 6 位（证明"两次拿到的是两条不同的标识"）。 */
const shapeOfValue = (value) => {
  const text = String(value ?? "");
  if (text === "") return { present: false };
  return {
    present: true,
    length: text.length,
    hexOnly: /^[0-9a-f]+$/i.test(text),
    sample: text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text,
    sha256_8: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8),
  };
};
const shapeOfUrl = (raw) => {
  try {
    const url = new URL(String(raw));
    return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort(), hasQueryString: url.search !== "" };
  } catch {
    return null;
  }
};
/** 表单正文 → 字段名与每个值的形状（不落原值，除了一眼能看的长度/形状）。 */
const shapeOfForm = (body) => {
  const form = new URLSearchParams(String(body ?? ""));
  return [...form.keys()].map((name) => ({ name, value: isSecretParam(name) ? fingerprint(form.get(name)) : shapeOfValue(form.get(name)) }));
};

/**
 * 页面那份指纹编码器的**逆运算**。用的是**产品里那一个**（`src/protocols/device-fingerprint.mjs`），
 * 而不是探针再抄一遍——这样"我们的编码器 = 页面的编码器"这件事在探针里也是当场比对的
 * （单测另用探针抓到的原件钉住逐字节一致）。
 *
 * 只用来回答一件事：那份 `fp` 里到底有哪些字段、`cs` 是什么算法——因为 deviceID 是拿它换回来的。
 */
function describeFingerprint(fp, rawLength) {
  const decoded = decodeProductFingerprint(fp);
  if (!decoded.ok) return { present: false, reason: decoded.reason };
  return {
    present: true,
    length: rawLength ?? String(fp).length,
    fieldNames: Object.keys(decoded.fields).sort(),
    /** 值形态：长度 + 是不是 40/64 位 hex（canvas/webgl/fonts 那类哈希长这样） */
    fields: Object.entries(decoded.fields)
      .map(([name, value]) => ({ name, length: value.length, hex40: /^[0-9a-f]{40}$/i.test(value), numeric: /^-?\d+$/.test(value) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    checksum: {
      present: true,
      length: decoded.checksum.length,
      /** 实测口径：`cs` 就是 **sha1(去掉 cs 的那半截)**（服务端认它，见报告 §A） */
      equalsSha1OfBody: decoded.checksum === createHash("sha1").update(decoded.body, "utf8").digest("hex"),
    },
    /** 空值在页面那份里是**空数组**（`devs=`/`ips=`），解码只能还出空串——如实标出来 */
    emptyValuedFields: Object.entries(decoded.fields).filter(([, value]) => value === "").map(([name]) => name).sort(),
  };
}

/** 不抓正文的请求记录；cookie 只留名单（`allHeaders()` 才拿得到它，普通 `headers()` 里没有）。 */
function recordRequest(request, allHeaders = {}) {
  const url = shapeOfUrl(request.url());
  const headers = { ...request.headers(), ...allHeaders };
  return {
    method: request.method(),
    url: request.url(),
    urlShape: url,
    postData: request.postData(),
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        name === "cookie" ? { names: String(value).split("; ").map((pair) => pair.split("=")[0]).sort() } : value,
      ]),
    ),
    resourceType: request.resourceType(),
  };
}

const steps = [];
function step(label, detail) {
  steps.push({ label, ...detail });
  console.log(`${String(detail.status ?? "—").padEnd(4)} ${label.padEnd(34)} ${detail.note ?? ""}`.trimEnd());
}

async function launchBrowser() {
  const candidates = [];
  const override = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "").trim();
  if (override !== "") candidates.push({ kind: "env", executablePath: override });
  candidates.push({ kind: "playwright" });
  candidates.push({ kind: "channel:chrome", channel: "chrome" });
  const failures = [];
  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch({
        ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
        ...(candidate.channel ? { channel: candidate.channel } : {}),
      });
      return { browser, kind: candidate.kind, failures };
    } catch (cause) {
      failures.push(`${candidate.kind}: ${String(cause.message).split("\n")[0]}`);
    }
  }
  return { browser: null, kind: null, failures };
}

/** `getLoginWay`：走公开接口拿 CAS 跳转（不登录、不提交凭据）。 */
async function resolveCasEntry() {
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    access_type: "offline",
    code_challenge: DUMMY_CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "r31-fidelity-state",
    display: "page",
    lang: "zh-cn",
    prompt: "login",
  }).toString();
  const response = await fetch(`${OAUTH_ORIGIN}/oauth2/ajax/getLoginWay?reflushCode=${Math.random()}&display=page`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "user-agent": DESKTOP_UA,
      "content-type": "application/x-www-form-urlencoded",
      fromLoginAuth: "false",
      interfaceVersion: "v3",
      origin: OAUTH_ORIGIN,
      referer: `${OAUTH_ORIGIN}/oauth2/v3/authorize?${authorizeQuery}`,
    },
    body: authorizeQuery,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  const casUrl = payload?.loginInteractInfo?.cas?.casLoginRedirectUrl;
  return { status: response.status, casUrl: typeof casUrl === "string" ? casUrl : null };
}

/**
 * 一个相位：开一张页面、跟到落点、按关键字拦请求。
 *
 * @returns 该相位抓到的请求/响应/页面事实
 */
async function drivePhase({ browser, label, userAgent, mobile, landing, waitMs, keywords, done, deviceScaleFactor = 1 }) {
  const context = await browser.newContext({
    userAgent,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { deviceScaleFactor }),
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const captured = [];
  const scriptUrls = new Set();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error.message).slice(0, 200)}`));
  page.on("request", (request) => {
    if (!keywords.test(request.url())) return;
    void request
      .allHeaders()
      .catch(() => ({}))
      .then((allHeaders) => {
        captured.push({ kind: "request", ...recordRequest(request, allHeaders) });
      });
  });
  page.on("response", async (response) => {
    if (keywords.test(response.url())) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      captured.push({
        kind: "response",
        url: response.url(),
        status: response.status(),
        setCookieNames: (response.headers()["set-cookie"] ?? "")
          .split("\n")
          .map((line) => line.split("=")[0].trim())
          .filter(Boolean),
        body: body.slice(0, 1200),
      });
    }
    if (response.request().resourceType() === "script") scriptUrls.add(response.url());
  });

  await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const polls = [];
  for (let waited = 0; waited <= waitMs; waited += 500) {
    const facts = await page
      .evaluate(() => ({
        canvases: document.querySelectorAll("canvas").length,
        qrDataImages: document.querySelectorAll("img[src^='data:image']").length,
        text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 240),
        localStorageKeys: Object.keys(window.localStorage).sort(),
        cookieNames: document.cookie
          .split("; ")
          .filter(Boolean)
          .map((pair) => pair.split("=")[0])
          .sort(),
      }))
      .catch(() => null);
    polls.push({ waited, ...facts });
    if (done(captured)) break;
    await page.waitForTimeout(500);
  }
  // 建单之后再看一小会儿：轮询要抓齐两轮（形状相同、只有 t 不同）
  await page.waitForTimeout(4_500);

  const finalFacts = await page.evaluate(() => ({
    localStorageKeys: Object.keys(window.localStorage).sort(),
    cookieNames: document.cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => pair.split("=")[0])
      .sort(),
  }));
  /** 导航落点（跟完重定向之后的真实地址）——"手机 UA 会落到哪张页"就靠它。 */
  finalFacts.landedUrl = page.url();
  finalFacts.landedShape = shapeOfUrl(page.url());
  finalFacts.landedSearch = (() => {
    try {
      return new URL(page.url()).search;
    } catch {
      return "";
    }
  })();
  finalFacts.title = await page.title().catch(() => "");
  await context.close();

  const create = captured.find((entry) => entry.kind === "request" && entry.url.includes("getqrInfo"));
  const polls2 = captured.filter((entry) => entry.kind === "request" && entry.url.includes("DimensionalCode/async"));
  return {
    label,
    userAgent,
    captured,
    createRequest: create ?? null,
    pollRequests: polls2,
    devRequest: captured.find((entry) => entry.kind === "request" && /\/ajaxHandler\/dev/.test(entry.url)) ?? null,
    pageFacts: { polls, final: finalFacts, scriptUrls: [...scriptUrls].sort(), consoleErrors },
  };
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

console.log("二维码全保真探针（R31）：headless Chromium 真开官方页，抓建单/轮询/设备指纹的真实形态\n");

const launched = await launchBrowser();
if (launched.browser === null) {
  writeReport({ blocked: "no_chromium", browserFailures: launched.failures });
  console.error(`没有可用的 Chromium：\n  ${launched.failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`浏览器：${launched.kind}（真启动成功）\n`);

const cas = await resolveCasEntry();
step("① getLoginWay（拿 CAS 跳转）", { status: cas.status, note: cas.casUrl ? "有 casLoginRedirectUrl" : "没有 CAS 跳转" });
if (cas.casUrl === null) {
  await launched.browser.close();
  writeReport({ blocked: "get_login_way_no_cas_url" });
  process.exit(1);
}

/**
 * 相位一：手机 UA 走一遍。两小步——① CAS 入口（服务端按 UA 把浏览器送到哪张页）；
 * ② 显式打开**移动登录页** `/CAS/mobile/standard/login.html`（R16 起二维码配置就是从这张页读的，
 * 所以"这张页自己画不画二维码、建不建单"必须当场说清）。
 */
const mobileEntryPhase = await drivePhase({
  browser: launched.browser,
  label: "CAS 入口（手机 UA）",
  userAgent: MOBILE_UA,
  mobile: true,
  landing: cas.casUrl,
  waitMs: 8_000,
  keywords: /DimensionalCode|qrcode\/login\.jsp|\/ajaxHandler\/dev$/,
  done: () => false,
});
/** 一个相位抓到的请求按用途分堆（"这张页面建不建单"是相位的结论，不能混在一起数）。 */
const countByKind = (phase) => ({
  create: phase.captured.filter((entry) => entry.kind === "request" && entry.url.includes("getqrInfo")).length,
  poll: phase.captured.filter((entry) => entry.kind === "request" && entry.url.includes("DimensionalCode/async")).length,
  deviceFinger: phase.captured.filter((entry) => entry.kind === "request" && /\/ajaxHandler\/dev$/.test(entry.url)).length,
});
const mobileEntryFacts = mobileEntryPhase.pageFacts.polls.at(-1);
step("② 手机 UA 走 CAS 入口", {
  status: 200,
  note: `落点 ${mobileEntryPhase.pageFacts.final.landedShape?.path ?? "?"}；画布 ${mobileEntryFacts?.canvases ?? "?"} 个、二维码图 ${mobileEntryFacts?.qrDataImages ?? "?"} 个；建单 ${countByKind(mobileEntryPhase).create} 条 / 轮询 ${countByKind(mobileEntryPhase).poll} 条 / 指纹 ${countByKind(mobileEntryPhase).deviceFinger} 条`,
});

const mobilePageUrl = `${CAS_ORIGIN}/CAS/mobile/standard/login.html${mobileEntryPhase.pageFacts.final.landedSearch ?? ""}`;
const mobilePhase = await drivePhase({
  browser: launched.browser,
  label: "移动登录页（手机 UA，显式打开）",
  userAgent: MOBILE_UA,
  mobile: true,
  landing: mobilePageUrl,
  waitMs: 10_000,
  keywords: /DimensionalCode|qrcode\/login\.jsp|\/ajaxHandler\/dev$/,
  done: () => false,
});

const mobileFacts = mobilePhase.pageFacts.polls.at(-1);
step("②b 显式打开移动登录页（手机 UA）", {
  status: 200,
  note: `落点 ${mobilePhase.pageFacts.final.landedShape?.path ?? "?"}；画布 ${mobileFacts?.canvases ?? "?"} 个、二维码图 ${mobileFacts?.qrDataImages ?? "?"} 个；建单 ${countByKind(mobilePhase).create} 条 / 轮询 ${countByKind(mobilePhase).poll} 条 / 指纹 ${countByKind(mobilePhase).deviceFinger} 条`,
});

// 相位二：桌面 UA 走门户页——屏幕上那张二维码就是它画的，建单/轮询都是它发的
const portalLanding = `${CAS_ORIGIN}/CAS/portal/loginAuth.html${new URL(cas.casUrl).search || ""}`;
const portalPhase = await drivePhase({
  browser: launched.browser,
  label: "桌面门户登录页（桌面 UA，二维码在这里）",
  userAgent: DESKTOP_UA,
  mobile: false,
  landing: cas.casUrl,
  waitMs: 20_000,
  keywords: /DimensionalCode|\/ajaxHandler\/dev/,
  done: (captured) =>
    captured.some((entry) => entry.kind === "request" && entry.url.includes("DimensionalCode/async")) &&
    captured.filter((entry) => entry.kind === "request" && entry.url.includes("DimensionalCode/async")).length >= 2,
});
const portalUrl = portalPhase.captured.find((entry) => entry.kind === "request" && /loginAuth\.html/.test(entry.headers.referer ?? ""))?.headers.referer ?? portalLanding;
const lastPortalFacts = portalPhase.pageFacts.polls.at(-1);
step("③ 桌面 UA 开门户登录页", {
  status: 200,
  note: `画布 ${lastPortalFacts?.canvases ?? "?"} 个、二维码图 ${lastPortalFacts?.qrDataImages ?? "?"} 个、localStorage=${JSON.stringify(lastPortalFacts?.localStorageKeys ?? [])}`,
});

const createRequest = portalPhase.createRequest;
if (createRequest === null) {
  await launched.browser.close();
  writeReport({ blocked: "no_create_request", mobilePhase, portalPhase });
  console.error("\n没抓到建单请求：二维码页的形状可能变了（见 .probe/r31-fidelity.json 的原始捕获）");
  process.exit(1);
}
const createForm = shapeOfForm(createRequest.postData);
const createFieldNames = createForm.map((entry) => entry.name).sort();
step("④ 页面自己的建单请求（决定性）", {
  status: "POST",
  note: `URL ${createRequest.urlShape.path}${createRequest.urlShape.hasQueryString ? "?（带查询串）" : "（**无查询串**）"}；字段 ${createFieldNames.join(",")}`,
});

const deviceIdField = createForm.find((entry) => entry.name === "deviceID");
const deviceTypeField = createForm.find((entry) => entry.name === "deviceType");
step("⑤ deviceID/deviceType 的形状", {
  status: "—",
  note: deviceIdField
    ? `deviceID 长度 ${deviceIdField.value.length} hex=${deviceIdField.value.hexOnly}；deviceType=${deviceTypeField?.value?.sample ?? "(缺)"}`
    : "页面这次没带 deviceID（isUsedDeviceFingerSite 没开？）",
});

const devRequest = portalPhase.devRequest;
const devBody = devRequest ? new URLSearchParams(devRequest.postData ?? "") : null;
// fp 里的 "+" 会被 URLSearchParams 解成空格，所以从原始正文里按字节取
function rawField(postData, name) {
  for (const pair of String(postData ?? "").split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at) === name) return decodeURIComponent(pair.slice(at + 1).replace(/\+/g, "%2B"));
  }
  return null;
}
const fingerprintShape = devRequest ? describeFingerprint(rawField(devRequest.postData, "fp")) : null;
step("⑥ 设备指纹 dev 请求（deviceID 的来源）", {
  status: "POST",
  note: fingerprintShape
    ? `fp 字段=${fingerprintShape.fieldNames.length} 个；cs=sha1(body)? ${fingerprintShape.checksum.equalsSha1OfBody}；请求字段=${[...(devBody?.keys() ?? [])].join(",")}`
    : "页面这次没发 dev 请求",
});

const devResponse = portalPhase.captured.find((entry) => entry.kind === "response" && /\/ajaxHandler\/dev/.test(entry.url));
let devSid = null;
try {
  devSid = JSON.parse(devResponse?.body ?? "{}").sid ?? null;
} catch {
  devSid = null;
}
step("⑦ dev 的响应（sid = deviceID）", {
  status: devResponse?.status ?? "—",
  note: devSid ? `sid 长度 ${String(devSid).length}（hex=${/^[0-9a-f]+$/i.test(devSid)}）` : "没有 sid",
});

const pollRequest = portalPhase.pollRequests[0] ?? null;
step("⑧ 页面自己的轮询请求", {
  status: "POST",
  note: pollRequest ? `${pollRequest.urlShape.path}?${pollRequest.urlShape.queryKeys.join("&")}；表单=${[...new URLSearchParams(pollRequest.postData ?? "").keys()].join(",")}` : "没抓到轮询",
});

// ---------------------------------------------------------------------------
// 保真度比对：**今天页面发的东西 vs 我们会发的东西**（用产品代码本身算，不另写一份）
// ---------------------------------------------------------------------------

/** 建单请求 URL：R31 起产品里就按"去掉查询串"发（没有这个导出时退化成同一规则，探针照样能跑）。 */
const toRequestUrl = typeof protocol.qrCreateRequestUrl === "function" ? protocol.qrCreateRequestUrl : (value) => String(value).split("?")[0];
const oursCreateUrl = toRequestUrl(HUAWEI_QR_ENDPOINTS.create);
/** 我们**现在**会发的那一份（模板六参数，没别的） */
const oursTemplateFields = [...new URLSearchParams(protocol.buildQrCreateBody(HUAWEI_QR_ENDPOINTS.create)).keys()].sort();
/** R31 B 之后我们会发的那一份（补上设备标识） */
const oursAlignedFields = [
  ...new URLSearchParams(protocol.buildQrCreateBody(HUAWEI_QR_ENDPOINTS.create, { extra: { deviceID: "X", deviceType: "7" } })).keys(),
].sort();
const pageCreateFields = createFieldNames;
const diff = (left, right) => ({
  missing: left.filter((name) => !right.includes(name)),
  extra: right.filter((name) => !left.includes(name)),
});

const fidelity = {
  create: {
    pageUrl: createRequest.urlShape,
    oursUrl: shapeOfUrl(oursCreateUrl),
    urlSame: shapeOfUrl(oursCreateUrl).path === createRequest.urlShape.path && !shapeOfUrl(oursCreateUrl).hasQueryString,
    pageFields: pageCreateFields,
    /** R31 B 之前的口径：只发模板六参数（deviceID/deviceType 缺） */
    oursFieldsNow: oursTemplateFields,
    missingNow: diff(pageCreateFields, oursTemplateFields).missing,
    /** R31 B 之后的口径：补上设备标识 */
    oursFieldsAligned: oursAlignedFields,
    missingAligned: diff(pageCreateFields, oursAlignedFields).missing,
    extraAligned: diff(pageCreateFields, oursAlignedFields).extra,
    /** 六个模板参数两边必须逐个相同（模板真源 = `getqrContent` 查询串） */
    templateParams: CREATE_TEMPLATE_PARAMS.map((name) => ({
      name,
      page: createForm.find((entry) => entry.name === name)?.value?.sample ?? null,
      ours: new URLSearchParams(protocol.buildQrCreateBody(HUAWEI_QR_ENDPOINTS.create)).get(name),
    })),
  },
  poll: {
    pageUrl: pollRequest?.urlShape ?? null,
    pageFields: pollRequest ? [...new URLSearchParams(pollRequest.postData ?? "").keys()] : [],
    oursUrl: shapeOfUrl(HUAWEI_QR_ENDPOINTS.poll),
    oursFields: [...new URLSearchParams(protocol.buildQrPollBody("X")).keys()],
  },
  headers: {
    pageUserAgent: createRequest.headers["user-agent"] ?? null,
    pageRefererShape: shapeOfUrl(createRequest.headers.referer ?? ""),
    pageCookieNames: createRequest.headers.cookie?.names ?? [],
    pageAccept: createRequest.headers.accept ?? null,
    pageContentType: createRequest.headers["content-type"] ?? null,
    /** 我们那份 UA 就是产品常量（与页面的桌面 UA 同款；改它要连契约一起改） */
    oursUserAgent: QR_HTTP_USER_AGENT,
    oursUserAgentSameAsPage: QR_HTTP_USER_AGENT === (createRequest.headers["user-agent"] ?? null),
    oursCookieNamesSource: "sidecar 的 cookie 罐（R31 起建单/轮询带它）",
  },
  interval: {
    page: null,
    ours: HUAWEI_QR_ENDPOINTS.intervalMs,
  },
  deviceIdentity: {
    pageDeviceIdShape: deviceIdField?.value ?? null,
    pageDeviceType: deviceTypeField?.value?.sample ?? null,
    devFieldNames: devRequest ? [...(devBody?.keys() ?? [])] : [],
    fingerprint: fingerprintShape,
    /**
     * fp 的**原值**（探针自己那份匿名浏览器指纹：画布/WebGL/字体哈希与屏幕尺寸，不含账号信息）。
     *
     * 为什么破例留原值：单测要用它钉住"我们的编码器与页面**逐字节**一致"
     * （`test/fixtures/r31-page-fingerprint.json` 就是从它摘的），而只留长度与指纹做不到这一点。
     */
    rawFingerprint: devRequest ? rawField(devRequest.postData, "fp") : null,
    /** 我们那份字段表（产品代码算出来的）与页面那份逐个比：字段名集合必须完全一致 */
    oursFingerprintFieldNames: Object.keys(deviceFingerprintFields({ now: 0, lang: "zh-cn" })).sort(),
    fingerprintFieldSetSame:
      fingerprintShape?.present === true &&
      JSON.stringify(Object.keys(deviceFingerprintFields({ now: 0, lang: "zh-cn" })).sort()) ===
        JSON.stringify(fingerprintShape.fieldNames),
    sidShape: devSid ? shapeOfValue(devSid) : null,
    ours: typeof protocol.buildQrFingerprint === "function" ? "产品里已实现同一条链（dev → sid → deviceID）" : "产品里还没有（R31 B 落地后这里会变）",
  },
};
step("⑨ 保真度比对（页面 vs 我们的代码）", {
  status: "—",
  note:
    `建单 URL ${fidelity.create.urlSame ? "一致 ✓" : "不一致 ✗"}；` +
    `字段缺 ${JSON.stringify(fidelity.create.missingAligned)}、多 ${JSON.stringify(fidelity.create.extraAligned)}；` +
    `轮询字段 ${JSON.stringify(fidelity.poll.pageFields)} vs ${JSON.stringify(fidelity.poll.oursFields)}；` +
    `设备指纹字段表 ${fidelity.deviceIdentity.fingerprintFieldSetSame ? "一致 ✓" : "不一致 ✗"}；` +
    `UA ${fidelity.headers.oursUserAgentSameAsPage ? "与页面相同 ✓" : "与页面不同 ✗"}`,
});

await launched.browser.close();

writeReport({
  ok: true,
  browser: launched.kind,
  cas: { entryShape: shapeOfUrl(cas.casUrl) },
  portalUrlShape: shapeOfUrl(portalUrl),
  /** 相位一（反证）：移动页不是二维码页 */
  mobilePhases: [
    {
      label: mobileEntryPhase.label,
      landingShape: shapeOfUrl(cas.casUrl),
      landedShape: mobileEntryPhase.pageFacts.final.landedShape ?? null,
      title: mobileEntryPhase.pageFacts.final.title ?? "",
      surface: mobileEntryFacts
        ? { canvases: mobileEntryFacts.canvases, qrDataImages: mobileEntryFacts.qrDataImages, text: mobileEntryFacts.text, localStorageKeys: mobileEntryFacts.localStorageKeys }
        : null,
      requests: countByKind(mobileEntryPhase),
    },
    {
      label: mobilePhase.label,
      landingShape: shapeOfUrl(mobilePageUrl),
      landedShape: mobilePhase.pageFacts.final.landedShape ?? null,
      title: mobilePhase.pageFacts.final.title ?? "",
      surface: mobileFacts
        ? { canvases: mobileFacts.canvases, qrDataImages: mobileFacts.qrDataImages, text: mobileFacts.text, localStorageKeys: mobileFacts.localStorageKeys }
        : null,
      requests: countByKind(mobilePhase),
      cookieNames: mobilePhase.pageFacts.final.cookieNames,
    },
  ],
  mobileConsoleErrors: [...mobileEntryPhase.pageFacts.consoleErrors, ...mobilePhase.pageFacts.consoleErrors].slice(0, 5),
  /** 相位二：真二维码页的完整形态 */
  portalPhase: {
    surface: lastPortalFacts ?? null,
    createRequest: { ...createRequest, urlShape: createRequest.urlShape, form: createForm },
    pollRequests: portalPhase.pollRequests.map((entry) => ({
      url: entry.url,
      urlShape: entry.urlShape,
      form: shapeOfForm(entry.postData),
      headers: entry.headers,
    })),
    devRequest: devRequest
      ? { url: devRequest.url, urlShape: devRequest.urlShape, headers: devRequest.headers, form: shapeOfForm(devRequest.postData) }
      : null,
    devResponse: devResponse ? { status: devResponse.status, sid: devSid ? shapeOfValue(devSid) : null } : null,
    consoleErrors: portalPhase.pageFacts.consoleErrors.slice(0, 5),
  },
  fidelity,
  note:
    "只请求公开页面/公开静态资源与公开的二维码建单、轮询、设备指纹接口；不登录账号、不提交凭据、不扫码确认。" +
    "qRCode/qrToken/二维码内容只留长度与指纹；deviceID 也只留形状（它是服务端下发的设备标识）。",
});

function writeReport({ blocked = null, ...rest }) {
  const report = {
    tool: "scripts/probe-qr-fidelity.mjs",
    generatedAt: new Date().toISOString(),
    mode: "headless Chromium 真开官方页（手机 UA 相位 + 桌面 UA 二维码页相位），拦页面自己的建单/轮询/指纹请求（无账号、无凭据、不确认）",
    disclaimer:
      "只请求公开页面/公开静态资源与公开接口；不登录、不提交凭据、不确认。凭据类值（qRCode/qrToken/content）只留长度与 sha256 前 8 位。",
    clientId: CLIENT_ID,
    desktopUserAgent: DESKTOP_UA,
    mobileUserAgent: MOBILE_UA,
    blocked,
    steps,
    ...rest,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n摘要已写入 ${outPath}`);
}
