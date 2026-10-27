/**
 * Tauri 命令名的唯一真源（`invoke` 的第一参数）。
 *
 * 为什么要有这个文件：命令名是**跨语言契约**——TS 侧一个字母写错，Rust 侧不会报错，
 * 只会在运行时回一句 "command not found"（旧仓的典型症状：点了没反应，日志里才看得出来）。
 * 与 `request-channels.ts` 同款纪律：字面量只出现在这里，Rust 侧
 * （`src-tauri/src/commands.rs` 的 `#[tauri::command]` 与
 * `src-tauri/src/lib.rs` 的 `generate_handler!`）是刻意的镜像副本，
 * 由 `test/autostart.test.mjs` 扫描两侧源码钉住。
 *
 * 注意这里**不是** `core_call` 的频道白名单：那一条是 `request-channels.ts` 的
 * `REQUEST_CHANNELS`（Rust 侧 `require_request_channel` 准入）。两者别混。
 */

/** 渲染层唯一业务通道（sidecar 的请求/响应）。 */
export const CORE_CALL = "core_call";
/** 渲染层就绪钩子（启动期提示的冲刷点）。 */
export const CORE_RENDERER_READY = "core_renderer_ready";

/**
 * 开机自启的读写（R10 增补）。
 *
 * 为什么不直接用插件自带的 `plugin:autostart|enable`：插件命令要经 capabilities 的
 * `autostart:allow-*` 权限，那等于给渲染层开一个**直接改系统自启**的入口；自己写命令则把它
 * 收在主窗来源守卫（`require_main_window`）后面，与 `core_call` 同一个门，且一次性加齐权限的问题
 * 也不必存在（自定义命令不走 ACL，见 `src-tauri/src/commands.rs` 的注释与
 * `test/autostart.test.mjs` 的前置条件用例）。
 *
 * 回执是**观测到的实际状态**（不是"请求已受理"）：开关跟着它走。
 */
export const CORE_SET_AUTOSTART = "core_set_autostart";
/** 读当前自启状态（设置页挂载时用；没有这条就只能靠猜）。 */
export const CORE_GET_AUTOSTART = "core_get_autostart";

/**
 * 托盘可用性（R11 增补）。
 *
 * 为什么要有这条：设置页的关窗行为提示与文案都要知道"托盘到底在不在"。R10 把
 * `TRAY_AVAILABLE = false` 写死在渲染层是**如实**（宿主侧当时根本没有这个口子），
 * 但托盘装上之后那句写死的话就变成假话了。这条命令是那个事实的唯一来源
 * （Rust 侧现问 tauri 的托盘表，不是自己记的镜像）。
 *
 * 回执是 `boolean`：**只认 `true`**（"确实装上了"）。渲染层用
 * `trayAvailabilityFromAnswer` 投影，认不出的一律按"不可用"处理——与 Rust 侧
 * `tray::decide_close` 的 fail-safe 同一个保守方向。
 */
export const CORE_GET_TRAY_AVAILABLE = "core_get_tray_available";

/**
 * 设置页「日志」标签的数据源（R56）：日志文件的最后 N 条结构化条目。
 *
 * 为什么另开一条命令而不是走 `core_call`：日志在**宿主**这一侧（`tauri_plugin_log` 写文件、
 * sidecar 的 stderr 由宿主读进同一条管线），sidecar 里没有这份数据。守卫与自启/托盘同门
 * （`require_main_webview`），返回前逐条脱敏（`src-tauri/src/run_log.rs` 的 `redact`）。
 */
export const CORE_READ_RUN_LOG = "core_read_run_log";

/** 歌词专命令均 async。toggle/document/progress 限 main；configure 限 main/lyrics/设置弹出窗；
 * control 限 main/lyrics（弹出窗只改外观，不按播放键）。
 * configure({}) 纯读，回 {config, visible, revision}；restoreIfPristine 仅 main 且 revision=0 恢复。
 * control 仅接受 {action: toggle|previous|next}，转现 player:command，不开放 core_call。
 */
export const CORE_LYRICS_TOGGLE = "core_lyrics_toggle";
export const CORE_LYRICS_CONFIGURE = "core_lyrics_configure";
export const CORE_LYRICS_CONTROL = "core_lyrics_control";
export const CORE_LYRICS_DOCUMENT = "core_lyrics_document";
export const CORE_LYRICS_PROGRESS = "core_lyrics_progress";
export const CORE_LYRICS_UNLOCK_ZONE = "core_lyrics_unlock_zone";

/**
 * 歌词设置**弹出窗**的三条命令（R51）：打开 / 报尺寸 / 关闭自己。
 *
 * 为什么要有这三条（而不是让渲染层自己开窗）：桌面歌词窗只有 800×128，菜单在这个高度里只能滚。
 * 菜单搬进一扇独立的小透明窗之后，"放在哪、多大"必须由 **Rust** 决定（锚点换算、下方放不下翻上方、
 * 夹进工作区、缩放比）——这些都是窗口层的事，而且那扇窗因此**不需要任何 window 权限**。
 *
 * - `open({anchor})`：限 `main`/`lyrics`；`anchor` 是**调用窗口客户区里的 CSS 像素**矩形
 *   （齿轮按钮的 `getBoundingClientRect()`，DIP）。Rust 换算到物理坐标并定位。
 * - `resize({width, height})`：限 `lyrics-settings`；页面用 `ResizeObserver` 量到菜单内容尺寸后上报，
 *   Rust 设窗口尺寸并按同一锚点重算位置（首次显示也走这条：量到尺寸才 show，免得闪一下默认尺寸）。
 * - `close()`：限 `lyrics-settings`；Esc 与点菜单外面由 radix 的 dismiss 回来。
 */
export const CORE_LYRICS_SETTINGS_OPEN = "core_lyrics_settings_open";
export const CORE_LYRICS_SETTINGS_RESIZE = "core_lyrics_settings_resize";
export const CORE_LYRICS_SETTINGS_CLOSE = "core_lyrics_settings_close";

/**
 * 登录体验的浮动控件（R25 增补）：**登录相关控件的唯一命令**。
 *
 * 为什么不能复用 `core_call`：浮动控件是主窗里的**另外两个子 webview**
 * （label `login-return` / `login-theme`），而 `core_call` 的来源守卫
 * （`commands::require_main_webview`）只认主窗那一个 label——放宽它等于把业务频道
 * 交给登录页与浮动控件，那是身份边界上的退让。所以这里另开一条**专用命令**，
 * 守卫只放行 `main` / `login-return` / `login-theme` 三个来源，
 * 官方登录页（label `login`）与歌词窗仍然一律拒绝。
 *
 * 载荷形状（`{action, theme?}`）：
 * - `{action:"return"}` → 取消登录（与 `auth:cancel-login` 落到同一个结论槽）；
 * - `{action:"theme"}` → **读回**当前主题（浮动控件挂载时用，不需要第二条命令）；
 * - `{action:"theme", theme:"light"|"dark"|"system"}` → 改主题（Rust 持有 + 落盘 + 广播
 *   `theme:changed`）。
 *
 * 回执统一是 `{theme}`（改主题那条）或 `{cancelled}`（取消那条）：调用方拿到的都是**事实**，
 * 不是"请求已受理"。
 */
export const CORE_LOGIN_CHROME = "core_login_chrome";

/**
 * 本地曲库的四条命令（R65）：全部在 Rust 侧、挂主窗来源守卫——**路径**只由宿主持有，渲染层只拿 id；
 * 把"选文件"交给页面（`<input type="file">` 或 dialog 插件的 JS API）等于把任意文件的读取权开给 webview。
 * 回执都是**事实**（`{baseUrl}` / `{tracks, available}` / `{added, updated, rejected, tracks, available}` / `{removed, tracks, available}`），不是"请求已受理"。
 */
export const CORE_LOCAL_BASE_URL = "core_local_base_url";
export const CORE_LOCAL_LIST = "core_local_list";
export const CORE_LOCAL_IMPORT = "core_local_import";
export const CORE_LOCAL_REMOVE = "core_local_remove";
