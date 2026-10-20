/**
 * 登录体验的**浮动控件**（R25 用户四项之 2 与 4）的跨语言契约：入口文件与 kind 字面量。
 *
 * 形态（控制器裁决）：两个小浮动 webview（`login-return` / `login-theme`）浮在官方登录页之上——
 * 左上角是「返回扫码登录」，右上角是「黑白主题 + 系统默认」。它们加载的是**同一个本地页面**，
 * 靠 `?kind=` 决定渲染哪一个控件：
 *
 * ```
 *   login-chrome.html?kind=return     左上：返回扫码登录
 *   login-chrome.html?kind=theme      右上：浅色 / 深色 / 跟随系统
 * ```
 *
 * 为什么是"一个入口 + kind"而不是两个 HTML 入口：两个控件的视觉、主题接线、透明背景、
 * 错误处置完全相同，差别只有渲染哪一棵子树——两个入口会把这些复制两份，
 * 而复制出来的第二份迟早与第一份漂移（R25 的 gate 与浮动控件共用同一个 React 组件是同一理由）。
 *
 * Rust 无法 import .mjs，`src-tauri/src/login.rs` 是刻意的镜像副本：
 * 入口名与两个 kind 字面量由 `test/login-chrome.test.mjs` 扫描源码钉住相等。
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
