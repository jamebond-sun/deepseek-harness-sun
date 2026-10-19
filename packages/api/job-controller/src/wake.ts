/**
 * 由两个观察生成器共享的 wake 记账：一个在两次等待之间从不丢失 wake 的
 * wake 标志等待器，以及一个把突发合并为有界帧的可中止 sleep。
 * @module @deepseek-ai/dsh-api-job-controller/wake
 */

/** Wake 标志等待器：两次等待之间的 wake 永不丢失。 */
export class OutputWaiter {
  private dirty = false
  private resolve: (() => void) | undefined

  /** 记录一次 wake；释放一个挂起的等待，或预备下一次等待。 */
  wake(): void {
    this.dirty = true
    this.resolve?.()
  }

  /**
   * 在下一次 wake 时解除挂起；已有 wake 到达则立即解除，或在中止时解除。
   * @param signal - 本次生成的取消信号。
   * @returns 在被唤醒或中止时落定。
   */
  wait(signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one wait owns the sole installed resolver. */
        if (this.resolve === finish) this.resolve = undefined
        this.dirty = false
        resolve()
      }
      this.resolve = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

/**
 * 睡眠一个合并窗口，或在已中止时立即返回。
 * @param ms - 窗口时长（毫秒）。
 * @param signal - 本次生成的取消信号。
 * @returns 在窗口结束后或中止时落定。
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
