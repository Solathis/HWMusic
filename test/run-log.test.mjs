/**
 * 设置页运行日志的渲染层纯逻辑：级别、筛选与脱敏兜底。
 * 两路来源在此归一：日志文件已脱敏且带级别；`app:notice` 没有级别，一律 info、来源「提示」。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NOTICE_SOURCE,
  RUN_LOG_DEFAULT_LEVELS,
  RUN_LOG_EMPTY_TEXT,
  RUN_LOG_FAILURE_TEXT,
  RUN_LOG_LEVELS,
  RUN_LOG_LEVEL_BADGE,
  RUN_LOG_LEVEL_LABELS,
  RUN_LOG_NO_MATCH_TEXT,
  filterRunLogEntries,
  isLevelVisible,
  levelOf,
  maskSecrets,
  mergeRunLogEntries,
  normalizeRunLogEntries,
  noticeEntriesToRunLog,
  runLogCountText,
  runLogTimeLabel,
  toggleLevel,
} from "../src/renderer/features/settings/run-log.mjs";

const FILE_ENTRIES = [
  { time: "2026-10-26 05:12:30", level: "info", source: "hwmusic_core", message: "已就绪" },
  { time: "2026-10-26 05:12:31", level: "warn", source: "hwmusic_core", message: "代理不可用，按直连" },
  { time: "2026-10-26 05:12:32", level: "error", source: "huawei_music_desktop_lib::commands", message: "core_get_autostart 未完成" },
  { time: "2026-10-26 05:12:33", level: "debug", source: "tao", message: "窗口几何恢复" },
];

test("级别：四档归一，认不出的按 info（界面不许发明第五档）", () => {
  assert.deepEqual(RUN_LOG_LEVELS, ["debug", "info", "warn", "error"]);
  assert.equal(levelOf("ERROR"), "error");
  assert.equal(levelOf("Warn"), "warn");
  assert.equal(levelOf("trace"), "debug");
  assert.equal(levelOf("info"), "info");
  for (const bad of [null, undefined, "", "fatal", 42, {}]) {
    assert.equal(levelOf(bad), "info", `认不出的级别按 info：${JSON.stringify(bad)}`);
  }
  // 每一档都有中文标签与官方 Badge 变体（不许自定义颜色类）
  for (const level of RUN_LOG_LEVELS) {
    assert.equal(typeof RUN_LOG_LEVEL_LABELS[level], "string");
    assert.ok(RUN_LOG_LEVEL_LABELS[level].trim() !== "", level);
    assert.ok(
      ["default", "secondary", "destructive", "outline", "ghost", "link"].includes(RUN_LOG_LEVEL_BADGE[level]),
      `${level} 的 Badge 变体必须是 shadcn 官方的：${RUN_LOG_LEVEL_BADGE[level]}`,
    );
  }
  assert.deepEqual(
    new Set(RUN_LOG_LEVELS.map((level) => RUN_LOG_LEVEL_BADGE[level])).size,
    4,
    "四档要能一眼分开（同一个变体等于没标）",
  );
  assert.deepEqual(RUN_LOG_DEFAULT_LEVELS, ["info", "warn", "error"], "默认不显示 debug");
});

test("宿主载荷：数组与 {entries} 都认，坏形状给空列表", () => {
  assert.equal(normalizeRunLogEntries(FILE_ENTRIES).length, 4);
  assert.equal(normalizeRunLogEntries({ entries: FILE_ENTRIES }).length, 4);
  for (const bad of [null, undefined, "nope", 42, [null, 7, "x"]]) {
    assert.deepEqual(normalizeRunLogEntries(bad), [], `坏入参不许抛：${JSON.stringify(bad)}`);
  }

  const normalized = normalizeRunLogEntries([
    { time: "2026-10-26 05:12:30", level: "WARN", source: "hwmusic_core", message: "代理不可用" },
    { source: null, message: 42 },
  ]);
  assert.equal(normalized.length, 1, "没有 message 的条目显示不出东西，直接丢");
  assert.equal(normalized[0].level, "warn");
  assert.equal(normalized[0].id, "file-0", "每条要有稳定的 key（React 列表用）");
  assert.equal(normalized[0].message, "代理不可用", "展示用的就是打码后的那一份");
});

test("提示条目：app:notice 没有级别 → info + 来源「提示」", () => {
  const entries = noticeEntriesToRunLog([
    { id: 1, text: "代理按环境变量设置生效" },
    { id: 2, text: "   " },
    null,
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, NOTICE_SOURCE);
  assert.equal(entries[0].level, "info");
  assert.equal(entries[0].message, "代理按环境变量设置生效");
  assert.notEqual(NOTICE_SOURCE, "", "来源不能空着（空来源会被当成「文件里的」）");
});

test("合并：文件里的在前、提示在后，key 两路不撞", () => {
  const merged = mergeRunLogEntries(FILE_ENTRIES, [{ id: 1, text: "提示一条" }]);
  assert.equal(merged.length, 5);
  assert.equal(merged[4].source, NOTICE_SOURCE, "提示在最后（它是最新发生的）");
  const ids = merged.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `key 必须唯一：${ids.join(",")}`);
  assert.deepEqual(
    mergeRunLogEntries(null, null),
    [],
    "两路都没有就是空列表（空态由界面说）",
  );
});

test("筛选：级别多选 + 文本子串（message 与 source 都算）", () => {
    const all = normalizeRunLogEntries(FILE_ENTRIES);
    assert.deepEqual(
      filterRunLogEntries(all, { levels: RUN_LOG_DEFAULT_LEVELS, query: "" }).map((entry) => entry.level),
      ["info", "warn", "error"],
      "默认三档（debug 不显示）",
    );
    assert.deepEqual(
      filterRunLogEntries(all, { levels: ["error"], query: "" }).map((entry) => entry.level),
      ["error"],
    );
    assert.deepEqual(
      filterRunLogEntries(all, { levels: RUN_LOG_LEVELS, query: "代理" }).map((entry) => entry.level),
      ["warn"],
    );
    assert.deepEqual(
      filterRunLogEntries(all, { levels: RUN_LOG_LEVELS, query: "HWMUSIC_CORE" }).map((entry) => entry.source),
      ["hwmusic_core", "hwmusic_core"],
      "文本也搜来源，且大小写不敏感",
    );
    assert.deepEqual(
      filterRunLogEntries(all, { levels: RUN_LOG_LEVELS, query: "   " }).length,
      4,
      "空白查询等于不筛",
    );
    // 没有级别条件（或坏形状）≠ 全筛掉
    assert.equal(filterRunLogEntries(all, { query: "" }).length, 4);
    assert.equal(filterRunLogEntries(all, { levels: null, query: "" }).length, 4);
    assert.equal(filterRunLogEntries(all, {}).length, 4);
    // 一档都不选时如实显示"没有匹配的日志"（不是偷偷显示全部）
    assert.deepEqual(filterRunLogEntries(all, { levels: [], query: "" }), []);

    assert.equal(filterRunLogEntries(all, { levels: RUN_LOG_LEVELS, query: "代理" })[0].message,
      "代理不可用，按直连", "命中项原样返回（不复制、不改写）");
  });

test("级别开关：最后一档不能被取消（否则界面会显示成「筛出 0 条」却没提示）", () => {
  assert.deepEqual(toggleLevel(["info", "warn"], "info"), ["warn"]);
  assert.deepEqual(toggleLevel(["warn"], "warn"), ["warn"], "取消最后一档不动");
  assert.deepEqual(toggleLevel([], "warn"), ["warn"], "一档都没有时点一下要能加回来");
  assert.deepEqual(toggleLevel(RUN_LOG_LEVELS, "debug").sort(), ["info", "warn", "error"].sort());
  assert.deepEqual(toggleLevel(["debug", "info"], "error"), ["debug", "info", "error"], "加回来按四档顺序");
  assert.equal(isLevelVisible(["info"], "info"), true);
  assert.equal(isLevelVisible(["info"], "debug"), false);
  assert.equal(isLevelVisible(null, "info"), true, "坏形状当「不筛」");
});

test("计数：两个数字都给（只报筛出来的条数就分不清「只有这些」与「被筛掉了」）", () => {
  assert.equal(runLogCountText(3, 20), "3 / 20 条");
  assert.equal(runLogCountText(0, 0), "0 / 0 条");
  for (const bad of [null, undefined, -1, 1.5, "3", NaN]) {
    assert.equal(runLogCountText(bad, 5), "0 / 5 条", `坏入参不许漏成 NaN：${String(bad)}`);
  }
});

test("时间：显示时:分:秒，认不出的原样给（不显示 Invalid Date）", () => {
  assert.equal(runLogTimeLabel("2026-10-26 05:12:33"), "05:12:33");
  assert.equal(runLogTimeLabel(""), "");
  assert.equal(runLogTimeLabel("坏了"), "坏了");
  assert.equal(runLogTimeLabel(null), "");
});

test("脱敏兜底：宿主已打码，界面这一层再挡一次（假 token 样本）", () => {
  const fake = "GET https://x/y?token=fake-token-123456&page=2 Authorization: Bearer abcdef123456";
  const masked = maskSecrets(fake);
  assert.ok(!masked.includes("fake-token-123456"), `token 值必须挡住：${masked}`);
  assert.ok(!masked.includes("abcdef123456"), `Bearer 值必须挡住：${masked}`);
  assert.match(masked, /page=2/, "只挡凭据，其余文字保留（不然排障没得看）");

  assert.equal(maskSecrets("已就绪（频道 21 条）"), "已就绪（频道 21 条）", "正常文本不许改");
  assert.equal(maskSecrets("token=***"), "token=***", "幂等：已打码的不再动");
  assert.equal(maskSecrets(null), "");

  const normalized = normalizeRunLogEntries([
    { time: "", level: "info", source: "hwmusic_core", message: "登录失败 token=leak-me-9999" },
  ]);
  assert.ok(
    !JSON.stringify(normalized).includes("leak-me-9999"),
    `归一化后的条目不许带凭据（界面直接渲染的就是这一份）：${JSON.stringify(normalized)}`,
  );
});

test("三种说法各一句话，且都给出下一步", () => {
  for (const [name, text] of [
    ["空态", RUN_LOG_EMPTY_TEXT],
    ["筛空", RUN_LOG_NO_MATCH_TEXT],
    ["读失败", RUN_LOG_FAILURE_TEXT],
  ]) {
    assert.ok(text.trim() !== "", `${name} 不能是空话`);
    assert.ok(!/敬请期待|即将上线/.test(text), `${name} 不许画饼：${text}`);
  }
  assert.notEqual(RUN_LOG_EMPTY_TEXT, RUN_LOG_NO_MATCH_TEXT, "「还没有」与「被筛掉了」不是同一句");
  assert.match(RUN_LOG_EMPTY_TEXT, /刷新/, "空态要给出下一步：刷新");
  assert.match(RUN_LOG_FAILURE_TEXT, /刷新/, "失败态要给出下一步：刷新");
});
