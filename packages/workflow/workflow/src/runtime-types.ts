/**
 * 仅宿主侧使用的 workflow 请求与活跃运行句柄。浏览器安全的持久化词汇
 * 仍留在 `./types` 中，以便 Client 程序绝不会导入 Agent，或宿主的 Cordis
 * 上下文声明。
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  WorkflowMeta, WorkflowResult, WorkflowRunId,
} from './types.ts'

/**
 * 调用方在启动一次 workflow 运行时所请求的内容。`meta` 与 `args` 按 seam
 * 契约为纯 JSON 数据。`parent` 是必需的，因为脚本所生成的每一个 `agent()`
 * 都归属于那个活跃的 Agent。
 */
export interface WorkflowStartRequest {
  /** 纯 JS 脚本正文（允许顶层 await；以 `return <json-value>` 结尾）。 */
  script: string
  /** workflow 的身份块，作为纯 JSON 数据（由引擎进行形状校验）。 */
  meta: WorkflowMeta
  /** 原样暴露给脚本、作为 `args` 全局的可选输入。 */
  args?: unknown
  /** 可选的、针对该运行的引擎级子项 provider 覆盖。 */
  subagentProvider?: string
  /** 可选的、逐运行的总子项上限。 */
  maxTotalAgents?: number
  /** 代表运行执行（每个子项的父级）的代理。 */
  parent: Agent
  /** 中止时取消该运行。 */
  signal?: AbortSignal
}

/**
 * 属主拥有的活跃 workflow。`result` 永不 reject；消费者可以取消，且
 * 必须调用幂等的 `dispose()` 以等待脚本与子项静止。
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId
  /** 在脚本正文运行前即可用的已校验 meta 块。 */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** 取消该运行及其子项。 */
  cancel(reason?: string): void
  /** 必要时取消，并等待脚本与子项清理完成。 */
  dispose(): Promise<void>
}
