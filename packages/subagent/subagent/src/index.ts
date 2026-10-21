/**
 * 子代理能力接缝（`ctx.subagents`）的 Service Definition：一个具名提供方注册表
 * 加上一个校验能力的异步启动 API。提供方在返回其运行之前先建立子代理，
 * 因此兑现是唯一的发布与所有权转移边界。
 *
 * 多个提供方共存：各自以唯一名称注册，调用方按名称选择其一。
 *
 * 本包拥有该能力接缝的 Service Definition 角色。Service Providers
 * （`@deepseek-ai/dsh-subagent-spawn-in-process`、`-fork`、`-acp`）与面向模型的
 * 消费者（`@deepseek-ai/dsh-tool-subagent`）是独立的包。
 *
 * `startActivation` 在激活管理器之下建立每个子代理，后者拥有执行、结果投递
 * 与资源释放。本地提供方播种可恢复的 Agents；外部提供方返回单个执行句柄。
 * `sendMessage` 在相邻的本地 Agents 之间转向，而不暴露子代理是否驻留。
 * 发现把真实子 Session 与用于外部执行的父自有记录结合起来。
 * 直接发现读取父目录；后代递归地读取可达的子目录。外部条目是没有本地
 * Session 的叶子。
 *
 * 同进程提供方是受信任的类型化协作者。请求、提供方描述符、结果与生命周期
 * 载荷都是借用的不可变值；序列化与敌意输入校验属于真实的进程、worker、
 * 持久化与模型边界。
 *
 * @module @deepseek-ai/dsh-subagent
 */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-attachment'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { Remote, RemoteError, TypertRemoteService, principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import {
  rejectPrompt, validateControlRequest,
} from './control.ts'
import type {
  SubagentDelivery,
  SubagentInterruptReceipt,
  SubagentPromptReceipt,
  SubagentPromptRequest,
  SubagentPromptRequestId,
} from './control-types.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentInterruptAuthority,
  SubagentProvider,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentSendMessageOptions,
  SubagentStartRequest,
} from './types.ts'
import { SubagentError } from './error.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { createActivationObserver, createLifecycleEmitter } from './lifecycle.ts'
import type { ActivationObserver, LifecycleEmitter } from './lifecycle.ts'
import SubagentManager from './manager.ts'
import { listChildren as listSubagentChildren, listDescendants as listSubagentDescendants } from './list-children.ts'
import type { SubagentDescendantListEntry } from './list-children.ts'
import { installSubagentArchiveAdmission } from './archive-admission.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition } from './projection.ts'
import { subagentCatalogProjectionDefinition } from './catalog.ts'
import { deliverSubagentPrompt } from './internal.ts'

export type {} from './catalog.ts'
export * from './out-of-process.ts'
export { AssistantOutputFold, finalAssistantOutput } from './assistant-output.ts'
export { SubagentRunId } from './types.ts'
export type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentActivation,
  SubagentActivationSpec,
  SubagentInterruptAuthority,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentSendMessageOptions,
  SubagentStartRequest,
  ResolvedSubagentStartRequest,
  SubagentStopReason,
  SubagentStopReasonMap,
} from './types.ts'
export {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
} from './descriptor.ts'
export type {
  ContinuableSubagentDescriptorData,
  ContinuableSubagentDescriptorInput,
  OneShotSubagentDescriptorData,
  SubagentDescriptorData,
} from './descriptor.ts'
export { STRUCTURED_OUTPUT_TOOL } from './structured.ts'
export { SubagentError } from './error.ts'
export { assertSubagentMaxDepth, delegationDepthOf } from './depth.ts'
export {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  parentAgentOptionsForDelegation,
  resolveChildAgentOptions,
  resolveChildDepth,
  SubagentDepthError,
} from './child-agent.ts'
export type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
export type { AgentMessageSource, SubagentSettledMessageSource } from './continuation-messages.ts'
export type * from './control-types.ts'
export type { SubagentDescendantListEntry } from './list-children.ts'
export type { SubagentRunEndInfo, SubagentRunInfo } from './types.ts'
export type { SubagentCatalogEntry, SubagentIdentityProjection, SubagentTimingProjection } from './projection-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * 一个提供方在注册表中变为可解析。
     * @param provider - 已注册的提供方。
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * 一个提供方离开了注册表。已被接受的运行仍由持有者拥有。
     * @param name - 不再可解析的提供方名称。
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * 一个提供方建立了一个已发布的子代理。对进程内提供方而言，
     * `ctx.agents.get(info.id)` 在本通知期间可解析。
     * 作用域过滤分派以委托方父代理为键控载体，因此一个父作用域监听器
     * 只观测其自身的委托。与 `subagent/end` 配对。
     * @param info - 提供方与已发布子代理的身份。
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * 一个已发布子代理已结算。作用域过滤分派使用与 `subagent/start` 相同的
     * 委托方父代理载体，因此该生命周期对到达同一个作用域受众。
     * @param info - 运行身份与终止结果。
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

/**
 * 一条浏览器撰写后续消息的持久化归属。Session Controller 声明这个
 * `user-rpc` 消息来源并依赖本包，因此字段在此处拼写：`MessageSource` 的
 * `user` 成员接受该记录，而关联 id 搭载在客户端用以对账其乐观 prompt 的
 * 持久化消息上。
 */
interface BrowserPromptSource {
  readonly kind: 'user'
  readonly rpcId: SubagentPromptRequestId
  readonly clientTimeZone?: string
  /** 提交本条后续消息的调用方，仅当其不是所有者时写入；缺省表示所有者。 */
  readonly principal?: Principal
}

/** 可续跑子代理容量的宿主配置。 */
export interface Config {
  /** 共享未被打断的可续跑父链接的最大活跃子代理数；默认为 8。 */
  maxActiveSubagents: Volatile<number>
  /** 未显式设限的工具的默认委托深度；默认为 1。 */
  maxDepth: Volatile<number>
}

/** 带有受管理激活、持久化发现与本地子消息传递的具名提供方注册表。 */
export class SubagentRuntime extends TypertRemoteService {
  static Config = z.object({
    maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(1).volatile(),
    maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8).volatile(),
  })
  static inject = ['workingDirectory']
  private providers = new Map<string, SubagentProvider>()
  private manager: SubagentManager | undefined
  /**
   * 带隔离的生命周期边发布器。在此处构建，因为作用域分派以这个精确的
   * service 实例为其载体键，而该实例自身的上下文过滤器会组合进载体。
   */
  private readonly emitLifecycle: LifecycleEmitter

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagents')
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentManager(childCtx, {
        startExternal: (name, request) => {
          const provider = this.expectProvider(name) as SubagentProvider & Required<Pick<SubagentProvider, 'start'>>
          return provider.start(request)
        },
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
      }, () => this.config.maxActiveSubagents.get())
      this.manager = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- 一个被注入的绑定拥有该槽位，直到其 fiber 被处置。 */
        if (this.manager === manager) this.manager = undefined
      }, 'subagents.managerBinding()')
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(subagentCatalogProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition)
    })
    // 归档准入：本运行时是知道哪些活着的子代理派生自某个 Session、
    // 以及父代理如何停止它们的属主。
    ctx.inject(['agents'], (agentsCtx: Context) => { installSubagentArchiveAdmission(agentsCtx) })
  }

  /**
   * 针对当前用户设置解析一个委托工具的深度策略。
   * @param configured - 显式工具限制，或对外部委托而言由提供方管理。
   * @returns 数值限制，或当提供方自己负责深度强制时为 undefined。
   */
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined {
    if (configured === 'provider-managed') return undefined
    if (configured !== undefined) return configured
    const depth = this.config.maxDepth.get()
    assertSubagentMaxDepth(depth)
    return depth
  }

  /**
   * 在其预留身份下启动一个本地子代理。
   * @param spec - 本地任务、预留子 id 与结果接收方。
   * @returns 带有其已接受初始消息 id 的激活。
   */
  startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }):
  Promise<SubagentActivation & { readonly messageId: MessageId }>
  /**
   * 启动一个本地或外部子代理。
   * @param spec - 任务、后端与结果接收方。
   * @returns 激活，仅对本地子代理带有消息 id。
   */
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  /**
   * 以特定于后端的执行能力建立一个受管理的子代理。
   * @param spec - 任务、后端与结果接收方。
   * @returns 身份、执行结果与精确激活的处置。预留的 childId 需要一个本地
   * 后端，并保证有一个已接受的 messageId。
   */
  async startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const provider = this.expectProvider(spec.provider)
    if (spec.childId !== undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError('reserved child ids require a local backend', 'UNSUPPORTED_CAPABILITY')
    }
    assertSubagentMaxDepth(spec.request.maxDepth)
    this.assertCapabilities(provider, { ...spec.request, signal: spec.signal })
    const manager = this.requireManager()
    if (this.ctx.get('agents')?.get(spec.request.parent.id) !== spec.request.parent) {
      throw new SubagentError('subagent creation requires the exact live parent agent', 'UNAUTHORIZED')
    }
    if (spec.request.outputSchema !== undefined) assertObjectJsonSchema(spec.request.outputSchema)
    return provider.prepareContinuable === undefined
      ? manager.startExternal(spec)
      : manager.startLocal(spec)
  }

  /**
   * 汇合正在推进的后代而不取消它们。收件箱需要之后唤醒的空闲后代保持
   * 驻留，且不延迟宿主的完成。
   * @param parent - 观测其后继工作的精确父代理。
   * @returns 是否汇合了工作；为 true 时宿主会重新检查父代理空闲。
   */
  async waitForChildren(parent: Agent): Promise<boolean> {
    return this.manager?.waitForChildren(parent) ?? false
  }

  /**
   * 把一条模型撰写的消息转向发送方的直接父代理或直接可续跑子代理。
   * 运行中的目标在最近的步骤边界接纳它；空闲目标开启一个轮次，而缺席的
   * 直接子代理从持久化冷恢复。service 从精确的实时发送方推导持久化发送方
   * 归属。调用方取消只停止接受之前的工作。
   * @param sender - 授权并发起该消息的精确实时 Agent。
   * @param targetId - 持久化的直接父或直接子 session id。
   * @param content - 待投递的模型撰写内容。
   * @param options - 在收件箱接受之前的调用方取消。
   * @returns 被接受消息的收件箱 id。
   * @throws 当续跑服务不可用、邻接被拒绝，或消息未被接纳时。
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    return this.requireManager().sendMessage(sender, targetId, content, options)
  }

  /**
   * 向一个直接可续跑子代理投递一条宿主协议消息。
   * 以 symbol 为键，使宿主适配器能保留自己的来源描述符，而无需拓宽公开的
   * Service Definition 或冒充一个 Agent 发送方。
   * @param parent - 授权该投递的精确实时直接父代理。
   * @param childId - 持久化的直接子 session id。
   * @param content - 待投递的宿主撰写内容。
   * @param source - 持久化宿主协议来源描述符。
   * @param signal - 在收件箱接受之前的调用方取消。
   * @param delivery - 作为独立轮次排队，或在最近的步骤转向。
   * @returns 被接受消息的收件箱 id。
   */
  private [deliverSubagentPrompt](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    delivery: SubagentDelivery,
  ): Promise<MessageId> {
    return delivery === 'steer'
      ? this.requireManager().steerPrompt(parent, childId, content, source, signal)
      : this.requireManager().queuePrompt(parent, childId, content, source, signal)
  }

  /**
   * 在人类父地址或一个精确的实时祖先 Agent 之下中断一个活着的子代理的
   * 当前执行。发后即忘：取消信号在本方法返回之前就已发出，但目标可能
   * 继续运行直到它观测到该信号。未被认领的待处理收件箱工作、该 Activation
   * 与已发布的后代都被保留；已认领的工作不会重新排队。一旦被中断的 Agent
   * 空闲，一次唤醒发送会恢复被挂起的 FIFO 队列。外部后端停止其单次执行。
   * 缺席的目标是已被接受的无操作，没有管理器的组合同样如此，它无法拥有
   * 一个活着的 Activation。
   * @param targetSessionId - 要中断的持久化子 session id。
   * @param authority - 人类父地址或精确的实时祖先 Agent。
   * @throws {SubagentError} 当该授权不拥有活着的目标时抛 `UNAUTHORIZED`。
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.manager?.interrupt(targetSessionId, authority)
  }

  /**
   * 关闭精确实时父 Agents 之下子代理的准入，同步停止仅它们可见的后代
   * Activation，然后等待已被接纳的作用域具现，并以子优先释放那些森林。
   * 作用域切断持续到每个精确父代理离开注册表为止；无关的父树保持存活。
   * @param parents - 进入拆解的、宿主拥有的精确父 Agents。
   * @returns 在每个被保留的后代激活释放其执行句柄之后返回。
   * @throws 当任一失败时，在所有分支结算之后抛出一个聚合错误。
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.manager
    // 缺席的激活管理器无法拥有已具现的子代理。
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * 释放一个精确实时父代理所选定的驻留直接子代理。同一父代理的其他子代理
   * 保持被接纳与驻留。缺席的目标与没有管理器的组合都是已被接受的无操作。
   * @param parent - 授权此次选择性释放的精确实时直接父代理。
   * @param childIds - 驻留时要释放的持久化直接子 id。
   * @returns 在每个被选中的激活释放其执行句柄之后返回。
   * @throws {SubagentError} 当某个驻留目标属于不同的父代理或所提供的父
   *   身份已陈旧时抛 `UNAUTHORIZED`。
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    const manager = this.manager
    if (manager === undefined) return
    await manager.drainChildren(parent, childIds)
  }

  /**
   * 读取父代理的持久化直接子目录，而不加载或恢复 Agent。
   * service 拥有并释放该实时优先的 Session 观测。
   * @param parentSessionId - 请求其直接子代理的父代理。
   * @param signal - 转发给 Session 查询的取消信号。
   * @returns 按父事件顺序排列的目录子代理。
   * @throws {@link SubagentError} 当查询或目录投影不可用时。
   * @throws SessionQueryError 当父代理无法被读取或查询被取消时。
   */
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]> {
    return listSubagentChildren(this.ctx, parentSessionId, signal)
  }

  /**
   * 以稳定的前序递归列举可达的父目录，保留每个目录的事件顺序。每一行
   * 携带其目录父代理与深度；外部子代理是叶子；一次性与 unknown 模式子代理
   * 仍是遍历节点。未知模式产生 unsupported 诊断。不可读的子目录产生
   * corrupt 或 unavailable 诊断，并只停止该分支。根读取失败、缺失服务或
   * 投影、以及取消会拒绝整个列举。每个目录只被观测一次，并在下一次读取
   * 之前释放。不加载或恢复任何 Agent；可达目录中缺席的 Session 被省略。
   * @param rootSessionId - 以其目录开始后代发现的 session。
   * @param signal - 转发给每次目录读取并在其前后检查的取消信号。
   * @returns 按父目录前序排列的子代理与分支诊断。
   * @throws {@link SubagentError} 当列举依赖不可用或调用方取消时。
   * @throws SessionQueryError 当根目录无法被读取时。
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * 通过精确的实时直接父代理把一条浏览器撰写的消息投递给可续跑子代理，
   * 并在被接受的消息上保留调用方铸造的请求身份与已校验的浏览器时区。
   * 成功标识的是子代理收件箱所接受的那条消息；之后的执行独立于本次调用。
   * 排队投递针对之后的轮次；转向投递针对最近的步骤，并保留 Agent 循环的
   * 尽力而为兜底语义。图片片段在投递之前经由附件存储被接纳并持久化，
   * 且子代理的模型必须接受图片输入。容量已满时的冷恢复以
   * `subagent/delivery-unavailable` 拒绝。
   * @param request - 持久化地址、投递方式、铸造的身份、内容与可选的浏览器时区。
   * @param signal - 载体取消，在收件箱接受之前拥有该调用。
   * @returns 被接受消息的收件箱身份。
   * @throws {RemoteError} `gateway/bad-request`、`subagent/attachment-invalid`、
   *   `subagent/invalid-time-zone`、`subagent/parent-unavailable`、
   *   `subagent/not-resumable`、`subagent/unauthorized`、
   *   `subagent/delivery-unavailable`、`gateway/cancelled` 或 `gateway/internal`。
   */
  @Remote('prompt')
  async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    const { parentSessionId, childSessionId, clientTimeZone, delivery } = request
    validateControlRequest('subagent.prompt', request)
    const canonicalTimeZone = clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(clientTimeZone)
    if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
      throw new RemoteError(
        'subagent/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: clientTimeZone },
      )
    }
    const parent = this.ctx.get('agents')?.get(parentSessionId)
    if (parent === undefined) {
      throw new RemoteError(
        'subagent/parent-unavailable',
        `parent session "${parentSessionId}" is not live`,
        { parentSessionId },
      )
    }
    const principal = principalOf(this.ctx.invocation)
    const source: BrowserPromptSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
      ...(principal === undefined ? {} : { principal }),
    }
    try {
      // 准入先于投递：图片片段在此处变成持久化引用，因此子收件箱
      // 只会接受由宿主持久化的附件。
      let content: ContentBlock[]
      if (request.content.every((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text')) {
        content = request.content.map(part => ({ type: 'text', text: part.text }))
      } else {
        const attachments = this.ctx.get('attachments')
        if (attachments === undefined) throw new Error('subagent image prompt requires an attachment store')
        content = await attachments.admitPromptContent(request.content)
      }
      return {
        messageId: await this[deliverSubagentPrompt](
          parent,
          childSessionId,
          content,
          source,
          signal,
          delivery,
        ),
      }
    } catch (error: unknown) {
      return rejectPrompt(error, childSessionId, signal)
    }
  }

  /**
   * {@link interrupt} 在一个持久化父地址之下的 Remote 外观。不运行任何
   * 目录、历史、持久化或父 Agent 查找：仅由核心原语针对活着的 Activation
   * 校验该地址的授权，这正是让一个活着的子代理在其父 Agent 离线时仍可
   * 被中断的原因。缺席、空闲与已完成的目標在那里都是已被接受的无操作。
   * @param childSessionId - 要中断的持久化子 session id。
   * @param parentSessionId - 被声称拥有授权的持久化直接父代理。
   * @param mode - 必需的续跑地址判别式。
   * @returns 确认取消信号已被接纳，而非确认目标已静默。
   * @throws {RemoteError} 空 id 时为 `gateway/bad-request`；
   *   当该地址不拥有活着的目标时为 `subagent/unauthorized`；
   *   否则为 `gateway/internal`。
   */
  @Remote('interruptByParent')
  interruptByParent(
    childSessionId: SessionId,
    parentSessionId: SessionId,
    mode: 'continuable',
  ): SubagentInterruptReceipt {
    validateControlRequest('subagent.interrupt', { childSessionId, parentSessionId, mode })
    try {
      this.interrupt(childSessionId, { kind: 'user', parentSessionId })
    } catch (error: unknown) {
      if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
        throw new RemoteError(
          'subagent/unauthorized',
          'subagent does not belong to this parent',
          { childSessionId },
          { cause: error },
        )
      }
      throw new RemoteError('gateway/internal', 'subagent interrupt failed', {}, { cause: error })
    }
    return { accepted: true }
  }

  /**
   * 以其名称注册一个提供方。注册是 effect 作用域的且对 HMR 安全；移除一个
   * 提供方会阻止新的启动，但不会撤销已返回给其持有者的运行。没有任何执行
   * 方法的提供方在注册之前会以 UNSUPPORTED_CAPABILITY 被拒绝。
   * @param provider - 受信任的提供方实现。
   * @returns 精确的 Cordis effect disposer。
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    if (provider.start === undefined && provider.prepareContinuable === undefined) {
      throw new SubagentError(`subagent provider "${name}" must implement start or prepareContinuable`, 'UNSUPPORTED_CAPABILITY')
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- 同步 disposer
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // 抛出的 added 监听器会回滚已 yield 的清理，与本仓库的
      // 失败即响亮（fail-loud）注册语义一致。
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * 按名称查找一个提供方。
   * @param name - 提供方名称。
   * @returns 该提供方，缺席时为 undefined。
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * 按插入顺序列出已注册的提供方名称。
   * @returns 已注册的名称。
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 解析一个提供方的、已分离的可续跑创建贡献。提供方上方法是否存在本身就是
   * 能力，因此没有它的提供方会在管理器预留任何子资源之前被拒绝。
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name) as SubagentProvider & Required<Pick<SubagentProvider, 'prepareContinuable'>>
    return provider.prepareContinuable(request)
  }

  /** 查找用于分派的提供方，否则响亮失败。 */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** 解析子代理管理器，否则响亮失败。 */
  private requireManager(): SubagentManager {
    if (this.manager === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.manager
  }

  /**
   * 为一次可续跑 Activation 的驻留周期构建生命周期观察者，使管理器发布
   * 其边而无需拥有事件分派。
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver {
    return createActivationObserver(this.emitLifecycle, provider, childId, parent)
  }

  /** 拒绝提供方所缺乏的第一个被请求能力。 */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    if (request.agentPreset !== undefined && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support independent agent preset selection`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.agentOptions !== undefined, cap: 'agentOptions' },
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }

}

export default SubagentRuntime
