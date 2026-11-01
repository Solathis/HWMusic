//! 检查更新与在线更新：官方 `tauri-plugin-updater` 只从这里调用（capabilities 不给 webview `updater:*` 权限）。
//! 请求读设置里的 HTTP 代理；下载完验过签名的安装包先挂起，走正常退出（保存配置、收掉 sidecar）后才安装。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::bridge::CoreError;
use crate::commands::require_main_webview;

/// 检查请求的总时限；下载不设总时限（慢网也要能下完），只限读停顿。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_STALL: Duration = Duration::from_secs(60);
/// 总大小未知时，每下这么多字节报一次进度。
const PROGRESS_STEP_BYTES: u64 = 512 * 1024;
/// 渲染层错误类别：只有这一类的 message 会原样显示。
const UPDATE_ERROR_KIND: &str = "update";

#[derive(Default)]
pub struct UpdateState {
    found: Mutex<Option<Update>>,
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    busy: AtomicBool,
}

impl UpdateState {
    fn found(&self) -> Option<Update> {
        self.found.lock().unwrap_or_else(|poison| poison.into_inner()).clone()
    }
    fn set_found(&self, update: Option<Update>) {
        *self.found.lock().unwrap_or_else(|poison| poison.into_inner()) = update;
    }
    fn set_pending(&self, pending: Option<(Update, Vec<u8>)>) {
        *self.pending.lock().unwrap_or_else(|poison| poison.into_inner()) = pending;
    }
    fn take_pending(&self) -> Option<(Update, Vec<u8>)> {
        self.pending.lock().unwrap_or_else(|poison| poison.into_inner()).take()
    }
}

/// `core_update_check` 的回执。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// 回执的纯函数部分：`found` 是（新版本号, 说明, 发布时间）。
pub fn check_answer(current: &str, found: Option<(String, Option<String>, Option<String>)>) -> UpdateCheck {
    match found {
        Some((version, notes, date)) => UpdateCheck {
            available: true,
            current_version: current.to_string(),
            version: Some(version),
            notes,
            date,
        },
        None => UpdateCheck {
            available: false,
            current_version: current.to_string(),
            version: None,
            notes: None,
            date: None,
        },
    }
}

/// 失败归类（决定界面上的那句话）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Timeout,
    Connect,
    Http,
    NotPublished,
    Signature,
    NoPackage,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Check,
    Download,
}

pub fn classify(error: &UpdaterError) -> Failure {
    match error {
        UpdaterError::Reqwest(source) if source.is_timeout() => Failure::Timeout,
        UpdaterError::Reqwest(source) if source.is_connect() => Failure::Connect,
        UpdaterError::Reqwest(_) | UpdaterError::Network(_) => Failure::Http,
        UpdaterError::ReleaseNotFound => Failure::NotPublished,
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => Failure::Signature,
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => Failure::NoPackage,
        _ => Failure::Other,
    }
}

/// 界面上的那句话：说原因与下一步，细节进日志。
pub fn failure_message(stage: Stage, failure: Failure) -> &'static str {
    match (stage, failure) {
        (Stage::Check, Failure::Timeout | Failure::Connect) => "连不上 GitHub 的更新服务器：检查网络，或在「网络」里配置 HTTP 代理后重试。",
        (Stage::Check, Failure::Http) => "更新服务器没有返回可用的更新信息，请稍后重试。",
        (Stage::Check, Failure::NotPublished) => "还没有可用的更新信息，请稍后重试，或到 GitHub Releases 查看。",
        (Stage::Download, Failure::Timeout | Failure::Connect) => "下载更新时网络中断：检查网络或代理设置后，再点一次「下载并安装」。",
        (Stage::Download, Failure::Http) => "下载服务器没有返回安装包，请稍后重试。",
        (_, Failure::Signature) => "安装包签名校验没有通过，已放弃安装。请到 GitHub Releases 手动下载。",
        (_, Failure::NoPackage) => "这个版本没有当前系统的安装包，请到 GitHub Releases 查看。",
        (Stage::Download, Failure::NotPublished) | (_, Failure::Other) => "更新时出了意外错误（详情见运行日志），请稍后重试。",
    }
}

fn update_error(stage: Stage, error: &UpdaterError) -> CoreError {
    CoreError::new(UPDATE_ERROR_KIND, failure_message(stage, classify(error)))
}

/// 下载进度节流：总大小已知时每涨 1% 报一次，未知时每 [`PROGRESS_STEP_BYTES`] 报一次。
#[derive(Debug, Default)]
pub struct ProgressMeter {
    downloaded: u64,
    reported_percent: Option<u64>,
    reported_bytes: u64,
}

impl ProgressMeter {
    /// 记一块；该报时回 `Some((已下载, 总大小))`。
    pub fn advance(&mut self, chunk: usize, total: Option<u64>) -> Option<(u64, Option<u64>)> {
        self.downloaded += chunk as u64;
        let due = match total {
            Some(total) if total > 0 => {
                let percent = (self.downloaded.min(total) * 100) / total;
                let due = self.reported_percent.is_none_or(|last| percent > last);
                if due {
                    self.reported_percent = Some(percent);
                }
                due
            }
            _ => {
                let due = self.downloaded - self.reported_bytes >= PROGRESS_STEP_BYTES;
                if due {
                    self.reported_bytes = self.downloaded;
                }
                due
            }
        };
        due.then_some((self.downloaded, total))
    }
}

fn emit_progress<R: tauri::Runtime>(app: &AppHandle<R>, payload: Value) {
    crate::commands::emit_core_event(app, crate::bridge::UPDATE_PROGRESS, payload);
}

/// 检查更新（只问，不下载）：主窗专用，读设置里的代理。
#[tauri::command]
pub async fn core_update_check(
    app: AppHandle,
    webview: Webview,
    state: State<'_, UpdateState>,
) -> Result<UpdateCheck, CoreError> {
    require_main_webview(webview.label())?;
    let proxy = crate::webview_data_root(&app)
        .ok()
        .and_then(|root| crate::webview_proxy::read_update_proxy(&root));
    log::info!("检查更新：{}", crate::webview_proxy::describe_update_proxy(proxy.as_ref()));
    let builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.read_timeout(DOWNLOAD_STALL));
    // 没配代理就直连，与 sidecar 一致（不悄悄改用系统代理）
    let builder = match proxy {
        Some(url) => builder.proxy(url),
        None => builder.no_proxy(),
    };
    let updater = builder.build().map_err(|error| {
        log::warn!("更新器没能初始化：{error}");
        update_error(Stage::Check, &error)
    })?;
    let found = updater.check().await.map_err(|error| {
        log::warn!("检查更新失败：{error}");
        update_error(Stage::Check, &error)
    })?;
    let current = app.package_info().version.to_string();
    let answer = check_answer(
        &current,
        found.as_ref().map(|update| {
            let date = update.raw_json.get("pub_date").and_then(Value::as_str).map(str::to_string);
            (update.version.clone(), update.body.clone(), date)
        }),
    );
    match &answer.version {
        Some(version) => log::info!("检查更新：当前 {current}，有新版本 {version}"),
        None => log::info!("检查更新：当前 {current}，已是最新"),
    }
    state.set_found(found);
    Ok(answer)
}

/// 下载并校验上次检查到的新版本，然后走正常退出；真正的安装见 [`install_pending`]。
#[tauri::command]
pub async fn core_update_install(
    app: AppHandle,
    webview: Webview,
    state: State<'_, UpdateState>,
) -> Result<(), CoreError> {
    require_main_webview(webview.label())?;
    let Some(update) = state.found() else {
        return Err(CoreError::new(UPDATE_ERROR_KIND, "请先检查更新。"));
    };
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err(CoreError::new(UPDATE_ERROR_KIND, "更新已在进行中。"));
    }
    log::info!("开始下载更新 {}", update.version);
    let progress_app = app.clone();
    let mut meter = ProgressMeter::default();
    let downloaded = update
        .download(
            move |chunk, total| {
                if let Some((bytes, total)) = meter.advance(chunk, total) {
                    emit_progress(&progress_app, serde_json::json!({ "phase": "downloading", "downloaded": bytes, "total": total }));
                }
            },
            || {},
        )
        .await;
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => {
            state.busy.store(false, Ordering::Release);
            log::warn!("下载更新失败：{error}");
            return Err(update_error(Stage::Download, &error));
        }
    };
    log::info!("更新 {} 已下载并通过签名校验（{} 字节），退出后安装", update.version, bytes.len());
    state.set_pending(Some((update, bytes)));
    emit_progress(&app, serde_json::json!({ "phase": "installing" }));
    if let Err(reason) = crate::request_app_exit(&app) {
        state.set_pending(None);
        state.busy.store(false, Ordering::Release);
        log::warn!("更新没能开始安装：{reason}");
        return Err(CoreError::new(UPDATE_ERROR_KIND, "没能开始安装（详情见运行日志），请重试。"));
    }
    Ok(())
}

/// 正常退出的最后一步（sidecar 已收掉、`app.exit(0)` 之前）：有挂起的安装包就装。
/// Windows 上插件启动安装程序后直接结束进程；其余情形与失败都重启，不留半关的应用。
pub fn install_pending<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<UpdateState>() else { return };
    let Some((update, bytes)) = state.take_pending() else { return };
    log::info!("安装更新 {}", update.version);
    match update.install(&bytes) {
        Ok(()) => log::info!("更新 {} 已安装，重启进入新版本", update.version),
        Err(error) => log::error!("安装更新失败（{error}），重启回当前版本"),
    }
    app.restart();
}

/// 退出准备失败：收回挂起的安装包，回 `true` 表示这次退出本是为了安装更新。
pub fn abort_pending<R: tauri::Runtime>(app: &AppHandle<R>, reason: &str) -> bool {
    let Some(state) = app.try_state::<UpdateState>() else { return false };
    if state.take_pending().is_none() {
        return false;
    }
    state.busy.store(false, Ordering::Release);
    log::warn!("更新没有安装：退出准备未完成（{reason}）");
    emit_progress(app, serde_json::json!({
        "phase": "failed",
        "message": format!("配置还没全部保存（{reason}），更新没有安装。请再点一次「下载并安装」。"),
    }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_with_total_reports_each_percent_once() {
        let mut meter = ProgressMeter::default();
        let reported: Vec<u64> = (0..1000).filter_map(|_| meter.advance(1, Some(1000))).map(|(bytes, _)| bytes).collect();
        assert_eq!(reported.len(), 101, "0% 到 100% 各一次");
        assert_eq!(reported.first(), Some(&1));
        assert_eq!(reported.last(), Some(&1000), "下完那一块一定报");
    }

    #[test]
    fn progress_without_total_reports_every_step() {
        let mut meter = ProgressMeter::default();
        let reported: Vec<(u64, Option<u64>)> = (0..2048).filter_map(|_| meter.advance(1024, None)).collect();
        assert_eq!(reported.len(), 4, "2 MiB 按 512 KiB 一步");
        assert_eq!(reported[0], (512 * 1024, None));
    }

    #[test]
    fn check_answer_reports_new_version_or_up_to_date() {
        let latest = check_answer("0.3.0", None);
        assert!(!latest.available);
        assert_eq!(latest.current_version, "0.3.0");
        assert_eq!(latest.version, None);
        let found = check_answer("0.2.0", Some(("0.3.0".into(), Some("## 新增".into()), Some("2026-11-01T00:00:00Z".into()))));
        assert!(found.available);
        assert_eq!(found.version.as_deref(), Some("0.3.0"));
        assert_eq!(found.notes.as_deref(), Some("## 新增"));
        assert_eq!(serde_json::to_value(&found).unwrap()["currentVersion"], "0.2.0", "字段名是 camelCase");
    }

    #[test]
    fn errors_map_to_a_reason_and_next_step() {
        assert_eq!(classify(&UpdaterError::ReleaseNotFound), Failure::NotPublished);
        assert_eq!(classify(&UpdaterError::Network("Download request failed with status: 404".into())), Failure::Http);
        assert_eq!(classify(&UpdaterError::TargetsNotFound(vec!["windows-x86_64".into()])), Failure::NoPackage);
        assert_eq!(classify(&UpdaterError::SignatureUtf8("x".into())), Failure::Signature);
        assert_eq!(classify(&UpdaterError::EmptyEndpoints), Failure::Other);
        assert!(failure_message(Stage::Check, Failure::Connect).contains("HTTP 代理"));
        assert!(failure_message(Stage::Download, Failure::Signature).contains("GitHub Releases"));
        for stage in [Stage::Check, Stage::Download] {
            for failure in [Failure::Timeout, Failure::Connect, Failure::Http, Failure::NotPublished, Failure::Signature, Failure::NoPackage, Failure::Other] {
                let message = failure_message(stage, failure);
                assert!(message.ends_with('。'), "{stage:?}/{failure:?} 的提示要是一句完整的话：{message}");
                assert!(!message.is_ascii(), "提示不许是原始英文错误：{message}");
            }
        }
        assert_eq!(update_error(Stage::Check, &UpdaterError::ReleaseNotFound).kind.as_deref(), Some(UPDATE_ERROR_KIND));
    }

    /// 用正式公钥与 latest.json 地址假装是 0.0.1：检查、下载并验签最新 Release（经代理时设 HTTPS_PROXY）。
    #[test]
    #[ignore = "联网访问 GitHub Releases，发布后手动验证"]
    fn real_release_is_found_and_verified() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), config["plugins"]["updater"].clone());
        context.package_info_mut().version = "0.0.1".parse().expect("版本号");
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("测试应用");
        let proxy = std::env::var("HTTPS_PROXY").ok().and_then(|raw| tauri::Url::parse(&raw).ok());
        let builder = app.handle().updater_builder().timeout(Duration::from_secs(60));
        let builder = match proxy {
            Some(url) => builder.proxy(url),
            None => builder.no_proxy(),
        };
        let update = tauri::async_runtime::block_on(async { builder.build().expect("更新器").check().await.expect("检查更新") })
            .expect("0.0.1 应当看到新版本");
        assert_eq!(update.version, env!("CARGO_PKG_VERSION"), "latest.json 的版本就是本仓库当前版本");
        let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).expect("下载并通过签名校验");
        assert!(bytes.len() > 1024 * 1024, "安装包至少 1 MB：{}", bytes.len());
    }
}
