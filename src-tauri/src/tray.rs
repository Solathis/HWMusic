//! 托盘菜单、关窗 fail-safe 与可用性判断。
//!
//! 本模块不发事件信封：广播一律经 `commands::emit_core_event`，排队能力依赖已登记的 core 状态。
//! 安装失败绝不 panic：落一条 `app:notice` 提示后应用照常启动，降级为"关窗即退出"。
//! 菜单槽位写成 [`MENU_SLOTS`] 数据表以便单测逐项钉住；认不出的 id 只记日志、不猜也不 panic。
//! 跨平台：Windows 用多尺寸 ico，macOS 叠模板图标，Linux 需 libayatana-appindicator3。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::{APP_NOTICE, APP_OPEN_SETTINGS, LYRICS_TOGGLE, PLAYER_COMMAND};
use crate::close_behavior::CloseBehavior;
use crate::commands;

/// 菜单项 id 前缀（`tray:<动作>`），也是"该 id 归托盘管"的判据。
/// 与 `lib.rs` 的 `TRAY_ID`（托盘图标句柄名）无关。
pub const MENU_ID_PREFIX: &str = "tray:";

/// 显示窗口（`focus_main`：还原 + 显示 + 聚焦）。
pub const ID_SHOW: &str = "tray:show";
/// 播放·暂停（广播 `player:command` 的 `toggle`）。
pub const ID_PLAY_PAUSE: &str = "tray:play-pause";
/// 上一首。
pub const ID_PREVIOUS: &str = "tray:previous";
/// 下一首。
pub const ID_NEXT: &str = "tray:next";
/// 桌面歌词勾选项：勾选态由托盘镜像并广播，歌词窗本身不归本模块。
pub const ID_LYRICS: &str = "tray:lyrics";
/// 设置…（广播 `app:open-settings`，渲染层切到设置页）。
pub const ID_SETTINGS: &str = "tray:settings";
/// 退出程序（与关窗共用一次性后台收尾入口）。
pub const ID_QUIT: &str = "tray:quit";

/// 一个菜单槽位：要么是一个可点的项，要么是一条分隔线。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuSlot {
    Item {
        id: &'static str,
        label: &'static str,
    },
    Separator,
}

/// 菜单槽位表（**唯一真源**）：9 槽位 / 7 项 / 2 条分隔线。
///
/// 顺序是契约，由单测钉住；建菜单时按这张表翻译成 tauri 的菜单项。
pub const MENU_SLOTS: &[MenuSlot] = &[
    MenuSlot::Item {
        id: ID_SHOW,
        label: "显示窗口",
    },
    MenuSlot::Separator,
    MenuSlot::Item {
        id: ID_PLAY_PAUSE,
        label: "播放·暂停",
    },
    MenuSlot::Item {
        id: ID_PREVIOUS,
        label: "上一首",
    },
    MenuSlot::Item {
        id: ID_NEXT,
        label: "下一首",
    },
    MenuSlot::Item {
        id: ID_LYRICS,
        label: "桌面歌词",
    },
    MenuSlot::Item {
        id: ID_SETTINGS,
        label: "设置…",
    },
    MenuSlot::Separator,
    MenuSlot::Item {
        id: ID_QUIT,
        label: "退出程序",
    },
];

/// 托盘菜单项 → 动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// 显示主窗（`crate::focus_main`：unminimize + show + set_focus）
    FocusMain,
    /// 播放·暂停
    PlayPause,
    /// 上一首
    Previous,
    /// 下一首
    Next,
    /// 桌面歌词勾选（占位：翻转勾选态 + 广播 `lyrics:toggle`）
    ToggleLyrics,
    /// 设置…
    OpenSettings,
    /// 退出程序
    Quit,
}

/// id → 动作。**认不出的 id 一律 `None`**：菜单 id 空间是跨模块的（别的窗口/别的菜单的事件
/// 也会走到托盘的事件处理里），猜一个动作去执行，比"没反应"危险得多。
pub fn action_for(id: &str) -> Option<TrayAction> {
    match id {
        ID_SHOW => Some(TrayAction::FocusMain),
        ID_PLAY_PAUSE => Some(TrayAction::PlayPause),
        ID_PREVIOUS => Some(TrayAction::Previous),
        ID_NEXT => Some(TrayAction::Next),
        ID_LYRICS => Some(TrayAction::ToggleLyrics),
        ID_SETTINGS => Some(TrayAction::OpenSettings),
        ID_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

/// 播放三项 → `player:command` 广播的命令词。
/// 命令词必须是渲染层认得的那几个，否则会被结构化拒绝（点了没反应）。
pub fn player_command_for(action: TrayAction) -> Option<&'static str> {
    match action {
        TrayAction::PlayPause => Some("toggle"),
        TrayAction::Previous => Some("previous"),
        TrayAction::Next => Some("next"),
        _ => None,
    }
}

/// 桌面歌词勾选的镜像计划（纯函数）。
/// `checked` 是点完之后的目标态；由托盘自己翻转，免去等渲染层来回导致菜单闪烁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LyricsTogglePlan {
    /// 翻转之后的勾选态。
    pub checked: bool,
}

impl LyricsTogglePlan {
    pub fn payload(self) -> Value {
        json!({ "checked": self.checked })
    }
}

/// 给定菜单项当前的勾选态，算出点击之后的目标态（**镜像**：托盘自己翻转，不回问）。
pub fn plan_lyrics_toggle(checked: bool) -> LyricsTogglePlan {
    LyricsTogglePlan { checked: !checked }
}

/// 把勾选态改回歌词窗的实际状态，返回是否真的改到；句柄只在托盘手里，失败只记日志不 panic。
/// 只改勾选、不发广播——这是对已发生事实的修正，再广播会让两层互相重试。
pub fn revert_lyrics_checked<R: Runtime>(app: &AppHandle<R>, checked: bool) -> bool {
    let Some(state) = app.try_state::<Arc<TrayState<R>>>() else {
        log::warn!("桌面歌词勾选态翻回失败：托盘状态不在（托盘没装上或已消失）");
        return false;
    };
    match state.lyrics_item().set_checked(checked) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("桌面歌词勾选态没能翻回（{error}）");
            false
        }
    }
}

/// 关窗决议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    PreventAndHide,
    Quit,
}

/// tray 仅在托盘可用时隐藏，其余退出。
pub fn decide_close(behavior: CloseBehavior, tray_available: bool) -> CloseAction {
    match behavior {
        CloseBehavior::Tray if tray_available => CloseAction::PreventAndHide,
        CloseBehavior::Tray | CloseBehavior::Quit => CloseAction::Quit,
    }
}

/// 托盘装不上时必须如实说明关窗回退。
pub fn tray_notice(reason: &str) -> String {
    format!("托盘未能启用（{reason}）：选「最小化到托盘」时关窗会直接退出应用，托盘菜单也不可用。")
}

/// Windows 用多尺寸 ico（高 DPI 不糊），其余平台用 32×32 png。`include_bytes!` 嵌进二进制：
/// 托盘图标不能依赖外部文件（打包后路径不可预测）。
#[cfg(windows)]
pub const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
#[cfg(not(windows))]
pub const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/32x32.png");

/// 内嵌图标 → tauri `Image`。解码失败也只是一句可读原因（调用方降级，不 panic）。
pub fn icon() -> Result<Image<'static>, String> {
    Image::from_bytes(TRAY_ICON_BYTES).map_err(|error| format!("托盘图标无法解码：{error}"))
}

/// Windows 还须确认 Shell 注册，内部句柄存活不能保证用户能找到托盘。
pub fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(tray) = app.tray_by_id(crate::TRAY_ID) else { return false; };
    #[cfg(windows)]
    return check_registration(tray.rect().map_err(|error| error.to_string())).is_ok();
    #[cfg(not(windows))]
    { let _ = tray; true }
}

#[cfg(windows)]
fn check_registration(rect: Result<Option<tauri::Rect>, String>) -> Result<(), String> {
    match rect {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err("系统托盘未注册图标：检查 Shell 与应用运行权限/完整性级别".to_string()),
        Err(error) => Err(format!("系统托盘注册检查失败（{error}）")),
    }
}

/// 托盘的托管状态：握着托盘与勾选项句柄，避免 `TrayIcon` 引用计数提前归零。
/// "托盘在不在"不看它（见 [`available`]），它只保证句柄不提前释放。
pub struct TrayState<R: Runtime> {
    tray: TrayIcon<R>,
    lyrics_item: CheckMenuItem<R>,
}

impl<R: Runtime> TrayState<R> {
    /// 托盘句柄（排障用；判定可用性请用 [`available`]）。
    pub fn tray(&self) -> &TrayIcon<R> {
        &self.tray
    }

    /// "桌面歌词"勾选项的句柄（勾选镜像挂在它上面）。
    pub fn lyrics_item(&self) -> &CheckMenuItem<R> {
        &self.lyrics_item
    }
}

/// 安装结论。`Unavailable` 带原因：调用方据此打日志，用户侧文案见 [`tray_notice`]。
pub enum TrayInstall<R: Runtime> {
    Installed(Arc<TrayState<R>>),
    Unavailable { reason: String },
}

impl<R: Runtime> std::fmt::Debug for TrayInstall<R> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrayInstall::Installed(_) => formatter.write_str("TrayInstall::Installed"),
            TrayInstall::Unavailable { reason } => formatter
                .debug_struct("TrayInstall::Unavailable")
                .field("reason", reason)
                .finish(),
        }
    }
}

impl<R: Runtime> TrayInstall<R> {
    pub fn is_installed(&self) -> bool {
        matches!(self, TrayInstall::Installed(_))
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            TrayInstall::Installed(_) => None,
            TrayInstall::Unavailable { reason } => Some(reason),
        }
    }
}

/// 安装托盘，必须在主线程调用；成功则登记托管状态，失败返回降级结论且不 panic。
/// 前置条件：调用前已 `manage` core 状态，否则 `emit_core_event` 退回直接 emit 会丢掉提示。
pub fn install<R: Runtime>(app: &AppHandle<R>) -> TrayInstall<R> {
    match build(app) {
        Ok(state) => {
            let state = Arc::new(state);
            app.manage(Arc::clone(&state));
            TrayInstall::Installed(state)
        }
        Err(reason) => {
            // 这条提示的可见性取决于调用方**先登记好 core 状态**（排队能力在它手里）：
            // 见 [`install`] 的前置条件。这里只负责投递。
            commands::emit_core_event(app, APP_NOTICE, json!({ "text": tray_notice(&reason) }));
            TrayInstall::Unavailable { reason }
        }
    }
}

/// 建菜单 + 建托盘。所有失败都收敛成一句可读原因（调用方只做"报告 + 降级"）。
fn build<R: Runtime>(app: &AppHandle<R>) -> Result<TrayState<R>, String> {
    let (menu, lyrics_item) = build_menu(app)?;
    let icon = icon()?;
    let title = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| crate::TRAY_ID.to_string());

    let builder = tauri::tray::TrayIconBuilder::with_id(crate::TRAY_ID)
        .icon(icon)
        .tooltip(title)
        .menu(&menu)
        // 左键点图标出菜单（Windows 的习惯）；"显示窗口"是菜单第一项，不另做左键唤起
        .show_menu_on_left_click(true);
    let builder = platform_icon_style(builder);

    let lyrics_handler = lyrics_item.clone();
    builder
        .on_menu_event(move |app, event| dispatch(app, &lyrics_handler, event.id().as_ref()))
        .build(app)
        .map_err(|error| format!("托盘创建失败：{error}"))
        .and_then(|tray| {
            #[cfg(windows)]
            {
                let registration = tray.set_icon(Some(self::icon()?))
                    .map_err(|error| format!("系统托盘图标更新失败（{error}）；检查应用运行权限/完整性级别"))
                    .and_then(|_| check_registration(tray.rect().map_err(|error| error.to_string())));
                if let Err(error) = registration {
                    app.remove_tray_by_id(crate::TRAY_ID);
                    return Err(error);
                }
            }
            Ok(TrayState { tray, lyrics_item })
        })
}

/// 平台图标口径：macOS 用模板图标（跟着系统亮暗自动反色），其余平台原样。
fn platform_icon_style<R: Runtime>(
    builder: tauri::tray::TrayIconBuilder<R>,
) -> tauri::tray::TrayIconBuilder<R> {
    #[cfg(target_os = "macos")]
    {
        builder.icon_as_template(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

/// 按 [`MENU_SLOTS`] 建菜单：槽位表是唯一真源，这里只做"翻译"，不另抄一份条目清单。
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(Menu<R>, CheckMenuItem<R>), String> {
    let mut items: Vec<MenuItem<R>> = Vec::new();
    let mut separators: Vec<PredefinedMenuItem<R>> = Vec::new();
    let mut lyrics: Option<CheckMenuItem<R>> = None;

    for slot in MENU_SLOTS {
        match slot {
            MenuSlot::Item { id, label } => {
                if *id == ID_LYRICS {
                    // 勾选项初始未勾选：真实勾选态取决于歌词窗是否存在，这里不建假同步。
                    lyrics = Some(
                        CheckMenuItem::with_id(app, *id, *label, true, false, None::<&str>)
                            .map_err(|error| format!("菜单项 {id} 创建失败：{error}"))?,
                    );
                } else {
                    items.push(
                        MenuItem::with_id(app, *id, *label, true, None::<&str>)
                            .map_err(|error| format!("菜单项 {id} 创建失败：{error}"))?,
                    );
                }
            }
            MenuSlot::Separator => separators.push(
                PredefinedMenuItem::separator(app)
                    .map_err(|error| format!("分隔线创建失败：{error}"))?,
            ),
        }
    }

    let Some(lyrics) = lyrics else {
        return Err("菜单槽位表里没有桌面歌词勾选项".to_string());
    };

    // 按槽位顺序拼引用（前面按类型攒，这里按顺序取，顺序仍由槽位表决定）
    let mut ordered: Vec<&dyn IsMenuItem<R>> = Vec::new();
    let mut item_iter = items.iter();
    let mut separator_iter = separators.iter();
    for slot in MENU_SLOTS {
        match slot {
            MenuSlot::Item { id, .. } if *id == ID_LYRICS => ordered.push(&lyrics),
            MenuSlot::Item { .. } => ordered.push(
                item_iter
                    .next()
                    .ok_or_else(|| "菜单项数量与槽位表对不上".to_string())?,
            ),
            MenuSlot::Separator => ordered.push(
                separator_iter
                    .next()
                    .ok_or_else(|| "分隔线数量与槽位表对不上".to_string())?,
            ),
        }
    }

    let menu = Menu::with_items(app, &ordered).map_err(|error| format!("托盘菜单创建失败：{error}"))?;
    Ok((menu, lyrics))
}

/// 菜单事件 → 动作 → 落地；认不出的 id 只记日志。
/// 勾选镜像在 `lyrics_item` 上翻转，并向渲染层广播目标态。
fn dispatch<R: Runtime>(app: &AppHandle<R>, lyrics_item: &CheckMenuItem<R>, id: &str) {
    let Some(action) = action_for(id) else {
        log::warn!("托盘菜单事件来自不认识的 id：{id}（已忽略）");
        return;
    };

    match action {
        TrayAction::FocusMain => crate::focus_main(app),
        TrayAction::ToggleLyrics => {
            let plan = plan_lyrics_toggle(lyrics_item.is_checked().unwrap_or(false));
            if let Err(error) = lyrics_item.set_checked(plan.checked) {
                log::warn!("桌面歌词勾选态没能翻转：{error}");
            }
            commands::emit_core_event(app, LYRICS_TOGGLE, plan.payload());
        }
        TrayAction::OpenSettings => {
            commands::emit_core_event(app, APP_OPEN_SETTINGS, json!({ "view": "settings" }));
        }
        TrayAction::PlayPause | TrayAction::Previous | TrayAction::Next => {
            if let Some(command) = player_command_for(action) {
                commands::emit_core_event(app, PLAYER_COMMAND, json!({ "command": command }));
            }
        }
        TrayAction::Quit => {
            log::info!("托盘菜单：退出程序");
            if let Err(error) = crate::request_app_exit(app) {
                log::warn!("退出请求失败（{error}）：保留应用并恢复主窗");
                crate::focus_main(app);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 槽位契约：9 槽位 / 7 项 / 2 条分隔线。
    #[test]
    fn menu_slots_are_nine_with_seven_items_and_two_separators() {
        let items: Vec<&MenuSlot> = MENU_SLOTS
            .iter()
            .filter(|slot| matches!(slot, MenuSlot::Item { .. }))
            .collect();
        let separators = MENU_SLOTS.len() - items.len();
        assert_eq!(MENU_SLOTS.len(), 9, "槽位表必须是 9 槽位：{MENU_SLOTS:?}");
        assert_eq!(items.len(), 7, "7 个可点的项：{MENU_SLOTS:?}");
        assert_eq!(separators, 2, "2 条分隔线：{MENU_SLOTS:?}");
    }

    /// 顺序与文案都是契约：显示窗口 / — / 播放·暂停 / 上一首 / 下一首 /
    /// 桌面歌词 / 设置… / — / 退出程序。
    #[test]
    fn menu_slots_keep_the_agreed_order_and_copy() {
        let labels: Vec<&str> = MENU_SLOTS
            .iter()
            .map(|slot| match slot {
                MenuSlot::Item { label, .. } => *label,
                MenuSlot::Separator => "—",
            })
            .collect();
        assert_eq!(
            labels,
            vec![
                "显示窗口",
                "—",
                "播放·暂停",
                "上一首",
                "下一首",
                "桌面歌词",
                "设置…",
                "—",
                "退出程序"
            ],
            "槽位顺序与文案是简报契约"
        );
    }

    /// 两条分隔线的位置：第 2 槽（把"显示窗口"隔开）与倒数第 2 槽（把"退出程序"隔开）。
    /// 位置错了菜单会变成"一串挤在一起的项"，而那是肉眼最不容易发现的那类错。
    #[test]
    fn separators_sit_where_the_menu_reads_right() {
        let separators: Vec<usize> = MENU_SLOTS
            .iter()
            .enumerate()
            .filter(|(_, slot)| matches!(slot, MenuSlot::Separator))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(separators, vec![1, MENU_SLOTS.len() - 2], "分隔线位置");
    }

    /// id 前缀隔离 + 唯一性：每个 id 都带 `tray:`，且没有两个槽位共用一个 id
    /// （共用 id 的后果是"点 A 执行 B"，而单测只会看到"有个动作没被覆盖"）。
    #[test]
    fn every_menu_id_carries_the_tray_prefix_and_is_unique() {
        let ids: Vec<&str> = MENU_SLOTS
            .iter()
            .filter_map(|slot| match slot {
                MenuSlot::Item { id, .. } => Some(*id),
                MenuSlot::Separator => None,
            })
            .collect();
        assert_eq!(ids.len(), 7);
        for id in &ids {
            assert!(
                id.starts_with(MENU_ID_PREFIX),
                "{id} 必须带前缀 {MENU_ID_PREFIX}（前缀是'这个 id 归托盘管'的判据）"
            );
            assert!(
                id.len() > MENU_ID_PREFIX.len(),
                "{id} 只有前缀没有动作名（空动作名会让 action_for 认不出）"
            );
        }
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "菜单 id 必须互不相同：{ids:?}");

        // 托盘**图标** id（lib.rs 的 `TRAY_ID`）与菜单 id 前缀是两件事：
        // 图标 id 只是一个句柄名、不带冒号，也不该被当成某个菜单动作。
        assert_eq!(crate::TRAY_ID, "tray", "托盘图标 id 由 lib.rs 定义");
        assert!(MENU_ID_PREFIX.ends_with(':'), "前缀以冒号收口：{MENU_ID_PREFIX}");
        assert_eq!(action_for(crate::TRAY_ID), None, "图标 id 不是菜单动作");
    }

    /// 每个槽位都能被认出来：**没有"点了没反应"的死项**（加了槽位忘了加动作，这条先红）。
    #[test]
    fn every_item_slot_has_an_action() {
        for slot in MENU_SLOTS {
            let MenuSlot::Item { id, label } = slot else {
                continue;
            };
            assert!(
                action_for(id).is_some(),
                "槽位 {label}（{id}）没有对应动作：加了菜单项却没接动作 = 用户点了没反应"
            );
        }
        assert_eq!(action_for(ID_SHOW), Some(TrayAction::FocusMain));
        assert_eq!(action_for(ID_PLAY_PAUSE), Some(TrayAction::PlayPause));
        assert_eq!(action_for(ID_PREVIOUS), Some(TrayAction::Previous));
        assert_eq!(action_for(ID_NEXT), Some(TrayAction::Next));
        assert_eq!(action_for(ID_LYRICS), Some(TrayAction::ToggleLyrics));
        assert_eq!(action_for(ID_SETTINGS), Some(TrayAction::OpenSettings));
        assert_eq!(action_for(ID_QUIT), Some(TrayAction::Quit));
    }

    /// 认不出的 id **不猜**（返回 `None` 让调用方只记日志）：跨模块 id、别的窗口的菜单事件、
    /// 手滑写错的大小写/空白，一个都不许落到某个动作上。
    #[test]
    fn unknown_menu_ids_are_never_guessed() {
        for id in [
            "",
            "tray:",
            "tray:unknown",
            "tray:show ",       // 尾随空白
            "Tray:show",        // 大小写
            "show",             // 少了前缀
            "settings:get",     // 请求频道
            "player:command",   // 广播频道
            "auth:status",
            "app:open-settings",
            "tray:quit:extra",
        ] {
            assert_eq!(action_for(id), None, "{id:?} 不是托盘菜单 id，必须不猜");
        }
    }

    /// 播放三项的命令词必须是渲染层认得的那几个（认不出的只会被结构化拒绝 = 点了没反应）。
    #[test]
    fn player_commands_are_the_ones_the_renderer_knows() {
        assert_eq!(player_command_for(TrayAction::PlayPause), Some("toggle"));
        assert_eq!(player_command_for(TrayAction::Previous), Some("previous"));
        assert_eq!(player_command_for(TrayAction::Next), Some("next"));
        // 其余动作不发播放命令（尤其是退出与设置：误发一条播放命令 = 用户点退出结果音乐停了）
        for action in [
            TrayAction::FocusMain,
            TrayAction::ToggleLyrics,
            TrayAction::OpenSettings,
            TrayAction::Quit,
        ] {
            assert_eq!(player_command_for(action), None, "{action:?} 不该发播放命令");
        }
        // 词表与外层的契约：载荷形状必须与 `player:command` 的约定一致。
        let command = player_command_for(TrayAction::PlayPause).expect("toggle");
        assert_eq!(json!({ "command": command }), json!({ "command": "toggle" }));
    }

    /// 勾选镜像：点击翻转，广播的是**目标态**。
    #[test]
    fn lyrics_toggle_mirrors_the_checkbox_state() {
        assert_eq!(plan_lyrics_toggle(false).checked, true, "没勾 → 勾上");
        assert_eq!(plan_lyrics_toggle(true).checked, false, "勾着 → 取消");
        assert_eq!(plan_lyrics_toggle(false).payload(), json!({ "checked": true }));
        assert_eq!(plan_lyrics_toggle(true).payload(), json!({ "checked": false }));
    }

    #[test]
    fn legacy_minimize_uses_the_tray_fail_safe() {
        let behavior = CloseBehavior::from_setting(Some("minimize")).expect("精确旧值必须迁移");
        assert_eq!(decide_close(behavior, true), CloseAction::PreventAndHide);
        assert_eq!(decide_close(behavior, false), CloseAction::Quit);
    }

    #[test]
    fn decide_close_is_fail_safe_on_all_four_branches() {
        for (behavior, available, expected) in [
            (CloseBehavior::Tray, true, CloseAction::PreventAndHide),
            (CloseBehavior::Tray, false, CloseAction::Quit),
            (CloseBehavior::Quit, true, CloseAction::Quit),
            (CloseBehavior::Quit, false, CloseAction::Quit),
        ] {
            assert_eq!(decide_close(behavior, available), expected, "{behavior:?}, tray={available}");
        }
    }

    /// 托盘装不上时的提示文案：说清原因、说清关窗会真退出、不画饼。
    #[test]
    fn tray_notice_says_what_happened_and_what_it_costs() {
        let text = tray_notice("appindicator 未安装");
        assert!(text.contains("appindicator 未安装"), "要带上原因：{text}");
        assert!(text.contains("托盘"), "要说是托盘这件事：{text}");
        assert!(
            text.contains("退出"),
            "必须说清关窗会直接退出（防'以为还能藏起来'）：{text}"
        );
        assert!(!text.trim().is_empty());
        assert!(!text.contains("敬请期待") && !text.contains("即将上线"), "禁画饼：{text}");
        assert!(!text.contains("R11"), "文案是给用户的，不写任务号：{text}");
    }

    /// 内嵌图标真的嵌进来了，且是当前平台该用的格式（Windows ico / 其余 png）。
    #[test]
    fn the_embedded_icon_is_the_platform_format() {
        assert!(TRAY_ICON_BYTES.len() > 1024, "图标不会只有几字节：{}", TRAY_ICON_BYTES.len());
        #[cfg(windows)]
        assert_eq!(
            &TRAY_ICON_BYTES[..4],
            &[0, 0, 1, 0],
            "Windows 用多尺寸 ico（含 DPI 变体）"
        );
        #[cfg(not(windows))]
        assert_eq!(
            &TRAY_ICON_BYTES[..8],
            b"\x89PNG\r\n\x1a\n",
            "非 Windows 用 png（macOS 再叠 icon_as_template）"
        );
    }

    /// 图标能真的解码（`include_bytes!` 指错文件、或 ico 坏掉，都在这里先红，
    /// 而不是等到用户机器上"托盘图标是空白"）。
    #[test]
    fn the_embedded_icon_decodes() {
        let image = icon().expect("内嵌图标必须能解码（image-ico / image-png 特性已开）");
        assert!(image.width() > 0 && image.height() > 0, "解码出来的图不能是 0 尺寸");
    }

    #[cfg(windows)]
    #[test]
    fn registration_requires_a_real_shell_rect_and_preserves_os_errors() {
        assert!(check_registration(Ok(Some(tauri::Rect::default()))).is_ok());
        let missing = check_registration(Ok(None)).expect_err("内部对象不可冒充系统注册成功");
        assert!(missing.contains("系统托盘未注册"));
        let denied = check_registration(Err("拒绝访问 (os error 5)".to_string())).expect_err("系统失败不可假成功");
        assert!(denied.contains("os error 5"));
        assert_eq!(decide_close(CloseBehavior::Tray, false), CloseAction::Quit);
    }

    #[cfg(windows)]
    #[test]
    fn embedded_image_converts_to_a_native_windows_icon() {
        #[link(name = "user32")]
        extern "system" {
            fn CreateIcon(instance: *mut std::ffi::c_void, width: i32, height: i32, planes: u8, bits: u8, mask: *const u8, color: *const u8) -> *mut std::ffi::c_void;
            fn DestroyIcon(icon: *mut std::ffi::c_void) -> i32;
        }
        let image = icon().expect("图标解码");
        let mut bgra = image.rgba().to_vec();
        let mut mask = Vec::with_capacity(bgra.len() / 4);
        for pixel in bgra.chunks_exact_mut(4) {
            mask.push(pixel[3].wrapping_sub(u8::MAX));
            pixel.swap(0, 2);
        }
        let handle = unsafe { CreateIcon(std::ptr::null_mut(), image.width() as i32, image.height() as i32, 1, 32, mask.as_ptr(), bgra.as_ptr()) };
        assert!(!handle.is_null(), "原生图标转换失败：{}×{}，{}", image.width(), image.height(), std::io::Error::last_os_error());
        unsafe { DestroyIcon(handle); }
    }

    /// 源码扫描一：本模块**不自己发事件信封**——广播只能经 `commands::emit_core_event`
    /// （信封形状与启动期排队都在那一个函数里）。
    #[test]
    fn the_module_never_emits_envelopes_itself() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray.rs"))
            .expect("要能读到自己的源码");
        let production = production_source(&source);

        assert!(
            !production.contains("app.emit(") && !production.contains(".emit("),
            "托盘模块不许自己 emit：事件信封的唯一构造点是 commands::emit_core_event"
        );
        assert!(
            production.contains("commands::emit_core_event("),
            "托盘的三条广播（player:command / lyrics:toggle / app:open-settings）都该走 emit_core_event"
        );
        for channel in [PLAYER_COMMAND, LYRICS_TOGGLE, APP_OPEN_SETTINGS, APP_NOTICE] {
            assert!(
                production.contains(channel),
                "{channel} 要在托盘模块里真的发出去（常量来自 bridge.rs）"
            );
        }
    }

    /// 源码扫描二：装不上 ≠ 崩掉。生产代码里不许出现 panic 家族。
    #[test]
    fn the_module_never_panics_on_the_install_path() {
        let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/tray.rs"))
            .expect("要能读到自己的源码");
        let production = production_source(&source);
        for forbidden in [".unwrap()", ".expect(", "panic!(", "unreachable!(", "todo!("] {
            assert!(
                !production.contains(forbidden),
                "托盘模块的生产代码不许出现 {forbidden}（装不上时要降级，不是崩掉）"
            );
        }
    }

    /// 只看生产代码：`#[cfg(test)]` 段里的字面量是测试夹具，不算模块行为。
    fn production_source(source: &str) -> &str {
        let cut = source.find("#[cfg(test)]").unwrap_or(source.len());
        &source[..cut]
    }
}
