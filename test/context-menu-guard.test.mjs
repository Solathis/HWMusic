/**
 * 默认网页菜单的屏蔽判定：行自己的菜单触发器与可编辑元素放行，其余一律拦掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_MENU_TRIGGER_SLOT,
  GUARDED_ENTRY_FILES,
  UNGUARDED_DOCUMENT_REASON,
  installContextMenuGuard,
  isEditableTarget,
  isMenuTriggerTarget,
  shouldSuppressContextMenu,
} from "../src/renderer/features/shell/context-menu-guard.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** 假目标元素：只给判定真正会读的那几个自有属性。 */
const input = (extra = {}) => ({ tagName: "INPUT", readOnly: false, disabled: false, isContentEditable: false, ...extra });

/** 假的 document：只实现监听注册（判定本身不碰 DOM）。 */
function fakeDocument() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener, options) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.options === options);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

const contextMenuEvent = (target) => ({
  target,
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
});

// ---------------------------------------------------------------------------
// 1. 可编辑判定
// ---------------------------------------------------------------------------

test("可编辑元素放行：非只读的 input / textarea、contenteditable（原生编辑菜单是唯一粘贴路径）", () => {
  assert.equal(isEditableTarget(input()), true, "普通文本框");
  assert.equal(isEditableTarget(input({ tagName: "textarea" })), true, "tagName 大小写不敏感");
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true, "contenteditable 由浏览器算好，不自己看属性");
  assert.equal(shouldSuppressContextMenu(input()), false);
});

test("只读 / 禁用的输入框按不可编辑处理（那时没有可编辑的东西可粘贴）", () => {
  assert.equal(isEditableTarget(input({ readOnly: true })), false, "readOnly 输入框");
  assert.equal(isEditableTarget(input({ disabled: true })), false, "disabled 输入框");
  assert.equal(isEditableTarget({ tagName: "TEXTAREA", readOnly: true }), false);
  assert.equal(shouldSuppressContextMenu(input({ readOnly: true })), true);
});

test("文本 input 放行：type 缺省/空/text/search/url/tel/email/password/number（大小写不敏感）", () => {
  for (const type of [undefined, "", "text", "search", "url", "tel", "email", "password", "number", "TEXT", "Search"]) {
    assert.equal(isEditableTarget(input(type === undefined ? {} : { type })), true, `该放行 type=${String(type)}`);
  }
});

test("非文本 input 一律阻止：取色器上网页菜单一项都用不上（真机上就是它漏出来的）", () => {
  for (const type of ["color", "checkbox", "radio", "range", "file", "button", "submit", "reset", "image", "hidden"]) {
    const target = input({ type });
    assert.equal(isEditableTarget(target), false, `不该放行 type=${type}`);
    assert.equal(shouldSuppressContextMenu(target), true, `该阻止 type=${type}`);
  }
});

test("其余一律阻止：普通元素、表格行、按钮、文本节点、没有 target", () => {
  for (const target of [
    { tagName: "DIV" },
    { tagName: "TR" },
    { tagName: "BUTTON" },
    { tagName: "SPAN", isContentEditable: false },
    { nodeType: 3, parentNode: { tagName: "P" } },
    null,
    undefined,
    "不是节点",
  ]) {
    assert.equal(shouldSuppressContextMenu(target), true, `应阻止：${JSON.stringify(target)}`);
  }
});

// ---------------------------------------------------------------------------
// 1b. 行自己的菜单：这一档必须放行，否则 radix 认为"已有人处理"而不弹菜单
// ---------------------------------------------------------------------------

/** 假元素：带 `getAttribute`（守卫按 radix 的 data-slot 认触发器）。 */
const element = ({ tagName = "DIV", dataSlot = null, parent = null } = {}) => {
  const node = {
    tagName,
    parentNode: parent,
    getAttribute: (name) => (name === "data-slot" ? dataSlot : null),
  };
  node.parentElement = parent;
  return node;
};

test("行触发器（含行内子孙）放行：radix 自己会 preventDefault 再弹菜单", () => {
  const row = element({ tagName: "TR", dataSlot: CONTEXT_MENU_TRIGGER_SLOT });
  const cell = element({ tagName: "TD", parent: row });
  assert.equal(isMenuTriggerTarget(row), true);
  assert.equal(isMenuTriggerTarget(cell), true, "点在单元格上，触发器是它的祖先");
  assert.equal(shouldSuppressContextMenu(cell), false, "这一档不许抢先 preventDefault");
  assert.equal(isMenuTriggerTarget(element({ tagName: "TR" })), false, "普通行不是触发器");
  assert.equal(shouldSuppressContextMenu(element({ tagName: "TR" })), true, "普通行仍要拦掉网页菜单");
});

test("触发器放行不等于可编辑放行：两档各自独立判定", () => {
  const input = element({ tagName: "INPUT" });
  assert.equal(isEditableTarget(input), true);
  assert.equal(isMenuTriggerTarget(input), false);
  assert.equal(isMenuTriggerTarget(null), false);
});

// ---------------------------------------------------------------------------
// 2. 安装/卸载（捕获阶段挂一条，软件里每扇自有窗都装）
// ---------------------------------------------------------------------------

test("安装：document 上挂一条捕获阶段的 contextmenu 监听", () => {
  const doc = fakeDocument();
  installContextMenuGuard(doc);
  assert.equal(doc.listeners.length, 1, "只挂一条");
  assert.equal(doc.listeners[0].type, "contextmenu");
  assert.equal(doc.listeners[0].options, true, "捕获阶段：先于任何行内处理器决定默认行为");
});

test("拦截：普通元素上的 contextmenu 被 preventDefault，输入框上的不动", () => {
  const doc = fakeDocument();
  installContextMenuGuard(doc);
  const listener = doc.listeners[0].listener;

  const onRow = contextMenuEvent({ tagName: "TR" });
  listener(onRow);
  assert.equal(onRow.defaultPrevented, true);

  const onInput = contextMenuEvent(input());
  listener(onInput);
  assert.equal(onInput.defaultPrevented, false, "输入框保留原生编辑菜单");
});

test("卸载：退订之后同一个事件不再被拦（幂等，重复调用不抛）", () => {
  const doc = fakeDocument();
  const uninstall = installContextMenuGuard(doc);
  assert.equal(typeof uninstall, "function");
  uninstall();
  assert.equal(doc.listeners.length, 0);
  const after = contextMenuEvent({ tagName: "TR" });
  assert.equal(after.defaultPrevented, false);
  uninstall();
});

test("没有 document 时安装是空操作（守卫不该让页面起不来）", () => {
  assert.equal(typeof installContextMenuGuard(null), "function", "回一个空退订，不抛");
  assert.equal(typeof installContextMenuGuard(undefined), "function");
});

// ---------------------------------------------------------------------------
// 3. 入口接线（四扇自有窗都装；官方登录页一个字节都不注入）
// ---------------------------------------------------------------------------

test("四扇自有窗都装上守卫：主窗 / 歌词窗 / 歌词设置弹出窗 / 浮动控件", () => {
  assert.deepEqual(
    [...GUARDED_ENTRY_FILES].sort(),
    [
      "src/renderer/login-chrome-main.tsx",
      "src/renderer/lyrics-main.tsx",
      "src/renderer/lyrics-settings-main.tsx",
      "src/renderer/main.tsx",
    ],
    "入口清单写死在这里：多一扇窗要登记，少一扇就等于那扇窗还漏网页菜单",
  );
  for (const relative of GUARDED_ENTRY_FILES) {
    assert.ok(existsSync(`${repoRoot}${relative}`), `${relative} 存在`);
    assert.match(stripComments(read(relative)), /installContextMenuGuard\(\)/, `${relative} 真的装了守卫`);
  }
});

test("官方登录页不注入：宿主侧没有任何 contextmenu 相关代码", () => {
  for (const relative of [
    "src-tauri/src/commands.rs",
    "src-tauri/src/login.rs",
    "src-tauri/src/main.rs",
    "src-tauri/src/lib.rs",
  ]) {
    if (!existsSync(`${repoRoot}${relative}`)) continue;
    assert.doesNotMatch(read(relative), /contextmenu|context_menu/i, `${relative} 不碰第三方页面的右键菜单`);
  }
  const reason = UNGUARDED_DOCUMENT_REASON;
  assert.match(reason, /登录页|第三方/, "把「不注入官方登录页」这条决定写出来");
});

test("守卫模块只被入口与测试引用（不许从组件里顺手再挂一条）", () => {
  const importers = [];
  for (const relative of ["src/renderer/App.tsx", "src/renderer/components.tsx", "src/renderer/pages.tsx"]) {
    if (stripComments(read(relative)).includes("context-menu-guard")) importers.push(relative);
  }
  assert.deepEqual(importers, [], "组件层不装守卫（装一次就够，到处都是会拦掉不该拦的）");
});
