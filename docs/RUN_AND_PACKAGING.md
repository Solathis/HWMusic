# 运行与打包（Windows）

面向"要在这台机器上把应用跑起来 / 打出安装包 / 看懂 CI"的人。事实只有一处真源：
脚本本身（`scripts/*.mjs`）与 `.github/workflows/windows-nsis.yml`，本文只解释它们为什么这么排。

## 1. 跑起来（开发）

```powershell
npm ci
npm run dev          # tauri dev：起 vite（devUrl 1420）+ 编译 Rust + 开窗
npm run dev:web      # 只起渲染层（改界面时更快，但没有宿主能力）
```

真窗跑不起来（容器/无桌面会话、WebView2 数据目录不可写 → `os error 5`）时**如实记 untested**，
不要用"SSR 渲出静态标记"冒充"窗口起来了"。

## 2. 打包链：三步，顺序是硬要求

```
build:web     vite build        → out/renderer
dist:sidecar  esbuild + SEA     → src-tauri/binaries/hwmusic-core-<triple>.exe
tauri build   cargo + NSIS      → src-tauri/target/release/bundle/nsis/*.exe
```

**为什么不能直接 `tauri build`**：`tauri.conf.json` 的 `beforeBuildCommand` 是空串（有意为之）。
Tauri 不会替你构建渲染层，它把 `frontendDist`（`out/renderer`）里**已有的**东西原样嵌进 exe——
改了界面却发布出旧界面，而且**退出码 0**。所以编排写在 `scripts/dist-win.mjs` 里：

```powershell
npm run dist:win         # = build:web → dist:sidecar → tauri build，逐步查退出码
```

`npm run` 之间不串 `&&`：npm 的 script-shell 在 Windows 上可能是 PowerShell，
`&&` 的语义会变、失败也容易被吞。编排由 Node 逐步 spawn，每步单独判退出码。

### mtime 新鲜度检查（防"嵌了旧界面还退出码 0"）

打包**之后**再验一遍：每个被打包进去的输入（`out/renderer/**` 与 sidecar 二进制）都必须
**不晚于**主程序 exe 的 `mtime`。谁比 exe 新，谁就没进这一个 exe（Tauri 复用了旧 exe，或者编排被绕开），
这时 `dist:win` **退出码非 0** 并点名是哪个产物。这条检查本身有测试：
`test/packaging.test.mjs` 用真实文件 mtime 造了"旧 exe + 新产物 → 必须失败"的用例。

### sidecar：为什么是两层 esbuild

Node 的 SEA 嵌入入口**只认 CJS**，而 `src/sidecar/main.mjs` 有顶层 await。所以
`dist:sidecar` 先用 esbuild 出 ESM（顶层 await 被收进 `__esm` 闭包），再转 CJS 作为 SEA 的 `main`；
只有 `node:*` 是外部依赖（undici 必须打进来：SEA 进程里没有 `node_modules`）。
注入完 `postject` 之后有**负向对照**（产物 SHA256 必须异于原 `node.exe`）与**双模式自验证**
（`memory-only` 与 `secure` 各真起一次，断言 stderr 结论行与宿主要求通道）。

## 3. 校验

```powershell
npm run check:nsis        # 对打包产物做静态校验（不执行安装包）
npm run release:checksums # 生成 SHA256SUMS
npm run smoke:build       # 起一次真产物（PASS / FAIL / UNTESTED，见第 5 节）
```

`check:nsis` 验八件事：安装包恰好一个且是 PE、sidecar 按三元组命名且是 PE、暂存目录能枚举、
暂存里有主程序与**剥掉三元组后缀**的 sidecar、bundle 配置与暂存目录都不含 `.local`/`research`。
它**不执行安装包**：装一次要写系统目录、注册表、开始菜单，还会拉起 WebView2 安装器，
在 CI 里等于给每个 PR 装一次应用。默认看 `release` 暂存目录；
`HWMUSIC_BUNDLE_PROFILE=debug` 时用开发期产物验同一套骨架。

`release:checksums` 写出 `<sha256>  <文件名>` 形状的 `SHA256SUMS`（按文件名排序，
重跑不产生无意义 diff）。产物一个都没有时它**报错退出**，不写空清单——
空的 `SHA256SUMS` 看起来像"校验过了"。

## 4. 测试

| 命令 | 验什么 | 口径 |
|---|---|---|
| `npm run test` | R3–R13 的功能与契约测试 | `fail 0` 且 `skipped 0`（跳过的测试不算验过） |
| `npm run test:acceptance` | 六条关键路径（登录门禁/代理/托盘/桌面歌词/任务栏降级无注入/设置持久化） | 引用既有测试与源码锚点，**不复制断言逻辑**；`PASS N / SKIP 0 / FAIL 0` |
| `npm run test:browser` | AMLL 面板/背景在真 Chromium 里的 DOM 与像素断言 | 无 Chromium = **FAIL**，不是静默跳过：`PASS N / SKIP 0 / FAIL 0` |
| `cd src-tauri; cargo test` | Rust 侧 | 全绿 |

## 5. smoke:build 的三种结论

| 结论 | 退出码 | 含义 |
|---|---|---|
| `PASS` | 0 | 进程活着，且主窗句柄非 0（真建了窗） |
| `FAIL` | 1 | 进程自己退出 / 到超时都没建出窗（真故障） |
| `UNTESTED` | 2 | 本机起不了交互式窗口（沙箱拒绝建窗等）——**不是通过** |

单独给 UNTESTED 一个退出码，是为了让调用方不可能把"没测"当成"过了"。
它不进 CI（无人值守的运行器只会得到 UNTESTED）；它是本地/发布前的人工步骤。

"环境拒绝访问"与"产物坏了"靠 stderr 的**窄指纹**分开（只认 `os error 5` / `拒绝访问` /
`Access is denied`，别的崩溃一律 FAIL——指纹放宽等于把这条闸关掉）。本机实测（2026-10-19）：

```
thread 'main' panicked at src\lib.rs:326:10:
Tauri 应用启动失败: PluginInitialization("log", "拒绝访问。 (os error 5)")
→ smoke:build 结果：UNTESTED（退出码 2）
```

原因是这台机器的沙箱不给写 `%LOCALAPPDATA%\<identifier>\logs`（tauri-plugin-log 的落点），
应用在建窗之前就 panic 了——**产物没问题，是这台机器测不了"窗口真的建起来了"这件事**，
所以如实记 untested。

## 6. CI（`.github/workflows/windows-nsis.yml`）

顺序：`npm ci` → `npm run test`（断言 `fail 0` / `skipped 0`，计数从 `--test-reporter=tap` 读）
→ `typecheck` → 验收六路径 → 装 Chromium → `dist:sidecar` + `build:web`
→ `test:browser`（断言 `PASS N / SKIP 0 / FAIL 0`）→ `cargo test` → `dist:win` → `check:nsis`
→ `release:checksums` → artifact（main 推送与标签都留）→ Release（**仅 `v*` 标签**）。

几条不能改的规矩：

- **每个 run 块都显式查 `$LASTEXITCODE`**：pwsh 不会因为原生命令非 0 就自动失败，
  不查的话"步骤全绿"可能只是没人看退出码。
- 单元测试的计数从稳定的 reporter 里读：`NODE_OPTIONS=--test-reporter=tap` 再 `npm run test`。
  **不能**写成 `npm run test -- --test-reporter=tap`：npm 把追加参数放在位置参数**之后**，
  而 node 从第一个位置参数起就不再解析自己的选项（实测：会把 `test` 当模块 require，报 MODULE_NOT_FOUND）。
- `npm run test` 自己用 `node --test test/*.test.mjs` 这种**显式路径**，不用 `node --test` 的自动发现：
  自动发现会把 `scripts/test-browser.mjs`（命中 `test-*.mjs`）也当成测试文件跑掉，
  单元测试就悄悄依赖起浏览器了。
- **命令之间不串 `&&`**（理由同第 2 节），也不引 `npx`：工具都走仓内直接路径。
- `CARGO_TARGET_DIR` 的**唯一真源在 workflow 里**（`${{ github.workspace }}/src-tauri/target`）：
  脚本与校验步骤都从这个目录读产物，否则步骤之间会各看各的目录。
- 推 `main` 只构建 + 留 artifact；推 `v*` 标签才发 Release，发布说明带四句免责声明
  （未签名 / 非官方 / OAuth 身份不属于本项目 / AGPL 完整源码地址）。

## 7. 本机环境限制（不假造然后说"验过了"）

- 沙箱只给工作区内的可删范围：esbuild/vite/tauri 的临时文件用默认 `%TEMP%` 会失败
  （清理时报 `Access is denied`）。所以脚本**对子进程**把 `TEMP`/`TMP` 指向仓内 `.tmp/temp`，
  不改用户环境。
- `dist:win` 里的 `tauri build` 是**编译打包**不是跑窗，通常可行；真窗冒烟才需要交互式桌面会话。
- 跑不了的一律记 **untested**（并写清是谁的边界），CI 是那一段的执行点。
