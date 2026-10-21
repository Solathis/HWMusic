/**
 * AMLL 流体背景（R9）：AMLL 官方 `BackgroundRender` 的**宿主**。
 *
 * 宿主只做三件事（其余全是官方组件的事）：
 * 1. 定位容器（绝对定位铺满舞台）；
 * 2. 把"在播/有没有歌词"这两个事实传下去（背景会据此调整活跃度）；
 * 3. 给组件一个 100% 尺寸的盒子——AMLL 的渲染器按容器尺寸建画布，
 *    没有尺寸就什么都画不出来。
 *
 * ## 封面（R40 接通）
 *
 * AMLL 对**字符串**地址会自己 `fetch` 成 blob（`amll-core` 的 `loadImage`），而 CSP 的
 * `connect-src` 只有 `'self' ipc:`——那条 fetch 会被拦掉（R38 已确认，见 docs 的未接线项）。
 * 所以这里给调用方一个 `albumUrl` 入口：**渲染层先自己用 `new Image()` 把图加载出来**
 * （图片走 CSP 的 `img-src`，是允许的那条路），再把 `HTMLImageElement` 交给 AMLL。
 *
 * 竞态处理就两条：
 * - 换地址（换歌单/换曲目）时 `alive` 标记让上一个元素的 load 回调失效，不会把旧图贴到新标题上；
 * - 加载失败（404/过期）就回 `null`，背景照旧渲染（只是没有专辑图）——不留碎图、不报错。
 *
 * 内联 `style` 是全项目仅有的两处例外之一（AMLL 的 100% 尺寸），由 theme-tokens 扫描钉住。
 */
import { BackgroundRender } from "@applemusic-like-lyrics/react"
import { useEffect, useState } from "react"

export interface AmllBackgroundProps {
  /** 在播状态（决定背景是否流动） */
  playing: boolean
  /** 这首歌是否有歌词（背景会据此变活跃；不知道时传 true） */
  hasLyric: boolean
  /** 专辑图（HTMLImageElement 而不是 URL：字符串会被 AMLL 拿去 fetch，撞 CSP connect-src） */
  albumArt?: HTMLImageElement | HTMLVideoElement
  /**
   * 专辑图地址（R40）：宿主自己用 `new Image()` 载入（`img-src` 白名单内），
   * 加载成功才交给 AMLL。与 `albumArt` 同时给时以 `albumArt` 为准（调用方已经自己造好了元素）。
   */
  albumUrl?: string | null
}

/**
 * 把封面地址变成 `HTMLImageElement`（AMLL 只认元素）。
 *
 * **必须带 `crossOrigin="anonymous"`**（R40 真机取证，`.tmp/r40-cover-cors.json`）：
 * AMLL 的 `MeshGradientRenderer.setAlbum` 会 `getImageData` 采样专辑图来取渐变色，而
 * **没带 CORS 的跨域图会把画布标记为 tainted** → `getImageData` 抛 `SecurityError`
 * （CDP 现场抓到过这条 pageerror）。实测 CDN（`contentcenter-drcn.dbankcdn.cn`）对带
 * `crossorigin` 的请求会回 `Access-Control-Allow-Origin`，于是图照常加载、采样也成功。
 * 万一某个域哪天不回了，图会加载失败 → 走下面的 `error` 分支回 `null`
 * （背景照常渲染，只是没有专辑图——**降级，不是崩**）。
 *
 * 不用 `decode()`：`load` 事件到了就说明解码必要的元数据已经可用，AMLL 自己会画；
 * `decode()` 在 WebView2 上还要多一层 Promise 竞态，收益只是省一次可能的闪烁。
 */
function useAlbumImage(url: string | null | undefined): HTMLImageElement | null {
  const [element, setElement] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    if (typeof url !== "string" || url.trim() === "") {
      setElement(null)
      return undefined
    }
    let alive = true
    const image = new Image()
    // 顺序要紧：crossOrigin 必须在 src 之前设（设晚了这一次请求已经发出去了，等于没设）
    image.crossOrigin = "anonymous"
    image.addEventListener(
      "load",
      () => {
        if (alive) setElement(image)
      },
      { once: true },
    )
    image.addEventListener(
      "error",
      () => {
        // 加载失败 = 这张图这次用不了：回 null，背景照常渲染（没有专辑图的那一档）
        if (alive) setElement(null)
      },
      { once: true },
    )
    image.src = url
    return () => {
      alive = false
    }
  }, [url])

  return element
}

export function AmllBackground({ playing, hasLyric, albumArt, albumUrl }: AmllBackgroundProps) {
  const loaded = useAlbumImage(albumUrl)

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="amll-background" aria-hidden="true">
      <BackgroundRender
        album={albumArt ?? loaded ?? undefined}
        playing={playing}
        hasLyric={hasLyric}
        renderScale={0.5}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
