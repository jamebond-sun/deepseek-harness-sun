/**
 * 驱动器拥有的持久 agent 收件箱投影与命令门面。
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** 对从持久收件箱拼接重建的待处理 agent 输入的线上验证。 */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** 重建待处理输入并拒绝无效持久拼接历史的标准折叠。 */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // 线上值就是折叠状态本身：每条待处理消息都已经
    // 以无损 JSON 在会话日志中往返。只有静态类型
    // 收窄到 JSON 安全的投影表条目。
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * 驱动器拥有的持久 Inbox 实现，供 ReactLoopAgent 和聚焦的
 * 提供方测试使用。
 * @param projections - 注册了由 AgentLoop 注册的标准 Inbox 投影的注册表。
 * @param session - 其持久事件存储待处理输入的会话。
 * @param dispatch - Inbox 生命周期事件的 agent 范围通知。
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** 等待各自 turn 的提示词。 */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** 等待下一个 step 边界的输入。 */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** 任一待处理消息列表是否包含工作。 */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** 持久取消所有待处理输入，先清空 next-step 再清空 next-turn。 */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * 移除并返回为一个步骤提议的完整批次。
   * @param target - 此边界是否还消耗一个排队的 turn。
   * @param turn - 将拥有被认领批次的 turn。
   * @returns next-step 输入，其后是排队的 turn（如请求）。
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * 向一个待处理列表追加一条消息。
   * @param target - 要扩展的待处理列表。
   * @param message - 要追加的消息。
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * 向一个待处理列表前插一条消息。
   * @param target - 要扩展的待处理列表。
   * @param message - 要前插的消息。
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * 原位替换一条待处理消息。
   * @param messageId - 要替换的待处理消息的身份。
   * @param newMessage - 替换消息。
   * @returns 该消息是否仍待处理。
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * 移除一条待处理消息。
   * @param messageId - 要移除的待处理消息的身份。
   * @returns 该消息是否仍待处理。
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * 应用标准 splice 语义并持久记录规范化后的结果。
   * @param target - 要变更的待处理列表。
   * @param start - splice 位置。
   * @param deleteCount - 可移除的最大消息数。
   * @param inserted - 要在解析后的位置插入的消息。
   * @returns 被 splice 移除的消息。
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** 在两个拥有的列表中定位单个待处理身份。 */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** 读取当前的持久投影状态。 */
  private current(): InboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /** 提交单个规范化变更并发布其活跃事件。 */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
