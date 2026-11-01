/**
 * 「关于」里的软件更新：检查、下载进度、安装。
 * 状态与文案在 `features/settings/update-state.mjs`；进度来自宿主的 `update:progress` 广播。
 */
import { useEffect, useReducer } from "react"
import { Loader2Icon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Progress } from "./components/ui/progress"
import {
  CHECK_FAILED_FALLBACK,
  INSTALL_FAILED_FALLBACK,
  UPDATE_IDLE,
  failureText,
  releaseNoteGroups,
  updateReducer,
  updateView,
} from "./features/settings/update-state.mjs"
import { checkForUpdate, installUpdate, onCoreEvent } from "./host-api"
import { UPDATE_PROGRESS } from "../shared/channels.ts"

export function UpdatePanel() {
  const [state, dispatch] = useReducer(updateReducer, UPDATE_IDLE)

  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | null = null
    onCoreEvent(UPDATE_PROGRESS, (event) => dispatch({ type: "progress", event }))
      .then((stop) => {
        if (alive) unlisten = stop
        else stop()
      })
      .catch(() => {})
    return () => {
      alive = false
      unlisten?.()
    }
  }, [])

  const view = updateView(state)
  const groups = releaseNoteGroups(view.notes)

  const run = () => {
    if (view.action === "install") {
      dispatch({ type: "install" })
      installUpdate()
        .then(() => dispatch({ type: "progress", event: { phase: "installing" } }))
        .catch((failure) => dispatch({ type: "install-failed", message: failureText(failure, INSTALL_FAILED_FALLBACK) }))
      return
    }
    dispatch({ type: "check" })
    checkForUpdate()
      .then((answer) => dispatch({ type: "checked", answer }))
      .catch((failure) => dispatch({ type: "check-failed", message: failureText(failure, CHECK_FAILED_FALLBACK) }))
  }

  return (
    <div className="flex flex-col gap-3" data-testid="update-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">软件更新</span>
          {view.status ? <span className="text-sm text-muted-foreground">{view.status}</span> : null}
        </div>
        <Button variant="outline" size="sm" disabled={view.busy} onClick={run}>
          {view.busy ? <Loader2Icon data-icon="inline-start" className="motion-safe:animate-spin" /> : null}
          {view.actionLabel}
        </Button>
      </div>
      {view.showProgress ? (
        <div className="flex flex-col gap-1">
          <Progress value={view.percent} aria-label="下载进度" />
          <span className="text-xs text-muted-foreground">{view.progressText}</span>
        </div>
      ) : null}
      {view.failureTitle ? (
        <Alert variant="destructive">
          <AlertTitle>{view.failureTitle}</AlertTitle>
          <AlertDescription>{view.failureMessage}</AlertDescription>
        </Alert>
      ) : null}
      {groups.length > 0 ? (
        <div className="flex flex-col gap-2 text-sm" data-testid="update-notes">
          {groups.map((group, index) => (
            <div key={`${group.title}-${index}`} className="flex flex-col gap-1">
              {group.title ? <span className="font-medium">{group.title}</span> : null}
              <ul className="list-disc pl-5 text-muted-foreground">
                {group.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
