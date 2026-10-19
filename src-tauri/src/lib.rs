//! 华为音乐第三方桌面客户端 · Tauri v2 外壳。
//!
//! R2 范围：窗口策略（1280×800 / min 960×640 / 显式 webview 数据目录）、最小权限
//! capabilities、插件链编排。R3 增加 sidecar 桥（NDJSON stdio、命令白名单、宿主要求路由）。
//! 登录窗、托盘、歌词窗由后续任务加入。

mod bridge;
mod commands;
mod sidecar;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// 主窗 label。窗口由代码创建（`tauri.conf.json` 的 `app.windows` 故意留空）。
pub const MAIN_WINDOW_LABEL: &str = "main";
/// 桌面歌词窗 label。窗口本体由 R12 创建，这里先定义以固定 window-state 的过滤白名单。
pub const LYRICS_WINDOW_LABEL: &str = "lyrics";
/// 托盘 id 前缀（菜单项 id 形如 `tray:play`）；托盘本体由 R11 创建。
pub const TRAY_ID: &str = "tray";
/// 数据目录覆盖旋钮：只接受绝对路径，空值等同未设置（%APPDATA% 不可写时排障用）。
pub const DATA_DIR_ENV: &str = "HWMUSIC_DATA_DIR";

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

/// 创建主窗（1280×800，最小 960×640，显式数据目录）。
///
/// 返回实际使用的 webview 数据根，由 `run()` 登记为托管状态。目录必须先建：
/// WebView2 不会自建，缺目录时建窗直接 `os error 5`（拒绝访问）。
pub fn create_main_window(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let webview_data = webview_data_root(app)?;
    std::fs::create_dir_all(&webview_data)?;

    // 标题与 tauri.conf.json 的 productName（= src/shared/app-name.mjs 的显示名）同源
    let title = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string());

    let window = WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT)
    .min_inner_size(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT)
    .data_directory(webview_data.clone())
    .build()?;

    // 显式聚焦：Windows 下窗口刚建好时不保证在前台
    window.set_focus()?;
    Ok(webview_data)
}

/// 第二个实例启动时把已有主窗拉到前台（single-instance 插件回调）。
pub fn focus_main(app: &tauri::AppHandle) {
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
                .build(),
        )
        .setup(|app| {
            let data_root = create_main_window(app.handle())?;
            app.manage(WebviewDataRoot(data_root));

            // core（sidecar）：起不来也不拦启动——core_call 会返回结构化 core_unavailable，
            // 比"应用直接起不来"更好排查，也不静默。
            app.manage(Arc::new(commands::CoreState::default()));
            let knobs = sidecar::SidecarKnobs::from_env();
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from("."));

            match sidecar::resolve_launch(&exe_dir, &knobs)
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
            commands::core_renderer_ready
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
}
