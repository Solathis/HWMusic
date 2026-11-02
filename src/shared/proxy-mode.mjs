// 代理方式与作用范围的唯一归一规则：core 与渲染层都从这里取，Rust 的 webview_proxy.rs 逐条照写并由测试互钉。
export const PROXY_MODES = ["off", "system", "custom"];
export const PROXY_SCOPES = ["all", "update"];

/** 原始代理对象 → `{mode, scope}`：缺 mode 时旧文档 `enabled === true` 算 custom、否则 system；缺 scope 时 custom 算 all、否则 update。 */
export function proxyModeAndScope(raw) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const mode = PROXY_MODES.includes(source.mode) ? source.mode : source.enabled === true ? "custom" : "system";
  const scope = PROXY_SCOPES.includes(source.scope) ? source.scope : mode === "custom" ? "all" : "update";
  return { mode, scope };
}
