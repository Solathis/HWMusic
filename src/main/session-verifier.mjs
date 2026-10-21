/**
 * 会话验证器（R37）：拿**收藏接口的最小页**判「这个音乐会话现在还有效吗」。
 *
 * ## 为什么是收藏接口
 *
 * 参考实现（公开仓库 `talongao/huawei-music-desktop`，`src/main/auth-manager.ts`）的登录链
 * 最后一步就是 `openLogin → loginex → favorites(candidate)`——**它用收藏接口验收刚换到的会话**。
 * 而收藏正好是「既要音乐会话令牌、又要本人 snsUserID」的最小业务调用（`start=0&limit=1`），
 * 端点与请求形状 R32 已经全对齐（`docs/API_CONTRACT.md` §2.2），所以它同时满足两件事：
 * 端点是真的、而且**没有有效会话就一定过不去**。
 *
 * ## 档位矩阵（三档，逐条钉在 `test/session-verifier.test.mjs`）
 *
 * | 服务端/环境 | 结论 | 后果 |
 * |---|---|---|
 * | HTTP 200 且 `result.resultCode === "000000"` | **有效** | 登录落地 / 恢复为「已登录已验」 |
 * | 服务端明确拒绝（业务码非 000000、HTTP 4xx/5xx） | **失效**（`session_invalid`） | 踢回登录，文案带「请重新登录」 |
 * | 网络错 / 端点被显式关闭 / 会话缺 SNS 标识 / 200 但没有业务码 | **没验成**（`verify_unavailable`） | 保守：**不判失效**（恢复时按「已登录未验证」继续） |
 *
 * 第三档为什么这么宽：把网络抖动或端点没配读成「会话失效」，代价是把用户踢回登录页——
 * 而用户刚扫完码。这与 `auth-manager.ts` 文件头那条规矩同源（**宁可少报失效**：
 * 会话留着、界面照常进主界面，业务请求自己会报真实原因）。
 *
 * **未实测（如实登记）**：真实账号下「有效会话返回 000000 / 失效会话返回什么业务码」没有本机证据
 * （要用户授权登录）。所以这里只把**已被参考实现走通的那条路**（200 + 000000 = 有效）当作有效，
 * 其余一律按上表分流；若 R37 之后真机发现某个业务码其实是「端点参数不对」而不是「会话失效」，
 * 收窄点只有一处——[`REJECTION_KINDS`]。
 *
 * ## 纪律
 *
 * - **凭据不进日志、不进错误文案**：音乐会话令牌只在请求头里出现（Digest 由
 *   `src/main/music-service.mjs` 构造），本模块既不读它也不回显它；
 * - **不自己发 HTTP**：全部经注入的 music api（端点表、Digest 头、超时/重试都是那一份）；
 * - **不猜 URL**：端点被显式关闭或没配时，协议层在发请求**之前**就收口，本模块只做档位归类。
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

/**
 * 判「服务端明确拒绝」的协议错误类别（其余一律保守，见文件头矩阵）。
 *
 * - `httpError`：HTTP 4xx/5xx——服务端把这次请求拒了（认证类与网关类都在内，
 *   协议层不为这种情况读响应体，所以这里拿不到更细的状态码；这是刻意的：响应体可能带内部信息）；
 * - `apiError`：HTTP 通了但业务码不是 `000000`（`decodeEnvelope` 的判据）。
 */
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
 * @param {(sessionSource: () => unknown) => {listFavoritesPage: Function}} options.createApi
 *        拿到「本次要验的会话」的取值函数，返回一个 music api。**由调用方建**
 *        （sidecar 里就是 `createMusicService({settingsData, session: sessionSource}).api`）：
 *        端点表与 Digest 头只有那一处实现，本模块不抄第二份。
 * @param {() => unknown} [options.sessionSource]
 *        兜底会话来源（sidecar 装配处给的是 `() => authManager.currentSession().session`）。
 *        只在调用方**没传**会话时用它。
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
   * **本次正在验证的那个会话**（一格内存，进出成对）。
   *
   * 为什么要这一格而不是直接用 `sessionSource()`：`auth-manager` 的两个调用点
   * （`restore` 与 `completeWithCode`）传进来的都是**还没落进内存的那个会话**——
   * 恢复时它刚从 DPAPI 信封里读出来，登录时它刚由 loginex 换到；这一刻
   * `currentSession().session` 里装的还是旧会话或 `null`。所以**参数赢**，
   * `sessionSource` 只作兜底（那个函数的取值仍然发生在**调用时**，不是装配时）。
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
    // 只看"HTTP 通了"是不够的（协议层对没有 `result` 的老信封是宽容的，
    // 而"看不懂的 200"在这里只能算「没验成」——绝不判有效）。
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
