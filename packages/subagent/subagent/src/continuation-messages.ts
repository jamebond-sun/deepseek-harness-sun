/**
 * 由可续跑子代理编排所拥有的、模型可见的消息。
 *
 * @module @deepseek-ai/dsh-subagent/continuation-messages
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from './types.ts'

/** Agent 之间一条模型撰写消息的持久化归属。 */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** 另一个 agent 发给本 agent 的消息（`relay` 上下文形态）。 */
  readonly form: 'relay'
  /** 其工具调用产生该消息的 Agent 的 session id。 */
  readonly senderSessionId: SessionId
}

/**
 * 运行时对可续跑子代理结算自身陈述的持久化归属。有意与
 * {@link AgentMessageSource} 使用不同的 kind：Agent 消息是发送方选定的内容，
 * 而本消息是管理器陈述子代理的最终结局；若把二者合并进同一份 transcript，
 * 会把子代理从未写下的话归到它头上。
 */
export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** 不展开该行即可展示的运行时陈述（`notice` 上下文形态）。 */
  readonly form: 'notice'
  /** 关于子代理如何结束的一行陈述。 */
  readonly summary: string
  /** 已结算子代理的 session id。 */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

/** 为一条相邻 Agent 消息构建持久化归属。 */
function agentMessageSource(sender: Agent): AgentMessageSource {
  return {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: sender.id,
  }
}

/**
 * 构建一条相邻 Agent 消息的模型可见且可持久化的表示。
 * @param sender - 撰写该消息的精确实时 Agent。
 * @param content - 发送方提供的、模型可见的消息块。
 * @returns 投递给接收方的持久化 user-message 表示。
 */
export function createAgentMessage(
  sender: Agent,
  content: ContentBlock[],
): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text' as const, text: `Agent ${sender.id} sent a message: ` },
      ...content,
    ],
    source: agentMessageSource(sender),
  })
}

/**
 * 向可续跑子代理的初始任务追加相邻 Agent 的返回指引。
 * @param parentId - 指引中所指名的持久化父 session id。
 * @param prompt - 初始的、模型可见的任务块。
 * @returns 任务块之后跟随可续跑返回指引。
 */
export function withContinuableReturnGuidance(
  parentId: SessionId,
  prompt: ContentBlock[],
): ContentBlock[] {
  const encodedParentId = JSON.stringify(parentId)
  return [
    ...prompt,
    {
      type: 'text',
      text: `Your parent agent id is ${encodedParentId}. Before you finish, send your result to that agent with `
        + `send_message({ agent_id: ${encodedParentId}, message: "<self-contained result>" }). The parent shares `
        + 'your workspace but does not automatically receive your transcript, tool output, or reasoning. Send '
        + 'earlier messages as well when a finding changes what the parent should do next; sending a message '
        + 'does not end your turn.',
    },
  ]
}

/**
 * 用父代理自身的任务词汇，以一行告知父代理某个后台子代理已结束及其原因。
 * @param childId - 父代理按 id 认识的持久化子代理。
 * @param stopReason - 子代理最后一个普通轮次如何结束。
 * @param continuable - 子代理是否接受后续消息。
 * @returns 结算通知面向模型的开头一行。
 */
function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason'], continuable: boolean): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return continuable
        ? `${subject} finished and will do no further work unless you send it more.`
        : `${subject} finished. It cannot receive follow-up messages.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    // 步骤前拒绝 —— hook deny、策略插件 —— 丢弃了子代理已认领的输入，
    // 因此父代理不得把任务视为已完成。
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` 是可合并扩展的，因此该分支
     * 需要一个添加变体的后端；无法名状的结束被报告为未完成，而非静默地当作成功。 */
    default:
      return `${subject} ended abnormally (${String(stopReason)}) before it finished.`
  }
}

/**
 * 根据子代理非空的收尾文本构建运行时自有的结算通知。
 * @param childId - 通知中所指名的持久化子 session id。
 * @param terminal - 已结算 Activation 所记录的终止状态。
 * @param continuable - 子代理能否接受另一个任务。
 * @returns 投递给父代理的持久化 user-message 表示。
 */
export function createSettlementMessage(
  childId: SessionId,
  terminal: SubagentResult,
  continuable = true,
): ReturnType<typeof createUserMessage> {
  const summary = settlementSummary(childId, terminal.stopReason, continuable)
  // 父提供方以 user message 形式接收该通知，可能拒绝非文本助手块。
  // 将此转换保持在本地，使 SDK/UI 消费者保留完整的子代理输出。
  const closingText = terminal.output.flatMap(block =>
    block.type === 'text' && block.text.length > 0 ? [block] : [],
  )
  return createUserMessage({
    content: [
      { type: 'text' as const, text: summary },
      ...closingText.length === 0
        ? [{ type: 'text' as const, text: 'It left no closing message.' }]
        : [{ type: 'text' as const, text: 'Its closing message:' }, ...closingText],
      ...terminal.structured !== undefined
        ? [{ type: 'text' as const, text: `Structured result: ${JSON.stringify(terminal.structured)}` }] : [],
      ...terminal.diagnostic !== undefined
        ? [{ type: 'text' as const, text: terminal.diagnostic }] : [],
    ],
    source: {
      kind: 'subagent-settled' as const,
      form: 'notice' as const,
      summary: boundContextSummary(summary),
      senderSessionId: childId,
    },
  })
}
