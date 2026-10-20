//! 华为音乐第三方桌面客户端 · Tauri v2 外壳。
//!
//! R2 范围：窗口策略（1280×800 / min 960×640 / 显式 webview 数据目录）、最小权限
//! capabilities、插件链编排。R3 增加 sidecar 桥（NDJSON stdio、命令白名单、宿主要求路由）。
//! R5 增加 DPAPI 安全存储（`secure_store.rs`）并把数据根经 argv 传给 sidecar。
//! R7 增加登录子窗（`login.rs`：白名单导航/hms 拦截/双期限/四收场/一次性数据目录）。
//! R11 增加托盘与关窗 fail-safe（`tray.rs` / `close_behavior.rs`）。
//! R12 增加桌面歌词窗与任务栏歌词降级（`lyrics_window.rs`）。
//!
//! `bridge` / `login` / `lyrics_window` / `tray` 是 `pub`：前两者的策略由 `tests/` 与内联单测直接钉
//! （纯函数，不要 GUI），歌词窗的几何与配置判定同理（见 `lyrics_window.rs` 的内联单测）。

pub mod bridge;
pub mod close_behavior;
mod commands;
pub mod login;
pub mod lyrics_window;
mod secure_store;
mod sidecar;
pub mod shortcuts;
pub mod tray;
mod webview_proxy;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::StateFlags;

/// 主窗 label。窗口由代码创建（`tauri.conf.json` 的 `app.windows` 故意留空）。
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 桌面歌词窗 label。窗口由 R12 的 `lyrics_window.rs` 起（无边框/透明/置顶/点透），
/// 这里定义常量以固定 window-state 的过滤白名单与四条歌词命令的来源守卫。
pub const LYRICS_WINDOW_LABEL: &str = "lyrics";
/// 托盘**图标** id（菜单项 id 的前缀是 `tray:`，见 `tray::MENU_ID_PREFIX`；两件事别混）。
pub const TRAY_ID: &str = "tray";
/// 数据目录覆盖旋钮：只接受绝对路径，空值等同未设置（%APPDATA% 不可写时排障用）。
pub const DATA_DIR_ENV: &str = "HWMUSIC_DATA_DIR";
/// 数据根下放日志的一级子目录名（R17/A）。
///
/// 名字钉成常量而不是就地拼字符串：它同时是排障入口（用户被要求去看这个目录）与
/// 清理脚本的靶子（`.tmp/<数据根>/logs`），改名等于同时弄坏这两件事。
pub const LOG_DIR_NAME: &str = "logs";

const MAIN_WINDOW_WIDTH: f64 = 1280.0;
const MAIN_WINDOW_HEIGHT: f64 = 800.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 960.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 640.0;

/// 数据根解析失败：应用数据目录与缓存目录都取不到。
///
/// 刻意没有“回退到 cwd”这一档：进程当前目录在打包后不可预测（可能是 Program Files），
/// 把配置/会话写进去会静默失败或落到只读位置，所以这里如实失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataRootError {
    /// data 与 cache 两级都不可用
    Unavailable,
}

impl std::fmt::Display for DataRootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DataRootError::Unavailable => write!(
                f,
                "无法确定应用数据目录：data 与 cache 目录都不可用（可用 {DATA_DIR_ENV} 指定绝对路径）"
            ),
        }
    }
}

impl std::error::Error for DataRootError {}

/// 托管状态：本进程实际使用的 webview 数据根，供 R5/R6 等后续任务读取落盘位置。
pub struct WebviewDataRoot(pub PathBuf);

/// 解析 `HWMUSIC_DATA_DIR` 覆盖值：空白 = 未设置；相对路径拒绝（会随启动目录漂移）；
/// 绝对路径容忍两端空白。
pub fn data_root_override(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    path.is_absolute().then(|| path.to_path_buf())
}

/// 数据根两级回退：应用数据目录 → 应用缓存目录；两者都不可用时报错（见 [`DataRootError`]）。
pub fn pick_data_root(
    data_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
) -> Result<PathBuf, DataRootError> {
    data_dir.or(cache_dir).ok_or(DataRootError::Unavailable)
}

/// 本进程 webview 的数据根：覆盖旋钮 → 应用数据目录 → 应用缓存目录。
///
/// 必须显式指定：WebView2 默认落在 `%LOCALAPPDATA%`，在受限环境下可能不可写。
pub fn webview_data_root(app: &tauri::AppHandle) -> Result<PathBuf, DataRootError> {
    if let Some(dir) = data_root_override(std::env::var(DATA_DIR_ENV).ok().as_deref()) {
        return Ok(dir);
    }
    let paths = app.path();
    pick_data_root(paths.app_data_dir().ok(), paths.app_cache_dir().ok())
}

/// 数据根 → 日志目录（R17/A）。纯函数，便于用例钉住"落在哪"。
pub fn log_dir(data_root: &Path) -> PathBuf {
    data_root.join(LOG_DIR_NAME)
}

/// 日志落点决议：`HWMUSIC_DATA_DIR` 是可用的绝对路径时给出 `<该值>/logs`，否则 `None`。
///
/// `None` 的含义是"**沿用插件的默认落点**"（`LogDir` = `%LOCALAPPDATA%\{bundle}\logs`），
/// 不是"不写文件"——见 [`log_plugin_targets`]。
pub fn log_folder(raw: Option<&str>) -> Option<PathBuf> {
    // 走同一个旋钮解析（`data_root_override`）：那三档非法输入（未设置/空白/相对路径）
    // 的判定在这里**不许有第二份**，否则日志目录与数据根会各自漂到不同地方。
    data_root_override(raw).map(|root| log_dir(&root))
}

/// 日志目标表（R17/A）：**stdout + 文件**，文件落点跟随数据根。
///
/// 为什么要有这次改动：插件的默认文件目标是 `LogDir`（Windows 上
/// `%LOCALAPPDATA%\{bundle}\logs`）。那在正常桌面环境完全没问题，但在**受限/便携**环境里
/// 它可能不可写——而建窗走的是数据根（`HWMUSIC_DATA_DIR` 指哪写哪），于是出现
/// "窗口能起、日志打开失败"的错配（实测表现就是把启动整个带走的 `os error 5`）。
/// 把日志目录也拴到同一个数据根上，两者要么一起可写、要么一起报同一个错。
///
/// 两档落点：
/// - **覆盖值可用** → `Folder(<覆盖值>/logs)`；
/// - **覆盖值不可用** → `LogDir`，即插件的默认落点——**改动前是什么就是什么**，
///   生产环境的行为逐字节不变。
///
/// 为什么只在这一档跟随数据根：目标表在 `Builder` 构造时就固定，而
/// `app_data_dir()` 要等 `AppHandle`（插件的 setup 之前拿不到）。所以能"无需 AppHandle
/// 就确定"的那一档（环境旋钮）跟随数据根，另一档交给插件默认；两者都是可写位置。
///
/// 档位（Info / 单文件 4MB / KeepOne）不在本函数里：它们仍写在 `run()` 的 Builder 链上，
/// 免得"日志级别"这种东西有两个真源。
pub fn log_plugin_targets(data_root_override: Option<&str>) -> Vec<Target> {
    let file = match log_folder(data_root_override) {
        Some(path) => Target::new(TargetKind::Folder {
            path,
            file_name: None,
        }),
        None => Target::new(TargetKind::LogDir { file_name: None }),
    };
    // stdout 必须显式列出：`.targets()` 是**替换**默认目标表（默认表里本来就有 Stdout），
    // 漏掉它 = 终端里再也看不到日志（开发与 CI 都靠它）。
    vec![Target::new(TargetKind::Stdout), file]
}

/// 创建主窗（1280×800，最小 960×640，显式数据目录，接设置里的代理）。
///
/// 返回实际使用的 webview 数据根，由 `run()` 登记为托管状态。目录必须先建：
/// WebView2 不会自建，缺目录时建窗直接 `os error 5`（拒绝访问）。
///
/// **代理必须接**：封面图与 `<audio>` 音频流走 WebView2 自己的网络栈，不接 `proxy_url` 就绕过设置直连
/// （旧仓审计出的缺陷 K6）。代理只在建窗时读取 → **改代理要重启应用才生效**（登录窗 R7、歌词窗 R12 同理）。
pub fn create_main_window(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let webview_data = webview_data_root(app)?;
    std::fs::create_dir_all(&webview_data)?;

    // 标题与 tauri.conf.json 的 productName（= src/shared/app-name.mjs 的显示名）同源
    let title = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());

    let mut builder = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT)
    .min_inner_size(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT)
    .data_directory(webview_data.clone());

    // 没配代理/配置不可用 → None → 直连（绝不猜一个代理出来）。
    // 走 `proxy_url_argument` 而不是直接 `Url::parse(...)?`：坏到解析不了的写法（清洗漏网的方括号 IPv6）
    // 只降级成"没配"，绝不把建主窗这一步带崩（旧缺陷：一个配置错误 = 应用起不来）。
    if let Some(proxy_url) =
        proxy_url_argument(webview_proxy::resolve_for_webview(&webview_data, MAIN_WINDOW_LABEL))
    {
        builder = builder.proxy_url(proxy_url);
    }
    let window = builder.build()?;

    // 关窗 fail-safe（R11）：`closeBehavior = tray` **且托盘真的装上**才藏窗口，否则放行（真退出）。
    //
    // 回调里每件事都现读事实，不缓存：关窗行为现读盘（设置页改完立刻生效）、托盘可用性现问
    // tauri 的托盘表——**没有第二份内存镜像可以漂移**。窗口藏起来之后，用户从托盘菜单
    // "显示窗口"回来（`focus_main`）。藏不了（窗口都找不到了）就放行，绝不拦着不让走。
    let close_app = app.clone();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let behavior = close_behavior::close_behavior_now(&close_app);
        let action = tray::decide_close(behavior.hides_on_close(), tray::available(&close_app));
        match (action, close_app.get_webview_window(MAIN_WINDOW_LABEL)) {
            (tray::CloseAction::PreventAndHide, Some(window)) => {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    log::warn!("关窗：窗口没能藏起来（{error}）：应用仍在托盘里运行");
                }
            }
            (tray::CloseAction::PreventAndHide, None) => {
                log::warn!("关窗：托盘可用但找不到主窗，这次关闭按退出放行");
            }
            (tray::CloseAction::Quit, _) => {
                log::info!("关窗即退出（行为={behavior}，托盘可用={}）", tray::available(&close_app));
            }
        }
    });

    // 显式聚焦：Windows 下窗口刚建好时不保证在前台
    window.set_focus()?;
    Ok(webview_data)
}

/// 建窗用的代理 URL 参数：取值链的**最后一道闸**。
///
/// 清洗（`webview_proxy::clean_host`）与 `tauri::Url::parse` 判的不是同一件事：清洗查字符集与形状，
/// 解析查 URL 结构——`[1.2.3.4]`、`[::::]` 这类写法能过清洗却解析不了。**解析失败一律当没配**
/// （直连）+ 一行日志：一个配置错误绝不能让主窗建不起来（简报：None 的所有情形都是"当作没配"而非错误）。
/// 这道闸同时兜住将来清洗规则的漏网（结构校验与字符集校验本来就不同源）。
///
/// 入参只可能是 `webview_proxy` 拼出的 `http://host:port`（凭据在那里就被丢弃并报告了），
/// 所以这行日志里不会有用户名/密码。
pub fn proxy_url_argument(candidate: Option<String>) -> Option<tauri::Url> {
    let raw = candidate?;
    match tauri::Url::parse(&raw) {
        Ok(url) => Some(url),
        Err(error) => {
            log::warn!("webview 代理地址无法解析，按没配处理（该窗口直连）：{raw}（{error}）");
            None
        }
    }
}

/// 第二个实例启动时把已有主窗拉到前台（single-instance 插件回调）。
pub fn focus_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册，否则第二个实例会先走完其它插件的初始化
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                // 只记 main/lyrics：其它窗口（如登录子窗）的位置不该被持久化
                .with_filter(|label| label == MAIN_WINDOW_LABEL || label == LYRICS_WINDOW_LABEL)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(4 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                // 落点跟随数据根（R17/A）：旋钮指哪，日志就写那儿；旋钮没设时是插件的
                // 默认 LogDir。留在这里而不是塞进 Builder 的默认值，是为了让"档位"与
                // "落点"两件事各有一个看得见的位置。
                .targets(log_plugin_targets(
                    std::env::var(DATA_DIR_ENV).ok().as_deref(),
                ))
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();

            // 关窗行为**先于建窗**恢复：窗一建出来用户就可能关它，而那一刻读的就是这里恢复出来的
            // 值。顺序反了 = 第一次关窗按默认走，用户会以为"设置没生效"（R11 的顺序契约）。
            let data_root = webview_data_root(handle)?;
            app.manage(close_behavior::CloseBehaviorState::restore(&data_root));

            let data_root = create_main_window(handle)?;
            app.manage(WebviewDataRoot(data_root.clone()));

            // 歌词窗的会话内配置（R12）：**登记在这里**而不是懒初始化——四条命令都可能
            // 是用户第一次点托盘时来的，而那时才"发现没状态"要多写一段 fallback。
            // 它不在任何广播路径上（顺序无契约）：只有四条歌词命令与设置页读它。
            app.manage(lyrics_window::LyricsWindowState::default());

            // core（sidecar）的托管状态**先于托盘安装**登记（R11 修复轮 1/5）：
            // 启动提示的排队能力住在 `Arc<CoreState>` 里，而 `tray::install` 装不上时要发一条
            // `app:notice`。登记晚于 install 的后果不是"少一条日志"——`emit_core_event` 在
            // `try_state` 取到 None 时走 `None => emit_now` 直接 `app.emit`，而 setup 时刻的
            // webview 还没跑 `listen()`：事件发进空气，"托盘未能启用…关窗会直接退出"这句降级
            // 用户永远看不到（他会以为关窗后还在托盘跑）。顺序由
            // `tray_is_installed_after_the_window_and_never_blocks_startup` 钉住。
            //
            // core（sidecar）起不来也不拦启动——core_call 会返回结构化 core_unavailable，
            // 比"应用直接起不来"更好排查，也不静默。
            app.manage(Arc::new(commands::CoreState::default()));

            // 托盘（R11）：建窗**之后**安装（建窗失败就没必要装）。装不上不拦启动——
            // 启动提示（`app:notice`）经上面登记好的队列扣到渲染层就绪再冲刷，
            // 关窗行为同时退回"真退出"（`tray::decide_close` 的 fail-safe）。
            match tray::install(handle) {
                tray::TrayInstall::Installed(_) => log::info!("托盘已装上（id={TRAY_ID}）"),
                tray::TrayInstall::Unavailable { reason } => {
                    log::warn!("托盘未能启用（{reason}）：关窗一律直接退出")
                }
            }

            // 快捷键（R13）：**逐条**注册（插件本身不注册任何组合——它遇到注册失败会把整个
            // 启动带崩），主组合被占用时沿备选链试。三条纪律：
            //
            // - 顺序：排在 `tray::install` **之后**——失败提示要指路托盘菜单，那得先知道托盘
            //   到底装上没有（指一个不存在的地方比不指更糟）；排在 core 状态登记之后同理
            //   （提示要能排队到渲染层就绪）。
            // - 失败/回退**逐条**经启动提示（`app:notice`）如实上报：真正生效的组合同时记进
            //   `ShortcutState`，用户看到的是"现在用的是哪个键"，不是"设置里写着另一个键"。
            // - 注册不上**不拦启动**：没有快捷键的用户仍然有主界面与托盘。
            let shortcut_report = shortcuts::install(handle);
            for text in shortcuts::shortcut_notices(&shortcut_report, tray::available(handle)) {
                log::warn!("快捷键：{text}");
                commands::emit_core_event(handle, crate::bridge::APP_NOTICE, serde_json::json!({ "text": text }));
            }
            app.manage(shortcuts::ShortcutState::new(shortcut_report));

            // 登录窗的独占状态：同一时刻只允许一次登录（R7）。登记在这里而不是懒初始化，
            // 免得"第一次登录时才发现没状态"要先写一段 fallback。
            // （顺序无契约：它不在广播路径上——广播的排队能力只归 `Arc<CoreState>`。
            //  真正要求"先登记"的是上面那条，别把两件事混起来。）
            app.manage(Arc::new(login::LoginState::default()));

            let knobs = sidecar::SidecarKnobs::from_env();
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from("."));

            match sidecar::resolve_launch(&exe_dir, &data_root, &knobs)
                .and_then(|plan| sidecar::SidecarProcess::spawn(&plan))
            {
                Ok(process) => {
                    let process = Arc::new(process);
                    commands::start_pump(app.handle(), &process);
                    app.state::<Arc<commands::CoreState>>()
                        .install(Arc::clone(&process));
                    log::info!("core（sidecar）已启动：{:?}", process.plan());
                }
                Err(error) => log::warn!("core（sidecar）未能启动：{error}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::core_call,
            commands::core_renderer_ready,
            // R10：设置页的开机自启开关（读写都经主窗来源守卫；**不进 capabilities**——
            // 自定义命令不走 ACL，理由与前置条件见 commands.rs 的注释）
            commands::core_set_autostart,
            commands::core_get_autostart,
            // R11：托盘可用性（R10 写死的 TRAY_AVAILABLE 占位改真查询的唯一来源）
            commands::core_get_tray_available,
            // R12：桌面歌词窗的四条命令（全部 async + 全部主窗来源守卫；歌词窗只订阅事件）。
            // async 不是风格问题：`WebviewWindowBuilder::build` 要走一趟主线程往返，
            // 同步命令自己就站在主线程上，等那一趟 = 死锁（见 lyrics_window.rs 的模块头）。
            lyrics_window::core_lyrics_toggle,
            lyrics_window::core_lyrics_configure,
            lyrics_window::core_lyrics_document,
            lyrics_window::core_lyrics_progress
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败")
        .run(|app_handle, event| {
            // tao 在 Windows 上 run_return 之后直接 process::exit，Drop 不会执行：
            // 退出路径必须显式收尸（关 stdin → sidecar exit(0) → 帧泵 EOF → 结清 pending）。
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                commands::shutdown_core(app_handle, "应用退出");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn abs(leaf: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\Users\\tester\\{leaf}"))
        } else {
            PathBuf::from(format!("/home/tester/{leaf}"))
        }
    }

    fn abs_str(leaf: &str) -> String {
        abs(leaf).to_string_lossy().into_owned()
    }

    /// 源码扫描：`generate_handler!` 的注册块（只看那一块：整份扫的话本用例自己的字面量就满足了它）。
    fn invoke_handler_block(source: &str) -> &str {
        let start = source
            .find("invoke_handler(tauri::generate_handler![")
            .expect("找不到 generate_handler! 的注册处");
        let end = source[start..]
            .find("])")
            .map(|offset| start + offset)
            .expect("generate_handler! 没有闭合");
        &source[start..end]
    }

    /// 源码扫描：`setup` 闭包体（接线顺序都在这段里）。
    fn setup_block(source: &str) -> &str {
        let start = source.find(".setup(|app| {").expect("找不到 setup");
        let end = source[start..]
            .find(".invoke_handler(")
            .map(|offset| start + offset)
            .expect("setup 之后应当紧跟 invoke_handler");
        &source[start..end]
    }

    /// 源码扫描：插件注册段（`Builder::default()` 到 `setup` 之间）。
    fn plugins_block(source: &str) -> &str {
        let start = source
            .find("tauri::Builder::default()")
            .expect("找不到插件注册段");
        let end = source[start..]
            .find(".setup(|app| {")
            .map(|offset| start + offset)
            .expect("插件注册段之后应当是 setup");
        &source[start..end]
    }

    /// 只看生产代码：`#[cfg(test)]` 段里的字面量是测试夹具，整份扫的话用例会把自己满足掉。
    fn production_source(source: &str) -> &str {
        let cut = source.find("#[cfg(test)]").unwrap_or(source.len());
        &source[..cut]
    }

    fn lib_source() -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("要能读到自己的源码")
    }

    #[test]
    fn data_root_override_unset_or_blank_is_none() {
        // 空值 = 旋钮未设置：不能让空串变成合法数据根
        assert_eq!(data_root_override(None), None);
        assert_eq!(data_root_override(Some("")), None);
        assert_eq!(data_root_override(Some("   ")), None);
        assert_eq!(data_root_override(Some("\t \r\n")), None);
    }

    #[test]
    fn data_root_override_rejects_relative_path() {
        // 相对路径随 cwd 漂移，等于把数据根交给进程启动目录
        assert_eq!(data_root_override(Some("data")), None);
        assert_eq!(data_root_override(Some("./data")), None);
        assert_eq!(data_root_override(Some("..")), None);
    }

    #[test]
    fn data_root_override_accepts_absolute_path() {
        let raw = abs_str("hwmusic-data");
        assert_eq!(data_root_override(Some(&raw)), Some(abs("hwmusic-data")));
    }

    #[test]
    fn data_root_override_tolerates_surrounding_whitespace() {
        let raw = format!("  {}\t", abs_str("hwmusic-data"));
        assert_eq!(data_root_override(Some(&raw)), Some(abs("hwmusic-data")));
    }

    #[test]
    fn pick_data_root_prefers_data_dir() {
        assert_eq!(
            pick_data_root(Some(abs("app-data")), Some(abs("app-cache"))),
            Ok(abs("app-data"))
        );
    }

    #[test]
    fn pick_data_root_falls_back_to_cache_dir() {
        assert_eq!(
            pick_data_root(None, Some(abs("app-cache"))),
            Ok(abs("app-cache"))
        );
    }

    #[test]
    fn pick_data_root_errors_when_both_unavailable() {
        assert_eq!(pick_data_root(None, None), Err(DataRootError::Unavailable));
    }

    #[test]
    fn pick_data_root_never_falls_back_to_cwd() {
        // 旧仓缺陷：两级回退都失败时落到 "."，把数据写进进程当前目录
        match pick_data_root(None, None) {
            Ok(picked) => panic!("两级回退都失败时必须报错，实际得到 {picked:?}"),
            Err(err) => assert_eq!(err, DataRootError::Unavailable),
        }
        assert_ne!(
            pick_data_root(None, None).unwrap_or_else(|_| abs("unused")),
            PathBuf::from(".")
        );
    }

    // ---- R17 / A：日志落点跟随数据根 -------------------------------------------------

    /// 日志目录必须是数据根下的一级子目录，且名字钉死在 `LOG_DIR_NAME` 上。
    ///
    /// 钉名字而不是"随便拼一个"：这个目录既是排障入口（用户被要求去看它），
    /// 也是清理脚本的靶子（`.tmp/<数据根>/logs`），改名等于同时弄坏这两件事。
    #[test]
    fn log_dir_is_the_data_root_leaf_named_logs() {
        assert_eq!(LOG_DIR_NAME, "logs");
        assert_eq!(log_dir(&abs("hwmusic-data")), abs("hwmusic-data").join("logs"));
    }

    /// 日志落点决议：**覆盖值可用 → `Folder(<覆盖值>/logs)`；否则 `None`（沿用插件默认目标）**。
    ///
    /// 三档非法输入（未设置 / 空白 / 相对路径）一律返回 `None`：相对路径随 cwd 漂移，
    /// 而这条路只该把日志写到一个"现在就能确定"的地方。
    #[test]
    fn log_folder_override_only_accepts_an_absolute_data_root() {
        assert_eq!(log_folder(None), None, "未设置 → 沿用插件默认（LogDir + stdout）");
        for blank in ["", "   ", "\t \r\n"] {
            assert_eq!(log_folder(Some(blank)), None, "{blank:?} 是空值，等同未设置");
        }
        for relative in ["data", "./data", "..", "logs"] {
            assert_eq!(log_folder(Some(relative)), None, "{relative} 是相对路径，不许当数据根");
        }

        let raw = abs_str("r17-data");
        assert_eq!(
            log_folder(Some(&raw)),
            Some(abs("r17-data").join(LOG_DIR_NAME)),
            "绝对覆盖值 → 日志写 <覆盖值>/logs"
        );
        assert_eq!(
            log_folder(Some(&format!("  {raw}\t"))),
            Some(abs("r17-data").join(LOG_DIR_NAME)),
            "两端空白照旧容忍（与 data_root_override 同一口径）"
        );
    }

    /// 接线钉：`run()` 里那条 `.targets(..)` 必须**经唯一构造点**取目标表，且带上数据根旋钮。
    ///
    /// 上一条用例只证明"决议函数算得对"——算得对而没接上去，日志照旧写 `%LOCALAPPDATA%`，
    /// 沙箱里就是同一个 `os error 5`。所以这里扫源码钉住那一段真的写了。
    #[test]
    fn the_log_plugin_follows_the_data_root_when_the_override_is_set() {
        let source = lib_source();
        let plugins = plugins_block(&source);
        let compact: String = plugins.chars().filter(|c| !c.is_whitespace()).collect();

        assert!(
            compact.contains(".targets(log_plugin_targets("),
            "日志目标要经唯一的构造点决定（不许在 run() 里现拼）：{compact}"
        );
        assert!(
            compact.contains("std::env::var(DATA_DIR_ENV)"),
            "落点要感知数据根旋钮（沙箱/便携环境可写才是本次改动的目的）：{compact}"
        );

        // 目标表本身的形状：stdout + 文件两档，文件那一档按覆盖值二选一。
        // 扫的是生产代码全段：`TargetKind` 的构造在 `log_plugin_targets` 的函数体里，
        // 不在插件注册那一段（整份扫也不会被本用例自己的字面量满足——本用例在 cfg(test) 之后）。
        let production = production_source(&source);
        let body_start = production
            .find("pub fn log_plugin_targets(")
            .expect("日志目标表必须有唯一的构造点");
        let body = &production[body_start..];

        assert!(
            body.contains("TargetKind::Stdout"),
            "stdout 必须显式列出：`.targets()` 是替换默认表，漏掉就等于终端里没有日志"
        );
        assert!(
            body.contains("TargetKind::Folder") && body.contains("TargetKind::LogDir"),
            "文件那一档要覆盖值与默认两条路都在（沙箱跟随数据根、生产沿用插件默认）"
        );
        assert!(body.contains("file_name: None"), "文件名交给插件按应用名取（不另起一个名字）");

        // 档位照旧（R13 的契约，本次不改）
        assert!(compact.contains(".level(log::LevelFilter::Info)"), "日志级别 Info");
        assert!(compact.contains(".max_file_size(4*1024*1024)"), "单文件 4MB");
        assert!(compact.contains("RotationStrategy::KeepOne"), "轮转只留一个文件");
    }

    /// 事实钉：`proxy_url` 的取值链是 `tauri::Url` → `tauri_runtime_wry::parse_proxy_url`
    /// （`url.host()` + `url.port()` → `--proxy-server=http://host:port`）。
    ///
    /// `url` crate 会把**默认端口**归一成 `None`（`http://host:80` → `port=None`），
    /// 于是 wry 拼出的是 `--proxy-server=http://host:`（端口段为空）。按 URL 规范空端口 = 默认端口，
    /// 预期仍等价于 80 —— 但**未实测**（真代理抓包属授权场景，见任务简报的范围外清单）。
    /// 这条用例把它记成"已知事实"而不是"没人发现"：将来真要动 80 端口的代理，从这里查起。
    #[test]
    fn proxy_url_default_port_is_normalized_away_by_the_url_crate() {
        let default_port = tauri::Url::parse("http://proxy.local:80").expect("合法 URL");
        assert_eq!(default_port.host_str(), Some("proxy.local"));
        assert_eq!(default_port.port(), None, "默认端口会被 url crate 抹掉");

        let explicit = tauri::Url::parse("http://proxy.local:8080").expect("合法 URL");
        assert_eq!(explicit.port(), Some(8080), "非默认端口原样保留");

        let ipv6 = tauri::Url::parse("http://[::1]:3128").expect("带方括号的 IPv6 是合法 URL");
        assert_eq!(ipv6.host_str(), Some("[::1]"), "方括号在 host 里保留（wry 直接拼进参数）");
        assert_eq!(ipv6.port(), Some(3128));
    }

    /// 建窗参数的最后一道闸：**解析失败一律当没配**，绝不把错误往上传（主窗建不起来）。
    #[test]
    fn proxy_url_argument_treats_unparseable_url_as_not_configured() {
        for good in ["http://proxy.local:8080", "http://[::1]:3128"] {
            assert!(
                proxy_url_argument(Some(good.to_string())).is_some(),
                "合法代理地址必须照常交给 builder：{good}"
            );
        }
        for bad in [
            "http://[1.2.3.4]:8080",
            "http://[::::]:8080",
            "http://proxy.local:99999",
            "不是 URL",
        ] {
            assert_eq!(
                proxy_url_argument(Some(bad.to_string())),
                None,
                "{bad} 必须降级成「没配」（直连），而不是让建窗失败"
            );
        }
        assert_eq!(proxy_url_argument(None), None);
    }

    /// 跨语言不变式：**清洗放行的 host，建窗用的 URL 必须能解析**。
    ///
    /// 清洗（`webview_proxy::clean_host`）与 `Url::parse` 的判定范围不同：前者查字符集与形状，
    /// 后者查 URL 结构。夹具里任何一条"放行"的写法若拼不出可解析的代理 URL，主窗就建不起来
    /// （简报：None 的所有情形都是"当作没配"而非错误）。这条用例是那类漏网的通用防线。
    #[test]
    fn every_host_cleaning_accepts_is_a_parseable_proxy_url() {
        let raw = std::fs::read_to_string(host_fixture_path()).expect("跨语言夹具必须存在");
        let fixture: serde_json::Value = serde_json::from_str(&raw).expect("夹具必须是合法 JSON");
        let port = fixture["port"].as_f64().expect("夹具要有端口");

        let mut accepted = 0;
        for case in fixture["cases"].as_array().expect("夹具要有 cases 数组") {
            let host = case["host"].as_str().expect("每条夹具都要有 host");
            let Some(cleaned) = webview_proxy::clean_host(Some(host)) else {
                continue;
            };
            let url = format!("http://{cleaned}:{port}");
            assert!(
                proxy_url_argument(Some(url.clone())).is_some(),
                "清洗放行了 {host:?}，但 {url} 解析不了（建窗会失败）"
            );
            accepted += 1;
        }
        assert!(accepted >= 10, "夹具的放行用例不能缩水（实际 {accepted} 条）");
    }

    fn host_fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test")
            .join("fixtures")
            .join("proxy-host-cases.json")
    }

    /// R10：两条自启命令必须进 `generate_handler!`——只定义不注册，渲染层点了没反应
    /// （`invoke` 报 "command not found"，而那是运行时才知道的事）。
    ///
    /// 源码扫描而不是行为测试：`generate_handler!` 展开后的白名单在运行期拿不到
    /// （要起一个真 app），而这条契约的关键就在"这一行有没有写"。
    #[test]
    fn autostart_commands_are_registered_in_the_invoke_handler() {
        let source = lib_source();
        // 只看 generate_handler! 那一块：整份扫的话，本用例自己的字面量就把它自己满足了
        let registered = invoke_handler_block(&source);

        for name in ["commands::core_set_autostart", "commands::core_get_autostart"] {
            assert!(
                registered.contains(name),
                "{name} 必须进 generate_handler!（否则 invoke 只会回 command not found）：{registered}"
            );
        }
    }

    /// R11：托盘可用性命令也必须进 `generate_handler!`——只定义不注册，设置页就会一直显示
    /// 「托盘不可用」（那正是 R10 写死 false 的那种假话，只是换了个来源）。
    #[test]
    fn tray_availability_command_is_registered_in_the_invoke_handler() {
        let source = lib_source();
        let registered = invoke_handler_block(&source);
        assert!(
            registered.contains("commands::core_get_tray_available"),
            "core_get_tray_available 必须进 generate_handler!：{registered}"
        );
    }

    /// R12：桌面歌词窗的四条命令必须进 `generate_handler!`——只定义不注册，用户点托盘那个
    /// "桌面歌词"勾选项就完全没有反应（而错误要到运行时才知道）。**四条都要**：少一条的后果
    /// 各不一样（少 toggle = 开关不动；少 document = 窗永远空白；少 progress = 歌词不动）。
    #[test]
    fn lyrics_window_commands_are_registered_in_the_invoke_handler() {
        let source = lib_source();
        let registered = invoke_handler_block(&source);
        for name in [
            "lyrics_window::core_lyrics_toggle",
            "lyrics_window::core_lyrics_configure",
            "lyrics_window::core_lyrics_document",
            "lyrics_window::core_lyrics_progress",
        ] {
            assert!(
                registered.contains(name),
                "{name} 必须进 generate_handler!（否则 invoke 只回 command not found）：{registered}"
            );
        }
    }

    /// R11 的顺序契约一：**关窗行为恢复必须先于建窗**。
    ///
    /// 反过来的后果是"第一次关窗按默认走"：窗一建出来用户就可能关它，而那一刻读的就是恢复出来的值。
    #[test]
    fn close_behavior_is_restored_before_the_window_is_created() {
        let source = lib_source();
        let setup = setup_block(&source);

        let restore = setup
            .find("close_behavior::CloseBehaviorState::restore(")
            .expect("setup 里必须按 settings.json 恢复关窗行为");
        let register = setup[..restore]
            .rfind("app.manage(")
            .expect("恢复出来的状态必须登记进托管状态（否则关窗回调读不到它）");
        let window = setup
            .find("create_main_window(")
            .expect("setup 里必须建主窗");
        assert!(
            restore < window,
            "关窗行为恢复必须在建窗之前：关窗回调从窗建好那一刻就可能被触发（restore={restore}, create={window}）"
        );
        assert!(register < restore, "先拿托管状态再恢复（manage 要在 restore 之前）");
    }

    /// R11 的顺序契约二：托盘在**建窗之后**安装（建窗失败就别装了），且装不上不拦启动。
    #[test]
    fn tray_is_installed_after_the_window_and_never_blocks_startup() {
        let source = lib_source();
        let setup = setup_block(&source);

        let window = setup.find("create_main_window(").expect("setup 里必须建主窗");
        let install = setup
            .find("tray::install(")
            .expect("setup 里必须安装托盘（R11 的交付点）");
        assert!(window < install, "托盘 install 要在建窗之后（建窗失败时不该已经装了个托盘）");
        assert!(
            !setup.contains("tray::install(handle)?"),
            "托盘装不上绝不能把启动带崩：结论要 match 掉（失败落启动提示 + 关窗退回真退出）"
        );
        for outcome in ["tray::TrayInstall::Installed", "tray::TrayInstall::Unavailable"] {
            assert!(setup.contains(outcome), "安装结论要显式处理：{outcome}");
        }

        // 顺序契约三（R11 修复轮 1/5）：**core 状态必须先登记**，`tray::install` 才能碰它。
        //
        // 启动提示的排队能力住在 `Arc<CoreState>` 的队列里：`emit_core_event` 拿 `try_state` 取到
        // 它才走 `deliver_or_queue`（未就绪 → 扣住，等 `core_renderer_ready` 冲刷）；取不到就走
        // `None => emit_now` 直接 `app.emit`——setup 时刻那个 webview 还没跑 `listen()`，
        // 事件发进空气。于是"托盘装不上"的降级在用户侧**完全不可见**（只剩日志），
        // 用户会以为关窗后还在托盘跑，下次关窗就再也找不回窗口。
        let core_state = setup
            .find("app.manage(Arc::new(commands::CoreState::default()))")
            .expect("setup 里必须登记 core 状态（启动提示队列住在它里面）");
        assert!(
            core_state < install,
            "core 状态登记必须先于 tray::install：托盘失败的提示要靠它的队列扣到渲染层就绪（core={core_state}, install={install}）"
        );
    }

    /// R13 顺序契约一：快捷键注册排在 **core 状态登记之后、托盘安装之后**。
    ///
    /// - 排在 core 状态之前：失败提示取不到队列，`emit_core_event` 退回直接 `app.emit`——
    ///   那时渲染层还没跑 `listen()`，提示发进空气（R11 修复轮 1/5 的同一个坑）。
    /// - 排在托盘之前：提示里"请改用托盘菜单"就成了没根据的话（托盘可能压根没装上）。
    ///
    /// 注册本身**不拦启动**：一个注册不上的快捷键不该把应用带走（简报）。
    #[test]
    fn shortcuts_are_registered_after_the_core_state_and_after_the_tray() {
        let source = lib_source();
        let setup = setup_block(&source);

        let core_state = setup
            .find("app.manage(Arc::new(commands::CoreState::default()))")
            .expect("setup 里必须登记 core 状态（提示队列住在它里面）");
        let tray = setup.find("tray::install(").expect("setup 里必须装托盘");
        let register = setup
            .find("shortcuts::install(")
            .expect("setup 里必须逐条注册快捷键（R13 的交付点）");
        assert!(
            core_state < register,
            "快捷键的失败提示要靠 core 状态的队列扣到渲染层就绪（core={core_state}, register={register}）"
        );
        assert!(
            tray < register,
            "提示里要指路托盘菜单，就得先知道托盘到底装上没有（tray={tray}, register={register}）"
        );
        assert!(
            !setup.contains("shortcuts::install(handle)?"),
            "快捷键注册失败绝不能把启动带崩：结论要收进 ShortcutReport 逐条上报"
        );
    }

    /// R13 的接线：注册结论**逐条入队**（经 `emit_core_event`），生效组合记进托管状态。
    ///
    /// 扫的是那一小段（从 `shortcuts::install` 到 `invoke_handler`）：整份扫的话，
    /// 别处（托盘 R11）的 `emit_core_event` 会把这条用例自己满足掉。
    #[test]
    fn shortcut_failures_are_queued_as_notices_and_the_state_is_managed() {
        let source = lib_source();
        let setup = setup_block(&source);

        let start = setup.find("shortcuts::install(").expect("setup 里必须注册快捷键");
        let end = setup.find(".invoke_handler(").unwrap_or(setup.len());
        let compact: String = setup[start..end].chars().filter(|c| !c.is_whitespace()).collect();

        assert!(
            compact.contains("shortcuts::shortcut_notices("),
            "失败与回退要经 shortcut_notices 逐条问出来：{compact}"
        );
        assert!(
            compact.contains("tray::available(handle)"),
            "提示里'请改用托盘菜单'要有根据：现问托盘表，不许猜：{compact}"
        );
        assert!(
            compact.contains("commands::emit_core_event(handle,crate::bridge::APP_NOTICE,"),
            "启动提示的唯一出口是 emit_core_event（不许自己 app.emit）：{compact}"
        );
        assert!(
            !compact.contains("app.emit(") && !compact.contains(".emit("),
            "快捷键这段不许绕开唯一构造点自己 emit：{compact}"
        );
        assert!(
            compact.contains("app.manage(shortcuts::ShortcutState::new(shortcut_report))"),
            "真正生效的组合要记进托管状态（设置页后续可读，本任务不做 UI）：{compact}"
        );
    }

    /// R13 的插件口径：**插件本身不注册任何组合**。
    ///
    /// `tauri-plugin-global-shortcut` 的 `Builder::with_shortcut(s)` 在它自己的 setup 里注册，
    /// 失败直接让 `setup` 返回 Err → tauri 在 `RuntimeRunEvent::Ready` 里 `panic!("Failed to setup
    /// app")`。那正是简报要防的"注册失败把应用带走"：组合只能由我们在 setup 里逐条注册。
    #[test]
    fn the_global_shortcut_plugin_registers_no_combos_itself() {
        let source = lib_source();
        let setup = setup_block(&source);
        let plugins = production_source(&source);
        for forbidden in [".with_shortcut(", ".with_shortcuts("] {
            assert!(
                !plugins.contains(forbidden),
                "组合不许交给插件注册（{forbidden}）：它一失败就是把应用带崩"
            );
        }
        assert!(
            plugins.contains("tauri_plugin_global_shortcut::Builder::new()"),
            "插件照常注册（提供管理器）"
        );
        assert!(
            !setup.contains(".with_shortcut(") && !setup.contains(".with_shortcuts("),
            "setup 里也不许用插件的组合注册接口"
        );
    }

    /// R13 收口核对（七项里的四项）：系统集成插件的**注册参数**是契约，逐项钉住。
    ///
    /// 这些参数各有一个"写错了要到用户机器上才发现"的后果：
    /// - **single-instance 必须最先注册**：晚于其它插件的话，第二个实例会先走完那些插件的
    ///   初始化（窗口状态恢复、日志文件打开）才被拦下——旧仓的"双击图标没反应"就是这么来的。
    /// - **window-state 的 flags 只许 SIZE|POSITION|MAXIMIZED**：混进 `VISIBLE`，桌面歌词窗
    ///   就会在**下次开机**自己弹出来（旧会话里它是可见的）；混进 `FULLSCREEN`/`DECORATIONS`
    ///   会跟歌词窗的无边框/置顶属性打架。
    /// - **filter 只放行 main/lyrics**：登录子窗的位置不该被持久化（一次性窗口）。
    /// - **autostart 用 `MacosLauncher::LaunchAgent`**：macOS 上的另一档（AppleScript）会在
    ///   系统设置里留一个"脚本"项，而自启注册失败在 macOS 上只有它这一条路。
    /// - **log 的档位**：Info / 单文件 4MB / KeepOne（落 `app_log_dir` 是插件的默认目标，
    ///   见 `tauri-plugin-log` 的 `DEFAULT_LOG_TARGETS`，不需要显式 `.target(..)`）。
    #[test]
    fn the_system_integration_plugins_keep_their_registration_parameters() {
        let source = lib_source();
        let plugins = plugins_block(&source);

        // 1. single-instance 最先，且回调把已有主窗拉到前台
        let single = plugins
            .find("tauri_plugin_single_instance::init(")
            .expect("必须注册 single-instance（第二实例要聚焦主窗）");
        assert!(
            single < plugins.find("tauri_plugin_window_state::").expect("窗口状态插件"),
            "single-instance 必须最先注册：晚于其它插件时第二实例会先跑完那些插件的初始化"
        );
        let after_single = &plugins[single..];
        assert!(
            after_single[..after_single.find(".plugin(").unwrap_or(after_single.len())]
                .contains("focus_main(app)"),
            "第二实例启动时必须 focus_main（否则用户双击图标什么都不会发生）"
        );

        // 2. window-state：flags 与 filter
        assert!(
            plugins.contains("StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED"),
            "窗口状态的 flags 是契约：{plugins}"
        );
        for forbidden in ["StateFlags::VISIBLE", "StateFlags::DECORATIONS", "StateFlags::FULLSCREEN"] {
            assert!(
                !plugins.contains(forbidden),
                "{forbidden} 不许混进 flags：歌词窗下次开机会自己弹出来 / 与无边框置顶打架"
            );
        }
        assert!(
            plugins.contains("with_filter(") && plugins.contains("MAIN_WINDOW_LABEL")
                && plugins.contains("LYRICS_WINDOW_LABEL"),
            "只记 main 与 lyrics 两个窗口的位置与尺寸：{plugins}"
        );

        // 3. notification 照常注册（host:notify 的落地口，R3 已接）
        assert!(plugins.contains("tauri_plugin_notification::init()"), "系统通知插件");

        // 4. autostart 的 macOS 档位
        assert!(
            plugins.contains("tauri_plugin_autostart::MacosLauncher::LaunchAgent"),
            "macOS 用 LaunchAgent：{plugins}"
        );

        // 5. log 的档位与落点
        assert!(plugins.contains(".level(log::LevelFilter::Info)"), "日志级别 Info");
        assert!(plugins.contains(".max_file_size(4 * 1024 * 1024)"), "单文件 4MB");
        assert!(
            plugins.contains("tauri_plugin_log::RotationStrategy::KeepOne"),
            "轮转只留一个文件"
        );
    }

    /// R11 的关窗回调：`CloseRequested` → `tray::decide_close`（fail-safe 的唯一判据）
    /// → 要么 `api.prevent_close()` + 藏窗口，要么放行（真退出）。回调里不许另写一份判断。
    #[test]
    fn close_requested_fails_safe_through_decide_close() {
        let source = lib_source();
        let production = production_source(&source);

        assert!(production.contains("WindowEvent::CloseRequested"), "必须接住关窗事件");
        assert!(
            production.contains("tray::decide_close("),
            "关窗决议只能来自 tray::decide_close（closeBehavior=tray **且**托盘真的装上才藏）"
        );
        assert!(production.contains("api.prevent_close()"), "藏窗口那一支要拦住这次关闭");
        assert!(
            production.contains("close_behavior::close_behavior_now("),
            "行为要现读（设置页改完立刻生效），不是启动时冻住的那份"
        );
        assert!(
            production.contains("tray::available("),
            "可用性要现问托盘表（fail-safe 的第二半）"
        );
        // 两个分支都要写出来：只写 PreventAndHide 那一支，另一支就成了"忘了处理的默认"
        assert!(production.contains("tray::CloseAction::PreventAndHide"));
        assert!(production.contains("tray::CloseAction::Quit"));
    }
}
