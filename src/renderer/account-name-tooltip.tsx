/** 账号名：单行截断；悬停时显示登录会话的实时剩余时间（只在提示打开时每秒刷新）。 */
import { useEffect, useState } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
import {
  ACCOUNT_NAME_TESTID,
  ACCOUNT_SESSION_TICK_MS,
  ACCOUNT_SESSION_TOOLTIP_TESTID,
  sessionRemainingText,
} from "./features/auth/account.mjs"

export function AccountNameTooltip({ name, sessionExpiresAt }: { name: string; sessionExpiresAt: number | null }) {
  const [open, setOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!open) return undefined
    const timer = setInterval(() => setNowMs(Date.now()), ACCOUNT_SESSION_TICK_MS)
    return () => clearInterval(timer)
  }, [open])

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        if (next) setNowMs(Date.now())
        setOpen(next)
      }}
    >
      <TooltipTrigger asChild>
        <span className="min-w-0 truncate text-sm" data-testid={ACCOUNT_NAME_TESTID}>
          {name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" data-testid={ACCOUNT_SESSION_TOOLTIP_TESTID}>
        {sessionRemainingText(sessionExpiresAt, nowMs)}
      </TooltipContent>
    </Tooltip>
  )
}
