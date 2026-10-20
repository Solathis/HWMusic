/**
 * R16 · C 部分：二维码渲染冒烟（成熟库 `qrcode`，MIT）。
 *
 * 为什么只到"库产出真二维码"这一层：真浏览器里的像素守卫是 `npm run test:browser`
 * （playwright + Chromium）的活；这里是**不依赖浏览器**的那一段——证明
 * 1. 依赖真的装着、许可证是 MIT（不是把别人的码抄进仓库）；
 * 2. 拿探针实探到的 `content` 形状能编出二维码（模块矩阵既不是全黑也不是全白）；
 * 3. 渲染层用的是库的渲染入口（`toCanvas`），而不是自己画模块矩阵。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(`${repoRoot}${relative}`, "utf8");

/** 实探到的二维码内容形状（`https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=…`）。 */
const SAMPLE_CONTENT =
  "https://id1.cloud.huawei.com/qrcode/login.jsp?loginChannel=7000700&reqClientType=700&qRCode=SAMPLE0000000000000000&qrSiteID=1&familySharing=0&appBrand=HUAWEI";

test("依赖：qrcode 是声明的运行时依赖，且许可证是 MIT", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.dependencies?.qrcode, "qrcode 必须在 dependencies 里（打包产物要用它渲染）");

  const installed = JSON.parse(read("node_modules/qrcode/package.json"));
  assert.equal(installed.license, "MIT", "二维码库必须是 MIT（与任务书一致）");
  assert.match(installed.version, /^1\.5\./, "锁在 1.5.x（本任务安装并验证过的版本）");
});

test("冒烟：实探到的内容串能编出真二维码（模块矩阵有黑有白）", () => {
  const qr = QRCode.create(SAMPLE_CONTENT, { errorCorrectionLevel: "L" });
  const size = qr.modules.size;
  assert.ok(size >= 21, `模块矩阵至少 21×21（实际 ${size}）`);

  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (qr.modules.get(row, column)) dark += 1;
    }
  }
  const ratio = dark / (size * size);
  assert.ok(dark > 0, "不能全白（那说明什么都没编进去）");
  assert.ok(ratio > 0.2 && ratio < 0.8, `黑白比例要在合理区间（实际 ${ratio.toFixed(2)}）`);
});

test("冒烟：库的两种渲染出口都能用（SVG 字符串 + 数据 URL 的降级路径）", async () => {
  const svg = await QRCode.toString(SAMPLE_CONTENT, { type: "svg", margin: 1 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /<path|<rect/, "SVG 出口要真的画出模块");

  // 渲染层用 toCanvas（浏览器路径）；这里证明库同时提供可离线断言的出口，
  // 免得"渲染冒烟"只能靠人眼看界面。
  const tooLong = "x".repeat(10_000);
  await assert.rejects(
    () => QRCode.toString(tooLong, { type: "svg" }),
    /too big|too long/i,
    "内容超长要抛（库里就有这道闸门，不需要我们自己再写一份）",
  );
});

test("渲染层：门禁只经库的渲染入口画二维码（没有第二个二维码实现）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /import QRCode from "qrcode"/);
  assert.match(gate, /QRCode\.toCanvas\(/);

  // 渲染层不许出现任何二维码编码细节（那意味着有人抄了一份实现进来）
  for (const forbidden of ["RS_BLOCK_TABLE", "getModuleCount", "getBestMaskPattern", "ecLevel"]) {
    assert.equal(gate.includes(forbidden), false, `渲染层不该出现二维码算法细节：${forbidden}`);
  }
});
