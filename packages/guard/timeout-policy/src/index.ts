/**
 * 协作式的工具调用超时执行器。工具声明 `timeoutMs` 并承诺遵守 `exec.signal`；
 * 本包装器负责启动该截止时间，并把自身到期映射为 `TOOL_TIMEOUT`，既不竞态
 * 也不抛弃工具的 promise。
 *
 * FIXME: 在首个打标签的发布之前，确定预期的 `@deepseek-ai/dsh-timeout-guard`
 * 改名 —— 仅为建议，让名字与其所在的 `guard/` 目录对齐；在解决时再决定
 * （[重新分组 Agent Note](../../../../.agents/notes/archived/architecture/2026-07-29-package-regrouping.md)）。
 *
 * @module @deepseek-ai/dsh-tool-call-timeout-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * 本插件拥有的 code，既用作内部 {@link deadline} 的分类 code，也用作替换后的
 * 工具结果上的结构化错误 `code`。把 {@link timeoutOf} 限定到它，可以避免嵌套的
 * 外层 deadline（另一个 `tools/execute` 包装器中先触发的定时器）被误读为本插件
 * 自身的超时 —— 那种情况会读作一次普通的上游取消。
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** 供加载器诊断信息使用的 Cordis 插件名。 */
export const name = 'timeout-policy'

/** 本插件包装（`tools/execute`）与读取（`get`）的工具注册表服务。 */
export const inject = ['tools']

/**
 * 当本插件的 deadline 胜出时替换上去的结构化结果。`content` 是面向模型的消息；
 * `error.code` 与本插件拥有的 {@link TOOL_TIMEOUT} 相同，因此重试/沙箱插件
 * （以及回放）可以据此路由。
 *
 * @param timeoutMs - 已耗尽的预算，会被渲染进面向模型的消息。
 * @returns 带 `TOOL_TIMEOUT` 错误的 `isError` {@link ToolExecutionResult}。
 */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * 注册超时包装器。它解析调用方可见的工具定义，临时替换 `exec.signal`，
 * 向下委派，恢复上游 signal，并且只在本包装器自身的定时器触发时替换结果。
 */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    // 未声明预算的工具：不设 deadline，原样向下委派。
    if (timeoutMs === undefined) return next()

    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    // 把派生的 deadline 换到 exec 上用于分发，随后恢复调用方自身的 signal，
    // 使 post-execute 监听器永远不会看到本插件的（可能已中止的）超时 signal。
    const upstream = exec.signal
    exec.signal = d.signal
    try {
      const result = await next()
      // 如果是我们的定时器触发（按 code 区分 —— 嵌套的外层 deadline 在这里
      // 读作 undefined），说明工具/能力已感知中止并达到静默状态；用它自己的
      // 中止结果替换为模型所见的结构化 TOOL_TIMEOUT。
      if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
        return toolTimeoutResult(timeoutMs)
      }
      return result
    } finally {
      exec.signal = upstream
    }
  })
}
