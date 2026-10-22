//! 托盘与关窗 fail-safe（R11）。
//!
//! 三件事：
//!
//! 1. **菜单**：9 槽位 / 7 项 / 2 条分隔线（显示窗口 / — / 播放·暂停 / 上一首 / 下一首 /
//!    桌面歌词（勾选）/ 设置… / — / 退出程序），菜单项 id 前缀 `tray:`。
//!    槽位写成**数据表**（[`MENU_SLOTS`]）而不是一长串构造调用：表能被单测逐项钉住，
//!    构造调用只能靠人眼看。认不出的 id **不猜、不 panic**（只记一行日志）。
//! 2. **关窗 fail-safe**：[`decide_close`] —— 只有"设置里选了托盘"**且**"托盘真的装上"才
//!    `prevent_close + hide`；minimize 独立于托盘并保留任务栏入口，其余退出应用。旧仓缺陷：托盘没装上却把窗口藏了，
//!    用户看到"窗口没了、托盘里也没有"，只能去任务管理器找进程。
//! 3. **可用性**：[`available`] 现问 tauri 的托盘表（`tray_by_id`），**不维护第二份内存镜像**
//!    （镜像与事实之间只会有漂移：装失败之后两边的说法就对不上了）。
//!
//! 两条纪律：
//!
//! - **本模块不发事件信封**：广播只能经 `commands::emit_core_event`（信封形状与"渲染层没就绪
//!   就先排队"两条规矩都在那一个函数里），自己直接 emit 等于绕开启动期队列——启动期发出去的
//!   提示会直接发进空气（旧仓缺陷）。
//!   排队能力本身住在 `Arc<CoreState>` 里，所以**调用方必须先把 core 状态登记好**
//!   （`lib.rs` 的 `setup` 里 `app.manage(Arc::new(commands::CoreState::default()))` 排在
//!   [`install`] 之前，并有顺序断言钉住）：登记晚于安装时，`emit_core_event` 取不到状态会退回
//!   "直接 emit"，提示照样发进空气——**经唯一入口 ≠ 一定排得上队**。
//! - **安装失败绝不 panic**：落一条启动提示（`app:notice`）+ 一句日志，应用照常起来。
//!   一个装不上的托盘不该把应用带走（代价应当是"关窗即退出"，而不是"起不来"）。
//!
//! 跨平台口径（简报）：Windows 用多尺寸 `icons/icon.ico`（高 DPI 不糊），其余平台用
//! `icons/32x32.png`，macOS 再叠 `icon_as_template(true)`（图标跟着系统亮暗反色）。
//! Linux 需要 `libayatana-appindicator3` 且 `TrayIconEvent` 不派发（只有菜单可用）——
//! 真机验证属 R15 的 PLATFORM_DIFFERENCES，本任务如实记 untested。

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::{APP_NOTICE, APP_OPEN_SETTINGS, LYRICS_TOGGLE, PLAYER_COMMAND};
use crate::close_behavior::CloseBehavior;
use crate::commands;

/// 菜单项 id 前缀（`tray:<动作>`）。
///
/// 与 `lib.rs` 的 `TRAY_ID`（托盘**图标** id，`"tray"`）是两件事：图标 id 只是一个句柄名，
/// 菜单 id 是跨模块契约——这条前缀同时也是"这个 id 归托盘管"的判据（见 [`action_for`]）。
pub const MENU_ID_PREFIX: &str = "tray:";

/// 显示窗口（`focus_main`：还原 + 显示 + 聚焦）。
pub const ID_SHOW: &str = "tray:show";
/// 播放·暂停（广播 `player:command` 的 `toggle`）。
pub const ID_PLAY_PAUSE: &str = "tray:play-pause";
/// 上一首。
pub const ID_PREVIOUS: &str = "tray:previous";
/// 下一首。
pub const ID_NEXT: &str = "tray:next";
/// 桌面歌词（CheckMenuItem：勾选态由托盘镜像并广播，歌词窗本体是 R12）。
pub const ID_LYRICS: &str = "tray:lyrics";
/// 设置…（广播 `app:open-settings`，渲染层切到设置页）。
pub const ID_SETTINGS: &str = "tray:settings";
/// 退出程序（`app.exit(0)`，走 RunEvent 收尸）。
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
/// 顺序是契约（简报逐项列出），由单测钉住；建菜单时按这张表翻译成 tauri 的菜单项。
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
///
/// 词表是 R9 定下的（`src/renderer/features/playback/player-commands.mjs` 是执行侧的唯一真源）：
/// 托盘发出去的命令词**必须是渲染层认得的那几个**，认不出的只会被结构化拒绝（点了没反应）。
pub fn player_command_for(action: TrayAction) -> Option<&'static str> {
    match action {
        TrayAction::PlayPause => Some("toggle"),
        TrayAction::Previous => Some("previous"),
        TrayAction::Next => Some("next"),
        _ => None,
    }
}

/// 桌面歌词勾选的镜像计划（纯函数）。
///
/// **目标态广播**：`{checked}` 是"点完这一下之后应当是什么"，不是"现在是什么"——
/// 消费方（R12 的歌词窗）按目标态开关，不必知道托盘点之前的状态。
///
/// 勾选态由托盘自己翻转（不去问渲染层"现在是什么"：那要等一个来回，菜单会闪一下）。
/// 勾选态与歌词窗**存在性**的同步是 R12 的事，本任务只保证这条广播发得出去、发得对。
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

/// 把"桌面歌词"勾选态**改回窗的实际状态**（R12：歌词窗命令失败时的收口）。
///
/// 勾选态是托盘自己镜像并翻转的（R11），所以"翻回"也只能由托盘做——歌词窗/R12 手上
/// 没有 `CheckMenuItem` 句柄。返回是否真的改到了：托盘不在（没装上、句柄早没了）时
/// 只记一行日志，**绝不 panic**（与安装路径同一条纪律）。
///
/// 只改勾选、不发广播：这是对**已发生的事实**的修正，不是一条新的目标态。再发一条广播
/// 会让渲染层再跑一遍开关命令，而那次命令大概率还是失败——两个循环互相点火。
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
    PreventAndMinimize,
    Quit,
}

/// tray 仅在托盘可用时隐藏；minimize 保留任务栏入口，不依赖托盘。
pub fn decide_close(behavior: CloseBehavior, tray_available: bool) -> CloseAction {
    match behavior {
        CloseBehavior::Tray if tray_available => CloseAction::PreventAndHide,
        CloseBehavior::Minimize => CloseAction::PreventAndMinimize,
        CloseBehavior::Tray | CloseBehavior::Quit => CloseAction::Quit,
    }
}

/// 托盘装不上时的启动提示文案（**唯一出口**：文案在这里造，`install` 只负责投递）。
///
/// 仅 tray 档回退退出，minimize 仍然保留任务栏入口。
pub fn tray_notice(reason: &str) -> String {
    format!("托盘未能启用（{reason}）：选「最小化到托盘」时关窗会直接退出应用，托盘菜单也不可用；「最小化到任务栏」不受影响。")
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

/// 托盘真的装上了吗：**现问 tauri 的托盘表**（`tray_by_id`），不维护第二份内存镜像。
///
/// 关窗回调与 `core_get_tray_available` 都走这一个事实来源：装失败之后，
/// "界面上说的"和"关窗时实际做的"必然是同一句话。
pub fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.tray_by_id(crate::TRAY_ID).is_some()
}

/// 托盘的托管状态：握着托盘与"桌面歌词"勾选项的句柄。
///
/// 归属：登记成托管状态（`app.manage`）而不是 setup 里的局部变量——`TrayIcon` 是引用计数的，
/// 句柄一放下、再加上 tauri 资源表里那一份被移除（`AppHandle::remove_tray_by_id`）之后，
/// 托盘才会真的从系统托盘区消失；进程退出时由 tauri 统一清理。
/// 所以"托盘在不在"**不靠这个结构体判断**（见 [`available`]），它只负责"别让句柄提前没了"。
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

/// 安装托盘（**必须在主线程调用**：tauri 的菜单与托盘构造都要在主线程上跑）。
///
/// 成功 → 句柄登记成托管状态；失败 → 一条启动提示（`app:notice`）+ 结构化结论，**不 panic**。
/// 日志由调用方（`lib.rs` 的 setup）打：这里只管"装上/降级"两件事。
///
/// **前置条件（R11 修复轮 1/5 补正）**：调用前必须已经 `app.manage(Arc::new(CoreState::default()))`。
/// 提示的排队能力住在 core 状态里——`emit_core_event` 取不到它时会退回直接 `app.emit`
/// （`commands.rs` 的 `None => emit_now`），而 setup 时刻的 webview 还没跑 `listen()`，
/// 事件被丢，用户只会看到"窗口关了就退出"却不知道托盘没装上。*原先这里的注释只写"渲染层
/// 没就绪会先排队"，把"队列已经存在"当成默认事实——那是错的，实际顺序曾反着来。*
/// `lib.rs` 的 setup 现已把登记排在本函数之前，由
/// `tray_is_installed_after_the_window_and_never_blocks_startup` 的顺序断言钉住。
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
        .map(|tray| TrayState { tray, lyrics_item })
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
                    // 勾选项：初始未勾选（真实状态由 R12 的歌词窗存在性决定，本任务不建假同步）
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

/// 菜单事件 → 动作 → 落地。
///
/// 认不出的 id 只记日志（见 [`action_for`]）。`lyrics_item` 就是菜单里那个勾选项的句柄：
/// 勾选镜像在它身上翻转，广播**目标态**给渲染层/R12。
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
            // 走 `app.exit` → RunEvent（ExitRequested/Exit）收尸：lib.rs 在那里关 sidecar 的 stdin。
            // `std::process::exit` 会跳过收尸，sidecar 变成孤儿进程。
            log::info!("托盘菜单：退出程序");
            app.exit(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 简报的槽位契约：9 槽位 / 7 项 / 2 条分隔线。
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

    /// 顺序与文案都是契约（简报逐项列出）：显示窗口 / — / 播放·暂停 / 上一首 / 下一首 /
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
        // 词表与外层的契约（R9 的 player:command 载荷形状）
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
    fn minimize_is_independent_of_tray_availability() {
        let behavior = CloseBehavior::from_setting(Some("minimize"))
            .expect("必须能解析最小化到任务栏（不能回落 quit）");
        assert!(!behavior.hides_on_close(), "minimize 不是托盘 hide");
        for available in [false, true] {
            assert_eq!(decide_close(behavior, available), CloseAction::PreventAndMinimize);
        }
    }

    #[test]
    fn decide_close_is_fail_safe_on_all_six_branches() {
        for (behavior, available, expected) in [
            (CloseBehavior::Tray, true, CloseAction::PreventAndHide),
            (CloseBehavior::Tray, false, CloseAction::Quit),
            (CloseBehavior::Minimize, true, CloseAction::PreventAndMinimize),
            (CloseBehavior::Minimize, false, CloseAction::PreventAndMinimize),
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
