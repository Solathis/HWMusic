/**
 * 侧栏「我的歌单」：组标题 + 歌单列表（封面 / 名字 / 歌曲数量）。
 * 数据只在这里取一次并留在内存（侧栏随外壳常驻，切页不重取）；窄轨（48px）里只剩封面，名字与数量交给 tooltip。
 */
import { ListMusicIcon, RefreshCwIcon } from "lucide-react"

import { LIBRARY_PLAYLISTS } from "../shared/request-channels.ts"
import { Button } from "./components/ui/button"
import { ScrollArea } from "./components/ui/scroll-area"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "./components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
import { CoverArt } from "./components"
import { libraryFailureText } from "./features/library/library-state.mjs"
import { PAGINATION_PAGE_SIZE } from "./features/library/pagination.mjs"
import {
  SIDEBAR_PLAYLIST_ITEM_TESTID,
  SIDEBAR_PLAYLIST_META_TESTID,
  SIDEBAR_PLAYLIST_NAME_TESTID,
  SIDEBAR_PLAYLISTS_EMPTY_TESTID,
  SIDEBAR_PLAYLISTS_EMPTY_TEXT,
  SIDEBAR_PLAYLISTS_FAILURE_TESTID,
  SIDEBAR_PLAYLISTS_LABEL,
  SIDEBAR_PLAYLISTS_LIST_TESTID,
  SIDEBAR_PLAYLISTS_RETRY_LABEL,
  SIDEBAR_PLAYLISTS_SKELETON_TESTID,
  SIDEBAR_PLAYLISTS_TESTID,
  sidebarPlaylistItems,
} from "./features/library/sidebar-playlists.mjs"
import { useLibraryResource } from "./features/library/use-library-resource.ts"

/** 与原来的「我的歌单」页同一条通道、同一个页大小（不新增端点）。 */
const PLAYLISTS_REQUEST = { page: 1, pageSize: PAGINATION_PAGE_SIZE }

function playlistsOf(data: { playlists?: unknown[] }) {
  return data.playlists ?? []
}

export interface SidebarPlaylistsProps {
  /** 当前打开的歌单（`playlist-detail` 的视图参数）；null = 没有打开任何歌单 */
  activePlaylistId: string | null
  onOpen: (playlistId: string, playlist: unknown) => void
}

export function SidebarPlaylists({ activePlaylistId, onOpen }: SidebarPlaylistsProps) {
  const resource = useLibraryResource<unknown[]>(LIBRARY_PLAYLISTS, PLAYLISTS_REQUEST, playlistsOf)
  const { reload } = resource

  const items = sidebarPlaylistItems(resource.data)

  let body
  if (resource.status === "loading") {
    body = (
      <SidebarMenu data-testid={SIDEBAR_PLAYLISTS_SKELETON_TESTID}>
        {[0, 1, 2].map((index) => (
          <SidebarMenuItem key={index}>
            <SidebarMenuSkeleton showIcon />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    )
  } else if (resource.status === "error") {
    body = (
      <div className="flex flex-col gap-1 px-1 py-1" data-testid={SIDEBAR_PLAYLISTS_FAILURE_TESTID}>
        <p className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {libraryFailureText(resource.failure)}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="w-fit group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:p-0"
          aria-label={SIDEBAR_PLAYLISTS_RETRY_LABEL}
          onClick={reload}
        >
          <RefreshCwIcon />
          <span className="group-data-[collapsible=icon]:hidden">{SIDEBAR_PLAYLISTS_RETRY_LABEL}</span>
        </Button>
      </div>
    )
  } else if (items.length === 0) {
    body = (
      <p
        className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
        data-testid={SIDEBAR_PLAYLISTS_EMPTY_TESTID}
      >
        {SIDEBAR_PLAYLISTS_EMPTY_TEXT}
      </p>
    )
  } else {
    body = (
      // 列表自己滚：歌单上百张时不许把「音乐库」那一组和底部账号区顶出画面。
      // 最后那一段把 radix viewport 的 display:table 内容盒压回 block，否则长名字会把列表撑宽。
      <ScrollArea className="h-full min-w-0 group-data-[collapsible=icon]:h-auto [&_[data-slot=scroll-area-viewport]>div]:!block">
        <SidebarMenu data-testid={SIDEBAR_PLAYLISTS_LIST_TESTID}>
          {items.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                size="lg"
                isActive={item.id === activePlaylistId}
                tooltip={item.tooltipText}
                data-testid={SIDEBAR_PLAYLIST_ITEM_TESTID}
                className="group-data-[collapsible=icon]:justify-center"
                onClick={() => onOpen(item.id, item.source)}
              >
                <CoverArt
                  coverUrl={item.coverUrl}
                  className="size-8 rounded-md"
                  iconClassName="size-4"
                  icon={ListMusicIcon}
                />
                <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
                  {/* 名字单行截断；截断之后靠悬停给出全名（展开态也看得到） */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate text-sm font-medium" data-testid={SIDEBAR_PLAYLIST_NAME_TESTID}>
                        {item.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">{item.name}</TooltipContent>
                  </Tooltip>
                  {item.metaText === null ? null : (
                    <span
                      className="truncate text-xs text-muted-foreground"
                      data-testid={SIDEBAR_PLAYLIST_META_TESTID}
                    >
                      {item.metaText}
                    </span>
                  )}
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </ScrollArea>
    )
  }

  return (
    <SidebarGroup
      data-testid={SIDEBAR_PLAYLISTS_TESTID}
      className="min-h-0 flex-1 gap-1 group-data-[collapsible=icon]:flex-none"
    >
      <SidebarGroupLabel>{SIDEBAR_PLAYLISTS_LABEL}</SidebarGroupLabel>
      <SidebarGroupContent className="min-h-0 flex-1">{body}</SidebarGroupContent>
    </SidebarGroup>
  )
}
