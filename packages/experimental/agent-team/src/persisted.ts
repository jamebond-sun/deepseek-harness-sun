/** 对持久化 Team 成员 Session 的、短生命周期的读取句柄访问。 */

import type { SessionEvent, SessionHeader, SessionId , SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** 一份持久化 Session 的、分离的头信息与完整的已提交事件日志。 */
export interface PersistedSessionView {
  /** 与 `header` 配对的、精确的 fork 继承事件计数。 */
  readonly inheritedEventCount: SessionLogOffset
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/**
 * 通过一个短生命周期的读取句柄读取一份已存储 session 的头信息与完整事件日志，
 * 并在返回前关闭该句柄。
 * @param persistence - 持久化 session 存储。
 * @param id - 要读取的已存储 session。
 * @param signal - 被 open 与 read 观察到的取消信号。
 * @returns 已存储的头信息与每一个已提交的事件。
 */
export async function readPersistedSession(
  persistence: SessionPersistence,
  id: SessionId,
  signal: AbortSignal,
): Promise<PersistedSessionView> {
  const handle = await persistence.open(id, 'read', { signal })
  try {
    const { events } = await handle.read(0, undefined, { signal })
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  } finally {
    await handle.close()
  }
}
