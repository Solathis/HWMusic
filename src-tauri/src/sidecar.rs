//! sidecar 进程监督：启动计划（环境覆盖旋钮 + 打包后同目录二进制回退）、双线程帧泵、收尸。
//!
//! 相机事实：tao 在 Windows 上 run_return 后直接 `process::exit`，`Drop` 不会执行，
//! 所以退出路径必须显式 `terminate`（`commands::shutdown_core`），`Drop` 只是兜底。

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::bridge::{
    classify_line, frame_excerpt, CoreError, CoreShared, Effect, FrameDecoder, FramePolicy,
    LineOutcome,
};

/// node 可执行文件覆盖旋钮：绝对路径或 PATH 上的裸命令名；空值/相对路径=未设置。
pub const NODE_BIN_ENV: &str = "HWMUSIC_NODE_BIN";

/// sidecar 脚本覆盖旋钮：只接受绝对路径；空值/相对路径=未设置（排障用）。
pub const SIDECAR_SCRIPT_ENV: &str = "HWMUSIC_SIDECAR_SCRIPT";

/// sidecar 启动参数：应用数据目录（Node 侧 `src/main/data-dir.mjs` 读同一个字面量，测试互钉）。
///
/// 数据目录只由宿主解析（`HWMUSIC_DATA_DIR` → 应用数据目录 → 应用缓存目录），再经 argv 交给
/// sidecar：让 sidecar 自己猜目录，打包后会落到不可写的位置（见 `lib.rs` 的 `DataRootError`）。
pub const DATA_DIR_ARG: &str = "--data-dir";

/// 打包后 sidecar 二进制的文件名主干：Tauri 复制 externalBin 时会剥掉三元组后缀。
pub const SIDECAR_BIN_STEM: &str = "hwmusic-core";

/// 收尸宽限：等 sidecar 自己退出（stdin EOF），超时才 kill。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// 打包后随应用同目录的 sidecar 文件名。
pub fn sidecar_binary_name() -> String {
    if cfg!(windows) {
        format!("{SIDECAR_BIN_STEM}.exe")
    } else {
        SIDECAR_BIN_STEM.to_string()
    }
}

/// 启动旋钮：环境覆盖 + 开发期脚本回退（release 构建刻意不给回退，见 [`fallback_dev_script`]）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SidecarKnobs {
    pub node_bin: Option<String>,
    pub script: Option<String>,
    pub dev_script: Option<PathBuf>,
}

impl SidecarKnobs {
    pub fn from_env() -> Self {
        Self {
            node_bin: std::env::var(NODE_BIN_ENV).ok(),
            script: std::env::var(SIDECAR_SCRIPT_ENV).ok(),
            dev_script: fallback_dev_script(),
        }
    }
}

/// 开发期的脚本回退：仓库里的 `src/sidecar/main.mjs`。
///
/// release 构建返回 None：不能把构建机上的仓库路径烘进交付产物——那时必须靠
/// 应用同目录的 sidecar 二进制（R14 打包负责放进去）。
#[cfg(debug_assertions)]
pub fn fallback_dev_script() -> Option<PathBuf> {
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("sidecar")
            .join("main.mjs"),
    )
}

#[cfg(not(debug_assertions))]
pub fn fallback_dev_script() -> Option<PathBuf> {
    None
}

/// 启动计划的来源（日志与排障要说得清到底起了哪一个）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchSource {
    /// 环境旋钮指定的脚本（用 node 跑）
    OverrideScript,
    /// 应用同目录的打包产物
    PackagedSibling,
    /// 开发期仓库里的 src/sidecar/main.mjs
    DevScript,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub source: LaunchSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// 既没有同目录二进制，也没有可用的开发期脚本
    NoCore { exe_dir: PathBuf, expected: PathBuf },
    /// 进程起不来（node 不在 PATH、二进制被拦等）
    Spawn { program: PathBuf, message: String },
    /// stdio 没接上管道
    NoPipe(&'static str),
    /// 数据目录是相对路径：会随启动目录漂移，只收绝对路径（与 `HWMUSIC_DATA_DIR` 同一口径）
    RelativeDataDir(PathBuf),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LaunchError::NoCore { exe_dir, expected } => write!(
                formatter,
                "找不到 core sidecar：{} 下没有 {}，也没有开发期脚本（可用 {SIDECAR_SCRIPT_ENV} 指定绝对路径）",
                exe_dir.display(),
                expected.file_name().map_or_else(|| SIDECAR_BIN_STEM.into(), |name| name.to_string_lossy().into_owned()),
            ),
            LaunchError::Spawn { program, message } => {
                write!(formatter, "无法启动 core sidecar（{}）：{message}", program.display())
            }
            LaunchError::NoPipe(which) => {
                write!(formatter, "core sidecar 的 {which} 没有接上管道")
            }
            LaunchError::RelativeDataDir(path) => write!(
                formatter,
                "sidecar 的数据目录必须是绝对路径（收到 {}）：相对路径会随启动目录漂移",
                path.display()
            ),
        }
    }
}

impl std::error::Error for LaunchError {}

/// node 程序覆盖值：接受绝对路径与裸命令名，其余（含相对路径）一律视为未设置。
///
/// 相对路径会随启动目录漂移，和 `HWMUSIC_DATA_DIR` 一样只收绝对路径；
/// 但裸命令名（如 `node`）是有意义的——交给 PATH 解析。
pub fn node_program_override(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Some(trimmed.to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return None;
    }
    Some(trimmed.to_string())
}

fn absolute_path_override(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    path.is_absolute().then(|| path.to_path_buf())
}

/// 启动计划：环境旋钮 → 打包后同目录二进制 → 开发期脚本；三者都没有就如实报错。
///
/// `data_dir` 必须是绝对路径：它经 argv（[`DATA_DIR_ARG`]）交给 sidecar，相对路径会随启动目录漂移。
pub fn resolve_launch(
    exe_dir: &Path,
    data_dir: &Path,
    knobs: &SidecarKnobs,
) -> Result<LaunchPlan, LaunchError> {
    if !data_dir.is_absolute() {
        return Err(LaunchError::RelativeDataDir(data_dir.to_path_buf()));
    }
    let data_dir_args = [
        OsString::from(DATA_DIR_ARG),
        data_dir.as_os_str().to_os_string(),
    ];
    let node = node_program_override(knobs.node_bin.as_deref()).unwrap_or_else(|| "node".to_string());

    if let Some(script) = absolute_path_override(knobs.script.as_deref()) {
        let mut args = vec![script.into_os_string()];
        args.extend(data_dir_args);
        return Ok(LaunchPlan {
            program: PathBuf::from(node),
            args,
            source: LaunchSource::OverrideScript,
        });
    }

    // 打包后：与应用同目录（Tauri externalBin 复制后剥掉三元组后缀）
    let expected = exe_dir.join(sidecar_binary_name());
    if expected.is_file() {
        return Ok(LaunchPlan {
            program: expected,
            args: data_dir_args.to_vec(),
            source: LaunchSource::PackagedSibling,
        });
    }
    // 也认不带扩展名的写法（跨平台构建/手工放置）
    let stem = exe_dir.join(SIDECAR_BIN_STEM);
    if stem.is_file() {
        return Ok(LaunchPlan {
            program: stem,
            args: data_dir_args.to_vec(),
            source: LaunchSource::PackagedSibling,
        });
    }

    if let Some(script) = knobs.dev_script.as_ref().filter(|path| path.is_file()) {
        let mut args = vec![script.clone().into_os_string()];
        args.extend(data_dir_args);
        return Ok(LaunchPlan {
            program: PathBuf::from(node),
            args,
            source: LaunchSource::DevScript,
        });
    }

    Err(LaunchError::NoCore {
        exe_dir: exe_dir.to_path_buf(),
        expected,
    })
}

/// child 句柄槽：帧泵线程（取退出码）与收尸路径（kill/wait）共享。
type ChildSlot = Arc<Mutex<Option<Child>>>;

/// 一个活着的 sidecar 进程 + 它的帧泵线程。
pub struct SidecarProcess {
    plan: LaunchPlan,
    shared: Arc<CoreShared>,
    child: ChildSlot,
    stdout: Mutex<Option<BufReader<ChildStdout>>>,
    pumps: Mutex<Vec<JoinHandle<()>>>,
    terminated: AtomicBool,
}

impl SidecarProcess {
    /// 起进程并把 stdio 接上桥；帧泵由 [`SidecarProcess::start_pump`] 启动。
    pub fn spawn(plan: &LaunchPlan) -> Result<Self, LaunchError> {
        let mut command = Command::new(&plan.program);
        command
            .args(&plan.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = command.spawn().map_err(|source| LaunchError::Spawn {
            program: plan.program.clone(),
            message: source.to_string(),
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(LaunchError::NoPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(LaunchError::NoPipe("stdout"))?;

        Ok(Self {
            plan: plan.clone(),
            shared: CoreShared::new(Box::new(stdin)),
            child: Arc::new(Mutex::new(Some(child))),
            stdout: Mutex::new(Some(BufReader::new(stdout))),
            pumps: Mutex::new(Vec::new()),
            terminated: AtomicBool::new(false),
        })
    }

    pub fn shared(&self) -> &Arc<CoreShared> {
        &self.shared
    }

    pub fn plan(&self) -> &LaunchPlan {
        &self.plan
    }

    /// 双线程：帧泵线程阻塞读 stdout（绝不放主线程），效果线程落地要做副作用的部分
    /// （`app.emit`、系统通知都不能占着阻塞读的线程）。
    pub fn start_pump<F>(&self, apply: F) -> Result<(), LaunchError>
    where
        F: Fn(Effect) + Send + 'static,
    {
        let reader = lock(&self.stdout).take().ok_or(LaunchError::NoPipe("stdout"))?;
        let shared = Arc::clone(&self.shared);
        let child = Arc::clone(&self.child);
        let (sender, receiver) = std::sync::mpsc::channel::<Effect>();

        let pump = thread::spawn(move || {
            let mut reader = reader;
            let mut decoder = FrameDecoder::default();
            let mut buffer = String::new();
            let policy = FramePolicy::default();

            loop {
                buffer.clear();
                match reader.read_line(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {
                        for line in decoder.push(&buffer) {
                            match classify_line(&line, &policy) {
                                LineOutcome::Response(frame) => {
                                    let id = frame.id.clone();
                                    if !shared.settle_response(frame) {
                                        let _ = sender.send(Effect::Notice(format!(
                                            "收到无人认领的响应帧（id={id}）：二次回调或超时后迟到"
                                        )));
                                    }
                                }
                                LineOutcome::Effect(effect) => {
                                    if sender.send(effect).is_err() {
                                        // 效果线程已退出：继续读下去只会积累无人处理的效果
                                        return;
                                    }
                                }
                                LineOutcome::Reject { id, error } => match id {
                                    Some(id) => {
                                        if !shared.respond(&id, Err(error)) {
                                            let _ = sender.send(Effect::Notice(
                                                "白名单外的请求既没得到答复也没被记下".to_string(),
                                            ));
                                        }
                                    }
                                    None => {
                                        let _ = sender.send(Effect::Notice(error.message));
                                    }
                                },
                            }
                        }
                    }
                    Err(source) => {
                        let _ = sender.send(Effect::Notice(format!("读 sidecar stdout 失败：{source}")));
                        break;
                    }
                }
            }

            if let Some(rest) = decoder.end() {
                // **绝不落全文**：这半帧可能正是带着凭据的一帧（凭据纪律，见 `frame_excerpt`）。
                // 进 Notice 的只有前 64 字节摘要 + 总长度，够排障、不够泄露。
                let _ = sender.send(Effect::Notice(format!(
                    "sidecar stdout 在半个帧上结束（只留前 64 字节）：{}",
                    frame_excerpt(&rest)
                )));
            }

            let code = reap(&child, SHUTDOWN_GRACE);
            let gone = CoreError::new("core_gone", format!("sidecar 进程已退出（退出码 {code:?}）"));
            let settled = shared.core_gone(gone);
            log::info!("core 进程结束：退出码 {code:?}，结清在途调用 {settled} 个");
            let _ = sender.send(Effect::CoreGone { code });
        });

        let effects = thread::spawn(move || {
            while let Ok(effect) = receiver.recv() {
                apply(effect);
            }
        });

        lock(&self.pumps).extend([pump, effects]);
        Ok(())
    }

    /// 收尸（幂等）：关写入端 → 等它自己退出（stdin EOF → exit(0)）→ 超时才 kill。
    ///
    /// 这是 `RunEvent::ExitRequested`/`Exit` 的落点：tao 在 Windows 上 `run_return` 之后
    /// 直接 `process::exit`，`Drop` 不会执行，所以必须显式收尸。
    pub fn terminate(&self, reason: &str) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        log::info!(
            "core 收尸（{reason}）：关闭写入端并等待退出（在途调用 {} 个）",
            self.shared.pending_len()
        );
        self.shared.close_write_end();
        if let Some(code) = reap(&self.child, SHUTDOWN_GRACE) {
            log::info!("core 已退出（退出码 {code:?}）");
        }
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate("Drop 兜底");
    }
}

/// 有界等待子进程退出：期间每轮短暂持锁，避免与帧泵线程互相卡住。
fn reap(child: &ChildSlot, grace: Duration) -> Option<i32> {
    let deadline = Instant::now() + grace;
    loop {
        {
            let mut guard = lock(child);
            let Some(process) = guard.as_mut() else {
                return None;
            };
            match process.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(source) => {
                    log::warn!("等待 core 退出失败：{source}");
                    return None;
                }
            }
            if Instant::now() >= deadline {
                log::warn!("core 未在 {grace:?} 内退出，强制 kill");
                let _ = process.kill();
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use serde_json::json;

    /// 测试用临时根目录：放 `src-tauri/target/` 下（构建产物区，已在 .gitignore 内）。
    ///
    /// 刻意不用系统临时目录：本机沙箱会拒绝工作区外的写入（os error 5）。
    fn test_tmp_root() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("sidecar-test-tmp");
        std::fs::create_dir_all(&root).expect("测试临时根目录必须能建");
        root
    }

    /// 造一个"打包后目录"：里面放一个同名 sidecar 二进制（内容无所谓，只验计划选择）。
    fn temp_exe_dir(label: &str, with_sibling: bool) -> PathBuf {
        let dir = test_tmp_root().join(format!("exe-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("临时目录必须能建");
        if with_sibling {
            std::fs::write(dir.join(sidecar_binary_name()), b"not a real binary")
                .expect("占位二进制必须能写");
        }
        dir
    }

    fn temp_dev_script(label: &str) -> PathBuf {
        let path = test_tmp_root().join(format!("dev-{label}-{}.mjs", std::process::id()));
        std::fs::write(&path, "// 占位（测试用开发期脚本）\n").expect("占位脚本必须能写");
        path
    }

    /// 测试用数据目录：绝对路径（sidecar 只接受绝对路径，相对路径会随启动目录漂移）。
    fn temp_data_dir(label: &str) -> PathBuf {
        let dir = test_tmp_root().join(format!("data-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("测试数据目录必须能建");
        dir
    }

    fn data_dir_args(dir: &Path) -> Vec<OsString> {
        vec![OsString::from(DATA_DIR_ARG), dir.as_os_str().to_os_string()]
    }

    fn cleanup(paths: &[&Path]) {
        for path in paths {
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    #[test]
    fn launch_override_script_uses_node_override() {
        let script = temp_dev_script("override");
        let node = test_tmp_root().join(if cfg!(windows) { "node.exe" } else { "node" });
        let data = temp_data_dir("override");
        let knobs = SidecarKnobs {
            node_bin: Some(node.to_string_lossy().into_owned()),
            script: Some(script.to_string_lossy().into_owned()),
            dev_script: None,
        };
        let plan = resolve_launch(&test_tmp_root(), &data, &knobs).expect("覆盖旋钮必须生效");

        assert_eq!(plan.source, LaunchSource::OverrideScript);
        assert_eq!(plan.program, node);
        let mut expected = vec![script.clone().into_os_string()];
        expected.extend(data_dir_args(&data));
        assert_eq!(plan.args, expected, "数据目录必须跟在脚本后面传给 sidecar");
        cleanup(&[&script]);
    }

    #[test]
    fn launch_override_rejects_relative_or_blank_script() {
        let dev = temp_dev_script("relative");
        let data = temp_data_dir("relative");
        for bad in ["", "   ", "src/sidecar/main.mjs", "./main.mjs", "..\\main.mjs"] {
            let knobs = SidecarKnobs {
                node_bin: None,
                script: Some(bad.to_string()),
                dev_script: Some(dev.clone()),
            };
            let plan = resolve_launch(Path::new("C:\\app"), &data, &knobs)
                .unwrap_or_else(|error| panic!("{bad:?} 应视为未设置并落到开发期脚本，实际 {error}"));
            assert_eq!(plan.source, LaunchSource::DevScript, "{bad:?} 不该被当成脚本路径");
        }
        cleanup(&[&dev]);
    }

    #[test]
    fn launch_prefers_packaged_sibling_over_dev_script() {
        let dir = temp_exe_dir("sibling", true);
        let dev = temp_dev_script("sibling");
        let data = temp_data_dir("sibling");
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: Some(dev.clone()),
        };
        let plan = resolve_launch(&dir, &data, &knobs).expect("同目录二进制必须被选中");

        assert_eq!(plan.source, LaunchSource::PackagedSibling);
        assert_eq!(plan.program, dir.join(sidecar_binary_name()));
        assert_eq!(
            plan.args,
            data_dir_args(&data),
            "打包后的 sidecar 唯一的参数就是数据目录"
        );
        cleanup(&[&dir, &dev]);
    }

    #[test]
    fn launch_dev_fallback_points_at_real_sidecar_entry() {
        let dir = temp_exe_dir("dev", false);
        let data = temp_data_dir("dev");
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: Some(fallback_dev_script().expect("debug 构建必须有开发期脚本回退")),
        };
        let plan = resolve_launch(&dir, &data, &knobs).expect("开发期必须能落到仓库里的 sidecar 脚本");

        assert_eq!(plan.source, LaunchSource::DevScript);
        assert_eq!(plan.program, PathBuf::from("node"));
        let script = PathBuf::from(plan.args.first().expect("开发期必须带脚本参数"));
        assert!(script.exists(), "回退脚本必须真实存在：{}", script.display());
        assert!(
            script.ends_with(Path::new("src").join("sidecar").join("main.mjs")),
            "回退脚本应为 src/sidecar/main.mjs，实际 {}",
            script.display()
        );
        assert_eq!(&plan.args[1..], data_dir_args(&data).as_slice());
        cleanup(&[&dir]);
    }

    #[test]
    fn launch_without_any_core_is_error() {
        let dir = temp_exe_dir("missing", false);
        let data = temp_data_dir("missing");
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: None,
        };
        match resolve_launch(&dir, &data, &knobs) {
            Ok(plan) => panic!("没有任何 core 可用时必须报错，实际 {plan:?}"),
            Err(error) => {
                let text = error.to_string();
                assert!(text.contains("hwmusic-core"), "错误要说清缺什么：{text}");
            }
        }
        cleanup(&[&dir]);
    }

    #[test]
    fn launch_rejects_relative_data_dir() {
        let dir = temp_exe_dir("relative-data", true);
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: None,
        };
        for bad in ["data", ".", "..\\data", "./data"] {
            match resolve_launch(&dir, Path::new(bad), &knobs) {
                Err(LaunchError::RelativeDataDir(path)) => {
                    assert_eq!(path, Path::new(bad), "错误要原样带回那个相对路径");
                }
                other => panic!("{bad:?} 是相对路径，必须被拒（会随启动目录漂移），实际 {other:?}"),
            }
        }
        cleanup(&[&dir]);
    }

    #[test]
    fn node_bin_override_accepts_bare_name_and_rejects_relative_path() {
        assert_eq!(node_program_override(Some("node")).as_deref(), Some("node"));
        let absolute = test_tmp_root().join(if cfg!(windows) { "node.exe" } else { "node" });
        assert_eq!(
            node_program_override(Some(&absolute.to_string_lossy())).as_deref(),
            Some(absolute.to_string_lossy().as_ref())
        );
        assert_eq!(node_program_override(Some("  ")), None);
        assert_eq!(node_program_override(Some("./node")), None, "相对路径会随启动目录漂移");
        assert_eq!(node_program_override(Some("tools\\node.exe")), None);
    }

    #[test]
    fn pump_round_trip_with_real_sidecar_process() {
        let Some(dev_script) = fallback_dev_script() else {
            eprintln!("跳过：release 构建没有开发期脚本回退");
            return;
        };
        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: Some(dev_script),
        };
        let data = temp_data_dir("pump");
        let plan = match resolve_launch(&std::env::temp_dir(), &data, &knobs) {
            Ok(plan) => plan,
            Err(error) => panic!("开发期启动计划必须可解析：{error}"),
        };

        let process = match SidecarProcess::spawn(&plan) {
            Ok(process) => Arc::new(process),
            Err(error) => {
                eprintln!("跳过：起不了真实 sidecar（{error}）");
                return;
            }
        };

        let effects = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&effects);
        process
            .start_pump(move |effect| sink.lock().unwrap().push(effect))
            .expect("帧泵必须能起来");

        // 真 sidecar 对白名单频道回**确定的答复**（不是超时、不是挂起）。
        // `auth:login` 自 R7 起是长轮询：立刻回"已受理"，真正的结论经 `auth:status` 广播送达
        // （渲染层那条 core_call 链路有 60 秒上限，等不了 10 分钟的扫码）。
        let ack = process
            .shared()
            .call("auth:login", json!({}), Duration::from_secs(20))
            .expect("auth:login 必须立刻回「已受理」而不是挂起");
        assert_eq!(ack.get("started"), Some(&json!(true)), "回执要说清「只是受理了」：{ack}");

        // 收尸：关写入端 → sidecar 自己 exit(0) → 帧泵 EOF → CoreGone{code: Some(0)}
        let started = Instant::now();
        process.terminate("测试收尸");
        assert!(
            wait_for(Duration::from_secs(15), || {
                effects
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|effect| matches!(effect, Effect::CoreGone { .. }))
            }),
            "收尸后帧泵必须报 CoreGone，实际 {:?}",
            effects.lock().unwrap()
        );
        let core_gone = effects
            .lock()
            .unwrap()
            .iter()
            .find_map(|effect| match effect {
                Effect::CoreGone { code } => Some(*code),
                _ => None,
            })
            .flatten();
        assert_eq!(core_gone, Some(0), "sidecar 收到 stdin EOF 应以 0 退出（双向收尸）");
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(process.shared().is_closed());
    }

    fn wait_for(deadline: Duration, mut condition: impl FnMut() -> bool) -> bool {
        let started = Instant::now();
        while started.elapsed() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        condition()
    }

    /// R6 端到端：真 sidecar 读真 `settings.json` → 广播 `app:notice` → 宿主帧泵收到 `Effect::Emit`。
    ///
    /// 这条横跨进程边界：证的不是"某个函数返回了什么"，而是**启动提示真的能被宿主收到**
    /// （旧仓缺陷正是"启动期 emit 发进空气"）。凭据只允许停在磁盘上，绝不进提示文本。
    #[test]
    fn proxy_startup_notice_reaches_the_host_pump_without_credentials() {
        let Some(dev_script) = fallback_dev_script() else {
            eprintln!("跳过：release 构建没有开发期脚本回退");
            return;
        };
        let data = temp_data_dir("proxy-notice");
        std::fs::write(
            data.join(crate::webview_proxy::SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"data":{"proxy":{"enabled":true,"host":"proxy.local","port":8080,"username":"notice-user","password":"notice-secret"}}}"#,
        )
        .expect("设置文件必须能写");

        let knobs = SidecarKnobs {
            node_bin: None,
            script: None,
            dev_script: Some(dev_script),
        };
        let plan = match resolve_launch(&std::env::temp_dir(), &data, &knobs) {
            Ok(plan) => plan,
            Err(error) => panic!("开发期启动计划必须可解析：{error}"),
        };
        let process = match SidecarProcess::spawn(&plan) {
            Ok(process) => Arc::new(process),
            Err(error) => {
                eprintln!("跳过：起不了真实 sidecar（{error}）");
                return;
            }
        };

        let effects = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&effects);
        process
            .start_pump(move |effect| sink.lock().unwrap().push(effect))
            .expect("帧泵必须能起来");

        let arrived = wait_for(Duration::from_secs(20), || {
            effects
                .lock()
                .unwrap()
                .iter()
                .any(|effect| matches!(effect, Effect::Emit { channel, .. } if channel == "app:notice"))
        });
        let notice = effects
            .lock()
            .unwrap()
            .iter()
            .find_map(|effect| match effect {
                Effect::Emit { channel, payload } if channel == "app:notice" => {
                    payload["text"].as_str().map(str::to_string)
                }
                _ => None,
            });
        process.terminate("测试收尸");

        let notice = notice.unwrap_or_else(|| {
            panic!(
                "启动提示必须到达宿主帧泵，实际效果：{:?}",
                effects.lock().unwrap()
            )
        });
        assert!(arrived);
        assert!(notice.contains("proxy.local:8080"), "提示要说清 host:port：{notice}");
        assert!(!notice.contains("notice-user"), "提示里不得出现用户名：{notice}");
        assert!(!notice.contains("notice-secret"), "提示里不得出现密码：{notice}");
    }
}
