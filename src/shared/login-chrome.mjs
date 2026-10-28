/**
 * 登录浮动控件（`login-return` / `login-theme`）的跨语言契约：同一个本地页面靠 `?kind=` 决定渲染哪一个。
 * 入口名与两个 kind 字面量由 `src-tauri/src/login.rs` 镜像，`test/login-chrome.test.mjs` 扫描源码钉住相等。
 */

/** 浮动控件的本地页面（打包入口之一，见 vite.config.ts）。 */
export const LOGIN_CHROME_ENTRY = "login-chrome.html";

/** 两个浮动控件的 kind（查询串 `?kind=` 的取值）。 */
export const LOGIN_CHROME_KIND = {
  /** 左上：返回扫码登录（点击 → `core_login_chrome {action:"return"}`） */
  return: "return",
  /** 右上：主题三态控件（点击 → `core_login_chrome {action:"theme", theme}`） */
  theme: "theme",
};

/** 全部 kind（顺序 = 展示顺序，也用作"认不出就不渲染"的白名单）。 */
export const LOGIN_CHROME_KINDS = [LOGIN_CHROME_KIND.return, LOGIN_CHROME_KIND.theme];

/** 一次浮动控件请求要加载的地址（Rust 侧镜像同一条拼法）。 */
export function loginChromeUrl(kind) {
  return `${LOGIN_CHROME_ENTRY}?kind=${kind}`;
}

/**
 * 地址 → kind。**认不出的 kind 一律 `null`**（界面渲染空壳，而不是猜一个控件出来）：
 * 这个页面的来源带着 `core_login_chrome` 的调用资格，多渲染一个控件就是多一个不该有的按钮。
 */
export function chromeKindOf(search) {
  const raw = typeof search === "string" ? search : "";
  const query = raw.startsWith("?") ? raw.slice(1) : raw;
  const value = new URLSearchParams(query).get("kind");
  return LOGIN_CHROME_KINDS.includes(value) ? value : null;
}
