/**
 * 登录门禁的判定逻辑（纯函数，.mjs 是有意的：渲染层与测试 import 同一份，不经过 JSX/打包）。
 *
 * R16 起引导页的形态变了（用户指令）：**只展示二维码和提示文字**，进页面自动发起二维码会话，
 * 界面上一开始没有按钮；只有出错时才出现"重试"（以及"二维码不可用"时的官方页次要入口）。
 *
 * 五条不变量：
 * 1. **未登录绝不渲染 app-shell**：`shouldShowLoginGate` 为真时，外层必须先渲染门禁；
 *    "还不知道"（`checking`：等 `auth:status` 的第一条广播）也按门禁处理。
 * 2. **自动开始只发生在"确定未登录"**：`shouldAutoStartQr` 要求三条件齐备
 *    （门禁内的确定态、不 busy、本轮未发起）。检查中就发起 = 可能覆盖已有登录态。
 * 3. **二维码状态只认广播**：`auth:qr`（sidecar 建的会话）是唯一来源；认不出的档位**不猜**，
 *    保持原状态（陌生档位当成"已确认"是最严重的误判）。
 * 4. **过期由 sidecar 自动换新**：渲染层只把状态行改成"二维码已刷新"，不自己再发一次请求
 *    （谁持有轮询状态谁负责续期，界面不做协议）。
 * 5. **失败必须可操作**：可重试（`canRetryQr`）；只有"协议不可用"那一类才额外给官方页入口
 *    （`shouldOfferOfficialFallback`）——网络抖一下就把用户推回"打开官方页面"是过度反应。
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

/**
 * 二维码在门禁里的阶段。
 *
 * `pending`/`scanned`/`confirmed`/`expired`/`failed` 与 sidecar 的 `QR_LOGIN_STATUS` **同值**
 * （两侧靠 `test/qr-protocol-parity` 式的人工对齐；渲染层不 import sidecar 的协议模块，
 * 因为那会把 Node 侧实现打进渲染层包）。`preparing` 是渲染层自己的一档：已发起、
 * 还没拿到内容（`auth:qr-start` 还没回，或广播还没到）。
 */
export const QR_GATE_STATUS = {
  preparing: "preparing",
  pending: "pending",
  scanned: "scanned",
  confirmed: "confirmed",
  expired: "expired",
  failed: "failed",
};

const KNOWN_QR_STATUSES = Object.values(QR_GATE_STATUS);

/**
 * 允许出现"在华为官方页面打开登录"这条次要入口的错误类别。
 *
 * 只在**二维码这条路本身用不了**时给：端点缺失/响应形状不认识/页面配置拿不到。
 * 网络类、超时类、确认类失败都只给"重试"——那些重试一次往往就好了，
 * 把用户推去开一个官方窗口是更重的动作（而且它自己也依赖网络）。
 */
export const OFFICIAL_FALLBACK_KINDS = [
  "missing_endpoint",
  "invalid_response",
  "qr_config_unavailable",
  "unknown_channel",
  "unimplemented",
];

/** 提示文字的唯一真源（界面与测试读同一句）。 */
export const QR_HINT_TEXT = "请使用华为手机上的华为账号扫码登录。";

/** 状态机认得的事件。 */
export const LOGIN_GATE_EVENT = {
  /** `auth:status` 广播：`{loggedIn, busy, message?}` */
  status: "status",
  /** （次要入口）本轮发起官方登录窗 */
  started: "started",
  /** 登录成功（广播到达前的本地乐观推进——真正的状态仍由广播说了算） */
  succeeded: "succeeded",
  /** 登录失败/取消，带一句给人看的文案 */
  failed: "failed",
  /** 用户主动取消 */
  cancelled: "cancelled",
  /** 渲染层发起二维码会话（拿内容之前的乐观态） */
  qrRequested: "qr-requested",
  /** `auth:qr` 广播：`{status, content?, expiresInMs?, message?, errorKind?}` */
  qr: "qr",
  /** `auth:qr-start` 调用本身失败（连内容都没拿到） */
  qrFailed: "qr-failed",
};

/** 二维码的初始态：还没发起（`preparing` = "正在准备二维码…"）。 */
function initialQrState() {
  return { status: QR_GATE_STATUS.preparing, content: null, expiresInMs: null, message: null, errorKind: null };
}

/** 初始状态：`checking`（**不是** loggedOut：还没问过 core 就不许下结论）。 */
export function initialGateState() {
  return {
    phase: LOGIN_GATE_PHASE.checking,
    busy: false,
    attempted: false,
    message: null,
    qr: initialQrState(),
    /** 本轮是否已经自动发起过二维码（防重复建单） */
    qrAttempted: false,
    /** 当前走的是哪条路：`"qr"`（默认）/ `"official"`（失败后的官方页次要入口）。状态行按它说人话 */
    path: null,
  };
}

function applyQrEvent(qr, event) {
  const status = event?.status;
  // 认不出的档位不猜：保持原状态（陌生档位当"已确认"= 拿一个没确认的会话去换令牌）
  if (typeof status !== "string" || !KNOWN_QR_STATUSES.includes(status)) return qr;
  const next = { ...qr, status };
  if (typeof event.content === "string" && event.content !== "") next.content = event.content;
  if (typeof event.expiresInMs === "number") next.expiresInMs = event.expiresInMs;
  if (status === QR_GATE_STATUS.failed) {
    next.message = typeof event.message === "string" && event.message !== "" ? event.message : "二维码登录失败（详情见日志）";
    next.errorKind = typeof event.errorKind === "string" ? event.errorKind : null;
  } else {
    // 非失败档位要把上一次的错误清掉：否则"二维码已刷新"上面还挂着一句旧报错
    next.message = null;
    next.errorKind = null;
  }
  return next;
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
    case LOGIN_GATE_EVENT.qrRequested:
      return { ...state, qrAttempted: true, path: "qr", message: null, qr: initialQrState() };
    case LOGIN_GATE_EVENT.qr:
      return { ...state, qr: applyQrEvent(state.qr, event) };
    case LOGIN_GATE_EVENT.qrFailed:
      return {
        ...state,
        qr: {
          ...state.qr,
          status: QR_GATE_STATUS.failed,
          message: typeof event.message === "string" && event.message !== "" ? event.message : "二维码登录未能开始（详情见日志）",
          errorKind: typeof event.errorKind === "string" ? event.errorKind : null,
        },
      };
    case LOGIN_GATE_EVENT.started:
      return { ...state, busy: true, attempted: true, path: "official", message: null };
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
 * 该自动发起二维码吗？三条件缺一不可：
 * 1. 阶段是**确定的**"未登录"（`checking` 不发起：可能已有会话）；
 * 2. 不 busy（开窗那条路正在跑）；
 * 3. 本轮没发起过（重试是用户按出来的，不是自动重来）。
 */
export function shouldAutoStartQr(state) {
  if (state?.phase !== LOGIN_GATE_PHASE.loggedOut) return false;
  if (state.busy === true) return false;
  if (state.qrAttempted === true) return false;
  return true;
}

/** 失败之后能重试吗？（重试 = 再发一次 `auth:qr-start`，sidecar 会换一张新码） */
export function canRetryQr(state) {
  return state?.qr?.status === QR_GATE_STATUS.failed;
}

/** 官方页次要入口：只在"二维码这条路本身用不了"时出现，且别的时候不许出现。 */
export function shouldOfferOfficialFallback(state) {
  if (state?.qr?.status !== QR_GATE_STATUS.failed) return false;
  return OFFICIAL_FALLBACK_KINDS.includes(state.qr.errorKind);
}

/** 次要入口可用吗？（只要不在忙：用户重来一次是他的自由） */
export function canStartLogin(state) {
  return state?.busy !== true;
}

/**
 * 状态行文案（克制：一行，告诉用户现在是什么状态、下一步能做什么）。
 *
 * 优先级：**最新一次明确的失败/取消** → 会话阶段 → 当前那条路的状态。
 * 失败文案排最前是有意的：出错时用户最需要看到的就是那一句（而不是"正在准备二维码…"）。
 */
export function loginGateStatusLine(state) {
  if (typeof state?.message === "string" && state.message !== "") return state.message;
  if (state?.phase === LOGIN_GATE_PHASE.checking) return "正在检查登录状态…";
  if (state?.phase === LOGIN_GATE_PHASE.loggedIn) return "已登录。";

  // 官方页那条路（次要入口）跑起来时，说的是"窗已经开了"，而不是二维码现在到哪一步
  if (state?.path === "official") {
    return state.busy === true ? "已打开华为官方登录页，请在窗口中扫码…" : "官方登录页已收起（可以重试或再打开一次）";
  }

  const qr = state?.qr ?? initialQrState();
  switch (qr.status) {
    case QR_GATE_STATUS.preparing:
      return "正在准备二维码…";
    case QR_GATE_STATUS.pending:
      return QR_HINT_TEXT;
    case QR_GATE_STATUS.scanned:
      return "已扫码，请在手机上确认。";
    case QR_GATE_STATUS.confirmed:
      return "已确认，正在完成登录…";
    case QR_GATE_STATUS.expired:
      return "二维码已刷新，请重新扫码。";
    case QR_GATE_STATUS.failed:
      return qr.message ?? "二维码登录失败（详情见日志）";
    default:
      return "正在准备二维码…";
  }
}
