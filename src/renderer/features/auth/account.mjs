/**
 * 左下角账号区（R38）的**纯逻辑**：`auth:status` 载荷里的可选 `profile` → 能渲染的那三项。
 *
 * 为什么单独一个模块：这里每一个判定都会被"界面长什么样"直接暴露出来——
 * 名字缺失时显示什么、头像地址不合格时怎么办、VIP 徽标什么时候出现。放进组件里就只能靠人眼，
 * 而这三条恰恰是"不造假数据"这条纪律最容易被破坏的地方。
 *
 * 四条口径（都是裁决，不是显然）：
 * 1. **缺什么就兜什么，绝不编**：没有名字 → [`ACCOUNT_FALLBACK_NAME`]（"已登录"），
 *    没有头像（或地址不合格/加载失败）→ 首字，连名字都没有 → 图标兜底；
 * 2. **会员只在有事实时显示**：`vip === true` 或**认得出的到期日**（R57）；
 *    到期日认不出时只说"会员"，绝不印一个编出来的日期；
 * 3. **旧载荷（没有 `profile` 这一格）必须照旧能认**：R38 之前建的会话就是这样，
 *    解析器对它返回 `null`（界面走兜底），**不抛错、不显示空壳**；
 * 4. **R57 的到期日不猜格式**：认哪种写法由 `src/shared/vip-expiry.mjs` 一处决定。
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

/**
 * `auth:status` 载荷 → 可渲染的 profile（认不出任何一项就是 `null`）。
 *
 * 只认三个键（与 `src/main/music-session.mjs` 的 `profileOfSessionRecord` 同一份形状）：
 * `userName` / `avatarUrl` / `vip`。其余一律忽略——载荷是**别人的数据**，形状不认识就当没有。
 */
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

/**
 * 头像加载失败/没有头像时的首字（`null` = 连名字都没有，交给图标占位）。
 *
 * 取**第一个码点**（`[...name][0]`），不按 UTF-16 下标切——否则 emoji 会被切成半个碎字。
 * 拉丁字母转大写（头像位只有一个字符，大小写混排时大写更好认）。
 */
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

/**
 * 是否会员：明确的 `true`，或者**有到期日**（有到期日本身就是会员的证据）。
 *
 * 到期日不是布尔标志：`vip === false` 却又带着到期日的载荷自相矛盾，这里按"有到期日算会员"
 * ——到期日比标志位更具体，而界面宁可多显示一个字，也不该把一个快到期的会员藏起来。
 */
export function accountIsVip(profile) {
  if (!isObject(profile)) return false;
  return profile.vip === true || normalizeVipExpiry(profile.vipExpiresOn) !== null;
}

/**
 * 会员徽标的文案（`null` = 不显示徽标）：`会员` / `会员 · 至 2026-12-31`。
 *
 * 到期时间只在**认得出那一天**时才写进去（见 `src/shared/vip-expiry.mjs`）；
 * 认不出就只说"会员"，绝不显示一个编出来的日期。
 */
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
