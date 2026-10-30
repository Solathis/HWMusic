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

**当前基线（R79–R82 收尾，截至 `de60272`；下方表格是终审修复波的历史基线，保留作证据）**：`npm test` 1275 pass / 0 fail / 0 skipped；`npm run typecheck` exit 0；`npm run build:web` 通过；`npm run test:acceptance` PASS 6 / SKIP 0 / FAIL 0（无注入扫描 20 类 token × 179 个文件 → 0 命中）；`npm run test:browser` PASS 312 / SKIP 0 / FAIL 0；`cargo test` 414 passed / 0 failed / 1 ignored（lib 356 + 集成 58：`frame_log_redaction` 4、`login_policy` 19、`taskbar_lyrics_test` 35），无 warning。sidecar 自验证、NSIS 静态校验、真窗冒烟本轮未重跑。

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

### 1.1 R38 / R39 增补（2026-10-21）

> 上面那张主表停在 R15（`97a03d6`）。**R16–R37 的档位不在本文**：那些轮次的分级登记在
> [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)（A 组闭合项 / B 组真机项）与
> [API_CONTRACT.md](API_CONTRACT.md) §5 的变更记录里。这一节只按**同款格式**增补 R38 / R39 两轮，
> **既有行一行未动**；§0 那张测试基线的数字也保持原样（它是终审修复波的值），当前基线见下表两行。

| 任务 | 内容 | 提交 | 状态 | 决定性证据 |
|---|---|---|---|---|
| **R38** | 登录后的主界面五项修复（封面点亮 / 歌词数据链 / 账号区与退出迁移 / 品牌重复 / 账号资料） | `3ce04b4` | **混合档 —— 逐项见下**：**真机 verified 3 项 + in-progress 1 项 + pending 1 项**（含修复轮 2 Important + 2 Note 全修） | `npm test` **800 pass / 0 fail / 0 skipped**（799 → 800，修复轮只 +1 条新用例、**未改写任何既有断言**）；`tsc` 0 错；`build:web` ✓；acceptance 6/0/0；真机 CDP 现场 `.tmp/r38-verify-ui.json` / `r38-verify-ui2.json` / `r38-probe-lyrics.json` / `r38-probe-lrc-fetch.json`。未动 Rust / CSP / 白名单，未新开频道 |
| **R39** | 运行日志设置页化（编辑器样式 + 文本筛选）+ shadcn / AMLL 合规清查与守卫加固 | `5d0b578` | **verified（真机 CDP 41/41）**；合规清查「无硬违例」；7 处组合边界 + 1 条口径**登记待裁决**（见下） | `npm test` **810 pass / 0 fail**（800 → 810，+10）；`tsc` 0 错；`build:web` ✓；CDP 裸协议驱动**真窗口** **41/41 PASS**、0 console error、0 pageerror（`.tmp/r39-live/r39-summary.json` + 三张截图）；未动 Rust / 主进程 / 频道 / `app:notice` 载荷 / `components/ui/` 生成原语，`styles.css` 一行未改 |

| **R40** | 六项修复（账号资料第二/第三来源 / 歌单详情页重写 + 播放全部与加入队列 / 歌词舞台入口与第 4 档兜底 / 搜索移入侧栏常驻框 / 曲目表横向溢出 / 播放器控件居中） | 工作树（未提交） | **混合档 —— 逐项见下**：**真机 verified 5 项 + pending 1 项（账号资料要重启后下一次登录）** | `npm test` **832 pass / 0 fail / 0 skipped**、`npm run typecheck` exit 0、`npm run build:web` ✓、`npm run test:acceptance` **PASS 6 / SKIP 0 / FAIL 0**；真机 CDP 合并取证 **33/33 PASS、0 console error、0 pageerror**（`.tmp/r40-verify-all2.out.log`、`.tmp/r40-live/`） |

**R38 逐项分档**（档位口径同本文开头那张表；「真机」= 在真实桌面会话里跑出来、眼睛看得见）

| # | 项 | 状态 | 决定性证据（可复现） |
|---|---|---|---|
| R38-1 | **封面点亮**（歌单卡 / 曲目行 / 播放栏 / 队列行统一走 `components.tsx` 的 `CoverArt`——全仓唯一的 `<img>` 实现） | **verified（真机 CDP）** | 诊断先落地：`coverUrl` **全部落在既有白名单域内**（`contentcenter-drcn.dbankcdn.cn` / `image.tingmall.com` / `music-pics-drcn.dbankcdn.cn`）→ 纯渲染层接线，**不扩白名单、不碰 CSP、不碰契约域表**。现场：歌单页卡片 **2/2** 张有 `<img>`，歌单详情 **22/22** 行曲目有 `<img>`，`loading="lazy"` 2/2 与 22/22，**碎图 0、无占位行**（`.tmp/r38-verify-ui.json` 的 `playlistImages` / `trackTable` / `trackImages`）；客户端代码零 `fetch(`（`test/no-self-visual.test.mjs` 同扫这条）。**如实登记未接线项**：`AmllBackground` 的专辑图仍未接（AMLL 要 `HTMLImageElement`，接它得命令式建 `Image()` 并处理加载竞态，属另一件事），写在契约 §2.5 |
| R38-2 | **歌词数据链修复**（`getLyrics` 改三档：显式注入端点 → 已加载条目地址的进程内索引 → 播放响应/内嵌 `songInfo`） | **in-progress（代码已落地、已提交；真机播放复验待用户验收）** | **根因是真机取证出来的**：`$.albumInfoEx.songSimpleInfos[i].lyricAddress` **3/3 条都有**（白名单域、无查询串、GET 200、3332 / 900 / 22 字节、LRC 时间戳行 80 / 46 / 1），而 `playback:resolve-url` 的产物里**没有任何歌词类字段**——旧实现只问播放响应，真机上永远取不到歌词（`.tmp/r38-probe-lyrics.json` / `r38-probe-lrc-fetch.json`）。修完由 `test/music.test.mjs` +4 钉住（三档顺序、白名单外不进索引、索引过期回落、`songInfo` 同表；另有一条「被淘汰的地址一次都没被请求过」的**能杀变异**的断言）。**为什么不算 verified**：协议层跑在 sidecar，改动**需重启才生效**，而本轮简报要求不重启——「打开歌单 → 双击一首 → 点歌词 → 出现歌词行」这一眼**尚未有人看过**（见 KNOWN_LIMITATIONS B23 ①(b)）。**已知边界不是 bug**：索引只含用户本次运行加载过的条目，重启后直接播恢复出来的队列仍可能没歌词，不靠发明端点/编地址绕过去 |
| R38-3 | **账号区与退出迁移**（设置页整块「登录状态与退出」删净；退出收进账号区 `AlertDialog` 二次确认 + `host-api` 的 `coreLogout` 唯一实现） | **verified（真机 CDP，兜底形态）** | 账号区存在、文本 = `已登录`、`slots = [avatar, avatar-fallback, alert-dialog-trigger]`、**VIP 徽标不存在**（因为确实没有 VIP 事实）、退出按钮存在（`aria-label="退出登录"`）；点退出 → 确认框标题/说明/两个按钮**逐字比对通过** → 点「取消」→ `data-state="closed"`、`app-shell` 仍在、`login-qr` 不在（**仍是登录态，取消不丢会话**）；设置页卡片标题现在是 `[网络与代理, 关窗行为, 开机自启, 外观, 桌面歌词, 播放队列]`，「登录」卡与「退出登录」字样都已消失（`.tmp/r38-verify-ui.json` / `r38-verify-ui2.json`）。两条旧断言按新契约重写（`test/proxy-settings-form.test.mjs` 第 8 节、`test/settings-page.test.mjs`） |
| R38-4 | **品牌重复删除**（`App.tsx` 的 `SidebarHeader` 整块删净，不留空壳） | **verified（真机 CDP）** | `document.querySelector('[data-slot="sidebar-header"]')` → `null`（修复前**同一断言**是 `true`，`.tmp/r38-verify-ui.json` 的 `skeleton.sidebarHeaderPresent: false`）；`APP_BRAND_LABEL` 仍有调用方（`main.tsx` 的 `document.title`）→ 导出保留，`test/login-gate-markup.test.mjs` 仍钉「品牌不进引导页」 |
| R38-5 | **账号资料点亮**（名字 / 头像 / VIP 进 `auth:status` 的可选 `profile`） | **pending（等真机登录取证）** | `loginex` 响应的形状**从来没有实证**，所以只做了防御式候选键（名字 `userName`/`nickName`/`nickname`；头像 `headUrl`/`headImage`/`avatarUrl`/`avatar`/`head` 且必须过 CDN 白名单；VIP 只认明确布尔或有证据的 `memberShip` 含 `6`，`vipLevel`/`vipType` **刻意不认**）+ **只记键名**的 INFO 日志两行。当前会话是 R38 之前建的、**没有 `profile`** → 左下角如实显示兜底（R38-3 那一行已验）。**所以这一档的 verified 只能等下一次真实登录**：运行日志里那两行「顶层键名（只记键名，不记值）」才是字段名的真源，回填候选表后才谈"点亮"；`test/music-session.test.mjs` +6、`test/account-area.test.mjs` +4 只钉住**候选键与降级形状**，**不证明任何真实字段存在** |

**R38 的两条如实登记**（都不进 verified）：
- **修复轮第 1 处（封面失败闩锁跨曲目粘死）没有真机证据**：本仓测试是 `node --test test/*.test.mjs`，**没有 DOM/组件渲染基建**，`CoverArt` 那三行也没有可抽的纯逻辑，所以证据只到 `tsc` + `build:web` + 代码推理；而且那一刻 **1420 上没有 vite 在监听**，这一处（渲染层）当时**也没能 HMR 送进窗口**。要真机钉子得在运行实例上造一次封面失败（会动正在跑的播放状态），本轮没做。
- **R38-1 的现场取证是在修复轮之前取的**：修复轮改的是"失败闩锁"这三行，**不是**封面接线本身，所以 2/2 与 22/22 那些数字仍然有效；但那一处的窗口内形态与证据之间隔了这次改动，如实写在这里。

**R39 逐项分档**
| # | 项 | 状态 | 决定性证据（可复现） |
|---|---|---|---|
| R39-1 | **运行日志从侧栏 Sheet 搬到设置页页尾**：编辑器样式（行号 gutter + 等宽正文 + 有界 `ScrollArea`）+ shadcn `Input` 文本筛选 + 「N / 总数 条」计数 + 两种空态；数据层 `useNoticeLog` 一行未改，**订阅仍留在外壳**（`app:notice` 是广播，订阅挪进只在切页时挂载的设置页 = 打开设置页之前的日志全丢） | **verified（真机 CDP 41/41）** | 侧栏已无入口（`sidebarText` 里没有「运行日志」、`[class*="scroll-text"]` 命中 **0** 个、导航仍是那五项）；设置页卡片清单多出页尾「运行日志」；空态 `0 / 0 条` + 「暂无日志。」；走**真实广播通道**注入 4 条 `app:notice` 后 `lines=4`、gutter `["1","2","3","4"]`、正文不加工；筛选 `SETTINGS` → `lines=1`、计数 `1 / 4 条`；无命中 → `0 / 4 条` + 「没有匹配的日志。」；有界高度 `maxHeight=480px`（60vh）；**64 条压力**下 `viewport client=480 / scroll=1040`、`scrollTop` 可到 560 且最后一条落在视口内；等宽小字真计算值 `12px` + gutter 色 = 令牌 `--muted-foreground`；离开设置页无残留、队列 Sheet 未被波及；**0 console error / 0 pageerror**（`.tmp/r39-live/r39-summary.json` + 三张截图）。代码级：`test/log-terminal.test.mjs` **新增 9 条**（筛选 / 计数 / 数据层未改 / 样式接线 / 不发明级别 / 入口迁移 / 设置页卡），数字 800 → **810**。**过程中实测抓到一个真缺陷并修掉**：只有 `max-height`、没有确定高度的父盒子解不出 radix viewport 的 `height:100%` → 日志**溢出**而不是滚动（与旧 Sheet 完全同形）；修法把有界高度直接落到 viewport 上，由测试钉住那条任意变体必须在 |
| R39-2 | **守卫扩展（shadcn / AMLL 合规清查的机器证据）** | **verified（代码级）** | `test/no-self-visual.test.mjs`：① `UI_FILES` 补入 `login-gate.tsx` / `login-chrome.tsx` / `theme-control.tsx`——**这三个展示文件此前一直在扫描名单外**，里面的自绘/裸原语守卫结构性抓不到；② `<canvas>` 断言改成"例外集合**恰好** = `login-gate.tsx`"且**可验证地**钉住它只是库的渲染目标（宿主不碰 `getContext`、只经 `paintQrCanvas`、`qr-canvas.mjs` 里确实是 `QRCode.toCanvas`）；③ 新增「自绘滚动容器：面板一律走 ScrollArea，页面级滚动根的例外集合写死」（`SCROLL_ROOT_EXCEPTIONS` 逐文件计数 `deepEqual`）。三条判据的机械结论：**硬编码色 0 处**（`theme-tokens.test.mjs` 扫除 `components/ui/` 外全部手写文件）、**自定义 CSS 0 处新增**（`styles.css` 一行未改）、**裸元素替代 shadcn 原语 0 处**（全仓裸表单/表格/弹层元素只出现在 `components/ui/` 生成物与那块二维码画布） |
| R39-3 | 审计交上来的 **7 处组合边界 + 1 条口径问题**：三处页面级自绘滚动根（`App.tsx` 内容区 / 搜索页内层 / `favorites-page`——后者要真实元素给 `IntersectionObserver`）、设置页顶部 `<p role="alert">` 与仓里已有的 `Alert` 两种形态并存、`QueuePanel` 两行空态、`PlaybackStage` 是覆盖层而不是 `Dialog`、二维码 `<canvas>` 形态；口径：行号 gutter = **显示位置 1..N**（跟筛选走），计数 = 「筛出来的 / 总数 条」 | **pending（登记待裁决；本轮刻意不动）** | 都不是硬违例，也都不是"拿不准就不做"——是按简报要求把边界交上去，逐条给了倾向与代价（报告 §4）。**一条未实测的推断**一并如实登记：旧 Sheet 用的是同一个 `max-h` 形状，所以 R38 那个日志面板很可能**也滚不动**；入口已删、无法就地实测，**这不是 R39 引入的问题**，修好的是同一个形状 |

**R40 逐项分档**（2026-10-21；报告 `.superpowers/sdd/2026-10-18-full-rebuild-from-zero/task-40-report.md`）

| # | 项 | 状态 | 决定性证据（可复现） |
|---|---|---|---|
| R40-1 | **账号资料（名字/头像/VIP）的三个来源**：loginex 顶层（R38 已证扑空）→ loginex 的两个**有名字的容器**读一层（`queryAllSubInfoResp` / `queryAppConfigDetailResp`）→ **`id_token` 的 claims**（`name`/`nickname`/`picture`/`avatar`，头像过白名单；**VIP 不从 claims 取**）。四条**只记键名**的日志（token 顶层 / claims / loginex 顶层 / loginex 容器一层） | **pending（要重启 + 下一次扫码登录）** | 真机现状取证：`auth:get-status` 载荷键只有 `busy, loggedIn`（**没有 profile**），账号区文本 = `已登录`、无头像图 —— 即 **R38 之后建的会话（15:52 那次登录）依然扑空**，这正是本轮加两个来源的理由（`.tmp/r40-item1-account.json`、`.tmp/dev-visible.log` 的两行键名）。代码级：`test/auth.test.mjs` +3（JWT 合法/坏形状/键名助手）、`test/music-session.test.mjs` +4（一层容器读取、容器键名日志只含键名、claims 取值与白名单、合并与"认不出就不动原记录"）、`test/auth-manager.test.mjs` +3（claims 进会话记录且**原文不落盘**、坏 id_token 不影响登录、loginex 优先） |
| R40-2 | **歌单详情页重写**：AMLL `BackgroundRender` 头部底景（封面经 `new Image()` + `crossOrigin="anonymous"` 载入）+ 大封面/名字/元信息 + 「播放全部」（整队替换开播）/「加入队列」（追加，**不动正在播的那一首**，`player.mjs` 新增 `enqueue`）+ 沿用 `TrackTable` | **verified（真机 CDP）** | 真机：头部 `title=奋斗，希望`、`description=共 22 首`、封面 `<img>` host `contentcenter-drcn.dbankcdn.cn`、底景 AMLL canvas = 1、两个按钮可用；**加入队列 22 → 44**（状态 `idle → idle`，不动当前项）、**播放全部 44 → 22 且 index=0、`data-state=playing`**；头部不撑出横向溢出（`.tmp/r40-item2-*.json`、`.tmp/r40-live/r40-2-playlist-detail.png`）。测试：`test/library-views.test.mjs` +1（头部文案：标题/元信息/「只加载了前 N 首」）、`test/playback-player.test.mjs` +4（追加/不打断/空队列不自动出声/不去重）、`test/no-self-visual.test.mjs` 的新用例钉住头部与两个按钮的接线 |
| R40-3 | **歌词/播放页**：`getLyrics` 增第 4 档（索引没命中且**播放响应自己给了 `albumID`** → 经既有专辑端点补一次条目索引）；PlayerBar 的封面/曲目信息点击 = 进歌词舞台（与头部按钮同一个 state）；舞台底景带上当前曲目封面 | **verified（真机 CDP）**：入口与既有链路成立；**第 4 档仍 untested**（协议层要 sidecar 重启） | **B23 未被复现**：恢复队列里的两首直接调 `playback:lyrics` 都成功（850 / 1081 字符、`warnings: []`），舞台里 AMLL 面板挂载且 `notice=null` → R38 的第 2 档在真机上确实生效（`.tmp/r40-b23-probe.json`、`.tmp/r40-item3-stage.json`）。点击入口：`player-track-info`（`aria-label="打开歌词"`）→ 舞台出现 + 面板挂载（`.tmp/r40-live/r40-3-stage.png`）。第 4 档的成败取决于"播放响应里有没有 `albumID`"，因此回落时**只记键名**地记一行日志（`topLevelKeysOf` / `objectKeysOf`），重启后一眼可见；测试 `test/music.test.mjs` +5（成功补索引/无 albumId 不瞎试/专辑里没这首/日志只含键名/无 log 注入位不崩） |
| R40-4 | **搜索布局**：侧栏顶部常驻 `SidebarInput`（回车提交，关键字进 `VIEW.search` 的视图参数），内容区只渲染结果；侧栏「搜索」导航项删除 | **verified（真机 CDP）** | 侧栏 `[data-slot="sidebar-input"]` 存在、placeholder「搜索歌曲、歌手或专辑」、导航 = 我的收藏/我的歌单/播放历史/设置（**无搜索**）；提交「周杰伦」→ 标题 `搜索`、**50 行结果**；搜索页里 `inputs = []`（没有第二个输入入口）；空白关键字 → 「输入关键字开始搜索。」（`.tmp/r40-item4-*.json`、`.tmp/r40-live/r40-4-search.png`）。测试：`test/library-views.test.mjs` 改写 R8 那条"侧边栏要覆盖搜索"为"搜索不再是导航项"；`test/no-self-visual.test.mjs` 新增「R40 搜索布局」用例（含页面里不许再有输入框/表单） |
| R40-5 | **曲目表横向溢出** | **verified（真机 CDP，三档窗宽）** | 根因（真机实测）：`table-layout: auto` 下 `w-40` 只是建议——艺人/专辑被 nowrap 内容撑到 318 / 479 px，表格长到 **1361 px** 而内容区 **1024 px**，整表横向溢出（`.tmp/r40-table-baseline.json`）。改法：`table-fixed` + 列宽配比常量（艺人 18% / 专辑 22%，标题吃余量）+ 列内真 `truncate`。复测：**1280 / 1024 / 820** 三档窗宽下 `horizontalOverflowChain = []`、`documentOverflow = false`、容器 `scrollWidth == clientWidth`；窄窗下艺人列 `clientW=81 / scrollW=149 / text-overflow=ellipsis`（.tmp/r40-item56-*.json、r40-item5-clipping.json）。顺带修掉一处真机抓到的 React 重复 key（行 key 带上行号） |
| R40-6 | **PlayerBar 控件居中**（三区布局） | **verified（真机 CDP，三档窗宽）** | 控件组 `absolute left-1/2 -translate-x-1/2`，三档窗宽下**中点偏差 0 px**（1280：栏中点 768 / 控件中点 768；1024：640/640；820：538/538，`.tmp/r40-item56-*.json`）。选绝对定位而不是 `flex-1 basis-0` 等分：两侧内容天然不等宽，等分只让剩余空间相等、中点仍会漂（理由写在组件注释里）；代价是极窄窗宽下可能与左区重叠，左区文字先截断、控件始终完整可点 |

**R41 逐项分档**（2026-10-21；报告 `.superpowers/sdd/2026-10-18-full-rebuild-from-zero/task-41a-report.md`；
本轮的 Rust / sidecar 改动**要重启应用**才生效，见报告 §需重启清单）

| # | 项 | 状态 | 决定性证据（可复现） |
|---|---|---|---|
| R41-1 | **歌词磁盘缓存**（`lyrics-cache/` 90 天 TTL + `lyrics-local/` 本地导入）与三条 `lyrics:*` 频道 | **代码级 verified + 真进程 e2e verified**；真机生效**待重启** | `test/lyrics-cache.test.mjs` 12 条（真目录：TTL / 原子写 / prune / 清缓存默认不删本地导入 / 无数据目录如实报不可用）；`test/sidecar-e2e.test.mjs` 用**真 sidecar 进程 + 真数据目录**跑通「导入 → 占用 +1 → `playback:lyrics` 命中本地 → 清缓存」；真机上渲染层对**运行中的旧二进制**调 `lyrics:cache-info` 得到 `unknown_channel`（`.tmp/r41-live/r41-channel-probe.json`）——"改了但要重启"这条事实本身有证据 |
| R41-2 | **本地导入 `.lrc`/`.txt`**（渲染层解码 BOM → UTF-8 严格 → GBK；导入即生效） | **代码级 verified + 真机 UI 链路 verified** | `test/lyrics-import.test.mjs`（解码退化链、四类拒绝文案、桥只发**文本**不发路径）；真机 CDP：`DOM.setFileInputFiles` 把一份真 `.lrc` 塞进隐藏的 `<input type=file>` → 卡片把 core 的结论如实显示（`.tmp/r41-live/r41-ui-import.json`） |
| R41-3 | **第三方回退**（Kugou → lrclib；严格 title+artist+duration、8 秒超时、失败静默不缓存、UA 不带凭据） | **代码级 verified**（联网未在真机验） | `test/lyrics-provider.test.mjs` 8 条 + `test/lyrics-fallback.test.mjs` 8 条（注入 fetch：三步走通 / 严格匹配拒绝翻唱与"安静下来" / 五类失败静默 / 请求头只有 accept+UA+referer） |
| R41-4 | **`getLyrics` 六跳编排**（本地 → 内存 → 磁盘 → 华为四档 → 第三方 → `invalid_response`）+ 第 4 档会话内负缓存 | **代码级 verified** | `test/music.test.mjs` 的 R41 组（本地压过一切、内存/磁盘命中不打网络、失败不缓存、缓存端口抛错不挡路、导入接口、负缓存按 (曲目, 专辑) 生效）；`docs/API_CONTRACT.md` §2.3.2 |
| R41-5 | **桌面歌词窗**：显示前重新加载页面（从"加载失败 ⇒ 永久空白"里恢复）+ 主题跟随 + 窗口标题 | **根因取证 verified（真机 Win32/像素）；修法待重启复测** | 品红背板实验：那块 960×120 里**非品红像素 0**（页面一个像素都没画，`.tmp/r41-live/r41-lyrics-over-magenta.png`）；`1420` 无监听 + vite 日志止于 16:27:50（页面恰在建窗那一刻加载失败）；窗口 960×120 @ (480,792) = `desktop_position` 的正解、`WS_EX_TOPMOST` 在、exStyle `0x40118`（无 `WS_EX_TOOLWINDOW` ⇒ Alt+Tab 里显示 "Tauri App"），`.tmp/r41-windows.json` |
| R41-6 | **设置页歌词挂点**（缓存占用 / 一键清除 / 导入入口） | **verified（真机 CDP）** | `.tmp/r41-verify.mjs` **15/15 PASS**：卡片挂载、`accept=.lrc,.txt`、两个按钮在、占用文案三档分得开（正在读取 / 数字 / 读不到）、开关能关能开、窗打开时主窗重推 `lyrics:document`（广播回声）、0 console error / 0 pageerror |

**本轮逐项分档（2026-10-26；R50–R67）**

**口径**：本轮**全部只有代码级验证** —— Node 单测（`npm test`）+ 无头浏览器守卫（真协议层、真渲染）。按静默规程**本轮没有启动真实实例**，因此下表**没有任何一项是真机 verified**；「状态」列里不出现“真机”二字。真窗观感一律记在 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) B 组。

| # | 项 | 状态 | 决定性证据（可复现） |
|---|---|---|---|
| R50 | 沉浸页歌词开关位置、透明歌词可读性、设置保存（`ac4a9d5`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/player-lyrics.test.mjs` +182、`test/playback-lyrics-toggle.test.mjs` +50、`test/lyrics-window.test.mjs` +87/−31、`test/lyrics-panel.test.mjs` +10/−1 |
| R51 | 桌面歌词设置弹出窗、紧凑默认尺寸（`d23f43a`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/lyrics-settings-popup.test.mjs` +209、`test/lyrics-window.test.mjs` +73/−59、`test/no-self-visual.test.mjs` +2 |
| R52 | 重构设置歌词页，沉浸式禁止改色（`7b8a6c5`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/lyrics-settings-page.test.mjs` +201、`test/lyrics-panel.test.mjs` +24/−17、`test/lyrics-window.test.mjs` +61/−24、`test/settings-page.test.mjs` +5/−3；旧的沉浸页改色用例整条删除（`test/player-lyrics.test.mjs` −182） |
| R53 | 设置页铺满主内容区（根因：`max-w-3xl`）（`8628db4`） | **代码级 verified（无头浏览器守卫）** | `scripts/test-browser.mjs` +258（宽窗下设置页右侧无空白、内容区撑满的守卫用例）；`src/renderer/App.tsx` / `pages.tsx` 去掉 `max-w-3xl`。**无单测改动** |
| R54 | 已登录冷启动不闪登录页，登录后停二维码轮询（`83118d2`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/auth-manager.test.mjs` +123、`test/login-gate.test.mjs` +58/−1、`test/auth-qr.test.mjs` +66、`test/qr-login.test.mjs` +34、`test/sidecar-e2e.test.mjs` +23、`test/channel-parity.test.mjs` +19 |
| R55 | 底栏总时长，沉浸页顶部整行可收起（`6bb0276`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/playback-player.test.mjs` +77/−1、`test/playback-runtime.test.mjs` +14、`test/playback-lyrics-toggle.test.mjs` +6/−4、`test/lyrics-panel.test.mjs` +1/−1 |
| R56 | 去掉歌单/历史加载说明，整表播放/入队；分页只读核查结论：服务端不分页（`5db5345`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/library-pagination.test.mjs` +127/−44、`test/music.test.mjs` +39、`test/library-views.test.mjs` +1/−7、`test/no-self-visual.test.mjs` +3/−2；只读结论与 `start`/`limit`/`pageNum`/`pageSize`/`offset` 的证据见 KNOWN_LIMITATIONS **A7** |
| R57 | 运行日志汇集 sidecar 输出，设置页按级别/关键字筛选（`7ac0c6e`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/run-log.test.mjs` +204、`test/log-terminal.test.mjs` +104/−155、`test/sidecar-e2e.test.mjs` +48/−1、`test/autostart.test.mjs` +47/−9 |
| R58 | 后台验证启动开关 `HWMUSIC_BACKGROUND_TEST`（`f06ebcb`） | **代码级 verified（源码锚点）** | 无单测改动：`src-tauri/src/lib.rs` +213/−8、`src-tauri/src/login.rs` +39/−1 的启动链分支，口径记在 `docs/PLATFORM_DIFFERENCES.md`。**运行期行为未在真机核**（本轮未起真实实例） |
| R59 | 账号区头像/名称/会员按证据显示（资料端点不可行）（`74fd7d7`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/account-area.test.mjs` +76/−3、`test/music-session.test.mjs` +11、`test/no-self-visual.test.mjs` +4/−3；“端点不可行”的结论见 KNOWN_LIMITATIONS **A9** |
| R60 | 桌面与任务栏歌词恢复逐字扫亮（`a3389ab`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/lyrics-window.test.mjs` +10（逐字高亮的按字切换断言） |
| R61 | 任务栏歌词独立设置颜色/字号/逐字（`450174f`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/lyrics-window.test.mjs` +174/−10、`test/lyrics-settings-page.test.mjs` +7/−4 |
| R62 | 桌面歌词设置改为指向齿轮的气泡面板（`afef324`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/lyrics-color.test.mjs` +147、`test/lyrics-settings-popup.test.mjs` +121/−58、`test/theme-tokens.test.mjs` +18/−1 |
| R63 | 竖版歌词单列竖排，字号随窗口宽度（`1e16fe2`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/vertical-lyrics.test.mjs` +223、`test/lyrics-window.test.mjs` +22/−76 |
| R64 | 我的歌单移到左侧栏（封面/名字/数量）（`180389f`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/sidebar-playlists.test.mjs` +167、`test/library-views.test.mjs` +9/−3、`test/no-self-visual.test.mjs` +14/−6、`test/theme-tokens.test.mjs` −1 |
| R65 | 应用内右键菜单，屏蔽网页默认菜单；**加入歌单未实现（无追加端点证据）**（`4525ce3`） | **代码级 verified（Node + 无头浏览器守卫）**；「加入歌单」**untested（刻意不做）** | `test/context-menu-guard.test.mjs` +215、`test/track-menu.test.mjs` +109、`test/playback-player.test.mjs` +77、`test/sidebar-playlists.test.mjs` +11/−18；缺项原因见 KNOWN_LIMITATIONS **A8** |
| R66 | 保存并恢复上次播放进度（恢复后暂停）（`28189c9`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/playback-player.test.mjs` +278/−5、`test/playback-queue.test.mjs` +52、`test/playback-runtime.test.mjs` +72/−1 |
| R67 | 左侧栏本地歌曲，本地导入自动识别歌词（`7f502ff`） | **代码级 verified（Node + 无头浏览器守卫）** | `test/local-library.test.mjs` +172、`test/local-lyrics.test.mjs` +157、`test/local-queue.test.mjs` +106、`test/local-views.test.mjs` +69、`test/safe-media-url.test.mjs` +52、`test/dispatcher.test.mjs` +8/−4、`test/channel-parity.test.mjs` +2、`test/library-views.test.mjs` +2/−1 |
| R68 | 桌面歌词进度改为订阅播放器通知；宿主缓存最新一帧，窗口不存在不广播，页面加载后补发文档与进度（`73e6967` `78bd3ef`） | **代码级 verified（Node + 无头浏览器守卫 + Rust 单测）**；真实窗口未验（KNOWN_LIMITATIONS B29） | `test/progress-pump.test.mjs`、`test/lyrics-window.test.mjs`；`npm test` 1247/0、`test:browser` 289/0、`cargo test` 404 passed |
| R69 | 锁定后鼠标穿透与解锁键、锁定衬底更淡、新增「纯透明」样式；删掉 clickThrough 配置与设置页两个开关（`2ed9074`） | **代码级 verified（Node + 无头浏览器守卫 + Rust 单测）**；真实窗口未验（B30） | `test:browser` 295/0（新增 r69 六项）、`npm test` 1249/0、`cargo test` 407 passed |
| R70 | 竖版字号与横版同档位、逐字连续扫亮、竖版默认 240×600（`d0cf6c9`） | **代码级 verified（Node + 无头浏览器守卫 + Rust 单测）**；真实窗口未验（B31） | `test:browser` 297/0（r70 四项）、`npm test` 1249/0、`cargo test` 407 passed |
| R71 | 播放栏与沉浸页的「桌面歌词 / 任务栏歌词」快捷切换，气泡面板加「位置」（`892ff3b`） | **代码级 verified（Node + 无头浏览器守卫）**；真实窗口未验（B32） | `test:browser` 303/0（新增 r71 六项）、`npm test` 1251/0 |
| R72 | 日志：快捷键回退记 INFO、sidecar 按请求退出记 INFO、设置页日志按启动分段（`ec50567`） | **verified（代码级 + 真实后台实例）** | `test:browser` 304/0（新增 r72-log-scope）、`npm test` 1252/0、`cargo test` 411 passed；真实后台实例里快捷键回退记 INFO、不再出现误报的 WARN |
| R73 | 「加入已有歌单」端点实测：没有追加语义，按用户裁决不做（无代码改动） | **verified（负结论）** | 临时歌单实测 15 次请求，建 1 删 1、以列表核对已清理（API_CONTRACT §2.13） |
| R74 | 全仓注释精简：去掉修改编号与修复经过（`9982396` `f1213da` `aaa0b04` `538fd51` `0eb2873` `118e096` `894a175` `86afbe9`） | **verified（只改注释）** | 每个提交 esbuild 去注释后与改前一致（模板字符串里的生成源另核）；Rust / toml / yml / html 非注释行改动 0；`npm test` 1252/0、`test:browser` 304/0、`cargo test` 411 passed |
| R75 | 按 `expireTime` 识别音乐会话到期：恢复与运行中都先判，到期回登录页并说明原因，会话结束后二维码重新自动出现（`d6d2a31`） | **代码级 verified（Node）**；启动恢复判到期已在真机验证（2026-10-28），时区按 R78 改正（KNOWN_LIMITATIONS B33） | 用户确认歌单与播放历史为空列表（不是报错）；`npm test` 1265/0（新增 10）、`test:browser` 307/0 |
| R76 | 竖版桌面歌词默认收窄到 112×600（lg 档正好两列），最小尺寸按布局取，窄窗工具栏换行（`cad109e`） | **代码级 verified（Rust + Node + 无头浏览器守卫）**；真实窗口未验（B34） | 守卫 `r76-vertical-default-two-columns`：改前 240 宽左侧空白 158px、译文夹具出现第三列，改后两列、空白 30/36px；`cargo test` 412 passed |
| R77 | 任务栏歌词不再套卡片底色与边框（`b67c358`） | **代码级 verified（Node + 无头浏览器守卫）**；真机任务栏观感未验（B35） | 守卫 `light-/dark-taskbar-surface-transparent`：改前 panel 组多一层 card（alpha 255 + 1px 描边），改后与 clean 组四层一致、全透明 |
| R78 | `expireTime` 改按 UTC 解读，到期时刻按本机时间显示（`06a6555`） | **verified（Node；证据来自真机启动日志）** | 真机启动日志：`expireTime=20261028075221`，session.enc 写于 2026-10-21T07:52:23.943Z，按 UTC 解读恰好加 7 天；R75 按北京时间解读会提前 8 小时判到期。`npm test` 1266/0（新增真机证据用例）、`test:browser` 307/0 |
| R79 | 账号名悬停显示登录会话的实时剩余时间（`7b35f38`） | **代码级 verified（Node + 无头浏览器守卫）**；真机未验（KNOWN_LIMITATIONS B36） | `auth:status` 在会话记录带 `expireTime` 时多带 `sessionExpiresAt`（UTC 毫秒，广播与快照同源）；守卫 `r79-account-session-remaining`：悬停文案「距登录过期还剩 6 天 5 小时 10 分 0 秒」，1.2 秒后变成「… 9 分 59 秒」。`npm test` 1269/0、`test:browser` 307/0 |
| R80 | 沉浸页收起行悬停改淡色半透明；Windows 上进沉浸页收起系统标题栏，页面画拖动区与窗口按钮，退出与重载前装回（`de60272`） | **代码级 verified（Rust + Node + 无头浏览器守卫）**；真实窗口未验（KNOWN_LIMITATIONS B37） | 守卫 `r80-immersive-chrome-*`：悬停底色浅色 alpha 76、深色 alpha 26（改前 ghost 的 `hover:bg-muted` 在浅色主题不透明）；打开与关闭成对发 immersive、normal；窗口按钮贴右上角、不压收起箭头、三个动作各发一次；拖动不收起、点击收起。`npm test` 1275/0、`cargo test` 414/0、`test:browser` 312/0 |
| R81 | 逐字扫亮按唱速封顶，句后停顿不再拉慢扫亮（`aaf0c81`） | **代码级 verified（Node）**；真机听感未验（KNOWN_LIMITATIONS B38） | 同一份歌词：第 5 句（6 字、句后停 8 秒）扫亮终点 14800 → 6600ms，最后一句 16000 → 15400ms，其余句不变。`npm test` 1271/0、`test:browser` 307/0 |
| R82 | 桌面歌词控件行加关闭键，走托盘「关闭桌面歌词」同一条路（`609e8ac`） | **代码级 verified（Rust + Node + 无头浏览器守卫）**；真机未验（KNOWN_LIMITATIONS B39） | `core_lyrics_control` 动作表加 `close`：先改托盘勾选、再发 `lyrics:toggle {checked:false}`；守卫 `r82-desktop-close-key`：图标 `lucide-x`、在控件行里、一击只多一条 `close`。`npm test` 1272/0、`cargo test` 413/0、`test:browser` 308/0 |

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
| 5 | 设置持久化（`settings.json` 形状/清洗/0600/原子写） | **verified**（+R50–R67 代码级：沉浸页歌词设置保存、设置页铺满主内容区） | **verified**（本机真写盘、真读回） | `test/settings-test-proxy.test.mjs`、`test/settings-page.test.mjs`、`scripts/acceptance.mjs` 的 `settings-persistence` 路径（4 条源码锚点） |
| 6 | HTTP 代理（sidecar 侧 undici `ProxyAgent`） | **verified** | **verified**（本地假代理端到端到 HTTP 头级） | `test/proxy.test.mjs`；`test/fixtures/proxy-host-cases.json` 31 例跨语言互钉（5 变异全灭） |
| 7 | HTTP 代理（三窗 webview `proxy_url`） | **verified**（源码扫描 + 跨进程 e2e 双钉） | untested（真抓包） | `test/proxy.test.mjs` 的接线扫描；`scripts/acceptance.mjs` 的 `proxy` 路径 |
| 8 | 登录门禁（未登录不渲染主界面） | **verified**（+R50–R75：已登录冷启动不闪登录页、登录后停二维码轮询、会话到期回登录页并说明原因、会话结束后重新出码） | untested | `test/login-gate.test.mjs`；`scripts/acceptance.mjs` 的 `login-gate` 路径（4 锚点：`shouldShowLoginGate` 判定 + `App.tsx` 真的挡在 `app-shell` 之前） |
| 9 | 登录子窗（白名单导航 / `hms://` 拦截 / 双期限 / 四收场） | **verified** | untested | `test/login-parity.test.mjs`（双端互钉）；Rust `src/login.rs` 内联测试 + `tests/login_policy.rs` 17 passed（含建窗失败路径删一次性数据目录） |
| 10 | 收藏分页（无可信总数 → 完整分页去重） | **verified** | untested（端点未配） | `test/favorites-pagination.test.mjs`；协议层 `readFavoritesPage` |
| 11 | 歌单 / 搜索 / 专辑 / 歌手 / 历史 | **verified（协议层 + UI 三态；+R50–R67：整表播放/入队、加载说明文案删除、只读核查确认服务端不分页）** | untested（端点未配） | `test/music.test.mjs`、`test/library-views.test.mjs`、`test/dispatcher.test.mjs`、`test/sidecar-e2e.test.mjs`（真进程） |
| 12 | 播放器状态机 + 队列持久化 | **verified**（+R50–R67：整表播放/入队、底栏总时长、上次播放进度保存与恢复后暂停） | untested（无真实音源） | `test/playback-state.test.mjs`、`test/playback-queue.test.mjs`、`test/playback-runtime.test.mjs`、`test/playback-player.test.mjs` |
| 13 | 播放地址纪律（不日志/不落盘/不缓存/不进状态） | **verified** | untested | `test/playback-channel.test.mjs`；断言状态快照序列化后不含 `http`/CDN 域 |
| 14 | `<audio>` 真实播放 | untested | untested | 端点未配置 → 无法验（B10） |
| 15 | 歌词解析适配（`[offset:]` + 翻译行）+ 逐行滚动 | **verified**（+R50–R70：竖版单列竖排、字号与横版同档位、逐字连续扫亮） | untested | `test/lyrics.test.mjs`、`test/amll-adapter.test.mjs`、`test/lyric-sync.test.mjs`；AMLL 官方组件真实挂载冒烟 23/23 |
| 16 | 歌词文本通道（`playback:lyrics`） | **verified（频道）** | untested（端点未配） | `test/lyrics-window.test.mjs`、`test/channel-parity.test.mjs` |
| 17 | Media Session 系统媒体控件 | **verified（映射逻辑）** | untested | `test/media-session.test.mjs` |
| 18 | 桌面歌词窗（六条 async 专命令、锁/媒体、横竖/样式、配置持久化） | **verified**（+R50–R71：设置弹出窗与齿轮气泡面板、紧凑默认尺寸（R76 竖版收窄到两列）、独立颜色/字号/逐字、逐字扫亮恢复、进度不依赖主窗可见、锁定后鼠标穿透、纯透明样式、桌面/任务栏快捷切换） | **R44c Windows 已验拖锁、一次媒体、几何与重启配置；R44e 持久化改由 Rust 保存任务拥有（登出/退出不丢），真机退出重启复验未做；其余平台/多屏待验；R68–R71、R76 新增行为未在真实窗口验证（KNOWN_LIMITATIONS B29–B32、B34）** | `test/lyrics-window.test.mjs`、`playback-runtime`、`proxy-settings`；Rust 原子 revision/来源/几何注入测试；browser 面板像素；`.tmp/r44c-native-evidence.json`、`.tmp/r44c-restart-evidence.json` |
| 19 | Windows 任务栏歌词（Beta，精确自窗原生内嵌） | **verified**（+R50–R77：逐字扫亮恢复、独立颜色/字号/逐字设置、不再套卡片底色与边框） | **verified（Windows 单屏 1920×1080 / dpi 96；多屏 `Shell_SecondaryTrayWnd`、高 DPI、自动隐藏、`TaskbarCreated` 重建、长时间 z-order 未验）** | R47 `a62a0ad` 的真实 Explorer 验证：`attached:true`、`GetParent(歌词 HWND) == Shell_TrayWnd (0x20072)`、子窗 `8,1034 680×44`（visible / enabled=false）、槽位像素差分 5235–5394 px 而空段与任务栏按钮区 0、`WindowFromPoint` 17 点全归 Explorer、切回 desktop 后 `underTaskbar=0`、退出无残留（`task-47-report.md`）；`taskbar_lyrics.rs` 的 parent-client/UIA/单在途/代次/退出纯测试 35 条；acceptance 仅新模块限定例外，DLL/全局 Hook 仍禁 |
| 20 | 托盘（9 槽位菜单 / 勾选镜像 / 失败提示） | **verified** | untested | `test/tray.test.mjs`；Rust `tray.rs` 内联测试 |
| 21 | 关窗 fail-safe（托盘真装上才藏窗口） | **verified** | untested | `src-tauri/src/tray.rs` 的 `decide_close` 矩阵；`scripts/acceptance.mjs` 的 `tray` 路径（锚点要求现场查 `tray_by_id`） |
| 22 | 全局快捷键（5 动作 / 备选链 / 失败提示） | **verified** | untested | `src-tauri/src/shortcuts.rs` 21 内联测试；接线变异校验（2 变异各自被专用用例抓到） |
| 23 | 开机自启（读回观测值） | **verified（判定逻辑，假 manager）** | untested（**刻意不写真实注册表**） | `test/autostart.test.mjs`；Rust `commands.rs::apply_autostart` |
| 24 | 系统通知 / 单实例 / 窗口状态 / 日志（四插件） | **verified** | untested | Rust 插件链顺序断言 + 源码扫描（`lib.rs` 内联测试） |
| 25 | 打包链（`build:web` → `dist:sidecar` → `tauri build` + mtime 新鲜度） | **verified** | **verified**（本机真跑通一次） | `scripts/dist-win.mjs`；`test/packaging.test.mjs`（29 条契约测试，含"旧 exe + 新产物 → 必须失败"） |
| 26 | sidecar SEA 打包与自验证 | **verified** | **verified**（本机真的起了两个模式） | `scripts/build-sidecar.mjs`；负向对照（产物 SHA ≠ node.exe） |
| 27 | NSIS 安装包静态校验（8 项） | **verified** | untested（**不执行安装包**） | `scripts/check-nsis-package.mjs`；`test/packaging.test.mjs` |
| 28 | CI 流水线（20 步） | **verified（YAML + 5 条契约测试）** | in-progress（GitHub 上跑过三次，浏览器守卫在运行器上未通过，见 KNOWN_LIMITATIONS F1） | `.github/workflows/windows-nsis.yml`；`yaml.safe_load` 验过；`test/packaging.test.mjs` 的 5 条 CI 契约测试 |
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
| `taskbar-fallback-no-injection`（保留 id） | Windows 内嵌 Beta | 仅新模块获自窗 SetParent，未知停显；禁 DLL/全局 Hook | `lyrics-window` + 文件/符号限定扫描；Rust `taskbar_lyrics_test` 验行为 |
| `settings-persistence` | 设置持久化 | `settings.json` 形状 + DPAPI 会话信封 | `settings-test-proxy` / `session-store` / `settings-page` |

三条口径（写在脚本文件头，这里复述）：**不复制断言逻辑**（引用既有测试，否则漂移的那一份才是假证据）；
**SKIP 不算 PASS**；**锚点缺失要停**（测试文件或锚点文件不见了直接失败并点名，绝不静默跳过）。

---

## 4. 与 API 契约的对应

`docs/API_CONTRACT.md` 是**接口事实与协议的单一真源**，各任务维护自己的那一节，R15 只做核对与增补：

| 契约节 | 由谁落地 | R15 核对结论 |
|---|---|---|
| §1.1–§1.4 OAuth 参数 / authorize / token / 登录域白名单 | R4、**R32** | **R32 换血**：authorize/token 换成参考实测的两台主机（原先把两者都登记在 `oauth-login1` 上）；`scope` 换成用户指令的完整 12 项；补 `countryCode`/`ui_locales`；白名单 = 参考 `LOGIN_HOSTS` 五域 + `loginCallback` 精确例外（`oauth-login1` 整域降级）。§3 的端点字面量仍由 `test/auth-manager.test.mjs` 读契约文件断言，新增 `test/reference-parity.test.mjs` 做逐字差分 |
| §1.5 令牌链环节（`loginex`） | R4、**R17** | R17 增补：`loginex` 从「待联调」升到「端点 + 形状已确认」，证据分三级如实标注；**兑换往返仍未实测** |
| §1.6 `consumeCallback` 宿主契约 | R4 修复轮 1 | 完整 |
| §1.7 登录子窗 ↔ sidecar 线上契约 | R7 | 完整（含 `FrameNavigationStarting` 缺口的如实登记） |
| §2.1–§2.4 业务端点登记 / 注入键 / 响应语义 / CDN 域 | R4、R8、**R32** | **R32 重写**：§2.1 从「端点全部待确认（K1 未消除）」改成「端点与请求/响应形状 = 公开参考实现实测值」，证据分三级（公开来源 / 本机可达性 / 仍未实测）；§2.2 是逐端点表（路径·方法·参数·会话要求·响应容器）；§2.3 收录成功判据（`result.resultCode`）、归一化字段映射、歌单发现必须翻页三条；新增 §2.3.1 播放资源 / §2.3.2 歌词 |
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
npm run release:assets       # 英文文件名的安装包 + 只含它的 SHA256SUMS（上传 Release 用）
npm run smoke:build          # 本机预期 UNTESTED(2)：不是通过
```

受限环境（`%TEMP%` 不可删）下先设好仓内临时目录，理由见
[RUN_AND_PACKAGING.md](RUN_AND_PACKAGING.md) §7。
