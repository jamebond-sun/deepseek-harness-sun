/** 由已提交的 DSH 会话事件派生的标准 ACP 更新。 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'

/**
 * 按内容块顺序转换一条已提交的 assistant 消息及其上下文用量。
 * @param ctx - 携带附件服务与 token 计量服务的 bridge 上下文。
 * @param session - 用于判断上下文压力的持久会话。
 * @param event - 已提交的 assistant 消息事件。
 * @returns 有序的标准 thought、消息以及可选的用量更新。
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * 依据持久化的调用事实启动一次通用 ACP 工具生命周期。
 * @param event - 已提交的 DSH 工具调用事件。
 * @returns 标准的通用工具调用更新。
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * 依据已提交的、面向模型的结果结束一次通用 ACP 工具生命周期。
 * @param ctx - 携带附件存储的 bridge 上下文。
 * @param event - 已提交的 DSH 工具结果事件。
 * @returns 标准的已完成或失败工具调用更新。
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/** 仅在 DSH 同时具备用量与容量事实时报告当前上下文占用。 */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** 将格式错误的模型输出保留为不透明输入，而不是丢弃该调用更新。 */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
