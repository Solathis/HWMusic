/**
 * 媒体 URL 安全（渲染层 img/audio 的唯一放行口）。
 *
 * 规则：`https` + CDN 后缀白名单（后缀边界必须是点，`evil-dbankcdn.cn` 不放行）+ 无 userinfo + 无显式端口。
 * 放行列表与 `src-tauri/tauri.conf.json` 的 CSP `img-src`/`media-src` 同源，
 * 一致性由 `test/safe-media-url.test.mjs` 解析 CSP 行钉死——改这里就必须同步改 CSP。
 *
 * 契约：**任何输入都不抛异常**，不合格一律 `null`。渲染层拿不到"半可信"的 URL。
 */

/** CDN 后缀白名单（与 CSP 同源）。 */
export const MEDIA_URL_HOST_SUFFIXES = ["dbankcdn.cn", "tingmall.com", "kuke.com"];

/** 只接受 https：CSP 里没有 http 源，降级到明文传输等于自己拆掉一层保护。 */
export const MEDIA_URL_ALLOWED_PROTOCOLS = ["https:"];

/** 拒绝原因（排障用；渲染层只关心 ok/url）。 */
export const MEDIA_URL_REASONS = {
  notAString: "not_a_string",
  empty: "empty",
  unparsable: "unparsable",
  scheme: "scheme",
  userinfo: "userinfo",
  port: "port",
  hostNotAllowed: "host_not_allowed",
};

/** 取 URL 的 authority（`https://` 之后、第一个 `/?#` 之前的那段）。 */
function authorityOf(raw) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
  return match ? match[1] : null;
}

/** 后缀匹配必须是"域名边界"匹配：host === 后缀，或 host 以 `.后缀` 结尾。 */
function matchSuffix(host) {
  return MEDIA_URL_HOST_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ?? null;
}

/**
 * 校验并归一化媒体 URL。
 * @returns {{ok: true, url: string, host: string, suffix: string} | {ok: false, reason: string}}
 */
export function parseSafeMediaUrl(value) {
  if (typeof value !== "string") return { ok: false, reason: MEDIA_URL_REASONS.notAString };
  const raw = value.trim();
  if (raw === "") return { ok: false, reason: MEDIA_URL_REASONS.empty };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: MEDIA_URL_REASONS.unparsable };
  }

  if (!MEDIA_URL_ALLOWED_PROTOCOLS.includes(url.protocol)) return { ok: false, reason: MEDIA_URL_REASONS.scheme };

  // 显式端口要在原始串上判：URL 会把 :443 归一化掉，只看 url.port 会漏掉它
  const authority = authorityOf(raw);
  if (authority === null) return { ok: false, reason: MEDIA_URL_REASONS.unparsable };
  if (authority.includes("@")) return { ok: false, reason: MEDIA_URL_REASONS.userinfo };
  if (authority.includes(":")) return { ok: false, reason: MEDIA_URL_REASONS.port };

  const host = url.hostname.toLowerCase();
  const suffix = matchSuffix(host);
  if (suffix === null) return { ok: false, reason: MEDIA_URL_REASONS.hostNotAllowed };

  return { ok: true, url: url.href, host, suffix };
}

/** @returns {string | null} 放行的归一化 URL；不合格返回 null。 */
export function safeMediaUrl(value) {
  const parsed = parseSafeMediaUrl(value);
  return parsed.ok ? parsed.url : null;
}

export function isSafeMediaUrl(value) {
  return parseSafeMediaUrl(value).ok;
}
