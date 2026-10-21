/**
 * 面向浏览器的子代理 prompt 与中断请求校验，以及 Remote 面所返回的
 * 稳定 prompt 失败码。
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { SubagentError } from './error.ts'

const SESSION_ID_SCHEMA = z.string().min(1)
const CONTROL_ID_SCHEMAS = {
  'subagent.prompt': z.object({
    parentSessionId: SESSION_ID_SCHEMA,
    childSessionId: SESSION_ID_SCHEMA,
    mode: z.literal('continuable'),
    delivery: z.enum(['queue', 'steer']),
  }),
  'subagent.interrupt': z.object({
    parentSessionId: SESSION_ID_SCHEMA,
    childSessionId: SESSION_ID_SCHEMA,
    mode: z.literal('continuable'),
  }),
} as const

/**
 * 应用那些比生成的品牌字符串编解码器更严格的子代理载荷检查。
 * @param method - 失败消息中携带的方法名。
 * @param payload - 待校验的已解码控制字段。
 * @throws {RemoteError} 带原始 Zod issues 的 `gateway/bad-request`。
 */
export function validateControlRequest(
  method: keyof typeof CONTROL_ID_SCHEMAS,
  payload: unknown,
): void {
  const parsed = CONTROL_ID_SCHEMAS[method].safeParse(payload)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
}

/**
 * 在不暴露提供方细节的前提下拒绝一次续跑 prompt：调用方可据此行动的
 * 接纳失败保留各自的错误码，其余一切视为内部错误。
 * @param error - 被抛出的值。
 * @param childSessionId - 所寻址的子代理。
 * @param signal - 调用方的取消信号。
 * @returns 永不返回 —— 该拒绝以抛出结束。
 * @throws {RemoteError} 总是抛出。
 */
export function rejectPrompt(error: unknown, childSessionId: SessionId, signal: AbortSignal): never {
  if (isCancellation(error, signal)) {
    throw new RemoteError('gateway/cancelled', 'subagent prompt was cancelled', {}, { cause: error })
  }
  if (error instanceof AttachmentError) {
    throw new RemoteError('subagent/attachment-invalid', error.message, { reason: error.code }, { cause: error })
  }
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'MODEL_DOES_NOT_SUPPORT_IMAGES':
        throw new RemoteError(
          'subagent/attachment-invalid',
          error.message,
          { reason: error.code },
          { cause: error },
        )
      case 'NOT_RESUMABLE':
        throw new RemoteError(
          'subagent/not-resumable',
          'subagent cannot be resumed',
          { childSessionId },
          { cause: error },
        )
      case 'UNAUTHORIZED':
        throw new RemoteError(
          'subagent/unauthorized',
          'subagent does not belong to this parent',
          { childSessionId },
          { cause: error },
        )
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'ACTIVATION_LIMIT_REACHED':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        throw new RemoteError(
          'subagent/delivery-unavailable',
          'subagent follow-up is temporarily unavailable',
          { childSessionId },
          { cause: error },
        )
      // 准入词汇之外的错误码不由调用方处置。
      default:
        break
    }
  }
  throw new RemoteError('gateway/internal', 'subagent prompt failed', {}, { cause: error })
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')
}
