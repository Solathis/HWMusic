/**
 * Tauri 命令名的唯一真源（`invoke` 的第一参数）。
 *
 * 命令名是跨语言契约：TS 侧一个字母写错，Rust 侧不会报错，只会在运行时回 command not found。
 * 字面量只出现在这里，Rust 侧是刻意的镜像副本，由测试扫描两侧源码钉住。
 * 注意这里不是 `core_call` 的频道白名单（那是 `request-channels.ts` 的 `REQUEST_CHANNELS`）。
 */

/** 渲染层唯一业务通道（sidecar 的请求/响应）。 */
export const CORE_CALL = "core_call";
/** 渲染层就绪钩子（启动期提示的冲刷点）。 */
export const CORE_RENDERER_READY = "core_renderer_ready";

/**
 * 开机自启的读写：不走插件自带的 `plugin:autostart|*`（那等于给渲染层开一个直接改系统自启的入口），
 * 而是收在主窗来源守卫后面。回执是观测到的实际状态，不是请求已受理。
 */
export const CORE_SET_AUTOSTART = "core_set_autostart";
/** 读当前自启状态（设置页挂载时用；没有这条就只能靠猜）。 */
export const CORE_GET_AUTOSTART = "core_get_autostart";

/**
 * 托盘可用性：设置页的关窗行为提示要知道托盘到底在不在，这里问 Rust 的托盘表，是那个事实的唯一来源。
 * 只认 `true`，认不出的按不可用处理——与 Rust 侧 `tray::decide_close` 同一个保守方向。
 */
export const CORE_GET_TRAY_AVAILABLE = "core_get_tray_available";

/**
 * 设置页「日志」标签的数据源：日志文件的最后 N 条结构化条目。
 * 日志在宿主这一侧，sidecar 里没有这份数据，所以另开一条命令；返回前逐条脱敏。
 */
export const CORE_READ_RUN_LOG = "core_read_run_log";

/** 歌词专命令均 async。toggle/document/progress 限 main；configure 限 main/lyrics/设置弹出窗；
 * control 限 main/lyrics（弹出窗只改外观，不按播放键）。
 * configure({}) 纯读，回 {config, visible, revision}；restoreIfPristine 仅 main 且 revision=0 恢复。
 * control 仅接受 {action: toggle|previous|next|close}：媒体键转现 player:command，close 走托盘「关闭桌面歌词」那条路；不开放 core_call。
 */
export const CORE_LYRICS_TOGGLE = "core_lyrics_toggle";
export const CORE_LYRICS_CONFIGURE = "core_lyrics_configure";
export const CORE_LYRICS_CONTROL = "core_lyrics_control";
export const CORE_LYRICS_DOCUMENT = "core_lyrics_document";
export const CORE_LYRICS_PROGRESS = "core_lyrics_progress";
export const CORE_LYRICS_UNLOCK_ZONE = "core_lyrics_unlock_zone";

/**
 * 歌词设置弹出窗的三条命令：打开 / 报尺寸 / 关闭自己。
 * 「放在哪、多大」必须由 Rust 决定（锚点换算、翻上方、夹进工作区），那扇窗因此不需要任何 window 权限。
 * `open({anchor})` 限 `main`/`lyrics`；`resize({width, height})` 与 `close()` 限 `lyrics-settings`。
 */
export const CORE_LYRICS_SETTINGS_OPEN = "core_lyrics_settings_open";
export const CORE_LYRICS_SETTINGS_RESIZE = "core_lyrics_settings_resize";
export const CORE_LYRICS_SETTINGS_CLOSE = "core_lyrics_settings_close";

/**
 * 登录体验的浮动控件：登录相关控件的唯一命令。
 * 不复用 `core_call`：它的来源守卫只认主窗 label，放宽等于把业务频道交给登录页；这里只放行 `main`/`login-return`/`login-theme`。
 * 载荷 `{action, theme?}`：`return` 取消登录、`theme` 读回或改主题；回执是事实（`{theme}` / `{cancelled}`）。
 */
export const CORE_LOGIN_CHROME = "core_login_chrome";

/**
 * 沉浸页的窗口外框，只接受主窗：`{action}` 为 immersive / normal（收起或装回标题栏）、read（只读）、minimize / toggle-maximize / close（窗口按钮）。
 * 只有 Windows 的 immersive 真的收起标题栏，其他平台保留原生标题栏；回执是实际的 `{frameless, maximized}`。
 */
export const CORE_MAIN_CHROME = "core_main_chrome";

/**
 * 本地曲库的四条命令：全部在 Rust 侧、挂主窗来源守卫——路径只由宿主持有，渲染层只拿 id。
 * 把选文件交给页面等于把任意文件的读取权开给 webview。回执都是事实，不是请求已受理。
 */
export const CORE_LOCAL_BASE_URL = "core_local_base_url";
export const CORE_LOCAL_LIST = "core_local_list";
export const CORE_LOCAL_IMPORT = "core_local_import";
export const CORE_LOCAL_REMOVE = "core_local_remove";

/** 设置「关于」：版本与运行环境（只读），限主窗。 */
export const CORE_APP_INFO = "core_app_info";
/** 设置「关于」：按键打开外链，只认 `src-tauri/src/about.rs` 固定表里的键，限主窗。 */
export const CORE_OPEN_LINK = "core_open_link";
