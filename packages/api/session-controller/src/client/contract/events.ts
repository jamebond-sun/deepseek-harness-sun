/** 由领域组装方消费的可观察连续 Session 事件窗口。 */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LlmAttemptId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** 仅 Client 侧的实时块呈现；`seq` 用持久化 Session seq 之间的序号排定这一瞬态行。 */
export interface AssistantLiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: LlmAttemptId
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

/** 当前持久化 Session 事件，或一次仅 Client 侧的实时块呈现。 */
export type SessionEventLike = SessionEvent | AssistantLiveChunkEvent

/** 保留其粗粒度传输层判别符的 Client 历史条目。 */
export type SessionEventLikeEntry =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'transient'; readonly event: AssistantLiveChunkEvent }

/** 被 append-only Client 路径接受的标量实时条目。 */
export type SessionLiveEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'event' }>
/** 原子性取代某次 attempt 的瞬态行的持久化 Assistant 事件。 */
export interface SessionAssistantSettlementEntry {
  readonly type: 'event'
  readonly event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
}
/** 在持久化游标代数之外接纳的仅 Client 侧 Assistant 帧。 */
export type SessionTransientEventEntry = Extract<SessionEventLikeEntry, { readonly type: 'transient' }>

interface EventWindowLeaf {
  readonly kind: 'leaf'
  readonly entries: readonly SessionEventLikeEntry[]
  readonly length: number
}

interface EventWindowConcat {
  readonly kind: 'concat'
  readonly left: EventWindowNode
  readonly right: EventWindowNode
  readonly length: number
}

type EventWindowNode = EventWindowLeaf | EventWindowConcat

function leaf(entries: readonly SessionEventLikeEntry[]): EventWindowLeaf {
  return { kind: 'leaf', entries, length: entries.length }
}

function concat(left: EventWindowNode, right: EventWindowNode): EventWindowConcat {
  return { kind: 'concat', left, right, length: left.length + right.length }
}

function materialize(node: EventWindowNode): readonly SessionEventLikeEntry[] {
  if (node.kind === 'leaf') return node.entries
  const entries = new Array<SessionEventLikeEntry>(node.length)
  const pending: EventWindowNode[] = [node]
  let index = 0
  while (pending.length > 0) {
    const current = pending.pop() as EventWindowNode
    if (current.kind === 'concat') {
      pending.push(current.right, current.left)
      continue
    }
    for (const entry of current.entries) {
      entries[index] = entry
      index += 1
    }
  }
  return entries
}

function windowSnapshot(
  node: EventWindowNode,
  hasMore: boolean,
  revision: number,
  change: SessionEventChange,
): SessionEventWindow {
  let entries: readonly SessionEventLikeEntry[] | undefined
  return {
    get entries() {
      entries ??= materialize(node)
      return entries
    },
    hasMore,
    revision,
    change,
  }
}

/** 产生最新事件窗口修订的精确增量。 */
export type SessionEventChange =
  | { readonly kind: 'replace'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly SessionEventLikeEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly SessionEventLikeEntry[] }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: LlmAttemptId
    readonly entry?: SessionAssistantSettlementEntry
  }

/** 当前连续事件窗口及其最新同步增量。 */
export interface SessionEventWindow {
  readonly entries: readonly SessionEventLikeEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: SessionEventChange
}

/** 由单个 Session 绑定暴露的面向会话内容的事件源。 */
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>

/** Session 持有的事件馈送；每一次被接纳的窗口变更都同步发布。 */
export class MutableSessionEventSource implements SessionEventSource {
  private readonly listeners = new Set<() => void>()
  private window: EventWindowNode = leaf([])
  private snapshot: SessionEventWindow = windowSnapshot(
    this.window,
    false,
    0,
    { kind: 'replace', entries: [] },
  )

  /** @returns 缓存的事件窗口快照。 */
  getSnapshot(): SessionEventWindow { return this.snapshot }

  /**
   * 订阅同步窗口发布。
   * @param listener - 失效回调。
   * @returns 取消订阅函数。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 替换完整的连续窗口。
   * @param entries - 完整窗口。
   * @param hasMore - 是否仍有更早的历史。
   */
  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = leaf(entries)
    this.publish(hasMore, { kind: 'replace', entries })
  }

  /**
   * 前插一页更早的连续内容。
   * @param entries - 新加载的更早条目。
   * @param hasMore - 是否仍有更早的历史。
   */
  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.window = concat(leaf(entries), this.window)
    this.publish(hasMore, { kind: 'prepend', entries })
  }

  /**
   * 追加一条连续的实时条目。
   * @param entry - 实时尾部条目。
   */
  append(entry: SessionEventLikeEntry): void {
    const entries = [entry]
    this.window = concat(this.window, leaf(entries))
    this.publish(this.snapshot.hasMore, {
      kind: 'append',
      entries,
    })
  }

  /**
   * 用某次 attempt 已提交的持久化落定替换其瞬态行。
   * @param attemptId - 实时行现已冗余的进程本地 attempt。
   * @param entry - 该 attempt 已提交的持久化落定。
   */
  settleAssistant(attemptId: LlmAttemptId, entry?: SessionAssistantSettlementEntry): void {
    const entries = materialize(this.window).filter(candidate => (
      candidate.type !== 'transient' || candidate.event.data.attemptId !== attemptId
    ))
    if (entry !== undefined) {
      const index = entries.findIndex(candidate => candidate.event.seq > entry.event.seq)
      if (index < 0) entries.push(entry)
      else entries.splice(index, 0, entry)
    }
    this.window = leaf(entries)
    this.publish(this.snapshot.hasMore, {
      kind: 'settle-assistant',
      attemptId,
      ...(entry === undefined ? {} : { entry }),
    })
  }

  private publish(
    hasMore: boolean,
    change: SessionEventChange,
  ): void {
    this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change)
    notifySubscribers(this.listeners, '[session-controller] event feed')
  }
}
