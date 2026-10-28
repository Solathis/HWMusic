/**
 * 会话验证器：用收藏接口的最小页（`start=0&limit=1`）判断当前音乐会话是否仍然有效。
 * 三档：HTTP 200 且业务码为 000000 记有效；服务端明确拒绝（4xx/5xx、业务码非 000000）记失效；
 * 网络错、端点关闭、缺 SNS 标识、200 但没有业务码一律记「没验成」，保守地不判失效。
 * 凭据不进日志与错误文案，不自己发 HTTP，全部经注入的 music api。
 */
import { MUSIC_BUSINESS_OK, MUSIC_ERROR_KINDS } from "../protocols/music.mjs";
import { err, ok } from "../shared/result.ts";

/** 本模块给出的两个档位（`auth-manager` 按 `kind` 分支：失效踢回登录，没验成保守继续）。 */
export const SESSION_VERIFY_ERROR_KINDS = {
  /** 服务端明确说「这个会话不行」 */
  sessionInvalid: "session_invalid",
  /** 没法验证（网络/端点/形状）：**不判失效**，如实说「没验过」 */
  unavailable: "verify_unavailable",
};

/** 判「服务端明确拒绝」的协议错误类别（httpError、apiError），其余一律保守。 */
const REJECTION_KINDS = [MUSIC_ERROR_KINDS.httpError, MUSIC_ERROR_KINDS.apiError];

/** 服务端拒绝 → 给人看的文案：说清原因 + 下一步（用户唯一能做的事就是重新登录）。 */
function invalidMessage(cause) {
  return `音乐会话已失效（${cause}），请重新登录。`;
}

/** 没验成 → 给人看的文案：说清原因 + 明确「不判失效」（这句话会进启动日志与状态行）。 */
function unavailableMessage(cause) {
  return `会话未能验证（${cause}）：本次不判定会话失效。`;
}

/**
 * 造会话验证器（`auth-manager` 的 `verifySession` 插座）。
 *
 * @param {object} options
 * @param {(sessionSource: () => unknown) => {listFavoritesPage: Function}} options.createApi 拿到本次要验的会话的取值函数，返回一个 music api（由调用方建，端点表与 Digest 头只有那一处实现）。
 * @param {() => unknown} [options.sessionSource] 兜底会话来源，只在调用方没传会话时用它。
 * @returns {(session?: unknown) => Promise<import("../shared/result.ts").CoreResult<{verified: true}>>}
 */
export function createMusicSessionVerifier({ createApi, sessionSource = () => null } = {}) {
  if (typeof createApi !== "function") {
    throw new TypeError("createMusicSessionVerifier 需要 createApi（拿到会话源、回一个 music api）");
  }
  if (typeof sessionSource !== "function") {
    throw new TypeError("createMusicSessionVerifier 需要 sessionSource 是函数（会话按调用时取）");
  }

  /**
   * 本次正在验证的那个会话（一格内存，进出成对）。
   * 参数赢：两个调用点传进来的是还没落进内存的新会话，`sessionSource` 只作兜底。
   */
  let verifying = null;
  const holder = () => (verifying === null ? sessionSource() : verifying);

  const api = createApi(holder);
  if (api === null || typeof api.listFavoritesPage !== "function") {
    throw new TypeError("createApi 必须给出 music api（要有 listFavoritesPage）");
  }

  return async function verifySession(session) {
    const previous = verifying;
    verifying = session ?? null;
    let result;
    try {
      // 最小页：一页一条。**不是**"取一次收藏看看有没有歌"——空收藏夹也是有效会话
      // （判据只有业务码，见文件头矩阵）。
      result = await api.listFavoritesPage({ page: 1, pageSize: 1 });
    } finally {
      verifying = previous;
    }

    if (!result.ok) {
      const kind = result.error.kind ?? "";
      const cause = result.error.message;
      return REJECTION_KINDS.includes(kind)
        ? err(invalidMessage(cause), SESSION_VERIFY_ERROR_KINDS.sessionInvalid)
        : err(unavailableMessage(cause), SESSION_VERIFY_ERROR_KINDS.unavailable);
    }

    // 成功判据按契约逐字来：**HTTP 200 且 `result.resultCode === "000000"`**。
    // 只看「HTTP 通了」不够，看不懂的 200 只能算「没验成」，绝不判有效。
    const code = result.data?.result?.resultCode;
    if (code !== MUSIC_BUSINESS_OK) {
      return err(
        unavailableMessage("收藏接口返回 200，但响应里没有成功的业务码 result.resultCode"),
        SESSION_VERIFY_ERROR_KINDS.unavailable,
      );
    }
    return ok({ verified: true });
  };
}
