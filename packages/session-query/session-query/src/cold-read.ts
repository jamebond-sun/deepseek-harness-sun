/** 通过基于句柄的持久化接缝完成的一次性冷会话读取。 */

import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeedEventState } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence'

/** 为只读查看做过平衡处理的已存储会话日志。 */
export interface ColdSessionLog {
  /** 已持久化事件的别名状态；合成的闭合事件由本地持有。 */
  readonly eventState: SessionSeedEventState
  /** 已存储的头部，在读取句柄打开时即固定。 */
  readonly header: SessionHeader
  /** 与 {@link header} 配对、精确的 fork 继承事件数。 */
  readonly inheritedEventCount: SessionLogOffset
  /** 已存储事件加上为被中断的最后一轮生成的确定性内存闭合事件；不会写回任何内容。 */
  readonly events: SessionEvent[]
}

/**
 * 读取一份完整的已存储会话日志，既不获取所有权也不改动存储：打开读取句柄、
 * 读取经过校验的连续日志、关闭句柄，并追加 `interruptedTurnClosers`，
 * 使写入者在回合中途崩溃的日志也能折叠成一份平衡的 transcript。
 * 后端错误原样向上传播、不做映射——每个调用方各自拥有自己的错误分类。
 * @param persistence - 已挂载的持久化服务。
 * @param sessionId - 要读取的已存储会话。
 * @param signal - open 与 read 工作的可选取消信号。
 * @returns 位于调用方持有的外层数组中的可领养种子，可直接用于原地恢复 Session。
 */
export async function readColdSessionLog(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ColdSessionLog> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await persistence.open(sessionId, 'read', options)
  let read: SessionHandleReadResult
  try {
    read = await handle.read(0, undefined, options)
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {
      // 读取失败才是可据以行动的原因；同一个已损坏句柄上的关闭失败不带来额外信息。
    }
    throw error
  }
  await handle.close()
  const { events } = read
  return {
    eventState: read.eventState,
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}
