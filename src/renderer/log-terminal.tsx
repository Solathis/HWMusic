/**
 * 运行日志面板（R8）。
 *
 * 它显示的是**真实发生过的提示**：core 经 `app:notice` 广播上来的那些
 * （例如"代理按环境变量设置生效"、"启动期提示"），加上壳自己加的一两句。
 * 刻意不做"假装有日志"的装饰：没有内容就显示"暂无日志。"。
 *
 * 与浏览器控制台的分工：控制台只留错误路径的 console.warn/error（调试残留一律不留），
 * 用户能看到的提示走这里——用户不该为了知道"代理生效了"去开发者工具里翻。
 */
import { useEffect, useState } from "react"

import { APP_NOTICE } from "../shared/channels.ts"
import { ScrollArea } from "./components/ui/scroll-area"
import { EmptyState } from "./components"
import { onCoreEvent } from "./host-api"
import { appendNotice } from "./features/library/library-state.mjs"

export interface LogEntry {
  id: number
  text: string
}

/** 面板最多留多少条（长跑进程的界面，不设上限就是缓慢的内存增长）。 */
export const LOG_ENTRY_LIMIT = 100

/**
 * 订阅 `app:notice` 的提示日志。
 *
 * 订阅失败（外壳没起来）不打扰用户：面板照常显示"暂无日志。"——
 * 这类失败的原因在门禁与启动提示里已经说过一遍了，再说一遍只会变成噪声。
 */
export function useNoticeLog(limit: number = LOG_ENTRY_LIMIT): LogEntry[] {
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    let counter = 0

    void (async () => {
      try {
        unlisten = await onCoreEvent<{ text?: unknown }>(APP_NOTICE, (payload) => {
          if (disposed) return
          const text = typeof payload?.text === "string" ? payload.text : null
          if (text === null) return
          counter += 1
          setEntries((current) => appendNotice(current, text, limit, counter))
        })
      } catch {
        // 订阅不上：面板显示空态即可（不额外 console 噪声，也不冒充有日志）
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [limit])

  return entries
}

export function LogTerminal({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4" data-testid="log-terminal">
      {entries.length === 0 ? (
        <EmptyState text="暂无日志。" />
      ) : (
        <ScrollArea className="min-h-0 flex-1 rounded-md border">
          <ul className="flex flex-col gap-1 p-3">
            {entries.map((entry) => (
              <li key={entry.id} className="font-mono text-xs break-all text-muted-foreground">
                {entry.text}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}
