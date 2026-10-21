/** 对有界、仅内存的撤销：针对一个已从本地凭证中移除的令牌。 */
import { setTimeout } from 'node:timers/promises'
import { logoutAccount } from './protocol.ts'

/** 由账户提供方所拥有的、已解析的登出重试设置。 */
export interface LogoutRetryPolicy {
  readonly maxRetries: number
  readonly delayMs: number
  readonly requestTimeoutMs: number
}

/**
 * 撤销一份已捕获的授权，而不改变本地账户状态。
 * @param origin - 本地授权移除之前所验证的签发者。
 * @param token - 已移除的授权，绝不会被一次后续登录的令牌所替换。
 * @param policy - 请求截止时间与指数退避重试上限。
 * @param signal - 提供方生命周期；关闭会中止请求与延迟。
 * @param headers - 已验证的、仅签发者的部署请求头。
 * @returns 在成功、耗尽或取消之后；远端失败留在后台。
 */
export async function revokeAccount(origin: string, token: string, policy: LogoutRetryPolicy,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (signal.aborted) return
    if (attempt > 0) {
      try { await setTimeout(policy.delayMs * 2 ** (attempt - 1), undefined, { signal, ref: false }) }
      catch { return } // 已验证的延迟只在提供方生命周期结束时才会被拒绝。
    }
    try {
      await logoutAccount(origin, token,
        AbortSignal.any([signal, AbortSignal.timeout(policy.requestTimeoutMs)]), headers)
      return
    } catch {
      // HTTP, business, and transport failures consume one attempt without restoring credentials.
    }
  }
}
