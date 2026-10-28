/**
 * 启动日志一行看明白登录态持久化：数据根是哪个路径、它哪来的、根里有没有 session.enc，以及恢复走到的档位。
 * 读不到 ≠ 不存在。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DATA_DIR_ARG, DATA_DIR_ENV } from "../src/main/data-dir.mjs";
import { SESSION_FILE_NAME } from "../src/main/session-store.mjs";
import {
  DATA_DIR_SOURCE,
  SESSION_DIAG_LABEL,
  dataDirSource,
  dataDirSourceLabel,
  readSessionFileState,
  sessionDiagnosticLine,
} from "../src/main/session-diagnostic.mjs";

/** 一份"什么都正常"的诊断输入（各用例只改自己关心的那一格）。 */
function facts(extra = {}) {
  return {
    dataDir: "C:\\Users\\tester\\AppData\\Roaming\\com.hwmusic.desktop",
    source: DATA_DIR_SOURCE.argv,
    sessionFile: { exists: true, size: 1234, mtime: "2026-10-20T13:00:00.000Z" },
    restore: { loggedIn: true, reason: "restored", verified: true },
    ...extra,
  };
}

test("诊断行：数据根、它的来源、session.enc、恢复档位四件事都在同一行里", () => {
  const line = sessionDiagnosticLine(facts());
  assert.ok(line.startsWith(`${SESSION_DIAG_LABEL}：`), "一条日志一眼可判：先说这是哪件事：{line}");
  assert.ok(line.includes("C:\\Users\\tester\\AppData\\Roaming\\com.hwmusic.desktop"), line);
  assert.ok(line.includes(DATA_DIR_ARG), "旋钮/参数的名字要写出来（读日志的人才知道去哪儿看）");
  assert.ok(line.includes(SESSION_FILE_NAME) && line.includes("1234"), line);
  assert.ok(line.includes("已登录"), "恢复走到的档位要如实写出来");
});

test("诊断行：数据根漂移一眼可判——同一个进程里根是哪来的、那个根里有没有会话", () => {
  // 控制器调试那一档：旋钮指到隔离根，会话在那里
  const debug = sessionDiagnosticLine(
    facts({ source: DATA_DIR_SOURCE.env, dataDir: "E:\\repo\\.tmp\\live-data" }),
  );
  assert.ok(debug.includes(DATA_DIR_ENV), debug);
  assert.ok(debug.includes(".tmp\\live-data"), debug);

  // 用户自跑那一档：旋钮没生效，根换了一个，会话文件**在那个根里没有**
  const user = sessionDiagnosticLine({
    dataDir: "C:\\Users\\tester\\AppData\\Roaming\\com.hwmusic.desktop",
    source: DATA_DIR_SOURCE.none,
    sessionFile: { exists: false, size: null, mtime: null },
    restore: { loggedIn: false, reason: "no_session", verified: false },
  });
  assert.ok(user.includes("不存在"), "根里没有会话文件是**最要紧**的那一格：{user}");
  assert.ok(user.includes("no_session"), user);
  assert.ok(!user.includes(DATA_DIR_ENV), "旋钮没设就不许提它（提了会让人以为它生效了）");
});

test("诊断行：没有数据根时如实说「无从查起」，不编造一个路径", () => {
  const line = sessionDiagnosticLine({
    dataDir: null,
    source: DATA_DIR_SOURCE.none,
    sessionFile: { exists: false, size: null, mtime: null },
    restore: { loggedIn: false, reason: "no_session", verified: false },
  });
  assert.ok(line.includes("(没有)"), line);
  assert.ok(line.includes("无从查起"), "没有根就没有 session.enc 这回事：不许说「不存在」（那是另一件事）");
});

test("诊断行：读不到 ≠ 不存在（stat 失败要如实说是「查不了」）", () => {
  const line = sessionDiagnosticLine(
    facts({ sessionFile: { exists: null, size: null, mtime: null, error: "EACCES: permission denied" } }),
  );
  assert.ok(line.includes("查不了"), line);
  assert.ok(line.includes("EACCES"), "原因要带出来（否则这一行等于没说）");
  assert.ok(!line.includes("不存在"), "读不到时不许写成「不存在」：一个是环境问题，一个是真没登录过");
});

test("诊断行：恢复没跑（restore 为空）时说「未执行」，不许说「未登录」", () => {
  const line = sessionDiagnosticLine(facts({ restore: null }));
  assert.ok(line.includes("未执行"), line);

  // 恢复失败（有 error）：把类别与那句话带出来（会话在、但解不开/验证不了，处置完全不同）
  const failed = sessionDiagnosticLine(
    facts({
      restore: {
        loggedIn: false,
        reason: "session_unreadable",
        verified: false,
        error: { kind: "invalid_cipher", message: "密文解不开（DPAPI 换了用户或机器）" },
      },
    }),
  );
  assert.ok(failed.includes("session_unreadable"), failed);
  assert.ok(failed.includes("invalid_cipher"), failed);
});

test("诊断行：一条日志一行（NDJSON 的 stdout 是协议通道，日志走 stderr 且不许换行）", () => {
  const line = sessionDiagnosticLine(facts());
  assert.ok(!line.includes("\n") && !line.includes("\r"), "日志行不许带换行：它会进 stderr 日志文件");
});

// ---------------------------------------------------------------------------
// 数据根的来源判定：与 `data-dir.mjs` 的解析逐档对应（不许有第二份"哪来的"
// ---------------------------------------------------------------------------

test("来源判定：宿主参数 > 环境旋钮 > 都没有，三档与 dataDirFromArgv 的解析一致", () => {
  assert.equal(dataDirSource([DATA_DIR_ARG, "C:\\x"], { env: {} }), DATA_DIR_SOURCE.argv);
  assert.equal(
    dataDirSource([DATA_DIR_ARG, "C:\\x"], { env: { [DATA_DIR_ENV]: "C:\\y" } }),
    DATA_DIR_SOURCE.argv,
    "两个都在时，参数优先（与 dataDirFromArgv 同一条优先级）",
  );
  assert.equal(dataDirSource([], { env: { [DATA_DIR_ENV]: "C:\\y" } }), DATA_DIR_SOURCE.env);
  assert.equal(dataDirSource([], { env: { [DATA_DIR_ENV]: "  " } }), DATA_DIR_SOURCE.none, "空白旋钮等于没设");
  assert.equal(dataDirSource([], { env: {} }), DATA_DIR_SOURCE.none);
  assert.equal(dataDirSource(["--other", "x"], { env: {} }), DATA_DIR_SOURCE.none);

  for (const source of Object.values(DATA_DIR_SOURCE)) {
    assert.equal(typeof dataDirSourceLabel(source), "string");
    assert.ok(dataDirSourceLabel(source).length > 0);
  }
});

// ---------------------------------------------------------------------------
// 会话文件的存在性：**只 stat，不读内容**（信封里是凭据密文）
// ---------------------------------------------------------------------------

test("会话文件：只查存在性与大小，不读内容", async () => {
  const seen = [];
  const state = await readSessionFileState("C:\\root", {
    stat: async (path) => {
      seen.push(path);
      return { size: 42, mtimeMs: Date.UTC(2026, 9, 20, 13, 0, 0) };
    },
  });
  assert.deepEqual(seen, [`C:\\root\\${SESSION_FILE_NAME}`], "查的就是数据根下那一个文件");
  assert.equal(state.exists, true);
  assert.equal(state.size, 42);
  assert.equal(state.mtime, "2026-10-20T13:00:00.000Z");
});

test("会话文件：ENOENT = 不存在（不是错误）；别的失败 = 查不了", async () => {
  const missing = await readSessionFileState("C:\\root", {
    stat: async () => {
      const cause = new Error("no such file");
      cause.code = "ENOENT";
      throw cause;
    },
  });
  assert.equal(missing.exists, false);
  assert.equal(missing.error, undefined, "没有会话文件是很正常的一件事，不该记成错误");

  const denied = await readSessionFileState("C:\\root", {
    stat: async () => {
      const cause = new Error("access denied");
      cause.code = "EACCES";
      throw cause;
    },
  });
  assert.equal(denied.exists, null, "读不到是「不知道」，不是「不存在」");
  assert.match(denied.error, /access denied/);

  // 没有数据根：没有可查的地方（也不许去猜一个）
  const none = await readSessionFileState(null, { stat: async () => assert.fail("没有根就不该去 stat") });
  assert.equal(none.exists, null);
});
