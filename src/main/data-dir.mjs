/**
 * sidecar 的应用数据目录：**只由宿主决定**，经 argv 传进来。
 *
 * 为什么不自己猜：打包后进程当前目录不可预测（可能是 Program Files），缓存的
 * `%LOCALAPPDATA%` 在受限环境下还可能不可写。宿主（Rust `lib.rs`）已经把三级回退做完
 * （`HWMUSIC_DATA_DIR` 旋钮 → 应用数据目录 → 应用缓存目录），再用 argv 交给 sidecar——
 * 两侧都解析一遍就会有两份会漂移的真源。
 *
 * 参数名 `--data-dir` 与 Rust `src-tauri/src/sidecar.rs` 的 `DATA_DIR_ARG` 由测试互钉。
 */
import { isAbsolute } from "node:path";

/** 宿主传数据目录用的参数名（Rust 侧同名字面量，测试互钉）。 */
export const DATA_DIR_ARG = "--data-dir";

/** 开发期兜底旋钮（手跑 `node src/sidecar/main.mjs` 用；生产路径永远由 argv 决定）。 */
export const DATA_DIR_ENV = "HWMUSIC_DATA_DIR";

/**
 * 从 `process.argv.slice(2)` 解析数据目录。
 *
 * - 有 `--data-dir <绝对路径>` → 用它；
 * - 参数在但值缺失/是相对路径 → **抛 TypeError**（宁可不启动，也不用一个会漂移的目录）；
 * - 没有该参数 → 环境旋钮兜底，坏值（空白/相对）一律当作未设置；
 * - 都没有 → `null`（调用方据此决定"只留内存会话"，绝不回退到 cwd）。
 */
export function dataDirFromArgv(argv = [], { env = process.env } = {}) {
  const index = argv.indexOf(DATA_DIR_ARG);
  if (index !== -1) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`${DATA_DIR_ARG} 缺少值：宿主必须传一个绝对路径`);
    }
    if (value.startsWith("-")) {
      throw new TypeError(`${DATA_DIR_ARG} 后面跟的是另一个参数（${value}），不是数据目录`);
    }
    if (!isAbsolute(value)) {
      throw new TypeError(`${DATA_DIR_ARG} 只接受绝对路径（收到 ${value}）：相对路径会随启动目录漂移`);
    }
    return value;
  }

  const fallback = typeof env?.[DATA_DIR_ENV] === "string" ? env[DATA_DIR_ENV].trim() : "";
  if (fallback === "") return null;
  return isAbsolute(fallback) ? fallback : null;
}
