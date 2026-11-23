import { useEffect, useMemo } from "react"
import { onCoreEvent } from "./host-api.ts"
import type { PlayerRuntime } from "./features/playback/player-runtime.ts"
import { createPlaybackNoticeListener, listenForAppNotices } from "./notifications.ts"

export function useAppNotifications() {
  useEffect(() => listenForAppNotices(onCoreEvent), [])
}

export function usePlayerNotifications(player: PlayerRuntime["player"]) {
  const receive = useMemo(() => createPlaybackNoticeListener(), [player])
  useEffect(() => {
    receive(player.snapshot())
    const unsubscribe = player.subscribe(receive)
    return () => { unsubscribe() }
  }, [player, receive])
}
