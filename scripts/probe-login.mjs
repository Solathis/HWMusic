#!/usr/bin/env node
/**
 * 登录链路探针：**只请求外网公开页面**（不登录、不提交凭据、不写 cookie、不带私人数据），结论写入 docs/API_CONTRACT.md。
 * 目的：把 authorize / token / loginCallback 的确切 URL 与跳转链确定下来（只落摘要，不落响应正文）。
 * 用法：`node scripts/probe-login.mjs` 只做 GET；`--include-token-probe` 追加 POST 一个**无效**授权码
 * （`code=PROBE-INVALID-CODE`），只期望 `invalid_grant`/`invalid_request` 这类标准错误码，不涉及任何账号。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  errorInfoFromBody,
  extractEndpointPaths,
  extractScriptSrcs,
  redactUrl,
  summarizeResponse,
  verdictOf,
} from "./probe-lib.mjs";

/** 协议常量（client_id 是公开标识符，不是凭据）。 */
const CLIENT_ID = "101444301";
const REDIRECT_URI = "hms://redirect_uri";
const SCOPE = "openid";
const ACCESS_TYPE = "offline";
/** 固定的哑元 challenge（43 字符 base64url）：探针不需要真正的 PKCE 对，也绝不产生可用凭据。 */
const DUMMY_CODE_CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROBE_CODE = "PROBE-INVALID-CODE";

/** 候选端点：**探针专用**，生产代码不得引用（src/protocols 里没有任何端点字面量）。 */
const AUTHORIZE_CANDIDATES = [
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize",
  "https://oauth-login1.cloud.huawei.com/oauth2/v2/authorize",
];
const TOKEN_CANDIDATES = [
  "https://oauth-login1.cloud.huawei.com/oauth2/v3/token",
  "https://oauth-login1.cloud.huawei.com/oauth2/v6/token",
];
const CALLBACK_CANDIDATES = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"];
/** CAS 系登录域（导航白名单里的条目，探针只做可达性确认）。 */
const CAS_CANDIDATES = ["https://login.cloud.huawei.com/"];

const MAX_HOPS = 5;
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 500;
/** 只读前 64KiB 做摘要：公开登录页足够，避免把整个 bundle 拖下来。 */
const MAX_BYTES = 64 * 1024;
/** bundle 扫描阶段要读到端点字符串，页面 bundle 通常几百 KB（上限 4MiB 防跑飞）。 */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;

const USER_AGENT = "hwmusic-desktop-probe/0.0.1 (public-page reconnaissance; not a music client)";

const args = new Set(process.argv.slice(2));
const includeTokenProbe = args.has("--include-token-probe");
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? ".probe/login-probe.json" : process.argv[outIndex + 1];
const scriptBudget = (() => {
  const index = process.argv.indexOf("--scripts");
  const value = index === -1 ? 3 : Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : 3;
})();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 单次请求：只读有限字节，返回响应头与截断后的正文（正文只用于摘要，不进结果）。 */
async function request(url, { method = "GET", body, maxBytes = MAX_BYTES } = {}) {
  const init = {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.1" },
  };
  if (body !== undefined) {
    init.body = body;
    init.headers["content-type"] = "application/x-www-form-urlencoded";
  }

  try {
    const response = await fetch(url, init);
    let text = "";
    try {
      const raw = await response.text();
      text = raw.slice(0, maxBytes);
    } catch {
      text = "";
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      body: text,
      error: null,
    };
  } catch (cause) {
    const code = cause?.cause?.code ?? cause?.code ?? cause?.name ?? "unknown";
    return { status: null, contentType: null, location: null, body: "", error: String(code).slice(0, 80) };
  }
}

/** 手工跟跳转链（`redirect: "manual"`），每一跳都留摘要——链本身就是结论。 */
async function follow(url, options = {}) {
  const hops = [];
  let current = url;
  for (let index = 0; index <= MAX_HOPS; index += 1) {
    const response = await request(current, options);
    hops.push({
      ...summarizeResponse({ ...response, url: current }),
      location: response.location ? redactUrl(response.location) : null,
      errorInfo: errorInfoFromBody(response.body, response.contentType),
      // 正文只在本次探测内用于摘要/线索提取，绝不进结果
      _body: response.body,
      _truncated: response.body.length >= (options.maxBytes ?? MAX_BYTES),
    });
    if (response.status === null) break;
    if (response.status >= 300 && response.status < 400 && response.location) {
      try {
        current = new URL(response.location, current).href;
      } catch {
        break;
      }
      await sleep(PAUSE_MS);
      continue;
    }
    break;
  }
  const last = hops.at(-1) ?? null;
  return {
    hops,
    finalUrl: last?.url ?? redactUrl(url),
    status: last?.status ?? null,
    verdict: verdictOf(last?.status ?? null),
    body: last?._body ?? "",
  };
}

/** 结果里不许出现 `_body`（体积大，且没必要留）与内部标记。 */
function publicHop(hop) {
  const { _body, _truncated, ...rest } = hop;
  void _body;
  void _truncated;
  return rest;
}

function buildAuthorizeUrl(endpoint) {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", ACCESS_TYPE);
  url.searchParams.set("code_challenge", DUMMY_CODE_CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "probe-state");
  return url.href;
}

function buildTokenBody(endpoint, code) {
  void endpoint;
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: DUMMY_CODE_CHALLENGE,
    redirect_uri: REDIRECT_URI,
  }).toString();
}

const results = [];

async function probe(label, purpose, url, options) {
  const outcome = await follow(url, options);
  const last = outcome.hops.at(-1) ?? null;
  const entry = {
    label,
    purpose,
    request: { method: options?.method ?? "GET", url: redactUrl(url) },
    status: outcome.status,
    verdict: outcome.verdict,
    finalUrl: outcome.finalUrl,
    errorInfo: last?.errorInfo ?? null,
    hops: outcome.hops.map(publicHop),
    /** 仅本次探测内使用（抽线索 / 记录脚本地址），写盘前剔除 */
    _body: outcome.body,
  };
  results.push(entry);
  const title = last?.title ?? "";
  const errorText = entry.errorInfo ? ` [error=${entry.errorInfo.code}${entry.errorInfo.subCode ? ` sub=${entry.errorInfo.subCode}` : ""}]` : "";
  console.log(
    `${String(outcome.status ?? "ERR").padEnd(4)} ${outcome.verdict.padEnd(17)} ${label.padEnd(38)} ${title}${errorText}`.trimEnd(),
  );
  await sleep(PAUSE_MS);
  return entry;
}

console.log(`登录链路探针：只读公开页面（${includeTokenProbe ? "含无效授权码 POST" : "仅 GET"}）`);
console.log("不生成本次登录的任何可用凭据；所有响应只留摘要，不留正文。\n");

for (const endpoint of AUTHORIZE_CANDIDATES) {
  await probe(`authorize ${new URL(endpoint).pathname}`, "确认授权页端点与协议参数是否被受理", buildAuthorizeUrl(endpoint));
}

for (const endpoint of CALLBACK_CANDIDATES) {
  await probe(`loginCallback ${new URL(endpoint).pathname}`, "确认回调落点存在（导航白名单精确例外）", endpoint);
}

for (const endpoint of CAS_CANDIDATES) {
  await probe(`CAS ${new URL(endpoint).origin}`, "确认 CAS 登录域可达", endpoint);
}

if (includeTokenProbe) {
  for (const endpoint of TOKEN_CANDIDATES) {
    await probe(
      `token ${new URL(endpoint).pathname}`,
      "用无效授权码探测 token 端点（预期 invalid_grant；无账号参与）",
      endpoint,
      { method: "POST", body: buildTokenBody(endpoint, PROBE_CODE) },
    );
  }
} else {
  for (const endpoint of TOKEN_CANDIDATES) {
    await probe(`token GET-probe ${new URL(endpoint).pathname}`, "未开 --include-token-probe：只做 GET 探路径", endpoint);
  }
}

/**
 * ③ 页面 bundle 扫描：授权页是 SPA，GET 拿到的 HTML 对任何路径都是同一份（catch-all），
 * 因此真正的端点字符串只在它的 JS 里。这里只提取"像端点路径"的字符串与出处片段，不留正文。
 */
const bundleEndpoints = [];
const scannedScripts = [];
const authorizePage = results.find((entry) => entry.label.startsWith("authorize /oauth2/v3/authorize"));
if (authorizePage) {
  const scripts = extractScriptSrcs(authorizePage._body, { baseUrl: buildAuthorizeUrl(AUTHORIZE_CANDIDATES[0]), limit: scriptBudget });
  console.log(`\n— ③ 授权页 bundle 扫描（脚本预算 ${scriptBudget}） —`);
  for (const script of scripts) {
    const outcome = await follow(script, { maxBytes: MAX_SCRIPT_BYTES });
    scannedScripts.push({ url: redactUrl(script), status: outcome.status, bytes: outcome.hops.at(-1)?.bytes ?? 0 });
    console.log(`${String(outcome.status ?? "ERR").padEnd(4)} ${String(outcome.hops.at(-1)?.bytes ?? 0).padStart(8)} B  ${redactUrl(script)}`);
    for (const found of extractEndpointPaths(outcome.body, { limit: 60 })) {
      if (!bundleEndpoints.some((item) => item.path === found.path)) bundleEndpoints.push({ ...found, script: redactUrl(script) });
    }
    await sleep(PAUSE_MS);
  }
  console.log(`   发现端点路径 ${bundleEndpoints.length} 条（明细在 JSON 里）`);
}

/** 顺带记录跳转链里出现过的域（只作线索，不作结论）。 */
const observedHosts = [...new Set(results.flatMap((entry) => entry.hops.map((hop) => {
  try {
    return new URL(hop.url).origin;
  } catch {
    return null;
  }
}).filter(Boolean)))];

const report = {
  tool: "scripts/probe-login.mjs",
  generatedAt: new Date().toISOString(),
  mode: includeTokenProbe ? "public-get + invalid-code-post" : "public-get-only",
  disclaimer: "只请求外网公开页面；不登录任何账号、不读取任何私人凭据；响应正文不入结果（只留长度/哈希/标记）。",
  protocol: {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    accessType: ACCESS_TYPE,
    codeChallengeMethod: "S256",
  },
  observedHosts,
  scannedScripts,
  bundleEndpoints,
  results: results.map((entry) => {
    const { _body, ...rest } = entry;
    void _body;
    return rest;
  }),
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n摘要已写入 ${outPath}（正文与敏感参数值不入结果）。`);
