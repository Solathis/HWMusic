/**
 * R6 设置 · settings.json 单一真源。
 *
 * 钉住的是"磁盘形状与清洗规则"，不是实现细节：
 * - 坏形状一律"当没配"，绝不猜（端口字符串、非对象 proxy、schemaVersion≠1）；
 * - 凭据原样保留但**绝不出现在日志/错误文案里**；
 * - 写盘原子（临时文件 + rename），未知顶层键原样保留（R10/R11 各自加字段不互相删）；
 * - 认不出的 schemaVersion 不覆盖（宁可不写，也不砸掉新版写的文件）。
 * 临时文件写在仓库内 `.tmp/`（已 gitignore）：本机沙箱拒绝工作区外的写入。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOSE_BEHAVIORS,
  DEFAULT_CLOSE_BEHAVIOR,
  DEFAULT_PROXY,
  SETTINGS_FILE_NAME,
  SETTINGS_SCHEMA_VERSION,
  SettingsStoreError,
  cleanHost,
  cleanPort,
  createSettingsHandlers,
  createSettingsStore,
  normalizeBypass,
  normalizeProxy,
  normalizeSettingsDocument,
} from "../src/main/settings.mjs";
import { CORE_ERROR_KINDS } from "../src/shared/result.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hostCases = JSON.parse(
  await readFile(join(repoRoot, "test", "fixtures", "proxy-host-cases.json"), "utf8"),
);

/** 测试用凭据：刻意是"看起来像 token"的串，用来抓任何漏进日志/错误文案的地方。 */
const PASSWORD = "s3cret-proxy-token";
const USERNAME = "proxy-user";

let dirCounter = 0;
async function tempDir(label) {
  dirCounter += 1;
  const dir = join(repoRoot, ".tmp", `proxy-settings-${label}-${process.pid}-${dirCounter}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 收集日志的假 logger（真 logger 一律走 stderr）。 */
function collectingLog() {
  const lines = [];
  return { lines, log: (message) => lines.push(String(message)) };
}

function storeAt(dir, { fs, log } = {}) {
  return createSettingsStore({
    dir,
    ...(fs === undefined ? {} : { fs }),
    ...(log === undefined ? {} : { log }),
  });
}

function fullProxy(overrides = {}) {
  return {
    enabled: true,
    host: "proxy.local",
    port: 8080,
    username: USERNAME,
    password: PASSWORD,
    bypass: ["localhost", "127.0.0.1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 归一：坏输入一律"当没配"，绝不猜
// ---------------------------------------------------------------------------

test("默认代理形状：enabled=false、端口 null、bypass 空数组（磁盘形状由简报钉死）", () => {
  assert.deepEqual({ ...DEFAULT_PROXY }, {
    enabled: false,
    host: "",
    port: null,
    username: "",
    password: "",
    bypass: [],
  });
  assert.deepEqual(normalizeProxy(undefined), { ...DEFAULT_PROXY });
  assert.deepEqual(normalizeProxy(null), { ...DEFAULT_PROXY });
  assert.deepEqual(normalizeProxy("proxy.local"), { ...DEFAULT_PROXY }, "字符串不是代理配置");
  assert.deepEqual(normalizeProxy([]), { ...DEFAULT_PROXY }, "数组不是代理配置");
});

test("enabled 只有严格 true 才算开；字段再全也不改变这一点", () => {
  assert.equal(normalizeProxy({ ...fullProxy(), enabled: false }).enabled, false);
  assert.equal(normalizeProxy({ ...fullProxy(), enabled: "true" }).enabled, false);
  assert.equal(normalizeProxy({ ...fullProxy(), enabled: 1 }).enabled, false);
  assert.equal(normalizeProxy(fullProxy()).enabled, true);
});

test("端口：数字与数字串都收；0/空/小数/越界一律当没填", () => {
  const cases = [
    [8080, 8080],
    ["8080", 8080],
    [" 1080 ", 1080],
    [1, 1],
    [65535, 65535],
    [8080.0, 8080],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeProxy({ ...fullProxy(), port: raw }).port, expected, `port=${JSON.stringify(raw)}`);
  }
  const unfilled = [0, "0", "", "   ", null, undefined, -1, 65536, 70000, 8080.5, "8080.5", "8080x", NaN, Infinity, true, {}];
  for (const raw of unfilled) {
    assert.equal(
      normalizeProxy({ ...fullProxy(), port: raw }).port,
      null,
      `port=${JSON.stringify(raw)} 应视为没填`,
    );
  }
});

test("host 清洗：跨语言夹具逐条一致（与 Rust webview_proxy::clean_host 读同一份 JSON）", () => {
  assert.ok(hostCases.cases.length >= 24, "夹具规模不能缩水");
  for (const { host, valid, why } of hostCases.cases) {
    const cleaned = cleanHost(host);
    if (valid) {
      assert.equal(typeof cleaned, "string", `host=${JSON.stringify(host)} 应放行（${why}）`);
      assert.equal(cleaned, cleaned.trim(), "清洗结果不带两端空白");
    } else {
      assert.equal(cleaned, null, `host=${JSON.stringify(host)} 应拒绝（${why}）`);
    }
  }
});

test("bypass 归一：逗号分隔 → 数组、去空白、去重（大小写不敏感）、非字符串条目丢掉", () => {
  assert.deepEqual(normalizeBypass("localhost, 127.0.0.1 ,localhost,, LOCALHOST"), ["localhost", "127.0.0.1"]);
  assert.deepEqual(normalizeBypass("*.corp.example, 10.0.0.0/8"), ["*.corp.example", "10.0.0.0/8"]);
  assert.deepEqual(normalizeBypass(["localhost", "", "   ", 42, null, "LOCALHOST", "::1"]), ["localhost", "::1"]);
  assert.deepEqual(normalizeBypass(""), []);
  assert.deepEqual(normalizeBypass(null), []);
  assert.deepEqual(normalizeBypass({}), [], "对象不是例外列表");
});

test("凭据原样保留（不 trim、不改写），空串 = 没填", () => {
  const proxy = normalizeProxy({ ...fullProxy(), username: " user ", password: " pa ss " });
  assert.equal(proxy.username, " user ", "用户名不做静默改写");
  assert.equal(proxy.password, " pa ss ", "密码更不做静默改写（空格可能是密码的一部分）");
  assert.equal(normalizeProxy({ ...fullProxy(), username: "", password: "" }).username, "");
  assert.equal(normalizeProxy({ ...fullProxy(), username: 42, password: null }).password, "");
});

// ---------------------------------------------------------------------------
// 文档归一：schema 不认识当没配
// ---------------------------------------------------------------------------

test("文档归一：非对象/坏 schemaVersion/坏 data 一律当没配（代理回默认），closeBehavior 回默认", () => {
  const broken = [
    null,
    "settings",
    [],
    {},
    { schemaVersion: 2, data: { proxy: fullProxy() } },
    { schemaVersion: "1", data: { proxy: fullProxy() } },
    { schemaVersion: 1 },
    { schemaVersion: 1, data: null },
    { schemaVersion: 1, data: [] },
    { schemaVersion: 1, data: { proxy: "proxy.local" } },
    { schemaVersion: 1, data: { proxy: null } },
  ];
  for (const raw of broken) {
    const doc = normalizeSettingsDocument(raw);
    assert.equal(doc.schemaVersion, SETTINGS_SCHEMA_VERSION, `schemaVersion 必须归一：${JSON.stringify(raw)}`);
    assert.deepEqual(doc.data.proxy, { ...DEFAULT_PROXY }, `坏形状的代理必须当没配：${JSON.stringify(raw)}`);
    assert.equal(doc.data.closeBehavior, DEFAULT_CLOSE_BEHAVIOR);
  }
});

test("文档归一：closeBehavior 不在枚举里回默认，但同文档里的代理照收（两件事互不牵连）", () => {
  const doc = normalizeSettingsDocument({
    schemaVersion: 1,
    data: { proxy: fullProxy(), closeBehavior: "explode" },
  });
  assert.equal(doc.data.closeBehavior, DEFAULT_CLOSE_BEHAVIOR);
  assert.deepEqual(doc.data.proxy, fullProxy());
});

test("文档归一：合法文档字段保留，未知顶层键原样带过（R10/R11 各自的字段不被吃掉）", () => {
  const raw = {
    schemaVersion: 1,
    data: {
      proxy: fullProxy(),
      closeBehavior: "quit",
      autostart: true,
      playQueue: { ids: ["a"] },
    },
  };
  const doc = normalizeSettingsDocument(raw);
  assert.deepEqual(doc, {
    schemaVersion: 1,
    data: {
      proxy: fullProxy(),
      closeBehavior: "quit",
      autostart: true,
      playQueue: { ids: ["a"] },
    },
  });
  assert.deepEqual(CLOSE_BEHAVIORS, ["tray", "quit"]);
});

test("settings:set 两态落盘读回；拒绝新写 minimize，历史精确值读迁移且下次保存为 tray", async (t) => {
  const { closeBehaviorFromSettings, closeBehaviorPatch } = await import("../src/renderer/features/settings/settings-form.mjs");
  const dir = await tempDir("close-round-trip");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createSettingsHandlers({ store: storeAt(dir) });
  await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify({ schemaVersion: 1, data: { closeBehavior: "minimize" } }));
  const legacy = await handlers.get();
  assert.equal(legacy.data.settings.data.closeBehavior, "tray");
  await handlers.set({ payload: { patch: { future: true } } });
  assert.equal(JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")).data.closeBehavior, "tray");
  for (const behavior of ["tray", "quit"]) {
    const saved = await handlers.set({ payload: { patch: closeBehaviorPatch(behavior) } });
    assert.equal(saved.ok, true, behavior);
    assert.equal(saved.data.restartRequired, false);
    assert.equal(saved.data.settings.data.closeBehavior, behavior);
    const disk = JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8"));
    assert.equal(disk.data.closeBehavior, behavior);
    const loaded = await handlers.get();
    assert.equal(closeBehaviorFromSettings(loaded.data.settings), behavior);
    for (const invalid of ["minimize", "MINIMIZE", " minimize", "minimize ", "explode"]) {
      const before = await readFile(join(dir, SETTINGS_FILE_NAME), "utf8");
      const rejected = await handlers.set({ payload: { patch: { closeBehavior: invalid } } });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.kind, "invalid_payload");
      assert.match(rejected.error.message, /tray \/ quit/);
      assert.equal(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8"), before);
    }
  }
});

// ---------------------------------------------------------------------------
// 落盘：读不到=没有、写盘原子、schema 不认识不覆盖
// ---------------------------------------------------------------------------

test("读：没有文件 → 默认文档（不是错误）", async (t) => {
  const dir = await tempDir("read-absent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { lines, log } = collectingLog();
  const doc = await storeAt(dir, { log }).read();
  assert.deepEqual(doc.data.proxy, { ...DEFAULT_PROXY });
  assert.deepEqual(lines, [], "没有文件不该刷日志");
});

test("读：坏 JSON → 当没配并记一条日志（不抛、不砸文件）", async (t) => {
  const dir = await tempDir("read-broken");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = "{ 这不是 JSON";
  await writeFile(join(dir, SETTINGS_FILE_NAME), original, "utf8");
  const { lines, log } = collectingLog();

  const doc = await storeAt(dir, { log }).read();
  assert.deepEqual(doc.data.proxy, { ...DEFAULT_PROXY }, "坏文件里的东西一律不猜");
  assert.equal(lines.length, 1, `坏文件要说一声：${JSON.stringify(lines)}`);
  assert.equal(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8"), original, "读不砸文件");
});

test("读：合法文件按归一结果读回，磁盘上的凭据不被改写", async (t) => {
  const dir = await tempDir("read-ok");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = {
    schemaVersion: 1,
    data: { proxy: { ...fullProxy(), port: "1080" }, closeBehavior: "quit" },
  };
  await writeFile(join(dir, SETTINGS_FILE_NAME), JSON.stringify(raw, null, 2), "utf8");

  const doc = await storeAt(dir).read();
  assert.equal(doc.data.proxy.port, 1080, "数字串端口归一成数字");
  assert.equal(doc.data.proxy.password, PASSWORD);
  assert.equal(doc.data.closeBehavior, "quit");
  assert.equal(
    JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")).data.proxy.port,
    "1080",
    "只读不写：磁盘原样",
  );
});

test("写：临时文件 + rename 原子替换，目录里不留半成品", async (t) => {
  const dir = await tempDir("write-atomic");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const realFs = await import("node:fs/promises");
  const spy = {
    ...realFs,
    async writeFile(path, ...rest) {
      calls.push(["writeFile", path]);
      return realFs.writeFile(path, ...rest);
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      return realFs.rename(from, to);
    },
  };
  const store = storeAt(dir, { fs: spy });
  await store.save({ proxy: fullProxy() });

  assert.deepEqual(calls.map((call) => call[0]), ["writeFile", "rename"], "先写临时文件再 rename");
  const [from, to] = [calls[1][1], calls[1][2]];
  assert.equal(dirname(from), dirname(to), "临时文件必须与目标同目录（跨分区 rename 不是原子的）");
  assert.ok(from.endsWith(".tmp"), `临时文件应有可辨认后缀：${from}`);
  assert.equal(to, join(dir, SETTINGS_FILE_NAME));
  assert.deepEqual(await readdir(dir), [SETTINGS_FILE_NAME], "没有残留临时文件");
});

test("写：patch 与磁盘现状合并，未知键保留；null 值表示回默认", async (t) => {
  const dir = await tempDir("write-merge");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = storeAt(dir);
  await writeFile(
    join(dir, SETTINGS_FILE_NAME),
    JSON.stringify({ schemaVersion: 1, data: { closeBehavior: "quit", playQueue: { ids: ["a"] } } }),
    "utf8",
  );

  const afterProxy = await store.save({ proxy: fullProxy() });
  assert.equal(afterProxy.data.closeBehavior, "quit", "没提的字段不动");
  assert.deepEqual(afterProxy.data.playQueue, { ids: ["a"] }, "未知键原样保留");
  assert.equal(afterProxy.data.proxy.host, "proxy.local");

  const afterClear = await store.save({ proxy: null, closeBehavior: null });
  assert.deepEqual(afterClear.data.proxy, { ...DEFAULT_PROXY }, "proxy=null = 回默认（恢复默认代理）");
  assert.equal(afterClear.data.closeBehavior, DEFAULT_CLOSE_BEHAVIOR);
  assert.deepEqual(afterClear.data.playQueue, { ids: ["a"] }, "回默认只碰已知键");
});

test("写：closeBehavior 不在枚举里 → 结构化错误且一个字节都不写", async (t) => {
  const dir = await tempDir("write-bad-behavior");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = storeAt(dir);
  await assert.rejects(
    () => store.save({ closeBehavior: "explode" }),
    (error) => {
      assert.ok(error instanceof SettingsStoreError);
      assert.equal(error.kind, CORE_ERROR_KINDS.invalidPayload);
      assert.ok(error.message.includes("closeBehavior"), error.message);
      return true;
    },
  );
  assert.deepEqual(await readdir(dir), [], "校验失败不该留下任何文件");
});

test("写：schemaVersion 认不出的文件绝不覆盖（宁可不写，也不砸新版写的文件）", async (t) => {
  const dir = await tempDir("write-future-schema");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = JSON.stringify({ schemaVersion: 2, data: { proxy: fullProxy() } });
  await writeFile(join(dir, SETTINGS_FILE_NAME), original, "utf8");
  const { lines, log } = collectingLog();
  const store = storeAt(dir, { log });

  const doc = await store.read();
  assert.deepEqual(doc.data.proxy, { ...DEFAULT_PROXY }, "认不出的 schema = 没配代理");
  assert.ok(lines.length >= 1, "要说一声为什么当没配");

  await assert.rejects(
    () => store.save({ proxy: fullProxy() }),
    (error) => {
      assert.ok(error instanceof SettingsStoreError);
      assert.equal(error.kind, CORE_ERROR_KINDS.invalidEnvelope);
      return true;
    },
  );
  assert.equal(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8"), original, "原文件必须一字不动");
});

test("写：重置把已知键打回默认，未知键保留", async (t) => {
  const dir = await tempDir("reset");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = storeAt(dir);
  await store.save({ proxy: fullProxy(), closeBehavior: "quit", future: { keep: 1 } });

  const doc = await store.reset();
  assert.deepEqual(doc.data.proxy, { ...DEFAULT_PROXY });
  assert.equal(doc.data.closeBehavior, DEFAULT_CLOSE_BEHAVIOR);
  assert.deepEqual(doc.data.future, { keep: 1 }, "回默认不碰未知键");
});

test("并发 settings:set 歌词与队列的 load/merge/rename 串行，不丢任一键", async (t) => {
  const dir = await tempDir("lyrics-queue-concurrent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  let writing = 0;
  let concurrent = false;
  const store = storeAt(dir, { fs: { ...realFs, async writeFile(...args) {
    writing += 1;
    concurrent ||= writing > 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    try { return await realFs.writeFile(...args); } finally { writing -= 1; }
  } } });
  await Promise.all([
    store.save({ lyricsWindow: { style: "panel", layout: "vertical" } }),
    store.save({ queue: { ids: ["a", "b"], index: 1 } }),
    store.reset(),
  ]);
  const restarted = await storeAt(dir).read();
  assert.deepEqual(restarted.data.lyricsWindow, { style: "panel", layout: "vertical" });
  assert.deepEqual(restarted.data.queue, { ids: ["a", "b"], index: 1 });
  assert.equal(concurrent, false);
});

// ---------------------------------------------------------------------------
// 凭据卫生：不进日志、不进错误文案
// ---------------------------------------------------------------------------

test("凭据卫生：日志、错误文案、路径里都不出现用户名/密码", async (t) => {
  const dir = await tempDir("credential-hygiene");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { lines, log } = collectingLog();
  const store = storeAt(dir, { log });
  await store.save({ proxy: fullProxy() });
  await store.read();

  // 写盘失败路径：错误文案同样不能回显凭据
  const failingFs = {
    ...(await import("node:fs/promises")),
    async writeFile() {
      throw Object.assign(new Error("EPERM: 打不开文件"), { code: "EPERM" });
    },
  };
  const failing = storeAt(dir, { fs: failingFs, log });
  await assert.rejects(() => failing.save({ proxy: fullProxy() }), (error) => {
    assert.ok(!error.message.includes(PASSWORD), `错误文案回显了密码：${error.message}`);
    assert.ok(!error.message.includes(USERNAME), `错误文案回显了用户名：${error.message}`);
    return true;
  });

  const text = [store.settingsPath(), ...lines].join("\n");
  assert.ok(!text.includes(PASSWORD), `密码漏进了日志/路径：${text}`);
  assert.ok(!text.includes(USERNAME), `用户名漏进了日志/路径：${text}`);
});

test("凭据卫生：0600 尽力而为——收不紧记一条日志，但不判保存失败", async (t) => {
  const dir = await tempDir("chmod-note");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  const failingChmod = {
    ...realFs,
    async chmod() {
      throw Object.assign(new Error("EPERM: chmod 不支持"), { code: "EPERM" });
    },
  };
  const { lines, log } = collectingLog();
  const store = storeAt(dir, { fs: failingChmod, log });

  const doc = await store.save({ proxy: fullProxy() });
  assert.equal(doc.data.proxy.host, "proxy.local", "chmod 失败不算保存失败");
  assert.equal(lines.length, 1, `chmod 失败要记一条：${JSON.stringify(lines)}`);
});

// ---------------------------------------------------------------------------
// R44e：单一写者 + 读排空屏障
// ---------------------------------------------------------------------------

test("R44e 读是排空屏障：已受理的写落定之后才读盘，读回的是新值而非旧盘", async (t) => {
  const dir = await tempDir("read-barrier");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = true;
  const store = storeAt(dir, { fs: { ...realFs, async writeFile(...args) {
    if (held) { held = false; await gate; }
    return realFs.writeFile(...args);
  } } });

  const write = store.save({ lyricsWindow: { style: "panel", layout: "vertical" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  let settled = false;
  const read = store.read().then((document) => { settled = true; return document; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "已受理的写还在飞时，读不能抢先返回旧盘");
  release();
  await write;
  const document = await read;
  assert.deepEqual(document.data.lyricsWindow, { style: "panel", layout: "vertical" }, "读回的是刚写的值");
  assert.equal(document.data.closeBehavior, DEFAULT_CLOSE_BEHAVIOR, "新文档带关窗行为默认值");
});

test("R44e 读屏障不自等也不改盘：读只排空与 load，不追加写", async (t) => {
  const dir = await tempDir("read-no-self-wait");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  const calls = [];
  const store = storeAt(dir, { fs: { ...realFs, async rename(from, to) {
    calls.push("rename");
    return realFs.rename(from, to);
  } } });

  // save 内部若走 read() 就会等自己尚未落定的尾链：这里必须自己能完成。
  const saved = await Promise.race([
    store.save({ proxy: fullProxy() }).then(() => "saved"),
    new Promise((resolve) => setTimeout(() => resolve("deadlock"), 300)),
  ]);
  assert.equal(saved, "saved", "save 不得等待自己的 writeTail（自等）");
  assert.equal(calls.length, 1);

  const document = await store.read();
  assert.equal(document.data.proxy.host, "proxy.local");
  assert.equal(calls.length, 1, "纯读不改盘");
});

test("R44e 同一 chunk 内的 set/set/get：get 排在两笔已发送的 set 之后", async (t) => {
  const dir = await tempDir("same-chunk-order");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  let slow = 0;
  const store = storeAt(dir, { fs: { ...realFs, async writeFile(...args) {
    slow += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return realFs.writeFile(...args);
  } } });

  // 与 src/host/bridge.mjs 的真实入帧一致：同一 chunk 的帧**同步**逐个交给处理器，
  // 不等前一个 handler 结束。排空屏障必须让后面的 get 看见前面的 set。
  const { createDispatcher } = await import("../src/host/dispatcher.mjs");
  const { createSettingsHandlers } = await import("../src/main/settings.mjs");
  const handlers = createSettingsHandlers({ store });
  const dispatcher = createDispatcher({ onHandlerError: () => {} });
  dispatcher.register("settings:get", handlers.get);
  dispatcher.register("settings:set", (request) => handlers.set(request));

  const answers = [];
  const frames = [
    { channel: "settings:set", payload: { patch: { lyricsWindow: { style: "panel" } } } },
    { channel: "settings:set", payload: { patch: { theme: "dark" } } },
    { channel: "settings:get", payload: null },
  ];
  const inflight = frames.map((frame, index) => new Promise((resolve) => {
    void dispatcher.dispatch({ id: `c${index}`, ...frame }, (result) => {
      answers.push({ index, result });
      resolve();
    });
  }));
  await Promise.all(inflight);

  const got = answers.find((entry) => entry.index === 2);
  assert.equal(got.result.ok, true);
  assert.deepEqual(got.result.data.settings.data.lyricsWindow, { style: "panel" }, "get 看见了第一笔 set");
  assert.equal(got.result.data.settings.data.theme, "dark", "get 看见了第二笔 set");
  assert.equal(slow, 2, "两笔 set 各写盘一次，get 不写");
});

// ---------------------------------------------------------------------------
// R50：读也排进同一条队列 + rename 对瞬时占用有限重试
// ---------------------------------------------------------------------------

/**
 * R50（brief 第 4 项）的现场证据是真实日志 `.tmp/run/app-20261025-160445.log:19`：
 *
 * ```
 * 歌词配置保存失败：设置落盘失败（EPERM: operation not permitted, rename '…settings.json.5712.4.tmp' -> '…settings.json'）
 * ```
 *
 * 两个原因叠在一起：①`read()` 只 `await` 调用时拿到的旧 `writeTail`，让出事件循环之后
 * `save()` 可以带着**新的读 + 写**插进来——Node 的读句柄在 Windows 上会阻止 `MoveFileEx`
 * 替换目标，rename 于是 EPERM；②Windows 上这种占用常常只持续几毫秒，一次失败就放弃太早。
 * 下面四条分别钉住这两个修复点。
 */
test("R50 读与写共用同一条队列：读已开始、save 随后插入也不会并发读写", async (t) => {
  const dir = await tempDir("r50-read-queued");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  await writeFile(
    join(dir, SETTINGS_FILE_NAME),
    JSON.stringify({ schemaVersion: 1, data: { closeBehavior: "quit" } }),
    "utf8",
  );

  const events = [];
  const overlaps = [];
  let reading = false;
  const store = storeAt(dir, { fs: { ...realFs,
    async readFile(...args) {
      if (reading) overlaps.push("readFile 与 readFile 并发");
      reading = true;
      events.push("read:start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        return await realFs.readFile(...args);
      } finally {
        reading = false;
        events.push("read:end");
      }
    },
    async writeFile(...args) {
      if (reading) overlaps.push("writeFile 与 readFile 并发（读句柄会挡住 rename）");
      events.push("write:start");
      return realFs.writeFile(...args);
    },
    async rename(from, to) {
      if (reading) overlaps.push("rename 与 readFile 并发");
      events.push("rename");
      return realFs.rename(from, to);
    },
  } });

  // 同一个 chunk 里：读先受理，写紧接着插进来（真实宿主里 settings:get 与 settings:set 就是这样排的）
  const reading0 = store.read();
  const writing = store.save({ closeBehavior: "tray" });
  const [readDocument, saved] = await Promise.all([reading0, writing]);

  assert.deepEqual(overlaps, [], `读写不许并发：${JSON.stringify(overlaps)}`);
  assert.equal(events[0], "read:start", "读先跑");
  const firstWrite = events.indexOf("write:start");
  assert.ok(firstWrite > 0 && events.slice(0, firstWrite).filter((name) => name === "read:end").length >= 1,
    `写必须排在已开始的读之后（事件：${events.join(",")}）`);
  assert.equal(readDocument.data.closeBehavior, "quit", "读排在前：读到的是插入前那一份");
  assert.equal(saved.data.closeBehavior, "tray", "写仍然成功");
  assert.equal((await storeAt(dir).read()).data.closeBehavior, "tray", "盘上是最后那一份");
});

test("R50 rename 连续 EPERM 两次后成功：保存最终成功、无错误、无残留临时文件", async (t) => {
  const dir = await tempDir("r50-rename-retry");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  let failures = 2;
  let attempts = 0;
  const store = storeAt(dir, {
    renameRetryDelaysMs: [0, 0, 0],
    fs: { ...realFs,
      async rename(from, to) {
        attempts += 1;
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM" });
        }
        return realFs.rename(from, to);
      },
    },
  });

  const saved = await store.save({ proxy: fullProxy() });
  assert.equal(saved.data.proxy.host, "proxy.local", "重试之后这次保存是成功的");
  assert.equal(attempts, 3, "两次瞬时占用 + 一次成功 = 三次尝试");
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")).data.proxy.bypass,
    ["localhost", "127.0.0.1"],
  );
  assert.deepEqual(await readdir(dir), [SETTINGS_FILE_NAME], "没有残留临时文件");
});

test("R50 rename 一直 EPERM：结构化失败、原文件保留、之后读写仍可用", async (t) => {
  const dir = await tempDir("r50-rename-exhausted");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");
  const target = join(dir, SETTINGS_FILE_NAME);
  const original = `${JSON.stringify({ schemaVersion: 1, data: { closeBehavior: "quit" } }, null, 2)}\n`;
  await writeFile(target, original, "utf8");

  let broken = true;
  let attempts = 0;
  const store = storeAt(dir, {
    renameRetryDelaysMs: [0, 0, 0],
    fs: { ...realFs,
      async rename(from, to) {
        attempts += 1;
        if (broken) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
        return realFs.rename(from, to);
      },
    },
  });

  await assert.rejects(
    () => store.save({ proxy: fullProxy() }),
    (error) => {
      assert.ok(error instanceof SettingsStoreError);
      assert.equal(error.kind, CORE_ERROR_KINDS.internal, "失败仍是 structured internal（错误码/文案不变）");
      assert.match(error.message, /设置落盘失败/);
      assert.match(error.message, /EPERM/, "原因原样带出来（不吞、不只说'失败'）");
      assert.ok(!error.message.includes(PASSWORD), "错误文案不回显凭据");
      return true;
    },
  );
  assert.equal(attempts, 4, "1 次 + 3 次重试 = 4 次尝试，然后放弃");
  assert.equal(await readFile(target, "utf8"), original, "原文件一字不动");
  assert.deepEqual(await readdir(dir), [SETTINGS_FILE_NAME], "临时文件已清掉");

  broken = false;
  const saved = await store.save({ closeBehavior: "tray" });
  assert.equal(saved.data.closeBehavior, "tray", "占用消失后下一笔保存照常成功");
  assert.equal((await store.read()).data.closeBehavior, "tray", "读取也照常可用");
});

test("R50 rename 只对 EPERM/EACCES/EBUSY 重试：别的错误立刻失败，不掩盖真原因", async (t) => {
  const dir = await tempDir("r50-rename-codes");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const realFs = await import("node:fs/promises");

  for (const code of ["EACCES", "EBUSY"]) {
    let failed = false;
    let attempts = 0;
    const store = storeAt(dir, {
      renameRetryDelaysMs: [0, 0, 0],
      fs: { ...realFs,
        async rename(from, to) {
          attempts += 1;
          if (!failed) {
            failed = true;
            throw Object.assign(new Error(`${code}: 目标被占用`), { code });
          }
          return realFs.rename(from, to);
        },
      },
    });
    await store.save({ closeBehavior: "quit" });
    assert.equal(attempts, 2, `${code} 是可重试的：第二次成功`);
  }

  let attempts = 0;
  const store = storeAt(dir, {
    renameRetryDelaysMs: [0, 0, 0],
    fs: { ...realFs,
      async rename() {
        attempts += 1;
        throw Object.assign(new Error("ENOENT: 目标目录不存在"), { code: "ENOENT" });
      },
    },
  });
  await assert.rejects(() => store.save({ closeBehavior: "quit" }), (error) => {
    assert.match(error.message, /ENOENT/, "不可重试的错误原样报出来");
    return true;
  });
  assert.equal(attempts, 1, "不可重试的错误一次都不多试（重试只会拖长时间并掩盖原因）");
});

// ---------------------------------------------------------------------------
// 请求频道处理器（settings:get / settings:set）
// ---------------------------------------------------------------------------

test("settings:get 返回归一后的完整文档（与磁盘同形）", async (t) => {
  const dir = await tempDir("handler-get");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createSettingsHandlers({ store: storeAt(dir) });
  const result = await handlers.get({ channel: "settings:get", payload: null });
  assert.equal(result.ok, true);
  assert.equal(result.data.settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(result.data.settings.data.proxy, { ...DEFAULT_PROXY });
});

test("settings:set 合并写盘并回报 restartRequired（代理改动要重启才生效）", async (t) => {
  const dir = await tempDir("handler-set");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createSettingsHandlers({ store: storeAt(dir) });

  const saved = await handlers.set({
    channel: "settings:set",
    payload: { patch: { proxy: fullProxy(), closeBehavior: "quit" } },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.settings.data.proxy.host, "proxy.local");
  assert.equal(saved.data.restartRequired, true, "代理改动必须明文告知需要重启");
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, SETTINGS_FILE_NAME), "utf8")).data.proxy.bypass,
    ["localhost", "127.0.0.1"],
  );

  const other = await handlers.set({ channel: "settings:set", payload: { patch: { closeBehavior: "tray" } } });
  assert.equal(other.data.restartRequired, false, "没动代理就不该说要重启");
});

test("settings:set 支持整份恢复默认（reset）", async (t) => {
  const dir = await tempDir("handler-reset");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createSettingsHandlers({ store: storeAt(dir) });
  await handlers.set({ channel: "settings:set", payload: { patch: { proxy: fullProxy() } } });

  const reset = await handlers.set({ channel: "settings:set", payload: { reset: true } });
  assert.equal(reset.ok, true);
  assert.deepEqual(reset.data.settings.data.proxy, { ...DEFAULT_PROXY });
  assert.equal(reset.data.restartRequired, true, "从「已配代理」回默认同样要重启才生效");
});

test("settings:set 坏 payload → 结构化 invalid_payload（不写盘）", async (t) => {
  const dir = await tempDir("handler-bad-payload");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createSettingsHandlers({ store: storeAt(dir) });
  const bad = [
    null,
    {},
    { patch: "proxy" },
    { patch: [] },
    { reset: "yes" },
    { reset: true, patch: { closeBehavior: "quit" } },
    { patch: { closeBehavior: "explode" } },
  ];
  for (const payload of bad) {
    const result = await handlers.set({ channel: "settings:set", payload });
    assert.equal(result.ok, false, `payload=${JSON.stringify(payload)} 该被拒`);
    assert.equal(result.error.kind, CORE_ERROR_KINDS.invalidPayload, JSON.stringify(result.error));
  }
  assert.deepEqual(await readdir(dir), [], "坏 payload 一个字节都不写");
});

test("没有数据目录时不假装保存成功（settings:set 结构化报错，settings:get 回默认）", async () => {
  const { lines, log } = collectingLog();
  const store = createSettingsStore({ dir: null, log });
  assert.equal(store.persistent, false);
  assert.equal(store.settingsPath(), null);
  const handlers = createSettingsHandlers({ store });

  const got = await handlers.get({ channel: "settings:get", payload: null });
  assert.equal(got.ok, true, "读不到磁盘也要给出可用默认");
  assert.deepEqual(got.data.settings.data.proxy, { ...DEFAULT_PROXY });

  const saved = await handlers.set({ channel: "settings:set", payload: { patch: { proxy: fullProxy() } } });
  assert.equal(saved.ok, false, "没有数据目录却回 ok 就是谎报");
  assert.equal(saved.error.kind, CORE_ERROR_KINDS.internal);
  assert.ok(saved.error.message.includes("数据目录"), saved.error.message);
  assert.ok(!saved.error.message.includes(PASSWORD), "错误文案不得回显凭据");
  assert.ok(lines.length >= 1, "要说一声为什么不能存");
});

// ---------------------------------------------------------------------------
// 跨语言互钉：文件名与 schemaVersion 与 Rust 同源
// ---------------------------------------------------------------------------

test("互钉：SETTINGS_FILE_NAME / SETTINGS_SCHEMA_VERSION 与 Rust webview_proxy.rs 字面量一致", async () => {
  const rust = await readFile(join(repoRoot, "src-tauri", "src", "webview_proxy.rs"), "utf8");
  const name = /SETTINGS_FILE_NAME\s*:\s*&str\s*=\s*"([^"]+)"/.exec(rust);
  const version = /SETTINGS_SCHEMA_VERSION\s*:\s*f64\s*=\s*([0-9.]+)/.exec(rust);
  assert.ok(name, "Rust 侧找不到 SETTINGS_FILE_NAME 字面量");
  assert.ok(version, "Rust 侧找不到 SETTINGS_SCHEMA_VERSION 字面量");
  assert.equal(name[1], SETTINGS_FILE_NAME);
  assert.equal(Number(version[1]), SETTINGS_SCHEMA_VERSION);
  assert.equal(SETTINGS_FILE_NAME, "settings.json");
  assert.equal(SETTINGS_SCHEMA_VERSION, 1);
});
