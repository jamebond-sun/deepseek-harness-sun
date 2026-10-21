/**
 * 持久化的 pi-ai 回放元数据，以及助手历史的重建。
 *
 * Harness 的内容仍然是文本与工具调用的持久化来源。本模块只存储
 * 在之后某次请求上重建一条 pi-ai 助手消息所需的、提供方原生的元数据。
 *
 * @module dsh-llm-pi-ai/replay
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage as HarnessAssistantMessage, ModelMessageSource, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, ToolCall, Usage as PiUsage } from '@earendil-works/pi-ai'

/** pi-ai 回放信封中按块的那一半，每个内容块一个条目。 */
export type PiAiReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string; namespace?: string }

/** pi-ai 回放信封中带版本号的、响应级的那一半。 */
export interface PiAiReplayResponse {
  kind: 'pi-ai'
  version: 2
  api: Api
  provider: string
  /** 被请求的模型身份，与持久化的助手来源一致。 */
  model: string
  /** 提供方所报告的模型；回放保留被请求的模型以匹配签名。 */
  responseModel?: string
  responseId?: string
  /** 供历史回放使用的、提供方原生的强度；缺失会被保留。 */
  providerThinkingLevel?: string
  stopReason: AssistantMessage['stopReason']
}

/** 一个 pi-ai 回放信封中已校验的两半。 */
interface PiAiReplayState {
  response: PiAiReplayResponse
  blocks: PiAiReplayBlock[]
}

/** 解析工具调用的 JSON 参数；把模型的格式错误当作 {} 容忍下来。 */
function parseArguments(raw: string): ToolCall['arguments'] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as ToolCall['arguments']
    }
  } catch {
    // 落到下面
  }
  return {}
}

/** 构造历史 pi-ai 消息所要求的那个零用量值。 */
function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * 把一次成功的 pi-ai 响应投影为最小的持久化回放状态。
 * 按块的那一半按索引与已流式输出的块对齐（pi-ai 的内容顺序），
 * 因此每当装配移除一个块时，`BlockAssembler` 就会连同它剪掉一个条目。
 * @param message - 已完成的、原生的 pi-ai 助手响应。
 * @param requestedModel - 存放在助手来源中的请求身份；默认取原生模型。
 * @returns 带版本号的、无损 JSON 的回放投影。
 */
export function toPiReplayState(message: AssistantMessage, requestedModel = message.model): ReplayEnvelope {
  const response: PiAiReplayResponse = {
    kind: 'pi-ai',
    version: 2,
    api: message.api,
    provider: message.provider,
    model: requestedModel,
    ...message.responseModel === undefined ? {} : { responseModel: message.responseModel },
    ...message.responseId === undefined ? {} : { responseId: message.responseId },
    ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
    stopReason: message.stopReason,
  }
  return {
    response,
    blocks: message.content.map((block): PiAiReplayBlock => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
          ...block.namespace === undefined ? {} : { namespace: block.namespace },
        }
      }
    }),
  }
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

/** 在持久化的、适配器私有的信封到达 pi-ai 之前校验它。 */
function readReplayState(value: unknown): PiAiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay('expected a replay envelope')
  const envelope = value as Record<string, unknown>
  const rawResponse = envelope['response']
  if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) return invalidReplay('expected a response object')
  const response = rawResponse as Record<string, unknown>
  if (response['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
  if (response['version'] !== 2) return invalidReplay(`unsupported version ${String(response['version'])}`)
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response['stopReason']))) {
    return invalidReplay('unknown stopReason')
  }
  if (response['responseModel'] !== undefined && typeof response['responseModel'] !== 'string') return invalidReplay('responseModel must be a string')
  if (response['responseId'] !== undefined && typeof response['responseId'] !== 'string') return invalidReplay('responseId must be a string')
  if (response['providerThinkingLevel'] !== undefined && typeof response['providerThinkingLevel'] !== 'string') return invalidReplay('providerThinkingLevel must be a string')
  const blocks = envelope['blocks']
  if (!Array.isArray(blocks)) return invalidReplay('blocks must be an array')
  for (const [index, value] of blocks.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call'].includes(String(block['type']))) return invalidReplay(`block ${index} has an unknown type`)
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature', 'namespace'] as const) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') return invalidReplay(`block ${index} ${signature} must be a string`)
    }
    if (block['redacted'] !== undefined && typeof block['redacted'] !== 'boolean') return invalidReplay(`block ${index} redacted must be boolean`)
  }
  return {
    response: response as unknown as PiAiReplayResponse,
    blocks: blocks as PiAiReplayBlock[],
  }
}

/** 转换与提供方无关的块，且不把它们当作同模型回放来信任。 */
function foreignAssistant(message: HarnessAssistantMessage): AssistantMessage {
  const source = message.source
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      }); break
      case 'image':
        throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
      default:
        // 插件新增的块类型在 pi-ai 中无法表示。
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // 刻意永不等于任何目录 API：缺失回放状态即为外来，
    // 即使来源指名了与本次请求相同的提供方/模型。
    api: 'dsh-foreign',
    provider: source.provider,
    model: source.model,
    usage: emptyPiUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** 把持久化的 Harness 内容与已校验的 pi-ai 回放元数据重新组合起来。 */
function replayedAssistant(message: HarnessAssistantMessage, source: ModelMessageSource, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.response.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.response.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
    switch (block.type) {
      case 'text': return {
        type: 'text',
        text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...replay.type === 'tool-call' && replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {},
        ...replay.type === 'tool-call' && replay.namespace !== undefined ? { namespace: replay.namespace } : {},
      }
      /* v8 ignore next -- readReplayState 会拒绝未知的回放标签，因此一个相等的、由插件新增的 Harness 标签无法到达这个 switch */
      default: return invalidReplay(`block ${index} has an unsupported Harness type`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    ...state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel },
    ...state.response.responseId === undefined ? {} : { responseId: state.response.responseId },
    ...state.response.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}

/**
 * 把一条持久化的 Harness 助手消息转换为 pi-ai 历史。
 *
 * 持久化的内容是权威的记录；回放元数据只用于恢复原生的保真度
 * （id、签名）。因此一个本构建无法使用的回放状态——另一个适配器的种类、
 * 另一个版本、一个格式错误的值，或不再与内容匹配的元数据——会让那一条
 * 消息降级为与提供方无关的历史，而不是让这次请求失败。
 * @param message - 由模型产出的助手内容，带有提供方、模型，以及可选的由适配器持有的回放元数据。
 * @param onDegrade - 当一个不可用的回放状态回退为与提供方无关的转换时，
 *   以该诊断原因被调用。
 * @returns 由持久化内容重建出来的、原生的 pi-ai 助手消息。
 */
export function toPiAssistant(message: HarnessAssistantMessage, onDegrade?: (reason: string) => void): AssistantMessage {
  const source = message.source
  if (source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch (error: unknown) {
    /* v8 ignore next -- replayedAssistant 只抛出 INVALID_REPLAY_STATE 的 LlmError；
       这个守卫让未来一次非回放的失败保持响亮，而不是被静默地降级 */
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}
