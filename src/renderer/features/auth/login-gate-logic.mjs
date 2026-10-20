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
 * 4. **过期由用户手动刷新**（R21 用户指令，**推翻** R16/R20 的"过期自动换新"）：`expired`
 *    是一条**终止**档——sidecar 停轮询、不建新单，本层撤掉旧码并显示"已过期，点击刷新"。
 *    本地还有一个秒级倒计时（[`qrCountdownText`]），但它只负责**显示**：过期判定一律以
 *    sidecar 那条 `expired` 广播为权威（本地归零只说"正在确认过期…"）。
 * 5. **失败必须可操作**：可重试（`canRetryQr`）；常驻入口在"开窗那条路没在跑"时永远可点
 *    （`canStartLogin`）——R17 抓到过"最需要它的场景里它恰好被禁用"这类坑，所以 `busy`
 *    只描述开窗那条路，二维码等待期间**不占** `busy`。
 * 6. **两条路互斥且可回退**：`path === "official"` 期间不建二维码订单；那条路收场
 *    （`busy` 落下来 **且带一句给人看的话**）时回到二维码态、重新武装自动发起。
 *    只认"带话的收场"是有原因的：二维码会话自己也会播 `busy:false`（没有文案），
 *    把它当成"网页那条路结束了"会让界面在窗还开着的时候跳回二维码。
 *
 * R20（用户真机验收反馈三项，2026-10-20）又加了三件事：
 * 1. **过期码绝不留在屏上**（`applyQrEvent` 的 expired 分支撤掉 content）：留在屏上的旧码
 *    是"扫了没反应"的死码——用户会以为是自己手机的问题；
 * 2. **过期提示要可感知**（`qrNotice` + `QR_REFRESH_NOTICE`）：sidecar 换新只隔一次
 *    `create` 请求，原来那句提示在新 `pending` 到达的瞬间就被"等待扫码…"顶掉（用户看不见）。
 *    现在它**挺过**那一跳，直到下次扫码状态变化（scanned/confirmed/failed）或用户自己动手；
 * 3. **二维码容器可点刷新**（[`canRefreshQr`]）：过期不必靠"重试"按钮，容器本身就是那个控件
 *    （键盘可达，可达名字 [`QR_REFRESH_LABEL`]）；点击 = `startQr`（与自动发起同一条路）。
 *
 * R21（用户指令 2026-10-20，**推翻 R16/R20 的"过期自动换新"**）改了三条，R20 的第 2 条随之删除：
 * 1. **过期倒计时**：`expiresInMs` 由建单应答/`auth:qr` 广播带过来，本层把它换算成**到期时刻**
 *    （`event.at + expiresInMs`，`at` 由调用方注入），显示文案由 [`qrCountdownText`] 从
 *    "现在几点"（每秒一次的 `tick` 事件）算出来。**钟在渲染层，权威在服务端**：本地数到 0
 *    只是「正在确认过期…」（[`QR_EXPIRING_TEXT`]），既不撤码也不改档——过期判定只认
 *    sidecar 那条 `expired` 广播（实测 TTL 181s、t+177.4s 收到 `103000201`，服务端通常
 *    早于本地归零，所以这一档是罕见的兜底）；
 * 2. **过期态不可扫**：`expired` 到达撤掉 content（R20 的裁决继续成立）+ 界面写
 *    [`QR_EXPIRED_BOX_TEXT`]，状态行说 [`QR_EXPIRED_NOTICE`]——过期是一条**终止**档；
 * 3. **只能手动刷新**：过期**不**重新武装自动发起（`shouldAutoStartQr` 在这一档为假，
 *    sidecar 也不再自己建单，见 `src/protocols/qr-login.mjs`）；刷新由用户点击触发
 *    （二维码容器，或过期态那个显著的「刷新二维码」按钮 → 都是 `startQr`）。
 *    因为不再有"刚自动换过一张"这一刻，R20 的 `qrNotice` / `QR_REFRESH_NOTICE` **整条删除**。
 *
 * 诊断依据（可复现：`node scripts/probe-qr.mjs --until-expired`，摘要 `.probe/qr-expiry-diag.json`）：
 * 服务端**会**给出过期档位——TTL 181s，实测 t+177.4s 时 `103000200` → `103000201`，
 * 过期之后重新建单照常下发新码（R21 起这件事改为**用户点刷新**时才做）。
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

/**
 * 网页登录那条路开着时，次要入口**变形的文案**（R20 要求 3）。
 *
 * "打开"与"返回"是两件事，用同一句话表示会让用户以为点了没用：窗已经开着，再点一次
 * `auth:login` 只会撞上 `login_in_progress`。这一档点的必须是 `auth:cancel-login`（关窗）。
 */
export const WEB_LOGIN_BACK_TEXT = "返回扫码登录";

/** 变形之后的测试锚点（与"打开"分开，真窗守卫/测试才能各点各的）。 */
export const WEB_LOGIN_BACK_TESTID = "login-back-to-qr";

/**
 * 二维码容器可点刷新的**可达名字**（R20 要求 2）。
 *
 * 容器本身是个 `<button>`：不写这一条，读屏与键盘用户只会听到"按钮"两个字，
 * 而它做的事（换一张新码）在页面上没有任何文字说明。
 */
export const QR_REFRESH_LABEL = "刷新二维码";

/** 刷新控件的测试锚点。 */
export const QR_REFRESH_TESTID = "login-qr-refresh";

/**
 * 过期提示（R20 要求 2，R21 改写）：**过期是一条终止档**，界面上说的是"该怎么办"。
 *
 * R20 那句是「二维码已刷新，请重新扫码。」——那时 sidecar 会自动换一张，提示的使命是
 * "挺过新码到达的那一跳"。R21 按用户指令删掉自动换新，于是不再有"刚换过"这一刻，
 * 这句话连同 `qrNotice` 一起删除；现在说过期，并直接给出唯一的出路（点击刷新）。
 */
export const QR_EXPIRED_NOTICE = "二维码已过期，点击刷新。";

/**
 * 过期态里写在二维码**原位**的那句（R21 要求 2）。
 *
 * 与状态行那句分开是有意的：原位那句是"这块地方现在是什么"（二维码没了、它过期了），
 * 状态行那句是"你该做什么"。画布位置不留任何可扫的东西——留着死码是最坏的一种"没反应"。
 */
export const QR_EXPIRED_BOX_TEXT = "二维码已过期";

/**
 * 本地倒计时数到 0 时那一行（R21 要求 1）。
 *
 * 为什么不改成"已过期"：本地钟不是权威。服务端实测在本地归零前就给 `expired`
 * （TTL 181s、t+177.4s 观测到），所以这一档只在"那条广播还没到"的窗口里出现——
 * 说"正在确认"是诚实的，说"已过期"则是在替服务端下结论（万一它还没过期呢）。
 */
export const QR_EXPIRING_TEXT = "正在确认过期…";

/** 倒计时的测试锚点（真窗守卫与标记测试按它点名那一行）。 */
export const QR_COUNTDOWN_TESTID = "login-qr-countdown";

/** 过期态那个显著的「刷新二维码」按钮的测试锚点（文案复用 [`QR_REFRESH_LABEL`]）。 */
export const QR_REFRESH_ACTION_TESTID = "login-qr-refresh-action";

/** 倒计时的步长（秒级；改它等于改倒计时的分辨率，界面文案跟着变）。 */
export const QR_COUNTDOWN_TICK_MS = 1_000;

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
  /** 渲染层自己的钟走了一秒（R21 倒计时；`nowMs` 由调用方注入，纯函数里不读真实时钟） */
  tick: "tick",
};

/** 二维码的初始态：还没发起（`preparing` = "正在准备二维码…"）。 */
function initialQrState() {
  return {
    status: QR_GATE_STATUS.preparing,
    content: null,
    expiresInMs: null,
    /**
     * 到期时刻（本地钟，R21）：`= 事件发生时刻 at + expiresInMs`。倒计时就是
     * "它减现在"，所以存的是**绝对时刻**而不是"还剩多少毫秒"——后者要每秒改一次状态，
     * 而且 tick 迟到/丢一次就永远数不准。
     */
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

/**
 * 过期倒计时（R21 要求 1）：**只**显示"还剩多久"，不参与过期判定。
 *
 * 位置选在二维码**下方**（而不是状态行里）：状态行是"现在到哪一步"的唯一真源，
 * 而倒计时每一秒都在变——混进状态行会让"等待扫码…"这句恒定的说明被数字淹掉，
 * 也会让状态行的断言变得没法写。界面上两行各司其职：
 *
 * ```
 *   [二维码]
 *   剩 179 秒过期        ← 本函数（只在"码在屏上等着被扫"那一档出现）
 *   手机「控制中心」>「扫一扫」…。
 *   等待扫码…            ← 状态行
 * ```
 *
 * 本地归零（[`QR_EXPIRING_TEXT`]）**不是**过期：那一刻只是"该过期了"，码留在屏上等
 * 服务端那条 `expired` 广播收口（它是唯一权威；实测它在本地归零前就到了）。
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
 * 倒计时每秒推进一次的那一格（R21）：把渲染层的钟喂进来。
 *
 * 钳在到期时刻：本地数到 0 之后就**不再变化**，reducer 因此返回同一个状态对象，
 * React 也就不再重渲染（表停了，而不是每秒白跑一次渲染直到服务端收口）。
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
    // R21：建单应答/广播里的有效期 → 本地到期时刻（`at` 是事件发生时刻，由调用方注入）。
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
    // R20 要求 2 / R21 要求 2：屏幕上那张已经**扫不动**了。留着一张死码是最坏的一种"没反应"
    // ——用户会反复对着它扫，然后以为是自己手机/网络的问题。当场撤掉，等用户点刷新。
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
    /** R21：每秒一次的钟（倒计时唯一的驱动力）。没有可数的到期时刻时**原样返回**（不重渲染）。 */
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
 *
 * R21：**过期不会重新武装它**——`qrRequested`/`returnToQr` 之外没有任何一条路把
 * `qrAttempted` 打回 false，所以过期之后页面不会自己再发一次 `auth:qr-start`；
 * 换新只能来自用户点击（[`canRefreshQr`] 那一档）。
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
 * 二维码容器现在点得动吗？（R20 要求 2 / R21 要求 3：过期与等待时不必去找"重试"按钮）
 *
 * 点击的语义就是 `startQr`（= `auth:qr-start`，sidecar 会停掉旧会话、换一张新码），
 * 所以"点得动"的判据是"再发一次有意义"：
 * - `pending`/`scanned`：有码在屏上，换一张是用户明确想要的（旧的那张他不想扫了）；
 * - `expired`：**R21 起这里是唯一的换码路径**（sidecar 不再自动换新）——过期态那张已经废了，
 *   点容器或点那个显著的「刷新二维码」按钮都是"再来一张"；
 * - `failed`：与「重试」同一件事（两个入口都留着，用户按哪个都行）；
 * - `preparing`：已经有一次请求在飞，再点一次只是**重复建单**（还会白白换掉马上要到的码）；
 * - `confirmed`：正在换码，这时换一张新码只会把已经成功的那次作废；
 * - 网页那条路开着：那层被窗盖住（点不到），而且此刻不该建第二张码（两条路互斥，不变量 6）。
 */
export function canRefreshQr(state) {
  if (state?.path === "official") return false;
  const status = state?.qr?.status;
  if (status === QR_GATE_STATUS.pending || status === QR_GATE_STATUS.scanned) return true;
  if (status === QR_GATE_STATUS.expired || status === QR_GATE_STATUS.failed) return true;
  return false;
}

/**
 * 次要入口现在是什么形态（R20 要求 3）：`"open"`（打开网页登录）还是 `"back"`（返回扫码登录）。
 *
 * 判据是 [`canStartLogin`]（= "那条路没在跑"），**不是** `path === "official"`：`path` 是渲染层
 * 这一次点击留下的本地猜测，渲染层 reload / 崩溃重启之后就没了——而那时窗很可能还开着
 * （`auth:get-status` 的应答会说 `busy:true`），恰恰是用户最需要这条返回路径的时刻。
 * `busy` 是 sidecar 自己的事实（R19 起查询与广播同源），所以形态跟着它走。
 *
 * 两种形态都**可点**（`disabled: false`）：打开与返回各自是那一刻唯一该做的事。
 * R17 抓过的那类坑正是"最需要某个控件时它恰好是灰的"，这里不再留任何一个灰的入口。
 *
 * 为什么要有"返回"这一档：走网页那条路时子窗**铺满内容区**（顶部只留 48px header），
 * 正文里的一切（包括原来那个入口）都在窗底下——点不到。用户唯一能碰到的就是那条 header，
 * 所以这一档的入口要挪进 header，点它走 `auth:cancel-login`（窗在 Rust 手里，只有它能拆）。
 */
export function webLoginEntry(state) {
  if (!canStartLogin(state)) {
    return { form: "back", text: WEB_LOGIN_BACK_TEXT, testid: WEB_LOGIN_BACK_TESTID, disabled: false };
  }
  return { form: "open", text: WEB_LOGIN_ENTRY_TEXT, testid: WEB_LOGIN_ENTRY_TESTID, disabled: false };
}

/**
 * "网页那条路现在没在跑"吗？（R18 立、R20 扩用：它同时是次要入口**形态**的判据）
 *
 * `busy` 只描述开窗那条路（二维码在准备/等待/过期/失败**都不占** busy），所以：
 * - 它为真时，入口是「在网页中打开登录」（发起那条路）；
 * - 它为假时，入口是「返回扫码登录」（见 `webLoginEntry`）——eq. 窗开着，正文被盖住，
 *   用户需要的不是"再打开一次"（那只会撞上 `login_in_progress`）而是"关掉它"。
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
 * （而不是"正在准备二维码…"）；`officialNote` 排在"现状"之前，理由同 R19：
 * 它说的是**刚刚发生了什么**，而"正在检查登录状态…"只是"还不知道"。
 *
 * R21：倒计时**不进这一行**（它在二维码下方自成一行，见 [`qrCountdownText`]）；
 * `expired` 那一档说的是 [`QR_EXPIRED_NOTICE`]（"已过期，点击刷新"）——它现在是一条
 * **终止**档（不再跟着一条新 pending）。
 */
export function loginGateStatusLine(state) {
  if (typeof state?.message === "string" && state.message !== "") return state.message;
  if (state?.phase === LOGIN_GATE_PHASE.loggedIn) return "已登录。";

  // 刚从网页那条路退回来、新码还没到：先说清楚那条路是怎么结束的
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
      // R21：终止档——不会再自动来一张新码，所以这里直接说"该怎么办"
      return QR_EXPIRED_NOTICE;
    case QR_GATE_STATUS.failed:
      return qr.message ?? "二维码登录失败（详情见日志）";
    default:
      return "正在准备二维码…";
  }
}
