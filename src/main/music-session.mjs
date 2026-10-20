/**
 * 音乐会话兑换（旧仓称 `loginex`）：账号 AT → 音乐会话凭据。
 *
 * ## 这次凭什么敢写端点（R17）
 *
 * R4 起这条链的最后一环一直是**结构化「待联调」**，理由是"端点 URL、请求形状、Digest 细节
 * 均无公开证据"。R17 的 bundle/公开源挖掘把三件事都找到了，并且**本机实测**了其中能实测的部分：
 *
 * 1. **端点与请求形状**：来自公开仓库 `talongao/huawei-music-desktop` 的
 *    `docs/API_CONTRACT.md`（2026-10-14 的本人账号实验记录）与 `src/auth.mjs`：
 *    `POST /music-odpapp-service/v5/service/userinfo/loginex`，体 `{"accessToken":"<账号 AT>"}`，
 *    头 `Authorization: Digest username=app-music-baseline, nonce=<随机>, created=<UTC ISO8601 无毫秒>`
 *    （**不带** token 段）。业务成功 = HTTP 2xx 且 `result.resultCode === "000000"`。
 * 2. **端点存在性**：R17 本机无凭据实测（`.tmp/r17-loginex-live.mjs`，结果记在
 *    `docs/API_CONTRACT.md` §1.5）：业务域 `api-drcn.music.dbankcloud.cn` 可解析；
 *    `GET` 该路径 **405 Method Not Allowed**（路径存在、只收 POST），而同一域下一个故意写错的
 *    对照路径回 **404**；`POST` 一个无效 AT 回 **200 + `result.resultCode = "990000"`**
 *    （请求被业务受理并拒绝）。
 * 3. **没有实测的**（如实登记，见报告 untested 清单）：拿**有效** AT 换到真会话的往返
 *    （需要用户授权扫码 → 只有用户在场才可能）。所以本模块的"形状"来自公开证据，
 *    "端点存在"来自本机实测，**"兑换成功"仍然未实测**。
 *
 * ## 纪律
 *
 * - **凭据绝不进日志/错误**：`accessToken`、音乐 `token` 都不出现在 message 里；
 *   错误只带 HTTP 状态、业务码、以及一句人话。
 * - **端点仍由调用方注入**：默认值住在 `auth-manager.ts`（与 authorize/token 同一处），
 *   本模块只认参数里的 `endpoint`。`endpoint` 为空时由调用方在发请求**之前**收口
 *   （见 auth-manager 的 `LOGINEX_PENDING_MESSAGE` 分支）——本模块不发这种请求。
 */
import { randomBytes } from "node:crypto";

import { err, ok } from "../shared/result.ts";

/** 音乐业务域（公开契约 §1"业务域"）。 */
export const HUAWEI_MUSIC_BASE = "https://api-drcn.music.dbankcloud.cn";

/** 音乐会话兑换路径（公开契约 §2.3）。 */
export const HUAWEI_MUSIC_LOGINEX_PATH = "/music-odpapp-service/v5/service/userinfo/loginex";

/** 音乐会话兑换端点（拼好的绝对 URL；也是 `auth-manager` 的默认值来源）。 */
export const HUAWEI_MUSIC_LOGINEX_ENDPOINT = `${HUAWEI_MUSIC_BASE}${HUAWEI_MUSIC_LOGINEX_PATH}`;

/**
 * Digest 头的 `username`：公开契约 §1"音乐会话请求头"里那个固定值。
 *
 * 它不是凭据（是服务端认的"应用基线"标识），但仍然只在请求头里出现、不进日志。
 */
export const MUSIC_SESSION_DIGEST_USERNAME = "app-music-baseline";

/** 业务成功码（公开契约 §1："业务成功通常要求 HTTP 成功且 `result.resultCode === "000000"`"）。 */
export const MUSIC_BUSINESS_OK = "000000";

/** 本模块的错误类别（与 `protocols/auth.mjs` 同名同义，避免跨层 import 造成的环）。 */
export const MUSIC_SESSION_ERROR_KINDS = {
  missingEndpoint: "missing_endpoint",
  missingParam: "missing_param",
  networkError: "network_error",
  httpError: "http_error",
  invalidResponse: "invalid_response",
  /** HTTP 通了但业务码不是 000000（带服务端 resultCode，不含任何凭据） */
  businessError: "loginex_failed",
};

/** 请求超时（与公开契约"只读调用 timeout=25 秒"同量级）。 */
export const MUSIC_SESSION_TIMEOUT_MS = 25_000;

/**
 * 构造 `Authorization: Digest …` 头。
 *
 * `created` 必须是 **UTC ISO8601 且不带毫秒**（公开契约明写；带毫秒服务端认不认未实测，
 * 所以按已证形状去掉毫秒）；`nonce` 每请求随机（契约："不要从日志或抓包中硬编码旧头信息"）。
 *
 * @param {{nonce: string, created: string, token?: string|null}} params
 */
export function buildMusicDigestHeader({ nonce, created, token = null }) {
  if (typeof nonce !== "string" || nonce.trim() === "") throw new TypeError("Digest nonce 不能为空");
  if (typeof created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created)) {
    throw new TypeError("Digest created 必须是「无毫秒的 UTC ISO8601」（YYYY-MM-DDTHH:MM:SSZ）");
  }
  // 头注入防护：token 里出现换行/逗号就能往头里塞第二段（与旧仓 musicHeaders 同一条判据）
  if (token !== null && /[\r\n,]/.test(String(token))) throw new TypeError("音乐会话令牌格式无效");
  const suffix = token === null ? "" : `, token=${token}`;
  return `Digest username=${MUSIC_SESSION_DIGEST_USERNAME}, nonce=${nonce}, created=${created}${suffix}`;
}

/** `Date` → 无毫秒的 UTC ISO8601（契约要的那个形状）。 */
export function digestCreatedAt(now = new Date()) {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function messageOf(cause) {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "string" && cause.trim() !== "") return cause;
  return "未知错误（详情见日志）";
}

/**
 * loginex 响应 → 本项目的会话形状。
 *
 * 映射（公开契约 §2.3 的"响应关注"三项 + 本仓既有会话形状）：
 * - `token`      → `musicSession`（**会话凭据**，进 DPAPI 信封，不进日志）
 * - `snsUserID`  → `userId`
 * - `expireTime` → 原样保留为 14 位 `yyyyMMddHHmmss` 字符串
 *
 * **刻意不把它换算成 `expiresAt` 毫秒**：契约明写"时区尚未完全确认"，换算错了就是一个
 * 看起来精确、实际偏 8 小时的时间戳；而这个项目的续期本来就没打通（失效要重扫）。
 * 原始串留下，等真机联调确认时区后再决定怎么用。
 */
export function parseMusicSessionResponse(payload) {
  if (payload === null || typeof payload !== "object") {
    return err("音乐会话兑换响应不是 JSON 对象", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }
  const resultCode = payload?.result?.resultCode;
  if (typeof resultCode !== "string") {
    return err("音乐会话兑换响应缺少 result.resultCode（形状与契约不符）", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }
  if (resultCode !== MUSIC_BUSINESS_OK) {
    // 只带业务码：服务端 resultMessage 可能回显请求内容，不进错误（错误会进日志与界面）
    return err(`音乐会话兑换被服务端拒绝（业务码 ${resultCode.slice(0, 16)}）`, MUSIC_SESSION_ERROR_KINDS.businessError);
  }

  const token = payload.token;
  if (typeof token !== "string" || token.trim() === "") {
    return err("音乐会话兑换响应里没有 token", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
  }

  const snsUserID = payload.snsUserID;
  const expireTime = payload.expireTime;
  return ok({
    musicSession: token,
    ...(typeof snsUserID === "string" && snsUserID.trim() !== "" ? { userId: snsUserID } : {}),
    ...(typeof expireTime === "string" && expireTime.trim() !== "" ? { expireTime } : {}),
  });
}

/**
 * 造一个真发请求的音乐会话端口（`auth-manager` 的 `exchangeMusicSession` 插座）。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]  注入 fetch（测试用；默认全局 fetch）
 * @param {Function} [options.random]     注入随机源（测试用；默认 node:crypto）
 * @param {Function} [options.now]       注入时钟（测试用；默认 `() => new Date()`）
 * @param {number}   [options.timeoutMs]  单次请求超时
 * @returns {(params: {accessToken: string, endpoint: string}) => Promise<import("../shared/result.ts").CoreResult<unknown>>}
 */
export function createHuaweiMusicSessionPort({
  fetchImpl = globalThis.fetch,
  random = randomBytes,
  now = () => new Date(),
  timeoutMs = MUSIC_SESSION_TIMEOUT_MS,
} = {}) {
  return async function exchangeMusicSession({ accessToken, endpoint } = {}) {
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      return err(
        "音乐会话兑换端点未确定：调用方必须在发请求之前收口（本模块不猜 URL、不发请求）",
        MUSIC_SESSION_ERROR_KINDS.missingEndpoint,
      );
    }
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      return err("账号访问令牌为空，无法兑换音乐会话", MUSIC_SESSION_ERROR_KINDS.missingParam);
    }

    let headers;
    try {
      headers = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: buildMusicDigestHeader({
          nonce: random(24).toString("base64url"),
          created: digestCreatedAt(now()),
        }),
      };
    } catch (cause) {
      return err(`音乐会话请求头构造失败：${messageOf(cause)}`, MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }

    let response;
    try {
      response = await fetchImpl(endpoint.trim(), {
        method: "POST",
        headers,
        body: JSON.stringify({ accessToken }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      return err(`请求音乐会话端点失败：${messageOf(cause)}`, MUSIC_SESSION_ERROR_KINDS.networkError);
    }

    if (!response || typeof response.ok !== "boolean") {
      return err("音乐会话端点未返回可识别的响应", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }
    if (!response.ok) {
      return err(`音乐会话端点返回 HTTP ${response.status}`, MUSIC_SESSION_ERROR_KINDS.httpError);
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return err("音乐会话端点响应不是 JSON", MUSIC_SESSION_ERROR_KINDS.invalidResponse);
    }
    return parseMusicSessionResponse(payload);
  };
}
