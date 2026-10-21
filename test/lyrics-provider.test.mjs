/**
 * R41 · 第三方歌词的匹配器（src/main/lyrics-provider.mjs）。
 *
 * 这一层的每一条规则都对应一个**具体的错词场景**——"显示错歌的词比没有词更糟"不是一句口号：
 * - `安静下来` vs `安静`（包含关系）：标题不精确 → 必须有时长佐证，否则拒绝；
 * - 同名不同人（翻唱/同名单曲）：艺人硬错配 → 直接拒绝；
 * - 30 秒的试听片段/铃声：那个时长不构成佐证；
 * - 分数门槛：三条信号凑不够两条半 → 不显示。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_SCORE,
  decodeKugouLyrics,
  kugouCandidates,
  kugouCandidatesById,
  kugouDownloadUrl,
  kugouLyricSearchUrl,
  kugouSearchUrl,
  lrclibCandidates,
  lrclibSearchUrl,
  normalizeName,
  pickCandidate,
  scoreCandidate,
} from "../src/main/lyrics-provider.mjs";

const QUERY = { title: "安静", artist: "周杰伦", durationSeconds: 327 };

test("匹配器（R41）：归一化去掉括号注释、大小写、标点与空白", () => {
  assert.equal(normalizeName("安静 (Live)"), "安静");
  assert.equal(normalizeName("【伴奏】安静"), "安静");
  assert.equal(normalizeName("Hello, World!"), "helloworld");
  assert.equal(normalizeName("A - B_C"), "abc");
  assert.equal(normalizeName(null), "", "空值回空串（不抛）");
});

test("匹配器（R41）：标题精确 + 艺人精确 + 时长接近 = 高分；硬错配一律 null", () => {
  const exact = scoreCandidate({ title: "安静", artists: ["周杰伦"], durationSeconds: 329 }, QUERY);
  assert.ok(exact >= 1.3 + 0.9 + 0.6, `三条信号全中应当接近满分：${exact}`);

  // 标题包含但时长差得多：拒绝（"安静下来"不是"安静"）
  assert.equal(scoreCandidate({ title: "安静下来", artists: ["周杰伦"], durationSeconds: 200 }, QUERY), null);
  // 标题包含（非精确）但时长对得上：接受，但分数比精确标题低
  const loose = scoreCandidate({ title: "安静钢琴版", artists: ["周杰伦"], durationSeconds: 330 }, QUERY);
  assert.ok(loose !== null && loose < exact, `宽松标题该低一些：${loose} vs ${exact}`);

  // 艺人硬错配：绝不显示
  assert.equal(scoreCandidate({ title: "安静", artists: ["别的歌手"], durationSeconds: 327 }, QUERY), null);
  // 标题完全不对
  assert.equal(scoreCandidate({ title: "晴天", artists: ["周杰伦"], durationSeconds: 327 }, QUERY), null);
  // 缺标题 / 缺查询标题
  assert.equal(scoreCandidate({ title: "", durationSeconds: 327 }, QUERY), null);
  assert.equal(scoreCandidate({ title: "安静", durationSeconds: 327 }, { title: "" }), null);
});

test("匹配器（R41）：时长只认『两边都 > 30 秒』的样本；差 > 25 秒要扣分", () => {
  const short = { title: "安静", artists: ["周杰伦"], durationSeconds: 25 };
  const full = { title: "安静", artists: ["周杰伦"], durationSeconds: 327 };
  // 精确标题 + 精确艺人：即使时长样本不可用（25 秒）也够门槛，只是少了时长那部分分
  assert.ok(scoreCandidate(short, QUERY) < scoreCandidate(full, QUERY));

  const far = scoreCandidate({ title: "安静", artists: ["周杰伦"], durationSeconds: 327 + 40 }, QUERY);
  const near = scoreCandidate({ title: "安静", artists: ["周杰伦"], durationSeconds: 327 + 2 }, QUERY);
  assert.ok(far < near, "差 40 秒要被扣分（-0.5）");
});

test("匹配器（R41）：多艺人写法都拆得开（顿号/斜杠/&/feat.）", () => {
  const query = { title: "歌", artist: "A、B", durationSeconds: 200 };
  assert.ok(scoreCandidate({ title: "歌", artists: ["B"], durationSeconds: 200 }, query) !== null);
  assert.ok(scoreCandidate({ title: "歌", artist: "A feat. B", durationSeconds: 200 }, query) !== null);
  assert.equal(scoreCandidate({ title: "歌", artists: ["C"], durationSeconds: 200 }, query), null);
});

test("匹配器（R41）：pickCandidate 取最高分且必须过门槛——不降级取第一个", () => {
  const candidates = [
    { title: "安静", artists: ["别的歌手"], durationSeconds: 327, id: "bad" },
    { title: "安静", artists: ["周杰伦"], durationSeconds: 328, id: "good" },
    { title: "安静", artists: ["周杰伦"], durationSeconds: 300, id: "worse" },
  ];
  const picked = pickCandidate(candidates, QUERY);
  assert.equal(picked.id, "good");
  assert.ok(picked.score >= MIN_SCORE);

  // 标题精确 + 艺人精确、但**两边都没有可信时长**：仍然过门槛（精确那两条信号自己够）
  const noDuration = pickCandidate([{ title: "安静", artists: ["周杰伦"], id: "nodur" }], QUERY);
  assert.equal(noDuration.id, "nodur");
  assert.equal(noDuration.score, 2.2, "1.3（精确标题）+ 0.9（精确艺人）");

  // 宽松标题 + 时长的佐证**不可用** → 拒绝（"安静钢琴版"不能顶替"安静"）
  assert.equal(pickCandidate([{ title: "安静钢琴版", artists: ["周杰伦"] }], QUERY), null);
  // 宽松标题 + 时长差 8 秒以上 → 拒绝
  assert.equal(pickCandidate([{ title: "安静钢琴版", artists: ["周杰伦"], durationSeconds: 500 }], QUERY), null);
  // 括号注释会被归一化剥掉 —— "(Live)" / "【伴奏】"都不影响标题判定（蓝本同一条规则）
  assert.ok(pickCandidate([{ title: "安静 (Live)", artists: ["周杰伦"], durationSeconds: 500 }], QUERY) !== null);
  // 只有宽松艺人（互相包含）也能凑够门槛：宽松标题 0.9 + 宽松艺人 0.6 + 时长 0.6 = 2.1
  assert.ok(pickCandidate([{ title: "安静钢琴版", artists: ["周杰伦乐队"], durationSeconds: 330 }], QUERY) !== null);

  assert.equal(pickCandidate([], QUERY), null);
  assert.equal(pickCandidate(null, QUERY), null, "非数组不抛");
  assert.equal(MIN_SCORE, 1.5, "门槛是契约（蓝本同值）");
});

test("匹配器（R41）：酷狗 URL 与候选解析（Duration 是秒；没哈希的条目丢掉）", () => {
  const search = new URL(kugouSearchUrl({ title: "安静", artist: "周杰伦" }));
  assert.equal(search.origin + search.pathname, "https://songsearch.kugou.com/song_search_v2");
  assert.equal(search.searchParams.get("keyword"), "安静 周杰伦");
  assert.equal(search.searchParams.get("pagesize"), "20");

  const candidates = kugouCandidates({
    data: {
      lists: [
        { SongName: "安静", SingerName: "周杰伦", Duration: 327, FileHash: "HASH1" },
        { SongName: "没有哈希", SingerName: "周杰伦", Duration: 200 },
      ],
    },
  });
  assert.equal(candidates.length, 1, "没有 FileHash 的条目进不了下一步");
  assert.deepEqual(candidates[0], { title: "安静", artists: ["周杰伦"], durationSeconds: 327, hash: "HASH1" });
  assert.deepEqual(kugouCandidates({}), [], "坏形状回空数组（不抛）");

  const index = new URL(kugouLyricSearchUrl("HASH1"));
  assert.equal(index.searchParams.get("hash"), "HASH1");
  assert.equal(index.searchParams.get("man"), "yes");

  const byId = kugouCandidatesById({ candidates: [{ id: 1, accesskey: "KEY", song: "安静", singer: "周杰伦", duration: 327000 }] });
  assert.deepEqual(byId[0], { id: "1", accesskey: "KEY", title: "安静", artists: ["周杰伦"], durationSeconds: 327 });
  assert.deepEqual(kugouCandidatesById({ candidates: [{ song: "没钥匙" }] }), [], "缺 id/accesskey 的条目丢掉");

  const download = new URL(kugouDownloadUrl("1", "KEY"));
  assert.equal(download.searchParams.get("fmt"), "lrc");
  assert.equal(download.searchParams.get("charset"), "utf8");
});

test("匹配器（R41）：酷狗下载响应是 base64（有的版本还带 BOM）；坏形状回 null", () => {
  const text = "[00:01.00]安静\n";
  assert.equal(decodeKugouLyrics({ content: Buffer.from(text, "utf8").toString("base64") }), text);
  assert.equal(
    decodeKugouLyrics({ content: Buffer.from(`\uFEFF${text}`, "utf8").toString("base64") }),
    text,
    "解出来的 BOM 要剥掉",
  );
  assert.equal(decodeKugouLyrics({ content: "" }), null);
  assert.equal(decodeKugouLyrics({}), null);
  assert.equal(decodeKugouLyrics({ content: Buffer.from("   ", "utf8").toString("base64") }), null, "全空白不算歌词");
});

test("匹配器（R41）：lrclib 候选取舍——纯音乐与没有同步歌词的条目丢掉（plainLyrics 不算）", () => {
  const url = new URL(lrclibSearchUrl({ title: "安静", artist: "周杰伦" }));
  assert.equal(url.origin + url.pathname, "https://lrclib.net/api/search");
  assert.equal(url.searchParams.get("q"), "安静 周杰伦");

  const candidates = lrclibCandidates([
    { trackName: "安静", artistName: "周杰伦", duration: 327, syncedLyrics: "[00:01.00]词", plainLyrics: "词" },
    { trackName: "纯音乐", artistName: "周杰伦", duration: 200, instrumental: true, syncedLyrics: "[00:01.00]x" },
    { trackName: "没歌词", artistName: "周杰伦", duration: 200 },
    // R41a：只有纯文本歌词（没有 syncedLyrics）→ 丢掉。这条路在落盘判据那一层必然被判空
    //（`hasTimedLyricLine` 要求时间戳行），所以是**非同步歌词暂不支持**，不是"退一步用纯文本"。
    { trackName: "只有纯文本", artistName: "周杰伦", duration: 200, syncedLyrics: null, plainLyrics: "词\n没有时间戳" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "安静");
  assert.equal(candidates[0].syncedLyrics, "[00:01.00]词");
  assert.equal(
    Object.keys(candidates[0]).includes("plainLyrics"),
    false,
    "候选里不该留下 plainLyrics（它取不到，留着只会让人以为还能退到它）",
  );
  assert.deepEqual(lrclibCandidates({}), [], "坏形状回空数组（不抛）");
});
