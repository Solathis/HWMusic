/**
 * 歌词卡片（R41）：**缓存占用 / 一键清除 / 导入本地歌词**（挂在设置页「桌面歌词」卡旁边）。
 *
 * 三件事都是这一张卡里的（不是三张卡）：它们共用同一句话的前提——"这首歌的歌词从哪来"。
 * 拆成三张会让用户在三处之间找关系（"我清了缓存，导入的东西还在吗？"）。
 * **设置页整体的二级分类是第二波任务**（简报明确），本轮只挂这一张卡。
 *
 * ## 五条纪律
 *
 * 1. **数字是问出来的，不是猜的**：占用来自 `lyrics:cache-info`（sidecar 现算），
 *    挂载时问一次、清完再问一次——界面从不自己估；
 * 2. **本地导入默认不删**：`lyrics-local/` 里是用户自己的文件，删掉不可撤销。
 *    所以"连本地导入一起清"是一个**单独的开关 + 确认框**（`AlertDialog`），不是默认行为；
 * 3. **没有正在播放的曲目就不给导入**：导入的语义是"换掉这首歌的歌词"，
 *    按钮禁用并说清原因（而不是让用户选完文件才失败）；
 * 4. **文件选择用系统标准控件**：`<input type="file" accept=".lrc,.txt">`（零 Rust、零 capability）。
 *    控件本体是隐藏的，按钮只负责 `click()` 它——这是"按钮长得像 shadcn，行为是原生的"那条路；
 * 5. **失败说人话**：解码/解析/落盘的失败文案都由 `lyrics-import.mjs` 与 core 给（带原因与下一步）。
 *
 * 全 shadcn 原语 + 令牌类，零自定义 CSS（与全仓同一条约束）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { UploadIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card"
import { Label } from "./components/ui/label"
import { Switch } from "./components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog"
import { getLyricsBridge } from "./features/lyrics/lyrics-bridge.mjs"
import {
  LYRICS_IMPORT_ACCEPT,
  lyricsCacheClearedText,
  lyricsCacheSizeText,
} from "./features/lyrics/lyrics-import.mjs"
import type { LyricsWindowBinding } from "./use-lyrics-window.ts"

const log = (...parts: unknown[]) => console.warn("[hwmusic-lyrics]", ...parts)

/** 一次操作的结论（成功与失败都带一句人话；界面只渲染它）。 */
interface LyricsCardResult {
  ok: boolean
  message: string
}

export interface LyricsCacheCardProps {
  /**
   * 桌面歌词窗的绑定（与设置页那张卡同一个来源）：`canImport` / `importFile` 从这里来。
   * 缺省 `null` = 外壳还没挂上（这时如实说"导入入口不可用"，而不是画一个点了没反应的按钮）。
   */
  lyrics?: LyricsWindowBinding | null
}

export function LyricsCacheCard({ lyrics = null }: LyricsCacheCardProps) {
  const bridge = getLyricsBridge()
  const [info, setInfo] = useState<unknown>(null)
  const [infoFailed, setInfoFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [withLocal, setWithLocal] = useState(false)
  const [result, setResult] = useState<LyricsCardResult | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  /** 问一次占用（sidecar 现算）。读不到就如实说读不到——不显示 0 条那种假数字。 */
  const refresh = useCallback(async () => {
    try {
      setInfo(await bridge.readCacheInfo())
      setInfoFailed(false)
    } catch (cause) {
      log("读取歌词缓存占用失败：", cause)
      setInfoFailed(true)
      setResult({ ok: false, message: "读不到歌词缓存占用（详情见运行日志）。" })
    }
  }, [bridge])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 一键清除：`withLocal` 决定要不要连本地导入一起删（回执里带新的占用）。 */
  async function clearCache() {
    setBusy(true)
    try {
      const next = await bridge.clearCache({ local: withLocal })
      setInfo(next)
      setResult({ ok: true, message: lyricsCacheClearedText(next, { local: withLocal }) })
    } catch (cause) {
      log("清除歌词缓存失败：", cause)
      setResult({ ok: false, message: "清除失败（详情见运行日志）：缓存可能只清掉了一部分。" })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** 用户选完文件：交给桥（解码 → 官方解析 → 落盘），成功即生效。 */
  async function onFilePicked(file: unknown) {
    if (lyrics === null) return
    setBusy(true)
    try {
      const picked = await lyrics.importFile(file)
      setResult({ ok: picked.ok, message: picked.message })
    } finally {
      setBusy(false)
      // 清空控件：同一个文件连选两次也要能触发 change（否则第二次"没反应"）
      if (fileRef.current !== null) fileRef.current.value = ""
    }
  }

  const canImport = lyrics?.canImport === true

  return (
    <Card data-testid="lyrics-cache-card">
      <CardHeader>
        <CardTitle>歌词缓存与本地导入</CardTitle>
        <CardDescription>
          在线取到的歌词会缓存在本机（90 天），也可以给某一首导入自己的 .lrc 文件——本地导入优先于任何在线结果。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground" data-testid="lyrics-cache-size">
          {lyricsCacheSizeText(info, { failed: infoFailed })}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
            刷新占用
          </Button>

          <div className="flex items-center gap-2">
            <Switch id="lyrics-clear-local" checked={withLocal} onCheckedChange={setWithLocal} />
            <Label htmlFor="lyrics-clear-local">连本地导入一起清</Label>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={busy}>
                清除歌词缓存
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>清除歌词缓存？</AlertDialogTitle>
                <AlertDialogDescription>
                  {withLocal
                    ? "会删掉在线缓存与你自己导入的歌词文件（本地导入不可恢复）。"
                    : "只删在线缓存；你自己导入的歌词会保留。"}
                  正在播放的歌不受影响，下一次取词会重新从来源获取。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => void clearCache()}>清除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept={LYRICS_IMPORT_ACCEPT}
            className="hidden"
            data-testid="lyrics-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void onFilePicked(file)
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !canImport}
            onClick={() => fileRef.current?.click()}
            data-testid="lyrics-import-button"
          >
            <UploadIcon />
            导入本地歌词（当前曲目）
          </Button>
          {canImport ? null : (
            <p className="text-xs text-muted-foreground">没有正在播放的曲目：先播一首，再导入歌词。</p>
          )}
        </div>

        {result === null ? null : (
          <p
            role="status"
            data-testid="lyrics-card-result"
            className={result.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
          >
            {result.message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
