/**
 * 媒体 URL 安全（渲染层 img/audio 的唯一放行口）。
 *
 * 规则：`https` + CDN 后缀白名单（后缀边界必须是点，`evil-dbankcdn.cn` 不放行）+ 无 userinfo + 无显式端口。
 * 放行列表与 `src-tauri/tauri.conf.json` 的 CSP `img-src`/`media-src` 同源，
 * 一致性由 `test/safe-media-url.test.mjs` 解析 CSP 行钉死——改这里就必须同步改 CSP。
 *
 * R65：多一档**本地曲库协议**（`LOCAL_MEDIA_SCHEME`）。它与 CDN 那一档是两条互不相交的路：
 * 本地协议只认"两种路径形状 + 32 位十六进制 id"，没有后缀白名单这回事（见 `parseLocalMediaUrl`）。
 *
 * 契约：**任何输入都不抛异常**，不合格一律 `null`。渲染层拿不到"半可信"的 URL。
 */
import { LOCAL_MEDIA_SCHEME, LOCAL_TRACK_HEX_LENGTH } from "../shared/local-track.ts";

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
  /** 本地协议：host 不是宿主给的那两个形态，或路径不是 `/<id>` / `/<id>/cover` */
  localPath: "local_path",
};

/**
 * 本地曲库协议的两条路径形状（与 `src/renderer/features/library/local-library.mjs` 的
 * `localMediaPath` 同源：那边负责拼，这边负责验）。
 */
const LOCAL_PATH = new RegExp(`^/[0-9a-f]{${LOCAL_TRACK_HEX_LENGTH}}(?:/cover)?$`);

/** 本地协议认的 host：Windows 形态与 mac/Linux 形态各一个。 */
const LOCAL_HOSTS = Object.freeze([`${LOCAL_MEDIA_SCHEME}.localhost`, "localhost"]);

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
 * 本地曲库协议的放行判定（R65）：只认两种宿主形态 + `/<id>`（音频）与 `/<id>/cover`（封面）两种路径，
 * 查询串/片段/userinfo/显式端口/多余路径段一律拒绝——协议只按 id 查索引，放行它们只会让"能不能播"不可预测。
 * 不是本地协议地址回 `null`（交给 CDN 那条规则）。
 */
export function parseLocalMediaUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== LOCAL_MEDIA_SCHEME) return null;

  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.includes(host)) return null;
  // Windows 形态必须是 http + `<scheme>.localhost`；mac/Linux 形态必须是 `<scheme>://localhost`。
  // 混着来的（https、或 http://localhost）都不是宿主会给的地址，拒绝。
  const windowsShape = scheme === "http" && host === `${LOCAL_MEDIA_SCHEME}.localhost`;
  const otherShape = scheme === LOCAL_MEDIA_SCHEME && host === "localhost";
  if (!windowsShape && !otherShape) return null;

  const authority = authorityOf(raw);
  if (authority === null) return { ok: false, reason: MEDIA_URL_REASONS.unparsable };
  if (authority.includes("@")) return { ok: false, reason: MEDIA_URL_REASONS.userinfo };
  if (authority.includes(":")) return { ok: false, reason: MEDIA_URL_REASONS.port };

  const pathname = raw.slice(raw.indexOf(authority) + authority.length);
  if (pathname.includes("?") || pathname.includes("#")) return { ok: false, reason: MEDIA_URL_REASONS.localPath };
  if (!LOCAL_PATH.test(pathname)) return { ok: false, reason: MEDIA_URL_REASONS.localPath };

  return { ok: true, url: url.href, host, suffix: null };
}

/**
 * 校验并归一化媒体 URL。
 * @returns {{ok: true, url: string, host: string, suffix: string|null} | {ok: false, reason: string}}
 */
export function parseSafeMediaUrl(value) {
  // 本地协议先判：它是另一条规则，不该被 "只认 https" 挡掉
  const local = parseLocalMediaUrl(value);
  if (local !== null) return local;

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
