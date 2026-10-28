/**
 * 打包链契约测试：只钉打包链自己的正确性，不重复功能断言。
 * 覆盖 dist:win 编排与 mtime 新鲜度、check:nsis 静态校验、test:browser 口径与 CI 工作流。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const readJson = (relative) => JSON.parse(read(relative));

const TMP = `${repoRoot}.tmp/packaging-test`;

// ---------------------------------------------------------------------------
// 1. 脚本入口（package.json）
// ---------------------------------------------------------------------------

test("scripts：打包链的八个入口都在，且都是直接路径风格（本机 npx 被禁）", () => {
  const { scripts } = readJson("package.json");
  const expected = {
    test: /node\s+--test/,
    "test:acceptance": /scripts\/acceptance\.mjs/,
    "test:browser": /scripts\/test-browser\.mjs/,
    "smoke:build": /scripts\/tauri-smoke\.mjs/,
    "dist:sidecar": /scripts\/build-sidecar\.mjs/,
    "dist:win": /scripts\/dist-win\.mjs/,
    "check:nsis": /scripts\/check-nsis-package\.mjs/,
    "release:checksums": /scripts\/release-checksums\.mjs/,
  };
  for (const [name, pattern] of Object.entries(expected)) {
    assert.ok(typeof scripts[name] === "string" && scripts[name] !== "", `package.json 缺 scripts.${name}`);
    assert.match(scripts[name], pattern, `scripts.${name} 必须直接指文件路径：${scripts[name]}`);
    assert.doesNotMatch(scripts[name], /\bnpx\b/, `scripts.${name} 不许用 npx（本机 PowerShell SecurityError）`);
  }
  assert.doesNotMatch(scripts["dist:win"], /&&/, "编排在 dist-win.mjs 里做，不靠 shell 串命令");
});

// 2. tauri.conf.json：externalBin 只声明 sidecar 一项，beforeBuildCommand 仍是空串（编排归 dist 脚本）。

test("tauri.conf.json：externalBin 按 R2 裁决加回，且 beforeBuildCommand 仍是空串（编排归 dist 脚本）", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  assert.deepEqual(
    conf.bundle.externalBin,
    ["binaries/hwmusic-core"],
    "Tauri 复制 externalBin 时剥三元组后缀，配置里写的是不带三元组的名字",
  );
  assert.equal(conf.build.beforeBuildCommand, "", "空串是刻意的：渲染层构建由 dist-win.mjs 统一编排");
  assert.equal(conf.build.frontendDist, "../out/renderer");
  assert.deepEqual(conf.bundle.targets, ["nsis"]);
});

// ---------------------------------------------------------------------------
// 3. build-sidecar：三元组、命名、两层 esbuild、SEA 熔丝
// ---------------------------------------------------------------------------

test("dist:sidecar：三元组与 externalBin 命名（Tauri 认 <stem>-<triple>.exe）", async () => {
  const mod = await import("../scripts/build-sidecar.mjs");
  assert.equal(mod.SIDECAR_STEM, "hwmusic-core");
  assert.equal(mod.hostTriple("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(mod.hostTriple("win32", "arm64"), "aarch64-pc-windows-msvc");
  assert.equal(mod.sidecarBinaryName("x86_64-pc-windows-msvc"), "hwmusic-core-x86_64-pc-windows-msvc.exe");
  assert.throws(() => mod.hostTriple("sunos", "sparc"), /不支持|未知/, "不认识的平台不许猜三元组");
});

test("dist:sidecar：SEA 只跑 CJS，而入口有顶层 await —— 用两层 esbuild（ESM 包体 → CJS 主体）", async () => {
  const mod = await import("../scripts/build-sidecar.mjs");
  const passes = mod.esbuildPasses();
  assert.equal(passes.length, 2, "一层 esbuild 过不去（cjs 输出不支持顶层 await），必须是两层");
  assert.equal(passes[0].format, "esm", "第一层先出 ESM：esbuild 会把顶层 await 收进 __esm 闭包");
  assert.equal(passes[1].format, "cjs", "第二层转 CJS：SEA 的嵌入入口只支持 CJS");
  for (const pass of passes) {
    assert.deepEqual(pass.external, ["node:*"], "只有 node:* 是外部的（undici 必须打进来）");
    assert.equal(pass.platform, "node");
    assert.equal(pass.bundle, true);
  }
  assert.equal(mod.SEA_FUSE, "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2");
  assert.equal(mod.SEA_BLOB_RESOURCE_NAME, "NODE_SEA_BLOB");
});

test("dist:sidecar：双模式自验证的口径写死在脚本里（memory-only 与 secure 分支各一条）", async () => {
  const mod = await import("../scripts/build-sidecar.mjs");
  const modes = mod.selfCheckModes({ dataDir: "C:\\tmp\\x" });
  assert.deepEqual(modes.map((mode) => mode.id), ["memory-only", "secure"]);
  const [memory, secure] = modes;
  assert.deepEqual(memory.args, [], "memory-only 模式不传 --data-dir（这就是「没有数据目录」那条分支）");
  assert.ok(
    memory.expectStderr.test("[hwmusic-core] 没有数据目录：设置只给内存里的默认值"),
    "memory-only 的结论要认「没有数据目录」这句",
  );
  assert.deepEqual(secure.args, ["--data-dir", "C:\\tmp\\x"], "secure 模式要带数据目录才会有 DPAPI 信封读路径");
  assert.ok(secure.sessionFile, "secure 模式要预置一个信封，否则解密封装根本不会被走到");
  assert.ok(
    secure.expectStderr.test("[hwmusic-core] 登录状态恢复：已登录（verify_unavailable，未验证）"),
    "secure 的结论要认「已登录」这句（解密成功才算这条链路通了）",
  );
  assert.match(secure.expectHostChannel, /^host:secure-decrypt$/);
});

// ---------------------------------------------------------------------------
// 4. dist-win：编排顺序 + mtime 新鲜度检查（含"旧产物触发 fail"）
// ---------------------------------------------------------------------------

test("dist:win：编排顺序是 build:web → dist:sidecar → tauri build（beforeBuildCommand 是空串）", async () => {
  const mod = await import("../scripts/dist-win.mjs");
  assert.deepEqual(
    mod.BACKEND_STEPS.map((step) => step.id),
    ["build:web", "dist:sidecar", "tauri:build"],
  );
  for (const step of mod.BACKEND_STEPS) {
    assert.ok(Array.isArray(step.args) && step.args.length > 0, `${step.id} 要给确切的命令`);
  }
  assert.match(mod.BACKEND_STEPS[0].args.join(" "), /vite/, "渲染层产物只能由 vite build 生成");
  assert.match(mod.BACKEND_STEPS[2].args.join(" "), /tauri/, "最后一步是 tauri build");
});

test("dist:win：mtime 新鲜度检查——渲染层产物比 exe 新就是失败（防嵌旧界面且退出码 0）", async () => {
  const mod = await import("../scripts/dist-win.mjs");
  const exe = { path: "target/release/app.exe", mtimeMs: 1000 };
  const fresh = [{ path: "out/renderer/index.html", mtimeMs: 900 }];
  const stale = [{ path: "out/renderer/index.html", mtimeMs: 1100 }];

  assert.deepEqual(mod.freshnessProblems({ appExe: exe, rendererArtifacts: fresh }), [], "产物比 exe 旧 = 正常");
  const problems = mod.freshnessProblems({ appExe: exe, rendererArtifacts: stale });
  assert.equal(problems.length, 1, "旧产物必须被判失败");
  assert.match(problems[0], /index\.html/, "失败理由要点名是哪个产物比 exe 新");
  assert.equal(mod.freshnessProblems({ appExe: null, rendererArtifacts: fresh }).length, 1, "exe 不在也要 fail");
  assert.equal(mod.freshnessProblems({ appExe: exe, rendererArtifacts: [] }).length, 1, "渲染层产物为空也要 fail");
});

test("dist:win：新鲜度检查走真实文件（旧 exe + 新产物 → 非空违规）", async (t) => {
  const mod = await import("../scripts/dist-win.mjs");
  const dir = `${TMP}/freshness`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/out/renderer`, { recursive: true });
  mkdirSync(`${dir}/target/release`, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const exePath = `${dir}/target/release/app.exe`;
  const artifactPath = `${dir}/out/renderer/index.html`;
  writeFileSync(exePath, "MZ");
  writeFileSync(artifactPath, "<html></html>");
  // exe 停在 2020，产物刚写 → 产物比 exe 新 6 年
  utimesSync(exePath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));

  const stale = await mod.collectFreshnessProblems({
    appExePath: exePath,
    rendererDir: `${dir}/out/renderer`,
  });
  assert.equal(stale.length, 1, `旧 exe 必须触发失败：${JSON.stringify(stale)}`);
  assert.match(stale[0], /index\.html/);

  // 反过来：exe 最新 → 无违规
  writeFileSync(exePath, "MZ");
  const ok = await mod.collectFreshnessProblems({
    appExePath: exePath,
    rendererDir: `${dir}/out/renderer`,
  });
  assert.deepEqual(ok, []);
});

// ---------------------------------------------------------------------------
// 5. check-nsis：静态校验骨架
// ---------------------------------------------------------------------------

test("check:nsis：暂存名靠剥三元组后缀推导，不写死", async () => {
  const mod = await import("../scripts/check-nsis-package.mjs");
  assert.equal(mod.stripTripleSuffix("hwmusic-core-x86_64-pc-windows-msvc.exe"), "hwmusic-core.exe");
  assert.equal(mod.stripTripleSuffix("hwmusic-core.exe"), "hwmusic-core.exe", "已经剥过的不再动");
  assert.equal(mod.stripTripleSuffix("app.exe"), "app.exe", "主程序名不带三元组");
  assert.equal(mod.stripTripleSuffix("华为音乐第三方客户端.exe"), "华为音乐第三方客户端.exe");
});

test("check:nsis：PE 头校验认 MZ + PE\\0\\0，垃圾文件不算可执行", async () => {
  const mod = await import("../scripts/check-nsis-package.mjs");
  const nodeExe = readFileSync(process.execPath);
  const head = mod.peHeader(nodeExe);
  assert.equal(head.mz, true, "真 node.exe 必须有 MZ");
  assert.equal(head.pe, true, "真 node.exe 必须有 PE 签名");
  assert.equal(mod.peHeader(Buffer.from("not an exe at all")).mz, false);
  assert.equal(mod.peHeader(Buffer.alloc(0)).mz, false);
});

test("check:nsis：bundle 配置输入与暂存目录都不得碰 .local / research（凭据纪律）", async () => {
  const mod = await import("../scripts/check-nsis-package.mjs");
  assert.deepEqual(
    mod.sensitiveBundleInputs({ externalBin: ["binaries/hwmusic-core"], icon: ["icons/icon.ico"] }),
    [],
  );
  const badConfig = mod.sensitiveBundleInputs({
    resources: [".local/session.enc"],
    icon: ["research/notes/icon.ico"],
  });
  assert.equal(badConfig.length, 2, `配置锚要有牙：${JSON.stringify(badConfig)}`);

  assert.deepEqual(mod.sensitiveStagedPaths(["app.exe", "hwmusic-core.exe"]), []);
  const badStaged = mod.sensitiveStagedPaths(["app.exe", ".local/session.enc", "research/live/x.json"]);
  assert.equal(badStaged.length, 2);
});

test("check:nsis：校验清单覆盖简报要求的六项（缺一项就少一道闸）", async () => {
  const mod = await import("../scripts/check-nsis-package.mjs");
  assert.deepEqual(mod.CHECK_IDS, [
    "installer-unique",
    "installer-pe",
    "sidecar-triple-name",
    "sidecar-pe",
    "staging-enumeration",
    "staged-sidecar",
    "bundle-config",
    "staging-sensitive",
  ]);
});

test("check:nsis：暂存目录 readdir 失败不吞（报结构化失败，不当空目录）", async () => {
  const mod = await import("../scripts/check-nsis-package.mjs");
  const failed = await mod.enumerateStaging(`${TMP}/does-not-exist-at-all`);
  assert.equal(failed.ok, false, "不存在/读不了的暂存目录必须是失败，不能静默当作「里面没东西」");
  assert.ok(failed.error && /ENOENT|no such file/i.test(failed.error), `要带出原因：${failed.error}`);
});

// ---------------------------------------------------------------------------
// 6. acceptance：六条路径引用既有锚点（不复制断言逻辑）
// ---------------------------------------------------------------------------

test("acceptance：六条关键路径与简报一致，且引用的测试文件/锚点文件都真实存在", async () => {
  const mod = await import("../scripts/acceptance.mjs");
  assert.deepEqual(mod.ACCEPTANCE_PATHS.map((path) => path.id), [
    "login-gate",
    "proxy",
    "tray",
    "desktop-lyrics",
    "taskbar-fallback-no-injection",
    "settings-persistence",
  ]);
  for (const path of mod.ACCEPTANCE_PATHS) {
    assert.ok(path.tests.length > 0, `${path.id} 必须引用既有测试文件（不复制断言逻辑）`);
    for (const relative of path.tests) {
      assert.ok(readFileSync(`${repoRoot}${relative}`, "utf8").length > 0, `${path.id} 引用的 ${relative} 不存在`);
    }
    for (const anchor of path.anchors) {
      assert.ok(readFileSync(`${repoRoot}${anchor.file}`, "utf8").length > 0, `${path.id} 的锚点文件 ${anchor.file} 不存在`);
      assert.ok(anchor.pattern instanceof RegExp, `${path.id} 的锚点 ${anchor.file} 必须给正则`);
    }
  }
  const noInjection = mod.ACCEPTANCE_PATHS.find((path) => path.id === "taskbar-fallback-no-injection");
  assert.ok(noInjection.scanTree, "任务栏降级那条要带全源码扫描（16 类注入 API 零命中）");
});

test("acceptance：无注入扫描的 token 表从 R12 的既有测试里读（引用而不是复制一份会漂移的清单）", async () => {
  const mod = await import("../scripts/acceptance.mjs");
  const tokens = mod.parseBannedTokens(read("test/lyrics-window.test.mjs"));
  assert.ok(tokens.length >= 15, `解析出的 token 太少（${tokens.length}），锚点表可能变了`);
  assert.ok(tokens.includes("SetWindowsHookEx"), "canary：解析结果必须含 SetWindowsHookEx，否则扫描等于没扫");
  assert.ok(tokens.includes("explorer.exe"));
  assert.equal(mod.nativeTokenAllowed("src-tauri/src/taskbar_lyrics.rs", "SetParent"), true);
  for (const file of ["src-tauri/src/lyrics_window.rs", "src-tauri/src/taskbar_lyrics.rs.bak", "src/renderer/taskbar_lyrics.rs"]) assert.equal(mod.nativeTokenAllowed(file, "SetParent"), false);
  for (const token of ["SetWindowsHookEx", "SetWinEventHook", "SendInput", "CreateRemoteThread", "WriteProcessMemory"]) assert.equal(mod.nativeTokenAllowed("src-tauri/src/taskbar_lyrics.rs", token), false);
});

test("R44d native 写扫描只允许以 ensure_own 包裹的显式受核 HWND，不按参数名放行", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  assert.deepEqual(taskbarWriteViolations("unsafe { SetParent(self::ensure_own(policy, own)?, Some(parent)); SetWindowPos(self::ensure_own(policy, own)?, None, 0, 0, 1, 1, flags); }"), []);
  for (const fn of ["SetParent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "SetWindowSubclass", "EnableWindow"]) {
    assert.equal(taskbarWriteViolations(`${fn}(parent, None);`).length, 1, `${fn} foreign must be rejected`);
    assert.equal(taskbarWriteViolations(`${fn}(own, None);`).length, 1, `${fn} 不能靠变量名绕过核验`);
    assert.equal(taskbarWriteViolations(`${fn}(handle, None);`).length, 1, `${fn} 不能靠通用句柄名绕过核验`);
    assert.equal(taskbarWriteViolations(`${fn}(self::ensure_own(token)?, None);`).length, 0, `${fn} 显式 own guard 可通过`);
  }

  // 前缀不是凭证：每条绕过都必须恰好点名 1 次，既不放大也不重复计数。
  const bypasses = [
    ["SetWindowLongPtrW(ensure_own(policy, own).unwrap_or(hwnd(foreign)), index, value)", "`.unwrap_or(foreign)` 兜底"],
    ["ShowWindow(ensure_own(policy, own).unwrap_or_else(|_| hwnd(foreign)), SW_HIDE)", "`.unwrap_or_else(foreign)` 兜底"],
    ["SetWindowPos(ensure_own(policy, own).map_or(hwnd(foreign), |h| h), None, 0, 0, 1, 1, flags)", "`.map_or(foreign, ...)` 兜底"],
    ["EnableWindow(ensure_own(policy, own).map(|_| hwnd(foreign)), false)", "`.map(...)` 改写目标"],
    ["ShowWindow((ensure_own(policy, own)?), SW_HIDE)", "整体多包一层括号"],
    ["ShowWindow(ensure_own(policy, own)? as isize, SW_HIDE)", "守卫之后接 cast"],
    ["SetParent(ensure_own(policy, own), None)", "守卫少了 `?`（不是完整表达式）"],
    ["SetWindowSubclass(own_top_level(&main).unwrap_or(hwnd(foreign)), Some(p), id, data)", "子类化也不许兜底"],
    ["ShowWindow(ensure_own(policy, own)?, SW_HIDE", "调用未闭合（实参不完整）"],
    ["ShowWindow(ensure_own(policy, (own)", "守卫自己的括号不平衡"],
  ];
  for (const [snippet, why] of bypasses) {
    const violations = taskbarWriteViolations(snippet);
    assert.equal(violations.length, 1, `${why} 必须点名：${snippet} -> ${JSON.stringify(violations)}`);
  }

  // 精确的守卫表达式 + `?` 仍然放行，守卫自己的嵌套逗号不截断。
  assert.deepEqual(
    taskbarWriteViolations("unsafe { let _ = ShowWindow(self::ensure_own(&i.policy, token)?, SW_SHOWNOACTIVATE); }"),
    [],
    "`self::ensure_own(&i.policy, token)?` 这种带嵌套逗号的精确守卫要继续放行",
  );
  assert.deepEqual(
    taskbarWriteViolations("SetWindowSubclass(self::own_top_level(&main)?, Some(lyrics_proc), id, data)"),
    [],
    "`self::own_top_level(&main)?` 仅限子类化，精确形态放行",
  );

  // Rust 字符串/字符字面量里的括号与逗号既不能截断实参，也不能把外来目标藏起来。
  assert.equal(
    taskbarWriteViolations('SetParent(fallback("),"), None)').length,
    1,
    "字符串里的 `)`/`,` 不能被当成真实分隔符（外来目标仍要点名）",
  );
  assert.deepEqual(
    taskbarWriteViolations('SetParent(self::ensure_own(policy, label("("))?, None)'),
    [],
    "守卫实参里的字符串括号不能把嵌套数算错（算错就会误报或误放行）",
  );

  // Rust raw 字面量里的引号、括号、逗号都是内容，只有同 hash 数的引号才收尾。
  // 下面断言那条 raw 兜底表达式必须被点名，补平衡的同形表达式钉 raw 解析完整。
  assert.equal(
    taskbarWriteViolations('ShowWindow(ensure_own(policy, make_own(r#"" )?, hwnd(foreign))"#).unwrap_or(hwnd(foreign)), SW_HIDE)').length,
    1,
    "brief 原样的 raw 兜底表达式必须点名（raw 里的 `)`/`,`/`?` 都是内容，不能当结构）",
  );
  const rawBypass =
    'ShowWindow(ensure_own(policy, make_own(r#"" )?, hwnd(foreign))"#)).unwrap_or(hwnd(foreign)), SW_HIDE)';
  const rawBypassViolations = taskbarWriteViolations(rawBypass);
  assert.equal(rawBypassViolations.length, 1, `raw 字符串里的兜底目标必须点名：${JSON.stringify(rawBypassViolations)}`);
  assert.match(
    rawBypassViolations[0],
    /\.unwrap_or\(hwnd\(foreign\)\)/,
    "实参要完整解析到 `.unwrap_or(hwnd(foreign))`——raw 内容里的引号与分隔符字节不能把实参截断",
  );
  assert.doesNotMatch(
    rawBypassViolations[0],
    /调用未闭合/,
    "raw 字面量必须真的被解析完（靠\"未闭合\"碰巧拦住不算理解 raw，换个位置就会放行）",
  );
  for (const [fn, literal, why] of [
    ["ShowWindow", 'make_own(br#"" )?, hwnd(foreign))"#', "字节 raw 前缀 `br` 不能当普通标识符"],
    ["SetWindowPos", 'make_own(br#"" )? "#', "byte raw 里的分隔符字节不能把 `?` 之后的兜底藏掉"],
  ]) {
    assert.equal(
      taskbarWriteViolations(`${fn}(ensure_own(policy, ${literal}).unwrap_or(hwnd(foreign)), None, 0, 0, 1, 1, flags)`).length,
      1,
      `${why}：${literal}`,
    );
  }

  // 「字面量里的 `//` 不是注释」：剥注释这一步也必须认得字面量，否则同一行后面的
  // **真实**外来写会被整行抹掉，扫描结果变成 0 违规（这是 raw/普通字符串的同一条洞）。
  for (const hidden of [
    'let url = r#"https://example.test"#; unsafe { ShowWindow(hwnd(foreign), SW_HIDE); }',
    'let url = r##"a//b"##; unsafe { SetParent(hwnd(foreign), None); }',
    'let url = "https://example.test"; unsafe { ShowWindow(hwnd(foreign), SW_HIDE); }',
  ]) {
    assert.equal(taskbarWriteViolations(hidden).length, 1, `字面量里的 // 不能把同一行后面的真实写抹掉：${hidden}`);
  }

  // 未结束的 raw 一律 fail closed：解析不出来就绝不当合法。
  for (const [snippet, why] of [
    ['ShowWindow(ensure_own(policy, probe(r#"abc)?, hwnd(foreign)), SW_HIDE)', "hash 数不匹配、到输入末尾仍在 raw 里"],
    ['ShowWindow(ensure_own(policy, probe(r##"abc"#)?, hwnd(foreign)), SW_HIDE)', "两 hash 开头只给一 hash 收尾"],
    ['SetParent(probe(r#"abc, None)', "外来目标后接未结束 raw"],
    ['ShowWindow(ensure_own(policy, own)?, r#"oops)', "第二实参里的未结束 raw 也不能让调用算闭合"],
  ]) {
    assert.equal(taskbarWriteViolations(snippet).length, 1, `未结束的 raw 必须 fail closed（${why}）：${snippet}`);
  }

  // 带 raw 字面量的**合法**精确守卫调用必须继续放行：raw 里的 `)`/`,`/`"`/`\` 不外溢，
  // `r#type` 这种 raw identifier 也不是字面量。
  for (const [snippet, why] of [
    ['SetWindowPos(self::ensure_own(policy, check(r#"(,"#))?, None, 0, 0, 1, 1, flags)', "raw 里的 `(,` 不是结构"],
    ['SetParent(self::ensure_own(policy, check(r##"a")b"##))?, None)', "两 hash 分隔符里可以出现裸 `\"`"],
    ['SetWindowLongPtrW(self::ensure_own(policy, probe(br#") , ( "#))?, index, value)', "byte raw br# 里的 `)`/`(`/`,`"],
    ['EnableWindow(self::ensure_own(policy, probe(rb#"x), y("#))?, false)', "rb 前缀的 raw"],
    ['ShowWindow(self::ensure_own(policy, probe(r")raw("))?, SW_HIDE)', "零 hash 的 raw `r\"…\"`"],
    ['SetParent(self::ensure_own(policy, probe(r#"a\\"#))?, None)', "raw 里的反斜杠不是转义，`\\\"#` 照常收尾"],
    ['SetParent(self::ensure_own(policy, probe(r#"{([])}"#))?, None)', "raw 里的三种括号都不参与配对"],
    ['SetParent(self::ensure_own(policy, r#type)?, None)', "`r#type` 是 raw identifier，不是 raw 字符串"],
    ['SetWindowSubclass(self::own_top_level(&main)?, Some(probe(r#")"#)), id, data)', "子类化的第二实参里可以带 raw"],
  ]) {
    assert.deepEqual(taskbarWriteViolations(snippet), [], `带 raw 字面量的合法守卫调用必须放行（${why}）：${snippet}`);
  }
});

test("R44d I-1 follow-up 2：Rust 普通字符串可以跨行，字面量里的 // 与 /* 不是注释，未闭合必须 fail closed", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");

  // 普通字符串允许裸 LF，串里的 `//` 不是注释起点，同一行的真实外来写必须被点名。
  const controllerRepro = [
    "unsafe fn g(h: HWND) {",
    '    let _s = "abc',
    '// "; unsafe { ShowWindow(h, SW_HIDE); }',
    "}",
  ].join("\n");
  const reproViolations = taskbarWriteViolations(controllerRepro);
  assert.equal(reproViolations.length, 1, `多行串里的 // 不能把真实写抹掉：${JSON.stringify(reproViolations)}`);
  assert.match(reproViolations[0], /ShowWindow: h\b/, "实参要完整解析到真实写目标：多行串里的字节不能把实参截断");
  assert.doesNotMatch(
    reproViolations[0],
    /调用未闭合/,
    '多行普通串必须真的被解析完（靠"未闭合"碰巧拦住不算理解多行串，换个位置就放行）',
  );

  // 串里的 `/*` 是内容，不能吞掉后面的真实外来写。
  const blockCommentBypass = [
    "unsafe fn g(h: HWND) {",
    '    let _s = "abc',
    '/* "; unsafe { SetParent(hwnd(foreign), None); }',
    "}",
  ].join("\n");
  const blockViolations = taskbarWriteViolations(blockCommentBypass);
  assert.equal(blockViolations.length, 1, `多行串里的 /* 不能把后面的真实写吃掉：${JSON.stringify(blockViolations)}`);
  assert.match(blockViolations[0], /hwnd\(foreign\)/, "被吃掉的是串外那段真实写，实参要完整出现");
  assert.doesNotMatch(blockViolations[0], /调用未闭合/, "`/*` 面同样是\"多行串必须被解析完\"，不能靠未闭合拦住");

  // 反向：合法的跨行守卫调用不许误报。
  const guardedMultiline = ["ShowWindow(self::ensure_own(policy,", '"line one', 'line two")?, SW_HIDE)'].join("\n");
  assert.deepEqual(taskbarWriteViolations(guardedMultiline), [], "跨行的精确 `self::ensure_own(...)?` 守卫必须继续放行");

  // 行尾规则照 rustc：裸 LF 是内容（上面已证）；CRLF 是合法行尾；
  // `\` + LF 是续行；转义引号不是收尾；**裸 CR**（后面不是 LF）非法，fail closed。
  for (const [snippet, why] of [
    ['ShowWindow(self::ensure_own(policy, "a\r\nb")?, SW_HIDE)', "多行串里的 CRLF 是合法行尾"],
    ['ShowWindow(self::ensure_own(policy, "a\\\nb")?, SW_HIDE)', "`\\` + LF 是续行，不是字符串结束"],
    ['ShowWindow(self::ensure_own(policy, "a\\"b")?, SW_HIDE)', "转义引号 `\\\"` 不是收尾引号"],
    ['SetParent(self::ensure_own(policy, "a\n\\\nb")?, None)', "续行之后再跨一行仍在同一个串里"],
  ]) {
    assert.deepEqual(taskbarWriteViolations(snippet), [], `合法多行串必须放行（${why}）：${JSON.stringify(snippet)}`);
  }
  const bareCrViolations = taskbarWriteViolations('ShowWindow(ensure_own(policy, "a\rb")?, SW_HIDE)');
  assert.equal(bareCrViolations.length, 1, `裸 CR 不是合法行尾，必须 fail closed：${JSON.stringify(bareCrViolations)}`);
  assert.match(bareCrViolations[0], /调用未闭合/, "裸 CR 让字符串无法收尾 → 按解析失败记账");

  // 未闭合普通串：解析不出来就绝不当合法，也**不许**把后面的代码当注释吃掉。
  assert.equal(
    taskbarWriteViolations('ShowWindow(ensure_own(policy, probe("abc)?, hwnd(foreign)), SW_HIDE)').length,
    1,
    "实参里的未闭合普通串必须 fail closed",
  );
  const unterminatedThenWrite = [
    "unsafe fn g(h: HWND) {",
    '    let _s = "abc',
    "// ShowWindow(hwnd(foreign), SW_HIDE);",
    "}",
  ].join("\n");
  const unterminatedViolations = taskbarWriteViolations(unterminatedThenWrite);
  assert.equal(unterminatedViolations.length, 1, `未闭合串不许把后面的真实写剥掉：${JSON.stringify(unterminatedViolations)}`);
  assert.match(unterminatedViolations[0], /hwnd\(foreign\)/, "未闭合串之后的内容照抄原文，扫描阶段才看得见真实写");

  // 串收尾引号落在后面几行也照常算：`//` 只是内容。
  assert.equal(
    taskbarWriteViolations(['let s = "a', "// b", 'c"; unsafe { EnableWindow(hwnd(foreign), false); }'].join("\n")).length,
    1,
    "收尾引号在后面的行上时，串里的 // 依旧不是注释",
  );
  // 没有真实写时不许因为"多行串里的 //"凭空冒违规。
  assert.deepEqual(
    taskbarWriteViolations(['let url = "https://example.test', '// 还在串里";'].join("\n")),
    [],
    "多行串里的 // 是内容，串外没有写就不许报",
  );
});

// scanner 收紧：C 串前缀、嵌套块注释、闭包 shadow 守卫名、函数指针别名四种可编译绕过都要点名。

test("R44d scanner F1：cr/C 字符串 raw 前缀与多 hash 收尾必须被识别（raw 里的 // 不能抹掉同一行的真实写）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  // `cr#"…"#` 是 Rust 1.77+ 的 C 字符串 raw 前缀：`cr` 必须认成 raw 开头，否则串里的 `// ` 会把同一行的真实外来写整行抹掉。
  const bypass = 'let _s = cr#"quote " // "#; unsafe { ShowWindow(hwnd(foreign), SW_HIDE); }';
  const violations = taskbarWriteViolations(bypass);
  assert.equal(violations.length, 1, `cr#"" 里的 // 不能抹掉真实写：${JSON.stringify(violations)}`);
  assert.match(violations[0], /ShowWindow: hwnd\(foreign\)/, "被抹掉的那次写要完整点名");

  // 多 hash：收尾必须是**同样多个** `#` 紧跟引号；串里可以出现裸 `"` 与 `#`。
  for (const hidden of [
    'let _s = cr##"a " # // "##; unsafe { SetParent(hwnd(foreign), None); }',
    'let _s = cr"a // b"; unsafe { SetParent(hwnd(foreign), None); }',
    'let _s = cr#"a\\"#; unsafe { EnableWindow(hwnd(foreign), false); }',
  ]) {
    assert.equal(taskbarWriteViolations(hidden).length, 1, `C 字符串 raw 里的 // 不能抹掉真实写：${hidden}`);
  }

  // hash 数不一致 → 未结束的 raw，必须 fail closed（不许当成"串里的内容"放行）。
  assert.equal(
    taskbarWriteViolations('SetParent(self::ensure_own(policy, probe(cr##"abc"#)?, hwnd(foreign)), None)').length,
    1,
    "两 hash 开头只给一 hash 收尾：未结束的 raw 必须按解析失败记账",
  );
  // 合法：`cr` raw 里的 `"`/`(`/`)`/`,` 都是内容，不外溢。
  assert.deepEqual(
    taskbarWriteViolations('SetParent(self::ensure_own(policy, probe(cr#"a") , ("#))?, None)'),
    [],
    "cr raw 里的引号与括号是内容，精确守卫调用必须放行",
  );
  // `cr` 只是前缀：`cr` 是普通标识符时不构成字面量。
  assert.deepEqual(taskbarWriteViolations('let cr = 1; let x = cr + 1;'), [], "`cr` 当标识符用时不是字面量");
});

test("R44d scanner F2：Rust 块注释可以嵌套（深度计数；整段注释里的假写不算命中）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  // 嵌套块注释要剥到最外层 `*/`；停在第一个 `*/` 会让 ` // ignored */` 把后面的真实写整行吃掉。
  const bypass = "/* outer /* inner */ // ignored */ unsafe { ShowWindow(hwnd(foreign), SW_HIDE); }";
  const violations = taskbarWriteViolations(bypass);
  assert.equal(violations.length, 1, `嵌套块注释里的 // 不能抹掉真实写：${JSON.stringify(violations)}`);
  assert.match(violations[0], /ShowWindow: hwnd\(foreign\)/, "被抹掉的那次写要完整点名");

  // 反向：整段（含嵌套）注释里的假写必须被忽略，剥不到底就会误报。
  assert.deepEqual(
    taskbarWriteViolations("/* outer /* inner */ ShowWindow(hwnd(foreign), SW_HIDE); */ let x = 1;"),
    [],
    "整段嵌套注释里的写不是命中（停得太早就会误报）",
  );
  assert.deepEqual(
    taskbarWriteViolations("/* 1 /* 2 /* 3 */ ShowWindow(hwnd(foreign), SW_HIDE); 2 */ 1 */ let x = 1;"),
    [],
    "三层嵌套的整段注释仍要被剥掉（写在外层注释收尾之前）",
  );

  // 跨行嵌套：外层注释在后续行才收尾，之后的真实写必须点名。
  const multiline = ["/* a /* b", "   // c", "*/ still comment */ unsafe { SetParent(hwnd(foreign), None); }"].join("\n");
  assert.equal(taskbarWriteViolations(multiline).length, 1, "跨行嵌套注释收尾之后的真实写必须点名");

  // 注释里的 `/*`/`*/` 不影响字符串解析，字符串里的注释符也不是注释（既有行为，别回归）。
  assert.deepEqual(
    taskbarWriteViolations('/* " */ let _s = "/* not a comment */";'),
    [],
    "字面量里的 /* */ 不是注释，串外的块注释照旧被剥掉",
  );
});

test("R44d scanner F3：写位置必须是 canonical self:: 守卫路径（本地闭包 shadow 不算守卫）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  // canonical：写目标由 `self::ensure_own` / `self::own_top_level` 当场给出（模块路径不能被局部绑定 shadow）。
  assert.deepEqual(
    taskbarWriteViolations("SetParent(self::ensure_own(policy, own)?, None)"),
    [],
    "`self::ensure_own(...)?` 是唯一的 canonical 守卫形态",
  );
  assert.deepEqual(
    taskbarWriteViolations("SetWindowSubclass(self::own_top_level(&main)?, Some(lyrics_proc), id, data)"),
    [],
    "`self::own_top_level(...)?` 仍是子类化专用",
  );
  // 裸名不再是写位置的凭证：局部闭包可以 shadow 它。
  const shadow = [
    "fn hide(policy: &EmbedState, own: OwnWindow) -> Result<(), Reason> {",
    "    let ensure_own = |_p: &EmbedState, _o: OwnWindow| Ok::<HWND, Reason>(hwnd(9));",
    "    unsafe { SetParent(ensure_own(policy, own)?, None); } Ok(())",
    "}",
  ].join("\n");
  const shadowViolations = taskbarWriteViolations(shadow);
  assert.ok(
    shadowViolations.some((item) => item.startsWith("SetParent:")),
    `局部闭包 shadow 之后的写必须点名：${JSON.stringify(shadowViolations)}`,
  );
  assert.equal(shadowViolations.filter((item) => item.startsWith("SetParent:")).length, 1, "同一处只点一次");

  // 就算写位置已经 canonical，本地再出现一份同名绑定也必须 fail closed（不许出现第二份 ensure_own）。
  const rebound = [
    "let ensure_own = |_p: &EmbedState, _o: OwnWindow| Ok::<HWND, Reason>(hwnd(9));",
    "SetParent(self::ensure_own(policy, own)?, None)",
  ].join("\n");
  const reboundViolations = taskbarWriteViolations(rebound);
  assert.ok(reboundViolations.length >= 1, "本地 ensure_own 绑定本身不许存在");
  assert.doesNotMatch(reboundViolations.join("\n"), /SetParent:.*self::ensure_own/, "canonical 的那处写不是违规点");
  for (const [snippet, name] of [
    ["use evil::ensure_own;", "ensure_own"],
    ["use evil::helpers as own_top_level;", "own_top_level"],
    ["fn f() { let mut ensure_own = 1; }", "ensure_own"],
  ]) {
    assert.ok(
      taskbarWriteViolations(snippet).some((item) => item.startsWith(`${name}:`)),
      `导入/别名/可变绑定都不许占用守卫名：${snippet}`,
    );
  }
  // 定义必须唯一：模块里出现第二份 `fn ensure_own`（嵌套 mod 也算）一律拒绝。
  const nestedDefinition = [
    "mod helper {",
    "    fn ensure_own(_p: &EmbedState, _o: OwnWindow) -> Result<HWND, Reason> { Ok(hwnd(9)) }",
    "}",
    "fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> { Ok(hwnd(own.handle)) }",
  ].join("\n");
  assert.ok(
    taskbarWriteViolations(nestedDefinition).some((item) => item.startsWith("ensure_own:")),
    "守卫定义必须唯一（多份定义让 self:: 不再可证）",
  );
  // 裸守卫调用（非写位置的自查点）仍允许；`own_top_level` 仍只对子类化开放。
  assert.deepEqual(taskbarWriteViolations("fn f() { ensure_own(policy, own)?; }"), [], "非写位置的自查调用不报");
  assert.equal(
    taskbarWriteViolations("ShowWindow(self::own_top_level(&main)?, SW_HIDE)").length,
    1,
    "`own_top_level` 许给子类化，但不许给显隐写",
  );
});

test("R44d scanner F4：六个写 API 的别名引用（函数指针 / use as / 裸引用）必须点名", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const apis = ["SetParent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "SetWindowSubclass", "EnableWindow"];
  for (const api of apis) {
    for (const [snippet, why] of [
      [`let reparent = ${api};\nunsafe { reparent(hwnd(foreign), None); }`, "函数指针别名"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api} as reparent;\nunsafe { reparent(hwnd(foreign), None); }`, "`use … as` 别名"],
      [`let f: usize = ${api} as usize;`, "裸引用（cast）"],
      [`let table = [${api}];`, "裸引用（放进数组）"],
    ]) {
      const violations = taskbarWriteViolations(snippet);
      assert.ok(
        violations.some((item) => item.startsWith(`${api}:`)),
        `${why} 必须点名：${snippet} -> ${JSON.stringify(violations)}`,
      );
    }
    // 直接（含全路径限定）调用仍是受核调用形态：放行/点名由第一实参守卫决定。
    assert.deepEqual(
      taskbarWriteViolations(`windows::Win32::UI::WindowsAndMessaging::${api}(self::ensure_own(policy, own)?, None)`),
      [],
      `${api} 的全路径限定调用形态仍受核（守卫给了就放行）`,
    );
    assert.equal(
      taskbarWriteViolations(`windows::Win32::UI::WindowsAndMessaging::${api}(hwnd(foreign), None)`).length,
      1,
      `${api} 的全路径限定调用也必须核第一实参`,
    );
  }
  // 同名导入（没有 `as`）不是别名：它绑定的还是原名，写调用仍按名字受核。
  assert.deepEqual(
    taskbarWriteViolations("use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};"),
    [],
    "无 as 的导入不是别名（绑定名没变）",
  );
  assert.deepEqual(
    taskbarWriteViolations("use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;"),
    [],
    "单条目无 as 的导入不是别名",
  );
  // 字符串/注释里的示例不是代码，不许误报（假阳性会让真实现被噪声淹没）。
  for (const inert of [
    'let doc = "let reparent = SetParent;";',
    'let doc = "use windows::Win32::UI::WindowsAndMessaging::SetParent as reparent;";',
    "// let reparent = SetParent;\n// use x::SetWindowPos as p;",
    'let doc = "reparent = SetParent";',
  ]) {
    assert.deepEqual(taskbarWriteViolations(inert), [], `字符串/注释里的别名示例不算命中：${inert}`);
  }
  // 已知的**假阳性**（保留、不修，安全一侧）：写函数名带括号地出现在字符串内容里时，旧的
  // 调用形态扫描仍会点名。它只会多报、不会漏报；照实钉住，免得以后被当成回归或悄悄放宽。
  assert.equal(
    taskbarWriteViolations('let doc = "SetParent(hwnd(foreign), None)";').length,
    1,
    "字符串里的调用形态仍是已知假阳性（多报一侧，保留）",
  );
});

test("R44d fix：写目标必须是当场复核的表达式，先校验再绑局部别名一律算违规", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  // 缺陷形状（本仓真实出现过）：先 `ensure_own(...)` 到局部别名，写调用拿到的是别名；
  // 子类化点则是先做一次 PID/线程检查再传裸句柄。三者都必须被点名。
  const localAlias = [
    "fn hide(policy: &EmbedState, own: OwnWindow) -> Result<(), Reason> {",
    "    let own = ensure_own(policy, own)?;",
    "    unsafe { let _ = ShowWindow(own, SW_HIDE); } Ok(())",
    "}",
    "unsafe fn set_long(policy: &EmbedState, token: OwnWindow) -> Result<(), Reason> {",
    "    let own = ensure_own(policy, token)?;",
    "    SetLastError(WIN32_ERROR(0)); let previous = SetWindowLongPtrW(own, index, value);",
    "}",
    "SetWindowSubclass(handle, Some(lyrics_proc), id, data as usize)",
  ].join("\n");
  const alias = taskbarWriteViolations(localAlias);
  assert.equal(alias.length, 3, `局部别名三条都要点名：${JSON.stringify(alias)}`);
  // 点名顺序按扫描器自己的 API 清单（不是源码顺序），这里只断言"三条都在"。
  assert.deepEqual(alias.map((item) => item.split(":")[0]).sort(), ["SetWindowLongPtrW", "SetWindowSubclass", "ShowWindow"].sort());
  assert.equal(
    taskbarWriteViolations(read("src-tauri/src/taskbar_lyrics.rs")).length,
    0,
    "仓库里的真实实现不许留未复核的写目标（局部别名这种形状已经在上面证明会被点名）",
  );

  // 唯一放行的两种形态，都是**写调用现场**给出的守卫表达式（canonical `self::`：局部绑定 shadow 不到它）。
  const direct = [
    "ShowWindow(self::ensure_own(policy, own)?, SW_HIDE)",
    "SetWindowLongPtrW(self::ensure_own(policy, token)?, index, value)",
    "SetWindowSubclass(self::ensure_own(&i.policy, own)?, Some(lyrics_proc), id, data)",
    "SetWindowSubclass(self::own_top_level(&main)?, Some(lyrics_proc), id, data)",
  ].join("\n");
  assert.deepEqual(taskbarWriteViolations(direct), [], "当场由守卫表达式给出的目标才放行");

  // 第二个守卫只对子类化开放：它只核自进程/owner 线程/存活，不核创建代次，
  // 别的写（样式/位置/父/显隐/启用）不许拿它当挡箭牌。
  for (const fn of ["SetParent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "EnableWindow"]) {
    const call = fn === "ShowWindow" ? `${fn}(own_top_level(&main)?, SW_HIDE)` : `${fn}(own_top_level(&main)?, None)`;
    assert.equal(taskbarWriteViolations(call).length, 1, `${fn} 不许用 own_top_level 绕开代次核验`);
  }
  for (const near of ["own_top_level_x(&main)?", "own_top_levelish(&main)?", "ensure_own_top_level(&main)?"]) {
    assert.equal(taskbarWriteViolations(`SetWindowSubclass(${near}, Some(lyrics_proc), id, data)`).length, 1, `形近名一律不放行：${near}`);
  }
  // 参数名不是凭证：own / handle / parent / foreign 都不能靠名字过。
  for (const fn of ["SetParent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "SetWindowSubclass", "EnableWindow"]) {
    for (const name of ["own", "handle", "parent", "foreign"]) {
      assert.equal(taskbarWriteViolations(`${fn}(${name}, None)`).length, 1, `${fn}(${name}) 不能靠参数名放行`);
    }
  }
});

// 注释要替换成分隔空白，`SetParent/**/as reparent` 不许拼成一个标识符。

test("R44d final 1：注释要换成分隔空白，`SetParent/**/as reparent` 不许拼成一个标识符", async () => {
  const { taskbarWriteViolations, stripComments } = await import("../scripts/acceptance.mjs");

  // 先在词法层钉住：`/**/` 之后必须仍是两个 token，而不是一个拼出来的标识符。
  const lexed = stripComments("use windows::Win32::UI::WindowsAndMessaging::SetParent/**/as reparent;", "x.rs");
  assert.match(lexed, /\bSetParent\b/, `注释两侧的标识符不能被拼掉：${JSON.stringify(lexed)}`);
  assert.doesNotMatch(lexed, /SetParentas/, `注释要换成空白，不是删掉：${JSON.stringify(lexed)}`);

  // 审查 rustc 编译过的那条（证据 `.tmp/r44d-final-fixture.rs`）：块注释把 API 名和 `as` 黏在一起。
  const alias = [
    "use windows::Win32::UI::WindowsAndMessaging::SetParent/**/as reparent;",
    "unsafe { reparent(hwnd(foreign), None); }",
  ].join("\n");
  const aliasViolations = taskbarWriteViolations(alias);
  assert.ok(aliasViolations.length >= 1, `注释分隔的 use as 别名必须点名：${JSON.stringify(aliasViolations)}`);
  assert.match(aliasViolations.join("\n"), /SetParent/, "点名的必须是被改名的那份写 API");

  // 行注释分隔同理（`use x::SetParent // c` + 下一行 `as reparent;` 是合法 Rust）。
  assert.ok(
    taskbarWriteViolations("use x::SetParent//c\nas reparent;").length >= 1,
    "行注释分隔的 use as 别名必须点名",
  );

  // 守卫名的本地绑定同样不许因为 `let/*c*/ensure_own` 拼成 `letensure_own` 而隐身。
  assert.ok(
    taskbarWriteViolations("let/*c*/ensure_own = |_p: &EmbedState, _o: OwnWindow| Ok::<HWND, Reason>(hwnd(9));").some((item) =>
      item.startsWith("ensure_own:"),
    ),
    "`let/**/ensure_own` 仍是守卫名绑定，必须点名",
  );

  // 新扩清单里的 API 也走同一条词法。
  for (const api of ["MoveWindow", "SetWindowLongW", "SetWindowLongA", "DestroyWindow", "SendMessageW", "SendMessageA"]) {
    assert.ok(
      taskbarWriteViolations(`use windows::Win32::UI::WindowsAndMessaging::${api}/**/as evil;`).some((item) => item.startsWith(`${api}:`)),
      `${api} 的注释分隔别名必须点名`,
    );
  }

  // 分隔空白不许引入新的假阳性：注释**内部**的写仍然是注释内容。
  assert.deepEqual(taskbarWriteViolations("/* SetParent(/**/hwnd(foreign), None); */"), [], "注释里的东西仍然是注释");
});

// 精确调用清单补齐 MoveWindow/SetWindowLongW/A/DestroyWindow/SendMessageW/A。
// 判据与别名规则不变，不新增按参数名或变量名放行的形态。

test("R44d final 3：MoveWindow/SetWindowLongW/A/DestroyWindow/SendMessageW/A 也必须在受核调用清单里", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const shapes = [
    ["MoveWindow", "0, 0, 10, 10, true"],
    ["SetWindowLongW", "index, value"],
    ["SetWindowLongA", "index, value"],
    ["DestroyWindow", ""],
    ["SendMessageW", "message, w, l"],
    ["SendMessageA", "message, w, l"],
  ];
  const call = (name, first, rest) => `${name}(${rest === "" ? first : `${first}, ${rest}`})`;
  for (const [api, rest] of shapes) {
    assert.equal(taskbarWriteViolations(`${call(api, "hwnd(foreign)", rest)};`).length, 1, `${api} 写外来 HWND 必须点名`);
    // 参数名不是凭证：own/handle/parent/foreign 一律点名。
    for (const name of ["own", "handle", "parent", "foreign"]) {
      assert.equal(taskbarWriteViolations(call(api, name, rest)).length, 1, `${api}(${name}) 不能靠参数名放行`);
    }
    // 写位置由 `self::ensure_own(...)?` 当场给出时才放行。
    assert.deepEqual(taskbarWriteViolations(call(api, "self::ensure_own(policy, own)?", rest)), [], `${api} 的受核调用必须放行`);
    // `own_top_level` 只给子类化：新清单里的写同样不许拿它当挡箭牌（它不核创建代次）。
    assert.equal(taskbarWriteViolations(call(api, "own_top_level(&main)?", rest)).length, 1, `${api} 不许用 own_top_level 绕开代次核验`);
    // 改名前后的四种别名形态都要点名（与既有六个 API 同一套规则）。
    for (const [snippet, why] of [
      [`let evil = ${api};\nunsafe { evil(hwnd(foreign)); }`, "函数指针别名"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api} as evil;`, "`use … as` 别名"],
      [`let evil = ${api} as usize;`, "cast 后的裸引用"],
      [`let table = [${api}];`, "数组里的裸引用"],
      [`use evil::${api};`, "非 windows:: 的导入"],
    ]) {
      assert.ok(
        taskbarWriteViolations(snippet).some((item) => item.startsWith(`${api}:`)),
        `${api} 的${why} 必须点名：${snippet} -> ${JSON.stringify(taskbarWriteViolations(snippet))}`,
      );
    }
    // 全路径限定调用仍按第一实参受核。
    assert.deepEqual(
      taskbarWriteViolations(`windows::Win32::UI::WindowsAndMessaging::${call(api, "self::ensure_own(policy, own)?", rest)}`),
      [],
      `${api} 的全路径受核调用必须放行`,
    );
    assert.equal(
      taskbarWriteViolations(`windows::Win32::UI::WindowsAndMessaging::${call(api, "hwnd(foreign)", rest)}`).length,
      1,
      `${api} 的全路径调用也必须核第一实参`,
    );
  }
  // 清单只许扩、不许缩：原有六个仍然逐个受核（防"换了张名单"的回归）。
  for (const api of ["SetParent", "SetWindowPos", "SetWindowLongPtrW", "ShowWindow", "SetWindowSubclass", "EnableWindow"]) {
    assert.equal(taskbarWriteViolations(`${api}(hwnd(foreign), None)`).length, 1, `既有 ${api} 检查不许被新清单挤掉`);
  }
  // 关联方法形态（`recv.SetParent(…)`）：写目标是**接收者**，第一实参守卫管不到它。
  // 扫描器不解析接收者来源，所以这种语法一律 fail closed——不假装它被覆盖了。
  for (const api of ["SetParent", "SetWindowLongPtrW", "MoveWindow", "SetWindowLongW", "SetWindowLongA", "DestroyWindow", "SendMessageW", "SendMessageA"]) {
    assert.equal(
      taskbarWriteViolations(`h.${api}(self::ensure_own(policy, own)?)`).length,
      1,
      `${api} 的关联方法形态必须以"写目标是接收者"点名（第一实参守卫管不到接收者）`,
    );
    assert.ok(
      taskbarWriteViolations(`h.${api}/*c*/(hwnd(foreign))`).length >= 1,
      `${api} 的关联方法形态（注释分隔）同样点名（接收者 + 外来目标各一次）`,
    );
  }
  // 全路径限定（`::` 结尾）不是方法形态，仍按第一实参受核。
  assert.deepEqual(
    taskbarWriteViolations("windows::Win32::UI::WindowsAndMessaging::MoveWindow(self::ensure_own(policy, own)?, 0, 0, 1, 1, true)"),
    [],
    "`::` 结尾的全路径调用不是关联方法形态",
  );
  // 字符串/注释里的示例不是代码。
  for (const inert of ['let doc = "use x::MoveWindow as m;";', "// let evil = DestroyWindow;", 'let doc = "SendMessageW as f";']) {
    assert.deepEqual(taskbarWriteViolations(inert), [], `字符串/注释里的示例不算命中：${inert}`);
  }
  // 真实模块在**完整**清单下仍然 0 违规（真实现只对自窗写）。
  assert.deepEqual(
    taskbarWriteViolations(read("src-tauri/src/taskbar_lyrics.rs")),
    [],
    "真实实现不许出现未受核的写目标（含新扩的六个 API）",
  );
});

// 守卫实现体不变量：扫描器只核调用形态，不核 `ensure_own` 的函数体。
// 下面的读取器是测试本地的，不进 acceptance、不新增放行形态。

/**
 * 测试本地的 Rust 字面量跳过：`start` 处是字面量起点就返回其后的位置，否则 `-1`。
 * 只服务下面这条守卫体不变量（普通串、raw 串 `r/br/rb/cr` + 任意 `#`、字节/C 串、字符、生命周期）。
 */
function literalEnd(text, start) {
  const plainEnd = (quote) => {
    for (let i = quote + 1; i < text.length; i += 1) {
      if (text[i] === "\\") { i += 1; continue; }
      if (text[i] === '"') return i + 1;
    }
    return -1;
  };
  if (text[start] === '"') return plainEnd(start);
  if (text[start] === "'") {
    if (text[start + 1] === "\\") {
      const close = text.indexOf("'", start + 3);
      return close < 0 ? -1 : close + 1;
    }
    if (text[start + 2] === "'") return start + 3;
    return -1; // 生命周期 `'a` / `'_`：不是字面量
  }
  if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) return -1; // 标识符中间的前缀不是 raw
  if ((text[start] === "b" || text[start] === "c") && text[start + 1] === '"') return plainEnd(start + 1);
  const raw = /^(?:br|rb|cr|r)(#*)"/.exec(text.slice(start, start + 64));
  if (raw !== null) {
    const closer = `"${raw[1]}`;
    const end = text.indexOf(closer, start + raw[0].length);
    return end < 0 ? -1 : end + closer.length;
  }
  return -1;
}

/**
 * 测试本地的 Rust 注释屏蔽：注释换成等长空白（换行保留），字面量整段照抄。
 * 必须长度不变，因为守卫体提取后还要用索引切花括号。
 */
function blankRustComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const literal = literalEnd(source, i);
    if (literal > 0) { out += source.slice(i, literal); i = literal; continue; }
    if (source[i] === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i += 1;
      out += source.slice(start, i).replace(/[^\n]/g, " ");
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const start = i;
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "/" && source[i + 1] === "*") { depth += 1; i += 2; continue; }
        if (source[i] === "*" && source[i + 1] === "/") { depth -= 1; i += 2; if (depth === 0) break; continue; }
        i += 1;
      }
      out += source.slice(start, i).replace(/[^\n]/g, " ");
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** 测试本地的 Rust 字面量屏蔽：串 / raw 串 / 字节/C 串 / 字符字面量换成**等长空格**（`\n` 保留），
 *  字符偏移与原文一致，所以 `index` 比较仍然有效；生命周期 `'a` / `'_` 原样保留（它们不是字面量）。 */
function blankRustLiterals(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const end = literalEnd(code, i);
    if (end > 0) {
      out += code.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    out += code[i];
    i += 1;
  }
  return out;
}

/**
 * 先剥注释再屏蔽字面量（两步等长、换行保留），按平衡花括号切出 `fn ensure_own` 的函数体。
 * 定义必须唯一，切不出来返回 `null`，调用方按失败记账。
 */
function ensureOwnBody(source) {
  const code = blankRustLiterals(blankRustComments(source));
  const definitions = [...code.matchAll(/\bfn\s+ensure_own\s*[<(]/g)];
  if (definitions.length !== 1) return null; // 定义必须唯一：0 处或 2 处都不能当通过
  const open = code.indexOf("{", definitions[0].index + definitions[0][0].length - 1);
  if (open < 0) return null;
  const close = matchDelimiter(code, open); // 字面量已屏蔽，平衡就是代码自己的平衡
  return close < 0 ? null : code.slice(open, close + 1);
}

/** `ensure_own` 实现体必须自己做的四项 live 检查（写资格 = 当前代次 + 自进程 + owner 线程 + 活性）。 */
const ENSURE_OWN_CHECKS = [
  { label: "!IsWindow(Some(handle)).as_bool()（句柄存活）", pattern: /!\s*IsWindow\s*\(\s*Some\s*\(\s*handle\s*\)\s*\)\s*\.\s*as_bool\s*\(\s*\)/ },
  { label: "!policy.may_write(own, pid, thread)（当前代次 + 写资格）", pattern: /!\s*policy\s*\.\s*may_write\s*\(\s*own\s*,\s*pid\s*,\s*thread\s*\)/ },
  { label: "thread != GetCurrentThreadId()（owner 线程）", pattern: /thread\s*!=\s*GetCurrentThreadId\s*\(\s*\)/ },
  { label: "pid != std::process::id()（自进程）", pattern: /pid\s*!=\s*std\s*::\s*process\s*::\s*id\s*\(\s*\)/ },
];

/** 返回守卫实现体的问题清单（空数组 = 四项都在且都在 `Ok(handle)` 之前）。
 *  先屏蔽字面量再判：字符串/字符里的检查文本不是检查，`Ok(handle)` 只出现在串里也不算成功出口。 */
function ensureOwnGuardMisses(body) {
  if (typeof body !== "string" || body.trim() === "") return ["函数体为空：提取失败不能当成守卫成立"];
  const code = blankRustLiterals(body);
  const success = /Ok\s*\(\s*handle\s*\)/.exec(code);
  const misses = [];
  if (success === null) misses.push("Ok(handle)：守卫的成功出口不见了");
  for (const { label, pattern } of ENSURE_OWN_CHECKS) {
    const hit = pattern.exec(code);
    if (hit === null) misses.push(`${label}：检查不见了`);
    else if (success !== null && hit.index > success.index) misses.push(`${label}：检查出现在 Ok(handle) 之后`);
  }
  return misses;
}

test("R44d follow-up：真实 ensure_own 的函数体自己核 存活/代次/owner 线程/自进程，且都在 Ok(handle) 之前", () => {
  // 1) 真实函数体：先剥注释，再用**平衡花括号**把 `fn ensure_own` 的体切出来
  //    （不用无界正则——那种写法会越过函数尾，读到后面紧邻的 `fn hide`）。
  const source = read("src-tauri/src/taskbar_lyrics.rs");
  const body = ensureOwnBody(source);
  assert.ok(body !== null, "没能从真实模块切出 `fn ensure_own` 的函数体：提取失败不等于守卫成立，必须红");
  assert.ok(body.startsWith("{") && body.endsWith("}"), "切出来的必须是完整函数体（配对花括号）");
  assert.match(body, /Ok\s*\(\s*handle\s*\)/, "成功出口必须是 `Ok(handle)`（切错函数或切得太短都要红）");
  assert.doesNotMatch(body, /fn\s+hide\s*\(/, "平衡括号提取不许把后面紧邻的 `fn hide` 一起吃进来");
  const misses = ensureOwnGuardMisses(body);
  assert.deepEqual(misses, [], `ensure_own 的守卫不变量被破坏：${JSON.stringify(misses)}`);

  // 2) 注释不是检查：把 `may_write` 那一项挪进注释后，判定必须点名它（剥注释真的生效）。
  const commented = source.replace("!policy.may_write(own, pid, thread)", "/* !policy.may_write(own, pid, thread) */ true");
  assert.notEqual(commented, source, "注释变体必须真的改动了源码，否则这条正控无效");
  const commentedMisses = ensureOwnGuardMisses(ensureOwnBody(commented));
  assert.ok(
    commentedMisses.some((item) => item.includes("may_write")),
    `注释里写一遍检查不算检查：${JSON.stringify(commentedMisses)}`,
  );

  // 变异自查：删掉任一项检查、或把检查挪到 `Ok(handle)` 之后，判定都必须失败。
  const wrap = (bodyText) => `mod native {\n    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> ${bodyText}\n}\n`;
  assert.deepEqual(
    ensureOwnGuardMisses(ensureOwnBody(wrap(body))),
    [],
    "内存里重组同一份函数体后，判定仍要通过（否则下面那些'必须红'没有意义）",
  );
  for (const [needle, why] of [
    ["!IsWindow(Some(handle)).as_bool() || ", "句柄存活"],
    ["!policy.may_write(own, pid, thread) || ", "代次 + 本代次写资格"],
    ["thread != GetCurrentThreadId() || ", "owner 线程"],
    [" || pid != std::process::id()", "自进程"],
  ]) {
    const mutated = body.replace(needle, "");
    assert.notEqual(mutated, body, `变异必须真的删掉了「${why}」这一项：${needle}`);
    const mutatedBody = ensureOwnBody(wrap(mutated));
    assert.ok(mutatedBody !== null, `删掉「${why}」后仍应能切出函数体（这是判定的事，不是提取的事）`);
    assert.ok(ensureOwnGuardMisses(mutatedBody).length >= 1, `删掉「${why}」后守卫判定必须红：${needle}`);
  }
  const lateBody = body
    .replace(" || pid != std::process::id()", "")
    .replace("Ok(handle)", "Ok(handle); if pid != std::process::id() { return Err(Reason::Stale); }");
  const lateMisses = ensureOwnGuardMisses(ensureOwnBody(wrap(lateBody)));
  assert.ok(
    lateMisses.some((item) => item.includes("之后")),
    `检查必须出现在 Ok(handle) 之前：挪到成功后必须点名：${JSON.stringify(lateMisses)}`,
  );

  // 负控：字面量里的检查文本不算检查，判定必须点名四项缺失。
  const guardText =
    "!IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) " +
    "|| thread != GetCurrentThreadId() || pid != std::process::id()";
  for (const [shape, literal] of [
    ["普通串", `"${guardText}"`],
    ['raw 串 r#"…"#', `r#"${guardText}"#`],
    ['raw 串 r##"…"##', `r##"${guardText}"##`],
  ]) {
    const inString = wrap(`{ let _ = note(${literal}); Ok(handle) }`);
    const inStringBody = ensureOwnBody(inString);
    assert.ok(inStringBody !== null, `${shape}变体仍应能切出函数体（这是判定的事，不是提取的事）`);
    const inStringMisses = ensureOwnGuardMisses(inStringBody);
    assert.equal(
      inStringMisses.length,
      ENSURE_OWN_CHECKS.length,
      `${shape}里的检查文本不是检查，四项都要点名：${JSON.stringify(inStringMisses)}`,
    );
    for (const { label } of ENSURE_OWN_CHECKS) {
      assert.ok(
        inStringMisses.some((item) => item.includes(label) && item.includes("不见了")),
        `${shape}：必须点名「${label}」缺失：${JSON.stringify(inStringMisses)}`,
      );
    }
  }

  // 同一个假阳性也要覆盖成功出口：`Ok(handle)` 只出现在串里时不算"守卫之后成功返回"。
  const hiddenSuccess = wrap(
    `{ if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) ` +
      `|| thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); } ` +
      `let _ = note("Ok(handle)"); Err(Reason::Stale) }`,
  );
  const hiddenSuccessMisses = ensureOwnGuardMisses(ensureOwnBody(hiddenSuccess));
  assert.ok(
    hiddenSuccessMisses.some((item) => item.includes("Ok(handle)") && item.includes("不见了")),
    `串里的 Ok(handle) 不是成功出口：${JSON.stringify(hiddenSuccessMisses)}`,
  );

  // 5) 反向：屏蔽字面量**不许**吃掉生命周期 / 字符字面量之后真正的检查
  //    （`'a`、`'_` 是生命周期而不是字符字面量；`'"'` 是字符而不是串开头）。
  const lifetimeBody = wrap(
    `{ fn tag<'a>(s: &'a str) -> &'a str { s } let quote = '"'; let _ = (tag("a"), quote); ` +
      `if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) ` +
      `|| thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); } Ok(handle) }`,
  );
  assert.deepEqual(
    ensureOwnGuardMisses(ensureOwnBody(lifetimeBody)),
    [],
    "生命周期 / 字符字面量之后的四项检查必须照样被看到（屏蔽字面量不许连代码一起吃掉）",
  );
});

// 守卫的来源必须可证：handle 与 pid/thread 同一来源，四项检查挡在成功出口前。
// 判据是词法 + 局部结构，源码形状一变就 fail closed，不认“等价写法”。

/** `code` 里名字作为**赋值目标**出现的位置（`=` 的下标；排除 `==` / `=>` / `own.pid`）。 */
function assignmentSites(code, name) {
  const sites = [];
  for (const hit of code.matchAll(new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*=(?!=|>)`, "g"))) {
    sites.push(hit.index + hit[0].length - 1);
  }
  return sites;
}

/** 从 `=` 处扫到**顶层** `;`，返回初始值文本；扫不到（不平衡/没有分号）返回 `null`。
 *  传进来的 `code` 已屏蔽字面量，所以不会把串里的 `;` 当分隔符。 */
function assignmentTarget(code, eqIndex) {
  let depth = 0;
  for (let i = eqIndex + 1; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return null;
      depth -= 1;
    } else if (ch === ";" && depth === 0) return code.slice(eqIndex + 1, i).trim();
  }
  return null;
}

/** 配对括号扫描（跳过字面量）；`code[open]` 是左括号，不平衡返回 `-1`。 */
function matchDelimiter(code, open) {
  const closers = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let i = open; i < code.length; i += 1) {
    const literal = literalEnd(code, i);
    if (literal > 0) { i = literal - 1; continue; }
    const ch = code[i];
    if (closers[ch] !== undefined) { stack.push(closers[ch]); continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 拒绝条件必须是四条拒绝谓词按固定顺序以 `||` 连接，只容忍空白差异，形状一变即 fail closed。 */
const ENSURE_OWN_REJECT_CLAUSES = [
  /^!\s*IsWindow\s*\(\s*Some\s*\(\s*handle\s*\)\s*\)\s*\.\s*as_bool\s*\(\s*\)$/,
  /^!\s*policy\s*\.\s*may_write\s*\(\s*own\s*,\s*pid\s*,\s*thread\s*\)$/,
  /^thread\s*!=\s*GetCurrentThreadId\s*\(\s*\)$/,
  /^pid\s*!=\s*std\s*::\s*process\s*::\s*id\s*\(\s*\)$/,
];

/** 按**顶层**（不在括号里）的 `||` 切子句；括号里的 `||` 不切。 */
function splitDisjunction(condition) {
  const clauses = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < condition.length; i += 1) {
    const ch = condition[i];
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth -= 1; continue; }
    if (depth === 0 && ch === "|" && condition[i + 1] === "|") {
      clauses.push(condition.slice(start, i));
      i += 1;
      start = i + 1;
    }
  }
  clauses.push(condition.slice(start));
  return clauses;
}

/** 条件是不是**恰好**那条"四项任一不成立就拒绝"的析取式（顺序固定、只容忍空白）。 */
function exactRejectCondition(condition) {
  const clauses = splitDisjunction(condition).map((clause) => clause.trim());
  if (clauses.length !== ENSURE_OWN_REJECT_CLAUSES.length) return false;
  return ENSURE_OWN_REJECT_CLAUSES.every((pattern, index) => pattern.test(clauses[index]));
}

/** 定位“拒绝条件恰为 canonical 析取式、分支 `return Err`、无 `else`”的 `if`，找不到即按缺失记账。 */
function guardingIf(code) {
  let nearMiss = false;
  for (const hit of code.matchAll(/\bif\b/g)) {
    let depth = 0;
    let open = -1;
    for (let i = hit.index + 2; i < code.length; i += 1) {
      const literal = literalEnd(code, i);
      if (literal > 0) { i = literal - 1; continue; }
      const ch = code[i];
      if (ch === "{" && depth === 0) { open = i; break; }
      if (ch === "(" || ch === "[") { depth += 1; continue; }
      if (ch === ")" || ch === "]") { depth -= 1; if (depth < 0) break; }
    }
    if (open < 0) continue;
    const blockEnd = matchDelimiter(code, open);
    if (blockEnd < 0) continue;
    const block = code.slice(open, blockEnd + 1);
    if (!/\breturn\b/.test(block) || !/\bErr\b/.test(block)) continue;
    // `else` 分支是没声明的形状（例如 `else { return Ok(handle) }`）：不算命中，按不可证处理。
    if (/^\s*else\b/.test(code.slice(blockEnd + 1, blockEnd + 16))) { nearMiss = true; continue; }
    const condition = code.slice(hit.index + 2, open);
    if (!exactRejectCondition(condition)) { nearMiss = true; continue; }
    return { found: true, nearMiss: false, condStart: hit.index, condEnd: open, blockEnd };
  }
  return { found: false, nearMiss, condStart: -1, condEnd: -1, blockEnd: -1 };
}

/** 守卫体的 canonical token 形状：一次 `let handle`、一次 pid/thread 绑定、四条拒绝谓词、唯一 `Ok(handle)` 收尾。 */
const CANONICAL_GUARD_BODY = [
  "{ unsafe {",
  "let handle = hwnd(own.handle);",
  "let mut pid = 0;",
  "let thread = GetWindowThreadProcessId(handle, Some(&mut pid));",
  "if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread)",
  "|| thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); }",
  "Ok(handle)",
  "} }",
].join(" ");

/** Rust 代码的 token 化（字面量/注释已屏蔽，所以只剩代码）：多字符运算符优先，其余单字节。 */
const GUARD_TOKEN = /::|->|=>|==|!=|&&|\|\||[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s]/g;
function guardTokens(code) {
  return [...code.matchAll(GUARD_TOKEN)].map((hit) => hit[0]);
}
const CANONICAL_GUARD_TOKENS = guardTokens(CANONICAL_GUARD_BODY);

/** 逐 token 比 canonical 形状；不同就返回一条点名第一个差异的诊断（相同返回 null）。 */
function canonicalGuardMismatch(tokens) {
  const length = Math.max(tokens.length, CANONICAL_GUARD_TOKENS.length);
  for (let i = 0; i < length; i += 1) {
    if (tokens[i] === CANONICAL_GUARD_TOKENS[i]) continue;
    return (
      "控制流：函数体必须恰好是 canonical 守卫形状（拒绝分支只能是直接的 `return Err(Reason::Stale);`，" +
      "成功后只能是唯一的 `Ok(handle)`；闭包吞 return / match 影子绑定 / else / 额外绑定都不认）：" +
      `第 ${i + 1} 个 token 起不同，期望 ${JSON.stringify(CANONICAL_GUARD_TOKENS[i] ?? "（结束）")}，` +
      `实际 ${JSON.stringify(tokens[i] ?? "（结束）")}`
    );
  }
  return null;
}

/** `handle` 的唯一合法来源：受核 HWND 转换（`hwnd(own.handle)`；`self::hwnd(...)` 也认）。 */
const ENSURE_OWN_HANDLE_SOURCE = /^\s*(?:self\s*::\s*)?hwnd\s*\(\s*own\s*\.\s*handle\s*\)\s*$/;
/** `pid`/`thread` 的唯一合法来源：同一次 `GetWindowThreadProcessId` 调用。 */
const ENSURE_OWN_IDENTITY =
  /let\s+mut\s+pid\s*(?::\s*u32\s*)?=\s*0\s*;\s*let\s+thread\s*(?::\s*u32\s*)?=\s*GetWindowThreadProcessId\s*\(\s*handle\s*,\s*Some\s*\(\s*&\s*mut\s+pid\s*\)\s*\)\s*;/;

/** provenance 版四项检查：判据同 `ENSURE_OWN_CHECKS`，但 `pid`/`thread` 必须指向局部值，而非抄 `own` 自证。 */
const ENSURE_OWN_PROVENANCE_CHECKS = [
  {
    label: "!IsWindow(Some(handle)).as_bool()（句柄存活）",
    pattern: /!\s*IsWindow\s*\(\s*Some\s*\(\s*handle\s*\)\s*\)\s*\.\s*as_bool\s*\(\s*\)/,
  },
  {
    label: "!policy.may_write(own, pid, thread)（当前代次 + 写资格）",
    pattern: /!\s*policy\s*\.\s*may_write\s*\(\s*own\s*,\s*pid\s*,\s*thread\s*\)/,
  },
  { label: "thread != GetCurrentThreadId()（owner 线程）", pattern: /(?<![A-Za-z0-9_.])thread\s*!=\s*GetCurrentThreadId\s*\(\s*\)/ },
  { label: "pid != std::process::id()（自进程）", pattern: /(?<![A-Za-z0-9_.])pid\s*!=\s*std\s*::\s*process\s*::\s*id\s*\(\s*\)/ },
];

/** 返回守卫实现体的来源问题清单：空数组 = handle/pid/thread 同一来源且四项检查挡在成功出口前。 */
function ensureOwnProvenanceMisses(body) {
  const misses = ensureOwnGuardMisses(body);
  if (typeof body !== "string" || body.trim() === "") return misses; // 空体已由上面点名
  const code = blankRustLiterals(body);

  // ① handle：只能有一次赋值，且来自 own.handle 的受核转换（多一次赋值就能在检查之后换目标）。
  const handleSites = assignmentSites(code, "handle");
  if (handleSites.length !== 1) {
    misses.push(`handle 的来源：只能有一次赋值（发现 ${handleSites.length} 次）——多一次就能在检查之后换掉写目标`);
  } else {
    const init = assignmentTarget(code, handleSites[0]);
    if (init === null || !ENSURE_OWN_HANDLE_SOURCE.test(init)) {
      misses.push(`handle 的来源：必须是 let handle = hwnd(own.handle)（当前是 ${JSON.stringify(init)}）`);
    }
  }

  // ② pid/thread：各自只能有一次赋值，且由**同一次** GetWindowThreadProcessId(handle, …) 填出来。
  const pidSites = assignmentSites(code, "pid");
  const threadSites = assignmentSites(code, "thread");
  if (pidSites.length !== 1 || threadSites.length !== 1) {
    misses.push(`pid/thread 的来源：各自只能有一次赋值（pid ${pidSites.length} / thread ${threadSites.length}）`);
  }
  const identity = ENSURE_OWN_IDENTITY.exec(code);
  if (identity === null) {
    misses.push(
      "pid/thread 的来源：必须来自 let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));（抄 own.pid/own.thread 不算）",
    );
  } else {
    for (const { label, pattern } of ENSURE_OWN_PROVENANCE_CHECKS) {
      const hit = pattern.exec(code);
      if (hit !== null && hit.index < identity.index) {
        misses.push(`${label}：身份值在 GetWindowThreadProcessId 之前就被用了（来源顺序不可证）`);
      }
    }
  }

  // ③ 四项检查必须真的用 handle 查出来的局部值（不是 own.pid/own.thread，也不是别的名字）。
  for (const { label, pattern } of ENSURE_OWN_PROVENANCE_CHECKS) {
    if (!pattern.test(code)) misses.push(`${label}：检查的不是 handle 查出来的局部值（来源不可证）`);
  }

  // ④ 成功出口唯一、且是函数体最后一条表达式。
  const successHits = [...code.matchAll(/Ok\s*\(\s*handle\s*\)/g)];
  if (successHits.length !== 1) misses.push(`Ok(handle)：成功出口必须唯一（发现 ${successHits.length} 个）`);
  const success = successHits[0] ?? null;
  if (success !== null && /[A-Za-z0-9_]/.test(code.slice(success.index + success[0].length))) {
    misses.push("Ok(handle)：必须是函数体最后一条表达式（之后不许再有代码）");
  }

  // 支配关系：拒绝条件必须恰为那条四项 `||` 析取式、分支 return Err，且整段排在 `Ok(handle)` 之前。
  const guarded = guardingIf(code);
  if (!guarded.found) {
    misses.push(
      guarded.nearMiss
        ? "拒绝条件：必须是恰好那条四项 `||` 析取式（`&&` / `false && (…)` / `true || (…)` / 多、少、换序子句 / 外层括号或取反 / else 分支都不行）"
        : "四项检查：必须都在同一个 if 条件里、该分支 return Err（来源有了，判据也得真的挡在写之前）",
    );
  } else {
    for (const { label, pattern } of ENSURE_OWN_PROVENANCE_CHECKS) {
      const hit = pattern.exec(code);
      if (hit !== null && (hit.index < guarded.condStart || hit.index >= guarded.condEnd)) {
        misses.push(`${label}：不在挡住 Ok(handle) 的那个 if 条件里`);
      }
    }
    if (success !== null && guarded.blockEnd > success.index) {
      misses.push("四项检查的那条 if 分支必须整段排在 Ok(handle) 之前");
    }
  }

  // canonical token 控制流：绑定 / 拒绝分支 / 成功出口必须逐 token 对得上（空白与注释可变），否则 fail closed。
  const mismatch = canonicalGuardMismatch(guardTokens(blankRustLiterals(blankRustComments(body))));
  if (mismatch !== null) misses.push(mismatch);
  return misses;
}

test("R44d final 2：真实 ensure_own 的 handle/pid/thread 来源必须可证（GetShellWindow 变体必须红）", () => {
  const source = read("src-tauri/src/taskbar_lyrics.rs");
  const body = ensureOwnBody(source);
  assert.ok(body !== null, "没能从真实模块切出 `fn ensure_own` 的函数体：提取失败不等于守卫成立，必须红");
  assert.deepEqual(
    ensureOwnProvenanceMisses(body),
    [],
    `真实守卫的来源不变量被破坏：${JSON.stringify(ensureOwnProvenanceMisses(body))}`,
  );

  const wrap = (bodyText) => `mod native {\n    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> ${bodyText}\n}\n`;
  // 正控：真实函数体在内存里重组后照样通过（否则下面那些"必须红"没有意义）。
  assert.deepEqual(ensureOwnProvenanceMisses(ensureOwnBody(wrap(body))), [], "内存里重组真实函数体后判定仍要通过");

  // 恶意体：句柄/身份来源被换掉，但四项关键字与 `Ok(handle)` 一个不缺——只核关键字的判据会全部接受。
  // 这组对照用来钉住「来源判据真的管用」。
  const guardTail =
    "if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) " +
    "|| thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); }";
  const malicious = [
    [
      "handle 在检查之后被换成 GetShellWindow()",
      `{ let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); ${guardTail} let handle = GetShellWindow(); Ok(handle) }`,
      "handle",
    ],
    [
      "handle 直接取自 GetShellWindow()",
      `{ let handle = GetShellWindow(); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); ${guardTail} Ok(handle) }`,
      "handle",
    ],
    [
      "pid/thread 抄 own 里的值（不是从 handle 查出来）",
      `{ let handle = hwnd(own.handle); let mut pid = own.pid; let thread = own.thread; ${guardTail} Ok(handle) }`,
      "GetWindowThreadProcessId",
    ],
    [
      "成功出口换回外来句柄",
      `{ let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); ${guardTail} Ok(handle); Ok(GetShellWindow()) }`,
      "Ok(handle)",
    ],
    [
      "检查用的是 own.pid/own.thread，不是查出来的局部值",
      `{ let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) || own.thread != GetCurrentThreadId() || own.pid != std::process::id() { return Err(Reason::Stale); } Ok(handle) }`,
      "owner 线程",
    ],
    [
      "四项检查不在 if 里（只算了个没用的局部布尔值）",
      `{ let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); let ok = !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) || thread != GetCurrentThreadId() || pid != std::process::id(); Ok(handle) }`,
      "if",
    ],
  ];
  const accepted = [];
  for (const [why, text, keyword] of malicious) {
    const maliciousBody = ensureOwnBody(wrap(text));
    assert.ok(maliciousBody !== null, `${why}：仍应能切出函数体（这是判定的事，不是提取的事）`);
    assert.deepEqual(ensureOwnGuardMisses(maliciousBody), [], `${why}：修前口径（只核四项关键字）确实会接受它`);
    const misses = ensureOwnProvenanceMisses(maliciousBody);
    // 被判为「通过」的恶意体收进 accepted 一次点名；判据管用时它是空的。
    if (misses.length === 0) { accepted.push(why); continue; }
    assert.ok(
      misses.join("\n").includes(keyword),
      `${why} 的点名要指出来源问题（含「${keyword}」）：${JSON.stringify(misses)}`,
    );
  }
  assert.deepEqual(accepted, [], `来源判据必须拒绝这些恶意体（修前口径全部接受）：${JSON.stringify(accepted)}`);

  // 变异自查：来源或任一条守卫子句被删/被改，判定必须红（防止判定"永远为真"或只核到别处）。
  for (const [needle, replacement, why] of [
    ["hwnd(own.handle)", "GetShellWindow()", "handle 不再来自 own.handle"],
    ["let thread = GetWindowThreadProcessId(handle, Some(&mut pid));", "let thread = own.thread;", "thread 不再从 handle 查出来"],
    ["!IsWindow(Some(handle)).as_bool() || ", "", "句柄存活"],
    ["!policy.may_write(own, pid, thread) || ", "", "代次 + 写资格"],
    ["thread != GetCurrentThreadId() || ", "", "owner 线程"],
    [" || pid != std::process::id()", "", "自进程"],
  ]) {
    const mutated = body.replace(needle, replacement);
    assert.notEqual(mutated, body, `变异必须真的改动了「${why}」：${needle}`);
    const mutatedBody = ensureOwnBody(wrap(mutated));
    assert.ok(mutatedBody !== null, `「${why}」变异后仍应能切出函数体（这是判定的事，不是提取的事）`);
    assert.ok(ensureOwnProvenanceMisses(mutatedBody).length >= 1, `「${why}」被改动后判定必须红：${mutated.slice(0, 120)}`);
  }
  // 检查挪到成功出口之后也必须红（次序判据）。
  const late = body
    .replace(" || pid != std::process::id()", "")
    .replace("Ok(handle)", "Ok(handle); if pid != std::process::id() { return Err(Reason::Stale); }");
  assert.ok(
    ensureOwnProvenanceMisses(ensureOwnBody(wrap(late))).some((item) => item.includes("之后")),
    "检查挪到 Ok(handle) 之后必须点名「之后」",
  );

  // 负控：把整段"来源 + 检查"塞进串里、可执行代码只有 `Ok(handle)` —— 来源判据必须红。
  const guardText =
    "let handle = hwnd(own.handle); let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); " +
    "if !IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) || thread != GetCurrentThreadId() || pid != std::process::id() { return Err(Reason::Stale); }";
  const inStringBody = ensureOwnBody(wrap(`{ let _ = note(r#"${guardText}"#); Ok(handle) }`));
  assert.ok(inStringBody !== null, "串里放检查文本的变体仍应能切出函数体");
  const inStringMisses = ensureOwnProvenanceMisses(inStringBody);
  assert.ok(
    inStringMisses.some((item) => item.includes("handle")),
    `串里的来源文本不是来源，必须点名 handle：${JSON.stringify(inStringMisses)}`,
  );
  assert.ok(
    inStringMisses.some((item) => item.includes("GetWindowThreadProcessId")),
    `串里放的 GetWindowThreadProcessId 不算来源：${JSON.stringify(inStringMisses)}`,
  );
});

// 四条判据：raw identifier 定义、守卫体先剥注释与字面量、拒绝条件形状、写 API 清单全覆盖。
// 四条都只往严的方向走，没有放宽任何既有形态。

/** first-HWND 直接改写清单：第二项是“除 HWND 外的实参”，清单只许扩、不许缩。 */
const MUTATION_SIGNATURES = [
  ["SetParent", "None"],
  ["SetWindowPos", "None, 0, 0, 1, 1, flags"],
  ["SetWindowLongPtrW", "index, value"],
  ["ShowWindow", "SW_HIDE"],
  ["SetWindowSubclass", "Some(lyrics_proc), id, data"],
  ["EnableWindow", "false"],
  ["MoveWindow", "0, 0, 10, 10, true"],
  ["SetWindowLongW", "index, value"],
  ["SetWindowLongA", "index, value"],
  ["DestroyWindow", ""],
  ["SendMessageW", "message, w, l"],
  ["SendMessageA", "message, w, l"],
  ["ShowWindowAsync", "SW_HIDE"],
  ["PostMessageW", "message, w, l"],
  ["PostMessageA", "message, w, l"],
  ["SendMessageTimeoutW", "message, w, l, flags, timeout, Some(&mut result)"],
  ["SendMessageTimeoutA", "message, w, l, flags, timeout, Some(&mut result)"],
  ["SetWindowLongPtrA", "index, value"],
  ["SetWindowTextW", "text"],
  ["SetWindowTextA", "text"],
  ["AnimateWindow", "duration, flags"],
  ["SetWindowPlacement", "&placement"],
  ["SetLayeredWindowAttributes", "color, alpha, flags"],
  ["SetWindowRgn", "region, redraw"],
  ["SetWindowTheme", "app, id"],
  ["SetPropW", "name, data"],
  ["SetPropA", "name, data"],
  ["SetWindowContextHelpId", "id"],
  ["SetWindowDisplayAffinity", "affinity"],
];

test("R44d findings 1：raw identifier 的守卫定义也算定义（fn r#ensure_own 不许绕过唯一性）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const realGuard = "fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> { Ok(hwnd(own.handle)) }";
  const rawGuard = "fn r#ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> { Ok(hwnd(9)) }";

  // 审查指出的实际绕过：嵌套 mod 里一份 raw 定义 + 外层真实定义。`self::ensure_own` 到底解析到
  // 哪一份，词法扫描器证明不了——所以"两份定义"必须被当成违规，不是当成一份。
  const nestedRaw = ["mod helper {", `    ${rawGuard}`, "}", realGuard].join("\n");
  const nestedViolations = taskbarWriteViolations(nestedRaw);
  assert.ok(
    nestedViolations.some((item) => item.startsWith("ensure_own:")),
    `raw 定义 + canonical 定义 = 两份定义，必须点名：${JSON.stringify(nestedViolations)}`,
  );
  assert.equal(
    nestedViolations.filter((item) => item.startsWith("ensure_own:")).length,
    1,
    "同一处唯一性问题只点一次（不按定义数重复记账）",
  );

  // 两份 raw 定义同样不许（嵌套 mod 里一份、外层一份）。
  const secondRawGuard = rawGuard.replace("hwnd(9)", "hwnd(own.handle)");
  assert.ok(
    taskbarWriteViolations(["mod helper {", `    ${rawGuard}`, "}", secondRawGuard].join("\n")).some((item) => item.startsWith("ensure_own:")),
    "两份 raw 定义也必须点名",
  );

  // 第二个守卫名同规则（`own_top_level` 只给子类化用，但定义本身同样必须唯一）。
  const realTop = "fn own_top_level<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, Reason> { Ok(hwnd(1)) }";
  const rawTop = "fn r#own_top_level<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, Reason> { Ok(hwnd(9)) }";
  const topViolations = taskbarWriteViolations(["mod helper {", `    ${rawTop}`, "}", realTop].join("\n"));
  assert.ok(
    topViolations.some((item) => item.startsWith("own_top_level:")),
    `raw 的 own_top_level 定义同样计入唯一性：${JSON.stringify(topViolations)}`,
  );

  // raw 名不能当写目标的凭证：写位置只认 canonical `self::`。
  assert.equal(
    taskbarWriteViolations("SetParent(r#ensure_own(policy, own)?, None)").length,
    1,
    "`r#ensure_own(...)` 不是 canonical 守卫路径，写位置必须点名",
  );
  // 但**唯一一份** raw 定义本身不是"本地绑定"（它就是同名函数），唯一性由计数兜、
  // 实现体由守卫体用例兜——这里钉住"不许因为加了 raw 支持就误报"。
  assert.deepEqual(taskbarWriteViolations(rawGuard), [], "唯一一份 raw 定义不违反唯一性（实现体由守卫体用例管）");
  // 非写位置的自查调用形态照旧放行（raw 名与裸名一样）。
  assert.deepEqual(taskbarWriteViolations("fn f() { r#ensure_own(policy, own)?; }"), [], "非写位置的 raw 自查调用不报");
});

test("R44d findings 2：守卫体提取必须先剥注释/屏蔽字面量，串里伪造的 fn ensure_own 不算定义", () => {
  const source = read("src-tauri/src/taskbar_lyrics.rs");
  const realBody = ensureOwnBody(source);
  assert.ok(realBody !== null, "真实模块必须能切出唯一一份 `fn ensure_own`");
  const wrap = (text) => `mod native {\n    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> ${text}\n}\n`;
  const forged = "fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> { Ok(hwnd(9)) }";

  // ① 串里伪造的定义不能把真实定义挤成"两份"（也不能被当成被检查的那一份）。
  for (const [shape, literal] of [
    ["普通串", `let _doc = ${JSON.stringify(forged)};`],
    ['raw 串 r#"…"#', `let _doc = r#"${forged}"#;`],
    ['raw 串 r##"…"##', `let _doc = r##"${forged}"##;`],
  ]) {
    const injected = wrap(`{ ${literal} ${realBody.slice(1)}`);
    const body = ensureOwnBody(injected);
    assert.ok(body !== null, `${shape}里的伪造定义不算定义，真实定义必须仍能被切出来`);
    assert.doesNotMatch(body, /fn\s+ensure_own/, `${shape}里的定义文本必须被屏蔽，不能进"函数体"`);
    assert.doesNotMatch(body, /hwnd\s*\(\s*9\s*\)/, `${shape}里伪造体的内容不能冒充真实守卫体`);
    // 串只是内容：真检查与真实来源都还在，但注入多出一条前置语句，canonical 控制流判据因此 fail closed（多报一侧）。
    assert.deepEqual(ensureOwnGuardMisses(body), [], `${shape}里的注入不改变四项真检查`);
    const provenance = ensureOwnProvenanceMisses(body);
    assert.ok(provenance.length >= 1, `${shape}：注入后的形状不是 canonical，必须 fail closed（不静默放行）`);
    assert.ok(
      provenance.every((item) => item.includes("控制流")),
      `${shape}：只许点名形状，不许把注入说成来源问题：${JSON.stringify(provenance)}`,
    );
  }

  // ② 只有串里那一份"定义"（模块里没有任何真实 fn 定义）时，提取必须失败（fail closed），
  //    不许把串内容当成守卫体。
  for (const [shape, literal] of [
    ["普通串", JSON.stringify(forged)],
    ['raw 串 r#"…"#', `r#"${forged}"#`],
    ['raw 串 r##"…"##', `r##"${forged}"##`],
  ]) {
    const onlyInString = `mod native {\n    const DOC: &str = ${literal};\n}\n`;
    assert.equal(ensureOwnBody(onlyInString), null, `${shape}里的伪造定义不许被当成真实定义（必须提取失败）`);
  }

  // ③ 注释里的"定义"同样不是定义（剥注释先于定位），且不得制造"两份定义"。
  assert.equal(
    ensureOwnBody(`mod native {\n    const A: u8 = 1;\n    // ${forged}\n}\n`),
    null,
    "注释里的伪造定义不许被当成真实定义",
  );
  assert.ok(
    ensureOwnBody(wrap(`{ // ${forged}\n ${realBody.slice(1)}`)) !== null,
    "注释里的伪造定义也不许把真实定义挤成两份（否则提取失败就掩盖了真实守卫体）",
  );

  // ④ 屏蔽必须**等长、换行保留**：跨行串里的伪造定义既不能被当成定义，也不能把偏移算歪。
  const baselineLines = ensureOwnBody(wrap(realBody)).split("\n").length;
  const multiline = wrap(`{ let _doc = "line a\n${forged}\nline b"; ${realBody.slice(1)}`);
  const multilineBody = ensureOwnBody(multiline);
  assert.ok(multilineBody !== null, "跨行串里的伪造定义不算定义");
  assert.equal(
    multilineBody.split("\n").length,
    baselineLines + 2,
    "字面量屏蔽要保留换行（串里的两个换行既不能丢、也不能把偏移算歪）",
  );
  assert.doesNotMatch(multilineBody, /fn\s+ensure_own/, "跨行串里的定义文本必须被屏蔽");

  // ⑤ 字符字面量里的花括号不许把体内嵌的平衡算错。
  const braces = wrap(`{ let _open = '{'; let _close = '}'; ${realBody.slice(1)}`);
  const bracesBody = ensureOwnBody(braces);
  assert.ok(bracesBody !== null, "字符字面量里的花括号不能把体内嵌的平衡算错");
  assert.doesNotMatch(bracesBody, /'\s*[{}]\s*'/, "字符字面量必须被等长屏蔽（`'{'`/`'}'` 不能留在视图里）");
  assert.deepEqual(ensureOwnGuardMisses(bracesBody), [], "字符字面量之后的四项真实检查仍要看得见");
  // 前置的 `let _open = …;` 让形状不再 canonical：只许因控制流 fail closed，来源不受影响。
  const bracesProvenance = ensureOwnProvenanceMisses(bracesBody);
  assert.ok(
    bracesProvenance.length >= 1 && bracesProvenance.every((item) => item.includes("控制流")),
    `字符字面量只是等长屏蔽，只许因形状 fail closed：${JSON.stringify(bracesProvenance)}`,
  );
});

test("R44d findings 3：四项拒绝条件必须恰好是那条析取式（&& / false && / true || / 多/少/换序一律红）", () => {
  const source = read("src-tauri/src/taskbar_lyrics.rs");
  const body = ensureOwnBody(source);
  assert.ok(body !== null, "真实模块必须能切出 `fn ensure_own` 的函数体");
  const CANON =
    "!IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) " +
    "|| thread != GetCurrentThreadId() || pid != std::process::id()";
  assert.ok(
    body.includes(CANON),
    "真实守卫的条件必须仍是那条 canonical 析取式（下面的变异以它为锚；形状变了就 fail closed）",
  );
  const wrap = (text) => `mod native {\n    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> ${text}\n}\n`;
  const missesOf = (text) => {
    const extracted = ensureOwnBody(wrap(text));
    assert.ok(extracted !== null, "变异后仍应能切出函数体（这是判定的事，不是提取的事）");
    return ensureOwnProvenanceMisses(extracted);
  };
  assert.deepEqual(missesOf(body), [], "正控：真实函数体必须通过");

  // 只加空白的等价写法仍要通过：判据是 token 形状，不是字节相等。
  assert.deepEqual(
    missesOf(
      body.replace(
        CANON,
        "! IsWindow ( Some ( handle ) ) . as_bool ( ) || ! policy . may_write ( own , pid , thread ) " +
          "|| thread != GetCurrentThreadId ( ) || pid != std :: process :: id ( )",
      ),
    ),
    [],
    "只加空白的等价写法必须继续通过",
  );

  // 逻辑被弱化的六种写法：四项关键字全在、次序也对，但条件已经不是"四项任一不成立就拒绝"。
  for (const [why, mutant] of [
    ["四项之间改成 && 连接", CANON.split(" || ").join(" && ")],
    ["外面套 `false && (…)`（整段被短路）", `false && (${CANON})`],
    ["外面套 `true || (…)`（整段被短路）", `true || (${CANON})`],
    ["整个条件取反 `!(…)`", `!(${CANON})`],
    ["多一个恒假子句 `|| false`", `${CANON} || false`],
    ["少一个子句（自进程被删）", CANON.replace(" || pid != std::process::id()", "")],
    ["后两个子句换序", "!IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) || pid != std::process::id() || thread != GetCurrentThreadId()"],
    ["条件只剩常量 false", "false"],
    ["条件只剩常量 true", "true"],
  ]) {
    const misses = missesOf(body.replace(CANON, mutant));
    assert.ok(misses.length >= 1, `「${why}」必须让守卫判定报失败`);
    assert.ok(
      misses.some((item) => item.includes("拒绝条件")),
      `「${why}」要点名"拒绝条件"不可弱化：${JSON.stringify(misses)}`,
    );
  }

  // 子句被挪到成功出口之后：同样必须红（次序判据，独立于上面的条件形状判据）。
  const moved = body
    .replace(" || pid != std::process::id()", "")
    .replace("Ok(handle)", "Ok(handle); if pid != std::process::id() { return Err(Reason::Stale); }");
  assert.notEqual(moved, body, "变异必须真的把子句挪走了");
  assert.ok(
    missesOf(moved).some((item) => item.includes("之后")),
    `子句挪到 Ok(handle) 之后必须点名「之后」：${JSON.stringify(missesOf(moved))}`,
  );
});

test("R44d findings 4：完整写 API 清单（first-HWND 受核 + 批量/多窗口写在本模块一律禁用）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const call = (name, first, rest) => `${name}(${rest === "" ? first : `${first}, ${rest}`})`;

  for (const [api, rest] of MUTATION_SIGNATURES) {
    // 外来目标 / 别的窗口 / 纯参数名：一律点名，且只点一次。
    for (const [first, why] of [
      ["hwnd(foreign)", "外来目标"],
      ["GetShellWindow()", "另一个窗口（shell）"],
      ["own", "参数名 own"],
      ["handle", "参数名 handle"],
      ["parent", "参数名 parent"],
    ]) {
      assert.equal(taskbarWriteViolations(call(api, first, rest)).length, 1, `${api}：${why} 必须点名`);
    }
    // 写位置由 canonical 守卫当场给出才放行。
    assert.deepEqual(
      taskbarWriteViolations(call(api, "self::ensure_own(policy, own)?", rest)),
      [],
      `${api} 的 canonical 受核调用必须放行`,
    );
    // `own_top_level` 不核创建代次：只许给 `SetWindowSubclass`，别的写不许拿它当挡箭牌。
    assert.equal(
      taskbarWriteViolations(call(api, "self::own_top_level(&main)?", rest)).length,
      api === "SetWindowSubclass" ? 0 : 1,
      `${api}：own_top_level 仍然只允许子类化`,
    );
    // 改名/取地址的四种形态都不能让"按名字受核"失效。
    for (const [snippet, why] of [
      [`let evil = ${api};`, "函数指针别名"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api} as evil;`, "use as 别名"],
      [`let evil = ${api} as usize;`, "cast 后的裸引用"],
      [`let table = [${api}];`, "数组里的裸引用"],
      [`use evil::${api};`, "非 windows:: 的导入"],
      [`h.${api}(self::ensure_own(policy, own)?)`, "关联方法形态（写目标是接收者）"],
    ]) {
      assert.ok(
        taskbarWriteViolations(snippet).some((item) => item.startsWith(`${api}:`)),
        `${api} 的${why}必须点名：${snippet} -> ${JSON.stringify(taskbarWriteViolations(snippet))}`,
      );
    }
    // 全路径限定调用仍按第一实参受核。
    assert.deepEqual(
      taskbarWriteViolations(`windows::Win32::UI::WindowsAndMessaging::${call(api, "self::ensure_own(policy, own)?", rest)}`),
      [],
      `${api} 的全路径受核调用必须放行`,
    );
    // 字符串 / 注释里的名字不是代码（**调用形态**的字符串是既有的、已钉住的假阳性，见六个写 API 别名引用那条用例，
    // 这里只用非调用形态，避免把那条「多报一侧」的已知行为混进来）。
    assert.deepEqual(taskbarWriteViolations(`let doc = "${api} 是 Win32 的直接改写入口";`), [], `${api}：字符串里的名字不算命中`);
  }

  // 批量 / 多窗口 / 非首参 HWND 的三个 API：本模块**一律禁用**，连 canonical 第一实参也不行
  // （第一实参守卫证明不了"这一批里只有一个自窗"，也证明不了 HDWP 里装的是谁）。
  for (const api of ["DeferWindowPos", "EndDeferWindowPos", "LockWindowUpdate"]) {
    for (const [snippet, why] of [
      [`${api}(hdwp, hwnd(foreign), 0, 0, 0, 0, flags)`, "外来目标调用"],
      [`${api}(self::ensure_own(policy, own)?, hdwp, 0, 0, 0, 0, flags)`, "连 canonical 守卫也不行"],
      [`${api}(hdwp)`, "哪怕没有明显的 HWND 实参"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api};`, "导入也算出现"],
      [`let f = ${api};`, "函数指针别名"],
      [`h.${api}(self::ensure_own(policy, own)?)`, "方法形态"],
    ]) {
      assert.equal(taskbarWriteViolations(snippet).length, 1, `${api}：${why} 必须点名（本模块一律禁用）`);
    }
    assert.deepEqual(taskbarWriteViolations(`let doc = "${api} 是禁用入口";`), [], `${api}：字符串里的名字不是出现`);
    assert.deepEqual(taskbarWriteViolations(`// ${api}(hwnd(foreign))`), [], `${api}：注释里的名字不是出现`);
  }

  // 清单只许扩不许缩：既有十二条仍逐个受核（MUTATION_SIGNATURES 前十二项就是它们），
  // 且真实模块在完整清单下仍然 0 违规（真实现只对自窗写）。
  assert.deepEqual(
    taskbarWriteViolations(read("src-tauri/src/taskbar_lyrics.rs")),
    [],
    "真实实现不许出现未受核的写目标（含本轮扩进来的全部 API 与三个禁用 API）",
  );
});

// 守卫判据必须核控制流与成功出口真身（闭包吞 return、match 影子绑定都会骗过只核关键字的判据），类级写 API 一律禁用。
// 判定一律只收紧：canonical token 形状不匹配即 fail closed。

/** 与真实 `fn ensure_own` 逐 token 相同的 canonical 形状（含 `unsafe {}` 外壳）。
 *  负控都在它上面改**一处**，这样"红了"只能归因于那处控制流/来源，而不是别的形状差异。 */
const FIX2_COND =
  "!IsWindow(Some(handle)).as_bool() || !policy.may_write(own, pid, thread) " +
  "|| thread != GetCurrentThreadId() || pid != std::process::id()";
const FIX2_PREFIX =
  "{ unsafe { let handle = hwnd(own.handle); let mut pid = 0; " +
  `let thread = GetWindowThreadProcessId(handle, Some(&mut pid)); if ${FIX2_COND} { return Err(Reason::Stale); } `;
const FIX2_CANON = `${FIX2_PREFIX}Ok(handle) } }`;

test("R44d fix2 1：守卫体必须是 canonical token 控制流（闭包吞 return / match 影子绑定一律红）", () => {
  const source = read("src-tauri/src/taskbar_lyrics.rs");
  const realBody = ensureOwnBody(source);
  assert.ok(realBody !== null, "真实模块必须能切出 `fn ensure_own` 的函数体");
  assert.deepEqual(ensureOwnProvenanceMisses(realBody), [], "真实守卫体仍必须是 canonical 形状");

  const wrap = (text) => `mod native {\n    fn ensure_own(policy: &EmbedState, own: OwnWindow) -> Result<HWND, Reason> ${text}\n}\n`;
  const missesOf = (text) => {
    const extracted = ensureOwnBody(wrap(text));
    assert.ok(extracted !== null, `仍应能切出函数体（这是判定的事，不是提取的事）：${text.slice(0, 80)}`);
    return ensureOwnProvenanceMisses(extracted);
  };
  const canonicalBody = ensureOwnBody(wrap(FIX2_CANON));
  assert.ok(canonicalBody !== null, "canonical 负控基准必须能切出函数体");
  assert.deepEqual(ensureOwnProvenanceMisses(canonicalBody), [], "canonical 基准体必须通过（下面每条负控只改它一处）");

  // 空白/注释可以变（判据是 token 形状，不是字节相等）：注释在提取时已被等长屏蔽。
  assert.deepEqual(missesOf(FIX2_CANON.replaceAll(" ", "   ")), [], "只改空白的等价写法必须继续通过");
  assert.deepEqual(
    missesOf(FIX2_CANON.replace("unsafe {", "unsafe { // 守卫在这里\n")),
    [],
    "函数体里插注释不算控制流变化（注释是空白）",
  );

  // 两条只核关键字的判据会接受的绕过，控制流判据必须点名。
  const slips = [
    [
      "if 分支里用闭包吞掉 return（Ok(handle) 变成无条件成功）",
      `${FIX2_PREFIX.replace(
        "{ return Err(Reason::Stale); }",
        "{ let _swallow = || { return Err::<HWND, Reason>(Reason::Stale); }; }",
      )}Ok(handle) } }`,
    ],
    [
      "match 的 pattern 影子绑定冒充成功出口",
      `${FIX2_PREFIX}match GetShellWindow() { handle => Ok(handle) } } }`,
    ],
  ];
  // 两条只核关键字的判据会接受的绕过，收集起来一次点名。
  const accepted = [];
  for (const [why, text] of slips) {
    const body = ensureOwnBody(wrap(text));
    assert.ok(body !== null, `${why}：仍应能切出函数体`);
    assert.deepEqual(ensureOwnGuardMisses(body), [], `${why}：旧判据（只核四项 + 次序）确实会接受它`);
    if (!ensureOwnProvenanceMisses(body).some((item) => item.includes("控制流"))) accepted.push(why);
  }
  assert.deepEqual(accepted, [], `控制流判据必须拒绝这两条绕过（旧判据全部接受）：${JSON.stringify(accepted)}`);

  // 其余负控：条件被短路、来源被换、假检查、成功后加料——全部必须红。
  const others = [
    ["四项之间改成 && 连接", FIX2_CANON.replaceAll(" || ", " && ")],
    ["外面套 `false && (…)`", FIX2_CANON.replace(`if ${FIX2_COND} {`, `if false && (${FIX2_COND}) {`)],
    ["外面套 `true || (…)`", FIX2_CANON.replace(`if ${FIX2_COND} {`, `if true || (${FIX2_COND}) {`)],
    ["handle 不是 hwnd(own.handle)", FIX2_CANON.replace("hwnd(own.handle)", "GetShellWindow()")],
    [
      "pid/thread 抄 own 里的值",
      FIX2_CANON.replace(
        "let mut pid = 0; let thread = GetWindowThreadProcessId(handle, Some(&mut pid));",
        "let mut pid = own.pid; let thread = own.thread;",
      ),
    ],
    [
      "检查文本只在块注释里",
      FIX2_CANON.replace(`if ${FIX2_COND} { return Err(Reason::Stale); }`, `/* if ${FIX2_COND} { return Err(Reason::Stale); } */`),
    ],
    ["成功出口之后又加了代码", FIX2_CANON.replace("Ok(handle) } }", "Ok(handle); let _extra = 1; } }")],
  ];
  for (const [why, text] of others) {
    assert.notEqual(text, FIX2_CANON, `负控必须真的改动了基准体：「${why}」`);
    assert.ok(missesOf(text).length >= 1, `「${why}」必须让守卫判定报失败`);
  }
});

test("R44d fix2 2：SetClassLongPtrW/A 是类级写，任何出现都拒绝（canonical 首参也不行）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  for (const api of ["SetClassLongPtrW", "SetClassLongPtrA"]) {
    for (const [snippet, why] of [
      [`${api}(hwnd(foreign), index, value)`, "外来目标直接调用"],
      [`${api}(self::ensure_own(policy, own)?, index, value)`, "canonical 首参也不行（改的是共享窗口类）"],
      [`let f = ${api};`, "函数指针引用"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api} as evil;`, "`use … as` 别名"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api};`, "导入本身也算出现"],
      [`h.${api}(self::ensure_own(policy, own)?, index, value)`, "关联方法形态"],
      [`let table = [${api}];`, "数组里的裸引用"],
    ]) {
      assert.equal(taskbarWriteViolations(snippet).length, 1, `${api}：${why} 必须点名：${snippet}`);
    }
    assert.deepEqual(taskbarWriteViolations(`let doc = "${api} 是类级写";`), [], `${api}：字符串里的名字不是出现`);
    assert.deepEqual(taskbarWriteViolations(`// ${api}(hwnd(foreign), 0, 0)`), [], `${api}：注释里的名字不是出现`);
  }
  // 普通首参受核的邻居不受影响（防止"一刀切所有 Set*Long*"式误伤）。
  assert.deepEqual(
    taskbarWriteViolations("SetWindowLongPtrW(self::ensure_own(policy, own)?, index, value)"),
    [],
    "SetWindowLongPtrW 仍是首参受核（只拒绝外来目标）",
  );
  assert.equal(taskbarWriteViolations("SetWindowLongPtrW(hwnd(foreign), index, value)").length, 1, "SetWindowLongPtrW 仍核第一实参");
  assert.deepEqual(taskbarWriteViolations(read("src-tauri/src/taskbar_lyrics.rs")), [], "真实实现不碰类级写");
});

test("R44d fix2 3：SendMessageTimeoutW/A 的夹具必须是真实参数表（Msg, wParam, lParam, flags, timeout, result）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const EXPECTED = "message, w, l, flags, timeout, Some(&mut result)";
  for (const api of ["SendMessageTimeoutW", "SendMessageTimeoutA"]) {
    const row = MUTATION_SIGNATURES.find(([name]) => name === api);
    assert.ok(row !== undefined, `${api} 必须在 first-HWND 受核清单里`);
    assert.equal(row[1], EXPECTED, `${api} 的样例必须按 windows 0.61 的真实参数表写全（含 timeout）`);
    assert.equal(row[1].split(",").length, 6, `${api}：HWND 之后是 6 个实参（Msg/wParam/lParam/flags/timeout/result）`);
    assert.equal(taskbarWriteViolations(`${api}(hwnd(foreign), ${row[1]})`).length, 1, `${api}：外来目标必须点名`);
    assert.deepEqual(
      taskbarWriteViolations(`${api}(self::ensure_own(policy, own)?, ${row[1]})`),
      [],
      `${api}：canonical 首参必须放行`,
    );
    // 真实全参数表（含 timeout、结果指针）同样按第一实参受核，不因参数变多而换判据。
    assert.equal(
      taskbarWriteViolations(`${api}(hwnd(foreign), WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 100, Some(&mut result))`).length,
      1,
      `${api}：完整真实参数表下外来目标仍要点名`,
    );
  }
});

test("R44d fix2 4：RemoveWindowSubclass 只允许当前子类回调对内层自窗的移除（其他出现一律点名）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const real = read("src-tauri/src/taskbar_lyrics.rs");
  // 真实模块的调用点是已审例外：唯一一份 `lyrics_proc` 子类回调里，用回调自己的 `window`/`id`
  // 撤掉自己装的子类（`WM_NCDESTROY`）。除此之外本模块没有任何 RemoveWindowSubclass。
  assert.deepEqual(taskbarWriteViolations(real), [], "真实实现的 RemoveWindowSubclass 必须是已审例外");
  const occurrences = [...real.matchAll(/\bRemoveWindowSubclass\b/g)].length;
  assert.equal(occurrences, 2, "真实实现里只有 import 与回调内各一次（新增调用点必须先过复审）");

  const CALL = "RemoveWindowSubclass(window, Some(lyrics_proc), id)";
  const callbackSource = [
    "struct NativeLife { alive: u32 }",
    'unsafe extern "system" fn lyrics_proc(window: HWND, message: u32, w: WPARAM, l: LPARAM, id: usize, ref_data: usize) -> LRESULT {',
    "    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};",
    "    if message == WM_NCDESTROY { let _ = RemoveWindowSubclass(window, Some(lyrics_proc), id); }",
    "    DefSubclassProc(window, message, w, l)",
    "}",
  ].join("\n");
  assert.deepEqual(taskbarWriteViolations(callbackSource), [], "子类回调里撤自己的子类是唯一放行形态");
  // 只变空白（`( window , Some ( lyrics_proc ) , id )`）不是"换目标"：判据是实参 token，不是字节。
  assert.deepEqual(
    taskbarWriteViolations(callbackSource.replace(CALL, "RemoveWindowSubclass( window , Some ( lyrics_proc ) , id )")),
    [],
    "回调自撤的实参只差空白时必须继续放行（判据是实参 token，不是字节相等）",
  );

  const inCallback = (call) => callbackSource.replace(CALL, call);
  for (const [call, why] of [
    ["RemoveWindowSubclass(GetShellWindow(), Some(lyrics_proc), id)", "回调外的 shell 窗"],
    ["RemoveWindowSubclass(hwnd(foreign), Some(lyrics_proc), id)", "回调里的外来窗"],
    ["RemoveWindowSubclass(window, Some(evil_proc), id)", "别人的子类回调"],
    ["RemoveWindowSubclass(window, Some(lyrics_proc), other_id)", "别人的子类 id"],
    ["h.RemoveWindowSubclass(window, Some(lyrics_proc), id)", "方法形态（接收者来源不可证）"],
  ]) {
    const snippet = inCallback(call);
    assert.equal(taskbarWriteViolations(snippet).length, 1, `${why} 必须点名：${call}`);
  }

  // 回调**外**的调用不许借"参数名恰好对"混过去：只有唯一一份 lyrics_proc 的体内才是放的。
  assert.equal(
    taskbarWriteViolations(`fn f() { let _ = ${CALL}; }`).length,
    1,
    "回调外的同形调用必须点名（参数名不是凭证，位置才是）",
  );
  assert.equal(
    taskbarWriteViolations(`${CALL};`).length,
    1,
    "没有子类回调时的同形调用必须点名",
  );
  // 回调存在多份 / 无法唯一定位时 fail closed。
  assert.equal(
    taskbarWriteViolations(
      [callbackSource, 'unsafe extern "system" fn lyrics_proc(window: HWND) -> LRESULT { LRESULT(0) }'].join("\n"),
    ).length,
    1,
    "lyrics_proc 定义必须唯一，两处定义时 fail closed",
  );
  // 改名/导入形态照旧按名字级规则点名。
  for (const [snippet, why] of [
    ["let f = RemoveWindowSubclass;", "函数指针别名"],
    ["use windows::Win32::UI::Shell::RemoveWindowSubclass as evil;", "`use … as` 别名"],
    ["use evil::RemoveWindowSubclass;", "非 windows:: 的导入"],
  ]) {
    assert.ok(taskbarWriteViolations(snippet).length >= 1, `${why} 必须点名：${snippet}`);
  }
  // 无 `as` 的 windows 导入（绑定名没变）仍放行。
  assert.deepEqual(
    taskbarWriteViolations("use windows::Win32::UI::Shell::RemoveWindowSubclass;"),
    [],
    "无 as 的 windows 导入不是别名",
  );
});

// `SetClassLongW/A`、`SetClassWord` 与 `SetClassLongPtrW/A` 同为类级写，走 `BLANKET_FORBIDDEN_APIS`。
// 同一段 canonical 首参调用，普通受核 API 放行，这三条必须点名“一律禁用”。

test("R44d fix3：SetClassLongW/A、SetClassWord 是类级写，任何出现都拒绝（canonical 首参也不行）", async () => {
  const { taskbarWriteViolations } = await import("../scripts/acceptance.mjs");
  const CLASS_WIDE_APIS = ["SetClassLongW", "SetClassLongA", "SetClassWord"];

  for (const api of CLASS_WIDE_APIS) {
    for (const [snippet, why] of [
      [`${api}(hwnd(foreign), index, value)`, "外来目标直接调用"],
      [`${api}(self::ensure_own(policy, own)?, index, value)`, "canonical 首参也不行（改的是共享窗口类）"],
      [`let f = ${api};`, "函数指针引用"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api} as evil;`, "`use … as` 别名"],
      [`use windows::Win32::UI::WindowsAndMessaging::${api};`, "无 as 导入本身也算出现"],
      [`h.${api}(self::ensure_own(policy, own)?, index, value)`, "关联方法形态"],
    ]) {
      assert.equal(taskbarWriteViolations(snippet).length, 1, `${api}：${why} 必须点名：${snippet}`);
    }
    // 名字级规则只看代码：字符串/注释里的名字不是出现。
    assert.deepEqual(taskbarWriteViolations(`let doc = "${api} 是类级写";`), [], `${api}：字符串里的名字不是出现`);
    assert.deepEqual(taskbarWriteViolations(`// ${api}(hwnd(foreign), 0, 0)`), [], `${api}：注释里的名字不是出现`);
  }

  // 必须落在 blanket 一侧：canonical 首参被拒绝，且诊断是"一律禁用"——
  // 如果它只是被塞进普通受核清单，canonical 首参会被放行（那就等于没修）。
  for (const api of CLASS_WIDE_APIS) {
    const violations = taskbarWriteViolations(`${api}(self::ensure_own(policy, own)?, index, value)`);
    assert.equal(violations.length, 1, `${api}：canonical 首参必须被拒绝（类级写）`);
    assert.match(violations[0], /一律禁用/, `${api} 必须由 blanket 规则点名，不是普通首参受核：${violations[0]}`);
  }

  // 邻居不受影响（防止"一刀切所有 Set*Class*Long*"式误伤）：首参受核的两个同族 API
  // 仍是 canonical 放行、外来点名。
  for (const api of ["SetWindowLongW", "SetWindowLongPtrW"]) {
    assert.deepEqual(
      taskbarWriteViolations(`${api}(self::ensure_own(policy, own)?, index, value)`),
      [],
      `${api} 仍是首参受核（canonical 首参放行）`,
    );
    assert.equal(taskbarWriteViolations(`${api}(hwnd(foreign), index, value)`).length, 1, `${api} 仍核第一实参`);
  }

  // 当前真实实现不碰类级写：完整清单下仍 0 违规。
  assert.deepEqual(taskbarWriteViolations(read("src-tauri/src/taskbar_lyrics.rs")), [], "真实实现不碰类级写");
});

test("acceptance：锚点缺失会被点名（不是静默通过），SKIP 不算 PASS", async () => {
  const mod = await import("../scripts/acceptance.mjs");
  const misses = mod.anchorMisses(
    [{ file: "a.txt", pattern: /必须出现/, why: "钉住存在" }, { file: "a.txt", pattern: /不该有的/, why: "钉住不存在" }],
    () => "这里什么都没有",
  );
  assert.equal(misses.length, 1, `有牙：${JSON.stringify(misses)}`);
  assert.match(misses[0], /a\.txt/);

  assert.equal(mod.pathVerdict({ pass: 3, fail: 0, skipped: 0 }), "PASS");
  assert.equal(mod.pathVerdict({ pass: 3, fail: 0, skipped: 1 }), "FAIL", "SKIP 不算 PASS");
  assert.equal(mod.pathVerdict({ pass: 0, fail: 1, skipped: 0 }), "FAIL");
  assert.match(mod.formatSummary([{ id: "x", verdict: "PASS" }]), /PASS 1 \/ SKIP 0 \/ FAIL 0/);
});

// ---------------------------------------------------------------------------
// 7. test:browser：PASS / SKIP 0 / FAIL 口径
// ---------------------------------------------------------------------------

test("test:browser：SKIP 会让整体判失败（无 Chromium 环境 = FAIL，不是静默跳过）", async () => {
  const mod = await import("../scripts/test-browser.mjs");
  assert.equal(mod.guardVerdict({ pass: 5, fail: 0, skipped: 0 }), "PASS");
  assert.equal(mod.guardVerdict({ pass: 4, fail: 0, skipped: 1 }), "FAIL");
  assert.equal(mod.guardVerdict({ pass: 0, fail: 1, skipped: 0 }), "FAIL");
  assert.match(mod.formatGuardSummary({ pass: 5, fail: 0, skipped: 0 }), /PASS 5 \/ SKIP 0 \/ FAIL 0/);
});

test("test:browser：Chromium 候选顺序 = 显式覆盖 → playwright 自带 → 系统 Chrome/Edge", async () => {
  const mod = await import("../scripts/test-browser.mjs");
  const kinds = mod.chromiumCandidates({ env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE: "C:\\x\\chromium.exe" } }).map(
    (candidate) => candidate.kind,
  );
  assert.equal(kinds[0], "env", "显式覆盖优先");
  assert.deepEqual(kinds.slice(1), ["playwright", "channel:chrome", "channel:msedge"], "都要有，缺一个都可能在本机白跑");
  assert.deepEqual(
    mod.chromiumCandidates({ env: {} }).map((candidate) => candidate.kind),
    ["playwright", "channel:chrome", "channel:msedge"],
  );
});

// ---------------------------------------------------------------------------
// 8. release-checksums
// ---------------------------------------------------------------------------

test("release:checksums：SHA256SUMS 行是 `<sha>  <name>`，按名字稳定排序", async () => {
  const mod = await import("../scripts/release-checksums.mjs");
  const lines = mod.checksumLines([
    { name: "b.exe", sha256: "bb" },
    { name: "a.exe", sha256: "aa" },
  ]);
  assert.deepEqual(lines, ["aa  a.exe", "bb  b.exe"]);
  assert.equal(mod.sha256Of(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ---------------------------------------------------------------------------
// 9. CI 工作流
// ---------------------------------------------------------------------------

const WORKFLOW = ".github/workflows/windows-nsis.yml";

/** 把 YAML 里 `run: |` 的块状脚本切出来（够用即可，不引 yaml 依赖）。 */
function runBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|-?\s*$/.exec(lines[index]);
    if (match === null) {
      const single = /^(\s*)run:\s*(\S.*)$/.exec(lines[index]);
      if (single !== null) blocks.push({ indent: single[1].length, body: single[2] });
      continue;
    }
    const indent = match[1].length;
    const collected = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() !== "" && line.search(/\S/) <= indent) break;
      collected.push(line);
    }
    blocks.push({ indent, body: collected.join("\n") });
  }
  return blocks;
}

test("CI：windows-latest、npm ci，且每个 run 块里的命令都显式查 $LASTEXITCODE（pwsh 不会自动失败）", () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /npm ci/);

  const blocks = runBlocks(workflow);
  assert.ok(blocks.length >= 8, `run 块太少（${blocks.length}），打包链没有真的进 CI`);
  const invoking = blocks.filter((block) => /^\s*(npm|node|cargo|npx)\b/m.test(block.body));
  assert.ok(invoking.length >= 6, `调用外部命令的 run 块只有 ${invoking.length} 个`);
  for (const block of invoking) {
    assert.match(
      block.body,
      /\$LASTEXITCODE/,
      `每个 run 块都要显式查 $LASTEXITCODE，这一块没有：\n${block.body}`,
    );
  }
});

test("CI：npm run 之间不串 &&（npm 的 script-shell 可能是 PowerShell），全链按步断言", () => {
  const workflow = read(WORKFLOW);
  assert.doesNotMatch(workflow, /&&\s*(?:npm|node|cargo)\b/, "不许用 && 串命令（失败会被吞）");
  assert.doesNotMatch(workflow, /\bnpx\b/, "不引 npx（本机与 CI 都要直接路径）");
  for (const step of [
    "test:acceptance",
    "test:browser",
    "dist:win",
    "check:nsis",
    "release:checksums",
  ]) {
    assert.ok(workflow.includes(step), `CI 缺步骤 ${step}`);
  }
  assert.match(workflow, /CARGO_TARGET_DIR/, "CARGO_TARGET_DIR 的唯一真源在 workflow 里");
});

test("CI：npm test 断言 fail 0 / skipped 0，test:browser 断言 PASS N / SKIP 0 / FAIL 0", () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /fail 0/, "npm test 的 fail 0 要有断言");
  assert.match(workflow, /skipped 0/, "npm test 的 skipped 0 要有断言");
  assert.match(workflow, /SKIP 0/, "test:browser 的 SKIP 0 要有断言（SKIP 不算成功）");
  assert.match(workflow, /test-reporter=tap|--test-reporter/, "计数要从稳定的 reporter 输出里读");
});

test("CI：release 只在 v* 标签触发，发布说明含四句免责声明，main 推送只传 artifact", () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /startsWith\(github\.ref,\s*'refs\/tags\/v'\)|refs\/tags\/v\*/, "v* 标签才发布");
  assert.match(workflow, /actions\/upload-artifact/, "main 推送要留 artifact");
  assert.match(workflow, /softprops\/action-gh-release|gh release create/, "Release 步骤要走 GitHub Release");

  for (const phrase of ["未签名", "非官方", "OAuth", "AGPL"]) {
    assert.ok(workflow.includes(phrase), `发布说明缺免责声明关键词：${phrase}`);
  }
});

test("CI：构建顺序与本地一致——先构建产物，再 test:browser / dist:win / check:nsis", () => {
  const workflow = read(WORKFLOW);
  const order = ["npm ci", "run test", "typecheck", "test:browser", "cargo test", "dist:win", "check:nsis", "release:checksums"];
  let cursor = -1;
  for (const token of order) {
    const at = workflow.indexOf(token);
    assert.ok(at > cursor, `CI 步骤顺序不对（${token} 应排在 ${order[order.indexOf(token) - 1] ?? "最前"} 之后）`);
    cursor = at;
  }
  assert.match(workflow, /dist:sidecar|dist-win\.mjs/, "浏览器守卫要跑在产物构建之后（它需要 dist:sidecar 与渲染层）");
});

// ---------------------------------------------------------------------------
// 10. 文档锚点：RUN_AND_PACKAGING 必须说清编排与 untested 的边界
// ---------------------------------------------------------------------------

test("docs/RUN_AND_PACKAGING.md：写清构建顺序、mtime 检查、SEA 两层打包与 CI 口径", () => {
  const doc = read("docs/RUN_AND_PACKAGING.md");
  for (const phrase of ["build:web", "dist:sidecar", "dist:win", "check:nsis", "mtime", "$LASTEXITCODE", "SHA256SUMS"]) {
    assert.ok(doc.includes(phrase), `交付文档缺关键事实：${phrase}`);
  }
});

// ---------------------------------------------------------------------------
// 11. smoke:build：三种结论不许混为一谈（UNTESTED 不是 PASS）
// ---------------------------------------------------------------------------

test("smoke:build：UNTESTED 单独一个退出码（0=PASS / 1=FAIL / 2=UNTESTED）", async () => {
  const mod = await import("../scripts/tauri-smoke.mjs");
  assert.equal(mod.exitCodeFor("PASS"), 0);
  assert.equal(mod.exitCodeFor("FAIL"), 1);
  assert.equal(mod.exitCodeFor("UNTESTED"), 2, "把「本机没测」写成 0 就是伪造验收");
  assert.ok(mod.formatSmokeSummary({ verdict: "UNTESTED", reason: "无交互式会话" }).includes("UNTESTED"));

  const base = {
    spawnFailed: null,
    alive: true,
    windowHandle: 1234,
    windowProbeAvailable: true,
    elapsedMs: 900,
    timeoutMs: 20_000,
  };
  assert.equal(mod.smokeVerdict(base).verdict, "PASS", "进程活着 + 主窗句柄非 0 = 真建了窗");
  assert.equal(mod.smokeVerdict({ ...base, windowHandle: 0 }).verdict, "FAIL", "进程活着但窗口没建出来是真故障");
  assert.equal(mod.smokeVerdict({ ...base, alive: false }).verdict, "FAIL", "进程自己退出 = 启动失败");
  assert.equal(mod.smokeVerdict({ ...base, spawnFailed: "EPERM" }).verdict, "UNTESTED", "起不了进程是环境限制，不是通过");
  assert.equal(mod.smokeVerdict({ ...base, windowProbeAvailable: false }).verdict, "PASS", "查不到窗口句柄时如实只断言存活");
});

test("smoke:build：环境拒绝访问（os error 5）判 UNTESTED，没有这个指纹的崩溃仍判 FAIL", async () => {
  const mod = await import("../scripts/tauri-smoke.mjs");
  const crashed = {
    spawnFailed: null,
    alive: false,
    windowHandle: null,
    windowProbeAvailable: true,
    elapsedMs: 1200,
    timeoutMs: 20_000,
    exitCode: 101,
    stderr: "",
  };
  // 本机实测到的那一条：日志插件往 %LOCALAPPDATA% 写文件被沙箱拒绝 → panic → 101
  const denial = mod.smokeVerdict({
    ...crashed,
    stderr: 'thread \'main\' panicked: Tauri 应用启动失败: PluginInitialization("log", "拒绝访问。 (os error 5)")',
  });
  assert.equal(denial.verdict, "UNTESTED", "环境拒绝访问不是产物坏了，但也绝不是通过");
  assert.match(denial.reason, /拒绝访问|os error 5/);

  const realCrash = mod.smokeVerdict({ ...crashed, stderr: "thread 'main' panicked at src/lib.rs:119: 建窗失败" });
  assert.equal(realCrash.verdict, "FAIL", "指纹必须窄：任何崩溃都算「环境」的话，这条闸就废了");
  assert.match(mod.stderrTail(""), /没有 stderr/);
});

test("exe 名来自 Cargo.toml 的 [[bin]] name，不是 productName（实测踩过：按显示名 stat → ENOENT 把成功判成失败）", async () => {
  const mod = await import("../scripts/dist-win.mjs");
  const smoke = await import("../scripts/tauri-smoke.mjs");
  const exeName = await mod.appExeName(repoRoot);
  assert.equal(exeName, "huawei-music-desktop.exe");
  assert.notEqual(
    exeName,
    `${readJson("src-tauri/tauri.conf.json").productName}.exe`,
    "productName 是显示名（安装包文件名与快捷方式用它），cargo 产物叫 <[[bin]] name>.exe",
  );
  // 三个脚本必须同一处事实：dist:win 的新鲜度检查 / check:nsis 的暂存名 / 冒烟的启动目标
  assert.equal(await smoke.appExeName(repoRoot), exeName);
  const cargoToml = read("src-tauri/Cargo.toml");
  assert.ok(cargoToml.includes(`name = "${exeName.replace(/\.exe$/, "")}"`), "本地真源就是 Cargo.toml");
});

test("release:checksums：真写文件（sha256sum 形状），空产物集合不写出空清单", async (t) => {
  const mod = await import("../scripts/release-checksums.mjs");
  const dir = `${TMP}/checksums`;
  rmSync(dir, { recursive: true, force: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outPath = `${dir}/SHA256SUMS`;
  const body = await mod.writeChecksums({
    outPath,
    entries: [
      { name: "b.exe", sha256: "bb" },
      { name: "a.exe", sha256: "aa" },
    ],
  });
  assert.equal(body, "aa  a.exe\nbb  b.exe\n", "行形状与排序都要稳定（重跑不该有 diff）");
  assert.equal(readFileSync(outPath, "utf8"), body);

  // 本地骨架：产物一个都没有时 defaultOutPath 仍落在安装包旁边，好让"缺产物"这条错误指向明确位置
  const fallback = mod.defaultOutPath([], { root: repoRoot, profile: "debug" });
  assert.match(fallback, /src-tauri[\\/]target[\\/]debug[\\/]bundle[\\/]nsis[\\/]SHA256SUMS$/);
});
