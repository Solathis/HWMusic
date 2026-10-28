/**
 * 真窗守卫里「先等门禁进 QR 档」这一步的纯函数级证据，假 `page` 只实现 `evaluate`。
 * 测的是轮询语义：何时算到了、何时该放弃、放弃时带出哪一档状态行。
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
