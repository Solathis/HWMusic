/**
 * 登录子窗顶部内缩的唯一真源（单位：CSS 像素）。
 *
 * 用途：官方登录页铺在引导页正文位置，子窗顶部要让出一条"取消/关闭"条，正文不许被它盖住。
 * 消费方（R7）：`src-tauri/src/login.rs` 的 `huawei.ts` 与渲染层**双侧 import 本模块**，
 * 任何一侧都不得再写第二份字面量（`test/login-parity.test.mjs` 扫描源码钉住这一点）。
 *
 * 只导出数字：不要在本模块里派生 "48px" 之类的字符串副本，否则"唯一字面量"约束会被绕过。
 */
export const LOGIN_VIEW_TOP_INSET = 48;
