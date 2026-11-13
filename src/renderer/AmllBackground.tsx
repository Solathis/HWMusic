/**
 * AMLL 流体背景：AMLL 官方 `BackgroundRender` 的宿主。
 * 宿主只做三件事：定位容器、把在播/有没有歌词传下去、给组件一个 100% 尺寸的盒子。
 * 封面走 `albumUrl` 入口：渲染层先用 `new Image()` 加载（走 CSP 的 `img-src`），再把元素交给 AMLL。
 * 竞态处理就两条：换地址时 `alive` 标记让旧回调失效；加载失败回 `null`，背景照常渲染。
 * 这里用的是**带 CORS** 的那一份加载（背景要取色）；封面本身能不能显示由 `useCoverImage` 单独判。
 */
import { BackgroundRender } from "@applemusic-like-lyrics/react"
import { useEffect, useState } from "react"
import { useMotionPolicy } from "./features/motion/MotionProvider"

export interface AmllBackgroundProps {
  /** 在播状态（决定背景是否流动） */
  playing: boolean
  /** 这首歌是否有歌词（背景会据此变活跃；不知道时传 true） */
  hasLyric: boolean
  /** 专辑图（HTMLImageElement 而不是 URL：字符串会被 AMLL 拿去 fetch，撞 CSP connect-src） */
  albumArt?: HTMLImageElement | HTMLVideoElement
  /**
   * 专辑图地址：宿主自己用 `new Image()` 载入，加载成功才交给 AMLL；与 `albumArt` 同时给时以 `albumArt` 为准。
   */
  albumUrl?: string | null
}

/**
 * 把封面地址变成 `HTMLImageElement`（AMLL 只认元素）。
 * `crossOrigin` 决定这次加载要不要跨域授权：背景取色必须带（AMLL 会 `getImageData` 采样，没带 CORS 的跨域图会让画布 tainted 并抛 `SecurityError`），
 * 而"这张图能不能显示"不需要（无 ACAO 的 CDN 图照样画得出来）。
 * 不用 `decode()`：`load` 到了元数据就够，AMLL 自己会画。竞态只有两条：换地址时 `alive` 让旧回调失效；加载失败回 `null`。
 */
function useImageElement(url: string | null | undefined, crossOrigin: boolean): HTMLImageElement | null {
  const [element, setElement] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    if (typeof url !== "string" || url.trim() === "") {
      setElement(null)
      return undefined
    }
    let alive = true
    const image = new Image()
    // 顺序要紧：crossOrigin 必须在 src 之前设（设晚了这一次请求已经发出去了，等于没设）
    if (crossOrigin) image.crossOrigin = "anonymous"
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
  }, [url, crossOrigin])

  return element?.getAttribute("src") === url ? element : null
}

/** 背景取色用的封面：**带** CORS（跨域图没有 ACAO 时这里就是 null，画布不会拿到污染图像）。 */
export function useAlbumImage(url: string | null | undefined): HTMLImageElement | null {
  return useImageElement(url, true)
}

/**
 * 显示用的封面：**不带** CORS 的普通加载。
 * 只要浏览器能画出这张图就算数——无 `Access-Control-Allow-Origin` 的 CDN 图也是"有封面"，
 * 不能因为背景取色那条路走不通就把封面换成"暂无封面"占位。
 */
export function useCoverImage(url: string | null | undefined): HTMLImageElement | null {
  return useImageElement(url, false)
}

export function AmllBackground({ playing, hasLyric, albumArt, albumUrl }: AmllBackgroundProps) {
  const { decorationsActive } = useMotionPolicy()
  const loaded = useAlbumImage(albumUrl)
  const album = albumArt ?? loaded ?? undefined

  return (
    <div className="absolute inset-0 overflow-hidden" data-testid="amll-background" aria-hidden="true">
      <BackgroundRender
        key={album?.src ?? "empty"}
        album={album}
        staticMode={!playing || !decorationsActive}
        hasLyric={hasLyric}
        renderScale={0.5}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
