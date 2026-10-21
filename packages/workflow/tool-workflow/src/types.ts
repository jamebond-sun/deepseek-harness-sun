/**
 * 模型面向的 workflow 工具写入其调用方父 Session 的、浏览器安全的
 * 持久化 workflow 记录事件。
 *
 * @module @deepseek-ai/dsh-tool-workflow/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowAgentOutcome, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow/types'

/** 开启一条持久的顶层 workflow 运行记录。 */
export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
}

/** 在某个子 Session 发布后记录一个 workflow 成员。 */
export interface ToolWorkflowAgentStartData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
}

/** 结算一个先前已启动的 workflow 成员。 */
export interface ToolWorkflowAgentEndData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
}

/** 在 workflow 运行的实时资源全部静止后结算该运行。 */
export interface ToolWorkflowRunEndData {
  readonly runId: WorkflowRunId
  readonly stopReason: WorkflowStopReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 开启一条顶层 workflow 记录。
     * @param data - 稳定的运行标识与展示名称。
     */
    'tool-workflow/run-start': ToolWorkflowRunStartData
    /**
     * 记录一个已发布的 workflow 成员。
     * @param data - 运行标识、成员序号、展示标识，以及子 Session。
     */
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    /**
     * 记录一次成员结算。
     * @param data - 运行标识、配对的成员序号，以及结果。
     */
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    /**
     * 在清理后关闭一条 workflow 记录。
     * @param data - 稳定的运行标识与终止原因。
     */
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
