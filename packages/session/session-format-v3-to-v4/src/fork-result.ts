/** 原生 V4 的 fork 结果身份与未启动错误校验。 */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

/**
 * 校验 fork 生成的未启动结果，不改变其身份或文本。
 * 追加结果携带自身的序号；替换结果保留更早的身份。
 * @param row - 逻辑事件或物理事件行。
 */
export function assertV4ForkResult(row: unknown): void {
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  const data = row['data']
  if (!isSessionFormatJsonObject(data)) return
  const error = data['error']
  const message = data['message']
  if (!isSessionFormatJsonObject(error) || error['code'] !== 'TOOL_NOT_STARTED'
    || !isSessionFormatJsonObject(message) || typeof message['id'] !== 'string'
    || !message['id'].startsWith('forked-tool-result-')) return
  const source = message['source']
  const callId = isSessionFormatJsonObject(source) ? source['callId'] : undefined
  const prefix = `forked-tool-result-${String(callId)}-`
  const suffix = message['id'].slice(prefix.length)
  const operation = row['surfaceOp']
  const replacement = isSessionFormatJsonObject(operation) && operation['op'] === 'replace'
  const sequence = Number(suffix)
  const content = message['content']
  const text: unknown = Array.isArray(content) && content.length === 1 ? content[0] : undefined
  const sourceEventSeqs = row['sourceEventSeqs']
  if (typeof callId !== 'string' || !message['id'].startsWith(prefix)
    || !/^(0|[1-9]\d*)$/.test(suffix) || !Number.isSafeInteger(sequence)
    || (replacement ? typeof row['seq'] !== 'number' || sequence >= row['seq'] : sequence !== row['seq'])
    || error['name'] !== 'ToolNotStartedError'
    || (!replacement && (sourceEventSeqs !== undefined || operation !== 'append'))
    || (replacement && (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length !== 1 || sourceEventSeqs[0] !== sequence))
    || message['role'] !== 'tool' || message['isError'] !== true || message['toolCallId'] !== callId
    || !isSessionFormatJsonObject(source) || source['kind'] !== 'tool'
    || !isSessionFormatJsonObject(text) || text['type'] !== 'text' || typeof text['text'] !== 'string') {
    throw new SessionFormatError('invalid V4 not-started fork result')
  }
}
