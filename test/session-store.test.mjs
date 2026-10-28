/**
 * 会话持久化 · 注入式单测：真 DPAPI 在 Rust 侧，这里注入假编解码器。
 * 只钉 Node 侧职责：原子替换、0600 尽力而为、失败不覆盖旧会话、错误不吞不回显。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SESSION_FILE_MODE,
  SESSION_FILE_NAME,
  SessionStoreError,
  createSessionStore,
} from "../src/main/session-store.mjs";
import { DATA_DIR_ARG, DATA_DIR_ENV, dataDirFromArgv } from "../src/main/data-dir.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SESSION = { musicSession: "user$7f3a", nickname: "听歌的人", expiresAt: 1_700_000_000_000 };
const SESSION_TEXT = JSON.stringify(SESSION);

let dirCounter = 0;
async function tempDir(label) {
  dirCounter += 1;
  const dir = join(repoRoot, ".tmp", `session-store-${label}-${process.pid}-${dirCounter}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 假 DPAPI：可逆的字节级变换（不含真凭据、不碰真后端），并记下每次调用。 */
function fakeCodec() {
  return {
    encrypted: [],
    decrypted: [],
    async secureEncrypt(payload) {
      const { plaintext } = payload;
      this.encrypted.push(plaintext);
      return { ok: true, data: { cipher: Buffer.from(`env(${plaintext})`, "utf8").toString("base64") } };
    },
    async secureDecrypt(payload) {
      const { cipher } = payload;
      this.decrypted.push(cipher);
      const text = Buffer.from(cipher, "base64").toString("utf8");
      const match = /^env\(([\s\S]*)\)$/.exec(text);
      if (match === null) {
        return { ok: false, error: { message: "DPAPI 解密失败：信封不合法", kind: "invalid_cipher" } };
      }
      return { ok: true, data: { plaintext: match[1] } };
    },
  };
}

function storeAt(dir, { codec = fakeCodec(), fs, log } = {}) {
  const store = createSessionStore({
    dir,
    secureEncrypt: codec.secureEncrypt.bind(codec),
    secureDecrypt: codec.secureDecrypt.bind(codec),
    ...(fs === undefined ? {} : { fs }),
    ...(log === undefined ? {} : { log }),
  });
  return { store, codec };
}

async function leftovers(dir) {
  return (await readdir(dir)).filter((name) => name !== SESSION_FILE_NAME);
}

// ---- 往返与原子替换 ----

test("往返：save 后 load 还原同一个会话，且磁盘上只有密文信封", async (t) => {
  const dir = await tempDir("roundtrip");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store, codec } = storeAt(dir);

  const result = await store.saveMusicSession(SESSION);
  assert.equal(result.path, join(dir, SESSION_FILE_NAME));
  assert.deepEqual(await store.loadMusicSession(), SESSION, "往返必须还原同一个会话对象");

  assert.deepEqual(codec.encrypted, [SESSION_TEXT], "加密的必须是会话 JSON 原文");
  const raw = await readFile(join(dir, SESSION_FILE_NAME), "utf8");
  assert.ok(!raw.includes("musicSession"), `磁盘上不得出现明文片段：${raw}`);
  assert.ok(!raw.includes("听歌的人"), "磁盘上不得出现明文片段");
  const envelope = JSON.parse(raw);
  assert.equal(envelope.schemaVersion, 1, "信封要带 schemaVersion 才谈得上以后演进");
  assert.equal(typeof envelope.cipher, "string");
  assert.ok(envelope.cipher.length > 0);
  assert.deepEqual(await leftovers(dir), [], "不许留下临时文件");
});

test("原子替换：第二次 save 换掉内容，读完是新会话且不留半文件", async (t) => {
  const dir = await tempDir("atomic");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);

  await store.saveMusicSession(SESSION);
  const next = { ...SESSION, musicSession: "user$next" };
  await store.saveMusicSession(next);

  assert.deepEqual(await store.loadMusicSession(), next);
  assert.deepEqual(await leftovers(dir), [], "替换路径上不许留下临时文件");
});

test("rename 的源与目标同目录不同名（同一分区才谈得上原子）", async (t) => {
  const dir = await tempDir("rename");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const calls = [];
  const fs = {
    mkdir: async () => {},
    writeFile: async (file, data, options) => {
      calls.push(["writeFile", file, options]);
      seen.push(file);
    },
    rename: async (from, to) => {
      calls.push(["rename", from, to]);
      seen.push(from);
    },
    chmod: async () => {},
    readFile: async () => {
      throw Object.assign(new Error("不该走到读"), { code: "ENOENT" });
    },
    unlink: async () => {},
  };
  const { store } = storeAt(dir, { fs });

  await store.saveMusicSession(SESSION);

  const [, from, to] = calls.find(([name]) => name === "rename");
  assert.equal(to, join(dir, SESSION_FILE_NAME));
  assert.notEqual(from, to, "必须先写临时文件再 rename，不能就地覆盖");
  assert.equal(dirname(from), dirname(to), "临时文件必须与目标同目录（跨分区 rename 不是原子的）");
  assert.ok(from.endsWith(".tmp"), `临时文件应有可辨认的后缀：${from}`);
  assert.equal(seen.length, 2, "先写临时文件、再 rename");
});

test("没有会话文件时 load 返回 null（不是错误）", async (t) => {
  const dir = await tempDir("absent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);

  assert.equal(await store.loadMusicSession(), null);
  assert.deepEqual(await readdir(dir), [], "读不到就什么都不建");
});

// ---- 0600 尽力而为 ----

test("0600：创建时即带 mode，chmod 成功时如实报 applied", async (t) => {
  const dir = await tempDir("mode-ok");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writes = [];
  const chmods = [];
  const fs = {
    mkdir: async () => {},
    writeFile: async (file, data, options) => {
      writes.push([file, options]);
    },
    rename: async () => {},
    chmod: async (file, mode) => {
      chmods.push([file, mode]);
    },
    readFile: async () => {
      throw Object.assign(new Error("没文件"), { code: "ENOENT" });
    },
    unlink: async () => {},
  };
  const { store } = storeAt(dir, { fs });

  const result = await store.saveMusicSession(SESSION);

  assert.deepEqual(writes[0][1], { mode: SESSION_FILE_MODE }, "临时文件创建时就该是 0600，别先宽后窄");
  assert.equal(SESSION_FILE_MODE, 0o600);
  assert.deepEqual(chmods, [[join(dir, SESSION_FILE_NAME), SESSION_FILE_MODE]], "rename 之后对最终文件再收一次");
  assert.equal(result.modeApplied, true);
  assert.equal(result.modeNote, null);
});

test("0600 尽力而为：chmod 不支持时记录并继续（Windows 常见），保存不算失败", async (t) => {
  const dir = await tempDir("mode-note");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logged = [];
  const fs = {
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {
      throw Object.assign(new Error("EPERM: chmod 不被支持"), { code: "EPERM" });
    },
    readFile: async () => {
      throw Object.assign(new Error("没文件"), { code: "ENOENT" });
    },
    unlink: async () => {},
  };
  const { store } = storeAt(dir, { fs, log: (message) => logged.push(message) });

  const result = await store.saveMusicSession(SESSION);

  assert.equal(result.modeApplied, false, "没收紧成功就得如实报 false");
  assert.ok(typeof result.modeNote === "string" && result.modeNote.includes("0600"), `记录里要说清是 0600：${result.modeNote}`);
  assert.equal(logged.length, 1, "尽力而为的失败必须留下记录");
  assert.match(logged[0], /0600/);
});

// ---- 失败路径：不覆盖旧会话、绝不写明文 ----

test("加密失败：不写任何文件，错误如实抛出（不降级成明文）", async (t) => {
  const dir = await tempDir("encrypt-fail");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codec = {
    async secureEncrypt() {
      return { ok: false, error: { message: "当前平台没有可用的安全存储后端", kind: "secure_store_unavailable" } };
    },
    async secureDecrypt() {
      throw new Error("不该走到解密");
    },
  };
  const { store } = storeAt(dir, { codec });

  const error = await store.saveMusicSession(SESSION).then(
    () => assert.fail("加密不可用时必须抛错，而不是静默降级"),
    (cause) => cause,
  );
  assert.ok(error instanceof SessionStoreError);
  assert.equal(error.kind, "secure_store_unavailable");
  assert.deepEqual(await readdir(dir), [], "磁盘上不许出现任何东西（尤其不能是明文）");
});

test("加密失败且已有旧会话：旧会话原封不动", async (t) => {
  const dir = await tempDir("keep-old");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = fakeCodec();
  const { store: writer } = storeAt(dir, { codec: good });
  await writer.saveMusicSession(SESSION);
  const before = await readFile(join(dir, SESSION_FILE_NAME), "utf8");

  const broken = {
    async secureEncrypt() {
      return { ok: false, error: { message: "DPAPI 加密失败（0x80070005）", kind: "secure_store_unavailable" } };
    },
    async secureDecrypt() {
      throw new Error("不该走到解密");
    },
  };
  const { store } = storeAt(dir, { codec: broken });
  await assert.rejects(() => store.saveMusicSession({ musicSession: "user$new" }), /安全存储|加密/);

  assert.equal(await readFile(join(dir, SESSION_FILE_NAME), "utf8"), before, "失败不许动旧会话");
  assert.deepEqual(await leftovers(dir), []);
  assert.deepEqual(await writer.loadMusicSession(), SESSION, "旧会话仍然可用");
});

test("落盘失败（writeFile 抛错）：旧会话保留，临时文件清掉", async (t) => {
  const dir = await tempDir("write-fail");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store: writer } = storeAt(dir);
  await writer.saveMusicSession(SESSION);
  const before = await readFile(join(dir, SESSION_FILE_NAME), "utf8");

  const unlinked = [];
  const fs = {
    mkdir: async () => {},
    writeFile: async () => {
      throw Object.assign(new Error("ENOSPC: 磁盘满了"), { code: "ENOSPC" });
    },
    rename: async () => assert.fail("写都没成功，不该 rename"),
    chmod: async () => {},
    readFile: async () => before,
    unlink: async (file) => {
      unlinked.push(file);
    },
  };
  const { store } = storeAt(dir, { fs });

  const error = await store.saveMusicSession(SESSION).then(
    () => assert.fail("写失败必须抛错"),
    (cause) => cause,
  );
  assert.equal(error.kind, "internal");
  assert.match(error.message, /ENOSPC/);
  assert.equal(await readFile(join(dir, SESSION_FILE_NAME), "utf8"), before, "旧会话必须原封不动");
  assert.equal(unlinked.length, 1, "半成品临时文件要尽力清掉");
  assert.ok(unlinked[0].endsWith(".tmp"));
});

test("rename 失败：旧会话保留，临时文件清掉", async (t) => {
  const dir = await tempDir("rename-fail");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store: writer } = storeAt(dir);
  await writer.saveMusicSession(SESSION);
  const before = await readFile(join(dir, SESSION_FILE_NAME), "utf8");

  const unlinked = [];
  const fs = {
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async () => {
      throw Object.assign(new Error("EPERM: 目标被占用"), { code: "EPERM" });
    },
    chmod: async () => {},
    readFile: async () => before,
    unlink: async (file) => {
      unlinked.push(file);
    },
  };
  const { store } = storeAt(dir, { fs });

  await assert.rejects(() => store.saveMusicSession(SESSION), (cause) => cause.kind === "internal");
  assert.equal(await readFile(join(dir, SESSION_FILE_NAME), "utf8"), before);
  assert.equal(unlinked.length, 1);
});

test("save 入参不是普通对象：当场拒绝，不加密不落盘", async (t) => {
  const dir = await tempDir("bad-input");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store, codec } = storeAt(dir);

  for (const bad of [null, undefined, "会话", 42, [SESSION], () => SESSION]) {
    await assert.rejects(
      () => store.saveMusicSession(bad),
      (cause) => cause instanceof SessionStoreError && cause.kind === "invalid_payload",
      `坏入参必须被拒：${String(bad)}`,
    );
  }
  assert.deepEqual(codec.encrypted, [], "坏入参不该碰加密后端");
  assert.deepEqual(await readdir(dir), []);
});

// ---- 损坏：错误不吞、不回显 ----

test("文件不是合法 JSON：invalid_envelope，原文件保留", async (t) => {
  const dir = await tempDir("bad-json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);
  const target = join(dir, SESSION_FILE_NAME);
  await writeFile(target, "{这不是 JSON", "utf8");

  const error = await store.loadMusicSession().then(
    () => assert.fail("损坏的信封必须抛错，不能当成'没有会话'"),
    (cause) => cause,
  );
  assert.equal(error.kind, "invalid_envelope");
  assert.equal(await readFile(target, "utf8"), "{这不是 JSON", "读失败不许顺手删文件");
});

test("信封 schemaVersion 不认识：invalid_envelope，不猜测内容", async (t) => {
  const dir = await tempDir("bad-version");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);
  await writeFile(join(dir, SESSION_FILE_NAME), JSON.stringify({ schemaVersion: 99, cipher: "AAAA" }), "utf8");

  const error = await store.loadMusicSession().then(
    () => assert.fail("不认识的版本必须抛错"),
    (cause) => cause,
  );
  assert.equal(error.kind, "invalid_envelope");
  assert.match(error.message, /99/, "错误里要带上读到的版本号");
});

test("信封缺 cipher：invalid_envelope", async (t) => {
  const dir = await tempDir("no-cipher");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);
  await writeFile(join(dir, SESSION_FILE_NAME), JSON.stringify({ schemaVersion: 1 }), "utf8");

  await assert.rejects(() => store.loadMusicSession(), (cause) => cause.kind === "invalid_envelope");
});

test("密文解不开：invalid_cipher 如实抛出，不回显密文", async (t) => {
  const dir = await tempDir("bad-cipher");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);
  const cipher = Buffer.from("这不是本机的 DPAPI 信封", "utf8").toString("base64");
  await writeFile(join(dir, SESSION_FILE_NAME), JSON.stringify({ schemaVersion: 1, cipher }), "utf8");

  const error = await store.loadMusicSession().then(
    () => assert.fail("解不开必须抛错"),
    (cause) => cause,
  );
  assert.equal(error.kind, "invalid_cipher");
  assert.ok(!error.message.includes(cipher), `错误里不能回显密文：${error.message}`);
});

test("解密成功但不是合法会话 JSON：invalid_cipher", async (t) => {
  const dir = await tempDir("not-json-plaintext");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);
  const cipher = Buffer.from("env(这不是 JSON)", "utf8").toString("base64");
  await writeFile(join(dir, SESSION_FILE_NAME), JSON.stringify({ schemaVersion: 1, cipher }), "utf8");

  await assert.rejects(() => store.loadMusicSession(), (cause) => cause.kind === "invalid_cipher");
});

test("读文件 IO 失败（非 ENOENT）：internal，不当成'没有会话'", async (t) => {
  const dir = await tempDir("read-fail");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fs = {
    readFile: async () => {
      throw Object.assign(new Error("EACCES: 拒绝访问"), { code: "EACCES" });
    },
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
    unlink: async () => {},
  };
  const { store } = storeAt(dir, { fs });

  const error = await store.loadMusicSession().then(
    () => assert.fail("读不了必须抛错"),
    (cause) => cause,
  );
  assert.equal(error.kind, "internal");
  assert.match(error.message, /EACCES/);
});

// ---- 清理与构造守卫 ----

test("clearMusicSession：删得掉返回 true，没得删返回 false，之后 load 是 null", async (t) => {
  const dir = await tempDir("clear");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { store } = storeAt(dir);

  await store.saveMusicSession(SESSION);
  assert.equal(await store.clearMusicSession(), true);
  assert.equal(await store.clearMusicSession(), false, "第二次已经没有文件了");
  assert.equal(await store.loadMusicSession(), null);
  assert.deepEqual(await readdir(dir), []);
});

test("构造守卫：缺 dir/缺编解码器当场报 TypeError", async (t) => {
  const dir = await tempDir("constructor");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codec = fakeCodec();

  assert.throws(() => createSessionStore(), TypeError);
  assert.throws(() => createSessionStore({ dir: "relative/dir", secureEncrypt: codec.secureEncrypt, secureDecrypt: codec.secureDecrypt }), TypeError);
  assert.throws(() => createSessionStore({ dir, secureDecrypt: codec.secureDecrypt }), TypeError);
  assert.throws(() => createSessionStore({ dir, secureEncrypt: codec.secureEncrypt }), TypeError);
  assert.ok(isAbsolute(dir));
});

// ---- 数据目录：宿主 argv 是唯一来源 ----

test("数据目录：--data-dir 取绝对路径，缺值/相对路径当场报错", () => {
  assert.equal(DATA_DIR_ARG, "--data-dir");
  assert.equal(dataDirFromArgv([DATA_DIR_ARG, "C:\\Users\\tester\\hwmusic"], { env: {} }), "C:\\Users\\tester\\hwmusic");

  assert.throws(() => dataDirFromArgv([DATA_DIR_ARG], { env: {} }), TypeError);
  assert.throws(() => dataDirFromArgv([DATA_DIR_ARG, ""], { env: {} }), TypeError);
  for (const relative of ["data", "./data", "..\\data"]) {
    assert.throws(() => dataDirFromArgv([DATA_DIR_ARG, relative], { env: {} }), TypeError, `${relative} 是相对路径`);
  }
});

test("数据目录：没有 argv 时用环境旋钮兜底，坏值一律当作未设置", () => {
  assert.equal(dataDirFromArgv([], { env: { [DATA_DIR_ENV]: "C:\\dev-data" } }), "C:\\dev-data");
  assert.equal(dataDirFromArgv([], { env: { [DATA_DIR_ENV]: "  " } }), null);
  assert.equal(dataDirFromArgv([], { env: { [DATA_DIR_ENV]: "relative" } }), null);
  assert.equal(dataDirFromArgv([], { env: {} }), null);
  assert.equal(dataDirFromArgv(["--other", "x"], { env: {} }), null);
});

test("数据目录：argv 优先于环境旋钮（宿主说了算）", () => {
  const dir = "C:\\from-argv";
  const argvResult = dataDirFromArgv([DATA_DIR_ARG, dir], { env: { [DATA_DIR_ENV]: "C:\\from-env" } });
  assert.equal(argvResult, dir);
});

test("双份钉死：Node 的 --data-dir 与 Rust sidecar.rs 的字面量相等", async () => {
  const rust = await readFile(join(repoRoot, "src-tauri", "src", "sidecar.rs"), "utf8");
  const match = /DATA_DIR_ARG\s*:[^=]*=\s*"([^"]+)"/.exec(rust);
  assert.ok(match, "Rust 源码里找不到 DATA_DIR_ARG 的字面量");
  assert.equal(DATA_DIR_ARG, match[1], "两侧参数名必须一致，否则 sidecar 永远读不到数据目录");
});
