/**
 * R14 打包链 · 契约测试（先写先看红）。
 *
 * 本文件只钉**打包链自己的**正确性，不重复 R3–R13 的功能断言：
 *
 * 1. `dist:win` 的编排顺序与 **mtime 新鲜度检查**——`beforeBuildCommand` 是空串，
 *    绕过编排直接 `tauri build` 会把旧界面嵌进 exe 且退出码 0（旧仓实际故障），
 *    所以"渲染层产物比 exe 新"必须**判失败**，这里用真实文件 mtime 造一次；
 * 2. `check:nsis` 的静态校验骨架：PE 头、三元组命名、剥后缀的暂存名、
 *    bundle 配置输入与暂存目录里不许出现 `.local`/`research`（凭据纪律）；
 * 3. `test:browser` 的 PASS/SKIP/FAIL 口径：SKIP 不算成功；
 * 4. `.github/workflows/windows-nsis.yml`：每步显式查 `$LASTEXITCODE`、不串 `&&`、
 *    SKIP 0 / fail 0 断言、v* 标签才 Release、四句免责声明；
 * 5. `tauri.conf.json` 加回 R2 裁决遗留的 `bundle.externalBin`。
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

// ---------------------------------------------------------------------------
// 2. tauri.conf.json：R2 裁决遗留的 externalBin 加回
// ---------------------------------------------------------------------------

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
