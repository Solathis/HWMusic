/**
 * 二维码画布（R18 抽出来的一处）：把"要画的东西"交给成熟库 `qrcode`（MIT）写到 canvas 上。
 *
 * 为什么单独一个 `.mjs`（而不是留在 `login-gate.tsx` 里）：
 * - **画法与测试共用同一个入口**。二维码的重画是"过期自动换新"这条链的最后一跳
 *   （`expired → sidecar 换新 → 新 content → 画布真重绘`），而这一跳在组件里是看不见的；
 *   抽出来之后测试可以拿一块假画布接住**库真写出来的像素**，钉住"新内容真的画上去了"
 *   （见 `test/qr-render.test.mjs`）；
 * - 渲染层仍然不碰二维码算法：编码、纠错、静区全在库里，这里只转发内容与参数。
 *
 * 内容为空、画布还没挂上时**不画**（返回 `null`）：这两种情况都是"还没到时候"，
 * 不是错误——状态行会说明现在到哪一步。
 */
import QRCode from "qrcode";

/** 二维码画布边长（CSS 像素）：与实探里官方页用的 208px 同量级，留出静区后手机好扫。 */
export const QR_SIZE_PX = 208;

/**
 * 库的渲染参数（唯一一份：界面与测试画的是同一张码）。
 *
 * `margin: 1` 是静区（官方页同量级），`errorCorrectionLevel: "L"` 是屏幕扫码的常规档
 * ——内容越长纠错档越高越挤，208px 下 L 最稳。
 */
export const QR_CANVAS_OPTIONS = { width: QR_SIZE_PX, margin: 1, errorCorrectionLevel: "L" };

/**
 * 把 `content` 画到 `canvas` 上（覆盖式重画：同一个 canvas 元素换内容就换画面）。
 *
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @param {string|null|undefined} content 建单接口给的 `content`（二维码要编码的那串）
 * @param {object} [options] 库的渲染参数（缺省 [`QR_CANVAS_OPTIONS`]）
 * @returns {Promise<unknown|null>} 库的返回值（画布本身），没画时是 `null`
 */
export async function paintQrCanvas(canvas, content, options = QR_CANVAS_OPTIONS) {
  if (canvas === null || canvas === undefined || typeof canvas.getContext !== "function") return null;
  if (typeof content !== "string" || content === "") return null;
  return QRCode.toCanvas(canvas, content, options);
}
