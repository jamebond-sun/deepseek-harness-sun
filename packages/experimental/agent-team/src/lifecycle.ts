/** Team 运行时共享的准入截止与有界结算。 */

import { TeamError } from './error.ts'

/** 持有 Team 运行时唯一的取消事实，以及处置超时。 */
export class TeamRuntimeLifecycle {
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controller = new AbortController()

  /**
   * @param disposalTimeoutMs - 单次处置结算操作的最大等待时长。
   */
  constructor(private readonly disposalTimeoutMs: number) {}

  /** 恰在 Team 运行时准入关闭时被中止的信号。 */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Team 运行时准入是否已关闭。 */
  get disposed(): boolean {
    return this.signal.aborted
  }

  /** 用于区分预期内处置拒绝的、精确的取消原因。 */
  get reason(): unknown {
    const reason: unknown = this.signal.reason
    return reason
  }

  /** 某次拒绝是否为运行时取消——无论是直接，还是经由 Error 的 cause 链。 */
  private isCancellation(reason: unknown): boolean {
    const seen = new Set<unknown>()
    let current = reason
    while (!seen.has(current)) {
      if (this.disposed && current === this.reason) return true
      if (this.disposed && current instanceof TeamError && current.code === 'TEAM_DISPOSED') return true
      if (!(current instanceof Error)) return false
      seen.add(current)
      current = current.cause
    }
    return false
  }

  /** 关闭 Team 运行时准入，并取消已准入的可中断工作。 */
  close(): void {
    this.controller.abort(new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED'))
  }

  /**
   * 跟踪一次已准入的发送或完整的创建事务，直到其结算。
   * @param operation - 由该运行时拥有的异步工作。
   * @returns 同一个操作。
   */
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }

  /**
   * 在关闭准入之后，捕获尚未完成的操作。
   * @returns 仍在等待结算的、已准入的工作。
   */
  pending(): readonly Promise<unknown>[] {
    return [...this.operations]
  }

  /**
   * 等待已准入的操作，并保留除运行时取消以外的失败。
   * @param operations - 在准入截止之后捕获的已准入操作。
   * @param failures - 用于收集意外拒绝或超时的聚合目标。
   */
  async settle(operations: readonly Promise<unknown>[], failures: unknown[]): Promise<void> {
    if (operations.length === 0) return
    try {
      const outcomes = await this.withTimeout(Promise.allSettled(operations))
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected' && !this.isCancellation(outcome.reason)) failures.push(outcome.reason)
      }
    } catch (error: unknown) {
      failures.push(error)
    }
  }

  /**
   * 为一次运行时结算操作设界。
   * @param operation - 否则可能阻塞 HMR 或进程关闭的结算。
   * @returns 该操作的结果。
   */
  async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TeamError(
          `Agent Teams runtime disposal exceeded ${this.disposalTimeoutMs}ms`,
          'TEAM_DISPOSAL_TIMEOUT',
        ))
      }, this.disposalTimeoutMs)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
