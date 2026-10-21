/**
 * 会话级反馈的公开词汇表：固定的分类体系、`feedback/record` 事件载荷，
 * 以及 `sessionFeedback.record` Remote 的请求与结果类型。本模块仅含类型；
 * 运行时分类元组由包入口导出，而浏览器插件只导入类型，因为其产物
 * 不得携带 Host 值。
 * @module @deepseek-ai/dsh-command-feedback/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 固定反馈分类之一；这些 id 是持久的日志词汇。 */
export type FeedbackCategory =
  | 'task-result'
  | 'instruction-following'
  | 'product-interaction'
  | 'service-stability'
  | 'resource-cost'
  | 'security-privacy-permission'
  | 'other'

/**
 * 一条已记录的、关于某个会话的用户意见。两个成员均为可选：两者都缺省的提交
 * 依然记录了用户请求复核该会话这一事实，而正是它授权了日志投递。
 */
export interface FeedbackRecord {
  /** 已去除首尾空白的自由文本意见；存在时必不为空。 */
  readonly text?: string
  /** 用户归档该意见时选择的分类。 */
  readonly category?: FeedbackCategory
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 一条已记录的关于本会话的用户意见。仅记日志且与触发方式无关；
     * 它永不进入模型上下文或派生历史。
     */
    'feedback/record': FeedbackRecord
  }
}

/** 通过 Host Remote 记录一条会话级意见。 */
export interface SessionFeedbackRecordRequest {
  /** 意见所描述的实时会话。 */
  readonly sessionId: SessionId
  /** 自由文本意见；空白文本按缺省记录。 */
  readonly text?: string
  /** 用户归档该意见时选择的分类。 */
  readonly category?: FeedbackCategory
}

/** 已记录意见的稳定后置条件。 */
export interface SessionFeedbackRecordValue {
  /** 该意见已追加到会话日志；落盘遵循会话自身的调度。 */
  readonly recorded: true
}

/** 没有实时会话持有请求的 id。 */
export interface SessionFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}

/** `sessionFeedback.record` 操作返回的结果。 */
export type SessionFeedbackRecordResult =
  | { readonly ok: true; readonly value: SessionFeedbackRecordValue }
  | { readonly ok: false; readonly error: SessionFeedbackSessionNotFound }
