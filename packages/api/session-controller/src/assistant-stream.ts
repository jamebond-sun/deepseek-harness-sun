/** 为重连的 Web 跟随者保留的进程本地 assistant 状态。 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAssistantStreamAttempt,
  SessionAssistantStreamBaseline,
} from './types.ts'

interface MutableAttempt {
  readonly attemptId: SessionAssistantStreamAttempt['attemptId']
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  readonly stream: AssistantStreamAccumulator
  nextIndex: number
}

const EMPTY_BASELINE: SessionAssistantStreamBaseline = { revision: 0 }

/**
 * 折叠稠密的 Agent 帧，并为每个被接受的修订
 * 物化一个共享的不可变重连基线。
 */
export class SessionAssistantStreamAccumulator {
  private activeAttempt: MutableAttempt | undefined
  private revision = 0
  private snapshotValue: SessionAssistantStreamBaseline = EMPTY_BASELINE
  private dirty = false

  /**
   * 折叠来自当前已附加 Agent 生命周期的一个受信任帧。
   * @param frame - 下一个稠密的进程本地 Assistant 帧。
   * @param durableCursor - 观察到该帧时最后已提交的 Session seq。
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.activeAttempt = undefined
      this.revision = 0
    }
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = undefined
      this.revision = frame.revision
      this.dirty = true
      return
    }
    this.revision = frame.revision
    switch (frame.type) {
      case 'start':
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: durableCursor,
          turn: frame.turn,
          step: frame.step,
          stream: new AssistantStreamAccumulator(),
          nextIndex: 0,
        }
        break
      case 'chunk': {
        const attempt = this.activeAttempt
        if (attempt === undefined
          || attempt.attemptId !== frame.attemptId
          || frame.index !== attempt.nextIndex) {
          this.activeAttempt = undefined
          break
        }
        attempt.stream.push({ time: frame.time, chunk: frame.chunk })
        attempt.nextIndex += 1
        break
      }
      case 'end':
        this.activeAttempt = undefined
        break
    }
    this.dirty = true
  }

  /**
   * 读取缓存的重连基线，在状态变化之后将其物化。
   * @returns 最新被接受修订的标识稳定基线。
   */
  snapshot(): SessionAssistantStreamBaseline {
    if (!this.dirty) return this.snapshotValue
    this.snapshotValue = {
      revision: this.revision,
      ...this.activeAttempt === undefined ? {} : {
        activeAttempt: {
          attemptId: this.activeAttempt.attemptId,
          startedAfterSeq: this.activeAttempt.startedAfterSeq,
          turn: this.activeAttempt.turn,
          step: this.activeAttempt.step,
          nextIndex: this.activeAttempt.nextIndex,
          stream: this.activeAttempt.stream.snapshot() as unknown as readonly JsonValue[],
        },
      },
    }
    this.dirty = false
    return this.snapshotValue
  }
}
