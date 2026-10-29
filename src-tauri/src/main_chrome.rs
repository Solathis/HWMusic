//! 沉浸页的主窗外框：Windows 上收起系统标题栏，由页面画拖动区与窗口按钮；其他平台保留原生标题栏。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Webview, WebviewWindow};

use crate::bridge::CoreError;
use crate::MAIN_WINDOW_LABEL;

/// 只有 Windows 收起标题栏（macOS / Linux 的窗口按钮与拖动习惯不同，保留原生标题栏）。
pub const FRAMELESS_SUPPORTED: bool = cfg!(windows);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChromeAction {
    Immersive,
    Normal,
    Read,
    Minimize,
    ToggleMaximize,
    Close,
}

/// 载荷必须正好是 `{action}`，动作认不出就拒。
pub fn parse_action(payload: &Value) -> Result<ChromeAction, CoreError> {
    let action = payload
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("action"))
        .and_then(Value::as_str);
    match action {
        Some("immersive") => Ok(ChromeAction::Immersive),
        Some("normal") => Ok(ChromeAction::Normal),
        Some("read") => Ok(ChromeAction::Read),
        Some("minimize") => Ok(ChromeAction::Minimize),
        Some("toggle-maximize") => Ok(ChromeAction::ToggleMaximize),
        Some("close") => Ok(ChromeAction::Close),
        _ => Err(CoreError::new(
            "invalid_payload",
            "窗口外框命令仅接受 {action: immersive|normal|read|minimize|toggle-maximize|close}",
        )),
    }
}

fn window_error(error: tauri::Error) -> CoreError {
    CoreError::new("internal", format!("主窗窗口操作失败：{error}"))
}

fn apply(window: &WebviewWindow, action: ChromeAction) -> Result<(), CoreError> {
    match action {
        ChromeAction::Immersive if FRAMELESS_SUPPORTED => window.set_decorations(false).map_err(window_error),
        ChromeAction::Immersive | ChromeAction::Read => Ok(()),
        ChromeAction::Normal => window.set_decorations(true).map_err(window_error),
        ChromeAction::Minimize => window.minimize().map_err(window_error),
        ChromeAction::ToggleMaximize => {
            let toggled = if window.is_maximized().map_err(window_error)? { window.unmaximize() } else { window.maximize() };
            toggled.map_err(window_error)
        }
        // 与系统关闭键同一条路：先触发 CloseRequested，由关窗行为决定进托盘还是退出
        ChromeAction::Close => window.close().map_err(window_error),
    }
}

/// 沉浸页的窗口外框命令（只接受主窗）：回执是实际的 `{frameless, maximized}`，渲染层据此决定画不画窗口按钮。
#[tauri::command]
pub async fn core_main_chrome(app: AppHandle, webview: Webview, payload: Value) -> Result<Value, CoreError> {
    crate::commands::require_main_webview(webview.label())?;
    let action = parse_action(&payload)?;
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| CoreError::new("internal", "找不到主窗"))?;
    apply(&window, action)?;
    let frameless = !window.is_decorated().map_err(window_error)?;
    let maximized = window.is_maximized().map_err(window_error)?;
    Ok(json!({ "frameless": frameless, "maximized": maximized }))
}

/// 把系统标题栏装回去（退出前与页面重载时）：window-state 存的是内尺寸，无框时存下会让下次启动高出一条标题栏。
pub fn restore_frame<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.set_decorations(true) {
        log::warn!("主窗标题栏没能装回（{error}）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r80_only_the_six_actions_parse() {
        for (name, action) in [
            ("immersive", ChromeAction::Immersive),
            ("normal", ChromeAction::Normal),
            ("read", ChromeAction::Read),
            ("minimize", ChromeAction::Minimize),
            ("toggle-maximize", ChromeAction::ToggleMaximize),
            ("close", ChromeAction::Close),
        ] {
            assert_eq!(parse_action(&json!({ "action": name })).unwrap(), action);
        }
        for bad in [json!({ "action": "fullscreen" }), json!({ "action": "close", "force": true }), json!("close"), json!({})] {
            assert!(parse_action(&bad).is_err(), "{bad} 应被拒");
        }
    }
}
