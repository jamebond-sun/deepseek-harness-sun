/** Session Remote 服务使用的浏览器安全请求、结果与生命周期词汇。 */
import type { NativeFileApplication } from '@deepseek-ai/dsh-native-command/types'

import type {
  AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 为冷 Session 列表摘要持久化的 Host 状态。 */
    sessionListMetadata: SessionListMetadata
    /** 启动期常量图片限制视图的 Host 状态。 */
    imageLimits: null
    /** 已被某次请求使用、仍等待后续请求使用的持久化模型选择。 */
    modelSelection: ModelSelectionProjectionState
  }
  interface SessionProjectionMap {
    /** 用于在不激活 Session 的情况下摘要它的持久化事实。 */
    sessionListMetadata: SessionListMetadata
    /** Session 提示词端点强制执行的图片录入限制。 */
    imageLimits: ImageAttachmentLimits
    /** 已被使用并已为下一次请求选定的持久化模型选择。 */
    modelSelection: ModelSelectionProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 为后续提示词组装请求的完整已验证模型选择。
     * 仅日志记录：从不进入派生的模型历史。
     */
    'model/selection': ModelSelection
  }
}

/** 用于摘要冷 Session 的持久化提示。 */
export interface SessionListMetadata {
  /** 折叠前缀是否不含任何回合。 */
  readonly blank: boolean
  /** 折叠前缀中最新的人工撰写提示词时间。 */
  readonly lastPromptAt: number | null
}

/**
 * Session 列表行携带的每一个可用 wire 值，作为部分且可能过期的提示。
 * `kind` 与 `asOfSeq` 是相互独立的事实：`kind` 说明 `asOfSeq` 属于哪个
 * 序列空间，从而决定客户端可以如何合并该块；`asOfSeq` 是生产方在该
 * 空间中的水位线。
 */
export interface SessionProjectionHints {
  /**
   * `sequenced`：Host 的活跃注册表为已附加的 Session 产出了该块，因此
   * `asOfSeq` 可与同一连接的基线和帧比较。`cached`：仅含 header 的列表
   * 从持久化投影缓存读取了该块，因此 `asOfSeq` 是所存记录自身的
   * 水位线，不得与已连接 Session 的值比较。
   */
  readonly kind: 'cached' | 'sequenced'
  /** 该块在 `kind` 所指序列空间中的水位线。 */
  readonly asOfSeq: number
  /** 块中存在的经提供方验证的值；省略的键仍为未知。 */
  readonly values: SessionProjectionValues
}

/** 精确 Session 事件游标处的完整投影值。 */
export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  /** 经提供方验证的值；省略的键表示此切点缺失该能力。 */
  readonly values: SessionProjectionValues
}

/** 类型化的已知投影，加上在此编译面之外贡献的 JSON 安全值。 */
export type SessionProjectionValues = Partial<SessionProjectionMap>
  & Readonly<Record<string, SessionProjectionValue>>

/**
 * 浏览器提交的提示词内容；Host 将图片字节提升为持久引用。
 * 文件部分携带同一 Session 上前一次 `uploadFile` 调用返回的不透明回执。
 */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }

/** 一个 Session 的完整模型选择。 */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 持久化模型选择的 Host 折叠状态。 */
export interface ModelSelectionProjectionState {
  /** 最近一次已记录模型请求所消费的选择。 */
  readonly lastUsed: ModelSelection | null
  /** 尚未被匹配模型请求消费的后续用户选择。 */
  readonly pending: ModelSelection | null
}

/** 持久化模型选择折叠的客户端视图。 */
export interface ModelSelectionProjection {
  /** 最近一次已记录模型请求所消费的选择。 */
  readonly lastUsed: ModelSelection | null
  /** 下一次请求应使用的选择，回退到 {@link lastUsed}。 */
  readonly next: ModelSelection | null
}

/** 精确模型路由上的一个由适配器拥有的推理力度档位。 */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** 精确模型路由上的可选推理元数据。 */
export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: string
}

/** 在其提供方分组内展示的一个模型。 */
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: ModelReasoning
}

/** 一个提供方及其成功加载的模型目录。 */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
}

/** 模型目录查询失败的一个提供方。 */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Host 生成的模型目录，以及未配置 Session 使用的默认值。 */
export interface ModelCatalog {
  readonly default: ModelSelection
  /** 至少拥有一个当前可用目录模型的提供方路由。 */
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

/** 客户端请求的对一个仍待处理队列项的变更。 */
export type QueueAction =
  | {
    readonly kind: 'edit'
    /** 非空的纯文本替换内容。 */
    readonly content: readonly TextBlock[]
  }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** 一个 Session 列表条目。 */
export interface SessionSummary {
  /** 该 Session 当前是否拥有活跃 Agent。 */
  readonly agentAvailable: boolean
  /** 已附加的 Session 为 current；否则为报告出的持久化格式状态。 */
  readonly formatStatus?: 'current' | 'migration-required'
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: SessionProjectionHints
}

/** 一个 Session 内容搜索结果。 */
export interface SessionSearchItem {
  readonly sessionId: SessionId
  readonly snippet: string
}

/** 一次搜索返回的 Session 数量上限。 */
export const SESSION_SEARCH_RESULT_LIMIT = 20

/** 以 Unicode 码点计的搜索摘录最大长度。 */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'session/provider-credentials-unavailable': Record<string, never>
    'session/provider-models-unavailable': { readonly provider: string }
    'session/model-unavailable': { readonly provider: string; readonly model: string }
    'session/conflict': {
      readonly sessionId: SessionId
      readonly requestedCwd: string
      readonly existingCwd?: string
    }
    'session/projections-unavailable': Record<string, never>
    'session/writer-held': { readonly sessionId: SessionId }
    'session/agent-busy': { readonly reason: string }
    'session/invalid-time-zone': { readonly value: string }
    'session/workspace-attach-failed': { readonly sessionId: SessionId; readonly workspaceId: string }
    'agent-preset/conflict': {
      readonly sessionId: SessionId
      readonly requestedPreset: string
    }
    'session/attachment-invalid': { readonly reason: string }
    'session/queue-item-not-found': { readonly itemId: MessageId }
    'session/steer-unavailable': { readonly itemId: MessageId }
    'session/title-invalid': { readonly sessionId: SessionId }
    'session/fork-unavailable': { readonly sessionId: SessionId }
    'session/migration-required': { readonly sessionId: SessionId }
    'subagent/not-found': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
    }
    'subagent/catalog-diagnostic': {
      readonly parentSessionId: SessionId
      readonly childSessionId: SessionId
      readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    }
  }
}

/** 面向人类可调用技能目录的按 Session 寻址请求。 */
export interface SkillListRequest {
  readonly sessionId: SessionId
}

/** Session 面向人类的输入框可用的一个技能。 */
export interface SkillEntry {
  /** 当由文件系统提供方提供时的绝对 SKILL.md 路径。 */
  readonly path?: string
  /** 以 `/name` 形式引用的 kebab-case 标识符。 */
  readonly name: string
  /** 简短的路由描述。 */
  readonly description: string
  /** 可选的额外路由指引。 */
  readonly whenToUse?: string
  /** 同一技能是否也向模型声明可用。 */
  readonly modelInvocable: boolean
}

/** 通过一个 Session 组合可见的人类可调用技能。 */
export interface SkillListValue {
  readonly skills: readonly SkillEntry[]
}

/** Session 列表请求。 */
export interface SessionListRequest {
  readonly cursor?: string
}

/** Session 列表响应值。 */
export interface SessionListValue {
  readonly items: readonly SessionSummary[]
}

/** Session 搜索请求。 */
export interface SessionSearchRequest {
  readonly query: string
}

/** Session 搜索响应值。 */
export interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[]
  readonly hasMore: boolean
}

/** 为新对话请求一个 Session。 */
export interface SessionCreateRequest {
  /** Session 加入的 Workspace；与 `cwd` 互斥。 */
  readonly workspaceId?: WorkspaceId
  /** 未指定 Workspace 时 Session 拥有的目录。 */
  readonly cwd?: string
  /** 在仍可复用时复用的空白 Session；当该标识下未存储任何 Session 时作为新 Session 的标识。 */
  readonly sessionId?: SessionId
  /** Session 运行的预设，会替换被复用 Session 已记录的预设；省略时使用配置的默认值。 */
  readonly agentPreset?: string
}

/** Session 创建响应值。 */
export interface SessionCreateValue {
  /** 创建或复用的 Session，可能与请求的 `sessionId` 不同。 */
  readonly sessionId: SessionId
  /** Session 运行的预设（当部署组合了预设名册时）。 */
  readonly agentPreset?: string
}

/** Session 模型选择请求。 */
export interface SessionSelectModelRequest extends ModelSelection {
  readonly sessionId: SessionId
}

/** Host 解析后被接受的模型选择。 */
export interface SessionSelectModelValue {
  readonly selected: ModelSelection
}

/** Session 重命名请求。 */
export interface SessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** 规范化后的标题以及提交它的持久化事件位置。 */
export interface SessionRenameValue {
  readonly title: string
  readonly seq: number
}

/** Session 分叉请求。 */
export interface SessionForkRequest {
  readonly sessionId: SessionId
  /** 精确的含端点源事件 seq；省略时选择最新的已完成回合前缀。 */
  readonly atSeq?: number
  /** false 要求 Host 在分叉前检查是否需要迁移。默认为 true。 */
  readonly allowMigration?: boolean
}

/** 新分叉 Session 的标识。 */
export interface SessionForkValue {
  readonly sessionId: SessionId
}

/** Session 提示词请求。 */
export interface SessionPromptRequest {
  /** 客户端生成的标识，持久化在确切被接受的用户消息上。 */
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  /** 至少一个非空白文本部分或附件。 */
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}

/** 一条提示词进入目标 Agent 收件箱后的回执。 */
export interface SessionPromptValue {
  readonly accepted: true
}

/** 持久化图片读取请求。 */
export interface SessionAttachmentRequest {
  readonly sessionId: SessionId
  readonly attachmentId: AttachmentIdType
}

/** 持久化图片读取响应值。 */
export interface SessionAttachmentValue {
  readonly attachment: ImageAttachmentRef
  readonly data: string
}

/** 待处理队列变更请求。 */
export interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId
  readonly itemId: MessageId
  readonly action: QueueAction
}

/** 一个待处理队列变更提交后的回执。 */
export interface SessionUpdateQueueValue {
  readonly accepted: true
}

/** 活动回合取消请求。 */
export interface SessionCancelRequest {
  readonly sessionId: SessionId
}

/** 取消被活跃 Agent 接纳后的回执。 */
export interface SessionCancelValue {
  readonly accepted: true
}

/** 在 Host 桌面上打开一个由感知 Session 的调用方准备好的路径的请求。 */
export interface SessionOpenWorkspacePathRequest {
  /** 请求时在文件管理器中定位；省略时使用默认应用程序。 */
  readonly action?: 'reveal'
  /** 已注册的应用程序标识符；定位时忽略。省略时保留操作系统默认。 */
  readonly application?: string
  /** 尽力完成 Session 工作区解析后的路径，采用 Host 文件系统语法。 */
  readonly path: string
}

/** 确认 Host 已将工作区路径交给其原生打开器。 */
export interface SessionOpenWorkspacePathValue {
  readonly opened: true
}

/** 客户端生成的提示词标识，用于对账乐观消息与持久化消息。 */
export type SessionRequestId = Branded<'session-request-id'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 浏览器提示词关联、可选的 Host 验证时区，以及提交提示词的调用方。
     * `principal` 仅为非拥有者调用方写入，因此缺失 `principal` 即表示拥有者。
     */
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal }
  }
}

/** 选择普通 Session 或一个直接 subagent 子级的持久化标识。 */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  }

/** 一次不激活 Session 的投影读取。 */
export interface SessionProjectionsRequest {
  readonly sessionId: SessionId
}

/** 精确投影携带其事件切点；需要迁移时返回无序列的缓存提示。null 表示不存在。 */
export type SessionProjectionsValue =
  | (SessionProjectionBaseline & { readonly kind: 'sequenced' })
  | { readonly kind: 'migration-required'; readonly values: SessionProjectionValues }
  | null

/** Remote 日志中的一条原始 Session 事件。 */
export interface SessionEventEntry {
  readonly type: 'event'
  readonly event: SessionWireEvent
}

/** 浏览器 wire 上携带的当前逻辑 Session 元数据。 */
export interface SessionWireHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  /** Session 是否包含分叉继承的前缀。 */
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** 浏览器 wire 表面操作；替换端点是表面顺序中更早的事件 seq。 */
export type SessionWireSurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/** 一条历史页记录，事件内嵌紧凑的 Assistant 流。 */
export type SessionHistoryRecord = SessionEventEntry

/**
 * 客户端日志适配器接受的精确 Session 事件信封。
 * 表面事件需要 surfaceOp；仅非 Assistant 表面事件可以引用更早的来源。
 * 持久化读取方负责识别可合并扩展的事件名。
 */
export interface SessionWireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable?: true
  /** 当前表面事件上的更早来源；未知可忽略事件上为不透明 JSON。 */
  readonly sourceEventSeqs?: JsonValue
  /** 当前表面事件上的规范放置；未知可忽略事件上为不透明 JSON。 */
  readonly surfaceOp?: JsonValue
}

/** 一次按消息对齐的向后历史请求。 */
export interface SessionPageRequest {
  readonly address: SessionAddress
  /** 从对应 follow 开场帧获得的含端点日志切点。 */
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
  /** 在满足两个最小值后的一个回合起点处停止，除非 maxMessages 或历史耗尽优先。 */
  readonly turnWindow?: {
    /** 追加来源的用户/assistant 消息最小数量；不得超过 maxMessages。 */
    readonly minMessages: number
    /** 跨过的回合起点最小数量，包括 beforeSeq 处的部分回合。 */
    readonly minTurns: number
  }
}

/** 针对一个持久化 Session 地址的实时事件请求。 */
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
  readonly address: SessionAddress
  /** 为 Web 客户端包含进程本地的 assistant 呈现帧。 */
  readonly assistantStream?: true
}

/** 重连开场快照中的一个活跃 assistant 尝试。 */
export interface SessionAssistantStreamAttempt {
  readonly attemptId: LlmAttemptId
  /** 该尝试开始时观察到的最后持久化 Session seq。 */
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  /** 下一个实时 chunk 帧所期望的稠密位置。 */
  readonly nextIndex: number
  /** 在此开场修订处累积的紧凑分离流。 */
  readonly stream: readonly JsonValue[]
}

/** 一次 follow 开场时的完整进程本地 assistant 状态。 */
export interface SessionAssistantStreamBaseline {
  readonly revision: number
  readonly activeAttempt?: SessionAssistantStreamAttempt
}

/** 进程本地 assistant 帧的浏览器 wire 形式。 */
export type SessionAssistantStreamFrame =
  | {
    readonly type: 'start'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly startedAfterSeq: SessionSeqCursor
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    readonly index: number
    readonly time: number
    readonly chunk: JsonValue
  }
  | {
    readonly type: 'end'
    readonly attemptId: LlmAttemptId
    readonly revision: number
    /** 该终止标记所代表的 chunk 帧数量。 */
    readonly index: number
    readonly outcome:
      | {
        readonly kind: 'committed'
        readonly eventType: 'assistant/message' | 'assistant/attempt'
        readonly seq: number
      }
      | { readonly kind: 'abandoned' }
  }

/** Session 日志的一个连续向后页。 */
export interface SessionPage {
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
}

/** 完整的开场窗口，其后为有序的持久化事件与选择加入的 assistant 帧。 */
export type SessionFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: SessionWireHeader
    readonly cursor: number
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: SessionProjectionBaseline
    readonly assistantStream?: SessionAssistantStreamBaseline
  }
  | SessionEventEntry
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

/** 完整的实时控制基线，每个控制流世代发射一次。 */
export interface SessionControlBaseline {
  readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>
}

/** 一个已完成的投影值及其持久化水位线。 */
export interface SessionProjectionUpdate {
  readonly sessionId: SessionId
  readonly key: string
  readonly value: JsonValue
  readonly seq: number
}

/** Host 范围的实时状态流。每个世代恰好以一个基线开始。 */
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 一个 Session 变为可见，或其 Agent 被创建或释放。
     * 消费方 upsert 该摘要并替换其当前的运行与可用性状态。
     * @mode emit
     * @param summary - 该 Session 当前的列表行。
     */
    'api-session/added'(summary: SessionSummary): void
    /**
     * 一个 Session 离开了活跃 Host 注册表。
     * @mode emit
     * @param sessionId - 被移除的 Session 标识。
     */
    'api-session/removed'(sessionId: SessionId): void
    /**
     * 一个 Agent 改变了运行状态。
     * @mode emit
     * @param sessionId - Agent 与 Session 标识。
     * @param running - Agent 是否正在运行。
     */
    'api-session/status'(sessionId: SessionId, running: boolean): void
    /**
     * 一条用户撰写的持久化消息推进了 Session 列表活动。
     * @mode emit
     * @param sessionId - 被寻址的 Session 标识。
     * @param updatedAt - 用于列表排序的持久化消息时间。
     */
    'api-session/activity'(sessionId: SessionId, updatedAt: number): void
    /**
     * 一个 Agent 在持久化回合位置之外失败。
     * @mode emit
     * @param sessionId - Agent 与 Session 标识。
     * @param message - 对用户安全的失败链。
     */
    'api-session/error'(sessionId: SessionId, message: string): void
  }
}

/** 列表消费方接受的 JSON 兼容投影值。 */
export type SessionProjectionValue = JsonValue

/** 服务桌面为一个文件返回的应用程序元数据。 */
export type SessionWorkspacePathApplication = NativeFileApplication
