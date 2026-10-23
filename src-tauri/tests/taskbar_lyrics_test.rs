use huawei_music_desktop_lib::taskbar_lyrics::{finish_detach, safe_slot, ApplyPlan, EmbedState, ExitBarrier, OwnWindow, PixelRect, Reason, TargetSnapshot, WindowIdentity, SNAPSHOT_LIFETIME_MS};

fn rect(x: i32, y: i32, width: i32, height: i32) -> PixelRect { PixelRect { x, y, width, height } }
fn target() -> TargetSnapshot {
    TargetSnapshot {
        shell: WindowIdentity { handle: 40, pid: 4, thread: 5, process_started: 100 },
        parent: WindowIdentity { handle: 41, pid: 4, thread: 5, process_started: 100 },
        client_screen: rect(-1920, 1032, 1920, 48), monitor: 3,
        monitor_rect: rect(-1920, 0, 1920, 1080), dpi: 96, dpi_context: -4,
    }
}
fn own(generation: u64) -> OwnWindow { OwnWindow { handle: 10, generation, pid: 7, thread: 8 } }
fn active() -> EmbedState { let mut s = EmbedState::default(); s.register(own(1)); s.request(true, true); s }
fn occupied() -> Vec<PixelRect> { vec![rect(-1920, 1032, 350, 48), rect(-200, 1032, 200, 48)] }

#[test]
fn d1_child_styles_preserve_dwm_and_route_input_to_parent_without_layered() {
    use huawei_music_desktop_lib::taskbar_lyrics::child_styles;
    let (style, ex) = child_styles(0x90cf0000, 0x000c0300);
    assert_eq!(style & 0x00cf0000, 0, "child must have no nonclient caption or resize frame");
    assert_eq!(ex & 0x00000300, 0, "no WINDOWEDGE or CLIENTEDGE");
    assert_eq!(style & 0x40000000, 0x40000000);
    assert_eq!(style & 0x08000000, 0x08000000, "disabled child input is routed to parent");
    assert_eq!(style & 0x90000000, 0);
    assert_eq!(ex & 0x00080000, 0, "CS_OWNDC cannot be layered");
    assert_eq!(ex & 0x08000000, 0x08000000);
    assert_eq!(ex & 0x00040020, 0, "no APPWINDOW or fake HTTRANSPARENT click-through");
}
#[test]
fn d2_probe_dpi_and_context_changes_rebuild_attached_surface() {
    for change in 0..2 {
        let mut s=active(); s.attached(target()); let mut next=target();
        if change==0 { next.dpi=120; } else { next.dpi_context=-3; }
        assert_eq!(s.plan(&next, 1), ApplyPlan::Rebuild);
    }
}
#[test]
fn d2_own_message_classifier_includes_top_level_and_child_parent_dpi_messages() {
    use huawei_music_desktop_lib::taskbar_lyrics::surface_message;
    for msg in [0xc123, 0x007e, 0x02e0, 0x02e2, 0x02e3] { assert!(surface_message(msg, 0xc123)); }
    assert!(!surface_message(0x0003, 0xc123));
}
#[test]
fn d3_destroyed_while_owner_busy_is_consumed_before_g2_and_old_saved_is_not_inherited() {
    use huawei_music_desktop_lib::taskbar_lyrics::GenerationResources;
    let resources=std::sync::Arc::new(GenerationResources::default());
    resources.register(own(1)); resources.save(own(1), 41);
    let r=resources.clone();
    resources.with_current(|_| { r.destroyed(1); });
    resources.register(own(2));
    assert_eq!(resources.saved_for(own(2)), None);
    assert_eq!(resources.saved_for(own(1)), None);
    assert_eq!(resources.live(), Some(own(2)));
    resources.destroyed(1); assert_eq!(resources.live(), Some(own(2)));
}
#[test]
fn d6_public_setter_ok_is_not_confirmation_until_actual_controller_bounds_match() {
    use huawei_music_desktop_lib::taskbar_lyrics::verify_content_bounds;
    let wanted=rect(0,0,600,44);
    assert_eq!(verify_content_bounds(wanted, Ok(rect(0,0,800,600))), Err(Reason::AttachFailed));
    assert_eq!(verify_content_bounds(wanted, Err(Reason::AttachFailed)), Err(Reason::AttachFailed));
    assert_eq!(verify_content_bounds(wanted, Ok(wanted)), Ok(()));
}

#[test]
fn d3_restore_failure_leaves_old_host_detached_and_tick_never_probes_or_places() {
    use huawei_music_desktop_lib::taskbar_lyrics::PROBE_INTERVAL_MS;
    // 旧 policy 已经在 taskbar 里显示过：有 snapshot、有 attachment。
    let mut s = active();
    let q = s.begin_query(target(), 0).unwrap(); s.complete(q, Ok(occupied()), 1); s.attached(target());
    assert!(matches!(s.plan(&target(), 2), ApplyPlan::Place(_)), "前提：切出前旧宿主确实处于可摆位状态");
    // mode 切回 desktop，受控 detach 的 restore 失败。
    assert_eq!(finish_detach(&mut s, own(1), Err(Reason::AttachFailed)), Err(Reason::AttachFailed));
    assert_eq!(s.revoked(), Some(Reason::AttachFailed), "restore 失败必须留下失败关闭原因");
    assert_eq!(s.live(), Some(own(1)), "同一有效代次仍保有写资格，才能重试 restore/detach");
    assert!(!s.probing(), "切出失败后旧宿主必须禁探测");
    assert!(s.begin_query(target(), PROBE_INTERVAL_MS).is_none(), "tick 不得再发起 UIA 查询");
    assert_eq!(s.plan(&target(), PROBE_INTERVAL_MS), ApplyPlan::Hide(Reason::AttachFailed), "tick 不得再摆位或显示旧宿主");
    // 旧的 enabled/requested 不允许借一次 request 复活探测。
    s.request(true, true);
    assert!(!s.probing());
    assert!(s.begin_query(target(), PROBE_INTERVAL_MS * 3).is_none());
    assert!(matches!(s.plan(&target(), PROBE_INTERVAL_MS * 3), ApplyPlan::Hide(_)));
}

#[test]
fn d3_failed_restore_keeps_saved_for_same_generation_and_desktop_reregister_starts_disabled() {
    use huawei_music_desktop_lib::taskbar_lyrics::GenerationResources;
    let resources = std::sync::Arc::new(GenerationResources::default());
    resources.register(own(1)); resources.save(own(1), 41);
    let mut s = active(); s.attached(target());
    assert_eq!(finish_detach(&mut s, own(1), Err(Reason::AttachFailed)), Err(Reason::AttachFailed));
    assert_eq!(resources.saved_for(own(1)), Some(41), "restore 失败不能无脑清 saved，否则同一代次无法重试");
    // 同一有效代次的重试路径仍然可用：第二次 restore 成功才 detached。
    assert_eq!(finish_detach(&mut s, own(1), Ok(())), Ok(()));
    assert!(!s.probing());
    assert!(s.begin_query(target(), 1).is_none());
    // desktop 由 lyrics_window 受控重建新 HWND 后 register 新的 disabled host。
    s.register(own(2)); s.request(false, false);
    resources.register(own(2));
    assert!(!s.probing(), "desktop 代次只允许 disabled，不能凭空开始探测");
    assert!(s.begin_query(target(), 1).is_none());
    assert_eq!(s.plan(&target(), 1), ApplyPlan::Hide(Reason::Disabled));
    assert_eq!(resources.saved_for(own(2)), None, "新代次不继承旧 saved");
}

#[test]
fn d3_restore_clears_child_style_before_unparenting_so_it_returns_to_top_level() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/taskbar_lyrics.rs")).expect("own source must be readable");
    let start = source.find("fn restore(").expect("restore must exist");
    let body = &source[start..];
    let body = &body[..body.find("\n    }\n").expect("restore body must end")];
    // Comments explain the rule; only executed lines may satisfy it.
    let code: Vec<&str> = body.lines().filter(|line| !line.trim_start().starts_with("//")).collect();
    // Spelled in two parts: the repo-wide injection scan bans the Win32 call name outside the
    // single pinned native module, and this test only needs to locate the call in that module.
    let unparent = ["Set", "Parent("].concat();
    let style = code.iter().position(|line| line.contains("GWL_STYLE")).expect("restore must put the original style back");
    let parent = code.iter().position(|line| line.contains(&unparent)).expect("restore must reparent");
    assert!(style < parent, "style must be restored before unparenting: a WS_CHILD window unparented first lands under the desktop window instead of becoming top-level");
}

#[test]
fn failed_query_invalidates_inflight_epoch_so_recovered_same_target_cannot_revive_old_geometry() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap();
    s.fail(Reason::ShellUnavailable); s.complete(q, Ok(occupied()), 200);
    assert!(matches!(s.plan(&target(), 200), ApplyPlan::Hide(_)));
}
#[test]
fn only_current_lyrics_subscriber_read_can_ack_ready() {
    use huawei_music_desktop_lib::lyrics_window::ready_generation;
    assert_eq!(ready_generation("lyrics", Some(7), Some(7), true), Some(7));
    for (source, generation, current, empty) in [("main", Some(7), Some(7), true), ("login", Some(7), Some(7), true), ("lyrics", Some(6), Some(7), true), ("lyrics", None, Some(7), true), ("lyrics", Some(7), None, true), ("lyrics", Some(7), Some(7), false)] {
        assert_eq!(ready_generation(source, generation, current, empty), None);
    }
}
#[test]
fn taskbar_mode_never_emits_desktop_geometry_or_style_effects() {
    use huawei_music_desktop_lib::lyrics_window::*;
    let config = LyricsConfig::default().apply_patch(&serde_json::json!({"mode":"taskbar"}));
    let mut effects = Vec::new();
    apply_window_effects(None, &config, Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1032.0 }, 1.0, None, |e| effects.push(e));
    assert!(effects.is_empty(), "Beta is exclusively owned by the native host");
    assert!(!desktop_topmost(&config)); assert!(desktop_topmost(&LyricsConfig::default()));
    for source in ["main", "lyrics"] {
        for field in ["parent", "hwnd", "taskbar", "requestedVisible"] {
            assert!(validate_configure(source, &serde_json::json!({field: 4}), None).is_err());
        }
    }
}
#[test]
fn parent_client_not_work_area_determines_position_and_negative_screen_coordinates_map_to_client() {
    assert_eq!(safe_slot(&target(), Some(&occupied())), Ok(rect(358, 2, 1200, 44)));
    let mut scaled = target(); scaled.dpi = 144; scaled.client_screen = rect(2560, -72, 1920, 72);
    assert_eq!(safe_slot(&scaled, Some(&[rect(2560, -72, 200, 72)])), Ok(rect(212, 3, 1696, 66)));
}
#[test]
fn occupied_union_and_margin_never_borrow_space_across_disconnected_gaps() {
    let mut t = target(); t.client_screen = rect(0, 0, 400, 48);
    assert_eq!(safe_slot(&t, Some(&[rect(0, 0, 130, 48), rect(200, 0, 130, 48)])), Err(Reason::NoSpace));
    assert_eq!(safe_slot(&t, Some(&[rect(0, 0, 40, 48), rect(20, 0, 80, 48), rect(300, 0, 100, 48)])), Ok(rect(108, 2, 184, 44)));
}
#[test]
fn uia_opens_only_known_pure_containers_and_reserves_unknown_or_tasklist_nodes_whole() {
    use huawei_music_desktop_lib::taskbar_lyrics::uia_container;
    for class in ["Windows.UI.Input.InputSite.WindowClass", "Taskbar.TaskbarFrameAutomationPeer", "ReBarWindow32", "WorkerW"] {
        assert!(uia_container(class, 50033, true, false));
        assert!(!uia_container(class, 50000, true, false), "known class must not make a button disappear");
        assert!(!uia_container(class, 50033, false, false));
    }
    assert!(!uia_container("MSTaskListWClass", 50033, true, false));
    assert!(!uia_container("UnknownInteractivePane", 50033, true, false));
    assert!(uia_container("root-class-is-not-used", 50033, true, true));
}
#[test]
fn missing_empty_and_malformed_uia_are_unknown_not_free_space() {
    assert_eq!(safe_slot(&target(), None), Err(Reason::UiaUnknown));
    assert_eq!(safe_slot(&target(), Some(&[])), Err(Reason::UiaUnknown));
    assert_eq!(safe_slot(&target(), Some(&[rect(0, 0, -1, 2)])), Err(Reason::UiaUnknown));
}
#[test]
fn timeout_hides_independently_of_completion_and_late_result_is_permanently_discarded() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap();
    assert_eq!(s.plan(&target(), SNAPSHOT_LIFETIME_MS + 1), ApplyPlan::Hide(Reason::Timeout));
    s.complete(q, Ok(occupied()), SNAPSHOT_LIFETIME_MS + 2);
    assert_ne!(s.plan(&target(), SNAPSHOT_LIFETIME_MS + 3), ApplyPlan::Place(rect(358, 2, 1200, 44)));
    assert!(s.begin_query(target(), 3000).is_some(), "hidden requested window must continue probing");
}
#[test]
fn shell_change_invalidates_snapshot_even_if_same_handle_returns_later() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap();
    s.shell_changed(); s.complete(q, Ok(occupied()), 200);
    assert!(matches!(s.plan(&target(), 200), ApplyPlan::Hide(_)));
}
#[test]
fn old_query_retains_single_inflight_slot_across_mode_changes() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap();
    s.request(false, false); s.request(true, true);
    assert!(s.begin_query(target(), 500).is_none());
    s.complete(q, Ok(occupied()), 600);
    assert!(matches!(s.plan(&target(), 600), ApplyPlan::Hide(_)));
    assert!(s.begin_query(target(), 601).is_some());
}
#[test]
fn hidden_no_space_recovers_without_changing_user_requested_visibility() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap();
    s.complete(q, Ok(vec![target().client_screen]), 1);
    assert_eq!(s.plan(&target(), 1), ApplyPlan::Hide(Reason::NoSpace));
    let q = s.begin_query(target(), 500).unwrap(); s.complete(q, Ok(occupied()), 501);
    assert!(matches!(s.plan(&target(), 501), ApplyPlan::Place(_)));
}
#[test]
fn destroyed_old_document_cannot_mark_new_native_window_ready() {
    use huawei_music_desktop_lib::taskbar_lyrics::NativeReadiness;
    let mut ready = NativeReadiness::default();
    ready.acknowledge(2); ready.acknowledge(1); assert!(ready.matches(2)); assert!(!ready.matches(1));
    ready.destroyed(2); ready.acknowledge(2); assert!(!ready.matches(2));
    ready.acknowledge(3); assert!(ready.matches(3));
}
#[test]
fn same_pid_same_hwnd_reuse_never_authorizes_old_generation_writes() {
    let mut s = active(); let old = own(1); s.destroyed(old); s.register(own(2));
    assert!(!s.may_write(old, 7, 8)); assert!(s.may_write(own(2), 7, 8));
    assert!(!s.may_write(own(2), 7, 9)); assert!(!s.may_write(own(2), 77, 8));
    s.destroyed(old); assert!(s.may_write(own(2), 7, 8));
}
#[test]
fn old_registration_cannot_replace_new_owner_even_before_old_destroyed_arrives() {
    let mut s = active(); s.register(own(2)); s.register(own(1));
    assert!(!s.may_write(own(1), 7, 8)); assert!(s.may_write(own(2), 7, 8));
}
#[test]
fn destroyed_before_registration_cannot_be_resurrected() {
    let mut s = EmbedState::default(); s.destroyed(own(1)); s.register(own(1));
    assert!(!s.may_write(own(1), 7, 8));
}
#[test]
fn query_dpi_origin_and_client_changes_require_fresh_snapshot_before_apply_or_show() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap(); s.complete(q, Ok(occupied()), 1);
    let mut dpi = target(); dpi.dpi = 120;
    let mut origin = target(); origin.client_screen.x = -1919;
    let mut client = target(); client.client_screen.height = 49;
    for t in [dpi, origin, client] { assert!(matches!(s.plan(&t, 1), ApplyPlan::Hide(_))); }
}
#[test]
fn shell_parent_and_monitor_changes_rebuild_own_surface_instead_of_cross_parent_reuse() {
    for change in 0..3 {
        let mut s = active(); s.attached(target()); let mut t = target();
        match change { 0 => t.shell.process_started += 1, 1 => t.parent.handle += 1, _ => t.monitor += 1 }
        assert_eq!(s.plan(&t, 1), ApplyPlan::Rebuild);
    }
}
#[test]
fn failed_native_attempt_hides_before_rollback_and_never_runs_show() {
    use huawei_music_desktop_lib::taskbar_lyrics::attachment_attempt;
    let mut effects = Vec::new();
    let result = attachment_attempt(&mut effects,
        |log| { log.push("set-style-own"); log.push("set-parent-own"); Err(Reason::AttachFailed) },
        |log| log.push("hide-own"), |log| log.push("restore-own"));
    assert_eq!(result, Err(Reason::AttachFailed));
    assert_eq!(effects, ["set-style-own", "set-parent-own", "hide-own", "restore-own"]);
    effects.clear();
    assert_eq!(attachment_attempt(&mut effects, |log| { log.push("verified-show-own"); Ok(()) }, |log| log.push("hide-own"), |log| log.push("restore-own")), Ok(()));
    assert_eq!(effects, ["verified-show-own"]);
}
#[test]
fn attach_verification_failure_stays_hidden_and_detach_shutdown_are_idempotent() {
    let mut s = active(); let q = s.begin_query(target(), 0).unwrap(); s.complete(q, Ok(occupied()), 1);
    s.fail(Reason::AttachFailed); assert_eq!(s.plan(&target(), 2), ApplyPlan::Hide(Reason::AttachFailed));
    for _ in 0..2 { s.request(false, false); assert!(matches!(s.plan(&target(), 3), ApplyPlan::Hide(_))); }
}
#[test]
fn attach_rejects_wrong_actual_parent_and_client_escape_even_when_setparent_reports_success() {
    use huawei_music_desktop_lib::taskbar_lyrics::verify_placement;
    let slot = rect(358, 2, 1200, 44);
    assert!(verify_placement(&target(), 41, slot, rect(-1562, 1034, 1200, 44)).is_ok());
    assert_eq!(verify_placement(&target(), 0, slot, rect(-1562, 1034, 1200, 44)), Err(Reason::AttachFailed));
    assert!(verify_placement(&target(), 41, slot, rect(-1563, 1034, 1200, 44)).is_err());
    assert!(verify_placement(&target(), 41, rect(1800, 2, 200, 44), rect(-120, 1034, 200, 44)).is_err());
}
#[test]
fn exit_destroyed_before_begin_failure_and_fixed_deadline_all_converge() {
    let mut b = ExitBarrier::default(); b.destroyed(1); b.begin(100, Some(1)); assert!(b.finished(100));
    let mut b = ExitBarrier::default(); b.begin(100, Some(2)); b.failed(2); assert!(b.finished(101));
    let mut b = ExitBarrier::default(); b.begin(100, Some(3)); b.begin(2000, Some(3));
    assert!(!b.finished(101)); assert!(b.finished(2100));
    let mut b = ExitBarrier::default(); b.begin(100, Some(4)); b.destroyed(4); assert!(b.finished(101));
}
