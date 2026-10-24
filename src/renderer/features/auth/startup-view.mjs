/**
 * R45A1 · 启动第一屏的三态判定（纯函数，.mjs 是有意的：渲染层与 node 测试 import 同一份）。
 *
 * 用户第 10 项：**已经登录的会话冷启动时会先闪一下登录页**。
 *
 * 根因（`App.tsx` 第一帧）：
 *
 * ```
 *   useAuthGate 的 useState 初值 = initialGateState()  →  phase = "checking"（还不知道）
 *   旧外壳：            phase !== "logged_in"  →  直接渲染 <LoginGate/>   ← 用户看见的那一闪
 *   一次 IPC 往返之后：  auth:status 广播 / auth:get-status 应答到 → 已登录 → app-shell
 * ```
 *
 * `checking` 本身没错（"还没问过 core"就是不许猜），错的是把它**当成未登录**来画。
 * 所以这里把「渲染哪一个界面」从 `shouldShowLoginGate`（"能不能渲染 app-shell"）里分出来：
 *
 * | phase | 界面 | 二维码 |
 * |---|---|---|
 * | `checking` | 中性启动屏（`StartupChecking`：一枚转圈；查询失败时多一句原因 + 两个动作） | 不发起 |
 * | `logged_out` | `LoginGate`（原来那一页） | 此刻才自动发起 |
 * | `logged_in` | app-shell | 不发起 |
 *
 * **复审 R45A1（合同要求）**：`checking` 恒为中性启动屏——包括查询失败那一档，也包括
 * 用户刚在那张屏上按了「在网页中打开登录」那一档。它**永远**不渲染 LoginGate/二维码：
 * 失败不是"确定未登录"，把它画成登录页等于用一张可能不需要的码盖住一个还没查完的会话。
 * 上一版的两处例外（失败、网页那条路在跑）已经删掉，那两条出路搬到了启动屏自己身上
 * （见 `startupCheckingStatusOf`）。
 *
 * 三条纪律：
 *
 * 1. **唯一裁决**：`startupViewOf` 是"渲染哪一个"的唯一真源，外壳不再自己比 phase；
 * 2. **不猜**：unknown/缺失/认不出的 phase 一律落回 `checking`（安静启动屏）——
 *    既不猜"已登录"（那是把没登录的用户放进主界面），也不猜"未登录"（那是拿一张
 *    可能不需要的二维码去覆盖已有会话）；
 * 3. **不掩盖**：这一层**没有任何时钟/延迟**。延迟画登录页、先画再 `hidden` 都是把同一个
 *    错误藏起来：那一帧仍然是错的，只是看不见了（`test/startup-view.test.mjs` 钉住这条）。
 *
 * 与 `login-gate-logic.mjs` 的关系：这里是它之上的一层**投影**，不是第二套判定——
 * "能不能渲染 app-shell" 仍然直接调 `shouldShowLoginGate`，所以两个模块永远同向。
 */
import { LOGIN_GATE_PHASE, LOGIN_OPENING_TEXT, loginOpeningIndicator, shouldShowLoginGate } from "./login-gate-logic.mjs";

/**
 * 非 app-shell 的两态 + app-shell 本身（三态的取值）。
 *
 * 取值是给源码守卫和测试认的标识，不是给人看的文案。
 */
export const STARTUP_VIEW = {
  /** 还不知道：中性启动屏（R45A1 新增的那一档） */
  checking: "checking",
  /** 确定未登录：登录门禁（原来那一页） */
  loginGate: "login-gate",
  /** 已登录：主界面 */
  appShell: "app-shell",
};

/**
 * 中性启动屏的测试锚点（真 SSR 标记测试与源码守卫按它点名那一屏）。
 *
 * 真窗守据点名登录页用的是 `login-qr-refresh` 一类锚点：已登录冷启动时那些锚点出现的次数
 * 必须是 0，而这一条必须是 1 —— 两边的判据都是"屏上到底有什么"。
 */
export const STARTUP_CHECKING_TESTID = "startup-checking";

/**
 * 中性启动屏的**可达名字**（不是可见文案）。
 *
 * 用户的要求是"安静中性"：屏上不写字（没有标题、没有提示、没有状态行堆叠）。但读屏用户
 * 仍然得知道"应用在启动、别急"——所以这句话只放在 `role="status"` 的 `aria-label` 上，
 * 不进可见文本（`test/login-gate-markup.test.mjs` 会断言安静档的可见文案为空串）。
 */
export const STARTUP_CHECKING_LABEL = "正在启动…";

/**
 * 「重新检查登录状态」的可见文案与锚点（复审 R45A1）。
 *
 * 为什么这个按钮必须存在：`checking` 不许画成登录页，但**检查真的失败**时也不能让用户
 * 停在一张永远安静的屏上（那正是 R19 要消灭的"空转"）。于是启动屏自己长出这一条：
 * 它做的事就是再问一次 `auth:get-status`（与挂载时那一次同一条实现）。
 */
export const STARTUP_RETRY_LABEL = "重新检查登录状态";
export const STARTUP_RETRY_TESTID = "startup-retry-status";

/** 启动屏上那句话的测试锚点（失败原因 / 「正在打开官方登录页…」都写在这一行里）。 */
export const STARTUP_NOTICE_TESTID = "startup-notice";

/**
 * 「这一次检查**已经失败**」吗？（`checking` 档里"该给用户一条出路"的那一种情况）
 *
 * R19 立的规矩是"查询失败**不猜档位**"（仍停在 checking）——没答上来就是没答上来。
 * 但"不猜"不等于"什么都不做"：原因要说出来，还要留两条出路（重新查一次 + 网页登录）。
 * 复审 R45A1 把这两条出路从登录页搬到了启动屏自己身上：合同要求 `checking` **绝不**渲染
 * LoginGate/二维码，失败不是"确定未登录"，画成登录页等于用一张可能不需要的码盖住一个
 * 还没查完的会话。
 *
 * 判据是 `message`：`reduceGateState` 只在**真的失败**时给它写一句人话（广播/查询失败、
 * 网页那条路收场），其余档位都是 `null`。已确定的两个档位不算（不能靠一句残留的 message
 * 把 app-shell 顶掉）。
 *
 * @param {object} state 门禁状态
 * @returns {boolean}
 */
export function startupCheckFailed(state) {
  const phase = state?.phase;
  if (phase === LOGIN_GATE_PHASE.loggedIn || phase === LOGIN_GATE_PHASE.loggedOut) return false;
  return typeof state?.message === "string" && state.message !== "";
}

/**
 * 中性启动屏上**长什么**（复审 R45A1：这一屏自己的判定，唯一真源）。
 *
 * 三档（其余情况一律是安静档 —— 空屏 + 一枚转圈）：
 *
 * | 情况 | 屏上那句 | 重新检查 | 网页登录 |
 * |---|---|---|---|
 * | 查询真的失败 | 失败原因（`state.message`） | 有 | 有 |
 * | 网页登录那条路刚被按下去、官方页还在屏外加载 | 「正在打开华为官方登录页…」 | 无 | 无 |
 * | 安静的检查中 | 无（零可见文案） | 无 | 无 |
 *
 * 为什么"正在打开"这一档要给一句：失败档上的入口按下去之后 `started` 会把 `message` 清空，
 * 若这一屏继续说"一片安静"，用户刚点完按钮却看不到任何反应——那和"点了没反应"是同一件事。
 *
 * @param {object} state 门禁状态
 * @returns {{failed: boolean, text: string|null, canRetry: boolean, canWebLogin: boolean}}
 */
export function startupCheckingStatusOf(state) {
  if (startupCheckFailed(state)) {
    return { failed: true, text: state.message, canRetry: true, canWebLogin: state?.busy !== true };
  }
  if (loginOpeningIndicator(state).showing) {
    // 官方页此刻还在屏外加载（Rust 侧 offscreen）：如实说在等什么，并且不给会打断它的按钮
    return { failed: false, text: LOGIN_OPENING_TEXT, canRetry: false, canWebLogin: false };
  }
  return { failed: false, text: null, canRetry: false, canWebLogin: false };
}

/**
 * 现在该渲染哪一个界面（**唯一真源**）。
 *
 * @param {object} state 门禁状态（`useAuthGate` 给的 `gate.state`）
 * @returns {string} `STARTUP_VIEW` 里的一个取值
 */
export function startupViewOf(state) {
  // 「能不能渲染 app-shell」仍由 login-gate-logic 判决（这里只是读它，不另写一条）
  if (!shouldShowLoginGate(state)) return STARTUP_VIEW.appShell;
  // 确定未登录 → 门禁页
  if (state?.phase === LOGIN_GATE_PHASE.loggedOut) return STARTUP_VIEW.loginGate;
  // 其余（还不知道 / 查询失败 / 刚按了网页登录那条路）= 中性启动屏。
  //
  // **复审 R45A1**：上一版把"查询失败"与"网页登录那条路在跑"都判成了登录页（理由是那条
  // 出路口长在门禁页上）。那违反复审合同——`checking` 永不渲染 LoginGate/二维码。
  // 现在那两条出路长在这一屏自己身上（见 `startupCheckingStatusOf`），所以这里不再有例外：
  // phase 是 checking 就是中性启动屏，一格不差。
  return STARTUP_VIEW.checking;
}
