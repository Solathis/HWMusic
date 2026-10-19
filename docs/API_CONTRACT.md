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
