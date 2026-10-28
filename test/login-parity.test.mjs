/**
 * 单一真源互钉：登录顶部内缩、10 分钟超时、登录域名白名单、回调识别。
 * 做法：Node 侧硬钉常量内容，再按源码扫描反漂移（字面量只许出现在唯一真源文件里）。
 * 登录页铺满整窗，`LOGIN_VIEW_TOP_INSET` 只服务门禁自己的 header，Rust 不许再镜像它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOGIN_VIEW_TOP_INSET } from "../src/shared/login-inset.mjs";
import { LOGIN_ALLOWED_ORIGINS, LOGIN_ALLOWED_URLS, LOGIN_TIMEOUT_MS } from "../src/protocols/login-callback.mjs";
import {
  HOST_LOGIN_STATUS,
  LOGIN_PAGE_UNAVAILABLE_MESSAGE,
  LOGIN_TIMEOUT_MESSAGE,
} from "../src/main/huawei.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 递归列出 src/ 下的运行期源码（跳过 src/shared/*.ts 真源与 .d.ts 声明）。 */
function sourceFiles(root = "src") {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(mjs|ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      found.push(child);
    }
  };
  walk(root);
  return found;
}

test("顶部内缩：唯一真源是 src/shared/login-inset.mjs，值为 48", () => {
  assert.equal(LOGIN_VIEW_TOP_INSET, 48);
  assert.equal(typeof LOGIN_VIEW_TOP_INSET, "number");
});

test("顶部内缩：48 字面量只许出现在 login-inset.mjs（其余地方必须 import 常量）", () => {
  const offenders = [];
  for (const relative of sourceFiles()) {
    if (relative === "src/shared/login-inset.mjs") continue;
    const source = read(relative);
    if (/LOGIN_VIEW_TOP_INSET\s*[:=]\s*\d/.test(source)) offenders.push(`${relative}: 重新定义了 LOGIN_VIEW_TOP_INSET 字面量`);
    source.split("\n").forEach((line, index) => {
      if (/inset/i.test(line) && /\b48\b/.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `顶部内缩字面量出现在唯一真源之外：${offenders.join(" | ")}`);
});

test("顶部内缩：R25 起 Rust **不再**镜像它（登录页铺满整窗，顶部那一条只剩门禁自己用）", () => {
  const rustPath = "src-tauri/src/login.rs";
  if (!existsSync(`${repoRoot}${rustPath}`)) {
    assert.ok(true, "R4 阶段 login.rs 尚不存在");
    return;
  }
  const code = stripComments(read(rustPath));
  assert.doesNotMatch(
    code,
    /LOGIN_VIEW_TOP_INSET/,
    "R25：Rust 侧不许再镜像顶部内缩——登录页铺满整个客户区（用户四项之 3），" +
      "留一个镜像值只会让下一个人又去客户区里挖一条",
  );
  assert.doesNotMatch(code, /top_inset/, "几何里不许再有 topInset 这个字段（留一个永远是 0 的旋钮只会摆错页面）");
  assert.doesNotMatch(code, /topInset/, "载荷解析里不许再有 topInset");
});

test("顶部内缩：门禁那条 header 仍然读共享常量（唯一消费者，不许写第二份 48）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(
    gate,
    /LOGIN_VIEW_TOP_INSET/,
    "R25：登录页不再是它的消费者，但门禁自己那条 header 仍然是——常量不许变成孤儿",
  );
});

test("登录超时：唯一真源是 login-callback.mjs 的 LOGIN_TIMEOUT_MS = 10 × 60_000", () => {
  assert.equal(LOGIN_TIMEOUT_MS, 600_000);
  assert.equal(LOGIN_TIMEOUT_MS, 10 * 60_000);

  const offenders = [];
  for (const relative of sourceFiles()) {
    if (relative === "src/protocols/login-callback.mjs") continue;
    const source = read(relative);
    if (/LOGIN_TIMEOUT_MS\s*[:=]\s*[\d_]/.test(source)) offenders.push(`${relative}: 重新定义了 LOGIN_TIMEOUT_MS`);
    source.split("\n").forEach((line, index) => {
      if (!/timeout/i.test(line)) return;
      if (/600_000|600000|10\s*\*\s*60_000|10\s*\*\s*60\s*\*\s*1000/.test(line)) {
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `10 分钟超时字面量出现在唯一真源之外：${offenders.join(" | ")}`);
});

test("登录超时：R7 的 Rust login.rs 一旦落地即与 Node 侧互钉（当前不存在 = 无需互钉）", () => {
  const rustPath = "src-tauri/src/login.rs";
  if (!existsSync(`${repoRoot}${rustPath}`)) {
    assert.ok(true, "R4 阶段 login.rs 尚不存在：Node 侧为唯一真源，R7 落地后本断言自动升级为互钉");
    return;
  }
  const source = read(rustPath);
  const secs = source.match(/LOGIN_TIMEOUT\w*\s*:[^=]*=\s*(?:Duration::from_secs\()?([0-9_]+)/);
  assert.ok(secs, "R7 落地后 login.rs 必须能识别出 LOGIN_TIMEOUT 秒数字面量，供本测试互钉");
  assert.equal(Number(secs[1].replaceAll("_", "")) * 1000, LOGIN_TIMEOUT_MS, "Rust 与 Node 的超时必须相等");
});

/**
 * 只扫代码，不扫注释：注释里写"只认 hms://redirect_uri"是说明文字，不是第二份真源。
 * 保留 `://`（前面是冒号，不算行注释）。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("state 比较必须常量时间（node:crypto 的 timingSafeEqual），不得用 === 比 state", () => {
  const source = stripComments(read("src/protocols/login-callback.mjs"));
  assert.match(source, /timingSafeEqual/, "state 比较必须用 timingSafeEqual");
  assert.match(source, /from\s+"node:crypto"/);
  // 类型/空值判断（expectedState === ""）不算"比 state"；比的是两个 state 值才算
  assert.doesNotMatch(
    source,
    /(?:expectedState|\.state)\s*(?:===|!==)\s*[^"'\s]/,
    "不得把 state 与变量直接 === 比较（必须走 statesMatch）",
  );
  assert.doesNotMatch(
    source,
    /(?:===|!==)\s*(?:expectedState|[\w.]+\.state)\b/,
    "不得把变量直接 === 到 state（必须走 statesMatch）",
  );
});

test("回调识别：hms:// 协议字面量只在 login-callback.mjs，redirect_uri 字面量只在 auth.mjs", () => {
  const offenders = [];
  for (const relative of sourceFiles("src")) {
    if (["src/protocols/login-callback.mjs", "src/protocols/auth.mjs"].includes(relative)) continue;
    const source = stripComments(read(relative));
    if (/["'`]hms:/.test(source)) offenders.push(`${relative}: 出现 hms: 协议字面量`);
    if (/hms:\/\/redirect_uri/.test(source)) offenders.push(`${relative}: 出现 redirect_uri 字面量`);
  }
  assert.deepEqual(offenders, [], offenders.join(" | "));

  const callback = stripComments(read("src/protocols/login-callback.mjs"));
  assert.match(callback, /OAUTH_REDIRECT_URI/, "回调识别必须复用 auth.mjs 的 OAUTH_REDIRECT_URI 常量");
  assert.doesNotMatch(callback, /redirect_uri/, "不得在 login-callback.mjs 里再写一份 redirect_uri 字面量");
});

test("登录域名白名单：条目硬钉（改动必须同步改测试，避免悄悄放宽）", () => {
  // 条目 = 参考实现实测走通的五个域（授权域与令牌域是两个不同主机）。
  assert.deepEqual(LOGIN_ALLOWED_ORIGINS, [
    "https://oauth-login.platform.hicloud.com",
    "https://oauth-login.cloud.huawei.com",
    // id1.cloud.huawei.com 是授权页跳转到的 CAS 门户页；少了它登录窗会停在空壳上。
    "https://id1.cloud.huawei.com",
    "https://account.huawei.com",
    "https://consumer.huawei.com",
  ]);
  assert.deepEqual(LOGIN_ALLOWED_URLS, ["https://oauth-login1.cloud.huawei.com/oauth2/v3/loginCallback"]);

  const source = read("src/protocols/login-callback.mjs");
  const code = stripComments(source);
  assert.doesNotMatch(code, /\*\.huawei\.com/, "白名单是显式条目，不是 *.huawei.com 通配");
  assert.doesNotMatch(code, /oauth-login2/, "不得加入 oauth-login2（换区域主机须显式决策）");
  // 通配式放行（endsWith("huawei.com") 之类）同样不算显式条目
  assert.doesNotMatch(code, /endsWith\(\s*["'`][^"'`]*huawei\.com/, "不得用后缀通配替代显式条目表");
});

test("登录域名白名单：R7 的 Rust 导航白名单一旦落地，必须覆盖 Node 侧全部条目（当前不存在 = 无需互钉）", () => {
  const rustPath = "src-tauri/src/login.rs";
  if (!existsSync(`${repoRoot}${rustPath}`)) {
    assert.ok(true, "R4 阶段 login.rs 尚不存在：Node 侧为唯一真源，R7 落地后本断言自动升级为互钉");
    return;
  }
  const code = stripComments(read(rustPath));
  const missing = [...LOGIN_ALLOWED_ORIGINS, ...LOGIN_ALLOWED_URLS].filter((entry) => !code.includes(entry));
  assert.deepEqual(missing, [], `Rust 侧导航白名单漏了 Node 侧的条目（旧仓"卡在 CAS 页"故障就是漏条目）：${missing.join(", ")}`);
  assert.doesNotMatch(code, /oauth-login2/, "Rust 侧同样不得默认放行 oauth-login2");
});

// 宿主结论的线上契约：Rust login.rs 与 Node huawei.ts 的 status 词表两侧互钉。

test("R7：宿主结论的 status 词表两侧互钉（Rust 交付 ↔ Node 解析）", () => {
  const code = stripComments(read("src-tauri/src/login.rs"));
  const missing = Object.values(HOST_LOGIN_STATUS).filter((status) => !code.includes(`"${status}"`));
  assert.deepEqual(missing, [], `Rust 侧缺少 Node 会解析的结论 status：${missing.join(", ")}`);
  assert.doesNotMatch(code, /"failed"/, "宿主结论不用 R4 的 failed（那是流程内部状态）：未知结论由 Node 归成结构化错误");
});

test("R7：两条期限文案两侧逐字一致，且「打不开官方页」≠「扫码超时」", () => {
  const code = stripComments(read("src-tauri/src/login.rs"));
  assert.ok(
    code.includes(LOGIN_PAGE_UNAVAILABLE_MESSAGE),
    `Rust 侧首载超时文案与 Node 侧不一致（用户两侧看到两句话）：${LOGIN_PAGE_UNAVAILABLE_MESSAGE}`,
  );
  assert.ok(
    code.includes(LOGIN_TIMEOUT_MESSAGE),
    `Rust 侧总超时文案与 Node 侧不一致：${LOGIN_TIMEOUT_MESSAGE}`,
  );
  assert.notEqual(LOGIN_PAGE_UNAVAILABLE_MESSAGE, LOGIN_TIMEOUT_MESSAGE);
});

test("R25：host:open-login 的形状只有 url 与 partition（topInset 已退休）", () => {
  const code = stripComments(read("src-tauri/src/login.rs"));
  const configAt = code.indexOf("pub struct LoginConfig");
  assert.ok(configAt > -1, "login.rs 要有 LoginConfig（载荷的形状就是它）");
  const body = code.slice(configAt, code.indexOf("}", configAt));
  for (const field of ["url", "partition"]) {
    assert.ok(body.includes(field), `LoginConfig 必须还有 ${field}：${body}`);
  }
  assert.ok(
    !body.includes("top_inset") && !body.includes("topInset"),
    `LoginConfig 不许再有 topInset（登录页铺满整窗）：${body}`,
  );
  assert.match(code, /struct LoginConfig/, "形状要能被本用例定位（改结构就得同步改这里）");
});
