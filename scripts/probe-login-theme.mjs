#!/usr/bin/env node
/**
 * 官方登录页主题探针（R26）：应用切深色时，嵌入的官方页能不能跟着变深？
 *
 * **只碰公开页面与公开接口**：不登录、不输账号、不提交凭据、不扫码。authorize 用的是 demo
 * `code_challenge` 与探针自己的一次性 `state`，因此拿不到任何可用凭据。
 *
 * 三个问题（结论与落点登记在 `docs/API_CONTRACT.md` §1.7 的 R26 段）：
 *
 *  A. `themeName` 是不是官方页的主题开关？它加在 **authorize 请求**上会不会传播到
 *     服务端生成的 `/CAS/portal/loginAuth.html?…`？
 *  B. 真正裁决主题的是谁？—— 页面第一个脚本 `hwidConfig.js` 会**同步** POST
 *     `common/getBaseSwitchInfo`，并用**服务端回的那一份**覆盖本地配置；这一问直接问服务端：
 *     哪些值它认、UA 会不会改变答案（桌面 UA 与 HarmonyOS 移动 UA 各来一遍）。
 *  C. 结论落到页面上是什么样？—— 用 headless Chromium 打开门户页（与 `npm run test:browser`
 *     同一套浏览器候选），量 body/root 的**计算背景色**、看它实际请求了哪一份主题 CSS。
 *
 * 用法：
 *   node scripts/probe-login-theme.mjs                 # 全部三段
 *   node scripts/probe-login-theme.mjs --out .probe/login-theme-probe.json
 *   node scripts/probe-login-theme.mjs --no-browser    # 只跑 A/B（不起浏览器）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** HarmonyOS 移动 UA（唯一一条服务端认深色的路；这也是**没有采纳**它的原因，见 §1.7 R26 段）。 */
const HARMONY_UA =
  "Mozilla/5.0 (Phone; HarmonyOS 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36";

const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH_ORIGIN = "https://oauth-login1.cloud.huawei.com";
const CAS_ORIGIN = "https://id1.cloud.huawei.com";
const CVERSION = "UP_CAS_6.26.3.100";
const TIMEOUT_MS = 25_000;

/** 页面的移动版式闸门（`_utils.isMobileWap()`，逐字来自页面 bundle）。 */
const MOBILE_LAYOUT_TOKENS = /android|mobile|iphone|ipad|hwid_clienttype=hmos|tablet/i;

const args = new Set(process.argv.slice(2));
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/login-theme-probe.json" : process.argv[outIndex + 1];
const skipBrowser = args.has("--no-browser");

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
function absorb(response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function request(url, init = {}) {
  const headers = { "user-agent": CHROME_UA, ...(jar.size > 0 ? { cookie: cookieHeader() } : {}), ...(init.headers ?? {}) };
  try {
    const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    absorb(response);
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    return { status: response.status, location: response.headers.get("location"), body, error: null };
  } catch (cause) {
    return { status: null, location: null, body: "", error: String(cause?.cause?.code ?? cause?.name ?? cause).slice(0, 80) };
  }
}

/** 只记形状：origin + path + `themeName` 的值（公开主题名，不是凭据）。 */
function shapeOf(raw) {
  try {
    const url = new URL(String(raw));
    return { origin: url.origin, path: url.pathname, themeName: url.searchParams.get("themeName") };
  } catch {
    return null;
  }
}

const report = {
  tool: "probe-login-theme",
  generatedAt: new Date().toISOString(),
  disclaimer: "只读公开页面与公开接口；不登录、不输账号、不提交凭据、不扫码",
  chromeUa: CHROME_UA,
  harmonyUa: HARMONY_UA,
};

// ---------------------------------------------------------------------------
// A. themeName 在授权链上的传播（加在 authorize 上 → casLoginRedirectUrl → 门户页）
// ---------------------------------------------------------------------------
async function chain(themeName, ua = CHROME_UA) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    access_type: "offline",
    code_challenge: DUMMY_CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "probe-login-theme",
    display: "page",
    lang: "zh-cn",
    prompt: "login",
    ...(themeName === undefined ? {} : { themeName }),
  }).toString();

  const loginWay = await request(`${OAUTH_ORIGIN}/oauth2/ajax/getLoginWay?reflushCode=${Math.random()}&display=page`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      fromLoginAuth: "false",
      interfaceVersion: "v3",
      origin: OAUTH_ORIGIN,
      referer: `${OAUTH_ORIGIN}/oauth2/v3/authorize?${query}`,
      "user-agent": ua,
    },
    body: query,
  });
  let casUrl = null;
  try {
    casUrl = JSON.parse(loginWay.body)?.loginInteractInfo?.cas?.casLoginRedirectUrl ?? null;
  } catch {
    casUrl = null;
  }
  if (typeof casUrl !== "string" || casUrl === "") {
    return { asked: themeName ?? "(未带)", loginWayStatus: loginWay.status, blocked: "no_cas_url" };
  }
  const cas = await request(casUrl, { headers: { "user-agent": ua } });
  const portalRaw = cas.location ? new URL(cas.location, casUrl).href : null;
  return {
    asked: themeName ?? "(未带)",
    loginWayStatus: loginWay.status,
    casRedirectThemeName: shapeOf(casUrl)?.themeName ?? null,
    casRedirectStatus: cas.status,
    portalThemeName: portalRaw === null ? null : shapeOf(portalRaw)?.themeName ?? null,
    portalPath: portalRaw === null ? null : shapeOf(portalRaw)?.path ?? null,
    portalRaw,
  };
}

console.log("官方登录页主题探针（只读公开页面；不登录、不输账号）\n");
console.log("== A. themeName 加在 authorize 上，能传播到门户页吗 ==");
const chains = [];
for (const themeName of [undefined, "dark", "huawei", "harmony", "harmonydark", "nonsense"]) {
  const result = await chain(themeName);
  chains.push({ ...result, portalRaw: undefined });
  console.log(
    `  asked=${String(result.asked).padEnd(14)} → remoteLogin=${String(result.casRedirectThemeName).padEnd(12)} portal=${String(
      result.portalThemeName,
    ).padEnd(10)} ${result.blocked ?? ""}`,
  );
}
report.chains = chains;

const portalSample = (await chain(undefined)).portalRaw;
if (typeof portalSample !== "string") {
  console.error("\n拿不到门户页地址：链路形状变了，后面的检查无法进行。");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...report, blocked: "cas_no_portal_location" }, null, 2));
  process.exit(1);
}
const portalUrl = new URL(portalSample);

// ---------------------------------------------------------------------------
// B. 服务端裁决：themeName × UA
// ---------------------------------------------------------------------------
async function baseSwitch(ua, themeName) {
  const answer = await request(
    `${CAS_ORIGIN}/CAS/IDM_W/ajaxHandler/common/getBaseSwitchInfo?reflushCode=${Math.random()}&cVersion=${CVERSION}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;", origin: CAS_ORIGIN, referer: portalUrl.href, "user-agent": ua },
      body: new URLSearchParams({ themeName, lang: "zh-cn", supportHarmonyTheme: "false" }).toString(),
    },
  );
  let json = null;
  try {
    json = JSON.parse(answer.body);
  } catch {
    json = null;
  }
  return { asked: themeName === "" ? "(空)" : themeName, status: answer.status, themeName: json?.themeName ?? null };
}

console.log("\n== B. 服务端 getBaseSwitchInfo 认哪些值（桌面 UA vs HarmonyOS UA）==");
const switchRows = [];
for (const [label, ua] of [
  ["桌面Chrome", CHROME_UA],
  ["HarmonyOS", HARMONY_UA],
]) {
  for (const themeName of ["", "red", "huawei", "blue", "lightred", "harmony", "dark", "harmonydark", "DARK", "nonsense"]) {
    const row = await baseSwitch(ua, themeName);
    switchRows.push({
      ua: label,
      ...row,
      clientWouldPickMobileLayout: MOBILE_LAYOUT_TOKENS.test(ua.toLowerCase()),
    });
    console.log(`  ua=${label.padEnd(12)} asked=${row.asked.padEnd(12)} → 服务端 themeName=${String(row.themeName).padEnd(12)}`);
  }
}
report.switchRows = switchRows;

// ---------------------------------------------------------------------------
// C. 落到页面上是什么样（headless Chromium）
// ---------------------------------------------------------------------------
report.renders = [];
if (skipBrowser) {
  console.log("\n== C. 跳过浏览器段（--no-browser）==");
} else {
  console.log("\n== C. 真浏览器里量一遍（计算样式 + 实际加载的主题 CSS）==");
  const { chromium } = await import("playwright-core");
  const { chromiumCandidates } = await import("./test-browser.mjs");

  let browser = null;
  for (const candidate of chromiumCandidates()) {
    const options = { headless: true, args: ["--no-sandbox"] };
    if (candidate.executablePath) options.executablePath = candidate.executablePath;
    if (candidate.channel) options.channel = candidate.channel;
    try {
      browser = await chromium.launch(options);
      report.browser = candidate.kind;
      break;
    } catch {
      browser = null;
    }
  }

  if (browser === null) {
    console.log("  没有可用浏览器（Chromium / Chrome / Edge 都起不来）：这一段跳过，A/B 两段的结果仍然有效");
  } else {
    for (const variant of [
      { label: "桌面UA+URL原样", ua: CHROME_UA, themeName: null, colorScheme: "light" },
      { label: "桌面UA+系统深色", ua: CHROME_UA, themeName: null, colorScheme: "dark" },
      { label: "HarmonyUA+themeName=dark", ua: HARMONY_UA, themeName: "dark", colorScheme: "light" },
    ]) {
      const url = new URL(portalUrl.href);
      if (variant.themeName === null) url.searchParams.delete("themeName");
      else url.searchParams.set("themeName", variant.themeName);

      const context = await browser.newContext({
        userAgent: variant.ua,
        colorScheme: variant.colorScheme,
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      const stylesheets = [];
      page.on("response", (response) => {
        if (response.request().resourceType() === "stylesheet") stylesheets.push(response.url().split("?")[0].split("/").pop());
      });
      await page.goto(url.href, { waitUntil: "load", timeout: TIMEOUT_MS }).catch(() => undefined);
      await page.waitForTimeout(2_500);
      const facts = await page
        .evaluate(() => {
          const background = (selector) => {
            const node = document.querySelector(selector);
            return node === null ? null : getComputedStyle(node).backgroundColor;
          };
          return {
            domConfigThemeName: window._hwidFrontEndConfig?.themeName ?? null,
            flowFilePath: window.flowFilePath ?? null,
            bodyAttrThemeName: document.body.getAttribute("hwid-themeName"),
            bodyBackground: background("body"),
            rootBackground: background(".hwid-root"),
            prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
            inputs: document.querySelectorAll("input").length,
          };
        })
        .catch((cause) => ({ error: String(cause).slice(0, 160) }));
      await context.close();
      report.renders.push({ ...variant, stylesheets, ...facts });
      console.log(
        `  ${variant.label.padEnd(26)} css=${stylesheets.filter((name) => name.startsWith("index-")).join(",") || "(无)"} bodyBg=${facts.bodyBackground} rootBg=${facts.rootBackground} flow=${facts.flowFilePath}`,
      );
    }
    await browser.close();
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n摘要已落 ${outPath}`);
