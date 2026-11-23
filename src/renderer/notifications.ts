import { toast } from "sonner"
import { APP_NOTICE } from "../shared/channels.ts"
import { playbackFailureText } from "./features/playback/playback-state.mjs"

type NoticeKind = "info" | "success" | "warning" | "error"
type Notify = (text: string, kind?: NoticeKind) => void

export function notify(text: string, kind: NoticeKind = "info") {
  const message = text.trim()
  if (message === "") return
  const existing = toast.getToasts().find((entry) => "title" in entry && entry.title === message)
  toast[kind](message, { id: existing?.id })
}

export function createPlaybackNoticeListener(show: Notify = notify) {
  let previousError: unknown = null
  let previousNotice: string | null = null
  return (state: { error?: unknown; notice?: string | null }) => {
    const error = state.error ?? null
    const notice = state.notice?.trim() || null
    if (error !== null && error !== previousError) show(playbackFailureText(error), "error")
    if (notice !== null && notice !== previousNotice && error === null) show(notice, "warning")
    previousError = error
    previousNotice = notice
  }
}

export function listenForAppNotices(
  subscribe: (channel: string, handler: (payload: unknown) => void) => Promise<() => void>,
  show: Notify = notify,
) {
  let disposed = false
  let unlisten: (() => void) | undefined
  void subscribe(APP_NOTICE, (payload) => {
    if (disposed || payload === null || typeof payload !== "object") return
    const text = (payload as { text?: unknown }).text
    if (typeof text === "string" && text.trim() !== "") show(text.trim())
  }).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  }).catch(() => {})
  return () => {
    disposed = true
    unlisten?.()
  }
}

export function notificationTheme(root?: { classList: { contains: (name: string) => boolean } }): "light" | "dark" | "system" {
  if (root?.classList.contains("dark")) return "dark"
  if (root?.classList.contains("light")) return "light"
  return "system"
}
