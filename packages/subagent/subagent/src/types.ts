/**
 * 本接缝面向消费者的契约：{@link SubagentProvider} 的请求、结果与能力类型，
 * 以及插件与宿主所观测的 `subagent/start` 与 `subagent/end` 载荷。内部控制
 * 接口与其实现放在一起 —— 生命周期观察者在 `./lifecycle.ts`，管理器宿主机
 * 在 `./manager.ts` —— 因此本模块保持为已发布的表面，而非一个装满各种
 * 类型形状的袋子。
 *
 * @module @deepseek-ai/dsh-subagent/types
 */

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** 在一次子代理运行的生命周期事件对之间标识它。 */
export type SubagentRunId = Branded<'SubagentRunId'>

/**
 * 把一个字符串打上 {@link SubagentRunId} 品牌。
 * @param id - 原始运行 id。
 * @returns 被打上品牌的同一字符串。
 */
export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}

/** 一次受管理的子执行及其结果投递策略。 */
export interface SubagentActivationSpec {
  /** 要使用的已注册后端。 */
  readonly provider: string
  /** 保留在已编目子代理成员关系中的简短任务标签。 */
  readonly label: string
  /** 本地子代理的可选预留身份；外部后端自行分配 id。 */
  readonly childId?: SessionId
  /** 任务、父代理与后端支持的执行选项。 */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
  /** 发布之前的取消；调用方通过 dispose 拥有之后的取消权。 */
  readonly signal: AbortSignal
  /** 父投递会通知模型；调用方投递只返回结果。本地子代理总是进入父目录。 */
  readonly delivery: 'parent' | 'caller'
}

/** 一次受管理的执行；处置针对的正是这次激活，而非之后的恢复。 */
export interface SubagentActivation {
  /** 子代理的稳定身份。 */
  readonly childId: SessionId
  /** 当后端有本地收件箱时的、已被接受的收件箱消息。 */
  readonly messageId?: MessageId
  /**
   * 拆解结算且通知已发送之后的执行结果；捕获失败会拒绝。
   * 拆解失败由 dispose() 报告，而不替换已捕获的结果。
   */
  readonly result: Promise<SubagentResult>
  /** 停止并释放本次激活及其所属后代；拆解失败时拒绝。 */
  dispose(): Promise<void>
}

/**
 * 一个中断请求被接纳所依据的授权。`user` 携带人类客户端呈现的持久化直接
 * 父地址；`ancestor` 携带精确的实时 Agent 对象，其记录的血缘必须包含调用方。
 */
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

/** 相邻 Agents 之间一条模型撰写消息的选项。 */
export interface SubagentSendMessageOptions {
  /** 调用方取消，仅在收件箱接受之前拥有该操作。 */
  readonly signal: AbortSignal
}

/**
 * 一次已发布子代理运行的、仅可观测的标识详情，由 `subagent/start` 承载。
 * 本地与外部激活共享此载荷。
 */
export interface SubagentRunInfo {
  /** 与配对的终止事件共享的唯一身份。 */
  readonly runId: SubagentRunId
  /**
   * 子代理首次创建时记录的提供方名称，即使该提供方之后被注销也保留。
   */
  readonly provider: string
  /** 子代理的 id。 */
  readonly id: SessionId
  /** 本次激活是否拥有一个本地 Agent，在发布时固定。 */
  readonly local: boolean
}

/**
 * 一次已结算子代理运行的、仅可观测的结果详情，由 `subagent/end` 承载，
 * 并通过 `runId` 与一个 {@link SubagentRunInfo} 配对。
 */
export interface SubagentRunEndInfo {
  /** 与配对的起始事件共享的唯一身份。 */
  readonly runId: SubagentRunId
  /** 配对的起始事件所携带的同一提供方名称。 */
  readonly provider: string
  /** 子代理的 id。 */
  readonly id: SessionId
  /** 本次激活是否拥有一个本地 Agent，在发布时固定。 */
  readonly local: boolean
  /** 终止停止原因。 */
  readonly stopReason: SubagentResult['stopReason']
  /**
   * 子代理的最终助手输出，按与 {@link SubagentResult.output} 相同的规则选取；
   * 在基础设施拒绝时或子代理未产生任何输出时不存在。
   */
  readonly lastAssistantMessage?: readonly ContentBlock[]
}

/**
 * 已注册后端所支持的启动时选项。管理器在准备本地子代理或启动外部执行之前
 * 检查每个被请求的选项。depthLimit 控制 maxDepth；其余标志名与
 * SubagentStartRequest 字段一致。
 */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  /** 支持独立于父代理组合选择预设。 */
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}

/**
 * 提供给后端的任务与可选能力。startActivation 在 request 中携带这些字段，
 * 同时单独拥有其标签、取消与投递策略。
 */
export interface SubagentStartRequest {
  /** 初始子目录；相对路径按父代理当前目录解析。省略则在启动时继承该目录。 */
  readonly cwd?: string
  /**
   * 独立预设 id；省略则加入父代理的当前 generation。
   * 需要一个具有 `capabilities.agentPreset` 且不继承父上下文的提供方。
   */
  readonly agentPreset?: string
  /** 随 session 支撑的子代理一起持久化的可选简短展示标签。 */
  readonly label?: string
  /** 作为子代理 user message 投递的内容。 */
  readonly prompt: ContentBlock[]
  /**
   * 发起的 agent。其生效目录提供默认 cwd；进程内子代理保留其来源、
   * 血缘与委托深度。
   */
  readonly parent: Agent
  /**
   * 来自发起上下文的取消信号（工具的 `exec.signal`）。这是启动前后唯一
   * 规范的取消通道：当它在运行发布之前触发时，提供方在清理部分资源之后
   * 拒绝 `start()`；当它在之后触发时，取消已发布运行剩余的轮次工作。
   */
  readonly signal: AbortSignal
  /**
   * 可选的宿主机 Agent provider、model、reasoning-effort 与输出 token 覆盖项。
   * 需要 {@link SubagentCapabilities.agentOptions}；进程内提供方在创建子代理时
   * 把它们合并覆盖到父 Agent 的选项之上，而 DSH SDK 提供方在初始化独立的
   * 子运行时之前把它们合并覆盖到其实例默认值之上。
   */
  readonly agentOptions?: AgentOptions
  /**
   * 位于 `assertObjectJsonSchema` 所强制子集内的、以对象为根的 JSON Schema。
   * Start 会拒绝不支持的模式或没有该能力的提供方。数据必须是纯宿主域 JSON；
   * 成功的子代理会返回匹配的值作为 {@link SubagentResult.structured}。
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * 针对正被启动的子代理的可选绝对委托深度上限：其计算出的深度必须小于
   * 或等于这个非负安全整数。需要 {@link SubagentCapabilities.depthLimit}；
   * 否则在 start 时被拒绝。
   */
  readonly maxDepth?: number
}

/** 面向提供方的请求，带有在启动之前选定的绝对目录。 */
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** 从父代理或显式请求中捕获的绝对子目录。 */
  readonly cwd: string
}

/**
 * 续跑管理器在具现一个可续跑子代理的首次激活时向提供方索取的内容。
 * 管理器已预留持久化子代理身份并拥有之后的每个操作，因此本请求只携带
 * 区分全新子代理与被父历史播种的子代理所必需的信息。
 */
export interface ContinuableCreateRequest {
  /** 在提供方准备之前捕获的绝对初始目录。 */
  readonly cwd: string
  /** 已预留的持久化子 session id，供提供方诊断使用。 */
  readonly sessionId: SessionId
  /** 播种型提供方读取其历史的委托方父代理。 */
  readonly parent: Agent
  /**
   * 调用方取消，它只在管理器把初始 prompt 接受到子代理收件箱之前拥有准备阶段。
   */
  readonly signal: AbortSignal
}

/**
 * 提供方对一个可续跑子代理创建的、已分离的贡献。这是数据，从不是能力：
 * 它不携带 Agent、`AgentHandle`、prompt 投递、结果、处置或恢复操作，因为
 * 续跑管理器在准备之后拥有子代理的整个生命周期。
 */
export interface ContinuableCreateSpec {
  /**
   * 用于播种子 session 的父日志已完成轮次前缀，全新子代理则不存在。
   * 与 `CreateAgentOptions.seed` 相同的持久化契约：自 seq 0 连续、
   * 无损 JSON、平衡。
   */
  readonly seed?: readonly SessionEvent[]
}

/**
 * 一次子代理运行为何结束。可合并扩展（后端可以添加变体）；消费者在已知
 * 情形上分支，并在 `default` 上兜底。已知情形镜像 harness 的轮次结束词汇，
 * 以便工具层能把非 `completed` 的结果映射为一个 `isError` 工具结果。
 */
export interface SubagentStopReasonMap {
  /** 子代理正常完成了其轮次。 */
  completed: 'completed'
  /** 通过请求信号或处置被取消。 */
  aborted: 'aborted'
  /** 模型或传输失败。 */
  error: 'error'
  /** 子代理在完成之前撞上了 token 上限。 */
  'max-tokens': 'max-tokens'
  /** 子代理拒绝了该任务。 */
  refusal: 'refusal'
}

/** {@link SubagentStopReasonMap} 上的联合 —— 后端合并变体时自动拓宽。 */
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

/**
 * 一次子代理运行的终止结果，由 {@link SubagentRun.result} 解析得到。
 */
export interface SubagentResult {
  /**
   * 子代理的最终助手输出是其最后一条非空助手消息的内容。空内容消息，
   * 包括仅用量消息，会被跳过。若没有非空消息，则输出为其累积的助手文本
   * 流，或当子代理两者都未产生时为 `[]`。
   */
  readonly output: readonly ContentBlock[]
  /**
   * 在被请求的 `outputSchema` 被成功满足之后的结构化结果。请求模式并不
   * 保证存在：当子代理失败或没有有效捕获就结束时，提供方可以以
   * `stopReason: 'error'` 结束。结构化值由提供方针对所请求的输出模式校验；
   * 此处为 `unknown`，因为本接缝与模式无关。
   */
  readonly structured?: unknown
  /**
   * 面向非 `completed` 结果的、由提供方撰写的非助手失败详情。提供方保持
   * 该文本不含工具输入、文件内容、环境值、凭据与原始协议载荷，并限制在
   * 4096 UTF-8 字节以内。消费者把它与 {@link output} 分开呈现。
   */
  readonly diagnostic?: string
  /** 运行为何结束。非 `completed` 的原因意味着 `output` 可能是不完整的。 */
  readonly stopReason: SubagentStopReason
}

/**
 * 直接由激活注册表拥有的后端执行句柄。
 * 结果可能在资源释放之前就已可用；管理器总是处置该句柄并等待清理。
 * 后端启动失败在拒绝之前清理部分资源，而已被接受的执行失败则通过结果结算。
 */
export interface SubagentRun {
  /** 由提供方铸造的 id，在本运行时内跨所有父代理、提供方与本地 Session 唯一。 */
  readonly id: SessionId
  /**
   * 在运行结算时以子代理的终止 {@link SubagentResult} 解析。在子代理级别
   * 失败时不拒绝 —— 模型/传输失败以 `stopReason: 'error'` 解析，以便消费者
   * 把它映射为 `isError` 工具结果。在本接缝无法用停止原因表示的基础设施
   * 故障上拒绝。
   */
  readonly result: Promise<SubagentResult>
  /**
   * 取消剩余工作、使子代理达到静默状态并释放资源。幂等。
   */
  dispose(): Promise<void>
}

/**
 * 一个已注册的、用于运行子代理的传输。提供方是受信任的同进程实现；调用方
 * 把描述符与返回值视为借用的不可变数据。service 可以为不同的子代理并发
 * 调用同一个提供方。提供方隔离各自操作局部的可变状态；共享的容量控制器
 * 可以延迟某个操作，但不得把其结算或清理与同级耦合。
 */
export interface SubagentProvider {
  /** 唯一的注册表名称（例如 `spawn`、`fork`、`acp`）。 */
  readonly name: string
  /** 本提供方所支持的启动期特性（见 {@link SubagentCapabilities}）。 */
  readonly capabilities: SubagentCapabilities
  /**
   * 子代理是否看到父代理的已完成轮次前缀。这是描述性的，而非经 service
   * 校验的启动能力：面向模型的工具从中推导真实措辞。它与工具注册、
   * 注入服务或权限继承无关。
   */
  readonly inheritsParentContext: boolean
  /**
   * 可选的、由提供方自有的静态 provider/model 路由，用于子 Agent 选项。
   * 消费者在 preflight 之前把工具/模型覆盖项合并到这些值之上；路由派生自
   * 父代理的提供方则省略它。该值是已分离的不可变数据，且需要
   * `agentOptions` 支持。
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * 建立一次外部执行并返回其所拥有的句柄。
   * service 已校验每个被请求的启动期能力都受支持。在兑现之前，提供方拥有
   * 准备工作，并在拒绝之前清理任何未发布的部分资源。所有权在兑现时转移；
   * 之后轮次或基础设施的失败通过返回的 run 结算。不同的启动可以重叠；
   * 每次运行的取消、失败、结果结算与处置保持彼此独立。
   */
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * 可选（可续跑创建能力）：贡献那些使本提供方可续跑子代理与众不同的、
   * 已分离的创建输入 —— 即子 session 是否用父历史播种。方法存在与否决定
   * 是否选择本地激活执行。没有它的提供方通过 start 执行，且不接受后续消息。
   *
   * 这是提供方在一个可续跑子代理中的唯一参与。续跑管理器拥有身份预留、
   * 组合、Agent 创建、prompt 投递、冷恢复、归属与处置，因此提供方永远
   * 看不到子代理的 Agent、句柄、轮次或拆解。不同的准备可以重叠；各自
   * 遵循自己的信号，并返回只属于 `request.sessionId` 的数据。
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
