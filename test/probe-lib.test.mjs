/**
 * 探针公共设施（scripts/probe-lib.mjs）单测：**探针绝不许把敏感值或响应正文带进结果**。
 * 这几条是"不读私人凭据 / 不留正文"的机械保证。先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BODY_MARKERS,
  errorInfoFromBody,
  extractAbsoluteUrls,
  extractApiCandidates,
  extractEndpointPaths,
  extractScriptSrcs,
  looksLikeApiUrl,
  redactUrl,
  summarizeResponse,
  verdictOf,
} from "../scripts/probe-lib.mjs";

test("redactUrl：敏感参数值一律打码，非敏感参数保持可读", () => {
  const redacted = redactUrl("https://example.invalid/a?client_id=101444301&code=SECRET-CODE&refresh_token=SECRET-RT&state=STATE-1");
  assert.match(redacted, /client_id=101444301/);
  assert.match(redacted, /code=\*\*\*/);
  assert.match(redacted, /refresh_token=\*\*\*/);
  assert.doesNotMatch(redacted, /SECRET-CODE|SECRET-RT/);
  assert.match(redacted, /state=\*\*\*/, "state 同样按敏感处理");

  assert.equal(redactUrl("https://example.invalid/a"), "https://example.invalid/a");
  assert.equal(redactUrl("https://example.invalid/a?x=1"), "https://example.invalid/a?x=1");
  assert.match(redactUrl("https://example.invalid/a?sessionId=abc&session_id=def"), /sessionId=\*\*\*/);
  assert.match(redactUrl("https://example.invalid/a?session_id=abc"), /session_id=\*\*\*/);
  assert.equal(redactUrl("https://example.invalid/a?session_id=abc").includes("abc"), false);
});

test("summarizeResponse：结果里只有摘要字段，绝不出现正文", () => {
  const body = `<html><head><title>  华为帐号登录  </title></head><body>扫码登录 invalid_client ${"x".repeat(500)}</body></html>`;
  const summary = summarizeResponse({ url: "https://example.invalid/login?code=SECRET", status: 200, contentType: "text/html", body });

  assert.deepEqual(Object.keys(summary).sort(), ["bytes", "contentType", "error", "markers", "sha256_16", "status", "title", "url"]);
  assert.equal(summary.title, "华为帐号登录");
  assert.equal(summary.status, 200);
  assert.equal(summary.bytes, Buffer.byteLength(body, "utf8"));
  assert.equal(summary.sha256_16.length, 16);
  assert.match(summary.url, /code=\*\*\*/);
  assert.ok(summary.markers.includes("invalid_client"));
  assert.ok(summary.markers.includes("扫码"));
  assert.equal(JSON.stringify(summary).includes("x".repeat(50)), false, "正文片段不得进入结果");
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
});

test("summarizeResponse：网络失败也如实记录（status null + error），不抛", () => {
  const summary = summarizeResponse({ url: "https://music.huawei.com/", error: "ENOTFOUND" });
  assert.equal(summary.status, null);
  assert.equal(summary.error, "ENOTFOUND");
  assert.equal(summary.bytes, 0);
  assert.equal(summary.title, null);
  assert.equal(summary.markers.length, 0);
});

test("extractScriptSrcs：相对路径解析成绝对、去重、限量", () => {
  const html = `
    <script src="/a.js"></script>
    <script src="https://cdn.example.invalid/b.js"></script>
    <script src="/a.js"></script>
    <script src="c.js?x=1"></script>
  `;
  assert.deepEqual(extractScriptSrcs(html, { baseUrl: "https://music.huawei.com/index.html" }), [
    "https://music.huawei.com/a.js",
    "https://cdn.example.invalid/b.js",
    "https://music.huawei.com/c.js?x=1",
  ]);
  assert.equal(extractScriptSrcs(html, { baseUrl: "https://music.huawei.com/", limit: 2 }).length, 2);
});

test("extractAbsoluteUrls / extractApiCandidates：只留 http(s)、去重、过滤静态资源", () => {
  const text = `
    const api = "https://api.example.invalid/music/playlist/list?page=1";
    const static1 = "https://static.example.invalid/app.9f2c.js";
    const same = "https://api.example.invalid/music/playlist/list?page=1";
    const ws = "wss://socket.example.invalid/ws";
  `;
  const urls = extractAbsoluteUrls(text);
  assert.deepEqual(urls.sort(), [
    "https://api.example.invalid/music/playlist/list?page=1",
    "https://static.example.invalid/app.9f2c.js",
  ], "wss 与非 http(s) 不入列，重复项去重");

  const candidates = extractApiCandidates(text);
  assert.deepEqual(candidates, ["https://api.example.invalid/music/playlist/list?page=1"]);
  assert.equal(looksLikeApiUrl("https://static.example.invalid/app.js"), false);
  assert.equal(looksLikeApiUrl("https://x.invalid/api/song/detail"), true);
});

test("verdictOf：区分「存在但要授权」与「路径不存在」（探针的关键判据）", () => {
  assert.equal(verdictOf(200), "reachable");
  assert.equal(verdictOf(302), "redirect");
  assert.equal(verdictOf(401), "exists_needs_auth");
  assert.equal(verdictOf(403), "exists_needs_auth");
  assert.equal(verdictOf(404), "not_found");
  assert.equal(verdictOf(405), "exists_wrong_method");
  assert.equal(verdictOf(500), "exists_other");
  assert.equal(verdictOf(null), "unreachable");
});

test("extractEndpointPaths：从 bundle 正文里抽出端点路径并带上出现处片段", () => {
  const bundle = `
    {path:"/oauth2/v3/authorize",label:"v3的authorize接口"},
    {path:"/oauth2/v2/authorize"},
    {path:"/oauth2/v3/authorize"},
    {path:"/oauth2/ajax/login"},
    static:"/static_rss_vue3/js/index.js"
  `;
  assert.deepEqual(extractEndpointPaths(bundle), [
    { path: "/oauth2/v3/authorize", evidence: "/oauth2/v3/authorize" },
    { path: "/oauth2/v2/authorize", evidence: "/oauth2/v2/authorize" },
    { path: "/oauth2/ajax/login", evidence: "/oauth2/ajax/login" },
  ]);
  assert.equal(extractEndpointPaths(bundle, { limit: 1 }).length, 1);
  assert.deepEqual(extractEndpointPaths("没有端点"), []);
});

test("errorInfoFromBody：只取标准错误码与子码，且只认小 JSON 响应", () => {
  assert.deepEqual(
    errorInfoFromBody('{"error":"invalid_grant","error_description":"SHOULD-NOT-LEAK"}', "application/json"),
    { code: "invalid_grant", subCode: null },
  );
  assert.deepEqual(errorInfoFromBody('{"error_code":"invalid_client"}', "application/json; charset=utf-8"), {
    code: "invalid_client",
    subCode: null,
  });
  // 华为 token 端点的真实形态：数字错误码 + 子码（正文里没有敏感值，描述字段仍然不取）
  assert.deepEqual(errorInfoFromBody('{"error":1101,"error_description":"invalid code","sub_error":20152}', "application/json"), {
    code: "1101",
    subCode: "20152",
  });
  assert.equal(errorInfoFromBody("<html>Error</html>", "text/html"), null);
  assert.equal(errorInfoFromBody('{"error":"invalid_grant"}', "text/html"), null, "非 JSON 响应不解析");
  assert.equal(errorInfoFromBody("x".repeat(2048), "application/json"), null, "大响应不当错误码来源");
  assert.equal(errorInfoFromBody("{oops", "application/json"), null);
  assert.equal(errorInfoFromBody(null, "application/json"), null);
  assert.equal(JSON.stringify(errorInfoFromBody('{"error":1101,"error_description":"SECRET"}', "application/json")).includes("SECRET"), false);
});

test("BODY_MARKERS 是常量清单（探针输出可复现）", () => {
  assert.ok(Array.isArray(BODY_MARKERS) && BODY_MARKERS.length >= 8);
  assert.ok(BODY_MARKERS.includes("loginCallback"));
});
