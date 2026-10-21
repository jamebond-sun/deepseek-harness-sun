/**
 * 客户端安全的递归目录行，以及浏览器端的续跑请求、回执与失败。
 *
 * @module @deepseek-ai/dsh-subagent/control-types
 */

import type { PromptContentPart } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 仅类型：本运行时把 `subagent` 合并进的、Workspace 注册表的归档准入系列映射。
import type {} from '@deepseek-ai/dsh-workspace/types'

/**
 * 由客户端铸造的一条浏览器 prompt 的身份，持久保存在精确被接受的消息上。
 * 它带有 Session Controller 的 `session-request-id` 品牌，使子代理 prompt 与
 * 普通 Session prompt 共用一套身份词汇；那个包依赖本包，因此品牌在此处
 * 拼写而非导入。
 */
export type SubagentPromptRequestId = Branded<'session-request-id'>

/** 递归目录列举所共享的子代理字段。 */
export type SubagentCatalogRow =
  & {
    /** 持久化子 session id，跨多个 Activation 保持稳定。 */
    readonly id: SessionId
    /**
     * 递归目录列举是否观测到一个常驻 Session。这并不编码持久化的结果，
     * 也不保证续跑投递成功。
     */
    readonly activity: 'running' | 'inactive'
  } & (
    | {
      /** 一个终止型一次性子代理。 */
      readonly mode: 'one-shot'
      /** 来自父目录的可选持久化创建标签。 */
      readonly label?: string
    }
    | {
      /** 没有本地子 Session 的外部执行。 */
      readonly mode: 'external'
      /** 来自父目录的可选持久化创建标签。 */
      readonly label?: string
    }
    | {
      /** 一个可恢复的对话。 */
      readonly mode: 'continuable'
      /** 来自父目录的持久化创建标签。 */
      readonly label: string
    }
  )

/**
 * 一条递归目录行。遍历也可能返回针对未知目录模式或不可读子目录的诊断。
 */
export type SubagentListEntry =
  | SubagentCatalogRow & {
    readonly kind: 'child'
    /** 子目录是否包含直接子代理。 */
    readonly hasChildren: boolean
  }
  | {
    readonly kind: 'diagnostic'
    /** 候选者的 session id。 */
    readonly id: SessionId
    /**
     * `corrupt` 表示读取子目录时发现了无效或冲突的 Session 数据；
     * `unavailable` 表示无法读取。二者都会中止该分支。`unsupported`
     * 表示父目录记录了未知的子代理模式；其可读目录仍会被遍历。
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/** 持久化父/子浏览地址；未知模式在读取子历史时被解析。 */
export type SubagentAddress =
  & {
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
  }
  & (
    | { readonly mode: 'one-shot' }
    | { readonly mode: 'continuable' }
    | { readonly mode: 'unknown' }
  )

/** 一个 Agent 收件箱目的地，由 prompt 请求所选定。 */
export type SubagentDelivery = SubagentPromptRequest['delivery']

/** 发给可续跑直接子代理的一条人类消息。 */
export interface SubagentPromptRequest {
  /** 持久保存在被接受消息上的身份，在调用之前铸造。 */
  readonly requestId: SubagentPromptRequestId
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  /** 从浏览器控制地址保留下来的必需判别式。 */
  readonly mode: 'continuable'
  /** 该消息是排队到之后的轮次，还是针对最近的步骤。 */
  readonly delivery: 'queue' | 'steer'
  /**
   * 作为子代理 user message 投递的浏览器 prompt 片段。宿主在投递之前
   * 接纳并持久化图片片段，因此wire 永不会携带调用方可伪造的持久化
   * 附件引用。
   */
  readonly content: readonly PromptContentPart[]
  /** 针对这一条确切人类 prompt 所采样的可选浏览器时区。 */
  readonly clientTimeZone?: string
}

/** 续跑接受一条人类消息后返回的收件箱身份。 */
export interface SubagentPromptReceipt {
  readonly messageId: MessageId
}

/** 一个中断请求被接纳的统一确认。 */
export interface SubagentInterruptReceipt {
  readonly accepted: true
}

/**
 * 控制面所返回的失败详情。prompt 与中断与 Client Remote 结果共享这些失败。
 */
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** 从本 session 委托出的子代理 session（任意深度）正处于轮次之中。 */
    subagent: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 浏览器提供的时区既不是 UTC 也不是规范的 IANA 名称。 */
    'subagent/invalid-time-zone': { readonly value: string }
    /** 没有存活的 Agent 承载所寻址的父 session。 */
    'subagent/parent-unavailable': { readonly parentSessionId: SessionId }
    /** 所寻址的子代理无法接受续跑。 */
    'subagent/not-resumable': { readonly childSessionId: SessionId }
    /** 所声称的父代理并不拥有所寻址的子代理。 */
    'subagent/unauthorized': { readonly childSessionId: SessionId }
    /** 图片接纳或模型图片能力拒绝。 */
    'subagent/attachment-invalid': { readonly reason: string }
    /** 子代理存在，但其收件箱此刻无法接纳该消息。 */
    'subagent/delivery-unavailable': { readonly childSessionId: SessionId }
  }
}
