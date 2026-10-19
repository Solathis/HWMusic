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
