/**
 * 运行日志面板（R8 起；R39 搬到设置页并改成编辑器样式；R56 换成真正的运行日志）。
 *
 * R56 之前这里只显示 `app:notice` 广播（很少），所以几乎总是「暂无日志」。
 * 现在两路合并：**宿主的日志文件**（`readRunLog` → `core_read_run_log`，含 sidecar 那一侧）
 * 在前，提示在后；文件条目自带级别，提示条目一律 info、来源「提示」。
 *
 * 订阅仍留在外壳（`useNoticeLog`）：`app:notice` 是广播，没人订阅那一刻的提示就丢了，
 * 而设置页只在切到「日志」标签时才挂载。
 */
import { useCallback, useEffect, useState } from "react"

import { ScrollArea } from "./components/ui/scroll-area"
import { Input } from "./components/ui/input"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Switch } from "./components/ui/switch"
import { Label } from "./components/ui/label"
import { EmptyState } from "./components"
import { onCoreEvent, readRunLog } from "./host-api"
import { APP_NOTICE } from "../shared/channels.ts"
import { appendNotice } from "./features/library/library-state.mjs"
import {
  RUN_LOG_EMPTY_TEXT,
  RUN_LOG_FAILURE_TEXT,
  RUN_LOG_FILTER_PLACEHOLDER,
  RUN_LOG_LEVELS,
  RUN_LOG_LEVEL_BADGE,
  RUN_LOG_LEVEL_LABELS,
  RUN_LOG_NO_MATCH_TEXT,
  RUN_LOG_DEFAULT_LEVELS,
  filterRunLogEntries,
  mergeRunLogEntries,
  runLogCountText,
  runLogTimeLabel,
  toggleLevel,
} from "./features/settings/run-log.mjs"

export interface LogEntry {
  id: number
  text: string
}

/** 提示面板最多留多少条（长跑进程的界面，不设上限就是缓慢的内存增长）。 */
export const LOG_ENTRY_LIMIT = 100

/** 自动刷新的间隔：日志是人在看，5 秒够用且不会把读盘做成负担。 */
const AUTO_REFRESH_MS = 5000

/**
 * 订阅 `app:notice` 的提示日志。
 *
 * 订阅失败（外壳没起来）不打扰用户：面板照常显示文件里的日志——
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
          if (text === null || text.trim() === "") return
          counter += 1
          const id = counter
          setEntries((current) => appendNotice(current, text, limit, id))
        })
      } catch {
        // 订阅不上：只显示文件里的日志（不冒充"有提示"，也不额外 console 噪声）
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
 * 日志卡本体：级别筛选 + 搜索 + 刷新 + 编辑器样式的日志区。
 *
 * 行号是**显示位置**（1..N，跟着筛选结果走）：它是 gutter 的序号，不是日志的身份——
 * 拿条目的 key 当行号会在筛选后留下跳号，读起来像丢了行。行号那一段对读屏 `aria-hidden`。
 */
export function LogTerminal({ notices = [] }: { notices?: LogEntry[] }) {
  const [payload, setPayload] = useState<unknown>([])
  const [failed, setFailed] = useState(false)
  const [levels, setLevels] = useState<string[]>(() => [...RUN_LOG_DEFAULT_LEVELS])
  const [query, setQuery] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const answer = await readRunLog()
      setPayload(answer)
      setFailed(false)
    } catch {
      // 读不到就清空（留旧内容会让"读不到"与"这些就是现在的日志"同时成立），只说那一句
      setPayload([])
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => void refresh(), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [autoRefresh, refresh])

  const entries = mergeRunLogEntries(payload, notices)
  const shown = filterRunLogEntries(entries, { levels, query })
  const total = entries.length

  return (
    <div className="flex flex-col gap-2" data-testid="log-terminal">
      <div className="flex flex-wrap items-center gap-2">
        {/* 级别多选：四档都点得开，最后一档取消不掉（见 toggleLevel） */}
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="级别筛选">
          {RUN_LOG_LEVELS.map((level) => {
            const active = levels.includes(level)
            return (
              <Button
                key={level}
                type="button"
                size="sm"
                variant={active ? "secondary" : "outline"}
                aria-pressed={active}
                data-testid={`log-level-${level}`}
                onClick={() => setLevels((current) => toggleLevel(current, level))}
              >
                {RUN_LOG_LEVEL_LABELS[level]}
              </Button>
            )
          })}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={RUN_LOG_FILTER_PLACEHOLDER}
          aria-label="搜索日志"
          className="h-8 w-full max-w-xs"
          data-testid="log-filter"
        />
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()} data-testid="log-refresh">
          刷新
        </Button>
        <div className="flex items-center gap-2">
          <Switch
            id="log-auto-refresh"
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
            data-testid="log-autorefresh"
          />
          <Label htmlFor="log-auto-refresh" className="text-xs text-muted-foreground">
            自动刷新
          </Label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" role="status" data-testid="log-count">
        {runLogCountText(shown.length, total)}
      </p>
      {failed ? (
        <p className="text-xs text-destructive" role="alert" data-testid="log-failure">
          {RUN_LOG_FAILURE_TEXT}
        </p>
      ) : null}
      {total === 0 ? (
        <EmptyState text={RUN_LOG_EMPTY_TEXT} />
      ) : shown.length === 0 ? (
        <EmptyState text={RUN_LOG_NO_MATCH_TEXT} />
      ) : (
        /*
          有界高度落到 radix 的 viewport 上：只写在 ScrollArea 根上时，viewport 的
          `height: 100%` 解不出百分比高度（实测日志会溢出卡片而不是滚动）。
        */
        <ScrollArea
          className="max-h-[60vh] rounded-md border [&>[data-slot=scroll-area-viewport]]:max-h-[60vh]"
          data-testid="log-lines"
        >
          <ol className="flex flex-col gap-0.5 p-2 font-mono text-xs">
            {shown.map((entry, position) => (
              <li key={entry.id} className="flex items-baseline gap-2" data-testid="log-line">
                <span
                  className="w-10 shrink-0 text-right tabular-nums text-muted-foreground select-none"
                  aria-hidden="true"
                >
                  {position + 1}
                </span>
                <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                  {runLogTimeLabel(entry.time)}
                </span>
                <Badge
                  variant={RUN_LOG_LEVEL_BADGE[entry.level]}
                  className="shrink-0"
                  data-testid="log-level-badge"
                  data-level={entry.level}
                >
                  {RUN_LOG_LEVEL_LABELS[entry.level]}
                </Badge>
                {entry.source === "" ? null : (
                  <span className="max-w-[14rem] shrink-0 truncate text-muted-foreground" title={entry.source}>
                    {entry.source}
                  </span>
                )}
                <span className="min-w-0 break-all">{entry.message}</span>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </div>
  )
}
