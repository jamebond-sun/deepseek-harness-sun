/**
 * 面向失败的活跃 step、中断日志与分叉 seed 共享的待处理工具结果恢复。尾部
 * 修复保留已关闭的 step，只补充缺失的工具结果与生命周期边界，并给出按原因
 * 区分的重试指引。
 * @module @deepseek-ai/dsh-session/repair
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/** 未到达已记录调用开始的 assistant 工具请求的恢复码。 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** 已记录工具调用的完成结果未被持久记录时的恢复码。 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * 打开的尾部 turn 以合成事件关闭的原因：`interrupted` 是对持久化日志的崩溃
 * 恢复；`forked` 是分叉 seed 在源打开 turn 内部切分。原因决定合成的
 * `turn/end` 原因、合成错误工具结果的模型可见措辞，以及确定性的合成
 * message-id 前缀。错误码（{@link TOOL_NOT_STARTED} /
 * {@link TOOL_OUTCOME_UNKNOWN}）共享：两种原因对调用的已记录生命周期陈述
 * 相同事实。
 */
export type OpenTurnCloseCause = { readonly kind: 'interrupted' } | { readonly kind: 'forked' }

/** 按原因键入的合成错误工具结果的模型可见措辞。 */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
} as const

/**
 * 返回关闭打开尾部 turn 的确定性合成事件。未配对的调用先收到错误结果，随
 * 后是打开的 `step/end` 与按原因区分的 `turn/end`；序号延续日志，时间戳复
 * 用最后一个真实事件。平衡或空日志不返回事件。
 *
 * @param events - 要扫描的已加载持久日志（一个有效的已提交前缀，可能带崩
 *   溃尾部）。
 * @param cause - 所属关闭操作：决定结果措辞与 turn 结束原因。
 * @returns 要按顺序追加到 `events` 之后的合成收尾事件；日志已平衡时为空。
 */
export function openTurnClosers(events: readonly SessionEvent[], cause: OpenTurnCloseCause): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  const recovery = new ToolCallRecovery(cause)
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // 其他事件类型不移动 turn/step 边界游标。
      default:
        break
    }
  }

  // 平衡日志（无打开尾部 turn）：无需关闭。打开的 turn 蕴含 `events` 非空
  // （其 turn/start 已记录），因此 `last` 存在。
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // 最后一个真实事件提供 seq 基准与合成收尾事件的时间戳（复用最后一个时间
  // 戳使它们确定，且绝不编造"未来"时间）。
  const closers: SessionEvent[] = recovery.results()
  let seq = last.seq + closers.length + 1
  const time = last.time

  // 在其 turn 之前关闭打开的 step。
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/**
 * 跟踪一个 Session 已提交事件中未应答的 assistant 工具请求。从所属 step 的
 * 开始或回放前缀开始观察，并在其 step 关闭前恢复。该状态保留待处理身份，
 * 不保留事件历史。
 */
export class ToolCallRecovery {
  private readonly pendingCalls = new Map<ToolCallId, { turn: number; step: number; callSeq?: SessionSeqType }>()
  private last: Pick<SessionEvent, 'seq' | 'time'> | undefined

  /** @param cause - 默认为中断的活跃/崩溃恢复；分叉 seed 构造提供自己的原因。 */
  constructor(private readonly cause: OpenTurnCloseCause = { kind: 'interrupted' }) {}

  /**
   * 消费下一个已提交事件；已关闭的 step 与 turn 边界丢弃待处理请求。
   * @param event - 同一 Session 的下一个事件，按序号顺序。
   */
  observe(event: SessionEvent): void {
    this.last = { seq: event.seq, time: event.time }
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pendingCalls.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            this.pendingCalls.set(block.id, { turn: event.data.turn, step: event.data.step })
          }
        }
        break
      case 'tool/call': {
        const entry = this.pendingCalls.get(event.data.callId)
        if (entry) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = this.pendingCalls.get(callId)
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          this.pendingCalls.delete(callId)
        }
        break
      }
      // SessionEvent 可合并扩展；无关事件保留待处理请求。
      default:
        break
    }
  }

  /**
   * 按 assistant 顺序构建保守的错误结果，不改变跟踪状态。
   * 序号跟随最新观察到的事件，时间戳复用其时间。
   * 调用方提交结果并在再次恢复前观察这些提交。
   * @returns 待处理的工具结果事件，没有请求仍未应答时为空。
   */
  results(): SessionEvent<'tool/result'>[] {
    if (this.last === undefined) return []
    let seq = this.last.seq + 1
    const time = this.last.time
    const results: SessionEvent<'tool/result'>[] = []

    const text = CLOSER_TEXT[this.cause.kind]
    // 在 step 之前关闭调用：provider 拒绝悬空的 assistant 调用，
    // Map 插入顺序保持其对话记录顺序。
    for (const [callId, { turn, step, callSeq }] of this.pendingCalls) {
      const started = callSeq !== undefined
      const message: ToolResultMessage = deepFreeze({
        id: brandString<MessageId>(`${this.cause.kind}-tool-result-${callId}-${seq}`),
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [{
          type: 'text',
          text: started ? text.started : text.notStarted,
        }],
      })
      results.push({
        type: 'tool/result',
        seq: SessionSeq(seq++),
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...started ? { sourceEventSeqs: [callSeq] } : {},
      })
    }

    return results
  }
}

/**
 * 崩溃恢复入口：为尾部 turn 被中断的持久化日志补齐平衡的合成收尾事件。
 * 由崩溃恢复调用方使用；分叉 seed 通过 `./fork.ts` 中的 `buildForkSeed` 获
 * 得其 `forked` 原因的收尾事件。
 *
 * @param events - 要扫描的持久化日志，可能结束于打开的 turn 内部。
 * @returns 要追加到 `events` 之后的合成 `interrupted` 收尾事件；日志已平衡
 *   时为空。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  return openTurnClosers(events, { kind: 'interrupted' })
}
