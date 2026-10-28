/**
 * 二维码画布：把要画的东西交给成熟库 `qrcode` 写到 canvas 上，渲染层不碰二维码算法。
 *
 * 单独一个 `.mjs` 是为了让界面与测试共用同一个入口，测试能接住库真写出来的像素；
 * 内容为空、画布还没挂上时不画（返回 `null`）——那是"还没到时候"，不是错误。
 */
import QRCode from "qrcode";

/** 二维码画布边长（CSS 像素）：与实探里官方页用的 208px 同量级，留出静区后手机好扫。 */
export const QR_SIZE_PX = 208;

/** 库的渲染参数（唯一一份）：`margin: 1` 是静区，`errorCorrectionLevel: "L"` 是屏幕扫码的常规档。 */
export const QR_CANVAS_OPTIONS = { width: QR_SIZE_PX, margin: 1, errorCorrectionLevel: "L" };

/**
 * 把 `content` 画到 `canvas` 上（覆盖式重画：同一个 canvas 换内容就换画面）。
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @param {string|null|undefined} content 建单接口给的 `content`
 * @param {object} [options] 库的渲染参数（缺省 [`QR_CANVAS_OPTIONS`]）
 * @returns {Promise<unknown|null>} 库的返回值（画布本身），没画时是 `null`
 */
export async function paintQrCanvas(canvas, content, options = QR_CANVAS_OPTIONS) {
  if (canvas === null || canvas === undefined || typeof canvas.getContext !== "function") return null;
  if (typeof content !== "string" || content === "") return null;
  return QRCode.toCanvas(canvas, content, options);
}
