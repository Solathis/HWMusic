# API_CONTRACT — 华为云音乐业务接口与 OAuth 事实登记（初版）

> 本文件是**接口事实的唯一真源**：代码里的端点一律由调用方注入，实际值只登记在这里。
> 状态标记只用四档：**已确认**（有可复现证据）、**待确认**（探针无法离线确定）、
> **待 R7 联调**（需要真实账号授权）、**已废弃**。
>
> 初版由 Task R4 建立（2026-10-19）。所有"已确认"项都附了复现命令与证据出处；
> 没有证据的一律写"待确认"，不写猜测值——猜测值一旦进代码就会变成下次事故的根因。

## 0. 证据来源与复现方式

| 探针 | 命令 | 产物 |
|---|---|---|
| 登录链路 | `node scripts/probe-login.mjs --include-token-probe` | `.probe/login-probe.json`（已 gitignore） |
| 音乐业务 | `node scripts/probe-music.mjs` | `.probe/music-probe.json`（已 gitignore） |
| 探针公共设施 | `node --test test/probe-lib.test.mjs` | 保证"正文不入结果、敏感参数值打码"两条红线 |

两条红线（探针自身实现，且有单测钉住）：**不落响应正文**（只留状态码/长度/标题/命中标记/哈希）、
**不落敏感参数值**（`code`/`state`/`token`/`session`/`ticket`/`password` 等的值一律打码为 `***`）。
探针**不登录任何账号、不读取任何私人凭据、不写 cookie**。

## 1. OAuth（华为帐号）

### 1.1 协议参数（已确认 · 出处：任务书/旧仓审计事实，勿改）

| 项 | 值 |
|---|---|
| `client_id` | `101444301`（**非本项目注册的身份**，极可能是华为音乐官方 App 的 OAuth 身份，随时可能失效） |
| `redirect_uri` | `hms://redirect_uri` |
| `scope` | `openid` |
| `access_type` | `offline` |
| `response_type` | `code` |
| PKCE | `code_challenge_method=S256`，`code_challenge = BASE64URL(SHA256(code_verifier))`；verifier 43–128 字符 |
| `state` | 随机、一次性、回调时**常量时间**比对（`timingSafeEqual`）、10 分钟过期 |

代码落点：`src/protocols/auth.mjs`（常量 + `createAttempt`）、`src/protocols/login-callback.mjs`（消费与编排）。

### 1.2 authorize 端点（已确认 · probe 证据）

```
https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize
```

证据（2026-10-19 实测，可用上表命令复现）：

1. 该域对**任意 GET 路径**都返回同一份 SPA 页面（`/oauth2/v3/authorize`、`/oauth2/v2/authorize`、
   `/oauth2/v3/loginCallback` 三者响应字节完全相同：14581 B，`sha256_16=94bf249ba7a6facf`）
   → **单靠 GET 状态码无法区分端点**，路径证据只能来自页面自己的 JS。
2. 授权页 bundle（`/static_rss_vue3/js/index-legacy-*.js`，213575 B）里**逐个列出了端点字符串**，
   其中含 `"/oauth2/v3/authorize"`（注释即"v3 的 authorize 接口"）与 `"/oauth2/v2/authorize"`。
   完整清单见 `.probe/login-probe.json` 的 `bundleEndpoints`（本次 22 条），关键几条：

   | bundle 里的路径 | 判断 |
   |---|---|
   | `/oauth2/v3/authorize` | **本项目使用**（v3 授权接口） |
   | `/oauth2/v2/authorize` | v2 旧版，不用 |
   | `/oauth2/v3/loginCallback` | 回调落点（见 §1.4，导航白名单精确例外） |
   | `/oauth2/v2/loginCallback` | v2 回调，存在但**不放行**（见 §1.4 注） |
   | `/oauth2/ajax/login`、`/oauth2/ajax/getLoginWay`、`/oauth2/ajax/authorizeConfirm` | 官方页自身的 XHR，本项目不用 |
   | `/oauth2/v3/device`、`/oauth2/v3/device/revoke` | 设备码流程，本项目不用 |

### 1.3 token 端点（已确认 · probe 证据）

```
https://oauth-login1.cloud.huawei.com/oauth2/v3/token
```

证据：`POST` 一个**无效**授权码（`code=PROBE-INVALID-CODE`，无任何账号参与）得到

```
HTTP 400  content-type: application/json  {"error":1101,"error_description":"invalid code","sub_error":20152}
```

判读：① 该路径**存在**（`/oauth2/v6/token` 同类请求是 404 HTML 错误页 → 路径不对）；
② 端点**受理了 `client_id=101444301` 与 `redirect_uri=hms://redirect_uri`**（先报的是"授权码无效"，
不是"客户端未注册"）——这是"身份被受理"的弱证据，**不等于**该身份被本项目授权使用；
③ 该端点的错误体是华为自有形态（数字 `error` + `sub_error`），**不是** RFC 6749 的字符串
`invalid_grant`：`src/protocols/auth.mjs` 的错误处理因此只记录 HTTP 状态与 HTTP 层的错误码，不假设字符串错误码。

### 1.4 登录域导航白名单（Node 侧唯一真源：`src/protocols/login-callback.mjs`）

```js
LOGIN_ALLOWED_ORIGINS = [
  "https://oauth-login1.cloud.huawei.com",  // OAuth 授权/令牌服务域
  "https://id1.cloud.huawei.com",           // R16 增补：CAS 门户域（授权页的落地页，见下）
  "https://login.cloud.huawei.com",         // 华为帐号登录（CAS 系，旧域名）
]
LOGIN_ALLOWED_URLS    = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"]  // 精确例外
```

- 是**显式条目表**，不是 `*.huawei.com` 通配（`test/login-parity.test.mjs` 扫源码禁止通配写法）；
- **不放 `oauth-login2`**：换区域主机属显式决策，默认不放行（历史故障正是"漏了某个登录域"）；
- **R16 增补 `https://id1.cloud.huawei.com`（真机"登录窗一片空白"的根因）**：
  `POST /oauth2/ajax/getLoginWay` 的实探响应是
  `loginInteractInfo.cas.casLoginRedirectUrl = https://id1.cloud.huawei.com:443/CAS/remoteLogin?…`
  → 302 → `/CAS/portal/loginAuth.html?…`。授权页（oauth-login1）自身只是个空壳 SPA，它拿到
  `loginType = TICKET` 后就 `location.href = <casLoginRedirectUrl>`；这条导航原先被白名单拦下，
  于是窗里永远停在那个什么都没渲染的授权页上。**端口 443 是默认端口**，`Url::origin()` / `URL.origin`
  归一化后都不带端口，所以一条 `https://id1.cloud.huawei.com` 同时覆盖 `:443` 的写法（两侧测试都钉了）。
  证据：`.probe/qr-probe.json` 的 ①②③ 步（`node scripts/probe-qr.mjs` 可复现）。
- `loginCallback` 例外是"扫码成功后 `hms://` 才会触发"的关键（旧仓历史故障根因：漏掉它 → 停在 CAS 页）；
- 探针实测：`https://login.cloud.huawei.com/` → `403`（域存在，仅拒绝裸请求，属预期）；
- **注**：bundle 里同时存在 `/oauth2/v2/loginCallback`。本项目只放 v3（审计事实点名的那个）。
  R7 联调若观测到回调真的落到 v2，必须**带证据**显式加条目并同步 parity 测试，不得改成通配。
- Rust 侧镜像（`src-tauri/src/login.rs` 的 `LOGIN_ALLOWED_ORIGINS`）与互钉测试已落地：
  改一侧就必须改另一侧 + `test/login-parity.test.mjs` + `src-tauri/tests/login_policy.rs`。

### 1.5 令牌链的后续环节

| 环节 | 状态 | 说明 |
|---|---|---|
| 授权码 → 账号 AT/RT（token 端点，带 `code_verifier`） | 已确认（§1.3） | — |
| 账号 AT → **音乐会话**（旧仓称 `loginex`，请求带 Digest 头） | **端点已确认（R17）；兑换往返仍未实测** | 见下方 §1.5.1：端点 URL、请求形状、Digest 头形状都有公开证据，且**端点存在性经本机实测**（405 / 对照 404 / 无效 AT → 200 + 业务码）；但"有效 AT 换到真会话"要用户授权扫码，本仓**没跑过** |
| 账号 AT 有效期 | 审计事实 ≈ 1 小时 | 未实测；`isTokenExpired` 默认提前 60 秒判过期 |
| 音乐会话有效期 | 审计事实 ≈ 7 天（到期字段提示） | 未实测完整周期；自动续期未打通，失效需重扫 |
| 刷新账号 AT | 已实现（注入端点） | 华为是否轮换 RT 未知；实现按"响应不发新 RT 就沿用旧 RT"处理 |

#### 1.5.1 `loginex`（R17 补全）：证据分三级，逐级如实标注

**① 本机实测（R17，无凭据、不登录账号）**

命令：`.tmp/r17-loginex-live.mjs`（临时探针，结论记在这里；探针只发一个**无效** AT，
与 `scripts/probe-login.mjs` 的 `--include-token-probe` 同一口径）。实测结果：

```
DNS  api-drcn.music.dbankcloud.cn                  → 2407:c080:1400:61:40a0:d51a:7895:e27f（可解析）
404  GET  /__r17_probe_not_a_path__                对照路径：网关错误页（说明下面那两行有区分力）
405  GET  /music-odpapp-service/v5/service/userinfo/loginex         ← 路径存在，只收 POST
200  POST /music-odpapp-service/v5/service/userinfo/loginex  {"result":{"resultCode":"990000","resultMessage":"System error!"}}
       （体 {"accessToken":"PROBE-INVALID-ACCESS-TOKEN"} + 不含 token 的 Digest 头）
401  GET  /music-userbehavior-service/v1/service/favorite/simple/exist  "check user authentication failed"
```

读法：**对照路径 404、目标路径 405/200-with-business-code** —— 这条链有真实的区分力，
证明"路径存在、方法受限、请求被业务受理"。`990000` 是无效令牌的业务码，**不是**"端点不存在"。

**② 公开来源（端点形状 / 请求形状 / Digest 细节）**

来源：公开仓库 `talongao/huawei-music-desktop`（2026-10-18 推送；即本项目文档里反复提到的"旧仓"）
的 `docs/API_CONTRACT.md`（核验日期 2026-10-14）与 `src/auth.mjs`。原文记录的是**该作者本人账号**
的一次成功实验（"账号 Access Token → 音乐 loginex 兑换成功，业务码 `000000`"）：

- **业务域**：`https://api-drcn.music.dbankcloud.cn`
- **端点**（本项目默认值，逐字同一串）：
  `https://api-drcn.music.dbankcloud.cn/music-odpapp-service/v5/service/userinfo/loginex`
- **请求体**：`{"accessToken":"<账号 AT>"}`（Content-Type: application/json）
- **请求头**：`Authorization: Digest username=app-music-baseline, nonce=<每请求随机>, created=<UTC ISO8601，无毫秒>`
  （**不带** token 段；带音乐会话的业务调用才追加 `, token=<音乐 token>`）
- **成功判据**：HTTP 2xx **且** `result.resultCode === "000000"`
- **响应关注**：`result.resultCode`、`token`（音乐会话凭据）、`snsUserID`（音乐用户标识）、
  `expireTime`（已见 14 位 `yyyyMMddHHmmss`；**时区尚未确认**）

本项目据此接线的落点：`src/main/music-session.mjs`（端点常量 + Digest 构造 + 响应解析 + 可注入 fetch），
默认值经 `src/main/auth-manager.ts` 的 `HUAWEI_OAUTH_ENDPOINTS.loginex` 注入。
`expireTime` **刻意不换算**成 `expiresAt`（时区未确认，宁可留原样也不造一个偏 8 小时的"精确"时间戳）。

**③ 仍未实测（本仓 untested，一条不漏）**

| # | 项 | 为什么没验 |
|---|---|---|
| 1 | 用**有效** AT 换到真音乐会话（业务码 `000000` 那一档） | 需要用户授权扫码（用户在场的授权动作），本仓不代扫 |
| 2 | `snsUserID` / `expireTime` 的真实取值与**时区** | 依赖第 1 条 |
| 3 | 该 AT 是否被本客户端（`client_id=101444301`）签发的会被受理 | 依赖第 1 条 |
| 4 | 音乐会话有效期与失效行为 | 依赖第 1 条；自动续期本来就没打通 |

**顺带记录的音乐业务端点**（同为上述公开来源，**本仓一条都没实测**，故不接线）：
收藏 `POST /music-userbehavior-service/v3/service/favorite/simple/all`、播放历史
`GET /music-userbehavior-service/v1/service/recentlyplayed/query`、搜索
`POST /music-search-service/v10/service/fuzzysearch`、播放地址
`POST /music-play-service/v3/service/file/bycontentcode` 等（完整清单见该仓库的契约文档）。
本机对 `favorite/simple/exist` 只做到"401 = 路径存在但要授权"这一步（见上表），
其余路径未逐个探测——**"路径可能存在"不等于"请求形状已确认"**，所以 `data.musicEndpoints`
仍然由设置文档注入、代码里不写死。

### 1.6 宿主契约（R7）：登录窗的导航 URL 如何交给 `consumeCallback`

`src/protocols/login-callback.mjs` 的 `runLoginFlow({host, ...}).consumeCallback(url)` **可以安全地喂进登录窗的每一个导航 URL**：

| 交付内容 | 返回的错误类别 | 是否结算登录流 |
|---|---|---|
| 真回调（`hms://redirect_uri?code&state`，state 相符） | — | ✅ `callback`（成功收场） |
| 授权页明确拒绝（`error=access_denied` 等） | `oauth_error` | ✅ `cancelled` |
| 回调落在 `hms://redirect_uri` 但残缺（缺/重复 `code`\|`state`） | `missing_params` / `duplicate_params` | ✅ `failed` |
| 回调来晚于 10 分钟 | `expired` | ✅ `failed`（真实时钟下计时器通常先结算 `timed_out`） |
| **普通页面跳转**（CAS 页、授权页、`about:blank`、同形钓鱼域） | `not_callback` | ❌ **不结算**，继续等 |
| **state 不符的回调**（陈旧 attempt 的回调、外来注入） | `state_mismatch` | ❌ **不结算**，继续等 |
| 流程已结算后的任何交付 | `already_settled` | ❌（已结算） |

- 终局类别表唯一真源：`LOGIN_TERMINAL_CALLBACK_ERROR_KINDS`（`test/login-callback.test.mjs` 有硬钉 + 穷尽归类断言）。
- **宿主不必先用 `isCallback` 预滤**（预滤也正确，但白名单导航与回调识别是两件事）；
  漏了预滤不会让登录流被一次普通导航杀死——这正是本表存在的理由。
- Rust 侧 R7 若把 `isCallback` 当"必须先调"的前置条件，属于**超出契约的额外要求**，不要在 Rust 里依赖它。

### 1.7 登录页宿主 ↔ sidecar 的线上契约（R7 落地 · R23 换宿主 · R25 铺满整窗）

**宿主形态（R23，用户指令"不开新窗口、在程序中跳转"）**：官方授权页是**主窗里的第二个 webview**
（`tauri::webview::WebviewBuilder` + `Window::add_child`，label `login`），不是独立子窗。
几何是**客户区相对**物理像素（`login::layout_for(客户区读数)`，`x`/`y` 恒为 0），
没有屏幕坐标、没有跨窗换算。

**R25（用户指令"不挤压网页"）**：登录页**铺满整个客户区** `(0, 0, w, h)`——R7–R24 那套
"顶部让出 48 CSS px"的几何**对登录页退役**，`host:open-login` 的载荷里也不再带 `topInset`。
原来落在那条上的两个控件改由**浮动 webview** 承载（同一窗、建在登录页**之后** ⇒ 在 z 序上面）：

| label | 位置 | 内容 | 页面 |
|---|---|---|---|
| `login` | `(0,0,w,h)` | 华为官方授权页（外部 URL） | — |
| `login-return` | 左上角（margin 8 CSS px） | 「返回扫码登录」 | `login-chrome.html?kind=return` |
| `login-theme` | 右上角（margin 8 CSS px） | 浅色 / 深色 / 跟随系统 | `login-chrome.html?kind=theme` |

- 两个浮动控件的盒子**只有控件那么大**（`RETURN_CHROME_SIZE` 124×34 / `THEME_CHROME_SIZE` 184×34，
  CSS 像素 × 缩放比）：透明子窗**仍然会吃掉落在它矩形里的鼠标**，所以"够用就好"是硬约束；
- 背景透明（`background_color(Color(0,0,0,0))` → WebView2 `SetDefaultBackgroundColor` 的 alpha=0），
  页面 `body` 也走 `bg-transparent`；它们与登录页**共用同一个 webview 数据目录**
  （tauri 的 `WebContextStore` 按数据目录缓存环境，见 §变更记录 R25 的出处），随登录页**同生同灭**；
- 浮动控件只许停在应用自己的本地页面上（`login::chrome_navigation_allowed`）：它们的 label 在
  `core_login_chrome` 的允许集合里，被导航到任意网页就等于把那个口子交出去；
- `login-return` **建不起来 = 这次登录结构化失败**（官方页铺满整窗时它是用户唯一的回退路径）；
  `login-theme` 建不起来只是少一个便利入口（留日志，登录照常）。

**R24 追加一条前提**：客户区**量不到**时没有几何——主窗最小化时 `Window::inner_size()` 是 `(0,0)`
（tao 直接 `GetClientRect`），这一档**不许**被钳成 `MIN_LOGIN_WIDTH×MIN_LOGIN_HEIGHT`：
创建路先把主窗恢复（`focus_main`）再量一次、仍量不到就结构化失败，跟随路保持现有几何、
等主窗回来那一 tick 重新摆（三个 webview 一起摆，用的是同一次读数）。
"返回" = 关掉登录页与两个浮动控件（`shutdown_login_view`），主窗一动不动。

**宿主要求（core → 宿主，payload 形状由两侧测试互钉）**

| 频道 | 入 | 出 |
|---|---|---|
| `host:open-login` | `{url, partition}`（R25 起**无** `topInset`） | `{status, url?, message?}`，**在登录页收场之后**才答复（长轮询） |
| `host:cancel-login` | `{}` | `{cancelled: boolean}`（`cancelled:false` = 本来就没有进行中的登录，不是错误） |

`status` 词表（Rust `LoginConclusion::status` ↔ Node `HOST_LOGIN_STATUS`，`test/login-parity.test.mjs` 互钉）：

| status | 含义 | 附带的字段 |
|---|---|---|
| `callback` | 拦到 `hms://` 导航，URL **原样**交回（判真伪是 `consumeCallback` 的事） | `url` |
| `cancelled` | 用户/渲染层取消（浮动控件的 `core_login_chrome {action:"return"}`；`host:cancel-login` 落到同一个结论槽） | — |
| `closed` | 登录页没了（应用退出 / 收尾先行；同窗宿主里用户没有可关的窗） | — |
| `timed_out` | 总期限（10 分钟）到 | `message` |
| `load_failed` | 首载期限（30 秒）内打不开官方页（网络/代理） | `message` |

- 两条期限**文案不同**（处置方式不同）：打不开官方页 vs 扫码超时。文案两侧逐字一致，parity 互钉。
- **双来源**（旧仓缺陷 C1）：Rust 侧"导航拦截"与"登录页消失（每 tick 现问 `app.get_webview`）"
  两条路都能把结论交给等待方；结论槽是 take-once 的（先到者胜、后到者不改写）。只接一条 = "扫码成功却等超时"。
- **登录页零命令权限**：`capabilities/main.json` 的 `windows` 只有 `main`/`lyrics`（不含 `login`），
  且不给登录页注入任何脚本（不订阅 `initialization_script`/`eval`）：白名单与回调**只靠导航事件**观测。
- **来源守卫判 webview label**（R23 的安全性前提）：同窗之后 `window.label()` 对登录页**恒为 `main`**，
  按窗口 label 判来源等于把守卫让给官方页。命令面因此一律取 `tauri::Webview` 并判 `webview.label()`。
  两档守卫：
  1. `commands::require_main_webview`——**只放主窗**，管 `core_call` 与其余 8 条命令（共 9 条）；
  2. `commands::require_login_chrome_source`（R25 增补）——**只放 `main` / `login-return` / `login-theme`**，
     管 `core_login_chrome` 这一条（两个动作：取消登录 / 改主题）。**官方登录页（`login`）不在里面**，
     歌词窗与托盘也不在——放宽 `core_call` 那条守卫等于把全部业务频道交给登录体验的浮动控件。
  第三层：官方页是**远程来源**，`Webview::on_message` 对远程来源一律要求 ACL 条目
  （tauri-2.12.4 `src/webview/mod.rs:2080`），而本应用没有 app 级 ACL manifest、`main.json` 也没有
  `remote` 字段 → 远程来源连自定义命令都到不了（`src/ipc/authority.rs:57-67` 的 `Origin::matches`）。
- **构建代价（如实登记）**：`add_child`/`WebviewBuilder` 在 tauri 2.12.4 里要 `unstable` Cargo feature
  （`Cargo.toml` 已开）。它同时把**每个**窗口的内容 webview 建成 `WindowChild`
  （tauri-runtime-wry `src/lib.rs:4596-4615`），主窗/歌词窗由"自动铺满父窗"改成"显式 bounds + 比例跟随"
  （同文件 `4922-4933`/`4273-4293`）——这是 Tauri 支持的既有模式（`WebviewWindow` 在两种模式下都工作），
  但真机观感需要用户验收（见 `KNOWN_LIMITATIONS.md` B16）。

**登录体验的浮动控件命令（R25 增补）**

```
core_login_chrome {action:"return"}                       → {cancelled: boolean}
core_login_chrome {action:"theme"}                        → {theme: "light"|"dark"|"system"}   （读回）
core_login_chrome {action:"theme", theme:"light"|...}     → {theme: ...}                        （改 + 广播）
```

- 回执是**事实**（不是"已受理"）：取消那条读的就是结论槽是否真的收口了一次进行中的登录；
  改主题那条回的是**实际生效**的档位（落盘失败走结构化错误，不静默改档）。
- 认不出的 `action`/档位一律结构化 `invalid_payload`（不猜）。
- 主题状态归 **Rust** 持有（`settings.json` 的 `theme` 键），改完广播 `theme:changed`
  （`{theme}` 目标态）——主窗与两个浮动控件各自把类落到 `<html>` 上（`features/theme/theme.mjs`）。
  写盘只动 `theme` 一个键、原子替换、**认不出的文件绝不覆盖**（与 `settings.mjs` 同一条纪律）；
  文件不存在时造出来的那份**自带 `closeBehavior` 的默认值**（否则会把它悄悄读成保守值）。

**渲染层 ← sidecar 的登录状态广播（R7 增补的广播频道）**

```
auth:status → {loggedIn: boolean, busy: boolean, message?: string}
```

- 为什么结论走广播而不是 `core_call` 的返回值：渲染层那条调用链（Rust `core_call`）有 60 秒上限，
  而扫码要等好几分钟。`auth:login` **立刻回 `{started:true,...}`**，真正的结论经 `auth:status` 送达。
- 启动期恢复也会广播一条（`{loggedIn:false, busy:false}`）：渲染层还没订阅时由 Rust 的
  `NoticeQueue` 排队，`core_renderer_ready` 时冲刷——"已登录"这个事实不会发进空气。
- **广播答不了"现在的状态是什么"（R19 补上重查通道）**：`NoticeQueue` 的冲刷**只发生一次**，
  渲染层 reload / 崩溃重启之后启动期那一条已经冲刷过了 → 门禁永远停在 `checking`
  （"正在检查登录状态…"）、二维码不发起、且没有任何报错。所以渲染层挂载时会主动
  `core_call(auth:get-status)` 问一次（与托盘可用性查询同款模式：状态由拥有者答），
  应答**与上面这条广播同形状**（同一个载荷构造点）；查询**不触发广播**，
  也**不带 `message`**——那是"刚发生的那件事"，属于广播，快照只答"现在是什么"。

**已知缺口（R7 如实登记，不硬绕）**：wry 0.57（tauri 2.12 的 webview 层）只注册 WebView2 的
`NavigationStarting`（主框架级），**没有** `FrameNavigationStarting`。官方页若从 **iframe** 内部发起
`hms://` 跳转，Rust 侧看不到（顶部框架跳转与 302 都能看到）。关闭它要么等上游提供帧级事件，
要么注入脚本监听——后者是硬边界明令禁止的（登录页零注入）。兜底：总期限仍会收口，不会永久挂住。

**官方登录页的主题（R26 实探 · 可复现 · 结论带边界）**

用户反馈（R26 之 1+2）："切换深色后，嵌入的官方页仍是白色"。**探针先跑，代码照证据落**。

复现：`node scripts/probe-login-theme.mjs`（摘要在 `.probe/login-theme-probe.json`，已 gitignore；
`--no-browser` 只跑公开接口那两段）。**全部请求只碰公开页面与公开接口**：不登录、不输账号、
不提交凭据、不扫码；`state` 是探针自己的一次性串。浏览器那一段用 headless Chromium
（与 `npm run test:browser` 同一套候选），量的是**计算样式**与页面**实际请求了哪一份主题 CSS**。

实探结论（**实测**，2026-10-20，headless Chromium + 公开接口；交付的探针跑 6 条链路变体 +
20 组服务端裁决（10 个 `themeName` 取值 × 2 类 UA）+ 3 档浏览器渲染，另有一轮 8 个候选 UA 的排查）：

| # | 问题 | 实测结果 |
|---|---|---|
| ① | `themeName` 是不是 CAS 门户页的主题开关？ | **是**，但**不是 URL 说了算**：页面第一个脚本 `hwidConfig.js` 会**同步** POST `common/getBaseSwitchInfo`（表单里带 URL 上那个 `themeName`），再用**服务端回的那一份**覆盖 `_hwidFrontEndConfig.themeName`；主题 CSS 链接由 `getThemeFilePath(flowFilePath, null)` 按这个值拼出 `.../vuebuild/css/login/portal/index-<theme>[-small].css` |
| ② | 桌面 UA 下服务端认哪些值？ | 只认 **{red, huawei, blue, lightred}**；`dark`/`harmonydark`/`harmony`/`DARK`/`0x01`/乱写**一律回落 `red`**（`index-dark-small.css` 本身 HTTP 200 存在，说明卡在**服务端裁决**而不是资源缺失） |
| ③ | 那"跟随系统"呢？（`prefers-color-scheme`） | **无效**。页面脚本在没有 URL 参数时确实会用 `matchMedia("(prefers-color-scheme: dark)")` 推出 `dark` 去问服务端——服务端照样回落 `red`；而且三份主题 CSS 里都写着 `@media (prefers-color-scheme: dark){.hwid-html-portalBg,.hwid-body-background{background-color:#fff}}`（深色系统下**强制白底**） |
| ④ | `themeName` 加在 **authorize 请求**上会传播吗？ | 会传播到 `/CAS/remoteLogin`（实测原样带上 `dark`/`huawei`/乱写值），**但 `302 → /CAS/portal/loginAuth.html` 那一步被服务端归一化回 `red`**（`huawei` 能过）——所以"加参数"这条路到不了深色 |
| ⑤ | 有没有能拿到深色的 UA？ | 只有 **HarmonyOS 移动 UA**（服务端认 `dark` → 页面真的加载 `index-dark.css`，实测 body/root 背景 `rgb(0,0,0)`；同一个 UA 下它认 `harmony`/`harmonydark`，不认识的值回落 `huawei`；桌面 UA 则一律回落 `red`）。但那个 UA 会让页面按 `isMobileWap()`（`/android|mobile|iphone|ipad|hwid_clienttype=hmos|tablet/i`）换成 `login/mobile/index`——**移动版登录页**（手机号/邮箱 + 短信验证码/密码表单，8 个输入框 vs 桌面门户的 18 个），不是现在这套桌面门户版式；8 个候选 UA 里没有一个能"服务端认深色而版式仍是桌面门户" |

**落点（R26 选型：只做机制，不伪装 UA——用户裁决）**：
1. **三态映射**（`login::login_theme_name`）：`dark` → `themeName=dark`；`system` → 主窗 `Window::theme()`
   读一次系统深浅（读不到按浅色，保守一侧）；**`light` → 不动这个参数**（服务端桌面默认就是浅色
   （实探 `red`），显式写 `huawei`/`blue` 会把用户现在看到的观感换成另一套浅色，是没人要过的变更）；
2. **打开时挂上**：`host:open-login` 落进 `open_login` 时按当前主题把参数挂到那条授权 URL 上
   （白名单校验在先：多一个查询参数不改变 origin/path）；
3. **切主题时重载**：`theme::set_theme` 改完并广播之后调 `login::reapply_login_theme`——把**已经开着**的
   登录页导航到"同一条 URL + 新 `themeName`"（值没变就不重载；目标不在白名单里不重载；另起线程做，
   因为同步命令在主线程上，dispatcher 往返不能在那儿等）。**不做**系统主题的实时监听（打开时取一次）。
4. **今天的结果如实说明**：桌面 UA 下服务端仍然回落 `red`，所以"深色档"目前**看不到深色官方页**——
   这条通路是唯一一条（服务端哪天放开桌面 UA，代码一个字都不用改），现状登记在
   `docs/KNOWN_LIMITATIONS.md` B18。

**未实测（如实登记）**：真窗上"切主题之后官方页重载一次"的观感（本环境起不了真窗）、
真实登录链路上这条参数的影响（需要真实账号；探针只到公开页面为止）。UA 伪装那条路**没有采纳**，
因此也不在验证清单里。

**未联调（untested）**：真实扫码登录（需要用户在场 + 真实账号）、音乐会话兑换（loginex，见 §1.5）、
`tauri dev` 真窗验证（本环境的子进程沙箱里应用起不来：`tauri-plugin-log` 初始化 `os error 5`）。

### 1.8 二维码（DimensionalCode）登录协议（R16 实探 · 可复现）

用户指令要求引导页**直接显示二维码**而不是"打开官方页"按钮流，所以 R16 把华为的二维码登录链
完整探了一遍。**全部证据来自公开页面**：不登录账号、不提交凭据、不扫码；探针自己建的二维码会话
用完即弃，因此拿不到任何可用凭据。

复现：`node scripts/probe-qr.mjs`（摘要落 `.probe/qr-probe.json`，已在 .gitignore）。

**① 找到二维码配置的那条链**（桌面门户不下发二维码配置，移动登录页才下发）：

| 步 | 请求 | 关键响应 |
|---|---|---|
| 1 | `POST https://oauth-login1.cloud.huawei.com/oauth2/ajax/getLoginWay?reflushCode=…&display=page`（头 `interfaceVersion: v3`、`fromLoginAuth: false`；表单 = 授权页查询串） | `loginInteractInfo.cas.casLoginRedirectUrl`（**对 client 101444301 一律是 TICKET/CAS 跳转**，没有 `loginType=CAS_JS_SDK` 那条路） |
| 2 | `GET <casLoginRedirectUrl>` | `302` → `https://id1.cloud.huawei.com:443/CAS/portal/loginAuth.html?…` |
| 3 | `GET /CAS/mobile/standard/login.html?<同一串参数>` | `200`（页面本身只是壳） |
| 4 | `POST https://id1.cloud.huawei.com/CAS/IDM_W/ajaxHandler/login/getPageInfo?reflushCode=…&cVersion=UP_CAS_6.26.3.100`（表单 = 上一步 URL 的参数 + `pageName=login` + `urlParam=…` + `languageCode`） | 顶层 `pageToken` / `pageTokenKey`；`localInfo.service`（**带本次 `state` 的 loginCallback URL**）、`loginUrl`、`reqClientType`、`loginChannel`、`lang`；**`localInfo.getqrContent` / `asyncURL` / `qrcodeRequestInterval` 只在这张移动页上出现** |

- **桌面门户（`/CAS/portal/loginAuth.html`）实测 `isQrlogin:false` 且不下发那三个二维码配置**——
  这不是"华为没开二维码"，而是"桌面门户那条路不渲染二维码组件"；移动登录页的
  `localInfo.isOpenDimensionalCode = true` 并给出完整配置。
- `getPageInfo` 的 `pageToken` 只对**换码**那一步有用（见 ③）；建单/轮询（②）**完全无状态**：
  实探证明不带任何 cookie、甚至用一个假 `qrToken` 也照样返回同一个 `103000200`。

**② 建单 / 轮询（两步都已实测跑通）**：

```
建单  POST https://id1.cloud.huawei.com/DimensionalCode/getqrInfo
          ?appID=com.huawei.hwidweb&loginChannel=7000700&reqClientType=700
          &confirmFlag=1&version=40200&appBrand=HUAWEI
      表单 {appID, confirmFlag, version, reqClientType, loginChannel, appBrand}（可带 deviceID/deviceType）
      → {content, qrCode, qrToken, sessionID, qrCodeCreateTime, expiredTime, version:"40200"}

轮询  POST https://id1.cloud.huawei.com/DimensionalCode/async?version=40200&t=<随机数>
      表单 {qrToken} → {resultCode, errorDesc}
```

| `resultCode` | 含义 | 实探 |
|---|---|---|
| `0` | **已确认**（响应携带 `userAccount`/`code`/`userID`/`siteID`/`accountType`/`opType` 等） | 未能观测（需要真人扫码 + 手机确认） |
| `103000202` | 已扫码，等待手机确认 | 未能观测（同上） |
| `103000201` | 二维码过期 | 未能观测（有效期 181 秒内没等到） |
| `103000200` | **未扫 / 会话未就绪**（服务端原话 `errorDesc: "Please to login."`） | ✅ 实测（连续 3 次轮询都是它） |
| 其它 | 页面按"继续轮询"处理 | — |

- `content`（**要编码进二维码的字符串**，实测 174 字符）形如
  `https://id1.cloud.huawei.com/qrcode/login.jsp?loginChannel=…&reqClientType=…&qRCode=…&qrSiteID=…&familySharing=…&appBrand=HUAWEI`；
  实探里 `expiredTime - qrCodeCreateTime = 181_000 ms`（二维码有效期 ≈ 3 分钟）。
- 轮询间隔由服务端给：`qrcodeRequestInterval = 2000`（ms）。
- `qrToken` 是会话令牌：**只在 sidecar 内使用**，不进广播、不写日志（`auth:qr` 只带 `content`）。

**③ 已确认 → 换授权码（形状来自页面 bundle，**未实测**）**：

```
POST https://id1.cloud.huawei.com/CAS/IDM_W/ajaxHandler/codeRemoteLogin?reflushCode=…&cVersion=UP_CAS_6.26.3.100
表单 {pageToken, pageTokenKey, loginUrl, reqClientType, service, loginChannel, lang, appID,
      userID, siteID, accountType, code, qrCode, userAccount, opType}
→ {callbackURL}      // = loginCallback URL（带 code，与扫码开窗那条链落到同一个地方）
```

这条链的**每一步都读自页面自己的代码**（`/CAS/static_rss/green/rss_20260904/CAS/vue3/vuebuild/js/login/portal/`
的 `qrCodeLogin-legacy.js` 与 `index-entry-legacy.js`；`getqrContent`/`asyncURL` 只作为**服务端配置值**出现，
bundle 里没有任何硬编码的二维码端点字符串——这也是"必须走 getPageInfo 拿配置"的原因）。
**未实测的边界**：`codeRemoteLogin` 需要一次真实的"扫码 + 手机确认"，那是用户在场的授权动作
（本任务交付到"轮询状态机就绪"）。失败时是结构化错误（`qr_confirm_failed` + 服务端 `errorCode`），不猜。

**本项目落地位置**：`src/protocols/qr-login.mjs`（状态机，端点注入）、`src/main/qr-login.mjs`
（探针确认的端点常量 `HUAWEI_QR_ENDPOINTS` + CAS 换码链）、`auth:qr-start` 请求频道、
`auth:qr` 广播频道、渲染层 `login-gate.tsx`（画法在 `features/auth/qr-canvas.mjs`，库为 `qrcode`）。

**R18 增补（两条路的互斥，用户指令）**：
- 引导页有一个**常驻**的次要入口「在网页中打开登录」（`WEB_LOGIN_ENTRY_TEXT`），走既有
  `auth:login` → R7 官方登录子窗；它与二维码流**互斥**：
  - `auth-manager.login()` 在开窗**之前**调 `stopQrSession()`：停轮询 + 作废当前 `qrAttempt`，
    **不广播**（紧接着就播 `busy:true`；多播一条 `busy:false` 会被渲染层读成"网页那条路已收场"）；
  - 迟到的二维码确认（用户改走网页那条路之后手机才点了确认）在 `onConfirmed` 里按
    `qrAttempt !== attempt` **丢弃**：不换码、不广播（否则一次作废的会话会多换一次码）；
  - 网页那条路收场（`auth:status` 落 `busy:false` **且带一句给人看的话**）→ 渲染层回到二维码态、
    重新武装自动发起（`officialNote` 记一句"它为什么结束了"，新码到达后退场）；
  - 二维码**不占** `busy`（`startQrLogin` 不再播 `busy:true`）：`busy` 只描述"开窗那条路正在跑"，
    否则常驻入口会在整个等扫码期间被 `disabled`。
- 过期自动换新曾是 sidecar 的事（协议层 `createQrSession` 的 `expired → create()` 重建），
  渲染层只是"内容变了就重画"；像素级的全链证据在 `test/qr-render.test.mjs`。
  **R21 已按用户指令推翻这条**：`expired` 只广播、停轮询、不建新单，换新改为用户手动点击
  （见下面的 R21 段）。

**R20 增补（过期档位实测 + 手动刷新语义，用户真机验收反馈）**：

过期档位 `103000201` 一直是"未观测"档，R20 把它**测出来了**（可复现：
`node scripts/probe-qr.mjs --until-expired`，摘要 `.probe/qr-expiry-diag.json`，只碰公开端点与自建
二维码会话，不扫码、不登录）：

| 观测 | 值 |
|---|---|
| 建单 TTL（`expiredTime - qrCodeCreateTime`） | `181_000` ms |
| 轮询间隔（实测每次请求往返） | 服务端配置 `2000` ms；实际每次轮询请求约 `8.2` s，故实测节奏约 `10` s 一次 |
| 过期前的档位 | `103000200`（"Please to login."）——最后一次在 t+169.1 s |
| **过期档位** | **`103000201`，t+177.4 s 观测到**（`stoppedBecause: tier_changed`） |
| 过期后重新建单 | HTTP 200 + 全字段（`content`/`qrToken`/`qrCode`/`expiredTime`），新会话 token 与旧的不同 |

→ **poll 不是"静默挂"**：服务端到点就改档位，所以 R20 当时把"过期 → 自动换新"这条链
建立在真凭据上，并且**不引入**"本地按 `expiresInMs` 主动换新"的回退；真机"过期了却没有提示"
的根因在**渲染层**（旧码留在屏上 + 那句提示被紧随其后的新 `pending` 顶掉），
修法见 `src/renderer/features/auth/login-gate-logic.mjs` 的 R20 三条。

**R21 按用户指令推翻自动换新**（下面这一段的"自动"部分即由此作废；实测数据不变）：

- **sidecar**：`expired` 变成一条**终点**广播——`stop()`（停轮询、清总期限计时器）+ 只播
  `expired`，**不再 `create()` 新单**。换新只剩手动一条：渲染层再发一次 `auth:qr-start`，
  而 `createHuaweiQrPort.start()` 本来就是 restart 语义（这一条 R20 立的语义原样保留）；
- **渲染层**：新增**秒级倒计时**（`expiresInMs` 由建单应答与 `auth:qr` 广播带过来，换算成
  本地到期时刻显示在二维码下方）。**过期判定仍以服务端 `expired` 广播为权威**：本地数到 0
  只说「正在确认过期…」，既不撤码也不改档（服务端实测在本地归零前就给 `103000201`）；
- **过期态不可扫**：`expired` 到达撤下 canvas（R20 的裁决继续成立），原位写「二维码已过期」，
  状态行说「二维码已过期，点击刷新。」，并多出一个显著的「刷新二维码」按钮
  （`QR_REFRESH_ACTION_TESTID`）——它与二维码容器、与自动发起走同一个 `startQr`；
- R20 的 `qrNotice` / `QR_REFRESH_NOTICE`（「二维码已刷新，请重新扫码。」）**整条删除**：
  不再自动换新，就没有"刚换过一张"这一刻。
- 钉在：`test/qr-login.test.mjs`（过期 = 终点档 + 手动重启）、`test/qr-port.test.mjs`
  （过期不建单、手动 start 之后换码带当前那张的 `qrCode`）、`test/login-gate.test.mjs`
  （倒计时/归零/只手动刷新）、`test/login-gate-markup.test.mjs`（真 SSR 标记）、
  `test/qr-render.test.mjs`（像素全链）。

同轮登记两处 **sidecar 语义**（`auth:qr-start` 的手动刷新 = 活动会话期间重启，渲染层点二维码容器）：

- `createHuaweiQrPort.start()` **天然就是 restart**：先 `session.cancel()` 再建新会话
  （新 `qrToken`/`qrCode`），所以"再调一次 `auth:qr-start`"就是换一张新码；
- 迟到的旧会话事件按**身份**丢弃（`session !== mine`，含"确认之后换码"那条异步尾巴）：
  旧码那次在飞的轮询落地时不许把界面上那张新码顶掉；协议层另有一道 `running` 复检
  （见 `src/protocols/qr-login.mjs` 的第五条规矩）；
- 换码链读的是**当前**那张的 `qrCode`（`session.current()`）而非建单时的快照：过期换新之后
  旧 `qrCode` 已作废，拿它去 `codeRemoteLogin` 只会白跑一趟（R20 修；R21 起"换新"= 用户手动
  `start()`，这条结论不变——过期之后端口不再自动换新，所以它手上那张一直是作废的，
  而 `confirmed` 不会再从一条已停的会话里冒出来）。

**R22（用户真机反馈两项：① 倒计时到 0 后卡在「正在确认过期…」**一直不过期**；② 过期时间正确性）**
在协议层落三件事，**渲染层一行未改**（简报的 C 项）。R21 那句"服务端通常在本地归零前就给
`103000201`"由此从"通常"变成"不依赖"——现在**不依赖**服务端准时说话：

1. **TTL 无偏差换算（根因 ②）**：`expiresInMs = expiredTime − qrCodeCreateTime`——两个都是**服务端值**，
   相减得到服务端自己的 TTL，与本地钟偏多少无关。老公式 `expiredTime − 本地 now()` 是拿服务端纪元减
   本地钟，本地快 1 小时就得到 `0`（倒计时一上来就归零，界面立刻变成「正在确认过期…」——**这正是用户
   反馈 ① 的现场**），慢 1 小时则多算出 63 分钟。RED 实测（`parseQrCreate` 注入偏钟）：±1 小时 →
   旧公式 `0` / `3781000`，新公式恒为 `181000`。`qrCodeCreateTime` 缺失/非法 → **回退**老公式
   （**已知偏差风险**：那条路径下倒计时随本地钟平移，见 §3 的 `QR_TTL_*` 那一行）；`expiredTime`
   本身不可信，或两个服务端值**互相矛盾**（`expiredTime ≤ qrCodeCreateTime`）→ `null`（不猜：
   界面少一行倒计时，比显示一个不准的数好）。
2. **卡死的三层修（根因 ①）**：
   - **未知码熔断**：认不出的 `resultCode` 仍按"继续等"处理，但**连续 5 个**
     （`QR_DEFAULT_MAX_UNKNOWN_CODES`）→ `failed`（`errorKind: "unknown_result_code"`，文案带上那颗码）
     + 停轮询。RED 实测：修前连着 5 个陌生码会话**仍在轮询**（`isRunning: true`）——协议真变了就是
     "一直打到总期限"，用户全程看着一张不会变的界面；
   - **本地到期权威兜底**：`expiresAtLocal = 建单响应落地时刻 + 服务端 TTL`（取"落地"不取"发出"：
     最多晚一个往返，而**晚判是安全的一侧**——早判等于撤掉一张其实还能扫的码）。轮询时若
     "锚 + 15 秒宽限（`QR_LOCAL_EXPIRY_GRACE_MS`）"已过、而服务端**什么话都没说**
     （`103000200` / 响应缺 `resultCode` / 陌生码，或轮询请求本身失败）→ **主动转 `expired`**
     （停轮询 + 广播 + 日志留一行说明）。**服务端一律优先**：它给出 `expired`/`scanned`/`confirmed`
     时兜底让位（`scanned` 是"会话还活着"，此时把会话判死 = 用户手机上那句确认按下去没有着落）；
     建单没给出可信 TTL（`expiresInMs === null`）时**不设锚点**、一次都不主动判过期（不猜）。
     界面由此**必有出口**：倒计时数到 0 之后最长 15 秒，「正在确认过期…」从"罕见兜底"变成"有上界的等待"；
   - **轮询诊断日志**：**每轮一行** `二维码轮询 #N：resultCode=…`（认不出的码带"连续 n/5"），
     **脱敏**——只有轮次与状态码，`qrToken` / 二维码内容 / cookie 一律不进日志。落点是端口注入的
     `log`（sidecar 默认 `console.error` → **stderr**，`src/main/auth-manager.ts` 的 `defaultLog`）。
3. **渲染层未改**：`expired` 那一档的处理（撤码、原位「二维码已过期」、状态行「二维码已过期，点击刷新。」）
   R21 就在了；兜底只保证它**必达**。倒计时显示不变（仍是"到期时刻 − 渲染层的钟"，只是喂进去的
   `expiresInMs` 现在不再被本地钟污染）。

钉在：`test/qr-login.test.mjs`（TTL 双路径 + 矛盾值 → `null`；熔断边界 5、中间认出一个码即归零、
阈值可注入；兜底边界 锚前不触发 / +14.999s 不触发 / +15s 触发 / 服务端先到优先 / `scanned`·`confirmed`
让位 / 无 TTL 不设锚 / 网络失败也出口；诊断日志每轮一行且不含 `qrToken` 与内容）、
`test/qr-port.test.mjs`（本地钟快 1 小时时交给渲染层的 `expiresInMs` 仍是 `181000`；诊断日志经端口
落到注入的 `log`）。**仍未验证**：真机上这两个现象是否真的消失——需要一次真会话（等 181 s）与
一次偏钟环境，由用户/控制器在能起窗的场所验（见 `docs/KNOWN_LIMITATIONS.md` B14）。

## 2. 音乐业务接口

### 2.1 结论：**端点全部待确认**（K1 风险未消除，如实登记）

| 探测对象 | 结果 |
|---|---|
| `https://music.huawei.com/` | **ENOTFOUND**（域名不解析，不是 403/404） |
| `https://api.music.huawei.com/`、`https://music-api.huawei.com/`、`https://msc.appmusic.huawei.com/` | 均 **ENOTFOUND**（候选，均不存在） |
| `https://www.huawei.com/` | 200，但其脚本（require/jquery/bootstrap/common）**不含任何业务接口线索** |
| 公开入口页脚本里的 API 候选 | 0 条 |

→ 业务接口只能靠**授权联调**或用户在场的授权 probe 确定。因此
`src/protocols/music.mjs` 采纳**端点注入式**设计：`createMusicApi({endpoints})`，
未注入的端点返回结构化 `endpoint_unknown`，**不写任何猜测 URL**（测试扫描源码禁止出现
huawei/dbankcdn 等域名）。

### 2.2 注入契约（端点键名 —— 调用方必须提供）

| 键 | 用途 | 状态 |
|---|---|---|
| `favorites` | 收藏列表分页 | 待确认 |
| `playlistList` | 自建歌单列表 | 待确认 |
| `playlistDetail` | **歌单曲目（R8 增补）**：与歌单列表分开——列表只有元信息，曲目要单独取 | 待确认 |
| `playlistDelete` | **自建歌单删除（必须用这个，不能用收藏端点）** | 待确认 |
| `search` | 搜索 | 待确认 |
| `album` / `artist` | 专辑 / 歌手详情与曲目 | 待确认 |
| `history` | 播放历史 | 待确认 |
| `playback` | 播放地址（含试听信息） | 待确认 |

值必须是 `https://` URL；同时 `queryNames` 表集中了请求参数名（`page`/`pageSize`/`keyword`/`id`），
默认值同样是**待确认**的占位：真实参数名确定后只改这一处。

会话凭据由 R7 通过 `sessionHeaders()` 注入（默认不带任何凭据）。**账号 AT/音乐会话不落盘、不进日志。**

### 2.3 响应语义（实现已按审计事实固化，形状细节待联调）

| 事实 | 状态 | 实现处置 |
|---|---|---|
| 响应信封含业务错误码（`code`，`0` 为成功） | 待确认 | `decodeEnvelope` 宽容处理：`code` 缺省视为成功，非 0 → `api_error`（带码与 ≤200 字说明，不回显整段响应体） |
| 列表容器字段名不定 | 待确认 | `extractList` 依次尝试 `list/items/songs/records/tracks`，取不到给空数组 |
| 歌曲 ID 字段名不定 | 待确认 | `trackIdOf` 依次尝试 `id/songId/musicId/resourceId/trackId`；都没有的条目**如实丢弃并计数**（不编 ID） |
| **收藏无直接总数字段** | 审计事实 | 总数 = **完整分页后 ID 去重**；接口若上报 `total`，只作 `reportedTotal` 记录，绝不当真值。`total` 只在分页走完（`stopReason="exhausted"`）才有值，未走完为 `null`；"已加载 N 首"用 `loadedCount`（R8 的 UI 必须分开显示） |
| playback **顶层 `fileURL` 才是音频** | 审计事实 | `parsePlaybackPayload` 只认顶层 `fileURL`；缺失 → `invalid_response` |
| `fileInfos` 可能是 JSON 字符串 | 审计事实 | `parseFileInfos` 解析失败不抛：降级为 `null` 并记 `file_infos_unparsable` 警告，不影响出音频地址 |
| **`auditionTime` 不能单独判 30 秒试听** | 审计事实 | `classifyAudition` 要求**两个信号齐备**（`auditionTime > 0` **且** 标志位命中）才判 `auditionLikely`；标志位候选表 `DEFAULT_AUDITION_FLAG_KEYS` 可覆写 |
| 自建歌单删除必须 `playlist/delete` | 审计事实 | `deletePlaylist` 只打 `playlistDelete` 端点，且测试断言"绝不走收藏端点" |
| 播放地址必须落在 CDN 白名单 | 本项目约束 | 非白名单域 → `unsafe_media_url`（渲染层反正加载不了，早报错） |

### 2.4 CDN 域（已确认可达）

| 域 | probe 实测 | 用途 |
|---|---|---|
| `*.dbankcdn.cn` | `https://www.dbankcdn.cn/` → 200 | 封面 / 音频 |
| `*.tingmall.com` | `https://www.tingmall.com/` → 200 | 封面 / 音频 |
| `*.kuke.com` | `https://www.kuke.com/` → 200 | 封面 / 音频 |

这三个后缀是 `src/protocols/safe-media-url.mjs` 的白名单，与 `src-tauri/tauri.conf.json` 的 CSP
`img-src`/`media-src` **同源**，一致性由 `test/safe-media-url.test.mjs` 解析 CSP 行钉死。

### 2.5 主界面 ↔ sidecar 的数据通道（R8 落地）

渲染层到 sidecar 的 `library:*` 七条请求频道（白名单唯一真源 `src/shared/request-channels.ts`，
Rust 镜像见 §3 的 parity 钉）：

| 频道 | 载荷 | 应答 `data` | 说明 |
|---|---|---|---|
| `library:favorites` | `{page, pageSize}` | `{page, pageSize, songs, skipped, reportedTotal, hasMore}` | **应答里没有 `total`**：收藏没有可信总数，总数由渲染层把页拼完后去重得出，未走完就是"已加载 N 首" |
| `library:playlists` | `{page, pageSize}` | `{playlists, hasMore}` | 歌单元信息 |
| `library:playlist-detail` | `{playlistId, page, pageSize}` | `{songs, hasMore}` | 走 `playlistDetail` 端点；缺 `playlistId` → `invalid_payload` |
| `library:search` | `{keyword, page, pageSize}` | `{songs, hasMore}` | 空关键字 → `invalid_payload`（不把坏参数透给协议层） |
| `library:album` / `library:artist` | `{albumId}` / `{artistId}` | `{songs, detail}` | 缺 id → `invalid_payload`；`detail` 是端点的原始回包（`getAlbum`/`getArtist` 原样透出，供后续页面取专辑/歌手元信息） |
| `library:history` | `{page, pageSize}` | `{songs, hasMore}` | 播放历史 |

**端点注入点**（R8 新增，取代"没有写入方"的状态）：设置文档 `data.musicEndpoints`，
键名 = §2.2 的端点键，值必须是 `https://`。`src/main/music-service.mjs` 只收已知键与非空字符串
（陌生键/空值一律丢弃），**现在仍是空表** → 每个库页面请求都由协议层如实回
`endpoint_unknown`，UI 显示"接口尚未配置（待联调确认）。"。这是设计落点：宁可说"没配"，
也不给出一个看起来是空的收藏夹。

**渲染层的三态纪律**（`src/renderer/features/library/library-state.mjs`，由测试钉住）：
加载中 → 骨架屏；失败 → `endpoint_unknown` 说"未配置"、其余类别说人话；真的空 → 一句空态。
**失败绝不复用空态文案**——那会把"连不上"说成"你什么都没有"。

**尚未接线**：`sessionHeaders`（会话凭据注入）没有接——端点未确认前猜 header 名是空转；
音源/封面链路（CSP `img-src`/`media-src` + CDN 白名单）也留给联调后的任务。

### 2.6 播放器 ↔ sidecar 的通道（R9 落地）

| 频道 | 方向 | 载荷 | 应答 / 语义 |
|---|---|---|---|
| `playback:resolve-url` | 渲染层 → core（请求） | `{trackId}` | `data` = `parsePlaybackPayload` 的产物 `{url, fileInfos, format, size, bitrate, duration, auditionLikely, signals, warnings}`；缺 `trackId` → `invalid_payload`；端点未配置 → `endpoint_unknown`；地址不在 CDN 白名单 → `unsafe_media_url`（文案只带域名） |
| `player:command` | core → 渲染层（广播） | `{command}`，取值 `play`/`pause`/`toggle`/`next`/`previous` | R9 **预登记**、R11 起**真的有人在发**（Rust 侧托盘的播放三项：`toggle`/`previous`/`next`）；渲染层 `features/playback/player-commands.mjs` 执行，认不出的命令回结构化 `invalid_command`，**拒绝且不猜** |

**播放地址的四条纪律**（R9 裁决，逐条在测试里钉住）：

1. 地址只作**当次**播放结果交给渲染层：不写日志（处理器与运行时都没有日志出口）、不落盘、不缓存
   （可能带时效签名，缓存它等于把"这一次能用"变成"以后也能用"）；
2. 渲染层拿到后**还要再过一次** `safe-media-url`（渲染层唯一允许引用协议层的地方是
   `features/playback/media-url.mjs`），不放行就不装载；状态机的 `guardUrl` 是**必填参数**，
   缺了直接抛——"忘了校验"不是一种可能的写法；
3. 地址**不进状态**：状态机快照里只有 `loaded: boolean`（测试断言快照序列化后不含 `http`/CDN 域），
   所以 UI 与日志都拿不到它；
4. 失败文案不回显整段地址（协议层只给域名），且失败类别原样透传
   （`endpoint_unknown` 就是"接口没配"，不会被改写成"这首歌放不了"）。

**队列持久化**（R9 裁决：只存曲目标识 + 当前索引）：

```json
{ "schemaVersion": 1, "data": { "queue": { "ids": ["1001", "1002"], "index": 1 } } }
```

- 键名 `QUEUE_SETTING_KEY = "queue"`（`src/renderer/features/playback/queue.mjs`），
  写入走 `settings:set` 的 `{patch: {queue: …}}`；`queue: null` = **删除该键**（§2.5 的既有语义）；
- 记录**结构上只有 `ids` 与 `index` 两个键**：不存播放地址（纪律 1）、不存标题/模式
  （裁决没让存；恢复出来的队列只有标识，界面如实显示"曲目 &lt;id&gt;"）；
- 反向同样严格：任何输入都洗不出第三个键（手工改坏的 `settings.json` 带 `url` 也进不来）；
- 恢复**不自动播放**：只还原队列与索引（没有用户手势的自动出声既打扰又会被浏览器拒绝）。

**Media Session**：浏览层能力（`features/playback/media-session.mjs`），不涉新权限、不起新窗口。
元数据只有标题/艺人（**不放封面**：字段未确认），状态映射 `playing→playing`、
`paused/loading→paused`、其余 `none`；环境没有这个 API 时静默降级（不报错）。

**尚未接线（如实登记）**：

1. **歌词来源**：解析适配（`features/lyrics/amll-adapter.ts`：`[offset:]` 补偿 + 翻译行合并）、
   进度同步（`features/lyrics/lyric-sync.mjs`）与 AMLL 面板宿主在本任务交付；
   **歌词文本通道由 R12 接上**（`playback:lyrics`，见 §2.9）——所以在 R9 那两个提交里
   面板如实显示"歌词来源尚未接入。"，而 R12 起改口为"歌词来源尚未配置。"（频道已接，
   缺的是端点）。这不是改文案了事：五档状态与两句失败文案的区分见 §2.9。
2. **封面/背景图**：曲目投影里没有封面字段（未确认），且 AMLL 对**字符串**地址会自己
   `fetch` 成 blob（`connect-src` 只有 `'self' ipc:`，会被 CSP 拦）。要接通得先用 `<img>`
   （`img-src` 白名单）加载再把 `HTMLImageElement` 传进 `BackgroundRender`。
3. **音质/试听标注**：`auditionLikely` 已在协议层算出，UI 本任务不显示（不虚标音质）。

### 2.7 设置页 ↔ core / 外壳（R10 落地）

**请求频道增补一条**（白名单唯一真源 `src/shared/request-channels.ts`，Rust 镜像见 §3 的 parity 钉）：

| 频道 | 载荷 | 应答 `data` | 说明 |
|---|---|---|---|
| `settings:test-proxy` | `{proxy:{enabled,host,port,username,password,bypass}}` | `{result}` | `result` 即 R6 `testProxyConnection` 的结构化结论（`{ok,ms,status}` 或 `{ok:false,error:{kind,message}}`）。**目标 URL 由 core 侧的固定常量 `PROXY_TEST_URL` 决定**（`https://oauth-login1.cloud.huawei.com/`，R4 已确认可达的官方授权主机根路径）——不接受调用方指定，否则等于把一个能带凭据出去的代理塞进渲染层手里；业务端点仍待联调，**不猜**。凭据原样进测试器（不然测的是另一个代理），但**答复文案与日志里一个字都不回显**，坏载荷那条路也不回显（`{proxy:null,password:"…"}` 有专门用例） |

**tauri 命令增补两条**（名字的唯一真源 `src/shared/commands.ts`；Rust 侧镜像由
`test/autostart.test.mjs` 扫描 `commands.rs` 与 `generate_handler!` 钉住）：

| 命令 | 载荷 | 回执 | 说明 |
|---|---|---|---|
| `core_set_autostart` | `{enabled: boolean}` | 观测到的实际状态（`boolean`） | 写完**回读** `is_enabled`：请求被受理 ≠ 真的打开了（Windows 上是 `Run` 键写入）。界面开关跟着观测值走——乐观翻转会在写入失败时显示一个不存在的"已开启" |
| `core_get_autostart` | 无 | 当前状态（`boolean`） | 设置页挂载时读一次；读不到就如实显示"状态未取到"并禁用开关（不猜） |

两条命令都过**主窗来源守卫**（`require_main_webview`，R23 起判 **webview label**）：
登录页/歌词窗/托盘改不了系统自启。

**权限裁决（Tauri 2.12 语义，已逐行核对源码）**：自定义命令**不进 capabilities**。
`tauri::Webview::on_message`（tauri-2.12.4 `src/webview/mod.rs:2080`）只在三种情形查 ACL——
命令名带 `plugin:` 前缀、应用定义了 app 级 ACL manifest（`tauri-build` 在 `app_manifest` 带
commands 或 `src-tauri/permissions` 非空时才写入 `__app-acl__`，`src/acl.rs:421`）、或来源不是本地。
本应用三者皆不成立，所以 `core_call`/`core_renderer_ready` 一直如此，新命令同理。
**前置条件由 `test/autostart.test.mjs` 钉住**：将来谁加了 app 级 manifest，那条用例会先红。

**主题裁决（R10）**：**不做手动切换**，亮暗只跟系统的 `prefers-color-scheme`——
`src/renderer/styles.css` 里把 `.dark` 那套令牌照原样接到 `@media (prefers-color-scheme: dark)` 的
`:root` 上，并让 `dark:` 变体也认系统偏好；不引 next-themes（它的防闪烁内联脚本会被 CSP 拦）、
不写 JS、不引入第二套配色。两份令牌**逐条一致**由 `test/theme-tokens.test.mjs` 钉住
（漏一条 = 暗色下有一处颜色留在亮色）。渲染层不得写 `dark` 类或存主题偏好（同文件扫描）。

**关窗行为**：`settings:set` 的 `{patch:{closeBehavior}}`（枚举 `tray`/`quit`，§2.5 既有语义）。
R11 起托盘真的在（见 §2.8），可用性的**真值**来自 `core_get_tray_available`；
渲染层的 `TRAY_AVAILABLE = false` 退化成"宿主没答上来"时的兜底（方向保守，见 §2.8）。

**如实登记的已知限制（本任务）**：

1. **托盘已在 R11 交付**（§2.8）：菜单、勾选镜像、关窗 fail-safe 都接上了——但**真机托盘点击与图标
   显示未实测**（本任务环境起不了真窗），Linux 的 `libayatana-appindicator3` 依赖检查也留给 R15；
2. **开机自启未经真机验证**：单测只覆盖判定逻辑（假 manager，**绝不写本机注册表**），
   真实注册表写入/读取未实测；Rust 侧的错误按结构化 `internal` 回，界面文案带原因；
3. **代理改动要重启才生效**：回执照实回报 `restartRequired`（sidecar 的全局 dispatcher 与
   主窗的 `proxy_url` 都只在启动时装配一次）——设置页据此提示"重启后生效；登录窗口下次打开即生效"；
4. **队列在设置页只读**（长度 + 当前曲），管理队列仍在播放队列面板。

### 2.8 托盘与关窗 fail-safe（R11 落地）

托盘本体在 Rust（`src-tauri/src/tray.rs`）：**9 槽位 / 7 项 / 2 条分隔线**
（显示窗口 / — / 播放·暂停 / 上一首 / 下一首 / 桌面歌词（勾选）/ 设置… / — / 退出程序），
菜单项 id 前缀 `tray:`（`lib.rs` 的 `TRAY_ID = "tray"` 是**托盘图标 id**，两件事别混）。
槽位写成一张数据表（`MENU_SLOTS`），建菜单只是"翻译"它——**没有第二份条目清单**；
认不出的菜单 id 只记一行日志（**不猜、不 panic**）。

**广播频道增补两条**（唯一真源 `src/shared/channels.ts`，Rust 镜像 `bridge.rs`，由 parity 钉住）：

| 频道 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `lyrics:toggle` | 宿主 → 渲染层（广播） | `{checked: boolean}` | 托盘"桌面歌词"勾选的**目标态**（`true` = 要开）。勾选态由托盘的 CheckMenuItem 自己镜像并翻转（不回问渲染层：那要等一个来回、菜单会闪）；**歌词窗本体是 R12**，勾选态与窗存在性的同步也在 R12 收口 |
| `app:open-settings` | 宿主 → 渲染层（广播） | `{view: "settings"}` | 托盘"设置…"：视图状态在渲染层，宿主只发"去设置页"的意图，渲染层走既有的 `navigate`（不新增 IPC 通道） |

**tauri 命令增补一条**（名字唯一真源 `src/shared/commands.ts`）：

| 命令 | 载荷 | 回执 | 说明 |
|---|---|---|---|
| `core_get_tray_available` | 无 | `boolean` | 托盘是否**真的**可用（Rust 侧现问 tauri 的托盘表 `tray_by_id`，不维护第二份镜像）。过主窗来源守卫；渲染层用 `trayAvailabilityFromAnswer` **只认 `true`**，其余一律按"不可用"处理 |

**关窗 fail-safe（本任务的核心）**：`decide_close(hide_on_close, tray_available)` —— 只有
"设置里选了托盘" **且** "托盘真的装上"才 `prevent_close + hide`，否则放行（真退出）。
反过来的后果是旧仓那类缺陷：托盘没装上却把窗口藏了，用户看到"窗口没了、托盘里也没有"，
只能去任务管理器找进程。**退化方向刻意保守**。

**关窗行为从哪来（读盘这侧在 Rust）**：`close_behavior.rs` 读的是**同一份** `settings.json`
（与 `webview_proxy` 共用文件名与 schemaVersion 闸门），分三档：

1. **文件不存在**（用户从没保存过设置）→ **core 的默认**（`DEFAULT_CLOSE_BEHAVIOR` = 枚举第一项 =
   `tray`）：设置页此刻经 `settings:get` 拿到的也是它、显示"最小化到托盘"——两边必须同一句话，
   否则就是"界面说藏起来、关窗却退出了"（与 `webview_proxy` 的"文件不在 = 没配"同款）；
2. 文件在、形状认识 → 照读；
3. 文件在但读不了（权限/IO）或**形状不认识**（非 JSON / 版本不是 1 / 缺 `data` /
   `closeBehavior` 不在枚举里）→ `quit`：**绝不猜 `tray`**。写入路径产不出这些形状
   （core 的 `settings:set` 会结构化拒绝越界值），所以"看不懂"只可能是有人动过盘——
   这时藏窗口的代价（关一次窗再也找不回应用）远大于多退出一次。

两处时点：

- 启动时 `restore()` 读一次并记日志，**先于建窗**（窗一建出来用户就可能关它，那一刻读的就是它）；
- 关窗前 `refresh()` **再读一次盘**：写盘的是设置页（core 的 `settings:set`，同目录临时文件 + rename，
  原子落盘），所以设置页改完**立刻生效**，不需要重启、也不需要新增一条"通知宿主"的命令
  （Rust 侧不维护会漂移的内存镜像）。

**如实登记的未验证项（本任务）**：

1. **真机托盘点击/图标显示未实测**（本任务环境起不了真窗）：菜单构造、事件映射、勾选翻转、
   `decide_close` 矩阵都有单测，但"点下去真的发生什么"没有实机证据；
2. **Linux**：需要 `libayatana-appindicator3`，且 `TrayIconEvent` 不派发（只有菜单可用）——
   依赖检查与环境差异写进 `PLATFORM_DIFFERENCES` 是 R15 的事；
3. **登录门禁期间**托盘"设置…"没有消费方：设置页在门禁之后才挂载，那时广播已经发出去且没人订阅
   （渲染层的订阅在 `LibraryShell` 里）——不是丢事件，是那一刻本来就没有设置页可切；
4. **勾选态与歌词窗存在性的同步**：**R12 已收口**（见 §2.9）：勾选态仍由托盘自己镜像并翻转，
   R12 只补失败路径（窗命令失败 → `app:notice` + 勾选翻回实际状态），不建双向同步链。

### 2.9 桌面歌词窗与任务栏降级（R12 落地）

桌面歌词窗本体在 Rust（`src-tauri/src/lyrics_window.rs`）：label `lyrics`、无边框、透明、无阴影、
置顶、不进任务栏、不可缩放、不抢焦点、**先建出来是隐藏的**（摆好几何再 `show`，防闪默认样式）、
独占 webview 数据目录 `<数据根>/webview2/lyrics`（与登录窗 `webview2/login/<partition>` 同款，
与主窗共用会被 WebView2 的库锁互相踩）。**代理三窗收口**：歌词窗建窗时同样走
`webview_proxy::resolve_for_webview(data_root, "lyrics")` + `proxy_url`（R6 的审计缺口：
不接则封面图与音频流绕过设置直连）。

**请求频道增补一条**（唯一真源 `src/shared/request-channels.ts`，Rust 镜像 `commands.rs`）：

| 频道 | 载荷 | 应答 `data` | 说明 |
|---|---|---|---|
| `playback:lyrics` | `{trackId}` | `{text, format, warnings}` | 歌词**文本**来源（原始 LRC 文本，不是解析结果）。为什么返回文本：逐行滚动必须来自 AMLL 官方组件，而"文本 → 行"是官方 `parseLrc` 的职责（`features/lyrics/amll-adapter.ts` 在它之上补 `[offset:]` 与翻译行）。端点仍是**注入**的（`data.musicEndpoints.lyrics`，与其余业务端点同一张表）：未配置时协议层回结构化 `endpoint_unknown`，界面说"歌词来源尚未配置"——不冒充"这首歌没有歌词"。响应形状尚未联调确认，`parseLyricsPayload` 按候选键宽容读取（`lyric`/`lyrics`/`lrc`/`lyricText`/`content`/`text`，只往里看一层），读到的键名进 `warnings` 备查。文本**不进日志、不落盘、不缓存** |

**广播频道增补三条**（唯一真源 `src/shared/channels.ts`，Rust 镜像 `bridge.rs`，parity 钉住）：

| 频道 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `lyrics:document` | 主窗 → 歌词窗 | `{lines, status}` | 歌词文档。歌词窗**没有业务频道权限**（`core_call` 只收主窗），所以广播是它唯一的数据来源；主窗面板与歌词窗共用**同一份行数组**，两处不可能显示两首歌 |
| `lyrics:progress` | 主窗 → 歌词窗 | `{timeMs, playing, seekGeneration}` | 进度。歌词窗里没有音频元素，进度只能由主窗推；**节流在桥里**（`shouldPushProgress`：≥100ms 或播放/跳转变化才发），且只在窗真的开着时跑 |
| `lyrics:state` | 宿主 → 两窗 | `{config, visible}` | 歌词窗配置（会话内）：`{mode, size, color, locked, clickThrough, effectiveSize}` + 窗可见性 |

**tauri 命令增补四条**（名字唯一真源 `src/shared/commands.ts`；Rust 侧镜像由
`test/lyrics-window.test.mjs` 与 `lib.rs` 的注册扫描钉住）：

| 命令 | 载荷 | 回执 | 说明 |
|---|---|---|---|
| `core_lyrics_toggle` | `{checked}` | `{config, visible}` | 开/关歌词窗。`checked` 是**目标态**（托盘 `lyrics:toggle` 给的就是它）；开 = 建（没有就建）/摆好/显示，关 = **隐藏不销毁**（保住 webview 与进度） |
| `core_lyrics_configure` | `{config}` 补丁 | `{config, visible}` | 改配置。**空补丁 = 读回当前配置**（设置页挂载时用，所以不需要第五条命令，且读操作无副作用）。认不出的值一律不猜（落回上一个合法值） |
| `core_lyrics_document` | `{lines, status}` | `null` | 转发歌词文档（歌词窗只订阅，数据由主窗转发） |
| `core_lyrics_progress` | `{timeMs, playing, seekGeneration}` | `null` | 推进度（主窗侧已按 ≥100ms / 播放或跳转变化节流） |

**四条命令都是 `async`，且都过主窗来源守卫**（`require_main_window`）。async 不是风格问题：
`WebviewWindowBuilder::build` 内部要走一趟主线程往返（窗口只能在事件循环线程上创建），
同步命令自己就站在主线程上，等那一趟 = 死锁（旧仓结论，沿用）。**歌词窗自己只订阅事件、
不调任何命令**（`test/lyrics-window.test.mjs` 扫描钉住：那个文件里没有 `coreCall`/`invoke`）。

**几何（纯函数，含矩阵单测）**：`taskbar_position`（水平居中、贴 `work_area` 下沿）与
`desktop_position`（再上抬 `DESKTOP_LIFT = 120px`，**夹回工作区顶部**）。尺寸按模式取
`TASKBAR_SIZE`（1200×44，单行）或 `DESKTOP_SIZE`（960×120），并**夹进工作区**（小屏上窗口
不该比屏幕还宽）。显示器口径：**优先主窗 `current_monitor()`，取不到退主屏**（桌面歌词是给
正在用主窗的人看的；摆到另一块屏上用户会以为它没开）。

> **"负偏移钳 0"的准确含义**：钳的是**偏移**（居中量 / 贴底量），不是最终坐标。
> 副屏摆在主屏左边时工作区原点就是负的（-1920），把最终坐标钳到 0 会把窗口从左侧副屏
> 扔到主屏上。钳偏移的效果是：窗口比工作区还宽/还高时贴左上角摆，绝不推出屏幕外。
> 由 `a_monitor_left_of_the_primary_keeps_its_negative_origin` 与
> `every_monitor_keeps_the_window_inside_its_own_work_area` 两条用例钉住。

**配置（会话内，持久化不做）**：字号是**档位**（`LYRICS_FONT_STEPS`：16/20/28/40/56px）而不是
连续值——渲染层的视觉一律走工具类/令牌，内联样式只允许几何契约与 AMLL 的 100% 尺寸那两处，
所以连续字号这条 CSS 路本来就不存在；档位与 CSS 的 rem 规则由测试钉住一致。
颜色只认设计令牌（`LYRICS_COLOR_TOKENS`：`foreground`/`muted`/`primary`/`contrast`），
映射在 `amll-theme.css`（AMLL 变量的唯一接线点）。**任务栏模式的有效字号 ≤ 20px**
（`TASKBAR_MAX_FONT_PX`，简报裁决）：配置值本身保留，切回桌面模式时用户的选择还在。
**任务栏模式一律点透**（贴边的一条显示带不该抢底下窗口的点击），桌面模式默认可点（要能接手拖动）；
锁定（`locked`）时渲染层不挂 `data-tauri-drag-region`。

**歌词数据流**：主窗在曲目变化时调 `playback:lyrics` → 官方 `parseLrc` 适配
（`features/lyrics/amll-adapter.ts`）→ `player.setLyrics(lines, status)`（主窗面板）
**与** `core_lyrics_document`（歌词窗）共用同一份行；进度由主窗 rAF 读播放状态机 → 节流 →
`core_lyrics_progress`。歌词状态五档（`unavailable`/`loading`/`empty`/`ready`/`failed`）：
端点没配说"尚未配置"，别的失败说"暂时取不到"——**两句不同的话**（R9 的"尚未接入"在 R12
之后不再成立，因为频道已经接上了，缺的是端点）。

**托盘勾选收口**：勾选态由托盘的 `CheckMenuItem` 自己镜像并翻转（R11，不建假同步链）。
R12 只补**失败路径**：窗命令失败时 → 一句 `app:notice`（带原因）**+** 勾选翻回**窗的实际状态**
（`tray::revert_lyrics_checked`，只有托盘握着那个句柄）。翻回不再发广播：那是
对已发生事实的修正，不是新的目标态（再发一条会让渲染层再跑一遍大概率仍然失败的命令）。

**任务栏歌词是降级实现**：三端都没有"往任务栏里写文字"的公开 API，所以只有"独立透明窗 +
贴 `work_area` 下沿"这一种做法。**绝不注入系统进程、不装系统钩子、不做 shell 扩展**——
`test/lyrics-window.test.mjs` 有一条全源码扫描把这件事钉死（`SetWindowsHookEx` /
`SetWinEventHook` / `Shell_TrayWnd` / `FindWindow` / `SetParent` / `explorer.exe` / … 0 命中）。

**如实登记的未验证项（本任务）**：

1. **真窗的透明/置顶/拖动/点透未实测**（本任务环境起不了真窗）：建窗属性、几何、
   `data-tauri-drag-region` 的挂法、点透开关都有单测与源码扫描，但"屏幕上看起来什么样、
   鼠标点下去发生什么"没有实机证据。多显示器矩阵也只是纯函数层面的（没在多屏机器上跑过）；
2. **任务栏模式与真实任务栏的视觉关系未实测**：窗口贴 `work_area` 下沿（= 任务栏上沿），
   理论上不重叠；不同 DPI/自动隐藏任务栏的机器上要看一眼（R14 的验收路径）；
3. **歌词端点未联调**：`playback:lyrics` 的**响应形状**是宽容读取的（候选键见上），
   真实形状确认后应收敛到那一个键（`warnings` 会指出实际读到的是哪个）。

**已知限制**：

1. **配置不持久化**（裁决：明确不做）：字号/颜色/模式/锁定/点透只在本次运行内生效，
   下次启动回默认；设置项旁边如实写着这句话（`LYRICS_SESSION_NOTICE`）；
2. **登录门禁期间托盘的"桌面歌词"没有消费方**：订阅在 `LibraryShell` 里，而未登录时它不挂载
   ——那一刻勾选会翻转（托盘侧镜像）但不会建窗。与 R11 的"设置…"是同一档（不是丢事件，
   是那一刻本来就没有消费者）；
3. **歌词窗只有隐藏没有销毁**：进程退出前它一直占着一份 webview（这是刻意的：保住进度与
   即时开关的代价，换来的是内存占用）。

### 2.10 系统集成与全局快捷键（R13 落地）

**快捷键组合清单（唯一真源：`src-tauri/src/shortcuts.rs` 的 `SHORTCUT_BINDINGS`）**

| 动作 | 主组合 | 备选链 | 落地（全部经 `emit_core_event`） |
|---|---|---|---|
| 播放·暂停 | `MediaPlayPause` | **无** | `player:command {command:"toggle"}` |
| 上一首 | `MediaTrackPrevious` | **无** | `player:command {command:"previous"}` |
| 下一首 | `MediaTrackNext` | **无** | `player:command {command:"next"}` |
| 桌面歌词 | `CmdOrCtrl+Alt+L` | `CmdOrCtrl+Alt+Shift+L` → `CmdOrCtrl+Shift+L` | `lyrics:toggle {checked}`（目标态 = 歌词窗的反事实状态）+ 托盘勾选镜像到同一目标态 |
| 设置 | `CmdOrCtrl+Alt+S` | `CmdOrCtrl+Alt+Shift+S` → `CmdOrCtrl+Shift+S` | `app:open-settings {view:"settings"}` |

注册在 `setup` 里**逐条**做，**插件不注册任何组合**（`Builder::with_shortcut(..)` 失败会让整个
`setup` 返回 Err → 启动即崩，一个被占用的媒体键不该把应用带走）。主组合被占用 → 沿备选链试；
媒体三键**没有备选**（配一条用户没按过的组合 = 偷偷换键，且他无从知道按哪个键）。只有 `Pressed`
那一次触发（`Released` 再来一次 = 播放/暂停翻两次）。生效组合记进 `ShortcutState`（托管状态，
设置页后续可读），回退与全废**逐条**经 `app:notice` 说清"原来想用哪个、现在实际是哪个、为什么"；
下一步指路托盘菜单，**托盘没装上就改指应用窗口**（指一个不存在的地方比不指更糟）。
**设置页不显示快捷键**（本任务范围外，已知限制，见 §2.10 末）。

**七项系统集成收口核对（逐项结论）**

1. **single-instance ✓**：最先注册（晚于其它插件 = 第二实例会先跑完那些插件的初始化）；
   回调 `focus_main`（unminimize + show + set_focus）——主窗藏在托盘里时也拉得回来。
2. **window-state ✓**：flags 只有 `SIZE|POSITION|MAXIMIZED`，`with_filter` 只放行 `main`/`lyrics`。
   **不含 `VISIBLE`** 是刻意的：插件只在 flags 含 `VISIBLE` 时才 `show()`
   （`tauri-plugin-window-state-2.5.0/src/lib.rs:279`），所以歌词窗不会在下次开机自己弹出来；
   不含 `DECORATIONS`/`FULLSCREEN`（不与歌词窗的无边框/置顶属性打架）。如实记一条副作用：
   SIZE/POSITION 会被恢复，歌词窗**首次创建**时 R12 的几何在其后应用（R12 的判定胜），
   隐藏后再显示不重摆（正是"保住用户拖动位置"的设计）。
3. **notification ✓**：`host:notify` → `HostPlan::Notify`。标题 = 应用显示名（`product_name`，
   不写任务号），正文 = sidecar 给的 `{text}`（trim 后非空；空串/非字符串回 `invalid_payload`）；
   送达失败 → 一行 `log::warn` **+** 结构化错误响应帧（比"只记日志"更强：上游知道没送到）。
   渲染层只有一处调用它（`auth-manager.ts` 的会话读取失败原因），文案克制。
4. **autostart ✓**：`MacosLauncher::LaunchAgent`；两条命令过 `require_main_window`；写入后
   `is_enabled()` **回读**并报**观测到的**状态（不回显请求——`enable()` 返回 Ok 不等于系统记下了）；
   插件未注册时回结构化错误（插件扩展 trait 的 `autolaunch()` 会 panic）。
5. **log ✓**：Info / 单文件 4MB / `KeepOne`；插件默认目标含 `LogDir`
   （`DEFAULT_LOG_TARGETS`），文件落 `app_log_dir()`（`tauri-plugin-log-2.10.1/src/lib.rs:820`），
   不需要显式 `.target(..)`。**`eprintln!` 只出现在 `sidecar.rs` 的 `#[cfg(test)]` 段**（4 处：
   "release 没有开发期脚本回退"/"起不了真 sidecar" 时打印跳过）——生产代码只有 `log::` 一条通道。
6. **快捷键 ↔ 托盘兜底 ✓**：全废时提示里指路托盘菜单；托盘不可用则指应用窗口入口（同一句话
   不指两个地方）。歌词键与托盘勾选的联动走 `tray::revert_lyrics_checked`（同一个"把勾选改成
   某个确定状态"的动作；R12 用它翻回事实，R13 用它镜像目标态），失败收口仍归 R12。
7. **Wayland ✓（限制已写进代码）**：`global-hotkey` 的 Linux 后端只有 **X11**（`x11rb`），
   Wayland 原生会话下没有 X 连接 → 每条注册都失败（`GlobalHotKeyManager::new()` 只起线程、
   当场返 Ok，错误落在 `register` 上）→ 走逐条提示这条既有降级路，不会把启动带崩。
   未实测，文案不承诺 Wayland。注释在 `shortcuts.rs` 模块头（`PLATFORM_DIFFERENCES.md` 是 R15
   的交付物，R15 直接取用）。

**如实登记的未验证项（本任务）**

1. **真机快捷键注册与投递未实测**：本任务只覆盖"注册计划/备选链/状态/文案"的纯函数层与
   `lib.rs` 的接线扫描；"媒体键按下去播放器真的动"没有实机证据（Windows 上媒体键被别的程序
   占用是常态，回退与提示正是为它写的）。
2. **Wayland 会话未实测**：预期是"每条注册都失败 → 逐条提示"，这是读 `global-hotkey` 源码
   得出的结论，不是真机证据。
3. **注册时机不在主线程自锁**：插件每次注册都 `run_on_main_thread` + 阻塞等结果，而
   `setup` 跑在主线程的事件循环回调里。已核到 `Context::send_user_message` 在主线程上**内联
   执行**（`tauri-runtime-wry-2.12.2/src/lib.rs:263-273`），因此 `setup` 里注册不会自锁——
   源码结论，未在真机跑过冷启动。

**已知限制**

1. **设置页看不到当前快捷键**（明确不做 UI）：生效组合记在 `ShortcutState` 里，只经启动提示
   说一次；
2. **`capabilities/main.json` 里的三条 `global-shortcut:allow-*` 现在没有渲染层调用方**
   （注册已收归宿主）：R2 的计划第 141 行显式要求这三条，本任务不动它——如实记为冗余权限。

### 2.11 请求频道与宿主要求的完整登记（R15 核对后增补）

> **为什么有这一节**：§2.4–§2.10 各节只登记了 R8–R13 **新增**的频道；R3–R7 建立的五条请求频道
> 与三条宿主要求在全文里**只被引用**（例如 §2.6 写「§2.5 的既有语义」、§2.7 引 `settings:set`），
> 却没有任何一处写过它们的载荷与回执形状。R15 核对 `docs/API_CONTRACT.md` 时发现这个缺漏，
> 按**代码事实**补齐（真源：`src/shared/request-channels.ts` 的两份清单，Rust 侧为镜像副本）。
> 本节只登记，不改任何实现。

**请求频道（渲染层 → core，唯一业务通道 `core_call`）** —— 共 17 条，真源 `REQUEST_CHANNELS`：

| 频道 | 载荷 | 应答 `data` | 失败类别 | 落地 |
|---|---|---|---|---|
| `auth:login` | 无 | `{started:true, loggedIn, epoch, loginInFlight}` | — | R4/R7 |
| `auth:logout` | 无 | `{sessionCleared, cacheCleared, notes[]}` | 清不干净**不改写成成功**，原因进 `notes` | R4/R7 |
| `auth:cancel-login` | 无 | `{cancelled}`（`false` = 本来就没有进行中的登录，**不是错误**） | — | R7（R25 起渲染层不再直接调它：浮动控件的「返回扫码登录」走 `core_login_chrome`，落到**同一个结论槽**） |
| `auth:qr-start` | 无 | `{content, expiresInMs}`（二维码内容 + 有效期；之后的状态变化走 `auth:qr` 广播） | 建单失败 → 结构化类别 + `auth:qr{failed}` | R16 |
| `auth:get-status` | 无 | `{loggedIn, busy}`（**与 `auth:status` 广播同形状**；不触发广播、不带 `message`） | 频道不可用即结构化错误（渲染层**不据此猜档位**，只把原因说到状态行上） | R19 |
| `settings:get` | 无 | `{settings}` = 归一后的完整文档 | 读不到/读坏了 → 回默认文档（代理当没配）+ 一条日志，**不抛、不砸文件** | R6 |
| `settings:set` | 二选一：`{patch:{...}}`（合并）或 `{reset:true}`（已知键回默认） | `{settings, restartRequired}` | `invalid_payload`（两个都给 / 都不给 / 类型不对，**不写盘**）；文件认不出 → 结构化错误并**保留原文件** | R6 |
| `settings:test-proxy` | 见 §2.7 | 见 §2.7 | 见 §2.7 | R10（接 R6 的测试器） |
| `library:*`（7 条） | 见 §2.5 | 见 §2.5 | 见 §2.5 | R8 |
| `playback:resolve-url` | 见 §2.6 | 见 §2.6 | 见 §2.6 | R9 |
| `playback:lyrics` | 见 §2.9 | 见 §2.9 | 见 §2.9 | R12 |

三条关于 `auth:login` 的要紧事实：

1. **它是"长轮询的反面"**：立刻回 `{started:true}`，真正的结论经 `auth:status` **广播**送达（§1.7）——
   渲染层那条调用链（Rust `core_call`）有 60 秒上限，而扫码要等好几分钟。
   dispatcher 支持处理器自行答复后 `return undefined` 不再写第二帧，这条路就是为它留的。
2. `epoch` 是"会话属于哪一代"（R8+ 的业务请求用它绑定凭据）。
3. **`auth:login` 的回执里没有账号标识**：设置页只显示「已登录/未登录」+ 退出按钮，
   不为显示扩协议（§2.7）。

**`settings:set` 的三层不对称（刻意，写在这里以免被当成不一致）**：

| 层级 | 口径 | 为什么 |
|---|---|---|
| **字段级宽容** | 代理的 `host`/`port` 不合法 → 归成「没填」 | 用户可能正在半填表单 |
| **枚举级严格** | `closeBehavior` 不在枚举（`tray`/`quit`）里 → 直接报错 | 枚举值是代码写的，错了就是 bug |
| **结构级严格** | `patch.proxy` 不是对象也不是 `null` → `invalid_payload` | 形状错了不该猜 |

另：`patch` 里某个键给 `null` = **删除该键**（§2.6 的队列清理依赖这条语义）。

**宿主要求（core → 宿主，经 `rpc.callHost`）** —— 共 5 条，真源 `HOST_REQUEST_CHANNELS`：

| 频道 | 入 | 出 | 落地 |
|---|---|---|---|
| `host:notify` | `{text}`（非空字符串，会 `trim`） | `{ok:true, data:null}` | R3：Rust `HostPlan::Notify` → `tauri-plugin-notification`；标题 = 应用显示名。空/非串 → `invalid_payload`（**不回显内容**） |
| `host:secure-encrypt` | `{plaintext}` | `{cipher}`（base64 的 DPAPI 信封） | R5：`session-store.mjs` 只认 `data.cipher` |
| `host:secure-decrypt` | `{cipher}` | `{plaintext}` | R5：只认 `data.plaintext`；解不开 → `invalid_cipher`（**不当成「没登录」**）；后端不可用 → `secure_store_unavailable`，**没有"失败降级成明文"这条分支** |
| `host:open-login` | 见 §1.7 | 见 §1.7（长轮询：窗收场后才答复） | R7 |
| `host:cancel-login` | 见 §1.7 | 见 §1.7 | R7 |

- 出向 `callHost` **只放行宿主白名单**：非白名单当场回 `unknown_channel` 且**不写帧**（`src/host/rpc.mjs`）。
- `host:notify` 的**端到端没被跑过**（R3 的 sidecar 不主动发起宿主要求）：Rust 单测覆盖了决策与
  一次性守卫，**真弹通知这条链没有运行期证据**（见 §6 的 untested 口径）。

**跨语言镜像**：两份清单的字面量只出现在 `src/shared/request-channels.ts`；Rust 侧
（`src-tauri/src/commands.rs` 的 `require_request_channel` / `route_host_request`）是**刻意的镜像副本**，
由 `test/channel-parity.test.mjs` 扫源码钉住集合相等。入口对 `REQUEST_CHANNELS` 逐个补齐兜底：
尚未实现的频道回结构化 `unimplemented`（**不静默、不挂起**）。

## 3. 本地常量（唯一真源位置）

| 常量 | 值 | 唯一真源文件 | 消费方 |
|---|---|---|---|
| `LOGIN_VIEW_TOP_INSET` | `48`（CSS px） | `src/shared/login-inset.mjs` | **R25 起只有门禁自己那条 header 读它**（`login-gate.tsx`）：登录页铺满整窗，不再是"给子窗让位"的几何契约，Rust 侧也**不再镜像**它（`test/login-parity.test.mjs` 反向钉住） |
| `LOGIN_TIMEOUT_MS` | `10 * 60_000` | `src/protocols/login-callback.mjs` | Node 侧；Rust `LOGIN_TIMEOUT_SECS = 600` 由 R7 镜像并由 parity 测试互钉 |
| `LOGIN_LOAD_DEADLINE_SECS` | `30` | `src-tauri/src/login.rs` | 首载期限（Rust 独有：Node 侧没有对应的墙钟，只有"打不开官方页"这条结论） |
| `LOGIN_WEBVIEW_LABEL` | `"login"` | `src-tauri/src/login.rs` | R23：登录页那个**子 webview** 的 label（不再是窗口 label）。它是命令层唯一能区分"这一帧是登录页发的还是主窗发的"的东西（`require_main_webview`），必须 ≠ `main` |
| `LOGIN_RETURN_WEBVIEW_LABEL` / `LOGIN_THEME_WEBVIEW_LABEL` | `"login-return"` / `"login-theme"` | `src-tauri/src/login.rs` | R25：两个浮动控件的 label（返回 / 主题）。`core_login_chrome` 的来源守卫按它们放行，两者都必须 ≠ `main` ≠ `login` |
| `LOGIN_CHROME_ENTRY` / `LOGIN_CHROME_KIND` | `"login-chrome.html"` / `"return"`、`"theme"` | `src/shared/login-chrome.mjs`（Rust 侧 `login.rs` 镜像，parity 互钉） | R25：两个浮动控件共用一个本地入口，`?kind=` 决定渲染哪一个 |
| `CHROME_MARGIN` / `RETURN_CHROME_SIZE` / `THEME_CHROME_SIZE` | `8` / `124×34` / `184×34`（CSS px） | `src-tauri/src/login.rs` | R25：浮动控件贴边留白与盒子尺寸（× 缩放比）。透明子窗仍会吃掉落在它矩形里的鼠标，所以盒子"够用就好" |
| `CORE_LOGIN_CHROME` | `"core_login_chrome"` | `src/shared/commands.ts` | R25：浮动控件与 gate 主题控件的唯一命令（两个动作：取消登录 / 主题三态）。来源守卫只放 `main`/`login-return`/`login-theme` |
| `THEME_CHANGED` | `"theme:changed"` | `src/shared/channels.ts`（Rust `bridge.rs` 镜像，parity 互钉） | R25：主题目标态广播 `{theme}`；Rust 持有状态（`settings.json` 的 `theme` 键），三个 webview 各自应用 class |
| `THEME_CHOICE` / `THEME_LABELS` / `THEME_DEFAULT` | `light`/`dark`/`system`；`浅色`/`深色`/`跟随系统`；默认 `system` | `src/renderer/features/theme/theme.mjs`（Rust `theme.rs` 镜像同值） | R25：主题三态的唯一真源；`applyThemeChoice` 是全项目**唯一**切类入口（扫描钉住），认不出的档位按系统档 |
| `THEME_KEY` | `"theme"` | `src-tauri/src/theme.rs` | R25：`settings.json` 的 `data.theme`。Rust 读+写这一个键（原子替换、认不出的文件绝不覆盖）；sidecar 的 `settings:get/set` 对它透传（`data` 层未知键原样保留） |
| 两条期限文案 | 见 §1.7 | `src-tauri/src/login.rs` ↔ `src/main/huawei.ts` | 两侧逐字一致，parity 互钉 |
| `LYRICS_SEEK_WINDOW_MS` | `200` | `src/renderer/features/lyrics/lyric-sync.mjs` | R9：歌词的 `isSeeking` 窗口（拖动时歌词跟着手走、手停 200ms 后自动收窗）；组件里不许再写这个数字（扫描钉住） |
| `QUEUE_SETTING_KEY` | `"queue"` | `src/renderer/features/playback/queue.mjs` | R9：播放队列的持久化键（`data.queue`，只存曲目标识 + 索引） |
| `PROXY_TEST_URL` | `https://oauth-login1.cloud.huawei.com/` | `src/host/proxy-handlers.mjs` | R10：`settings:test-proxy` 的唯一目标（不接受调用方指定；业务端点仍待联调） |
| `CORE_SET_AUTOSTART` / `CORE_GET_AUTOSTART` | `"core_set_autostart"` / `"core_get_autostart"` | `src/shared/commands.ts` | R10：命令名的唯一真源（渲染层只用常量；Rust 侧为镜像副本，由 `test/autostart.test.mjs` 钉住） |
| `CORE_GET_TRAY_AVAILABLE` | `"core_get_tray_available"` | `src/shared/commands.ts` | R11：托盘可用性的唯一来源（Rust 侧镜像由 `test/tray.test.mjs` 与 lib.rs 的注册扫描钉住） |
| `TRAY_AVAILABLE` | `false` | `src/renderer/features/settings/settings-form.mjs` | R11：**兜底值**——宿主没答上来时用（真值来自 `core_get_tray_available`）。方向保守：界面说"不可用"而实际能用，比反过来代价小 |
| `TRAY_ID` | `"tray"` | `src-tauri/src/lib.rs` | R11：托盘**图标** id（菜单项 id 前缀是 `tray:`，见 `tray::MENU_ID_PREFIX`）；`core_get_tray_available` 与关窗回调都按它现问托盘表 |
| `MENU_SLOTS`（9 槽位/7 项/2 分隔线） | 见 `src-tauri/src/tray.rs` | `src-tauri/src/tray.rs` | R11：托盘菜单的唯一真源（顺序与文案由 Rust 内联单测 + `test/tray.test.mjs` 双向钉住） |
| `PLAYBACK_LYRICS` | `"playback:lyrics"` | `src/shared/request-channels.ts` | R12：歌词文本来源（Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `LYRICS_DOCUMENT` / `LYRICS_PROGRESS` / `LYRICS_STATE` | `"lyrics:document"` / `"lyrics:progress"` / `"lyrics:state"` | `src/shared/channels.ts` | R12：主窗 → 歌词窗的三条广播（歌词窗只订阅事件，这是它唯一的输入） |
| `CORE_LYRICS_TOGGLE` / `_CONFIGURE` / `_DOCUMENT` / `_PROGRESS` | `"core_lyrics_toggle"` / `"core_lyrics_configure"` / `"core_lyrics_document"` / `"core_lyrics_progress"` | `src/shared/commands.ts` | R12：四条命令名的唯一真源（Rust 侧为镜像副本，由 `test/lyrics-window.test.mjs` 与 `lib.rs` 注册扫描钉住） |
| `LYRICS_WINDOW_LABEL` | `"lyrics"` | `src-tauri/src/lib.rs` | R12：歌词窗 label（window-state 过滤白名单、四条命令的来源守卫、`current_monitor()` 的窗口都按它认） |
| `TASKBAR_SIZE` / `DESKTOP_SIZE` / `DESKTOP_LIFT` | `1200×44` / `960×120` / `120` | `src-tauri/src/lyrics_window.rs` | R12：两种模式的窗口尺寸与桌面上抬量（夹进工作区；几何矩阵有内联单测） |
| `LYRICS_FONT_STEPS` / `TASKBAR_MAX_FONT_PX` | `sm16/md20/lg28/xl40/xxl56` / `20` | `src/renderer/features/lyrics/lyrics-window.mjs` ↔ `src-tauri/src/lyrics_window.rs` | R12：字号档位与任务栏模式上限（两侧一张表，由 `test/lyrics-window.test.mjs` 逐条钉住；CSS 的 rem 规则在 `amll-theme.css`） |
| `LYRICS_COLOR_TOKENS` | `foreground`/`muted`/`primary`/`contrast` | 同上（TS 为真源、Rust 为镜像） | R12：歌词颜色的令牌档位（只认设计令牌，绝不接受任意色值） |
| `MIN_PROGRESS_INTERVAL_MS` | `100` | `src/renderer/features/lyrics/lyrics-window.mjs` | R12：进度节流窗口（rAF 每帧调 `pushProgress`，只有该推的才出 IPC） |
| `LYRICS_SESSION_NOTICE` | 会话内说明文案 | `src/renderer/features/lyrics/lyrics-window.mjs` | R12：设置项旁边如实写"只在本次运行内生效、不写入设置文件" |
| `SHORTCUT_BINDINGS` | 5 动作 / 主组合 + 备选链 | `src-tauri/src/shortcuts.rs` | R13：全局快捷键的唯一真源（媒体三键无备选；两条提示型组合各有 2 条备选）。每个组合都必须能被 `global-hotkey` 解析、且不许两个动作抢同一个组合（内联单测钉住） |
| `ShortcutState` | 生效组合快照 | `src-tauri/src/shortcuts.rs` | R13：`setup` 里登记成托管状态（设置页后续可读；本任务只记 + 提示，不做 UI） |
| `HUAWEI_QR_ENDPOINTS` | 见 §1.8（建单/轮询/CAS 换码三条） | `src/main/qr-login.mjs` | R16：二维码登录的端点表（探针确认值；协议层 `src/protocols/qr-login.mjs` 仍只收注入，不写死 URL） |
| `AUTH_QR_START` / `AUTH_QR` | `"auth:qr-start"` / `"auth:qr"` | `src/shared/request-channels.ts` / `src/shared/channels.ts` | R16：二维码会话的请求频道与状态广播（Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `AUTH_GET_STATUS` | `"auth:get-status"` | `src/shared/request-channels.ts` | R19：登录状态**重查**频道（渲染层挂载时主动问一次；应答与 `auth:status` 同形状，Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `QR_HINT_TEXT` | `"手机「控制中心」>「扫一扫」或者系统「设置」>「华为账号」>「扫一扫」。"` | `src/renderer/features/auth/login-gate-logic.mjs` | R16 立、**R18 按用户指令改文案**：引导页那**一句**提示文字（界面与测试读同一份真源；状态行不再复述它） |
| `LOGIN_GATE_TITLE` | `"华为账号登录"` | `src/renderer/features/auth/login-gate-logic.mjs` | R18：引导页标题的唯一真源（居中放在二维码正上方；header 里那份已移除，全页只出现一次） |
| `WEB_LOGIN_ENTRY_TEXT` / `WEB_LOGIN_ENTRY_TESTID` | `"在网页中打开登录"` / `"login-open-web"` | `src/renderer/features/auth/login-gate-logic.mjs` | R18：**常驻**次要入口的文案与测试锚点（走 R7 的 `auth:login` 开窗路径；与二维码互斥，见 §1.8） |
| `WEB_LOGIN_BACK_TEXT` / `WEB_LOGIN_BACK_TESTID` | `"返回扫码登录"` / `"login-back-to-qr"` | `src/renderer/features/auth/login-gate-logic.mjs` | R20 立、**R25 改落点**：`webLoginEntry(state)` 仍是形态的唯一判据，但那个控件**不再由 gate 渲染**——它浮在官方页之上（浮动 webview `login-return`，`login-chrome.tsx`），点击走 `core_login_chrome {action:"return"}`（与 `auth:cancel-login` 落到同一个结论槽） |
| `QR_REFRESH_LABEL` / `QR_REFRESH_TESTID` | `"刷新二维码"` / `"login-qr-refresh"` | `src/renderer/features/auth/login-gate-logic.mjs` | R20：二维码容器（`<button>`）的**可达名字**与锚点；点击 = `startQr`（换一张新码）。R25：它**就是**唯一的换码控件（过期态那个显著按钮已删） |
| `QR_EXPIRED_BOX_TEXT` / `QR_EXPIRED_BOX_HINT` | `"二维码已过期"` / `"点击刷新"` | `src/renderer/features/auth/login-gate-logic.mjs` | R21 立、**R25 改成两行**：过期占位只写「二维码已过期」/「点击刷新」两行（用户指令），原来那个显著的「刷新二维码」按钮删掉——容器自己就是那个控件。**R26：这两行是过期态唯一的提示载体**（状态行在过期档不再渲染，见 `loginGateStatusLine`） |
| ~~`QR_EXPIRED_NOTICE`~~ | ~~`"二维码已过期，点击刷新。"`~~ | — | **R26 删除**（用户真机反馈之 4：它与二维码遮罩那两行重复、还把用户的选择挤下去。过期态状态行**整行隐掉**，不给第二份文案） |
| `QR_EXPIRING_TEXT` | `"正在确认过期…"` | `src/renderer/features/auth/login-gate-logic.mjs` | R21：本地倒计时**数到 0** 时那一行。本地钟不是权威（服务端 `expired` 广播才是），所以这一档说的是"在等确认"，不是"已过期" |
| `QR_COUNTDOWN_TICK_MS` / `QR_COUNTDOWN_TESTID` | `1000` / `"login-qr-countdown"` | `src/renderer/features/auth/login-gate-logic.mjs` | R21：倒计时的步长（秒级）与那一行的测试锚点；文案由 `qrCountdownText(state)` 从"到期时刻 − 渲染层的钟"算出 |
| ~~`QR_REFRESH_ACTION_TESTID`~~ | ~~`"login-qr-refresh-action"`~~ | — | **R25 删除**（用户指令：过期遮罩只两行、删掉过期态那个刷新按钮，容器是唯一换码入口） |
| `QR_CANVAS_OPTIONS` / `QR_SIZE_PX` | `{width: 208, margin: 1, errorCorrectionLevel: "L"}` / `208` | `src/renderer/features/auth/qr-canvas.mjs` | R18：二维码画布的唯一画法（内容一换即重画；`npm run verify:live` 按 208×208 与墨迹占比复核） |
| `QR_DEFAULT_INTERVAL_MS` / `QR_DEFAULT_MAX_POLL_FAILURES` | `2000` / `3` | `src/protocols/qr-login.mjs` | R16：轮询间隔兜底（真值由服务端下发）与连续失败几次收口 |
| `QR_DEFAULT_MAX_UNKNOWN_CODES` | `5` | `src/protocols/qr-login.mjs` | R22：连续几个**认不出**的 `resultCode` 就熔断成 `failed`（`unknown_result_code`）。陌生码当成功是最严重的误判，但"一直陌生"同样致命：协议真变了时它会 2 秒一次打到总期限，用户全程停在等待态、日志里什么都没有 |
| `QR_LOCAL_EXPIRY_GRACE_MS` | `3_000` | `src/protocols/qr-login.mjs` | R22 立（15 秒）、**R26 收窄到 3 秒**：本地到期兜底的宽限。R26 起落点从"轮询落地"改成**建单/刷新时挂的一次性定时器**（延迟 = 服务端 TTL + 宽限），到点时服务端还是**什么都没说** → 本地主动转 `expired`（服务端给出 `expired`/`scanned`/`confirmed` 时让位）。它同时是渲染层「正在确认过期…」那一档的**上界**：归零之后最多 3 秒必有出口 |
| `LOGIN_THEME_PARAM` | `"themeName"` | `src-tauri/src/login.rs` | R26：官方登录页认的主题查询参数（CAS 门户页按它选 `index-<theme>.css`）。probe 实测见 §1.7 的 R26 段 |
| `LOGIN_THEME_NAME_DARK` | `"dark"` | `src-tauri/src/login.rs` | R26：深色档挂上去的值。**实测边界**：桌面 UA 下服务端只放 {red, huawei, blue, lightred}，`dark` 会被回落成 `red`（浅色）——这条通路今天拿不到深色页面（登记在 `KNOWN_LIMITATIONS.md` B18）。浅色档**不动这个参数**（服务端桌面默认就是浅色，显式换一套浅色是没人要过的变更） |
| `QR_TTL_DIFF` / `QR_TTL_LEGACY`（内部两条路，不是导出常量） | `expiredTime − qrCodeCreateTime` / `expiredTime − now()` | `src/protocols/qr-login.mjs` 的 `resolveExpiresInMs` | R22：有效期换算。两条都是**服务端值**相减时免疫本地时钟偏差；`qrCodeCreateTime` 缺失/非法才回退老公式——**已知偏差风险**：本地钟快 1 小时，倒计时就早归零 1 小时（用户看到的是"卡在正在确认过期…"）。两值矛盾或 `expiredTime` 不可信 → `null`（不猜，界面少一行倒计时） |
| `MAX_URL_LOG_CHARS` | `160` | `src-tauri/src/login.rs` | R16：登录窗导航/加载日志里 URL 的截断上限（查询值一律不进日志） |
| `HUAWEI_MUSIC_LOGINEX_ENDPOINT` | `https://api-drcn.music.dbankcloud.cn/music-odpapp-service/v5/service/userinfo/loginex` | `src/main/music-session.mjs`（默认值经 `auth-manager.ts` 的 `HUAWEI_OAUTH_ENDPOINTS.loginex` 注入） | R17：音乐会话兑换端点（证据分级见 §1.5.1）。协议层 `auth.mjs`/`music.mjs` 仍只收注入；`test/auth-manager.test.mjs` 拿本文件反查这串字面量 |
| `MUSIC_SESSION_DIGEST_USERNAME` | `"app-music-baseline"` | `src/main/music-session.mjs` | R17：音乐业务请求 Digest 头的固定 `username`（不是凭据；只在请求头里出现，不进日志） |
| `MUSIC_BUSINESS_OK` | `"000000"` | `src/main/music-session.mjs` | R17：业务成功码（HTTP 2xx **且** `result.resultCode === "000000"` 才算成功） |
| `LOG_DIR_NAME` | `"logs"` | `src-tauri/src/lib.rs` | R17：日志目录在数据根下的一级子目录名；`HWMUSIC_DATA_DIR` 可用时日志写 `<数据根>/logs`（`log_plugin_targets` 的唯一构造点） |

## 4. 红线（任何后续任务不得越过）

1. 渲染层拿不到 Token；业务 HTTP 只在 sidecar/Rust 侧。
2. 端点未确认前不写猜测 URL：只登记本文件，代码走注入。
3. 探针只碰公开资源，不碰账号与私人凭据；产物落 `.probe/`（已 gitignore）。
4. OAuth 身份 `101444301` 非本项目注册：发布物必须声明，不尝试"修身份"式重试。

## 5. 变更记录

- 2026-10-19（Task R4）：建初版。确认 authorize/token 端点与 CDN 域可达性；业务端点与 `loginex` 登记为待确认。
- 2026-10-19（Task R4 修复轮 1）：新增 §1.6 宿主契约——`consumeCallback` 可接收窗内每个导航 URL，
  `not_callback` / `state_mismatch` 只拒绝该次调用、**不结算**登录流（原先会被当成终局 `failed`，
  一次普通页面跳转即永久杀死登录）。
- 2026-10-19（Task R7）：新增 §1.7——登录子窗 ↔ sidecar 的线上契约（`host:open-login` 长轮询、
  `host:cancel-login` 增补、五个 `status` 词表、双期限文案）、`auth:status` 广播载荷与
  "结论为什么走广播"、`FrameNavigationStarting` 缺口如实登记；§3 补两行常量。
  `loginex` 仍为**待联调**（§1.5 未变）：本任务不猜它的 URL，默认实现直接回结构化「待联调」。
- 2026-10-19（Task R8）：§2.2 增补 `playlistDetail` 注入键（歌单曲目与歌单列表是两件事）；
  新增 §2.5——主界面 ↔ sidecar 的 `library:*` 七条频道、应答形状、端点注入点
  （设置文档 `data.musicEndpoints`，仍为空表）、渲染层的三态纪律与两处如实登记的未接线项。
- 2026-10-19（Task R9）：新增 §2.6——`playback:resolve-url`（当次播放地址：不写日志、不落盘、
  不缓存、渲染层再闸一次、地址不进状态）与 `player:command` 广播（R11 托盘的预登记）；
  队列持久化 `data.queue = {ids, index}` 的裁决与"恢复不自动播放"；Media Session 的对接范围；
  三条如实登记的未接线项（**歌词来源通道**、封面/背景图、音质/试听标注）。§3 增补两个常量
  （`LYRICS_SEEK_WINDOW_MS`、`QUEUE_SETTING_KEY`）。
  协议层新增 `readFavoritesPage`（单页分页结论，**不给 total**）与 `getPlaylistDetail`。
- 2026-10-19（Task R10）：新增 §2.7——`settings:test-proxy` 频道（固定测试目标、凭据不回显）
  与两条 tauri 命令 `core_set_autostart` / `core_get_autostart`（报观测到的状态、主窗来源守卫、
  **不进 capabilities** 的 Tauri 2.12 出处与前置条件）；主题裁决（只跟 `prefers-color-scheme`，
  不做手动切换，两份令牌逐条一致由测试钉住）；关窗行为的托盘可用性口径；四条如实登记的限制。
  §3 增补三行常量。设置页**不显示账号标识**（`auth:status` 载荷里没有该字段，不为显示扩协议），
  登录状态只显示"已登录/未登录" + 退出按钮。
- 2026-10-19（Task R11）：新增 §2.8——托盘（9 槽位菜单 / `tray:` id 前缀 / `include_bytes!` 图标）、
  关窗 fail-safe（`decide_close`：选托盘 **且** 托盘真的装上才藏窗口）、`close_behavior.rs` 的读盘恢复
  （与 `webview_proxy` 同款 schema 闸门，形状不认识一律 `quit`；启动恢复先于建窗 + 关窗前现读盘）、
  两条广播增补（`lyrics:toggle`、`app:open-settings`）与命令 `core_get_tray_available`；
  §2.7 的关窗行为口径与"托盘不存在"那条限制随之更新；§3 增补三行常量与 `TRAY_ID`/`MENU_SLOTS` 两行。
  四条如实登记的未验证项（真机托盘点击/图标、Linux appindicator、门禁期间的"设置…"、歌词窗同步归 R12）。
- 2026-10-19（Task R12）：新增 §2.9——桌面歌词窗（label/无边框/透明/置顶/不进任务栏/隐藏后 show/
  独占数据目录/代理三窗收口）、任务栏歌词降级（贴 `work_area` 下沿，**绝不注入**，
  由全源码扫描钉死）、几何纯函数（含"负偏移钳 0"的准确含义与多显示器负坐标）、
  会话内配置（字号档位 ≤20px / 颜色令牌 / 锁定 / 点透）、请求频道 `playback:lyrics`、
  三条广播与四条 async 命令、歌词数据流与五档状态、托盘勾选失败路径的收口；
  §2.6 的"歌词来源通道"那条未接线项**由本节关闭**（频道已接，缺的是端点）。
  §3 增补七行常量。三条如实登记的未验证项 + 三条已知限制。
- 2026-10-19（Task R13）：新增 §2.10——全局快捷键组合清单（媒体三键无备选 / 两条提示型组合
  各 2 条备选）、逐条注册与备选链回退（**插件不注册任何组合**：它的注册失败会崩启动）、
  回退与全废逐条经 `app:notice` 说清"现在用的是哪个键"（托盘不可用则改指应用窗口）、
  歌词键顺带把托盘勾选镜像到目标态；**七项系统集成收口核对逐项结论**
  （single-instance / window-state flags 与 filter / notification / autostart / log /
  快捷键与托盘的兜底关系 / Wayland 热键限制写在代码注释里）；§3 增补两行。
  三条如实登记的未验证项（真机注册与投递、Wayland 会话、setup 期注册不自锁是源码结论）
  + 两条已知限制（设置页不显示快捷键、capabilities 里三条 `global-shortcut:allow-*` 冗余）。
- 2026-10-19（Task R15）：**核对后增补 §2.11** —— R3–R7 建立的五条请求频道
  （`auth:login`/`auth:logout`/`auth:cancel-login`/`settings:get`/`settings:set`）与三条宿主要求
  （`host:notify`/`host:secure-encrypt`/`host:secure-decrypt`）此前在全文里只有引用、没有登记
  （典型症状：§2.6/§2.7 引「§2.5 的既有语义」而 §2.5 里并没有它们）。本节按代码事实补齐载荷、
  回执、失败类别与三层不对称语义，并登记 `host:notify` 端到端未跑过。**只补文档，不动代码。**
  顺带把 §2.4（CDN 域）那一段**整体上移到 §2.5 之前**——R8 修复轮插回标题时它落在 §2.10 之后，
  导致 §2 的物理顺序是 2.3→2.5…2.10→2.4；现在 §2.1–§2.11 按编号单调，且 §2.11 在末尾（纯挪行，内容一字未改）。
  其余各节（§1.1–§1.7、§2.1–§2.10、§3–§4）核对无缺漏。
- 2026-10-20（Task R16）：**用户指令推翻 R7 的"按钮流"裁决**（引导页只展示二维码与提示文字），
  为此新增 §1.8——二维码（DimensionalCode）登录协议的完整实探：getLoginWay → CAS 302 →
  **移动登录页的 getPageInfo 才下发二维码配置**（桌面门户实测 `isQrlogin:false`）→
  `DimensionalCode/getqrInfo` 建单（`content` 就是要编码的字符串，有效期 181 秒）→
  `DimensionalCode/async` 轮询（`0`/`103000202`/`103000201`/其余，实探只见 `103000200`）→
  `codeRemoteLogin` 换回带 `code` 的回调（**未实测**：需要真人扫码确认）。
  同轮把 §1.4 的白名单增补一条 `https://id1.cloud.huawei.com`——**这就是真机"登录窗一片空白"的根因**
  （授权页空壳 SPA 要跳到 CAS 门户，而那条导航被拦下）；配套落地：登录窗导航/加载日志
  （URL 只留 origin+path+参数名，`MAX_URL_LOG_CHARS` 截断）+ debug 构建开 devtools。
  §3 增补六行常量。**仍未联调**：真实扫码确认后的兑换（`loginex` 端点仍缺，见 §1.5）、
  真机 dev 跑一次的验证（由用户在场所做）。
- 2026-10-20（Task R17）：**`loginex` 从「待联调」升到「端点 + 形状已确认」**——§1.5 改名并新增
  §1.5.1，把证据分三级逐条标注（① 本机实测：405 / 对照 404 / 无效 AT → 200 + 业务码 `990000`；
  ② 公开来源：业务域 + 端点 + 请求体 + Digest 头形状 + 成功判据；③ 仍未实测：有效 AT 的兑换往返、
  `expireTime` 时区）。落地：新增 `src/main/music-session.mjs`（端点常量 / Digest 构造 / 响应解析 /
  可注入 fetch 的端口），`auth-manager.ts` 的默认 `loginex` 端点改指确认值（显式注入 `null` 仍是
  「关掉」且一次请求都不发）。同轮顺带记录**音乐业务端点**的公开来源候选（收藏/历史/搜索/播放地址），
  **本仓一条都没实测**，故 `data.musicEndpoints` 仍由设置文档注入、代码不写死。
  **仍未联调**：真实扫码确认后的完整兑换（§1.5.1 的 untested 清单）。
- 2026-10-20（Task R17，日志落点）：`tauri-plugin-log` 的文件目标从插件的默认 `LogDir`
  改为**跟随数据根**（`HWMUSIC_DATA_DIR` 可用时写 `<数据根>/logs`）——受限环境里 `%LOCALAPPDATA%`
  可能不可写，而建窗本来就走数据根，两者绑在一起才不会出现"窗口能起、日志打开失败"。详见 §3。
- 2026-10-20（Task R18，**补记**：当时只改了正文、漏了本节）：§1.8 增补"两条路互斥"
  （引导页常驻的「在网页中打开登录」与二维码流互斥：开窗前停轮询 + 作废尝试、迟到确认按身份
  比对丢弃、二维码不占 `busy`）；§3 增补 `LOGIN_GATE_TITLE` / `WEB_LOGIN_ENTRY_TEXT` /
  `WEB_LOGIN_ENTRY_TESTID` / `QR_CANVAS_OPTIONS` 四行并更新 `QR_HINT_TEXT` 的值。
- 2026-10-20（Task R19）：**新增请求频道 `auth:get-status`**（§1.7 增补说明、§2.11 与 §3 登记）。
  它是渲染层 reload / 崩溃重启之后门禁卡在 `checking` 的修复：`auth:status` 是广播，而 Rust
  `NoticeQueue` 的冲刷**只发生一次**，重启后的渲染层再也等不到那条一次性通知——
  "现在的状态是什么"只能靠一次有应答的查询（与 `core_get_tray_available` 同款模式）。
  三条边界：**不触发广播**、**不带 `message`**（那是"刚发生的那件事"）、**不推结论**
  （未验证的会话不会因为被问了一句就变成"已登录"）。渲染层挂载时在订阅就位、`rendererReady()`
  之后查一次，应答与广播喂同一条状态事件；查询本身失败时**不猜档位**（仍 `checking`），
  只把原因写到状态行上。`npm run verify:live` 相应地把"等二维码"改成轮询 canvas 与状态行
  （等不到时报出卡住的那一档），断言条数不变。**仍未联调**：真机重跑 18/18 由控制器执行。
- 2026-10-20（Task R20）：**用户真机验收反馈三项**，逐条落地（§1.8 增补"R20 那段"实测与语义）：
  1. 引导页 header 里那句品牌**删掉**（与窗口标题栏重复）：header 结构保留（48px 对位契约），
     只是不再有任何可见文字；
  2. 二维码过期：**实测确认**服务端会给出 `103000201`（t+177.4 s，TTL 181 s，过期后重新建单照常
     下发新码）→ **不做**本地到期计时回退；改的是渲染层：`expired` 到达当场撤掉旧码
     （不可扫的码绝不留在屏上）、提示 `QR_REFRESH_NOTICE` 由 `qrNotice` 保管并挺过新 `pending`、
     容器本身可点刷新（可达名字 `QR_REFRESH_LABEL`，点击 = `startQr`）。同轮修两个 sidecar 语义：
     手动刷新 = 活动会话期间重启（迟到的旧会话事件按身份丢弃）+ 换码链读当前那张的 `qrCode`；
  3. 网页登录那条路**有返回路径**：窗开着时次要入口变形为「返回扫码登录」并挪进那条唯一可见的
     48px header，点击走 `auth:cancel-login`（关窗）→ 那条路的收场广播 → R18 的 `returnToQr`
     回到二维码态并重新发码。§3 增补四行常量。
  探针侧增补 `scripts/probe-qr.mjs --until-expired`（可复现的档位观测）；
  `npm run verify:live` 增补三条可量断言（header 无可见文字 / 刷新容器有可达名字且可点 /
  正常路径恰好两个可操作元素），外加一个**显式开关** `--check-back-path` 走一遍"打开→返回"。
  **仍未联调**：真机 verify:live（含 `--check-back-path`）由控制器/用户在场所跑。
- 2026-10-20（Task R21）：**用户指令推翻 R16/R20 的"过期自动换新"**，改成"倒计时 + 过期态
  不可扫 + **只能手动刷新**"三条：
  1. **过期倒计时**：`expiresInMs`（建单应答与 `auth:qr` 广播都带）在渲染层换算成本地到期
     时刻，二维码下方按秒显示（`剩 x 秒过期`）。**过期判定仍以服务端 `expired` 广播为权威**：
     本地数到 0 只说「正在确认过期…」，不撤码、不改档（实测服务端在本地归零前就给 `103000201`，
     所以这一档是罕见兜底）；钟在渲染层（纯函数 reducer 只吃注入的 `tick`），本地到 0 后
     reducer 返回同一状态对象 → React 不再重渲染（表停在 0）；
  2. **过期后不能扫**：协议层 `expired` 变成**终点**（`stop()` + 只广播，**不再 `create()` 新单**），
     渲染层撤下 canvas、原位写「二维码已过期」、状态行说「二维码已过期，点击刷新。」；
  3. **只能手动刷新**：过期**不**重新武装自动发起，换新由用户点击二维码容器（R20 已有）或
     过期态那个显著的「刷新二维码」按钮触发——两者与自动发起走同一个 `startQr`
     （= `auth:qr-start`，端口本来就是 restart 语义）。
  R20 的 `qrNotice` / `QR_REFRESH_NOTICE`（「已刷新，请重新扫码」）**整条删除**：不再自动换新，
  就没有"刚换过一张"这一刻。§1.8 增补 R21 段、§3 换四行常量（含删掉 `QR_REFRESH_NOTICE`、
  改写 `QR_REFRESH_LABEL` 那一行）。验收脚本**未改**：`verify:live` 的"正常路径恰好两个可操作
  元素"说的是 `pending` 那一档（新增的按钮只在 `expired` 出现），它的"已知状态行"是从逻辑模块
  现算的（`Object.values(QR_GATE_STATUS)` 喂 `loginGateStatusLine`），自动跟着新文案走。
  **仍未联调**：真机点一次过期态的刷新按钮（`npm run verify:live`）由控制器/用户在场所跑。
- 2026-10-20（Task R22）：**用户真机反馈两项**（① 倒计时到 0 后卡在「正在确认过期…」一直不过期；
  ② 过期时间正确性），§1.8 增补 R22 段，**只改协议层、渲染层一行未动**：
  1. **TTL 无偏差换算**：`expiresInMs = expiredTime − qrCodeCreateTime`（两个服务端值相减，
     免疫本地时钟偏差——老公式 `expiredTime − 本地 now()` 在本地钟快 1 小时时得到 `0`，
     倒计时一上来就归零，**这就是反馈 ① 的现场**）；缺 `qrCodeCreateTime` 时回退老公式并留注释记偏差风险；
     字段不可信/两值矛盾 → `null`（不猜）；
  2. **卡死三层修**：连续 5 个认不出的 `resultCode` → 熔断成 `failed`（`unknown_result_code`）；
     本地到期锚 + **15 秒**宽限兜底 → 主动转 `expired`（停轮询 + 广播；服务端 `expired`/`scanned`/
     `confirmed` 一律优先，无可信 TTL 时不设锚点）；轮询**每轮**记一行脱敏 `resultCode`（进 stderr）；
  3. §3 增补三行常量（`QR_DEFAULT_MAX_UNKNOWN_CODES`、`QR_LOCAL_EXPIRY_GRACE_MS`、
     `QR_TTL_DIFF`/`QR_TTL_LEGACY` 两条路的说明）。
  测试：`test/qr-login.test.mjs` +14、`test/qr-port.test.mjs` +2（全量 658 → **674 / 0 fail**）。
  **仍未验证**：真机上两个现象是否真的消失（需一次真会话 + 一次偏钟环境），登记在 KNOWN_LIMITATIONS B14。
- 2026-10-20（Task R23）：**用户指令"网页登录仍然是打开一个新界面，还是没有返回的按钮——其应该是在
  程序中跳转"**。宿主从"独立子窗"换成**主窗里的第二个 webview**（`WebviewBuilder` + `Window::add_child`，
  label `login`）；应用自己的 header（含「返回扫码登录」）因此始终可见可点。§1.7 改写（宿主形态 +
  几何是客户区相对物理像素 + `closed` 语义 + 两层来源守卫 + 构建代价），§2.7 的守卫名同步。
  四处要点：
  1. **几何**：`login::layout_target(client_width, client_height, topInset×scale)` —— 入参是客户区
     物理像素尺寸，输出 `x` 恒为 0、`y = topInset`。跨窗那套"屏幕位置 + 缩放比换算"整条消失
     （R7 真机几何偏差的根因就在那条路上）；
  2. **来源守卫按 webview label**（安全前提）：同窗之后 `window.label()` 对登录页恒为 `main`，
     命令面因此一律取 `tauri::Webview` 并判 `webview.label()`（`require_main_webview`，9 条命令）。
     第二层：官方页是远程来源 → 无 ACL 条目一律拒（出处见 §2.7）；扫描用例把"不许退回按窗口 label 判"
     钉死（`commands.rs` 单测 + `test/tray.test.mjs` / `test/lyrics-window.test.mjs`）；
  3. **构建代价**：`add_child`/`WebviewBuilder` 需 tauri 的 `unstable` feature（`Cargo.toml` 已开）——
     它把**每个**窗口的内容 webview 建成 `WindowChild`，主窗/歌词窗改用"显式 bounds + 比例跟随"。
     这是 Tauri 支持的既有模式（`WebviewWindow` 两种模式都工作），但真机观感须用户验收（B16）；
  4. 策略层**一行未改**：导航白名单 / `hms://` 拦截 / `on_new_window` Deny / 双期限 / take-once 结论槽 /
     一次性数据目录 + 退避删除 / 先答复再拆 —— 只换了承载与坐标。渲染层与 sidecar **一行未改**。
  测试：cargo 201+1 → **204 pass + 1 ignored**（新增 4 条：宿主形状、label 相异、客户区相对几何、
  守卫扫描；删掉 1 条随宿主消失的 `show()` 回滚用例，见报告 §自审）；node 674 / 0 不变。
- 2026-10-20（Task R24）：**真机证据：登录页被摆成 `rect=(0,48,320,160)`，而主窗是 1280×800**。
  先核实（vendored 源码 + 真机窗口树），再修：
  1. **单位真相**：`Window::inner_size()` = tao `GetClientRect`（**物理**像素客户区）、
     `Window::scale_factor()` = DPI 缩放比、`add_child`/`set_position`/`set_size` 收的也是**物理**像素
     且相对父窗客户区（wry `webview2/mod.rs:1553-1560`）⇒ R23 的换算**本来就是对的**
     （简报里"疑似被 4 除"经核实**不成立**：同一个进程里 09:08:56Z 那次就是对的
     `rect=(0,48,1280,752)`）；
  2. **真根因**：主窗**最小化**时 `inner_size()` 是 `(0,0)`（真机窗口树：`client=0x0 iconic=True`），
     而 R23 只有一种输出——把任何输入都钳成 `MIN_LOGIN_WIDTH×MIN_LOGIN_HEIGHT`。于是"量不到"
     变成了 320×160 的**假盒子**：创建时一次（`rect=(0,48,320,160)`），跟随每 250ms 又一次
     （真机工作实例里那个先摆对成 1280×752、随后被跟随改成 320×160 的登录 webview 就是它）；
  3. **修法**：几何决策长出第二档 `Layout::HostUnmeasurable`（`login::layout_for`）——量不到**没有几何**：
     创建路先 `focus_main`（unminimize + show + set_focus，与托盘/单实例同一动作）再量一次，仍量不到
     则结构化失败（绝不建假盒子）；跟随路保持登录页现有几何，等主窗回来重摆；
  4. **诊断**：创建那一次与跟随的每次状态翻转都记一行**原始读数**
     （`inner_size=(1280,800) scale=1 minimized=false`），事后不再只能看到钳过的结果。
  测试：cargo 204+1 → **211 pass + 1 ignored**（lib 184→190、login_policy 16→17）；node/tsc/vite/
  acceptance 不变。真机复验项见 `KNOWN_LIMITATIONS.md` B16。
- 2026-10-20（Task R25）：**用户四项指令**——① 过期遮罩只两行「二维码已过期」/「点击刷新」、
  删掉过期态那个刷新按钮（点二维码容器刷新保留）；②「返回扫码登录」悬浮在网页左上角
  （不独占一行、不挤压网页）；③ 登录 webview 铺满主窗（不再让出 48px）；
  ④ 登录页右上角加「黑白主题 + 系统默认」（浅色 / 深色 / 跟随系统）——gate 视图与嵌入官方页
  打开时都要有。四条都落在 §1.7 与 §3：
  1. **几何**：`layout_target(client_width, client_height)` = `(0, 0, w, h)`；`host:open-login`
     的载荷与 Rust 的 `LoginConfig` **不再有 `topInset`**（`MAX_TOP_INSET` 一并删除），
     `LOGIN_VIEW_TOP_INSET` 只剩门禁自己那条 header 消费（Rust 不再镜像，parity 反向钉住）；
  2. **两个浮动 webview**（建在登录页之后 ⇒ z 序在上、透明背景 `Color(0,0,0,0)`、
     与登录页共用 webview 数据目录、随它同生同灭、只许停在本地页面上）：
     `login-return` 左上 / `login-theme` 右上，共用一个本地入口 `login-chrome.html?kind=`；
     `login-return` 建不起来 = 这次登录结构化失败（它是唯一的回退路径），
     `login-theme` 失败只留痕；
  3. **专用命令 `core_login_chrome`**（`{action:"return"|"theme", theme?}`，两条动作）+
     **专用来源守卫** `require_login_chrome_source`（只放 `main`/`login-return`/`login-theme`；
     **官方登录页不在里面**）。`core_call` 那条守卫一个字未放宽——它管的是全部业务频道；
  4. **主题三态**（`theme.rs` + `settings.json` 的 `theme` 键 + `theme:changed` 广播 +
     `.light`/`.dark` 两个类）：状态归 Rust 持有，三个 webview 各自把类落到 `<html>` 上，
     切类只有 `features/theme/theme.mjs` 一处；CSS 侧媒体查询改成 `:root:not(.light)`，
     `dark:` 变体的媒体分支改成 `&:not(.light, .light *)`（强制浅色时不许漏进暗色工具类）；
     渲染层的主题控件（`theme-control.tsx`）在 gate 与浮动控件里**是同一个组件**；
  5. **过期态**：占位只有两行（`QR_EXPIRED_BOX_TEXT` + `QR_EXPIRED_BOX_HINT`），
     `QR_REFRESH_ACTION_TESTID` 与那个按钮一起删除；`QR_REFRESH_ACTION_TESTID` 在 §3 里划掉。
  测试：cargo 211+1 → **229 pass + 1 ignored**（lib 190→206、login_policy 17→19；
  新增 theme.rs 6 条 / login.rs 4 条 / commands.rs 3 条 / lib.rs 2 条）；
  node 674 → **689 / 0 fail**（新增 `test/login-chrome.test.mjs` 11 条 + 各处同步）；
  tsc 0 错、vite 三入口构建通过、acceptance 6/0/0。真机复验项见 `KNOWN_LIMITATIONS.md` B17。
- 2026-10-20（Task R26）：**用户四项（真机反馈）**——①+② 官方登录页跟随应用主题（深色）；
  ③ 二维码倒计时到 0 之后「正在确认过期…」等太久；④ 过期态状态行不再复述遮罩那两行。
  四项都**先写失败测试再修**，证据与选型如下：
  1. **①+② 官方页主题**：先 probe 实测（结论见 §1.7 的 R26 段：`themeName` 由**服务端**
     `getBaseSwitchInfo` 按 UA 裁决，桌面 UA 只放 {red,huawei,blue,lightred}，`dark` 一律回落
     `red`；系统深色还会被 CSS 强制白底）。按**用户裁决**只做机制、不伪装 UA：
     `login.rs` 新增 `LOGIN_THEME_PARAM`/`LOGIN_THEME_NAME_DARK`/`login_theme_name`/
     `with_theme_name`/`theme_reload_target`/`effective_login_theme`/`system_is_dark`/
     `reapply_login_theme`；`open_login` 打开时挂参数，`theme::set_theme` 改完重载已开着的页面
     （另起线程，值没变/白名单外都不重载）。**今天的结果如实登记为"看不到深色官方页"**（B18）；
  2. **③ 过期出口**：`QR_LOCAL_EXPIRY_GRACE_MS` 15_000 → **3_000**，兜底落点从"轮询落地"
     改成**建单/刷新时挂的一次性定时器**（`armLocalExpiry`，延迟 = TTL + 宽限）——归零之后
     最长等的不再是"一整轮轮询（实探往返约 8 秒）"，而是 3 秒；轮询落地点保留成第二张网，
     服务端一律优先（`scanned` 到达时那张网直接撤掉）；
  3. **④ 过期态状态行**：`QR_EXPIRED_NOTICE` **删除**，`loginGateStatusLine` 在 `expired` 档返回
     `null`，`login-gate.tsx` 把那一行**整行隐掉**（不渲染空话）——二维码遮罩那两行成为唯一提示载体；
  4. **测试基线的环境注记**：任务简报写的 `cargo 211/0/1` 是 **R25 之前**的旧基线。本轮**实测**：
     HEAD（R25 之后）= **229 pass + 1 ignored**（lib 206 + login_policy 19 + 另一目标 4，与 R25 报告
     逐字一致），本轮 = **235 pass + 1 ignored**（lib 206 → 212，新增 login.rs 5 条 / theme.rs 1 条）。
     量法：把 HEAD 的两个源文件临时换回 `src-tauri/src/`（`git show` 只读），跑完再换回来。
  测试：cargo **235 pass + 1 ignored**、node 689 → **695 / 0 fail**（qr-login +6、登录门禁若干断言改写）、
  tsc 0 错、vite 三入口构建通过、acceptance 6/0/0。真机复验项见 `KNOWN_LIMITATIONS.md` B18。
