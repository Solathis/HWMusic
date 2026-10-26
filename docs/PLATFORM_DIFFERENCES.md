# PLATFORM_DIFFERENCES — 三端能力差异

> **口径（先读）**：本文档只用四档描述每个平台的能力：
> **verified**（有可复现证据）/ **in-progress**（部分实现）/ **pending**（已设计未开始）/ **untested**（实现存在但没验过）。
> **未验证的平台不宣称支持**——本仓的代码路径、构建与运行期证据全部来自 **Windows**；
> Linux 与 macOS 的每一格都停在 `untested` 或代码级/编译期证据上，没有一格是真机跑出来的。
>
> 事实真源：`src-tauri/Cargo.toml`（target 分段依赖与 feature）、`src-tauri/tauri.conf.json`
> （`bundle.targets` 只有 `nsis`）、`src-tauri/capabilities/main.json`、以及各模块头注释里
> 明确写下的平台注记（`tray.rs` / `shortcuts.rs` / `secure_store.rs` / `webview_proxy.rs`）。
> 本机环境（实测）：Windows 11 + WebView2 155.0.4283.62 + MSVC VS 18 Community + rustc 1.99.1 + Node 24。

## 0. 一句话总表

| 维度 | Windows | Linux | macOS |
|---|---|---|---|
| 构建 / 打包 | **verified**（`dist:win` 本机真跑通，NSIS 26134896 B） | untested（未构建过） | untested（未构建过） |
| 安装包格式 | **NSIS**（`bundle.targets = ["nsis"]`） | pending（未配 target） | pending（未配 target） |
| 窗口 / webview | **verified（代码级）** + untested（真窗观感） | untested | untested |
| 托盘 | **verified（代码级）** + untested（真机点击/图标） | untested（且需要系统依赖，见 §2） | untested（且是编译期分支，本机从未编译） |
| 全局快捷键 | **verified（代码级）** + untested（真机注册与投递） | untested（**且只在 X11 会话下可能可用**，见 §5） | untested |
| DPAPI 会话加密 | **verified**（本机真跑过 `cargo test`；1 条半程端到端 ignored） | untested（`#[cfg(not(windows))]` 一行 stub，本机不参与编译） | untested（同上） |
| HTTP 代理（webview 侧） | **verified（代码级）** + untested（真抓包） | untested | untested（需 `macos-proxy` feature 且**仅 14+**） |
| 任务栏歌词 | 实验内嵌 Beta；Windows 单屏真实验证，多屏/高 DPI/自动隐藏未验 | unsupported | unsupported |
| 本地曲库协议（`hwlocal`） | **verified（代码级 + 浏览器守卫）**；真 WebView2 播放与 Range 未验 | untested（URL 形态是 `hwlocal://localhost/<id>`） | untested（同上） |
| 开机自启 | untested（真实注册表写入**刻意没测**，见 §6） | untested | untested（`MacosLauncher::LaunchAgent`） |
| 本机 `vite build` 临时目录 | **已验证需要 TEMP 指向仓内**（沙箱限制） | untested | untested |

**这张表里没有任何一格写着"支持 Linux"或"支持 macOS"。** 本仓的交付形态是 Windows 桌面应用。

---

## 1. capability 权限清单（三端共用，权限是窗口级而非平台级）

`src-tauri/capabilities/main.json` 只作用于 main：event、start-dragging、三项 global-shortcut。
`src-tauri/capabilities/lyrics.json` 只给 lyrics **event + start-dragging**，不授快捷键/HTTP/fs/login。
配置与媒体专命令按 webview label 只放行 main/lyrics；core_call、document/progress/toggle 仍 main-only。

| 权限 | 为什么需要 | 被谁消费 |
|---|---|---|
| `core:event:default` | core:event 频道广播与 ready 握手 | 两窗 |
| `core:window:allow-start-dragging` | 官方自窗 startDragging | 歌词拖柄与非交互宿主，锁定/点透时禁用 |
| `global-shortcut:allow-register` / `-unregister` / `-is-registered` | 主窗原有注册权限 | main 保留，lyrics 不再授予；当前实际注册仍在 Rust setup |

三条不能忘的事实：

1. **登录子窗不在 `windows` 名单里** —— 官方登录页拿不到任何权限，白名单与回调只靠导航事件观测。
2. **自定义命令不进 capabilities**：`core_call` 与全部 `core_*` 命令走的是**主窗来源守卫**
   （`require_main_window`）+ 频道白名单，而不是 ACL。依据是 Tauri 2.12.4 的 `Webview::on_message`
   只在「命令名带 `plugin:` 前缀 / 应用定义了 app 级 ACL manifest / 来源不是本地」三种情形查 ACL，
   本应用三者皆不成立；**前置条件由 `test/autostart.test.mjs` 钉住**（将来谁加了 app 级 manifest，那条用例先红）。
3. **不开 fs / shell / http / dialog / store 任何权限**，插件清单只限
   single-instance、window-state、global-shortcut、notification、autostart、log。

---

## 2. 托盘

| 项 | Windows | Linux | macOS |
|---|---|---|---|
| 实现状态 | **verified（代码级）**：`tray.rs`，9 槽位 / 7 项 / 2 条分隔线 | 同代码，**untested** | 同代码，**untested 且从未编译** |
| 图标 | `icons/icon.ico`（多尺寸，高 DPI 不糊），`include_bytes!` 内嵌 | `icons/32x32.png` | `icons/32x32.png` + `icon_as_template(true)` |
| 系统依赖 | 无 | **需要 `libayatana-appindicator3`**（缺了托盘装不上） | 无额外依赖 |
| 事件 | 菜单项 + 图标事件 | **`TrayIconEvent` 不派发** —— 只有菜单可用 | 未验证 |
| 真机表现 | untested（本机起不了真窗） | untested | untested |

- **安装失败绝不 panic**：落一条启动提示（`app:notice`）+ 一句日志，应用照常起来。
  一个装不上的托盘不该把应用带走——代价应当是「关窗即退出」，而不是「起不来」。
- **关窗三态与 fail-safe**：`closeBehavior` 选了 `tray` **且**托盘真的装上（现场查
  `tray_by_id(TRAY_ID)`）才 `prevent_close + hide`，托盘不可用仍回退退出；`minimize` 则是
  `prevent_close + window.minimize()`，不依赖托盘，主窗 `skip_taskbar=false` 保留任务栏入口。
  `quit` 异步收 sidecar 后退出整个应用（包含歌词与登录辅助窗），不只关闭主窗。失败保留可恢复主窗。
  **R44e（正常退出的顺序，跨平台一致）**：先做**可失败**的保存准备（冻结新写 → 等在飞的写/主题事务 →
  歌词最后一笔排空（失败至多一次重试）→ 主题 uncertain 重存 → `settings:get` 写队列屏障 → 校验盘上文档），
  成功才进入不可逆清理（D 的 detach/收尸 → `shutdown_core` → `app.exit`）。任何一步失败/超时都保窗可重试。
  **Windows 专有的一步**：准备成功之后、最终排队退出之前，对本应用**自己的**窗口发 `WM_CANCELMODE`
  （`PostMessage`、不用键盘注入、不碰 foreign HWND），因为 own 系统菜单/拖动模态会阻塞排队的 `app.exit`
  （控制器现场：8 秒未退，取消后 169ms 退出）。非 Windows 这一步是空实现。
  新 minimize/quit 与上述退出顺序的原生行为需控制器重启复验；Linux/macOS 仍未经真机验证。
- **菜单 id 前缀 `tray:` 与图标 id `"tray"` 是两件事**：前者是跨模块契约（判据 `action_for`），后者只是一个句柄名。
- **图标清晰度**：只验证了内嵌字节是合法多尺寸 ico 且能被 `Image::from_bytes` 解码
  （用例 `the_embedded_icon_decodes`）；**Windows 高 DPI 下的实际缩放表现未实测**。
- **macOS 的 `icon_as_template(true)`** 只是 `#[cfg(target_os = "macos")]` 分支——本机从未编译过该分支。

## 3. 代理

三端共同的设计：**单一真源 `settings.json`**，两条网络栈各自装配。

| 网络栈 | 装配点 | 平台差异 |
|---|---|---|
| sidecar（Node / undici） | 全局 `ProxyAgent` | 三端同款；**支持凭据** |
| webview（主窗 / 登录窗 / 歌词窗） | `builder.proxy_url(...)` | Windows/WebView2 与 Linux/WebKitGTK 行为未验证；**macOS 需要 `macos-proxy` feature 且只编到 macOS 14+** |

**三窗收口（R6 审计出的缺口 K6，已闭）**：漏接任一窗口的 `proxy_url`，封面图与 `<audio>` 音频流
就会绕过用户设置的代理直连。三个窗口建窗时都调 `webview_proxy::resolve_for_webview(data_root, tag)`：
`main`（R2/R6）、`login`（R7）、`lyrics`（R12）。由源码扫描 + 跨进程 e2e 双钉。

**Chromium 不吃内联凭据**：`--proxy-server` 的 URL 里放 `user:pass@` 无效，
所以 webview 侧**只接受 `http://host:port`**，用户名/密码**当场丢弃并报告**
（`webview_proxy::describe` 是唯一出口，有用例钉住它不含凭据）。认证代理只有 sidecar 那条路能走通。

**代理改动需重启**（三窗都是"建窗时读一次"）：主窗与 sidecar 改代理后必须重启应用；
登录窗/歌词窗是"下次打开即生效"。回执里的 `restartRequired` 就是这个说明的驱动源。

**`bypass` 只对 sidecar 生效**：Tauri 的 `proxy_url` 只接受一个 URL，没有 bypass 参数
（Chromium 的 `--proxy-bypass-list` 未被 Tauri 暴露）。命中例外的域名，sidecar 直连而
webview 仍走代理——这是两套网络栈的行为不一致，如实记（见 §8）。

## 4. 窗口

| 项 | 三端口径 | 状态 |
|---|---|---|
| 主窗 | 1280×800，最小 960×640，标题 = `productName` = `src/shared/app-name.mjs` 的显示名 | verified（代码级）；真窗未验 |
| 窗口状态持久化 | `StateFlags = SIZE \| POSITION \| MAXIMIZED`，只记录 main/lyrics；lyrics 跳过自动恢复，避免覆盖配置几何 | verified（代码级），R44c Windows 首开几何已验 |
| 登录子窗 | 无边框、不进任务栏、独立数据目录、独立 partition、不共享会话 | verified（代码级）；真窗未验 |
| 歌词窗 | 无边框 / 透明 / 无阴影 / 置顶 / 不进任务栏 / 不可缩放 / 不抢焦点 / 先建后 `show` | verified（代码级）；真窗未验 |
| webview 数据目录 | `<数据根>/webview2/{main,login/<partition>,lyrics}` | verified（代码级） |
| macOS 菜单栏 | **仅最小角色**（本项目不加自定义菜单栏） | 计划约束，未实测 |

- **数据根三级解析**：`HWMUSIC_DATA_DIR` 旋钮（绝对路径）→ 应用数据目录 → 应用缓存目录；
  **绝不回退 cwd**（打包后当前目录不可预测，可能是 Program Files）。这一条在 Windows 上尤其要紧：
  WebView2 默认落 `%LOCALAPPDATA%`，受限环境下不可写。
- **目录必须先建**：WebView2 不会自建，缺目录时建窗直接 `os error 5`（拒绝访问）。
- **登录窗不进 window-state 白名单**：它的位置不该被持久化（R2 已定）。
- **窗口状态的平台差异（未验证）**：多显示器、不同 DPI、自动隐藏任务栏这些机器上，
  window-state 的主窗恢复与 Beta 多屏几何都只有**纯函数级**证据（几何矩阵含负坐标副屏），
  **没有在多屏/混合 DPI 机器上真跑过**。

## 5. 全局快捷键

| 项 | 三端口径 |
|---|---|
| 组合清单唯一真源 | `src-tauri/src/shortcuts.rs` 的 `SHORTCUT_BINDINGS`（5 动作；媒体三键无备选，两条提示型组合各 2 条备选） |
| 注册时机 | `setup` 里**逐条**注册（插件不注册任何组合：插件的注册失败会崩启动） |
| 失败处置 | 逐条回退到备选链，仍失败则经 `app:notice` 说清「现在用的是哪个键」；托盘不可用时改指应用窗口 |
| 真机注册与投递 | **untested**（"媒体键按下去播放器真的动""`Ctrl+Alt+L` 真的开关歌词窗"没有实机证据） |

### Wayland（**X11-only**，如实披露，未实测）

`tauri-plugin-global-shortcut` 的 Linux 后端是 `global-hotkey`，而它**只有 X11 实现**
（`x11rb` + `xkeysym`，见 `global-hotkey-0.8.0/src/platform_impl/x11/`）。

- Wayland **原生会话**下没有 X 连接，**注册会失败**，没有隐藏的降级路径可走；
- 本模块的处理是**如实降级**：`GlobalHotKeyManager::new()` 在 X11 后端里只是起一个线程、
  当场返回 `Ok`，真正的连接错误落在每条 `register` 上 —— 于是每个动作各自走「注册失败」这条路，
  一条启动提示说清哪个键没能注册，并指路托盘菜单 / 主界面；
- **文案不承诺 Wayland，也不假装有替代方案**；这条约束由源码扫描用例钉住
  （`the_wayland_limitation_is_written_down_where_the_code_is`：`shortcuts.rs` 里必须出现
  `Wayland` 与 `X11`，且**不得**出现「支持 Wayland」之类的表述）；
- **Wayland 上快捷键可用性未在真机验证**（`untested`）；本模块的结论来自 `global-hotkey` 的
  源码结构，是**源码推断，不是真机证据**。

### 其它未验证的快捷键事实

- **Windows 上媒体键被其它程序占用是常态** —— 回退与提示正是为它写的，但「占用时插件返回的错误文案
  长什么样」只在夹具里模拟过；真实 `reason` 会原样进提示，**可能是英文的库错误文本**（宁可给真话，不替它编中文）。
- **setup 期注册不自锁** 的结论来自 `tauri-runtime-wry` 的 `send_user_message` 主线程内联分支（源码），没跑过真机冷启动。
- **`Pressed`/`Released` 去重（一次按键只发一条广播）** 没有真机抓过（源码 + 单测层面完备）。
- **设置页不显示当前生效的快捷键**（明确不做）：生效组合记在 `ShortcutState`（托管状态），只在启动提示说一次。

## 6. 开机自启 / 通知 / 单实例

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| 开机自启 | untested（**刻意不写真注册表**：那会在用户机器上留一个自启项） | untested | untested（`MacosLauncher::LaunchAgent`） |
| 单实例 | verified（代码级）：第二实例聚焦主窗 | untested | untested |
| 通知 | verified（代码级）：`host:notify` → 系统通知，标题 = 应用显示名 | untested | untested |
| 日志 | verified（代码级）：`tauri-plugin-log`，Info / KeepOne / 4MB / 本地时间（`UseLocal`），行格式 `[日期][时间][级别][target]`；sidecar stderr 由宿主读进同一文件（target `hwmusic_core`） | 同（`UseLocal` 跨平台同样成立） | 同 |

开机自启的**单测口径**要写清：用假 manager 覆盖的是**判定逻辑**（先写后读、报观测值、失败结构化、
「插件没注册」走 `try_state` 而不是 panic）；**真实注册表写入/读取未实测**。
界面开关跟着**观测到的实际状态**走（写完回读 `is_enabled`），不做乐观翻转。

### 后台验证开关 `HWMUSIC_BACKGROUND_TEST`（只供后台静默验证，不是用户旋钮）

取值为 `1` / `true` 时：主窗建出来**不显示也不激活**（`visible(false)` + `focused(false)`、跳过建窗后的 `set_focus`），window-state 也只恢复尺寸与位置、不恢复最大化（Windows 上那步就是 `ShowWindow(SW_MAXIMIZE)`）；托盘、登录页聚焦、单实例等所有"把窗口拉到前台"的路径统一空转。此时收到第二实例信号，测试实例写一条 info 日志后**退出自己**让位给用户的启动——按 single-instance 插件惯例，用户那次启动也会退出，用户需要再点一次图标（不另做"替用户重新拉起"）。缺省（未设 / `0` / `false` / 空白）与不加开关时的行为完全一致。

## 7. 任务栏歌词（Beta）：仅 Windows 实验内嵌

用户已授权精确自窗 SetParent 到合法 primary/secondary Shell root，Win10 可用 ReBar/WorkerW。Shell 没有稳定的歌词 API，故功能标 Beta，不保证全部 Windows 10/11 版本。Linux/macOS 明确 unsupported，不提供贴边浮窗冒充任务栏。

`taskbar_lyrics.rs` 只在 Windows 编译原生部分，使用实际父客户区映射和只读 UIA 占用差集；单 MTA/单在途查询、固定时效、迟到废弃；未知 UIA、无 100 DIP 安全空段、自动隐藏、权限/DPI 不符均隐藏并给结构化原因。自窗 owner 线程/创建代次/活性限制所有 native 写，Explorer 按钮尺寸/样式不改。切回 desktop 或换 Shell/parent/monitor 重建自窗并用 C ready 补文档进度；退出不 join UIA。

桌面模式默认 800×128 DIP 横版或 260×520 DIP 窄高竖版（R51 收紧，原 960×160 / 320×620），夹工作区，可拖锁与媒体控制；竖版（R61）由渲染层**自渲染单列**（一句一列、`text-orientation: mixed` 的 Unicode 默认混排、字号随窗口宽度 `clamp(1rem, 26cqw, 6rem)`、按演唱进度沿书写方向平移、无原生滚动条），不再借 AMLL 组件的行盒打补丁，也不使用 canvas；横版、任务栏、沉浸页仍由官方 `LyricPlayer` 渲染，行为未变。设置面是**另一扇独立小窗** `lyrics-settings`（无边框/透明/置顶/不进任务栏/不缩放，只有事件权限，尺寸与位置由 Rust 定）：R60 起是**气泡面板**——面板贴在窗口留边内侧、箭头指着齿轮，下方优先、放不下翻上方，水平以齿轮为中心并夹进工作区，窗口 = 面板 + 四周一圈透明留边（阴影与箭头）；竖版下「字号」项禁用（字号由窗口宽度决定）。Beta 单行最多 1200×44 DIP、有效字号≤20px、点透无控件带。window-state 只保存主窗，原生 D 状态不持久化。

扫描例外仅新模块的限定符号集合；DLL/全局 Hook/foreign HWND 写/系统进程 kill 始终禁止。MIT 参考固定 commit 与全文许可见 NOTICE。

实测边界（R47 `a62a0ad`，Windows 11 单屏 1920×1080 / dpi 96，正常完整性副本 + 真实 Explorer）：`attached:true`，`GetParent(歌词窗) == Shell_TrayWnd (0x20072)`，子窗 `8,1034 680×44`（宽度由 `safe_slot` 现算）、visible、`enabled=false`（输入交父窗）；同一时刻 show/hide 差分：槽位内 5235 / 5374 / 5394 px 变化，空段与任务栏按钮区 **0**，托盘仅 Explorer 自身活动；`WindowFromPoint` 17 个点全部命中 Explorer，无一点命中本应用；`mode:desktop` 后 `underTaskbar=0`、桌面窗恢复，`mode:taskbar` 往返再次 attached，退出后无残留。**未验**：多显示器 / `Shell_SecondaryTrayWnd`、高 DPI（scale≠1）、自动隐藏、`TaskbarCreated` 重建后的重挂、长时间 z-order、Windows 10、Linux/macOS、NSIS/release 安装包。仓库 `target/debug` 目录带 Low 完整性标签，直接跑该 exe 会 `access_denied`——那是构建目录 ACL 的环境现象，不是产品路径。失败路径（17 按钮零覆盖）仍然只是"降级正确"，不算内嵌成功。

## 8. 本地曲库（R65）：协议 URL、文件对话框、支持格式

| 项 | Windows | Linux | macOS |
|---|---|---|---|
| 音频 / 封面协议 URL | `http://hwlocal.localhost/<id>`（封面 `/<id>/cover`） | `hwlocal://localhost/<id>` | `hwlocal://localhost/<id>` |
| 基址来源 | `core_local_base_url`（`protocol_base()`，`#[cfg(windows)]` 分支） | 同左 | 同左 |
| 选文件对话框 | `tauri-plugin-dialog` 的 **Rust API**（`spawn_blocking` 里等，主线程不被占住） | 同左（未实测） | 同左（未实测） |

- **URL 形态由宿主算，渲染层不写死**：Windows 的 webview 只认 `http://<scheme>.localhost` 形态，mac/Linux 是 `hwlocal://localhost`。
  渲染层的 `normalizeLocalBaseUrl` 只接受这两种，认不出就回 `null`（界面说"本地播放不可用"），不拼一个注定 404 的地址。
- **文件对话框只从 Rust 侧调用**：capabilities 不给任何 webview `dialog` 权限，JS 也拿不到真实绝对路径；
  渲染层只发 `core_local_import`（`paths` 省略 = 弹系统对话框）。对话框在阻塞线程池上等——Windows 上同步等模态框会把事件循环锁死。
- **支持哪些格式由 WebView2 / Chromium 决定**，不是由我们的清单决定：`SUPPORTED_FORMATS` = mp3 / flac / m4a / aac / ogg / opus / wav。
  其它格式（ape、wma 等）在导入时直接拒绝并说明理由——导进来再发现播不了，比不导入更糟。
  这一条在 Linux（WebKitGTK）与 macOS（WKWebView）上的实际可播集合**未实测**，不要按 Windows 的结论推断。

## 9. 只在一端存在的东西（不要误当跨平台能力）

| 项 | 只在哪 | 说明 |
|---|---|---|
| **NSIS 安装包** | **仅 Windows** | `bundle.targets = ["nsis"]`；`check:nsis` 校验的也是 NSIS 暂存目录。Linux/macOS 未配任何 target，**未打包过** |
| **DPAPI（`CryptProtectData`）** | **仅 Windows** | `#[cfg(windows)]` 用 `windows` crate；非 Windows 是**一行 stub**（`Err(unavailable_error())`），本机不参与编译，只在 Linux/macOS 构建时才会被编译器检查 |
| **多尺寸 `.ico` 托盘图标** | 仅 Windows | 非 Windows 用 32×32 PNG |
| **`icon_as_template`** | 仅 macOS | 编译期分支，本机从未编译 |
| **`macos-proxy` feature** | 仅 macOS，且**只编到 14+** | Cargo.toml 已配；本机不参与编译 |
| **`MacosLauncher::LaunchAgent`** | 仅 macOS | autostart 插件配置 |
| **`--proxy-server` 的浏览器参数路径** | Windows/Linux 的 webview | macOS 走 feature 门；且 80 端口的代理会被 `url` crate 归一成无端口，拼出 `--proxy-server=http://host:`（按 URL 规范空端口 = 默认端口，**预期等效但未实测**） |
| **本机 TEMP 限制** | 本仓的开发机 | `vite build` / esbuild / tauri 在受限会话里需要把 `TEMP`/`TMP` 指向仓内 `.tmp/temp`；CI runner 不受影响 |

## 10. 未验证平台的诚实结论

Linux 与 macOS 的每一格都是 `untested`，**本仓不宣称支持它们**。交付形态是 Windows 桌面应用：

- 打包链只产出 NSIS；
- 会话加密只有 Windows 后端（其它平台会明确报「不可用」而不是静默降级明文）；
- 托盘在 Linux 需要额外系统依赖，且 `TrayIconEvent` 不派发（只有菜单）；
- 全局快捷键在 Wayland 原生会话下预期全部注册失败（逐条提示 + 指路托盘菜单），**未实测**；
- 代理的 webview 侧在 macOS 需要 14+。

要让这些格子从 `untested` 变成 `verified`，需要的是**真机证据**（各平台至少一次构建 + 一次真窗冒烟 +
一次快捷键/托盘/歌词窗目视），而不是代码推断。逐条清单与「谁是执行点」见
[docs/KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。
