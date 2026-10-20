//! 主题三态（浅色 / 深色 / 跟随系统）：`settings.json` 的 `theme` 键 + `theme:changed` 广播（R25）。
//!
//! 用户四项之 4：登录体验的右上角要有「黑白主题 + 系统默认」。三个档位的**状态**放在这里
//! （Rust 侧持有），渲染层只有"把类落到 `<html>` 上"那一个副作用
//! （`src/renderer/features/theme/theme.mjs`）。
//!
//! 为什么状态归 Rust 而不是渲染层：改主题的入口有三个（gate 里的控件、浮动 `login-theme` 控件、
//! 将来的设置页），而它们活在**三个不同的 webview** 里——各存一份必然漂移
//! （"主窗是暗的、浮动控件还是亮的"）。于是：一份状态 + 一条广播（[`crate::bridge::THEME_CHANGED`]）
//! + 每个 webview 自己按广播应用类。
//!
//! 三条纪律（与 `close_behavior.rs` / `webview_proxy.rs` 的读盘同款）：
//!
//! 1. **读盘认不出就用默认，不猜**：非 JSON、`schemaVersion ≠ 1`、`data` 不是对象、
//!    `theme` 不在枚举里 —— 一律回落 [`DEFAULT_THEME`]（跟随系统 = 什么都不强制）。
//!    这与 R10 起的行为逐字一致，用户不会因为一次坏读盘突然被锁进某个强制档。
//! 2. **写盘只动 `theme` 一个键**：其余键（含未知键）原样保留——`settings.json` 是
//!    **多个消费者**共用的文档（sidecar 写代理与关窗行为，Rust 写主题）。
//! 3. **认不出的文件绝不覆盖**：盘上是坏 JSON 或陌生 schema 时**报结构化错误**，
//!    宁可这次主题不落盘，也不砸掉用户（或新版）写的文件——`settings.mjs` 的同一条纪律。
//!
//! 写盘用"同目录临时文件 + rename"（原子替换），与 sidecar 的写法一致：正常情形下
//! 别的读者要么看到旧文档、要么看到新文档，不会是半个。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::bridge::CoreError;
use crate::webview_proxy::{SETTINGS_FILE_NAME, SETTINGS_SCHEMA_VERSION};

/// 磁盘与广播上的三个字面量（渲染层 `src/renderer/features/theme/theme.mjs` 同源）。
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const THEME_SYSTEM: &str = "system";

/// `settings.json` 的 `data` 里的键名（与 sidecar 的 `settings:set` 透传的那一个键同源）。
pub const THEME_KEY: &str = "theme";

/// 落盘临时文件的后缀（同目录、可区分；失败时尽力清掉）。
const TEMP_SUFFIX: &str = ".theme.tmp";

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

/// 没有这一项 / 认不出时的落点：**跟随系统**（= 什么都不强制，与 R10 起的行为一致）。
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

/// 读数据目录下的 `settings.json`，分三档（与 `close_behavior::read_close_behavior` 同款）：
///
/// 1. **文件不存在** → [`DEFAULT_THEME`]（用户没选过，界面显示的也是它）；
/// 2. 文件在、形状认识 → 照读（缺 `theme` 键同样落 [`DEFAULT_THEME`]）；
/// 3. 文件在但读不了 / 形状不认识 → [`DEFAULT_THEME`]（**不猜档位**：跟随系统是唯一安全的落点）。
pub fn read_theme(data_dir: &Path) -> ThemeChoice {
    match std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)) {
        Ok(raw) => parse_theme(Some(&raw)).unwrap_or(DEFAULT_THEME),
        Err(_) => DEFAULT_THEME,
    }
}

/// 把主题写进一份文档文本（**纯函数**：只有它决定"盘上应该长什么样"）。
///
/// - `raw` 是 `None`（文件还不存在）→ 造一份最小文档：`schemaVersion` + `closeBehavior`
///   的**默认值** + `theme`。为什么必须连 `closeBehavior` 一起写：`close_behavior.rs` 把
///   "文件在、但这一项没有"读成**保守值**（直接退出），而"文件不在"读成默认值（最小化到托盘）
///   ——我们造出一份缺这一项的文件，就等于悄悄把用户的关窗行为改成了"退出"；
/// - `raw` 认得（`schemaVersion == 1` 且 `data` 是对象）→ 只改 `data.theme`，其余键原样保留；
/// - `raw` 认不出 → `Err`（**绝不覆盖**，与 `settings.mjs` 同一条纪律）。
pub fn document_with_theme(raw: Option<&str>, choice: ThemeChoice) -> Result<String, CoreError> {
    let mut document = match raw {
        None => json!({
            "schemaVersion": SETTINGS_SCHEMA_VERSION,
            "data": {
                // 与 sidecar 的 `DEFAULT_CLOSE_BEHAVIOR` 同值（Rust 侧的镜像真源见 close_behavior.rs）
                "closeBehavior": crate::close_behavior::CORE_DEFAULT_CLOSE_BEHAVIOR.setting(),
            },
        }),
        Some(text) => {
            let parsed: Value = serde_json::from_str(text).map_err(|_| {
                CoreError::new(
                    "internal",
                    format!("{SETTINGS_FILE_NAME} 不是合法 JSON：主题这次不落盘，且不覆盖原文件（请手工修好或删掉）"),
                )
            })?;
            let recognized = parsed
                .get("schemaVersion")
                .and_then(Value::as_f64)
                .map(|version| version == SETTINGS_SCHEMA_VERSION)
                .unwrap_or(false)
                && parsed.get("data").map(Value::is_object).unwrap_or(false);
            if !recognized {
                return Err(CoreError::new(
                    "internal",
                    format!(
                        "{SETTINGS_FILE_NAME} 的形状不认识（本版本只认 schemaVersion={SETTINGS_SCHEMA_VERSION}）：主题这次不落盘，且不覆盖原文件"
                    ),
                ));
            }
            parsed
        }
    };

    // `data` 在上面两种来路上都保证是对象（None 那条是我们自己造的），这里只做一次防御性取值。
    let data = document
        .get_mut("data")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| CoreError::new("internal", "设置文档缺少 data 对象：主题不落盘（不覆盖原文件）"))?;
    data.insert(THEME_KEY.to_string(), Value::String(choice.setting().to_string()));

    let mut text = serde_json::to_string_pretty(&document).map_err(|source| {
        CoreError::new("internal", format!("主题文档序列化失败（{source}）：这次不落盘"))
    })?;
    text.push('\n'); // 与 sidecar 的写法一致（文件尾部一个换行）
    Ok(text)
}

/// 把主题写到数据目录下的 `settings.json`（原子替换：同目录临时文件 + rename）。
pub fn write_theme(data_dir: &Path, choice: ThemeChoice) -> Result<(), CoreError> {
    let target = data_dir.join(SETTINGS_FILE_NAME);
    // 读不到（不存在是正常的）与读坏是两件事：读坏的文本照样交给纯函数去判定
    let existing = match std::fs::read_to_string(&target) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(CoreError::new(
                "internal",
                format!("读取 {SETTINGS_FILE_NAME} 失败（{source}）：主题这次不落盘，且不覆盖原文件"),
            ))
        }
    };
    let text = document_with_theme(existing.as_deref(), choice)?;

    std::fs::create_dir_all(data_dir).map_err(|source| {
        CoreError::new("internal", format!("数据目录不可写（{source}）：主题落盘失败"))
    })?;
    let temp = data_dir.join(format!("{SETTINGS_FILE_NAME}{TEMP_SUFFIX}"));
    std::fs::write(&temp, text).map_err(|source| {
        CoreError::new("internal", format!("主题临时文件写不进去（{source}）：这次不落盘"))
    })?;
    if let Err(source) = std::fs::rename(&temp, &target) {
        // 尽力清掉临时文件；原始失败原因更重要
        let _ = std::fs::remove_file(&temp);
        return Err(CoreError::new(
            "internal",
            format!("主题写盘失败（{source}）：已保留原文件"),
        ));
    }
    Ok(())
}

/// 主题的托管状态（**在 setup 里登记**，与关窗行为同款）。
pub struct ThemeState {
    data_dir: PathBuf,
    choice: Mutex<ThemeChoice>,
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
            choice: Mutex::new(choice),
        }
    }

    /// 当前档位（**不读盘**：内存里那份是唯一权威，写盘与更新在同一处完成）。
    pub fn current(&self) -> ThemeChoice {
        *lock(&self.choice)
    }

    /// 改主题：**先落盘、再更新内存**（反过来的话，落盘失败就留下一个"界面说改了、盘上没有"的状态）。
    /// 返回实际生效的档位（就是入参——落盘失败会走 `Err`，不会静默改档）。
    pub fn set(&self, choice: ThemeChoice) -> Result<ThemeChoice, CoreError> {
        write_theme(&self.data_dir, choice)?;
        *lock(&self.choice) = choice;
        Ok(choice)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// 改主题并广播（`core_login_chrome` 的 `theme` 动作落在这里）。
///
/// 广播经 `commands::emit_core_event`（信封的唯一构造点 + 启动期排队）：改完这一下，
/// 主窗、两个浮动控件的 `<html>` 类一起变。
pub fn set_theme<R: tauri::Runtime>(
    app: &AppHandle<R>,
    choice: ThemeChoice,
) -> Result<ThemeChoice, CoreError> {
    use tauri::Manager;
    let state = app.try_state::<ThemeState>().ok_or_else(|| {
        CoreError::new("internal", "主题状态未登记（setup 未完成）：主题改不了")
    })?;
    let applied = state.set(choice)?;
    crate::commands::emit_core_event(
        app,
        crate::bridge::THEME_CHANGED,
        json!({ "theme": applied.setting() }),
    );
    // R26（用户四项之 1+2）立、R27 改落点：登录页开着的时候，官方页的主题要跟着走。
    // R26 是"导航到同一条 URL + 新 themeName"，**R27 改成"关掉重开一份"**
    // （`user_agent` 是建 webview 时的属性，运行期没有 setter——切 UA 只能靠重建，
    //  详见 `login::reapply_login_theme`）。这一步**不改回执**：登录页重开失败不该让"改主题"看起来失败了。
    crate::login::reapply_login_theme(app);
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(theme: &str) -> String {
        format!(
            "{{\n  \"schemaVersion\": 1,\n  \"data\": {{\n    \"closeBehavior\": \"quit\",\n    \"theme\": \"{theme}\",\n    \"proxy\": {{\"enabled\": true}}\n  }}\n}}\n"
        )
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

    /// 写回：**只动 theme 一个键**，其余键（含未知键）原样保留。
    #[test]
    fn writing_keeps_every_other_key_untouched() {
        let written = document_with_theme(Some(&document("light")), ThemeChoice::Dark).expect("认得出的文档要能写");
        let parsed: Value = serde_json::from_str(&written).expect("写出来必须是合法 JSON");

        assert_eq!(parsed["data"]["theme"], "dark", "要改的那个键改了");
        assert_eq!(parsed["data"]["closeBehavior"], "quit", "关窗行为不许被主题写坏");
        assert_eq!(parsed["data"]["proxy"]["enabled"], true, "代理那一段原样保留");

        // 未知键（将来的设置项 / 新版写的）也不许被吃掉
        let with_unknown = "{\"schemaVersion\": 1, \"data\": {\"theme\": \"system\", \"future\": 7}}";
        let parsed: Value = serde_json::from_str(
            &document_with_theme(Some(with_unknown), ThemeChoice::Light).expect("要能写"),
        )
        .expect("合法 JSON");
        assert_eq!(parsed["data"]["future"], 7, "未知键原样带过（前向兼容）");
        assert_eq!(parsed["data"]["theme"], "light");
    }

    /// 文件还不存在时造出来的文档必须**自带关窗行为的默认值**。
    ///
    /// 不写它的后果是真的：`close_behavior.rs` 把"文件在、但这一项没有"读成保守值（直接退出），
    /// 而"文件不在"读成默认值（最小化到托盘）——一次改主题就会悄悄改掉用户从没选过的关窗行为。
    #[test]
    fn a_fresh_document_seeds_the_close_behavior_default() {
        let written = document_with_theme(None, ThemeChoice::Dark).expect("没文件时也要能写");
        let parsed: Value = serde_json::from_str(&written).expect("合法 JSON");
        assert_eq!(parsed["schemaVersion"], 1.0);
        assert_eq!(parsed["data"]["theme"], "dark");
        assert_eq!(
            parsed["data"]["closeBehavior"],
            crate::close_behavior::CORE_DEFAULT_CLOSE_BEHAVIOR.setting(),
            "新造的文档要带着关窗行为的默认值（否则等于把它改成了保守值）"
        );
        assert_eq!(
            crate::close_behavior::parse_close_behavior(Some(&written)),
            crate::close_behavior::CORE_DEFAULT_CLOSE_BEHAVIOR,
            "落在磁盘上的那份必须真的被关窗行为那一侧读成默认值"
        );
    }

    /// 认不出的文件**绝不覆盖**（坏 JSON / 陌生 schema 都拒）。
    #[test]
    fn an_unrecognized_document_is_never_overwritten() {
        for raw in [
            "{ 半个 JSON",
            "[]",
            "{\"schemaVersion\": 2, \"data\": {\"theme\": \"dark\"}}",
            "{\"schemaVersion\": 1, \"data\": []}",
        ] {
            let error = document_with_theme(Some(raw), ThemeChoice::Dark)
                .expect_err("认不出的文件必须拒写而不是砸掉它");
            assert_eq!(error.kind.as_deref(), Some("internal"));
            assert!(
                error.message.contains(SETTINGS_FILE_NAME),
                "错误里要指明是哪个文件：{}",
                error.message
            );
        }
    }

    /// 真落盘：读回一致、二次写覆盖、且**原来的其它键还在**（原子替换不留半个文件）。
    #[test]
    fn writing_then_reading_round_trips_on_a_real_directory() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("theme-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // 文件不存在：写出来的那份自带 closeBehavior 默认值
        write_theme(&dir, ThemeChoice::Light).expect("第一次写要成功");
        assert_eq!(read_theme(&dir), ThemeChoice::Light);
        let raw = std::fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).expect("文件要在");
        assert!(raw.ends_with('\n'), "尾部一个换行（与 sidecar 的写法一致）");
        assert!(!dir.join(format!("{SETTINGS_FILE_NAME}{TEMP_SUFFIX}")).exists(), "临时文件要已被 rename 掉");

        // 第二次写：只改 theme
        write_theme(&dir, ThemeChoice::Dark).expect("第二次写要成功");
        assert_eq!(read_theme(&dir), ThemeChoice::Dark);

        // 坏文件：拒写，且原文件逐字节不变
        let broken = "这不是 JSON";
        std::fs::write(dir.join(SETTINGS_FILE_NAME), broken).expect("要能写坏文件");
        assert!(write_theme(&dir, ThemeChoice::System).is_err(), "认不出的文件必须拒写");
        assert_eq!(
            std::fs::read_to_string(dir.join(SETTINGS_FILE_NAME)).expect("文件还在"),
            broken,
            "拒写时原文件必须一字不动"
        );
        assert_eq!(read_theme(&dir), DEFAULT_THEME, "读不出来就按默认（跟随系统）");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 状态的读写：`set` 之后 `current` 跟着走；落盘失败时**内存也不动**
    ///（否则就是"界面说改了、盘上没有"那种漂移）。
    #[test]
    fn the_state_updates_only_after_a_successful_write() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("theme-state-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("能建测试目录");

        let state = ThemeState::restore(&dir);
        assert_eq!(state.current(), DEFAULT_THEME, "没有文件 = 跟随系统");

        state.set(ThemeChoice::Dark).expect("要能写");
        assert_eq!(state.current(), ThemeChoice::Dark);
        assert_eq!(read_theme(&dir), ThemeChoice::Dark, "内存与磁盘说的必须是同一件事");

        // 把文件弄坏：set 失败，内存里仍是上一个合法档位
        std::fs::write(dir.join(SETTINGS_FILE_NAME), "坏文件").expect("要能写");
        assert!(state.set(ThemeChoice::Light).is_err());
        assert_eq!(state.current(), ThemeChoice::Dark, "落盘失败不许改内存里那一份");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R26（用户四项之 1+2）立、R27 改落点：改主题之后要把**已经开着**的登录页按新主题重来一次
    /// （否则用户得自己关掉重开才看得到），而且**它不改回执**——登录页重开失败不该让
    /// 「改主题」看起来失败了。
    ///
    /// 源码钉子：这一条链路横跨两个模块（`theme::set_theme` 是主题的唯一写入口，
    /// 重开落在 `login::reapply_login_theme`），所以在这里扫主题侧那一半。
    /// R27 那一半（"关掉重开"+ 重建窗口）扫在 `login.rs` 的
    /// `a_theme_change_reopens_the_page_instead_of_navigating_the_old_one` 里。
    #[test]
    fn changing_the_theme_reapplies_it_to_an_open_login_page() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/theme.rs"))
            .expect("要能读到自己的源码");
        let production = match source.find("#[cfg(test)]") {
            Some(cut) => &source[..cut],
            None => &source[..],
        };
        let set = production
            .find("pub fn set_theme<")
            .expect("set_theme 是主题的唯一写入口");
        let block = &production[set..];
        assert!(
            block.contains("crate::login::reapply_login_theme("),
            "改完主题要把已开着的登录页按新主题重来一次：{block}"
        );
        assert!(
            block.contains("Ok(applied)"),
            "登录页重开不改回执（回执是**实际生效**的档位，与它成功与否无关）：{block}"
        );
    }
}
