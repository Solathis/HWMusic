/**
 * 登录门禁的判定逻辑（纯函数，.mjs 是有意的：渲染层与测试 import 同一份，不经过 JSX/打包）。
 *
 * R16 起引导页的形态变了（用户指令）：**只展示二维码和提示文字**，进页面自动发起二维码会话，
 * 界面上没有"开始扫码"这类按钮；只有出错时才出现"重试"（R18 又加了一个常驻的次要入口，见下）。
 *
 * R18（用户指令 2026-10-20）又改了五件事，都落在本文件里：
 * 1. 提示文案换成手机控制中心/设置那两条路径那句（[`QR_HINT_TEXT`] 唯一真源），
 *    **状态行不再复述它**（pending 那一档说"等待扫码…"，免得同一句话在页面上出现两次）；
 * 2. 二维码容器带边框（视觉在 `login-gate.tsx`，是令牌工具类，这里不掺）；
 * 3. 过期仍由 sidecar 自动换新（第 4 条不变量不变），渲染层只需要"新内容到了就换"；
 * 4. **"在网页中打开登录"是常驻次要入口**（`WEB_LOGIN_ENTRY_TEXT`）——不再"只在协议不可用时
 *    出现"；与二维码互斥：发起时 path 转 `official`（自动发起与重试都停），那条路收场之后
 *    回到二维码态并**重新武装自动发起**（`officialNote` 记一句"它为什么结束了"）；
 * 5. 标题移到二维码正上方（[`LOGIN_GATE_TITLE`] 唯一真源，全页只出现一次）。
 *
 * 六条不变量：
 * 1. **未登录绝不渲染 app-shell**：`shouldShowLoginGate` 为真时，外层必须先渲染门禁；
 *    "还不知道"（`checking`：等 `auth:status` 的第一条广播）也按门禁处理。
 * 2. **自动开始只发生在"确定未登录"且没走网页那条路**：`shouldAutoStartQr` 要求四条件齐备
 *    （门禁内的确定态、不 busy、本轮未发起、`path` 不是 `official`）。检查中就发起 =
 *    可能覆盖已有登录态；网页那条路在跑时发起 = 两条路并发（各换一次码）。
 * 3. **二维码状态只认广播**：`auth:qr`（sidecar 建的会话）是唯一来源；认不出的档位**不猜**，
 *    保持原状态（陌生档位当成"已确认"是最严重的误判）。
 * 4. **过期由 sidecar 自动换新**：渲染层只把状态行改成"二维码已刷新"，不自己再发一次请求
 *    （谁持有轮询状态谁负责续期，界面不做协议）；新内容到了自然就换了画面。
 * 5. **失败必须可操作**：可重试（`canRetryQr`）；常驻入口在"开窗那条路没在跑"时永远可点
 *    （`canStartLogin`）——R17 抓到过"最需要它的场景里它恰好被禁用"这类坑，所以 `busy`
 *    只描述开窗那条路，二维码等待期间**不占** `busy`。
 * 6. **两条路互斥且可回退**：`path === "official"` 期间不建二维码订单；那条路收场
 *    （`busy` 落下来 **且带一句给人看的话**）时回到二维码态、重新武装自动发起。
 *    只认"带话的收场"是有原因的：二维码会话自己也会播 `busy:false`（没有文案），
 *    把它当成"网页那条路结束了"会让界面在窗还开着的时候跳回二维码。
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

/** 提示文字的唯一真源（界面与测试读同一句）。R18 按用户指令换成"两条路径"那句。 */
export const QR_HINT_TEXT = "手机「控制中心」>「扫一扫」或者系统「设置」>「华为账号」>「扫一扫」。";

/** 页面标题的唯一真源（R18：标题在二维码正上方，全页只出现一次——header 里那份已移除）。 */
export const LOGIN_GATE_TITLE = "华为账号登录";

/** 次要入口的文案（R18：常驻，不再只在错误态出现）。 */
export const WEB_LOGIN_ENTRY_TEXT = "在网页中打开登录";

/** 次要入口的测试锚点（真窗守卫 `npm run verify:live` 按它点名这个入口）。 */
export const WEB_LOGIN_ENTRY_TESTID = "login-open-web";

/** 网页那条路收场、广播里却没带文案时的兜底说明（"刚退回来"这个标记永远不为空）。 */
export const OFFICIAL_ENDED_NOTE = "网页登录已结束（没有完成登录）。";

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
    /** 当前走的是哪条路：`"qr"`（默认）/ `"official"`（网页登录那条路）。状态行按它说人话 */
    path: null,
    /**
     * 网页那条路收场时留下的一句话（R18）：回到二维码态之后先说清楚"它怎么了"，
     * 等新二维码真的到了（`pending` 带内容）再退场。
     */
    officialNote: null,
  };
}

/**
 * 网页那条路收场 → 回到二维码态。
 *
 * 重新武装自动发起（`qrAttempted: false`）是有意的：用户关掉登录窗之后，眼前应该重新出现
 * 一张能扫的码，而不是让他自己去按什么东西（简报给的两个选项里选了"重新 qr-start"）。
 *
 * `officialNote` **永远不为空**：它既是给用户看的那句"那条路怎么了"，也是渲染层判断
 * "这一轮该重新发码"的标记（`useAuthGate` 的自动发起 effect 读它）。
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
    case LOGIN_GATE_EVENT.qr: {
      const qr = applyQrEvent(state.qr, event);
      // 新二维码真的到了（pending 带内容）：网页那条路留下的那句话可以退场了
      const landed = qr.status === QR_GATE_STATUS.pending && qr.content !== null;
      return { ...state, qr, officialNote: landed ? null : state.officialNote };
    }
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
      // 走网页那条路：清掉上一轮的说明（这次是用户自己按的），二维码会话由 sidecar 停掉
      return { ...state, busy: true, attempted: true, path: "official", message: null, officialNote: null };
    case LOGIN_GATE_EVENT.succeeded:
      return { ...state, phase: LOGIN_GATE_PHASE.loggedIn, busy: false, message: null };
    case LOGIN_GATE_EVENT.failed: {
      if (state?.path === "official") return returnToQr(state, event.message);
      return { ...state, busy: false, message: event.message ?? "登录未完成（详情见日志）" };
    }
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
 * 该自动发起二维码吗？四条件缺一不可：
 * 1. 阶段是**确定的**"未登录"（`checking` 不发起：可能已有会话）；
 * 2. 不 busy（网页那条路正在跑）；
 * 3. 本轮没发起过（重试是用户按出来的，不是自动重来）；
 * 4. 当前不在网页那条路上（R18：两条路互斥，别在窗里又建一张码）。
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
 * 常驻次要入口可用吗？（R18）
 *
 * 只有"网页那条路正在跑"时禁用（那时再点一次只会撞上 `login_in_progress`）。
 * 二维码在准备/等待/过期/失败**都不占** busy，所以这些档位下入口一直点得动。
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
 * 状态行文案（克制：一行，告诉用户现在是什么状态、下一步能做什么）。
 *
 * 优先级：**最新一次明确的失败/取消** → 会话阶段 → **网页那条路刚收场留下的那句话** →
 * 当前那条路的状态。失败文案排最前是有意的：出错时用户最需要看到的就是那一句
 * （而不是"正在准备二维码…"）。
 */
export function loginGateStatusLine(state) {
  if (typeof state?.message === "string" && state.message !== "") return state.message;
  if (state?.phase === LOGIN_GATE_PHASE.loggedIn) return "已登录。";

  // 刚从网页那条路退回来、新码还没到：先说清楚那条路是怎么结束的
  // （排在"正在检查登录状态…"之前：那句话是"还不知道"，而这句是**刚发生的事**）
  if (typeof state?.officialNote === "string" && state.officialNote !== "") return state.officialNote;

  if (state?.phase === LOGIN_GATE_PHASE.checking) return "正在检查登录状态…";

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
      return "已扫码，请在手机上确认。";
    case QR_GATE_STATUS.confirmed:
      return "已确认，正在完成登录…";
    case QR_GATE_STATUS.expired:
      // 短暂档：sidecar 紧接着就会播新的 pending（几秒内），之后回到"等待扫码…"
      return "二维码已刷新，请重新扫码。";
    case QR_GATE_STATUS.failed:
      return qr.message ?? "二维码登录失败（详情见日志）";
    default:
      return "正在准备二维码…";
  }
}
