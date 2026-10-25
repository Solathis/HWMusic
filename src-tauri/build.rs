fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Common-Controls v6 激活上下文必须覆盖**所有**会链接出 PE 的目标：
        //   - `cargo test --lib` 的 lib 单测二进制：`rustc-link-arg-tests` **不覆盖**它
        //     （实测：`cargo test --lib --no-run` 出来的 exe 连资源段都没有），少了 v6 清单
        //     就会在加载期 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`
        //     （comctl32!TaskDialogIndirect 等 v6 导出，见 task-48）；
        //   - `cargo test --test ...` 的集成测试；
        //   - app bin（走下面那条例外分支）。
        // 所以清单必须走全局 `rustc-link-arg`，不能走 `-tests`。
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("tests/fixtures/common-controls-v6.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

        // app bin 是唯一例外：tauri-build 已经把一份内容完全相同的清单写进 `resource.lib` 的
        // RT_MANIFEST 资源（`target/.../out/resource.rc` 里的 `1 24 { ... }`）。
        // link.exe 的 `/MANIFESTINPUT` **不与资源里的清单合并**，而是另外生成一份
        // → `CVTRES : fatal error CVT1100`（重复的 MANIFEST 资源）+ `LNK1123`。
        // 因此 bin 侧关掉我们自己这份的生成，继续用 tauri 嵌进去的那份清单
        // （`mt.exe -inputresource:...\huawei-music-desktop.exe;#1` 核对：内容与改动前一致）。
        // 这样做的副作用是 linker 会告警 LNK4075（"忽略 /MANIFESTINPUT（由于 /MANIFEST:NO）"），
        // 这条冲突是**有意**的，就地静音，别让它淹没真正的链接问题。
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rustc-link-arg-bins=/IGNORE:4075");
    }
}
