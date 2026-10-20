#!/usr/bin/env node
/**
 * R27 探针：登录 webview 换 **HarmonyOS 移动 UA** 这条路，全链与页面形态到底长什么样。
 *
 * 背景（R26 遗留）：桌面 UA 下服务端 `getBaseSwitchInfo` 只放 {red, huawei, blue, lightred}，
 * `dark` 一律回落 `red` —— "深色档看不到深色官方页"是服务端边界。R26 探针同时实测到
 * **唯一一条能拿到深色的路是 HarmonyOS 移动 UA**（`.probe/r26-theme-render.json` 的 C 行：
 * `index-dark.css` + body/root 背景 `rgb(0,0,0)`），代价是页面按 `isMobileWap()` 换成移动版式。
 * 控制器 R27 裁决：登录 webview 就采用移动 UA。
 *
 * 于是本探针回答四个问题（结论登记在 `docs/API_CONTRACT.md` §1.7 的 R27 段）：
 *
 *  A. **全链**：移动 UA 下 authorize 链的每一跳与桌面 UA 有什么差异？经过的主机有没有
 *     落在现有导航白名单（`login::LOGIN_ALLOWED_ORIGINS`）**之外**的？（白名单漏一个域
 *     就是 R16 那类"登录页停在空壳上"。）
 *  B. **服务端裁决**：移动 UA 下 `getBaseSwitchInfo` 认哪些 `themeName`？浅色档该挂哪个值
 *     （R26 的"浅色档不挂参数"在移动 UA 下站不住：不带参数时页面会拿 prefers-color-scheme
 *     去问服务端，系统深色就会变黑）。
 *  C. **黑底复测**：真 Chromium 里量计算样式，确认哪个值给出 `#000` 真黑底。
 *  D. **页面形态**：移动版登录页有哪些输入、有没有二维码入口（决定"用户在窗里能做什么"）。
 *
 * **只碰公开页面与公开接口**：不登录、不输账号、不提交凭据、不扫码；`state` 与
 * `code_challenge` 都是探针自己的一次性/占位串，因此拿不到任何可用凭据。
 *
 * 用法：
 *   node scripts/probe-login-mobile-ua.mjs                # 全部四段
 *   node scripts/probe-login-mobile-ua.mjs --no-browser   # 只跑 A/B（不起浏览器）
 *   node scripts/probe-login-mobile-ua.mjs --out .probe/xxx.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 桌面基线（R26 那一份，用来对比"链路哪几跳变了"）。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 移动 UA 候选。
 *
 * 第一条是 R26 实测出 `#000` 的那一条（`r26-theme-render.json` 的 `harmony`），也是
 * 本任务打算落进 `login::LOGIN_MOBILE_UA` 的那一条；其余几条用来确认"是不是只有它行"
 * （选型要的是"服务端认深色 + 版式可用"，不是碰巧某一条能跑）。
 */
const MOBILE_UA_CANDIDATES = {
  /** `Mozilla/5.0 (Phone; HarmonyOS 4.0) … Mobile Safari/537.36`（R26 实测出黑底的那一条） */
  harmonyPhone:
    "Mozilla/5.0 (Phone; HarmonyOS 4.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  /** 华为浏览器移动版（同一个 HarmonyOS 家族，带 HuaweiBrowser 标识） */
  huaweiBrowserMobile:
    "Mozilla/5.0 (Linux; HarmonyOS 4.0; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.0.0 Mobile Safari/537.36 HuaweiBrowser/14.0.3.312",
  /** hwid_clienttype=hmos：页面自己的 `isMobileWap()` 认这个 token */
  hwidHmos:
    "Mozilla/5.0 (Linux; HarmonyOS 4.0; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 hwid_clienttype=hmos",
  /** 纯 Android Chrome 移动版（对照组：确认"黑"是 HarmonyOS 家族的特征而不是任意移动 UA） */
  androidChrome:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
};

/** 默认落进实现的候选（见 [`MOBILE_UA_CANDIDATES`]）。 */
const MOBILE_UA = MOBILE_UA_CANDIDATES.harmonyPhone;

const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OAUTH_ORIGIN = "https://oauth-login1.cloud.huawei.com";
const CAS_ORIGIN = "https://id1.cloud.huawei.com";
const CVERSION = "UP_CAS_6.26.3.100";
const TIMEOUT_MS = 25_000;

/** 现有导航白名单（`login::LOGIN_ALLOWED_ORIGINS` 的镜像：只用于**对比**，判定不在这里）。 */
const ALLOWED_ORIGINS = [
  "https://oauth-login1.cloud.huawei.com",
  "https://id1.cloud.huawei.com",
  "https://login.cloud.huawei.com",
];

/** 页面自己的移动版式闸门（`_utils.isMobileWap()`，逐字来自页面 bundle）。 */
const MOBILE_LAYOUT_TOKENS = /android|mobile|iphone|ipad|hwid_clienttype=hmos|tablet/i;

/** `themeName` 取值矩阵：未知值也问一遍（服务端的回落方向是选型依据）。 */
const THEME_VALUES = ["", "red", "huawei", "blue", "lightred", "harmony", "dark", "harmonydark", "nonsense"];

const args = new Set(process.argv.slice(2));
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/r27-mobile-ua-probe.json" : process.argv[outIndex + 1];
const skipBrowser = args.has("--no-browser");

async function request(url, init = {}) {
  try {
    const response = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    return { status: response.status, location: response.headers.get("location"), body, error: null };
  } catch (cause) {
    return {
      status: null,
      location: null,
      body: "",
      error: String(cause?.cause?.code ?? cause?.name ?? cause).slice(0, 80),
    };
  }
}

/** 只记形状（origin + path + 查询参数名 + 公开主题名）：凭据值一律不进结果。 */
function shapeOf(raw) {
  try {
    const url = new URL(String(raw));
    return {
      origin: url.origin,
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())].sort(),
      themeName: url.searchParams.get("themeName"),
      inWhitelist: ALLOWED_ORIGINS.includes(url.origin),
    };
  } catch {
    return null;
  }
}

/** 授权页查询串（与 R26 探针同一份：只到公开页面为止）。 */
function authorizeQuery(state) {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    access_type: "offline",
    code_challenge: DUMMY_CODE_CHALLENGE,
    code_challenge_method: "S256",
    state,
    display: "page",
    lang: "zh-cn",
    prompt: "login",
  }).toString();
}

/**
 * A. 走一遍授权链，记录每一跳（与 `scripts/probe-login-theme.mjs` 的 chain 同款，
 * 区别是**按 UA 参数化**并且把每一跳的 origin 都过一遍白名单对照）。
 */
async function chain(ua, label) {
  const query = authorizeQuery(`r27-${label}`);
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
    return { label, loginWayStatus: loginWay.status, blocked: "no_cas_url", loginWayError: loginWay.error };
  }

  const cas = await request(casUrl, { headers: { "user-agent": ua } });
  const portalRaw = cas.location ? new URL(cas.location, casUrl).href : null;
  const hosts = [shapeOf(casUrl)?.origin, portalRaw === null ? null : shapeOf(portalRaw)?.origin].filter(
    (origin) => typeof origin === "string",
  );

  return {
    label,
    loginWayStatus: loginWay.status,
    step1CasRedirect: shapeOf(casUrl),
    casStatus: cas.status,
    step2Portal: portalRaw === null ? null : shapeOf(portalRaw),
    /** 这条链经过的主机是不是都在现有白名单里（漏一个 = 登录页会停在空壳上） */
    hostsOutsideWhitelist: [...new Set(hosts.filter((origin) => !ALLOWED_ORIGINS.includes(origin)))],
  };
}

/** B. 服务端裁决：这个 UA 下，问这个 `themeName` 会拿回什么。 */
async function baseSwitch(ua, themeName) {
  const answer = await request(
    `${CAS_ORIGIN}/CAS/IDM_W/ajaxHandler/common/getBaseSwitchInfo?reflushCode=${Math.random()}&cVersion=${CVERSION}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;",
        origin: CAS_ORIGIN,
        "user-agent": ua,
      },
      body: new URLSearchParams({ themeName, lang: "zh-cn", supportHarmonyTheme: "false" }).toString(),
    },
  );
  let json = null;
  try {
    json = JSON.parse(answer.body);
  } catch {
    json = null;
  }
  return {
    asked: themeName === "" ? "(空)" : themeName,
    status: answer.status,
    themeName: json?.themeName ?? null,
    wiseContentCluster: json?.wiseContentCluster ?? null,
  };
}

const report = {
  tool: "probe-login-mobile-ua",
  generatedAt: new Date().toISOString(),
  disclaimer: "只读公开页面与公开接口（headless Chromium）；不登录、不输账号、不提交凭据、不扫码",
  desktopUa: DESKTOP_UA,
  mobileUa: MOBILE_UA,
  mobileUaCandidates: Object.values(MOBILE_UA_CANDIDATES),
  mobileLayoutTokens: String(MOBILE_LAYOUT_TOKENS),
  allowedOriginsMirror: ALLOWED_ORIGINS,
};

console.log("R27 探针：登录 webview 的移动 UA（只读公开页面；不登录、不输账号）\n");

// ---------------------------------------------------------------------------
// A. 全链：桌面 UA vs 移动 UA，每一跳与白名单对照
// ---------------------------------------------------------------------------
console.log("== A. 授权链每一跳（桌面 UA 对照）==");
report.chains = [];
for (const [label, ua] of [
  ["desktop", DESKTOP_UA],
  ["mobile", MOBILE_UA],
  ...Object.entries(MOBILE_UA_CANDIDATES).filter(([, value]) => value !== MOBILE_UA),
]) {
  const row = await chain(ua, label);
  report.chains.push({ ua: label, ...row });
  const portal = row.step2Portal;
  console.log(
    `  ua=${label.padEnd(20)} getLoginWay=${row.loginWayStatus} → CAS(${row.step1CasRedirect?.path ?? "?"}) → ${portal?.path ?? "(无 302)"} themeName=${portal?.themeName ?? "-"} 白名单外主机=${JSON.stringify(row.hostsOutsideWhitelist ?? [])}`,
  );
}

// ---------------------------------------------------------------------------
// B. 服务端裁决：themeName × UA
// ---------------------------------------------------------------------------
console.log("\n== B. 服务端 getBaseSwitchInfo 认哪些值（桌面 UA 对照 + 全部移动候选）==");
report.switchRows = [];
for (const [label, ua] of [
  ["desktop", DESKTOP_UA],
  ...Object.entries(MOBILE_UA_CANDIDATES).map(([key, value]) => [
    key === "harmonyPhone" ? "mobile" : key,
    value,
  ]),
]) {
  for (const themeName of THEME_VALUES) {
    const row = await baseSwitch(ua, themeName);
    report.switchRows.push({
      ua: label,
      ...row,
      clientWouldPickMobileLayout: MOBILE_LAYOUT_TOKENS.test(ua.toLowerCase()),
    });
    console.log(
      `  ua=${label.padEnd(8)} asked=${row.asked.padEnd(12)} → 服务端 themeName=${String(row.themeName).padEnd(12)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// C/D. 真浏览器：黑底复测 + 页面形态
// ---------------------------------------------------------------------------
report.renders = [];
if (skipBrowser) {
  console.log("\n== C/D. 跳过浏览器段（--no-browser）==");
} else {
  console.log("\n== C/D. 真浏览器里量一遍（计算样式 + 实际加载的主题 CSS + 页面形态）==");
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
    /** 一次渲染：量计算样式 + 页面形态（DOM，不读任何用户输入）。 */
    async function render({ label, ua, themeName, colorScheme, viewport, portal }) {
      const url = new URL(portal);
      if (themeName === null) url.searchParams.delete("themeName");
      else url.searchParams.set("themeName", themeName);

      const context = await browser.newContext({ userAgent: ua, colorScheme, viewport });
      const page = await context.newPage();
      const stylesheets = [];
      page.on("response", (response) => {
        if (response.request().resourceType() === "stylesheet") {
          stylesheets.push(response.url().split("?")[0].split("/").pop());
        }
      });
      let error = null;
      try {
        await page.goto(url.href, { waitUntil: "load", timeout: TIMEOUT_MS });
        await page.waitForTimeout(2_500);
      } catch (cause) {
        error = String(cause).slice(0, 120);
      }
      const facts = await page
        .evaluate(() => {
          const css = (selector) => {
            const node = document.querySelector(selector);
            if (node === null) return null;
            const style = getComputedStyle(node);
            return { backgroundColor: style.backgroundColor, color: style.color };
          };
          const text = document.body === null ? "" : document.body.innerText.slice(0, 400);
          const qrMarkers = ["二维码", "扫一扫", "qrcode", "扫码"].filter(
            (marker) => text.includes(marker) || document.body.innerHTML.includes(marker),
          );
          return {
            title: document.title,
            domConfigThemeName: window._hwidFrontEndConfig?.themeName ?? null,
            flowFilePath: window.flowFilePath ?? null,
            bodyAttr: document.body.getAttribute("hwid-themeName"),
            html: css("html"),
            body: css("body"),
            root: css(".hwid-root"),
            inputs: [...document.querySelectorAll("input")].map((node) => ({
              type: node.getAttribute("type"),
              name: node.getAttribute("name"),
              placeholder: node.getAttribute("placeholder"),
            })),
            buttons: [...document.querySelectorAll("button, a")].map((node) => node.innerText.trim()).filter((t) => t !== "").slice(0, 12),
            canvases: document.querySelectorAll("canvas").length,
            images: document.querySelectorAll("img").length,
            qrMarkers,
            textSample: text.replace(/\s+/g, " ").slice(0, 200),
          };
        })
        .catch((cause) => ({ error: String(cause).slice(0, 160) }));
      const shot = `.tmp/r27-shots/${label.replace(/[^\w]+/g, "_")}.png`;
      await page.screenshot({ path: shot }).catch(() => undefined);
      await context.close();
      return {
        label,
        ua: ua === MOBILE_UA ? "mobile" : "other",
        themeName: themeName ?? "(移除)",
        colorScheme,
        viewport: `${viewport.width}x${viewport.height}`,
        stylesheets,
        shot,
        ...facts,
        error,
      };
    }

    /** 用**移动 UA 自己**跑出来的门户页做基线：先把链走一遍再渲染。 */
    const mobilePortal = (() => {
      const row = report.chains.find((entry) => entry.ua === "mobile");
      return row?.step2Portal ?? null;
    })();

    if (mobilePortal === null) {
      console.log("  移动 UA 那条链没拿到门户页地址：这一段跳过");
    } else {
      const baseUrl = new URL(`${mobilePortal.origin}${mobilePortal.path}`);
      // 门户页认得的那几个参数（与真链一致的最小集）
      baseUrl.searchParams.set("reqClientType", "90");
      baseUrl.searchParams.set("loginChannel", "90000300");
      baseUrl.searchParams.set("lang", "zh-cn");

      const variants = [
        { label: "移动UA+无参数+系统浅色", ua: MOBILE_UA, themeName: null, colorScheme: "light" },
        { label: "移动UA+无参数+系统深色", ua: MOBILE_UA, themeName: null, colorScheme: "dark" },
        { label: "移动UA+dark", ua: MOBILE_UA, themeName: "dark", colorScheme: "light" },
        { label: "移动UA+harmonydark", ua: MOBILE_UA, themeName: "harmonydark", colorScheme: "light" },
        { label: "移动UA+harmony", ua: MOBILE_UA, themeName: "harmony", colorScheme: "light" },
        { label: "移动UA+huawei", ua: MOBILE_UA, themeName: "huawei", colorScheme: "light" },
        { label: "移动UA+red", ua: MOBILE_UA, themeName: "red", colorScheme: "light" },
        { label: "移动UA+乱写", ua: MOBILE_UA, themeName: "nonsense", colorScheme: "light" },
        { label: "桌面UA+dark（对照）", ua: DESKTOP_UA, themeName: "dark", colorScheme: "light" },
      ];

      for (const variant of variants) {
        const facts = await render({
          ...variant,
          viewport: { width: 1280, height: 752 },
          portal: baseUrl.href,
        });
        report.renders.push(facts);
        console.log(
          `  ${facts.label.padEnd(26)} css=${(facts.stylesheets ?? []).filter((n) => n.startsWith("index-")).join(",") || "(无)"} bodyBg=${facts.body?.backgroundColor ?? "?"} rootBg=${facts.root?.backgroundColor ?? "?"} flow=${facts.flowFilePath ?? "?"} inputs=${facts.inputs?.length ?? "?"} 二维码标记=${JSON.stringify(facts.qrMarkers ?? [])}`,
        );
        if (facts.error) console.log(`      error=${facts.error}`);
      }

      // 手机尺寸再量一次：窗在桌面上是宽矩形，移动版式在里面长什么样（观感参考）
      const phone = await render({
        label: "移动UA+dark+手机尺寸",
        ua: MOBILE_UA,
        themeName: "dark",
        colorScheme: "light",
        viewport: { width: 390, height: 844 },
        portal: baseUrl.href,
      });
      report.renders.push(phone);
      console.log(
        `  ${phone.label.padEnd(26)} bodyBg=${phone.body?.backgroundColor ?? "?"} inputs=${phone.inputs?.length ?? "?"} 按钮=${JSON.stringify((phone.buttons ?? []).slice(0, 6))}`,
      );
    }
    await browser.close();
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n摘要已落 ${outPath}`);
