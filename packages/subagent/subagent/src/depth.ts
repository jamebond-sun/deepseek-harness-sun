/**
 * 委托深度记账：父代理传给其子代理的递归预算。与 service 分开保存，
 * 以便组合辅助函数无需导入注册表即可读取它。
 *
 * @module @deepseek-ai/dsh-subagent/depth
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** 委托深度：顶层 agent 为零，子代理为父深度 + 1。 */
    subagentDepth?: number
  }
}

/**
 * 读取一个 agent 的委托深度，缺失时按顶层深度零处理。持久化的 session
 * header 是权威且单调的：运行时 `AgentOptions.subagentDepth` 可以加深计数
 * 但永远不能降低它 —— 恢复后的子代理带着全新选项到达，若从零计数就会
 * 让它像顶层一样委托。
 * @param agent - 其 header 与选项承载该深度的 agent。
 * @returns 其非负安全整数深度。
 * @throws 若运行时 `AgentOptions.subagentDepth` 不是非负安全整数。
 */
export function delegationDepthOf(agent: Agent): number {
  const runtime = agent.options.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  // header 值在 session 边界处已被校验（创建与持久化加载都经 store 构造）。
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
}

/**
 * 拒收无法表示精确委托深度的递归上限。
 * @param maxDepth - 待校验的可选运行时值。
 */
export function assertSubagentMaxDepth(maxDepth: unknown): void {
  if (maxDepth !== undefined && (
    typeof maxDepth !== 'number'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || Object.is(maxDepth, -0)
  )) {
    throw new TypeError('subagent maxDepth must be a non-negative safe integer')
  }
}
