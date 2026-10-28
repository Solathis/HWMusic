/**
 * 左下角账号区的纯逻辑：auth:status 载荷里的 profile → 能渲染的那三项。
 *
 * 缺什么就兜什么绝不编；会员只在有事实时显示；旧载荷照旧能认，不抛错也不显示空壳。
 */
import { normalizeVipExpiry } from "../../../shared/vip-expiry.mjs";

/** 没有名字时的兜底文案（这是实话：会话在，只是我们不知道它叫什么）。 */
export const ACCOUNT_FALLBACK_NAME = "已登录";
/** 账号区与其中几处的测试锚点（CDP/测试都按它们认）。 */
export const ACCOUNT_AREA_TESTID = "account-area";
export const ACCOUNT_NAME_TESTID = "account-name";
export const ACCOUNT_VIP_TESTID = "account-vip";
export const ACCOUNT_AVATAR_TESTID = "account-avatar";

/** VIP 徽标的可达名称（图标本身不给读屏信息）。 */
export const ACCOUNT_VIP_LABEL = "会员";

/** 退出登录那三句文案（唯一出处；AlertDialog 只是把它们摆出来）。 */
export const ACCOUNT_LOGOUT_TITLE = "退出登录";
export const ACCOUNT_LOGOUT_DESCRIPTION = "退出后需要重新扫码登录。";
export const ACCOUNT_LOGOUT_CONFIRM = "退出";
export const ACCOUNT_LOGOUT_CANCEL = "取消";
/** 退出失败时那一句（用户主动点的动作，失败必须看得见）。 */
export const ACCOUNT_LOGOUT_FAILED_TEXT = "退出登录失败（详情见日志）。";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** auth:status 载荷 → 可渲染的 profile（认不出任何一项就是 null）；只认 userName / avatarUrl / vip 三个键。 */
export function profileFromStatusPayload(payload) {
  const source = isObject(payload) ? payload.profile : null;
  if (!isObject(source)) return null;
  const profile = {};
  const userName = textOf(source.userName);
  if (userName !== null) profile.userName = userName;
  const avatarUrl = textOf(source.avatarUrl);
  if (avatarUrl !== null) profile.avatarUrl = avatarUrl;
  if (source.vip === true) profile.vip = true;
  const vipExpiresOn = normalizeVipExpiry(source.vipExpiresOn);
  if (vipExpiresOn !== null) profile.vipExpiresOn = vipExpiresOn;
  return Object.keys(profile).length === 0 ? null : profile;
}

/** 显示名：有名字用名字，没有就是"已登录"（不显示 userId——那不是给人看的东西）。 */
export function accountNameText(profile) {
  const name = isObject(profile) ? textOf(profile.userName) : null;
  return name ?? ACCOUNT_FALLBACK_NAME;
}

/**
 * 悬停时给出的全名（`null` = 不值得悬停：没有真名字，或者名字根本没被截断）。
 *
 * 兜底那句"已登录"不弹：它背后没有更多信息，弹出来只是噪音。
 */
export function accountFullName(profile) {
  return isObject(profile) ? textOf(profile.userName) : null;
}

/** 头像加载失败或没有头像时的首字：取第一个码点（不按 UTF-16 切），拉丁字母转大写；null 交给图标占位。 */
export function accountAvatarFallbackText(profile) {
  const name = accountFullName(profile);
  if (name === null) return null;
  const first = [...name][0];
  return first === undefined ? null : first.toUpperCase();
}

/** 头像地址；没有就是 `null`（`Avatar` 会落到首字/图标兜底）。 */
export function accountAvatarUrl(profile) {
  return isObject(profile) ? textOf(profile.avatarUrl) : null;
}

/** 是否会员：vip === true，或者有认得出的到期日（到期日比标志位更具体）。 */
export function accountIsVip(profile) {
  if (!isObject(profile)) return false;
  return profile.vip === true || normalizeVipExpiry(profile.vipExpiresOn) !== null;
}

/** 会员徽标文案（null = 不显示）：到期日只在认得出那一天时才写进去，认不出就只说会员。 */
export function accountVipText(profile) {
  if (!accountIsVip(profile)) return null;
  const expiry = normalizeVipExpiry(profile.vipExpiresOn);
  return expiry === null ? ACCOUNT_VIP_LABEL : `${ACCOUNT_VIP_LABEL} · 至 ${expiry}`;
}

/** 退出失败 → 一句人话（core 的 message 已清洗过，原样用；认不出就用兜底那句）。 */
export function accountLogoutFailureText(cause) {
  const message = isObject(cause) ? textOf(cause.message) : null;
  return message ?? ACCOUNT_LOGOUT_FAILED_TEXT;
}
