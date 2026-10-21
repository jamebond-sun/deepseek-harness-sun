/** 共享的顶层调用后置策略选择，用于搜索结果的转储。 @module dsh-tool-fs-search/direct-call */

import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * 仅当该工具仍然持有一次直接的、成功的顶层调用，且没有下游策略替换掉任一投影时，
 * 才返回被接受的规范值。
 * @param ctx - 用于解析当前作用域持有者的工具插件上下文。
 * @param tool - 其值可能被投影的确切已注册定义。
 * @param exec - 已完成的执行标识。
 * @param result - 应用后置策略决策之前的规范结果。
 * @param decision - 组合后的下游后置策略决策。
 * @returns 待投影的规范值；转储必须延后时为 `undefined`。
 */
export function acceptedDirectCallValue(
  ctx: Context,
  tool: ToolDefinition,
  exec: ToolExecution,
  result: ToolExecutionResult,
  decision: PostToolDecision,
): JsonValue | undefined {
  if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')
    || exec.parent !== undefined || exec.name !== tool.name || result.isError
    || ctx.tools.get(exec.name, exec.agent) !== tool) return undefined
  return result.value
}
