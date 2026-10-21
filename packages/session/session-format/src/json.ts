import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionFormatError } from './error.ts'
import type {
  SessionFormatHeader,
  SessionFormatJsonValue,
} from './types.ts'

/**
 * 判断一个值是否为非空、非数组的对象。
 * @param value - 待检测的值。
 * @returns 该值是否为对象记录。
 */
export function isSessionFormatJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 要求一个非负安全整数，且排除 JSON 中不稳定的负零。
 * @param value - 待检测的计数。
 * @param label - 诊断主体。
 * @returns 已校验的计数。
 */
export function sessionFormatCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

/**
 * 要求一个安全整数，且排除 JSON 中不稳定的负零。
 * @param value - 待检测的整数。
 * @param label - 诊断主体。
 * @returns 已校验的整数。
 */
export function sessionFormatSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new SessionFormatError(`${label} must be a safe integer`)
  }
  return value as number
}

/**
 * 要求一个非负整数格式版本。
 * @param value - 待检测的版本。
 * @param label - 诊断主体。
 * @returns 已校验的版本。
 */
export function sessionFormatVersion(value: unknown, label = 'Session format version'): number {
  return sessionFormatCount(value, label)
}

/**
 * 仅读取定向分发所需的版本。
 * @param headerValue - 未受信任的物理头部值。
 * @returns 已校验的存储版本。
 */
export function inspectSessionFormatVersion(headerValue: unknown): number {
  if (!isSessionFormatJsonObject(headerValue)) {
    throw new SessionFormatError('Session header must be a JSON object')
  }
  return sessionFormatVersion(headerValue['version'])
}

/**
 * 分离并深度冻结调用方提供的无损 JSON 值。
 * @param value - 借用的候选值。
 * @param label - 诊断主体。
 * @returns 不可变的、已分离的 JSON 快照。
 */
export function snapshotSessionFormatJson(value: unknown, label = 'Session value'): SessionFormatJsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) {
    throw new SessionFormatError(`${label} is not lossless JSON`)
  }
  return deepFreeze(snapshot) as SessionFormatJsonValue
}

/**
 * 在不检查事件体的前提下快照一个逻辑头部。
 * @param header - 借用的逻辑头部。
 * @param label - 诊断主体。
 * @returns 不可变的、已分离的头部。
 */
export function snapshotSessionFormatHeader(header: SessionFormatHeader, label = 'Session header'): SessionFormatHeader {
  const snapshot = snapshotSessionFormatJson(header, label)
  if (!isSessionFormatJsonObject(snapshot)) throw new SessionFormatError(`${label} must be a JSON object`)
  inspectSessionFormatVersion(snapshot)
  if (typeof snapshot['id'] !== 'string') throw new SessionFormatError(`${label} id must be a string`)
  sessionFormatCount(snapshot['createdAt'], `${label} createdAt`)
  if (typeof snapshot['isSeeded'] !== 'boolean') throw new SessionFormatError(`${label} isSeeded must be a boolean`)
  sessionFormatCount(snapshot['delegationDepth'], `${label} delegationDepth`)
  return snapshot as SessionFormatHeader
}
