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
pub mod lyrics_settings;
pub mod lyrics_window;
/// R65：本地曲库（选文件 / 元数据 / 索引 / 按 id 提供音频与封面）与自定义协议
pub mod local_library;
pub mod taskbar_lyrics;
pub mod run_log;
mod secure_store;
mod sidecar;
pub mod shortcuts;
pub mod theme;
pub mod tray;
mod webview_proxy;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_window_state::StateFlags;

/// 主窗 label。窗口由代码创建（`tauri.conf.json` 的 `app.windows` 故意留空）。
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 桌面歌词窗 label。窗口由 R12 的 `lyrics_window.rs` 起（无边框/透明/置顶/点透），
/// window-state、歌词专命令来源守卫与几何接管都按同一 label。
pub const LYRICS_WINDOW_LABEL: &str = "lyrics";
/// 桌面歌词**设置弹出窗** label（R51）。它是歌词窗外面的另一扇小透明窗：菜单要能超出歌词窗的
/// 800×128，所以不能留在窗里。窗口与几何归 `lyrics_settings.rs`，它自己**没有任何** window 权限。
pub const LYRICS_SETTINGS_WINDOW_LABEL: &str = "lyrics-settings";
/// 托盘**图标** id（菜单项 id 的前缀是 `tray:`，见 `tray::MENU_ID_PREFIX`；两件事别混）。
pub const TRAY_ID: &str = "tray";
/// 数据目录覆盖旋钮：只接受绝对路径，空值等同未设置（%APPDATA% 不可写时排障用）。
pub const DATA_DIR_ENV: &str = "HWMUSIC_DATA_DIR";
/// 数据根下放日志的一级子目录名（R17/A）。
///
/// 名字钉成常量而不是就地拼字符串：它同时是排障入口（用户被要求去看这个目录）与
/// 清理脚本的靶子（`.tmp/<数据根>/logs`），改名等于同时弄坏这两件事。
pub const LOG_DIR_NAME: &str = "logs";

fn persist_window_state(label: &str) -> bool { label == MAIN_WINDOW_LABEL }

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

/// 启动诊断那一行：**数据根是哪个路径** + **它是哪来的**（R27 用户三项之 3）。
///
/// 为什么这一行值得单独存在：用户报"每次重启都要重登"，而最可能的原因根本不是代码——
/// 调试用的根（`HWMUSIC_DATA_DIR=.tmp/live-data`）与用户自跑时读的根
/// （`%APPDATA%\{bundle}`）**互不相通**，两个根里的 `session.enc` 各归各的。
/// 没有这一行时，"会话为什么不在"只能靠人回忆当时那个进程读的是哪个根。
///
/// 报的是**实际用的那个根**（`root`，走完了三级回退之后的结果），不是旋钮里的原始写法：
/// 那两者在"旋钮没设 / 设了空白 / 设了相对路径"这三种情况下是**不一样**的，而日志要回答的是
/// "这一次到底写哪儿了"。来源只分两档（旋钮生效 / 没生效）——第三级回退（应用数据目录 →
/// 缓存目录）的区分已经体现在路径本身里（`%APPDATA%` vs `%LOCALAPPDATA%`）。
///
/// sidecar 那一侧另有一行更完整的诊断（同一个根 + `session.enc` 存在性 + 恢复档位，
/// 见 `src/main/session-diagnostic.mjs`）；两处说的是**同一个**根（宿主经 `--data-dir` 交给它）。
pub fn data_root_note(raw: Option<&str>, root: &Path) -> String {
    let source = if data_root_override(raw).is_some() {
        format!("{DATA_DIR_ENV} 覆盖")
    } else {
        "应用数据目录（未设覆盖旋钮）".to_string()
    };
    format!("数据根：{}（来源：{source}）", root.display())
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

/// 后台验证开关：只改启动期的窗口激活，供验证脚本用，不是给用户的旋钮。
pub const BACKGROUND_TEST_ENV: &str = "HWMUSIC_BACKGROUND_TEST";

/// 开关值解析：`1` / `true`（不分大小写、容忍两端空白）才算开，其余一律当关。
pub fn background_test_flag(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true")
    )
}

/// 进程内**唯一**的开关读取点：多处读会出现"建窗看见开、拉前台看见关"的分裂。
pub fn background_test() -> bool {
    background_test_flag(std::env::var(BACKGROUND_TEST_ENV).ok().as_deref())
}

/// 启动期窗口激活（开关只影响这三件事）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupActivation {
    pub visible: bool,
    pub focused: bool,
    /// 建完之后是否再 `set_focus`（Windows 不保证新建窗口在前台）
    pub focus_after_build: bool,
}

/// 正常启动：显示 + 激活 + 建完再聚焦；后台验证：三件都不做。
pub fn startup_activation(background_test: bool) -> StartupActivation {
    StartupActivation {
        visible: !background_test,
        focused: !background_test,
        focus_after_build: !background_test,
    }
}

/// 第二实例信号的出路。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecondInstanceAction {
    /// 把已有主窗拉到前台（用户双击图标时的唯一反馈）
    FocusExisting,
    /// 后台验证实例让位退出（它不该把用户的启动顶掉，也不该被拉到前台）
    ExitBackgroundTest,
}

pub fn second_instance_action(background_test: bool) -> SecondInstanceAction {
    if background_test {
        SecondInstanceAction::ExitBackgroundTest
    } else {
        SecondInstanceAction::FocusExisting
    }
}

/// 窗口状态恢复的标志：后台验证去掉 `MAXIMIZED`。
///
/// Windows 上恢复最大化就是 `ShowWindow(SW_MAXIMIZE)`——那会让隐藏的主窗显示出来并抢走前台。
pub fn window_state_flags(background_test: bool) -> StateFlags {
    let base = StateFlags::SIZE | StateFlags::POSITION;
    if background_test {
        base
    } else {
        base | StateFlags::MAXIMIZED
    }
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
    let activation = startup_activation(background_test());

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
    .skip_taskbar(false)
    .theme(theme::current_theme(app).to_native())
    .data_directory(webview_data.clone())
    .visible(activation.visible)
    .focused(activation.focused);

    // 没配代理/配置不可用 → None → 直连（绝不猜一个代理出来）。
    // 走 `proxy_url_argument` 而不是直接 `Url::parse(...)?`：坏到解析不了的写法（清洗漏网的方括号 IPv6）
    // 只降级成"没配"，绝不把建主窗这一步带崩（旧缺陷：一个配置错误 = 应用起不来）。
    if let Some(proxy_url) =
        proxy_url_argument(webview_proxy::resolve_for_webview(&webview_data, MAIN_WINDOW_LABEL))
    {
        builder = builder.proxy_url(proxy_url);
    }
    let window = builder.build()?;

    let close_app = app.clone();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let behavior = close_behavior::close_behavior_now(&close_app);
        let action = tray::decide_close(behavior, tray::available(&close_app));
        let window = close_app.get_webview_window(MAIN_WINDOW_LABEL);
        let action = if action == tray::CloseAction::PreventAndHide && window.is_none() {
            log::warn!("关窗：托盘可用但找不到主窗，这次按退出处理");
            tray::CloseAction::Quit
        } else {
            action
        };
        let result = apply_close_action(
            action,
            || api.prevent_close(),
            || {
                let window = window.as_ref().ok_or_else(|| "找不到主窗".to_string())?;
                window.hide().map_err(|error| error.to_string())
            },
            || request_app_exit(&close_app),
        );
        match result {
            Ok(()) => log::info!("关窗已处理：{action:?}（行为={behavior}）"),
            Err(error) => {
                log::warn!("关窗操作 {action:?} 失败（{error}）：已拦住关闭，保留应用并恢复主窗");
                focus_main(&close_app);
            }
        }
    });

    // 显式聚焦：Windows 下窗口刚建好时不保证在前台（后台验证实例不显示也不聚焦）
    if activation.focus_after_build {
        window.set_focus()?;
    }
    Ok(webview_data)
}

fn apply_close_action<E>(
    action: tray::CloseAction,
    prevent_close: impl FnOnce(),
    hide: impl FnOnce() -> Result<(), E>,
    quit: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    prevent_close();
    match action {
        tray::CloseAction::PreventAndHide => hide(),
        tray::CloseAction::Quit => quit(),
    }
}

#[derive(Default)]
struct ExitState(std::sync::atomic::AtomicBool, std::sync::atomic::AtomicBool);

impl ExitState {
    fn request<E>(&self, spawn: impl FnOnce() -> Result<(), E>, focus: impl FnOnce()) -> Result<(), E> {
        use std::sync::atomic::Ordering;
        if self.0.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Ok(());
        }
        if let Err(error) = spawn() {
            self.0.store(false, Ordering::Release);
            focus();
            return Err(error);
        }
        Ok(())
    }

    /// 准备失败时的 CAS 复位：下一次 Quit 必须能**再试一次**（不是"这次失败就永远退不了"）。
    fn reset_request(&self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// 正常退出的准备预算（毫秒）：保存准备是有界的，超时/失败都**保窗可重试**。
///
/// 为什么不许无限等：`CoreShared::call` 自己就有 10 秒上限（[`commands::SETTINGS_CALL_TIMEOUT_SECS`]），
/// 两次写 + 一次确认读必须落在这个预算里；否则用户会看到"点了退出没反应"的窗口。
pub const EXIT_PREPARE_BUDGET_MS: u64 = 4000;

fn finish_app_exit(shutdown: impl FnOnce(), exit: impl FnOnce()) {
    shutdown();
    exit();
}

/// 退出前的持久化校验（**纯函数**）：盘上的权威文档必须与 Rust 内存里的权威值一致。
///
/// 为什么必须比对而不是"写调用没报错就行"：`CoreShared::call` 超时后 sidecar 仍可能把那一帧
/// 处理完（也可能永远不处理）。只有一次**排在写队列后面**的 `settings:get` 读回来的文档，
/// 才能证明"最后一笔真的落盘了"。缺键按默认比（用户从没选过时盘上本来就没有这一格）。
pub fn verify_persisted_documents(
    answer: &Value,
    theme: theme::ThemeChoice,
    lyrics: &lyrics_window::LyricsConfig,
) -> Result<(), String> {
    let stored_theme = commands::settings_receipt_value(answer, theme::THEME_KEY)
        .and_then(Value::as_str)
        .and_then(|raw| theme::ThemeChoice::from_setting(Some(raw)))
        .unwrap_or(theme::DEFAULT_THEME);
    if stored_theme != theme {
        return Err(format!(
            "盘上主题是 {}，运行中的是 {}：最后一次写入没有确认",
            stored_theme.setting(),
            theme.setting()
        ));
    }
    let stored_lyrics = lyrics_window::LyricsConfig::restored(
        commands::settings_receipt_value(answer, lyrics_window::LYRICS_SETTING_KEY),
    );
    if &stored_lyrics != lyrics {
        return Err("盘上的歌词配置与运行中的不一致：最后一次写入没有确认".to_string());
    }
    Ok(())
}

/// 取消**本应用自窗**的菜单/拖动模态（只在准备成功之后、排队退出之前调）。
///
/// 控制器真验（`.tmp/r44-own-cancel-menu.json`）：一个 own 系统菜单模态会把排队的 `app.exit`
/// 堵住 8 秒以上（GUI flags 12 / menuOwner=main），只对精确 own HWND 发一次 `WM_CANCELMODE`
/// 后 169ms 就退出了。三条限制写死在这里：
///
/// 1. **只发自己进程的窗口 HWND**：目标来自 `app.webview_windows()`（本应用注册过的窗），
///    不枚举系统窗口、不碰 foreign HWND、不按类名/标题猜；
/// 2. **`PostMessage`（异步、不等回包）**：不重入消息泵、不阻塞退出线程；不注入键盘、不点别人的窗；
/// 3. **只在保存准备成功之后**：准备失败时用户的菜单/拖动状态不许先被摧毁（那会让"退出失败保窗"
///    变成"退出失败还顺手关掉了用户正在用的菜单"）。
#[cfg(windows)]
pub fn cancel_own_modal_menus(post: impl Fn(isize) -> bool, targets: impl IntoIterator<Item = (String, isize)>) -> Vec<String> {
    let mut cancelled = Vec::new();
    for (label, hwnd) in targets {
        if hwnd == 0 {
            continue; // 没有原生句柄（窗还没建好/已销毁）：不发
        }
        if post(hwnd) {
            cancelled.push(label);
        }
    }
    if !cancelled.is_empty() {
        log::info!("退出前已请求取消自窗模态（WM_CANCELMODE）：{}", cancelled.join(", "));
    }
    cancelled
}

#[cfg(windows)]
fn cancel_own_modals_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CANCELMODE};
    let targets: Vec<(String, isize)> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| window.hwnd().ok().map(|hwnd| (label, hwnd.0 as isize)))
        .collect();
    cancel_own_modal_menus(
        |hwnd| {
            let handle = windows::Win32::Foundation::HWND(hwnd as *mut std::ffi::c_void);
            // SAFETY: 句柄来自本应用自己的窗口注册表；PostMessage 对已销毁窗口只会失败，不会崩。
            unsafe { PostMessageW(Some(handle), WM_CANCELMODE, Default::default(), Default::default()).is_ok() }
        },
        targets,
    );
}

#[cfg(not(windows))]
fn cancel_own_modals_now<R: tauri::Runtime>(_: &tauri::AppHandle<R>) {}

/// 正常退出的**准备阶段**：冻结 → 排空 → 重试/处置 → 屏障读 → 校验。
///
/// 只有整段成功，调用方才允许进入 D 的不可逆 detach / core 收尸 / `app.exit`。
fn prepare_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(EXIT_PREPARE_BUDGET_MS);
    let gate = commands::persistence_gate(app).map_err(|error| error.message)?;
    // 1) 冻结：此后的渲染层写一律拒（已受理的继续收尾）
    gate.begin_prepare();
    prepare_exit_with(
        deadline,
        // 2) 等已受理的写与整笔主题事务有结论（有界）
        |deadline| {
            if gate.wait_drained(deadline) {
                Ok(())
            } else {
                Err(format!("等待已受理的保存超时（还有 {} 笔在飞）", gate.in_flight()))
            }
        },
        // 3) 歌词最新配置：失败过一次的话本轮 Quit 至多重试一次
        |deadline| lyrics_window::prepare_exit_persistence(app, deadline).map_err(|error| error.message),
        // 4) 主题 uncertain：重存当前权威主题并确认（只拿剩余预算）
        |deadline| theme::resolve_uncertain(app, deadline).map(|_| ()).map_err(|error| error.message),
        // 5) `settings:get` 是写队列的屏障（sidecar 先排空已受理的写再读盘；同样只拿剩余预算）
        |deadline| commands::settings_read_owned_before(app, deadline).map_err(|error| error.message),
        // 6) 校验权威持久：不一致就保窗（不许"看起来退了、其实丢了一笔"）
        |answer| {
            verify_persisted_documents(
                answer,
                theme::current_theme(app),
                &app.state::<lyrics_window::LyricsWindowState>().config(),
            )
        },
    )
}

/// [`prepare_exit`] 的**可脱机测试**版本：每一步由参数注入，但**共用同一个绝对期限**。
///
/// 为什么要有这一层：退出准备的有界性是 review finding 4 的对象——4 秒是整段的上限，
/// 不是"每一段各自 10 秒"。把步进抽出来的唯一目的就是让"每一步拿到的是不是同一个 deadline"
/// 成为可断言的行为，而不是靠读源码。
fn prepare_exit_with(
    deadline: std::time::Instant,
    wait_drained: impl FnOnce(std::time::Instant) -> Result<(), String>,
    drain_lyrics: impl FnOnce(std::time::Instant) -> Result<(), String>,
    resolve_theme: impl FnOnce(std::time::Instant) -> Result<(), String>,
    read_settings: impl FnOnce(std::time::Instant) -> Result<serde_json::Value, String>,
    verify: impl FnOnce(&serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    wait_drained(deadline)?;
    drain_lyrics(deadline)?;
    resolve_theme(deadline)?;
    let answer = read_settings(deadline)?;
    verify(&answer)
}

pub(crate) fn request_app_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let state = app.try_state::<ExitState>().ok_or_else(|| "退出状态未登记".to_string())?;
    state.request(|| {
        let app = app.clone();
        std::thread::Builder::new()
            .name("app-exit".into())
            .spawn(move || run_exit(&app))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }, || focus_main(app))
}

/// 退出顺序的**唯一收口**：准备成功才跑不可逆清理，失败只跑失败分支（且不做任何不可逆的事）。
///
/// 抽成这个 helper 是为了让"顺序是合同"可测：`run_exit` 走的正是它，不是另外抄一遍。
fn finish_prepared_exit(
    preparation: Result<(), String>,
    commit: impl FnOnce(),
    abort: impl FnOnce(&str),
) -> Result<(), String> {
    match preparation {
        Ok(()) => {
            commit();
            Ok(())
        }
        Err(reason) => {
            abort(&reason);
            Err(reason)
        }
    }
}

/// 准备成功之后：进入不可逆阶段（取消自窗模态 → 停保存任务 → D 屏障/core 收尸 → app.exit）。
fn commit_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(gate) = commands::persistence_gate(app) {
        log::info!("退出准备完成（持久化阶段：{:?}）：进入不可逆清理", gate.phase());
        gate.begin_exit();
    }
    // 用户在退出前开着菜单/拖着窗：只有准备成功之后才取消（准备失败时不能先摧毁他的状态）。
    cancel_own_modals_now(app);
    lyrics_window::stop_persistence(app);
    finish_app_exit(
        || {
            let owner = app.clone();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2100);
            let _ = app.run_on_main_thread(move || lyrics_window::begin_shutdown(&owner));
            commands::shutdown_core(app, "请求退出");
            while std::time::Instant::now() < deadline && !lyrics_window::shutdown_finished(app) {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        },
        || {
            app.state::<ExitState>().1.store(true, std::sync::atomic::Ordering::Release);
            app.exit(0);
        },
    );
}

/// 准备失败：保窗、复位（**先**歌词保存解冻、**再**准入门回到 Running、CAS 清掉），把可操作提示交给渲染层。
///
/// 歌词那一格是 review finding 1：退出准备会冻结保存任务并把"本轮已重试过"置位；不解冻的话，
/// 一次失败的退出会让这个会话再也保存不了歌词配置（手动重试与下一次 Quit 都被拒），
/// 而盘上仍是旧值。解冻**不**碰 dirty/saved/saveError：没写成就不许宣布已保存。
fn abort_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, reason: &str) {
    // 顺序是合同（review round 2 finding 1）：歌词先解冻，准入门**最后**才开。门一开就有渲染层
    // 写可以进来，那时歌词必须已经可写，否则受理的那一笔会落在冻结的队列上被静默丢掉。
    let gate = commands::persistence_gate(app).ok();
    let lyrics = app.try_state::<lyrics_window::LyricsWindowState>();
    match (gate, lyrics) {
        (Some(gate), Some(lyrics)) => {
            lyrics_window::restore_after_failed_exit(&gate, lyrics.inner(), || {})
        }
        // 少了任何一格就各自复原各自那一格：不许因为对面没登记就整个不复原
        (gate, lyrics) => {
            if let Some(gate) = gate {
                gate.abort_prepare();
            }
            if let Some(lyrics) = lyrics {
                lyrics.abort_exit_drain();
            }
        }
    }
    app.state::<ExitState>().reset_request();
    log::warn!("正常退出未完成（{reason}）：已保留窗口与 core，可再次退出重试");
    commands::emit_core_event(
        app,
        crate::bridge::APP_NOTICE,
        serde_json::json!({
            "text": format!("退出未完成：配置还没全部保存（{reason}）。窗口已保留，请稍后重新退出一次。")
        }),
    );
    focus_main(app);
}

/// 退出线程：**先做可失败的保存准备，再做不可逆清理**（顺序是合同，不是风格）。
fn run_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = finish_prepared_exit(
        prepare_exit(app),
        || commit_exit(app),
        |reason| abort_exit(app, reason),
    );
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
    // 托盘/单实例/登录窗/失败恢复都经这里：后台验证实例一次都不许被端到前台
    if background_test() {
        log::info!("后台验证开关生效：跳过把主窗拉到前台");
        return;
    }
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
            // 后台验证实例收到第二实例信号就退出：用户的启动按插件惯例也退出（需再点一次图标）
            match second_instance_action(background_test()) {
                SecondInstanceAction::FocusExisting => focus_main(app),
                SecondInstanceAction::ExitBackgroundTest => {
                    log::info!("第二实例启动：后台验证实例让位退出（{BACKGROUND_TEST_ENV} 生效）");
                    app.exit(0);
                }
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags(background_test()))
                // 歌词几何归歌词宿主管理，尤其不能把 Shell child 的坐标写进窗口状态文件。
                .with_filter(persist_window_state)
                .skip_initial_state(LYRICS_WINDOW_LABEL)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // R65：对话框插件**只从 Rust 侧用**（`local_library::pick_paths`）。登记插件本身不给
        // 渲染层任何能力：JS 那条 `plugin:dialog|*` 要经 capabilities 授权，而本应用没有那条权限
        // （见 `src-tauri/capabilities/main.json` 与 `test/packaging.test.mjs` 的扫描）。
        .plugin(tauri_plugin_dialog::init())
        /*
          R65：本地曲库的自定义 URI 协议（`hwlocal`）。判定全在 `local_library::handle_protocol`（纯函数）：
          只按 **id** 查索引（路径不进 URL）、只服务主窗（其它来源 webview 一律 404）、音频支持 Range。
          磁盘读放在阻塞线程池上：同步读一个几十 MB 的文件会把那一帧的其它请求一起堵住。
        */
        .register_asynchronous_uri_scheme_protocol(local_library::PROTOCOL_SCHEME, |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_string();
            let path = request.uri().path().to_string();
            let range = request
                .headers()
                .get("range")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            tauri::async_runtime::spawn_blocking(move || {
                let outcome = match crate::webview_data_root(&app) {
                    Ok(root) => local_library::handle_protocol(&root, &label, &path, range.as_deref()),
                    Err(error) => {
                        log::warn!("本地曲库协议拿不到数据根：{error}");
                        local_library::ProtocolOutcome::not_found_for_data_root()
                    }
                };
                let mut builder = tauri::http::Response::builder().status(outcome.status);
                for (name, value) in &outcome.headers {
                    builder = builder.header(name, value);
                }
                let response = builder
                    .body(outcome.body)
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(4 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                // 时间统一成**本地时间**：插件默认 UTC，与用户看到的系统时间差一个时区，
                // 排障时对不上"刚才那一下"。（这一句会把行格式换成 [时间][级别][target]。）
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
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
            // R27（用户三项之 3）：数据根与它的来源先落一行——"会话为什么不在"的一半答案在这里。
            // 位置在建窗之前：建窗失败（`os error 5` 那类）时，这一行是唯一说出"当时读的是哪个根"的记录。
            log::info!(
                "{}",
                data_root_note(std::env::var(DATA_DIR_ENV).ok().as_deref(), &data_root)
            );
            app.manage(close_behavior::CloseBehaviorState::restore(&data_root));

            // 主题（R25）：与关窗行为同一个位置（**先于建窗**读盘）。三个 webview
            //（主窗 + 两个浮动控件）都要在挂载时读到它，而浮动控件是登录那一刻才建的
            // ——早一步登记，就不存在"第一个读它的人比登记早"的窗口。
            app.manage(theme::ThemeState::restore(&data_root));
            app.manage(ExitState::default());
            // R44e：持久化准入门**先于**任何能写盘的运行时登记（主题事务、歌词保存任务、退出编排
            // 都要在受理时看到同一个阶段）。
            app.manage(Arc::new(commands::PersistenceGate::new()));

            let data_root = create_main_window(handle)?;
            app.manage(WebviewDataRoot(data_root.clone()));

            // 先登记运行配置与 revision（R44e：**只读**恢复盘上的歌词配置当基线——主窗不再
            // bootstrap 写盘，内存与盘上必须一开始就一致），再起 Rust 拥有的保存任务。
            app.manage(lyrics_window::LyricsWindowState::restore(&data_root));
            // R51：设置弹出窗的会话内状态（锚点 / 量到的内容尺寸 / 最近失焦关闭的时刻）。
            // 登记位置与歌词窗相邻：两者说的是同一件事的相邻两半，谁先谁后都不会被读到半份。
            app.manage(lyrics_settings::SettingsPopupState::default());
            lyrics_window::start_persistence(handle);
            #[cfg(windows)] {
                app.manage(taskbar_lyrics::Host::default());
                if let Err(reason) = taskbar_lyrics::observe_main(handle) { log::warn!("任务栏消息观察不可用：{}", reason.as_str()); }
                taskbar_lyrics::Host::start(handle);
            }

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
            // 托盘不可用时关窗回退退出。
            match tray::install(handle) {
                tray::TrayInstall::Installed(_) => log::info!("托盘已装上（id={TRAY_ID}）"),
                tray::TrayInstall::Unavailable { reason } => {
                    log::warn!("{}", tray::tray_notice(&reason))
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
            // R56：设置页「日志」标签的数据源（主窗来源守卫 + 返回前脱敏）
            commands::core_read_run_log,
            // R65：本地曲库四条命令（选文件 / 快照 / 导入 / 移除）。对话框只在 Rust 侧开，
            // 路径只在宿主里，渲染层拿到的每条记录只有 id 与元数据。
            local_library::core_local_base_url,
            local_library::core_local_list,
            local_library::core_local_import,
            local_library::core_local_remove,
            lyrics_window::core_lyrics_toggle,
            lyrics_window::core_lyrics_configure,
            lyrics_window::core_lyrics_control,
            lyrics_window::core_lyrics_document,
            lyrics_window::core_lyrics_progress,
            // R51：歌词设置的**独立弹出窗**（打开 / 报尺寸 / 关闭）。位置与尺寸由 Rust 定，
            // 所以这扇窗不授予任何 window 权限（见 capabilities/lyrics-settings.json）。
            lyrics_settings::core_lyrics_settings_open,
            lyrics_settings::core_lyrics_settings_resize,
            lyrics_settings::core_lyrics_settings_close,
            // R25：登录体验的浮动控件（返回 / 主题）。**另开一条命令**而不是放宽 core_call 的
            // 来源守卫：浮动 webview 的 label 不是 main，而 core_call 收的是全部业务频道
            //（守卫与两条动作的边界见 commands.rs 的 `require_login_chrome_source`）。
            commands::core_login_chrome
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败")
        .run(|app_handle, event| {
            // tao 在 Windows 上 run_return 之后直接 process::exit，Drop 不会执行：
            // 退出路径必须显式收尸（关 stdin → sidecar exit(0) → 帧泵 EOF → 结清 pending）。
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if !app_handle.state::<ExitState>().1.load(std::sync::atomic::Ordering::Acquire) {
                        api.prevent_exit();
                        let _ = request_app_exit(app_handle);
                    }
                }
                tauri::RunEvent::Exit => commands::shutdown_core(app_handle, "应用退出"),
                _ => {}
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
    fn window_state_only_persists_main_and_never_shell_child_geometry() {
        assert!(persist_window_state("main"));
        for label in ["lyrics", "login", "login-theme", "login-return"] { assert!(!persist_window_state(label)); }
    }

    // ---- R67：后台验证开关（只改启动期的窗口激活） ---------------------------------

    /// 开关只认显式的 `1` / `true`：环境里残留的 `0`/`false`/空白一律当没开。
    #[test]
    fn the_background_test_switch_only_accepts_explicit_on_values() {
        for raw in [None, Some(""), Some("   "), Some("0"), Some("false"), Some("FALSE"), Some("yes")] {
            assert!(!background_test_flag(raw), "{raw:?} 不该把开关打开");
        }
        for raw in [Some("1"), Some(" 1 "), Some("true"), Some("True")] {
            assert!(background_test_flag(raw), "{raw:?} 应当打开开关");
        }
    }

    /// 缺省行为必须与现在完全一致：显示主窗、建完再聚焦。
    #[test]
    fn the_default_startup_shows_and_focuses_the_main_window() {
        let activation = startup_activation(false);
        assert!(activation.visible, "正常启动要显示主窗");
        assert!(activation.focused, "正常启动要拿到焦点");
        assert!(activation.focus_after_build, "正常启动建完还要 set_focus（Windows 不保证前台）");
    }

    /// 开关打开：不显示、不激活、建完也不聚焦（一次都不许把窗口端到用户眼前）。
    #[test]
    fn the_background_test_startup_neither_shows_nor_focuses_the_main_window() {
        let activation = startup_activation(true);
        assert!(!activation.visible, "后台验证实例不许显示主窗");
        assert!(!activation.focused, "后台验证实例不许激活主窗");
        assert!(!activation.focus_after_build, "后台验证实例建完也不许 set_focus");
    }

    /// 窗口状态恢复：后台验证不恢复 MAXIMIZED——Windows 上那一步就是 `ShowWindow(SW_MAXIMIZE)`。
    #[test]
    fn the_window_state_flags_drop_maximized_only_for_background_tests() {
        let normal = window_state_flags(false);
        assert!(normal.contains(StateFlags::SIZE));
        assert!(normal.contains(StateFlags::POSITION));
        assert!(normal.contains(StateFlags::MAXIMIZED), "正常启动照旧恢复最大化");

        let background = window_state_flags(true);
        assert!(background.contains(StateFlags::SIZE));
        assert!(background.contains(StateFlags::POSITION));
        assert!(!background.contains(StateFlags::MAXIMIZED), "恢复最大化会把隐藏的主窗显示出来");

        for flags in [normal, background] {
            assert!(!flags.contains(StateFlags::VISIBLE), "VISIBLE 永远不进 flags（插件会 show + set_focus）");
        }
    }

    /// 第二实例信号两条出路：正常启动拉主窗；后台验证实例写日志后让位退出。
    #[test]
    fn the_second_instance_signal_makes_a_background_test_instance_yield() {
        assert_eq!(second_instance_action(false), SecondInstanceAction::FocusExisting);
        assert_eq!(second_instance_action(true), SecondInstanceAction::ExitBackgroundTest);
    }

    /// 开关的读取只有一处：读两次就会出"建窗看见开、拉前台看见关"的事故。
    #[test]
    fn the_background_test_switch_is_read_in_exactly_one_place() {
        let source = lib_source();
        let production = production_source(&source);
        assert_eq!(
            production.matches("std::env::var(BACKGROUND_TEST_ENV)").count(),
            1,
            "开关只在 background_test() 里读一次"
        );
    }

    /// 建窗按决策走（显示/激活/建完聚焦三个动作都由 [`startup_activation`] 决定）。
    #[test]
    fn the_main_window_creation_follows_the_activation_decision() {
        let source = lib_source();
        let production = production_source(&source);
        let start = production
            .find("pub fn create_main_window")
            .expect("找不到建主窗的函数");
        let create = &production[start..];
        let body = &create[..create.find("\n}\n").expect("建主窗函数没有闭合")];
        for expected in [
            ".visible(activation.visible)",
            ".focused(activation.focused)",
            "if activation.focus_after_build {",
        ] {
            assert!(body.contains(expected), "建窗必须按决策走：{expected}");
        }
    }

    /// 单实例回调：决策分派（拉主窗 / 写日志后退出），不让位就等于测试实例抢用户的启动。
    #[test]
    fn the_second_instance_callback_dispatches_the_decision() {
        let source = lib_source();
        let plugins = plugins_block(&source);
        let single = plugins
            .find("tauri_plugin_single_instance::init(")
            .expect("必须注册 single-instance");
        let after = &plugins[single..];
        let callback = &after[..after.find(".plugin(").unwrap_or(after.len())];
        assert!(
            callback.contains("second_instance_action(background_test())"),
            "回调必须按决策分派：{callback}"
        );
        assert!(
            callback.contains("SecondInstanceAction::FocusExisting => focus_main(app)"),
            "正常启动照旧拉主窗：{callback}"
        );
        assert!(
            callback.contains("SecondInstanceAction::ExitBackgroundTest =>"),
            "后台验证实例要让位（不显示、不聚焦）：{callback}"
        );
        assert!(callback.contains("app.exit(0)"), "让位就是退出测试实例：{callback}");
    }

    /// `focus_main` 是全部"拉到前台"的唯一收口（托盘/单实例/登录/失败恢复），开关下它必须空转。
    #[test]
    fn focus_main_is_the_single_gate_for_bringing_the_window_forward() {
        let source = lib_source();
        let production = production_source(&source);
        let start = production.find("pub fn focus_main").expect("找不到 focus_main");
        let focus = &production[start..];
        let body = &focus[..focus.find("\n}\n").expect("focus_main 没有闭合")];
        let guard = body.find("background_test()").expect("focus_main 先看开关");
        let show = body.find(".show()").expect("正常启动要显示主窗");
        assert!(guard < show, "开关判断必须挡在 show 之前");
    }

    // ---- R44e：正常退出的保存准备 -------------------------------------------------

    fn settings_document(theme: Option<&str>, lyrics: Option<Value>) -> Value {
        let mut data = serde_json::json!({ "closeBehavior": "tray" });
        if let Some(theme) = theme { data["theme"] = serde_json::json!(theme); }
        if let Some(lyrics) = lyrics { data["lyricsWindow"] = lyrics; }
        serde_json::json!({ "settings": { "schemaVersion": 1, "data": data } })
    }

    /// 校验：盘上的权威文档必须与运行中的权威值一致；缺键按默认比（用户从没选过时盘上本来就没有）。
    #[test]
    fn r44e_exit_verification_compares_the_authoritative_document() {
        let defaults = lyrics_window::LyricsConfig::default();
        assert_eq!(
            verify_persisted_documents(&settings_document(None, None), theme::ThemeChoice::System, &defaults),
            Ok(()),
            "从没写过盘时（缺两格）默认值与运行值一致，退出不该被卡住"
        );

        let dark_panel = lyrics_window::LyricsConfig::default().apply_patch(&serde_json::json!({ "style": "panel" }));
        assert_eq!(
            verify_persisted_documents(
                &settings_document(Some("dark"), Some(dark_panel.persisted())),
                theme::ThemeChoice::Dark,
                &dark_panel
            ),
            Ok(())
        );

        let theme_mismatch = verify_persisted_documents(
            &settings_document(Some("light"), Some(dark_panel.persisted())),
            theme::ThemeChoice::Dark,
            &dark_panel,
        )
        .expect_err("盘上主题与内存不一致 = 最后一笔没确认");
        assert!(theme_mismatch.contains("主题"), "{theme_mismatch}");

        let lyrics_mismatch = verify_persisted_documents(
            &settings_document(Some("dark"), Some(defaults.persisted())),
            theme::ThemeChoice::Dark,
            &dark_panel,
        )
        .expect_err("盘上歌词配置与内存不一致");
        assert!(lyrics_mismatch.contains("歌词"), "{lyrics_mismatch}");

        // 回执形状认不出：两格都按默认比 → 与"运行值也是默认"一致、与"运行值非默认"不一致
        assert_eq!(
            verify_persisted_documents(&Value::Null, theme::ThemeChoice::System, &defaults),
            Ok(())
        );
        assert!(
            verify_persisted_documents(&Value::Null, theme::ThemeChoice::System, &dark_panel).is_err(),
            "读不到文档就不能替运行值背书"
        );
    }

    /// 自窗模态取消：只发非零句柄、逐个报结果；空列表什么都不发。
    #[cfg(windows)]
    #[test]
    fn r44e_own_modal_cancel_only_targets_own_nonzero_handles() {
        let posted = std::cell::RefCell::new(Vec::new());
        let cancelled = cancel_own_modal_menus(
            |hwnd| {
                posted.borrow_mut().push(hwnd);
                true
            },
            vec![("main".to_string(), 101), ("lyrics".to_string(), 0), ("login-theme".to_string(), 202)],
        );
        assert_eq!(*posted.borrow(), vec![101, 202], "句柄 0 不发（窗没建好/已销毁）");
        assert_eq!(cancelled, vec!["main".to_string(), "login-theme".to_string()]);

        posted.borrow_mut().clear();
        assert!(cancel_own_modal_menus(|hwnd| { posted.borrow_mut().push(hwnd); true }, Vec::new()).is_empty());
        assert!(posted.borrow().is_empty(), "没有自窗就不许发消息");

        // 发送失败（窗口已销毁）不算已取消：结果里不出现它
        assert!(cancel_own_modal_menus(|_| false, vec![("main".to_string(), 5)]).is_empty());
    }

    /// R44e / I1：退出顺序是**合同**——准备成功之前不许做任何不可逆的事（取消用户菜单/拖动、
    /// 停歌词保存任务、D 的 detach+收尸、`app.exit`）；准备失败一条都不做，只把原因报一次。
    ///
    /// 这条用例走的是 `run_exit` 用的那个 helper（生产路径本身），不是"源码里像不像那个顺序"：
    /// 两个闭包各记一笔，断言两种结论下的次数。
    #[test]
    fn r44e_irreversible_cleanup_never_runs_before_a_successful_prepare() {
        let log = std::cell::RefCell::new(Vec::new());
        let refused = finish_prepared_exit(
            Err("等待已受理的保存超时（还有 1 笔在飞）".to_string()),
            || log.borrow_mut().push("commit".to_string()),
            |reason| log.borrow_mut().push(format!("abort:{reason}")),
        );
        assert!(refused.is_err(), "准备失败必须如实失败（调用方据此保窗）");
        assert_eq!(
            *log.borrow(),
            vec!["abort:等待已受理的保存超时（还有 1 笔在飞）".to_string()],
            "准备失败：不可逆清理（取消菜单/停保存/D 收尸/exit）一次都不许发生"
        );

        log.borrow_mut().clear();
        let committed = finish_prepared_exit(
            Ok(()),
            || log.borrow_mut().push("commit".to_string()),
            |_| log.borrow_mut().push("abort".to_string()),
        );
        assert!(committed.is_ok());
        assert_eq!(
            *log.borrow(),
            vec!["commit".to_string()],
            "准备成功才进入不可逆清理，而且只做一次"
        );
    }

    /// 退出请求的 CAS：失败必须能复位重试；成功（终于允许退出）之后不许再被复位。
    #[test]
    fn r44e_exit_cas_resets_only_before_the_final_exit() {
        use std::sync::atomic::Ordering;
        let state = ExitState::default();
        let spawned = std::cell::Cell::new(0);
        assert_eq!(state.request(|| { spawned.set(spawned.get() + 1); Ok::<(), String>(()) }, || {}), Ok(()));
        assert_eq!(state.request(|| { spawned.set(spawned.get() + 1); Ok::<(), String>(()) }, || {}), Ok(()));
        assert_eq!(spawned.get(), 1, "重复 Quit 不重复起退出线程");

        state.reset_request();
        assert_eq!(state.request(|| { spawned.set(spawned.get() + 1); Ok::<(), String>(()) }, || {}), Ok(()));
        assert_eq!(spawned.get(), 2, "准备失败复位之后必须能再试一次");

        state.1.store(true, Ordering::Release);
        assert!(state.1.load(Ordering::Acquire));
    }

    /// R44e fix1 / review finding 4：整个退出准备**共用一个绝对期限**。
    ///
    /// 修复前只有"等在飞"与"歌词排空"拿 deadline；uncertain 重存与最终 `settings:get` 各自
    /// 另起 10 秒等待——4 秒不是上限。这里跑的是 `prepare_exit` 用的那个 helper（生产路径本身）。
    #[test]
    fn fix4_the_whole_preparation_shares_one_absolute_deadline() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(EXIT_PREPARE_BUDGET_MS);
        let seen = std::cell::RefCell::new(Vec::new());
        prepare_exit_with(
            deadline,
            |given| {
                seen.borrow_mut().push(("wait", given));
                Ok(())
            },
            |given| {
                seen.borrow_mut().push(("lyrics", given));
                Ok(())
            },
            |given| {
                seen.borrow_mut().push(("theme", given));
                Ok(())
            },
            |given| {
                seen.borrow_mut().push(("read", given));
                Ok(serde_json::json!({}))
            },
            |_| {
                seen.borrow_mut().push(("verify", deadline));
                Ok(())
            },
        )
        .expect("准备成功");
        let steps: Vec<(&str, bool)> = seen.borrow().iter().map(|(name, given)| (*name, *given == deadline)).collect();
        assert_eq!(
            steps,
            vec![("wait", true), ("lyrics", true), ("theme", true), ("read", true), ("verify", true)],
            "每一步拿到的都是同一个绝对期限（不许各自重起一个 10 秒等待）"
        );
    }

    /// R44e fix1 / review finding 4：预算用尽时**立刻**有界失败，后面的步骤一步都不许再跑。
    ///
    /// 失败走既有的可逆 abort（保窗、保 core、uncertain/dirty 留给下次），不进入不可逆清理。
    #[test]
    fn fix4_an_exhausted_budget_stops_the_preparation_before_any_further_write() {
        let ran = std::cell::RefCell::new(Vec::new());
        let result = prepare_exit_with(
            std::time::Instant::now(),
            |_| {
                ran.borrow_mut().push("wait");
                Ok(())
            },
            |_| {
                ran.borrow_mut().push("lyrics");
                Ok(())
            },
            |_| {
                ran.borrow_mut().push("theme");
                Err("退出准备预算已用尽：本次不退出，请稍后重试".to_string())
            },
            |_| {
                ran.borrow_mut().push("read");
                Ok(serde_json::json!({}))
            },
            |_| {
                ran.borrow_mut().push("verify");
                Ok(())
            },
        );
        let reason = result.expect_err("没有预算就必须有界失败（保窗可重试）");
        assert!(reason.contains("预算"), "{reason}");
        assert_eq!(*ran.borrow(), vec!["wait", "lyrics", "theme"], "失败之后不许再跑最终读与校验");
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

    /// R27（用户三项之 3）：启动诊断要把**数据根**与**它是哪来的**写成一行。
    ///
    /// 为什么非要有它：用户报"每次重启都要重登"，而最可能的原因不是代码——调试用的根
    /// （`HWMUSIC_DATA_DIR=.tmp/live-data`）与用户自跑时读的根（`%APPDATA%\<bundle>`）
    /// **互不相通**。日志里没有这一行时，"会话为什么不在"要靠人去推断当时那个进程读的是哪个根。
    /// sidecar 那一侧还有一行完整的诊断（数据根 + `session.enc` 存在性 + 恢复档位，
    /// 见 `src/main/session-diagnostic.mjs`），两处说的是**同一个**根（宿主经 `--data-dir` 交给它）。
    #[test]
    fn the_startup_note_names_the_data_root_and_where_it_came_from() {
        let root = abs("hwmusic-data");

        // 旋钮生效：报出路径 + 报出是哪个旋钮给的
        let via_override = data_root_note(Some(&abs_str("tmp-live-data")), &root);
        assert!(via_override.contains(DATA_DIR_ENV), "旋钮生效时必须报出来：{via_override}");
        assert!(
            via_override.contains(&root.to_string_lossy().to_string()),
            "报的是**实际用的**那个根（不是旋钮里那个原始写法）：{via_override}"
        );

        // 旋钮没设：报路径 + 说清来自应用数据目录（**不许**提那个旋钮——提了会让人以为它生效了）
        let fallback = data_root_note(None, &root);
        assert!(fallback.contains(&root.to_string_lossy().to_string()), "{fallback}");
        assert!(fallback.contains("数据目录"), "{fallback}");
        assert!(!fallback.contains(DATA_DIR_ENV), "旋钮没设就不许提它：{fallback}");

        // 空白旋钮 = 未设置（与 data_root_override 同一口径）
        assert_eq!(data_root_note(Some("   "), &root), fallback);
        // 一行日志：不许带换行（日志文件是行导向的）
        assert!(!fallback.contains('\n') && !via_override.contains('\n'));
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

    /// 五条具名命令都必须注册，防止仅定义却运行时 command not found。
    #[test]
    fn lyrics_window_commands_are_registered_in_the_invoke_handler() {
        let source = lib_source();
        let registered = invoke_handler_block(&source);
        for name in [
            "lyrics_window::core_lyrics_toggle",
            "lyrics_window::core_lyrics_configure",
            "lyrics_window::core_lyrics_control",
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

    /// R25：主题状态同样**先于建窗**登记——三个 webview（主窗 + 两个浮动控件）挂载时都要读它，
    /// 而浮动控件是"用户点登录那一刻"才建的：早一步登记，就不存在"第一个读它的人比登记早"的窗口。
    #[test]
    fn the_theme_state_is_registered_before_the_window_is_created() {
        let source = lib_source();
        let setup = setup_block(&source);

        let register = setup
            .find("app.manage(theme::ThemeState::restore(")
            .expect("setup 里必须按 settings.json 恢复主题并登记托管状态");
        let window = setup
            .find("create_main_window(")
            .expect("setup 里必须建主窗");
        assert!(
            register < window,
            "主题恢复要排在建窗之前（主窗挂载时就会读它）：register={register}, create={window}"
        );
    }

    /// R25：浮动控件的命令必须进 `generate_handler!`——只定义不注册，用户点浮动控件上的
    /// 「返回扫码登录」或任一主题档位都只会拿到 `command not found`（点上没反应）。
    #[test]
    fn the_login_chrome_command_is_registered_in_the_invoke_handler() {
        let source = lib_source();
        let registered = invoke_handler_block(&source);
        assert!(
            registered.contains("commands::core_login_chrome"),
            "core_login_chrome 必须进 generate_handler!：{registered}"
        );
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

        // 2. window-state：flags 与 filter（取值归 `window_state_flags`，开关那一档见 R67 用例）
        assert!(
            plugins.contains("with_state_flags(window_state_flags(background_test()))"),
            "窗口状态的 flags 必须走决策函数：{plugins}"
        );
        for forbidden in ["StateFlags::VISIBLE", "StateFlags::DECORATIONS", "StateFlags::FULLSCREEN"] {
            assert!(
                !plugins.contains(forbidden),
                "{forbidden} 不许混进 flags：歌词窗下次开机会自己弹出来 / 与无边框置顶打架"
            );
        }
        assert!(
            plugins.contains("with_filter(persist_window_state)"),
            "歌词位置不交给 window-state 持久化：{plugins}"
        );

        assert!(plugins.contains("skip_initial_state(LYRICS_WINDOW_LABEL)"), "歌词几何由配置接管，插件不能在窗口 ready 时异步盖回旧尺寸/任务栏位置");

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
        assert!(
            plugins.contains("TimezoneStrategy::UseLocal"),
            "日志时间必须是本地时间（插件默认 UTC，与用户看到的系统时间差一个时区）"
        );
    }

    /// 关窗回调消费唯一两态决策，原生操作失败时不能意外销毁主窗。
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
        assert!(production.contains("tray::CloseAction::PreventAndHide"));
        assert!(!production.contains("tray::CloseAction::PreventAndMinimize"));
        assert!(production.contains("tray::CloseAction::Quit"));
        let callback = production
            .split("window.on_window_event(move |event| {")
            .nth(1)
            .expect("主窗关窗回调")
            .split("// 显式聚焦")
            .next()
            .expect("回调收口");
        let callback: String = callback.lines().filter(|line| !line.trim_start().starts_with("//")).collect();
        assert!(!callback.contains("window.minimize()"), "撤销最小化到任务栏分支");
        assert!(callback.contains("request_app_exit("), "quit 必须退出整个应用，不能只关主窗留下歌词/登录辅助窗");
        assert!(!callback.contains("shutdown_core(") && !callback.contains("app.exit("), "退出收尾不能阻塞关窗回调");
        assert!(callback.contains("focus_main(&close_app)"), "执行失败必须保留可恢复窗口");
        let exit = production.split("fn request_app_exit<").nth(1).expect("退出工作线程").split("fn finish_prepared_exit(").next().expect("退出函数收口");
        assert!(exit.contains(".spawn(move || run_exit(&app))"), "退出必须在工作线程里跑（不许阻塞 UI 线程）");
        assert!(!exit.contains("commands::shutdown_core("), "请求本身不负责收尸：先做可失败的保存准备");
        // R44e：顺序合同——准备成功才允许 commit_exit（取消自窗模态/D 屏障/shutdown_core/app.exit）
        let runner = production
            .split("fn run_exit<")
            .nth(1)
            .expect("退出线程主体")
            .split("/// 建窗用的代理")
            .next()
            .expect("退出线程收口");
        assert!(runner.contains("finish_prepared_exit("), "退出必须经由统一收口");
        assert!(runner.contains("prepare_exit(app)"), "先做保存准备");
        assert!(runner.contains("commit_exit(app)"), "成功分支才进入不可逆清理");
        assert!(runner.contains("abort_exit(app, reason)"), "失败分支只保窗复位");
        let commit = production
            .split("fn commit_exit<")
            .nth(1)
            .expect("不可逆清理")
            .split("fn abort_exit<")
            .next()
            .expect("不可逆清理收口");
        let cancel = commit.find("cancel_own_modals_now(app)").expect("准备成功后取消自窗模态");
        let shutdown = commit.find("commands::shutdown_core(").expect("既有 sidecar 收尾");
        let exit_at = commit.find("app.exit(0)").expect("整个应用退出");
        assert!(cancel < shutdown, "取消模态在最终排队退出之前");
        assert!(shutdown < exit_at, "收尸必须先于整个应用退出");
        let failure_branch = production
            .split("fn abort_exit<")
            .nth(1)
            .expect("失败分支")
            .split("fn run_exit<")
            .next()
            .expect("失败分支收口");
        assert!(!failure_branch.contains("shutdown_core("), "准备失败不许关掉 core");
        assert!(!failure_branch.contains("begin_shutdown("), "准备失败不许进入 D 的不可逆 detach");
        assert!(!failure_branch.contains("app.exit(0)"), "准备失败不许退出");
        assert!(failure_branch.contains("abort_prepare()"), "准备失败必须复位准入门（可重试）");
        assert!(failure_branch.contains("reset_request()"), "准备失败必须复位退出 CAS（可重试）");
        assert!(failure_branch.contains("focus_main(app)"), "准备失败要把主窗拉回可操作的焦点");
        assert!(failure_branch.contains("APP_NOTICE"), "准备失败要留一条可操作提示");
        assert!(production.contains(".skip_taskbar(false)"), "任务栏按钮不能被主窗策略隐藏");
    }

    #[test]
    fn repeated_exit_requests_spawn_once_and_clean_before_exit() {
        use std::cell::RefCell;
        let state = ExitState::default();
        let effects = RefCell::new(Vec::new());
        for _ in 0..8 {
            state.request(|| {
                effects.borrow_mut().push("spawn");
                finish_app_exit(
                    || effects.borrow_mut().push("shutdown"),
                    || effects.borrow_mut().push("exit"),
                );
                Ok::<(), &str>(())
            }, || effects.borrow_mut().push("focus")).expect("请求成功");
        }
        assert_eq!(*effects.borrow(), vec!["spawn", "shutdown", "exit"]);
    }

    #[test]
    fn failed_exit_spawn_resets_the_gate_and_restores_the_window() {
        use std::cell::RefCell;
        let state = ExitState::default();
        let effects = RefCell::new(Vec::new());
        assert_eq!(state.request(|| { effects.borrow_mut().push("failed spawn"); Err("spawn failed") }, || effects.borrow_mut().push("focus")), Err("spawn failed"));
        state.request(|| { effects.borrow_mut().push("retry"); Ok::<(), &str>(()) }, || effects.borrow_mut().push("focus")).expect("可以重试");
        assert_eq!(*effects.borrow(), vec!["failed spawn", "focus", "retry"]);
    }

    #[test]
    fn concurrent_exit_requests_share_one_gate() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = Arc::new(ExitState::default());
        let spawned = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..32).map(|_| {
            let state = Arc::clone(&state);
            let spawned = Arc::clone(&spawned);
            std::thread::spawn(move || state.request(|| { spawned.fetch_add(1, Ordering::SeqCst); Ok::<(), &str>(()) }, || {}).expect("请求成功"))
        }).collect();
        for worker in workers { worker.join().expect("线程结束"); }
        assert_eq!(spawned.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn close_actions_prevent_destruction_and_call_only_the_requested_effect() {
        use std::cell::RefCell;
        for (action, expected) in [
            (tray::CloseAction::PreventAndHide, vec!["prevent", "hide"]),
            (tray::CloseAction::Quit, vec!["prevent", "exit"]),
        ] {
            let effects = RefCell::new(Vec::new());
            let result = apply_close_action(
                action,
                || effects.borrow_mut().push("prevent"),
                || { effects.borrow_mut().push("hide"); Ok::<(), &str>(()) },
                || { effects.borrow_mut().push("exit"); Ok(()) },
            );
            assert_eq!(result, Ok(()));
            assert_eq!(*effects.borrow(), expected);
        }
    }

    #[test]
    fn failed_close_effects_keep_the_close_prevented_and_never_fall_through_to_exit() {
        use std::cell::RefCell;
        for action in [tray::CloseAction::PreventAndHide, tray::CloseAction::Quit] {
            let effects = RefCell::new(Vec::new());
            let result = apply_close_action(
                action,
                || effects.borrow_mut().push("prevent"),
                || { effects.borrow_mut().push("hide"); Err("hide failed") },
                || { effects.borrow_mut().push("exit"); Err("exit worker failed") },
            );
            let (effect, error) = match action {
                tray::CloseAction::PreventAndHide => ("hide", "hide failed"),
                tray::CloseAction::Quit => ("exit", "exit worker failed"),
            };
            assert_eq!(result, Err(error));
            assert_eq!(*effects.borrow(), vec!["prevent", effect]);
        }
    }
}
