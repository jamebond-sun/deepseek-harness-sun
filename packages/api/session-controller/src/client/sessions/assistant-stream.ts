/** 把瞬态 Assistant 帧折叠到一次持久化 v2 落定的 Web 呈现层。 */

import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
} from '../../types.ts'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type {
  SessionAssistantSettlementEntry,
  SessionEventLikeEntry,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from '../contract/events.ts'

interface ActiveAttempt {
  readonly attemptId: LlmAttemptId
  readonly startedAfterSeq: number
  readonly turn: number
  readonly step: number
  nextIndex: number
}

/** assistant 流折叠的一次 Web 发布决策。 */
export type ClientAssistantStreamResult =
  | {
    readonly type: 'publish'
    readonly entry: SessionLiveEventEntry
    /** 在发布其 Step 结束之后退役该成功 attempt 的瞬态行。 */
    readonly retireAttemptId?: LlmAttemptId
  }
  | {
    readonly type: 'settlement'
    readonly attemptId: LlmAttemptId
    readonly entry: SessionAssistantSettlementEntry
  }
  | { readonly type: 'abandonment'; readonly attemptId: LlmAttemptId }
  | { readonly type: 'transient'; readonly entry: SessionTransientEventEntry }
  | { readonly type: 'rebaseline' }
  | undefined

/** 让瞬态 Assistant 呈现保持在一个感知落定的接口之后。 */
export class ClientAssistantStream {
  private activeAttempt: ActiveAttempt | undefined
  private retainedAttempt: Pick<ActiveAttempt, 'attemptId' | 'turn' | 'step'> | undefined
  private readonly pending = new Map<number, SessionAssistantSettlementEntry>()
  private publishedSeqs = new Set<number>()
  private durableCursor = -1
  private transientInGap = 0

  /**
   * 替换持久化 Web 窗口并采纳一个可选的重连基线。
   * @param entries - 替换窗口中的持久化条目。
   * @param baseline - 仍存活的 Assistant attempt 的紧凑前缀。
   * @returns 立即可见的持久化条目加上重建的瞬态块。
   */
  replace(
    entries: readonly SessionEventLikeEntry[],
    baseline?: SessionAssistantStreamBaseline,
  ): readonly SessionEventLikeEntry[] {
    this.pending.clear()
    this.transientInGap = 0
    this.activeAttempt = undefined
    this.retainedAttempt = undefined
    const opening = baseline?.activeAttempt
    if (opening !== undefined) {
      this.activeAttempt = {
        attemptId: opening.attemptId,
        startedAfterSeq: opening.startedAfterSeq,
        turn: opening.turn,
        step: opening.step,
        nextIndex: opening.nextIndex,
      }
    }
    const visible: SessionEventLikeEntry[] = [...entries]
    this.publishedSeqs = new Set(visible.map(entry => entry.event.seq))
    this.durableCursor = visible.reduce((cursor, entry) => Math.max(cursor, entry.event.seq), -1)
    if (opening !== undefined) {
      for (const [index, member] of expandAssistantStream(
        opening.stream as unknown as readonly AssistantStreamRecord[],
      ).entries()) {
        this.transientInGap += 1
        visible.push({
          type: 'transient',
          event: {
            type: 'assistant/live-chunk',
            seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
            time: member.time,
            data: {
              attemptId: opening.attemptId,
              turn: opening.turn,
              step: opening.step,
              chunk: member.chunk,
            },
          },
        })
        if (index + 1 >= opening.nextIndex) break
      }
    }
    return visible
  }

  /**
   * 在其匹配的实时 attempt 仍开启时暂存一次持久化 v2 落定。
   * @param entry - 新跟随到的持久化条目。
   * @returns 一个发布决策，或在没有条目变为可见时返回 `undefined`。
   */
  acceptDurable(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    const event = entry.event
    this.durableCursor = Math.max(this.durableCursor, event.seq)
    this.transientInGap = 0
    const settlement = assistantSettlementEntry(entry)
    if (settlement !== undefined && this.attemptForSettlement(settlement.event) !== undefined) {
      if (this.pending.has(event.seq)) return { type: 'rebaseline' }
      this.pending.set(event.seq, settlement)
      return undefined
    }
    return this.publish(entry)
  }

  /**
   * 折叠一个稠密的瞬态帧并释放其指名的持久化落定。
   * 成功的消息保留其瞬态行，直到所属的 Step 结束；
   * 被打断的消息、失败的 attempt 与放弃会立即退役它们。
   * @param frame - 跟随连接收到的下一个 Assistant 流帧。
   * @returns 瞬态、发布或重新定基线决策，或在没有条目变为可见时返回 `undefined`。
   */
  acceptFrame(frame: SessionAssistantStreamFrame): ClientAssistantStreamResult {
    switch (frame.type) {
      case 'start':
        if (this.activeAttempt !== undefined || this.retainedAttempt !== undefined
          || this.pending.size > 0) return { type: 'rebaseline' }
        this.pending.clear()
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: frame.startedAfterSeq,
          turn: frame.turn,
          step: frame.step,
          nextIndex: 0,
        }
        return undefined
      case 'chunk': {
        const attempt = this.activeAttempt
        // 在 Host 看到该 attempt 之后才挂载的控制器没有可用的
        // start 帧来重建。其持久化落定直接发布；
        // 在下一个已知 start 之前忽略瞬态后缀。
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) return undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        attempt.nextIndex += 1
        this.transientInGap += 1
        return {
          type: 'transient',
          entry: {
            type: 'transient',
            event: {
              type: 'assistant/live-chunk',
              seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
              time: frame.time,
              data: {
                attemptId: frame.attemptId,
                turn: attempt.turn,
                step: attempt.step,
                chunk: frame.chunk as never,
              },
            },
          },
        }
      }
      case 'end': {
        const attempt = this.activeAttempt
        if (attempt === undefined || attempt.attemptId !== frame.attemptId) {
          return undefined
        }
        this.activeAttempt = undefined
        if (frame.index !== attempt.nextIndex) return { type: 'rebaseline' }
        if (frame.outcome.kind === 'abandoned') {
          return this.pending.size === 0
            ? { type: 'abandonment', attemptId: attempt.attemptId }
            : { type: 'rebaseline' }
        }
        if (this.publishedSeqs.has(frame.outcome.seq)) return undefined
        const entry = this.pending.get(frame.outcome.seq)
        if (entry === undefined
          || entry.event.type !== frame.outcome.eventType) {
          return { type: 'rebaseline' }
        }
        this.pending.delete(frame.outcome.seq)
        if (entry.event.type === 'assistant/message' && entry.event.data.interrupted !== true) {
          this.retainedAttempt = { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step }
          return this.publish(entry)
        }
        this.publishedSeqs.add(entry.event.seq)
        return { type: 'settlement', attemptId: attempt.attemptId, entry }
      }
    }
  }

  private attemptForSettlement(
    event: SessionAssistantSettlementEntry['event'],
  ): ActiveAttempt | undefined {
    const attempt = this.activeAttempt
    if (attempt === undefined
      || (event.type === 'assistant/message' && event.surfaceOp !== 'append')
      || event.seq <= attempt.startedAfterSeq
      || attempt.turn !== event.data.turn
      || attempt.step !== event.data.step) return undefined
    return attempt
  }

  private publish(entry: SessionLiveEventEntry): ClientAssistantStreamResult {
    this.publishedSeqs.add(entry.event.seq)
    const retained = this.retainedAttempt
    if (retained !== undefined && entry.event.type === 'step/end'
      && entry.event.data.turn === retained.turn && entry.event.data.step === retained.step) {
      this.retainedAttempt = undefined
      return { type: 'publish', entry, retireAttemptId: retained.attemptId }
    }
    return { type: 'publish', entry }
  }
}

function assistantSettlementEntry(
  entry: SessionLiveEventEntry,
): SessionAssistantSettlementEntry | undefined {
  return entry.event.type === 'assistant/message' || entry.event.type === 'assistant/attempt'
    ? entry as SessionAssistantSettlementEntry
    : undefined
}
