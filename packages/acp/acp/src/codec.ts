/**
 * harness 生命周期与 automation-only ACP 线上协议之间的纯转换。
 * @module @deepseek-ai/dsh-acp/codec
 */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * 将 harness 的轮次结束原因映射为 ACP 的终止原因词表。
 * @param reason - harness 轮次结果。
 * @returns 最接近的合法 ACP 停止原因。
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` 保留给客户端显式取消（`session/cancel`）与销毁，两者都在带外结算；
    // 由 hook 或其他所有者中止的轮次属于普通静默，报告 `end_turn`。
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    /* v8 ignore next 2 -- TurnEndReason 可合并扩展；所有活跃轮次的成员都在上方处理，
     * 仅在种子阶段出现的变体（`forked`）永远不会结束 ACP 提示词轮次。 */
    default:
      return 'end_turn'
  }
}
