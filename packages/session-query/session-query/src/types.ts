/**
 * 面向 live 优先的逻辑会话语料，用于精确读取与关系追踪的公共记录。
 *
 * @module @deepseek-ai/dsh-session-query/types
 */

import type {
  SessionEvent,
  SessionEventType,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  OptionalSessionSeq,
  SurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type { SessionSearchCursor } from './cursor.ts'

export type { SessionSearchCursor } from './cursor.ts'

/** 事件属于当前模型上下文、已被替换的上下文，还是仅存在于原始日志中。 */
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'

/** 一个逻辑会话的轻量标识与源可用性。 */
export interface SessionRecord {
  /** 从 live 优先语料中选出的克隆会话头部。 */
  header: SessionHeader
  /** 该 id 当前是否存在于 `ctx.sessions`。 */
  live: boolean
  /** 当前活动的持久化后端是否列出该 id，包括它已观察到的、已创建但尚未物化的会话。 */
  persisted: boolean
  /** live Session 为 current；否则为持久化报告的格式状态。 */
  formatStatus?: 'current' | 'migration-required'
}

/** 对会话当前模型 surface 的一次原子的、live 优先的观察。 */
export interface SessionSurfaceSnapshot {
  /** 与 `events` 来自同一次语料观察的克隆会话头部。 */
  session: SessionHeader
  /** 被观察日志中 fork 继承事件的精确数量。 */
  inheritedEventCount: SessionLogOffset
  /** 该观察包含的最高原始日志 seq；空日志为 `null`。 */
  capturedThroughSeq: OptionalSessionSeq
  /** 按模型历史顺序排列的、克隆的当前 surface 事件。 */
  events: SurfaceEvent[]
}

/** 对逻辑会话完整原始日志的一次经过校验的分离观察。 */
export interface SessionLogSnapshot {
  /** 与 `events` 来自同一次观察的克隆会话头部。 */
  session: SessionHeader
  /** 被观察日志中 fork 继承事件的精确数量。 */
  inheritedEventCount: SessionLogOffset
  /** 经过内存中断回合平衡与重放校验后克隆出的连续原始事件。 */
  events: SessionEvent[]
}

/** 逻辑会话中一个事件的轻量元数据。 */
export interface SessionEventRecord {
  /** 拥有该事件的会话。 */
  sessionId: SessionId
  /** 会话内单调的事件 seq。 */
  seq: SessionSeq
  /** 会话事件的判别标签。 */
  type: SessionEventType
  /** 事件时间戳，Unix 纪元毫秒。 */
  time: number
  /** 事件在折叠后的会话 surface 中的位置。 */
  surface: SessionEventSurface
}

/** 会话谱系追踪中的递归后代节点。 */
export interface SessionLineageNode {
  /** 该后代对应的分离逻辑语料记录。 */
  session: SessionRecord
  /** 直接子节点，各自携带自己的递归后代。 */
  descendants: SessionLineageNode[]
}

/** 一个逻辑会话的已知祖先与后代。 */
export type SessionLineageTrace = {
  /** 被追踪会话对应的分离记录。 */
  target: SessionRecord
  /** 自直接父会话向外的已知父辈。 */
  ancestors: SessionRecord[]
  /** 以目标的直接子节点为根的完整已知后代树。 */
  descendants: SessionLineageNode[]
} & (
  | {
    /** 完整的父链都存在于逻辑语料中。 */
    complete: true
    /** 完整谱系顶端的分离记录。 */
    root: SessionRecord
  }
  | {
    /** 父链离开了可见的逻辑语料。 */
    complete: false
    /** 第一个不在逻辑语料中的父 id。 */
    unresolvedParentId: SessionId
  }
)

/** 请求获取某个事件周围直接的 surface 替换关系与到被引用源事件的关系。 */
export interface SessionEventTraceRequest {
  /** 拥有目标事件的会话。 */
  sessionId: SessionId
  /** 目标事件 seq。 */
  seq: SessionSeq
}

/** 某个事件直接的 surface 替换关系，以及到被引用源事件的关系。 */
export interface SessionEventTrace {
  /** 目标的轻量记录。 */
  target: SessionEventRecord
  /** 当目标被遮蔽时，直接按位置替换它的事件。 */
  replacedBy?: SessionSeq
  /** 从直接替换者到最终替换者的按位置替换链。 */
  replacementChain: SessionSeq[]
  /** 当目标自身执行了替换时被直接移除的 surface 节点。 */
  replacedEventSeqs: SessionSeq[]
  /** 按其记录顺序直接作为来源被引用的更早事件。 */
  sourceEventSeqs: SessionSeq[]
  /** 按日志顺序直接把目标作为来源引用的更晚事件。 */
  derivedEventSeqs: SessionSeq[]
}

/** 绑定到同一次会话头部观察的事件关系。 */
export interface SessionEventTraceObservation extends SessionEventTrace {
  /** 与追踪所用事件日志一同选出的克隆头部。 */
  session: SessionHeader
}

/** 请求获取一个事件及其原始邻近日志上下文。 */
export interface SessionEventReadRequest {
  /** 拥有目标事件的会话。 */
  sessionId: SessionId
  /** 目标事件 seq。 */
  seq: SessionSeq
  /** 要包含的前置原始事件数量。 */
  before?: number
  /** 要包含的后置原始事件数量。 */
  after?: number
}

/** 完整目标事件与一个有界的原始日志窗口。 */
export interface SessionEventWindow {
  /** live 优先源读取所对应的克隆头部。 */
  session: SessionHeader
  /** 被观察日志中 fork 继承事件的精确数量。 */
  inheritedEventCount: SessionLogOffset
  /** 完整克隆的目标事件。 */
  target: SessionEvent
  /** 从 `startSeq` 到 `endSeq` 的完整克隆事件。 */
  events: SessionEvent[]
  /** `events` 中包含的第一个 seq。 */
  startSeq: SessionSeq
  /** `events` 中包含的最后一个 seq。 */
  endSeq: SessionSeq
}

/** 绑定到同一次会话头部观察的最新折叠标题。 */
export interface SessionTitleObservation {
  /** 与标题折叠所用事件日志一同选出的克隆头部。 */
  session: SessionHeader
  /** 最新标题快照；被观察日志没有标题时不存在。 */
  title?: SessionTitleSnapshot
}

/** 批量标题观察中的一个有序结果。 */
export type SessionTitleObservationResult =
  | {
    /** 被请求的会话 id。 */
    sessionId: SessionId
    /** 成功完成的原子头部/标题观察。 */
    status: 'fulfilled'
    /** 来自同一个逻辑源的头部与可选的最新标题。 */
    value: SessionTitleObservation
  }
  | {
    /** 被请求的会话 id。 */
    sessionId: SessionId
    /** 隔离到该会话的操作性失败。 */
    status: 'rejected'
    /** 来自逻辑源解析或标题折叠的原始失败。 */
    reason: unknown
  }

/** 时间与序号过滤器使用的闭区间数值区间。 */
export interface SessionResultRange {
  /** 闭区间下界。 */
  from?: number
  /** 闭区间上界。 */
  to?: number
}

/** 逻辑会话过滤器所理解的源可用性谓词。 */
export type SessionAvailability = 'live' | 'persisted'

/**
 * 一个逻辑会话谓词。过滤器数组按 AND 组合；子句内的 `values` 按 OR 组合。
 */
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }

/**
 * 一个事件谓词。过滤器数组按 AND 组合；取值为列表的子句按 OR 组合。
 * 文本子句是一次字面量、大小写不敏感且对空白宽松的语义文本扫描。
 */
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }

/** 全文提供方可以在相关性排序之前应用的事件谓词。 */
export type SessionEventMetadataFilter = Exclude<SessionEventResultFilter, { kind: 'text' }>

/** 由一个会话事件派生出的可搜索语义文档。 */
export interface SessionEventSearchDocument extends SessionEventRecord {
  /** 供扫描过滤器与全文索引使用的第一方语义文本。 */
  text: string
}

/** 一个游标分页的结果页。 */
export interface SessionSearchPage<T> {
  /** 按契约定义顺序排列的本页结果。 */
  items: readonly T[]
  /** 不透明的续接游标；最后一页不存在。 */
  nextCursor?: SessionSearchCursor
}

/** 绑定到已索引的目标会话观察的事件搜索结果。 */
export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** 与 `items` 来自同一个已索引代次的克隆目标头部。 */
  session: SessionHeader
}

/** 跨会话与会话内搜索调用共用的控制项。 */
export interface SessionSearchExecContext {
  /** 中止调用方等待，并在支持时中断提供方的工作。 */
  signal?: AbortSignal
}

/** 跨会话全文搜索请求。 */
export interface SessionSearchRequest {
  /** 全文查询，作为数据处理，绝不是可执行的 FTS 语法。 */
  query: string
  /** 在事件排序之前应用的逻辑会话谓词。 */
  sessionFilters?: readonly SessionResultFilter[]
  /** 在事件排序之前应用的事件谓词。 */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** 本页会话数上限。 */
  limit?: number
  /** 针对同一个归一化请求返回的不透明游标。 */
  cursor?: SessionSearchCursor
}

/** 会话内全文搜索请求。 */
export interface SessionEventSearchRequest {
  /** 被搜索其 live 优先逻辑日志的会话。 */
  sessionId: SessionId
  /** 全文查询，作为数据处理，绝不是可执行的 FTS 语法。 */
  query: string
  /** 在排序之前应用的事件谓词。 */
  filters?: readonly SessionEventMetadataFilter[]
  /** 本页事件数上限。 */
  limit?: number
  /** 针对同一个归一化请求返回的不透明游标。 */
  cursor?: SessionSearchCursor
}

/** 一个事件全文搜索命中，附带一段有界的纯文本摘录。 */
export interface SessionEventSearchHit extends SessionEventRecord {
  /** 围绕匹配位置选取的纯文本摘录。 */
  snippet: string
}

/** 一个分组后的跨会话命中，按其最强匹配事件排序。 */
export interface SessionSearchHit extends SessionRecord {
  /** 该会话中匹配度最高的事件。 */
  bestMatch: SessionEventSearchHit
}
