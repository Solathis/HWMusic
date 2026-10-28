/**
 * 左下角账号区：`auth:status` 载荷里的可选 `profile` 能渲染出的三项。
 *
 * 三条不造假的口径：老载荷没有 `profile` 时解析回 `null` 且不抛，界面走兜底；
 * 缺什么兜什么——没有名字显示「已登录」（不显示 userId）、没有头像回 `null`、VIP 只在 `vip === true` 时显示；
 * 多余的键与坏类型一律忽略。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACCOUNT_FALLBACK_NAME,
  ACCOUNT_LOGOUT_DESCRIPTION,
  ACCOUNT_LOGOUT_FAILED_TEXT,
  ACCOUNT_LOGOUT_TITLE,
  ACCOUNT_SESSION_TICK_MS,
  accountAvatarFallbackText,
  accountAvatarUrl,
  accountFullName,
  accountIsVip,
  accountLogoutFailureText,
  accountNameText,
  accountVipText,
  profileFromStatusPayload,
  sessionExpiresAtFromStatusPayload,
  sessionRemainingText,
} from "../src/renderer/features/auth/account.mjs";
import { normalizeVipExpiry } from "../src/shared/vip-expiry.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

test("载荷解析：带 profile 认（只认那三个键），不带/坏形状回 null（旧载荷照旧能认）", () => {
  assert.deepEqual(
    profileFromStatusPayload({
      loggedIn: true,
      busy: false,
      profile: { userName: "听歌的人", avatarUrl: "https://cdn.dbankcdn.cn/a.jpg", vip: true, userId: "SNS-1" },
    }),
    { userName: "听歌的人", avatarUrl: "https://cdn.dbankcdn.cn/a.jpg", vip: true },
    "多余的键（userId 之类）不进投影",
  );

  // 之前的老载荷：没有 profile 这一格。
  assert.equal(profileFromStatusPayload({ loggedIn: true, busy: false }), null);
  assert.equal(profileFromStatusPayload({ loggedIn: false, busy: false, message: "登录未完成" }), null);
  assert.equal(profileFromStatusPayload(null), null);
  assert.equal(profileFromStatusPayload(undefined), null);

  // 坏形状一律当成"没有资料"，绝不抛
  for (const bad of [42, "profile", [], { profile: null }, { profile: [] }, { profile: {} }]) {
    assert.equal(profileFromStatusPayload(bad), null, JSON.stringify(bad));
  }

  // 只有一部分：缺的那部分就是缺（不是空串、不是占位符）
  assert.deepEqual(profileFromStatusPayload({ profile: { vip: true } }), { vip: true });
  assert.deepEqual(profileFromStatusPayload({ profile: { userName: "  名字  " } }), { userName: "名字" });
  assert.deepEqual(profileFromStatusPayload({ profile: { userName: "   " } }), null, "空白名字等于没有名字");
  assert.deepEqual(profileFromStatusPayload({ profile: { avatarUrl: 7 } }), null, "头像不是字符串就当没有");
});

test("显示：没有名字就是「已登录」（不显示 userId），VIP 只认明确的 true", () => {
  assert.equal(accountNameText({ userName: "听歌的人" }), "听歌的人");
  assert.equal(accountNameText(null), ACCOUNT_FALLBACK_NAME);
  assert.equal(accountNameText({}), ACCOUNT_FALLBACK_NAME);
  assert.equal(accountNameText({ userName: "  " }), ACCOUNT_FALLBACK_NAME);
  assert.equal(ACCOUNT_FALLBACK_NAME, "已登录", "兜底那句话是实话：会话在，只是不知道它叫什么");
  assert.doesNotMatch(ACCOUNT_FALLBACK_NAME, /userId|账号|uid/i);

  assert.equal(accountAvatarUrl({ avatarUrl: "https://cdn.dbankcdn.cn/a.jpg" }), "https://cdn.dbankcdn.cn/a.jpg");
  assert.equal(accountAvatarUrl({}), null);
  assert.equal(accountAvatarUrl(null), null);

  assert.equal(accountIsVip({ vip: true }), true);
  assert.equal(accountIsVip({ vip: false }), false);
  assert.equal(accountIsVip({}), false);
  assert.equal(accountIsVip(null), false);
});

test("退出：文案与失败人话都来自这一处（core 的原话优先，认不出才用兜底那句）", () => {
  assert.equal(ACCOUNT_LOGOUT_TITLE, "退出登录");
  assert.match(ACCOUNT_LOGOUT_DESCRIPTION, /重新扫码登录/, "说明要写清代价（重扫成本高）");
  assert.equal(accountLogoutFailureText({ message: "core 尚未就绪", kind: "core_unavailable" }), "core 尚未就绪");
  assert.equal(accountLogoutFailureText({ message: "   " }), ACCOUNT_LOGOUT_FAILED_TEXT);
  assert.equal(accountLogoutFailureText(null), ACCOUNT_LOGOUT_FAILED_TEXT);
  assert.equal(accountLogoutFailureText("boom"), ACCOUNT_LOGOUT_FAILED_TEXT);
});

test("接线：资料与登录状态来自同一份载荷；账号区只用这一个模块的投影", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /profileFromStatusPayload\(payload\)/, "门禁解析 profile（与状态同一处 apply）");
  assert.match(gate, /profile: AccountProfile/, "AuthGate 暴露 profile 给外壳");
  assert.doesNotMatch(gate, /\.userId\b/, "userId 不是给人看的（不显示账号标识）");

  const app = read("src/renderer/App.tsx");
  for (const helper of ["accountNameText(", "accountAvatarUrl(", "accountVipText(", "accountLogoutFailureText("]) {
    assert.match(app, new RegExp(helper.replace("(", "\\(")), `账号区要用纯逻辑模块的 ${helper}）`);
  }
  assert.match(app, /data-testid=\{ACCOUNT_AREA_TESTID\}/, "账号区要有测试锚点（CDP 取证也靠它）");
  assert.match(app, /data-testid=\{ACCOUNT_VIP_TESTID\}/, "VIP 徽标要有锚点");
  // 徽标只在有会员事实时渲染（不是靠 CSS 藏起来）
  assert.match(app, /accountVipText/, "会员徽标由 accountVipText 的结论决定");
});

/* 到期时间：只认「能显示成某一天」的形状，其余一律当没有。 */

test("R57 到期时间：只认「能显示成某一天」的形状，其余一律当没有（不编日期）", () => {
  for (const [input, expected] of [
    ["2026-12-31", "2026-12-31"],
    [" 2026-12-31 ", "2026-12-31"],
    ["20261231", "2026-12-31"],
    ["20261231235959", "2026-12-31"],
    ["2026-12-31T23:59:59Z", "2026-12-31"],
    ["2026-12-31 23:59:59", "2026-12-31"],
  ]) {
    assert.equal(normalizeVipExpiry(input), expected, input);
  }
  for (const bad of [null, undefined, "", "   ", "soon", "2026-13-01", "2026-02-30", "0000-00-00", 20261231, true, {}, []]) {
    assert.equal(normalizeVipExpiry(bad), null, JSON.stringify(bad) ?? String(bad));
  }
});

test("R57 会员徽标文案：没有会员事实就不显示；有到期日才写成「会员 · 至 …」", () => {
  assert.equal(accountVipText(null), null);
  assert.equal(accountVipText({}), null);
  assert.equal(accountVipText({ vip: false }), null);
  assert.equal(accountVipText({ vip: true }), "会员");
  assert.equal(accountVipText({ vip: true, vipExpiresOn: "2026-12-31" }), "会员 · 至 2026-12-31");
  assert.equal(accountVipText({ vipExpiresOn: "2026-12-31" }), "会员 · 至 2026-12-31", "有到期日本身就说明是会员");
  assert.equal(accountVipText({ vip: true, vipExpiresOn: "坏值" }), "会员", "到期日认不出就只说会员");
  assert.equal(accountIsVip({ vipExpiresOn: "2026-12-31" }), true);
});

test("R57 头像兜底：有名字就取首字（拉丁字母大写），没名字就交给图标占位", () => {
  assert.equal(accountAvatarFallbackText({ userName: "听歌的人" }), "听");
  assert.equal(accountAvatarFallbackText({ userName: "alice" }), "A");
  assert.equal(accountAvatarFallbackText({ userName: "  alice  " }), "A");
  assert.equal(accountAvatarFallbackText({ userName: "🎵听歌" }), "🎵", "按码点取，不把代理对切坏");
  assert.equal(accountAvatarFallbackText(null), null);
  assert.equal(accountAvatarFallbackText({}), null);
  assert.equal(accountAvatarFallbackText({ userName: "   " }), null);
  assert.equal(accountFullName({ userName: "听歌的人" }), "听歌的人", "全名（头像首字也从它取）");
  assert.equal(accountFullName(null), null, "兜底那句「已登录」不是真名字");
  assert.equal(accountFullName({}), null);
});

test("R57 载荷：到期时间跟着 profile 一起进来（旧载荷没有这一格照旧能认）", () => {
  assert.deepEqual(
    profileFromStatusPayload({ profile: { userName: "名字", vip: true, vipExpiresOn: "20261231", userId: "SNS-1" } }),
    { userName: "名字", vip: true, vipExpiresOn: "2026-12-31" },
  );
  assert.deepEqual(profileFromStatusPayload({ profile: { vip: true, vipExpiresOn: "坏值" } }), { vip: true }, "坏值丢弃，不丢 vip");
  assert.deepEqual(profileFromStatusPayload({ profile: { vipExpiresOn: "2026-12-31" } }), { vipExpiresOn: "2026-12-31" });
});

test("R57/R79 接线：账号区用官方组件（头像可回退、名称截断 + 悬停剩余时间、徽标用 Badge、折叠只剩头像）", () => {
  const app = read("src/renderer/App.tsx");
  const tooltip = read("src/renderer/account-name-tooltip.tsx");
  // 头像：图片 + 兜底两档都在（图片挂了要落到首字/图标）
  assert.match(app, /<AvatarImage/, "头像走 AvatarImage");
  assert.match(app, /ACCOUNT_AVATAR_TESTID/, "头像要有锚点");
  assert.match(app, /accountAvatarFallbackText\(/, "兜底用 accountAvatarFallbackText");
  // 名称：截断 + 悬停显示会话剩余时间（Tooltip 是官方组件）
  assert.match(app, /<AccountNameTooltip name=\{accountName\} sessionExpiresAt=\{sessionExpiresAt\} \/>/, "名称交给 AccountNameTooltip");
  assert.match(tooltip, /<TooltipTrigger asChild>[\s\S]{0,400}?ACCOUNT_NAME_TESTID/, "名称悬停提示用 Tooltip");
  assert.match(tooltip, /truncate/, "名称要截断");
  assert.match(tooltip, /sessionRemainingText\(sessionExpiresAt, nowMs\)/, "提示文案来自 sessionRemainingText");
  assert.match(tooltip, /if \(!open\) return undefined/, "只在提示打开时刷新");
  // 会员：官方 Badge 承载文案
  assert.match(app, /const accountVipLabel = accountVipText\(profile\)/, "徽标文案来自 accountVipText");
  assert.match(app, /accountVipLabel === null \? null : \(/, "没有会员事实就不渲染徽标");
  assert.match(app, /<Badge/, "会员标识用 Badge");
  // 折叠成图标时只剩头像（名字那一列、主题、退出一起藏）
  assert.match(app, /group-data-\[collapsible=icon\]:hidden">\s*<AccountNameTooltip/, "名字整列在窄轨里隐藏");
});

test("R79 悬停剩余时间：天 / 小时 / 分 / 秒，前导的零单位省略；到期与未知各一句", () => {
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  const second = 1_000;
  assert.equal(sessionRemainingText(now + (6 * 86_400 + 5 * 3_600 + 9 * 60 + 8) * second, now), "距登录过期还剩 6 天 5 小时 9 分 8 秒");
  assert.equal(sessionRemainingText(now + 7 * 86_400 * second, now), "距登录过期还剩 7 天 0 小时 0 分 0 秒");
  assert.equal(sessionRemainingText(now + (2 * 3_600 + 5) * second, now), "距登录过期还剩 2 小时 0 分 5 秒");
  assert.equal(sessionRemainingText(now + 59 * second, now), "距登录过期还剩 59 秒");
  assert.equal(sessionRemainingText(now + 1, now), "距登录过期还剩 1 秒", "不足一秒向上取整，不提前说过期");
  assert.equal(sessionRemainingText(now, now), "登录已过期，请重新扫码登录");
  assert.equal(sessionRemainingText(now - 5_000, now), "登录已过期，请重新扫码登录");
  for (const bad of [null, undefined, Number.NaN, "1", Number.POSITIVE_INFINITY]) {
    assert.equal(sessionRemainingText(bad, now), "登录有效期未知", `认不出：${String(bad)}`);
  }
  assert.notEqual(sessionRemainingText(now + 90 * second, now), sessionRemainingText(now + 90 * second, now + second), "每秒变化");
  assert.equal(ACCOUNT_SESSION_TICK_MS, 1_000);
});

test("R79 载荷：sessionExpiresAt 只认有限正数，别的一律当没有", () => {
  assert.equal(sessionExpiresAtFromStatusPayload({ loggedIn: true, sessionExpiresAt: 1_793_000_000_000 }), 1_793_000_000_000);
  for (const bad of [{}, { sessionExpiresAt: 0 }, { sessionExpiresAt: -1 }, { sessionExpiresAt: "1793000000000" }, { sessionExpiresAt: Number.NaN }, null, undefined]) {
    assert.equal(sessionExpiresAtFromStatusPayload(bad), null, JSON.stringify(bad));
  }
});
