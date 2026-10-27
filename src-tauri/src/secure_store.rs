//! DPAPI 安全存储：Windows 上把明文封成只有本机本用户能解的信封，其他平台返回同形的结构化错误。
//! 只搬内存字节，不落盘；落盘（0600 + 临时文件 + rename）由 Node 侧 `src/main/session-store.mjs` 负责。
//! 过桥形态是 base64（NDJSON 帧只放文本），编解码与平台无关，因此能在任何平台单测。
//! 错误一律结构化、绝不 panic、绝不回显明文或密文；`secure_store_unavailable` 时上层须保留内存会话，
//! 不允许退化成明文落盘（`invalid_payload` 是调用方坏输入，`invalid_cipher` 是信封不可解）。
//! 加密用 `CRYPTPROTECT_UI_FORBIDDEN`（后台进程不能被弹窗卡住），刻意不传额外熵：熵不是密钥。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::bridge::CoreError;

/// 后端不可用（非 Windows，或后端拒绝加密）：上层保留内存会话并明确提示，**不许写明文**。
pub const SECURE_STORE_UNAVAILABLE_KIND: &str = "secure_store_unavailable";
/// 密文不合法：base64 坏、信封被改过、不是本机本用户写的、解出来不是 UTF-8。
pub const INVALID_CIPHER_KIND: &str = "invalid_cipher";
/// 载荷不合法（空明文/空密文）：在这一层就拒，碰不到后端。
pub const INVALID_PAYLOAD_KIND: &str = "invalid_payload";

/// DPAPI 的描述串：只进信封里的诊断信息，不含任何会话内容。
#[cfg(windows)]
const DPAPI_DESCRIPTION: &str = "hwmusic-session";

/// 加密信封 → base64 文本（过桥形态）。纯函数，任何平台可测。
pub fn encode_cipher(raw: &[u8]) -> String {
    BASE64.encode(raw)
}

/// base64 文本 → 加密信封。非法 base64 是 `invalid_cipher`，**不回显输入**（只报长度）。
pub fn decode_cipher(cipher_b64: &str) -> Result<Vec<u8>, CoreError> {
    BASE64.decode(cipher_b64).map_err(|_| {
        CoreError::new(
            INVALID_CIPHER_KIND,
            format!(
                "密文不是合法的 base64（长度 {} 字符）",
                cipher_b64.chars().count()
            ),
        )
    })
}

/// 明文 → DPAPI 信封 → base64。
pub fn encrypt(plaintext: &str) -> Result<String, CoreError> {
    if plaintext.is_empty() {
        return Err(CoreError::new(
            INVALID_PAYLOAD_KIND,
            "待加密的明文为空：拒绝把空串当成会话写下去",
        ));
    }
    protect(plaintext.as_bytes()).map(|envelope| encode_cipher(&envelope))
}

/// base64 → DPAPI 信封 → 明文。
pub fn decrypt(cipher_b64: &str) -> Result<String, CoreError> {
    if cipher_b64.is_empty() {
        return Err(CoreError::new(INVALID_PAYLOAD_KIND, "待解密的密文为空"));
    }
    let envelope = decode_cipher(cipher_b64)?;
    let plaintext = unprotect(&envelope)?;
    String::from_utf8(plaintext).map_err(|_| {
        CoreError::new(
            INVALID_CIPHER_KIND,
            "解密结果不是合法的 UTF-8：信封不是本应用写的，或已被破坏",
        )
    })
}

/// 没有后端可用时的结构化错误：说清平台，并说清不会退化成明文。
/// 唯一生产使用点在 `#[cfg(not(windows))]`，故 Windows 下显式 `allow(dead_code)`，而非藏进 cfg 丢掉测试覆盖。
#[allow(dead_code)]
pub fn unavailable_error() -> CoreError {
    CoreError::new(
        SECURE_STORE_UNAVAILABLE_KIND,
        format!(
            "当前平台（{}）没有可用的安全存储后端（DPAPI 只有 Windows 提供）：会话只保留在内存里，不写明文，也不静默降级",
            std::env::consts::OS
        ),
    )
}

/// 加密失败 = 后端不可用（上层转内存会话）。只带系统错误码，不带任何内容。
pub fn protect_failure_error(code: i32) -> CoreError {
    CoreError::new(
        SECURE_STORE_UNAVAILABLE_KIND,
        format!(
            "DPAPI 加密失败（{:#010X}）：本机安全存储后端拒绝了本次加密，会话不会落盘（保留在内存里，不写明文）",
            code as u32
        ),
    )
}

/// 解密失败 = 信封不合法（不是"后端不可用"）。只带系统错误码，不带任何内容。
pub fn unprotect_failure_error(code: i32) -> CoreError {
    CoreError::new(
        INVALID_CIPHER_KIND,
        format!(
            "DPAPI 解密失败（{:#010X}）：信封不是本机本用户写的，或已被破坏（已丢弃，不会当成会话使用）",
            code as u32
        ),
    )
}

/// 把 DPAPI 分配的输出 blob 复制成自有字节并立刻释放。
///
/// SAFETY（调用方保证）：`blob` 是 DPAPI 成功返回的输出——要么 `pbData` 由 `LocalAlloc` 分配，
/// 要么两者皆空。绝不把 LocalAlloc 的指针带出这个函数。
#[cfg(windows)]
unsafe fn copy_and_free(blob: &mut windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};

    let bytes = if blob.pbData.is_null() || blob.cbData == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec()
    };
    if !blob.pbData.is_null() {
        let _ = unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void))) };
    }
    blob.pbData = std::ptr::null_mut();
    blob.cbData = 0;
    bytes
}

#[cfg(windows)]
fn protect(plaintext: &[u8]) -> Result<Vec<u8>, CoreError> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // DPAPI 要的是 NUL 结尾的宽字符串：这里现算一份，别让常量以 Vec 的形式常驻
    let description: Vec<u16> = DPAPI_DESCRIPTION
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY：input 只被读取且在本调用期间活着；output 只在成功后由 DPAPI 分配，
    // 紧接着被 copy_and_free 复制走并 LocalFree——指针不外泄。
    let status = unsafe {
        CryptProtectData(
            &input,
            PCWSTR(description.as_ptr()),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    status.map_err(|source| protect_failure_error(source.code().0))?;
    // SAFETY：status 成功 ⇒ output 是 DPAPI 分配的输出。
    Ok(unsafe { copy_and_free(&mut output) })
}

#[cfg(windows)]
fn unprotect(envelope: &[u8]) -> Result<Vec<u8>, CoreError> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: envelope.len() as u32,
        pbData: envelope.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY：同 protect；描述串传 None（我们不要它，少一次 LocalFree）。
    let status = unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    status.map_err(|source| unprotect_failure_error(source.code().0))?;
    // SAFETY：status 成功 ⇒ output 是 DPAPI 分配的输出。
    Ok(unsafe { copy_and_free(&mut output) })
}

#[cfg(not(windows))]
fn protect(_plaintext: &[u8]) -> Result<Vec<u8>, CoreError> {
    Err(unavailable_error())
}

#[cfg(not(windows))]
fn unprotect(_envelope: &[u8]) -> Result<Vec<u8>, CoreError> {
    Err(unavailable_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::CoreError;

    /// 一段"看起来就像凭据"的会话文本：所有"不回显"断言都用它。
    const SECRET: &str = "{\"musicSession\":\"user$7f3a\",\"remark\":\"这是会话凭据\"}";

    fn kind(error: &CoreError) -> &str {
        error.kind.as_deref().unwrap_or("<无 kind>")
    }

    // ---- 纯 base64 层（任何平台都能测） ----

    #[test]
    fn encode_decode_round_trip_is_byte_exact() {
        let raw = vec![0u8, 1, 2, b'h', b'i', 254, 255];
        let encoded = encode_cipher(&raw);
        assert!(
            encoded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')),
            "编码结果必须是 base64 字符集：{encoded}"
        );
        assert_eq!(
            decode_cipher(&encoded).expect("自己编出来的 base64 必须能解回去"),
            raw,
            "base64 层必须字节级往返"
        );
        assert_eq!(encode_cipher(&[]), "", "空字节序列编码为空串");
        assert_eq!(
            decode_cipher("").expect("空串是合法的 base64（解出空字节序列）"),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn decode_cipher_rejects_garbage_without_echoing_it() {
        for garbage in [
            "!!这不是 base64!!",
            "aGk",          // 缺 padding
            "aGk=extra",    // padding 后面还有东西
            "a G k =",      // 空格
            "bm90LWEtZHBhcGktZW52ZWxvcGU", // 合法前缀但整体不合法
        ] {
            let error = decode_cipher(garbage).expect_err("非法 base64 必须报结构化错误");
            assert_eq!(kind(&error), INVALID_CIPHER_KIND, "输入 {garbage:?}");
            assert!(
                !error.message.contains(garbage),
                "错误里绝不能回显密文：{}",
                error.message
            );
        }
    }

    // ---- 载荷层守卫：空串在这里就被拒，不碰后端 ----

    #[test]
    fn encrypt_rejects_empty_plaintext_as_invalid_payload() {
        let error = encrypt("").expect_err("空明文必须被拒（不能把空串当成会话写下去）");
        assert_eq!(kind(&error), INVALID_PAYLOAD_KIND);
        assert!(error.message.contains("空"), "文案要说清是空明文：{}", error.message);
    }

    #[test]
    fn decrypt_rejects_empty_cipher_as_invalid_payload() {
        let error = decrypt("").expect_err("空密文必须被拒");
        assert_eq!(kind(&error), INVALID_PAYLOAD_KIND);
    }

    // ---- 错误分类层（纯函数，任何平台都能测；非 Windows 分支无法在本机跑到） ----

    #[test]
    fn unavailable_error_is_structured_and_platform_labelled() {
        let error = unavailable_error();
        assert_eq!(kind(&error), SECURE_STORE_UNAVAILABLE_KIND);
        assert!(
            error.message.contains(std::env::consts::OS),
            "不可用错误必须写明平台：{}",
            error.message
        );
        assert!(
            error.message.contains("明文"),
            "不可用错误必须写明不会退化成明文：{}",
            error.message
        );
        assert!(
            !error.message.contains(SECRET) && !error.message.contains("musicSession"),
            "不可用错误里不该出现任何会话内容：{}",
            error.message
        );
    }

    #[test]
    fn protect_failure_is_secure_store_unavailable_with_code() {
        let error = protect_failure_error(0x8007_0005u32 as i32);
        assert_eq!(kind(&error), SECURE_STORE_UNAVAILABLE_KIND, "加密失败=后端不可用，上层转内存会话");
        assert!(error.message.contains("0x80070005"), "要带上系统错误码：{}", error.message);
    }

    #[test]
    fn unprotect_failure_is_invalid_cipher_with_code() {
        let error = unprotect_failure_error(0x8007_000Du32 as i32);
        assert_eq!(kind(&error), INVALID_CIPHER_KIND, "解不开=信封不合法，不是后端不可用");
        assert!(error.message.contains("0x8007000D"), "要带上系统错误码：{}", error.message);
        assert!(
            !error.message.contains("musicSession") && !error.message.contains(SECRET),
            "错误里绝不能出现明文：{}",
            error.message
        );
    }

    #[test]
    fn decrypt_failure_never_echoes_cipher_or_plaintext() {
        // 合法 base64、但肯定不是本机 DPAPI 信封的字节：解不开也不许 panic
        let foreign = encode_cipher(&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
        let error = decrypt(&foreign).expect_err("外来信封必须被拒");
        assert!(
            matches!(kind(&error), INVALID_CIPHER_KIND | SECURE_STORE_UNAVAILABLE_KIND),
            "外来信封只能是 invalid_cipher 或（非 Windows）不可用：{:?}",
            error.kind
        );
        assert!(!error.message.contains(&foreign), "错误里不能回显密文：{}", error.message);
        assert!(!error.message.contains(SECRET));
    }

    // ---- 真 DPAPI（Windows） ----

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_preserves_text_and_hides_it() {
        let cipher = encrypt(SECRET).expect("Windows 上必须能加密");
        assert_ne!(cipher, SECRET, "密文不能等于明文（说明根本没加密）");
        assert!(!cipher.contains("musicSession"), "密文里不该出现明文片段：{cipher}");
        assert!(!cipher.contains("这是会话凭据"));
        assert_eq!(decode_cipher(&cipher).is_ok(), true, "过桥形态必须是合法 base64");
        assert_eq!(decrypt(&cipher).expect("自己封的信封必须能解回来"), SECRET);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_handles_unicode_and_long_text() {
        let long = format!("{}🎵{}", "会话".repeat(500), "x".repeat(8 * 1024));
        let cipher = encrypt(&long).expect("长文本必须能加密");
        assert_eq!(decrypt(&cipher).expect("长文本必须能解回来"), long);
    }

    #[cfg(windows)]
    #[test]
    fn same_plaintext_encrypts_differently_but_always_decrypts() {
        let first = encrypt(SECRET).expect("第一次加密");
        let second = encrypt(SECRET).expect("第二次加密");
        assert_ne!(first, second, "DPAPI 每次加密都带随机盐：两次密文不该相同");
        assert_eq!(decrypt(&first).unwrap(), SECRET);
        assert_eq!(decrypt(&second).unwrap(), SECRET);
    }

    #[cfg(windows)]
    #[test]
    fn tampered_cipher_is_invalid_cipher_and_never_panics() {
        let bytes = decode_cipher(&encrypt(SECRET).expect("先有一个真信封")).expect("真信封是合法 base64");
        let middle = bytes.len() / 2;
        let mut flipped = bytes.clone();
        flipped[middle] ^= 0x5a;

        for (label, broken) in [
            ("中间翻一位", encode_cipher(&flipped)),
            ("截断一半", encode_cipher(&bytes[..middle])),
            ("整个换成别的字节", encode_cipher(&vec![0x5au8; bytes.len()])),
        ] {
            match decrypt(&broken) {
                Ok(plaintext) => panic!("{label}：坏信封竟然解密成功（{} 字节）", plaintext.len()),
                Err(error) => {
                    assert_eq!(kind(&error), INVALID_CIPHER_KIND, "{label} 的错误类别不对");
                    assert!(!error.message.contains(&broken), "{label}：错误里回显了密文");
                }
            }
        }
    }

    /// DPAPI 只认自己头部里的长度：信封尾部多几个字节既不报错也不改明文，所以不算篡改。
    /// 真正会被拒的是截断与翻位；此用例钉住尾字节行为，免得后来者误以为该报 `invalid_cipher`。
    #[cfg(windows)]
    #[test]
    fn trailing_bytes_after_the_envelope_are_ignored_by_dpapi() {
        let bytes = decode_cipher(&encrypt(SECRET).expect("先有一个真信封")).expect("合法 base64");
        let padded = encode_cipher(&[bytes, vec![0u8; 16]].concat());
        assert_eq!(
            decrypt(&padded).expect("DPAPI 忽略信封尾部的多余字节"),
            SECRET,
            "尾部补字节既不报错也不改明文"
        );
    }

    // ---- 非 Windows：如实不可用，不写明文、不静默降级 ----

    #[cfg(not(windows))]
    #[test]
    fn encrypt_is_unavailable_on_non_windows_and_never_returns_plaintext() {
        let error = encrypt(SECRET).expect_err("非 Windows 没有后端，必须结构化报不可用");
        assert_eq!(kind(&error), SECURE_STORE_UNAVAILABLE_KIND);
        let error = decrypt(&encode_cipher(b"whatever")).expect_err("非 Windows 没有后端");
        assert_eq!(kind(&error), SECURE_STORE_UNAVAILABLE_KIND);
    }

    // ---- 真 sidecar + 真 DPAPI + 真文件（默认不跑的端到端） ----

    /// 默认 `#[ignore]`：它要 spawn 真 sidecar 进程并往数据目录写真文件。
    /// 协议内还没有触发 `host:secure-*` 的调用方，故只起 sidecar 证明接线，再走宿主同一条路由落到真文件。
    #[cfg(windows)]
    #[ignore = "需要本机允许 spawn 真 sidecar 并写数据目录；用 cargo test -- --ignored 手动运行"]
    #[test]
    fn real_sidecar_dpapi_session_envelope_round_trip() {
        use crate::commands::{plan_host_request, HostPlan};
        use crate::sidecar::{self, SidecarKnobs, SidecarProcess};
        use serde_json::json;

        let script = sidecar::fallback_dev_script().expect("debug 构建才有开发期 sidecar 脚本");
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: Some(script),
        };
        let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("secure-store-e2e");
        std::fs::create_dir_all(&data_dir).expect("临时数据目录必须能建");
        let plan = sidecar::resolve_launch(&std::env::temp_dir(), &data_dir, &knobs)
            .expect("开发期启动计划必须可解析");
        let process = SidecarProcess::spawn(&plan).expect("真 sidecar 必须起得来");

        let cipher = match plan_host_request("e2e-1", "host:secure-encrypt", &json!({"plaintext": SECRET})) {
            HostPlan::Respond(frame) => frame.data.expect("加密必须回数据")["cipher"]
                .as_str()
                .expect("加密响应必须带 cipher")
                .to_string(),
            other => panic!("加密应直接回一帧，实际 {other:?}"),
        };

        let envelope = data_dir.join("session.enc");
        std::fs::write(&envelope, format!("{{\"schemaVersion\":1,\"cipher\":\"{cipher}\"}}\n"))
            .expect("信封必须能落盘");
        let raw = std::fs::read_to_string(&envelope).expect("信封必须能读回");
        assert!(!raw.contains("musicSession"), "落到磁盘上的信封里不能有明文");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("信封是 JSON");
        let stored = parsed["cipher"].as_str().expect("信封必须带 cipher").to_string();

        match plan_host_request("e2e-2", "host:secure-decrypt", &json!({"cipher": stored})) {
            HostPlan::Respond(frame) => {
                assert!(frame.ok, "读回的信封必须能解开：{:?}", frame.error);
                assert_eq!(frame.data.expect("解密必须回数据")["plaintext"], json!(SECRET));
            }
            other => panic!("解密应直接回一帧，实际 {other:?}"),
        }

        process.terminate("e2e 收尾");
        let _ = std::fs::remove_file(&envelope);
    }
}
