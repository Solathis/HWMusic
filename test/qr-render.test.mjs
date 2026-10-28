/**
 * 二维码渲染冒烟（成熟库 `qrcode`，MIT）与过期换新的像素级全链。
 *
 * 只到「库产出真二维码」这一层：真浏览器里的像素守卫归 `npm run test:browser`；
 * 这里证明依赖真装着、探针的 `content` 能编出二维码、渲染层走库的 `toCanvas`，
 * 并用假画布接住库真写出的像素——换新前后两帧必须不一样。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

import { AUTH_QR, AUTH_STATUS } from "../src/shared/channels.ts";
import { QR_SIZE_PX, paintQrCanvas } from "../src/renderer/features/auth/qr-canvas.mjs";
import {
  LOGIN_GATE_EVENT,
  initialGateState,
  qrContentOf,
  reduceGateState,
} from "../src/renderer/features/auth/login-gate-logic.mjs";

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
  assert.match(gate, /paintQrCanvas\(/, "门禁经 painter（features/auth/qr-canvas.mjs）画码，不自己碰库");

  // 渲染层不许出现任何二维码编码细节（那意味着有人抄了一份实现进来）
  for (const forbidden of ["RS_BLOCK_TABLE", "getModuleCount", "getBestMaskPattern", "ecLevel"]) {
    assert.equal(gate.includes(forbidden), false, `渲染层不该出现二维码算法细节：${forbidden}`);
  }
});

// 手动刷新的最后一跳：同一块画布上真的重画。

/** 假画布：只实现 `qrcode` canvas 出口用到的那几个入口，足以接住库真写出来的像素。 */
function fakeCanvas() {
  const frames = [];
  const context = {
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    clearRect: () => undefined,
    putImageData: (image) => {
      frames.push(Uint8Array.from(image.data));
    },
  };
  return { frames, style: {}, width: 0, height: 0, getContext: () => context };
}

/** 一帧像素里的暗像素占比（与 verify-live 的口径同源：空白画布是 0）。 */
function inkCoverage(frame) {
  let dark = 0;
  for (let index = 0; index + 3 < frame.length; index += 4) {
    const luminance = 0.299 * frame[index] + 0.587 * frame[index + 1] + 0.114 * frame[index + 2];
    if (frame[index + 3] >= 128 && luminance < 128) dark += 1;
  }
  return dark / (frame.length / 4);
}

/** 两帧像素差异比例。 */
function pixelDiffRatio(a, b) {
  if (a.length !== b.length) return 1;
  let differing = 0;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) differing += 1;
  return differing / a.length;
}

test("painter：一次绘制写出真二维码像素（尺寸=QR_SIZE_PX、有黑有白）", async () => {
  const canvas = fakeCanvas();
  await paintQrCanvas(canvas, SAMPLE_CONTENT);

  assert.equal(canvas.frames.length, 1, "一次绘制 = 一帧（putImageData 一次）");
  assert.equal(canvas.width, QR_SIZE_PX, `画布尺寸由库按 width 选项定：${canvas.width}`);
  assert.equal(canvas.height, QR_SIZE_PX);
  const coverage = inkCoverage(canvas.frames[0]);
  assert.ok(coverage > 0.15 && coverage < 0.8, `墨迹占比要在二维码区间（实际 ${coverage.toFixed(4)}）`);
});

test("painter：没有内容或没有画布时不画（不做无意义的绘制，也不抛）", async () => {
  const canvas = fakeCanvas();
  assert.equal(await paintQrCanvas(canvas, ""), null);
  assert.equal(await paintQrCanvas(canvas, null), null);
  assert.equal(await paintQrCanvas(null, SAMPLE_CONTENT), null);
  assert.equal(canvas.frames.length, 0);
});

test("手动刷新（全链）：过期撤下画布 → 用户点刷新 → 新码在新画布上画出**不同**的像素", async () => {
  const OLD = "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=OLD-0000";
  const NEW = "https://id1.cloud.huawei.com/qrcode/login.jsp?qRCode=NEW-1111";

  // sidecar 真会播出的那串（auth:status 起点 + auth:qr 的过期；新码来自用户点刷新后的 qr-start 应答）
  const broadcasts = [
    { channel: AUTH_STATUS, payload: { loggedIn: false, busy: false } },
    { channel: AUTH_QR, payload: { status: "pending", content: OLD, expiresInMs: 181_000, at: 1_000_000 } },
    { channel: AUTH_QR, payload: { status: "expired" } },
    { channel: AUTH_QR, payload: { status: "pending", content: NEW, expiresInMs: 181_000, at: 1_000_000 } },
  ];

  const canvas = fakeCanvas();
  let state = initialGateState();
  let painted = null;
  let contentAtExpired = "unset";
  for (const { channel, payload } of broadcasts) {
    state = reduceGateState(state, {
      type: channel === AUTH_STATUS ? LOGIN_GATE_EVENT.status : LOGIN_GATE_EVENT.qr,
      ...payload,
    });
    if (payload.status === "expired") contentAtExpired = qrContentOf(state);
    // 渲染层的重画条件就是"要画的内容变了"（QrCanvas 的 effect 依赖是 content）：
    // 内容为 null = 画布被撤下（过期态），于是下一次内容变化一定落在**新画布**上重画
    const content = qrContentOf(state);
    if (content !== null && content !== painted) {
      painted = content;
      await paintQrCanvas(canvas, content);
    }
  }

  assert.equal(contentAtExpired, null, "过期那一档：屏上不该再有可画的内容（死码必须撤下）");
  assert.equal(canvas.frames.length, 2, `手动刷新后必须在画布上画出新码（实际 ${canvas.frames.length} 帧）`);
  const diff = pixelDiffRatio(canvas.frames[0], canvas.frames[1]);
  assert.ok(diff > 0.05, `新码与旧码的画面必须真的不同（实际差异 ${(diff * 100).toFixed(2)}%）`);
  assert.ok(inkCoverage(canvas.frames[1]) > 0.15, "刷新后的那一帧仍是一张真的二维码");
});

test("painter 是唯一出口：门禁的重画条件钉在「内容」上（内容不变不重画）", () => {
  const gate = read("src/renderer/login-gate.tsx");
  assert.match(gate, /paintQrCanvas\(canvasRef\.current, content\)/, "画布经 painter 画，参数是当前内容");
  assert.match(gate, /\},\s*\[content\]\)/, "effect 依赖是 content：内容一换就重画（过期换新走的就是这条路）");
  assert.doesNotMatch(gate, /QRCode\./, "门禁不直接碰二维码库（画法只有 qr-canvas.mjs 一处）");
});

