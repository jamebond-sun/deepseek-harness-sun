/** 原始 Session 日志响应的事件局部接纳；载荷保持属主定义的 JSON。 */

import { validateSessionEventData, validateSurfaceMetadata } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent } from '../types.ts'

/**
 * 拒绝非当前事件信封，而不剥离或规范化 wire 字段。
 * 范围成员关系与来源存在性需要持久化日志，仍由 Host 持有。
 * @param value - 跟随帧或历史页收到的一个事件。
 * @returns 在收窄被接纳的事件信封之后不返回任何东西。
 * @throws 当信封或当前事件局部元数据无效时。
 */
export function assertSessionWireEvent(value: unknown): asserts value is SessionWireEvent {
  const subject = 'session wire event'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
  const event = value as Record<string, unknown>
  for (const key of Object.keys(event)) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'ignorable':
      case 'surfaceOp':
      case 'sourceEventSeqs':
        break
      default:
        throw new Error(`${subject} has unexpected field ${key}`)
    }
  }
  const seq = event['seq']
  if (typeof event['type'] !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof event['time'] !== 'number' || !Number.isSafeInteger(event['time'])
    || !Object.hasOwn(event, 'data') || event['data'] === undefined
    || (Object.hasOwn(event, 'ignorable') && event['ignorable'] !== true)) {
    throw new Error(`${subject} has an invalid envelope`)
  }
  // 事件名与载荷是合并可扩展的；这里只运行事件局部的属主规则。
  const current = event as SessionEvent
  validateSurfaceMetadata(current)
  validateSessionEventData(current, subject)
}
