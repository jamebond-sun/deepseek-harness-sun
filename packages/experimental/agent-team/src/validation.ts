/** 由 Team 花名册与任务命令共享的输入归一化。 */

import { TeamError } from './error.ts'

/**
 * 归一化一个必需的、人工撰写的字符串。
 * @param value - 原始输入值。
 * @param field - 用于诊断的字段名。
 * @param maxLength - 归一化后的最大字符数。
 * @returns 已去除首尾空白的非空文本。
 */
export function requiredText(value: string, field: string, maxLength: number): string {
  const text = value.trim()
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, 'TEAM_INVALID_ARGUMENT')
  if (text.length > maxLength) {
    throw new TeamError(`${field} exceeds ${maxLength} characters`, 'TEAM_INVALID_ARGUMENT')
  }
  return text
}

/**
 * 归一化一个相对于工作区的路径前缀，且不将其视为锁。
 * @param value - 用户撰写的路径前缀。
 * @returns 归一化后的、以斜杠分隔的前缀。
 */
export function writeScope(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, 'TEAM_INVALID_WRITE_SCOPE')
  }
  return normalized
}
