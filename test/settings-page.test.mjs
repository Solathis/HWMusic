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

test("关窗选择保存：写入期间禁用并按真实回执重建选择，失败回滚", () => {
  const source = settingsPageSource();
  const handler = source.slice(source.indexOf("async function chooseCloseBehavior("), source.indexOf("async function applyAutostart("));
  assert.match(handler, /setSaving\(true\)/);
  assert.match(handler, /const answer = await coreCall<SettingsAnswer>\(SETTINGS_SET/);
  assert.match(handler, /setCloseBehavior\(closeBehaviorFromSettings\(answer.settings\)\)/);
  assert.match(handler, /catch[\s\S]*setCloseBehavior\(previous\)/);
  assert.match(handler, /finally\s*\{\s*setSaving\(false\)/);
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

test("设置 Select 调用点：popper/start/4 + SelectGroup，触发器响应式，不改选中语义", () => {
  const source = settingsPageSource();
  const contents = [...source.matchAll(/<SelectContent\b([^>]*)>([\s\S]*?)<\/SelectContent>/g)];
  // R52（有意更改）：7 → 3。字号/颜色/方向/样式四个下拉搬进 R51 的桌面歌词外观弹出窗，
  // 设置页只剩关窗行为、主题、窗口位置这三处。
  assert.equal(contents.length, 3, "关窗、主题、歌词窗口位置三处");
  for (const [, props, body] of contents) {
    assert.match(props, /position="popper"/, "弹层不能 item-aligned 盖住 trigger");
    assert.match(props, /align="start"/);
    assert.match(props, /sideOffset=\{4\}/);
    assert.match(body, /^\s*<SelectGroup>[\s\S]*<SelectItem[\s\S]*<\/SelectGroup>\s*$/, "选项包在 SelectGroup 里（与其它下拉同一条纪律）");
  }
  const triggers = [...source.matchAll(/<SelectTrigger\b[^>]*className="([^"]+)"/g)];
  assert.equal(triggers.length, 3);
  for (const [, classes] of triggers) assert.match(classes, /\bw-full max-w-xs\b/);
  assert.doesNotMatch(source, /aria-selected|data-state=\{/, "选中态交给 Radix，不根据焦点伪造 aria");
});

test("保存中禁用：写盘期间按钮不可重复点（一次点击 = 一次写入）", () => {
  const source = settingsPageSource();
  assert.match(source, /disabled=\{/, "保存/测试/自启开关都要有禁用态");
  assert.match(source, /saving|busy|pending/, "要有进行中的状态（否则用户只能靠再点一次判断）");
});

// ---------------------------------------------------------------------------
// R41：歌词缓存卡（挂点，不是二级分类——那是第二波）
// ---------------------------------------------------------------------------

test("歌词缓存卡（R41）：挂在设置页里，且与「桌面歌词」卡同一个 lyrics 绑定", () => {
  const source = settingsPageSource();
  assert.match(read("src/renderer/pages.tsx"), /from\s+"\.\/lyrics-cache-card\.tsx"/, "卡片是独立组件（设置页不继续膨胀）");
  assert.match(source, /<LyricsCacheCard lyrics=\{lyrics\}\s*\/>/, "挂点：把外壳交下来的 lyrics 绑定传进去");
});

// ---------------------------------------------------------------------------
// R41b：二级分类（单页 Tabs，不新开视图）
// ---------------------------------------------------------------------------

/** 取某个标签页那一段（从它的开头到下一个 `</TabsContent>`）。 */
function paneSource(source, id) {
  const start = source.indexOf(`<TabsContent value="${id}"`);
  assert.ok(start > -1, `要能找到 ${id} 这个标签页`);
  const end = source.indexOf("</TabsContent>", start);
  assert.ok(end > start, `${id} 页没有收口`);
  return source.slice(start, end);
}

test("R41b 二级分类：四个标签页，trigger 与 content 的值都来自 SETTINGS_TABS", () => {
  const page = read("src/renderer/pages.tsx");
  const source = settingsPageSource();

  // trigger 与 content 各写一个字面量就会出现"点了标签、内容区是空的"（radix 只认 value 相等）
  assert.match(page, /export const SETTINGS_TABS = \[/, "分类表要有名字（trigger 与 content 的唯一真源）");
  assert.match(source, /SETTINGS_TABS\.map\(\(tab\) =>/, "标签按钮由那张表生成");
  assert.match(source, /value=\{tab\.id\}/, "trigger 的值来自那张表");
  assert.match(source, /defaultValue=\{SETTINGS_TABS\[0\]\.id\}/, "默认停在第一类（通用）");

  const ids = [...page.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)" \}/g)].map((found) => [found[1], found[2]]);
  assert.deepEqual(
    ids,
    [
      ["general", "通用"],
      ["network", "网络"],
      ["lyrics", "歌词"],
      ["log", "日志"],
    ],
    "四个分类与文案（文案要克制：两三个字，不带句号）",
  );
  assert.ok(ids.every(([, label]) => label.length >= 2 && label.length <= 3), "标签文案不许长过三个字");
  for (const [id] of ids) paneSource(source, id); // 每个 id 都要有对应的 content
});

test("R41b 二级分类：卡片各归其类（只搬家，卡内一个字没改）", () => {
  const source = settingsPageSource();
  const panes = {
    general: paneSource(source, "general"),
    network: paneSource(source, "network"),
    lyrics: paneSource(source, "lyrics"),
    log: paneSource(source, "log"),
  };

  // 通用：关窗行为 / 开机自启 / 外观 / 播放队列
  for (const title of ["关窗行为", "开机自启", "外观", "播放队列"]) {
    assert.ok(panes.general.includes(`<CardTitle>${title}</CardTitle>`), `通用页要有「${title}」`);
  }
  // 网络：代理（连不上网时才会来看的那一类）
  assert.ok(panes.network.includes("<CardTitle>网络与代理</CardTitle>"), "网络页是代理表单");
  assert.ok(panes.network.includes("proxy-enabled"), "代理开关还在那一页里（搬家不改内部）");
  // 歌词：桌面歌词窗 + 歌词缓存/导入（同一件事的两半）
  assert.ok(panes.lyrics.includes("<CardTitle>桌面歌词</CardTitle>"), "歌词页有桌面歌词卡");
  assert.ok(panes.lyrics.includes("<LyricsCacheCard lyrics={lyrics} />"), "歌词缓存卡与它同一页（R41 的挂点跟着搬）");
  // 日志：只读的诊断面板（不是设置项），所以它单独一类
  assert.ok(panes.log.includes("<CardTitle>运行日志</CardTitle>"), "日志单独成一类");
  assert.ok(panes.log.includes("<LogTerminal"), "日志终端在那一页里");
  assert.doesNotMatch(panes.general, /LogTerminal/, "通用页里不许还留着日志终端（挂两处等于两处要同步）");

  // 每一张卡都只出现一次（"搬家"不是"复制"）
  for (const title of ["关窗行为", "开机自启", "外观", "播放队列", "网络与代理", "桌面歌词", "运行日志"]) {
    const seen = source.split(`<CardTitle>${title}</CardTitle>`).length - 1;
    assert.equal(seen, 1, `「${title}」只该有一处定义`);
  }
});

test("R41b 二级分类：失败/提示那两行留在标签页之上（页面级）", () => {
  const source = settingsPageSource();
  const tabsAt = source.indexOf('data-testid="settings-tabs"');
  const failureAt = source.indexOf('role="alert"');
  const noticeAt = source.indexOf('role="status"');
  assert.ok(tabsAt > -1, "要能找到 Tabs 容器");
  assert.ok(failureAt > -1 && failureAt < tabsAt, "失败那行在标签页之上（它是「刚才那次保存」的结果，藏进某一页就看不见了）");
  assert.ok(noticeAt > -1 && noticeAt < tabsAt, "提示那行同理");
});

test("R41b 外观卡：三态 Select 与左下角那枚图标按钮同一份接线", () => {
  const source = settingsPageSource();
  const pane = paneSource(source, "general");
  assert.match(pane, /<CardTitle>外观<\/CardTitle>/, "外观卡在通用页里");
  assert.match(pane, /<Select value=\{themeChoice\}/, "三态是受控 Select");
  assert.match(pane, /themeLabel\(themeChoice\)/, "标签直接写进 SelectValue（radix 没展开过内容时拿不到选项文案）");
  assert.match(pane, /THEME_CHOICES\.map/, "三个档位来自 theme.mjs 的唯一真源");
  assert.match(source, /const \{ choice: themeChoice, select: selectTheme \} = useThemeChoice\(\)/, "状态与写入口来自那一份接线");
  assert.doesNotMatch(source, /APPEARANCE_NOTICE_TEXT[^}]*手动切换/, "外观说明不许再写「不提供手动切换」（R25 起就不是事实了）");
});

test("歌词缓存卡（R41）：文件选择用系统标准控件；清缓存要确认；本地导入默认不删", () => {
  const card = read("src/renderer/lyrics-cache-card.tsx");
  // 零 Rust / 零 capability：渲染层的标准文件输入
  assert.match(card, /type="file"/, "文件选择用系统标准控件");
  assert.match(card, /accept=\{LYRICS_IMPORT_ACCEPT\}/, "accept 来自常量（.lrc,.txt，与文案同一处真源）");
  assert.doesNotMatch(card, /invoke\(|coreCall\(/, "卡片自己不调 IPC：走 getLyricsBridge（频道常量只在共享真源里）");
  // 删用户的文件要确认，而且默认不删
  assert.match(card, /<AlertDialog/, "清除要有确认框（尤其勾上「连本地导入一起清」时）");
  assert.match(card, /useState\(false\)/, "「连本地导入一起清」默认关（删用户的文件不是默认行为）");
  assert.match(card, /withLocal[\s\S]{0,120}会删掉在线缓存与你自己导入的歌词文件/, "确认框要说清这一次到底删什么");
  // 没有当前曲目就不给导入，并说清原因
  assert.match(card, /canImport/, "导入入口要有可用性判定（没有正在播放的曲目时禁用）");
  assert.match(card, /先播一首，再导入歌词/, "禁用不是终点：要告诉用户下一步");
  // 占用读不到就说读不到（不显示 0 条那种假数字；三种状态由纯函数分开）
  assert.match(card, /lyricsCacheSizeText\(info, \{ failed: infoFailed \}\)/, "占用文案来自纯函数（不可用/读不到那两档由它兜住）");
  assert.match(card, /setInfoFailed\(true\)/, "调用失败要落'读不到'那一档（不许说成'没有数据目录'）");
});
