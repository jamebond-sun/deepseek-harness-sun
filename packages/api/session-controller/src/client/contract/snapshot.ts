/** Session 持有的可观察状态，不含 Conversation 目标数据。 */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '../../types.ts'

/** 本地提交回显在持久化接纳前展示的一张图片。 */
export interface PendingSubmissionImage {
  /** 浏览器持有的预览 URL；其生命周期属于提交方，绝不属于本快照。 */
  readonly previewUrl: string
  /** 浏览器文件名（当文件有名字时）。 */
  readonly name?: string
  /** 固有像素宽度（当提交方已探测到时）。 */
  readonly width?: number
  /** 固有像素高度（当提交方已探测到时）。 */
  readonly height?: number
}

/** 本地提交回显附件的图片分支。 */
export interface PendingSubmissionImageAttachment {
  readonly type: 'image'
  readonly value: PendingSubmissionImage
}

/** 本地提交回显附件的文件分支。 */
export interface PendingSubmissionFileAttachment {
  readonly type: 'file'
  readonly value: FileAttachmentRef
}

/** 本地提交回显展示的一个附件，按提示词顺序排列。 */
export type PendingSubmissionAttachment =
  | PendingSubmissionImageAttachment
  | PendingSubmissionFileAttachment

/** 本地提交开始时选定的 Client 展示面。 */
export type PendingSubmissionPlacement = 'transcript' | 'queued' | 'steering'

/**
 * 一条本地提示词提交回显：提交开始时同步插入，使会话能在序列化、
 * 传输与持久化接纳完成前显示消息。仅存于 Client 内存 —— 重载与
 * 重连都只依据持久化事件重建会话。
 */
export interface PendingSubmission {
  /** 提示词 RPC 身份；持久化 `user/message` 源会以 `rpcId` 回显它。 */
  readonly requestId: SessionRequestId
  /** 提交时固定的展示面；Inbox 接纳不会把 Chat 回显移入 dock。 */
  readonly placement: PendingSubmissionPlacement
  /** 提交开始时的 Client 墙钟毫秒数。 */
  readonly time: number
  /** 与实际发送完全一致的提示词文本（单个文本块）。 */
  readonly text: string
  /** 与提示词附件匹配的有序图片预览与持久化文件元数据。 */
  readonly attachments: readonly PendingSubmissionAttachment[]
}

/** Session 事件窗口的历史打开生命周期。 */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/** Session 消费方呈现的发送/停止失败。 */
export interface PromptError {
  readonly op: 'send' | 'stop'
  readonly error: RemoteFailure
}

/** 不可变的 Session 生命周期与控制快照。 */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  /** 尚未观察到对应持久化事件或队列出现的本地提示词提交回显。 */
  readonly pendingSubmissions: readonly PendingSubmission[]
  readonly running: boolean
  readonly subagent: {
    readonly address: SubagentAddress
    /** 在直接父级目录解析完成前缺失。 */
    readonly parentAvailable?: boolean
  } | null
  readonly removed: boolean
  readonly openState: OpenState
  readonly openError: RemoteFailure | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly promptError: PromptError | null
  readonly blank: boolean
  readonly lastAgentError: string | null
  /** 此 Client Session 对象上已发起过一次提示词调用。 */
  readonly promptAttempted: boolean
  /** 首个被接纳的提示词尚未到达持久化 `turn/start` 事件。 */
  readonly awaitingFirstTurn: boolean
}
