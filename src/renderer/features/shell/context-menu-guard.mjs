/**
 * 自有窗的右键菜单守卫：只留两类放行，其余一律吃掉 WebView2 那套「返回/刷新/检查」。
 * 行自己的菜单交给 radix：这里若抢先 preventDefault()，它的 composeEventHandlers 见到 defaultPrevented 就不再弹菜单。
 * 文本输入与 contenteditable 保留原生编辑菜单（粘贴的唯一路径）。
 */

/** 装守卫的自有窗入口（清单写在这里，测试按它逐个扫）。 */
export const GUARDED_ENTRY_FILES = Object.freeze([
  "src/renderer/main.tsx",
  "src/renderer/lyrics-main.tsx",
  "src/renderer/lyrics-settings-main.tsx",
  "src/renderer/login-chrome-main.tsx",
]);

/** radix ContextMenu 触发器在 DOM 上的标记（生成原语的 `data-slot`）。 */
export const CONTEXT_MENU_TRIGGER_SLOT = "context-menu-trigger";

const TEXT_INPUT_TYPES = Object.freeze(["", "text", "search", "url", "tel", "email", "password", "number"]);
const ANCESTOR_DEPTH = 8;

function walkFrom(target, visit) {
  let current = target;
  for (let depth = 0; current !== null && current !== undefined && depth < ANCESTOR_DEPTH; depth += 1) {
    if (visit(current) === true) return true;
    current = current.parentElement ?? current.parentNode ?? null;
  }
  return false;
}

function nearestElement(target) {
  let found = null;
  walkFrom(target, (node) => {
    if (typeof node.tagName === "string" && node.tagName !== "") {
      found = node;
      return true;
    }
    return false;
  });
  return found;
}

/** 可编辑 = 非只读、非禁用的文本类 input（缺省 type 也算文本）、textarea，或 contenteditable 区域；isContentEditable 由浏览器算好（含祖先继承）。 */
export function isEditableTarget(target) {
  const element = nearestElement(target);
  if (element === null) return false;
  if (element.isContentEditable === true) return true;
  if (element.readOnly === true || element.disabled === true) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
  return TEXT_INPUT_TYPES.includes(type);
}

/** 目标是不是某一行自己的菜单触发器（含它在行内的子孙）。 */
export function isMenuTriggerTarget(target) {
  const element = nearestElement(target);
  if (element === null) return false;
  return walkFrom(element, (node) =>
    typeof node.getAttribute === "function" && node.getAttribute("data-slot") === CONTEXT_MENU_TRIGGER_SLOT);
}

export function shouldSuppressContextMenu(target) {
  return !isEditableTarget(target) && !isMenuTriggerTarget(target);
}

/** 装上守卫；回退订函数（重复调用幂等，没有 document 时是空操作）。 */
export function installContextMenuGuard(doc = typeof document === "undefined" ? null : document) {
  if (doc === null || doc === undefined || typeof doc.addEventListener !== "function") return () => {};
  const listener = (event) => {
    if (shouldSuppressContextMenu(event?.target)) event.preventDefault();
  };
  doc.addEventListener("contextmenu", listener, true);
  return () => {
    if (typeof doc.removeEventListener === "function") doc.removeEventListener("contextmenu", listener, true);
  };
}

/** 「不注入官方登录页」这条决定写在这里（测试按它认，免得只活在报告里）。 */
export const UNGUARDED_DOCUMENT_REASON = "官方华为登录页是独立 webview 里的第三方网页，不为它注入任何脚本";
