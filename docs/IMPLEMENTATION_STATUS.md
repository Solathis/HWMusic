# IMPLEMENTATION_STATUS — 实现状态与证据

> **这份文档只回答一件事**：「这个东西，凭什么说它是好的？」
>
> **档位只有四档**，每个断言都必须能指向证据（测试名 / 脚本名 / 命令 / 提交号）：
>
> | 档位 | 含义 |
> |---|---|
> | **verified** | 有**可复现证据**。证据分两类，本文**分开写**：**代码级 verified**（自动化测试/脚本/源码扫描）与 **真机 verified**（在真实桌面会话里跑出来、眼睛看得见） |
> | **in-progress** | 部分实现，明确知道缺哪一块 |
> | **pending** | 已设计、已登记，但还没开始（含「明确不做」） |
> | **untested** | **实现存在，但没有任何实测证据**。这一档不许说成"支持" |
>
> **红线**：一切「已验收」都能指到证据；**未验证的平台与功能一律不宣称支持**。
> 本文与 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) 的档位逐条一致。

基准时间：2026-10-19　仓库 HEAD：`97a03d6`（R0–R15 共 **16 次提交**，R15 的交付文档已提交；
终审修复波的 7 项改动在工作树里，随 v0.1.0 标签一并提交）

---

## 0. 全局测试基线（终审修复波实测，全绿；真窗冒烟除外，见末行）

| 链路 | 命令 | 结果 |
|---|---|---|
| Node 单元/契约测试 | `npm run test`（`node --test test/*.test.mjs`） | **528 pass / 0 fail / 0 skipped** |
| 类型检查 | `npm run typecheck` | exit 0（`tsc --noEmit` 无输出） |
| 验收六路径 | `npm run test:acceptance` | **PASS 6 / SKIP 0 / FAIL 0**；无注入扫描 15 类 token × 110 文件 → **0 命中** |
| 真 Chromium 守卫 | `npm run test:browser` | **PASS 7 / SKIP 0 / FAIL 0**（像素级：面板字迹比例 67.02%、推进 3300ms 像素差 1.79%、运行期 console error 0；R14 / R15 / 终审修复波各跑一次，数字是同一档） |
| Rust 测试 | `cd src-tauri; cargo test` | **194 passed / 0 failed / 1 ignored**（lib 173 + 集成 21：`login_policy` 17 + `frame_log_redaction` 4） |
| sidecar 自验证 | `npm run dist:sidecar` | 2/2（`memory-only` PASS、`secure` PASS；产物 SHA ≠ node.exe）——**R14 实测值，终审修复波未重跑** |
| NSIS 静态校验 | `npm run check:nsis` | 8/8 ——**R14 实测值，终审修复波未重跑** |
| 真窗冒烟 | `npm run smoke:build` | **UNTESTED（退出码 2）——不是通过**（见 KNOWN_LIMITATIONS B 组） |

> 本表前五行是终审修复波（工作树：HEAD `97a03d6` + 7 项修复）的实测值；R14 那一轮的同类数字
> （`npm test` 525、Rust 188）留在 §1 的 R14 行，作为那一轮的历史证据。
> `0 skipped` 是硬口径：**跳过的测试不算验过**。验收脚本对引用测试同样要求 `skipped == 0`，
> 并把 `SKIP > 0` 直接判 FAIL。

---

## 1. R0–R15 逐任务完成态

| 任务 | 内容 | 提交 | 状态 | 决定性证据 |
|---|---|---|---|---|
| **R0** | 工具链、空仓、LICENSE/NOTICE | `ccb29ef` | **verified**（证据由控制器直测，**报告缺失**） | rustc/cargo 1.99.1 可用；MSVC `VC.Tools.x86.x64`（vswhere 实测）；LICENSE 661 行 AGPL 全文；NOTICE 12 项归属；`.gitignore` 条目齐。**无实现报告**（委派被中断反复 cancel，证据是直测 — 见 KNOWN_LIMITATIONS G1） |
| **R1** | 前端骨架与设计令牌（Vite + React + Tailwind v4 + shadcn + AMLL） | `dd7ad33` | **verified（代码级）** | 20 个 shadcn 原语；`npm run typecheck` exit 0；`build:web` exit 0（双入口产物齐）；契约逐条核对 |
| **R2** | Tauri v2 外壳与最小权限 | `8ca149d` | **verified（代码级）** | `cargo test` 8/8；`cargo build` exit 0；图标链幂等；**ACL 恰 5 权限**；TDD RED=16 errors → GREEN |
| **R3** | sidecar NDJSON 桥与白名单 | `c306ea6` | **verified（代码级）** | Node 37/37、Rust 42/42；真进程双向收尸端到端 0.20s；`channel-parity.test.mjs`、`sidecar-e2e.test.mjs` |
| **R4** | OAuth PKCE 协议原型 + 探针 | `8606b72` | **verified（代码级）**；端到端 untested | 123/123；probe 实测确认 authorize/token/loginCallback 三个端点；**变异测试证明守卫有牙**；`endpoint_unknown` 注入式设计。真实兑换 untested（A4） |
| **R5** | DPAPI 安全存储 | `7ffbaea` | **verified（代码级）** | Rust 61 passed + **1 ignored**（半程端到端，见下）；Node 146/146；tsc 0；`cargo build` 无警告；两个变异被杀 |
| **R6** | 统一设置与 HTTP 代理 | `033ff13` | **verified（代码级）** | Rust 84+1 ignored、Node 202；跨语言 host 清洗夹具 31 例双语言互钉；**本地假代理端到端到 HTTP 头级**；5 变异全灭；主窗 `proxy_url` 接线由源码扫描 + 跨进程 e2e 双钉。真抓包 untested（B11） |
| **R7** | 引导页与扫码登录 | `f297461` | **verified（代码级）**；真窗 untested | Rust lib 95+1 ignored / `login_policy` 10；Node 245/245；双端 10 分钟互钉、白名单双份互钉、48 互钉实测；五生产者共用 take-once 结论槽；Rust 先答复再拆窗 |
| **R8** | 主界面与页面 | `ea0979e` | **verified（代码级）**；真窗 untested | Node 290/290；7 条 `library:*` 频道走常量表 + parity 硬钉 + Rust 镜像；`react-dom/server` 渲染冒烟 14 锚点；自审修 6 个真缺陷 |
| **R9** | 播放器与歌词面板 | `1f2aba9` | **verified（代码级）**；真机播放 untested | Node 391/391；AMLL 官方组件真实挂载冒烟 23/23；`resolve-url` 地址纪律结构性落地（构造器强制 `guardUrl`、不进状态/日志/盘）；队列持久化只存 ids+index |
| **R10** | 设置页 | `2992bdc` | **verified（代码级）** | Node 451/451、cargo 101+15；**ACL 无 capability 条目的论断经审查者逐行核对 vendored tauri 2.12 源码成立**（前置条件被测试钉死）；主题令牌双钉；SSR 冒烟 19/19 抓到 `SelectValue` 空触发真缺陷并修 |
| **R11** | 托盘与关窗行为 | `7fe6ebd` | **verified（代码级）**；真机托盘 untested | Rust 132+15、Node 464/464；`emit_core_event` 成为唯一信封构造点（全模块扫描验证为真）；`CORE_DEFAULT` 与 `CONSERVATIVE` 拆分钉死"新装用户界面说藏起来关窗却退出"的谎言 |
| **R12** | 桌面歌词与任务栏降级 | `76e2c1c` | **verified（代码级）**；真窗 untested | Rust 148+15、Node 496/496；四条 async 命令全守卫；R6 三窗 `proxy_url` 收口实测接线；**无注入扫描 16 token × 0 命中**；4 变异全灭；tsc 拦下 `document` 遮蔽全局真缺陷 |
| **R13** | 系统集成（快捷键等七项） | `9e1352d` | **verified（代码级）**；真机按键 untested | Rust 173+15、Node 496/496；`shortcuts.rs` 925 行 21 内联测试；**接线变异校验**（install 提前 + 托盘写死 true → 2 用例红）；媒体键无备选不静默换键；七项收口核对全过 |
| **R14** | 打包、验收与 CI | `6968ba2` | **verified（代码级 + 本机打包真跑通）**；CI/安装/真窗 untested | `npm test` 525/525/0；acceptance 6/0/0；`test:browser` 7/0/0；`check:nsis` 8/8；`dist:win` **本机真跑通**（NSIS **26134896 B** + mtime 新鲜度检查通过）；修 2 真缺陷 + 1 flake 根因 |
| **R15** | 交付文档与契约核对 | `97a03d6` | **verified（文档级）**；`host:notify` 端到端未跑过（如实登记） | `docs/API_CONTRACT.md` §2.11 增补（R3–R7 五条请求频道 + 三条宿主要求）与 §5 变更记录；[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) 与本文的档位收口。**只补文档、不动代码**（该提交只改了 `README.md` 与 `docs/` 下四份文档） |

**唯一那个 `1 ignored`**：R5 的 DPAPI 半程端到端用例——sidecar 的发起方在 R7，
所以当前形态不是完整端到端。`cargo test -- --ignored` 手动跑得 `1 passed`。

---

## 2. 能力矩阵（**代码级 verified 与真机 verified 分开写**）

**读法**：`代码级` 一列是「自动化证据」，`真机` 一列是「在真实桌面会话里跑出来」。
**`真机` 列为空白的行，就是"这个功能没被真机验过"** —— 无论 `代码级` 多绿。

| # | 能力 | 代码级 | 真机 | 证据（可复现） |
|---|---|---|---|---|
| 1 | OAuth PKCE（`state` 一次性 + 常量时间比对 + 10 分钟过期） | **verified** | untested | `test/login-callback.test.mjs`、`test/auth.test.mjs`；终局类别表 `LOGIN_TERMINAL_CALLBACK_ERROR_KINDS` 有穷尽归类断言 |
| 2 | 授权码 → 账号 AT 兑换 | **verified（注入式）** | untested（无账号） | `test/auth-manager.test.mjs`「端点真源」直接读 `docs/API_CONTRACT.md` 并断言两条端点字面量仍在 |
| 3 | 音乐会话兑换（`loginex`） | **verified（端点 + 形状）** | **端点存在性 verified / 兑换往返 untested** | R17 补全：端点与请求形状有公开证据、端点存在性本机实测（`test/music-session.test.mjs` 钉形状与纪律；证据分级见 `docs/API_CONTRACT.md` §1.5.1）。「有效 AT → 真会话」要用户授权扫码，仍未实测（A2） |
| 4 | DPAPI 会话加密/解密 | **verified** | **verified**（本机 `cargo test` 真跑 DPAPI；+1 ignored 是半程端到端） | `src-tauri/src/secure_store.rs` 内联测试；`test/session-store.test.mjs` |
| 5 | 设置持久化（`settings.json` 形状/清洗/0600/原子写） | **verified** | **verified**（本机真写盘、真读回） | `test/settings-test-proxy.test.mjs`、`test/settings-page.test.mjs`、`scripts/acceptance.mjs` 的 `settings-persistence` 路径（4 条源码锚点） |
| 6 | HTTP 代理（sidecar 侧 undici `ProxyAgent`） | **verified** | **verified**（本地假代理端到端到 HTTP 头级） | `test/proxy.test.mjs`；`test/fixtures/proxy-host-cases.json` 31 例跨语言互钉（5 变异全灭） |
| 7 | HTTP 代理（三窗 webview `proxy_url`） | **verified**（源码扫描 + 跨进程 e2e 双钉） | untested（真抓包） | `test/proxy.test.mjs` 的接线扫描；`scripts/acceptance.mjs` 的 `proxy` 路径 |
| 8 | 登录门禁（未登录不渲染主界面） | **verified** | untested | `test/login-gate.test.mjs`；`scripts/acceptance.mjs` 的 `login-gate` 路径（4 锚点：`shouldShowLoginGate` 判定 + `App.tsx` 真的挡在 `app-shell` 之前） |
| 9 | 登录子窗（白名单导航 / `hms://` 拦截 / 双期限 / 四收场） | **verified** | untested | `test/login-parity.test.mjs`（双端互钉）；Rust `src/login.rs` 内联测试 + `tests/login_policy.rs` 17 passed（含建窗失败路径删一次性数据目录） |
| 10 | 收藏分页（无可信总数 → 完整分页去重） | **verified** | untested（端点未配） | `test/favorites-pagination.test.mjs`；协议层 `readFavoritesPage` |
| 11 | 歌单 / 搜索 / 专辑 / 歌手 / 历史 | **verified（协议层 + UI 三态）** | untested（端点未配） | `test/music.test.mjs`、`test/library-views.test.mjs`、`test/dispatcher.test.mjs`、`test/sidecar-e2e.test.mjs`（真进程） |
| 12 | 播放器状态机 + 队列持久化 | **verified** | untested（无真实音源） | `test/playback-state.test.mjs`、`test/playback-queue.test.mjs`、`test/playback-runtime.test.mjs`、`test/playback-player.test.mjs` |
| 13 | 播放地址纪律（不日志/不落盘/不缓存/不进状态） | **verified** | untested | `test/playback-channel.test.mjs`；断言状态快照序列化后不含 `http`/CDN 域 |
| 14 | `<audio>` 真实播放 | untested | untested | 端点未配置 → 无法验（B10） |
| 15 | 歌词解析适配（`[offset:]` + 翻译行）+ 逐行滚动 | **verified** | untested | `test/lyrics.test.mjs`、`test/amll-adapter.test.mjs`、`test/lyric-sync.test.mjs`；AMLL 官方组件真实挂载冒烟 23/23 |
| 16 | 歌词文本通道（`playback:lyrics`） | **verified（频道）** | untested（端点未配） | `test/lyrics-window.test.mjs`、`test/channel-parity.test.mjs` |
| 17 | Media Session 系统媒体控件 | **verified（映射逻辑）** | untested | `test/media-session.test.mjs` |
| 18 | 桌面歌词窗（属性/几何/配置/四条 async 命令） | **verified** | untested | `test/lyrics-window.test.mjs`；Rust `lyrics_window.rs` 内联几何矩阵；`scripts/acceptance.mjs` 的 `desktop-lyrics` 路径 |
| 19 | 任务栏歌词（**降级实现**：独立窗贴 `work_area`） | **verified** | untested | `scripts/acceptance.mjs` 的 `taskbar-fallback-no-injection` 路径 + **全源码 token 扫描 0 命中** |
| 20 | 托盘（9 槽位菜单 / 勾选镜像 / 失败提示） | **verified** | untested | `test/tray.test.mjs`；Rust `tray.rs` 内联测试 |
| 21 | 关窗 fail-safe（托盘真装上才藏窗口） | **verified** | untested | `src-tauri/src/tray.rs` 的 `decide_close` 矩阵；`scripts/acceptance.mjs` 的 `tray` 路径（锚点要求现场查 `tray_by_id`） |
| 22 | 全局快捷键（5 动作 / 备选链 / 失败提示） | **verified** | untested | `src-tauri/src/shortcuts.rs` 21 内联测试；接线变异校验（2 变异各自被专用用例抓到） |
| 23 | 开机自启（读回观测值） | **verified（判定逻辑，假 manager）** | untested（**刻意不写真实注册表**） | `test/autostart.test.mjs`；Rust `commands.rs::apply_autostart` |
| 24 | 系统通知 / 单实例 / 窗口状态 / 日志（四插件） | **verified** | untested | Rust 插件链顺序断言 + 源码扫描（`lib.rs` 内联测试） |
| 25 | 打包链（`build:web` → `dist:sidecar` → `tauri build` + mtime 新鲜度） | **verified** | **verified**（本机真跑通一次） | `scripts/dist-win.mjs`；`test/packaging.test.mjs`（29 条契约测试，含"旧 exe + 新产物 → 必须失败"） |
| 26 | sidecar SEA 打包与自验证 | **verified** | **verified**（本机真的起了两个模式） | `scripts/build-sidecar.mjs`；负向对照（产物 SHA ≠ node.exe） |
| 27 | NSIS 安装包静态校验（8 项） | **verified** | untested（**不执行安装包**） | `scripts/check-nsis-package.mjs`；`test/packaging.test.mjs` |
| 28 | CI 流水线（17 步） | **verified（YAML + 5 条契约测试）** | untested（没在 GitHub 上跑过） | `.github/workflows/windows-nsis.yml`；`yaml.safe_load` 验过；`test/packaging.test.mjs` 的 5 条 CI 契约测试 |
| 29 | 真窗冒烟（`smoke:build`） | verified（三种结论与退出码） | **UNTESTED**（本机起不了真窗，退出码 2） | `scripts/tauri-smoke.mjs`；窄指纹只认 `os error 5` / `拒绝访问` / `Access is denied`，别的崩溃一律 FAIL |
| 30 | Linux / macOS 支持 | untested | untested | **本仓不宣称支持**（见 KNOWN_LIMITATIONS C 组与 [PLATFORM_DIFFERENCES.md](PLATFORM_DIFFERENCES.md)） |

---

## 3. 六条验收路径的落点（`npm run test:acceptance`）

| id | 路径 | 它证明什么 | 引用测试 |
|---|---|---|---|
| `login-gate` | 登录门禁 | 未登录不渲染主界面；扫码回调只拦 `hms://` | `login-gate` / `login-callback` |
| `proxy` | 代理 | 单一真源 `settings.json` + 三窗接线 + 凭据纪律 | `proxy` / `proxy-settings` / `settings-test-proxy` |
| `tray` | 托盘 | 托盘 9 槽位 + 关窗 fail-safe（托盘真装上才藏窗口） | `tray` / `close-behavior` |
| `desktop-lyrics` | 桌面歌词 | 独立透明窗 + 几何纯函数 + 不回写 | `lyrics-window` / `lyrics-panel` |
| `taskbar-fallback-no-injection` | 任务栏降级 | 贴 `work_area` 下沿；全源码 0 注入 API | `lyrics-window` + token 扫描（15 类 × 110 文件） |
| `settings-persistence` | 设置持久化 | `settings.json` 形状 + DPAPI 会话信封 | `settings-test-proxy` / `session-store` / `settings-page` |

三条口径（写在脚本文件头，这里复述）：**不复制断言逻辑**（引用既有测试，否则漂移的那一份才是假证据）；
**SKIP 不算 PASS**；**锚点缺失要停**（测试文件或锚点文件不见了直接失败并点名，绝不静默跳过）。

---

## 4. 与 API 契约的对应

`docs/API_CONTRACT.md` 是**接口事实与协议的单一真源**，各任务维护自己的那一节，R15 只做核对与增补：

| 契约节 | 由谁落地 | R15 核对结论 |
|---|---|---|
| §1.1–§1.4 OAuth 参数 / authorize / token / 登录域白名单 | R4 | 完整；§3 的三条端点字面量由 `test/auth-manager.test.mjs` 直接读取断言 |
| §1.5 令牌链环节（`loginex`） | R4、**R17** | R17 增补：`loginex` 从「待联调」升到「端点 + 形状已确认」，证据分三级如实标注；**兑换往返仍未实测** |
| §1.6 `consumeCallback` 宿主契约 | R4 修复轮 1 | 完整 |
| §1.7 登录子窗 ↔ sidecar 线上契约 | R7 | 完整（含 `FrameNavigationStarting` 缺口的如实登记） |
| §2.1–§2.4 业务端点登记 / 注入键 / 响应语义 / CDN 域 | R4、R8 | 完整（§2.4 的标题回归已由 R8 修复轮插回；R15 把该段整体上移到 §2.5 之前，§2 编号现在单调） |
| §2.5 `library:*` 七条频道 | R8 | 完整 |
| §2.6 播放地址与 `player:command` | R9（R11 更新发送方） | 完整 |
| §2.7 设置页 ↔ core / 外壳 | R10（R11 更新关窗口径） | 完整 |
| §2.8 托盘与关窗 fail-safe | R11 | 完整 |
| §2.9 桌面歌词窗与任务栏降级 | R12 | 完整 |
| §2.10 系统集成与全局快捷键 | R13 | 完整 |
| **§2.11（R15 增补）** | **R3 / R5 / R6 / R4 / R7** | **核对发现缺漏并补齐**：`host:notify`、`host:secure-encrypt/decrypt`（R3/R5）、`settings:get/set`（R6）、`auth:login/logout/cancel-login`（R4/R7）这些频道在全文里只被**引用**（如「§2.5 的既有语义」），却没有一处登记过载荷与回执形状。R15 按代码事实补成 §2.11 |
| §3 本地常量唯一真源位置 | R4–R13 逐任务增补 | 完整（39 行） |
| §4 红线（四条） | R4 | 完整 |
| §5 变更记录 | R4–R13 逐任务增补 | 完整；R15 追加一行（§2.11 增补） |

---

## 5. 怎么自己复跑这一整套

```powershell
npm ci
npm run typecheck
npm run test                 # 528 / 0 / 0
npm run test:acceptance      # PASS 6 / SKIP 0 / FAIL 0
npm run test:browser         # PASS 7 / SKIP 0 / FAIL 0（需 Chromium）
cd src-tauri; cargo test; cd ..   # 194 passed / 1 ignored

# 打包（顺序是硬要求，用编排脚本而不是直接 tauri build）
npm run dist:sidecar
npm run build:web
npm run dist:win             # 含 mtime 新鲜度检查
npm run check:nsis           # 8/8
npm run release:checksums
npm run smoke:build          # 本机预期 UNTESTED(2)：不是通过
```

受限环境（`%TEMP%` 不可删）下先设好仓内临时目录，理由见
[RUN_AND_PACKAGING.md](RUN_AND_PACKAGING.md) §7。
