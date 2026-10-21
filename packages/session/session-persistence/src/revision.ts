/** 用于轻量级持久化观测的不透明修订标识。 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * 后端持有的令牌，同时标识一个存储来源与一份已持久化会话日志的一个修订。
 */
export type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>

/**
 * 为与提供方无关的持久化契约标记一个后端修订。
 * @param value - 后端持有的不透明修订表示。
 * @returns 同一个运行时字符串，但带有持久化修订身份。
 */
export function SessionPersistenceRevision(value: string): SessionPersistenceRevision {
  return value as SessionPersistenceRevision
}
