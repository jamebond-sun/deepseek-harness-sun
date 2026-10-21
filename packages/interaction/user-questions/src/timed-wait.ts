/** 前台提问的生命周期与 Client 认领；问题的持久状态留在投影里。 */

/** 一次生效中的前台等待，仅当没有任何作答 UI 持有时才由 Host 计时。 */
export class TimedQuestionWait {
  private readonly controller = new AbortController()
  private readonly completion = Promise.withResolvers<void>()
  private readonly claims = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param deadline - 没有 Client 持有该等待时使用的 Host 时钟截止时间。
   * @param parent - 发起调用的 Turn 的取消信号。
   * @param timeout - 用于终结一次无人看管的等待的业务错误。
   */
  constructor(
    readonly deadline: number,
    private readonly parent: AbortSignal | undefined,
    private readonly timeout: Error,
  ) {
    parent?.addEventListener('abort', this.parentAborted, { once: true })
    if (parent?.aborted === true) this.parentAborted()
    else this.schedule()
  }

  /** 与前台 waterfall 共享的取消信号，而不是发起调用的 Turn 的那个。 */
  get signal(): AbortSignal { return this.controller.signal }

  /** 在等待被取消、到期或被回收时兑现。 */
  get done(): Promise<void> { return this.completion.promise }

  private readonly parentAborted = (): void => { this.close(this.parent?.reason) }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.signal.aborted || this.claims.size > 0) return
    this.timer = setTimeout(() => { this.close(this.timeout) }, Math.max(0, this.deadline - Date.now()))
  }

  /**
   * 为一个作答 UI 持有该等待，直到其流关闭或该问题终结。
   * @param signal - 这条业务流的取消生命周期。
   * @returns 一帧剩余时长；其兑现意味着认领被释放。
   */
  async *attach(signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    if (signal.aborted || this.signal.aborted) return
    if (this.claims.size === 0 && Date.now() >= this.deadline) {
      this.close(this.timeout)
      return
    }
    const ended = Promise.withResolvers<void>()
    const release = (): void => {
      if (!this.claims.delete(release)) return
      signal.removeEventListener('abort', release)
      this.signal.removeEventListener('abort', release)
      ended.resolve()
      this.schedule()
    }
    this.claims.add(release)
    signal.addEventListener('abort', release, { once: true })
    this.signal.addEventListener('abort', release, { once: true })
    this.schedule()
    try {
      yield { remainingMs: Math.max(0, this.deadline - Date.now()) }
      await ended.promise
    } finally {
      release()
    }
  }

  /**
   * 释放定时器、父级取消订阅以及所有 Client 认领。
   * @param reason - 投递给前台 waterfall 的取消原因。
   */
  close(reason: unknown): void {
    if (this.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.parent?.removeEventListener('abort', this.parentAborted)
    this.controller.abort(reason)
    this.completion.resolve()
  }
}
