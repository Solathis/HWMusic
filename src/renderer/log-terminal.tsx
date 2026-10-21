/**
 * 运行日志面板（R8，R39 迁到设置页并改成编辑器样式）。
 *
 * 它显示的是**真实发生过的提示**：core 经 `app:notice` 广播上来的那些
 * （例如"代理按环境变量设置生效"、"启动期提示"），加上壳自己加的一两句。
 * 刻意不做"假装有日志"的装饰：没有内容就显示"暂无日志。"。
 *
 * 与浏览器控制台的分工：控制台只留错误路径的 console.warn/error（调试残留一律不留），
 * 用户能看到的提示走这里——用户不该为了知道"代理生效了"去开发者工具里翻。
 *
 * R39 的两处改动（用户指令）：
 * 1. **入口搬到设置页**：`App.tsx` 侧栏那个「运行日志」Sheet 删掉了，展示落在
 *    `SettingsPage` 的「运行日志」Card 里。订阅**仍留在外壳**（`LibraryShell` 调
 *    `useNoticeLog()` 再交给页面，与 `trayAvailable`/`lyrics` 同一条纪律）——
 *    `app:notice` 是广播，没人订阅那一刻的提示就没了；把订阅挪进只在设置页挂载的组件，
 *    等于"打开设置页之前的日志全丢"。
 * 2. **编辑器样式**（用户要求）：逐行 = 行号 gutter + 正文，整体在 `ScrollArea`
 *    （`border rounded-md`）里，有界高度由外层 `max-h-[60vh]` 给；上面一个 `Input`
 *    按**文本子串**筛选，并显示「N / 总数 条」计数。
 *
 * 关于"级别"：`app:notice` 的载荷只有 `text`（见 `src/shared/channels.ts`），
 * **不许发明级别**——所以这里没有级别列、没有级别筛选、没有按级别配色，筛选只按文本做。
 * 列表怎么拼、怎么筛、计数怎么说全在 `features/library/library-state.mjs`（纯函数，跑得了测试）。
 */
import { useEffect, useState } from "react"

import { APP_NOTICE } from "../shared/channels.ts"
import { ScrollArea } from "./components/ui/scroll-area"
import { Input } from "./components/ui/input"
import { EmptyState } from "./components"
import { onCoreEvent } from "./host-api"
import {
  appendNotice,
  filterNoticeEntries,
  noticeLogCountText,
} from "./features/library/library-state.mjs"

export interface LogEntry {
  id: number
  text: string
}

/** 面板最多留多少条（长跑进程的界面，不设上限就是缓慢的内存增长）。 */
export const LOG_ENTRY_LIMIT = 100

/** 无日志与筛空是**两句不同的话**：一句说"还没有"，一句说"有，但被筛掉了"。 */
export const LOG_EMPTY_TEXT = "暂无日志。"
export const LOG_NO_MATCH_TEXT = "没有匹配的日志。"

/** 筛选框的占位（克制：不加"支持正则"之类没有的能力）。 */
export const LOG_FILTER_PLACEHOLDER = "筛选日志…"

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

/**
 * 日志卡本体：筛选框 + 计数 + 编辑器样式的日志区。
 *
 * 行号是**显示位置**（1..N，跟着筛选结果走）：它是 gutter 的序号，不是日志的身份——
 * 拿 `entry.id` 当行号会在筛选后留下一串跳号（3、7、12），读起来像丢了行。
 *
 * 行号那一段对读屏 `aria-hidden`：它只帮眼睛对齐，念出来只是噪声；
 * 每行真正的内容是 `entry.text` 那一句。
 */
export function LogTerminal({ entries }: { entries: LogEntry[] }) {
  const [query, setQuery] = useState("")
  const shown = filterNoticeEntries(entries, query)
  const total = entries.length

  return (
    // 日志卡：筛选框 + 计数 + 编辑器样式的日志区（从上到下，短内容时自己收着）
    <div className="flex flex-col gap-2" data-testid="log-terminal">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={LOG_FILTER_PLACEHOLDER}
        aria-label="筛选日志"
        data-testid="log-filter"
      />
      <p className="text-xs text-muted-foreground" role="status" data-testid="log-count">
        {noticeLogCountText(shown.length, total)}
      </p>
      {total === 0 ? (
        <EmptyState text={LOG_EMPTY_TEXT} />
      ) : shown.length === 0 ? (
        <EmptyState text={LOG_NO_MATCH_TEXT} />
      ) : (
        /*
          有界高度（R39 实测修正）：
          `max-h-[60vh]` 只写在 ScrollArea 的**根**上是不够的——radix 的 viewport 是
          `height: 100%`（shadcn 给的 `size-full`），而"只有 max-height、没有确定高度"的父盒子
          解不出百分比高度，于是 viewport 会长成内容高度（实测 64 行时 clientHeight=1040 而
          根只有 480）→ 日志**溢出卡片**而不是滚动。view 自己的 max-height 才是真正管用的那一条：
          它是有 `overflow-y: scroll` 的滚动容器，`max-height` 直接决定它的用值高度。
          那条任意变体就是把这句写上去（选择器认的是 shadcn 生成原语的 `data-slot`，
          与 R1 "不手改生成原语" 的约束不冲突）。
        */
        <ScrollArea
          className="max-h-[60vh] rounded-md border [&>[data-slot=scroll-area-viewport]]:max-h-[60vh]"
          data-testid="log-lines"
        >
          {/*
            逐行：行号 gutter + 正文。`font-mono text-xs` + `break-all` 是原 Sheet 里
            已验证的正文写法，gutter 用 `tabular-nums` 对齐（等宽数字，位数变化不跳）。
          */}
          <ol className="flex flex-col p-2 font-mono text-xs">
            {shown.map((entry, position) => (
              <li key={entry.id} className="flex gap-3" data-testid="log-line">
                <span
                  className="w-8 shrink-0 text-right tabular-nums text-muted-foreground select-none"
                  aria-hidden="true"
                >
                  {position + 1}
                </span>
                <span className="min-w-0 break-all">{entry.text}</span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}
