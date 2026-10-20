/**
 * 登录体验的两个**浮动控件**（R25 用户四项之 2 与 4）。
 *
 * 它们活在两个独立的小 webview 里（label `login-return` / `login-theme`），浮在官方登录页之上：
 *
 * ```
 *   ┌──────────────────────────────────────────────┐
 *   │ [返回扫码登录]                    [浅色 深色 跟随系统] │ ← 两个浮动 webview（透明、置顶）
 *   │                                              │
 *   │           华为官方登录页（铺满整窗）              │
 *   └──────────────────────────────────────────────┘
 * ```
 *
 * 三条约束决定了这个文件的形状：
 *
 * 1. **只有这两件事可以做**：取消登录（`action:"return"`）与切主题（`action:"theme"`）。
 *    不能走 `core_call`——业务频道的来源守卫只认主窗那一个 label（同窗宿主里
 *    窗口 label 恒为 `main`，唯一的区分就是 webview label，见 `src-tauri/src/commands.rs`）。
 * 2. **盒子很小**：这两个 webview 只有控件那么大（几十像素见方），所以不做下拉、不做浮层，
 *    平铺的按钮是唯一能在盒子里点全的形态。
 * 3. **透明**：宿主页面（官方登录页）在它们底下，所以这里不铺任何全屏底色
 *    （HTML 的 `<body class="bg-transparent">` 与窗口的透明背景一起保证这一点）。
 */
import { useCallback } from "react"

import {
  LOGIN_CHROME_KIND,
} from "../shared/login-chrome.mjs"
import { WEB_LOGIN_BACK_TESTID, WEB_LOGIN_BACK_TEXT } from "./features/auth/login-gate-logic.mjs"
import { Button } from "./components/ui/button"
import { ThemeControl } from "./theme-control"
import { coreLoginChrome } from "./host-api"

/**
 * 左上角那个「返回扫码登录」。
 *
 * 点击走专用命令的取消动作——它落到与 `auth:cancel-login` **同一个结论槽**上
 * （`login::cancel_login`）：那条路收场后 sidecar 会播一条带文案的 `auth:status`，
 * 主窗门禁据此回到二维码态并重新发码（R18 的链一个字都没改）。
 */
export function LoginReturnControl() {
  const back = useCallback(() => {
    void (async () => {
      try {
        await coreLoginChrome<{ cancelled?: boolean }>({ action: "return" })
      } catch (failure) {
        // 失败不弹东西：这个 webview 里除了这个按钮什么都没有，
        // 真正的收场由主窗门禁那条状态行说（它才是能显示文字的地方）。
        console.warn("返回扫码登录失败（详情见日志）", failure)
      }
    })()
  }, [])

  return (
    <div className="flex h-full w-full items-center justify-center p-0.5">
      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        data-testid={WEB_LOGIN_BACK_TESTID}
        onClick={back}
      >
        {WEB_LOGIN_BACK_TEXT}
      </Button>
    </div>
  )
}

/**
 * 浮动控件的调度：只认两个 kind，其余一律渲染空壳（**不猜**）。
 *
 * 地址由 Rust 侧拼（`login-chrome.html?kind=…`），认不出的 kind 不渲染任何东西——
 * 这个页面手里握着 `core_login_chrome` 的调用资格，多渲染一个控件就是多一个不该有的按钮。
 */
export function LoginChrome({ kind }: { kind?: string | null }) {
  if (kind === LOGIN_CHROME_KIND.return) {
    return (
      <div className="flex h-full w-full items-start justify-start">
        <LoginReturnControl />
      </div>
    )
  }
  if (kind === LOGIN_CHROME_KIND.theme) {
    return (
      <div className="flex h-full w-full items-start justify-end">
        <ThemeControl />
      </div>
    )
  }
  return null
}
