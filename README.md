# 华为音乐第三方桌面客户端（HWMusic）

基于 Tauri 2 + React 的华为音乐 Windows 桌面客户端：扫码登录、音乐库与播放、AMLL 歌词与沉浸页、桌面歌词、Windows 任务栏歌词（Beta）、托盘与全局快捷键、HTTP 代理。

项目地址：https://github.com/Solathis/HWMusic

> **先读这三句**
>
> 1. **非官方**：本项目是第三方独立实现，与华为及其关联公司没有任何隶属、合作或代理关系，不是官方发布物；华为音乐、华为帐号等一切官方权利归官方所有。
> 2. **未签名**：安装包没有代码签名，Windows SmartScreen 会提示「未知发布者」。请用同一 Release 里的 `SHA256SUMS` 自己核对文件。
> 3. **OAuth 身份不属于本项目**：登录打开的是华为官方授权页，用的 client id（`101444301`）沿用自参考实现，本项目不持有任何官方凭据，详见下文「OAuth 身份声明」。

---

## 下载与安装

安装包只经 [GitHub Releases](https://github.com/Solathis/HWMusic/releases) 发布，不另设网盘或其它下载渠道。

1. 从 Release 下载 `HWMusic_<版本>_x64-setup.exe` 与 `SHA256SUMS`。文件名用英文，是因为 GitHub 会删掉资产名里的中文；安装后的应用名仍是「华为音乐第三方客户端」。
2. 核对哈希：`certutil -hashfile HWMusic_<版本>_x64-setup.exe SHA256`，结果应与 `SHA256SUMS` 里那一行一致。
3. 运行安装包。SmartScreen 拦下时点「更多信息」→「仍要运行」。机器上没有 WebView2 运行时的话，安装程序会联网下载安装。

只在 Windows x64 上构建和验证过；Linux 与 macOS 没有构建过，本项目不宣称支持。

---

## 功能

**登录**

- 未登录时启动即显示扫码引导页：二维码下方显示剩余有效时间，过期后遮住二维码，点击刷新。
- 也可以在应用内打开华为官方网页登录。
- 登录态用 Windows DPAPI 加密保存在本机，重启后保持登录；音乐会话约 7 天到期，到期后回到扫码页并说明原因。
- 左下角账号区显示头像、名称与会员信息（取得到时才显示），悬停名称显示登录剩余时间；退出登录也在这里。

**音乐库与播放**

- 收藏、我的歌单（左侧栏，带封面、名称与曲目数）、搜索、专辑、歌手、播放历史、本地歌曲（导入时自动识别同名歌词）。
- 歌单可整表播放或加入队列；列表触底加载更多。
- 播放队列、播放模式、音量；启动时恢复上次播放的歌曲与进度（暂停状态）。
- 应用内右键菜单（屏蔽网页默认菜单）。

**歌词**

- 歌词用 AMLL 官方组件渲染，支持逐字高亮与翻译行；只有整句时间的歌词，逐字扫亮按演唱速度设了上限。
- 沉浸式歌词页：左侧封面、右侧歌词，背景取自封面。Windows 上进入时收起系统标题栏、铺满整个窗口，页面自带拖动区与最小化、最大化、关闭按钮。
- 歌词来源依次为：本地导入 → 本地缓存（90 天，设置里可查看占用、一键清除）→ 华为音乐 → 第三方回退（酷狗音乐、LRCLIB）。
- 可导入本地 `.lrc` / `.txt`，自动识别 UTF-8、UTF-16 与 GBK 编码；本地导入优先于任何在线结果。

**桌面歌词与任务栏歌词**

- 桌面歌词：横版与竖排两种布局，置顶、透明、可拖动与缩放；锁定后鼠标穿透，悬停只显示解锁键；字号、颜色、逐字高亮等样式在气泡面板里设置；控件行有播放/暂停、上一首、下一首与关闭。
- 任务栏歌词（Beta，仅 Windows）：嵌在任务栏的安全空白区，颜色、字号与逐字高亮单独设置；权限不符、占用未知或任务栏自动隐藏时停止显示并说明原因。

**系统集成**

- 托盘菜单：显示窗口、桌面歌词开关、播放/暂停、上一首、下一首、设置、退出；关闭主窗口可选择退出应用或最小化到托盘。
- 全局快捷键：媒体键三键、`Ctrl+Alt+L`（桌面歌词）、`Ctrl+Alt+S`（设置）；组合键被占用时自动改用备用组合并提示。
- 单实例运行、窗口位置与大小记忆、开机自启、浅色 / 深色 / 跟随系统三种主题。
- 设置页：HTTP 代理（主机、端口、用户名密码、例外列表、测试连接）；运行日志用编辑器样式展示，可按级别和关键字筛选。

**明确不做**：每日推荐、移动端、云同步、自动更新服务、其它平台音源、绕过付费或 DRM、「加入已有歌单」（没有官方追加接口的证据）。

---

## 从源码运行

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.18.0** | `package.json` 的 `engines` 硬约束；22.18 起默认开启 type stripping，更早的版本跑 `npm test` 会失败 |
| Rust | stable，目标 `x86_64-pc-windows-msvc` | 用 `rustup` 安装 |
| MSVC Build Tools | 含 `VC.Tools.x86.x64` | Windows 上 `cargo` 的链接器 |
| WebView2 Runtime | Windows 10/11 通常已随 Edge 安装 | 安装包会按需引导下载 |

```powershell
npm ci
npm run dev        # tauri dev：起 vite（http://localhost:1420）+ 编译 Rust + 开窗
npm run dev:web    # 只起渲染层（没有宿主能力，适合改界面）
```

- `npm run dev` **不会**重建 sidecar：改了 `src/main/**`、`src/host/**`、`src/sidecar/**` 或 `src/protocols/**` 之后，先 `npm run dist:sidecar`，再把产物复制到 `src-tauri\target\debug\hwmusic-core.exe`，否则跑的是上一次的 sidecar。细节与两个排障旋钮见 [docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md)。
- 默认数据目录不可写时，用环境变量指定一个可写的绝对路径：`$env:HWMUSIC_DATA_DIR = "E:\hwmusic-data"`。

---

## 构建安装包

顺序是硬要求：先构建渲染层，再打包 sidecar，最后 `tauri build`。`npm run dist:win` 把三步串起来，并在打包之后做 mtime 新鲜度检查：任何被打包进去的输入比主程序新，就非 0 退出并点名那个产物。

| 命令 | 做什么 |
|---|---|
| `npm run build:web` | `vite build` → `out/renderer`（主窗、桌面歌词窗、歌词设置弹出窗、登录浮动控件四个入口） |
| `npm run dist:sidecar` | esbuild → Node SEA + postject → `src-tauri/binaries/hwmusic-core-<triple>.exe` |
| `npm run dist:win` | 上面两步 + `tauri build`（NSIS）+ mtime 新鲜度检查，产物在 `src-tauri/target/release/bundle/nsis/` |
| `npm run check:nsis` | 对安装包与暂存目录做静态校验（不执行安装包） |
| `npm run release:checksums` | 写 `SHA256SUMS` |
| `npm run release:assets` | 把安装包复制成英文文件名 `HWMusic_<版本>_x64-setup.exe`，连同只含它的 `SHA256SUMS` 放进 `bundle/release-assets/`；Release 上传的就是这两个文件 |

`tauri.conf.json` 的 `beforeBuildCommand` 有意留空，原因、mtime 检查的口径与 CI 的规矩见 [docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md)。

**CI**（`.github/workflows/windows-nsis.yml`，windows-latest）：依赖安装 → 取参考实现（固定提交）→ 单元测试 → 类型检查 → 验收六路径 → 浏览器守卫 → Rust 测试 → 打包 → 安装包静态校验 → 校验和 → 发布用资产（英文文件名）。推 `main` 只保留构建产物；推 `v*` 标签额外创建 GitHub Release，附英文文件名的安装包与 `SHA256SUMS`，发布说明写明未签名、非官方、OAuth 身份不属于本项目，并给出对应提交的完整源码地址。

---

## 测试

| 命令 | 验什么 | 口径 |
|---|---|---|
| `npm test` | Node 侧功能与契约测试 | fail 0 / skipped 0（跳过的测试不算验过） |
| `npm run typecheck` | `tsc --noEmit` | 退出码 0 |
| `npm run test:acceptance` | 六条关键路径（登录门禁、代理、托盘、桌面歌词、任务栏歌词降级与无注入、设置持久化） | PASS 6 / SKIP 0 / FAIL 0 |
| `npm run test:browser` | 界面在真 Chromium 里的 DOM 与像素断言 | PASS N / SKIP 0 / FAIL 0；没有 Chromium 判 FAIL，不静默跳过 |
| `cd src-tauri; cargo test` | Rust 单元与集成测试 | 0 failed（1 条 DPAPI 端到端用例默认 ignored） |

`test/reference-parity.test.mjs` 的 6 条差分测试逐字比对参考实现的源码：本机没有 `.tmp/reference-repo/` 时按缺席跳过，`npm test` 会报 skipped 6（不算验过）。要跑全，把 https://github.com/talongao/huawei-music-desktop 克隆到 `.tmp/reference-repo/`，再检出 [docs/API_CONTRACT.md](docs/API_CONTRACT.md) 记录的固定提交；CI 每次都这样取。

浏览器守卫用的是合成账号与夹具数据，不能当作个人账号的验证证据。当前基线数字见 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

---

## 项目结构

| 目录 | 职责 |
|---|---|
| `src/renderer/` | 渲染层（React + shadcn/ui + AMLL）。只经 `host-api.ts` 的白名单封装调用宿主，拿不到任何凭据 |
| `src/sidecar/` | sidecar 入口（打包为 Node SEA：`hwmusic-core`） |
| `src/main/` | sidecar 业务：登录与会话、音乐接口、歌词、设置、代理 |
| `src/host/` | sidecar 与宿主之间的帧协议与频道分发 |
| `src/protocols/` | 协议层：OAuth、二维码登录、播放地址白名单等 |
| `src/shared/` | 命令名、频道名与常量的唯一真源（Rust 侧是镜像副本，由 parity 测试互钉） |
| `src-tauri/` | Rust 外壳：窗口、托盘、桌面歌词窗、任务栏歌词、登录子窗、DPAPI、代理装配 |
| `test/` | Node 测试（`node --test`） |
| `scripts/` | 构建、打包、验收、浏览器守卫与只读探针脚本 |
| `docs/` | 接口契约、实现状态、已知限制、平台差异、打包说明 |
| `build/` | 应用与托盘图标（由 `scripts/make-icon.mjs` 从 Lucide 生成） |

---

## 架构与安全边界

```
┌─ 渲染层（WebView2 / React）─────────── 无凭据、不对外发请求、CSP 收紧
│    host-api.ts（白名单方法）
└──────────────┬──────────────────────────────────────────────
               │ Tauri IPC（core_call 与具名 core_* 命令，按 webview label 守卫）
┌──────────────▼─ Rust 外壳（src-tauri）── 窗口、托盘、歌词窗、登录子窗、DPAPI、代理装配
└──────────────┬──────────────────────────────────────────────
               │ NDJSON 帧（stdin / stdout；日志走 stderr）
┌──────────────▼─ sidecar hwmusic-core（Node SEA）── 设置、代理、OAuth、业务 HTTP
└─────────────────────────────────────────────────────────────
```

1. **凭据只在 sidecar 与 Rust**：渲染层拿不到 Token，业务 HTTP 只在 sidecar 里发；凭据只活在 sidecar 内存与 DPAPI 信封里。
2. **登录页零权限、零注入**：官方登录页在独立子 webview 里（独立数据目录，不进任何 capability），不给官方页注入脚本，白名单与回调只靠导航事件观测。
3. **不放宽安全开关**：CSP 的 `connect-src` 只有 `'self' ipc: http://ipc.localhost`，`object-src`、`base-uri`、`frame-ancestors` 均为 `'none'`；不关 webSecurity，不放宽 TLS 校验，不注册全局 `hms://` 协议，不改系统代理。
4. **不注入、不 Hook**：不注入 DLL、不装全局 Hook、不改 Explorer 按钮；任务栏歌词只对本应用自己的窗口调用 `SetParent`，对其它窗口只读。全源码扫描禁用系统钩子与注入类 API，例外钉死到文件与符号。

---

## 数据与隐私

| 落点 | 内容 | 保护 |
|---|---|---|
| 数据目录 | 默认 `%APPDATA%\org.hwmusicdesktop.unofficial.internal`；可用 `HWMUSIC_DATA_DIR` 覆盖 | 只按「旋钮 → 应用数据目录 → 应用缓存目录」解析，绝不回退当前目录 |
| `session.enc` | 音乐会话（唯一落盘的凭据） | Windows DPAPI 加密信封，换用户或换机器解不开；临时文件 + rename 原子写 |
| `settings.json` | 设置，**含代理密码明文** | 0600 尽力而为 + 用户目录 ACL；认不出的文件绝不覆盖 |
| `lyrics-cache/`、`lyrics-local/` | 在线歌词缓存（90 天）与本地导入的歌词 | 设置页可查看占用、一键清除 |
| `webview2/` | 各窗口独立的 WebView2 数据目录 | 主窗与登录子窗不共用 |
| 运行日志 | 设置页可查看；Info 级，单文件 4MB | 不记播放地址、登录 URL 与代理凭据；界面只显示必要提示，调试信息只进日志 |

- **第三方歌词回退**：华为音乐取不到歌词时，会把歌名、歌手与时长发给酷狗音乐与 LRCLIB 检索歌词，不带任何本项目的凭据、账号标识或会话。
- **只读探针**（`scripts/probe-*.mjs`）：只访问公开资源，不登录任何账号、不读取私人凭据。
- 真实账号凭据与音乐库数据（`.local/`）、本地研究材料（`research/`）不提交、不打包；`check:nsis` 有一条专门校验安装包里不含它们。

---

## 已知限制（摘要）

完整清单逐条列在 [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)。最要紧的几条：

1. **只在 Windows 上构建与验证过**。Linux 与 macOS 没有构建过，本项目不宣称支持。
2. **安装包未签名**；`check:nsis` 只做静态校验，没有在干净机器上做过安装与卸载测试。
3. **华为音乐没有公开接口文档**：登录与业务接口对齐的是非官方参考实现与实测结果，官方调整随时可能让它失效。
4. **任务栏歌词是 Beta**：只在单屏 1920×1080、100% 缩放上真机验证过，多屏、高 DPI、任务栏自动隐藏没有验证。
5. **不少界面改动只在代码级与无头浏览器里验证过**，真实窗口里的观感仍需人工确认，例如沉浸页收起标题栏后的边缘缩放与 Snap 布局。
6. **会话到期**：启动时已到期会回到扫码页并说明原因（真机验证过）；运行中到期时，要等下一次业务请求才回到扫码页，没有后台定时检查。服务端若在到期之前提前作废会话，客户端无法察觉。

---

## 参考项目与致谢

本项目参考、改编或直接使用了下列项目。参考关系如实列出；第三方组件的许可证与归属见 [NOTICE](NOTICE)。

**参考实现与设计参考**

| 项目 | 地址 | 本项目参考了什么 |
|---|---|---|
| talongao/huawei-music-desktop | https://github.com/talongao/huawei-music-desktop | 华为音乐第三方客户端（学习版）。本项目的登录链路（OAuth 授权与 token 端点、`loginex` 换取音乐会话）、业务接口的请求与响应形状、播放地址的 CDN 白名单，都对齐这个参考实现的实测值，见 [docs/API_CONTRACT.md](docs/API_CONTRACT.md) |
| ANYNC/TaskbarLyrics | https://github.com/ANYNC/TaskbarLyrics | Windows 任务栏歌词：自窗附着、UIA 占用快照与安全空白布局改编自其固定提交 `bd746ff87a2d4d20543a7e91654ef09675a93c5b`（MIT，许可证全文见 NOTICE）；不包含其修改 Explorer 任务列表尺寸的算法 |
| Mai-icy/Spotify-lyrics-window | https://github.com/Mai-icy/Spotify-lyrics-window | 桌面歌词窗的设计参考：横版与竖排显示、样式自定义、悬浮窗交互 |
| Apple Music-like Lyrics（AMLL） | https://github.com/amll-dev/applemusic-like-lyrics ，文档 https://amll.dev/guides | 歌词播放器、沉浸页布局、封面与背景渲染直接使用其官方组件（AGPL-3.0-only） |
| shadcn/ui | https://ui.shadcn.com ，https://github.com/shadcn-ui/ui | 全部界面组件来源（生成在 `src/renderer/components/ui/`） |

**运行时会访问的第三方服务**

| 服务 | 地址 | 用途 |
|---|---|---|
| 酷狗音乐 | https://www.kugou.com | 华为音乐取不到歌词时的回退来源之一 |
| LRCLIB | https://lrclib.net | 华为音乐取不到歌词时的回退来源之一 |

**主要依赖**

| 依赖 | 地址 | 用途 |
|---|---|---|
| Tauri 2 | https://tauri.app ，https://github.com/tauri-apps/tauri | 桌面外壳与官方插件（single-instance、window-state、global-shortcut、notification、autostart、log） |
| React | https://react.dev | 渲染层 |
| Vite | https://vite.dev | 渲染层构建 |
| TypeScript | https://www.typescriptlang.org | 类型检查 |
| Tailwind CSS | https://tailwindcss.com | 样式工具类与设计令牌 |
| Radix UI | https://www.radix-ui.com | shadcn/ui 的无障碍原语 |
| Lucide | https://lucide.dev | 图标；应用与托盘图标由 `scripts/make-icon.mjs` 从 Lucide 生成（归属见 `build/icon.LICENSE.txt`） |
| sonner | https://github.com/emilkowalski/sonner | 提示条（shadcn/ui 的 Toaster） |
| next-themes | https://github.com/pacocoursey/next-themes | 提示条跟随主题 |
| node-qrcode | https://github.com/soldair/node-qrcode | 登录二维码渲染（本项目不手写二维码编码） |
| PixiJS | https://pixijs.com | AMLL 背景渲染 |
| Motion | https://motion.dev | AMLL 布局动效，尊重系统的「减少动态效果」设置 |
| Jotai | https://jotai.org | AMLL 的状态库 |
| undici | https://undici.nodejs.org | sidecar 的 HTTP 客户端与代理 |
| Node.js 单文件可执行程序（SEA） | https://nodejs.org/api/single-executable-applications.html | sidecar 打包 |
| NSIS | https://nsis.sourceforge.io | Windows 安装包 |
| Microsoft Edge WebView2 | https://developer.microsoft.com/microsoft-edge/webview2/ | Windows 上的 webview 运行时 |

---

## OAuth 身份声明（必须读）

登录链路使用 `client_id = 101444301`、`redirect_uri = hms://redirect_uri`、`access_type = offline`，授权码 + PKCE（S256）；scope 清单见 [docs/API_CONTRACT.md](docs/API_CONTRACT.md) §1.1。

- 这个身份**不是本项目注册的**，沿用自参考实现，极可能是华为音乐官方 App 的 OAuth 身份；
- 本项目**不持有**该身份的任何凭据，也**没有被授权使用它**；
- 该身份**随时可能失效**（官方改配置、下线端点或换主机都会让它失效）；
- 本项目**不做**「修身份式重试」：不伪造、不轮换、不猜测其它 client id；
- 能扫码登录成功，只说明这个身份目前被受理，**不等于**本项目获得了使用授权。

---

## 免责声明

1. **非官方**：本项目是第三方独立实现，与华为及其关联公司没有任何隶属、合作或代理关系，不是官方发布物；华为音乐、华为帐号等一切官方权利归官方所有。
2. **未签名**：安装包没有代码签名证书，SmartScreen 会提示「未知发布者」。这不是被篡改的证据，但也没有任何东西替你担保这个文件，请用同一 Release 里的 `SHA256SUMS` 自己核对。
3. **OAuth 身份不属于本项目**：见上一节。登录凭据只落本机（DPAPI 保护的会话信封），不进发布物，不进 CI。
4. **按现状提供（AS IS）**：本项目不提供任何担保。因使用本项目产生的账号风险、数据风险或其它后果由使用者自行承担；请自行确认你的使用方式符合当地法律与官方条款。

---

## 许可

- 本项目源代码以 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）** 授权，全文见 [LICENSE](LICENSE)。完整源码在 https://github.com/Solathis/HWMusic ，每个 Release 的发布说明都给出它对应提交的源码地址。
- 第三方组件的归属与各自许可证见 [NOTICE](NOTICE)；图标归属见 `build/icon.LICENSE.txt`。
- AMLL（`@applemusic-like-lyrics/*`）同样是 AGPL-3.0-only。以二进制形式分发本项目时，须一并保留 `NOTICE` 与相应许可证文本。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | 每项能力的档位（verified / untested 等）、证据与当前测试基线 |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | 全部未验证项与已知限制，逐条列出 |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | 接口事实与协议的唯一真源：OAuth、业务端点、频道与命令契约、常量、红线 |
| [docs/PLATFORM_DIFFERENCES.md](docs/PLATFORM_DIFFERENCES.md) | Windows / Linux / macOS 的能力差异与 capability 权限清单 |
| [docs/RUN_AND_PACKAGING.md](docs/RUN_AND_PACKAGING.md) | 打包链为什么这么排、`smoke:build` 的三种结论、CI 规矩 |
| [docs/superpowers/plans/2026-10-18-full-rebuild-from-zero.md](docs/superpowers/plans/2026-10-18-full-rebuild-from-zero.md) | 本次从零重建的实施计划（过程文档） |
