/**
 * 左下角账号区（R38）的**纯逻辑**：`auth:status` 载荷里的可选 `profile` → 能渲染的那三项。
 *
 * 为什么单独一个模块：这里每一个判定都会被"界面长什么样"直接暴露出来——
 * 名字缺失时显示什么、头像地址不合格时怎么办、VIP 徽标什么时候出现。放进组件里就只能靠人眼，
 * 而这三条恰恰是"不造假数据"这条纪律最容易被破坏的地方。
 *
 * 三条口径（都是裁决，不是显然）：
 * 1. **缺什么就兜什么，绝不编**：没有名字 → [`ACCOUNT_FALLBACK_NAME`]（"已登录"），
 *    没有头像（或地址不合格）→ `Avatar` 的图标兜底，没有 VIP 事实 → **不显示徽标**；
 * 2. **VIP 只在 `profile.vip === true` 时显示**：`false`/缺失/坏形状一律不显示——
 *    协议层也只在"认得出"时才带这个键（见 `src/main/music-session.mjs` 的 `profileFromResponse`）；
 * 3. **旧载荷（没有 `profile` 这一格）必须照旧能认**：R38 之前建的会话就是这样，
 *    解析器对它返回 `null`（界面走兜底），**不抛错、不显示空壳**。
 */

/** 没有名字时的兜底文案（这是实话：会话在，只是我们不知道它叫什么）。 */
export const ACCOUNT_FALLBACK_NAME = "已登录";

/** 账号区与其中几处的测试锚点（CDP/测试都按它们认）。 */
export const ACCOUNT_AREA_TESTID = "account-area";
export const ACCOUNT_NAME_TESTID = "account-name";
export const ACCOUNT_VIP_TESTID = "account-vip";

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
  return Object.keys(profile).length === 0 ? null : profile;
}

/** 显示名：有名字用名字，没有就是"已登录"（不显示 userId——那不是给人看的东西）。 */
export function accountNameText(profile) {
  const name = isObject(profile) ? textOf(profile.userName) : null;
  return name ?? ACCOUNT_FALLBACK_NAME;
}

/** 头像地址；没有就是 `null`（`Avatar` 会落到图标兜底）。 */
export function accountAvatarUrl(profile) {
  return isObject(profile) ? textOf(profile.avatarUrl) : null;
}

/** 是否显示 VIP 徽标：**只认明确的 true**。 */
export function accountIsVip(profile) {
  return isObject(profile) && profile.vip === true;
}

/** 退出失败 → 一句人话（core 的 message 已清洗过，原样用；认不出就用兜底那句）。 */
export function accountLogoutFailureText(cause) {
  const message = isObject(cause) ? textOf(cause.message) : null;
  return message ?? ACCOUNT_LOGOUT_FAILED_TEXT;
}
