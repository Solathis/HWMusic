/**
 * 广播频道与桥内部事件名的唯一真源（Node sidecar 与渲染层 import 同一模块）。
 *
 * Rust 侧 src-tauri/src/bridge.rs 用同名字符串字面量镜像这两项（Rust 无法 import TS），
 * 由 test/channel-parity.test.mjs 扫描源码钉住两侧一致——改这里就必须同步改那里。
 */

/** 渲染层订阅的唯一 Tauri 事件名（漏斗事件）：载荷形如 `{channel, payload}`。 */
export const CORE_EVENT = "core:event";

/**
 * sidecar 允许广播给渲染层的频道白名单（Rust 侧 `Effect::Emit` 的准入集合）。
 *
 * 初始集合由控制器裁决为 `app:notice`（R3 尚无真实广播，它是 R4+ 的第一个广播频道；
 * 白名单一旦为空，sidecar 的任何广播都会被当成白名单外帧丢掉）。R4+ 每新增一个广播频道
 * 都往这里增补，不另立清单。
 *
 * 注意这里也收 **Rust 侧直接发出**的广播（R9 的 `player:command`、R11 的 `lyrics:toggle` 与
 * `app:open-settings`）：白名单是"渲染层可以收到的频道"这一份清单，Rust 侧 `bridge.rs` 的
 * 同名数组是它的镜像副本（两侧由 `test/channel-parity.test.mjs` 钉住）。
 */
export const APP_NOTICE = "app:notice" as const;

/**
 * 登录状态广播（R7 增补）：`{loggedIn: boolean, busy: boolean, message?: string}`。
 *
 * 为什么是独立频道而不是复用 `app:notice`：`app:notice` 的语义是"给用户看的提示文案"，
 * 而登录状态是**状态**——渲染层的门禁与 R8 主界面靠它决定"该显示哪一层"，
 * 把状态塞进提示文案里，早晚要靠解析文案来判状态。
 *
 * 为什么结论走广播而不是 `core_call` 的返回值：渲染层那条调用链有 60 秒上限
 * （Rust `CALL_TIMEOUT_SECS`），而扫码要等好几分钟——`auth:login` 只回"已受理"，
 * 真正的结论（含失败原因与文案）经这里送达。渲染层也不必猜：`busy` 是宿主的登录状态。
 *
 * 启动期的那一条也会经 Rust 的 NoticeQueue 排队（渲染层就绪后冲刷），所以"渲染层还没订阅"
 * 不会丢掉"已登录"这个事实。
 */
export const AUTH_STATUS = "auth:status" as const;

/**
 * 播放控制广播（R9 增补，**预登记**：真正的发送方是 R11 的托盘）。
 *
 * 语义：`{command: "play"|"pause"|"toggle"|"next"|"previous"}` —— 控制意图，不是状态。
 * 为什么是广播而不是请求频道：托盘的菜单项在 **Rust 侧**响应（点一下要立刻有反馈），
 * 它既不能调 `core_call`（那是主窗的通道），也不该为了发一条命令去起一趟请求/响应；
 * 而状态回报（"现在在放哪首"）走渲染层自己的订阅，两条路互不冒充。
 *
 * 载荷形状由 `src/renderer/features/playback/player-commands.mjs` 的唯一真源校验：
 * 认不出的命令**不执行也不猜**，与"点了没反应"相比，返回结构化错误才是可排查的。
 */
export const PLAYER_COMMAND = "player:command" as const;

/**
 * 桌面歌词开关广播（R11 增补）：`{checked: boolean}` —— **目标态**（点完这一下之后应当是什么）。
 *
 * 发送方是托盘的那个 CheckMenuItem（Rust 侧）：勾选态由托盘自己镜像并翻转，
 * 渲染层/R12 的歌词窗按这个目标态行动（`true` = 要开、`false` = 要关），不必猜"现在是开还是关"。
 *
 * 本任务只保证这条广播发得出去、发得对：**歌词窗本体是 R12**，勾选态与窗存在性的同步也在 R12 收口
 * （这里不建假同步）。
 */
export const LYRICS_TOGGLE = "lyrics:toggle" as const;

/**
 * 打开设置页广播（R11 增补）：`{view: "settings"}`。
 *
 * 托盘菜单的"设置…"要切到设置页，而视图状态在渲染层（`App.tsx` 的 `view` 那一个 useState），
 * 所以 Rust 只能发一条"去设置页"的意图，由渲染层自己走既有的 `navigate`——
 * 不为这件事新开一条 IPC 请求通道（托盘既不能调 `core_call`，也不该为了切页起一趟请求/响应）。
 */
export const APP_OPEN_SETTINGS = "app:open-settings" as const;

export const BROADCAST_CHANNELS = [
  APP_NOTICE,
  AUTH_STATUS,
  PLAYER_COMMAND,
  LYRICS_TOGGLE,
  APP_OPEN_SETTINGS,
] as const;

export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];
