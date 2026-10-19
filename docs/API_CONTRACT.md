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
LOGIN_ALLOWED_ORIGINS = ["https://oauth-login1.cloud.huawei.com", "https://login.cloud.huawei.com"]
LOGIN_ALLOWED_URLS    = ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"]  // 精确例外
```

- 是**显式条目表**，不是 `*.huawei.com` 通配（`test/login-parity.test.mjs` 扫源码禁止通配写法）；
- **不放 `oauth-login2`**：换区域主机属显式决策，默认不放行（历史故障正是"漏了某个登录域"）；
- `loginCallback` 例外是"扫码成功后 `hms://` 才会触发"的关键（旧仓历史故障根因：漏掉它 → 停在 CAS 页）；
- 探针实测：`https://login.cloud.huawei.com/` → `403`（域存在，仅拒绝裸请求，属预期）；
- **注**：bundle 里同时存在 `/oauth2/v2/loginCallback`。本项目只放 v3（审计事实点名的那个）。
  R7 联调若观测到回调真的落到 v2，必须**带证据**显式加条目并同步 parity 测试，不得改成通配。
- Rust 侧镜像与互钉测试归 R7（`src-tauri/src/login.rs` + `test/login-parity.test.mjs` 已写好"存在即互钉"的钉子）。

### 1.5 未确认：令牌链的后续环节

| 环节 | 状态 | 说明 |
|---|---|---|
| 授权码 → 账号 AT/RT（token 端点，带 `code_verifier`） | 已确认（§1.3） | — |
| 账号 AT → **音乐会话**（旧仓称 `loginex`，请求带 Digest 头） | **待确认 / 待 R7 联调** | 端点 URL、请求形状、Digest 算法细节均无公开证据；探针无法离线确定（GET/POST 都需有效 AT）。`src/protocols/auth.mjs` 因此不实现它，只提供可注入端点的兑换/刷新 |
| 账号 AT 有效期 | 审计事实 ≈ 1 小时 | 未实测；`isTokenExpired` 默认提前 60 秒判过期 |
| 音乐会话有效期 | 审计事实 ≈ 7 天（到期字段提示） | 未实测完整周期；自动续期未打通，失效需重扫 |
| 刷新账号 AT | 已实现（注入端点） | 华为是否轮换 RT 未知；实现按"响应不发新 RT 就沿用旧 RT"处理 |

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

## 3. 本地常量（唯一真源位置）

| 常量 | 值 | 唯一真源文件 | 消费方 |
|---|---|---|---|
| `LOGIN_VIEW_TOP_INSET` | `48`（CSS px） | `src/shared/login-inset.mjs` | R7：`huawei.ts` 与渲染层双侧 import |
| `LOGIN_TIMEOUT_MS` | `10 * 60_000` | `src/protocols/login-callback.mjs` | Node 侧；Rust `LOGIN_TIMEOUT` 由 R7 镜像并由 parity 测试互钉 |

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
