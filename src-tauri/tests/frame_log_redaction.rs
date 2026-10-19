//! 终审 B · 截断帧/非法帧**绝不落全文**（凭据邻接的第二道口子）。
//!
//! 为什么单独立一份：帧文本是**唯一**会把未解析字节原样交出来的东西，而它可能正是一帧带着
//! 凭据的 JSON（`{"channel":"host:secure-store-get","payload":{"password":…`）。日志会落盘、
//! 会被贴进 issue，所以两侧（Node 宿主与 Rust 宿主）都按裁决取 **64 字节上限**：
//! 够认出"是哪个频道、坏在哪一段"，第 64 字节之后的凭据进不了日志。
//!
//! 纯函数部分（[`frame_excerpt`]）在这里直接测；帧泵那一段接在真 sidecar 进程上（要真起进程 + 真
//! stderr），所以用**源码扫描**钉住"帧泵走的是摘要、不是 `{rest}` 原文"——同型做法见
//! `tests/login_policy.rs` 的接线扫描。

use huawei_music_desktop_lib::bridge::{frame_excerpt, FrameDecoder};

/// 帧摘要的字节上限（与 `src/host/bridge.mjs` 的 `FRAME_EXCERPT_BYTES` 同一口径）。
const EXCERPT_BYTES: usize = 64;

/// 哑凭据：只在断言里用，不是任何真实值。
const DUMMY_SECRET: &str = "dummy-secret-do-not-log";

/// 半帧的形状：哑凭据刻意放在第 64 字节**之后**——这正是"凭据邻接"的样子。
fn half_frame_with_secret() -> String {
    format!(
        "{{\"id\":\"half\",\"channel\":\"host:secure-store-get\",\"payload\":{{\"key\":\"{}\",\"password\":\"{DUMMY_SECRET}\"",
        "p".repeat(40)
    )
}

#[test]
fn a_truncated_frame_is_logged_as_an_excerpt_and_never_in_full() {
    let mut decoder = FrameDecoder::default();
    let half = half_frame_with_secret();
    decoder.push(&half);
    let rest = decoder.end().expect("EOF 时必须交出半帧残余");

    assert_eq!(rest, half, "协议层照旧拿到完整残余（摘要只作用于日志）");

    let logged = frame_excerpt(&rest);
    assert!(!logged.contains(DUMMY_SECRET), "截断帧不得全文进日志：{logged}");
    assert!(
        logged.starts_with(&half[..EXCERPT_BYTES]),
        "摘要要保留可辨识性（渠道与坏在哪一段）：{logged}"
    );
    assert!(logged.contains("已截断"), "{logged}");
    assert!(
        logged.contains(&format!("共 {} 字节", half.len())),
        "总长度如实报出（截了多少一目了然）：{logged}"
    );
}

#[test]
fn a_residual_shorter_than_the_cap_is_still_labelled_with_its_length() {
    let mut decoder = FrameDecoder::default();
    decoder.push("{\"id\":\"half\"");
    let rest = decoder.end().expect("EOF 时必须交出半帧残余");

    let logged = frame_excerpt(&rest);
    assert_eq!(logged, format!("{rest}（共 {} 字节）", rest.len()));
    assert!(!logged.contains("已截断"), "没到上限就不该说截断：{logged}");
    assert!(
        logged.len() <= EXCERPT_BYTES + "（共 1234567890 字节）".len(),
        "上限之内的残余不加额外字节：{logged}"
    );
}

#[test]
fn the_excerpt_never_splits_a_multibyte_character() {
    // 每字 3 字节 → 第 64 字节正好落在一个汉字中间
    let text = format!("{{\"text\":\"{}\"}}", "中".repeat(40));
    let logged = frame_excerpt(&text);

    assert!(!logged.contains('\u{FFFD}'), "不许留半个汉字：{logged}");
    let head = logged.split('…').next().expect("摘要总是有头");
    assert!(head.len() <= EXCERPT_BYTES, "摘要头仍要 ≤64 字节：{head}");
    assert!(logged.contains("已截断"), "{logged}");
}

/// 帧泵那一段（`src-tauri/src/sidecar.rs`）走的是摘要：源码扫描，钉住接线本身。
#[test]
fn the_sidecar_frame_pump_logs_the_excerpt_instead_of_the_raw_residual() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sidecar.rs"))
        .expect("要能读到 sidecar.rs");

    assert!(
        source.contains("frame_excerpt(&rest)"),
        "EOF 残余进 Notice 前必须先过摘要（截断至 64 字节）"
    );
    assert!(
        !source.contains("在半个帧上结束：{rest}"),
        "不得把半帧原文插进 Notice：那会把凭据写进落盘的日志"
    );
}
