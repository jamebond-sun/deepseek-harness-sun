import { brandNumber, brandString, type Branded, type BrandedNumber } from '@deepseek-ai/dsh-brand'
import type {
  AssistantMessage,
  DeveloperMessage,
  AssistantStreamRecord,
  ToolCallId,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmFailure,
  SystemMessage,
  SystemPromptUpdate,
  TokenUsage,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 标识存储中的一个 session（及其持久化产物）。 */
export type SessionId = Branded<'SessionId'>

/**
 * 将字符串标记为 {@link SessionId}。
 * @param id - 原始 session id 字符串。
 * @returns 附带 session-id 品牌的同一字符串。
 */
export function SessionId(id: string): SessionId {
  return brandString<SessionId>(id)
}

/** Session 日志中一个已存在事件的序号。 */
export type SessionSeq = BrandedNumber<'SessionSeq'>

/**
 * 将数值接受为已存在的 Session 事件位置。
 * @param value - 由所属日志操作接受的非负安全整数。
 * @returns 附带 Session-sequence 品牌的同一数值。
 */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionSeq>(value)
}

/** Session 日志间隙、前缀长度或读取偏移，可以等于事件总数。 */
export type SessionLogOffset = BrandedNumber<'SessionLogOffset'>

/**
 * 将数值接受为 Session 日志偏移。
 * @param value - 用作间隙或前缀长度的非负安全整数。
 * @returns 附带 Session-log-offset 品牌的同一数值。
 */
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionLogOffset>(value)
}

/** 含端点的 Session 事件水位线，任何事件存在之前为 `-1`。 */
export type SessionSeqCursor = SessionSeq | -1

/** 一个已存在的 Session 事件位置，或显式缺失。 */
export type OptionalSessionSeq = SessionSeq | null

/**
 * 当前逻辑 Session 格式版本，盖入每个新写入的 {@link SessionHeader}。当前
 * Session 与持久化代码只接受该值；仅读 header 的读取方对受支持的历史格式做
 * 分类，而事件体读取会组接构建期固定的相邻迁移链，并在构造 Session 前只发布
 * 这一代最终格式。
 *
 * 版本是单个单调递增整数，不分 major/minor。满足以下条件时保留该版本：旧读
 * 取方能正确恢复、能安全保留可忽略记录，或在执行、变更、尾部修复前拒绝所需
 * 特性。新读取方必须保留历史语义，包括新旧记录表示混存的日志。仅当现有
 * discriminator 无法阻止不安全的解读时才升版本；仅有结构差异并不足够。未知
 * 字段与取值需要已发布读取方实际接受行为的证据。逐事件的
 * {@link SessionEvent.ignorable} 标记管辖未知事件类型，而非任意的嵌套载荷变
 * 更。同版本读取方保留更早的表示：存储版本与当前版本一致时相邻迁移链不运行。
 * 后续迁移必须覆盖其来源的全部受支持表示。兼容性评审及保留的迁移义务记录在
 * `.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md`。
 */
export const SESSION_FORMAT_VERSION = 4

/**
 * 不可变且经验证的存储元数据，保存在会话事件日志之外。
 */
export interface SessionHeader {
  /**
   * 当前逻辑格式版本，取自 {@link SESSION_FORMAT_VERSION}。
   * 历史物理 header 在进入此接口前先做转换。
   */
  readonly version: typeof SESSION_FORMAT_VERSION
  /** 该 session 的 id（与 {@link Session} 的 id 一致）。 */
  readonly id: SessionId
  /** session 创建时间的非负安全整数 Unix 纪元毫秒。 */
  readonly createdAt: number
  /** 创建 session 时所在的工作目录绝对路径（如有）。 */
  readonly cwd?: string
  /** 本 session 由其分叉而来的 session（seed 谱系），如有。 */
  readonly parentSession?: SessionId
  /**
   * 本 Session 是否包含分叉继承的事件前缀。确切的前缀长度是 Session 状态，
   * 而非普通 header 元数据。
   */
  readonly isSeeded: boolean
  /**
   * 作为 subagent 子级创建的 session 的粗粒度产品分类。
   * 这是展示元数据，不能证明该子级可以继续。
   */
  readonly origin?: 'subagent'
  /**
   * 委派深度：顶层 session 缺省（为零），subagent 子级为父级深度 + 1。持久化
   * 它使递归预算在重启与恢复后仍然有效——仅存于运行时的深度会把恢复的子级
   * 重置为顶层。
   */
  readonly delegationDepth?: number
  /**
   * 部署按 session 组合时，本 session 的 agent 由哪个 agent preset 组合而来的
   * id。持久化它是因为 preset 决定 session 的工具与提示词：恢复到不同组合的
   * 话，回放的历史将是模型无法再执行的。
   */
  readonly agentPreset?: string
}

/**
 * 通过存储创建 {@link Session} 的选项。`seed` 回放/分叉一个既有事件日志；
 * `meta` 携带调用方提供的存储字段，由存储折叠进 {@link SessionHeader}。
 */
export interface CreateSessionOptions {
  /** 构造时提供的初始回放或分叉历史。 */
  readonly seed?: readonly SessionEvent[]
  /**
   * `meta.isSeeded` 为 true 时的确切分叉继承前缀长度。构造器会在切点处追
   * 加子级自有的带标记 marker，除非 seed 已包含它且其后是子级自有的分叉收
   * 尾事件。
   */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * 发布前读取一次的存储元数据。`isSeeded` 标记分叉谱系；仅提供回放历史
   * 并不使其成为继承历史。
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}

/**
 * 可采纳 Session seed 的别名状态。`shared-frozen` 允许同一 seed 中同时存在深
 * 冻结的别名与独立持有的未冻结值。
 */
export type SessionSeedEventState = 'detached' | 'shared-frozen'

/**
 * 转移给 {@link SessionStore.prepare} 的可采纳存储值，无需再复制或冻结。
 */
export interface RestoredSessionOptions {
  /** 独立持有或已深度冻结的事件。 */
  readonly seed: SessionEvent[]
  /** 独立持有的存储元数据，将就地验证并冻结。 */
  readonly meta: SessionHeader
  /** 从存储解码出的分叉继承前导事件的确切数量。 */
  readonly inheritedEventCount: SessionLogOffset
  /** 由产生 seed 的操作所携带的别名状态。 */
  readonly eventState: SessionSeedEventState
}

/** 构造未发布 Session 时接受的输入。 */
export type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly eventState?: undefined })
  | RestoredSessionOptions

/** 活跃 agent driver 被取消的原因。 */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** 持久化的取消原因，包括原始粗粒度记录未带原因的导入。 */
export type TurnEndCancelCause = AgentCancelCause | { readonly kind: 'legacy' }

/**
 * turn 结束的原因。可合并扩展的 sum 类型。
 */
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** 取消请求中断了进行中的 turn。 */
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }

  blocked: { kind: 'blocked' }
  /**
   * turn 失败。`error` 始终是结构化失败：原样保留 `LlmError` 的事实，或将任
   * 何其他错误摊平为 `{ message: errorChain(error), code: 'UNKNOWN' }`。
   */
  error: { kind: 'error'; error: LlmFailure }
  /** 至少一个 step 达到了输出 token 上限，即使插件继续了该 turn。 */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * 因崩溃而孤立的 turn 在事后被关闭：agent-loop 恢复为最后一个 turn 未结束
   * 的存储日志追加此收尾事件，session-query 在冷读取时合成它。循环从不在运
   * 行中发出此标记，崩溃前记录的事件保持原样。
   */
  interrupted: { kind: 'interrupted' }
  /**
   * 分叉 seed 构造关闭了源 session 中在分叉切点处仍处于打开状态的 turn。只有
   * 分叉 seed 携带此标记——循环从不发出它——且切点之前的源事件在子级中保持
   * 原样。
   */
  forked: { kind: 'forked' }
}

/** {@link TurnEndReasonMap} 的联合——turn 结束的原因；插件通过向该 map 合并变体来扩展它。 */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * 派生历史之外的已记录请求状态：调用配置与工具。系统提示词属于派生历史——
 * surface 节点 0，一个 `system/message` 事件。最新完整的 `request/header`
 * 快照重建该 header；规范的空可选字段不存在。
 */
export interface EpochHeader {
  /** 会话的调用配置（provider、model、推理努力度与采样标量）。 */
  config: LlmCallConfig
  /** 由确切 adapter 物化而非调用方提议的生效配置字段。 */
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** 组装好的工具 schema；无工具请求时不存在。 */
  tools?: ToolSchema[]
  /** 已废弃的请求文本；系统提示词属于 system/message 事件。
   * @persistenceReserved
   */
  system?: never
}

/** 一个已解析模型路由的注册期绑定元数据。 */
export interface RequestContext {
  /** 该元数据所属的已注册 provider 路由。 */
  provider: string
  /** 该元数据所属的 provider 侧 model id。 */
  model: string
  /** 提供方声明时的请求与响应合计上下文 token 上限。 */
  contextWindow?: number
  /** 路由把任意位置的最新 `system` 消息读作生效系统提示词时为 `'in-history'`。 */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * 追加 `request/header` 快照的原因：`'initial'`——日志的第一个 header（新会
 * 话）；`'resume'`——循环实例对已含 header 事件的日志发起的第一个请求（进程
 * 重启、分叉 seed）；`'change'`——后续请求使用了不同的 header；`'series'`——
 * 未变化的 header 开启了显式区分的消息序列，或出现在 surface 替换之后。出现
 * 新序列且与其他原因重合时，其他原因也携带 `startsSeries`。
 */
export type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

/**
 * agent 交互的可合并扩展、只追加的权威来源。消息历史由该日志派生。每个事件
 * 都是无损 JSON，序号保持连续。assistant attempt 事件内嵌其精确压缩的原始流，
 * 使持久化为每次尝试存储一个持久结算。
 */
export interface SessionEventMap {
  /**
   * 在循环认领排队输入或运行 pre-step 之前打开 turn `turn`。拒绝、空输入、
   * 取消或失败可能在不产生 step 的情况下关闭它；否则随后的已标识
   * `user/message` 事件或批次记录进入该 step 的消息。
   */
  'turn/start': { turn: number }
  /**
   * 以结束该 turn 的 {@link TurnEndReason} 关闭 turn `turn`。没有进入 step
   * 的 turn 没有 `step/start` 或 `step/end`。循环不在 turn 边界等待刷新：
   * `dsh-session-checkpoint-policy` 拥有按请求的持久化检查点，在 `whenIdle()`
   * 之后读取存储的消费方自行刷新。成功提交该 turn；拒绝被实时上报且不阻碍
   * 后续工作。
   */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** 打开 turn `turn` 的 step `step`——一次模型调用加上它请求的工具执行。 */
  'step/start': { turn: number; step: number }
  /** 关闭 turn `turn` 的 step `step`。 */
  'step/end': { turn: number; step: number }
  /**
   * 模型可见 surface 上的 user 角色消息：直接的人类提示词（本 turn 认领的排
   * 队消息）、合成的 `agent.inject()` 上下文（文件变更通知、子目录
   * AGENTS.md、技能内容、cron 通知等），或已进入的 goal 续轮。三者的
   * `content` 都按原样投影；`source` 用于区分它们。
   */
  'user/message': UserMessage
  /** 在所指 turn 与 step 处接受的增量 agent session 变更。 */
  'developer/message': {
    turn: number
    step: number
    message: DeveloperMessage
    /** 定义每个工具新增的更早 request/header；恰好存在新增时必填。 */
    headerSeq?: SessionSeq
  }
  /**
   * 模型可见 surface 上渲染后的系统提示词。循环在该 step 的第一个
   * `user/message` 之前把第一个系统提示词追加为 surface 节点 0。已准备的
   * in-history 路由可以在延续序列中追加非空变更。无能力路由或新序列会把文
   * 本规范化到第一个系统节点。规范化先清空非空的后续节点，再按需重写头节点，
   * 全程通过已记录的逐节点替换完成。空渲染总是清除所有活跃系统节点，不留下
   * 任何模型可见的旧指令。空的后续节点处于休眠状态且不投影任何消息；没有活
   * 跃后续节点的空头节点记录"无系统提示词"。恢复的非空文本遵循相同的路由与
   * 序列规则；空节点从不恢复更早的文本。
   */
  'system/message': { turn: number; step: number; message: SystemMessage }
  /**
   * 一个 step 的组装后 assistant 消息（派生历史使用它）。adapter 报告了 token
   * 核算时携带该 step 的 `usage`，使模型输出与其核算同行（没有单独的 usage
   * 记录）。adapter 未报告时 `usage` 不存在。流中取消的 turn 将其已交付的文
   * 本/推理前缀以 `interrupted: true` 定格为本事件；未派发的工具调用不存在。
   * 该标记区分该前缀，无需从 turn 边界重新推导中断。没有此类事件的中止 turn
   * 未流式输出任何可见内容。
   */
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage
    /** 精确的带时序模型流，压缩时不合并 delta 边界。 */
    stream: AssistantStreamRecord[]
    usage?: TokenUsage
    interrupted?: true
  }
  /**
   * 未提交任何 surface 消息的一次模型尝试。内嵌流保留到达结算的失败、重试、
   * 取消或流错误尝试，而不伪造模型可见历史。
   */
  'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }
  /**
   * 模型请求一次工具调用：`name` 与模型产出的原始 `arguments` JSON 字符串
   * （未解析）。`callId` 把该调用与其 `tool/result` 配对。
   */
  'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
  /**
   * 已完成工具调用的面向模型结果、可选的内部失败标识与面向用户的原因，以及
   * 可选的工具私有 `meta` 展示载荷。原因保持在面向模型的消息之外。`meta` 对
   * 核心不透明（产生它的工具拥有其结构并在 `presentResult` 中读回），但必须
   * 可 JSON 序列化：`Session.append` 用 `isJsonValue` 对所有事件数据做运行时
   * 校验，因此不可序列化的 `meta` 在源头被拒绝，持久日志在回放时重现完全相
   * 同的卡片。除非工具附加了 `meta`，否则不存在（例如 `dsh-tool-fs` 在此携
   * 带其结果时间的上下文 diff）。
   */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    /**
     * 可选的失败标识与原始面向用户的原因，位于模型内容之外；
     * 仅当消息带有 `isError: true` 时允许。
     */
    error?: { name: string; code: string; reason?: string }
    meta?: JsonValue
  }
  /**
   * 下一个请求的完整 header，在其 step 内、派发前追加。
   * 它仅存在于日志；最新快照重建请求 header。
   */
  'request/header': {
    header: EpochHeader
    reason: RequestHeaderReason
    /** 该请求开启了一个独立区分的模型消息序列，与 header 原因无关。 */
    startsSeries?: true
  }
  /**
   * 下一个请求的路由元数据，仅在路由、容量或系统提示词更新模式变化时记录。
   * 它不参与请求重建或 header 相等性比较。提示词接纳使用绑定的已准备调用的
   * 能力，而非这个来自更早请求的快照。
   */
  'request/context': RequestContext
  /**
   * 把继承或恢复的历史与后续生命周期持有的工作分开。该仅存于日志的标记不必
   * 位于 {@link Session.firstLiveSeq}：分叉 seed 可以在构造之前就已包含其带
   * 标记 marker 与子级自有的合成收尾事件。
   *
   * 新分叉子级在其确切的继承前缀切点处拥有一个 `{ inherited: true }` marker，
   * 即使该前缀以祖先 marker 结尾。`buildForkSeed` 在任何合成收尾事件之前追
   * 加该 marker；`Session` 构造器在只给定继承前缀时补上它。最后一个带标记
   * marker 是当前 Session 的切点；不带标记的 marker 保留普通的恢复与回放生
   * 命周期边界。
   *
   * 只有 `Session` 构造器与 `buildForkSeed` 可以创建该 marker。Session 追加
   * 不拒绝其他写入者，因此插件追加一个会把其之前的所有活跃括号静默归类为
   * seed 历史。
   *
   * 独立开/闭括号（`compaction/start` … `compaction/end`）的所有者读取它，
   * 因为 seed 历史与活跃工作在其他方面字节级相同：该事件之前一个未配对的开
   * marker 属于已结束的生命周期，无论其如何结束。它不是关于其他写入者存活
   * 状态的信号——并发活跃的 session 在别处持有自己的边界，因此容忍并发写入
   * 者需要日志之外的信号。
   */
  'session/end-seed': { inherited?: true }
}

/** {@link SessionEventMap} 的可追加事件类型键，包括插件合并的扩展。 */
export type SessionEventType = keyof SessionEventMap

/**
 * {@link SessionEventType} 值中其事件产生 LLM 消息并有资格出现在有序 surface
 * 上的子集。只有这些事件类型可以携带 {@link SurfaceOp}；system、user 与 tool
 * 事件还可以通过 {@link SessionEvent.sourceEventSeqs} 引用更早的来源。
 */
export type SurfaceEventType =
  | 'system/message'
  | 'developer/message'
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/** 携带其必需 surface 操作的产消息事件。 */
export type SurfaceEvent = SessionEvent<SurfaceEventType>

/**
 * session 事件进入有序 surface 的方式。仅对 {@link SurfaceEventType} 事件有效。
 *
 * - `'append'`：追加到尾部——user/assistant/tool 消息的正常路径。
 * - `{ op: 'replace', startSeq, endSeq }`：用本节点替换 `startSeq`（含）至
 *   `endSeq`（含）之间的 surface 节点。两者都必须作为 surface 节点存在于当前
 *   surface。`startSeq === endSeq` 替换单个节点。节点的
 *   {@link SessionEvent.sourceEventSeqs} 必须包含每个被遮蔽的 surface 节点。
 *   由压缩使用；任何替换 surface 的生产者也可使用。
 */
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }

/**
 * {@link Session.append} 的 surface 放置与引用的来源事件 seq。产消息事件必填，
 * 仅存于日志的事件禁止。
 */
export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
  surfaceOp: SurfaceOp
} & (T extends 'assistant/message' ? {
  /** assistant 消息内嵌其 provider 流，而非引用来源事件。 */
  sourceEventSeqs?: never
} : {
  /** 已知更早来源事件 seq 的完整非空集合。 */
  sourceEventSeqs?: SessionSeq[]
})

/**
 * session 日志中的一个不可变条目。
 *
 * 按 `type` 构成的正规可辨识联合（不是独立的 `type`/`data` 联合），因此
 * `switch (event.type)` 无需转型即可收窄 `event.data`。
 *
 * {@link sourceEventSeqs} 与 {@link surfaceOp} 字段是条件性的：
 * 它们只存在于 {@link SurfaceEventType} 变体（`system/message`、`user/message`、
 * `assistant/message`、`tool/result`）上。
 * 非 surface 事件（边界标记、尝试、错误）从不携带
 * surface 元数据——编译器在 `Session.append()`
 * 调用点强制这一点。
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** session 内的单调递增序号。 */
    seq: SessionSeq
    /** Unix 纪元毫秒。 */
    time: number
    data: SessionEventMap[K]
    /**
     * 标记读取方在不识别 `type` 时可以安全跳过的事件。缺省意味着必需：读取
     * 方遇到没有此标记的未识别类型时必须拒绝重建 session，而不是静默丢弃该
     * 事件，因为未识别的必需事件可能改变日志其余部分的解读方式。写入者仅对
     * 纯信息性记录设置 `true`，其丢失不会影响重建；默认为必需意味着遗忘的标
     * 记导致过度拒绝（一种不便），而非静默恢复一个被掏空的 session。
     */
    ignorable?: true
  } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
    surfaceOp?: never
    sourceEventSeqs?: never
  })
}[T]

/**
 * 实验性插件记录的事件类型：`plugin:` 后跟以斜杠分隔的段，段由小写字母、数
 * 字、`.`、`_` 与 `-` 组成，每段以字母或数字开头。记录类型绝不是
 * {@link SessionEventMap} 成员。
 */
export type PluginRecordType = `plugin:${string}`

/**
 * 实验性包写入的载荷，以其 `plugin:` 记录名为键。包扩展此 map 以获得写入类
 * 型并进入当前插件记录目录；这些声明不进入 {@link SessionEventMap} 或已发布
 * 的持久化 schema。存储的记录仍需要所有者验证。
 */
export interface PluginRecordMap {}

/**
 * 一条已提交的实验性插件记录，通过 `pluginRecordOf` 从日志读取。记录的所有
 * 者在使用前验证 `data`，因为恢复的记录携带其所有者早期构建写入的任意 JSON，
 * 或格式迁移重命名进 `plugin:` 命名空间的 V3 事件所持有的内容。
 */
export interface PluginRecord {
  /** 记录类型，由所属插件选择。 */
  readonly type: PluginRecordType
  /** 记录在 Session 日志中的位置。 */
  readonly seq: SessionSeq
  /** 追加时的 Unix 纪元毫秒。 */
  readonly time: number
  /** 按提交原样的 JSON 载荷。 */
  readonly data: unknown
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** 一个 Session；Session Controller 注册其默认的 `sessionId` wire 字段。 */
    session: TypertResource<SessionId>
  }

  interface RemoteErrorDetailsMap {
    /** 所指名的 Session 不存在；由解析 SessionId 的每一层产生。 */
    'session/not-found': { readonly sessionId: SessionId }
  }
}
