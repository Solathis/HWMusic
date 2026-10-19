# 华为音乐第三方桌面客户端

> ## ⚠️ 非官方声明（先读这一段）
>
> 本项目是**第三方独立实现**，与华为及其关联公司**没有任何隶属、合作或代理关系**，
> **不是官方发布物**。华为音乐、华为帐号等一切官方权利归官方所有。
>
> 本项目的登录环节打开的是**华为官方的授权页面**，用的是**上游项目注册的** OAuth client id
> （`101444301`，见 [OAuth 身份声明](#oauth-身份声明必须读)）——本项目不持有任何官方凭据，
> 也不代表官方立场。请自行评估使用风险。

Tauri v2 + React 的桌面客户端外壳：官方授权页扫码登录、音乐库浏览、播放器与歌词、
桌面歌词窗与任务栏歌词降级、托盘与全局快捷键、统一 HTTP 代理设置。

**当前交付状态的准确说法**：代码级与纯函数级已验收（Node 525 / Rust 188 / 验收六路径 6 / 真 Chromium 7 项 / NSIS 静态校验 8 项，全绿）；
**但真实账号扫码、真实音乐业务端点、真实窗口视觉与 Linux/macOS 平台都还没有实测**。
逐项档位见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)，
逐项限制见 [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)。
**本 README 不宣称任何未验证的平台或功能。**

---

## 1. 快速开始（开发）

### 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.15.0** | `package.json` 的 `engines` 硬约束；SEA 打包与 `node --test` 都用它 |
| Rust 工具链 | stable（实测 rustc/cargo 1.99.1） | `rustup` 安装，Windows 目标 `x86_64-pc-windows-msvc` |
| MSVC Build Tools | 需含 `VC.Tools.x86.x64` | Windows 上 `cargo` 的链接器；实测 VS 18 Community 满足 |
| WebView2 Runtime | Windows 上由安装包 `downloadBootstrapper` 引导 | 开发机通常已随 Edge 装好（实测 155.0.4283.62） |

### 跑起来

```powershell
npm ci
npm run dev          # tauri dev：起 vite（devUrl http://localhost:1420）+ 编译 Rust + 开窗
npm run dev:web      # 只起渲染层（改界面时更快，但没有宿主能力：window.desktop 不存在）
```

### 启动即扫码门禁（这不是 bug）

应用起来后**看到的第一屏是官方授权页**，不登录就进不了主界面。这是设计：

- 未登录时 `App.tsx` 渲染的是登录门禁（`shouldShowLoginGate` 在渲染之前拦），主界面根本不挂载；
- 登录窗是**独立子 webview**（无边框、不进任务栏、独立数据目录、不与主窗共享会话），
  导航白名单放行、回调只拦 `hms://`，**不给官方页注入任何脚本**；
- 二维码由**官方页面自己渲染**，本项目不引入二维码库（自绘二维码 = 自实现登录协议，触碰身份边界）；
- 登录结论走 `auth:status` 广播（扫码要好几分钟，而 IPC 那条链有 60 秒上限）。

数据目录不可写（受限沙箱、`%APPDATA%` 被策略锁）时用环境旋钮排障：

```powershell
$env:HWMUSIC_DATA_DIR = "E:\hwmusic-data"    # 必须是绝对路径；空值/相对路径等同未设置
npm run dev
```

---

## 2. 功能范围

### 已提供（各自档位见 IMPLEMENTATION_STATUS）

- **登录**：PKCE S256 扫码登录（`state` 一次性 + 常量时间比对 + 10 分钟过期）、四收场结论、
  双期限（首载 30 秒 / 总 10 分钟）文案、取消、登出。
- **会话存储**：Windows DPAPI（`CryptProtectData`）加密信封，`0600` + 临时文件 + rename 原子写。
- **音乐库**：收藏（分页 + 去重得出总数）、自建歌单列表与曲目、搜索、专辑/歌手、播放历史。
  六个页面共用一套「加载 / 失败 / 空」三态纪律。
- **播放器**：状态机、队列（持久化只存曲目标识 + 索引）、播放模式、音量、
  Media Session 系统媒体控件对接。
- **歌词**：AMLL 官方组件渲染、`[offset:]` 补偿与翻译行合并、逐行滚动、面板与独立歌词窗。
- **桌面歌词窗**：无边框/透明/置顶/不进任务栏/可拖动/点透，字号档位与颜色令牌。
- **任务栏歌词（降级实现）**：独立透明窗贴 `work_area` 下沿。**不是**注入任务栏 —— 见第 8 节。
- **托盘与关窗行为**：9 槽位菜单、关窗 fail-safe（托盘真的装上才藏窗口，否则真退出）。
- **全局快捷键**：媒体三键 + `Ctrl+Alt+L` 等，逐条注册、失败回退并有提示。
- **设置**：HTTP 代理（含凭据与例外列表、测试连接）、开机自启、关窗行为、歌词窗配置。
- **打包**：SEA sidecar + NSIS 安装包 + `SHA256SUMS` + GitHub Actions 流水线。

### 明确不做（范围外，不是"还没做完"）

- **旧仓数据迁移**：本仓没有旧数据（旧仓已整体删除），`migrate` 不做。
- **每日推荐 / 移动端 / 云同步 / 自动更新服务 / 其它平台音源**。
- **音频解密、绕过任何付费或 DRM**：只播官方接口给出的地址。
- **主题手动切换**：亮暗只跟随系统 `prefers-color-scheme`，不做切换开关（有意裁决）。
- **歌词窗配置持久化**：字号/颜色/模式/锁定/点透只在本次运行内生效。
- **任务栏文字注入**：绝不做（见第 8 节）。
- **签名分发**：不签名，不另开分发渠道，二进制只经 GitHub Release。

---

## 3. 构建与打包

**顺序是硬要求**，见 [docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md)（那里是完整说明，本节只给命令表）：

```
build:web  →  dist:sidecar  →  tauri build
vite build    esbuild + SEA     cargo + NSIS
→ out/renderer → src-tauri/binaries/hwmusic-core-<triple>.exe → src-tauri/target/release/bundle/nsis/*.exe
```

`tauri.conf.json` 的 `beforeBuildCommand` 是**空串**（有意为之）：Tauri 不会替你构建渲染层，
它把 `frontendDist` 里已有的东西原样嵌进 exe —— 改了界面却发布出旧界面，而且**退出码 0**。
所以编排写在 `scripts/dist-win.mjs` 里，并在打包**之后**做 mtime 新鲜度检查：
任何被打包进去的输入比主程序 exe 新，`dist:win` 直接非 0 退出并点名是哪个产物。

| 命令 | 做什么 |
|---|---|
| `npm run build:web` | `vite build` → `out/renderer`（双入口：`index.html` + `lyrics.html`） |
| `npm run dist:sidecar` | esbuild（ESM→CJS）→ Node SEA + postject → `src-tauri/binaries/hwmusic-core-<triple>.exe` |
| `npm run dist:win` | 上面三步的编排 + mtime 新鲜度检查 |
| `npm run check:nsis` | 对打包产物做**静态**校验（8 项：PE 头、三元组命名、暂存目录内容、不含 `.local`/`research`） |
| `npm run release:checksums` | 写 `SHA256SUMS`（按文件名排序，重跑无意义 diff 为零） |
| `npm run smoke:build` | 起一次真产物：`PASS`(0) / `FAIL`(1) / `UNTESTED`(2) |

为什么 `beforeBuildCommand` 空串、mtime 检查怎么算、sidecar 为什么要两层 esbuild、CI 的 17 个步骤与
几条不能改的规矩、`smoke:build` 三种结论分别意味着什么 —— 全部在
[docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md)。

---

## 4. 测试

| 命令 | 验什么 | 口径 |
|---|---|---|
| `npm run test` | Node 侧功能与契约测试 | `525 pass / 0 fail / 0 skipped`（**跳过的测试不算验过**） |
| `npm run typecheck` | `tsc --noEmit` | exit 0 |
| `npm run test:acceptance` | 六条关键路径（登录门禁/代理/托盘/桌面歌词/任务栏降级无注入/设置持久化） | `PASS 6 / SKIP 0 / FAIL 0`；引用既有测试与源码锚点，**不复制断言逻辑** |
| `npm run test:browser` | AMLL 面板/背景在**真 Chromium** 里的 DOM 与像素断言 | `PASS 7 / SKIP 0 / FAIL 0`；无 Chromium = **FAIL**，不静默跳过 |
| `cd src-tauri; cargo test` | Rust 侧单元 + 集成测试 | `188 passed / 0 failed / 1 ignored` |

`cargo test` 的 **1 个 ignored** 是 R5 那条半程端到端 DPAPI 用例（sidecar 发起方在 R7，
当前形态不是完整端到端）；用 `cargo test -- --ignored` 手动跑。

### TEMP 环境说明（本机沙箱限制，不是代码问题）

受限会话里 `%TEMP%` 落在不可删的目录下，esbuild/vite/tauri 清理自己的临时文件时会报
`Access is denied`。打包脚本**对子进程**把 `TEMP`/`TMP` 指向仓内 `.tmp/temp`（已 gitignore），
**不改用户环境变量**；手动跑 `vite build` 时如果撞上同一个报错，照这个方向处理即可。
CI 的 runner 自带可写 TEMP，不受影响。

---

## 5. 架构与四条安全边界

```
┌─ 渲染层（WebView2 / React）───────── 无凭据、无对外 fetch、CSP 收紧
│    window.desktop.core_call(channel, payload)   ← 唯一业务通道（频道白名单）
└──────────────┬──────────────────────────────────────────────
               │ Tauri IPC（core_call / core_renderer_ready / core_* 命令）
┌──────────────▼─ Rust 外壳（src-tauri）── 建窗、托盘、歌词窗、登录窗、DPAPI、代理装配
│    require_main_window 来源守卫 + 频道准入 + 事件信封唯一构造点
└──────────────┬──────────────────────────────────────────────
               │ NDJSON 帧（stdin/stdout；日志一律 stderr）
┌──────────────▼─ sidecar `hwmusic-core`（Node SEA）─ 设置、代理、OAuth、业务 HTTP
│    undici ProxyAgent；凭据只活在这里的内存与 DPAPI 信封里
└─────────────────────────────────────────────────────────────
```

| # | 边界 | 落点（可核对） |
|---|---|---|
| 1 | **凭据只在 sidecar / Rust** | 渲染层拿不到 Token；业务 HTTP 只在 sidecar 侧；`auth:status` 载荷里没有账号标识（不为显示扩协议） |
| 2 | **登录页零权限、零注入** | 登录窗独立子 webview + 独立数据目录；`capabilities/main.json` 的 `windows` 只有 `main`/`lyrics`；不订阅 `initialization_script`/`eval`，白名单与回调只靠导航事件观测 |
| 3 | **不放宽任何安全开关** | `tauri.conf.json` 的 CSP 收紧（`connect-src` 只有 `'self' ipc: http://ipc.localhost`；`object-src 'none'`；`base-uri 'none'`；`frame-ancestors 'none'`）；不关 webSecurity、不放宽 TLS、不注册全局 `hms://` 协议、不改系统代理 |
| 4 | **不注入、不 Hook 系统进程** | 托盘用 Tauri `tray-icon`；任务栏歌词只用「独立透明窗 + `work_area` 贴边」；`SetWindowsHookEx`/`SetWinEventHook`/`Shell_TrayWnd`/`FindWindow`/`SetParent`/`explorer.exe` 等 token 由 `npm run test:acceptance` 的**全源码扫描**钉成 0 命中 |

关键实现事实：

- **sidecar 生命周期**：stdin EOF → 收尸并 `exit(0)`；双向收尸不依赖单侧 kill。
- **建窗必须 async**：`WebviewWindowBuilder::build` 内部要走一趟主线程往返，同步命令自己站在主线程上等它 = 死锁（旧仓结论，沿用）。
- **启动期提示必须排队**：Rust 的 `NoticeQueue` 等到 `core_renderer_ready` 才冲刷，否则「已登录」「代理来自环境变量」这类事实会发进空气。
- **单一真源 + 跨语言互钉**：频道名、命令名、常量（`LOGIN_VIEW_TOP_INSET`、期限、字号档位…）各有唯一真源文件，Rust 侧是**刻意的镜像副本**，由 parity 测试扫源码钉住集合相等。

---

## 6. 数据与隐私

| 落点 | 内容 | 保护 |
|---|---|---|
| 应用数据目录 | `<数据根>/` | 数据根三级解析：`HWMUSIC_DATA_DIR` 旋钮 → 应用数据目录 → 应用缓存目录；**绝不回退 cwd**（打包后当前目录不可预测） |
| `<数据根>/settings.json` | 设置（含**代理密码明文**） | 0600 尽力而为 + 用户目录 ACL；形状不认识就当「没配」，**认不出的文件绝不覆盖** |
| `<数据根>/session.enc` | 音乐会话（唯一的落盘凭据） | Windows DPAPI 加密信封；0600 + 临时文件 + rename 原子写；且**跨用户/跨机器必然解不开**（DPAPI 的设计意图） |
| `<数据根>/webview2/{main,login/<partition>,lyrics}` | 各窗独立 webview 数据目录 | 主窗与子窗**不共用**（共用会被 WebView2 的库锁互相踩） |
| 内存 | 账号 AT/RT、音乐会话 | 只在 sidecar 内存与 DPAPI 信封里；**不落盘、不进日志** |

**日志红线（`tauri-plugin-log`，Info / KeepOne / 4MB）**：

- 播放地址**不写日志、不落盘、不缓存、不进状态**（可能带时效签名）；
- 代理凭据**绝不进日志/错误文案**；webview 侧只允许出现 `host:port`（Chromium 的 `--proxy-server` 不接受内联凭据，凭据在那里就被丢弃并报告）；
- 登录 URL 不进日志（旧仓把整段 URL 打进日志 = 把一次性凭据抄进日志文件）；
- 面内错误只带域名或结构化类别，不回显整段响应体；
- 界面提示克制：调试信息、请求细节、堆栈进日志，**不进 UI**。

**探针（`scripts/probe-*.mjs`）**：只碰公开资源，**不登录任何账号、不读取任何私人凭据、不写 cookie**；
两条红线（不落响应正文、敏感参数值打码）由 `test/probe-lib.test.mjs` 钉住；产物落 `.probe/`（已 gitignore）。

**不打包、不提交**：`.local/`（真实账号凭据/音乐库数据）、`.tmp/`、`.probe/`、`research/`、`out/`、`src-tauri/target/`、`src-tauri/binaries/`。
`check:nsis` 里有一条专门校验：bundle 配置与暂存目录都不得含 `.local`/`research`。

---

## 7. 已知限制（摘要，完整清单见 KNOWN_LIMITATIONS）

**一切未实测的项都在 [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) 逐条列着，共 62 条**（分七组：授权与联调、真窗与运行期、平台、功能边界、设计口径、工具链、文档交付）。最要紧的几条：

1. **真实账号扫码登录没有实测**（需要真实账号 + 用户在场授权）。回调成功链只在注入式测试里验过。
2. **真实音乐业务端点全部未知**（K1 风险未消除）。所以收藏/搜索/歌单/专辑/歌手/历史/播放地址/歌词
   在真实环境里回的都是结构化的「接口尚未配置（待联调确认）」——**这是如实，不是坏了**。
   代码坚持**端点注入式**，不写任何猜测 URL。
3. **`loginex`（账号 AT → 音乐会话）端点与请求形状待联调**：默认实现直接回结构化「待联调」，**一次请求都不发**。
4. **真实窗口视觉未验收**：开发机的沙箱起不了真窗（`tauri-plugin-log` 写 `%LOCALAPPDATA%` 被拒，
   `os error 5`）。托盘点击、歌词窗透明/置顶/点透、快捷键、媒体键、界面观感都只有
   「代码级 + 纯函数级 + 静态渲染冒烟」证据。
5. **Linux / macOS 未实测，本仓不宣称支持**。Windows 之外的构建在本机不参与编译（`#[cfg(windows)]`/`#[cfg(target_os)]` 分支），
   Linux 打包未做过，macOS 只配了 `macos-proxy`（且仅 14+ 生效）。差异细节见 [docs/PLATFORM_DIFFERENCES.md](docs/PLATFORM_DIFFERENCES.md)。
6. **任务栏歌词是降级实现**：三端都没有「往任务栏里写文字」的公开 API，所以只有「独立透明窗 + 贴 `work_area` 下沿」
   这一种做法，**绝不注入系统进程、不装系统钩子、不做 shell 扩展**。
7. **安装包未签名、未实际执行安装**：`check:nsis` 只做静态校验；CI 未在 GitHub 上真跑过一遍。
8. **歌词窗配置不持久化**（明确不做）、**主题手动切换非目标**、**旧仓数据迁移不做**。

---

## OAuth 身份声明（必须读）

登录链路使用 `client_id = 101444301`（`redirect_uri = hms://redirect_uri`，`scope = openid`，
`access_type = offline`，PKCE S256）。

- 这个身份**不是本项目注册的**，极可能是**华为音乐官方 App 的 OAuth 身份**；
- 本项目**不持有**该身份的任何凭据，也**没有被授权使用它**；
- 该身份**随时可能失效**（官方改配置、下线 v3 端点、换区域主机都会让它失效）；
- 本项目**不做**「修身份式重试」（不尝试伪造、轮换或猜测其它 client id）；
- 唯一证据等级：token 端点对一个**无效**授权码回了「授权码无效」而不是「客户端未注册」——
  这只是「身份被受理」的**弱证据**，**不等于**身份被授权使用。详见
  [docs/API_CONTRACT.md](docs/API_CONTRACT.md) §1.1/§1.3。

## 免责声明

1. **非官方**：本项目是第三方独立实现，与华为及其关联公司没有任何隶属、合作或代理关系，
   不是官方发布物；华为音乐、华为帐号等一切官方权利归官方所有。
2. **未签名**：发布物没有代码签名证书，Windows SmartScreen 会提示「未知发布者」。
   这不是被篡改的证据，但**也没有任何东西替你担保这个文件**——请用同一 Release 里的
   `SHA256SUMS` 自己核一遍（`certutil -hashfile <安装包> SHA256`）。
3. **OAuth 身份不属于本项目**：见上一节。登录凭据只落本机（DPAPI 保护的会话信封），
   不进发布物、不进 CI。
4. **按现状提供（AS IS）**：本项目不提供任何担保。因使用本项目产生的账号风险、
   数据风险或其它后果，由使用者自行承担。请自行确认你的使用方式符合当地法律与官方条款。
5. **AGPL 完整源码**：本项目以 AGPL-3.0-only 授权，对应版本的完整源码须随 Release 提供。
   当前仓库尚未配置 remote，CI 发布说明里的源码地址是**占位符**，发布前必须替换为真实地址。

## 许可

- 本项目源代码：**GNU Affero General Public License v3.0 only（AGPL-3.0-only）**，全文见 [LICENSE](LICENSE)。
- 第三方组件归属与各自许可证：见 [NOTICE](NOTICE)（Tauri、React、Vite、TypeScript、Tailwind、shadcn/ui、
  radix-ui、cva、AMLL、Lucide、undici、Node.js）。图标归属见 `build/icon.LICENSE.txt`。
- 注意：AMLL（`@applemusic-like-lyrics/*`）是 **AGPL-3.0-only**。以二进制形式分发本项目时，
  须一并保留 `NOTICE` 与相应许可证文本。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | 每个任务与每项能力的档位（verified / in-progress / pending / untested）+ 证据指向 |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | 全部未验证项与已知限制，逐条（含"谁的边界、谁来验"） |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | 接口事实与协议的**唯一真源**：OAuth 端点与证据、业务端点登记（全部待确认）、频道/命令契约、常量位置、红线、变更记录 |
| [docs/PLATFORM_DIFFERENCES.md](docs/PLATFORM_DIFFERENCES.md) | 三端（Windows/Linux/macOS）能力差异、capability 权限清单、托盘/代理/窗口/快捷键/任务栏歌词 |
| [docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md) | 打包链为什么这么排、`smoke:build` 三种结论、CI 17 步与几条不能改的规矩 |
| [docs/superpowers/plans/2026-10-18-full-rebuild-from-zero.md](docs/superpowers/plans/2026-10-18-full-rebuild-from-zero.md) | 过程文档：本次从零重建的实施计划（Global Constraints 是硬边界的真源） |
| [.superpowers/sdd/…/](.superpowers/sdd/2026-10-18-full-rebuild-from-zero/) | 过程文档：R0–R15 的任务简报与实现报告（未入库，仅在本地工作树） |

**日志与报告**：`.superpowers/` 与 `.tmp/` 已 gitignore，属本机过程资料，不在发布物内。
