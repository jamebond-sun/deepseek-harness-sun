/** 最小化的原生 thinking 元数据；持久化的 Harness 块持有全部响应文本。 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'

/** 与每个已发出的 Harness 块一起保留的、按索引对齐的元数据。 */
export interface ReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  signature?: string
}

/** 在读取提供方数据与持久化数据时拒绝格式错误的 JSON 对象。
 * @param value - 不可信的已解码 JSON。
 * @param code - 所属的失败类别。
 * @returns 已校验的对象。
 */
export function object(value: unknown, code = 'MALFORMED_RESPONSE'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmError('DeepSeek Messages expected a JSON object', code)
  }
  return value as Record<string, unknown>
}

/** 构造响应元数据，且不重复助手文本。
 * @param model - 被请求的模型身份。
 * @param blocks - 按已发出块顺序排列的元数据。
 * @returns 由现有组装器持久化的、带版本号的信封。
 */
export function replayState(model: string, blocks: ReplayBlock[]): ReplayEnvelope {
  return { response: { kind: 'deepseek-messages', version: 1, model }, blocks }
}

/** 校验原生回放，在序列化持久化内容之前丢弃不可用的元数据。
 * @param message - 持久化的助手内容与来源元数据。
 * @param model - 目标模型；跨模型的签名不可移植。
 * @param onDegrade - 针对不可用元数据的诊断；不会收到消息内容或签名。
 * @returns 按索引对齐的元数据；对于外来的、跨模型的或已降级的历史则为缺失。
 */
export function readReplay(message: Message, model: string, onDegrade?: (reason: string) => void): ReplayBlock[] | undefined {
  try { return validateReplay(message, model) } catch (error) {
    /* v8 ignore next -- 校验器只会抛出 INVALID_REPLAY_STATE；保留未来的非回放失败。 */
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return undefined
  }
}

function validateReplay(message: Message, model: string): ReplayBlock[] | undefined {
  if (message.source.kind !== 'model' || message.source.replayState === undefined) return undefined
  const fail = (detail: string): never => { throw new LlmError(`DeepSeek Messages replay: ${detail}`, 'INVALID_REPLAY_STATE') }
  const envelope = object(message.source.replayState, 'INVALID_REPLAY_STATE')
  const response = object(envelope.response, 'INVALID_REPLAY_STATE')
  if (response.kind !== 'deepseek-messages' || response.version !== 1) return fail('unsupported kind or version')
  if (response.model !== message.source.model) return fail('model does not match assistant source model')
  if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return fail('block count mismatch')
  const blocks = envelope.blocks.map((value, index): ReplayBlock => {
    const block = object(value, 'INVALID_REPLAY_STATE')
    if (block.type !== message.content[index]?.type
      || (block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'tool-call')) return fail('block type mismatch')
    if (block.signature !== undefined && (block.type !== 'reasoning' || typeof block.signature !== 'string')) return fail('invalid signature')
    return { type: block.type, ...typeof block.signature === 'string' ? { signature: block.signature } : {} }
  })
  return response.model === model ? blocks : undefined
}
