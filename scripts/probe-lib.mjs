/**
 * 探针公共设施（scripts/probe-*.mjs 共用）。
 *
 * 三条硬约束落在这里，不靠调用方自觉：
 * 1. **不落响应体**：`summarizeResponse` 只输出状态、长度、标题、哈希与命中标记，正文一概不进结果；
 * 2. **不落敏感参数**：`redactUrl` 把 code/token/session/ticket/password 之类的值一律打码为 `***`；
 * 3. 只认 http/https，其他 scheme 直接丢弃。
 *
 * 纯函数，可离线单测（test/probe-lib.test.mjs）。
 */
import { createHash } from "node:crypto";

/** 命中即打码的查询参数（大小写不敏感，做子串匹配）。 */
export const SENSITIVE_QUERY_PATTERNS = [
  "code",
  "state",
  "token",
  "session",
  "ticket",
  "password",
  "passwd",
  "secret",
  "sign",
  "hmac",
  "authorization",
  "cookie",
  "credential",
];

/** 打码后仍可见的参数（用于证明"这个端点认这些参数"）：非敏感项保持原样。 */
function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_QUERY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 把 URL 里敏感查询参数的值打码；其余保持原样。 */
export function redactUrl(raw) {
  const text = String(raw);
  const index = text.indexOf("?");
  if (index === -1) return text;
  const head = text.slice(0, index);
  const query = text.slice(index + 1).split("#", 1)[0];
  const parts = [];
  for (const [key, value] of new URLSearchParams(query)) {
    parts.push(`${encodeURIComponent(key)}=${isSensitiveKey(key) ? "***" : encodeURIComponent(value)}`);
  }
  return parts.length === 0 ? head : `${head}?${parts.join("&")}`;
}

/** 在公开页面里找这些标记，用来判断"这个页面是什么"。 */
export const BODY_MARKERS = [
  "oauth",
  "authorize",
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_grant",
  "unsupported_response_type",
  "loginCallback",
  "captcha",
  "verifycode",
  "扫码",
  "二维码",
  "qrcode",
  "登录",
];

function titleOf(text) {
  const match = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(text);
  return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 120) : null;
}

/**
 * 响应摘要：**绝不含正文**。正文只用来算长度/哈希/标题/命中标记。
 * @param {{url: string, status?: number|null, contentType?: string|null, body?: string, error?: string}} input
 */
export function summarizeResponse(input) {
  const text = typeof input.body === "string" ? input.body : "";
  return {
    url: redactUrl(input.url),
    status: input.status ?? null,
    contentType: input.contentType ?? null,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256_16: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16),
    title: titleOf(text),
    markers: BODY_MARKERS.filter((marker) => text.includes(marker)),
    error: input.error ?? null,
  };
}

/** 绝对 http(s) URL 抽取（去重、限量、去掉引号与尾随标点）。 */
export function extractAbsoluteUrls(text, options = {}) {
  const limit = options.limit ?? 40;
  const found = new Set();
  for (const match of String(text).matchAll(/https?:\/\/[^\s"'`<>()\\]+/gi)) {
    const cleaned = match[0].replace(/[.,;:]+$/, "");
    found.add(cleaned);
    if (found.size >= limit) break;
  }
  return [...found];
}

/** 入口页里的脚本地址（相对路径解析成绝对；去重限量）。 */
export function extractScriptSrcs(html, options = {}) {
  const limit = options.limit ?? 10;
  const base = options.baseUrl ?? "https://example.invalid/";
  const found = new Set();
  for (const match of String(html).matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      found.add(new URL(match[1], base).href);
    } catch {
      // 解析不了的相对路径直接跳过
    }
    if (found.size >= limit) break;
  }
  return [...found];
}

/** 像业务接口的 URL 才算候选（避免把静态资源/字体也当端点）。 */
export function looksLikeApiUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return /(api|music|song|playlist|favorite|user|account|search|album|artist|lyric|play)/i.test(
      `${parsed.hostname}${parsed.pathname}`,
    );
  } catch {
    return false;
  }
}

/**
 * 从 JS/HTML 正文里抽"端点路径"字符串（例如 `/oauth2/v3/authorize`）。
 * 返回去重后的 `{path, evidence}`：evidence 是出现处的原文片段（截断），便于人工判断。
 */
export function extractEndpointPaths(text, options = {}) {
  const limit = options.limit ?? 40;
  const pattern = options.pattern ?? /\/(?:oauth2|api|ajax|music)\/[A-Za-z0-9/_.-]{2,80}/g;
  const found = new Map();
  for (const match of String(text).matchAll(pattern)) {
    const path = match[0].replace(/[.,;:'"`)]+$/, "");
    if (!found.has(path)) found.set(path, match[0].slice(0, 120));
    if (found.size >= limit) break;
  }
  return [...found.entries()].map(([path, evidence]) => ({ path, evidence }));
}

/**
 * 小 JSON 错误响应里的标准错误码：只取 `error`（字符串或数字）与 `sub_error`，
 * **不取 `error_description`**（那是自由文本，可能回显调用方参数）。
 * @returns {{code: string, subCode: string|null} | null}
 */
export function errorInfoFromBody(body, contentType) {
  if (typeof body !== "string" || body === "" || body.length > 1024) return null;
  if (!/json/i.test(String(contentType ?? ""))) return null;
  try {
    const parsed = JSON.parse(body);
    const raw = parsed?.error ?? parsed?.error_code;
    const code =
      typeof raw === "string" && raw !== "" ? raw.slice(0, 64) : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
    if (code === null) return null;
    const rawSub = parsed?.sub_error;
    const subCode =
      typeof rawSub === "string" && rawSub !== ""
        ? rawSub.slice(0, 32)
        : typeof rawSub === "number" && Number.isFinite(rawSub)
          ? String(rawSub)
          : null;
    return { code, subCode };
  } catch {
    return null;
  }
}

/** 从正文里挑出业务接口候选（公开页面里抄来的线索，仅用于探测）。 */
export function extractApiCandidates(text, options = {}) {
  return extractAbsoluteUrls(text, { limit: options.limit ?? 60 }).filter(looksLikeApiUrl).slice(0, options.limit ?? 20);
}

/** 判定端点存在性：401/403 = 存在但要授权；404/410 = 路径不对。 */
export function verdictOf(status) {
  if (status === null || status === undefined) return "unreachable";
  if (status === 404 || status === 410) return "not_found";
  if (status === 401 || status === 403) return "exists_needs_auth";
  if (status === 405) return "exists_wrong_method";
  if (status >= 200 && status < 300) return "reachable";
  if (status >= 300 && status < 400) return "redirect";
  return "exists_other";
}
