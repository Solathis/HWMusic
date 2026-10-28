#!/usr/bin/env node
/**
 * 音乐业务端点探针：**只请求外网公开资源**（不带账号凭据、不写 cookie、不读本地私密文件），三步全部可离线复现——
 * 1. 白名单 CDN 域可达性（校验 CSP/`safe-media-url.mjs` 里那三个后缀真的存在）；
 * 2. 公开入口页 → 脚本清单 → 从脚本正文里正则提取「像业务接口」的候选 URL（只留候选，不留正文）；
 * 3. 对候选做**无凭据**探测：401/403 = 端点存在但要授权，404 = 路径不对，2xx = 公开可读。
 * **端点未确认前 `src/protocols/music.mjs` 一律走注入式**，本脚本的候选清单只是探测输入，生产代码不得引用。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { extractApiCandidates, extractScriptSrcs, looksLikeApiUrl, redactUrl, summarizeResponse, verdictOf } from "./probe-lib.mjs";

/** CDN 白名单（与 CSP、safe-media-url.mjs 同源的三个后缀）。 */
const CDN_ORIGINS = ["https://www.dbankcdn.cn/", "https://www.tingmall.com/", "https://www.kuke.com/"];

/** 公开入口页（音乐业务线索来源；只读 HTML）。 */
const ENTRY_PAGES = ["https://music.huawei.com/", "https://www.huawei.com/cn/"];

/** 无凭据探测的候选接口主机（**候选**，不是结论；DNS/状态码本身就是证据）。 */
const API_HOST_CANDIDATES = [
  "https://api.music.huawei.com/",
  "https://music-api.huawei.com/",
  "https://msc.appmusic.huawei.com/",
];

const MAX_HOPS = 3;
const TIMEOUT_MS = 15_000;
const PAUSE_MS = 500;
const MAX_BYTES = 256 * 1024;
const USER_AGENT = "hwmusic-desktop-probe/0.0.1 (public-page reconnaissance; not a music client)";

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : ".probe/music-probe.json";
const scriptBudget = flagValue("--scripts", 4);
const candidateBudget = flagValue("--candidates", 12);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function request(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/javascript;q=0.9,*/*;q=0.1" },
    });
    let text = "";
    try {
      text = (await response.text()).slice(0, MAX_BYTES);
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

async function follow(url) {
  const hops = [];
  let current = url;
  for (let index = 0; index <= MAX_HOPS; index += 1) {
    const response = await request(current);
    hops.push({
      ...summarizeResponse({ ...response, url: current }),
      location: response.location ? redactUrl(response.location) : null,
      // 正文只在本次调用内使用，绝不进结果
      _body: response.body,
    });
    if (response.status !== null && response.status >= 300 && response.status < 400 && response.location) {
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
  return { hops, status: last?.status ?? null, verdict: verdictOf(last?.status ?? null), body: last?._body ?? "", finalUrl: last?.url ?? redactUrl(url) };
}

/** 结果里不许出现 `_body`（体积大且可能含无关内容）。 */
function publicEntry(entry) {
  const { _body, ...rest } = entry;
  void _body;
  return rest;
}

const results = [];
const apiCandidates = new Set();

async function probeUrl(label, purpose, url) {
  const outcome = await follow(url);
  const entry = {
    label,
    purpose,
    url: redactUrl(url),
    status: outcome.status,
    verdict: outcome.verdict,
    finalUrl: outcome.finalUrl,
    hops: outcome.hops.map(publicEntry),
  };
  results.push(entry);
  console.log(`${String(outcome.status ?? "ERR").padEnd(4)} ${outcome.verdict.padEnd(17)} ${label}`.trimEnd());
  await sleep(PAUSE_MS);
  return outcome;
}

console.log(`音乐业务端点探针：只读公开资源（脚本预算 ${scriptBudget}，候选预算 ${candidateBudget}）`);
console.log("不带任何账号凭据；响应只留摘要，不留正文。\n");

console.log("— ① CDN 白名单域可达性 —");
for (const origin of CDN_ORIGINS) {
  await probeUrl(`cdn ${new URL(origin).host}`, "校验 CSP/白名单里的 CDN 域真实可达", origin);
}

console.log("\n— ② 公开入口页 → 脚本 → API 候选 —");
const scriptUrls = [];
for (const page of ENTRY_PAGES) {
  const outcome = await probeUrl(`entry ${new URL(page).host}`, "公开入口页（读取 HTML 找脚本线索）", page);
  if (outcome.status === null) continue;
  for (const script of extractScriptSrcs(outcome.body, { baseUrl: page, limit: scriptBudget })) {
    if (!scriptUrls.includes(script)) scriptUrls.push(script);
  }
}
console.log(`   入口页发现脚本 ${scriptUrls.length} 个（最多取 ${scriptBudget} 个继续看）`);

let scannedScripts = 0;
for (const script of scriptUrls.slice(0, scriptBudget)) {
  const outcome = await probeUrl(`script ${new URL(script).pathname.split("/").pop() || script}`, "脚本正文里的接口线索", script);
  scannedScripts += 1;
  for (const candidate of extractApiCandidates(outcome.body, { limit: candidateBudget })) apiCandidates.add(candidate);
}
console.log(`   已看脚本 ${scannedScripts} 个，累计 API 候选 ${apiCandidates.size} 个`);

console.log("\n— ③ 候选接口主机无凭据探测（401/403 = 存在但要授权） —");
for (const host of API_HOST_CANDIDATES) {
  await probeUrl(`api-host ${new URL(host).host}`, "候选业务主机（未确认）", host);
}

const candidateReport = [];
for (const candidate of [...apiCandidates].slice(0, candidateBudget)) {
  if (!looksLikeApiUrl(candidate)) continue;
  const outcome = await follow(candidate);
  candidateReport.push({
    url: redactUrl(candidate),
    status: outcome.status,
    verdict: outcome.verdict,
    note: "无凭据探测；需授权才能确定语义",
  });
  console.log(`${String(outcome.status ?? "ERR").padEnd(4)} ${outcome.verdict.padEnd(17)} candidate ${redactUrl(candidate)}`);
  await sleep(PAUSE_MS);
}

const report = {
  tool: "scripts/probe-music.mjs",
  generatedAt: new Date().toISOString(),
  mode: "public-get-only",
  disclaimer: "只请求外网公开资源；不带任何账号凭据、不写 cookie；响应正文与敏感参数值不入结果。",
  cdnOrigins: CDN_ORIGINS,
  entryPages: ENTRY_PAGES,
  apiHostCandidates: API_HOST_CANDIDATES,
  scriptUrls,
  apiCandidates: [...apiCandidates],
  candidateProbes: candidateReport,
  results,
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n摘要已写入 ${outPath}（正文不入结果）。`);
