/**
 * R19：真窗守卫（`npm run verify:live`）里"先等门禁进 QR 档"这一步的**纯函数级**证据。
 *
 * 为什么单独测它：真窗守卫本体要真应用 + CDP（R19 的约束是不起 GUI），而这一步恰好是把
 * R19 那个缺口（reload 之后门禁卡在 `checking`）翻译成**可读证据**的地方——
 * 只等 canvas 的话，失败信息是"canvas 没出现"，看不出卡在哪一档；把轮询时的状态行带出来，
 * 日志会直接说"门禁停在「正在检查登录状态…」"，那就是根因本身。
 *
 * 假 `page` 只实现守卫用到的那一个方法（`evaluate`），所以这一层测的是**轮询语义**：
 * 什么时候算到了、什么时候该放弃、放弃时带出什么。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { waitForQrTier } from "../scripts/verify-live.mjs";

/** 假页面：按调用次序依次给出预设的观测量，用完之后一直给最后一个。 */
function fakePage(views) {
  let index = 0;
  return {
    calls: 0,
    async evaluate() {
      this.calls += 1;
      const view = views[Math.min(index, views.length - 1)];
      index += 1;
      return view;
    },
  };
}

test("等 QR 档：画布一出现就返回（到了就不必把超时等满）", async () => {
  const page = fakePage([
    { canvas: false, status: "正在检查登录状态…" },
    { canvas: false, status: "正在准备二维码…" },
    { canvas: true, status: "等待扫码…" },
  ]);
  const view = await waitForQrTier(page, { testid: "login-qr", timeoutMs: 5000, pollMs: 1 });
  assert.equal(view.seen, true);
  assert.equal(view.reason, "canvas");
  assert.equal(page.calls, 3, "第三次读到画布就停：多轮一次都是浪费");
});

test("等 QR 档：一直没到就如实报「没到」，并带上当时的状态行（卡在 checking 一眼可见）", async () => {
  const page = fakePage([{ canvas: false, status: "正在检查登录状态…" }]);
  const view = await waitForQrTier(page, { testid: "login-qr", timeoutMs: 30, pollMs: 5 });
  assert.equal(view.seen, false);
  assert.equal(view.reason, "timeout");
  assert.equal(view.status, "正在检查登录状态…", "失败信息要能指认「门禁卡在检查中」这个根因");
  assert.ok(page.calls >= 2, "超时窗口内要真的轮询，而不是读一次就下结论");
});

test("等 QR 档：页面读不到（evaluate 抛错，例如导航中）当成「还没到」，不把守卫自己炸掉", async () => {
  let calls = 0;
  const page = {
    async evaluate() {
      calls += 1;
      if (calls === 1) throw new Error("Execution context was destroyed");
      return { canvas: true, status: "等待扫码…" };
    },
  };
  const view = await waitForQrTier(page, { testid: "login-qr", timeoutMs: 1000, pollMs: 1 });
  assert.equal(view.seen, true);
  assert.equal(calls, 2);
});
