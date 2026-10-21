/**
 * 把 pi-ai 的助手事件翻译为 Harness 的流式协议。
 *
 * pi-ai 的工具调用参数是已解析的对象，而 Harness 保留它们的原始 JSON
 * 表示。pi-ai 还把失败报告为终止性的流事件，本模块把它们映射为
 * Harness 的 finish 块。
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * 映射 pi-ai 的用量（pi-ai 把推理折进了输出）。
 * @param usage - 来自终止性 pi-ai 事件的累计用量。
 * @returns 携带 pi-ai 精确总计的 harness 计数；缓存字段只在非零时出现
 *   （pi-ai 报告的是零，而不是缺失）。
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai 上游)：pi-ai 把被捕获的错误压平为 `error.message`
// （api/anthropic-messages.js：`errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`），在它到达我们之前就丢弃了原始的
// Error 及其 `cause` 链。undici 把可操作的传输细节放在 `cause` 上
// （例如 `SocketError: other side closed`），却把 fetch 包装器交给一个
// 光秃秃的 `terminated`，因此我们只能在这里对简略的措辞做模式匹配。
// 如果 pi-ai 将来转发原始的 Error（或提供一个能让我们自己捕获 cause 的
// fetch/dispatcher 钩子），就改为依据 `code`/`cause` 而不是文本来分类。
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // 一个被拒绝的请求体（网关或提供方的大小上限）：重发同一次请求
  // 不可能成功，因此它是无效请求，而不是瞬时错误。
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // 在提供方的终止性事件之前就被截断的流：当线路在响应中途关闭而没有
  // 终止性事件时，每个 pi-ai 提供方都会抛出自家的措辞
  // （`… stream ended before message_stop`、`… before a terminal response
  // event`、`… ended without a terminal event`、`Stream ended without
  // finish_reason`）。连接在响应中途断开，因此这是一次传输截断，
  // 而不是模型级错误。
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici 把一次流中途的 socket 断掉渲染为一个光秃秃的 `terminated`
    // （它的 `cause` —— 真正的 SocketError —— 已在上游被压平掉了）；
    // Node 的流层会说 `Premature close`。
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * 把一个终止性的 pi-ai 事件映射为 harness 的结束原因。
 * @param message - 由 `done` 或 `error` 事件所携带的助手消息。
 * @param contextWindow - 供基于用量的溢出检测使用的、已解析的目录容量。
 * @returns 映射后的 harness 原因。已识别的错误文本、高于 `contextWindow`
 *   的 `stop` 用量，以及填满窗口但输出为零的 `length` 用量，都映射为
 *   `CONTEXT_WINDOW_EXCEEDED`；一个没有任何内容块的 `stop` 映射为一个
 *   `EMPTY_RESPONSE` 错误，而终止性的 `pending` 与 `deferred` 状态
 *   映射为不可重试的 `PI_AI_ERROR` 失败。
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // 一个没有产出任何内容块的终止性 stop 是一次退化的提供方完成，
      // 而不是一条成功的（空的）助手消息。
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * 把 pi-ai 的事件流翻译为 StreamChunk。pi-ai 从不在流中途抛出——
 * 失败以 `error` 事件到达，它们会变成 error/aborted 的 `finish` 块。
 * @param events - 一个助手轮次的 pi-ai 事件流。
 * @param contextWindow - 供基于用量的溢出检测使用的、已解析的目录容量。
 * @param callerSignal - 调用方的取消状态；一个已中止的调用方会把任何
 *   带内的终止性错误变成一个 aborted 结束。
 * @param requestedModel - 为持久化回放而记录的、被请求的模型身份。
 * @returns 各个 harness 块，以 `usage` 然后 `finish` 结束；当来源在没有
 *   终止性事件的情况下结束时会抛出 `LlmError`（`STREAM_CLOSED`）。
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai 的 contentIndex ↔ 我们的块索引是 1:1 映射（两者都按流顺序
  // 从 0 开始数块），但我们按索引跟踪工具调用的 id。
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // 那个 id/name 位于本索引上那个 partial 的内容中。
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai 交回的是已解析的参数；而 harness 的词汇保留原始字符串。
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // 流内错误投递（pi-ai 的风格）→ error finish 块
        // （harness 除了抛出之外的另一条受认可的错误路径）。
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      // 没有 default：AssistantMessageEvent 是 pi-ai 的封闭联合；
      // 当新增一种事件类型时，这里的 switch 覆盖当前全部变体，
      // 应当通过 tsc 的穷尽性检查让编译失败。
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
