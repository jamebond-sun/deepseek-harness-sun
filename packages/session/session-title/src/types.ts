/**
 * 标题领域的纯类型：即 `title` 投影键声明的唯一出处，不含本包主机侧的值
 * 导入（cordis 服务、schemastery、llm 接缝）。两个命名空间投影服务于它——
 * 主机消费方用 `./types`，客户端聚合用 `./client/types`——且零内容重复。
 *
 * @module @deepseek-ai/dsh-session-title/types
 */

export {}

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { OptionalSessionSeq, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** 标识一次会话标题提供方注册。 */
export type SessionTitleProviderId = Branded<'SessionTitleProviderId'>

/** 产生某个标题的、确切的辅助模型路由。 */
export interface SessionTitleModelIdentity {
  /** 已注册的 LLM 提供方路由。 */
  readonly provider: string
  /** 提供方模型 id。 */
  readonly model: string
}

/** 一个被接受的会话标题的、持久的所有权记录。 */
export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | {
    readonly kind: 'provider'
    readonly provider: SessionTitleProviderId
    readonly model?: SessionTitleModelIdentity
  }
  | {
    /** 显式的用户重命名：固定该标题——自动生成停止排程。 */
    readonly kind: 'user'
  }

/** 仅日志的 `session/title` 事件的载荷。 */
export interface SessionTitleEventData {
  /** 已归一化的非空标题文本。 */
  readonly title: string
  /** 用于推导本标题的、确切的人类 `user/message` seq；显式用户重命名时为空。 */
  readonly messageSeqs: SessionSeq[]
  /** 标题是由内置回退、已注册提供方，还是用户提供的。 */
  readonly source: SessionTitleSource
}

/** 最新的已折叠标题，加上该标题事件持久的信封事实。 */
export interface SessionTitleSnapshot extends SessionTitleEventData {
  /** 最新的 `session/title` 事件的 seq。 */
  readonly eventSeq: SessionSeq
  /** 最新的 `session/title` 事件的时间戳。 */
  readonly updatedAt: number
}

/** 主机标题投影值。 */
export type TitleProjection = SessionTitleSnapshot

/** 暴露给标题提供方的、一条合格的人类文本消息。 */
export interface SessionTitleUserMessage {
  /** 源 `user/message` 事件的 seq。 */
  readonly seq: SessionSeq
  /** 确切的、拼接后的文本块内容。 */
  readonly text: string
}

/** 作为有界聚合存储的、合格的标题输入。 */
export interface TitleInputState {
  /** 最旧的合格消息，在任何消息之前为 null。 */
  readonly first: SessionTitleUserMessage | null
  /** 到目前为止折叠的合格消息总数。 */
  readonly count: number
  /** 最新合格消息的 seq，在任何消息之前为 null。 */
  readonly lastSeq: OptionalSessionSeq
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最新的已记录标题文本，或 null。 */
    title: string | null
    /** 合格的人类标题输入。 */
    titleInput: TitleInputState
  }
  interface SessionProjectionMap {
    /**
     * 会话当前的归一化标题——即最新的 `session/title` 事件的文本
     * （最新者胜），或在第一个标题落地之前为 `null`。一个纯字符串：
     * 客户端列表行所消费的形状。
     */
    title: string | null
  }
}
