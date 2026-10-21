/**
 * 面向进程内子代理的、子作用域结构化输出工具、prompt 指令、终止守卫与
 * 权威结果捕获。每个子代理在自己的作用域上注册其真实模式，因此并发运行
 * 互不干扰，且处置后不留全局残留。prompt 贡献是普通的、可重建的请求状态。
 *
 * 捕获仅在权威的 `tools/result` 成功之后提交；PTC 模式捕获还要等待外层
 * `run_code` 结果。终止结果标记与单调工具守卫可防止后续调用重新打开一个
 * 已完成的结构化运行。
 * @module @deepseek-ai/dsh-subagent/structured
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** 结构化子代理为完成所必须调用的、面向模型的工具名。 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/**
 * 注册为子代理尾部作用域 prompt 区段的指令：该要求随工具一起传递，
 * 作为恰好一个 agent 的普通 prompt 状态。
 */
export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

/** 一次结构化运行的实时句柄：在子代理结算后读取被捕获的值。 */
export interface StructuredAttachment {
  /**
   * 从捕获暂存到其最终结果（包括外层 PTC 执行）期间，输入保持关闭。
   * 失败的结果会丢弃其捕获并重新打开输入。
   * @returns 该激活能否接受另一条消息。
   */
  acceptsInput(): boolean
  /**
   * 一旦子代理以合法参数调用了该工具、且权威的最终工具结果接受了该调用，
   * 即为被捕获的值。
   * @returns 已提交的值，未接受任何值时为 undefined。
   */
  captured(): { value: unknown } | undefined
}

/**
 * 在创建窗口期间把作用域化的捕获工具、指令与强制措施附加到子代理上。
 * 子代理处置会移除所有注册项。
 * @param childCtx - 子代理的作用域上下文（`setup` 的实参）。
 * @param schema - 要强制的、已受信任且已断言的模式子集（见 dsh-tools 中的
 *   `assertObjectJsonSchema`）。
 * @param canComplete - 已接受的输入与所属子代理工作是否已完成。
 * @returns 附加句柄（在子代理结算后读取 `captured()`）。
 */
export function attachStructuredRuntime(
  childCtx: Context,
  schema: ObjectJsonSchema,
  canComplete: () => boolean,
): StructuredAttachment {
  /**
   * 由捕获工具体暂存的、已校验的值，等待它们各自的权威 `tools/result`
   * 通知。执行对象的身份唯一地标识一次穿越管线的行程：适配器调用 id 可能
   * 跨步骤重复，但另一次执行永远无法到达这个 Map 条目。这区别于用于关联
   * 嵌套传输的不透明 `ToolExecutionToken`。最终通知总是删除自己的暂存，
   * 无论结果成功还是失败。
   */
  const staged = new Map<ToolExecution, { value: unknown }>()
  /** 等待其外层传输提交的、成功的嵌套捕获。 */
  let pending: { parent: ToolExecution['token']; value: unknown } | undefined
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    parameters: { ...schema },
  }

  childCtx.tools.register({
    ...schemaEntry,
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Structured output recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args)
      // ToolArgsError → 带 INVALID_ARGS 的 isError 结果：模型在同一轮次内重试，
      // 与经过模式校验的 defineTool 调用完全一致。
      if (violations.length > 0) throw new ToolArgsError(violations)
      if (!canComplete()) throw new Error('Wait for all delegated child tasks to finish and process pending messages before submitting structured output.')
      // 以本次执行为键的两阶段提交：之后可转换的 waterfall 仍可能把成功变成错误。
      // ToolRuntime 已在真实输入边界处冻结了模型绑定的实参。
      staged.set(exec, { value: args })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: childCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // 在步骤内终止。守卫在整个 pre-execute waterfall 之后运行，且单调组合
  // （拒绝或弃权，从不允许），因此后加入的前置监听器无法复活分派。
  // 同一响应中位于捕获之前的调用不受影响。
  childCtx.tools.guard(exec => captured === undefined && pending === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  // 捕获提交在完整管线与外部错误规范化之后观测不可变、权威的结果。
  // 该通知无法转换结果，因此提交裁定之外没有包装层。
  childCtx.on('tools/result', function (this: unknown, exec, result) {
    if (exec.name === STRUCTURED_OUTPUT_TOOL) {
      const entry = staged.get(exec)
      if (entry === undefined) return
      staged.delete(exec)
      if (result.isError) return
      if (exec.parent === undefined) {
        /* v8 ignore else -- 顺序的 agent-loop 分派让守卫阻断每一个后续受支持调用 */
        if (captured === undefined) captured = { value: entry.value }
      } else {
        /* v8 ignore else -- PTC 模式串行化子分派，因此守卫阻断每一个后续受支持调用 */
        if (captured === undefined && pending === undefined) {
          pending = { parent: exec.parent, value: entry.value }
        }
      }
      return
    }
    if (pending?.parent !== exec.token) return
    const entry = pending
    pending = undefined
    if (result.isError) return
    /* v8 ignore else -- PTC 模式串行化外层执行，因此守卫阻断每一个后续受支持调用 */
    if (captured === undefined) captured = { value: entry.value }
  })

  return {
    captured: () => captured,
    acceptsInput: () => staged.size === 0 && pending === undefined && captured === undefined,
  }
}
