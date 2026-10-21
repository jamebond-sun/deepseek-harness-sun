/** 一次性的 Team 变更等待器，独立于持久化状态投影。 */

import type { TeamId, TeamWaitResult } from './types.ts'
import { errorMessage, TeamError } from './error.ts'

interface Waiter {
  readonly resolve: () => void
}

/** 持有当前的 Team 变更等待器，且每个至多释放一次。 */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()
  private closed = false

  /**
   * 等待下一次 Team 领域或成员状态的变化。
   * @param id - 其下一次边沿将唤醒调用方的 Team。
   * @param timeoutMs - 从十秒到一小时的有界等待时长。
   * @param signal - 仅用于本次等待的调用方取消。
   * @returns 等待是否因超时而结束。
   */
  async wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
    }
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- 在一名胜出者移除其余等待器之后，超时、取消与通知可能竞相发生。 */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal 不会重放一次在预检查与监听器注册之间胜出的取消。
      /* v8 ignore next -- 需要在预检查与监听器注册之间的同步间隙中发生一次取消。 */
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * 唤醒并移除某个 Team 的全部当前等待器。
   * @param id - 其当前等待器应观察到该变化的 Team。
   */
  notify(id: TeamId): void {
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve()
  }

  /** 在运行时处置期间关闭准入并唤醒每个当前等待器。 */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
