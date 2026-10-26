//! R7 登录窗策略 · 集成测试（**不依赖真 GUI**：策略全部走纯函数）。
//!
//! 为什么这些用例在 `tests/` 而不是 `#[cfg(test)] mod tests`：它们钉的是**登录窗对外契约**
//! （导航白名单、回调原样交付、payload 不回显、partition 路径安全、双期限、结论 take-once、独占），
//! 与 login.rs 内部实现无关；放在集成测试里，将来把策略拆成子模块也不会让钉子失效。
//!
//! 真窗（`tauri dev`）与真实扫码联调**不在本任务范围**，见 task-7-report.md 的 untested 清单。

use std::cell::Cell;
use std::path::Path;
use std::time::Duration;

use huawei_music_desktop_lib::login::{
    abandon_build_data_dir, abandon_build_data_dir_with,
    chrome_navigation_allowed, chrome_rects, deadline_conclusion, deliver_build_result, layout_for,
    layout_target, login_data_dir,
    navigation_for, parse_config, shutdown_failures, BuildDelivery, ClientArea, DiscardableWindow,
    Layout, LoginConclusion, LoginSession, LoginState, Navigation, Rect, ShutdownFailure,
    ShutdownOutcome, CHROME_MARGIN, LOGIN_ALLOWED_ORIGINS,
    LOGIN_ALLOWED_URLS, LOGIN_LOAD_DEADLINE_SECS, LOGIN_LOAD_TIMEOUT_MESSAGE, LOGIN_TIMEOUT_SECS,
    LOGIN_TOTAL_TIMEOUT_MESSAGE, MIN_LOGIN_HEIGHT,
    MIN_LOGIN_WIDTH, PARTITION_MAX_LEN,
};
use serde_json::json;

const AUTHORIZE: &str = "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize?client_id=101444301&state=S";

fn config_of(payload: serde_json::Value) -> huawei_music_desktop_lib::login::LoginConfig {
    parse_config(&payload).expect("这份 payload 应当合法")
}

fn error_of(payload: serde_json::Value) -> huawei_music_desktop_lib::bridge::CoreError {
    parse_config(&payload).expect_err("这份 payload 应当被拒")
}

// ---------------------------------------------------------------------------
// 1. 导航策略：白名单整域 + 精确例外；其余一律 Block（拦下不请求）
// ---------------------------------------------------------------------------

#[test]
fn navigation_allows_only_explicit_whitelist_entries() {
    // 白名单里的整域（含 query/hash/任意路径）
    for allowed in [
        // R32：授权入口换成参考实现实测的 oauth-login.platform.hicloud.com，
        // 令牌域 oauth-login.cloud.huawei.com 同时进白名单（授权域与令牌域是两个主机）
        "https://oauth-login.platform.hicloud.com/oauth2/v3/authorize?client_id=1&state=S",
        "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
        "https://account.huawei.com/",
        "https://consumer.huawei.com/",
        // oauth-login1 只剩 loginCallback 这一条精确例外（扫码路径的 CAS 回调落点）
        "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback?code=C&state=S",
        // R16 增补：授权页把浏览器送到这里（https://id1.cloud.huawei.com:443/CAS/remoteLogin?… 的落地页）。
        // 默认端口 `:443` 在 origin 里被归一化掉，两种写法都要放行。
        "https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?clientID=101444301&state=S",
        "https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html?clientID=101444301",
    ] {
        assert_eq!(navigation_for(allowed), Navigation::Allow, "白名单条目必须放行：{allowed}");
    }

    // oauth-login1 的**整域**已经不放行了（R32 降级为精确例外）：授权页那个路径现在必须被拦
    for blocked in [
        "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize",
        "https://oauth-login1.cloud.huawei.com/oauth2/v2/loginCallback?code=C",
        // R32 移出的旧 CAS 域（参考清单里没有它）
        "https://login.cloud.huawei.com/",
        "https://login.cloud.huawei.com/sso/index.html?x=1#frag",
    ] {
        assert_eq!(navigation_for(blocked), Navigation::Block, "不在白名单里就必须拦下：{blocked}");
    }

    // 同形攻击面 + 降级 + 其它 scheme：一律 Block
    for blocked in [
        "https://oauth-login.platform.hicloud.com.attacker.invalid/oauth2/v3/authorize",
        "https://account.huawei.com.attacker.invalid/",
        "https://oauth-login2.cloud.huawei.com/oauth2/v3/authorize",
        // id1 的同形/子域同样不许放行（白名单是显式条目，不是后缀通配）
        "https://id1.cloud.huawei.com.attacker.invalid/CAS/portal/loginAuth.html",
        "https://evil-id1.cloud.huawei.com/CAS/portal/loginAuth.html",
        "https://id1.cloud.huawei.com:8443/CAS/portal/loginAuth.html",
        "http://id1.cloud.huawei.com/CAS/portal/loginAuth.html",
        "https://huawei.com.evil.com/",
        "https://evil-huawei.com/",
        "https://user:pass@oauth-login.platform.hicloud.com/oauth2/v3/authorize",
        "https://user@oauth-login.platform.hicloud.com/oauth2/v3/authorize",
        "https://oauth-login.platform.hicloud.com:8443/oauth2/v3/authorize",
        "http://oauth-login.platform.hicloud.com/oauth2/v3/authorize",
        "http://oauth-login.cloud.huawei.com/oauth2/v3/token",
        "javascript:alert(1)",
        "data:text/html,<b>x</b>",
        "about:blank",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        "不是 URL",
        "",
        "   ",
    ] {
        assert_eq!(navigation_for(blocked), Navigation::Block, "必须拦下：{blocked}");
    }

    // 白名单是**显式条目**，不是后缀通配：这一条钉的就是"别改成 endsWith(huawei.com)"
    // R32 起是五条（参考 LOGIN_HOSTS 的五个主机）+ 一条 loginCallback 精确例外
    assert_eq!(LOGIN_ALLOWED_ORIGINS.len(), 5);
    assert_eq!(LOGIN_ALLOWED_URLS.len(), 1);
}

// ---------------------------------------------------------------------------
// 2. 回调：hms:// 一律拦下，并把**原样** URL 交给等待方（不解析、不改写）
// ---------------------------------------------------------------------------

#[test]
fn navigation_hands_back_hms_urls_verbatim() {
    for (raw, expected) in [
        (
            "hms://redirect_uri?code=CODE-1&state=STATE-1",
            "hms://redirect_uri?code=CODE-1&state=STATE-1",
        ),
        // 大小写、空路径、尾斜杠、其它 authority：原样交付，判真伪是 Node 侧 isCallback 的事
        ("HMS://REDIRECT_URI?code=C", "HMS://REDIRECT_URI?code=C"),
        ("hms://redirect_uri", "hms://redirect_uri"),
        ("hms://redirect_uri/", "hms://redirect_uri/"),
        (
            "hms://redirect_uri?error=access_denied&state=S",
            "hms://redirect_uri?error=access_denied&state=S",
        ),
        ("hms://other/path?code=C", "hms://other/path?code=C"),
    ] {
        match navigation_for(raw) {
            // 交付原样 ≠ Allow：拦下（false）时 URL 必须与进入时逐字节相同
            Navigation::Callback(handed) => assert_eq!(handed, expected, "回调必须原样交出：{raw}"),
            other => panic!("hms:// 必须被拦下并交出原 URL，实际 {other:?}：{raw}"),
        }
    }
}

// ---------------------------------------------------------------------------
// 3. payload 校验：坏形态一律结构化错误，且**不回显 url/partition 原文**
// ---------------------------------------------------------------------------

#[test]
fn parse_config_rejects_bad_payloads_without_echoing_them() {
    let secrets = "CODE-SECRET-42";

    // url 非 https / 不在白名单 / 解析不了 —— 错误里不得出现 url 原文（旧仓缺陷：错误回显整段 URL）
    let bad_urls = vec![
        "http://oauth-login1.cloud.huawei.com/oauth2/v3/authorize".to_string(),
        "https://oauth-login1.cloud.huawei.com.attacker.invalid/oauth2/v3/authorize".to_string(),
        format!("https://evil.invalid/authorize?code={secrets}"),
        format!("不是 URL?code={secrets}"),
        String::new(),
    ];
    for bad_url in bad_urls {
        let error = error_of(json!({"url": bad_url.clone(), "partition": "p1"}));
        assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "url={bad_url}");
        assert!(!error.message.contains(secrets), "错误里回显了 url 里的敏感参数：{}", error.message);
        assert!(
            !error.message.contains("evil.invalid") && !error.message.contains("attacker.invalid"),
            "错误里回显了 url 主机：{}",
            error.message
        );
    }

    // R25：`topInset` 已从载荷里退休——多给的字段**不是错误**（前向兼容：老调用方多传一个键
    // 不该让登录起不来），但它也不改变任何几何（登录页铺满整窗，见 §8）。
    let config = config_of(json!({"url": AUTHORIZE, "partition": "p1", "topInset": 48}));
    assert_eq!(config.url, AUTHORIZE);
    assert_eq!(config.partition, "p1");

    // partition：路径穿越与非法字符必须在进入文件系统之前被拒
    let too_long = "x".repeat(PARTITION_MAX_LEN + 1);
    for bad_partition in [
        "../main",
        "..",
        "a/b",
        "a\\b",
        "a.b",
        "%2e%2e",
        "p 1",
        "登录",
        "",
        too_long.as_str(),
    ] {
        let error = error_of(json!({"url": AUTHORIZE, "partition": bad_partition}));
        assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "partition={bad_partition:?}");
        assert!(error.message.contains("partition"), "应指明是哪个字段：{}", error.message);
        // 不复述调用方给的写法（尤其路径穿越那几种）；范围文本里的 "1..=64" 是规则说明，不算复述
        for leak in ["main", "%2e", "\\", "xxxx"] {
            assert!(!error.message.contains(leak), "错误里复述了入参写法：{}", error.message);
        }
    }

    // 形状不对（非对象 / 缺字段）
    for payload in [json!(null), json!([]), json!({"url": AUTHORIZE}), json!({})] {
        let error = error_of(payload.clone());
        assert_eq!(error.kind.as_deref(), Some("invalid_payload"), "payload={payload}");
    }
}

#[test]
fn parse_config_accepts_the_documented_shape() {
    let config = config_of(json!({"url": AUTHORIZE, "partition": "aB0_-Z9"}));
    assert_eq!(config.url, AUTHORIZE);
    assert_eq!(config.partition, "aB0_-Z9");

    // 回调 URL 不是合法入参（登录窗只铺官方授权页）
    let error = error_of(json!({"url": "hms://redirect_uri?code=C", "partition": "p"}));
    assert_eq!(error.kind.as_deref(), Some("invalid_payload"));
}

// ---------------------------------------------------------------------------
// 4. partition → 数据目录：必须落在数据根之下，且只有一层（路径安全）
// ---------------------------------------------------------------------------

#[test]
fn login_data_dir_stays_under_the_data_root() {
    let root = if cfg!(windows) {
        Path::new("C:\\Users\\tester\\AppData\\Roaming\\hwmusic")
    } else {
        Path::new("/home/tester/.local/share/hwmusic")
    };
    let long_partition = "x".repeat(PARTITION_MAX_LEN);

    for partition in ["p1", "aB0_-Z9", long_partition.as_str()] {
        // 只有过了 parse_config 的 partition 才会走到这里（校验面与建目录面是同一道门）
        config_of(json!({"url": AUTHORIZE, "partition": partition}));
        let dir = login_data_dir(root, partition);
        assert!(dir.starts_with(root), "登录数据目录必须落在数据根之下：{dir:?}");
        assert!(dir.ends_with(partition), "目录名就是 partition：{dir:?}");
        assert_eq!(
            dir.components().count(),
            root.components().count() + 3,
            "webview2/login/<partition> 恰好三层：{dir:?}"
        );
        assert!(
            !dir.to_string_lossy().contains(".."),
            "合法 partition 拼不出上跳路径：{dir:?}"
        );
    }

    // 每个 partition 各自独立（随机一次性隔离的意义所在）
    assert_ne!(login_data_dir(root, "p1"), login_data_dir(root, "p2"));
}

// ---------------------------------------------------------------------------
// 5. 双期限：首载 30 秒独立成一条结论，总期限 10 分钟；两条文案必须不同
// ---------------------------------------------------------------------------

#[test]
fn deadline_conclusion_arms_load_deadline_independently_of_total_deadline() {
    let load = Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS);
    let total = Duration::from_secs(LOGIN_TIMEOUT_SECS);

    // 首载未完成：30 秒前继续等，30 秒起判「打不开官方页」
    assert_eq!(deadline_conclusion(load - Duration::from_millis(1), false), None);
    match deadline_conclusion(load, false) {
        Some(LoginConclusion::LoadFailed { message }) => assert_eq!(message, LOGIN_LOAD_TIMEOUT_MESSAGE),
        other => panic!("首载超时必须给出独立的失败结论，实际 {other:?}"),
    }

    // 首载完成：首载期限解除，只等总期限
    assert_eq!(deadline_conclusion(load, true), None);
    assert_eq!(deadline_conclusion(total - Duration::from_secs(1), true), None);

    // 总期限对两种状态都成立（首载完成也要有终点）
    assert_eq!(deadline_conclusion(total, true), Some(LoginConclusion::TimedOut));
    assert_eq!(deadline_conclusion(total, false), Some(LoginConclusion::TimedOut));

    // 两条文案必须不同：用户看到"打不开官方页"和"扫码超时"是两件事（处置方式也不同）
    assert_ne!(LOGIN_LOAD_TIMEOUT_MESSAGE, LOGIN_TOTAL_TIMEOUT_MESSAGE);
    assert!(LOGIN_LOAD_TIMEOUT_MESSAGE.contains("登录页面"), "{}", LOGIN_LOAD_TIMEOUT_MESSAGE);
    assert!(LOGIN_TOTAL_TIMEOUT_MESSAGE.contains("超时"), "{}", LOGIN_TOTAL_TIMEOUT_MESSAGE);

    // 期限常量本身：10 分钟 / 30 秒（与 Node LOGIN_TIMEOUT_MS 由 login-parity 互钉）
    assert_eq!(LOGIN_TIMEOUT_SECS, 600);
    assert_eq!(LOGIN_LOAD_DEADLINE_SECS, 30);
    assert!(Duration::from_secs(LOGIN_LOAD_DEADLINE_SECS) < Duration::from_secs(LOGIN_TIMEOUT_SECS));
}

// ---------------------------------------------------------------------------
// 6. 结论槽 take-once：多个来源（导航/关窗/取消/计时器）谁先到谁算，后续一律不改写
// ---------------------------------------------------------------------------

#[test]
fn conclusion_slot_is_take_once() {
    let session = LoginSession::new();
    assert_eq!(session.conclusion(), None);

    // 双来源的老缺陷（C1）：导航拦截与窗口关闭各写一次 → 必须是"先到者胜"，不是互相覆盖
    assert!(session.settle(LoginConclusion::Callback {
        url: "hms://redirect_uri?code=C&state=S".to_string()
    }));
    assert!(!session.settle(LoginConclusion::Closed), "已结算后不得改写结论");
    assert!(!session.settle(LoginConclusion::Cancelled));
    assert_eq!(
        session.conclusion(),
        Some(LoginConclusion::Callback {
            url: "hms://redirect_uri?code=C&state=S".to_string()
        }),
        "先到的结论必须保持原样（后到的不得覆盖）"
    );

    // 取走语义：结论只被读，不被"取走即删除"（等待方与关窗路径都要能看到同一结论）
    assert!(session.conclusion().is_some());

    // 载荷形状（Node huawei.ts 按 status 分支）
    assert_eq!(session.conclusion().unwrap().to_payload()["status"], json!("callback"));
    assert_eq!(LoginConclusion::Cancelled.to_payload()["status"], json!("cancelled"));
    assert_eq!(LoginConclusion::Closed.to_payload()["status"], json!("closed"));
    assert_eq!(LoginConclusion::TimedOut.to_payload()["status"], json!("timed_out"));
    assert_eq!(
        LoginConclusion::TimedOut.to_payload()["message"],
        json!(LOGIN_TOTAL_TIMEOUT_MESSAGE),
        "总超时文案随结论一起交给 Node（两侧同一句话，parity 互钉）"
    );
    assert_eq!(
        LoginConclusion::LoadFailed {
            message: LOGIN_LOAD_TIMEOUT_MESSAGE.to_string()
        }
        .to_payload()["status"],
        json!("load_failed")
    );
}

#[test]
fn session_wait_returns_the_conclusion_and_never_stalls_on_a_settled_slot() {
    let session = LoginSession::new();
    // 先结算再等：立刻拿到，不睡满超时
    session.settle(LoginConclusion::Cancelled);
    let started = std::time::Instant::now();
    assert_eq!(session.wait(Duration::from_secs(5)), Some(LoginConclusion::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(1), "已结算的槽必须立刻返回");

    // 未结算：到点返回 None（由调用方用 deadline_conclusion 定夺），不永久挂住。
    //
    // 这里断言的是**超时路径的返回语义**（返回 None + 控制权交回调用方 + 槽未被这次等待动过），
    // 不是挂钟耗时：下界卡在超时值本身会被 Windows 计时器粒度钳住而偶发打红
    //（实测 ~1/12），且"多久才算到点"的阈值语义已由纯函数 deadline_conclusion 的用例覆盖。
    let idle = LoginSession::new();
    assert_eq!(
        idle.wait(Duration::from_millis(50)),
        None,
        "到点必须交出控制权（返回 None），不得永久挂住"
    );
    assert_eq!(idle.conclusion(), None, "超时返回不得凭空写入结论");
    assert!(!idle.is_loaded(), "超时返回不得改动首载标志");
    assert!(idle.settle(LoginConclusion::Closed), "超时之后槽仍可结算：生产者照常写入");
    assert_eq!(
        idle.wait(Duration::from_secs(5)),
        Some(LoginConclusion::Closed),
        "结算之后等待立刻拿到结论（控制权交回后一切照旧）"
    );

    // 首载标志：只记第一次
    let loading = LoginSession::new();
    assert!(!loading.is_loaded());
    assert!(loading.mark_loaded(), "第一次上报首载完成");
    assert!(!loading.mark_loaded(), "重复上报不是新的首载");
    assert!(loading.is_loaded());
}

// ---------------------------------------------------------------------------
// 7. 独占：并排第二次登录不得开出第二个窗
// ---------------------------------------------------------------------------

#[test]
fn login_state_is_exclusive() {
    let state = LoginState::default();
    assert!(!state.is_active());

    let first = LoginSession::new();
    assert!(
        state.begin(std::sync::Arc::clone(&first)),
        "第一次登录应当登记成功"
    );
    assert!(state.is_active());
    assert!(state.session().is_some());

    let second = LoginSession::new();
    assert!(
        !state.begin(second),
        "已有进行中的登录时必须拒绝第二次（调用方转而聚焦既有窗）"
    );
    assert!(
        std::sync::Arc::ptr_eq(&state.session().expect("既有会话仍在"), &first),
        "拒绝第二次不得把既有会话换掉"
    );

    state.finish();
    assert!(!state.is_active());
    assert!(
        state.begin(LoginSession::new()),
        "收尾之后可以重新开始"
    );
    state.finish();
    state.finish(); // 幂等：重复收尾不 panic
    assert!(!state.is_active());
}

// ---------------------------------------------------------------------------
// 8. 几何（R23：登录页是**同窗** webview ⇒ 坐标是客户区相对的，没有屏幕坐标、也没有跨窗换算。
//    R25：登录页**铺满整个客户区**——用户四项之 3"不挤压网页"）
// ---------------------------------------------------------------------------

#[test]
fn layout_target_fills_the_whole_main_client_area() {
    // 输入是**主窗客户区尺寸**（物理像素）：同窗 webview 的坐标原点就是客户区左上角，
    // 所以 x/y 恒为 0——屏幕坐标（旧宿主用的 `inner_position`）不参与。
    let target = layout_target(1280.0, 800.0);

    assert_eq!(target.x, 0.0, "同窗 webview 不存在屏幕 x 偏移");
    assert_eq!(target.y, 0.0, "R25：顶部不再让出那一条（官方页铺满整窗）");
    assert_eq!(target.width, 1280.0, "宽度铺满客户区");
    assert_eq!(target.height, 800.0, "高度铺满客户区（不再是 800-48）");
    assert!(target.y + target.height <= 800.0, "不得溢出客户区");

    // 主窗被外部压到退化尺寸时钳制：绝不交出零尺寸（set_size 会失败/建出畸形块）
    let squashed = layout_target(10.0, 20.0);
    assert_eq!(squashed.height, MIN_LOGIN_HEIGHT);
    assert_eq!(squashed.width, MIN_LOGIN_WIDTH);
    assert!(squashed.height > 0.0 && squashed.width > 0.0);

    // 非有限/负输入按 0 处理（合成器偶发退化值），仍然不产出零/负尺寸
    for bad in [f64::NAN, f64::INFINITY, -5.0] {
        let target = layout_target(bad, bad);
        assert!(target.x.is_finite() && target.y.is_finite());
        assert!(target.width >= MIN_LOGIN_WIDTH && target.height >= MIN_LOGIN_HEIGHT);
    }
}

/// R25：浮动控件的几何（用户四项之 2/4）——左上角「返回扫码登录」、右上角主题控件，
/// 贴边留 8px、尺寸按缩放比换算，且**不会越过客户区**（越界就等于点不到）。
#[test]
fn chrome_widgets_are_anchored_to_the_two_top_corners() {
    let [back, theme] = chrome_rects(1280.0, 800.0, 1.0);
    assert_eq!((back.x, back.y), (CHROME_MARGIN, CHROME_MARGIN), "返回控件在左上角");
    assert_eq!(theme.y, CHROME_MARGIN);
    assert_eq!(theme.x, 1280.0 - CHROME_MARGIN - theme.width, "主题控件贴右沿");
    assert!(
        back.x + back.width <= theme.x,
        "宽窗口里两个控件不许重叠：{back:?} vs {theme:?}"
    );
    for rect in [back, theme] {
        assert!(rect.width >= 1.0 && rect.height >= 1.0, "{rect:?}");
        assert!(rect.x >= 0.0 && rect.x + rect.width <= 1280.0, "不许越过客户区：{rect:?}");
    }

    // CSS 像素 → 物理像素：200% 缩放时尺寸与边距一起翻倍
    let [back2, theme2] = chrome_rects(1280.0, 800.0, 2.0);
    assert_eq!(back2.width, back.width * 2.0);
    assert_eq!(back2.x, back.x * 2.0);
    assert_eq!(theme2.width, theme.width * 2.0);

    // 缩放比不可信时按 1 算（与 ClientArea 的纪律一致）
    assert_eq!(chrome_rects(1280.0, 800.0, f64::NAN)[0].width, back.width);

    // 窄窗口：夹进客户区，仍然是正尺寸
    for rect in chrome_rects(200.0, 800.0, 1.0) {
        assert!(rect.width >= 1.0 && rect.height >= 1.0, "{rect:?}");
        assert!(rect.x >= 0.0 && rect.x + rect.width <= 200.0, "不许越过客户区右沿：{rect:?}");
    }
}

/// R25：浮动控件只许停在应用自己的本地页面上（它们握着 `core_login_chrome` 的来源资格）。
#[test]
fn chrome_widgets_may_only_navigate_within_the_app() {
    assert!(chrome_navigation_allowed("tauri://localhost/login-chrome.html?kind=theme"));
    assert!(chrome_navigation_allowed("http://localhost:1420/login-chrome.html?kind=return"));
    for blocked in [
        "https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize",
        "https://evil.example.com/",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        "javascript:alert(1)",
        "",
        "不是 URL",
    ] {
        assert!(!chrome_navigation_allowed(blocked), "{blocked} 必须拦下");
    }
}

/// R24：几何的**输入**也可能"量不到"——真机 2026-10-20 同一个进程里那两行日志就是这个契约的两端：
/// 主窗可测量 → `rect=(0,48,1280,752)`（R25 起是 `(0,0,1280,800)`）；主窗最小化
/// （`inner_size()` 是 `(0,0)`）→ **没有几何**，而不是 `rect=(0,48,320,160)`
///（那是两条钳制下限凑出来的假盒子：登录页真的被摆成了 320×160，创建日志一次、跟随每 250ms 又一次）。
#[test]
fn an_unmeasurable_client_area_has_no_geometry() {
    let measurable = ClientArea {
        width: 1280.0,
        height: 800.0,
        scale: 1.0,
        minimized: false,
    };
    assert_eq!(
        layout_for(&measurable),
        Layout::Target(Rect {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 800.0,
        }),
        "R25：真机那台 1280×800 的主窗 ⇒ rect=(0,0,1280,800)"
    );
    assert_eq!(
        measurable.describe(),
        "inner_size=(1280,800) scale=1 minimized=false",
        "原始读数要能进日志（简报 R24 要求）"
    );

    // 主窗最小化：tao 的 inner_size 就是 GetClientRect 的结果，真机读数是 (0,0)
    let minimized = ClientArea {
        width: 0.0,
        height: 0.0,
        scale: 1.0,
        minimized: true,
    };
    assert_eq!(
        layout_for(&minimized),
        Layout::HostUnmeasurable,
        "量不到不是尺寸：不许钳成 MIN_LOGIN_WIDTH×MIN_LOGIN_HEIGHT"
    );
    assert_eq!(minimized.describe(), "inner_size=(0,0) scale=1 minimized=true");

    // 半边为 0 / 非有限值同样是"量不到"
    for (width, height) in [(0.0, 800.0), (1280.0, 0.0), (f64::NAN, 800.0)] {
        let area = ClientArea {
            width,
            height,
            scale: 1.0,
            minimized: false,
        };
        assert_eq!(
            layout_for(&area),
            Layout::HostUnmeasurable,
            "({width},{height}) 不是尺寸"
        );
    }
}

// ---------------------------------------------------------------------------
// 9. 收尾失败分级（修复轮 1 · Important 2）：预期失败只留日志，app:notice 只给真残留
// ---------------------------------------------------------------------------
//
// 场景：登录窗已经消失时（"窗口消失"轮询判 Closed，或用户/系统在收尾前就关掉了窗），
// `clear_all_browsing_data` / `close` 必然失败——而数据目录会被整棵删掉，实际上什么都没残留。
// 旧写法把每一次预期失败都无条件广播成 app:notice，等于每结束一次登录就弹一条
// "建议手动清理"，让用户去清理一个**刚刚被删掉**的东西。

#[test]
fn failures_on_an_already_gone_window_are_log_only_and_never_notice_the_user() {
    // 窗口已消失：clear 与 close 都失败，但目录已整棵删掉（data_dir: None）→ 无残留
    let gone = ShutdownOutcome {
        clear_browsing_data: Err("窗口已不存在".to_string()),
        close: Err("窗口已不存在".to_string()),
        ..Default::default()
    };
    let failures = shutdown_failures(&gone);
    assert_eq!(failures.len(), 2, "预期失败仍要留痕（调用方写日志），不许静默");
    assert!(
        failures.iter().all(|failure| !failure.needs_user_notice()),
        "窗口已消失的路径上没有任何残留：不得广播 app:notice，实际 {failures:?}"
    );
    for failure in &failures {
        // 文案契约：不含字面 markdown 记号；也不得让用户去手动清理一个已经被删掉的东西
        assert!(!failure.message().contains("**"), "文案里留了 markdown 记号：{}", failure.message());
        assert!(
            !failure.message().contains("手动清理"),
            "该路径没有残留可清理：{}",
            failure.message()
        );
    }

    // 真残留之一：数据目录没删掉（里面可能还躺着本次的登录 cookie）→ 必须打扰用户
    let residue = ShutdownOutcome {
        data_dir: Some("拒绝访问。 (os error 5)".to_string()),
        ..Default::default()
    };
    let failures = shutdown_failures(&residue);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].needs_user_notice(), "目录删不掉是真残留：{failures:?}");
    assert!(!failures[0].message().contains("**"), "{}", failures[0].message());
    assert!(failures[0].message().contains("建议手动清理"), "{}", failures[0].message());

    // 真残留之二：窗口还在且销毁失败（任务管理器里能看到）→ 也必须打扰用户
    let stuck = ShutdownOutcome {
        close: Err("拒绝访问".to_string()),
        still_present: true,
        destroy: Err("拒绝访问".to_string()),
        ..Default::default()
    };
    let failures = shutdown_failures(&stuck);
    assert_eq!(failures.len(), 2, "close 失败 + 销毁失败两条都留痕：{failures:?}");
    assert_eq!(
        failures.iter().filter(|failure| failure.needs_user_notice()).count(),
        1,
        "只有销毁失败是真残留（close 失败已被 destroy 兜住）：{failures:?}"
    );
    assert!(matches!(
        failures.iter().find(|failure| failure.needs_user_notice()),
        Some(ShutdownFailure::Destroy(_))
    ));

    // 窗口已不在时不采纳 destroy 的结果：没销毁过就不算"销毁失败"
    let stale_destroy = ShutdownOutcome {
        still_present: false,
        destroy: Err("这次 destroy 根本没被调用".to_string()),
        ..Default::default()
    };
    assert!(
        shutdown_failures(&stale_destroy)
            .iter()
            .all(|failure| !matches!(failure, ShutdownFailure::Destroy(_))),
        "未尝试销毁不得报成销毁失败"
    );

    // 全清干净：没有任何失败项
    assert!(shutdown_failures(&ShutdownOutcome::default()).is_empty());
}

// ---------------------------------------------------------------------------
// 10. 建窗结果交付（修复轮 1 · Important 1）：没人等待的窗必须销毁，不许留在屏幕上
// ---------------------------------------------------------------------------
//
// 场景：`create_login_window` 把建窗闭包投到主线程后只等 `BUILD_TIMEOUT`（10s）。主线程忙到超时时，
// 那个闭包**稍后仍会执行**：它会建出、显示并聚焦一个无人等待的登录窗，而此刻 `LoginState` 已经
// `finish()`——用户再点登录只会撞 duplicate-label，人卡在一个没人管的无边框窗里。
// 交付守卫就是这条路：`send` 失败意味着等待方已经走了，把刚建出来的窗就地销毁。

#[test]
fn a_window_nobody_waits_for_is_discarded_instead_of_left_on_screen() {
    use std::sync::mpsc::SendError;

    // 正常路径：等待方还在，交付成功 → 一根手指都不碰窗
    assert_eq!(
        deliver_build_result::<&str, &str>(Ok(()), |_| panic!("正常路径不该清理任何窗口")),
        BuildDelivery::Delivered
    );

    // 等待方已经走了（建窗超时），但窗**已经建出来了**（`send` 把它原样还回来）→ 必须销毁
    let mut discarded: Vec<&str> = Vec::new();
    let delivery = deliver_build_result::<&str, &str>(Err(SendError(Ok("login-view"))), |window| {
        discarded.push(window);
        Ok(())
    });
    assert_eq!(delivery, BuildDelivery::OrphanDiscarded);
    assert_eq!(discarded, vec!["login-view"], "孤儿登录窗必须被销毁");

    // 销毁也失败：如实报告（调用方据此留日志），不当成没发生
    assert_eq!(
        deliver_build_result::<&str, &str>(Err(SendError(Ok("login-view"))), |_| Err(
            "拒绝访问".to_string()
        )),
        BuildDelivery::OrphanLeftBehind("拒绝访问".to_string())
    );

    // 窗根本没建出来（交回的是 Err）→ 无事可做，也不许去碰不存在的窗
    assert_eq!(
        deliver_build_result::<&str, &str>(Err(SendError(Err("建窗失败"))), |_| panic!(
            "没建出窗就不该清理"
        )),
        BuildDelivery::NothingBuilt
    );
}

/// 建窗超时留下的孤儿页：销毁 + 删掉那个一次性数据目录（两条都要尽力，一条失败不影响另一条）。
#[test]
fn an_orphan_window_is_destroyed_and_its_one_shot_directory_removed() {
    use huawei_music_desktop_lib::login::discard_orphan_login_window;

    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("login-orphan-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("EBWebView").join("Default")).expect("能建测试目录");
    std::fs::write(dir.join("EBWebView").join("Default").join("Cookies"), b"x").expect("能写文件");

    let window = FakeWindow::new(Ok(()));
    assert_eq!(discard_orphan_login_window(&window, &dir), Ok(()));
    assert_eq!(window.discards.get(), 1, "孤儿窗要销毁");
    assert!(!dir.exists(), "孤儿窗的数据目录也要删掉（里面可能已经有 cookie）");

    // 销毁失败：目录仍要删（另一条独立尽力），并把失败原因如实交出来
    let dir_again = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("login-orphan-test-b-{}", std::process::id()));
    std::fs::create_dir_all(&dir_again).expect("能建测试目录");
    let stubborn = FakeWindow::new(Err("拒绝访问".to_string()));
    let failure = discard_orphan_login_window(&stubborn, &dir_again).expect_err("销毁失败要如实报告");
    assert!(failure.contains("拒绝访问"), "{failure}");
    assert!(!dir_again.exists(), "销毁失败不该连累目录清理");
}

/// 纯函数测不了"有没有真接上"：钉住生产代码走的是交付守卫，而不是旧写法 `let _ = sender.send(built)`。
///
/// R23：宿主换成同窗 webview 之后，"建出来但接不下去"的形态只剩**孤儿**一种——旧宿主还有第二条
/// （`build()` 成功而 `show()` 失败 → 回头销毁）；同窗宿主没有 `show()` 那一步，那条机制连同它的
/// 用例一起删掉了（不留一个永不触发的检查）。这里改为钉住**新宿主的形状**：登录页挂在主窗上。
#[test]
fn the_build_handoff_is_wired_through_the_delivery_guard() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/login.rs"))
        .expect("要能读到 login.rs");
    let production = match source.find("#[cfg(test)]") {
        Some(cut) => &source[..cut],
        None => &source[..],
    };

    assert!(
        production.contains("deliver_build_result(sender.send("),
        "建窗结果必须走交付守卫（等待方走了就把 webview 关掉）"
    );
    assert!(
        !production.contains("let _ = sender.send("),
        "不得丢弃交付结果：那正是「超时后留下孤儿登录页」的来源"
    );
    assert!(
        production.contains("discard_orphan_login_window("),
        "超时那条路要尽力清掉可能已经建出来的孤儿页"
    );
    assert!(
        production.contains("discard_pending_login_view("),
        "建页超时的等待方也要自己清一次（闭包可能已经建出来但还没交付）"
    );
    assert!(
        production.contains("drop(receiver)"),
        "等待方一旦收场就要立刻扔掉接收端：否则晚到的 `send` 仍可能成功，webview 被丢进没人再读的通道 = 孤儿页"
    );
    assert!(
        production.contains("WebviewBuilder::new(") && production.contains(".add_child("),
        "宿主必须是主窗下面的第二个 webview（R23 用户指令：在程序内跳转、不开新窗口）"
    );
    assert!(
        !production.contains("WebviewWindowBuilder"),
        "登录页不再是独立子窗"
    );
}

/// 建窗失败那条路（终审 C）：`create_login_window` 可能在"目录已建、窗没建起来"之后失败
/// （`build()` / `show()` 失败）。那条路上 `shutdown_window` **永远不会跑**（它只在建窗成功的路径上
/// 被调用），于是那个一次性数据目录没人负责——里面可能已经有本次的 cookie。
#[test]
fn a_window_that_never_opened_does_not_leave_its_data_dir_behind() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("login-abandon-build-test-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("EBWebView").join("Default")).expect("能建测试目录");
    std::fs::write(dir.join("EBWebView").join("Default").join("Cookies"), b"x").expect("能写文件");

    let failures = abandon_build_data_dir(&dir);
    assert!(failures.is_empty(), "删干净了就不该有任何失败项：{failures:?}");
    assert!(!dir.exists(), "建窗失败的一次性目录必须删掉（里面可能已经有 cookie）");

    // 更早的失败（比如 url 解析不了）根本没建出目录：不算失败，也不许报残留
    assert!(abandon_build_data_dir(&dir).is_empty(), "本来就不存在 = 已经清干净");

    // 删不掉：按 `DataDir` 分级 → 必须打扰用户（与收尾路径共用同一张分级表与文案）
    let stubborn =
        abandon_build_data_dir_with(&dir, |_| Some("拒绝访问。 (os error 5)".to_string()));
    assert_eq!(stubborn.len(), 1, "{stubborn:?}");
    assert!(matches!(stubborn[0], ShutdownFailure::DataDir(_)), "{stubborn:?}");
    assert!(stubborn[0].needs_user_notice(), "目录没删掉是真残留：{stubborn:?}");
    assert!(stubborn[0].message().contains("建议手动清理"), "{}", stubborn[0].message());
}

/// 纯函数测不了"有没有真接上"：钉住建窗失败分支真的调了那次善后，且失败原因仍如实回给等待方。
#[test]
fn the_build_failure_branch_also_cleans_the_one_shot_data_dir() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/login.rs"))
        .expect("要能读到 login.rs");
    let start = source.find("fn run_login_view(").expect("登录线程的正体要还在");
    let end = source.find("fn wait_for_conclusion(").expect("下一个函数要还在");
    let login_thread = &source[start..end];

    assert!(
        login_thread.contains("abandon_build_data_dir("),
        "建窗失败那条路要删掉它可能已经建出来的一次性数据目录"
    );
    assert!(
        login_thread.contains("respond(&shared, &request_id, Err(error))"),
        "失败原因仍要如实回给等待方（不是塞一句「打不开官方页」）"
    );
}

/// 假窗：只为观察"有没有真的去销毁"，真实实现是 tauri 的 `WebviewWindow`（需要真 GUI，测不了）。
struct FakeWindow {
    discards: Cell<u32>,
    result: Result<(), String>,
}

impl FakeWindow {
    fn new(result: Result<(), String>) -> Self {
        Self { discards: Cell::new(0), result }
    }
}

impl DiscardableWindow for FakeWindow {
    fn discard(&self) -> Result<(), String> {
        self.discards.set(self.discards.get() + 1);
        self.result.clone()
    }
}
