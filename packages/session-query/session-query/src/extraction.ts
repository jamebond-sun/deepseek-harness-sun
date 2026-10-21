/** 面向 session-query 使用方的第一方语义文本抽取。 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 仅类型：包含下面消费到的第一方 todo 事件。
import type {} from '@deepseek-ai/dsh-tool-todo'

/**
 * 从一个第一方会话事件中抽取可搜索的语义文本。
 *
 * 结构性边界、内嵌的原始流、请求信封以及未知的声明合并事件都不贡献文本。
 * @param event - 要检查的事件。
 * @returns 以换行连接的语义文本；不可搜索时返回空字符串。
 */
export function extractSessionEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return contentText(event.data.content)
    case 'assistant/message':
      return contentText(event.data.message.content)
    case 'tool/call':
      return joinText([event.data.name, event.data.arguments])
    case 'tool/result':
      return joinText([
        contentText(event.data.message.content),
        event.data.error?.name ?? '',
        event.data.error?.code ?? '',
      ])
    case 'todo/write':
      return joinText(event.data.todos.flatMap(todo => [todo.status, todo.content]))
    case 'turn/end':
      return turnEndText(event.data.reason)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'request/header':
      return ''
    // SessionEventMap 是可合并扩展的。在具体的第一方消费方定义语义之前，
    // 未知事件保持不可搜索。
    default:
      return ''
  }
}

function turnEndText(reason: SessionEvent<'turn/end'>['data']['reason']): string {
  switch (reason.kind) {
    case 'error':
      return joinText(['error', reason.error.message])
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'interrupted':
      return reason.kind
    case 'completed':
      return ''
    // TurnEndReasonMap 是可合并扩展的。在其属主定义哪一部分细节属于语义而非结构之前，
    // 未知结果不参与抽取。
    default:
      return ''
  }
}

type SessionContentBlock = SessionEvent<'user/message'>['data']['content'][number]

function contentText(content: readonly SessionContentBlock[]): string {
  return joinText(content.flatMap(blockText))
}

function blockText(block: SessionContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    // ContentBlockMap 是可合并扩展的。未知分块不会因为其载荷恰好含有字符串
    // 就变成可搜索内容。
    default:
      return []
  }
}

function joinText(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}
