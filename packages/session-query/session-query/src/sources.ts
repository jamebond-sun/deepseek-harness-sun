/** 逻辑会话源观察者共用的不可变头部校验。 */

import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from './config.ts'

/**
 * 拒绝对同一逻辑会话源做出互不兼容的观察。
 * @param a - 第一个 live、listed 或 loaded 的头部观察结果。
 * @param b - 第二个头部观察结果，预期标识同一个源。
 */
export function assertSessionHeadersCompatible(a: SessionHeader, b: SessionHeader): void {
  if (
    a.id !== b.id
    || a.createdAt !== b.createdAt
    || a.cwd !== b.cwd
    || a.parentSession !== b.parentSession
    || a.isSeeded !== b.isSeeded
    || (a.delegationDepth ?? 0) !== (b.delegationDepth ?? 0)
  ) {
    throw new SessionQueryError(
      `session source headers conflict for session "${a.id}"`,
      'SESSION_QUERY_SOURCE_CONFLICT',
    )
  }
}
