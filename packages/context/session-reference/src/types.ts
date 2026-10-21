/**
 * 公开的会话引用请求、候选与准备记录。
 * 导入保持在仅类型子路径上，以便生成的 Remote 客户端无需 Host 运行时代码即可消费本模块。
 * @module @deepseek-ai/dsh-session-reference/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { OptionalSessionSeq, SessionId } from '@deepseek-ai/dsh-session/types'

/** 用于已准备跨会话上下文的、持久的源会话、被引用事件 seq 与快照事实。 */
export interface SessionReferenceSource {
  kind: 'session-reference'
  /** 从另一个会话日志中提取出的素材（`recall` 上下文形式）。 */
  form: 'recall'
  version: 1
  references: {
    sessionId: string
    label: string
    /** 源会话格式代次；缺省即表示版本 0。 */
    capturedFormatVersion?: number
    capturedThroughSeq: OptionalSessionSeq
    compacted: boolean
    originalMessages: number
    retainedMessages: number
    omittedMessages: number
    omittedBytes: number
    truncated: boolean
    inputIndex: number
  }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-reference': SessionReferenceSource
  }
}

/** 由宿主选定的一个源会话。 */
export interface SessionReferenceInput {
  /** 不透明的源会话标识。 */
  sessionId: SessionId
  /** 可选的、面向用户的提及标签。 */
  label?: string
}

/** 来自精确会话元数据、面向宿主的一个候选。 */
export interface SessionReferenceCandidate {
  /** 不透明的源会话标识。 */
  sessionId: SessionId
  /** 最新的、由日志支撑的标题，缺省时回退到不透明的会话 id。 */
  label: string
  /** 展示与规范提及文本，优先采用子代理的持久化创建标签而非 {@link label}。 */
  displayTitle?: string
  /** 源会话的工作目录，记录时存在。 */
  cwd?: string
  /**
   * 当 {@link SessionReferenceCandidate.cwd} 被记录且等于请求方代理的 cwd 时为 true。
   * 仅呈现区分性位置的宿主读取此字段，而非去比较它们从未收到的路径。
   */
  sameWorkspace: boolean
  /** 源会话的创建时间，以 Unix 纪元毫秒计。 */
  createdAt: number
}

/** 携带其规范提示提及的一个发现候选。 */
export interface SessionReferenceMentionCandidate extends SessionReferenceCandidate {
  /** 被序列化进提示草稿的、规范的 `@[label](dsh-session:…)` 提及。 */
  mention: string
}

/** 直接消息内容，以及可选的被引用会话上下文。 */
export interface PreparedReferencedMessage {
  /** 在移除宿主提及标记之后、可读的消息内容。 */
  content: ContentBlock[]
  /** 聚合的、不受信任的快照；当消息没有引用时为缺省。 */
  additionalContext?: UserMessage
}

/** 仅文本的、投影出的对话项。 */
export interface ReferencedConversationItem {
  /** 原始消息角色。 */
  role: 'user' | 'assistant'
  /** 从该消息保留的、可见的文本。 */
  text: string
}
