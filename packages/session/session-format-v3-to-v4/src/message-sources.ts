/** 原生源接纳保留未知归属，并拒绝已退役的 plugin 包装。 */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { mapEventMessages } from './sources.ts'

function source(message: Readonly<Record<string, unknown>>): void {
  const value = message['source']
  if (!isSessionFormatJsonObject(value) || typeof value['kind'] !== 'string' || value['kind'].length === 0 || value['kind'] === 'plugin') {
    throw new SessionFormatError('format v4 message requires a producer-owned source kind')
  }
}

/**
 * 校验每个已声明的持久消息槽位中的生产者归属。
 * @param event - 被 Session 接纳之前的完整原生 V4 事件。
 */
export function assertV4MessageSources(event: SessionFormatEvent): void {
  mapEventMessages(event, (message) => {
    source(message)
    return message
  })
}

/**
 * 即使在格式错误的可恢复行之后，也拒绝已退役的源语法；不完整的消息交给解码处理。
 * @param row - 已解析的行，其不完整的值尚未被扫描器分类。
 */
export function assertV4SourceRowAdmission(row: unknown): void {
  if (!isSessionFormatJsonObject(row) || !isSessionFormatJsonObject(row['data'])) return
  const data = row['data']
  const messages = row['type'] === 'user/message' ? [data]
    : row['type'] === 'system/message' || row['type'] === 'assistant/message' || row['type'] === 'tool/result' ? [data['message']]
      : row['type'] === 'agent/inbox/spliced' ? data['inserted']
        : row['type'] === 'session/title-llm-request' ? data['messages'] : []
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!isSessionFormatJsonObject(message)) continue
    const value = message['source']
    if (isSessionFormatJsonObject(value) && value['kind'] === 'plugin') source(message)
  }
}
