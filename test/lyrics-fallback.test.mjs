/**
 * 第三方歌词回退的网络层：匹配严格、失败静默、不缓存失败、UA 只说明客户端且不带凭据。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LYRICS_FALLBACK_TIMEOUT_MS, LYRICS_FALLBACK_USER_AGENT, createThirdPartyLyrics } from "../src/main/lyrics-fallback.mjs";

const QUERY = { title: "安静", artist: "周杰伦", durationSeconds: 327 };
const LRC = "[00:01.00]安静\n[00:05.00]第二行\n";

const jsonResponse = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/** 按 URL 片段分派的 fetch 桩（记录每次请求的 url/init）。 */
function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return { calls, fetchImpl };
}

const kugouFlow = (lyricsText = LRC) => (url) => {
  if (url.includes("song_search_v2")) {
    return jsonResponse({
      data: { lists: [{ SongName: "安静", SingerName: "周杰伦", Duration: 327, FileHash: "HASH1" }] },
    });
  }
  if (url.includes("krcs.kugou.com/search")) {
    return jsonResponse({ candidates: [{ id: 7, accesskey: "KEY", song: "安静", singer: "周杰伦", duration: 327000 }] });
  }
  if (url.includes("lyrics.kugou.com/download")) {
    return jsonResponse({ content: Buffer.from(lyricsText, "utf8").toString("base64") });
  }
  throw new Error(`不该请求：${url}`);
};

test("回退（R41）：酷狗三步走通 → 返回文档（source/matchedTitle/matchedArtist 齐全）", async () => {
  const { calls, fetchImpl } = scriptedFetch(kugouFlow());
  const fallback = createThirdPartyLyrics({ fetchImpl });

  const doc = await fallback(QUERY);
  assert.equal(doc.text, "[00:01.00]安静\n[00:05.00]第二行");
  assert.equal(doc.source, "kugou");
  assert.equal(doc.format, "lrc");
  assert.equal(doc.matchedTitle, "安静");
  assert.equal(doc.matchedArtist, "周杰伦");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).hostname),
    ["songsearch.kugou.com", "krcs.kugou.com", "lyrics.kugou.com"],
    "顺序：搜索 → 索引 → 下载",
  );
});

test("回退（R41）：请求头克制——只有 accept / UA / referer，**没有任何凭据**", async () => {
  const { calls, fetchImpl } = scriptedFetch(kugouFlow());
  await createThirdPartyLyrics({ fetchImpl })(QUERY);

  for (const call of calls) {
    const headers = call.init.headers ?? {};
    assert.equal(headers["user-agent"], LYRICS_FALLBACK_USER_AGENT);
    const joined = `${call.url} ${JSON.stringify(headers)}`;
    for (const forbidden of ["token", "authorization", "musicSession", "snsUserID", "cookie"]) {
      assert.equal(
        joined.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `第三方请求里不许出现 ${forbidden}：${joined}`,
      );
    }
  }
  assert.equal(calls[0].init.redirect, "error", "不跟随跳转");
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["accept", "referer", "user-agent"]);
});

test("回退（R41）：酷狗命中不了就在 lrclib 上再试一次（两个来源是依次试，不是二选一）", async () => {
  const { calls, fetchImpl } = scriptedFetch((url) => {
    if (url.includes("songsearch.kugou.com")) {
      // 酷狗给的候选是别人的翻唱 → 严格匹配拒绝
      return jsonResponse({ data: { lists: [{ SongName: "安静", SingerName: "翻唱歌手", Duration: 327, FileHash: "HASH1" }] } });
    }
    if (url.includes("lrclib.net")) {
      return jsonResponse([
        { trackName: "安静", artistName: "周杰伦", duration: 328, syncedLyrics: LRC, plainLyrics: "安静" },
      ]);
    }
    throw new Error(`不该请求：${url}`);
  });
  const doc = await createThirdPartyLyrics({ fetchImpl })(QUERY);
  assert.equal(doc.source, "lrclib");
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), ["songsearch.kugou.com", "lrclib.net"]);
});

test("回退（R41a）：lrclib 只有**纯文本**歌词（没有 syncedLyrics）→ 跳过（非同步歌词暂不支持）", async () => {
  // 纯文本歌词在落盘判据那一层必然判空，所以钉的是「确实不被采用」，而不是「退一步用纯文本」。
  const plainOnly = scriptedFetch((url) => {
    if (url.includes("kugou")) return jsonResponse({});
    return jsonResponse([{ trackName: "安静", artistName: "周杰伦", duration: 327, syncedLyrics: null, plainLyrics: "安静\n没有时间戳" }]);
  });
  const doc = await createThirdPartyLyrics({ fetchImpl: plainOnly.fetchImpl })(QUERY);
  assert.equal(doc, null, "纯文本歌词取不到（判据要求时间戳行）");
  assert.deepEqual(
    plainOnly.calls.map((call) => new URL(call.url).hostname),
    ["songsearch.kugou.com", "lrclib.net"],
    "两个来源都试过了（不是提前放弃）",
  );

  // 两份都没有 → 同样跳过
  const noLyrics = scriptedFetch((url) =>
    url.includes("kugou") ? jsonResponse({}) : jsonResponse([{ trackName: "安静", artistName: "周杰伦", duration: 327 }]),
  );
  assert.equal(await createThirdPartyLyrics({ fetchImpl: noLyrics.fetchImpl })(QUERY), null);

  // 有 syncedLyrics 的同一条（plainLyrics 也在）→ 采用，且文本就是 syncedLyrics
  const synced = scriptedFetch((url) => {
    if (url.includes("kugou")) return jsonResponse({});
    return jsonResponse([{ trackName: "安静", artistName: "周杰伦", duration: 327, syncedLyrics: LRC, plainLyrics: "安静" }]);
  });
  const found = await createThirdPartyLyrics({ fetchImpl: synced.fetchImpl })(QUERY);
  assert.equal(found.source, "lrclib");
  assert.equal(found.text, "[00:01.00]安静\n[00:05.00]第二行", "取的是带时间戳的那一份");
});

test("回退（R41a）：失败各留一行**结论级**日志——带服务名与阶段，不带凭据、不带走响应体", async () => {
  const cases = {
    "HTTP 500": { handler: () => jsonResponse({ error: "boom" }, 500), expect: /被拒.*500/ },
    "坏 JSON": { handler: () => jsonResponse("not json at all"), expect: /不是 JSON/ },
    "抛错（网络不通）": {
      handler: () => {
        throw new Error("ECONNREFUSED");
      },
      expect: /未完成/,
    },
    "声明体积过大": {
      handler: () => new Response("{}", { status: 200, headers: { "content-length": String(9 * 1024 * 1024) } }),
      expect: /响应过大/,
    },
  };
  for (const [label, { handler, expect }] of Object.entries(cases)) {
    const logs = [];
    const doc = await createThirdPartyLyrics({ fetchImpl: async (url) => handler(url), log: (line) => logs.push(line) })(
      QUERY,
    );
    assert.equal(doc, null, `${label} 必须回 null`);
    assert.ok(
      logs.some((line) => expect.test(line)),
      `${label} 要留一行痕（真机上"为什么没取到"只有这里能看到）：${JSON.stringify(logs)}`,
    );
    assert.ok(logs.length <= 2, `${label} 的日志不该刷屏（两个来源各一行）：${JSON.stringify(logs)}`);
    for (const line of logs) {
      for (const forbidden of ["token", "authorization", "cookie", "boom", "http://", "https://", "?"]) {
        assert.equal(
          line.toLowerCase().includes(forbidden.toLowerCase()),
          false,
          `结论级日志里不许出现 ${forbidden}：${line}`,
        );
      }
    }
  }

  // "服务端说没有"（200 + 形状不对的空对象）不是异常：不该刷日志
  const quiet = [];
  const empty = scriptedFetch(() => jsonResponse({}));
  assert.equal(
    await createThirdPartyLyrics({ fetchImpl: empty.fetchImpl, log: (line) => quiet.push(line) })(QUERY),
    null,
  );
  assert.deepEqual(quiet, [], "服务端答「没有」是一条结论，不是异常");
});

test("回退（R41）：没有标题就不试（第三方库靠关键字搜索，没标题等于盲搜）", async () => {
  const { calls, fetchImpl } = scriptedFetch(kugouFlow());
  const fallback = createThirdPartyLyrics({ fetchImpl });
  assert.equal(await fallback({ artist: "周杰伦", durationSeconds: 327 }), null);
  assert.equal(await fallback({ title: "   " }), null);
  assert.equal(await fallback(null), null, "坏入参不抛");
  assert.deepEqual(calls, [], "一次请求都不该发");
});

test("回退（R41）：拿到的是非歌词文本（没有时间戳）→ 回 null（不落一份显示不出来的东西）", async () => {
  const { fetchImpl } = scriptedFetch(kugouFlow("这不是歌词，只是一段话"));
  assert.equal(await createThirdPartyLyrics({ fetchImpl })(QUERY), null);
});

test("回退（R41）：超时是 8 秒（顺带试一下的东西，不该拖成华为接口那样的 25 秒）", () => {
  assert.equal(LYRICS_FALLBACK_TIMEOUT_MS, 8000);
  assert.match(LYRICS_FALLBACK_USER_AGENT, /unofficial/i, "UA 自报「非官方客户端」，但不带任何凭据");
});
