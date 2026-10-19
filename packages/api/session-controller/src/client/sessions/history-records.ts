/** 对齐的 Session 历史记录的 Client 范围访问与类型收窄。 */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'

/**
 * 无分配地把对齐的 wire 记录收窄为它们的 Client 事件类型。
 * @param records - 经校验的历史传输记录。
 * @returns 同一个记录数组，内部事件带类型。
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  return records as unknown as readonly SessionEventLikeEntry[]
}

/**
 * 读取一条 wire 记录所表示的首个逻辑序列。
 * @param record - 经校验的 Session 事件。
 * @returns 包含在内的首个 Session 序列。
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * 读取一条 wire 记录所表示的最后一个逻辑序列。
 * @param record - 经校验的 Session 事件。
 * @returns 包含在内的最后一个 Session 序列。
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}
