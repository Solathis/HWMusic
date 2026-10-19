/**
 * 歌单网格（R8）：卡片一律是 shadcn 的 Card + Button，自己只负责排列与文案。
 *
 * **本任务不加载远程封面**：封面要过 CSP 的 `img-src` 白名单与 CDN 校验
 * （docs/API_CONTRACT.md §2.4），那条链路待联调确认。所以封面位置是一个 `bg-muted`
 * 占位方块 + lucide 图标——不做"先 img 再说"（结果是一排碎图，比占位更糟）。
 */
import { ListMusicIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { Card, CardContent, CardFooter } from "./components/ui/card"
import { EmptyState } from "./components"
import { playlistIdOf, playlistNameOf, playlistSongCountOf } from "./features/library/playlist-fields.mjs"

export interface PlaylistGridProps {
  playlists: unknown[]
  emptyText: string
  onOpen: (playlistId: string, playlist: unknown) => void
}

export function PlaylistGrid({ playlists, emptyText, onOpen }: PlaylistGridProps) {
  if (playlists.length === 0) return <EmptyState text={emptyText} />

  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-4 p-4"
      data-testid="playlist-grid"
    >
      {playlists.map((playlist, index) => {
        const id = playlistIdOf(playlist)
        const count = playlistSongCountOf(playlist)
        return (
          <Card key={id ?? `playlist-${index}`} size="sm">
            <CardContent className="flex flex-col gap-3">
              <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
                <ListMusicIcon className="size-6 text-muted-foreground" />
              </div>
              <span className="truncate text-sm font-medium">{playlistNameOf(playlist)}</span>
            </CardContent>
            <CardFooter className="justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {count === null ? "曲目数待联调" : `${count} 首`}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={id === null}
                onClick={() => {
                  if (id === null) return
                  onOpen(id, playlist)
                }}
              >
                打开
              </Button>
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}
