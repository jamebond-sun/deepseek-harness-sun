/**
 * 控制器对已归档 Session 的准入闸门：已归档的 Session 或其
 * subagent 后代在恢复之前不得运行任何模型步骤。Session 仍在
 * 运行的工作由其拥有者——Agent 注册表（`turn`）、job 注册表
 * 接缝（`job`）、Subagent 运行时（`subagent`）与 Schedule 插件
 * （`schedule`）——通过 Workspace 注册表的归档准入事件报告并停止。
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'

/**
 * 作为 `ctx.plugin(...)` 插件的闸门：它在 Agent 注册表、Session 存储与
 * Workspace 注册表可用后加载，并随插件的 fiber 一起展开。对已归档
 * Session 的迟到唤醒投递——subagent 结算、排队的后续任务——会提议
 * 一个被闸门拒绝的步骤，循环将其以 `blocked` 结束而不发出请求；
 * 取消归档会为整个谱系解除闸门。
 */
export const ArchivedSessionGate: Plugin.Object<void> = {
  name: 'archived-session-gate',
  inject: ['agents', 'sessions', 'workspaceRegistry'],
  apply(ctx: Context): void {
    ctx.on('agent/pre-step', (payload, next) =>
      underArchivedSession(ctx, payload.agent)
        ? Promise.resolve({ kind: 'reject' as const })
        : next())
  },
}

/**
 * 该 Agent 的 Session 或其 subagent 谱系中位于其上方的 Session
 * 是否已归档。谱系仅通过 subagent 来源的 Session 沿持久化
 * header 字段追溯：已归档 Session 的分叉是一个独立对话。
 * @param ctx - Host 上下文。
 * @param agent - 提议步骤的 Agent。
 * @returns 是否有已归档 Session 拥有该步骤。
 */
export function underArchivedSession(ctx: Context, agent: Agent): boolean {
  const archived = ctx.workspaceRegistry.archivedSessionIds
  let header = agent.session.header
  const visited = new Set<SessionId>()
  while (!visited.has(header.id)) {
    if (archived.includes(header.id)) return true
    visited.add(header.id)
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    const parent = ctx.sessions.get(header.parentSession)
    if (parent === undefined) return archived.includes(header.parentSession)
    header = parent.header
  }
  return false
}
