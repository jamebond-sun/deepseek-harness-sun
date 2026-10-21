/** 针对最新已记录请求路由的账户登出策略。 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from './index.ts'

/**
 * 识别最近一次绑定的请求使用了账户路由的、正在运行的工作。
 * @param agent - 带有其持久化请求上下文的、存活中的 Agent。
 * @returns 账户登出是否应当中断此任务。
 */
export function isRunningAccountTask(agent: Pick<Agent, 'status' | 'session'>): boolean {
  return agent.status === 'running' && agent.session.requestContext()?.provider === 'deepseek-account'
}

/**
 * 取消已登出的账户任务，并为被拒绝的请求发布登录指引。
 * @param ctx - 账户提供方的生命周期；Agents 可能在之后才挂载。
 */
export function installAccountTaskCancellation(ctx: Context): void {
  ctx.inject(['agents'], (scope) => {
    scope.on('agent/error', ({ error }) => {
      if (error instanceof LlmError && error.code === 'ACCOUNT_SIGN_IN_REQUIRED') {
        scope.emit('deepseek-account/model-sign-in-required')
      }
    })
    scope.on('deepseek-account/signed-out', () => {
      for (const agent of scope.agents.list()) {
        if (isRunningAccountTask(agent)) {
          agent.cancel({ kind: 'hook', reason: 'deepseek-account/signed-out' }, { keepInbox: true })
        }
      }
    })
  })
}
