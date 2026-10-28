/**
 * 媒体 URL 安全（`src/protocols/safe-media-url.mjs`）。
 *
 * 渲染层的 img/audio 只吃这个模块放行的 URL：https + CDN 后缀白名单（与 tauri.conf.json CSP 同源）。
 * 解析不了、host 不符、带凭据或端口的输入一律返回 null，绝不抛异常；
 * CSP 与常量的一致性由本文件解析 tauri.conf.json 的 CSP 行来钉。
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

  // 本地曲库的自定义协议只加在 img-src / media-src 两个指令上；
  // default-src / connect-src 一个字都不许动（AMLL 背景靠 `new Image()` 预载，不走 fetch）。
  for (const name of ["img-src", "media-src"]) {
    const sources = directive(name);
    assert.ok(sources.includes("http://hwlocal.localhost"), `${name} 必须放行 Windows 形态的本地协议`);
    assert.ok(sources.includes("hwlocal:"), `${name} 必须放行 mac/Linux 形态的本地协议`);
  }
  for (const name of ["default-src", "connect-src", "script-src"]) {
    assert.ok(
      !directive(name).some((source) => source.includes("hwlocal")),
      `${name} 不许出现本地协议（那等于放宽整条链）`,
    );
  }
});

test("R65：本地曲库协议按 id 形状放行（Windows 与 mac/Linux 两种形态），其余一律拒绝", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(parseSafeMediaUrl(`http://hwlocal.localhost/${hex}`), {
    ok: true,
    url: `http://hwlocal.localhost/${hex}`,
    host: "hwlocal.localhost",
    suffix: null,
  });
  assert.deepEqual(parseSafeMediaUrl(`hwlocal://localhost/${hex}/cover`), {
    ok: true,
    url: `hwlocal://localhost/${hex}/cover`,
    host: "localhost",
    suffix: null,
  });

  for (const bad of [
    // id 形状不对：不可猜的 id 是"没导入就拿不到"的唯一凭据，形状本身就是过滤器
    "http://hwlocal.localhost/",
    "http://hwlocal.localhost/0123456789abcdef",
    "http://hwlocal.localhost/0123456789ABCDEF0123456789abcdef",
    `http://hwlocal.localhost/${hex}0`,
    // 多出来的路径段 / 查询串 / 片段：协议只认两种形状
    `http://hwlocal.localhost/${hex}/cover/extra`,
    `http://hwlocal.localhost/${hex}?x=1`,
    `http://hwlocal.localhost/${hex}#frag`,
    `http://hwlocal.localhost/../${hex}`,
    // 换域（哪怕长得像）：基址由宿主给，不认识的域一律拒绝
    `http://hwlocal.localhost.evil.com/${hex}`,
    `http://evil.example/${hex}`,
    `hwlocal://evil.example/${hex}`,
    `hwlocal://localhost:8080/${hex}`,
    `hwlocal://user@localhost/${hex}`,
  ]) {
    assert.equal(safeMediaUrl(bad), null, `必须拒绝：${bad}`);
  }
});

test("广播频道：R16 起是 app:notice + auth:status + auth:qr + player:command + 托盘那两条 + 歌词窗那四条 + 主题那条（每个新增都在共享常量表里，不另立清单）", () => {
  // 广播频道是硬钉的白名单：每次放宽都得同步改这一行——意义是「有人签字」，
  // 不是「永远不许加」。
  assert.deepEqual([...BROADCAST_CHANNELS], [
    "app:notice",
    "auth:status",
    "auth:qr",
    "player:command",
    "lyrics:toggle",
    "app:open-settings",
    "lyrics:document",
    "lyrics:progress",
    "lyrics:state",
    "lyrics:pointer",
    "theme:changed",
  ]);
});
