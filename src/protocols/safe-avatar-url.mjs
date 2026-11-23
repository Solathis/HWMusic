import { isSafeMediaUrl } from "./safe-media-url.mjs";

export function isSafeAvatarUrl(value) {
  if (isSafeMediaUrl(value)) return true;
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!/^https:\/\/upfile-drcn\.platform\.hicloud\.com(?:[/?#]|$)/i.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "upfile-drcn.platform.hicloud.com"
      && url.username === "" && url.password === "" && url.port === "";
  } catch {
    return false;
  }
}
