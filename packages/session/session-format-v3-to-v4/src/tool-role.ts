/** V4 表示中的一等 tool-role 消息。 */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

const WRAPPER_FIELDS = new Set(['type', 'toolCallId', 'content', 'isError'])
const MESSAGE_FIELDS = new Set(['id', 'role', 'source', 'content'])

/** 保留未知字段，但不合并它们原本所属的消息与结果持有者。 */
function extensionFields(
  value: Record<string, SessionFormatJsonValue>, fields: ReadonlySet<string>, owner: 'message' | 'result',
): Record<string, SessionFormatJsonValue> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key))
    .map(([key, field]) => [`plugin:${owner}:${key}`, field]))
}

function resultContent(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${subject} tool-result content must be an array`)
  if (value.some(block => isSessionFormatJsonObject(block) && block['type'] === 'tool-result')) {
    throw new SessionFormatUnsupportedMigrationError(
      `${subject} contains a nested tool-result unsupported by this converter`,
    )
  }
  return value as SessionFormatJsonValue[]
}

/**
 * 将一条已发布的 V3 包装式 tool/result 行提升为一等的 V4 消息。
 * 在丢弃包装器之前先校验它，这样格式错误的历史内容会被拒绝，
 * 而不是被静默截断。
 * @param event - 已发布的包装式 tool/result 事件。
 * @returns 同一个事件，但携带一等 tool-role 消息。
 * @throws {SessionFormatError} 当包装器、工具源、内容或错误标记格式错误时抛出。
 * @throws {SessionFormatUnsupportedMigrationError} 当结果中嵌套了另一个结果时抛出。
 */
export function liftToolResult(event: SessionFormatEvent): SessionFormatEvent {
  if (event.type !== 'tool/result' || !isSessionFormatJsonObject(event.data)) return event
  const data = event.data
  const message = data['message']
  if (!isSessionFormatJsonObject(message) || message['role'] !== 'user') return event
  const source = message['source']
  const callId = isSessionFormatJsonObject(source) ? source['callId'] : undefined
  const content = message['content']
  const block = Array.isArray(content) && content.length === 1
    ? (content as readonly SessionFormatJsonValue[])[0]
    : undefined
  const wrapper = isSessionFormatJsonObject(block) ? block : undefined
  const id = message['id']
  if (typeof id !== 'string' || id.length === 0
    || !isSessionFormatJsonObject(source) || source['kind'] !== 'tool'
    || typeof callId !== 'string' || callId.length === 0
    || wrapper === undefined || wrapper['type'] !== 'tool-result'
    || wrapper['toolCallId'] !== callId) {
    throw new SessionFormatError(`format v3 ${event.type} at seq ${event.seq} requires exactly one tool-result wrapper matching its tool source`)
  }
  const isError = wrapper['isError']
  if (isError !== undefined && typeof isError !== 'boolean') {
    throw new SessionFormatError(`format v3 ${event.type} at seq ${event.seq} tool-result isError must be boolean`)
  }
  const targetMessage: Record<string, SessionFormatJsonValue> = {
    role: 'tool',
    source,
    toolCallId: callId,
    content: resultContent(wrapper['content'], `format v3 ${event.type} at seq ${event.seq}`),
    ...(isError === undefined ? {} : { isError }),
    id,
    ...extensionFields(message, MESSAGE_FIELDS, 'message'),
    ...extensionFields(wrapper, WRAPPER_FIELDS, 'result'),
  }
  return { ...event, data: { ...data, message: targetMessage } }
}

/**
 * 校验某个 tool/result 行的原生 V4 一等 tool-role 消息。
 * @param event - 规范化的 V4 事件。
 * @throws {SessionFormatError} 当该行不是精确的一等工具结果时抛出。
 */
export function assertV4ToolResultMessage(event: SessionFormatEvent): void {
  if (event.type !== 'tool/result') return
  const subject = `format v4 ${event.type} at seq ${event.seq}`
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError(`${subject} data must be an object`)
  const message = data['message']
  if (!isSessionFormatJsonObject(message)) throw new SessionFormatError(`${subject} message must be an object`)
  const id = message['id']
  const role = message['role']
  const toolCallId = message['toolCallId']
  const source = message['source']
  const isError = message['isError']
  const content = message['content']
  const sourceCallId = isSessionFormatJsonObject(source) ? source['callId'] : undefined
  if (typeof id !== 'string' || id.length === 0) {
    throw new SessionFormatError(`${subject} requires a first-class message with a string id`)
  }
  if (role !== 'tool') throw new SessionFormatError(`${subject} requires a tool-role message`)
  if (typeof toolCallId !== 'string' || toolCallId.length === 0 || sourceCallId !== toolCallId) {
    throw new SessionFormatError(`${subject} requires toolCallId matching its tool source`)
  }
  if (!isSessionFormatJsonObject(source) || source['kind'] !== 'tool') {
    throw new SessionFormatError(`${subject} requires a tool source`)
  }
  if (!Array.isArray(content)) throw new SessionFormatError(`${subject} requires array content`)
  if (content.some(block => isSessionFormatJsonObject(block) && block['type'] === 'tool-result')) {
    throw new SessionFormatError(`${subject} content must not contain a released tool-result wrapper`)
  }
  if (isError !== undefined && typeof isError !== 'boolean') {
    throw new SessionFormatError(`${subject} isError must be boolean when present`)
  }
  if (data['error'] !== undefined && isError !== true) {
    throw new SessionFormatError(`${subject} carries error metadata for a non-error tool result`)
  }
}
