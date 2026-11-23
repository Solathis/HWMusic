import { useRef, type CSSProperties, type ReactNode } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react"

import { APP_BRAND_LABEL } from "../shared/app-name.mjs"
import { Button } from "./components/ui/button"
import { useMainChrome } from "./use-main-chrome"

export function DesktopFrame({ children }: { children: ReactNode }) {
  const chrome = useMainChrome(true)
  const press = useRef<{ x: number; y: number } | null>(null)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground"
      style={{ "--desktop-titlebar-height": chrome.frameless ? "32px" : "0px" } as CSSProperties}>
      {chrome.frameless ? (
        <header className="flex h-8 shrink-0 select-none items-center border-b bg-background" data-testid="desktop-titlebar">
          <div className="flex h-full min-w-0 flex-1 items-center px-3 text-xs text-muted-foreground"
            onPointerDown={(event) => { press.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null }}
            onPointerUp={() => { press.current = null }}
            onPointerCancel={() => { press.current = null }}
            onPointerMove={(event) => {
              const origin = press.current
              if (!origin || event.buttons !== 1 || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 4) return
              press.current = null
              void getCurrentWindow().startDragging().catch(() => undefined)
            }}
            onDoubleClick={() => chrome.act("toggle-maximize")}>
            <span className="truncate">{APP_BRAND_LABEL}</span>
          </div>
          <Button variant="ghost" className="h-8 w-11 rounded-none px-0" aria-label="最小化窗口" onClick={() => chrome.act("minimize")}>
            <MinusIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" className="h-8 w-11 rounded-none px-0" aria-label={chrome.maximized ? "还原窗口" : "最大化窗口"} onClick={() => chrome.act("toggle-maximize")}>
            {chrome.maximized ? <CopyIcon className="size-3.5" /> : <SquareIcon className="size-3.5" />}
          </Button>
          <Button variant="ghost" className="h-8 w-11 rounded-none px-0" aria-label="关闭应用窗口" onClick={() => chrome.act("close")}>
            <XIcon className="size-4" />
          </Button>
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
