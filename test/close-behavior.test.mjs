/**
 * R10 设置页 · 关窗行为（tray / quit）：载荷、越界值、托盘可用性、页面接线。
 *
 * 与 `test/proxy-settings-form.test.mjs` 第 6 节的分工：那边钉**纯函数**的文案与形状，
 * 这里钉**这条链真的接得上**——UI 造的载荷经 core 的 merge 落到文档里，且落下去的就是
 * 用户选的那一项（不是"看起来对"的另一项）。
 *
 * 四条兜底：
 * 1. **枚举只有一份**：UI 的 `CLOSE_BEHAVIORS` 与 core 的 `CLOSE_BEHAVIORS` 逐条相等
 *    （各写一份的后果是"界面上有的选项 core 不认"，报错只在保存时才出现）；
 * 2. **越界值不静默写盘**：UI 侧回落到 `quit`（能真正退出的那一个），core 侧对越界值
 *    结构化报错——两边都不许"尽力猜一个"；
 * 3. **托盘可用性如实**：R11 之前托盘不存在，`TRAY_AVAILABLE` 必须是 `false`，
 *    选了托盘要当场说清"会回退成退出"；
 * 4. **页面不自己拼载荷**：`{closeBehavior: ...}` 这个键只在 `closeBehaviorPatch` 里出现一次。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLOSE_BEHAVIORS,
  TRAY_AVAILABLE,
  closeBehaviorFromSettings,
  closeBehaviorLabel,
  closeBehaviorNotice,
  closeBehaviorPatch,
} from "../src/renderer/features/settings/settings-form.mjs";
import {
  CLOSE_BEHAVIORS as CORE_CLOSE_BEHAVIORS,
  DEFAULT_CLOSE_BEHAVIOR,
  mergeSettings,
  normalizeSettingsDocument,
} from "../src/main/settings.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

const PAGE_FILE = "src/renderer/pages.tsx";
const settingsPageSource = () => {
  const page = read(PAGE_FILE);
  const slice = page.slice(page.indexOf("export function SettingsPage("));
  assert.ok(slice.length > 100, "必须在 pages.tsx 里找到 SettingsPage");
  return slice;
};

test("枚举只有一份：UI 的关窗行为与 core 的逐条相等（各写一份就会漂移）", () => {
  assert.deepEqual([...CLOSE_BEHAVIORS], [...CORE_CLOSE_BEHAVIORS]);
  assert.deepEqual([...CLOSE_BEHAVIORS], ["tray", "quit"]);
  assert.ok(
    CLOSE_BEHAVIORS.includes(DEFAULT_CLOSE_BEHAVIOR),
    "core 的默认值必须在枚举里（否则归一后的文档自己就不合法）",
  );
});

test("往返：UI 选哪一项，落进文档的就是哪一项（经 core 的合并，不靠页面自觉）", () => {
  const empty = normalizeSettingsDocument(null);
  for (const behavior of CLOSE_BEHAVIORS) {
    const saved = mergeSettings(empty, closeBehaviorPatch(behavior));
    assert.equal(saved.data.closeBehavior, behavior, `${behavior} 必须原样落盘`);
    // 再读回来（归一不改变它）：写进去什么，下次打开设置页就是什么
    assert.equal(normalizeSettingsDocument(saved).data.closeBehavior, behavior);
  }
});

test("越界值：UI 回落到 quit（能退出的那个），core 结构化报错——都不猜", () => {
  for (const bad of ["explode", "", null, undefined, 42, {}, "TRAY"]) {
    assert.deepEqual(
      closeBehaviorPatch(bad),
      { closeBehavior: "quit" },
      `认不出的值必须回落到 quit：${JSON.stringify(bad)}`,
    );
  }

  // core 侧同一件事的另一种处理（写路径不替调用方猜）：结构化错误，且一个字节都不写
  assert.throws(
    () => mergeSettings(normalizeSettingsDocument(null), { closeBehavior: "explode" }),
    (error) => {
      assert.equal(error.kind, "invalid_payload");
      assert.match(error.message, /tray/, `错误要列出合法值：${error.message}`);
      return true;
    },
  );
});

test("托盘可用性：R11 之前必须是 false，且选了托盘当场说清会回退成退出", () => {
  assert.equal(
    TRAY_AVAILABLE,
    false,
    "托盘是 R11 的交付：现在写 true 就是在界面上承诺一个不存在的托盘",
  );

  const notice = closeBehaviorNotice("tray", { trayAvailable: TRAY_AVAILABLE });
  assert.match(notice, /托盘/, notice);
  assert.match(notice, /退出/, `要说清回退行为：${notice}`);

  // 选 quit 时不许扯上托盘（用户在问"关窗怎么办"，不是问托盘）
  assert.ok(!/托盘/.test(closeBehaviorNotice("quit", { trayAvailable: false })));
});

test("选项文案：每一项都有非空标签，认不出的值给「退出」那一档", () => {
  for (const behavior of CLOSE_BEHAVIORS) {
    const label = closeBehaviorLabel(behavior);
    assert.equal(typeof label, "string");
    assert.ok(label.trim() !== "", `${behavior} 的选项文案不能是空的`);
    assert.ok(!/敬请期待|即将上线/.test(label), `禁画饼：${label}`);
  }
  assert.equal(closeBehaviorLabel("explode"), closeBehaviorLabel("quit"));
});

test("读取：文档里的值原样显示；认不出就跟 core 的默认一致（不拿我们的兜底当用户的选择）", () => {
  assert.equal(closeBehaviorFromSettings({ data: { closeBehavior: "tray" } }), "tray");
  assert.equal(closeBehaviorFromSettings({ data: { closeBehavior: "quit" } }), "quit");

  for (const broken of [null, undefined, {}, { data: null }, { data: { closeBehavior: "explode" } }]) {
    assert.equal(
      closeBehaviorFromSettings(broken),
      CLOSE_BEHAVIORS[0],
      `认不出的文档跟 core 的默认同口径（枚举第一项）：${JSON.stringify(broken)}`,
    );
  }
  assert.equal(CLOSE_BEHAVIORS[0], "tray", "枚举第一项就是 core 的默认值（这条差异是刻意的，见函数注释）");
});

test("页面接线：载荷只从 closeBehaviorPatch 来，提示只从 closeBehaviorNotice 来", () => {
  const settingsPage = settingsPageSource();

  assert.match(settingsPage, /closeBehaviorPatch\(/, "关窗行为的载荷必须经纯函数（一处真源）");
  assert.match(settingsPage, /closeBehaviorNotice\(/, "托盘可用性提示必须经纯函数");
  assert.match(settingsPage, /TRAY_AVAILABLE/, "可用性来自那个常量（R11 接通时只改一处）");
  assert.doesNotMatch(
    settingsPage,
    /closeBehavior\s*:\s*["']/,
    "页面不许自己拼 {closeBehavior: 'tray'} 这种载荷（枚举与回落规则都在纯函数里）",
  );
  assert.match(settingsPage, /closeBehaviorLabel\(/, "选项文案来自纯逻辑模块（不抄第二份）");
});
