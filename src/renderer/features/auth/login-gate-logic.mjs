/**
 * 登录门禁的判定逻辑（纯函数，渲染层与测试 import 同一份）。
 *
 * 六条不变量：未登录绝不渲染 app-shell；自动发起只发生在确定未登录且没走网页那条路时；
 * 二维码状态只认 sidecar 广播；过期是终止档、只能手动刷新；失败必须可操作；两条路互斥且可回退。
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

/** 二维码在门禁里的阶段：pending/scanned/confirmed/expired/failed 与 sidecar 同值，preparing 是渲染层自己的一档。 */
export const QR_GATE_STATUS = {
  preparing: "preparing",
  pending: "pending",
  scanned: "scanned",
  confirmed: "confirmed",
  expired: "expired",
  failed: "failed",
};

const KNOWN_QR_STATUSES = Object.values(QR_GATE_STATUS);

/** 提示文字的唯一真源（界面与测试读同一句）。 */
export const QR_HINT_TEXT = "手机「控制中心」>「扫一扫」或者系统「设置」>「华为账号」>「扫一扫」。";

/** 页面标题的唯一真源，全页只出现一次。 */
export const LOGIN_GATE_TITLE = "华为账号登录";

/** 次要入口的文案（常驻，不再只在错误态出现）。 */
export const WEB_LOGIN_ENTRY_TEXT = "在网页中打开登录";

/** 次要入口的测试锚点（真窗守卫 `npm run verify:live` 按它点名这个入口）。 */
export const WEB_LOGIN_ENTRY_TESTID = "login-open-web";

/** 网页登录那条路开着时次要入口的变形文案——这一档点的是关窗，不是再打开一次。 */
export const WEB_LOGIN_BACK_TEXT = "返回扫码登录";

/** 变形之后的测试锚点（与"打开"分开，真窗守卫/测试才能各点各的）。 */
export const WEB_LOGIN_BACK_TESTID = "login-back-to-qr";

/** 按下入口后那一行「正在打开华为官方登录页…」：官方页还没画出来，先别让用户看一片白。 */
export const LOGIN_OPENING_TEXT = "正在打开华为官方登录页…";

/** 加载动画的测试锚点（真窗守卫按它点名这个转圈）。 */
export const LOGIN_OPENING_TESTID = "login-opening";

/** 二维码容器可点刷新的可达名字（容器本身就是那个按钮）。 */
export const QR_REFRESH_LABEL = "刷新二维码";

/** 刷新控件的测试锚点。 */
export const QR_REFRESH_TESTID = "login-qr-refresh";

/** 过期态里写在二维码原位的那句（遮罩是过期态唯一的提示载体）。 */
export const QR_EXPIRED_BOX_TEXT = "二维码已过期";

/** 过期占位的第二行：这块地方点得动（容器就是换码入口）。 */
export const QR_EXPIRED_BOX_HINT = "点击刷新";

/** 本地倒计时数到 0 时那一行：本地钟不是权威，所以只说正在确认。 */
export const QR_EXPIRING_TEXT = "正在确认过期…";

/** 倒计时的测试锚点（真窗守卫与标记测试按它点名那一行）。 */
export const QR_COUNTDOWN_TESTID = "login-qr-countdown";

/** 倒计时的步长（秒级；改它等于改倒计时的分辨率，界面文案跟着变）。 */
export const QR_COUNTDOWN_TICK_MS = 1_000;

/** 扫到之后那两句：状态行与二维码遮蔽层共用同一份常量。 */
export const QR_SCANNED_TEXT = "已扫码，请在手机上确认。";
export const QR_CONFIRMED_TEXT = "已确认，正在完成登录…";

/** 二维码遮蔽层的测试锚点。 */
export const QR_MASK_TESTID = "login-qr-mask";

/** 网页那条路收场、广播里却没带文案时的兜底说明（"刚退回来"这个标记永远不为空）。 */
export const OFFICIAL_ENDED_NOTE = "网页登录已结束（没有完成登录）。";

/** 状态机认得的事件。 */
export const LOGIN_GATE_EVENT = {
  /** `auth:status` 广播：`{loggedIn, busy, message?}` */
  status: "status",
  /**
   * 「恢复中」应答 `{restoring:true}`：**不是**结论，reducer 原样保持当前态
   * （`checking` 仍是中性启动屏，不画登录页、不武装自动发起）。
   */
  restoring: "restoring",
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
  /** 渲染层自己的钟走了一秒（倒计时用）。 */
  tick: "tick",
};

/** 二维码的初始态：还没发起（`preparing` = "正在准备二维码…"）。 */
function initialQrState() {
  return {
    status: QR_GATE_STATUS.preparing,
    content: null,
    expiresInMs: null,
    /** 到期时刻（本地钟）：存绝对时刻而非剩余毫秒，倒计时就是「它减现在」。 */
    expiresAt: null,
    /** 渲染层当前采到的钟（每秒一次的 `tick` 事件喂进来；只在有 `expiresAt` 时才走） */
    nowMs: null,
    message: null,
    errorKind: null,
  };
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
    /** 当前走的是哪条路：`"qr"`（默认）/ `"official"`（网页登录那条路）。状态行按它说人话 */
    path: null,
    /** 网页那条路收场时留下的一句话，等新二维码到了再退场。 */
    officialNote: null,
  };
}

/**
 * 网页那条路收场 → 回到二维码态，并重新武装自动发起。
 * `officialNote` 永远不为空：既是给用户看的说明，也是渲染层判断该重新发码的标记。
 */
function returnToQr(state, note) {
  return {
    ...state,
    path: "qr",
    busy: false,
    message: null,
    qrAttempted: false,
    qr: initialQrState(),
    officialNote: typeof note === "string" && note !== "" ? note : OFFICIAL_ENDED_NOTE,
  };
}

/** "网页那条路的收场广播"的判据：busy 落下来 **且带一句给人看的话**（见不变量 6）。 */
function isOfficialFinish(state, event) {
  if (state?.path !== "official") return false;
  if (event?.busy === true || event?.loggedIn === true) return false;
  return typeof event?.message === "string" && event.message !== "";
}

/**
 * 过期倒计时：只显示「还剩多久」，不参与过期判定，位置在二维码下方而非状态行里。
 * 本地归零不是过期，码留在屏上等服务端那条 `expired` 广播收口。
 *
 * @param {object} state 门禁状态
 * @returns {string|null} 要显示的那一行；没有可数的东西时 `null`（界面少一行，不是显示"剩 0 秒"）
 */
export function qrCountdownText(state) {
  const qr = state?.qr;
  if (qr?.status !== QR_GATE_STATUS.pending) return null;
  if (typeof qr.expiresAt !== "number" || typeof qr.nowMs !== "number") return null;
  const remainingMs = qr.expiresAt - qr.nowMs;
  if (remainingMs <= 0) return QR_EXPIRING_TEXT;
  return `剩 ${Math.ceil(remainingMs / 1000)} 秒过期`;
}

/**
 * 把渲染层的钟喂进来，倒计时每秒推进一格。
 * 钳在到期时刻：本地数到 0 后返回同一个状态对象，React 不再重渲染。
 */
function tickQrClock(qr, nowMs) {
  if (typeof nowMs !== "number" || qr.expiresAt === null) return qr;
  const clamped = Math.min(nowMs, qr.expiresAt);
  if (clamped === qr.nowMs) return qr;
  return { ...qr, nowMs: clamped };
}

function applyQrEvent(qr, event) {
  const status = event?.status;
  // 认不出的档位不猜：保持原状态（陌生档位当"已确认"= 拿一个没确认的会话去换令牌）
  if (typeof status !== "string" || !KNOWN_QR_STATUSES.includes(status)) return qr;
  const next = { ...qr, status };
  if (typeof event.content === "string" && event.content !== "") next.content = event.content;
  if (typeof event.expiresInMs === "number") next.expiresInMs = event.expiresInMs;
  if (status === QR_GATE_STATUS.pending) {
    // 建单应答/广播里的有效期 → 本地到期时刻（`at` 由调用方注入）。
    // 两样缺一就不编造：宁可不显示倒计时，也不显示一个数不准的。
    const at = event.at;
    if (typeof event.expiresInMs === "number" && typeof at === "number") {
      next.expiresAt = at + event.expiresInMs;
      next.nowMs = at;
    } else {
      next.expiresAt = null;
      next.nowMs = null;
    }
  } else {
    // 只有"等扫码"那一档才有倒计时：扫到了/确认了/过期了/失败了都不该再数
    next.expiresAt = null;
    next.nowMs = null;
  }
  if (status === QR_GATE_STATUS.expired) {
    // 屏幕上那张码已经扫不动了，留着一张死码是最坏的一种「没反应」。
    // 当场撤掉，等用户点刷新。
    next.content = null;
    next.expiresInMs = null;
  }
  if (status === QR_GATE_STATUS.failed) {
    next.message = typeof event.message === "string" && event.message !== "" ? event.message : "二维码登录失败（详情见日志）";
    next.errorKind = typeof event.errorKind === "string" ? event.errorKind : null;
  } else {
    // 非失败档位要把上一次的错误清掉：否则"二维码已过期"上面还挂着一句旧报错
    next.message = null;
    next.errorKind = null;
  }
  return next;
}

/**
 * 一份 `auth:status` 形状的载荷 → 门禁事件（唯一一处映射，广播回调与应答都经它）。
 * `restoring:true` 走自己那条事件：它跟 `loggedIn:false` 长得像，含义却是"还不知道"。
 */
export function statusEventOf(payload) {
  if (payload?.restoring === true) return { type: LOGIN_GATE_EVENT.restoring };
  return {
    type: LOGIN_GATE_EVENT.status,
    loggedIn: payload?.loggedIn === true,
    busy: payload?.busy === true,
    message: typeof payload?.message === "string" ? payload.message : undefined,
  };
}

/** 事件 → 新状态（纯函数：不改写入参，未知事件原样返回）。 */
export function reduceGateState(state, event) {
  const type = event?.type;
  switch (type) {
    case LOGIN_GATE_EVENT.restoring:
      // 「恢复中」= 还没有结论：原样返回，已落定的结论不许被一条迟到的事件推回启动屏
      return state;
    case LOGIN_GATE_EVENT.status: {
      const loggedIn = event.loggedIn === true;
      const base = {
        ...state,
        phase: loggedIn ? LOGIN_GATE_PHASE.loggedIn : LOGIN_GATE_PHASE.loggedOut,
        busy: event.busy === true,
        // 广播里带文案就用它（失败原因），没带就保留本地那条（别把用户刚看到的说明抹掉）
        message: loggedIn ? null : (event.message ?? state.message),
      };
      // 网页那条路收场（判据看的是**旧状态**的 path：base 里 phase 已经翻过面了）
      if (isOfficialFinish(state, event)) return returnToQr(base, event.message);
      return base;
    }
    case LOGIN_GATE_EVENT.qrRequested:
      return { ...state, qrAttempted: true, path: "qr", message: null, qr: initialQrState() };
    /** 每秒一次的钟（倒计时唯一的驱动力）。没有可数的到期时刻时原样返回，不重渲染。 */
    case LOGIN_GATE_EVENT.tick: {
      const qr = tickQrClock(state.qr, event.nowMs);
      return qr === state.qr ? state : { ...state, qr };
    }
    case LOGIN_GATE_EVENT.qr: {
      const qr = applyQrEvent(state.qr, event);
      // 新二维码真的到了（pending 带内容）：网页那条路留下的那句话可以退场了
      const landed = qr.status === QR_GATE_STATUS.pending && qr.content !== null;
      return {
        ...state,
        qr,
        officialNote: landed ? null : state.officialNote,
      };
    }
    case LOGIN_GATE_EVENT.qrFailed:
      return {
        ...state,
        qr: {
          ...state.qr,
          status: QR_GATE_STATUS.failed,
          // 连内容带倒计时一起清掉：这一档没有码，也就没有"还剩多久"可数（表要停）
          content: null,
          expiresInMs: null,
          expiresAt: null,
          nowMs: null,
          message: typeof event.message === "string" && event.message !== "" ? event.message : "二维码登录未能开始（详情见日志）",
          errorKind: typeof event.errorKind === "string" ? event.errorKind : null,
        },
      };
    case LOGIN_GATE_EVENT.started:
      // 走网页那条路：清掉上一轮的说明（这次是用户自己按的），二维码会话由 sidecar 停掉
      return { ...state, busy: true, attempted: true, path: "official", message: null, officialNote: null };
    case LOGIN_GATE_EVENT.succeeded:
      return { ...state, phase: LOGIN_GATE_PHASE.loggedIn, busy: false, message: null };
    case LOGIN_GATE_EVENT.failed: {
      if (state?.path === "official") return returnToQr(state, event.message);
      return { ...state, busy: false, message: event.message ?? "登录未完成（详情见日志）" };
    }
    case LOGIN_GATE_EVENT.cancelled: {
      // 与 `failed` 同一条规矩：取消"网页那条路"= 那条路收场 → 回二维码态并重新发码。
      // （留在 official 上而 busy 已落，会让入口变回"打开"形态——窗若还开着就又没人可点）
      const message = event.message ?? "已取消登录（可以重新打开官方登录页）";
      if (state?.path === "official") return returnToQr(state, message);
      return { ...state, busy: false, message };
    }
    default:
      return state;
  }
}

/**
 * 「正在打开华为官方登录页…」这一档现在显不显示。
 * 判据是「用户按出来的」且「它还在跑」，同时驱动状态行文案与旁边那个转圈。
 *
 * @param {object} state 门禁状态
 * @returns {{showing: boolean, text: string}} `text` 恒为 [`LOGIN_OPENING_TEXT`]（唯一真源）
 */
export function loginOpeningIndicator(state) {
  return {
    showing: state?.busy === true && state?.path === "official",
    text: LOGIN_OPENING_TEXT,
  };
}

/** 该显示门禁吗？（`phase` 不是"已登录"就显示门禁，包括"还不知道"） */
export function shouldShowLoginGate(state) {
  return state?.phase !== LOGIN_GATE_PHASE.loggedIn;
}

/**
 * 该自动发起二维码吗？阶段确定未登录、不 busy、本轮没发起过、不在网页那条路上。
 * 过期不会重新武装它：换新只能来自用户点击（[`canRefreshQr`]）。
 */
export function shouldAutoStartQr(state) {
  if (state?.phase !== LOGIN_GATE_PHASE.loggedOut) return false;
  if (state.busy === true) return false;
  if (state.qrAttempted === true) return false;
  if (state.path === "official") return false;
  return true;
}

/** 失败之后能重试吗？（重试 = 再发一次 `auth:qr-start`，sidecar 会换一张新码） */
export function canRetryQr(state) {
  return state?.qr?.status === QR_GATE_STATUS.failed;
}

/**
 * 二维码容器现在点得动吗？点击的语义就是 `auth:qr-start`，判据是「再发一次有意义」。
 * 过期态这里是唯一的换码路径；`preparing`/`scanned`/`confirmed` 与网页那条路都点不动。
 */
export function canRefreshQr(state) {
  if (state?.path === "official") return false;
  const status = state?.qr?.status;
  if (status === QR_GATE_STATUS.pending) return true;
  if (status === QR_GATE_STATUS.expired || status === QR_GATE_STATUS.failed) return true;
  return false;
}

/**
 * 二维码上要不要盖遮蔽层：要盖就返回盖上去的那句话，不盖返回 `null`。
 * 只认 `scanned`/`confirmed` 两档，遮蔽与不可点两条一起处置。
 *
 * @param {object} state 门禁状态
 * @returns {string|null} 遮蔽层上那句文案；`null` = 这一档不盖
 */
export function qrMaskText(state) {
  const status = state?.qr?.status;
  if (status === QR_GATE_STATUS.scanned) return QR_SCANNED_TEXT;
  if (status === QR_GATE_STATUS.confirmed) return QR_CONFIRMED_TEXT;
  return null;
}

/**
 * 次要入口现在是什么形态：`"open"`（打开网页登录）还是 `"back"`（返回扫码登录）。
 * 判据是 [`canStartLogin`]（`busy` 是 sidecar 的事实），两种形态都可点。
 */
export function webLoginEntry(state) {
  if (!canStartLogin(state)) {
    return { form: "back", text: WEB_LOGIN_BACK_TEXT, testid: WEB_LOGIN_BACK_TESTID, disabled: false };
  }
  return { form: "open", text: WEB_LOGIN_ENTRY_TEXT, testid: WEB_LOGIN_ENTRY_TESTID, disabled: false };
}

/**
 * 「网页那条路现在没在跑」吗？它同时是次要入口形态的判据。
 * 为假时入口是「返回扫码登录」：窗开着，用户需要的是关掉它而不是再打开一次。
 */
export function canStartLogin(state) {
  return state?.busy !== true;
}

/** 画面要画的那串内容（没有就是 `null`：界面给同尺寸的占位）。 */
export function qrContentOf(state) {
  const content = state?.qr?.content;
  return typeof content === "string" && content !== "" ? content : null;
}

/**
 * 状态行文案：一行，告诉用户现在是什么状态、下一步能做什么；`null` = 不显示该行。
 * 优先级：最新一次失败/取消 → 会话阶段 → 网页那条路刚收场的那句话 → 当前路的状态。
 * `expired` 这一档不说话，遮罩是它唯一的提示载体；倒计时也不进这一行。
 *
 * @param {object} state 门禁状态
 * @returns {string|null} 要显示的那一行；`null` = 这一档不显示状态行
 */
export function loginGateStatusLine(state) {
  if (typeof state?.message === "string" && state.message !== "") return state.message;
  if (state?.phase === LOGIN_GATE_PHASE.loggedIn) return "已登录。";

  // 刚从网页那条路退回来、新码还没到：先说清楚那条路是怎么结束的
  if (typeof state?.officialNote === "string" && state.officialNote !== "") return state.officialNote;

  if (state?.phase === LOGIN_GATE_PHASE.checking) return "正在检查登录状态…";

  // 官方页还在加载（页还在屏外）→ 如实说"正在打开"
  if (loginOpeningIndicator(state).showing) return LOGIN_OPENING_TEXT;

  // 官方页那条路（次要入口）跑起来时，说的是"窗已经开了"，而不是二维码现在到哪一步
  if (state?.path === "official") {
    return state.busy === true ? "已在网页中打开登录。" : "官方登录页已收起（可以再打开一次）";
  }

  const qr = state?.qr ?? initialQrState();
  switch (qr.status) {
    case QR_GATE_STATUS.preparing:
      return "正在准备二维码…";
    case QR_GATE_STATUS.pending:
      // 提示文字已经在上一条把"怎么扫"说完了：这里只说"现在在等什么"
      return "等待扫码…";
    case QR_GATE_STATUS.scanned:
      return QR_SCANNED_TEXT;
    case QR_GATE_STATUS.confirmed:
      return QR_CONFIRMED_TEXT;
    case QR_GATE_STATUS.expired:
      // 终止档且提示已经在二维码遮罩上了——状态行整行隐掉，不复述
      return null;
    case QR_GATE_STATUS.failed:
      return qr.message ?? "二维码登录失败（详情见日志）";
    default:
      return "正在准备二维码…";
  }
}
