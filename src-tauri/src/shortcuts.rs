//! 全局快捷键的注册编排（R13）。
//!
//! 三件事，件件都做成"没有 app 也能钉住"的形状：
//!
//! 1. **组合清单是数据表**（[`SHORTCUT_BINDINGS`]）：媒体三键（`MediaPlayPause` /
//!    `MediaTrackPrevious` / `MediaTrackNext`）与两条提示型组合（`CmdOrCtrl+Alt+L` 桌面歌词、
//!    `CmdOrCtrl+Alt+S` 设置）。表能被单测逐条钉住（含"每个组合都得解析得出来"），
//!    写成散落在 setup 里的一串调用就只能靠人眼。
//! 2. **注册计划是纯函数**（[`plan_binding`]）：主组合被别的程序占用时沿备选链往下试，
//!    试过哪些、为什么失败、最后生效的是哪条，全部落在 [`ShortcutPlan`] 里。
//!    注册动作本身由调用方注入（`register` 闭包）——所以"占用/全废/回退"这些分支
//!    不需要真机就能覆盖。
//! 3. **结论如实上报**：生效的组合记进 [`ShortcutState`]（设置页后续可读），
//!    回退与失败逐条经启动提示说清楚"现在用的是哪个键"（[`shortcut_notices`]）。
//!
//! 三条纪律：
//!
//! - **组合只能在这里逐条注册**，不许用插件的 `Builder::with_shortcut(..)`：
//!   `tauri-plugin-global-shortcut` 在它自己的 setup 里注册，失败会让整个 `setup` 返回 Err，
//!   而 tauri 收到 Err 会在启动期直接崩（`Failed to setup app`）——**一个被占用的媒体键不该把
//!   应用带走**（Windows 上媒体键注册失败是常态）。
//! - **不静默换键**：回退一定会经启动提示说出来（原来想用哪个、现在实际是哪个）。
//!   媒体三键**没有备选链**——给媒体键配一条 `Ctrl+...` 备选，等于用户按了媒体键没反应、
//!   却多出一个他从不认识的组合在起作用。
//! - **广播只经 `commands::emit_core_event`**（事件信封的唯一构造点，启动期排队也在那里）。
//!   本模块不自己 `emit`。
//!
//! ## 平台差异：Wayland（如实记录，未实测）
//!
//! `tauri-plugin-global-shortcut` 的 Linux 后端是 `global-hotkey`，而它只有 **X11** 实现
//! （`x11rb` + `xkeysym`，见 `global-hotkey-0.8.0/src/platform_impl/x11/`）：Wayland 原生会话
//! 下没有 X 连接，注册会失败（没有隐藏的降级路径可走）。本模块的处理是**如实降级**——
//! `GlobalHotKeyManager::new()` 在 X11 后端里只是起一个线程、当场返回 Ok，真正的连接错误落在
//! 每条 `register` 上，于是每个动作各自走"注册失败"这条路：一条启动提示说清哪个键没能注册，
//! 并指路托盘菜单/主界面。**Wayland 上快捷键可用性未在真机验证**（本任务范围外，如实记
//! `untested`）；文案不承诺 Wayland，也不假装有替代方案。
//!
//! 计划里"Wayland 热键限制写入 PLATFORM_DIFFERENCES"的落点：`docs/PLATFORM_DIFFERENCES.md`
//! 是 R15 的交付物（本任务时尚未创建），所以这条事实先钉在本模块的注释与一条源码扫描用例里
//! （[`tests::the_wayland_limitation_is_written_down_where_the_code_is`]），R15 直接取用。

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutEvent, ShortcutState as HotKeyState};

use crate::bridge::{APP_OPEN_SETTINGS, LYRICS_TOGGLE, PLAYER_COMMAND};
use crate::commands::emit_core_event;

// ---------------------------------------------------------------------------
// 组合清单（数据表 = 唯一真源）
// ---------------------------------------------------------------------------

/// 快捷键能做的事。五个动作与托盘菜单的前五项一一对应（动作名与文案都跟托盘对齐：
/// 用户看到的应该是同一件事，不该在托盘里叫"播放·暂停"、在提示里叫别的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
    PlayPause,
    Previous,
    Next,
    ToggleLyrics,
    OpenSettings,
}

impl ShortcutAction {
    /// 给用户看的名字（提示文案里用；与 `tray::MENU_SLOTS` 的文案逐字一致）。
    pub fn label(self) -> &'static str {
        match self {
            ShortcutAction::PlayPause => "播放·暂停",
            ShortcutAction::Previous => "上一首",
            ShortcutAction::Next => "下一首",
            ShortcutAction::ToggleLyrics => "桌面歌词",
            ShortcutAction::OpenSettings => "设置",
        }
    }

    /// 播放类动作的 `player:command` 命令词；其余动作 `None`（不发播放命令）。
    ///
    /// 词表是 R9 定的（`src/renderer/features/playback/player-commands.mjs` 是执行侧的唯一真源）：
    /// 发一个渲染层不认识的词，只会被结构化拒绝 = 用户按了没反应。
    pub fn play_command(self) -> Option<&'static str> {
        match self {
            ShortcutAction::PlayPause => Some("toggle"),
            ShortcutAction::Previous => Some("previous"),
            ShortcutAction::Next => Some("next"),
            ShortcutAction::ToggleLyrics | ShortcutAction::OpenSettings => None,
        }
    }
}

/// 一个动作的组合与备选链。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortcutBinding {
    pub action: ShortcutAction,
    /// 主组合（简报钉死的那一条）。
    pub primary: &'static str,
    /// 主组合被占用时**按顺序**试的备选。空 = 没有备选（媒体三键）。
    pub fallbacks: &'static [&'static str],
}

impl ShortcutBinding {
    /// 尝试顺序：主组合在前，备选按表里的顺序（试到第一条成功为止）。
    pub fn chain(&self) -> impl Iterator<Item = &'static str> + '_ {
        std::iter::once(self.primary).chain(self.fallbacks.iter().copied())
    }
}

/// 组合清单一（**唯一真源**）：媒体三键 + 两条提示型组合。
///
/// 提示型组合的备选刻意"同键加 Shift、再减一层 Alt"：用户按主组合失败后，能在提示里看到
/// 一个**还记得住**的键（同一个字母键），而不是一个毫无关系的组合。
pub const SHORTCUT_BINDINGS: &[ShortcutBinding] = &[
    ShortcutBinding {
        action: ShortcutAction::PlayPause,
        primary: "MediaPlayPause",
        fallbacks: &[],
    },
    ShortcutBinding {
        action: ShortcutAction::Previous,
        primary: "MediaTrackPrevious",
        fallbacks: &[],
    },
    ShortcutBinding {
        action: ShortcutAction::Next,
        primary: "MediaTrackNext",
        fallbacks: &[],
    },
    ShortcutBinding {
        action: ShortcutAction::ToggleLyrics,
        primary: "CmdOrCtrl+Alt+L",
        fallbacks: &["CmdOrCtrl+Alt+Shift+L", "CmdOrCtrl+Shift+L"],
    },
    ShortcutBinding {
        action: ShortcutAction::OpenSettings,
        primary: "CmdOrCtrl+Alt+S",
        fallbacks: &["CmdOrCtrl+Alt+Shift+S", "CmdOrCtrl+Shift+S"],
    },
];

/// 查一条绑定。表里没有就返回 `None`（调用方只记日志，不猜、不 panic）。
pub fn binding_for(action: ShortcutAction) -> Option<&'static ShortcutBinding> {
    SHORTCUT_BINDINGS
        .iter()
        .find(|binding| binding.action == action)
}

// ---------------------------------------------------------------------------
// 注册计划（纯函数）
// ---------------------------------------------------------------------------

/// 一次失败的注册尝试：哪条组合、为什么没成（原因原样保留——提示里要说真话）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutAttempt {
    pub combo: String,
    pub reason: String,
}

/// 一个动作的注册结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutPlan {
    pub action: ShortcutAction,
    /// 这个动作的主组合（提示文案里要对照"原来想用哪个"）。
    pub primary: &'static str,
    /// 真正生效的组合；`None` = 一条都没注册上（**不许填一个假组合**）。
    pub chosen: Option<String>,
    /// 按顺序试过的组合（成功的那条也在里面）。
    pub tried: Vec<String>,
    /// 失败的尝试（失败逐条留着，不静默丢弃）。
    pub failures: Vec<ShortcutAttempt>,
}

impl ShortcutPlan {
    /// 是否回退了（主组合没成、备选成了）。全废**不算**回退——那是失败，走另一条提示文案。
    pub fn fell_back(&self) -> bool {
        match &self.chosen {
            Some(combo) => combo.as_str() != self.primary,
            None => false,
        }
    }
}

/// 按备选链试注册：**试到第一条成功为止**，一条都不成就如实报"没有组合"。
///
/// `register` 由调用方注入（生产里是 `app.global_shortcut().on_shortcut(..)`，单测里是桩）：
/// 注册这件事的唯一不可测部分是那一次 FFI 调用，判定逻辑全在这个纯函数里。
pub fn plan_binding(
    binding: &ShortcutBinding,
    mut register: impl FnMut(&str) -> Result<(), String>,
) -> ShortcutPlan {
    let mut tried = Vec::new();
    let mut failures = Vec::new();

    for combo in binding.chain() {
        tried.push(combo.to_string());
        match register(combo) {
            Ok(()) => {
                return ShortcutPlan {
                    action: binding.action,
                    primary: binding.primary,
                    chosen: Some(combo.to_string()),
                    tried,
                    failures,
                }
            }
            Err(reason) => failures.push(ShortcutAttempt {
                combo: combo.to_string(),
                reason,
            }),
        }
    }

    ShortcutPlan {
        action: binding.action,
        primary: binding.primary,
        chosen: None,
        tried,
        failures,
    }
}

/// 一轮注册的完整结论。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShortcutReport {
    plans: Vec<ShortcutPlan>,
}

impl ShortcutReport {
    pub fn from_plans(plans: Vec<ShortcutPlan>) -> Self {
        Self { plans }
    }

    pub fn plans(&self) -> &[ShortcutPlan] {
        &self.plans
    }

    pub fn plan_for(&self, action: ShortcutAction) -> Option<&ShortcutPlan> {
        self.plans.iter().find(|plan| plan.action == action)
    }

    /// 这个动作**实际**用的组合（没注册上 / 没试过都是 `None`）。
    pub fn combo_for(&self, action: ShortcutAction) -> Option<&str> {
        self.plan_for(action)?.chosen.as_deref()
    }

    /// 真正生效的动作数（0 = 一个快捷键都没有）。
    pub fn active_count(&self) -> usize {
        self.plans.iter().filter(|plan| plan.chosen.is_some()).count()
    }
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 托管状态：本进程**实际生效**的组合。
///
/// 名字与插件的 `ShortcutState`（事件状态枚举）撞了，所以那边在 import 时改名成 `HotKeyState`；
/// 托管状态沿用简报给的名字。注册只在 setup 里发生一次，所以这里是**快照**而不是可变的表
/// （不维护第二份会漂移的镜像：状态页将来要显示的就是这张快照）。
pub struct ShortcutState {
    report: ShortcutReport,
}

impl ShortcutState {
    pub fn new(report: ShortcutReport) -> Self {
        Self { report }
    }

    pub fn report(&self) -> &ShortcutReport {
        &self.report
    }

    /// 某个动作此刻生效的组合（设置页将来显示"当前快捷键"就读它）。
    pub fn combo_for(&self, action: ShortcutAction) -> Option<&str> {
        self.report.combo_for(action)
    }
}

impl Default for ShortcutState {
    fn default() -> Self {
        Self {
            report: ShortcutReport::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/// 逐条注册全部组合，返回结论。**不 panic、不拦启动**。
///
/// 前置条件（顺序契约，由 `lib.rs` 的用例钉住）：调用前 core 状态必须已登记
/// （失败提示要经 `emit_core_event` 排队到渲染层就绪），且托盘可用性已确定
/// （提示里"请改用托盘菜单"得有根据）。
pub fn install<R: Runtime>(app: &AppHandle<R>) -> ShortcutReport {
    let mut plans = Vec::new();

    for binding in SHORTCUT_BINDINGS {
        let action = binding.action;
        let plan = plan_binding(binding, |candidate| {
            app.global_shortcut()
                .on_shortcut(candidate, move |app: &AppHandle<R>, _shortcut, event: ShortcutEvent| {
                    // 只认"按下"：松开那一次不该再发一遍广播（一次按键发两条 = 播放/暂停翻两次）
                    if event.state == HotKeyState::Pressed {
                        dispatch(app, action);
                    }
                })
                .map_err(|error| error.to_string())
        });

        match &plan.chosen {
            Some(combo) => log::info!("快捷键 {:?} 已注册：{combo}", action),
            None => log::warn!(
                "快捷键 {:?} 一条都没注册上（试过 {:?}，原因 {:?}）",
                action,
                plan.tried,
                plan.failures
            ),
        }
        plans.push(plan);
    }

    ShortcutReport::from_plans(plans)
}

/// 快捷键按下去之后的落地：广播意图（歌词键再顺带把托盘勾选镜像到目标态）。
fn dispatch<R: Runtime>(app: &AppHandle<R>, action: ShortcutAction) {
    let Some(broadcast) = broadcast_for(action, crate::lyrics_window::is_open(app)) else {
        log::warn!("快捷键 {action:?} 没有对应的广播（已忽略）");
        return;
    };

    // 勾选态由托盘的 CheckMenuItem 自己持有（R11）：**谁发起翻转谁负责把它改到目标态**——
    // 托盘菜单自己是这么做的（`tray::plan_lyrics_toggle`），快捷键这条路径同理，
    // 否则按了歌词键、托盘里的勾还是旧的（两处状态各说各话）。
    // 失败收口仍归 R12：歌词窗命令失败时，那条路径会把勾选翻回窗的实际状态。
    if let Some(checked) = broadcast.mirror_tray_checked {
        crate::tray::revert_lyrics_checked(app, checked);
    }

    emit_core_event(app, broadcast.channel, broadcast.payload);
}

/// 一个动作要发的广播（纯函数：通道与载荷都能单测钉住）。
#[derive(Debug, Clone, PartialEq)]
pub struct ShortcutBroadcast {
    pub channel: &'static str,
    pub payload: Value,
    /// 顺带要把托盘"桌面歌词"勾选改成什么（`None` = 与勾选无关）。
    pub mirror_tray_checked: Option<bool>,
}

/// 动作 → 广播。认不出的动作返回 `None`（调用方只记日志：宁可没反应，也不发一条假广播）。
pub fn broadcast_for(action: ShortcutAction, lyrics_window_open: bool) -> Option<ShortcutBroadcast> {
    if let Some(command) = action.play_command() {
        return Some(ShortcutBroadcast {
            channel: PLAYER_COMMAND,
            payload: json!({ "command": command }),
            mirror_tray_checked: None,
        });
    }

    match action {
        // 目标态 = 反事实状态（同托盘：消费方按目标态开关，不必知道现在是什么）
        ShortcutAction::ToggleLyrics => {
            let checked = !lyrics_window_open;
            Some(ShortcutBroadcast {
                channel: LYRICS_TOGGLE,
                payload: json!({ "checked": checked }),
                mirror_tray_checked: Some(checked),
            })
        }
        ShortcutAction::OpenSettings => Some(ShortcutBroadcast {
            channel: APP_OPEN_SETTINGS,
            payload: json!({ "view": "settings" }),
            mirror_tray_checked: None,
        }),
        // 播放三键在上面那条分支里已经返回了：走到这里说明两张表不同步。
        ShortcutAction::PlayPause | ShortcutAction::Previous | ShortcutAction::Next => None,
    }
}

/// 播放类动作的命令词（转调 [`ShortcutAction::play_command`]：词表只有一处）。
pub fn player_command_for(action: ShortcutAction) -> Option<&'static str> {
    action.play_command()
}

// ---------------------------------------------------------------------------
// 提示文案
// ---------------------------------------------------------------------------

/// 把库的写法翻译成用户认得的写法。
///
/// `CmdOrCtrl` 是 global-hotkey 的写法（macOS 上是 Cmd、其余平台是 Ctrl）：提示里直接印
/// `CmdOrCtrl+Alt+L`，用户会在自己键盘上找一个叫 CmdOrCtrl 的键。
/// **认不出的组合原样显示**——宁可露出库的写法，也不许翻译成一个别的键。
pub fn display_combo(combo: &str, macos: bool) -> String {
    match combo {
        "MediaPlayPause" => return "播放/暂停媒体键".to_string(),
        "MediaTrackPrevious" => return "上一首媒体键".to_string(),
        "MediaTrackNext" => return "下一首媒体键".to_string(),
        _ => {}
    }
    combo.replace("CmdOrCtrl", if macos { "Cmd" } else { "Ctrl" })
}

/// 一条问题一条提示：回退与全废才有话可说，一切正常时**不打扰用户**。
pub fn shortcut_notices(report: &ShortcutReport, tray_available: bool) -> Vec<String> {
    report
        .plans()
        .iter()
        .filter_map(|plan| shortcut_notice(plan, tray_available))
        .collect()
}

/// 单个动作的提示文案（`None` = 一切按计划，不必打扰用户）。
///
/// 文案要说清三件事：**哪个动作**、**为什么**、**下一步去哪**。下一步按事实分两种：
/// 托盘在就指托盘菜单，托盘没装上就指应用窗口——指一个不存在的地方比不指更糟。
pub fn shortcut_notice(plan: &ShortcutPlan, tray_available: bool) -> Option<String> {
    let label = plan.action.label();
    let advice = if tray_available {
        format!("请改用托盘菜单的「{label}」。")
    } else {
        format!("托盘没能启用，请改用应用窗口里的「{label}」。")
    };
    let macos = cfg!(target_os = "macos");
    let reason = plan
        .failures
        .first()
        .map(|failure| failure.reason.as_str())
        .unwrap_or("原因未记录");

    match &plan.chosen {
        // 一条都没成：说清试了几个、为什么，再指路
        None => Some(format!(
            "「{label}」的快捷键没能注册（共试了 {} 个组合都没成：{reason}）：{advice}",
            plan.tried.len()
        )),
        // 回退了：把"原来想用哪个、现在实际是哪个"都说出来（不静默换键）
        Some(combo) if plan.fell_back() => Some(format!(
            "「{label}」的 {} 没能注册（{reason}），已改用 {}。",
            display_combo(plan.primary, macos),
            display_combo(combo, macos)
        )),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::str::FromStr;

    use crate::bridge::BROADCAST_CHANNELS;
    use tauri_plugin_global_shortcut::Shortcut;

    /// 表里必须有这个动作（缺了就是"那个动作只剩托盘一条路，而用户不会知道"）。
    fn binding(action: ShortcutAction) -> &'static ShortcutBinding {
        binding_for(action).expect("组合表里必须有这个动作")
    }

    fn broadcast(action: ShortcutAction, lyrics_window_open: bool) -> ShortcutBroadcast {
        broadcast_for(action, lyrics_window_open).expect("每个动作都要有对应的广播")
    }

    /// 除 `blocked` 之外都放行（用来模拟"主组合被占、备选还空着"）。
    fn free_but<'a>(blocked: &[&'a str]) -> impl FnMut(&str) -> Result<(), String> + 'a {
        let blocked: Vec<&'a str> = blocked.to_vec();
        move |candidate| {
            if blocked.contains(&candidate) {
                Err("该组合已被其它程序注册".to_string())
            } else {
                Ok(())
            }
        }
    }

    /// 一条都注册不上（系统级禁用、Wayland 无 X 连接、键全被占）。
    fn free_nothing() -> impl FnMut(&str) -> Result<(), String> {
        |_: &str| Err("该组合已被其它程序注册".to_string())
    }

    fn free_everything() -> impl FnMut(&str) -> Result<(), String> {
        |_: &str| Ok(())
    }

    fn plan_of<'a>(action: ShortcutAction, blocked: &[&'a str]) -> ShortcutPlan {
        plan_binding(binding(action), free_but(blocked))
    }

    fn report_of(plans: Vec<ShortcutPlan>) -> ShortcutReport {
        ShortcutReport::from_plans(plans)
    }

    fn production_source() -> String {
        let source =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shortcuts.rs"))
                .expect("要能读到自己的源码");
        let cut = source.find("#[cfg(test)]").unwrap_or(source.len());
        source[..cut].to_string()
    }

    // -----------------------------------------------------------------------
    // 组合清单
    // -----------------------------------------------------------------------

    /// 简报的组合清单：媒体三键（无备选）、歌词与设置（各有备选链）。
    #[test]
    fn every_action_has_a_binding_with_the_agreed_primary_combo() {
        assert_eq!(SHORTCUT_BINDINGS.len(), 5, "五个动作各一条：{SHORTCUT_BINDINGS:?}");

        assert_eq!(binding(ShortcutAction::PlayPause).primary, "MediaPlayPause");
        assert_eq!(binding(ShortcutAction::Previous).primary, "MediaTrackPrevious");
        assert_eq!(binding(ShortcutAction::Next).primary, "MediaTrackNext");
        assert_eq!(binding(ShortcutAction::ToggleLyrics).primary, "CmdOrCtrl+Alt+L");
        assert_eq!(binding(ShortcutAction::OpenSettings).primary, "CmdOrCtrl+Alt+S");

        // 每个动作都查得到（查不到的动作 = 静默没有快捷键）
        for action in [
            ShortcutAction::PlayPause,
            ShortcutAction::Previous,
            ShortcutAction::Next,
            ShortcutAction::ToggleLyrics,
            ShortcutAction::OpenSettings,
        ] {
            assert!(binding_for(action).is_some(), "{action:?} 没有绑定");
        }

        // 媒体三键**没有**备选：备选只能是另一个不同于媒体键的组合，等于偷偷换一个用户没按过的键
        for action in [
            ShortcutAction::PlayPause,
            ShortcutAction::Previous,
            ShortcutAction::Next,
        ] {
            assert!(
                binding(action).fallbacks.is_empty(),
                "{action:?} 是媒体键：注册不上时只提示改用托盘菜单，不换键"
            );
        }
        for action in [ShortcutAction::ToggleLyrics, ShortcutAction::OpenSettings] {
            assert!(
                !binding(action).fallbacks.is_empty(),
                "{action:?} 是提示型组合：必须有至少一条备选（简报）"
            );
        }

        // 每个动作恰好出现一次
        let mut actions: Vec<String> = SHORTCUT_BINDINGS
            .iter()
            .map(|item| format!("{:?}", item.action))
            .collect();
        let total = actions.len();
        actions.sort();
        actions.dedup();
        assert_eq!(actions.len(), total, "同一个动作在表里出现了两次：{SHORTCUT_BINDINGS:?}");
    }

    /// 表里的每一个组合都必须能被 global-hotkey 解析（拼错一个字母 = 那一条永远注册不上），
    /// 且**没有任何两个动作抢同一个组合**（抢的后果是后注册的必然失败 + 一条看不懂的提示）。
    #[test]
    fn every_combo_parses_and_no_two_actions_claim_the_same_key() {
        let mut seen: HashSet<&str> = HashSet::new();
        for item in SHORTCUT_BINDINGS {
            for combo in item.chain() {
                assert!(!combo.trim().is_empty(), "{:?} 的组合不能是空串", item.action);
                assert_eq!(combo, combo.trim(), "组合里不许有空白：{combo:?}");
                assert!(
                    Shortcut::from_str(combo).is_ok(),
                    "{:?} 的组合 {combo:?} 解析不了：这条永远注册不上",
                    item.action
                );
                assert!(seen.insert(combo), "组合 {combo:?} 被两个动作抢（后注册的必然失败）");
            }
        }
        assert!(seen.len() >= 9, "主组合 5 条 + 备选 4 条：{:?}", seen);
    }

    // -----------------------------------------------------------------------
    // 注册计划（纯函数）
    // -----------------------------------------------------------------------

    #[test]
    fn a_free_primary_combo_is_taken_and_no_fallback_is_tried() {
        let plan = plan_binding(binding(ShortcutAction::ToggleLyrics), free_everything());
        assert_eq!(plan.chosen.as_deref(), Some("CmdOrCtrl+Alt+L"));
        assert_eq!(plan.tried, vec!["CmdOrCtrl+Alt+L"], "主组合就成了：备选一个都不该试");
        assert!(plan.failures.is_empty());
        assert!(!plan.fell_back(), "没回退就不该说'换过键'");
        assert_eq!(plan.primary, "CmdOrCtrl+Alt+L", "主组合留在计划里，提示要对照");
    }

    #[test]
    fn an_occupied_primary_falls_back_along_the_chain_and_says_so() {
        let binding = binding(ShortcutAction::ToggleLyrics);
        let expected = binding.fallbacks[0];
        let plan = plan_of(ShortcutAction::ToggleLyrics, &[binding.primary]);

        assert_eq!(plan.chosen.as_deref(), Some(expected), "应当落到第一条备选");
        assert_eq!(plan.tried, vec![binding.primary, expected], "试过的组合按顺序记下来");
        assert_eq!(plan.failures.len(), 1, "失败的那一次要如实记着");
        assert_eq!(plan.failures[0].combo, binding.primary);
        assert!(
            !plan.failures[0].reason.is_empty(),
            "失败原因不许丢（提示里要说明白为什么换键）"
        );
        assert!(plan.fell_back(), "主组合没成而备选成了 = 回退");
    }

    #[test]
    fn the_chain_stops_at_the_first_success() {
        let binding = binding(ShortcutAction::OpenSettings);
        let first = binding.fallbacks[0];
        let plan = plan_of(ShortcutAction::OpenSettings, &[binding.primary, first]);

        assert_eq!(plan.chosen.as_deref(), Some(binding.fallbacks[1]), "再往下一档");
        assert_eq!(plan.tried.len(), 3, "试到成功为止：{:?}", plan.tried);
        assert_eq!(plan.failures.len(), 2);
        assert_eq!(
            plan.tried.iter().map(String::as_str).collect::<Vec<_>>(),
            binding.chain().collect::<Vec<_>>(),
            "试的顺序必须与备选链一致"
        );
    }

    #[test]
    fn a_dead_chain_reports_every_attempt_and_records_no_combo() {
        let binding = binding(ShortcutAction::ToggleLyrics);
        let chain: Vec<&str> = binding.chain().collect();
        let plan = plan_binding(binding, free_nothing());

        assert_eq!(plan.chosen, None, "一条都没成：不许记一个假组合");
        assert_eq!(plan.tried.len(), chain.len(), "每一条都要真的试过：{:?}", plan.tried);
        assert_eq!(plan.failures.len(), chain.len(), "失败逐条记着（不静默）");
        for (failure, combo) in plan.failures.iter().zip(chain.iter()) {
            assert_eq!(&failure.combo, combo, "失败的顺序与尝试顺序一致");
            assert!(!failure.reason.is_empty());
        }
        assert!(!plan.fell_back(), "全废不是'回退'，是失败");
    }

    /// 媒体键没有备选链：注册不上就是没有，**绝不静默换一个用户没按过的键**。
    #[test]
    fn a_media_key_that_cannot_register_has_no_silent_replacement() {
        let binding = binding(ShortcutAction::PlayPause);
        let plan = plan_binding(binding, free_nothing());

        assert_eq!(plan.tried, vec!["MediaPlayPause"], "只试它自己");
        assert_eq!(plan.chosen, None);
        assert_eq!(plan.failures.len(), 1);
        assert_eq!(plan.failures[0].combo, "MediaPlayPause", "失败要记清是哪条组合");
        assert!(!plan.fell_back(), "没有备选可退，谈不上回退");
    }

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------

    #[test]
    fn the_report_answers_which_combo_is_actually_in_use() {
        let fallback = binding(ShortcutAction::ToggleLyrics).fallbacks[0];
        let report = report_of(vec![
            plan_of(ShortcutAction::ToggleLyrics, &["CmdOrCtrl+Alt+L"]),
            plan_binding(binding(ShortcutAction::OpenSettings), free_everything()),
            plan_binding(binding(ShortcutAction::PlayPause), free_nothing()),
        ]);

        assert_eq!(report.combo_for(ShortcutAction::ToggleLyrics), Some(fallback));
        assert_eq!(
            report.combo_for(ShortcutAction::OpenSettings),
            Some("CmdOrCtrl+Alt+S")
        );
        assert_eq!(
            report.combo_for(ShortcutAction::PlayPause),
            None,
            "没注册上的动作没有组合（状态里不许留假话）"
        );
        assert_eq!(report.active_count(), 2);
        assert_eq!(report.plans().len(), 3);
        assert_eq!(
            report.plan_for(ShortcutAction::PlayPause).map(|plan| plan.tried.len()),
            Some(1)
        );
        // 表里没试过的动作也问得到，答案是"没有"
        assert_eq!(report.combo_for(ShortcutAction::Next), None);

        // 托管状态就是这张快照（设置页将来读它）
        let state = ShortcutState::new(report.clone());
        assert_eq!(state.combo_for(ShortcutAction::ToggleLyrics), Some(fallback));
        assert_eq!(state.report(), &report);
        assert_eq!(ShortcutState::default().report().active_count(), 0);
    }

    // -----------------------------------------------------------------------
    // 提示文案
    // -----------------------------------------------------------------------

    #[test]
    fn a_fallback_notice_names_the_key_in_use_and_the_one_it_replaced() {
        let report = report_of(vec![plan_of(ShortcutAction::ToggleLyrics, &["CmdOrCtrl+Alt+L"])]);
        let notices = shortcut_notices(&report, true);

        assert_eq!(notices.len(), 1, "一条问题一条提示：{notices:?}");
        let text = &notices[0];
        assert!(text.contains("桌面歌词"), "说清是哪个动作：{text}");
        assert!(text.contains("Ctrl+Alt+L"), "说清原来想用的是哪个键：{text}");
        assert!(
            text.contains("Ctrl+Alt+Shift+L"),
            "说清现在用的是哪个键（不静默换键）：{text}"
        );
        assert!(text.contains("已改用"), "这是回退，不是失败：{text}");
        assert!(
            text.contains("该组合已被其它程序注册"),
            "原因原样带上（提示要说真话）：{text}"
        );
    }

    #[test]
    fn every_shortcut_that_really_works_produces_no_notice() {
        let report = report_of(vec![
            plan_binding(binding(ShortcutAction::ToggleLyrics), free_everything()),
            plan_binding(binding(ShortcutAction::PlayPause), free_everything()),
        ]);
        assert_eq!(report.active_count(), 2);
        assert!(shortcut_notices(&report, true).is_empty(), "全成都成了就别打扰用户");
        assert!(shortcut_notices(&ShortcutReport::default(), true).is_empty());
    }

    /// 全废的动作要指路托盘菜单（简报第 6 项），并带上真实原因。
    #[test]
    fn a_dead_media_key_points_at_the_tray_menu() {
        let report = report_of(vec![plan_binding(binding(ShortcutAction::PlayPause), free_nothing())]);
        let notices = shortcut_notices(&report, true);

        assert_eq!(notices.len(), 1, "{notices:?}");
        let text = &notices[0];
        assert!(text.contains("播放·暂停"), "说清是哪个动作：{text}");
        assert!(text.contains("托盘菜单"), "指路托盘菜单：{text}");
        assert!(text.contains("该组合已被其它程序注册"), "带上原因：{text}");
        assert!(text.contains("1 个组合"), "说清试了几个（媒体键只有一条路）：{text}");
    }

    /// 托盘没装上还指路托盘菜单 = 让用户去一个不存在的地方找。这时只能指主界面。
    #[test]
    fn a_dead_shortcut_in_an_app_without_a_tray_points_at_the_window_instead() {
        for action in [
            ShortcutAction::PlayPause,
            ShortcutAction::ToggleLyrics,
            ShortcutAction::OpenSettings,
        ] {
            let report = report_of(vec![plan_binding(binding(action), free_nothing())]);
            let notices = shortcut_notices(&report, false);

            assert_eq!(notices.len(), 1, "{notices:?}");
            let text = &notices[0];
            assert!(
                !text.contains("托盘菜单"),
                "{action:?}：托盘没装上就不许指路托盘菜单：{text}"
            );
            assert!(text.contains("窗口"), "{action:?}：要指一个真的存在的地方：{text}");
        }
    }

    /// 文案纪律：不写任务号、不画饼、不用感叹号喊人、一条别写成一段话。
    #[test]
    fn notice_copy_stays_restrained() {
        let report = report_of(vec![
            plan_of(ShortcutAction::ToggleLyrics, &["CmdOrCtrl+Alt+L"]),
            plan_binding(binding(ShortcutAction::OpenSettings), free_nothing()),
            plan_binding(binding(ShortcutAction::PlayPause), free_nothing()),
        ]);
        let notices = shortcut_notices(&report, true);

        assert_eq!(notices.len(), 3, "三条问题三条提示：{notices:?}");
        for text in &notices {
            assert!(!text.trim().is_empty());
            for forbidden in ["R13", "敬请期待", "即将上线", "！", "!"] {
                assert!(!text.contains(forbidden), "文案克制（禁 {forbidden}）：{text}");
            }
            assert!(text.chars().count() < 120, "一条提示别写成一段话：{text}");
        }
    }

    #[test]
    fn display_combo_speaks_the_platform_language() {
        assert_eq!(display_combo("CmdOrCtrl+Alt+L", false), "Ctrl+Alt+L");
        assert_eq!(display_combo("CmdOrCtrl+Alt+L", true), "Cmd+Alt+L");
        assert_eq!(display_combo("CmdOrCtrl+Alt+Shift+S", false), "Ctrl+Alt+Shift+S");
        assert_eq!(display_combo("MediaPlayPause", false), "播放/暂停媒体键");
        assert_eq!(display_combo("MediaTrackPrevious", true), "上一首媒体键");
        assert_eq!(display_combo("MediaTrackNext", false), "下一首媒体键");
        // 认不出的组合原样显示：宁可露出库的写法，也不许翻译成别的键
        assert_eq!(display_combo("F13", false), "F13");
    }

    // -----------------------------------------------------------------------
    // 动作 → 广播（纯函数；落地只经 emit_core_event）
    // -----------------------------------------------------------------------

    #[test]
    fn the_lyrics_key_asks_for_the_opposite_state_and_mirrors_the_tray_checkbox() {
        let closed = broadcast(ShortcutAction::ToggleLyrics, false);
        assert_eq!(closed.channel, LYRICS_TOGGLE);
        assert_eq!(closed.payload, json!({ "checked": true }));
        assert_eq!(closed.mirror_tray_checked, Some(true), "托盘的勾选要跟着一起走");

        let open = broadcast(ShortcutAction::ToggleLyrics, true);
        assert_eq!(open.payload, json!({ "checked": false }));
        assert_eq!(open.mirror_tray_checked, Some(false));
    }

    #[test]
    fn the_media_keys_send_the_words_the_renderer_knows_and_the_rest_do_not() {
        assert_eq!(player_command_for(ShortcutAction::PlayPause), Some("toggle"));
        assert_eq!(player_command_for(ShortcutAction::Previous), Some("previous"));
        assert_eq!(player_command_for(ShortcutAction::Next), Some("next"));
        for action in [ShortcutAction::ToggleLyrics, ShortcutAction::OpenSettings] {
            assert_eq!(player_command_for(action), None, "{action:?} 不发播放命令");
        }
        assert_eq!(broadcast(ShortcutAction::Next, false).payload, json!({ "command": "next" }));

        // 词表是跨语言契约：渲染层认不出就结构化拒绝（= 按了没反应）
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/renderer/features/playback/player-commands.mjs"
        ))
        .expect("要能读到渲染层的命令词表");
        let start = source.find("PLAYER_COMMANDS = [").expect("命令词表在渲染层");
        let end = source[start..].find(']').expect("词表要闭合") + start;
        let table = &source[start..end];
        for (action, word) in [
            (ShortcutAction::PlayPause, "toggle"),
            (ShortcutAction::Previous, "previous"),
            (ShortcutAction::Next, "next"),
        ] {
            assert_eq!(player_command_for(action), Some(word));
            assert!(table.contains(&format!("\"{word}\"")), "渲染层认得 {word}：{table}");
        }
    }

    #[test]
    fn the_settings_key_opens_the_settings_view() {
        let settings = broadcast(ShortcutAction::OpenSettings, false);
        assert_eq!(settings.channel, APP_OPEN_SETTINGS);
        assert_eq!(settings.payload, json!({ "view": "settings" }));
        assert_eq!(settings.mirror_tray_checked, None, "设置键与托盘勾选无关");
    }

    /// 快捷键发的三条广播都必须在桥的白名单里：不在的话那条广播会被当白名单外的帧丢掉
    /// （用户按了没反应，日志里只有一条 Reject）。
    #[test]
    fn every_broadcast_a_shortcut_sends_is_on_the_bridge_whitelist() {
        for action in [
            ShortcutAction::PlayPause,
            ShortcutAction::Previous,
            ShortcutAction::Next,
            ShortcutAction::ToggleLyrics,
            ShortcutAction::OpenSettings,
        ] {
            let channel = broadcast(action, false).channel;
            assert!(
                BROADCAST_CHANNELS.contains(&channel),
                "{action:?} 发的 {channel} 不在广播白名单里"
            );
            assert_eq!(
                binding_for(action).map(|item| item.primary.is_empty()),
                Some(false),
                "{action:?} 的绑定不许是空组合"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 源码扫描（本模块的纪律）
    // -----------------------------------------------------------------------

    /// 广播只能经 `commands::emit_core_event`（唯一构造点）：自己 `app.emit` 等于绕开启动期队列。
    #[test]
    fn the_module_never_emits_envelopes_itself() {
        let production = production_source();
        assert!(
            !production.contains(".emit("),
            "快捷键模块不许自己 emit：事件信封的唯一构造点是 commands::emit_core_event"
        );
        assert!(production.contains("emit_core_event("), "三条广播都该走 emit_core_event");
        // 三条广播的通道都得是真的接上去的（不是只在 doc 里提了一句）
        let compact: String = production.chars().filter(|c| !c.is_whitespace()).collect();
        for channel in ["PLAYER_COMMAND", "LYRICS_TOGGLE", "APP_OPEN_SETTINGS"] {
            assert!(
                compact.contains(&format!("channel:{channel},")),
                "广播表里 {channel} 没有真的接到某个动作上（常量来自 bridge.rs）"
            );
        }
        // 插件不许替我们注册组合：它失败会把整个 setup 带崩（见模块头）
        for forbidden in [".with_shortcut(", ".with_shortcuts("] {
            assert!(!production.contains(forbidden), "组合只能由本模块逐条注册：{forbidden}");
        }
        assert!(production.contains("GlobalShortcutExt"), "注册走 app.global_shortcut()");
    }

    #[test]
    fn the_module_never_panics_on_the_registration_path() {
        let production = production_source();
        for forbidden in [".unwrap()", ".expect(", "panic!(", "unreachable!(", "todo!("] {
            assert!(
                !production.contains(forbidden),
                "快捷键模块的生产代码不许出现 {forbidden}（注册不上要如实报告，不是崩掉）"
            );
        }
    }

    /// Wayland：global-hotkey 的 Linux 后端只有 X11（`x11rb`），Wayland 原生会话下注册会失败。
    /// 这件事必须**写在代码里**（文案不承诺 Wayland），否则下一个做平台适配的人只能靠猜。
    #[test]
    fn the_wayland_limitation_is_written_down_where_the_code_is() {
        let production = production_source();
        assert!(production.contains("Wayland"), "要写清 Wayland 的限制");
        assert!(production.contains("X11"), "要写清后端只有 X11");
        assert!(
            !production.contains("支持 Wayland") && !production.contains("Wayland 也支持"),
            "不许承诺 Wayland"
        );
    }
}
