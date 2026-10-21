/**
 * 针对模型请求、顶层工具派发与已完成的 agent 步骤的、语义化的持久性检查点。
 * @module @deepseek-ai/dsh-session-checkpoint-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** 由 Loader 诊断所用的 Cordis 插件名称。 */
export const name = 'session-checkpoint-policy'

/** 本策略所接合其请求、工具、会话与持久化边界的服务。 */
export const inject = ['llm', 'sessionPersistence', 'sessions', 'tools']

/**
 * 推迟下游模型流的构造，直到完整的、已记录的请求前缀变为持久。一次检查点
 * 拒绝会阻止适配器派发。
 *
 * @param ctx - 拥有会话存储的插件上下文。
 * @param session - 由模型请求命名的活跃会话。
 * @param next - 下游的 `llm/stream` 链。
 * @returns 一条在其请求首个分块之前先做检查点的流。
 */
function afterCheckpoint(
  ctx: Context,
  session: Session,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await ctx.sessions.flush(session)
    yield* next()
  })()
}

/** 为一次在工具派发之前被取消的调用，物化其规范结果。 */
function abortedBeforeDispatchResult(): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }
}

/**
 * 安装语义化检查点监听器。由循环构建的模型调用会在适配器派发之前、对其
 * 已记录的请求做检查点；顶层工具调用会在工具体之前、对其已记录的调用做
 * 检查点；下一个请求边界会对前一批响应/结果做检查点。嵌套的工具派发会
 * 复用那个持久的外层调用。
 *
 * 检查点失败在模型与工具副作用边界处是失败关闭的：下游适配器或工具体
 * 不会被调用。
 *
 * @param ctx - 拥有这些监听器的插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    return session === undefined ? next() : afterCheckpoint(ctx, session, next)
  })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    await ctx.sessions.flush(exec.agent.session)
    if (exec.signal.aborted) return abortedBeforeDispatchResult()
    return next()
  })

  // 在每次请求之前，把前一步所提交的一切都持久化；第一步的调用除了任何
  // 提示摄入之外，是有意的无操作。
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    await ctx.sessions.flush(agent.session)
    return next()
  })
}
