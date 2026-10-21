/** 依据已配置的路由能力，把系统快照、工具变更与对话轮次映射为 Messages。 */

import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { readReplay } from './replay.ts'
import type { WireBlock, WireInput, WireMessage, WireRequest } from './wire-types.ts'

function unsupported(type: string): never {
  throw new LlmError(`DeepSeek Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Messages 无法表示的历史参数使用空输入；持久化内容保持不变。 */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function assistant(message: Message, model: string, onReplayDegrade?: (reason: string) => void): WireBlock[] {
  const replay = readReplay(message, model, onReplayDegrade)
  return message.content.flatMap((block, index): WireBlock | WireBlock[] => {
    switch (block.type) {
      case 'text': return block.text.length === 0 ? [] : { type: 'text', text: block.text }
      case 'reasoning': return {
        type: 'thinking', thinking: block.text,
        ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
      }
      case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
      default: return unsupported(`assistant content ${block.type}`)
    }
  })
}

/** 使用已准备好的图像字节序列化一次完整的请求。
 * 用户与工具结果内容会省略推理与工具调用块。
 * 空的助手文本块，以及空的用户/助手消息会被跳过；
 * 空的工具结果保留其调用 id。
 * 已由 `LlmRuntime` 为本路由投影过的 developer 消息，会成为前一个用户轮次之后的
 * system 角色更新，其中工具变更表现为指向已声明工具的 `tool_addition`
 * 与 `tool_removal` 引用。
 * @param options - 与提供方无关的请求。
 * @param connection - 已校验的默认值与 thinking 策略。
 * @param history - 已完成图像投影、并带有完整系统快照的历史；持久化消息保持不变。
 * @param images - 被保留图像的请求版本。
 * @param access - 供图像描述使用的执行世界路径。
 * @param onReplayDegrade - 针对被丢弃的原生回放元数据的诊断。
 * @param fileIds - 已解析的 Files 引用；省略时选择内联图像字节。
 * @returns Messages API 的 JSON 请求体。
 */
export function serialize(
  options: GenerateOptions, connection: Connection, history: readonly RequestMessage[],
  images: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, access: ImageAttachmentAccessResolver,
  onReplayDegrade?: (reason: string) => void,
  fileIds?: ReadonlyMap<ImageAttachmentRef['attachmentId'], DeepSeekFileId>,
): WireRequest {
  const model = connection.models.find(entry => entry.id === options.model)
  const inHistory = model?.systemPromptUpdate === 'in-history'
  const input = (blocks: readonly ContentBlock[]): WireInput[] => blocks.flatMap((block): WireInput[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'reasoning' || block.type === 'tool-call') return []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    const version = images.get(block.attachment.attachmentId)
    if (version === undefined) throw new LlmError('DeepSeek Messages request image is missing', 'INVALID_REQUEST')
    const fileId = fileIds?.get(block.attachment.attachmentId)
    if (fileIds !== undefined && fileId === undefined) throw new LlmError('DeepSeek Messages request file id is missing', 'INVALID_REQUEST')
    return [
      { type: 'text', text: requestImageHandleText(block.attachment, version, access(block.attachment)) },
      fileId === undefined
        ? { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
        : { type: 'image', source: { type: 'file', file_id: fileId } },
    ]
  })
  const messages: WireMessage[] = []
  let historySystem: string | undefined
  const systemUpdates: WireMessage[] = []
  // Harness 在用户输入之前接受系统更新。Messages 会把同样的更新放在
  // 该用户/工具结果轮次之后、下一个助手之前。
  const flushSystemUpdates = () => {
    if (systemUpdates.length === 0) return
    if (messages.at(-1)?.role !== 'user') return unsupported('system update without a preceding user or tool-result turn')
    messages.push(...systemUpdates.splice(0))
  }
  for (const message of history) {
    if (message.role === 'developer') {
      const content = message.content.flatMap((block): WireBlock[] => {
        switch (block.type) {
          case 'text': return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
          case 'tool-addition': return [{ type: 'tool_addition', tool: { type: 'tool_reference', name: block.toolName } }]
          case 'tool-removal': return [{ type: 'tool_removal', tool: { type: 'tool_reference', name: block.toolName } }]
          default: return unsupported(`developer content ${block.type}`)
        }
      })
      if (content.length > 0) systemUpdates.push({ role: 'system', content })
      continue
    }
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      return unsupported('tool-change blocks outside developer messages')
    }
    if (message.role === 'system') {
      const texts = message.content.filter(block => block.type === 'text')
      if (texts.length !== message.content.length) return unsupported('non-text system message')
      const text = texts.map(block => block.text).join('')
      if (inHistory && messages.length > 0) {
        if (text.length === 0) return unsupported('empty in-history system update')
        systemUpdates.push({ role: 'system', content: [{ type: 'text', text }] })
      } else {
        historySystem = text
      }
      continue
    }
    const content: WireBlock[] = message.role === 'assistant'
      ? assistant(message, options.model, onReplayDegrade)
      : message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: input(message.content), ...message.isError === undefined ? {} : { is_error: message.isError } }]
        : message.content.flatMap((block): WireBlock[] => input([block]))
    if ((message.role === 'user' || message.role === 'assistant') && content.length === 0) continue
    if (message.role === 'assistant') flushSystemUpdates()
    const wireRole = message.role === 'tool' ? 'user' : message.role
    const previous = messages.at(-1)
    if (previous?.role === wireRole) previous.content.push(...content)
    else messages.push({ role: wireRole, content })
  }
  flushSystemUpdates()
  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(block => block.type === 'tool_use')
      pending = new Set(calls.map(block => block.id))
      if (pending.size !== calls.length) throw new LlmError('DeepSeek Messages duplicate tool call id', 'INVALID_REQUEST')
    } else if (message.role === 'user') {
      const results = message.content.filter(block => block.type === 'tool_result')
      for (const result of results) {
        if (!pending.delete(result.tool_use_id)) throw new LlmError('DeepSeek Messages tool result has no matching call', 'INVALID_REQUEST')
      }
      if (pending.size > 0) throw new LlmError('DeepSeek Messages tool calls need immediate results', 'INVALID_REQUEST')
      message.content = [...results, ...message.content.filter(block => block.type !== 'tool_result')]
    }
  }
  if (pending.size > 0) throw new LlmError('DeepSeek Messages history ends with unresolved tools', 'INVALID_REQUEST')
  const effort = options.reasoningEffort ?? (connection.defaults.reasoningEffort ?? (connection.defaults.thinking === 'disabled' ? 'off' : 'high'))
  if (!['off', 'low', 'high', 'max'].includes(effort) || (connection.defaults.thinking === 'disabled' && effort !== 'off')) {
    throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const system = [options.system, historySystem].filter(Boolean).join('\n\n')
  return {
    model: options.model, stream: true, messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort: effort as 'low' | 'high' | 'max' } },
    ...system.length === 0 ? {} : { system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...tool.deferLoading === true ? { defer_loading: true as const } : {},
      })),
    },
  }
}
