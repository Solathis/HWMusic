/**
 * 行的专属右键菜单：曲目表与播放队列共用这一份。
 * 菜单项与动作 id 全由 features/shell/track-menu.mjs 决定（纯逻辑，测试按 id 认），这里只把 id 接到动作上。
 */
import type { ReactNode } from "react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./components/ui/context-menu"
import { TRACK_MENU_ITEM, TRACK_MENU_TESTID, trackMenuItemTestId, trackMenuItems } from "./features/shell/track-menu.mjs"

/** 行菜单需要的两个播放动作（由外壳沿 props 下发：页面拿不到音频，也拿不到地址）。 */
export interface TrackRowActions {
  /** 插到当前曲目之后 */
  onPlayNext?: (songs: unknown[]) => void
  /** 追加到队尾 */
  onEnqueue?: (songs: unknown[]) => void
}

export interface TrackRowMenuProps extends TrackRowActions {
  /** 行的来源（决定菜单项集合：曲目表一档、队列一档） */
  target: string
  /** 这一行代表的那一首；「下一首播放」「加入播放队列」作用于它 */
  songs: unknown[]
  /** 「播放」= 这一行的既有语义（曲目行是双击那种连队列一起播，队列行是跳播） */
  onPlay?: () => void
  canPlay?: boolean
  children: ReactNode
}

/**
 * 把一行包进右键菜单。**一项都出不来时不包**（没有动作就没有菜单，也不弹一个空框）。
 * 空白处没有这层包装，所以那里右键只被入口的守卫吃掉、什么都不弹。
 */
export function TrackRowMenu({
  target,
  songs,
  onPlay,
  onPlayNext,
  onEnqueue,
  canPlay = true,
  children,
}: TrackRowMenuProps) {
  const items = trackMenuItems(target, {
    play: canPlay,
    playNext: onPlayNext !== undefined,
    enqueue: onEnqueue !== undefined,
  })

  const run = (id: string) => {
    if (id === TRACK_MENU_ITEM.play) onPlay?.()
    else if (id === TRACK_MENU_ITEM.playNext) onPlayNext?.(songs)
    else if (id === TRACK_MENU_ITEM.enqueue) onEnqueue?.(songs)
  }

  if (items.length === 0) return <>{children}</>

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid={TRACK_MENU_TESTID}>
        {items.map((item) => (
          <ContextMenuItem key={item.id} data-testid={trackMenuItemTestId(item.id)} onSelect={() => run(item.id)}>
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
