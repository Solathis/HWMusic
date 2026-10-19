/**
 * 登录门禁的判定逻辑（纯函数，.mjs 是有意的：渲染层与测试 import 同一份，不经过 JSX/打包）。
 *
 * 三条不变量（简报的硬要求）：
 * 1. **未登录绝不渲染 app-shell**：`shouldShowLoginGate` 为真时，外层必须先渲染门禁；
 *    "还不知道"（`checking`：等 `auth:status` 的第一条广播）也按门禁处理——猜错的代价是
 *    把没登录的用户放进主界面（然后每个请求都失败），比多显示一个"正在检查"严重得多。
 * 2. **自动发起只发生在"确定未登录"**：`shouldAutoStartLogin` 要求三条件齐备
 *    （门禁内的确定态、不 busy、本轮未发起）。检查中就自动开登录窗 = 可能把已有会话顶掉。
 * 3. **取消之后不自动重开**：`attempted` 一旦置位就不再自动发起（否则取消按钮形同虚设），
 *    但手动按钮仍然可用（`canStartLogin`）。
 */

/** 门禁的三个阶段。 */
export const LOGIN_GATE_PHASE = {
  /** 还不知道：等 `auth:status` 的第一条广播（启动期那条会被 Rust 排队，不会丢） */
  checking: "checking",
  /** 确定未登录 */
  loggedOut: "logged_out",
  /** 已登录 → 放行 app-shell */
  loggedIn: "logged_in",
};

/** 状态机认得的事件。 */
export const LOGIN_GATE_EVENT = {
  /** `auth:status` 广播：`{loggedIn, busy, message?}` */
  status: "status",
  /** 本轮发起登录（按钮点击或自动发起） */
  started: "started",
  /** 登录成功（广播到达前的本地乐观推进——真正的状态仍由广播说了算） */
  succeeded: "succeeded",
  /** 登录失败/取消，带一句给人看的文案 */
  failed: "failed",
  /** 用户主动取消 */
  cancelled: "cancelled",
};

/** 初始状态：`checking`（**不是** loggedOut：还没问过 core 就不许下结论）。 */
export function initialGateState() {
  return { phase: LOGIN_GATE_PHASE.checking, busy: false, attempted: false, message: null };
}

/** 事件 → 新状态（纯函数：不改写入参，未知事件原样返回）。 */
export function reduceGateState(state, event) {
  const type = event?.type;
  switch (type) {
    case LOGIN_GATE_EVENT.status: {
      const loggedIn = event.loggedIn === true;
      return {
        ...state,
        phase: loggedIn ? LOGIN_GATE_PHASE.loggedIn : LOGIN_GATE_PHASE.loggedOut,
        busy: event.busy === true,
        // 广播里带文案就用它（失败原因），没带就保留本地那条（别把用户刚看到的说明抹掉）
        message: loggedIn ? null : (event.message ?? state.message),
      };
    }
    case LOGIN_GATE_EVENT.started:
      return { ...state, busy: true, attempted: true, message: null };
    case LOGIN_GATE_EVENT.succeeded:
      return { ...state, phase: LOGIN_GATE_PHASE.loggedIn, busy: false, message: null };
    case LOGIN_GATE_EVENT.failed:
      return { ...state, busy: false, message: event.message ?? "登录未完成（详情见日志）" };
    case LOGIN_GATE_EVENT.cancelled:
      return { ...state, busy: false, message: "已取消登录（可以重新打开官方登录页）" };
    default:
      return state;
  }
}

/** 该显示门禁吗？（`phase` 不是"已登录"就显示门禁，包括"还不知道"） */
export function shouldShowLoginGate(state) {
  return state?.phase !== LOGIN_GATE_PHASE.loggedIn;
}

/**
 * 该自动发起登录吗？三条件缺一不可：
 * 1. 阶段是**确定的**"未登录"（`checking` 不发起：可能已有会话）；
 * 2. 不 busy（已经有一次在进行）；
 * 3. 本轮没发起过（取消之后不重开）。
 */
export function shouldAutoStartLogin(state) {
  if (state?.phase !== LOGIN_GATE_PHASE.loggedOut) return false;
  if (state.busy === true) return false;
  if (state.attempted === true) return false;
  return true;
}

/** 手动按钮可用吗？（只要不在忙：用户重来一次是他的自由） */
export function canStartLogin(state) {
  return state?.busy !== true;
}

/** 状态行文案（克制：一行，告诉用户现在是什么状态、下一步能做什么）。 */
export function loginGateStatusLine(state) {
  if (state?.busy === true) return "已打开华为官方登录页，请在窗口中扫码…";
  if (typeof state?.message === "string" && state.message !== "") return state.message;
  if (state?.phase === LOGIN_GATE_PHASE.checking) return "正在检查登录状态…";
  if (state?.phase === LOGIN_GATE_PHASE.loggedIn) return "已登录。";
  return "未登录：登录页由华为官方渲染，本应用不接触你的账号与密码。";
}
