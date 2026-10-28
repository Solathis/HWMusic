/**
 * 登录体验的两个浮动控件：返回扫码登录 与 主题切换，各自活在独立的小 webview 里，浮在官方登录页之上。
 *
 * 只有这两件事可以做（`action:"return"` / `action:"theme"`），不能走 `core_call`；盒子只有控件那么大，所以平铺按钮、不做浮层；宿主页面在底下，所以不铺任何全屏底色。
 */
import { useCallback } from "react"

import {
  LOGIN_CHROME_KIND,
} from "../shared/login-chrome.mjs"
import { WEB_LOGIN_BACK_TESTID, WEB_LOGIN_BACK_TEXT } from "./features/auth/login-gate-logic.mjs"
import { Button } from "./components/ui/button"
import { ThemeControl } from "./theme-control"
import { coreLoginChrome } from "./host-api"

/** 左上角那个「返回扫码登录」：点击走专用命令的取消动作，落到与 `auth:cancel-login` 同一个结论槽，主窗门禁据此回到二维码态。 */
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

/** 浮动控件的调度：只认两个 kind，其余一律渲染空壳——地址由 Rust 侧拼，认不出的 kind 不渲染任何东西。 */
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
