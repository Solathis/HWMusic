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

### 1.1 协议参数（已确认 · 出处：用户指令 + 参考实现实测，勿改）

| 项 | 值 |
|---|---|
| `client_id` | `101444301`（**非本项目注册的身份**，极可能是华为音乐官方 App 的 OAuth 身份，随时可能失效） |
| `redirect_uri` | `hms://redirect_uri` |
| `scope` | **完整清单**（R32，用户指令逐字给出；空格分隔）：`openid` + `https://www.huawei.com/auth/account/{mobile.number,guardian.uid,country,base.profile,birthday,gender,accountlist.anonymous,accountlist}` + `https://www.huawei.com/auth/pay/walletinfo` + `https://www.huawei.com/auth/drive.file` + `https://www.huawei.com/default/scopes`（共 12 项，顺序即此顺序）。**注意**：参考实现默认只发 `openid`（那是它做最小实验用的集合），本项目的授权 URL 按用户指令发全量 |
| `access_type` | `offline` |
| `response_type` | `code` |
| `countryCode` | `cn`（R32；参考实测参数，缺了授权页按别的区域渲染） |
| `ui_locales` | `zh-cn`（R32；同上） |
| PKCE | `code_challenge_method=S256`，`code_challenge = BASE64URL(SHA256(code_verifier))`；verifier 43–128 字符 |
| `state` | 随机、一次性、回调时**常量时间**比对（`timingSafeEqual`）、10 分钟过期 |

代码落点：`src/protocols/auth.mjs`（常量 + `createAttempt` + `buildAuthorizeUrl`）、
`src/protocols/login-callback.mjs`（消费与编排）。

### 1.2 authorize 端点（已确认 · R32 换成参考实现实测值）

```
https://oauth-login.platform.hicloud.com/oauth2/v3/authorize
```

**R32 换血理由**：R4 探针登记的是 `https://oauth-login1.cloud.huawei.com/oauth2/v3/authorize`——
那次探测证明的只是"该域可达、该路径存在"（同一份 SPA 对任意路径都回同一份页面），**不证明**
"这是客户端该用的授权入口"。公开参考实现 `talongao/huawei-music-desktop`（`src/auth.mjs` +
`docs/API_CONTRACT.md`，2026-10-14 本人账号实验）用的是 **`oauth-login.platform.hicloud.com`**，
并且**真实走通过**"授权 → hms:// 回调 → 兑换 → 音乐会话"这条链。

代价不对称：用错主机的表现不是报错，而是授权页照常打开、`hms://` 照常回调，之后拿不到能用的令牌
——所以以"实测走通过的那一组"为准。旧值（`oauth-login1`）保留在 §1.4 的 `loginCallback` 精确例外里
（扫码路径的 CAS 回调仍然落在它上面）。

### 1.3 token 端点（已确认 · R32 换成参考实现实测值）

```
https://oauth-login.cloud.huawei.com/oauth2/v3/token
```

请求 `application/x-www-form-urlencoded`，字段与顺序逐字对齐参考：
`grant_type=authorization_code` / `client_id` / `redirect_uri` / `code` / `code_verifier`。
刷新令牌：`grant_type=refresh_token` + `client_id` + `refresh_token`（参考实测**不带** client_secret）。

**R32 换血理由**：与 §1.2 同一条——R4 只证明了 `oauth-login1` 那个路径存在（无效授权码回
`HTTP 400 {"error":1101,"error_description":"invalid code"}` 只能说明"端点受理了这个 client_id"），
而参考实测的兑换主机是 `oauth-login.cloud.huawei.com`。授权域与令牌域**本就是两个主机**，
把它们都打在同一个域上是 R4 的简化，不是事实。

R4 那次探测留下的两条结论仍然有效、也仍然重要：① 错误体是华为自有形态（数字 `error` +
`sub_error`），**不是** RFC 6749 的字符串错误码，所以错误处理只记录 HTTP 状态与 HTTP 层错误码；
② "身份被受理"不等于"该身份被本项目授权使用"。

### 1.4 登录域导航白名单（Node 侧唯一真源：`src/protocols/login-callback.mjs`）

```js
LOGIN_ALLOWED_ORIGINS = [
  "https://oauth-login.platform.hicloud.com",  // R32：授权入口域（authorize 端点所在主机）
  "https://oauth-login.cloud.huawei.com",      // R32：令牌兑换域（token 端点所在主机）
  "https://id1.cloud.huawei.com",              // R16：CAS 门户域（授权页的落地页，见下）
  "https://account.huawei.com",                // R32：参考清单条目
  "https://consumer.huawei.com",               // R32：参考清单条目
]
LOGIN_ALLOWED_URLS    = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"]  // 精确例外
```

- 是**显式条目表**，不是 `*.huawei.com` 通配（`test/login-parity.test.mjs` 扫源码禁止通配写法）；
- **R32 换血**：条目 = 参考实现 `LOGIN_HOSTS` 那五个域。理由与 §1.2 同源——授权入口换主机之后，
  整条跳转链的域跟着换；而 R16 那条教训恰恰是"**漏一个域 = 窗里一片空白**，且只有真机才看得出来"，
  所以按参考那份**实测走通**的清单来，而不是按我们的旧观测补丁；
- `oauth-login1.cloud.huawei.com` 从"整域放行"**降级**为 `loginCallback` 精确例外（保留）：
  扫码成功后回调落到这里，漏掉它就会卡在 CAS 页（旧仓历史故障根因，也是 §1.8 二维码路径的关键落点）；
- `login.cloud.huawei.com`（旧 CAS 域）**移出**：它是 oauth-login1 那条链的域，参考清单里没有；
- **不放 `oauth-login2`**：换区域主机属显式决策，默认不放行；
- **R16 保留**：`https://id1.cloud.huawei.com` —— 实探（`scripts/probe-qr.mjs` 的 ③/④ 步，
  `.probe/qr-probe.json`）证明 `POST /oauth2/ajax/getLoginWay` 的响应把浏览器送到
  `https://id1.cloud.huawei.com:443/CAS/remoteLogin?…` → `/CAS/portal/loginAuth.html`。
  授权页自身是空壳 SPA，它拿到 `loginType = TICKET` 后就 `location.href = <casLoginRedirectUrl>`；
  这条导航原先被拦下，窗里就永远停在什么都没渲染的授权页上。**端口 443 是默认端口**，
  `Url::origin()` / `URL.origin` 归一化后都不带端口，所以一条 `https://id1.cloud.huawei.com`
  同时覆盖 `:443` 的写法（两侧测试都钉了）；
- **注**：bundle 里同时存在 `/oauth2/v2/loginCallback`。本项目只放 v3（审计事实点名的那个）。
  若观测到回调真的落到 v2，必须**带证据**显式加条目并同步 parity 测试，不得改成通配。
- Rust 侧镜像（`src-tauri/src/login.rs` 的 `LOGIN_ALLOWED_ORIGINS`）与互钉测试已落地：
  改一侧就必须改另一侧 + `test/login-parity.test.mjs` + `src-tauri/tests/login_policy.rs`。

历史证据（R4 探针，仍在 §0 的产物里可复现，只是**不再作为端点真源**）：
`oauth-login1` 域对任意 GET 路径返回同一份 SPA（14581 B，`sha256_16=94bf249ba7a6facf`），
bundle（`/static_rss_vue3/js/index-legacy-*.js`，213575 B）里逐个列出 `"/oauth2/v3/authorize"`、
`"/oauth2/v2/authorize"`、`"/oauth2/v3/loginCallback"`、`"/oauth2/ajax/getLoginWay"` 等 22 条路径，
完整清单见 `.probe/login-probe.json` 的 `bundleEndpoints`。这组观测解释的是"路径存在性"，
不是"客户端该用哪个主机"。

### 1.5 令牌链的后续环节

| 环节 | 状态 | 说明 |
|---|---|---|
| 授权码 → 账号 AT/RT（token 端点，带 `code_verifier`） | 已确认（§1.3） | — |
| 账号 AT → **音乐会话**（旧仓称 `loginex`，请求带 Digest 头） | **端点已确认（R17）；兑换往返仍未实测** | 见下方 §1.5.1：端点 URL、请求形状、Digest 头形状都有公开证据，且**端点存在性经本机实测**（405 / 对照 404 / 无效 AT → 200 + 业务码）；但"有效 AT 换到真会话"要用户授权扫码，本仓**没跑过** |
| 账号 AT 有效期 | 审计事实 ≈ 1 小时 | 未实测；`isTokenExpired` 默认提前 60 秒判过期 |
| 音乐会话有效期 | 审计事实 ≈ 7 天（到期字段提示） | R75 起按 `expireTime`（按北京时间解读，推断）判到期：到期回登录页并说明原因；自动续期未打通，到期需重扫 |
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
`expireTime` 在会话记录里仍保留 14 位原始串；R75 起读取时由 `musicSessionExpiresAt` 按北京时间（`MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES = 480`）换算成到期时刻。这是推断：session.enc 写于 2026-10-21T07:52:23Z，按北京时间算 7 天后的到期时刻（10-28 15:52）早于用户看到空列表的 17:30，按 UTC 算（23:52）则矛盾；官方未确认（KNOWN_LIMITATIONS B33）。

**③ 仍未实测（本仓 untested，一条不漏）**

| # | 项 | 为什么没验 |
|---|---|---|
| 1 | 用**有效** AT 换到真音乐会话（业务码 `000000` 那一档） | 需要用户授权扫码（用户在场的授权动作），本仓不代扫 |
| 2 | `snsUserID` / `expireTime` 的真实取值与**时区** | 依赖第 1 条 |
| 3 | 该 AT 是否被本客户端（`client_id=101444301`）签发的会被受理 | 依赖第 1 条 |
| 4 | 音乐会话有效期与失效行为 | 依赖第 1 条；自动续期本来就没打通 |

**顺带记录的音乐业务端点**（同为上述公开来源）**R32 起已经接进代码**：逐端点的路径 / 方法 /
参数 / 响应容器 / 归一化规则见 §2（那里是业务接口的唯一真源）。R17 时它们只是"记录在案、不接线"，
理由是"路径可能存在 ≠ 请求形状已确认"——R32 拿到的正是**请求与响应形状**，所以接线了。
**仍然没有实测的**是"用本项目的账号走完这些请求"（见 §2.1 第 3 条那张表）。

#### 1.5.2 账号资料 / 会员到期：**没有可用端点（R57 结论：不可行）**

问题：恢复会话时（账号 AT 早已过期，手里只有 1 小时 AT 换来的音乐会话）能不能拉到"名字 / 头像 /
会员到期时间"？结论是**不能**，三条证据都指向"没有这条端点"，因此**不猜端点、不猜字段**：

1. **官方没有可读的 H5/Web 音乐前端**：`music.dbankcloud.cn`、`music.dbankcloud.com`、
   `www|web|h5|m|api|portal.music.dbankcloud.cn`、`music-{h5,web}-*.hicloud.com` 等 12 个候选主机
   全部 `ENOTFOUND`（40 次 DNS 查询，零 HTTP）；可达的两个都与此无关——
   `music.hicloud.com` 是华为官网的音乐**营销页**（静态站，脚本经 Referer 才放行，无任何资料接口），
   `music.cloud.huawei.com` 是网关错误页（`An error occurred. code: 4xx`）。
   ⇒ 简报优先要求的那条路（下载公开静态 JS 找 userinfo/会员端点）**在本产品上不存在**。
2. **公开参考实现没有这个端点**：`.tmp/reference-repo` 全库出现的音乐服务路径共 15 条（favorite /
   playlist / recentlyplayed / search / album / artist / play / recommend / loginex），
   **userinfo 只有 `loginex` 一条**；其研究文档里那句"本人资料接口返回 `memberShip=6`"**没有留下路径**。
3. **本机只读探测 15 条候选路径全部 404**（用 `.tmp/live-data` 的已登录会话，共 17 次请求、
   间隔 ≥1.2 s、只发读查询、从未碰写端点；2 次对照为收藏最小页 200 + `resultCode:000000`，
   证明会话/头/网关都是通的）：见 §2.6 的 R57 段列出的 15 条路径。**404 是真答复，不是会话问题**。

**为什么不能退而求其次"登录时多存一份"**：登录期只有 `loginex` 一个来源，它的**顶层 13 个键已证没有
名字/头像**（R38/R40 真机取证），而 `queryAllSubInfoResp` / `queryAppConfigDetailResp` 两个容器内部的键名
**至今没有证据**（R40 的键名日志随日志轮转丢失）。所以现在既不新增候选键，也不新增刷新流程；
下次扫码登录时 sidecar 会记下那两个容器的**键名**（只记键名、不记值），那才是"能不能补"的下一步证据。

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
- **登录页零命令权限**：main capability 只含 main，lyrics capability 只含 lyrics（事件/自窗拖动）；均不含 login。
  不给登录页注入任何脚本（不订阅 `initialization_script`/`eval`）：白名单与回调**只靠导航事件**观测。
- **来源守卫判 webview label**：同窗之后 `window.label()` 对登录页恒为 main，命令面必须取 `tauri::Webview` 并判 `webview.label()`。
  1. `commands::require_main_webview`——只放 main，core_call 与歌词 toggle/document/progress 不放宽；
  2. `commands::require_login_chrome_source`——只放 main/login-return/login-theme；官方 login、lyrics、tray 均拒绝；
  3. `lyrics_window::require_lyrics_source`——仅 configure/control 专命令放 main/lyrics，载荷字段白名单，lyrics 不可恢复盘上快照。
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
core_login_chrome {action:"theme"}                        → {theme: "light"|"dark"|"system", revision}   （读回）
core_login_chrome {action:"theme", theme:"light"|...}     → {theme: ..., revision}                        （改 + 广播）
```

- 回执是**事实**（不是"已受理"）：取消那条读的就是结论槽是否真的收口了一次进行中的登录；
  改主题那条回的是**实际生效**的档位（落盘失败走结构化错误，不静默改档）。
- 认不出的 `action`/档位一律结构化 `invalid_payload`（不猜）。
- 主题状态归 **Rust** 持有（`settings.json` 的 `theme` 键），改完广播 `theme:changed`
  （`{theme, revision}` 目标态）——主窗、两个浮动控件与歌词窗各自把类落到 `<html>` 上（`features/theme/theme.mjs`）。
- **R44e：`settings.json` 的唯一写者是 sidecar**（`src/main/settings.mjs` 的 `writeTail` 尾链）。
  Rust 不再自己 read/rename 这个文件——两个写者各自"读旧文档 → 改自己那一键 → rename"会互相覆盖
  （原子替换不等于串行读改写）。主题改盘走**内部** `settings:set`（`commands::settings_write_owned`），
  与代理/队列/歌词配置排在同一条尾链上；启动时仍只读 `parse`/`read`（缺文件回默认，坏文件不覆盖）。
- **整笔主题事务由 Rust 拥有**：接受补丁 → 置 uncertain → 内部 `settings:set` → 校验回执里的主题 →
  确认后更新内存/原生/revision → 广播。写可能已发出但没等到回执（超时）时，那一笔在确认提交前保持
  uncertain（**不能把超时当没写**）；退出前会重存一次当前权威主题来消除它。invoke 的等待者消失
  （WebView 导航/组件卸载）**不会取消**后半提交。
- 读回与广播都带**单调 revision**：三个消费者共用纯函数 `acceptThemePayload`（旧回执不许盖掉新广播；
  没有编号的老载荷照收但不把水位往回退）。读回失败时，已经收到过带编号答案的界面**不回落**系统档。
- 保留键：`core_call(settings:set)` 明确拒直接 patch `theme` / `lyricsWindow`
  （`forbidden_source`）——绕过运行时只会造成盘上写新、内存/广播/原生仍旧的两份真相。
  `proxy` / `queue` / `closeBehavior` / `reset` / 未知键照旧可写。
- R44a：建主窗时 `builder.theme(current_theme.to_native())` 恢复原生标题栏；light/dark 分别为
  `Some(Theme::Light/Dark)`，system 为 `None`（无 Theme::System，不强制为浅色）。确认落盘后调用
  主窗 `window.set_theme(...)` 再广播网页，不重建或注入官方登录页。原生调用失败返回结构化 `internal`，
  明确说明主题已保存并广播、原生应用失败；不回滚已写值，下次建窗重试（R44e 保持这条 A 语义）。

**渲染层 ← sidecar 的登录状态广播（R7 增补的广播频道）**

```
auth:status → {loggedIn: boolean, busy: boolean, message?: string,
               profile?: {userName?: string, avatarUrl?: string, vip?: boolean,
                          vipExpiresOn?: string}}
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
- **可选 `profile`（R38 增补，左下角账号区；R40 加两个来源）**：来自三处**认得出**的那几项
  （`src/main/music-session.mjs`）：
  ① loginex 响应（`profileFromResponse`：名字候选 `userName`/`nickName`/`nickname`，
  头像候选 `headUrl`/`headImage`/`avatarUrl`/`avatar`/`head` 且**必须过 CDN 白名单**，VIP 只认
  明确的布尔或有实测证据的 `memberShip` 含 `6`；R40 起还会往两个**有名字的容器**
  `queryAllSubInfoResp` / `queryAppConfigDetailResp` 里读**一层**——简报指定的防御式接线，
  **不是证据**）；
  ② **id_token 的 claims（R40）**：token 响应的顶层键名里确实有 `id_token`（真机 15:52 取证），
  而 loginex **顶层没有**用户名/头像（同一次取证的顶层键名共 13 个，没有一个是名字/头像）。
  协议层按 OIDC 的 `header.payload.signature` 解码 payload 段（`idTokenClaimsOf`：三段式
  base64url 才认，坏形状回 `null`、**不抛**、**不验签**），取 `name`/`nickname` 与
  `picture`/`avatar`（头像同样过白名单）；**VIP 不从 claims 取**（claims 里没有有证据的会员字段）。
  loginex 那份**优先**，claims 只补空缺（`mergeProfiles`）。
  **认不出就不带这个键**（也就不显示）——旧会话（R38 之前登录的）没有 `profile`，
  界面如实显示兜底（头像占位 + "已登录"）。
  **不新开频道**：Rust 的频道常量表是硬钉的 parity，状态里多一个可选字段不必动 Rust。
  这条链的响应形状一直缺实证，所以兑换点加了**只记键名**的日志（token 响应顶层 / `id_token`
  claims / loginex 响应顶层 / loginex 两个容器的一层；**值一律不进日志**），
  会话记录里只多一个由它们提取出的 `profile`（**claims 原文与 id_token 都不落盘**）。
- **可选 `vipExpiresOn`（R57 增补，「会员 · 至 2026-12-31」的那个日期）**：**本项目自己的字段，
  不是服务端键名**。只认「能显示成某一天」的形状（`YYYY-MM-DD` / `YYYYMMDD` / 14 位
  `YYYYMMDDHHMMSS` 取日期段），校验在 `src/shared/vip-expiry.mjs` 一处；认不出就**不写**
  （界面只说"会员"）。**当前没有任何生产者**：R57 的端点调研结论是**不可行**（见 §1.5.2），
  所以恢复期与登录期都不会填写它；界面与守卫用注入载荷覆盖这一档。
- **§1.5.2 R57 端点调研结论：拿账号资料/会员到期的（恢复期可用）端点是「不可行」**。
  证据分三条：① 官方**没有**可下载的 H5/Web 音乐前端——`music.dbankcloud.cn` / `music.dbankcloud.com` /
  `web|h5|m|api|portal.music.*` 等 12 个候选域名全部 **ENOTFOUND**，仅 `music.hicloud.com`（华为官网音乐
  营销页，Joomla/Vue 静态站）与 `music.cloud.huawei.com`（网关错误页）可达，两者都没有账号资料接口；
  ② 参考实现（`.tmp/reference-repo`）全库只有 `loginex` 这一个 userinfo 路径，没有任何资料端点；
  ③ 用 `.tmp/live-data` 的已登录会话做了 **17 次只读探测**（含 2 次对照），15 条候选路径
  （`music-odpapp-service/v5/service/userinfo/{query,detail,getuserinfo,queryAllSubInfo,queryAppConfigDetail,getUserInfo,queryUserInfo}`、
  `music-userbasic-service/v1/service/userinfo/{detail,query}`、`music-user-service/v1/service/user/info`、
  `music-userbehavior-service/v1/service/userinfo/{query,get}`、`music-social-service/v1/service/userinfo/query`、
  `music-member-service/v1/service/membership/detail`）**全部 HTTP 404**，而同一轮的对照
  （`favorite/simple/all` 最小页）**200 + `resultCode:000000`** ⇒ 会话与 Digest 头都是通的，404 是真答复。
  **结论：不猜端点、不猜字段**；恢复期刷新流程不实现，界面维持兜底；
  会员到期只在有证据的字段出现时才显示。详细过程见 `.superpowers/.../task-57-report.md`。
- **可选 `restoring: true`（R53 增补）**：**快照与恢复期间的广播都可能带 `restoring:true`；恢复结论广播不带**。
  sidecar 先建 RPC（注册 `auth:get-status`）再 `await restore()`，而 restore 要发一次网络验证（真机 1–3 秒）；
  渲染层挂载即查，那一问落在恢复期间，此时会话还没读出来——`{loggedIn:false}` 的普通载荷会被门禁当成
  **结论**（画登录页并自动建码）。带 `restoring:true` 的载荷渲染层当 `checking`：中性启动屏、不发码。
  恢复期间除 `concludeRestore()` 之外的广播（取消、失败……）都不是结论，因此也带这一格；
  只有恢复落定那条播出去时不带（清位之后构造载荷）。
- **会话到期（R75）**：恢复读到会话后先按 `expireTime` 判到期；已到期就不发验证请求（到期会话服务端照样回 200 + `000000`、只是不给数据，验证器验不出来），恢复档位记 `session_expired`，`auth:status` 带「音乐会话已于 X月X日 HH:mm 到期，请重新扫码登录。」，session.enc 不删。sidecar 的业务会话来源是 `activeSession()`，`auth:get-status` 的快照也先判一次：运行中到期就收回会话、epoch 前移并广播同一句话。渲染层把它存进 `sessionNote`，新码准备中与等待扫码时一直显示，扫码后让位、登录后清掉；会话从已登录转未登录时复位 `qrAttempted`，二维码重新自动出现。恢复与登录成功各记一行「会话到期：expireTime=…（按北京时间 …），已过/还剩 … 小时」。
- **登录态确立即停二维码（R53）**：每一份"已登录"的 `auth:status` 播出去之前，sidecar 会停掉在跑的
  二维码会话（停轮询 + 作废待兑换的尝试）。这一处是所有来源的收口：restore 成功 / 扫码确认收尾成功 /
  网页登录成功。渲染层另有 `auth:cancel-qr`（见 §2.11）在门禁收场时停一次。

**已知缺口（R7 如实登记，不硬绕）**：wry 0.57（tauri 2.12 的 webview 层）只注册 WebView2 的
`NavigationStarting`（主框架级），**没有** `FrameNavigationStarting`。官方页若从 **iframe** 内部发起
`hms://` 跳转，Rust 侧看不到（顶部框架跳转与 302 都能看到）。关闭它要么等上游提供帧级事件，
要么注入脚本监听——后者是硬边界明令禁止的（登录页零注入）。兜底：总期限仍会收口，不会永久挂住。

**官方登录页的主题（R26 实探 · 可复现 · 结论带边界）**

> **R28 口径（2026-10-20，按用户指令移除）**：这一节与下一节描述的**机制代码已经整体删掉**
> （R26 立起、R27 改档，R28 按用户指令撤销）——官方登录页**不再跟随应用主题**，它就按自己的
> 默认渲染；登录 webview 也**不再伪装 UA**。下面这些**实测结论仍然成立**（它们说的是服务端与
> 页面的行为，不是我们的代码），只是**没有一条通路在用它们**了；落点那几条改成历史记录。
> 撤销的清单与理由见本节末的 **R28 段**。

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

**落点（R26 立 → R27 改档 → R28 按用户指令整体移除；下面是历史记录）**：
1. **三态映射**（当时的 `login::login_theme_name`）：`dark` → `themeName=dark`；`system` → 主窗
   `Window::theme()` 读一次系统深浅（读不到按浅色，保守一侧）；**`light` → 不动这个参数**；
2. **打开时挂上**：`host:open-login` 落进 `open_login` 时按当前主题把参数挂到那条授权 URL 上；
3. **切主题时重载**（R27 改成"关掉重开"）：`theme::set_theme` 改完并广播之后把**已经开着**的
   登录页按新主题来一次。**不做**系统主题的实时监听。
4. **R26 当时如实说明的结果**：桌面 UA 下服务端仍然回落 `red`，所以"深色档"看不到深色官方页
   （这条是服务端边界，不是实现问题）。

**未实测（如实登记 · R28 起作废）**：真窗上"切主题之后官方页重载一次"的观感（本环境起不了
真窗）、真实登录链路上这条参数的影响（需要真实账号；探针只到公开页面为止）——**这两件事随着
机制被撤销而不再需要验**（没有这条通路了）。

> **R28 撤销（用户指令 2026-10-20）**：上面四条**全部移除**——`login.rs` 里与主题相关的常量、
> 纯函数、打开时的参数注入、切主题的重开链（含建窗参数、重建窗口）一个不留，`theme::set_theme`
> 也不再碰登录页。**理由**：官方登录页归官方，应用主题只该影响自家 UI。细节见本节 R28 段。

**官方登录页的真深色 + 屏外加载（R27 实探 · 可复现 · R28 按用户指令推翻其中"伪装 UA"那一项）**

> **R28 口径**：第 1/2/3/5 条（移动 UA + 主题取值 + 关掉重开 + 代价）**已按用户指令整体移除**：
> 登录 webview 回到宿主默认 UA，官方页不再跟随应用主题。第 4 条（屏外加载）**留着**，
> 但"什么时候摆进内容区"的判据在 R28 换成了**静默窗**（见下面的 R28 段）。

用户指令（R27 之 1+2，2026-10-20）：①"切换深色后官方页仍是白色"**继续修**——控制器裁决
**推翻 R26 的"不伪装 UA"**，登录 webview 改用 HarmonyOS 移动 UA；②点"在网页中打开登录"之后
官方页加载慢（数秒白屏）——**加载动画**。

复现：`node scripts/probe-login-mobile-ua.mjs`（摘要在 `.probe/r27-mobile-ua-probe.json`，已
gitignore；`--no-browser` 只跑公开接口那两段）。**只碰公开页面与公开接口**：不登录、不输账号、
不提交凭据、不扫码；`state` 与 `code_challenge` 是探针自己的一次性/占位串。

交付的探针跑 5 条链路变体（桌面 UA 对照 + 4 个移动候选）+ 45 组服务端裁决（9 个 `themeName` 取值
× 5 类 UA）+ 10 档真浏览器计算样式。**结论**：

| # | 问题 | 实测结果 |
|---|---|---|
| ① | 移动 UA 下链路每一跳变了吗？白名单要不要补？ | **逐跳相同**：`getLoginWay` 200 → `/CAS/remoteLogin` 302 → `/CAS/portal/loginAuth.html`，hosts 全在白名单内（4 个移动候选 + 桌面 UA 五条链的 `hostsOutsideWhitelist` 都是 `[]`）→ **白名单一个字都不用改** |
| ② | 移动 UA 下服务端认哪些 `themeName`？ | 认 **{red, huawei, blue, harmony, dark, harmonydark}**；**认不出的值一律回落 `huawei`**（桌面 UA 则一律回落 `red`）。所以移动档的"默认浅色"就是 `huawei`，而 `lightred` 在移动档**回落成 `huawei`**（桌面档它是自己的一个值） |
| ③ | 哪个值给出真黑底？ | **`dark`**：页面加载 `index-dark.css`，body `rgb(0,0,0)`、`.hwid-root` `rgb(0,0,0)`（1280×752 与 390×844 两种尺寸下一致）。**`harmonydark` 不行**（加载了 `index-harmonydark.css`，但 html/body/root 三段背景全是 `rgba(0,0,0,0)` 透明 → 露出来的是宿主底色，不是真黑） |
| ④ | 不带参数（想靠"跟随系统"）行吗？ | **不行，而且危险**：移动 UA + 无参数 + 系统深色 → 页面自己拿 `prefers-color-scheme` 去问服务端，拿到 `index-dark.css` + `rgb(0,0,0)`——**应用当时处于浅色档**。于是"浅色档不挂参数"在移动 UA 下不再等于浅色（这正是 R27 把 [`login_theme_name`] 从 `Option` 改成"三态总有值"的原因） |
| ⑤ | 移动版式长什么样？用户在窗里能做什么？ | 页面按 `isMobileWap()` 换成 `login/mobile/index`：**8 个输入框**（账号/密码、手机号/短信验证码、隐藏 `hwmeta` 等）+ 「短信验证码登录」/「忘记密码」/「登录」/「注册账号」；**没有可见的二维码入口**（`qrMarkers` 只剩 `qrcode` 这个类名，桌面门户页那一档才有「二维码」/「扫一扫」/「扫码」三种标记 + 1 个 canvas + 2 张图） |

**落点（R27 立 → R28 按用户指令移除第 1/2/3/5 条、保留第 4 条并改判据）**：
1. ~~**UA 伪装**：登录 webview 建窗时设置 UA~~（**R28 移除**：建窗不设 UA，WebView2 用自己的
   默认桌面 UA。原话：这里曾经设过一条 HarmonyOS 移动 UA，字面量见本文件 §5 的 R27 条）；
2. ~~**三态总给一个具体值**~~（**R28 移除**：主题取值与参数注入一起没了）；
3. ~~**切主题 = 关掉重开**~~（**R28 移除**：连同建窗参数、重建窗口、"页不在是不是预期"那一档
   一起删干净）；
4. **屏外加载**（用户之 2，**保留**）：登录页建在**客户区左沿之外**（`login::offscreen_rect`，
   `x = -(宽+8)`），**静默窗走完**或首载期限（30 秒）到才 `set_position` 摆进内容区
   （R28 改判据，见下一段；R27 那一版是"首载 `Finished` 就摆"）。
   屏外期间**不跟随**主窗几何（跟随会把那一份摆回内容区，用户当场看到还在加载的白页），
   浮动控件照常跟随（那一段里它们是唯一可点的东西）；门禁层此刻显示转圈 +
   「正在打开华为官方登录页…」（`loginOpeningIndicator` / `LOGIN_OPENING_TEXT`）；
5. ~~**如实登记的代价**：移动版式没有二维码入口~~（**R28 随移动 UA 一起消失**：页面回到宿主
   默认 UA 渲染的那一套）。

**未实测（如实登记）**：真窗上"移动 UA 下登录能不能走完 `hms://` 回调"（要真实账号，探针只到
公开页面为止）、服务端风控对"伪装成 HarmonyOS 客户端"的反应。**这两条随 R28 的撤销一起作废**
（不再伪装 UA，也就没有"风控怎么看伪装"这件事）；原真机清单见 task-27 报告 §4。

**官方登录页摆进内容区的时序：静默窗（R28 用户指令 2026-10-20 · 真机反馈驱动 · 机制有测试钉）**

用户真机反馈（R27 交出去的那一版）：点「在网页中打开登录」之后**加载动画提前结束**——动画在
"首载 `Finished`"就收掉了，可那一刻页面停在 **authorize 中间页**，后面还有 CAS 重定向在加载，
用户看到的是"动画已经结束、页面还没好"。

**证据（可复现，只读公开页面）**：链路逐跳记录在 `.probe/r27-mobile-ua-probe.json` 的 `chains`
里（`getLoginWay` 200 → `id1.cloud.huawei.com/CAS/remoteLogin` 302 →
`/CAS/portal/loginAuth.html`）；探针脚本 `scripts/probe-login-mobile-ua.mjs`（同样只碰公开页面与
公开接口）。也就是说：**首载那一次 `Finished` 与"页面真的好了"之间隔着一整跳重定向**。

**修法（与链路多长无关，判据只钉"安静了没有"）**：

| 步 | 判据 | 落点 |
|---|---|---|
| 1 | 每次 `PageLoadEvent::Finished` → 起一个 `login::LOGIN_QUIET_WINDOW_MS` = **1.5 秒**的静默窗 | `login.rs` 的 `on_page_load` → `LoginSession::note_page_finished` |
| 2 | 窗内出现**新导航**（`PageLoadEvent::Started`，或 `on_navigation` 放行的任何一跳）→ **撤窗**，等下一次 `Finished` | 同上两个回调 → `LoginSession::note_navigation_started` |
| 3 | 窗内没有新导航 → 页面真的安静了 → **摆进内容区**（动画到此为止） | `wait_for_conclusion` → `place_login_view`（`placement_due` 的 `page_quiet` 那一档） |
| 4 | **30 秒首载期限**到 → 也摆进来（页面可能还在转，文案如实） | `placement_due` 的第二档，与 R27 一字不差 |

三条如实说明：
1. **1.5 秒量的是"两次导航之间有没有下一跳"**，不是"页面什么时候画完"——重定向链每一跳在毫秒到
   数百毫秒级，这个窗足以把"还有下一跳"和"安静了"分开；代价是最快也要多看 1.5 秒动画；
2. **拦下的导航（白名单外 / `hms://` 回调）不撤窗**：它们不会加载任何东西，没有"还在加载"可言。
   最坏结果是页面在窗内被拦一次 → 多等到下一个 `Finished` 或 30 秒兜底；
3. **时序判据全部是可注入时钟的纯函数 / 会话方法**（`quiet_window_passed` / `placement_due` /
   `LoginSession::new_at` 与 `_at` 变体）：`authorize Finished → 新导航起 → 撤窗`、
   `CAS Finished → 1.5 秒无导航 → 摆进`、`期限到 → 摆进` 三档都有用例钉住（不靠 sleep）。

**R28 的撤销清单（用户指令 2026-10-20，推翻 R26/R27 两项裁决）**：

| # | 用户指令 | 落点 |
|---|---|---|
| 1 | **官方登录页不再支持切换主题**：删掉主题参数注入与切主题重开链，官方页按默认渲染，应用主题只影响自家 UI（门禁 / 浮动控件 / 主界面） | `login.rs` 删掉主题常量、三态映射、参数注入、建窗参数、重建窗口与整条重开链；`theme::set_theme` 只落盘 + 广播，**不再碰登录页**；浮动主题控件（`login-theme`，R25）**留着**——它改的是应用主题 |
| 2 | **改回之前的 UA**：删掉移动 UA，恢复 WebView2 默认桌面 UA | `login.rs` 建窗链里不再设 UA |
| 3 | **修加载动画提前结束** | 上面那张表的静默窗 |
| 4 | **清理口径** | 本文件 §3/§5 与 `docs/KNOWN_LIMITATIONS.md` B18/B18-R27：改成"按用户指令移除"，历史证据保留 |

**这次撤销的代价与现状（如实登记）**：深色档下官方登录页**回到服务端默认的浅色渲染**
（R28 之前的黑底是移动 UA 换来的）；换回来的是"官方页就是官方页"与"不再为它伪装身份"，
以及网页登录窗里重新有桌面门户那一套版式（含二维码入口）。真机观感见
`docs/KNOWN_LIMITATIONS.md` 的 B18-R28。

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
→ {callbackURL}      // = **https 的 loginCallback 中转页**
                     //   R33：按 302 → Location 语义跟随它；**R34 真机改口：那条链回的是 HTTP 200**
                     //   （HTML 页面，浏览器里靠页面自己的 JS 跳 hms://redirect_uri?code&state），
                     //   见本节 R33/R34 段（三策略按证据序收尾）
```

这条链的**每一步都读自页面自己的代码**（`/CAS/static_rss/green/rss_20260904/CAS/vue3/vuebuild/js/login/portal/`
的 `qrCodeLogin-legacy.js` 与 `index-entry-legacy.js`；`getqrContent`/`asyncURL` 只作为**服务端配置值**出现，
bundle 里没有任何硬编码的二维码端点字符串——这也是"必须走 getPageInfo 拿配置"的原因）。
**实测状态（R34 更新）**：这一步**已有真机证据**——用户扫码 + 手机确认后轮询见到 `0`，本接口跑通并交回了
`callbackURL`（形状见上：https 中转页）。**R16 那句"`callbackURL` 带 code"是读 bundle 的推断**，
用户 R34 澄清：它**只是参考、当时未实测**——所以最后一跳不再押注"参数里一定有 code"这一条，
按三策略（参数直构 / 302 跟随 / 200 响应体提取）依次试，见下方 R34 段。
换码接口自己失败时是结构化错误（`qr_confirm_failed` + 服务端 `errorCode`），不猜。

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

**R29（用户真机反馈之 4：扫码之后轮询仍停在"未扫"）——诊断结论 + 观测加强**。
现场（可复现：`.tmp/dev-visible.log` 行 35–243）：四个二维码会话、每个连轮询约 90 轮，**全部**
`resultCode=103000200` + `errorDesc="Please to login."`，**连 `103000202`（已扫待确认）都没出现过**
——扫码从未关联到我们会话。桌面侧逐项实测健康，落点在**手机侧**：

1. **建单参数保真度：与官方页逐参数相同**（现场比对，非"照抄历史探针"）。
   官方移动页 `showQrcode` 的建单是 `POST localInfo.getqrContent.split("?")[0]`，表单
   `{appID, confirmFlag, version, reqClientType, loginChannel, appBrand}` **+ `getDevInfo()`**；
   我们（`HUAWEI_QR_ENDPOINTS.create` → `buildQrCreateBody`）发的是同一组值。
   `scripts/probe-qr-phone.mjs` 现场比对（今天下发的模板 vs 我们的常量）：**六个值全等、路径全等**、
   `asyncURL` 全等、`qrcodeRequestInterval` 全等（`appID=com.huawei.hwidweb`、`loginChannel=7000700`、
   `reqClientType=700`、`confirmFlag=1`、`version=40200`、`appBrand=HUAWEI`）。
   **简报假设的"reqClientType/loginChannel 错位"不成立**：页面 `localInfo` 里另有一套
   `reqClientType="90"` / `loginChannel="90000300"`（那是 OAuth 客户端的上下文），而**二维码建单用的是
   `getqrContent` 里的 700/7000700**——我们跟页面走的是同一条；若当初取了 `localInfo` 那套才是错位。
2. **三处保真度偏差，本轮如实登记、不改行为**（没有任何证据表明它们影响"扫码关联"，改了就是赌）
   ——**R31 更新：这三条已按探针实测补齐，见下面 R31 段**：
   - **查询串**：页面把 `?…` 丢掉（`split("?")[0]`），我们把模板查询串**留在 URL 上**（表单里同时也带了
     同样六个参数）。协议层是"参数从端点模板取"的唯一真源设计（`buildQrCreateBody`），改 URL 形状要连
     契约一起改，而收益不明；
   - **`deviceID`/`deviceType`**：页面在 `localStorage.hwid_cas_sid` 存在时补 `{deviceID, deviceType: 7}`
     （`getDevInfo`），而这张页面的 `localInfo.isUsedDeviceFingerSite = true`（**设备指纹在这个站点上是
     开着的**）。sidecar 没有浏览器 localStorage 那一份 `hwid_cas_sid`，目前**一个都不带**
     （R31 查清了那颗 `sid` 的来源：服务端下发的，见 R31 段第 2 条）；
   - **cookie**：页面两个调用都是 `withCredentials: true`（带的是它自己 CAS 会话的 cookie）。我们
     建单/轮询**完全不依赖 cookie**——R16 的 `recon-stateless.mjs` 与 R29 的探针都在"零 cookie"下拿到
     了正常建单响应与正常轮询档位（可复现），所以这不是"请求被拒"的问题；至于它会不会影响**扫码关联**，
     本环境无法判定（见第 4 条）。**R31 更正口径**："不依赖"说的是服务端**不拒绝**无 cookie 的请求，
     不等于"页面不带 cookie"——探针实测页面的轮询还带着**建单响应自己种下的** `qRCode`/`expiredTime`/
     `qrCodeCreateTime`，所以我们照样把罐带上（`docs/KNOWN_LIMITATIONS.md` B21）。
3. **轮询请求保真度：形状相同，节奏略有差异**。页面 `asyncRequest`：`POST asyncURL + "&t=" + Math.random()`、
   表单只有 `qrToken`、`Content-Type: x-www-form-urlencoded`、超时 30 s、`withCredentials: true`；
   我们除 cookie 外逐项相同（`buildQrPollBody` 也只有 `qrToken`）。**节奏**：页面按"上一轮**发出**时刻 +
   `qrcodeRequestInterval`"排下一轮（`loopCheck`：先算 `now − lastRequestTime`，不够就补差），我们排在
   **上一轮落地之后**再等一整个 `intervalMs`（等价于 `interval + 往返`）。只影响采样密度，不影响档位判定；
   R29 起日志把节奏记下来（见第 6 条），真机据此就能核对。
4. **手机侧（这是结论的落点）**：二维码 content 指向 `https://id1.cloud.huawei.com/qrcode/login.jsp?…`，
   手机打开后 **302 → `/CAS/mobile/confirmQRLogin.html?…&callbackURL=…`**。该页的页面代码里**只有一个
   出向请求**：用户按「登录」时的 `pi.confirmQRLogin({qRCode})`（`.confirmQRLogin(` **1 处**、
   `.qrRemoteLogin(` **0 处**、`scanQRCode` **0 处**——`qrRemoteLogin` 只作为共享 SDK 的**声明**存在，
   本页组件从不调用）。也就是说**"把那个链接打开"本身并不上报扫码**：探针用手机 UA 打开 content URL
   （无账号会话）前后各轮询两次，档位始终 `103000200`／`"Please to login."`。
   于是"压根没扫"与"扫了但手机侧那台设备**没有登录华为账号**"在服务端是**同一档**；而
   `errorDesc` 那句 "Please to login." **读作服务端在说后者**——这是**推断，不是实测**（R31 更正措辞）：
   我们只验过"无账号的手机打开 content URL 会得到这句话"，没有对照组，也没验过服务端会不会在别的
   场合复用同一句话。
   **仍未验证的关键一跳**：一台已登录华为账号的手机扫这张码，是否会依次给出 `103000202` → `0`
   ——需要真实账号（本任务与探针都禁止登录），如实登记为 `docs/KNOWN_LIMITATIONS.md` **B19**
   并给出用户步骤（手机侧先登录，再看日志里是否出现 `103000202`）。
5. **`errorDesc` 的处置**：页面 bundle 只认 `0`/`103000201`/`103000202`，其余（含 `103000200`）一律
   "继续轮询"，所以**状态码本身分不出上面那两种情况**。`errorDesc` 是服务端在 `103000200` 这档上
   **给出的唯一一句话**（现场原话 `"Please to login."`），也是我们手上**唯一能拿来推断**
   "是不是手机侧没登录"的线索——注意口径（R31 更正）：**它是线索，不是判据**。
   本轮能证明的只有"这句话在'无账号的手机打开 content URL'时出现"，**不能**证明"这句话出现 ⇔ 手机侧
   没登录"（没有对照组：既没验过"手机侧已登录但没关联"会说什么，也没验过服务端会不会在别的场合
   复用这句话）。它不带会话信息，因此 R29 起**进日志**（压成一行、超长截断 `QR_ERROR_DESC_MAX = 80`），
   真机上按"线索"读即可。
6. **观测加强（本轮交付的可判性）**，两条，都在协议层（`src/protocols/qr-login.mjs`）：
   - **建单一行** `二维码建单：content=/qrcode/login.jsp?loginChannel=…&reqClientType=…&qrSiteID=…
     &appBrand=…&familySharing=…；有效期=181s`——只留**非敏感**参数（`describeQrContent` 丢掉
     `qRCode`/任何 token/session 类参数），真机再报"不关联"时先看这张码指向哪、带什么上下文；
   - **轮询每行带时刻与节奏 + errorDesc**：`二维码轮询 #7（15:09:31，t+18.2s）：resultCode=103000200
     （errorDesc="Please to login."）`（陌生码的"连续 n/5"照旧跟在后面）。`qrToken`/`qrCode`/整串
     content 仍然**一律不进日志**。
7. 钉在：`test/qr-login.test.mjs` 的 5 条 R29 用例（`sanitizeErrorDesc` 单行+截断、
   `describeQrContent` 丢掉 `qRCode`、建单一行只此一条且不含凭据、轮询行的时刻与 `t+…s`、陌生码那行
   格式不分叉）；探针 `scripts/probe-qr-phone.mjs` + 摘要 `.probe/r29-phone.json`。
   **未改任何行为**：参数/链路/cookie 一处未动（依据见第 2 条），本轮交付的是**结论 + 可判性**。

**R31（用户指令 2026-10-21：界面不变、不用移动端 UA、继续修自己生成的二维码）——建单/轮询全保真对齐**。
R29 是被动读代码推断，R31 换了方法：**用 headless Chromium 真开官方页，把页面自己发的请求抓下来**
（`scripts/probe-qr-fidelity.mjs` → `.probe/r31-fidelity.json`；`test:acceptance` 之外可单独
`node scripts/probe-qr-fidelity.mjs` 复现）。抓下来之后，R29 登记的三处缺口一条条变成了事实。

1. **先说一张被推翻的想当然：建单不在移动页上，在桌面门户页上**（这是本轮所有结论的前提）。
   探针两个相位：手机 UA 下——无论是 CAS 入口落到的那张页（`/CAS/portal/loginAuth.html`）还是显式打开的
   移动登录页（`/CAS/mobile/standard/login.html`）——**画布 0 个、二维码图 0 个、建单 0 条、轮询 0 条**
   （那两张页渲染的是"短信验证码登录/密码登录"）；桌面 UA 下同一张门户页 **画布 1 个、二维码图 1 个**，
   建单与轮询都是它发的。所以：① R16 起从移动页读 `getqrContent` 只是"借它的配置"，**二维码从来是桌面页的东西**；
   ② 用户"不用移动端 UA"的指令与协议保真是**同一件事**（移动 UA 下那张页根本没有二维码）。
   附带更正：探针里**桌面门户页的 `getPageInfo` 也下发 `getqrContent`/`asyncURL`/`qrcodeRequestInterval`**
   （R16 记的是"不下发"）——R16 的判断按当时的请求参数成立与否已不可考，但今天的实测是下发，
   所以我们沿用原设计（配置仍从移动页读、常量仍以那次实探为准），只是把门户页用在"上下文"上。
2. **`deviceID` 的真源查清了：它是服务端下发的 `sid`，不是页面自己算的哈希**。页面顺序是
   `POST /CAS/IDM_W/ajaxHandler/dev`（正文 `{pageToken, pageTokenKey, reqClientType, loginChannel,
   clientID, lang, languageCode, state, fp}`）→ 响应 `{"isSuccess":1,"sid":"204937…（84 位 hex）"}`
   → 写进 `localStorage.hwid_cas_sid` 与同名 cookie → 建单时作为 `deviceID=<sid>&deviceType=7` 发出去。
   那份 `fp` 的编码（`k=v` 排序 + `&cs=<sha1>` + 滚动 XOR + base64）在
   `src/protocols/device-fingerprint.mjs` 里**逐字节复刻**，并由探针抓到的那份原件钉住
   （`test/fixtures/r31-page-fingerprint.json` + `test/device-fingerprint.test.mjs`）。
   服务端的接受规则也是实测的：`cs` 必须是 `sha1(去掉 cs 的那半截)`（写错/不写/内容不合形状 → `sid:""`
   = 拒绝），而**指纹里那几个哈希不校验来源**（换一个 40 位 hex 照样发 `sid`）。
   → 因此我们发的那份指纹里：`ett`/`etz`/`nlg`/屏幕尺寸是**真值**（可注入），
   `canvas`/`webgl`/`fonts` 是**同形状的固定值**（sidecar 没有浏览器引擎）——如实登记在模块头与 B21。
3. **建单请求的完整形状**（页面 vs 我们，R31 起逐项相等）：URL `POST /DimensionalCode/getqrInfo`
   **不带查询串**（`qrCreateRequestUrl` 只留 origin+path；端点常量仍带模板查询串，因为六个参数从它取）、
   表单 `{appID, confirmFlag, version, reqClientType, loginChannel, appBrand, deviceID, deviceType}`
   （前六个逐值相同，后两个形状相同）、头 `content-type: application/x-www-form-urlencoded` +
   `accept: application/json, text/plain, */*`（`QR_PAGE_ACCEPT`）+ 页面 UA（`QR_HTTP_USER_AGENT`）
   + `Referer` 指门户页 + **cookie**（CAS 会话那串，含 `dev` 响应种下的 `hwid_cas_sid`）。
4. **轮询请求同理**：`POST /DimensionalCode/async?version=40200&t=<随机>`、表单只有 `qrToken`、
   同一套头与 cookie——**并且带着建单响应自己种下的** `qRCode`/`expiredTime`/`qrCodeCreateTime`
   （探针实测的 cookie 名单里就有它们；这正是"cookie 罐"这条缺口最硬的一条证据）。
5. **降级是硬约束**：上下文那一步（CAS 链 → 门户页 → getPageInfo → dev）**失败不许挡界面**——
   拿不到就照旧建单（不带 `deviceID`/cookie），日志留一行
   `二维码建单上下文（R31 全保真）降级：<原因>；照旧建单（不带 deviceID/cookie）`；
   拿到则留 `二维码建单上下文（R31 全保真）：门户页=/CAS/portal/loginAuth.html；cookie=N 项；
   deviceID=服务端 sid（84 位 hex）`。`sid` 的值本身**不进日志**（只记长度）。
   dev 回空 `sid` 时**不猜一个 deviceID**（自己编的骗不过服务端，只会让"不关联"更难查）。
6. **界面与 UA 一处未动**：渲染层零改动、登录 webview 仍是宿主默认 UA、二维码的画布/倒计时/过期/刷新
   全保留。协议里的 UA 是**请求头层面的协议保真**（桌面 Chrome），与"应用用什么 UA 打开官方登录页"是两件事。
7. **实探（产品代码自己走一遍，`.tmp/r31-live-port.mjs`）**：`deviceID=服务端 sid（84 位 hex）`、
   建单 8 字段 + cookie 名单 `CAS_THEME_NAME,JSESSIONID,VERSION_NO,CASTGC,CASTGCLOW,hwid_cas_sid`、
   轮询 cookie 名单再带上 `qRCode,qrCodeCreateTime,expiredTime,cversion`；建单/轮询 UA 与
   `QR_HTTP_USER_AGENT` 逐字节相同。**仍然测不到的是"关联"本身**（要真手机 + 真账号）
   → `docs/KNOWN_LIMITATIONS.md` **B21**（**R33 的真机证据补上了这一条：关联通了**，见本节 R33 段）。
8. 钉在：`test/device-fingerprint.test.mjs`（10 条：序列化/校验/往返/**与页面逐字节一致**/字段表）、
   `test/qr-login.test.mjs` 的 R31 3 条（建单 URL 去查询串、建单请求形状、轮询请求形状）、
   `test/qr-port.test.mjs` 的 R31 4 条（上下文链 + cookie 罐；降级；空 sid 不猜；CAS 链只走一遍）。

**R33（用户真机证据 2026-10-21：扫码关联已通，卡在最后一跳）——`callbackURL` 是 https 中转页，要跟着它拿 `hms://`**。**（R36 已整体退役：见本节末的 R36 段——真机上那一页不是 302 中转页。以下保留为历史。）**

真机事实链：用户扫码 + 手机确认之后，轮询见到了 `0`（已确认）、`codeRemoteLogin` 跑通并回了
`callbackURL`（R31 的保真生效了），但界面报「不是登录回调 URL（只接受 hms://redirect_uri）」。
根因：**那个 `callbackURL` 不是 `hms://` 回调，而是 https 的 loginCallback 中转页**：

```
codeRemoteLogin → {callbackURL: "https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback
                                  ?state=…&code=…&redirect_uri=hms%3A%2F%2Fredirect_uri&…"}
浏览器里这一跳：302 → Location: hms://redirect_uri?code=…&state=…
```

我们此前把那份 https URL **原样**喂给只认 `hms://redirect_uri` 的 `parseCallback`
（`src/protocols/login-callback.mjs`）→ 扫码明明成功了，却在最后一步报"不是回调"。
（R16 的 §③ 表里写的是"`callbackURL` = loginCallback URL"，**方向是对的、形状写粗了**：
它是 https 的中转页，不是回调本身。）

修法落在确认链里（`src/main/qr-login.mjs` 的 `resolveCallbackUrl`，`codeRemoteLogin` 之后、
`onConfirmed` 之前），三条规矩：

1. **`hms://` 开头 → 直通**：原样交回，下游 `parseCallback` 仍是判真伪的唯一之处（既有链零改动）；
2. **`https://` → 跟随**：`fetch(…, {redirect: "manual"})` 自己读 `Location`（复用 QR 链那条
   [`request`]，于是自动带同一口 cookie 罐、页面 UA，并补上与换码那一步同款的 `Referer`）。
   **必须 manual**：让 fetch 自动跟随会把 302 变成一次"自定义 scheme 的导航"（引擎跟不了），
   `Location` 反而读不到——这一跳要的就是那颗 `Location`。跟随最多 `QR_CALLBACK_MAX_REDIRECTS = 5`
   跳（允许区域中转再套一层，但**有上界**：跟随目标来自服务端响应，无上界的跟随等于把"打不通"
   变成一个循环），`Location` 允许相对路径（按当前地址解析）；
3. **形状对不上就结构化报错，不猜**（新增类别 `QR_PORT_ERROR_KINDS.callbackRedirectFailed`
   = `qr_callback_redirect_failed`）：非 3xx / 3xx 但**没有 `Location`** / 跳去的不是
   `hms://redirect_uri` 回调（例如 `hms://evil.example.com/…` 这种钓鱼形状，用 `isCallback` 判）/
   超过跳数 / 连 https 中转页都不是的 callbackURL。跟随那一跳**网络失败**走既有的 `network_error`。
   **文案不回显 URL**（那个地址里带着 `code`）：只说状态码与"形状哪里不对"。
   `parseCallback` 成功之后的链（`consumeCallback → exchangeCode → loginex → 会话落地`）**一行未动**。

钉在 `test/qr-port.test.mjs` 的 R33 8 条：直通（一个多余请求都不发）/ 一跳 302（含
`redirect: "manual"`、cookie 罐、UA、Referer 逐项）/ 两跳 / 5 跳边界与超限 /
200 无 `Location` / `Location` 是别的 hms 域 / 跟随那一跳网络失败 / 形状不认不外发请求。

**R34（用户真机证据 + 用户澄清 2026-10-21）：最后一跳改成三策略按证据序收尾。****（R36 已整体退役：三条策略全部落空，见本节末的 R36 段。以下保留为历史。）**

真机把 R33 那条路**走出了界**：R33 的"跟随 302 读 Location"在真机上**没有走到**——服务端 fetch 那份
https 中转页拿到的是 **HTTP 200**（一张 HTML 页面，浏览器里靠页面自己的 JS 跳 `hms://`），
**没有 `Location` 可读**，于是报「中转页没有跳转到登录回调（HTTP 200）」。同时用户澄清：
R16 §③ 里"`callbackURL` = loginCallback URL **带 code**"那句是**读 bundle 的推断**，
**只是参考、当时未实测** —— 所以最后一跳**不再押注任何单一路径**。

`src/main/qr-login.mjs` 的 `resolveCallbackUrl` 按**证据序**三条策略（`hms://` 直通仍在最前）：

| # | 策略 | 触发条件 | 代价 |
|---|---|---|---|
| ① | **参数直构** | 这条 URL（起点**或某一跳的 Location**）的查询里既有 `code`、又有 `redirect_uri` **解码后等于** `hms://redirect_uri` | **零请求**：直接构造 `hms://redirect_uri?code[&state]` |
| ② | **302 Location 跟随**（R33 已有，保留） | ①不成立 → `redirect:"manual"` 读 `Location`（同一口 cookie 罐 + 同款头），≤ 5 跳 | 每跳一次请求 |
| ③ | **响应体提取** | ②的那一跳回 **2xx**、没有 `Location`、体里带着 `hms://redirect_uri?` 字面量 | 无附加请求（体已在手） |

四条口径（每条都有测试钉住）：

1. **①只搬原文**：`code`/`state` 从查询串里按**原始字符**取用（不做"解码再编码"——`%2B` 解成 `+`
   就是另一个字符了）；`state` 缺省时**只带 `code`**，**不编一个 state**。回调"形状完不完整"
   **不在这里判**：`parseCallback`/`consumeCallback` 才是判真伪的地方（缺 state 到那里会得到
   `missing_params`——那是一条看得见的失败，胜过替它圆一个假的过去）。
2. **①的第二个条件是硬条件**：`redirect_uri` 不是 `hms://redirect_uri` 时**绝不直构**
   （那等于把别人的 code 塞进我们的回调）。
3. **③锚定精确开头**：锚点是 `OAUTH_REDIRECT_URI + "?"`（**不在这里再写一份 `hms://redirect_uri`
   字面量**：唯一真源在 `auth.mjs`，`test/login-parity.test.mjs` 在全仓范围内钉这条纪律），
   提取到 `"`/`'`/`` ` ``/`<`/`>`/空白/反斜杠为止（HTML/JS 的包装边界），**原文不加不减**；
   取到的必须过 `isCallback` 才认（`hms://evil.example.com/…` 这类钓鱼形状一个字都不提）。
4. **三策略全败 → 既有结构化错误**（`qr_callback_redirect_failed`）：不猜、**不回显 URL**
   （那个地址里带着 `code`）。跟随那一跳的网络失败仍是 `network_error`；换码接口自己失败仍是
   `qr_confirm_failed`。诊断日志按 `via`（`params`/`location`/`body`）说清是哪条收的场，
   **state 值一个字符都不进日志**。

**state 接线核实（R34 的必核项，结论：已经是同一个 state，不需要改接线）**

- 证据（真机探针存档，两条都点名了 state）：`.tmp/getLoginWay.json` —— CAS 把**我们发出去的那串
  授权参数**（含 `state=probe-state`）原样嵌进 `casLoginRedirectUrl.service`；
  `.tmp/cas-getPageInfo-mobile.json` —— 移动登录页下发的 `localInfo.service` 同样带着 `state=probe-state`。
  **CAS 侧是原样回带，不是自己另生成一个。**
- 代码路径（一处都没换过 state）：`attempt.authorizeUrl`（含 `attempt.state`）
  → `walkToCasPortal` 把整串查询当表单正文 POST 给 `getLoginWay` → 门户/移动页 URL（同一串参数）
  → `getPageInfo` 表单 → `localInfo.service` → `codeRemoteLogin` 的 `service` → `callbackURL` 的 `state`
  → 策略①直构 → `consumeCallback(expectedState: attempt.state)` 比对。
- 钉在 `test/qr-port.test.mjs` 的"R34 state 接线"一条：假世界照真机那样**从我们发出去的那串参数里
  取 state 回带**，逐环断言（getLoginWay 正文、两次 getPageInfo 表单、换码 `service`），
  最后交给**真的** `consumeCallback` 判通过——外加"换个 state 就拒"的反面控制（证明校验不是形同虚设）。

钉在 `test/qr-port.test.mjs` 的 R34 12 条：策略①直构（零请求）/ 没有 code → 落② /
`redirect_uri` 不是我们的不直构 / 没有 state 只带 code（并断言 `parseCallback` 会判 `missing_params`）/
编码原样（`%2B` 不变 `+`）/ 302 链终点带 code 也直构（不多打一次）/ 策略③ 200 提取原文 /
包装边界不加不减 / 两跳后从体里提取 / 体里只有别的 hms 域不提取 / 三策略全败结构化 /
state 接线（含反面控制）。R33 那条"跟随那一跳网络失败"的剧本改用**查询里没有 code** 的中转页
（带 code 的会被①当场收下，那一跳根本不会发生）。

**仍未实测**：那句 HTTP 200 页面里**到底写的是哪一串跳转字面量**（③按"页面 JS 跳转目标"的通用形状实现，
真机若给的是别的写法——例如把 `&` 写成 HTML 实体 `&amp;` 的属性值——③会提不出可用字面量，
仍走结构化失败；`&amp;` 这一类**本轮不处理**，按"原文不加不减"的口径登记在此）→
`docs/KNOWN_LIMITATIONS.md` A6。

**R36（用户真机诊断定案 2026-10-21）：确认链的最后一跳**改走登录 webview**——服务端解析整体退役。**

R35 的诊断日志把真实形状钉死了，R33/R34/R35 的假设**全部落空**：

| 观测（R35 真机日志） | 它推翻了什么 |
|---|---|
| `loginCallback` 页的查询里**没有 `code`**（只有 `ticket`/`siteID`/`flowID` 一类的 OAuth 票据参数） | R34 策略①"参数直构"没有立足点（**没有 code 可构**） |
| 那一跳回的是 **HTTP 200**（不是 3xx），**没有 `Location`** | R33/R34 策略②"跟随 302"在真机上根本不会发生 |
| 那份 200 的 14KB HTML 里**连 `hms` 字样都没有** | R34 策略③"响应体提取"也没有立字点（跳转目标是页面 JS 现拼的） |

⇒ **服务端 fetch 这一页结构性地拿不到授权码**：它不是"回一份带 code 的中转页"，而是**一张靠自己的
JS 完成最后一跳的页面**。所以 R33（跟随 302）、R34（三策略按证据序）、R35（脱敏诊断）
**整体退役**——不是"哪条修得不对"，而是"在服务端收场"这个前提本身不成立。

**定案依据是同一个应用里的对照组**：**账号密码网页登录实证走通**，走的正是
"**webview 里**加载官方页 → 页面自己的 JS 执行 → 跳 `hms://` → 被导航拦截器接住"。
于是二维码这条链的最后一跳复用同一条路：

```
手机确认 → 轮询 resultCode=0 → codeRemoteLogin → {callbackURL}（https 登录收尾页）
  → auth-manager.finishQrLogin：经宿主要求开一扇登录 webview（既有 host:open-login 那条路径）
       LoginConfig.url = callbackURL（宿主白名单：https + loginCallback 精确例外，两侧都已登记）
  → 页面自己的 JS 跳 hms:// → Rust 导航拦截 → LoginConclusion::Callback{url}（原样）
  → 同一条兑换链：consumeCallback（expectedState = attempt.state）→ exchangeCode（PKCE）
       → loginex → 会话落地 → auth:status{loggedIn:true}
```

**两流合一（选型）**：`finishQrLogin` 的这半段**直接复用 R7 的 `runLoginFlow`**
（`src/protocols/login-callback.mjs`），auth-manager 里只有一个装配点（`startLoginFlow`）——
开窗/回调/取消/关窗/超时/首载失败六种交付物的结算与"结束必清理"只有一份实现。
QR 的 attempt 通过 `expectedState` + `createdAt` 传进同一条流（**同一个 OAuth attempt**：
R34 已核实建单链的 `state` 就是 `attempt.state`），所以 state 校验天然成立，
"过期"也仍然只说一件事：**这次尝试的寿命到了**（`runLoginFlow` 为此新增可选参数 `createdAt`，
默认仍是"开窗那一刻"）。

**端口的职责因此收窄成"搬运"**（`src/main/qr-login.mjs`）：`codeRemoteLogin` 交回的 `callbackURL`
**原样**交给登录链路——一个多余请求都不发（不 fetch 那份收尾页）、一个形状判断都不做。
判真伪是 `isCallback`/`parseCallback` 的唯一职责，能不能开窗是宿主白名单的职责
（Rust `login.rs` 的 `parse_config`：必须 https 且在导航白名单内）。
日志只记形状：`二维码换码：callbackURL 形状=<scheme>://<host><path> → 原样交给登录链路…`
（**不含查询串**：`code`/`state`/`ticket` 一个字符都不进日志）。

`auth-manager` 的两条分支与三处接线：

1. **`callbackURL` 已经是回调**（`hms://redirect_uri?code&state`）→ 不开窗，`consumeCallback` 后照旧兑换
   （既有链零改动；宿主那只收 https 的登录页，喂 `hms://` 给它是白跑一趟）；
2. **是 https 收尾页**（真机形状）→ 开登录 webview，等它的结论；四收场各归各的类别
   （取消 / 关窗 / 超时 / 首载失败），一律经 `failQrWith` 落到 `auth:qr{failed}`（界面才有"重试"）；
3. **那扇窗登记在 `qrWindow` 上**：跑着的时候 `login()` 如实拒（`login_in_progress`），
   `cancelLogin()` 也关得掉它（用户能看见的窗，就得能取消）；窗开着期间 `busy: true`
   （`busy` 描述的就是"开窗那条路在跑"，渲染层 reload 之后只凭它也知道窗开着）。

**可见性**：这扇 webview 用的是**既有登录 webview 的全部策略**（Rust 侧一行未改）——
白名单导航、`hms://` 拦截、R25/R27 的静默窗摆进、浮动「返回扫码登录」/主题控件、关窗收尾。
所以"用户能不能看见官方收尾页"由既有策略决定：页面在静默窗（每次加载 `Finished` 后 1.5 秒内无新导航）
之后摆进内容区——**没有额外确认步骤就跳走的页面，用户可能只看到门禁**；要再确认一步的页面，用户看得见。

**门禁状态行（渲染层零改动）**：确认之后那一行是既有的
「**已确认，正在完成登录…**」（QR 这条路的 `path` 一直是 `qr`）。契约里那句「已在网页中打开登录。」
属于 `path === "official"`（渲染层**自己按了入口**的那条路）；而且在当前渲染层里它与 R27 的
「正在打开华为官方登录页…」判据相同、后者先命中，**是不可达的一句**——R36 不动渲染层，
这个差异如实登记在 `task-36-report.md`。

钉在：`test/qr-port.test.mjs` 的 R36 5 条（原样交回、查询里没有 code 也原样交回、`hms://` 也原样交回、
**不做形状裁决**、以及一条源码扫描钉住三策略+诊断**整体退役**）＋ state 接线 1 条（收尾页 URL 带
`attempt.state`、webview 结论过**真的** `consumeCallback`）；`test/auth-qr.test.mjs` 的 R36 7 条
（两流合一全链 / `hms://` 直通 / 用户取消 / `cancelLogin` 关得掉那扇窗 / 陌生 state / 首载失败与超时 /
门禁状态行）；`test/login-callback.test.mjs` 的 R36 1 条（`createdAt` 把过期锚在 attempt 上，
含"不给它时行为不变"的反面控制）。

**R35（用户真机证据 2026-10-21：三策略全败 → 不再猜形状，先把真实形状留在日志里）——只加脱敏诊断，不改行为。**
**（R36 已整体退役：下面这段描述的诊断输出格式**不再存在**，保留它是因为 R36 的定案正是靠它拿到的形状。）**

真机链路（用户交回的证据链）：扫码确认 ✅ → `codeRemoteLogin` ✅ → `callbackURL` → ①参数直构 ✗
（查询里没有可判的 `code`+`redirect_uri` 组合）→ ②跟随得 **HTTP 200**（非 3xx）→ ③页面提取 ✗
（体里没有 `OAUTH_REDIRECT_URI + "?"` 那段字面量）→ 报错。**三个假设全部落空 = 我们在猜形状**，
所以这一轮**一条策略都不动**：`src/main/qr-login.mjs` 的 `resolveCallbackUrl` 三策略照旧跑
（顺序、请求数、`via`、失败文案一处未改），只是每一跳多记三行**脱敏诊断**到既有 `log`
（→ sidecar **stderr**；**不进 UI、不发新请求、不参与判定**）：

| 行（`stage`） | 它服务哪条策略 | 键（**值一律不进日志**） |
|---|---|---|
| `candidate` | ①的**判定输入** | `hop`（第几次候选=第几次请求，起点 0）/ `scheme` / `origin_path`（`scheme://host + path`，**查询串不进这一项**）/ `query_names`（**参数名清单，不含值**）+ `query_names_total` + `query_names_truncated` / `has_code` / `code_nonempty` / `redirect_uri_is_oauth`（**布尔**：解码后是否等于 `OAUTH_REDIRECT_URI` —— 记判断，不记值） |
| `response` | ②的输入 | `status` / `has_location`（**布尔**：头在不在）/ `location_scheme`（绝对地址的 scheme；相对路径给空串） |
| `body` | ③的输入 | `body_bytes`（**UTF-8 字节数**，不是字符数）/ `has_hms` / `has_redirect_uri` / `has_login_callback` / `hms_fragments`（体里所有 `hms[^"'\s<>]{0,120}` 片段，逐条脱敏；去重、上限 8 条）/ `hms_fragments_total` / `hms_fragments_truncated` |

一行就是一个 JSON 对象（`{"tag":"qr-callback-diagnostic","stage":…}`，键值对，直接读也直接 grep）。
**脱敏**（本轮的硬承诺）：片段里 `code=` / `state=` 之后的值一律换成 `<len:N>`（**只留长度指纹**，
N = 那个值的字符数）；规则**只宽不窄**——名字以 `code`/`state` 结尾的（`wxCode=`）一起脱、
大小写不敏感、已经是 `<len:N>` 的不再套一层（幂等）——并且在**整行序列化之后再过一遍**，
所以"值一个字符都不进日志"是**结构上**的保证，不靠"当时记得脱"。

钉在 `test/qr-port.test.mjs` 的 R35 8 条：哑值 `CODE-VALUE-DO-NOT-LOG` / `STATE-VALUE-DO-NOT-LOG`
同时注入**查询值 / Location / 响应体**三处之后**整份日志断言缺席**（外加反面控制"形状确实记了"，
否则"缺席"可能只是"什么都没记"）；候选/响应/体三行的字段逐项钉（origin+path 不含查询串、参数名
清单按出现序、两个布尔、字节长度 > 字符数、三个包含布尔、片段长度指纹、去重与上限如实标注）；
"只观测"一条钉住零请求那条路**不许**凭空记出一行"响应形状"；另有两条纯函数级用例钉脱敏的
"只宽不窄 + 幂等"与片段收集的去重/上限。

真机形状的两个样本（`.tmp/r35-shape-demo.mjs` 驱动**真的**端口跑出来的原样输出，不是手写的）：

```
{"stage":"candidate","hop":0,"scheme":"https","origin_path":"https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback",
 "query_names":["state","redirect_uri"],"query_names_total":2,"has_code":false,"code_nonempty":false,"redirect_uri_is_oauth":true}
{"stage":"response","hop":0,"status":200,"has_location":false,"location_scheme":""}
{"stage":"body","hop":0,"status":200,"body_bytes":130,"has_hms":false,"has_redirect_uri":false,"has_login_callback":true,
 "hms_fragments":[],"hms_fragments_total":0,"hms_fragments_truncated":false}
```

——这正是"三个假设全落空"的形状：**查询里没有 `code`**、**回的是 200 且没有 `Location`**、
**体里压根没有 `hms`**。第二个样本（R34 登记过的未处理写法，`&` 写成 `&amp;`）的 `body` 行：

```
{"stage":"body","hop":0,"status":200,"body_bytes":116,"has_hms":true,"has_redirect_uri":true,
 "hms_fragments":["hms://redirect_uri?code=<len:9>&amp;state=<len:10>"],"hms_fragments_total":1,...}
```

——`hms_fragments` 里那串 `&amp;state` 就是**真机一旦这么写**时我们要看的东西（值只剩长度指纹）。

**仍未实测（R35 只是把可判性做足，不改变这一条）**：那句 HTTP 200 页面里到底写的是什么。
R35 之后用户再扫一次码，日志里 `stage=body` 那行的 `hms_fragments`（或"一个片段都没有"这个事实）
本身就是答案 → R36 按真实形状精准修。

## 2. 音乐业务接口

### 2.1 结论：**端点与请求/响应形状 = 公开参考实现的实测值（R32 换血）**

| 探测对象 | R4 结果 | R32 结论 |
|---|---|---|
| `https://music.huawei.com/` 等候选 | **ENOTFOUND**（域名不解析） | 同上，这些**不是**业务域 |
| 业务域 | 未知 | **`https://api-drcn.music.dbankcloud.cn`**（参考实现实测；R17 本机也验证过该域可解析） |
| 业务端点形状 | 全部"待确认" | 见 §2.2 的逐端点表（路径 / 方法 / 参数 / 响应容器全部来自参考实测记录） |

**证据分级**（与 §1.5.1 同一套口径，逐级如实标注）：

1. **公开来源（协议形状）**：`talongao/huawei-music-desktop` 的 `src/music.mjs` + `docs/API_CONTRACT.md`
   （核验日期 2026-10-14，作者本人账号的兼容性实验记录）。本节的路径、方法、参数名、参数位置、
   响应容器名、成功判据、归一化字段映射**逐条来自它**；
2. **本机实测（可达性）**：R17 探针证明业务域可解析、`loginex` 路径存在且只收 POST
   （405 vs 对照 404、无效 AT 回 200 + 业务码 `990000`）；
3. **仍未实测（本仓，一条不漏）**：

   | # | 项 | 为什么没验 |
   |---|---|---|
   | 1 | 用本项目账号走完 §2.2 的每一条请求（收藏/歌单/搜索/专辑/歌手/历史） | 要用户在场的授权登录；本仓不代登 |
   | 2 | 歌单发现的真实分页形态（首页是不是常常整页歌曲） | 依赖第 1 条 |
   | 3 | 播放地址与音质（`lossless` 在本账号是否可用） | 依赖第 1 条 |
   | 4 | 歌词资源地址在本账号响应里的真实字段 | 依赖第 1 条（字段清单来自参考，未本机复核） |
   | 5 | 各写操作（删歌单等）的真实生效与清理 | 依赖第 1 条；本项目第一版只开放删除自建歌单 |

**架构没变**：端点仍然**注入**。`src/protocols/music.mjs` 只登记**路径形状**（`MUSIC_ENDPOINT_PATHS`，
一个域名都不含 —— 由 `test/music.test.mjs` 的源码扫描钉死）；绝对 URL 的默认值住在
`src/main/music-service.mjs`（业务域 + 路径），设置文档 `data.musicEndpoints` 可逐键**覆盖或显式关闭**
（`null` = 这次不要这个端点，离线/排障/测试要一个"确定性不可用"的状态）。

### 2.2 逐端点表（唯一真源：`src/protocols/music.mjs` 的 `MUSIC_ENDPOINT_PATHS` / `MUSIC_ENDPOINT_METHODS`）

| 键 | 方法 | 路径 | 参数 | 需音乐会话 | 响应容器 |
|---|---|---|---|---|---|
| `favorites` | POST | `/music-userbehavior-service/v3/service/favorite/simple/all` | `targetSnsUserID` `start` `limit` `contentTypes:["1"]` | ✅ | `favoriteInfos[]` |
| `playlistList` | POST | 同上（**同一个端点，不同的 `contentTypes`**） | `targetSnsUserID` `start` `limit` `contentTypes:["1","4","5","7"]` | ✅ | `favoriteInfos[]` |
| `playlistDetail` | GET | `/music-userbehavior-service/v1/service/playlist/detail/all` | `playListID` `start` `limit` | ✅ | `playListInfoEx.playListInfo` + `.playListSongInfoList[]` |
| `playlistDetailPublic` | POST | `/music-operation-service/v2/service/musiclist/detail/bymusiclistid` | `musicListID` `copyrightSwitch:"1"` `start` `limit` | — | `musicListInfoEx.musicListDetail` + `.songSimpleInfos[]` |
| `playlistDelete` | POST | `/music-userbehavior-service/v1/service/playlist/delete` | `playListID` | ✅ | —（写操作，不自动重试） |
| `search` | POST | `/music-search-service/v10/service/fuzzysearch` | `contentType:"1"` `correct:"1"` `queryWord` `start` `limit` | — | `songSimpleInfos[]` + `hasNextPage` + `totalNum` |
| `album` | GET | `/music-metacontent-service/v1/service/album/detail/byalbumcode` | `albumCode` `start` `limit` | — | `albumInfoEx.albumInfo` + `.songSimpleInfos[]` |
| `artist` | POST | `/music-metacontent-service/v2/service/artist/detail/byartistcode` | `artistCode` `songNum` `albumNum` | — | `artistInfoEx.artistInfo` + `.songSimpleInfos[]` + `.albumSimpleInfos[]` |
| `history` | GET | `/music-userbehavior-service/v1/service/recentlyplayed/query` | `contentType:"1"` | ✅ | `contentSimpleInfos[]` |
| `playback` | POST | `/music-play-service/v3/service/file/bycontentcode` | `contentCode` `contentType:"1"` `qualityType` | ✅ | `fileURL`（顶层）等，见 §2.4 |
| `lyrics` | — | *（默认没有独立端点）* | — | — | 从播放响应推导，见 §2.4 |

三条容易踩的规则：

1. **`POST` 用 JSON 体，`GET` 用查询串**（R32 之前我们一律拼查询串——那是错的）；
2. **分页是 `start`/`limit`（偏移量），不是 `page`/`size`**。通道契约仍然是"页号"
   （`library:favorites` 的载荷是 `{page, pageSize}`），换算是协议层唯一一处（`start = (page-1) × pageSize`）；
3. **`playlistList` 与 `favorites` 是同一个端点**：真接口把歌曲与各种歌单混在一个分页列表里
   （`contentTypes=[1,4,5,7]`），由 `contentType` 分流（官方 H5 的语义：1=歌曲、4=收藏歌单、5=自建歌单、
   7=榜单）。所以"我的歌单"必须**翻页扫完**再挑歌单（见 §2.3 的发现流程）。

值必须是 `https://` URL（非 https 一律按"端点未确定"处理）。

**会话凭据**由主进程经 `sessionHeaders` 注入（`Authorization: Digest username=app-music-baseline,
nonce=…, created=…[, token=…]`，见 §1.5.1 ②）；`snsUserID`（收藏/歌单发现的 `targetSnsUserID` 来源）
从存盘的会话里取。**账号 AT / 音乐会话不进日志、不落明文盘。**

### 2.3 响应语义与归一化（形状 = 参考实测，逐条钉在测试里）

| 事实 | 实现处置 |
|---|---|
| 业务成功 = HTTP 成功 **且** `result.resultCode === "000000"` | `decodeEnvelope` 按它判定；非 `000000` → `api_error`（只带业务码，**不回显 `resultMessage`**——服务端可能回显请求内容） |
| 响应没有 `result` 时仍是老形态 | 兼容 `{code:"0", data}` 信封与直给对象（手工注入的响应/网关包装） |
| 收藏**没有可信总数字段** | 总数 = **完整分页后 ID 去重**；接口上报的 `totalCount`/`totalNum` 只作 `reportedTotal` 记录，绝不当真值。`total` 只在分页走完（`stopReason="exhausted"`）才有值，未走完为 `null`；"已加载 N 首"用 `loadedCount` |
| 分页到底的判据 | 收藏/歌单发现：**整页返回 = 可能还有下一页**（真接口不发 `hasMore`）；搜索：`hasNextPage === "1"`；历史：不分页（参考只验证了一条查询） |
| **歌单详情：整表响应 + 本地切片**（R45A3 fix1；缓存边界见 fix2；在途/失败/整页重复见 fix3） | 2026-10-23 真机只读取证：`library:playlist-detail` 请求 `start=0&limit=50`，服务端**一次回整张歌单**（1623 条）且不认窗口。处置：`getPlaylistDetail` 把**首屏那一次响应**（能自证是整张歌单时：`received > pageSize`，或首页条数 ≠ `pageSize`）按 `kind + playlistId` 记进**API 实例私有内存缓存**（上限 4 张、不落盘/不进设置/不进日志/不跨进程），后续页按 `(page-1)×pageSize` **本地切片**，`hasMore = end < total`，歌单元信息沿用第一页那份。**缓存边界（R45A3 fix2，复审 Important）**：① 第一页不论解析到哪条 kind、不论形状，都先把这张歌单**所有** kind 的旧条目一起失效；② 后续页（`kind="auto"`）**只认这张歌单最近一次解析到的端点**，不按 `owned`→`collected` 的固定顺序撞运气——否则"页 1 由公开端点解析、页 2 切到上一轮那份自建列表"会让同一张歌单的两页来自两条不同路由；③ 会话身份（`token`/`snsUserID` 的散列指纹）一变就**整张清空**，不跨账号复用（指纹只在内存里做变更检测，不落盘、不进日志）。应答额外带 `pageSource`（`"local-slice"` / `"server"`）与 `available`（这一页背后那份响应的条数）。**如实口径**：页 2+ **不发网络请求**，但也**不减少任何字节**——整份已经在第一页下载过（R55 起界面不再显示这句说明；分页边界的只读取证见 §2.3.3）。**R55**：整表已在内存时第一页额外带 `fullSongs`（整张歌单），「播放全部」「加入队列」因此作用于全部曲目；`pageSource:"server"` 的形状没有整表，动作退回已加载的那批。服务端若真的按 `start`/`limit` 分页（形状是整页返回或后续页给一小段），照旧走网络分页并标 `pageSource:"server"`，不被本地切片吞掉。**在途竞态与边界（R45A3 fix3，复审 Important + Minor）**：④ 每次请求都记下开始时的**会话指纹 + 这张歌单第一页的代次**，`await` 回来后两者都对得上才许写缓存/交回调用方；对不上就整条作废并回结构化 `stale_response`（迟到的旧会话响应绝不写缓存、绝不交回——否则新会话的第 2 页会从上一个账号那份列表里切）；两样都只是**进程内存内的不透明比较值**（FNV-1a 散列 + 自增序号），不写进缓存数据、日志、设置或任何文件；⑤ 第一页的失效点挪到**发起之前**：失败与空响应同样让这张歌单所有 kind 的旧条目失效（旧实现失败/空时提前 return，页 2 会读出上一轮那份）；⑥ "恰好一整页"这一档分不清"服务端真分页"与"服务端忽略窗口每次回同一份"：记住整页响应的归一化 ID 序列（含顺序），下一份整页序列**完全相同**而窗口起点不同 → 收敛成 `hasMore:false`、`songs:[]`、`pageSource:"server-repeat"`（`available` 只报这一份响应的条数，**不冒充总数**），避免触底加载反复取同一页；每页内容不同的真分页（如 120 首 → 三页各不同）不受影响。**R45A fix4**：`kind:"auto"` 的第一页若被判为服务端分页，记录该页解析出的 `owned`/`collected` 端点；后续页固定只请求它，失败原样返回而不回退另一端点拼接歌单。路由记忆有界（`max(playlistCacheLimit×4, 8)`），新第一页尝试与会话变化时清理；页 2+ 缺少有效记忆返回结构化 `invalid_response`，要求重取第一页。整表响应仍优先命中既有本地切片缓存。列表时长的 `qualityIdOf` 只接受非负整数或不含空白的纯数字字符串（例如 `0`/`1`/`17`），拒绝负数、小数及非法值。`server-repeat` 会一路保留到分页状态并在歌单详情显示“服务端重复返回同一页，已停止继续加载；…请重新打开歌单后再试”，不把该页 `available` 当作歌单总数，也不显示误导性的到底数量。 |
| 歌单发现**必须翻页** | 歌曲与歌单混在一个列表里，首页很可能整页都是歌。判停条件照参考：短页、**这一页没带来任何新条目**（`fresh === 0`，新条目含歌曲）、或触到保守上限（10 页 × 200 条）。触到上限 → `hasMore: true`（如实说"没扫完"） |
| **`contentID` 等线上字段名** | 归一化成内部形状：`contentID→id`、`contentName→name`、`artistNamePairs/artistName→singer`、`albumID/albumName→albumId/albumName`、`picture.*→coverUrl`、`duration→duration`、`totalCount→count`、`contentType→kind`（4/5/7）。**渲染层一行都不用改**（它的读取兜底表认的就是 `id`/`name`/…） |
| 无 ID 的条目 | 如实丢弃并计数（`skipped`），**绝不编 ID**（列表里出现删不掉的幽灵行比少一行糟得多） |
| 时长单位与固定选源 | `durationOfEntry` 优先可信顶层 `duration` 秒数，再用 `contentExInfoOf` 解 JSON/对象读 `completeFileInfos` 与 `fileInfos`（对象形态的 key 就是档位）；资源必须**显式声明 MP3**（`format`/`mediaFileType`，存在几个就必须全部相符）。仅收有限正数字/数字串且 `<86400` 秒，不按枚举首项选、不取 15/17 的 MKV 视频时长。2026-10-22 真机样本为 240/195/203 秒（第三首视频为 204 秒）；`times="32894214"` 且重复读取会变化，**绝不能作为时长**。所有列表共用归一化，不新增逐曲请求。**R45A2 fix1（用户裁定，记录在 progress.md）：档位放宽为「任意显式声明的音质档」**——**显式 MP3** 仍是硬条件（M4A/FLAC/MKV/`format` 为空一律不取），档位必须**被显式声明**且形如华为的音质标识（数字 / 数字串；没声明 `quality` 的资源不取，不猜），**标准档 `quality="1"` 仍排第一顺位**，其余档作为兜底；标准档自己坏了（编码不符 / 秒数坏或缺失）才退到别的显式 MP3 档。残留（2026-10-23 真机只读取证，同一份数据）：一页 1623 条非空 **1240 → 1408**，仍缺 **215 条**——它们**没有任何一档显式声明 MP3**（只有 M4A / FLAC / 空 `format`），界面如实显示 "—"；本轮 fix1 未重新真机复查（不访问私人账号/网络），该计数来自 A2 报告的只读探针 |
| 自建歌单删除必须 `playlist/delete` | `favorite/delete` 对 type=5 曾返回 `000000` **但没有删掉歌单**——`deletePlaylist` 只打那一个端点，且测试断言"绝不走收藏端点" |

**单页收藏读取**（`readFavoritesPage`，R8 的滚动加载走这条）应答
`{page, pageSize, songs, skipped, reportedTotal, hasMore}`；**没有 `total`**：总数是"拼页者"的结论，
不是单页的结论。

#### 2.3.1 播放资源（参考的最终口径覆盖 R4 的猜测）

**播放地址**：`POST file/bycontentcode`，体 `{contentCode, contentType:"1", qualityType}`，
`qualityType` 只认 `standard="1"` / `lossless="3"`（别的一律回 `quality_unsupported`，**不猜也不降级**）。

| 事实 | 实现处置 |
|---|---|
| **顶层 `fileURL` 才是音频** | `parsePlaybackPayload` 只认顶层 `fileURL`；缺失 → `invalid_response`。参考的样本里 `fileInfos` 甚至根本不是音频（`mediaFileType=JSON`、`fileType=18`），**绝不盲用 `fileInfos[0].fileURL`** |
| `fileInfos` 可能是 JSON 字符串 | 解析失败不抛：降级为 `null` 并记 `file_infos_unparsable` 警告，不影响出音频地址 |
| **`auditionTime` 不能单独判 30 秒试听** | 参考的会员样本实测 `auditionTime=30000` 却完整可播（MP3/FLAC 全曲解码成功）。`classifyAudition` 要求**两个信号齐备**（`auditionTime > 0` **且** 标志位命中）才判 `auditionLikely` |
| 音质**不虚标** | `confirmedPlaybackQuality(playQuality, type)`：`"3"+flac → lossless`、`"1"+mp3 → standard`，对不上就是 `unknown` |
| 播放地址必须落在 CDN 白名单 | 非白名单域 → `unsafe_media_url`（文案只带域名）。白名单与参考**逐字相同**：`dbankcdn.cn` / `tingmall.com` / `kuke.com` |

#### 2.3.2 歌词（R32 从播放响应推导；R38 真机取证后改为三档；**R40 增补第四档**；**R41 升级为六跳编排**）

参考实现里**没有独立歌词端点**。R38 用真实会话取证（CDP 只读，只记字段名与域名）：

**真机事实（2026-10-21，`library:album` 原始响应）**：曲目条目 `albumInfoEx.songSimpleInfos[]`
**自带 `lyricAddress`**（3/3 条都有，`https://music-pics-drcn.dbankcdn.cn/...`，**无查询串=无时效签名**，
GET 200，3.3 KiB / 0.9 KiB / 22 B（三条分别是 3332 / 900 / 22 字节），含 LRC 时间戳行 80/46/1 行）；而**播放响应（`file/bycontentcode`）里
没有任何歌词类字段**——`getLyrics` 从前只问播放响应，所以真机上永远回"没有可用的歌词"
（歌词窗与歌词舞台停在`歌词暂时取不到`）。

所以 `getLyrics` 现在是四档，按"最可能有、最便宜"排序：
| 档 | 来源 | 说明 |
|---|---|---|
| 1 | 设置里显式注入的 `musicEndpoints.lyrics` | 形状按候选键宽容读取；那条路的响应形状**没有实测证据**，只在显式注入时使用 |
| 2 | **已加载过的曲目条目自带的 `lyricAddress`** | 官方 H5 走的就是列表里这条地址。协议层在 `normalizeTrack` 时把它记进**进程内索引**（`trackId → 地址`，上限 400 条先进先出，**不落盘、不跨进程**）；取歌词时再**过一次 CDN 白名单**。命中就省掉一次播放请求 |
| 3 | 播放响应 | `lyricAddress`（含内嵌的 `songInfo`，按**同一份候选表**读）→ 下载；没有地址就看内嵌歌词（`contentExInfo.lyrics`，最多剥两层 JSON 字符串） |
| 4 | **按专辑补条目索引**（R40） | 第 2、3 档都落空时：用**播放响应自己给出的**专辑 id（`albumID`，与 `normalizeTrack` 同一份候选表；含内嵌 `songInfo`）经**既有的**专辑端点拉一次详情——那条响应的条目自带 `lyricAddress`，归一化时顺手进索引，于是"本次运行从没在任何列表里加载过"的曲目（典型：重启后直接播恢复出来的队列）还有一次机会。**代价**：多一次专辑请求（只在前面几档全落空时发生）。**边界（三条，都别当成 bug）**：① 播放响应没给专辑 id 就没有这一档（不猜 id、不编地址），仍然如实回下一段的 `invalid_response`；② **只拉专辑的第一页**（`getAlbum` 的默认 `pageSize` = 50，与所有 `library:*` 分页同一个默认值）——一张 200 首的专辑里排在第 51 位之后的曲目，第 4 档**看不见**（翻页补全不做：为了一首歌把整张专辑翻完是另一种代价，见 `docs/KNOWN_LIMITATIONS.md` B23）；③ **同一对 (曲目, 专辑) 每进程只问一次**（R41 会话内负缓存：失败也是结论，重复取词不再重放那一次注定同样的专辑请求） |

**R41 起这一条是六跳编排**（上面四档仍然是"华为那一侧"的实现，第 4 档之后不再直接回错误）：

| 跳 | 来源 | 命中后 |
|---|---|---|
| ① | **本地导入**（磁盘 `lyrics-local/`，见 §2.12） | 立即返回（`source: "local"`，带 `fileName`/`importedAt`）——**永远压过任何在线结果** |
| ② | **进程内内存缓存**（上限 200 首，先进先出） | 立即返回（`cached: "memory"`） |
| ③ | **90 天磁盘缓存**（`lyrics-cache/`） | 立即返回（`cached: "disk"`），顺手进内存 |
| ④ | 上面那四档（华为） | 写内存 + 写磁盘（`source: "huawei"`） |
| ⑤ | **第三方回退**（Kugou → lrclib，见 §2.12） | 写内存 + 写磁盘（`source: "kugou"｜"lrclib"`，带 `matchedTitle`/`matchedArtist`） |
| ⑥ | 都没有 → 回**第 ④ 跳那一次的真实失败** | 界面按那个 `kind` 说人话（`endpoint_unknown` / `session_required` / `invalid_response`） |

三条边界：**失败不缓存**（只有真拿到歌词才落盘，"这次没有"必须能被下一次尝试推翻）；
**第 ⑤ 跳只在曲目有标题时发生**（第三方库靠关键字搜索，没标题等于盲搜），且匹配严格
（标题 + 艺人 + 时长，半天差 > 8 秒或艺人硬错配一律不显示——错词比没有词更糟）；
**第 ⑥ 跳回的是华为那次的失败**而不是"第三方也失败了"（第三方是额外的机会，不该盖掉更有用的结论）。

四档都没有 → `invalid_response`（**不把整段响应体当歌词**塞给渲染层——那只会让歌词窗显示一坨 JSON）。
下载一律：CDN 白名单内、有界读取（上限 512 KiB）、**不跟随跳转**。

**第 4 档带一行只记键名的诊断日志**（`createMusicApi` 的 `log` 注入位，装配在 sidecar）：
回落时记下播放响应的顶层键名与 `songInfo` 键名——"播放响应里到底有没有 `albumID`"这句话
**尚未实测**（协议层改动要 sidecar 重启才生效），下一台真机跑一次就能从这一行看到答案。

**现场取证（R40，运行中的实例）**：`playback:lyrics` 对**列表加载过的曲目**与**恢复队列里的曲目**
都回了文本（850 / 1081 字符，`warnings: []`），歌词舞台 `[data-testid="playback-stage"]` 里
AMLL 面板挂载、无提示行——即 R38 的第 2 档在真机上确实生效（证据 `.tmp/r40-b23-probe.json`、
`.tmp/r40-stage-after-click.json`）。**B23 的边界因此收窄到"这次运行谁都没加载过的那首"**。

**边界（如实登记）**：索引只包含**用户自己已经加载过的列表条目**（见到的才会被记住）。所以
"重启后直接播恢复出来的队列、且本次运行还没打开过任何列表"这一档仍然只能走第 3、4 档；
第 3 档的实测结论是"播放响应里没有歌词字段"，第 4 档取决于播放响应有没有给专辑 id
（见上面的诊断日志）——**都不是可以靠猜字段绕过去的**（不发明端点、不编地址）。

#### 2.3.3 歌单详情与收藏的分页边界（R55 只读取证）

2026-10-26 用 `.tmp/live-data` 的已登录会话经 `core_call` 只读探测（16 次请求，间隔 ≥1 秒；只记条数与首末 ID 的 SHA-256 前 8 位）。**歌单详情端点不能分页**：

| 端点 | 请求参数 | 结果 | 返回条数 | 首/末条 ID 哈希 |
|---|---|---|---|---|
| `GET /music-userbehavior-service/v1/service/playlist/detail/all` | `playListID=<1623 首的歌单>`、`start=0&limit=50` | ok | 服务端回 **1623**（`available=1623`；页面只看前 50 = 本地切片） | `f93c4ad3` / `03979923` |
| 同上 | `start=0&limit=1` | ok | **1623**（`limit` 被忽略） | `f93c4ad3` / `03979923` |
| 同上（22 首的歌单） | `start=0&limit=22` | ok，`pageSource:"server"` | 22（`received == limit`，这一档不判整表） | `1d32c247` / `c56759e6` |
| 同上 | `start=22&limit=22`（第 2 页，真发网络） | ok，`pageSource:"server-repeat"` | 服务端**原样再回同一页**（22）⇒ `start` 被忽略 | `1d32c247` / `c56759e6` |
| 同上（端点 URL 追加查询参数，经 `settings.data.musicEndpoints.playlistDetail` 覆盖，副本数据根） | `start=0&limit=50&pageNum=1&pageSize=50&offset=50` | ok | **1623**，与基线逐字节同形 ⇒ 这些参数名同样无效 | `f93c4ad3` / `03979923` |
| 同上 | `start=0&limit=1623` | HTTP 400（`limit` 有上限，调大不是出路） | — | — |

参考实现（`.tmp/reference-repo/src/music.mjs` 的 `playlistDetail`）也是同一组 `start`/`limit`，没有别的分页参数可用 ⇒ **"一次取回 + 本地切片"是唯一可行形状**，维持不变。历史端点（`recentlyplayed/query`）同样不分页。

R55 由此把整张歌单在**第一页**一并交出：应答额外带 `fullSongs`（整表已在内存时才有；后续页不重复带），渲染层据此让「播放全部」「加入队列」作用于整张歌单。`start`/`limit` 真被服务端认下的形状（`pageSource:"server"`）没有整表，两个动作退回已加载的那批。

**收藏首页为空（R55 核查结论）**：`library:favorites`（`start=0&limit=50&contentTypes:["1"]`）回 ok、**0 条**、`hasMore:false`；同一会话 `library:history` 回 **200** 条 ⇒ **不是会话问题**。同一个端点在歌单发现那次扫描里（`contentTypes:["1","4","5","7"]`、`limit=50`）只回 **2** 条、且**两条都是歌单**（`scanned == playlists == 2`）⇒ 这份收藏流里没有任何 `contentType=1` 的条目，`contentTypes:["1"]` 的写法也与参考实现一致（字符串形式在同一端点工作正常）⇒ **不是探测参数问题**。结论：该账号确实没有收藏歌曲，界面显示空态是如实的；本条不需要改代码。残留未验：`contentTypes` 的数字类型无法经 `library:*` 通道传入（处理器只透 `page`/`pageSize`），故只验过字符串数组。

### 2.4 CDN 域（已确认可达）

| 域 | probe 实测 | 用途 |
|---|---|---|
| `*.dbankcdn.cn` | `https://www.dbankcdn.cn/` → 200 | 封面 / 音频 / 歌词 |
| `*.tingmall.com` | `https://www.tingmall.com/` → 200 | 封面 / 音频 / 歌词 |
| `*.kuke.com` | `https://www.kuke.com/` → 200 | 封面 / 音频 / 歌词 |

这三个后缀是 `src/protocols/safe-media-url.mjs` 的白名单（与参考实现的 `allowedSuffixes` **逐字相同**），
与 `src-tauri/tauri.conf.json` 的 CSP `img-src`/`media-src` **同源**，一致性由
`test/safe-media-url.test.mjs` 解析 CSP 行钉死。歌词资源走同一份白名单。

### 2.5 主界面 ↔ sidecar 的数据通道（R8 落地）

渲染层到 sidecar 的 `library:*` 七条请求频道（白名单唯一真源 `src/shared/request-channels.ts`，
Rust 镜像见 §3 的 parity 钉）：

| 频道 | 载荷 | 应答 `data` | 说明 |
|---|---|---|---|
| `library:favorites` | `{page, pageSize}` | `{page, pageSize, songs, skipped, reportedTotal, hasMore}` | **应答里没有 `total`**：收藏没有可信总数，总数由渲染层把页拼完后去重得出，未走完就是"已加载 N 首" |
| `library:playlists` | `{page, pageSize}` | `{playlists, hasMore, scanned}` | 歌单元信息。R32 起**协议层会翻页扫完**（歌曲与歌单混在一个列表里，见 §2.3），`hasMore=true` = 触到保守上限没扫完 |
| `library:playlist-detail` | `{playlistId, page, pageSize}` | `{playlistId, playlist, songs, hasMore, pageSource, available[, fullSongs]}` | 缺 `playlistId` → `invalid_payload`；`playlist` 是歌单元信息（自建/收藏两条路由自动分派，见 §2.3）；整表已在内存时第一页额外带 `fullSongs`（整张歌单，R55），后续页不带 |
| `library:search` | `{keyword, page, pageSize}` | `{songs, skipped, reportedTotal, hasMore}` | 空关键字 → `invalid_payload`（不把坏参数透给协议层） |
| `library:album` / `library:artist` | `{albumId}` / `{artistId}` | `{songs, detail}` | 缺 id → `invalid_payload`；`detail` 是端点的原始回包（`getAlbum`/`getArtist` 原样透出，供后续页面取专辑/歌手元信息） |
| `library:history` | `{page, pageSize}` | `{songs, skipped, reportedTotal, hasMore}` | 播放历史；`hasMore` 恒为 `false`（参考只验证了一条查询，不承诺无限翻页） |

**端点注入点**：设置文档 `data.musicEndpoints`，键名 = §2.2 的端点键。R32 起语义是三档：

| 设置里的值 | 含义 |
|---|---|
| **不写这个键** | 用**默认值**（`src/main/music-service.mjs` 的 `MUSIC_ENDPOINT_DEFAULTS` = 业务域 + §2.2 的路径，参考实测） |
| 非空 `https://` 字符串 | 覆盖该键（域名变化时不用改代码） |
| `null` | **显式关闭**该键（离线/排障/测试要一个"确定性不可用"的状态；与 `auth-manager` 的 `loginex: null` 同义） |

陌生键一律丢弃（多收了会让人以为某个接口能用）。全部关闭时每个库页面请求由协议层如实回
`endpoint_unknown`（消息里会写明是"被显式关闭"还是"尚未确定"），UI 显示"接口尚未配置"。
**这是设计落点**：宁可说"没配"，也不给出一个看起来是空的收藏夹。

**会话注入**（R32 接通）：`createMusicService({session})` 拿的是**取值函数**（顶层装配时还没登录），
`{musicSession, userId}` → `{token, snsUserID}` 的映射在 `src/main/music-service.mjs` 的 `sessionOf`
（唯一翻译点）。没有会话时协议层回结构化 `session_required`（"先登录"），
**绝不拿匿名请求冒充"你的库是空的"**。

**渲染层的三态纪律**（`src/renderer/features/library/library-state.mjs`，由测试钉住）：
加载中 → 骨架屏；失败 → `endpoint_unknown` 说"未配置"、其余类别说人话；真的空 → 一句空态。
**失败绝不复用空态文案**——那会把"连不上"说成"你什么都没有"。

**封面（R38 点亮）**：曲目/歌单归一化里本来就有 `coverUrl`（只带 CDN 白名单内的地址），
渲染层现在真的消费它了——歌单卡、曲目行、播放栏、队列行统一走 `<img src>`（`loading="lazy"` +
失败落回 lucide 图标占位），**绝不 `fetch`**：图片走 CSP `img-src`，而 `connect-src` 只有
self/ipc（`fetch` 那张图一定被拦，界面上是一片空白，比占位更糟）。真机实测（2026-10-21）
歌单/曲目 `coverUrl` 全部落在白名单域内（`*.dbankcdn.cn`、`image.tingmall.com`），无需扩白名单。

**仍然未接线**：`AmllBackground` 的专辑图（它在 AMLL 里要的是 `HTMLImageElement`，传字符串会被
AMLL 自己 `fetch` 而撞 `connect-src`；接它得先命令式建 `Image()` 并处理加载竞态，属另一件事）；
音质/试听标注（`actualQuality` 与 `auditionLikely` 已在协议层算出，UI 不显示）。

### 2.6 播放器 ↔ sidecar 的通道（R9 落地）

| 频道 | 方向 | 载荷 | 应答 / 语义 |
|---|---|---|---|
| `playback:resolve-url` | 渲染层 → core（请求） | `{trackId}` | `data` = `parsePlaybackPayload` 的产物 `{url, fileInfos, format, size, bitrate, duration, actualQuality, auditionLikely, signals, warnings}`；缺 `trackId` → `invalid_payload`；没有音乐会话 → `session_required`（"先登录"）；端点被关/未配 → `endpoint_unknown`；地址不在 CDN 白名单 → `unsafe_media_url`（文案只带域名） |
| `player:command` | core → 渲染层（广播） | `{command}`，取值 `play`/`pause`/`toggle`/`next`/`previous` | R9 **预登记**、R11 起**真的有人在发**（Rust 侧托盘的播放三项：`toggle`/`previous`/`next`）；渲染层 `features/playback/player-commands.mjs` 执行，认不出的命令回结构化 `invalid_command`，**拒绝且不猜** |

**播放地址的四条纪律**（R9 裁决，逐条在测试里钉住）：

1. 地址只作**当次**播放结果交给渲染层：不写日志（处理器与运行时都没有日志出口）、不落盘、不缓存
   （可能带时效签名，缓存它等于把"这一次能用"变成"以后也能用"）；
2. 渲染层拿到后**还要再过一次** `safe-media-url`（渲染层唯一允许引用协议层的地方是
   `features/playback/media-url.mjs`），不放行就不装载；状态机的 `guardUrl` 是**必填参数**，
   缺了直接抛——"忘了校验"不是一种可能的写法；
3. **音频地址不进状态**：状态机只记 `loaded: boolean`，UI 与持久化拿不到 signed 音频 URL；
   R44a 展示快照可以带安全封面 URL，它不是任意网络 URL 的通行证；
4. 失败文案不回显整段地址（协议层只给域名），且失败类别原样透传
   （`endpoint_unknown` 就是"接口没配"，不会被改写成"这首歌放不了"）。

**队列持久化**（R44a：兼容 R9 的 ids/index，新增可选安全展示快照）：

```json
{ "schemaVersion": 1, "data": { "queue": { "ids": ["1001", "1002"], "index": 1, "metadata": [{ "id": "1001", "name": "曲名", "artists": "艺人", "duration": 215, "coverUrl": "https://music.dbankcdn.cn/cover.jpg", "albumId": "a1", "albumName": "专辑" }, null] } } }
```

- 键名 `QUEUE_SETTING_KEY = "queue"`，写入仍走 `settings:set` 的 `{patch: {queue: …}}`；
  `queue: null` = 删除该键，IPC 与 schemaVersion 不变；
- `metadata?: Array<QueueEntry|null>` 按 `ids` 原始位置对应；每条只允许
  `id/name/artists/duration/coverUrl/albumId/albumName`。`duration` 为非负有限秒数，文本取不到为 null；
  全部元信息为空时省略 `metadata`，条数不超过当前有效队列长度；
- `coverUrl` 必须经现有 renderer `media-url.mjs`：HTTPS、CDN 后缀白名单、无 userinfo、无显式端口；
  **安全元信息不等于任意网络 URL**。音频 `url/audioURL`、token、头像、raw 对象与任意其他键不保存；
- 读取仅认自有数据字段，不执行访问器；metadata 的 id 不匹配对应 ids 时丢弃该快照。
  旧 ids/index 记录正常恢复，缺元信息时仍显示标识；
- 恢复只还原条目与索引，当前条目与 entries 共用快照，**不自动播放、不 resolve 音频**。

**Media Session**：浏览层能力，不涉新权限、不起新窗口。标题/艺人、可选专辑与安全 artwork
来自队列快照；同 id 内容变化也更新，进度与音量帧不更新。歌词仅在 id/标题/艺人/时长变化时重匹配。
状态映射 `playing→playing`、`paused/loading→paused`、其余 `none`；环境没有这个 API 时静默降级。

**尚未接线（如实登记）**：

1. **歌词来源**：解析适配（`features/lyrics/amll-adapter.ts`：`[offset:]` 补偿 + 翻译行合并）、
   进度同步（`features/lyrics/lyric-sync.mjs`）与 AMLL 面板宿主在本任务交付；
   **歌词文本通道由 R12 接上**（`playback:lyrics`，见 §2.9），**R32 起文本来源真的存在了**
   （从播放响应推导，见 §2.3.2）。这不是改文案了事：五档状态与两句失败文案的区分见 §2.9。
2. **封面/背景图**：R44a 底栏与 QueuePanel 已消费安全 `coverUrl`，并通过可选快照支持重启恢复。
   舞台背景沿用既有 `<img>` 加载再交给 `BackgroundRender` 的路径，本阶段不改沉浸布局；
   不把字符串 URL 直接交给 AMLL 发 `fetch`（`connect-src` 仍只有 `'self' ipc:`）。
3. **音质/试听标注**：`actualQuality` 与 `auditionLikely` 已在协议层算出，UI 本任务不显示
   （不虚标音质）。

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

**主题裁决**：R25 起支持浅色/深色/跟随系统，Rust 持有状态，渲染层只经 `applyThemeChoice`
切类，不在本地缓存第二份偏好。系统档沿用 `prefers-color-scheme`，两份设计令牌仍由
`test/theme-tokens.test.mjs` 钉住。R44a 同步主窗原生标题栏，system 映射 `None`，建窗恢复与
失败后的已保存策略见 §1.7；官方登录页仍按默认渲染，不重开、不注入。

**关窗行为**：`settings:set` 的 `{patch:{closeBehavior}}`（有序枚举 `[tray,quit]`，默认 `tray`）。文案为「最小化到托盘」「退出应用」。精确历史值 `minimize` 在 Node/UI/Rust 读路径迁移为 `tray`，下一次设置保存会写为 `tray`；新写 `minimize` 与其他非法值结构化拒绝。Rust 对其他未知值仍保守退出，不 trim、不忽略大小写。保存中禁用选择，成功按回执重建当前值，失败回滚。设置中的关窗/外观/歌词 Select 均使用官方 `SelectGroup` + `position="popper" align="start" sideOffset={4}`，不改生成原语或选中语义。
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
| `core_get_tray_available` | 无 | `boolean` | 托盘是否**真的**可用：现问 tauri 托盘表，Windows 还须查到原生 Shell 注册位置，不能仅以内部对象存在判成功。安装后用原生图标更新检查 OS 错误，失败清掉内部注册并排队提示；运行权限/完整性级别阻止注册时按不可用处理，不提升权限或绕过系统安全标签。过主窗来源守卫；渲染层只认 `true` |

**关窗两态与 fail-safe**：`decide_close(behavior: CloseBehavior, tray_available)` 是唯一决策。
`tray` 且托盘可用 → `prevent_close + hide`，托盘不可用仍保守退出；`quit` 拦住单窗关闭，
与托盘 Quit 共用 `request_app_exit`。托管 `ExitState` 的 AtomicBool 先 CAS，成功者只起一个后台线程；
重复请求不 spawn。线程创建失败复位门禁并恢复主窗，隐藏失败同样保留应用。
主窗仍显式 `skip_taskbar(false)`。来源守卫、Sidecar/core 白名单与 IPC 权限不变。

**R44e：正常退出先做可失败的保存准备，再做不可逆清理**（顺序是合同）：

1. `PersistenceGate.begin_prepare()`：**冻结**新的渲染层持久写（已受理的继续收尾；内部保存/退出 drain 仍收）；
2. 等已受理的写与整笔主题事务**有结论**（有界，`EXIT_PREPARE_BUDGET_MS`）；
3. 歌词最新配置排空：上一次保存失败的本轮 Quit **至多**重试一次；
4. 主题 uncertain（可能已写但没确认）重存当前权威主题并校验回执；
5. 内部 `settings:get` 作**写队列屏障**（sidecar 先排空已受理的写再读盘）；
6. 校验盘上权威文档（`data.theme` / `data.lyricsWindow`）与运行中的权威值一致；
7. 只有全部成功才：`begin_exit()` → 取消**自窗**菜单/拖动模态（`WM_CANCELMODE`，PostMessage、只对自己的 HWND，
   且只在准备成功之后）→ 停保存任务 → D 的 detach/destroy 屏障 → `shutdown_core` → `app.exit(0)`。

任何一步失败/超时都**保窗可重试**：准入门回到 `Running`、退出 CAS 复位、主窗重新聚焦，并经 `app:notice`
给出可操作提示（Rust 侧的 `dirty`/`saveError` 仍可回读）。失败路径**不**关 stdin、不拿走 process、
不进入不可逆 detach。强杀/断电不承诺刷盘，也不为此加常驻服务。

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

### 2.9 桌面歌词窗与 Windows 任务栏 Beta（R44d；R12/R41 历史见下）

桌面歌词窗本体在 Rust（`src-tauri/src/lyrics_window.rs`）：label `lyrics`、无边框、透明、无阴影、
置顶、不进任务栏、不可缩放、不抢焦点、**先建出来是隐藏的**（摆好几何再 `show`，防闪默认样式）、
独占 webview 数据目录 `<数据根>/webview2/lyrics`（与登录窗 `webview2/login/<partition>` 同款，
与主窗共用会被 WebView2 的库锁互相踩）。**代理三窗收口**：歌词窗建窗时同样走
`webview_proxy::resolve_for_webview(data_root, "lyrics")` + `proxy_url`（R6 的审计缺口：
不接则封面图与音频流绕过设置直连）。

**R41 的三处修正（真机诊断驱动，见 `.superpowers/.../task-41a-report.md`）**：

| 项 | 修正前 | 修正后 | 为什么 |
|---|---|---|---|
| **页面加载是"一锤子买卖"** | 页面只在建窗那一刻加载一次：`toggle` 只 hide/show、`configure` 只改几何、模块里没有 destroy——**任何一次没加载完的页面会被永久保留**。实测现场：dev server 在 16:27:50 挂掉，歌词窗恰好在那一刻建出来（JS 模块没到、React 从未挂载），窗口全透明 ⇒ 屏幕上什么都看不到，开关多少次都一样，**只有重启应用能救**（品红背板实验：那块 960×120 里非品红像素 **0**） | 显示**已有**窗口之前先 `reload()`（新建那条分支不动，它本来就在加载）；**重新加载之后那一份歌词由宿主重发**——`core_lyrics_document` 留一份最后发出去的文档，页面加载完成（`on_page_load(Finished)`）时 `replay_after_page_load` 重发（**R41a**：R41 曾让主窗在"窗刚可见"时重推，那一次必然落在新页 `listen()` 之前，已删），所以打开就能看到这一首的词 | "加载失败 = 永久空白且无路可退"这条性质与触发原因无关：慢盘、杀软拦一下、渲染进程崩一次都会落到同一状态 |
| **歌词窗不跟随主题** | `lyrics-main.tsx` 里没有 `installThemeSync`（也用不了：那条路要经 `core_login_chrome` 读档位，而该命令的来源守卫只放行主窗与两个浮动控件）。于是歌词窗永远停在 `:root` 的**浅色**令牌上——深色主题下用近黑的字浮在深色桌面上，"有歌词但看不见" | 主题作为**查询串参数**随建窗同步到位（`lyrics_window_url(config, theme)`，`theme` 取自 `theme::current_theme(app)`），到窗之后跟随 `theme:changed` 广播（订阅不需要任何权限、不新增命令） | 与"配置走查询串"同一条纪律（订阅是异步的，建窗那一刻可能还没 listen）；颜色令牌（`foreground`/`muted`/`primary`/`contrast`）本来就是主题令牌，不跟随主题时那张表没有意义 |
| **Alt+Tab 里叫 "Tauri App"** | 建窗没给 `.title()`，tao 的默认标题就是 `"Tauri App"`；`skip_taskbar(true)` 在 Windows 上只做 `ITaskbarList::DeleteTab`（tao 0.37.1 `set_skip_taskbar`）——删了任务栏条目，**没碰** `WS_EX_TOOLWINDOW`（实测 exStyle `0x40118`） | `.title(LYRICS_WINDOW_TITLE)` = `"桌面歌词"` | 一个无边框透明条在 Alt+Tab 里显示成 "Tauri App"，用户没有任何线索知道那是什么 |

**请求频道增补一条**（唯一真源 `src/shared/request-channels.ts`，Rust 镜像 `commands.rs`）：

| 频道 | 载荷 | 应答 `data` | 说明 |
|---|---|---|---|
| `playback:lyrics` | `{trackId, title?, artist?, durationSeconds?}` | `{text, format, source, cached?, warnings}` | 歌词**文本**来源（原始 LRC 文本，不是解析结果）。为什么返回文本：逐行滚动必须来自 AMLL 官方组件，而"文本 → 行"是官方 `parseLrc` 的职责（`features/lyrics/amll-adapter.ts` 在它之上补 `[offset:]` 与翻译行）。端点仍是**注入**的（`data.musicEndpoints.lyrics`，与其余业务端点同一张表）：注入过就打它（候选键宽容读取，读到的键名进 `warnings`），没注入就走 §2.3.2 那条链。**R41**：三个可选元信息只用于第三方回退的严格匹配（缺 `title` 就没有那一跳）；`source` ∈ `local`/`huawei`/`kugou`/`lrclib`，`cached` 只在命中内存/磁盘缓存时出现。文本**不进日志**（落盘的副本见 §2.10） |

**广播频道增补四条**（唯一真源 `src/shared/channels.ts`，Rust 镜像 `bridge.rs`，parity 钉住）：

| 频道 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `lyrics:document` | 主窗 → 歌词窗 | `{lines, status}` | 歌词文档。歌词窗**没有业务频道权限**（`core_call` 只收主窗），所以广播是它唯一的数据来源；主窗面板与歌词窗共用**同一份行数组**，两处不可能显示两首歌 |
| `lyrics:progress` | 主窗 → 歌词窗 | `{timeMs, playing, seekGeneration}` | 进度。歌词窗里没有音频元素，进度只能由主窗推；**节流在桥里**（`shouldPushProgress`：≥100ms 或播放/跳转变化才发）；R68 起主窗进度泵订阅播放器通知（不再用 rAF，也不看窗口是否可见：主窗最小化、被遮挡、收进托盘都照推），歌词窗不存在时宿主只缓存最新一帧、不广播，页面加载完成先补发文档再补发进度（播放中按经过时间前推） |
| `lyrics:state` | 宿主 → 两窗 | `{config, visible, revision, dirty, saveError, requestedVisible, taskbar:{supported,attached,reason}}` | Rust 原子 config/revision；保存完成/失败也推进 `runtimeRevision`（同 config revision 的持久化状态可更新、不落盘）。D 的 taskbar 状态同理。另有 `{ready:true}` 握手，不当作配置消费 |
| `lyrics:pointer` | 宿主 → 歌词窗 | `{inside: boolean}` | R69：桌面歌词**锁定**时宿主每 100ms 读一次光标位置（Tauri `cursor_position`），光标进出窗口才广播；歌词窗据此显隐解锁键。光标落在解锁区时宿主临时关掉鼠标穿透，让那一下能点到 |

**Tauri 歌词专命令**（名字唯一真源 `src/shared/commands.ts`，均 async，按 webview label 守卫）：

| 命令 | 载荷 | 回执 | 来源及说明 |
|---|---|---|---|
| `core_lyrics_toggle` | `{checked}` | 同 lyrics:state 状态载荷 | **main-only**；desktop 显示已有窗前 reload，普通关闭只隐藏；Beta 不走 tao show/hide |
| `core_lyrics_configure` | `{config, retrySave?}` | 同 lyrics:state 状态载荷 | **main/lyrics**；只收合同配置字段，未知字段/非法值拒绝；空补丁=纯读（不改配置），当前 lyrics 文档 generation 的订阅后空读同时确认 native ready。`retrySave:true` **只能与空 config 同用**（重存当前运行配置，不是又改一次值）。**`restoreIfPristine` 已取消**：启动配置由宿主只读恢复，传旧参数一律 `invalid_payload` |
| `core_lyrics_control` | `{payload:{action:'toggle'|'previous'|'next'}}` | `null` | **main/lyrics**；非法动作/extra 字段拒绝；转既有 `player:command {command}`，只在唯一主窗播放器执行 |
| `core_lyrics_document` | `{document:{lines,status}}` | `null` | **main-only**；归一、缓存并广播文档 |
| `core_lyrics_progress` | `{progress:{timeMs,playing,seekGeneration}}` | `null` | **main-only**；主窗 ≥100ms / 播放或 seek 变化节流 |
| `core_lyrics_unlock_zone` | `null` 或 `{x, y, width, height}`（有限非负数，CSS 像素） | `null` | **lyrics-only**（R69）；歌词窗用 ResizeObserver 上报解锁键矩形，宿主据此判断光标是否在解锁区；形状不对回 `invalid_payload` |

`core_call` 与 `core_login_chrome` 的既有来源守卫不放宽。歌词窗没有任意业务 HTTP、登录、文档写入或进度写入权限。
歌词页先订阅 document/config/progress/theme，再 `configure({})` 回读权威配置，最后 signalReady；主窗补读最新配置、补文档/进度/主题。

**几何**：desktop 横版默认 **800×128 DIP**、竖版默认 **112×600 DIP**（R51 收紧，原 960×160 / 320×620；R70 竖版由 260×520 改为 240×600；R76 收窄到 lg 档正好两列，最小尺寸按布局取：桌面竖版 96×120、横版与任务栏 240×120，运行中切换布局先下发 `WindowEffect::MinSize` 再改几何；用户拖过的尺寸优先，切换方向/模式会丢弃上一方向的尺寸）；竖版**不再使用官方 AMLL 组件**，由渲染层自渲染单列（`VerticalLyricColumn` + `features/lyrics/vertical-lyrics.mjs`，R61：一句一列、`writing-mode: vertical-rl` + `text-orientation: mixed`、字号与横版同档位（R70）、按演唱进度沿书写方向平移）；横版、任务栏与沉浸页仍走官方 `LyricPlayer`。taskbar 最多 **1200×44 DIP**，实际尺寸由安全空白决定，不能走 desktop 几何/样式分支。
只 mode/layout 变化重新计算 size/position，颜色、字号、锁、点透、演出选项不重定位。已有用户位置保留并夹入当前歌词窗显示器工作区；首次优先主窗显示器，退主屏。
window-state 不自动恢复 lyrics 的旧尺寸/坐标，避免异步覆盖配置几何或 Taskbar。拖柄与非交互歌词宿主通过官方 `startDragging()` 拖动，排除按钮/输入/滑块等交互节点。

> **"负偏移钳 0"的准确含义**：钳的是**偏移**（居中量 / 贴底量），不是最终坐标。
> 副屏摆在主屏左边时工作区原点就是负的（-1920），把最终坐标钳到 0 会把窗口从左侧副屏
> 扔到主屏上。钳偏移的效果是：窗口比工作区还宽/还高时贴左上角摆，绝不推出屏幕外。
> 由 `a_monitor_left_of_the_primary_keeps_its_negative_origin` 与
> `every_monitor_keeps_the_window_inside_its_own_work_area` 两条用例钉住。

**配置**：`{mode:'desktop'|'taskbar', layout:'horizontal'|'vertical', style:'clean'|'panel'|'bare', size, color, locked, enableBlur, enableScale, enableSpring, showControls, taskbarSize, taskbarColor, taskbarCustomColor, taskbarKaraoke}`。
默认 desktop/horizontal/clean/lg/foreground，locked=false，四个演出/控件布尔=true。R69 起没有 clickThrough 配置（落盘键 18→17，旧盘上的键被忽略）：鼠标穿透由 `mode=taskbar || locked` 推导；锁定时衬底更淡（clean 为 `bg-background/35`，panel 为 `bg-card/65`），`bare`（纯透明）不画衬底、字加 `drop-shadow-md`。AMLL 官方 props 控制模糊/缩放/弹簧，panel 使用 shadcn Card 语义 surface（R77 起只在桌面模式：任务栏只画歌词文字，不套卡片底色与边框，判定在 `lyricsPanelCard`）；宿主隔离 AMLL 合成以保证浅暗文字可见。桌面 panel+contrast 的有效字色使用既有 foreground 令牌，配置仍保留 contrast，切回 clean 还原；任务栏没有卡片底，字色按 `taskbarColor` 原样取。
字号档位为 **桌面 16/20/28/40/56px**（`sm|md|lg|xl|xxl`）与 **任务栏 12/14/16/18/20px**（`tsm|tmd|tlg|txl|txxl`）两张表，id 不重叠、互不通用（`taskbarSize` 收桌面档位一律 `invalid_payload`）。颜色只认 foreground/muted/primary/contrast 令牌。
**竖版字号（R70）**：竖版与横版用同一套字号档位——竖版 CSS 读 `amll-theme.css` 里的别名 `--vertical-lyric-font-size`（= 横版 `--amll-lp-font-size`），不随窗口宽度和拖放变化，设置气泡面板的「字号」项在竖版下照常可用。正在唱的字按 `--vertical-word-progress`（0–1，每帧由 `setProperty` 写在视口上）由上往下连续扫亮；减少动效时不扫。R61 的 `clamp(1rem, 26cqw, 6rem)` 与对应纯函数已删除。
**任务栏外观独立（R59）**：`taskbarSize`（默认 `txxl` = 20px）、`taskbarColor`（默认 `foreground`）、`taskbarCustomColor`（`#RRGGBB` 或空串，默认空）、`taskbarKaraoke`（逐字高亮，默认 `true`）。`mode=taskbar` 时歌词窗**只读**这四个字段（字号/颜色/自定义色/逐字），`mode=desktop` 只读 `size`/`color`/`customColor` 且逐字恒开；两套值各存一份，改一边不动另一边。逐字关闭 = 不经逐字词推导（行级数组直接交给官方 `LyricPlayer`，按行渐变），仍是同一个官方组件。任务栏模式强制横条点透；clean/panel 均不渲染任何控件带，showControls 不改变 44px 歌词可用高度。
任务栏这张卡只在**宿主回报 `taskbar.supported === true`**（Windows）时渲染，配置入口在主窗设置页「任务栏歌词（Beta）」卡（窄命令 `core_lyrics_configure`），不出现在桌面歌词的齿轮弹出窗里。
**快捷切换（R71）**：播放栏与沉浸页的歌词开关旁各有一个下拉（shadcn `DropdownMenu` 单选：关闭 / 桌面歌词 / 任务栏歌词（Beta）），两处共用 `LyricsTargetMenu`。选择经 `selectTarget` 交给纯函数 `lyricsTargetPlan(on, mode, target)` 决定动作：「关闭」只在窗开着时关窗；选桌面或任务栏时，模式不同才改模式，窗没开才打开。齿轮气泡面板另有「位置」单选（桌面 / 任务栏（Beta）），直接改 `mode`。宿主回报 `taskbar.supported !== true` 时，任务栏项禁用并写「仅支持 Windows」。
锁定仅禁拖，解锁/媒体仍可点击；点透整窗不接鼠标，须在主窗设置恢复。

**恢复/保存（R44e：唯一写者是 sidecar）**：Rust 持有本次运行的权威配置与 revision，**启动时只读**恢复
`settings.json` 的 `data.lyricsWindow` 当基线（坏文件/坏字段按默认，不回写默认值）。
**落盘由 Rust 的保存任务拥有**（独立线程，与 WebView / React 生命周期无关）：单在途 + 最新待写，
成功后只确认对应快照（期间来了新值继续写），失败保留运行值、标 `dirty`/`saveError` 并**停止自动重试**；
`retrySave` 或下一次改动才重试。写入的字段是合同里的 **18 个** config 键（R59 起含 `taskbarSize`/`taskbarColor`/`taskbarCustomColor`/`taskbarKaraoke`），**不含** `visible`/`revision`/`effectiveSize`/`dirty`。旧 `settings.json` 缺这些键时按默认值恢复，坏值不覆盖运行值。
同一 status 订阅按 `revision` + `runtimeRevision` 接收，旧回执不倒退；渲染层不再有保存队列，
主窗观察者卸载、渲染层崩溃、登出门禁都不影响落盘。失败文案由渲染层按稳定代码翻译（`saveErrorText`），
设置页与歌词窗都能显示"未保存/未确认 + 重试"。sidecar 的 `load→merge→rename` 在**唯一一条写尾链**上串行，
它与内部 `settings:get` 之间由"读排空屏障"排序（读之前先等已受理的写落定）。

**歌词数据流**：主窗在曲目变化时调 `playback:lyrics` → 官方 `parseLrc` 适配
（`features/lyrics/amll-adapter.ts`）→ `player.setLyrics(lines, status)`（主窗面板）
**与** `core_lyrics_document`（歌词窗）共用同一份行；进度由主窗进度泵订阅播放器通知（R68 起不再用 rAF） → 节流 →
`core_lyrics_progress`。歌词状态五档（`unavailable`/`loading`/`empty`/`ready`/`failed`）：
端点没配说"尚未配置"，别的失败说"暂时取不到"——**两句不同的话**（R9 的"尚未接入"在 R12
之后不再成立，因为频道已经接上了，缺的是端点）。

**托盘勾选收口**：勾选态由托盘的 `CheckMenuItem` 自己镜像并翻转（R11，不建假同步链）。
R12 只补**失败路径**：窗命令失败时 → 一句 `app:notice`（带原因）**+** 勾选翻回**窗的实际状态**
（`tray::revert_lyrics_checked`，只有托盘握着那个句柄）。翻回不再发广播：那是
对已发生事实的修正，不是新的目标态（再发一条会让渲染层再跑一遍大概率仍然失败的命令）。

**R44d 任务栏歌词（Beta）**：用户明确授权 Windows 精确自窗 `SetParent` 到合法 Shell primary/secondary root 或 Win10 ReBar/WorkerW。原生写仅 `taskbar_lyrics.rs` 内、owner UI 线程、当前创建代次且 PID/thread/live 相符的 lyrics HWND；Explorer 只读，不改任务按钮样式/尺寸，不用 DLL/全局 Hook/系统 kill。非 Windows 不支持，不再有 work_area 贴边回退。

状态增补 `{requestedVisible, taskbar:{supported,attached,reason}}`，与 config/revision 分离，仅透传，不落 settings；同 revision 可更新 D 状态。reason 词表为 disabled/waiting/attached/no_space/uia_unknown/timeout/access_denied/shell_unavailable/auto_hide/dpi_mismatch/stale/attach_failed/unsupported/destroy_failed。句柄/父矩形不下发 renderer。用户请求显示与实际 visible 分离，隐藏或 no_space 后继续 probe。

几何来自实际 parent 客户区与 MapWindowPoints，UIA 只读递归已知纯容器、保留未知节点/Win10 任务列表；8 DIP 间隔、至少 100 DIP 连续空白、最多 1200×44 DIP。UIA 独立单 MTA 线程/单在途，500ms 刷新、从查询开始计龄 2 秒，迟到永久丢弃；独立定时停显。apply/show 前重核 Shell/parent/monitor/DPI/客户区与实际 GetParent/rect，并显式同步自身 WebView client bounds。换 parent/monitor 或退出 Beta 销毁重建自窗，不把 tao 原生样式缓存混用；URL generation 绑定订阅后 configure 空读 ready，继续 C 文档/进度/主题握手。

退出先登记 Destroyed 屏障再 destroy，固定 deadline 不因重试延后；不 join UIA，sidecar 幂等收尾，final-exit 许可后 ExitRequested 放行。window-state 只存主窗，不记录 Shell child 几何。MIT 来源固定 commit 与全文许可见 NOTICE。

**如实登记的未验证项（本任务）**：

1. **R44c Windows 已真验**：拖柄 rect 变化、锁后不动/解锁恢复、锁中媒体一次、横竖几何、样式/颜色/锁/点透不回跳、hide/reopen 最新配置、配置保存及重启恢复；证据 `.tmp/r44c-native-evidence.json` / `.tmp/r44c-restart-evidence.json`。多显示器/高 DPI 和 Linux/macOS 未实机验；
2. **Windows Beta 成功路径已真机验证（R47 `a62a0ad`）**：真实 Explorer 上 `attached:true`、`GetParent(歌词窗) == Shell_TrayWnd (0x20072)`、子窗 `8,1034 680×44` 落在栏体客户区内，槽位像素差分 5235–5394 px 而空段与任务栏按钮区 0，`WindowFromPoint` 17 点全归 Explorer，切回 desktop 与退出无残留（`task-47-report.md`）；未验项：多屏/高 DPI/自动隐藏/`TaskbarCreated` 重建/长时间 z-order/Win10/Linux/macOS/安装包。仓库 `target/debug` 目录带 Low 完整性标签导致直接跑该 exe `access_denied`，属构建目录 ACL 的环境现象，不是产品路径；
3. **歌词端点未联调**：`playback:lyrics` 的**响应形状**是宽容读取的（候选键见上），
   真实形状确认后应收敛到那一个键（`warnings` 会指出实际读到的是哪个）。

**已知限制**：

1. **位置不作为配置写入 settings**：window-state 仍可记录位置，但不自动覆盖歌词配置几何；重启后按 mode/layout 与工作区摆放；
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
   **R56 补齐的三件事**：① 时间用 `TimezoneStrategy::UseLocal`（插件默认 UTC，与用户看到的系统
   时间差一个时区），行格式因此是 `[日期][时间][级别][target] 正文`（读取端按值解析，插件的
   `[日期][时间][target][级别]` 旧顺序同样认得）；② sidecar 的 stderr 从 `inherit` 改成**管道**，
   宿主后台线程逐行读进同一条 `log` 管线、target 固定 `hwmusic_core`（级别取 sidecar 自己的
   `[hwmusic-core][warn]` 标记，没有标记的续行按 info），读线程**不 join**——收尸不等管道关闭；
   ③ 设置页「日志」的数据源 `core_read_run_log`：只允许主窗（`require_main_webview`），回日志文件
   **最后 500 条** `{time,level,source,message}`，返回前逐条脱敏（`run_log::redact`：`Bearer` /
   `Authorization`·`Cookie` 类头部 / `token`·`code`·`ticket`·`sign` 等键的值一律 `***`）。
   **R72 补齐的三件事**：① 宿主每次启动先写一行「运行日志：本次启动（pid N）」，设置页「日志」默认只显示本次启动（可切「全部」），旧启动留下的警告不再混进当前视图；② 快捷键主组合被占用、改用备选组合成功记 INFO，一个都没注册上才记 WARN；③ sidecar 被宿主按请求收尸后退出记 INFO「按请求退出」，非主动退出仍记 WARN。
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

**请求频道（渲染层 → core，唯一业务通道 `core_call`）** —— 共 21 条，真源 `REQUEST_CHANNELS`：

| 频道 | 载荷 | 应答 `data` | 失败类别 | 落地 |
|---|---|---|---|---|
| `auth:login` | 无 | `{started:true, loggedIn, epoch, loginInFlight}` | — | R4/R7 |
| `auth:logout` | 无 | `{sessionCleared, cacheCleared, notes[]}` | 清不干净**不改写成成功**，原因进 `notes` | R4/R7 |
| `auth:cancel-login` | 无 | `{cancelled}`（`false` = 本来就没有进行中的登录，**不是错误**） | — | R7（R25 起渲染层不再直接调它：浮动控件的「返回扫码登录」走 `core_login_chrome`，落到**同一个结论槽**） |
| `auth:qr-start` | 无 | `{content, expiresInMs}`（二维码内容 + 有效期；之后的状态变化走 `auth:qr` 广播） | 建单失败 → 结构化类别 + `auth:qr{failed}` | R16 |
| `auth:get-status` | 无 | `{loggedIn, busy, restoring?}`（**与 `auth:status` 广播同形状**；`restoring` 只在恢复落定前出现，恢复期间的广播也带它、结论广播不带） | 频道不可用即结构化错误（渲染层**不据此猜档位**，只把原因说到状态行上） | R19（R53 加 `restoring`） |
| `auth:cancel-qr` | 无（`null`） | `{cancelled:true}`（幂等：没有在跑的会话也回已停） | 端口取消失败只记日志，仍回已停 | R53 |
| `settings:get` | 无 | `{settings}` = 归一后的完整文档 | 读不到/读坏了 → 回默认文档（代理当没配）+ 一条日志，**不抛、不砸文件** | R6 |
| `settings:set` | 二选一：`{patch:{...}}`（合并）或 `{reset:true}`（已知键回默认） | `{settings, restartRequired}` | `invalid_payload`（两个都给 / 都不给 / 类型不对，**不写盘**）；文件认不出 → 结构化错误并**保留原文件** | R6 |
| `settings:test-proxy` | 见 §2.7 | 见 §2.7 | 见 §2.7 | R10（接 R6 的测试器） |
| `library:*`（7 条） | 见 §2.5 | 见 §2.5 | 见 §2.5 | R8 |
| `playback:resolve-url` | 见 §2.6 | 见 §2.6 | 见 §2.6 | R9 |
| `playback:lyrics` | 见 §2.9 | 见 §2.9 | 见 §2.9 | R12（R41 增可选元信息与 `source`） |
| `lyrics:import` | `{trackId, text, fileName?}` | 生效的歌词文档（`source:"local"`，带 `fileName`） | `invalid_payload`（缺 trackId / text 不是字符串 / 文本 > 512 KB）；文本不含时间戳歌词行 → `invalid_response`；没有数据目录 → `cache_unavailable` | R41（§2.12） |
| `lyrics:cache-info` | 无（`null`） | `{available, bytes, entries, localBytes, localEntries}` | 读不出占用 → `invalid_response`；没有缓存端口（无数据目录）→ **不是错误**，`available:false` | R41（§2.12） |
| `lyrics:cache-clear` | `{local?: boolean}` | 清完之后的**新**占用（同 `lyrics:cache-info`） | 没有数据目录 → `cache_unavailable`；其余 → `invalid_response` | R41（§2.12） |

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
| **枚举级严格** | 新写 `closeBehavior` 只接受 `tray`/`quit`，精确历史 `minimize` 只在读路径迁移 `tray` | 写非法值直接报错，不悄悄改成关窗退出 |
| **结构级严格** | `patch.proxy` 不是对象也不是 `null` → `invalid_payload` | 形状错了不该猜 |

另：`patch` 里某个键给 `null` = **删除该键**（§2.6 的队列清理依赖这条语义）。

**宿主要求（core → 宿主，经 `rpc.callHost`）** —— 共 6 条，真源 `HOST_REQUEST_CHANNELS`：

| 频道 | 入 | 出 | 落地 |
|---|---|---|---|
| `host:notify` | `{text}`（非空字符串，会 `trim`） | `{ok:true, data:null}` | R3：Rust `HostPlan::Notify` → `tauri-plugin-notification`；标题 = 应用显示名。空/非串 → `invalid_payload`（**不回显内容**） |
| `host:secure-encrypt` | `{plaintext}` | `{cipher}`（base64 的 DPAPI 信封） | R5：`session-store.mjs` 只认 `data.cipher` |
| `host:secure-decrypt` | `{cipher}` | `{plaintext}` | R5：只认 `data.plaintext`；解不开 → `invalid_cipher`（**不当成「没登录」**）；后端不可用 → `secure_store_unavailable`，**没有"失败降级成明文"这条分支** |
| `host:open-login` | 见 §1.7 | 见 §1.7（长轮询：窗收场后才答复） | R7 |
| `host:cancel-login` | 见 §1.7 | 见 §1.7 | R7 |
| `host:local-lyrics-source` | `{trackId}`（`local:<32 hex>` 或裸 id） | `{bytes, source, name?}`（`bytes` = 原始字节的 base64，`source` ∈ `lrc`/`txt`/`embedded`）；没有歌词 → `data:null` | R65：查找顺序 同名 `.lrc` → `.txt` → 内嵌；上限 512 KiB；id 形状不对 → `invalid_payload`。见 §2.14 |

- 出向 `callHost` **只放行宿主白名单**：非白名单当场回 `unknown_channel` 且**不写帧**（`src/host/rpc.mjs`）。
- `host:notify` 的**端到端没被跑过**（R3 的 sidecar 不主动发起宿主要求）：Rust 单测覆盖了决策与
  一次性守卫，**真弹通知这条链没有运行期证据**（见 §6 的 untested 口径）。

**跨语言镜像**：两份清单的字面量只出现在 `src/shared/request-channels.ts`；Rust 侧
（`src-tauri/src/commands.rs` 的 `require_request_channel` / `route_host_request`）是**刻意的镜像副本**，
由 `test/channel-parity.test.mjs` 扫源码钉住集合相等。入口对 `REQUEST_CHANNELS` 逐个补齐兜底：
尚未实现的频道回结构化 `unimplemented`（**不静默、不挂起**）。

### 2.12 歌词的缓存、本地导入与第三方回退（R41 落地）

三条新频道见 §2.11；这一节写它们背后的**磁盘布局、纪律与出口**。代码真源：
`src/main/lyrics-cache.mjs`（fs，sidecar 持有）、`src/main/lyrics-store.mjs`（纯助手）、
`src/main/lyrics-provider.mjs`（匹配器）、`src/main/lyrics-fallback.mjs`（网络）。

**两个目录**（都挂在宿主给的**数据根**下，即 `--data-dir`；没有数据根时缓存如实报 `available:false`，
**不假装"0 条 0 字节"**）：

| 目录 | 内容 | 谁写 | 优先级 |
|---|---|---|---|
| `<数据根>/lyrics-cache/` | 在线取到的歌词（华为那条链 + 第三方回退） | `getLyrics` 命中即写 | 低于本地导入 |
| `<数据根>/lyrics-local/` | 用户**自己导入**的 `.lrc`/`.txt` | `lyrics:import` | **永远压过任何在线结果**（§2.3.2 第 ① 跳） |

**六条磁盘纪律**：TTL **90 天**（过期当没命中，不删文件）；**原子写**（同目录 temp + rename）；
单文件上限 **512 KiB**（超了不写，不截断）；**空歌词不落盘**（"至少一行带 LRC 时间戳"是判据——
`hasTimedLyricLine`，与官方 `parseLrc` 在本项目里的既有结论等价，见该函数说明）；
`lyrics-cache/` 上限 **3000 条**按 mtime 裁最旧；**写缓存失败不打扰用户**（只留一行日志），
**本地导入失败要抛**（用户按了导入就 expect 它记住）。

**本地导入的链路**：渲染层 `<input type="file" accept=".lrc,.txt">`（系统标准控件，**零 Rust、
零 capability**）→ 渲染层解码（BOM 探测 UTF-16LE/BE/UTF-8 → UTF-8 严格 → **GBK 退化**，
`TextDecoder('gbk')` 由 Chromium 的完整 ICU 提供）→ **官方 `parseLrc` 判"有没有歌词行"**
（没有就拒，并说清"纯文本歌词暂时显示不了"）→ 只把**文本**交给 core（不发路径：少一条
"sidecar 去读一个别人给的路径"的信任边界）→ 落 `lyrics-local/` → 立刻生效（导入的那一份推给
主窗面板与歌词窗）。512 KB 上限与空文件在渲染层就被拦下（不把大字符串递给磁盘模块再指望它报错）。

**第三方回退（Kugou → lrclib）**：`https://songsearch.kugou.com` / `krcs.kugou.com` /
`lyrics.kugou.com` / `https://lrclib.net`。三个事实写清楚，免得下次有人以为漏了配置：

1. **不需要任何白名单**——sidecar 侧的出口**没有域名白名单**（`src/main/proxy.mjs` 只管代理与例外）；
   CSP 的 `connect-src` 只约束**渲染层**，而这两个请求都发生在 sidecar 进程里，歌词文本经 IPC 回来
   （与 `playback:lyrics` 同路）。媒体白名单（`safe-media-url.mjs`）管的是 `<audio>`/`<img>`，与此无关。
2. **走全局 fetch ⇒ 设置里的代理照常生效**（`applyStartupProxy` 装的就是全局 dispatcher）。
3. **UA 克制**：`HuaweiMusicDesktop/0.0.1 (unofficial study client)` —— 只自报"这是什么客户端"，
   **不带任何本项目凭据**（无令牌、无账号标识、无会话头；酷狗那三个请求另带 `referer: https://www.kugou.com/`）。
   超时 8 秒（顺带试一下的东西，不该拖成华为接口那样的 25 秒）、单响应 512 KiB、不跟随跳转、
   **失败静默回 `null` 且不缓存**（缓存一份"这次没有"等于把这个来源永久关掉）。

**匹配器的硬规则**（`lyrics-provider.mjs`，整片单测覆盖）：艺人硬错配一律拒绝；标题不精确时
**必须有**时长佐证（`|Δ| ≤ 8 秒`，两边都要 > 30 秒才参与）；分数门槛 `MIN_SCORE = 1.5`。
理由一句话：**显示错歌的词比没有词更糟**。

### 2.13 向**已有**歌单加歌：**没有可用证据（R63 结论：不实现；R73 实测确认没有追加语义）**

用户要的是"右键曲目 → 加入歌单 → 选一张本人的歌单"。这需要一个**追加**语义的写端点。
R63 按下面四条标准逐条查过，**一条都没满足**，所以 `src/renderer/features/shell/track-menu.mjs`
的 `ADD_TO_PLAYLIST_SUPPORTED` 保持 `false`，菜单里没有这一项（也没有放死按钮）。

**证据标准（四条全中才算有）**：① 端点路径与方法明确；② 参数明确；③ 成功判据明确；
④ 语义明确是"追加歌曲"，不是"用新列表覆盖整张歌单"。**语义分不出来一律按无证据处理**——
对真实用户歌单发错语义的写请求可能毁掉整张歌单。

**查过的来源**（都是只读）：

| 来源 | 位置 | 结论 |
|---|---|---|
| 本仓协议层 | `src/protocols/music.mjs` 的 `MUSIC_ENDPOINT_PATHS`（52–75 行） | 只有 `playlistDetail` / `playlistDetailPublic` / `playlistDelete`，**没有**任何加歌端点 |
| 本仓端点差分表 | `test/reference-parity.test.mjs` 的 `notImplementedPaths`（91–98 行） | 参考里与歌单写相关的路径只有 `playlist/create`、`playlist/update`，本仓**故意没接** |
| 参考项目源码 | `talongao/huawei-music-desktop`，main @ `3fd67319fa4b4a10de00d6da7d88e4e52ebd8327`（2026-10-18，共 23 个提交，已整仓下载只读检索） | 歌单写操作只有三件：`MusicClient.createPlaylist`、`updatePlaylistDescription`、`deletePlaylist`（`src/music.mjs` 83–103 行）；`src/main/writes.mjs` 的写控制器只有 `createPlaylist` / `updateDescription` / `deletePlaylist`，**没有任何"往已有歌单加歌"的函数** |
| 参考项目文档 | `docs/API_CONTRACT.md` §3.5–§3.7（170–211 行）、`docs/authorized-feature-validation.md` 26 行、`README.md` 220 行 | 作者本人账号实测过的是"建歌单（带一首歌）→ 改简介 → 删歌单"；原文写明"本轮验证的是简介修改，**不宣称已验证**改名、排序、封面或**增删歌单内歌曲**"，并写"不提供改名/封面/**曲目增删**的假按钮" |
| 官方公开 H5 | — | R57 已查（15 个候选路径全部 404，公开 H5 前端不存在），本轮不重复 |

**为什么 `playlist/create` 与 `playlist/update` 顶不上**：

- `POST /music-userbehavior-service/v1/service/playlist/create`，体
  `{createTime, playListName, songCodes[], shareFlag:"0"}`——**没有 `playListID` 参数**，
  它建一张新歌单并塞进首批歌；拿它去"加到某张已有歌单"连目标都表达不了（语义也不同：
  实测的判据是响应回一个新 `playListID`）。
- `POST /music-userbehavior-service/v1/service/playlist/update`，已测的只有
  `{actionType:"1", listDesc, playListID}` = **改简介**。参考文档明确写"不把 actionType=1
  推断为通用更改名称/删除/改封面操作；**其他动作未测**"。`actionType` 的其它取值是否等于
  "换掉整张歌单的曲目列表"、"是否追加"、"`songCodes` 是不是它的参数"——**全是未知**，
  正是上面第 ④ 条要拒的那一档。

**真实写入未验证（未获授权）**：本轮**没有**对真实接口发过任何请求（包括"试一下"），
没有读 `.local\`，没有启动真实应用实例。所以即便将来找到了端点，也必须先有用户授权的
"临时歌单 + 写后读回 + 清理"验证，才能进界面。

**什么时候可以翻这个闸门**：拿到满足四条标准的端点证据（路径/方法/参数/成功判据/**追加语义**）
→ 写进本节的逐端点表 → 协议层加一条写通道（不自动重试）→ 再把
`ADD_TO_PLAYLIST_SUPPORTED` 改成 `true`（菜单项、子菜单、提示都在那一处之后才出现）。

**R73 实测（2026-10-27，用户授权，只动临时歌单）**：一次性脚本只在内存里持有会话、不打印不落盘，共 15 次请求（预算 30）。`playlist/create` 带 `songCodes` 回 `000000`，读回正好 1 首（首次在用户账号上实测通过）；`playlist/update {actionType, playListID, songCodes}`：`actionType=2` 回 `000000` 但曲目不变（noop），`3/4/5` 回 HTTP 400——**没有任何一个值是追加**。清理：建 1 删 1（`playlist/delete`），以歌单列表核对临时歌单已不在；注意 `playlist/detail/all` 对已删 id 仍回 ok + 0 首，删除只能以列表为准。结论：第 ④ 条仍不满足，按用户裁决暂不做，`ADD_TO_PLAYLIST_SUPPORTED` 保持 `false`。

### 2.14 本地曲库（R65）：四条命令、`hwlocal` 协议与 `host:local-lyrics-source`

本地曲库由 Rust 拥有：选文件、读元数据、存索引、按 id 提供音频与封面。**渲染层与 sidecar 永远拿不到原始路径**，只拿 id。

**四条命令**（真源 `src/shared/commands.ts`；Rust `local_library.rs`，每条都过 `require_main_webview`，只对主窗开放）：

| 命令 | 入 | 出 | 备注 |
|---|---|---|---|
| `core_local_base_url` | 无 | `{baseUrl}` | 平台形态见 PLATFORM_DIFFERENCES §8；渲染层缓存一次，不猜 |
| `core_local_list` | 无 | `{tracks[], available}` | 快照；`available` 说的是文件还在不在（每条一个） |
| `core_local_import` | `{paths?: string[], folder?: boolean}` | `{tracks[], available, added, updated, rejected[], truncated}` | `paths` 省略 = 弹系统对话框（`folder:true` 选文件夹）；取消不是错误 |
| `core_local_remove` | `{id}`（收 `local:<32 hex>` 与裸 id 两种） | `{removed, tracks[], available}` | **只删索引记录，不删用户的文件** |

- 每条记录只有 `id`（128 位随机、32 位十六进制，不可枚举）与元数据：`title` / `artists` / `album` / `duration` / `format` / `importedAt` / `available` / `hasCover`。
  **没有 `path`**——这是"没导入就拿不到"这条保证的落点。
- 索引落在数据目录下的 `local-library.json`（先写临时文件再 rename）；同一路径重复导入按去重更新。

**`hwlocal` 协议**（真源 `local_library.rs` 的 `handle_protocol`，注册在 `lib.rs`）：

- 路径只有两种：`/<id>`（音频）与 `/<id>/cover`（封面）。渲染层拼地址走 `localMediaPath`，验地址走 `parseLocalMediaUrl`（共同真源 `src/shared/local-track.ts` 的 id 形状）。
- 只服务**主窗**：来源 label 不是 `main`（歌词窗、内嵌官方登录页、浮动控件）一律 404。歌词窗不取本地封面/音频。
- 未知 id、未导入、路径形状不对、格式不支持、封面没有内嵌图 → **404**（界面用占位图，不是裂图）。
- 音频支持 `Range`：单区间回 **206 + `Content-Range`**，起点越界回 **416**，认不出的 `Range` 按整份 200 处理。拖动进度靠这条。
- 封面响应带 `access-control-allow-origin: *`：AMLL 取色用 CORS 模式的 `new Image()` + `getImageData`，不带这个头会抛 `SecurityError`。**没有回显 `Origin`**（未取证的真实 WebView2 行为见 task-65 报告）。
- CSP 只在 `img-src` 与 `media-src` 加了这两个来源（`http://hwlocal.localhost`、`hwlocal:`），`default-src` / `connect-src` 未动。

**宿主要求 `host:local-lyrics-source`**（登记见 §2.11；真源 `HOST_LOCAL_LYRICS_SOURCE`）：

- 载荷 `{trackId}`（`local:<32 hex>` 或裸 id）；应答 `data` = `{bytes, source, name?}`，`bytes` 是**原始字节的 base64**（编码识别只由 sidecar 的 `decodeLyricsBuffer` 做一份：UTF-8 / UTF-16 / GBK）。
- Rust 侧的查找顺序：同目录同名 **`.lrc`** → 同名 **`.txt`** → **内嵌歌词标签**；外挂文件是用户自己放的（看得见、改得动），所以优先。
- 没导入 / 没有歌词 → `data` 为 `null`（不是错误）；`trackId` 形状不对 → `invalid_payload`；字节上限 512 KiB（`LYRICS_SOURCE_MAX_BYTES`，与 `LYRICS_IMPORT_MAX_BYTES` 同值）。
- sidecar 侧的优先级：**用户手动导入**（`lyrics-cache` 的 `readLocal(trackId)`）> 本请求给的字节；两者都没有才回落到在线歌词。

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
| `QUEUE_SETTING_KEY` | `"queue"` | `src/renderer/features/playback/queue.mjs` | R44a：队列持久化键（`data.queue = {ids,index,metadata?}`，兼容旧记录，仅安全展示快照） |
| `PROXY_TEST_URL` | `https://oauth-login1.cloud.huawei.com/` | `src/host/proxy-handlers.mjs` | R10：`settings:test-proxy` 的唯一目标（不接受调用方指定；业务端点仍待联调） |
| `CORE_SET_AUTOSTART` / `CORE_GET_AUTOSTART` | `"core_set_autostart"` / `"core_get_autostart"` | `src/shared/commands.ts` | R10：命令名的唯一真源（渲染层只用常量；Rust 侧为镜像副本，由 `test/autostart.test.mjs` 钉住） |
| `CORE_GET_TRAY_AVAILABLE` | `"core_get_tray_available"` | `src/shared/commands.ts` | R11：托盘可用性的唯一来源（Rust 侧镜像由 `test/tray.test.mjs` 与 lib.rs 的注册扫描钉住） |
| `CORE_READ_RUN_LOG` | `"core_read_run_log"` | `src/shared/commands.ts` | R56：设置页「日志」标签的数据源（宿主侧日志文件的最后 500 条；`require_main_webview` 守卫、返回前脱敏）；Rust 侧注册由 `lib.rs` 的注册扫描钉住 |
| `STDERR_PREFIX` / `STDERR_LOG_TARGET` | `"[hwmusic-core]"` / `"hwmusic_core"` | `src-tauri/src/sidecar.rs`（与 `src/sidecar/main.mjs` 的 `LOG_PREFIX` 逐字一致） | R56：sidecar stderr 每一行的前缀，以及它在日志文件里的 target |
| `TRAY_AVAILABLE` | `false` | `src/renderer/features/settings/settings-form.mjs` | R11：**兜底值**——宿主没答上来时用（真值来自 `core_get_tray_available`）。方向保守：界面说"不可用"而实际能用，比反过来代价小 |
| `TRAY_ID` | `"tray"` | `src-tauri/src/lib.rs` | R11：托盘**图标** id（菜单项 id 前缀是 `tray:`，见 `tray::MENU_ID_PREFIX`）；`core_get_tray_available` 与关窗回调都按它现问托盘表 |
| `MENU_SLOTS`（9 槽位/7 项/2 分隔线） | 见 `src-tauri/src/tray.rs` | `src-tauri/src/tray.rs` | R11：托盘菜单的唯一真源（顺序与文案由 Rust 内联单测 + `test/tray.test.mjs` 双向钉住） |
| `PLAYBACK_LYRICS` | `"playback:lyrics"` | `src/shared/request-channels.ts` | R12：歌词文本来源（Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `LYRICS_DOCUMENT` / `LYRICS_PROGRESS` / `LYRICS_STATE` | `"lyrics:document"` / `"lyrics:progress"` / `"lyrics:state"` | `src/shared/channels.ts` | 文档/进度只由主窗转发，配置由 Rust 广播并携 revision |
| `LYRICS_POINTER` | `"lyrics:pointer"` | `src/shared/channels.ts` | R69：锁定桌面歌词时宿主广播光标进出窗 `{inside}`，歌词窗据此显隐解锁键 |
| `CORE_LYRICS_TOGGLE` / `_CONFIGURE` / `_CONTROL` / `_DOCUMENT` / `_PROGRESS` | `core_lyrics_*` 五条具名命令 | `src/shared/commands.ts` | 名字、Rust 注册、来源守卫与最小 capability 一次补齐 |
| `CORE_LYRICS_UNLOCK_ZONE` | `"core_lyrics_unlock_zone"` | `src/shared/commands.ts` | R69：第六条歌词专命令，歌词窗上报解锁键矩形（只接受歌词窗调用） |
| `LYRICS_WINDOW_LABEL` | `"lyrics"` | `src-tauri/src/lib.rs` | 歌词窗 label、来源守卫、window-state 与几何接管 |
| `TASKBAR_SIZE` / `DESKTOP_SIZE` / `DESKTOP_VERTICAL_SIZE` / `DESKTOP_LIFT` | `1200×44` / `800×128` / `112×600` / `120` DIP | `src-tauri/src/lyrics_window.rs` | R51 收紧桌面默认尺寸、R70 竖版由 260×520 改为 240×600、R76 收窄到 112×600（lg 档正好两列）；按 scale 与工作区夹限（最小尺寸见下一行） |
| `MIN_WINDOW_WIDTH_DIP` / `MIN_VERTICAL_WINDOW_WIDTH_DIP` / `MIN_WINDOW_HEIGHT_DIP` | `240` / `96` / `120` DIP | `src-tauri/src/lyrics_window.rs` 的 `min_window_size` | R76：最小尺寸按布局取，桌面竖版 96×120（xxl 档也放得下一列），横版与任务栏 240×120；建窗、尺寸补丁夹紧与运行中切换布局同一口径 |
| `LYRICS_SETTINGS_WINDOW_LABEL` / `CORE_LYRICS_SETTINGS_OPEN` / `_RESIZE` / `_CLOSE` | `"lyrics-settings"` / `core_lyrics_settings_*` 三条命令 | `src-tauri/src/lib.rs` ↔ `src/shared/commands.ts` | R51：设置弹出窗（独立小窗；尺寸/位置/关闭全由 Rust 定，窗口没有任何 window 权限）。R60 起回执多一个 `geometry: { side: "bottom"\|"top", arrow, pad }`（CSS 像素）：`_RESIZE` 与已量过尺寸的 `_OPEN` 都带，页面按它摆箭头 |
| `LYRICS_FONT_STEPS` / `TASKBAR_MAX_FONT_PX` | `sm16/md20/lg28/xl40/xxl56` / `20` | `src/renderer/features/lyrics/lyrics-window.mjs` ↔ `src-tauri/src/lyrics_window.rs` | R12：字号档位与任务栏模式上限（两侧一张表，由 `test/lyrics-window.test.mjs` 逐条钉住；CSS 的 rem 规则在 `amll-theme.css`） |
| `LYRICS_COLOR_TOKENS` | `foreground`/`muted`/`primary`/`contrast` | 同上（TS 为真源、Rust 为镜像） | R12：歌词颜色的令牌档位（只认设计令牌，绝不接受任意色值） |
| `MIN_PROGRESS_INTERVAL_MS` | `100` | `src/renderer/features/lyrics/lyrics-window.mjs` | R12：进度节流窗口（R68 起进度泵收到播放器通知才调 `pushProgress`，只有该推的才出 IPC） |
| `SHORTCUT_BINDINGS` | 5 动作 / 主组合 + 备选链 | `src-tauri/src/shortcuts.rs` | R13：全局快捷键的唯一真源（媒体三键无备选；两条提示型组合各有 2 条备选）。每个组合都必须能被 `global-hotkey` 解析、且不许两个动作抢同一个组合（内联单测钉住） |
| `ShortcutState` | 生效组合快照 | `src-tauri/src/shortcuts.rs` | R13：`setup` 里登记成托管状态（设置页后续可读；本任务只记 + 提示，不做 UI） |
| `HUAWEI_QR_ENDPOINTS` | 见 §1.8（建单/轮询/CAS 换码三条 + **R31 的两条**：`deviceFingerPath`、`portalLoginPath`） | `src/main/qr-login.mjs` | R16 立、**R31 增补两条**：二维码登录的端点表（探针确认值；协议层 `src/protocols/qr-login.mjs` 仍只收注入，不写死 URL）。R31 增补的两条来自新探针：`/CAS/IDM_W/ajaxHandler/dev`（指纹换 `sid` = deviceID 的来源）与 `/CAS/portal/loginAuth.html`（画着二维码的那张页，也是建单/轮询的 Referer） |
| `QR_HTTP_USER_AGENT` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` | `src/main/qr-login.mjs` | R31：二维码这条链上**所有 HTTP 请求**的 UA（协议保真 = 像页面一样说话）。探针实测页面的 UA 与它**逐字节相同**（`probe-qr-fidelity` 每次都当场比）。**与"应用用什么 UA 打开官方登录页"无关**——后者按用户指令保持宿主默认 |
| `QR_PAGE_ACCEPT` | `"application/json, text/plain, */*"` | `src/protocols/qr-login.mjs` | R31：建单/轮询的 `accept`（页面 axios 发的就是这一串；原来只写 `application/json`） |
| `DEVICE_FINGERPRINT_FIELDS` / `DEVICE_FINGERPRINT_DEFAULT_SCREEN` | 19 个字段 / `{width:1920, height:1080}` | `src/protocols/device-fingerprint.mjs` | R31：设备指纹的字段表（探针实测页面那份的 19 个：`bsh,bsw,canvas,devs,ep,ett,etz,fonts,ips,nacn,nan,nce,nlg,npf,sah,saw,sh,sw,webgl`）与拿不到真窗口尺寸时的合约默认值。**服务端按形状收**（实测），所以 `canvas`/`webgl`/`fonts` 是同形状固定值 |
| `AUTH_QR_START` / `AUTH_QR` | `"auth:qr-start"` / `"auth:qr"` | `src/shared/request-channels.ts` / `src/shared/channels.ts` | R16：二维码会话的请求频道与状态广播（Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `AUTH_GET_STATUS` | `"auth:get-status"` | `src/shared/request-channels.ts` | R19：登录状态**重查**频道（渲染层挂载时主动问一次；应答与 `auth:status` 同形状，Rust 镜像由 `test/channel-parity.test.mjs` 钉住） |
| `AUTH_CANCEL_QR` | `"auth:cancel-qr"` | `src/shared/request-channels.ts` | R53：停掉进行中的二维码会话（渲染层门禁收场时发一次：切主界面 / 卸载）。与 `auth:cancel-login` 分工——那一条关**宿主登录窗**，这一条停**二维码轮询** |
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
| ~~`LOGIN_THEME_PARAM`~~ | ~~`"themeName"`~~ | — | **R28 按用户指令移除**（R26 立、R27 改档）：官方页不再跟随应用主题，挂在授权页 URL 上的主题参数一并删掉。**实测结论仍成立**（服务端按 UA 裁决主题 CSS），见 §1.7 的 R26 段 |
| ~~`LOGIN_THEME_NAME_DARK`~~ | ~~`"dark"`~~ | — | **R28 按用户指令移除**：深色档取值（R26 立、R27 起真的出深色——那要靠移动 UA，而移动 UA 也被撤销了）。见 §1.7 的 R26/R27/R28 三段 |
| ~~`LOGIN_THEME_NAME_LIGHT`~~ | ~~`"huawei"`~~ | — | **R28 按用户指令移除**（R27 新增）：浅色档取值（移动档服务端的回落值）。随主题机制一起删 |
| ~~`LOGIN_MOBILE_UA`~~ | ~~`Mozilla/5.0 (Phone; HarmonyOS 4.0) … Mobile Safari/537.36`~~ | — | **R28 按用户指令移除**（R27 新增）：登录 webview 的 UA。现在建窗**不设 UA**，WebView2 用自己的默认桌面 UA。代价与现状见 §1.7 的 R28 段 |
| `OFFSCREEN_MARGIN` | `8.0` | `src-tauri/src/login.rs` | **R27 新增**：屏外摆放的横向余量（物理像素）。登录页先摆在 `x = -(宽 + 8)`（客户区左沿之外，子窗被父窗客户区裁剪）等它加载 |
| `LOGIN_QUIET_WINDOW_MS` | `1_500` | `src-tauri/src/login.rs` | **R28 新增**：摆进内容区之前的**静默窗**（毫秒）。每次加载 `Finished` 起窗、窗内出现新导航就撤窗，窗内没有新导航才摆进（R27 那一版是"首载 `Finished` 就摆"，而首载多半只是 authorize 中间页）。30 秒首载期限那条兜底不变。时序矩阵见 §1.7 的 R28 段 |
| `LOGIN_OPENING_TEXT` / `LOGIN_OPENING_TESTID` | `"正在打开华为官方登录页…"` / `"login-opening"` | `src/renderer/features/auth/login-gate-logic.mjs` | **R27 新增**：官方页还在**屏外加载**那一刻，门禁状态行那一句（旁边带一个 `Loader2Icon animate-spin`）。R20 那句「已在网页中打开登录。」保留给**另一档**：渲染层 reload 之后只剩 `busy:true`（`path` 丢了），那一刻页多半早画好了——说"正在打开"是编造（判定见 `loginOpeningIndicator`） |
| `SESSION_DIAG_LABEL` | `"登录态持久化诊断"` | `src/main/session-diagnostic.mjs` | **R27 新增**：启动诊断那一行的开头（grep 用）。内容是"数据根 + 它是哪来的 + 那个根里有没有 `session.enc` + 恢复档位"——`数据根漂移`（调试根 vs `%APPDATA%` 根）一眼可判。Rust 侧另有一行 `数据根：<路径>（来源：…）`（`lib.rs::data_root_note`） |
| `MUSIC_EXPIRE_TIME_UTC_OFFSET_MINUTES` | `480` | `src/main/music-session.mjs` | R75：`expireTime` 按北京时间（UTC+8）解读，到期判定、到期文案与诊断行同一口径；推断，官方未确认（KNOWN_LIMITATIONS B33） |
| `QR_TTL_DIFF` / `QR_TTL_LEGACY`（内部两条路，不是导出常量） | `expiredTime − qrCodeCreateTime` / `expiredTime − now()` | `src/protocols/qr-login.mjs` 的 `resolveExpiresInMs` | R22：有效期换算。两条都是**服务端值**相减时免疫本地时钟偏差；`qrCodeCreateTime` 缺失/非法才回退老公式——**已知偏差风险**：本地钟快 1 小时，倒计时就早归零 1 小时（用户看到的是"卡在正在确认过期…"）。两值矛盾或 `expiredTime` 不可信 → `null`（不猜，界面少一行倒计时） |
| `MAX_URL_LOG_CHARS` | `160` | `src-tauri/src/login.rs` | R16：登录窗导航/加载日志里 URL 的截断上限（查询值一律不进日志） |
| `HUAWEI_MUSIC_LOGINEX_ENDPOINT` | `https://api-drcn.music.dbankcloud.cn/music-odpapp-service/v5/service/userinfo/loginex` | `src/main/music-session.mjs`（默认值经 `auth-manager.ts` 的 `HUAWEI_OAUTH_ENDPOINTS.loginex` 注入） | R17：音乐会话兑换端点（证据分级见 §1.5.1）。协议层 `auth.mjs`/`music.mjs` 仍只收注入；`test/auth-manager.test.mjs` 拿本文件反查这串字面量 |
| `MUSIC_SESSION_DIGEST_USERNAME` | `"app-music-baseline"` | `src/main/music-session.mjs` | R17：音乐业务请求 Digest 头的固定 `username`（不是凭据；只在请求头里出现，不进日志） |
| `MUSIC_BUSINESS_OK` | `"000000"` | `src/main/music-session.mjs` | R17：业务成功码（HTTP 2xx **且** `result.resultCode === "000000"` 才算成功） |
| `LOG_DIR_NAME` | `"logs"` | `src-tauri/src/lib.rs` | R17：日志目录在数据根下的一级子目录名；`HWMUSIC_DATA_DIR` 可用时日志写 `<数据根>/logs`（`log_plugin_targets` 的唯一构造点） |

## 4. 红线（任何后续任务不得越过）

1. 渲染层拿不到 Token；业务 HTTP 只在 sidecar/Rust 侧。
2. **端点一律注入，代码里只写"已确认"的值**：`src/protocols/*.mjs` 不含域名（路径形状可以写，
   绝对 URL 必须由 `src/main/*` 注入）；默认值必须是**有实测出处**的那一组，并在本文件登记。
   未确认的端点不写猜测值（宁可回结构化 `endpoint_unknown`）。
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
- 2026-10-20（Task R27）：**用户三项**——① 官方登录页真深色（**控制器裁决推翻 R26 的"不伪装 UA"**）；
  ② 点「在网页中打开登录」之后的加载动画；③ 登录态持久化诊断。三项都先写失败测试再修：
  1. **① 移动 UA**：先 probe 全链 + 45 组服务端裁决 + 10 档真浏览器计算样式（结论见 §1.7 的 R27 段）。
     实测：链路逐跳与桌面 UA 相同（白名单不用改）、移动档服务端认 `dark` 并真的加载 `index-dark.css`
     （body/root `rgb(0,0,0)`）、`harmonydark` **不出黑**（三段背景全透明）、不带参数时会跟着**系统**
     深色走（所以浅色档也必须显式挂 `huawei`）。落点：`LOGIN_MOBILE_UA` +
     `login_theme_name` 从 `Option` 改成"三态总有值" + **切主题 = 关掉重开**（`rebuild_login_view`，
     UA 是建窗属性、运行期没有 setter）——重建复用既有收尾/建页链，重建窗口由
     `LoginSession::begin_rebuild/end_rebuild` 挡住"页没了 → `Closed`"的兜底，失败则按 `Closed` 收场；
  2. **② 屏外加载**：登录页建在客户区左沿之外（`offscreen_rect`），首载 `Finished` 或 30 秒期限到
     才 `set_position` 摆进内容区；屏外期间**不跟随**主窗几何（否则等于把还在加载的白页摆回用户眼前），
     浮动控件照常跟随；门禁层显示 `Loader2Icon animate-spin` +「正在打开华为官方登录页…」
     （`loginOpeningIndicator`，与状态行文案同一个判定）。
     **R28 改判据**：`Finished` 只**起静默窗**（1.5 秒内没有新导航才摆进），理由与矩阵见 §1.7 的 R28 段；
  3. **③ 诊断**：新增 `src/main/session-diagnostic.mjs` + sidecar 启动那一行
     （数据根 + 来源 + `session.enc` 存在性 + 恢复档位）；Rust 侧 `lib.rs::data_root_note` 另落一行
     「数据根 + 来源」。真机实测：调试根（`HWMUSIC_DATA_DIR=.tmp/live-data`）与用户根
     （`%APPDATA%\org.hwmusicdesktop.unofficial.internal`）**都没有 `session.enc`**——
     当前"每次都要重登"的可观测原因是**一次真实登录都没落过盘**，数据根漂移是**尚未咬人**的陷阱
     （见 task-27 报告 §3）；
  4. **测试基线**：HEAD（R26 之后）实测 **235 pass + 1 ignored**（lib 212 + login_policy 19 + 另一目标 4），
     本轮 = **241 pass + 1 ignored**（lib 217、login_policy 20；新增 login.rs 4 条 / lib.rs 1 条 /
     login_policy 1 条，另 1 条改写）。
  测试：cargo **241 pass + 1 ignored**、node 695 → **708 / 0 fail**（新增 `test/session-diagnostic.test.mjs`
  9 条 + 登录门禁 R27 4 条、2 处断言按新文案改写）、tsc 0 错、acceptance 6/0/0。
  真机复验项见 `KNOWN_LIMITATIONS.md` B18（R27 段）。
- 2026-10-20（Task R28）：**用户三项（用户指令推翻 R26/R27 两项裁决）**——① 官方登录页不再支持
  切换主题；② 改回之前的 UA（删移动 UA）；③ 修"加载动画没等到页面真正加载完就结束"。三项都**先写
  失败测试再改**（先红后绿，两段红的原文见 task-28 报告 §3）：
  1. **① 撤销主题机制**：**整体删除**——`LOGIN_THEME_PARAM` / `LOGIN_THEME_NAME_DARK` /
     `LOGIN_THEME_NAME_LIGHT` 三个常量、`login_theme_name` / `with_theme_name` /
     `theme_reload_target` / `effective_login_theme` / `system_is_dark` / `reapply_login_theme` /
     `rebuild_login_view` / `reopen_login_view`、`LoginBuildSpec` 与 `LoginState::{spec,set_theme}`、
     `LoginSession::{begin_rebuild,end_rebuild,is_rebuilding}`、`vanish_conclusion` 里"页不在是不是
     预期"那一档，全部删干净（建页/收尾链的运行时泛型也随之收回，它当初只为那条链而加）；
     `open_login` 打开的就是 `host:open-login` 收到的那条 URL（不再装饰）；`theme::set_theme` 只落盘 +
     广播 `theme:changed`，**不再碰登录页**。浮动主题控件（`login-theme`，R25）**留着**：它改的是
     应用主题，与官方页无关；
  2. **② UA 回到宿主默认**：建窗链里删掉设 UA 那一句，WebView2 用自己的默认桌面 UA
     （`LOGIN_MOBILE_UA` 常量一并删）。代价如实登记：深色档下官方页回到服务端默认的**浅色**渲染
     （见 §1.7 的 R28 段与 `KNOWN_LIMITATIONS.md` B18-R28）；
  3. **③ 静默窗**：`LOGIN_QUIET_WINDOW_MS = 1_500` + `quiet_window_passed` + 会话的
     `note_page_finished` / `note_navigation_started`（`PageLoadEvent::Finished` 起窗、`Started`
     与**放行的导航**撤窗）+ `LoginSession::new_at` 与 `_at` 变体（**注入时钟**：这套时序矩阵不靠
     sleep 钉）；`placement_due(page_quiet, elapsed)` 的第一档从"首载完成"改成"静默窗走完"，
     **30 秒首载期限那条兜底不变**；
  4. **测试基线**：HEAD（R27 之后）实测 **242 pass + 1 ignored**（lib 218 + login_policy 20 +
     另一目标 4，与 R27 报告逐字一致）。本轮 **239 pass + 1 ignored**（lib 216 + login_policy 19 + 4）：
     删掉 8 条随机制作废的旧用例（主题三态映射 / 移动 UA / `with_theme_name` / `theme_reload_target` /
     会话重建走位 / 重建链 / 建窗参数 / 打开时挂参数）与 login_policy 1 条，新增 6 条 R28 用例
     （两条"删干净"的源码钉子 + 静默窗矩阵 + 静默窗接线 + 屏外几何 + 会话走位与 `Closed` 兜底）。
  测试：cargo **239 pass + 0 fail + 1 ignored**、node **708 pass / 0 fail**（渲染层只改注释与文案来源
  说明，无行为改动）、tsc 0 错、vite 三入口构建通过、acceptance 6/0/0。
  真机复验项见 `KNOWN_LIMITATIONS.md` B18-R28。
- 2026-10-21（Task R32）：**按参考项目全面对齐协议层**（用户指令：参考
  `talongao/huawei-music-desktop` 修复所有问题，确保歌曲正常播放、歌单列表正确显示）。七项换血：
  1. **§1.1/§1.2/§1.3 端点与参数**：authorize 换成 `oauth-login.platform.hicloud.com`、
     token 换成 `oauth-login.cloud.huawei.com`（**两个不同主机**——R4 把它们都登记在
     `oauth-login1` 上，那只证明了"域可达、路径存在"）；`scope` 换成用户指令的完整 12 项清单；
     授权 URL 补 `countryCode=cn` / `ui_locales=zh-cn`；兑换表单字段顺序也对齐参考；
  2. **§1.4 白名单**：条目 = 参考 `LOGIN_HOSTS` 五域；`oauth-login1` 从整域放行**降级**为
     `loginCallback` 精确例外（保留）；`login.cloud.huawei.com` 移出。Rust 镜像与两侧 parity 同步；
  3. **§2.1/§2.2 业务端点**：默认端点表 = 业务域 + 参考实测路径（11 个键，`lyrics` 无独立端点）；
     POST 用 JSON 体 / GET 用查询串；分页 `start`/`limit`（通道的页号在协议层换算）；
     沿用注入式架构（`protocols/music.mjs` 仍**一个域名都不含**，由源码扫描钉死）；
     设置 `data.musicEndpoints` 支持覆盖与**显式关闭**（`null`）；
  4. **§2.3 响应与归一化**：成功判据 = `result.resultCode === "000000"`；线上字段
     （`contentID`/`contentName`/`picture.*`…）归一化成内部形状（`id`/`name`/`coverUrl`…），
     **渲染层零改动**；"我的歌单"必须翻页扫完再挑（歌曲与歌单混在一个列表里，`fresh === 0` 才停）；
  5. **§2.3.1 播放链**：`contentCode/contentType/qualityType` 进 JSON 体（音质只认 standard/lossless，
     对不上就 `quality_unsupported`）；顶层 `fileURL` 是音频；音质**不虚标**（`actualQuality`
     要与声明的编码对得上）；
  6. **§2.3.2 歌词**：参考没有独立歌词端点 → 从播放响应推导（`lyricAddress` 走 CDN 白名单下载，
     或内嵌 `contentExInfo.lyrics`，最多剥两层 JSON）；设置里显式注入 `lyrics` 时才走独立端点；
  7. **会话接通**：`createMusicService({session})` 取活会话（`{musicSession,userId}` →
     `{token,snsUserID}`），`Authorization: Digest`（无 token 调用也带，形状同参考）；
     没有会话时回 `session_required`（不拿匿名请求冒充"你的库是空的"）。
  新增 `test/reference-parity.test.mjs`：拿 `.tmp/reference-repo/src/*.mjs` 做**逐字差分**
  （不确定项按"缺席即跳过"处理，不假装验过）。**未实测**：用本项目账号走完这些请求（要用户在场授权），
  见 §2.1 第 3 条。
  测试：cargo **239 pass + 0 fail + 1 ignored**（白名单 3 条断言改写）、node **723 pass / 0 fail**
  （`test/music.test.mjs` 按新线上形状重写、新增差分用例）、tsc 0 错、acceptance 6/0/0。

- 2026-10-21（Task R31）：**自建二维码全保真修复**（用户指令：界面不变、不用移动端 UA、继续修自己生成的
  二维码）。方法换了：R29 是读代码推断，本轮**用 headless Chromium 真开官方二维码页**，把页面自己发的
  建单/轮询/指纹请求抓下来（`scripts/probe-qr-fidelity.mjs` → `.probe/r31-fidelity.json`）。八条见 §1.8 的
  R31 段，最要紧的三条：① **二维码是桌面门户页画的**（手机 UA 下那张页画布 0 个、建单 0 条——所以"不用
  移动端 UA"与协议保真是同一件事）；② **`deviceID` = 服务端下发的 `sid`**（拿一份设备指纹打
  `/CAS/IDM_W/ajaxHandler/dev` 换回来，编码格式逐字节复刻，见 `src/protocols/device-fingerprint.mjs`）；
  ③ **cookie 罐**——页面的轮询带着建单响应自己种下的 `qRCode`/`expiredTime`，我们此前全丢。
  落地：建单 URL 去查询串（`qrCreateRequestUrl`）、建单表单补 `deviceID`/`deviceType=7`、
  建单/轮询走同一个 cookie 罐并带页面 UA/Referer/`accept`。**失败一律降级**（拿不到上下文照旧建单，
  界面不受影响）；渲染层与 Rust 一行未动。**仍未验证**："补上这些到底有没有用"要真手机 + 真账号
  → `docs/KNOWN_LIMITATIONS.md` **B21**。
  测试：node **753 pass / 0 fail**（+17：指纹模块 10、协议层 3、端口层 4）、tsc 0 错、
  acceptance 6/0/0、cargo **239 pass + 0 fail + 1 ignored**（源码一行未动，跑一遍确认没回归）。

- 2026-10-21（Task R38）：**登录后主界面五项修复**（首次以真实会话联调主界面；CDP 只读取证）。
  1. **左上角品牌重复**：`App.tsx` 的 `SidebarHeader` 那句品牌删掉（与窗口标题栏重复），
     `SidebarHeader` 随之整块消失（不留空壳节点）；`APP_BRAND_LABEL` 仍有调用方（`main.tsx`
     的 `document.title`），导出保留；
  2. **封面点亮（§2.5）**：真机实测歌单/曲目 `coverUrl` **全部落在白名单域内**
     （`contentcenter-drcn.dbankcdn.cn` / `image.tingmall.com` / `music-pics-drcn.dbankcdn.cn`），
     所以只需渲染层接线：歌单卡、曲目行、播放栏、队列行统一 `<img src>` + `loading="lazy"` +
     失败落回 lucide 占位（`components.tsx` 的 `CoverArt` 一处实现）。**绝不 `fetch`**
     （图片走 `img-src`，`connect-src` 只有 self/ipc）；白名单与 CSP 一行未改。
     `AmllBackground` 的专辑图**仍不接**（AMLL 要 `HTMLImageElement`，接它得命令式建 `Image()`
     并处理加载竞态，属另一件事）；
  3. **歌词（§2.3.2 重写）**：真机取证发现 **`lyricAddress` 长在曲目条目上**
     （`songSimpleInfos[]`，实测 3/3 条都有，无查询串、GET 200、是真的 LRC），而
     **播放响应里没有**任何歌词字段——旧实现只问播放响应，所以真机上永远"没有可用的歌词"。
     `getLyrics` 改成三档：显式注入的端点 → **已加载条目的地址**（`normalizeTrack` 顺手记进
     进程内索引：`trackId → 地址`，上限 400 条 FIFO，**不落盘、不跨进程**，取用时再验一次白名单）
     → 播放响应（`lyricAddress`，含内嵌 `songInfo` 的同一份候选表 / 内嵌歌词）。
     边界如实登记：索引只有"用户见过的条目"，重启后直接播恢复队列仍可能没歌词（见
     `docs/KNOWN_LIMITATIONS.md` B23）；
  4. **账号资料（§1.7 的 `auth:status` 载荷）**：`loginex` 响应形状无实证，所以只做
     **防御式候选键** + **只记键名**的 INFO 日志（loginex 与 token 响应各一条，值一律不进日志）：
     名字 `userName`/`nickName`/`nickname`，头像 `headUrl`/`headImage`/`avatarUrl`/`avatar`/`head`
     且**必须过 CDN 白名单**，VIP 只认明确布尔或**有证据的** `memberShip` 含 `6`
     （"含 6 = 会员类别"来自参考仓库的功能验证记录；`vipLevel`/`vipType` 没有枚举证据 →
     不猜、不显示）。profile 随会话进 DPAPI 信封，并经**既有** `auth:status` 暴露
     （**不新开频道**：Rust 的频道常量表是硬钉 parity）。旧会话没有 profile → 左下角如实兜底
     （头像占位 + "已登录"），重新扫码登录一次才点亮；
  5. **退出登录搬到左下角**：设置页整块「登录状态与退出」删除（`loginStatusText` 随之删除，
     不留死代码），退出改在 `SidebarFooter` 的账号区：`AlertDialog` 二次确认（「退出后需要
     重新扫码登录。」），确认后走**唯一实现** `host-api` 的 `coreLogout`（`auth:logout` 的
     唯一出口，载荷仍是 `null`）；失败在账号区显示一句人话，成功不做跳转（`auth:status` 广播接管）。
  测试：node **799 pass / 0 fail**（+10：R38 歌词三档 4 条、`music-session` profile 6 条、
  账号区 4 条，另有两条旧断言按新契约重写）、tsc 0 错、`build:web` ✓、acceptance 6/0/0。
  **渲染层改动已经 HMR 在运行实例上取证**（`.tmp/r38-verify-ui.json`）；协议层/主进程改动
  **需重启 sidecar 生效**。

- 2026-10-21（Task R40）：
  1. **§1.7 的 `auth:status.profile` 扩到三个来源**：loginex 顶层（真机已证扑空）→ loginex 的
     `queryAllSubInfoResp` / `queryAppConfigDetailResp` 两个容器**读一层** → **`id_token` 的
     claims**（`header.payload.signature` 只解码 payload 段：三段式 base64url 才认、坏形状回 `null`、
     **不验签**、**不抛**；取 `name`/`nickname` 与 `picture`/`avatar` 且头像过 CDN 白名单；
     **VIP 不从 claims 取**）。loginex 那份优先、claims 只补空缺；只有提取出的三个键随会话记录
     进 DPAPI 信封（**claims 原文与 id_token 都不落盘**）。日志新增三条**只记键名**的行
     （`id_token` claims 键名 / loginex 容器一层键名 ×N），值一律不进日志。
  2. **§2.3.2 歌词增第四档**：索引没命中且**播放响应自己给了 `albumID`**（与 `normalizeTrack`
     同一份候选表，含内嵌 `songInfo`）→ 经**既有**专辑端点补一次条目索引（那条响应的条目自带
     `lyricAddress`）→ 取到就下载；没给专辑 id 就没有这一档，仍如实回 `invalid_response`。
     该档带一行**只记键名**的诊断（播放响应顶层键名 + `songInfo` 键名）——"播放响应里有没有
     `albumID`"尚无实证，靠真机日志回答。`createMusicApi` 新增 `options.log` 注入位（协议层自己不写日志）。
  3. **频道的载荷与常量表一行未动**（R40 全部改动都在既有频道内：没有新开频道、没有改 CSP/白名单）。
  4. 渲染层（歌单详情页头部 + 播放全部/加入队列、搜索移到侧栏常驻框、曲目表 `table-fixed`、
     PlayerBar 控件居中、封面点击进歌词舞台）**已 HMR/页面重载在运行实例上取证**；
     测试 node **832 pass / 0 fail**（+22）、tsc 0 错、`build:web` ✓、acceptance 6/0/0。
     **AMLL 封面必须带 `crossOrigin="anonymous"`**（不带会把画布 taint，AMLL 采样时
     `getImageData` 抛 `SecurityError`；实测 CDN 会回 ACAO）。
- 2026-10-26（Task R53）：**已登录冷启动不再闪登录页、二维码不再空转到过期**。
  1. **`auth:get-status` 增可选 `restoring: true`**（恢复期间的广播同样带它，恢复结论广播不带）：sidecar 先建 RPC
     再 `await restore()`（要发网络验证），渲染层那一问落在恢复期间；旧应答 `{loggedIn:false}` 被门禁
     当成结论 → 画登录页 + 自动建码。恢复期间现在答"恢复中"，渲染层当 `checking`（中性启动屏、不发码）。
  2. **新增请求频道 `auth:cancel-qr`**（§2.11 与 §3 登记）：渲染层门禁收场（切主界面 / 卸载）时
     停一次；Rust `REQUEST_CHANNELS` 镜像同步加了一条（`test/channel-parity.test.mjs` 钉住）。
  3. **sidecar 侧收口**：`auth-manager.announce()` 一旦播"已登录"就停掉在跑的二维码会话
     （停轮询 + 作废待兑换的尝试）——restore / 扫码 / 网页三条来源由此共用一处。
  4. 登录协议本身**一行未动**（端点、建单/轮询/换码、DPAPI 信封全部照旧）。
- 2026-10-26（Task R55）：**歌单/历史的说明文案删掉 + 歌单详情整表交给动作**。
  1. **删三句说明文案**（用户要求）：`playlistPartialNoticeText`（"这一页只加载了前 N 首…"）、
     `playlistLocalSliceNoticeText`（"服务端一次返回整张歌单…"）、`localRevealNoticeText`
     （"后端一次返回 N 首（1 次网络请求…）…已显示 N 首"）连同常量 `PLAYLIST_SLICE_NOTICE_TESTID`、
     页面渲染与测试锚点一起删除；保留"已加载 N 首 / 继续向下滚动"与 `server-repeat` 的停止原因。
     歌手页与历史页不再挂状态行。
  2. **整张歌单随第一页交出**：`library:playlist-detail` 第一页在整表已在内存时额外带 `fullSongs`
     （后续页不带），渲染层让「播放全部」「加入队列」作用于整张歌单；`pageSource:"server"` 时没有整表，
     动作退回已加载的那批。
  3. **只读核查（§2.3.3）**：歌单详情端点不认 `start`/`limit`，也不认 `pageNum`/`pageSize`/`offset`
     （`limit=1623` 反而 HTTP 400）⇒ 服务端不能分页，维持"一次取回 + 本地切片"；参考实现也只有 `start`/`limit`。
  4. **收藏首页为空已查清**：同一会话历史 200 条、同一端点扫描 `contentTypes:["1","4","5","7"]` 只回 2 条
     且都是歌单 ⇒ 不是会话/参数问题，该账号确实没有收藏歌曲（界面上是如实空态）。
- 2026-10-26（Task R57）：**账号资料/会员到期的端点调研结论 = 不可行；账号区改成"有资料就能显示"的形态**。
  1. **新增 §1.5.2（不可行结论 + 三条证据）**：12 个候选 H5/Web 主机全部 ENOTFOUND；
     参考实现只有 `loginex` 一个 userinfo 路径；用已登录会话做的 15 条候选路径只读探测**全部 404**
     （17 次请求、2 次对照 200 + `000000`）。**不猜端点、不猜字段**，恢复期刷新流程不实现。
  2. **`auth:status.profile` 增可选 `vipExpiresOn`**（§2.6）：本项目自己的字段，只认「能显示成某一天」的
     形状（`YYYY-MM-DD` / `YYYYMMDD` / 14 位 `YYYYMMDDHHMMSS`），校验只有一处
     （`src/shared/vip-expiry.mjs`）。**当前没有生产者**——它是给"哪天有证据"准备的落点，
     界面与守卫用注入载荷覆盖这一档。
  3. **账号区（左下角）**：头像（`AvatarImage`，加载失败/无地址回退首字，连名字都没有才回退图标）、
     名称（`truncate` + `Tooltip` 显示全名）、会员徽标（shadcn `Badge`，`会员` / `会员 · 至 …`）；
     主题切换与退出登录入口保留；**侧栏收起成图标轨时只留头像**（R41b 的"竖排三个图标"作废）。
     头像地址仍只走已有媒体白名单，**CSP `img-src` 一行未改**。
