/** 类型化的 Agent Teams 失败。 */

import { inspect } from 'node:util'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** 由 Team 领域抛出的稳定失败。 */
export class TeamError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'TeamError'
  }
}

/**
 * 渲染一个被抛出的任意值，同时不替换原始的拒绝原因。
 * @param error - 用于诊断或持久化失败记录的、被捕获的值。
 * @returns 一条有界的单行描述。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return inspect(error, { breakLength: Infinity, compact: true, depth: 4 })
}
