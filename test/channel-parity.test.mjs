/**
 * R3 桥 · 双份一致性钉死（防 Node 与 Rust 两侧频道清单/超时漂移）。
 *
 * 做法：Node 侧直接 import 共享常量；Rust 侧按源码扫描提取字面量集合，两者必须相等。
 * 另有一条"反漂移"扫描：src/host、src/sidecar、src/renderer 内不得出现频道名字面量
 * （唯一真源只有 src/shared/*.ts，Rust 是刻意的镜像副本、由本文件钉住）。
 * 先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HOST_REQUEST_CHANNELS, REQUEST_CHANNELS } from "../src/shared/request-channels.ts";
import { BROADCAST_CHANNELS, CORE_EVENT } from "../src/shared/channels.ts";
import { CALL_TIMEOUT_MS } from "../src/host/bridge.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rustSource = (name) => readFileSync(`${repoRoot}src-tauri/src/${name}`, "utf8");

/** 只看生产代码：`#[cfg(test)]` 段落里的字面量是测试夹具，不算镜像副本。 */
function rustProduction(source) {
  const cut = source.indexOf("#[cfg(test)]");
  return cut === -1 ? source : source.slice(0, cut);
}

/** 从 Rust 源码里抽 `const NAME: &[&str] = &[ "a", "b" ];` 的字符串集合。 */
function rustStringArray(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*&\\[([\\s\\S]*?)\\]`));
  assert.ok(match, `Rust 源码里找不到 ${constName} 的字面量清单`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((found) => found[1]);
}

/** 从 Rust 源码里抽所有匹配前缀的频道字面量（含路由表分支，防"清单和分支各写一份"）。 */
function rustChannelLiterals(source, prefixPattern) {
  const literal = new RegExp(`"(${prefixPattern})[a-z][a-z-]*"`, "g");
  return [...new Set([...source.matchAll(literal)].map((found) => found[0].slice(1, -1)))];
}

function rustStringConst(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*"([^"]+)"`));
  assert.ok(match, `Rust 源码里找不到常量 ${constName}`);
  return match[1];
}

function rustNumberConst(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*:[^=]*=\\s*([0-9_]+)`));
  assert.ok(match, `Rust 源码里找不到常量 ${constName}`);
  return Number(match[1].replaceAll("_", ""));
}

function sorted(values) {
  return [...values].sort();
}

test("一致性：请求频道白名单（Node 共享常量 ↔ Rust commands.rs 全部 auth:/settings: 字面量）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "(?:auth|settings):");
  assert.deepEqual(sorted(rust), sorted(REQUEST_CHANNELS));
  assert.deepEqual(sorted(REQUEST_CHANNELS), [
    "auth:cancel-login",
    "auth:login",
    "auth:logout",
    "settings:get",
    "settings:set",
  ]);
});

test("一致性：宿主要求频道（Node 共享常量 ↔ Rust commands.rs 全部 host: 字面量）", () => {
  const rust = rustChannelLiterals(rustProduction(rustSource("commands.rs")), "(?:host):");
  assert.deepEqual(sorted(rust), sorted(HOST_REQUEST_CHANNELS));
  assert.deepEqual(sorted(HOST_REQUEST_CHANNELS), [
    "host:notify",
    "host:open-login",
    "host:secure-decrypt",
    "host:secure-encrypt",
  ]);
});

test("一致性：广播频道白名单（Node 共享常量 ↔ Rust bridge.rs 字面量，且两侧都钉死内容）", () => {
  const rust = rustStringArray(rustSource("bridge.rs"), "BROADCAST_CHANNELS");
  assert.deepEqual(sorted(rust), sorted(BROADCAST_CHANNELS));
  // 内容硬钉：只做两侧互比的话，"两侧一起为空/一起写错"也能过（这正是上一轮漏掉的）
  assert.deepEqual(sorted(rust), ["app:notice"]);
  assert.deepEqual(sorted(BROADCAST_CHANNELS), ["app:notice"]);
});

test("一致性：漏斗事件名与调用超时两侧相等", () => {
  assert.equal(rustStringConst(rustSource("bridge.rs"), "CORE_EVENT"), CORE_EVENT);
  assert.equal(CORE_EVENT, "core:event");
  assert.equal(rustNumberConst(rustSource("bridge.rs"), "CALL_TIMEOUT_SECS") * 1000, CALL_TIMEOUT_MS);
  assert.equal(CALL_TIMEOUT_MS, 60_000);
});

test("反漂移：Node 运行期代码里不得出现频道名字面量（只有 src/shared 是唯一真源）", () => {
  // 递归扫 src/ 下的运行期代码：src/shared/*.ts 是唯一真源（跳过），其余一律必须 import 常量
  const scanned = [];
  const walk = (relative) => {
    for (const entry of readdirSync(`${repoRoot}${relative}`, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(mjs|ts|tsx)$/.test(entry.name)) continue;
      if (child.startsWith("src/shared/")) continue;
      scanned.push(child);
    }
  };
  walk("src");
  assert.ok(scanned.length >= 8, `扫描范围异常，只拿到 ${scanned.length} 个文件：${scanned.join(", ")}`);

  // 只认普通引号里的字面量：注释里用反引号写的频道名是说明文字，不是第二份清单
  const literal = /["']((?:auth|settings|host):[a-z][a-z-]*)["']/g;
  const offenders = [];
  for (const relative of scanned) {
    const source = readFileSync(`${repoRoot}${relative}`, "utf8");
    for (const match of source.matchAll(literal)) offenders.push(`${relative}: ${match[1]}`);
  }
  assert.deepEqual(offenders, [], `频道名出现在运行期代码里（应从 src/shared 导入）：${offenders.join("; ")}`);
});
