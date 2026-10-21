/**
 * 位于公开 Service Definition 与面向模型的 Agent 消息契约之外的续跑集成
 * 标记与宿主机适配器。
 * @module @deepseek-ai/dsh-subagent/internal
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type SubagentRuntime from './index.ts'
import type { SubagentDelivery } from './control-types.ts'

/** 仅由标准的相邻 Agent 消息工具承载的、进程稳定的身份。 */
export const adjacentAgentSendMessageTool = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')

/**
 * 标记标准的相邻 Agent 消息工具，而不改变其模型可见的模式。
 * @param definition - 标准的 `send_message` 定义。
 * @returns 装好内部身份的同一份定义。
 */
export function markAdjacentAgentSendMessageTool(definition: ToolDefinition): ToolDefinition {
  Object.defineProperty(definition, adjacentAgentSendMessageTool, { value: true })
  return definition
}

/**
 * 检测某个可见定义是否为标准的相邻 Agent 消息工具。
 * @param definition - 作用域解析出的 `send_message` 候选者。
 * @returns 该定义是否带有内部的标准工具身份。
 */
export function isAdjacentAgentSendMessageTool(definition: ToolDefinition | undefined): boolean {
  return definition !== undefined
    && (definition as ToolDefinition & { [adjacentAgentSendMessageTool]?: true })[adjacentAgentSendMessageTool] === true
}

/**
 * 由打包运行时入口与本未打包内部子路径共享的、进程稳定的 symbol 键宿主投递。
 * @internal
 */
export const deliverSubagentPrompt = Symbol.for('dsh.subagent.deliverPrompt')

/** 仅宿主可用的 prompt 适配器所要求的运行时外观。 */
export interface HostPromptDeliverer {
  [deliverSubagentPrompt](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    delivery: SubagentDelivery,
  ): Promise<MessageId>
}

/**
 * 排队一条宿主协议消息，而不暴露另一个 Service 操作。
 * @param runtime - 拥有续跑驻留的子代理运行时。
 * @param parent - 授权该投递的精确实时直接父代理。
 * @param childId - 持久化的直接子 session id。
 * @param content - 待投递的宿主撰写内容。
 * @param source - 持久化宿主协议来源描述符。
 * @param signal - 在收件箱接受之前的调用方取消。
 * @returns 被接受消息的收件箱 id。
 */
export function queueHostSubagentPrompt(
  runtime: SubagentRuntime,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  return (runtime as unknown as HostPromptDeliverer)[deliverSubagentPrompt](
    parent,
    childId,
    content,
    source,
    signal,
    'queue',
  )
}

/**
 * 转向一条宿主协议消息，而不暴露另一个 Service 操作。
 * @param runtime - 拥有续跑驻留的子代理运行时。
 * @param parent - 授权该投递的精确实时直接父代理。
 * @param childId - 持久化的直接子 session id。
 * @param content - 待投递的宿主撰写内容。
 * @param source - 持久化宿主协议来源描述符。
 * @param signal - 在收件箱接受之前的调用方取消。
 * @returns 被接受消息的收件箱 id。
 */
export function steerHostSubagentPrompt(
  runtime: SubagentRuntime,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  return (runtime as unknown as HostPromptDeliverer)[deliverSubagentPrompt](
    parent,
    childId,
    content,
    source,
    signal,
    'steer',
  )
}
