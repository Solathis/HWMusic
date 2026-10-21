/**
 * 歌单网格（R8）：卡片一律是 shadcn 的 Card + Button，自己只负责排列与文案。
 *
 * **封面（R38 点亮）**：`<img>` + `loading="lazy"`，地址来自协议层的白名单投影
 * （`normalizePlaylist` 只保留 CDN 白名单内的 `coverUrl`），**绝不 fetch**——
 * 图片走 CSP 的 `img-src`，而 `connect-src` 只有 self/ipc（docs/API_CONTRACT.md §2.4）。
 * 没有地址或加载失败时保留占位（`bg-muted` + lucide 图标），不留碎图。
 */
import { ListMusicIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import { Card, CardContent, CardFooter } from "./components/ui/card"
import { CoverArt, EmptyState } from "./components"
import {
  playlistCoverUrlOf,
  playlistIdOf,
  playlistNameOf,
  playlistSongCountOf,
} from "./features/library/playlist-fields.mjs"

export interface PlaylistGridProps {
  playlists: unknown[]
  emptyText: string
  onOpen: (playlistId: string, playlist: unknown) => void
}

/**
 * 歌单卡封面：有白名单内的地址就用 `<img>`（懒加载 + 失败落回占位），否则直接占位。
 *
 * 复用主界面那一个 `CoverArt`（占位图标换成清单图标，与歌单的语义一致）——
 * 封面这件事只有一处实现，`<img>`/`loading`/失败兜底就不会各写一份。
 */
function PlaylistCover({ coverUrl }: { coverUrl: string | null }) {
  return (
    <CoverArt
      coverUrl={coverUrl}
      className="aspect-square w-full rounded-md"
      iconClassName="size-6"
      icon={ListMusicIcon}
    />
  )
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
              <PlaylistCover coverUrl={playlistCoverUrlOf(playlist)} />
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
