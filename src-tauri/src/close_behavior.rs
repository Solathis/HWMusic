//! 关窗行为（`tray` / `quit`）：读盘时将精确旧值 `minimize` 迁移为 `tray`。
//!
//! 为什么读盘这侧在 Rust：关窗回调在 Rust 里（窗口是 Rust 建的），它要在**用户关窗的那一刻**
//! 知道设置里选的是什么。写盘的是 core（设置页 → `settings:set` → `settings.json`），
//! 所以这里的读盘与 `webview_proxy` 用**同一套 schema 闸门**（同一个文件名常量、同一个
//! schemaVersion 判定）：非 JSON、不是对象、`schemaVersion` 不是 1、缺 `data`、
//! `data.closeBehavior` 不在枚举里 —— 一律当"没配"。
//!
//! **退化方向刻意保守**：认不出的形状一律回落 `quit`（能真正退出的那一个），绝不猜 `tray`。
//! 猜成 `tray` 而托盘又没装上，用户关一次窗就再也找不回应用（窗口藏了、托盘里没有）；
//! 猜成 `quit` 最坏也只是"多退出一次"，重开就有。
//!
//! 状态的形状：启动时 `restore()` 读一次盘并记日志（**先于建窗**：窗一建出来，用户就可能关它），
//! 每次关窗前 `refresh()` 再读一次——写盘的是设置页，**改完就该立刻生效**；内存里那份只当兜底，
//! 不拿去和磁盘较劲（旧仓的教训：自己记一份状态，迟早与磁盘说法不一致）。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::webview_proxy::{SETTINGS_FILE_NAME, SETTINGS_SCHEMA_VERSION};

/// 磁盘字面量（渲染层 CLOSE_BEHAVIORS / core 同源）。
pub const CLOSE_BEHAVIOR_TRAY: &str = "tray";
pub const CLOSE_BEHAVIOR_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    Tray,
    Quit,
}

impl CloseBehavior {
    /// 精确旧值 minimize 迁移 tray，不 Trim、不忽略大小写。
    pub fn from_setting(raw: Option<&str>) -> Option<Self> {
        match raw {
            Some(CLOSE_BEHAVIOR_TRAY) | Some("minimize") => Some(CloseBehavior::Tray),
            Some(CLOSE_BEHAVIOR_QUIT) => Some(CloseBehavior::Quit),
            _ => None,
        }
    }

    pub fn setting(self) -> &'static str {
        match self {
            CloseBehavior::Tray => CLOSE_BEHAVIOR_TRAY,
            CloseBehavior::Quit => CLOSE_BEHAVIOR_QUIT,
        }
    }

    pub fn hides_on_close(self) -> bool {
        matches!(self, CloseBehavior::Tray)
    }

    pub fn describe(self) -> &'static str {
        match self {
            CloseBehavior::Tray => "最小化到托盘",
            CloseBehavior::Quit => "退出应用",
        }
    }
}

impl std::fmt::Display for CloseBehavior {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.setting())
    }
}

/// core 的默认值（`src/main/settings.mjs` 的 `DEFAULT_CLOSE_BEHAVIOR` = 枚举第一项 = `tray`）。
///
/// 用在**设置里还没有这一项**的情形（`settings.json` 不存在 = 用户从没保存过设置）。
/// 那时设置页经 `settings:get` 拿到的就是 core 的这个默认值、界面显示"最小化到托盘"——
/// Rust 这侧必须按同一句话走，否则就是"界面说藏起来、关窗却退出了"。
/// 与 `webview_proxy::read_proxy` 同款：**文件不在 = 没配 = 用两端一致的默认**。
pub const CORE_DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = CloseBehavior::Tray;

/// 形状不认识时的落点（**保守方向的唯一落点**，见模块注释）：认不出的盘一律按"退出"。
///
/// 与 [`CORE_DEFAULT_CLOSE_BEHAVIOR`] 是两件事：那边是"用户还没选"，这边是"盘上的东西看不懂"。
/// 猜 `tray` 而托盘又没装上，用户关一次窗就再也找不回应用。
pub const CONSERVATIVE_CLOSE_BEHAVIOR: CloseBehavior = CloseBehavior::Quit;

/// `settings.json` 文本 → 关窗行为。
///
/// **形状不认识一律 [`CONSERVATIVE_CLOSE_BEHAVIOR`]**：非 JSON、不是对象、`schemaVersion` 不是 1、
/// 缺 `data`、`data.closeBehavior` 不在枚举里 —— 都是"退出"。
///
/// 入参是 `Option<&str>`：`None` = 没有文本可读（读盘失败那一侧），与"文本在但认不出"同一档
/// ——保守方向只需要一个落点。**文件不存在**不走这里（那是"用户还没选"，见 [`read_close_behavior`]）。
pub fn parse_close_behavior(raw: Option<&str>) -> CloseBehavior {
    raw.and_then(|raw| {
        let value: Value = serde_json::from_str(raw).ok()?;
        let document = value.as_object()?;
        if document.get("schemaVersion").and_then(Value::as_f64) != Some(SETTINGS_SCHEMA_VERSION) {
            return None;
        }
        let setting = document.get("data")?.as_object()?.get("closeBehavior")?;
        CloseBehavior::from_setting(setting.as_str())
    })
    .unwrap_or(CONSERVATIVE_CLOSE_BEHAVIOR)
}

/// 读数据目录下的 `settings.json`，分三档：
///
/// 1. **文件不存在** → [`CORE_DEFAULT_CLOSE_BEHAVIOR`]（用户还没选过；界面显示的也是它）；
/// 2. 文件在、形状认识 → 照读；
/// 3. 文件在但读不了（权限/IO）或形状不认识 → [`CONSERVATIVE_CLOSE_BEHAVIOR`]（保守：不藏窗口）。
///
/// 写入路径是 core 的 `settings:set`（同目录临时文件 + rename，原子落盘），所以正常情形下
/// 这里读到的要么是旧文档、要么是新文档，不会是半个。
pub fn read_close_behavior(data_dir: &Path) -> CloseBehavior {
    match std::fs::read_to_string(data_dir.join(SETTINGS_FILE_NAME)) {
        Ok(raw) => parse_close_behavior(Some(&raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CORE_DEFAULT_CLOSE_BEHAVIOR,
        Err(_) => CONSERVATIVE_CLOSE_BEHAVIOR,
    }
}

/// 关窗行为的托管状态（**先于建窗登记**）。
pub struct CloseBehaviorState {
    data_dir: PathBuf,
    behavior: Mutex<CloseBehavior>,
}

impl CloseBehaviorState {
    /// 启动时按磁盘恢复（**必须在建窗之前调用**），并记一行日志。
    ///
    /// 顺序不是形式主义：窗一存在，用户就可能关它，而那一刻读的就是这里恢复出来的值。
    pub fn restore(data_dir: &Path) -> Self {
        let state = CloseBehaviorState {
            data_dir: data_dir.to_path_buf(),
            behavior: Mutex::new(CORE_DEFAULT_CLOSE_BEHAVIOR),
        };
        let restored = state.refresh();
        log::info!("关窗行为（按 {SETTINGS_FILE_NAME} 恢复）：{restored}（{}）", restored.describe());
        state
    }

    /// **现读磁盘**并更新当前值；返回本次读到的值。
    ///
    /// 关窗前调用：设置页刚写下去的那一档必须当场生效（用户改完设置再关窗，
    /// 期待的就是新的行为——等下次启动才生效，等于设置页在撒谎）。
    pub fn refresh(&self) -> CloseBehavior {
        let current = read_close_behavior(&self.data_dir);
        *lock(&self.behavior) = current;
        current
    }

    /// 当前值（**不读盘**；排障与日志用）。
    pub fn current(&self) -> CloseBehavior {
        *lock(&self.behavior)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 关窗那一刻的行为：现读磁盘。
///
/// 托管状态没登记（理论上不会：它先于建窗登记）时退回 [`CONSERVATIVE_CLOSE_BEHAVIOR`]——
/// 与"读不出合法值"同一个保守方向，并且留一行 warn（"状态没登记"本身是要修的事）。
pub fn close_behavior_now(app: &AppHandle) -> CloseBehavior {
    match app.try_state::<CloseBehaviorState>() {
        Some(state) => state.refresh(),
        None => {
            log::warn!("关窗行为状态未登记：按保守值（{CONSERVATIVE_CLOSE_BEHAVIOR}）处理");
            CONSERVATIVE_CLOSE_BEHAVIOR
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 枚举 → 磁盘 → 枚举 往返不失真（两边各写一份字面量时，这条先红）。
    #[test]
    fn setting_and_from_setting_are_a_round_trip() {
        for behavior in [CloseBehavior::Tray, CloseBehavior::Quit] {
            assert_eq!(CloseBehavior::from_setting(Some(behavior.setting())), Some(behavior));
        }
        assert_eq!(CloseBehavior::Tray.setting(), "tray");
        assert_eq!(CloseBehavior::Quit.setting(), "quit");
        assert_eq!(CLOSE_BEHAVIOR_TRAY, "tray");
        assert_eq!(CLOSE_BEHAVIOR_QUIT, "quit");
    }

    #[test]
    fn exact_legacy_minimize_migrates_to_tray_on_disk_and_refresh() {
        assert_eq!(CloseBehavior::from_setting(Some("minimize")), Some(CloseBehavior::Tray));
        let raw = json!({ "schemaVersion": 1, "data": { "closeBehavior": "minimize" } }).to_string();
        assert_eq!(parse_close_behavior(Some(&raw)), CloseBehavior::Tray);
        let dir = test_dir("minimize-migration");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");
        let state = CloseBehaviorState::restore(&dir);
        write_behavior(&dir, "minimize");
        assert_eq!(read_close_behavior(&dir), CloseBehavior::Tray);
        assert_eq!(state.refresh(), CloseBehavior::Tray);
        assert_eq!(state.current(), CloseBehavior::Tray);
        assert_eq!(CloseBehaviorState::restore(&dir).current(), CloseBehavior::Tray);
        for bad in ["MINIMIZE", " minimize", "minimize ", "explode"] {
            write_behavior(&dir, bad);
            assert_eq!(state.refresh(), CloseBehavior::Quit);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只认精确字面量：大小写、空白、别的词、非字符串都不猜。
    #[test]
    fn only_the_exact_literals_are_recognized() {
        assert_eq!(CloseBehavior::from_setting(Some("tray")), Some(CloseBehavior::Tray));
        assert_eq!(CloseBehavior::from_setting(Some("quit")), Some(CloseBehavior::Quit));
        for raw in [
            Some("TRAY"),
            Some("Tray"),
            Some(" tray"),
            Some("tray "),
            Some(""),
            Some("MINIMIZE"),
            Some(" minimize"),
            Some("minimize "),
            Some("explode"),
            None,
        ] {
            assert_eq!(CloseBehavior::from_setting(raw), None, "{raw:?} 不是枚举里的字面量");
        }
    }

    /// `hides_on_close` 只说"用户选了什么"（能不能藏由 `tray::decide_close` 判）。
    #[test]
    fn hides_on_close_only_reports_the_choice() {
        assert!(CloseBehavior::Tray.hides_on_close());
        assert!(!CloseBehavior::Quit.hides_on_close());
    }

    /// 兜底方向：**"用户还没选"给 core 的默认，"盘上的东西看不懂"给退出**。
    ///
    /// 两个常量分开是刻意的：混成一个就会出现两种错之一——
    /// 新装的用户被"退出"（与设置页显示的默认不一致），或认不出的盘被"藏窗口"（找不回应用）。
    #[test]
    fn the_two_fallbacks_are_different_things() {
        assert_eq!(
            CORE_DEFAULT_CLOSE_BEHAVIOR,
            CloseBehavior::Tray,
            "core 的默认是枚举第一项（`src/main/settings.mjs` 的 DEFAULT_CLOSE_BEHAVIOR = tray）：\
             界面在「没这一项」时显示的就是它"
        );
        assert_eq!(
            CONSERVATIVE_CLOSE_BEHAVIOR,
            CloseBehavior::Quit,
            "认不出的盘一律退出（猜 tray 而托盘装不上 = 关一次窗再也找不回应用）"
        );
        assert!(CORE_DEFAULT_CLOSE_BEHAVIOR.hides_on_close());
        assert!(!CONSERVATIVE_CLOSE_BEHAVIOR.hides_on_close());
    }

    /// schema 闸门：形状不认识一律 `quit`，绝不猜 `tray`（简报的退化方向）。
    #[test]
    fn parse_close_behavior_refuses_to_guess_on_bad_shapes() {
        let good_data = json!({ "closeBehavior": "tray" });
        assert_eq!(
            parse_close_behavior(None),
            CloseBehavior::Quit,
            "没有文本可读（读盘失败那一侧）也要保守"
        );

        let bad = vec![
            "".to_string(),
            "   ".to_string(),
            "不是 JSON".to_string(),
            "null".to_string(),
            "[]".to_string(),
            "\"settings\"".to_string(),
            "42".to_string(),
            // 缺 schemaVersion / 版本不对 / 版本类型不对
            json!({ "data": good_data }).to_string(),
            json!({ "schemaVersion": 2, "data": good_data }).to_string(),
            json!({ "schemaVersion": "1", "data": good_data }).to_string(),
            // data 不是对象 / 缺 closeBehavior / 类型不对 / 不在枚举里
            json!({ "schemaVersion": 1 }).to_string(),
            json!({ "schemaVersion": 1, "data": null }).to_string(),
            json!({ "schemaVersion": 1, "data": [] }).to_string(),
            json!({ "schemaVersion": 1, "data": {} }).to_string(),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": null } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": 42 } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": [] } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": "TRAY" } }).to_string(),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": "explode" } }).to_string(),
        ];
        for raw in bad {
            assert_eq!(
                parse_close_behavior(Some(&raw)),
                CloseBehavior::Quit,
                "坏形状必须回落 quit（猜 tray 会让用户关一次窗就再也找不回应用）：{raw}"
            );
        }
    }

    #[test]
    fn parse_close_behavior_reads_two_choices_and_migrates_the_legacy_value() {
        for (text, expected) in [("tray", CloseBehavior::Tray), ("minimize", CloseBehavior::Tray), ("quit", CloseBehavior::Quit)] {
            let raw = json!({ "schemaVersion": 1, "data": { "closeBehavior": text } }).to_string();
            assert_eq!(parse_close_behavior(Some(&raw)), expected, "{text} 必须照读");
        }
    }

    /// schemaVersion 用浮点比（JSON 的 `1` 与 `1.0` 都该认），与 `webview_proxy` 同一把闸门。
    #[test]
    fn parse_close_behavior_accepts_both_json_number_spellings() {
        // 与 webview_proxy 的常量同源：改一处就必须改另一处（Node 侧同名字面量）
        assert_eq!(SETTINGS_SCHEMA_VERSION, 1.0);
        assert_eq!(SETTINGS_FILE_NAME, "settings.json");
        for raw in [
            json!({ "schemaVersion": 1, "data": { "closeBehavior": "tray" } }).to_string(),
            json!({ "schemaVersion": 1.0, "data": { "closeBehavior": "tray" } }).to_string(),
        ] {
            assert_eq!(parse_close_behavior(Some(&raw)), CloseBehavior::Tray, "{raw}");
        }
    }

    /// 字段互不牵连：代理那一段坏掉不影响关窗行为的读取（两件事各判各的）。
    #[test]
    fn a_broken_proxy_section_does_not_poison_the_close_behavior() {
        let raw = json!({
            "schemaVersion": 1,
            "data": {
                "proxy": { "enabled": true, "host": "http://坏的主机", "port": 99999 },
                "closeBehavior": "tray"
            }
        })
        .to_string();
        assert_eq!(parse_close_behavior(Some(&raw)), CloseBehavior::Tray);
        assert_eq!(
            crate::webview_proxy::parse_settings(&raw),
            None,
            "代理那边照旧当没配（两条判定互不影响）"
        );
    }

    /// 读盘分三档：**文件不在** → core 的默认（用户还没选过）；文件在 → 严格照读；
    /// 读不了 / 认不出 → 保守的退出。
    #[test]
    fn read_close_behavior_handles_absent_readable_and_broken_files() {
        let dir = test_dir("read-close-behavior");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(
            read_close_behavior(&dir),
            CORE_DEFAULT_CLOSE_BEHAVIOR,
            "没有设置文件 = 用户还没选过 → 跟 core 的默认一致（设置页此刻显示的也是它）"
        );

        std::fs::write(dir.join(SETTINGS_FILE_NAME), "{ 半个 JSON").expect("坏文件要能写");
        assert_eq!(
            read_close_behavior(&dir),
            CloseBehavior::Quit,
            "文件在却认不出 = 有人动过这份盘 → 保守退出（写入路径产不出这种形状）"
        );

        write_behavior(&dir, "tray");
        assert_eq!(read_close_behavior(&dir), CloseBehavior::Tray, "合法文档照读");

        write_behavior(&dir, "quit");
        assert_eq!(read_close_behavior(&dir), CloseBehavior::Quit);

        // schema 不对同样是"看不懂"（不是"用户还没选"）
        std::fs::write(
            dir.join(SETTINGS_FILE_NAME),
            json!({ "schemaVersion": 2, "data": { "closeBehavior": "tray" } }).to_string(),
        )
        .expect("版本不对的文件要能写");
        assert_eq!(read_close_behavior(&dir), CloseBehavior::Quit, "版本不认识也要保守");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 启动恢复读的就是磁盘：先于建窗那一步不能是空转。
    #[test]
    fn restore_reads_the_disk() {
        let dir = test_dir("restore");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        assert_eq!(
            CloseBehaviorState::restore(&dir).current(),
            CORE_DEFAULT_CLOSE_BEHAVIOR,
            "没有设置文件时恢复出的是 core 的默认（与设置页同一句话）"
        );

        write_behavior(&dir, "tray");
        assert_eq!(CloseBehaviorState::restore(&dir).current(), CloseBehavior::Tray);

        write_behavior(&dir, "quit");
        assert_eq!(CloseBehaviorState::restore(&dir).current(), CloseBehavior::Quit);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **设置页改完立刻生效**：`refresh()` 现读磁盘，不靠重启（写盘的是设置页那一条路）。
    #[test]
    fn refresh_picks_up_a_rewritten_setting() {
        let dir = test_dir("refresh");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        let state = CloseBehaviorState::restore(&dir);
        assert_eq!(state.current(), CORE_DEFAULT_CLOSE_BEHAVIOR);

        // 模拟设置页写盘（core 的 settings:set 落的就是这个形状）
        write_behavior(&dir, "quit");
        assert_eq!(state.refresh(), CloseBehavior::Quit, "refresh 必须读到刚写下去的那一档");
        assert_eq!(state.current(), CloseBehavior::Quit, "refresh 之后当前值也更新了");

        write_behavior(&dir, "tray");
        assert_eq!(state.refresh(), CloseBehavior::Tray);

        // 文件被删掉（回到"还没选过"这一档）→ 跟随 core 的默认
        std::fs::remove_file(dir.join(SETTINGS_FILE_NAME)).expect("删得掉");
        assert_eq!(
            state.refresh(),
            CORE_DEFAULT_CLOSE_BEHAVIOR,
            "文件不在 = 用户还没选过（不是「看不懂」）"
        );
        assert_eq!(state.current(), CORE_DEFAULT_CLOSE_BEHAVIOR);

        // 文件在但认不出 → 保守
        std::fs::write(dir.join(SETTINGS_FILE_NAME), "坏 JSON").expect("坏文件要能写");
        assert_eq!(state.refresh(), CloseBehavior::Quit, "认不出的盘一律保守");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `current()` 不读盘：它只是把当前值说出来（分辨"现读"与"记住的那个值"）。
    #[test]
    fn current_does_not_re_read_the_disk() {
        let dir = test_dir("current");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("测试目录必须能建");

        let state = CloseBehaviorState::restore(&dir);
        write_behavior(&dir, "quit");
        assert_eq!(
            state.current(),
            CORE_DEFAULT_CLOSE_BEHAVIOR,
            "没 refresh 就不该看见新值"
        );
        assert_eq!(state.refresh(), CloseBehavior::Quit);

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_behavior(dir: &Path, behavior: &str) {
        std::fs::write(
            dir.join(SETTINGS_FILE_NAME),
            json!({ "schemaVersion": 1, "data": { "closeBehavior": behavior } }).to_string(),
        )
        .expect("设置文件要能写");
    }

    fn test_dir(label: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("close-behavior-test")
            .join(format!("{label}-{}", std::process::id()))
    }
}
