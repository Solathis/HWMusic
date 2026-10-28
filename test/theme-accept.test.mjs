/**
 * 主题回执的单调 revision 合同，多个 webview 消费者共用这一份规则。
 * 读回是异步的，慢半拍的旧回执会盖掉刚收到的新广播，界面就从新主题跳回旧主题。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createThemeAcceptor } from "../src/renderer/features/theme/theme-accept.mjs";

test("R44e 主题接受器：revision 单调，旧回执盖不掉新广播", () => {
  const applied = [];
  const acceptor = createThemeAcceptor((choice) => applied.push(choice));

  assert.equal(acceptor.accept({ theme: "dark", revision: 3 }), true);
  assert.equal(acceptor.accept({ theme: "light", revision: 2 }), false, "旧 revision 的回执必须被拒");
  assert.deepEqual(applied, ["dark"]);

  assert.equal(acceptor.accept({ theme: "light", revision: 4 }), true, "更新的 revision 照收");
  assert.deepEqual(applied, ["dark", "light"]);

  assert.equal(acceptor.accept({ theme: "system", revision: 4 }), true, "同 revision 允许（同一笔的读回）");
  assert.deepEqual(applied, ["dark", "light", "system"]);
});

test("R44e 主题接受器：认不出的档位落系统档，认不出的载荷不改界面", () => {
  const applied = [];
  const acceptor = createThemeAcceptor((choice) => applied.push(choice));
  acceptor.accept({ theme: "neon", revision: 1 });
  assert.deepEqual(applied, ["system"], "认不出的档位按系统档（与 theme.mjs 同一条纪律）");
  const fresh = createThemeAcceptor((choice) => applied.push(choice));
  fresh.accept(null);
  assert.deepEqual(applied.slice(1), ["system"], "形状问题不抛：按系统档落地");
  const another = createThemeAcceptor((choice) => applied.push(choice));
  another.accept("dark");
  assert.deepEqual(applied.slice(2), ["system"], "顶层不是对象的载荷也按系统档（不猜）");
});

test("R44e 主题接受器：没有 revision 的旧广播照收，但不把水位往回退", () => {
  const applied = [];
  const acceptor = createThemeAcceptor((choice) => applied.push(choice));
  assert.equal(acceptor.accept({ theme: "dark" }), true, "老形状（无编号）照旧收");
  assert.equal(acceptor.revision(), -1, "无编号的载荷不推进水位");
  assert.equal(acceptor.accept({ theme: "light", revision: 2 }), true);
  assert.equal(acceptor.accept({ theme: "system" }), true, "无编号照收（C 阶段的广播没有编号）");
  assert.equal(acceptor.revision(), 2, "水位仍停在 2（不许被无编号载荷拉回去）");
  assert.equal(acceptor.accept({ theme: "dark", revision: 1 }), false, "带编号的旧回执仍拒");
  assert.deepEqual(applied, ["dark", "light", "system"]);
});

test("R44e 主题接受器：失败路径不许在收到新 revision 之后回落系统档", () => {
  const applied = [];
  const acceptor = createThemeAcceptor((choice) => applied.push(choice));
  acceptor.accept({ theme: "dark", revision: 5 });
  // 读回失败时调用方的落点必须问接受器：已经有关键 revision → 不改界面
  assert.equal(acceptor.revision(), 5);
  assert.equal(acceptor.acceptOnFailure("system"), false);
  assert.deepEqual(applied, ["dark"], "catch 不许把已收到的暗色打回系统档");

  const fresh = createThemeAcceptor((choice) => applied.push(choice));
  assert.equal(fresh.acceptOnFailure("system"), true, "还没收到任何编号时按系统档（门禁的既有行为）");
  assert.deepEqual(applied, ["dark", "system"]);
});
