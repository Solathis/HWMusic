/**
 * 会员到期时间（R57）：**只认「能显示成某一天」的形状**，其余一律 `null`。
 *
 * 为什么收这么紧：这一格会直接印在账号区上（「会员 · 至 2026-12-31」）。认错了，
 * 就是把"不知道"写成"确定"，而用户会拿它去决定要不要续费。
 *
 * 认三种写法（都是本仓已有证据的同类形状）：`YYYY-MM-DD`、`YYYYMMDD`、
 * 本 API 的 14 位 `YYYYMMDDHHMMSS`（与 `expireTime` 同形状，时间部分丢弃）。
 * 时区一律不换算——只取日期段，不猜它在哪个时区。
 */

/** 4 位年 + 2 位月 + 2 位日（允许后面跟时间，但时间部分不参与）。 */
const ISO_LIKE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
/** 8 位 `YYYYMMDD` 或 14 位 `YYYYMMDDHHMMSS`。 */
const COMPACT = /^(\d{4})(\d{2})(\d{2})(?:\d{6})?$/;

/**
 * @param {unknown} value 候选到期时间
 * @returns {string | null} 归一化的 `YYYY-MM-DD`；认不出就是 `null`（不抛）
 */
export function normalizeVipExpiry(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const match = ISO_LIKE.exec(text) ?? COMPACT.exec(text);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // 回读校验：2026-02-30 会被 Date 进位成 3 月 2 日，那不是用户看到的那一天
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() + 1 !== month ||
    stamp.getUTCDate() !== day
  ) {
    return null;
  }
  // 会员到期时间不会早于这个产品诞生的年代（挡掉 0000-01-01 之类的"合法但荒谬"）
  if (year < 1970) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
