import type { Branded } from '@deepseek-ai/dsh-brand'

/** 同一个请求步骤的重试链中所有尝试共享的稳定标识。 */
export type RetryId = Branded<'RetryId'>

/**
 * 为一条由实现铸造的重试链标识打上品牌标记。
 * @param id - 不透明的重试标识。
 * @returns 同一个字符串，仅打上品牌标记；不执行任何校验。
 */
export function RetryId(id: string): RetryId {
  return id as RetryId
}
