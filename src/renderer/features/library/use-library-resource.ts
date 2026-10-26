/**
 * 一次一页的库资源取数：页面（pages.tsx）与侧栏歌单列表共用这一份实现。
 * 载荷用 JSON 做依赖键、`select` 放 ref：都是为了让"每次渲染新建的对象/函数"不进依赖比较。
 */
import { useCallback, useEffect, useRef, useState } from "react"

import type { RequestChannel } from "../../../shared/request-channels.ts"
import { coreCall, isCoreError } from "../../host-api"
import { libraryFailureText } from "./library-state.mjs"

export interface Resource<T> {
  status: "loading" | "ready" | "error"
  data: T | null
  failure: { message: string; kind?: string } | null
}

/** `reload` 是"再取一次"的唯一入口：失败后的重试、歌单变了之后的刷新都走它。 */
export interface LibraryResource<T> extends Resource<T> {
  reload: () => void
}

export function useLibraryResource<T>(
  channel: RequestChannel,
  payload: unknown,
  select: (data: never) => T,
  enabled = true,
): LibraryResource<T> {
  const [state, setState] = useState<Resource<T>>({ status: "loading", data: null, failure: null })
  const [version, setVersion] = useState(0)
  const selectRef = useRef(select)
  selectRef.current = select
  const key = JSON.stringify(payload)
  const reload = useCallback(() => setVersion((value) => value + 1), [])

  // `version` 只在 reload 时变：它是"同一份载荷再取一次"的开关，不进载荷本身
  useEffect(() => {
    if (!enabled) {
      setState({ status: "ready", data: null, failure: null })
      return
    }
    let alive = true
    setState({ status: "loading", data: null, failure: null })
    void (async () => {
      try {
        const data = await coreCall(channel, JSON.parse(key))
        if (!alive) return
        setState({ status: "ready", data: selectRef.current(data as never), failure: null })
      } catch (failure) {
        if (!alive) return
        // 错误路径才写控制台；结构化错误的人话由 libraryFailureText 给（这里不编）
        console.warn(`库页面请求失败（${channel}）：`, failure)
        setState({
          status: "error",
          data: null,
          failure: isCoreError(failure) ? failure : { message: libraryFailureText(failure) },
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [channel, key, enabled, version])

  return { ...state, reload }
}
