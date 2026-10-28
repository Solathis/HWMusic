/**
 * 主题回执的单调接受器：把共享合同 acceptThemePayload 包成「落地 + 记水位」。
 * 合同本身在 theme.mjs 的 acceptThemePayload（纯函数，三个消费者共用）；这一层只加记住水位、把接受的档位交给一个副作用。
 */
import { acceptThemePayload, normalizeThemeChoice, THEME_DEFAULT } from "./theme.mjs"

/**
 * @param {(choice: string) => void} apply 真正落地的副作用
 */
export function createThemeAcceptor(apply) {
  let seen = -1
  const choiceOf = (payload) =>
    normalizeThemeChoice(payload !== null && typeof payload === "object" ? payload.theme : undefined) ?? THEME_DEFAULT
  const land = (payload) => {
    const verdict = acceptThemePayload(seen, payload)
    if (!verdict.accept) return false
    seen = verdict.seen
    apply(choiceOf(payload))
    return true
  }
  return {
    /** 见过的最高 revision（`-1` = 还没收到带编号的回执） */
    revision: () => seen,
    /** 广播 / 读回：旧回执返回 false（不落地） */
    accept: land,
    /**
     * 失败路径的落点：**只有在还没收到任何带编号的回执时**才回落系统档。
     * 已经收到过 `{revision}` 说明宿主已经给过权威答案，读回失败不该把界面打回系统档。
     */
    acceptOnFailure: (fallback) => {
      if (seen >= 0) return false
      apply(normalizeThemeChoice(fallback) ?? THEME_DEFAULT)
      return true
    },
  }
}
