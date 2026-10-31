//! 设置「关于」的两条命令：版本与运行环境、按键打开外链。
//! 外链只认 [`LINKS`] 里的键：渲染层传不了任意 URL；`src/renderer/features/settings/about-info.mjs` 的同一张表由测试逐条互钉。

use serde::Serialize;
use tauri::{Manager, Webview};

use crate::bridge::CoreError;
use crate::commands::require_main_webview;

/// 键 → 地址（顺序与渲染层一致：先本项目，后参考项目）。
pub const LINKS: &[(&str, &str)] = &[
    ("repository", "https://github.com/Solathis/HWMusic"),
    ("releases", "https://github.com/Solathis/HWMusic/releases"),
    ("issues", "https://github.com/Solathis/HWMusic/issues"),
    ("license", "https://github.com/Solathis/HWMusic/blob/main/LICENSE"),
    ("ref-huawei-music-desktop", "https://github.com/talongao/huawei-music-desktop"),
    ("ref-taskbar-lyrics", "https://github.com/ANYNC/TaskbarLyrics"),
    ("ref-spotify-lyrics-window", "https://github.com/Mai-icy/Spotify-lyrics-window"),
    ("ref-amll", "https://github.com/amll-dev/applemusic-like-lyrics"),
    ("ref-shadcn", "https://github.com/shadcn-ui/ui"),
];

/// 查表：认不出的键是 `None`。
pub fn link_url(key: &str) -> Option<&'static str> {
    LINKS.iter().find(|(name, _)| *name == key).map(|(_, url)| *url)
}

/// 「关于」的版本与运行环境；取不到的值为 `None`，界面显示占位。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    pub webview_version: Option<String>,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn core_app_info(webview: Webview) -> Result<AppInfo, CoreError> {
    require_main_webview(webview.label())?;
    Ok(AppInfo {
        version: webview.app_handle().package_info().version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version: tauri::webview_version().ok(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// 用系统默认浏览器打开固定表里的地址。只用 opener 的 Rust 函数、不注册插件：
/// 注册会给每个 webview（含官方登录页）注入点击拦截脚本，并开出 `plugin:opener|*` 入口。
#[tauri::command]
pub async fn core_open_link(webview: Webview, key: String) -> Result<(), CoreError> {
    require_main_webview(webview.label())?;
    let url = link_url(&key)
        .ok_or_else(|| CoreError::new("invalid_payload", format!("不认识的外链：{key}")))?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| {
        log::warn!("打开外链失败（{url}）：{error}");
        CoreError::new("internal", format!("打开外链失败：{error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_keys_resolve_and_unknown_keys_do_not() {
        assert_eq!(link_url("repository"), Some("https://github.com/Solathis/HWMusic"));
        assert_eq!(link_url("license"), Some("https://github.com/Solathis/HWMusic/blob/main/LICENSE"));
        assert_eq!(link_url(""), None);
        assert_eq!(link_url("https://example.com"), None, "传 URL 不等于传键");
    }

    #[test]
    fn keys_are_unique_and_urls_are_plain_https() {
        let mut keys: Vec<&str> = LINKS.iter().map(|(key, _)| *key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), LINKS.len(), "键不许重复");
        for (key, url) in LINKS {
            assert!(url.starts_with("https://github.com/"), "{key} 只放 GitHub 的 https 地址：{url}");
            assert!(!url.contains(char::is_whitespace), "{key} 的地址不许带空白");
        }
    }
}
