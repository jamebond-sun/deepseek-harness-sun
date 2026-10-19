/**
 * Workspace 注册表 archive 准入的 `turn` 家族：Session 自身的 Agent 是否
 * 处于一个 turn 中，以及当 Session 连同其工作被归档时的取消。由注册表的
 * 构造函数安装，因此它为注册表发布的每个 Agent 作答。
 *
 * @module @deepseek-ai/dsh-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import type { Agent } from './types.ts'

/**
 * 当 Session 的 Agent 正在运行（包括等待审批或答复的 turn）时，以 `turn`
 * 家族回答 `workspace/session-activity`；并以用户自己停止的方式 ——
 * `agent.cancel({ kind: 'user' })`，但不带停止按钮的 `keepInbox` —— 取消
 * 该 turn 来回答 `workspace/session-stop`，因此排队的输入被丢弃并记录
 * inbox splice，而不是稍后唤醒已归档的 Session。没有任何东西被等待到
 * 结算。两个监听器的存活期都与 `ctx` 的 fiber 相同。
 * @param ctx - 注册表的注册上下文。
 * @param lookup - 注册表按 Session id 的活跃 Agent 查找。
 */
export function installTurnArchiveAdmission(ctx: Context, lookup: (sessionId: SessionId) => Agent | undefined): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = lookup(sessionId)?.status === 'running'
    const rest = await next()
    if (!running) return rest
    const own: SessionActivity = { kind: 'turn' }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    const agent = lookup(sessionId)
    if (agent?.status === 'running') agent.cancel({ kind: 'user' })
  })
}
