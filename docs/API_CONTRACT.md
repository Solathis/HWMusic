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

### 1.7 登录子窗 ↔ sidecar 的线上契约（R7 落地）

**宿主要求（core → 宿主，payload 形状由两侧测试互钉）**

| 频道 | 入 | 出 |
|---|---|---|
| `host:open-login` | `{url, partition, topInset}` | `{status, url?, message?}`，**在登录窗收场之后**才答复（长轮询） |
| `host:cancel-login` | `{}` | `{cancelled: boolean}`（`cancelled:false` = 本来就没有进行中的登录，不是错误） |

`status` 词表（Rust `LoginConclusion::status` ↔ Node `HOST_LOGIN_STATUS`，`test/login-parity.test.mjs` 互钉）：

| status | 含义 | 附带的字段 |
|---|---|---|
| `callback` | 拦到 `hms://` 导航，URL **原样**交回（判真伪是 `consumeCallback` 的事） | `url` |
| `cancelled` | 用户/渲染层取消（`host:cancel-login`） | — |
| `closed` | 登录窗被关闭 | — |
| `timed_out` | 总期限（10 分钟）到 | `message` |
| `load_failed` | 首载期限（30 秒）内打不开官方页（网络/代理） | `message` |

- 两条期限**文案不同**（处置方式不同）：打不开官方页 vs 扫码超时。文案两侧逐字一致，parity 互钉。
- **双来源**（旧仓缺陷 C1）：Rust 侧"导航拦截"与"窗口关闭"两条路都能把结论交给等待方；
  结论槽是 take-once 的（先到者胜、后到者不改写）。只接一条 = "扫码成功却等超时"。
- **登录窗零命令权限**：`capabilities/main.json` 的 `windows` 只有 `main`/`lyrics`，且不给登录页注入任何
  脚本（不订阅 `initialization_script`/`eval`）：白名单与回调**只靠导航事件**观测。

**渲染层 ← sidecar 的登录状态广播（R7 增补的广播频道）**

```
auth:status → {loggedIn: boolean, busy: boolean, message?: string}
```

- 为什么结论走广播而不是 `core_call` 的返回值：渲染层那条调用链（Rust `core_call`）有 60 秒上限，
  而扫码要等好几分钟。`auth:login` **立刻回 `{started:true,...}`**，真正的结论经 `auth:status` 送达。
- 启动期恢复也会广播一条（`{loggedIn:false, busy:false}`）：渲染层还没订阅时由 Rust 的
  `NoticeQueue` 排队，`core_renderer_ready` 时冲刷——"已登录"这个事实不会发进空气。

**已知缺口（R7 如实登记，不硬绕）**：wry 0.57（tauri 2.12 的 webview 层）只注册 WebView2 的
`NavigationStarting`（主框架级），**没有** `FrameNavigationStarting`。官方页若从 **iframe** 内部发起
`hms://` 跳转，Rust 侧看不到（顶部框架跳转与 302 都能看到）。关闭它要么等上游提供帧级事件，
要么注入脚本监听——后者是硬边界明令禁止的（登录页零注入）。兜底：总期限仍会收口，不会永久挂住。

**未联调（untested）**：真实扫码登录（需要用户在场 + 真实账号）、音乐会话兑换（loginex，见 §1.5）、
`tauri dev` 真窗验证（本环境的子进程沙箱里应用起不来：`tauri-plugin-log` 初始化 `os error 5`）。

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
| `player:command` | core → 渲染层（广播） | `{command}`，取值 `play`/`pause`/`toggle`/`next`/`previous` | R9 **预登记**（真正的发送方是 R11 的托盘）；渲染层 `features/playback/player-commands.mjs` 执行，认不出的命令回结构化 `invalid_command`，**拒绝且不猜** |

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

1. **歌词来源**：本任务交付解析适配（`features/lyrics/amll-adapter.ts`：`[offset:]` 补偿 +
   翻译行合并）、进度同步（`features/lyrics/lyric-sync.mjs`）与 AMLL 面板宿主；
   但**没有歌词文本通道**（本任务只增补了 `playback:resolve-url` 与 `player:command` 两条，
   见上面）——所以面板今天如实显示"歌词来源尚未接入。"，不冒充"这首歌没有歌词"。
   歌词通道与 R12 的桌面歌词窗一起定（`task-9-brief.md` 的范围外清单：桌面歌词窗属 R12）。
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

两条命令都过**主窗来源守卫**（`require_main_window`）：登录子窗/歌词窗/托盘改不了系统自启。

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
托盘本体是 R11；在那之前 `TRAY_AVAILABLE = false`，选了托盘当场说明"会回退成退出"。

**如实登记的已知限制（本任务）**：

1. **托盘不存在**（R11）：桌面托盘、关窗时真正的最小化到托盘都还没有——选 `tray` 今天等同于退出；
2. **开机自启未经真机验证**：单测只覆盖判定逻辑（假 manager，**绝不写本机注册表**），
   真实注册表写入/读取未实测；Rust 侧的错误按结构化 `internal` 回，界面文案带原因；
3. **代理改动要重启才生效**：回执照实回报 `restartRequired`（sidecar 的全局 dispatcher 与
   主窗的 `proxy_url` 都只在启动时装配一次）——设置页据此提示"重启后生效；登录窗口下次打开即生效"；
4. **队列在设置页只读**（长度 + 当前曲），管理队列仍在播放队列面板。

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
| `LOGIN_VIEW_TOP_INSET` | `48`（CSS px） | `src/shared/login-inset.mjs` | R7：`huawei.ts` 与渲染层 `login-gate.tsx` 双侧 import；Rust `login.rs` 镜像并互钉 |
| `LOGIN_TIMEOUT_MS` | `10 * 60_000` | `src/protocols/login-callback.mjs` | Node 侧；Rust `LOGIN_TIMEOUT_SECS = 600` 由 R7 镜像并由 parity 测试互钉 |
| `LOGIN_LOAD_DEADLINE_SECS` | `30` | `src-tauri/src/login.rs` | 首载期限（Rust 独有：Node 侧没有对应的墙钟，只有"打不开官方页"这条结论） |
| 两条期限文案 | 见 §1.7 | `src-tauri/src/login.rs` ↔ `src/main/huawei.ts` | 两侧逐字一致，parity 互钉 |
| `LYRICS_SEEK_WINDOW_MS` | `200` | `src/renderer/features/lyrics/lyric-sync.mjs` | R9：歌词的 `isSeeking` 窗口（拖动时歌词跟着手走、手停 200ms 后自动收窗）；组件里不许再写这个数字（扫描钉住） |
| `QUEUE_SETTING_KEY` | `"queue"` | `src/renderer/features/playback/queue.mjs` | R9：播放队列的持久化键（`data.queue`，只存曲目标识 + 索引） |
| `PROXY_TEST_URL` | `https://oauth-login1.cloud.huawei.com/` | `src/host/proxy-handlers.mjs` | R10：`settings:test-proxy` 的唯一目标（不接受调用方指定；业务端点仍待联调） |
| `CORE_SET_AUTOSTART` / `CORE_GET_AUTOSTART` | `"core_set_autostart"` / `"core_get_autostart"` | `src/shared/commands.ts` | R10：命令名的唯一真源（渲染层只用常量；Rust 侧为镜像副本，由 `test/autostart.test.mjs` 钉住） |
| `TRAY_AVAILABLE` | `false` | `src/renderer/features/settings/settings-form.mjs` | R10：R11 之前托盘不存在——写死在渲染层是如实，不是偷懒（宿主侧今天没有"托盘在不在"的口子） |

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
