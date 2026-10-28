fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Common-Controls v6 清单必须覆盖**所有**会链接出 PE 的目标（含 lib 单测二进制，缺了会在加载期
        // `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`），所以只能走全局 `rustc-link-arg`，`-tests` 不覆盖。
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("tests/fixtures/common-controls-v6.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

        // app bin 是唯一例外：tauri-build 已把内容相同的清单嵌进 `resource.lib` 的 RT_MANIFEST，而
        // `/MANIFESTINPUT` 不与它合并，会另生成一份 → CVT1100 + LNK1123；故 bin 侧关掉，LNK4075 有意静音。
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rustc-link-arg-bins=/IGNORE:4075");
    }
}
