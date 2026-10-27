//! 主题三态（浅色 / 深色 / 跟随系统），状态归 Rust 持有，渲染层只按广播把类落到 `<html>` 上。
//! 三个 webview 里的入口共用这一份状态加一条广播，各存一份必然漂移。
//! 读盘认不出就用默认不猜；`settings.json` 的唯一写者是 sidecar，Rust 改盘走 `settings:set`。
//! 收到写盘错误就什么都不改，内存、原生主题与广播都不动。
//! 整笔事务在 Rust 拥有的任务里完成，invoke 等待者消失不会取消后半提交。
//! 写可能发出却没等到回执时那一笔保持 uncertain，退出流程等的是整笔主题而非底层那次调用。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::bridge::CoreError;
use crate::commands::{settings_receipt_value, spawn_settings_write, PersistAdmission};
use crate::webview_proxy::{SETTINGS_FILE_NAME, SETTINGS_SCHEMA_VERSION};

/// 磁盘与广播上的三个字面量（渲染层 `src/renderer/features/theme/theme.mjs` 同源）。
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const THEME_SYSTEM: &str = "system";

/// `settings.json` 的 `data` 里的键名（与 sidecar 的 `settings:set` 透传的那一个键同源）。
pub const THEME_KEY: &str = "theme";

/// 一档主题。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    /// 强制浅色（`<html class="light">`）
    Light,
    /// 强制深色（`<html class="dark">`）
    Dark,
    /// 跟随系统（不加类，媒体查询说了算）
    System,
}

impl ThemeChoice {
    /// 磁盘字面量 → 枚举。**只认枚举里的三个字面量**，其余（大小写不同、空白、别的词、
    /// 非字符串）一律 `None` —— 不猜、不 Trim、不忽略大小写。
    pub fn from_setting(raw: Option<&str>) -> Option<Self> {
        match raw {
            Some(THEME_LIGHT) => Some(ThemeChoice::Light),
            Some(THEME_DARK) => Some(ThemeChoice::Dark),
            Some(THEME_SYSTEM) => Some(ThemeChoice::System),
            _ => None,
        }
    }

    /// 枚举 → 磁盘字面量（与 [`ThemeChoice::from_setting`] 是一对，往返不失真）。
    pub fn setting(self) -> &'static str {
        match self {
            ThemeChoice::Light => THEME_LIGHT,
            ThemeChoice::Dark => THEME_DARK,
            ThemeChoice::System => THEME_SYSTEM,
        }
    }

    pub fn to_native(self) -> Option<tauri::Theme> {
        match self {
            ThemeChoice::Light => Some(tauri::Theme::Light),
            ThemeChoice::Dark => Some(tauri::Theme::Dark),
            ThemeChoice::System => None,
        }
    }

    /// 一行给人看的说法（日志用）。
    pub fn describe(self) -> &'static str {
        match self {
            ThemeChoice::Light => "浅色（强制）",
            ThemeChoice::Dark => "深色（强制）",
            ThemeChoice::System => "跟随系统",
        }
    }
}

impl std::fmt::Display for ThemeChoice {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.setting())
    }
}

/// 没有这一项或认不出时的落点，跟随系统，什么都不强制。
pub const DEFAULT_THEME: ThemeChoice = ThemeChoice::System;

/// `settings.json` 文本 → 主题档位；认不出/没写一律 `None`（由调用方决定回落）。
pub fn parse_theme(raw: Option<&str>) -> Option<ThemeChoice> {
    let value: Value = serde_json::from_str(raw?).ok()?;
    let document = value.as_object()?;
    if document.get("schemaVersion").and_then(Value::as_f64) != Some(SETTINGS_SCHEMA_VERSION) {
        return None;
    }
    let setting = document.get("data")?.as_object()?.get(THEME_KEY)?;
    ThemeChoice::from_setting(setting.as_str())
}

/// 读数据目录下的 `settings.json` 得到启动档位，读不了或认不出就算 [`DEFAULT_THEME`] 不猜。
/// 只在启动时调用一次，运行期内存里那份才是权威，读盘一律经 sidecar 的排空屏障。
pub fn read_theme(data_dir: &Path) -> ThemeChoice {
    match std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)) {
        Ok(raw) => parse_theme(Some(&raw)).unwrap_or(DEFAULT_THEME),
        Err(_) => DEFAULT_THEME,
    }
}

/// 一次写入的载荷（**只动 `theme` 一个键**：其余键由 sidecar 的 merge 原样保留）。
pub fn theme_patch(choice: ThemeChoice) -> Value {
    json!({ THEME_KEY: choice.setting() })
}

/// 主题的托管状态，在 setup 里登记，`current` 只在事务确认提交后写，`uncertain` 超时时必须留着。
/// `order` 是整笔事务的顺序门，`revision` 单调递增让旧回执盖不掉新的，不能把超时当没写。
pub struct ThemeState {
    data_dir: PathBuf,
    current: Mutex<ThemeChoice>,
    revision: AtomicU64,
    uncertain: Mutex<Option<ThemeChoice>>,
    order: Mutex<()>,
}

impl ThemeState {
    /// 启动时按磁盘恢复（并记一行日志）。
    pub fn restore(data_dir: &Path) -> Self {
        let choice = read_theme(data_dir);
        log::info!(
            "主题（按 {SETTINGS_FILE_NAME} 恢复）：{choice}（{}）",
            choice.describe()
        );
        ThemeState {
            data_dir: data_dir.to_path_buf(),
            current: Mutex::new(choice),
            revision: AtomicU64::new(0),
            uncertain: Mutex::new(None),
            order: Mutex::new(()),
        }
    }

    /// 当前档位（**不读盘**：内存里那份是唯一权威，改盘与更新在同一笔事务里完成）。
    pub fn current(&self) -> ThemeChoice {
        *lock(&self.current)
    }

    /// 当前 revision（每次**确认提交** +1；读回与广播都带它）。
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    /// 档位与 revision 必须取自同一笔提交，分开读会给出新档位配旧编号的假快照。
    /// 写者在 `current` 的互斥量内同时改两者，所以持着它读编号即可。
    pub fn snapshot(&self) -> ThemeCommit {
        let current = lock(&self.current);
        ThemeCommit {
            theme: *current,
            revision: self.revision.load(Ordering::Acquire),
        }
    }

    /// 有没有一档"可能已写盘但没确认"的主题。`Some` = 退出前必须重存权威主题。
    pub fn uncertain(&self) -> Option<ThemeChoice> {
        *lock(&self.uncertain)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 一笔已提交主题事务的快照，由事务本身产出，保证回执与广播同源而不是事后另读当前档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeCommit {
    pub theme: ThemeChoice,
    pub revision: u64,
}

/// 这次失败算不算"可能已经写了"，= 必须留 uncertain；超时时 sidecar 仍可能把那帧处理完。
pub fn is_uncertain_write(error: &CoreError) -> bool {
    matches!(error.kind.as_deref(), Some("timeout") | Some("uncertain"))
}

/// 整笔主题事务的编排，三个外部效果由参数注入所以可脱机测。
/// 只有写盘回执确认成功才更新内存、应用原生主题并广播，超时或回执认不出时留 uncertain 不提交。
pub fn apply_theme_transaction<W, N, B>(
    state: &ThemeState,
    choice: ThemeChoice,
    write: W,
    native: N,
    broadcast: B,
) -> Result<ThemeCommit, CoreError>
where
    W: FnOnce() -> Result<Option<ThemeChoice>, CoreError>,
    N: FnOnce(Option<tauri::Theme>) -> Result<(), String>,
    B: FnOnce(ThemeChoice, u64),
{
    let _order = lock(&state.order);
    // 写之前就记账：从这一刻起"盘上可能是新主题"，直到确认提交或明确失败。
    *lock(&state.uncertain) = Some(choice);

    match write() {
        Ok(Some(received)) if received == choice => {
            *lock(&state.uncertain) = None;
        }
        Ok(Some(received)) => {
            // 回执里的主题不是我们要的那一档：盘上的作者是别人（并发写者）。这一笔不能确认。
            return Err(CoreError::new(
                "uncertain",
                format!(
                    "主题写入回执为 {}（请求 {}）：本次不提交，退出前会重存权威主题",
                    received.setting(),
                    choice.setting()
                ),
            ));
        }
        Ok(None) => {
            return Err(CoreError::new(
                "uncertain",
                "主题写入回执里读不出主题：本次不提交，退出前会重存权威主题",
            ));
        }
        Err(error) => {
            if !is_uncertain_write(&error) {
                *lock(&state.uncertain) = None;
            }
            return Err(error);
        }
    }

    // 档位与 revision 在**同一个临界区**里前进：快照读（`ThemeState::snapshot`）不会拼出
    // "新档位 + 旧编号"这种谁都解释不了的组合。
    let commit = {
        let mut current = lock(&state.current);
        *current = choice;
        ThemeCommit {
            theme: choice,
            revision: state.revision.fetch_add(1, Ordering::AcqRel) + 1,
        }
    };
    let native_result = native(choice.to_native());
    broadcast(commit.theme, commit.revision);
    match native_result {
        Ok(()) => Ok(commit),
        Err(error) => {
            let message = format!(
                "主题 {} 已保存并广播，但原生标题栏应用失败（{error}）；下次启动将重试",
                choice.setting()
            );
            log::warn!("{message}");
            Err(CoreError::new("internal", message))
        }
    }
}

/// 起一条 Rust 拥有的线程跑整笔事务，受理在命令线程上同步完成，凭据随线程走完才放行退出。
pub fn spawn_theme_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    choice: ThemeChoice,
) -> Result<std::sync::mpsc::Receiver<Result<ThemeCommit, CoreError>>, CoreError> {
    use tauri::Manager;
    if app.try_state::<ThemeState>().is_none() {
        return Err(CoreError::new(
            "internal",
            "主题状态未登记（setup 未完成）：主题改不了",
        ));
    }
    let admission = crate::commands::persistence_gate(app)?
        .admit(crate::commands::PersistKind::Renderer)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let owner = app.clone();
    std::thread::Builder::new()
        .name("theme-commit".into())
        .spawn(move || {
            let _ = sender.send(run_theme_transaction(&owner, choice, admission));
        })
        .map_err(|error| CoreError::new("internal", format!("主题事务线程起不来（{error}）")))?;
    Ok(receiver)
}

fn run_theme_transaction<R: tauri::Runtime>(
    app: &AppHandle<R>,
    choice: ThemeChoice,
    _admission: PersistAdmission,
) -> Result<ThemeCommit, CoreError> {
    use tauri::Manager;
    let state = app.try_state::<ThemeState>().ok_or_else(|| {
        CoreError::new("internal", "主题状态未登记（setup 未完成）：主题改不了")
    })?;
    let write_app = app.clone();
    apply_theme_transaction(
        &state,
        choice,
        move || {
            let receiver = spawn_settings_write(&write_app, theme_patch(choice));
            let answer = receiver
                .recv()
                .map_err(|_| CoreError::new("internal", "主题写入任务没有回话"))??;
            Ok(settings_receipt_value(&answer, THEME_KEY)
                .and_then(Value::as_str)
                .and_then(|raw| ThemeChoice::from_setting(Some(raw))))
        },
        |native| {
            let window = app
                .get_webview_window(crate::MAIN_WINDOW_LABEL)
                .ok_or_else(|| "找不到主窗".to_string())?;
            window.set_theme(native).map_err(|error| error.to_string())
        },
        |applied, revision| {
            crate::commands::emit_core_event(
                app,
                crate::bridge::THEME_CHANGED,
                json!({ "theme": applied.setting(), "revision": revision }),
            );
        },
    )
}

/// 当前档位（托管状态没登记时回落 [`DEFAULT_THEME`]，并留一行 warn——那本身是要修的事）。
pub fn current_theme<R: tauri::Runtime>(app: &AppHandle<R>) -> ThemeChoice {
    use tauri::Manager;
    match app.try_state::<ThemeState>() {
        Some(state) => state.current(),
        None => {
            log::warn!("主题状态未登记：按默认（{DEFAULT_THEME}）处理");
            DEFAULT_THEME
        }
    }
}

/// 当前档位 + revision（`core_login_chrome` 的读回用：渲染层靠 revision 拒绝旧回执）。
///
/// 一次**原子快照**：档位与编号来自同一笔提交（见 [`ThemeState::snapshot`]）。
pub fn current_snapshot<R: tauri::Runtime>(app: &AppHandle<R>) -> ThemeCommit {
    use tauri::Manager;
    match app.try_state::<ThemeState>() {
        Some(state) => state.snapshot(),
        None => ThemeCommit { theme: DEFAULT_THEME, revision: 0 },
    }
}

/// 改主题并广播，是渲染层发起的入口，先过准入门再把整笔事务交给 Rust 拥有的线程。
/// 回执是这一笔事务提交的那一对 `{theme, revision}` 而不是事后另读的快照。
pub async fn set_theme<R: tauri::Runtime>(
    app: &AppHandle<R>,
    choice: ThemeChoice,
) -> Result<ThemeCommit, CoreError> {
    let receiver = spawn_theme_transaction(app, choice)?;
    let owner = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .unwrap_or_else(|_| Err(CoreError::new("internal", "主题事务没有回话")))
    });
    let applied = match task.await {
        Ok(result) => result?,
        Err(source) => {
            let _ = owner;
            return Err(CoreError::new("internal", format!("主题事务等待失败：{source}")));
        }
    };
    Ok(applied)
}

/// `core_login_chrome` 回执 `{theme, revision}` 的唯一构造点，保证形状与来源不漂移。
/// 写盘回执传这一笔提交，读回传当前原子快照，别处不许另读一次当前档位。
pub fn reply_payload(commit: ThemeCommit) -> Value {
    json!({ "theme": commit.theme.setting(), "revision": commit.revision })
}

/// 退出用的 uncertain 处置，把当前权威主题重存一次，成功才清 uncertain，失败必须保窗而非当作已一致。
/// `deadline` 是整个退出准备的绝对期限，重存只用剩余预算，用尽即立刻有界失败并保留 uncertain。
pub fn resolve_uncertain<R: tauri::Runtime>(
    app: &AppHandle<R>,
    deadline: std::time::Instant,
) -> Result<bool, CoreError> {
    use tauri::Manager;
    let Some(state) = app.try_state::<ThemeState>() else {
        return Ok(true);
    };
    if state.uncertain().is_none() {
        return Ok(true);
    }
    // 受理凭据覆盖整笔重存（写 + 回执校验 + 清 uncertain）：invoke 等待者与被退出线程都看得见它。
    let admission = crate::commands::persistence_gate(app)?
        .admit(crate::commands::PersistKind::Internal)?;
    let result = resolve_uncertain_with(state.inner(), deadline, |choice, timeout| {
        crate::commands::settings_write_owned_within(app, theme_patch(choice), timeout)
    });
    drop(admission);
    result
}

/// [`resolve_uncertain`] 的可脱机测试版本，写调用由参数注入并拿到调用方给的时间上限。
/// 顺序是合同，没有 uncertain 就什么都不做，预算用尽时立刻失败且一次都不写。
pub fn resolve_uncertain_with<W>(
    state: &ThemeState,
    deadline: std::time::Instant,
    write: W,
) -> Result<bool, CoreError>
where
    W: FnOnce(ThemeChoice, std::time::Duration) -> Result<Value, CoreError>,
{
    if state.uncertain().is_none() {
        return Ok(true);
    }
    let timeout = crate::commands::call_timeout_within(
        deadline,
        std::time::Instant::now(),
        std::time::Duration::from_secs(crate::commands::SETTINGS_CALL_TIMEOUT_SECS),
    )?;
    let choice = state.current();
    // 顺序门与主题事务共用：重存不会与一笔在飞的主题提交交叉。
    let _order = lock(&state.order);
    if state.uncertain().is_none() {
        return Ok(true);
    }
    let answer = write(choice, timeout)?;
    let confirmed = settings_receipt_value(&answer, THEME_KEY)
        .and_then(Value::as_str)
        .and_then(|raw| ThemeChoice::from_setting(Some(raw)));
    if confirmed != Some(choice) {
        return Err(CoreError::new(
            "uncertain",
            format!(
                "退出前重存主题 {} 未得到确认（回执认不出或与请求不一致）",
                choice.setting()
            ),
        ));
    }
    *lock(&state.uncertain) = None;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 磁盘夹具：只给 `read_theme`/`restore` 的启动恢复用。
    fn document(theme: &str) -> String {
        format!(
            "{{\n  \"schemaVersion\": 1,\n  \"data\": {{\n    \"closeBehavior\": \"quit\",\n    \"theme\": \"{theme}\",\n    \"proxy\": {{\"enabled\": true}}\n  }}\n}}\n"
        )
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("theme-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn native_theme_keeps_system_unforced() {
        assert_eq!(ThemeChoice::Light.to_native(), Some(tauri::Theme::Light));
        assert_eq!(ThemeChoice::Dark.to_native(), Some(tauri::Theme::Dark));
        assert_eq!(ThemeChoice::System.to_native(), None);
    }

    /// 枚举 → 磁盘 → 枚举 往返不失真；只认三个精确字面量。
    #[test]
    fn setting_and_from_setting_are_a_round_trip() {
        for choice in [ThemeChoice::Light, ThemeChoice::Dark, ThemeChoice::System] {
            assert_eq!(ThemeChoice::from_setting(Some(choice.setting())), Some(choice));
        }
        assert_eq!(THEME_LIGHT, "light");
        assert_eq!(THEME_DARK, "dark");
        assert_eq!(THEME_SYSTEM, "system");

        for junk in [
            None,
            Some(""),
            Some("Light"),
            Some(" light"),
            Some("auto"),
            Some("dark "),
            Some("默认"),
        ] {
            assert_eq!(ThemeChoice::from_setting(junk), None, "{junk:?} 不是档位：不许猜");
        }
    }

    /// 坏读盘一律落"跟随系统"，绝不猜一个强制档（用户不该因为一次坏文件被锁进暗色）。
    #[test]
    fn an_unreadable_or_unknown_document_falls_back_to_the_system_choice() {
        assert_eq!(parse_theme(None), None);
        assert_eq!(parse_theme(Some("{ 半个 JSON")), None);
        assert_eq!(parse_theme(Some("[]")), None);
        assert_eq!(
            parse_theme(Some("{\"schemaVersion\": 2, \"data\": {\"theme\": \"dark\"}}")),
            None,
            "陌生 schema 不当成能读的文档"
        );
        assert_eq!(
            parse_theme(Some("{\"schemaVersion\": 1, \"data\": {}}")),
            None,
            "没有这一项 = 没选过（由调用方回落默认）"
        );
        assert_eq!(
            parse_theme(Some("{\"schemaVersion\": 1, \"data\": {\"theme\": \"neon\"}}")),
            None,
            "认不出的档位不猜"
        );
        assert_eq!(
            parse_theme(Some(&document("dark"))),
            Some(ThemeChoice::Dark),
            "认得出就照读"
        );
    }

    /// 主题侧不许自己写 `settings.json`，唯一写者只能是 sidecar 的 `writeTail`，否则两个写者互相覆盖。
    #[test]
    fn the_theme_module_owns_no_second_settings_json_writer() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/theme.rs"))
            .expect("要能读到自己的源码");
        let production = match source.find("#[cfg(test)]") {
            Some(cut) => &source[..cut],
            None => &source[..],
        };
        for forbidden in [
            "std::fs::write",
            "std::fs::rename",
            "std::fs::create_dir_all",
            "write_theme",
            "document_with_theme",
        ] {
            assert!(
                !production.contains(forbidden),
                "主题模块不许再自己写 settings.json（唯一写者是 sidecar 的 writeTail）：{forbidden}"
            );
        }
        assert!(
            production.contains("settings_write_owned"),
            "主题改盘必须走内部 settings:set（与代理/歌词同一条尾链）"
        );
        assert!(
            production.contains("spawn_settings_write"),
            "写盘要在 Rust 拥有的任务里跑（invoke 等待者消失不取消）"
        );
    }

    /// 确认提交才改内存/revision/原生/广播；写失败一律什么都不动（"收到错误就什么都不改"）。
    #[test]
    fn a_failed_write_changes_nothing_and_a_confirmed_one_commits_everything() {
        let state = ThemeState::restore(&scratch("commit"));
        let effects = RefCell::new(Vec::new());
        let failed = apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || Err(CoreError::new("internal", "settings.json 的形状不认识：主题这次不落盘")),
            |_| {
                effects.borrow_mut().push("native");
                Ok(())
            },
            |_, _| effects.borrow_mut().push("broadcast"),
        );
        let error = failed.expect_err("写失败不许假成功");
        assert!(error.message.contains("不落盘"), "{}", error.message);
        assert_eq!(state.current(), DEFAULT_THEME, "写失败不改内存");
        assert_eq!(state.revision(), 0, "写失败不推进 revision");
        assert_eq!(state.uncertain(), None, "明确失败不算 uncertain（那一笔没写进去）");
        assert!(effects.borrow().is_empty(), "写失败不应用原生、不广播");

        let applied = apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || Ok(Some(ThemeChoice::Dark)),
            |native| {
                assert_eq!(native, Some(tauri::Theme::Dark));
                effects.borrow_mut().push("native");
                Ok(())
            },
            |choice, revision| {
                assert_eq!(choice, ThemeChoice::Dark);
                assert_eq!(revision, 1, "第一笔确认提交的 revision 是 1");
                effects.borrow_mut().push("broadcast");
            },
        )
        .expect("确认提交要走完");
        assert_eq!(applied, ThemeCommit { theme: ThemeChoice::Dark, revision: 1 });
        assert_eq!(state.current(), ThemeChoice::Dark);
        assert_eq!(state.revision(), 1);
        assert_eq!(state.uncertain(), None, "确认之后 uncertain 必须清掉");
        assert_eq!(*effects.borrow(), vec!["native", "broadcast"]);
    }

    /// 超时（写可能迟到）**不许当成没写**：uncertain 留着，且不提交内存/广播。
    #[test]
    fn a_timed_out_write_keeps_uncertain_until_a_later_confirmation() {
        let state = ThemeState::restore(&scratch("uncertain"));
        let error = apply_theme_transaction(
            &state,
            ThemeChoice::Light,
            || Err(CoreError::new("timeout", "调用 settings:set 超时（10 秒）")),
            |_| panic!("超时不能应用原生主题"),
            |_, _| panic!("超时不能广播"),
        )
        .expect_err("超时要如实报错");
        assert_eq!(error.kind.as_deref(), Some("timeout"));
        assert_eq!(
            state.uncertain(),
            Some(ThemeChoice::Light),
            "超时的那一档可能已经写进盘：必须留 uncertain"
        );
        assert_eq!(state.current(), DEFAULT_THEME, "没确认就不改内存");

        // 下一次成功提交（另一档）清掉 uncertain，并把 revision 推进到 1
        apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || Ok(Some(ThemeChoice::Dark)),
            |_| Ok(()),
            |_, _| {},
        )
        .expect("确认提交");
        assert_eq!(state.uncertain(), None);
        assert_eq!(state.revision(), 1);
    }

    /// 回执与请求不一致 / 回执认不出：都不提交，且**留着 uncertain**（盘上的作者是别人）。
    #[test]
    fn an_unverifiable_receipt_is_not_a_success() {
        let state = ThemeState::restore(&scratch("receipt"));
        let mismatch = apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || Ok(Some(ThemeChoice::Light)),
            |_| panic!("回执不一致不能应用"),
            |_, _| panic!("回执不一致不能广播"),
        )
        .expect_err("回执不一致必须报错");
        assert_eq!(mismatch.kind.as_deref(), Some("uncertain"));
        assert_eq!(state.uncertain(), Some(ThemeChoice::Dark));
        assert_eq!(state.current(), DEFAULT_THEME);

        let unreadable = apply_theme_transaction(
            &state,
            ThemeChoice::System,
            || Ok(None),
            |_| panic!("回执认不出不能应用"),
            |_, _| panic!("回执认不出不能广播"),
        )
        .expect_err("回执认不出必须报错");
        assert_eq!(unreadable.kind.as_deref(), Some("uncertain"));
        assert_eq!(state.uncertain(), Some(ThemeChoice::System), "后一笔覆盖前一笔记账");
        assert_eq!(state.revision(), 0);
    }

    /// 原生失败保 A 语义（盘上/内存已是新主题、广播照发），但要把失败报出去。
    #[test]
    fn native_failure_keeps_the_saved_theme_and_still_broadcasts_it() {
        let state = ThemeState::restore(&scratch("native-fail"));
        let effects = RefCell::new(Vec::new());
        let error = apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || Ok(Some(ThemeChoice::Dark)),
            |native| {
                assert_eq!(native, Some(tauri::Theme::Dark));
                effects.borrow_mut().push("native");
                Err("native failure".to_string())
            },
            |choice, _| {
                assert_eq!(choice, ThemeChoice::Dark);
                effects.borrow_mut().push("broadcast");
            },
        )
        .expect_err("原生失败不可假成功");
        assert_eq!(error.kind.as_deref(), Some("internal"));
        assert!(error.message.contains("已保存") && error.message.contains("native failure"));
        assert_eq!(*effects.borrow(), vec!["native", "broadcast"]);
        assert_eq!(state.current(), ThemeChoice::Dark);
        assert_eq!(state.revision(), 1);
        assert_eq!(state.uncertain(), None, "写到盘并确认了，原生失败不是 uncertain");
    }

    /// 快速两笔主题：revision 单调、顺序门保证"后一笔是最后一笔"，广播的序号不许回退。
    #[test]
    fn two_quick_changes_commit_in_order_with_monotonic_revisions() {
        let state = ThemeState::restore(&scratch("rapid"));
        let seen = RefCell::new(Vec::new());
        for choice in [ThemeChoice::Dark, ThemeChoice::Light] {
            apply_theme_transaction(
                &state,
                choice,
                || Ok(Some(choice)),
                |_| Ok(()),
                |applied, revision| seen.borrow_mut().push((applied, revision)),
            )
            .expect("两笔都要提交");
        }
        assert_eq!(
            *seen.borrow(),
            vec![(ThemeChoice::Dark, 1), (ThemeChoice::Light, 2)],
            "revision 单调递增，广播不许乱序"
        );
        assert_eq!(state.current(), ThemeChoice::Light, "内存是最后一笔");
        assert_eq!(state.revision(), 2);
    }

    /// 命令回执必须带这一笔事务自己提交的 `(theme, revision)`，与广播同源。
    #[test]
    fn fix3_a_commit_reply_carries_the_very_revision_that_transaction_committed() {
        let state = ThemeState::restore(&scratch("commit-reply"));
        let broadcasts = RefCell::new(Vec::new());
        let commit = |choice: ThemeChoice| {
            apply_theme_transaction(
                &state,
                choice,
                || Ok(Some(choice)),
                |_| Ok(()),
                |applied, revision| broadcasts.borrow_mut().push((applied, revision)),
            )
            .expect("确认提交")
        };

        let first = commit(ThemeChoice::Dark);
        let second = commit(ThemeChoice::Light);

        assert_eq!(
            first,
            ThemeCommit { theme: ThemeChoice::Dark, revision: 1 },
            "回执是这一笔自己的快照（不是事后另读：那时编号已经是 2）"
        );
        assert_eq!(second, ThemeCommit { theme: ThemeChoice::Light, revision: 2 });
        assert_eq!(
            *broadcasts.borrow(),
            vec![(ThemeChoice::Dark, 1), (ThemeChoice::Light, 2)],
            "回执与广播必须是同一份 (theme, revision)"
        );
        assert_eq!(state.snapshot(), second, "快照里的档位与编号也必须是同一笔的");
    }

    /// 退出前重存 uncertain 只能用剩余预算，预算耗尽时一次都不写并保留 uncertain。
    #[test]
    fn fix4_the_uncertain_rewrite_only_gets_the_remaining_exit_budget() {
        let state = ThemeState::restore(&scratch("uncertain-budget"));
        // 回执如实回显请求写入的那一档（注入的写是"真实侧的唯一外部效果"，别让夹具自己编答案）
        let receipt = |choice: ThemeChoice| {
            Ok(json!({ "settings": { "data": { THEME_KEY: choice.setting() } } }))
        };

        *lock(&state.uncertain) = Some(ThemeChoice::Dark);
        let now = std::time::Instant::now();
        let granted = RefCell::new(Vec::new());
        resolve_uncertain_with(&state, now + std::time::Duration::from_millis(300), |choice, timeout| {
            granted.borrow_mut().push(timeout);
            receipt(choice)
        })
        .expect("重存确认");
        let timeout = granted.borrow()[0];
        assert!(
            timeout <= std::time::Duration::from_millis(300)
                && timeout > std::time::Duration::from_millis(250),
            "写调用只拿剩余预算（不是新的 10 秒）：{timeout:?}"
        );
        assert_eq!(state.uncertain(), None, "确认之后 uncertain 清掉");

        // 预算用尽：一次都不许写，uncertain 留着（退出必须保窗，而不是"当作已写"）
        *lock(&state.uncertain) = Some(ThemeChoice::Dark);
        let writes = RefCell::new(0);
        let error = resolve_uncertain_with(&state, now, |choice, _timeout| {
            *writes.borrow_mut() += 1;
            receipt(choice)
        })
        .expect_err("没有预算就必须立刻失败");
        assert_eq!(error.kind.as_deref(), Some("timeout"));
        assert_eq!(*writes.borrow(), 0, "没有预算就不许再起一笔写");
        assert_eq!(state.uncertain(), Some(ThemeChoice::Dark), "失败保 uncertain，留给下一次退出/下一笔确认");

        // 没有 uncertain 时什么都不做（预算再紧也不该报错）
        *lock(&state.uncertain) = None;
        assert!(resolve_uncertain_with(&state, now, |_, _| panic!("没有 uncertain 不许写盘")).expect("无事可做"));
    }

    /// 回执在构造点绑定自己那一笔，晚组装也必须仍是 `(dark, 1)` 而不是最新快照。
    #[test]
    fn fix3_a_reply_is_built_from_its_own_commit_not_from_the_latest_snapshot() {
        let state = ThemeState::restore(&scratch("commit-reply-payload"));
        let commit = |choice: ThemeChoice| {
            apply_theme_transaction(&state, choice, || Ok(Some(choice)), |_| Ok(()), |_, _| {})
                .expect("确认提交")
        };
        let first = commit(ThemeChoice::Dark);
        let second = commit(ThemeChoice::Light);

        assert_eq!(
            reply_payload(first),
            json!({ "theme": "dark", "revision": 1 }),
            "第一笔的回执是它自己提交的那一对（现在最新快照已经是 light/2）"
        );
        assert_eq!(reply_payload(second), json!({ "theme": "light", "revision": 2 }));
        assert_eq!(reply_payload(state.snapshot()), reply_payload(second), "读回用同一个构造点，形状不漂移");
    }

    /// 顺序门是**排他的**：一笔事务在写盘时可重入的那一笔不能先提交。
    #[test]
    fn the_order_gate_serializes_whole_transactions() {
        let state = ThemeState::restore(&scratch("order"));
        let log = RefCell::new(Vec::new());
        apply_theme_transaction(
            &state,
            ThemeChoice::Dark,
            || {
                // 写盘期间"另一笔"若没有顺序门就会在这里插进来提交；这里只记一笔
                log.borrow_mut().push("write-1");
                Ok(Some(ThemeChoice::Dark))
            },
            |_| Ok(()),
            |_, _| log.borrow_mut().push("commit-1"),
        )
        .expect("第一笔");
        apply_theme_transaction(
            &state,
            ThemeChoice::Light,
            || {
                log.borrow_mut().push("write-2");
                Ok(Some(ThemeChoice::Light))
            },
            |_| Ok(()),
            |_, _| log.borrow_mut().push("commit-2"),
        )
        .expect("第二笔");
        assert_eq!(
            *log.borrow(),
            vec!["write-1", "commit-1", "write-2", "commit-2"],
            "整笔事务（写 → 提交）是排他的"
        );
        assert_eq!(state.revision(), 2);
    }

    /// 改主题只影响主窗与浮窗，不得再触碰官方登录页。
    #[test]
    fn changing_the_theme_leaves_the_official_login_page_alone() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/theme.rs"))
            .expect("要能读到自己的源码");
        let production = match source.find("#[cfg(test)]") {
            Some(cut) => &source[..cut],
            None => &source[..],
        };
        let set = production
            .find("fn run_theme_transaction<")
            .expect("主题的提交点必须存在");
        let block = &production[set..];
        for forbidden in ["crate::login::", "reapply_login_theme"] {
            assert!(
                !block.contains(forbidden),
                "R28 用户指令：官方页不再跟随应用主题，改主题不许再去碰登录页（不许有 {forbidden}）：{block}"
            );
        }
        assert!(
            block.contains("THEME_CHANGED"),
            "广播一条不少：改完主题主窗与两个浮动控件的 `<html>` 类照旧一起变：{block}"
        );
    }
}
