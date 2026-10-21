/**
 * 拥有子代理启动、消息准入、冷恢复与执行生命周期。一个子锁排序输入接受与
 * 关闭；一个激活映射拥有跨所有提供方的容量、父关系与资源释放。
 *
 * @module @deepseek-ai/dsh-subagent/manager
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, contentHasImage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides,
  childSessionMeta, resolveChildAgentOptions, resolveChildDepth,
} from './child-agent.ts'
import type { ChildComposition, DelegatedPolicyOverrides } from './child-agent.ts'
import { createAgentMessage, withContinuableReturnGuidance, createSettlementMessage } from './continuation-messages.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import type { SubagentDescriptorData } from './descriptor.ts'
import { establishCatalogChild, establishExternalCatalogChild } from './catalog.ts'
import { SubagentError } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { ActivationObserver } from './lifecycle.ts'
import type {
  ContinuableCreateRequest, ContinuableCreateSpec, SubagentInterruptAuthority,
  SubagentActivationSpec, SubagentActivation, SubagentStartRequest, SubagentRun,
  SubagentSendMessageOptions, SubagentResult, ResolvedSubagentStartRequest,
} from './types.ts'
import { attachStructuredRuntime } from './structured.ts'
import type { StructuredAttachment } from './structured.ts'
import type { SubagentDelivery } from './control-types.ts'
import { ActivationPool, ChildLock, activationAgent, captureLocalResult, observeLocalFailure, requireLocalActivation } from './activation.ts'
import type { Activation, ActivationResource, LocalActivation } from './activation.ts'

/** 模型转向与人类 prompt 投递所共享的输入。 */
type ChildDeliveryOptions =
  | {
    readonly delivery: 'steer'
    /**
     * 所提供的宿主来源会保留在 user message 上；省略则把一条相邻 Agent 消息
     * 归属给父代理。
     */
    readonly source?: MessageSource
    readonly signal: AbortSignal
  }
  | { readonly delivery: 'queue'; readonly source: MessageSource; readonly signal: AbortSignal }

/** 由所属 service 提供的包内私有钩子。 */
interface SubagentHost {
  startExternal(name: string, request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /** 解析一个提供方的、已分离的可续跑创建贡献。 */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /** 为一次 Activation 驻留周期构建生命周期观察者。 */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

/** 全新与恢复的 Activation 具现所共享的输入。 */
interface MaterializeBase {
  childId: SessionId
  provider: string
  parent: Agent
  signal: AbortSignal
  delivery?: 'parent' | 'caller' | undefined
}

/** 一次本地驻留或一次外部后端执行的创建输入。 */
type MaterializeInputs = MaterializeBase & (
  | {
    kind: 'local'
    /**
     * 创建输入；冷恢复时不存在，冷恢复加载已持久化的 session —— 包括一次
     * 全新创建所播种的委托策略事件，因此恢复永不重新捕获父代理的策略。
     */
    create?: {
      /** 在提供方准备之前捕获的绝对初始目录。 */
      cwd: string
      seed: readonly SessionEvent[] | undefined
      meta: NonNullable<CreateAgentOptions['meta']>
      /** {@link seed} 内部精确的父日志前缀长度。 */
      inheritedEventCount: SessionLogOffset
      /** 委托时捕获的策略：父代理的 sandbox 覆盖加上审批钉值。 */
      delegatedPolicies: DelegatedPolicyOverrides
      /** 在继承标记之后追加的子代理自有组合记录。 */
      descriptor: SubagentDescriptorData
    }
    agentOptions: AgentOptions
    composition: ChildComposition
    outputSchema?: ObjectJsonSchema | undefined
  }
  | { kind: 'external'; start: (signal: AbortSignal) => Promise<SubagentRun> }
)

/**
 * 一次已被接纳的具现，以及在其同步准入点观测到的精确实时血缘。保留身份
 * 使得即便某中间 Agent 在此期间离开注册表，作用域拆解仍可继续等待。
 */
interface Materialization {
  readonly lineage: readonly Agent[]
  readonly settled: Promise<void>
  readonly controller: AbortController
}

/** 自然结算观察者所观测到的驻留状态。 */
type SettlementState = 'closed' | 'retry' | 'wait' | 'ready'

/** 最终子锁结算决策的结果。 */
type SettlementAttempt =
  | Exclude<SettlementState, 'ready'>
  | { readonly done: Promise<void> }

/** 仅渲染来自执行或拆解失败的安全外层消息。 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown teardown failure'
}

/** 拥有子代理请求以及每个活跃激活的资源。 */
export class SubagentManager {
  /** 子 session id → 其活跃 Activation。进程本地，从不持久化。 */
  private readonly resident = new Map<SessionId, Activation>()
  /** 根身份在子结算期间保留其池，而不保留已死亡的根。 */
  private readonly rootPools = new WeakMap<Agent, ActivationPool>()
  /** 在 drain 之前被接纳的具现，被跟踪到发布或回滚。 */
  private readonly materializations = new Set<Materialization>()
  /** 由投递、释放与处置共享的、按子代理的串行器。 */
  private readonly locks = new ChildLock()
  /** 每个 Activation 句柄的结构性 Cordis 属主。 */
  private readonly ownerCtx: Context
  /**
   * 其宿主拆解已开始的精确根，以及每个根下观测到的活跃血缘成员。条目保留
   * 到该精确根离开 Agent 注册表为止，从而在其宿主拆解全程关闭准入，而不会
   * 污染之后同 id 的替代者。
   */
  private readonly closingScopes = new Map<Agent, Set<Agent>>()
  private draining = false

  /**
   * 在 service 的 Agent 注入上下文中构建一个管理器。
   * @param ctx - 提供 Agents、Sessions 与拆解属主的上下文。
   * @param host - 由 service 拥有的提供方分派与生命周期观测。
   * @param maxActiveSubagents - 当前已配置的子代理容量。
   */
  constructor(
    private readonly ctx: Context,
    private readonly host: SubagentHost,
    private readonly maxActiveSubagents: () => number,
  ) {
    // 普通 Cordis 属主 effect 以注册的逆序展开，无法表达动态子图。
    // 先注册私有作用域的结构性 disposer，再注册 drain，使逆序展开在释放
    // 作用域之前先调用 drain；一个与 Agent 句柄同作用域的清理 effect 会让
    // 结构性句柄处置绕过子优先顺序。
    const scope = ctx.plugin(function activationOwner() {})
    this.ownerCtx = scope.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.closingScopes.delete(agent)
    })
    ctx.effect(function* (this: SubagentManager) {
      yield scope.dispose
      yield () => this.drain()
    }.bind(this), 'subagents.manager()')
  }

  /**
   * 在所提供的授权下中断一个活着的可续跑子代理的当前轮次。
   * @param targetSessionId - 要中断的持久化子 session id。
   * @param authority - 人类父地址或精确的实时祖先 Agent。
   */
  interrupt(
    targetSessionId: SessionId,
    authority: SubagentInterruptAuthority,
  ): void {
    if (authority.kind === 'ancestor') {
      const caller = authority.agent
      if (this.ctx.agents.get(caller.id) !== caller) {
        throw new SubagentError(
          `interrupting "${targetSessionId}" requires the exact live ancestor agent`,
          'UNAUTHORIZED',
        )
      }
      if (caller.id === targetSessionId) {
        throw new SubagentError(
          `agent "${caller.id}" cannot interrupt itself`,
          'UNAUTHORIZED',
        )
      }
    }
    const activation = this.resident.get(targetSessionId)
    if (activation === undefined) return
    if (authority.kind === 'user') {
      if (activation.parent.id !== authority.parentSessionId) {
        throw new SubagentError(
          `subagent "${targetSessionId}" belongs to another parent session`,
          'UNAUTHORIZED',
        )
      }
    } else if (!activation.ancestry.has(authority.agent)) {
      throw new SubagentError(
        `subagent "${targetSessionId}" is not a live descendant of agent "${authority.agent.id}"`,
        'UNAUTHORIZED',
      )
    }
    // 处置已用一次整体 Activation 拆解停止了目标；第二次取消只是对
    // 一个正在关闭的句柄发出冗余信号。
    if (activation.closing !== undefined) return
    const kind = authority.kind === 'user' ? 'user' : 'parent'
    if (activation.kind === 'local') {
      activation.handle.agent.cancel({ kind }, { keepInbox: true })
    } else {
      activation.controller.abort({ kind })
      // 结算观察者报告拆解失败。
      void this.dispose(activation).catch(() => undefined)
    }
  }

  /**
   * 关闭准入，等待每个已被接纳的具现通过发布或回滚完成，然后以子优先
   * 处置稳定的活跃 Activation 图。
   */
  async drain(): Promise<void> {
    this.draining = true
    for (const pending of this.materializations) pending.controller.abort()
    await Promise.all([...this.materializations].map(materialization => materialization.settled))
    const owned = new Set<SessionId>()
    for (const activation of this.resident.values()) {
      for (const child of activation.ownedChildren) owned.add(child)
    }
    const roots = [...this.resident.values()].filter(activation => !owned.has(activation.childId))
    await this.disposeRoots(roots, 'activation(s)')
  }

  /**
   * 汇合正在推进的子工作，让空闲挂起的收件箱保持驻留。
   * @param parent - 观测其后代的精确实时父代理。
   * @returns 是否汇合了工作且宿主必须重新检查父代理的完成。
   */
  async waitForChildren(parent: Agent): Promise<boolean> {
    let observed = false
    while (true) {
      const pending = [...this.materializations].filter(item => item.lineage.includes(parent))
      const children = [...this.resident.values()].filter(item => activationAgent(item) !== parent && item.ancestry.has(parent))
      observed ||= children.some(item => item.kind === 'local' && item.handle.agent.status !== 'idle')
      await Promise.all(children.flatMap(item => item.kind === 'local' ? [item.handle.agent.whenIdle()] : []))
      const waits: Promise<unknown>[] = pending.map(item => item.settled)
      for (const item of children) {
        if (item.kind === 'external' || item.closing !== undefined) {
          waits.push(item.result.promise.catch(() => undefined))
          continue
        }
        if (item.handle.agent.status !== 'idle') {
          waits.push(item.handle.agent.whenIdle())
          continue
        }
        if (item.ownedChildren.size > 0) {
          // 已发布的后代被单独观测；准备持有的锁让属主保持 pending，
          // 直到发布或回滚唤醒它。
          if ([...item.ownedChildren].some(id => !this.resident.has(id))) waits.push(item.poke.promise)
          continue
        }
        const inbox = item.handle.agent.inbox
        if (item.failureAt === undefined && (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0)) continue
        waits.push(Promise.race([item.result.promise.catch(() => undefined), item.poke.promise]))
      }
      if (waits.length > 0) {
        observed = true
        await Promise.all(waits)
        continue
      }
      // 当 whenIdle 跟随另一个子代理时，一个后代可能已被发布。
      if ([...this.materializations].some(item => item.lineage.includes(parent) && !pending.includes(item))
        || [...this.resident.values()].some(item => activationAgent(item) !== parent
          && item.ancestry.has(parent) && !children.includes(item))) continue
      return observed
    }
  }

  /**
   * 停止精确实时宿主拥有父代理的受管理后代。
   * @param parents - 其受管理后代必须停止的精确实时根。
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const roots = new Set(parents.filter(parent => this.ctx.agents.get(parent.id) === parent))
    if (roots.size === 0) return

    for (const root of roots) {
      this.closingMembers(root).add(root)
    }

    const targets: Activation[] = []
    for (const activation of this.resident.values()) {
      const child = activationAgent(activation)
      const lineage = this.liveLineage(child ?? activation.parent)
      const owners = [...roots].filter(root => child !== root
        && activation.ancestry.has(root))
      if (owners.length === 0) continue
      targets.push(activation)
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        if (child !== undefined) members.add(child)
        for (const agent of lineage) members.add(agent)
      }
    }
    const materializations = [...this.materializations].filter((materialization) => {
      const owners = [...roots].filter(root => materialization.lineage.includes(root))
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        for (const agent of materialization.lineage) members.add(agent)
      }
      if (owners.length > 0) materialization.controller.abort()
      return owners.length > 0
    })

    const ownedTargets = new Set<SessionId>()
    for (const activation of targets) {
      for (const child of activation.ownedChildren) ownedTargets.add(child)
    }
    const targetRoots = targets.filter(activation => !ownedTargets.has(activation.childId))

    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }

    await Promise.all(materializations.map(materialization => materialization.settled))
    await this.disposeRoots(targetRoots, 'scoped activation(s)')
  }

  /**
   * 释放一个精确实时父代理所选定的驻留直接子代理。
   * @param parent - 授权此次选择性释放的精确实时直接父代理。
   * @param childIds - 驻留时要释放的持久化直接子 id。
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError('selected child teardown requires the exact live parent agent', 'UNAUTHORIZED')
    }
    const targets: Activation[] = []
    for (const childId of new Set(childIds)) {
      const activation = this.resident.get(childId)
      if (activation === undefined) continue
      if (activation.parent.id !== parent.id || !activation.ancestry.has(parent)) {
        throw new SubagentError(
          `subagent "${childId}" is not a direct child of agent "${parent.id}"`,
          'UNAUTHORIZED',
        )
      }
      targets.push(activation)
    }

    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }
    await this.disposeRoots(targets, 'selected activation(s)')
  }

  /**
   * 启动一个可续跑后台子代理，并在初始收件箱接受时解析。任何更早的失败
   * 都会处置任何已创建的句柄，并回滚 Activation 与父属主关系，而不返回
   * 任何一个 id。
   * @param spec - 提供方、委托请求与调用方取消。
   * @returns 持久化子 id 与已接受的初始 prompt 消息 id。
   */
  async startLocal(spec: SubagentActivationSpec): Promise<SubagentActivation & { messageId: MessageId }> {
    const request = spec.request
    const parent = request.parent
    this.assertAdmitting(parent)
    const persistence = spec.delivery === 'caller' ? this.ctx.get('sessionPersistence') : this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    const childId = spec.childId ?? brandString<SessionId>(randomUUID())
    this.assertChildIdAvailable(childId)
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // 在任何 await 之前快照：无效的描述符 JSON 会在子代理存在之前拒绝本次
    // 调用，而这个已分离的值才是最终进入日志的内容。
    const agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)
    const agentProvider = agentOptions.provider
    const agentModel = agentOptions.model
    const agentReasoningEffort = agentOptions.reasoningEffort
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...agentReasoningEffort !== undefined ? { agentReasoningEffort } : {},
    })
    // 在首次 await 之前捕获：父代理之后的切换属于父代理的未来，不属于该子代理。
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent)

    // 一个空闲的、由续跑管理的父代理不得在调用方仍在创建其子代理时结算。
    // 轮次作用域的委托不需要这一点，但本 service 也可在轮次之外被调用。
    const releaseHold = this.holdOwnership(parent, childId)
    try {
      const cwd = await this.resolveDirectory(request, spec.signal)
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        cwd,
        parent,
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.assertAdmitting(parent)
      const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      let established!: Activation
      const messageId = await this.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.assertAdmitting(parent)
        this.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence?.stat(childId, { signal: spec.signal })
          spec.signal.throwIfAborted()
          this.assertAdmitting(parent)
          this.assertChildIdAvailable(childId)
          if (persisted !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
        }
        const activation = await this.materialize({
          kind: 'local',
          childId,
          provider: spec.provider,
          parent,
          create: {
            cwd,
            seed,
            meta: childSessionMeta(parent, childDepth, prepared.seed !== undefined, request.agentPreset),
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
          },
          agentOptions,
          composition: { agentPreset: request.agentPreset },
          signal: spec.signal,
          delivery: spec.delivery,
          outputSchema: spec.request.outputSchema,
        })
        established = activation
        const child = requireLocalActivation(activation).handle.agent
        const childHeader = child.session.header
        return await this.submitMaterialized(
          activation,
          spec.delivery !== 'caller' && isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', child))
            ? withContinuableReturnGuidance(parent.id, request.prompt)
            : request.prompt,
          { source: { kind: 'user' }, signal: spec.signal, delivery: 'queue' },
          parent,
          () => {
            establishCatalogChild(parent.session, childHeader, descriptor)
          },
        )
      })
      return { ...this.receipt(established), childId, messageId }
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /**
   * 在激活属主关系下启动一个外部后端。
   * @param spec - 任务、提供方、取消与投递策略。
   * @returns 已被接纳的激活及其结果/处置能力。
   */
  async startExternal(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    const parent = spec.request.parent
    this.assertAdmitting(parent)
    const pendingId = brandString<SessionId>(randomUUID())
    const releaseHold = this.holdOwnership(parent, pendingId)
    let activation: Activation | undefined
    try {
      const cwd = await this.resolveDirectory(spec.request, spec.signal)
      activation = await this.materialize({
        kind: 'external',
        childId: pendingId,
        provider: spec.provider,
        parent,
        signal: spec.signal,
        delivery: spec.delivery,
        start: signal => this.host.startExternal(spec.provider, {
          ...spec.request, cwd, label: spec.label, signal,
        }),
      })
      this.assertAdmitting(parent)
      this.assertLiveParent(parent, activation.childId)
      spec.signal.throwIfAborted()
      if (spec.delivery === 'parent') {
        establishExternalCatalogChild(parent.session, activation.childId, spec.label)
      }
      this.announce(activation)
      return this.receipt(activation)
    } catch (error: unknown) {
      if (activation !== undefined) {
        try {
          await this.dispose(activation)
        } catch (cleanupError: unknown) {
          this.ctx.logger.warn(`subagent "${activation.childId}" admission rollback failed: ${failureMessage(cleanupError)}`)
        }
      }
      throw error
    } finally {
      releaseHold()
    }
  }

  /** 在父代理仍拥有启动时捕获显式或继承来的目录。 */
  private async resolveDirectory(request: Pick<SubagentStartRequest, 'parent' | 'cwd'>, signal: AbortSignal): Promise<string> {
    const cwd = request.cwd !== undefined && isAbsolute(request.cwd)
      ? request.cwd
      : resolve(await this.ctx.workingDirectory.ensure(request.parent, signal), request.cwd ?? '.')
    signal.throwIfAborted()
    return cwd
  }

  /**
   * 把一条模型撰写的消息投递给一个直接可续跑子代理，或投递给发送方的
   * 直接父代理。缺失的直接子代理通过普通的续跑生命周期冷恢复。
   * @param sender - 授权并发起该消息的精确实时 Agent。
   * @param targetId - 持久化的直接父或直接子 session id。
   * @param content - 待投递的模型撰写内容。
   * @param options - 在接受之前的调用方取消。
   * @returns 被接受消息的收件箱 id。
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError(
        'message delivery requires the exact live sender agent',
        'UNAUTHORIZED',
      )
    }
    this.assertAdmitting(sender)
    const senderActivation = this.resident.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.kind === 'local'
      && senderActivation.handle.agent === sender
      && senderActivation.parent.id === targetId) {
      options.signal.throwIfAborted()
      return this.sendToParent(senderActivation, sender, content)
    }
    if (sender.session.header.parentSession === targetId) {
      throw new SubagentError(
        `agent "${sender.id}" is not a resident continuable child and cannot send to parent "${targetId}"`,
        'UNAUTHORIZED',
      )
    }
    return this.deliverToChild(sender, targetId, content, {
      signal: options.signal,
      delivery: 'steer',
    })
  }

  /**
   * 把一条人类撰写的 prompt 作为一个独立的直接子轮次排队。
   * @param parent - 授权该投递的精确实时直接父代理。
   * @param childId - 持久化的直接子 session id。
   * @param content - 模型可见的 prompt 块。
   * @param source - 人类 prompt 的持久化归属。
   * @param signal - 在收件箱接受之前的调用方取消。
   * @returns 被接受的持久化消息 id。
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'queue' })
  }

  /**
   * 把一条宿主撰写的 prompt 转向一个直接可续跑子代理。
   * @param parent - 授权该投递的精确实时直接父代理。
   * @param childId - 持久化的直接子 session id。
   * @param content - 模型可见的 prompt 块。
   * @param source - 宿主 prompt 的持久化归属。
   * @param signal - 在收件箱接受之前的调用方取消。
   * @returns 被接受的持久化消息 id。
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return this.deliverToChild(parent, childId, content, { source, signal, delivery: 'steer' })
  }

  /** 在任何拆解开始之前同步接纳本地输入。 */
  private deliver(activation: Activation, message: UserMessage, delivery: SubagentDelivery): void {
    if (activation.closing !== undefined) {
      throw new SubagentError(
        'subagent activation is being disposed; the message was not accepted',
        'ACTIVATION_CLOSING',
      )
    }
    const local = requireLocalActivation(activation)
    if (local.structured?.acceptsInput() === false) {
      throw new SubagentError('subagent is submitting or has submitted its structured result; the message was not accepted', 'INPUT_CLOSED')
    }
    if (delivery === 'steer') local.handle.agent.steer(message)
    else local.handle.agent.followup(message)
  }

  /**
   * 拒收一个已被活跃 Agent 或 Session 拥有的子身份。
   * @param childId - 提议的持久化子 session id。
   */
  private assertChildIdAvailable(childId: SessionId): void {
    if (this.resident.has(childId) || this.ctx.agents.get(childId) !== undefined || this.ctx.get('sessions')?.get(childId) !== undefined) {
      throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
    }
  }

  /**
   * 把 `childId` 预注册进一个由续跑管理的父代理的所属集合，使父代理在调用方
   * 仍在建立或恢复该子代理时无法结算。为失败路径返回一个释放器；它只移除
   * 本次调用所添加的持有，一旦该子代理存在活跃的 Activation 就保留属主关系。
   * @param parent - 本次操作被接纳于其下的实时直接父代理。
   * @param childId - 本次操作所寻址的持久化子代理。
   * @returns 失败路径的释放器；未添加任何东西时为空操作。
   */
  private holdOwnership(parent: Agent, childId: SessionId): () => void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation === undefined || activationAgent(parentActivation) !== parent) return () => {}
    if (parentActivation.closing !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    if (parentActivation.ownedChildren.has(childId)) return () => {}
    parentActivation.ownedChildren.add(childId)
    return () => {
      const live = this.resident.get(childId)
      /* v8 ignore next 4 -- 到达该分支需要在本次操作失败与其释放器运行之间，
       * 由另一次投递建立该子代理，而没有测试能确定性地调度这件事：
       * 那时属主边属于那个活跃 Activation，因此保守的保留把它留给
       * finishDisposal 的 releaseOwnership。 */
      if (live !== undefined && live.closing === undefined) return
      if (parentActivation.ownedChildren.delete(childId)) this.wake(parentActivation)
    }
  }

  /**
   * 在投递输入之前对一个驻留父代理应用激活准入。
   * @param parent - 接收该消息的精确实时 Agent。
   * @param message - 待投递的持久化 user message。
   * @param delivery - 接收收件箱的目的地。
   */
  private sendWaking(parent: Agent, message: UserMessage, delivery: SubagentDelivery): void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation !== undefined && activationAgent(parentActivation) === parent) {
      try {
        this.deliver(parentActivation, message, delivery)
      } finally {
        this.wake(parentActivation)
      }
      return
    }
    if (delivery === 'steer') parent.steer(message)
    else parent.followup(message)
  }

  /**
   * 一旦管理器或这个精确的父树开始 drain，就拒收新的准入。
   * @param agent - 其血缘决定准入的精确实时 Agent。
   */
  private assertAdmitting(agent: Agent): void {
    const closing = this.closingTeardownFor(agent)
    if (closing === undefined) return
    throw new SubagentError(
      closing === 'manager'
        ? 'subagents are draining; the operation was not admitted'
        : `subagents below parent "${closing.id}" are draining; the operation was not admitted`,
      'DRAINING',
    )
  }

  /**
   * 针对持久化直接父血缘授权一次操作。
   * @param parent - 声称拥有直接父权限的精确实时 Agent。
   * @param childId - 本次操作所寻址的持久化子 session id。
   * @param parentSession - 子代理所记录的持久化直接父 id。
   */
  private authorizeLineage(
    parent: Agent,
    childId: SessionId,
    parentSession: SessionId | undefined,
  ): void {
    this.assertLiveParent(parent, childId)
    if (parentSession !== parent.id) {
      throw new SubagentError(`subagent "${childId}" belongs to another parent session`, 'UNAUTHORIZED')
    }
  }

  /** 在实时注册表条目变化之后拒绝父权限。 */
  private assertLiveParent(parent: Agent, childId: SessionId): void {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError(
        `subagent "${childId}" delivery requires the exact live parent agent`,
        'UNAUTHORIZED',
      )
    }
  }

  /**
   * 创建或恢复一个子 Agent 并发布其 Activation。
   * @param inputs - 驻留周期的重建与准入输入。
   * @returns 已发布的进程本地 Activation。
   */
  private materialize(inputs: MaterializeInputs): Promise<Activation> {
    this.assertAdmitting(inputs.parent)
    inputs.signal.throwIfAborted()
    const lineage = this.liveLineage(inputs.parent)
    const pool = this.resident.get(inputs.parent.id)?.pool ?? this.rootPool(inputs.parent)
    const releaseSlot = pool.reserve(this.maxActiveSubagents())
    const settled = Promise.withResolvers<void>()
    const controller = new AbortController()
    const materialization: Materialization = {
      lineage,
      settled: settled.promise,
      controller,
    }
    this.materializations.add(materialization)
    return this.materializeTracked(
      { ...inputs, signal: AbortSignal.any([inputs.signal, controller.signal]) }, lineage, pool, releaseSlot,
    ).catch((error: unknown) => {
      releaseSlot()
      if (error instanceof Error && error.name === 'AbortError') this.assertAdmitting(inputs.parent)
      throw error
    }).finally(() => {
      this.materializations.delete(materialization)
      settled.resolve()
    })
  }

  /**
   * 通过其记忆化的关闭事务停止并释放一个 Activation。
   * @param activation - 要关闭的精确驻留周期。
   * @returns 共享的关闭事务。
   */
  private dispose(activation: Activation): Promise<void> {
    return this.close(activation, () => this.finishDisposal(activation, true))
  }

  /** 同步关闭准入并共享一次释放，包括启动回滚。 */
  private close(activation: Activation, release: () => Promise<void>): Promise<void> {
    if (activation.closing !== undefined) return activation.closing
    const completion = Promise.withResolvers<void>()
    activation.closing = completion.promise
    void release().then(completion.resolve, completion.reject)
    return completion.promise
  }

  /** 处置独立的根，并在全部结算之后报告每个分支的失败。 */
  private async disposeRoots(
    roots: readonly Activation[],
    failureSubject: 'activation(s)' | 'scoped activation(s)' | 'selected activation(s)',
  ): Promise<void> {
    const failures = await Promise.all(roots.map(async (activation) => {
      try {
        await this.dispose(activation)
        return undefined
      } catch (error: unknown) {
        return error
      }
    }))
    const reasons = failures.filter(failure => failure !== undefined)
    if (reasons.length > 0) {
      throw new SubagentError(
        `subagent teardown failed for ${reasons.length} ${failureSubject}: `
        + reasons.map(reason => failureMessage(reason)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
      )
    }
  }

  /** 返回一个精确作用域拆解根的保留成员集合。 */
  private closingMembers(root: Agent): Set<Agent> {
    const existing = this.closingScopes.get(root)
    if (existing !== undefined) return existing
    const members = new Set<Agent>()
    this.closingScopes.set(root, members)
    return members
  }

  /** 返回从 `agent` 向上精确当前可解析的血缘。 */
  private liveLineage(agent: Agent): Agent[] {
    const lineage = [agent]
    const seen = new Set<SessionId>([agent.id])
    let parentSession = agent.session.header.parentSession
    while (parentSession !== undefined) {
      const parent = this.ctx.agents.get(parentSession)
      if (parent === undefined || seen.has(parent.id)) break
      lineage.push(parent)
      seen.add(parent.id)
      parentSession = parent.session.header.parentSession
    }
    return lineage
  }

  /** 返回为本 agent 血缘关闭了续跑准入的那次拆解。 */
  private closingTeardownFor(agent: Agent): Agent | 'manager' | undefined {
    if (this.draining) return 'manager'
    const lineage = this.liveLineage(agent)
    for (const [root, members] of this.closingScopes) {
      if (members.has(agent) || lineage.includes(root)) return root
    }
    return undefined
  }

  /** 解析一个根的池一次；后代直接继承其驻留父代理的池。 */
  private rootPool(parent: Agent): ActivationPool {
    let pool = this.rootPools.get(parent)
    if (pool === undefined) {
      pool = new ActivationPool()
      this.rootPools.set(parent, pool)
    }
    return pool
  }

  /** 通过发布或回滚执行一次被跟踪的具现。 */
  private async materializeTracked(
    inputs: MaterializeInputs,
    parentLineage: readonly Agent[],
    pool: ActivationPool,
    releaseSlot: () => void,
  ): Promise<Activation> {
    const { provider, parent } = inputs
    let childId = inputs.childId
    inputs.signal.throwIfAborted()
    let resource: ActivationResource
    if (inputs.kind === 'external') {
      const controller = new AbortController()
      const cancelStartup = (): void => { controller.abort(inputs.signal.reason) }
      inputs.signal.addEventListener('abort', cancelStartup, { once: true })
      try {
        const run = await inputs.start(controller.signal)
        resource = { kind: 'external', run, controller }
        void run.result.catch(() => undefined)
        childId = run.id
        try { this.assertChildIdAvailable(childId) } catch (error: unknown) {
          await run.dispose()
          throw error
        }
      } finally {
        inputs.signal.removeEventListener('abort', cancelStartup)
      }
    } else {
      const { create } = inputs
      let structured: StructuredAttachment | undefined
      const setup = async (childCtx: Context, child: Agent): Promise<void> => {
        // 只有全新创建会在继承标记之后追加描述符与委托策略；
        // 冷恢复重放那些已持久化的事件。
        if (inputs.composition.agentPreset !== undefined) {
          await applyChildComposition(childCtx, parent, inputs.composition)
        }
        if (create !== undefined) {
          if (inputs.composition.agentPreset !== undefined) {
            child.session.append('agent-preset/selected', { agentPreset: inputs.composition.agentPreset })
          }
          child.session.append('subagent/descriptor', create.descriptor)
          appendDelegatedPolicyOverrides(child.session, create.delegatedPolicies)
          const workingDirectory = childCtx.get('workingDirectory')
          if (workingDirectory === undefined) throw new Error('local subagents require the working-directory service')
          await workingDirectory.set(child, create.cwd, inputs.signal)
        }
        if (inputs.composition.agentPreset === undefined) await applyChildComposition(childCtx, parent, inputs.composition)
        if (inputs.outputSchema !== undefined) {
          structured = attachStructuredRuntime(childCtx, inputs.outputSchema, () =>
            this.resident.get(childId)?.ownedChildren.size === 0
            && child.inbox.nextStep.length === 0
            && child.inbox.nextTurn.length === 0,
          )
        }
      }
      const handle = create === undefined
        ? await this.ownerCtx.agents.resume({
          resumeSessionId: childId,
          parentAgent: parent,
          agentOptions: inputs.agentOptions,
          signal: inputs.signal,
          setup,
        })
        : await this.ownerCtx.agents.create({
          sessionId: childId,
          parentAgent: parent,
          meta: create.meta,
          ...(create.seed === undefined ? {} : { seed: create.seed }),
          inheritedEventCount: create.inheritedEventCount,
          agentOptions: inputs.agentOptions,
          signal: inputs.signal,
          setup,
        })

      resource = { kind: 'local', handle, outputStart: handle.agent.session.seq, structured, failureAt: undefined, poke: Promise.withResolvers<void>() }
    }
    const observer = this.host.observeActivation(provider, childId, parent)

    const activation: Activation = {
      pool,
      releaseSlot,
      childId,
      ...resource,
      parent,
      delivery: inputs.delivery ?? 'parent',
      result: Promise.withResolvers<SubagentResult>(),
      closing: undefined,
      ancestry: new WeakSet(resource.kind === 'external' ? parentLineage : [resource.handle.agent, ...parentLineage]),
      ownedChildren: new Set(),
      observer,
      announced: false,
    }
    void activation.result.promise.catch(() => undefined)
    this.resident.set(childId, activation)
    try {
      this.assertAdmitting(parent)
      inputs.signal.throwIfAborted()
      if (this.ctx.agents.get(parent.id) !== parent) throw new SubagentError('subagent parent is no longer live', 'UNAUTHORIZED')
      this.acquireOwnership(parent, childId)
      const wakeSettlement = (): void => { this.wake(activation) }
      if (activation.kind === 'local') {
        observeLocalFailure(activation, wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/inserted', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/claimed', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/discarded', wakeSettlement)
      }
      observer.start(activationAgent(activation))
    } catch (error: unknown) {
      /* v8 ignore next -- 回滚失败不得掩盖导致本次操作无法返回已接受
       * 消息 id 的那次准入失败。 */
      await this.rollbackUnpublished(activation, error).catch(() => undefined)
      throw error
    }
    return activation
  }

  /**
   * 在记录初始接受之后开始结算观测。
   * @param activation - 要观测的、已被接纳的激活。
   */
  private announce(activation: Activation): void {
    if (activation.announced) return
    activation.announced = true
    if (activation.kind === 'local') {
      this.watchLocalSettlement(activation)
    } else {
      const finish = (): Promise<void> => this.close(activation, () => this.finishDisposal(activation, false))
      void activation.run.result.then(finish, finish).catch((error: unknown) => { this.reportTeardownFailure(activation, error) })
    }
  }

  /** 释放一个其起始边未被发布的 Activation。 */
  private rollbackUnpublished(activation: Activation, error: unknown): Promise<void> {
    return this.close(activation, async () => {
      try {
        await (activation.kind === 'local' ? activation.handle.dispose() : activation.run.dispose())
      } finally {
        this.resident.delete(activation.childId)
        activation.releaseSlot()
        this.releaseOwnership(activation.childId)
        activation.result.reject(error)
      }
    })
  }

  /** 把子代理注册进一个由续跑管理的父代理的所属集合。 */
  private acquireOwnership(parent: Agent, childId: SessionId): void {
    const parentActivation = this.resident.get(parent.id)
    if (parentActivation === undefined) return
    if (parentActivation.closing !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    parentActivation.ownedChildren.add(childId)
    this.wake(parentActivation)
  }

  /** 把一个子代理从其活跃属主的集合中移除，并让该属主重新检查结算。 */
  private releaseOwnership(childId: SessionId): void {
    for (const candidate of this.resident.values()) {
      if (candidate.ownedChildren.delete(childId)) this.wake(candidate)
    }
  }

  /** 在相关状态变化后让结算观察者重新检查驻留状态。 */
  private wake(activation: Activation): void {
    if (activation.kind === 'external') return
    activation.poke.resolve()
    activation.poke = Promise.withResolvers<void>()
  }

  /** 跟随一个 Activation 直到自然结算。 */
  private watchLocalSettlement(activation: LocalActivation): void {
    void (async () => {
      while (true) {
        const idleObservation = activation.poke
        await activation.handle.agent.whenIdle()
        if (activation.closing !== undefined) return
        const readiness = await this.locks.run(activation.childId, () => Promise.resolve(
          this.settlementState(activation, idleObservation),
        ))
        if (readiness === 'closed') return
        if (readiness === 'retry') continue
        if (readiness === 'wait') {
          await idleObservation.promise
          continue
        }

        const finalSeq = activation.handle.agent.session.seq
        await this.flushFinalState(activation)
        const attempt = await this.locks.run<SettlementAttempt>(activation.childId, () => {
          const state = this.settlementState(activation, idleObservation)
          if (state !== 'ready') return Promise.resolve(state)
          if (activation.handle.agent.session.seq !== finalSeq) {
            return Promise.resolve('retry')
          }
          let done!: Promise<void>
          try {
            void activation.handle.agent.runMaintenance(() => {
              done = this.close(activation, () => this.finishDisposal(activation, false))
              return Promise.resolve()
            })
          } catch (_error: unknown) {
            // 另一个活动已拥有该 Agent 的空闲阶段。
            return Promise.resolve('retry')
          }
          return Promise.resolve({ done })
        })

        if (typeof attempt === 'string') {
          if (attempt === 'closed') return
          continue
        }
        try {
          await attempt.done
        } catch (error: unknown) {
          this.reportTeardownFailure(activation, error)
        }
        return
      }
    })()
  }

  /** 在自然结算观察者结束后报告一次处置失败。 */
  private reportTeardownFailure(activation: Activation, error: unknown): void {
    this.ctx.logger.warn(`subagent "${activation.childId}" activation teardown failed: ${failureMessage(error)}`)
  }

  /** 在关闭准入之前检查待处理输入与所属子代理。 */
  private settlementState(
    activation: LocalActivation,
    observation: PromiseWithResolvers<void>,
  ): SettlementState {
    if (activation.closing !== undefined) return 'closed'
    if (activation.poke !== observation) return 'retry'
    const inbox = activation.handle.agent.inbox
    if (activation.ownedChildren.size > 0) return 'wait'
    if (activation.failureAt === undefined && (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0)) return 'wait'
    return 'ready'
  }

  /** 同步传播停止，并在释放之前等待后代启动回滚。 */
  private async finishDisposal(activation: Activation, stop: boolean): Promise<void> {
    this.wake(activation)
    const { childId } = activation
    const failures: SubagentError[] = []
    let result: SubagentResult = { output: [], stopReason: 'error' }
    let resultFailure: { error: unknown } | undefined
    let externalDisposal: Promise<void> | undefined
    const child = activationAgent(activation)
    const detail = (error: unknown): string => child === undefined
      ? failureMessage(error)
      : errorChain(error)
    try {
      if (activation.kind === 'external') {
        if (stop) {
          activation.controller.abort({ kind: 'parent' })
          // 某些后端只在处置开始时才结算其结果。
          externalDisposal = Promise.resolve().then(() => activation.run.dispose())
          void externalDisposal.catch(() => undefined)
        }
        result = await activation.run.result
      } else {
        if (stop) {
          activation.handle.agent.cancel({ kind: 'parent' })
          const idle = activation.handle.agent.whenIdle()
          const children = [...activation.ownedChildren]
            .map(child => this.resident.get(child))
            .filter((child): child is Activation => child !== undefined)
          const pending = [...this.materializations].filter(item => item.lineage.includes(activation.handle.agent))
          const childDisposals = children.map(child => this.dispose(child))
          for (const item of pending) item.controller.abort()
          childDisposals.push(...pending.map(item => item.settled))
          const childFailures = await Promise.all(childDisposals.map(async (disposal) => {
            try {
              await disposal
              return undefined
            } catch (error: unknown) {
              return error
            }
          }))
          const reasons = childFailures.filter(reason => reason !== undefined)
          if (reasons.length > 0) {
            failures.push(new SubagentError(
              `subagent "${childId}" child teardown failed: ${reasons.map(reason => failureMessage(reason)).join('; ')}`,
              'ACTIVATION_TEARDOWN_FAILED',
            ))
          }
          await idle
          await this.flushFinalState(activation)
        }
        result = captureLocalResult(activation)
      }
    } catch (error: unknown) {
      resultFailure = { error }
      failures.push(new SubagentError(
        `subagent "${childId}" activation teardown failed: ${detail(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }
    try {
      if (activation.kind === 'local') await activation.handle.dispose()
      else await (externalDisposal ?? activation.run.dispose())
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation handle disposal failed: ${detail(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }

    let failure: SubagentError | undefined
    if (failures.length === 1) {
      failure = failures[0]
    } else if (failures.length > 1) {
      failure = new SubagentError(
        `subagent "${childId}" activation teardown failed at ${failures.length} boundaries: `
        + failures.map(item => detail(item)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: new AggregateError(failures) },
      )
    }
    this.resident.delete(childId)
    activation.releaseSlot()
    const terminal: SubagentResult = failure === undefined ? result : { output: [], stopReason: 'error' }
    this.notifySettlement(activation, result)
    this.releaseOwnership(childId)
    activation.observer.settle(terminal)
    if (resultFailure === undefined) activation.result.resolve(result)
    else activation.result.reject(resultFailure.error)
    if (failure !== undefined) throw failure
  }

  /** 在清理之后把捕获的执行结果投递给持久化直接父代理。 */
  private notifySettlement(activation: Activation, terminal: SubagentResult): void {
    if (!activation.announced || activation.delivery === 'caller') return
    try {
      const parent = this.ctx.agents.get(activation.parent.id)
      if (parent !== activation.parent) return
      const message = createSettlementMessage(
        activation.childId, terminal, activationAgent(activation) !== undefined,
      )
      if (this.closingTeardownFor(parent) !== undefined) {
        parent.inject(message)
        return
      }
      this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" settlement notice was not delivered to its parent: `
        + errorChain(error),
      )
    }
  }

  /** 在关闭自然结算准入之前请求一次尽力而为的最终 session 刷写。 */
  private async flushFinalState(activation: LocalActivation): Promise<void> {
    try {
      await activation.handle.agent.ctx.sessions.flush(activation.handle.agent.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" best-effort final session flush failed; `
        + `the persisted state may be unavailable or stale on resume: ${errorChain(error)}`,
      )
    }
  }

  /** 返回绑定到精确激活而非未来同 id 实例的能力。 */
  private receipt(activation: Activation): SubagentActivation {
    return {
      childId: activation.childId,
      result: activation.result.promise,
      dispose: () => this.dispose(activation),
    }
  }

  /** 把一次源自父代理的投递经由驻留与冷恢复路由。 */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    this.assertAdmitting(parent)
    const releaseHold = this.holdOwnership(parent, childId)
    try {
      return await this.deliverFollowup(parent, childId, content, options)
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** {@link deliverToChild} 背后的投递循环，在父持有之下运行。 */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    while (true) {
      const live = await this.locks.run(childId, async () => {
        const activation = this.resident.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        requireLocalActivation(activation)
        const disposal = activation.closing
        /* v8 ignore next 3 -- 发送与处置的分界需要一次投递在同一个
         * 开启它的关键区段之内观测到该事务。 */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(requireLocalActivation(activation).handle.agent, options.signal)
          if (activation.closing !== undefined) {
            await Promise.allSettled([activation.closing])
            return undefined
          }
        }
        const messageId = this.submitAdmitted(activation, content, options, parent)
        this.announce(activation)
        return messageId
      })
      /* v8 ignore start -- 只有输掉了处置分界的投递才会重试。 */
      if (live !== undefined) return live
      this.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /** 把一个驻留可续跑子代理的消息投递给其活跃直接父代理。 */
  private sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
  ): MessageId {
    /* v8 ignore next 6 -- 只有同步的可重入拆解能在精确 agent 授权与这段
     * 无 await 区间之间开启该事务。 */
    if (activation.closing !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parent.id)
    if (parent !== activation.parent) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = createAgentMessage(sender, content)
    this.sendAgentMessage(parent, message)
    return message.id
  }

  /** 发送一条 Agent 消息，同时只转译目标自身的拒绝。 */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): void {
    try {
      this.sendWaking(parent, message, 'steer')
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /**
   * 冷恢复一个已持久化的子代理并提交等待中的轮次。描述符提供每个重建输入；
   * 不派发任何子代理提供方。
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
    const query = this.requireSessionQuery()
    let observation: SessionObservation
    try {
      observation = await query.observeSession(childId, {
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    using source = observation
    this.assertAdmitting(parent)
    this.authorizeLineage(parent, childId, source.header.parentSession)
    const ownEvents = source.events.slice(source.inheritedEventCount)
    const descriptor = foldSubagentDescriptor(ownEvents)
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      const independentlySelected = hasIndependentPresetSelection(ownEvents)
      const agentPreset = independentlySelected ? source.projections?.values.agentPreset : undefined
      if (independentlySelected && typeof agentPreset !== 'string') {
        throw new SubagentError(`subagent "${childId}" has no agent preset projection for restoration`, 'NOT_RESUMABLE')
      }
      activation = await this.materialize({
        kind: 'local',
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { agentPreset: agentPreset ?? undefined, persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** 接纳一个已具现的子代理，提交其创建事实，并在失败时释放它。 */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
    commit?: () => void,
  ): Promise<MessageId> {
    try {
      if (contentHasImage(content)) {
        await this.assertImageCapable(requireLocalActivation(activation).handle.agent, options.signal)
        if (activation.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      const messageId = this.submitAdmitted(activation, content, options, parent)
      commit?.()
      this.announce(activation)
      return messageId
    } catch (error: unknown) {
      try {
        await this.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission or catalog append failure also failed: ${String(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** 跨最终的同步准入分界构建并提交一条消息。 */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): MessageId {
    const message = options.source === undefined
      ? createAgentMessage(parent, content)
      : createUserMessage({ content, source: options.source })
    options.signal.throwIfAborted()
    this.assertAdmitting(parent)
    this.authorizeLineage(parent, activation.childId, activation.parent.id)
    this.acquireOwnership(parent, activation.childId)
    try {
      this.deliver(activation, message, options.delivery)
    } finally {
      this.wake(activation)
    }
    return message.id
  }

  /** 为其固定模型只接受文本的子代理拒收图片内容。 */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- 没有 LLM 注册表时，投递推迟到投影。 */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** 解析可续跑子代理所需的持久化服务，否则响亮失败。 */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }

  /** 解析用于冷子观测的 Session 查询服务。 */
  private requireSessionQuery(): SessionQueryEngine {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new SubagentError(
        'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return query
  }
}

export default SubagentManager

/** 创建时的选择先于自身描述符；历史 fork 可以在其后选择。 */
function hasIndependentPresetSelection(events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type === 'subagent/descriptor') return false
    if (event.type === 'agent-preset/selected') return true
  }
  /* v8 ignore next -- coldResume 在该查找之前就拒绝没有受支持自身描述符的日志。 */
  return false
}
