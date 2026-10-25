//! Windows taskbar embedding. Placement/single-flight policy is platform-independent.
//! Native writes are confined to the registered lyrics window on its owner thread.
//! Adapted from ANYNC/TaskbarLyrics bd746ff87a2d4d20543a7e91654ef09675a93c5b (MIT; see NOTICE).

use std::collections::BTreeSet;
use serde_json::{json, Value};

pub const SNAPSHOT_LIFETIME_MS: u64 = 2000;
pub const PROBE_INTERVAL_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }
impl PixelRect {
    fn valid(self) -> bool { self.width > 0 && self.height > 0 && self.x.checked_add(self.width).is_some() && self.y.checked_add(self.height).is_some() }
    fn right(self) -> i32 { self.x + self.width }
    fn bottom(self) -> i32 { self.y + self.height }
    fn intersects(self, other: Self) -> bool { self.x < other.right() && other.x < self.right() && self.y < other.bottom() && other.y < self.bottom() }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowIdentity { pub handle: isize, pub pid: u32, pub thread: u32, pub process_started: u64 }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnWindow { pub handle: isize, pub generation: u64, pub pid: u32, pub thread: u32 }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetSnapshot {
    pub shell: WindowIdentity, pub parent: WindowIdentity, pub client_screen: PixelRect,
    pub monitor: isize, pub monitor_rect: PixelRect, pub dpi: u32, pub dpi_context: isize,
}
impl TargetSnapshot {
    fn same_surface(&self, other: &Self) -> bool { self.shell == other.shell && self.parent == other.parent && self.monitor == other.monitor && self.dpi == other.dpi && self.dpi_context == other.dpi_context }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason { Disabled, Waiting, Attached, NoSpace, UiaUnknown, Timeout, AccessDenied, ShellUnavailable, AutoHide, DpiMismatch, Stale, AttachFailed, Unsupported, DestroyFailed }
impl Reason {
    pub fn as_str(self) -> &'static str { match self {
        Self::Disabled => "disabled", Self::Waiting => "waiting", Self::Attached => "attached", Self::NoSpace => "no_space", Self::UiaUnknown => "uia_unknown", Self::Timeout => "timeout", Self::AccessDenied => "access_denied", Self::ShellUnavailable => "shell_unavailable", Self::AutoHide => "auto_hide", Self::DpiMismatch => "dpi_mismatch", Self::Stale => "stale", Self::AttachFailed => "attach_failed", Self::Unsupported => "unsupported", Self::DestroyFailed => "destroy_failed",
    } }
    pub fn payload(self, attached: bool) -> Value { json!({ "supported": cfg!(windows), "attached": attached, "reason": self.as_str() }) }
}

pub fn safe_slot(target: &TargetSnapshot, occupied: Option<&[PixelRect]>) -> Result<PixelRect, Reason> {
    let bar = target.client_screen;
    if !bar.valid() || target.dpi == 0 || target.dpi > 960 { return Err(Reason::Stale); }
    let occupied = occupied.filter(|r| !r.is_empty()).ok_or(Reason::UiaUnknown)?;
    if occupied.iter().any(|r| !r.valid()) { return Err(Reason::UiaUnknown); }
    let scale = f64::from(target.dpi) / 96.0;
    let margin = (8.0 * scale).ceil() as i32;
    let minimum = (100.0 * scale).ceil() as i32;
    if bar.width < bar.height || bar.height < (24.0 * scale).ceil() as i32 { return Err(Reason::NoSpace); }
    let mut intervals: Vec<_> = occupied.iter().filter(|r| r.intersects(bar)).map(|r| (
        r.x.saturating_sub(bar.x).saturating_sub(margin).clamp(0, bar.width),
        r.right().saturating_sub(bar.x).saturating_add(margin).clamp(0, bar.width),
    )).collect();
    if intervals.is_empty() { return Err(Reason::UiaUnknown); }
    intervals.sort_unstable();
    let mut cursor = margin;
    let mut best = (0, 0);
    for (start, end) in intervals.into_iter().chain(std::iter::once((bar.width - margin, bar.width))) {
        if start - cursor > best.1 { best = (cursor, start - cursor); }
        cursor = cursor.max(end);
    }
    if best.1 < minimum { return Err(Reason::NoSpace); }
    let height = ((44.0 * scale).round() as i32).min(bar.height);
    Ok(PixelRect { x: best.0, y: (bar.height - height) / 2, width: best.1.min((1200.0 * scale).round() as i32), height })
}

pub fn child_styles(style: isize, exstyle: isize) -> (isize, isize) {
    ((style & !0x90cf0000) | 0x48000000, (exstyle & !0x000c0320) | 0x08000000)
}

pub fn surface_message(message: u32, taskbar_created: u32) -> bool {
    (taskbar_created != 0 && message == taskbar_created) || matches!(message, 0x007e | 0x02e0 | 0x02e2 | 0x02e3)
}

/// 窄自窗判据（纯逻辑，可脱窗单测）：句柄必须**存在**、属于**本进程**、且是**当前 owner 线程**的窗。
///
/// 只给子类化顶层主窗那一个入口用：主窗不属于歌词创建代次，`ensure_own` 的代次资格对它不成立，
/// 但"只写自窗"这条不变量不变——外来 HWND（Explorer 的任务栏控件、任意他进程窗）PID 对不上，
/// 别的线程拥有的窗也不在本线程上，两者都被拒；销毁后的句柄（`is_window == false`）同样被拒。
pub fn self_window(is_window: bool, pid: u32, thread: u32, current_pid: u32, current_thread: u32) -> bool {
    is_window && pid != 0 && pid == current_pid && thread == current_thread
}

pub fn verify_content_bounds(wanted: PixelRect, actual: Result<PixelRect, Reason>) -> Result<(), Reason> {
    if wanted.valid() && actual? == wanted { Ok(()) } else { Err(Reason::AttachFailed) }
}

pub fn uia_container(class: &str, control_type: i32, shell_owned: bool, root: bool) -> bool {
    root || (shell_owned && matches!(control_type, 50033 | 50025 | 50032) && matches!(class, "Windows.UI.Input.InputSite.WindowClass" | "Taskbar.TaskbarFrameAutomationPeer" | "ReBarWindow32" | "WorkerW"))
}

pub fn verify_placement(target: &TargetSnapshot, actual_parent: isize, slot: PixelRect, actual_screen: PixelRect) -> Result<(), Reason> {
    let bar = target.client_screen;
    if actual_parent != target.parent.handle || !bar.valid() || !slot.valid() || !actual_screen.valid() || slot.x < 0 || slot.y < 0 || slot.right() > bar.width || slot.bottom() > bar.height { return Err(Reason::AttachFailed); }
    if i64::from(actual_screen.x) != i64::from(bar.x) + i64::from(slot.x) || i64::from(actual_screen.y) != i64::from(bar.y) + i64::from(slot.y) || actual_screen.width != slot.width || actual_screen.height != slot.height { return Err(Reason::AttachFailed); }
    Ok(())
}

pub fn attachment_attempt<T>(state: &mut T, apply: impl FnOnce(&mut T) -> Result<(), Reason>, hide: impl FnOnce(&mut T), rollback: impl FnOnce(&mut T)) -> Result<(), Reason> {
    let result = apply(state);
    if result.is_err() { hide(state); rollback(state); }
    result
}

/// 受控切出（detach）的纯状态收口：`restored` 是隐藏 + restore 的实际结果。
/// 成功才 detached；失败必须失败关闭——旧宿主立刻禁探测、禁摆位、保持隐藏，
/// 且已保存的恢复信息不收掉，好让同一有效代次重试 restore/detach。
pub fn finish_detach(state: &mut EmbedState, own: OwnWindow, restored: Result<(), Reason>) -> Result<(), Reason> {
    if state.live() != Some(own) { return Err(Reason::Stale); }
    match restored {
        Ok(()) => { state.detached(); Ok(()) }
        Err(reason) => { state.revoke(reason); Err(reason) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyPlan { Hide(Reason), Place(PixelRect), Rebuild }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query { epoch: u64, own: OwnWindow, target: TargetSnapshot, started: u64 }
#[derive(Default)]
pub struct EmbedState {
    live: Option<OwnWindow>, dead_through: u64, epoch: u64, enabled: bool, requested: bool,
    /// 已切出 taskbar（或切出失败）的代次：保留写资格与 saved 以便重试，但永不再探测/显示/摆位。
    revoked: Option<(OwnWindow, Reason)>,
    inflight: Option<Query>, last_query: Option<u64>, snapshot: Option<(Query, Vec<PixelRect>)>,
    attachment: Option<TargetSnapshot>, failure: Option<Reason>,
    native_alive: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
impl EmbedState {
    pub fn register(&mut self, own: OwnWindow) {
        if own.generation <= self.dead_through || self.live.is_some_and(|live| live.generation >= own.generation) { return; }
        self.live = Some(own); self.revoked = None; self.invalidate();
    }
    pub fn live(&self) -> Option<OwnWindow> { self.live }
    pub fn destroyed(&mut self, own: OwnWindow) {
        self.dead_through = self.dead_through.max(own.generation);
        if self.revoked.is_some_and(|(revoked, _)| revoked == own) { self.revoked = None; }
        if self.live == Some(own) { self.live = None; self.attachment = None; self.invalidate(); }
    }
    fn invalidate(&mut self) { self.epoch += 1; self.snapshot = None; self.last_query = None; self.failure = None; }
    pub fn request(&mut self, enabled: bool, requested: bool) {
        // 已切出（或切出失败）的代次不允许被重新开启：旧 policy 不能靠一次 request 复活探测。
        if self.revoked.is_some() && (enabled || requested) { self.enabled = false; self.requested = false; self.invalidate(); return; }
        if (self.enabled, self.requested) != (enabled, requested) { self.invalidate(); }
        self.enabled = enabled; self.requested = requested;
    }
    /// 切出 taskbar（或 restore 失败）后的失败关闭：旧宿主立刻 detached、禁探测、禁摆位，
    /// 且不再接受 `request(true, true)` 复活；`live` 与已保存的恢复信息都保留，
    /// 好让同一有效代次仍能走 detach/restore 重试。回到 desktop 必须由新 HWND 重新 `register`。
    /// 第一次的原因胜出：后续的兜底 revoke 不会盖掉更精确的 restore 失败原因。
    pub fn revoke(&mut self, reason: Reason) {
        if let Some(own) = self.live { self.revoked.get_or_insert((own, reason)); }
        self.enabled = false; self.requested = false; self.attachment = None;
        self.fail(reason);
    }
    pub fn revoked(&self) -> Option<Reason> { self.revoked.map(|(_, reason)| reason) }
    pub fn probing(&self) -> bool { self.enabled && self.requested && self.live.is_some() && self.revoked.is_none() }
    pub fn may_write(&self, own: OwnWindow, pid: u32, thread: u32) -> bool { self.live == Some(own) && own.generation > self.dead_through && own.pid == pid && own.thread == thread && self.native_alive.as_ref().is_none_or(|alive| alive.load(std::sync::atomic::Ordering::Acquire)) }
    pub fn begin_query(&mut self, target: TargetSnapshot, now: u64) -> Option<Query> {
        if !self.probing() || self.inflight.is_some() || self.last_query.is_some_and(|last| now.saturating_sub(last) < PROBE_INTERVAL_MS) { return None; }
        let q = Query { epoch: self.epoch, own: self.live?, target, started: now };
        self.last_query = Some(now); self.inflight = Some(q.clone()); Some(q)
    }
    pub fn complete(&mut self, query: Query, result: Result<Vec<PixelRect>, Reason>, now: u64) {
        if self.inflight.as_ref() != Some(&query) { return; }
        self.inflight = None;
        if query.epoch != self.epoch || self.live != Some(query.own) || !self.probing() { return; }
        if now.saturating_sub(query.started) > SNAPSHOT_LIFETIME_MS { self.fail(Reason::Timeout); return; }
        match result { Ok(rects) => { self.snapshot = Some((query, rects)); self.failure = None; }, Err(reason) => self.fail(reason) }
    }
    pub fn shell_changed(&mut self) { self.invalidate(); }
    pub fn fail(&mut self, reason: Reason) { self.epoch += 1; self.snapshot = None; self.failure = Some(reason); }
    pub fn attached(&mut self, target: TargetSnapshot) { self.attachment = Some(target); }
    pub fn detached(&mut self) { self.revoked = None; self.attachment = None; self.invalidate(); }
    pub fn plan(&self, current: &TargetSnapshot, now: u64) -> ApplyPlan {
        if let Some(reason) = self.revoked() { return ApplyPlan::Hide(reason); }
        if !self.probing() { return ApplyPlan::Hide(Reason::Disabled); }
        if self.attachment.as_ref().is_some_and(|old| !old.same_surface(current)) { return ApplyPlan::Rebuild; }
        if let Some((query, rects)) = &self.snapshot {
            if now.saturating_sub(query.started) > SNAPSHOT_LIFETIME_MS { return ApplyPlan::Hide(Reason::Timeout); }
            if query.target != *current { return ApplyPlan::Hide(Reason::Stale); }
            return match safe_slot(current, Some(rects)) { Ok(rect) => ApplyPlan::Place(rect), Err(reason) => ApplyPlan::Hide(reason) };
        }
        ApplyPlan::Hide(self.failure.unwrap_or_else(|| if self.inflight.as_ref().is_some_and(|q| now.saturating_sub(q.started) > SNAPSHOT_LIFETIME_MS) { Reason::Timeout } else { Reason::Waiting }))
    }
}

pub struct GenerationResources<T = isize> {
    current: std::sync::Mutex<(Option<OwnWindow>, Option<(OwnWindow, T)>)>,
    dead: std::sync::atomic::AtomicU64,
}
impl<T> Default for GenerationResources<T> {
    fn default() -> Self { Self { current: std::sync::Mutex::new((None, None)), dead: std::sync::atomic::AtomicU64::new(0) } }
}
impl<T> GenerationResources<T> {
    pub fn destroyed(&self, generation: u64) { self.dead.fetch_max(generation, std::sync::atomic::Ordering::AcqRel); }
    pub fn dead_through(&self) -> u64 { self.dead.load(std::sync::atomic::Ordering::Acquire) }
    fn access<R>(&self, apply: impl FnOnce(&mut (Option<OwnWindow>, Option<(OwnWindow, T)>)) -> R) -> R {
        let mut slot = self.current.lock().unwrap_or_else(|p| p.into_inner());
        if slot.0.is_some_and(|own| own.generation <= self.dead_through()) { *slot = (None, None); }
        apply(&mut slot)
    }
    pub fn register(&self, own: OwnWindow) {
        self.access(|slot| {
            if own.generation > self.dead_through() && slot.0.is_none_or(|current| current.generation < own.generation) { *slot = (Some(own), None); }
        });
    }
    pub fn with_current<R>(&self, apply: impl FnOnce(Option<OwnWindow>) -> R) -> R { self.access(|slot| apply(slot.0)) }
    pub fn live(&self) -> Option<OwnWindow> { self.with_current(|own| own) }
    pub fn save(&self, own: OwnWindow, saved: T) { self.access(|slot| { if slot.0 == Some(own) && own.generation > self.dead_through() { slot.1 = Some((own, saved)); } }); }
    pub fn clear_saved(&self, own: OwnWindow) { self.access(|slot| { if slot.0 == Some(own) { slot.1 = None; } }); }
    pub fn saved_for(&self, own: OwnWindow) -> Option<T> where T: Clone { self.access(|slot| slot.1.as_ref().filter(|(token, _)| *token == own && slot.0 == Some(own)).map(|(_, saved)| saved.clone())) }
}

#[derive(Default)]
pub struct NativeReadiness { generation: Option<u64>, dead_through: u64 }
impl NativeReadiness {
    pub fn acknowledge(&mut self, generation: u64) { if generation > self.dead_through && self.generation.is_none_or(|current| generation >= current) { self.generation = Some(generation); } }
    pub fn destroyed(&mut self, generation: u64) { self.dead_through = self.dead_through.max(generation); if self.generation.is_some_and(|g| g <= self.dead_through) { self.generation = None; } }
    pub fn matches(&self, generation: u64) -> bool { self.generation == Some(generation) && generation > self.dead_through }
}

#[derive(Default)]
pub struct ExitBarrier { deadline: Option<u64>, awaiting: Option<u64>, destroyed: BTreeSet<u64>, failed: BTreeSet<u64> }
impl ExitBarrier {
    pub fn begin(&mut self, now: u64, generation: Option<u64>) { if self.deadline.is_none() { self.deadline = Some(now.saturating_add(2000)); self.awaiting = generation; } }
    pub fn destroyed(&mut self, generation: u64) { self.destroyed.insert(generation); }
    pub fn failed(&mut self, generation: u64) { self.failed.insert(generation); }
    pub fn finished(&self, now: u64) -> bool { self.deadline.is_some_and(|deadline| now >= deadline || self.awaiting.is_none_or(|g| self.destroyed.contains(&g) || self.failed.contains(&g))) }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{marker::PhantomData, rc::Rc, sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex, MutexGuard}, time::Instant};
    use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
    use windows::{core::{w, PWSTR}, Win32::{
        Foundation::{CloseHandle, GetLastError, SetLastError, HANDLE, HWND, POINT, RECT, FILETIME, WIN32_ERROR},
        Graphics::Gdi::{GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY},
        System::{Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED}, Threading::{GetCurrentProcess, GetCurrentThreadId, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION}},
        UI::{Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationElement, TreeScope_Children}, HiDpi::{AreDpiAwarenessContextsEqual, GetDpiForWindow, GetThreadDpiAwarenessContext, GetWindowDpiAwarenessContext}, Shell::{SHAppBarMessage, APPBARDATA, ABM_GETSTATE, ABM_GETAUTOHIDEBAREX, ABS_AUTOHIDE}, WindowsAndMessaging::*},
    }};

    struct NativeLife { alive: std::sync::Arc<AtomicBool>, changed: std::sync::Arc<AtomicBool>, taskbar_created: u32 }
    // Installed only on our lyrics HWND, never on Explorer. ref_data owns one Box until WM_NCDESTROY.
    // The callback marks liveness before forwarding destruction, without taking any host mutex.
    unsafe extern "system" fn lyrics_proc(window: HWND, message: u32, w: windows::Win32::Foundation::WPARAM, l: windows::Win32::Foundation::LPARAM, id: usize, ref_data: usize) -> windows::Win32::Foundation::LRESULT {
        use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
        let life = &*(ref_data as *const NativeLife);
        if message == WM_NCDESTROY {
            life.alive.store(false, Ordering::Release);
            let _ = RemoveWindowSubclass(window, Some(lyrics_proc), id);
            drop(Box::from_raw(ref_data as *mut NativeLife));
        } else if surface_message(message, life.taskbar_created) {
            life.changed.store(true, Ordering::Release);
        }
        DefSubclassProc(window, message, w, l)
    }

    // 子类化目标只能是本项目自己 runtime 的顶层主窗：现场核 存活/本进程/owner 线程，
    // 外来 HWND 与别的线程的窗一律拒（判据走纯函数 `self_window`，可单测）。
    fn own_top_level<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, Reason> {
        let handle = HWND(window.hwnd().map_err(|_| Reason::Stale)?.0);
        unsafe {
            let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));
            if !self_window(IsWindow(Some(handle)).as_bool(), pid, thread, std::process::id(), GetCurrentThreadId()) { return Err(Reason::Stale); }
            Ok(handle)
        }
    }
    // 顶层观察窗的子类化：目标在调用表达式里由 self::own_top_level 当场复核；装不上就把 ref_data 收回来。
    fn observe_with<R: Runtime>(window: &WebviewWindow<R>, id: usize, data: usize) -> Result<bool, Reason> {
        Ok(unsafe { windows::Win32::UI::Shell::SetWindowSubclass(self::own_top_level(window)?, Some(lyrics_proc), id, data).as_bool() })
    }
    // 歌词宿主窗的子类化：目标在调用表达式里由 ensure_own 当场核 代次/线程/自进程/活性。
    fn subclass_own(policy: &EmbedState, own: OwnWindow, id: usize, data: usize) -> Result<bool, Reason> {
        Ok(unsafe { windows::Win32::UI::Shell::SetWindowSubclass(self::ensure_own(policy, own)?, Some(lyrics_proc), id, data).as_bool() })
    }

    // Only the current own top-level main observes broadcasts; it never receives lyrics style/geometry writes.
    pub fn observe_main<R: Runtime>(app: &AppHandle<R>) -> Result<(), Reason> {
        let main = app.get_webview_window(crate::MAIN_WINDOW_LABEL).ok_or(Reason::Stale)?;
        unsafe {
            let taskbar_created=RegisterWindowMessageW(w!("TaskbarCreated"));
            if taskbar_created==0 { return Err(Reason::ShellUnavailable); }
            let host=app.state::<Host>();
            let data=Box::into_raw(Box::new(NativeLife { alive: std::sync::Arc::new(AtomicBool::new(true)), changed: host.changed.clone(), taskbar_created }));
            if !matches!(observe_with(&main, usize::MAX, data as usize), Ok(true)) { drop(Box::from_raw(data)); return Err(Reason::Stale); }
        }
        Ok(())
    }

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(|p| p.into_inner()) }
    fn hwnd(value: isize) -> HWND { HWND(value as *mut _) }
    fn pixel(rect: RECT) -> Result<PixelRect, Reason> {
        let r = PixelRect { x: rect.left, y: rect.top, width: rect.right.checked_sub(rect.left).ok_or(Reason::Stale)?, height: rect.bottom.checked_sub(rect.top).ok_or(Reason::Stale)? };
        if r.valid() { Ok(r) } else { Err(Reason::Stale) }
    }
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    fn identity(handle: HWND) -> Result<WindowIdentity, Reason> {
        // Read-only borrowed HWND; all out pointers refer to live stack buffers.
        unsafe {
            if !IsWindow(Some(handle)).as_bool() { return Err(Reason::ShellUnavailable); }
            let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));
            let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| Reason::AccessDenied)?);
            let (mut start, mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            GetProcessTimes(process.0, &mut start, &mut exit, &mut kernel, &mut user).map_err(|_| Reason::ShellUnavailable)?;
            Ok(WindowIdentity { handle: handle.0 as isize, pid, thread, process_started: (u64::from(start.dwHighDateTime) << 32) | u64::from(start.dwLowDateTime) })
        }
    }
    fn integrity(process: HANDLE) -> Result<u32, Reason> {
        // Token buffer is usize-aligned; SID remains inside it until the final RID is copied.
        unsafe {
            let mut token = HANDLE::default(); OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|_| Reason::AccessDenied)?;
            let token = OwnedHandle(token); let mut bytes = 0;
            let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut bytes);
            if bytes < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 || bytes > 65536 { return Err(Reason::AccessDenied); }
            let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
            GetTokenInformation(token.0, TokenIntegrityLevel, Some(buffer.as_mut_ptr().cast()), bytes, &mut bytes).map_err(|_| Reason::AccessDenied)?;
            let label = &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
            if !IsValidSid(label.Label.Sid).as_bool() { return Err(Reason::AccessDenied); }
            let count = *GetSidSubAuthorityCount(label.Label.Sid);
            if count == 0 { return Err(Reason::AccessDenied); }
            Ok(*GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)))
        }
    }
    fn class(handle: HWND) -> String {
        let mut buffer = [0u16; 256];
        // Borrowed HWND; GetClassNameW writes at most the supplied stack slice.
        let count = unsafe { GetClassNameW(handle, &mut buffer) }.max(0) as usize;
        String::from_utf16_lossy(&buffer[..count])
    }
    fn shell_owner() -> Result<WindowIdentity, Reason> {
        unsafe {
            let shell = identity(GetShellWindow())?;
            let process = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, shell.pid).map_err(|_| Reason::AccessDenied)?);
            let mut name = [0u16; 32768]; let mut len = name.len() as u32;
            QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(name.as_mut_ptr()), &mut len).map_err(|_| Reason::AccessDenied)?;
            let path = String::from_utf16_lossy(&name[..len as usize]);
            let expected = std::env::var("WINDIR").map_err(|_| Reason::ShellUnavailable)? + "\\explorer.exe";
            if !path.eq_ignore_ascii_case(&expected) { return Err(Reason::ShellUnavailable); }
            let our_level = integrity(GetCurrentProcess())?; let shell_level = integrity(process.0)?;
            if our_level < 8192 || our_level != shell_level { return Err(Reason::AccessDenied); }
            Ok(shell)
        }
    }
    fn client_screen(handle: HWND) -> Result<PixelRect, Reason> {
        unsafe {
            let mut rect = RECT::default(); GetClientRect(handle, &mut rect).map_err(|_| Reason::Stale)?;
            let mut points = [POINT { x: rect.left, y: rect.top }, POINT { x: rect.right, y: rect.bottom }];
            SetLastError(WIN32_ERROR(0)); let mapped = MapWindowPoints(Some(handle), None, &mut points);
            if mapped == 0 && GetLastError().0 != 0 { return Err(Reason::Stale); }
            pixel(RECT { left: points[0].x, top: points[0].y, right: points[1].x, bottom: points[1].y })
        }
    }
    pub fn probe(own: OwnWindow, target_monitor: isize) -> Result<TargetSnapshot, Reason> {
        // All HWNDs are borrowed. Explorer is only queried, never styled/resized/messaged.
        unsafe {
            let shell = shell_owner()?;
            let primary = FindWindowW(w!("Shell_TrayWnd"), None).map_err(|_| Reason::ShellUnavailable)?;
            let mut roots = vec![primary]; let mut previous = None;
            for _ in 0..32 {
                let Ok(root) = FindWindowExW(None, previous, w!("Shell_SecondaryTrayWnd"), None) else { break; };
                roots.push(root); previous = Some(root);
            }
            for root in roots {
                let root_id = identity(root)?;
                if root_id.pid != shell.pid || root_id.process_started != shell.process_started || !matches!(class(root).as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") || !IsWindowVisible(root).as_bool() { continue; }
                let monitor = MonitorFromWindow(root, MONITOR_DEFAULTTONEAREST);
                if monitor.0 as isize != target_monitor { continue; }
                let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                if !GetMonitorInfoW(monitor, &mut info).as_bool() { return Err(Reason::ShellUnavailable); }
                let mut appbar = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: root, rc: info.rcMonitor, ..Default::default() };
                if SHAppBarMessage(ABM_GETSTATE, &mut appbar) & ABS_AUTOHIDE as usize != 0 { return Err(Reason::AutoHide); }
                for edge in 0..4 { appbar.uEdge = edge; if SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut appbar) != 0 { return Err(Reason::AutoHide); } }
                let xaml_taskbar = FindWindowExW(Some(root), None, w!("Windows.UI.Input.InputSite.WindowClass"), None).is_ok();
                let parent = if xaml_taskbar { root } else {
                    FindWindowExW(Some(root), None, w!("ReBarWindow32"), None).ok()
                        .or_else(|| FindWindowExW(Some(root), None, w!("WorkerW"), None).ok()).unwrap_or(root)
                };
                let parent_id = identity(parent)?;
                if parent_id.pid != root_id.pid || (parent != root && GetAncestor(parent, GA_ROOT) != root) { return Err(Reason::ShellUnavailable); }
                let context = GetWindowDpiAwarenessContext(parent); let own_context = GetWindowDpiAwarenessContext(hwnd(own.handle));
                if context.0.is_null() || own_context.0.is_null() || !AreDpiAwarenessContextsEqual(context, own_context).as_bool() || !AreDpiAwarenessContextsEqual(context, GetThreadDpiAwarenessContext()).as_bool() { return Err(Reason::DpiMismatch); }
                let dpi = GetDpiForWindow(parent); if dpi == 0 { return Err(Reason::DpiMismatch); }
                return Ok(TargetSnapshot { shell: root_id, parent: parent_id, client_screen: client_screen(parent)?, monitor: target_monitor, monitor_rect: pixel(info.rcMonitor)?, dpi, dpi_context: context.0 as isize });
            }
            Err(Reason::ShellUnavailable)
        }
    }

    struct ComGuard(PhantomData<Rc<()>>);
    impl Drop for ComGuard { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
    fn read_occupied(query: &Query) -> Result<Vec<PixelRect>, Reason> {
        // Interfaces/COM guard are created and dropped on this sole MTA thread; only DTOs escape.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|_| Reason::UiaUnknown)?;
            let _guard = ComGuard(PhantomData);
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|_| Reason::UiaUnknown)?;
            let root = uia.ElementFromHandle(hwnd(query.target.shell.handle)).map_err(|_| Reason::UiaUnknown)?;
            let mut occupied = Vec::new(); let mut budget = 512;
            walk_uia(&uia, &root, query, 0, &mut budget, &mut occupied)?;
            if occupied.is_empty() { Err(Reason::UiaUnknown) } else { Ok(occupied) }
        }
    }
    // Borrowed interfaces remain on their MTA; children are dropped before their COM guard.
    // HWND values here are read-only and never establish write authority.
    unsafe fn walk_uia(uia: &IUIAutomation, node: &IUIAutomationElement, query: &Query, depth: usize, budget: &mut usize, occupied: &mut Vec<PixelRect>) -> Result<(), Reason> {
        if depth > 16 || *budget == 0 { return Err(Reason::UiaUnknown); } *budget -= 1;
        let pid = node.CurrentProcessId().map_err(|_| Reason::UiaUnknown)? as u32;
        let native = node.CurrentNativeWindowHandle().map_err(|_| Reason::UiaUnknown)?;
        if pid == query.own.pid && (native.0 as isize == query.own.handle || IsChild(hwnd(query.own.handle), native).as_bool()) { return Ok(()); }
        if node.CurrentIsOffscreen().map_err(|_| Reason::UiaUnknown)?.as_bool() { return Ok(()); }
        let bounds = node.CurrentBoundingRectangle().map_err(|_| Reason::UiaUnknown)?;
        let class = node.CurrentClassName().map_err(|_| Reason::UiaUnknown)?.to_string();
        let kind = node.CurrentControlType().map_err(|_| Reason::UiaUnknown)?.0;
        let container = uia_container(&class, kind, pid == query.target.shell.pid, depth == 0);
        if !container {
            let rect = pixel(bounds).map_err(|_| Reason::UiaUnknown)?;
            if rect.intersects(query.target.client_screen) { occupied.push(rect); }
            // Unknown nodes are reserved as a whole; task-list containers are deliberately not opened.
            return Ok(());
        }
        if depth != 0 && !matches!(kind, 50033 | 50025 | 50032) { return Err(Reason::UiaUnknown); }
        let condition = uia.CreateTrueCondition().map_err(|_| Reason::UiaUnknown)?;
        let children = node.FindAll(TreeScope_Children, &condition).map_err(|_| Reason::UiaUnknown)?;
        let length = children.Length().map_err(|_| Reason::UiaUnknown)?;
        if length == 0 { return Err(Reason::UiaUnknown); }
        for index in 0..length { walk_uia(uia, &children.GetElement(index).map_err(|_| Reason::UiaUnknown)?, query, depth + 1, budget, occupied)?; }
        Ok(())
    }

    #[derive(Clone, Copy)]
    struct Saved { own: OwnWindow, parent: isize, style: isize, exstyle: isize, rect: PixelRect }
    struct Inner {
        policy: EmbedState, resources: std::sync::Arc<GenerationResources<Saved>>, ready: NativeReadiness, reason: Reason,
        attached: bool, rebuilding: bool, target_monitor: isize,
        results: mpsc::Receiver<(Query, Result<Vec<PixelRect>, Reason>)>,
    }
    pub struct Host {
        inner: Mutex<Inner>, resources: std::sync::Arc<GenerationResources<Saved>>, sender: mpsc::SyncSender<Query>, origin: Instant,
        stopped: AtomicBool, pending: AtomicBool, changed: std::sync::Arc<AtomicBool>, pub barrier: Mutex<ExitBarrier>,
    }
    impl Default for Host {
        fn default() -> Self {
            let (sender, requests) = mpsc::sync_channel::<Query>(1);
            let (results, receiver) = mpsc::channel();
            let spawned = std::thread::Builder::new().name("lyrics-uia-mta".into()).spawn(move || {
                while let Ok(query) = requests.recv() { let answer = read_occupied(&query); if results.send((query, answer)).is_err() { break; } }
            });
            let resources = std::sync::Arc::new(GenerationResources::default());
            Self { inner: Mutex::new(Inner { policy: EmbedState::default(), resources: resources.clone(), ready: NativeReadiness::default(), reason: if spawned.is_ok() { Reason::Disabled } else { Reason::UiaUnknown }, attached: false, rebuilding: false, target_monitor: 0, results: receiver }), resources, sender, origin: Instant::now(), stopped: AtomicBool::new(false), pending: AtomicBool::new(false), changed: std::sync::Arc::new(AtomicBool::new(false)), barrier: Mutex::new(ExitBarrier::default()) }
        }
    }
    impl Host {
        pub fn now(&self) -> u64 { self.origin.elapsed().as_millis().min(u128::from(u64::MAX)) as u64 }
        pub fn payload(&self) -> Value { let i = lock(&self.inner); i.reason.payload(i.attached) }
        pub fn live(&self) -> Option<OwnWindow> { lock(&self.inner).policy.live() }
        /// 窄只读出口：**已 revoke 但仍活着**的旧代次（没有就 `None`）。
        ///
        /// 撤销态只影响探测/显示/摆位（`live`/`saved` 故意保留，好让同一代次重试
        /// restore/detach）。所以"这扇窗还是不是那个被禁用的旧 HWND"只能问宿主：
        /// 桌面重开必须据此改走受控销毁 + 新建代次，而不是 reload/show 旧窗。
        /// 顺手消费迟到的 Destroyed 记账，免得拿一扇已经销毁的代次去重建。
        pub fn revoked_live(&self) -> Option<OwnWindow> {
            let mut i = lock(&self.inner);
            self.consume_destroyed(&mut i);
            i.policy.revoked().and_then(|_| i.policy.live())
        }
        pub fn failed(&self, reason: Reason) { let mut i = lock(&self.inner); i.policy.fail(reason); i.reason = reason; i.attached = false; }
        /// 失败关闭出口（窄接口）：切出 taskbar / restore 失败时，旧宿主立即进入 detached、
        /// 禁探测、隐藏；`live` 与 saved 保留给同一有效代次重试 restore。
        /// 第一个原因胜出：detach 已记下更精确的原因时，后续兜底不覆盖它。
        pub fn revoke(&self, reason: Reason) {
            let mut i = lock(&self.inner);
            let reason = i.policy.revoked().unwrap_or(reason);
            if let Some(own) = i.policy.live() { let _ = hide(&i.policy, own); }
            i.policy.revoke(reason); i.reason = reason; i.attached = false; i.rebuilding = false;
        }
        pub fn destroyed(&self, generation: u64) {
            self.resources.destroyed(generation);
            lock(&self.barrier).destroyed(generation);
        }
        fn consume_destroyed(&self, i: &mut Inner) {
            let dead = self.resources.dead_through();
            i.ready.destroyed(dead);
            if let Some(own) = i.policy.live().filter(|own| own.generation <= dead) {
                i.policy.destroyed(own); i.attached = false; i.rebuilding = false;
            }
            i.policy.dead_through = i.policy.dead_through.max(dead);
        }
        pub fn ready(&self, generation: u64) { let mut i = lock(&self.inner); i.ready.acknowledge(generation); }
        pub fn register<R: Runtime>(&self, window: &WebviewWindow<R>, generation: u64, enabled: bool, requested: bool, monitor: isize) -> Result<(), Reason> {
            let handle = HWND(window.hwnd().map_err(|_| Reason::AttachFailed)?.0);
            unsafe {
                let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));
                if pid != std::process::id() || thread != GetCurrentThreadId() { return Err(Reason::AttachFailed); }
                let own = OwnWindow { handle: handle.0 as isize, generation, pid, thread };
                let mut i = lock(&self.inner);
                self.consume_destroyed(&mut i);
                if generation <= i.policy.dead_through || i.policy.live().is_some_and(|o| o.generation >= generation) { return Err(Reason::Stale); }
                let taskbar_created = RegisterWindowMessageW(w!("TaskbarCreated"));
                if taskbar_created == 0 { return Err(Reason::AttachFailed); }
                let alive = std::sync::Arc::new(AtomicBool::new(true));
                let data = Box::into_raw(Box::new(NativeLife { alive: alive.clone(), changed: self.changed.clone(), taskbar_created }));
                // 先登记代次再装子类：这样子类化调用的目标参数本身就能由 ensure_own 当场复核
                // （代次/线程/自进程/活性四项），而不是靠前面那次 PID 检查。装不上就地撤销这次登记，
                // 绝不留"有写资格却没有 liveness 观察"的活代次。
                i.policy.register(own); i.policy.native_alive = Some(alive);
                let installed = subclass_own(&i.policy, own, generation as usize, data as usize);
                if !matches!(installed, Ok(true)) {
                    let reason = installed.err().unwrap_or(Reason::AttachFailed);
                    drop(Box::from_raw(data)); i.policy.native_alive = None; i.policy.destroyed(own);
                    return Err(reason);
                }
                self.resources.register(own); i.policy.attachment = None;
                i.policy.request(enabled, requested); i.target_monitor = monitor; i.rebuilding = false; i.attached = false; i.reason = if enabled && requested { Reason::Waiting } else { Reason::Disabled };
            }
            Ok(())
        }
        pub fn request(&self, enabled: bool, requested: bool, monitor: isize) {
            let mut i = lock(&self.inner); i.policy.request(enabled, requested); i.target_monitor = monitor;
            if let Some(reason) = i.policy.revoked() { i.attached = false; i.reason = reason; return; }
            if enabled && requested && i.reason == Reason::Disabled { i.reason = Reason::Waiting; }
            if !enabled || !requested { if let Some(own) = i.policy.live() { let _ = hide(&i.policy, own); } i.attached = false; i.reason = Reason::Disabled; }
        }
        pub fn detach<R: Runtime>(&self, window: &WebviewWindow<R>, generation: u64) -> Result<(), Reason> {
            let mut i = lock(&self.inner);
            self.consume_destroyed(&mut i);
            let Some(own) = i.policy.live().filter(|o| o.generation == generation) else {
                if generation <= i.policy.dead_through { return Ok(()); }
                return Err(Reason::Stale);
            };
            // 从这里开始任何失败都必须失败关闭：旧宿主不能再被探测或显示。
            let restored = self::ensure_own(&i.policy, own).and_then(|_| match i.resources.saved_for(own) {
                Some(saved) => restore(&i.policy, saved),
                None => hide(&i.policy, own),
            });
            if let Err(reason) = finish_detach(&mut i.policy, own, restored) {
                i.reason = reason; i.attached = false; i.rebuilding = false;
                return Err(reason);
            }
            // 走到这里隐藏 + restore 都已成功，旧的恢复信息才允许收掉。
            i.resources.clear_saved(own);
            i.attached = false; i.ready.destroyed(generation);
            // Drop our mutex before dispatching destroy: Destroyed may be delivered synchronously.
            drop(i);
            if window.destroy().is_err() {
                // 销毁没送到：旧宿主仍是活动窗口，不能再被探测/显示。
                self.revoke(Reason::DestroyFailed);
                return Err(Reason::DestroyFailed);
            }
            Ok(())
        }
        pub fn shutdown(&self) { self.stopped.store(true, Ordering::Release); let mut i = lock(&self.inner); i.policy.request(false, false); }
        pub fn start<R: Runtime>(app: &AppHandle<R>) {
            let app = app.clone();
            let _ = std::thread::Builder::new().name("lyrics-taskbar-clock".into()).spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let Some(host) = app.try_state::<Host>() else { break; };
                if host.stopped.load(Ordering::Acquire) { break; }
                if host.pending.swap(true, Ordering::AcqRel) { continue; }
                let handle = app.clone();
                if app.run_on_main_thread(move || {
                    let Some(host) = handle.try_state::<Host>() else { return; };
                    let before = host.payload(); let rebuild = host.tick(&handle); host.pending.store(false, Ordering::Release);
                    if before != host.payload() { crate::lyrics_window::emit_status(&handle); }
                    if rebuild { crate::lyrics_window::schedule_rebuild(&handle); }
                }).is_err() { host.pending.store(false, Ordering::Release); break; }
            });
        }
        fn tick<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
            let mut i = lock(&self.inner); let now = self.now();
            self.consume_destroyed(&mut i);
            while let Ok((q, answer)) = i.results.try_recv() { i.policy.complete(q, answer, now); }
            if !i.policy.probing() || self.stopped.load(Ordering::Acquire) { return false; }
            let own = i.policy.live().unwrap();
            i.target_monitor = monitor_for(app);
            if self::ensure_own(&i.policy, own).is_err() { i.reason = Reason::Stale; i.attached = false; return false; }
            if self.changed.swap(false, Ordering::AcqRel) {
                let _ = hide(&i.policy, own); i.policy.shell_changed(); i.reason = Reason::Stale; i.attached = false;
                if i.resources.saved_for(own).is_some() && !i.rebuilding { i.rebuilding = true; return true; }
            }
            let target = match probe(own, i.target_monitor) { Ok(t) => t, Err(reason) => { let _ = hide(&i.policy, own); i.policy.fail(reason); i.reason = reason; i.attached = false; return false; } };
            if !i.ready.matches(own.generation) { let _ = hide(&i.policy, own); i.reason = Reason::Waiting; return false; }
            if let Some(q) = i.policy.begin_query(target.clone(), now) {
                if self.sender.try_send(q.clone()).is_err() { i.policy.complete(q, Err(Reason::UiaUnknown), now); }
            }
            match i.policy.plan(&target, now) {
                ApplyPlan::Rebuild => { let _ = hide(&i.policy, own); i.reason = Reason::Stale; i.attached = false; if !i.rebuilding { i.rebuilding = true; return true; } }
                ApplyPlan::Hide(reason) => { let _ = hide(&i.policy, own); i.reason = reason; i.attached = false; }
                ApplyPlan::Place(rect) => {
                    let window = app.get_webview_window(crate::LYRICS_WINDOW_LABEL);
                    let result = attachment_attempt(&mut *i,
                        |i| window.as_ref().ok_or(Reason::AttachFailed).and_then(|w| attach_or_update(i, own, &target, rect, w, self.origin)),
                        |i| { let _ = hide(&i.policy, own); },
                        |i| { if let Some(saved) = i.resources.saved_for(own) { if restore(&i.policy, saved).is_ok() { i.resources.clear_saved(own); } } });
                    match result {
                        Ok(()) => { i.policy.attached(target); i.reason = Reason::Attached; i.attached = true; }
                        Err(reason) => { i.policy.fail(reason); i.reason = reason; i.attached = false; }
                    }
                }
            }
            false
        }
    }
    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> {
        unsafe {
            let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));
            if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) || thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); }
            Ok(handle)
        }
    }
    fn hide(policy: &EmbedState, own: OwnWindow) -> Result<(), Reason> {
        // 隐藏也走同一条写资格核验，且核验就在调用表达式里（不留"先校验再绑别名"的缝）。
        unsafe { let _ = ShowWindow(self::ensure_own(policy, own)?, SW_HIDE); } Ok(())
    }
    unsafe fn get_long(own: HWND, index: WINDOW_LONG_PTR_INDEX) -> Result<isize, Reason> {
        SetLastError(WIN32_ERROR(0)); let value = GetWindowLongPtrW(own, index);
        if value == 0 && GetLastError().0 != 0 { Err(Reason::AttachFailed) } else { Ok(value) }
    }
    unsafe fn set_long(policy: &EmbedState, token: OwnWindow, index: WINDOW_LONG_PTR_INDEX, value: isize) -> Result<(), Reason> {
        SetLastError(WIN32_ERROR(0)); let previous = SetWindowLongPtrW(self::ensure_own(policy, token)?, index, value);
        if previous == 0 && GetLastError().0 != 0 { Err(Reason::AttachFailed) } else { Ok(()) }
    }
    // Saved owns no HWND. Every mutation revalidates the current creation token on the owner UI thread;
    // foreign handles are only read or supplied as the new parent. Stack RECT/POINT buffers never escape.
    fn restore(policy: &EmbedState, saved: Saved) -> Result<(), Reason> {
        let own = self::ensure_own(policy, saved.own)?; hide(policy, saved.own)?;
        unsafe {
            // Style before parent: SetParent(NULL) on a window that still carries WS_CHILD reparents it
            // under the desktop window (GetParent != 0) instead of restoring top-level ownership.
            set_long(policy, saved.own, GWL_STYLE, saved.style & !(WS_VISIBLE.0 as isize))?;
            set_long(policy, saved.own, GWL_EXSTYLE, saved.exstyle)?;
            let _ = SetParent(self::ensure_own(policy, saved.own)?, (saved.parent != 0).then(|| hwnd(saved.parent)));
            if GetParent(own).ok().map(|h| h.0 as isize).unwrap_or(0) != saved.parent { return Err(Reason::AttachFailed); }
            let after = if saved.exstyle & WS_EX_TOPMOST.0 as isize != 0 { HWND_TOPMOST } else { HWND_NOTOPMOST };
            SetWindowPos(self::ensure_own(policy, saved.own)?, Some(after), saved.rect.x, saved.rect.y, saved.rect.width, saved.rect.height, SWP_NOACTIVATE | SWP_FRAMECHANGED).map_err(|_| Reason::AttachFailed)?;
        }
        Ok(())
    }
    fn sync_content<R: Runtime>(policy: &EmbedState, token: OwnWindow, window: &WebviewWindow<R>, wanted: PixelRect) -> Result<(), Reason> {
        self::ensure_own(policy, token)?;
        let webview: &tauri::Webview<R> = window.as_ref();
        webview.set_bounds(tauri::Rect { position: tauri::PhysicalPosition::new(0,0).into(), size: tauri::PhysicalSize::new(wanted.width as u32, wanted.height as u32).into() }).map_err(|_| Reason::AttachFailed)?;
        let completed = std::sync::Arc::new(Mutex::new(None)); let receipt = completed.clone();
        let alive = policy.native_alive.clone().ok_or(Reason::Stale)?;
        // PlatformWebview/controller are borrowed and dropped in this owner-thread callback only.
        // No COM interface escapes; only the completed bounds verification does.
        window.with_webview(move |native| {
            let result = (|| {
                if !alive.load(Ordering::Acquire) || unsafe { GetCurrentThreadId() } != token.thread { return Err(Reason::Stale); }
                let controller = native.controller();
                let mut actual = Default::default();
                unsafe { controller.Bounds(&mut actual) }.map_err(|_| Reason::AttachFailed)?;
                verify_content_bounds(wanted, Ok(PixelRect { x: actual.left, y: actual.top, width: actual.right-actual.left, height: actual.bottom-actual.top }))?;
                let mut container = Default::default();
                unsafe { controller.ParentWindow(&mut container) }.map_err(|_| Reason::AttachFailed)?;
                let handle = HWND(container.0);
                let mut pid=0; let thread=unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) };
                if pid!=token.pid || thread!=token.thread || !unsafe { IsChild(hwnd(token.handle), handle) }.as_bool() { return Err(Reason::Stale); }
                let content = client_screen(handle)?; let root = client_screen(hwnd(token.handle))?;
                verify_content_bounds(PixelRect { x: root.x, y: root.y, width: wanted.width, height: wanted.height }, Ok(content))
            })();
            *lock(&receipt) = Some(result);
        }).map_err(|_| Reason::AttachFailed)?;
        self::ensure_own(policy, token)?;
        let result = lock(&completed).take().unwrap_or(Err(Reason::AttachFailed)); result
    }

    fn prepare_child<R: Runtime>(i: &mut Inner, token: OwnWindow, target: &TargetSnapshot, rect: PixelRect, window: &WebviewWindow<R>) -> Result<(), Reason> {
        let own = self::ensure_own(&i.policy, token)?;
        unsafe {
            if i.resources.saved_for(token).is_none() {
                hide(&i.policy, token)?;
                let mut original = RECT::default(); GetWindowRect(own, &mut original).map_err(|_| Reason::AttachFailed)?;
                let saved = Saved { own: token, parent: GetParent(own).ok().map(|h| h.0 as isize).unwrap_or(0), style: get_long(own, GWL_STYLE)?, exstyle: get_long(own, GWL_EXSTYLE)?, rect: pixel(original)? };
                i.resources.save(token, saved);
                let (style, exstyle) = child_styles(saved.style, saved.exstyle);
                set_long(&i.policy, token, GWL_STYLE, style)?;
                set_long(&i.policy, token, GWL_EXSTYLE, exstyle)?;
                SetWindowPos(self::ensure_own(&i.policy, token)?, Some(HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).map_err(|_| Reason::AttachFailed)?;
                SetLastError(WIN32_ERROR(0)); let _ = SetParent(self::ensure_own(&i.policy, token)?, Some(hwnd(target.parent.handle)));
                if GetParent(own).ok() != Some(hwnd(target.parent.handle)) { return Err(if GetLastError().0 == 5 { Reason::AccessDenied } else { Reason::AttachFailed }); }
            }
            if GetParent(own).ok() != Some(hwnd(target.parent.handle)) { return Err(Reason::Stale); }
            SetWindowPos(self::ensure_own(&i.policy, token)?, None, rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED).map_err(|_| Reason::AttachFailed)?;
            let mut client = RECT::default(); GetClientRect(own, &mut client).map_err(|_| Reason::AttachFailed)?;
            sync_content(&i.policy, token, window, PixelRect { x:0, y:0, width:client.right-client.left, height:client.bottom-client.top })?;
            use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
            let _ = EnableWindow(self::ensure_own(&i.policy, token)?, false);
            if IsWindowEnabled(own).as_bool() { return Err(Reason::AttachFailed); }
            let mut actual = RECT::default(); GetWindowRect(self::ensure_own(&i.policy, token)?, &mut actual).map_err(|_| Reason::AttachFailed)?;
            verify_placement(target, GetParent(own).ok().map(|h| h.0 as isize).unwrap_or(0), rect, pixel(actual)?)?;
        }
        Ok(())
    }
    fn attach_or_update<R: Runtime>(i: &mut Inner, token: OwnWindow, target: &TargetSnapshot, rect: PixelRect, window: &WebviewWindow<R>, origin: Instant) -> Result<(), Reason> {
        if probe(token, i.target_monitor)? != *target { return Err(Reason::Stale); }
        prepare_child(i, token, target, rect, window)?;
        if probe(token, i.target_monitor)? != *target || !matches!(i.policy.plan(target, origin.elapsed().as_millis() as u64), ApplyPlan::Place(_)) { return Err(Reason::Stale); }
        unsafe { let _ = ShowWindow(self::ensure_own(&i.policy, token)?, SW_SHOWNOACTIVATE); }
        if !unsafe { IsWindowVisible(hwnd(token.handle)) }.as_bool() { return Err(Reason::AttachFailed); }
        Ok(())
    }
    #[cfg(test)]
    mod native_tests { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/taskbar_lyrics_native.rs")); }

    pub fn monitor_for<R: Runtime>(app: &AppHandle<R>) -> isize {
        app.get_webview_window(crate::MAIN_WINDOW_LABEL).and_then(|w| w.hwnd().ok()).map(|handle| unsafe { MonitorFromWindow(HWND(handle.0), MONITOR_DEFAULTTONEAREST).0 as isize }).unwrap_or(0)
    }
}

#[cfg(windows)]
pub use native::{Host, monitor_for, observe_main};
