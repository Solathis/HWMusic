/**
 * R10 设置页 · 代理表单的纯逻辑（清洗 / 保存载荷 / 复位 / 凭据卫生）。
 *
 * 这一层刻意做成纯模块（`src/renderer/features/settings/settings-form.mjs`），
 * 因为要钉的几条规矩全是"看起来对、其实在撒谎"的事：
 *
 * 1. **凭据不回显**：`settings:get` 的回执里**带**代理密码（R6 的磁盘形状如此），
 *    所以"读到之后不显示"必须由投影函数结构性地保证——表单对象里根本没有密码这一项，
 *    只有一个 `hasStoredPassword` 布尔。
 * 2. **密码留空 = 清除**：表单是只写的（不回显、也不留旧值），所以留空保存会清掉已存密码。
 *    这件事必须在界面上说清（`passwordHint`），而不是让用户保存后才发现代理连不上。
 * 3. **归一只有一份**：表单只做"拆逗号、去空白、丢空项"，大小写去重与端口清洗都归 core
 *    （`src/main/settings.mjs`）。这里拿 core 的 `normalizeProxy` 反向验证这条链真的接得上。
 * 4. **文案要能执行**：校验与失败文案必须说明原因或下一步（测试禁掉空文案与"敬请期待"）。
 * 5. **端口坏值不许静默丢**：`8080x` 之类的输入在保存前就被拦下（core 会把它当"没填"）。
 *
 * 接管补记（上一执行者中断后由收尾执行者改写）：原第 8 节钉的是"账号标识白名单投影"
 * （`src/shared/account.mjs` 的 `accountText`），与最终裁决冲突——**不显示账号标识**：
 * `auth:status` 的载荷只有 `{loggedIn, busy, message?}`，R10 不为显示去扩协议。
 * 改成钉"只收一个布尔"的 `loginStatusText`（结构性保证比白名单更强），并补了
 * 队列摘要文案与「外观跟随系统」两条。
 *
 * R38 补记（用户指令 2026-10-21）：设置页的「登录状态与退出」区块**整块删掉**——
 * 登录状态展示与左下角账号区重复，退出入口搬到左下角账号区（App 的 `SidebarFooter`，
 * 走 `AlertDialog` 二次确认）。所以：
 * - `loginStatusText` 随区块一起删（它已无消费者，留着就是死代码）；
 * - 第 8 节改成钉**新契约**：设置页里不再有登录状态与退出入口，退出只有一处实现
 *   （`host-api` 的 `coreLogout`，唯一 `auth:logout` 出口）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  APPEARANCE_NOTICE_TEXT,
  CLOSE_BEHAVIORS,
  CLOSE_BEHAVIOR_LABELS,
  closeBehaviorNotice,
  closeBehaviorPatch,
  passwordHint,
  proxyFormFromSettings,
  proxyPatchFromForm,
  proxySaveNotice,
  proxyTestResultText,
  queueSummary,
  queueSummaryText,
  settingsFailureText,
  validateProxyForm,
} from "../src/renderer/features/settings/settings-form.mjs";
import { normalizeProxy } from "../src/main/settings.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 测试用凭据：刻意是"看起来像 token"的串，用来抓任何漏进文案/日志的地方。 */
const PASSWORD = "s3cret-proxy-token";
const USERNAME = "proxy-user";

/** 一份"存过代理"的设置文档（settings:get 的回执形状）。 */
function documentWithProxy(overrides = {}) {
  return {
    schemaVersion: 1,
    data: {
      proxy: {
        enabled: true,
        host: "proxy.local",
        port: 8080,
        username: USERNAME,
        password: PASSWORD,
        bypass: ["localhost", "127.0.0.1"],
        ...overrides,
      },
      closeBehavior: "quit",
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 读 → 表单：凭据不回显（结构性保证，不是"小心一点"）
// ---------------------------------------------------------------------------

test("投影：读到的代理填进表单，但密码一个字都不带（只有一个 hasStoredPassword）", () => {
  const form = proxyFormFromSettings(documentWithProxy());

  assert.equal(form.enabled, true);
  assert.equal(form.host, "proxy.local");
  assert.equal(form.portText, "8080", "端口以文本进表单（用户的输入就是文本）");
  assert.equal(form.username, USERNAME);
  assert.equal(form.bypassText, "localhost, 127.0.0.1", "例外列表回填成逗号分隔文本");
  assert.equal(form.hasStoredPassword, true, "已存密码只以布尔形式告知");

  assert.equal(form.password, "", "密码字段永远从空开始（只写）");
  assert.ok(
    !JSON.stringify(form).includes(PASSWORD),
    `投影结果里漏进了密码：${JSON.stringify(form)}`,
  );
});

test("投影：没存过密码 / 坏文档都不抛（表单要能开，哪怕设置读坏了）", () => {
  const empty = proxyFormFromSettings(null);
  assert.deepEqual(empty, {
    enabled: false,
    host: "",
    portText: "",
    username: "",
    password: "",
    bypassText: "",
    hasStoredPassword: false,
  });

  for (const broken of [null, undefined, {}, { data: null }, { data: { proxy: "proxy.local" } }]) {
    const form = proxyFormFromSettings(broken);
    assert.equal(form.enabled, false, `坏文档当成没配：${JSON.stringify(broken)}`);
    assert.equal(form.host, "");
    assert.equal(form.portText, "", "端口 null（没填）不显示成 \"null\"");
  }

  assert.equal(
    proxyFormFromSettings(documentWithProxy({ password: "" })).hasStoredPassword,
    false,
    "空串 = 没存过密码",
  );
});

test("密码提示：存过密码要说清「留空会清除」，没存过就不吓唬人", () => {
  const stored = passwordHint({ hasStoredPassword: true });
  assert.match(stored, /留空.*清除|清除.*留空/, `提示要说清后果：${stored}`);
  assert.ok(!stored.includes(PASSWORD), "提示里不许回显任何凭据");

  const none = passwordHint({ hasStoredPassword: false });
  assert.equal(typeof none, "string");
  assert.ok(!/清除/.test(none), `没有已存密码时不该说"会清除"：${none}`);
});

// ---------------------------------------------------------------------------
// 2. 表单 → 保存载荷：只做拆分，归一归 core
// ---------------------------------------------------------------------------

test("载荷：表单 → settings:set 的 patch，形状与磁盘一致（六个字段一个不少）", () => {
  const form = {
    enabled: true,
    host: " proxy.local ",
    portText: " 8080 ",
    username: " user ",
    password: " pa ss ",
    bypassText: " localhost , 127.0.0.1 , , LOCALHOST ",
    hasStoredPassword: false,
  };
  const patch = proxyPatchFromForm(form);

  assert.deepEqual(Object.keys(patch), ["proxy"]);
  assert.deepEqual(Object.keys(patch.proxy), [
    "enabled",
    "host",
    "port",
    "username",
    "password",
    "bypass",
  ]);
  assert.equal(patch.proxy.enabled, true);
  assert.equal(patch.proxy.host, "proxy.local", "主机两端空白去掉（中间不动，core 再清洗字符集）");
  assert.equal(patch.proxy.port, "8080", "端口以文本发出：清洗规则只有 core 一份");
  assert.equal(patch.proxy.username, " user ", "用户名不做静默改写（与 core 同口径：空格可能是名字的一部分）");
  assert.equal(patch.proxy.password, " pa ss ", "密码原样送去（空格可能是密码的一部分）");
  assert.deepEqual(patch.proxy.bypass, ["localhost", "127.0.0.1", "LOCALHOST"], "只拆逗号、去空白、丢空项");
});

test("载荷：坏表单（空值/非字符串/非对象）不抛，形状照样成立", () => {
  for (const broken of [null, undefined, "proxy", 42, []]) {
    const patch = proxyPatchFromForm(broken);
    assert.equal(patch.proxy.enabled, false, `坏表单当成没开：${JSON.stringify(broken)}`);
    assert.equal(patch.proxy.host, "");
    assert.equal(patch.proxy.port, "");
    assert.equal(patch.proxy.username, "");
    assert.equal(patch.proxy.password, "");
    assert.deepEqual(patch.proxy.bypass, []);
  }

  const partial = proxyPatchFromForm({ enabled: "true", portText: 8080, bypassText: 42 });
  assert.equal(partial.proxy.enabled, false, "只有严格 true 算开（与 core 的 enabled 判定同口径）");
  assert.equal(partial.proxy.port, "", "非字符串端口当没填");
  assert.deepEqual(partial.proxy.bypass, []);
});

test("链路口径：表单载荷交给 core 归一后，去重/端口清洗都由 core 说了算（没有第二份实现）", () => {
  const patch = proxyPatchFromForm({
    enabled: true,
    host: " proxy.local ",
    portText: "1080",
    username: USERNAME,
    password: PASSWORD,
    bypassText: "localhost, LOCALHOST , 127.0.0.1",
  });
  const stored = normalizeProxy(patch.proxy);

  assert.deepEqual(stored, {
    enabled: true,
    host: "proxy.local",
    port: 1080,
    username: USERNAME,
    password: PASSWORD,
    bypass: ["localhost", "127.0.0.1"],
    // core 的 normalizeProxy 只回这六个字段（顺序即磁盘顺序）
  });
});

// ---------------------------------------------------------------------------
// 3. 保存前的校验：坏输入先拦下（core 会把 `8080x` 静默当"没填"）
// ---------------------------------------------------------------------------

test("校验：端口不是 1–65535 的整数就拦下，并说清「留空 = 不填」", () => {
  const base = { enabled: false, host: "", portText: "", username: "", password: "" };
  assert.equal(validateProxyForm(base), null, "端口留空是合法的（= 不填）");
  assert.equal(validateProxyForm({ ...base, portText: "1080" }), null);
  assert.equal(validateProxyForm({ ...base, portText: " 8080 " }), null, "两端空白不算错");

  for (const bad of ["8080x", "0", "65536", "8080.5", "-1", "1e3", "８０８０"]) {
    const message = validateProxyForm({ ...base, portText: bad });
    assert.equal(typeof message, "string", `端口 ${JSON.stringify(bad)} 该被拦下`);
    assert.match(message, /端口/, `文案要指明是端口：${message}`);
    assert.match(message, /留空/, `文案要给出下一步（留空 = 不填）：${message}`);
  }
});

test("校验：启用代理却没填主机 = 一定直连，保存前就说清", () => {
  const message = validateProxyForm({ enabled: true, host: "   ", portText: "1080" });
  assert.equal(typeof message, "string");
  assert.match(message, /主机/, `文案要指明缺什么：${message}`);
  assert.match(message, /直连/, `文案要说明后果：${message}`);

  assert.equal(validateProxyForm({ enabled: true, host: "proxy.local", portText: "1080" }), null);
  assert.equal(
    validateProxyForm({ enabled: false, host: "", portText: "" }),
    null,
    "没开代理时啥都不填是合法状态",
  );
});

// ---------------------------------------------------------------------------
// 4. 保存回执：重启要求要如实说，坏主机不许说成"已生效"
// ---------------------------------------------------------------------------

test("回执：代理改动要重启才生效，并说清「登录窗口下次打开即生效」", () => {
  const text = proxySaveNotice(documentWithProxy(), true);
  assert.match(text, /重启/, `要说明重启要求：${text}`);
  assert.match(text, /登录窗口/, `登录窗那半句也要在（R7 的窗是建窗时读代理）：${text}`);
  assert.ok(!text.includes(PASSWORD), "保存提示不许回显凭据");
});

test("回执：没动代理的保存不提重启（只说已保存）", () => {
  const text = proxySaveNotice(documentWithProxy(), false);
  assert.match(text, /已保存/);
  assert.ok(!/重启/.test(text), `没动代理别说要重启：${text}`);
});

test("回执：主机没通过清洗时必须说「代理不会生效」，不许只报「已保存」", () => {
  const text = proxySaveNotice(documentWithProxy({ host: "" }), true);
  assert.match(text, /主机/, `要指出主机有问题：${text}`);
  assert.match(text, /直连|不生效/, `要说明后果（仍直连）：${text}`);
  assert.match(text, /已保存/, "保存本身是成功的，别把它说成失败");
  assert.ok(!/protocol|undefined|\[object/.test(text), `不许漏出实现细节：${text}`);
});

// ---------------------------------------------------------------------------
// 5. 测试连接：成功/失败+原因摘要，且绝不回显凭据
// ---------------------------------------------------------------------------

test("测试连接：成功给出耗时，失败用 core 的结构化原因（带下一步）", () => {
  const okText = proxyTestResultText({ ok: true, ms: 320, status: 200 });
  assert.match(okText, /连通/);
  assert.match(okText, /320/, `耗时是用户判断代理好坏的唯一线索：${okText}`);

  const auth = proxyTestResultText({
    ok: false,
    ms: 12,
    error: { kind: "proxy_auth_required", message: "代理要求认证（407）：请检查用户名与密码" },
  });
  assert.match(auth, /认证/, auth);
  assert.match(auth, /用户名与密码/, `失败文案要给出下一步：${auth}`);

  assert.equal(proxyTestResultText(null), null, "还没测过就不显示任何结论");
});

test("测试连接：认不出的失败类别也要有一句话，且不带凭据", () => {
  const text = proxyTestResultText({ ok: false, error: { kind: "who_knows" } });
  assert.equal(typeof text, "string");
  assert.ok(text.trim() !== "", "空文案等于什么都没说");
  assert.ok(!text.includes(PASSWORD), text);
});

// ---------------------------------------------------------------------------
// 6. 关窗行为：tray/quit 载荷 + 托盘可用性提示
// ---------------------------------------------------------------------------

test("关窗行为：载荷只有枚举里的两项，越界值一律不写", () => {
  assert.deepEqual(CLOSE_BEHAVIORS, ["tray", "quit"]);
  assert.deepEqual(closeBehaviorPatch("tray"), { closeBehavior: "tray" });
  assert.deepEqual(closeBehaviorPatch("quit"), { closeBehavior: "quit" });
  assert.deepEqual(closeBehaviorPatch("explode"), { closeBehavior: "quit" }, "认不出的值回落到退出（能退出的那个）");
  assert.deepEqual(closeBehaviorPatch(null), { closeBehavior: "quit" });
  assert.equal(CLOSE_BEHAVIOR_LABELS.tray.length > 0, true);
  assert.equal(typeof CLOSE_BEHAVIOR_LABELS.quit, "string");
});

test("关窗行为：选了托盘但托盘不可用，必须说清会回退成退出", () => {
  const fallback = closeBehaviorNotice("tray", { trayAvailable: false });
  assert.match(fallback, /托盘/, fallback);
  assert.match(fallback, /退出/, `要说清回退行为：${fallback}`);

  const ready = closeBehaviorNotice("tray", { trayAvailable: true });
  assert.match(ready, /托盘/, ready);
  assert.ok(!/回退|不可用/.test(ready), `托盘可用时不该再提回退：${ready}`);

  const quit = closeBehaviorNotice("quit", { trayAvailable: false });
  assert.match(quit, /退出/, quit);
  assert.ok(!/托盘/.test(quit), `选退出与托盘无关，别扯上它：${quit}`);
});

// ---------------------------------------------------------------------------
// 7. 只读队列状态与失败文案
// ---------------------------------------------------------------------------

test("队列只读摘要：长度 + 当前曲（队列空时不说成播放失败）", () => {
  const empty = queueSummary({ entries: [], index: -1, track: null });
  assert.deepEqual(empty, { count: 0, current: null });

  const playing = queueSummary({
    entries: [{ id: "1001", name: "第一首", artists: "某歌手" }, { id: "1002", name: "第二首" }],
    index: 1,
    track: { id: "1002", name: "第二首" },
  });
  assert.equal(playing.count, 2);
  assert.equal(playing.current, "第二首");

  // 只有标识的曲目（恢复出来的队列）：显示标识，不显示"未知歌曲"
  const restored = queueSummary({ entries: [{ id: "1003" }], index: 0, track: { id: "1003" } });
  assert.equal(restored.current, "曲目 1003");

  assert.deepEqual(queueSummary(null), { count: 0, current: null }, "没有播放状态就是空队列，不抛");
});

test("队列只读摘要的文案：空队列给下一步，有队列给当前曲（都不说成播放失败）", () => {
  const empty = queueSummaryText({ count: 0, current: null });
  assert.match(empty, /双击/, `空队列要说清怎么开始：${empty}`);
  assert.ok(!/失败|错误/.test(empty), `空队列不是错误：${empty}`);

  const playing = queueSummaryText({ count: 3, current: "第二首" });
  assert.match(playing, /3/);
  assert.match(playing, /第二首/);

  const idle = queueSummaryText({ count: 3, current: null });
  assert.match(idle, /3/);
  assert.ok(!/undefined|null/.test(idle), `不许漏出实现细节：${idle}`);
});

test("失败文案：认得的类别给「原因 + 下一步」，认不得的带上 core 那句话", () => {
  const offline = settingsFailureText({ kind: "core_unavailable" });
  assert.match(offline, /重开|重启|稍后/, `要给出下一步：${offline}`);

  const payload = settingsFailureText({ kind: "invalid_payload", message: 'closeBehavior 只接受 tray / quit（收到 "explode"）' });
  assert.match(payload, /未.*保存|没.*保存/, `要说明没写盘：${payload}`);
  assert.equal(typeof settingsFailureText(null), "string");
  assert.ok(settingsFailureText(null).trim() !== "");

  const unknown = settingsFailureText({ kind: "weird_kind", message: "共享设置目录被占用" });
  assert.match(unknown, /共享设置目录被占用/, "认不出的类别要保留 core 给的那句话（唯一线索）");

  for (const text of [offline, payload, unknown, settingsFailureText(null)]) {
    assert.ok(!/敬请期待|即将上线/.test(text), `禁画饼：${text}`);
    assert.ok(!text.includes(PASSWORD), `文案里不许出现凭据：${text}`);
  }
});

// ---------------------------------------------------------------------------
// 8. 登录状态与退出（R38 改写：设置页那一整块删掉，退出只剩左下角账号区一处）
// ---------------------------------------------------------------------------
//
// 为什么不是"投影白名单"：`auth:status` 的载荷是**别人的数据**，形状不认识就当没有
// （R38 增补的可选 `profile` 由 `features/auth/account.mjs` 的 `profileFromStatusPayload` 解析）。
// 这一段钉两件事：
// 1. 设置页**不再**有登录状态字样与退出入口（删干净，不是注释掉）——展示与左下角账号区重复；
// 2. 退出只有**一处实现**：`host-api` 的 `coreLogout`（唯一 `auth:logout` 出口），
//    界面上的那个按钮走它，二次确认由 `AlertDialog` 负责。

test("登录状态与退出：设置页那一块已删净（不留注释掉的残骸、不留半个 Card）", () => {
  const page = read(PAGE_FILE);
  const settingsPage = page.slice(page.indexOf("export function SettingsPage("));
  assert.ok(settingsPage.length > 100, "必须在 pages.tsx 里找到 SettingsPage");

  assert.doesNotMatch(page, /loginStatusText/, "设置页不再有登录状态字样（那个函数已删）");
  assert.doesNotMatch(settingsPage, /AUTH_LOGOUT/, "设置页不再自己调退出频道");
  assert.doesNotMatch(settingsPage, /退出登录/, "设置页不再有退出入口（搬去左下角账号区）");
  assert.doesNotMatch(settingsPage, /<CardTitle>登录<\/CardTitle>/, "「登录」那一张卡整块删掉");
});

test("退出登录：只有一处实现（host-api 的 coreLogout），界面入口在左下角账号区", () => {
  const api = read("src/renderer/host-api.ts");
  assert.match(api, /export async function coreLogout\(/, "退出收进具名封装（唯一 auth:logout 出口）");
  assert.match(api, /coreCall\(AUTH_LOGOUT, null\)/, "载荷仍是 null（与设置页那一版同一件事）");
  assert.doesNotMatch(api, /coreCall\(\s*["'`]auth:logout["'`]/, "频道名走共享常量，不写字面量");

  const app = read("src/renderer/App.tsx");
  assert.match(app, /\bcoreLogout\b/, "左下角账号区走同一个实现（不复制第二份）");
  assert.match(app, /AlertDialog/, "退出要二次确认（误触的代价是重新扫码）");
  assert.match(app, /ACCOUNT_LOGOUT_DESCRIPTION/, "说明文案来自纯逻辑模块（只有一处真源）");

  const account = read("src/renderer/features/auth/account.mjs");
  assert.match(account, /退出后需要重新扫码登录/, "说明要写清代价");
  assert.match(account, /ACCOUNT_LOGOUT_TITLE = "退出登录"/, "确认框标题就是那个动作");
});

// ---------------------------------------------------------------------------
// 9. 凭据卫生：源码扫描（凭据不进任何被记录字符串 / UI 文案）
// ---------------------------------------------------------------------------

const LOGIC_FILE = "src/renderer/features/settings/settings-form.mjs";
const PAGE_FILE = "src/renderer/pages.tsx";

test("凭据卫生：密码只进表单与保存载荷，不进任何日志、文案或请求", () => {
  // 纯逻辑模块里不许有任何日志口子（它只回字符串，谁记录由调用方决定）
  const logic = read(LOGIC_FILE);
  assert.doesNotMatch(logic, /console\./, "纯逻辑模块不许写日志");
  assert.doesNotMatch(logic, /fetch\(|XMLHttpRequest|WebSocket/, "渲染层不发请求（唯一通道是 host-api）");

  // 带 password 的那几行只能是表单绑定，不许同时是日志
  const page = read(PAGE_FILE);
  for (const [index, line] of page.split("\n").entries()) {
    if (!/password/i.test(line)) continue;
    assert.doesNotMatch(line, /console\./, `${PAGE_FILE}:${index + 1} 密码不许进日志：${line.trim()}`);
  }
});

test("凭据卫生：页面不直接摸回执里的代理对象，密码字段是 password 类型", () => {
  const page = read(PAGE_FILE);
  const settingsPage = page.slice(page.indexOf("export function SettingsPage("));
  assert.ok(settingsPage.length > 100, "必须在 pages.tsx 里找到 SettingsPage");

  assert.match(settingsPage, /type="password"/, "密码字段必须是 password 类型（不回显给旁人）");
  assert.doesNotMatch(
    settingsPage,
    /data\.proxy|\.proxy\.password/,
    "页面不许直接读回执里的代理对象（唯一入口是 proxyFormFromSettings 的投影，凭据在那一步就丢了）",
  );
  assert.match(settingsPage, /proxyFormFromSettings\(/, "表单必须经投影函数建立");
});

// ---------------------------------------------------------------------------
// 10. 外观：跟随系统（裁决：不做手动切换，如实写在界面上）
// ---------------------------------------------------------------------------

test("外观：如实说明「跟随系统」，且不画手动切换的饼", () => {
  assert.equal(typeof APPEARANCE_NOTICE_TEXT, "string");
  assert.match(APPEARANCE_NOTICE_TEXT, /跟随系统|系统/, `要说清亮暗由谁决定：${APPEARANCE_NOTICE_TEXT}`);
  assert.ok(
    !/手动|自定义主题|深色模式开关/.test(APPEARANCE_NOTICE_TEXT) || /不提供|不做|没有/.test(APPEARANCE_NOTICE_TEXT),
    `不许暗示有手动切换：${APPEARANCE_NOTICE_TEXT}`,
  );
  assert.ok(!/敬请期待|即将上线/.test(APPEARANCE_NOTICE_TEXT), `禁画饼：${APPEARANCE_NOTICE_TEXT}`);

  const page = read(PAGE_FILE);
  const settingsPage = page.slice(page.indexOf("export function SettingsPage("));
  assert.match(settingsPage, /APPEARANCE_NOTICE_TEXT/, "设置页要真的把这条如实说明显示出来");
});
