/**
 * 播放栏 / 沉浸页的「桌面歌词 / 任务栏歌词」快捷开关，以及沉浸页顶部中央的收起按钮。
 * 语义只有一份（lyricsToggleView）；待定意图只有一个主人，第二次点击必须取反；失败在发起面给可操作的话；没有 binding 时不渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 只扫代码，不扫注释（注释里写"右上角"是说明文字）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const COMPONENTS = "src/renderer/components.tsx";
const STAGE = "src/renderer/playback-stage.tsx";
const APP = "src/renderer/App.tsx";
const HOOK = "src/renderer/use-lyrics-window.ts";

const outDir = resolve(".tmp/r45c-toggle");
await mkdir(outDir, { recursive: true });
const bundle = async (name, source) => {
  const path = resolve(outDir, `${name}.mjs`);
  await build({
    stdin: { contents: source, resolveDir: repoRoot, loader: "tsx" },
    outfile: path,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    packages: "external",
    logLevel: "warning",
  });
  return import(pathToFileURL(path).href);
};

/** 显式 deferred：测试要精确控制"回执什么时候回来"。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("R45C 语义：状态取 requestedVisible ?? visible，标签随模式", async () => {
  const { lyricsToggleView } = await bundle("toggle-view", `export { lyricsToggleView } from "./src/renderer/components.tsx";`);
  const binding = (config, extra = {}) => ({ config: { mode: "desktop", ...config }, visible: false, setVisible() {}, ...extra });

  assert.deepEqual(lyricsToggleView(binding({})), { on: false, mode: "desktop", label: "显示桌面歌词" });
  assert.deepEqual(lyricsToggleView(binding({}, { visible: true })), { on: true, mode: "desktop", label: "隐藏桌面歌词" });
  assert.deepEqual(lyricsToggleView(binding({ mode: "taskbar" })), { on: false, mode: "taskbar", label: "显示任务栏歌词" });
  assert.deepEqual(lyricsToggleView(binding({ mode: "taskbar" }, { visible: true })), { on: true, mode: "taskbar", label: "隐藏任务栏歌词" });

  // requestedVisible 是"我们请求它开着"，比宿主回执更早、更准（点下去那一刻就该翻状态）
  assert.deepEqual(lyricsToggleView(binding({}, { visible: false, requestedVisible: true })), { on: true, mode: "desktop", label: "隐藏桌面歌词" });
  assert.deepEqual(lyricsToggleView(binding({}, { visible: true, requestedVisible: false })), { on: false, mode: "desktop", label: "显示桌面歌词" });

  // 没有 binding = 没有语义（调用点据此不渲染），而不是"假装它是关着的"
  assert.equal(lyricsToggleView(null), null);
  assert.equal(lyricsToggleView(undefined), null);
  assert.equal(lyricsToggleView(binding({ mode: "floating" })).label, "显示桌面歌词", "认不出的模式按桌面说");
});

test("R45C 待定意图：迟到的回执之前再点一次必须取反（不是重复发 true）", async () => {
  const { createLyricsToggleIntent } = await import(
    pathToFileURL(resolve(repoRoot, "src/renderer/features/lyrics/lyrics-toggle-intent.mjs")).href
  );

  const sent = [];
  const gates = [];
  const seen = [];
  const intent = createLyricsToggleIntent({
    send: (target) => {
      sent.push(target);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    onChange: (snapshot) => seen.push({ ...snapshot }),
  });

  const first = intent.request(true);
  // **同一个任务里**再点一次：渲染还没来得及把新状态交回按钮，意图机必须自己取反
  const second = intent.request(false);
  assert.deepEqual(sent, [true, false], "第二次点击取反待定目标，不重复提交同一个 true");
  assert.equal(intent.snapshot().pending, false, "待定目标是最后那一次点击的意图");

  gates[0].resolve({ visible: true });
  await first;
  assert.equal(intent.snapshot().pending, false, "旧回执不许把新意图清掉");

  gates[1].resolve({ visible: false });
  await second;
  assert.equal(intent.snapshot().pending, null, "最后那一次回执到了才清掉待定目标");
  assert.equal(intent.snapshot().error, null);
  assert.ok(seen.length >= 3, "每次意图变化都要通知界面（按钮状态跟着待定目标走）");
});

test("R45C 失败：一句可操作的话（原因/下一步）、重试能恢复、能关掉", async () => {
  const { createLyricsToggleIntent, toggleFailureText } = await import(
    pathToFileURL(resolve(repoRoot, "src/renderer/features/lyrics/lyrics-toggle-intent.mjs")).href
  );

  let refuse = true;
  const sent = [];
  const intent = createLyricsToggleIntent({
    send: async (target) => {
      sent.push(target);
      if (refuse) {
        refuse = false;
        throw { kind: "internal", message: "宿主原始错误：不得出现在界面文案里" };
      }
      return { visible: target };
    },
  });

  await intent.request(true, "player-bar");
  const failed = intent.snapshot();
  assert.equal(failed.pending, null, "失败之后不留下一个永远待定的开关");
  assert.equal(failed.surface, "player-bar", "记住是哪一面按的（失败只印在那一面）");
  assert.equal(typeof failed.error, "string");
  assert.match(failed.error, /桌面歌词/, "说清是哪个歌词（模式）");
  assert.match(failed.error, /重试/, "给下一步：重试");
  assert.match(failed.error, /设置页/, "仍然失败时的下一步");
  assert.doesNotMatch(failed.error, /宿主原始错误/, "原始错误只进日志，不糊到界面");

  await intent.retry();
  assert.deepEqual(sent, [true, true], "重试只重发最后那一个意图");
  assert.equal(intent.snapshot().error, null, "重试成功后提示消失");
  assert.equal(intent.snapshot().pending, null);
  assert.equal(intent.snapshot().surface, null, "成功之后不再挂着某一面");

  // 关掉提示：不再有 error，也不发任何命令
  refuse = true;
  await intent.request(false);
  assert.notEqual(intent.snapshot().error, null);
  const before = sent.length;
  intent.dismiss();
  assert.equal(intent.snapshot().error, null, "用户可以直接关掉这句话");
  assert.equal(sent.length, before, "关掉提示不是重试");

  // 模式说清楚：任务栏那句不能还在说桌面歌词
  assert.match(toggleFailureText(true, "taskbar"), /任务栏歌词/);
  assert.match(toggleFailureText(false, "desktop"), /关上/);
  assert.doesNotMatch(toggleFailureText(true, "taskbar"), /桌面歌词/);
});

test("R46 播放栏：传输组回到 模式→上一首→播放→下一首，歌词开关搬到尾部工具区；没有 lyrics 就不渲染", async () => {
  const { render } = await bundle("bar", `
    import { renderToStaticMarkup } from "react-dom/server";
    import { PlayerBar } from "./src/renderer/components.tsx";
    import { createPlayer } from "./src/renderer/features/playback/player.mjs";

    export function render(lyrics) {
      const player = createPlayer({
        audio: { setSource() {}, play: async () => {}, pause() {}, setCurrentTime() {}, setVolume() {}, setMuted() {}, on: () => () => {} },
        resolveUrl: async () => ({}),
        guardUrl: () => null,
      });
      player.setQueue([{ id: "1", name: "真实标题", artists: "艺人" }]);
      const state = player.snapshot();
      return renderToStaticMarkup(<PlayerBar runtime={{ player }} state={state} onOpenStage={() => {}} lyrics={lyrics} />);
    }`);

  const binding = (config = {}, extra = {}) => ({ config: { mode: "desktop", ...config }, visible: false, requestedVisible: false, setVisible() {}, toggleVisible() {}, ...extra });

  for (const absent of [undefined, null]) {
    const markup = render(absent);
    assert.doesNotMatch(markup, /player-lyrics-toggle|桌面歌词|任务栏歌词/, "没有 lyrics binding 时开关不渲染（不做死按钮）");
  }

  const desktop = render(binding({}, { visible: true, requestedVisible: true }));
  const toggle = desktop.match(/<button[^>]*data-testid="player-lyrics-toggle"[^>]*>/)?.[0];
  assert.ok(toggle, "播放栏要有这枚开关（测试锚点 player-lyrics-toggle）");
  assert.match(toggle, /aria-label="隐藏桌面歌词"/, "状态来自 requestedVisible ?? visible");
  assert.match(toggle, /aria-pressed="true"/, "开着的状态要可读（不是只有颜色）");
  assert.match(desktop, /lucide-captions/, "图标是 lucide 的 Captions（不自绘）");

  /** 传输组恢复常规顺序 —— 模式 → 上一首 → 播放 → 下一首；歌词开关挪到尾部工具区（player-bar-trailing），不再劈开传输控件。 */
  const transportAt = desktop.indexOf('data-testid="player-controls"');
  const trailingAt = desktop.indexOf('data-testid="player-bar-trailing"');
  const toggleAt = desktop.indexOf('data-testid="player-lyrics-toggle"');
  const trailingCloseAt = desktop.indexOf("</div>", toggleAt);
  assert.ok(transportAt > -1 && trailingAt > -1 && toggleAt > -1, "传输组 / 尾部工具区 / 开关三个锚点都要在标记里");
  const transport = desktop.slice(transportAt, trailingAt);
  const modeAt = transport.indexOf('aria-label="播放模式：');
  const previousAt = transport.indexOf('aria-label="上一首"');
  const playAt = transport.indexOf('aria-label="播放"');
  const nextAt = transport.indexOf('aria-label="下一首"');
  assert.ok(modeAt > -1 && previousAt > -1 && playAt > -1 && nextAt > -1, "传输组里要能找到 模式/上一首/播放/下一首");
  assert.ok(modeAt < previousAt && previousAt < playAt && playAt < nextAt,
    "传输组的 DOM 顺序必须是 模式 → 上一首 → 播放 → 下一首（R46：歌词开关不再插在中间）");
  assert.equal(transport.includes("player-lyrics-toggle"), false, "传输组里不许再有歌词开关（它已搬走）");
  assert.ok(toggleAt > trailingAt, "开关挂在尾部工具区（`player-bar-trailing`）里");
  assert.ok(trailingCloseAt > toggleAt, "开关在尾部工具区的标签之内（不是跟在它后面）");

  const taskbar = render(binding({ mode: "taskbar" }));
  assert.match(taskbar, /aria-label="显示任务栏歌词"/, "任务栏模式的标签说的是任务栏歌词");
  assert.match(taskbar, /aria-pressed="false"/, "关着时 pressed 为 false");

  // 失败时：在**发起面**就有一句话 + 重试 + 关掉；不是只留在 console/设置页
  const failed = render(binding({}, {
    toggleErrorSurface: "player-bar",
    toggleError: "桌面歌词没能打开：宿主没有确认这次操作。请点「重试」再发一次；仍然失败时到设置页确认歌词窗可用。",
    retryToggle() {}, dismissToggleError() {},
  }));
  assert.match(failed, /data-testid="lyrics-toggle-error"/, "播放栏要有这句失败提示（发起面）");
  assert.match(failed, /宿主没有确认这次操作/, "原因说清楚");
  assert.match(failed, /data-testid="lyrics-toggle-retry"/, "有重试");
  assert.match(failed, /data-testid="lyrics-toggle-dismiss"/, "能关掉");
  assert.equal(render(binding({})).includes("lyrics-toggle-error"), false, "没失败时不出现这句提示");

  // 同一个失败只印一处：从沉浸页发起的那次不在播放栏里再冒一遍；
  // 从设置页/别处发起的（surface = null）由这条常驻的播放栏兜住，不会只剩日志。
  const elsewhere = render(binding({}, {
    toggleErrorSurface: "playback-stage",
    toggleError: "桌面歌词没能打开：宿主没有确认这次操作。请点「重试」再发一次；仍然失败时到设置页确认歌词窗可用。",
    retryToggle() {}, dismissToggleError() {},
  }));
  assert.equal(elsewhere.includes("lyrics-toggle-error"), false, "发起面在沉浸页时，播放栏不重复同一句话");
  const fromSettings = render(binding({}, {
    toggleErrorSurface: null,
    toggleError: "桌面歌词没能关上：宿主没有确认这次操作。请点「重试」再发一次；仍然失败时到设置页关闭桌面歌词。",
    retryToggle() {}, dismissToggleError() {},
  }));
  assert.match(fromSettings, /data-testid="lyrics-toggle-error"/, "非播放面发起的失败也由常驻播放栏说，不只写日志");
});

test("R45C 播放栏/沉浸页：一次点击只发一次 toggle，且不自建运行时", () => {
  const components = stripComments(read(COMPONENTS));
  const stage = stripComments(read(STAGE));
  const hook = stripComments(read(HOOK));

  for (const [relative, source] of [[COMPONENTS, components], [STAGE, stage]]) {
    assert.match(source, /lyricsToggleView\(lyrics\)/, `${relative} 的标签/状态必须来自唯一语义（lyricsToggleView）`);
    assert.equal(
      [...source.matchAll(/\.toggleVisible\(/g)].length,
      1,
      `${relative} 的点击只转一次 toggleVisible（意图机是唯一主人）`,
    );
    assert.equal(
      [...source.matchAll(/\.setVisible\(/g)].length,
      0,
      `${relative} 不许自己算目标态（渲染快照里的"下一页"在同一次任务里可能是旧的）`,
    );
  }
  assert.match(stage, /<MediaButton[^>]*aria-label=\{lyricsView\.label\}/, "沉浸页那枚开关是官方 MediaButton");
  assert.equal([...stage.matchAll(/lyricsView === null \? null :/g)].length, 1, "没有 binding 时不在沉浸页渲染它");
  assert.equal([...components.matchAll(/lyricsView === null \? null :/g)].length, 1, "播放栏同理");

  for (const [relative, source] of [[COMPONENTS, components], [STAGE, stage]]) {
    assert.doesNotMatch(source, /createLyricsBridge|new PlayerRuntime|getLyricsBridge\(/, `${relative} 不新建歌词运行时/桥（那是单例）`);
  }

  // 失败提示：两个发起面都要有，且同一个失败只印在发起面（不额外弹 toast）
  assert.match(components, /data-testid="lyrics-toggle-error"/);
  assert.match(stage, /data-testid="stage-lyrics-toggle-error"/);
  assert.match(components, /lyrics\.toggleErrorSurface !== "playback-stage"/, "播放栏不重复沉浸页发起的那次失败");
  assert.match(stage, /lyrics\.toggleErrorSurface === "playback-stage"/, "沉浸页只认自己发起的那次失败");
  for (const source of [components, stage]) {
    assert.match(source, /lyrics\?\.retryToggle\?\.\(\)/);
    assert.match(source, /lyrics\?\.dismissToggleError\?\.\(\)/);
    assert.doesNotMatch(source, /sonner|toast\(/, "失败不许再弹一条 toast（同一件事只在一个地方说）");
  }

  // 待定意图的主人只有 hook 里那一个（桥的开关只有一个发送点）
  assert.match(hook, /createLyricsToggleIntent/, "hook 用唯一意图机");
  assert.match(hook, /toggleState\.pending \?\?/, "binding 投影的 requestedVisible 让待定目标优先于权威回执");
  assert.equal([...hook.matchAll(/bridge\.setVisible\(/g)].length, 1, "桥的开关只有一处发送");
  assert.match(hook, /toggleError: toggleState\.error/, "失败经 binding 交给发起面");
  assert.match(hook, /toggleErrorSurface/, "失败发生在哪一面也经 binding 交出去");
  assert.match(hook, /intent\.snapshot\(\)/, "取反读意图机自己的待定目标（渲染闭包在同一次任务里是旧的）");
  assert.match(hook, /toggleVisible/, "取反由意图机决定，不由渲染快照决定");
});

/** 沉浸页的传输组只放传输控件：歌词开关与音量/静音/播放模式同档（MediaButton size-8、图标 size-4），挂在下方工具行尾部。 */
test("R50 沉浸页：传输组只剩 上一首→播放→下一首，歌词开关移到工具行（size-8 / 图标 size-4）", () => {
  const stage = stripComments(read(STAGE));
  const TRANSPORT = 'className="flex items-center justify-evenly"';
  const TOOLS = 'className="flex items-center gap-2"';
  const transportAt = stage.indexOf(TRANSPORT);
  const toolsAt = stage.indexOf(TOOLS);
  assert.ok(transportAt > -1 && toolsAt > -1 && toolsAt > transportAt, "先传输组、后工具行（两段都在，顺序是契约）");

  const transport = stage.slice(transportAt, toolsAt);
  const previousAt = transport.indexOf('aria-label="上一首"');
  const playAt = transport.indexOf('aria-label={playing ? "暂停" : "播放"}');
  const nextAt = transport.indexOf('aria-label="下一首"');
  assert.ok(previousAt > -1 && playAt > -1 && nextAt > -1, "传输组里要能找到 上一首/播放/下一首");
  assert.ok(previousAt < playAt && playAt < nextAt, "传输组的 DOM 顺序必须是 上一首 → 播放 → 下一首");
  assert.equal(transport.includes("stage-lyrics-toggle"), false, "歌词开关不许夹在传输组里");
  assert.equal(transport.includes("CaptionsIcon"), false, "传输组里连它的图标都不该出现");

  const toggleAt = stage.indexOf('data-testid="stage-lyrics-toggle"');
  assert.ok(toggleAt > toolsAt, "开关挂在下方的音量/模式工具行里（不是传输行）");
  for (const anchor of [
    'aria-label={state.muted ? "取消静音" : "静音"}',
    'aria-label="音量"',
    'aria-label={`播放模式：',
  ]) {
    const at = stage.indexOf(anchor);
    assert.ok(at > toolsAt && at < toggleAt, `工具行顺序是 静音 → 音量 → 播放模式 → 歌词开关（${anchor} 在开关之前）`);
  }

  const openAt = stage.lastIndexOf("<MediaButton", toggleAt);
  const closeAt = stage.indexOf("/>", toggleAt) + 2;
  const toggleMarkup = stage.slice(openAt, closeAt);
  assert.match(toggleMarkup, /className="size-8 shrink-0"/, "与音量/模式同档：MediaButton size-8");
  assert.match(toggleMarkup, /<CaptionsIcon className="size-4" \/>/, "图标 size-4（不再是传输组的 size-5）");
  assert.doesNotMatch(toggleMarkup, /size-10|size-5/, "不许再借用传输组的尺寸");
  // 语义一个字没变：状态/标签仍只来自 lyricsToggleView，点击仍只转一次 toggleVisible
  assert.match(toggleMarkup, /aria-label=\{lyricsView\.label\}/);
  assert.match(toggleMarkup, /aria-pressed=\{lyricsView\.on\}/);
  assert.match(toggleMarkup, /lyrics\?\.toggleVisible\("playback-stage"\)/);
});

test("R54 沉浸页收起：顶部整行（宽度铺满、箭头居中），不再是中央一小块，ESC 照旧", () => {
  const stage = stripComments(read(STAGE));

  assert.match(
    stage,
    /className="absolute inset-x-0 top-0 h-10 w-full[^"]*"/,
    "收起是顶部整行：左右贴边、只在顶部占一条带（行内任意位置都能点）",
  );
  assert.match(stage, /<Button[\s\S]*?aria-label="收起歌词"/, "收起用 shadcn Button（官方组件，不手写可点 div）");
  assert.match(stage, /aria-label="收起歌词"/, "无障碍名称说清它做什么");
  assert.match(stage, /<ChevronDownIcon/, "图标是 lucide 的 ChevronDown");
  assert.doesNotMatch(stage, /absolute top-2 left-1\/2 -translate-x-1\/2/, "顶部中央那一小块已不再是收起入口");
  assert.doesNotMatch(stage, /<div[^>]*onClick=\{onClose\}/, "可点区域不能是裸 div（键盘/无障碍都要靠按钮）");
  // 叉号只属于「关闭窗口」那枚窗口按钮（关窗口，不是收起沉浸页）；收起入口仍是下拉箭头
  const collapse = stage.match(/<Button[^>]*aria-label="收起歌词"[^>]*>[\s\S]*?<\/Button>/)?.[0] ?? "";
  assert.ok(collapse.includes("<ChevronDownIcon") && !collapse.includes("XIcon"), "收起入口不用叉号图标");
  assert.equal([...stage.matchAll(/<XIcon\b/g)].length, 1, "叉号只有窗口按钮里的那一枚");
  const closeWindowAt = stage.indexOf('aria-label="关闭窗口"');
  assert.ok(closeWindowAt > 0 && stage.indexOf("<XIcon") > closeWindowAt, "叉号是「关闭窗口」按钮的图标");
  assert.match(stage, /"Escape"/, "ESC 关闭保留（键盘用户不该只剩鼠标一条路）");
  assert.match(stage, /\[role="dialog"\], \[role="alertdialog"\], \[role="menu"\]/, "上层弹窗打开时 ESC 先关弹窗");
});

test("R45C 外壳：同一份 lyrics binding 交给播放栏与沉浸页（不存在第二份状态）", () => {
  const app = stripComments(read(APP));
  assert.match(app, /useLyricsWindow\(runtime, playback\)/, "binding 仍来自唯一 hook");
  const bar = app.slice(app.indexOf("<PlayerBar"), app.indexOf("<PlaybackStage"));
  const stage = app.slice(app.indexOf("<PlaybackStage"), app.indexOf("</SidebarProvider>"));
  assert.ok(bar.length > 0 && stage.length > 0, "要能在 App.tsx 里定位两个调用点");
  assert.match(bar, /lyrics=\{lyrics\}/, "播放栏拿到同一个 binding");
  assert.match(stage, /lyrics=\{lyrics\}/, "沉浸页拿到同一个 binding");
});
