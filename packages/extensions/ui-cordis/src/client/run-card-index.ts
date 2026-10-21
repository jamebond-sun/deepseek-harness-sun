/** 针对 `cordis_run` 卡片上 Package 业务视图的、会话局部的归属索引。 */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from './events.ts'

/** 一个 Package 自有业务视图的稳定 keyed-slot 身份。 */
export type CordisToolViewKey = `${CordisDynamicPluginId}.${CordisDynamicPackageId}`

/** 一个成功争夺承载 Package 业务视图的工具结果。 */
export interface CordisRunCardPointer {
  readonly key: CordisToolViewKey
  readonly callId: string
  readonly seq: number
  readonly pluginRunId: CordisDynamicPluginRunId
}

/** 每个已挂载 Run 卡片所消费的、按会话的可观察索引。 */
export interface CordisRunCardStore extends HostObservable<ReadonlyMap<CordisToolViewKey, CordisRunCardPointer>> {
  /** 发布一个成功的 Run 结果；只有更大的日志序号才能替换它。 */
  observe(pointer: CordisRunCardPointer): void
}

function createStore(): CordisRunCardStore {
  const pointers = new Map<CordisToolViewKey, CordisRunCardPointer>()
  const listeners = new Set<() => void>()
  let cache: ReadonlyMap<CordisToolViewKey, CordisRunCardPointer> | undefined
  return {
    getSnapshot: () => cache ??= new Map(pointers),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observe: (pointer) => {
      const current = pointers.get(pointer.key)
      if (current !== undefined && current.seq >= pointer.seq) return
      pointers.set(pointer.key, pointer)
      cache = undefined
      for (const listener of [...listeners]) listener()
    },
  }
}

/** 页面生命周期的注册表，让一个会话的所有卡片共享同一 Store。 */
export class CordisRunCardRegistry {
  private readonly sessions = new Map<SessionId, CordisRunCardStore>()

  /**
   * 返回会话持久化的页面局部 Store。
   * @param sessionId - 其卡片共享 supersession 状态的会话。
   * @returns 为该会话保留的页面局部 Store。
   */
  forSession(sessionId: SessionId): CordisRunCardStore {
    let store = this.sessions.get(sessionId)
    if (store === undefined) {
      store = createStore()
      this.sessions.set(sessionId, store)
    }
    return store
  }
}

/**
 * 构建注册与 Run 卡片所共享的 Package 业务视图键。
 * @param pluginId - 稳定的 Plugin 身份。
 * @param packageId - 不可变的 Package 身份。
 * @returns 共享的业务视图键。
 */
export function cordisToolViewKey(
  pluginId: CordisDynamicPluginId,
  packageId: CordisDynamicPackageId,
): CordisToolViewKey {
  return `${pluginId}.${packageId}`
}
