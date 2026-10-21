/**
 * 从父代理自有的目录中发现直接子代理与递归后代。
 * 每次目录读取在进入下一分支之前释放其 Session 观测。
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from './control-types.ts'
import { SubagentError } from './error.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'

export type { SubagentListEntry } from './control-types.ts'

/** 一个目录后代，及其直接父代理和距所请求根节点的边距离。 */
export type SubagentDescendantListEntry = SubagentListEntry & {
  /** 其目录包含该子代理的父代理。 */
  readonly parentId: SessionId
  /** 距所请求根节点的边距离；直接子代理为 `1`。 */
  readonly depth: number
}

/**
 * 通过实时优先的 Session 观测读取一个父代理的持久化目录。
 * @param ctx - 承载 Session 查询服务的上下文。
 * @param parentSessionId - 请求其直接子代理的父代理。
 * @param signal - 转发给 Session 观测的取消信号。
 * @returns 按父目录事件顺序排列的直接子代理行。
 * @throws {@link SubagentError} 当查询或目录投影不可用时。
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentCatalogEntry[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)',
      'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
    )
  }
  using parent = await query.observeSession(parentSessionId, {
    ...signal === undefined ? {} : { signal },
  })
  const entries = parent.projections?.values.subagentCatalog
  if (entries === undefined) {
    throw new SubagentError(
      'listing subagents requires the registered subagentCatalog projection',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  return entries
}

/**
 * 以稳定的前序遍历可达的父目录，而不加载 Agents。
 * @see SubagentRuntime.listDescendants 了解失败与取消语义。
 * @param ctx - 承载 Session store 与查询服务的上下文。
 * @param rootSessionId - 以其目录开始遍历的父代理。
 * @param signal - 在每次目录读取前后检查的取消信号。
 * @returns 带有目录父代理与深度的子代理及分支诊断。
 */
export async function listDescendants(
  ctx: Context,
  rootSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentDescendantListEntry[]> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @deepseek-ai/dsh-session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  const readChildren = async (id: SessionId): Promise<SubagentCatalogEntry[]> => {
    assertListingNotCancelled(signal)
    let children: SubagentCatalogEntry[]
    try {
      children = await listChildren(ctx, id, signal)
    } catch (error) {
      assertListingNotCancelled(signal)
      throw error
    }
    assertListingNotCancelled(signal)
    return children
  }
  const stack = (await readChildren(rootSessionId))
    .map(entry => ({ entry, parentId: rootSessionId, depth: 1 }))
    .reverse()
  const visited = new Set<SessionId>([rootSessionId])
  const result: SubagentDescendantListEntry[] = []
  for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
    const { entry, parentId, depth } = position
    if (visited.has(entry.id)) continue
    visited.add(entry.id)
    let children: SubagentCatalogEntry[]
    try {
      children = entry.mode === 'external' ? [] : await readChildren(entry.id)
    } catch (error) {
      if (error instanceof SubagentError) throw error
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      result.push({
        kind: 'diagnostic', id: entry.id, parentId, depth,
        reason: code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_SOURCE_CONFLICT'
          ? 'corrupt' : 'unavailable',
      })
      continue
    }
    if (entry.mode === 'unknown') {
      result.push({ kind: 'diagnostic', id: entry.id, parentId, depth, reason: 'unsupported' })
    } else {
      const { createdAt: _createdAt, ...identity } = entry
      result.push({
        ...identity, kind: 'child', parentId, depth,
        activity: sessions.get(entry.id) === undefined ? 'inactive' : 'running',
        hasChildren: children.length > 0,
      })
    }
    // 目录事件顺序定义兄弟次序；栈接下来访问第一个。
    for (const child of [...children].reverse()) {
      stack.push({ entry: child, parentId: entry.id, depth: depth + 1 })
    }
  }
  return result
}

/** 当调用方取消时中止整个遍历。 */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}
