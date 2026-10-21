/**
 * 逐条消息反馈的公开请求、结果与失败词汇表。
 * 本模块仅含类型，以便生成的 Remote 客户端无需导入 Host 运行时代码即可使用。
 * @module @deepseek-ai/dsh-message-feedback/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'

/** 某个精确反馈条目修订的不透明比较并交换令牌。 */
export type MessageFeedbackVersion = Branded<'MessageFeedbackVersion'>

/** 用户对单条 assistant 消息的总体评价。 */
export type MessageFeedbackRating = 'positive' | 'negative'

/** 一个当前反馈值及其不透明变更令牌。 */
export interface MessageFeedbackItem {
  /** 该 assistant 消息在其所属会话内的稳定标识。 */
  readonly messageId: MessageId
  /** 总体的正向或负向评价。 */
  readonly rating: MessageFeedbackRating
  /** 可选说明，校验通过后原样保留。 */
  readonly note?: string
  /** 用户归档该评价时选择的分类。 */
  readonly category?: FeedbackCategory
  /** 仅供比较的令牌，任何实质性创建或更新都会将其替换。 */
  readonly version: MessageFeedbackVersion
  /** Host 分配的创建时间，Unix 纪元毫秒。 */
  readonly createdAt: number
  /** Host 分配的最近一次实质更新时间。 */
  readonly updatedAt: number
}

/** 一次实质性创建或编辑，保留其完整的当前值。 */
export interface MessageFeedbackPut {
  /** 所属会话；派生会话中继承而来的反馈归属于其父会话。 */
  readonly sessionId: SessionId
  /** 本次变更后的值，包含原始创建时间。 */
  readonly item: MessageFeedbackItem
}

/** 对某个当前反馈条目的一次实质性删除。 */
export interface MessageFeedbackDelete {
  /** 拥有被删除反馈的会话。 */
  readonly sessionId: SessionId
  /** 被移除反馈所属的消息。 */
  readonly messageId: MessageId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 仅记日志的用户反馈；永不进入模型历史。 */
    'feedback/message-put': MessageFeedbackPut
    /** 仅记日志的删除；此前的评价与说明仍留在日志中。 */
    'feedback/message-delete': MessageFeedbackDelete
  }
}

/** 读取属于某个已持久化会话生命周期的全部消息反馈。 */
export interface MessageFeedbackListRequest {
  /** 需读取其反馈事件的会话。 */
  readonly sessionId: SessionId
}

/** 某个会话的当前反馈值，按首次创建顺序排列。 */
export interface MessageFeedbackListValue {
  /** 全新的不可变条目快照。 */
  readonly items: readonly MessageFeedbackItem[]
}

/** 为单条 assistant 消息创建或替换反馈。 */
export interface MessageFeedbackPutRequest {
  /** 拥有目标消息的已持久化会话。 */
  readonly sessionId: SessionId
  /** 目标 assistant 消息的标识。 */
  readonly messageId: MessageId
  /** 期望的总体评价。 */
  readonly rating: MessageFeedbackRating
  /** 可选的非空白说明。 */
  readonly note?: string
  /** 可选分类；缺省时该条目保持未分类。 */
  readonly category?: FeedbackCategory
  /** 观察到的条目版本；`null` 表示要求该条目不存在。 */
  readonly ifVersion: MessageFeedbackVersion | null
}

/** 观察到当前版本后删除某条消息的反馈。 */
export interface MessageFeedbackDeleteRequest {
  /** 拥有该反馈的会话。 */
  readonly sessionId: SessionId
  /** 操作完成后应无反馈的消息。 */
  readonly messageId: MessageId
  /** 观察到的条目版本；条目本就缺失时忽略。 */
  readonly ifVersion: MessageFeedbackVersion
}

/** 幂等的删除回执。 */
export interface MessageFeedbackDeleteValue {
  /** 首次删除与每次重试共享的稳定后置条件。 */
  readonly absent: true
}

/** 请求的 id 不存在已持久化的会话头。 */
export interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}

/** 该 id 未指向一条派生自追加来源的 assistant 消息。 */
export interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}

/** 一次实质性变更与被操作条目的当前版本不匹配。 */
export interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** 权威的当前条目；不存在时为 `null`。 */
  readonly current: MessageFeedbackItem | null
}

/** 提供的说明不含任何非空白字符。 */
export interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}

/** 提供的说明超出配置的 UTF-8 字节上限。 */
export interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}

/** 公开的消息反馈操作共有的失败。 */
export type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge

/** 成功的公开操作结果。 */
export interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** 被拒绝的公开操作结果，附带稳定的业务失败。 */
export interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}

/** 消息反馈 `list` 操作返回的结果。 */
export type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>

/** 消息反馈 `put` 操作返回的结果。 */
export type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >

/** 消息反馈 `delete` 操作返回的结果。 */
export type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>
