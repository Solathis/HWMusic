/**
 * README：三张截图（主界面 / 播放页 / 设置）真实存在、尺寸一致、用演示数据；正文简短、参考项目齐全。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SCREENSHOT_DIR, SCREENSHOTS, VIEWPORT, demoHarnessSource, demoPlaylists, demoSongs } from "../scripts/readme-screenshots.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url));

test("README：主界面 / 播放页 / 设置三张截图都在，是 PNG，尺寸就是截图脚本的视口", () => {
  const readme = read("README.md").toString("utf8");
  assert.deepEqual(SCREENSHOTS, ["main.png", "player.png", "settings.png"]);
  for (const name of SCREENSHOTS) {
    const file = `${SCREENSHOT_DIR}/${name}`;
    assert.ok(readme.includes(`](${file})`), `README 要引用 ${file}`);
    const png = read(file);
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG", `${file} 是 PNG`);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [VIEWPORT.width, VIEWPORT.height], `${file} 的尺寸`);
    assert.ok(png.length < 400 * 1024, `${file} 不超过 400 KB（${png.length} 字节）`);
  }
  assert.match(readme, /截图使用演示数据/, "说清截图不是真实账号");
});

test("README：截图只用演示数据（演示账号、演示歌手、原创歌词），不连真实服务", () => {
  const source = demoHarnessSource({ version: "0.0.0", tauriVersion: "0.0.0" });
  assert.match(source, /userName: "演示用户"/);
  assert.ok(demoSongs().every((song) => song.artists.startsWith("演示")), "歌手都是演示名字");
  assert.ok([...demoSongs(), ...demoPlaylists()].every((item) => item.coverUrl.startsWith("https://music.dbankcdn.cn/demo/")), "封面都由脚本本地生成并拦截");
  for (const secret of [".local/", "session.enc", "accessToken", "refreshToken"]) assert.ok(!source.includes(secret), `不读任何真实会话：${secret}`);
  const script = read("scripts/readme-screenshots.mjs").toString("utf8");
  assert.doesNotMatch(script, /headless:\s*false/, "无头浏览器，不抢焦点");
  assert.equal(JSON.parse(read("package.json").toString("utf8")).scripts["docs:screenshots"], "node scripts/readme-screenshots.mjs");
});

test("README：简短，参考项目与地址齐全", () => {
  const readme = read("README.md").toString("utf8");
  assert.ok(readme.split("\n").length <= 120, `README 应简短（现在 ${readme.split("\n").length} 行）`);
  for (const url of [
    "https://github.com/talongao/huawei-music-desktop",
    "https://github.com/ANYNC/TaskbarLyrics",
    "https://github.com/Mai-icy/Spotify-lyrics-window",
    "https://github.com/amll-dev/applemusic-like-lyrics",
    "https://github.com/shadcn-ui/ui",
  ]) {
    assert.ok(readme.includes(url), `README 缺参考项目 ${url}`);
  }
  assert.ok(readme.includes("[CHANGELOG.md](CHANGELOG.md)"), "更新内容指向 CHANGELOG");
});
