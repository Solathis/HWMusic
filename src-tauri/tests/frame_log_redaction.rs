//! 截断帧/非法帧**绝不落全文**：帧文本是唯一会把未解析字节原样交出来的东西。
//!
//! 它可能正是一帧带凭据的 JSON，而日志会落盘、会被贴进 issue，所以两侧都取
//! **64 字节上限**：够认出是哪个频道、坏在哪一段，之后的凭据进不了日志。
//!
//! [`frame_excerpt`] 在这里直接测；帧泵那段接真 sidecar 进程，另用**源码扫描**钉住它走摘要而非原文。

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
