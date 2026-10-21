/** 执行期记录、容量槽位、子代理序列化以及本地输出捕获。
 * @module @deepseek-ai/dsh-subagent/activation
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { finalAssistantOutput } from './assistant-output.ts'
import { epochStopReason } from './lifecycle.ts'
import type { ActivationObserver } from './lifecycle.ts'
import { SubagentError } from './error.ts'
import type { StructuredAttachment } from './structured.ts'
import type { SubagentResult, SubagentRun } from './types.ts'

/** 通过未被打断的可续跑父链接共享的进程本地槽位。 */
export class ActivationPool {
  private readonly slots = new Set<symbol>()

  /**
   * 在重建之前预留；释放时也容忍未发布的回滚。
   * @param capacity - 本池中同时激活的最大数量。
   * @returns 一个幂等的槽位释放函数。
   */
  reserve(capacity: number): () => void {
    if (this.slots.size >= capacity) {
      throw new SubagentError(
        `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish `
        + 'or complete this work with the current agents',
        'ACTIVATION_LIMIT_REACHED',
      )
    }
    const slot = Symbol()
    this.slots.add(slot)
    return () => { this.slots.delete(slot) }
  }
}

/**
 * 本地子代理或外部执行的一个驻留周期。
 * 管理器负责准入、执行句柄以及资源释放。
 */
interface ActivationBase {
  /** 本 Activation 及其所有被管理后代共享的容量。 */
  readonly pool: ActivationPool
  /** 在其句柄完成处置后归还本周期的槽位。 */
  readonly releaseSlot: () => void
  /** 本 Activation 所对应周期的持久化子代理。 */
  readonly childId: SessionId
  readonly parent: Agent
  readonly delivery: 'parent' | 'caller'
  readonly result: PromiseWithResolvers<SubagentResult>
  /** 在拆解之前同步发布；后续调用者共享此事务。 */
  closing: Promise<void> | undefined
  /**
   * 本 Activation 具现时所观测到的精确 Agent 实时血缘。
   * 弱成员关系在中间祖先离开注册表时不保留其运行时，从而保留
   * 宿主范围内的身份。
   */
  readonly ancestry: WeakSet<Agent>
  /**
   * 本 Activation 所拥有的子 Activation 的会话 id 集合。由于一个
   * 会话至多存在一个活跃的 Activation，该 id 可标识活跃子代理，
   * 无需另一处运行时 incarnation 引用。非空会阻塞结算。
   */
  readonly ownedChildren: Set<SessionId>
  /** 发出本周期起始与终止边的生命周期观察者。 */
  readonly observer: ActivationObserver
  /**
   * 是否曾接受过任何向该子代理的投递。若具现后在首次接受之前
   * 就回滚，对调用者而言这是一个被告知并不存在的子代理，因此其
   * 拆解不欠父代理任何结算账目。
   */
  announced: boolean
}

/** 仅针对所选执行类型保留的资源。 */
export type ActivationResource =
  | {
    readonly kind: 'local'
    readonly handle: AgentHandle
    readonly outputStart: SessionLogOffset
    readonly structured: StructuredAttachment | undefined
    /** 未被后续已提交轮次结束所取代的最新实时失败。 */
    failureAt: SessionLogOffset | undefined
    /** 当本地结算需要重新检查输入或所属子代理时刷新。 */
    poke: PromiseWithResolvers<void>
  }
  | {
    readonly kind: 'external'
    readonly run: SubagentRun
    readonly controller: AbortController
  }

/** 一段受管理的执行期及其提供方特定的资源。 */
export type Activation = ActivationBase & ActivationResource

/** 带有输入准入与 Session 支撑结果捕获的本地驻留。 */
export type LocalActivation = Extract<Activation, { kind: 'local' }>

/**
 * 读取本地执行所保留的实时 Agent。
 * @param activation - 受管理的本地或外部执行。
 * @returns 本地 Agent，外部运行则不存在。
 */
export function activationAgent(activation: Activation): Agent | undefined {
  return activation.kind === 'local' ? activation.handle.agent : undefined
}

/**
 * 在接受进一步输入之前要求本地驻留。
 * @param activation - 消息投递所针对的执行。
 * @returns 本地 activation。
 * @throws 当外部后端无法接受另一条消息时。
 */
export function requireLocalActivation(activation: Activation): LocalActivation {
  switch (activation.kind) {
    case 'local': return activation
    case 'external':
      throw new SubagentError(`subagent "${activation.childId}" does not accept follow-up input`, 'NOT_CONTINUABLE')
    /* v8 ignore next 2 -- 上述已处理两种执行类型。 */
    default: return assertNever(activation)
  }
}

/**
 * 保留那些轮次结束无法被提交的本地失败。
 * @param activation - 接收作用域观察者的精确本地 Agent 与周期。
 * @param wake - 当失败改变就绪状态时通知其结算监听器。
 */
export function observeLocalFailure(activation: LocalActivation, wake: () => void): void {
  const child = activation.handle.agent
  child.ctx.on('agent/error', ({ agent }) => {
    if (agent !== child) return
    activation.failureAt = child.session.seq
    wake()
  })
  child.ctx.on('session/event', (session, event) => {
    if (session === child.session && event.type === 'turn/end'
      && activation.failureAt !== undefined && event.seq >= activation.failureAt) {
      activation.failureAt = undefined
    }
  })
}

/**
 * 捕获本地输出并保留没有后续已提交轮次结束的失败。
 * @param activation - 已结算的本地执行及任何结构化结果。
 * @returns 最终输出、停止原因以及已提交的结构化值。
 */
export function captureLocalResult(activation: LocalActivation): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- 沿用既有 Session 历史读取；迁移暂缓。
  const events = activation.handle.agent.session.snapshotEvents(activation.outputStart)
  const output = finalAssistantOutput(events) ?? []
  const stopReason = activation.failureAt === undefined ? epochStopReason(events) : 'error'
  const structured = activation.structured
  if (structured !== undefined) {
    const captured = structured.captured()
    if (captured !== undefined) return { output, stopReason, structured: captured.value }
    if (stopReason === 'completed') return { output, stopReason: 'error' }
  }
  return { output, stopReason }
}

/** 对每个持久化子代理的投递、释放与处置进行串行化。 */
export class ChildLock {
  private tails = new Map<SessionId, Promise<unknown>>()

  /**
   * 在 `childId` 之前排队的每个操作之后运行 `operation`。
   * @param childId - 操作被线性化的持久化子代理。
   * @param operation - 按顺序运行的关键区段。
   * @returns 该操作自身的结算结果。
   */
  run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    // 在链式尾部吸收拒绝，使单个失败的关键区段不会拒绝无关的后续调用者。
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(childId, tail)
    void tail.then(() => {
      if (this.tails.get(childId) === tail) this.tails.delete(childId)
    })
    return result
  }
}
