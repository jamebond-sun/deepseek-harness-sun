import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * 要求一个普通 JSON 对象。
 * @param value - 待检测的 JSON 值。
 * @param label - 诊断主体。
 * @returns 已校验的对象记录。
 */
export function releasedV0Record(value: unknown, label: string): Record<string, SessionFormatJsonValue> {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(`${label} must be a JSON object`)
  return value as Record<string, SessionFormatJsonValue>
}

/**
 * 要求每个具名成员都存在，且不存在可选列表之外的成员。
 * @param record - 待检测的对象。
 * @param required - 必须存在的成员。
 * @param optional - 额外被接纳的成员。
 * @param label - 诊断主体。
 */
export function assertReleasedV0Keys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const unexpected = Object.keys(record).find(key => !allowed.has(key))
  if (unexpected !== undefined) throw new SessionFormatError(`${label} has unexpected member ${JSON.stringify(unexpected)}`)
  const missing = required.find(key => !Object.hasOwn(record, key))
  if (missing !== undefined) throw new SessionFormatError(`${label} lacks required member ${JSON.stringify(missing)}`)
}
