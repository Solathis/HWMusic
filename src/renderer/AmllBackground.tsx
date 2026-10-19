/**
 * AMLL 流体背景（R9）：AMLL 官方 `BackgroundRender` 的**宿主**。
 *
 * 宿主只做三件事（其余全是官方组件的事）：
 * 1. 定位容器（绝对定位铺满舞台）；
 * 2. 把"在播/有没有歌词"这两个事实传下去（背景会据此调整活跃度）；
 * 3. 给组件一个 100% 尺寸的盒子——AMLL 的渲染器按容器尺寸建画布，
 *    没有尺寸就什么都画不出来。
 *
 * 关于封面：**本任务不传**。理由有两条，都是硬的：
 * - 曲目投影里没有封面地址字段（`features/library/track-fields.mjs` 只认已确认的键，
 *   猜一个 `coverUrl` 只会得到一排碎图）；
 * - AMLL 对**字符串**地址会自己 `fetch` 成 blob（`amll-core` 的 `loadImage`），
 *   而 CSP 的 `connect-src` 只有 `'self' ipc:` —— 那条 fetch 会被拦掉。
 *   封面链路要接通的话，得先用 `<img>`（`img-src` 白名单放行）加载，再把
 *   `HTMLImageElement` 传进来；那需要先确认封面字段名（联调后的事）。
 *
 * 内联 `style` 是全项目仅有的两处例外之一（AMLL 的 100% 尺寸），由 theme-tokens 扫描钉住。
 */
import { BackgroundRender } from "@applemusic-like-lyrics/react"

export interface AmllBackgroundProps {
  /** 在播状态（决定背景是否流动） */
  playing: boolean
  /** 这首歌是否有歌词（背景会据此变活跃；不知道时传 true） */
  hasLyric: boolean
  /** 专辑图（HTMLImageElement 而不是 URL：字符串会被 AMLL 拿去 fetch，撞 CSP connect-src） */
  albumArt?: HTMLImageElement | HTMLVideoElement
}

export function AmllBackground({ playing, hasLyric, albumArt }: AmllBackgroundProps) {
  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="amll-background" aria-hidden="true">
      <BackgroundRender
        album={albumArt}
        playing={playing}
        hasLyric={hasLyric}
        renderScale={0.5}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
