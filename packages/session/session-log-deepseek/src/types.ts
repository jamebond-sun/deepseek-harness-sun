/** 用于无损增量式 DeepSeek 会话日志上传的线上类型。 */

import type { SessionEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 在外部请求线上以原始 JSON 原语形式序列化的会话头部字段。 */
export interface DeepSeekSessionLogWireHeader {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  /** 精确的继承前缀长度；对于未播种的会话则不存在。 */
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** 在外部请求线上序列化的、原始数值形式的 surface 变更。 */
export type DeepSeekSessionLogWireSurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/**
 * 为上传而转换为原始 JSON 原语的一个规范事件。Surface 事件需要携带一个
 * 操作；system、user 与 tool 事件可以引用来源。Assistant 提供方的元数据
 * 内嵌在其 data 中；仅日志事件既不携带操作也不携带来源。
 */
export type DeepSeekSessionLogWireEvent = {
  [K in SessionEvent['type']]: {
    readonly type: K
    readonly seq: number
    readonly time: number
    readonly data: JsonValue
    readonly ignorable?: true
  } & (K extends SurfaceEventType ? {
    readonly surfaceOp: DeepSeekSessionLogWireSurfaceOp
  } & (K extends 'assistant/message' ? {
    readonly sourceEventSeqs?: never
  } : {
    readonly sourceEventSeqs?: readonly number[]
  }) : {
    readonly surfaceOp?: never
    readonly sourceEventSeqs?: never
  })
}[SessionEvent['type']] | {
  /** 无法识别的可忽略记录保留其不透明元数据，但不具备 surface 语义。 */
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable: true
  readonly surfaceOp?: JsonValue
  readonly sourceEventSeqs?: JsonValue
}

/** 由官方 DeepSeek 请求携带的、带版本的增量会话日志字段。 */
export interface DeepSeekSessionLogExtension {
  readonly version: 1
  /** 该后缀所代表的会话格式代际。 */
  readonly sessionFormatVersion: number
  readonly session: DeepSeekSessionLogWireHeader
  /** 本次请求之前已被持久记录为已接受的最高序号，或 `-1`。 */
  readonly afterSeq: number
  /** 由 {@link events} 所代表的最高序号。 */
  readonly throughSeq: number
  /** 从 `afterSeq + 1` 到 `throughSeq` 的每个序号对应的完整规范事件信封。 */
  readonly events: readonly DeepSeekSessionLogWireEvent[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_session_log: DeepSeekSessionLogExtension
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 记录配置的端点已通过 `throughSeq` 接受的一次投递。 */
    'session-log-deepseek/delivery-accepted': {
      /** 被接受的投递所携带的会话身份；继承得到的 fork 标记保留父会话的 id。 */
      sessionId: import('@deepseek-ai/dsh-session/types').SessionId
      /** 被接受的会话格式代际；缺失则标识为版本 0。 */
      sessionFormatVersion?: number
      /** 被接受的请求中包含的最后一个规范事件。 */
      throughSeq: import('@deepseek-ai/dsh-session/types').SessionSeq
    }
  }
}
