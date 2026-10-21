/**
 * Workspace 注册表中 `subagent` 系列的归档准入：一个 Session 的哪些
 * 子代理后代仍在轮次之中，以及当 Session 连同其工作一起归档时如何停止它们。
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-workspace'
import { foldSubagentDescriptor } from './descriptor.ts'

/**
 * 用所查询 Session 正在运行的子代理后代响应 `workspace/session-activity`，
 * 并通过像其父代理那样取消每一个后代来响应 `workspace/session-stop`。
 * 两个监听器与 `ctx` 的 fiber 同生命周期。
 * @param ctx - 承载 Agent 注册表的上下文；Session 查询服务是可选的，仅用于提供标签。
 */
export function installSubagentArchiveAdmission(ctx: Context): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = runningDescendants(ctx, sessionId)
    const rest = await next()
    if (running.length === 0) return rest
    const own: SessionActivity = { kind: 'subagent', items: await Promise.all(running.map(child => describe(ctx, child))) }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    for (const child of runningDescendants(ctx, sessionId)) {
      try {
        child.cancel({ kind: 'parent' })
      } catch (error: unknown) {
        // 某个子代理拒绝取消，不能让其兄弟继续为一个已归档的父代理运行。
        ctx.logger.warn(`subagent: cancelling "${child.id}" for an archived Session failed: ${String(error)}`)
      }
    }
  })
}

/**
 * 按持久化血缘统计轮次内的活跃子代理后代：header 中指明其父代理且带有本包
 * 所记录 subagent origin 的子代理，任意深度均可。fork 共享血缘字段但没有
 * 该 origin，属于独立对话，因此从不持有其来源。血缘作为数据读取，所以
 * 损坏且成环的 header 链只会被访问一次。
 */
function runningDescendants(ctx: Context, rootId: SessionId): Agent[] {
  const childrenOf = new Map<SessionId, Agent[]>()
  for (const agent of ctx.agents.list()) {
    const { parentSession, origin } = agent.session.header
    if (parentSession === undefined || origin !== 'subagent') continue
    const siblings = childrenOf.get(parentSession) ?? []
    siblings.push(agent)
    childrenOf.set(parentSession, siblings)
  }
  const running: Agent[] = []
  const pending = [rootId]
  const visited = new Set<SessionId>()
  while (pending.length > 0) {
    const parentId = pending.shift() as SessionId
    if (visited.has(parentId)) continue
    visited.add(parentId)
    for (const child of childrenOf.get(parentId) ?? []) {
      if (child.status === 'running') running.push(child)
      pending.push(child.id)
    }
  }
  return running
}

/**
 * 子代理的活动条目：其 id 加上其描述符所携带的持久化创建标签，通过
 * 实时的 Session 观测读取。若没有 Session 查询服务，或描述符缺失/不可读，
 * 条目仅以 id 指名该子代理。
 */
async function describe(ctx: Context, child: Agent): Promise<SessionActivityItem> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return { id: child.id }
  try {
    using observation = await query.observeSession(child.id, { projectionMode: 'none' })
    const label = foldSubagentDescriptor(observation.events.slice(observation.inheritedEventCount))?.label
    return label === undefined ? { id: child.id } : { id: child.id, label }
  } catch {
    // 损坏的描述符属于子代理中的数据损坏；报告仍会指名该子代理。
    return { id: child.id }
  }
}
