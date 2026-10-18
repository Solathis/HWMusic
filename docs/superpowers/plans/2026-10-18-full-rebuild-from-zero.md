# 华为云音乐桌面端 · 从零重建实施计划（Full Rebuild from Zero）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已清空的 `E:\Projects\华为云音乐桌面端`（旧仓库含 git 记录已按用户指令全部删除）从零重建 Tauri v2 + React + shadcn/ui + AMLL 的华为音乐第三方桌面客户端，满足原任务书全部验收标准。

**Architecture:** Rust 外壳（Tauri v2：窗口/托盘/登录子窗/歌词窗/5 官方插件/DPAPI 安全存储）+ Node sidecar（Node SEA 单文件二进制，OAuth/PKCE、华为业务 HTTP、undici 代理、NDJSON stdio 桥）+ React 渲染层（Tailwind v4 + shadcn/ui + AMLL，无对外网络权限，白名单 IPC）。

**Tech Stack:** Tauri 2.12.x、Rust（tauri + windows crate DPAPI）、Node ≥22.15（SEA 打包 sidecar）、React 19、Vite 7、TypeScript、Tailwind CSS v4、shadcn/ui（radix-ui 单包 + cn 包）、@applemusic-like-lyrics/{core,lyric,react} 0.6/1.1、undici、sonner、lucide-react。

**Spec:** 原用户任务书（迁移/清理/重写/角色分工/验收标准全文，见交付文档 Task R15 归档副本）。

## Global Constraints（原 AGENTS.md + 任务书硬边界，AGENTS.md 已删，本节即真源）

1. **凭据与业务 HTTP 只在 sidecar/Rust**；渲染层只能调用 `window.desktop` 白名单方法，拿不到任何 Token。渲染层无对外 fetch 通道。
2. **官方登录页无应用权限**：独立子 webview（无边框、不进任务栏、独立数据目录、不与主窗共享会话），导航白名单放行，回调只拦 `hms://`，取消只走 `auth:cancel-login`；顶部取消条高度与 `LOGIN_VIEW_TOP_INSET` 必须一致（单一常量真源，双侧导入）。
3. **不关闭 webSecurity / 不放宽 TLS 校验 / 不注册全局 hms:// 协议 / 不修改系统代理**。CSP `connect-src` 只有 `'self' ipc: http://ipc.localhost`。
4. **不注入、不 Hook 系统进程**：托盘用 Tauri `tray-icon`；任务栏歌词只用"独立透明窗 + work_area 贴边"降级（三端无公开文字 API），绝不 explorer 注入 / shell 扩展 / SetWindowsHookEx。
5. **UI 只用 shadcn/ui 与 AMLL 官方组件 + Tailwind 工具类 + 设计令牌**；禁止自写视觉组件、手写自定义 CSS、仿写。缺失能力靠组合原语/主题变量/成熟库。
6. 动效只用 tw-animate-css、shadcn/Radix 状态动画、Tailwind transition 工具、AMLL 官方动效；尊重 `prefers-reduced-motion`；禁止无意义动画。
7. 界面提示克制：仅必要状态反馈与可操作错误提示；调试信息/请求细节/堆栈进日志（`tauri-plugin-log`），不进 UI，不暴露敏感信息。
8. **最小权限 capabilities**：只给 main/lyrics 两窗口 event + 拖动 + 快捷键注册；不开 fs/shell/http/dialog/store。
9. Tauri 官方插件限定：single-instance、window-state、global-shortcut、notification、autostart、log。不加 updater/store/fs/dialog/http。
10. `.local/`（如再出现，真实账号凭据/音乐库数据）禁止打印/上传/提交/打包；真实个人账号联网验证需当前用户明确授权；写操作测试只用临时对象并读回确认清理。
11. 二进制只通过 GitHub Release 发布（未签名测试构建），发布说明必须写明未签名、非官方、OAuth 身份不属于本项目；不另开分发渠道。
12. 许可：AGPL-3.0-only（`LICENSE`）+ `NOTICE` 第三方归属；AMLL 为 AGPL-3.0-only，图标用 Lucide（ISC）需保留 `build/icon.LICENSE.txt` 归属。
13. 显示名统一走共享常量（如 `src/shared/app-name.mjs`）；不改 `package.json` 的 `name`。
14. Windows/Linux 无菜单栏，macOS 仅最小角色；`data_directory` 必须显式（WebView2 默认 %LOCALAPPDATA% 可能不可写），数据根两级回退 data→cache，绝不回退 cwd。
15. 每个功能一个独立 git 提交（Conventional Commmits 中文消息）；提交前 diff 检查不得含密钥/构建产物/缓存/临时文件。
16. **构建顺序硬要求**：`build:web` → `dist:sidecar` → `tauri build`；`beforeBuildCommand` 保持空串时必须由 dist 脚本统一编排并做 mtime 新鲜度检查。
17. 不用 `npx`（本机 PowerShell SecurityError）；编译器直接指文件路径执行。本机若 spawn 受限，`node --test` 需逐文件跑。
18. 不重选 Tauri/Go 之外的容器；不做每日推荐/移动端/云同步/自动更新服务/其它平台音源/音频解密/绕过任何付费或 DRM。

## 审计存留的协议与工程事实（旧仓已删，本节是唯一幸存知识源，不得丢弃）

- **OAuth**：`client_id = 101444301`（非本项目身份，极可能是华为音乐官方 App 的 OAuth 身份，随时可能失效——发布物必须声明）；`redirect_uri = hms://redirect_uri`；`scope = openid`；`access_type = offline`；PKCE S256（code_challenge + state，state 常量时间比较、一次性消费、10 分钟过期）。
- **登录域名白名单**（Rust `on_navigation` 与 Node 侧双份必须同步）：华为官方登录域 + 区域 OAuth 服务精确例外 `https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback`。**历史故障根因**：漏掉该例外导致扫码成功后停在 CAS 页、`hms://` 永不触发。官方换区域主机（如 oauth-login2）会复发同类故障。
- **令牌链**：授权码兑换（token endpoint，带 code_verifier）→ 音乐会话兑换（loginex 接口，请求带 Digest 头）。账号 AT≈1 小时；音乐会话是另一种凭据（到期字段提示约 7 天，未实测完整周期；自动续期未打通，失效需重扫）。账号 AT/RT 不落地，只保存最小音乐会话。
- **CDN 域**（CSP img/media 用）：`https://*.dbankcdn.cn`、`https://*.tingmall.com`、`https://*.kuke.com`。
- **业务语义陷阱**：playback 顶层 `fileURL` 是音频、`fileInfos` 可能是 JSON；`auditionTime` 不能单独判 30 秒试听；收藏无直接总数字段（总数=完整分页后 ID 去重，与"已加载 N 首"分开）；自建歌单删除必须 `playlist/delete`，不能用 `favorite/delete` 成功码冒充。
- **接口端点**：具体 URL 已随 `docs/API_CONTRACT.md` 删除，**需在 Task R4 由用户授权的 probe 实验重新确定**（方法见该任务）。域名已知：登录/CAS 在 huawei.com 系，业务接口与 CDN 见上。
- **代理**：单一真源 `settings.json`（`{schemaVersion:1,data:{proxy}}`）；sidecar 全局 undici `ProxyAgent`（支持凭据）；webview 侧 `proxy_url`（只 `http://host:port`，凭据必须丢弃并记日志，Chromium `--proxy-server` 不吃内联凭据）；**三个窗口（登录窗/主窗/歌词窗）都必须接 proxy_url**，否则封面图与 `<audio>` 音频流绕过设置代理直连。环境变量兜底 HTTP(S)_PROXY/ALL_PROXY/NO_PROXY 且要有可见提示。
- **DPAPI**（Windows）：`CryptProtectData`（windows crate features 仅 `Win32_Foundation`、`Win32_Security_Cryptography`、`Win32_System_Memory`，且必须 `[target.'cfg(windows)'.dependencies]`）；`session.enc` 0600 + 临时文件 + rename 原子写；不可用时保内存会话并明确提示，不静默降级明文。macOS/Linux 无后端时如实标记 pending。
- **Rust 插件注册**（`tauri = "2.12.4"`，features：`tray-icon`、`image-png`、`image-ico`；macOS 目标加 `macos-proxy` 且仅 14+ 生效）：single-instance（第二实例聚焦主窗）→ window-state（`StateFlags = SIZE|POSITION|MAXIMIZED`，`with_filter` 只记 main/lyrics；插件不读 conf 的 plugins 段）→ global-shortcut（setup 里逐条注册，失败如实上报 + 备选链回退）→ notification → autostart（`MacosLauncher::LaunchAgent`）→ log（Info、KeepOne、4MB）。
- **窗口/托盘**：托盘 9 槽位/7 项/2 分隔线（显示窗口/播放暂停/上一首/下一首/桌面歌词 CheckMenuItem/设置/退出），id 前缀 `tray:`；图标 `include_bytes!` 嵌二进制（Windows 用多尺寸 ico，非 Windows 32x32 png，macOS `icon_as_template(true)`）；Linux 需 `libayatana-appindicator3` 且 `TrayIconEvent` 不派发（只能菜单）。关窗 fail-safe：`closeBehavior: tray` **且**托盘真的装上才 PreventAndHide，否则真退出。
- **歌词窗**：label `lyrics`，无边框/透明/无阴影/置顶/不进任务栏/建后按配置再 show；拖动=`data-tauri-drag-region`（锁定=不挂）；点透=`set_ignore_cursor_events`；多显示器=优先主窗 `current_monitor()` 退主屏；任务栏模式贴 `work_area` 下沿（如 1200×44、字号≤20）。
- **sidecar 打包**：esbuild 内联打包（undici 打进去，只 `node:*` external）→ SEA（postject 注入 node.exe 副本，SHA 必须异于 node.exe）→ externalBin `binaries/hwmusic-core`（Tauri 复制时剥三元组后缀）。bridge：NDJSON 帧 + request id + pending 表；宿主要求（host:open-login / host:secure-encrypt / host:secure-decrypt / host:notify）走同一桥。
- **前端依赖版本**（与旧仓一致，避免重新踩版本坑）：react/react-dom 19.3、vite 7.3、@vitejs/plugin-react 5.1、tailwindcss + @tailwindcss/vite 4.3、tw-animate-css 1.4、typescript 7.0、shadcn 4.22、radix-ui 1.8、cn 0.5、cva 0.7、lucide-react 0.468、sonner 2.0、AMLL core 0.6/react 0.6/lyric 1.1 + @pixi 7.4.3 系列、undici 7.30、@tauri-apps/api 2.12、@tauri-apps/cli 2.12.3。
- **本机环境**：Git Bash（经 scoop）；不用 npx；%APPDATA% 可能不可写（用 `HWMUSIC_DATA_DIR` 覆盖旋钮排障）；spawn 受限会话里 `node --test` 要逐文件跑。工具链已随旧仓删除，Task R0 重装。
- **旧仓工程质量结论**（避免重蹈覆辙）：emit 启动期提示必须排队到渲染层就绪后冲刷（直接 emit 发进空气）；退出必须显式收尸 sidecar（tao 的 run 在 Windows 不 drop App）；同步命令里 `WebviewWindowBuilder::build()` 死锁（建窗全 async 命令 + `require_main_window` 守卫）；双端 10 分钟登录超时字面量必须互相钉住；`beforeBuildCommand=""` 时绕过 dist 脚本直接 tauri build 会嵌旧界面且退出码 0（需 mtime 检查）。

## 目标文件结构

```
├── .git/  .gitignore  .github/workflows/windows-nsis.yml
├── LICENSE  NOTICE  README.md  components.json
├── package.json  tsconfig.json  vite.config.ts
├── build/icon.LICENSE.txt  build/icon.png  build/tray.png
├── docs/
│   ├── superpowers/plans/2026-10-18-full-rebuild-from-zero.md   (本计划)
│   ├── API_CONTRACT.md  PLATFORM_DIFFERENCES.md  KNOWN_LIMITATIONS.md
│   └── RUN_AND_PACKAGING.md
├── scripts/  (make-icon.mjs、build-sidecar.mjs、dist-win.mjs、check-nsis-package.mjs、release-checksums.mjs、probe-login.mjs、probe-music.mjs)
├── src/
│   ├── shared/   (app-name、channels、request-channels、types、result、login-inset)
│   ├── host/     (NDJSON 帧、RPC、dispatcher、host-services)
│   ├── sidecar/  (main.mjs 入口编排)
│   ├── main/     (auth-manager、huawei 业务、proxy、settings、json-store、写操作)
│   ├── renderer/ (index.html/lyrics.html、main.tsx/lyrics-main.tsx、App、login-gate、pages、
│   │             components(TrackTable/PlayerBar/QueuePanel)、components/ui/ (shadcn)、
│   │             features/{auth,library,lyrics,playback}、styles.css、amll-theme.css)
│   └── protocols/(auth.mjs、music.mjs、lyrics.mjs、login-callback.mjs、safe-media-url.mjs —— 可独立 node 测试)
└── src-tauri/
    ├── Cargo.toml  tauri.conf.json  capabilities/main.json  icons/  binaries/
    └── src/ (lib.rs、login.rs、tray.rs、lyrics_window.rs、b5_proxy.rs→webview_proxy.rs、
             shortcuts.rs、commands.rs、sidecar.rs、secure_store.rs、close_behavior.rs)
```

## 任务总览与提交粒度

| # | 任务 | 提交信息（pi） |
|---|---|---|
| R0 | 工具链、空仓、许可证 | `chore: 初始化仓库与许可证` |
| R1 | 前端骨架（Vite+React+Tailwind v4+shadcn+AMLL） | `feat(ui): 前端骨架与设计令牌` |
| R2 | Tauri 骨架（外壳、窗口策略、CSP、capabilities） | `feat(shell): Tauri v2 外壳与最小权限` |
| R3 | sidecar 桥（NDJSON、命令白名单、宿主要求） | `feat(bridge): sidecar NDJSON 桥与白名单` |
| R4 | 协议原型层（OAuth/PKCE、业务接口探针） | `feat(auth): OAuth PKCE 协议原型` |
| R5 | DPAPI 安全存储与会话持久化 | `feat(auth): DPAPI 安全存储` |
| R6 | 设置与统一代理 | `feat(settings): 统一设置与 HTTP 代理` |
| R7 | 登录链路（子窗、门禁引导页） | `feat(auth): 引导页与扫码登录` |
| R8 | 主界面 UI（外壳、页面、表格、播放栏） | `feat(ui): 主界面与页面` |
| R9 | 播放器与 AMLL 歌词 | `feat(player): 播放器与歌词面板` |
| R10 | 设置页（代理表单、关窗行为、自启） | `feat(settings): 设置页` |
| R11 | 托盘与关窗 fail-safe | `feat(tray): 托盘与关窗行为` |
| R12 | 桌面歌词窗与任务栏降级 | `feat(lyrics): 桌面歌词与任务栏降级` |
| R13 | 系统集成（单实例/状态/快捷键/通知/自启/日志） | `feat(system): 系统集成` |
| R14 | 打包、验收脚本与 CI | `build: NSIS 打包链与 CI` |
| R15 | 交付文档与状态记录 | `docs: 交付文档` |

角色分工（沿用任务书）：kimicode=计划/审查，deepseekharness=执行+自测，pi=git。pi 已无历史可保护（旧 .git 已删）：R0 起全新 `git init`，main 即主线；每任务审查通过后一次独立提交。

---

### Task R0：工具链、空仓、许可证

**Files:** Create `.gitignore`、`LICENSE`、`NOTICE`、`docs/superpowers/plans/`（本计划迁入）。

**Interfaces:** Produces: 可用的 node/npm/rust/cargo/git 环境；空 git 仓库；AGPL 许可证对。

- [ ] **Step 1** 安装工具链（scoop 路径，本机无系统级 Rust）：
  ```sh
  node --version          # 必须 ≥ v22.15.0；不足则 scoop install nodejs-lts
  scoop install rustup    # 或 scoop install rust；rustc --version 与 cargo --version 必须可用
  git --version
  ```
- [ ] **Step 2** `git init`（默认分支 main），写入 `.gitignore`：`node_modules/`、`out/`、`dist/`、`src-tauri/target/`、`src-tauri/binaries/`、`.tmp/`、`.local/`、`research/`、`.idea/`、`.probe/`、`.DS_Store`、`*.log`。
- [ ] **Step 3** 放入 `LICENSE`（AGPL-3.0 全文）与 `NOTICE`（版权行 + Tauri/MIT、React/MIT、Tailwind/MIT、shadcn/MIT、AMLL/AGPL-3.0-only、Lucide/ISC、undici/MIT 归属）。
- [ ] **Step 4** 自测：`git status` 干净地只显示四个新文件；`cargo --version` 可用。
- [ ] **Step 5** pi 提交：`chore: 初始化仓库与许可证`

### Task R1：前端骨架

**Files:** Create `package.json`、`tsconfig.json`、`vite.config.ts`、`components.json`、`src/renderer/{index.html,lyrics.html,main.tsx,lyrics-main.tsx,styles.css,amll-theme.css}`、`src/renderer/components/ui/*`（shadcn 生成）、`src/renderer/lib/utils.ts`、`src/shared/app-name.mjs`。

**Interfaces:** Produces: `cn()`（`export { cn } from "cn"`）；`APP_BRAND_LABEL`；双入口构建；`styles.css` 含 `:root/.dark` oklch 令牌（含 sidebar 全套）+ `@theme inline` 映射 + `@layer base` 两行；`amll-theme.css` 只做 AMLL 三个变量接线（`--amll-lp-color/font-size/hover-bg-color`），CSS 引入顺序契约 `core/style.css → amll-theme.css → styles.css`。

- [ ] **Step 1** 依赖安装（版本锁定见"审计存留事实"清单）：`npm i react@19.3.0 react-dom@19.3.0 @tauri-apps/api@2.12.4` + AMLL 四包 + pixi 系列 + radix-ui + cn + cva + lucide-react + sonner + undici；dev 侧 vite/plugin-react/tailwind/@tailwindcss/vite/tw-animate-css/typescript/shadcn/@tauri-apps/cli。
- [ ] **Step 2** `vite.config.ts`：双入口显式声明（`index.html` + `lyrics.html`），`outDir: 'out/renderer'`，`@` 别名指 `src/renderer`。
- [ ] **Step 3** shadcn 初始化：`node node_modules/shadcn/dist/index.js init`（**不经 npx**），生成 button/card/input/label/select/switch/slider/table/tabs/dialog/dropdown-menu/scroll-area/sheet/sidebar/skeleton/sonner/tooltip/alert/badge/separator。
- [ ] **Step 4** 自测：`node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/vite/bin/vite.js build` 双双退出码 0；产物含 index 与 lyrics 两入口。
- [ ] **Step 5** pi 提交：`feat(ui): 前端骨架与设计令牌`

### Task R2：Tauri 骨架

**Files:** Create `src-tauri/{Cargo.toml,tauri.conf.json,build.rs,capabilities/main.json,icons/,src/lib.rs}`。

**Interfaces:** Produces: `run()`（插件链 + setup 编排）；`MAIN_WINDOW_LABEL="main"`；`webview_data_root()`（data→cache 两级回退，绝不 cwd，`HWMUSIC_DATA_DIR` 覆盖旋钮）；`create_main_window`（1280×800/min 960×640/显式 data_directory）；CSP 与 capabilities 见 Constraints 3/8。

- [ ] **Step 1** `Cargo.toml` 按审计事实写：tauri 2.12.4 三 feature + 6 插件 + serde/serde_json/log/base64；windows crate 仅 `cfg(windows)` 三模块；macOS 目标 `macos-proxy`。
- [ ] **Step 2** `tauri.conf.json`：`frontendDist: "../out/renderer"`、`beforeBuildCommand: ""`、`bundle.targets: ["nsis"]`、`externalBin: ["binaries/hwmusic-core"]`、CSP 按审计事实原文。
- [ ] **Step 3** capabilities/main.json：windows `["main","lyrics"]`；权限仅 `core:event:default`、`core:window:allow-start-dragging`、`global-shortcut:allow-register/unregister/is-registered`。
- [ ] **Step 4** 图标：Lucide `music` 字形生成脚本 `scripts/make-icon.mjs` → `build/icon.png` + `build/icon.LICENSE.txt`（ISC 归属）→ `cargo tauri icon` 生成 ico/icns/全套 png。
- [ ] **Step 5** 自测：`cargo test --manifest-path src-tauri/Cargo.toml` 通过（含数据根回退/覆盖旋钮纯函数单测）；`cargo tauri dev` 能开空主窗。
- [ ] **Step 6** pi 提交：`feat(shell): Tauri v2 外壳与最小权限`

### Task R3：sidecar 桥

**Files:** Create `src/host/{bridge.mjs,rpc.mjs,dispatcher.mjs,host-services.mjs}`、`src/sidecar/main.mjs`、`src/shared/{channels,request-channels,result}.ts`、`src-tauri/src/{bridge.rs,sidecar.rs,commands.rs}`。

**Interfaces:** Produces: NDJSON 帧 `{id,channel,payload}` / `{id,ok,data,error}`；`core_call` 唯一业务通道（Rust `generate_handler!` 白名单 + `require_main_window` 来源守卫）；宿主要求频道 `host:open-login`、`host:secure-encrypt`、`host:secure-decrypt`、`host:notify`；渲染层 `window.desktop` 方法路由表（`src/renderer/host-api.ts` 消费）；副作用：Rust `RunEvent::Exit/ExitRequested` 显式 `shutdown_core` 收尸。

- [ ] **Step 1** 先写帧协议失败测试（`test/bridge-protocol.test.mjs`：分帧/半帧/EOF/pending/双回调拒绝），跑 `node test/bridge-protocol.test.mjs` 确认红。
- [ ] **Step 2** 实现最小桥使测试转绿；Rust 侧 `FramePump` 双线程（帧泵 + 效果线程）与 `apply_effect` 按审计事实实现。
- [ ] **Step 3** 自测：`node --test test/bridge-protocol.test.mjs`（受限环境逐文件）+ `cargo test`。
- [ ] **Step 4** pi 提交：`feat(bridge): sidecar NDJSON 桥与白名单`

### Task R4：协议原型层（OAuth/PKCE 与业务接口）

**Files:** Create `src/protocols/{auth.mjs,music.mjs,lyrics.mjs,login-callback.mjs,safe-media-url.mjs}`、`src/music-types.d.ts`、`scripts/{probe-login.mjs,probe-music.mjs}`、`test/{auth,login-callback}.test.mjs`。

**Interfaces:** Produces: `createAttempt()`（client_id 101444301 / redirect hms://redirect_uri / scope openid / access_type offline / PKCE S256）；`consumeCallback(url)`（一次性、state timingSafeEqual、error/重复参数检查）；`isCallback()` 单一真源；`LOGIN_VIEW_TOP_INSET=48` 常量（放 `src/shared/login-inset.mjs`，huawei.ts 与渲染层**双侧导入**，任务书一致性要求）；`LOGIN_TIMEOUT` 双端 10 分钟字面量互钉测试；登录域名白名单数组（与 Rust 双份同步，测试钉住两份一致）。

- [ ] **Step 1** 失败测试先行：PKCE RFC 7636 向量、attempt 随机性、回调精确匹配、白名单、超时互钉（`test/login-parity.test.mjs` 扫描 Rust 与 Node 两处超时字面量相等、`login-inset` 只有一处字面量 48）。
- [ ] **Step 2** 实现 `auth.mjs`/`login-callback.mjs` 转绿。**业务端点未知**：写 `probe-login.mjs`（仅请求外网、不登录私人账号，需用户在场授权执行）重新确定 authorize/token/loginex 的确切 URL，结果记入 `docs/API_CONTRACT.md`。
- [ ] **Step 3** `music.mjs` 按探针确定的端点实现收藏分页/歌单/搜索/专辑/歌手/历史/播放地址；遵守业务语义陷阱（总数=分页 ID 去重；fileURL vs fileInfos；auditionTime 不单独判试听）。
- [ ] **Step 4** pi 提交：`feat(auth): OAuth PKCE 协议原型`

### Task R5：DPAPI 安全存储

**Files:** Create `src-tauri/src/secure_store.rs`、`src/main/{auth-manager.ts,json-store}` 接线。

**Interfaces:** Produces: `host:secure-encrypt/decrypt` 命令；`session.enc`（DPAPI 信封，0600+临时文件+rename）；失败路径：不可用→内存会话+明确提示，不写明文。

- [ ] **Step 1** 失败测试：往返加解密、不 panic、错误不回显密文、非 Windows 返回结构化错误。
- [ ] **Step 2** 实现后 `cargo test` 转绿；`#[ignore]` 的真 sidecar 持久化用例留待授权验证。
- [ ] **Step 3** pi 提交：`feat(auth): DPAPI 安全存储`

### Task R6：设置与统一代理

**Files:** Create `src/main/{settings.mjs,proxy.mjs}`、`src-tauri/src/webview_proxy.rs`（替代旧 b5_proxy.rs 命名）。

**Interfaces:** Produces: `settings.json` `{schemaVersion:1,data:{proxy,closeBehavior,...}}` 单一真源；`applySettingsProxy`（undici 全局 dispatcher，先于 AuthManager.restore 装配）；`testProxyConnection`；`webview_proxy_url()` 纯函数（凭据丢弃必须报告）；Rust `read_proxy(data_dir)`；**三窗接线：登录窗、主窗、歌词窗创建时都 `builder.proxy_url()`**（审计确认的旧缺口：主窗不接则封面/音频绕过代理）；环境变量兜底 + 启动提示可见。

- [ ] **Step 1** 失败测试：`test/proxy.test.mjs`（12 种坏输入→None 不猜、凭据不进 URL、bypass 归一、token 不进 URI、复位）；Rust 纯函数 8 例。
- [ ] **Step 2** 实现转绿；`lib.rs` 建主窗处接 `webview_proxy::resolve_for_webview(data_dir, "main")`。
- [ ] **Step 3** pi 提交：`feat(settings): 统一设置与 HTTP 代理`

### Task R7：登录链路与引导页

**Files:** Create `src-tauri/src/login.rs`、`src-tauri/tests/login_policy.rs`、`src/renderer/{login-gate.tsx,features/auth/login-gate-logic.mjs}`、`src/main/{huawei.ts,auth-manager.ts}`。

**Interfaces:** Consumes R4 的 attempt/consumeCallback/白名单。Produces: `open_login`（partition 随机隔离、独立数据目录、`on_navigation` 白名单+hms 拦截、`on_new_window` Deny、首载 30s 期限与超时 10min 双期限、四收场 Callback/Cancelled/Closed/TimedOut、结束清浏览数据+删目录）；布局：登录窗铺主窗内容区、顶部让出 `LOGIN_VIEW_TOP_INSET`（从共享常量计算，**两侧同一常量**）；渲染层门禁 `shouldShowLoginGate`/`shouldAutoStartLogin`（自动发起，未登录绝不渲染 app-shell）；capability 只绑 main，登录页无任何命令。

- [ ] **Step 1** 失败测试：`login_policy.rs`（白名单/拦截/回调原样/payload 不回显/partition 路径安全）+ `test/login-gate.test.mjs`（门禁分支先于 app-shell、取消条高度=共享常量非字面量）。
- [ ] **Step 2** 实现；二维码策略沿用审计结论：**官方授权页铺在引导页正文位置，二维码由官方页渲染，本项目不引入二维码库**（前端自绘二维码=自实现登录协议，触碰身份边界）。
- [ ] **Step 3** pi 提交：`feat(auth): 引导页与扫码登录`

### Task R8：主界面 UI

**Files:** Create `src/renderer/{App.tsx,pages.tsx,favorites-page.tsx,components.tsx,playlist-grid.tsx,log-terminal.tsx}`。

**Interfaces:** Consumes host-api 路由表。Produces: View union + Sidebar 导航；收藏页（常驻挂载不卸载 + IntersectionObserver 滚动加载 + 总数与已加载数分开显示 + 切页位置恢复）；TrackTable（双击播放/键盘/艺人专辑跳转/收藏）；GridSkeleton/空态文案克制。**禁止**：`style={{}}`（除 AMLL 100% 尺寸例外）、zinc/amber 等硬编码色（一律设计令牌）、自写视觉组件。

- [ ] **Step 1** 失败测试：`test/theme-tokens.test.mjs`（renderer 内禁止硬编码色类与 `<style>`；AMLL 变量只许出现在 amll-theme.css）。
- [ ] **Step 2** 实现转绿。
- [ ] **Step 3** pi 提交：`feat(ui): 主界面与页面`

### Task R9：播放器与 AMLL 歌词

**Files:** Create `src/renderer/{playback-stage.tsx,AmllBackground.tsx,AmllLyricsPanel.tsx}`、`src/renderer/features/playback/player.mjs`。

**Interfaces:** Produces: 单 `Audio` 实例状态机（队列可持久化但不存播放地址、进度/音量、顺序/列表循环/单曲循环/随机）；AMLL `BackgroundRender`+`LyricPlayer`（官方组件，宿主只做定位容器与 rAF 逐帧进度推送 + 200ms isSeeking 窗口）；歌词解析 `parseLrc`（@applemusic-like-lyrics/lyric）；Media Session 对接。

- [ ] **Step 1** 失败测试：`test/lyrics-window.test.mjs` 断言逐行滚动**必须来自 AMLL 官方组件**（禁自绘）。
- [ ] **Step 2** 实现转绿；真实华为音源全曲播放留授权验证（不虚标音质）。
- [ ] **Step 3** pi 提交：`feat(player): 播放器与歌词面板`

### Task R10：设置页

**Files:** Modify `src/renderer/pages.tsx`（SettingsPage）。

**Interfaces:** Produces: 代理表单（开关/主机/端口/用户名/密码/例外列表/测试连接/保存/恢复默认，凭据不进日志）；关窗行为（托盘/退出，联动托盘可用性提示）；**autostart 开关**（旧仓缺口：插件已注册但无 UI）；生效说明文案（sidecar 侧改代理需重启；登录窗下次打开即生效）。

- [ ] **Step 1** 失败测试：`test/proxy-settings.test.mjs`（表单清洗/复位/凭据处理）。
- [ ] **Step 2** 实现转绿。
- [ ] **Step 3** pi 提交：`feat(settings): 设置页`

### Task R11：托盘

**Files:** Create `src-tauri/src/{tray.rs,close_behavior.rs}`。

**Interfaces:** Produces: 菜单 9 槽位（含 CheckMenuItem 桌面歌词）；`decide_close(hide_on_close, tray_available)` fail-safe；`TrayState`（drop 即消失、失败落 Unavailable 进启动提示，不 panic）；启动时按 settings 恢复关窗行为（**先于建窗**）。

- [ ] **Step 1** 失败测试：`cargo test`（菜单映射/勾选镜像/fail-safe 降级，用 `tauri::test` mock runtime）。
- [ ] **Step 2** 实现转绿。
- [ ] **Step 3** pi 提交：`feat(tray): 托盘与关窗行为`

### Task R12：桌面歌词窗与任务栏降级

**Files:** Create `src-tauri/src/lyrics_window.rs`、`src/renderer/{LyricsWindow.tsx,lyrics-main.tsx,use-lyrics-window.ts,features/lyrics/*}`。

**Interfaces:** Produces: 四 async 命令（toggle/configure/document/progress，全部 `require_main_window`）；几何纯函数（taskbar/desktop position，负偏移钳 0）；歌词窗只订阅事件不回写；字号颜色可调（会话内，持久化**不做**，写入已知限制）；任务栏模式=贴 work_area 下沿单行，字号≤20。

- [ ] **Step 1** 失败测试：几何纯函数 + "无注入"源码扫描（SetWindowsHookEx/explorer 注入 0 命中）。
- [ ] **Step 2** 实现转绿。
- [ ] **Step 3** pi 提交：`feat(lyrics): 桌面歌词与任务栏降级`

### Task R13：系统集成

**Files:** Modify `src-tauri/src/{lib.rs,shortcuts.rs}`。

**Interfaces:** Produces: 单实例聚焦、window-state with_filter（只 main/lyrics）、快捷键（Media 三键 + Ctrl/Cmd+Alt+L 歌词 + Ctrl/Cmd+Alt+S 设置，失败逐条上报+备选链回退，不 panic）、通知走系统中心、autostart、log 落 app_log_dir。

- [ ] **Step 1** 失败测试：注册失败路径单测（mock）。
- [ ] **Step 2** 实现转绿；Wayland 热键限制写入 PLATFORM_DIFFERENCES。
- [ ] **Step 3** pi 提交：`feat(system): 系统集成`

### Task R14：打包、验收与 CI

**Files:** Create `scripts/{build-sidecar.mjs,dist-win.mjs,check-nsis-package.mjs,release-checksums.mjs,acceptance.mjs,tauri-smoke.mjs,test-browser.mjs}`、`.github/workflows/windows-nsis.yml`、`docs/RUN_AND_PACKAGING.md`。

**Interfaces:** Produces: `build:web → dist:sidecar → tauri build` 编排 + **mtime 新鲜度检查**（防嵌旧界面退出码 0）；SEA 双模式自验证；NSIS 静态校验（PE 头/三元组/暂存扫描不含 .local、research）；acceptance 六路径（登录门禁/代理/托盘/桌面歌词/任务栏降级无注入/设置持久化，SKIP 不算 PASS）；CI：npm test（fail 0/skipped 0）→ typecheck → test:browser（PASS N/SKIP 0/FAIL 0）→ cargo test → dist-win → check:nsis → SHA256SUMS；每步显式查 `$LASTEXITCODE`；Release 只在 v* 标签 + 四句免责声明。

- [ ] **Step 1** 本地全链自测：`npm run typecheck && node scripts/acceptance.mjs && npm run dist:win && npm run check:nsis` 全绿。
- [ ] **Step 2** pi 提交：`build: NSIS 打包链与 CI`

### Task R15：交付文档

**Files:** Create `README.md`、`docs/{API_CONTRACT,PLATFORM_DIFFERENCES,KNOWN_LIMITATIONS,IMPLEMENTATION_STATUS}.md`。

**Interfaces:** Produces: README（快速开始/构建打包/测试/架构四边界/数据隐私/已知限制/OAuth 身份声明/免责声明）；IMPLEMENTATION_STATUS 只用 verified/in-progress/pending/untested 四档，未验证平台不宣称支持；已知限制如实写（真实扫码待授权验证、任务栏歌词为降级实现、Linux/macOS 未实测）。

- [ ] **Step 1** 自测：文档断言与现实一致（无"已验收"掩盖 pending）。
- [ ] **Step 2** pi 提交：`docs: 交付文档`；全部任务通过后 pi 打 `v0.1.0` 标签。

---

## 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| K1 | **业务端点已随旧仓删除**，probe 需重新确定 URL | R4 探针 + 用户授权实测；API_CONTRACT 未确定前不宣称播放已验证 |
| K2 | OAuth 身份 `101444301` 非本项目注册，随时失效 | README/Release 四句声明；不改身份重试逻辑 |
| K3 | 本机 %APPDATA% 不可写 / spawn 受限 / npx 被禁 | `HWMUSIC_DATA_DIR` 旋钮；逐文件测试；直接指 node_modules 内 bin |
| K4 | `beforeBuildCommand=""` 嵌旧界面 | dist 脚本统一编排 + mtime 检查（R14） |
| K5 | 登录白名单双份漂移 | 互钉测试（R4/R7） |
| K6 | 主窗漏接 proxy_url（旧仓实际缺陷） | R6 明确三窗接线 + acceptance 代理路径覆盖 |
| K7 | 从零重写丢旧仓 49+121 测试的保护网 | 每任务 TDD 先行；关键回归点已在各任务 Step 1 列明 |
| K8 | 旧 git 历史已删，无回滚点 | R0 起新历史；每功能独立提交即新基线 |
| K9 | macOS/Linux 无安全存储后端 | 如实 pending，不静默明文 |
| K10 | 真实账号验证欠账 | 授权门禁任务：用户在场明确授权才执行，结果如实记档 |

## Self-Review

- 规格覆盖：任务书验收 1–11 → R0–R15 全部有对应任务；二维码策略、Tauri 插件取舍、任务栏降级按"审计存留事实"的既定决策执行并在计划中说明理由。
- 无占位符：每步给出具体命令/代码要点/测试断言；唯一显式未知（业务端点）标记为 K1 并给探针方法。
- 类型/命名一致：`LOGIN_VIEW_TOP_INSET`、`webview_proxy::resolve_for_webview`、`core_call`、`require_main_window` 等跨任务名称已统一。

## 执行交接

**计划已保存到 `docs/superpowers/plans/2026-10-18-full-rebuild-from-zero.md`（重建后的新路径）。两种执行方式：**

**1. Subagent-Driven（推荐）** — 每任务派发独立子代理执行，任务间由 kimicode 审查（符合任务书角色分工：deepseekharness 执行、kimicode 审查、pi 提交）。

**2. Inline Execution** — 本会话按 executing-plans 批量执行，检查点审查。
