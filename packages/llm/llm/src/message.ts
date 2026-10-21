/** 消息值类型、身份，以及不可变的构造辅助函数。 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { MessageId, ToolCallId } from './brand.ts'
import type { ContentBlock } from './types.ts'

/** 一条助手消息的提供方/模型身份，以及适配器私有的回放数据。 */
export interface AssistantProviderMetadata {
  /** 产出该消息的提供方路由。 */
  provider: string
  /** 产出该消息的提供方模型 id。 */
  model: string
  /**
   * 回放提供方响应所需的无损 JSON 适配器状态。
   * 只有当目标适配器实例当前同时持有这个历史提供方与目标提供方时，
   * `LlmRuntime` 才会把它暴露给该适配器。
   */
  replayState?: unknown
}

/** 一条由被路由模型产出的助手消息所必需的来源。 */
export interface ModelMessageSource extends AssistantProviderMetadata {
  kind: 'model'
}

/** 一条携带某个工具结果的 tool 角色消息所必需的来源。 */
export interface ToolMessageSource {
  kind: 'tool'
  callId: ToolCallId
}

/** 一条由系统提示插件产出的 system 角色消息所必需的来源。 */
export interface SystemPromptMessageSource {
  kind: 'system-prompt'
}

/**
 * 由生产者提供的上下文所含信息的种类，由生产者在同一个
 * `MessageSource` 中声明。
 *
 * `MessageSource.kind` 回答*这是谁产生的*；`form` 回答*它是哪一种东西*，
 * 这两个维度刻意相互独立——若干生产者共享同一个 form，
 * 而一个生产者在一次会话中可能发出多于一种 form。
 *
 * 这套词汇是语义性的，绝不是视觉性的：某个值说明内容是某个文件的
 * 指令、或是一份可选项的目录，而由消费者决定它长什么样。
 * 颜色、图标、排序与折叠默认值是消费者的事，绝不能进入这个联合类型。
 * 它随着生产者获得其 form 所需的结构化字段而一次增加一个值；
 * 缺失或未知的值是文档化的默认，按不透明内容呈现。
 */
export type ContextForm =
  /** 从模型应当遵循的工作区文件中读出的指令。 */
  | 'instructions'
  /** 本次会话中可选项的目录，随其变化而重新发布。 */
  | 'catalog'
  /** 当前状态；同一生产者较晚的快照会取代较早的一个。 */
  | 'snapshot'
  /** 对刚刚发生的事情的一次性记述；它不取代任何东西。 */
  | 'notice'
  /** 另一个 agent 发给本 agent 的消息。 */
  | 'relay'
  /** 从另一个会话的日志中取出的材料，可能在进入时被压缩过。 */
  | 'recall'

/** 对 `snapshot` 形态上下文的一项具名贡献，按装配顺序排列。 */
export interface ContextSnapshotSection {
  /** 贡献该内容的子系统名称。 */
  readonly name: string
  /** 该贡献面向模型的文本，与装配出来的完全一致。 */
  readonly text: string
}

/**
 * 由生产者声明的 {@link ContextForm}，以及该 form 所需的字段，
 * 混入到携带它的那些来源类型中。
 *
 * 以 `form` 作为判别式，因此生产者无法在不提供呈现所需字段的
 * 前提下选择某个 form：一条 `notice` 必须记录它的一行记述，
 * 一个 `snapshot` 必须记录它的各个小节。省略 `form` 仍然合法——
 * 未声明的上下文就是文档化的默认。
 */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | {
    readonly form: 'snapshot'
    /** 本快照按顺序装配出来的各个具名贡献。 */
    readonly sections: readonly ContextSnapshotSection[]
  }
  | {
    readonly form: 'notice'
    /** 对所发生事情的一行记述，无需展开该行即可显示。 */
    readonly summary: string
  }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

/**
 * 一条消息（或被注入的内容）来自何处，用 harness 自己的词汇表达。
 * 可合并扩展的和类型——每个生产者在自己的模块中声明自己的
 * `kind`；不存在共享的兜底 `plugin` 种类。模型与工具来源对应
 * 各自角色的消息；用户消息携带任意生产者的 kind，
 * 而消费者对未知的 kind 直接放过。
 */
export interface MessageSourceMap {
  user: { kind: 'user' }
  model: ModelMessageSource
  tool: ToolMessageSource
  'system-prompt': SystemPromptMessageSource
}

/**
 * 一条 `notice` 摘要的上界。生产者把这一行记述提交到持久化日志；
 * 它的输入——任务标签、目标描述、工具参数——都是调用方的文本，
 * 本身没有长度限制。
 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * 把一条 `notice` 摘要限制到 {@link CONTEXT_SUMMARY_MAX_CHARS}。
 * @param summary - 生产者的一行记述，任意长度。
 * @returns 该记述；超出上界时以省略号截断。
 */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** 任意已知的消息来源，由 {@link MessageSourceMap} 派生；按 `kind` 分支，并对未知值放过（可合并扩展）。 */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** 每条对话消息共享的不可变字段。 */
interface MessageBase {
  /** 跨每个表示边界都得以保留的稳定标识。 */
  readonly id: MessageId
  /** 精确的、面向模型的块。 */
  readonly content: readonly ContentBlock[]
  /** 由生产者提供的必需来源字段。
   * @persistenceSource user developer
   */
  readonly source: MessageSource
}

/** 一条归属于系统提示生产者的、已渲染的系统提示；空内容表示不发送任何提示。 */
export interface SystemMessage extends MessageBase {
  readonly role: 'system'
  readonly source: MessageSourceMap['system-prompt']
}

/** 按对话顺序排列的、增量的 agent 会话变更，目前是工具的添加与移除。 */
export interface DeveloperMessage extends MessageBase {
  readonly role: 'developer'
}

/** 共享消息表示的一个 user 角色特化。 */
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}

/** 共享消息表示的一个由模型产出的 assistant 特化。 */
export interface AssistantMessage extends MessageBase {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** 一条携带单次工具调用结果的一等 tool 角色消息。 */
export interface ToolResultMessage extends MessageBase {
  readonly role: 'tool'
  readonly source: ToolMessageSource
  /** 本消息所回答的那次工具调用的、由提供方签发的 id。 */
  readonly toolCallId: ToolCallId
  /** 该工具调用是否失败。 */
  readonly isError?: boolean
}

/**
 * 由 Session 持久化的对话消息，按角色作为键。这个映射是封闭的，
 * 因为每个模型可见的角色都必须有一个持久化的 Session 事件
 * 与一个适配器投影。
 */
export interface MessageRoleMap {
  system: SystemMessage
  developer: DeveloperMessage
  user: UserMessage
  assistant: AssistantMessage
  tool: ToolResultMessage
}

/** 任意一条已持久化的对话消息，按其 `role` 判别。 */
export type Message = MessageRoleMap[keyof MessageRoleMap]

type NewMessage = {
  [Role in keyof MessageRoleMap]: Omit<MessageRoleMap[Role], 'id'>
}[keyof MessageRoleMap]
type NewDeveloperMessage = Omit<DeveloperMessage, 'id' | 'role'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

/**
 * 分离并深度冻结一条身份已存在的消息。
 * @param message - 完整的消息，包含其稳定身份。
 * @returns 保留该身份的不可变快照。
 */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * 创建一条带身份的消息，并在发布之前冻结它。
 * @param input - 一条新消息的完整角色、内容与来源。
 * @returns 一条带有全新稳定身份的不可变消息。
 */
export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return deepFreeze(structuredClone({
    ...input,
    id: brandString<MessageId>(randomUUID()),
  }))
}

/**
 * 创建一条带身份、不可变的 developer 消息。
 * @param input - 该新消息的内容与生产者来源。
 * @returns 一条带有全新身份的、已分离的 developer 消息。
 */
export function createDeveloperMessage<T extends NewDeveloperMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<DeveloperMessage, 'id' | 'role'> {
  return createMessage({ ...input, role: 'developer' })
}

/**
 * 创建一条带身份的 user 角色消息，并在发布之前冻结它。
 * @param input - 一条新用户消息的完整内容与来源。
 * @returns 一条带有全新稳定身份的不可变用户消息。
 */
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

/**
 * 创建一条带身份、由模型产出的助手消息，并在发布之前冻结它。
 * @param input - 一条新助手消息的完整内容，以及提供方、模型与可选的回放状态。
 * @returns 一条带有固定角色/来源标签与全新稳定身份的不可变助手消息。
 */
export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      ...input.source,
    },
  })
}

/**
 * 创建并冻结一条带身份的、持有已渲染系统提示的 system 角色消息。
 * @param text - 完整渲染出来的提示；`''` 表示“没有系统提示”。
 * @returns 一条带有全新稳定身份的不可变系统消息。
 */
export function createSystemMessage(text: string): SystemMessage {
  return createMessage({
    role: 'system',
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  })
}

/** 其被接受即创建一条工具结果消息的输入。 */
export interface ToolResultMessageInput {
  readonly callId: ToolCallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

/**
 * 创建并冻结一条带身份的工具结果消息。
 * @param input - 调用身份、原始结果块与结果。
 * @returns 一条回答该工具调用的、不可变的 tool 角色消息。
 */
export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createMessage({
    role: 'tool',
    source: { kind: 'tool', callId: input.callId },
    toolCallId: input.callId,
    content: input.content,
    isError: input.isError,
  })
}
