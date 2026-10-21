/**
 * 后端共用的存储校验：版本闸门、失败关闭的事件词表、追加批次物化与连续性——
 * 集中在一处，以便每个后端以完全相同的方式拒绝相同的输入。
 * @module @deepseek-ai/dsh-session-persistence/storage-contract
 */

import {
  adoptSessionEvent,
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  sessionFormatVersionRefusal,
  type SessionLocation,
} from './errors.ts'

/** 构造一个格式拒绝；当后端持有原始制品时，指向它。 */
function unsupported(reason: string, location: SessionLocation | undefined): SessionFormatUnsupportedError {
  return new SessionFormatUnsupportedError(
    location === undefined ? reason : `${reason} (raw log: ${location.path})`,
    location,
  )
}

/**
 * 拒绝未绑定到所请求会话 id 的已存储元数据。
 * @param id - 所请求的会话 id。
 * @param meta - 已存储的头部。
 */
export function assertStoredId(id: SessionId, meta: SessionHeader): void {
  if (meta.id !== id) {
    throw new Error(`stored session identity mismatch: requested "${id}", header contains "${meta.id}"`)
  }
}

/**
 * 拒绝尚未恢复到当前逻辑格式的头部。
 * @param meta - 已存储的头部。
 * @param location - 后端用于拒绝诊断的制品位置，若存在的话。
 */
export function assertVersion(
  meta: { readonly id: SessionId; readonly version: number },
  location?: SessionLocation,
): void {
  if (meta.version !== SESSION_FORMAT_VERSION) {
    throw unsupported(sessionFormatVersionRefusal(meta.id, meta.version), location)
  }
}

/**
 * 就地校验一个独占所有的已存储事件数组：接纳每条记录（校验并冻结它），
 * 并拒绝本构建不认识的任何事件类型，除非其写入者将其标记为
 * `ignorable: true`——静默跳过一个未知的必需事件可能重建出错误的会话
 * （即 `SessionEvent.ignorable` 上的信封契约）。未知的必需类型与已退役的
 * 预发布形态都在此处被拒绝；本校验器不执行任何迁移。
 * @param meta - 这些事件所属的已存储头部。
 * @param events - 独占所有的已解码事件；就地校验。
 * @param location - 后端用于拒绝诊断的制品位置，若存在的话。
 * @returns 同一个数组，已校验并冻结。
 * @throws {SessionFormatUnsupportedError} 遇到未知事件类型时抛出。
 * @throws {SessionPersistenceCorruptionError} 遇到未通过校验的记录时抛出。
 */
export function validateStoredEvents(
  meta: SessionHeader,
  events: SessionEvent[],
  location?: SessionLocation,
): SessionEvent[] {
  for (const event of events) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw unsupported(
        `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
        location,
      )
    }
    // 藏在已知类型之下的唯一一种已退役形态：被移除的 delta 编解码器的
    // 全量头部 "fallback" reason。其它已退役的东西都是整个事件类型。
    if (event.type === 'request/header') {
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null
        && (data as Record<string, unknown>)['reason'] === 'fallback') {
        throw unsupported(
          `session "${meta.id}" contains a request/header event (seq ${event.seq}) with the unsupported legacy reason "fallback"; refusing to interpret the log — it was written by a retired pre-release harness`,
          location,
        )
      }
    }
  }
  try {
    for (const [index, event] of events.entries()) events[index] = adoptSessionEvent(event)
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedError) throw error
    throw new SessionPersistenceCorruptionError(
      `stored session "${meta.id}" failed validation: ${String(error)}`,
      { cause: error },
    )
  }
  return events
}

/**
 * 在一次遍历中校验并深度快照传给 `create` 的头部。
 * @param header - 调用方提供的头部。
 * @returns 已分离的无损 JSON 头部。
 * @throws {TypeError} 遇到非 JSON 元数据或无效的 `createdAt` 时抛出。
 */
export function materializeCreateHeader(header: SessionHeader): SessionHeader {
  const snapshot = snapshotJsonValue(header)
  if (snapshot === undefined) {
    throw new TypeError('session metadata must be losslessly JSON-serializable')
  }
  if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
    throw new TypeError('session metadata createdAt must be a non-negative safe integer')
  }
  return snapshot
}

/**
 * 在一次遍历中校验并深度快照一个追加批次，使被检查的值恰好就是被持久化的值
 * （先检查再复制可能会把访问器重读成另一条记录）。
 * @param events - 调用方提供的批次。
 * @returns 已分离的无损 JSON 批次。
 * @throws {TypeError} 当任何事件数据无法无损 JSON 序列化时抛出。
 */
export function materializeAppendBatch(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const batch = snapshotJsonValue(events)
  if (batch === undefined) {
    throw new TypeError('session event batch is not losslessly JSON-serializable because it contains non-JSON-serializable data')
  }
  return batch
}

/**
 * 拒绝未连续延续已存储日志的批次。
 * @param id - 该批次所属的会话。
 * @param events - 按 seq 排序的批次。
 * @param cursor - 已存储的 next-seq。
 */
export function assertContiguous(id: SessionId, events: readonly SessionEvent[], cursor: number): void {
  for (const [index, event] of events.entries()) {
    if (event.seq !== cursor + index) {
      throw new Error(`append seq mismatch for "${id}": expected ${cursor + index} at index ${index}, got ${event.seq}`)
    }
  }
}
