/**
 * dsh-llm 自己持有的带品牌 id：工具调用关联与提供方请求诊断。
 *
 * `Branded<B>` 原语与无状态构造器位于 `@deepseek-ai/dsh-brand`，
 * 因此每个跨边界 id 的持有者都能在不依赖 dsh-llm 的前提下给它打上品牌标记；
 * 名义类型策略见该包的 README。
 *
 * @module @deepseek-ai/dsh-llm/brand
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** 一条消息跨收件箱、日志与模型请求边界所携带的稳定标识。 */
export type MessageId = Branded<'MessageId'>

/**
 * 为一条消息标识打上品牌标记。
 * @param id - 不透明的消息标识。
 * @returns 同一个字符串，带 message-id 品牌。
 */
export function MessageId(id: string): MessageId {
  return brandString<MessageId>(id)
}

/**
 * 把一个由模型发起的工具调用与其结果关联起来。对于真实适配器由提供方签发；
 * 对于 mock/组装器兜底则是合成的。
 */
export type ToolCallId = Branded<'ToolCallId'>

/**
 * 把一个字符串打上 {@link ToolCallId} 的品牌标记。
 * @param id - 由提供方签发或合成的调用 id。
 * @returns 同一个字符串，带 tool-call-id 品牌。
 */
export function ToolCallId(id: string): ToolCallId {
  return brandString<ToolCallId>(id)
}

/** 跨包边界保留下来用于诊断的、由提供方签发的请求标识。 */
export type ProviderRequestId = Branded<'ProviderRequestId'>

/**
 * 为一个由提供方签发的请求标识打上品牌标记。
 * @param id - 不透明的、由提供方签发的字符串。
 * @returns 同一个字符串，仅打上品牌标记；不执行任何校验。
 */
export function ProviderRequestId(id: string): ProviderRequestId {
  return brandString<ProviderRequestId>(id)
}

/** 一次模型流式尝试的标识，在一个 Agent 生命周期内唯一。 */
export type LlmAttemptId = Branded<'LlmAttemptId'>

/**
 * 为一个由循环持有的流式尝试标识打上品牌标记。
 * @param id - 不透明的、Agent 生命周期局部的标识。
 * @returns 同一个字符串，带 attempt-id 品牌。
 */
export function LlmAttemptId(id: string): LlmAttemptId {
  return brandString<LlmAttemptId>(id)
}

/** 由适配器持有的、一个模型可选推理强度的标识。 */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>

/**
 * 为一个由适配器持有的推理强度标识打上品牌标记。
 * @param id - 由某个模型能力暴露出来的不透明标识。
 * @returns 同一个字符串，仅打上品牌标记；不执行任何校验。
 */
export function ReasoningEffortId(id: string): ReasoningEffortId {
  return brandString<ReasoningEffortId>(id)
}
