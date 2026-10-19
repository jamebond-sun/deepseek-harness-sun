/** 进程本地的 assistant 尝试框架化和持久流累积。 */

import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

/** 将单次模型尝试折叠为一个紧凑流加上按顺序的瞬态帧。 */
export class AssistantStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private index = 0
  private terminal = false
  /** 在此 Agent 生命周期内唯一的尝试身份。 */
  readonly attemptId: LlmAttemptId

  /** 此已启动的尝试是否已发出其终止帧。 */
  get ended(): boolean { return this.terminal }

  /**
   * @param sessionId - 仅嵌入在 Agent 生命周期本地尝试 id 中的身份。
   * @param attempt - 附加 Session 本地的尝试计数器。
   * @param nextRevision - 分配下一个已发出帧的修订号。
   * @param turn - 拥有该请求的持久 turn。
   * @param step - 拥有该请求的持久 step。
   * @param emit - agent 范围的通知发布器。
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`)
  }

  /** 在首个送达的块之前发布开始标记。 */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    })
  }

  /** 对单个块快照一次，然后馈送持久压缩、组装和活跃发布。 */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /**
   * 在匹配的持久事件提交之后发布终止结算。
   * @param eventType - 持久结算类型。
   * @param append - 同步的持久追加，返回其已提交的 seq。
   */
  settle(
    eventType: 'assistant/message' | 'assistant/attempt',
    append: () => SessionSeq,
  ): void {
    let seq: SessionSeq
    try {
      seq = append()
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** 在无法提交任何持久尝试事件时发布放弃。 */
  abandon(): void {
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  /** 最终持久事件的精确紧凑流。 */
  get stream(): SessionEventMap['assistant/attempt']['stream'] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** 来自相同块的规范化完成消息块。 */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /** 取消中断尝试时的安全可见前缀。 */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }

  /** 流中适配器报告的最新用量。 */
  get usage(): TokenUsage | undefined {
    return this.assembler.usage
  }

  /** 终止原因，流未提供时默认为 stop。 */
  get finish(): FinishReason {
    return this.assembler.finish
  }

  /** 终止 finish 记录携带的重放状态。 */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembler.replayState
  }
}
