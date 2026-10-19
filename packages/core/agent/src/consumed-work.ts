/**
 * 单个 agent 日志如何核算它消费过的工作。
 *
 * 仅凭 turn 与 step 词汇无法回答这个问题。一个在第一个 step 之前停止的
 * turn 留下的 `turn/end`，与拒绝或空认领产生的平衡无操作 turn 完全同形，
 * 因此孤立地读取 turn 要么把被截断的工作记为已完成，要么把每个无操作
 * 都定罪。缺失的事实是 inbox 自身的记录：{@link Inbox} 以 `removedCount`
 * 记录每次变更，并用 `outcome: 'canceled'` 标记取消，从而把 turn 认领了
 * 其输入与工作被未运行就丢弃区分开。
 *
 * @module @deepseek-ai/dsh-agent/consumed-work
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

/** 单个 agent 日志如何核算它消费过的工作。 */
export interface ConsumedWork {
  /**
   * 核算已消费工作的最新关闭 turn：进入了模型 step 的 turn，或认领了
   * inbox 输入随后失败、被停止或被拒绝的 turn。没有任何 turn 关闭过
   * 工作时不存在。
   */
  readonly end?: SessionEvent<'turn/end'>
  /**
   * 该 turn 之后，已接受的工作是否被取消出 inbox 且未运行。这是取消操作
   * 在任何 turn 得以打开之前获取输入的唯一核算记录 —— 没有 `turn/end`
   * 描述它。
   */
  readonly droppedUnrun: boolean
}

/**
 * 消费了输入但从未到达 step 的 turn，其结束方式是否核算了该输入。
 * 只有 `completed` 结束不核算：一旦其认领被改写掉，它已无事可运行。
 * `blocked` 结束同样核算该输入的终结 —— 产生它的 pre-step 拒绝丢弃了
 * 被认领的消息，因此它取走的工作永远不会运行。
 * @param reason - 该 turn 记录的结束方式。
 * @returns 该结束方式是否核算了 turn 获取的输入。
 */
function accountsForClaim(reason: TurnEndReason): boolean {
  switch (reason.kind) {
    case 'completed':
      return false
    case 'blocked':
    case 'aborted':
    case 'interrupted':
    case 'error':
      return true
    /* v8 ignore next 5 -- unreachable: `max-tokens` requires a step and short-circuits
     * before this call; `forked` exists only in constructor seed history, while production
     * callers fold an operation-owned suffix. `TurnEndReasonMap` is merge-extensible, so a
     * backend-added variant cannot be listed; an unnameable ending over consumed input must
     * not read as success. */
    default:
      return true
  }
}

/**
 * 把单个 agent 日志（或其被拥有的后缀）fold 成其已消费工作的核算。
 * 单次遍历，且每个输入都是日志本身：没有调用方需要在取消前采样活跃状态，
 * 因此任何人 —— 所有者的拆除、祖先的中断、正在卸载的插件 —— 发出的取消
 * 读到的结果一致。
 * @param events - 要 fold 的日志或其被拥有的后缀。
 * @returns 关闭的核算 turn（若有），以及其后工作是否被未运行就丢弃。
 */
export function foldConsumedWork(events: readonly SessionEvent[]): ConsumedWork {
  const stepped = new Set<number>()
  const claimed = new Set<number>()
  let open: number | undefined
  let end: SessionEvent<'turn/end'> | undefined
  let droppedUnrun = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = event.data.turn
        break
      case 'step/start':
        stepped.add(event.data.turn)
        break
      case 'agent/inbox/spliced': {
        const { removedCount, outcome, inserted } = event.data
        if (removedCount === undefined) break
        // 替换会让工作以新身份保持待处理，因此只有不留下任何东西的取消
        // 才算丢弃。
        if (outcome === 'canceled') droppedUnrun ||= inserted.length === 0
        // 认领是循环自身的 step 边界读取，总是发生在 turn 内。
        else if (open !== undefined) claimed.add(open)
        break
      }
      case 'turn/end': {
        const { turn, reason } = event.data
        open = undefined
        if (stepped.delete(turn) || (claimed.delete(turn) && accountsForClaim(reason))) {
          end = event
          // 在本 turn 关闭之前被丢弃的内容已由其自身的结束方式报告；
          // 只有更晚的丢弃仍未被核算。
          droppedUnrun = false
        }
        break
      }
      default:
        break
    }
  }
  return { ...end === undefined ? {} : { end }, droppedUnrun }
}
