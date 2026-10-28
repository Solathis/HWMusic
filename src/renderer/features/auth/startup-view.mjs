/**
 * 启动第一屏的三态判定（纯函数，.mjs 是有意的：渲染层与 node 测试 import 同一份）。
 * `checking` 恒为中性启动屏，绝不渲染 LoginGate/二维码；unknown/缺失/认不出的 phase 一律落回 `checking`。
 */
import { LOGIN_GATE_PHASE, LOGIN_OPENING_TEXT, loginOpeningIndicator, shouldShowLoginGate } from "./login-gate-logic.mjs";

/**
 * 非 app-shell 的两态 + app-shell 本身（三态的取值）。
 *
 * 取值是给源码守卫和测试认的标识，不是给人看的文案。
 */
export const STARTUP_VIEW = {
  /** 还不知道：中性启动屏（安静档）。 */
  checking: "checking",
  /** 确定未登录：登录门禁（原来那一页） */
  loginGate: "login-gate",
  /** 已登录：主界面 */
  appShell: "app-shell",
};

/**
 * 中性启动屏的测试锚点（真 SSR 标记测试与源码守卫按它点名那一屏）。
 */
export const STARTUP_CHECKING_TESTID = "startup-checking";

/**
 * 中性启动屏的可达名字（不是可见文案），只放在 `role="status"` 的 `aria-label` 上，不进可见文本。
 */
export const STARTUP_CHECKING_LABEL = "正在启动…";

/**
 * 「重新检查登录状态」的可见文案与锚点：它做的事就是再问一次 `auth:get-status`。
 */
export const STARTUP_RETRY_LABEL = "重新检查登录状态";
export const STARTUP_RETRY_TESTID = "startup-retry-status";

/** 启动屏上那句话的测试锚点（失败原因 / 「正在打开官方登录页…」都写在这一行里）。 */
export const STARTUP_NOTICE_TESTID = "startup-notice";

/**
 * 「这一次检查已经失败」吗？（`checking` 档里该给用户一条出路的那一种情况）判据是 `message`。
 * @param {object} state 门禁状态
 * @returns {boolean}
 */
export function startupCheckFailed(state) {
  const phase = state?.phase;
  if (phase === LOGIN_GATE_PHASE.loggedIn || phase === LOGIN_GATE_PHASE.loggedOut) return false;
  return typeof state?.message === "string" && state.message !== "";
}

/**
 * 中性启动屏上长什么（这一屏自己的判定，唯一真源）：失败档给原因与两条出路，其余是安静档。
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
 * 现在该渲染哪一个界面（唯一真源）。
 * @param {object} state 门禁状态（`useAuthGate` 给的 `gate.state`）
 * @returns {string} `STARTUP_VIEW` 里的一个取值
 */
export function startupViewOf(state) {
  // 「能不能渲染 app-shell」仍由 login-gate-logic 判决（这里只是读它，不另写一条）
  if (!shouldShowLoginGate(state)) return STARTUP_VIEW.appShell;
  // 确定未登录 → 门禁页
  if (state?.phase === LOGIN_GATE_PHASE.loggedOut) return STARTUP_VIEW.loginGate;
  // 其余（还不知道 / 查询失败 / 刚按了网页登录那条路）= 中性启动屏。
  // `checking` 永不渲染 LoginGate/二维码，phase 是 checking 就是中性启动屏，一格不差。
  return STARTUP_VIEW.checking;
}
