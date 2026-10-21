/**
 * R10 设置页 · 页面接线（源码扫描）。
 *
 * 令牌/自绘那两条硬约束在 R8 的两个扫描文件里（theme-tokens / no-self-visual），这里只管
 * **设置页特有**的接线，全是"看起来能用、其实在撒谎"的地方：
 *
 * 1. 读设置走 `settings:get` 一次（不是每次渲染都打一趟）；
 * 2. 保存走 `settings:set` 的 `{patch}`，且 patch 由纯函数造；恢复默认只回默认**代理**
 *    （`{patch:{proxy:null}}`，不是整份 reset——那会把关窗行为一起打回默认，用户没要求）；
 * 3. 测试连接走新频道 `settings:test-proxy`，载荷就是表单当前的草稿（不是已保存的旧值：
 *    用户点"测试连接"是想知道**刚填的**这组能不能通）；
 * 4. 失败文案来自 `settingsFailureText`（不是库页面的 `libraryFailureText`：设置失败要能说
 *    "没保存"，库页面那句是"加载失败"）；
 * 5. 队列**只读**：不出现任何队列管理动作（播放/清空/跳转），也不直接渲染 QueuePanel；
 * 6. 保存中按钮禁用（重复点击 = 写两次盘）。
 *
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

function settingsPageSource() {
  const page = read("src/renderer/pages.tsx");
  const slice = page.slice(page.indexOf("export function SettingsPage("));
  assert.ok(slice.length > 100, "必须在 pages.tsx 里找到 SettingsPage");
  return slice;
}

test("组合原语：设置页用 shadcn 的 Switch / Input / Label / Button / Card / Select", () => {
  // 导入在文件顶部（不在 SettingsPage 那一段里），所以查整份文件；用法查那一段
  const page = read("src/renderer/pages.tsx");
  const source = settingsPageSource();
  for (const [primitive, usage] of [
    ["switch", "<Switch"],
    ["input", "<Input"],
    ["label", "<Label"],
    ["card", "<Card"],
    ["button", "<Button"],
    ["select", "<Select"],
  ]) {
    assert.match(page, new RegExp(`from\\s+"\\./components/ui/${primitive}"`), `导入 shadcn 的 ${primitive} 原语`);
    assert.ok(source.includes(usage), `设置页要真的用上 ${usage}（导入但不用 = 死代码）`);
  }
  assert.doesNotMatch(source, /<(?:input|select|button)\b/, "不许拿裸标签拼输入控件");
});

test("频道：全部来自共享常量（不写字面量，channel-parity 已管反漂移）", () => {
  const page = read("src/renderer/pages.tsx");
  for (const constant of [
    "SETTINGS_GET",
    "SETTINGS_SET",
    "SETTINGS_TEST_PROXY",
  ]) {
    assert.match(page, new RegExp(`\\b${constant}\\b`), `设置页要用共享常量 ${constant}`);
  }
  assert.match(page, /from\s+"\.\.\/shared\/request-channels\.ts"/, "频道常量从共享真源导入");
  // R38：`AUTH_LOGOUT` **不再**出现在设置页——退出搬到左下角账号区（App 的 SidebarFooter），
  // 唯一实现收在 host-api 的 `coreLogout`（那一份由 proxy-settings-form.test.mjs 钉住）。
  assert.doesNotMatch(page, /AUTH_LOGOUT/, "设置页不再直接摸退出频道（那一块已删）");
});

test("读取：settings:get 只打一次（挂载时），不是每次渲染一趟", () => {
  const source = settingsPageSource();
  assert.match(source, /coreCall<[^>]*>\(\s*SETTINGS_GET/, "设置要经 coreCall 读一次");
  assert.match(source, /useEffect\(/, "读取发生在 effect 里（挂载一次）");
});

test("保存：{patch} 由纯函数造；恢复默认只回默认代理", () => {
  const source = settingsPageSource();
  assert.match(source, /proxyPatchFromForm\(/, "保存载荷必须经纯函数（清洗与形状只有一处）");
  assert.match(source, /coreCall<[^>]*>\(\s*SETTINGS_SET/, "保存走 settings:set");
  assert.match(source, /\{\s*patch\s*:/, "载荷形状是 {patch:{...}}（settings:set 的契约）");
  assert.match(source, /proxySaveNotice\(/, "保存回执要按 restartRequired 如实说明");
  assert.match(
    source,
    /patch:\s*\{\s*proxy:\s*null\s*\}/,
    "恢复默认只回默认代理（整份 reset 会连关窗行为一起打回默认）",
  );
});

test("测试连接：载荷是表单当前的草稿（不是已保存的旧值），结果显示克制且不回显凭据", () => {
  const source = settingsPageSource();
  assert.match(source, /coreCall<[^>]*>\(\s*SETTINGS_TEST_PROXY/, "测试连接走 settings:test-proxy");
  assert.match(source, /proxyTestResultText\(/, "结论文案来自纯函数（成功给耗时、失败给原因+下一步）");
  assert.doesNotMatch(source, /key=\{?[^}]*password/i, "不许拿密码当 React key（那是把它写进 DOM 属性）");
});

test("失败文案：设置失败用设置那一档（不是库页面的「加载失败」）", () => {
  const source = settingsPageSource();
  assert.match(source, /settingsFailureText\(/, "设置页的失败文案来自 settings-form.mjs");
  assert.doesNotMatch(source, /libraryFailureText\(/, "库页面的失败文案不适用（那是「加载失败」，这里是「没保存」）");
});

test("队列只读：显示长度与当前曲，不给任何队列管理动作", () => {
  const source = settingsPageSource();
  assert.match(source, /queueSummary\(/, "队列摘要来自纯函数");
  assert.match(source, /queueSummaryText\(/, "摘要文案来自纯函数（空队列给下一步）");
  for (const forbidden of ["QueuePanel", "playQueue(", "playAt(", "playNext(", "clear()"]) {
    assert.ok(
      !source.includes(forbidden),
      `队列在设置页是只读的，不许出现 ${forbidden}（管理队列有专门的播放队列面板）`,
    );
  }
});

test("关窗行为下拉：受控值 + 自绘标签（radix 在内容没展开过时拿不到选项文案）", () => {
  const source = settingsPageSource();
  // 真缺陷（一次性 SSR 冒烟抓到的）：`<SelectValue />` 空着时，触发器要等选项挂载（= 展开过）
  // 才拿得到文本；受控值 + 内容没展开 → 触发器是空的。把标签写进 SelectValue 才稳定。
  assert.match(
    source,
    /<SelectValue>\{[^}]*closeBehaviorLabel\(/,
    "SelectValue 必须自带标签（空着会在没展开过下拉时显示空白）",
  );
});

test("保存中禁用：写盘期间按钮不可重复点（一次点击 = 一次写入）", () => {
  const source = settingsPageSource();
  assert.match(source, /disabled=\{/, "保存/测试/自启开关都要有禁用态");
  assert.match(source, /saving|busy|pending/, "要有进行中的状态（否则用户只能靠再点一次判断）");
});
