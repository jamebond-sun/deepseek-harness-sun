import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { RetryId } from './brand.ts'

export type { RetryId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 一次请求尝试失败之后排定的、按提供方路由的重试的持久化非展示记录。 */
    'llm/retry': LlmRetryEventData
    /** 在重试等待成功之后、下一次请求尝试开始之前写入的持久化状态迁移。 */
    'llm/retry-started': LlmRetryStartedEventData
  }
}

/** 在一次按提供方路由的模型请求重试等待之前记录的持久化载荷。 */
export type LlmRetryEventData =
  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'normal'
    policyKey: string
    retry: number
    maxRetries: number
    delayMs: number
    failure: LlmFailure
  }

  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'always'
    policyKey: string
    retry: number
    delayMs: number
    failure: LlmFailure
  }

/** 一次重试延迟结束之后记录的持久化状态迁移。 */
export interface LlmRetryStartedEventData {
  retryId: RetryId
  turn: number
  step: number
  retry: number
}
