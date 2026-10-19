/**
 * R4 协议原型层 · 媒体 URL 安全（src/protocols/safe-media-url.mjs）。
 *
 * 渲染层 img/audio 只吃这个模块放行的 URL：https + CDN 后缀白名单（与 tauri.conf.json CSP 同源）。
 * 任何解析不了、host 对不上、带凭据/端口的输入一律返回 null——**绝不抛异常**（渲染层不能因为一张封面炸掉）。
 * CSP ↔ 常量一致性由本文件从 tauri.conf.json 解析 CSP 行来钉，先写先看红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MEDIA_URL_HOST_SUFFIXES,
  isSafeMediaUrl,
  parseSafeMediaUrl,
  safeMediaUrl,
} from "../src/protocols/safe-media-url.mjs";
import { BROADCAST_CHANNELS } from "../src/shared/channels.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("白名单后缀：三个 CDN 域，且硬钉内容（放宽必须改测试）", () => {
  assert.deepEqual([...MEDIA_URL_HOST_SUFFIXES], ["dbankcdn.cn", "tingmall.com", "kuke.com"]);
});

test("放行：白名单域的自身与任意子域", () => {
  for (const url of [
    "https://dbankcdn.cn/a.jpg",
    "https://img.dbankcdn.cn/a.jpg",
    "https://a.b.c.dbankcdn.cn/path/to/a.jpg?x=1",
    "https://tingmall.com/a.mp3",
    "https://cdn.tingmall.com/a.mp3",
    "https://kuke.com/a.mp3",
    "https://static.kuke.com/music/a.flac",
  ]) {
    assert.equal(safeMediaUrl(url), url, `应放行：${url}`);
    assert.equal(isSafeMediaUrl(url), true);
  }
});

test("拒绝：后缀同名但不同域（无点边界）、把白名单域当子域前缀的钓鱼域", () => {
  for (const url of [
    "https://evil-dbankcdn.cn/a.jpg",
    "https://dbankcdn.cn.evil.com/a.jpg",
    "https://notdbankcdn.cn/a.jpg",
    "https://dbankcdn.com.cn/a.jpg",
    "https://xdbankcdn.cn/a.jpg",
  ]) {
    assert.equal(safeMediaUrl(url), null, `必须拒绝：${url}`);
  }
});

test("拒绝：非 https（http/data/blob/file/javascript/ftp）与无协议字符串", () => {
  for (const url of [
    "http://img.dbankcdn.cn/a.jpg",
    "data:image/png;base64,AAAA",
    "blob:https://localhost/abc",
    "file:///C:/secret.mp3",
    "javascript:alert(1)",
    "ftp://img.dbankcdn.cn/a.jpg",
    "//img.dbankcdn.cn/a.jpg",
    "img.dbankcdn.cn/a.jpg",
    "not a url at all",
  ]) {
    assert.equal(safeMediaUrl(url), null, `必须拒绝：${url}`);
  }
});

test("拒绝：userinfo 与显式端口（含 443 之外的任何端口）", () => {
  for (const url of [
    "https://user:pass@img.dbankcdn.cn/a.jpg",
    "https://user@img.dbankcdn.cn/a.jpg",
    "https://img.dbankcdn.cn:8080/a.jpg",
    "https://img.dbankcdn.cn:443/a.jpg",
  ]) {
    assert.equal(safeMediaUrl(url), null, `必须拒绝：${url}`);
  }
});

test("大小写与尾点：host 大小写不敏感放行；尾点域名（FQDN 写法）拒绝", () => {
  assert.equal(safeMediaUrl("https://IMG.DBankCDN.cn/a.jpg"), "https://img.dbankcdn.cn/a.jpg");
  assert.equal(isSafeMediaUrl("https://Img.TingMall.Com/a.mp3"), true);
  assert.equal(safeMediaUrl("https://img.dbankcdn.cn./a.jpg"), null, "尾点域名的 host 语义与白名单条目不同，不放行");
});

test("非字符串与畸形输入一律 null，绝不抛（渲染层不能因封面 URL 炸掉）", () => {
  for (const value of [null, undefined, 42, {}, [], true, "", "   ", Symbol("x")]) {
    assert.doesNotThrow(() => safeMediaUrl(value));
    assert.equal(safeMediaUrl(value), null, `必须拒绝：${String(value)}`);
  }
});

test("parseSafeMediaUrl：给出可读的拒绝原因（排障用，不实现渲染）", () => {
  assert.deepEqual(parseSafeMediaUrl("https://img.dbankcdn.cn/a.jpg"), {
    ok: true,
    url: "https://img.dbankcdn.cn/a.jpg",
    host: "img.dbankcdn.cn",
    suffix: "dbankcdn.cn",
  });

  for (const [url, reason] of [
    [42, "not_a_string"],
    ["not a url at all", "unparsable"],
    ["http://img.dbankcdn.cn/a.jpg", "scheme"],
    ["https://user@img.dbankcdn.cn/a.jpg", "userinfo"],
    ["https://img.dbankcdn.cn:8080/a.jpg", "port"],
    ["https://evil-dbankcdn.cn/a.jpg", "host_not_allowed"],
  ]) {
    assert.deepEqual(parseSafeMediaUrl(url), { ok: false, reason }, `拒绝原因不符：${String(url)}`);
  }
});

test("CSP 一致性：常量后缀与 tauri.conf.json 的 img-src/media-src 白名单同源", () => {
  const conf = JSON.parse(readFileSync(`${repoRoot}src-tauri/tauri.conf.json`, "utf8"));
  const csp = conf.app.security.csp;
  const directive = (name) => {
    const found = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
    assert.ok(found, `CSP 里找不到 ${name} 指令`);
    return found.split(/\s+/).slice(1);
  };

  const cspMediaHosts = new Set();
  for (const name of ["img-src", "media-src"]) {
    for (const source of directive(name)) {
      const match = /^https:\/\/\*\.([a-z0-9.-]+)$/.exec(source);
      if (match) cspMediaHosts.add(match[1]);
    }
  }
  assert.deepEqual([...cspMediaHosts].sort(), [...MEDIA_URL_HOST_SUFFIXES].sort(), "CSP 与 safe-media-url 白名单必须同源");
  assert.deepEqual(directive("connect-src"), ["'self'", "ipc:", "http://ipc.localhost"], "渲染层不得有对外直连通道");
});

test("广播频道：R12 起是 app:notice + auth:status + player:command + 托盘那两条 + 歌词窗那三条（每个新增都在共享常量表里，不另立清单）", () => {
  // R4 落地时这里钉的是"只有 app:notice"；R7 增补 auth:status（登录状态）、
  // R9 预登记 player:command（R11 托盘的播放控制）、R11 增补 lyrics:toggle / app:open-settings
  // （托盘"桌面歌词"与"设置…"）、R12 增补 lyrics:document / lyrics:progress / lyrics:state
  // （主窗转发给歌词窗的歌词、进度与配置）后同步改这一行——硬钉的意义是"每次放宽都得有人签字"，
  // 不是"永远不许加"。
  assert.deepEqual([...BROADCAST_CHANNELS], [
    "app:notice",
    "auth:status",
    "player:command",
    "lyrics:toggle",
    "app:open-settings",
    "lyrics:document",
    "lyrics:progress",
    "lyrics:state",
  ]);
});
